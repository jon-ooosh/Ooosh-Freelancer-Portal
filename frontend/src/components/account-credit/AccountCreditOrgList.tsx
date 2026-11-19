import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../../services/api';
import { type AccountCredit, acMoney, acDay, AC_STATUS_LABEL } from '../../lib/accountCredit';

/**
 * A client's money on account, on their own page above their vouchers
 * (docs/CREDIT-ON-ACCOUNT-SPEC.md) — everything ever held, newest first. Read-only:
 * it is held from the job it was paid on and used from the job it's for. Renders
 * nothing for a client who has never had any.
 */
export default function AccountCreditOrgList({ organisationId }: { organisationId: string }) {
  const [credits, setCredits] = useState<AccountCredit[]>([]);
  useEffect(() => {
    let cancelled = false;
    api.get<{ data: AccountCredit[] }>(`/account-credit?organisation_id=${organisationId}`)
      .then((r) => { if (!cancelled) setCredits(r.data); })
      .catch(() => undefined);
    return () => { cancelled = true; };
  }, [organisationId]);

  if (credits.length === 0) return null;
  const live = credits.filter((c) => c.status === 'held' || c.status === 'reserved');
  const total = live.reduce((s, c) => s + c.amount, 0);
  const tone = (c: AccountCredit) => (c.status === 'held' ? 'bg-blue-100 text-blue-800'
    : c.status === 'reserved' ? 'bg-amber-100 text-amber-800' : 'bg-gray-100 text-gray-600');

  return (
    <div className="bg-white rounded-xl shadow-sm border border-gray-200 p-5 mb-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2 mb-1">
        <h3 className="text-lg font-semibold text-gray-900">Money on account</h3>
        {live.length > 0 && <span className="text-sm font-semibold text-blue-800">{acMoney(total)} held</span>}
      </div>
      <p className="text-xs text-gray-500 mb-3">
        Their own money, overpaid on an earlier job and kept for the next one. Not a voucher: no VAT, no use-by date.
      </p>
      <ul className="divide-y divide-gray-100">
        {credits.map((c) => (
          <li key={c.id} className="py-2 flex flex-wrap items-center justify-between gap-x-3 gap-y-1 text-sm">
            <span className="min-w-0">
              <span className={`font-semibold ${c.status === 'held' || c.status === 'reserved' ? 'text-gray-900' : 'text-gray-400'}`}>{acMoney(c.amount)}</span>
              {' '}overpaid on{' '}
              <Link to={`/jobs/${c.source_job_id}?tab=money`} className="text-ooosh-600 hover:underline">job {c.source_job_number ?? '—'}</Link>
              <span className="text-xs text-gray-500"> · held {acDay(c.held_at)}{c.held_by_name ? ` by ${c.held_by_name}` : ''}</span>
              {c.note && <span className="block text-xs italic text-gray-500">{c.note}</span>}
              {c.status === 'released' && c.released_reason && <span className="block text-xs text-gray-500">{c.released_reason}</span>}
            </span>
            <span className={`text-xs font-semibold px-2 py-0.5 rounded-full whitespace-nowrap ${tone(c)}`}>
              {c.status === 'reserved' && c.reserved_job_id
                ? <Link to={`/jobs/${c.reserved_job_id}?tab=money`} className="hover:underline">For job {c.reserved_job_number}</Link>
                : AC_STATUS_LABEL[c.status]}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
