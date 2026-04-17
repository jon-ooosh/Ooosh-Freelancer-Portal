import { useState, useEffect } from 'react';
import { api } from '../services/api';

interface OpenReminder {
  id: string;
  requirement_type: string;
  custom_label: string | null;
  notes: string | null;
  due_date: string | null;
  event_trigger: string | null;
  status: string;
}

/**
 * Section for Lost / Cancel modals: lists open reminders on the job and
 * lets the user tick which ones should be auto-cancelled. Default is
 * keep — the user explicitly opts each reminder out. Event-triggered
 * reminders whose trigger won't fire on this transition are pre-selected
 * since they'd never fire anyway.
 */
export default function CancelRemindersSection({
  jobId,
  targetStatus,
  selected,
  onChange,
}: {
  jobId: string;
  targetStatus: 'lost' | 'cancelled';
  selected: Set<string>;
  onChange: (s: Set<string>) => void;
}) {
  const [reminders, setReminders] = useState<OpenReminder[]>([]);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    api.get<{ data: OpenReminder[] }>(`/requirements/job/${jobId}`)
      .then((res) => {
        const open = (res.data || []).filter((r) =>
          r.requirement_type === 'reminder' &&
          !['done', 'cancelled', 'blocked'].includes(r.status),
        );
        setReminders(open);
        // Pre-tick event-triggered reminders that won't fire on this transition
        const autoSelect = new Set<string>();
        for (const r of open) {
          if (r.event_trigger && r.event_trigger !== targetStatus) autoSelect.add(r.id);
        }
        if (autoSelect.size > 0) onChange(autoSelect);
      })
      .catch(() => {})
      .finally(() => setLoaded(true));
  // Intentionally only on mount — onChange/selected are not deps to avoid re-fetch loops
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jobId, targetStatus]);

  if (!loaded || reminders.length === 0) return null;

  const toggle = (id: string) => {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    onChange(next);
  };

  return (
    <div className="bg-gray-50 border border-gray-200 rounded-lg p-3 space-y-2">
      <div className="text-sm font-medium text-gray-700">Open reminders on this job</div>
      <p className="text-xs text-gray-500">
        Tick any that should be cancelled. Leave unticked if the follow-up is still worth doing.
      </p>
      {reminders.map((r) => {
        const willNeverFire = r.event_trigger && r.event_trigger !== targetStatus;
        return (
          <label key={r.id} className="flex items-start gap-2 cursor-pointer">
            <input
              type="checkbox"
              checked={selected.has(r.id)}
              onChange={() => toggle(r.id)}
              className="mt-0.5"
            />
            <div className="text-sm flex-1 min-w-0">
              <div className="text-gray-900">{r.custom_label || 'Reminder'}</div>
              {(r.due_date || r.event_trigger) && (
                <div className="text-xs text-gray-500">
                  {r.due_date && <>Due: {new Date(r.due_date).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}</>}
                  {r.due_date && r.event_trigger && ' · '}
                  {r.event_trigger && <>Triggers on: {r.event_trigger}</>}
                  {willNeverFire && <span className="text-amber-600"> (won't fire — job is now {targetStatus})</span>}
                </div>
              )}
            </div>
          </label>
        );
      })}
    </div>
  );
}
