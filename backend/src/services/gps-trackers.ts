/**
 * The GPS tracker register — THE definition of which tracker is in which van
 * (migration 284, docs/reference/VEHICLES-AND-FLEET.md "GPS trackers").
 *
 * Each physical unit carries a numbered label (001, 002…). Traccar knows a
 * unit by its IMEI, so a van's Traccar device is found through the tracker
 * fitted to it (`imeiForReg`) — the device's name in Traccar is only a
 * fallback for vans with no tracker on the register.
 *
 * "Fitted" is never stored on the tracker: it is the open row (removed_on IS
 * NULL) in gps_tracker_fittings, which is also the history.
 */
import { query, getClient } from '../config/database';
import { ukToday } from './uk-date';
import { DISPLAY_NAME_SQL } from './display-name';

export const TRACKER_STATUSES = ['active', 'faulty', 'retired'] as const;
export type TrackerStatus = typeof TRACKER_STATUSES[number];

export class TrackerError extends Error {
  constructor(public status: number, message: string) {
    super(message);
    this.name = 'TrackerError';
  }
}

/**
 * A position a tracker sends with no satellite fix comes through as 0,0 —
 * "Null Island", in the Gulf of Guinea. Never a real place for a UK van, so
 * every reader of Traccar positions drops it (the RO23HLU "in the sea" bug).
 */
export function isRealFix(lat: unknown, lng: unknown): boolean {
  if (typeof lat !== 'number' || typeof lng !== 'number') return false;
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return false;
  return !(lat === 0 && lng === 0);
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function assertId(id: string, what: string): void {
  if (!UUID_RE.test(id)) throw new TrackerError(404, `${what} not found`);
}

export function normaliseReg(s: string): string {
  return s.replace(/\s+/g, '').toUpperCase();
}

// ── Validation (pure) ───────────────────────────────────────────────────────

/** '7' → '007'; anything else non-empty is kept as typed (trimmed, upper). */
export function cleanTrackerNumber(v: unknown): string | undefined {
  if (typeof v !== 'string' && typeof v !== 'number') return undefined;
  const s = String(v).trim().toUpperCase();
  if (!s || s.length > 10) return undefined;
  return /^\d+$/.test(s) ? s.padStart(3, '0') : s;
}

/** An IMEI is 15 digits. */
export function cleanImei(v: unknown): string | undefined {
  if (typeof v !== 'string' && typeof v !== 'number') return undefined;
  const s = String(v).replace(/\s+/g, '');
  return /^\d{15}$/.test(s) ? s : undefined;
}

/** A SIM ICCID is 18–22 digits (some end in a letter F). Empty = null. */
export function cleanIccid(v: unknown): string | null | undefined {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v !== 'string' && typeof v !== 'number') return undefined;
  const s = String(v).replace(/\s+/g, '').toUpperCase();
  if (!s) return null;
  return /^\d{17,21}[\dF]$/.test(s) ? s : undefined;
}

/** YYYY-MM-DD with a real day, or undefined. */
function cleanDate(v: unknown): string | undefined {
  if (typeof v !== 'string' || !/^20\d{2}-\d{2}-\d{2}$/.test(v)) return undefined;
  const d = new Date(`${v}T00:00:00Z`);
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== v) return undefined;
  return v;
}

// ── Reads ───────────────────────────────────────────────────────────────────

export interface TrackerRow {
  id: string;
  trackerNumber: string;
  imei: string;
  iccid: string | null;
  status: TrackerStatus;
  notes: string | null;
  /** The van it is in now, or null = not fitted. */
  vehicleId: string | null;
  vehicleReg: string | null;
  /** false = that van has left the fleet (sold / old) — the tracker wants recovering. */
  vehicleActive: boolean | null;
  fittedOn: string | null;
}

const TRACKER_SELECT = `
  SELECT t.id, t.tracker_number, t.imei, t.iccid, t.status, t.notes,
         f.vehicle_id, COALESCE(v.reg, f.vehicle_reg) AS vehicle_reg,
         CASE WHEN v.id IS NULL THEN NULL
              ELSE (COALESCE(v.is_active, true) AND COALESCE(v.fleet_group, '') <> 'old_sold')
         END AS vehicle_active,
         to_char(f.fitted_on, 'YYYY-MM-DD') AS fitted_on
    FROM gps_trackers t
    LEFT JOIN gps_tracker_fittings f ON f.tracker_id = t.id AND f.removed_on IS NULL
    LEFT JOIN fleet_vehicles v ON v.id = f.vehicle_id`;

function toRow(r: Record<string, unknown>): TrackerRow {
  return {
    id: r.id as string,
    trackerNumber: r.tracker_number as string,
    imei: r.imei as string,
    iccid: (r.iccid as string) || null,
    status: r.status as TrackerStatus,
    notes: (r.notes as string) || null,
    vehicleId: (r.vehicle_id as string) || null,
    vehicleReg: (r.vehicle_reg as string) || null,
    vehicleActive: r.vehicle_active === null || r.vehicle_active === undefined ? null : Boolean(r.vehicle_active),
    fittedOn: (r.fitted_on as string) || null,
  };
}

export async function listTrackers(): Promise<TrackerRow[]> {
  const res = await query(`${TRACKER_SELECT} ORDER BY t.tracker_number`);
  return res.rows.map(toRow);
}

async function getTracker(id: string): Promise<TrackerRow> {
  assertId(id, 'Tracker');
  const res = await query(`${TRACKER_SELECT} WHERE t.id = $1`, [id]);
  if (!res.rows[0]) throw new TrackerError(404, 'Tracker not found');
  return toRow(res.rows[0]);
}

export interface FittingRow {
  vehicleId: string | null;
  vehicleReg: string;
  fittedOn: string;
  removedOn: string | null;
  fittedBy: string | null;
  removedBy: string | null;
}

/** DISPLAY_NAME_SQL is written against alias `p`; the history joins two people. */
const nameAs = (alias: string) => DISPLAY_NAME_SQL.replace(/\bp\./g, `${alias}.`);

/** Every van this tracker has been in, newest first. */
export async function getTrackerHistory(id: string): Promise<FittingRow[]> {
  assertId(id, 'Tracker');
  const res = await query(
    `SELECT f.vehicle_id, COALESCE(v.reg, f.vehicle_reg) AS vehicle_reg,
            to_char(f.fitted_on, 'YYYY-MM-DD') AS fitted_on,
            to_char(f.removed_on, 'YYYY-MM-DD') AS removed_on,
            ${nameAs('fu')} AS fitted_by, ${nameAs('ru')} AS removed_by
       FROM gps_tracker_fittings f
       LEFT JOIN fleet_vehicles v ON v.id = f.vehicle_id
       LEFT JOIN users fbu ON fbu.id = f.fitted_by
       LEFT JOIN people fu ON fu.id = fbu.person_id
       LEFT JOIN users rbu ON rbu.id = f.removed_by
       LEFT JOIN people ru ON ru.id = rbu.person_id
      WHERE f.tracker_id = $1
      ORDER BY f.fitted_on DESC, f.created_at DESC`,
    [id],
  );
  return res.rows.map((r) => ({
    vehicleId: r.vehicle_id || null,
    vehicleReg: r.vehicle_reg,
    fittedOn: r.fitted_on,
    removedOn: r.removed_on || null,
    fittedBy: r.fitted_by?.trim() || null,
    removedBy: r.removed_by?.trim() || null,
  }));
}

/** The IMEI of the tracker fitted to this van now, or null. */
export async function imeiForReg(reg: string): Promise<string | null> {
  const res = await query(
    `SELECT t.imei
       FROM gps_tracker_fittings f
       JOIN gps_trackers t ON t.id = f.tracker_id
       JOIN fleet_vehicles v ON v.id = f.vehicle_id
      WHERE f.removed_on IS NULL
        AND UPPER(REPLACE(v.reg, ' ', '')) = $1
      LIMIT 1`,
    [normaliseReg(reg)],
  );
  return res.rows[0]?.imei || null;
}

// ── Writes ──────────────────────────────────────────────────────────────────

function uniqueClash(err: unknown): TrackerError | null {
  const e = err as { code?: string; constraint?: string };
  if (e?.code !== '23505') return null;
  if (e.constraint?.includes('imei')) return new TrackerError(409, 'Another tracker already has that IMEI');
  if (e.constraint?.includes('tracker_number')) return new TrackerError(409, 'That tracker number is already used');
  if (e.constraint?.includes('open_vehicle')) return new TrackerError(409, 'That van already has a tracker fitted');
  if (e.constraint?.includes('open_tracker')) return new TrackerError(409, 'That tracker is already fitted to a van');
  return new TrackerError(409, 'That clashes with an existing tracker');
}

export async function createTracker(body: Record<string, unknown>): Promise<TrackerRow> {
  const trackerNumber = cleanTrackerNumber(body.trackerNumber);
  if (!trackerNumber) throw new TrackerError(400, 'Tracker number is required');
  const imei = cleanImei(body.imei);
  if (!imei) throw new TrackerError(400, 'IMEI must be 15 digits');
  const iccid = cleanIccid(body.iccid);
  if (iccid === undefined) throw new TrackerError(400, 'SIM number (ICCID) should be 18–22 digits');
  const notes = typeof body.notes === 'string' && body.notes.trim() ? body.notes.trim() : null;
  try {
    const res = await query(
      `INSERT INTO gps_trackers (tracker_number, imei, iccid, notes) VALUES ($1, $2, $3, $4) RETURNING id`,
      [trackerNumber, imei, iccid, notes],
    );
    return getTracker(res.rows[0].id);
  } catch (err) {
    throw uniqueClash(err) || err;
  }
}

export async function updateTracker(id: string, body: Record<string, unknown>): Promise<TrackerRow> {
  const current = await getTracker(id);
  const sets: string[] = [];
  const params: unknown[] = [];
  const set = (col: string, val: unknown) => { params.push(val); sets.push(`${col} = $${params.length}`); };

  if (body.trackerNumber !== undefined) {
    const v = cleanTrackerNumber(body.trackerNumber);
    if (!v) throw new TrackerError(400, 'Tracker number is required');
    set('tracker_number', v);
  }
  if (body.imei !== undefined) {
    const v = cleanImei(body.imei);
    if (!v) throw new TrackerError(400, 'IMEI must be 15 digits');
    set('imei', v);
  }
  if (body.iccid !== undefined) {
    const v = cleanIccid(body.iccid);
    if (v === undefined) throw new TrackerError(400, 'SIM number (ICCID) should be 18–22 digits');
    set('iccid', v);
  }
  if (body.status !== undefined) {
    if (!(TRACKER_STATUSES as readonly unknown[]).includes(body.status)) {
      throw new TrackerError(400, 'Unknown status');
    }
    if (body.status === 'retired' && current.vehicleId) {
      throw new TrackerError(409, `Take it out of ${current.vehicleReg} first`);
    }
    set('status', body.status);
  }
  if (body.notes !== undefined) {
    set('notes', typeof body.notes === 'string' && body.notes.trim() ? body.notes.trim() : null);
  }
  if (sets.length === 0) return current;

  params.push(id);
  try {
    await query(
      `UPDATE gps_trackers SET ${sets.join(', ')}, updated_at = NOW() WHERE id = $${params.length}`,
      params,
    );
  } catch (err) {
    throw uniqueClash(err) || err;
  }
  return getTracker(id);
}

/**
 * Put a tracker in a van. If it is in another van now, that fitting is closed
 * on the same day (a move). A van that already has a different tracker is
 * refused — take that one out first, so nobody loses track of a unit.
 */
export async function fitTracker(
  id: string,
  vehicleId: unknown,
  userId: string | null,
  fittedOnRaw?: unknown,
): Promise<TrackerRow> {
  assertId(id, 'Tracker');
  if (typeof vehicleId !== 'string' || !vehicleId) throw new TrackerError(400, 'Choose a van');
  assertId(vehicleId, 'Van');
  const fittedOn = fittedOnRaw === undefined || fittedOnRaw === null || fittedOnRaw === ''
    ? ukToday()
    : cleanDate(fittedOnRaw);
  if (!fittedOn) throw new TrackerError(400, 'Bad fitted date');

  const client = await getClient();
  try {
    await client.query('BEGIN');
    const t = await client.query(`SELECT id, status FROM gps_trackers WHERE id = $1 FOR UPDATE`, [id]);
    if (!t.rows[0]) throw new TrackerError(404, 'Tracker not found');
    if (t.rows[0].status === 'retired') throw new TrackerError(409, 'That tracker is retired');

    const v = await client.query(`SELECT id, reg FROM fleet_vehicles WHERE id = $1`, [vehicleId]);
    if (!v.rows[0]) throw new TrackerError(404, 'Van not found');

    const other = await client.query(
      `SELECT t.tracker_number FROM gps_tracker_fittings f JOIN gps_trackers t ON t.id = f.tracker_id
        WHERE f.vehicle_id = $1 AND f.removed_on IS NULL AND f.tracker_id <> $2`,
      [vehicleId, id],
    );
    if (other.rows[0]) {
      throw new TrackerError(409, `${v.rows[0].reg} already has tracker ${other.rows[0].tracker_number} — take that one out first`);
    }

    const open = await client.query(
      `SELECT id, vehicle_id, to_char(fitted_on, 'YYYY-MM-DD') AS fitted_on
         FROM gps_tracker_fittings WHERE tracker_id = $1 AND removed_on IS NULL`,
      [id],
    );
    if (open.rows[0]?.vehicle_id === vehicleId) throw new TrackerError(409, `It is already in ${v.rows[0].reg}`);
    if (open.rows[0]) {
      if (fittedOn < open.rows[0].fitted_on) {
        throw new TrackerError(400, `It went into its current van on ${open.rows[0].fitted_on} — the move can't be earlier`);
      }
      await client.query(
        `UPDATE gps_tracker_fittings SET removed_on = $1, removed_by = $2 WHERE id = $3`,
        [fittedOn, userId, open.rows[0].id],
      );
    }
    await client.query(
      `INSERT INTO gps_tracker_fittings (tracker_id, vehicle_id, vehicle_reg, fitted_on, fitted_by)
       VALUES ($1, $2, $3, $4, $5)`,
      [id, vehicleId, v.rows[0].reg, fittedOn, userId],
    );
    await client.query(`UPDATE gps_trackers SET updated_at = NOW() WHERE id = $1`, [id]);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw uniqueClash(err) || err;
  } finally {
    client.release();
  }
  return getTracker(id);
}

/** Take a tracker out of its van (it becomes a spare). */
export async function removeTracker(id: string, userId: string | null, removedOnRaw?: unknown): Promise<TrackerRow> {
  const current = await getTracker(id);
  if (!current.vehicleId && !current.vehicleReg) throw new TrackerError(409, 'It is not fitted to a van');
  const removedOn = removedOnRaw === undefined || removedOnRaw === null || removedOnRaw === ''
    ? ukToday()
    : cleanDate(removedOnRaw);
  if (!removedOn) throw new TrackerError(400, 'Bad removed date');
  if (current.fittedOn && removedOn < current.fittedOn) {
    throw new TrackerError(400, `It was fitted on ${current.fittedOn} — it can't come out before that`);
  }
  await query(
    `UPDATE gps_tracker_fittings SET removed_on = $1, removed_by = $2
      WHERE tracker_id = $3 AND removed_on IS NULL`,
    [removedOn, userId, id],
  );
  await query(`UPDATE gps_trackers SET updated_at = NOW() WHERE id = $1`, [id]);
  return getTracker(id);
}
