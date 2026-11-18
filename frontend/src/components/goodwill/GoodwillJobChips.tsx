import { useCallback, useEffect, useState } from 'react';
import { api } from '../../services/api';
import { type GoodwillCredit, money, creditCode, hireHopNote } from '../../lib/goodwillCopy';

/** Reserved or used on this job (`GET /goodwill/on-job/:jobId`), re-read on demand. */
export function useGoodwillOnJob(jobId: string | null | undefined) {
  const [credits, setCredits] = useState<GoodwillCredit[]>([]);
  const load = useCallback(() => {
    if (!jobId) { setCredits([]); return; }
    api.get<{ data: GoodwillCredit[] }>(`/goodwill/on-job/${jobId}`)
      .then((r) => setCredits(r.data))
      .catch(() => setCredits([]));
  }, [jobId]);
  useEffect(() => { load(); }, [load]);
  return { credits, reload: load };
}

/**
 * The job header's voucher chips (docs/GOODWILL-CREDIT-SPEC.md §4.3 / §6): one per
 * credit reserved or used on this job. Amber while it waits for HireHop or the
 * read-back found something wrong; green once used cleanly. Clicking a reserved one
 * asks HireHop now instead of waiting for the hourly check. Nothing when none.
 */
export default function GoodwillJobChips({ jobId }: { jobId: string }) {
  const { credits, reload } = useGoodwillOnJob(jobId);
  const [checking, setChecking] = useState<string | null>(null);
  if (credits.length === 0) return null;

  async function checkNow(c: GoodwillCredit) {
    setChecking(c.id);
    try { await api.post(`/goodwill/${c.id}/check`, {}); } catch { /* the chip just stays as it was */ }
    setChecking(null);
    reload();
  }

  return (
    <>
      {credits.map((c) => {
        const used = c.status === 'used';
        const warn = !used || !!c.check_problem;
        const label = used
          ? `Voucher ${creditCode(c)}: −${money(c.used_amount_ex_vat ?? c.amount_ex_vat)} + VAT`
          : `Voucher ${creditCode(c)} held`;
        const title = [
          used ? `Used on this job (${c.used_how === 'credit_note' ? `credit note ${c.used_hh_ref ?? ''}` : c.used_how === 'line' ? 'found on a HireHop line' : 'marked applied'}).`
            : `Held: ${money(c.reserved_amount_ex_vat ?? c.amount_ex_vat)} + VAT — waiting for "${hireHopNote(c)}" in HireHop. Click to check now.`,
          c.check_problem ? `⚠ ${c.check_problem}` : '',
        ].filter(Boolean).join('\n');
        const cls = `inline-flex items-center gap-1 px-2.5 py-1 text-xs font-medium rounded-full border ${
          warn ? 'bg-amber-50 text-amber-800 border-amber-200' : 'bg-green-50 text-green-800 border-green-200'}`;
        return used ? (
          <span key={c.id} className={cls} title={title}>{c.check_problem ? '⚠ ' : '🎟️ '}{label}</span>
        ) : (
          <button key={c.id} type="button" className={`${cls} hover:bg-amber-100 disabled:opacity-60`} title={title}
            disabled={checking === c.id} onClick={() => void checkNow(c)}>
            {c.check_problem ? '⚠ ' : '🎟️ '}{checking === c.id ? 'Checking HireHop…' : label}
          </button>
        );
      })}
    </>
  );
}
