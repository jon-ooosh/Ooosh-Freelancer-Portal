import { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { Link } from 'react-router-dom';
import { api } from '../services/api';

// ── Types ────────────────────────────────────────────────────────────

interface Assignment {
  id: string;
  person_id: string | null;
  first_name: string | null;
  last_name: string | null;
  role: string;
  status: string;
  agreed_rate: number | null;
  rate_type: string | null;
  is_ooosh_crew: boolean;
  confirmed_at: string | null;
  expected_expenses: number | null;
  invoice_received: boolean;
  invoice_amount: number | null;
}

interface OpsQuote {
  id: string;
  job_id: string | null;
  job_type: 'delivery' | 'collection' | 'crewed';
  calculation_mode: string;
  venue_name: string | null;
  venue_id: string | null;
  distance_miles: number | null;
  arrival_time: string | null;
  job_date: string | Date | null;
  job_finish_date: string | Date | null;
  is_multi_day: boolean;
  status: string;
  ops_status: string;
  key_points: string | null;
  client_introduction: string | null;
  work_type: string | null;
  work_type_other: string | null;
  work_description: string | null;
  freelancer_fee: number | null;
  freelancer_fee_rounded: number | null;
  client_charge_total: number | null;
  client_charge_rounded: number | null;
  run_group: string | null;
  run_order: number | null;
  run_group_fee: number | null;
  is_local: boolean;
  tolls_status: string;
  accommodation_status: string;
  flight_status: string;
  completed_at: string | null;
  completed_by: string | null;
  completion_notes: string | null;
  completion_signature: string | null;
  completion_photos: string[] | null;
  customer_present: boolean | null;
  what_is_it: string | null;
  num_days: number | null;
  crew_count: number | null;
  expenses_included: number | null;
  expenses_not_included: number | null;
  internal_notes: string | null;
  freelancer_notes: string | null;
  // Joined fields
  job_name: string | null;
  hh_job_number: number | null;
  client_name: string | null;
  out_date: string | null;
  return_date: string | null;
  linked_venue_name: string | null;
  venue_address: string | null;
  venue_city: string | null;
  assignments: Assignment[];
}

// ── Constants ────────────────────────────────────────────────────────

const OPS_STATUSES = ['todo', 'arranging', 'arranged', 'dispatched', 'completed', 'cancelled'] as const;

const OPS_STATUS_CONFIG: Record<string, { label: string; colour: string; bgColour: string }> = {
  todo: { label: 'To Be Arranged', colour: 'text-red-700', bgColour: 'bg-red-100' },
  arranging: { label: 'Arranging', colour: 'text-amber-700', bgColour: 'bg-amber-100' },
  arranged: { label: 'Arranged', colour: 'text-blue-700', bgColour: 'bg-blue-100' },
  dispatched: { label: 'Dispatched', colour: 'text-indigo-700', bgColour: 'bg-indigo-100' },
  completed: { label: 'Completed', colour: 'text-green-700', bgColour: 'bg-green-100' },
  cancelled: { label: 'Cancelled', colour: 'text-gray-500', bgColour: 'bg-gray-100' },
};

const JOB_TYPE_LABELS: Record<string, string> = {
  delivery: 'DEL',
  collection: 'COL',
  crewed: 'CREW',
};

const JOB_TYPE_COLOURS: Record<string, string> = {
  delivery: 'bg-blue-100 text-blue-700',
  collection: 'bg-orange-100 text-orange-700',
  crewed: 'bg-purple-100 text-purple-700',
};

const RUN_PILL_STYLES = [
  { border: 'border-l-violet-500', pill: 'bg-violet-100 text-violet-700' },
  { border: 'border-l-emerald-500', pill: 'bg-emerald-100 text-emerald-700' },
  { border: 'border-l-sky-500', pill: 'bg-sky-100 text-sky-700' },
  { border: 'border-l-rose-500', pill: 'bg-rose-100 text-rose-700' },
  { border: 'border-l-amber-500', pill: 'bg-amber-100 text-amber-700' },
];

function normaliseDateKey(d: string | Date | null): string {
  if (!d) return '';
  if (d instanceof Date) return d.toISOString().split('T')[0];
  return typeof d === 'string' ? (d.includes('T') ? d.split('T')[0] : d) : '';
}

interface PersonOption {
  id: string;
  first_name: string;
  last_name: string;
  skills: string[];
  is_insured_on_vehicles: boolean;
  is_approved: boolean;
  current_organisations?: Array<{ organisation_name: string; role: string }> | null;
}

// ── Main Page ────────────────────────────────────────────────────────

export default function TransportOpsPage() {
  const [quotes, setQuotes] = useState<OpsQuote[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [filter, setFilter] = useState<'all' | 'transport' | 'crewed'>('all');
  const [viewMode, setViewMode] = useState<'table' | 'calendar'>('table');
  const [showCompleted, setShowCompleted] = useState(false);
  const [showCancelled, setShowCancelled] = useState(false);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [assignModalQuoteId, setAssignModalQuoteId] = useState<string | null>(null);
  const [assignRole, setAssignRole] = useState('driver');
  const [peopleSearch, setPeopleSearch] = useState('');
  const [peopleOptions, setPeopleOptions] = useState<PersonOption[]>([]);
  const [crewHistory, setCrewHistory] = useState<{ person_id: string; first_name: string; last_name: string; role: string; job_count: number; last_job_date: string; avg_rate: number }[]>([]);

  useEffect(() => {
    loadOps();
  }, [filter]);

  // Escape key to close assign modal
  useEffect(() => {
    function handleEscape(e: KeyboardEvent) {
      if (e.key === 'Escape' && assignModalQuoteId) {
        setAssignModalQuoteId(null);
        setPeopleSearch('');
        setPeopleOptions([]);
      }
    }
    document.addEventListener('keydown', handleEscape);
    return () => document.removeEventListener('keydown', handleEscape);
  }, [assignModalQuoteId]);

  async function loadOps() {
    try {
      setLoading(true);
      const params = filter !== 'all' ? `?job_type=${filter}` : '';
      const res = await api.get<{ data: OpsQuote[] }>(`/quotes/ops/overview${params}`);
      setQuotes(res.data);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load');
    } finally {
      setLoading(false);
    }
  }

  async function updateOpsStatus(quoteId: string, newStatus: string) {
    try {
      await api.patch(`/quotes/${quoteId}/ops-status`, { ops_status: newStatus });
      setQuotes((prev) =>
        prev.map((q) => (q.id === quoteId ? { ...q, ops_status: newStatus } : q))
      );
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Failed to update status');
    }
  }

  async function searchPeople(search: string) {
    try {
      const data = await api.get<{ data: PersonOption[] }>(
        `/people?search=${encodeURIComponent(search)}&limit=10&is_freelancer=true&is_approved=true`
      );
      setPeopleOptions(data.data);
    } catch {
      console.error('Failed to search people');
    }
  }

  async function assignPerson(quoteId: string, personId: string, role: string) {
    try {
      await api.post(`/quotes/${quoteId}/assignments`, { personId, role });
      await loadOps();
      setAssignModalQuoteId(null);
      setPeopleSearch('');
      setPeopleOptions([]);
      setAssignRole('driver');
    } catch {
      console.error('Failed to assign person');
    }
  }

  async function removeAssignment(quoteId: string, assignmentId: string) {
    try {
      await api.delete(`/quotes/${quoteId}/assignments/${assignmentId}`);
      await loadOps();
    } catch {
      console.error('Failed to remove assignment');
    }
  }

  function openAssignModal(quoteId: string) {
    setAssignModalQuoteId(quoteId);
    setPeopleSearch('');
    setPeopleOptions([]);
    setAssignRole('driver');
    setCrewHistory([]);

    // Load crew history for this quote's job/venue/client
    const quote = quotes.find(q => q.id === quoteId);
    if (quote && quote.job_type === 'crewed') {
      const params = new URLSearchParams();
      if (quote.job_id) params.set('job_id', quote.job_id);
      if (quote.venue_id) params.set('venue_id', quote.venue_id);
      if (quote.client_name) params.set('client_name', quote.client_name);
      if (params.toString()) {
        api.get<{ data: typeof crewHistory }>(`/quotes/crew-history?${params}`)
          .then(res => setCrewHistory(res.data || []))
          .catch(() => {});
      }
    }
  }

  // ── Editing handlers ──

  const [editingQuote, setEditingQuote] = useState<OpsQuote | null>(null);

  function openEditModal(quote: OpsQuote) {
    setEditingQuote(quote);
  }

  async function updateOpsDetails(quoteId: string, fields: Record<string, unknown>) {
    try {
      await api.put(`/quotes/${quoteId}/ops-details`, fields);
      setQuotes((prev) =>
        prev.map((q) => (q.id === quoteId ? { ...q, ...fields } : q))
      );
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Failed to update');
    }
  }

  async function updateRunGroup(quoteId: string, runGroup: string | null, runOrder: number | null) {
    try {
      await api.put(`/quotes/${quoteId}/run-group`, { run_group: runGroup, run_order: runOrder });
      // Full reload to ensure all quotes see the updated run groups
      const params = filter !== 'all' ? `?job_type=${filter}` : '';
      const res = await api.get<{ data: OpsQuote[] }>(`/quotes/ops/overview${params}`);
      setQuotes(res.data);
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Failed to update run group');
    }
  }

  async function saveQuoteEdit(quoteId: string, fields: Record<string, unknown>) {
    try {
      await api.put(`/quotes/${quoteId}`, fields);
      await loadOps();
      setEditingQuote(null);
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Failed to save');
    }
  }

  // Group quotes by ops_status for table view
  const grouped = useMemo(() => {
    const groups: Record<string, OpsQuote[]> = {};
    for (const status of OPS_STATUSES) {
      groups[status] = [];
    }
    for (const q of quotes) {
      const status = q.ops_status || 'todo';
      if (!groups[status]) groups[status] = [];
      groups[status].push(q);
    }
    return groups;
  }, [quotes]);

  // Calendar data: group by date (respects completed/cancelled toggles)
  const calendarData = useMemo(() => {
    const byDate: Record<string, OpsQuote[]> = {};
    for (const q of quotes) {
      if (q.ops_status === 'completed' && !showCompleted) continue;
      if (q.ops_status === 'cancelled' && !showCancelled) continue;
      const dateKey = normaliseDateKey(q.job_date) || 'unscheduled';
      if (!byDate[dateKey]) byDate[dateKey] = [];
      byDate[dateKey].push(q);
    }
    return byDate;
  }, [quotes, showCompleted, showCancelled]);

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-ooosh-600" />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Crew & Transport</h1>
          <p className="text-sm text-gray-500">
            {quotes.length} item{quotes.length !== 1 ? 's' : ''} total
          </p>
        </div>

        <div className="flex items-center gap-2 flex-wrap">
          {/* Filter pills */}
          <div className="flex rounded-lg border border-gray-300 overflow-hidden text-sm">
            {(['all', 'transport', 'crewed'] as const).map((f) => (
              <button
                key={f}
                onClick={() => setFilter(f)}
                className={`px-3 py-1.5 ${filter === f ? 'bg-ooosh-600 text-white' : 'bg-white text-gray-700 hover:bg-gray-50'}`}
              >
                {f === 'all' ? 'All' : f === 'transport' ? 'D&C' : 'Crewed'}
              </button>
            ))}
          </div>

          {/* View toggle */}
          <div className="flex rounded-lg border border-gray-300 overflow-hidden text-sm">
            <button
              onClick={() => setViewMode('table')}
              className={`px-3 py-1.5 ${viewMode === 'table' ? 'bg-ooosh-600 text-white' : 'bg-white text-gray-700 hover:bg-gray-50'}`}
            >
              Table
            </button>
            <button
              onClick={() => setViewMode('calendar')}
              className={`px-3 py-1.5 ${viewMode === 'calendar' ? 'bg-ooosh-600 text-white' : 'bg-white text-gray-700 hover:bg-gray-50'}`}
            >
              Calendar
            </button>
          </div>

          {/* Show completed/cancelled toggles */}
          <label className="flex items-center gap-1.5 text-sm text-gray-600 cursor-pointer">
            <input
              type="checkbox"
              checked={showCompleted}
              onChange={(e) => setShowCompleted(e.target.checked)}
              className="rounded border-gray-300 text-green-600 focus:ring-green-500"
            />
            Completed
          </label>
          <label className="flex items-center gap-1.5 text-sm text-gray-600 cursor-pointer">
            <input
              type="checkbox"
              checked={showCancelled}
              onChange={(e) => setShowCancelled(e.target.checked)}
              className="rounded border-gray-300 text-gray-400 focus:ring-gray-400"
            />
            Cancelled
          </label>
        </div>
      </div>

      {error && (
        <div className="bg-red-50 border border-red-200 rounded-lg p-3 text-sm text-red-700">{error}</div>
      )}

      {/* Table view */}
      {viewMode === 'table' && (
        <div className="space-y-6">
          {OPS_STATUSES.filter((s) => {
            if (s === 'completed') return showCompleted;
            if (s === 'cancelled') return showCancelled;
            return true;
          }).map((status) => {
            const items = grouped[status] || [];
            if (items.length === 0 && (status === 'completed' || status === 'cancelled')) return null;

            const config = OPS_STATUS_CONFIG[status];

            return (
              <div key={status} className="bg-white rounded-lg shadow-sm border border-gray-200 overflow-hidden">
                {/* Section header */}
                <div className={`px-4 py-2.5 border-b border-gray-200 flex items-center justify-between ${config.bgColour}`}>
                  <div className="flex items-center gap-2">
                    <h2 className={`font-semibold text-sm ${config.colour}`}>{config.label}</h2>
                    <span className={`text-xs px-1.5 py-0.5 rounded-full ${config.bgColour} ${config.colour} font-medium`}>
                      {items.length}
                    </span>
                  </div>
                </div>

                {items.length === 0 ? (
                  <div className="px-4 py-6 text-center text-sm text-gray-400">No items</div>
                ) : (
                  <div className="divide-y divide-gray-100">
                    {items.map((q) => (
                      <QuoteRow
                        key={q.id}
                        quote={q}
                        expanded={expandedId === q.id}
                        onToggle={() => setExpandedId(expandedId === q.id ? null : q.id)}
                        onStatusChange={updateOpsStatus}
                        onAssign={openAssignModal}
                        onRemoveAssignment={removeAssignment}
                        onUpdateDetails={updateOpsDetails}
                        onEdit={openEditModal}
                        onUpdateRunGroup={updateRunGroup}
                        allQuotes={quotes}
                      />
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* Calendar view */}
      {viewMode === 'calendar' && (
        <CalendarView
          data={calendarData}
          allQuotes={quotes}
          onStatusChange={updateOpsStatus}
          onAssign={openAssignModal}
          onRemoveAssignment={removeAssignment}
          onUpdateDetails={updateOpsDetails}
          onEdit={openEditModal}
          onUpdateRunGroup={updateRunGroup}
        />
      )}

      {/* Assign Crew Modal */}
      {assignModalQuoteId && (
        <div className="fixed inset-0 z-50 flex items-center justify-center">
          <div className="absolute inset-0 bg-black/50" onClick={() => setAssignModalQuoteId(null)} />
          <div className="relative bg-white rounded-xl shadow-xl w-full max-w-md mx-4 p-6">
            <h3 className="text-lg font-semibold text-gray-900 mb-4">Assign Crew Member</h3>

            <div className="space-y-4">
              {/* Role */}
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Role</label>
                <select
                  value={assignRole}
                  onChange={e => setAssignRole(e.target.value)}
                  className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm"
                >
                  <option value="driver">Driver</option>
                  <option value="crew">Crew</option>
                  <option value="loader">Loader</option>
                  <option value="tech">Tech</option>
                  <option value="manager">Manager</option>
                </select>
              </div>

              {/* Search */}
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Search People</label>
                <input
                  type="text"
                  value={peopleSearch}
                  onChange={e => {
                    setPeopleSearch(e.target.value);
                    if (e.target.value.length >= 2) searchPeople(e.target.value);
                    else setPeopleOptions([]);
                  }}
                  placeholder="Type a name..."
                  className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm"
                  autoFocus
                />
              </div>

              {/* Previously sent crew suggestions */}
              {crewHistory.length > 0 && peopleSearch.length < 2 && (
                <div>
                  <p className="text-xs font-medium text-gray-500 mb-1">Previously sent to this client/venue</p>
                  <div className="border border-purple-200 rounded-lg divide-y divide-purple-100 bg-purple-50/50">
                    {crewHistory.map(h => {
                      const currentQuote = quotes.find(q => q.id === assignModalQuoteId);
                      const alreadyAssigned = currentQuote?.assignments?.some(a => a.person_id === h.person_id);
                      return (
                        <button
                          key={h.person_id}
                          disabled={alreadyAssigned}
                          onClick={() => assignPerson(assignModalQuoteId!, h.person_id, assignRole)}
                          className={`w-full text-left px-3 py-2 text-sm flex items-center justify-between ${
                            alreadyAssigned ? 'opacity-40 cursor-not-allowed' : 'hover:bg-purple-100'
                          }`}
                        >
                          <div>
                            <span className="font-medium text-gray-900">{h.first_name} {h.last_name}</span>
                            <span className="ml-2 text-xs text-purple-600">{h.role}</span>
                            <span className="ml-1 text-xs text-gray-400">
                              ({h.job_count} job{h.job_count !== 1 ? 's' : ''})
                            </span>
                          </div>
                          <div className="flex gap-1 items-center">
                            {h.avg_rate > 0 && (
                              <span className="text-xs text-gray-500">avg &pound;{h.avg_rate}</span>
                            )}
                            {alreadyAssigned && (
                              <span className="text-xs bg-gray-100 text-gray-500 rounded px-1.5 py-0.5">Assigned</span>
                            )}
                          </div>
                        </button>
                      );
                    })}
                  </div>
                </div>
              )}

              {/* Results */}
              {peopleOptions.length > 0 && (
                <div className="max-h-48 overflow-y-auto border border-gray-200 rounded-lg divide-y divide-gray-100">
                  {peopleOptions.map(p => {
                    const currentQuote = quotes.find(q => q.id === assignModalQuoteId);
                    const alreadyAssigned = currentQuote?.assignments?.some(a => a.person_id === p.id);
                    return (
                      <button
                        key={p.id}
                        disabled={alreadyAssigned}
                        onClick={() => assignPerson(assignModalQuoteId!, p.id, assignRole)}
                        className={`w-full text-left px-3 py-2.5 text-sm flex items-center justify-between ${
                          alreadyAssigned ? 'opacity-40 cursor-not-allowed' : 'hover:bg-ooosh-50'
                        }`}
                      >
                        <div>
                          <span className="font-medium text-gray-900">{p.first_name} {p.last_name}</span>
                          {p.current_organisations?.length ? (
                            <span className="ml-2 text-xs text-gray-400">
                              {p.current_organisations.slice(0, 2).map(o => `${o.role} at ${o.organisation_name}`).join(', ')}
                            </span>
                          ) : p.skills?.length > 0 ? (
                            <span className="ml-2 text-xs text-gray-400">{p.skills.slice(0, 3).join(', ')}</span>
                          ) : null}
                        </div>
                        <div className="flex gap-1">
                          {p.is_insured_on_vehicles && (
                            <span className="text-xs bg-green-100 text-green-700 rounded px-1.5 py-0.5">Insured</span>
                          )}
                          {alreadyAssigned && (
                            <span className="text-xs bg-gray-100 text-gray-500 rounded px-1.5 py-0.5">Assigned</span>
                          )}
                        </div>
                      </button>
                    );
                  })}
                </div>
              )}

              {peopleSearch.length >= 2 && peopleOptions.length === 0 && (
                <p className="text-sm text-gray-400 text-center py-2">No people found</p>
              )}
            </div>

            <div className="mt-6 flex justify-end">
              <button
                onClick={() => setAssignModalQuoteId(null)}
                className="px-4 py-2 bg-gray-100 text-gray-700 rounded-lg text-sm hover:bg-gray-200 font-medium"
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Edit Quote Modal */}
      {editingQuote && (
        <EditQuoteModal
          quote={editingQuote}
          onSave={saveQuoteEdit}
          onClose={() => setEditingQuote(null)}
        />
      )}
    </div>
  );
}

// ── Quote Row Component ──────────────────────────────────────────────

function QuoteRow({
  quote: q,
  expanded,
  onToggle,
  onStatusChange,
  onAssign,
  onRemoveAssignment,
  onUpdateDetails,
  onEdit,
  onUpdateRunGroup,
  allQuotes,
}: {
  quote: OpsQuote;
  expanded: boolean;
  onToggle: () => void;
  onStatusChange: (id: string, status: string) => void;
  onAssign: (quoteId: string) => void;
  onRemoveAssignment: (quoteId: string, assignmentId: string) => void;
  onUpdateDetails: (quoteId: string, fields: Record<string, unknown>) => Promise<void>;
  onEdit: (quote: OpsQuote) => void;
  onUpdateRunGroup: (quoteId: string, runGroup: string | null, runOrder: number | null) => Promise<void>;
  allQuotes: OpsQuote[];
}) {
  const assignments = Array.isArray(q.assignments) ? q.assignments : [];
  const crewNames = assignments
    .map((a) => a.is_ooosh_crew ? 'Ooosh Crew' : `${a.first_name || ''} ${a.last_name || ''}`.trim())
    .filter(Boolean);

  // Compute run letter and colour index for display (runs match by date, not job)
  const qDate = normaliseDateKey(q.job_date);
  const runInfo = useMemo(() => {
    if (!q.run_group) return null;
    const RUN_LETTERS = ['A', 'B', 'C', 'D', 'E'];
    const uniqueGroups: string[] = [];
    for (const other of allQuotes) {
      if (normaliseDateKey(other.job_date) === qDate && other.run_group && !uniqueGroups.includes(other.run_group)) {
        uniqueGroups.push(other.run_group);
      }
    }
    const idx = uniqueGroups.indexOf(q.run_group);
    return { letter: RUN_LETTERS[idx] || String(idx + 1), colourIdx: idx % RUN_PILL_STYLES.length };
  }, [q.run_group, qDate, allQuotes]);

  return (
    <div>
      <div
        className={`px-4 py-3 flex items-center gap-3 hover:bg-gray-50 cursor-pointer transition-colors ${runInfo ? `border-l-4 ${RUN_PILL_STYLES[runInfo.colourIdx].border}` : ''}`}
        onClick={onToggle}
      >
        {/* Expand chevron */}
        <svg
          className={`w-4 h-4 text-gray-400 flex-shrink-0 transition-transform ${expanded ? 'rotate-90' : ''}`}
          fill="none" viewBox="0 0 24 24" stroke="currentColor"
        >
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
        </svg>

        {/* Job type badge */}
        <span className={`text-xs font-bold px-1.5 py-0.5 rounded ${JOB_TYPE_COLOURS[q.job_type] || 'bg-gray-100 text-gray-700'}`}>
          {JOB_TYPE_LABELS[q.job_type] || q.job_type}
        </span>

        {/* Date & time */}
        <div className="w-32 flex-shrink-0">
          <div className="text-sm font-medium text-gray-900">
            {q.job_date ? (
              q.is_multi_day && q.job_finish_date ? (
                <>{formatDate(q.job_date)} – {formatDate(q.job_finish_date)}</>
              ) : formatDate(q.job_date)
            ) : <span className="text-gray-400">No date</span>}
          </div>
          <div className="text-xs text-gray-500 flex items-center gap-1.5">
            {q.arrival_time && <span>{q.arrival_time}</span>}
            {q.is_multi_day && q.num_days && q.num_days > 1 && (
              <span className="text-purple-600 font-medium">{q.num_days}d</span>
            )}
          </div>
        </div>

        {/* Job / Venue name + badges */}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1.5">
            <span className="text-sm font-medium text-gray-900 truncate">
              {q.linked_venue_name || q.venue_name || 'No venue'}
            </span>
            {q.is_local && (
              <span className="text-xs px-1.5 py-0.5 rounded bg-teal-100 text-teal-700 font-medium flex-shrink-0">Local</span>
            )}
            {q.run_group && runInfo && (
              <span className={`text-xs px-1.5 py-0.5 rounded font-medium flex-shrink-0 ${RUN_PILL_STYLES[runInfo.colourIdx].pill}`}>
                Run {runInfo.letter}
              </span>
            )}
            {q.hh_job_number && (
              <span className="text-xs text-gray-400 flex-shrink-0">HH#{q.hh_job_number}</span>
            )}
          </div>
          <div className="text-xs text-gray-500 truncate">
            {q.client_name || q.job_name || ''}
          </div>
        </div>

        {/* Crew */}
        <div className="w-44 flex-shrink-0 hidden lg:block" onClick={(e) => e.stopPropagation()}>
          {crewNames.length > 0 ? (
            <div className="text-sm text-gray-700">
              <div className="truncate">{crewNames.join(', ')}</div>
              <div className="flex items-center gap-1.5">
                {(q.crew_count || 1) > 1 && (
                  <span className={`text-xs font-medium ${crewNames.length >= (q.crew_count || 1) ? 'text-green-600' : 'text-amber-600'}`}>
                    {crewNames.length}/{q.crew_count} assigned
                  </span>
                )}
                <button
                  onClick={() => onAssign(q.id)}
                  className="text-xs text-ooosh-600 hover:text-ooosh-700"
                  title="Assign more crew"
                >+</button>
              </div>
            </div>
          ) : (
            <button
              onClick={() => onAssign(q.id)}
              className={`text-xs font-medium ${(q.crew_count || 1) > 1 ? 'text-red-500 hover:text-red-700' : 'text-red-500 hover:text-red-700'}`}
            >
              + Assign crew{(q.crew_count || 1) > 1 ? ` (${q.crew_count} needed)` : ''}
            </button>
          )}
        </div>

        {/* Fee */}
        <div className="w-16 text-right flex-shrink-0 hidden md:block">
          <span className="text-sm font-medium text-gray-700">
            {q.client_charge_rounded ? `£${q.client_charge_rounded}` : '—'}
          </span>
        </div>

        {/* Status dropdown */}
        <div className="w-36 flex-shrink-0" onClick={(e) => e.stopPropagation()}>
          <StatusDropdown
            value={q.ops_status || 'todo'}
            onChange={(v) => onStatusChange(q.id, v)}
          />
        </div>
      </div>

      {/* Expanded detail */}
      {expanded && (
        <ExpandedDetail
          q={q}
          assignments={assignments}
          onAssign={onAssign}
          onRemoveAssignment={onRemoveAssignment}
          onUpdateDetails={onUpdateDetails}
          onEdit={onEdit}
          onUpdateRunGroup={onUpdateRunGroup}
          allQuotes={allQuotes}
        />
      )}
    </div>
  );
}

// ── Status Dropdown (colour-matched) ─────────────────────────────────

function StatusDropdown({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const [open, setOpen] = useState(false);
  const btnRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const [menuPos, setMenuPos] = useState({ top: 0, left: 0 });

  const openMenu = useCallback(() => {
    if (btnRef.current) {
      const rect = btnRef.current.getBoundingClientRect();
      const menuHeight = OPS_STATUSES.length * 30 + 8; // approx height
      const spaceBelow = window.innerHeight - rect.bottom;
      const top = spaceBelow < menuHeight ? rect.top - menuHeight : rect.bottom + 4;
      setMenuPos({ top, left: rect.right - 160 }); // 160 = w-40
    }
    setOpen(true);
  }, []);

  useEffect(() => {
    if (!open) return;
    function handleClickOutside(e: MouseEvent) {
      if (btnRef.current?.contains(e.target as Node)) return;
      if (menuRef.current?.contains(e.target as Node)) return;
      setOpen(false);
    }
    function handleScroll() { setOpen(false); }
    document.addEventListener('mousedown', handleClickOutside);
    window.addEventListener('scroll', handleScroll, true);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
      window.removeEventListener('scroll', handleScroll, true);
    };
  }, [open]);

  const config = OPS_STATUS_CONFIG[value] || OPS_STATUS_CONFIG.todo;

  return (
    <div>
      <button
        ref={btnRef}
        onClick={() => open ? setOpen(false) : openMenu()}
        className={`text-xs font-medium rounded px-2.5 py-1.5 w-full text-left flex items-center justify-between ${config.bgColour} ${config.colour}`}
      >
        <span>{config.label}</span>
        <svg className={`w-3.5 h-3.5 ml-1 transition-transform ${open ? 'rotate-180' : ''}`} fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
        </svg>
      </button>
      {open && createPortal(
        <div
          ref={menuRef}
          style={{ position: 'fixed', top: menuPos.top, left: menuPos.left, zIndex: 9999 }}
          className="w-40 bg-white rounded-lg shadow-lg border border-gray-200 py-1"
        >
          {OPS_STATUSES.map((s) => {
            const sc = OPS_STATUS_CONFIG[s];
            return (
              <button
                key={s}
                onClick={() => { onChange(s); setOpen(false); }}
                className={`w-full text-left px-3 py-1.5 text-xs font-medium flex items-center gap-2 hover:opacity-80 ${
                  s === value ? 'ring-1 ring-inset ring-gray-300' : ''
                }`}
              >
                <span className={`w-2 h-2 rounded-full ${sc.bgColour} border ${sc.colour.replace('text-', 'border-')}`} />
                <span className={sc.colour}>{sc.label}</span>
              </button>
            );
          })}
        </div>,
        document.body
      )}
    </div>
  );
}

// ── Expanded Detail Component ────────────────────────────────────────

const ARRANGEMENT_STATUSES = ['not_needed', 'todo', 'booked', 'paid'] as const;

const CLIENT_INTRO_STATUSES = ['not_needed', 'todo', 'working_on_it', 'done'] as const;

function nextStatus(current: string, list: readonly string[]): string {
  const idx = list.indexOf(current);
  if (idx === -1) return list[1] || list[0]; // default to second item (usually 'todo')
  return list[(idx + 1) % list.length];
}

function ExpandedDetail({
  q,
  assignments,
  onAssign,
  onRemoveAssignment,
  onUpdateDetails,
  onEdit,
  onUpdateRunGroup,
  allQuotes,
}: {
  q: OpsQuote;
  assignments: Assignment[];
  onAssign: (quoteId: string) => void;
  onRemoveAssignment: (quoteId: string, assignmentId: string) => void;
  onUpdateDetails: (quoteId: string, fields: Record<string, unknown>) => Promise<void>;
  onEdit: (quote: OpsQuote) => void;
  onUpdateRunGroup: (quoteId: string, runGroup: string | null, runOrder: number | null) => Promise<void>;
  allQuotes: OpsQuote[];
}) {
  const [editingField, setEditingField] = useState<string | null>(null);
  const [fieldValues, setFieldValues] = useState({
    key_points: q.key_points || '',
    internal_notes: q.internal_notes || '',
    freelancer_notes: q.freelancer_notes || '',
  });

  async function saveField(field: string) {
    const value = fieldValues[field as keyof typeof fieldValues] || null;
    await onUpdateDetails(q.id, { [field]: value });
    setEditingField(null);
  }

  function handleArrangementClick(field: string, currentStatus: string) {
    const newStatus = nextStatus(currentStatus, ARRANGEMENT_STATUSES);
    onUpdateDetails(q.id, { [field]: newStatus });
  }

  function handleClientIntroClick() {
    const newStatus = nextStatus(q.client_introduction || 'not_needed', CLIENT_INTRO_STATUSES);
    onUpdateDetails(q.id, { client_introduction: newStatus });
  }

  // Run grouping — find existing run groups on the same date (runs can span jobs)
  const qDate = normaliseDateKey(q.job_date);
  const jobRunGroups = useMemo(() => {
    const groups = new Map<string, { letter: string; count: number; colourIdx: number }>();
    const RUN_LETTERS = ['A', 'B', 'C', 'D', 'E'];
    let letterIdx = 0;
    for (const other of allQuotes) {
      if (normaliseDateKey(other.job_date) === qDate && other.run_group && !groups.has(other.run_group)) {
        groups.set(other.run_group, { letter: RUN_LETTERS[letterIdx] || String(letterIdx + 1), count: 0, colourIdx: letterIdx % RUN_PILL_STYLES.length });
        letterIdx++;
      }
    }
    for (const other of allQuotes) {
      if (normaliseDateKey(other.job_date) === qDate && other.run_group && groups.has(other.run_group)) {
        groups.get(other.run_group)!.count++;
      }
    }
    return Array.from(groups.entries()).map(([id, info]) => ({ id, ...info }));
  }, [qDate, allQuotes]);

  const currentRunInfo = useMemo(() => {
    if (!q.run_group) return null;
    const group = jobRunGroups.find((g) => g.id === q.run_group);
    if (!group) return null;
    return { letter: group.letter, colourIdx: group.colourIdx };
  }, [q.run_group, jobRunGroups]);

  async function setRunGroup(groupId: string | null) {
    const order = groupId ? (q.run_order || 1) : null;
    await onUpdateRunGroup(q.id, groupId, order);
  }

  async function createNewRunGroup() {
    const newGroupId = crypto.randomUUID();
    await onUpdateRunGroup(q.id, newGroupId, 1);
  }

  return (
    <div className="px-4 pb-4 pt-1 bg-gray-50 border-t border-gray-100">
      {/* Action bar */}
      <div className="flex items-center justify-end gap-2 mb-3">
        <button
          onClick={() => onEdit(q)}
          className="text-xs px-3 py-1.5 rounded-lg border border-gray-300 text-gray-700 hover:bg-white hover:border-gray-400 font-medium transition-colors"
        >
          Edit Quote
        </button>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-4 text-sm">
        {/* Column 1: Details */}
        <div className="space-y-2">
          <h4 className="font-semibold text-gray-700 text-xs uppercase tracking-wider">Details</h4>
          {q.job_id && (
            <div>
              <Link to={`/jobs/${q.job_id}`} className="text-ooosh-600 hover:underline text-sm">
                View Job Detail
              </Link>
            </div>
          )}
          {q.venue_address && (
            <div className="text-gray-600">{q.venue_address}{q.venue_city ? `, ${q.venue_city}` : ''}</div>
          )}
          {q.distance_miles != null && q.distance_miles > 0 && (
            <div className="text-gray-500">{q.distance_miles} miles</div>
          )}
          {q.what_is_it && (
            <div className="text-gray-500">What: {q.what_is_it}</div>
          )}
          {q.work_type && (
            <div className="text-gray-500">
              Work: {q.work_type === 'other' ? q.work_type_other || 'Other' : q.work_type}
            </div>
          )}
          {q.work_description && (
            <div className="text-gray-500">{q.work_description}</div>
          )}
          {q.is_multi_day && q.job_finish_date && (
            <div className="text-gray-600">
              <span className="text-gray-400">Dates:</span> {formatDate(q.job_date)} – {formatDate(q.job_finish_date)}
              {q.num_days && q.num_days > 1 && <span className="ml-1 text-purple-600 font-medium">({q.num_days} days)</span>}
            </div>
          )}
          {(q.crew_count || 1) > 1 && (
            <div className="text-gray-600">
              <span className="text-gray-400">Crew needed:</span>{' '}
              <span className={`font-medium ${q.assignments.length >= (q.crew_count || 1) ? 'text-green-600' : 'text-amber-600'}`}>
                {q.assignments.length}/{q.crew_count} assigned
              </span>
            </div>
          )}

          {/* Run grouping */}
          {q.job_id && (
            <div className="border-t border-gray-200 pt-2 mt-2">
              <div className="flex items-center gap-2 mb-1">
                <span className="text-xs font-medium text-gray-700">Run group</span>
                {currentRunInfo && (
                  <span className={`text-xs px-1.5 py-0.5 rounded font-bold ${RUN_PILL_STYLES[currentRunInfo.colourIdx].pill}`}>
                    Run {currentRunInfo.letter}
                  </span>
                )}
              </div>
              <div className="flex flex-wrap gap-1.5">
                <button
                  onClick={() => setRunGroup(null)}
                  className={`text-xs px-2 py-0.5 rounded border ${
                    !q.run_group ? 'bg-gray-200 border-gray-300 font-medium' : 'bg-white border-gray-200 hover:bg-gray-50'
                  }`}
                >
                  None
                </button>
                {jobRunGroups.map((g) => {
                  const style = RUN_PILL_STYLES[g.colourIdx];
                  const isSelected = q.run_group === g.id;
                  return (
                    <button
                      key={g.id}
                      onClick={() => setRunGroup(g.id)}
                      className={`text-xs px-2 py-0.5 rounded border font-medium ${
                        isSelected
                          ? `${style.pill} border-current`
                          : `bg-white border-gray-200 hover:${style.pill}`
                      }`}
                    >
                      Run {g.letter} ({g.count})
                    </button>
                  );
                })}
                {!q.run_group && (
                  <button
                    onClick={createNewRunGroup}
                    className="text-xs px-2 py-0.5 rounded border border-dashed border-gray-300 text-gray-500 hover:bg-gray-50"
                  >
                    + New run
                  </button>
                )}
              </div>
            </div>
          )}
        </div>

        {/* Column 2: Arranging (inline-editable) */}
        <div className="space-y-2">
          <h4 className="font-semibold text-gray-700 text-xs uppercase tracking-wider">Arranging</h4>

          {/* Client introduction — status pill */}
          <ClickableStatusPill
            label="Client intro"
            status={q.client_introduction || 'not_needed'}
            onClick={handleClientIntroClick}
            statusList={CLIENT_INTRO_STATUSES}
          />

          {/* Key points */}
          <InlineEditField
            label="Key points"
            value={fieldValues.key_points}
            isEditing={editingField === 'key_points'}
            onStartEdit={() => setEditingField('key_points')}
            onChange={(v) => setFieldValues((prev) => ({ ...prev, key_points: v }))}
            onSave={() => saveField('key_points')}
            onCancel={() => { setEditingField(null); setFieldValues((prev) => ({ ...prev, key_points: q.key_points || '' })); }}
          />

          {/* Arrangement status pills — clickable to cycle */}
          <div className="flex flex-wrap gap-2 pt-1">
            <ClickableStatusPill
              label="Tolls"
              status={q.tolls_status}
              onClick={() => handleArrangementClick('tolls_status', q.tolls_status)}
              statusList={ARRANGEMENT_STATUSES}
            />
            <ClickableStatusPill
              label="Accom"
              status={q.accommodation_status}
              onClick={() => handleArrangementClick('accommodation_status', q.accommodation_status)}
              statusList={ARRANGEMENT_STATUSES}
            />
            <ClickableStatusPill
              label="Flights"
              status={q.flight_status}
              onClick={() => handleArrangementClick('flight_status', q.flight_status)}
              statusList={ARRANGEMENT_STATUSES}
            />
          </div>

          {/* Freelancer notes */}
          <InlineEditField
            label="Freelancer notes"
            value={fieldValues.freelancer_notes}
            isEditing={editingField === 'freelancer_notes'}
            onStartEdit={() => setEditingField('freelancer_notes')}
            onChange={(v) => setFieldValues((prev) => ({ ...prev, freelancer_notes: v }))}
            onSave={() => saveField('freelancer_notes')}
            onCancel={() => { setEditingField(null); setFieldValues((prev) => ({ ...prev, freelancer_notes: q.freelancer_notes || '' })); }}
            multiline
          />

          {/* Internal notes */}
          <InlineEditField
            label="Internal notes"
            value={fieldValues.internal_notes}
            isEditing={editingField === 'internal_notes'}
            onStartEdit={() => setEditingField('internal_notes')}
            onChange={(v) => setFieldValues((prev) => ({ ...prev, internal_notes: v }))}
            onSave={() => saveField('internal_notes')}
            onCancel={() => { setEditingField(null); setFieldValues((prev) => ({ ...prev, internal_notes: q.internal_notes || '' })); }}
            multiline
          />
        </div>

        {/* Column 3: Crew & Financials */}
        <div className="space-y-2">
          <div className="flex items-center gap-2">
            <h4 className="font-semibold text-gray-700 text-xs uppercase tracking-wider">Crew & Costs</h4>
            <button
              onClick={() => onAssign(q.id)}
              className="text-xs text-ooosh-600 hover:text-ooosh-700 font-medium"
            >
              + Assign
            </button>
          </div>
          {assignments.length === 0 ? (
            <div className="text-red-500 text-xs italic">No crew assigned</div>
          ) : (
            <div className="flex flex-wrap gap-1.5">
              {assignments.map((a) => (
                <div key={a.id} className="inline-flex items-center gap-1.5 bg-blue-50 border border-blue-200 rounded-full px-2.5 py-1 text-xs">
                  <span className="font-medium text-blue-800">
                    {a.is_ooosh_crew ? 'Ooosh Crew' : `${a.first_name} ${a.last_name}`}
                  </span>
                  <span className="text-blue-500 capitalize">({a.role})</span>
                  {a.agreed_rate != null && (
                    <span className="text-blue-400">&pound;{Number(a.agreed_rate).toFixed(0)}</span>
                  )}
                  {a.invoice_received && (
                    <span className="text-green-600" title={`Invoice: £${a.invoice_amount}`}>INV</span>
                  )}
                  <button
                    onClick={() => onRemoveAssignment(q.id, a.id)}
                    className="ml-0.5 text-blue-400 hover:text-red-500"
                    title="Remove"
                  >&times;</button>
                </div>
              ))}
            </div>
          )}
          {/* Total crew cost (sum of agreed rates) */}
          {assignments.length > 0 && assignments.some(a => a.agreed_rate != null) && (
            <div className="text-xs text-gray-500 mt-1">
              Total crew cost: <span className="font-medium text-gray-700">
                &pound;{assignments.reduce((sum, a) => sum + (Number(a.agreed_rate) || 0), 0).toFixed(0)}
              </span>
            </div>
          )}
          <div className="border-t border-gray-200 pt-1 mt-1">
            <div className="flex justify-between text-xs">
              <span className="text-gray-500">Client charge</span>
              <span className="font-medium">{q.client_charge_rounded ? `£${q.client_charge_rounded}` : '—'}</span>
            </div>
            <div className="flex justify-between text-xs">
              <span className="text-gray-500">Freelancer cost</span>
              <span className="font-medium">{q.freelancer_fee_rounded ? `£${q.freelancer_fee_rounded}` : '—'}</span>
            </div>
            {(q.expenses_included != null && q.expenses_included > 0) && (
              <div className="flex justify-between text-xs">
                <span className="text-gray-500">Expenses (in quote)</span>
                <span className="font-medium text-gray-600">&pound;{Number(q.expenses_included).toFixed(2)}</span>
              </div>
            )}
            {(q.expenses_not_included != null && q.expenses_not_included > 0) && (
              <div className="flex justify-between text-xs">
                <span className="text-gray-500">Expenses (freelancer claims)</span>
                <span className="font-medium text-amber-600">&pound;{Number(q.expenses_not_included).toFixed(2)}</span>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Completion details (when completed) */}
      {q.ops_status === 'completed' && q.completed_at && (
        <div className="mt-4 pt-3 border-t border-gray-200">
          <h4 className="font-semibold text-gray-700 text-xs uppercase tracking-wider mb-2">Completion Details</h4>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3 text-xs">
            <div className="space-y-1.5">
              <div className="flex items-center gap-2">
                <span className="text-gray-500">Completed:</span>
                <span className="font-medium text-gray-700">
                  {new Date(q.completed_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}
                  {' at '}
                  {new Date(q.completed_at).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}
                </span>
              </div>
              {q.completed_by && (
                <div className="flex items-center gap-2">
                  <span className="text-gray-500">By:</span>
                  <span className="font-medium text-gray-700">{q.completed_by}</span>
                </div>
              )}
              {q.customer_present !== null && (
                <div className="flex items-center gap-2">
                  <span className="text-gray-500">Customer present:</span>
                  <span className={`font-medium ${q.customer_present ? 'text-green-600' : 'text-amber-600'}`}>
                    {q.customer_present ? 'Yes' : 'No'}
                  </span>
                </div>
              )}
              {q.completion_notes && (
                <div>
                  <span className="text-gray-500">Notes:</span>
                  <p className="mt-0.5 text-gray-700 bg-white rounded p-2 border border-gray-200">{q.completion_notes}</p>
                </div>
              )}
            </div>
            <div className="space-y-2">
              {/* Signature */}
              {q.completion_signature && (
                <div>
                  <span className="text-gray-500">Signature:</span>
                  <div className="mt-1 bg-white rounded border border-gray-200 p-2 inline-block">
                    <img src={q.completion_signature} alt="Signature" className="h-16 max-w-[200px] object-contain" />
                  </div>
                </div>
              )}
              {/* Photos */}
              {q.completion_photos && q.completion_photos.length > 0 && (
                <div>
                  <span className="text-gray-500">Photos ({q.completion_photos.length}):</span>
                  <div className="mt-1 flex flex-wrap gap-2">
                    {q.completion_photos.map((photo, idx) => (
                      <a key={idx} href={photo} target="_blank" rel="noopener noreferrer" className="block">
                        <img
                          src={photo}
                          alt={`Completion photo ${idx + 1}`}
                          className="h-20 w-20 object-cover rounded border border-gray-200 hover:border-ooosh-500 transition-colors"
                        />
                      </a>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Inline Edit Field ───────────────────────────────────────────────

function InlineEditField({
  label,
  value,
  isEditing,
  onStartEdit,
  onChange,
  onSave,
  onCancel,
  multiline,
}: {
  label: string;
  value: string;
  isEditing: boolean;
  onStartEdit: () => void;
  onChange: (v: string) => void;
  onSave: () => void;
  onCancel: () => void;
  multiline?: boolean;
}) {
  if (isEditing) {
    const inputProps = {
      value,
      onChange: (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => onChange(e.target.value),
      onKeyDown: (e: React.KeyboardEvent) => {
        if (e.key === 'Enter' && !multiline) onSave();
        if (e.key === 'Escape') onCancel();
      },
      onBlur: onSave,
      className: 'w-full border border-ooosh-300 rounded px-2 py-1 text-xs focus:ring-1 focus:ring-ooosh-500 focus:border-ooosh-500',
      autoFocus: true,
    };

    return (
      <div>
        <span className="text-xs font-medium text-gray-500">{label}</span>
        {multiline ? (
          <textarea {...inputProps} rows={2} />
        ) : (
          <input type="text" {...inputProps} />
        )}
      </div>
    );
  }

  return (
    <div
      onClick={onStartEdit}
      className="group cursor-pointer hover:bg-white hover:rounded px-1 py-0.5 -mx-1 transition-colors"
      title="Click to edit"
    >
      <span className="text-xs font-medium text-gray-500">{label}: </span>
      {value ? (
        <span className="text-xs text-gray-700">{value}</span>
      ) : (
        <span className="text-xs text-gray-300 italic group-hover:text-gray-400">Click to add...</span>
      )}
    </div>
  );
}

// ── Clickable Status Pill ───────────────────────────────────────────

function ClickableStatusPill({
  label,
  status,
  onClick,
  statusList,
}: {
  label: string;
  status: string;
  onClick: () => void;
  statusList: readonly string[];
}) {
  const colours: Record<string, string> = {
    not_needed: 'bg-gray-100 text-gray-400',
    todo: 'bg-amber-100 text-amber-700',
    booked: 'bg-blue-100 text-blue-700',
    paid: 'bg-green-100 text-green-700',
    working_on_it: 'bg-orange-100 text-orange-700',
    done: 'bg-green-100 text-green-700',
  };

  const statusLabels: Record<string, string> = {
    not_needed: 'n/a',
    todo: 'to do',
    booked: 'booked',
    paid: 'paid',
    working_on_it: 'working on it',
    done: 'done',
  };

  const cycleLabels = statusList.map((s) => statusLabels[s] || s).join(' → ');

  return (
    <button
      onClick={onClick}
      className={`text-xs px-2 py-0.5 rounded-full cursor-pointer hover:opacity-80 transition-opacity ${colours[status] || 'bg-gray-100 text-gray-600'}`}
      title={`Click to cycle: ${cycleLabels}`}
    >
      {label}: {statusLabels[status] || status}
    </button>
  );
}

// ── Edit Quote Modal ────────────────────────────────────────────────

function EditQuoteModal({
  quote,
  onSave,
  onClose,
}: {
  quote: OpsQuote;
  onSave: (id: string, fields: Record<string, unknown>) => Promise<void>;
  onClose: () => void;
}) {
  const isLocal = quote.is_local || quote.calculation_mode === 'fixed';
  const parseDateField = (d: string | Date | null) => {
    if (!d) return '';
    if (d instanceof Date) return d.toISOString().split('T')[0];
    return String(d).includes('T') ? String(d).split('T')[0] : String(d);
  };
  const [form, setForm] = useState({
    job_type: quote.job_type,
    venue_name: quote.linked_venue_name || quote.venue_name || '',
    job_date: parseDateField(quote.job_date),
    job_finish_date: parseDateField(quote.job_finish_date),
    is_multi_day: quote.is_multi_day || false,
    num_days: quote.num_days || 1,
    arrival_time: quote.arrival_time || '',
    what_is_it: quote.what_is_it || '',
    work_type: quote.work_type || '',
    work_description: quote.work_description || '',
    crew_count: quote.crew_count || 1,
    internal_notes: quote.internal_notes || '',
    freelancer_notes: quote.freelancer_notes || '',
    client_charge_rounded: quote.client_charge_rounded || 0,
    freelancer_fee_rounded: quote.freelancer_fee_rounded || 0,
  });
  const [saving, setSaving] = useState(false);

  // Venue search
  const [venueSearch, setVenueSearch] = useState('');
  const [venueOptions, setVenueOptions] = useState<{ id: string; name: string; address?: string; city?: string }[]>([]);
  const [selectedVenueId, setSelectedVenueId] = useState<string | null>(quote.venue_id || null);

  async function searchVenues(search: string) {
    try {
      const data = await api.get<{ data: { id: string; name: string; address?: string; city?: string }[] }>(
        `/venues?search=${encodeURIComponent(search)}&limit=8`
      );
      setVenueOptions(data.data);
    } catch {
      // ignore
    }
  }

  async function handleSave() {
    setSaving(true);
    try {
      await onSave(quote.id, {
        job_type: form.job_type,
        venue_name: form.venue_name,
        venue_id: selectedVenueId,
        job_date: form.job_date || null,
        job_finish_date: form.job_finish_date || null,
        is_multi_day: form.is_multi_day,
        num_days: form.num_days,
        arrival_time: form.arrival_time || null,
        what_is_it: form.what_is_it || null,
        work_type: form.work_type || null,
        work_description: form.work_description || null,
        crew_count: form.crew_count > 1 ? form.crew_count : 1,
        internal_notes: form.internal_notes || null,
        freelancer_notes: form.freelancer_notes || null,
        client_charge_rounded: form.client_charge_rounded,
        freelancer_fee_rounded: form.freelancer_fee_rounded,
      });
    } finally {
      setSaving(false);
    }
  }

  useEffect(() => {
    function handleEsc(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    document.addEventListener('keydown', handleEsc);
    return () => document.removeEventListener('keydown', handleEsc);
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/50" onClick={onClose} />
      <div className="relative bg-white rounded-xl shadow-xl w-full max-w-lg mx-4 p-6 max-h-[90vh] overflow-y-auto">
        <h3 className="text-lg font-semibold text-gray-900 mb-4">
          Edit {isLocal ? 'Local ' : ''}{form.job_type === 'delivery' ? 'Delivery' : form.job_type === 'collection' ? 'Collection' : 'Crewed Job'}
        </h3>

        <div className="space-y-4">
          {/* Type */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Type</label>
            <select
              value={form.job_type}
              onChange={(e) => setForm((p) => ({ ...p, job_type: e.target.value as OpsQuote['job_type'] }))}
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm"
            >
              <option value="delivery">Delivery</option>
              <option value="collection">Collection</option>
              <option value="crewed">Crewed</option>
            </select>
          </div>

          {/* Venue */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Venue</label>
            <input
              type="text"
              value={venueSearch || form.venue_name}
              onChange={(e) => {
                setVenueSearch(e.target.value);
                setForm((p) => ({ ...p, venue_name: e.target.value }));
                setSelectedVenueId(null);
                if (e.target.value.length >= 2) searchVenues(e.target.value);
                else setVenueOptions([]);
              }}
              onFocus={() => { if (form.venue_name.length >= 2) searchVenues(form.venue_name); }}
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm"
            />
            {venueOptions.length > 0 && !selectedVenueId && (
              <div className="mt-1 border border-gray-200 rounded-lg max-h-32 overflow-y-auto divide-y divide-gray-100">
                {venueOptions.map((v) => (
                  <button
                    key={v.id}
                    onClick={() => {
                      setForm((p) => ({ ...p, venue_name: v.name }));
                      setSelectedVenueId(v.id);
                      setVenueSearch('');
                      setVenueOptions([]);
                    }}
                    className="w-full text-left px-3 py-2 text-sm hover:bg-ooosh-50"
                  >
                    <span className="font-medium">{v.name}</span>
                    {v.city && <span className="text-xs text-gray-400 ml-1">({v.city})</span>}
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* Date & Time row */}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">{form.is_multi_day ? 'Start Date' : 'Date'}</label>
              <input
                type="date"
                value={form.job_date}
                onChange={(e) => setForm((p) => ({ ...p, job_date: e.target.value }))}
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Arrival Time</label>
              <input
                type="time"
                value={form.arrival_time}
                onChange={(e) => setForm((p) => ({ ...p, arrival_time: e.target.value }))}
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm"
              />
            </div>
          </div>

          {/* Multi-day toggle + finish date */}
          <div className="flex items-center gap-3">
            <label className="flex items-center gap-2 text-sm text-gray-700">
              <input
                type="checkbox"
                checked={form.is_multi_day}
                onChange={(e) => setForm((p) => ({ ...p, is_multi_day: e.target.checked, num_days: e.target.checked ? Math.max(p.num_days, 2) : 1 }))}
                className="w-4 h-4 text-ooosh-600 rounded"
              />
              Multi-day
            </label>
            {form.is_multi_day && (
              <>
                <div>
                  <input
                    type="date"
                    value={form.job_finish_date}
                    onChange={(e) => {
                      const end = e.target.value;
                      const days = form.job_date && end
                        ? Math.max(1, Math.ceil((new Date(end + 'T00:00:00').getTime() - new Date(form.job_date + 'T00:00:00').getTime()) / 86400000) + 1)
                        : form.num_days;
                      setForm((p) => ({ ...p, job_finish_date: end, num_days: days }));
                    }}
                    className="border border-gray-300 rounded-lg px-3 py-1.5 text-sm"
                  />
                </div>
                <span className="text-xs text-purple-600 font-medium">{form.num_days} days</span>
              </>
            )}
          </div>

          {/* Crewed-specific fields */}
          {form.job_type === 'crewed' && (
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Work Type</label>
                <select
                  value={form.work_type}
                  onChange={(e) => setForm((p) => ({ ...p, work_type: e.target.value }))}
                  className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm"
                >
                  <option value="">—</option>
                  <option value="backline_tech">Backline Tech</option>
                  <option value="general_assist">General Assist</option>
                  <option value="engineer_foh">Engineer - FOH</option>
                  <option value="engineer_mons">Engineer - mons</option>
                  <option value="driving_only">Driving Only</option>
                  <option value="other">Other</option>
                </select>
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Crew Needed</label>
                <input
                  type="number"
                  min={1}
                  max={20}
                  value={form.crew_count}
                  onChange={(e) => setForm((p) => ({ ...p, crew_count: Math.max(1, parseInt(e.target.value) || 1) }))}
                  className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm"
                />
              </div>
              {form.work_type && (
                <div className="col-span-2">
                  <label className="block text-sm font-medium text-gray-700 mb-1">Work Description</label>
                  <textarea
                    value={form.work_description}
                    onChange={(e) => setForm((p) => ({ ...p, work_description: e.target.value }))}
                    rows={2}
                    className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm"
                  />
                </div>
              )}
            </div>
          )}

          {/* What is it (D&C only) */}
          {form.job_type !== 'crewed' && (
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">What is it</label>
              <select
                value={form.what_is_it}
                onChange={(e) => setForm((p) => ({ ...p, what_is_it: e.target.value }))}
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm"
              >
                <option value="">—</option>
                <option value="vehicle">Vehicle</option>
                <option value="equipment">Equipment</option>
                <option value="people">People</option>
              </select>
            </div>
          )}

          {/* Fees — editable for all quotes (override calculator values or set local fees) */}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Client Charge</label>
              <input
                type="number"
                min={0}
                step={5}
                value={form.client_charge_rounded}
                onChange={(e) => setForm((p) => ({ ...p, client_charge_rounded: parseFloat(e.target.value) || 0 }))}
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Freelancer Fee</label>
              <input
                type="number"
                min={0}
                step={5}
                value={form.freelancer_fee_rounded}
                onChange={(e) => setForm((p) => ({ ...p, freelancer_fee_rounded: parseFloat(e.target.value) || 0 }))}
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm"
              />
            </div>
          </div>

          {/* Notes */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Internal Notes</label>
            <textarea
              value={form.internal_notes}
              onChange={(e) => setForm((p) => ({ ...p, internal_notes: e.target.value }))}
              rows={2}
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Freelancer Notes</label>
            <textarea
              value={form.freelancer_notes}
              onChange={(e) => setForm((p) => ({ ...p, freelancer_notes: e.target.value }))}
              rows={2}
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm"
            />
          </div>

          {!isLocal && (
            <div className="bg-blue-50 border border-blue-200 rounded-lg p-3 text-xs text-blue-700">
              Fee overrides will replace the calculator values. To fully recalculate, use the transport calculator from the Job Detail page.
            </div>
          )}
        </div>

        <div className="mt-6 flex justify-end gap-2">
          <button
            onClick={onClose}
            className="px-4 py-2 bg-gray-100 text-gray-700 rounded-lg text-sm hover:bg-gray-200 font-medium"
          >
            Cancel
          </button>
          <button
            onClick={handleSave}
            disabled={saving}
            className="px-4 py-2 bg-ooosh-600 text-white rounded-lg text-sm hover:bg-ooosh-700 font-medium disabled:opacity-50"
          >
            {saving ? 'Saving...' : 'Save Changes'}
          </button>
        </div>
      </div>
    </div>
  );
}


// ── Calendar View ────────────────────────────────────────────────────

function CalendarView({
  data,
  allQuotes,
  onStatusChange,
  onAssign,
  onRemoveAssignment,
  onUpdateDetails,
  onEdit,
  onUpdateRunGroup,
}: {
  data: Record<string, OpsQuote[]>;
  allQuotes: OpsQuote[];
  onStatusChange: (id: string, status: string) => void;
  onAssign: (quoteId: string) => void;
  onRemoveAssignment: (quoteId: string, assignmentId: string) => void;
  onUpdateDetails: (quoteId: string, fields: Record<string, unknown>) => Promise<void>;
  onEdit: (quote: OpsQuote) => void;
  onUpdateRunGroup: (quoteId: string, runGroup: string | null, runOrder: number | null) => Promise<void>;
}) {
  type CalViewMode = 'month' | 'week' | 'day';
  const [calView, setCalView] = useState<CalViewMode>('month');
  const [currentDate, setCurrentDate] = useState(() => new Date());
  const [selectedQuote, setSelectedQuote] = useState<OpsQuote | null>(null);

  const todayKey = new Date().toISOString().split('T')[0];

  function makeDateKey(d: Date): string {
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }

  // Navigation
  function navigate(dir: -1 | 1) {
    setCurrentDate(prev => {
      const d = new Date(prev);
      if (calView === 'month') d.setMonth(d.getMonth() + dir);
      else if (calView === 'week') d.setDate(d.getDate() + dir * 7);
      else d.setDate(d.getDate() + dir);
      return d;
    });
  }

  function goToday() { setCurrentDate(new Date()); }

  // Compute visible days
  const visibleDays: Date[] = useMemo(() => {
    const result: Date[] = [];
    if (calView === 'month') {
      const first = new Date(currentDate.getFullYear(), currentDate.getMonth(), 1);
      const dow = first.getDay();
      const startOffset = dow === 0 ? 6 : dow - 1;
      const startDate = new Date(first);
      startDate.setDate(startDate.getDate() - startOffset);
      const daysInMonth = new Date(currentDate.getFullYear(), currentDate.getMonth() + 1, 0).getDate();
      const totalCells = Math.ceil((startOffset + daysInMonth) / 7) * 7;
      for (let i = 0; i < totalCells; i++) {
        const d = new Date(startDate);
        d.setDate(d.getDate() + i);
        result.push(d);
      }
    } else if (calView === 'week') {
      const dow = currentDate.getDay();
      const mondayOffset = dow === 0 ? -6 : 1 - dow;
      const monday = new Date(currentDate);
      monday.setDate(monday.getDate() + mondayOffset);
      for (let i = 0; i < 7; i++) {
        const d = new Date(monday);
        d.setDate(d.getDate() + i);
        result.push(d);
      }
    } else {
      result.push(new Date(currentDate));
    }
    return result;
  }, [currentDate, calView]);

  // Heading
  const heading = useMemo(() => {
    if (calView === 'month') return currentDate.toLocaleDateString('en-GB', { month: 'long', year: 'numeric' });
    if (calView === 'week') {
      const first = visibleDays[0];
      const last = visibleDays[visibleDays.length - 1];
      return `${first.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })} – ${last.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}`;
    }
    return currentDate.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
  }, [currentDate, calView, visibleDays]);

  // Quote detail panel
  // Slide panel with full editable ExpandedDetail (same as table view)
  function QuoteSlidePanel({ q, onClose }: { q: OpsQuote; onClose: () => void }) {
    const assignments = Array.isArray(q.assignments) ? q.assignments : [];
    return (
      <div className="fixed inset-0 z-50 flex justify-end">
        <div className="absolute inset-0 bg-black/30" onClick={onClose} />
        <div className="relative w-full max-w-2xl bg-white shadow-xl overflow-y-auto">
          {/* Header with status, type, venue */}
          <div className="p-4 border-b border-gray-200 flex items-center justify-between sticky top-0 bg-white z-10">
            <div className="flex items-center gap-3">
              <span className={`text-xs font-bold px-1.5 py-0.5 rounded ${JOB_TYPE_COLOURS[q.job_type] || 'bg-gray-100 text-gray-700'}`}>
                {JOB_TYPE_LABELS[q.job_type] || q.job_type}
              </span>
              <span className="font-semibold text-gray-900">{q.linked_venue_name || q.venue_name || 'TBC'}</span>
              {q.job_date && <span className="text-sm text-gray-500">{formatDate(q.job_date)}</span>}
              {q.arrival_time && <span className="text-sm text-gray-500">{q.arrival_time}</span>}
            </div>
            <div className="flex items-center gap-2">
              <div className="w-28">
                <StatusDropdown
                  value={q.ops_status || 'todo'}
                  onChange={(v) => onStatusChange(q.id, v)}
                />
              </div>
              <button onClick={onClose} className="p-1 hover:bg-gray-100 rounded">
                <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
              </button>
            </div>
          </div>
          {/* Full editable detail */}
          <ExpandedDetail
            q={q}
            assignments={assignments}
            onAssign={onAssign}
            onRemoveAssignment={onRemoveAssignment}
            onUpdateDetails={onUpdateDetails}
            onEdit={onEdit}
            onUpdateRunGroup={onUpdateRunGroup}
            allQuotes={allQuotes}
          />
        </div>
      </div>
    );
  }

  // Render a single item pill (shared between month/week/day)
  function ItemPill({ q }: { q: OpsQuote }) {
    return (
      <div
        key={q.id}
        onClick={(e) => { e.stopPropagation(); setSelectedQuote(q); }}
        className={`text-[10px] leading-tight px-1 py-0.5 rounded truncate cursor-pointer hover:opacity-80 transition-opacity ${
          JOB_TYPE_COLOURS[q.job_type] || 'bg-gray-100 text-gray-700'
        }`}
        title={`${JOB_TYPE_LABELS[q.job_type]} ${q.linked_venue_name || q.venue_name || ''} ${q.arrival_time || ''}`}
      >
        {q.arrival_time && <span className="font-semibold">{q.arrival_time} </span>}
        {JOB_TYPE_LABELS[q.job_type]} {q.linked_venue_name || q.venue_name || '?'}
      </div>
    );
  }

  return (
    <div className="bg-white rounded-lg shadow-sm border border-gray-200 overflow-hidden">
      {/* Header: nav + view mode */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-gray-200">
        <div className="flex items-center gap-2">
          <button onClick={() => navigate(-1)} className="p-1 hover:bg-gray-100 rounded">
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" /></svg>
          </button>
          <button onClick={() => navigate(1)} className="p-1 hover:bg-gray-100 rounded">
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" /></svg>
          </button>
          <button onClick={goToday} className="text-xs px-2 py-1 border border-gray-300 rounded hover:bg-gray-50">Today</button>
          <h2 className="font-semibold text-gray-900 ml-2">{heading}</h2>
        </div>
        <div className="flex rounded-lg border border-gray-300 overflow-hidden text-xs">
          {(['month', 'week', 'day'] as CalViewMode[]).map(v => (
            <button
              key={v}
              onClick={() => setCalView(v)}
              className={`px-3 py-1.5 capitalize ${calView === v ? 'bg-ooosh-600 text-white' : 'bg-white text-gray-700 hover:bg-gray-50'}`}
            >
              {v}
            </button>
          ))}
        </div>
      </div>

      {/* Month view */}
      {calView === 'month' && (
        <>
          <div className="grid grid-cols-7 border-b border-gray-200">
            {['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map((d) => (
              <div key={d} className="px-2 py-1.5 text-xs font-semibold text-gray-500 text-center">{d}</div>
            ))}
          </div>
          <div className="grid grid-cols-7">
            {visibleDays.map((day) => {
              const key = makeDateKey(day);
              const items = data[key] || [];
              const isToday = key === todayKey;
              const isCurrentMonth = day.getMonth() === currentDate.getMonth();
              return (
                <div
                  key={key}
                  className={`min-h-[80px] border-b border-r border-gray-100 p-1 ${isToday ? 'bg-ooosh-50' : ''} ${!isCurrentMonth ? 'bg-gray-50' : ''}`}
                >
                  <div className={`text-xs font-medium mb-0.5 ${isToday ? 'text-ooosh-700 font-bold' : isCurrentMonth ? 'text-gray-500' : 'text-gray-300'}`}>
                    {day.getDate()}
                  </div>
                  <div className="space-y-0.5">
                    {items.slice(0, 4).map((q) => <ItemPill key={q.id} q={q} />)}
                    {items.length > 4 && (
                      <button
                        onClick={() => { setCalView('day'); setCurrentDate(new Date(day)); }}
                        className="text-[10px] text-ooosh-600 hover:underline"
                      >
                        +{items.length - 4} more
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </>
      )}

      {/* Week view */}
      {calView === 'week' && (
        <>
          <div className="grid grid-cols-7 border-b border-gray-200">
            {visibleDays.map(day => {
              const key = makeDateKey(day);
              const isToday = key === todayKey;
              return (
                <div
                  key={key}
                  className={`px-2 py-2 text-center border-r border-gray-100 cursor-pointer hover:bg-gray-50 ${isToday ? 'bg-ooosh-50' : ''}`}
                  onClick={() => { setCalView('day'); setCurrentDate(new Date(day)); }}
                >
                  <div className="text-xs text-gray-500">{day.toLocaleDateString('en-GB', { weekday: 'short' })}</div>
                  <div className={`text-lg font-semibold ${isToday ? 'text-ooosh-700' : 'text-gray-900'}`}>{day.getDate()}</div>
                </div>
              );
            })}
          </div>
          <div className="grid grid-cols-7">
            {visibleDays.map(day => {
              const key = makeDateKey(day);
              const items = data[key] || [];
              const isToday = key === todayKey;
              return (
                <div key={key} className={`min-h-[200px] border-r border-gray-100 p-1.5 space-y-1 ${isToday ? 'bg-ooosh-50/30' : ''}`}>
                  {items.map(q => {
                    const sc = OPS_STATUS_CONFIG[q.ops_status || 'todo'] || OPS_STATUS_CONFIG.todo;
                    const assignments = Array.isArray(q.assignments) ? q.assignments : [];
                    return (
                      <div
                        key={q.id}
                        onClick={() => setSelectedQuote(q)}
                        className={`p-1.5 rounded border cursor-pointer hover:shadow-sm transition-shadow ${JOB_TYPE_COLOURS[q.job_type] || 'bg-gray-50 border-gray-200'}`}
                      >
                        <div className="text-[10px] font-semibold">{q.arrival_time || '—'}</div>
                        <div className="text-[10px] leading-tight truncate">{q.linked_venue_name || q.venue_name || 'TBC'}</div>
                        <div className="flex items-center gap-1 mt-0.5">
                          <span className={`text-[9px] rounded px-1 py-0.5 ${sc.bgColour} ${sc.colour}`}>{sc.label}</span>
                        </div>
                        {assignments.length > 0 && (
                          <div className="text-[9px] text-gray-500 mt-0.5 truncate">
                            {assignments.map(a => a.is_ooosh_crew ? 'Ooosh' : a.first_name || '').join(', ')}
                          </div>
                        )}
                      </div>
                    );
                  })}
                  {items.length === 0 && <div className="text-xs text-gray-300 text-center mt-4">—</div>}
                </div>
              );
            })}
          </div>
        </>
      )}

      {/* Day view */}
      {calView === 'day' && (
        <div className="p-4">
          {(() => {
            const key = makeDateKey(currentDate);
            const items = (data[key] || []).sort((a, b) => (a.arrival_time || '').localeCompare(b.arrival_time || ''));
            if (items.length === 0) return <p className="text-gray-400 text-sm text-center py-8">No transport scheduled for this day.</p>;
            return (
              <div className="space-y-2">
                {items.map(q => {
                  const sc = OPS_STATUS_CONFIG[q.ops_status || 'todo'] || OPS_STATUS_CONFIG.todo;
                  const assignments = Array.isArray(q.assignments) ? q.assignments : [];
                  return (
                    <div
                      key={q.id}
                      onClick={() => setSelectedQuote(q)}
                      className="flex items-start gap-4 p-3 rounded-lg border border-gray-200 hover:bg-gray-50 cursor-pointer transition-colors"
                    >
                      <div className="w-16 text-right">
                        <div className="text-sm font-semibold text-gray-900">{q.arrival_time || '—'}</div>
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2">
                          <span className={`text-xs font-medium rounded px-2 py-0.5 ${JOB_TYPE_COLOURS[q.job_type] || 'bg-gray-100 text-gray-700'}`}>
                            {JOB_TYPE_LABELS[q.job_type]}
                          </span>
                          <span className={`text-xs rounded px-2 py-0.5 ${sc.bgColour} ${sc.colour}`}>{sc.label}</span>
                          {q.calculation_mode === 'fixed' && <span className="text-xs bg-amber-100 text-amber-700 rounded px-1.5 py-0.5">Local</span>}
                        </div>
                        <div className="text-sm font-medium text-gray-900 mt-1">{q.linked_venue_name || q.venue_name || 'TBC'}</div>
                        {q.hh_job_number && <Link to={`/jobs/${q.job_id}`} className="text-xs text-ooosh-600 hover:underline">Job #{q.hh_job_number}</Link>}
                        {assignments.length > 0 && (
                          <div className="text-xs text-gray-500 mt-1">
                            {assignments.map(a => a.is_ooosh_crew ? 'Ooosh Crew' : `${a.first_name || ''} ${a.last_name || ''}`.trim()).join(', ')}
                          </div>
                        )}
                      </div>
                      <div className="text-right text-xs text-gray-500">
                        {q.client_charge_rounded != null && <div>£{q.client_charge_rounded}</div>}
                      </div>
                    </div>
                  );
                })}
              </div>
            );
          })()}
        </div>
      )}

      {/* Quote detail slide panel */}
      {selectedQuote && <QuoteSlidePanel q={selectedQuote} onClose={() => setSelectedQuote(null)} />}
    </div>
  );
}

// ── Helpers ──────────────────────────────────────────────────────────

function formatDate(dateInput: string | Date): string {
  try {
    // node-pg returns DATE columns as JS Date objects, TIMESTAMPTZ as ISO strings
    let d: Date;
    if (dateInput instanceof Date) {
      d = dateInput;
    } else if (typeof dateInput === 'string') {
      const raw = dateInput.includes('T') ? dateInput : dateInput + 'T12:00:00';
      d = new Date(raw);
    } else {
      return String(dateInput);
    }
    if (isNaN(d.getTime())) return String(dateInput);
    return d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });
  } catch {
    return String(dateInput);
  }
}
