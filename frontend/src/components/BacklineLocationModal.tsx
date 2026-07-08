/**
 * BacklineLocationModal — "Where is it?" capture for prepped backline.
 *
 * Records where the physical kit currently sits: loaded into a van (+reg),
 * loading bay, rehearsal room, or other (free text). Freely editable — kit
 * moves from bay to van as the hire approaches. Used from both the Backline
 * operations page and the Job Detail backline requirement card.
 */

import { useEffect, useRef, useState } from 'react';
import { api } from '../services/api';

export interface BacklineLocation {
  type: 'van' | 'loading_bay' | 'rehearsal' | 'other';
  reg: string | null;
  detail: string | null;
}

const TYPE_OPTIONS: { value: BacklineLocation['type']; label: string; icon: string }[] = [
  { value: 'van', label: 'Loaded into van', icon: '🚐' },
  { value: 'loading_bay', label: 'Loading bay', icon: '📦' },
  { value: 'rehearsal', label: 'Rehearsal room', icon: '🎸' },
  { value: 'other', label: 'Other', icon: '📍' },
];

export function backlineLocationIcon(loc: BacklineLocation): string {
  return TYPE_OPTIONS.find(o => o.value === loc.type)?.icon || '📍';
}

export function backlineLocationLabel(loc: BacklineLocation): string {
  switch (loc.type) {
    case 'van': return loc.reg ? `In ${loc.reg}` : 'Loaded in a van';
    case 'loading_bay': return loc.detail ? `Loading bay — ${loc.detail}` : 'Loading bay';
    case 'rehearsal': return loc.detail ? `Rehearsal room — ${loc.detail}` : 'Rehearsal room';
    case 'other': return loc.detail || 'Other location';
    default: return 'Location set';
  }
}

interface LocationContext {
  location: BacklineLocation | null;
  allocatedRegs: string[];
  fleetRegs: string[];
}

export default function BacklineLocationModal({
  requirementId,
  initialLocation,
  onClose,
  onSaved,
}: {
  requirementId: string;
  initialLocation?: BacklineLocation | null;
  onClose: () => void;
  onSaved: (loc: BacklineLocation | null) => void;
}) {
  const [ctx, setCtx] = useState<LocationContext | null>(null);
  const [type, setType] = useState<BacklineLocation['type']>(initialLocation?.type || 'van');
  const [reg, setReg] = useState(initialLocation?.reg || '');
  const [detail, setDetail] = useState(initialLocation?.detail || '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const prefilledRef = useRef(false);

  // Load allocated vans + fleet suggestions + current server-side location.
  useEffect(() => {
    api.get<{ data: LocationContext }>(`/backline/location-context/${requirementId}`)
      .then(d => {
        setCtx(d.data);
        // If we weren't handed an initial location, adopt the server's.
        if (!initialLocation && d.data.location) {
          setType(d.data.location.type);
          setReg(d.data.location.reg || '');
          setDetail(d.data.location.detail || '');
        }
      })
      .catch(() => setCtx({ location: null, allocatedRegs: [], fleetRegs: [] }));
  }, [requirementId, initialLocation]);

  // When "van" is picked and there's exactly the allocated van(s) known and no
  // reg typed yet, prefill the first allocated reg (once).
  useEffect(() => {
    if (type === 'van' && !reg && !prefilledRef.current && ctx && ctx.allocatedRegs.length > 0) {
      setReg(ctx.allocatedRegs[0]);
      prefilledRef.current = true;
    }
  }, [type, reg, ctx]);

  // Escape closes
  useEffect(() => {
    function onKey(e: KeyboardEvent) { if (e.key === 'Escape') onClose(); }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  async function save() {
    setSaving(true);
    setError(null);
    try {
      const body = {
        location_type: type,
        vehicle_reg: type === 'van' ? reg.trim() : null,
        detail: type === 'van' ? null : detail.trim() || null,
      };
      const d = await api.put<{ data: BacklineLocation }>(`/backline/location/${requirementId}`, body);
      onSaved(d.data);
      onClose();
    } catch (e: any) {
      setError(e?.message || 'Failed to save location');
    } finally {
      setSaving(false);
    }
  }

  async function clear() {
    setSaving(true);
    setError(null);
    try {
      await api.delete(`/backline/location/${requirementId}`);
      onSaved(null);
      onClose();
    } catch (e: any) {
      setError(e?.message || 'Failed to clear location');
    } finally {
      setSaving(false);
    }
  }

  const regSuggestions = ctx
    ? [...ctx.allocatedRegs, ...ctx.fleetRegs.filter(r => !ctx.allocatedRegs.includes(r))]
    : [];

  return (
    <div
      className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4"
      onClick={onClose}
    >
      <div
        className="bg-white rounded-xl shadow-xl w-full max-w-md p-5"
        onClick={e => e.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-base font-semibold text-gray-900">Where is the backline?</h3>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600">
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Type picker */}
        <div className="grid grid-cols-2 gap-2 mb-4">
          {TYPE_OPTIONS.map(opt => (
            <button
              key={opt.value}
              onClick={() => setType(opt.value)}
              className={`flex items-center gap-2 px-3 py-2.5 rounded-lg border text-sm font-medium transition-colors ${
                type === opt.value
                  ? 'border-ooosh-500 bg-ooosh-50 text-ooosh-700'
                  : 'border-gray-200 text-gray-600 hover:bg-gray-50'
              }`}
            >
              <span>{opt.icon}</span>
              {opt.label}
            </button>
          ))}
        </div>

        {/* Van reg */}
        {type === 'van' && (
          <div className="mb-4">
            <label className="block text-xs font-medium text-gray-500 mb-1">
              Vehicle reg {ctx && ctx.allocatedRegs.length > 0 && <span className="text-ooosh-600">(prefilled from allocation)</span>}
            </label>
            <input
              type="text"
              value={reg}
              onChange={e => setReg(e.target.value.toUpperCase())}
              list="backline-reg-suggestions"
              placeholder="e.g. RX22SWN"
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:border-ooosh-500 focus:outline-none focus:ring-1 focus:ring-ooosh-500"
            />
            <datalist id="backline-reg-suggestions">
              {regSuggestions.map(r => <option key={r} value={r} />)}
            </datalist>
            {ctx && ctx.allocatedRegs.length > 1 && (
              <p className="text-[11px] text-gray-400 mt-1">
                Allocated to this job: {ctx.allocatedRegs.join(', ')}
              </p>
            )}
          </div>
        )}

        {/* Optional detail for non-van types */}
        {type !== 'van' && (
          <div className="mb-4">
            <label className="block text-xs font-medium text-gray-500 mb-1">
              {type === 'other' ? 'Where is it?' : 'Notes (optional)'}
            </label>
            <input
              type="text"
              value={detail}
              onChange={e => setDetail(e.target.value)}
              placeholder={type === 'other' ? 'Free text…' : 'Optional detail'}
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:border-ooosh-500 focus:outline-none focus:ring-1 focus:ring-ooosh-500"
            />
          </div>
        )}

        {error && <p className="text-xs text-red-600 mb-3">{error}</p>}

        <div className="flex items-center justify-between gap-2">
          <button
            onClick={clear}
            disabled={saving}
            className="text-xs text-gray-500 hover:text-red-600 disabled:opacity-50"
          >
            Clear location
          </button>
          <div className="flex gap-2">
            <button
              onClick={onClose}
              disabled={saving}
              className="px-3 py-1.5 text-sm text-gray-600 hover:text-gray-900 disabled:opacity-50"
            >
              Cancel
            </button>
            <button
              onClick={save}
              disabled={saving}
              className="px-4 py-1.5 text-sm font-medium bg-ooosh-600 text-white rounded-lg hover:bg-ooosh-700 disabled:opacity-50"
            >
              {saving ? 'Saving…' : 'Save'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
