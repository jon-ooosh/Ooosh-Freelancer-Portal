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
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await api.get<{ data: LeaveRequest[] }>('/staff-calendar/leave');
      setRequests(res.data);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load your requests');
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

      <BookTimeOff onBooked={async (msg) => { setNotice(msg); setError(null); await load(); }} onError={setError} />

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

      {past.length > 0 && (
        <section className="mt-6">
          <h2 className="text-sm font-semibold text-gray-900 uppercase tracking-wide mb-2">Past</h2>
          <div className="space-y-2">
            {past.slice(0, 20).map(r => <RequestCard key={r.id} r={r} />)}
          </div>
        </section>
      )}
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

function BookTimeOff({ onBooked, onError }: {
  onBooked: (msg: string) => Promise<void>; onError: (msg: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [leaveType, setLeaveType] = useState<LeaveType>('holiday');
  const [startDate, setStartDate] = useState(TODAY);
  const [endDate, setEndDate] = useState(TODAY);
  const [halfDays, setHalfDays] = useState<Record<string, 'full' | 'am' | 'pm'>>({});
  const [note, setNote] = useState('');
  const [impact, setImpact] = useState<Impact | null>(null);
  const [checking, setChecking] = useState(false);
  const [saving, setSaving] = useState(false);

  // Keep the end date sane rather than letting an invalid range reach the API.
  useEffect(() => { if (endDate < startDate) setEndDate(startDate); }, [startDate, endDate]);

  const halfDaysKey = useMemo(() => JSON.stringify(halfDays), [halfDays]);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setChecking(true);
    const t = setTimeout(async () => {
      try {
        const qs = new URLSearchParams({
          from: startDate, to: endDate, type: leaveType, halfDays: halfDaysKey,
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
  }, [open, startDate, endDate, leaveType, halfDaysKey]);

  async function submit() {
    setSaving(true);
    try {
      await api.post('/staff-calendar/leave', {
        leaveType, startDate, endDate,
        halfDays: Object.keys(halfDays).length ? halfDays : undefined,
        note: note || null,
      });
      setOpen(false); setNote(''); setHalfDays({}); setImpact(null);
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
            {(Object.keys(TYPE_LABELS) as LeaveType[]).map(t => (
              <option key={t} value={t}>{TYPE_LABELS[t]}</option>
            ))}
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

      {impact && impact.days.length > 0 && impact.days.length <= 10 && (
        <div className="mb-3">
          <span className="block text-xs text-gray-600 mb-1">Days (click to make a half day)</span>
          <div className="flex flex-wrap gap-1.5">
            {impact.days.map(d => {
              const portion = halfDays[d.date] ?? 'full';
              const next = portion === 'full' ? 'am' : portion === 'am' ? 'pm' : 'full';
              return (
                <button key={d.date}
                  onClick={() => setHalfDays(prev => {
                    const n = { ...prev };
                    if (next === 'full') delete n[d.date]; else n[d.date] = next;
                    return n;
                  })}
                  className={`px-2 py-1 rounded border text-xs ${
                    portion === 'full'
                      ? 'border-gray-300 bg-white text-gray-700'
                      : 'border-ooosh-300 bg-ooosh-50 text-ooosh-800'}`}>
                  {fmtDate(d.date)}
                  {portion !== 'full' && <span className="ml-1 font-medium">{portion}</span>}
                  <span className="ml-1 text-gray-400">{fmtH(d.minutes)}</span>
                </button>
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
