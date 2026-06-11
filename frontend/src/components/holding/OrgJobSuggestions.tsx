/**
 * Reverse-link helper: when staff know the band/org but not the job number,
 * show that org's jobs (upcoming first) so they can link without leaving the
 * page to hunt for the number. Picking a job fills the HH number, which then
 * drives the existing JobNumberField confirmation.
 *
 * Renders nothing until an org is selected, and hides once a number is set.
 */
import { useEffect, useState } from 'react';
import { api } from '../../services/api';

interface OrgJob {
  job_id: string;
  hh_job_number: number | null;
  job_name: string | null;
  out_date: string | null;
  job_date: string | null;
  pipeline_status: string | null;
}

const fmt = (d: string | null) => (d ? new Date(d).toLocaleDateString('en-GB') : '');

export function OrgJobSuggestions({ orgId, hasNumber, onPick, compact }: {
  orgId: string | null;
  hasNumber: boolean;
  onPick: (hhJobNumber: string) => void;
  compact?: boolean;
}) {
  const [jobs, setJobs] = useState<OrgJob[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!orgId) { setJobs([]); return; }
    let cancelled = false;
    setLoading(true);
    api.get<{ data: OrgJob[] }>(`/holding/org-jobs/${orgId}`)
      .then((r) => { if (!cancelled) setJobs(r.data.filter((j) => j.hh_job_number != null)); })
      .catch(() => { if (!cancelled) setJobs([]); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [orgId]);

  if (!orgId || hasNumber) return null;
  if (loading) return <p className={`${compact ? 'text-xs' : 'text-[11px]'} text-slate-400`}>Finding their jobs…</p>;
  if (jobs.length === 0) return <p className={`${compact ? 'text-xs' : 'text-[11px]'} text-slate-400`}>No jobs found for this client — enter a job # above if you have one.</p>;

  return (
    <div>
      <p className={`${compact ? 'text-sm' : 'text-xs'} text-slate-500 mb-1`}>Link to one of their jobs:</p>
      <div className="flex flex-col gap-1 max-h-44 overflow-y-auto">
        {jobs.map((j) => (
          <button type="button" key={j.job_id} onClick={() => onPick(String(j.hh_job_number))}
            className="text-left border border-slate-200 rounded-lg px-3 py-2 hover:bg-slate-50 active:bg-slate-100">
            <span className="text-sm font-medium text-slate-700">#{j.hh_job_number}</span>
            {j.job_name ? <span className="text-sm text-slate-600"> · {j.job_name}</span> : null}
            {(j.out_date || j.job_date) ? <span className="text-xs text-slate-400"> · {fmt(j.out_date || j.job_date)}</span> : null}
          </button>
        ))}
      </div>
    </div>
  );
}
