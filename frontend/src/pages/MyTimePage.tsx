import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../services/api';
import { splitBankHolidays } from '../lib/companyCalendar';
import { useAuthStore } from '../hooks/useAuthStore';
import { hasManagerRole } from '../lib/roles';

/**
 * My Time — book time off, see your balances, track your requests.
 * See docs/STAFF-CALENDAR-SPEC.md §5.2, §10, §11.
 *
 * The impact preview is shown to the REQUESTER, not just the approver. The
 * best clash is the one that never gets requested: if you can see that two
 * people are already off and nobody would be in, you pick a different week and
 * nobody has to have a conversation about it.
 *
 * Every warning here informs; none of them block. Submitting with a shortfall
 * is allowed — the request simply reaches the approver with the shortfall
 * shown. A gate with no route through it strands people.
 *
 * Layout (Sep 2026 redesign): balances as three stat cards, the overtime
 * logger always open (the typical use is "next morning, on a phone" and a
 * button to open a form was one tap too many), and holiday, overtime and
 * company days in ONE timeline with a list / calendar toggle. The UI says
 * "Overtime" throughout; "toil" survives only as the API's leaveType.
 */

type LeaveType = 'holiday' | 'toil' | 'unpaid';
interface DaySpec { portion: 'full' | 'am' | 'pm' | 'hours'; startTime?: string; endTime?: string }
type LeaveStatus = 'pending' | 'approved' | 'declined' | 'cancelled' | 'withdrawn';

interface LeaveRequest {
  id: string;
  personId: string;
  personName: string;
  leaveType: LeaveType;
  startDate: string;
  endDate: string;
  totalMinutes: number;
  status: LeaveStatus;
  requestNote: string | null;
  requestedAt: string;
  decidedAt: string | null;
  decidedByName: string | null;
  decisionNote: string | null;
  cancellationReason: string | null;
  days: { date: string; minutes: number; portion: 'full' | 'am' | 'pm' }[];
}
interface AccountBreakdown {
  inMinutes: number;
  outMinutes: number;
  availableMinutes: number;
  nominalDayMinutes: number | null;
  byType: Record<string, number>;
}
type BhPolicy = 'use_allowance' | 'granted';
interface MyBalances {
  year: number;
  holiday: AccountBreakdown;
  overtime: AccountBreakdown;
  /** This person's own rule — their override, else the company's. Optional:
   *  an older backend does not send it, and the page then falls back to the
   *  company-wide policy from /bank-holidays. */
  bankHolidayPolicy?: BhPolicy;
}
interface OvertimeEntry {
  id: string;
  workDate: string;
  startTime: string | null;
  endTime: string | null;
  minutes: number;
  reason: string;
  status: 'pending' | 'approved' | 'declined' | 'cancelled';
  decidedByName: string | null;
  decisionNote: string | null;
}
interface Impact {
  days: { date: string; minutes: number; portion: string }[];
  totalMinutes: number;
  workingDays: number;
  balanceBefore: number | null;
  balanceAfter: number | null;
  nominalDayMinutes: number | null;
  shortfallMinutes: number;
  noticeDays: number;
  ownClashes: string[];
  clashes: { date: string; people: string[] }[];
  coverage: { date: string; scheduled: number; ifApproved: number }[];
  warnings: string[];
}

const TYPE_LABELS: Record<LeaveType, string> = {
  holiday: 'Holiday', toil: 'Overtime taken as time off', unpaid: 'Unpaid leave',
};
const STATUS_STYLE: Record<LeaveStatus, string> = {
  pending: 'bg-amber-100 text-amber-800',
  approved: 'bg-emerald-100 text-emerald-800',
  declined: 'bg-red-100 text-red-800',
  cancelled: 'bg-gray-100 text-gray-600',
  withdrawn: 'bg-gray-100 text-gray-600',
};

function fmtH(min: number): string {
  const sign = min < 0 ? '-' : '';
  const a = Math.abs(min), h = Math.floor(a / 60), m = a % 60;
  if (h === 0) return `${sign}${m}m`;
  return m === 0 ? `${sign}${h}h` : `${sign}${h}h ${m}m`;
}
function fmtDate(iso: string): string {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('en-GB', {
    weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC',
  });
}
function fmtRange(a: string, b: string): string {
  return a === b ? fmtDate(a) : `${fmtDate(a)} – ${fmtDate(b)}`;
}
/** One part of a YYYY-MM-DD date, formatted — "Tue", "29", "Sep". */
function datePart(iso: string, part: Intl.DateTimeFormatOptions): string {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('en-GB', { ...part, timeZone: 'UTC' });
}
/** Days between ISO dates, done in UTC so a clock change cannot lose an hour. */
function addDaysIso(iso: string, n: number): string {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}
/**
 * Today in the person's OWN timezone. `toISOString()` is UTC, which during
 * British Summer Time still reads yesterday until 1am — the one hour somebody
 * finishing a late load-out is most likely to be logging it.
 */
function localIso(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
const TODAY = localIso(new Date());
const CURRENT_YEAR = Number(TODAY.slice(0, 4));

/** Whole weeks left in a leave year, for the "use it or lose it" nudge. */
function weeksLeftInYear(year: number): number {
  if (year !== CURRENT_YEAR) return 0;
  const end = Date.UTC(year, 11, 31);
  const now = Date.UTC(CURRENT_YEAR, Number(TODAY.slice(5, 7)) - 1, Number(TODAY.slice(8, 10)));
  return Math.max(0, Math.floor((end - now) / (7 * 86400000)));
}

/** The leave years the page offers, newest first. */
const YEARS = [CURRENT_YEAR + 1, CURRENT_YEAR, CURRENT_YEAR - 1, CURRENT_YEAR - 2];

/** "List" or "Calendar" — remembered per browser, validated on read (a stored
 *  preference must never be able to pin the page into a bad state). */
const VIEW_KEY = 'myTime.view';
function readView(): 'list' | 'calendar' {
  try { return localStorage.getItem(VIEW_KEY) === 'calendar' ? 'calendar' : 'list'; }
  catch { return 'list'; }
}

/**
 * The page's derived holiday / overtime parts.
 *
 * A single net figure answers "can I book this?" but not "where did it go?".
 * For the overtime bank especially, earned / taken as time off / paid out are
 * three separate facts that one number silently merges.
 *
 * The parts are derived so they ALWAYS reconcile to the available figure,
 * rather than read off raw credits and debits. A cancelled holiday posts a
 * credit, so raw "in" would have read 217h on a 196h allowance — true to the
 * ledger, wrong on a line labelled Allowance. Netting the cancellation
 * against the booking it reverses gives the number a person expects, and
 * allowance is then derived from what is left.
 */
function deriveParts(balances: MyBalances) {
  const t = (b: AccountBreakdown, k: string) => b.byType[k] ?? 0;
  const holidayTaken = -(t(balances.holiday, 'booking') + t(balances.holiday, 'cancellation'));
  const holidayAllowance = balances.holiday.availableMinutes + holidayTaken;
  const toilTaken = -(t(balances.overtime, 'spend_toil') + t(balances.overtime, 'cancellation'));
  const toilPaid = -(t(balances.overtime, 'spend_paid') + t(balances.overtime, 'year_end_cashout'));
  const toilBanked = balances.overtime.availableMinutes + toilTaken + toilPaid;
  // Granted, not remaining: "nothing left" and "nothing granted" look the same
  // in the available figure and mean entirely different things.
  const granted = t(balances.holiday, 'entitlement') + t(balances.holiday, 'adjustment')
    + t(balances.holiday, 'carry_over');
  return { holidayTaken, holidayAllowance, toilTaken, toilPaid, toilBanked, granted };
}

function asDays(mins: number, nominal: number | null): string | null {
  return nominal && nominal > 0 ? (mins / nominal).toFixed(1) : null;
}

export default function MyTimePage() {
  const role = useAuthStore(s => s.user?.role);
  const [requests, setRequests] = useState<LeaveRequest[]>([]);
  const [overtime, setOvertime] = useState<OvertimeEntry[]>([]);
  const [balances, setBalances] = useState<MyBalances | null>(null);
  const [hasStaffRecord, setHasStaffRecord] = useState(true);
  // The leave year being looked at. Everything on this page is per leave year
  // because the ledger is — balances, entitlement and the year-end sweep all
  // key on it — so a page that mixes years is showing a number that belongs to
  // no account.
  const [year, setYear] = useState(CURRENT_YEAR);
  const [bankHolidays, setBankHolidays] = useState<string[]>([]);
  const [bhPolicy, setBhPolicy] = useState<BhPolicy>('use_allowance');
  const [companyDays, setCompanyDays] = useState<{ date: string; label: string }[]>([]);
  // The booking form, when open: which type it starts on and which date.
  const [booking, setBooking] = useState<{ type: LeaveType; seed: string } | null>(null);
  const [view, setView] = useState<'list' | 'calendar'>(readView);
  const [calMonth, setCalMonth] = useState({ y: CURRENT_YEAR, m: Number(TODAY.slice(5, 7)) - 1 });
  // Overtime logged on this visit, so its row can be picked out in the list.
  const [freshIds, setFreshIds] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const from = `${year}-01-01`;
      const to = `${year}-12-31`;
      const [leave, ot, bal, bh, cd] = await Promise.all([
        api.get<{ data: LeaveRequest[] }>(`/staff-calendar/leave?from=${from}&to=${to}`),
        api.get<{ data: OvertimeEntry[] }>(`/staff-calendar/overtime?from=${from}&to=${to}`),
        api.get<{ data: MyBalances | null; hasStaffRecord?: boolean }>(
          `/staff-calendar/me/balances?year=${year}`),
        api.get<{ data: string[]; policy?: BhPolicy }>(
          `/staff-calendar/bank-holidays?year=${year}`),
        api.get<{ occurrences: { date: string; label: string }[] }>(
          `/staff-calendar/company-days?year=${year}`),
      ]);
      setRequests(leave.data);
      setOvertime(ot.data);
      setBalances(bal.data);
      setBankHolidays(bh.data ?? []);
      setBhPolicy(bh.policy ?? 'use_allowance');
      setCompanyDays(cd.occurrences ?? []);
      setHasStaffRecord(bal.hasStaffRecord !== false);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load your time');
    } finally { setLoading(false); }
  }, [year]);

  useEffect(() => { void load(); }, [load]);

  function changeView(v: 'list' | 'calendar') {
    setView(v);
    try { localStorage.setItem(VIEW_KEY, v); } catch { /* private window — just not remembered */ }
  }

  // Picking a year moves the calendar with it: this month for this year,
  // January for any other.
  function changeYear(y: number) {
    setYear(y);
    setCalMonth(y === CURRENT_YEAR
      ? { y, m: Number(TODAY.slice(5, 7)) - 1 }
      : { y, m: 0 });
  }

  async function withdraw(id: string) {
    if (!confirm('Withdraw this request?')) return;
    try {
      await api.post(`/staff-calendar/leave/${id}/withdraw`, {});
      setNotice('Request withdrawn.');
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to withdraw');
    }
  }

  async function cancelOvertime(id: string) {
    if (!confirm('Withdraw this overtime entry?')) return;
    try {
      await api.post(`/staff-calendar/overtime/${id}/cancel`, {});
      setNotice('Entry withdrawn.'); await load();
    } catch (err) { setError(err instanceof Error ? err.message : 'Failed to withdraw'); }
  }

  const isCurrentYear = year === CURRENT_YEAR;
  // Next year is bookable now that its entitlement is granted in advance.
  // Only a year that has finished is read-only, and then because the dates
  // have been and gone rather than because of anything about the balance.
  const isPastYear = year < CURRENT_YEAR;
  // Open a form on the year being looked at, not on today. This was the real
  // reason next year was gated read-only: picking 2027 and hitting "Book time
  // off" opened a form dated 2026, which is worse than not offering it.
  const formSeedDate = isCurrentYear ? TODAY : `${year}-01-01`;

  // THIS person's rule, not just the company's — the staff record can override
  // it. Falls back to the company-wide policy if the backend did not say.
  const policy: BhPolicy = balances?.bankHolidayPolicy ?? bhPolicy;

  // Bank holidays still ahead that nobody has booked off, MINUS any the company
  // has already granted (splitBankHolidays: a company day wins). A bank holiday
  // already covered by a live request is not "left" — telling someone to book
  // Easter Monday when they already have is a nag people learn to ignore.
  const bh = useMemo(() => {
    const booked = new Set(requests
      .filter(r => r.status === 'pending' || r.status === 'approved')
      .flatMap(r => r.days.map(d => d.date)));
    const { working, granted } = splitBankHolidays(bankHolidays, companyDays, TODAY);
    return {
      // Only under use_allowance is a bank holiday something to book at all.
      toBook: policy === 'use_allowance' ? working.filter(d => !booked.has(d)) : [],
      granted,
    };
  }, [requests, bankHolidays, companyDays, policy]);

  const pendingOvertime = overtime
    .filter(e => e.status === 'pending')
    .reduce((s, e) => s + e.minutes, 0);

  function openBooking(type: LeaveType, seed = formSeedDate) {
    setBooking({ type, seed });
  }

  return (
    <div className="flex flex-col gap-4 sm:gap-6">
      {error && <div className="p-3 rounded-lg bg-red-50 border border-red-200 text-sm text-red-700">{error}</div>}
      {notice && <div className="p-3 rounded-lg bg-emerald-50 border border-emerald-200 text-sm text-emerald-800">{notice}</div>}

      {!hasStaffRecord && (
        <div className="p-3 rounded-lg border border-amber-200 bg-amber-50 text-sm text-amber-900">
          <strong className="block">Your login isn&apos;t linked to a staff record.</strong>
          Your hours, holiday and overtime all hang off a staff record, and this login
          isn&apos;t pointed at one — so there is nothing to show and nothing can be booked.
          {hasManagerRole(role) ? (
            <> Fix it on the <Link to="/staff/admin" className="underline font-medium">Staff page</Link>:
            find the employee, then use <em>Link a login</em>. If they show
            &ldquo;No login&rdquo;, that is this exact problem.</>
          ) : (
            <> Ask an admin to link it on the Staff page.</>
          )}
        </div>
      )}

      {/* Desktop: three stat cards up top. A phone gets two small tiles BELOW
          the logger instead — there, logging is the reason the page is open. */}
      <StatCards balances={balances} year={year} onYear={changeYear}
        pendingOvertime={pendingOvertime} />

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 items-stretch">
        <div className="lg:col-span-2">
          <LogOvertime
            onLogged={async (_msg, id) => {
              if (id) setFreshIds(prev => [...prev, id]);
              setError(null); setNotice(null);
              await load();
            }}
            onUndone={async () => { await load(); }}
            onError={setError} />
        </div>

        <MobileTiles balances={balances} year={year} onYear={changeYear}
          pendingOvertime={pendingOvertime} />

        <div className="bg-white border border-gray-200 rounded-2xl sm:rounded-xl p-5 flex flex-col gap-2.5">
          <h2 className="text-[17px] font-semibold text-gray-900">Want some time off?</h2>
          {isPastYear ? (
            <p className="text-sm text-gray-500">
              {year} has finished, so this is a record rather than something to book against.
            </p>
          ) : (
            <>
              <button onClick={() => openBooking('holiday')}
                className="w-full py-[11px] rounded-lg bg-ooosh-600 hover:bg-ooosh-700 text-white text-[15px] font-semibold">
                Book holiday
              </button>
              <button onClick={() => openBooking('toil')}
                className="w-full py-2.5 rounded-lg border border-ooosh-300 text-ooosh-700 hover:bg-ooosh-50 text-sm font-medium">
                Use overtime as time off
              </button>
              {!isCurrentYear && (
                <p className="text-xs text-gray-500">
                  Books against {year} — next year&apos;s allowance is already set.
                </p>
              )}
            </>
          )}

          {!isPastYear && (bh.toBook.length > 0 || bh.granted.length > 0) && (
            <div className="mt-1 pt-3 border-t border-gray-100 text-[13px] leading-[1.55] text-gray-700">
              {/* A count and the NEXT date only. Listing every one grew to
                  eight lines in January; the full set is in the timeline
                  below, each with its own "Book it". */}
              {bh.toBook.length > 0 && (
                <p>
                  <strong>{bh.toBook.length} bank holiday{bh.toBook.length === 1 ? '' : 's'} left</strong>
                  {' '}— next is {fmtDate(bh.toBook[0])}.{' '}
                  {bh.toBook.length === 1
                    ? 'It’s a normal working day here, so book it off if you want it.'
                    : 'They’re normal working days here, so book them off if you want them.'}
                </p>
              )}
              {bh.granted.length > 0 && (
                <p className={bh.toBook.length > 0 ? 'mt-1' : ''}>
                  {bh.granted.length === 1 ? 'One bank holiday is' : `${bh.granted.length} bank holidays are`}
                  {' '}also a company day{bh.granted.length === 1 ? '' : 's'}, so already given to you.
                </p>
              )}
            </div>
          )}

          <div className="mt-auto pt-2 flex gap-5 text-sm">
            <Link to="/staff/calendar" className="text-ooosh-600 hover:underline">Team calendar →</Link>
            {hasManagerRole(role) && <Link to="/staff/admin" className="text-ooosh-600 hover:underline">Staff →</Link>}
          </div>
        </div>
      </div>

      {booking && (
        <BookTimeOff key={`${booking.type}:${booking.seed}`}
          balances={balances} seedDate={booking.seed} initialType={booking.type}
          onClose={() => setBooking(null)}
          onBooked={async (msg) => { setNotice(msg); setError(null); setBooking(null); await load(); }}
          onError={setError} />
      )}

      <section className="bg-white border border-gray-200 rounded-2xl sm:rounded-xl overflow-hidden">
        <div className="px-4 sm:px-5 py-3.5 border-b border-gray-100 flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-wrap items-baseline gap-x-2.5">
            <h2 className="text-[17px] font-semibold text-gray-900">Your time</h2>
            <span className="hidden sm:inline text-[13px] text-gray-500">Holiday, overtime and company days together</span>
          </div>
          <div className="flex bg-gray-100 rounded-lg p-[3px]">
            {(['list', 'calendar'] as const).map(v => (
              <button key={v} onClick={() => changeView(v)}
                className={`px-3 h-9 sm:h-auto sm:py-[5px] rounded-md text-[13px] font-medium ${
                  view === v ? 'bg-white text-gray-900 shadow-[0_1px_2px_rgba(0,0,0,.08)]' : 'text-gray-500 hover:text-gray-700'}`}>
                {v === 'list' ? 'List' : 'Calendar'}
              </button>
            ))}
          </div>
        </div>

        {loading ? (
          <div className="px-5 py-6 text-sm text-gray-500">Loading…</div>
        ) : view === 'list' ? (
          <TimeList year={year} requests={requests} overtime={overtime} companyDays={companyDays}
            bankHolidaysToBook={bh.toBook} freshIds={freshIds}
            onWithdraw={withdraw} onCancelOvertime={cancelOvertime}
            onBook={isPastYear ? undefined : (d) => openBooking('holiday', d)} />
        ) : (
          <TimeCalendar month={calMonth}
            onMonth={(next) => {
              // Data is fetched per leave year, so crossing 31 December
              // switches the year rather than showing an empty month.
              setCalMonth(next);
              if (next.y !== year) setYear(next.y);
            }}
            onThisMonth={() => changeYear(CURRENT_YEAR)}
            requests={requests} overtime={overtime} companyDays={companyDays}
            bankHolidays={bankHolidays} bankHolidaysToBook={bh.toBook}
            onBook={isPastYear ? undefined : (d) => openBooking('holiday', d)} />
        )}
      </section>
    </div>
  );
}

function BookTimeOff({ balances, seedDate, initialType = 'holiday', onClose, onBooked, onError }: {
  balances: MyBalances | null;
  /** The date the form opens on — today, or 1 January of the year being viewed. */
  seedDate: string;
  /** Which button opened it: "Book holiday" or "Use overtime as time off". */
  initialType?: LeaveType;
  onClose: () => void;
  onBooked: (msg: string) => Promise<void>; onError: (msg: string) => void;
}) {
  const [leaveType, setLeaveType] = useState<LeaveType>(initialType);
  // Opens below the logger, which on a phone is off-screen — bring it into view.
  const panelRef = useRef<HTMLDivElement>(null);
  useEffect(() => { panelRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }); }, []);
  const [spanMode, setSpanMode] = useState<'days' | 'part'>('days');
  const [startDate, setStartDate] = useState(seedDate);
  const [endDate, setEndDate] = useState(seedDate);
  // A day can be whole, a half, or an actual period ("leaving at 15:00").
  const [dayParts, setDayParts] = useState<Record<string, DaySpec>>({});
  const [note, setNote] = useState('');
  const [impact, setImpact] = useState<Impact | null>(null);
  const [impactError, setImpactError] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const [saving, setSaving] = useState(false);

  // Keep the end date sane rather than letting an invalid range reach the API.
  useEffect(() => { if (endDate < startDate) setEndDate(startDate); }, [startDate, endDate]);

  // Part-of-a-day is always one date, and the times must follow it if the date
  // moves — otherwise dayParts still points at yesterday and the request costs
  // a whole day without saying why.
  useEffect(() => {
    if (spanMode !== 'part') return;
    setEndDate(startDate);
    setDayParts(prev => {
      const existing = Object.values(prev)[0];
      return { [startDate]: existing ?? { portion: 'hours', startTime: '15:00', endTime: '17:00' } };
    });
  }, [spanMode, startDate]);

  const dayPartsKey = useMemo(() => JSON.stringify(dayParts), [dayParts]);

  // A native time input reports "23" as 23:00 while you are still typing the
  // minutes, so every keystroke fired a request and a transient out-of-range
  // value blanked the panel. Validate locally first and say so, without asking
  // the server about something we already know is wrong.
  const localTimeError = useMemo(() => {
    if (spanMode !== 'part') return null;
    const p = Object.values(dayParts)[0];
    if (!p || p.portion !== 'hours') return null;
    if (!p.startTime || !p.endTime) return 'Set a start and an end time.';
    const toMin = (t: string) => {
      const [h, m] = t.split(':').map(Number);
      return (h || 0) * 60 + (m || 0);
    };
    if (toMin(p.endTime) <= toMin(p.startTime)) return 'The end time needs to be after the start.';
    return null;
  }, [spanMode, dayParts]);

  useEffect(() => {
    if (localTimeError) { setChecking(false); return; }
    let cancelled = false;
    setChecking(true);
    const t = setTimeout(async () => {
      try {
        const qs = new URLSearchParams({
          from: startDate, to: endDate, type: leaveType, halfDays: dayPartsKey,
        });
        const res = await api.get<{ data: Impact }>(`/staff-calendar/leave/impact?${qs}`);
        if (!cancelled) { setImpact(res.data); setImpactError(null); }
      } catch (err) {
        // The impact call failing is the usual reason Submit stays disabled.
        // Silently nulling it left the button greyed with nothing explaining
        // why — show what the server said instead.
        if (!cancelled) {
          setImpact(null);
          setImpactError(err instanceof Error ? err.message : 'Could not work out the impact');
        }
      } finally {
        if (!cancelled) setChecking(false);
      }
    }, 300);
    return () => { cancelled = true; clearTimeout(t); };
  }, [startDate, endDate, leaveType, dayPartsKey, localTimeError]);

  async function submit() {
    setSaving(true);
    try {
      await api.post('/staff-calendar/leave', {
        leaveType, startDate, endDate,
        halfDays: Object.keys(dayParts).length ? dayParts : undefined,
        note: note || null,
      });
      setNote(''); setDayParts({}); setImpact(null);
      await onBooked('Request submitted — you’ll hear when it’s been looked at.');
    } catch (err) {
      onError(err instanceof Error ? err.message : 'Failed to submit the request');
    } finally { setSaving(false); }
  }


  const blocked = localTimeError !== null
    || (impact?.ownClashes.length ?? 0) > 0
    || (impact?.workingDays ?? 0) === 0;

  return (
    <div ref={panelRef} className="p-5 rounded-2xl sm:rounded-xl border border-gray-200 bg-white scroll-mt-4">
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-[17px] font-semibold text-gray-900">Book time off</h2>
        <button onClick={onClose} className="text-sm text-gray-500 hover:text-gray-700">Cancel</button>
      </div>

      <div className="mb-3">
        <span className="block text-xs text-gray-600 mb-1">How much time?</span>
        <div className="flex rounded border border-gray-300 overflow-hidden text-xs w-fit">
          {([['days', 'Whole days'], ['part', 'Part of a day']] as const).map(([m, label]) => (
            <button key={m}
              onClick={() => {
                setSpanMode(m);
                if (m === 'part') {
                  setEndDate(startDate);
                  setDayParts({ [startDate]: { portion: 'hours', startTime: '15:00', endTime: '17:00' } });
                } else {
                  setDayParts({});
                }
              }}
              className={`px-3 py-1.5 ${spanMode === m ? 'bg-ooosh-600 text-white' : 'bg-white text-gray-700 hover:bg-gray-50'}`}>
              {label}
            </button>
          ))}
        </div>
        {spanMode === 'part' && (
          <p className="mt-1 text-xs text-gray-500">
            For an hour or two — an early finish, a late start, or an appointment.
          </p>
        )}
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 mb-3">
        <label className="text-sm">
          <span className="block text-xs text-gray-600 mb-1">Type</span>
          <select value={leaveType} onChange={e => setLeaveType(e.target.value as LeaveType)}
            className="w-full px-2 py-1.5 border border-gray-300 rounded text-sm">
            {/* The balance is in the label so the choice between holiday and
                overtime is made with both figures visible, not from memory. */}
            <option value="holiday">
              Holiday{balances ? ` — ${fmtH(balances.holiday.availableMinutes)} left` : ''}
            </option>
            <option value="toil">
              Overtime as time off{balances ? ` — ${fmtH(balances.overtime.availableMinutes)} banked` : ''}
            </option>
            <option value="unpaid">Unpaid leave</option>
          </select>
        </label>
        <label className="text-sm">
          <span className="block text-xs text-gray-600 mb-1">From</span>
          <input type="date" value={startDate} onChange={e => setStartDate(e.target.value)}
            className="w-full px-2 py-1.5 border border-gray-300 rounded text-sm" />
        </label>
        {spanMode === 'days' && (
          <label className="text-sm">
            <span className="block text-xs text-gray-600 mb-1">To</span>
            <input type="date" value={endDate} min={startDate} onChange={e => setEndDate(e.target.value)}
              className="w-full px-2 py-1.5 border border-gray-300 rounded text-sm" />
          </label>
        )}
      </div>

      {spanMode === 'part' && (
        <div className="mb-3 flex flex-wrap items-end gap-2">
          <label className="text-sm">
            <span className="block text-xs text-gray-600 mb-1">From</span>
            <input type="time" step={300}
              value={Object.values(dayParts)[0]?.startTime ?? '15:00'}
              onChange={e => setDayParts({ [startDate]: {
                ...(Object.values(dayParts)[0] ?? { portion: 'hours' as const }),
                portion: 'hours', startTime: e.target.value } })}
              className="px-2 py-1.5 border border-gray-300 rounded text-sm" />
          </label>
          <label className="text-sm">
            <span className="block text-xs text-gray-600 mb-1">To</span>
            <input type="time" step={300}
              value={Object.values(dayParts)[0]?.endTime ?? '17:00'}
              onChange={e => setDayParts({ [startDate]: {
                ...(Object.values(dayParts)[0] ?? { portion: 'hours' as const }),
                portion: 'hours', endTime: e.target.value } })}
              className="px-2 py-1.5 border border-gray-300 rounded text-sm" />
          </label>
          {impact && impact.totalMinutes > 0 && (
            <span className="pb-2 text-sm text-gray-700">= {fmtH(impact.totalMinutes)}</span>
          )}
        </div>
      )}

      {spanMode === 'days' && impact && impact.days.length > 0 && impact.days.length <= 14 && (
        <div className="mb-3">
          <span className="block text-xs text-gray-600 mb-1">
            Days — click to switch between a whole day, a half, or set times
          </span>
          <div className="space-y-1.5">
            {impact.days.map(d => {
              const spec = dayParts[d.date] ?? { portion: 'full' as const };
              const cycle: DaySpec['portion'][] = ['full', 'am', 'pm', 'hours'];
              const next = cycle[(cycle.indexOf(spec.portion) + 1) % cycle.length];
              return (
                <div key={d.date} className="flex flex-wrap items-center gap-2">
                  <button
                    onClick={() => setDayParts(prev => {
                      const n = { ...prev };
                      if (next === 'full') delete n[d.date];
                      else if (next === 'hours') n[d.date] = { portion: 'hours', startTime: '15:00', endTime: '17:00' };
                      else n[d.date] = { portion: next };
                      return n;
                    })}
                    className={`px-2 py-1 rounded border text-xs min-w-[8.5rem] text-left ${
                      spec.portion === 'full'
                        ? 'border-gray-300 bg-white text-gray-700'
                        : 'border-ooosh-300 bg-ooosh-50 text-ooosh-800'}`}>
                    {fmtDate(d.date)}
                    <span className="ml-1 font-medium">
                      {spec.portion === 'full' ? 'whole day'
                        : spec.portion === 'am' ? 'morning'
                        : spec.portion === 'pm' ? 'afternoon' : 'set times'}
                    </span>
                  </button>

                  {spec.portion === 'hours' && (
                    <span className="flex items-center gap-1 text-xs">
                      <input type="time" step={300} value={spec.startTime ?? '15:00'}
                        onChange={e => setDayParts(p => ({ ...p, [d.date]: { ...spec, startTime: e.target.value } }))}
                        className="px-1.5 py-1 border border-gray-300 rounded text-xs" />
                      <span className="text-gray-400">to</span>
                      <input type="time" step={300} value={spec.endTime ?? '17:00'}
                        onChange={e => setDayParts(p => ({ ...p, [d.date]: { ...spec, endTime: e.target.value } }))}
                        className="px-1.5 py-1 border border-gray-300 rounded text-xs" />
                    </span>
                  )}

                  <span className="text-xs text-gray-500">{fmtH(d.minutes)}</span>
                </div>
              );
            })}
          </div>
        </div>
      )}

      <label className="block text-sm mb-3">
        <span className="block text-xs text-gray-600 mb-1">Note (optional)</span>
        <input value={note} onChange={e => setNote(e.target.value)}
          placeholder="Anything worth saying?"
          className="w-full px-2 py-1.5 border border-gray-300 rounded text-sm" />
      </label>

      <ImpactPanel impact={impact} checking={checking} leaveType={leaveType}
        error={localTimeError ?? impactError} />

      <button onClick={() => void submit()} disabled={saving || checking || blocked}
        className="mt-3 px-3 py-2 text-sm rounded bg-ooosh-600 text-white hover:bg-ooosh-700 disabled:opacity-50">
        {saving ? 'Submitting…' : 'Submit request'}
      </button>
      {blocked && impact && (
        <p className="mt-1.5 text-xs text-red-600">
          {impact.ownClashes.length > 0
            ? 'Pick dates you haven’t already booked.'
            : 'None of those dates are days you’re contracted to work.'}
        </p>
      )}
    </div>
  );
}

export function ImpactPanel({ impact, checking, leaveType, error }: {
  impact: Impact | null; checking: boolean; leaveType: LeaveType; error?: string | null;
}) {
  // Keep the panel in place whatever happens. It used to return null the
  // moment the impact call failed — so typing a time outside someone's working
  // day made the whole summary disappear mid-keystroke, with the reason
  // tucked away below the button. The box stays; the message goes inside it.
  if (error) {
    return (
      <div className="p-3 rounded border border-amber-200 bg-amber-50 text-sm text-amber-900">
        {error}
      </div>
    );
  }
  if (!impact) {
    return (
      <div className="p-3 rounded border border-gray-200 bg-gray-50/70 text-sm text-gray-500">
        {checking ? 'Checking…' : 'Pick your dates and times to see what this costs.'}
      </div>
    );
  }

  const days = impact.nominalDayMinutes
    ? (impact.totalMinutes / impact.nominalDayMinutes).toFixed(1) : null;

  return (
    <div className="p-3 rounded border border-gray-200 bg-gray-50/70">
      <div className="flex flex-wrap gap-x-5 gap-y-1 text-sm">
        <span>
          <span className="text-gray-600">This costs:</span>{' '}
          <span className="font-medium text-gray-900">{fmtH(impact.totalMinutes)}</span>
          {days && <span className="text-gray-500"> ({days} days)</span>}
        </span>
        {leaveType === 'unpaid' ? (
          <span className="text-gray-500">Unpaid — nothing comes off your allowance.</span>
        ) : impact.balanceBefore !== null && (
          <span>
            <span className="text-gray-600">Balance:</span>{' '}
            <span className="font-medium text-gray-900">{fmtH(impact.balanceBefore)}</span>
            <span className="text-gray-400"> → </span>
            <span className={`font-medium ${impact.balanceAfter! < 0 ? 'text-red-700' : 'text-gray-900'}`}>
              {fmtH(impact.balanceAfter!)}
            </span>
          </span>
        )}
      </div>

      {impact.clashes.length > 0 && (
        <div className="mt-2 text-xs text-gray-600">
          <span className="text-gray-500">Also off:</span>{' '}
          {impact.clashes.map(c => `${fmtDate(c.date)} — ${c.people.join(', ')}`).join(' · ')}
        </div>
      )}

      {impact.warnings.length > 0 && (
        <ul className="mt-2 space-y-1">
          {impact.warnings.map((w, i) => (
            <li key={i} className="text-xs text-amber-800 flex gap-1.5">
              <span aria-hidden>⚠</span><span>{w}</span>
            </li>
          ))}
        </ul>
      )}

      {impact.warnings.length === 0 && impact.workingDays > 0 && (
        <p className="mt-2 text-xs text-emerald-700">No clashes, and cover looks fine.</p>
      )}
    </div>
  );
}

// ── Balances, up front ──────────────────────────────────────────────────────

/**
 * What to say about the leave year — the old YearNudge, now the caption of the
 * Leave year card.
 *
 * The single most useful thing this page can say, and the one a list of past
 * requests cannot: NOTHING CARRIES OVER (spec §5.1), so holiday not booked by
 * 31 December is simply gone. A balance on its own does not convey that; a
 * balance next to the weeks remaining does.
 */
function yearCaption(balances: MyBalances, year: number): { text: string; urgent: boolean } {
  const left = balances.holiday.availableMinutes;
  const { granted } = deriveParts(balances);
  const leftDays = asDays(left, balances.holiday.nominalDayMinutes);
  const isCurrentYear = year === CURRENT_YEAR;
  const isFutureYear = year > CURRENT_YEAR;

  if (left < 0) {
    return { text: `You are ${fmtH(-left)} over your ${year} allowance. Worth a word with a manager.`, urgent: true };
  }
  if (left === 0 && granted === 0) {
    // Zero LEFT and zero ALLOWANCE are different facts and the old copy read
    // them the same, telling anyone looking at a future year that all of it
    // was "booked or taken" when none of it had been granted.
    return {
      text: `No ${year} allowance has been worked out yet.${isFutureYear
        ? ' It is set automatically — if this is still empty tomorrow, tell an admin.'
        : ' If that looks wrong, tell an admin — it hangs off your working pattern.'}`,
      urgent: false,
    };
  }
  if (left === 0) return { text: `All of your ${year} holiday is booked or taken.`, urgent: false };
  if (isCurrentYear) {
    const weeks = weeksLeftInYear(year);
    return {
      text: weeks > 0 ? 'Use it by 31 Dec — nothing carries over.' : `${year} is nearly over, and nothing carries over.`,
      urgent: weeks <= 8,
    };
  }
  if (isFutureYear) return { text: `Already set aside for ${year}. You can book against it now.`, urgent: false };
  return { text: `${leftDays !== null ? `${leftDays} days` : fmtH(left)} unused at the end of ${year}.`, urgent: false };
}

function YearSelect({ year, onYear, className = '' }: {
  year: number; onYear: (y: number) => void; className?: string;
}) {
  // Two back is enough: nothing carries over, so an older year is history
  // rather than something to act on, and the list should not grow forever.
  return (
    <select value={year} onChange={e => onYear(Number(e.target.value))} aria-label="Leave year"
      className={`px-2 py-1 rounded-md border border-gray-300 text-[13px] text-gray-900 bg-white ${className}`}>
      {YEARS.map(y => (
        <option key={y} value={y}>{y}{y === CURRENT_YEAR ? ' (this year)' : ''}</option>
      ))}
    </select>
  );
}

/**
 * Holiday left, overtime banked, and how much of the leave year remains.
 *
 * Shown before any dates are picked, because the choice between "take a
 * holiday" and "use some overtime" is only a real choice if both numbers are
 * visible at the moment of deciding. Desktop only; a phone gets MobileTiles.
 */
function StatCards({ balances, year, onYear, pendingOvertime }: {
  balances: MyBalances | null; year: number; onYear: (y: number) => void; pendingOvertime: number;
}) {
  const card = 'bg-white border border-gray-200 rounded-xl p-5 flex flex-col gap-3';
  const label = 'text-[13px] font-medium text-gray-500';
  const big = 'text-[40px] leading-none font-semibold tracking-[-0.02em] tabular-nums';

  if (!balances) {
    // Keep the year picker reachable even with nothing to show — the empty
    // state for one year must not strand someone who wants to look at another.
    return (
      <div className="hidden sm:flex justify-end">
        <YearSelect year={year} onYear={onYear} />
      </div>
    );
  }

  const p = deriveParts(balances);
  const hol = balances.holiday;
  const nominal = hol.nominalDayMinutes;
  const holDays = asDays(hol.availableMinutes, nominal);
  const bookedPct = p.holidayAllowance > 0
    ? Math.min(100, Math.max(0, (p.holidayTaken / p.holidayAllowance) * 100)) : 0;

  const ot = balances.overtime;
  const otDays = asDays(ot.availableMinutes, ot.nominalDayMinutes);
  // Three segments, all out of what was ever earned plus what is waiting.
  const otTotal = Math.max(0, p.toilBanked) + pendingOvertime;
  const pct = (m: number) => otTotal > 0 ? `${(Math.max(0, m) / otTotal) * 100}%` : '0%';
  const otUsed = p.toilTaken + p.toilPaid;

  const isCurrentYear = year === CURRENT_YEAR;
  const caption = yearCaption(balances, year);
  // Share of the calendar year already gone, for the Leave year bar.
  const elapsedPct = year < CURRENT_YEAR ? 100 : year > CURRENT_YEAR ? 0
    : ((Date.UTC(year, Number(TODAY.slice(5, 7)) - 1, Number(TODAY.slice(8, 10))) - Date.UTC(year, 0, 1))
      / (Date.UTC(year + 1, 0, 1) - Date.UTC(year, 0, 1))) * 100;

  return (
    <div className="hidden sm:grid grid-cols-3 gap-4">
      <div className={card}>
        <div className={label}>Holiday left</div>
        <div className="flex items-baseline justify-between gap-2">
          <div className="flex items-baseline gap-1.5">
            <span className={`${big} ${hol.availableMinutes < 0 ? 'text-red-700' : 'text-gray-900'}`}>
              {holDays ?? fmtH(hol.availableMinutes)}
            </span>
            {holDays !== null && <span className="text-[17px] text-gray-700">days</span>}
          </div>
          {holDays !== null && <span className="text-[13px] text-gray-500 tabular-nums">{fmtH(hol.availableMinutes)}</span>}
        </div>
        <div className="h-2 rounded-full bg-ooosh-200 overflow-hidden">
          <div className="h-full bg-ooosh-600 rounded-full" style={{ width: `${bookedPct}%` }} />
        </div>
        <div className="flex justify-between gap-2 text-xs text-gray-500">
          <span>
            {p.holidayTaken === 0 ? 'Nothing booked yet'
              : `${asDays(p.holidayTaken, nominal) ?? fmtH(p.holidayTaken)}${nominal ? ' days' : ''} booked`}
          </span>
          <span>of {asDays(p.holidayAllowance, nominal) ?? fmtH(p.holidayAllowance)}{nominal ? ' days' : ''} for {year}</span>
        </div>
      </div>

      <div className={card}>
        <div className={label}>Overtime in the bank</div>
        <div className="flex items-baseline justify-between gap-2">
          <div className="flex items-baseline gap-1.5">
            <span className={`${big} ${ot.availableMinutes < 0 ? 'text-red-700' : 'text-gray-900'}`}>
              {fmtH(ot.availableMinutes)}
            </span>
            {otDays !== null && <span className="text-[17px] text-gray-700">{otDays} days</span>}
          </div>
          {pendingOvertime > 0 && (
            <span className="text-[13px] text-amber-800 whitespace-nowrap">+{fmtH(pendingOvertime)} waiting</span>
          )}
        </div>
        <div className="h-2 rounded-full bg-gray-100 flex gap-0.5 overflow-hidden">
          {otUsed > 0 && <div className="h-full bg-slate-300" style={{ width: pct(otUsed) }} />}
          {ot.availableMinutes > 0 && <div className="h-full bg-ooosh-600" style={{ width: pct(ot.availableMinutes) }} />}
          {pendingOvertime > 0 && (
            <div className="h-full" style={{
              width: pct(pendingOvertime),
              background: 'repeating-linear-gradient(135deg,#fbbf24 0 4px,#fde68a 4px 8px)',
            }} />
          )}
        </div>
        <div className="flex flex-wrap gap-x-4 gap-y-0.5 text-xs text-gray-500">
          <span>Earned {fmtH(p.toilBanked)}</span>
          <span>Taken as time off {fmtH(p.toilTaken)}</span>
          <span>Paid out {fmtH(p.toilPaid)}</span>
        </div>
      </div>

      <div className={card}>
        <div className="flex items-center justify-between gap-2">
          <div className={label}>Leave year</div>
          <YearSelect year={year} onYear={onYear} />
        </div>
        <div className="flex items-baseline gap-1.5">
          {isCurrentYear ? (
            <>
              <span className={`${big} text-gray-900`}>{weeksLeftInYear(year)}</span>
              <span className="text-[17px] text-gray-700">weeks left</span>
            </>
          ) : (
            <span className="text-[28px] leading-10 font-semibold text-gray-900">
              {year < CURRENT_YEAR ? 'Finished' : 'Not started'}
            </span>
          )}
        </div>
        <div className="relative h-2 rounded-full bg-gray-200">
          <div className="h-full bg-slate-400 rounded-full" style={{ width: `${elapsedPct}%` }} />
          {isCurrentYear && (
            <div className="absolute -top-1 w-0.5 h-4 bg-gray-900" style={{ left: `${elapsedPct}%` }} />
          )}
        </div>
        <div className={`text-xs ${caption.urgent ? 'text-amber-800' : 'text-gray-500'}`}>{caption.text}</div>
      </div>
    </div>
  );
}

/** The phone's version of the balances: two tiles, under the logger. */
function MobileTiles({ balances, year, onYear, pendingOvertime }: {
  balances: MyBalances | null; year: number; onYear: (y: number) => void; pendingOvertime: number;
}) {
  const hol = balances?.holiday;
  const holDays = hol ? asDays(hol.availableMinutes, hol.nominalDayMinutes) : null;
  const weeks = weeksLeftInYear(year);
  const caption = balances ? yearCaption(balances, year) : null;
  return (
    <div className="sm:hidden flex flex-col gap-2.5">
      {balances && hol && (
        <div className="grid grid-cols-2 gap-2.5">
          <div className="bg-white border border-gray-200 rounded-[14px] p-3.5">
            <div className="text-xs text-gray-500">Holiday left</div>
            <div className={`mt-1 text-[28px] font-semibold tabular-nums ${hol.availableMinutes < 0 ? 'text-red-700' : 'text-gray-900'}`}>
              {holDays ?? fmtH(hol.availableMinutes)}
              {holDays !== null && <span className="text-sm font-normal text-gray-600"> days</span>}
            </div>
            <div className={`text-xs ${caption?.urgent ? 'text-amber-800' : 'text-gray-500'}`}>
              {year === CURRENT_YEAR && weeks > 0 && (hol.availableMinutes > 0)
                ? `${weeks} week${weeks === 1 ? '' : 's'} to use it` : caption?.text}
            </div>
          </div>
          <div className="bg-white border border-gray-200 rounded-[14px] p-3.5">
            <div className="text-xs text-gray-500">Overtime bank</div>
            <div className="mt-1 text-[28px] font-semibold tabular-nums text-gray-900">
              {fmtH(balances.overtime.availableMinutes)}
            </div>
            {pendingOvertime > 0 && <div className="text-xs text-amber-800">+{fmtH(pendingOvertime)} waiting</div>}
          </div>
        </div>
      )}
      <label className="flex items-center justify-end gap-2 text-xs text-gray-500">
        Leave year <YearSelect year={year} onYear={onYear} className="h-9" />
      </label>
    </div>
  );
}

// ── Overtime ────────────────────────────────────────────────────────────────

const HOURS = Array.from({ length: 24 }, (_, i) => i);
// Five-minute steps only. `staff_overtime_entries` has a `minutes % 5 = 0`
// CHECK, and `<input type="time" step={300}>` never enforced that — Chrome's
// picker lists all sixty minutes whatever the step says (see frontend.md,
// "Time inputs"). Owning the options is what makes both ends land on the grid.
const MINUTES = Array.from({ length: 12 }, (_, i) => i * 5);
const LAST_SLOT = 23 * 60 + 55;
/** How far past "now" an end time may be on today's date — enough to log
 *  "until 18:00" at 17:55 on the way out of the door, no more. */
const FUTURE_GRACE_MIN = 15;
/** Used when there is no working pattern to read a finish time from. */
const FALLBACK_FINISH = 17 * 60;

const toMin = (t: string) => {
  const [h, m] = t.split(':').map(Number);
  return (h || 0) * 60 + (m || 0);
};
const hhmm = (min: number) =>
  `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;
/** Onto the five-minute grid, rounding up — a select whose value matches no
 *  option renders blank. */
const onGrid = (min: number) => Math.min(LAST_SLOT, Math.ceil(min / 5) * 5);

function TimePair({ label, value, onChange }: {
  label: string; value: number; onChange: (min: number) => void;
}) {
  const h = Math.floor(value / 60), m = value % 60;
  const sel = 'h-12 sm:h-auto px-2 py-[9px] border border-gray-300 rounded-lg text-[17px] sm:text-[15px] tabular-nums bg-white';
  return (
    <div className="flex-1 sm:flex-none">
      <span className="block text-xs text-gray-600 mb-1">{label}</span>
      <div className="flex items-center gap-1">
        <select aria-label={`${label} hour`} value={h} onChange={e => onChange(Number(e.target.value) * 60 + m)}
          className={`${sel} flex-1 sm:flex-none`}>
          {HOURS.map(x => <option key={x} value={x}>{String(x).padStart(2, '0')}</option>)}
        </select>
        <span className="font-semibold text-gray-500">:</span>
        <select aria-label={`${label} minute`} value={m} onChange={e => onChange(h * 60 + Number(e.target.value))}
          className={`${sel} flex-1 sm:flex-none`}>
          {MINUTES.map(x => <option key={x} value={x}>{String(x).padStart(2, '0')}</option>)}
        </select>
      </div>
    </div>
  );
}

/**
 * Log overtime — always open, no button to reveal it.
 *
 * The typical case is next morning, on a phone, so every step is a tap: a day
 * chip, two pairs of dropdowns that start at your usual finish, a preset, a
 * reason, done. Times rather than a bare number of minutes, because that is
 * how people remember it ("I came in at eight") and it is the more checkable
 * record. (The "just minutes" fallback was dropped in the Sep 2026 redesign —
 * the presets cover "about an hour".)
 *
 * Exported so the mobile Quick Actions page can mount the SAME form.
 * Logging overtime after a late finish is the single most time-sensitive thing
 * staff do here, and it was three clicks deep behind the avatar menu.
 */
export function LogOvertime({ onLogged, onUndone, onError }: {
  /** Kept for callers that still pass it; the form has no Cancel of its own. */
  onClose?: () => void;
  onLogged: (msg: string, id?: string) => Promise<void>;
  onUndone?: () => Promise<void>;
  onError: (msg: string) => void;
}) {
  // Worked out on mount, in local time — see localIso().
  const today = useMemo(() => localIso(new Date()), []);
  const yesterday = addDaysIso(today, -1);
  const earliest = addDaysIso(today, -90);
  // Today first, then back a day at a time for a fortnight.
  const chips = useMemo(() => Array.from({ length: 14 }, (_, i) => {
    const date = addDaysIso(today, -i);
    return {
      date,
      label: i === 0 ? 'Today' : i === 1 ? 'Yesterday' : datePart(date, { weekday: 'short' }),
      sub: datePart(date, { day: 'numeric', month: 'short' }),
    };
  }), [today]);

  const [workDate, setWorkDate] = useState(today);
  const [earlier, setEarlier] = useState<string | null>(null);
  const [startMin, setStartMin] = useState(FALLBACK_FINISH);
  const [endMin, setEndMin] = useState(FALLBACK_FINISH + 60);
  // Once somebody has set a time themselves, changing the day leaves it alone.
  const [touched, setTouched] = useState(false);
  const [finishes, setFinishes] = useState<Record<string, number>>({});
  const [starts, setStarts] = useState<Record<string, number>>({});
  const [reason, setReason] = useState('');
  const [saving, setSaving] = useState(false);
  const [lastLogged, setLastLogged] = useState<{ id: string; text: string } | null>(null);
  const stripRef = useRef<HTMLDivElement>(null);
  const earlierRef = useRef<HTMLInputElement>(null);

  // Your contracted start and finish on each recent day, from your own calendar — which
  // already knows about two-week cycles, swaps and hours changes. Failure is
  // silent: the form simply starts at 17:00.
  useEffect(() => {
    let cancelled = false;
    api.get<{ data: { days: { date: string; startTime: string | null; endTime: string | null }[] } | null }>(
      `/staff-calendar/me?from=${earliest}&to=${today}`)
      .then(res => {
        if (cancelled || !res.data) return;
        const ends: Record<string, number> = {};
        const begins: Record<string, number> = {};
        for (const d of res.data.days) {
          if (d.endTime) ends[d.date] = toMin(d.endTime);
          if (d.startTime) begins[d.date] = toMin(d.startTime);
        }
        setFinishes(ends);
        setStarts(begins);
      })
      .catch(() => { /* no staff record or no pattern — keep the default */ });
    return () => { cancelled = true; };
  }, [earliest, today]);

  // The finish for a day you did not work normally (a Saturday gig) is your
  // most common finish, which beats a flat 17:00 for anyone on a late shift.
  const usualFinish = useMemo(() => {
    const counts = new Map<number, number>();
    for (const m of Object.values(finishes)) counts.set(m, (counts.get(m) ?? 0) + 1);
    let best = FALLBACK_FINISH, n = 0;
    counts.forEach((c, m) => { if (c > n) { best = m; n = c; } });
    return best;
  }, [finishes]);

  useEffect(() => {
    if (touched) return;
    // Today, before your finish: a late finish cannot be logged yet, so the
    // likelier entry is an early start — the hour before you were due in.
    const nowD = new Date();
    const finish = finishes[workDate] ?? usualFinish;
    const due = starts[workDate];
    if (workDate === localIso(nowD) && due !== undefined && due >= 60
      && nowD.getHours() * 60 + nowD.getMinutes() < finish) {
      const s = onGrid(due - 60);
      setStartMin(s);
      setEndMin(Math.min(LAST_SLOT, s + 60));
      return;
    }
    const start = onGrid(finish);
    setStartMin(start);
    setEndMin(Math.min(LAST_SLOT, start + 60));
  }, [workDate, finishes, starts, usualFinish, touched]);

  const duration = endMin - startMin;
  // Both ends are on the grid now, so this is a no-op — kept as a guard.
  const snapped = duration > 0 ? Math.ceil(duration / 5) * 5 : 0;

  // Evaluated on every render, so "now" is always current.
  const now = new Date();
  const nowMin = now.getHours() * 60 + now.getMinutes();
  const isToday = workDate === localIso(now);
  const timeError =
    duration <= 0 ? 'end before start'
    : snapped > 960 ? 'more than 16 hours'
    // Overtime that has not happened yet is a mistake, not a judgement call —
    // so unlike the leave warnings, this one blocks.
    : isToday && endMin > nowMin + FUTURE_GRACE_MIN ? 'that’s still to come'
    : null;
  const valid = timeError === null && reason.trim() !== '';

  const dayWord = workDate === today ? 'today' : workDate === yesterday ? 'yesterday' : fmtDate(workDate);

  function pickDate(d: string) {
    if (!d || d > today || d < earliest) return;
    setWorkDate(d);
    setEarlier(chips.some(c => c.date === d) ? null : d);
  }

  async function save() {
    if (!valid) return;
    setSaving(true);
    try {
      const res = await api.post<{ data: { id: string } }>('/staff-calendar/overtime', {
        workDate,
        startTime: hhmm(startMin),
        endTime: hhmm(endMin),
        minutes: snapped,
        reason: reason.trim(),
      });
      setReason('');
      setLastLogged({
        id: res.data.id,
        text: `Logged ${fmtH(snapped)} for ${fmtDate(workDate)} — it lands in your bank once approved.`,
      });
      await onLogged('Overtime logged — it’ll be added to your bank once approved.', res.data.id);
    } catch (err) {
      onError(err instanceof Error ? err.message : 'Failed to log the overtime');
    } finally { setSaving(false); }
  }

  async function undo() {
    if (!lastLogged) return;
    try {
      await api.post(`/staff-calendar/overtime/${lastLogged.id}/cancel`, {});
      setLastLogged(null);
      await onUndone?.();
    } catch (err) {
      onError(err instanceof Error ? err.message : 'Failed to undo');
    }
  }

  const chipBase = 'shrink-0 min-w-[76px] sm:min-w-[70px] h-[54px] sm:h-auto px-3 py-[7px] rounded-[10px] sm:rounded-lg border text-left';
  const chipOn = 'bg-ooosh-600 border-ooosh-600 text-white';
  const chipOff = 'bg-white border-gray-300 text-gray-900 hover:border-gray-400';
  const arrow = 'hidden sm:flex shrink-0 w-9 items-center justify-center rounded-lg border border-gray-200 bg-white text-lg text-gray-700 hover:bg-gray-50';

  return (
    <div className="h-full bg-white border border-gray-200 rounded-2xl sm:rounded-xl p-[18px] sm:px-5 sm:pt-5 sm:pb-[18px] flex flex-col gap-3.5">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <div className="flex flex-wrap items-baseline gap-x-2.5">
          <h2 className="text-[17px] font-semibold text-gray-900">Log overtime</h2>
          <span className="text-[13px] text-gray-500">Worked late or came in early? It goes into your bank once approved.</span>
        </div>
        <span className="text-xs text-gray-400">Early start and late finish = two entries</span>
      </div>

      <div>
        <span className="block text-xs text-gray-600 mb-1">Day</span>
        <div className="flex items-stretch gap-1.5">
          {/* ‹ goes back toward Today; › further into the past. */}
          <button type="button" aria-label="Towards today" className={arrow}
            onClick={() => stripRef.current?.scrollBy({ left: -320, behavior: 'smooth' })}>‹</button>
          <div ref={stripRef} className="flex-1 flex gap-1.5 overflow-x-auto scrollbar-hide">
            {chips.map(c => (
              <button key={c.date} type="button" onClick={() => pickDate(c.date)}
                aria-pressed={workDate === c.date}
                className={`${chipBase} ${workDate === c.date ? chipOn : chipOff}`}>
                <span className="block text-[13px] font-semibold">{c.label}</span>
                <span className="block text-[11px] opacity-80">{c.sub}</span>
              </button>
            ))}
            <div className="relative shrink-0">
              <button type="button"
                onClick={() => {
                  // showPicker() opens the calendar from our own button;
                  // browsers without it fall back to focusing the input.
                  const el = earlierRef.current as (HTMLInputElement & { showPicker?: () => void }) | null;
                  try { el?.showPicker ? el.showPicker() : el?.focus(); } catch { el?.focus(); }
                }}
                className={`${chipBase} min-w-[96px] sm:min-w-[96px] ${earlier && workDate === earlier
                  ? chipOn : 'bg-white border-dashed border-gray-300 text-gray-900 hover:border-gray-400'}`}>
                <span className="block text-[13px] font-semibold">
                  {earlier ? datePart(earlier, { weekday: 'short' }) : 'Earlier…'}
                </span>
                <span className="block text-[11px] opacity-80">
                  {earlier ? datePart(earlier, { day: 'numeric', month: 'short' }) : 'pick a date'}
                </span>
              </button>
              <input ref={earlierRef} type="date" tabIndex={-1} aria-label="Pick an earlier date"
                min={earliest} max={today} value={earlier ?? ''}
                onChange={e => pickDate(e.target.value)}
                className="absolute inset-0 w-full h-full opacity-0 pointer-events-none" />
            </div>
          </div>
          <button type="button" aria-label="Further back" className={arrow}
            onClick={() => stripRef.current?.scrollBy({ left: 320, behavior: 'smooth' })}>›</button>
        </div>
      </div>

      <div className="flex flex-wrap items-end gap-x-5 gap-y-3">
        <div className="flex gap-3 w-full sm:w-auto">
          <TimePair label="From" value={startMin} onChange={v => { setTouched(true); setStartMin(v); }} />
          <TimePair label="To" value={endMin} onChange={v => { setTouched(true); setEndMin(v); }} />
        </div>
        <div className="flex items-center gap-2 w-full sm:w-auto sm:pb-2">
          {[30, 60, 120].map(n => (
            <button key={n} type="button"
              onClick={() => { setTouched(true); setEndMin(Math.min(LAST_SLOT, startMin + n)); }}
              className="flex-1 sm:flex-none h-11 sm:h-auto px-[9px] py-[5px] rounded-full border border-ooosh-200 bg-ooosh-50 text-ooosh-700 text-xs font-medium hover:bg-ooosh-100">
              +{fmtH(n)}
            </button>
          ))}
          <span className={`ml-auto sm:ml-2 whitespace-nowrap text-[15px] font-semibold ${timeError ? 'text-red-600' : 'text-gray-900'}`}>
            {timeError ?? `= ${fmtH(snapped)}`}
          </span>
        </div>
      </div>

      <div className="flex flex-col sm:flex-row gap-3">
        <input value={reason} onChange={e => setReason(e.target.value)}
          aria-label="What were you doing?"
          placeholder="What were you doing? e.g. in early for the Gary Numan load-out"
          className="flex-1 h-12 sm:h-auto px-3 py-2.5 border border-gray-300 rounded-lg text-base sm:text-[15px]" />
        <button type="button" onClick={() => void save()} disabled={saving || !valid}
          className={`h-[52px] sm:h-auto sm:py-2.5 px-5 rounded-xl sm:rounded-lg text-[17px] sm:text-[15px] font-semibold text-white whitespace-nowrap ${
            valid ? 'bg-ooosh-600 hover:bg-ooosh-700' : 'bg-slate-300 cursor-not-allowed'}`}>
          {saving ? 'Logging…'
            : timeError ? 'Check your times'
            : !reason.trim() ? 'Say what you were doing'
            : `Log ${fmtH(snapped)} for ${dayWord}`}
        </button>
      </div>

      {timeError === 'that’s still to come' && (
        <p className="-mt-1.5 text-xs text-red-600">
          It&apos;s {hhmm(nowMin)} now — log it once you&apos;ve done it.
        </p>
      )}

      {lastLogged && (
        <div className="flex items-center justify-between gap-3 px-3 py-2.5 rounded-lg border border-emerald-200 bg-emerald-50 text-sm text-emerald-800">
          <span>{lastLogged.text}</span>
          <button type="button" onClick={() => void undo()} className="font-semibold hover:underline">Undo</button>
        </div>
      )}
    </div>
  );
}

// ── Your time: one timeline, as a list or a month ───────────────────────────

interface TimeRow {
  key: string;
  /** Where it sorts and which date block it shows. */
  date: string;
  /** Last date it covers — decides "coming up" vs "earlier". */
  until: string;
  title: string;
  meta: string;
  extra?: string | null;
  amount: string;
  amountClass: string;
  pill: string;
  pillClass: string;
  /** The same status as a line of text, for a phone that drops the pill. */
  statusClass: string;
  dot: string;
  fresh?: boolean;
  action?: { label: string; onClick: () => void; className: string };
}

const statusWord = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const DEAD = new Set(['declined', 'cancelled', 'withdrawn']);

/**
 * Leave requests, overtime, company days and bank holidays not yet booked, as
 * one date-sorted list. From where somebody is standing the office being shut
 * IS time off — they just did not have to ask for it and it cost nothing — so
 * it sits in the same list as their own bookings.
 */
function buildRows({ requests, overtime, companyDays, bankHolidaysToBook, freshIds, onWithdraw, onCancelOvertime, onBook }: {
  requests: LeaveRequest[]; overtime: OvertimeEntry[];
  companyDays: { date: string; label: string }[]; bankHolidaysToBook: string[]; freshIds: string[];
  onWithdraw: (id: string) => void; onCancelOvertime: (id: string) => void; onBook?: (date: string) => void;
}): TimeRow[] {
  const rows: TimeRow[] = [];

  for (const c of companyDays) {
    rows.push({
      key: `cd:${c.date}`, date: c.date, until: c.date,
      title: c.label, meta: 'Company day — the office is shut',
      amount: 'Free', amountClass: 'text-emerald-700',
      pill: 'Costs you nothing', pillClass: 'bg-emerald-100 text-emerald-800', statusClass: 'text-emerald-700',
      dot: 'bg-emerald-500',
    });
  }

  for (const d of bankHolidaysToBook) {
    rows.push({
      key: `bh:${d}`, date: d, until: d,
      title: 'Bank holiday', meta: 'A normal working day here — book it off if you want it',
      amount: '', amountClass: '',
      pill: 'Not booked', pillClass: 'bg-amber-100 text-amber-800', statusClass: 'text-amber-800',
      dot: 'bg-amber-500',
      action: onBook ? { label: 'Book it', onClick: () => onBook(d), className: 'text-ooosh-600 font-semibold' } : undefined,
    });
  }

  for (const e of overtime) {
    const dead = DEAD.has(e.status);
    const times = e.startTime && e.endTime ? `${e.startTime.slice(0, 5)}–${e.endTime.slice(0, 5)} · ` : '';
    rows.push({
      key: `ot:${e.id}`, date: e.workDate, until: e.workDate,
      title: e.reason, meta: `${times}overtime`,
      extra: e.decisionNote ? `${e.decidedByName ? `${e.decidedByName}: ` : ''}${e.decisionNote}` : null,
      amount: `+${fmtH(e.minutes)}`,
      amountClass: dead ? 'text-gray-500 line-through' : e.status === 'pending' ? 'text-amber-800' : 'text-emerald-700',
      pill: e.status === 'pending' ? 'Waiting for approval' : e.status === 'approved' ? 'Approved · banked' : statusWord(e.status),
      pillClass: STATUS_STYLE[e.status as LeaveStatus] ?? 'bg-gray-100 text-gray-600',
      statusClass: e.status === 'pending' ? 'text-amber-800' : e.status === 'approved' ? 'text-emerald-700' : 'text-gray-500',
      dot: dead ? 'bg-gray-300' : e.status === 'pending' ? 'bg-amber-500' : 'bg-ooosh-600',
      fresh: freshIds.includes(e.id),
      action: e.status === 'pending'
        ? { label: 'Withdraw', onClick: () => onCancelOvertime(e.id), className: 'text-red-600' } : undefined,
    });
  }

  for (const r of requests) {
    const dead = DEAD.has(r.status);
    const n = r.days.length;
    const span = r.startDate === r.endDate ? '' : `${fmtRange(r.startDate, r.endDate)} · `;
    const isToil = r.leaveType === 'toil';
    const extras = [
      r.decisionNote ? `${r.status === 'declined' ? 'Declined' : 'Approved'}${r.decidedByName ? ` by ${r.decidedByName}` : ''}: ${r.decisionNote}` : null,
      r.cancellationReason ? `Cancelled: ${r.cancellationReason}` : null,
    ].filter(Boolean).join(' · ');
    rows.push({
      key: `lr:${r.id}`, date: r.startDate, until: r.endDate,
      title: isToil ? (r.requestNote || 'Time off') : TYPE_LABELS[r.leaveType],
      meta: isToil
        ? `${span}${n > 1 ? `${n} days · ` : ''}overtime taken as time off`
        : `${span}${n} day${n === 1 ? '' : 's'} · ${fmtH(r.totalMinutes)}${r.requestNote ? ` · “${r.requestNote}”` : ''}`,
      extra: extras || null,
      amount: `−${fmtH(r.totalMinutes)}`,
      amountClass: dead ? 'text-gray-500 line-through' : 'text-gray-600',
      pill: statusWord(r.status), pillClass: STATUS_STYLE[r.status],
      statusClass: r.status === 'pending' ? 'text-amber-800' : r.status === 'approved' ? 'text-emerald-700'
        : r.status === 'declined' ? 'text-red-700' : 'text-gray-500',
      dot: dead ? 'bg-gray-300' : isToil ? 'bg-slate-400' : 'bg-ooosh-600',
      action: r.status === 'pending'
        ? { label: 'Withdraw', onClick: () => onWithdraw(r.id), className: 'text-red-600' } : undefined,
    });
  }
  return rows;
}

function TimeList(props: {
  year: number; requests: LeaveRequest[]; overtime: OvertimeEntry[];
  companyDays: { date: string; label: string }[]; bankHolidaysToBook: string[]; freshIds: string[];
  onWithdraw: (id: string) => void; onCancelOvertime: (id: string) => void; onBook?: (date: string) => void;
}) {
  const rows = buildRows(props);
  const upcoming = rows.filter(r => r.until >= TODAY).sort((a, b) => a.date.localeCompare(b.date));
  const earlier = rows.filter(r => r.until < TODAY).sort((a, b) => b.date.localeCompare(a.date));

  if (rows.length === 0) {
    return <div className="px-5 py-6 text-sm text-gray-500">Nothing here yet for {props.year}.</div>;
  }

  const section = (label: string, list: TimeRow[]) => list.length > 0 && (
    <div>
      <div className="px-4 sm:px-5 py-2.5 bg-gray-50 text-[11px] font-semibold uppercase tracking-[.06em] text-gray-500">
        {label}
      </div>
      {list.map(r => (
        <div key={r.key}
          className={`grid grid-cols-[38px_1fr_auto] sm:grid-cols-[52px_10px_1fr_auto] items-center gap-3 sm:gap-3.5 px-4 sm:px-5 py-3.5 border-b border-gray-100 ${r.fresh ? 'bg-amber-50' : ''}`}>
          <div className="text-center leading-tight">
            <div className="hidden sm:block text-[11px] uppercase text-gray-500">{datePart(r.date, { weekday: 'short' })}</div>
            <div className="text-lg sm:text-xl font-semibold text-gray-900">{Number(r.date.slice(8, 10))}</div>
            <div className="text-[11px] text-gray-500">{datePart(r.date, { month: 'short' })}</div>
          </div>
          <span className={`hidden sm:block w-2.5 h-2.5 rounded-full ${r.dot}`} aria-hidden />
          <div className="min-w-0">
            <div className="text-[15px] font-medium text-gray-900 truncate">{r.title}</div>
            <div className="text-[13px] text-gray-500 truncate sm:whitespace-normal">{r.meta}</div>
            <div className={`sm:hidden text-xs font-medium ${r.statusClass}`}>{r.pill}</div>
            {r.extra && <div className="text-xs text-gray-600 mt-0.5">{r.extra}</div>}
          </div>
          <div className="flex flex-col sm:flex-row items-end sm:items-center gap-1 sm:gap-3 text-right">
            {r.amount && <span className={`text-[15px] font-semibold tabular-nums ${r.amountClass}`}>{r.amount}</span>}
            <span className={`hidden sm:inline-flex text-xs px-[9px] py-[3px] rounded-full whitespace-nowrap ${r.pillClass}`}>
              {r.pill}
            </span>
            {r.action && (
              <button onClick={r.action.onClick} className={`text-xs sm:text-sm hover:underline ${r.action.className}`}>
                {r.action.label}
              </button>
            )}
          </div>
        </div>
      ))}
    </div>
  );

  const isCurrentYear = props.year === CURRENT_YEAR;
  return (
    <div>
      {section('Coming up', upcoming)}
      {section(isCurrentYear ? 'Earlier this year' : `Earlier in ${props.year}`, earlier)}
    </div>
  );
}

interface CalEvent { label: string; cls: string; dot: string; onClick?: () => void }

const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

/** A month grid, Monday first, of the same facts the list shows. */
function TimeCalendar({ month, onMonth, onThisMonth, requests, overtime, companyDays, bankHolidays, bankHolidaysToBook, onBook }: {
  month: { y: number; m: number };
  onMonth: (next: { y: number; m: number }) => void;
  onThisMonth: () => void;
  requests: LeaveRequest[]; overtime: OvertimeEntry[];
  companyDays: { date: string; label: string }[];
  bankHolidays: string[]; bankHolidaysToBook: string[];
  onBook?: (date: string) => void;
}) {
  const events = useMemo(() => {
    const map = new Map<string, CalEvent[]>();
    const add = (d: string, e: CalEvent) => map.set(d, [...(map.get(d) ?? []), e]);
    const company = new Set(companyDays.map(c => c.date));
    for (const c of companyDays) add(c.date, { label: c.label, cls: 'bg-emerald-100 text-emerald-800', dot: 'bg-emerald-500' });
    const toBook = new Set(bankHolidaysToBook);
    for (const d of bankHolidays) {
      if (company.has(d)) continue; // a company day wins (companyCalendar.ts)
      add(d, toBook.has(d)
        ? { label: 'Bank holiday — book?', cls: 'bg-amber-100 text-amber-800', dot: 'bg-amber-500',
            onClick: onBook ? () => onBook(d) : undefined }
        : { label: 'Bank holiday', cls: 'bg-gray-100 text-gray-600', dot: 'bg-gray-300' });
    }
    for (const e of overtime) {
      if (e.status === 'approved') add(e.workDate, { label: `+${fmtH(e.minutes)} overtime`, cls: 'bg-ooosh-100 text-ooosh-700', dot: 'bg-ooosh-600' });
      else if (e.status === 'pending') add(e.workDate, { label: `+${fmtH(e.minutes)} waiting`, cls: 'bg-amber-100 text-amber-800', dot: 'bg-amber-500' });
    }
    for (const r of requests) {
      if (r.status !== 'pending' && r.status !== 'approved') continue;
      const waiting = r.status === 'pending';
      for (const d of r.days) {
        if (r.leaveType === 'toil') {
          add(d.date, { label: `−${fmtH(d.minutes)} time off${waiting ? ' (waiting)' : ''}`, cls: 'bg-gray-100 text-gray-700', dot: 'bg-slate-400' });
        } else {
          const what = r.leaveType === 'unpaid' ? 'Unpaid leave' : 'Holiday';
          add(d.date, waiting
            ? { label: `${what} — waiting`, cls: 'bg-amber-100 text-amber-800', dot: 'bg-amber-500' }
            : { label: what, cls: 'bg-ooosh-600 text-white', dot: 'bg-ooosh-600' });
        }
      }
    }
    return map;
  }, [requests, overtime, companyDays, bankHolidays, bankHolidaysToBook, onBook]);

  const { y, m } = month;
  const first = new Date(Date.UTC(y, m, 1));
  const lead = (first.getUTCDay() + 6) % 7; // Monday = 0
  const daysInMonth = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  const cells = Math.ceil((lead + daysInMonth) / 7) * 7;
  const label = first.toLocaleDateString('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' });

  const shift = (n: number) => {
    const d = new Date(Date.UTC(y, m + n, 1));
    return { y: d.getUTCFullYear(), m: d.getUTCMonth() };
  };
  const prev = shift(-1), next = shift(1);
  // Only the years the page can load — anything else would be an empty month.
  const canPrev = YEARS.includes(prev.y), canNext = YEARS.includes(next.y);
  const navBtn = 'w-11 h-11 sm:w-8 sm:h-8 rounded-lg border border-gray-200 bg-white text-gray-700 hover:bg-gray-50 disabled:opacity-40';

  return (
    <div>
      <div className="px-4 sm:px-5 py-3 flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <button className={navBtn} disabled={!canPrev} onClick={() => onMonth(prev)} aria-label="Previous month">‹</button>
          <span className="text-[15px] font-semibold text-gray-900 min-w-[130px] sm:min-w-[150px] text-center">{label}</span>
          <button className={navBtn} disabled={!canNext} onClick={() => onMonth(next)} aria-label="Next month">›</button>
        </div>
        <button onClick={onThisMonth}
          className="whitespace-nowrap px-3 py-[5px] rounded-lg border border-gray-200 bg-white text-[13px] text-gray-700 hover:bg-gray-50">
          This month
        </button>
      </div>

      <div className="grid grid-cols-7 border-t border-gray-100">
        {WEEKDAYS.map(w => (
          <div key={w} className="px-1 sm:px-2.5 py-2 text-[11px] font-semibold uppercase tracking-[.06em] text-gray-500 text-center sm:text-left">
            {w}
          </div>
        ))}
        {Array.from({ length: cells }, (_, i) => {
          const day = i - lead + 1;
          const inMonth = day >= 1 && day <= daysInMonth;
          const date = inMonth ? `${y}-${String(m + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}` : '';
          const isToday = date === TODAY;
          const weekend = i % 7 >= 5;
          const evs = inMonth ? events.get(date) ?? [] : [];
          const shown = new Date(Date.UTC(y, m, day)).getUTCDate();
          return (
            <div key={i}
              className={`min-h-[46px] sm:min-h-[92px] p-1 sm:px-1.5 sm:pt-1.5 sm:pb-2 border-r border-b border-gray-100 flex flex-col items-center sm:items-stretch gap-1 overflow-hidden ${
                isToday ? 'bg-ooosh-50' : inMonth && weekend ? 'bg-gray-50' : ''}`}>
              <span className={`text-xs sm:text-[13px] font-semibold w-6 h-6 sm:w-[22px] sm:h-[22px] flex items-center justify-center rounded-full ${
                isToday ? 'bg-ooosh-600 text-white' : inMonth ? 'text-gray-900' : 'text-gray-300'}`}>
                {shown}
              </span>
              {/* Desktop: labelled chips. Phone: up to three dots. */}
              <div className="hidden sm:flex flex-col gap-1 min-w-0">
                {evs.map((e, j) => e.onClick ? (
                  <button key={j} onClick={e.onClick} title={e.label}
                    className={`text-left text-[11px] font-medium px-1.5 py-0.5 rounded truncate hover:underline ${e.cls}`}>
                    {e.label}
                  </button>
                ) : (
                  <span key={j} title={e.label} className={`text-[11px] font-medium px-1.5 py-0.5 rounded truncate ${e.cls}`}>
                    {e.label}
                  </span>
                ))}
              </div>
              {evs.length > 0 && (
                <div className="flex sm:hidden gap-0.5">
                  {evs.slice(0, 3).map((e, j) => <span key={j} className={`w-[5px] h-[5px] rounded-full ${e.dot}`} />)}
                </div>
              )}
            </div>
          );
        })}
      </div>

      <div className="flex flex-wrap gap-x-4 gap-y-1.5 px-4 sm:px-5 py-3 text-xs text-gray-600">
        {[
          ['bg-ooosh-100', 'Overtime banked'],
          ['bg-amber-100', 'Waiting / to book'],
          ['bg-gray-100 border border-gray-200', 'Time off'],
          ['bg-ooosh-600', 'Holiday'],
          ['bg-emerald-100', 'Company day'],
        ].map(([cls, text]) => (
          <span key={text} className="flex items-center gap-1.5">
            <i className={`w-2.5 h-2.5 rounded-[3px] ${cls}`} />{text}
          </span>
        ))}
      </div>
    </div>
  );
}
