import { useState, useEffect, useCallback } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { api } from '../services/api';
import { LOST_REASON_OPTIONS } from '@shared/index';

type ValueBucket = '' | 'under_500' | '500_2000' | '2000_10000' | 'over_10000';

const VALUE_BUCKETS: Record<ValueBucket, { min: number | null; max: number | null; label: string }> = {
  '': { min: null, max: null, label: 'All values' },
  under_500: { min: null, max: 500, label: 'Under £500' },
  '500_2000': { min: 500, max: 2000, label: '£500 – £2k' },
  '2000_10000': { min: 2000, max: 10000, label: '£2k – £10k' },
  over_10000: { min: 10000, max: null, label: 'Over £10k' },
};

const NOTICE_PERIOD_OPTIONS = [
  { value: '', label: 'Any notice' },
  { value: 'same_day', label: 'Same day' },
  { value: 'within_week', label: '<1 week' },
  { value: 'within_month', label: '1–4 weeks' },
  { value: 'over_month', label: '>1 month' },
] as const;

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
  // Manager (joined from people)
  manager1_first_name: string | null;
  manager1_last_name: string | null;
}

interface CloseoutProgress {
  items: Array<{ type: string; label: string; status: string; custom_label?: string }>;
  done: number;
  total: number;
  blocked: number;
}

const CLOSEOUT_LABELS: Record<string, string> = {
  invoice: 'Invoice',
  payment_reconcile: 'Refund',
  client_followup: 'Client',
  excess_resolve: 'Excess',
};

const DOT_COLOUR: Record<string, string> = {
  done: 'bg-green-500',
  in_progress: 'bg-amber-400',
  not_started: 'bg-gray-300',
  blocked: 'bg-red-500',
};

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
  const [closeoutData, setCloseoutData] = useState<Record<string, CloseoutProgress>>({});
  const [managerOptions, setManagerOptions] = useState<{ id: string; first_name: string; last_name: string }[]>([]);
  const [showAdvancedFilters, setShowAdvancedFilters] = useState(false);

  const tab = searchParams.get('tab') || 'cancelled';
  const page = parseInt(searchParams.get('page') || '1');
  const search = searchParams.get('search') || '';
  const sort = searchParams.get('sort') || 'date_desc';

  // Filter state — read from URL so they're shareable + persist on refresh
  const filterLostReason = searchParams.get('lost_reason') || '';
  const filterTier = searchParams.get('cancellation_tier') || '';
  const filterManager = searchParams.get('manager') || '';
  const filterDateFrom = searchParams.get('date_from') || '';
  const filterDateTo = searchParams.get('date_to') || '';
  const filterValueBucket = (searchParams.get('value_bucket') || '') as ValueBucket;
  const filterNoticePeriod = searchParams.get('notice_period') || '';
  const filterOutstandingCloseout = searchParams.get('outstanding_closeout') === 'true';
  const filterHideReopened = searchParams.get('hide_reopened') === 'true';

  const setUrlParam = (key: string, value: string) => {
    const p = new URLSearchParams(searchParams);
    if (value) p.set(key, value); else p.delete(key);
    p.delete('page');
    setSearchParams(p);
  };

  const hasActiveFilters = filterLostReason || filterTier || filterManager || filterDateFrom
    || filterDateTo || filterValueBucket || filterNoticePeriod || filterOutstandingCloseout || filterHideReopened;

  const clearAllFilters = () => {
    const p = new URLSearchParams(searchParams);
    ['lost_reason', 'cancellation_tier', 'manager', 'date_from', 'date_to', 'value_bucket',
     'notice_period', 'outstanding_closeout', 'hide_reopened', 'search', 'page'].forEach(k => p.delete(k));
    setSearchParams(p);
  };

  // Load manager dropdown options once
  useEffect(() => {
    api.get<{ data: { id: string; first_name: string; last_name: string }[] }>('/pipeline/managers')
      .then(res => setManagerOptions(res.data))
      .catch(() => {});
  }, []);

  const fetchJobs = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({
        status: tab,
        page: String(page),
        limit: '50',
        sort,
      });
      if (search) params.set('search', search);
      if (filterLostReason) params.set('lost_reason', filterLostReason);
      if (filterTier) params.set('cancellation_tier', filterTier);
      if (filterManager) params.set('manager', filterManager);
      if (filterDateFrom) params.set('date_from', filterDateFrom);
      if (filterDateTo) params.set('date_to', filterDateTo);
      if (filterNoticePeriod) params.set('notice_period', filterNoticePeriod);
      if (filterOutstandingCloseout) params.set('outstanding_closeout', 'true');
      if (filterHideReopened) params.set('hide_reopened', 'true');

      const valueB = VALUE_BUCKETS[filterValueBucket];
      if (valueB.min != null) params.set('value_min', String(valueB.min));
      if (valueB.max != null) params.set('value_max', String(valueB.max));

      const res = await api.get<{ data: LostCancelledJob[]; pagination: { total: number } }>(
        `/cancellations/list?${params}`
      );
      setJobs(res.data);
      setTotal(res.pagination.total);

      // Fetch close-out progress for cancelled jobs
      if (tab === 'cancelled' && res.data.length > 0) {
        const jobIds = res.data.map((j: LostCancelledJob) => j.id);
        api.post<{ data: Record<string, CloseoutProgress> }>('/requirements/closeout-progress', { job_ids: jobIds })
          .then(r => setCloseoutData(r.data))
          .catch(() => {});
      }
    } catch (err) {
      console.error('Failed to load jobs:', err);
    } finally {
      setLoading(false);
    }
  }, [tab, page, search, sort, filterLostReason, filterTier, filterManager, filterDateFrom, filterDateTo, filterValueBucket, filterNoticePeriod, filterOutstandingCloseout, filterHideReopened]);

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

      {/* Filters — primary row */}
      <div className="mb-3 flex items-center gap-3 flex-wrap">
        <input
          type="text"
          placeholder="Search by job number, name, or client..."
          value={search}
          onChange={e => setUrlParam('search', e.target.value)}
          className="flex-1 min-w-[280px] max-w-md border border-gray-300 rounded-lg px-3 py-2 text-sm"
        />

        <select
          value={sort}
          onChange={e => setUrlParam('sort', e.target.value)}
          className="border border-gray-300 rounded px-3 py-1.5 text-sm"
        >
          <option value="date_desc">Sort: Newest first</option>
          <option value="date_asc">Sort: Oldest first</option>
          <option value="value_desc">Sort: Highest value</option>
          <option value="value_asc">Sort: Lowest value</option>
          <option value="name">Sort: Name A–Z</option>
        </select>

        <button
          type="button"
          onClick={() => setShowAdvancedFilters(s => !s)}
          className={`px-3 py-1.5 text-xs font-medium rounded border transition-colors ${
            showAdvancedFilters || hasActiveFilters
              ? 'bg-gray-100 text-gray-900 border-gray-400'
              : 'bg-white text-gray-600 border-gray-300 hover:bg-gray-50'
          }`}
        >
          {showAdvancedFilters ? '− Filters' : '+ Filters'}
          {hasActiveFilters && !showAdvancedFilters && (
            <span className="ml-1 inline-flex items-center justify-center w-1.5 h-1.5 rounded-full bg-red-500" />
          )}
        </button>

        {hasActiveFilters && (
          <button
            type="button"
            onClick={clearAllFilters}
            className="text-xs text-gray-500 hover:text-gray-700 underline"
          >
            Clear all
          </button>
        )}
      </div>

      {/* Filters — advanced row (collapsible) */}
      {showAdvancedFilters && (
        <div className="mb-4 flex items-center gap-3 flex-wrap p-3 bg-gray-50 rounded-lg border border-gray-200">
          {/* Lost reason — Lost tab only */}
          {tab === 'lost' && (
            <select
              value={filterLostReason}
              onChange={e => setUrlParam('lost_reason', e.target.value)}
              className="border border-gray-300 rounded px-3 py-1.5 text-sm"
            >
              <option value="">All lost reasons</option>
              {LOST_REASON_OPTIONS.map(r => (
                <option key={r} value={r}>{r}</option>
              ))}
            </select>
          )}

          {/* Cancellation tier — Cancelled tab only */}
          {tab === 'cancelled' && (
            <select
              value={filterTier}
              onChange={e => setUrlParam('cancellation_tier', e.target.value)}
              className="border border-gray-300 rounded px-3 py-1.5 text-sm"
            >
              <option value="">All tiers</option>
              <option value=">7_days">&gt;7 days</option>
              <option value="2_to_7_days">2–7 days</option>
              <option value="<2_days">&lt;2 days</option>
            </select>
          )}

          {/* Notice period bucket — Cancelled tab only */}
          {tab === 'cancelled' && (
            <select
              value={filterNoticePeriod}
              onChange={e => setUrlParam('notice_period', e.target.value)}
              className="border border-gray-300 rounded px-3 py-1.5 text-sm"
            >
              {NOTICE_PERIOD_OPTIONS.map(opt => (
                <option key={opt.value} value={opt.value}>{opt.label}</option>
              ))}
            </select>
          )}

          {/* Manager */}
          <select
            value={filterManager}
            onChange={e => setUrlParam('manager', e.target.value)}
            className="border border-gray-300 rounded px-3 py-1.5 text-sm"
          >
            <option value="">All managers</option>
            {managerOptions.map(m => (
              <option key={m.id} value={m.id}>
                {m.first_name} {m.last_name}
              </option>
            ))}
          </select>

          {/* Date range — when lost / cancelled */}
          <div className="flex items-center gap-1 text-xs text-gray-600">
            <span className="text-gray-500">{tab === 'cancelled' ? 'Cancelled' : 'Lost'}:</span>
            <input
              type="date"
              value={filterDateFrom}
              onChange={e => setUrlParam('date_from', e.target.value)}
              className="border border-gray-300 rounded px-2 py-1 text-xs"
            />
            <span className="text-gray-400">→</span>
            <input
              type="date"
              value={filterDateTo}
              onChange={e => setUrlParam('date_to', e.target.value)}
              className="border border-gray-300 rounded px-2 py-1 text-xs"
            />
          </div>

          {/* Value bucket */}
          <select
            value={filterValueBucket}
            onChange={e => setUrlParam('value_bucket', e.target.value)}
            className="border border-gray-300 rounded px-3 py-1.5 text-sm"
          >
            {(Object.keys(VALUE_BUCKETS) as ValueBucket[]).map(k => (
              <option key={k || 'all'} value={k}>{VALUE_BUCKETS[k].label}</option>
            ))}
          </select>

          {/* Outstanding close-out — useful for both tabs */}
          <label className="flex items-center gap-1.5 text-sm text-gray-600 cursor-pointer" title="Show only jobs with at least one open post-hire close-out item (refund pending, invoice not sent, etc.)">
            <input
              type="checkbox"
              checked={filterOutstandingCloseout}
              onChange={e => setUrlParam('outstanding_closeout', e.target.checked ? 'true' : '')}
              className="rounded border-gray-300"
            />
            Outstanding close-out
          </label>

          {/* Hide re-opened — Cancelled tab only */}
          {tab === 'cancelled' && (
            <label className="flex items-center gap-1.5 text-sm text-gray-600 cursor-pointer" title="Hide cancelled jobs that have been re-opened as new bookings">
              <input
                type="checkbox"
                checked={filterHideReopened}
                onChange={e => setUrlParam('hide_reopened', e.target.checked ? 'true' : '')}
                className="rounded border-gray-300"
              />
              Hide re-opened
            </label>
          )}
        </div>
      )}

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
                    <th className="text-left text-xs font-medium text-gray-500 uppercase px-4 py-3">Close-out</th>
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
                  onClick={() => navigate(`/jobs/${job.id}`, { state: { from: '/jobs/lost-cancelled' } })}
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
                      <td className="px-4 py-3">
                        {closeoutData[job.id] && closeoutData[job.id].items.length > 0 ? (
                          <div className="flex items-center gap-1.5 flex-wrap">
                            {closeoutData[job.id].items.map((item, i) => (
                              <span key={i} className="inline-flex items-center gap-0.5" title={`${item.custom_label || item.label}: ${item.status.replace('_', ' ')}`}>
                                <span className={`w-2 h-2 rounded-full ${DOT_COLOUR[item.status] || DOT_COLOUR.not_started}`} />
                                <span className={`text-[10px] ${item.status === 'done' ? 'text-gray-400' : 'text-gray-600'}`}>
                                  {CLOSEOUT_LABELS[item.type] || item.label}
                                </span>
                              </span>
                            ))}
                          </div>
                        ) : (
                          <span className="text-xs text-gray-400">—</span>
                        )}
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
