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
import { generateHireFormPdf, fetchLogo, type HireFormData } from '../services/hire-form-pdf';
import { uploadToR2, getFromR2 } from '../config/r2';
import { emailService } from '../services/email-service';

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

// ── POST /api/hire-forms/quick-assign — Quick-create assignment for testing ──

const quickAssignSchema = z.object({
  driver_id: z.string().uuid(),
  vehicle_id: z.string().uuid(),
  job_id: z.string().uuid(),
  hire_start: z.string().optional(),
  hire_end: z.string().optional(),
  client_email: z.string().email().optional(),
});

router.post('/quick-assign', validate(quickAssignSchema), async (req: AuthRequest, res: Response) => {
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

router.get('/options/lists', async (_req: AuthRequest, res: Response) => {
  try {
    const drivers = await query(
      `SELECT id, full_name, email, licence_points FROM drivers WHERE is_active = true ORDER BY full_name`
    );
    const vehicles = await query(
      `SELECT id, reg, vehicle_type, simple_type, hire_status FROM fleet_vehicles WHERE status = 'active' ORDER BY reg`
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

router.get('/:id', async (req: AuthRequest, res: Response) => {
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
      JOIN fleet_vehicles fv ON fv.id = vha.vehicle_id
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

router.patch('/:id', validate(patchSchema), async (req: AuthRequest, res: Response) => {
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
    JOIN fleet_vehicles fv ON fv.id = vha.vehicle_id
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
    dateOfBirth: row.driver_dob ? String(row.driver_dob) : undefined,
    homeAddress,
    licenceAddress: row.driver_licence_address || undefined,
    licenceNumber: row.driver_licence_number || '',
    licenceIssuedBy: row.driver_licence_issued_by || '',
    licenceValidTo: row.driver_licence_valid_to ? String(row.driver_licence_valid_to) : undefined,
    datePassedTest: row.driver_date_passed_test ? String(row.driver_date_passed_test) : undefined,
    vehicleReg: row.vehicle_reg || '',
    vehicleModel: row.vehicle_model || '',
    hireStartDate: row.hire_start ? String(row.hire_start) : undefined,
    hireStartTime: row.start_time ? String(row.start_time) : undefined,
    hireEndDate: row.hire_end ? String(row.hire_end) : undefined,
    hireEndTime: row.end_time ? String(row.end_time) : undefined,
    insuranceExcess: excessStr || undefined,
    hireFormNumber: `OT-HF-${assignmentId.substring(0, 8).toUpperCase()}`,
    contractNumber: row.hirehop_job_id ? String(row.hirehop_job_id) : '',
    signatureDate: row.driver_signature_date ? String(row.driver_signature_date) : undefined,
    signatureImage,
    logoImage,
  };
}

// ── POST /api/hire-forms/:id/generate-pdf — Generate hire form PDF ──

router.post('/:id/generate-pdf', async (req: AuthRequest, res: Response) => {
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
          hireStart: formData.hireStartDate || 'TBC',
          hireEnd: formData.hireEndDate || 'TBC',
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

router.post('/:id/send-email', async (req: AuthRequest, res: Response) => {
  try {
    const { id } = req.params;

    // Get assignment with PDF key
    const assignment = await query(
      `SELECT vha.*, d.full_name AS driver_name, d.email AS driver_email,
        fv.reg AS vehicle_reg, fv.vehicle_type AS vehicle_model
      FROM vehicle_hire_assignments vha
      LEFT JOIN drivers d ON d.id = vha.driver_id
      JOIN fleet_vehicles fv ON fv.id = vha.vehicle_id
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
        hireStart: row.hire_start ? String(row.hire_start) : 'TBC',
        hireEnd: row.hire_end ? String(row.hire_end) : 'TBC',
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

router.get('/:id/download', async (req: AuthRequest, res: Response) => {
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
