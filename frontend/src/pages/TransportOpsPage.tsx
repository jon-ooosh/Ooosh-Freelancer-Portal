import { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { Link } from 'react-router-dom';
import { api } from '../services/api';
import DatePicker from '../components/DatePicker';
import { VenuePicker } from '../components/VenuePicker';
import CompleteQuoteOverrideModal from '../components/CompleteQuoteOverrideModal';

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
  run_combined_freelancer_fee: number | null;
  run_combined_client_fee: number | null;
  run_notes: string | null;
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
  pipeline_status: string | null;
  job_status: number | null;
  linked_venue_name: string | null;
  venue_address: string | null;
  venue_city: string | null;
  assignments: Assignment[];
}

// Speculative-section bucket. Operational = confirmed-and-beyond (the default
// view). The other four are opt-in via the "Show:" filter pills and render
// in dedicated sections below the operational lists.
type JobBucket = 'operational' | 'provisional' | 'enquiry' | 'lost' | 'cancelled';

type SpeculativeBucket = Exclude<JobBucket, 'operational'>;

const JOB_BUCKET_ORDER: SpeculativeBucket[] = ['provisional', 'enquiry', 'lost', 'cancelled'];

const JOB_BUCKET_CONFIG: Record<Exclude<JobBucket, 'operational'>, {
  label: string;
  description: string;
  badge: string;          // used on the speculative section header
  rowBadge: string;       // used as a small pill on each row in case of merge
}> = {
  provisional: {
    label: 'Provisional',
    description: 'Awaiting deposit — not yet confirmed.',
    badge: 'bg-blue-100 text-blue-700 border-blue-200',
    rowBadge: 'bg-blue-100 text-blue-700',
  },
  enquiry: {
    label: 'Enquiry',
    description: 'Pre-provisional. Speculative — these jobs may not happen.',
    badge: 'bg-purple-100 text-purple-700 border-purple-200',
    rowBadge: 'bg-purple-100 text-purple-700',
  },
  lost: {
    label: 'Lost',
    description: 'Enquiries that didn\'t convert.',
    badge: 'bg-gray-100 text-gray-600 border-gray-200',
    rowBadge: 'bg-gray-100 text-gray-600',
  },
  cancelled: {
    label: 'Cancelled',
    description: 'Confirmed jobs that were later cancelled.',
    badge: 'bg-rose-100 text-rose-700 border-rose-200',
    rowBadge: 'bg-rose-100 text-rose-700',
  },
};

function getJobBucket(q: OpsQuote): JobBucket {
  const ps = q.pipeline_status;
  const js = q.job_status;
  if (ps === 'provisional' || (ps == null && js === 1)) return 'provisional';
  if (
    ps === 'new_enquiry' || ps === 'quoting' || ps === 'paused' ||
    (ps == null && js === 0)
  ) return 'enquiry';
  if (ps === 'lost' || (ps == null && js === 10)) return 'lost';
  if (ps === 'cancelled' || (ps == null && js === 9)) return 'cancelled';
  return 'operational';
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

// ── Filter + sort helpers ────────────────────────────────────────────

type DateWindow = 'all' | 'overdue' | 'today_tomorrow' | 'this_week' | 'next_week' | 'upcoming';
type SortKey = 'date' | 'client' | 'freelancer' | 'status';

/** Calendar-day precision, timezone-local. Today at midnight. */
function startOfToday(): Date {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
}

/** Start of this ISO week (Monday 00:00). */
function startOfIsoWeek(): Date {
  const d = startOfToday();
  const day = d.getDay() || 7; // Sun → 7
  if (day !== 1) d.setDate(d.getDate() - (day - 1));
  return d;
}

function addDays(d: Date, n: number): Date {
  const r = new Date(d);
  r.setDate(r.getDate() + n);
  return r;
}

/** Extract a Date (or null) from a quote's job_date which may be string | Date | null. */
function quoteDate(q: OpsQuote): Date | null {
  if (!q.job_date) return null;
  const d = q.job_date instanceof Date ? new Date(q.job_date) : new Date(q.job_date);
  if (Number.isNaN(d.getTime())) return null;
  d.setHours(0, 0, 0, 0);
  return d;
}

/** Does the quote fall inside the named window? "all" always true. */
function inDateWindow(q: OpsQuote, win: DateWindow): boolean {
  if (win === 'all') return true;
  const jd = quoteDate(q);
  if (!jd) return false; // unscheduled quotes only show in the "all" window
  const today = startOfToday();
  if (win === 'overdue') {
    return jd < today && q.ops_status !== 'completed' && q.ops_status !== 'cancelled';
  }
  if (win === 'today_tomorrow') {
    const tomorrow = addDays(today, 1);
    return jd.getTime() === today.getTime() || jd.getTime() === tomorrow.getTime();
  }
  if (win === 'this_week') {
    const start = startOfIsoWeek();
    const end = addDays(start, 7);
    return jd >= start && jd < end;
  }
  if (win === 'next_week') {
    const start = addDays(startOfIsoWeek(), 7);
    const end = addDays(start, 7);
    return jd >= start && jd < end;
  }
  if (win === 'upcoming') return jd >= today;
  return true;
}

/** Case-insensitive substring match across the fields staff typically look
 *  for: HH number, client, venue (linked or free text), job name, and any
 *  assigned crew member's name. */
function matchesSearch(q: OpsQuote, term: string): boolean {
  if (!term) return true;
  const needle = term.toLowerCase().trim();
  if (!needle) return true;
  const haystack: string[] = [
    q.hh_job_number != null ? String(q.hh_job_number) : '',
    q.client_name || '',
    q.job_name || '',
    q.linked_venue_name || '',
    q.venue_name || '',
    q.venue_address || '',
    q.venue_city || '',
    q.work_description || '',
  ];
  for (const a of q.assignments || []) {
    if (a.is_ooosh_crew) haystack.push('ooosh staff', 'ooosh crew');
    else haystack.push(`${a.first_name || ''} ${a.last_name || ''}`.trim());
  }
  return haystack.some((h) => h && h.toLowerCase().includes(needle));
}

function sortQuotes(list: OpsQuote[], sortBy: SortKey): OpsQuote[] {
  const arr = [...list];
  if (sortBy === 'date') {
    arr.sort((a, b) => {
      const ad = quoteDate(a); const bd = quoteDate(b);
      if (!ad && !bd) return 0;
      if (!ad) return 1;
      if (!bd) return -1;
      return ad.getTime() - bd.getTime() || (a.arrival_time || '').localeCompare(b.arrival_time || '');
    });
  } else if (sortBy === 'client') {
    arr.sort((a, b) => (a.client_name || '').localeCompare(b.client_name || ''));
  } else if (sortBy === 'freelancer') {
    const nameOf = (q: OpsQuote) => {
      const a = (q.assignments || [])[0];
      if (!a) return '~~~unassigned';
      if (a.is_ooosh_crew) return '~~ooosh';
      return `${a.first_name || ''} ${a.last_name || ''}`.trim() || '~~~unknown';
    };
    arr.sort((a, b) => nameOf(a).localeCompare(nameOf(b)));
  } else if (sortBy === 'status') {
    const rank = (s: string) => OPS_STATUSES.indexOf(s as typeof OPS_STATUSES[number]);
    arr.sort((a, b) => rank(a.ops_status) - rank(b.ops_status));
  }
  return arr;
}

// ── Main Page ────────────────────────────────────────────────────────

export default function TransportOpsPage() {
  // Read URL params once at mount so reload / bookmarked links preserve state.
  const initialParams = typeof window !== 'undefined'
    ? new URLSearchParams(window.location.search)
    : new URLSearchParams();

  const [quotes, setQuotes] = useState<OpsQuote[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [filter, setFilter] = useState<'all' | 'transport' | 'crewed'>(
    (initialParams.get('type') as 'all' | 'transport' | 'crewed') || 'all'
  );
  const [needsCrewOnly, setNeedsCrewOnly] = useState(() => initialParams.get('needs_crew') === '1');
  const [needsIntroOnly, setNeedsIntroOnly] = useState(() => initialParams.get('needs_intro') === '1');
  const [viewMode, setViewMode] = useState<'table' | 'calendar'>(
    initialParams.get('view') === 'calendar' ? 'calendar' : 'table'
  );
  const [showCompleted, setShowCompleted] = useState(initialParams.get('completed') === '1');
  const [showCancelled, setShowCancelled] = useState(initialParams.get('cancelled') === '1');
  // Job-stage toggles — heads-up planning, mirroring the backline page.
  // These widen the API query to include speculative / dead-stage jobs and
  // surface them in their own collapsible sections below the operational
  // lists. Default off; URL-persisted so a shared link keeps the view.
  const [showProvisional, setShowProvisional] = useState(initialParams.get('provisional') === '1');
  const [showEnquiry, setShowEnquiry] = useState(initialParams.get('enquiry') === '1');
  const [showLostJobs, setShowLostJobs] = useState(initialParams.get('lost') === '1');
  const [showCancelledJobs, setShowCancelledJobs] = useState(initialParams.get('cancelled_jobs') === '1');
  // Collapsed section keys — persisted in localStorage so refreshes keep
  // the layout staff have set up. Separate keyspace per render-bucket so a
  // collapsed "todo" in the operational list doesn't collapse a "todo"
  // sub-list inside the Provisional section (and vice versa).
  const [collapsedSections, setCollapsedSections] = useState<Set<string>>(() => {
    try {
      const raw = localStorage.getItem('transportOps.collapsedSections');
      return raw ? new Set(JSON.parse(raw) as string[]) : new Set();
    } catch {
      return new Set();
    }
  });

  // New filter controls — date window, free-text search, sort, person/venue pins.
  const [dateWindow, setDateWindow] = useState<DateWindow>(
    (initialParams.get('when') as DateWindow) || 'all'
  );
  const [searchTerm, setSearchTerm] = useState(initialParams.get('q') || '');
  const [sortBy, setSortBy] = useState<SortKey>((initialParams.get('sort') as SortKey) || 'date');
  // When the user clicks a driver / venue in a row, pin the page to just
  // that entity. null means no pin.
  const [personPin, setPersonPin] = useState<{ id: string; name: string } | null>(() => {
    const id = initialParams.get('person_id');
    const name = initialParams.get('person_name');
    return id && name ? { id, name } : null;
  });
  const [venuePin, setVenuePin] = useState<{ name: string } | null>(() => {
    const name = initialParams.get('venue_name');
    return name ? { name } : null;
  });
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [assignModalQuoteId, setAssignModalQuoteId] = useState<string | null>(null);
  const [assignRole, setAssignRole] = useState('driver');
  const [peopleSearch, setPeopleSearch] = useState('');
  const [peopleOptions, setPeopleOptions] = useState<PersonOption[]>([]);
  const [crewHistory, setCrewHistory] = useState<{ person_id: string; first_name: string; last_name: string; role: string; job_count: number; last_job_date: string; avg_rate: number }[]>([]);

  useEffect(() => {
    loadOps();
    // Job-stage toggles are part of the API query, so re-fetch when they
    // change. The other URL-synced state (date window, sort, search, etc.)
    // is filtered client-side from a single response and doesn't refetch.
  }, [filter, showProvisional, showEnquiry, showLostJobs, showCancelledJobs]);

  // Keep the URL in sync with the current filter state so refresh / share
  // preserves what the user was looking at. Debounce the search string so
  // every keystroke doesn't thrash history.
  useEffect(() => {
    const params = new URLSearchParams();
    if (filter !== 'all') params.set('type', filter);
    if (viewMode !== 'table') params.set('view', viewMode);
    if (showCompleted) params.set('completed', '1');
    if (showCancelled) params.set('cancelled', '1');
    if (showProvisional) params.set('provisional', '1');
    if (showEnquiry) params.set('enquiry', '1');
    if (showLostJobs) params.set('lost', '1');
    if (showCancelledJobs) params.set('cancelled_jobs', '1');
    if (needsCrewOnly) params.set('needs_crew', '1');
    if (needsIntroOnly) params.set('needs_intro', '1');
    if (dateWindow !== 'all') params.set('when', dateWindow);
    if (searchTerm) params.set('q', searchTerm);
    if (sortBy !== 'date') params.set('sort', sortBy);
    if (personPin) {
      params.set('person_id', personPin.id);
      params.set('person_name', personPin.name);
    }
    if (venuePin) params.set('venue_name', venuePin.name);
    const qs = params.toString();
    const newUrl = qs ? `${window.location.pathname}?${qs}` : window.location.pathname;
    const timer = window.setTimeout(() => {
      window.history.replaceState({}, '', newUrl);
    }, 200);
    return () => window.clearTimeout(timer);
  }, [
    filter, viewMode, showCompleted, showCancelled,
    showProvisional, showEnquiry, showLostJobs, showCancelledJobs,
    needsCrewOnly, needsIntroOnly, dateWindow, searchTerm, sortBy, personPin, venuePin,
  ]);

  // Toggle a collapsible section's collapsed state and persist to
  // localStorage. Section keys are namespaced per render bucket — see the
  // sectionKey() helper below.
  const toggleSection = useCallback((key: string) => {
    setCollapsedSections((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      try {
        localStorage.setItem('transportOps.collapsedSections', JSON.stringify([...next]));
      } catch {
        // ignore quota errors — non-essential
      }
      return next;
    });
  }, []);

  // Build the /quotes/ops/overview query string for the active filter +
  // toggle state. Used by every fetch path so they stay in lockstep.
  const buildOverviewQuery = useCallback(() => {
    const params = new URLSearchParams();
    if (filter !== 'all') params.set('job_type', filter);
    if (showProvisional) params.set('include_provisional', 'true');
    if (showEnquiry) params.set('include_enquiry', 'true');
    if (showLostJobs) params.set('include_lost', 'true');
    if (showCancelledJobs) params.set('include_cancelled', 'true');
    const qs = params.toString();
    return qs ? `?${qs}` : '';
  }, [filter, showProvisional, showEnquiry, showLostJobs, showCancelledJobs]);

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

  // Map effective_ops_status from backend (handles lifecycle-cancelled quotes)
  function mapEffectiveOpsStatus(data: OpsQuote[]): OpsQuote[] {
    return data.map((q) => ({
      ...q,
      ops_status: (q as any).effective_ops_status || q.ops_status || 'todo',
    }));
  }

  async function loadOps() {
    try {
      setLoading(true);
      const res = await api.get<{ data: OpsQuote[] }>(`/quotes/ops/overview${buildOverviewQuery()}`);
      setQuotes(mapEffectiveOpsStatus(res.data));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load');
    } finally {
      setLoading(false);
    }
  }

  async function updateOpsStatus(quoteId: string, newStatus: string) {
    // Completion should go through the override modal (captures reason,
    // offers a nudge first). Portal is still the primary completion path.
    if (newStatus === 'completed') {
      const quote = quotes.find((q) => q.id === quoteId);
      if (quote) {
        setCompletingQuote(quote);
        return;
      }
    }
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
  const [completingQuote, setCompletingQuote] = useState<OpsQuote | null>(null);

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
      const res = await api.get<{ data: OpsQuote[] }>(`/quotes/ops/overview${buildOverviewQuery()}`);
      setQuotes(mapEffectiveOpsStatus(res.data));
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Failed to update run group');
    }
  }

  // Update the run's combined fee (applies across all member quotes).
  // Leaves individual freelancer_fee values intact — purely an override.
  async function updateRunCombinedFee(
    runGroupId: string,
    fields: { combined_freelancer_fee?: number | null; combined_client_fee?: number | null; notes?: string | null }
  ) {
    try {
      await api.patch(`/quotes/runs/${runGroupId}`, fields);
      const res = await api.get<{ data: OpsQuote[] }>(`/quotes/ops/overview${buildOverviewQuery()}`);
      setQuotes(mapEffectiveOpsStatus(res.data));
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Failed to update combined fee');
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

  // Filtered pool — pre-grouping, pre-sort. Applies every active filter.
  const filteredQuotes = useMemo(() => {
    let out = quotes;
    if (needsCrewOnly) {
      out = out.filter((q) => (q.assignments || []).filter((a) => a.status !== 'cancelled').length === 0);
    }
    if (needsIntroOnly) {
      out = out.filter((q) => {
        const intro = q.client_introduction || 'not_needed';
        return intro === 'todo' || intro === 'working_on_it';
      });
    }
    if (dateWindow !== 'all') {
      out = out.filter((q) => inDateWindow(q, dateWindow));
    }
    if (personPin) {
      out = out.filter((q) => (q.assignments || []).some((a) => a.person_id === personPin.id));
    }
    if (venuePin) {
      const pinLower = venuePin.name.toLowerCase();
      out = out.filter((q) => {
        const name = (q.linked_venue_name || q.venue_name || '').toLowerCase();
        return name === pinLower;
      });
    }
    if (searchTerm.trim()) {
      out = out.filter((q) => matchesSearch(q, searchTerm));
    }
    return out;
  }, [quotes, needsCrewOnly, needsIntroOnly, dateWindow, personPin, venuePin, searchTerm]);

  // Split filtered pool by job-stage bucket. Operational drives the main
  // grouped-by-ops_status table; the four speculative buckets render as
  // their own flat date-sorted sections below it.
  const filteredByBucket = useMemo(() => {
    const out: Record<JobBucket, OpsQuote[]> = {
      operational: [], provisional: [], enquiry: [], lost: [], cancelled: [],
    };
    for (const q of filteredQuotes) out[getJobBucket(q)].push(q);
    return out;
  }, [filteredQuotes]);

  // Group operational quotes by ops_status for the main table view.
  const grouped = useMemo(() => {
    const groups: Record<string, OpsQuote[]> = {};
    for (const status of OPS_STATUSES) groups[status] = [];
    for (const q of filteredByBucket.operational) {
      const status = q.ops_status || 'todo';
      if (!groups[status]) groups[status] = [];
      groups[status].push(q);
    }
    // Apply the sort within each ops_status bucket so the ladder ordering
    // stays intact across the page.
    for (const status of Object.keys(groups)) {
      groups[status] = sortQuotes(groups[status], sortBy);
    }
    return groups;
  }, [filteredByBucket.operational, sortBy]);

  // Speculative-section quotes: flat list per bucket, sorted by the
  // current sort key. We deliberately don't sub-group these by ops_status —
  // the volumes are small and a single date-sorted list is more useful.
  const speculativeSections = useMemo(() => {
    return JOB_BUCKET_ORDER
      .filter((b) => {
        if (b === 'provisional') return showProvisional;
        if (b === 'enquiry') return showEnquiry;
        if (b === 'lost') return showLostJobs;
        if (b === 'cancelled') return showCancelledJobs;
        return false;
      })
      .map((bucket) => ({
        bucket,
        quotes: sortQuotes(filteredByBucket[bucket], sortBy),
      }));
  }, [filteredByBucket, showProvisional, showEnquiry, showLostJobs, showCancelledJobs, sortBy]);

  // Calendar data: group by date (respects completed/cancelled toggles)
  const calendarData = useMemo(() => {
    const byDate: Record<string, OpsQuote[]> = {};
    for (const q of filteredQuotes) {
      if (q.ops_status === 'completed' && !showCompleted) continue;
      if (q.ops_status === 'cancelled' && !showCancelled) continue;
      const dateKey = normaliseDateKey(q.job_date) || 'unscheduled';
      if (!byDate[dateKey]) byDate[dateKey] = [];
      byDate[dateKey].push(q);
    }
    return byDate;
  }, [filteredQuotes, showCompleted, showCancelled]);

  // Top-of-page summary counts, computed against the raw operational quotes
  // (not filteredQuotes) so clicking a chip doesn't then change the chip
  // count. Speculative buckets (provisional / enquiry / lost / cancelled
  // jobs) are excluded — the chips are about real operational work, mirror-
  // ing the backline page convention. Respects the job-type pill though —
  // these counts are about the stream you're looking at.
  const summary = useMemo(() => {
    const today = startOfToday();
    let overdue = 0, todayCount = 0, thisWeek = 0, needsCrew = 0, needsIntro = 0;
    for (const q of quotes) {
      if (getJobBucket(q) !== 'operational') continue;
      const jd = quoteDate(q);
      const active = q.ops_status !== 'completed' && q.ops_status !== 'cancelled';
      if (active && jd && jd < today) overdue++;
      if (jd && jd.getTime() === today.getTime()) todayCount++;
      if (active && jd && inDateWindow(q, 'this_week')) thisWeek++;
      if (active && (q.assignments || []).filter((a) => a.status !== 'cancelled').length === 0) needsCrew++;
      if (active && (q.client_introduction === 'todo' || q.client_introduction === 'working_on_it')) needsIntro++;
    }
    return { overdue, todayCount, thisWeek, needsCrew, needsIntro };
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
            {filteredQuotes.length} of {quotes.length} shown
          </p>
        </div>

        <div className="flex items-center gap-2 flex-wrap">
          {/* Job type pills */}
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

          {/* Show completed/cancelled toggles — quote-level (controls the
              Completed / Cancelled ops_status sections in the operational
              table). Distinct from the Show: pills below, which are
              job-level (pipeline_status). */}
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

      {/* Job-stage toggles — heads-up planning. Off by default; speculative
          and dead-stage jobs render in their own collapsible sections below
          the operational lists. Headline stat chips above stay scoped to
          operational work. */}
      <div className="flex flex-wrap items-center gap-1 bg-gray-100 rounded-lg p-1 w-fit">
        <span className="px-2 py-1 text-[10px] uppercase tracking-wider text-gray-500 font-semibold">
          Show:
        </span>
        <button
          type="button"
          onClick={() => setShowProvisional((v) => !v)}
          title="Show jobs awaiting deposit (Provisional). Stat chips above stay scoped to confirmed work."
          className={`px-2 py-1.5 text-xs font-medium rounded-md transition-colors flex items-center gap-1 whitespace-nowrap ${
            showProvisional ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-500 hover:text-gray-700'
          }`}
        >
          <span className={`w-2 h-2 rounded-full flex-shrink-0 ${showProvisional ? 'bg-blue-400' : 'bg-gray-300'}`} />
          Provisional
        </button>
        <button
          type="button"
          onClick={() => setShowEnquiry((v) => !v)}
          title="Show pre-provisional enquiries. Useful for forward-planning capacity."
          className={`px-2 py-1.5 text-xs font-medium rounded-md transition-colors flex items-center gap-1 whitespace-nowrap ${
            showEnquiry ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-500 hover:text-gray-700'
          }`}
        >
          <span className={`w-2 h-2 rounded-full flex-shrink-0 ${showEnquiry ? 'bg-purple-400' : 'bg-gray-300'}`} />
          Enquiry
        </button>
        <button
          type="button"
          onClick={() => setShowLostJobs((v) => !v)}
          title="Show jobs that didn't convert (Lost)."
          className={`px-2 py-1.5 text-xs font-medium rounded-md transition-colors flex items-center gap-1 whitespace-nowrap ${
            showLostJobs ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-500 hover:text-gray-700'
          }`}
        >
          <span className={`w-2 h-2 rounded-full flex-shrink-0 ${showLostJobs ? 'bg-gray-500' : 'bg-gray-300'}`} />
          Lost
        </button>
        <button
          type="button"
          onClick={() => setShowCancelledJobs((v) => !v)}
          title="Show jobs that were confirmed and later cancelled."
          className={`px-2 py-1.5 text-xs font-medium rounded-md transition-colors flex items-center gap-1 whitespace-nowrap ${
            showCancelledJobs ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-500 hover:text-gray-700'
          }`}
        >
          <span className={`w-2 h-2 rounded-full flex-shrink-0 ${showCancelledJobs ? 'bg-rose-500' : 'bg-gray-300'}`} />
          Cancelled
        </button>
      </div>

      {/* Summary chips — click any count to jump to that view */}
      <div className="flex flex-wrap gap-2">
        <button
          onClick={() => setDateWindow(dateWindow === 'overdue' ? 'all' : 'overdue')}
          className={`text-xs px-3 py-1.5 rounded-full border font-medium transition-colors ${
            summary.overdue === 0
              ? 'bg-gray-50 text-gray-400 border-gray-200 cursor-default'
              : dateWindow === 'overdue'
              ? 'bg-red-600 text-white border-red-700'
              : 'bg-red-50 text-red-700 border-red-200 hover:bg-red-100'
          }`}
          disabled={summary.overdue === 0}
          title="Active quotes whose job date has passed"
        >
          {summary.overdue} overdue
        </button>
        <button
          onClick={() => setDateWindow(dateWindow === 'today_tomorrow' ? 'all' : 'today_tomorrow')}
          className={`text-xs px-3 py-1.5 rounded-full border font-medium transition-colors ${
            dateWindow === 'today_tomorrow'
              ? 'bg-blue-600 text-white border-blue-700'
              : 'bg-blue-50 text-blue-700 border-blue-200 hover:bg-blue-100'
          }`}
          title="Any job with today's date"
        >
          {summary.todayCount} today
        </button>
        <button
          onClick={() => setDateWindow(dateWindow === 'this_week' ? 'all' : 'this_week')}
          className={`text-xs px-3 py-1.5 rounded-full border font-medium transition-colors ${
            dateWindow === 'this_week'
              ? 'bg-purple-600 text-white border-purple-700'
              : 'bg-purple-50 text-purple-700 border-purple-200 hover:bg-purple-100'
          }`}
          title="Active quotes with a job date this ISO week"
        >
          {summary.thisWeek} this week
        </button>
        <button
          onClick={() => setNeedsCrewOnly(!needsCrewOnly)}
          className={`text-xs px-3 py-1.5 rounded-full border font-medium transition-colors ${
            needsCrewOnly
              ? 'bg-amber-600 text-white border-amber-700'
              : 'bg-amber-50 text-amber-700 border-amber-200 hover:bg-amber-100'
          }`}
          title="Quotes with no crew assigned"
        >
          {summary.needsCrew} needing crew
        </button>
        <button
          onClick={() => setNeedsIntroOnly(!needsIntroOnly)}
          className={`text-xs px-3 py-1.5 rounded-full border font-medium transition-colors ${
            needsIntroOnly
              ? 'bg-blue-600 text-white border-blue-700'
              : 'bg-blue-50 text-blue-700 border-blue-200 hover:bg-blue-100'
          }`}
          title="Quotes whose client introduction is 'to do' or 'working on it'"
        >
          {summary.needsIntro} needing client intro
        </button>
      </div>

      {/* Filter bar — search + date window pills + sort */}
      <div className="flex flex-col lg:flex-row gap-3 bg-white rounded-lg border border-gray-200 p-3">
        {/* Search */}
        <div className="relative flex-1 min-w-[240px]">
          <input
            type="search"
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            placeholder="Search HH#, client, venue, driver…"
            className="w-full border border-gray-300 rounded-lg px-3 py-1.5 pr-8 text-sm focus:ring-1 focus:ring-ooosh-500 focus:border-ooosh-500"
          />
          {searchTerm && (
            <button
              onClick={() => setSearchTerm('')}
              className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-700"
              title="Clear search"
              aria-label="Clear search"
            >
              &times;
            </button>
          )}
        </div>

        {/* Date window pills */}
        <div className="flex rounded-lg border border-gray-300 overflow-hidden text-sm flex-wrap">
          {([
            ['all', 'All dates'],
            ['overdue', 'Overdue'],
            ['today_tomorrow', 'Today & tomorrow'],
            ['this_week', 'This week'],
            ['next_week', 'Next week'],
            ['upcoming', 'All upcoming'],
          ] as const).map(([key, label]) => (
            <button
              key={key}
              onClick={() => setDateWindow(key)}
              className={`px-3 py-1.5 border-r border-gray-300 last:border-r-0 ${
                dateWindow === key ? 'bg-ooosh-600 text-white' : 'bg-white text-gray-700 hover:bg-gray-50'
              }`}
            >
              {label}
            </button>
          ))}
        </div>

        {/* Sort */}
        <div className="flex items-center gap-2 text-sm">
          <label className="text-gray-500">Sort</label>
          <select
            value={sortBy}
            onChange={(e) => setSortBy(e.target.value as SortKey)}
            className="border border-gray-300 rounded-lg px-2 py-1.5 text-sm bg-white"
          >
            <option value="date">Date</option>
            <option value="client">Client</option>
            <option value="freelancer">Freelancer</option>
            <option value="status">Status</option>
          </select>
        </div>
      </div>

      {/* Active-pin banners — person / venue pinned by clicking a name in a row */}
      {(personPin || venuePin) && (
        <div className="flex flex-wrap gap-2">
          {personPin && (
            <div className="inline-flex items-center gap-2 bg-ooosh-50 border border-ooosh-200 rounded-full px-3 py-1 text-xs text-ooosh-700">
              <span className="font-medium">Driver:</span> {personPin.name}
              <button
                onClick={() => setPersonPin(null)}
                className="text-ooosh-500 hover:text-ooosh-800"
                aria-label="Clear driver filter"
              >&times;</button>
            </div>
          )}
          {venuePin && (
            <div className="inline-flex items-center gap-2 bg-teal-50 border border-teal-200 rounded-full px-3 py-1 text-xs text-teal-700">
              <span className="font-medium">Venue:</span> {venuePin.name}
              <button
                onClick={() => setVenuePin(null)}
                className="text-teal-500 hover:text-teal-800"
                aria-label="Clear venue filter"
              >&times;</button>
            </div>
          )}
        </div>
      )}

      {needsCrewOnly && (
        <div className="bg-amber-50 border border-amber-200 rounded-lg p-3 text-sm text-amber-800 flex items-center justify-between">
          <span>Showing quotes without crew assigned.</span>
          <button
            onClick={() => setNeedsCrewOnly(false)}
            className="text-amber-700 hover:text-amber-900 font-medium"
          >
            Clear filter &times;
          </button>
        </div>
      )}

      {needsIntroOnly && (
        <div className="bg-blue-50 border border-blue-200 rounded-lg p-3 text-sm text-blue-800 flex items-center justify-between">
          <span>Showing quotes where the client introduction is still to-do or working-on-it.</span>
          <button
            onClick={() => setNeedsIntroOnly(false)}
            className="text-blue-700 hover:text-blue-900 font-medium"
          >
            Clear filter &times;
          </button>
        </div>
      )}

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
            // Section keys are namespaced per render bucket so that
            // collapsing "todo" inside Operational doesn't also collapse
            // the operational table when toggled from elsewhere.
            const key = `op:${status}`;
            const isCollapsed = collapsedSections.has(key);

            return (
              <div key={status} className="bg-white rounded-lg shadow-sm border border-gray-200 overflow-hidden">
                {/* Section header — click to collapse */}
                <button
                  type="button"
                  onClick={() => toggleSection(key)}
                  className={`w-full px-4 py-2.5 border-b border-gray-200 flex items-center justify-between text-left ${config.bgColour}`}
                  aria-expanded={!isCollapsed}
                >
                  <div className="flex items-center gap-2">
                    <span className={`text-xs ${config.colour}`} aria-hidden="true">
                      {isCollapsed ? '▸' : '▾'}
                    </span>
                    <h2 className={`font-semibold text-sm ${config.colour}`}>{config.label}</h2>
                    <span className={`text-xs px-1.5 py-0.5 rounded-full ${config.bgColour} ${config.colour} font-medium`}>
                      {items.length}
                    </span>
                  </div>
                </button>

                {!isCollapsed && (
                  items.length === 0 ? (
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
                          onUpdateRunCombinedFee={updateRunCombinedFee}
                          onPinPerson={(id, name) => setPersonPin({ id, name })}
                          onPinVenue={(name) => setVenuePin({ name })}
                          allQuotes={quotes}
                        />
                      ))}
                    </div>
                  )
                )}
              </div>
            );
          })}

          {/* Speculative sections — heads-up planning, off by default. Each
              one shows quotes whose linked job is in a non-operational
              pipeline stage. The flat date-sorted list is intentional: the
              ops_status sub-grouping only matters for confirmed work. */}
          {speculativeSections.map(({ bucket, quotes: bucketQuotes }) => {
            const config = JOB_BUCKET_CONFIG[bucket];
            const key = `spec:${bucket}`;
            const isCollapsed = collapsedSections.has(key);
            return (
              <div
                key={bucket}
                className={`bg-white rounded-lg shadow-sm border ${config.badge.includes('border-') ? '' : 'border-gray-200'} overflow-hidden`}
              >
                <button
                  type="button"
                  onClick={() => toggleSection(key)}
                  className={`w-full px-4 py-2.5 border-b border-gray-200 flex items-center justify-between text-left ${config.badge}`}
                  aria-expanded={!isCollapsed}
                >
                  <div className="flex items-center gap-2">
                    <span className="text-xs" aria-hidden="true">
                      {isCollapsed ? '▸' : '▾'}
                    </span>
                    <h2 className="font-semibold text-sm">{config.label}</h2>
                    <span className="text-xs px-1.5 py-0.5 rounded-full bg-white/70 font-medium">
                      {bucketQuotes.length}
                    </span>
                    <span className="text-xs font-normal opacity-75 hidden sm:inline">
                      — {config.description}
                    </span>
                  </div>
                </button>

                {!isCollapsed && (
                  bucketQuotes.length === 0 ? (
                    <div className="px-4 py-6 text-center text-sm text-gray-400">No items</div>
                  ) : (
                    <div className="divide-y divide-gray-100">
                      {bucketQuotes.map((q) => (
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
                          onUpdateRunCombinedFee={updateRunCombinedFee}
                          onPinPerson={(id, name) => setPersonPin({ id, name })}
                          onPinVenue={(name) => setVenuePin({ name })}
                          allQuotes={quotes}
                        />
                      ))}
                    </div>
                  )
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
          onUpdateRunCombinedFee={updateRunCombinedFee}
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

      {/* Complete Quote Override Modal */}
      {completingQuote && (
        <CompleteQuoteOverrideModal
          quoteId={completingQuote.id}
          assignees={(completingQuote.assignments || [])
            .filter((a): a is Assignment & { person_id: string } => !!a.person_id)
            .map((a) => ({
              id: a.person_id,
              name: a.is_ooosh_crew
                ? 'Ooosh Staff'
                : `${a.first_name || ''} ${a.last_name || ''}`.trim() || 'Assigned crew',
              is_ooosh_crew: a.is_ooosh_crew === true,
            }))}
          onClose={() => setCompletingQuote(null)}
          onCompleted={() => {
            setCompletingQuote(null);
            loadOps();
          }}
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
  onUpdateRunCombinedFee,
  onPinPerson,
  onPinVenue,
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
  onUpdateRunCombinedFee: (runGroupId: string, fields: { combined_freelancer_fee?: number | null; combined_client_fee?: number | null; notes?: string | null }) => Promise<void>;
  onPinPerson: (personId: string, name: string) => void;
  onPinVenue: (name: string) => void;
  allQuotes: OpsQuote[];
}) {
  const assignments = Array.isArray(q.assignments) ? q.assignments : [];

  // Overdue = active quote whose job date has passed (calendar-day).
  // Takes priority over run-group border colour so the red flag is visible.
  // daysOverdue powers the "Xd overdue" badge — undefined when not overdue.
  const { isOverdue, daysOverdue } = (() => {
    if (q.ops_status === 'completed' || q.ops_status === 'cancelled') return { isOverdue: false, daysOverdue: undefined };
    if (!q.job_date) return { isOverdue: false, daysOverdue: undefined };
    const d = q.job_date instanceof Date ? new Date(q.job_date) : new Date(q.job_date);
    if (Number.isNaN(d.getTime())) return { isOverdue: false, daysOverdue: undefined };
    d.setHours(0, 0, 0, 0);
    const today = new Date(); today.setHours(0, 0, 0, 0);
    if (d >= today) return { isOverdue: false, daysOverdue: undefined };
    const days = Math.round((today.getTime() - d.getTime()) / 86400000);
    return { isOverdue: true, daysOverdue: days };
  })();

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

  const venueName = q.linked_venue_name || q.venue_name || '';

  // Left-border precedence: overdue > run group > none.
  const leftBorderClass = isOverdue
    ? 'border-l-4 border-l-red-500'
    : runInfo
      ? `border-l-4 ${RUN_PILL_STYLES[runInfo.colourIdx].border}`
      : '';

  return (
    <div>
      <div
        className={`px-4 py-3 flex items-center gap-3 hover:bg-gray-50 cursor-pointer transition-colors ${leftBorderClass}`}
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
            {venueName ? (
              <>
                <button
                  type="button"
                  onClick={(e) => { e.stopPropagation(); onEdit(q); }}
                  className="text-sm font-medium text-gray-900 truncate hover:text-ooosh-600 hover:underline text-left"
                  title="Edit venue / quote details"
                >
                  {venueName}
                </button>
                <button
                  type="button"
                  onClick={(e) => { e.stopPropagation(); onPinVenue(venueName); }}
                  className="flex-shrink-0 text-gray-400 hover:text-ooosh-600"
                  title={`Show all quotes for ${venueName}`}
                  aria-label="Pin venue filter"
                >
                  <svg className="w-3.5 h-3.5" fill="currentColor" viewBox="0 0 20 20">
                    <path fillRule="evenodd" d="M5.05 4.05a7 7 0 119.9 9.9L10 18.9l-4.95-4.95a7 7 0 010-9.9zM10 11a2 2 0 100-4 2 2 0 000 4z" clipRule="evenodd" />
                  </svg>
                </button>
              </>
            ) : (
              <button
                type="button"
                onClick={(e) => { e.stopPropagation(); onEdit(q); }}
                className="text-sm font-medium text-red-500 truncate hover:text-red-700 hover:underline text-left"
                title="Click to link a venue"
              >
                No venue — click to add
              </button>
            )}
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
            {isOverdue && (
              <span className="text-xs px-1.5 py-0.5 rounded bg-red-100 text-red-700 font-semibold flex-shrink-0">
                {daysOverdue ? `${daysOverdue}d overdue` : 'Overdue'}
              </span>
            )}
          </div>
          <div className="text-xs text-gray-500 truncate">
            {q.client_name || q.job_name || ''}
          </div>
        </div>

        {/* Crew */}
        <div className="w-44 flex-shrink-0 hidden lg:block" onClick={(e) => e.stopPropagation()}>
          {assignments.length > 0 ? (
            <div className="text-sm text-gray-700">
              <div className="flex flex-wrap items-center gap-x-1 gap-y-0.5">
                {assignments.map((a, i) => {
                  const label = a.is_ooosh_crew
                    ? 'Ooosh Staff'
                    : `${a.first_name || ''} ${a.last_name || ''}`.trim() || 'Unknown';
                  // Ooosh Staff isn't pinnable — pinning would filter to "every
                  // job done by Ooosh", not useful. Render as plain text.
                  if (a.is_ooosh_crew || !a.person_id) {
                    return (
                      <span key={a.id} className="truncate">
                        {label}{i < assignments.length - 1 ? ',' : ''}
                      </span>
                    );
                  }
                  return (
                    <button
                      key={a.id}
                      type="button"
                      onClick={() => onPinPerson(a.person_id!, label)}
                      className="truncate hover:text-ooosh-600 hover:underline"
                      title={`Show all quotes for ${label}`}
                    >
                      {label}{i < assignments.length - 1 ? ',' : ''}
                    </button>
                  );
                })}
              </div>
              <div className="flex items-center gap-1.5">
                {(q.crew_count || 1) > 1 && (
                  <span className={`text-xs font-medium ${assignments.length >= (q.crew_count || 1) ? 'text-green-600' : 'text-amber-600'}`}>
                    {assignments.length}/{q.crew_count} assigned
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
        <div className="w-16 text-right flex-shrink-0 hidden md:block" title={
          q.run_group && q.run_combined_client_fee != null
            ? `Combined run charge (individual £${q.client_charge_rounded ?? 0})`
            : undefined
        }>
          {q.run_group && q.run_combined_client_fee != null ? (
            <span className="text-sm font-medium text-gray-700">
              £{Number(q.run_combined_client_fee).toFixed(0)}
              <span className="text-[9px] text-gray-400 ml-0.5">run</span>
            </span>
          ) : (
            <span className="text-sm font-medium text-gray-700">
              {q.client_charge_rounded ? `£${q.client_charge_rounded}` : '—'}
            </span>
          )}
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
          onUpdateRunCombinedFee={onUpdateRunCombinedFee}
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

// ── Completion image helpers ────────────────────────────────────────
// Photos/signature are stored either as a legacy data URL ("data:...")
// or an R2 key ("completion/..."). R2 keys are fetched authenticated
// and turned into blob URLs; data URLs render directly. Thumbnails open
// a lightbox with a download action.

function isDirectImageSrc(ref: string): boolean {
  return ref.startsWith('data:') || ref.startsWith('http://') || ref.startsWith('https://');
}

/**
 * Build a human-friendly download filename like "15746-2026-04-17-1.jpg"
 * or "15746-2026-04-17-signature.png". Falls back to quote-id snippet
 * and "unknown-date" if the quote has no HH job number or job date.
 */
function buildCompletionFilename(q: OpsQuote, which: 'signature' | number): string {
  const rawDate = q.completed_at
    || (q.job_date ? (q.job_date instanceof Date ? q.job_date.toISOString() : String(q.job_date)) : null);
  let datePart = 'unknown-date';
  if (rawDate) {
    const d = new Date(rawDate);
    if (!isNaN(d.getTime())) datePart = d.toISOString().slice(0, 10);
  }
  const jobPart = q.hh_job_number ? String(q.hh_job_number) : `quote-${q.id.slice(0, 8)}`;
  return which === 'signature'
    ? `${jobPart}-${datePart}-signature.png`
    : `${jobPart}-${datePart}-${which}.jpg`;
}

function useResolvedImageSrc(ref: string): { src: string | null; loading: boolean } {
  const [src, setSrc] = useState<string | null>(() => (isDirectImageSrc(ref) ? ref : null));
  const [loading, setLoading] = useState(!isDirectImageSrc(ref));

  useEffect(() => {
    if (isDirectImageSrc(ref)) {
      setSrc(ref);
      setLoading(false);
      return;
    }
    let cancelled = false;
    let objectUrl: string | null = null;
    setLoading(true);
    api.blob(`/files/download?key=${encodeURIComponent(ref)}`)
      .then(({ blob, contentType }) => {
        if (cancelled) return;
        objectUrl = URL.createObjectURL(new Blob([blob], { type: contentType }));
        setSrc(objectUrl);
        setLoading(false);
      })
      .catch((err) => {
        console.error('[CompletionImage] load failed:', ref, err);
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [ref]);

  return { src, loading };
}

function ImageLightbox({ src, filename, onClose }: { src: string; filename: string; onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return createPortal(
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/80 p-4"
      onClick={onClose}
    >
      <div className="relative max-h-full max-w-full" onClick={(e) => e.stopPropagation()}>
        <img
          src={src}
          alt={filename}
          className="max-h-[85vh] max-w-[90vw] object-contain rounded shadow-2xl bg-white"
        />
        <div className="absolute top-2 right-2 flex gap-2">
          <a
            href={src}
            download={filename}
            className="px-3 py-1.5 text-sm bg-white/95 hover:bg-white rounded shadow font-medium text-gray-800"
          >
            Download
          </a>
          <button
            type="button"
            onClick={onClose}
            className="px-3 py-1.5 text-sm bg-white/95 hover:bg-white rounded shadow font-medium text-gray-800"
          >
            Close
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
}

function CompletionImageThumb({ refString, alt, filename, thumbClassName }: {
  refString: string;
  alt: string;
  filename: string;
  thumbClassName?: string;
}) {
  const { src, loading } = useResolvedImageSrc(refString);
  const [open, setOpen] = useState(false);
  const cls = thumbClassName || 'h-20 w-20 object-cover rounded border border-gray-200 hover:border-ooosh-500 transition-colors';

  if (!src) {
    return (
      <div className={`${cls} flex items-center justify-center bg-gray-50 text-xs text-gray-400`}>
        {loading ? '…' : 'Load failed'}
      </div>
    );
  }
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="block focus:outline-none focus:ring-2 focus:ring-ooosh-500 rounded"
        title="Click to enlarge"
      >
        <img src={src} alt={alt} className={cls} />
      </button>
      {open && <ImageLightbox src={src} filename={filename} onClose={() => setOpen(false)} />}
    </>
  );
}

// Run combined fee editor — shown when a quote is part of a run.
// Inline-edit combined freelancer + client fees; displays the standalone
// sum alongside so staff can see what the run "would" cost individually.
// Individual quote freelancer_fee values are never touched.
function RunCombinedFeeEditor({
  runGroupId,
  currentCombinedFreelancerFee,
  currentCombinedClientFee,
  siblingQuotes,
  onUpdate,
}: {
  runGroupId: string;
  currentCombinedFreelancerFee: number | null;
  currentCombinedClientFee: number | null;
  siblingQuotes: OpsQuote[];
  onUpdate: (runGroupId: string, fields: { combined_freelancer_fee?: number | null; combined_client_fee?: number | null; notes?: string | null }) => Promise<void>;
}) {
  const [freelancerDraft, setFreelancerDraft] = useState<string>(
    currentCombinedFreelancerFee != null ? String(currentCombinedFreelancerFee) : ''
  );
  const [clientDraft, setClientDraft] = useState<string>(
    currentCombinedClientFee != null ? String(currentCombinedClientFee) : ''
  );
  const [saving, setSaving] = useState(false);

  // Standalone totals — sum of individual per-quote fees (read-only reference).
  const standaloneFreelancerTotal = siblingQuotes.reduce(
    (s, q) => s + Number(q.freelancer_fee_rounded ?? q.freelancer_fee ?? 0),
    0
  );
  const standaloneClientTotal = siblingQuotes.reduce(
    (s, q) => s + Number(q.client_charge_rounded ?? q.client_charge_total ?? 0),
    0
  );

  async function save(field: 'combined_freelancer_fee' | 'combined_client_fee', raw: string) {
    const trimmed = raw.trim();
    const value = trimmed === '' ? null : Number(trimmed);
    if (trimmed !== '' && Number.isNaN(value)) return;
    setSaving(true);
    try {
      await onUpdate(runGroupId, { [field]: value });
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="mt-2 pt-2 border-t border-dashed border-gray-200 space-y-1.5">
      <div className="flex items-center gap-2">
        <label className="text-xs text-gray-500 w-24">Combined freelancer fee</label>
        <div className="flex items-center gap-1">
          <span className="text-xs text-gray-400">£</span>
          <input
            type="number"
            min={0}
            step="0.01"
            value={freelancerDraft}
            onChange={(e) => setFreelancerDraft(e.target.value)}
            onBlur={(e) => save('combined_freelancer_fee', e.target.value)}
            placeholder={`sum: ${standaloneFreelancerTotal.toFixed(0)}`}
            disabled={saving}
            className="w-20 text-xs px-1.5 py-0.5 border border-gray-300 rounded focus:outline-none focus:ring-1 focus:ring-ooosh-500"
          />
        </div>
        <span className="text-xs text-gray-400">
          standalone: <span className="line-through">£{standaloneFreelancerTotal.toFixed(0)}</span>
        </span>
      </div>
      <div className="flex items-center gap-2">
        <label className="text-xs text-gray-500 w-24">Combined client charge</label>
        <div className="flex items-center gap-1">
          <span className="text-xs text-gray-400">£</span>
          <input
            type="number"
            min={0}
            step="0.01"
            value={clientDraft}
            onChange={(e) => setClientDraft(e.target.value)}
            onBlur={(e) => save('combined_client_fee', e.target.value)}
            placeholder={`sum: ${standaloneClientTotal.toFixed(0)}`}
            disabled={saving}
            className="w-20 text-xs px-1.5 py-0.5 border border-gray-300 rounded focus:outline-none focus:ring-1 focus:ring-ooosh-500"
          />
        </div>
        <span className="text-xs text-gray-400">
          standalone: <span className="line-through">£{standaloneClientTotal.toFixed(0)}</span>
        </span>
      </div>
      <p className="text-[10px] text-gray-400 italic">
        Combined fee overrides the sum. Leave blank to fall back to the standalone total. Individual quote prices are preserved.
      </p>
    </div>
  );
}

function ExpandedDetail({
  q,
  assignments,
  onAssign,
  onRemoveAssignment,
  onUpdateDetails,
  onEdit,
  onUpdateRunGroup,
  onUpdateRunCombinedFee,
  allQuotes,
}: {
  q: OpsQuote;
  assignments: Assignment[];
  onAssign: (quoteId: string) => void;
  onRemoveAssignment: (quoteId: string, assignmentId: string) => void;
  onUpdateDetails: (quoteId: string, fields: Record<string, unknown>) => Promise<void>;
  onEdit: (quote: OpsQuote) => void;
  onUpdateRunGroup: (quoteId: string, runGroup: string | null, runOrder: number | null) => Promise<void>;
  onUpdateRunCombinedFee: (runGroupId: string, fields: { combined_freelancer_fee?: number | null; combined_client_fee?: number | null; notes?: string | null }) => Promise<void>;
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
          {q.is_multi_day && q.job_date && q.job_finish_date && (
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

              {q.run_group && (
                <RunCombinedFeeEditor
                  runGroupId={q.run_group}
                  currentCombinedFreelancerFee={q.run_combined_freelancer_fee}
                  currentCombinedClientFee={q.run_combined_client_fee}
                  siblingQuotes={allQuotes.filter((s) => s.run_group === q.run_group)}
                  onUpdate={onUpdateRunCombinedFee}
                />
              )}
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
                    {a.is_ooosh_crew ? 'Ooosh Staff' : `${a.first_name} ${a.last_name}`}
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
              {q.run_group && q.run_combined_client_fee != null ? (
                <span className="font-medium">
                  <span className="line-through text-gray-400 mr-1">£{q.client_charge_rounded ?? 0}</span>
                  £{Number(q.run_combined_client_fee).toFixed(0)}
                  <span className="ml-1 text-[10px] text-gray-400">(run)</span>
                </span>
              ) : (
                <span className="font-medium">{q.client_charge_rounded ? `£${q.client_charge_rounded}` : '—'}</span>
              )}
            </div>
            <div className="flex justify-between text-xs">
              <span className="text-gray-500">Freelancer cost</span>
              {q.run_group && q.run_combined_freelancer_fee != null ? (
                <span className="font-medium">
                  <span className="line-through text-gray-400 mr-1">£{q.freelancer_fee_rounded ?? 0}</span>
                  £{Number(q.run_combined_freelancer_fee).toFixed(0)}
                  <span className="ml-1 text-[10px] text-gray-400">(run)</span>
                </span>
              ) : (
                <span className="font-medium">{q.freelancer_fee_rounded ? `£${q.freelancer_fee_rounded}` : '—'}</span>
              )}
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
                    <CompletionImageThumb
                      refString={q.completion_signature}
                      alt="Signature"
                      filename={buildCompletionFilename(q, 'signature')}
                      thumbClassName="h-16 max-w-[200px] object-contain cursor-zoom-in"
                    />
                  </div>
                </div>
              )}
              {/* Photos */}
              {q.completion_photos && q.completion_photos.length > 0 && (
                <div>
                  <span className="text-gray-500">Photos ({q.completion_photos.length}):</span>
                  <div className="mt-1 flex flex-wrap gap-2">
                    {q.completion_photos.map((photo, idx) => (
                      <CompletionImageThumb
                        key={idx}
                        refString={photo}
                        alt={`Completion photo ${idx + 1}`}
                        filename={buildCompletionFilename(q, idx + 1)}
                      />
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
  const [selectedVenueId, setSelectedVenueId] = useState<string | null>(quote.venue_id || null);

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
            <VenuePicker
              value={{ venueId: selectedVenueId, venueName: form.venue_name }}
              onChange={({ venueId, venueName }) => {
                setSelectedVenueId(venueId);
                setForm((p) => ({ ...p, venue_name: venueName }));
              }}
            />
          </div>

          {/* Date & Time row */}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">{form.is_multi_day ? 'Start Date' : 'Date'}</label>
              <DatePicker
                value={form.job_date}
                onChange={(val) => setForm((p) => ({ ...p, job_date: val }))}
                className={quote.out_date && form.job_date && form.job_date !== parseDateField(quote.out_date) ? '[&>button]:border-amber-400 [&>button]:bg-amber-50' : ''}
              />
              {quote.out_date && form.job_date && form.job_date !== parseDateField(quote.out_date) && (
                <p className="text-xs text-amber-600 mt-1">
                  HH start: {parseDateField(quote.out_date)}
                </p>
              )}
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
          <div className="flex items-center gap-3 flex-wrap">
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
                  <DatePicker
                    value={form.job_finish_date}
                    onChange={(val) => {
                      const days = form.job_date && val
                        ? Math.max(1, Math.ceil((new Date(val + 'T00:00:00').getTime() - new Date(form.job_date + 'T00:00:00').getTime()) / 86400000) + 1)
                        : form.num_days;
                      setForm((p) => ({ ...p, job_finish_date: val, num_days: days }));
                    }}
                    min={form.job_date || undefined}
                    className={quote.return_date && form.job_finish_date && form.job_finish_date !== parseDateField(quote.return_date) ? '[&>button]:border-amber-400 [&>button]:bg-amber-50' : ''}
                  />
                </div>
                <span className="text-xs text-purple-600 font-medium">{form.num_days} days</span>
              </>
            )}
          </div>
          {form.is_multi_day && quote.return_date && form.job_finish_date && form.job_finish_date !== parseDateField(quote.return_date) && (
            <p className="text-xs text-amber-600 -mt-2">
              HH return: {parseDateField(quote.return_date)}
            </p>
          )}

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
  onUpdateRunCombinedFee,
}: {
  data: Record<string, OpsQuote[]>;
  allQuotes: OpsQuote[];
  onStatusChange: (id: string, status: string) => void;
  onAssign: (quoteId: string) => void;
  onRemoveAssignment: (quoteId: string, assignmentId: string) => void;
  onUpdateDetails: (quoteId: string, fields: Record<string, unknown>) => Promise<void>;
  onEdit: (quote: OpsQuote) => void;
  onUpdateRunGroup: (quoteId: string, runGroup: string | null, runOrder: number | null) => Promise<void>;
  onUpdateRunCombinedFee: (runGroupId: string, fields: { combined_freelancer_fee?: number | null; combined_client_fee?: number | null; notes?: string | null }) => Promise<void>;
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
            onUpdateRunCombinedFee={onUpdateRunCombinedFee}
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
                            {assignments.map(a => a.is_ooosh_crew ? 'Ooosh Staff' : `${a.first_name || ''} ${a.last_name || ''}`.trim()).join(', ')}
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
