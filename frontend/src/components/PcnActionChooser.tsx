/**
 * PCN action chooser — the "what next?" surface after a PCN is logged.
 *
 * Shared by the post-create step in CreatePcnModal and the action panel on
 * PcnDetailPage. Presents the seven action paths, reveals per-action options
 * (send email? add the £35+VAT charge?), and POSTs to /pcns/:id/action.
 *
 * Backend (services/pcn-actions.ts) owns status + action_path + the branded
 * email + the conditional HireHop charge. This component just chooses + confirms.
 */
import { useState } from 'react';
import { api } from '../services/api';
import { useAuthStore } from '../hooks/useAuthStore';

const MANAGER_ROLES = ['admin', 'manager', 'weekend_manager'];

interface ActionMeta {
  key: string;
  emoji: string;
  title: string;
  desc: string;
  hasEmail: boolean;     // does this action send a client/driver email?
  chargeable: boolean;   // does it add the £35+VAT handling charge by default?
  managerOnly: boolean;  // money-moving / charge-adding → manager tier
}

const ACTIONS: ActionMeta[] = [
  {
    key: 'pay_direct', emoji: '💳', title: 'Driver to pay direct',
    desc: 'Lenient path — the driver pays the issuer (often at a reduced rate) within 48h and sends us proof of payment. No handling fee unless it has to escalate.',
    hasEmail: true, chargeable: false, managerOnly: false,
  },
  {
    key: 'transfer_liability', emoji: '📨', title: 'Transfer liability to driver',
    desc: 'Name the driver to the issuer so the notice transfers to them. Adds the £35+VAT handling fee to the job.',
    hasEmail: true, chargeable: true, managerOnly: true,
  },
  {
    key: 'pay_recharge', emoji: '🧾', title: 'Pay & recharge the client',
    desc: 'We pay the fine and recharge the client via HireHop. Adds the £35+VAT handling fee.',
    hasEmail: true, chargeable: true, managerOnly: true,
  },
  {
    key: 'request_driver_id', emoji: '❓', title: 'Request driver ID from client',
    desc: 'Ask the client who was driving. Police NIPs are time-critical — the email flags the urgency automatically.',
    hasEmail: true, chargeable: false, managerOnly: false,
  },
  {
    key: 'internal_ooosh', emoji: '🏢', title: 'Internal — Ooosh',
    desc: 'Our own fault / vehicle movement. No client contact, no charge.',
    hasEmail: false, chargeable: false, managerOnly: false,
  },
  {
    key: 'internal_freelancer', emoji: '🧑‍🔧', title: 'Internal — Freelancer',
    desc: 'A freelancer working on our business. No client contact, no charge.',
    hasEmail: false, chargeable: false, managerOnly: false,
  },
  {
    key: 'query', emoji: '⚖️', title: 'Query / dispute',
    desc: 'Hold the notice while we contest it. No client contact yet.',
    hasEmail: false, chargeable: false, managerOnly: false,
  },
];

interface ActionResult {
  status: string;
  emailed: { sent: boolean; to: string | null; fallback: boolean; error: string | null };
  charge: { attempted: boolean; applied: boolean; message: string | null };
}

export default function PcnActionChooser({
  pcnId,
  driverEmail,
  onActioned,
}: {
  pcnId: string;
  driverEmail?: string | null;
  onActioned: (result: ActionResult) => void;
}) {
  const role = useAuthStore((s) => s.user)?.role || '';
  const isManager = MANAGER_ROLES.includes(role);

  const [selected, setSelected] = useState<ActionMeta | null>(null);
  const [sendEmail, setSendEmail] = useState(true);
  const [addCharge, setAddCharge] = useState(true);
  const [emailOverride, setEmailOverride] = useState('');
  const [note, setNote] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ActionResult | null>(null);

  const choose = (a: ActionMeta) => {
    setSelected(a);
    setSendEmail(a.hasEmail);
    setAddCharge(a.chargeable);
    setEmailOverride('');
    setNote('');
    setError(null);
    setResult(null);
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
          <p className="text-slate-600">
            ✉ Emailed {result.emailed.to}{result.emailed.fallback ? ' (no contact on file — sent to info@)' : ''}.
          </p>
        )}
        {result.emailed.error && (
          <p className="text-amber-700">⚠ Email didn’t send: {result.emailed.error}</p>
        )}
        {result.charge.attempted && (
          <p className={result.charge.applied ? 'text-slate-600' : 'text-amber-700'}>
            {result.charge.applied ? '✓' : '⚠'} {result.charge.message}
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
                {a.hasEmail && (
                  <>
                    <label className="flex items-center gap-2 text-sm text-slate-700">
                      <input type="checkbox" checked={sendEmail} onChange={(e) => setSendEmail(e.target.checked)} />
                      Send the {a.key === 'request_driver_id' || a.key === 'pay_recharge' ? 'client' : 'driver'} email now
                    </label>
                    {sendEmail && (
                      <input
                        type="email"
                        value={emailOverride}
                        onChange={(e) => setEmailOverride(e.target.value)}
                        placeholder={driverEmail ? `Default: ${driverEmail}` : 'Override recipient (optional)'}
                        className="border rounded-lg px-3 py-1.5 text-sm w-full"
                      />
                    )}
                  </>
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
                    ? 'Note for the record (e.g. "Dave to pay direct / deduct from next invoice")'
                    : 'Note for the record (optional)'}
                  className="border rounded-lg px-3 py-1.5 text-sm w-full resize-y min-h-[44px]"
                />
                {error && <p className="text-sm text-red-600">{error}</p>}
                <button
                  type="button"
                  onClick={confirm}
                  disabled={submitting}
                  className="bg-[#7B5EA7] text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-[#6a5092] disabled:opacity-50"
                >
                  {submitting ? 'Working…' : `Confirm — ${a.title}`}
                </button>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
