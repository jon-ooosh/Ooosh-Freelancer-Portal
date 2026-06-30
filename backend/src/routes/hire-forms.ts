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
import {
  authenticateVehicleFlexible,
  isFreelancerBookout,
  getBookoutScope,
  type FlexibleVehicleRequest,
} from '../middleware/freelancer-bookout-auth';
import { validate } from '../middleware/validate';
import { generateHireFormPdf, fetchLogo, composeMakeModel, type HireFormData } from '../services/hire-form-pdf';
import { uploadToR2, getFromR2 } from '../config/r2';
import { emailService } from '../services/email-service';
import { getFrontendUrl } from '../config/app-urls';
import {
  resolveClientEmailTarget,
  buildFallbackBanner,
  logFallbackToTimeline,
} from '../services/money-emails';
import { resolveHireFormContacts } from '../services/hire-form-contacts';
import { encryptDriverPiiInto, decryptDriverRow } from '../services/driver-pii';
import {
  findOverlappingAssignments,
  buildConflictPayload,
} from '../services/assignment-overlap';
import { syncFleetHireStatus } from '../services/fleet-hire-status-sync';
import { autoDispatchJob } from '../services/auto-dispatch';
import { runHookWithRecovery } from '../services/post-hook-recovery';
import { cancelOrphanSiblingAllocations } from '../services/vha-dedup';

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
    // Normalise email to lowercase so case variations don't create duplicate drivers
    if (typeof f.email === 'string') {
      f.email = f.email.trim().toLowerCase();
    }
    if (typeof f.client_email === 'string') {
      f.client_email = f.client_email.trim().toLowerCase();
    }
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
          licence_restrictions = $16,
          dvla_check_code = COALESCE($17, dvla_check_code),
          dvla_check_date = COALESCE($18, dvla_check_date),
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

    // Dual-write encrypted PII companions (Phase 1) for the fields this write
    // set. date_of_birth/address_line1/2 are overwritten directly above;
    // dvla_check_code uses COALESCE on update, so only encrypt it when a real
    // value was supplied (mirrors the plaintext COALESCE — don't clear the
    // encrypted copy when the plaintext copy was preserved).
    {
      const piiForEnc: Record<string, unknown> = {
        date_of_birth: f.date_of_birth || null,
        address_line1: f.address_line1 || null,
        address_line2: f.address_line2 || null,
      };
      if (f.dvla_check_code) piiForEnc.dvla_check_code = f.dvla_check_code;
      await encryptDriverPiiInto(client, driverId, piiForEnc);
    }

    // 2. Referral status — accept from hire form app or detect from endorsements
    const requiresReferral = f.requires_referral || false;
    const referralReason = f.referral_reason || '';

    if (requiresReferral) {
      // Leave referral_status NULL on initial submission so the driver
      // lands in the red "Refer to Insurers" todo state — explicit signal
      // that staff hasn't actioned anything yet. Staff bumps to 'pending'
      // ("Referred & Waiting" amber) via the Mark as Referred button on
      // DriverDetailPage when they actually send the insurer email. The
      // auto-fire of the referral_alert email to admins still happens
      // via the requires_referral flag elsewhere — the alert path is
      // unchanged.
      await client.query(
        `UPDATE drivers SET requires_referral = true, referral_notes = $1 WHERE id = $2`,
        [referralReason, driverId]
      );
    }

    // 3. Excess amount — passed from hire form app, NOT recalculated here
    //    The hire form app calculates excess from DVLA points during the verification flow.
    //    We store whatever they send. If nothing sent, store null (UI shows red alert).
    const excessAmount: number | null = f.excess_amount ?? null;
    const calculationBasis = f.excess_calculation_basis || (requiresReferral ? `Referral required: ${referralReason}` : '');

    // 3a. Driver-level liability — write the £1,200 floor (or higher if
    //     hire form sent more) onto the drivers row itself. This is the
    //     SOURCE OF TRUTH for the /drivers display and the input to the
    //     per-job excess calculation. Skipped if excess_locked = true
    //     (manual insurer-imposed override that staff have pinned).
    //
    //     The job_excess record below is the per-job realisation of this
    //     liability — it carries payment state, claims, top-N "covered"
    //     status, etc. Driver liability flows IN; per-job state flows OUT.
    const STANDARD_EXCESS_PER_DRIVER = 1200;
    const driverLiability = Math.max(parseFloat(String(excessAmount)) || 0, STANDARD_EXCESS_PER_DRIVER);
    const driverLiabilityBasis = calculationBasis || `Standard £${STANDARD_EXCESS_PER_DRIVER.toLocaleString()} floor (hire form submission)`;
    await client.query(
      `UPDATE drivers
       SET calculated_excess_amount = $1,
           calculated_excess_basis  = $2,
           updated_at = NOW()
       WHERE id = $3 AND excess_locked = false`,
      [driverLiability, driverLiabilityBasis, driverId]
    );

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

    // 6. Check for existing non-cancelled assignment (deduplication)
    //    Dedup by (driver, job) only — NOT by vehicle. The same driver
    //    on the same job should never have two rows; whether the
    //    vehicle_id has been linked yet is incidental. Previously this
    //    required vehicle_id to match too, which meant a re-submission
    //    where the staff had since linked a van between attempts could
    //    slip through and create a duplicate. Also excludes 'returned'
    //    rows so a driver on a follow-up hire on the same job (rare but
    //    possible if staff clone or re-open) gets a fresh row.
    const dedup: string[] = [];
    const dedupParams: unknown[] = [];
    let dedupIdx = 1;
    dedup.push(`driver_id = $${dedupIdx++}`); dedupParams.push(driverId);
    if (jobId) { dedup.push(`job_id = $${dedupIdx++}`); dedupParams.push(jobId); }
    else if (f.hirehop_job_id) { dedup.push(`hirehop_job_id = $${dedupIdx++}`); dedupParams.push(f.hirehop_job_id); }

    const existingAssignment = await client.query(
      `SELECT id FROM vehicle_hire_assignments
       WHERE ${dedup.join(' AND ')} AND status NOT IN ('cancelled', 'returned')
       ORDER BY created_at DESC LIMIT 1`,
      dedupParams
    );

    if (existingAssignment.rows.length > 0) {
      // Duplicate — commit driver updates but skip assignment creation.
      // Return the SAME shape as the create path so clients can rely on
      // data.assignment.id regardless of whether the call was a fresh create
      // or a dedup hit.
      await client.query('COMMIT');
      client.release();
      console.log(`[hire-forms] Deduplicated: existing assignment ${existingAssignment.rows[0].id} for driver ${driverId}`);
      const full = await getPool().query(
        `SELECT a.*, d.full_name AS driver_name, fv.reg AS vehicle_reg
         FROM vehicle_hire_assignments a
         LEFT JOIN drivers d ON d.id = a.driver_id
         LEFT JOIN fleet_vehicles fv ON fv.id = a.vehicle_id
         WHERE a.id = $1`,
        [existingAssignment.rows[0].id]
      );
      const existingExcess = await getPool().query(
        `SELECT * FROM job_excess WHERE assignment_id = $1 ORDER BY created_at DESC LIMIT 1`,
        [existingAssignment.rows[0].id]
      );
      return res.status(200).json({
        data: {
          driver_id: driverId,
          assignment: full.rows[0],
          excess: existingExcess.rows[0] || null,
          requires_referral: requiresReferral,
          referral_reason: requiresReferral ? referralReason : null,
        },
        deduplicated: true,
      });
    }

    // Overlap check — only when a vehicle is actually assigned. Hire forms
    // submitted without a van (vehicle_id NULL) don't occupy a slot yet; the
    // overlap check runs again if/when a van is linked later.
    if (vehicleId) {
      const conflicts = await findOverlappingAssignments({
        vehicleId,
        hireStart: f.hire_start,
        hireEnd: f.hire_end,
        jobId: jobId,
        hirehopJobId: f.hirehop_job_id || null,
      });
      if (conflicts.length > 0) {
        await client.query('ROLLBACK');
        client.release();
        return res.status(409).json(buildConflictPayload(conflicts));
      }
    }

    // 7. Create vehicle hire assignment
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

    // 7. Create or absorb excess record
    // Check for an existing portal-created excess record (no assignment_id, created before hire form)
    // If found, absorb it: link to this assignment and update the required amount from the hire form calculation.
    // This handles the case where the payment portal collected excess before the driver submitted the hire form.
    let excessResult;
    const existingPortalExcess = jobId ? await client.query(
      `SELECT id, excess_amount_taken, excess_status, payment_method, payment_reference, payment_date, hh_deposit_id
       FROM job_excess
       WHERE job_id = $1 AND assignment_id IS NULL
         AND excess_status NOT IN ('reimbursed', 'fully_claimed', 'rolled_over', 'not_required', 'released')
       ORDER BY created_at DESC LIMIT 1`,
      [jobId]
    ) : { rows: [] };

    if (existingPortalExcess.rows.length > 0) {
      const portalRecord = existingPortalExcess.rows[0];
      const alreadyTaken = parseFloat(portalRecord.excess_amount_taken || 0);
      // Enforce the £1,200 floor and never regress from amount already
      // taken. Hire form app sometimes sends 0 for returning drivers who
      // skip the DVLA flow — without this clamp we'd wipe a live pre-auth.
      const STANDARD_EXCESS_PER_VAN = 1200;
      const hireFormCalculated = parseFloat(String(excessAmount)) || 0;
      const newRequired = Math.max(hireFormCalculated, STANDARD_EXCESS_PER_VAN, alreadyTaken);
      // Determine new status based on what's already been collected
      let newStatus = 'pending';
      if (portalRecord.excess_status === 'pre_auth') {
        newStatus = 'pre_auth';
      } else if (alreadyTaken > 0 && alreadyTaken >= newRequired) {
        newStatus = 'taken';
      } else if (alreadyTaken > 0) {
        newStatus = 'partially_paid';
      }

      excessResult = await client.query(
        `UPDATE job_excess SET
          assignment_id = $1,
          excess_amount_required = $2,
          excess_calculation_basis = $3,
          excess_status = $4,
          xero_contact_id = COALESCE($5, xero_contact_id),
          xero_contact_name = COALESCE($6, xero_contact_name),
          client_name = COALESCE($7, client_name),
          notes = COALESCE(notes, '') || E'\nHire form submitted — excess updated from £' || COALESCE(excess_amount_required, 0)::TEXT || ' to £' || $9::TEXT,
          updated_at = NOW()
        WHERE id = $8
        RETURNING *`,
        [
          assignment.id, newRequired, calculationBasis,
          newStatus,
          f.xero_contact_id || null, f.xero_contact_name || null, f.client_name || null,
          portalRecord.id,
          String(newRequired),      // $9 — same value as $2 but cast to text for notes concat
        ]
      );
      console.log(`[hire-forms] Absorbed portal excess ${portalRecord.id}: required £${newRequired}, already taken £${alreadyTaken}, status=${newStatus}`);
    } else {
      // No orphan to absorb — apply £1,200 floor + top-N rule, mirroring
      // the staff quick-assign path. Without this, second-onwards drivers
      // on a job land with whatever the hire form app sent (often null/0
      // for clean-licence drivers who expect the OP to apply the floor),
      // leaving the driver's individual liability invisible on /drivers
      // and unblockable on the dispatch gate.
      //
      // Top-N: total excess for a job = sum of N highest-risk drivers,
      // where N = van count. We can't sort by amount at submission time
      // (later drivers haven't submitted yet), so we approximate as
      // first-N-assigned. Records beyond N get excess_status='not_required'
      // (£0) — informational, gate passes, Money tab excludes. Staff can
      // manually flip records if a higher-excess referral lands late.
      const STANDARD_EXCESS_PER_DRIVER = 1200;

      const flagsResult = jobId ? await client.query(
        `SELECT hh_derived_flags FROM jobs WHERE id = $1`,
        [jobId]
      ) : { rows: [] };
      const flags = flagsResult.rows[0]?.hh_derived_flags as { self_drive_count?: number } | null;
      const vanCount = Math.max(flags?.self_drive_count || 1, 1);

      const countResult = jobId ? await client.query(
        `SELECT COUNT(*)::int AS count FROM job_excess
         WHERE job_id = $1 AND assignment_id IS NOT NULL
           AND excess_status NOT IN ('reimbursed', 'fully_claimed', 'rolled_over', 'not_required', 'waived', 'released')`,
        [jobId]
      ) : { rows: [{ count: 0 }] };
      const activeCount = countResult.rows[0].count;
      const withinTopN = activeCount < vanCount;

      if (withinTopN) {
        // Apply £1,200 floor. Hire form app may have sent a higher figure
        // (referral surcharge) — keep whichever is greater.
        const hireFormCalculated = parseFloat(String(excessAmount)) || 0;
        const finalRequired = Math.max(hireFormCalculated, STANDARD_EXCESS_PER_DRIVER);
        const finalBasis = calculationBasis ||
          `Standard £${STANDARD_EXCESS_PER_DRIVER.toLocaleString()} floor (driver ${activeCount + 1} of ${vanCount})`;

        excessResult = await client.query(
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
            finalRequired, finalBasis,
            'pending',
            f.xero_contact_id || null, f.xero_contact_name || null, f.client_name || null,
            req.user!.id,
          ]
        );
        console.log(`[hire-forms] Insert path: driver ${activeCount + 1}/${vanCount}, required £${finalRequired}`);
      } else {
        // Additional driver beyond van count — covered by another driver's
        // excess on this hire. On record for audit (so /drivers shows the
        // signature), but no separate charge.
        excessResult = await client.query(
          `INSERT INTO job_excess (
            assignment_id, job_id, hirehop_job_id,
            excess_amount_required, excess_calculation_basis,
            excess_status,
            xero_contact_id, xero_contact_name, client_name,
            created_by
          ) VALUES ($1, $2, $3, 0, $4, 'not_required', $5, $6, $7, $8)
          RETURNING *`,
          [
            assignment.id, jobId, f.hirehop_job_id || null,
            `Additional driver ${activeCount + 1} on ${vanCount}-van job — covered by another driver's excess`,
            f.xero_contact_id || null, f.xero_contact_name || null, f.client_name || null,
            req.user!.id,
          ]
        );
        console.log(`[hire-forms] Insert path: additional driver ${activeCount + 1} on ${vanCount}-van job, marked not_required`);
      }
    }

    await client.query('COMMIT');

    console.log(`[hire-forms] Created: driver=${driverId}, assignment=${assignment.id}, vehicle=${vehicleId || 'none'}, job=${f.hirehop_job_id || 'none'}, excess=${excessAmount || 'none'}`);

    // Advance the hire_forms requirement on successful submission so the
    // Job Requirements view reflects "forms in" without waiting for book-
    // out. If this submission triggers a referral, we step the card back
    // to 'in_progress' (amber) so staff see it needs attention. The flip
    // happens in setImmediate so it doesn't slow the hire form response.
    const advanceJobId: string | undefined = assignment.job_id;
    if (advanceJobId) {
      const targetStatus = requiresReferral ? 'in_progress' : 'done';
      setImmediate(async () => {
        try {
          await query(
            `UPDATE job_requirements
             SET status = $1, updated_at = NOW()
             WHERE job_id = $2
               AND requirement_type = 'hire_forms'
               AND phase = 'pre_hire'
               AND status <> $1`,
            [targetStatus, advanceJobId]
          );
          // Hire form may also have linked a vehicle (vehicle_id on the new
          // assignment). Recompute vehicle requirement status from the post-
          // insert state.
          const { syncVehicleRequirementStatus } = await import('../services/vehicle-requirement-sync');
          await syncVehicleRequirementStatus(advanceJobId);
        } catch (err) {
          console.warn(`[hire-forms] hire_forms requirement advance failed for job ${advanceJobId}:`, err);
        }
      });
    }

    // Send referral notification email (non-blocking — don't fail the request)
    if (requiresReferral) {
      sendReferralNotification(driverId, f.full_name, f.email || '', referralReason, f.hirehop_job_id || null)
        .catch(err => console.error('[hire-forms] Referral notification error:', err));
    }

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

router.get('/by-job/:hirehopJobId', authenticateVehicleFlexible, async (req: FlexibleVehicleRequest & AuthRequest, res: Response) => {
  try {
    const hirehopJobId = parseInt(req.params.hirehopJobId as string);

    // Freelancer scope: caller can only read hire forms on their own job.
    // Without this, a session for one delivery could enumerate hire forms
    // across the whole fleet.
    if (isFreelancerBookout(req)) {
      const scope = await getBookoutScope(req);
      if (!scope) {
        return res.status(403).json({ error: 'Assignment not found' });
      }
      if (scope.hhJobNumber !== hirehopJobId) {
        return res.status(403).json({ error: 'Hire forms are not on your job' });
      }
    }

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
        AND vha.status NOT IN ('cancelled', 'swapped')
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
  vehicle_id: z.string().uuid().nullable().optional(),   // optional — staff can link driver-only first, pick the vehicle later
  job_id: z.string().uuid(),
  hire_start: z.string().optional(),
  hire_end: z.string().optional(),
  client_email: z.string().email().optional(),
});

router.post('/quick-assign', authenticate, validate(quickAssignSchema), async (req: AuthRequest, res: Response) => {
  try {
    const f = req.body;

    // Driver document validity gate. The frontend traffic-light filter is
    // a UX hint; this is the authoritative check. A driver with any expired
    // document (licence / DVLA / POA) cannot be assigned — staff must send
    // a fresh hire form to refresh the data first. Drivers requiring
    // insurance referral with status 'pending' or 'declined' are also
    // blocked.
    const driverCheck = await query(
      `SELECT licence_valid_to, dvla_valid_until,
              poa1_valid_until, poa2_valid_until,
              requires_referral, referral_status, full_name
         FROM drivers WHERE id = $1`,
      [f.driver_id]
    );
    if (driverCheck.rows.length === 0) {
      return res.status(404).json({ error: 'Driver not found' });
    }
    const dr = driverCheck.rows[0];
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const isExpired = (d: string | null | undefined) => d ? new Date(d) < today : false;

    const expiredDocs: string[] = [];
    if (isExpired(dr.licence_valid_to)) expiredDocs.push('Licence');
    if (isExpired(dr.dvla_valid_until)) expiredDocs.push('DVLA check');
    // POA: at least one needs to be valid (matches the existing validator).
    const poa1Expired = isExpired(dr.poa1_valid_until);
    const poa2Expired = isExpired(dr.poa2_valid_until);
    if (poa1Expired && poa2Expired) expiredDocs.push('Proof of address');

    if (expiredDocs.length > 0) {
      return res.status(400).json({
        error: `Cannot assign ${dr.full_name} — expired documents: ${expiredDocs.join(', ')}. Send a fresh hire form to refresh.`,
        code: 'driver_documents_expired',
        expiredDocs,
      });
    }
    if (dr.requires_referral && dr.referral_status !== 'approved') {
      return res.status(400).json({
        error: `Cannot assign ${dr.full_name} — insurance referral is ${dr.referral_status || 'pending'}. Resolve the referral on the driver detail page first.`,
        code: 'driver_referral_unresolved',
      });
    }

    // Look up the HireHop job number from the jobs table
    const jobResult = await query(`SELECT hh_job_number, job_name FROM jobs WHERE id = $1`, [f.job_id]);
    const hhJobId = jobResult.rows[0]?.hh_job_number || null;
    const hhJobName = jobResult.rows[0]?.job_name || null;

    // Dedup gate — block re-creating an assignment for a (job, driver) that
    // already has a non-cancelled, non-returned row. Without this, staff
    // hitting "+ Add driver manually" on a job where the customer's hire
    // form is already in OP creates a DUPLICATE vehicle_hire_assignments
    // row, and the top-N rule then flags this driver as "additional"
    // (£0 / excess_status='not_required') because the slot is already
    // filled. Live example: job 15852 / Mr Desmond Magee, 29 Apr 2026.
    //
    // Loud 409 (not silent absorb) so staff can see exactly what happened
    // — the right action is "look at the existing assignment, don't create
    // another". Returns the existing assignment ID so the UI could in
    // future jump to it.
    const existingAssignment = await query(
      `SELECT vha.id, vha.status, vha.vehicle_id, fv.reg AS vehicle_reg
         FROM vehicle_hire_assignments vha
         LEFT JOIN fleet_vehicles fv ON fv.id = vha.vehicle_id
        WHERE vha.driver_id = $1
          AND (vha.job_id = $2 OR ($3::int IS NOT NULL AND vha.hirehop_job_id = $3))
          AND vha.status NOT IN ('cancelled', 'returned')
        LIMIT 1`,
      [f.driver_id, f.job_id, hhJobId]
    );
    if (existingAssignment.rows.length > 0) {
      const ex = existingAssignment.rows[0];
      return res.status(409).json({
        error: `${dr.full_name} is already assigned to this job (status: ${ex.status}${ex.vehicle_reg ? ', vehicle: ' + ex.vehicle_reg : ', no vehicle linked'}). Use the existing row on the Drivers & Vehicles tab — don't add them twice.`,
        code: 'driver_already_assigned',
        existing_assignment_id: ex.id,
        existing_status: ex.status,
        existing_vehicle_reg: ex.vehicle_reg || null,
      });
    }

    // Overlap check — only when a vehicle is being assigned at quick-assign time.
    if (f.vehicle_id) {
      const conflicts = await findOverlappingAssignments({
        vehicleId: f.vehicle_id,
        hireStart: f.hire_start,
        hireEnd: f.hire_end,
        jobId: f.job_id,
        hirehopJobId: hhJobId,
      });
      if (conflicts.length > 0) {
        return res.status(409).json(buildConflictPayload(conflicts));
      }
    }

    // Create assignment (vehicle_id may be null — DB column is nullable)
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
        f.vehicle_id || null, f.job_id, hhJobId, hhJobName,
        f.driver_id,
        f.hire_start || null, f.hire_end || null, f.client_email || null,
        req.user!.id,
      ]
    );

    // Also create an excess record.
    //
    // Quick-assign is a STAFF action — it defaults to the £1,200 floor per
    // driver (per-van), same as the HH derivation engine. We explicitly DO
    // NOT read the excess_rules table here: that table holds points-tier
    // surcharges which are applied by the hire form app during the DVLA
    // flow, not by manual staff assignments. The principle from CLAUDE.md:
    //   "£1,200 is the FLOOR — any DVLA points/referral surcharge gets added
    //    on top, never replaces."
    //
    // Top-N-drivers algorithm: total excess for a job = sum of the N
    // highest-risk drivers' excesses, where N = van count. Additional
    // drivers beyond N are on record but don't add to the charge. In
    // quick-assign all drivers default to £1,200 (tied) so it's effectively
    // first-N-assigned. Records beyond N get excess_status = 'not_required'
    // (£0) — informational only, book-out gate passes, Money tab excludes.
    //
    // Absorption: if the HH derivation engine created an unlinked £1,200
    // record (assignment_id IS NULL, non-terminal), the first quick-assign
    // LINKS that record to this driver's new assignment rather than
    // creating a duplicate. Preserves any payment/pre_auth state on the
    // orphan. Subsequent drivers on the same job evaluate against the
    // top-N rule.
    const assignment = result.rows[0];
    const STANDARD_EXCESS_PER_DRIVER = 1200;

    // Read derived van count from the HH-derived flags on the job. Falls
    // back to 1 if the derivation engine hasn't run yet for this job
    // (e.g. freshly-created OP-native job).
    const flagsResult = await query(
      `SELECT hh_derived_flags, is_internal FROM jobs WHERE id = $1`,
      [f.job_id]
    );
    const flags = flagsResult.rows[0]?.hh_derived_flags as { self_drive_count?: number } | null;
    const vanCount = Math.max(flags?.self_drive_count || 1, 1);
    const isInternalJob = flagsResult.rows[0]?.is_internal === true;

    // Internal jobs (garage visits / our own vehicle movements) never charge
    // excess — record the assignment as not_required (£0) for audit and skip
    // the orphan/top-N logic entirely. Without this gate, quick-assign would
    // create (or un-waive) a £1,200 record on a job with no client to charge.
    if (isInternalJob) {
      await query(
        `INSERT INTO job_excess (assignment_id, job_id, hirehop_job_id, excess_amount_required, excess_calculation_basis, excess_status, created_by)
         VALUES ($1, $2, $3, 0, 'Internal job — excess not applicable', 'not_required', $4)`,
        [assignment.id, f.job_id, hhJobId, req.user!.id]
      );
      console.log(`[hire-forms] Quick-assign on internal job: assignment ${assignment.id} recorded with not_required excess`);
    } else {

    // Try to absorb an orphan record created by the derivation engine.
    // 'waived' is excluded — a waived record (staff decision, V&D cascade or
    // internal-job cascade) must never be silently flipped back to 'pending'.
    // 'released' is terminal (migration 087) — absorbing one resurrects a dead
    // pre-auth to 'pending' with stale amount_held (job 15934 incident, Jun 2026).
    const orphanExcess = await query(
      `SELECT id FROM job_excess
       WHERE job_id = $1 AND assignment_id IS NULL
         AND excess_status NOT IN ('reimbursed', 'fully_claimed', 'rolled_over', 'not_required', 'waived', 'released')
       ORDER BY created_at ASC LIMIT 1`,
      [f.job_id]
    );

    if (orphanExcess.rows.length > 0) {
      // Absorb — this driver takes "slot 1" for the orphan's van coverage.
      // Status flips to pending unless real money has already moved.
      await query(
        `UPDATE job_excess SET
          assignment_id = $1,
          excess_amount_required = $2,
          excess_calculation_basis = $3,
          excess_status = CASE
            WHEN excess_status IN ('taken', 'pre_auth', 'partially_paid') THEN excess_status
            ELSE 'pending'
          END,
          notes = COALESCE(notes, '') || E'\nAbsorbed by quick-assign for driver ' || $4::TEXT,
          updated_at = NOW()
        WHERE id = $5`,
        [assignment.id, STANDARD_EXCESS_PER_DRIVER, `Standard £${STANDARD_EXCESS_PER_DRIVER.toLocaleString()} floor (quick-assign, absorbed derivation record)`, f.driver_id, orphanExcess.rows[0].id]
      );
      console.log(`[hire-forms] Quick-assign absorbed orphan excess ${orphanExcess.rows[0].id} into assignment ${assignment.id}`);
    } else {
      // No orphan — evaluate top-N. Count how many drivers on this job
      // already have "active" excess records (linked, non-terminal, not
      // marked not_required). If we're within N, this driver is charged;
      // otherwise they're an additional driver on record only.
      const countResult = await query(
        `SELECT COUNT(*)::int AS count FROM job_excess
         WHERE job_id = $1 AND assignment_id IS NOT NULL
           AND excess_status NOT IN ('reimbursed', 'fully_claimed', 'rolled_over', 'not_required', 'waived', 'released')`,
        [f.job_id]
      );
      const activeCount = countResult.rows[0].count;
      const withinTopN = activeCount < vanCount;

      if (withinTopN) {
        await query(
          `INSERT INTO job_excess (assignment_id, job_id, hirehop_job_id, excess_amount_required, excess_calculation_basis, excess_status, created_by)
           VALUES ($1, $2, $3, $4, $5, 'pending', $6)`,
          [assignment.id, f.job_id, hhJobId, STANDARD_EXCESS_PER_DRIVER, `Standard £${STANDARD_EXCESS_PER_DRIVER.toLocaleString()} floor (quick-assign, driver ${activeCount + 1} of ${vanCount})`, req.user!.id]
        );
      } else {
        // Additional driver beyond van count — on record, no separate charge.
        await query(
          `INSERT INTO job_excess (assignment_id, job_id, hirehop_job_id, excess_amount_required, excess_calculation_basis, excess_status, created_by)
           VALUES ($1, $2, $3, 0, $4, 'not_required', $5)`,
          [assignment.id, f.job_id, hhJobId, `Additional driver (${activeCount + 1} of ${vanCount} vans — no separate charge, covered by primary driver's excess)`, req.user!.id]
        );
        console.log(`[hire-forms] Quick-assign additional driver: assignment ${assignment.id} (driver ${activeCount + 1} on ${vanCount}-van job, not_required)`);
      }
    }
    } // end !isInternalJob

    console.log(`[hire-forms] Quick assignment created: ${assignment.id} (driver ${f.driver_id} → vehicle ${f.vehicle_id || 'unassigned'} on job ${f.job_id}, van_count=${vanCount})`);

    // Recompute vehicle requirement — quick-assign may have linked a vehicle
    // (or not, if vehicle_id was omitted). Helper handles both cases.
    if (f.job_id) {
      const { syncVehicleRequirementStatus } = await import('../services/vehicle-requirement-sync');
      syncVehicleRequirementStatus(f.job_id).catch(err => {
        console.warn(`[hire-forms] quick-assign vehicle requirement sync failed:`, err);
      });
    }

    res.status(201).json({ data: assignment });
  } catch (error) {
    console.error('[hire-forms] Quick assign error:', error);
    res.status(500).json({ error: 'Failed to create assignment' });
  }
});

// ── GET /api/hire-forms/options — Get available drivers and vehicles for assignment ──

router.get('/options/lists', authenticate, async (_req: AuthRequest, res: Response) => {
  try {
    // Driver options include the doc-validity dates so the assign-driver
    // picker on Job Detail can render traffic-light validity (green / amber
    // / red) and block selection of expired drivers without an extra round-
    // trip to the drivers endpoint.
    const drivers = await query(
      `SELECT id, full_name, email, licence_points,
              licence_valid_to, dvla_valid_until, poa1_valid_until, poa2_valid_until,
              requires_referral, referral_status, is_active
         FROM drivers
        WHERE is_active = true
        ORDER BY full_name`
    );
    // Active fleet only — matches the canonical filter used elsewhere
    // (dashboard.ts, compliance-checker.ts, vehicles.ts fleet overview).
    const vehicles = await query(
      `SELECT id, reg, vehicle_type, simple_type, hire_status
       FROM fleet_vehicles
       WHERE is_active = true AND fleet_group != 'old_sold'
       ORDER BY reg`
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
  // vehicle_id accepts null so staff can "unlink" a van from an assignment
  // before book-out (e.g. after picking the wrong van, or if plans change).
  // The Allocations UI sends null to clear the link for this driver and —
  // via its cascade logic — for every sibling driver on the same slot.
  vehicle_id: z.string().uuid().nullable().optional(),
  hire_end: z.string().optional(),
  start_time: z.string().optional(),
  end_time: z.string().optional(),
  ve103b_ref: z.string().max(100).optional(),
  return_overnight: z.boolean().nullable().optional(),
  client_email: z.string().email().nullable().optional(),
  status: z.enum(['soft', 'confirmed', 'booked_out', 'active', 'returned', 'cancelled']).optional(),
  notes: z.string().optional(),
});

// Fields a freelancer book-out session is allowed to write at book-out
// time. Anything else gets silently stripped — never 403'd. Brief from
// jon (Round 4): a freelancer must never be blocked mid-handover by a
// "you can't change that field" error. If their client accidentally
// includes a non-allowed field we drop it and proceed.
//
// Includes ve103b_ref because the existing updateDriverHireForm helper
// always sends it (lead-driver-only flag — empty string for freelancers).
// Excluded: client_email (would let a freelancer overwrite the customer's
// contact email) and notes (admin field).
const FREELANCER_PATCH_ALLOW = new Set([
  'vehicle_id',
  'hire_end',
  'start_time',
  'end_time',
  'return_overnight',
  'status',
  've103b_ref',
]);

/**
 * Post-book-out hook chain. Fires fleet hire_status sync, requirement
 * advance, hire agreement PDF + email, OOH info email, and auto-dispatch
 * for an assignment that has just transitioned to status='booked_out'
 * with vehicle_id linked.
 *
 * Used by both the PATCH /:id handler (standard book-out completion) and
 * POST /:id/add-to-hire (mid-tour driver linked to an already-out van —
 * same downstream effects). Extracting the chain into one place keeps the
 * two paths in lockstep when new hooks are added.
 *
 * All hooks are fire-and-forget via setImmediate so the caller can
 * respond immediately. runHookWithRecovery handles retries + alerting on
 * permanent failure; each hook is independently idempotent so calling
 * this twice on the same job (e.g. once per cloned assignment in a
 * multi-van add-to-hire) is safe.
 */
function firePostBookOutHooks(opts: {
  assignmentId: string;
  vehicleId: string;
  jobId: string | null;
  hhJobNumber: number | null;
  returnOvernight: boolean | null;
  hireFormEmailedAt: Date | string | null;
  actorLabel: string;
  actorUserId: string | null;
}): void {
  const {
    assignmentId,
    vehicleId,
    jobId,
    hhJobNumber,
    returnOvernight,
    hireFormEmailedAt,
    actorLabel,
    actorUserId,
  } = opts;

  // Fleet hire_status sync (single source of truth helper). Non-blocking.
  syncFleetHireStatus(vehicleId).catch((err) => {
    console.warn(`[hire-forms] fleet hire_status sync failed for vehicle ${vehicleId}:`, err);
  });

  // Advance pre-hire requirement cards to 'done' — book-out by definition
  // means the hire agreement has been executed and the van has left the
  // warehouse. The excess sync helper is forward-only.
  if (jobId) {
    setImmediate(() => {
      runHookWithRecovery(
        {
          hookLabel: 'Post-book-out requirement advance',
          jobId,
          hhJobNumber,
          assignmentId,
        },
        async () => {
          await query(
            `UPDATE job_requirements
             SET status = 'done', updated_at = NOW()
             WHERE job_id = $1
               AND requirement_type IN ('hire_forms', 'vehicle')
               AND phase = 'pre_hire'
               AND status IN ('not_started', 'in_progress')`,
            [jobId]
          );
          const { syncExcessRequirementStatus } = await import('../services/excess-requirement-sync');
          await syncExcessRequirementStatus(jobId);
        }
      ).catch((err) => {
        console.warn(`[hire-forms] Post-book-out requirement advance failed for job ${jobId}:`, err);
      });
    });
  }

  // Generate + email PDF if this is the first book-out email for this
  // assignment (idempotent — a retry shouldn't re-spam).
  if (!hireFormEmailedAt) {
    setImmediate(() => {
      runHookWithRecovery(
        {
          hookLabel: 'Hire form PDF + email',
          jobId,
          hhJobNumber,
          assignmentId,
        },
        () => generateAndEmailHireFormPdf(assignmentId, 'book-out')
      ).catch((err) => {
        console.error(`[hire-forms] Post-book-out PDF+email failed for ${assignmentId}:`, err);
      });
    });
  }

  // Multi-van fan-out: every OTHER self-drive driver on the job also gets a
  // hire agreement for THIS van — the "everyone drives everything" paperwork,
  // so each driver holds proof of eligibility for every van. No-op on
  // single-van jobs (no other-van drivers). Idempotent per (driver, van) via
  // the hire_form_documents UNIQUE constraint.
  setImmediate(() => {
    runHookWithRecovery(
      {
        hookLabel: 'Multi-van hire form fan-out',
        jobId,
        hhJobNumber,
        assignmentId,
      },
      () => fanOutVanHireForms({ jobId, hhJobNumber, vanVehicleId: vehicleId })
    ).catch((err) => {
      console.error(`[hire-forms] Multi-van fan-out failed for van ${vehicleId} on job ${jobId ?? hhJobNumber}:`, err);
    });
  });

  // Out-of-hours return info email (function dedupes per-assignment via
  // ooh_info_sent_at, so safe to call when only some vans on the job are OOH).
  if (returnOvernight === true && jobId) {
    setImmediate(() => {
      runHookWithRecovery(
        {
          hookLabel: 'OOH info email',
          jobId,
          hhJobNumber,
          assignmentId,
        },
        async () => {
          const { sendOohInfoEmailsForJob } = await import('../services/ooh-return');
          await sendOohInfoEmailsForJob(jobId);
        }
      ).catch((err) => {
        console.error(`[hire-forms] OOH info email send failed for job ${jobId}:`, err);
      });
    });
  }

  // Auto-dispatch — idempotent, short-circuits if HH already at status 5+.
  // For add-to-hire this almost always no-ops (the job is already
  // dispatched, which is what triggered the add-to-hire path), but we
  // still call it so the standard book-out path's behaviour is preserved
  // and so any "first van booked out" edge case still dispatches the job.
  if (jobId) {
    setImmediate(() => {
      runHookWithRecovery(
        {
          hookLabel: 'Auto-dispatch',
          jobId,
          hhJobNumber,
          assignmentId,
        },
        () => autoDispatchJob({
          jobId,
          source: 'staff-bookout',
          actorLabel,
          actorUserId,
          interactionContent: `🚐 Job dispatched — booked out by ${actorLabel}.`,
        }).then(() => undefined)
      ).catch((err) => {
        console.error(`[hire-forms] auto-dispatch failed for job ${jobId}:`, err);
      });
    });
  }
}

router.patch('/:id', authenticateVehicleFlexible, validate(patchSchema), async (req: FlexibleVehicleRequest & AuthRequest, res: Response) => {
  try {
    const id = req.params.id as string;
    let updates = req.body;

    // Freelancer scope + silent-strip. Done BEFORE the overlap/SQL work
    // below so the rest of the handler can treat freelancer and staff
    // requests identically.
    if (isFreelancerBookout(req)) {
      const scope = await getBookoutScope(req);
      if (!scope) {
        return res.status(403).json({ error: 'Assignment not found' });
      }

      // Confirm the target row sits on the same job as the freelancer's
      // session. Multi-driver-on-one-van: customer hire forms for sibling
      // drivers are also accessible (same job), so the writeback loop in
      // BookOutPage can stamp the same vehicle_id across all of them.
      const targetRow = await query(
        `SELECT job_id, hirehop_job_id, driver_id
           FROM vehicle_hire_assignments WHERE id = $1`,
        [id]
      );
      if (targetRow.rows.length === 0) {
        return res.status(404).json({ error: 'Hire form not found' });
      }
      const target = targetRow.rows[0];
      const onSameJob =
        (scope.jobId && target.job_id === scope.jobId) ||
        (scope.hhJobNumber && target.hirehop_job_id === scope.hhJobNumber);
      if (!onSameJob) {
        return res.status(403).json({ error: 'Hire form is not on your job' });
      }

      // If the freelancer's client tries to set vehicle_id to anything
      // OTHER than their own allocated van, that's a bug or a tamper
      // attempt — clamp to scope.vehicleId. Same blast radius as silent
      // strip: don't surprise the freelancer with a 403 mid-handover.
      if (updates.vehicle_id && updates.vehicle_id !== scope.vehicleId) {
        console.warn('[hire-forms] Freelancer PATCH tried to set vehicle_id outside session scope; clamping', {
          assignmentId: id,
          attempted: updates.vehicle_id,
          scopeVehicle: scope.vehicleId,
        });
        updates = { ...updates, vehicle_id: scope.vehicleId };
      }

      // Silent-strip non-whitelisted fields. We rebuild the updates object
      // so anything the freelancer's client accidentally sends (notes,
      // client_email, future schema additions) is dropped without
      // disrupting the flow.
      const filtered: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(updates)) {
        if (FREELANCER_PATCH_ALLOW.has(k)) filtered[k] = v;
      }
      // Lock status to 'booked_out' — freelancers can flip out of
      // 'soft'/'confirmed' but not into anything else.
      if (filtered.status && filtered.status !== 'booked_out') {
        delete filtered.status;
      }
      updates = filtered;
      if (Object.keys(updates).length === 0) {
        // Nothing left to write — return 200 idempotently rather than
        // 400, so the freelancer's writeback loop registers as success.
        return res.json({ data: { id, no_op: true } });
      }
    }

    // Guard: never let a vehicle-link or book-out write land on a TERMINAL row
    // (swapped / returned / cancelled). After a swap, by-job used to surface the
    // swapped original alongside the replacement; the BookOutPage writeback loop
    // then stamped the replacement van's reg + status='booked_out' onto the
    // swapped row, resurrecting it as a duplicate booked_out row and leaving the
    // outgoing van with no live assignment (job 15828, RX21UOB→RX24SZE, Jun 2026
    // — the same class as RX73TBZ). by-job no longer returns swapped rows, but
    // this is the belt-and-braces stop for any other caller: a stale tab, an
    // offline-queue replay, or a direct API call. No-op (200) rather than 4xx so
    // the writeback loop treats it as success and moves on without corrupting it.
    const wantsVehicleChange = updates.vehicle_id !== undefined;
    const wantsBookOut = updates.status === 'booked_out';
    if (wantsVehicleChange || wantsBookOut) {
      const cur = await query(
        `SELECT status FROM vehicle_hire_assignments WHERE id = $1`,
        [id]
      );
      if (cur.rows.length === 0) {
        return res.status(404).json({ error: 'Hire form not found' });
      }
      const curStatus = cur.rows[0].status as string;
      if (curStatus === 'swapped' || curStatus === 'returned' || curStatus === 'cancelled') {
        console.warn(
          `[hire-forms] PATCH ignored on terminal row ${id} (status=${curStatus}); ` +
          `refusing vehicle-link/book-out write (wantsVehicleChange=${wantsVehicleChange}, wantsBookOut=${wantsBookOut})`
        );
        return res.json({ data: { id, no_op: true, reason: 'terminal_status' } });
      }
    }

    // Overlap check when a vehicle is being linked/changed. We only run the
    // check if vehicle_id is being SET to a non-null value; unlinking (null)
    // is always allowed. Self-assignment (same vehicle) is excluded via the
    // excludeAssignmentId filter in findOverlappingAssignments.
    if (updates.vehicle_id !== undefined && updates.vehicle_id !== null) {
      const existingAssignment = await query(
        `SELECT vehicle_id, job_id, hirehop_job_id, hire_start, hire_end
         FROM vehicle_hire_assignments WHERE id = $1`,
        [id]
      );
      if (existingAssignment.rows.length === 0) {
        return res.status(404).json({ error: 'Hire form not found' });
      }
      const existing = existingAssignment.rows[0];
      if (existing.vehicle_id !== updates.vehicle_id) {
        const conflicts = await findOverlappingAssignments({
          vehicleId: updates.vehicle_id,
          hireStart: existing.hire_start,
          hireEnd: existing.hire_end,
          jobId: existing.job_id,
          hirehopJobId: existing.hirehop_job_id,
          excludeAssignmentId: id,
        });
        if (conflicts.length > 0) {
          return res.status(409).json(buildConflictPayload(conflicts));
        }
      }
    }

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

    // Stamp booked_out_at (and booked_out_by) on the booked_out transition.
    // Without this, a book-out driven purely through this PATCH — the
    // BookOutPage writeback loop that flips every hire form on the van — leaves
    // booked_out_at NULL. Only the SEPARATE save-event vehicle event ever set
    // it. When that event fails to land (transient error, abandoned walkaround,
    // offline-queue not flushed), the row reads as booked_out with no timestamp
    // and no history card, which then fools the check-in job-resolver into
    // picking a stale book-out from a PREVIOUS hire (RX73TBZ, jobs 16057↔16149,
    // Jun 2026 — the Unpeople return got stamped against the prior Ritchie Prior
    // hire). COALESCE keeps it idempotent on PATCH retries and never overwrites
    // a real walkaround timestamp. Freelancer book-outs (no req.user) still get
    // booked_out_at; they just don't stamp booked_out_by.
    if (updates.status === 'booked_out') {
      setClauses.push(`booked_out_at = COALESCE(booked_out_at, NOW())`);
      const bookedOutActor = req.user?.id || null;
      if (bookedOutActor) {
        setClauses.push(`booked_out_by = COALESCE(booked_out_by, $${paramIdx})`);
        values.push(bookedOutActor);
        paramIdx++;
      }
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

    const updated = result.rows[0];
    console.log(`[hire-forms] Updated assignment ${id}:`, Object.keys(updates).join(', '));

    // Recompute the pre-hire vehicle requirement status whenever vehicle_id
    // or status changes — both add to and subtract from "vehicles assigned"
    // count for this job. The helper handles done/in_progress/not_started
    // bidirectionally (linking AND un-linking), respects manual 'blocked'
    // status, and handles multi-van quantity.
    const vehicleStateChanged =
      updates.vehicle_id !== undefined || updates.status !== undefined;
    if (vehicleStateChanged && updated.job_id) {
      const jobId: string = updated.job_id;
      const hhJobId: number | null = updated.hirehop_job_id ?? null;
      setImmediate(() => {
        runHookWithRecovery(
          {
            hookLabel: 'Vehicle requirement sync',
            jobId,
            hhJobNumber: hhJobId,
            assignmentId: id,
          },
          async () => {
            const { syncVehicleRequirementStatus } = await import('../services/vehicle-requirement-sync');
            await syncVehicleRequirementStatus(jobId);
          }
        ).catch((err) => {
          console.warn(`[hire-forms] Vehicle requirement sync failed for job ${jobId}:`, err);
        });
      });
    }

    // Post-update side effects on book-out transition.
    //
    // The live book-out UI (frontend/src/modules/vehicles/pages/BookOutPage.tsx)
    // drives a PATCH here with status='booked_out' once the walkaround is
    // complete. At that point the assignment has a confirmed vehicle, so
    // this is the right moment to (a) update the fleet's hire_status and
    // (b) generate + email the definitive hire agreement PDF with the real
    // reg. We skip the email if one has already been sent for this
    // assignment (idempotent — a staff PATCH retry shouldn't re-spam).
    const nowBookedOut = updates.status === 'booked_out' && updated.status === 'booked_out';
    if (nowBookedOut && !updated.vehicle_id) {
      // Loud warning — the assignment just transitioned to booked_out
      // without a linked vehicle, which means the post-book-out chain
      // below (fleet hire_status sync, requirement advance, hire
      // agreement PDF + email) all silently no-op. The save-event
      // book-out side-effect now backfills vehicle_id via its
      // null-vehicle fallback, but if we're seeing this warning the
      // front-end should also be passing vehicle_id on the PATCH
      // (28 Apr 2026 RX22SWU incident).
      console.warn(
        `[hire-forms] PATCH set status=booked_out on assignment ${id} ` +
        `but vehicle_id is NULL — post-book-out hooks skipped. ` +
        `Caller should include vehicle_id in the PATCH body, or rely ` +
        `on the save-event backstop to backfill it.`
      );
    }
    if (nowBookedOut && updated.vehicle_id) {
      // Orphan dedup: now this hire-form row owns the van, cancel any
      // sibling staff-allocation row (driver_id NULL, never booked out) for
      // the same (vehicle, job). Without this, the stale 'confirmed' sibling
      // keeps "occupying" the van in overlap checks and blocks future
      // allocations + swaps (the 15 May 2026 HLU/15613 incident). Awaited so
      // the data is consistent before the response + the fleet status sync
      // inside firePostBookOutHooks observes the cleaned-up state.
      try {
        const cancelled = await cancelOrphanSiblingAllocations({
          keepAssignmentId: id,
          vehicleId: updated.vehicle_id,
          jobId: updated.job_id ?? null,
          hhJobNumber: updated.hirehop_job_id ?? null,
        });
        if (cancelled > 0) {
          console.log(
            `[hire-forms] PATCH book-out: cancelled ${cancelled} orphan staff-allocation sibling(s) for assignment ${id}`,
          );
        }
      } catch (err) {
        console.warn(`[hire-forms] orphan dedup failed for assignment ${id}:`, err);
      }

      const isFreelancer = isFreelancerBookout(req);
      firePostBookOutHooks({
        assignmentId: id,
        vehicleId: updated.vehicle_id,
        jobId: updated.job_id ?? null,
        hhJobNumber: updated.hirehop_job_id ?? null,
        returnOvernight: updated.return_overnight,
        hireFormEmailedAt: updated.hire_form_emailed_at,
        actorLabel: isFreelancer ? 'freelancer book-out' : (req.user?.email || 'staff'),
        actorUserId: isFreelancer ? null : (req.user?.id || null),
      });
    }

    res.json({ data: updated });
  } catch (error) {
    console.error('[hire-forms] Patch error:', error);
    res.status(500).json({ error: 'Failed to update hire form' });
  }
});

// ── Add to Hire (mid-tour driver linking) ──
//
// When a job is already dispatched and a new driver submits a hire form,
// their assignment row lands with vehicle_id NULL. The driver is on the
// tour but isn't linked to any of the vans physically out on the road.
// "Add to Hire" links them to one or more already-booked-out vans on the
// same job WITHOUT a fresh walkaround (the sibling driver's book-out
// record covers the van's physical handover).
//
// For each chosen van:
//   - First van: updates the existing assignment row (hire_start=NOW,
//     hire_end + return_overnight inherited from sibling, status=booked_out)
//   - Additional vans: clones the row with the new vehicle_id
// Each resulting assignment then fires the standard post-book-out hook
// chain — fresh hire agreement PDF + email per van (vehicle reg is baked
// into each PDF), OOH info if applicable, requirement advance.

const addToHireSchema = z.object({
  vehicle_ids: z.array(z.string().uuid()).min(1).max(10),
});

router.post(
  '/:id/add-to-hire',
  authenticate,
  validate(addToHireSchema),
  async (req: AuthRequest, res: Response) => {
    const sourceId = req.params.id as string;
    const requestedVehicleIds: string[] = Array.from(new Set(req.body.vehicle_ids));

    const pool = getPool();
    const dbClient = await pool.connect();

    try {
      // 1. Load source assignment with driver info
      const sourceResult = await dbClient.query(
        `SELECT a.*,
                d.full_name AS driver_name,
                d.email AS driver_email
         FROM vehicle_hire_assignments a
         LEFT JOIN drivers d ON d.id = a.driver_id
         WHERE a.id = $1`,
        [sourceId]
      );

      if (sourceResult.rows.length === 0) {
        return res.status(404).json({ error: 'Hire form not found' });
      }

      const source = sourceResult.rows[0];

      // 2. Validate source is in a state to be added mid-tour
      if (source.vehicle_id) {
        return res.status(400).json({
          error: 'Driver is already linked to a vehicle. Use Swap Vehicle if you need to change it.',
        });
      }
      if (!['soft', 'confirmed'].includes(source.status)) {
        return res.status(400).json({
          error: `Assignment is in status '${source.status}' and cannot be added to a hire. ` +
                 `Expected 'soft' or 'confirmed'.`,
        });
      }
      if (source.assignment_type !== 'self_drive') {
        return res.status(400).json({
          error: `Add to Hire is only supported for self-drive customer hires (got '${source.assignment_type}').`,
        });
      }
      if (!source.job_id && !source.hirehop_job_id) {
        return res.status(400).json({
          error: 'Assignment has no linked job — cannot identify booked-out siblings.',
        });
      }

      // 3. For each requested van, find a sibling assignment in
      //    booked_out/active on the same job. Used for hire_end +
      //    return_overnight inheritance and as a hard validation that
      //    the van is actually out on this job (not a free van).
      const siblings: Array<{
        vehicle_id: string;
        vehicle_reg: string;
        hire_end: Date | null;
        return_overnight: boolean | null;
      }> = [];

      for (const vehicleId of requestedVehicleIds) {
        const siblingResult = await dbClient.query(
          `SELECT a.vehicle_id, a.hire_end, a.return_overnight, fv.reg AS vehicle_reg
           FROM vehicle_hire_assignments a
           JOIN fleet_vehicles fv ON fv.id = a.vehicle_id
           WHERE a.vehicle_id = $1
             AND a.id != $2
             AND a.status IN ('booked_out', 'active')
             AND (
               ($3::uuid IS NOT NULL AND a.job_id = $3::uuid)
               OR
               ($4::integer IS NOT NULL AND a.hirehop_job_id = $4::integer)
             )
           ORDER BY a.booked_out_at DESC NULLS LAST
           LIMIT 1`,
          [vehicleId, sourceId, source.job_id, source.hirehop_job_id]
        );

        if (siblingResult.rows.length === 0) {
          return res.status(400).json({
            error: `Vehicle ${vehicleId} is not currently booked out on this job — cannot add driver mid-hire.`,
          });
        }
        siblings.push(siblingResult.rows[0]);
      }

      // 4. Transactional update + cloning
      await dbClient.query('BEGIN');

      const affected: Array<{
        id: string;
        vehicle_id: string;
        vehicle_reg: string;
        return_overnight: boolean | null;
        hire_form_emailed_at: Date | null;
        is_clone: boolean;
      }> = [];

      // First van: update source row. start_time is set to LOCALTIME (now)
      // because the driver only became authorised at this moment — the
      // original hire form's nominal 09:00 start no longer applies.
      const first = siblings[0];
      const firstUpdate = await dbClient.query(
        `UPDATE vehicle_hire_assignments
         SET vehicle_id = $1,
             hire_start = CURRENT_DATE,
             start_time = LOCALTIME,
             hire_end = COALESCE($2, hire_end),
             return_overnight = $3,
             status = 'booked_out',
             status_changed_at = NOW(),
             booked_out_at = NOW(),
             booked_out_by = $4,
             updated_at = NOW()
         WHERE id = $5
         RETURNING id, vehicle_id, return_overnight, hire_form_emailed_at`,
        [first.vehicle_id, first.hire_end, first.return_overnight, req.user!.id, sourceId]
      );
      const firstRow = firstUpdate.rows[0];
      affected.push({
        id: firstRow.id,
        vehicle_id: firstRow.vehicle_id,
        vehicle_reg: first.vehicle_reg,
        return_overnight: firstRow.return_overnight,
        hire_form_emailed_at: firstRow.hire_form_emailed_at,
        is_clone: false,
      });

      // Additional vans: clone source row, one per van
      for (let i = 1; i < siblings.length; i++) {
        const sib = siblings[i];
        const cloneResult = await dbClient.query(
          `INSERT INTO vehicle_hire_assignments (
             vehicle_id, job_id, hirehop_job_id, hirehop_job_name,
             driver_id, assignment_type, van_requirement_index,
             required_type, required_gearbox,
             status, status_changed_at,
             hire_start, hire_end, start_time, end_time, return_overnight,
             booked_out_at, booked_out_by,
             client_email,
             notes, allocated_by_name, created_by
           )
           VALUES (
             $1, $2, $3, $4,
             $5, $6, $7,
             $8, $9,
             'booked_out', NOW(),
             CURRENT_DATE, $10, LOCALTIME, $11, $12,
             NOW(), $13,
             $14,
             $15, $16, $17
           )
           RETURNING id, vehicle_id, return_overnight, hire_form_emailed_at`,
          [
            sib.vehicle_id,
            source.job_id,
            source.hirehop_job_id,
            source.hirehop_job_name,
            source.driver_id,
            source.assignment_type,
            source.van_requirement_index ?? 0,
            source.required_type,
            source.required_gearbox,
            sib.hire_end,
            source.end_time,
            sib.return_overnight,
            req.user!.id,
            source.client_email,
            `Cloned from assignment ${sourceId} for mid-tour add-to-hire (multi-van).`,
            source.allocated_by_name,
            req.user!.id,
          ]
        );
        const cloneRow = cloneResult.rows[0];
        affected.push({
          id: cloneRow.id,
          vehicle_id: cloneRow.vehicle_id,
          vehicle_reg: sib.vehicle_reg,
          return_overnight: cloneRow.return_overnight,
          hire_form_emailed_at: cloneRow.hire_form_emailed_at,
          is_clone: true,
        });
      }

      // 5. Log interaction(s) on the job timeline — one per van for an
      //    auditable trail. created_by must be UUID; req.user.id is fine.
      if (source.job_id) {
        const regList = affected.map(a => a.vehicle_reg).join(', ');
        const driverDisplay = source.driver_name || 'Driver';
        await dbClient.query(
          `INSERT INTO interactions (type, content, job_id, created_by)
           VALUES ('note', $1, $2, $3)`,
          [
            `🚐 ${driverDisplay} added mid-hire to ${regList} (hire window inherited from existing booking; hire start set to ${new Date().toLocaleString('en-GB')}).`,
            source.job_id,
            req.user!.id,
          ]
        );
      }

      await dbClient.query('COMMIT');

      // 6. Fire the post-book-out hook chain for each affected assignment.
      //    Per-vehicle hooks (fleet status, PDF + email) need to fire per
      //    row. Per-job hooks (requirement advance, OOH, auto-dispatch) are
      //    idempotent so the cost of multiple calls is minimal.
      const actorLabel = req.user?.email ? `${req.user.email} (add-to-hire)` : 'staff (add-to-hire)';
      const actorUserId = req.user?.id || null;

      for (const a of affected) {
        firePostBookOutHooks({
          assignmentId: a.id,
          vehicleId: a.vehicle_id,
          jobId: source.job_id ?? null,
          hhJobNumber: source.hirehop_job_id ?? null,
          returnOvernight: a.return_overnight,
          hireFormEmailedAt: a.hire_form_emailed_at,
          actorLabel,
          actorUserId,
        });
      }

      // 7. Vehicle requirement sync — same as standard PATCH does on any
      //    vehicle state change. Once per job.
      if (source.job_id) {
        const jobIdForSync: string = source.job_id;
        const hhJobIdForSync: number | null = source.hirehop_job_id ?? null;
        const assignmentIdForSync: string = affected[0].id;
        setImmediate(() => {
          runHookWithRecovery(
            {
              hookLabel: 'Vehicle requirement sync',
              jobId: jobIdForSync,
              hhJobNumber: hhJobIdForSync,
              assignmentId: assignmentIdForSync,
            },
            async () => {
              const { syncVehicleRequirementStatus } = await import('../services/vehicle-requirement-sync');
              await syncVehicleRequirementStatus(jobIdForSync);
            }
          ).catch((err) => {
            console.warn(`[hire-forms] Vehicle requirement sync failed for job ${jobIdForSync}:`, err);
          });
        });
      }

      console.log(
        `[hire-forms] Add-to-Hire: linked assignment ${sourceId} to ${affected.length} van(s): ${affected.map(a => a.vehicle_reg).join(', ')}`
      );

      res.json({
        data: {
          source_assignment_id: sourceId,
          assignments: affected.map(a => ({
            id: a.id,
            vehicle_id: a.vehicle_id,
            vehicle_reg: a.vehicle_reg,
            is_clone: a.is_clone,
          })),
        },
      });
    } catch (error) {
      try { await dbClient.query('ROLLBACK'); } catch { /* swallow */ }
      console.error('[hire-forms] Add-to-Hire error:', error);
      res.status(500).json({ error: 'Failed to add driver to hire' });
    } finally {
      dbClient.release();
    }
  }
);

/**
 * Look up the OP job_id for an assignment. Used by the email fallback
 * path so we can resolve a job-level recipient (info@ + amber banner +
 * timeline log) when the assignment's driver has no email on record.
 */
async function getJobIdForAssignment(assignmentId: string): Promise<string | null> {
  const result = await query(
    `SELECT job_id FROM vehicle_hire_assignments WHERE id = $1`,
    [assignmentId]
  );
  return result.rows[0]?.job_id || null;
}

/**
 * Resolve the recipient for a hire-agreement email. Prefer the driver's
 * email (from the hire form). If absent, fall back to the job's client
 * recipients via resolveClientEmailTarget — which itself falls back to
 * info@oooshtours.co.uk with an amber banner + timeline interaction so
 * staff can forward manually and patch the address book.
 *
 * Returns the bits the caller needs to send + log the fallback.
 */
async function resolveHireFormEmailTarget(
  assignmentId: string,
  driverEmail: string | null,
): Promise<
  | { kind: 'driver'; to: string; cc: string[]; banner: undefined; jobId: string | null }
  | { kind: 'fallback'; to: string; cc: string[]; banner: string; jobId: string }
  | { kind: 'none' }
> {
  if (driverEmail) {
    return { kind: 'driver', to: driverEmail, cc: [], banner: undefined, jobId: await getJobIdForAssignment(assignmentId) };
  }
  const jobId = await getJobIdForAssignment(assignmentId);
  if (!jobId) return { kind: 'none' };
  const target = await resolveClientEmailTarget(jobId);
  // resolveClientEmailTarget always returns a primaryEmail (info@ in the
  // worst case), so we always have somewhere to send. The flag tells us
  // whether to attach the banner + log the timeline entry.
  return target.isFallback
    ? {
        kind: 'fallback',
        to: target.primaryEmail,
        cc: target.ccEmails,
        banner: buildFallbackBanner({
          jobId,
          clientName: target.clientName,
          jobNumber: target.jobNumber,
          jobName: target.jobName,
        }),
        jobId,
      }
    : { kind: 'driver', to: target.primaryEmail, cc: target.ccEmails, banner: undefined, jobId };
}

/**
 * Generate the definitive hire agreement PDF for an assignment, upload to R2,
 * and email it to the driver with the PDF attached. Used by the book-out
 * transition hook in the PATCH handler above, and shared with the on-demand
 * generate-pdf endpoint below.
 *
 * Recipient resolution chain:
 *   1. driver's email on the hire form (the customer who signed)
 *   2. job-level client contacts via resolveClientEmailTarget
 *   3. info@oooshtours.co.uk + amber banner + timeline interaction
 *
 * Step 3 makes sure the agreement is never silently dropped when no
 * client email is on file — staff get a forwardable copy so the customer
 * still receives their PDF, and the address-book gap gets surfaced for
 * manual fixing.
 */
async function generateAndEmailHireFormPdf(assignmentId: string, trigger: string): Promise<void> {
  const formData = await loadHireFormData(assignmentId);
  if (!formData) {
    console.warn(`[hire-forms] ${trigger}: loadHireFormData returned null for ${assignmentId}`);
    return;
  }
  if (!formData.vehicleReg || formData.vehicleReg === 'TBC') {
    console.warn(`[hire-forms] ${trigger}: skipping PDF for ${assignmentId} — no vehicle assigned`);
    return;
  }

  const { pdfBytes, filename } = await generateHireFormPdf(formData);
  const r2Key = `hire-forms/${assignmentId}/${filename}`;
  await uploadToR2(r2Key, Buffer.from(pdfBytes), 'application/pdf');

  await query(
    `UPDATE vehicle_hire_assignments
     SET hire_form_pdf_key = $1, hire_form_generated_at = NOW(), updated_at = NOW()
     WHERE id = $2`,
    [r2Key, assignmentId]
  );

  console.log(`[hire-forms] ${trigger}: PDF generated for ${assignmentId} (${pdfBytes.length} bytes)`);

  const target = await resolveHireFormEmailTarget(assignmentId, formData.email);
  if (target.kind === 'none') {
    console.warn(`[hire-forms] ${trigger}: no email recipient resolvable for ${assignmentId}; PDF stored but not emailed`);
    return;
  }

  const emailResult = await emailService.send('hire_form', {
    to: target.to,
    cc: target.cc.length > 0 ? target.cc : undefined,
    prependBanner: target.kind === 'fallback' ? target.banner : undefined,
    variables: {
      driverName: formData.driverName,
      vehicleReg: formData.vehicleReg || 'TBC',
      vehicleModel: formData.vehicleModel || 'TBC',
      hireStart: fmtDate(formData.hireStartDate),
      hireEnd: fmtDate(formData.hireEndDate),
      jobNumber: formData.hhJobNumber || '',
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
      [assignmentId]
    );
    console.log(`[hire-forms] ${trigger}: email sent to ${target.to} for ${assignmentId}${target.kind === 'fallback' ? ' (fallback to info@)' : ''}`);
    if (target.kind === 'fallback' && target.jobId) {
      await logFallbackToTimeline({ jobId: target.jobId, templateId: 'hire_form' });
    }
  } else {
    console.warn(`[hire-forms] ${trigger}: email failed for ${assignmentId}:`, emailResult);
  }
}

/**
 * Fan a just-booked-out van's hire agreement out to every OTHER self-drive
 * driver on the job (drivers not on this van get a PDF for it too, so on a
 * multi-van hire every driver ends up holding an agreement for every van).
 *
 * No-op on single-van jobs: the only drivers are on the booked-out van, so
 * the target set is empty. Each (driver, van) PDF is generated + emailed
 * exactly once — the hire_form_documents UNIQUE(assignment_id, vehicle_id)
 * constraint serialises concurrent book-out hooks (a multi-driver van fires
 * this once per driver) so nobody is emailed twice. Throws if any cross-van
 * email failed, so runHookWithRecovery retries just the failed ones (a failed
 * leg drops its claim row, the succeeded ones short-circuit on re-run).
 */
async function fanOutVanHireForms(ctx: {
  jobId: string | null;
  hhJobNumber: number | null;
  vanVehicleId: string;
}): Promise<void> {
  const { jobId, hhJobNumber, vanVehicleId } = ctx;

  // Target = signed self-drive drivers on the job NOT on the booked-out van
  // (those get this van's agreement via their own-van column path). One row
  // per driver. `IS DISTINCT FROM` keeps not-yet-allocated (NULL vehicle_id)
  // drivers in the target set too.
  const targets = await query(
    `SELECT DISTINCT ON (vha.driver_id) vha.id
       FROM vehicle_hire_assignments vha
      WHERE (($1::uuid IS NOT NULL AND vha.job_id = $1)
             OR ($2::int IS NOT NULL AND vha.hirehop_job_id = $2))
        AND vha.assignment_type = 'self_drive'
        AND vha.driver_id IS NOT NULL
        AND vha.status NOT IN ('cancelled', 'swapped')
        AND vha.vehicle_id IS DISTINCT FROM $3
      ORDER BY vha.driver_id, vha.created_at`,
    [jobId, hhJobNumber, vanVehicleId]
  );
  if (targets.rows.length === 0) return;

  let anyFailed = false;
  for (const t of targets.rows) {
    const status = await generateAndEmailCrossVanHireForm(t.id as string, vanVehicleId, { jobId, hhJobNumber });
    if (status === 'failed') anyFailed = true;
  }
  if (anyFailed) {
    throw new Error('one or more cross-van hire form emails failed — will retry');
  }
}

/**
 * Generate + email ONE driver a hire agreement for a van that is NOT their
 * own assigned van (the cross-van leg of fanOutVanHireForms). Same driver
 * data + dates as their own agreement, with the other van's reg/model swapped
 * in — the PDF builder already takes a single reg, so no builder change.
 *
 * Idempotency: claim-first INSERT against UNIQUE(assignment_id, vehicle_id).
 * Loser of a concurrent race gets 0 rows → 'skipped' (never emails). On email
 * failure the claim is dropped so a later book-out can retry cleanly.
 */
async function generateAndEmailCrossVanHireForm(
  driverAssignmentId: string,
  vanVehicleId: string,
  ctx: { jobId: string | null; hhJobNumber: number | null },
): Promise<'sent' | 'skipped' | 'failed'> {
  const claim = await query(
    `INSERT INTO hire_form_documents (assignment_id, vehicle_id, driver_id, job_id, hirehop_job_id)
     SELECT $1, $2, vha.driver_id, $3, $4
       FROM vehicle_hire_assignments vha WHERE vha.id = $1
     ON CONFLICT (assignment_id, vehicle_id) DO NOTHING
     RETURNING id`,
    [driverAssignmentId, vanVehicleId, ctx.jobId, ctx.hhJobNumber],
  );
  if (claim.rows.length === 0) return 'skipped';
  const docId = claim.rows[0].id as string;

  try {
    const formData = await loadHireFormData(driverAssignmentId);
    if (!formData) {
      await query(`DELETE FROM hire_form_documents WHERE id = $1`, [docId]);
      return 'failed';
    }

    const van = await query(`SELECT reg, vehicle_type, make, model FROM fleet_vehicles WHERE id = $1`, [vanVehicleId]);
    const vanReg = van.rows[0]?.reg as string | undefined;
    const vanModel = (van.rows[0]?.vehicle_type as string | undefined) || '';
    if (!vanReg || vanReg === 'TBC') {
      await query(`DELETE FROM hire_form_documents WHERE id = $1`, [docId]);
      return 'failed';
    }

    // Swap in the cross van — everything else stays the driver's own.
    formData.vehicleReg = vanReg;
    formData.vehicleModel = vanModel;
    formData.vehicleMakeModel = composeMakeModel(van.rows[0]?.make, van.rows[0]?.model) || undefined;

    const { pdfBytes, filename } = await generateHireFormPdf(formData);
    const r2Key = `hire-forms/${driverAssignmentId}/${filename}`;
    await uploadToR2(r2Key, Buffer.from(pdfBytes), 'application/pdf');

    const target = await resolveHireFormEmailTarget(driverAssignmentId, formData.email);
    if (target.kind === 'none') {
      // No recipient — keep the PDF + record (proof of authorisation) but leave
      // emailed_at NULL. Won't auto-retry; staff can resend if a contact lands.
      await query(
        `UPDATE hire_form_documents SET vehicle_reg = $1, pdf_r2_key = $2 WHERE id = $3`,
        [vanReg, r2Key, docId],
      );
      console.warn(`[hire-forms] cross-van: no recipient for ${driverAssignmentId} van ${vanReg}; PDF stored, not emailed`);
      return 'skipped';
    }

    const emailResult = await emailService.send('hire_form', {
      to: target.to,
      cc: target.cc.length > 0 ? target.cc : undefined,
      prependBanner: target.kind === 'fallback' ? target.banner : undefined,
      variables: {
        driverName: formData.driverName,
        vehicleReg: vanReg,
        vehicleModel: vanModel || 'TBC',
        hireStart: fmtDate(formData.hireStartDate),
        hireEnd: fmtDate(formData.hireEndDate),
        jobNumber: formData.hhJobNumber || '',
        multiVanNote: 'yes',
      },
      attachments: [{ filename, content: Buffer.from(pdfBytes), contentType: 'application/pdf' }],
    });

    if (!emailResult.success) {
      await query(`DELETE FROM hire_form_documents WHERE id = $1`, [docId]);
      console.warn(`[hire-forms] cross-van: email failed for ${driverAssignmentId} van ${vanReg}`);
      return 'failed';
    }

    await query(
      `UPDATE hire_form_documents
         SET vehicle_reg = $1, pdf_r2_key = $2, email_to = $3, emailed_at = NOW()
       WHERE id = $4`,
      [vanReg, r2Key, target.to, docId],
    );
    if (target.kind === 'fallback' && target.jobId) {
      await logFallbackToTimeline({ jobId: target.jobId, templateId: 'hire_form' });
    }
    console.log(`[hire-forms] cross-van: ${vanReg} agreement sent to ${target.to} for assignment ${driverAssignmentId}`);
    return 'sent';
  } catch (err) {
    await query(`DELETE FROM hire_form_documents WHERE id = $1`, [docId]).catch(() => {});
    console.error(`[hire-forms] cross-van: error for ${driverAssignmentId} van ${vanVehicleId}:`, err);
    return 'failed';
  }
}

// ── Helper: load full data for PDF generation ──

async function loadHireFormData(assignmentId: string): Promise<HireFormData | null> {
  // Date/time resolution: vehicle_hire_assignments.hire_start/hire_end/
  // start_time/end_time are treated as OVERRIDES. If any are null, fall
  // back to the parent job's job_date/job_end (and 09:00 for times,
  // per Ooosh T&Cs: "rental period starts at 9am on the first date of
  // hire and concludes at 9am the morning after the final hired day").
  // Prevents blank dates/times appearing on the hire agreement email +
  // PDF when assignment dates weren't populated upstream.
  //
  // Fallback uses j.job_end (Job Finish — the real end of the hire window)
  // NOT j.return_date (which is the +1-day turnaround buffer for warehouse
  // scheduling). Aligned with the overlap-check service so dates are
  // consistent across the codebase.
  const result = await query(
    `SELECT vha.*,
      COALESCE(vha.hire_start, j.job_date) AS resolved_hire_start,
      COALESCE(vha.hire_end, j.job_end) AS resolved_hire_end,
      COALESCE(vha.start_time, '09:00') AS resolved_start_time,
      COALESCE(vha.end_time, '09:00') AS resolved_end_time,
      COALESCE(j.hh_job_number, vha.hirehop_job_id) AS resolved_hh_job_number,
      fv.reg AS vehicle_reg,
      fv.vehicle_type AS vehicle_model,
      fv.make AS vehicle_make,
      fv.model AS vehicle_make_model,
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
      d.calculated_excess_amount AS driver_calculated_excess,
      je.excess_amount_required,
      je.excess_status
    FROM vehicle_hire_assignments vha
    LEFT JOIN fleet_vehicles fv ON fv.id = vha.vehicle_id
    LEFT JOIN drivers d ON d.id = vha.driver_id
    LEFT JOIN job_excess je ON je.assignment_id = vha.id
    LEFT JOIN jobs j ON j.id = vha.job_id
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

  // Format excess amount \u2014 SOURCE OF TRUTH is the DRIVER's personal
  // liability (drivers.calculated_excess_amount), NOT the per-job
  // job_excess.excess_amount_required.
  //
  // job_excess is the per-job REALISATION \u2014 for drivers marked
  // 'not_required' by the top-N-drivers algorithm (e.g. a second
  // driver on a single van whose excess slot is covered by a sibling
  // in the top slot) it carries \u00A30 and excess_status='not_required'.
  // Using it on the PDF showed \u00A30 for those drivers and misrepresented
  // their actual liability. Their personal liability stands at \u00A31,200+
  // regardless \u2014 that's what the hire agreement legally commits them to.
  //
  // Same fix shape as the /drivers page got in migration 065 ("Driver-
  // level liability model"). \u00A31,200 floor as defensive fallback for
  // pre-migration-065 drivers whose calculated_excess_amount may be NULL.
  let excessStr = '';
  const personalLiability = row.driver_calculated_excess
    ? parseFloat(row.driver_calculated_excess)
    : null;
  const excessAmount = personalLiability && personalLiability >= 1200
    ? personalLiability
    : 1200;
  excessStr = `\u00A3${excessAmount.toLocaleString('en-GB', { minimumFractionDigits: 0 })}`;

  // Try to load signature from driver files. Files are stored via
  // driver-verification's /upload endpoint with the R2 key under `url`
  // (not `r2_key` — that was an aborted schema). We match by tag first
  // ('signature'), falling back to label and filename-prefix to catch
  // variations from the hire form app. `r2_key` is kept as a last-resort
  // fallback in case any legacy records ever shipped with it.
  let signatureImage: Buffer | null = null;
  if (row.driver_files) {
    const files = typeof row.driver_files === 'string' ? JSON.parse(row.driver_files) : row.driver_files;
    const matchesSignature = (f: Record<string, unknown>) => {
      const tag = String(f.tag || '').toLowerCase();
      const label = String(f.label || '').toLowerCase();
      const name = String(f.name || '').toLowerCase();
      return tag === 'signature' || tag === 'sig' ||
             label === 'signature' || label === 'sig' ||
             name.startsWith('signature') || name.startsWith('sig_');
    };
    const sigFile = Array.isArray(files) ? files.find(matchesSignature) : null;
    const sigKey = (sigFile?.url || sigFile?.r2_key) as string | undefined;
    if (sigKey) {
      try {
        const resp = await getFromR2(sigKey);
        if (resp.Body) {
          const chunks: Buffer[] = [];
          const stream = resp.Body as NodeJS.ReadableStream;
          for await (const chunk of stream) {
            chunks.push(Buffer.from(chunk as Uint8Array));
          }
          signatureImage = Buffer.concat(chunks);
          console.log(`[hire-forms] Loaded signature from R2: ${sigKey}`);
        }
      } catch (e) {
        console.warn('[hire-forms] Could not load signature from R2:', (e as Error).message);
      }
    } else if (Array.isArray(files) && files.length > 0) {
      console.warn('[hire-forms] No signature file found in driver.files (tag/label/name match failed)');
    }
  }

  const logoImage = await fetchLogo();

  // node-postgres returns DATE columns as JS Date objects (not ISO strings).
  // String(dateObj) produces locale toString() output like "Sun Jan 09 1983
  // 00:00:00 GMT+0000 (GMT)" — no 'T' character to split on, so the previous
  // .split('T')[0] approach returned the raw toString which leaked into the
  // PDF as "Sun Jan 09 1983 00:00:00 GM...". Use toISOString() which is
  // always YYYY-MM-DDTHH:MM:SS.sssZ.
  function toISODate(v: unknown): string | undefined {
    if (v === null || v === undefined || v === '') return undefined;
    if (v instanceof Date) {
      if (isNaN(v.getTime())) return undefined;
      return v.toISOString().split('T')[0];
    }
    const s = String(v);
    if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
    const d = new Date(s);
    if (isNaN(d.getTime())) return undefined;
    return d.toISOString().split('T')[0];
  }

  return {
    driverName: row.driver_name || '',
    email: row.driver_email || row.client_email || '',
    phoneCountry: row.driver_phone_country || '',
    phoneNumber: row.driver_phone || '',
    dateOfBirth: toISODate(row.driver_dob),
    homeAddress,
    licenceAddress: row.driver_licence_address || undefined,
    licenceNumber: row.driver_licence_number || '',
    licenceIssuedBy: row.driver_licence_issued_by || '',
    licenceValidTo: toISODate(row.driver_licence_valid_to),
    datePassedTest: toISODate(row.driver_date_passed_test),
    vehicleReg: row.vehicle_reg || '',
    vehicleModel: row.vehicle_model || '',
    vehicleMakeModel: composeMakeModel(row.vehicle_make, row.vehicle_make_model) || undefined,
    hireStartDate: toISODate(row.resolved_hire_start),
    hireStartTime: row.resolved_start_time ? String(row.resolved_start_time) : undefined,
    hireEndDate: toISODate(row.resolved_hire_end),
    hireEndTime: row.resolved_end_time ? String(row.resolved_end_time) : undefined,
    insuranceExcess: excessStr || undefined,
    hireFormNumber: `OT-HF-${assignmentId.substring(0, 8).toUpperCase()}`,
    contractNumber: row.hirehop_job_id ? String(row.hirehop_job_id) : '',
    signatureDate: toISODate(row.driver_signature_date),
    hhJobNumber: row.resolved_hh_job_number ? String(row.resolved_hh_job_number) : '',
    signatureImage,
    logoImage,
  };
}

// ── POST /api/hire-forms/:id/generate-pdf — Generate hire form PDF ──

/**
 * Auth: staff JWT, hire-form API key, OR freelancer book-out session.
 * Tries the API key path first (so the existing Netlify hire-form app
 * keeps working), then falls back to the flexible JWT auth which handles
 * both staff and freelancer JWTs.
 */
function authenticatePdfRoute(req: FlexibleVehicleRequest & AuthRequest, res: Response, next: NextFunction): void {
  const apiKey = req.headers['x-api-key'] as string | undefined;
  if (apiKey && process.env.HIRE_FORM_API_KEY) {
    try {
      const expected = Buffer.from(process.env.HIRE_FORM_API_KEY);
      const provided = Buffer.from(apiKey);
      if (expected.length === provided.length && crypto.timingSafeEqual(expected, provided)) {
        req.user = { id: '00000000-0000-0000-0000-000000000000', email: 'hire-form@system', role: 'admin' };
        next();
        return;
      }
    } catch {
      // Fall through.
    }
  }
  authenticateVehicleFlexible(req, res, next);
}

router.post('/:id/generate-pdf', authenticatePdfRoute, async (req: FlexibleVehicleRequest & AuthRequest, res: Response) => {
  try {
    const id = req.params.id as string;
    const sendEmailRequested = req.query.send_email === 'true';

    // Freelancer scope: caller can only generate a PDF for a hire form on
    // their own job. Same rule as PATCH/by-job — scope.jobId or
    // scope.hhJobNumber must match the hire form row.
    if (isFreelancerBookout(req)) {
      const scope = await getBookoutScope(req);
      if (!scope) {
        return res.status(403).json({ error: 'Assignment not found' });
      }
      const targetRow = await query(
        `SELECT job_id, hirehop_job_id FROM vehicle_hire_assignments WHERE id = $1`,
        [id]
      );
      if (targetRow.rows.length === 0) {
        return res.status(404).json({ error: 'Hire form not found' });
      }
      const target = targetRow.rows[0];
      const onSameJob =
        (scope.jobId && target.job_id === scope.jobId) ||
        (scope.hhJobNumber && target.hirehop_job_id === scope.hhJobNumber);
      if (!onSameJob) {
        return res.status(403).json({ error: 'Hire form is not on your job' });
      }
    }

    // Load all data
    const formData = await loadHireFormData(id);
    if (!formData) {
      return res.status(404).json({ error: 'Hire form not found' });
    }

    // Gate: the hire agreement PDF is only meaningful once a vehicle has
    // been assigned. Without a vehicle reg, the PDF would say "TBC", which
    // is neither a valid record nor appropriate to send to the driver.
    // The hire form app calls this endpoint at signature time as part of
    // its A→B→C chain — in that case we silently no-op and let the
    // definitive generation happen at book-out (or via ad-hoc staff action
    // after a vehicle is linked).
    const hasVehicle = !!formData.vehicleReg && formData.vehicleReg !== 'TBC';
    if (!hasVehicle) {
      console.log(`[hire-forms] PDF generation skipped for ${id}: no vehicle assigned yet`);
      return res.json({
        data: {
          pdf_key: null,
          filename: null,
          size: 0,
          email_sent: false,
          skipped: true,
          reason: 'no_vehicle_assigned',
        },
      });
    }

    const sendEmail = sendEmailRequested;

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

    // Send email if requested. Recipient resolution mirrors the auto-fire
    // path in generateAndEmailHireFormPdf above: driver email → job
    // client contacts → info@ + amber banner + timeline log.
    let emailResult = null;
    if (sendEmail) {
      const target = await resolveHireFormEmailTarget(id, formData.email);
      if (target.kind !== 'none') {
        emailResult = await emailService.send('hire_form', {
          to: target.to,
          cc: target.cc.length > 0 ? target.cc : undefined,
          prependBanner: target.kind === 'fallback' ? target.banner : undefined,
          variables: {
            driverName: formData.driverName,
            vehicleReg: formData.vehicleReg || 'TBC',
            vehicleModel: formData.vehicleModel || 'TBC',
            hireStart: fmtDate(formData.hireStartDate),
            hireEnd: fmtDate(formData.hireEndDate),
            jobNumber: formData.hhJobNumber || '',
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
          console.log(`[hire-forms] Email sent for ${id} to ${target.to}${target.kind === 'fallback' ? ' (fallback to info@)' : ''}`);
          if (target.kind === 'fallback' && target.jobId) {
            await logFallbackToTimeline({ jobId: target.jobId, templateId: 'hire_form' });
          }
        }
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

    // Get assignment with PDF key. Same hire_start/end fallback to parent
    // job as loadHireFormData — keeps the email body consistent regardless
    // of which endpoint generated the PDF.
    const assignment = await query(
      `SELECT vha.*,
        COALESCE(vha.hire_start, j.job_date) AS resolved_hire_start,
        COALESCE(vha.hire_end, j.job_end) AS resolved_hire_end,
        COALESCE(j.hh_job_number, vha.hirehop_job_id) AS resolved_hh_job_number,
        d.full_name AS driver_name, d.email AS driver_email,
        fv.reg AS vehicle_reg, fv.vehicle_type AS vehicle_model
      FROM vehicle_hire_assignments vha
      LEFT JOIN drivers d ON d.id = vha.driver_id
      LEFT JOIN fleet_vehicles fv ON fv.id = vha.vehicle_id
      LEFT JOIN jobs j ON j.id = vha.job_id
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
        hireStart: fmtDate(row.resolved_hire_start),
        hireEnd: fmtDate(row.resolved_hire_end),
        jobNumber: row.resolved_hh_job_number ? String(row.resolved_hh_job_number) : '',
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

// ── Referral notification helper ──

async function sendReferralNotification(
  driverId: string,
  driverName: string,
  driverEmail: string,
  referralReason: string,
  hirehopJobId: number | null,
): Promise<void> {
  try {
    // Build referral reasons list from driver data
    const driverResult = await query(
      `SELECT d.*,
        COALESCE(
          (SELECT string_agg(CONCAT('#', vha.hirehop_job_id, ' ', vha.hirehop_job_name), ', ')
           FROM vehicle_hire_assignments vha
           WHERE vha.driver_id = d.id AND vha.status IN ('soft', 'confirmed', 'booked_out', 'active')),
          'No active hires'
        ) AS linked_jobs
      FROM drivers d WHERE d.id = $1`,
      [driverId]
    );

    if (driverResult.rows.length === 0) return;
    const driver = decryptDriverRow(driverResult.rows[0]);

    // Build human-readable reasons
    const reasons: string[] = [];
    if (referralReason) reasons.push(referralReason);
    if (driver.has_disability) reasons.push('Declared disability/medical condition');
    if (driver.has_convictions) reasons.push('Declared motoring convictions');
    if (driver.has_prosecution) reasons.push('Declared pending prosecution');
    if (driver.has_accidents) reasons.push('Declared previous accidents');
    if (driver.has_insurance_issues) reasons.push('Declared insurance issues');
    if (driver.has_driving_ban) reasons.push('Declared previous driving ban');
    if (driver.licence_points >= 9) reasons.push(`${driver.licence_points} penalty points on licence`);
    if (driver.licence_issue_country && !['GB', 'UK', 'DVLA'].includes(driver.licence_issue_country.toUpperCase())) {
      reasons.push(`Non-standard licence country: ${driver.licence_issue_country}`);
    }
    if (reasons.length === 0) reasons.push('Flagged by hire form verification process');

    const frontendUrl = getFrontendUrl();

    // Try to generate snapshot PDF for attachment
    let attachments: Array<{ filename: string; content: Buffer; contentType: string }> | undefined;
    try {
      const { generateDriverSnapshot, loadDriverDocuments } = await import('../services/driver-snapshot-pdf');
      const { fetchLogo } = await import('../services/hire-form-pdf');

      const documents = await loadDriverDocuments(driver.files || []);
      let logoImage: Buffer | null = null;
      try { logoImage = await fetchLogo(); } catch { /* skip */ }

      const isUk = (driver.licence_issue_country || '').toUpperCase() === 'GB' ||
        (driver.licence_issued_by || '').toUpperCase().includes('DVLA');

      const snapshotData = {
        driverName: driver.full_name || driverName,
        email: driver.email || driverEmail,
        phone: driver.phone ? `${driver.phone_country || ''} ${driver.phone}` : '',
        dateOfBirth: driver.date_of_birth || '',
        nationality: driver.nationality || '',
        homeAddress: driver.address_full || [driver.address_line1, driver.address_line2, driver.city, driver.postcode].filter(Boolean).join(', '),
        licenceAddress: driver.licence_address || '',
        licenceNumber: driver.licence_number || '',
        licenceIssuedBy: driver.licence_issued_by || driver.licence_issue_country || '',
        licenceValidTo: driver.licence_valid_to || '',
        datePassedTest: driver.date_passed_test || '',
        dvlaPoints: String(driver.licence_points || 0),
        dvlaEndorsements: Array.isArray(driver.licence_endorsements)
          ? driver.licence_endorsements.map((e: any) => e.code).join(', ') || 'None'
          : 'None',
        calculatedExcess: '',
        isUkDriver: isUk,
        hasDisability: driver.has_disability || false,
        hasConvictions: driver.has_convictions || false,
        hasProsecution: driver.has_prosecution || false,
        hasAccidents: driver.has_accidents || false,
        hasInsuranceIssues: driver.has_insurance_issues || false,
        hasDrivingBan: driver.has_driving_ban || false,
        additionalDetails: driver.additional_details || '',
        jobId: hirehopJobId ? String(hirehopJobId) : 'N/A',
        documents,
        logoImage,
      };

      const { pdfBytes, filename } = await generateDriverSnapshot(snapshotData);
      attachments = [{ filename, content: Buffer.from(pdfBytes), contentType: 'application/pdf' }];
      console.log(`[hire-forms] Snapshot PDF generated for referral email: ${filename}`);
    } catch (snapshotErr) {
      console.warn('[hire-forms] Could not generate snapshot PDF for referral email:', (snapshotErr as Error).message);
    }

    const { getVehicleNotificationTargets } = await import('../services/vehicle-notify');
    const vehicleTargets = await getVehicleNotificationTargets();
    await emailService.send('referral_alert', {
      to: vehicleTargets.to,
      cc: vehicleTargets.cc,
      variables: {
        driverName: driverName || 'Unknown',
        driverEmail: driverEmail || 'N/A',
        jobNumber: hirehopJobId ? String(hirehopJobId) : 'N/A',
        referralReasons: reasons.map(r => `• ${r}`).join('<br/>'),
        linkedJobs: driver.linked_jobs || 'No active hires',
        driverUrl: `${frontendUrl}/drivers/${driverId}`,
      },
      attachments,
    });

    console.log(`[hire-forms] Referral notification sent for driver ${driverName}`);
  } catch (err) {
    console.error('[hire-forms] Failed to send referral notification:', err);
  }
}

// ─── POST-SIGNATURE AUTOMATIONS ─────────────────────────────────────────────
// Called by hire form app after successful signature + assignment creation.
// Handles: additional driver charges in HireHop + mid-tour detection.
router.post('/:id/post-signature', authenticateOrApiKey, async (req: AuthRequest, res: Response) => {
  const { id } = req.params;
  const results: Record<string, unknown> = {};

  try {
    // 1. Load the assignment
    const assignmentResult = await query(
      `SELECT a.*, fv.reg AS vehicle_reg, d.full_name AS driver_name, d.email AS driver_email
       FROM vehicle_hire_assignments a
       LEFT JOIN fleet_vehicles fv ON fv.id = a.vehicle_id
       LEFT JOIN drivers d ON d.id = a.driver_id
       WHERE a.id = $1`,
      [id]
    );
    if (assignmentResult.rows.length === 0) {
      return res.status(404).json({ error: 'Assignment not found' });
    }
    const assignment = assignmentResult.rows[0];
    const hhJobId = assignment.hirehop_job_id;

    // 2. Additional driver charge check
    if (hhJobId) {
      try {
        const chargeResult = await processAdditionalDriverCharge(hhJobId, assignment.job_id);
        results.additionalDriverCharge = chargeResult;
        console.log(`[post-signature] Additional driver charge result for HH job ${hhJobId}:`, chargeResult);
      } catch (err) {
        console.warn('[post-signature] Additional driver charge failed (non-blocking):', (err as Error).message);
        results.additionalDriverCharge = { error: (err as Error).message };
      }
    }

    // 3. Mid-tour detection — is the job already dispatched?
    if (hhJobId) {
      try {
        const { isHireHopConfigured } = await import('../config/hirehop');
        if (isHireHopConfigured()) {
          const { default: hhBroker } = await import('../services/hirehop-broker');
          const jobData = await hhBroker.get<{ STATUS: string }>('/api/job_data.php', { job: hhJobId }, { priority: 'high', cacheTTL: 60 });
          const hhStatus = parseFloat(String(jobData.data?.STATUS || '0'));
          const isDispatched = [5, 6].includes(hhStatus);

          if (isDispatched) {
            console.log(`[post-signature] MID-TOUR DETECTED — HH job ${hhJobId} status ${hhStatus}`);

            // Set hire_start to NOW (driver shouldn't have been driving before form submission)
            await query(
              `UPDATE vehicle_hire_assignments SET hire_start = NOW() WHERE id = $1 AND hire_start IS NULL`,
              [id]
            );

            // Send notification to team
            const frontendUrl = getFrontendUrl();
            try {
              const { getVehicleNotificationTargets } = await import('../services/vehicle-notify');
              const targets = await getVehicleNotificationTargets();

              // Bell notification to vehicle manager only (no fan-out to all admins).
              // email_sent_at = NOW() so the escalation scheduler doesn't fire a
              // duplicate email — the direct mid_tour_driver send below covers it.
              for (const userId of targets.bellUserIds) {
                await query(
                  `INSERT INTO notifications (user_id, type, title, content, entity_type, entity_id, priority, action_url, email_sent_at)
                   VALUES ($1, 'hire_form', $2, $3, 'vehicle_hire_assignments', $4, 'high', $5, NOW())`,
                  [
                    userId,
                    `Mid-tour driver — ${assignment.driver_name || 'Unknown'}`,
                    `${assignment.driver_name || 'A driver'} submitted a hire form for job #${hhJobId} (${assignment.hirehop_job_name || ''}) which is already dispatched. Hire form assigned to ${assignment.vehicle_reg || 'unassigned vehicle'}.`,
                    id,
                    assignment.job_id ? `/jobs/${assignment.job_id}` : null,
                  ]
                );
              }

              // Email notification — info@ + will@ CC
              await emailService.send('mid_tour_driver', {
                to: targets.to,
                cc: targets.cc,
                variables: {
                  driverName: assignment.driver_name || 'Unknown Driver',
                  driverEmail: assignment.driver_email || 'N/A',
                  vehicleReg: assignment.vehicle_reg || 'Not assigned',
                  jobNumber: String(hhJobId),
                  jobName: assignment.hirehop_job_name || '',
                  jobUrl: `${frontendUrl}/jobs/${assignment.job_id || ''}`,
                },
              });
            } catch (notifyErr) {
              console.warn('[post-signature] Mid-tour notification failed:', (notifyErr as Error).message);
            }

            results.midTour = { detected: true, hhStatus, notified: true };
          } else {
            results.midTour = { detected: false, hhStatus };
          }
        }
      } catch (err) {
        console.warn('[post-signature] Mid-tour check failed (non-blocking):', (err as Error).message);
        results.midTour = { error: (err as Error).message };
      }
    }

    res.json({ success: true, assignmentId: id, results });
  } catch (error) {
    console.error('[post-signature] Error:', error);
    res.status(500).json({ error: 'Post-signature processing failed' });
  }
});

/**
 * Count drivers for a job and add additional driver charges to HireHop if needed.
 * 2 drivers per vehicle are free; each additional = item 1324, £20+VAT.
 */
async function processAdditionalDriverCharge(hhJobId: number, jobId: string | null) {
  const ADDITIONAL_DRIVER_ITEM_ID = 1324;
  const VEHICLE_CATEGORY_ID = 370;
  const DRIVERS_PER_VEHICLE = 2;

  // Count drivers from our assignments table
  let driverCount = 0;
  if (jobId) {
    const driverResult = await query(
      `SELECT COUNT(DISTINCT driver_id) AS cnt FROM vehicle_hire_assignments
       WHERE job_id = $1 AND status NOT IN ('cancelled', 'swapped')`,
      [jobId]
    );
    driverCount = parseInt(driverResult.rows[0]?.cnt || '0');
  } else {
    const driverResult = await query(
      `SELECT COUNT(DISTINCT driver_id) AS cnt FROM vehicle_hire_assignments
       WHERE hirehop_job_id = $1 AND status NOT IN ('cancelled', 'swapped')`,
      [hhJobId]
    );
    driverCount = parseInt(driverResult.rows[0]?.cnt || '0');
  }

  if (driverCount === 0) {
    return { driverCount: 0, chargesAdded: 0, message: 'No drivers found' };
  }

  // Get job items from HireHop to count vehicles + existing charges
  const { isHireHopConfigured } = await import('../config/hirehop');
  if (!isHireHopConfigured()) {
    return { driverCount, chargesAdded: 0, message: 'HireHop not configured' };
  }

  const { default: hhBroker } = await import('../services/hirehop-broker');
  const { getHireHopConfig } = await import('../config/hirehop');
  const config = getHireHopConfig();

  // Fetch job items. The broker wraps responses in { success, data, error },
  // so `itemsResponse` is never a raw array — checking Array.isArray(itemsResponse)
  // was always false, `items` stayed empty, `vehicleCount` was always 0, and
  // every hire form submission added another charge regardless of van count
  // (observed on Desmond Magee's single-driver job, 22 Apr 2026). Unwrap the
  // data envelope and handle both plain-array and { items: [] } / { rows: [] }
  // shapes that different HH endpoints return, same pattern as quotes.ts
  // findOrCreateHeader.
  const itemsResponse = await hhBroker.get<unknown>(
    '/frames/items_to_supply_list.php',
    { job: hhJobId },
    { priority: 'high', cacheTTL: 30 }
  );

  const rawItems: unknown = itemsResponse?.data;
  const items: unknown[] = Array.isArray(rawItems)
    ? rawItems
    : ((rawItems as { items?: unknown[]; rows?: unknown[] } | undefined)?.items
       || (rawItems as { items?: unknown[]; rows?: unknown[] } | undefined)?.rows
       || []);
  console.log(`[processAdditionalDriverCharge] HH job ${hhJobId}: broker success=${itemsResponse?.success}, items resolved=${items.length}`);
  let vehicleCount = 0;
  let existingCharges = 0;

  for (const item of items as Record<string, unknown>[]) {
    const categoryId = parseInt(String(item.CATEGORY_ID || 0));
    // LIST_ID is the stock item ID (stable, shared across lines pointing at
    // the same stock entry). ITEM_ID is the per-LINE row ID (unique per
    // line, big number) — using it here would never match
    // ADDITIONAL_DRIVER_ITEM_ID = 1324, so existingCharges would stay at 0
    // and every submission would add another line. That's the bug we hit
    // on 22 Apr 2026 where 3 hire-form submissions produced 3 line items.
    const stockId = parseInt(String(item.LIST_ID || item.ITEM_ID || item.ID || 0));
    const qty = parseFloat(String(item.qty || item.QTY || item.quantity || item.QUANTITY || 1));
    const isVirtual = item.VIRTUAL === '1';

    if (categoryId === VEHICLE_CATEGORY_ID && !isVirtual) {
      vehicleCount += qty;
    }
    if (stockId === ADDITIONAL_DRIVER_ITEM_ID) {
      existingCharges += qty;
    }
  }

  // Sequential-swap override: if staff have declared the real simultaneous
  // van count (HH lists qty-2 but it's one van swapped mid-hire), use that for
  // the free-driver allowance (2 free per real van) instead of the raw HH qty.
  // Otherwise an undercharge: a 1-van swap with 3 drivers would read 4 free
  // (2 vans x 2) and bill nobody, when 1 should be chargeable. Same column the
  // derivation reads for excess; capped so the override can only REDUCE.
  const overrideRow = jobId
    ? await query(`SELECT self_drive_van_override FROM jobs WHERE id = $1`, [jobId])
    : await query(`SELECT self_drive_van_override FROM jobs WHERE hh_job_number = $1`, [hhJobId]);
  const vanOverride = overrideRow.rows[0]?.self_drive_van_override;
  const effectiveVanCount = (vanOverride !== null && vanOverride !== undefined)
    ? Math.min(Number(vanOverride), vehicleCount)
    : vehicleCount;

  const freeDrivers = effectiveVanCount * DRIVERS_PER_VEHICLE;
  const chargeableDrivers = Math.max(0, driverCount - freeDrivers);
  const newChargesNeeded = Math.max(0, chargeableDrivers - existingCharges);
  console.log(`[processAdditionalDriverCharge] HH job ${hhJobId}: drivers=${driverCount}, vehicles=${vehicleCount}, effectiveVans=${effectiveVanCount}, free=${freeDrivers}, chargeable=${chargeableDrivers}, existing=${existingCharges}, new=${newChargesNeeded}`);

  if (newChargesNeeded <= 0) {
    return { driverCount, vehicleCount, freeDrivers, existingCharges, chargesAdded: 0, message: 'No additional charges needed' };
  }

  // Check job status (don't add to locked/closed jobs)
  const jobResp = await hhBroker.get<Record<string, unknown>>('/api/job_data.php', { job: hhJobId }, { priority: 'high', cacheTTL: 30 });
  const jd = jobResp.data || {};
  const locked = jd.LOCKED === 1;
  const hhStatus = parseFloat(String(jd.STATUS || 0));
  const isClosed = [7, 9, 10, 11].includes(hhStatus);

  if (locked || isClosed) {
    return {
      driverCount, vehicleCount, chargesAdded: 0, newChargesNeeded,
      message: `Job is ${locked ? 'locked' : 'closed'} — ${newChargesNeeded} charge(s) needed manually`,
      manualActionRequired: true,
    };
  }

  // Add the charges via save_job.php
  const itemKey = `b${ADDITIONAL_DRIVER_ITEM_ID}`;
  await hhBroker.post('/api/save_job.php', {
    job: hhJobId,
    items: JSON.stringify({ [itemKey]: newChargesNeeded }),
    no_webhook: 1,
  }, { priority: 'high' });

  // Add a note to the HireHop job
  await hhBroker.get('/api/job_note.php', {
    job: hhJobId,
    note: `Additional driver charge(s) added automatically. Drivers: ${driverCount}, Vehicles: ${vehicleCount}, Charges added: ${newChargesNeeded} × £20+VAT. (${new Date().toLocaleDateString('en-GB')})`,
  }, { priority: 'low' });

  return { driverCount, vehicleCount, freeDrivers, existingCharges, chargesAdded: newChargesNeeded };
}

// ── Hire Form Email Sending ──────────────────────────────────────────────

/**
 * GET /api/hire-forms/email-contacts/:jobId — get available contacts for a job
 * Returns client org contacts + linked people with emails, for the contact picker.
 */
router.get('/email-contacts/:jobId', authenticate, async (req: AuthRequest, res: Response) => {
  try {
    const jobId = req.params.jobId as string;

    const jobResult = await query(
      `SELECT id, hh_job_number, client_name, company_name, job_date, job_name
       FROM jobs WHERE id = $1 AND is_deleted = false`,
      [jobId]
    );

    if (jobResult.rows.length === 0) {
      res.status(404).json({ error: 'Job not found' });
      return;
    }

    const job = jobResult.rows[0];
    // Use shared resolver — same source of truth as the auto-email scheduler
    const contacts = await resolveHireFormContacts(jobId);

    res.json({
      contacts,
      job: {
        id: job.id,
        hh_job_number: job.hh_job_number,
        job_name: job.job_name,
        job_date: job.job_date,
        client_name: job.company_name || job.client_name,
      },
    });
  } catch (error) {
    console.error('Hire form email contacts error:', error);
    res.status(500).json({ error: 'Failed to load contacts' });
  }
});

/**
 * POST /api/hire-forms/send-email — send hire form email to selected contacts
 */
const sendHireFormEmailSchema = z.object({
  jobId: z.string().uuid(),
  recipients: z.array(z.object({
    email: z.string().email(),
    name: z.string(),
  })).min(1),
  isChase: z.boolean().optional().default(false),
});

router.post('/send-email', authenticate, validate(sendHireFormEmailSchema), async (req: AuthRequest, res: Response) => {
  try {
    const { jobId, recipients, isChase } = req.body;

    // Get job details
    const jobResult = await query(
      `SELECT id, hh_job_number, job_name, job_date, company_name, client_name
       FROM jobs WHERE id = $1 AND is_deleted = false`,
      [jobId]
    );

    if (jobResult.rows.length === 0) {
      res.status(404).json({ error: 'Job not found' });
      return;
    }

    const job = jobResult.rows[0];

    if (!job.hh_job_number) {
      res.status(400).json({ error: 'Job has no HireHop number — cannot construct hire form URL' });
      return;
    }

    const hireFormUrl = `https://hireforms.oooshtours.co.uk/?job=${job.hh_job_number}`;
    const jobDate = job.job_date ? new Date(job.job_date) : null;
    const startDay = jobDate ? jobDate.toLocaleDateString('en-GB', { weekday: 'long' }) : '';
    const startDate = jobDate ? jobDate.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' }) : '';
    const templateId = isChase ? 'hire_form_chase' : 'hire_form_request';

    const emailService = (await import('../services/email-service')).default;
    const results: Array<{ email: string; success: boolean; error?: string }> = [];

    for (const recipient of recipients) {
      try {
        const result = await emailService.send(templateId, {
          to: recipient.email,
          variables: {
            clientName: recipient.name || 'there',
            jobNumber: String(job.hh_job_number),
            jobName: job.job_name || '',
            startDay,
            startDate,
            hireFormUrl,
          },
        });
        results.push({ email: recipient.email, success: result.success, error: result.error });
      } catch (err) {
        results.push({ email: recipient.email, success: false, error: err instanceof Error ? err.message : 'Send failed' });
      }
    }

    // Update the hire_forms requirement status + record when last sent
    const sentEmails = results.filter(r => r.success).map(r => r.email).join(', ');
    if (sentEmails) {
      await query(
        `UPDATE job_requirements SET
           notes = COALESCE(notes, '') || E'\n' || $1,
           status = CASE WHEN status = 'not_started' THEN 'in_progress' ELSE status END,
           current_step = CASE WHEN status = 'not_started' THEN 'Sent' ELSE current_step END,
           updated_at = NOW()
         WHERE job_id = $2 AND requirement_type = 'hire_forms'`,
        [
          `Hire form ${isChase ? 'reminder' : 'email'} sent to ${sentEmails} on ${new Date().toLocaleDateString('en-GB')}`,
          jobId,
        ]
      );
    }

    const sent = results.filter(r => r.success).length;
    const failed = results.filter(r => !r.success).length;

    // Log to activity timeline
    if (sent > 0) {
      const recipientList = results.filter(r => r.success).map(r => r.email).join(', ');
      await query(
        `INSERT INTO interactions (type, content, job_id, created_by)
         VALUES ('email', $1, $2, $3)`,
        [
          `Hire form ${isChase ? 'reminder' : 'link'} sent to ${recipientList}`,
          jobId,
          req.user!.id,
        ]
      );
    }

    res.json({ success: true, sent, failed, results });
  } catch (error) {
    console.error('Send hire form email error:', error);
    res.status(500).json({ error: 'Failed to send emails' });
  }
});

export default router;
