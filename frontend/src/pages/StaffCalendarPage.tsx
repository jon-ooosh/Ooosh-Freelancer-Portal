import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../services/api';
import { dayMarker } from '../lib/companyCalendar';
import { QuarterHourSelect } from '../components/QuarterHourSelect';
import { useAuthStore } from '../hooks/useAuthStore';

/**
 * Staff calendar — the global "who's in" grid (Staff Calendar, Phase A).
 * See docs/STAFF-CALENDAR-SPEC.md §10.
 *
 * Peers see in/out only. Special-category detail is stripped by the API
 * (services/staff-day-status.ts maskForViewer), never hidden here — so this
 * page renders whatever it is given and cannot leak what it never received.
 */

type DayStatus = 'working' | 'not_scheduled' | 'leave' | 'absent' | 'partial';

interface StaffDay {
  date: string;
  scheduledMinutes: number;
  status: DayStatus;
  startTime: string | null;
  endTime: string | null;
  window?: { start: string; end: string };
  /** Every timed window on the day — someone can be in late AND away early. */
  windows?: { start: string; end: string }[];
  isException: boolean;
  /** The company has granted this day to everyone — "Christmas Day". */
  companyDay?: string;
  /** Requested, not yet approved — shown as "Requested", still counted in. */
  pending?: boolean;
  /** Working, but from home (spec §19) — counted as working, not as here. */
  location?: 'home';
  /** A working-from-home request for the day is waiting for a decision. */
  homePending?: boolean;
  detail?: { leaveType?: string; absenceType?: string };
}
/**
 * A freelancer booked in to work at the yard (spec §9).
 *
 * Deliberately NOT a CalendarPerson: they have no working pattern, no leave and
 * no absence, and the day is a booking rather than a contracted shift. Offered
 * → accepted / declined, never "rostered".
 */
interface DayBooking {
  id: string;
  personId: string;
  personName: string;
  bookingDate: string;
  startTime: string | null;
  endTime: string | null;
  durationType: 'full_day' | 'half_day' | 'hours';
  rateType: 'day' | 'half_day' | 'hourly' | 'fixed';
  agreedRate: number | null;
  expectedTotal: number | null;
  status: 'offered' | 'accepted' | 'declined' | 'cancelled' | 'completed' | 'lapsed' | 'withdrew';
  notes: string | null;
  invoiceReceived: boolean;
  invoiceAmount: number | null;
  invoiceQueried: boolean;
}

interface SpendSummary {
  bookedDays: number; completedDays: number;
  expectedTotal: number; invoicedTotal: number;
  awaitingInvoice: number; queried: number;
}

interface CalendarPerson {
  personId: string;
  name: string;
  preferredName: string | null;
  jobTitle: string | null;
  department: string | null;
  days: StaffDay[];
}

// ── date helpers (UTC-anchored, mirroring the backend) ──────────────────────
function addDays(date: string, days: number): string {
  const [y, m, d] = date.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + days);
  return dt.toISOString().slice(0, 10);
}
function weekdayIndex(date: string): number {
  const [y, m, d] = date.split('-').map(Number);
  return (new Date(Date.UTC(y, m - 1, d)).getUTCDay() + 6) % 7;
}
function mondayOf(date: string): string {
  return addDays(date, -weekdayIndex(date));
}
function shortDay(date: string): string {
  return ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'][weekdayIndex(date)];
}
function dayNum(date: string): string {
  return String(Number(date.slice(8, 10)));
}
function fmtLongDate(date: string): string {
  const [y, m, d] = date.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return Number.isNaN(dt.getTime()) ? date
    : dt.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
}
/**
 * What the visible range is called. The view rolls week to week, so a window
 * that starts on 31 August is mostly September — naming it after its first
 * day said "August" over a fortnight of September. Name the span instead —
 * always, even inside one month: "October 2026" over a fortnight read as the
 * whole month (design pack, Oct 2026). "5 – 18 Oct 2026", "28 Sept – 11 Oct 2026".
 */
function rangeLabel(from: string, to: string): string {
  const fmt = (d: string, opts: Intl.DateTimeFormatOptions) => {
    const [y, m, dd] = d.split('-').map(Number);
    return new Date(Date.UTC(y, m - 1, dd)).toLocaleDateString('en-GB', { ...opts, timeZone: 'UTC' });
  };
  const sameYear = from.slice(0, 4) === to.slice(0, 4);
  const sameMonth = from.slice(0, 7) === to.slice(0, 7);
  const start = sameMonth ? dayNum(from)
    : fmt(from, { day: 'numeric', month: 'short', ...(sameYear ? {} : { year: 'numeric' }) });
  return `${start} – ${fmt(to, { day: 'numeric', month: 'short', year: 'numeric' })}`;
}
/** Three-letter month for the header, shown where a month starts. */
function monthShort(date: string): string {
  const [y, m] = date.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString('en-GB', { month: 'short', timeZone: 'UTC' });
}

const TODAY = new Date().toISOString().slice(0, 10);

/** 1, 2 or 4 weeks. "Month" is not a mode the grid has — it is week-anchored —
 *  so the third option stays 4 weeks (jon, Oct 2026). */
type Weeks = 1 | 2 | 4;
const WEEK_OPTIONS: [Weeks, string][] = [[1, '1 week'], [2, '2 weeks'], [4, '4 weeks']];
/** Remembered per browser, validated on read — a stored value must never be
 *  able to pin the page into a bad state (frontend rules). */
const WEEKS_KEY = 'staffCalendar.weeks';
function readWeeks(): Weeks {
  try {
    const n = Number(localStorage.getItem(WEEKS_KEY));
    return n === 1 || n === 4 ? n : 2;
  } catch { return 2; }
}

/**
 * Hours between two HH:MM times. Mirrors `hoursBetween` in
 * services/freelancer-days.ts, which is what actually gets stored — this is
 * the preview, and the two must agree or the figure shown before saving is not
 * the figure saved.
 *
 * Negative when the pair is backwards; the caller decides what that means.
 * Returns null if either time is missing or unparseable.
 */
function hoursBetween(start: string, end: string): number | null {
  const toMin = (t: string) => {
    const [h, m] = t.split(':').map(Number);
    return Number.isFinite(h) && Number.isFinite(m) ? h * 60 + m : null;
  };
  const a = toMin(start);
  const b = toMin(end);
  if (a === null || b === null) return null;
  return Math.round(((b - a) / 60) * 100) / 100;
}

/** "5 hours", "8.5 hours", "1 hour", "45 minutes" — quarter hours read badly as decimals below one. */
function formatDuration(hours: number): string {
  if (hours < 1) return `${Math.round(hours * 60)} minutes`;
  const trimmed = Number(hours.toFixed(2));
  return `${trimmed} ${trimmed === 1 ? 'hour' : 'hours'}`;
}

/**
 * How a booking reads on the grid. Offered is deliberately paler than
 * accepted: an offer is not a commitment from either side, and the calendar
 * should not imply the person is definitely coming.
 */
const BOOKING_STATUS: Record<
  DayBooking['status'], { cell: string; short: string; label: string; counts: boolean }
> = {
  // `counts` is whether this person can be relied on to be there. An offer
  // cannot: nobody has said yes. It still SHOWS, because the approver needs to
  // see it coming — the same call pending leave makes, for the same reason.
  offered:   { cell: 'bg-transparent text-amber-800 border border-dashed border-amber-400', short: 'Pending', label: 'Offered — waiting on their reply', counts: false },
  accepted:  { cell: 'bg-amber-100 text-amber-800', short: 'In',   label: 'Accepted',  counts: true },
  completed: { cell: 'bg-amber-200 text-amber-900', short: 'Done', label: 'Done',      counts: true },
  declined:  { cell: 'bg-gray-100 text-gray-500',   short: '—',    label: 'Declined',  counts: false },
  cancelled: { cell: 'bg-gray-100 text-gray-500',   short: '—',    label: 'Cancelled', counts: false },
  // Offered, never answered, day gone, written off. Not a decline — nobody
  // declined — and not a cancellation, which is us calling the day off.
  lapsed:    { cell: 'bg-gray-100 text-gray-500',   short: '—',    label: 'No reply — written off', counts: false },
  // Accepted, then pulled out. Kept apart from `declined` on purpose: one left
  // a hole at short notice and the other never wanted the day.
  withdrew:  { cell: 'bg-gray-100 text-gray-500',   short: '—',    label: 'Pulled out after accepting', counts: false },
};

/**
 * Quiet for in, loud for off (Oct 2026). Most of the grid is people in on their
 * usual hours, and when every one of those cells was a green box with "09:00"
 * in it the few that mattered disappeared. Now "in" is a pale wash, and the eye
 * goes to what is different.
 *
 * Leave and absence are deliberately the SAME colour and the same word, "Off"
 * (jon): a different colour for sickness would tell everybody why somebody is
 * not in, which is exactly what maskForViewer exists to stop. Admins get the
 * reason on hover.
 */
const CELL: Record<DayStatus, { bg: string; label: string }> = {
  working:       { bg: 'bg-emerald-100 text-emerald-700',               label: 'In' },
  partial:       { bg: 'bg-amber-100 text-amber-800 font-semibold',     label: 'Part' },
  leave:         { bg: 'bg-violet-600 text-white font-semibold',        label: 'Off' },
  absent:        { bg: 'bg-violet-600 text-white font-semibold',        label: 'Off' },
  not_scheduled: { bg: '',                                              label: '' },
};
/** A requested day — dashed, like an offered freelancer: coming, not agreed. */
const REQUESTED = { bg: 'bg-transparent text-amber-800 border border-dashed border-amber-400', label: 'Requested' };
/** Working from home — working, but not in the building (spec §19). */
const HOME = { bg: 'bg-transparent text-teal-800 border border-teal-300', label: '⌂ Home' };
const HOME_ASKED = { bg: 'bg-emerald-100 text-teal-700 border border-dashed border-teal-400', label: 'Home?' };

/** Somebody's usual start across the days on screen — only a DIFFERENT one is
 *  worth printing in the cell. */
function usualStart(days: StaffDay[]): string | null {
  const counts = new Map<string, number>();
  for (const d of days) {
    if (d.status === 'working' && d.startTime) {
      const t = d.startTime.slice(0, 5);
      counts.set(t, (counts.get(t) ?? 0) + 1);
    }
  }
  let best: string | null = null, n = 0;
  counts.forEach((c, t) => { if (c > n) { best = t; n = c; } });
  return best;
}

export default function StaffCalendarPage() {
  const role = useAuthStore(s => s.user?.role);
  // Admin gates what is left of admin here: the Staff page link and settings.
  // Booking a freelancer is the whole team's (jon, Oct 2026) — see the
  // freelancer-days routes in routes/staff-calendar.ts.
  const isAdmin = role === 'admin';

  const [weeks, setWeeks] = useState<Weeks>(readWeeks);
  // "Who is physically here?" as a view rather than a sum in your head
  // (spec §19.3, jon): home days fade out and the footer counts the building.
  const [onSiteOnly, setOnSiteOnly] = useState(false);
  const [from, setFrom] = useState(() => mondayOf(TODAY));
  const [people, setPeople] = useState<CalendarPerson[]>([]);
  const [bankHolidays, setBankHolidays] = useState<string[]>([]);
  const [companyDays, setCompanyDays] = useState<{ date: string; label: string }[]>([]);
  const [freelancerDays, setFreelancerDays] = useState<DayBooking[]>([]);
  const [spend, setSpend] = useState<SpendSummary | null>(null);
  const [addingBooking, setAddingBooking] = useState(false);
  const [openBooking, setOpenBooking] = useState<DayBooking | null>(null);
  const [bhPolicy, setBhPolicy] = useState<'use_allowance' | 'granted'>('use_allowance');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const to = useMemo(() => addDays(from, weeks * 7 - 1), [from, weeks]);

  // The range is remembered per browser (design pack, Oct 2026). The anchor
  // date is not: the page always opens on this week.
  function changeWeeks(n: Weeks) {
    setWeeks(n);
    try { localStorage.setItem(WEEKS_KEY, String(n)); } catch { /* private mode */ }
  }
  const goPrev = useCallback(() => setFrom(f => addDays(f, -weeks * 7)), [weeks]);
  const goNext = useCallback(() => setFrom(f => addDays(f, weeks * 7)), [weeks]);
  const goToday = useCallback(() => setFrom(mondayOf(TODAY)), []);

  // ← / → move a period, T is today. Ignored while typing — the booking form
  // has text inputs, and an arrow in a date field must stay in the field.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.altKey || e.ctrlKey || e.metaKey) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return;
      if (e.key === 'ArrowLeft') { e.preventDefault(); goPrev(); }
      else if (e.key === 'ArrowRight') { e.preventDefault(); goNext(); }
      else if (e.key === 't' || e.key === 'T') { goToday(); }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [goPrev, goNext, goToday]);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await api.get<{
        data: CalendarPerson[];
        bankHolidays?: string[];
        bankHolidayPolicy?: 'use_allowance' | 'granted';
        companyDays?: { date: string; label: string }[];
      }>(`/staff-calendar/calendar?from=${from}&to=${to}`);
      setPeople(res.data);
      setBankHolidays(res.bankHolidays ?? []);
      setCompanyDays(res.companyDays ?? []);

      // A separate call rather than more fields on the calendar response:
      // freelancer days are a different concept with a different access tier,
      // and one of the two must keep working if the other fails.
      try {
        const fd = await api.get<{ data: DayBooking[]; spend?: SpendSummary }>(
          `/staff-calendar/freelancer-days?from=${from}&to=${to}`);
        setFreelancerDays(fd.data ?? []);
        setSpend(fd.spend ?? null);
      } catch {
        setFreelancerDays([]);
        setSpend(null);
      }
      setBhPolicy(res.bankHolidayPolicy ?? 'use_allowance');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load the calendar');
    } finally {
      setLoading(false);
    }
  }, [from, to]);

  useEffect(() => { void load(); }, [load]);

  const dates = useMemo(() => {
    const out: string[] = [];
    for (let d = from; d <= to; d = addDays(d, 1)) out.push(d);
    return out;
  }, [from, to]);

  // A company day beats a bank holiday on the same date — the rule lives in
  // lib/companyCalendar.ts so this page and My Time cannot drift apart on it.
  const marker = useCallback(
    (date: string) => dayMarker(date, bankHolidays, companyDays),
    [bankHolidays, companyDays]);

  // Column shading, shared by the header and every row so a column reads as
  // one stripe. Today wins over the weekend; the month divider replaces the
  // old blue line, which was easy to confuse with "today".
  const colBg = (d: string) =>
    d === TODAY ? 'bg-ooosh-50' : weekdayIndex(d) >= 5 ? 'bg-gray-50' : '';
  const monthEdge = (d: string) =>
    d !== from && dayNum(d) === '1' ? 'border-l-2 border-l-ooosh-300' : '';

  // Headcount per day — the coverage signal, informational only.
  //
  // Staff and freelancers are counted SEPARATELY and shown as "4 +2", collapsing
  // to a single number on a day with no freelancers. The calendar is used to
  // answer "have we got enough people in", so the freelancers have to be in the
  // total — but they are not interchangeable with staff, and a merged number
  // would quietly claim they were.
  const headcount = useMemo(
    () => dates.map(d => ({
      staff: people.filter(p => {
        const day = p.days.find(x => x.date === d);
        return day?.status === 'working' || day?.status === 'partial';
      }).length,
      // In the BUILDING — working, and not from home.
      onSite: people.filter(p => {
        const day = p.days.find(x => x.date === d);
        return (day?.status === 'working' || day?.status === 'partial') && day.location !== 'home';
      }).length,
      // CONFIRMED only. Counting an unanswered offer would tell you that you
      // have cover you have not actually got, which is the one thing this
      // number exists to get right.
      freelancers: freelancerDays.filter(
        b => b.bookingDate === d && BOOKING_STATUS[b.status].counts).length,
      pending: freelancerDays.filter(
        b => b.bookingDate === d && b.status === 'offered').length,
    })),
    [dates, people, freelancerDays]
  );

  // One lane per freelancer who appears anywhere in the window.
  const freelancerLanes = useMemo(() => {
    const byPerson = new Map<string, { personId: string; name: string; byDate: Map<string, DayBooking> }>();
    for (const b of freelancerDays) {
      if (b.status === 'declined' || b.status === 'cancelled') continue;
      const lane = byPerson.get(b.personId)
        ?? { personId: b.personId, name: b.personName, byDate: new Map() };
      lane.byDate.set(b.bookingDate, b);
      byPerson.set(b.personId, lane);
    }
    return [...byPerson.values()].sort((a, b) => a.name.localeCompare(b.name));
  }, [freelancerDays]);

  const divider = <span aria-hidden className="w-px h-7 bg-gray-200" />;

  return (
    <div className="p-4 sm:p-6 max-w-full">
      {/* Header row — title left, toolbar right, wrapping underneath on a
          narrow screen. The toolbar groups read left to right as: where
          else to go · how to look · where in time · the one action. */}
      <div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-4 mb-5">
        <div>
          <h1 className="text-[26px] leading-tight font-semibold text-gray-900">Staff calendar</h1>
          <p className="text-[15px] text-gray-500 mt-1">
            Who&apos;s in, who&apos;s not · {rangeLabel(from, to)}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-4 whitespace-nowrap">
          {isAdmin && (
            <>
              <Link to="/staff/admin" className="text-sm text-ooosh-600 hover:text-ooosh-700 hover:underline">
                Staff →
              </Link>
              {divider}
            </>
          )}

          {/* Range — a segmented control, the active option lifted on white. */}
          <div role="radiogroup" aria-label="How many weeks to show"
            className="flex rounded-lg bg-gray-100 p-[3px]">
            {WEEK_OPTIONS.map(([n, label]) => (
              <button key={n} type="button" role="radio" aria-checked={weeks === n}
                onClick={() => changeWeeks(n)}
                className={`px-3 py-1.5 text-sm rounded-md transition-colors ${
                  weeks === n
                    ? 'bg-white font-semibold text-gray-900 shadow-[0_1px_2px_rgba(0,0,0,.08)]'
                    : 'text-gray-500 hover:text-gray-800'}`}>
                {label}
              </button>
            ))}
          </div>

          {/* On site only — a switch; the whole label is the target. */}
          <label className="flex items-center gap-2 text-sm text-gray-700 cursor-pointer select-none">
            <button type="button" role="switch" aria-checked={onSiteOnly}
              onClick={() => setOnSiteOnly(v => !v)}
              className={`relative inline-flex h-5 w-[34px] shrink-0 items-center rounded-full transition-colors duration-150 ${
                onSiteOnly ? 'bg-ooosh-600' : 'bg-gray-300'}`}>
              <span className={`inline-block h-4 w-4 rounded-full bg-white shadow-[0_1px_2px_rgba(0,0,0,.2)] transition-transform duration-150 ${
                onSiteOnly ? 'translate-x-[16px]' : 'translate-x-[2px]'}`} />
            </button>
            On site only
          </label>

          {divider}

          {/* Date navigator — one joined control. Also ← / → and T. */}
          <div className="flex items-stretch rounded-lg border border-gray-300 bg-white overflow-hidden">
            <button type="button" onClick={goPrev} aria-label="Previous period" title="Previous period (←)"
              className="w-9 h-9 flex items-center justify-center text-gray-500 text-lg hover:bg-gray-100">‹</button>
            <button type="button" onClick={goToday} title="Today (T)"
              className="h-9 px-3.5 text-sm text-gray-700 border-x border-gray-200 hover:bg-gray-100">Today</button>
            <button type="button" onClick={goNext} aria-label="Next period" title="Next period (→)"
              className="w-9 h-9 flex items-center justify-center text-gray-500 text-lg hover:bg-gray-100">›</button>
          </div>

          {/* The only filled button on the page. */}
          <button type="button" onClick={() => setAddingBooking(true)}
            className="h-[38px] px-[18px] rounded-lg bg-ooosh-600 text-white text-sm font-semibold hover:bg-ooosh-700">
            + Book a freelancer
          </button>
        </div>
      </div>

      {error && (
        <div className="mb-4 p-3 rounded-lg bg-red-50 border border-red-200 text-sm text-red-700">{error}</div>
      )}

      <UnansweredOffers onError={setError} />

      {addingBooking && (
        /* Today if today is on screen, otherwise the first day in view. The
           panel used to open on `from` — the MONDAY of the current fortnight —
           so booking something for today meant correcting the date every time.
           Paging forward to November and booking still gives you November: the
           dates you are looking at are the ones you mean. */
        <BookFreelancer defaultDate={TODAY >= from && TODAY <= to ? TODAY : from}
          onClose={() => setAddingBooking(false)}
          onBooked={async () => { setAddingBooking(false); await load(); }}
          onError={setError} />
      )}

      {openBooking && (
        <BookingActions booking={openBooking}
          onClose={() => setOpenBooking(null)}
          onChanged={async () => { setOpenBooking(null); await load(); }}
          onError={setError} />
      )}

      {/* Freelance summary — hidden when there is nothing in view. */}
      {spend && spend.bookedDays + spend.completedDays > 0 && (
        <div className="mb-5 px-4 py-3 rounded-[10px] border border-amber-200 bg-amber-50 text-[15px] text-gray-800">
          <strong className="font-semibold">{spend.bookedDays + spend.completedDays} freelance day
            {spend.bookedDays + spend.completedDays === 1 ? '' : 's'}</strong> in view
          {spend.expectedTotal > 0 && <> · £{spend.expectedTotal.toFixed(2)} expected</>}
          {spend.awaitingInvoice > 0 && (
            <span className="ml-2 text-xs px-2 py-0.5 rounded bg-amber-200 text-amber-900">
              {spend.awaitingInvoice} awaiting an invoice
            </span>
          )}
          {spend.queried > 0 && (
            <span className="ml-2 text-xs px-2 py-0.5 rounded bg-rose-100 text-rose-800">
              {spend.queried} queried
            </span>
          )}
        </div>
      )}

      {loading ? (
        <div className="text-sm text-gray-500 py-8">Loading…</div>
      ) : people.length === 0 ? (
        <div className="p-6 rounded-[10px] border border-dashed border-gray-300 text-sm text-gray-500">
          No staff have an employment record yet.
          {isAdmin && <> <Link to="/staff/admin" className="text-ooosh-600 hover:underline">Set one up</Link> to see them here.</>}
        </div>
      ) : (
        /* Wide grids scroll inside their own container — the page body must not. */
        <div className="overflow-x-auto rounded-[10px] border border-gray-200 bg-white">
          {/* Fixed layout: every day column the same width whatever is in
              it — auto layout let a "Requested" cell widen its whole column. */}
          <table className="w-full border-collapse table-fixed"
            style={{ minWidth: 180 + dates.length * 64 }}>
            <colgroup>
              <col style={{ width: 180 }} />
              {dates.map(d => <col key={d} />)}
            </colgroup>
            <thead>
              <tr>
                <th className="sticky left-0 z-10 bg-white text-left align-bottom text-[13px] font-semibold text-gray-500 px-4 pb-3 border-b border-gray-200">
                  Person
                </th>
                {dates.map(d => (
                  <th key={d}
                    title={(() => {
                      const m = marker(d);
                      if (m?.kind === 'company') return `${m.label} — company day, nobody is contracted`;
                      if (m?.kind === 'bank') {
                        return bhPolicy === 'granted'
                          ? 'Bank holiday — granted, nobody is contracted'
                          : 'Bank holiday — a normal working day here. Book it off if you want it';
                      }
                      return undefined;
                    })()}
                    className={`px-1 py-2.5 border-b border-gray-200 font-normal text-center align-bottom ${
                      monthEdge(d)} ${
                      marker(d)?.kind === 'company' ? 'bg-emerald-50' : colBg(d)}`}>
                    {/* The month is named where it starts — and on the first
                        column, so the grid never opens on an unnamed month.
                        Its height is reserved on every cell so the rows line up. */}
                    <div className="h-3.5 leading-[14px] text-[10px] font-bold uppercase tracking-[.06em] text-ooosh-600">
                      {(d === from || dayNum(d) === '1') ? monthShort(d) : ''}
                    </div>
                    <div className="text-[11px] font-semibold uppercase tracking-[.06em] text-gray-500">{shortDay(d)}</div>
                    <div className={`mx-auto mt-0.5 h-7 w-7 flex items-center justify-center rounded-full text-sm font-semibold ${
                      d === TODAY ? 'bg-ooosh-600 text-white' : 'text-gray-900'}`}>
                      {dayNum(d)}
                    </div>
                    {/* A dot, not a colour fill: under `use_allowance` a bank
                        holiday IS a working day, and shading it like leave
                        would say the opposite of what the ledger did. */}
                    <div className="h-1.5 leading-none">
                      {marker(d)?.kind === 'company'
                        ? <span className="text-[9px] text-emerald-600">★</span>
                        : marker(d)?.kind === 'bank' && <span className="text-[9px] text-ooosh-400">●</span>}
                    </div>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {people.map(p => (
                <tr key={p.personId} className="h-[38px]">
                  {/* Job title on hover: a second line under every name doubled
                      the row height for something you rarely need. */}
                  <td className="sticky left-0 z-10 bg-white px-4 border-b border-gray-100 whitespace-nowrap"
                    title={p.jobTitle ?? undefined}>
                    <div className="text-[15px] font-semibold text-gray-900">{p.preferredName || p.name}</div>
                  </td>
                  {(() => {
                    const usual = usualStart(p.days);
                    return p.days.map(day => {
                      const worked = day.status === 'working' || day.status === 'partial';
                      const home = worked && day.location === 'home';
                      const cell = day.pending ? REQUESTED
                        : home && day.status === 'working' ? (onSiteOnly ? { bg: 'text-gray-300', label: '⌂' } : HOME)
                        : day.homePending && day.status === 'working' ? HOME_ASKED
                        : CELL[day.status];
                      // A day can carry several windows now; fall back to the
                      // single `window` so a cached bundle keeps working.
                      const wins = day.windows ?? (day.window ? [day.window] : []);
                      // Why somebody is off is admin-only: detail never reaches
                      // anybody else (maskForViewer), so peers just see "Off".
                      const why = day.detail?.absenceType ?? day.detail?.leaveType;
                      const title = home
                        ? `Working from home${day.startTime ? ` ${day.startTime.slice(0, 5)}–${day.endTime?.slice(0, 5)}` : ''}`
                        : day.homePending && day.status === 'working'
                          ? 'Asked to work from home — not approved yet, so expected in'
                          : day.pending
                        ? `Requested${wins.length ? ` ${wins.map(w => `${w.start}–${w.end}`).join(', ')}` : ''}, not yet approved${why ? ` — ${why}` : ''}`
                        : day.status === 'working' && day.startTime
                          ? `In ${day.startTime.slice(0, 5)}–${day.endTime?.slice(0, 5)}`
                          : wins.length > 0
                            ? `Off ${wins.map(w => `${w.start}–${w.end}`).join(', ')}${why ? ` — ${why}` : ''}`
                            : day.status === 'leave' || day.status === 'absent'
                              ? `Off${why ? ` — ${why}` : ''}`
                              : cell.label || (day.companyDay ? `Closed — ${day.companyDay}` : 'Not working');
                      // "In" on the usual hours is an empty pill — the colour
                      // alone says it, and only a DIFFERENT start is worth printing.
                      const text = day.pending || (home && day.status === 'working') || (day.homePending && day.status === 'working') ? cell.label
                        : day.status === 'working'
                          ? (day.startTime && day.startTime.slice(0, 5) !== usual ? day.startTime.slice(0, 5) : '')
                          : day.companyDay ? 'Closed' : cell.label;
                      const empty = day.status === 'not_scheduled' && !day.companyDay;
                      return (
                        <td key={day.date}
                          className={`px-1 border-b border-gray-100 text-center align-middle ${
                            monthEdge(day.date)} ${colBg(day.date)}`}>
                          {!empty && (
                            <div title={title}
                              className={`rounded-md h-[22px] flex items-center justify-center text-[11px] leading-none ${
                                day.companyDay && day.status === 'not_scheduled' ? 'text-gray-400' : cell.bg} ${
                                day.isException ? 'ring-1 ring-inset ring-ooosh-400' : ''
                              }`}>
                              {text}
                            </div>
                          )}
                        </td>
                      );
                    });
                  })()}
                </tr>
              ))}
              {/* A separate, visually distinct lane below the staff rows
                  (spec §9.1). They are here because the calendar answers
                  "have we got enough people in" and a freelancer in the yard
                  counts — but they have no pattern, no leave and no absence,
                  and the amber lane says so at a glance. */}
              {freelancerLanes.length > 0 && (
                <tr>
                  <td colSpan={dates.length + 1}
                    className="sticky left-0 bg-amber-50 px-4 py-2.5 text-[11px] font-bold uppercase tracking-[.07em] text-amber-800 border-b border-amber-200">
                    Freelance · offered and confirmed
                  </td>
                </tr>
              )}
              {freelancerLanes.map(lane => (
                <tr key={lane.personId} className="h-[52px]">
                  <td className="sticky left-0 z-10 bg-white px-4 border-b border-gray-100 whitespace-nowrap">
                    {/* Through to the person record — the Freelancer tab there
                        carries their whole history with us, which is the next
                        question after "who is this on my calendar". */}
                    <Link to={`/people/${lane.personId}`}
                      className="text-[15px] font-semibold text-gray-900 hover:text-ooosh-700 hover:underline">
                      {lane.name}
                    </Link>
                    <div className="text-xs text-amber-700">Freelance</div>
                  </td>
                  {dates.map(d => {
                    const b = lane.byDate.get(d);
                    return (
                      <td key={d}
                        className={`px-1 border-b border-gray-100 text-center align-middle ${
                          monthEdge(d)} ${colBg(d)}`}>
                        {b && (
                          <button type="button"
                            onClick={() => setOpenBooking(b)}
                            title={[
                              b.personName,
                              b.durationType === 'hours' ? `${b.startTime}–${b.endTime}`
                                : b.durationType === 'half_day' ? 'Half day' : 'Full day',
                              BOOKING_STATUS[b.status].label,
                              b.expectedTotal !== null ? `£${b.expectedTotal.toFixed(2)}` : null,
                              b.notes,
                            ].filter(Boolean).join(' · ')}
                            className={`w-full rounded-md h-[22px] flex items-center justify-center text-[11px] leading-none hover:ring-1 hover:ring-amber-400 ${
                              BOOKING_STATUS[b.status].cell}`}>
                            {b.durationType === 'hours' ? b.startTime
                              : b.durationType === 'half_day' ? '½'
                                : BOOKING_STATUS[b.status].short}
                          </button>
                        )}
                      </td>
                    );
                  })}
                </tr>
              ))}

              <tr className="h-11">
                <td className="sticky left-0 z-10 bg-white px-4 text-xs font-bold uppercase tracking-[.07em] text-gray-500">
                  In
                </td>
                {headcount.map((n, i) => (
                  <td key={dates[i]}
                    className={`px-1 text-center text-[15px] font-semibold text-gray-800 ${
                      monthEdge(dates[i])} ${colBg(dates[i])}`}
                    title={[
                      n.onSite === n.staff ? `${n.staff} staff in`
                        : `${n.onSite} in the building · ${n.staff - n.onSite} working from home`,
                      n.freelancers > 0 ? `${n.freelancers} freelance confirmed` : null,
                      n.pending > 0 ? `${n.pending} offered, no reply yet` : null,
                    ].filter(Boolean).join(' · ')}>
                    {/* One number when everyone working is here; when somebody
                        is at home, the building count leads and home trails
                        (spec §19.3 — the two-number form is the exception). */}
                    {n.onSite}
                    {n.onSite !== n.staff && !onSiteOnly && (
                      <span className="ml-[3px] text-xs font-normal text-teal-700">+{n.staff - n.onSite}⌂</span>
                    )}
                    {n.freelancers > 0 && (
                      <span className="ml-[3px] text-xs text-amber-700">+{n.freelancers}</span>
                    )}
                    {n.pending > 0 && (
                      <span className="ml-[3px] text-xs font-normal text-amber-500">+{n.pending}?</span>
                    )}
                  </td>
                ))}
              </tr>
            </tbody>
          </table>
        </div>
      )}

      <div className="mt-5 flex flex-wrap items-center gap-x-5 gap-y-2 text-[13px] text-gray-500">
        {[
          { bg: CELL.working.bg, label: 'In (time shown if not their usual start)' },
          { bg: CELL.partial.bg, label: 'Part day' },
          { bg: REQUESTED.bg, label: 'Requested' },
          { bg: HOME.bg, label: 'Working from home' },
          { bg: CELL.leave.bg, label: 'Off' },
          { bg: 'border border-gray-200', label: 'Not working' },
        ].map(l => (
          <span key={l.label} className="inline-flex items-center gap-1.5 whitespace-nowrap">
            <span className={`inline-block w-3.5 h-2.5 rounded-[3px] ${l.bg}`} />
            {l.label}
          </span>
        ))}
        <span className="inline-flex items-center gap-1.5 whitespace-nowrap">
          <span className="inline-block w-3.5 h-2.5 rounded-[3px] ring-1 ring-inset ring-ooosh-400" />
          One-off change / swap
        </span>
        {dates.some(d => marker(d)?.kind === 'bank') && (
          <span className="inline-flex items-center gap-1.5">
            <span className="text-ooosh-400">●</span>
            Bank holiday{bhPolicy === 'use_allowance' && ' — a normal working day here'}
          </span>
        )}
        {dates.some(d => marker(d)?.kind === 'company') && (
          <span className="inline-flex items-center gap-1.5">
            <span className="text-emerald-600">★</span>
            Company day — granted, costs nobody any allowance
          </span>
        )}
        {freelancerLanes.length > 0 && (
          <span className="inline-flex items-center gap-1.5 whitespace-nowrap">
            <span className={`inline-block w-3.5 h-2.5 rounded-[3px] ${BOOKING_STATUS.accepted.cell}`} />
            Freelance (counts as &ldquo;+n&rdquo;)
          </span>
        )}
        {freelancerDays.some(b => b.status === 'offered') && (
          <span className="inline-flex items-center gap-1.5">
            <span className="inline-block w-3.5 h-2.5 rounded-[3px] border border-dashed border-amber-400" />
            Offered, no reply yet — shown as &ldquo;+n?&rdquo; and NOT counted as cover
          </span>
        )}
        {isAdmin && (
          <Link to="/settings" className="text-ooosh-600 hover:underline whitespace-nowrap">
            Company days &amp; bank holidays →
          </Link>
        )}
      </div>
    </div>
  );
}

// ── Booking a freelancer in (spec §9.2) ─────────────────────────────────────

interface Bookable {
  personId: string; name: string; email: string | null;
  defaultDayRate: number | null; defaultHalfDayRate: number | null;
}

/**
 * Book someone in for a day at the yard.
 *
 * Lives on the calendar rather than behind its own page, because the moment
 * you decide you need an extra pair of hands is the moment you are looking at
 * the week and seeing a thin day.
 *
 * The rate PRE-FILLS from the person and is then theirs to change: what gets
 * stored is what was agreed for this booking, not a lookup that could restate
 * it later.
 */
function BookFreelancer({ defaultDate, onClose, onBooked, onError }: {
  defaultDate: string;
  onClose: () => void;
  onBooked: () => void | Promise<void>;
  onError: (m: string) => void;
}) {
  const [people, setPeople] = useState<Bookable[]>([]);
  const [personId, setPersonId] = useState('');
  const [bookingDate, setBookingDate] = useState(defaultDate);
  const [durationType, setDurationType] = useState<DayBooking['durationType']>('full_day');
  const [startTime, setStartTime] = useState('09:00');
  const [endTime, setEndTime] = useState('17:00');
  const [rateType, setRateType] = useState<DayBooking['rateType']>('day');
  const [agreedRate, setAgreedRate] = useState<string>('');
  const [notes, setNotes] = useState('');
  const [backdateOk, setBackdateOk] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    api.get<{ data: Bookable[] }>('/staff-calendar/freelancer-days/bookable')
      .then(r => setPeople(r.data))
      .catch(() => onError('Could not load the freelancer list.'));
  }, [onError]);

  // Pre-fill from the person and the duration, but never overwrite a figure
  // that has been typed — the agreed rate is the point of the field.
  const chosen = people.find(p => p.personId === personId);
  useEffect(() => {
    if (!chosen || agreedRate !== '') return;
    const suggested = durationType === 'half_day' ? chosen.defaultHalfDayRate : chosen.defaultDayRate;
    if (suggested !== null && suggested !== undefined) setAgreedRate(String(suggested));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [personId, durationType]);

  useEffect(() => { setBackdateOk(false); }, [bookingDate]);

  useEffect(() => {
    if (durationType === 'half_day' && rateType === 'day') setRateType('half_day');
    if (durationType === 'full_day' && rateType === 'half_day') setRateType('day');
    if (durationType !== 'hours' && rateType === 'hourly') setRateType('day');
  }, [durationType, rateType]);

  const timed = durationType === 'hours';
  // Shown the moment the pair stops making sense, rather than on save. `save()`
  // still refuses it — this is the same rule said earlier and in the right
  // place, not a second one that could drift.
  const timesBackwards = timed && endTime <= startTime;
  // Backfilling after the fact is legitimate — things come together at the last
  // minute and get recorded afterwards — so this is a deliberate pause rather
  // than a refusal, per the platform's warnings-not-gates rule. What it stops
  // is the silent slip: a mistyped year quietly booking someone into 2025.
  const isBackdated = bookingDate < TODAY;
  const rate = agreedRate === '' ? null : Number(agreedRate);
  // The same number the duration is shown from, so what is displayed and what
  // is charged cannot disagree.
  const hours = timed ? hoursBetween(startTime, endTime) : null;
  const expected = rate === null ? null
    : rateType === 'hourly'
      ? Math.round(rate * Math.max(0, hours ?? 0) * 100) / 100
      : rate;

  async function save() {
    if (!personId) { onError('Pick who you are booking.'); return; }
    if (timed && endTime <= startTime) { onError('The end time needs to be after the start.'); return; }
    if (isBackdated && !backdateOk) { onError('Tick the box to confirm the date is in the past.'); return; }
    setSaving(true);
    try {
      await api.post('/staff-calendar/freelancer-days', {
        personId, bookingDate, durationType, rateType,
        ...(timed ? { startTime, endTime } : {}),
        agreedRate: rate,
        notes: notes || null,
      });
      await onBooked();
    } catch (e) {
      onError(e instanceof Error ? e.message : 'Failed to book that day');
    } finally { setSaving(false); }
  }

  return (
    <div className="mb-4 p-4 rounded-lg border border-amber-200 bg-amber-50/50 space-y-3">
      <div>
        <h2 className="text-sm font-semibold text-gray-900">Book a freelancer in</h2>
        <p className="text-xs text-gray-600 mt-0.5">
          A day at the yard — prep, warehouse, an extra pair of hands. It is an{' '}
          <strong>offer</strong> until they reply, and it has nothing to do with holiday,
          overtime or working patterns.
        </p>
      </div>

      <div className="grid sm:grid-cols-3 gap-3">
        <label className="text-sm">
          <span className="block text-xs uppercase tracking-wide text-gray-400 mb-1">Who</span>
          <select value={personId} onChange={e => setPersonId(e.target.value)}
            className="w-full px-2 py-1.5 rounded border border-gray-300 bg-white">
            <option value="">Pick someone…</option>
            {people.map(p => <option key={p.personId} value={p.personId}>{p.name}</option>)}
          </select>
        </label>
        <label className="text-sm">
          <span className="block text-xs uppercase tracking-wide text-gray-400 mb-1">Day</span>
          <input type="date" value={bookingDate} onChange={e => setBookingDate(e.target.value)}
            className="w-full px-2 py-1.5 rounded border border-gray-300 bg-white" />
        </label>
        <label className="text-sm">
          <span className="block text-xs uppercase tracking-wide text-gray-400 mb-1">How long</span>
          <select value={durationType}
            onChange={e => setDurationType(e.target.value as DayBooking['durationType'])}
            className="w-full px-2 py-1.5 rounded border border-gray-300 bg-white">
            <option value="full_day">Full day</option>
            <option value="half_day">Half day</option>
            <option value="hours">Set hours</option>
          </select>
        </label>
      </div>

      {timed && (
        <div className="grid sm:grid-cols-3 gap-3">
          <label className="text-sm">
            <span className="block text-xs uppercase tracking-wide text-gray-400 mb-1">From</span>
            {/* Quarter hours, and a <select> rather than a time input because
                Chrome's time picker ignores `step` and offered all sixty
                minutes. Overtime deliberately stays on 5-minute steps —
                staff_overtime_entries has a `minutes % 5 = 0` CHECK and the two
                are answering different questions. */}
            <QuarterHourSelect value={startTime} onChange={setStartTime} aria-label="Start time"
              className="w-full px-2 py-1.5 rounded border border-gray-300 bg-white" />
          </label>
          <label className="text-sm">
            <span className="block text-xs uppercase tracking-wide text-gray-400 mb-1">To</span>
            <QuarterHourSelect value={endTime} onChange={setEndTime} aria-label="End time"
              className={`w-full px-2 py-1.5 rounded border bg-white ${
                timesBackwards ? 'border-red-400' : 'border-gray-300'}`} />
          </label>
          {/* The third column of the row the two pickers sit in. Reading the
              hours back is how you catch picking 17:00 when you meant 07:00 —
              the pair is valid, so nothing else would flag it. */}
          <div className="text-sm flex items-end pb-1.5">
            {hours !== null && hours > 0 && (
              <span className="text-gray-600">
                That is <strong className="text-gray-900">{formatDuration(hours)}</strong>
                {rateType === 'hourly' && ' at the hourly rate'}
              </span>
            )}
          </div>
          {timesBackwards && (
            <p className="text-xs text-red-700 sm:col-span-3 -mt-1" role="alert">
              {endTime === startTime
                ? 'The start and end are the same — that is a day with no hours in it.'
                : `Finishing at ${endTime} is before starting at ${startTime}. Overnight days are not supported yet — book the two halves as separate days.`}
            </p>
          )}
        </div>
      )}

      <div className="grid sm:grid-cols-3 gap-3">
        <label className="text-sm">
          <span className="block text-xs uppercase tracking-wide text-gray-400 mb-1">Rate basis</span>
          <select value={rateType} onChange={e => setRateType(e.target.value as DayBooking['rateType'])}
            className="w-full px-2 py-1.5 rounded border border-gray-300 bg-white">
            <option value="day">Day rate</option>
            <option value="half_day">Half-day rate</option>
            {timed && <option value="hourly">Hourly</option>}
            <option value="fixed">Fixed for the job</option>
          </select>
        </label>
        <label className="text-sm">
          <span className="block text-xs uppercase tracking-wide text-gray-400 mb-1">
            Agreed rate (£)
          </span>
          <input type="number" min={0} step="0.01" value={agreedRate}
            onChange={e => setAgreedRate(e.target.value)}
            placeholder={chosen?.defaultDayRate ? String(chosen.defaultDayRate) : '—'}
            className="w-full px-2 py-1.5 rounded border border-gray-300 bg-white" />
        </label>
        <div className="text-sm flex items-end pb-1.5">
          {expected !== null && (
            <span className="text-gray-600">
              Expected: <strong className="text-gray-900">£{expected.toFixed(2)}</strong>
            </span>
          )}
        </div>
      </div>

      <label className="block text-sm">
        <span className="block text-xs uppercase tracking-wide text-gray-400 mb-1">
          What are they doing
        </span>
        <input value={notes} onChange={e => setNotes(e.target.value)}
          placeholder="Van prep for the Thursday get-out"
          className="w-full px-2 py-1.5 rounded border border-gray-300 bg-white" />
      </label>

      {isBackdated && (
        <label className="flex items-start gap-2 p-2 rounded border border-amber-300 bg-amber-100/60 text-sm text-amber-900">
          <input type="checkbox" checked={backdateOk} className="mt-0.5"
            onChange={e => setBackdateOk(e.target.checked)} />
          <span>
            <strong>{fmtLongDate(bookingDate)} is in the past.</strong> That is fine if you
            are recording something that already happened — tick to confirm you meant it.
          </span>
        </label>
      )}

      <div className="flex gap-2">
        <button disabled={saving || timesBackwards || (isBackdated && !backdateOk)} onClick={() => void save()}
          className="px-3 py-1.5 text-sm rounded bg-amber-600 text-white hover:bg-amber-700 disabled:opacity-50">
          {isBackdated ? 'Record the day' : 'Offer the day'}
        </button>
        <button onClick={onClose}
          className="px-3 py-1.5 text-sm rounded border border-gray-300 bg-white hover:bg-gray-50">
          Cancel
        </button>
      </div>
    </div>
  );
}

/**
 * Passed, still unanswered — the list §9.4 decision 1 creates and item 5 clears.
 *
 * Decision 1 (never auto-decline an unanswered offer) is right: somebody who
 * has not replied may well be planning to turn up, and silently removing them
 * is the worse error. But it leaves those days with no terminal state, so
 * without this panel the list grows forever and, six months in, is long enough
 * that nobody reads it — which defeats the point of having kept them.
 *
 * Two buttons because those are the two things that actually happened. Shown
 * only when there is something in it: an empty panel every morning is training
 * to ignore the panel.
 */
function UnansweredOffers({ onError }: { onError: (m: string) => void }) {
  const [rows, setRows] = useState<DayBooking[]>([]);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await api.get<{ data: DayBooking[] }>('/staff-calendar/freelancer-days/needs-closing');
      setRows(r.data ?? []);
    } catch {
      // Silent: this is a housekeeping panel, and failing to load it must not
      // put an error banner over the calendar somebody actually came for.
      setRows([]);
    }
  }, []);
  useEffect(() => { void load(); }, [load]);

  async function close(id: string, outcome: 'completed' | 'lapsed') {
    setBusy(id);
    try {
      await api.post(`/staff-calendar/freelancer-days/${id}/close`, { outcome });
      await load();
    } catch (e) {
      onError(e instanceof Error ? e.message : 'Could not close that out');
    } finally { setBusy(null); }
  }

  if (rows.length === 0) return null;

  return (
    <div className="mb-4 p-4 rounded-lg border border-gray-300 bg-gray-50 space-y-3">
      <div>
        <h2 className="text-sm font-semibold text-gray-900">
          {rows.length === 1 ? 'One offer was never answered' : `${rows.length} offers were never answered`}
        </h2>
        <p className="text-xs text-gray-600 mt-0.5">
          The day has passed and nobody replied. Nothing was assumed either way —
          say what happened so it stops sitting here.
        </p>
      </div>
      <ul className="space-y-2">
        {rows.map(b => (
          <li key={b.id} className="flex flex-wrap items-center gap-2 text-sm">
            <Link to={`/people/${b.personId}`}
              className="text-gray-900 font-medium hover:text-ooosh-700 hover:underline">
              {b.personName}
            </Link>
            <span className="text-gray-500">{fmtLongDate(b.bookingDate)}</span>
            {b.notes && <span className="text-gray-400 text-xs truncate max-w-[16rem]">{b.notes}</span>}
            <span className="ml-auto flex gap-2">
              <button disabled={busy === b.id} onClick={() => void close(b.id, 'completed')}
                className="px-2 py-1 text-xs rounded border border-amber-300 bg-white hover:bg-amber-50 disabled:opacity-40">
                They came anyway
              </button>
              <button disabled={busy === b.id} onClick={() => void close(b.id, 'lapsed')}
                className="px-2 py-1 text-xs rounded border border-gray-300 bg-white hover:bg-gray-100 disabled:opacity-40">
                It did not happen
              </button>
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * What can be done with an existing booking.
 *
 * Accepted / declined is recorded here by admin for now — the freelancer-facing
 * version is spec §9.3 and is not built. A decline is recorded and nothing else
 * happens to them; that is the whole point of the wording.
 */
function BookingActions({ booking, onClose, onChanged, onError }: {
  booking: DayBooking;
  onClose: () => void;
  onChanged: () => void | Promise<void>;
  onError: (m: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [amending, setAmending] = useState(false);
  const [aDate, setADate] = useState(booking.bookingDate);
  const [aDuration, setADuration] = useState(booking.durationType);
  const [aStart, setAStart] = useState(booking.startTime ?? '09:00');
  const [aEnd, setAEnd] = useState(booking.endTime ?? '17:00');
  const [aRate, setARate] = useState(booking.agreedRate !== null ? String(booking.agreedRate) : '');
  const [aNotes, setANotes] = useState(booking.notes ?? '');
  const [invoiceAmount, setInvoiceAmount] = useState(
    booking.invoiceAmount !== null ? String(booking.invoiceAmount)
      : booking.expectedTotal !== null ? String(booking.expectedTotal) : '');

  async function act(fn: () => Promise<unknown>) {
    setBusy(true);
    try { await fn(); await onChanged(); }
    catch (e) { onError(e instanceof Error ? e.message : 'That did not work'); }
    finally { setBusy(false); }
  }

  return (
    <div className="mb-4 p-4 rounded-lg border border-amber-200 bg-white space-y-3">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <Link to={`/people/${booking.personId}`}
          className="font-medium text-gray-900 hover:text-ooosh-700 hover:underline">
          {booking.personName}
        </Link>
        <span className="text-sm text-gray-600">{booking.bookingDate}</span>
        <span className="text-sm text-gray-500">
          {booking.durationType === 'hours' ? `${booking.startTime}–${booking.endTime}`
            : booking.durationType === 'half_day' ? 'Half day' : 'Full day'}
        </span>
        <span className="text-xs px-2 py-0.5 rounded bg-amber-100 text-amber-900">
          {BOOKING_STATUS[booking.status].label}
        </span>
        {booking.expectedTotal !== null && (
          <span className="text-sm text-gray-600">£{booking.expectedTotal.toFixed(2)} expected</span>
        )}
        <button onClick={onClose} className="ml-auto text-sm text-gray-500 hover:underline">Close</button>
      </div>
      {booking.notes && <p className="text-sm text-gray-600">{booking.notes}</p>}

      <div className="flex flex-wrap gap-2">
        {booking.status === 'offered' && (
          <>
            <button disabled={busy}
              onClick={() => act(() => api.post(`/staff-calendar/freelancer-days/${booking.id}/respond`,
                { response: 'accepted' }))}
              className="px-3 py-1.5 text-sm rounded bg-emerald-600 text-white hover:bg-emerald-700 disabled:opacity-50">
              They accepted
            </button>
            <button disabled={busy}
              onClick={() => act(() => api.post(`/staff-calendar/freelancer-days/${booking.id}/respond`,
                { response: 'declined' }))}
              className="px-3 py-1.5 text-sm rounded border border-gray-300 hover:bg-gray-50 disabled:opacity-50">
              They declined
            </button>
          </>
        )}
        {booking.status === 'accepted' && (
          <>
            <button disabled={busy}
              onClick={() => act(() => api.post(`/staff-calendar/freelancer-days/${booking.id}/complete`, {}))}
              className="px-3 py-1.5 text-sm rounded bg-ooosh-600 text-white hover:bg-ooosh-700 disabled:opacity-50">
              Mark the day done
            </button>
            {/* Not "they declined": they had agreed and pulled out, which left a
                hole at short notice. Recording those the same way loses the one
                thing worth knowing next time you are deciding who to ask. */}
            <button disabled={busy}
              onClick={() => {
                const note = window.prompt('They pulled out — anything worth noting? (optional)');
                if (note === null) return;
                void act(() => api.post(`/staff-calendar/freelancer-days/${booking.id}/withdraw`,
                  { note: note.trim() || null }));
              }}
              className="px-3 py-1.5 text-sm rounded border border-gray-300 hover:bg-gray-50 disabled:opacity-50">
              They pulled out
            </button>
          </>
        )}
        {(booking.status === 'offered' || booking.status === 'accepted') && (
          <button disabled={busy} onClick={() => setAmending(a => !a)}
            className="px-3 py-1.5 text-sm rounded border border-gray-300 hover:bg-gray-50 disabled:opacity-50">
            {amending ? 'Stop amending' : 'Amend'}
          </button>
        )}
        {booking.status !== 'cancelled' && (
          <button disabled={busy}
            onClick={() => {
              const reason = window.prompt('Why is this being cancelled? (kept on the record)');
              if (!reason) return;
              void act(() => api.post(`/staff-calendar/freelancer-days/${booking.id}/cancel`, { reason }));
            }}
            className="px-3 py-1.5 text-sm rounded border border-red-200 text-red-700 hover:bg-red-50 disabled:opacity-50">
            Cancel the booking
          </button>
        )}
      </div>

      {amending && (
        <div className="pt-3 border-t border-gray-100 space-y-3">
          {/* The rule, said out loud where it is being used. Moving the day or
              the hours is a different commitment and has to be agreed again;
              changing the rate or the job is something to tell them. Without
              this line the two buttons look arbitrary. */}
          <p className="text-xs text-gray-600">
            Changing the <strong>day or the hours</strong> asks them again
            {booking.status === 'accepted' ? ' — this booking goes back to pending' : ''}.
            Changing the <strong>rate or the notes</strong> just tells them.
          </p>
          <div className="grid sm:grid-cols-3 gap-3">
            <label className="text-sm">
              <span className="block text-xs uppercase tracking-wide text-gray-400 mb-1">Day</span>
              <input type="date" value={aDate} onChange={e => setADate(e.target.value)}
                className="w-full px-2 py-1.5 rounded border border-gray-300" />
            </label>
            <label className="text-sm">
              <span className="block text-xs uppercase tracking-wide text-gray-400 mb-1">How long</span>
              <select value={aDuration} onChange={e => setADuration(e.target.value as DayBooking['durationType'])}
                className="w-full px-2 py-1.5 rounded border border-gray-300 bg-white">
                <option value="full_day">Full day</option>
                <option value="half_day">Half day</option>
                <option value="hours">Set hours</option>
              </select>
            </label>
            <label className="text-sm">
              <span className="block text-xs uppercase tracking-wide text-gray-400 mb-1">Agreed rate (£)</span>
              <input type="number" min={0} step="0.01" value={aRate}
                onChange={e => setARate(e.target.value)}
                className="w-full px-2 py-1.5 rounded border border-gray-300" />
            </label>
          </div>
          {aDuration === 'hours' && (
            <div className="grid sm:grid-cols-3 gap-3">
              <label className="text-sm">
                <span className="block text-xs uppercase tracking-wide text-gray-400 mb-1">From</span>
                <QuarterHourSelect value={aStart} onChange={setAStart} aria-label="New start time"
                  className="w-full px-2 py-1.5 rounded border border-gray-300 bg-white" />
              </label>
              <label className="text-sm">
                <span className="block text-xs uppercase tracking-wide text-gray-400 mb-1">To</span>
                <QuarterHourSelect value={aEnd} onChange={setAEnd} aria-label="New end time"
                  className="w-full px-2 py-1.5 rounded border border-gray-300 bg-white" />
              </label>
            </div>
          )}
          <label className="block text-sm">
            <span className="block text-xs uppercase tracking-wide text-gray-400 mb-1">What are they doing</span>
            <input value={aNotes} onChange={e => setANotes(e.target.value)}
              className="w-full px-2 py-1.5 rounded border border-gray-300" />
          </label>
          <button disabled={busy}
            onClick={() => act(async () => {
              await api.patch(`/staff-calendar/freelancer-days/${booking.id}`, {
                bookingDate: aDate,
                durationType: aDuration,
                ...(aDuration === 'hours' ? { startTime: aStart, endTime: aEnd } : { startTime: null, endTime: null }),
                agreedRate: aRate === '' ? null : Number(aRate),
                notes: aNotes.trim() || null,
              });
              setAmending(false);
            })}
            className="px-3 py-1.5 text-sm rounded bg-amber-600 text-white hover:bg-amber-700 disabled:opacity-50">
            Save the change
          </button>
        </div>
      )}

      {booking.status === 'completed' && (
        <div className="pt-3 border-t border-gray-100 flex flex-wrap items-end gap-2">
          <label className="text-sm">
            <span className="block text-xs uppercase tracking-wide text-gray-400 mb-1">
              Invoice received (£)
            </span>
            <input type="number" min={0} step="0.01" value={invoiceAmount}
              onChange={e => setInvoiceAmount(e.target.value)}
              className="px-2 py-1.5 rounded border border-gray-300 w-32" />
          </label>
          <button disabled={busy}
            onClick={() => act(() => api.post(`/staff-calendar/freelancer-days/${booking.id}/invoice`, {
              received: true,
              amount: invoiceAmount === '' ? null : Number(invoiceAmount),
              queried: invoiceAmount !== '' && booking.expectedTotal !== null
                && Number(invoiceAmount) !== booking.expectedTotal,
            }))}
            className="px-3 py-1.5 text-sm rounded bg-ooosh-600 text-white hover:bg-ooosh-700 disabled:opacity-50">
            Record it
          </button>
          {booking.invoiceReceived && (
            <span className="text-xs text-emerald-700">
              Recorded{booking.invoiceQueried ? ' — flagged, it differs from the expected figure' : ''}
            </span>
          )}
        </div>
      )}
    </div>
  );
}
