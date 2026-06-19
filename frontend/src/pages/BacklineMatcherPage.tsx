/**
 * BacklineMatcherPage — Operations > Backline Matcher.
 *
 * Two halves: the AI matcher search (shared <BacklineMatcher/>) and the demand
 * tracker — a sortable/searchable table of what clients keep asking for,
 * replacing Monday board 2227909940. Purchasing intelligence: most-requested
 * items, whether we stock them, total potential hire-days.
 */
import { useState, useEffect, useCallback } from 'react';
import { api } from '../services/api';
import BacklineMatcher from '../components/BacklineMatcher';

interface DemandRow {
  id: string;
  display_request: string;
  request_count: number;
  total_hire_days: number;
  job_refs: string[];
  have_it_status: 'yes' | 'no' | 'sort_of';
  notes: string | null;
  first_requested_at: string;
  last_requested_at: string;
}

const STATUS_BADGE: Record<DemandRow['have_it_status'], { label: string; cls: string }> = {
  yes: { label: 'In stock', cls: 'bg-green-100 text-green-700' },
  sort_of: { label: 'Similar', cls: 'bg-amber-100 text-amber-700' },
  no: { label: 'Not stocked', cls: 'bg-red-100 text-red-700' },
};

const SORTS = [
  { key: 'count', label: 'Most requested' },
  { key: 'recent', label: 'Recently asked' },
  { key: 'days', label: 'Most hire-days' },
  { key: 'name', label: 'A–Z' },
];

function fmtDate(d: string | null) {
  if (!d) return '—';
  return new Date(d).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: '2-digit' });
}

export default function BacklineMatcherPage() {
  const [rows, setRows] = useState<DemandRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [sort, setSort] = useState('count');
  const [q, setQ] = useState('');
  const [statusFilter, setStatusFilter] = useState('');

  const loadDemand = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({ sort });
      if (q.trim()) params.set('q', q.trim());
      if (statusFilter) params.set('status', statusFilter);
      const resp = await api.get<{ items: DemandRow[] }>(`/backline-matcher/demand?${params.toString()}`);
      setRows(resp.items || []);
    } catch {
      setRows([]);
    } finally {
      setLoading(false);
    }
  }, [sort, q, statusFilter]);

  useEffect(() => {
    const t = setTimeout(loadDemand, 250);
    return () => clearTimeout(t);
  }, [loadDemand]);

  return (
    <div className="max-w-5xl mx-auto px-4 py-6 space-y-8">
      <div>
        <h1 className="text-2xl font-bold text-gray-900">🎸 Backline Matcher</h1>
        <p className="text-sm text-gray-500 mt-1">
          Find alternatives when a client asks for kit we might not stock. Every search is logged below as
          purchasing intelligence.
        </p>
      </div>

      <BacklineMatcher onLogged={loadDemand} />

      {/* Demand tracker */}
      <div className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-lg font-semibold text-gray-900">Demand Tracker</h2>
          <div className="flex flex-wrap items-center gap-2">
            <input
              type="text"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Search requests…"
              className="px-3 py-1.5 border border-gray-300 rounded-lg text-sm"
            />
            <select
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value)}
              className="px-3 py-1.5 border border-gray-300 rounded-lg text-sm"
            >
              <option value="">All statuses</option>
              <option value="no">Not stocked</option>
              <option value="sort_of">Similar only</option>
              <option value="yes">In stock</option>
            </select>
            <select
              value={sort}
              onChange={(e) => setSort(e.target.value)}
              className="px-3 py-1.5 border border-gray-300 rounded-lg text-sm"
            >
              {SORTS.map((s) => (
                <option key={s.key} value={s.key}>{s.label}</option>
              ))}
            </select>
          </div>
        </div>

        <div className="bg-white rounded-xl border border-gray-200 overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 text-gray-500 text-xs uppercase tracking-wide">
              <tr>
                <th className="text-left px-4 py-2 font-medium">Request</th>
                <th className="text-right px-4 py-2 font-medium">Times asked</th>
                <th className="text-right px-4 py-2 font-medium">Hire-days</th>
                <th className="text-left px-4 py-2 font-medium">Do we have it?</th>
                <th className="text-left px-4 py-2 font-medium">Jobs</th>
                <th className="text-left px-4 py-2 font-medium">Last asked</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {loading ? (
                <tr><td colSpan={6} className="px-4 py-6 text-center text-gray-400">Loading…</td></tr>
              ) : rows.length === 0 ? (
                <tr><td colSpan={6} className="px-4 py-6 text-center text-gray-400">No requests logged yet.</td></tr>
              ) : (
                rows.map((row) => {
                  const badge = STATUS_BADGE[row.have_it_status];
                  return (
                    <tr key={row.id} className="hover:bg-gray-50">
                      <td className="px-4 py-2 font-medium text-gray-900">
                        {row.display_request}
                        {row.notes && <div className="text-xs text-gray-400 font-normal">{row.notes}</div>}
                      </td>
                      <td className="px-4 py-2 text-right text-gray-700">{row.request_count}</td>
                      <td className="px-4 py-2 text-right text-gray-700">{row.total_hire_days || '—'}</td>
                      <td className="px-4 py-2">
                        <span className={`text-xs font-medium px-2 py-0.5 rounded-full ${badge.cls}`}>{badge.label}</span>
                      </td>
                      <td className="px-4 py-2 text-gray-500 text-xs">
                        {row.job_refs.length > 0 ? row.job_refs.slice(0, 4).map((j) => (
                          <a
                            key={j}
                            href={`https://myhirehop.com/job.php?id=${j}`}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-ooosh-600 hover:underline mr-1.5"
                          >#{j}</a>
                        )) : '—'}
                        {row.job_refs.length > 4 && <span className="text-gray-400">+{row.job_refs.length - 4}</span>}
                      </td>
                      <td className="px-4 py-2 text-gray-500 text-xs">{fmtDate(row.last_requested_at)}</td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
