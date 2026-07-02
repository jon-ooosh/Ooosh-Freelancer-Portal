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
import { syncExcessRequirementStatus } from './excess-requirement-sync';
import { syncCostResolveRequirementStatus } from './cost-requirement-sync';
import { hhBroker } from './hirehop-broker';
import { calculateVatAdjustment } from './vat-adjustment';
import { BACKLINE_CATEGORY_IDS } from './backline-categories';
import { computeRehearsalDetail, buildRehearsalSummary, type RehearsalDetail } from './rehearsal-plan';
import { syncRehearsalRequirementStatus } from './studio-sitter';

// ── HH Category IDs ──────────────────────────────────────────────────────
// Source: HireHop categories_list.php, verified 9 Apr 2026

const VEHICLE_CATEGORY = 370;           // Vehicles (actual vans)
const VEHICLE_ACCESSORIES_CATEGORY = 371; // Vehicle accessories (rear seats, additional driver, etc.)
const REHEARSAL_CATEGORY = 450;         // Rehearsal Rooms
const STORAGE_CATEGORY = 449;           // Storage Space

// "Backline" in Ooosh's operational context = ALL equipment the warehouse preps.
// Single source of truth in `backline-categories.ts` (shared with the Backline
// Matcher). Includes instruments, PA/sound, DJ, lighting, staging, power, video,
// accessories. Everything EXCEPT vehicles (370-371), rehearsal rooms (450),
// storage (449).
const BACKLINE_CATEGORIES = BACKLINE_CATEGORY_IDS;

// Keep separate arrays for sanity-check flags (has_pa, has_lighting, etc.)
const PA_CATEGORIES = [411, 412, 413, 414, 415, 416, 417, 418, 419, 420, 421, 422, 423, 424, 425, 426, 427, 428];
const DJ_CATEGORIES = [429, 430, 431];
const LIGHTING_CATEGORIES = [432, 433, 434, 435, 436, 437, 438];
const POWER_CATEGORIES = [439, 440, 441, 442, 443];
const STAGING_CATEGORIES = [444, 445, 446, 447, 448];
const VIDEO_CATEGORIES = [451, 452, 453];

// ── Known AUTOPULL IDs for prompts ───────────────────────────────────────

const AUTOPULL_SEAT_ROUND_TABLE = 2822;
const AUTOPULL_SEAT_FORWARD_FACING = 2823;
const SEAT_PARENT_LIST_ID = 1645; // "Rear seats:" stock item

// VE103B certificate — chargeable HH stock item (CATEGORY_ID 355 "Misc Sale Item",
// £25 one-off). Its presence on a job is sales' signal that the vehicle is going
// abroad and needs a VE103B. One cert per vehicle going abroad, so the line
// QUANTITY = number of vans going abroad = number of certs needed.
const VE103B_CERT_LIST_ID = 1023;

// ATA Carnet arrangement fee — chargeable HH sale item (CATEGORY_ID 355 "Misc
// Sale Item", £750). Its presence on a job is sales' signal that we're
// arranging a carnet on the client's behalf (the 'we_supply' mode). Mirrors
// the VE103B detection. See docs/CARNET-SPEC.md.
//
// ⚠️ The CATEGORY_ID 355 guard is REQUIRED, not belt-and-braces: HireHop's
// asset and sale-item stock-ID spaces are SEPARATE, so a rental ASSET can also
// carry LIST_ID 575 (a completely different item). Matching LIST_ID alone
// false-fired the carnet on any job carrying asset-575 (jobs 16142 / 16007 /
// 15828 incident, Jun 2026). The real carnet sale item is uniquely 575 + cat 355.
const CARNET_ARRANGEMENT_LIST_ID = 575;
const MISC_SALE_CATEGORY = 355;

// ── Derived flags shape ──────────────────────────────────────────────────

export type VehicleSlotMode = 'self_drive' | 'van_and_driver';

/** Per-vehicle-slot mode overrides, keyed by HH ITEM_ID.
 *  Array index = slot index within the line. Missing entries default to 'self_drive'. */
export type VehicleSlotModes = Record<string, VehicleSlotMode[]>;

export interface VehicleSlot {
  item_id: number;
  slot_index: number;
  item_name: string;
  mode: VehicleSlotMode;
}

export interface DerivedFlags {
  has_vehicle: boolean;
  vehicle_count: number;
  vehicle_types: string[];            // e.g. ["Premium LWB (M)", "Basic MWB (A)"]
  vehicle_slots: VehicleSlot[];       // One entry per van slot (expanded from qty)
  self_drive_count: number;           // Number of slots with mode='self_drive'
  van_and_driver_count: number;       // Number of slots with mode='van_and_driver'
  seat_config: 'round_table' | 'forward_facing' | null;
  ve103b_required: boolean;           // VE103B cert item (1023) present on the job
  vans_going_abroad: number;          // Count of certs needed (= qty of item 1023)
  has_carnet: boolean;                // Carnet arrangement fee (575) present — we supply a carnet
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
  // Studio-sitter detection intelligence (rooms + flavour + sitter-needed
  // evenings). Populated in deriveRequirementsForJob (needs job dates), NOT in
  // deriveFlags (item-only). Optional — absent on item-only deriveFlags calls.
  rehearsal_detail?: RehearsalDetail | null;
}

// ── Derive flags from line items ─────────────────────────────────────────

export function deriveFlags(items: HHLineItem[], slotModes: VehicleSlotModes = {}): DerivedFlags {
  const flags: DerivedFlags = {
    has_vehicle: false,
    vehicle_count: 0,
    vehicle_types: [],
    vehicle_slots: [],
    self_drive_count: 0,
    van_and_driver_count: 0,
    seat_config: null,
    ve103b_required: false,
    vans_going_abroad: 0,
    has_carnet: false,
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
      const qty = Math.max(1, item.QUANTITY);
      flags.has_vehicle = true;
      flags.vehicle_count += qty;
      flags.vehicle_types.push(item.ITEM_NAME);
      flags.prep_time_by_category.vehicles += prepMins * qty;
      // Expand into per-slot entries with mode from override map.
      const lineKey = String(item.ITEM_ID);
      const modes = slotModes[lineKey] || [];
      for (let slotIndex = 0; slotIndex < qty; slotIndex++) {
        const mode: VehicleSlotMode = modes[slotIndex] || 'self_drive';
        flags.vehicle_slots.push({
          item_id: item.ITEM_ID,
          slot_index: slotIndex,
          item_name: item.ITEM_NAME,
          mode,
        });
        if (mode === 'self_drive') flags.self_drive_count++;
        else flags.van_and_driver_count++;
      }
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
    // Count physical items (non-virtual) for item count.
    // But include ALL items (including virtual parents) for prep time,
    // since preptimemins is often set on the stock type (virtual parent) not individual children.
    // ── VE103B certificate (stock item 1023) → vehicle going abroad ──
    if (item.LIST_ID === VE103B_CERT_LIST_ID && item.kind !== 0) {
      flags.ve103b_required = true;
      flags.vans_going_abroad += Math.max(1, item.QUANTITY);
    }

    // ── Carnet arrangement fee (sale item 575) → we're supplying a carnet ──
    if (item.LIST_ID === CARNET_ARRANGEMENT_LIST_ID && item.CATEGORY_ID === MISC_SALE_CATEGORY && item.kind !== 0) {
      flags.has_carnet = true;
    }

    if (BACKLINE_CATEGORIES.includes(item.CATEGORY_ID) && item.kind === 2) {
      if (!item.VIRTUAL) {
        flags.has_backline = true;
        flags.backline_item_count++;
      }
      // Prep time from both virtual parents and physical items
      if (prepMins > 0) {
        flags.has_backline = true;
        flags.prep_time_by_category.backline += prepMins * Math.max(1, item.QUANTITY);
      }
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
    // Include virtual items here — preptimemins is often on the parent stock type
    if (item.kind !== 0 && prepMins > 0) {
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

  // Load job with line items. Rehearsal date columns are extracted in
  // Europe/London so the finish-on-the-day rule (see rehearsal-plan.ts) keys off
  // the real local hour regardless of server timezone.
  const jobResult = await query(
    `SELECT id, hh_job_number, client_name, line_items, hh_derived_flags, is_van_and_driver, vehicle_slot_modes, is_internal, self_drive_van_override,
       (COALESCE(job_date, out_date) AT TIME ZONE 'Europe/London')::date::text AS reh_start_date,
       (COALESCE(job_end, return_date) AT TIME ZONE 'Europe/London')::date::text AS reh_end_date,
       EXTRACT(HOUR FROM (COALESCE(job_end, return_date) AT TIME ZONE 'Europe/London'))::int AS reh_end_hour
     FROM jobs WHERE id = $1 AND is_deleted = false`,
    [jobId]
  );

  if (jobResult.rows.length === 0) return result;
  const job = jobResult.rows[0];
  const items: HHLineItem[] = job.line_items || [];
  // Internal jobs (garage visits, MOTs, our own vehicle movements booked in HH
  // to keep stock accurate) suppress the client-facing chain: hire forms,
  // excess, and money close-out. Vehicle/backline/crew stay live.
  const isInternal = job.is_internal === true;

  if (items.length === 0) return result;

  // Derive flags — per-slot modes override the legacy job-level flag.
  // If `vehicle_slot_modes` is empty but `is_van_and_driver=true`, fall back to
  // marking every slot as van_and_driver (safety net for pre-migration data).
  const slotModes: VehicleSlotModes = job.vehicle_slot_modes || {};
  const flags = deriveFlags(items, slotModes);
  if (Object.keys(slotModes).length === 0 && job.is_van_and_driver === true) {
    for (const slot of flags.vehicle_slots) {
      slot.mode = 'van_and_driver';
    }
    flags.van_and_driver_count = flags.vehicle_slots.length;
    flags.self_drive_count = 0;
  }
  // Sequential-swap override (Option X): when staff have declared the real
  // simultaneous self-drive van count (e.g. HH lists qty-2 but it's one van
  // swapped mid-hire), cap self_drive_count to that. vehicle_slots is left
  // intact so the card still shows both physical vans (with a "treated as N"
  // label) — only the COUNT that drives excess + top-N + additional-driver
  // charge is corrected. The existing excess mismatch logic then either
  // auto-updates an uncollected record or flags one with money taken.
  if (job.self_drive_van_override !== null && job.self_drive_van_override !== undefined) {
    const ov = Number(job.self_drive_van_override);
    if (Number.isFinite(ov) && ov >= 0) {
      flags.self_drive_count = Math.min(ov, flags.self_drive_count);
    }
  }
  // ── Rehearsal detection intelligence (Phase A) ──
  // Needs job dates, so computed here rather than in the item-only deriveFlags().
  // Attaching to `flags` persists it in hh_derived_flags and surfaces it on the
  // requirement card via the derived-flags read. See services/rehearsal-plan.ts.
  if (flags.has_rehearsal) {
    flags.rehearsal_detail = computeRehearsalDetail(items, {
      startDate: job.reh_start_date ?? null,
      endDate: job.reh_end_date ?? null,
      endHour: job.reh_end_hour ?? null,
    });
  } else {
    flags.rehearsal_detail = null;
  }
  result.flags = flags;

  const previousFlags: DerivedFlags | null = job.hh_derived_flags;
  const hasAnySelfDrive = flags.self_drive_count > 0;

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

    // ── Hire forms (only if ≥1 self-drive van, never on internal jobs) ──
    if (flags.has_vehicle && hasAnySelfDrive && !isInternal) {
      await upsertAutoRequirement(client, jobId, 'hire_forms', flags, previousFlags, result, {
        notes: `${flags.self_drive_count} self-drive vehicle(s) — hire forms required`,
        snapshot: items.filter(i => i.CATEGORY_ID === VEHICLE_CATEGORY && i.kind === 2),
      });
      // Restore if previously suspended by V&D / Internal toggle
      await restoreSuspendedRequirement(client, jobId, 'hire_forms');
    } else if (flags.has_vehicle) {
      // Every vehicle slot is van_and_driver OR job is internal — soft-suspend hire_forms
      await suspendRequirement(client, jobId, 'hire_forms', isInternal ? 'Internal' : 'Van & Driver');
    }

    // ── Insurance excess (only if ≥1 self-drive van, never on internal jobs) ──
    if (flags.has_vehicle && hasAnySelfDrive && !isInternal) {
      await upsertAutoRequirement(client, jobId, 'excess', flags, previousFlags, result, {
        notes: `Insurance excess: £${(flags.self_drive_count * 1200).toLocaleString()} (${flags.self_drive_count} self-drive vehicle(s) × £1,200)`,
        snapshot: null,
      });
      await restoreSuspendedRequirement(client, jobId, 'excess');
      // Restore any suspended (V&D / Internal) job_excess record so the
      // existing updatableExcess query below picks it up and recomputes the
      // required amount based on the (possibly partial) self-drive count.
      await restoreJobExcessFromSuspension(client, jobId);

      // Ensure a job_excess record exists with the standard rate (£1,200 per self-drive van).
      // This gives the Money tab and payment portal something to work with before hire forms are submitted.
      // Only creates if no job_excess records exist yet — doesn't overwrite portal payments or hire form data.
      const STANDARD_EXCESS_PER_VAN = 1200;
      const expectedExcess = flags.self_drive_count * STANDARD_EXCESS_PER_VAN;
      const existingExcess = await client.query(
        `SELECT id FROM job_excess WHERE job_id = $1 LIMIT 1`,
        [jobId]
      );
      if (existingExcess.rows.length === 0) {
        // Migration 100: pair the new excess record to the client's Xero
        // contact directly when known, so it lands in the correct ledger
        // bucket from the start (instead of falling into the name-based
        // workaround bucket added by migration 063).
        const xeroLookup = await client.query(
          `SELECT o.xero_contact_id
           FROM jobs j
           LEFT JOIN organisations o ON o.id = j.client_id
           WHERE j.id = $1`,
          [jobId]
        );
        const xeroContactId = xeroLookup.rows[0]?.xero_contact_id || null;
        await client.query(
          `INSERT INTO job_excess (
            job_id, hirehop_job_id, excess_amount_required, excess_status,
            excess_calculation_basis, client_name, xero_contact_id, notes, created_by
          ) VALUES ($1, $2, $3, 'needed', $4, $5, $6, $7, $8)`,
          [
            jobId,
            job.hh_job_number,
            expectedExcess,
            `Standard £${STANDARD_EXCESS_PER_VAN.toLocaleString()} × ${flags.self_drive_count} self-drive vehicle(s)`,
            // Populate client_name so the ledger view can group this record
            // under the real client (via the 'name:' prefix added in migration
            // 063) when xero_contact_id isn't available. With migration 100
            // landing, xero_contact_id is preferred when set.
            job.client_name || null,
            xeroContactId,
            `Auto-created: ${flags.self_drive_count} self-drive vehicle(s) detected`,
            '00000000-0000-0000-0000-000000000000',
          ]
        );
        result.requirementsCreated.push(`excess_record (£${expectedExcess.toLocaleString()} for ${flags.self_drive_count} self-drive vehicle(s))`);
      } else {
        // Record exists — check if vehicle count changed and update required amount
        // Safe to update: needed, pending, pre_auth (no real money moved — pre_auth is just a hold)
        // Flag only: taken, partially_paid (real money has changed hands)
        const updatableExcess = await client.query(
          `SELECT id, excess_amount_required, excess_amount_taken, excess_status, assignment_id
           FROM job_excess WHERE job_id = $1 AND assignment_id IS NULL
             AND excess_status IN ('needed', 'pending', 'pre_auth')
           LIMIT 1`,
          [jobId]
        );
        if (updatableExcess.rows.length > 0) {
          const curr = updatableExcess.rows[0];
          const currRequired = parseFloat(curr.excess_amount_required || 0);
          if (currRequired !== expectedExcess) {
            await client.query(
              `UPDATE job_excess SET
                excess_amount_required = $1,
                excess_calculation_basis = $2,
                updated_at = NOW()
              WHERE id = $3`,
              [
                expectedExcess,
                `Standard £${STANDARD_EXCESS_PER_VAN.toLocaleString()} × ${flags.self_drive_count} self-drive vehicle(s)`,
                curr.id,
              ]
            );
            result.requirementsUpdated.push(`excess_record (£${currRequired} → £${expectedExcess})`);
          }
        } else {
          // Check for actually-charged records where van count changed — flag mismatch only
          const chargedExcess = await client.query(
            `SELECT id, excess_amount_required, excess_status
             FROM job_excess WHERE job_id = $1 AND assignment_id IS NULL
               AND excess_status IN ('taken', 'partially_paid')
             LIMIT 1`,
            [jobId]
          );
          if (chargedExcess.rows.length > 0) {
            const charged = chargedExcess.rows[0];
            const chargedRequired = parseFloat(charged.excess_amount_required || 0);
            if (chargedRequired !== expectedExcess) {
              await client.query(
                `UPDATE job_excess SET
                  notes = COALESCE(notes, '') || E'\n⚠️ Self-drive van count changed: now ${flags.self_drive_count} van(s) = £${expectedExcess}, but £' || excess_amount_required::TEXT || ' already charged. Review required.',
                  updated_at = NOW()
                WHERE id = $1`,
                [charged.id]
              );
              result.mismatchesFlagged.push(`excess_record (charged £${chargedRequired} but now ${flags.self_drive_count} self-drive van(s) = £${expectedExcess})`);
            }
          }
        }
      }

      // Promote the excess requirement to 'done' if coverage is already met
      // (e.g. derivation runs after a portal pre-auth has landed).
      await syncExcessRequirementStatus(jobId, client);
    } else if (flags.has_vehicle) {
      // All vehicle slots are van_and_driver OR job is internal — suspend the
      // excess requirement AND cascade-waive the derivation-created job_excess
      // record so the Money tab and ExcessGateBanner stop surfacing a
      // fictional outstanding amount. Records with money attached are skipped
      // inside the helper — staff handles those manually.
      const reason = isInternal ? 'Internal' : 'Van & Driver';
      await suspendRequirement(client, jobId, 'excess', reason);
      await suspendJobExcess(client, jobId, reason);
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
        notes: buildRehearsalSummary(flags.rehearsal_detail ?? null),
        snapshot: items.filter(i => i.CATEGORY_ID === REHEARSAL_CATEGORY),
      });
    }

    // ── Carnet (sale item 575 — we supply a carnet) ──
    if (flags.has_carnet) {
      await upsertAutoRequirement(client, jobId, 'carnet', flags, previousFlags, result, {
        notes: 'ATA Carnet arrangement detected from HireHop — we supply',
        snapshot: items.filter(i => i.LIST_ID === CARNET_ARRANGEMENT_LIST_ID && i.CATEGORY_ID === MISC_SALE_CATEGORY && i.kind !== 0),
      });

      // Ensure a job_carnets record exists (we_supply mode). Like the job_excess
      // auto-create: only inserts if none exists, never clobbers staff progress.
      // The unique-live index means a 'cancelled' row won't block a fresh one.
      const existingCarnet = await client.query(
        `SELECT id FROM job_carnets WHERE job_id = $1 AND status <> 'cancelled' LIMIT 1`,
        [jobId]
      );
      if (existingCarnet.rows.length === 0) {
        await client.query(
          `INSERT INTO job_carnets (job_id, mode, status, notes, created_by)
           VALUES ($1, 'we_supply', 'detected', $2, $3)`,
          [
            jobId,
            'Auto-created: carnet arrangement fee (item 575) detected on HireHop',
            '00000000-0000-0000-0000-000000000000',
          ]
        );
        result.requirementsCreated.push('carnet_record');
      }
    } else {
      // Carnet no longer detected on HH (or never really was — see the asset/sale
      // ID-collision note on the detection constant). Remove an UNTOUCHED
      // auto-created record so false positives self-heal on the next sync.
      // Mirrors the requirement stale-cleanup below (which deletes not_started
      // auto requirements). Anything a human has touched (status moved off
      // 'detected', client form back, application ref, or a lead name entered)
      // is left intact for manual review.
      const wiped = await client.query(
        `DELETE FROM job_carnets
         WHERE job_id = $1 AND mode = 'we_supply' AND status = 'detected'
           AND form_submitted_at IS NULL AND application_ref IS NULL AND lead_name IS NULL
           AND NOT EXISTS (SELECT 1 FROM carnet_gmrs g WHERE g.carnet_id = job_carnets.id)
         RETURNING id`,
        [jobId]
      );
      if (wiped.rows.length > 0) {
        result.requirementsUpdated.push('carnet_record (removed — not on HH)');
      }
    }

    // ── Clean up stale requirements ──
    // If HH doesn't have items for a requirement type that was auto-created,
    // remove it (if not_started) or flag it (if staff has acted on it).
    const DETECTABLE_TYPES = ['vehicle', 'hire_forms', 'excess', 'backline', 'rehearsal', 'carnet'];
    const activeTypes = new Set<string>();
    if (flags.has_vehicle) { activeTypes.add('vehicle'); }
    if (flags.has_vehicle && hasAnySelfDrive && !isInternal) { activeTypes.add('hire_forms'); activeTypes.add('excess'); }
    if (flags.has_backline) { activeTypes.add('backline'); }
    if (flags.has_rehearsal) { activeTypes.add('rehearsal'); }
    if (flags.has_carnet) { activeTypes.add('carnet'); }

    // Every vehicle slot is van_and_driver (or job is internal) —
    // hire_forms/excess are suspended, not stale
    const hireChainSuppressed = flags.has_vehicle && (!hasAnySelfDrive || isInternal);

    for (const reqType of DETECTABLE_TYPES) {
      if (activeTypes.has(reqType)) continue; // Still on HH — skip
      if (hireChainSuppressed && (reqType === 'hire_forms' || reqType === 'excess')) continue;
      // Check if an auto pre_hire requirement exists for this type
      const existing = await client.query(
        `SELECT id, is_auto, status FROM job_requirements
         WHERE job_id = $1 AND requirement_type = $2 AND phase = 'pre_hire'`,
        [jobId, reqType]
      );
      if (existing.rows.length === 0) continue;
      const req = existing.rows[0];
      if (!req.is_auto) {
        // Manually created — flag as "not on HH" but don't delete
        await client.query(
          `UPDATE job_requirements SET hh_mismatch = true,
             hh_mismatch_detail = 'Not detected on HireHop — may need removing',
             updated_at = NOW()
           WHERE id = $1`,
          [req.id]
        );
        result.mismatchesFlagged.push(`${reqType} (not on HH)`);
      } else if (req.status === 'not_started') {
        // Auto-created and untouched — safe to remove
        await client.query(
          `DELETE FROM job_requirements WHERE id = $1`,
          [req.id]
        );
        result.requirementsUpdated.push(`${reqType} (removed — no longer on HH)`);
      } else {
        // Auto-created but staff has acted — flag rather than delete
        await client.query(
          `UPDATE job_requirements SET hh_mismatch = true,
             hh_mismatch_detail = 'Item removed from HireHop since this was marked "${req.status}"',
             updated_at = NOW()
           WHERE id = $1`,
          [req.id]
        );
        result.mismatchesFlagged.push(`${reqType} (removed from HH)`);
      }
    }

    // ── Save derived flags for next comparison ──
    await client.query(
      `UPDATE jobs SET hh_derived_flags = $1,
         is_van_and_driver = $2
       WHERE id = $3`,
      [
        JSON.stringify(flags),
        // Keep the legacy boolean in sync: true iff every vehicle slot is van_and_driver
        flags.has_vehicle && flags.self_drive_count === 0,
        jobId,
      ]
    );

    // ── Auto-generate post-hire requirements ──
    // Gate on OP pipeline_status, not HH status. HH jumps to 4/5 the moment
    // items get checked out, but OP holds at 'prepped' until staff explicitly
    // mark the job dispatched. Creating post-hire rows earlier surfaces them
    // on the Job Requirements toggle before staff are meant to be working
    // post-hire — they end up ticking the wrong card. Keeps frontend toggle
    // default and backend creation in lockstep on the same OP gate.
    const jobStatus = await client.query(
      `SELECT status, pipeline_status, hh_job_number, job_date, out_date, job_end, return_date FROM jobs WHERE id = $1`,
      [jobId]
    );
    const hhStatus = jobStatus.rows[0]?.status;
    const hhJobNumber = jobStatus.rows[0]?.hh_job_number;
    const jobRow = jobStatus.rows[0];
    const opPipelineStatus: string | null = jobStatus.rows[0]?.pipeline_status ?? null;
    const POST_HIRE_OP_STATUSES = ['dispatched', 'returned_incomplete', 'returned', 'completed'];
    const isPostHirePhase = !!opPipelineStatus && POST_HIRE_OP_STATUSES.includes(opPipelineStatus);

    if (isPostHirePhase && flags.has_backline) {
      const existingPostHire = await client.query(
        `SELECT id FROM job_requirements
         WHERE job_id = $1 AND requirement_type = 'backline' AND phase = 'post_hire'`,
        [jobId]
      );
      if (existingPostHire.rows.length === 0) {
        await client.query(
          `INSERT INTO job_requirements (job_id, requirement_type, status, notes, is_auto, source, phase)
           VALUES ($1, 'backline', 'not_started', $2, true, 'auto_post_hire', 'post_hire')`,
          [jobId, `${flags.backline_item_count} item(s) — de-prep required`]
        );
        result.requirementsCreated.push('backline (post_hire)');
      }
    }

    // Similarly for vehicles — post-hire check-in (only if any self-drive vans)
    if (isPostHirePhase && flags.has_vehicle && hasAnySelfDrive) {
      const existingPostVehicle = await client.query(
        `SELECT id FROM job_requirements
         WHERE job_id = $1 AND requirement_type = 'vehicle' AND phase = 'post_hire'`,
        [jobId]
      );
      if (existingPostVehicle.rows.length === 0) {
        await client.query(
          `INSERT INTO job_requirements (job_id, requirement_type, status, notes, is_auto, source, phase)
           VALUES ($1, 'vehicle', 'not_started', $2, true, 'auto_post_hire', 'post_hire')`,
          [jobId, `${flags.vehicle_count} vehicle(s) — check-in required`]
        );
        result.requirementsCreated.push('vehicle (post_hire)');
      }
    }

    // ── Auto-generate close-out requirements when job reaches return status ──
    // HH status 6=Returned Incomplete, 7=Returned, 8=Requires Attention, 11=Completed
    const isReturnPhase = hhStatus >= 6 && hhStatus !== 9 && hhStatus !== 10; // exclude cancelled/not interested
    // HH status 7+ means everything is physically back (Returned, Requires Attention, Completed)
    const isFullyReturned = hhStatus >= 7 && hhStatus !== 9 && hhStatus !== 10;

    if (isReturnPhase) {
      // Helper: create a post_hire requirement if it doesn't exist yet
      const ensureCloseout = async (type: string, notes: string) => {
        const exists = await client.query(
          `SELECT id FROM job_requirements WHERE job_id = $1 AND requirement_type = $2 AND phase = 'post_hire'`,
          [jobId, type]
        );
        if (exists.rows.length === 0) {
          await client.query(
            `INSERT INTO job_requirements (job_id, requirement_type, status, notes, is_auto, source, phase)
             VALUES ($1, $2, 'not_started', $3, true, 'auto_post_hire', 'post_hire')`,
            [jobId, type, notes]
          );
          result.requirementsCreated.push(`${type} (post_hire)`);
        }
      };

      // Always create: invoice, payment reconciliation, client follow-up.
      // EXCEPT on internal jobs — there's no client to invoice, chase or
      // follow up (the "client" is a garage / ourselves).
      if (!isInternal) {
        await ensureCloseout('invoice', 'Check HireHop for invoice status');
        await ensureCloseout('payment_reconcile', 'Verify all payments received and balance is zero');
        await ensureCloseout('client_followup', 'Follow up with client post-hire');
      }

      // Conditional: excess resolution — only if job has excess records
      // (skipped on internal jobs — any derivation-created record is waived)
      if (!isInternal) {
        const excessCount = await client.query(
          `SELECT COUNT(*) AS cnt FROM job_excess WHERE job_id = $1`,
          [jobId]
        );
        if (parseInt(excessCount.rows[0]?.cnt || '0') > 0) {
          await ensureCloseout('excess_resolve', 'Resolve all insurance excess (reimburse, claim, or waive)');
        }
      }

      // Conditional: cost recharge resolution — only if the job has any cost
      // flagged for client recharge. Skipped on internal jobs (no client to bill).
      if (!isInternal) {
        const rechargeCount = await client.query(
          `SELECT COUNT(*) AS cnt FROM costs WHERE job_id = $1 AND recharge_mode <> 'none'`,
          [jobId]
        );
        if (parseInt(rechargeCount.rows[0]?.cnt || '0') > 0) {
          await ensureCloseout('cost_resolve', 'Resolve all client recharges (bill to HireHop, bill externally, or absorb)');
        }

        // Standing "recharge running costs" card — forward-looking, on jobs
        // declared to recharge their running costs (a quote recharge line or the
        // Tools toggle). Created amber regardless of whether costs have landed
        // yet (the whole point: it says "expect the freelancer's fuel/parking
        // invoice, recharge it"). Manual close via "no further costs".
        const rrc = await client.query(
          `SELECT recharge_running_costs FROM jobs WHERE id = $1`,
          [jobId]
        );
        if (rrc.rows[0]?.recharge_running_costs) {
          const exists = await client.query(
            `SELECT id FROM job_requirements WHERE job_id = $1 AND requirement_type = 'recharge_running_costs' AND phase = 'post_hire'`,
            [jobId]
          );
          if (exists.rows.length === 0) {
            await client.query(
              `INSERT INTO job_requirements (job_id, requirement_type, status, notes, is_auto, source, phase)
               VALUES ($1, 'recharge_running_costs', 'in_progress', $2, true, 'auto_post_hire', 'post_hire')`,
              [jobId, 'Running costs recharged at actual + 20%. Log the freelancer/supplier invoices as they land, recharge each to the client, then mark done when no further costs are expected.']
            );
            result.requirementsCreated.push('recharge_running_costs (post_hire)');
          }
        }
      }

      // Conditional: freelancer follow-up — only if crew assignments exist
      const crewCount = await client.query(
        `SELECT COUNT(*) AS cnt FROM quote_assignments qa
         JOIN quotes q ON q.id = qa.quote_id
         WHERE q.job_id = $1 AND qa.status != 'cancelled'`,
        [jobId]
      );
      if (parseInt(crewCount.rows[0]?.cnt || '0') > 0) {
        await ensureCloseout('freelancer_followup', 'Check in with freelancers — expenses, feedback, issues');
      }

      // Conditional: damage review — only if any vehicle assignment has has_damage=true
      const damageCount = await client.query(
        `SELECT COUNT(*) AS cnt FROM vehicle_hire_assignments
         WHERE job_id = $1 AND has_damage = true`,
        [jobId]
      );
      if (parseInt(damageCount.rows[0]?.cnt || '0') > 0) {
        await ensureCloseout('damage_review', 'Vehicle damage flagged during hire — review and resolve');
      }

      // ── Auto-resolve statuses from real data sources ──
      // Only auto-advance — never regress a status that staff has already progressed

      // Helper: auto-resolve a requirement to 'done' if it's still 'not_started'
      const autoResolve = async (type: string, newStatus: string) => {
        await client.query(
          `UPDATE job_requirements
           SET status = $3, updated_at = NOW()
           WHERE job_id = $1 AND requirement_type = $2 AND phase = 'post_hire'
             AND status = 'not_started'`,
          [jobId, type, newStatus]
        );
      };

      // Vehicle check-in + backline de-prep: if HH says fully returned (status >= 7), auto-done
      if (isFullyReturned) {
        await autoResolve('vehicle', 'done');
        await autoResolve('backline', 'done');
      }

      // Excess resolution: resolution-authoritative via the shared helper
      // (now that the post_hire excess_resolve card is created above). Sets
      // 'done' when every excess record is terminal-resolved, else amber
      // 'in_progress' — including demoting a card staff marked Resolved while
      // money's still in limbo. Replaces the old forward-only autoResolve.
      await syncExcessRequirementStatus(jobId, client);
      // Same treatment for the cost_resolve card — green only when every
      // recharge-flagged cost on the job is resolved (pushed/external/absorbed).
      await syncCostResolveRequirementStatus(jobId, client);

      // Client follow-up: check if any interaction exists after return_date
      const postReturnInteraction = await client.query(
        `SELECT 1 FROM interactions i
         JOIN jobs j ON j.id = i.job_id
         WHERE i.job_id = $1
           AND j.return_date IS NOT NULL
           AND i.created_at > j.return_date
           AND i.type IN ('note', 'call', 'email', 'meeting')
         LIMIT 1`,
        [jobId]
      );
      if (postReturnInteraction.rows.length > 0) {
        await autoResolve('client_followup', 'done');
      }

      // Invoice + payment reconciliation: read HH billing for live status.
      // - invoice → in_progress ("Generated") when any non-proforma invoice exists
      // - payment_reconcile → done ("Reconciled") when total OWING (less any VAT
      //   relief the OP knows about but HH doesn't) is ≤ £0.01
      // Only fires while requirement is still 'not_started' (autoResolve gates on that),
      // so staff progress is never regressed. Wrapped in try/catch so a flaky HH call
      // doesn't blow up the whole derivation transaction.
      // Skipped on internal jobs — the invoice/payment_reconcile cards don't
      // exist there, so the HH billing fetch would be a wasted broker call.
      if (hhJobNumber && !isInternal) {
        try {
          const billingRes = await hhBroker.get(
            '/php_functions/billing_list.php',
            { main_id: hhJobNumber, type: 1 },
            { priority: 'low', cacheTTL: 300 }
          );
          if (billingRes.success && billingRes.data) {
            const bl = billingRes.data as Record<string, any>;
            if (Array.isArray(bl.rows)) {
              let hasInvoice = false;
              let totalOwing = 0;
              for (const row of bl.rows) {
                const kind = parseInt(row.kind ?? '0');
                if (kind !== 1) continue;
                const data = row.data || row;
                const invoiceStatus = parseInt(data.STATUS || data.status || '0');
                const isProforma = invoiceStatus === 0;
                const invoiceDesc = String(data.DESCRIPTION || row.desc || '');
                if (isProforma || invoiceDesc.toLowerCase().includes('proforma')) continue;
                hasInvoice = true;
                totalOwing += parseFloat(data.OWING || data.owing || row.owing || '0');
              }
              if (hasInvoice) {
                await autoResolve('invoice', 'in_progress');

                // Subtract VAT relief the OP knows about but HH doesn't. When a
                // client pays the OP's adjusted total via the portal, HH still
                // shows OWING == vatSaved — without this, international jobs
                // would never auto-reconcile. Returns null for non-international
                // jobs (early exit, no extra HH calls), so vatSaved defaults to 0.
                let vatSaved = 0;
                const startDate = jobRow?.job_date || jobRow?.out_date;
                const endDate = jobRow?.job_end || jobRow?.return_date;
                if (startDate && endDate) {
                  const hireDays = Math.max(1, Math.ceil(
                    (new Date(endDate).getTime() - new Date(startDate).getTime()) / (1000 * 60 * 60 * 24)
                  ));
                  try {
                    const vatAdj = await calculateVatAdjustment(hhJobNumber, hireDays);
                    if (vatAdj) vatSaved = vatAdj.vatSaved;
                  } catch (vatErr) {
                    console.warn(`[HH Derive] VAT adjustment lookup failed for job ${jobId}:`, vatErr);
                  }
                }

                if (totalOwing - vatSaved <= 0.01) {
                  await autoResolve('payment_reconcile', 'done');
                }
              }
            }
          }
        } catch (billingErr) {
          console.warn(`[HH Derive] Billing check failed for job ${jobId}:`, billingErr);
        }
      }
    }

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

  // ── Wind the rehearsal requirement status from sitter coverage ──
  // Coverage-authoritative: adding/removing a sitter-needed evening re-derives
  // the status (e.g. a new date winds 'done' back to 'in_progress'). Best-effort.
  if (flags.has_rehearsal) {
    try { await syncRehearsalRequirementStatus(jobId); } catch (err) {
      console.error(`[HH Derive] rehearsal status sync failed for job ${jobId}:`, err);
    }
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
  // Check if requirement already exists (pre_hire phase only — derivation creates pre-hire)
  const existing = await client.query(
    `SELECT id, is_auto, status, hh_item_snapshot, notes, hh_mismatch
     FROM job_requirements
     WHERE job_id = $1 AND requirement_type = $2 AND phase = 'pre_hire'`,
    [jobId, requirementType]
  );

  if (existing.rows.length === 0) {
    // Create new auto requirement (pre_hire phase)
    const insertResult = await client.query(
      `INSERT INTO job_requirements (job_id, requirement_type, status, notes, is_auto, source, hh_item_snapshot, phase)
       VALUES ($1, $2, 'not_started', $3, true, 'hirehop_sync', $4, 'pre_hire')
       RETURNING id`,
      [jobId, requirementType, data.notes, data.snapshot ? JSON.stringify(data.snapshot) : null]
    );
    if (insertResult.rows.length > 0) {
      result.requirementsCreated.push(requirementType);
    }
    return;
  }

  const req = existing.rows[0];

  // For manually-created requirements: don't update notes/snapshot,
  // but DO clear mismatch flag if this type is now detected on HireHop.
  // This fixes the case where a requirement created via the enquiry form
  // gets flagged "Not detected on HireHop" during a sync where items were
  // temporarily unavailable, and the flag is never cleared on later syncs.
  if (!req.is_auto) {
    if (req.hh_mismatch) {
      await client.query(
        `UPDATE job_requirements SET hh_mismatch = false,
           hh_mismatch_detail = NULL, updated_at = NOW()
         WHERE id = $1`,
        [req.id]
      );
    }
    return;
  }

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

  // Status is still 'not_started' — safe to update snapshot.
  // Only overwrite notes if they haven't been enriched by user actions (e.g. hire form sends)
  const hasUserNotes = req.notes && (
    req.notes.includes('Hire form email sent') ||
    req.notes.includes('Hire form reminder sent') ||
    req.notes.includes('[Suspended:')
  );
  if (hasUserNotes) {
    await client.query(
      `UPDATE job_requirements SET hh_item_snapshot = $1,
         hh_mismatch = false, hh_mismatch_detail = NULL, updated_at = NOW()
       WHERE id = $2`,
      [data.snapshot ? JSON.stringify(data.snapshot) : null, req.id]
    );
  } else {
    await client.query(
      `UPDATE job_requirements SET notes = $1, hh_item_snapshot = $2,
         hh_mismatch = false, hh_mismatch_detail = NULL, updated_at = NOW()
       WHERE id = $3`,
      [data.notes, data.snapshot ? JSON.stringify(data.snapshot) : null, req.id]
    );
  }
  result.requirementsUpdated.push(requirementType);
}

/**
 * Soft-suspend a requirement when switching to Van & Driver or marking a job
 * as internal. Instead of deleting, marks it as suspended so data persists
 * and can be restored if the toggle was accidental.
 */
type SuspensionReason = 'Van & Driver' | 'Internal';

async function suspendRequirement(client: any, jobId: string, requirementType: string, reason: SuspensionReason): Promise<void> {
  // Suspend the pre_hire requirement of this type regardless of how it was
  // created. Only ever called for hire_forms / excess, both of which are fully
  // V&D-/Internal-governed — when the job is wholly Van & Driver (or internal)
  // they aren't needed no matter their origin. NB: the enquiry-form
  // "Self-drive van" quick-select inserts these with is_auto=false (column
  // default), so filtering on is_auto=true here silently skipped them and left
  // the hire-form/excess chain live on V&D jobs.
  const existing = await client.query(
    `SELECT id, status, notes FROM job_requirements
     WHERE job_id = $1 AND requirement_type = $2 AND phase = 'pre_hire'
       AND status NOT IN ('cancelled', 'done')`,
    [jobId, requirementType]
  );
  if (existing.rows.length === 0) return;
  const req = existing.rows[0];
  // Already suspended (either reason) — don't overwrite
  if (req.notes?.includes('[Suspended:')) return;

  // Preserve the previous status in notes so we can restore it
  const prevStatusNote = `[Suspended: ${reason}] Previous status: ${req.status}`;
  const updatedNotes = req.notes
    ? `${req.notes}\n${prevStatusNote}`
    : prevStatusNote;

  await client.query(
    `UPDATE job_requirements SET status = 'blocked',
       notes = $1, updated_at = NOW()
     WHERE id = $2`,
    [updatedNotes, req.id]
  );
}

/**
 * Suspend the derivation-created job-level excess record when every vehicle
 * slot is V&D or the job is internal — Option A cascade. Sets
 * `excess_status='waived'` and zeros `excess_amount_required` so
 * dispatch-check, the gate banner, and the Money tab all naturally treat the
 * record as resolved (waived is in every terminal-status whitelist). Tags
 * `notes` with `[Suspended: <reason>]` so we can identify and restore on
 * toggle-back. Only acts on records with NO money attached
 * (`amount_taken=0`, status `needed`/`pending`); records holding payments or
 * pre-auth holds are left alone — staff resolves those manually because real
 * money has moved (or is held).
 */
async function suspendJobExcess(client: any, jobId: string, reason: SuspensionReason): Promise<void> {
  await client.query(
    `UPDATE job_excess
     SET excess_status = 'waived',
         excess_amount_required = 0,
         notes = COALESCE(NULLIF(notes, '') || E'\n', '') || $2,
         updated_at = NOW()
     WHERE job_id = $1
       AND assignment_id IS NULL
       AND COALESCE(excess_amount_taken, 0) = 0
       AND excess_status IN ('needed', 'pending')
       AND (notes IS NULL OR notes NOT LIKE '%[Suspended:%')`,
    [jobId, `[Suspended: ${reason}]`]
  );
}

/**
 * Restore a job_excess record that was suspended (V&D or Internal). Flips
 * status back to `needed` and strips the marker; the existing updatableExcess
 * logic in the SDH branch then sees a `needed` record with stale (zeroed)
 * required amount and recomputes it via the standard £1,200 ×
 * self_drive_count path. Marker-gated so we never touch records that were
 * genuinely staff-waived.
 */
async function restoreJobExcessFromSuspension(client: any, jobId: string): Promise<void> {
  await client.query(
    `UPDATE job_excess
     SET excess_status = 'needed',
         notes = NULLIF(TRIM(BOTH E'\n ' FROM
           REPLACE(REPLACE(COALESCE(notes, ''), '[Suspended: Van & Driver]', ''), '[Suspended: Internal]', '')), ''),
         updated_at = NOW()
     WHERE job_id = $1
       AND assignment_id IS NULL
       AND (notes LIKE '%[Suspended: Van & Driver]%' OR notes LIKE '%[Suspended: Internal]%')
       AND COALESCE(excess_amount_taken, 0) = 0`,
    [jobId]
  );
}

/**
 * Restore a requirement that was suspended by the Van & Driver or Internal
 * toggle. Puts it back to its previous status.
 */
async function restoreSuspendedRequirement(client: any, jobId: string, requirementType: string): Promise<void> {
  // Mirror suspendRequirement: marker-gated, origin-agnostic (no is_auto filter)
  // so a manually-created (enquiry-form) hire_forms/excess requirement that was
  // suspended on V&D gets restored when the job flips back to self-drive.
  const existing = await client.query(
    `SELECT id, notes FROM job_requirements
     WHERE job_id = $1 AND requirement_type = $2 AND status = 'blocked' AND phase = 'pre_hire'`,
    [jobId, requirementType]
  );
  if (existing.rows.length === 0) return;
  const req = existing.rows[0];
  if (!req.notes?.includes('[Suspended:')) return;

  // Extract previous status from notes (either suspension reason)
  const match = req.notes.match(/\[Suspended: (?:Van & Driver|Internal)\] Previous status: (\w+)/);
  const restoredStatus = match?.[1] || 'not_started';

  // Remove the suspension note
  const cleanedNotes = req.notes
    .replace(/\n?\[Suspended: (?:Van & Driver|Internal)\] Previous status: \w+/, '')
    .trim() || null;

  await client.query(
    `UPDATE job_requirements SET status = $1,
       notes = $2, updated_at = NOW()
     WHERE id = $3`,
    [restoredStatus, cleanedNotes, req.id]
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

  if (flags.self_drive_count > 0 && flags.van_and_driver_count > 0) {
    parts.push(`${flags.self_drive_count} self-drive, ${flags.van_and_driver_count} van & driver`);
  } else if (flags.van_and_driver_count > 0) {
    parts.push('All van & driver');
  }

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
