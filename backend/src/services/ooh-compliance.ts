/**
 * Out-of-Hours return compliance (Part 2 of docs/OOH-SMS-AND-COMPLIANCE-SPEC.md).
 *
 * "Did they park considerately?" is a STAFF judgement made at van check-in (and
 * retro-flaggable for a few days after). Not automated. Each flag is a
 * ooh_return_violations row attributed to a driver; once a driver crosses the
 * configurable threshold the system *suggests* a block (never auto-applies it).
 */
import { query } from '../config/database';
import { getSystemSetting } from '../routes/system-settings';

export type OohViolationType =
  | 'parked_blocking'
  | 'parked_outside_yard'
  | 'left_without_telling_us'
  | 'other';
export type OohSeverity = 'minor' | 'serious';

export const OOH_VIOLATION_TYPES: OohViolationType[] = [
  'parked_blocking',
  'parked_outside_yard',
  'left_without_telling_us',
  'other',
];

/** Resolve an OP job UUID from either a UUID or an HH job number. */
export async function resolveJobId(opts: {
  job_id?: string | null;
  hh_job_number?: number | null;
}): Promise<string | null> {
  if (opts.job_id) return opts.job_id;
  if (opts.hh_job_number != null) {
    const r = await query(`SELECT id FROM jobs WHERE hh_job_number = $1 LIMIT 1`, [opts.hh_job_number]);
    return (r.rows[0]?.id as string | undefined) ?? null;
  }
  return null;
}

/** Resolve a fleet vehicle UUID from either a UUID or a registration. */
export async function resolveVehicleId(opts: {
  vehicle_id?: string | null;
  reg?: string | null;
}): Promise<string | null> {
  if (opts.vehicle_id) return opts.vehicle_id;
  if (opts.reg) {
    const r = await query(
      `SELECT id FROM fleet_vehicles WHERE REPLACE(UPPER(reg), ' ', '') = REPLACE(UPPER($1), ' ', '') LIMIT 1`,
      [opts.reg],
    );
    return (r.rows[0]?.id as string | undefined) ?? null;
  }
  return null;
}

export async function getBlockThreshold(): Promise<number> {
  const raw = await getSystemSetting('ooh_violation_block_threshold');
  const n = parseInt(raw || '2', 10);
  return isFinite(n) && n > 0 ? n : 2;
}

export interface OohVanDriver {
  assignmentId: string;
  driverId: string | null;
  driverName: string | null;
  submitted: boolean; // confirmed parking via the form
  blocked: boolean;
}

/**
 * The OOH-flagged drivers on a given (job, vehicle) — drives the check-in
 * "OOH steps followed?" capture + its attribution picker. Includes returned
 * rows because check-in may already have flipped status.
 */
export async function getOohVanDrivers(jobId: string, vehicleId: string): Promise<OohVanDriver[]> {
  const r = await query(
    `SELECT vha.id              AS assignment_id,
            vha.driver_id        AS driver_id,
            d.full_name          AS driver_name,
            vha.ooh_returned_at  AS returned_at,
            COALESCE(d.ooh_blocked, FALSE) AS blocked
       FROM vehicle_hire_assignments vha
       LEFT JOIN drivers d ON d.id = vha.driver_id
      WHERE vha.job_id = $1
        AND vha.vehicle_id = $2
        AND vha.return_overnight = TRUE
        AND vha.status IN ('booked_out', 'active', 'returned')
      ORDER BY vha.van_requirement_index NULLS LAST, vha.created_at ASC`,
    [jobId, vehicleId],
  );
  return (r.rows as Array<{
    assignment_id: string;
    driver_id: string | null;
    driver_name: string | null;
    returned_at: Date | null;
    blocked: boolean;
  }>).map(row => ({
    assignmentId: row.assignment_id,
    driverId: row.driver_id,
    driverName: row.driver_name,
    submitted: !!row.returned_at,
    blocked: row.blocked,
  }));
}

export interface CreateViolationResult {
  violationId: string;
  driverId: string | null;
  driverViolationCount: number;
  threshold: number;
  blockSuggested: boolean; // driver crossed threshold and isn't already blocked
}

/**
 * Record a parking violation. Attribution: explicit driver_id wins; else, if the
 * (job, vehicle) has exactly one OOH driver, attribute to them; else leave null
 * ("whole hire / unattributed") for staff to resolve later.
 */
export async function createViolation(opts: {
  jobId: string | null;
  vehicleId: string | null;
  driverId?: string | null;
  assignmentId?: string | null;
  type: OohViolationType;
  severity?: OohSeverity;
  notes?: string | null;
  occurredOn?: string | null;
  loggedBy: string;
}): Promise<CreateViolationResult> {
  let driverId = opts.driverId ?? null;
  let assignmentId = opts.assignmentId ?? null;

  // Auto-attribute when not given and we can be certain (single OOH driver).
  if (!driverId && opts.jobId && opts.vehicleId) {
    const drivers = await getOohVanDrivers(opts.jobId, opts.vehicleId);
    if (drivers.length === 1) {
      driverId = drivers[0].driverId;
      assignmentId = assignmentId ?? drivers[0].assignmentId;
    } else if (!assignmentId && drivers.length > 0) {
      assignmentId = drivers[0].assignmentId; // link to the lead row for context
    }
  }

  const ins = await query(
    `INSERT INTO ooh_return_violations
       (driver_id, assignment_id, job_id, vehicle_id, type, severity, notes, occurred_on, logged_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, COALESCE($8::date, CURRENT_DATE), $9)
     RETURNING id`,
    [
      driverId,
      assignmentId,
      opts.jobId,
      opts.vehicleId,
      opts.type,
      opts.severity || 'serious',
      opts.notes ?? null,
      opts.occurredOn ?? null,
      opts.loggedBy,
    ],
  );
  const violationId = ins.rows[0].id as string;

  const threshold = await getBlockThreshold();
  let driverViolationCount = 0;
  let blockSuggested = false;
  if (driverId) {
    const c = await query(
      `SELECT COUNT(*)::int AS n, BOOL_OR(COALESCE(ooh_blocked, FALSE)) AS already
         FROM ooh_return_violations v
         JOIN drivers d ON d.id = v.driver_id
        WHERE v.driver_id = $1 AND v.dismissed = FALSE`,
      [driverId],
    );
    driverViolationCount = (c.rows[0]?.n as number) ?? 0;
    const already = (c.rows[0]?.already as boolean) ?? false;
    blockSuggested = !already && driverViolationCount >= threshold;
  }

  return { violationId, driverId, driverViolationCount, threshold, blockSuggested };
}

export async function setDriverBlock(
  driverId: string,
  blocked: boolean,
  reason: string | null,
  userId: string,
): Promise<void> {
  await query(
    `UPDATE drivers
        SET ooh_blocked = $1,
            ooh_blocked_at = CASE WHEN $1 THEN NOW() ELSE NULL END,
            ooh_blocked_reason = CASE WHEN $1 THEN $2 ELSE NULL END,
            ooh_blocked_by = CASE WHEN $1 THEN $3::uuid ELSE NULL END,
            updated_at = NOW()
      WHERE id = $4`,
    [blocked, reason, userId, driverId],
  );
}

/** Which OOH drivers on a (job, vehicle) are blocked — for the toggle/book-out gate. */
export async function getBlockedOohDrivers(
  jobId: string,
  vehicleId: string,
): Promise<Array<{ driverId: string; driverName: string | null }>> {
  const r = await query(
    `SELECT DISTINCT d.id AS driver_id, d.full_name AS driver_name
       FROM vehicle_hire_assignments vha
       JOIN drivers d ON d.id = vha.driver_id
      WHERE vha.job_id = $1 AND vha.vehicle_id = $2
        AND COALESCE(d.ooh_blocked, FALSE) = TRUE`,
    [jobId, vehicleId],
  );
  return (r.rows as Array<{ driver_id: string; driver_name: string | null }>).map(row => ({
    driverId: row.driver_id,
    driverName: row.driver_name,
  }));
}

export interface DriverComplianceSummary {
  driverId: string;
  blocked: boolean;
  blockedAt: string | null;
  blockReason: string | null;
  violationCount: number;
  threshold: number;
  violations: Array<{
    id: string;
    occurredOn: string | null;
    type: string;
    severity: string;
    notes: string | null;
    dismissed: boolean;
    jobId: string | null;
    hhJobNumber: number | null;
    vehicleReg: string | null;
    loggedByName: string | null;
    createdAt: string;
  }>;
}

export async function getDriverCompliance(driverId: string): Promise<DriverComplianceSummary | null> {
  const d = await query(
    `SELECT id, ooh_blocked, ooh_blocked_at, ooh_blocked_reason FROM drivers WHERE id = $1`,
    [driverId],
  );
  const drv = d.rows[0] as
    | { id: string; ooh_blocked: boolean; ooh_blocked_at: Date | null; ooh_blocked_reason: string | null }
    | undefined;
  if (!drv) return null;

  const v = await query(
    `SELECT v.id, v.occurred_on, v.type, v.severity, v.notes, v.dismissed, v.created_at,
            v.job_id, j.hh_job_number, fv.reg AS vehicle_reg,
            u_p.full_name AS logged_by_name
       FROM ooh_return_violations v
       LEFT JOIN jobs j ON j.id = v.job_id
       LEFT JOIN fleet_vehicles fv ON fv.id = v.vehicle_id
       LEFT JOIN users u ON u.id = v.logged_by
       LEFT JOIN people u_p ON u_p.id = u.person_id
      WHERE v.driver_id = $1
      ORDER BY v.occurred_on DESC, v.created_at DESC`,
    [driverId],
  );

  const threshold = await getBlockThreshold();
  const violations = (v.rows as Array<Record<string, unknown>>).map(row => ({
    id: row.id as string,
    occurredOn: row.occurred_on ? String(row.occurred_on).slice(0, 10) : null,
    type: row.type as string,
    severity: row.severity as string,
    notes: (row.notes as string | null) ?? null,
    dismissed: (row.dismissed as boolean) ?? false,
    jobId: (row.job_id as string | null) ?? null,
    hhJobNumber: (row.hh_job_number as number | null) ?? null,
    vehicleReg: (row.vehicle_reg as string | null) ?? null,
    loggedByName: (row.logged_by_name as string | null) ?? null,
    createdAt: row.created_at ? new Date(row.created_at as string).toISOString() : '',
  }));

  return {
    driverId: drv.id,
    blocked: drv.ooh_blocked,
    blockedAt: drv.ooh_blocked_at ? new Date(drv.ooh_blocked_at).toISOString() : null,
    blockReason: drv.ooh_blocked_reason,
    violationCount: violations.filter(x => !x.dismissed).length,
    threshold,
    violations,
  };
}

export interface RecentOohReturn {
  jobId: string;
  hhJobNumber: number | null;
  jobName: string | null;
  vehicleId: string;
  vehicleReg: string;
  returnedAt: string | null;
  submitted: boolean;
  drivers: OohVanDriver[];
  existingViolationId: string | null;
}

/**
 * OOH-flagged returns in the last N days — powers the dashboard "Recent OOH
 * returns" retro-flag list (so someone other than the check-in person can flag).
 */
export async function getRecentOohReturns(days: number): Promise<RecentOohReturn[]> {
  const r = await query(
    `SELECT vha.job_id, j.hh_job_number, j.job_name,
            vha.vehicle_id, fv.reg AS vehicle_reg,
            vha.driver_id, d.full_name AS driver_name,
            vha.ooh_returned_at, vha.checked_in_at, vha.status_changed_at, vha.status,
            COALESCE(d.ooh_blocked, FALSE) AS blocked,
            vha.id AS assignment_id
       FROM vehicle_hire_assignments vha
       JOIN jobs j ON j.id = vha.job_id
       LEFT JOIN fleet_vehicles fv ON fv.id = vha.vehicle_id
       LEFT JOIN drivers d ON d.id = vha.driver_id
      WHERE vha.return_overnight = TRUE
        AND vha.vehicle_id IS NOT NULL
        AND GREATEST(
              COALESCE(vha.ooh_returned_at, 'epoch'::timestamptz),
              COALESCE(vha.checked_in_at, 'epoch'::timestamptz),
              CASE WHEN vha.status = 'returned' THEN COALESCE(vha.status_changed_at, 'epoch'::timestamptz) ELSE 'epoch'::timestamptz END
            ) >= NOW() - ($1 || ' days')::interval
      ORDER BY vha.vehicle_id, vha.van_requirement_index NULLS LAST, vha.created_at ASC`,
    [String(days)],
  );

  interface Row {
    job_id: string;
    hh_job_number: number | null;
    job_name: string | null;
    vehicle_id: string;
    vehicle_reg: string;
    driver_id: string | null;
    driver_name: string | null;
    ooh_returned_at: Date | null;
    checked_in_at: Date | null;
    status_changed_at: Date | null;
    status: string;
    blocked: boolean;
    assignment_id: string;
  }
  const rows = r.rows as Row[];

  // Group by (job, vehicle)
  const groups = new Map<string, Row[]>();
  for (const row of rows) {
    const key = `${row.job_id}:${row.vehicle_id}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(row);
  }

  // Existing (non-dismissed) violations for these jobs+vehicles, to mark "already flagged".
  const existing = await query(
    `SELECT DISTINCT ON (job_id, vehicle_id) job_id, vehicle_id, id
       FROM ooh_return_violations
      WHERE dismissed = FALSE
      ORDER BY job_id, vehicle_id, created_at DESC`,
  );
  const existingMap = new Map<string, string>();
  for (const e of existing.rows as Array<{ job_id: string; vehicle_id: string; id: string }>) {
    existingMap.set(`${e.job_id}:${e.vehicle_id}`, e.id);
  }

  const out: RecentOohReturn[] = [];
  for (const [key, grp] of groups) {
    const lead = grp[0];
    const returnedTimes = grp
      .map(g => g.ooh_returned_at || g.checked_in_at || (g.status === 'returned' ? g.status_changed_at : null))
      .filter(Boolean) as Date[];
    const returnedAt = returnedTimes.length
      ? new Date(Math.max(...returnedTimes.map(t => new Date(t).getTime()))).toISOString()
      : null;
    out.push({
      jobId: lead.job_id,
      hhJobNumber: lead.hh_job_number,
      jobName: lead.job_name,
      vehicleId: lead.vehicle_id,
      vehicleReg: lead.vehicle_reg,
      returnedAt,
      submitted: grp.some(g => !!g.ooh_returned_at),
      drivers: grp.map(g => ({
        assignmentId: g.assignment_id,
        driverId: g.driver_id,
        driverName: g.driver_name,
        submitted: !!g.ooh_returned_at,
        blocked: g.blocked,
      })),
      existingViolationId: existingMap.get(key) ?? null,
    });
  }

  // Newest return first
  out.sort((a, b) => (b.returnedAt || '').localeCompare(a.returnedAt || ''));
  return out;
}
