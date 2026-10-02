/**
 * Server-side Traccar lookup. Used by routes that can't go through the
 * staff-auth /api/vehicles/traccar proxy (e.g. the public OOH parking form).
 */

const TRACCAR_URL = process.env.TRACCAR_URL || 'https://tracking.oooshtours.co.uk';
const TRACCAR_EMAIL = process.env.TRACCAR_EMAIL || '';
const TRACCAR_PASSWORD = process.env.TRACCAR_PASSWORD || '';

interface TraccarDeviceRow {
  id: number;
  name: string;
  status?: string;
  lastUpdate?: string;
}

interface TraccarPositionRow {
  deviceId: number;
  latitude: number;
  longitude: number;
  fixTime: string;
  serverTime: string;
  /** Knots (Traccar's unit). */
  speed?: number;
  course?: number;
  address?: string | null;
}

let deviceCache: { rows: TraccarDeviceRow[]; expiresAt: number } | null = null;
const DEVICE_CACHE_MS = 5 * 60_000;

async function traccarFetch<T>(endpoint: string, params?: Record<string, string>): Promise<T> {
  if (!TRACCAR_EMAIL || !TRACCAR_PASSWORD) {
    throw new Error('Traccar not configured');
  }
  const url = new URL(`/api${endpoint}`, TRACCAR_URL);
  if (params) {
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  }
  const auth = 'Basic ' + Buffer.from(`${TRACCAR_EMAIL}:${TRACCAR_PASSWORD}`).toString('base64');
  const res = await fetch(url.toString(), {
    headers: { Authorization: auth, Accept: 'application/json' },
  });
  if (!res.ok) {
    throw new Error(`Traccar API error: ${res.status}`);
  }
  return res.json() as Promise<T>;
}

function normaliseReg(s: string): string {
  return s.replace(/\s+/g, '').toUpperCase();
}

/** The Traccar device named after this registration (devices are named by reg). */
async function findDeviceForReg(reg: string): Promise<TraccarDeviceRow | null> {
  const now = Date.now();
  if (!deviceCache || deviceCache.expiresAt < now) {
    const rows = await traccarFetch<TraccarDeviceRow[]>('/devices');
    deviceCache = { rows, expiresAt: now + DEVICE_CACHE_MS };
  }
  const target = normaliseReg(reg);
  return deviceCache.rows.find(d => normaliseReg(d.name || '') === target) || null;
}

export interface RoutePoint {
  /** ISO fix time (UTC). */
  time: string;
  lat: number;
  lng: number;
  speedKph: number;
  course: number | null;
  address: string | null;
}

/**
 * A van's recorded positions between two times (docs/INCIDENT-CLAIMS-SPEC.md §14).
 * null = Traccar isn't configured or has no device for this reg; [] = the
 * device exists but has no positions then (not moving, or already purged).
 * Throws on a Traccar error so the caller can tell "nothing" from "failed".
 */
export async function getRouteForReg(reg: string, from: Date, to: Date): Promise<RoutePoint[] | null> {
  if (!TRACCAR_EMAIL || !TRACCAR_PASSWORD) return null;
  const device = await findDeviceForReg(reg);
  if (!device) return null;
  const rows = await traccarFetch<TraccarPositionRow[]>('/positions', {
    deviceId: String(device.id),
    from: from.toISOString(),
    to: to.toISOString(),
  });
  return rows
    .filter((p) => Number.isFinite(p.latitude) && Number.isFinite(p.longitude))
    .map((p) => ({
      time: p.fixTime,
      lat: p.latitude,
      lng: p.longitude,
      speedKph: Math.round((p.speed || 0) * 1.852 * 10) / 10,
      course: typeof p.course === 'number' ? p.course : null,
      address: p.address || null,
    }))
    .sort((a, b) => a.time.localeCompare(b.time));
}

/**
 * Look up the latest Traccar position for a vehicle by registration. Returns
 * null if no device exists or no position is available.
 */
export async function getLatestPositionForReg(reg: string): Promise<{
  latitude: number;
  longitude: number;
  fixTime: string;
  ageSeconds: number;
} | null> {
  try {
    if (!TRACCAR_EMAIL || !TRACCAR_PASSWORD) return null;

    const device = await findDeviceForReg(reg);
    if (!device) return null;

    const positions = await traccarFetch<TraccarPositionRow[]>('/positions', {
      deviceId: String(device.id),
    });
    const pos = positions[0];
    if (!pos) return null;

    const fixTimeMs = new Date(pos.fixTime).getTime();
    const ageSeconds = Math.max(0, Math.round((Date.now() - fixTimeMs) / 1000));

    return {
      latitude: pos.latitude,
      longitude: pos.longitude,
      fixTime: pos.fixTime,
      ageSeconds,
    };
  } catch (err) {
    console.warn(`[traccar-server] position lookup failed for ${reg}:`, err);
    return null;
  }
}
