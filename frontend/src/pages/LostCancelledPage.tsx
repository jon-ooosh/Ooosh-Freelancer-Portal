import { useState, useEffect, useCallback } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { api } from '../services/api';

interface LostCancelledJob {
  id: string;
  hh_job_number: number | null;
  job_name: string | null;
  company_name: string | null;
  client_name: string | null;
  job_date: string | null;
  job_end: string | null;
  job_value: number | null;
  pipeline_status: string;
  // Lost fields
  lost_reason: string | null;
  lost_detail: string | null;
  lost_at: string | null;
  // Cancelled fields
  cancelled_at: string | null;
  cancellation_reason: string | null;
  cancellation_fee: number | null;
  cancellation_refund: number | null;
  cancellation_tier: string | null;
  cancellation_notice_days: number | null;
  cancellation_notes: string | null;
  reopened_to_job_id: string | null;
}

function formatDate(d: string | null): string {
  if (!d) return '—';
  return new Date(d).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
}

function formatCurrency(v: number | null): string {
  if (v == null) return '—';
  return `£${v.toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export default function LostCancelledPage() {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const [jobs, setJobs] = useState<LostCancelledJob[]>([]);
  const [loading, setLoading] = useState(true);
  const [total, setTotal] = useState(0);

  const tab = searchParams.get('tab') || 'cancelled';
  const page = parseInt(searchParams.get('page') || '1');
  const search = searchParams.get('search') || '';

  const fetchJobs = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({
        status: tab,
        page: String(page),
        limit: '50',
        ...(search ? { search } : {}),
      });
      const res = await api.get<{ data: LostCancelledJob[]; pagination: { total: number } }>(
        `/cancellations/list?${params}`
      );
      setJobs(res.data);
      setTotal(res.pagination.total);
    } catch (err) {
      console.error('Failed to load jobs:', err);
    } finally {
      setLoading(false);
    }
  }, [tab, page, search]);

  useEffect(() => { fetchJobs(); }, [fetchJobs]);

  const setTab = (t: string) => {
    const p = new URLSearchParams(searchParams);
    p.set('tab', t);
    p.delete('page');
    setSearchParams(p);
  };

  const tierLabel: Record<string, string> = {
    '>7_days': '>7 days',
    '2_to_7_days': '2-7 days',
    '<2_days': '<2 days',
  };

  return (
    <div className="p-6">
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-gray-900">Lost & Cancelled</h1>
        <p className="text-sm text-gray-500 mt-1">
          {total} {tab === 'cancelled' ? 'cancelled' : tab === 'lost' ? 'lost' : ''} job{total !== 1 ? 's' : ''}
        </p>
      </div>

      {/* Tabs */}
      <div className="flex gap-1 mb-4 border-b border-gray-200">
        {[
          { key: 'cancelled', label: 'Cancelled' },
          { key: 'lost', label: 'Lost Enquiries' },
        ].map(t => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
              tab === t.key
                ? 'border-red-500 text-red-600'
                : 'border-transparent text-gray-500 hover:text-gray-700'
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* Search */}
      <div className="mb-4">
        <input
          type="text"
          placeholder="Search by job name or client..."
          value={search}
          onChange={e => {
            const p = new URLSearchParams(searchParams);
            if (e.target.value) p.set('search', e.target.value); else p.delete('search');
            p.delete('page');
            setSearchParams(p);
          }}
          className="w-full max-w-md border border-gray-300 rounded-lg px-3 py-2 text-sm"
        />
      </div>

      {loading ? (
        <div className="flex justify-center py-12">
          <div className="animate-spin h-8 w-8 border-4 border-red-500 border-t-transparent rounded-full" />
        </div>
      ) : jobs.length === 0 ? (
        <div className="text-center py-12 text-gray-500">
          No {tab === 'cancelled' ? 'cancelled' : 'lost'} jobs found.
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="min-w-full divide-y divide-gray-200">
            <thead className="bg-gray-50">
              <tr>
                <th className="text-left text-xs font-medium text-gray-500 uppercase px-4 py-3">Job</th>
                <th className="text-left text-xs font-medium text-gray-500 uppercase px-4 py-3">Client</th>
                <th className="text-left text-xs font-medium text-gray-500 uppercase px-4 py-3">Dates</th>
                {tab === 'cancelled' ? (
                  <>
                    <th className="text-left text-xs font-medium text-gray-500 uppercase px-4 py-3">Cancelled</th>
                    <th className="text-left text-xs font-medium text-gray-500 uppercase px-4 py-3">Reason</th>
                    <th className="text-left text-xs font-medium text-gray-500 uppercase px-4 py-3">Notice</th>
                    <th className="text-right text-xs font-medium text-gray-500 uppercase px-4 py-3">Fee</th>
                    <th className="text-right text-xs font-medium text-gray-500 uppercase px-4 py-3">Refund</th>
                  </>
                ) : (
                  <>
                    <th className="text-left text-xs font-medium text-gray-500 uppercase px-4 py-3">Lost</th>
                    <th className="text-left text-xs font-medium text-gray-500 uppercase px-4 py-3">Reason</th>
                    <th className="text-right text-xs font-medium text-gray-500 uppercase px-4 py-3">Value</th>
                  </>
                )}
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-200">
              {jobs.map(job => (
                <tr
                  key={job.id}
                  onClick={() => navigate(`/jobs/${job.id}`)}
                  className="hover:bg-gray-50 cursor-pointer"
                >
                  <td className="px-4 py-3">
                    <div className="text-sm font-medium text-gray-900">{job.job_name || 'Untitled'}</div>
                    <div className="text-xs font-mono">
                      {job.hh_job_number ? (
                        <a
                          href={`https://myhirehop.com/job.php?id=${job.hh_job_number}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          onClick={e => e.stopPropagation()}
                          className="text-ooosh-600 hover:underline"
                        >
                          J-{job.hh_job_number}
                        </a>
                      ) : (
                        <span className="text-gray-400">NEW</span>
                      )}
                    </div>
                  </td>
                  <td className="px-4 py-3 text-sm text-gray-600">
                    {job.company_name || job.client_name || '—'}
                  </td>
                  <td className="px-4 py-3 text-sm text-gray-500">
                    {formatDate(job.job_date)}
                    {job.job_end && job.job_end !== job.job_date && ` — ${formatDate(job.job_end)}`}
                  </td>

                  {tab === 'cancelled' ? (
                    <>
                      <td className="px-4 py-3 text-sm text-gray-500">{formatDate(job.cancelled_at)}</td>
                      <td className="px-4 py-3">
                        <span className="text-sm text-red-600">{job.cancellation_reason || '—'}</span>
                        {job.reopened_to_job_id && (
                          <span className="ml-2 inline-flex px-1.5 py-0.5 rounded text-xs bg-blue-100 text-blue-700">
                            Re-opened
                          </span>
                        )}
                      </td>
                      <td className="px-4 py-3 text-sm text-gray-500">
                        {job.cancellation_notice_days != null ? (
                          <span>{tierLabel[job.cancellation_tier || ''] || `${job.cancellation_notice_days}d`}</span>
                        ) : '—'}
                      </td>
                      <td className="px-4 py-3 text-sm font-medium text-red-700 text-right">
                        {formatCurrency(job.cancellation_fee)}
                      </td>
                      <td className="px-4 py-3 text-sm font-medium text-green-700 text-right">
                        {formatCurrency(job.cancellation_refund)}
                      </td>
                    </>
                  ) : (
                    <>
                      <td className="px-4 py-3 text-sm text-gray-500">{formatDate(job.lost_at)}</td>
                      <td className="px-4 py-3">
                        <span className="text-sm text-gray-600">{job.lost_reason || '—'}</span>
                        {job.lost_detail && (
                          <p className="text-xs text-gray-400 truncate max-w-[200px]">{job.lost_detail}</p>
                        )}
                      </td>
                      <td className="px-4 py-3 text-sm font-medium text-gray-900 text-right">
                        {formatCurrency(job.job_value)}
                      </td>
                    </>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Pagination */}
      {total > 50 && (
        <div className="flex justify-center gap-2 mt-4">
          <button
            disabled={page <= 1}
            onClick={() => {
              const p = new URLSearchParams(searchParams);
              p.set('page', String(page - 1));
              setSearchParams(p);
            }}
            className="px-3 py-1 text-sm border rounded disabled:opacity-50"
          >
            Previous
          </button>
          <span className="px-3 py-1 text-sm text-gray-500">
            Page {page} of {Math.ceil(total / 50)}
          </span>
          <button
            disabled={page * 50 >= total}
            onClick={() => {
              const p = new URLSearchParams(searchParams);
              p.set('page', String(page + 1));
              setSearchParams(p);
            }}
            className="px-3 py-1 text-sm border rounded disabled:opacity-50"
          >
            Next
          </button>
        </div>
      )}
    </div>
  );
}
