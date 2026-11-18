import { useEffect, useState } from 'react';
import { api } from '../../services/api';
import { type GoodwillOwner } from '../../lib/goodwillCopy';
import VoucherAmount, { useVoucherAmount } from './VoucherAmount';

export interface GoodwillTickValue {
  amount_ex_vat: number;
  value_inc_vat?: number;
  organisation_id?: string | null;
  person_id?: string | null;
}

/**
 * The Cancel Job modal's "Give them a voucher" tick (docs/GOODWILL-CREDIT-SPEC.md
 * §4.1, door 1d; §17 — a voucher with its own code). Saved by the cancellation itself, after the job is cancelled —
 * a failure never stops the cancellation. Reports null until it's ticked AND has
 * an amount and somebody to hold it. Managers only (the modal is manager-only).
 */
export default function GoodwillTick({ jobId, onChange }: { jobId: string; onChange: (v: GoodwillTickValue | null) => void }) {
  const [on, setOn] = useState(false);
  const [choices, setChoices] = useState<GoodwillOwner[] | null>(null);
  const [ownerKey, setOwnerKey] = useState('');
  const { amounts, setAmounts, value } = useVoucherAmount();

  useEffect(() => {
    if (!on || choices) return;
    api.get<{ data: GoodwillOwner[] }>(`/goodwill/owner-choices/${jobId}`)
      .then((r) => { setChoices(r.data); if (r.data[0]) setOwnerKey(`${r.data[0].kind}:${r.data[0].id}`); })
      .catch(() => setChoices([]));
  }, [on, choices, jobId]);

  const chosen = (choices || []).find((c) => `${c.kind}:${c.id}` === ownerKey) || null;

  useEffect(() => {
    onChange(on && value && chosen ? {
      amount_ex_vat: value.amount_ex_vat,
      value_inc_vat: value.value_inc_vat,
      organisation_id: chosen.kind === 'organisation' ? chosen.id : null,
      person_id: chosen.kind === 'person' ? chosen.id : null,
    } : null);
    // onChange is the parent's setter; re-run only when the answer changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [on, value?.amount_ex_vat, value?.value_inc_vat, chosen?.id, chosen?.kind]);

  return (
    <div className="border border-ooosh-200 bg-ooosh-50 rounded-lg p-3 text-sm space-y-2">
      <label className="flex items-start gap-2 cursor-pointer">
        <input type="checkbox" checked={on} onChange={(e) => setOn(e.target.checked)} className="mt-0.5 rounded border-gray-300" />
        <span>
          <span className="font-medium text-ooosh-800">Give them a voucher</span>
          <span className="block text-xs text-gray-500">Money off their next hire, the shop or what they owe — not a refund. You tell them in your own email.</span>
        </span>
      </label>
      {on && (
        choices === null ? <div className="pl-6 text-xs text-gray-400">Loading…</div>
        : choices.length === 0 ? <div className="pl-6 text-xs text-amber-700">No band, client or contact on this job to hold it — offer it from their page instead.</div>
        : (
          <div className="pl-6 space-y-2">
            <select aria-label="Voucher for" value={ownerKey} onChange={(e) => setOwnerKey(e.target.value)}
              className="border border-gray-300 rounded px-2 py-1.5 text-sm bg-white">
              {choices.map((c) => <option key={`${c.kind}:${c.id}`} value={`${c.kind}:${c.id}`}>{c.name}{c.role ? ` — ${c.role}` : ''}</option>)}
            </select>
            <VoucherAmount amounts={amounts} onChange={setAmounts} />
            <span className="block text-xs text-gray-600">Use by 12 months from today.</span>
          </div>
        )
      )}
    </div>
  );
}
