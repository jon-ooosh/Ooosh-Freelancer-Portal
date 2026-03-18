/**
 * Hire Form Routes — composite endpoints for the driver hire form flow.
 *
 * POST /api/hire-forms creates or updates a driver record, creates a
 * vehicle_hire_assignment, calculates the excess, and creates a job_excess
 * record — all in one transactional call.
 */
import { Router, Response } from 'express';
import { z } from 'zod';
import { query, getPool } from '../config/database';
import { authenticate, AuthRequest } from '../middleware/auth';
import { validate } from '../middleware/validate';

const router = Router();
router.use(authenticate);

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

  // Assignment details
  vehicle_id: z.string().uuid(),
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

  // Excess override
  excess_amount_override: z.number().min(0).nullable().optional(),
  excess_override_reason: z.string().nullable().optional(),

  // Xero
  xero_contact_id: z.string().max(100).nullable().optional(),
  xero_contact_name: z.string().max(200).nullable().optional(),
  client_name: z.string().max(200).nullable().optional(),
});

// ── POST /api/hire-forms — Submit completed hire form ──

router.post('/', validate(hireFormSchema), async (req: AuthRequest, res: Response) => {
  const pool = getPool();
  const client = await pool.connect();

  try {
    const f = req.body;
    await client.query('BEGIN');

    // 1. Create or update driver
    let driverId: string;

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

    // 2. Check for referral triggers
    let requiresReferral = false;
    let referralReason = '';

    // Check endorsement codes
    const referralRules = await client.query(
      `SELECT * FROM excess_rules WHERE is_active = true AND requires_referral = true ORDER BY sort_order`
    );

    const endorsementCodes = (f.licence_endorsements || []).map((e: any) => e.code);

    for (const rule of referralRules.rows) {
      if (rule.rule_type === 'endorsement_referral' && rule.condition_code) {
        if (endorsementCodes.some((code: string) => code.toUpperCase().startsWith(rule.condition_code.toUpperCase()))) {
          requiresReferral = true;
          referralReason = rule.description;
          break;
        }
      }
      if (rule.rule_type === 'licence_type' && f.licence_issue_country !== 'GB') {
        requiresReferral = true;
        referralReason = rule.description;
        break;
      }
    }

    // Update driver referral status
    if (requiresReferral) {
      await client.query(
        `UPDATE drivers SET requires_referral = true, referral_status = 'pending', referral_notes = $1 WHERE id = $2`,
        [referralReason, driverId]
      );
    }

    // 3. Calculate excess amount
    let excessAmount: number | null = null;
    let calculationBasis = '';

    if (f.excess_amount_override != null) {
      excessAmount = f.excess_amount_override;
      calculationBasis = `Manual override: ${f.excess_override_reason || 'No reason given'}`;
    } else if (!requiresReferral) {
      const tierResult = await client.query(
        `SELECT * FROM excess_rules
         WHERE is_active = true AND rule_type = 'points_tier'
           AND condition_min <= $1 AND condition_max >= $1
         ORDER BY sort_order LIMIT 1`,
        [f.licence_points]
      );
      if (tierResult.rows[0]) {
        excessAmount = tierResult.rows[0].excess_amount ? parseFloat(tierResult.rows[0].excess_amount) : null;
        calculationBasis = tierResult.rows[0].description || `${f.licence_points} points`;
      }
    } else {
      calculationBasis = `Referral required: ${referralReason}`;
    }

    // 4. Create vehicle hire assignment
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
        f.vehicle_id, f.job_id || null, f.hirehop_job_id || null, f.hirehop_job_name || null,
        driverId,
        f.van_requirement_index, f.required_type || null, f.required_gearbox || null,
        f.hire_start || null, f.hire_end || null, f.start_time || null, f.end_time || null, f.return_overnight ?? null,
        f.ve103b_ref || null, req.user!.id,
      ]
    );

    const assignment = assignmentResult.rows[0];

    // 5. Create excess record
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
        assignment.id, f.job_id || null, f.hirehop_job_id || null,
        excessAmount, calculationBasis,
        requiresReferral ? 'pending' : 'pending',
        f.xero_contact_id || null, f.xero_contact_name || null, f.client_name || null,
        req.user!.id,
      ]
    );

    await client.query('COMMIT');

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

router.get('/by-job/:hirehopJobId', async (req: AuthRequest, res: Response) => {
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
      JOIN fleet_vehicles fv ON fv.id = vha.vehicle_id
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

router.get('/by-driver/:driverId', async (req: AuthRequest, res: Response) => {
  try {
    const { driverId } = req.params;

    const result = await query(
      `SELECT vha.*,
        fv.reg AS vehicle_reg,
        je.excess_amount_required,
        je.excess_status
      FROM vehicle_hire_assignments vha
      JOIN fleet_vehicles fv ON fv.id = vha.vehicle_id
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

export default router;
