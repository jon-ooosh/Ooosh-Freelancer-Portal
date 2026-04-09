/**
 * HH-Derived Requirements Engine
 *
 * Reads HireHop line items stored on a job and automatically derives
 * operational requirements — what prep is needed, what configuration
 * changes are required, what workflows to trigger.
 *
 * HireHop is the source of truth for *what's on a job*.
 * The OP adds *operational intelligence* on top.
 *
 * Three-tier detection:
 *   1. Category check — items in specific HH categories
 *   2. Category + keyword — category match + item name parsing
 *   3. Prompt parsing — kind:3 selected prompts under parent items
 */

import { query, getClient } from '../config/database';
import type { HHLineItem } from './hirehop-job-sync';

// ── HH Category IDs ──────────────────────────────────────────────────────
// Source: HireHop categories_list.php, verified 9 Apr 2026

const VEHICLE_CATEGORY = 370;           // Vehicles (actual vans)
const VEHICLE_ACCESSORIES_CATEGORY = 371; // Vehicle accessories (rear seats, additional driver, etc.)
const REHEARSAL_CATEGORY = 450;         // Rehearsal Rooms
const STORAGE_CATEGORY = 449;           // Storage Space

// Backline = everything a band uses on stage. Multiple parent groups:
// GUITARS (372): 373-378, BASSES (379): 380-384, DRUMS (385): 386-398,
// KEYBOARDS (399): 400-404, WOODWIND (405), BACKLINE ACCESSORIES (406): 407-410
const BACKLINE_CATEGORIES = [
  // Guitars
  372, 373, 374, 375, 376, 377, 378,
  // Basses
  379, 380, 381, 382, 383, 384,
  // Drums
  385, 386, 387, 388, 389, 390, 391, 392, 393, 394, 395, 396, 397, 398,
  // Keyboards
  399, 400, 401, 402, 403, 404,
  // Woodwind
  405,
  // Backline accessories (stands, cases, fans, valves)
  406, 407, 408, 409, 410,
];

// PA / Sound categories (not backline — separate operational area)
const PA_CATEGORIES = [411, 412, 413, 414, 415, 416, 417, 418, 419, 420, 421, 422, 423, 424, 425, 426, 427, 428];

// DJ categories
const DJ_CATEGORIES = [429, 430, 431];

// Lighting categories
const LIGHTING_CATEGORIES = [432, 433, 434, 435, 436, 437, 438];

// Power categories
const POWER_CATEGORIES = [439, 440, 441, 442, 443];

// Staging categories
const STAGING_CATEGORIES = [444, 445, 446, 447, 448];

// Video categories
const VIDEO_CATEGORIES = [451, 452, 453];

// ── Known AUTOPULL IDs for prompts ───────────────────────────────────────

const AUTOPULL_SEAT_ROUND_TABLE = 2822;
const AUTOPULL_SEAT_FORWARD_FACING = 2823;
const SEAT_PARENT_LIST_ID = 1645; // "Rear seats:" stock item

// ── Derived flags shape ──────────────────────────────────────────────────

export interface DerivedFlags {
  has_vehicle: boolean;
  vehicle_count: number;
  vehicle_types: string[];            // e.g. ["Premium LWB (M)", "Basic MWB (A)"]
  seat_config: 'round_table' | 'forward_facing' | null;
  has_backline: boolean;
  backline_item_count: number;
  has_rehearsal: boolean;
  has_staging: boolean;
  has_pa: boolean;
  has_lighting: boolean;
  has_crew_items: boolean;            // kind:4 items on HH (sanity flag)
  crew_item_count: number;
  total_prep_time_mins: number;       // Sum of preptimemins across all items
  prep_time_by_category: {
    vehicles: number;
    backline: number;
    rehearsals: number;
    other: number;
  };
}

// ── Derive flags from line items ─────────────────────────────────────────

export function deriveFlags(items: HHLineItem[]): DerivedFlags {
  const flags: DerivedFlags = {
    has_vehicle: false,
    vehicle_count: 0,
    vehicle_types: [],
    seat_config: null,
    has_backline: false,
    backline_item_count: 0,
    has_rehearsal: false,
    has_staging: false,
    has_pa: false,
    has_lighting: false,
    has_crew_items: false,
    crew_item_count: 0,
    total_prep_time_mins: 0,
    prep_time_by_category: { vehicles: 0, backline: 0, rehearsals: 0, other: 0 },
  };

  for (const item of items) {
    const prepMins = extractPrepTime(item);

    // ── Vehicles (category 370) ──
    if (item.CATEGORY_ID === VEHICLE_CATEGORY && item.kind === 2 && !item.VIRTUAL) {
      flags.has_vehicle = true;
      flags.vehicle_count += Math.max(1, item.QUANTITY);
      flags.vehicle_types.push(item.ITEM_NAME);
      flags.prep_time_by_category.vehicles += prepMins * Math.max(1, item.QUANTITY);
    }

    // ── Seat configuration (prompt detection) ──
    if (item.kind === 3) {
      if (item.AUTOPULL === AUTOPULL_SEAT_ROUND_TABLE) {
        flags.seat_config = 'round_table';
      } else if (item.AUTOPULL === AUTOPULL_SEAT_FORWARD_FACING) {
        flags.seat_config = 'forward_facing';
      }
    }

    // ── Backline ──
    if (BACKLINE_CATEGORIES.includes(item.CATEGORY_ID) && item.kind === 2 && !item.VIRTUAL) {
      flags.has_backline = true;
      flags.backline_item_count++;
      flags.prep_time_by_category.backline += prepMins * Math.max(1, item.QUANTITY);
    }

    // ── Rehearsal (category 450) ──
    if (item.CATEGORY_ID === REHEARSAL_CATEGORY && item.kind === 2) {
      flags.has_rehearsal = true;
      flags.prep_time_by_category.rehearsals += prepMins * Math.max(1, item.QUANTITY);
    }

    // ── Staging (categories 444-448) ──
    if (STAGING_CATEGORIES.includes(item.CATEGORY_ID) && item.kind === 2 && !item.VIRTUAL) {
      flags.has_staging = true;
    }

    // ── PA / Sound (categories 411-428) ──
    if (PA_CATEGORIES.includes(item.CATEGORY_ID) && item.kind === 2 && !item.VIRTUAL) {
      flags.has_pa = true;
    }

    // ── Lighting (categories 432-438) ──
    if (LIGHTING_CATEGORIES.includes(item.CATEGORY_ID) && item.kind === 2 && !item.VIRTUAL) {
      flags.has_lighting = true;
    }

    // ── Crew/service items (kind:4) — sanity flag ──
    if (item.kind === 4) {
      flags.has_crew_items = true;
      flags.crew_item_count++;
    }

    // ── Accumulate total prep time ──
    if (item.kind !== 0 && !item.VIRTUAL && prepMins > 0) {
      const qty = Math.max(1, item.QUANTITY);
      flags.total_prep_time_mins += prepMins * qty;
      // Assign to "other" if not already counted above
      if (item.CATEGORY_ID !== VEHICLE_CATEGORY &&
          !BACKLINE_CATEGORIES.includes(item.CATEGORY_ID) &&
          item.CATEGORY_ID !== REHEARSAL_CATEGORY) {
        flags.prep_time_by_category.other += prepMins * qty;
      }
    }
  }

  return flags;
}

/** Extract prep time in minutes from TYPE_CUSTOM_FIELDS.preptimemins */
function extractPrepTime(item: HHLineItem): number {
  if (!item.TYPE_CUSTOM_FIELDS) return 0;
  const ptf = item.TYPE_CUSTOM_FIELDS.preptimemins;
  if (!ptf) return 0;
  const val = typeof ptf === 'object' ? ptf.value : ptf;
  return parseInt(String(val), 10) || 0;
}

// ── Derive and apply requirements to a job ──────────────────────────────

export interface DerivationResult {
  jobId: string;
  flags: DerivedFlags;
  requirementsCreated: string[];
  requirementsUpdated: string[];
  mismatchesFlagged: string[];
  seatAvailability?: SeatAvailability;
}

export interface SeatAvailability {
  required: 'round_table' | 'forward_facing';
  matchingVans: Array<{ id: string; reg: string; simple_type: string; seat_layout: string | null }>;
  nonMatchingVans: Array<{ id: string; reg: string; simple_type: string; seat_layout: string | null }>;
  unknownVans: Array<{ id: string; reg: string; simple_type: string }>;
}

/**
 * Main entry point: derive requirements from HH line items for a single job.
 * Creates/updates job_requirements with is_auto=true, source='hirehop_sync'.
 * Respects manual status — never overwrites staff actions, only flags mismatches.
 */
export async function deriveRequirementsForJob(jobId: string): Promise<DerivationResult> {
  const result: DerivationResult = {
    jobId,
    flags: deriveFlags([]),
    requirementsCreated: [],
    requirementsUpdated: [],
    mismatchesFlagged: [],
  };

  // Load job with line items
  const jobResult = await query(
    `SELECT id, hh_job_number, line_items, hh_derived_flags, is_van_and_driver
     FROM jobs WHERE id = $1 AND is_deleted = false`,
    [jobId]
  );

  if (jobResult.rows.length === 0) return result;
  const job = jobResult.rows[0];
  const items: HHLineItem[] = job.line_items || [];

  if (items.length === 0) return result;

  // Derive flags
  const flags = deriveFlags(items);
  result.flags = flags;

  const previousFlags: DerivedFlags | null = job.hh_derived_flags;
  const isVanAndDriver = job.is_van_and_driver === true;

  const client = await getClient();
  try {
    await client.query('BEGIN');

    // ── Vehicle requirement ──
    if (flags.has_vehicle) {
      await upsertAutoRequirement(client, jobId, 'vehicle', flags, previousFlags, result, {
        notes: buildVehicleNotes(flags),
        snapshot: items.filter(i => i.CATEGORY_ID === VEHICLE_CATEGORY && i.kind === 2),
      });
    }

    // ── Hire forms (only if self-drive) ──
    if (flags.has_vehicle && !isVanAndDriver) {
      await upsertAutoRequirement(client, jobId, 'hire_forms', flags, previousFlags, result, {
        notes: `${flags.vehicle_count} vehicle(s) — hire forms required`,
        snapshot: items.filter(i => i.CATEGORY_ID === VEHICLE_CATEGORY && i.kind === 2),
      });
    } else if (isVanAndDriver) {
      // If van & driver is set, remove auto hire_forms if they exist
      await removeAutoRequirementIfExists(client, jobId, 'hire_forms');
    }

    // ── Insurance excess (only if hire forms needed) ──
    if (flags.has_vehicle && !isVanAndDriver) {
      await upsertAutoRequirement(client, jobId, 'excess', flags, previousFlags, result, {
        notes: 'Insurance excess required for self-drive hire',
        snapshot: null,
      });
    } else if (isVanAndDriver) {
      await removeAutoRequirementIfExists(client, jobId, 'excess');
    }

    // ── Backline ──
    if (flags.has_backline) {
      await upsertAutoRequirement(client, jobId, 'backline', flags, previousFlags, result, {
        notes: `${flags.backline_item_count} backline item(s)` +
          (flags.prep_time_by_category.backline > 0
            ? ` — est. ${formatPrepTime(flags.prep_time_by_category.backline)} prep`
            : ''),
        snapshot: items.filter(i => BACKLINE_CATEGORIES.includes(i.CATEGORY_ID) && i.kind === 2),
      });
    }

    // ── Rehearsal ──
    if (flags.has_rehearsal) {
      await upsertAutoRequirement(client, jobId, 'rehearsal', flags, previousFlags, result, {
        notes: 'Rehearsal space detected from HireHop items',
        snapshot: items.filter(i => i.CATEGORY_ID === REHEARSAL_CATEGORY),
      });
    }

    // ── Save derived flags for next comparison ──
    await client.query(
      `UPDATE jobs SET hh_derived_flags = $1 WHERE id = $2`,
      [JSON.stringify(flags), jobId]
    );

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(`[HH Derive] Failed for job ${jobId}:`, err);
    throw err;
  } finally {
    client.release();
  }

  // ── Seat availability (read-only, outside transaction) ──
  if (flags.seat_config && flags.has_vehicle) {
    result.seatAvailability = await checkSeatAvailability(flags, items);
  }

  return result;
}

// ── Helpers ──────────────────────────────────────────────────────────────

/**
 * Upsert an auto-derived requirement. If it already exists:
 *   - If is_auto=true and status not changed by staff: update snapshot + notes
 *   - If status changed by staff (not 'not_started'): flag mismatch if HH data changed
 *   - Never overwrite manual requirements (is_auto=false)
 */
async function upsertAutoRequirement(
  client: any,
  jobId: string,
  requirementType: string,
  currentFlags: DerivedFlags,
  previousFlags: DerivedFlags | null,
  result: DerivationResult,
  data: { notes: string; snapshot: HHLineItem[] | null },
): Promise<void> {
  // Check if requirement already exists
  const existing = await client.query(
    `SELECT id, is_auto, status, hh_item_snapshot, notes
     FROM job_requirements
     WHERE job_id = $1 AND requirement_type = $2`,
    [jobId, requirementType]
  );

  if (existing.rows.length === 0) {
    // Create new auto requirement (existence already checked above)
    const insertResult = await client.query(
      `INSERT INTO job_requirements (job_id, requirement_type, status, notes, is_auto, source, hh_item_snapshot)
       VALUES ($1, $2, 'not_started', $3, true, 'hirehop_sync', $4)
       RETURNING id`,
      [jobId, requirementType, data.notes, data.snapshot ? JSON.stringify(data.snapshot) : null]
    );
    if (insertResult.rows.length > 0) {
      result.requirementsCreated.push(requirementType);
    }
    return;
  }

  const req = existing.rows[0];

  // Don't touch manually-created requirements
  if (!req.is_auto) return;

  // If staff has acted (status not 'not_started'), check for mismatch
  if (req.status !== 'not_started') {
    const snapshotChanged = hasSnapshotChanged(req.hh_item_snapshot, data.snapshot);
    if (snapshotChanged) {
      await client.query(
        `UPDATE job_requirements SET hh_mismatch = true,
           hh_mismatch_detail = $1, hh_item_snapshot = $2, updated_at = NOW()
         WHERE id = $3`,
        [
          `HireHop items changed since this was marked "${req.status}"`,
          data.snapshot ? JSON.stringify(data.snapshot) : null,
          req.id,
        ]
      );
      result.mismatchesFlagged.push(requirementType);
    }
    return;
  }

  // Status is still 'not_started' — safe to update notes + snapshot
  await client.query(
    `UPDATE job_requirements SET notes = $1, hh_item_snapshot = $2,
       hh_mismatch = false, hh_mismatch_detail = NULL, updated_at = NOW()
     WHERE id = $3`,
    [data.notes, data.snapshot ? JSON.stringify(data.snapshot) : null, req.id]
  );
  result.requirementsUpdated.push(requirementType);
}

/** Remove an auto requirement if it exists and hasn't been touched by staff */
async function removeAutoRequirementIfExists(client: any, jobId: string, requirementType: string): Promise<void> {
  await client.query(
    `DELETE FROM job_requirements
     WHERE job_id = $1 AND requirement_type = $2 AND is_auto = true AND status = 'not_started'`,
    [jobId, requirementType]
  );
}

/** Check if the HH item snapshot has changed meaningfully */
function hasSnapshotChanged(oldSnapshot: any, newItems: HHLineItem[] | null): boolean {
  if (!oldSnapshot && !newItems) return false;
  if (!oldSnapshot || !newItems) return true;

  const oldArr = Array.isArray(oldSnapshot) ? oldSnapshot : [];
  if (oldArr.length !== newItems.length) return true;

  // Compare by ITEM_ID + QUANTITY + ITEM_NAME (covers most meaningful changes)
  const oldSet = new Set(oldArr.map((i: any) => `${i.ITEM_ID}:${i.QUANTITY}:${i.ITEM_NAME}`));
  for (const item of newItems) {
    if (!oldSet.has(`${item.ITEM_ID}:${item.QUANTITY}:${item.ITEM_NAME}`)) return true;
  }
  return false;
}

/** Build human-readable notes for vehicle requirement */
function buildVehicleNotes(flags: DerivedFlags): string {
  const parts: string[] = [];
  parts.push(`${flags.vehicle_count} vehicle(s): ${flags.vehicle_types.join(', ')}`);

  if (flags.seat_config === 'forward_facing') {
    parts.push('Seats: Forward-facing');
  } else if (flags.seat_config === 'round_table') {
    parts.push('Seats: Round a table');
  }

  if (flags.prep_time_by_category.vehicles > 0) {
    parts.push(`Est. prep: ${formatPrepTime(flags.prep_time_by_category.vehicles)}`);
  }

  return parts.join(' | ');
}

/** Format minutes into readable time */
function formatPrepTime(mins: number): string {
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  const remainder = mins % 60;
  return remainder > 0 ? `${hours}h ${remainder}m` : `${hours}h`;
}

/**
 * Check fleet vehicles for seat configuration availability.
 * Only relevant for Premium vans (the only type with configurable rear seats).
 */
export async function checkSeatAvailability(flags: DerivedFlags, items: HHLineItem[]): Promise<SeatAvailability> {
  const required = flags.seat_config!;

  // Detect which van types are on the job (look for "Premium" in name)
  const hasPremium = flags.vehicle_types.some(t => t.toLowerCase().includes('premium'));

  if (!hasPremium) {
    // Non-premium vans don't have configurable seats
    return { required, matchingVans: [], nonMatchingVans: [], unknownVans: [] };
  }

  // Query available Premium fleet vehicles
  const vansResult = await query(
    `SELECT id, reg, simple_type, seat_layout
     FROM fleet_vehicles
     WHERE is_active = true
       AND simple_type ILIKE '%Premium%'
       AND hire_status NOT IN ('On Hire', 'Sold')
     ORDER BY reg`
  );

  const matching: SeatAvailability['matchingVans'] = [];
  const nonMatching: SeatAvailability['nonMatchingVans'] = [];
  const unknown: SeatAvailability['unknownVans'] = [];

  for (const van of vansResult.rows) {
    if (!van.seat_layout) {
      unknown.push({ id: van.id, reg: van.reg, simple_type: van.simple_type });
    } else if (van.seat_layout === required) {
      matching.push(van);
    } else {
      nonMatching.push(van);
    }
  }

  return { required, matchingVans: matching, nonMatchingVans: nonMatching, unknownVans: unknown };
}

// ── Bulk derivation (for background sync) ────────────────────────────────

/**
 * Run derivation for all active jobs that have line items.
 * Called from the 30-min sync cycle after line items are refreshed.
 */
export async function deriveRequirementsForActiveJobs(): Promise<{ processed: number; created: number; mismatches: number }> {
  let processed = 0;
  let created = 0;
  let mismatches = 0;

  try {
    const jobsResult = await query(
      `SELECT id FROM jobs
       WHERE is_deleted = false
         AND status = ANY($1)
         AND hh_job_number IS NOT NULL
         AND line_items IS NOT NULL
         AND line_items != '[]'::jsonb`,
      [[1, 2, 3, 4, 5, 6]]
    );

    for (const row of jobsResult.rows) {
      try {
        const result = await deriveRequirementsForJob(row.id);
        processed++;
        created += result.requirementsCreated.length;
        mismatches += result.mismatchesFlagged.length;
      } catch (err) {
        console.warn(`[HH Derive] Error for job ${row.id}:`, err);
      }
    }

    console.log(`[HH Derive] Processed ${processed} jobs: ${created} requirements created, ${mismatches} mismatches flagged`);
  } catch (err) {
    console.error('[HH Derive] Bulk derivation error:', err);
  }

  return { processed, created, mismatches };
}
