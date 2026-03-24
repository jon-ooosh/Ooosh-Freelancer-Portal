/**
 * Driver Verification Routes — public-facing endpoints for the standalone hire form app.
 *
 * These endpoints are called by the Netlify-hosted driver verification app.
 * They use a separate auth mechanism (hire form session JWTs) rather than
 * the standard OP user JWTs.
 *
 * Endpoints:
 *   POST /api/driver-verification/auth/verify   — Verify OTP and get session JWT
 *   GET  /api/driver-verification/status         — Get driver status + document validity
 *   POST /api/driver-verification/next-step      — Routing engine (determine next step)
 *   POST /api/driver-verification/update         — Update driver fields (partial)
 *   GET  /api/driver-verification/check-hire-form — Check if hire form exists for job
 */
import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import multer from 'multer';
import path from 'path';
import { v4 as uuid } from 'uuid';
import { query } from '../config/database';
import { uploadToR2, isR2Configured } from '../config/r2';

const router = Router();

const JWT_SECRET: string = process.env.JWT_SECRET!;
const HIRE_FORM_TOKEN_EXPIRY = '40m'; // Match existing 40-minute session timeout

// ============================================================================
// Auth types & middleware for hire form sessions
// ============================================================================

interface HireFormUser {
  email: string;
  type: 'hire_form_session';
}

interface HireFormRequest extends Request {
  hireFormUser?: HireFormUser;
}

/**
 * Middleware: authenticate hire form session token.
 * Accepts either:
 *   1. Authorization: Bearer <jwt> (new OP tokens)
 *   2. X-Session-Token: <legacy-hmac-token> (existing Netlify tokens, for transition)
 *   3. X-API-Key: <service-key> (server-to-server calls)
 */
function authenticateHireForm(req: HireFormRequest, res: Response, next: NextFunction): void {
  // Check API key first (server-to-server)
  const apiKey = req.headers['x-api-key'] as string;
  if (apiKey && process.env.HIRE_FORM_API_KEY) {
    try {
      const expected = Buffer.from(process.env.HIRE_FORM_API_KEY);
      const provided = Buffer.from(apiKey);
      if (expected.length === provided.length && crypto.timingSafeEqual(expected, provided)) {
        // API key auth — extract email from query or body
        // Note: for multipart uploads, req.body may not be parsed yet (multer runs after this middleware),
        // so we allow API key auth to proceed without email — the endpoint can extract it later.
        const email = (req.query.email as string) || req.body?.email;
        req.hireFormUser = { email: email || 'api_key_service', type: 'hire_form_session' };
        next();
        return;
      }
    } catch {
      // Fall through to other auth methods
    }
  }

  // Check Bearer token (OP-issued JWT)
  const authHeader = req.headers.authorization;
  if (authHeader?.startsWith('Bearer ')) {
    const token = authHeader.split(' ')[1];
    try {
      const decoded = jwt.verify(token, JWT_SECRET) as HireFormUser & { exp: number };
      if (decoded.type === 'hire_form_session') {
        req.hireFormUser = { email: decoded.email, type: 'hire_form_session' };
        next();
        return;
      }
    } catch {
      // Token invalid or expired
    }
  }

  res.status(401).json({ error: 'Authentication required' });
}

// ============================================================================
// POST /api/driver-verification/auth/verify — Issue session JWT after OTP
// ============================================================================

const verifySchema = z.object({
  email: z.string().email(),
  // The OTP verification itself stays on Netlify — this endpoint is called
  // AFTER successful OTP verification to get an OP session token.
  // The Netlify function passes a shared secret to prove verification happened.
  verification_secret: z.string(),
});

router.post('/auth/verify', async (req: Request, res: Response) => {
  try {
    const { email, verification_secret } = verifySchema.parse(req.body);

    // Verify the shared secret (set in both Netlify and OP env vars)
    const expectedSecret = process.env.HIRE_FORM_VERIFICATION_SECRET;
    if (!expectedSecret) {
      console.error('[driver-verification] HIRE_FORM_VERIFICATION_SECRET not configured');
      res.status(500).json({ error: 'Server configuration error' });
      return;
    }

    try {
      const expected = Buffer.from(expectedSecret);
      const provided = Buffer.from(verification_secret);
      if (expected.length !== provided.length || !crypto.timingSafeEqual(expected, provided)) {
        res.status(403).json({ error: 'Invalid verification' });
        return;
      }
    } catch {
      res.status(403).json({ error: 'Invalid verification' });
      return;
    }

    // Issue a short-lived JWT for this driver's session
    const token = jwt.sign(
      { email, type: 'hire_form_session' },
      JWT_SECRET,
      { expiresIn: HIRE_FORM_TOKEN_EXPIRY }
    );

    res.json({
      success: true,
      sessionToken: token,
      expiresIn: HIRE_FORM_TOKEN_EXPIRY,
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      res.status(400).json({ error: 'Invalid request', details: error.errors });
      return;
    }
    console.error('[driver-verification] Auth error:', error);
    res.status(500).json({ error: 'Authentication failed' });
  }
});

// ============================================================================
// GET /api/driver-verification/status — Driver status + document validity
// ============================================================================

router.get('/status', authenticateHireForm, async (req: HireFormRequest, res: Response) => {
  try {
    const email = (req.query.email as string) || req.hireFormUser!.email;

    const result = await query(
      `SELECT d.* FROM drivers d WHERE d.email = $1 AND d.is_active = true ORDER BY d.updated_at DESC LIMIT 1`,
      [email]
    );

    if (result.rows.length === 0) {
      // New driver — return empty status
      res.json(buildNewDriverStatus(email));
      return;
    }

    const driver = result.rows[0];
    const status = buildDriverStatusResponse(driver);
    res.json(status);
  } catch (error) {
    console.error('[driver-verification] Status error:', error);
    res.status(500).json({ error: 'Failed to get driver status' });
  }
});

// ============================================================================
// POST /api/driver-verification/next-step — Routing engine
// ============================================================================

const nextStepSchema = z.object({
  email: z.string().email(),
  currentStep: z.string(),
  addressMismatch: z.boolean().optional().default(false),
});

router.post('/next-step', authenticateHireForm, async (req: HireFormRequest, res: Response) => {
  try {
    const { email, currentStep, addressMismatch } = nextStepSchema.parse(req.body);

    const result = await query(
      `SELECT d.* FROM drivers d WHERE d.email = $1 AND d.is_active = true ORDER BY d.updated_at DESC LIMIT 1`,
      [email]
    );

    const driver = result.rows[0] || null;
    const analysis = analyzeDocuments(driver);
    const nextStep = calculateNextStep(analysis, currentStep, addressMismatch);

    res.json({
      success: true,
      email,
      currentStep,
      nextStep: nextStep.step,
      reason: nextStep.reason,
      documentStatus: analysis,
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      res.status(400).json({ error: 'Invalid request', details: error.errors });
      return;
    }
    console.error('[driver-verification] Next-step error:', error);
    res.status(500).json({ error: 'Failed to determine next step' });
  }
});

// ============================================================================
// POST /api/driver-verification/update — Update driver fields (partial)
// ============================================================================

const updateSchema = z.object({
  email: z.string().email(),
  updates: z.record(z.unknown()),
});

router.post('/update', authenticateHireForm, async (req: HireFormRequest, res: Response) => {
  try {
    const { email, updates } = updateSchema.parse(req.body);

    console.log(`[driver-verification] UPDATE for ${email} — incoming fields:`, Object.keys(updates));
    console.log(`[driver-verification] UPDATE values:`, JSON.stringify(updates, null, 2));

    // camelCase → snake_case mapping for hire form app compatibility
    const camelToSnake: Record<string, string> = {
      fullName: 'full_name',
      phoneNumber: 'phone',
      phoneCountry: 'phone_country',
      dateOfBirth: 'date_of_birth',
      addressFull: 'address_full',
      homeAddress: 'address_full',
      licenceAddress: 'licence_address',
      licenseAddress: 'licence_address',
      licenceNumber: 'licence_number',
      licenseNumber: 'licence_number',
      licenceIssuedBy: 'licence_issued_by',
      licenseIssuedBy: 'licence_issued_by',
      licenceIssueCountry: 'licence_issue_country',
      licenceValidFrom: 'licence_valid_from',
      licenceValidTo: 'licence_valid_to',
      datePassedTest: 'date_passed_test',
      licenceNextCheckDue: 'licence_next_check_due',
      licenseNextCheckDue: 'licence_next_check_due',
      poa1ValidUntil: 'poa1_valid_until',
      poa2ValidUntil: 'poa2_valid_until',
      dvlaValidUntil: 'dvla_valid_until',
      passportValidUntil: 'passport_valid_until',
      poa1Provider: 'poa1_provider',
      poa2Provider: 'poa2_provider',
      dvlaCheckCode: 'dvla_check_code',
      dvlaCheckDate: 'dvla_check_date',
      hasDisability: 'has_disability',
      hasConvictions: 'has_convictions',
      hasProsecution: 'has_prosecution',
      hasAccidents: 'has_accidents',
      hasInsuranceIssues: 'has_insurance_issues',
      hasDrivingBan: 'has_driving_ban',
      additionalDetails: 'additional_details',
      insuranceStatus: 'insurance_status',
      overallStatus: 'overall_status',
      idenfyCheckDate: 'idenfy_check_date',
      idenfyScanRef: 'idenfy_scan_ref',
      signatureDate: 'signature_date',
      licencePoints: 'licence_points',
      licenceEndorsements: 'licence_endorsements',
      requiresReferral: 'requires_referral',
      referralStatus: 'referral_status',
      referralReasons: 'referral_notes',
      referralDate: 'referral_date',
      referralNotes: 'referral_notes',
    };

    // Whitelist of fields the hire form app can update
    const allowedFields = new Set([
      'full_name', 'phone', 'phone_country', 'date_of_birth', 'nationality',
      'address_full', 'licence_address',
      'licence_number', 'licence_issued_by', 'licence_issue_country',
      'licence_valid_from', 'licence_valid_to', 'date_passed_test',
      'licence_next_check_due',
      'poa1_valid_until', 'poa2_valid_until', 'dvla_valid_until', 'passport_valid_until',
      'poa1_provider', 'poa2_provider',
      'dvla_check_code', 'dvla_check_date',
      'has_disability', 'has_convictions', 'has_prosecution', 'has_accidents',
      'has_insurance_issues', 'has_driving_ban', 'additional_details',
      'insurance_status', 'overall_status',
      'idenfy_check_date', 'idenfy_scan_ref', 'signature_date',
      'licence_points', 'licence_endorsements',
      'requires_referral', 'referral_status', 'referral_date', 'referral_notes',
    ]);

    const setClauses: string[] = [];
    const params: unknown[] = [];

    for (const [key, value] of Object.entries(updates)) {
      // Normalise: accept both camelCase and snake_case
      const dbField = camelToSnake[key] || key;
      if (!allowedFields.has(dbField)) continue;
      params.push(value ?? null);
      setClauses.push(`${dbField} = $${params.length}`);
    }

    if (setClauses.length === 0) {
      console.log(`[driver-verification] UPDATE for ${email} — NO valid fields after mapping! Incoming keys were:`, Object.keys(updates));
      res.status(400).json({ error: 'No valid fields to update' });
      return;
    }

    console.log(`[driver-verification] UPDATE for ${email} — writing fields:`, setClauses.map(c => c.split(' = ')[0]));

    setClauses.push('updated_at = NOW()');
    params.push(email);

    // Upsert: update if exists, create if not
    const existing = await query(
      `SELECT id FROM drivers WHERE email = $1 AND is_active = true LIMIT 1`,
      [email]
    );

    // Check if requires_referral is being set to true (for notification trigger)
    const referralBeingSet = updates.requiresReferral === true || updates.requires_referral === true;

    // If referral is being set, check if it's a *change* (was previously false/null)
    let wasAlreadyReferred = false;
    if (referralBeingSet && existing.rows.length > 0) {
      const currentDriver = await query(
        `SELECT requires_referral FROM drivers WHERE id = $1`,
        [existing.rows[0].id]
      );
      wasAlreadyReferred = currentDriver.rows[0]?.requires_referral === true;
    }

    if (existing.rows.length > 0) {
      const result = await query(
        `UPDATE drivers SET ${setClauses.join(', ')} WHERE email = $${params.length} AND is_active = true RETURNING id`,
        params
      );

      const driverId = result.rows[0]?.id;

      // Fire referral notification if requires_referral just changed to true
      if (referralBeingSet && !wasAlreadyReferred && driverId) {
        await fireReferralNotification(email, driverId, updates);
      }

      res.json({ success: true, driverId });
    } else {
      // Create new driver with email + whatever fields were provided
      const fullName = (updates.full_name as string) || email;
      const createResult = await query(
        `INSERT INTO drivers (full_name, email, source) VALUES ($1, $2, 'hire_form') RETURNING id`,
        [fullName, email]
      );
      const newId = createResult.rows[0].id;

      // Now apply the updates
      params[params.length - 1] = email; // email param stays the same
      await query(
        `UPDATE drivers SET ${setClauses.join(', ')} WHERE id = $${params.length + 1}`,
        [...params.slice(0, -1), newId] // replace email param with id
      );

      // Fire referral notification for new driver created with referral flag
      if (referralBeingSet) {
        await fireReferralNotification(email, newId, updates);
      }

      res.json({ success: true, driverId: newId, created: true });
    }
  } catch (error) {
    if (error instanceof z.ZodError) {
      res.status(400).json({ error: 'Invalid request', details: error.errors });
      return;
    }
    console.error('[driver-verification] Update error:', error);
    res.status(500).json({ error: 'Failed to update driver' });
  }
});

// ============================================================================
// GET /api/driver-verification/check-hire-form — Check if hire form exists
// ============================================================================

router.get('/check-hire-form', authenticateHireForm, async (req: HireFormRequest, res: Response) => {
  try {
    const email = req.query.email as string;
    const jobNumber = req.query.jobNumber as string;

    if (!email || !jobNumber) {
      res.status(400).json({ error: 'email and jobNumber are required' });
      return;
    }

    // Find driver by email, then check assignments for this job
    const result = await query(
      `SELECT vha.id, vha.hirehop_job_id, vha.hire_start, vha.hire_end, vha.status,
        d.full_name AS driver_name
      FROM vehicle_hire_assignments vha
      JOIN drivers d ON d.id = vha.driver_id
      WHERE d.email = $1
        AND (vha.hirehop_job_id = $2 OR vha.hirehop_job_name ILIKE $3)
        AND vha.assignment_type = 'self_drive'
        AND vha.status != 'cancelled'
      LIMIT 1`,
      [email, parseInt(jobNumber) || 0, `%${jobNumber}%`]
    );

    if (result.rows.length > 0) {
      res.json({
        success: true,
        exists: true,
        assignment: result.rows[0],
        message: `Hire form already completed for job ${jobNumber}`,
      });
    } else {
      res.json({
        success: true,
        exists: false,
        message: 'No existing hire form found',
      });
    }
  } catch (error) {
    console.error('[driver-verification] Check hire form error:', error);
    res.status(500).json({ error: 'Failed to check hire form' });
  }
});

// ============================================================================
// GET /api/driver-verification/validate-job/:jobNumber — Validate job for hire form
// Also mounted at GET /api/jobs/:jobNumber (for Netlify validate-job.js compatibility)
// ============================================================================

/**
 * Map HireHop status codes and pipeline statuses to a human-readable status string.
 * Returns the status and whether the job is valid for driver verification.
 */
function mapJobStatus(job: Record<string, unknown>): { status: string; validForHire: boolean } {
  const pipelineStatus = job.pipeline_status as string | null;
  const hhStatus = job.status as number;

  // Pipeline status takes precedence if set
  if (pipelineStatus) {
    switch (pipelineStatus) {
      case 'new_enquiry':
      case 'quoting':
      case 'chasing':
      case 'paused':
        return { status: 'enquiry', validForHire: false };
      case 'lost':
        return { status: 'cancelled', validForHire: false };
      case 'provisional':
        return { status: 'provisional', validForHire: true };
      case 'confirmed':
        // Check HH code for more granularity
        if (hhStatus === 9) return { status: 'cancelled', validForHire: false };
        if (hhStatus === 11) return { status: 'completed', validForHire: false };
        return { status: 'confirmed', validForHire: true };
      default:
        break;
    }
  }

  // Fall back to HH status codes
  switch (hhStatus) {
    case 0: return { status: 'enquiry', validForHire: false };
    case 1: return { status: 'provisional', validForHire: true };
    case 2: return { status: 'confirmed', validForHire: true };
    case 3: return { status: 'prepped', validForHire: true };
    case 4: return { status: 'part_dispatched', validForHire: true };
    case 5: return { status: 'dispatched', validForHire: true };
    case 6: return { status: 'returned_incomplete', validForHire: true };
    case 7: return { status: 'returned', validForHire: true };
    case 8: return { status: 'requires_attention', validForHire: true };
    case 9: return { status: 'cancelled', validForHire: false };
    case 10: return { status: 'not_interested', validForHire: false };
    case 11: return { status: 'completed', validForHire: false };
    default: return { status: 'unknown', validForHire: false };
  }
}

/**
 * Middleware: authenticate via API key only (no session JWT needed for job lookup).
 * This is a lighter auth than authenticateHireForm — only server-to-server.
 */
function authenticateApiKey(req: Request, res: Response, next: NextFunction): void {
  const apiKey = req.headers['x-api-key'] as string;
  if (apiKey && process.env.HIRE_FORM_API_KEY) {
    try {
      const expected = Buffer.from(process.env.HIRE_FORM_API_KEY);
      const provided = Buffer.from(apiKey);
      if (expected.length === provided.length && crypto.timingSafeEqual(expected, provided)) {
        next();
        return;
      }
    } catch {
      // Fall through
    }
  }
  res.status(401).json({ error: 'API key required' });
}

router.get('/validate-job/:jobNumber', authenticateApiKey, async (req: Request, res: Response) => {
  try {
    const jobNumber = req.params.jobNumber as string;
    const jobNum = parseInt(jobNumber, 10);

    if (isNaN(jobNum)) {
      res.status(400).json({ error: 'Invalid job number' });
      return;
    }

    const result = await query(
      `SELECT hh_job_number, job_name, client_name, job_date, job_end, status, pipeline_status
       FROM jobs
       WHERE hh_job_number = $1 AND is_deleted = false
       LIMIT 1`,
      [jobNum]
    );

    if (result.rows.length === 0) {
      res.status(404).json({ found: false });
      return;
    }

    const job = result.rows[0];
    const { status, validForHire } = mapJobStatus(job);

    const formatDate = (d: unknown): string | null => {
      if (!d) return null;
      const date = new Date(d as string);
      if (isNaN(date.getTime())) return null;
      return date.toISOString().split('T')[0];
    };

    res.json({
      found: true,
      jobNumber: String(job.hh_job_number),
      jobName: job.job_name || job.client_name || 'Unknown Job',
      startDate: formatDate(job.job_date),
      endDate: formatDate(job.job_end),
      status,
      validForHire,
    });
  } catch (error) {
    console.error('[driver-verification] Validate job error:', error);
    res.status(500).json({ error: 'Failed to validate job' });
  }
});

// ============================================================================
// POST /api/driver-verification/upload — File upload for hire form app
// ============================================================================

const hireFormUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const allowed = ['.pdf', '.jpg', '.jpeg', '.png', '.gif', '.webp', '.doc', '.docx'];
    const ext = path.extname(file.originalname).toLowerCase();
    if (allowed.includes(ext)) {
      cb(null, true);
    } else {
      cb(new Error(`File type ${ext} not allowed`));
    }
  },
});

router.post('/upload', authenticateHireForm, hireFormUpload.single('file'), async (req: HireFormRequest, res: Response) => {
  try {
    if (!isR2Configured()) {
      res.status(503).json({ error: 'File storage not configured' });
      return;
    }

    if (!req.file) {
      res.status(400).json({ error: 'No file provided' });
      return;
    }

    const { entity_id, label, comment, tag } = req.body;
    const email = req.body.email || req.hireFormUser?.email;

    // Look up driver by email or entity_id
    let driverId = entity_id;
    if (!driverId && email) {
      const result = await query(
        `SELECT id FROM drivers WHERE email = $1 AND is_active = true LIMIT 1`,
        [email]
      );
      if (result.rows.length > 0) {
        driverId = result.rows[0].id;
      }
    }

    if (!driverId) {
      res.status(400).json({ error: 'Driver not found — provide entity_id or email' });
      return;
    }

    const ext = path.extname(req.file.originalname).toLowerCase();
    const fileId = uuid();
    const key = `files/drivers/${driverId}/${fileId}${ext}`;

    await uploadToR2(key, req.file.buffer, req.file.mimetype);

    const fileType = ['.jpg', '.jpeg', '.png', '.gif', '.webp'].includes(ext) ? 'image' : 'document';
    const fileAttachment: Record<string, unknown> = {
      name: req.file.originalname,
      url: key,
      type: fileType,
      uploaded_at: new Date().toISOString(),
      uploaded_by: email || 'hire_form',
    };
    if (label?.trim()) fileAttachment.label = label.trim();
    if (comment?.trim()) fileAttachment.comment = comment.trim();
    if (tag?.trim()) fileAttachment.tag = tag.trim();

    // Append to driver's files JSONB array
    await query(
      `UPDATE drivers SET files = COALESCE(files, '[]'::jsonb) || $1::jsonb, updated_at = NOW() WHERE id = $2`,
      [JSON.stringify([fileAttachment]), driverId]
    );

    console.log(`[driver-verification] File uploaded for driver ${driverId}: ${req.file.originalname} (tag: ${tag || 'none'})`);

    res.status(201).json({ success: true, file: fileAttachment, driverId });
  } catch (error) {
    console.error('[driver-verification] File upload error:', error);
    if (error instanceof multer.MulterError && error.code === 'LIMIT_FILE_SIZE') {
      res.status(413).json({ error: 'File too large (max 10MB)' });
      return;
    }
    const message = error instanceof Error ? error.message : 'Upload failed';
    res.status(500).json({ error: message });
  }
});

// ============================================================================
// Referral notification helper
// ============================================================================

async function fireReferralNotification(
  driverEmail: string,
  driverId: string,
  updates: Record<string, unknown>
): Promise<void> {
  try {
    const driverName = (updates.fullName as string) || (updates.full_name as string) || driverEmail;
    const reasons = (updates.referralReasons as string[]) || (updates.referral_reasons as string[]) || [];
    const reasonsText = reasons.length > 0 ? reasons.join(', ') : 'Not specified';

    console.log(`[driver-verification] REFERRAL TRIGGERED for ${driverName} (${driverEmail}) — reasons: ${reasonsText}`);

    // Find which jobs this driver is currently assigned to
    const assignmentResult = await query(
      `SELECT vha.hirehop_job_id, vha.hirehop_job_name, j.job_name
       FROM vehicle_hire_assignments vha
       LEFT JOIN jobs j ON j.id = vha.job_id
       WHERE vha.driver_id = $1
         AND vha.status IN ('soft', 'confirmed')
         AND vha.assignment_type = 'self_drive'`,
      [driverId]
    );

    const jobRefs = assignmentResult.rows
      .map((r: any) => r.hirehop_job_name || r.job_name || `J-${r.hirehop_job_id}`)
      .filter(Boolean);
    const jobsText = jobRefs.length > 0 ? jobRefs.join(', ') : 'No active assignments';

    // 1. Create bell notifications for all admin/manager users
    const adminUsers = await query(
      `SELECT id FROM users WHERE role IN ('admin', 'manager') AND is_active = true`
    );

    const notificationContent = `Manual referral needed: ${driverName} — ${reasonsText}${jobRefs.length > 0 ? ` (Jobs: ${jobsText})` : ''}`;

    for (const user of adminUsers.rows) {
      await query(
        `INSERT INTO notifications (user_id, type, content, link)
         VALUES ($1, 'referral', $2, $3)`,
        [user.id, notificationContent, `/vehicles/drivers/${driverId}`]
      );
    }

    console.log(`[driver-verification] Bell notifications sent to ${adminUsers.rows.length} admin/manager users`);

    // 2. Send email alert to info@oooshtours.co.uk (matches existing hire form behaviour)
    try {
      const { emailService } = await import('../services/email-service');
      const frontendUrl = process.env.FRONTEND_URL || 'https://staff.oooshtours.co.uk';

      await emailService.send('referral_alert', {
        to: 'info@oooshtours.co.uk',
        variables: {
          driverName,
          driverEmail,
          referralReasons: reasonsText,
          linkedJobs: jobsText,
          driverUrl: `${frontendUrl}/vehicles/drivers/${driverId}`,
        },
      });

      console.log(`[driver-verification] Referral email sent to info@oooshtours.co.uk`);
    } catch (emailErr) {
      // Email failure shouldn't block the update — bell notification already sent
      console.error('[driver-verification] Failed to send referral email (bell notification still sent):', emailErr);
    }
  } catch (error) {
    // Don't fail the update if notification fails
    console.error('[driver-verification] Failed to send referral notification:', error);
  }
}

// ============================================================================
// Document analysis & routing engine (ported from get-next-step.js)
// ============================================================================

interface DocValidity {
  valid: boolean;
  expiryDate: string | null;
  provider?: string | null;
}

interface DocumentAnalysis {
  licence: DocValidity;
  poa1: DocValidity & { provider: string | null };
  poa2: DocValidity & { provider: string | null };
  dvla: DocValidity;
  passport: DocValidity;
  isUkDriver: boolean;
  allValid: boolean;
}

function analyzeDocuments(driver: Record<string, unknown> | null): DocumentAnalysis {
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const analysis: DocumentAnalysis = {
    licence: { valid: false, expiryDate: null },
    poa1: { valid: false, expiryDate: null, provider: null },
    poa2: { valid: false, expiryDate: null, provider: null },
    dvla: { valid: false, expiryDate: null },
    passport: { valid: false, expiryDate: null },
    isUkDriver: false,
    allValid: false,
  };

  if (!driver) return analysis;

  analysis.isUkDriver = driver.licence_issued_by === 'DVLA';

  // Helper: add days to a date string
  function addDays(dateStr: string, days: number): Date {
    const d = new Date(dateStr);
    d.setDate(d.getDate() + days);
    return d;
  }

  // Licence: 90 days from iDenfy check, capped at actual licence expiry
  // Falls back to licence_next_check_due if idenfy_check_date is not set
  if (driver.idenfy_check_date) {
    const windowEnd = addDays(driver.idenfy_check_date as string, 90);
    // Cap at actual licence expiry if that's sooner
    let effectiveEnd = windowEnd;
    if (driver.licence_valid_to) {
      const licenceExpiry = new Date(driver.licence_valid_to as string);
      if (licenceExpiry < windowEnd) effectiveEnd = licenceExpiry;
    }
    analysis.licence.valid = effectiveEnd > today;
    analysis.licence.expiryDate = effectiveEnd.toISOString().split('T')[0];
  } else if (driver.licence_next_check_due) {
    // licence_next_check_due stores the actual expiry date (already check date + 90 days)
    // If value looks like a past date relative to driver creation, it's the raw check date — add 90 days
    const storedDate = new Date(driver.licence_next_check_due as string);
    // Treat the stored value as the expiry date directly (it should already be check date + 90d)
    analysis.licence.valid = storedDate > today;
    analysis.licence.expiryDate = storedDate.toISOString().split('T')[0];
  }

  // POA1: 90 days from doc date (stored as poa1_valid_until by hire form)
  if (driver.poa1_valid_until) {
    const poa1Date = new Date(driver.poa1_valid_until as string);
    analysis.poa1.valid = poa1Date > today;
    analysis.poa1.expiryDate = (driver.poa1_valid_until as string);
  }
  analysis.poa1.provider = (driver.poa1_provider as string) || null;

  // POA2: 90 days from doc date
  if (driver.poa2_valid_until) {
    const poa2Date = new Date(driver.poa2_valid_until as string);
    analysis.poa2.valid = poa2Date > today;
    analysis.poa2.expiryDate = (driver.poa2_valid_until as string);
  }
  analysis.poa2.provider = (driver.poa2_provider as string) || null;

  // DVLA: 30 days from check date
  if (driver.dvla_check_date) {
    const dvlaEnd = addDays(driver.dvla_check_date as string, 30);
    analysis.dvla.valid = dvlaEnd > today;
    analysis.dvla.expiryDate = dvlaEnd.toISOString().split('T')[0];
  } else if (driver.dvla_valid_until) {
    // Fallback to stored value
    const dvlaDate = new Date(driver.dvla_valid_until as string);
    analysis.dvla.valid = dvlaDate > today;
    analysis.dvla.expiryDate = (driver.dvla_valid_until as string);
  }

  // Passport: 30 days from iDenfy check (non-UK), or stored value
  if (driver.passport_valid_until) {
    const passDate = new Date(driver.passport_valid_until as string);
    analysis.passport.valid = passDate > today;
    analysis.passport.expiryDate = (driver.passport_valid_until as string);
  } else if (!analysis.isUkDriver && driver.idenfy_check_date) {
    const passEnd = addDays(driver.idenfy_check_date as string, 30);
    analysis.passport.valid = passEnd > today;
    analysis.passport.expiryDate = passEnd.toISOString().split('T')[0];
  }

  // All valid check
  if (analysis.isUkDriver) {
    analysis.allValid = analysis.licence.valid && analysis.poa1.valid &&
      analysis.poa2.valid && analysis.dvla.valid;
  } else {
    analysis.allValid = analysis.licence.valid && analysis.poa1.valid &&
      analysis.poa2.valid && analysis.passport.valid;
  }

  return analysis;
}

/**
 * Routing engine — ported from get-next-step.js v2.6
 * Determines the next step a driver should complete based on document validity.
 */
function calculateNextStep(
  analysis: DocumentAnalysis,
  currentStep: string,
  addressMismatch: boolean
): { step: string; reason: string } {
  // 1. All valid → signature (but UK mismatch needs passport too)
  if (analysis.allValid) {
    if (analysis.isUkDriver && addressMismatch && !analysis.passport.valid) {
      // Fall through — passport still needed
    } else {
      return { step: 'signature', reason: 'All documents are valid and up to date' };
    }
  }

  // 2. From insurance questionnaire
  if (currentStep === 'insurance-complete') {
    if (!analysis.licence.valid) {
      return { step: 'idenfy', reason: 'Licence verification required' };
    }
    if (!analysis.poa1.valid || !analysis.poa2.valid) {
      return { step: 'poa-instructions', reason: 'Proof of address documents required' };
    }
    if (analysis.isUkDriver && !analysis.dvla.valid) {
      return { step: 'dvla-check', reason: 'DVLA check required' };
    }
    if (!analysis.isUkDriver && !analysis.passport.valid) {
      return { step: 'passport-upload', reason: 'Passport verification required' };
    }
    return { step: 'signature', reason: 'All documents valid' };
  }

  // 3. From iDenfy (licence verified)
  if (currentStep === 'idenfy-complete' || currentStep === 'processing-hub') {
    if (!analysis.poa1.valid || !analysis.poa2.valid) {
      return { step: 'poa-instructions', reason: 'Licence verified - proof of address required' };
    }
    if (analysis.isUkDriver && !analysis.dvla.valid) {
      return { step: 'dvla-check', reason: 'POAs verified - DVLA check required' };
    }
    if (!analysis.isUkDriver && !analysis.passport.valid) {
      return { step: 'passport-upload', reason: 'POAs verified - passport verification required' };
    }
    return { step: 'signature', reason: 'All verifications complete' };
  }

  // 4. From POA1
  if (currentStep === 'poa1-complete') {
    if (!analysis.poa2.valid) {
      return { step: 'poa2', reason: 'POA #1 validated - now upload Proof of Address #2' };
    }
    if (analysis.isUkDriver) {
      if (addressMismatch && !analysis.passport.valid) {
        return { step: 'passport-upload', reason: 'Address differs from licence - passport required' };
      }
      if (!analysis.dvla.valid) {
        return { step: 'dvla-check', reason: 'POAs complete - DVLA check required' };
      }
    } else if (!analysis.passport.valid) {
      return { step: 'passport-upload', reason: 'POAs complete - passport verification required' };
    }
    return { step: 'signature', reason: 'All documents valid' };
  }

  // 5. From POA2
  if (currentStep === 'poa2-complete') {
    if (analysis.isUkDriver) {
      if (addressMismatch && !analysis.passport.valid) {
        return { step: 'passport-upload', reason: 'Address differs from licence - passport required' };
      }
      if (!analysis.dvla.valid) {
        return { step: 'dvla-check', reason: 'Both POAs validated - DVLA check required' };
      }
    } else if (!analysis.passport.valid) {
      return { step: 'passport-upload', reason: 'Both POAs validated - passport verification required' };
    }
    return { step: 'signature', reason: 'All documents verified' };
  }

  // 6. DVLA in progress
  if (currentStep === 'dvla-processing' || currentStep === 'dvla-check') {
    if (analysis.dvla.valid) {
      return { step: 'signature', reason: 'DVLA check complete' };
    }
    return { step: 'dvla-check', reason: 'DVLA check in progress' };
  }

  // 7. DVLA complete
  if (currentStep === 'dvla-complete') {
    return { step: 'signature', reason: 'DVLA check verified - ready for signature' };
  }

  // 8. Passport complete
  if (currentStep === 'passport-complete') {
    if (analysis.isUkDriver && !analysis.dvla.valid) {
      return { step: 'dvla-check', reason: 'Passport verified - DVLA check required' };
    }
    return { step: 'signature', reason: 'Passport verification complete - ready for signature' };
  }

  // Default fallback — analyse what's needed
  if (!analysis.licence.valid) {
    return { step: 'idenfy', reason: 'Licence verification needed' };
  }
  if (!analysis.poa1.valid || !analysis.poa2.valid) {
    return { step: 'poa-instructions', reason: 'Proof of address needed' };
  }
  if (analysis.isUkDriver && addressMismatch && !analysis.passport.valid) {
    return { step: 'passport-upload', reason: 'Address differs from licence - passport required' };
  }
  if (analysis.isUkDriver && !analysis.dvla.valid) {
    return { step: 'dvla-check', reason: 'DVLA check needed' };
  }
  if (!analysis.isUkDriver && !analysis.passport.valid) {
    return { step: 'passport-upload', reason: 'Passport verification needed' };
  }
  return { step: 'signature', reason: 'Default route to signature' };
}

// ============================================================================
// Response builders
// ============================================================================

function buildDriverStatusResponse(driver: Record<string, unknown>) {
  const analysis = analyzeDocuments(driver);

  const licenceEnding = (driver.licence_number as string)?.slice(-8) || null;

  // Determine overall status
  let status = 'new';
  if (driver.overall_status === 'Insurance Review') status = 'insurance_review';
  else if (driver.overall_status === 'Stuck') status = 'stuck';
  else if (analysis.allValid) status = 'verified';
  else if (analysis.licence.valid) {
    if (!analysis.poa1.valid || !analysis.poa2.valid) status = 'poa_expired';
    else if (analysis.isUkDriver && !analysis.dvla.valid) status = 'dvla_expired';
    else if (!analysis.isUkDriver && !analysis.passport.valid) status = 'passport_expired';
    else status = 'partial';
  } else if (driver.full_name) status = 'pending';

  // Excess display — not calculated here, just show points for reference.
  // All excess calculations are done within the hire form app.
  const points = (driver.licence_points as number) || 0;
  const excessDisplay: string | null = null;

  // Build endorsements display
  let endorsementsDisplay: string | null = null;
  try {
    const endorsements = typeof driver.licence_endorsements === 'string'
      ? JSON.parse(driver.licence_endorsements as string)
      : driver.licence_endorsements;
    if (Array.isArray(endorsements) && endorsements.length > 0) {
      endorsementsDisplay = endorsements.map((e: { code: string }) => e.code).join(', ');
    }
  } catch { /* ignore */ }

  return {
    status,
    email: driver.email,
    name: driver.full_name || null,
    phoneNumber: driver.phone || null,
    phoneCountry: driver.phone_country || null,
    dateOfBirth: driver.date_of_birth || null,
    licenseNumber: driver.licence_number || null,
    licenseEnding: licenceEnding,
    licenseIssuedBy: driver.licence_issued_by || null,
    homeAddress: driver.address_full || [driver.address_line1, driver.address_line2, driver.city, driver.postcode].filter(Boolean).join(', ') || null,
    licenseAddress: driver.licence_address || null,
    nationality: driver.nationality || null,
    documents: {
      license: {
        valid: analysis.licence.valid,
        ...(analysis.licence.expiryDate ? { expiryDate: analysis.licence.expiryDate } : {}),
        status: analysis.licence.valid ? 'valid' : (driver.licence_next_check_due ? 'expired' : 'required'),
      },
      poa1: {
        valid: analysis.poa1.valid,
        ...(analysis.poa1.expiryDate ? { expiryDate: analysis.poa1.expiryDate } : {}),
        status: analysis.poa1.valid ? 'valid' : (driver.poa1_valid_until ? 'expired' : 'required'),
        provider: analysis.poa1.provider,
      },
      poa2: {
        valid: analysis.poa2.valid,
        ...(analysis.poa2.expiryDate ? { expiryDate: analysis.poa2.expiryDate } : {}),
        status: analysis.poa2.valid ? 'valid' : (driver.poa2_valid_until ? 'expired' : 'required'),
        provider: analysis.poa2.provider,
      },
      dvlaCheck: {
        valid: analysis.dvla.valid,
        ...(analysis.dvla.expiryDate ? { expiryDate: analysis.dvla.expiryDate } : {}),
        status: analysis.dvla.valid ? 'valid' : (driver.dvla_valid_until ? 'expired' : 'required'),
      },
      passportCheck: {
        valid: analysis.passport.valid,
        ...(analysis.passport.expiryDate ? { expiryDate: analysis.passport.expiryDate } : {}),
        status: analysis.passport.valid ? 'valid' : (driver.passport_valid_until ? 'expired' : 'not_required'),
      },
    },
    insuranceData: {
      datePassedTest: driver.date_passed_test ? String(driver.date_passed_test).split('T')[0] : '',
      hasDisability: (driver.has_disability as boolean) || false,
      hasConvictions: (driver.has_convictions as boolean) || false,
      hasProsecution: (driver.has_prosecution as boolean) || false,
      hasAccidents: (driver.has_accidents as boolean) || false,
      hasInsuranceIssues: (driver.has_insurance_issues as boolean) || false,
      hasDrivingBan: (driver.has_driving_ban as boolean) || false,
      additionalDetails: (driver.additional_details as string) || '',
    },
    boardAId: driver.id || null,
    lastUpdated: driver.updated_at || null,
    licenseNextCheckDue: analysis.licence.expiryDate || driver.licence_next_check_due || null,
    poa1ValidUntil: driver.poa1_valid_until || null,
    poa2ValidUntil: driver.poa2_valid_until || null,
    dvlaValidUntil: driver.dvla_valid_until || null,
    passportValidUntil: driver.passport_valid_until || null,
    poa1Provider: driver.poa1_provider || null,
    poa2Provider: driver.poa2_provider || null,
    dvlaPoints: (driver.licence_points as number) || 0,
    dvlaEndorsements: endorsementsDisplay,
    dvlaCalculatedExcess: excessDisplay,
  };
}

function buildNewDriverStatus(email: string) {
  return {
    status: 'new',
    email,
    name: null,
    phoneNumber: null,
    phoneCountry: null,
    dateOfBirth: null,
    licenseNumber: null,
    licenseEnding: null,
    licenseIssuedBy: null,
    homeAddress: null,
    licenseAddress: null,
    nationality: null,
    documents: {
      license: { valid: false, status: 'required' },
      poa1: { valid: false, status: 'required', provider: null },
      poa2: { valid: false, status: 'required', provider: null },
      dvlaCheck: { valid: false, status: 'required' },
      passportCheck: { valid: false, status: 'not_required' },
    },
    insuranceData: null,
    boardAId: null,
    lastUpdated: null,
    licenseNextCheckDue: null,
    poa1ValidUntil: null,
    poa2ValidUntil: null,
    dvlaValidUntil: null,
    passportValidUntil: null,
    poa1Provider: null,
    poa2Provider: null,
    dvlaPoints: 0,
    dvlaEndorsements: null,
    dvlaCalculatedExcess: null,
  };
}

export default router;
