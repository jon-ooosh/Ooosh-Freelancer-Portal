/**
 * Hire Form Routes — composite endpoints for the driver hire form flow.
 *
 * POST /api/hire-forms creates or updates a driver record, creates a
 * vehicle_hire_assignment, calculates the excess, and creates a job_excess
 * record — all in one transactional call.
 */
import { Router, Response, NextFunction } from 'express';
import { z } from 'zod';
import crypto from 'crypto';
import { query, getPool } from '../config/database';
import { authenticate, AuthRequest } from '../middleware/auth';
import { validate } from '../middleware/validate';
import { generateHireFormPdf, fetchLogo, type HireFormData } from '../services/hire-form-pdf';
import { uploadToR2, getFromR2 } from '../config/r2';
import { emailService } from '../services/email-service';

/** Format a date string/Date to "18 Mar 2026" */
function fmtDate(d?: string | Date | null): string {
  if (!d) return 'TBC';
  const dt = typeof d === 'string' ? new Date(d) : d;
  if (isNaN(dt.getTime())) return 'TBC';
  return dt.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
}

const router = Router();

/**
 * Dual auth: accepts OP user JWT OR HIRE_FORM_API_KEY.
 * Used on POST /api/hire-forms which is called by both:
 *   - OP frontend (user JWT)
 *   - Netlify generate-hire-form.js function (API key)
 */
function authenticateOrApiKey(req: AuthRequest, res: Response, next: NextFunction): void {
  // Try API key first (server-to-server from Netlify functions)
  const apiKey = req.headers['x-api-key'] as string;
  if (apiKey && process.env.HIRE_FORM_API_KEY) {
    try {
      const expected = Buffer.from(process.env.HIRE_FORM_API_KEY);
      const provided = Buffer.from(apiKey);
      if (expected.length === provided.length && crypto.timingSafeEqual(expected, provided)) {
        // API key auth — set a service user identity
        req.user = { id: '00000000-0000-0000-0000-000000000000', email: 'hire-form@system', role: 'admin' };
        next();
        return;
      }
    } catch {
      // Fall through to JWT auth
    }
  }

  // Fall back to standard JWT auth
  authenticate(req, res, next);
}

// NOTE: No global router.use(authenticate) — auth is per-route.
// POST / uses authenticateOrApiKey (Netlify functions + OP frontend)
// All other routes use authenticate (OP frontend only)

// ── Schemas ──

const endorsementSchema = z.object({
  code: z.string().max(10),
  points: z.number().int().min(0),
  date: z.string().nullable().optional(),
  expiry: z.string().nullable().optional(),
});

const hireFormSchema = z.object({
  // Driver details
  driver_id: z.string().uuid().nullable().optional(),        // If updating existing driver
  full_name: z.string().min(1).max(200),
  email: z.string().email().nullable().optional(),
  phone: z.string().max(50).nullable().optional(),
  date_of_birth: z.string().nullable().optional(),
  address_line1: z.string().max(255).nullable().optional(),
  address_line2: z.string().max(255).nullable().optional(),
  city: z.string().max(100).nullable().optional(),
  postcode: z.string().max(20).nullable().optional(),
  licence_number: z.string().max(50).nullable().optional(),
  licence_type: z.string().max(20).nullable().optional(),
  licence_valid_from: z.string().nullable().optional(),
  licence_valid_to: z.string().nullable().optional(),
  licence_issue_country: z.string().max(100).optional().default('GB'),
  licence_points: z.number().int().min(0).optional().default(0),
  licence_endorsements: z.array(endorsementSchema).optional().default([]),
  licence_restrictions: z.string().nullable().optional(),
  dvla_check_code: z.string().max(50).nullable().optional(),
  dvla_check_date: z.string().nullable().optional(),

  // Assignment details — vehicle_id OR vehicle_reg, both optional (vehicle assigned later)
  vehicle_id: z.string().uuid().nullable().optional(),
  vehicle_reg: z.string().max(20).nullable().optional(),   // Alternative: look up UUID by reg
  job_id: z.string().uuid().nullable().optional(),
  hirehop_job_id: z.number().int().nullable().optional(),
  hirehop_job_name: z.string().max(500).nullable().optional(),
  van_requirement_index: z.number().int().min(0).default(0),
  required_type: z.string().max(50).nullable().optional(),
  required_gearbox: z.string().max(10).nullable().optional(),
  hire_start: z.string().nullable().optional(),
  hire_end: z.string().nullable().optional(),
  start_time: z.string().nullable().optional(),
  end_time: z.string().nullable().optional(),
  return_overnight: z.boolean().nullable().optional(),
  ve103b_ref: z.string().max(100).nullable().optional(),
  client_email: z.string().email().nullable().optional(),

  // Excess — passed from hire form app (DVLA-calculated), NOT recalculated here
  excess_amount: z.number().min(0).nullable().optional(),
  excess_calculation_basis: z.string().nullable().optional(),
  requires_referral: z.boolean().optional(),
  referral_reason: z.string().nullable().optional(),

  // Xero
  xero_contact_id: z.string().max(100).nullable().optional(),
  xero_contact_name: z.string().max(200).nullable().optional(),
  client_name: z.string().max(200).nullable().optional(),
});

// ── POST /api/hire-forms — Submit completed hire form ──

/**
 * camelCase → snake_case transform for Netlify function compatibility.
 * The hire form app sends camelCase; the schema expects snake_case.
 */
function normalizeHireFormBody(body: Record<string, unknown>): Record<string, unknown> {
  const map: Record<string, string> = {
    driverId: 'driver_id',
    fullName: 'full_name',
    dateOfBirth: 'date_of_birth',
    addressLine1: 'address_line1',
    addressLine2: 'address_line2',
    licenceNumber: 'licence_number',
    licenseNumber: 'licence_number',
    licenceType: 'licence_type',
    licenceValidFrom: 'licence_valid_from',
    licenceValidTo: 'licence_valid_to',
    licenceIssueCountry: 'licence_issue_country',
    licenceIssuedBy: 'licence_issue_country',
    licencePoints: 'licence_points',
    licenceEndorsements: 'licence_endorsements',
    licenceRestrictions: 'licence_restrictions',
    dvlaCheckCode: 'dvla_check_code',
    dvlaCheckDate: 'dvla_check_date',
    vehicleId: 'vehicle_id',
    vehicleReg: 'vehicle_reg',
    jobId: 'job_id',
    hirehopJobId: 'hirehop_job_id',
    hirehopJobName: 'hirehop_job_name',
    hireHopJobId: 'hirehop_job_id',
    hireHopJobName: 'hirehop_job_name',
    vanRequirementIndex: 'van_requirement_index',
    requiredType: 'required_type',
    requiredGearbox: 'required_gearbox',
    hireStart: 'hire_start',
    hireEnd: 'hire_end',
    startTime: 'start_time',
    endTime: 'end_time',
    returnOvernight: 'return_overnight',
    ve103bRef: 've103b_ref',
    clientEmail: 'client_email',
    excessAmount: 'excess_amount',
    excessCalculationBasis: 'excess_calculation_basis',
    requiresReferral: 'requires_referral',
    referralReason: 'referral_reason',
    xeroContactId: 'xero_contact_id',
    xeroContactName: 'xero_contact_name',
    clientName: 'client_name',
  };

  // Fields that must be coerced from string to number (hire form app sends strings)
  const numericFields = new Set([
    'hirehop_job_id', 'van_requirement_index', 'licence_points', 'excess_amount',
  ]);

  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(body)) {
    const snakeKey = map[key] || key;
    // Don't overwrite if the snake_case key is already set
    if (!(snakeKey in result) || result[snakeKey] == null) {
      // Coerce string→number for numeric fields (hire form app sends strings from form inputs)
      if (numericFields.has(snakeKey) && typeof value === 'string' && value.trim() !== '') {
        const parsed = Number(value);
        result[snakeKey] = isNaN(parsed) ? null : parsed;
      } else {
        result[snakeKey] = value;
      }
    }
  }
  return result;
}

router.post('/', authenticateOrApiKey, (req: AuthRequest, _res: Response, next: NextFunction) => {
  // Transform camelCase to snake_case before validation
  req.body = normalizeHireFormBody(req.body);
  next();
}, validate(hireFormSchema), async (req: AuthRequest, res: Response) => {
  const pool = getPool();
  const client = await pool.connect();

  try {
    const f = req.body;
    await client.query('BEGIN');

    // 1. Create or update driver
    let driverId: string;

    // Try to find existing driver by email if no driver_id provided
    if (!f.driver_id && f.email) {
      const existingDriver = await client.query(
        `SELECT id FROM drivers WHERE email = $1 AND is_active = true ORDER BY updated_at DESC LIMIT 1`,
        [f.email]
      );
      if (existingDriver.rows[0]) {
        f.driver_id = existingDriver.rows[0].id;
      }
    }

    if (f.driver_id) {
      // Update existing driver with latest details
      await client.query(
        `UPDATE drivers SET
          full_name = $1, email = $2, phone = $3, date_of_birth = $4,
          address_line1 = $5, address_line2 = $6, city = $7, postcode = $8,
          licence_number = $9, licence_type = $10, licence_valid_from = $11, licence_valid_to = $12,
          licence_issue_country = $13, licence_points = $14, licence_endorsements = $15,
          licence_restrictions = $16, dvla_check_code = $17, dvla_check_date = $18,
          updated_at = NOW()
        WHERE id = $19`,
        [
          f.full_name, f.email || null, f.phone || null, f.date_of_birth || null,
          f.address_line1 || null, f.address_line2 || null, f.city || null, f.postcode || null,
          f.licence_number || null, f.licence_type || null, f.licence_valid_from || null, f.licence_valid_to || null,
          f.licence_issue_country, f.licence_points, JSON.stringify(f.licence_endorsements),
          f.licence_restrictions || null, f.dvla_check_code || null, f.dvla_check_date || null,
          f.driver_id,
        ]
      );
      driverId = f.driver_id;
    } else {
      // Create new driver
      const driverResult = await client.query(
        `INSERT INTO drivers (
          full_name, email, phone, date_of_birth,
          address_line1, address_line2, city, postcode,
          licence_number, licence_type, licence_valid_from, licence_valid_to,
          licence_issue_country, licence_points, licence_endorsements, licence_restrictions,
          dvla_check_code, dvla_check_date,
          source, created_by
        ) VALUES (
          $1, $2, $3, $4,
          $5, $6, $7, $8,
          $9, $10, $11, $12,
          $13, $14, $15, $16,
          $17, $18,
          'hire_form', $19
        ) RETURNING id`,
        [
          f.full_name, f.email || null, f.phone || null, f.date_of_birth || null,
          f.address_line1 || null, f.address_line2 || null, f.city || null, f.postcode || null,
          f.licence_number || null, f.licence_type || null, f.licence_valid_from || null, f.licence_valid_to || null,
          f.licence_issue_country, f.licence_points, JSON.stringify(f.licence_endorsements),
          f.licence_restrictions || null, f.dvla_check_code || null, f.dvla_check_date || null,
          req.user!.id,
        ]
      );
      driverId = driverResult.rows[0].id;
    }

    // 2. Referral status — accept from hire form app or detect from endorsements
    const requiresReferral = f.requires_referral || false;
    const referralReason = f.referral_reason || '';

    if (requiresReferral) {
      await client.query(
        `UPDATE drivers SET requires_referral = true, referral_status = 'pending', referral_notes = $1 WHERE id = $2`,
        [referralReason, driverId]
      );
    }

    // 3. Excess amount — passed from hire form app, NOT recalculated here
    //    The hire form app calculates excess from DVLA points during the verification flow.
    //    We store whatever they send. If nothing sent, store null (UI shows red alert).
    const excessAmount: number | null = f.excess_amount ?? null;
    const calculationBasis = f.excess_calculation_basis || (requiresReferral ? `Referral required: ${referralReason}` : '');

    // 4. Resolve vehicle_id from vehicle_reg if needed
    let vehicleId = f.vehicle_id || null;
    if (!vehicleId && f.vehicle_reg) {
      const vResult = await client.query(
        'SELECT id FROM fleet_vehicles WHERE reg = $1',
        [f.vehicle_reg.toUpperCase()]
      );
      vehicleId = vResult.rows[0]?.id || null;
    }

    // 5. Resolve job_id from hirehop_job_id if needed
    let jobId = f.job_id || null;
    if (!jobId && f.hirehop_job_id) {
      const jResult = await client.query(
        'SELECT id FROM jobs WHERE hh_job_number = $1 LIMIT 1',
        [f.hirehop_job_id]
      );
      jobId = jResult.rows[0]?.id || null;
    }

    // 6. Create vehicle hire assignment
    const assignmentResult = await client.query(
      `INSERT INTO vehicle_hire_assignments (
        vehicle_id, job_id, hirehop_job_id, hirehop_job_name,
        driver_id, assignment_type,
        van_requirement_index, required_type, required_gearbox,
        status, status_changed_at,
        hire_start, hire_end, start_time, end_time, return_overnight,
        ve103b_ref, created_by
      ) VALUES (
        $1, $2, $3, $4,
        $5, 'self_drive',
        $6, $7, $8,
        'confirmed', NOW(),
        $9, $10, $11, $12, $13,
        $14, $15
      ) RETURNING *`,
      [
        vehicleId, jobId, f.hirehop_job_id || null, f.hirehop_job_name || null,
        driverId,
        f.van_requirement_index, f.required_type || null, f.required_gearbox || null,
        f.hire_start || null, f.hire_end || null, f.start_time || null, f.end_time || null, f.return_overnight ?? null,
        f.ve103b_ref || null, req.user!.id,
      ]
    );

    const assignment = assignmentResult.rows[0];

    // 7. Create excess record (stores whatever the hire form app calculated)
    const excessResult = await client.query(
      `INSERT INTO job_excess (
        assignment_id, job_id, hirehop_job_id,
        excess_amount_required, excess_calculation_basis,
        excess_status,
        xero_contact_id, xero_contact_name, client_name,
        created_by
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
      RETURNING *`,
      [
        assignment.id, jobId, f.hirehop_job_id || null,
        excessAmount, calculationBasis,
        'pending',
        f.xero_contact_id || null, f.xero_contact_name || null, f.client_name || null,
        req.user!.id,
      ]
    );

    await client.query('COMMIT');

    console.log(`[hire-forms] Created: driver=${driverId}, assignment=${assignment.id}, vehicle=${vehicleId || 'none'}, job=${f.hirehop_job_id || 'none'}, excess=${excessAmount || 'none'}`);

    res.status(201).json({
      data: {
        driver_id: driverId,
        assignment: assignment,
        excess: excessResult.rows[0],
        requires_referral: requiresReferral,
        referral_reason: requiresReferral ? referralReason : null,
      },
    });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('[hire-forms] Submit error:', error);
    res.status(500).json({ error: 'Failed to submit hire form' });
  } finally {
    client.release();
  }
});

// ── GET /api/hire-forms/by-job/:hirehopJobId — Get hire forms for a job ──

router.get('/by-job/:hirehopJobId', authenticate, async (req: AuthRequest, res: Response) => {
  try {
    const hirehopJobId = parseInt(req.params.hirehopJobId as string);

    const result = await query(
      `SELECT vha.*,
        fv.reg AS vehicle_reg,
        d.full_name AS driver_name,
        d.email AS driver_email,
        d.licence_points AS driver_points,
        d.requires_referral,
        je.excess_amount_required,
        je.excess_amount_taken,
        je.excess_status
      FROM vehicle_hire_assignments vha
      LEFT JOIN fleet_vehicles fv ON fv.id = vha.vehicle_id
      LEFT JOIN drivers d ON d.id = vha.driver_id
      LEFT JOIN job_excess je ON je.assignment_id = vha.id
      WHERE vha.hirehop_job_id = $1
        AND vha.assignment_type = 'self_drive'
        AND vha.status != 'cancelled'
      ORDER BY vha.van_requirement_index ASC`,
      [hirehopJobId]
    );

    res.json({ data: result.rows });
  } catch (error) {
    console.error('[hire-forms] By job error:', error);
    res.status(500).json({ error: 'Failed to load hire forms' });
  }
});

// ── GET /api/hire-forms/by-driver/:driverId — Get all forms for a driver ──

router.get('/by-driver/:driverId', authenticate, async (req: AuthRequest, res: Response) => {
  try {
    const { driverId } = req.params;

    const result = await query(
      `SELECT vha.*,
        fv.reg AS vehicle_reg,
        je.excess_amount_required,
        je.excess_status
      FROM vehicle_hire_assignments vha
      LEFT JOIN fleet_vehicles fv ON fv.id = vha.vehicle_id
      LEFT JOIN job_excess je ON je.assignment_id = vha.id
      WHERE vha.driver_id = $1
        AND vha.assignment_type = 'self_drive'
      ORDER BY vha.created_at DESC`,
      [driverId]
    );

    res.json({ data: result.rows });
  } catch (error) {
    console.error('[hire-forms] By driver error:', error);
    res.status(500).json({ error: 'Failed to load hire forms' });
  }
});

// ── GET /api/hire-forms/active — All active assignments with drivers + unassigned drivers ──

router.get('/active', authenticate, async (_req: AuthRequest, res: Response) => {
  try {
    // Assignments with real drivers linked (from hire form submissions)
    const assignedResult = await query(
      `SELECT vha.*,
        fv.reg AS vehicle_reg,
        d.full_name AS driver_name,
        d.email AS driver_email,
        d.licence_points AS driver_points,
        d.requires_referral,
        je.excess_amount_required,
        je.excess_amount_taken,
        je.excess_status
      FROM vehicle_hire_assignments vha
      LEFT JOIN fleet_vehicles fv ON fv.id = vha.vehicle_id
      LEFT JOIN drivers d ON d.id = vha.driver_id
      LEFT JOIN job_excess je ON je.assignment_id = vha.id
      WHERE vha.assignment_type = 'self_drive'
        AND vha.status != 'cancelled'
        AND d.id IS NOT NULL
        AND d.full_name IS NOT NULL
        AND d.full_name != ''
      ORDER BY vha.created_at DESC
      LIMIT 100`
    );

    // Second: active drivers not yet assigned to any job (available for selection)
    const unassignedResult = await query(
      `SELECT d.id AS driver_id, d.full_name AS driver_name, d.email AS driver_email,
        d.licence_points AS driver_points, d.requires_referral
      FROM drivers d
      WHERE d.is_active = true
        AND d.full_name IS NOT NULL
        AND d.full_name != ''
        AND NOT EXISTS (
          SELECT 1 FROM vehicle_hire_assignments vha
          WHERE vha.driver_id = d.id AND vha.status != 'cancelled'
        )
      ORDER BY d.full_name
      LIMIT 50`
    );

    // Combine: assigned first, then unassigned (with synthetic shape)
    const combined = [
      ...assignedResult.rows,
      ...unassignedResult.rows.map((d: any) => ({
        id: `unassigned-${d.driver_id}`,
        driver_id: d.driver_id,
        driver_name: d.driver_name,
        driver_email: d.driver_email,
        driver_points: d.driver_points,
        requires_referral: d.requires_referral,
        hirehop_job_id: null,
        hirehop_job_name: null,
        vehicle_id: null,
        vehicle_reg: null,
        status: 'available',
        assignment_type: 'self_drive',
      })),
    ];

    res.json({ data: combined });
  } catch (error) {
    console.error('[hire-forms] Active forms error:', error);
    res.status(500).json({ error: 'Failed to load active hire forms' });
  }
});

// ── POST /api/hire-forms/quick-assign — Quick-create assignment for testing ──

const quickAssignSchema = z.object({
  driver_id: z.string().uuid(),
  vehicle_id: z.string().uuid(),
  job_id: z.string().uuid(),
  hire_start: z.string().optional(),
  hire_end: z.string().optional(),
  client_email: z.string().email().optional(),
});

router.post('/quick-assign', authenticate, validate(quickAssignSchema), async (req: AuthRequest, res: Response) => {
  try {
    const f = req.body;

    // Look up the HireHop job number from the jobs table
    const jobResult = await query(`SELECT hh_job_number, job_name FROM jobs WHERE id = $1`, [f.job_id]);
    const hhJobId = jobResult.rows[0]?.hh_job_number || null;
    const hhJobName = jobResult.rows[0]?.job_name || null;

    // Create assignment
    const result = await query(
      `INSERT INTO vehicle_hire_assignments (
        vehicle_id, job_id, hirehop_job_id, hirehop_job_name,
        driver_id, assignment_type,
        status, status_changed_at,
        hire_start, hire_end, client_email,
        created_by
      ) VALUES ($1, $2, $3, $4, $5, 'self_drive', 'confirmed', NOW(), $6, $7, $8, $9)
      RETURNING *`,
      [
        f.vehicle_id, f.job_id, hhJobId, hhJobName,
        f.driver_id,
        f.hire_start || null, f.hire_end || null, f.client_email || null,
        req.user!.id,
      ]
    );

    // Also create an excess record
    const assignment = result.rows[0];
    const driverResult = await query(`SELECT licence_points FROM drivers WHERE id = $1`, [f.driver_id]);
    const points = driverResult.rows[0]?.licence_points || 0;

    const tierResult = await query(
      `SELECT * FROM excess_rules WHERE is_active = true AND rule_type = 'points_tier'
       AND condition_min <= $1 AND condition_max >= $1 ORDER BY sort_order LIMIT 1`,
      [points]
    );
    const excessAmount = tierResult.rows[0]?.excess_amount ? parseFloat(tierResult.rows[0].excess_amount) : null;

    await query(
      `INSERT INTO job_excess (assignment_id, job_id, hirehop_job_id, excess_amount_required, excess_calculation_basis, excess_status, created_by)
       VALUES ($1, $2, $3, $4, $5, 'pending', $6)`,
      [assignment.id, f.job_id, hhJobId, excessAmount, `${points} points`, req.user!.id]
    );

    console.log(`[hire-forms] Quick assignment created: ${assignment.id} (driver ${f.driver_id} → vehicle ${f.vehicle_id} on job ${f.job_id})`);
    res.status(201).json({ data: assignment });
  } catch (error) {
    console.error('[hire-forms] Quick assign error:', error);
    res.status(500).json({ error: 'Failed to create assignment' });
  }
});

// ── GET /api/hire-forms/options — Get available drivers and vehicles for assignment ──

router.get('/options/lists', authenticate, async (_req: AuthRequest, res: Response) => {
  try {
    const drivers = await query(
      `SELECT id, full_name, email, licence_points FROM drivers WHERE is_active = true ORDER BY full_name`
    );
    const vehicles = await query(
      `SELECT id, reg, vehicle_type, simple_type, hire_status FROM fleet_vehicles WHERE hire_status != 'Sold' ORDER BY reg`
    );
    res.json({
      drivers: drivers.rows,
      vehicles: vehicles.rows,
    });
  } catch (error) {
    console.error('[hire-forms] Options error:', error);
    res.status(500).json({ error: 'Failed to load options' });
  }
});

// ── GET /api/hire-forms/:id — Get single hire form with full details ──

router.get('/:id', authenticateOrApiKey, async (req: AuthRequest, res: Response) => {
  try {
    const { id } = req.params;

    const result = await query(
      `SELECT vha.*,
        fv.reg AS vehicle_reg,
        fv.vehicle_type AS vehicle_model,
        d.full_name AS driver_name,
        d.email AS driver_email,
        d.phone AS driver_phone,
        d.phone_country AS driver_phone_country,
        d.date_of_birth AS driver_dob,
        d.address_full AS driver_home_address,
        d.address_line1 AS driver_address_line1,
        d.address_line2 AS driver_address_line2,
        d.city AS driver_city,
        d.postcode AS driver_postcode,
        d.licence_address AS driver_licence_address,
        d.licence_number AS driver_licence_number,
        d.licence_issued_by AS driver_licence_issued_by,
        d.licence_valid_to AS driver_licence_valid_to,
        d.date_passed_test AS driver_date_passed_test,
        d.licence_points AS driver_points,
        d.requires_referral,
        d.signature_date AS driver_signature_date,
        d.files AS driver_files,
        je.excess_amount_required,
        je.excess_amount_taken,
        je.excess_status
      FROM vehicle_hire_assignments vha
      LEFT JOIN fleet_vehicles fv ON fv.id = vha.vehicle_id
      LEFT JOIN drivers d ON d.id = vha.driver_id
      LEFT JOIN job_excess je ON je.assignment_id = vha.id
      WHERE vha.id = $1`,
      [id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Hire form not found' });
    }

    res.json({ data: result.rows[0] });
  } catch (error) {
    console.error('[hire-forms] Get by ID error:', error);
    res.status(500).json({ error: 'Failed to load hire form' });
  }
});

// ── PATCH /api/hire-forms/:id — Update hire assignment (mid-hire changes) ──

const patchSchema = z.object({
  vehicle_id: z.string().uuid().optional(),
  hire_end: z.string().optional(),
  start_time: z.string().optional(),
  end_time: z.string().optional(),
  ve103b_ref: z.string().max(100).optional(),
  return_overnight: z.boolean().nullable().optional(),
  client_email: z.string().email().nullable().optional(),
  status: z.enum(['soft', 'confirmed', 'booked_out', 'active', 'returned', 'cancelled']).optional(),
  notes: z.string().optional(),
});

router.patch('/:id', authenticate, validate(patchSchema), async (req: AuthRequest, res: Response) => {
  try {
    const { id } = req.params;
    const updates = req.body;

    // Build dynamic SET clause
    const setClauses: string[] = [];
    const values: any[] = [];
    let paramIdx = 1;

    const fieldMap: Record<string, string> = {
      vehicle_id: 'vehicle_id',
      hire_end: 'hire_end',
      start_time: 'start_time',
      end_time: 'end_time',
      ve103b_ref: 've103b_ref',
      return_overnight: 'return_overnight',
      client_email: 'client_email',
      status: 'status',
      notes: 'notes',
    };

    for (const [key, col] of Object.entries(fieldMap)) {
      if (updates[key] !== undefined) {
        setClauses.push(`${col} = $${paramIdx}`);
        values.push(updates[key]);
        paramIdx++;
      }
    }

    if (updates.status) {
      setClauses.push(`status_changed_at = NOW()`);
    }

    setClauses.push('updated_at = NOW()');

    if (setClauses.length === 1) {
      // Only updated_at — nothing to change
      return res.status(400).json({ error: 'No fields to update' });
    }

    values.push(id);

    const result = await query(
      `UPDATE vehicle_hire_assignments SET ${setClauses.join(', ')} WHERE id = $${paramIdx} RETURNING *`,
      values
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Hire form not found' });
    }

    console.log(`[hire-forms] Updated assignment ${id}:`, Object.keys(updates).join(', '));
    res.json({ data: result.rows[0] });
  } catch (error) {
    console.error('[hire-forms] Patch error:', error);
    res.status(500).json({ error: 'Failed to update hire form' });
  }
});

// ── Helper: load full data for PDF generation ──

async function loadHireFormData(assignmentId: string): Promise<HireFormData | null> {
  const result = await query(
    `SELECT vha.*,
      fv.reg AS vehicle_reg,
      fv.vehicle_type AS vehicle_model,
      d.full_name AS driver_name,
      d.email AS driver_email,
      d.phone AS driver_phone,
      d.phone_country AS driver_phone_country,
      d.date_of_birth AS driver_dob,
      d.address_full AS driver_home_address,
      d.address_line1 AS driver_address_line1,
      d.address_line2 AS driver_address_line2,
      d.city AS driver_city,
      d.postcode AS driver_postcode,
      d.licence_address AS driver_licence_address,
      d.licence_number AS driver_licence_number,
      d.licence_issued_by AS driver_licence_issued_by,
      d.licence_valid_to AS driver_licence_valid_to,
      d.date_passed_test AS driver_date_passed_test,
      d.signature_date AS driver_signature_date,
      d.files AS driver_files,
      je.excess_amount_required,
      je.excess_status
    FROM vehicle_hire_assignments vha
    LEFT JOIN fleet_vehicles fv ON fv.id = vha.vehicle_id
    LEFT JOIN drivers d ON d.id = vha.driver_id
    LEFT JOIN job_excess je ON je.assignment_id = vha.id
    WHERE vha.id = $1`,
    [assignmentId]
  );

  if (result.rows.length === 0) return null;

  const row = result.rows[0];

  // Build home address from parts if address_full not available
  const homeAddress = row.driver_home_address || [
    row.driver_address_line1, row.driver_address_line2,
    row.driver_city, row.driver_postcode,
  ].filter(Boolean).join(', ');

  // Format excess amount
  let excessStr = '';
  if (row.excess_amount_required) {
    excessStr = `\u00A3${parseFloat(row.excess_amount_required).toLocaleString('en-GB', { minimumFractionDigits: 0 })}`;
  }

  // Try to load signature from driver files (look for tag 'signature')
  let signatureImage: Buffer | null = null;
  if (row.driver_files) {
    const files = typeof row.driver_files === 'string' ? JSON.parse(row.driver_files) : row.driver_files;
    const sigFile = Array.isArray(files) ? files.find((f: any) => f.tag === 'signature') : null;
    if (sigFile?.r2_key) {
      try {
        const resp = await getFromR2(sigFile.r2_key);
        if (resp.Body) {
          const chunks: Buffer[] = [];
          const stream = resp.Body as NodeJS.ReadableStream;
          for await (const chunk of stream) {
            chunks.push(Buffer.from(chunk as Uint8Array));
          }
          signatureImage = Buffer.concat(chunks);
        }
      } catch (e) {
        console.log('[hire-forms] Could not load signature from R2');
      }
    }
  }

  const logoImage = await fetchLogo();

  return {
    driverName: row.driver_name || '',
    email: row.driver_email || row.client_email || '',
    phoneCountry: row.driver_phone_country || '',
    phoneNumber: row.driver_phone || '',
    dateOfBirth: row.driver_dob ? String(row.driver_dob).split('T')[0] : undefined,
    homeAddress,
    licenceAddress: row.driver_licence_address || undefined,
    licenceNumber: row.driver_licence_number || '',
    licenceIssuedBy: row.driver_licence_issued_by || '',
    licenceValidTo: row.driver_licence_valid_to ? String(row.driver_licence_valid_to).split('T')[0] : undefined,
    datePassedTest: row.driver_date_passed_test ? String(row.driver_date_passed_test).split('T')[0] : undefined,
    vehicleReg: row.vehicle_reg || '',
    vehicleModel: row.vehicle_model || '',
    hireStartDate: row.hire_start ? String(row.hire_start).split('T')[0] : undefined,
    hireStartTime: row.start_time ? String(row.start_time) : undefined,
    hireEndDate: row.hire_end ? String(row.hire_end).split('T')[0] : undefined,
    hireEndTime: row.end_time ? String(row.end_time) : undefined,
    insuranceExcess: excessStr || undefined,
    hireFormNumber: `OT-HF-${assignmentId.substring(0, 8).toUpperCase()}`,
    contractNumber: row.hirehop_job_id ? String(row.hirehop_job_id) : '',
    signatureDate: row.driver_signature_date ? String(row.driver_signature_date).split('T')[0] : undefined,
    signatureImage,
    logoImage,
  };
}

// ── POST /api/hire-forms/:id/generate-pdf — Generate hire form PDF ──

router.post('/:id/generate-pdf', authenticateOrApiKey, async (req: AuthRequest, res: Response) => {
  try {
    const id = req.params.id as string;
    const sendEmail = req.query.send_email === 'true';

    // Load all data
    const formData = await loadHireFormData(id);
    if (!formData) {
      return res.status(404).json({ error: 'Hire form not found' });
    }

    // Generate PDF
    const { pdfBytes, filename } = await generateHireFormPdf(formData);

    // Upload to R2
    const r2Key = `hire-forms/${id}/${filename}`;
    await uploadToR2(r2Key, Buffer.from(pdfBytes), 'application/pdf');

    // Update assignment record
    await query(
      `UPDATE vehicle_hire_assignments
       SET hire_form_pdf_key = $1, hire_form_generated_at = NOW(), updated_at = NOW()
       WHERE id = $2`,
      [r2Key, id]
    );

    console.log(`[hire-forms] PDF generated and stored: ${r2Key} (${pdfBytes.length} bytes)`);

    // Send email if requested
    let emailResult = null;
    if (sendEmail && formData.email) {
      emailResult = await emailService.send('hire_form', {
        to: formData.email,
        variables: {
          driverName: formData.driverName,
          vehicleReg: formData.vehicleReg || 'TBC',
          vehicleModel: formData.vehicleModel || 'TBC',
          hireStart: fmtDate(formData.hireStartDate),
          hireEnd: fmtDate(formData.hireEndDate),
        },
        attachments: [{
          filename,
          content: Buffer.from(pdfBytes),
          contentType: 'application/pdf',
        }],
      });

      if (emailResult.success) {
        await query(
          `UPDATE vehicle_hire_assignments SET hire_form_emailed_at = NOW() WHERE id = $1`,
          [id]
        );
        console.log(`[hire-forms] Email sent for ${id}`);
      }
    }

    res.json({
      data: {
        pdf_key: r2Key,
        filename,
        size: pdfBytes.length,
        email_sent: emailResult?.success || false,
        email_redirected_to: emailResult?.redirectedTo || null,
      },
    });
  } catch (error) {
    console.error('[hire-forms] Generate PDF error:', error);
    res.status(500).json({ error: 'Failed to generate hire form PDF' });
  }
});

// ── POST /api/hire-forms/:id/send-email — Re-send hire form email ──

router.post('/:id/send-email', authenticateOrApiKey, async (req: AuthRequest, res: Response) => {
  try {
    const { id } = req.params;

    // Get assignment with PDF key
    const assignment = await query(
      `SELECT vha.*, d.full_name AS driver_name, d.email AS driver_email,
        fv.reg AS vehicle_reg, fv.vehicle_type AS vehicle_model
      FROM vehicle_hire_assignments vha
      LEFT JOIN drivers d ON d.id = vha.driver_id
      LEFT JOIN fleet_vehicles fv ON fv.id = vha.vehicle_id
      WHERE vha.id = $1`,
      [id]
    );

    if (assignment.rows.length === 0) {
      return res.status(404).json({ error: 'Hire form not found' });
    }

    const row = assignment.rows[0];
    const recipientEmail = row.client_email || row.driver_email;

    if (!recipientEmail) {
      return res.status(400).json({ error: 'No email address available' });
    }

    if (!row.hire_form_pdf_key) {
      return res.status(400).json({ error: 'No PDF generated yet — generate first' });
    }

    // Fetch PDF from R2
    const pdfResponse = await getFromR2(row.hire_form_pdf_key);
    const chunks: Buffer[] = [];
    const stream = pdfResponse.Body as NodeJS.ReadableStream;
    for await (const chunk of stream) {
      chunks.push(Buffer.from(chunk as Uint8Array));
    }
    const pdfBuffer = Buffer.concat(chunks);
    const filename = row.hire_form_pdf_key.split('/').pop() || 'hire-form.pdf';

    const emailResult = await emailService.send('hire_form', {
      to: recipientEmail,
      variables: {
        driverName: row.driver_name || 'Driver',
        vehicleReg: row.vehicle_reg || 'TBC',
        vehicleModel: row.vehicle_model || 'TBC',
        hireStart: fmtDate(row.hire_start),
        hireEnd: fmtDate(row.hire_end),
      },
      attachments: [{
        filename,
        content: pdfBuffer,
        contentType: 'application/pdf',
      }],
    });

    if (emailResult.success) {
      await query(
        `UPDATE vehicle_hire_assignments SET hire_form_emailed_at = NOW() WHERE id = $1`,
        [id]
      );
    }

    res.json({
      data: {
        email_sent: emailResult.success,
        recipient: recipientEmail,
        redirected_to: emailResult.redirectedTo || null,
        error: emailResult.error || null,
      },
    });
  } catch (error) {
    console.error('[hire-forms] Send email error:', error);
    res.status(500).json({ error: 'Failed to send hire form email' });
  }
});

// ── GET /api/hire-forms/:id/download — Download hire form PDF ──

router.get('/:id/download', authenticateOrApiKey, async (req: AuthRequest, res: Response) => {
  try {
    const { id } = req.params;

    const result = await query(
      `SELECT hire_form_pdf_key FROM vehicle_hire_assignments WHERE id = $1`,
      [id]
    );

    if (result.rows.length === 0 || !result.rows[0].hire_form_pdf_key) {
      return res.status(404).json({ error: 'No PDF available' });
    }

    const pdfResponse = await getFromR2(result.rows[0].hire_form_pdf_key);
    const chunks: Buffer[] = [];
    const stream = pdfResponse.Body as NodeJS.ReadableStream;
    for await (const chunk of stream) {
      chunks.push(Buffer.from(chunk as Uint8Array));
    }
    const pdfBuffer = Buffer.concat(chunks);
    const filename = result.rows[0].hire_form_pdf_key.split('/').pop() || 'hire-form.pdf';

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="${filename}"`);
    res.send(pdfBuffer);
  } catch (error) {
    console.error('[hire-forms] Download error:', error);
    res.status(500).json({ error: 'Failed to download hire form PDF' });
  }
});

export default router;
