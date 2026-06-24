/**
 * Vehicle forecast — deterministic, forward-looking health picture for the
 * Vehicle > Forecast tab. Assembled server-side from existing data so it can
 * be both rendered (frontend) AND narrated (the AI assessment) from ONE source
 * of truth — no drift between what staff see and what Claude reasons over.
 *
 * Pure arithmetic + queries, no AI here (that's vehicle-forecast-ai.ts). Sources:
 *   - prep sessions (R2)        → tyres (per-corner wear + projection) + fluids
 *   - vehicle_mileage_log       → mileage pace (miles/day, projected annual)
 *   - fleet_vehicles            → compliance dates + service-due mileage
 *   - vehicle_service_log       → cost trajectory + recurring-work signals
 *   - vehicle_fuel_log          → fuel spend + cost/mile
 *   - job_issues                → recurring-issue counts (by component)
 *
 * Projections are straight-line and deliberately conservative — to 5mm (plan)
 * and 4mm (replace), never the 1.6mm legal limit. Front and rear tyres are
 * computed independently from their own readings.
 */

import { query } from '../config/database';
import { getFromR2, isR2Configured } from '../config/r2';

// Tyre thresholds — mirror frontend lib/tyre-sanity.ts. Single source would be
// nice but the frontend can't import from backend; keep these in step.
const TYRE_CAP_MM = 10;
const TYRE_RED_MM = 4; // replace now
const TYRE_AMBER_MM = 5; // plan replacement
const TREAD_RESET_JUMP_MM = 1.5; // jump UP = new/swapped tyre

type Corner = 'FL' | 'FR' | 'RL' | 'RR';
const CORNERS: Corner[] = ['FL', 'FR', 'RL', 'RR'];
const CORNER_LABEL: Record<Corner, string> = {
  FL: 'Front left', FR: 'Front right', RL: 'Rear left', RR: 'Rear right',
};
const CORNER_TREAD_NAMES: Record<Corner, string[]> = {
  FL: ['front left tyre tread', 'fl tread'],
  FR: ['front right tyre tread', 'fr tread'],
  RL: ['rear left tyre tread', 'rl tread'],
  RR: ['rear right tyre tread', 'rr tread'],
};

const FLUID_DEFS = [
  { key: 'oil', label: 'Oil', match: ['oil level', 'oil'] },
  { key: 'coolant', label: 'Coolant / water', match: ['water level', 'coolant', 'water'] },
  { key: 'screenwash', label: 'Screen wash', match: ['screen wash', 'screenwash', 'washer'] },
  { key: 'adblue', label: 'AdBlue', match: ['ad blue', 'adblue'] },
];

interface PrepItem { name: string; value?: string; detail?: string; unit?: string }
interface PrepSection { name: string; items?: PrepItem[]; notes?: string }
export interface PrepSessionDoc {
  vehicleReg?: string;
  preparedBy?: string;
  mileage?: number | null;
  date: string;
  overallStatus?: string;
  sections?: PrepSection[];
  eventId?: string;
}

export interface CornerForecast {
  corner: Corner;
  axle: 'front' | 'rear';
  label: string;
  currentTread: number | null;
  wearRatePer1000: number | null;
  status: 'red' | 'amber' | 'green' | 'unknown';
  milesTo5mm: number | null;
  milesTo4mm: number | null;
  resetCount: number;
}

export interface VehicleForecast {
  vehicle: { id: string; reg: string; currentMileage: number | null; simpleType: string | null; ulezCompliant: boolean | null };
  mileage: { perDay: number | null; perWeek: number | null; annualProjected: number | null; readings: number };
  service: {
    nextDueMileage: number | null;
    milesUntil: number | null;
    etaWeeks: number | null;
    status: 'ok' | 'soon' | 'due' | 'unknown';
    lastServiceMileage: number | null;
    lastServiceDate: string | null;
  };
  compliance: Array<{ kind: string; due: string | null; days: number | null; status: 'ok' | 'soon' | 'overdue' | 'unknown' }>;
  fluids: Array<{ key: string; label: string; topUps: number; preps: number; milesBetween: number | null; status: 'ok' | 'watch' }>;
  tyres: { corners: CornerForecast[]; prepsWithTread: number };
  costs: {
    last12mTotal: number;
    perMile: number | null;
    serviceTotal: number;
    fuelTotal: number;
    recent: Array<{ date: string | null; type: string; name: string; cost: number | null; garage: string | null }>;
  };
  recurringIssues: Array<{ label: string; count: number; lastDate: string | null }>;
  prepSessions: PrepSessionDoc[];
  /** Compact unstructured text harvested for the AI narrator. */
  notesForAi: string[];
}

async function readR2Json<T>(key: string): Promise<T | null> {
  try {
    const resp = await getFromR2(key);
    if (!resp.Body) return null;
    const text = await resp.Body.transformToString('utf-8');
    return JSON.parse(text) as T;
  } catch (err: unknown) {
    if ((err as { name?: string })?.name === 'NoSuchKey') return null;
    throw err;
  }
}

function normaliseTread(v: number): number {
  return v > TYRE_CAP_MM ? v / 10 : v;
}
function parseTread(raw?: string | null): number | null {
  if (raw == null) return null;
  const n = Number(String(raw).replace(/[^0-9.]/g, ''));
  if (!Number.isFinite(n) || n <= 0) return null;
  return normaliseTread(n);
}

function readCornerTread(s: PrepSessionDoc, corner: Corner): number | null {
  for (const sec of s.sections || []) {
    for (const item of sec.items || []) {
      const n = item.name.toLowerCase();
      if (CORNER_TREAD_NAMES[corner].some((w) => n.includes(w))) {
        return parseTread(item.value || item.detail);
      }
    }
  }
  return null;
}

/** Least-squares slope of tread vs mileage → mm lost per mile (positive = wearing). */
function wearRatePerMile(points: { mileage: number; tread: number }[]): number | null {
  const usable = points.filter((p) => Number.isFinite(p.mileage));
  if (usable.length < 2) return null;
  const n = usable.length;
  let sx = 0, sy = 0, sxx = 0, sxy = 0;
  for (const p of usable) { sx += p.mileage; sy += p.tread; sxx += p.mileage * p.mileage; sxy += p.mileage * p.tread; }
  const denom = n * sxx - sx * sx;
  if (denom === 0) return null;
  const loss = -((n * sxy - sx * sy) / denom);
  return loss > 0 ? loss : null;
}

function computeCorner(corner: Corner, ordered: PrepSessionDoc[]): CornerForecast {
  const pts: { mileage: number; tread: number; date: string }[] = [];
  for (const s of ordered) {
    const tread = readCornerTread(s, corner);
    if (tread == null) continue;
    pts.push({ mileage: Number(s.mileage), tread, date: s.date });
  }
  // Detect tyre changes (tread jumps up) → reset wear baseline.
  let resetCount = 0;
  let segStart = 0;
  for (let i = 1; i < pts.length; i++) {
    if (pts[i].tread - pts[i - 1].tread > TREAD_RESET_JUMP_MM) { resetCount++; segStart = i; }
  }
  const segment = pts.slice(segStart);
  const latest = pts.length ? pts[pts.length - 1] : null;
  const currentTread = latest?.tread ?? null;
  const rate = wearRatePerMile(segment.map((p) => ({ mileage: p.mileage, tread: p.tread })));
  const milesTo = (threshold: number): number | null => {
    if (currentTread == null || rate == null || rate <= 0 || currentTread <= threshold) return null;
    return Math.round((currentTread - threshold) / rate);
  };
  let status: CornerForecast['status'] = 'unknown';
  if (currentTread != null) status = currentTread <= TYRE_RED_MM ? 'red' : currentTread <= TYRE_AMBER_MM ? 'amber' : 'green';
  return {
    corner,
    axle: corner.startsWith('F') ? 'front' : 'rear',
    label: CORNER_LABEL[corner],
    currentTread,
    wearRatePer1000: rate == null ? null : Math.round(rate * 1000 * 100) / 100,
    status,
    milesTo5mm: milesTo(TYRE_AMBER_MM),
    milesTo4mm: milesTo(TYRE_RED_MM),
    resetCount,
  };
}

/** Is a fluid item value a "topped up" answer? */
function isToppedUp(value?: string): boolean {
  if (!value) return false;
  const v = value.toLowerCase();
  return v.includes('top') && !v.includes('not'); // "topped up" / "top up", guard "no top up"
}

function daysUntil(dateStr: string | null): number | null {
  if (!dateStr) return null;
  const d = new Date(dateStr);
  if (Number.isNaN(d.getTime())) return null;
  return Math.round((d.getTime() - Date.now()) / 86400000);
}

/** Safe yyyy-mm-dd — returns null for null/invalid dates instead of throwing. */
function isoDate(value: unknown): string | null {
  if (value == null || value === '') return null;
  const d = new Date(value as string);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 10);
}

export async function buildVehicleForecast(vehicleId: string): Promise<VehicleForecast | null> {
  const vRes = await query(
    `SELECT id, reg, simple_type, current_mileage, mot_due, tax_due, tfl_due, ulez_compliant,
            next_service_due, last_service_mileage, last_service_date
       FROM fleet_vehicles WHERE id = $1`,
    [vehicleId],
  );
  if (vRes.rows.length === 0) return null;
  const v = vRes.rows[0];
  const reg: string = v.reg;
  const currentMileage: number | null = v.current_mileage ?? null;

  // ── Prep sessions (R2) — hydrate the most recent ~20 for tyres + fluids ──
  const ordered: PrepSessionDoc[] = [];
  if (isR2Configured()) {
    try {
      const idx = await readR2Json<{ sessions: Array<{ eventId: string; date?: string; completedAt?: string; startedAt?: string }> }>(
        `prep-sessions/${reg.toUpperCase()}/_index.json`,
      );
      if (idx && Array.isArray(idx.sessions)) {
        const sorted = [...idx.sessions].sort((a, b) => {
          const at = a.completedAt || a.startedAt || a.date || '';
          const bt = b.completedAt || b.startedAt || b.date || '';
          return at.localeCompare(bt); // oldest first for wear regression
        });
        const recent = sorted.slice(-20);
        for (const e of recent) {
          const full = await readR2Json<PrepSessionDoc>(`prep-sessions/${reg.toUpperCase()}/${e.eventId}.json`);
          if (full) ordered.push({ ...full, eventId: e.eventId });
        }
      }
    } catch (err) {
      console.warn('[vehicle-forecast] prep read failed:', err);
    }
  }

  // ── Tyres ──
  const corners = CORNERS.map((c) => computeCorner(c, ordered));
  const prepsWithTread = ordered.filter((s) => CORNERS.some((c) => readCornerTread(s, c) != null)).length;

  // ── Fluids — top-up frequency + miles-between ──
  const fluids = FLUID_DEFS.map((def) => {
    const topUpMileages: number[] = [];
    let preps = 0;
    for (const s of ordered) {
      let present = false;
      let topped = false;
      for (const sec of s.sections || []) {
        for (const item of sec.items || []) {
          const n = item.name.toLowerCase();
          if (def.match.some((m) => n.includes(m))) {
            present = true;
            if (isToppedUp(item.value)) topped = true;
          }
        }
      }
      if (present) preps++;
      if (topped && Number.isFinite(Number(s.mileage))) topUpMileages.push(Number(s.mileage));
    }
    let milesBetween: number | null = null;
    if (topUpMileages.length >= 2) {
      const span = topUpMileages[topUpMileages.length - 1] - topUpMileages[0];
      if (span > 0) milesBetween = Math.round(span / (topUpMileages.length - 1));
    }
    // "watch" when topped up in a majority of recent preps (a van drinking fluid).
    const status: 'ok' | 'watch' = preps >= 3 && topUpMileages.length >= Math.ceil(preps * 0.6) ? 'watch' : 'ok';
    return { key: def.key, label: def.label, topUps: topUpMileages.length, preps, milesBetween, status };
  });

  // ── Mileage pace ──
  const mRes = await query(
    `SELECT mileage, recorded_at FROM vehicle_mileage_log
      WHERE vehicle_id = $1 AND mileage > 0 ORDER BY recorded_at ASC`,
    [vehicleId],
  );
  let perDay: number | null = null;
  const mrows = mRes.rows;
  if (mrows.length >= 2) {
    const first = mrows[0];
    const last = mrows[mrows.length - 1];
    const days = (new Date(last.recorded_at).getTime() - new Date(first.recorded_at).getTime()) / 86400000;
    const miles = Number(last.mileage) - Number(first.mileage);
    if (days > 0 && miles > 0) perDay = miles / days;
  }
  const perWeek = perDay == null ? null : Math.round(perDay * 7);
  const annualProjected = perDay == null ? null : Math.round(perDay * 365);

  // ── Service due projection ──
  const nextDueMileage: number | null = v.next_service_due ?? null;
  const milesUntil = nextDueMileage != null && currentMileage != null ? nextDueMileage - currentMileage : null;
  const etaWeeks = milesUntil != null && perDay != null && perDay > 0 ? Math.round(milesUntil / perDay / 7) : null;
  let serviceStatus: 'ok' | 'soon' | 'due' | 'unknown' = 'unknown';
  if (milesUntil != null) serviceStatus = milesUntil <= 0 ? 'due' : milesUntil <= 1500 ? 'soon' : 'ok';

  // ── Compliance runway ──
  // Insurance is a blanket fleet policy (no per-van date) so it's deliberately
  // NOT tracked here. Only surface items that actually have a date — a van with
  // no TFL date (e.g. a 6-seater that can't register for the discount) simply
  // doesn't appear, rather than nagging as "unknown / unmanageable".
  const compliance = [
    { kind: 'MOT', due: v.mot_due },
    { kind: 'Tax', due: v.tax_due },
    { kind: 'TFL', due: v.tfl_due },
  ]
    .map((c) => {
      const due = isoDate(c.due);
      const days = daysUntil(due);
      let status: 'ok' | 'soon' | 'overdue' | 'unknown' = 'unknown';
      if (days != null) status = days < 0 ? 'overdue' : days <= 30 ? 'soon' : 'ok';
      return { kind: c.kind, due, days, status };
    })
    .filter((c) => c.due != null);

  // ── Cost trajectory (last 12 months) ──
  const sRes = await query(
    `SELECT service_date, service_type, name, cost, garage
       FROM vehicle_service_log
      WHERE vehicle_id = $1 AND service_date >= (CURRENT_DATE - INTERVAL '12 months')
      ORDER BY service_date DESC NULLS LAST`,
    [vehicleId],
  );
  const serviceTotal = sRes.rows.reduce((s, r) => s + (Number(r.cost) || 0), 0);
  const fRes = await query(
    `SELECT COALESCE(SUM(cost),0) AS total FROM vehicle_fuel_log
      WHERE vehicle_id = $1 AND date >= (CURRENT_DATE - INTERVAL '12 months')`,
    [vehicleId],
  );
  const fuelTotal = Number(fRes.rows[0]?.total) || 0;
  const last12mTotal = serviceTotal + fuelTotal;
  // £/mile over the period from the mileage spanned in the last 12m of readings.
  let perMile: number | null = null;
  const m12 = mrows.filter((r) => new Date(r.recorded_at).getTime() >= Date.now() - 365 * 86400000);
  if (m12.length >= 2) {
    const span = Number(m12[m12.length - 1].mileage) - Number(m12[0].mileage);
    if (span > 0) perMile = Math.round((last12mTotal / span) * 100) / 100;
  }
  const recent = sRes.rows.slice(0, 8).map((r) => ({
    date: isoDate(r.service_date),
    type: r.service_type || 'service',
    name: r.name || '',
    cost: r.cost != null ? Number(r.cost) : null,
    garage: r.garage || null,
  }));

  // ── Recurring issues (by category/component) ──
  let recurringIssues: VehicleForecast['recurringIssues'] = [];
  try {
    const iRes = await query(
      `SELECT COALESCE(NULLIF(component_key,''), category, 'other') AS label,
              COUNT(*)::int AS count, MAX(created_at) AS last_at
         FROM job_issues
        WHERE vehicle_id = $1
        GROUP BY 1 HAVING COUNT(*) >= 2
        ORDER BY count DESC, last_at DESC LIMIT 8`,
      [vehicleId],
    );
    recurringIssues = iRes.rows.map((r) => ({
      label: String(r.label),
      count: Number(r.count),
      lastDate: isoDate(r.last_at),
    }));
  } catch (err) {
    console.warn('[vehicle-forecast] recurring-issue query failed:', err);
  }

  // ── Unstructured text for the AI narrator (recent prep + service notes) ──
  const notesForAi: string[] = [];
  for (const s of ordered.slice(-6)) {
    for (const sec of s.sections || []) {
      if (sec.notes && sec.notes.trim()) notesForAi.push(`Prep ${s.date} — ${sec.name}: ${sec.notes.trim()}`);
      for (const item of sec.items || []) {
        if (item.value?.toLowerCase().includes('problem')) {
          notesForAi.push(`Prep ${s.date} — ${item.name}: ${item.detail || 'problem flagged'}`);
        }
      }
    }
  }
  for (const r of sRes.rows.slice(0, 6)) {
    if (r.notes) notesForAi.push(`Service ${isoDate(r.service_date) || ''}: ${r.name} — ${r.notes}`);
    else if (r.name) notesForAi.push(`Service ${isoDate(r.service_date) || ''}: ${r.name}`);
  }

  return {
    vehicle: { id: v.id, reg, currentMileage, simpleType: v.simple_type ?? null, ulezCompliant: v.ulez_compliant ?? null },
    mileage: { perDay: perDay == null ? null : Math.round(perDay * 10) / 10, perWeek, annualProjected, readings: mrows.length },
    service: {
      nextDueMileage,
      milesUntil,
      etaWeeks,
      status: serviceStatus,
      lastServiceMileage: v.last_service_mileage ?? null,
      lastServiceDate: isoDate(v.last_service_date),
    },
    compliance,
    fluids,
    tyres: { corners, prepsWithTread },
    costs: { last12mTotal: Math.round(last12mTotal * 100) / 100, perMile, serviceTotal: Math.round(serviceTotal * 100) / 100, fuelTotal: Math.round(fuelTotal * 100) / 100, recent },
    recurringIssues,
    prepSessions: [...ordered].reverse(), // newest-first for the frontend panel
    notesForAi,
  };
}
