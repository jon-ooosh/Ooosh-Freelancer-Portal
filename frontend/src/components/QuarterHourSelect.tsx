/**
 * A time picker in quarter hours — THE definition, per CLAUDE.md's helper rule.
 *
 * WHY THIS IS NOT `<input type="time" step={900}>`. It was, and the step did
 * nothing. `step` governs validation and the little spinner arrows, but Chrome's
 * dropdown picker — the thing people actually click — ignores it and lists all
 * sixty minutes regardless. So the field accepted 09:07 from the one route into
 * it that anybody uses, and the quarter-hour rule existed only in the source.
 *
 * Owning the option list instead makes the granularity ours rather than the
 * browser's: same behaviour in every browser, on a phone, and in a test. Typing
 * still works — focus the field and type "09" and it jumps.
 *
 * NOT for overtime. `staff_overtime_entries` has a `minutes % 5 = 0` CHECK and
 * five-minute steps are deliberate there; the two are answering different
 * questions. Overtime keeps its time input.
 */

/** "00:00", "00:15", … "23:45" — 96 of them. */
export const QUARTER_HOUR_TIMES: string[] = Array.from({ length: 96 }, (_, i) => {
  const h = Math.floor(i / 4);
  const m = (i % 4) * 15;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
});

interface QuarterHourSelectProps {
  value: string;
  onChange: (value: string) => void;
  className?: string;
  disabled?: boolean;
  'aria-label'?: string;
}

export function QuarterHourSelect({
  value,
  onChange,
  className = '',
  disabled = false,
  'aria-label': ariaLabel,
}: QuarterHourSelectProps) {
  // A value that is not on the quarter hour still has to render. Bookings made
  // before this component existed can hold 09:07, and a <select> whose value
  // matches no option shows blank — which would look like an empty field and
  // then silently overwrite the real time on the next save. Carry it as its own
  // option instead, so an odd time survives being looked at.
  const options = QUARTER_HOUR_TIMES.includes(value) || value === ''
    ? QUARTER_HOUR_TIMES
    : [value, ...QUARTER_HOUR_TIMES].sort();

  return (
    <select
      value={value}
      disabled={disabled}
      aria-label={ariaLabel}
      onChange={e => onChange(e.target.value)}
      className={className}
    >
      {options.map(t => <option key={t} value={t}>{t}</option>)}
    </select>
  );
}
