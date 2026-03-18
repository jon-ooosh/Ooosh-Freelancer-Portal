import { useState, useEffect, useMemo } from 'react';
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
  job_date: string | null;
  job_finish_date: string | null;
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
  completion_notes: string | null;
  what_is_it: string | null;
  internal_notes: string | null;
  freelancer_notes: string | null;
  // Joined fields
  job_name: string | null;
  hirehop_id: number | null;
  client_name: string | null;
  out_date: string | null;
  return_date: string | null;
  linked_venue_name: string | null;
  venue_address: string | null;
  venue_city: string | null;
  assignments: Assignment[];
}

// ── Constants ────────────────────────────────────────────────────────

const OPS_STATUSES = ['todo', 'arranging', 'arranged', 'dispatched', 'arrived', 'completed', 'cancelled'] as const;

const OPS_STATUS_CONFIG: Record<string, { label: string; colour: string; bgColour: string }> = {
  todo: { label: 'To Be Arranged', colour: 'text-red-700', bgColour: 'bg-red-100' },
  arranging: { label: 'Arranging', colour: 'text-amber-700', bgColour: 'bg-amber-100' },
  arranged: { label: 'Arranged', colour: 'text-blue-700', bgColour: 'bg-blue-100' },
  dispatched: { label: 'Dispatched', colour: 'text-indigo-700', bgColour: 'bg-indigo-100' },
  arrived: { label: 'Arrived', colour: 'text-purple-700', bgColour: 'bg-purple-100' },
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

// ── Main Page ────────────────────────────────────────────────────────

export default function TransportOpsPage() {
  const [quotes, setQuotes] = useState<OpsQuote[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [filter, setFilter] = useState<'all' | 'transport' | 'crewed'>('all');
  const [viewMode, setViewMode] = useState<'table' | 'calendar'>('table');
  const [showCompleted, setShowCompleted] = useState(false);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  useEffect(() => {
    loadOps();
  }, [filter]);

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

  // Calendar data: group by date
  const calendarData = useMemo(() => {
    const byDate: Record<string, OpsQuote[]> = {};
    for (const q of quotes) {
      if (q.ops_status === 'completed' || q.ops_status === 'cancelled') continue;
      const date = q.job_date || 'unscheduled';
      if (!byDate[date]) byDate[date] = [];
      byDate[date].push(q);
    }
    return byDate;
  }, [quotes]);

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

          {/* Show completed toggle */}
          <label className="flex items-center gap-1.5 text-sm text-gray-600 cursor-pointer">
            <input
              type="checkbox"
              checked={showCompleted}
              onChange={(e) => setShowCompleted(e.target.checked)}
              className="rounded border-gray-300 text-ooosh-600 focus:ring-ooosh-500"
            />
            Show completed
          </label>
        </div>
      </div>

      {error && (
        <div className="bg-red-50 border border-red-200 rounded-lg p-3 text-sm text-red-700">{error}</div>
      )}

      {/* Table view */}
      {viewMode === 'table' && (
        <div className="space-y-6">
          {OPS_STATUSES.filter((s) => showCompleted || (s !== 'completed' && s !== 'cancelled')).map((status) => {
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
        <CalendarView data={calendarData} />
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
}: {
  quote: OpsQuote;
  expanded: boolean;
  onToggle: () => void;
  onStatusChange: (id: string, status: string) => void;
}) {
  const assignments = Array.isArray(q.assignments) ? q.assignments : [];
  const crewNames = assignments
    .map((a) => a.is_ooosh_crew ? 'Ooosh Crew' : `${a.first_name || ''} ${a.last_name || ''}`.trim())
    .filter(Boolean);

  return (
    <div>
      <div
        className="px-4 py-3 flex items-center gap-3 hover:bg-gray-50 cursor-pointer transition-colors"
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

        {/* Local badge */}
        {q.is_local && (
          <span className="text-xs px-1.5 py-0.5 rounded bg-teal-100 text-teal-700 font-medium">Local</span>
        )}

        {/* Run group badge */}
        {q.run_group && (
          <span className="text-xs px-1.5 py-0.5 rounded bg-violet-100 text-violet-700 font-medium">
            Run {q.run_order || '?'}
          </span>
        )}

        {/* Date & time */}
        <div className="w-28 flex-shrink-0">
          <div className="text-sm font-medium text-gray-900">
            {q.job_date ? formatDate(q.job_date) : <span className="text-gray-400">No date</span>}
          </div>
          {q.arrival_time && (
            <div className="text-xs text-gray-500">{q.arrival_time}</div>
          )}
        </div>

        {/* Job / Venue name */}
        <div className="flex-1 min-w-0">
          <div className="text-sm font-medium text-gray-900 truncate">
            {q.linked_venue_name || q.venue_name || 'No venue'}
            {q.hirehop_id && (
              <span className="ml-1.5 text-xs text-gray-400">HH#{q.hirehop_id}</span>
            )}
          </div>
          <div className="text-xs text-gray-500 truncate">
            {q.client_name || q.job_name || ''}
          </div>
        </div>

        {/* Crew */}
        <div className="w-40 flex-shrink-0 hidden lg:block">
          {crewNames.length > 0 ? (
            <div className="text-sm text-gray-700 truncate">{crewNames.join(', ')}</div>
          ) : (
            <span className="text-xs text-red-500 font-medium">Unassigned</span>
          )}
        </div>

        {/* Fee */}
        <div className="w-16 text-right flex-shrink-0 hidden md:block">
          <span className="text-sm font-medium text-gray-700">
            {q.client_charge_rounded ? `£${q.client_charge_rounded}` : '—'}
          </span>
        </div>

        {/* Status dropdown */}
        <div className="w-32 flex-shrink-0" onClick={(e) => e.stopPropagation()}>
          <select
            value={q.ops_status || 'todo'}
            onChange={(e) => onStatusChange(q.id, e.target.value)}
            className={`text-xs font-medium rounded px-2 py-1 border-0 cursor-pointer w-full ${
              OPS_STATUS_CONFIG[q.ops_status]?.bgColour || 'bg-gray-100'
            } ${OPS_STATUS_CONFIG[q.ops_status]?.colour || 'text-gray-700'}`}
          >
            {OPS_STATUSES.map((s) => (
              <option key={s} value={s}>{OPS_STATUS_CONFIG[s].label}</option>
            ))}
          </select>
        </div>
      </div>

      {/* Expanded detail */}
      {expanded && (
        <div className="px-4 pb-4 pt-1 bg-gray-50 border-t border-gray-100">
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
            </div>

            {/* Column 2: Arranging */}
            <div className="space-y-2">
              <h4 className="font-semibold text-gray-700 text-xs uppercase tracking-wider">Arranging</h4>
              {q.key_points && (
                <div className="text-gray-600">
                  <span className="font-medium">Key points:</span> {q.key_points}
                </div>
              )}
              {q.client_introduction && (
                <div className="text-gray-600">
                  <span className="font-medium">Client intro:</span> {q.client_introduction}
                </div>
              )}
              <div className="flex flex-wrap gap-2">
                {q.tolls_status !== 'not_needed' && (
                  <StatusPill label="Tolls" status={q.tolls_status} />
                )}
                {q.accommodation_status !== 'not_needed' && (
                  <StatusPill label="Accommodation" status={q.accommodation_status} />
                )}
                {q.flight_status !== 'not_needed' && (
                  <StatusPill label="Flights" status={q.flight_status} />
                )}
              </div>
              {q.freelancer_notes && (
                <div className="text-gray-500 text-xs italic">
                  Freelancer notes: {q.freelancer_notes}
                </div>
              )}
              {q.internal_notes && (
                <div className="text-gray-500 text-xs">
                  Internal: {q.internal_notes}
                </div>
              )}
            </div>

            {/* Column 3: Crew & Financials */}
            <div className="space-y-2">
              <h4 className="font-semibold text-gray-700 text-xs uppercase tracking-wider">Crew & Costs</h4>
              {assignments.length === 0 ? (
                <div className="text-red-500 text-xs">No crew assigned</div>
              ) : (
                assignments.map((a) => (
                  <div key={a.id} className="flex items-center justify-between text-xs">
                    <span className="text-gray-700">
                      {a.is_ooosh_crew ? 'Ooosh Crew' : `${a.first_name} ${a.last_name}`}
                      <span className="text-gray-400 ml-1">({a.role})</span>
                    </span>
                    <span className="text-gray-500">
                      {a.agreed_rate ? `£${a.agreed_rate}` : '—'}
                      {a.invoice_received && (
                        <span className="ml-1 text-green-600" title={`Invoice: £${a.invoice_amount}`}>INV</span>
                      )}
                    </span>
                  </div>
                ))
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
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Status Pill (for tolls/accommodation/flight) ─────────────────────

function StatusPill({ label, status }: { label: string; status: string }) {
  const colours: Record<string, string> = {
    todo: 'bg-amber-100 text-amber-700',
    booked: 'bg-green-100 text-green-700',
    paid: 'bg-emerald-100 text-emerald-700',
  };
  return (
    <span className={`text-xs px-2 py-0.5 rounded-full ${colours[status] || 'bg-gray-100 text-gray-600'}`}>
      {label}: {status}
    </span>
  );
}

// ── Calendar View ────────────────────────────────────────────────────

function CalendarView({
  data,
}: {
  data: Record<string, OpsQuote[]>;
}) {
  const [currentMonth, setCurrentMonth] = useState(() => {
    const now = new Date();
    return new Date(now.getFullYear(), now.getMonth(), 1);
  });

  const daysInMonth = new Date(currentMonth.getFullYear(), currentMonth.getMonth() + 1, 0).getDate();
  const firstDayOfWeek = currentMonth.getDay(); // 0=Sun
  // Adjust to Monday-start: 0=Mon, 6=Sun
  const startOffset = firstDayOfWeek === 0 ? 6 : firstDayOfWeek - 1;

  const days: (number | null)[] = [];
  for (let i = 0; i < startOffset; i++) days.push(null);
  for (let d = 1; d <= daysInMonth; d++) days.push(d);

  const monthStr = currentMonth.toLocaleDateString('en-GB', { month: 'long', year: 'numeric' });

  function dateKey(day: number): string {
    const y = currentMonth.getFullYear();
    const m = String(currentMonth.getMonth() + 1).padStart(2, '0');
    return `${y}-${m}-${String(day).padStart(2, '0')}`;
  }

  const todayKey = new Date().toISOString().split('T')[0];

  return (
    <div className="bg-white rounded-lg shadow-sm border border-gray-200 overflow-hidden">
      {/* Month nav */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-gray-200">
        <button
          onClick={() => setCurrentMonth(new Date(currentMonth.getFullYear(), currentMonth.getMonth() - 1, 1))}
          className="p-1 hover:bg-gray-100 rounded"
        >
          <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
          </svg>
        </button>
        <h2 className="font-semibold text-gray-900">{monthStr}</h2>
        <button
          onClick={() => setCurrentMonth(new Date(currentMonth.getFullYear(), currentMonth.getMonth() + 1, 1))}
          className="p-1 hover:bg-gray-100 rounded"
        >
          <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
          </svg>
        </button>
      </div>

      {/* Day headers */}
      <div className="grid grid-cols-7 border-b border-gray-200">
        {['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map((d) => (
          <div key={d} className="px-2 py-1.5 text-xs font-semibold text-gray-500 text-center">{d}</div>
        ))}
      </div>

      {/* Calendar grid */}
      <div className="grid grid-cols-7">
        {days.map((day, idx) => {
          if (day === null) {
            return <div key={`empty-${idx}`} className="min-h-[80px] border-b border-r border-gray-100 bg-gray-50" />;
          }

          const key = dateKey(day);
          const items = data[key] || [];
          const isToday = key === todayKey;

          return (
            <div
              key={key}
              className={`min-h-[80px] border-b border-r border-gray-100 p-1 ${isToday ? 'bg-ooosh-50' : ''}`}
            >
              <div className={`text-xs font-medium mb-0.5 ${isToday ? 'text-ooosh-700 font-bold' : 'text-gray-500'}`}>
                {day}
              </div>
              <div className="space-y-0.5">
                {items.slice(0, 4).map((q) => (
                  <div
                    key={q.id}
                    className={`text-[10px] leading-tight px-1 py-0.5 rounded truncate cursor-default ${
                      JOB_TYPE_COLOURS[q.job_type] || 'bg-gray-100 text-gray-700'
                    }`}
                    title={`${JOB_TYPE_LABELS[q.job_type]} ${q.linked_venue_name || q.venue_name || ''} ${q.arrival_time || ''}`}
                  >
                    {JOB_TYPE_LABELS[q.job_type]} {q.linked_venue_name || q.venue_name || '?'}
                  </div>
                ))}
                {items.length > 4 && (
                  <div className="text-[10px] text-gray-400">+{items.length - 4} more</div>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ── Helpers ──────────────────────────────────────────────────────────

function formatDate(dateStr: string): string {
  try {
    const d = new Date(dateStr + 'T00:00:00');
    return d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });
  } catch {
    return dateStr;
  }
}
