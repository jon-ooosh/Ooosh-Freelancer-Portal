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
  status: 'offered' | 'accepted' | 'declined' | 'cancelled' | 'completed';
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
function fmtMinutes(min: number): string {
  const h = Math.floor(min / 60);
  const m = min % 60;
  if (h === 0) return `${m}m`;
  return m === 0 ? `${h}h` : `${h}h ${m}m`;
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
function monthLabel(date: string): string {
  const [y, m] = date.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' });
}

const TODAY = new Date().toISOString().slice(0, 10);

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
  offered:   { cell: 'bg-white text-amber-700 border border-dashed border-amber-400', short: 'Pending', label: 'Offered — waiting on their reply', counts: false },
  accepted:  { cell: 'bg-amber-100 text-amber-900', short: 'In',   label: 'Accepted',  counts: true },
  completed: { cell: 'bg-amber-200 text-amber-900', short: 'Done', label: 'Done',      counts: true },
  declined:  { cell: 'bg-gray-100 text-gray-500',   short: '—',    label: 'Declined',  counts: false },
  cancelled: { cell: 'bg-gray-100 text-gray-500',   short: '—',    label: 'Cancelled', counts: false },
};

const CELL: Record<DayStatus, { bg: string; label: string }> = {
  working:       { bg: 'bg-emerald-100 text-emerald-900', label: 'In' },
  partial:       { bg: 'bg-amber-100 text-amber-900',     label: 'Part' },
  leave:         { bg: 'bg-sky-100 text-sky-900',         label: 'Leave' },
  absent:        { bg: 'bg-rose-100 text-rose-900',       label: 'Out' },
  not_scheduled: { bg: 'bg-gray-50 text-gray-400',        label: '' },
};

export default function StaffCalendarPage() {
  const role = useAuthStore(s => s.user?.role);
  const isAdmin = role === 'admin';

  const [weeks, setWeeks] = useState(2);
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

  return (
    <div className="p-4 sm:p-6 max-w-full">
      <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
        <div>
          <h1 className="text-2xl font-semibold text-gray-900">Staff calendar</h1>
          <p className="text-sm text-gray-500 mt-0.5">
            Who&apos;s in, who&apos;s not. {monthLabel(from)}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {isAdmin && (
            <button onClick={() => setAddingBooking(true)}
              className="px-3 py-1.5 text-sm rounded border border-amber-300 text-amber-800 hover:bg-amber-50">
              Book a freelancer
            </button>
          )}
          {isAdmin && (
            <Link to="/staff/admin"
              className="px-3 py-1.5 text-sm rounded border border-ooosh-300 text-ooosh-700 hover:bg-ooosh-50">
              Staff
            </Link>
          )}
          <button onClick={() => setFrom(addDays(from, -weeks * 7))}
            className="px-3 py-1.5 text-sm rounded border border-gray-300 hover:bg-gray-50">← Back</button>
          <button onClick={() => setFrom(mondayOf(TODAY))}
            className="px-3 py-1.5 text-sm rounded border border-gray-300 hover:bg-gray-50">Today</button>
          <button onClick={() => setFrom(addDays(from, weeks * 7))}
            className="px-3 py-1.5 text-sm rounded border border-gray-300 hover:bg-gray-50">Forward →</button>
          <select value={weeks} onChange={e => setWeeks(Number(e.target.value))}
            className="px-2 py-1.5 text-sm rounded border border-gray-300">
            <option value={1}>1 week</option>
            <option value={2}>2 weeks</option>
            <option value={4}>4 weeks</option>
          </select>
        </div>
      </div>

      {error && (
        <div className="mb-4 p-3 rounded bg-red-50 border border-red-200 text-sm text-red-700">{error}</div>
      )}

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

      {isAdmin && spend && spend.bookedDays + spend.completedDays > 0 && (
        <div className="mb-4 p-3 rounded border border-amber-200 bg-amber-50/60 text-sm text-amber-900">
          <strong>{spend.bookedDays + spend.completedDays} freelance day
            {spend.bookedDays + spend.completedDays === 1 ? '' : 's'}</strong> in view
          {spend.expectedTotal > 0 && <> — £{spend.expectedTotal.toFixed(2)} expected</>}
          {spend.awaitingInvoice > 0 && (
            <span className="ml-2 text-xs px-2 py-0.5 rounded bg-amber-200">
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
        <div className="p-6 rounded border border-dashed border-gray-300 text-sm text-gray-500">
          No staff have an employment record yet.
          {isAdmin && <> <Link to="/staff/admin" className="text-ooosh-600 hover:underline">Set one up</Link> to see them here.</>}
        </div>
      ) : (
        /* Wide grids scroll inside their own container — the page body must not. */
        <div className="overflow-x-auto border border-gray-200 rounded-lg bg-white">
          <table className="min-w-full border-collapse text-sm">
            <thead>
              <tr className="bg-gray-50">
                <th className="sticky left-0 z-10 bg-gray-50 text-left font-medium text-gray-600 px-3 py-2 border-b border-gray-200 min-w-[10rem]">
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
                    className={`px-1 py-2 border-b border-gray-200 font-medium text-center min-w-[3rem] ${
                      d === TODAY ? 'bg-ooosh-50 text-ooosh-700' : 'text-gray-600'
                    } ${weekdayIndex(d) >= 5 ? 'bg-gray-100' : ''} ${
                      marker(d)?.kind === 'company' ? 'bg-emerald-50 text-emerald-800' : ''}`}>
                    <div className="text-[10px] uppercase tracking-wide">{shortDay(d)}</div>
                    <div className="text-xs">{dayNum(d)}</div>
                    {/* A dot, not a colour fill: under `use_allowance` a bank
                        holiday IS a working day, and shading it like leave
                        would say the opposite of what the ledger did. */}
                    <div className="h-1.5 leading-none">
                      {marker(d)?.kind === 'company'
                        ? <span className="text-[9px] text-emerald-600">★</span>
                        : marker(d)?.kind === 'bank' && <span className="text-[9px] text-violet-500">●</span>}
                    </div>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {people.map(p => (
                <tr key={p.personId} className="hover:bg-gray-50/60">
                  <td className="sticky left-0 z-10 bg-white px-3 py-2 border-b border-gray-100 whitespace-nowrap">
                    <div className="font-medium text-gray-900">{p.preferredName || p.name}</div>
                    {p.jobTitle && <div className="text-xs text-gray-500">{p.jobTitle}</div>}
                  </td>
                  {p.days.map(day => {
                    const cell = CELL[day.status];
                    // A day can carry several windows now; fall back to the
                    // single `window` so a cached bundle keeps working.
                    const wins = day.windows ?? (day.window ? [day.window] : []);
                    const title = day.status === 'working' && day.startTime
                      ? `${day.startTime.slice(0, 5)}–${day.endTime?.slice(0, 5)} · ${fmtMinutes(day.scheduledMinutes)}`
                      : wins.length > 0
                        ? `Out ${wins.map(w => `${w.start}–${w.end}`).join(', ')}`
                        : cell.label || 'Not scheduled';
                    return (
                      <td key={day.date}
                        className={`px-1 py-1.5 border-b border-gray-100 text-center align-middle ${
                          weekdayIndex(day.date) >= 5 ? 'bg-gray-50/60' : ''
                        }`}>
                        <div title={title}
                          className={`rounded px-1 py-1 text-[10px] leading-tight ${cell.bg} ${
                            day.isException ? 'ring-1 ring-inset ring-ooosh-400' : ''
                          }`}>
                          {day.status === 'working' && day.startTime
                            ? day.startTime.slice(0, 5)
                            : day.companyDay
                              ? 'Closed'
                              : cell.label || '·'}
                        </div>
                      </td>
                    );
                  })}
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
                    className="sticky left-0 bg-amber-50/70 px-3 py-1 text-[10px] uppercase tracking-wide text-amber-800 border-t border-amber-200">
                    Freelance — offered and confirmed
                  </td>
                </tr>
              )}
              {freelancerLanes.map(lane => (
                <tr key={lane.personId} className="hover:bg-amber-50/40">
                  <td className="sticky left-0 z-10 bg-white px-3 py-2 border-b border-gray-100 whitespace-nowrap">
                    <div className="font-medium text-gray-900">{lane.name}</div>
                    <div className="text-xs text-amber-700">Freelance</div>
                  </td>
                  {dates.map(d => {
                    const b = lane.byDate.get(d);
                    return (
                      <td key={d}
                        className={`px-1 py-1.5 border-b border-gray-100 text-center align-middle ${
                          weekdayIndex(d) >= 5 ? 'bg-gray-50/60' : ''}`}>
                        {b && (
                          <button
                            onClick={() => isAdmin && setOpenBooking(b)}
                            disabled={!isAdmin}
                            title={[
                              b.personName,
                              b.durationType === 'hours' ? `${b.startTime}–${b.endTime}`
                                : b.durationType === 'half_day' ? 'Half day' : 'Full day',
                              BOOKING_STATUS[b.status].label,
                              b.expectedTotal !== null ? `£${b.expectedTotal.toFixed(2)}` : null,
                              b.notes,
                            ].filter(Boolean).join(' · ')}
                            className={`w-full rounded px-1 py-1 text-[10px] leading-tight ${
                              BOOKING_STATUS[b.status].cell} ${isAdmin ? 'hover:ring-1 hover:ring-amber-400' : ''}`}>
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

              <tr className="bg-gray-50 font-medium">
                <td className="sticky left-0 z-10 bg-gray-50 px-3 py-2 text-gray-600 text-xs uppercase tracking-wide">
                  In
                </td>
                {headcount.map((n, i) => (
                  <td key={dates[i]} className="px-1 py-2 text-center text-gray-700"
                    title={[
                      `${n.staff} staff`,
                      n.freelancers > 0 ? `${n.freelancers} freelance confirmed` : null,
                      n.pending > 0 ? `${n.pending} offered, no reply yet` : null,
                    ].filter(Boolean).join(' · ')}>
                    {n.staff}
                    {n.freelancers > 0 && (
                      <span className="text-amber-700"> +{n.freelancers}</span>
                    )}
                    {n.pending > 0 && (
                      <span className="text-amber-500 font-normal"> +{n.pending}?</span>
                    )}
                  </td>
                ))}
              </tr>
            </tbody>
          </table>
        </div>
      )}

      <div className="mt-4 flex flex-wrap items-center gap-3 text-xs text-gray-500">
        {(['working', 'partial', 'leave', 'absent', 'not_scheduled'] as DayStatus[]).map(s => (
          <span key={s} className="inline-flex items-center gap-1.5">
            <span className={`inline-block w-3 h-3 rounded ${CELL[s].bg}`} />
            {s === 'not_scheduled' ? 'Not scheduled' : CELL[s].label}
          </span>
        ))}
        <span className="inline-flex items-center gap-1.5">
          <span className="inline-block w-3 h-3 rounded ring-1 ring-inset ring-ooosh-400" />
          One-off change / swap
        </span>
        {dates.some(d => marker(d)?.kind === 'bank') && (
          <span className="inline-flex items-center gap-1.5">
            <span className="text-violet-500">●</span>
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
          <span className="inline-flex items-center gap-1.5">
            <span className="inline-block w-3 h-3 rounded bg-amber-100" />
            Freelance confirmed — counts toward the total as &ldquo;+n&rdquo;
          </span>
        )}
        {freelancerDays.some(b => b.status === 'offered') && (
          <span className="inline-flex items-center gap-1.5">
            <span className="inline-block w-3 h-3 rounded border border-dashed border-amber-400" />
            Offered, no reply yet — shown as &ldquo;+n?&rdquo; and NOT counted as cover
          </span>
        )}
        {isAdmin && (
          <Link to="/settings" className="text-ooosh-600 hover:underline">
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
        <span className="font-medium text-gray-900">{booking.personName}</span>
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
          <button disabled={busy}
            onClick={() => act(() => api.post(`/staff-calendar/freelancer-days/${booking.id}/complete`, {}))}
            className="px-3 py-1.5 text-sm rounded bg-ooosh-600 text-white hover:bg-ooosh-700 disabled:opacity-50">
            Mark the day done
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
