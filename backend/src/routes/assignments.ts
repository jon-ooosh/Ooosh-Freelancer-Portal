/**
 * Vehicle Hire Assignment Routes — unified vehicle-to-job assignment management.
 *
 * Replaces R2-backed allocations with a proper database table.
 * Handles soft allocations, confirmed hires, book-out/check-in data,
 * and the dispatch gate check (excess status).
 *
 * Also includes compatibility endpoints that return the old VanAllocation[]
 * shape for the existing frontend allocations page.
 */
import { Router, Response } from 'express';
import { z } from 'zod';
import { query } from '../config/database';
import { authenticate, authorize, AuthRequest } from '../middleware/auth';
import { validate } from '../middleware/validate';
import {
  findOverlappingAssignments,
  buildConflictPayload,
} from '../services/assignment-overlap';
import { syncFleetHireStatus } from '../services/fleet-hire-status-sync';
import { syncVehicleRequirementStatus } from '../services/vehicle-requirement-sync';

const router = Router();
router.use(authenticate);

// ── Schemas ──

const createAssignmentSchema = z.object({
  vehicle_id: z.string().uuid(),
  job_id: z.string().uuid().nullable().optional(),
  hirehop_job_id: z.number().int().nullable().optional(),
  hirehop_job_name: z.string().max(500).nullable().optional(),
  driver_id: z.string().uuid().nullable().optional(),
  assignment_type: z.enum(['self_drive', 'driven', 'delivery', 'collection']).default('self_drive'),
  van_requirement_index: z.number().int().min(0).default(0),
  required_type: z.string().max(50).nullable().optional(),
  required_gearbox: z.string().max(10).nullable().optional(),
  status: z.enum(['soft', 'confirmed', 'booked_out', 'active', 'returned', 'cancelled']).default('soft'),
  hire_start: z.string().nullable().optional(),
  hire_end: z.string().nullable().optional(),
  start_time: z.string().nullable().optional(),
  end_time: z.string().nullable().optional(),
  return_overnight: z.boolean().nullable().optional(),
  freelancer_person_id: z.string().uuid().nullable().optional(),
  notes: z.string().nullable().optional(),
  ve103b_ref: z.string().max(100).nullable().optional(),
  allocated_by_name: z.string().max(200).nullable().optional(),
});

const updateAssignmentSchema = createAssignmentSchema.partial();

const statusTransitionSchema = z.object({
  status: z.enum(['soft', 'confirmed', 'booked_out', 'active', 'returned', 'cancelled']),
  notes: z.string().nullable().optional(),
});

const bookOutSchema = z.object({
  mileage_out: z.number().int().min(0),
  fuel_level_out: z.string().max(20),
  // Optional V&D promotion: when set, the assignment is being booked out as
  // an Ooosh-supplied-driver hire (no customer hire form). The freelancer
  // taking the van is recorded via freelancer_person_id; the gate checks for
  // referral/excess are skipped (assignment_type='driven' branch).
  assignment_type: z.enum(['self_drive', 'driven', 'delivery', 'collection']).optional(),
  freelancer_person_id: z.string().uuid().nullable().optional(),
  hire_start: z.string().nullable().optional(),
  hire_end: z.string().nullable().optional(),
  start_time: z.string().nullable().optional(),
  end_time: z.string().nullable().optional(),
});

const checkInSchema = z.object({
  mileage_in: z.number().int().min(0),
  fuel_level_in: z.string().max(20),
  has_damage: z.boolean().default(false),
});

// ── Helper: base SELECT with joins ──

const BASE_SELECT = `
  SELECT vha.*,
    fv.reg AS vehicle_reg,
    fv.simple_type AS vehicle_type,
    fv.hire_status AS vehicle_hire_status,
    d.full_name AS driver_name,
    d.email AS driver_email,
    d.phone AS driver_phone,
    d.licence_points AS driver_points,
    d.requires_referral AS driver_requires_referral,
    d.referral_status AS driver_referral_status,
    p.first_name || ' ' || p.last_name AS freelancer_name,
    je.id AS excess_id,
    je.excess_status,
    je.excess_amount_required,
    je.excess_amount_taken
  FROM vehicle_hire_assignments vha
  LEFT JOIN fleet_vehicles fv ON fv.id = vha.vehicle_id
  LEFT JOIN drivers d ON d.id = vha.driver_id
  LEFT JOIN people p ON p.id = vha.freelancer_person_id
  LEFT JOIN job_excess je ON je.assignment_id = vha.id
`;

// ── GET /api/assignments — List assignments ──

router.get('/', async (req: AuthRequest, res: Response) => {
  try {
    const {
      job_id, hirehop_job_id, vehicle_id, status, assignment_type,
      hire_start_from, hire_start_to,
      page = '1', limit = '50',
    } = req.query;
    const offset = (parseInt(page as string) - 1) * parseInt(limit as string);
    const pageLimit = parseInt(limit as string);

    let where = 'WHERE 1=1';
    const params: unknown[] = [];

    if (job_id) {
      params.push(job_id);
      where += ` AND vha.job_id = $${params.length}`;
    }
    if (hirehop_job_id) {
      params.push(parseInt(hirehop_job_id as string));
      where += ` AND vha.hirehop_job_id = $${params.length}`;
    }
    if (vehicle_id) {
      params.push(vehicle_id);
      where += ` AND vha.vehicle_id = $${params.length}`;
    }
    if (status) {
      params.push(status);
      where += ` AND vha.status = $${params.length}`;
    }
    if (assignment_type) {
      params.push(assignment_type);
      where += ` AND vha.assignment_type = $${params.length}`;
    }
    if (hire_start_from) {
      params.push(hire_start_from);
      where += ` AND vha.hire_start >= $${params.length}`;
    }
    if (hire_start_to) {
      params.push(hire_start_to);
      where += ` AND vha.hire_start <= $${params.length}`;
    }

    // Exclude cancelled by default unless explicitly requested
    if (!status) {
      where += ` AND vha.status != 'cancelled'`;
    }

    const countResult = await query(
      `SELECT COUNT(*) FROM vehicle_hire_assignments vha ${where}`,
      params
    );
    const total = parseInt(countResult.rows[0].count);

    const dataParams = [...params, pageLimit, offset];
    const result = await query(
      `${BASE_SELECT} ${where}
      ORDER BY vha.hire_start ASC NULLS LAST, vha.created_at DESC
      LIMIT $${dataParams.length - 1} OFFSET $${dataParams.length}`,
      dataParams
    );

    res.json({
      data: result.rows,
      pagination: {
        page: parseInt(page as string),
        limit: pageLimit,
        total,
        totalPages: Math.ceil(total / pageLimit),
      },
    });
  } catch (error) {
    console.error('[assignments] List error:', error);
    res.status(500).json({ error: 'Failed to load assignments' });
  }
});

// ── GET /api/assignments/availability — Find occupied vans for a window ──
//
// Returns one row per occupied vehicle, with its conflicting assignment.
// Used by the Allocations page to grey out / label vans that are already
// committed to another hire over the same date range. The backend is still
// the source of truth (write-path checks will reject a conflict) — this
// endpoint is for UX so staff don't have to discover conflicts by trial.

router.get('/availability', async (req: AuthRequest, res: Response) => {
  try {
    const startParam = (req.query.start || req.query.hire_start) as string | undefined;
    const endParam = (req.query.end || req.query.hire_end) as string | undefined;
    const excludeHhJobId = req.query.exclude_hh_job_id
      ? parseInt(req.query.exclude_hh_job_id as string, 10)
      : null;
    const excludeJobId = (req.query.exclude_job_id as string) || null;

    if (!startParam || !endParam) {
      return res.status(400).json({ error: 'start and end dates required (YYYY-MM-DD)' });
    }

    const result = await query(
      `SELECT DISTINCT ON (vha.vehicle_id)
         vha.vehicle_id,
         vha.id AS assignment_id,
         vha.status,
         vha.job_id,
         vha.hirehop_job_id,
         j.job_name,
         j.hh_job_number,
         COALESCE(vha.hire_start, j.job_date::DATE) AS effective_start,
         COALESCE(vha.hire_end, j.job_end::DATE) AS effective_end,
         d.full_name AS driver_name,
         fv.reg AS vehicle_reg
       FROM vehicle_hire_assignments vha
       LEFT JOIN jobs j ON j.id = vha.job_id
       LEFT JOIN fleet_vehicles fv ON fv.id = vha.vehicle_id
       LEFT JOIN drivers d ON d.id = vha.driver_id
       WHERE vha.status IN ('soft', 'confirmed', 'booked_out', 'active')
         AND vha.vehicle_id IS NOT NULL
         AND ($3::integer IS NULL OR vha.hirehop_job_id IS DISTINCT FROM $3::integer)
         AND ($4::uuid IS NULL OR vha.job_id IS DISTINCT FROM $4::uuid)
         AND COALESCE(vha.hire_start, j.job_date::DATE) <= $2::DATE
         AND COALESCE(vha.hire_end, j.job_end::DATE) >= $1::DATE
       ORDER BY vha.vehicle_id, vha.hire_start DESC NULLS LAST`,
      [startParam, endParam, excludeHhJobId, excludeJobId],
    );

    res.json({
      data: {
        start: startParam,
        end: endParam,
        unavailable: result.rows.map((r: any) => ({
          vehicleId: r.vehicle_id,
          vehicleReg: r.vehicle_reg,
          assignmentId: r.assignment_id,
          status: r.status,
          jobId: r.job_id,
          hirehopJobId: r.hirehop_job_id,
          jobName: r.job_name,
          hhJobNumber: r.hh_job_number,
          effectiveStart: r.effective_start ? new Date(r.effective_start).toISOString().slice(0, 10) : null,
          effectiveEnd: r.effective_end ? new Date(r.effective_end).toISOString().slice(0, 10) : null,
          driverName: r.driver_name,
        })),
      },
    });
  } catch (error) {
    console.error('[assignments] Availability error:', error);
    res.status(500).json({ error: 'Failed to load availability' });
  }
});

// ── GET /api/assignments/:id — Single assignment with driver + excess ──

router.get('/:id', async (req: AuthRequest, res: Response) => {
  try {
    const { id } = req.params;

    const result = await query(
      `${BASE_SELECT} WHERE vha.id = $1`,
      [id]
    );

    if (result.rows.length === 0) {
      res.status(404).json({ error: 'Assignment not found' });
      return;
    }

    // Also fetch any excess record
    const excessResult = await query(
      'SELECT * FROM job_excess WHERE assignment_id = $1',
      [id]
    );

    res.json({
      data: {
        ...result.rows[0],
        excess: excessResult.rows[0] || null,
      },
    });
  } catch (error) {
    console.error('[assignments] Detail error:', error);
    res.status(500).json({ error: 'Failed to load assignment' });
  }
});

// ── POST /api/assignments — Create assignment ──

router.post('/', validate(createAssignmentSchema), async (req: AuthRequest, res: Response) => {
  try {
    const a = req.body;

    // Block if this vehicle is already occupying an overlapping window on a
    // different job. Same-job rows are excluded (multi-driver single-van
    // allocations don't self-conflict). returned/cancelled/swapped rows do
    // not occupy the van.
    const conflicts = await findOverlappingAssignments({
      vehicleId: a.vehicle_id,
      hireStart: a.hire_start,
      hireEnd: a.hire_end,
      jobId: a.job_id || null,
      hirehopJobId: a.hirehop_job_id || null,
    });
    if (conflicts.length > 0) {
      return res.status(409).json(buildConflictPayload(conflicts));
    }

    const result = await query(
      `INSERT INTO vehicle_hire_assignments (
        vehicle_id, job_id, hirehop_job_id, hirehop_job_name,
        driver_id, assignment_type,
        van_requirement_index, required_type, required_gearbox,
        status, status_changed_at,
        hire_start, hire_end, start_time, end_time, return_overnight,
        freelancer_person_id, notes, ve103b_ref,
        created_by, allocated_by_name
      ) VALUES (
        $1, $2, $3, $4,
        $5, $6,
        $7, $8, $9,
        $10, NOW(),
        $11, $12, $13, $14, $15,
        $16, $17, $18,
        $19, $20
      ) RETURNING *`,
      [
        a.vehicle_id, a.job_id || null, a.hirehop_job_id || null, a.hirehop_job_name || null,
        a.driver_id || null, a.assignment_type,
        a.van_requirement_index, a.required_type || null, a.required_gearbox || null,
        a.status,
        a.hire_start || null, a.hire_end || null, a.start_time || null, a.end_time || null, a.return_overnight ?? null,
        a.freelancer_person_id || null, a.notes || null, a.ve103b_ref || null,
        req.user!.id, a.allocated_by_name || null,
      ]
    );

    const assignment = result.rows[0];

    // For self_drive assignments, auto-create a pending excess record
    if (a.assignment_type === 'self_drive') {
      await query(
        `INSERT INTO job_excess (
          assignment_id, job_id, hirehop_job_id, excess_status, created_by
        ) VALUES ($1, $2, $3, 'pending', $4)`,
        [assignment.id, a.job_id || null, a.hirehop_job_id || null, req.user!.id]
      );
    }

    // Recompute pre-hire vehicle requirement now that an assignment with a
    // vehicle exists (or doesn't, if vehicle_id was null — helper handles
    // both cases bidirectionally).
    if (a.job_id) {
      syncVehicleRequirementStatus(a.job_id).catch(err => {
        console.warn(`[assignments] Vehicle requirement sync failed:`, err);
      });
    }

    res.status(201).json({ data: assignment });
  } catch (error) {
    console.error('[assignments] Create error:', error);
    res.status(500).json({ error: 'Failed to create assignment' });
  }
});

// ── PUT /api/assignments/:id — Update assignment ──

router.put('/:id', validate(updateAssignmentSchema), async (req: AuthRequest, res: Response) => {
  try {
    const { id } = req.params;
    const updates = req.body;

    const setClauses: string[] = [];
    const params: unknown[] = [];

    for (const [key, value] of Object.entries(updates)) {
      params.push(value ?? null);
      setClauses.push(`${key} = $${params.length}`);
    }

    if (setClauses.length === 0) {
      res.status(400).json({ error: 'No fields to update' });
      return;
    }

    setClauses.push('updated_at = NOW()');
    params.push(id);

    const result = await query(
      `UPDATE vehicle_hire_assignments SET ${setClauses.join(', ')} WHERE id = $${params.length} RETURNING *`,
      params
    );

    if (result.rows.length === 0) {
      res.status(404).json({ error: 'Assignment not found' });
      return;
    }

    res.json({ data: result.rows[0] });
  } catch (error) {
    console.error('[assignments] Update error:', error);
    res.status(500).json({ error: 'Failed to update assignment' });
  }
});

// ── PATCH /api/assignments/:id/status — Status transition ──

router.patch('/:id/status', validate(statusTransitionSchema), async (req: AuthRequest, res: Response) => {
  try {
    const { id } = req.params;
    const { status, notes } = req.body;

    const result = await query(
      `UPDATE vehicle_hire_assignments
       SET status = $1, status_changed_at = NOW(), notes = COALESCE($2, notes), updated_at = NOW()
       WHERE id = $3
       RETURNING *`,
      [status, notes, id]
    );

    if (result.rows.length === 0) {
      res.status(404).json({ error: 'Assignment not found' });
      return;
    }

    res.json({ data: result.rows[0] });
  } catch (error) {
    console.error('[assignments] Status transition error:', error);
    res.status(500).json({ error: 'Failed to update assignment status' });
  }
});

// ── POST /api/assignments/:id/book-out — Record book-out data ──

router.post('/:id/book-out', validate(bookOutSchema), async (req: AuthRequest, res: Response) => {
  try {
    const { id } = req.params;
    const {
      mileage_out, fuel_level_out,
      assignment_type, freelancer_person_id,
      hire_start, hire_end, start_time, end_time,
    } = req.body;

    // Per-driver advisory check: gather any unresolved referral / excess
    // issues so they can be returned as warnings. These are NON-BLOCKING —
    // staff see the equivalent amber banners on Job Detail and are trusted
    // to proceed if they know what they're doing. The hard-gate-with-admin-
    // override version is planned for ~May 2026 (see CLAUDE.md "Future nice-
    // to-haves"). dispatch_override on job_excess still suppresses the
    // warning for audit tidiness.
    const gateCheck = await query(
      `SELECT vha.assignment_type, vha.driver_id,
        d.requires_referral, d.referral_status,
        je.excess_status, je.dispatch_override
      FROM vehicle_hire_assignments vha
      LEFT JOIN drivers d ON d.id = vha.driver_id
      LEFT JOIN job_excess je ON je.assignment_id = vha.id
      WHERE vha.id = $1`,
      [id]
    );

    const warnings: string[] = [];
    if (gateCheck.rows.length > 0) {
      const row = gateCheck.rows[0];
      if (row.assignment_type === 'self_drive') {
        if (row.requires_referral && row.referral_status !== 'approved') {
          warnings.push('Driver referral pending — not yet approved');
        }
        if (
          row.excess_status &&
          !['taken', 'waived', 'rolled_over', 'not_required', 'reimbursed', 'partially_reimbursed', 'fully_claimed', 'pre_auth'].includes(row.excess_status) &&
          !row.dispatch_override
        ) {
          warnings.push('Insurance excess not resolved');
        }
      }
    }

    const result = await query(
      `UPDATE vehicle_hire_assignments
       SET status = 'booked_out',
           status_changed_at = NOW(),
           booked_out_at = NOW(),
           booked_out_by = $1,
           mileage_out = $2,
           fuel_level_out = $3,
           assignment_type = COALESCE($5, assignment_type),
           freelancer_person_id = COALESCE($6, freelancer_person_id),
           hire_start = COALESCE($7::date, hire_start),
           hire_end = COALESCE($8::date, hire_end),
           start_time = COALESCE($9::time, start_time),
           end_time = COALESCE($10::time, end_time),
           updated_at = NOW()
       WHERE id = $4
       RETURNING *`,
      [
        req.user!.id, mileage_out, fuel_level_out, id,
        assignment_type ?? null,
        freelancer_person_id ?? null,
        hire_start ?? null,
        hire_end ?? null,
        start_time ?? null,
        end_time ?? null,
      ]
    );

    if (result.rows.length === 0) {
      res.status(404).json({ error: 'Assignment not found' });
      return;
    }

    const assignment = result.rows[0];

    // Dual-write mileage to vehicle_mileage_log (only if vehicle assigned)
    if (mileage_out > 0 && assignment.vehicle_id) {
      await query(
        `INSERT INTO vehicle_mileage_log (vehicle_id, mileage, source, source_ref, recorded_by)
         VALUES ($1, $2, 'book_out', $3, $4)`,
        [assignment.vehicle_id, mileage_out, id, req.user!.id]
      );

      // Update fleet_vehicles current_mileage (only if higher)
      await query(
        `UPDATE fleet_vehicles
         SET current_mileage = GREATEST(COALESCE(current_mileage, 0), $1),
             last_mileage_update = NOW()
         WHERE id = $2`,
        [mileage_out, assignment.vehicle_id]
      );
    }

    // Recompute fleet hire_status from current assignment state so the Fleet
    // page reflects reality. The helper is the single source of truth — it
    // sees the just-flipped 'booked_out' assignment and writes 'On Hire'.
    if (assignment.vehicle_id) {
      await syncFleetHireStatus(assignment.vehicle_id);
    }
    // Book-out is the canonical "vehicle confirmed" moment — if the
    // requirement was 'in_progress' at allocation time it should now be
    // 'done'. Helper preserves manual 'blocked' state.
    if (assignment.job_id) {
      syncVehicleRequirementStatus(assignment.job_id).catch(err => {
        console.warn(`[assignments] book-out vehicle requirement sync failed:`, err);
      });
    }

    res.json({ data: assignment, warnings });
  } catch (error) {
    console.error('[assignments] Book-out error:', error);
    res.status(500).json({ error: 'Failed to record book-out' });
  }
});

// ── POST /api/assignments/:id/check-in — Record check-in data ──

router.post('/:id/check-in', validate(checkInSchema), async (req: AuthRequest, res: Response) => {
  try {
    const id = req.params.id as string;
    const { mileage_in, fuel_level_in, has_damage } = req.body;

    const result = await query(
      `UPDATE vehicle_hire_assignments
       SET status = 'returned',
           status_changed_at = NOW(),
           checked_in_at = NOW(),
           checked_in_by = $1,
           mileage_in = $2,
           fuel_level_in = $3,
           has_damage = $4,
           updated_at = NOW()
       WHERE id = $5
       RETURNING *`,
      [req.user!.id, mileage_in, fuel_level_in, has_damage, id]
    );

    if (result.rows.length === 0) {
      res.status(404).json({ error: 'Assignment not found' });
      return;
    }

    const assignment = result.rows[0];

    // Dual-write mileage (only if vehicle assigned)
    if (mileage_in > 0 && assignment.vehicle_id) {
      await query(
        `INSERT INTO vehicle_mileage_log (vehicle_id, mileage, source, source_ref, recorded_by)
         VALUES ($1, $2, 'check_in', $3, $4)`,
        [assignment.vehicle_id, mileage_in, id, req.user!.id]
      );

      await query(
        `UPDATE fleet_vehicles
         SET current_mileage = GREATEST(COALESCE(current_mileage, 0), $1),
             last_mileage_update = NOW()
         WHERE id = $2`,
        [mileage_in, assignment.vehicle_id]
      );
    }

    // Recompute fleet hire_status — helper sees no active assignment and
    // transitions the row from 'On Hire' → 'Prep Needed'. The 'Prep Needed'
    // → 'Available' transition is owned by the prep-completion flow.
    if (assignment.vehicle_id) {
      await syncFleetHireStatus(assignment.vehicle_id);
    }
    // Check-in flips the assignment to 'returned', so it no longer counts
    // toward the pre-hire vehicle requirement. The pre-hire phase is
    // historically "done" by this point — recomputing keeps it accurate
    // against any cancellation / removal that happens between book-out
    // and check-in.
    if (assignment.job_id) {
      syncVehicleRequirementStatus(assignment.job_id).catch(err => {
        console.warn(`[assignments] check-in vehicle requirement sync failed:`, err);
      });
    }

    // Auto-create damage_review close-out requirement if damage flagged
    if (has_damage && assignment.job_id) {
      try {
        // Get vehicle reg for the note
        let vehicleReg = '';
        if (assignment.vehicle_id) {
          const vResult = await query(
            `SELECT registration FROM fleet_vehicles WHERE id = $1`,
            [assignment.vehicle_id]
          );
          vehicleReg = vResult.rows[0]?.registration || '';
        }

        const noteText = vehicleReg
          ? `Vehicle damage flagged on check-in — ${vehicleReg}`
          : 'Vehicle damage flagged on check-in';

        // Insert if not already exists (unique constraint: job_id + requirement_type + phase)
        await query(
          `INSERT INTO job_requirements (job_id, requirement_type, status, is_auto, source, phase, notes)
           VALUES ($1, 'damage_review', 'not_started', true, 'check_in', 'post_hire', $2)
           ON CONFLICT (job_id, requirement_type, phase) DO UPDATE
             SET notes = CASE
               WHEN job_requirements.notes IS NULL OR job_requirements.notes = '' THEN $2
               WHEN job_requirements.notes NOT LIKE '%' || $2 || '%' THEN job_requirements.notes || E'\n' || $2
               ELSE job_requirements.notes
             END,
             updated_at = NOW()`,
          [assignment.job_id, noteText]
        );
      } catch (dmgErr) {
        console.warn('[assignments] Damage requirement auto-creation failed:', dmgErr);
      }
    }

    res.json({ data: assignment });
  } catch (error) {
    console.error('[assignments] Check-in error:', error);
    res.status(500).json({ error: 'Failed to record check-in' });
  }
});

// ── DELETE /api/assignments/:id — Cancel assignment ──

router.delete('/:id', async (req: AuthRequest, res: Response) => {
  try {
    const { id } = req.params;

    const result = await query(
      `UPDATE vehicle_hire_assignments
       SET status = 'cancelled', status_changed_at = NOW(), updated_at = NOW()
       WHERE id = $1
       RETURNING *`,
      [id]
    );

    if (result.rows.length === 0) {
      res.status(404).json({ error: 'Assignment not found' });
      return;
    }

    res.json({ data: result.rows[0] });
  } catch (error) {
    console.error('[assignments] Cancel error:', error);
    res.status(500).json({ error: 'Failed to cancel assignment' });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// DISPATCH GATE CHECK
// ═══════════════════════════════════════════════════════════════════════════

// ── GET /api/assignments/dispatch-check/:jobId — Per-assignment readiness for a job ──
// Returns blockers per assignment. The job itself can still go out — the gate
// is per-driver: a specific driver can't be booked out until their referral
// is approved and excess is resolved.

// ── GET /api/assignments/allocation-conflicts/:jobId — Per-assignment overlap ──
//
// For each active assignment on this job, detect whether its vehicle is also
// committed to an overlapping hire on a DIFFERENT job. Used by the amber
// banner on Job Detail > Drivers & Vehicles to flag "dates moved — reassign
// one or the other" scenarios.

router.get('/allocation-conflicts/:jobId', async (req: AuthRequest, res: Response) => {
  try {
    const jobId = req.params.jobId as string;

    const assignments = await query(
      `SELECT vha.id, vha.vehicle_id, vha.hirehop_job_id,
              vha.hire_start, vha.hire_end,
              fv.reg AS vehicle_reg,
              d.full_name AS driver_name
       FROM vehicle_hire_assignments vha
       LEFT JOIN fleet_vehicles fv ON fv.id = vha.vehicle_id
       LEFT JOIN drivers d ON d.id = vha.driver_id
       WHERE vha.job_id = $1
         AND vha.status IN ('soft', 'confirmed', 'booked_out', 'active')
         AND vha.vehicle_id IS NOT NULL`,
      [jobId]
    );

    const conflicts: Array<{
      assignmentId: string;
      vehicleId: string;
      vehicleReg: string | null;
      driverName: string | null;
      conflict: Awaited<ReturnType<typeof findOverlappingAssignments>>[number];
    }> = [];

    for (const a of assignments.rows) {
      const overlaps = await findOverlappingAssignments({
        vehicleId: a.vehicle_id,
        hireStart: a.hire_start,
        hireEnd: a.hire_end,
        jobId,
        hirehopJobId: a.hirehop_job_id,
        excludeAssignmentId: a.id,
      });
      if (overlaps.length > 0) {
        conflicts.push({
          assignmentId: a.id,
          vehicleId: a.vehicle_id,
          vehicleReg: a.vehicle_reg,
          driverName: a.driver_name,
          conflict: overlaps[0],
        });
      }
    }

    res.json({ data: { conflicts } });
  } catch (error) {
    console.error('[assignments] Allocation conflicts error:', error);
    res.status(500).json({ error: 'Failed to load allocation conflicts' });
  }
});

// ── GET /api/assignments/date-mismatches/:jobId ──
//
// Detects assignments whose locked hire window (hire_start / hire_end) no
// longer matches the parent job's dates (job_date / job_end). Returns the
// drift so Job Detail can render an amber "extend assignment to match?"
// banner. Only reports active rows — cancelled / returned / swapped don't
// matter.
//
// Direction:
//   - 'extension'   = job_end > vha.hire_end (client kept van longer / job extended)
//   - 'shortening'  = job_end < vha.hire_end (job shortened, assignment overshoots)
//   - 'start_drift' = vha.hire_start drift in either direction
router.get('/date-mismatches/:jobId', async (req: AuthRequest, res: Response) => {
  try {
    const jobId = req.params.jobId as string;

    const result = await query(
      `SELECT vha.id, vha.status, vha.hire_start, vha.hire_end,
              fv.reg AS vehicle_reg,
              d.full_name AS driver_name,
              j.job_date, j.job_end
       FROM vehicle_hire_assignments vha
       LEFT JOIN fleet_vehicles fv ON fv.id = vha.vehicle_id
       LEFT JOIN drivers d ON d.id = vha.driver_id
       LEFT JOIN jobs j ON j.id = vha.job_id
       WHERE vha.job_id = $1
         AND vha.status IN ('soft', 'confirmed', 'booked_out', 'active')`,
      [jobId]
    );

    type Mismatch = {
      assignmentId: string;
      vehicleReg: string | null;
      driverName: string | null;
      assignmentStatus: string;
      assignmentStart: string | null;
      assignmentEnd: string | null;
      jobStart: string | null;
      jobEnd: string | null;
      kind: 'extension' | 'shortening' | 'start_drift';
    };

    const mismatches: Mismatch[] = [];
    for (const r of result.rows) {
      // Only flag if both dates are populated AND drift is meaningful (>0
      // days). Null assignment dates default to job dates anyway, so the
      // PDF / display layer doesn't see a real mismatch until book-out
      // locked them.
      if (!r.hire_end || !r.job_end) continue;
      const aEnd = new Date(r.hire_end);
      const jEnd = new Date(r.job_end);
      const aStart = r.hire_start ? new Date(r.hire_start) : null;
      const jStart = r.job_date ? new Date(r.job_date) : null;
      const ms = (a: Date, b: Date) => Math.round((a.getTime() - b.getTime()) / 86400000);

      const endDriftDays = ms(aEnd, jEnd);
      // Only the date portion matters — strip time below by re-parsing as date.
      const endDriftAbs = Math.abs(endDriftDays);

      let kind: Mismatch['kind'] | null = null;
      if (endDriftDays < 0) kind = 'extension';      // job_end is later → assignment lags
      else if (endDriftDays > 0) kind = 'shortening'; // job_end is earlier → assignment overshoots
      else if (aStart && jStart && Math.abs(ms(aStart, jStart)) > 0) kind = 'start_drift';

      if (!kind || (kind !== 'start_drift' && endDriftAbs === 0)) continue;

      mismatches.push({
        assignmentId: r.id,
        vehicleReg: r.vehicle_reg,
        driverName: r.driver_name,
        assignmentStatus: r.status,
        assignmentStart: r.hire_start ? new Date(r.hire_start).toISOString().slice(0, 10) : null,
        assignmentEnd: r.hire_end ? new Date(r.hire_end).toISOString().slice(0, 10) : null,
        jobStart: r.job_date ? new Date(r.job_date).toISOString().slice(0, 10) : null,
        jobEnd: r.job_end ? new Date(r.job_end).toISOString().slice(0, 10) : null,
        kind,
      });
    }

    res.json({ data: { mismatches } });
  } catch (error) {
    console.error('[assignments] Date mismatches error:', error);
    res.status(500).json({ error: 'Failed to load date mismatches' });
  }
});

// ── POST /api/assignments/:id/match-job-dates ──
//
// One-click action attached to the date-mismatch banner. Updates the
// assignment's hire_start / hire_end to match the parent job's dates and
// emails the driver an updated hire agreement PDF (so they have a record
// of the new window). Re-runs the overlap check against the new window —
// rejects with 409 if the extension would clash with another hire on the
// same van.
router.post('/:id/match-job-dates', async (req: AuthRequest, res: Response) => {
  try {
    const id = req.params.id as string;

    const existing = await query(
      `SELECT vha.id, vha.vehicle_id, vha.job_id, vha.hirehop_job_id,
              vha.hire_start, vha.hire_end, vha.status,
              j.job_date, j.job_end
         FROM vehicle_hire_assignments vha
         LEFT JOIN jobs j ON j.id = vha.job_id
        WHERE vha.id = $1`,
      [id]
    );
    if (existing.rows.length === 0) {
      return res.status(404).json({ error: 'Assignment not found' });
    }
    const a = existing.rows[0];
    if (!a.job_date || !a.job_end) {
      return res.status(400).json({ error: 'Job has no dates set' });
    }

    // Overlap check on the NEW window before applying — extending could
    // collide with another hire scheduled in the (formerly free) gap.
    const conflicts = await findOverlappingAssignments({
      vehicleId: a.vehicle_id,
      hireStart: a.job_date,
      hireEnd: a.job_end,
      jobId: a.job_id,
      hirehopJobId: a.hirehop_job_id,
      excludeAssignmentId: id,
    });
    if (conflicts.length > 0) {
      return res.status(409).json(buildConflictPayload(conflicts));
    }

    await query(
      `UPDATE vehicle_hire_assignments
          SET hire_start = $1::date, hire_end = $2::date, updated_at = NOW()
        WHERE id = $3`,
      [a.job_date, a.job_end, id]
    );

    res.json({
      data: {
        id,
        hire_start: new Date(a.job_date).toISOString().slice(0, 10),
        hire_end: new Date(a.job_end).toISOString().slice(0, 10),
      },
    });
  } catch (error) {
    console.error('[assignments] Match job dates error:', error);
    res.status(500).json({ error: 'Failed to update assignment dates' });
  }
});

router.get('/dispatch-check/:jobId', async (req: AuthRequest, res: Response) => {
  try {
    const { jobId } = req.params;

    // Find all self_drive assignments for this job with excess + referral status
    const result = await query(
      `SELECT vha.id AS assignment_id,
        vha.status AS assignment_status,
        d.full_name AS driver_name,
        fv.reg AS vehicle_reg,
        je.id AS excess_id,
        je.excess_amount_required,
        je.excess_status,
        je.dispatch_override,
        d.requires_referral,
        d.referral_status
      FROM vehicle_hire_assignments vha
      LEFT JOIN fleet_vehicles fv ON fv.id = vha.vehicle_id
      LEFT JOIN drivers d ON d.id = vha.driver_id
      LEFT JOIN job_excess je ON je.assignment_id = vha.id
      WHERE vha.job_id = $1
        AND vha.assignment_type = 'self_drive'
        AND vha.status != 'cancelled'`,
      [jobId]
    );

    const blockers: Array<{
      type: string;
      assignmentId: string;
      excessId?: string;
      driverName: string | null;
      vehicleReg: string | null;
      amountRequired: number | null;
      dispatchOverride?: boolean;
    }> = [];

    for (const row of result.rows) {
      // Check excess status
      if (row.excess_status && !['taken', 'waived', 'rolled_over', 'not_required', 'reimbursed', 'partially_reimbursed', 'fully_claimed', 'pre_auth'].includes(row.excess_status)) {
        blockers.push({
          type: 'excess_pending',
          assignmentId: row.assignment_id,
          excessId: row.excess_id,
          driverName: row.driver_name,
          vehicleReg: row.vehicle_reg,
          amountRequired: row.excess_amount_required ? parseFloat(row.excess_amount_required) : null,
          dispatchOverride: row.dispatch_override,
        });
      }

      // Check referral status
      if (row.requires_referral && row.referral_status !== 'approved') {
        blockers.push({
          type: 'referral_pending',
          assignmentId: row.assignment_id,
          driverName: row.driver_name,
          vehicleReg: row.vehicle_reg,
          amountRequired: null,
        });
      }
    }

    // Also check for job-level excess (not tied to a specific assignment)
    const jobExcessResult = await query(
      `SELECT je.id AS excess_id, je.excess_amount_required, je.excess_status,
              je.client_name, je.dispatch_override
       FROM job_excess je
       WHERE je.job_id = $1
         AND je.assignment_id IS NULL
         AND je.excess_status NOT IN ('taken', 'waived', 'rolled_over', 'not_required', 'reimbursed', 'partially_reimbursed', 'fully_claimed', 'pre_auth')`,
      [jobId]
    );
    for (const row of jobExcessResult.rows) {
      blockers.push({
        type: 'excess_pending',
        assignmentId: 'job-level',
        excessId: row.excess_id,
        driverName: row.client_name || null,
        vehicleReg: null,
        amountRequired: row.excess_amount_required ? parseFloat(row.excess_amount_required) : null,
        dispatchOverride: row.dispatch_override,
      });
    }

    res.json({
      // Job can still dispatch — blockers are per-driver, not per-job
      canDispatch: true,
      totalAssignments: result.rows.length,
      readyAssignments: result.rows.length - new Set(blockers.map(b => b.assignmentId)).size,
      blockers,
    });
  } catch (error) {
    console.error('[assignments] Dispatch check error:', error);
    res.status(500).json({ error: 'Failed to check dispatch status' });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// COMPATIBILITY LAYER — returns old VanAllocation[] shape
// These endpoints let the existing AllocationsPage work unchanged.
// ═══════════════════════════════════════════════════════════════════════════

// ── GET /api/assignments/compat/allocations — Old-format allocations ──

router.get('/compat/allocations', async (_req: AuthRequest, res: Response) => {
  try {
    // Clean up duplicate assignments (same job + same vehicle, multiple active rows).
    // Only touch allocations-created rows (driver_id IS NULL).
    // Hire-form-created assignments (driver_id IS NOT NULL) are managed by the hire form flow.
    await query(
      `WITH ranked AS (
        SELECT id,
          ROW_NUMBER() OVER (
            PARTITION BY hirehop_job_id, vehicle_id
            ORDER BY
              CASE status
                WHEN 'booked_out' THEN 1 WHEN 'active' THEN 2
                WHEN 'confirmed' THEN 3 WHEN 'soft' THEN 4
              END,
              created_at ASC
          ) AS rn
        FROM vehicle_hire_assignments
        WHERE status IN ('soft', 'confirmed', 'booked_out', 'active')
          AND vehicle_id IS NOT NULL
          AND driver_id IS NULL
      )
      UPDATE vehicle_hire_assignments
      SET status = 'cancelled', status_changed_at = NOW(), updated_at = NOW()
      WHERE id IN (SELECT id FROM ranked WHERE rn > 1)`
    );

    const result = await query(
      `SELECT vha.*,
        fv.reg AS vehicle_reg,
        d.full_name AS driver_name
      FROM vehicle_hire_assignments vha
      LEFT JOIN fleet_vehicles fv ON fv.id = vha.vehicle_id
      LEFT JOIN drivers d ON d.id = vha.driver_id
      WHERE vha.status IN ('soft', 'confirmed', 'booked_out', 'active')
      ORDER BY vha.created_at ASC`
    );

    // Map to VanAllocation shape
    // Use driver_name from drivers table if linked, otherwise fall back to notes (freetext)
    // Tag as readOnly if: booked_out/active status, OR hire-form-created (has driver_id).
    // Hire-form assignments are managed via the hire forms / driver pages, not allocations.
    const allocations = result.rows.map((row: any) => ({
      id: row.id,
      hireHopJobId: row.hirehop_job_id,
      hireHopJobName: row.hirehop_job_name || '',
      vanRequirementIndex: row.van_requirement_index,
      vehicleId: row.vehicle_id,
      vehicleReg: row.vehicle_reg || null,
      driverName: row.driver_name || row.notes || null,
      driverId: row.driver_id || null,
      status: row.status === 'soft' ? 'soft' : 'confirmed',
      // Expose the underlying assignment status so the UI can distinguish
      // booked_out/active from confirmed — the narrowed `status` above
      // collapses them for backwards compatibility with the old
      // VanAllocation shape.
      rawStatus: row.status,
      allocatedAt: row.created_at,
      allocatedBy: row.allocated_by_name || 'Unknown',
      confirmedAt: row.status !== 'soft' ? row.status_changed_at : null,
      readOnly: ['booked_out', 'active'].includes(row.status) || !!row.driver_id,
      hireFormLinked: !!row.driver_id,
    }));

    res.json({ allocations });
  } catch (error) {
    console.error('[assignments/compat] Get allocations error:', error);
    res.status(500).json({ error: 'Failed to load allocations' });
  }
});

// ── POST /api/assignments/compat/allocations — Save old-format allocations ──
// Converts VanAllocation[] to assignment rows. Used by existing frontend.
//
// Strategy: Match existing DB rows by UUID (id). Only modify soft/confirmed
// assignments — booked_out/active are managed by book-out/hire-form flows.
// Uses (job_id, vehicle_id) dedup to prevent duplicate rows.

router.post('/compat/allocations', async (req: AuthRequest, res: Response) => {
  try {
    const { allocations, managedJobIds } = req.body;

    if (!Array.isArray(allocations)) {
      res.status(400).json({ error: 'allocations array required' });
      return;
    }

    // Collect the set of job IDs being managed in this save request.
    const incomingJobIds = new Set<number>(
      allocations.map((a: any) => Number(a.hireHopJobId)).filter((n: number) => !isNaN(n))
    );
    if (Array.isArray(managedJobIds)) {
      for (const jid of managedJobIds) {
        const n = Number(jid);
        if (!isNaN(n)) incomingJobIds.add(n);
      }
    }

    if (incomingJobIds.size === 0) {
      res.json({ success: true });
      return;
    }

    // Load ALL existing active assignments for managed jobs (all statuses the GET returns)
    const existing = await query(
      `SELECT id, hirehop_job_id, van_requirement_index, vehicle_id, driver_id, notes, status
       FROM vehicle_hire_assignments
       WHERE status IN ('soft', 'confirmed', 'booked_out', 'active')
         AND hirehop_job_id = ANY($1)`,
      [Array.from(incomingJobIds)]
    );

    // Index by UUID for matching incoming allocations to existing DB rows
    const existingById = new Map<string, any>(
      existing.rows.map((r: any) => [r.id, r])
    );
    // Index by (job, vehicle) for dedup — prevents creating duplicate rows
    const existingByJobVehicle = new Map<string, any>();
    for (const r of existing.rows) {
      if (r.vehicle_id) {
        existingByJobVehicle.set(`${r.hirehop_job_id}-${r.vehicle_id}`, r);
      }
    }

    // Track which existing rows are still referenced by the incoming data
    const touchedIds = new Set<string>();
    // Collect per-allocation conflicts so the UI can surface them to staff.
    // We skip conflicting allocations rather than failing the whole batch —
    // the frontend can then remove/reassign the offending slot.
    const conflictResults: Array<{
      allocationId: string;
      vehicleReg: string | null;
      conflict: Awaited<ReturnType<typeof findOverlappingAssignments>>[number];
    }> = [];

    for (const alloc of allocations) {
      // Skip readOnly allocations — booked_out/active are not managed here
      if (alloc.readOnly) {
        const existingRow = existingById.get(alloc.id);
        if (existingRow) touchedIds.add(existingRow.id);
        continue;
      }

      // Try to match by UUID (DB ID returned from GET)
      const existingRow = existingById.get(alloc.id);

      if (existingRow) {
        touchedIds.add(existingRow.id);

        // Only update soft/confirmed assignments
        if (!['soft', 'confirmed'].includes(existingRow.status)) continue;

        // Resolve vehicle by reg if needed
        let vehicleId = alloc.vehicleId;
        if (!vehicleId || !/^[0-9a-f-]{36}$/i.test(vehicleId)) {
          const vResult = await query(
            'SELECT id FROM fleet_vehicles WHERE reg = $1',
            [alloc.vehicleReg?.toUpperCase()]
          );
          vehicleId = vResult.rows[0]?.id || existingRow.vehicle_id;
        }

        // If the vehicle is actually changing, check it's not already taken
        // for overlapping dates on a different job. Exclude this assignment
        // from the conflict search so a no-op update doesn't self-block.
        if (vehicleId && vehicleId !== existingRow.vehicle_id) {
          const existingConflicts = await findOverlappingAssignments({
            vehicleId,
            hirehopJobId: alloc.hireHopJobId,
            excludeAssignmentId: existingRow.id,
          });
          if (existingConflicts.length > 0) {
            conflictResults.push({
              allocationId: alloc.id,
              vehicleReg: alloc.vehicleReg || null,
              conflict: existingConflicts[0],
            });
            continue;
          }
        }

        // Resolve driver
        let driverId: string | null = alloc.driverId || null;
        const driverName = alloc.driverName || null;
        if (driverName && !driverId) {
          const dResult = await query(
            `SELECT id FROM drivers WHERE full_name ILIKE $1 AND is_active = true ORDER BY updated_at DESC LIMIT 1`,
            [driverName.trim()]
          );
          driverId = dResult.rows[0]?.id || null;
        }

        await query(
          `UPDATE vehicle_hire_assignments
           SET vehicle_id = $1, hirehop_job_name = $2, status = $3,
               allocated_by_name = $4, notes = $5,
               driver_id = COALESCE($6, driver_id), updated_at = NOW()
           WHERE id = $7`,
          [
            vehicleId,
            alloc.hireHopJobName || null,
            alloc.status === 'confirmed' ? 'confirmed' : 'soft',
            alloc.allocatedBy || null,
            driverName,
            driverId,
            existingRow.id,
          ]
        );
      } else {
        // New allocation (frontend-generated UUID, not yet in DB)
        // Resolve vehicle
        let vehicleId = alloc.vehicleId;
        if (!vehicleId || !/^[0-9a-f-]{36}$/i.test(vehicleId)) {
          const vResult = await query(
            'SELECT id FROM fleet_vehicles WHERE reg = $1',
            [alloc.vehicleReg?.toUpperCase()]
          );
          if (!vResult.rows[0]) continue;
          vehicleId = vResult.rows[0].id;
        }

        // Check for existing assignment with same job+vehicle (dedup)
        const dupeKey = `${alloc.hireHopJobId}-${vehicleId}`;
        const existingDupe = existingByJobVehicle.get(dupeKey);
        if (existingDupe) {
          // Already assigned — don't create duplicate, just mark as touched
          touchedIds.add(existingDupe.id);
          continue;
        }

        // Overlap check on the target vehicle against other jobs' assignments.
        const newConflicts = await findOverlappingAssignments({
          vehicleId,
          hirehopJobId: alloc.hireHopJobId,
        });
        if (newConflicts.length > 0) {
          conflictResults.push({
            allocationId: alloc.id,
            vehicleReg: alloc.vehicleReg || null,
            conflict: newConflicts[0],
          });
          continue;
        }

        // Resolve driver
        let driverId: string | null = alloc.driverId || null;
        const driverName = alloc.driverName || null;
        if (driverName && !driverId) {
          const dResult = await query(
            `SELECT id FROM drivers WHERE full_name ILIKE $1 AND is_active = true ORDER BY updated_at DESC LIMIT 1`,
            [driverName.trim()]
          );
          driverId = dResult.rows[0]?.id || null;
        }

        const insertResult = await query(
          `INSERT INTO vehicle_hire_assignments (
            vehicle_id, hirehop_job_id, hirehop_job_name,
            van_requirement_index, status, allocated_by_name,
            notes, driver_id,
            assignment_type, created_by
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'self_drive', $9)
          RETURNING id`,
          [
            vehicleId,
            alloc.hireHopJobId,
            alloc.hireHopJobName || null,
            alloc.vanRequirementIndex ?? 0,
            alloc.status === 'confirmed' ? 'confirmed' : 'soft',
            alloc.allocatedBy || null,
            driverName,
            driverId,
            req.user!.id,
          ]
        );

        // Track in dedup map to prevent further duplicates in this batch
        if (insertResult.rows[0]) {
          existingByJobVehicle.set(dupeKey, { id: insertResult.rows[0].id });
        }
      }
    }

    // Cancel soft/confirmed assignments that are no longer referenced.
    // Only cancel allocations-created rows (driver_id IS NULL).
    // Hire-form-created assignments (driver_id set) are managed by the hire form flow.
    for (const row of existing.rows) {
      if (['soft', 'confirmed'].includes(row.status) && !touchedIds.has(row.id) && !row.driver_id) {
        await query(
          `UPDATE vehicle_hire_assignments
           SET status = 'cancelled', status_changed_at = NOW(), updated_at = NOW()
           WHERE id = $1`,
          [row.id]
        );
      }
    }

    // Recompute the pre-hire vehicle requirement on every job touched in
    // this batch — the allocation save may have added, removed, or changed
    // vehicle linkage on multiple jobs at once. Lookup OP UUIDs from HH
    // numbers since this endpoint speaks HH ids. Fire-and-forget per job.
    if (incomingJobIds.size > 0) {
      const opIdResult = await query(
        `SELECT id, hh_job_number FROM jobs WHERE hh_job_number = ANY($1)`,
        [Array.from(incomingJobIds)],
      );
      for (const r of opIdResult.rows) {
        syncVehicleRequirementStatus(r.id as string).catch(err => {
          console.warn(`[assignments/compat] vehicle requirement sync failed for HH#${r.hh_job_number}:`, err);
        });
      }
    }

    res.json({ success: true, conflicts: conflictResults });
  } catch (error) {
    console.error('[assignments/compat] Save allocations error:', error);
    res.status(500).json({ error: 'Failed to save allocations' });
  }
});

// ─── VEHICLE SWAP ──────────────────────────────────────────────────────────
// Swap a vehicle on an existing assignment (e.g. breakdown → replacement).
// Original assignment gets status 'swapped'; new assignment is created for the replacement vehicle.
const swapSchema = z.object({
  new_vehicle_id: z.string().uuid(),
  swap_reason: z.string().min(1).max(500),
});

router.post('/:id/swap-vehicle', validate(swapSchema), async (req: AuthRequest, res: Response) => {
  const { id } = req.params;
  const { new_vehicle_id, swap_reason } = req.body;

  try {
    // 1. Load original assignment
    const origResult = await query(
      `SELECT a.*, fv.reg AS vehicle_reg, d.full_name AS driver_name
       FROM vehicle_hire_assignments a
       LEFT JOIN fleet_vehicles fv ON fv.id = a.vehicle_id
       LEFT JOIN drivers d ON d.id = a.driver_id
       WHERE a.id = $1 AND a.status NOT IN ('cancelled', 'swapped')`,
      [id]
    );
    if (origResult.rows.length === 0) {
      return res.status(404).json({ error: 'Assignment not found or already swapped/cancelled' });
    }
    const orig = origResult.rows[0];

    // 2. Verify new vehicle exists
    const newVehicleResult = await query(`SELECT id, reg FROM fleet_vehicles WHERE id = $1`, [new_vehicle_id]);
    if (newVehicleResult.rows.length === 0) {
      return res.status(400).json({ error: 'Replacement vehicle not found' });
    }
    const newVehicle = newVehicleResult.rows[0];

    // Overlap check on the replacement vehicle. The original stays on the
    // swapped slot (about to be marked 'swapped' = non-occupying), so we
    // only care about other jobs' assignments colliding with the new van.
    const swapConflicts = await findOverlappingAssignments({
      vehicleId: new_vehicle_id,
      hireStart: orig.hire_start,
      hireEnd: orig.hire_end,
      jobId: orig.job_id,
      hirehopJobId: orig.hirehop_job_id,
    });
    if (swapConflicts.length > 0) {
      return res.status(409).json(buildConflictPayload(swapConflicts, newVehicle.reg));
    }

    // 3. Create new assignment for replacement vehicle (same driver, job, dates)
    const newResult = await query(
      `INSERT INTO vehicle_hire_assignments (
        vehicle_id, job_id, hirehop_job_id, hirehop_job_name,
        driver_id, assignment_type,
        van_requirement_index, required_type, required_gearbox,
        status, status_changed_at,
        hire_start, hire_end, start_time, end_time, return_overnight,
        client_email, notes, created_by
      ) VALUES (
        $1, $2, $3, $4,
        $5, $6,
        $7, $8, $9,
        'confirmed', NOW(),
        NOW(), $10, $11, $12, $13,
        $14, $15, $16
      ) RETURNING *`,
      [
        new_vehicle_id, orig.job_id, orig.hirehop_job_id, orig.hirehop_job_name,
        orig.driver_id, orig.assignment_type,
        orig.van_requirement_index, orig.required_type, orig.required_gearbox,
        orig.hire_end, orig.start_time, orig.end_time, orig.return_overnight,
        orig.client_email,
        `Swapped from ${orig.vehicle_reg || 'unknown'}: ${swap_reason}`,
        req.user!.id,
      ]
    );
    const newAssignment = newResult.rows[0];

    // 4. Mark original as swapped
    await query(
      `UPDATE vehicle_hire_assignments
       SET status = 'swapped', swap_reason = $1, swapped_at = NOW(), swapped_to_assignment_id = $2, status_changed_at = NOW()
       WHERE id = $3`,
      [swap_reason, newAssignment.id, id]
    );

    // 5. Copy excess record to new assignment
    await query(
      `INSERT INTO job_excess (assignment_id, job_id, hirehop_job_id, excess_amount_required, excess_calculation_basis, excess_status, created_by)
       SELECT $1, job_id, hirehop_job_id, excess_amount_required, excess_calculation_basis, excess_status, $2
       FROM job_excess WHERE assignment_id = $3 LIMIT 1`,
      [newAssignment.id, req.user!.id, id]
    );

    // 6. Recompute hire_status on both vehicles. Old van: assignment is now
    // 'swapped' (not occupying), helper transitions 'On Hire' → 'Prep Needed'
    // if the original was already booked out, otherwise preserves. New van:
    // assignment is 'confirmed', no flip until book-out completes — helper
    // preserves whatever value it had ('Available' usually).
    if (orig.vehicle_id) await syncFleetHireStatus(orig.vehicle_id);
    await syncFleetHireStatus(new_vehicle_id);

    // Vehicle requirement: count is unchanged (1 swapped out, 1 swapped in)
    // but recompute anyway for safety — handles edge cases like swapping
    // when the new assignment can't be created for some reason.
    if (orig.job_id) {
      syncVehicleRequirementStatus(orig.job_id).catch(err => {
        console.warn(`[assignments] swap-vehicle requirement sync failed:`, err);
      });
    }

    console.log(`[assignments] Vehicle swapped: ${orig.vehicle_reg} → ${newVehicle.reg} (assignment ${id} → ${newAssignment.id})`);

    // Return both assignments
    const fullNew = await query(
      `SELECT a.*, fv.reg AS vehicle_reg, d.full_name AS driver_name
       FROM vehicle_hire_assignments a
       LEFT JOIN fleet_vehicles fv ON fv.id = a.vehicle_id
       LEFT JOIN drivers d ON d.id = a.driver_id
       WHERE a.id = $1`,
      [newAssignment.id]
    );

    res.status(201).json({
      data: {
        original: { id, status: 'swapped', swap_reason, vehicle_reg: orig.vehicle_reg },
        replacement: fullNew.rows[0],
      },
    });
  } catch (error) {
    console.error('[assignments] Vehicle swap error:', error);
    res.status(500).json({ error: 'Failed to swap vehicle' });
  }
});

export default router;
