import { useEffect, useState } from 'react';
import { api } from '../../services/api';
import DatePicker from '../DatePicker';
import { ukToday, ukDatePlus } from '../../lib/ukDate';
import {
  type GoodwillCredit, type GoodwillOwner, creditHeadline, creditCode, voucherMoney, emailPoints, copyText,
} from '../../lib/goodwillCopy';
import VoucherAmount, { useVoucherAmount } from './VoucherAmount';

/**
 * "Give a voucher" (once "Offer goodwill credit") — one modal behind every door
 * (close-out panel, a Problem's Money card, an org or person page). docs/GOODWILL-CREDIT-SPEC.md
 * §4.2, §17: it makes a voucher with its own code, held by the band / client / a person.
 * Managers only (the routes enforce it). OP sends nothing to the client: once it's
 * saved, the modal shows the points to put in your own email.
 *
 * Give `jobId` to offer the job's band / client / contacts as "For"; give `owner`
 * for a fixed one (an org or person page).
 */
export default function OfferGoodwillModal({ jobId, owner, sourceKind, sourceJobId, sourceIssueId, onClose, onDone }: {
  jobId?: string | null;
  owner?: GoodwillOwner;
  sourceKind: GoodwillCredit['source_kind'];
  sourceJobId?: string | null;
  sourceIssueId?: string | null;
  onClose: () => void;
  onDone?: (g: GoodwillCredit) => void;
}) {
  const [choices, setChoices] = useState<GoodwillOwner[]>(owner ? [owner] : []);
  const [ownerKey, setOwnerKey] = useState(owner ? `${owner.kind}:${owner.id}` : '');
  const [loadingChoices, setLoadingChoices] = useState(!owner && !!jobId);
  const { amounts, setAmounts, value } = useVoucherAmount();
  const [reason, setReason] = useState('');
  const [expiresOn, setExpiresOn] = useState(ukDatePlus(365));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState<GoodwillCredit | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (owner || !jobId) return;
    api.get<{ data: GoodwillOwner[] }>(`/goodwill/owner-choices/${jobId}`)
      .then((r) => {
        setChoices(r.data);
        if (r.data[0]) setOwnerKey(`${r.data[0].kind}:${r.data[0].id}`);
      })
      .catch(() => setError('Could not load who this could be for'))
      .finally(() => setLoadingChoices(false));
  }, [jobId, owner]);

  const chosen = choices.find((c) => `${c.kind}:${c.id}` === ownerKey) || null;

  async function save() {
    if (!chosen) { setError('Pick who it is for'); return; }
    if (!value) { setError('Say how much it is worth'); return; }
    if (!reason.trim()) { setError('Say why — staff only'); return; }
    setSaving(true);
    setError('');
    try {
      const r = await api.post<{ data: GoodwillCredit }>('/goodwill', {
        organisation_id: chosen.kind === 'organisation' ? chosen.id : null,
        person_id: chosen.kind === 'person' ? chosen.id : null,
        amount_ex_vat: value.amount_ex_vat,
        value_inc_vat: value.value_inc_vat,
        reason: reason.trim(),
        source_kind: sourceKind,
        source_job_id: sourceJobId || null,
        source_issue_id: sourceIssueId || null,
        expires_on: expiresOn,
      });
      setSaved(r.data);
      onDone?.(r.data);
    } catch (e) {
      setError((e as { body?: { error?: string } })?.body?.error || 'Could not save');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={() => { if (!saving) onClose(); }}>
      <div className="bg-white rounded-xl shadow-xl w-full max-w-lg max-h-[90vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
        <div className="px-5 pt-5 pb-3 border-b border-gray-100">
          <h3 className="text-lg font-semibold text-gray-900">{saved ? `Voucher ${creditCode(saved)} made` : 'Give a voucher'}</h3>
          <p className="text-sm text-gray-500 mt-0.5">
            {saved
              ? 'Nothing has been sent to the client — put these points in your own email.'
              : 'Money off a future hire, the shop, or money they already owe, with its own code. Nothing is refunded and nothing changes in HireHop or Xero today.'}
          </p>
        </div>

        {saved ? (
          <div className="px-5 py-4 space-y-3">
            <div className="text-sm text-gray-700">
              <b>{creditHeadline(saved)}</b> for <b>{saved.owner_name}</b>. It shows on their next enquiry.
            </div>
            <div className="border border-gray-200 rounded-lg p-3">
              <div className="flex items-center justify-between mb-2">
                <span className="text-sm font-semibold text-gray-800">Put these in your email</span>
                <button type="button" onClick={async () => setCopied(await copyText(emailPoints(saved)))}
                  className="px-3 py-1.5 text-xs border border-gray-300 rounded hover:bg-gray-50">{copied ? '✓ Copied' : 'Copy'}</button>
              </div>
              <pre className="whitespace-pre-wrap text-xs text-gray-700 bg-gray-50 rounded p-2 font-sans">{emailPoints(saved)}</pre>
            </div>
            <div className="flex justify-end">
              <button type="button" onClick={onClose} className="px-4 py-2 text-sm bg-ooosh-600 text-white rounded-lg hover:bg-ooosh-700">Done</button>
            </div>
          </div>
        ) : (
          <div className="px-5 py-4 space-y-4">
            <div>
              <label htmlFor="gw-for" className="block text-xs font-semibold text-gray-700 mb-1">For</label>
              {loadingChoices ? (
                <div className="text-sm text-gray-400">Loading…</div>
              ) : choices.length === 0 ? (
                <div className="text-sm text-amber-700">This job has no band, client or contacts to hold a voucher. Add one to the job, or give it from Money › Vouchers.</div>
              ) : (
                <select id="gw-for" value={ownerKey} onChange={(e) => setOwnerKey(e.target.value)} disabled={!!owner}
                  className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm disabled:bg-gray-50">
                  {choices.map((c) => (
                    <option key={`${c.kind}:${c.id}`} value={`${c.kind}:${c.id}`}>{c.name}{c.role ? ` — ${c.role}` : ''}</option>
                  ))}
                </select>
              )}
              <p className="text-[11px] text-gray-500 mt-1">It shows whenever they're on a later job, whoever books.</p>
            </div>

            <div>
              <span className="block text-xs font-semibold text-gray-700 mb-1">Worth</span>
              <VoucherAmount amounts={amounts} onChange={setAmounts} />
            </div>

            <div>
              <label htmlFor="gw-why" className="block text-xs font-semibold text-gray-700 mb-1">Why (staff only)</label>
              <textarea id="gw-why" rows={2} value={reason} onChange={(e) => setReason(e.target.value)}
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm" placeholder="e.g. Support band — the headliner cancelled the tour" />
            </div>

            <div>
              <span className="block text-xs font-semibold text-gray-700 mb-1">Use by</span>
              <div className="w-48"><DatePicker value={expiresOn} onChange={setExpiresOn} min={ukToday()} /></div>
              <p className="text-[11px] text-gray-500 mt-1">12 months by default. A booking made by this date still counts.</p>
            </div>

            {error && <div className="text-sm text-red-600">{error}</div>}

            <div className="flex justify-end gap-2 pt-1">
              <button type="button" onClick={onClose} disabled={saving} className="px-4 py-2 text-sm border border-gray-300 rounded-lg hover:bg-gray-50">Cancel</button>
              <button type="button" onClick={save} disabled={saving || loadingChoices || choices.length === 0}
                className="px-4 py-2 text-sm bg-ooosh-600 text-white rounded-lg hover:bg-ooosh-700 disabled:opacity-50">
                {saving ? 'Saving…' : value ? `Give the ${voucherMoney(value.value_inc_vat)} voucher` : 'Give the voucher'}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
