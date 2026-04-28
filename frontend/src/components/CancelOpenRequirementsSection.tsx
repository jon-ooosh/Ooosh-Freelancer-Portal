import { useState, useEffect } from 'react';
import { api } from '../services/api';

interface OpenRequirement {
  id: string;
  requirement_type: string;
  type_label: string;
  type_icon: string;
  custom_label: string | null;
  notes: string | null;
  due_date: string | null;
  event_trigger: string | null;
  status: string;
  phase: 'pre_hire' | 'post_hire';
}

/**
 * Section for the Lost / Cancel modals.
 *
 * Lists EVERY open (non-done, non-cancelled, non-blocked) requirement on the
 * job — reminders, hire forms, excess, vehicle prep, backline, etc. — and
 * defaults all of them to "cancel". Staff tick the items they want to KEEP
 * alive past close-out (e.g. a post-cancellation client follow-up reminder,
 * or an invoice that still needs sending after a cancellation).
 *
 * Submission shape: parent collects a Set of "keep" requirement IDs; the
 * server cancels everything else open on the job, and sets
 * keep_after_close = true on the kept items so background scanners
 * (reminder scanner, hire-form auto-emailer, etc.) keep firing them.
 *
 * If the requirement has an event_trigger that matches the target status
 * ('lost' or 'cancelled'), it'll fire on the way out anyway — we still show
 * it but pre-skip the keep tick (no point keeping it; it's about to fire
 * and self-mark done).
 */
export default function CancelOpenRequirementsSection({
  jobId,
  targetStatus,
  keepIds,
  onChange,
}: {
  jobId: string;
  targetStatus: 'lost' | 'cancelled';
  keepIds: Set<string>;
  onChange: (s: Set<string>) => void;
}) {
  const [requirements, setRequirements] = useState<OpenRequirement[]>([]);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    api.get<{ data: OpenRequirement[] }>(`/requirements/job/${jobId}`)
      .then((res) => {
        const open = (res.data || []).filter((r) =>
          !['done', 'cancelled', 'blocked'].includes(r.status),
        );
        setRequirements(open);
      })
      .catch(() => {})
      .finally(() => setLoaded(true));
  // Intentionally only on mount — keepIds/onChange are not deps to avoid re-fetch loops
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jobId, targetStatus]);

  if (!loaded || requirements.length === 0) return null;

  const toggle = (id: string) => {
    const next = new Set(keepIds);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    onChange(next);
  };

  return (
    <div className="bg-amber-50 border border-amber-200 rounded-lg p-3 space-y-2">
      <div className="text-sm font-medium text-amber-900">Open requirements on this job</div>
      <p className="text-xs text-amber-800">
        These will all be cancelled when you mark the job as {targetStatus}. Tick any you want to keep alive
        (e.g. a follow-up reminder, an outstanding invoice, a refund chase).
      </p>
      <ul className="space-y-1.5">
        {requirements.map((r) => {
          const label = r.custom_label || r.type_label;
          const willFireOnExit = r.event_trigger === targetStatus;
          const isKept = keepIds.has(r.id);
          return (
            <li key={r.id}>
              <label className="flex items-start gap-2 cursor-pointer p-1.5 rounded hover:bg-amber-100/60">
                <input
                  type="checkbox"
                  checked={isKept}
                  onChange={() => toggle(r.id)}
                  disabled={willFireOnExit}
                  className="mt-0.5"
                />
                <div className="text-sm flex-1 min-w-0">
                  <div className="flex items-center gap-1.5">
                    <span className="text-base">{r.type_icon}</span>
                    <span className="font-medium text-gray-900">{label}</span>
                    <span className="text-[10px] uppercase text-gray-500 tracking-wide">{r.type_label}</span>
                    {r.phase === 'post_hire' && (
                      <span className="text-[10px] uppercase text-blue-600">post-hire</span>
                    )}
                  </div>
                  {(r.due_date || r.event_trigger) && (
                    <div className="text-xs text-gray-600 mt-0.5">
                      {r.due_date && <>Due: {new Date(r.due_date).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}</>}
                      {r.due_date && r.event_trigger && ' · '}
                      {r.event_trigger && <>Triggers on: {r.event_trigger}</>}
                      {willFireOnExit && (
                        <span className="text-amber-700"> — will fire on the way out, then auto-cancel</span>
                      )}
                    </div>
                  )}
                  {!isKept && !willFireOnExit && (
                    <div className="text-[11px] text-red-600 mt-0.5">Will be cancelled</div>
                  )}
                  {isKept && (
                    <div className="text-[11px] text-green-700 mt-0.5">Kept — will keep firing past close-out</div>
                  )}
                </div>
              </label>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
