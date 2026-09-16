import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../services/api';
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
interface MyBalances {
  year: number;
  holiday: AccountBreakdown;
  overtime: AccountBreakdown;
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
  holiday: 'Holiday', toil: 'TOIL (banked overtime)', unpaid: 'Unpaid leave',
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
const TODAY = new Date().toISOString().slice(0, 10);
const CURRENT_YEAR = Number(TODAY.slice(0, 4));

/** Whole weeks left in a leave year, for the "use it or lose it" nudge. */
function weeksLeftInYear(year: number): number {
  if (year !== CURRENT_YEAR) return 0;
  const end = Date.UTC(year, 11, 31);
  const now = Date.UTC(CURRENT_YEAR, Number(TODAY.slice(5, 7)) - 1, Number(TODAY.slice(8, 10)));
  return Math.max(0, Math.floor((end - now) / (7 * 86400000)));
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
  const [bhPolicy, setBhPolicy] = useState<'use_allowance' | 'granted'>('use_allowance');
  const [openForm, setOpenForm] = useState<'leave' | 'overtime' | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const from = `${year}-01-01`;
      const to = `${year}-12-31`;
      const [leave, ot, bal, bh] = await Promise.all([
        api.get<{ data: LeaveRequest[] }>(`/staff-calendar/leave?from=${from}&to=${to}`),
        api.get<{ data: OvertimeEntry[] }>(`/staff-calendar/overtime?from=${from}&to=${to}`),
        api.get<{ data: MyBalances | null; hasStaffRecord?: boolean }>(
          `/staff-calendar/me/balances?year=${year}`),
        api.get<{ data: string[]; policy?: 'use_allowance' | 'granted' }>(
          `/staff-calendar/bank-holidays?year=${year}`),
      ]);
      setRequests(leave.data);
      setOvertime(ot.data);
      setBalances(bal.data);
      setBankHolidays(bh.data ?? []);
      setBhPolicy(bh.policy ?? 'use_allowance');
      setHasStaffRecord(bal.hasStaffRecord !== false);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load your time');
    } finally { setLoading(false); }
  }, [year]);

  useEffect(() => { void load(); }, [load]);

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

  const upcoming = requests.filter(r => r.endDate >= TODAY);
  const past = requests.filter(r => r.endDate < TODAY);
  const isCurrentYear = year === CURRENT_YEAR;
  // Next year is bookable now that its entitlement is granted in advance.
  // Only a year that has finished is read-only, and then because the dates
  // have been and gone rather than because of anything about the balance.
  const isPastYear = year < CURRENT_YEAR;
  // Open a form on the year being looked at, not on today. This was the real
  // reason next year was gated read-only: picking 2027 and hitting "Book time
  // off" opened a form dated 2026, which is worse than not offering it.
  const formSeedDate = isCurrentYear ? TODAY : `${year}-01-01`;

  return (
    <div className="p-4 sm:p-6 max-w-4xl">
      <div className="flex flex-wrap items-center justify-between gap-3 mb-1">
        <h1 className="text-2xl font-semibold text-gray-900">My time</h1>
        <div className="flex items-center gap-3 text-sm">
          {/* Leave years, newest first. Two back is enough: nothing carries
              over, so an older year is history rather than something to act
              on, and the list should not grow forever. */}
          {/* Labelled, because an unlabelled select sitting next to two links
              reads as part of the nav rather than as a control. */}
          <label className="flex items-center gap-1.5 text-gray-500">
            Year
            <select value={year} onChange={e => setYear(Number(e.target.value))}
              aria-label="Leave year"
              className="px-2 py-1 rounded border border-gray-300 text-sm text-gray-900">
            {[CURRENT_YEAR + 1, CURRENT_YEAR, CURRENT_YEAR - 1, CURRENT_YEAR - 2].map(y => (
                <option key={y} value={y}>{y}{y === CURRENT_YEAR ? ' (this year)' : ''}</option>
              ))}
            </select>
          </label>
          <Link to="/staff/calendar" className="text-ooosh-600 hover:underline">Team calendar →</Link>
          {hasManagerRole(role) && <Link to="/staff/admin" className="text-ooosh-600 hover:underline">Staff →</Link>}
        </div>
      </div>
      <p className="text-sm text-gray-500 mb-5">
        {isPastYear
          ? `Your ${year} leave year. Finished, so this is a record rather than something to book against.`
          : isCurrentYear
            ? 'Book time off and track your requests.'
            : `Your ${year} leave year. You can book against it now — next year's allowance is already set.`}
      </p>

      {error && <div className="mb-4 p-3 rounded bg-red-50 border border-red-200 text-sm text-red-700">{error}</div>}
      {notice && <div className="mb-4 p-3 rounded bg-emerald-50 border border-emerald-200 text-sm text-emerald-800">{notice}</div>}

      {!hasStaffRecord && (
        <div className="mb-4 p-3 rounded border border-amber-200 bg-amber-50 text-sm text-amber-900">
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

      <BalanceCards balances={balances} />
      <YearNudge balances={balances} year={year} bankHolidays={bankHolidays} bhPolicy={bhPolicy} />

      {/* One form at a time. These were previously siblings in a flex row, so
          opening either expanded it to full width while the other button
          stretched to match — a stray panel beside the open form. */}
      {isPastYear ? null : openForm === null ? (
        <div className="flex flex-wrap gap-2">
          <button onClick={() => setOpenForm('leave')}
            className="px-3 py-2 text-sm rounded bg-ooosh-600 text-white hover:bg-ooosh-700">
            Book time off
          </button>
          <button onClick={() => setOpenForm('overtime')}
            className="px-3 py-2 text-sm rounded border border-ooosh-300 text-ooosh-700 hover:bg-ooosh-50">
            Log overtime
          </button>
        </div>
      ) : openForm === 'leave' ? (
        <BookTimeOff balances={balances} seedDate={formSeedDate} onClose={() => setOpenForm(null)}
          onBooked={async (msg) => { setNotice(msg); setError(null); setOpenForm(null); await load(); }}
          onError={setError} />
      ) : (
        <LogOvertime onClose={() => setOpenForm(null)}
          onLogged={async (msg) => { setNotice(msg); setError(null); setOpenForm(null); await load(); }}
          onError={setError} />
      )}

      <section className="mt-6">
        <h2 className="text-sm font-semibold text-gray-900 uppercase tracking-wide mb-2">
          {isCurrentYear ? 'Upcoming' : `Booked in ${year}`}
        </h2>
        {loading ? (
          <div className="text-sm text-gray-500">Loading…</div>
        ) : upcoming.length === 0 ? (
          <div className="p-4 rounded border border-dashed border-gray-300 text-sm text-gray-500">
            Nothing booked{isCurrentYear ? '' : ` in ${year}`}.
          </div>
        ) : (
          <div className="space-y-2">
            {upcoming.map(r => <RequestCard key={r.id} r={r} onWithdraw={withdraw} />)}
          </div>
        )}
      </section>

      <section className="mt-6">
        <h2 className="text-sm font-semibold text-gray-900 uppercase tracking-wide mb-2">
          Overtime{isCurrentYear ? '' : ` in ${year}`}
        </h2>
        {overtime.length === 0 ? (
          <div className="p-4 rounded border border-dashed border-gray-300 text-sm text-gray-500">
            Nothing logged yet.
          </div>
        ) : (
          <div className="space-y-2">
            {overtime.slice(0, 30).map(e => (
              <OvertimeCard key={e.id} e={e}
                onCancel={async (id) => {
                  if (!confirm('Withdraw this overtime entry?')) return;
                  try {
                    await api.post(`/staff-calendar/overtime/${id}/cancel`, {});
                    setNotice('Entry withdrawn.'); await load();
                  } catch (err) { setError(err instanceof Error ? err.message : 'Failed to withdraw'); }
                }} />
            ))}
          </div>
        )}
      </section>

      <section className="mt-6">
        <h2 className="text-sm font-semibold text-gray-900 uppercase tracking-wide mb-2">
          {isCurrentYear ? 'Already taken this year' : `Taken in ${year}`}
        </h2>
        {past.length === 0 ? (
          <div className="p-4 rounded border border-dashed border-gray-300 text-sm text-gray-500">
            Nothing yet — time off you have already taken will build up here.
          </div>
        ) : (
          <div className="space-y-2">{past.slice(0, 30).map(r => <RequestCard key={r.id} r={r} />)}</div>
        )}
      </section>
    </div>
  );
}

function RequestCard({ r, onWithdraw }: { r: LeaveRequest; onWithdraw?: (id: string) => void }) {
  return (
    <div className="p-3 rounded-lg border border-gray-200 bg-white">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <div className="flex items-center gap-2 flex-wrap">
            <span className="font-medium text-gray-900">{fmtRange(r.startDate, r.endDate)}</span>
            <span className={`text-[11px] px-1.5 py-0.5 rounded ${STATUS_STYLE[r.status]}`}>
              {r.status}
            </span>
          </div>
          <div className="text-xs text-gray-500 mt-0.5">
            {TYPE_LABELS[r.leaveType]} · {r.days.length} day{r.days.length === 1 ? '' : 's'} · {fmtH(r.totalMinutes)}
          </div>
          {r.requestNote && <div className="text-xs text-gray-600 mt-1 italic">“{r.requestNote}”</div>}
          {r.decisionNote && (
            <div className="text-xs text-gray-600 mt-1">
              {r.status === 'declined' ? 'Declined' : 'Approved'}
              {r.decidedByName && ` by ${r.decidedByName}`}: {r.decisionNote}
            </div>
          )}
          {r.cancellationReason && (
            <div className="text-xs text-gray-600 mt-1">Cancelled: {r.cancellationReason}</div>
          )}
        </div>
        {onWithdraw && r.status === 'pending' && (
          <button onClick={() => onWithdraw(r.id)} className="text-xs text-red-600 hover:underline">
            Withdraw
          </button>
        )}
      </div>
    </div>
  );
}

function BookTimeOff({ balances, seedDate, onClose, onBooked, onError }: {
  balances: MyBalances | null;
  /** The date the form opens on — today, or 1 January of the year being viewed. */
  seedDate: string;
  onClose: () => void;
  onBooked: (msg: string) => Promise<void>; onError: (msg: string) => void;
}) {
  const [leaveType, setLeaveType] = useState<LeaveType>('holiday');
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
    <div className="p-4 rounded-lg border border-gray-200 bg-white">
      <div className="flex items-center justify-between mb-3">
        <h2 className="font-medium text-gray-900">Book time off</h2>
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
                TOIL is made with both figures visible, not from memory. */}
            <option value="holiday">
              Holiday{balances ? ` — ${fmtH(balances.holiday.availableMinutes)} left` : ''}
            </option>
            <option value="toil">
              TOIL{balances ? ` — ${fmtH(balances.overtime.availableMinutes)} available` : ''}
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
 * Holiday left and overtime banked, side by side.
 *
 * Shown before any dates are picked, because the choice between "take a
 * holiday" and "use some TOIL" is only a real choice if both numbers are
 * visible at the moment of deciding.
 */
function BalanceCards({ balances }: { balances: MyBalances | null }) {
  if (!balances) return null;

  const days = (mins: number, nominal: number | null) =>
    nominal && nominal > 0 ? `${(mins / nominal).toFixed(1)} days` : null;

  // A single net figure answers "can I book this?" but not "where did it go?".
  // For the overtime bank especially, earned / taken as time off / paid out are
  // three separate facts that one number silently merges.
  //
  // The parts are derived so they ALWAYS reconcile to the available figure,
  // rather than read off raw credits and debits. A cancelled holiday posts a
  // credit, so raw "in" would have read 217h on a 196h allowance — true to the
  // ledger, wrong on a line labelled Allowance. Netting the cancellation
  // against the booking it reverses gives the number a person expects, and
  // allowance is then derived from what is left.
  const t = (b: AccountBreakdown, k: string) => b.byType[k] ?? 0;

  const holidayTaken = -(t(balances.holiday, 'booking') + t(balances.holiday, 'cancellation'));
  const holidayAllowance = balances.holiday.availableMinutes + holidayTaken;

  const toilTaken = -(t(balances.overtime, 'spend_toil') + t(balances.overtime, 'cancellation'));
  const toilPaid = -(t(balances.overtime, 'spend_paid') + t(balances.overtime, 'year_end_cashout'));
  const toilBanked = balances.overtime.availableMinutes + toilTaken + toilPaid;

  const cards = [
    {
      key: 'holiday',
      label: 'Holiday',
      b: balances.holiday,
      parts: [
        { label: 'Allowance', mins: holidayAllowance, always: true },
        { label: 'Booked off', mins: holidayTaken, always: true },
      ],
      hint: `${balances.year} allowance`,
    },
    {
      key: 'overtime',
      label: 'Overtime',
      b: balances.overtime,
      parts: [
        { label: 'Banked', mins: toilBanked, always: true },
        { label: 'Taken as time off', mins: toilTaken, always: false },
        { label: 'Paid out', mins: toilPaid, always: false },
      ],
      hint: 'Take as time off or ask for it in pay',
    },
  ];

  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mb-4">
      {cards.map(c => {
        const avail = c.b.availableMinutes;
        const asDays = days(avail, c.b.nominalDayMinutes);
        return (
          <div key={c.key} className="p-3 rounded-lg border border-gray-200 bg-white">
            <div className="text-xs text-gray-500">{c.label} available</div>
            <div className="flex items-baseline gap-2">
              <span className={`text-xl font-semibold tabular-nums ${
                avail < 0 ? 'text-red-700' : 'text-gray-900'}`}>{fmtH(avail)}</span>
              {asDays && <span className="text-sm text-gray-600">{asDays}</span>}
            </div>

            <dl className="mt-2 pt-2 border-t border-gray-100 space-y-0.5">
              {c.parts.filter(p => p.always || p.mins !== 0).map(p => (
                <div key={p.label} className="flex justify-between text-xs">
                  <dt className="text-gray-500">{p.label}</dt>
                  <dd className="text-gray-700 tabular-nums">{fmtH(p.mins)}</dd>
                </div>
              ))}
            </dl>
            <div className="text-[11px] text-gray-400 mt-1.5">{c.hint}</div>
          </div>
        );
      })}
    </div>
  );
}

// ── Overtime ────────────────────────────────────────────────────────────────

function OvertimeCard({ e, onCancel }: {
  e: OvertimeEntry; onCancel: (id: string) => void;
}) {
  return (
    <div className="p-3 rounded-lg border border-gray-200 bg-white">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <div className="flex items-center gap-2 flex-wrap">
            <span className="font-medium text-gray-900">{fmtDate(e.workDate)}</span>
            <span className="text-sm text-gray-700">{fmtH(e.minutes)}</span>
            <span className={`text-[11px] px-1.5 py-0.5 rounded ${
              STATUS_STYLE[e.status as LeaveStatus] ?? 'bg-gray-100 text-gray-600'}`}>
              {e.status}
            </span>
          </div>
          <div className="text-xs text-gray-500 mt-0.5">
            {e.startTime && e.endTime && `${e.startTime.slice(0, 5)}–${e.endTime.slice(0, 5)} · `}
            {e.reason}
          </div>
          {e.decisionNote && (
            <div className="text-xs text-gray-600 mt-1">
              {e.decidedByName && `${e.decidedByName}: `}{e.decisionNote}
            </div>
          )}
        </div>
        {e.status === 'pending' && (
          <button onClick={() => onCancel(e.id)} className="text-xs text-red-600 hover:underline">
            Withdraw
          </button>
        )}
      </div>
    </div>
  );
}

/**
 * Log overtime.
 *
 * Times first, because that is how people remember it ("I came in at eight").
 * The minutes box is the fallback for "about forty minutes, I didn't look at
 * the clock" — and it is what actually gets stored either way, rounded to the
 * five-minute step the module works in.
 */
function LogOvertime({ onClose, onLogged, onError }: {
  onClose: () => void;
  onLogged: (msg: string) => Promise<void>; onError: (msg: string) => void;
}) {
  const [workDate, setWorkDate] = useState(TODAY);
  const [mode, setMode] = useState<'times' | 'minutes'>('times');
  const [startTime, setStartTime] = useState('08:00');
  const [endTime, setEndTime] = useState('09:00');
  const [minutes, setMinutes] = useState(60);
  const [reason, setReason] = useState('');
  const [saving, setSaving] = useState(false);

  const computed = useMemo(() => {
    if (mode === 'minutes') return minutes;
    const toMin = (t: string) => {
      const [h, m] = t.split(':').map(Number);
      return h * 60 + m;
    };
    return toMin(endTime) - toMin(startTime);
  }, [mode, minutes, startTime, endTime]);

  // Snap UP to the 5-minute step rather than refusing. Telling someone their
  // 12 minutes "will need rounding" and then blocking them is friction for no
  // benefit — round it, say so plainly, and let them get on.
  const snapped = computed > 0 ? Math.ceil(computed / 5) * 5 : 0;
  const wasSnapped = snapped !== computed;
  const invalid = snapped <= 0 || snapped > 960 || !reason.trim();

  async function save() {
    setSaving(true);
    try {
      await api.post('/staff-calendar/overtime', {
        workDate,
        startTime: mode === 'times' ? startTime : null,
        endTime: mode === 'times' ? endTime : null,
        minutes: snapped,
        reason: reason.trim(),
      });
      setReason('');
      await onLogged('Overtime logged — it’ll be added to your bank once approved.');
    } catch (err) {
      onError(err instanceof Error ? err.message : 'Failed to log the overtime');
    } finally { setSaving(false); }
  }


  return (
    <div className="w-full p-4 rounded-lg border border-gray-200 bg-white">
      <div className="flex items-center justify-between mb-1">
        <h2 className="font-medium text-gray-900">Log overtime</h2>
        <button onClick={onClose} className="text-sm text-gray-500 hover:text-gray-700">Cancel</button>
      </div>
      <p className="text-xs text-gray-500 mb-3">
        Goes into your bank once approved. You decide later whether to take it as time off or ask for it in pay.
        Log an early start and a late finish as two separate entries.
      </p>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mb-3">
        <label className="text-sm">
          <span className="block text-xs text-gray-600 mb-1">Date worked</span>
          <input type="date" value={workDate} max={TODAY} onChange={e => setWorkDate(e.target.value)}
            className="w-full px-2 py-1.5 border border-gray-300 rounded text-sm" />
        </label>
        <div className="text-sm">
          <span className="block text-xs text-gray-600 mb-1">How long?</span>
          <div className="flex rounded border border-gray-300 overflow-hidden text-xs w-fit">
            {(['times', 'minutes'] as const).map(m => (
              <button key={m} onClick={() => setMode(m)}
                className={`px-2.5 py-1.5 ${mode === m ? 'bg-ooosh-600 text-white' : 'bg-white text-gray-700 hover:bg-gray-50'}`}>
                {m === 'times' ? 'Start and end' : 'Just minutes'}
              </button>
            ))}
          </div>
        </div>
      </div>

      {mode === 'times' ? (
        <div className="flex flex-wrap items-end gap-2 mb-3">
          <label className="text-sm">
            <span className="block text-xs text-gray-600 mb-1">From</span>
            <input type="time" step={300} value={startTime} onChange={e => setStartTime(e.target.value)}
              className="px-2 py-1.5 border border-gray-300 rounded text-sm" />
          </label>
          <label className="text-sm">
            <span className="block text-xs text-gray-600 mb-1">To</span>
            <input type="time" step={300} value={endTime} onChange={e => setEndTime(e.target.value)}
              className="px-2 py-1.5 border border-gray-300 rounded text-sm" />
          </label>
          <span className={`pb-2 text-sm ${computed > 0 ? 'text-gray-700' : 'text-red-600'}`}>
            = {computed > 0 ? fmtH(computed) : 'end must be after start'}
          </span>
        </div>
      ) : (
        <div className="flex flex-wrap items-end gap-2 mb-3">
          <label className="text-sm">
            <span className="block text-xs text-gray-600 mb-1">Minutes</span>
            <input type="number" min={5} max={960} step={5} value={minutes}
              onChange={e => setMinutes(Number(e.target.value))}
              className="w-24 px-2 py-1.5 border border-gray-300 rounded text-sm" />
          </label>
          <span className="pb-2 text-sm text-gray-700">= {fmtH(minutes)}</span>
        </div>
      )}

      <label className="block text-sm mb-3">
        <span className="block text-xs text-gray-600 mb-1">What were you doing?</span>
        <input value={reason} onChange={e => setReason(e.target.value)}
          placeholder="e.g. in early for the Gary Numan load-out"
          className="w-full px-2 py-1.5 border border-gray-300 rounded text-sm" />
      </label>

      {wasSnapped && (
        <p className="mb-2 text-xs text-gray-600">
          Rounded up to {fmtH(snapped)} — overtime is banked in 5-minute steps.
        </p>
      )}

      <button onClick={() => void save()} disabled={saving || invalid}
        className="px-3 py-2 text-sm rounded bg-ooosh-600 text-white hover:bg-ooosh-700 disabled:opacity-50">
        {saving ? 'Logging…' : `Log ${snapped > 0 ? fmtH(snapped) : ''}`}
      </button>
    </div>
  );
}

// ── The nudge that makes a leave year mean something ────────────────────────

/**
 * "You have this much left and this long to use it."
 *
 * The single most useful thing this page can say, and the one a list of past
 * requests cannot: NOTHING CARRIES OVER (spec §5.1), so holiday not booked by
 * 31 December is simply gone. A balance on its own does not convey that; a
 * balance next to the weeks remaining does.
 *
 * It also carries the bank-holiday fact, which surprises people: under the
 * `use_allowance` policy Christmas Day is an ordinary working day here, so
 * anyone who assumed otherwise has fewer days than they think.
 */
function YearNudge({ balances, year, bankHolidays, bhPolicy }: {
  balances: MyBalances | null;
  year: number;
  bankHolidays: string[];
  bhPolicy: 'use_allowance' | 'granted';
}) {
  if (!balances) return null;

  const left = balances.holiday.availableMinutes;
  const nominal = balances.holiday.nominalDayMinutes;
  const leftDays = nominal && nominal > 0 ? left / nominal : null;
  const weeks = weeksLeftInYear(year);
  const isCurrentYear = year === CURRENT_YEAR;
  const isFutureYear = year > CURRENT_YEAR;

  // Bank holidays still ahead, so the count is actionable rather than trivia.
  const upcomingBh = bankHolidays.filter(d => d >= TODAY);

  // Nothing worth saying about a year that is over, or one with no allowance.
  if (!isCurrentYear && !isFutureYear && left <= 0) return null;

  const urgent = isCurrentYear && left > 0 && weeks <= 8;

  return (
    <div className={`mb-4 p-3 rounded-lg border text-sm ${
      urgent ? 'border-amber-200 bg-amber-50 text-amber-900'
             : 'border-gray-200 bg-white text-gray-700'}`}>
      {left > 0 ? (
        <>
          <strong>
            {leftDays !== null ? `${leftDays.toFixed(1)} days` : fmtH(left)} of holiday left
          </strong>
          {isCurrentYear ? (
            weeks > 0
              ? <> — and {weeks} week{weeks === 1 ? '' : 's'} of {year} to use {leftDays !== null && leftDays === 1 ? 'it' : 'them'} in. Nothing carries over.</>
              : <> — {year} is nearly over, and nothing carries over.</>
          ) : isFutureYear
            ? <> for {year}, already set aside. You can book against it now.</>
            : <> unused at the end of {year}.</>}
        </>
      ) : left < 0 ? (
        <><strong>You are {fmtH(-left)} over</strong> your {year} allowance. Worth a word with a manager.</>
      ) : (
        <>All of your {year} holiday is booked or taken.</>
      )}

      {isCurrentYear && bhPolicy === 'use_allowance' && upcomingBh.length > 0 && (
        <div className="mt-1 text-xs opacity-80">
          {upcomingBh.length} bank holiday{upcomingBh.length === 1 ? '' : 's'} left this year
          {' '}({upcomingBh.slice(0, 3).map(fmtDate).join(', ')}
          {upcomingBh.length > 3 ? '…' : ''}) — they are normal working days here,
          so book them off if you want them.
        </div>
      )}
    </div>
  );
}
