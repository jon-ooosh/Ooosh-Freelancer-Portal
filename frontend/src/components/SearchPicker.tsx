/**
 * SearchPicker — type to find one thing in a list (a person, a van, a job)
 * instead of scrolling a <select>.
 *
 * Two sources:
 *  - `options`: a list already in hand, filtered as you type;
 *  - `loadOptions`: asked for as you type (debounced), for lists too big to
 *    load up front, e.g. jobs.
 *
 * Once something is picked it shows as a chip with a × to clear. `value`
 * carries its own label, so a picked item that is not in `options` (a van no
 * longer in the active fleet) still shows rather than going blank.
 */

import { useEffect, useMemo, useRef, useState } from 'react';

export interface PickerOption {
  value: string;
  label: string;
  /** Smaller grey text after the label. */
  hint?: string;
}

export default function SearchPicker({
  value, onChange, options, loadOptions, placeholder = 'Type to search…', minChars = 0, disabled, autoFocus,
}: {
  value: PickerOption | null;
  onChange: (next: PickerOption | null) => void;
  options?: PickerOption[];
  loadOptions?: (q: string) => Promise<PickerOption[]>;
  placeholder?: string;
  /** Characters needed before `loadOptions` is asked. */
  minChars?: number;
  disabled?: boolean;
  autoFocus?: boolean;
}) {
  const [q, setQ] = useState('');
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const [remote, setRemote] = useState<PickerOption[]>([]);
  const [loading, setLoading] = useState(false);
  const boxRef = useRef<HTMLDivElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Close on a click anywhere else.
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, []);

  // Remote search, debounced. A late reply for an old query is ignored.
  useEffect(() => {
    if (!loadOptions) return;
    if (timer.current) clearTimeout(timer.current);
    const term = q.trim();
    if (term.length < minChars) { setRemote([]); setLoading(false); return; }
    let stale = false;
    setLoading(true);
    timer.current = setTimeout(() => {
      loadOptions(term)
        .then((r) => { if (!stale) setRemote(r); })
        .catch(() => { if (!stale) setRemote([]); })
        .finally(() => { if (!stale) setLoading(false); });
    }, 250);
    return () => { stale = true; if (timer.current) clearTimeout(timer.current); };
  }, [q, loadOptions, minChars]);

  const list = useMemo(() => {
    if (loadOptions) return remote;
    const term = q.trim().toLowerCase();
    const all = options ?? [];
    if (!term) return all.slice(0, 50);
    return all.filter((o) => `${o.label} ${o.hint ?? ''}`.toLowerCase().includes(term)).slice(0, 50);
  }, [loadOptions, remote, options, q]);

  useEffect(() => { setActive(0); }, [q, open]);

  function pick(o: PickerOption) {
    onChange(o);
    setQ('');
    setOpen(false);
  }

  if (value) {
    return (
      <div className="flex items-center gap-2 w-full px-3 py-2 rounded-lg border border-gray-300 bg-white text-sm">
        <span className="min-w-0 flex-1 truncate text-gray-900">
          {value.label}{value.hint && <span className="text-gray-400"> · {value.hint}</span>}
        </span>
        {!disabled && (
          <button type="button" onClick={() => onChange(null)} aria-label="Clear"
            className="shrink-0 text-gray-400 hover:text-gray-700 text-lg leading-none">×</button>
        )}
      </div>
    );
  }

  const tooShort = !!loadOptions && q.trim().length < minChars;

  return (
    <div ref={boxRef} className="relative w-full">
      <input
        value={q}
        disabled={disabled}
        autoFocus={autoFocus}
        onChange={(e) => { setQ(e.target.value); setOpen(true); }}
        onFocus={() => setOpen(true)}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown') { e.preventDefault(); setOpen(true); setActive((a) => Math.min(a + 1, list.length - 1)); }
          else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((a) => Math.max(a - 1, 0)); }
          else if (e.key === 'Enter') { if (open && list[active]) { e.preventDefault(); pick(list[active]); } }
          else if (e.key === 'Escape') { if (open) { e.stopPropagation(); setOpen(false); } }
        }}
        placeholder={placeholder}
        role="combobox"
        aria-expanded={open}
        className="w-full px-3 py-2 rounded-lg border border-gray-300 bg-white text-sm focus:outline-none focus:ring-2 focus:ring-ooosh-200 focus:border-ooosh-400"
      />
      {open && !disabled && (
        <ul role="listbox"
          className="absolute z-20 mt-1 w-full max-h-64 overflow-y-auto rounded-lg border border-gray-200 bg-white shadow-lg text-sm">
          {tooShort ? (
            <li className="px-3 py-2 text-gray-400">Type {minChars} or more characters</li>
          ) : loading ? (
            <li className="px-3 py-2 text-gray-400">Searching…</li>
          ) : list.length === 0 ? (
            <li className="px-3 py-2 text-gray-400">Nothing matches</li>
          ) : list.map((o, i) => (
            <li key={o.value} role="option" aria-selected={i === active}
              onMouseDown={(e) => { e.preventDefault(); pick(o); }}
              onMouseEnter={() => setActive(i)}
              className={`px-3 py-2 cursor-pointer ${i === active ? 'bg-ooosh-50' : ''}`}>
              <span className="text-gray-900">{o.label}</span>
              {o.hint && <span className="text-gray-400"> · {o.hint}</span>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
