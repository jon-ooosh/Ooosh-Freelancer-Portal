import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../services/api';
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
  isException: boolean;
  detail?: { leaveType?: string; absenceType?: string };
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
function monthLabel(date: string): string {
  const [y, m] = date.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' });
}

const TODAY = new Date().toISOString().slice(0, 10);

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
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const to = useMemo(() => addDays(from, weeks * 7 - 1), [from, weeks]);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await api.get<{ data: CalendarPerson[] }>(
        `/staff-calendar/calendar?from=${from}&to=${to}`
      );
      setPeople(res.data);
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

  // Headcount per day — the coverage signal, informational only.
  const headcount = useMemo(
    () => dates.map(d => people.filter(p => {
      const day = p.days.find(x => x.date === d);
      return day?.status === 'working' || day?.status === 'partial';
    }).length),
    [dates, people]
  );

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
                    className={`px-1 py-2 border-b border-gray-200 font-medium text-center min-w-[3rem] ${
                      d === TODAY ? 'bg-ooosh-50 text-ooosh-700' : 'text-gray-600'
                    } ${weekdayIndex(d) >= 5 ? 'bg-gray-100' : ''}`}>
                    <div className="text-[10px] uppercase tracking-wide">{shortDay(d)}</div>
                    <div className="text-xs">{dayNum(d)}</div>
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
                    const title = day.status === 'working' && day.startTime
                      ? `${day.startTime.slice(0, 5)}–${day.endTime?.slice(0, 5)} · ${fmtMinutes(day.scheduledMinutes)}`
                      : day.window
                        ? `Out ${day.window.start}–${day.window.end}`
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
                            : cell.label || '·'}
                        </div>
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
                  <td key={dates[i]} className="px-1 py-2 text-center text-gray-700">{n}</td>
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
      </div>
    </div>
  );
}
