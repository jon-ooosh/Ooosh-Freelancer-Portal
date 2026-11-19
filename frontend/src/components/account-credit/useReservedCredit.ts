import { useEffect, useState } from 'react';
import { api } from '../../services/api';
import { type AccountCredit, acMoney } from '../../lib/accountCredit';

/**
 * Money on account put aside for this job, as the words the "How was this confirmed?"
 * modals use (docs/CREDIT-ON-ACCOUNT-SPEC.md): "£68.40 held on account from job 16489".
 * Null when there is none — the "Credit on account" method is only offered when there is.
 * Confirming on it is always a person's choice; nothing confirms a job by itself.
 */
export function useReservedCreditNote(jobId: string | null | undefined, enabled: boolean): string | null {
  const [note, setNote] = useState<string | null>(null);
  useEffect(() => {
    if (!jobId || !enabled) { setNote(null); return; }
    let cancelled = false;
    api.get<{ data: AccountCredit[] }>(`/account-credit/context?job_id=${jobId}`)
      .then((r) => {
        if (cancelled) return;
        const mine = r.data.filter((c) => c.status === 'reserved' && c.reserved_job_id === jobId);
        if (mine.length === 0) { setNote(null); return; }
        const total = mine.reduce((s, c) => s + c.amount, 0);
        const jobs = mine.map((c) => c.source_job_number).filter(Boolean);
        setNote(`${acMoney(total)} held on account from job${jobs.length === 1 ? '' : 's'} ${jobs.join(', ') || '(earlier)'}`);
      })
      .catch(() => { if (!cancelled) setNote(null); });
    return () => { cancelled = true; };
  }, [jobId, enabled]);
  return note;
}
