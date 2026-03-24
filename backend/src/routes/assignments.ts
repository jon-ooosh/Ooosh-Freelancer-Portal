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
    const { mileage_out, fuel_level_out } = req.body;

    // Per-driver gate: check if this driver's referral and excess are cleared
    const gateCheck = await query(
      `SELECT vha.assignment_type, vha.driver_id,
        d.requires_referral, d.referral_status,
        je.excess_status
      FROM vehicle_hire_assignments vha
      LEFT JOIN drivers d ON d.id = vha.driver_id
      LEFT JOIN job_excess je ON je.assignment_id = vha.id
      WHERE vha.id = $1`,
      [id]
    );

    if (gateCheck.rows.length > 0) {
      const row = gateCheck.rows[0];
      const gateBlockers: string[] = [];

      if (row.assignment_type === 'self_drive') {
        if (row.requires_referral && row.referral_status !== 'approved') {
          gateBlockers.push('Driver referral pending — must be approved before book-out');
        }
        if (row.excess_status && !['taken', 'waived', 'rolled_over', 'not_required'].includes(row.excess_status)) {
          gateBlockers.push('Insurance excess not resolved — must be taken or waived before book-out');
        }
      }

      if (gateBlockers.length > 0) {
        res.status(409).json({
          error: 'Book-out blocked',
          blockers: gateBlockers,
        });
        return;
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
           updated_at = NOW()
       WHERE id = $4
       RETURNING *`,
      [req.user!.id, mileage_out, fuel_level_out, id]
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

    res.json({ data: assignment });
  } catch (error) {
    console.error('[assignments] Book-out error:', error);
    res.status(500).json({ error: 'Failed to record book-out' });
  }
});

// ── POST /api/assignments/:id/check-in — Record check-in data ──

router.post('/:id/check-in', validate(checkInSchema), async (req: AuthRequest, res: Response) => {
  try {
    const { id } = req.params;
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

    // Update vehicle hire_status to Prep Needed (only if vehicle assigned)
    if (assignment.vehicle_id) {
      await query(
        `UPDATE fleet_vehicles SET hire_status = 'Prep Needed' WHERE id = $1`,
        [assignment.vehicle_id]
      );
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

router.get('/dispatch-check/:jobId', async (req: AuthRequest, res: Response) => {
  try {
    const { jobId } = req.params;

    // Find all self_drive assignments for this job with excess + referral status
    const result = await query(
      `SELECT vha.id AS assignment_id,
        vha.status AS assignment_status,
        d.full_name AS driver_name,
        fv.reg AS vehicle_reg,
        je.excess_amount_required,
        je.excess_status,
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
      driverName: string | null;
      vehicleReg: string | null;
      amountRequired: number | null;
    }> = [];

    for (const row of result.rows) {
      // Check excess status
      if (row.excess_status && !['taken', 'waived', 'rolled_over', 'not_required'].includes(row.excess_status)) {
        blockers.push({
          type: 'excess_pending',
          assignmentId: row.assignment_id,
          driverName: row.driver_name,
          vehicleReg: row.vehicle_reg,
          amountRequired: row.excess_amount_required ? parseFloat(row.excess_amount_required) : null,
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
      allocatedAt: row.created_at,
      allocatedBy: row.allocated_by_name || 'Unknown',
      confirmedAt: row.status !== 'soft' ? row.status_changed_at : null,
    }));

    res.json({ allocations });
  } catch (error) {
    console.error('[assignments/compat] Get allocations error:', error);
    res.status(500).json({ error: 'Failed to load allocations' });
  }
});

// ── POST /api/assignments/compat/allocations — Save old-format allocations ──
// Converts VanAllocation[] to assignment rows. Used by existing frontend.

router.post('/compat/allocations', async (req: AuthRequest, res: Response) => {
  try {
    const { allocations } = req.body;

    if (!Array.isArray(allocations)) {
      res.status(400).json({ error: 'allocations array required' });
      return;
    }

    // Collect the set of job IDs being managed in this save request.
    // We must ONLY touch assignments for jobs that are in the incoming list.
    // The Allocations page only shows a subset of jobs (e.g. today/tomorrow),
    // so we must not cancel assignments for jobs outside that scope.
    const incomingJobIds = new Set<number>(
      allocations.map((a: any) => Number(a.hireHopJobId)).filter((n: number) => !isNaN(n))
    );

    // Only load existing assignments for jobs that are in the incoming payload
    const existing = incomingJobIds.size > 0
      ? await query(
          `SELECT id, hirehop_job_id, van_requirement_index, vehicle_id, driver_id, notes
           FROM vehicle_hire_assignments
           WHERE status IN ('soft', 'confirmed')
             AND hirehop_job_id = ANY($1)`,
          [Array.from(incomingJobIds)]
        )
      : { rows: [] };

    const existingMap = new Map(
      existing.rows.map((r: any) => [`${r.hirehop_job_id}-${r.van_requirement_index}`, r])
    );

    const incomingIds = new Set<string>();

    for (const alloc of allocations) {
      const key = `${alloc.hireHopJobId}-${alloc.vanRequirementIndex}`;
      incomingIds.add(key);

      const existingRow = existingMap.get(key);

      // Resolve driver_id from driverName if provided
      let driverId: string | null = alloc.driverId || null;
      const driverName = alloc.driverName || null;
      if (driverName && !driverId) {
        const dResult = await query(
          `SELECT id FROM drivers WHERE full_name ILIKE $1 AND is_active = true ORDER BY updated_at DESC LIMIT 1`,
          [driverName.trim()]
        );
        driverId = dResult.rows[0]?.id || null;
      }

      if (existingRow) {
        // Update existing — resolve vehicle by reg if needed
        let vehicleId = alloc.vehicleId;
        if (!vehicleId || !/^[0-9a-f-]{36}$/i.test(vehicleId)) {
          const vResult = await query(
            'SELECT id FROM fleet_vehicles WHERE reg = $1',
            [alloc.vehicleReg?.toUpperCase()]
          );
          vehicleId = vResult.rows[0]?.id || existingRow.vehicle_id;
        }

        await query(
          `UPDATE vehicle_hire_assignments
           SET vehicle_id = $1,
               hirehop_job_name = $2,
               status = $3,
               allocated_by_name = $4,
               notes = $5,
               driver_id = COALESCE($6, driver_id),
               updated_at = NOW()
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
        // Create new — resolve vehicle by reg
        let vehicleId = alloc.vehicleId;
        if (!vehicleId || !/^[0-9a-f-]{36}$/i.test(vehicleId)) {
          const vResult = await query(
            'SELECT id FROM fleet_vehicles WHERE reg = $1',
            [alloc.vehicleReg?.toUpperCase()]
          );
          if (!vResult.rows[0]) continue; // Skip if vehicle not found
          vehicleId = vResult.rows[0].id;
        }

        await query(
          `INSERT INTO vehicle_hire_assignments (
            vehicle_id, hirehop_job_id, hirehop_job_name,
            van_requirement_index, status, allocated_by_name,
            notes, driver_id,
            assignment_type, created_by
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'self_drive', $9)`,
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
      }
    }

    // Cancel assignments that are no longer in the incoming list
    for (const [key, row] of existingMap) {
      if (!incomingIds.has(key)) {
        await query(
          `UPDATE vehicle_hire_assignments
           SET status = 'cancelled', status_changed_at = NOW(), updated_at = NOW()
           WHERE id = $1`,
          [(row as any).id]
        );
      }
    }

    res.json({ success: true });
  } catch (error) {
    console.error('[assignments/compat] Save allocations error:', error);
    res.status(500).json({ error: 'Failed to save allocations' });
  }
});

export default router;
