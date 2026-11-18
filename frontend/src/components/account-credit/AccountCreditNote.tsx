import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../../services/api';
import { useAuthStore } from '../../hooks/useAuthStore';
import { hasManagerRole } from '../../lib/roles';
import { type AccountCredit, acMoney, acDay, acError, fromJob } from '../../lib/accountCredit';

/**
 * Money this client has on account — the Client History sidebar, above Vouchers
 * (docs/CREDIT-ON-ACCOUNT-SPEC.md). Fetches its own data so the pages that show it only
 * pass ids. `clientOrgId` is the job's CLIENT (the payer), never the band.
 *
 * `jobId` is the saved job; without one (a New Enquiry not saved yet) the money can be
 * seen but not put aside. Any staff puts it aside; a manager takes it back off.
 * Renders nothing when the client has nothing on account.
 */
export default function AccountCreditNote({ clientOrgId, jobId }: {
  clientOrgId?: string | null;
  jobId?: string | null;
}) {
  const user = useAuthStore((s) => s.user);
  const isManager = hasManagerRole(user?.role);
  const [credits, setCredits] = useState<AccountCredit[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState('');

  const load = useCallback(() => {
    if (!clientOrgId && !jobId) { setCredits([]); return; }
    const p = new URLSearchParams();
    if (clientOrgId) p.set('organisation_id', clientOrgId);
    if (jobId) p.set('job_id', jobId);
    api.get<{ data: AccountCredit[] }>(`/account-credit/context?${p}`)
      .then((r) => setCredits(r.data))
      .catch(() => setCredits([]));
  }, [clientOrgId, jobId]);
  useEffect(() => { load(); }, [load]);

  if (credits.length === 0) return null;

  async function act(c: AccountCredit, path: 'reserve' | 'unreserve') {
    setBusy(c.id);
    setError('');
    try {
      await api.post(`/account-credit/${c.id}/${path}`, path === 'reserve' ? { job_id: jobId } : {});
      load();
    } catch (e) {
      setError(acError(e, 'Could not save'));
    } finally {
      setBusy(null);
    }
  }

  const btn = 'px-2 py-1 text-xs border border-gray-300 bg-white rounded hover:bg-gray-50 disabled:opacity-50';
  return (
    <div className="mb-3 p-2.5 bg-blue-50 border border-blue-200 rounded-lg">
      <div className="text-xs font-semibold text-blue-800 uppercase mb-1">Money on account</div>
      <ul className="space-y-2.5">
        {credits.map((c) => (
          <li key={c.id} className="text-xs text-gray-700">
            <div className="text-sm font-bold text-gray-900">{acMoney(c.amount)} already paid</div>
            <div>
              Overpaid <Link to={`/jobs/${c.source_job_id}?tab=money`} className="text-ooosh-600 hover:underline">{fromJob(c).replace('from ', 'on ')}</Link>
              {' '}· held {acDay(c.held_at)}{c.held_by_name ? ` by ${c.held_by_name}` : ''}
            </div>
            {c.note && <div className="italic text-gray-500">{c.note}</div>}

            {c.status === 'reserved' ? (
              <div className="mt-1.5 p-2 bg-amber-50 border border-amber-200 rounded text-amber-900">
                Put aside for this job. It comes off the invoice when this job is invoiced. Until then HireHop and the
                payment link still show the full balance, so tell the client to pay {acMoney(c.amount)} less.
                {isManager && (
                  <div className="mt-1.5">
                    <button type="button" disabled={busy === c.id} className={btn}
                      onClick={() => { if (confirm(`Take the ${acMoney(c.amount)} off this job? It goes back to being free for ${c.client_name}'s other jobs.`)) void act(c, 'unreserve'); }}>
                      Take off this job
                    </button>
                  </div>
                )}
              </div>
            ) : (
              <div className="mt-1.5">
                {jobId ? (
                  <button type="button" disabled={busy === c.id} onClick={() => void act(c, 'reserve')}
                    className="px-2 py-1 text-xs bg-blue-700 text-white rounded hover:bg-blue-800 disabled:opacity-50">Use on this job</button>
                ) : (
                  <span className="text-[11px] text-gray-500">Save the enquiry to use it on this job.</span>
                )}
              </div>
            )}
          </li>
        ))}
      </ul>
      {error && <div className="text-xs text-red-600 mt-1">{error}</div>}
    </div>
  );
}
