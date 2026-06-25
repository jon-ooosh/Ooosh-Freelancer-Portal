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

// Click-to-sort columns. `field` is the backend sort base; the sort key sent to
// the API is `${field}_${dir}`. `defaultDir` is the direction applied when the
// column is first clicked (desc for counts/dates, asc for text).
type SortDir = 'asc' | 'desc';
const SORT_COLUMNS = [
  { field: 'name', label: 'Request', align: 'left', defaultDir: 'asc' as SortDir },
  { field: 'request_count', label: 'Times asked', align: 'right', defaultDir: 'desc' as SortDir },
  { field: 'hire_days', label: 'Hire-days', align: 'right', defaultDir: 'desc' as SortDir },
  { field: 'have_it', label: 'Do we have it?', align: 'left', defaultDir: 'asc' as SortDir },
  { field: 'last_asked', label: 'Last asked', align: 'left', defaultDir: 'desc' as SortDir },
] as const;

const PREFS_KEY = 'ooosh_backline_demand_prefs';
const DEFAULT_SORT = 'request_count_desc';

function loadPrefs(): { sort: string; statusFilter: string } {
  try {
    const raw = localStorage.getItem(PREFS_KEY);
    if (raw) {
      const p = JSON.parse(raw);
      return { sort: p.sort || DEFAULT_SORT, statusFilter: p.statusFilter || '' };
    }
  } catch {
    /* ignore */
  }
  return { sort: DEFAULT_SORT, statusFilter: '' };
}

function fmtDate(d: string | null) {
  if (!d) return '—';
  return new Date(d).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: '2-digit' });
}

export default function BacklineMatcherPage() {
  const [rows, setRows] = useState<DemandRow[]>([]);
  const [loading, setLoading] = useState(true);
  const initial = loadPrefs();
  const [sort, setSort] = useState(initial.sort);
  const [q, setQ] = useState('');
  const [statusFilter, setStatusFilter] = useState(initial.statusFilter);

  // Persist sort + status filter so the view comes back the way staff left it.
  useEffect(() => {
    try {
      localStorage.setItem(PREFS_KEY, JSON.stringify({ sort, statusFilter }));
    } catch {
      /* ignore */
    }
  }, [sort, statusFilter]);

  function onSortColumn(field: string, defaultDir: SortDir) {
    setSort((cur) => {
      const [curField, curDir] = cur.split(/_(asc|desc)$/);
      if (curField === field) {
        return `${field}_${curDir === 'asc' ? 'desc' : 'asc'}`;
      }
      return `${field}_${defaultDir}`;
    });
  }

  async function updateStatus(id: string, status: DemandRow['have_it_status']) {
    setRows((prev) => prev.map((r) => (r.id === id ? { ...r, have_it_status: status } : r)));
    try {
      await api.patch(`/backline-matcher/demand/${id}`, { have_it_status: status });
    } catch {
      loadDemand();
    }
  }

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
          </div>
        </div>

        <div className="bg-white rounded-xl border border-gray-200 overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 text-gray-500 text-xs uppercase tracking-wide">
              <tr>
                {SORT_COLUMNS.map((col) => {
                  const [curField, curDir] = sort.split(/_(asc|desc)$/);
                  const active = curField === col.field;
                  // "Do we have it?" header sits before the Jobs column.
                  const th = (
                    <th
                      key={col.field}
                      onClick={() => onSortColumn(col.field, col.defaultDir)}
                      className={`${col.align === 'right' ? 'text-right' : 'text-left'} px-4 py-2 font-medium cursor-pointer select-none hover:text-gray-700 ${active ? 'text-gray-900' : ''}`}
                      title="Click to sort"
                    >
                      {col.label}
                      <span className="ml-1 inline-block w-2 text-gray-400">
                        {active ? (curDir === 'asc' ? '▲' : '▼') : ''}
                      </span>
                    </th>
                  );
                  // Inject the non-sortable Jobs column between "Do we have it?" and "Last asked".
                  if (col.field === 'have_it') {
                    return [th, <th key="jobs" className="text-left px-4 py-2 font-medium">Jobs</th>];
                  }
                  return th;
                })}
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
                        <select
                          value={row.have_it_status}
                          onChange={(e) => updateStatus(row.id, e.target.value as DemandRow['have_it_status'])}
                          className={`text-xs font-medium pl-2 pr-6 py-0.5 rounded-full border-0 cursor-pointer focus:ring-2 focus:ring-ooosh-400 ${badge.cls}`}
                          title="Update whether we stock this"
                        >
                          <option value="no">Not stocked</option>
                          <option value="sort_of">Similar</option>
                          <option value="yes">In stock</option>
                        </select>
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
