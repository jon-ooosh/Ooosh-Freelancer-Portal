/**
 * Public Out-of-Hours return parking-confirmation page.
 *
 * Token-authenticated (no login). Driver opens the link from their email,
 * the page pre-fills the marker from Traccar, they confirm or drag, submit.
 *
 * Mounted outside the OP staff Layout (no nav shell). Mobile-friendly.
 */
import { useEffect, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import markerIcon2x from 'leaflet/dist/images/marker-icon-2x.png';
import markerIcon from 'leaflet/dist/images/marker-icon.png';
import markerShadow from 'leaflet/dist/images/marker-shadow.png';

// Fix Leaflet's default icon paths with bundlers
delete (L.Icon.Default.prototype as unknown as Record<string, unknown>)._getIconUrl;
L.Icon.Default.mergeOptions({
  iconRetinaUrl: markerIcon2x,
  iconUrl: markerIcon,
  shadowUrl: markerShadow,
});

interface FormContext {
  vehicleReg: string;
  jobNumber: number | null;
  jobName: string | null;
  driverName: string | null;
  alreadySubmitted: boolean;
}

interface PrefillData {
  latitude: number;
  longitude: number;
  fixTime: string;
  ageSeconds: number;
}

const OOOSH_LAT = 50.84;
const OOOSH_LNG = -0.13;

export default function OohReturnParkingPage() {
  const { token } = useParams<{ token: string }>();
  const [ctx, setCtx] = useState<FormContext | null>(null);
  const [loadError, setLoadError] = useState<string>('');
  const [loading, setLoading] = useState(true);
  const [prefill, setPrefill] = useState<PrefillData | null>(null);
  const [coords, setCoords] = useState<{ lat: number; lng: number } | null>(null);
  const [notes, setNotes] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState('');
  const [submitted, setSubmitted] = useState(false);

  const mapRef = useRef<HTMLDivElement>(null);
  const mapInstanceRef = useRef<L.Map | null>(null);
  const markerRef = useRef<L.Marker | null>(null);

  // Load context + Traccar prefill in parallel
  useEffect(() => {
    if (!token) {
      setLoadError('Missing link token');
      setLoading(false);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const [ctxRes, prefillRes] = await Promise.all([
          fetch(`/api/ooh-return/by-token/${token}`),
          fetch(`/api/ooh-return/by-token/${token}/prefill`),
        ]);
        if (!ctxRes.ok) {
          const body = await ctxRes.json().catch(() => ({}));
          if (!cancelled) {
            setLoadError(body.error || 'This link is no longer valid.');
            setLoading(false);
          }
          return;
        }
        const ctxBody = await ctxRes.json();
        const prefillBody = prefillRes.ok ? await prefillRes.json() : { data: null };
        if (cancelled) return;
        setCtx(ctxBody.data);
        const initial: PrefillData | null = prefillBody.data ?? null;
        setPrefill(initial);
        setCoords(initial ? { lat: initial.latitude, lng: initial.longitude } : { lat: OOOSH_LAT, lng: OOOSH_LNG });
      } catch (err) {
        if (!cancelled) setLoadError(err instanceof Error ? err.message : 'Failed to load');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [token]);

  // Initialise Leaflet map once we have coords
  useEffect(() => {
    if (!mapRef.current || mapInstanceRef.current || !coords) return;

    const map = L.map(mapRef.current, {
      zoomControl: true,
      attributionControl: false,
    }).setView([coords.lat, coords.lng], 16);

    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
    }).addTo(map);

    L.control.attribution({ prefix: false, position: 'bottomright' })
      .addAttribution('© OpenStreetMap')
      .addTo(map);

    const marker = L.marker([coords.lat, coords.lng], { draggable: true })
      .addTo(map)
      .bindTooltip('Drag if not accurate', { permanent: false });

    marker.on('dragend', () => {
      const ll = marker.getLatLng();
      setCoords({ lat: ll.lat, lng: ll.lng });
    });

    map.on('click', (e: L.LeafletMouseEvent) => {
      marker.setLatLng(e.latlng);
      setCoords({ lat: e.latlng.lat, lng: e.latlng.lng });
    });

    mapInstanceRef.current = map;
    markerRef.current = marker;

    return () => {
      map.remove();
      mapInstanceRef.current = null;
      markerRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [coords ? '1' : '0']);

  async function handleSubmit() {
    if (!coords || !token) return;
    setSubmitting(true);
    setSubmitError('');
    try {
      const res = await fetch(`/api/ooh-return/by-token/${token}/submit`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          latitude: coords.lat,
          longitude: coords.lng,
          notes: notes.trim() || null,
        }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || `Submit failed: ${res.status}`);
      }
      setSubmitted(true);
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : 'Submit failed');
    } finally {
      setSubmitting(false);
    }
  }

  function ageText(): string {
    if (!prefill) return '';
    const s = prefill.ageSeconds;
    if (s < 60) return 'just now';
    if (s < 3600) return `${Math.round(s / 60)} mins ago`;
    if (s < 86400) return `${Math.round(s / 3600)} hrs ago`;
    return `${Math.round(s / 86400)} days ago`;
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-50 to-slate-100 flex items-start justify-center py-6 px-3">
      <div className="w-full max-w-lg bg-white rounded-2xl shadow-lg overflow-hidden">
        <div className="bg-ooosh-navy px-5 py-4 text-white">
          <h1 className="text-lg font-semibold">Confirm parking location</h1>
          <p className="text-xs text-white/80 mt-0.5">Out-of-hours van return</p>
        </div>

        <div className="px-5 py-5 space-y-4">
          {loading && (
            <p className="text-center text-sm text-gray-500 py-8">Loading…</p>
          )}

          {!loading && loadError && (
            <div className="rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-700">
              <p className="font-medium mb-1">This link is no longer valid</p>
              <p>{loadError}</p>
              <p className="mt-2 text-xs text-red-600">
                If you've already returned the van and the office hasn't checked it in yet, please call us.
              </p>
            </div>
          )}

          {submitted && ctx && (
            <div className="rounded-lg border border-green-200 bg-green-50 p-4 text-sm text-green-800 text-center">
              <p className="font-semibold text-base mb-1">✓ Thanks, {ctx.driverName || 'all done'}!</p>
              <p>We've logged where you parked {ctx.vehicleReg}. Have a safe trip home.</p>
            </div>
          )}

          {!loading && !loadError && !submitted && ctx && (
            <>
              <div className="rounded-lg bg-gray-50 border border-gray-200 p-3 text-sm">
                <div className="flex justify-between items-baseline gap-2">
                  <span className="text-gray-500">Vehicle</span>
                  <span className="font-semibold text-gray-900">{ctx.vehicleReg}</span>
                </div>
                {ctx.jobNumber && (
                  <div className="flex justify-between items-baseline gap-2 mt-1">
                    <span className="text-gray-500">Job</span>
                    <span className="text-gray-700">#{ctx.jobNumber}</span>
                  </div>
                )}
                {ctx.driverName && (
                  <div className="flex justify-between items-baseline gap-2 mt-1">
                    <span className="text-gray-500">Driver</span>
                    <span className="text-gray-700">{ctx.driverName}</span>
                  </div>
                )}
              </div>

              {ctx.alreadySubmitted && (
                <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-xs text-amber-800">
                  You've already submitted a location for this hire. Submitting again will update it.
                </div>
              )}

              <div>
                <p className="text-sm font-medium text-gray-700 mb-1">Where did you park?</p>
                {prefill ? (
                  <p className="text-xs text-gray-500 mb-2">
                    The marker is the van's last GPS position ({ageText()}).
                    {prefill.ageSeconds > 1800 && (
                      <span className="text-amber-700"> If that's not where you actually parked, drag the marker.</span>
                    )}
                  </p>
                ) : (
                  <p className="text-xs text-gray-500 mb-2">
                    Tap or drag the marker to where you parked the van.
                  </p>
                )}
                <div
                  ref={mapRef}
                  className="rounded-lg overflow-hidden border border-gray-200"
                  style={{ height: 280 }}
                />
                {coords && (
                  <p className="text-[11px] text-gray-400 mt-1 font-mono text-right">
                    {coords.lat.toFixed(5)}, {coords.lng.toFixed(5)}
                  </p>
                )}
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Anything else we should know? (optional)
                </label>
                <textarea
                  value={notes}
                  onChange={e => setNotes(e.target.value)}
                  rows={3}
                  maxLength={2000}
                  placeholder="e.g. parked behind the blue van on the seafront, keys in the drop"
                  className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-ooosh-navy focus:outline-none focus:ring-1 focus:ring-ooosh-navy"
                />
              </div>

              {submitError && (
                <div className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">
                  {submitError}
                </div>
              )}

              <button
                type="button"
                onClick={handleSubmit}
                disabled={submitting || !coords}
                className="w-full px-4 py-3 bg-ooosh-navy text-white text-sm font-semibold rounded-lg hover:opacity-90 disabled:opacity-50"
              >
                {submitting ? 'Submitting…' : 'Confirm parking location'}
              </button>

              <p className="text-[11px] text-gray-400 text-center">
                You remain responsible for the vehicle until we open and check it in.
              </p>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
