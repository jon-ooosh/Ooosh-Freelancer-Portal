/**
 * Returns & Completed — the place where things go to get finished up,
 * then live as a record for future queries.
 *
 * Replaces the previous bare-bones Returns page. Server-side everything:
 * search, status filter, type filter, date range, overdue toggle,
 * pagination with jump-to-page. Per-job retro pill.
 *
 * Nov 2026 tidy-up: the same table as Upcoming & Out (JobsPage), so the two
 * lists read alike, with the job's post-hire close-out cards as a pip strip
 * (the dashboard's strip, `components/dashboard/v2`) instead of a bare "3/4"
 * bar. The Returned tab is grouped by NEXT STEP — to invoice, invoice to send,
 * waiting on payment, other things to finish, ready to complete — and a
 * "Waiting on" filter finds jobs with any one card still open. Filter and
 * pips come from one mapping (backend `services/job-progress-strip.ts`), so
 * they can't disagree.
 */
import { useState, useEffect, useCallback, useRef } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { api } from '../services/api';
import { MobileListCard } from '../components/mobile/MobileListCard';
import { MobileFilterSheet } from '../components/mobile/MobileFilterSheet';
import { jobDisplayOrgNameOr } from '../lib/jobOrgName';
import { getStatusBadge } from '../lib/jobStatusBadge';
import { ukDateOf, ukToday } from '../lib/ukDate';
import { ProgressStrip } from '../components/dashboard/v2/primitives';
import { STRIP_LABELS, STRIP_ORDER } from '../components/dashboard/v2/progress-strip';
import type { JobProgressStrip } from '../components/dashboard/v2/progress-strip';

const RATING_COLOURS: Record<string, string> = {
  great: 'bg-green-100 text-green-700',
  ok: 'bg-amber-100 text-amber-700',
  issues: 'bg-red-100 text-red-700',
};

const RATING_LABEL: Record<string, string> = {
  great: 'Great',
  ok: 'OK',
  issues: 'Issues',
};

interface Job {
  id: string;
  hh_job_number: number;
  job_name: string | null;
  status: number;
  status_name: string | null;
  pipeline_status: string | null;
  client_name: string | null;
  company_name: string | null;
  // Canonical org names from the API (see lib/jobOrgName.ts). Render via
  // jobDisplayOrgNameOr(job), never the raw client_name/company_name strings.
  client_org_name?: string | null;
  lead_org_name?: string | null;
  venue_name: string | null;
  job_date: string | null;
  job_end: string | null;
  out_date: string | null;
  return_date: string | null;
  manager1_name: string | null;
  job_value: number | null;
  // Cached inc-VAT hire value (job_financials) — preferred, as on JobsPage.
  hire_value_inc_vat?: number | null;
  is_internal?: boolean | null;
}

interface RetroSnippet { rating: string; notes: string; created_at: string }

type StatusFilter = 'all' | 'returned' | 'completed';
type TypeFilter = 'vehicle' | 'backline' | 'rehearsal';
// Sortable columns (Nov 2026) — click a header to sort, click again to flip.
// Each maps to a server sort key per direction (routes/hirehop.ts
// `allowedSorts`); Dates sorts by the due-back date, so its "ascending" is the
// long-standing 'overdue' (oldest due back first).
type SortColumn = 'job' | 'name' | 'client' | 'status' | 'dates' | 'value' | 'manager';
const COLUMN_SORTS: Record<SortColumn, { asc: string; desc: string; label: string; ascLabel: string; descLabel: string }> = {
  job:     { asc: 'job_asc',     desc: 'job_desc',     label: 'Job #',   ascLabel: 'lowest first',       descLabel: 'highest first' },
  name:    { asc: 'name_asc',    desc: 'name_desc',    label: 'Name',    ascLabel: 'A–Z',                descLabel: 'Z–A' },
  client:  { asc: 'client_asc',  desc: 'client_desc',  label: 'Client',  ascLabel: 'A–Z',                descLabel: 'Z–A' },
  status:  { asc: 'status_asc',  desc: 'status_desc',  label: 'Status',  ascLabel: 'returned first',     descLabel: 'completed first' },
  dates:   { asc: 'overdue',     desc: 'return_desc',  label: 'Due back', ascLabel: 'oldest first',      descLabel: 'newest first' },
  value:   { asc: 'value_asc',   desc: 'value_desc',   label: 'Value',   ascLabel: 'lowest first',       descLabel: 'highest first' },
  manager: { asc: 'manager_asc', desc: 'manager_desc', label: 'Manager', ascLabel: 'A–Z',                descLabel: 'Z–A' },
};
type SortKey = string;
type RetroFilter = 'all' | 'has_retro' | 'no_retro';

// Every sort, for the phone's Sort select (no headers to click there) and for
// checking a sort read from the URL. 'job_date_desc' is an older key a saved
// link may still carry ('return_asc' is read as 'overdue' — the same order).
const SORT_OPTIONS: { key: SortKey; label: string }[] = [
  ...Object.values(COLUMN_SORTS).flatMap(c => [
    { key: c.asc, label: `${c.label} — ${c.ascLabel}` },
    { key: c.desc, label: `${c.label} — ${c.descLabel}` },
  ]),
  { key: 'job_date_desc', label: 'Job date — newest' },
];

/** Jobs before this were never closed out in OP — hidden unless "Include pre-OP" is ticked. */
const PRE_OP_CUTOFF = '2026-03-01';

// Tab order — "Returned (needs completing)" first because that's where staff
// spend their time working through close-outs. Completed second (recent
// finished jobs), All last as a fallback.
const STATUS_PILLS: { key: StatusFilter; label: string; statusCsv: string }[] = [
  { key: 'returned',  label: 'Returned (needs completing)', statusCsv: '6,7,8' },
  { key: 'completed', label: 'Completed',                   statusCsv: '11' },
  { key: 'all',       label: 'All',                         statusCsv: '6,7,8,11' },
];

// "Waiting on" — the backend's `closeout` filter (routes/hirehop.ts). The
// slot keys are the progress strip's; invoice_raise / invoice_send split the
// Invoice card (no invoice yet vs raised but not sent); ready = nothing open.
const WAITING_ON_OPTIONS: { key: string; label: string }[] = [
  { key: '',              label: 'Anything' },
  { key: 'invoice_raise', label: 'Invoice to raise' },
  { key: 'invoice_send',  label: 'Invoice to send' },
  { key: 'payment',       label: 'Payment' },
  { key: 'excess',        label: 'Excess' },
  { key: 'recharges',     label: 'Recharges' },
  { key: 'client',        label: 'Client follow-up' },
  { key: 'freelancer',    label: 'Freelancer follow-up' },
  { key: 'vehicle',       label: 'Vehicle' },
  { key: 'deprep',        label: 'De-prep' },
  { key: 'merch',         label: 'Merch' },
  { key: 'ready',         label: 'Nothing — ready to complete' },
];
const WAITING_ON_KEYS = new Set(WAITING_ON_OPTIONS.map(o => o.key));

// The Returned tab's sections, in the order the work happens.
type Stage = 'to_invoice' | 'to_send' | 'payment' | 'other' | 'ready';
const STAGES: { key: Stage; title: string; border: string; dot: string }[] = [
  { key: 'to_invoice', title: 'To invoice',             border: 'border-amber-200 border-l-amber-500',     dot: 'bg-amber-500' },
  { key: 'to_send',    title: 'Invoice to send',        border: 'border-blue-200 border-l-blue-500',       dot: 'bg-blue-500' },
  { key: 'payment',    title: 'Waiting on payment',     border: 'border-indigo-200 border-l-indigo-500',   dot: 'bg-indigo-500' },
  { key: 'other',      title: 'Other things to finish', border: 'border-gray-200 border-l-gray-400',       dot: 'bg-gray-400' },
  { key: 'ready',      title: 'Ready to complete',      border: 'border-emerald-200 border-l-emerald-500', dot: 'bg-emerald-500' },
];

// The Returned tab loads the whole worklist in one go so its sections are
// whole (never split one page of a paged list into buckets — CLAUDE.md
// "LIMIT lesson"). 200 is also the most the strip endpoint answers for.
const RETURNED_LIMIT = 200;
const PAGE_LIMIT = 50;

/** The job's next step, from its post-hire strip. No cards yet = "other". */
function stageOf(strip: JobProgressStrip | undefined): Stage {
  const present = strip ? STRIP_ORDER.filter(c => strip[c] !== undefined) : [];
  if (!strip || present.length === 0) return 'other';
  if (strip.invoicing === 'todo' || strip.invoicing === 'prob') return 'to_invoice';
  if (strip.invoicing === 'wip') return 'to_send';
  if (strip.payment !== undefined && strip.payment !== 'done') return 'payment';
  if (present.some(c => strip[c] !== 'done')) return 'other';
  return 'ready';
}

/** Whole UK calendar days since a date (yesterday = 1), or null if unreadable. */
function daysSince(dateStr: string | null): number | null {
  if (!dateStr) return null;
  const d = new Date(dateStr);
  if (Number.isNaN(d.getTime())) return null;
  const then = Date.parse(`${ukDateOf(d)}T00:00:00Z`);
  const today = Date.parse(`${ukToday()}T00:00:00Z`);
  return Math.round((today - then) / 86400000);
}

function formatDateRange(start: string | null, end: string | null): string {
  const fmt = (s: string) => {
    const d = new Date(s);
    return Number.isNaN(d.getTime())
      ? '—'
      : d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'Europe/London' });
  };
  if (start && end && start !== end) return `${fmt(start)} – ${fmt(end)}`;
  if (start) return fmt(start);
  return '—';
}

function formatCurrency(value: number | null | undefined): string {
  if (value == null) return '';
  const n = typeof value === 'number' ? value : parseFloat(String(value));
  if (isNaN(n) || n <= 0) return '';
  return `£${n.toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

// return_date is when the hire was DUE back (HireHop's return date), not when
// it was checked in — so the wording says so.
function returnedLabel(days: number): string {
  if (days <= 0) return 'Due back today';
  return `Due back ${days} day${days === 1 ? '' : 's'} ago`;
}

export default function ReturnsPage() {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const initialOverdue = searchParams.get('overdue') === '1';
  const initialStatusParam = searchParams.get('status_filter');
  const initialStatus: StatusFilter =
    initialStatusParam === 'completed' || initialStatusParam === 'all' ? initialStatusParam : 'returned';
  const initialWaiting = searchParams.get('waiting') || '';

  const [jobs, setJobs] = useState<Job[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState(searchParams.get('search') || '');
  const [statusFilter, setStatusFilter] = useState<StatusFilter>(initialStatus);
  const [typeFilter, setTypeFilter] = useState<TypeFilter[]>([]);
  const [dateFrom, setDateFrom] = useState(searchParams.get('date_from') || '');
  const [dateTo, setDateTo] = useState(searchParams.get('date_to') || '');
  const [overdueOnly, setOverdueOnly] = useState(initialOverdue);
  const [hasIssuesOnly, setHasIssuesOnly] = useState(searchParams.get('has_issues') === '1');
  const [waitingOn, setWaitingOn] = useState(WAITING_ON_KEYS.has(initialWaiting) ? initialWaiting : '');
  const initialRetro = searchParams.get('retro');
  const [retroFilter, setRetroFilter] = useState<RetroFilter>(
    initialRetro === 'has_retro' || initialRetro === 'no_retro' ? initialRetro : 'all'
  );
  // Default sort: "Most overdue first" on Returned tab (where you live when
  // working through close-outs), "Return date newest" on Completed (newest
  // finished jobs at the top). All tab defaults to overdue too.
  // A sort read from the URL is checked against the list — an unknown value
  // would leave the select blank (frontend rules: validate stored values).
  const initialSortParam = searchParams.get('sort');
  const initialSort = initialSortParam === 'return_asc' ? 'overdue' : initialSortParam;
  const [sort, setSort] = useState<SortKey>(
    SORT_OPTIONS.some(o => o.key === initialSort)
      ? (initialSort as SortKey)
      : (initialStatus === 'completed' ? 'return_desc' : 'overdue')
  );
  // Pre-OP and internal jobs are hidden unless asked for (Nov 2026): almost all
  // are clutter — pre-OP ones were never closed out here, internal ones rarely
  // have anything to do after the hire.
  const [includePreOp, setIncludePreOp] = useState(searchParams.get('pre_op') === '1');
  const [includeInternal, setIncludeInternal] = useState(searchParams.get('internal') === '1');
  const [page, setPage] = useState(parseInt(searchParams.get('page') || '1', 10));
  const [totalPages, setTotalPages] = useState(1);
  const [total, setTotal] = useState(0);
  const [pageInput, setPageInput] = useState('');
  const [mobileFilterOpen, setMobileFilterOpen] = useState(false);

  const [strips, setStrips] = useState<Record<string, JobProgressStrip>>({});
  const [retros, setRetros] = useState<Record<string, RetroSnippet>>({});

  // Only the newest load may write — a slow reply for old filters must not
  // overwrite the list for the new ones.
  const loadSeq = useRef(0);

  const grouped = statusFilter === 'returned';
  const limit = grouped ? RETURNED_LIMIT : PAGE_LIMIT;

  const loadJobs = useCallback(async () => {
    const seq = ++loadSeq.current;
    setLoading(true);
    try {
      const params = new URLSearchParams();
      const statusCsv = STATUS_PILLS.find(p => p.key === statusFilter)?.statusCsv || '6,7,8,11';
      params.set('status', statusCsv);
      params.set('page', String(page));
      params.set('limit', String(limit));
      params.set('date_field', 'return_date');
      // Exclude mid-hire partial returns (HH status 6 but not yet due back —
      // an element returned early while the rest stays out). Those belong in
      // Out Now, not Returns. See CLAUDE.md → "status-6 no man's land".
      params.set('genuinely_returning', '1');
      if (search.trim()) params.set('search', search.trim());
      if (typeFilter.length > 0) params.set('service_type', typeFilter.join(','));
      if (dateFrom) params.set('date_from', dateFrom);
      if (dateTo) params.set('date_to', dateTo);
      if (hasIssuesOnly) params.set('has_issues', '1');
      if (waitingOn) params.set('closeout', waitingOn);
      if (retroFilter === 'has_retro') params.set('has_retro', '1');
      else if (retroFilter === 'no_retro') params.set('has_retro', '0');
      // Overdue is server-side so it composes with pagination + the "All"
      // status pill. Was previously a client-side post-filter, which broke
      // when the first page filled with completed jobs (which then got
      // filtered out, yielding an empty page).
      if (overdueOnly) params.set('overdue', '1');
      if (!includePreOp) params.set('exclude_before', PRE_OP_CUTOFF);
      if (!includeInternal) params.set('internal', 'exclude');
      params.set('sort', sort);

      const res = await api.get<{ data: Job[]; pagination: { totalPages: number; total: number } }>(
        `/hirehop/jobs?${params.toString()}`
      );
      // The strips decide the Returned tab's sections, so they arrive with the
      // list rather than after it (no rows jumping between sections).
      let nextStrips: Record<string, JobProgressStrip> = {};
      if (res.data.length > 0) {
        try {
          const sr = await api.post<{ data: Record<string, JobProgressStrip> }>('/dashboard/job-progress', {
            jobs: res.data.map(j => ({ id: j.id, phase: 'post_hire' })),
          });
          nextStrips = sr.data || {};
        } catch (err) {
          console.error('Failed to load close-out progress:', err);
        }
      }
      if (seq !== loadSeq.current) return;
      setJobs(res.data);
      setStrips(nextStrips);
      setTotalPages(res.pagination.totalPages);
      setTotal(res.pagination.total);
    } catch (err) {
      console.error('Failed to load returns:', err);
    } finally {
      if (seq === loadSeq.current) setLoading(false);
    }
  }, [statusFilter, typeFilter, dateFrom, dateTo, overdueOnly, hasIssuesOnly, waitingOn, retroFilter, includePreOp, includeInternal, sort, page, limit, search]);

  useEffect(() => { loadJobs(); }, [loadJobs]);

  // Sync filter state into URL so links survive a refresh / share.
  useEffect(() => {
    const next = new URLSearchParams();
    if (statusFilter !== 'returned') next.set('status_filter', statusFilter);
    if (search.trim()) next.set('search', search.trim());
    if (dateFrom) next.set('date_from', dateFrom);
    if (dateTo) next.set('date_to', dateTo);
    if (overdueOnly) next.set('overdue', '1');
    if (hasIssuesOnly) next.set('has_issues', '1');
    if (waitingOn) next.set('waiting', waitingOn);
    if (retroFilter !== 'all') next.set('retro', retroFilter);
    if (includePreOp) next.set('pre_op', '1');
    if (includeInternal) next.set('internal', '1');
    if (sort !== 'overdue') next.set('sort', sort);
    if (page > 1) next.set('page', String(page));
    setSearchParams(next, { replace: true });
  }, [statusFilter, search, dateFrom, dateTo, overdueOnly, hasIssuesOnly, waitingOn, retroFilter, includePreOp, includeInternal, sort, page, setSearchParams]);

  // Retros load after the list — a pill, not something the layout depends on.
  useEffect(() => {
    if (jobs.length === 0) { setRetros({}); return; }
    api.post<{ data: Record<string, RetroSnippet> }>('/hirehop/jobs/retros-bulk', { job_ids: jobs.map(j => j.id) })
      .then(res => setRetros(res.data))
      .catch(() => {});
  }, [jobs]);

  // Reset page when filters change so the user sees results from the start.
  useEffect(() => { setPage(1); }, [statusFilter, search, typeFilter, dateFrom, dateTo, overdueOnly, hasIssuesOnly, waitingOn, retroFilter, includePreOp, includeInternal, sort]);

  function clearFilters() {
    setSearch(''); setTypeFilter([]); setDateFrom(''); setDateTo('');
    setOverdueOnly(false); setHasIssuesOnly(false); setWaitingOn(''); setRetroFilter('all');
    setIncludePreOp(false); setIncludeInternal(false);
    setSort('overdue'); setStatusFilter('returned'); setPage(1);
  }

  /** Click a header: sort by it ascending, or flip it if it's already the sort. */
  function sortBy(col: SortColumn) {
    const c = COLUMN_SORTS[col];
    setSort(sort === c.asc ? c.desc : c.asc);
  }

  function jumpToPage() {
    const n = parseInt(pageInput, 10);
    if (Number.isFinite(n) && n >= 1 && n <= totalPages) {
      setPage(n); setPageInput('');
    }
  }

  function jobValue(job: Job): string {
    return formatCurrency(job.hire_value_inc_vat ?? job.job_value);
  }

  function StatusBadge({ job }: { job: Job }) {
    const badge = getStatusBadge(job);
    return badge.colour ? (
      <span
        className="inline-flex px-2 py-0.5 rounded-full text-xs font-medium whitespace-nowrap"
        style={{ backgroundColor: badge.colour + '20', color: badge.colour }}
      >
        {badge.label}
      </span>
    ) : (
      <span className={`inline-flex px-2 py-0.5 rounded-full text-xs font-medium whitespace-nowrap ${badge.fallbackClass}`}>
        {badge.label}
      </span>
    );
  }

  function RetroPill({ job }: { job: Job }) {
    const retro = retros[job.id];
    if (!retro) return null;
    return (
      <span
        className={`inline-flex px-2 py-0.5 rounded-full text-[10px] font-semibold ${RATING_COLOURS[retro.rating] || 'bg-gray-100 text-gray-600'}`}
        title={retro.notes ? `Retro: ${retro.notes}` : `Retro: ${RATING_LABEL[retro.rating] || retro.rating}`}
      >
        Retro: {RATING_LABEL[retro.rating] || retro.rating}
      </span>
    );
  }

  function CloseOut({ job }: { job: Job }) {
    const strip = strips[job.id];
    const present = strip ? STRIP_ORDER.filter(c => strip[c] !== undefined) : [];
    if (!strip || present.length === 0) {
      return <span className="text-xs text-gray-400 italic">No close-out cards yet</span>;
    }
    return (
      <div className="dash-v2">
        <ProgressStrip strip={strip} labels={STRIP_LABELS.post_hire} />
      </div>
    );
  }

  /** The "Due back n days ago" line under the dates — red after 5 days (not on Completed). */
  function ReturnedAge({ job }: { job: Job }) {
    if (job.status === 11) return null;
    const days = daysSince(job.return_date || job.job_end);
    if (days === null || days < 0) return null;
    const late = days > 5;
    return (
      <div className={`text-xs mt-0.5 ${late ? 'text-red-700 font-semibold' : 'text-gray-400'}`}>
        {late ? '⚠ ' : ''}{returnedLabel(days)}
      </div>
    );
  }

  function isLate(job: Job): boolean {
    if (job.status === 11) return false;
    const days = daysSince(job.return_date || job.job_end);
    return days !== null && days > 5;
  }

  function HhLink({ job, mobile = false }: { job: Job; mobile?: boolean }) {
    if (!job.hh_job_number) return <span className="font-mono text-gray-400">—</span>;
    return (
      <a
        href={`https://myhirehop.com/job.php?id=${job.hh_job_number}`}
        target="_blank"
        rel="noopener noreferrer"
        onClick={(e) => e.stopPropagation()}
        className={mobile
          ? 'font-mono text-xs px-1.5 py-0.5 rounded bg-ooosh-50 text-ooosh-700 hover:bg-ooosh-100'
          : 'font-mono text-ooosh-600 hover:text-ooosh-700 hover:underline'}
      >
        J-{job.hh_job_number}
      </a>
    );
  }

  function renderJobRow(job: Job) {
    const late = isLate(job);
    return (
      <tr
        key={job.id}
        onClick={() => navigate(`/jobs/${job.id}`)}
        className={`cursor-pointer transition-colors ${
          job.status === 8 || late ? 'bg-red-50 hover:bg-red-100' : 'hover:bg-gray-50'
        }`}
      >
        <td className="px-4 py-3 whitespace-nowrap text-sm align-top"><HhLink job={job} /></td>
        <td className="px-4 py-3 align-top">
          <div className="text-sm font-medium text-gray-900 break-words">
            {job.job_name || '—'}
          </div>
        </td>
        <td className="px-4 py-3 text-sm text-gray-600 break-words align-top">
          {jobDisplayOrgNameOr(job)}
        </td>
        <td className="px-4 py-3 whitespace-nowrap align-top">
          <div className="flex flex-col items-start gap-1">
            <StatusBadge job={job} />
            {job.status === 8 && (
              <span className="inline-flex px-2 py-0.5 rounded-full text-xs font-semibold bg-red-100 text-red-700 whitespace-nowrap">
                Requires attention
              </span>
            )}
            {job.is_internal && (
              <span className="inline-flex px-2 py-0.5 rounded-full text-xs font-medium bg-gray-100 text-gray-600 whitespace-nowrap">
                Internal
              </span>
            )}
            <RetroPill job={job} />
          </div>
        </td>
        <td className="px-4 py-3 whitespace-nowrap text-sm text-gray-500 align-top">
          <div>{formatDateRange(job.job_date, job.job_end)}</div>
          <ReturnedAge job={job} />
        </td>
        <td className="px-4 py-3 whitespace-nowrap text-sm text-gray-600 font-medium align-top">
          {jobValue(job)}
        </td>
        <td className="px-4 py-3 align-top"><CloseOut job={job} /></td>
        <td className="px-4 py-3 whitespace-nowrap text-sm text-gray-500 truncate align-top">
          {job.manager1_name || '—'}
        </td>
      </tr>
    );
  }

  // Mobile counterpart to renderJobRow — same data, card layout (as JobsPage).
  function renderMobileJobCard(job: Job) {
    const late = isLate(job);
    const value = jobValue(job);
    return (
      <MobileListCard
        key={job.id}
        leftBorderClass={job.status === 8 || late ? 'border-l-4 border-l-red-500' : ''}
        onToggle={() => navigate(`/jobs/${job.id}`)}
        leadingBadge={<HhLink job={job} mobile />}
        primary={job.job_name || jobDisplayOrgNameOr(job)}
        trailing={<StatusBadge job={job} />}
        secondary={jobDisplayOrgNameOr(job, '')}
        meta={
          <>
            <span className="text-gray-700 font-medium">{formatDateRange(job.job_date, job.job_end)}</span>
            {value && <span>· {value}</span>}
            {job.manager1_name && <span>· {job.manager1_name}</span>}
          </>
        }
        chips={
          <div className="flex flex-col gap-1.5 w-full">
            <div className="flex flex-wrap items-center gap-1.5">
              <ReturnedAge job={job} />
              {job.status === 8 && (
                <span className="text-xs px-2 py-0.5 rounded-full bg-red-100 text-red-700 font-semibold">
                  Requires attention
                </span>
              )}
              <RetroPill job={job} />
            </div>
            <CloseOut job={job} />
          </div>
        }
      />
    );
  }

  // Fixed column widths (table-fixed) so the columns line up from one
  // section's table to the next.
  // Every header but Close-out sorts the list (server-side, so it holds across
  // pages); the arrow shows the current column and direction.
  function renderTableHeader() {
    const th = 'px-4 py-2.5 text-left text-xs font-medium text-gray-500 uppercase tracking-wider';
    const sortTh = (col: SortColumn, label: string, width: string) => {
      const c = COLUMN_SORTS[col];
      const dir = sort === c.asc ? 'asc' : sort === c.desc ? 'desc' : null;
      return (
        <th className={`${th} ${width}`} aria-sort={dir === 'asc' ? 'ascending' : dir === 'desc' ? 'descending' : 'none'}>
          <button
            type="button"
            onClick={() => sortBy(col)}
            className={`inline-flex items-center gap-1 uppercase tracking-wider hover:text-gray-800 ${dir ? 'text-gray-900' : ''}`}
            title={`Sort by ${c.label.toLowerCase()} — ${dir === 'asc' ? c.descLabel : c.ascLabel}`}
          >
            {label}
            <span className={dir ? '' : 'text-gray-300'}>{dir === 'desc' ? '▼' : '▲'}</span>
          </button>
        </th>
      );
    };
    return (
      <thead className="bg-gray-50">
        <tr>
          {sortTh('job', 'Job #', 'w-24')}
          {sortTh('name', 'Name', 'w-[17%]')}
          {sortTh('client', 'Client', 'w-[12%]')}
          {sortTh('status', 'Status', 'w-32')}
          {sortTh('dates', 'Dates', 'w-36')}
          {sortTh('value', 'Value', 'w-24')}
          <th className={`${th} w-[28%]`}>Close-out</th>
          {sortTh('manager', 'Manager', 'w-36')}
        </tr>
      </thead>
    );
  }

  /** One bordered card holding a table (desktop) and cards (mobile). */
  function renderJobList(list: Job[], border: string) {
    return (
      <div className={`bg-white rounded-xl shadow-sm border ${border} overflow-hidden`}>
        <div className="hidden md:block overflow-x-auto">
          <table className="min-w-[1100px] w-full table-fixed divide-y divide-gray-200">
            {renderTableHeader()}
            <tbody className="bg-white divide-y divide-gray-100">
              {list.map(renderJobRow)}
            </tbody>
          </table>
        </div>
        <div className="md:hidden divide-y divide-gray-100">
          {list.map(renderMobileJobCard)}
        </div>
      </div>
    );
  }

  const TYPE_OPTIONS: { key: TypeFilter; label: string }[] = [
    { key: 'vehicle',   label: 'Vehicles' },
    { key: 'backline',  label: 'Backline' },
    { key: 'rehearsal', label: 'Rehearsals' },
  ];

  const hasFilters = search.trim() !== '' || typeFilter.length > 0 || dateFrom !== '' || dateTo !== '' || overdueOnly || hasIssuesOnly || waitingOn !== '' || retroFilter !== 'all' || includePreOp || includeInternal || sort !== 'overdue' || statusFilter !== 'returned';

  const headline =
    statusFilter === 'returned' ? `${total} waiting to be completed`
    : statusFilter === 'completed' ? `${total} completed`
    : `${total} returned or completed`;

  const sections = grouped
    ? STAGES.map(s => ({ ...s, jobs: jobs.filter(j => stageOf(strips[j.id]) === s.key) }))
        .filter(s => s.jobs.length > 0)
    : [];

  const selectClass = 'rounded border border-gray-300 px-3 py-2 text-sm shadow-sm bg-white focus:border-ooosh-500 focus:outline-none focus:ring-1 focus:ring-ooosh-500';

  return (
    <div>
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 mb-4">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Returns &amp; Completed</h1>
          <p className="text-sm text-gray-500 mt-1">{loading && total === 0 ? 'Loading…' : headline}</p>
        </div>
      </div>

      {/* Mobile compact filter bar — search + Filters button. Desktop
          filters live in the .hidden md:block block below. */}
      <div className="md:hidden mb-3 flex gap-2">
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search returns…"
          className="flex-1 min-w-0 border border-gray-300 rounded px-3 py-2 text-sm shadow-sm focus:border-ooosh-500 focus:outline-none focus:ring-1 focus:ring-ooosh-500"
        />
        <button
          type="button"
          onClick={() => setMobileFilterOpen(true)}
          className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg border border-gray-300 bg-white text-sm text-gray-700 hover:bg-gray-50 flex-shrink-0"
          aria-label="Open filters"
        >
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 4a1 1 0 011-1h16a1 1 0 011 1v2.586a1 1 0 01-.293.707l-6.414 6.414a1 1 0 00-.293.707V17l-4 4v-6.586a1 1 0 00-.293-.707L3.293 7.293A1 1 0 013 6.586V4z" />
          </svg>
          Filters
        </button>
      </div>

      {/* ── Filters (desktop) — the same controls as Upcoming & Out ── */}
      <div className="space-y-3 mb-5 hidden md:block">
        <div className="flex flex-wrap items-center gap-3">
          <input
            type="text"
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="Search by job name, client, or job number…"
            className="flex-1 min-w-[200px] max-w-md rounded border border-gray-300 px-4 py-2 text-sm shadow-sm focus:border-ooosh-500 focus:outline-none focus:ring-1 focus:ring-ooosh-500"
          />
          <div className="flex gap-1 bg-gray-100 rounded-lg p-0.5">
            {STATUS_PILLS.map(p => (
              <button
                key={p.key}
                onClick={() => setStatusFilter(p.key)}
                className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap ${
                  statusFilter === p.key ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-500 hover:text-gray-700'
                }`}
              >
                {p.label}
              </button>
            ))}
          </div>
          <label className="inline-flex items-center gap-1.5 text-sm text-gray-600">
            Waiting on
            <select
              value={waitingOn}
              onChange={e => setWaitingOn(e.target.value)}
              className={selectClass}
              title="Jobs with this close-out card still open"
            >
              {WAITING_ON_OPTIONS.map(o => <option key={o.key} value={o.key}>{o.label}</option>)}
            </select>
          </label>
          {/* Sorting is the column headers on desktop (the phone keeps a Sort select). */}
          {hasFilters && (
            <button
              onClick={clearFilters}
              className="ml-auto text-xs text-gray-500 hover:text-gray-700 underline whitespace-nowrap"
            >
              Clear filters
            </button>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-4">
          <div className="inline-flex items-center gap-1">
            <span className="text-xs text-gray-500 mr-1">Type:</span>
            {TYPE_OPTIONS.map(opt => {
              const active = typeFilter.includes(opt.key);
              return (
                <button
                  key={opt.key}
                  type="button"
                  onClick={() => setTypeFilter(prev =>
                    prev.includes(opt.key) ? prev.filter(p => p !== opt.key) : [...prev, opt.key]
                  )}
                  className={`px-2.5 py-1 text-xs font-medium rounded-full border transition-colors ${
                    active ? 'bg-ooosh-600 text-white border-ooosh-600' : 'bg-white text-gray-600 border-gray-300 hover:bg-gray-50'
                  }`}
                >
                  {opt.label}
                </button>
              );
            })}
          </div>

          <div className="inline-flex items-center gap-1.5">
            <span className="text-xs text-gray-500">Returned:</span>
            <input
              type="date"
              value={dateFrom}
              onChange={e => setDateFrom(e.target.value)}
              className="border border-gray-300 rounded px-2 py-1 text-xs"
              title="From (return_date >= …)"
            />
            <span className="text-xs text-gray-400">→</span>
            <input
              type="date"
              value={dateTo}
              onChange={e => setDateTo(e.target.value)}
              className="border border-gray-300 rounded px-2 py-1 text-xs"
              title="To (return_date <= …)"
            />
          </div>

          <label
            className="inline-flex items-center gap-1.5 text-sm text-gray-600 cursor-pointer"
            title="Only jobs whose return date has passed and that aren't completed"
          >
            <input
              type="checkbox"
              checked={overdueOnly}
              onChange={e => setOverdueOnly(e.target.checked)}
              className="rounded border-gray-300"
            />
            Overdue only
          </label>

          <label
            className="inline-flex items-center gap-1.5 text-sm text-gray-600 cursor-pointer"
            title="Only jobs with an open Problem, or a card marked as a problem"
          >
            <input
              type="checkbox"
              checked={hasIssuesOnly}
              onChange={e => setHasIssuesOnly(e.target.checked)}
              className="rounded border-gray-300"
            />
            Has issues
          </label>

          <label
            className="inline-flex items-center gap-1.5 text-sm text-gray-600 cursor-pointer"
            title="Show jobs that came back before 1 March 2026, before OP was in use — never closed out here"
          >
            <input
              type="checkbox"
              checked={includePreOp}
              onChange={e => setIncludePreOp(e.target.checked)}
              className="rounded border-gray-300"
            />
            Include pre-OP
          </label>

          <label
            className="inline-flex items-center gap-1.5 text-sm text-gray-600 cursor-pointer"
            title="Show internal jobs (Ooosh's own use)"
          >
            <input
              type="checkbox"
              checked={includeInternal}
              onChange={e => setIncludeInternal(e.target.checked)}
              className="rounded border-gray-300"
            />
            Include internal
          </label>

          {/* Retro filter — three states (any / filed / not yet). Useful for
              "which finished jobs haven't been retro'd". A select like the
              other filters, so the default doesn't look like an active pill. */}
          <label className="inline-flex items-center gap-1.5 text-sm text-gray-600">
            Retro
            <select
              value={retroFilter}
              onChange={e => setRetroFilter(e.target.value as RetroFilter)}
              className="rounded border border-gray-300 px-2 py-1 text-xs bg-white"
            >
              <option value="all">Any</option>
              <option value="has_retro">Filed</option>
              <option value="no_retro">Not yet</option>
            </select>
          </label>
        </div>
      </div>

      {/* ── Jobs list ── */}
      {loading && jobs.length === 0 ? (
        <div className="mt-8 text-center text-sm text-gray-500">Loading…</div>
      ) : jobs.length === 0 ? (
        <div className="text-center py-12 text-gray-400 bg-gray-50 rounded-lg border border-dashed border-gray-200">
          No jobs match these filters.
        </div>
      ) : grouped ? (
        <div className={`space-y-6 ${loading ? 'opacity-60' : ''}`}>
          {total > jobs.length && (
            <div className="bg-amber-50 border border-amber-200 rounded-lg px-4 py-3 text-sm text-amber-800">
              Showing the first {jobs.length} of {total} — narrow it down with the filters.
            </div>
          )}
          {sections.map(s => (
            <div key={s.key}>
              <div className="flex items-center gap-2 mb-3">
                <div className={`w-2 h-2 rounded-full ${s.dot}`} />
                <h2 className="text-sm font-bold text-gray-900 uppercase tracking-wide">{s.title}</h2>
                <span className="text-xs text-gray-400 bg-gray-100 px-2 py-0.5 rounded-full">{s.jobs.length}</span>
              </div>
              {renderJobList(s.jobs, `border-l-4 ${s.border}`)}
            </div>
          ))}
        </div>
      ) : (
        <div className={loading ? 'opacity-60' : ''}>
          {renderJobList(jobs, 'border-gray-200')}
        </div>
      )}

      {/* ── Pagination ── */}
      {totalPages > 1 && !grouped && (
        <div className="mt-6 flex flex-wrap items-center justify-between gap-3">
          <p className="text-sm text-gray-500">
            Page {page} of {totalPages} · {total} total
          </p>
          <div className="flex items-center gap-2">
            <button onClick={() => setPage(1)} disabled={page <= 1}
              className="px-2.5 py-1 text-sm border rounded disabled:opacity-50">⏮</button>
            <button onClick={() => setPage(p => Math.max(1, p - 1))} disabled={page <= 1}
              className="px-3 py-1 text-sm border rounded disabled:opacity-50">Prev</button>
            <button onClick={() => setPage(p => Math.min(totalPages, p + 1))} disabled={page >= totalPages}
              className="px-3 py-1 text-sm border rounded disabled:opacity-50">Next</button>
            <button onClick={() => setPage(totalPages)} disabled={page >= totalPages}
              className="px-2.5 py-1 text-sm border rounded disabled:opacity-50">⏭</button>
            <span className="text-xs text-gray-400 ml-2">Jump to:</span>
            <input
              type="number"
              min={1}
              max={totalPages}
              value={pageInput}
              onChange={e => setPageInput(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') jumpToPage(); }}
              placeholder={String(page)}
              className="w-16 border border-gray-300 rounded px-2 py-1 text-sm"
            />
            <button
              onClick={jumpToPage}
              disabled={!pageInput}
              className="px-2.5 py-1 text-sm border rounded disabled:opacity-50"
            >Go</button>
          </div>
        </div>
      )}

      {/* Mobile filter sheet — mirrors the desktop filter row. State changes
          live; Done just closes. */}
      <MobileFilterSheet
        open={mobileFilterOpen}
        onClose={() => setMobileFilterOpen(false)}
        title="Filter returns"
        applyLabel="Done"
      >
        <div className="space-y-5">
          <div>
            <h4 className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-2">Status</h4>
            <div className="flex flex-wrap gap-1.5">
              {STATUS_PILLS.map((p) => (
                <button
                  key={p.key}
                  onClick={() => setStatusFilter(p.key)}
                  className={`px-3 py-1.5 text-sm rounded-lg border ${
                    statusFilter === p.key
                      ? 'bg-ooosh-600 text-white border-ooosh-700'
                      : 'bg-white text-gray-700 border-gray-300'
                  }`}
                >
                  {p.label}
                </button>
              ))}
            </div>
          </div>

          <div>
            <h4 className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-2">Waiting on</h4>
            <select
              value={waitingOn}
              onChange={(e) => setWaitingOn(e.target.value)}
              className="w-full rounded border border-gray-300 px-3 py-2.5 text-sm bg-white"
            >
              {WAITING_ON_OPTIONS.map(o => <option key={o.key} value={o.key}>{o.label}</option>)}
            </select>
          </div>

          <div>
            <h4 className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-2">Type</h4>
            <div className="flex flex-wrap gap-2">
              {TYPE_OPTIONS.map((opt) => {
                const active = typeFilter.includes(opt.key);
                return (
                  <button
                    key={opt.key}
                    type="button"
                    onClick={() => setTypeFilter((prev) =>
                      prev.includes(opt.key) ? prev.filter((p) => p !== opt.key) : [...prev, opt.key]
                    )}
                    className={`px-3 py-1.5 text-sm font-medium rounded-full border transition-colors ${
                      active
                        ? 'bg-ooosh-600 text-white border-ooosh-600'
                        : 'bg-white text-gray-600 border-gray-300'
                    }`}
                  >
                    {opt.label}
                  </button>
                );
              })}
            </div>
          </div>

          <div>
            <h4 className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-2">Returned date range</h4>
            <div className="flex items-center gap-2">
              <input
                type="date"
                value={dateFrom}
                onChange={(e) => setDateFrom(e.target.value)}
                className="flex-1 border border-gray-300 rounded-lg px-3 py-2 text-sm"
              />
              <span className="text-xs text-gray-400">→</span>
              <input
                type="date"
                value={dateTo}
                onChange={(e) => setDateTo(e.target.value)}
                className="flex-1 border border-gray-300 rounded-lg px-3 py-2 text-sm"
              />
            </div>
          </div>

          <div>
            <h4 className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-2">Quick filters</h4>
            <div className="space-y-2">
              <label className="flex items-center gap-2 text-sm text-gray-700 cursor-pointer">
                <input
                  type="checkbox"
                  checked={overdueOnly}
                  onChange={(e) => setOverdueOnly(e.target.checked)}
                  className="rounded border-gray-300 w-4 h-4"
                />
                Overdue only
              </label>
              <label className="flex items-center gap-2 text-sm text-gray-700 cursor-pointer">
                <input
                  type="checkbox"
                  checked={hasIssuesOnly}
                  onChange={(e) => setHasIssuesOnly(e.target.checked)}
                  className="rounded border-gray-300 w-4 h-4"
                />
                Has issues
              </label>
              <label className="flex items-center gap-2 text-sm text-gray-700 cursor-pointer">
                <input
                  type="checkbox"
                  checked={includePreOp}
                  onChange={(e) => setIncludePreOp(e.target.checked)}
                  className="rounded border-gray-300 w-4 h-4"
                />
                Include pre-OP (before 1 Mar 2026)
              </label>
              <label className="flex items-center gap-2 text-sm text-gray-700 cursor-pointer">
                <input
                  type="checkbox"
                  checked={includeInternal}
                  onChange={(e) => setIncludeInternal(e.target.checked)}
                  className="rounded border-gray-300 w-4 h-4"
                />
                Include internal
              </label>
            </div>
          </div>

          <div>
            <h4 className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-2">Retro</h4>
            <div className="flex flex-wrap gap-2">
              {(['all', 'has_retro', 'no_retro'] as RetroFilter[]).map(key => (
                <button
                  key={key}
                  type="button"
                  onClick={() => setRetroFilter(key)}
                  className={`px-3 py-1.5 text-sm font-medium rounded-full border transition-colors ${
                    retroFilter === key
                      ? 'bg-ooosh-600 text-white border-ooosh-600'
                      : 'bg-white text-gray-600 border-gray-300'
                  }`}
                >
                  {key === 'all' ? 'Any' : key === 'has_retro' ? 'Retro filed' : 'No retro yet'}
                </button>
              ))}
            </div>
          </div>

          <div>
            <h4 className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-2">Sort</h4>
            <select
              value={sort}
              onChange={(e) => setSort(e.target.value as SortKey)}
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm bg-white"
            >
              {SORT_OPTIONS.map(opt => (
                <option key={opt.key} value={opt.key}>{opt.label}</option>
              ))}
            </select>
          </div>

          {hasFilters && (
            <button
              onClick={() => { clearFilters(); setMobileFilterOpen(false); }}
              className="w-full text-sm text-gray-600 hover:text-gray-900 underline py-2"
            >
              Clear all filters
            </button>
          )}
        </div>
      </MobileFilterSheet>
    </div>
  );
}
