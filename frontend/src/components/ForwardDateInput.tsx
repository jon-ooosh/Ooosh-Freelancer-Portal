/**
 * A date that looks forward — for due dates, reminders and follow-ups on a
 * to-do (jon, Sep 2026: a date in the past is always a slip).
 *
 * `min` is today, and three one-tap shortcuts sit underneath: Today, +7 days,
 * +14 days. The server enforces the same rule (staff-tasks.ts
 * `assertForward`), so this is the convenience, not the gate.
 *
 * An EXISTING past value is still shown as it is: an overdue task keeps its
 * due date until somebody moves it, and an edit that doesn't touch it is not
 * refused.
 */

/** Local today + n days as YYYY-MM-DD — never via toISOString(), which is UTC. */
export function ymdFromToday(days = 0): string {
  const d = new Date();
  d.setDate(d.getDate() + days);
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${mm}-${dd}`;
}

const SHORTCUTS: { label: string; days: number }[] = [
  { label: 'Today', days: 0 },
  { label: '+7 days', days: 7 },
  { label: '+14 days', days: 14 },
];

export default function ForwardDateInput({
  value, onChange, disabled, ariaLabel, className = '',
}: {
  value: string;
  onChange: (next: string) => void;
  disabled?: boolean;
  ariaLabel?: string;
  className?: string;
}) {
  return (
    <div>
      <input
        type="date"
        value={value}
        min={ymdFromToday(0)}
        disabled={disabled}
        aria-label={ariaLabel}
        onChange={e => onChange(e.target.value)}
        className={className || 'px-3 py-2 border border-gray-300 rounded text-sm bg-white'}
      />
      <div className="flex gap-2 mt-1">
        {SHORTCUTS.map(s => (
          <button key={s.label} type="button" disabled={disabled}
            onClick={() => onChange(ymdFromToday(s.days))}
            className="text-[11px] text-ooosh-600 hover:underline disabled:opacity-40">
            {s.label}
          </button>
        ))}
      </div>
    </div>
  );
}
