import { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '../services/api';
import { ImpactPanel } from '../pages/MyTimePage';

/**
 * Leave approvals (Staff Calendar, Phase B2). See spec §11.
 *
 * The point of this surface is the CONTEXT. BrightHR mails a request with no
 * information attached, so approving is a guess: you cannot see who else is
 * off, whether anyone would be left in, or what the balance becomes. Here the
 * request arrives with all of it already worked out.
 *
 * Everything shown is a warning. Nothing blocks approval — the decision stays
 * with the person making it, which is the whole reason to show them the facts
 * rather than enforce a rule.
 */

type LeaveType = 'holiday' | 'toil' | 'unpaid';

interface LeaveRequest {
  id: string;
  personId: string;
  personName: string;
  leaveType: LeaveType;
  startDate: string;
  endDate: string;
  totalMinutes: number;
  status: string;
  requestNote: string | null;
  requestedAt: string;
  days: { date: string; minutes: number; portion: string }[];
  // Spec §5.4 — optional, so an older backend simply shows none of it.
  /** A CHANGE: the approved booking it replaces once approved. */
  replacesRequestId?: string | null;
  replaces?: { startDate: string; endDate: string; totalMinutes: number; leaveType: LeaveType } | null;
  /** An approved booking with an ask to cancel waiting. */
  cancelAsk?: { requestedAt: string; note: string | null; declinedAt: string | null } | null;
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
  holiday: 'Holiday', toil: 'TOIL', unpaid: 'Unpaid leave',
};

function fmtDate(iso: string): string {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('en-GB', {
    weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC',
  });
}
function fmtH(min: number): string {
  const a = Math.abs(min), h = Math.floor(a / 60), m = a % 60;
  const sign = min < 0 ? '-' : '';
  if (h === 0) return `${sign}${m}m`;
  return m === 0 ? `${sign}${h}h` : `${sign}${h}h ${m}m`;
}

interface OvertimeEntry {
  id: string; personName: string; workDate: string;
  startTime: string | null; endTime: string | null;
  minutes: number; reason: string; status: string;
}

/** A one-off working-from-home request (spec §19). */
interface WfhRequest {
  id: string; personName: string; startDate: string; endDate: string; requestNote: string | null;
}

/** A day swap (spec §8.2) — a day off, and a usual day off worked instead. */
interface DaySwap {
  id: string; personName: string; offDate: string; workDate: string;
  startTime: string; endTime: string; minutes: number; usualMinutes: number | null;
  requestNote: string | null;
}

export default function LeaveApprovals({ onChanged }: { onChanged?: () => void }) {
  const [pending, setPending] = useState<LeaveRequest[]>([]);
  const [overtime, setOvertime] = useState<OvertimeEntry[]>([]);
  const [wfh, setWfh] = useState<WfhRequest[]>([]);
  const [swaps, setSwaps] = useState<DaySwap[]>([]);
  // Approved bookings somebody has asked, in writing, to cancel (§5.4).
  const [cancelAsks, setCancelAsks] = useState<LeaveRequest[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [leave, ot, wf, sw, ca] = await Promise.all([
        api.get<{ data: LeaveRequest[] }>('/staff-calendar/leave?status=pending'),
        api.get<{ data: OvertimeEntry[] }>('/staff-calendar/overtime?status=pending'),
        api.get<{ data: WfhRequest[] }>('/staff-calendar/wfh?status=pending')
          .catch(() => ({ data: [] as WfhRequest[] })),
        api.get<{ data: DaySwap[] }>('/staff-calendar/swaps?status=pending')
          .catch(() => ({ data: [] as DaySwap[] })),
        api.get<{ data: LeaveRequest[] }>('/staff-calendar/leave?cancelAsked=1')
          .catch(() => ({ data: [] as LeaveRequest[] })),
      ]);
      setCancelAsks(ca.data ?? []);
      setPending(leave.data);
      setOvertime(ot.data);
      setWfh(wf.data ?? []);
      setSwaps(sw.data ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load requests');
    } finally { setLoaded(true); }
  }, []);

  useEffect(() => { void load(); }, [load]);

  if (!loaded) return null;

  return (
    <section className="mb-6">
      <div className="flex items-baseline gap-2 mb-2">
        <h2 className="text-sm font-semibold text-gray-900 uppercase tracking-wide">Waiting for you</h2>
        {pending.length > 0 && (
          <span className="text-xs px-1.5 py-0.5 rounded-full bg-amber-100 text-amber-800 font-medium">
            {pending.length} waiting
          </span>
        )}
      </div>

      {error && <div className="mb-2 p-2.5 rounded bg-red-50 border border-red-200 text-sm text-red-700">{error}</div>}

      {pending.length === 0 ? (
        // Only when NOTHING is waiting — overtime, home days and swaps are
        // listed below, and "nothing waiting" above them read as a contradiction.
        pending.length + overtime.length + wfh.length + swaps.length + cancelAsks.length === 0 && (
          <div className="p-3 rounded border border-dashed border-gray-300 text-sm text-gray-500">
            Nothing waiting for a decision.
          </div>
        )
      ) : (
        <div className="space-y-2">
          {pending.map(r => (
            <ApprovalCard key={r.id} request={r}
              open={openId === r.id}
              onToggle={() => setOpenId(openId === r.id ? null : r.id)}
              onDecided={async () => { setError(null); await load(); onChanged?.(); }}
              onError={setError} />
          ))}
        </div>
      )}

      {cancelAsks.length > 0 && (
        <div className="mt-4">
          <div className="flex items-baseline gap-2 mb-2">
            <h3 className="text-sm font-semibold text-gray-900 uppercase tracking-wide">Asks to cancel</h3>
            <span className="text-xs px-1.5 py-0.5 rounded-full bg-amber-100 text-amber-800 font-medium">
              {cancelAsks.length} waiting
            </span>
          </div>
          <p className="text-xs text-gray-500 mb-2">
            Approved time off they no longer want. Approving gives the time back to their balance;
            declining leaves it booked, and they&apos;re told why.
          </p>
          <div className="space-y-2">
            {cancelAsks.map(r => (
              <CancelAskRow key={r.id} request={r}
                onDecided={async () => { setError(null); await load(); onChanged?.(); }}
                onError={setError} />
            ))}
          </div>
        </div>
      )}

      {overtime.length > 0 && (
        <div className="mt-4">
          <div className="flex items-baseline gap-2 mb-2">
            <h3 className="text-sm font-semibold text-gray-900 uppercase tracking-wide">Overtime</h3>
            <span className="text-xs px-1.5 py-0.5 rounded-full bg-amber-100 text-amber-800 font-medium">
              {overtime.length} waiting
            </span>
          </div>
          <p className="text-xs text-gray-500 mb-2">
            Approving adds it to their bank. Whether it becomes time off or pay is decided later,
            by them.
          </p>
          <div className="space-y-2">
            {overtime.map(e => (
              <OvertimeApprovalRow key={e.id} entry={e}
                onDecided={async () => { setError(null); await load(); onChanged?.(); }}
                onError={setError} />
            ))}
          </div>
        </div>
      )}

      {wfh.length > 0 && (
        <div className="mt-4">
          <div className="flex items-baseline gap-2 mb-2">
            <h3 className="text-sm font-semibold text-gray-900 uppercase tracking-wide">Working from home</h3>
            <span className="text-xs px-1.5 py-0.5 rounded-full bg-amber-100 text-amber-800 font-medium">
              {wfh.length} waiting
            </span>
          </div>
          <p className="text-xs text-gray-500 mb-2">
            Costs nothing and touches no balance — the question is only who is left in the building.
            Check the calendar for those days.
          </p>
          <div className="space-y-2">
            {wfh.map(w => (
              <WfhApprovalRow key={w.id} request={w}
                onDecided={async () => { setError(null); await load(); onChanged?.(); }}
                onError={setError} />
            ))}
          </div>
        </div>
      )}

      {swaps.length > 0 && (
        <div className="mt-4">
          <div className="flex items-baseline gap-2 mb-2">
            <h3 className="text-sm font-semibold text-gray-900 uppercase tracking-wide">Day swaps</h3>
            <span className="text-xs px-1.5 py-0.5 rounded-full bg-amber-100 text-amber-800 font-medium">
              {swaps.length} waiting
            </span>
          </div>
          <p className="text-xs text-gray-500 mb-2">
            Costs no holiday — it moves which day they&apos;re in. The calendar changes only once you approve.
            Check it for both days.
          </p>
          <div className="space-y-2">
            {swaps.map(sw => (
              <SwapApprovalRow key={sw.id} swap={sw}
                onDecided={async () => { setError(null); await load(); onChanged?.(); }}
                onError={setError} />
            ))}
          </div>
        </div>
      )}
    </section>
  );
}

/** An ask to cancel approved time off (spec §5.4). */
function CancelAskRow({ request, onDecided, onError }: {
  request: LeaveRequest; onDecided: () => Promise<void>; onError: (msg: string) => void;
}) {
  const [busy, setBusy] = useState(false);

  async function decide(action: 'approve' | 'decline') {
    let body: Record<string, string> = {};
    if (action === 'approve') {
      if (!confirm(`Cancel ${request.personName}'s booking? The time goes back to their balance, and they're told.`)) return;
    } else {
      const note = prompt(`Why are you declining? ${request.personName}'s booking stays, and they'll see this.`);
      if (!note?.trim()) return;
      body = { note };
    }
    setBusy(true);
    try {
      await api.post(`/staff-calendar/leave/${request.id}/cancel-request/${action}`, body);
      await onDecided();
    } catch (err) {
      onError(err instanceof Error ? err.message : `Failed to ${action}`);
    } finally { setBusy(false); }
  }

  const range = request.startDate === request.endDate
    ? fmtDate(request.startDate)
    : `${fmtDate(request.startDate)} – ${fmtDate(request.endDate)}`;
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 p-3 rounded-lg border border-gray-200 bg-white">
      <div className="min-w-0">
        <div className="font-medium text-gray-900">
          {request.personName}
          <span className="ml-2 text-sm font-normal text-gray-600">asks to cancel {range}</span>
        </div>
        <div className="text-xs text-gray-500">
          {TYPE_LABELS[request.leaveType]} · {request.days.length} day{request.days.length === 1 ? '' : 's'}
          {' · '}{fmtH(request.totalMinutes)}{request.leaveType === 'unpaid' ? '' : ' back to their balance'}
          {request.cancelAsk?.note && ` · “${request.cancelAsk.note}”`}
        </div>
      </div>
      <div className="flex gap-2 shrink-0">
        <button onClick={() => void decide('approve')} disabled={busy}
          className="px-2.5 py-1.5 text-sm rounded bg-emerald-600 text-white hover:bg-emerald-700 disabled:opacity-50">
          Approve
        </button>
        <button onClick={() => void decide('decline')} disabled={busy}
          className="px-2.5 py-1.5 text-sm rounded border border-red-300 text-red-700 hover:bg-red-50 disabled:opacity-50">
          Decline
        </button>
      </div>
    </div>
  );
}

function SwapApprovalRow({ swap, onDecided, onError }: {
  swap: DaySwap; onDecided: () => Promise<void>; onError: (msg: string) => void;
}) {
  const [busy, setBusy] = useState(false);

  async function decide(action: 'approve' | 'decline') {
    let body: Record<string, string> = {};
    if (action === 'decline') {
      const note = prompt(`Why are you declining ${swap.personName}'s swap?`);
      if (!note?.trim()) return;
      body = { note };
    }
    setBusy(true);
    try {
      await api.post(`/staff-calendar/swaps/${swap.id}/${action}`, body);
      await onDecided();
    } catch (err) {
      onError(err instanceof Error ? err.message : `Failed to ${action}`);
    } finally { setBusy(false); }
  }

  // Their hours on the new day against the day given up — the one thing the
  // calendar cannot show.
  const diff = swap.usualMinutes === null ? null : swap.minutes - swap.usualMinutes;
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 p-3 rounded-lg border border-gray-200 bg-white">
      <div className="min-w-0">
        <div className="font-medium text-gray-900">
          {swap.personName}
          <span className="ml-2 text-sm font-normal text-gray-600">
            off {fmtDate(swap.offDate)} · working {fmtDate(swap.workDate)} {swap.startTime}–{swap.endTime} instead
          </span>
        </div>
        <div className="text-xs text-gray-500">
          {fmtH(swap.minutes)}
          {diff !== null && (diff === 0
            ? ' — the same as the day given up'
            : ` — ${fmtH(Math.abs(diff))} ${diff > 0 ? 'longer' : 'shorter'} than the day given up`)}
          {swap.requestNote && ` · ${swap.requestNote}`}
        </div>
      </div>
      <div className="flex gap-2 shrink-0">
        <button onClick={() => void decide('approve')} disabled={busy}
          className="px-2.5 py-1.5 text-sm rounded bg-emerald-600 text-white hover:bg-emerald-700 disabled:opacity-50">
          Approve
        </button>
        <button onClick={() => void decide('decline')} disabled={busy}
          className="px-2.5 py-1.5 text-sm rounded border border-red-300 text-red-700 hover:bg-red-50 disabled:opacity-50">
          Decline
        </button>
      </div>
    </div>
  );
}

function WfhApprovalRow({ request, onDecided, onError }: {
  request: WfhRequest; onDecided: () => Promise<void>; onError: (msg: string) => void;
}) {
  const [busy, setBusy] = useState(false);

  async function decide(action: 'approve' | 'decline') {
    let body: Record<string, string> = {};
    if (action === 'decline') {
      const note = prompt(`Why are you declining ${request.personName}'s home day?`);
      if (!note) return;
      body = { note };
    }
    setBusy(true);
    try {
      await api.post(`/staff-calendar/wfh/${request.id}/${action}`, body);
      await onDecided();
    } catch (err) {
      onError(err instanceof Error ? err.message : `Failed to ${action}`);
    } finally { setBusy(false); }
  }

  return (
    <div className="flex flex-wrap items-center justify-between gap-3 p-3 rounded-lg border border-gray-200 bg-white">
      <div className="min-w-0">
        <div className="font-medium text-gray-900">
          {request.personName}
          <span className="ml-2 text-sm font-normal text-gray-600">
            {fmtDate(request.startDate)}{request.endDate !== request.startDate && ` – ${fmtDate(request.endDate)}`}
          </span>
        </div>
        {request.requestNote && <div className="text-xs text-gray-500">{request.requestNote}</div>}
      </div>
      <div className="flex gap-2 shrink-0">
        <button onClick={() => void decide('approve')} disabled={busy}
          className="px-2.5 py-1.5 text-sm rounded bg-emerald-600 text-white hover:bg-emerald-700 disabled:opacity-50">
          Approve
        </button>
        <button onClick={() => void decide('decline')} disabled={busy}
          className="px-2.5 py-1.5 text-sm rounded border border-red-300 text-red-700 hover:bg-red-50 disabled:opacity-50">
          Decline
        </button>
      </div>
    </div>
  );
}

function OvertimeApprovalRow({ entry, onDecided, onError }: {
  entry: OvertimeEntry; onDecided: () => Promise<void>; onError: (msg: string) => void;
}) {
  const [busy, setBusy] = useState(false);

  async function decide(action: 'approve' | 'decline') {
    let body: Record<string, string> = {};
    if (action === 'decline') {
      const note = prompt(`Why are you declining ${entry.personName}'s overtime?`);
      if (!note) return;
      body = { note };
    }
    setBusy(true);
    try {
      await api.post(`/staff-calendar/overtime/${entry.id}/${action}`, body);
      await onDecided();
    } catch (err) {
      onError(err instanceof Error ? err.message : `Failed to ${action}`);
    } finally { setBusy(false); }
  }

  return (
    <div className="flex flex-wrap items-center justify-between gap-3 p-3 rounded-lg border border-gray-200 bg-white">
      <div className="min-w-0">
        <div className="font-medium text-gray-900">
          {entry.personName}
          <span className="ml-2 text-sm font-normal text-gray-600">{fmtDate(entry.workDate)}</span>
          <span className="ml-2 text-sm text-gray-900">{fmtH(entry.minutes)}</span>
        </div>
        <div className="text-xs text-gray-500">
          {entry.startTime && entry.endTime && `${entry.startTime.slice(0, 5)}–${entry.endTime.slice(0, 5)} · `}
          {entry.reason}
        </div>
      </div>
      <div className="flex gap-2 shrink-0">
        <button onClick={() => void decide('approve')} disabled={busy}
          className="px-2.5 py-1.5 text-sm rounded bg-emerald-600 text-white hover:bg-emerald-700 disabled:opacity-50">
          Approve
        </button>
        <button onClick={() => void decide('decline')} disabled={busy}
          className="px-2.5 py-1.5 text-sm rounded border border-red-300 text-red-700 hover:bg-red-50 disabled:opacity-50">
          Decline
        </button>
      </div>
    </div>
  );
}

function ApprovalCard({ request, open, onToggle, onDecided, onError }: {
  request: LeaveRequest; open: boolean; onToggle: () => void;
  onDecided: (msg?: string) => Promise<void>; onError: (msg: string) => void;
}) {
  const [impact, setImpact] = useState<Impact | null>(null);
  // For a change: the booking it replaces, days and all.
  const [original, setOriginal] = useState<LeaveRequest | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open || impact) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await api.get<{ data: { impact: Impact; original?: LeaveRequest | null } }>(`/staff-calendar/leave/${request.id}`);
        if (!cancelled) { setImpact(res.data.impact); setOriginal(res.data.original ?? null); }
      } catch { /* the card still works without context */ }
    })();
    return () => { cancelled = true; };
  }, [open, impact, request.id]);

  async function decide(action: 'approve' | 'decline') {
    let body: Record<string, string> = {};
    if (action === 'decline') {
      const note = prompt(`Why are you declining ${request.personName}'s request?`);
      if (!note) return;
      body = { note };
    }
    setBusy(true);
    try {
      await api.post(`/staff-calendar/leave/${request.id}/${action}`, body);
      await onDecided();
    } catch (err) {
      onError(err instanceof Error ? err.message : `Failed to ${action}`);
    } finally { setBusy(false); }
  }

  const range = request.startDate === request.endDate
    ? fmtDate(request.startDate)
    : `${fmtDate(request.startDate)} – ${fmtDate(request.endDate)}`;
  // A CHANGE to approved time off (§5.4) — approving swaps the old booking
  // for this one; declining leaves the old one as it was.
  const was = request.replaces
    ? (request.replaces.startDate === request.replaces.endDate
        ? fmtDate(request.replaces.startDate)
        : `${fmtDate(request.replaces.startDate)} – ${fmtDate(request.replaces.endDate)}`)
    : null;
  // Taking a day out of the middle leaves both end dates where they were, so
  // the ranges alone can read "was Mon – Fri → now Mon – Fri". Say the hours,
  // and once it is open, the days.
  const headline = was === null ? range
    : was !== range ? `asks to change: was ${was} → now ${range}`
    : request.replaces && request.replaces.totalMinutes !== request.totalMinutes
      ? `asks to change ${range}: ${fmtH(request.totalMinutes)} instead of ${fmtH(request.replaces.totalMinutes)}`
      : `asks to change ${range}`;
  const daysDiff = useMemo(() => {
    if (!original) return null;
    const word = (p: string) => p === 'full' ? 'whole day' : p === 'am' ? 'morning' : p === 'pm' ? 'afternoon' : 'set times';
    const lines: string[] = [];
    const gone = original.days.filter(o => !request.days.some(n => n.date === o.date)).map(o => fmtDate(o.date));
    const added = request.days.filter(n => !original.days.some(o => o.date === n.date)).map(n => fmtDate(n.date));
    const altered = request.days
      .filter(n => original.days.some(o => o.date === n.date && o.portion !== n.portion))
      .map(n => `${fmtDate(n.date)} (${word(n.portion)})`);
    if (gone.length) lines.push(`No longer off: ${gone.join(', ')}`);
    if (added.length) lines.push(`Now off: ${added.join(', ')}`);
    if (altered.length) lines.push(`Now part of the day: ${altered.join(', ')}`);
    if (original.leaveType !== request.leaveType) {
      lines.push(`${TYPE_LABELS[original.leaveType]} → ${TYPE_LABELS[request.leaveType]}`);
    }
    return lines;
  }, [original, request.days, request.leaveType]);

  // Thinnest cover across the requested days — the single number that decides
  // whether this approval is routine or needs thinking about.
  const worst: number | null = impact
    ? impact.coverage.reduce<number | null>(
        (min, c) => (min === null || c.ifApproved < min ? c.ifApproved : min), null)
    : null;

  return (
    <div className="rounded-lg border border-gray-200 bg-white">
      <button onClick={onToggle} className="w-full flex items-center justify-between gap-3 px-4 py-3 text-left hover:bg-gray-50">
        <div className="min-w-0">
          <div className="font-medium text-gray-900">
            {request.personName}
            <span className="ml-2 text-sm font-normal text-gray-600">{headline}</span>
          </div>
          <div className="text-xs text-gray-500">
            {was && 'Change · '}{TYPE_LABELS[request.leaveType]} · {request.days.length} day{request.days.length === 1 ? '' : 's'}
            {' · '}{fmtH(request.totalMinutes)}
            {impact && worst !== null && (
              <span className={worst <= 1 ? 'text-amber-700 font-medium' : ''}>
                {' · '}{worst} in if approved
              </span>
            )}
          </div>
        </div>
        <span className="text-gray-400 text-sm shrink-0">{open ? '▲' : '▼'}</span>
      </button>

      {open && (
        <div className="border-t border-gray-100 p-4 space-y-3">
          {request.requestNote && (
            <p className="text-sm text-gray-700 italic">“{request.requestNote}”</p>
          )}

          <ImpactPanel impact={impact} checking={!impact} leaveType={request.leaveType} />

          {impact && impact.coverage.length > 0 && (
            <div>
              <h4 className="text-xs font-medium text-gray-600 mb-1">Cover, day by day</h4>
              <div className="flex flex-wrap gap-1.5">
                {impact.coverage.map(c => (
                  <span key={c.date}
                    className={`px-2 py-1 rounded text-xs border ${
                      c.ifApproved === 0 ? 'border-red-300 bg-red-50 text-red-800'
                        : c.ifApproved === 1 ? 'border-amber-300 bg-amber-50 text-amber-800'
                        : 'border-gray-200 bg-white text-gray-600'}`}>
                    {fmtDate(c.date)}: {c.scheduled} → <strong>{c.ifApproved}</strong>
                  </span>
                ))}
              </div>
            </div>
          )}

          {daysDiff && daysDiff.length > 0 && (
            <div className="text-sm text-gray-800">
              <h4 className="text-xs font-medium text-gray-600 mb-0.5">What changes</h4>
              {daysDiff.map(l => <div key={l}>{l}</div>)}
            </div>
          )}

          {was && (
            <p className="text-xs text-gray-600">
              Approving cancels the {was} booking and books this instead, in one go. Declining leaves {was} as it was.
              Cover and notice are checked only for the days that change.
            </p>
          )}

          <div className="flex flex-wrap gap-2 pt-1">
            <button onClick={() => void decide('approve')} disabled={busy}
              className="px-3 py-2 text-sm rounded bg-emerald-600 text-white hover:bg-emerald-700 disabled:opacity-50">
              {busy ? 'Working…' : 'Approve'}
            </button>
            <button onClick={() => void decide('decline')} disabled={busy}
              className="px-3 py-2 text-sm rounded border border-red-300 text-red-700 hover:bg-red-50 disabled:opacity-50">
              Decline
            </button>
            <span className="self-center text-xs text-gray-500">
              Warnings above inform the decision — none of them stop you approving.
            </span>
          </div>
        </div>
      )}
    </div>
  );
}
