import { useEffect, useRef, useState } from 'react';
import { api } from '../services/api';

export interface VenuePickerValue {
  venueId: string | null;
  venueName: string;
}

interface VenueOption {
  id: string;
  name: string;
  address?: string | null;
  city?: string | null;
}

/**
 * Shared venue picker: search the OP venues database, link by id, or fall
 * back to a free-text name. Used by the Edit Quote modal on both Job Detail
 * and Transport Ops so a single pattern maintains venue linkage end-to-end.
 *
 * When the user types, we clear any existing venueId (they're overriding
 * the link). Selecting from the dropdown sets both id + name. Typing the
 * same name back without selecting leaves it unlinked (free-text).
 */
export function VenuePicker({
  value,
  onChange,
  placeholder = 'Search venues…',
  autoFocus,
}: {
  value: VenuePickerValue;
  onChange: (v: VenuePickerValue) => void;
  placeholder?: string;
  autoFocus?: boolean;
}) {
  const [options, setOptions] = useState<VenueOption[]>([]);
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  async function search(term: string) {
    if (term.trim().length < 2) {
      setOptions([]);
      return;
    }
    try {
      const data = await api.get<{ data: VenueOption[] }>(
        `/venues?search=${encodeURIComponent(term)}&limit=8`
      );
      setOptions(data.data);
    } catch {
      // Swallow errors — free-text fallback remains usable.
    }
  }

  // Close dropdown on outside click.
  useEffect(() => {
    if (!open) return;
    function handler(e: MouseEvent) {
      if (!containerRef.current?.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  return (
    <div className="relative" ref={containerRef}>
      <input
        type="text"
        value={value.venueName}
        autoFocus={autoFocus}
        onChange={(e) => {
          const name = e.target.value;
          // Typing overrides any existing link.
          onChange({ venueId: null, venueName: name });
          search(name);
          setOpen(true);
        }}
        onFocus={() => {
          if (value.venueName.length >= 2) {
            search(value.venueName);
            setOpen(true);
          }
        }}
        className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm"
        placeholder={placeholder}
      />
      {value.venueId && (
        <p className="text-xs text-green-600 mt-1">✓ Linked to venue record</p>
      )}
      {open && options.length > 0 && (
        <div className="absolute z-20 mt-1 w-full bg-white border border-gray-200 rounded-lg shadow-lg max-h-48 overflow-y-auto">
          {options.map((v) => (
            <button
              key={v.id}
              type="button"
              onClick={() => {
                onChange({ venueId: v.id, venueName: v.name });
                setOptions([]);
                setOpen(false);
              }}
              className="w-full text-left px-3 py-2 text-sm hover:bg-ooosh-50 flex justify-between items-center"
            >
              <span className="font-medium text-gray-900">{v.name}</span>
              {v.city && <span className="text-xs text-gray-400 ml-2">{v.city}</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
