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

type HaveIt = 'yes' | 'no' | 'sort_of' | 'used_to';
type Priority = 'high' | 'medium' | 'low';
type Acquisition = 'none' | 'getting_soon' | 'ordered' | 'not_getting';

interface DemandRow {
  id: string;
  display_request: string;
  request_count: number;
  total_hire_days: number;
  job_refs: string[];
  have_it_status: HaveIt;
  priority: Priority | null;
  acquisition_status: Acquisition;
  notes: string | null;
  first_requested_at: string;
  last_requested_at: string;
}

const STATUS_BADGE: Record<HaveIt, { label: string; cls: string }> = {
  yes: { label: 'In stock', cls: 'bg-green-100 text-green-700' },
  sort_of: { label: 'Similar', cls: 'bg-amber-100 text-amber-700' },
  used_to: { label: 'We used to', cls: 'bg-orange-100 text-orange-700' },
  no: { label: 'Not stocked', cls: 'bg-red-100 text-red-700' },
};

const PRIORITY_BADGE: Record<Priority, { label: string; cls: string }> = {
  high: { label: 'High', cls: 'bg-red-100 text-red-700' },
  medium: { label: 'Medium', cls: 'bg-amber-100 text-amber-700' },
  low: { label: 'Low', cls: 'bg-gray-100 text-gray-600' },
};

const ACQUISITION_BADGE: Record<Acquisition, { label: string; cls: string }> = {
  none: { label: '—', cls: 'bg-gray-50 text-gray-400' },
  getting_soon: { label: 'Getting soon', cls: 'bg-blue-100 text-blue-700' },
  ordered: { label: 'Ordered', cls: 'bg-indigo-100 text-indigo-700' },
  not_getting: { label: 'Not getting', cls: 'bg-gray-100 text-gray-500' },
};

// Idea 2: nudge to prioritise something asked for repeatedly but still a gap.
const PRIORITISE_HINT_THRESHOLD = 3;

// Click-to-sort columns. `field` is the backend sort base; the sort key sent to
// the API is `${field}_${dir}`. `defaultDir` is the direction applied when the
// column is first clicked (desc for counts/dates, asc for text).
type SortDir = 'asc' | 'desc';
const SORT_COLUMNS = [
  { field: 'name', label: 'Request', align: 'left', defaultDir: 'asc' as SortDir },
  { field: 'request_count', label: 'Times asked', align: 'right', defaultDir: 'desc' as SortDir },
  { field: 'hire_days', label: 'Hire-days', align: 'right', defaultDir: 'desc' as SortDir },
  { field: 'have_it', label: 'Do we have it?', align: 'left', defaultDir: 'asc' as SortDir },
  { field: 'priority', label: 'Priority', align: 'left', defaultDir: 'asc' as SortDir },
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
  // Priority filter seeds from ?priority= (dashboard "Backline to Buy" deep-link).
  const [priorityFilter, setPriorityFilter] = useState(() => {
    const p = new URLSearchParams(window.location.search).get('priority') || '';
    return (['high', 'medium', 'low'] as string[]).includes(p) ? p : '';
  });
  const [acquisitionFilter, setAcquisitionFilter] = useState('');

  // Ad-hoc "add item" (skip the AI matcher) — for broken kit needing a
  // replacement, or suggestions to stock something.
  const [showAdd, setShowAdd] = useState(false);
  const [addRequest, setAddRequest] = useState('');
  const [addNotes, setAddNotes] = useState('');
  const [addJobs, setAddJobs] = useState('');
  const [addHaveIt, setAddHaveIt] = useState<HaveIt>('no');
  const [addPriority, setAddPriority] = useState<'' | Priority>('');
  const [addAcquisition, setAddAcquisition] = useState<Acquisition>('none');
  const [adding, setAdding] = useState(false);
  const [addError, setAddError] = useState('');

  function openAdd() {
    setAddRequest('');
    setAddNotes('');
    setAddJobs('');
    setAddHaveIt('no');
    setAddPriority('');
    setAddAcquisition('none');
    setAddError('');
    setShowAdd(true);
  }

  async function submitAdd() {
    if (!addRequest.trim() || adding) return;
    setAdding(true);
    setAddError('');
    try {
      const jobNumbers = addJobs
        .split(/[\s,]+/)
        .map((s) => s.trim())
        .filter((s) => /^\d+$/.test(s));
      await api.post('/backline-matcher/demand', {
        request: addRequest.trim(),
        notes: addNotes.trim() || undefined,
        have_it_status: addHaveIt,
        priority: addPriority || undefined,
        acquisition_status: addAcquisition,
        jobNumbers,
      });
      setShowAdd(false);
      await loadDemand();
    } catch {
      setAddError('Could not add — please try again.');
    } finally {
      setAdding(false);
    }
  }

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

  async function updateRow(id: string, patch: Partial<Pick<DemandRow, 'have_it_status' | 'priority' | 'acquisition_status'>>) {
    setRows((prev) => prev.map((r) => {
      if (r.id !== id) return r;
      const next = { ...r, ...patch };
      // Mirror the backend rule: flipping to In stock clears the plan.
      if (patch.have_it_status === 'yes' && patch.acquisition_status === undefined) {
        next.acquisition_status = 'none';
      }
      return next;
    }));
    try {
      await api.patch(`/backline-matcher/demand/${id}`, patch);
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
      if (priorityFilter) params.set('priority', priorityFilter);
      if (acquisitionFilter) params.set('acquisition', acquisitionFilter);
      const resp = await api.get<{ items: DemandRow[] }>(`/backline-matcher/demand?${params.toString()}`);
      setRows(resp.items || []);
    } catch {
      setRows([]);
    } finally {
      setLoading(false);
    }
  }, [sort, q, statusFilter, priorityFilter, acquisitionFilter]);

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
              <option value="">All stock</option>
              <option value="no">Not stocked</option>
              <option value="sort_of">Similar only</option>
              <option value="used_to">We used to</option>
              <option value="yes">In stock</option>
            </select>
            <select
              value={priorityFilter}
              onChange={(e) => setPriorityFilter(e.target.value)}
              className="px-3 py-1.5 border border-gray-300 rounded-lg text-sm"
            >
              <option value="">All priorities</option>
              <option value="high">High</option>
              <option value="medium">Medium</option>
              <option value="low">Low</option>
            </select>
            <select
              value={acquisitionFilter}
              onChange={(e) => setAcquisitionFilter(e.target.value)}
              className="px-3 py-1.5 border border-gray-300 rounded-lg text-sm"
            >
              <option value="">All plans</option>
              <option value="getting_soon">Getting soon</option>
              <option value="ordered">Ordered</option>
              <option value="not_getting">Not getting</option>
              <option value="none">No plan</option>
            </select>
            <button
              onClick={openAdd}
              className="px-3 py-1.5 bg-ooosh-600 text-white rounded-lg text-sm font-medium hover:bg-ooosh-700"
            >
              + Add item
            </button>
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
                  // Inject the non-sortable Plan + Jobs columns after Priority.
                  if (col.field === 'priority') {
                    return [
                      th,
                      <th key="plan" className="text-left px-4 py-2 font-medium">Plan</th>,
                      <th key="jobs" className="text-left px-4 py-2 font-medium">Jobs</th>,
                    ];
                  }
                  return th;
                })}
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {loading ? (
                <tr><td colSpan={8} className="px-4 py-6 text-center text-gray-400">Loading…</td></tr>
              ) : rows.length === 0 ? (
                <tr><td colSpan={8} className="px-4 py-6 text-center text-gray-400">No requests logged yet.</td></tr>
              ) : (
                rows.map((row) => {
                  const badge = STATUS_BADGE[row.have_it_status];
                  const priBadge = row.priority ? PRIORITY_BADGE[row.priority] : { label: '—', cls: 'bg-gray-50 text-gray-400' };
                  const acqBadge = ACQUISITION_BADGE[row.acquisition_status];
                  // "Not getting" is a closed decision — de-emphasise the row.
                  const dim = row.acquisition_status === 'not_getting';
                  // Idea 2: nudge to prioritise a repeatedly-asked gap that isn't
                  // already high priority.
                  const showHint =
                    row.request_count >= PRIORITISE_HINT_THRESHOLD &&
                    row.have_it_status !== 'yes' &&
                    row.priority !== 'high' &&
                    row.acquisition_status === 'none';
                  return (
                    <tr key={row.id} className={`hover:bg-gray-50 ${dim ? 'opacity-55' : ''}`}>
                      <td className="px-4 py-2 font-medium text-gray-900">
                        {row.display_request}
                        {showHint && (
                          <span
                            className="ml-2 inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium bg-amber-50 text-amber-700 align-middle"
                            title={`Asked ${row.request_count}× and still a gap — consider prioritising`}
                          >↑ asked {row.request_count}×</span>
                        )}
                        {row.notes && <div className="text-xs text-gray-400 font-normal whitespace-pre-line">{row.notes}</div>}
                      </td>
                      <td className="px-4 py-2 text-right text-gray-700">{row.request_count}</td>
                      <td className="px-4 py-2 text-right text-gray-700">{row.total_hire_days || '—'}</td>
                      <td className="px-4 py-2">
                        <select
                          value={row.have_it_status}
                          onChange={(e) => updateRow(row.id, { have_it_status: e.target.value as HaveIt })}
                          className={`text-xs font-medium pl-2 pr-6 py-0.5 rounded-full border-0 cursor-pointer focus:ring-2 focus:ring-ooosh-400 ${badge.cls}`}
                          title="Update whether we stock this"
                        >
                          <option value="no">Not stocked</option>
                          <option value="sort_of">Similar</option>
                          <option value="used_to">We used to</option>
                          <option value="yes">In stock</option>
                        </select>
                      </td>
                      <td className="px-4 py-2">
                        <select
                          value={row.priority ?? ''}
                          onChange={(e) => updateRow(row.id, { priority: (e.target.value || null) as Priority | null })}
                          className={`text-xs font-medium pl-2 pr-6 py-0.5 rounded-full border-0 cursor-pointer focus:ring-2 focus:ring-ooosh-400 ${priBadge.cls}`}
                          title="Set priority"
                        >
                          <option value="">— None</option>
                          <option value="high">High</option>
                          <option value="medium">Medium</option>
                          <option value="low">Low</option>
                        </select>
                      </td>
                      <td className="px-4 py-2">
                        <select
                          value={row.acquisition_status}
                          onChange={(e) => updateRow(row.id, { acquisition_status: e.target.value as Acquisition })}
                          disabled={row.have_it_status === 'yes'}
                          className={`text-xs font-medium pl-2 pr-6 py-0.5 rounded-full border-0 cursor-pointer focus:ring-2 focus:ring-ooosh-400 disabled:cursor-not-allowed disabled:opacity-60 ${acqBadge.cls}`}
                          title={row.have_it_status === 'yes' ? 'In stock — no plan needed' : 'Set the acquisition plan'}
                        >
                          <option value="none">— No plan</option>
                          <option value="getting_soon">Getting soon</option>
                          <option value="ordered">Ordered</option>
                          <option value="not_getting">Not getting</option>
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

      {/* Ad-hoc add item modal */}
      {showAdd && (
        <div className="fixed inset-0 bg-black/30 flex items-center justify-center z-50 p-4" onClick={() => setShowAdd(false)}>
          <div className="bg-white rounded-xl shadow-xl p-6 w-[440px] max-w-full max-h-[85vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
            <h3 className="text-lg font-semibold text-gray-900 mb-1">Add backline item</h3>
            <p className="text-xs text-gray-500 mb-4">
              For kit that needs replacing or has been suggested — no AI search needed. If it's already tracked, this
              merges into the existing row.
            </p>
            <div className="space-y-3">
              <div>
                <label className="text-xs text-gray-500 mb-1 block">Item</label>
                <input
                  type="text"
                  value={addRequest}
                  onChange={(e) => setAddRequest(e.target.value)}
                  placeholder="e.g. Fender Twin Reverb"
                  className="w-full border border-gray-300 rounded px-3 py-2 text-sm"
                  autoFocus
                />
              </div>
              <div>
                <label className="text-xs text-gray-500 mb-1 block">Note (optional)</label>
                <textarea
                  value={addNotes}
                  onChange={(e) => setAddNotes(e.target.value)}
                  placeholder="e.g. Broke on last hire — need a replacement"
                  rows={2}
                  className="w-full border border-gray-300 rounded px-3 py-2 text-sm resize-y"
                />
              </div>
              <div>
                <label className="text-xs text-gray-500 mb-1 block">Link to job(s) — optional</label>
                <input
                  type="text"
                  value={addJobs}
                  onChange={(e) => setAddJobs(e.target.value)}
                  placeholder="HireHop job number(s), comma-separated"
                  className="w-full border border-gray-300 rounded px-3 py-2 text-sm"
                />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-xs text-gray-500 mb-1 block">Do we stock it?</label>
                  <select
                    value={addHaveIt}
                    onChange={(e) => setAddHaveIt(e.target.value as HaveIt)}
                    className="w-full border border-gray-300 rounded px-3 py-2 text-sm"
                  >
                    <option value="no">Not stocked</option>
                    <option value="sort_of">Similar only</option>
                    <option value="used_to">We used to</option>
                    <option value="yes">In stock</option>
                  </select>
                </div>
                <div>
                  <label className="text-xs text-gray-500 mb-1 block">Priority</label>
                  <select
                    value={addPriority}
                    onChange={(e) => setAddPriority(e.target.value as '' | Priority)}
                    className="w-full border border-gray-300 rounded px-3 py-2 text-sm"
                  >
                    <option value="">— None</option>
                    <option value="high">High</option>
                    <option value="medium">Medium</option>
                    <option value="low">Low</option>
                  </select>
                </div>
              </div>
              {addHaveIt !== 'yes' && (
                <div>
                  <label className="text-xs text-gray-500 mb-1 block">Plan</label>
                  <select
                    value={addAcquisition}
                    onChange={(e) => setAddAcquisition(e.target.value as Acquisition)}
                    className="w-full border border-gray-300 rounded px-3 py-2 text-sm"
                  >
                    <option value="none">— No plan yet</option>
                    <option value="getting_soon">Getting soon</option>
                    <option value="ordered">Ordered</option>
                    <option value="not_getting">Not getting</option>
                  </select>
                </div>
              )}
              {addError && <p className="text-xs text-red-600">{addError}</p>}
            </div>
            <div className="flex justify-end gap-2 mt-5">
              <button onClick={() => setShowAdd(false)} className="px-3 py-1.5 text-sm text-gray-600 hover:text-gray-800">Cancel</button>
              <button
                onClick={submitAdd}
                disabled={!addRequest.trim() || adding}
                className="px-4 py-1.5 text-sm bg-ooosh-600 text-white rounded hover:bg-ooosh-700 disabled:opacity-50"
              >{adding ? 'Adding…' : 'Add item'}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
