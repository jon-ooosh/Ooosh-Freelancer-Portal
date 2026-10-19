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
 * Shared venue picker: search the OP venues database, link by id, create a new
 * venue record inline, or fall back to a free-text name. Used by the Edit Quote
 * modal (Job Detail + Transport Ops) and the Local Delivery / Collection form
 * so a single pattern maintains venue linkage end-to-end.
 *
 * When the user types, we clear any existing venueId (they're overriding the
 * link). Selecting from the dropdown sets both id + name. Typing the same name
 * back without selecting leaves it unlinked (free-text).
 *
 * ── Why free text is still allowed, and why it's now flagged ──────────────
 * A quote with `venue_name` set and `venue_id` NULL is an orphan: the
 * freelancer portal reads the address off `venues v ON v.id = q.venue_id`
 * (routes/portal.ts), so an unlinked venue means the driver gets a NAME WITH
 * NO ADDRESS — no postcode, no parking or load-in notes. 97 of 675 quotes were
 * in that state in Sep 2026.
 *
 * The fix is deliberately NOT to auto-create a venue from whatever was typed.
 * Plenty of these genuinely aren't venues ("client's house", "our warehouse",
 * "TBC", a bare postcode), and a record minted from a typo or a part-name
 * ("Brixton") pollutes the table permanently and makes every later search
 * worse — the opposite of the intent. A venue created from a name alone has no
 * address either, which is the only thing that made linking worth doing.
 *
 * So: free text stays possible, linking is the path of least resistance
 * (one click when there's no match), and an unlinked value renders an amber
 * warning naming the actual consequence.
 */
export function VenuePicker({
  value,
  onChange,
  placeholder = 'Search venues…',
  autoFocus,
  allowCreate = true,
}: {
  value: VenuePickerValue;
  onChange: (v: VenuePickerValue) => void;
  placeholder?: string;
  autoFocus?: boolean;
  /** Set false to hide the inline "create venue" affordance (search + free text only). */
  allowCreate?: boolean;
}) {
  const [options, setOptions] = useState<VenueOption[]>([]);
  const [open, setOpen] = useState(false);
  const [searched, setSearched] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  // Inline create form. `draft` holds the minimal set worth capturing at this
  // moment — name plus the address fields the freelancer portal actually needs.
  // Everything else on a venue (parking, load-in, technical notes) is added
  // later on the venue page; asking for it here would make the quick path slow
  // enough that people go back to free text.
  const [creating, setCreating] = useState(false);
  const [draft, setDraft] = useState({ name: '', address: '', city: '', postcode: '' });
  const [saving, setSaving] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  async function search(term: string) {
    if (term.trim().length < 2) {
      setOptions([]);
      setSearched(false);
      return;
    }
    try {
      const data = await api.get<{ data: VenueOption[] }>(
        `/venues?search=${encodeURIComponent(term)}&limit=8`
      );
      setOptions(data.data);
      setSearched(true);
    } catch {
      // Swallow errors — free-text fallback remains usable.
      setSearched(false);
    }
  }

  // Close dropdown on outside click. The create form is deliberately NOT
  // dismissed this way — half-typed address fields shouldn't vanish because
  // someone clicked the modal background.
  useEffect(() => {
    if (!open) return;
    function handler(e: MouseEvent) {
      if (!containerRef.current?.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  function startCreate() {
    setDraft({ name: value.venueName.trim(), address: '', city: '', postcode: '' });
    setCreateError(null);
    setCreating(true);
    setOpen(false);
  }

  async function saveNewVenue() {
    const name = draft.name.trim();
    if (!name) {
      setCreateError('A name is required.');
      return;
    }
    setSaving(true);
    setCreateError(null);
    try {
      // POST /api/venues returns the created row directly (not wrapped in
      // `{ data }` — this endpoint predates that convention).
      const created = await api.post<{ id: string; name: string }>('/venues', {
        name,
        address: draft.address.trim() || null,
        city: draft.city.trim() || null,
        postcode: draft.postcode.trim() || null,
      });
      onChange({ venueId: created.id, venueName: created.name });
      setCreating(false);
      setOptions([]);
      setSearched(false);
    } catch (err) {
      setCreateError(err instanceof Error ? err.message : 'Could not create the venue.');
    } finally {
      setSaving(false);
    }
  }

  const typed = value.venueName.trim();
  // Offer creation only once a search has actually come back with nothing that
  // matches what was typed. Showing it while results are still loading invites
  // a duplicate of a venue that was about to appear.
  const exactMatch = options.some((o) => o.name.trim().toLowerCase() === typed.toLowerCase());
  const canOfferCreate = allowCreate && searched && typed.length >= 2 && !exactMatch;

  if (creating) {
    return (
      <div className="border border-ooosh-200 bg-ooosh-50/50 rounded-lg p-3 space-y-2">
        <p className="text-xs font-medium text-gray-700">New venue</p>
        <input
          type="text"
          value={draft.name}
          autoFocus
          onChange={(e) => setDraft({ ...draft, name: e.target.value })}
          className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm"
          placeholder="Venue name"
        />
        <input
          type="text"
          value={draft.address}
          onChange={(e) => setDraft({ ...draft, address: e.target.value })}
          className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm"
          placeholder="Address"
        />
        <div className="grid grid-cols-2 gap-2">
          <input
            type="text"
            value={draft.city}
            onChange={(e) => setDraft({ ...draft, city: e.target.value })}
            className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm"
            placeholder="City"
          />
          <input
            type="text"
            value={draft.postcode}
            onChange={(e) => setDraft({ ...draft, postcode: e.target.value })}
            className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm"
            placeholder="Postcode"
          />
        </div>
        <p className="text-xs text-gray-500">
          The address is what reaches the freelancer. Parking, load-in and access notes can be
          added on the venue page later.
        </p>
        {createError && <p className="text-xs text-red-600">{createError}</p>}
        <div className="flex gap-2">
          <button
            type="button"
            onClick={saveNewVenue}
            disabled={saving}
            className="px-3 py-1.5 rounded-lg bg-ooosh-600 text-white text-sm font-medium disabled:opacity-50"
          >
            {saving ? 'Creating…' : 'Create & link'}
          </button>
          <button
            type="button"
            onClick={() => { setCreating(false); setCreateError(null); }}
            disabled={saving}
            className="px-3 py-1.5 rounded-lg border border-gray-300 text-gray-600 text-sm"
          >
            Cancel
          </button>
        </div>
      </div>
    );
  }

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
          setSearched(false);
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
      {value.venueId ? (
        <p className="text-xs text-green-600 mt-1">✓ Linked to venue record</p>
      ) : (
        typed.length > 0 && (
          <p className="text-xs text-amber-600 mt-1">
            ⚠ Not linked to a venue record — the freelancer won't see an address
          </p>
        )
      )}
      {open && (options.length > 0 || canOfferCreate) && (
        <div className="absolute z-20 mt-1 w-full bg-white border border-gray-200 rounded-lg shadow-lg max-h-48 overflow-y-auto">
          {options.map((v) => (
            <button
              key={v.id}
              type="button"
              onClick={() => {
                onChange({ venueId: v.id, venueName: v.name });
                setOptions([]);
                setSearched(false);
                setOpen(false);
              }}
              className="w-full text-left px-3 py-2 text-sm hover:bg-ooosh-50 flex justify-between items-center"
            >
              <span className="font-medium text-gray-900">{v.name}</span>
              {v.city && <span className="text-xs text-gray-400 ml-2">{v.city}</span>}
            </button>
          ))}
          {canOfferCreate && (
            <button
              type="button"
              onClick={startCreate}
              className="w-full text-left px-3 py-2 text-sm text-ooosh-700 hover:bg-ooosh-50 border-t border-gray-100 font-medium"
            >
              ＋ Create venue "{typed}"
            </button>
          )}
        </div>
      )}
    </div>
  );
}
