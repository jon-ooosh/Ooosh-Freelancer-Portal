import { useCallback, useEffect, useState } from 'react';
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

export default function LeaveApprovals({ onChanged }: { onChanged?: () => void }) {
  const [pending, setPending] = useState<LeaveRequest[]>([]);
  const [overtime, setOvertime] = useState<OvertimeEntry[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [leave, ot] = await Promise.all([
        api.get<{ data: LeaveRequest[] }>('/staff-calendar/leave?status=pending'),
        api.get<{ data: OvertimeEntry[] }>('/staff-calendar/overtime?status=pending'),
      ]);
      setPending(leave.data);
      setOvertime(ot.data);
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
        <div className="p-3 rounded border border-dashed border-gray-300 text-sm text-gray-500">
          Nothing waiting for a decision.
        </div>
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
    </section>
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
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open || impact) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await api.get<{ data: { impact: Impact } }>(`/staff-calendar/leave/${request.id}`);
        if (!cancelled) setImpact(res.data.impact);
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
            <span className="ml-2 text-sm font-normal text-gray-600">{range}</span>
          </div>
          <div className="text-xs text-gray-500">
            {TYPE_LABELS[request.leaveType]} · {request.days.length} day{request.days.length === 1 ? '' : 's'}
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
