/**
 * VE103B Certificate Routes
 *
 * Handles VE103B certificate generation, tracking, voiding, and BVRLA monthly reports.
 * VE103B is a UK document authorising a named driver to take a hired vehicle abroad.
 */
import { Router } from 'express';
import { z } from 'zod';
import { authenticate, authorize, AuthRequest } from '../middleware/auth';
import { query } from '../config/database';
import { uploadToR2, getFromR2, isR2Configured } from '../config/r2';
import { generateVE103BPDF, formatDateForVE103B, assembleDriverAddress } from '../services/ve103b-pdf';
import emailService from '../services/email-service';

const router = Router();

// All routes require authentication
router.use(authenticate);

// ── POST /generate — Generate a VE103B certificate ────────────────────

const generateSchema = z.object({
  assignment_id: z.string().uuid(),
  certificate_number: z.string().min(1).max(20),
});

router.post('/generate', async (req: AuthRequest, res) => {
  try {
    const body = generateSchema.parse(req.body);

    // Check certificate number uniqueness
    const existing = await query(
      `SELECT id FROM ve103b_certificates WHERE certificate_number = $1`,
      [body.certificate_number],
    );
    if (existing.rows.length > 0) {
      res.status(409).json({
        error: 'Certificate number already exists',
        message: `Certificate number ${body.certificate_number} has already been used`,
      });
      return;
    }

    // Fetch assignment with vehicle, driver, and job data
    const assignmentResult = await query(
      `SELECT
        a.id AS assignment_id,
        a.vehicle_id,
        a.driver_id,
        a.job_id,
        a.hire_start,
        a.hire_end,
        a.hirehop_job_id,
        -- Vehicle V5 fields
        v.reg AS vehicle_reg,
        v.date_first_reg,
        v.make,
        v.v5_type,
        v.model,
        v.body_type,
        v.vin,
        v.max_mass_kg,
        v.vehicle_category,
        v.cylinder_capacity_cc,
        v.colour,
        v.seats,
        -- Driver fields
        d.full_name AS driver_name,
        d.address_line1,
        d.address_line2,
        d.city,
        d.postcode,
        -- Job fields
        j.hh_job_number
      FROM vehicle_hire_assignments a
      LEFT JOIN fleet_vehicles v ON v.id = a.vehicle_id
      LEFT JOIN drivers d ON d.id = a.driver_id
      LEFT JOIN jobs j ON j.id = a.job_id
      WHERE a.id = $1`,
      [body.assignment_id],
    );

    if (assignmentResult.rows.length === 0) {
      res.status(404).json({ error: 'Assignment not found' });
      return;
    }

    const row = assignmentResult.rows[0];

    // Validate required data
    if (!row.vehicle_reg) {
      res.status(400).json({ error: 'Assignment has no linked vehicle' });
      return;
    }
    if (!row.driver_name) {
      res.status(400).json({ error: 'Assignment has no linked driver' });
      return;
    }

    // Assemble PDF data
    const driverAddress = assembleDriverAddress(
      row.address_line1, row.address_line2, row.city, row.postcode,
    );

    const pdfData = {
      vehicleReg: row.vehicle_reg || '',
      dateFirstReg: formatDateForVE103B(row.date_first_reg),
      make: row.make || '',
      type: row.v5_type || '',
      model: row.model || '',
      bodyType: row.body_type || '',
      vinChassis: row.vin || '',
      f1Weight: row.max_mass_kg ? String(row.max_mass_kg) : '',
      jCategory: row.vehicle_category || '',
      p1Cc: row.cylinder_capacity_cc ? String(row.cylinder_capacity_cc) : '',
      rColour: row.colour || '',
      s1Seats: row.seats ? String(row.seats) : '',
      driverName: row.driver_name || '',
      driverAddress,
      startDate: formatDateForVE103B(row.hire_start),
      returnDate: formatDateForVE103B(row.hire_end),
    };

    // Generate PDF
    const { pdfBytes, filename } = await generateVE103BPDF(pdfData, body.certificate_number);

    // Upload to R2
    let pdfR2Key: string | null = null;
    if (isR2Configured()) {
      const safeReg = (row.vehicle_reg || 'UNKNOWN').replace(/[^a-zA-Z0-9]/g, '');
      pdfR2Key = `ve103b/${safeReg}/${filename}`;
      await uploadToR2(pdfR2Key, Buffer.from(pdfBytes), 'application/pdf');
    }

    // Insert certificate record
    const hhJobNumber = row.hh_job_number || row.hirehop_job_id || null;

    const insertResult = await query(
      `INSERT INTO ve103b_certificates (
        certificate_number, assignment_id, vehicle_id, driver_id, job_id,
        vehicle_reg, driver_name, driver_address, hire_start, hire_end,
        hirehop_job_number, pdf_r2_key, pdf_filename, generated_by
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
      RETURNING id, created_at, date_certificate_supplied`,
      [
        body.certificate_number,
        body.assignment_id,
        row.vehicle_id,
        row.driver_id,
        row.job_id,
        row.vehicle_reg,
        row.driver_name,
        driverAddress,
        row.hire_start,
        row.hire_end,
        hhJobNumber,
        pdfR2Key,
        filename,
        req.user!.id,
      ],
    );

    const cert = insertResult.rows[0];

    // Update assignment ve103b_ref
    await query(
      `UPDATE vehicle_hire_assignments SET ve103b_ref = $1, updated_at = NOW() WHERE id = $2`,
      [body.certificate_number, body.assignment_id],
    );

    // Email PDF to office
    let emailed = false;
    const jobLabel = hhJobNumber ? `Job ${hhJobNumber}` : 'Unknown Job';
    try {
      await emailService.sendRaw({
        to: 'info@oooshtours.co.uk',
        subject: `VE103B - ${row.vehicle_reg} - ${jobLabel}`,
        html: `<p>VE103B - ${row.vehicle_reg} - ${jobLabel}</p><p>Please print on VE103B form paper.</p>`,
        attachments: [{
          filename,
          content: Buffer.from(pdfBytes),
          contentType: 'application/pdf',
        }],
      });
      emailed = true;
    } catch (emailErr) {
      console.error('[VE103B] Email send failed:', emailErr);
    }

    res.json({
      id: cert.id,
      certificate_number: body.certificate_number,
      vehicle_reg: row.vehicle_reg,
      driver_name: row.driver_name,
      pdf_filename: filename,
      status: 'issued',
      emailed,
      date_certificate_supplied: cert.date_certificate_supplied,
    });
  } catch (err) {
    if (err instanceof z.ZodError) {
      res.status(400).json({ error: 'Validation failed', details: err.errors });
      return;
    }
    console.error('[VE103B] Generate error:', err);
    res.status(500).json({ error: 'Failed to generate VE103B certificate' });
  }
});

// ── POST /test-generate — Test generation from vehicle + manual driver info ──
// Temporary endpoint for testing PDF output without needing a hire assignment.

const testGenerateSchema = z.object({
  vehicle_id: z.string().uuid(),
  driver_name: z.string().min(1).max(200),
  driver_address: z.string().max(500).optional().default(''),
  certificate_number: z.string().min(1).max(20),
  hire_start: z.string().optional(),
  hire_end: z.string().optional(),
});

router.post('/test-generate', async (req: AuthRequest, res) => {
  try {
    const body = testGenerateSchema.parse(req.body);

    // Check certificate number uniqueness
    const existing = await query(
      `SELECT id FROM ve103b_certificates WHERE certificate_number = $1`,
      [body.certificate_number],
    );
    if (existing.rows.length > 0) {
      res.status(409).json({
        error: 'Certificate number already exists',
        message: `Certificate number ${body.certificate_number} has already been used`,
      });
      return;
    }

    // Fetch vehicle V5 data
    const vehicleResult = await query(
      `SELECT id, reg, date_first_reg, make, v5_type, model, body_type, vin,
              max_mass_kg, vehicle_category, cylinder_capacity_cc, colour, seats
       FROM fleet_vehicles WHERE id = $1`,
      [body.vehicle_id],
    );

    if (vehicleResult.rows.length === 0) {
      res.status(404).json({ error: 'Vehicle not found' });
      return;
    }

    const v = vehicleResult.rows[0];

    const pdfData = {
      vehicleReg: v.reg || '',
      dateFirstReg: formatDateForVE103B(v.date_first_reg),
      make: v.make || '',
      type: v.v5_type || '',
      model: v.model || '',
      bodyType: v.body_type || '',
      vinChassis: v.vin || '',
      f1Weight: v.max_mass_kg ? String(v.max_mass_kg) : '',
      jCategory: v.vehicle_category || '',
      p1Cc: v.cylinder_capacity_cc ? String(v.cylinder_capacity_cc) : '',
      rColour: v.colour || '',
      s1Seats: v.seats ? String(v.seats) : '',
      driverName: body.driver_name,
      driverAddress: body.driver_address || '',
      startDate: formatDateForVE103B(body.hire_start),
      returnDate: formatDateForVE103B(body.hire_end),
    };

    // Generate PDF
    const { pdfBytes, filename } = await generateVE103BPDF(pdfData, body.certificate_number);

    // Upload to R2
    let pdfR2Key: string | null = null;
    if (isR2Configured()) {
      const safeReg = (v.reg || 'UNKNOWN').replace(/[^a-zA-Z0-9]/g, '');
      pdfR2Key = `ve103b/${safeReg}/${filename}`;
      await uploadToR2(pdfR2Key, Buffer.from(pdfBytes), 'application/pdf');
    }

    // Insert certificate record (no assignment/driver/job links)
    const insertResult = await query(
      `INSERT INTO ve103b_certificates (
        certificate_number, vehicle_id, vehicle_reg, driver_name, driver_address,
        hire_start, hire_end, pdf_r2_key, pdf_filename, generated_by
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
      RETURNING id, created_at, date_certificate_supplied`,
      [
        body.certificate_number, body.vehicle_id, v.reg, body.driver_name,
        body.driver_address || null, body.hire_start || null, body.hire_end || null,
        pdfR2Key, filename, req.user!.id,
      ],
    );

    const cert = insertResult.rows[0];

    // Email PDF to office
    let emailed = false;
    try {
      await emailService.sendRaw({
        to: 'info@oooshtours.co.uk',
        subject: `VE103B - ${v.reg} - TEST`,
        html: `<p>VE103B - ${v.reg} - TEST GENERATION</p><p>Please print on VE103B form paper.</p>`,
        attachments: [{
          filename,
          content: Buffer.from(pdfBytes),
          contentType: 'application/pdf',
        }],
      });
      emailed = true;
    } catch (emailErr) {
      console.error('[VE103B] Test email send failed:', emailErr);
    }

    res.json({
      id: cert.id,
      certificate_number: body.certificate_number,
      vehicle_reg: v.reg,
      driver_name: body.driver_name,
      pdf_filename: filename,
      status: 'issued',
      emailed,
    });
  } catch (err) {
    if (err instanceof z.ZodError) {
      res.status(400).json({ error: 'Validation failed', details: err.errors });
      return;
    }
    console.error('[VE103B] Test generate error:', err);
    res.status(500).json({ error: 'Failed to generate test VE103B' });
  }
});

// ── POST /:id/void — Void a certificate ───────────────────────────────

const voidSchema = z.object({
  reason: z.string().min(1).max(500),
});

router.post('/:id/void', async (req: AuthRequest, res) => {
  try {
    const { id } = req.params;
    const body = voidSchema.parse(req.body);

    const result = await query(
      `UPDATE ve103b_certificates
       SET status = 'void', void_reason = $1, voided_at = NOW(), voided_by = $2, updated_at = NOW()
       WHERE id = $3 AND status = 'issued'
       RETURNING id, certificate_number, status, void_reason, voided_at`,
      [body.reason, req.user!.id, id],
    );

    if (result.rows.length === 0) {
      res.status(404).json({ error: 'Certificate not found or already voided' });
      return;
    }

    res.json(result.rows[0]);
  } catch (err) {
    if (err instanceof z.ZodError) {
      res.status(400).json({ error: 'Validation failed', details: err.errors });
      return;
    }
    console.error('[VE103B] Void error:', err);
    res.status(500).json({ error: 'Failed to void certificate' });
  }
});

// ── GET / — List certificates ─────────────────────────────────────────

router.get('/', async (req: AuthRequest, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page as string) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit as string) || 50));
    const offset = (page - 1) * limit;
    const status = req.query.status as string;
    const vehicleReg = req.query.vehicle_reg as string;
    const search = req.query.search as string;
    const dateFrom = req.query.date_from as string;
    const dateTo = req.query.date_to as string;

    const conditions: string[] = [];
    const params: unknown[] = [];
    let paramIdx = 1;

    if (status && status !== 'all') {
      conditions.push(`c.status = $${paramIdx++}`);
      params.push(status);
    }
    if (vehicleReg) {
      conditions.push(`c.vehicle_reg ILIKE $${paramIdx++}`);
      params.push(`%${vehicleReg}%`);
    }
    if (search) {
      conditions.push(`(c.certificate_number ILIKE $${paramIdx} OR c.vehicle_reg ILIKE $${paramIdx} OR c.driver_name ILIKE $${paramIdx})`);
      params.push(`%${search}%`);
      paramIdx++;
    }
    if (dateFrom) {
      conditions.push(`c.date_certificate_supplied >= $${paramIdx++}`);
      params.push(dateFrom);
    }
    if (dateTo) {
      conditions.push(`c.date_certificate_supplied <= $${paramIdx++}`);
      params.push(dateTo);
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    const countResult = await query(
      `SELECT COUNT(*) FROM ve103b_certificates c ${whereClause}`,
      params,
    );
    const total = parseInt(countResult.rows[0].count);

    const dataResult = await query(
      `SELECT c.*, u.email AS generated_by_email, u2.email AS voided_by_email
       FROM ve103b_certificates c
       LEFT JOIN users u ON u.id = c.generated_by
       LEFT JOIN users u2 ON u2.id = c.voided_by
       ${whereClause}
       ORDER BY c.created_at DESC
       LIMIT $${paramIdx++} OFFSET $${paramIdx++}`,
      [...params, limit, offset],
    );

    res.json({
      data: dataResult.rows,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    });
  } catch (err) {
    console.error('[VE103B] List error:', err);
    res.status(500).json({ error: 'Failed to list certificates' });
  }
});

// ── GET /bvrla-report — Download BVRLA monthly CSV ────────────────────

router.get('/bvrla-report', authorize('admin', 'manager'), async (req: AuthRequest, res) => {
  try {
    const monthParam = req.query.month as string; // YYYY-MM format

    let startDate: string;
    let endDate: string;

    if (monthParam && /^\d{4}-\d{2}$/.test(monthParam)) {
      const [year, month] = monthParam.split('-').map(Number);
      startDate = `${year}-${String(month).padStart(2, '0')}-01`;
      // Last day of month
      const lastDay = new Date(year!, month!, 0).getDate();
      endDate = `${year}-${String(month).padStart(2, '0')}-${lastDay}`;
    } else {
      // Default to previous month
      const now = new Date();
      const prevMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);
      const lastDay = new Date(prevMonth.getFullYear(), prevMonth.getMonth() + 1, 0).getDate();
      startDate = `${prevMonth.getFullYear()}-${String(prevMonth.getMonth() + 1).padStart(2, '0')}-01`;
      endDate = `${prevMonth.getFullYear()}-${String(prevMonth.getMonth() + 1).padStart(2, '0')}-${lastDay}`;
    }

    const result = await query(
      `SELECT * FROM ve103b_certificates
       WHERE date_certificate_supplied >= $1 AND date_certificate_supplied <= $2
       ORDER BY date_certificate_supplied ASC, created_at ASC`,
      [startDate, endDate],
    );

    const csv = generateBVRLACSV(result.rows);

    // Format month name for filename
    const d = new Date(startDate);
    const months = ['January', 'February', 'March', 'April', 'May', 'June',
      'July', 'August', 'September', 'October', 'November', 'December'];
    const monthName = months[d.getMonth()];
    const year = d.getFullYear();

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="BVRLA-VE103B-${monthName}-${year}.csv"`);
    res.send(csv);
  } catch (err) {
    console.error('[VE103B] BVRLA report error:', err);
    res.status(500).json({ error: 'Failed to generate BVRLA report' });
  }
});

// ── GET /:id — Get single certificate ─────────────────────────────────

router.get('/:id', async (req: AuthRequest, res) => {
  try {
    const { id } = req.params;
    const result = await query(
      `SELECT c.*, u.email AS generated_by_email, u2.email AS voided_by_email
       FROM ve103b_certificates c
       LEFT JOIN users u ON u.id = c.generated_by
       LEFT JOIN users u2 ON u2.id = c.voided_by
       WHERE c.id = $1`,
      [id],
    );

    if (result.rows.length === 0) {
      res.status(404).json({ error: 'Certificate not found' });
      return;
    }

    res.json(result.rows[0]);
  } catch (err) {
    console.error('[VE103B] Get error:', err);
    res.status(500).json({ error: 'Failed to get certificate' });
  }
});

// ── GET /:id/download — Download PDF ──────────────────────────────────

router.get('/:id/download', async (req: AuthRequest, res) => {
  try {
    const { id } = req.params;
    const result = await query(
      `SELECT pdf_r2_key, pdf_filename FROM ve103b_certificates WHERE id = $1`,
      [id],
    );

    if (result.rows.length === 0) {
      res.status(404).json({ error: 'Certificate not found' });
      return;
    }

    const { pdf_r2_key, pdf_filename } = result.rows[0];
    if (!pdf_r2_key) {
      res.status(404).json({ error: 'PDF not available for this certificate' });
      return;
    }

    const r2Response = await getFromR2(pdf_r2_key);
    if (!r2Response.Body) {
      res.status(404).json({ error: 'PDF file not found in storage' });
      return;
    }

    const bodyBytes = await r2Response.Body.transformToByteArray();

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="${pdf_filename}"`);
    res.send(Buffer.from(bodyBytes));
  } catch (err) {
    console.error('[VE103B] Download error:', err);
    res.status(500).json({ error: 'Failed to download PDF' });
  }
});

// ── BVRLA CSV generation ──────────────────────────────────────────────

export function generateBVRLACSV(rows: Record<string, unknown>[]): string {
  const headers = [
    'Date Certificate Supplied',
    'BVRLA Member Number',
    'DVLA REF NO. (7 digit number in circle)',
    'REG. NO.',
    'COMPANY NAME (leave blank if issued to an individual)',
    'START DATE (date certificate is valid from)',
    'EXPIRY DATE (date certificate is valid to - max 12 months)',
  ];

  const csvRows = [headers.join(',')];

  for (const row of rows) {
    const isVoid = row.status === 'void';
    const dateSupplied = formatDateDD(row.date_certificate_supplied as string);
    const startDate = isVoid ? '' : formatDateDD(row.hire_start as string);
    const expiryDate = isVoid ? '' : formatDateDD(row.hire_end as string);
    const regNo = isVoid ? 'VOID' : (row.vehicle_reg as string || '');

    csvRows.push([
      dateSupplied,
      row.bvrla_member_number as string || '10864',
      row.certificate_number as string,
      regNo,
      '', // Company name — always blank
      startDate,
      expiryDate,
    ].join(','));
  }

  return csvRows.join('\n');
}

/** Format date to DD/MM/YYYY for BVRLA report */
function formatDateDD(dateInput: string | Date | null | undefined): string {
  if (!dateInput) return '';
  const d = typeof dateInput === 'string' ? new Date(dateInput) : dateInput;
  if (isNaN(d.getTime())) return '';
  return `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}/${d.getFullYear()}`;
}

export default router;
