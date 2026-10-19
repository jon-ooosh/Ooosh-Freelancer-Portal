/**
 * PCN action chooser — the "what next?" surface after a PCN is logged.
 *
 * Shared by the post-create step in CreatePcnModal and the action panel on
 * PcnDetailPage. Presents the seven action paths, reveals per-action options
 * (send email? add the £35+VAT charge?), and POSTs to /pcns/:id/action.
 *
 * Backend (services/pcn-actions.ts) owns status + action_path + the branded
 * email + the conditional HireHop charge. This component just chooses + confirms.
 *
 * RECIPIENT PREVIEW. Choosing an action fetches GET /pcns/:id/recipient, which
 * runs the SAME resolver the send uses, so the address shown here is provably
 * the one that goes out. Where a driver-facing action can't reach a driver and
 * would land on the client, that's surfaced as an amber warning with a tick you
 * have to make before Confirm unlocks — a warning, not a block, because a
 * client self-drive hire with no driver record legitimately does go to the
 * client. Before this, the fall-through was completely silent (job 16373: a
 * freelancer's PCN emailed the client, with nothing on screen to say so).
 */
import { useCallback, useEffect, useState } from 'react';
import { api } from '../services/api';
import { useAuthStore } from '../hooks/useAuthStore';

const MANAGER_ROLES = ['admin', 'manager', 'weekend_manager'];

interface ActionMeta {
  key: string;
  emoji: string;
  title: string;
  desc: string;
  hasEmail: boolean;      // sends an email as part of the action (tick defaults on)
  optionalEmail: boolean; // CAN email, but only if staff opt in (internal_freelancer)
  chargeable: boolean;    // adds the £35+VAT handling charge by default
  managerOnly: boolean;   // money-moving / charge-adding → manager tier
}

const ACTIONS: ActionMeta[] = [
  {
    key: 'pay_direct', emoji: '💳', title: 'Driver to pay direct',
    desc: 'Lenient path — the driver pays the issuer (often at a reduced rate) within 48h and sends us proof of payment. No handling fee unless it has to escalate.',
    hasEmail: true, optionalEmail: false, chargeable: false, managerOnly: false,
  },
  {
    key: 'transfer_liability', emoji: '📨', title: 'Transfer liability to driver',
    desc: 'Name the driver to the issuer so the notice transfers to them. Adds the £35+VAT handling fee to the job.',
    hasEmail: true, optionalEmail: false, chargeable: true, managerOnly: true,
  },
  {
    key: 'pay_recharge', emoji: '🧾', title: 'Pay & recharge the client',
    desc: 'We pay the fine and recharge it to the client via HireHop (shows on the Money tab), plus the £35+VAT handling fee.',
    hasEmail: true, optionalEmail: false, chargeable: true, managerOnly: true,
  },
  {
    key: 'request_driver_id', emoji: '❓', title: 'Request driver ID from client',
    desc: 'Ask the client who was driving. Police NIPs are time-critical — the email flags the urgency automatically.',
    hasEmail: true, optionalEmail: false, chargeable: false, managerOnly: false,
  },
  {
    key: 'internal_ooosh', emoji: '🏢', title: 'Internal — Ooosh',
    desc: 'Our own fault / vehicle movement. No client contact, no charge.',
    hasEmail: false, optionalEmail: false, chargeable: false, managerOnly: false,
  },
  {
    key: 'internal_freelancer', emoji: '🧑‍🔧', title: 'Internal — Freelancer',
    desc: 'A freelancer working on our business. Never contacts the client, no charge — but you can send the freelancer a heads-up.',
    hasEmail: false, optionalEmail: true, chargeable: false, managerOnly: false,
  },
  {
    key: 'query', emoji: '⚖️', title: 'Query / dispute',
    desc: 'Hold the notice while we contest it. No client contact yet.',
    hasEmail: false, optionalEmail: false, chargeable: false, managerOnly: false,
  },
];

interface ActionResult {
  status: string;
  emailed: {
    sent: boolean; to: string | null; fallback: boolean; error: string | null;
    kind?: string | null; clientFallback?: boolean; label?: string | null; skippedReason?: string | null;
  };
  charge: { attempted: boolean; applied: boolean; message: string | null };
  fineRecharge?: { attempted: boolean; applied: boolean; amount: number | null; message: string | null };
}

interface RecipientPreview {
  action: string;
  sends_email: boolean;
  can_email: boolean;
  audience: 'driver' | 'client' | 'freelancer_only';
  to: string | null;
  cc: string[];
  kind: string;
  label: string;
  is_client_fallback: boolean;
  is_info_fallback: boolean;
  reason: string | null;
  has_driver: boolean;
  driver_label: string | null;
}

interface TransferWarning {
  code: string;
  severity: 'high' | 'info';
  message: string;
}

export default function PcnActionChooser({
  pcnId,
  onActioned,
  onAssignDriver,
  refreshKey,
}: {
  pcnId: string;
  onActioned: (result: ActionResult) => void;
  /** Opens the assign-driver picker, offered inline when no driver is on the PCN. */
  onAssignDriver?: () => void;
  /**
   * Changes when the PCN's driver does, so the recipient preview re-resolves
   * after an inline assign. (PcnDetailPage currently remounts us on reload, but
   * don't rely on that — a stale preview would defeat the whole point.)
   */
  refreshKey?: string;
}) {
  const role = useAuthStore((s) => s.user)?.role || '';
  const isManager = MANAGER_ROLES.includes(role);

  const [selected, setSelected] = useState<ActionMeta | null>(null);
  const [sendEmail, setSendEmail] = useState(true);
  const [notifyFreelancer, setNotifyFreelancer] = useState(true);
  const [freelancerMessage, setFreelancerMessage] = useState('');
  const [addCharge, setAddCharge] = useState(true);
  const [emailOverride, setEmailOverride] = useState('');
  const [ackClientFallback, setAckClientFallback] = useState(false);
  const [note, setNote] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ActionResult | null>(null);
  const [preview, setPreview] = useState<RecipientPreview | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [transferWarnings, setTransferWarnings] = useState<TransferWarning[] | null>(null);
  const [checkingTransfer, setCheckingTransfer] = useState(false);

  // Will this confirm actually send an email?
  const willSend = !!selected && (selected.optionalEmail ? notifyFreelancer : selected.hasEmail && sendEmail);
  // Driver-facing action about to hit the client — needs an explicit tick.
  const needsAck = willSend && !!preview?.is_client_fallback;

  const loadPreview = useCallback(async () => {
    if (!selected) return;
    setPreviewLoading(true);
    try {
      const params = new URLSearchParams({ action: selected.key });
      if (selected.optionalEmail && notifyFreelancer) params.set('notify_freelancer', '1');
      const ov = emailOverride.trim();
      if (ov) params.set('email_override', ov);
      const r = await api.get<{ data: RecipientPreview }>(`/pcns/${pcnId}/recipient?${params.toString()}`);
      setPreview(r.data);
    } catch {
      setPreview(null);  // preview is advisory — never blocks the action
    } finally {
      setPreviewLoading(false);
    }
  }, [pcnId, selected, notifyFreelancer, emailOverride]);

  // Re-resolve whenever anything that changes the recipient changes. Debounced
  // so typing an override address doesn't fire a request per keystroke.
  useEffect(() => {
    if (!selected) { setPreview(null); return; }
    const t = setTimeout(() => { void loadPreview(); }, emailOverride.trim() ? 400 : 0);
    return () => clearTimeout(t);
  }, [selected, loadPreview, emailOverride, refreshKey]);

  // A changed recipient invalidates a tick made against the previous one.
  useEffect(() => { setAckClientFallback(false); }, [preview?.to, preview?.is_client_fallback]);

  const choose = (a: ActionMeta) => {
    setSelected(a);
    setSendEmail(a.hasEmail);
    setNotifyFreelancer(a.optionalEmail);   // internal_freelancer defaults to notifying
    setFreelancerMessage('');
    setAddCharge(a.chargeable);
    setEmailOverride('');
    setAckClientFallback(false);
    setNote('');
    setError(null);
    setResult(null);
    setPreview(null);
    setTransferWarnings(null);

    // Soft pre-flight for liability transfers: warn if the representation is
    // likely to be rejected (missing make/model, no signed agreement, offence
    // outside the hire window, London bus lane) so staff can switch to Pay &
    // recharge. Advisory only — never disables the Confirm button.
    if (a.key === 'transfer_liability') {
      setCheckingTransfer(true);
      api
        .get<{ data: { warnings: TransferWarning[] } }>(`/pcns/${pcnId}/transfer-check`)
        .then((r) => setTransferWarnings(r.data.warnings || []))
        .catch(() => setTransferWarnings(null))
        .finally(() => setCheckingTransfer(false));
    }
  };

  const confirm = async () => {
    if (!selected) return;
    setSubmitting(true); setError(null);
    try {
      const r = await api.post<{ data: ActionResult }>(`/pcns/${pcnId}/action`, {
        action: selected.key,
        send_email: selected.hasEmail ? sendEmail : false,
        add_charge: selected.chargeable ? addCharge : false,
        email_override: emailOverride.trim() || null,
        resolution_note: note.trim() || null,
        notify_freelancer: selected.optionalEmail ? notifyFreelancer : undefined,
        freelancer_message: selected.optionalEmail ? (freelancerMessage.trim() || null) : undefined,
      });
      setResult(r.data);
      onActioned(r.data);
    } catch (e) {
      const msg = (e as { message?: string })?.message || '';
      setError(msg.includes('403')
        ? 'That action needs a manager — it adds a charge / recharges the client.'
        : 'Action failed — please try again.');
    } finally {
      setSubmitting(false);
    }
  };

  // After a successful action, show the outcome summary.
  if (result) {
    return (
      <div className="text-sm space-y-2">
        <p className="text-green-700 font-medium">✓ Done — status is now updated.</p>
        {result.emailed.sent && (
          <p className={result.emailed.clientFallback ? 'text-amber-700' : 'text-slate-600'}>
            ✉ Emailed {result.emailed.label || result.emailed.to}
            {result.emailed.fallback ? ' (no contact on file — sent to info@)' : ''}.
          </p>
        )}
        {result.emailed.skippedReason && (
          <p className="text-slate-600">✉ No email sent — {result.emailed.skippedReason}</p>
        )}
        {result.emailed.error && (
          <p className="text-amber-700">⚠ Email didn’t send: {result.emailed.error}</p>
        )}
        {result.charge.attempted && (
          <p className={result.charge.applied ? 'text-slate-600' : 'text-amber-700'}>
            {result.charge.applied ? '✓' : '⚠'} {result.charge.message}
          </p>
        )}
        {result.fineRecharge?.attempted && result.fineRecharge.message && (
          <p className={result.fineRecharge.applied ? 'text-slate-600' : 'text-amber-700'}>
            {result.fineRecharge.applied ? '✓' : '⚠'} {result.fineRecharge.message}
          </p>
        )}
      </div>
    );
  }

  return (
    <div className="space-y-2">
      {ACTIONS.map((a) => {
        const blocked = a.managerOnly && !isManager;
        const isSel = selected?.key === a.key;
        return (
          <div key={a.key}>
            <button
              type="button"
              disabled={blocked}
              onClick={() => choose(a)}
              className={`w-full text-left border rounded-lg px-3 py-2 transition ${
                isSel ? 'border-[#7B5EA7] bg-purple-50' : 'hover:bg-slate-50'
              } ${blocked ? 'opacity-50 cursor-not-allowed' : ''}`}
            >
              <div className="flex items-center gap-2">
                <span className="text-lg">{a.emoji}</span>
                <span className="text-sm font-medium text-slate-800">{a.title}</span>
                {a.managerOnly && (
                  <span className="text-[10px] uppercase tracking-wide text-slate-400 ml-auto">manager</span>
                )}
              </div>
              <p className="text-xs text-slate-500 mt-0.5">{a.desc}</p>
              {blocked && <p className="text-xs text-amber-600 mt-1">Refer to a manager.</p>}
            </button>

            {/* Inline options + confirm for the chosen action */}
            {isSel && !blocked && (
              <div className="border border-t-0 rounded-b-lg -mt-1 px-3 py-3 bg-purple-50/50 space-y-2">
                {/* Liability-transfer pre-flight advisory (soft — never blocks) */}
                {a.key === 'transfer_liability' && checkingTransfer && (
                  <p className="text-xs text-slate-500">Checking the hire agreement…</p>
                )}
                {a.key === 'transfer_liability' && transferWarnings && transferWarnings.length > 0 && (
                  <div className="rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 space-y-1.5">
                    <p className="text-xs font-semibold text-amber-800">
                      ⚠ This transfer may be rejected — consider Pay &amp; recharge instead:
                    </p>
                    <ul className="space-y-1">
                      {transferWarnings.map((w, i) => (
                        <li key={i} className="text-xs text-amber-800 flex gap-1.5">
                          <span>{w.severity === 'high' ? '🔴' : 'ℹ️'}</span>
                          <span>{w.message}</span>
                        </li>
                      ))}
                    </ul>
                    <p className="text-[11px] text-amber-700/80 pt-0.5">
                      You can still proceed — this is a warning, not a block.
                    </p>
                  </div>
                )}

                {/* Opt-in freelancer heads-up (internal_freelancer only) */}
                {a.optionalEmail && (
                  <>
                    <label className="flex items-center gap-2 text-sm text-slate-700">
                      <input type="checkbox" checked={notifyFreelancer} onChange={(e) => setNotifyFreelancer(e.target.checked)} />
                      Email the freelancer a heads-up
                    </label>
                    {notifyFreelancer && (
                      <textarea
                        value={freelancerMessage}
                        onChange={(e) => setFreelancerMessage(e.target.value)}
                        placeholder="Optional line for the freelancer (e.g. “no action needed, we’ve covered this one”)"
                        className="border rounded-lg px-3 py-1.5 text-sm w-full resize-y min-h-[44px]"
                      />
                    )}
                  </>
                )}

                {a.hasEmail && (
                  <label className="flex items-center gap-2 text-sm text-slate-700">
                    <input type="checkbox" checked={sendEmail} onChange={(e) => setSendEmail(e.target.checked)} />
                    Send the {a.key === 'request_driver_id' || a.key === 'pay_recharge' ? 'client' : 'driver'} email now
                  </label>
                )}

                {/* Who is this actually going to? — resolved server-side. */}
                {willSend && (
                  <div className="space-y-2">
                    {previewLoading && <p className="text-xs text-slate-500">Working out who this goes to…</p>}

                    {!previewLoading && preview?.to && !preview.is_client_fallback && (
                      <p className="text-sm text-slate-700 rounded-lg bg-white border px-3 py-2">
                        ✉ Will email <strong>{preview.label}</strong>
                        {preview.cc.length > 0 && <span className="text-slate-500"> · cc {preview.cc.join(', ')}</span>}
                      </p>
                    )}

                    {/* Driver-facing action landing on the client — the exact
                        case that misfired. Tick to proceed. */}
                    {!previewLoading && preview?.is_client_fallback && (
                      <div className="rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 space-y-2">
                        <p className="text-sm text-amber-900">
                          ⚠ This will email the <strong>CLIENT</strong> — {preview.label}
                          {preview.cc.length > 0 && <span className="text-amber-800"> (cc {preview.cc.join(', ')})</span>} — not a driver.
                        </p>
                        <p className="text-xs text-amber-800">
                          {preview.reason || 'No driver contact on file for this PCN.'}
                          {preview.has_driver
                            ? ` ${preview.driver_label || 'The assigned driver'} has no email address on their record.`
                            : ' Assign the driver (a hire driver or a freelancer) and it will go to them instead.'}
                        </p>
                        <div className="flex flex-wrap items-center gap-3">
                          {onAssignDriver && (
                            <button type="button" onClick={onAssignDriver}
                              className="text-xs font-medium text-[#7B5EA7] hover:underline">
                              {preview.has_driver ? 'Change the driver →' : 'Assign the driver →'}
                            </button>
                          )}
                        </div>
                        <label className="flex items-start gap-2 text-sm text-amber-900">
                          <input type="checkbox" className="mt-0.5" checked={ackClientFallback}
                            onChange={(e) => setAckClientFallback(e.target.checked)} />
                          <span>Yes — I mean to send this to the client.</span>
                        </label>
                      </div>
                    )}

                    {/* Nothing to send to (freelancer path with no freelancer). */}
                    {!previewLoading && preview && !preview.to && (
                      <div className="rounded-lg border border-slate-300 bg-white px-3 py-2 space-y-2">
                        <p className="text-sm text-slate-700">
                          ✉ No email will be sent — {preview.reason}
                        </p>
                        {onAssignDriver && (
                          <button type="button" onClick={onAssignDriver}
                            className="text-xs font-medium text-[#7B5EA7] hover:underline">
                            {preview.has_driver ? 'Change the driver →' : 'Assign the freelancer →'}
                          </button>
                        )}
                        <p className="text-xs text-slate-500">
                          The action itself will still be recorded.
                        </p>
                      </div>
                    )}

                    <input
                      type="email"
                      value={emailOverride}
                      onChange={(e) => setEmailOverride(e.target.value)}
                      placeholder="Send somewhere else instead (optional)"
                      className="border rounded-lg px-3 py-1.5 text-sm w-full"
                    />
                  </div>
                )}

                {a.chargeable && (
                  <label className="flex items-center gap-2 text-sm text-slate-700">
                    <input type="checkbox" checked={addCharge} onChange={(e) => setAddCharge(e.target.checked)} />
                    Add the £35+VAT handling charge to the HireHop job
                  </label>
                )}
                <textarea
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                  placeholder={a.key === 'internal_freelancer'
                    ? 'Internal note for the record (e.g. "Dave to pay direct / deduct from next invoice") — not sent to anyone'
                    : 'Note for the record (optional)'}
                  className="border rounded-lg px-3 py-1.5 text-sm w-full resize-y min-h-[44px]"
                />
                {error && <p className="text-sm text-red-600">{error}</p>}
                <button
                  type="button"
                  onClick={confirm}
                  disabled={submitting || (needsAck && !ackClientFallback)}
                  className="bg-[#7B5EA7] text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-[#6a5092] disabled:opacity-50"
                >
                  {submitting ? 'Working…' : `Confirm — ${a.title}`}
                </button>
                {needsAck && !ackClientFallback && (
                  <p className="text-xs text-amber-700">Tick the box above to send this to the client.</p>
                )}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
