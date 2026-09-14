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
interface MyBalances {
  year: number;
  holiday: { balanceMinutes: number; nominalDayMinutes: number | null };
  overtime: { balanceMinutes: number; nominalDayMinutes: number | null };
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

export default function MyTimePage() {
  const role = useAuthStore(s => s.user?.role);
  const [requests, setRequests] = useState<LeaveRequest[]>([]);
  const [overtime, setOvertime] = useState<OvertimeEntry[]>([]);
  const [balances, setBalances] = useState<MyBalances | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [leave, ot, bal] = await Promise.all([
        api.get<{ data: LeaveRequest[] }>('/staff-calendar/leave'),
        api.get<{ data: OvertimeEntry[] }>('/staff-calendar/overtime'),
        api.get<{ data: MyBalances | null }>('/staff-calendar/me/balances'),
      ]);
      setRequests(leave.data);
      setOvertime(ot.data);
      setBalances(bal.data);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load your time');
    } finally { setLoading(false); }
  }, []);

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

  return (
    <div className="p-4 sm:p-6 max-w-4xl">
      <div className="flex flex-wrap items-center justify-between gap-3 mb-1">
        <h1 className="text-2xl font-semibold text-gray-900">My time</h1>
        <div className="flex items-center gap-3 text-sm">
          <Link to="/staff/calendar" className="text-ooosh-600 hover:underline">Team calendar →</Link>
          {hasManagerRole(role) && <Link to="/staff/admin" className="text-ooosh-600 hover:underline">Staff →</Link>}
        </div>
      </div>
      <p className="text-sm text-gray-500 mb-5">Book time off and track your requests.</p>

      {error && <div className="mb-4 p-3 rounded bg-red-50 border border-red-200 text-sm text-red-700">{error}</div>}
      {notice && <div className="mb-4 p-3 rounded bg-emerald-50 border border-emerald-200 text-sm text-emerald-800">{notice}</div>}

      <BalanceCards balances={balances} />

      <div className="flex flex-wrap gap-2">
        <BookTimeOff balances={balances}
          onBooked={async (msg) => { setNotice(msg); setError(null); await load(); }} onError={setError} />
        <LogOvertime onLogged={async (msg) => { setNotice(msg); setError(null); await load(); }} onError={setError} />
      </div>

      <section className="mt-6">
        <h2 className="text-sm font-semibold text-gray-900 uppercase tracking-wide mb-2">Upcoming</h2>
        {loading ? (
          <div className="text-sm text-gray-500">Loading…</div>
        ) : upcoming.length === 0 ? (
          <div className="p-4 rounded border border-dashed border-gray-300 text-sm text-gray-500">
            Nothing booked.
          </div>
        ) : (
          <div className="space-y-2">
            {upcoming.map(r => <RequestCard key={r.id} r={r} onWithdraw={withdraw} />)}
          </div>
        )}
      </section>

      <section className="mt-6">
        <h2 className="text-sm font-semibold text-gray-900 uppercase tracking-wide mb-2">Overtime</h2>
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
        <h2 className="text-sm font-semibold text-gray-900 uppercase tracking-wide mb-2">Past leave</h2>
        {past.length === 0 ? (
          <div className="p-4 rounded border border-dashed border-gray-300 text-sm text-gray-500">
            Nothing yet — past holidays and time off will build up here.
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

function BookTimeOff({ balances, onBooked, onError }: {
  balances: MyBalances | null;
  onBooked: (msg: string) => Promise<void>; onError: (msg: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [leaveType, setLeaveType] = useState<LeaveType>('holiday');
  const [startDate, setStartDate] = useState(TODAY);
  const [endDate, setEndDate] = useState(TODAY);
  // A day can be whole, a half, or an actual period ("leaving at 15:00").
  const [dayParts, setDayParts] = useState<Record<string, DaySpec>>({});
  const [note, setNote] = useState('');
  const [impact, setImpact] = useState<Impact | null>(null);
  const [checking, setChecking] = useState(false);
  const [saving, setSaving] = useState(false);

  // Keep the end date sane rather than letting an invalid range reach the API.
  useEffect(() => { if (endDate < startDate) setEndDate(startDate); }, [startDate, endDate]);

  const dayPartsKey = useMemo(() => JSON.stringify(dayParts), [dayParts]);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setChecking(true);
    const t = setTimeout(async () => {
      try {
        const qs = new URLSearchParams({
          from: startDate, to: endDate, type: leaveType, halfDays: dayPartsKey,
        });
        const res = await api.get<{ data: Impact }>(`/staff-calendar/leave/impact?${qs}`);
        if (!cancelled) setImpact(res.data);
      } catch {
        if (!cancelled) setImpact(null);
      } finally {
        if (!cancelled) setChecking(false);
      }
    }, 300);
    return () => { cancelled = true; clearTimeout(t); };
  }, [open, startDate, endDate, leaveType, dayPartsKey]);

  async function submit() {
    setSaving(true);
    try {
      await api.post('/staff-calendar/leave', {
        leaveType, startDate, endDate,
        halfDays: Object.keys(dayParts).length ? dayParts : undefined,
        note: note || null,
      });
      setOpen(false); setNote(''); setDayParts({}); setImpact(null);
      await onBooked('Request submitted — you’ll hear when it’s been looked at.');
    } catch (err) {
      onError(err instanceof Error ? err.message : 'Failed to submit the request');
    } finally { setSaving(false); }
  }

  if (!open) {
    return (
      <button onClick={() => setOpen(true)}
        className="px-3 py-2 text-sm rounded bg-ooosh-600 text-white hover:bg-ooosh-700">
        Book time off
      </button>
    );
  }

  const blocked = (impact?.ownClashes.length ?? 0) > 0 || (impact?.workingDays ?? 0) === 0;

  return (
    <div className="p-4 rounded-lg border border-gray-200 bg-white">
      <div className="flex items-center justify-between mb-3">
        <h2 className="font-medium text-gray-900">Book time off</h2>
        <button onClick={() => setOpen(false)} className="text-sm text-gray-500 hover:text-gray-700">Cancel</button>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 mb-3">
        <label className="text-sm">
          <span className="block text-xs text-gray-600 mb-1">Type</span>
          <select value={leaveType} onChange={e => setLeaveType(e.target.value as LeaveType)}
            className="w-full px-2 py-1.5 border border-gray-300 rounded text-sm">
            {/* The balance is in the label so the choice between holiday and
                TOIL is made with both figures visible, not from memory. */}
            <option value="holiday">
              Holiday{balances ? ` — ${fmtH(balances.holiday.balanceMinutes)} left` : ''}
            </option>
            <option value="toil">
              TOIL{balances ? ` — ${fmtH(balances.overtime.balanceMinutes)} banked` : ''}
            </option>
            <option value="unpaid">Unpaid leave</option>
          </select>
        </label>
        <label className="text-sm">
          <span className="block text-xs text-gray-600 mb-1">From</span>
          <input type="date" value={startDate} onChange={e => setStartDate(e.target.value)}
            className="w-full px-2 py-1.5 border border-gray-300 rounded text-sm" />
        </label>
        <label className="text-sm">
          <span className="block text-xs text-gray-600 mb-1">To</span>
          <input type="date" value={endDate} min={startDate} onChange={e => setEndDate(e.target.value)}
            className="w-full px-2 py-1.5 border border-gray-300 rounded text-sm" />
        </label>
      </div>

      {impact && impact.days.length > 0 && impact.days.length <= 14 && (
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
                      <input type="time" value={spec.startTime ?? '15:00'}
                        onChange={e => setDayParts(p => ({ ...p, [d.date]: { ...spec, startTime: e.target.value } }))}
                        className="px-1.5 py-1 border border-gray-300 rounded text-xs" />
                      <span className="text-gray-400">to</span>
                      <input type="time" value={spec.endTime ?? '17:00'}
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

      <ImpactPanel impact={impact} checking={checking} leaveType={leaveType} />

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

export function ImpactPanel({ impact, checking, leaveType }: {
  impact: Impact | null; checking: boolean; leaveType: LeaveType;
}) {
  if (checking && !impact) return <div className="text-sm text-gray-500">Checking…</div>;
  if (!impact) return null;

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
  const cards = [
    { label: 'Holiday left', ...balances.holiday, hint: `${balances.year} allowance` },
    { label: 'Overtime banked', ...balances.overtime, hint: 'Take as time off or ask for it in pay' },
  ];
  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mb-4">
      {cards.map(c => {
        const days = c.nominalDayMinutes
          ? (c.balanceMinutes / c.nominalDayMinutes).toFixed(1) : null;
        return (
          <div key={c.label} className="p-3 rounded-lg border border-gray-200 bg-white">
            <div className="text-xs text-gray-500">{c.label}</div>
            <div className="flex items-baseline gap-2">
              <span className={`text-xl font-semibold tabular-nums ${
                c.balanceMinutes < 0 ? 'text-red-700' : 'text-gray-900'}`}>
                {fmtH(c.balanceMinutes)}
              </span>
              {days && <span className="text-sm text-gray-600">{days} days</span>}
            </div>
            <div className="text-[11px] text-gray-400 mt-0.5">{c.hint}</div>
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
function LogOvertime({ onLogged, onError }: {
  onLogged: (msg: string) => Promise<void>; onError: (msg: string) => void;
}) {
  const [open, setOpen] = useState(false);
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

  const invalid = computed <= 0 || computed % 5 !== 0 || computed > 960 || !reason.trim();

  async function save() {
    setSaving(true);
    try {
      await api.post('/staff-calendar/overtime', {
        workDate,
        startTime: mode === 'times' ? startTime : null,
        endTime: mode === 'times' ? endTime : null,
        minutes: computed,
        reason: reason.trim(),
      });
      setOpen(false); setReason('');
      await onLogged('Overtime logged — it’ll be added to your bank once approved.');
    } catch (err) {
      onError(err instanceof Error ? err.message : 'Failed to log the overtime');
    } finally { setSaving(false); }
  }

  if (!open) {
    return (
      <button onClick={() => setOpen(true)}
        className="px-3 py-2 text-sm rounded border border-ooosh-300 text-ooosh-700 hover:bg-ooosh-50">
        Log overtime
      </button>
    );
  }

  return (
    <div className="w-full p-4 rounded-lg border border-gray-200 bg-white">
      <div className="flex items-center justify-between mb-1">
        <h2 className="font-medium text-gray-900">Log overtime</h2>
        <button onClick={() => setOpen(false)} className="text-sm text-gray-500 hover:text-gray-700">Cancel</button>
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
            <input type="time" value={startTime} onChange={e => setStartTime(e.target.value)}
              className="px-2 py-1.5 border border-gray-300 rounded text-sm" />
          </label>
          <label className="text-sm">
            <span className="block text-xs text-gray-600 mb-1">To</span>
            <input type="time" value={endTime} onChange={e => setEndTime(e.target.value)}
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

      {computed > 0 && computed % 5 !== 0 && (
        <p className="mb-2 text-xs text-amber-700">
          Overtime is logged in 5-minute steps — {computed} minutes will need rounding.
        </p>
      )}

      <button onClick={() => void save()} disabled={saving || invalid}
        className="px-3 py-2 text-sm rounded bg-ooosh-600 text-white hover:bg-ooosh-700 disabled:opacity-50">
        {saving ? 'Logging…' : `Log ${computed > 0 ? fmtH(computed) : ''}`}
      </button>
    </div>
  );
}
