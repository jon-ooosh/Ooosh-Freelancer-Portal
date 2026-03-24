/**
 * Driver Routes — CRUD for driver records (DVLA data, licence details)
 *
 * Drivers are people who have been through the hire form process, or
 * freelancers/staff who drive Ooosh vehicles. Each driver record stores
 * their global DVLA/licence data, correctable in one place.
 */
import { Router, Response } from 'express';
import { z } from 'zod';
import { query } from '../config/database';
import { authenticate, authorize, AuthRequest } from '../middleware/auth';
import { validate } from '../middleware/validate';
import { generateDriverSnapshot, loadDriverDocuments, type DriverSnapshotData } from '../services/driver-snapshot-pdf';
import { uploadToR2 } from '../config/r2';
import { fetchLogo } from '../services/hire-form-pdf';

const router = Router();
router.use(authenticate);

// ── Schemas ──

const endorsementSchema = z.object({
  code: z.string().max(10),
  points: z.number().int().min(0),
  date: z.string().nullable().optional(),
  expiry: z.string().nullable().optional(),
});

const createDriverSchema = z.object({
  person_id: z.string().uuid().nullable().optional(),
  full_name: z.string().min(1).max(200),
  email: z.string().email().nullable().optional(),
  phone: z.string().max(50).nullable().optional(),
  phone_country: z.string().max(10).nullable().optional(),
  date_of_birth: z.string().nullable().optional(),
  nationality: z.string().max(100).nullable().optional(),
  address_line1: z.string().max(255).nullable().optional(),
  address_line2: z.string().max(255).nullable().optional(),
  city: z.string().max(100).nullable().optional(),
  postcode: z.string().max(20).nullable().optional(),
  address_full: z.string().nullable().optional(),
  licence_address: z.string().nullable().optional(),
  licence_number: z.string().max(50).nullable().optional(),
  licence_type: z.string().max(20).nullable().optional(),
  licence_valid_from: z.string().nullable().optional(),
  licence_valid_to: z.string().nullable().optional(),
  licence_issue_country: z.string().max(100).optional().default('GB'),
  licence_issued_by: z.string().max(100).nullable().optional(),
  licence_points: z.number().int().min(0).optional().default(0),
  licence_endorsements: z.array(endorsementSchema).optional().default([]),
  licence_restrictions: z.string().nullable().optional(),
  licence_next_check_due: z.string().nullable().optional(),
  date_passed_test: z.string().nullable().optional(),
  // Document expiry dates
  poa1_valid_until: z.string().nullable().optional(),
  poa2_valid_until: z.string().nullable().optional(),
  dvla_valid_until: z.string().nullable().optional(),
  passport_valid_until: z.string().nullable().optional(),
  // Document providers
  poa1_provider: z.string().max(100).nullable().optional(),
  poa2_provider: z.string().max(100).nullable().optional(),
  // DVLA
  dvla_check_code: z.string().max(50).nullable().optional(),
  dvla_check_date: z.string().nullable().optional(),
  // Insurance questionnaire
  has_disability: z.boolean().optional().default(false),
  has_convictions: z.boolean().optional().default(false),
  has_prosecution: z.boolean().optional().default(false),
  has_accidents: z.boolean().optional().default(false),
  has_insurance_issues: z.boolean().optional().default(false),
  has_driving_ban: z.boolean().optional().default(false),
  additional_details: z.string().nullable().optional(),
  insurance_status: z.enum(['Approved', 'Referral', 'Failed']).nullable().optional(),
  overall_status: z.string().max(50).nullable().optional(),
  // Referral
  requires_referral: z.boolean().optional().default(false),
  referral_status: z.string().max(30).nullable().optional(),
  referral_date: z.string().nullable().optional(),
  referral_notes: z.string().nullable().optional(),
  // iDenfy
  idenfy_check_date: z.string().max(50).nullable().optional(),
  idenfy_scan_ref: z.string().max(100).nullable().optional(),
  // Signature
  signature_date: z.string().nullable().optional(),
  // Metadata
  source: z.string().max(30).optional().default('hire_form'),
});

const updateDriverSchema = createDriverSchema.partial();

// ── GET /api/drivers — List drivers ──

router.get('/', async (req: AuthRequest, res: Response) => {
  try {
    const { search, page = '1', limit = '50', is_active, has_referral } = req.query;
    const offset = (parseInt(page as string) - 1) * parseInt(limit as string);
    const pageLimit = parseInt(limit as string);

    let where = 'WHERE 1=1';
    const params: unknown[] = [];

    if (is_active !== undefined) {
      params.push(is_active === 'true');
      where += ` AND d.is_active = $${params.length}`;
    } else {
      where += ' AND d.is_active = true';
    }

    if (has_referral === 'true') {
      where += ' AND d.requires_referral = true';
    }

    if (search) {
      params.push(`%${search}%`);
      const si = params.length;
      where += ` AND (d.full_name ILIKE $${si} OR d.email ILIKE $${si} OR d.licence_number ILIKE $${si} OR d.postcode ILIKE $${si})`;
    }

    const countResult = await query(
      `SELECT COUNT(*) FROM drivers d ${where}`,
      params
    );
    const total = parseInt(countResult.rows[0].count);

    const dataParams = [...params, pageLimit, offset];
    const result = await query(
      `SELECT d.*,
        p.first_name AS person_first_name,
        p.last_name AS person_last_name
      FROM drivers d
      LEFT JOIN people p ON p.id = d.person_id
      ${where}
      ORDER BY d.full_name ASC
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
    console.error('[drivers] List error:', error);
    res.status(500).json({ error: 'Failed to load drivers' });
  }
});

// ── GET /api/drivers/lookup — Quick search for hire form pre-fill ──

router.get('/lookup', async (req: AuthRequest, res: Response) => {
  try {
    const { email, name, licence } = req.query;

    if (!email && !name && !licence) {
      res.status(400).json({ error: 'Provide email, name, or licence to search' });
      return;
    }

    let where = 'WHERE d.is_active = true AND (';
    const conditions: string[] = [];
    const params: unknown[] = [];

    if (email) {
      params.push(email);
      conditions.push(`d.email = $${params.length}`);
    }
    if (name) {
      params.push(`%${name}%`);
      conditions.push(`d.full_name ILIKE $${params.length}`);
    }
    if (licence) {
      params.push(licence);
      conditions.push(`d.licence_number = $${params.length}`);
    }

    where += conditions.join(' OR ') + ')';

    const result = await query(
      `SELECT d.* FROM drivers d ${where} ORDER BY d.updated_at DESC LIMIT 10`,
      params
    );

    res.json({ data: result.rows });
  } catch (error) {
    console.error('[drivers] Lookup error:', error);
    res.status(500).json({ error: 'Failed to lookup driver' });
  }
});

// ── GET /api/drivers/:id — Get single driver with hire + excess history ──

router.get('/:id', async (req: AuthRequest, res: Response) => {
  try {
    const { id } = req.params;

    const result = await query(
      `SELECT d.*,
        p.first_name AS person_first_name,
        p.last_name AS person_last_name,
        p.email AS person_email
      FROM drivers d
      LEFT JOIN people p ON p.id = d.person_id
      WHERE d.id = $1`,
      [id]
    );

    if (result.rows.length === 0) {
      res.status(404).json({ error: 'Driver not found' });
      return;
    }

    res.json({ data: result.rows[0] });
  } catch (error) {
    console.error('[drivers] Detail error:', error);
    res.status(500).json({ error: 'Failed to load driver' });
  }
});

// ── GET /api/drivers/:id/hire-history — All assignments for this driver ──

router.get('/:id/hire-history', async (req: AuthRequest, res: Response) => {
  try {
    const { id } = req.params;
    const includeCancelled = req.query.include_cancelled === 'true';

    const result = await query(
      `SELECT vha.*,
        fv.reg AS vehicle_reg,
        fv.simple_type AS vehicle_type
      FROM vehicle_hire_assignments vha
      LEFT JOIN fleet_vehicles fv ON fv.id = vha.vehicle_id
      WHERE vha.driver_id = $1
        ${includeCancelled ? '' : "AND vha.status != 'cancelled'"}
      ORDER BY vha.created_at DESC`,
      [id]
    );

    res.json({ data: result.rows });
  } catch (error) {
    console.error('[drivers] Hire history error:', error);
    res.status(500).json({ error: 'Failed to load hire history' });
  }
});

// ── GET /api/drivers/:id/excess-history — All excess records for this driver ──

router.get('/:id/excess-history', async (req: AuthRequest, res: Response) => {
  try {
    const { id } = req.params;

    const result = await query(
      `SELECT je.*,
        vha.vehicle_id,
        fv.reg AS vehicle_reg,
        vha.hire_start,
        vha.hire_end
      FROM job_excess je
      JOIN vehicle_hire_assignments vha ON vha.id = je.assignment_id
      LEFT JOIN fleet_vehicles fv ON fv.id = vha.vehicle_id
      WHERE vha.driver_id = $1
      ORDER BY je.created_at DESC`,
      [id]
    );

    res.json({ data: result.rows });
  } catch (error) {
    console.error('[drivers] Excess history error:', error);
    res.status(500).json({ error: 'Failed to load excess history' });
  }
});

// ── POST /api/drivers — Create driver ──

router.post('/', validate(createDriverSchema), async (req: AuthRequest, res: Response) => {
  try {
    const d = req.body;

    const result = await query(
      `INSERT INTO drivers (
        person_id, full_name, email, phone, phone_country, date_of_birth, nationality,
        address_line1, address_line2, city, postcode, address_full, licence_address,
        licence_number, licence_type, licence_valid_from, licence_valid_to,
        licence_issue_country, licence_issued_by, licence_points, licence_endorsements,
        licence_restrictions, licence_next_check_due, date_passed_test,
        poa1_valid_until, poa2_valid_until, dvla_valid_until, passport_valid_until,
        poa1_provider, poa2_provider,
        dvla_check_code, dvla_check_date,
        has_disability, has_convictions, has_prosecution, has_accidents,
        has_insurance_issues, has_driving_ban, additional_details,
        insurance_status, overall_status,
        requires_referral, referral_status, referral_date, referral_notes,
        idenfy_check_date, idenfy_scan_ref, signature_date,
        source, created_by
      ) VALUES (
        $1, $2, $3, $4, $5, $6, $7,
        $8, $9, $10, $11, $12, $13,
        $14, $15, $16, $17,
        $18, $19, $20, $21,
        $22, $23, $24,
        $25, $26, $27, $28,
        $29, $30,
        $31, $32,
        $33, $34, $35, $36,
        $37, $38, $39,
        $40, $41,
        $42, $43, $44, $45,
        $46, $47, $48,
        $49, $50
      ) RETURNING *`,
      [
        d.person_id || null, d.full_name, d.email || null, d.phone || null,
        d.phone_country || null, d.date_of_birth || null, d.nationality || null,
        d.address_line1 || null, d.address_line2 || null, d.city || null, d.postcode || null,
        d.address_full || null, d.licence_address || null,
        d.licence_number || null, d.licence_type || null, d.licence_valid_from || null, d.licence_valid_to || null,
        d.licence_issue_country, d.licence_issued_by || null, d.licence_points,
        JSON.stringify(d.licence_endorsements), d.licence_restrictions || null,
        d.licence_next_check_due || null, d.date_passed_test || null,
        d.poa1_valid_until || null, d.poa2_valid_until || null, d.dvla_valid_until || null, d.passport_valid_until || null,
        d.poa1_provider || null, d.poa2_provider || null,
        d.dvla_check_code || null, d.dvla_check_date || null,
        d.has_disability, d.has_convictions, d.has_prosecution, d.has_accidents,
        d.has_insurance_issues, d.has_driving_ban, d.additional_details || null,
        d.insurance_status || null, d.overall_status || null,
        d.requires_referral, d.referral_status || null, d.referral_date || null, d.referral_notes || null,
        d.idenfy_check_date || null, d.idenfy_scan_ref || null, d.signature_date || null,
        d.source, req.user!.id,
      ]
    );

    res.status(201).json({ data: result.rows[0] });
  } catch (error) {
    console.error('[drivers] Create error:', error);
    res.status(500).json({ error: 'Failed to create driver' });
  }
});

// ── GET /api/drivers/:id/audit-log — Edit history for a driver ──

router.get('/:id/audit-log', async (req: AuthRequest, res: Response) => {
  try {
    const { id } = req.params;
    const result = await query(
      `SELECT al.id, al.user_id, al.action, al.previous_values, al.new_values, al.created_at,
        u.email AS user_email,
        COALESCE(u.first_name || ' ' || u.last_name, u.email) AS user_name
      FROM audit_log al
      LEFT JOIN users u ON u.id::text = al.user_id
      WHERE al.entity_type = 'driver' AND al.entity_id = $1
      ORDER BY al.created_at DESC
      LIMIT 100`,
      [id]
    );
    res.json({ data: result.rows });
  } catch (error) {
    // Log the actual error for server-side debugging
    const errMsg = error instanceof Error ? error.message : String(error);
    console.error('[drivers] Audit log error:', errMsg);
    // Return empty data instead of 500 — audit log is non-critical
    // Common cause: permissions issue on audit_log table (like sync_log before migration 009)
    res.json({ data: [], _error: 'Audit log temporarily unavailable' });
  }
});

// ── PUT /api/drivers/:id — Update driver (admin/manager only) ──

router.put('/:id', authorize('admin', 'manager'), validate(updateDriverSchema), async (req: AuthRequest, res: Response) => {
  try {
    const { id } = req.params;
    const updates = req.body;

    // Fetch previous values for audit log
    const previous = await query('SELECT * FROM drivers WHERE id = $1', [id]);
    if (previous.rows.length === 0) {
      res.status(404).json({ error: 'Driver not found' });
      return;
    }
    const previousValues = previous.rows[0];

    // Build dynamic UPDATE
    const setClauses: string[] = [];
    const params: unknown[] = [];

    const fields: Record<string, unknown> = { ...updates };
    if (fields.licence_endorsements) {
      fields.licence_endorsements = JSON.stringify(fields.licence_endorsements);
    }

    // Track what actually changed for audit
    const changedFields: Record<string, { old: unknown; new: unknown }> = {};

    for (const [key, value] of Object.entries(fields)) {
      const prev = previousValues[key];
      const newVal = value ?? null;
      // Compare stringified to handle date/number coercion
      if (String(prev ?? '') !== String(newVal ?? '')) {
        changedFields[key] = { old: prev, new: newVal };
      }
      params.push(newVal);
      setClauses.push(`${key} = $${params.length}`);
    }

    if (setClauses.length === 0) {
      res.status(400).json({ error: 'No fields to update' });
      return;
    }

    setClauses.push('updated_at = NOW()');
    params.push(id);

    const result = await query(
      `UPDATE drivers SET ${setClauses.join(', ')} WHERE id = $${params.length} RETURNING *`,
      params
    );

    if (result.rows.length === 0) {
      res.status(404).json({ error: 'Driver not found' });
      return;
    }

    // Write audit log if anything actually changed
    if (Object.keys(changedFields).length > 0) {
      const oldVals: Record<string, unknown> = {};
      const newVals: Record<string, unknown> = {};
      for (const [key, { old: o, new: n }] of Object.entries(changedFields)) {
        oldVals[key] = o;
        newVals[key] = n;
      }
      await query(
        `INSERT INTO audit_log (user_id, entity_type, entity_id, action, previous_values, new_values)
         VALUES ($1, 'driver', $2, 'update', $3, $4)`,
        [req.user!.id, id, JSON.stringify(oldVals), JSON.stringify(newVals)]
      );
    }

    res.json({ data: result.rows[0] });
  } catch (error) {
    console.error('[drivers] Update error:', error);
    res.status(500).json({ error: 'Failed to update driver' });
  }
});

// ── POST /api/drivers/:id/resolve-referral — Resolve insurance referral ──

const resolveReferralSchema = z.object({
  outcome: z.enum(['approved', 'declined']),
  notes: z.string().optional().default(''),
  // Optional adjusted excess amount (insurer may approve with higher excess)
  adjusted_excess: z.number().min(0).nullable().optional(),
  // Optional: extend specific validity dates on approval
  extend_dates: z.object({
    idenfy_check_date: z.string().nullable().optional(),      // Licence: 90d from this
    dvla_check_date: z.string().nullable().optional(),         // DVLA: 30d from this
    poa1_valid_until: z.string().nullable().optional(),        // POA1: set directly
    poa2_valid_until: z.string().nullable().optional(),        // POA2: set directly
    passport_valid_until: z.string().nullable().optional(),    // Passport: set directly
  }).optional(),
});

router.post('/:id/resolve-referral', authorize('admin', 'manager'), validate(resolveReferralSchema), async (req: AuthRequest, res: Response) => {
  try {
    const { id } = req.params;
    const { outcome, notes, adjusted_excess, extend_dates } = req.body;

    // Fetch current driver
    const current = await query('SELECT * FROM drivers WHERE id = $1', [id]);
    if (current.rows.length === 0) {
      res.status(404).json({ error: 'Driver not found' });
      return;
    }
    const driver = current.rows[0];

    if (!driver.requires_referral) {
      res.status(400).json({ error: 'Driver does not have a pending referral' });
      return;
    }

    // Build update fields
    const updates: Record<string, unknown> = {
      referral_status: outcome,
      referral_notes: [driver.referral_notes, notes].filter(Boolean).join(' | '),
      insurance_status: outcome === 'approved' ? 'Approved' : 'Failed',
    };

    // If approved, optionally extend validity dates
    if (outcome === 'approved' && extend_dates) {
      for (const [key, value] of Object.entries(extend_dates)) {
        if (value) updates[key] = value;
      }
    }

    // Build dynamic SQL
    const setClauses: string[] = [];
    const params: unknown[] = [];
    const changedFields: Record<string, { old: unknown; new: unknown }> = {};

    for (const [key, value] of Object.entries(updates)) {
      const prev = driver[key];
      const newVal = value ?? null;
      if (String(prev ?? '') !== String(newVal ?? '')) {
        changedFields[key] = { old: prev, new: newVal };
      }
      params.push(newVal);
      setClauses.push(`${key} = $${params.length}`);
    }

    setClauses.push('updated_at = NOW()');
    params.push(id);

    const result = await query(
      `UPDATE drivers SET ${setClauses.join(', ')} WHERE id = $${params.length} RETURNING *`,
      params
    );

    // Update excess records if adjusted_excess provided
    if (adjusted_excess != null) {
      await query(
        `UPDATE job_excess SET excess_amount_required = $1, excess_calculation_basis = $2, updated_at = NOW()
         WHERE assignment_id IN (
           SELECT id FROM vehicle_hire_assignments WHERE driver_id = $3 AND status IN ('soft', 'confirmed', 'booked_out', 'active')
         )`,
        [adjusted_excess, `Referral ${outcome}: ${notes || 'insurer adjustment'}`, id]
      );
    }

    // Audit log
    if (Object.keys(changedFields).length > 0) {
      const oldVals: Record<string, unknown> = {};
      const newVals: Record<string, unknown> = {};
      for (const [key, { old: o, new: n }] of Object.entries(changedFields)) {
        oldVals[key] = o;
        newVals[key] = n;
      }
      await query(
        `INSERT INTO audit_log (user_id, entity_type, entity_id, action, previous_values, new_values)
         VALUES ($1, 'driver', $2, 'resolve_referral', $3, $4)`,
        [req.user!.id, id, JSON.stringify(oldVals), JSON.stringify(newVals)]
      );
    }

    console.log(`[drivers] Referral resolved: driver=${id}, outcome=${outcome}`);
    res.json({ data: result.rows[0] });
  } catch (error) {
    console.error('[drivers] Resolve referral error:', error);
    res.status(500).json({ error: 'Failed to resolve referral' });
  }
});

// ── POST /api/drivers/:id/snapshot — Generate verification snapshot PDF ──

router.post('/:id/snapshot', authorize('admin', 'manager'), async (req: AuthRequest, res: Response) => {
  try {
    const { id } = req.params;
    const { hirehop_job_id } = req.body || {};

    const result = await query('SELECT * FROM drivers WHERE id = $1', [id]);
    if (result.rows.length === 0) {
      res.status(404).json({ error: 'Driver not found' });
      return;
    }
    const d = result.rows[0];

    // Load document files from R2
    const documents = await loadDriverDocuments(d.files || []);

    // Load logo
    let logoImage: Buffer | null = null;
    try { logoImage = await fetchLogo(); } catch { /* no logo is fine */ }

    const isUk = (d.licence_issue_country || '').toUpperCase() === 'GB' ||
      (d.licence_issued_by || '').toUpperCase().includes('DVLA');

    const snapshotData: DriverSnapshotData = {
      driverName: d.full_name || '',
      email: d.email || '',
      phone: d.phone ? `${d.phone_country || ''} ${d.phone}` : '',
      dateOfBirth: d.date_of_birth || '',
      nationality: d.nationality || '',
      homeAddress: d.address_full || [d.address_line1, d.address_line2, d.city, d.postcode].filter(Boolean).join(', '),
      licenceAddress: d.licence_address || '',
      licenceNumber: d.licence_number || '',
      licenceIssuedBy: d.licence_issued_by || d.licence_issue_country || '',
      licenceValidTo: d.licence_valid_to || '',
      datePassedTest: d.date_passed_test || '',
      dvlaPoints: String(d.licence_points || 0),
      dvlaEndorsements: Array.isArray(d.licence_endorsements)
        ? d.licence_endorsements.map((e: any) => e.code).join(', ') || 'None'
        : 'None',
      calculatedExcess: '', // Will be populated from job_excess if available
      isUkDriver: isUk,
      hasDisability: d.has_disability || false,
      hasConvictions: d.has_convictions || false,
      hasProsecution: d.has_prosecution || false,
      hasAccidents: d.has_accidents || false,
      hasInsuranceIssues: d.has_insurance_issues || false,
      hasDrivingBan: d.has_driving_ban || false,
      additionalDetails: d.additional_details || '',
      jobId: hirehop_job_id ? String(hirehop_job_id) : 'N/A',
      documents,
      logoImage,
    };

    // Try to get excess from latest active assignment
    const excessResult = await query(
      `SELECT je.excess_amount_required FROM job_excess je
       JOIN vehicle_hire_assignments vha ON vha.id = je.assignment_id
       WHERE vha.driver_id = $1 AND vha.status IN ('soft','confirmed','booked_out','active')
       ORDER BY je.created_at DESC LIMIT 1`,
      [id]
    );
    if (excessResult.rows[0]?.excess_amount_required) {
      snapshotData.calculatedExcess = `£${Number(excessResult.rows[0].excess_amount_required).toLocaleString()}`;
    }

    const { pdfBytes, filename } = await generateDriverSnapshot(snapshotData);

    // Upload to R2
    const r2Key = `driver-snapshots/${id}/${filename}`;
    await uploadToR2(r2Key, Buffer.from(pdfBytes), 'application/pdf');

    console.log(`[drivers] Snapshot generated: ${filename} (${pdfBytes.length} bytes)`);
    res.json({ data: { filename, r2Key, size: pdfBytes.length } });
  } catch (error) {
    console.error('[drivers] Snapshot error:', error);
    res.status(500).json({ error: 'Failed to generate snapshot' });
  }
});

// ── DELETE /api/drivers/:id — Soft-delete (admin only) ──

router.delete('/:id', authorize('admin'), async (req: AuthRequest, res: Response) => {
  try {
    const { id } = req.params;

    const result = await query(
      'UPDATE drivers SET is_active = false, updated_at = NOW() WHERE id = $1 RETURNING id',
      [id]
    );

    if (result.rows.length === 0) {
      res.status(404).json({ error: 'Driver not found' });
      return;
    }

    res.json({ success: true });
  } catch (error) {
    console.error('[drivers] Delete error:', error);
    res.status(500).json({ error: 'Failed to delete driver' });
  }
});

export default router;
