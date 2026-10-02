import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../services/api';
import { jobStatusDisplay } from '../lib/pipelineStatus';

interface VenueJob {
  id: string;
  hh_job_number: number | null;
  job_name: string | null;
  client_name: string | null;
  company_name: string | null;
  job_date: string | null;
  job_end: string | null;
  pipeline_status: string | null;
  status: number | null;
  via_job: boolean;
  via_quote: boolean;
}

function formatDate(d: string | null): string {
  if (!d) return '—';
  return new Date(d).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
}

/**
 * Venue → "Linked Jobs" tab: everything this venue has been attached to, newest
 * first. Deliberately a plain list — the org/person HireHistoryTab's filters,
 * CSV and stat cards exist for entities with thousands of jobs; a venue has
 * tens.
 *
 * "Via" matters because the two link routes mean different things: `job` is the
 * venue on the job record itself (HireHop sync), `quote` is the venue picked in
 * the transport calculator. A job very often has only the latter.
 */
export default function VenueLinkedJobs({ venueId }: { venueId: string }) {
  const [jobs, setJobs] = useState<VenueJob[]>([]);
  const [total, setTotal] = useState(0);
  const [orphanQuotes, setOrphanQuotes] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      setError(null);
      try {
        const data = await api.get<{ data: VenueJob[]; total: number; orphan_quotes: number }>(
          `/venues/${venueId}/history`
        );
        if (cancelled) return;
        setJobs(data.data);
        setTotal(data.total);
        setOrphanQuotes(data.orphan_quotes);
      } catch {
        if (!cancelled) setError('Could not load linked jobs.');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [venueId]);

  if (loading) {
    return <div className="text-center py-8 text-gray-400">Loading…</div>;
  }

  if (error) {
    return <div className="text-center py-8 text-red-600 text-sm">{error}</div>;
  }

  if (jobs.length === 0) {
    return (
      <div className="space-y-3">
        <div className="text-center py-8 text-gray-400 bg-gray-50 rounded-lg border border-dashed border-gray-200">
          No jobs linked to this venue yet
        </div>
        {orphanQuotes > 0 && <OrphanNote count={orphanQuotes} />}
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <p className="text-xs text-gray-500">
        {total} linked job{total === 1 ? '' : 's'}
        {total > jobs.length && ` — showing the ${jobs.length} most recent`}
      </p>

      <div className="bg-white rounded-xl shadow-sm border border-gray-200 overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-gray-50 border-b border-gray-200">
            <tr>
              <th className="px-4 py-2 text-left text-xs font-semibold text-gray-600 uppercase tracking-wide">Job</th>
              <th className="px-4 py-2 text-left text-xs font-semibold text-gray-600 uppercase tracking-wide">Name</th>
              <th className="px-4 py-2 text-left text-xs font-semibold text-gray-600 uppercase tracking-wide">Date</th>
              <th className="px-4 py-2 text-left text-xs font-semibold text-gray-600 uppercase tracking-wide">Status</th>
              <th className="px-4 py-2 text-left text-xs font-semibold text-gray-600 uppercase tracking-wide">Via</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {jobs.map((job) => {
              const status = jobStatusDisplay(job);
              const via = [job.via_job ? 'Job' : null, job.via_quote ? 'Quote' : null]
                .filter(Boolean)
                .join(' + ');
              return (
                <tr key={job.id} className="hover:bg-gray-50">
                  <td className="px-4 py-2 whitespace-nowrap">
                    <Link to={`/jobs/${job.id}`} className="text-ooosh-600 hover:text-ooosh-700 hover:underline font-medium">
                      {job.hh_job_number ?? 'View'}
                    </Link>
                  </td>
                  <td className="px-4 py-2 text-gray-800">
                    {job.job_name || job.client_name || job.company_name || 'Untitled'}
                  </td>
                  <td className="px-4 py-2 text-gray-600 whitespace-nowrap">{formatDate(job.job_date)}</td>
                  <td className="px-4 py-2 whitespace-nowrap">
                    <span className={`inline-flex px-2 py-0.5 rounded text-xs font-medium ${status.colour}`}>
                      {status.label}
                    </span>
                  </td>
                  <td className="px-4 py-2 text-xs text-gray-500 whitespace-nowrap">{via}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {orphanQuotes > 0 && <OrphanNote count={orphanQuotes} />}
    </div>
  );
}

function OrphanNote({ count }: { count: number }) {
  return (
    <p className="text-xs text-amber-600">
      ⚠ {count} quote{count === 1 ? '' : 's'} saved against this venue {count === 1 ? 'is' : 'are'} not
      attached to a job, so {count === 1 ? 'it isn’t' : 'they aren’t'} listed above.
    </p>
  );
}
