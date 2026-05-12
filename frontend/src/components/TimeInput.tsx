import { useEffect, useState } from 'react';

// Normalises partial time entry to HH:MM.
//   "10"     → "10:00"
//   "1030"   → "10:30"
//   "10:30"  → "10:30"
//   "9"      → "09:00"
// Returns '' for unparseable input so callers can decide whether to fall back
// to a default.
export function normalizeTimeInput(value: string): string {
  if (!value) return '';
  const cleaned = value.replace(/[^\d:]/g, '');
  if (/^\d{2}:\d{2}$/.test(cleaned)) return cleaned;
  if (/^\d{1,2}$/.test(cleaned)) {
    const hour = parseInt(cleaned);
    if (hour >= 0 && hour <= 23) return hour.toString().padStart(2, '0') + ':00';
  }
  if (/^\d{3,4}$/.test(cleaned)) {
    const hour = cleaned.length === 3 ? parseInt(cleaned[0]) : parseInt(cleaned.slice(0, 2));
    const mins = cleaned.length === 3 ? cleaned.slice(1) : cleaned.slice(2);
    if (hour >= 0 && hour <= 23 && parseInt(mins) >= 0 && parseInt(mins) <= 59) {
      return hour.toString().padStart(2, '0') + ':' + mins.padStart(2, '0');
    }
  }
  return '';
}

// Free-typed time input. Uses type="text" because the native type="time"
// rejects partial entry — staff typing "10" and tabbing away would lose
// the value entirely. We buffer locally, normalise on blur, and propagate
// the cleaned HH:MM. Accepts "10", "1030", "10:30", "9:5", etc.
interface TimeInputProps {
  value: string;
  onChange: (v: string) => void;
  disabled?: boolean;
  placeholder?: string;
  className?: string;
  id?: string;
  'aria-label'?: string;
}

export function TimeInput({
  value,
  onChange,
  disabled,
  placeholder = 'HH:MM (e.g. 11 or 11:30)',
  className,
  id,
  'aria-label': ariaLabel,
}: TimeInputProps) {
  const [localValue, setLocalValue] = useState(value || '');
  useEffect(() => { setLocalValue(value || ''); }, [value]);

  const commit = () => {
    const normalized = normalizeTimeInput(localValue);
    if (normalized !== localValue) setLocalValue(normalized);
    if (normalized !== (value || '')) onChange(normalized);
  };

  return (
    <input
      id={id}
      type="text"
      inputMode="numeric"
      value={localValue}
      disabled={disabled}
      placeholder={placeholder}
      aria-label={ariaLabel}
      onChange={(e) => {
        setLocalValue(e.target.value);
        // Eagerly propagate fully-typed HH:MM so consumers that re-render
        // mid-edit (e.g. linked Out↔Start times) stay in sync.
        if (/^\d{2}:\d{2}$/.test(e.target.value)) onChange(e.target.value);
      }}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          commit();
          (e.target as HTMLInputElement).blur();
        }
      }}
      className={className ?? 'w-full px-3 py-2 border border-gray-300 rounded-lg text-sm'}
    />
  );
}
