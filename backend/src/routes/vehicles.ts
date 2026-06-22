/**
 * Vehicle Module Routes
 *
 * Native OP backend routes for fleet management and job data,
 * plus a catch-all proxy to Netlify for remaining VM functions.
 *
 * Route priority (top-to-bottom):
 *   1. /api/vehicles/fleet/*     — Fleet CRUD (reads from fleet_vehicles table)
 *   2. /api/vehicles/jobs/*      — Job data for VM (reads from OP jobs table, returns HireHopJob format)
 *   3. /api/vehicles/hirehop/*   — HireHop proxy (barcode checkout/checkin, status updates)
 *   4. /api/vehicles/:fn         — Netlify proxy catch-all (for remaining VM functions)
 */
import { Router, Request, Response } from 'express';
import multer from 'multer';
import path from 'path';
import { v4 as uuid } from 'uuid';
import { authenticate, AuthRequest } from '../middleware/auth';
import {
  verifyFreelancerBookoutToken,
  mintFreelancerBookoutSession,
  authenticateVehicleFlexible,
  isFreelancerBookout,
  getBookoutScope,
  type FlexibleVehicleRequest,
} from '../middleware/freelancer-bookout-auth';
import { query, getPool } from '../config/database';
import { isHireHopConfigured } from '../config/hirehop';
import { hhBroker } from '../services/hirehop-broker';
import { getFromR2, uploadToR2, deleteFromR2, listR2Objects, isR2Configured, uploadToPublicR2, getFromPublicR2, listPublicR2Objects } from '../config/r2';
import { emailService } from '../services/email-service';
import { fetchLogo } from '../services/hire-form-pdf';
import {
  resolveClientEmailTarget,
  buildFallbackBanner,
  logFallbackToTimeline,
} from '../services/money-emails';
import {
  buildConditionReportSubject,
  buildConditionReportEmailHtml,
  type ConditionReportEmailParams,
} from '../services/condition-report-email';
import { getSystemSetting } from './system-settings';

const router = Router();

// Default low-tread alert threshold (mm). Staff-tweakable via the
// `tyre_tread_amber_threshold` system_settings key. Keep in step with the
// frontend TYRE_TREAD_AMBER_MM constant in lib/tyre-sanity.ts.
const DEFAULT_TYRE_TREAD_AMBER_MM = 5;

// ── Public: Freelancer book-out token redemption ────────────────────
//
// The portal deep-links freelancers here with an HMAC token. This
// endpoint validates the token, checks the freelancer is assigned to
// the quote, resolves (or creates) the vehicle_hire_assignment that
// represents their allocated van, and mints a narrow-scoped session
// JWT they can use for the subsequent book-out event submissions.
//
// Mounted BEFORE `router.use(authenticate)` — the HMAC token is the
// authentication here; staff JWT is not required (and indeed not
// available on the freelancer's browser in this flow).
router.post('/freelancer-bookout/resolve', async (req: Request, res: Response) => {
  try {
    const token = (req.body?.token || req.query?.token) as string | undefined;
    if (!token) {
      console.warn('[freelancer-bookout] Resolve called with no token');
      res.status(400).json({ error: 'Missing token' });
      return;
    }

    console.log('[freelancer-bookout] Resolve attempt', {
      tokenLength: token.length,
      tokenPreview: `${token.slice(0, 20)}...${token.slice(-8)}`,
    });

    const verified = verifyFreelancerBookoutToken(token);
    if (!verified) {
      // Detailed reason already logged inside verifyFreelancerBookoutToken.
      res.status(401).json({ error: 'Invalid or expired token' });
      return;
    }
    const { quoteId, freelancerEmail } = verified;
    console.log('[freelancer-bookout] Token verified', { quoteId, freelancerEmail });

    // Check the freelancer is actually assigned to this quote.
    const personResult = await query(
      `SELECT id, first_name, last_name FROM people WHERE LOWER(email) = LOWER($1) LIMIT 1`,
      [freelancerEmail]
    );
    if (personResult.rows.length === 0) {
      res.status(403).json({ error: 'Freelancer not recognised' });
      return;
    }
    const person = personResult.rows[0];

    const assignmentCheck = await query(
      `SELECT qa.id AS quote_assignment_id, q.job_id, q.job_type, q.venue_name, j.hh_job_number
         FROM quote_assignments qa
         JOIN quotes q ON q.id = qa.quote_id
         LEFT JOIN jobs j ON j.id = q.job_id
         WHERE qa.quote_id = $1
           AND qa.person_id = $2
           AND q.is_deleted = false
         LIMIT 1`,
      [quoteId, person.id]
    );
    if (assignmentCheck.rows.length === 0) {
      res.status(403).json({ error: 'You are not assigned to this job' });
      return;
    }
    const { job_id: jobId, hh_job_number: hhJobNumber, venue_name: venueName } = assignmentCheck.rows[0];

    // Find the vehicle_hire_assignment for this job. The trust chain for a
    // freelancer doing a delivery is: their row on quote_assignments
    // (verified above) → job → vehicle_hire_assignment.
    //
    // Important: we do NOT require the freelancer to be the registered
    // driver of the assignment. The common D&C pattern is:
    //   - Self-drive client gets allocated a van (assignment_type='self_drive',
    //     driver_id = the client driver record, status often 'confirmed')
    //   - Ooosh runs a delivery quote on the same job
    //   - A separate freelancer is on quote_assignments to physically deliver
    // The freelancer is authorised via the quote, not the driver record.
    //
    // Status filter accepts every "currently allocated, not yet returned"
    // value: 'soft' (tentative), 'confirmed' (firm allocation), 'active'
    // (legacy mid-hire), 'booked_out' (resume case). The DB CHECK constraint
    // (migration 017) only allows soft|confirmed|booked_out|active|returned|
    // cancelled — there is no 'allocated' value.
    //
    // Job match falls back to hirehop_job_id because some allocation paths
    // populate only the HH job number, not the OP UUID.
    //
    // ──────────────────────────────────────────────────────────────────────
    // SMART RESOLVE — auto-merge dual-row D&C bookings
    //
    // Common scenario for D&C with self-drive client:
    //   Row A — staff allocation row from the Allocations page
    //           (vehicle_id set, driver_id NULL — represents "this van
    //            is going to this delivery").
    //   Row B — customer's hire-form row from POST /api/hire-forms
    //           (driver_id set, vehicle_id NULL — the customer who'll
    //            actually drive once it lands).
    //
    // These are the same logical hire and need to be merged before book-out
    // so we have ONE row carrying both vehicle + customer driver. Without
    // the merge: book-out only sees Row A (no customer name on the PDF),
    // hire-form PDF generation skips Row B (no vehicle reg), check-in flips
    // the wrong row, and we end up with the kind of stranded-customer-row
    // mess we hand-fixed for jobs 15378/15793/15819/15820.
    //
    // Merge rule (tight on purpose, idempotent):
    //   1. The freelancer's session would land on a row with `vehicle_id IS
    //      NOT NULL AND driver_id IS NULL` (Row A — pure allocation).
    //   2. There exists a separate row on the same job with `driver_id IS
    //      NOT NULL AND vehicle_id IS NULL`, status not cancelled (Row B —
    //      customer hire form).
    //   3. Merge: copy vehicle_id (and reg) onto Row B, cancel Row A with
    //      an audit note.
    //   4. Mint the freelancer's session against Row B (the merged row).
    //
    // Multi-van case: scoped out for now. If the job has multiple Row A
    // allocations or multiple Row B customer hire forms, the merge picks
    // one (most recent allocation × earliest customer by van_requirement_index)
    // and leaves any siblings untouched. Full N×M expansion is the "D&C
    // allocation linkage gap" — separate round.
    //
    // Idempotent: re-running the resolve after the merge finds Row B
    // directly (vehicle_id + driver_id both set) and returns it without
    // attempting a second merge.
    // ──────────────────────────────────────────────────────────────────────

    type VhaRow = {
      assignment_id: string;
      vehicle_id: string | null;
      driver_id: string | null;
      status: string;
      assignment_type: string;
      registration: string | null;
      make: string | null;
      model: string | null;
      vehicle_type: string | null;
      customer_driver_name: string | null;
      customer_driver_email: string | null;
    };

    async function fetchAllocatedVehicleRow(): Promise<VhaRow | null> {
      // Pull all currently-active rows on the job once and pick from them
      // in JS — we need to inspect the set as a whole to decide whether to
      // merge, and a single result row hides that.
      const result = await query(
        `SELECT vha.id AS assignment_id, vha.vehicle_id, vha.driver_id, vha.status,
                vha.assignment_type, vha.created_at, vha.van_requirement_index,
                fv.reg AS registration, fv.make, fv.model, fv.vehicle_type,
                d.full_name AS customer_driver_name, d.email AS customer_driver_email
           FROM vehicle_hire_assignments vha
           LEFT JOIN fleet_vehicles fv ON fv.id = vha.vehicle_id
           LEFT JOIN drivers d ON d.id = vha.driver_id
          WHERE vha.status IN ('soft', 'confirmed', 'active', 'booked_out')
            AND (vha.job_id = $1 OR vha.hirehop_job_id = $2)
          ORDER BY vha.created_at DESC`,
        [jobId, hhJobNumber]
      );
      const rows = result.rows as Array<VhaRow & { created_at: string; van_requirement_index: number | null }>;
      if (rows.length === 0) return null;

      // First preference: a row that already has BOTH vehicle and driver —
      // this is the post-merge steady state, or a job that was created the
      // tidy way from the start. Just use it.
      const merged = rows.find(r => r.vehicle_id && r.driver_id);
      if (merged) return merged;

      // Second preference: smart-merge candidate. Find the freelancer's
      // allocation row (vehicle, no driver) and the customer's hire-form
      // row (driver, no vehicle) and combine them.
      const allocationRow = rows.find(r => r.vehicle_id && !r.driver_id);
      const customerRow = rows
        .filter(r => r.driver_id && !r.vehicle_id)
        .sort((a, b) => {
          const ai = a.van_requirement_index ?? Number.POSITIVE_INFINITY;
          const bi = b.van_requirement_index ?? Number.POSITIVE_INFINITY;
          if (ai !== bi) return ai - bi;
          return new Date(a.created_at).getTime() - new Date(b.created_at).getTime();
        })[0];

      if (allocationRow && customerRow) {
        // Atomic merge: stamp vehicle onto customer row, cancel allocation
        // row. Run inside an explicit transaction so a partial failure
        // doesn't leave the data half-merged.
        const client = await getPool().connect();
        try {
          await client.query('BEGIN');
          await client.query(
            `UPDATE vehicle_hire_assignments
                SET vehicle_id = $1, updated_at = NOW()
              WHERE id = $2`,
            [allocationRow.vehicle_id, customerRow.assignment_id]
          );
          await client.query(
            `UPDATE vehicle_hire_assignments
                SET status = 'cancelled',
                    status_changed_at = NOW(),
                    updated_at = NOW(),
                    notes = COALESCE(notes, '') ||
                            CASE WHEN COALESCE(notes, '') = '' THEN '' ELSE E'\n' END ||
                            $1
              WHERE id = $2`,
            [
              `[Auto-merged] Vehicle ${allocationRow.registration || allocationRow.vehicle_id} ` +
                `transferred to customer hire-form row ${customerRow.assignment_id} ` +
                `on freelancer book-out resolve (${new Date().toISOString()})`,
              allocationRow.assignment_id,
            ]
          );
          await client.query('COMMIT');
        } catch (err) {
          await client.query('ROLLBACK');
          throw err;
        } finally {
          client.release();
        }

        console.log('[freelancer-bookout] Smart-merged allocation row into customer hire-form row', {
          allocationRowId: allocationRow.assignment_id,
          customerRowId: customerRow.assignment_id,
          vehicleId: allocationRow.vehicle_id,
          registration: allocationRow.registration,
        });

        // Re-read the merged customer row so the response carries the
        // freshly-stamped vehicle fields (reg, make, model, vehicle_type).
        const reread = await query(
          `SELECT vha.id AS assignment_id, vha.vehicle_id, vha.driver_id, vha.status,
                  vha.assignment_type,
                  fv.reg AS registration, fv.make, fv.model, fv.vehicle_type,
                  d.full_name AS customer_driver_name, d.email AS customer_driver_email
             FROM vehicle_hire_assignments vha
             LEFT JOIN fleet_vehicles fv ON fv.id = vha.vehicle_id
             LEFT JOIN drivers d ON d.id = vha.driver_id
            WHERE vha.id = $1
            LIMIT 1`,
          [customerRow.assignment_id]
        );
        return (reread.rows[0] as VhaRow) || null;
      }

      // Fallback: no merge possible. Hand back the most recent row with a
      // vehicle so book-out can still proceed (legacy behaviour). Common in
      // staff-test scenarios where there's no customer hire form yet.
      return rows.find(r => r.vehicle_id) || null;
    }

    const vha = await fetchAllocatedVehicleRow();
    if (!vha) {
      console.warn('[freelancer-bookout] No allocated vehicle for job', { jobId, hhJobNumber });
      res.status(409).json({
        error: 'No vehicle allocated for this job yet',
        code: 'no_allocation',
        hint: 'Staff needs to allocate a van on the OP Allocations page before you can book out.',
      });
      return;
    }
    console.log('[freelancer-bookout] Vehicle resolved', {
      assignmentId: vha.assignment_id,
      registration: vha.registration,
      status: vha.status,
      assignmentType: vha.assignment_type,
      hasCustomerDriver: !!vha.customer_driver_name,
    });

    const sessionToken = mintFreelancerBookoutSession({
      assignmentId: vha.assignment_id,
      quoteId,
      freelancerEmail,
      freelancerPersonId: person.id,
    });

    res.json({
      success: true,
      sessionToken,
      assignment: {
        id: vha.assignment_id,
        vehicleId: vha.vehicle_id,
        registration: vha.registration,
        makeModel: [vha.make, vha.model].filter(Boolean).join(' '),
        vehicleType: vha.vehicle_type || null,
        status: vha.status,
        // The customer (real driver on the hire agreement). May be null on
        // jobs that don't yet have a hire form submitted — caller should
        // surface a clear "ask the customer to fill in the hire form first"
        // message in that case.
        customerDriver: vha.customer_driver_name
          ? {
              name: vha.customer_driver_name,
              email: vha.customer_driver_email || null,
            }
          : null,
      },
      job: {
        id: jobId,
        hhJobNumber,
        venueName,
      },
      driver: {
        // The FREELANCER (delivery person). Distinct from assignment.customerDriver.
        name: `${person.first_name} ${person.last_name}`.trim(),
        email: freelancerEmail,
      },
    });
  } catch (err) {
    // Use the same [freelancer-bookout] tag as the verification logs so a
    // single grep finds everything. Include the stack so the next 500 we
    // hit is diagnosable from logs alone.
    console.error('[freelancer-bookout] Resolve crashed:', err instanceof Error ? err.stack || err.message : err);
    res.status(500).json({ error: 'Failed to resolve book-out token' });
  }
});

// Vehicle routes accept EITHER a staff JWT or a freelancer book-out
// session JWT. The flexible middleware populates req.user (staff) XOR
// req.bookoutSession (freelancer). A follow-up gate restricts freelancer
// sessions to the subset of endpoints they need for a D&C book-out;
// staff keep access to everything.
router.use(authenticateVehicleFlexible as unknown as typeof authenticate);

/**
 * Paths a freelancer-scoped session JWT is allowed to reach. Anything
 * else → 403. Each handler downstream still does its own scope-check to
 * make sure the freelancer is only touching THEIR assignment.
 *
 * Matching is done against `req.path` (no query string) and the HTTP
 * method, to avoid surprises from substring tricks.
 */
const FREELANCER_BOOKOUT_ALLOW: Array<{ method: string; pattern: RegExp }> = [
  { method: 'GET',   pattern: /^\/fleet$/ },
  { method: 'GET',   pattern: /^\/fleet\/[^/]+$/ },
  { method: 'PATCH', pattern: /^\/fleet\/by-reg\/[^/]+\/hire-status$/ },
  { method: 'POST',  pattern: /^\/upload-photo$/ },
  { method: 'POST',  pattern: /^\/save-event$/ },
  { method: 'POST',  pattern: /^\/generate-pdf$/ },
  { method: 'POST',  pattern: /^\/send-email$/ },
  { method: 'POST',  pattern: /^\/send-condition-report$/ },
  { method: 'GET',   pattern: /^\/jobs\/[^/]+$/ },
  // Walkaround / briefing UI: settings are global (no PII) so freelancer
  // sessions read the same payload as staff. The scope-check on get-events
  // (below) clamps the freelancer's events query to their own vehicle reg.
  { method: 'GET',   pattern: /^\/get-checklist-settings$/ },
  { method: 'GET',   pattern: /^\/get-events$/ },
];

router.use((req: FlexibleVehicleRequest, res: Response, next) => {
  if (!isFreelancerBookout(req)) {
    next();
    return;
  }
  const match = FREELANCER_BOOKOUT_ALLOW.some(
    rule => rule.method === req.method && rule.pattern.test(req.path)
  );
  if (!match) {
    res.status(403).json({ error: 'Not available to freelancer session' });
    return;
  }
  next();
});

// `getBookoutScope` lives in middleware/freelancer-bookout-auth.ts now —
// imported above. Shared between vehicles + hire-forms routes (the
// freelancer write-back path at book-out needs the same scope checks).

// ═══════════════════════════════════════════════════════════════════════════
// 1. FLEET CRUD — /api/vehicles/fleet/*
// ═══════════════════════════════════════════════════════════════════════════

/**
 * GET /api/vehicles/fleet
 * List all fleet vehicles. Supports filtering by fleet_group, hire_status, simple_type.
 * Returns data in the shape the VM's Vehicle interface expects.
 */
router.get('/fleet', async (req: FlexibleVehicleRequest, res: Response) => {
  try {
    // Freelancer scope: return only the vehicle assigned to this session.
    // Filters (group/hire_status/etc.) are ignored — staff-only concerns.
    if (isFreelancerBookout(req)) {
      const scope = await getBookoutScope(req);
      if (!scope) {
        res.status(404).json({ error: 'Assignment not found' });
        return;
      }
      const r = await query('SELECT * FROM fleet_vehicles WHERE id = $1', [scope.vehicleId]);
      res.json({ data: r.rows.map(row => mapDbRowToVehicle(row)) });
      return;
    }

    const { group, hire_status, simple_type, include_inactive } = req.query;

    let where = 'WHERE 1=1';
    const params: unknown[] = [];

    // By default exclude inactive (old/sold) unless explicitly requested
    if (include_inactive !== 'true') {
      where += ' AND is_active = true';
    }

    if (group && (group as string) !== 'all') {
      params.push(group);
      where += ` AND fleet_group = $${params.length}`;
    }

    if (hire_status) {
      params.push(hire_status);
      where += ` AND hire_status = $${params.length}`;
    }

    if (simple_type) {
      params.push(simple_type);
      where += ` AND simple_type = $${params.length}`;
    }

    const result = await query(
      `SELECT * FROM fleet_vehicles ${where} ORDER BY reg ASC`,
      params
    );

    // Map DB rows to the VM's Vehicle interface shape
    const includeFinance = canViewVehicleFinance(req.user?.role);
    const vehicles = result.rows.map(row => mapDbRowToVehicle(row, { includeFinance }));

    res.json({ data: vehicles });
  } catch (error) {
    console.error('[vehicles/fleet] List error:', error);
    res.status(500).json({ error: 'Failed to load fleet' });
  }
});

/**
 * GET /api/vehicles/fleet/:id
 * Get a single vehicle by ID or registration.
 */
router.get('/fleet/:idOrReg', async (req: FlexibleVehicleRequest, res: Response) => {
  try {
    const idOrReg = req.params.idOrReg as string;

    // Freelancer: only allow lookup of their own assigned vehicle.
    if (isFreelancerBookout(req)) {
      const scope = await getBookoutScope(req);
      if (!scope) {
        res.status(404).json({ error: 'Assignment not found' });
        return;
      }
      const asked = idOrReg.toUpperCase();
      if (asked !== scope.vehicleId.toUpperCase() && asked !== scope.registration) {
        res.status(403).json({ error: 'Not your vehicle' });
        return;
      }
    }

    // Try UUID first, then registration
    const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(idOrReg);
    const result = isUuid
      ? await query('SELECT * FROM fleet_vehicles WHERE id = $1', [idOrReg])
      : await query('SELECT * FROM fleet_vehicles WHERE reg = $1', [idOrReg.toUpperCase()]);

    if (result.rows.length === 0) {
      res.status(404).json({ error: 'Vehicle not found' });
      return;
    }

    res.json(mapDbRowToVehicle(result.rows[0], { includeFinance: canViewVehicleFinance(req.user?.role) }));
  } catch (error) {
    console.error('[vehicles/fleet] Detail error:', error);
    res.status(500).json({ error: 'Failed to load vehicle' });
  }
});

/**
 * POST /api/vehicles/fleet
 * Create a new vehicle.
 */
/**
 * Whitelist of accepted vehicle fields (request key → DB column). Shared by the
 * fleet create + update handlers so a field added once is editable AND settable
 * at creation. Accepts both snake_case and camelCase request keys.
 */
const FLEET_FIELD_MAP: Record<string, string> = {
  reg: 'reg', vehicle_type: 'vehicle_type', vehicleType: 'vehicle_type',
  simple_type: 'simple_type', simpleType: 'simple_type',
  gearbox: 'gearbox',
  make: 'make', model: 'model', colour: 'colour', seats: 'seats',
  damage_status: 'damage_status', damageStatus: 'damage_status',
  service_status: 'service_status', serviceStatus: 'service_status',
  hire_status: 'hire_status', hireStatus: 'hire_status',
  mot_due: 'mot_due', motDue: 'mot_due',
  tax_due: 'tax_due', taxDue: 'tax_due',
  tfl_due: 'tfl_due', tflDue: 'tfl_due',
  last_service_date: 'last_service_date', lastServiceDate: 'last_service_date',
  warranty_expires: 'warranty_expires', warrantyExpires: 'warranty_expires',
  last_service_mileage: 'last_service_mileage', lastServiceMileage: 'last_service_mileage',
  next_service_due: 'next_service_due', nextServiceDue: 'next_service_due',
  ulez_compliant: 'ulez_compliant', ulezCompliant: 'ulez_compliant',
  spare_key: 'spare_key', spareKey: 'spare_key',
  wifi_network: 'wifi_network', wifiNetwork: 'wifi_network',
  finance_with: 'finance_with', financeWith: 'finance_with',
  finance_ends: 'finance_ends', financeEnds: 'finance_ends',
  // Finance & lifecycle (migration 104) — admin-only (see FINANCE_FIELD_KEYS)
  finance_start: 'finance_start', financeStart: 'finance_start',
  finance_reference: 'finance_reference', financeReference: 'finance_reference',
  cash_price: 'cash_price', cashPrice: 'cash_price',
  deposit_paid: 'deposit_paid', depositPaid: 'deposit_paid',
  amount_financed: 'amount_financed', amountFinanced: 'amount_financed',
  monthly_payment: 'monthly_payment', monthlyPayment: 'monthly_payment',
  finance_term_months: 'finance_term_months', financeTermMonths: 'finance_term_months',
  finance_fees: 'finance_fees', financeFees: 'finance_fees',
  sold_date: 'sold_date', soldDate: 'sold_date',
  sale_price: 'sale_price', salePrice: 'sale_price',
  sale_notes: 'sale_notes', saleNotes: 'sale_notes',
  // Removal checklist (migration 104) — all-staff (JSONB, like setup_checklist)
  removal_checklist: 'removal_checklist', removalChecklist: 'removal_checklist',
  co2_per_km: 'co2_per_km', co2PerKm: 'co2_per_km',
  recommended_tyre_psi_front: 'recommended_tyre_psi_front', recommendedTyrePsiFront: 'recommended_tyre_psi_front',
  recommended_tyre_psi_rear: 'recommended_tyre_psi_rear', recommendedTyrePsiRear: 'recommended_tyre_psi_rear',
  fuel_type: 'fuel_type', fuelType: 'fuel_type',
  mpg: 'mpg', fleet_group: 'fleet_group', fleetGroup: 'fleet_group',
  is_active: 'is_active', isActive: 'is_active',
  monday_item_id: 'monday_item_id', mondayItemId: 'monday_item_id',
  notes: 'notes',
  // Setup checklist (migration 089)
  setup_checklist: 'setup_checklist', setupChecklist: 'setup_checklist',
  // Insurance
  insurance_due: 'insurance_due', insuranceDue: 'insurance_due',
  insurance_provider: 'insurance_provider', insuranceProvider: 'insurance_provider',
  insurance_policy_number: 'insurance_policy_number', insurancePolicyNumber: 'insurance_policy_number',
  // Booked-in dates
  mot_booked_in_date: 'mot_booked_in_date', motBookedInDate: 'mot_booked_in_date',
  service_booked_in_date: 'service_booked_in_date', serviceBookedInDate: 'service_booked_in_date',
  insurance_booked_in_date: 'insurance_booked_in_date', insuranceBookedInDate: 'insurance_booked_in_date',
  tax_booked_in_date: 'tax_booked_in_date', taxBookedInDate: 'tax_booked_in_date',
  // NOTE: current_mileage is deliberately NOT settable here — it is a
  // ratcheted/derived field and corrections must go through the audited
  // current-mileage correction endpoint (managers+ only).
  // V5 fields
  vin: 'vin',
  date_first_reg: 'date_first_reg', dateFirstReg: 'date_first_reg',
  v5_type: 'v5_type', v5Type: 'v5_type',
  body_type: 'body_type', bodyType: 'body_type',
  max_mass_kg: 'max_mass_kg', maxMassKg: 'max_mass_kg',
  vehicle_category: 'vehicle_category', vehicleCategory: 'vehicle_category',
  cylinder_capacity_cc: 'cylinder_capacity_cc', cylinderCapacityCc: 'cylinder_capacity_cc',
  // Extended details (migration 015)
  oil_type: 'oil_type', oilType: 'oil_type',
  coolant_type: 'coolant_type', coolantType: 'coolant_type',
  tyre_size: 'tyre_size', tyreSize: 'tyre_size',
  last_rossetts_service_date: 'last_rossetts_service_date', lastRossettsServiceDate: 'last_rossetts_service_date',
  last_rossetts_service_notes: 'last_rossetts_service_notes', lastRossettsServiceNotes: 'last_rossetts_service_notes',
  service_plan_status: 'service_plan_status', servicePlanStatus: 'service_plan_status',
  // Rossetts annual warranty applicability (migration 088)
  rossetts_applicable: 'rossetts_applicable', rossettsApplicable: 'rossetts_applicable',
  // Seat layout (migration 041)
  seat_layout: 'seat_layout', seatLayout: 'seat_layout',
};

/** Coerce a request value for its target DB column (uppercase reg, stringify jsonb). */
function coerceFleetValue(key: string, dbCol: string, value: unknown): unknown {
  if (key === 'reg') return String(value).toUpperCase();
  if ((dbCol === 'setup_checklist' || dbCol === 'removal_checklist' || dbCol === 'finance_fees') && typeof value !== 'string') {
    return JSON.stringify(value ?? []);
  }
  return value;
}

/**
 * Vehicle finance is ADMIN-ONLY (jon's call, May 2026). These DB columns are
 * stripped from read payloads for non-admins and rejected on writes. The
 * removal checklist (removal_checklist) and sold_date are deliberately NOT in
 * here — they're operational and visible to all staff. Easy to widen the
 * gate later by changing `canViewVehicleFinance`.
 */
const FINANCE_DB_COLUMNS = new Set([
  'finance_with', 'finance_ends', 'finance_start', 'finance_reference',
  'cash_price', 'deposit_paid', 'amount_financed', 'monthly_payment',
  'finance_term_months', 'finance_fees',
  'sale_price', 'sale_notes',
]);

/** Whether this role may read/write vehicle finance fields. Admin only for now. */
function canViewVehicleFinance(role: string | undefined): boolean {
  return role === 'admin';
}

router.post('/fleet', async (req: AuthRequest, res: Response) => {
  try {
    const v = req.body;
    if (!v.reg || !String(v.reg).trim()) {
      res.status(400).json({ error: 'Registration is required' });
      return;
    }

    // Build a dynamic INSERT from whitelisted fields. Columns not provided fall
    // back to their DB defaults (hire_status, fuel_type, fleet_group, etc.).
    const columns: string[] = [];
    const placeholders: string[] = [];
    const values: unknown[] = [];
    let idx = 1;
    const financeAllowed = canViewVehicleFinance(req.user?.role);
    for (const [key, dbCol] of Object.entries(FLEET_FIELD_MAP)) {
      if (FINANCE_DB_COLUMNS.has(dbCol) && !financeAllowed) continue;
      if (v[key] !== undefined && !columns.includes(dbCol)) {
        columns.push(dbCol);
        placeholders.push(`$${idx}`);
        values.push(coerceFleetValue(key, dbCol, v[key]));
        idx++;
      }
    }

    const result = await query(
      `INSERT INTO fleet_vehicles (${columns.join(', ')})
       VALUES (${placeholders.join(', ')}) RETURNING *`,
      values
    );

    res.status(201).json(mapDbRowToVehicle(result.rows[0], { includeFinance: financeAllowed }));
  } catch (error) {
    console.error('[vehicles/fleet] Create error:', error);
    if ((error as { code?: string }).code === '23505') {
      res.status(409).json({ error: 'A vehicle with this registration already exists' });
      return;
    }
    res.status(500).json({ error: 'Failed to create vehicle' });
  }
});

/**
 * PUT /api/vehicles/fleet/:id
 * Update a vehicle.
 */
router.put('/fleet/:id', async (req: AuthRequest, res: Response) => {
  try {
    const { id } = req.params;
    const v = req.body;

    // Build dynamic SET clause from provided fields
    const fields: string[] = [];
    const values: unknown[] = [];
    let idx = 1;

    const financeAllowed = canViewVehicleFinance(req.user?.role);
    for (const [key, dbCol] of Object.entries(FLEET_FIELD_MAP)) {
      if (FINANCE_DB_COLUMNS.has(dbCol) && !financeAllowed) continue;
      if (v[key] !== undefined) {
        // Avoid duplicate columns
        if (!fields.some(f => f.startsWith(`${dbCol} =`))) {
          fields.push(`${dbCol} = $${idx}`);
          values.push(coerceFleetValue(key, dbCol, v[key]));
          idx++;
        }
      }
    }

    if (fields.length === 0) {
      res.status(400).json({ error: 'No fields to update' });
      return;
    }

    values.push(id);
    const result = await query(
      `UPDATE fleet_vehicles SET ${fields.join(', ')} WHERE id = $${idx} RETURNING *`,
      values
    );

    if (result.rows.length === 0) {
      res.status(404).json({ error: 'Vehicle not found' });
      return;
    }

    res.json(mapDbRowToVehicle(result.rows[0], { includeFinance: financeAllowed }));
  } catch (error) {
    console.error('[vehicles/fleet] Update error:', error);
    res.status(500).json({ error: 'Failed to update vehicle' });
  }
});

/**
 * PATCH /api/vehicles/fleet/:id/current-mileage
 * Audited correction of current_mileage. This is the ONLY path that can LOWER
 * the figure — every other write path ratchets upward (GREATEST guard), so a
 * fat-fingered high reading is otherwise stuck. Managers+ only.
 * Writes the figure directly, logs a 'correction' reading for the history
 * list, and records an audit_log entry.
 */
router.patch('/fleet/:id/current-mileage', async (req: FlexibleVehicleRequest, res: Response) => {
  try {
    const role = req.user?.role;
    if (!role || !['admin', 'manager', 'weekend_manager'].includes(role)) {
      res.status(403).json({ error: 'Manager access required to correct mileage' });
      return;
    }

    const { id } = req.params;
    const { mileage, reason } = req.body;
    const userId = req.user?.id || null;
    const mileageVal = Number(mileage);

    if (!Number.isFinite(mileageVal) || mileageVal <= 0) {
      res.status(400).json({ error: 'A valid mileage is required' });
      return;
    }

    const existing = await query('SELECT id, current_mileage FROM fleet_vehicles WHERE id = $1', [id]);
    if (existing.rows.length === 0) {
      res.status(404).json({ error: 'Vehicle not found' });
      return;
    }
    const previousMileage = existing.rows[0].current_mileage as number | null;

    // Direct set — deliberately bypasses the upward-only ratchet so a bad high
    // value can be corrected down.
    const result = await query(
      `UPDATE fleet_vehicles SET current_mileage = $1, last_mileage_update = NOW()
       WHERE id = $2 RETURNING *`,
      [mileageVal, id]
    );

    // Audit trail in the mileage history list (source='correction').
    await query(
      `INSERT INTO vehicle_mileage_log (vehicle_id, mileage, source, source_ref, recorded_by)
       VALUES ($1, $2, 'correction', $3, $4)`,
      [id, mileageVal, reason ? String(reason).slice(0, 200) : null, userId]
    ).catch(err => console.warn('[vehicles/current-mileage] log insert failed:', err));

    await query(
      `INSERT INTO audit_log (user_id, entity_type, entity_id, action, previous_values, new_values)
       VALUES ($1, 'fleet_vehicle', $2, 'correct_mileage', $3, $4)`,
      [
        userId,
        id,
        JSON.stringify({ current_mileage: previousMileage }),
        JSON.stringify({ current_mileage: mileageVal, reason: reason || null }),
      ]
    ).catch(err => console.warn('[vehicles/current-mileage] audit insert failed:', err));

    res.json(mapDbRowToVehicle(result.rows[0], { includeFinance: canViewVehicleFinance(req.user?.role) }));
  } catch (error) {
    console.error('[vehicles/current-mileage] Correction error:', error);
    res.status(500).json({ error: 'Failed to correct mileage' });
  }
});

/**
 * PATCH /api/vehicles/fleet/by-reg/:reg/hire-status
 * Quick hire status update by registration plate.
 * Used by book-out (→ "On Hire") and check-in (→ "Prep Needed").
 */
router.patch('/fleet/by-reg/:reg/hire-status', async (req: FlexibleVehicleRequest, res: Response) => {
  try {
    const reg = (req.params.reg as string).toUpperCase();
    const { status } = req.body;

    if (!status) {
      res.status(400).json({ error: 'status is required' });
      return;
    }

    // Freelancer: only allowed to flip THEIR vehicle to 'On Hire' (book-out
    // completion). All other transitions require staff.
    if (isFreelancerBookout(req)) {
      const scope = await getBookoutScope(req);
      if (!scope || reg !== scope.registration) {
        res.status(403).json({ error: 'Not your vehicle' });
        return;
      }
      if (status !== 'On Hire') {
        res.status(403).json({ error: 'Freelancer session can only set status to On Hire' });
        return;
      }
    }

    const result = await query(
      'UPDATE fleet_vehicles SET hire_status = $1 WHERE reg = $2 RETURNING *',
      [status, reg]
    );

    if (result.rows.length === 0) {
      res.status(404).json({ error: `Vehicle with reg ${reg} not found` });
      return;
    }

    console.log(`[vehicles/fleet] Hire status updated: ${reg} → ${status}`);
    res.json({ success: true, vehicle: mapDbRowToVehicle(result.rows[0], { includeFinance: canViewVehicleFinance(req.user?.role) }) });
  } catch (error) {
    console.error('[vehicles/fleet] Hire status update error:', error);
    res.status(500).json({ error: 'Failed to update hire status' });
  }
});

/**
 * PATCH /api/vehicles/fleet/:id/mark-washed
 * Clears the "needs external wash" marker once a van has been to the carwash.
 * Staff action (the marker is also auto-cleared by a later prep recording the
 * bodywork as "Washed and clean").
 */
router.patch('/fleet/:id/mark-washed', async (req: AuthRequest, res: Response) => {
  try {
    const { id } = req.params;
    const userId = req.user?.id || null;

    const existing = await query('SELECT needs_external_wash FROM fleet_vehicles WHERE id = $1', [id]);
    if (existing.rows.length === 0) {
      res.status(404).json({ error: 'Vehicle not found' });
      return;
    }
    const previousValue = existing.rows[0].needs_external_wash === true;

    const result = await query(
      'UPDATE fleet_vehicles SET needs_external_wash = false WHERE id = $1 RETURNING *',
      [id]
    );

    await query(
      `INSERT INTO audit_log (user_id, entity_type, entity_id, action, previous_values, new_values)
       VALUES ($1, 'fleet_vehicle', $2, 'mark_washed', $3, $4)`,
      [
        userId,
        id,
        JSON.stringify({ needs_external_wash: previousValue }),
        JSON.stringify({ needs_external_wash: false }),
      ]
    ).catch(err => console.warn('[vehicles/mark-washed] audit insert failed:', err));

    res.json({ success: true, vehicle: mapDbRowToVehicle(result.rows[0], { includeFinance: canViewVehicleFinance(req.user?.role) }) });
  } catch (error) {
    console.error('[vehicles/fleet] Mark washed error:', error);
    res.status(500).json({ error: 'Failed to mark vehicle as washed' });
  }
});

/**
 * POST /api/vehicles/fleet/bulk
 * Bulk upsert vehicles (for one-time Monday.com data import).
 */
router.post('/fleet/bulk', async (req: AuthRequest, res: Response) => {
  try {
    const { vehicles } = req.body;
    if (!Array.isArray(vehicles) || vehicles.length === 0) {
      res.status(400).json({ error: 'vehicles array is required' });
      return;
    }

    let created = 0;
    let updated = 0;
    const errors: string[] = [];

    for (const v of vehicles) {
      try {
        const reg = (v.reg || '').toUpperCase();
        if (!reg) {
          errors.push('Skipped vehicle with no registration');
          continue;
        }

        const result = await query(
          `INSERT INTO fleet_vehicles (
            reg, vehicle_type, simple_type, make, model, colour, seats,
            damage_status, service_status, hire_status,
            mot_due, tax_due, tfl_due, last_service_date, warranty_expires,
            last_service_mileage, next_service_due,
            ulez_compliant, spare_key, wifi_network,
            finance_with, finance_ends,
            co2_per_km, recommended_tyre_psi_front, recommended_tyre_psi_rear,
            fuel_type, mpg, fleet_group, is_active, monday_item_id, notes
          ) VALUES (
            $1, $2, $3, $4, $5, $6, $7,
            $8, $9, $10,
            $11, $12, $13, $14, $15,
            $16, $17,
            $18, $19, $20,
            $21, $22,
            $23, $24, $25,
            $26, $27, $28, $29, $30, $31
          )
          ON CONFLICT (reg) DO UPDATE SET
            vehicle_type = EXCLUDED.vehicle_type,
            simple_type = EXCLUDED.simple_type,
            make = EXCLUDED.make,
            model = EXCLUDED.model,
            colour = EXCLUDED.colour,
            seats = EXCLUDED.seats,
            damage_status = EXCLUDED.damage_status,
            service_status = EXCLUDED.service_status,
            hire_status = EXCLUDED.hire_status,
            mot_due = EXCLUDED.mot_due,
            tax_due = EXCLUDED.tax_due,
            tfl_due = EXCLUDED.tfl_due,
            last_service_date = EXCLUDED.last_service_date,
            warranty_expires = EXCLUDED.warranty_expires,
            last_service_mileage = EXCLUDED.last_service_mileage,
            next_service_due = EXCLUDED.next_service_due,
            ulez_compliant = EXCLUDED.ulez_compliant,
            spare_key = EXCLUDED.spare_key,
            wifi_network = EXCLUDED.wifi_network,
            finance_with = EXCLUDED.finance_with,
            finance_ends = EXCLUDED.finance_ends,
            co2_per_km = EXCLUDED.co2_per_km,
            recommended_tyre_psi_front = EXCLUDED.recommended_tyre_psi_front,
            recommended_tyre_psi_rear = EXCLUDED.recommended_tyre_psi_rear,
            fuel_type = EXCLUDED.fuel_type,
            mpg = EXCLUDED.mpg,
            fleet_group = EXCLUDED.fleet_group,
            is_active = EXCLUDED.is_active,
            monday_item_id = EXCLUDED.monday_item_id,
            notes = EXCLUDED.notes
          RETURNING (xmax = 0) AS is_insert`,
          [
            reg, v.vehicleType || v.vehicle_type, v.simpleType || v.simple_type,
            v.make, v.model, v.colour, v.seats || null,
            v.damageStatus || v.damage_status || 'ALL GOOD',
            v.serviceStatus || v.service_status || 'OK',
            v.hireStatus || v.hire_status || 'Available',
            v.motDue || v.mot_due || null, v.taxDue || v.tax_due || null,
            v.tflDue || v.tfl_due || null, v.lastServiceDate || v.last_service_date || null,
            v.warrantyExpires || v.warranty_expires || null,
            v.lastServiceMileage || v.last_service_mileage || null,
            v.nextServiceDue || v.next_service_due || null,
            v.ulezCompliant ?? v.ulez_compliant ?? true,
            v.spareKey ?? v.spare_key ?? false,
            v.wifiNetwork || v.wifi_network || null,
            v.financeWith || v.finance_with || null,
            v.financeEnds || v.finance_ends || null,
            v.co2PerKm || v.co2_per_km || null,
            v.recommendedTyrePsiFront || v.recommended_tyre_psi_front || null,
            v.recommendedTyrePsiRear || v.recommended_tyre_psi_rear || null,
            v.fuelType || v.fuel_type || 'diesel',
            v.mpg || null,
            v.fleetGroup || v.fleet_group || 'active',
            v.isActive ?? v.is_active ?? true,
            v.mondayItemId || v.monday_item_id || v.id || null,
            v.notes || null,
          ]
        );

        if (result.rows[0].is_insert) {
          created++;
        } else {
          updated++;
        }
      } catch (err) {
        const reg = (v.reg || 'unknown').toUpperCase();
        errors.push(`${reg}: ${err instanceof Error ? err.message : 'Unknown error'}`);
      }
    }

    console.log(`[vehicles/fleet] Bulk import: ${created} created, ${updated} updated, ${errors.length} errors`);
    res.json({ created, updated, errors, total: vehicles.length });
  } catch (error) {
    console.error('[vehicles/fleet] Bulk import error:', error);
    res.status(500).json({ error: 'Bulk import failed' });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// 1b. SERVICE LOG — /api/vehicles/fleet/:vehicleId/service-log/*
//     CRUD for vehicle service, repair, MOT, insurance, and tax records.
// ═══════════════════════════════════════════════════════════════════════════

function mapServiceLogRow(row: Record<string, unknown>) {
  return {
    id: row.id as string,
    vehicleId: row.vehicle_id as string,
    name: row.name as string,
    serviceType: row.service_type as string,
    serviceDate: formatDate(row.service_date),
    mileage: row.mileage as number | null,
    cost: row.cost ? Number(row.cost) : null,
    status: row.status as string | null,
    garage: row.garage as string | null,
    hirehopJob: row.hirehop_job as string | null,
    notes: row.notes as string | null,
    nextDueDate: formatDate(row.next_due_date),
    nextDueMileage: row.next_due_mileage as number | null,
    aiSummary: row.ai_summary as string | null,
    aiExtracted: row.ai_extracted as boolean,
    files: row.files || [],
    createdBy: row.created_by as string | null,
    createdByName: row.created_by_name as string | null,
    createdAt: row.created_at ? (row.created_at as Date).toISOString() : null,
    updatedAt: row.updated_at ? (row.updated_at as Date).toISOString() : null,
  };
}

/**
 * GET /api/vehicles/fleet/:vehicleId/service-log
 * List all service records for a vehicle. Optional ?type= filter.
 */
router.get('/fleet/:vehicleId/service-log', async (req: AuthRequest, res: Response) => {
  try {
    const { vehicleId } = req.params;
    const { type, limit = '50', offset = '0' } = req.query;

    let sql = `SELECT sl.*, CONCAT(p.first_name, ' ', p.last_name) AS created_by_name
      FROM vehicle_service_log sl
      LEFT JOIN users u ON u.id = sl.created_by
      LEFT JOIN people p ON p.id = u.person_id
      WHERE sl.vehicle_id = $1`;
    const params: unknown[] = [vehicleId];
    let idx = 2;

    if (type && typeof type === 'string') {
      sql += ` AND sl.service_type = $${idx}`;
      params.push(type);
      idx++;
    }

    sql += ` ORDER BY sl.service_date DESC NULLS LAST, sl.created_at DESC LIMIT $${idx} OFFSET $${idx + 1}`;
    params.push(Number(limit), Number(offset));

    const result = await query(sql, params);

    // Get total count
    let countSql = 'SELECT COUNT(*) FROM vehicle_service_log WHERE vehicle_id = $1';
    const countParams: unknown[] = [vehicleId];
    if (type && typeof type === 'string') {
      countSql += ' AND service_type = $2';
      countParams.push(type);
    }
    const countResult = await query(countSql, countParams);

    res.json({
      data: result.rows.map(mapServiceLogRow),
      total: Number(countResult.rows[0].count),
    });
  } catch (error) {
    console.error('[vehicles/service-log] List error:', error);
    res.status(500).json({ error: 'Failed to fetch service records' });
  }
});

/**
 * GET /api/vehicles/fleet/:vehicleId/service-log/:logId
 * Get a single service record.
 */
router.get('/fleet/:vehicleId/service-log/:logId', async (req: AuthRequest, res: Response) => {
  try {
    const { vehicleId, logId } = req.params;
    const result = await query(
      `SELECT sl.*, CONCAT(p.first_name, ' ', p.last_name) AS created_by_name
       FROM vehicle_service_log sl
       LEFT JOIN users u ON u.id = sl.created_by
       LEFT JOIN people p ON p.id = u.person_id
       WHERE sl.id = $1 AND sl.vehicle_id = $2`,
      [logId, vehicleId]
    );
    if (result.rows.length === 0) {
      res.status(404).json({ error: 'Service record not found' });
      return;
    }
    res.json(mapServiceLogRow(result.rows[0]));
  } catch (error) {
    console.error('[vehicles/service-log] Get error:', error);
    res.status(500).json({ error: 'Failed to fetch service record' });
  }
});

/**
 * POST /api/vehicles/fleet/:vehicleId/service-log
 * Create a new service record. Also updates vehicle mileage and due dates.
 */
router.post('/fleet/:vehicleId/service-log', async (req: AuthRequest, res: Response) => {
  try {
    const { vehicleId } = req.params;
    const authReq = req as AuthRequest;
    const userId = authReq.user?.id || null;
    const {
      name, service_type = 'service', service_date, mileage, cost,
      status, garage, hirehop_job, notes, next_due_date, next_due_mileage,
      ai_summary, ai_extracted = false, files = [],
    } = req.body;

    // When false (e.g. backfilling a historical record), the record is logged
    // but the vehicle's live figures (current mileage, last/next service, due
    // dates) are NOT touched. Defaults to true.
    const applyToVehicle = req.body.apply_to_vehicle !== false;

    if (!name) {
      res.status(400).json({ error: 'name is required' });
      return;
    }

    // Insert service record
    const result = await query(
      `INSERT INTO vehicle_service_log (
        vehicle_id, name, service_type, service_date, mileage, cost,
        status, garage, hirehop_job, notes, next_due_date, next_due_mileage,
        ai_summary, ai_extracted, files, created_by
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
      RETURNING *`,
      [
        vehicleId, name, service_type, service_date || null, mileage || null, cost || null,
        status || null, garage || null, hirehop_job || null, notes || null,
        next_due_date || null, next_due_mileage || null,
        ai_summary || null, ai_extracted, JSON.stringify(files), userId,
      ]
    );

    const record = result.rows[0];

    // If mileage provided, always log it to the historical mileage log. The
    // live current_mileage only moves when applying to the vehicle (and never
    // downward — the < $1 guard keeps the highest reading).
    if (mileage) {
      await query(
        `INSERT INTO vehicle_mileage_log (vehicle_id, mileage, source, source_ref, recorded_by)
         VALUES ($1, $2, 'service', $3, $4)`,
        [vehicleId, mileage, record.id, userId]
      );
      if (applyToVehicle) {
        await query(
          `UPDATE fleet_vehicles SET current_mileage = $1, last_mileage_update = NOW()
           WHERE id = $2 AND (current_mileage IS NULL OR current_mileage < $1)`,
          [mileage, vehicleId]
        );
      }
    }

    // The remaining writes mutate the vehicle's live figures — skip entirely
    // for backfilled / historical records.
    if (applyToVehicle) {
      // If next_due_date, update the relevant due date on fleet_vehicles
      if (next_due_date) {
        if (service_type === 'mot') {
          await query('UPDATE fleet_vehicles SET mot_due = $1 WHERE id = $2', [next_due_date, vehicleId]);
        } else if (service_type === 'insurance') {
          await query('UPDATE fleet_vehicles SET insurance_due = $1 WHERE id = $2', [next_due_date, vehicleId]);
        } else if (service_type === 'tax') {
          await query('UPDATE fleet_vehicles SET tax_due = $1 WHERE id = $2', [next_due_date, vehicleId]);
        }
      }

      // Propagate the next service mileage threshold to the vehicle so the
      // "miles until service" indicator + alerts pick it up automatically.
      if ((service_type === 'service' || service_type === 'repair') && next_due_mileage) {
        await query('UPDATE fleet_vehicles SET next_service_due = $1 WHERE id = $2', [next_due_mileage, vehicleId]);
      }

      // Update last_service_date if this is a service record
      if ((service_type === 'service' || service_type === 'repair') && service_date) {
        await query(
          `UPDATE fleet_vehicles SET last_service_date = $1, last_service_mileage = COALESCE($2, last_service_mileage)
           WHERE id = $3`,
          [service_date, mileage, vehicleId]
        );
      }
    }

    res.status(201).json(mapServiceLogRow(record));
  } catch (error) {
    console.error('[vehicles/service-log] Create error:', error);
    res.status(500).json({ error: 'Failed to create service record' });
  }
});

/**
 * PUT /api/vehicles/fleet/:vehicleId/service-log/:logId
 * Update a service record.
 */
router.put('/fleet/:vehicleId/service-log/:logId', async (req: AuthRequest, res: Response) => {
  try {
    const { vehicleId, logId } = req.params;
    const v = req.body;

    const fieldMap: Record<string, string> = {
      name: 'name', service_type: 'service_type', service_date: 'service_date',
      mileage: 'mileage', cost: 'cost', status: 'status',
      garage: 'garage', hirehop_job: 'hirehop_job', notes: 'notes',
      next_due_date: 'next_due_date', next_due_mileage: 'next_due_mileage',
      ai_summary: 'ai_summary', files: 'files',
    };

    const fields: string[] = [];
    const values: unknown[] = [];
    let idx = 1;

    for (const [key, dbCol] of Object.entries(fieldMap)) {
      if (v[key] !== undefined) {
        fields.push(`${dbCol} = $${idx}`);
        values.push(key === 'files' ? JSON.stringify(v[key]) : v[key]);
        idx++;
      }
    }

    if (fields.length === 0) {
      res.status(400).json({ error: 'No fields to update' });
      return;
    }

    values.push(logId, vehicleId);
    const result = await query(
      `UPDATE vehicle_service_log SET ${fields.join(', ')}, updated_at = NOW()
       WHERE id = $${idx} AND vehicle_id = $${idx + 1} RETURNING *`,
      values
    );

    if (result.rows.length === 0) {
      res.status(404).json({ error: 'Service record not found' });
      return;
    }

    res.json(mapServiceLogRow(result.rows[0]));
  } catch (error) {
    console.error('[vehicles/service-log] Update error:', error);
    res.status(500).json({ error: 'Failed to update service record' });
  }
});

/**
 * DELETE /api/vehicles/fleet/:vehicleId/service-log/:logId
 * Delete a service record.
 */
router.delete('/fleet/:vehicleId/service-log/:logId', async (req: AuthRequest, res: Response) => {
  try {
    const { vehicleId, logId } = req.params;
    const result = await query(
      'DELETE FROM vehicle_service_log WHERE id = $1 AND vehicle_id = $2 RETURNING id',
      [logId, vehicleId]
    );

    if (result.rows.length === 0) {
      res.status(404).json({ error: 'Service record not found' });
      return;
    }

    res.json({ success: true });
  } catch (error) {
    console.error('[vehicles/service-log] Delete error:', error);
    res.status(500).json({ error: 'Failed to delete service record' });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// 1c. SERVICE LOG FILES — /api/vehicles/fleet/:vehicleId/service-log/:logId/files
// ═══════════════════════════════════════════════════════════════════════════

const serviceLogUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }, // 10 MB
});

/**
 * POST /api/vehicles/fleet/:vehicleId/service-log/:logId/files
 * Upload a file and append to the service record's files JSONB array.
 */
router.post(
  '/fleet/:vehicleId/service-log/:logId/files',
  serviceLogUpload.single('file'),
  async (req: AuthRequest, res: Response) => {
    try {
      const { vehicleId, logId } = req.params;
      if (!req.file) {
        res.status(400).json({ error: 'No file provided' });
        return;
      }

      // Verify record exists
      const existing = await query(
        'SELECT id, files FROM vehicle_service_log WHERE id = $1 AND vehicle_id = $2',
        [logId, vehicleId]
      );
      if (existing.rows.length === 0) {
        res.status(404).json({ error: 'Service record not found' });
        return;
      }

      const ext = path.extname(req.file.originalname).toLowerCase();
      const fileId = uuid();
      const key = `files/vehicle-service/${vehicleId}/${logId}/${fileId}${ext}`;

      await uploadToR2(key, req.file.buffer, req.file.mimetype);

      const imageExts = ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.svg'];
      const docExts = ['.pdf', '.doc', '.docx', '.xls', '.xlsx', '.csv', '.txt'];
      const fileType = imageExts.includes(ext) ? 'image' : docExts.includes(ext) ? 'document' : 'other';

      const comment = req.body?.comment?.trim() || '';

      const fileMeta: Record<string, unknown> = {
        name: req.file.originalname,
        url: key,
        type: fileType,
        size: req.file.size,
        uploaded_at: new Date().toISOString(),
        uploaded_by: req.user!.email,
      };
      if (comment) {
        fileMeta.comment = comment;
      }

      // Append to JSONB array
      await query(
        `UPDATE vehicle_service_log
         SET files = COALESCE(files, '[]'::jsonb) || $1::jsonb, updated_at = NOW()
         WHERE id = $2 AND vehicle_id = $3`,
        [JSON.stringify([fileMeta]), logId, vehicleId]
      );

      res.status(201).json(fileMeta);
    } catch (error) {
      console.error('[vehicles/service-log] File upload error:', error);
      if (error instanceof multer.MulterError) {
        res.status(400).json({ error: `Upload error: ${error.message}` });
        return;
      }
      res.status(500).json({ error: 'File upload failed' });
    }
  }
);

/**
 * DELETE /api/vehicles/fleet/:vehicleId/service-log/:logId/files
 * Remove a file from the service record and R2.
 * Body: { key: "files/vehicle-service/..." }
 */
router.delete('/fleet/:vehicleId/service-log/:logId/files', async (req: AuthRequest, res: Response) => {
  try {
    const { vehicleId, logId } = req.params;
    const { key } = req.body;
    if (!key) {
      res.status(400).json({ error: 'key is required' });
      return;
    }

    // Get current files
    const existing = await query(
      'SELECT files FROM vehicle_service_log WHERE id = $1 AND vehicle_id = $2',
      [logId, vehicleId]
    );
    if (existing.rows.length === 0) {
      res.status(404).json({ error: 'Service record not found' });
      return;
    }

    const files = (existing.rows[0].files || []) as Array<{ url: string }>;
    const updated = files.filter(f => f.url !== key);

    // Delete from R2
    try {
      await deleteFromR2(key);
    } catch (e) {
      console.warn('[vehicles/service-log] R2 delete failed (may not exist):', e);
    }

    // Update JSONB
    await query(
      'UPDATE vehicle_service_log SET files = $1::jsonb, updated_at = NOW() WHERE id = $2 AND vehicle_id = $3',
      [JSON.stringify(updated), logId, vehicleId]
    );

    res.status(204).send();
  } catch (error) {
    console.error('[vehicles/service-log] File delete error:', error);
    res.status(500).json({ error: 'File delete failed' });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// 1d. VEHICLE FILES — /api/vehicles/fleet/:vehicleId/files
// ═══════════════════════════════════════════════════════════════════════════

const vehicleFileUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }, // 10 MB
});

/**
 * POST /api/vehicles/fleet/:vehicleId/files
 * Upload a file and append to the vehicle's files JSONB array.
 * Body (multipart): file, label (optional), comment (optional)
 */
router.post(
  '/fleet/:vehicleId/files',
  vehicleFileUpload.single('file'),
  async (req: AuthRequest, res: Response) => {
    try {
      const { vehicleId } = req.params;
      if (!req.file) {
        res.status(400).json({ error: 'No file provided' });
        return;
      }

      // Verify vehicle exists
      const existing = await query('SELECT id, files FROM fleet_vehicles WHERE id = $1', [vehicleId]);
      if (existing.rows.length === 0) {
        res.status(404).json({ error: 'Vehicle not found' });
        return;
      }

      // Finance docs are admin-only (flagged so the general Files UI hides them
      // and non-admins never receive them — see mapDbRowToVehicle).
      const isFinance = req.body.is_finance === 'true' || req.body.is_finance === true;
      if (isFinance && !canViewVehicleFinance(req.user?.role)) {
        res.status(403).json({ error: 'Admin access required to upload finance documents' });
        return;
      }

      const ext = path.extname(req.file.originalname).toLowerCase();
      const fileType = ext.match(/\.(jpg|jpeg|png|gif|webp|svg)$/i) ? 'image' : ext === '.pdf' ? 'document' : 'other';
      const fileId = uuid();
      const r2Key = `files/vehicle/${vehicleId}/${fileId}${ext}`;

      await uploadToR2(r2Key, req.file.buffer, req.file.mimetype);

      const fileMeta = {
        name: req.file.originalname,
        label: req.body.label || null,
        comment: req.body.comment || null,
        url: r2Key,
        type: fileType,
        is_finance: isFinance,
        uploaded_at: new Date().toISOString(),
        uploaded_by: req.user?.email || 'system',
      };

      const currentFiles = (existing.rows[0].files || []) as unknown[];
      currentFiles.push(fileMeta);

      await query(
        'UPDATE fleet_vehicles SET files = $1::jsonb WHERE id = $2',
        [JSON.stringify(currentFiles), vehicleId]
      );

      res.status(201).json(fileMeta);
    } catch (error) {
      console.error('[vehicles/files] Upload error:', error);
      if (error instanceof multer.MulterError) {
        res.status(400).json({ error: `Upload error: ${error.message}` });
        return;
      }
      res.status(500).json({ error: 'File upload failed' });
    }
  }
);

/**
 * DELETE /api/vehicles/fleet/:vehicleId/files
 * Remove a file from the vehicle and R2.
 * Body: { key: "files/vehicle/..." }
 */
router.delete('/fleet/:vehicleId/files', async (req: AuthRequest, res: Response) => {
  try {
    const { vehicleId } = req.params;
    const { key } = req.body;
    if (!key) {
      res.status(400).json({ error: 'key is required' });
      return;
    }

    const existing = await query('SELECT files FROM fleet_vehicles WHERE id = $1', [vehicleId]);
    if (existing.rows.length === 0) {
      res.status(404).json({ error: 'Vehicle not found' });
      return;
    }

    const files = (existing.rows[0].files || []) as Array<{ url: string }>;
    const updated = files.filter(f => f.url !== key);

    try {
      await deleteFromR2(key);
    } catch (e) {
      console.warn('[vehicles/files] R2 delete failed (may not exist):', e);
    }

    await query(
      'UPDATE fleet_vehicles SET files = $1::jsonb WHERE id = $2',
      [JSON.stringify(updated), vehicleId]
    );

    res.status(204).send();
  } catch (error) {
    console.error('[vehicles/files] Delete error:', error);
    res.status(500).json({ error: 'File delete failed' });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// 1e. FINANCE PROVIDERS — /api/vehicles/finance-providers
// Reusable picklist (category 'finance_provider', seeded in migration 103) for
// the admin-only finance-with dropdown. Staff can add ad-hoc providers that
// persist for reuse across the fleet. Admin only (matches finance visibility).
// NOTE: mounted at /finance-providers (NOT /fleet/...) to avoid colliding with
// the GET /fleet/:idOrReg route.
// ═══════════════════════════════════════════════════════════════════════════

router.get('/finance-providers', async (req: AuthRequest, res: Response) => {
  try {
    if (!canViewVehicleFinance(req.user?.role)) {
      res.status(403).json({ error: 'Admin access required' });
      return;
    }
    const result = await query(
      `SELECT value, label FROM picklist_items
       WHERE category = 'finance_provider' AND is_active = true
       ORDER BY sort_order ASC, label ASC`
    );
    res.json({ data: result.rows });
  } catch (error) {
    console.error('[vehicles/finance-providers] List error:', error);
    res.status(500).json({ error: 'Failed to load finance providers' });
  }
});

router.post('/finance-providers', async (req: AuthRequest, res: Response) => {
  try {
    if (!canViewVehicleFinance(req.user?.role)) {
      res.status(403).json({ error: 'Admin access required' });
      return;
    }
    const label = String(req.body?.label || '').trim();
    if (!label) {
      res.status(400).json({ error: 'label is required' });
      return;
    }
    // Append after the current max sort_order so ad-hoc additions land at the end.
    const maxRow = await query(
      `SELECT COALESCE(MAX(sort_order), 0) AS max FROM picklist_items WHERE category = 'finance_provider'`
    );
    const nextOrder = Number(maxRow.rows[0]?.max || 0) + 1;
    await query(
      `INSERT INTO picklist_items (category, value, label, sort_order)
       VALUES ('finance_provider', $1, $1, $2)
       ON CONFLICT (category, value) DO UPDATE SET is_active = true`,
      [label, nextOrder]
    );
    res.status(201).json({ value: label, label });
  } catch (error) {
    console.error('[vehicles/finance-providers] Create error:', error);
    res.status(500).json({ error: 'Failed to add finance provider' });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// 2. JOBS — /api/vehicles/jobs/*
//    Serves job data from the OP's jobs table in HireHopJob format.
//    Replaces the VM's direct HireHop API calls and R2 cache.
// ═══════════════════════════════════════════════════════════════════════════

/** HireHop status codes for active/dispatched jobs */
const ACTIVE_STATUSES = [1, 2, 3, 4, 5]; // Provisional → Dispatched
const RETURN_STATUSES = [5, 6]; // Dispatched, Returned Incomplete

/**
 * GET /api/vehicles/jobs/going-out
 * Jobs going out today and tomorrow (by out_date).
 */
router.get('/jobs/going-out', async (req: AuthRequest, res: Response) => {
  try {
    const today = new Date().toISOString().split('T')[0];
    const tomorrow = new Date(Date.now() + 86400000).toISOString().split('T')[0];

    const result = await query(
      `SELECT * FROM jobs
       WHERE is_deleted = false
         AND status = ANY($1)
         AND (
           (out_date IS NOT NULL AND out_date::date >= $2::date AND out_date::date <= $3::date)
           OR (out_date IS NULL AND job_date IS NOT NULL AND job_date::date >= $2::date AND job_date::date <= $3::date)
         )
       ORDER BY out_date ASC NULLS LAST, job_date ASC NULLS LAST`,
      [ACTIVE_STATUSES, today, tomorrow]
    );

    res.json(result.rows.map(mapJobRowToHireHopJob));
  } catch (error) {
    console.error('[vehicles/jobs] Going out error:', error);
    res.status(500).json({ error: 'Failed to load going-out jobs' });
  }
});

/**
 * GET /api/vehicles/jobs/due-back
 * Jobs due back today and tomorrow (by return_date).
 */
router.get('/jobs/due-back', async (req: AuthRequest, res: Response) => {
  try {
    const today = new Date().toISOString().split('T')[0];
    const tomorrow = new Date(Date.now() + 86400000).toISOString().split('T')[0];

    const result = await query(
      `SELECT * FROM jobs
       WHERE is_deleted = false
         AND status = ANY($1)
         AND (
           (return_date IS NOT NULL AND return_date::date >= $2::date AND return_date::date <= $3::date)
           OR (return_date IS NULL AND job_end IS NOT NULL AND job_end::date >= $2::date AND job_end::date <= $3::date)
         )
       ORDER BY return_date ASC NULLS LAST, job_end ASC NULLS LAST`,
      [RETURN_STATUSES, today, tomorrow]
    );

    res.json(result.rows.map(mapJobRowToHireHopJob));
  } catch (error) {
    console.error('[vehicles/jobs] Due back error:', error);
    res.status(500).json({ error: 'Failed to load due-back jobs' });
  }
});

/**
 * GET /api/vehicles/jobs/upcoming?days=7
 * Upcoming jobs for the next N days.
 */
router.get('/jobs/upcoming', async (req: AuthRequest, res: Response) => {
  try {
    const days = parseInt(req.query.days as string) || 7;
    const today = new Date().toISOString().split('T')[0];
    const endDate = new Date(Date.now() + days * 86400000).toISOString().split('T')[0];

    const result = await query(
      `SELECT * FROM jobs
       WHERE is_deleted = false
         AND status = ANY($1)
         AND (
           (out_date IS NOT NULL AND out_date::date >= $2::date AND out_date::date <= $3::date)
           OR (out_date IS NULL AND job_date IS NOT NULL AND job_date::date >= $2::date AND job_date::date <= $3::date)
         )
       ORDER BY out_date ASC NULLS LAST, job_date ASC NULLS LAST`,
      [ACTIVE_STATUSES, today, endDate]
    );

    res.json(result.rows.map(mapJobRowToHireHopJob));
  } catch (error) {
    console.error('[vehicles/jobs] Upcoming error:', error);
    res.status(500).json({ error: 'Failed to load upcoming jobs' });
  }
});

/**
 * GET /api/vehicles/jobs/upcoming-due-back?days=7
 * Upcoming due-back jobs for the next N days.
 *
 * Includes jobs with booked_out/active assignments in OP even if their HH
 * status is stale (e.g. HH status still at 2 Booked when the van is
 * physically out). Prevents vans disappearing from Due Back when the
 * OP→HH status auto-push is deferred and staff haven't advanced HH
 * manually.
 */
router.get('/jobs/upcoming-due-back', async (req: AuthRequest, res: Response) => {
  try {
    const days = parseInt(req.query.days as string) || 7;
    const today = new Date().toISOString().split('T')[0];
    const endDate = new Date(Date.now() + days * 86400000).toISOString().split('T')[0];

    const result = await query(
      `SELECT DISTINCT j.* FROM jobs j
       LEFT JOIN vehicle_hire_assignments vha ON vha.job_id = j.id
       WHERE j.is_deleted = false
         AND (
           j.status = ANY($1)
           OR vha.status IN ('booked_out', 'active')
         )
         AND (
           (j.return_date IS NOT NULL AND j.return_date::date >= $2::date AND j.return_date::date <= $3::date)
           OR (j.return_date IS NULL AND j.job_end IS NOT NULL AND j.job_end::date >= $2::date AND j.job_end::date <= $3::date)
         )
       ORDER BY j.return_date ASC NULLS LAST, j.job_end ASC NULLS LAST`,
      [RETURN_STATUSES, today, endDate]
    );

    res.json(result.rows.map(mapJobRowToHireHopJob));
  } catch (error) {
    console.error('[vehicles/jobs] Upcoming due-back error:', error);
    res.status(500).json({ error: 'Failed to load upcoming due-back jobs' });
  }
});

/**
 * GET /api/vehicles/jobs/cache-meta
 * Returns sync metadata (replaces R2 cache meta).
 */
router.get('/jobs/cache-meta', async (_req: AuthRequest, res: Response) => {
  try {
    const result = await query(
      `SELECT completed_at FROM sync_log
       WHERE sync_type = 'jobs' AND status = 'completed'
       ORDER BY completed_at DESC LIMIT 1`
    );

    res.json({
      syncedAt: result.rows[0]?.completed_at || null,
      source: 'op-database',
    });
  } catch {
    res.json({ syncedAt: null, source: 'op-database' });
  }
});

/**
 * POST /api/vehicles/jobs/refresh-items
 * On-demand sync: fetch line items from HireHop for specific jobs.
 * Called by the "Refresh from HireHop" button on the Allocations page.
 * Body: { jobNumbers: number[] }
 */
router.post('/jobs/refresh-items', async (req: AuthRequest, res: Response) => {
  try {
    const { jobNumbers } = req.body;
    if (!Array.isArray(jobNumbers) || jobNumbers.length === 0) {
      res.status(400).json({ error: 'jobNumbers array required' });
      return;
    }

    // Limit to 50 jobs per request to prevent abuse
    const limited = jobNumbers.slice(0, 50).map(Number).filter(n => !isNaN(n) && n > 0);
    if (limited.length === 0) {
      res.status(400).json({ error: 'No valid job numbers provided' });
      return;
    }

    const { syncLineItemsForJobs } = await import('../services/hirehop-job-sync');
    const result = await syncLineItemsForJobs(limited);

    res.json({
      success: true,
      updated: result.updated,
      errors: result.errors,
      total: limited.length,
    });
  } catch (error) {
    console.error('[vehicles/jobs] Refresh items error:', error);
    res.status(500).json({ error: 'Failed to refresh items' });
  }
});

/**
 * GET /api/vehicles/jobs/:jobNumber
 * Get a single job by HireHop job number.
 */
router.get('/jobs/:jobNumber', async (req: FlexibleVehicleRequest, res: Response) => {
  try {
    const jobNumber = parseInt(req.params.jobNumber as string);
    if (isNaN(jobNumber)) {
      res.status(400).json({ error: 'Invalid job number' });
      return;
    }

    // Freelancer: only allowed to look up their own assignment's job.
    if (isFreelancerBookout(req)) {
      const scope = await getBookoutScope(req);
      if (!scope || scope.hhJobNumber !== jobNumber) {
        res.status(403).json({ error: 'Not your job' });
        return;
      }
    }

    const result = await query(
      'SELECT * FROM jobs WHERE hh_job_number = $1 AND is_deleted = false',
      [jobNumber]
    );

    if (result.rows.length === 0) {
      res.status(404).json({ error: `Job #${jobNumber} not found` });
      return;
    }

    res.json(mapJobRowToHireHopJob(result.rows[0]));
  } catch (error) {
    console.error('[vehicles/jobs] Job detail error:', error);
    res.status(500).json({ error: 'Failed to load job' });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// 3. HIREHOP PROXY — /api/vehicles/hirehop/*
//    Direct HireHop API operations (barcode checkout/checkin, status updates).
//    Uses the OP's HireHop config (token + domain) instead of Netlify proxy.
// ═══════════════════════════════════════════════════════════════════════════

/**
 * POST /api/vehicles/hirehop
 * Generic HireHop proxy — forwards requests to HireHop API.
 * Body: { endpoint, method, params }
 */
router.post('/hirehop', async (req: AuthRequest, res: Response) => {
  try {
    if (!isHireHopConfigured()) {
      res.status(503).json({ error: 'HireHop not configured' });
      return;
    }

    const { endpoint, method, params } = req.body;
    if (!endpoint) {
      res.status(400).json({ error: 'endpoint is required' });
      return;
    }

    let result;
    if (method === 'POST') {
      result = await hhBroker.post(endpoint, params || {}, { priority: 'high' });
    } else {
      result = await hhBroker.get(endpoint, params || {}, { priority: 'high' });
    }

    if (!result.success) {
      // Return the error in a format the VM's hirehop-api.ts expects
      res.status(400).json({ error: result.error });
      return;
    }

    res.json(result.data);
  } catch (error) {
    console.error('[vehicles/hirehop] Proxy error:', error);
    res.status(500).json({ error: 'HireHop request failed' });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// 4. R2-BACKED DATA ENDPOINTS
//    Settings, issues, allocations, stock, and vehicle events.
//    All stored in the OP's R2 bucket under vm-specific prefixes.
// ═══════════════════════════════════════════════════════════════════════════

/** Helper: read a JSON file from R2, return parsed object or null */
async function readR2Json<T>(key: string): Promise<T | null> {
  try {
    const resp = await getFromR2(key);
    if (!resp.Body) return null;
    const text = await resp.Body.transformToString('utf-8');
    return JSON.parse(text) as T;
  } catch (err: unknown) {
    const code = (err as { name?: string })?.name;
    if (code === 'NoSuchKey') return null;
    throw err;
  }
}

/** Helper: write a JSON object to R2 */
async function writeR2Json(key: string, data: unknown): Promise<void> {
  const body = Buffer.from(JSON.stringify(data));
  await uploadToR2(key, body, 'application/json');
}

// ── Checklist Settings ──

/**
 * GET /api/vehicles/get-checklist-settings
 * Fetch checklist settings from R2. Falls back to empty defaults.
 */
router.get('/get-checklist-settings', async (_req: AuthRequest, res: Response) => {
  try {
    const data = await readR2Json<Record<string, unknown>>('settings/checklists.json');
    if (data) {
      res.json(data);
    } else {
      // Return empty structure — the frontend has DEFAULT_CHECKLIST_SETTINGS as fallback
      res.json({ briefingItems: {}, prepItems: {} });
    }
  } catch (error) {
    console.error('[vehicles/settings] Failed to read checklist settings:', error);
    res.status(500).json({ error: 'Failed to load settings' });
  }
});

/**
 * POST /api/vehicles/save-checklist-settings
 * Save checklist settings to R2.
 */
router.post('/save-checklist-settings', async (req: AuthRequest, res: Response) => {
  try {
    const data = req.body;
    data.updatedAt = new Date().toISOString();
    await writeR2Json('settings/checklists.json', data);
    res.json({ success: true });
  } catch (error) {
    console.error('[vehicles/settings] Failed to save checklist settings:', error);
    res.status(500).json({ error: 'Failed to save settings' });
  }
});

// ── Issues (R2-backed) ──

/**
 * GET /api/vehicles/get-all-issues
 * Fetch the fleet-wide issue index from R2.
 */
router.get('/get-all-issues', async (_req: AuthRequest, res: Response) => {
  try {
    const data = await readR2Json<{ issues: unknown[] }>('issues/_index.json');
    res.json({ issues: data?.issues || [] });
  } catch (error) {
    console.error('[vehicles/issues] Failed to read issues index:', error);
    res.status(500).json({ error: 'Failed to load issues' });
  }
});

/**
 * GET /api/vehicles/get-vehicle-issues?vehicleReg=XX00XXX
 * Fetch all issues for a specific vehicle from R2.
 */
router.get('/get-vehicle-issues', async (req: AuthRequest, res: Response) => {
  try {
    const vehicleReg = (req.query.vehicleReg as string || '').toUpperCase();
    if (!vehicleReg) {
      res.status(400).json({ error: 'vehicleReg is required' });
      return;
    }

    const prefix = `issues/${vehicleReg}/`;
    const objects = await listR2Objects(prefix);
    const issues: unknown[] = [];

    for (const obj of objects) {
      if (!obj.Key || obj.Key.endsWith('/_index.json')) continue;
      const issue = await readR2Json(obj.Key);
      if (issue) issues.push(issue);
    }

    // Sort by reportedAt descending
    issues.sort((a: any, b: any) => (b.reportedAt || '').localeCompare(a.reportedAt || ''));
    res.json({ issues });
  } catch (error) {
    console.error('[vehicles/issues] Failed to read vehicle issues:', error);
    res.status(500).json({ error: 'Failed to load vehicle issues' });
  }
});

/**
 * GET /api/vehicles/get-issue?vehicleReg=XX00XXX&issueId=xxx
 * Fetch a single issue by vehicle reg + issue ID.
 */
router.get('/get-issue', async (req: AuthRequest, res: Response) => {
  try {
    const vehicleReg = (req.query.vehicleReg as string || '').toUpperCase();
    const issueId = req.query.issueId as string;
    if (!vehicleReg || !issueId) {
      res.status(400).json({ error: 'vehicleReg and issueId are required' });
      return;
    }

    const issue = await readR2Json(`issues/${vehicleReg}/${issueId}.json`);
    if (!issue) {
      res.status(404).json({ error: 'Issue not found' });
      return;
    }
    res.json({ issue });
  } catch (error) {
    console.error('[vehicles/issues] Failed to read issue:', error);
    res.status(500).json({ error: 'Failed to load issue' });
  }
});

/**
 * POST /api/vehicles/save-issue
 * Save (create or update) an issue to R2.
 * Writes the full issue JSON and upserts the fleet-wide index.
 */
router.post('/save-issue', async (req: AuthRequest, res: Response) => {
  try {
    const { issue } = req.body;
    if (!issue?.id || !issue?.vehicleReg) {
      res.status(400).json({ error: 'issue with id and vehicleReg is required' });
      return;
    }

    const reg = (issue.vehicleReg as string).toUpperCase();

    // Write full issue JSON
    await writeR2Json(`issues/${reg}/${issue.id}.json`, issue);

    // Update fleet-wide index
    const indexData = await readR2Json<{ issues: any[] }>('issues/_index.json') || { issues: [] };
    const indexEntry = {
      id: issue.id,
      vehicleReg: reg,
      vehicleId: issue.vehicleId || '',
      category: issue.category,
      component: issue.component,
      severity: issue.severity,
      summary: issue.summary,
      status: issue.status,
      reportedAt: issue.reportedAt,
      resolvedAt: issue.resolvedAt || null,
      lastActivityAt: issue.activity?.length
        ? issue.activity[issue.activity.length - 1].timestamp
        : issue.reportedAt,
    };

    const idx = indexData.issues.findIndex((e: any) => e.id === issue.id);
    if (idx >= 0) {
      indexData.issues[idx] = indexEntry;
    } else {
      indexData.issues.push(indexEntry);
    }

    await writeR2Json('issues/_index.json', indexData);
    res.json({ success: true });
  } catch (error) {
    console.error('[vehicles/issues] Failed to save issue:', error);
    res.status(500).json({ error: 'Failed to save issue' });
  }
});

// ── Allocations ──

/**
 * GET /api/vehicles/get-allocations
 * Fetch all active allocations from R2.
 */
router.get('/get-allocations', async (_req: AuthRequest, res: Response) => {
  try {
    const data = await readR2Json<{ allocations: unknown[] }>('allocations/_index.json');
    res.json({ allocations: data?.allocations || [] });
  } catch (error) {
    console.error('[vehicles/allocations] Failed to read allocations:', error);
    res.status(500).json({ error: 'Failed to load allocations' });
  }
});

/**
 * POST /api/vehicles/save-allocations
 * Save the full allocations array to R2 (replaces existing).
 */
router.post('/save-allocations', async (req: AuthRequest, res: Response) => {
  try {
    const { allocations } = req.body;
    await writeR2Json('allocations/_index.json', { allocations: allocations || [], updatedAt: new Date().toISOString() });
    res.json({ success: true });
  } catch (error) {
    console.error('[vehicles/allocations] Failed to save allocations:', error);
    res.status(500).json({ error: 'Failed to save allocations' });
  }
});

// ── Stock ──

/**
 * GET /api/vehicles/get-stock
 * Fetch all stock items and recent transactions from R2.
 */
router.get('/get-stock', async (_req: AuthRequest, res: Response) => {
  try {
    const data = await readR2Json<{ items: unknown[]; transactions: unknown[] }>('stock/data.json');
    res.json({ items: data?.items || [], transactions: data?.transactions || [] });
  } catch (error) {
    console.error('[vehicles/stock] Failed to read stock:', error);
    res.status(500).json({ error: 'Failed to load stock' });
  }
});

/**
 * POST /api/vehicles/save-stock
 * Save the full stock state (items + transactions).
 */
router.post('/save-stock', async (req: AuthRequest, res: Response) => {
  try {
    const { items, transactions } = req.body;
    await writeR2Json('stock/data.json', { items: items || [], transactions: transactions || [], updatedAt: new Date().toISOString() });
    res.json({ success: true });
  } catch (error) {
    console.error('[vehicles/stock] Failed to save stock:', error);
    res.status(500).json({ error: 'Failed to save stock' });
  }
});

/**
 * POST /api/vehicles/record-stock-transaction
 * Record one or more stock transactions.
 * Reads current stock, applies transaction(s), writes back.
 */
router.post('/record-stock-transaction', async (req: AuthRequest, res: Response) => {
  try {
    const { transaction, transactions: batchTransactions } = req.body;
    const txns = batchTransactions || (transaction ? [transaction] : []);

    if (txns.length === 0) {
      res.status(400).json({ error: 'transaction(s) required' });
      return;
    }

    // Read current stock
    const data = await readR2Json<{ items: any[]; transactions: any[] }>('stock/data.json') || { items: [], transactions: [] };

    // Apply each transaction
    for (const txn of txns) {
      data.transactions.push(txn);

      // Update item quantity
      const item = data.items.find((i: any) => i.id === txn.itemId);
      if (item) {
        if (txn.type === 'consumed' || txn.type === 'adjustment_down') {
          item.currentStock = Math.max(0, (item.currentStock || 0) - (txn.quantity || 0));
        } else if (txn.type === 'received' || txn.type === 'adjustment_up') {
          item.currentStock = (item.currentStock || 0) + (txn.quantity || 0);
        }
        item.updatedAt = new Date().toISOString();
      }
    }

    data.transactions = data.transactions || [];
    await writeR2Json('stock/data.json', { ...data, updatedAt: new Date().toISOString() });
    res.json({ success: true, processed: txns.length });
  } catch (error) {
    console.error('[vehicles/stock] Failed to record transaction:', error);
    res.status(500).json({ error: 'Failed to record stock transaction' });
  }
});

// ── Vehicle Events ──

/**
 * GET /api/vehicles/check-in-eligibility?vehicleReg=<reg>
 *
 * DB-backed gate for the check-in flow. Replaces the old R2 event-history
 * comparison, which was fooled by same-day book-out + check-in pairs once
 * `eventDate` got stored as a date-only string.
 *
 * Source of truth: `vehicle_hire_assignments.status`. If any active row
 * for this vehicle is `booked_out` (or legacy `active`), the van is
 * currently out and can be checked in. Otherwise we block with a reason.
 */
router.get('/check-in-eligibility', async (req: AuthRequest, res: Response) => {
  try {
    const vehicleReg = typeof req.query.vehicleReg === 'string' ? req.query.vehicleReg.trim().toUpperCase() : '';
    if (!vehicleReg) {
      res.status(400).json({ error: 'vehicleReg is required' });
      return;
    }

    const result = await query(
      `SELECT vha.id, vha.status, vha.checked_in_at, vha.booked_out_at,
              vha.status_changed_at, vha.hirehop_job_id, vha.updated_at
       FROM vehicle_hire_assignments vha
       JOIN fleet_vehicles fv ON fv.id = vha.vehicle_id
       WHERE fv.reg = $1
         AND vha.status IN ('booked_out', 'active', 'returned')
       -- A live (booked_out/active) row ALWAYS wins over a returned one,
       -- regardless of updated_at. Otherwise a stale returned row whose
       -- updated_at gets bumped by a background pass (sync / fleet-status /
       -- dedup) after a fresh book-out masks the live rows and the van
       -- wrongly reads as "already checked in" (RX24SZG, jobs 15429→15781,
       -- 27 May 2026). Only fall back to a returned row when none are live.
       ORDER BY
         CASE WHEN vha.status IN ('booked_out', 'active') THEN 0 ELSE 1 END,
         vha.updated_at DESC
       LIMIT 1`,
      [vehicleReg]
    );

    if (result.rows.length === 0) {
      res.json({
        eligible: false,
        reason: 'never_booked_out',
        checkInDate: null,
        assignmentId: null,
        hirehopJob: null,
      });
      return;
    }

    const row = result.rows[0];
    if (row.status === 'booked_out' || row.status === 'active') {
      res.json({
        eligible: true,
        reason: null,
        checkInDate: null,
        assignmentId: row.id,
        hirehopJob: row.hirehop_job_id,
      });
      return;
    }

    // status === 'returned'
    const checkInDate = row.checked_in_at
      ? new Date(row.checked_in_at).toISOString().slice(0, 10)
      : null;
    res.json({
      eligible: false,
      reason: 'already_checked_in',
      checkInDate,
      assignmentId: row.id,
      hirehopJob: row.hirehop_job_id,
    });
  } catch (err) {
    console.error('[vehicles/check-in-eligibility] Error:', err);
    res.status(500).json({ error: 'Failed to determine check-in eligibility' });
  }
});

/**
 * POST /api/vehicles/save-event
 * Save a vehicle event to R2.
 * Writes event JSON + updates per-vehicle index.
 */
router.post('/save-event', async (req: FlexibleVehicleRequest, res: Response) => {
  try {
    const { event } = req.body;
    if (!event?.id || !event?.vehicleReg) {
      res.status(400).json({ error: 'event with id and vehicleReg is required' });
      return;
    }

    const reg = (event.vehicleReg as string).toUpperCase();

    // Freelancer: event MUST target their assignment. Allow only book-out
    // events (check-in is a separate future flow and isn't enabled yet).
    if (isFreelancerBookout(req)) {
      const scope = await getBookoutScope(req);
      if (!scope) {
        res.status(403).json({ error: 'Assignment not found' });
        return;
      }
      if (reg !== scope.registration) {
        res.status(403).json({ error: 'Event does not target your vehicle' });
        return;
      }
      const askedJob = event.hireHopJob != null ? parseInt(String(event.hireHopJob), 10) : null;
      if (scope.hhJobNumber != null && askedJob !== scope.hhJobNumber) {
        res.status(403).json({ error: 'Event does not target your job' });
        return;
      }
      const et = String(event.eventType || '').toLowerCase();
      if (et !== 'book-out' && et !== 'book out' && et !== 'bookout') {
        res.status(403).json({ error: 'Only book-out events allowed for freelancer session' });
        return;
      }
    }

    // If the caller included a signature as base64, persist it alongside
    // the event as a separate R2 object and strip it from the JSON blob
    // (signatures are ~10-50KB base64 — fine for R2 but bloats the event
    // JSON which is read frequently for the events index). The key pattern
    // matches what /events/:eventId/regenerate-pdf looks for by default.
    if (event.signatureBase64 && typeof event.signatureBase64 === 'string') {
      try {
        const sigBase64 = event.signatureBase64.includes(',')
          ? event.signatureBase64.split(',')[1]
          : event.signatureBase64;
        if (sigBase64) {
          const sigBuffer = Buffer.from(sigBase64, 'base64');
          const sigKey = `vehicle-events/${reg}/${event.id}_signature.png`;
          await uploadToR2(sigKey, sigBuffer, 'image/png');
          event.signatureR2Key = sigKey;
        }
      } catch (err) {
        console.warn('[vehicles/events] Failed to persist signature:', err);
      }
      // Remove from the event JSON regardless of upload success —
      // don't leak the base64 into the stored JSON either way.
      delete event.signatureBase64;
    }

    // Write full event JSON (briefingItems, signatureR2Key, etc. flow through)
    await writeR2Json(`vehicle-events/${reg}/${event.id}.json`, event);

    // Update per-vehicle index
    const indexKey = `vehicle-events/${reg}/_index.json`;
    const indexData = await readR2Json<{ events: any[] }>(indexKey) || { events: [] };

    const indexEntry = {
      id: event.id,
      vehicleReg: reg,
      eventType: event.eventType,
      eventDate: event.eventDate,
      mileage: event.mileage ?? null,
      fuelLevel: event.fuelLevel ?? null,
      hireHopJob: event.hireHopJob ?? null,
      hireStatus: event.hireStatus ?? null,
      createdAt: event.createdAt || new Date().toISOString(),
    };

    const idx = indexData.events.findIndex((e: any) => e.id === event.id);
    if (idx >= 0) {
      indexData.events[idx] = indexEntry;
    } else {
      indexData.events.push(indexEntry);
    }

    await writeR2Json(indexKey, indexData);

    // If hire status change included, update fleet_vehicles table
    if (event.hireStatus) {
      await query(
        'UPDATE fleet_vehicles SET hire_status = $1 WHERE reg = $2',
        [event.hireStatus, reg]
      ).catch(err => console.warn('[vehicles/events] Failed to update hire status:', err));
    }

    // Dual-write mileage to vehicle_mileage_log if present
    if (event.mileage && Number(event.mileage) > 0) {
      const mileageVal = Number(event.mileage);
      const eventType = event.eventType || 'event';
      try {
        // Look up vehicle ID from reg
        const vehicleResult = await query('SELECT id FROM fleet_vehicles WHERE reg = $1', [reg]);
        if (vehicleResult.rows.length > 0) {
          const vehicleId = vehicleResult.rows[0].id;
          const userId = req.user?.id || null;

          await query(
            `INSERT INTO vehicle_mileage_log (vehicle_id, mileage, source, source_ref, recorded_by)
             VALUES ($1, $2, $3, $4, $5)`,
            [vehicleId, mileageVal, eventType, event.id, userId]
          );
          // Update current mileage (only if higher)
          await query(
            `UPDATE fleet_vehicles SET current_mileage = $1, last_mileage_update = NOW()
             WHERE id = $2 AND (current_mileage IS NULL OR current_mileage < $1)`,
            [mileageVal, vehicleId]
          );
        }
      } catch (err) {
        console.warn('[vehicles/events] Failed to log mileage:', err);
      }
    }

    // Book-out side effects: when BookOutPage (staff or freelancer) fires
    // a book-out event, flip the matching allocated assignment to
    // 'booked_out'. This is equivalent to POST /api/assignments/:id/book-out
    // but keyed off the event payload (reg + hh job) since BookOutPage
    // doesn't know the assignment UUID directly.
    //
    // Two-pass match: first look for an assignment already linked to this
    // vehicle (the normal case). If none, fall back to a null-vehicle row
    // on this job — disambiguated by driver name when available — and
    // backfill vehicle_id at the same time as flipping status. The
    // fallback is the safety net for the Quick Assign → Book Out path
    // that previously left assignments orphaned with vehicle_id NULL
    // (28 Apr 2026 RX22SWU incident).
    const normalisedEventType = String(event.eventType || '').toLowerCase().replace(/[\s_]+/g, '-');
    if (normalisedEventType === 'book-out' && event.hireHopJob) {
      try {
        const hhJob = parseInt(String(event.hireHopJob), 10);
        if (!isNaN(hhJob)) {
          const mileageOut = event.mileage ? Number(event.mileage) : null;
          const fuelOut = event.fuelLevel || null;
          const eventDriverName = event.driverName ? String(event.driverName).trim() : null;
          // Prefer scoped assignment id when a freelancer session is
          // present — the safest targeting for the D&C case where a job
          // can have multiple allocations. Staff path falls back to the
          // reg+job match used before this change.
          let matchedIds: string[] = [];
          if (req.bookoutSession?.assignmentId) {
            matchedIds = [req.bookoutSession.assignmentId];
          } else {
            // Pass 1: rows already linked to this vehicle.
            const m = await query(
              `SELECT vha.id
                 FROM vehicle_hire_assignments vha
                 JOIN fleet_vehicles fv ON fv.id = vha.vehicle_id
                WHERE fv.reg = $1
                  AND vha.hirehop_job_id = $2
                  AND vha.status IN ('soft', 'confirmed')
                ORDER BY vha.created_at DESC`,
              [reg, hhJob]
            );
            matchedIds = m.rows.map(r => r.id as string);

            // Pass 2: null-vehicle fallback. Only runs if pass 1 found
            // nothing — we don't want to clobber a properly-linked match.
            if (matchedIds.length === 0) {
              if (eventDriverName) {
                // Name-disambiguated: safe even when the job has multiple
                // unlinked rows for different drivers.
                const fallback = await query(
                  `SELECT vha.id
                     FROM vehicle_hire_assignments vha
                     LEFT JOIN drivers d ON d.id = vha.driver_id
                    WHERE vha.hirehop_job_id = $1
                      AND vha.vehicle_id IS NULL
                      AND vha.status IN ('soft', 'confirmed')
                      AND d.full_name ILIKE $2
                    ORDER BY vha.created_at DESC`,
                  [hhJob, eventDriverName]
                );
                matchedIds = fallback.rows.map(r => r.id as string);
                if (matchedIds.length > 0) {
                  console.log(`[vehicles/events] book-out: null-vehicle fallback matched ${matchedIds.length} row(s) by driver name "${eventDriverName}" for ${reg} / HH#${hhJob} — backfilling vehicle_id`);
                }
              } else {
                // No driver name — only flip if there's exactly one
                // unlinked row. More than one is ambiguous; let it
                // surface as a warning rather than risk wrong-row update.
                const fallback = await query(
                  `SELECT vha.id
                     FROM vehicle_hire_assignments vha
                    WHERE vha.hirehop_job_id = $1
                      AND vha.vehicle_id IS NULL
                      AND vha.status IN ('soft', 'confirmed')
                    ORDER BY vha.created_at DESC`,
                  [hhJob]
                );
                if (fallback.rows.length === 1) {
                  matchedIds = [fallback.rows[0]!.id as string];
                  console.log(`[vehicles/events] book-out: null-vehicle fallback matched 1 unique unlinked row for HH#${hhJob} — backfilling vehicle_id ${reg}`);
                } else if (fallback.rows.length > 1) {
                  console.warn(`[vehicles/events] book-out: ${fallback.rows.length} ambiguous null-vehicle rows for HH#${hhJob} (no driver name to disambiguate) — skipping fallback`);
                }
              }
            }
          }
          const userId = req.user?.id || null;
          for (const id of matchedIds) {
            // COALESCE on vehicle_id backfills the link for fallback-matched
            // rows without disturbing rows that were already linked.
            await query(
              `UPDATE vehicle_hire_assignments
                  SET status = 'booked_out',
                      vehicle_id = COALESCE(vehicle_id, (SELECT id FROM fleet_vehicles WHERE reg = $5)),
                      status_changed_at = NOW(),
                      booked_out_at = COALESCE(booked_out_at, NOW()),
                      booked_out_by = COALESCE(booked_out_by, $1),
                      mileage_out = COALESCE(mileage_out, $2),
                      fuel_level_out = COALESCE(fuel_level_out, $3),
                      updated_at = NOW()
                WHERE id = $4`,
              [userId, mileageOut, fuelOut, id, reg]
            );
          }
          if (matchedIds.length === 0) {
            console.log(`[vehicles/events] book-out: no matching allocated assignment for ${reg} / HH#${hhJob} — no assignment state flip`);
          }
        }
      } catch (err) {
        console.warn('[vehicles/events] book-out side-effect failed:', err);
      }
    }

    // Check-in side effects: when CheckInPage.tsx fires a check-in event
    // via save-event, flip the matching hire assignment(s) to 'returned'.
    //
    // Normalise the eventType so both 'check-in' (hyphen, our convention)
    // and 'Check In' (space, capitalised — actually sent by CheckInPage)
    // both match. Original strict match silently failed for every live
    // check-in and was only caught in testing on 22 Apr 2026.
    if (normalisedEventType === 'check-in' && event.hireHopJob) {
      try {
        const hhJob = parseInt(String(event.hireHopJob), 10);
        if (!isNaN(hhJob)) {
          // Match any non-terminal out-of-warehouse status so a check-in
          // correctly closes the loop even on 'active' (mid-hire state)
          // assignments. 'confirmed' is NOT matched — that indicates
          // allocated-but-never-booked-out, which a check-in shouldn't
          // silently close (signals a staff error to investigate).
          //
          // Pass 1 looks for rows already linked to this vehicle. Pass 2
          // is the null-vehicle fallback: if a previous book-out left an
          // assignment orphaned (vehicle_id NULL but status=booked_out),
          // a check-in for the right hh_job will adopt and link it.
          // Mirrors the book-out side-effect's two-pass match.
          let matchedRows: Array<{ id: string }> = [];
          const matched = await query(
            `SELECT vha.id, vha.checked_in_at
             FROM vehicle_hire_assignments vha
             JOIN fleet_vehicles fv ON fv.id = vha.vehicle_id
             WHERE fv.reg = $1
               AND vha.hirehop_job_id = $2
               AND vha.status IN ('booked_out', 'active')
             ORDER BY vha.booked_out_at DESC NULLS LAST`,
            [reg, hhJob]
          );
          matchedRows = matched.rows.map(r => ({ id: r.id as string }));

          if (matchedRows.length === 0) {
            // CheckInPage doesn't send driverName in the event, so we
            // can only safely flip when there's exactly one unlinked
            // candidate. Multiple rows would be ambiguous — log it and
            // let staff fix manually.
            const fallback = await query(
              `SELECT vha.id
                 FROM vehicle_hire_assignments vha
                WHERE vha.hirehop_job_id = $1
                  AND vha.vehicle_id IS NULL
                  AND vha.status IN ('booked_out', 'active')
                ORDER BY vha.booked_out_at DESC NULLS LAST`,
              [hhJob]
            );
            if (fallback.rows.length === 1) {
              matchedRows = [{ id: fallback.rows[0]!.id as string }];
              console.log(`[vehicles/events] check-in: null-vehicle fallback matched 1 unique unlinked row for HH#${hhJob} — backfilling vehicle_id ${reg}`);
            } else if (fallback.rows.length > 1) {
              console.warn(`[vehicles/events] check-in: ${fallback.rows.length} ambiguous null-vehicle rows for HH#${hhJob} — skipping fallback (manual fix required)`);
            }
          }

          if (matchedRows.length > 0) {
            const userId = req.user?.id || null;
            const mileageIn = event.mileage ? Number(event.mileage) : null;
            const fuelIn = event.fuelLevel || null;
            const hasDamage = event.hasDamage === true;
            for (const row of matchedRows) {
              await query(
                `UPDATE vehicle_hire_assignments
                 SET status = 'returned',
                     vehicle_id = COALESCE(vehicle_id, (SELECT id FROM fleet_vehicles WHERE reg = $6)),
                     status_changed_at = NOW(),
                     checked_in_at = COALESCE(checked_in_at, NOW()),
                     checked_in_by = COALESCE(checked_in_by, $1),
                     mileage_in = COALESCE(mileage_in, $2),
                     fuel_level_in = COALESCE(fuel_level_in, $3),
                     has_damage = COALESCE(has_damage, $4),
                     updated_at = NOW()
                 WHERE id = $5`,
                [userId, mileageIn, fuelIn, hasDamage, row.id, reg]
              );
            }
          } else {
            console.log(`[vehicles/events] check-in: no matching booked_out assignment for ${reg} / HH#${hhJob} — no assignment state flip`);
          }

          // The van is back — cancel any stale van allocations on this
          // (vehicle, job) that never booked out. Driver-agnostic: once the
          // hire's returned, nothing un-booked-out on it is going anywhere.
          // This is the prevention for the 15 May 2026 HLU/15613 incident,
          // where the blocking orphan carried a driver_id and so slipped
          // past the book-out dedup's `driver_id IS NULL` guard.
          try {
            const vidRow = await query(`SELECT id FROM fleet_vehicles WHERE reg = $1`, [reg]);
            if (vidRow.rows.length > 0) {
              const { cancelStaleVanAllocationsOnReturn } = await import('../services/vha-dedup');
              const cancelled = await cancelStaleVanAllocationsOnReturn({
                vehicleId: vidRow.rows[0].id,
                hhJobNumber: hhJob,
              });
              if (cancelled > 0) {
                console.log(`[vehicles/events] check-in: cancelled ${cancelled} stale van allocation(s) for ${reg} / HH#${hhJob}`);
              }
            }
          } catch (err) {
            console.warn('[vehicles/events] check-in stale-allocation cleanup failed:', err);
          }
        }
      } catch (err) {
        console.warn('[vehicles/events] check-in side-effect failed:', err);
      }
    }

    // Soft check-in side effects: an INTERIM assessment of a van being taken
    // out of service mid-hire (vehicle swap) or handed over by a freelancer,
    // WITHOUT closing the hire. Unlike a full check-in this does NOT flip any
    // assignment status — the caller (the swap endpoint) owns the assignment
    // lifecycle. It only forces fleet hire_status to 'Not Ready' (a sticky
    // value), which the final reconcile below then preserves rather than
    // recomputing to 'On Hire' / 'Prep Needed'. No HH writeback, no close-out
    // requirements — the hire continues (on a replacement van for the swap
    // case). Mileage is logged generically above (the reading is real).
    if (normalisedEventType === 'soft-check-in') {
      try {
        await query(
          `UPDATE fleet_vehicles SET hire_status = 'Not Ready', updated_at = NOW() WHERE reg = $1`,
          [reg]
        );
        console.log(`[vehicles/events] soft check-in: ${reg} → Not Ready (interim — hire continues elsewhere, no assignment flip)`);
      } catch (err) {
        console.warn('[vehicles/events] soft check-in side-effect failed:', err);
      }
    }

    // Final reconcile — recompute fleet hire_status from current assignment
    // state. Runs AFTER the assignment status flips above, so the helper
    // observes the post-flip state. The earlier `event.hireStatus` direct
    // write (kept for prep-flow compatibility — prep events write 'Available'
    // and there's no assignment side-effect) is still respected: the helper's
    // "preserve current value" rule means 'Available' is preserved when no
    // active assignment exists. The helper's job is to override stale values,
    // not to clobber legitimate ones.
    try {
      const { syncFleetHireStatusByReg } = await import('../services/fleet-hire-status-sync');
      await syncFleetHireStatusByReg(reg);
    } catch (err) {
      console.warn('[vehicles/events] hire_status sync failed:', err);
    }

    res.json({ success: true, id: event.id });
  } catch (error) {
    console.error('[vehicles/events] Failed to save event:', error);
    res.status(500).json({ error: 'Failed to save event' });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// 5. PREP SESSIONS — native R2-backed endpoints
//    Replaces the legacy Netlify functions (save-prep, get-prep-history) that
//    proxied to https://ooosh-vehicles.netlify.app. The Netlify site was
//    retired without `VEHICLE_MODULE_URL` ever being set on the OP server,
//    so all prep saves were silently 404ing and prep history failed to load.
//
//    R2 layout:
//      prep-sessions/{REG}/{eventId}.json   — full session document
//      prep-sessions/{REG}/_index.json      — lightweight index for listing
//
//    The PrepHistoryTab extracts problems / notes from session sections, so
//    persisting full sessions also persists per-vehicle issue history (e.g.
//    "this door is a bit stiff") visible across future preps until resolved.
// ═══════════════════════════════════════════════════════════════════════════

/**
 * POST /api/vehicles/save-prep
 * Body: { vehicleReg, eventId, data }
 * Stores the full prep session JSON in R2 and updates the per-vehicle index.
 */
router.post('/save-prep', async (req: AuthRequest, res: Response) => {
  try {
    const { vehicleReg, eventId, data } = req.body;
    if (!vehicleReg || !eventId || !data) {
      res.status(400).json({ error: 'vehicleReg, eventId and data are required' });
      return;
    }

    const reg = (vehicleReg as string).toUpperCase();

    // Write full session document
    await writeR2Json(`prep-sessions/${reg}/${eventId}.json`, data);

    // Update per-vehicle index for cheap listing
    const indexKey = `prep-sessions/${reg}/_index.json`;
    const indexData = await readR2Json<{ sessions: any[] }>(indexKey) || { sessions: [] };

    const indexEntry = {
      eventId,
      vehicleReg: reg,
      preparedBy: data.preparedBy || null,
      mileage: data.mileage ?? null,
      fuelLevel: data.fuelLevel || null,
      date: data.date || new Date().toISOString().slice(0, 10),
      startedAt: data.startedAt || null,
      completedAt: data.completedAt || null,
      durationMinutes: data.durationMinutes ?? null,
      overallStatus: data.overallStatus || null,
    };

    const existingIdx = indexData.sessions.findIndex((s: any) => s.eventId === eventId);
    if (existingIdx >= 0) {
      indexData.sessions[existingIdx] = indexEntry;
    } else {
      indexData.sessions.push(indexEntry);
    }

    await writeR2Json(indexKey, indexData);

    // "Needs external wash" marker. A bodywork answer of "To be cleaned" sets
    // the flag (carwash to-do, NOT a Problems-register issue); "Washed and
    // clean" clears it. Any other answer (or no bodywork item) leaves the
    // current value untouched, so a prep that skips bodywork never wrongly
    // clears an existing flag.
    //
    // NOTE: these strings must match the Bodywork item's option labels in the
    // checklist settings (Settings → Checklists → Prep). If those labels are
    // renamed, update the matching here too.
    try {
      const sections: any[] = Array.isArray(data?.sections) ? data.sections : [];
      let bodyworkValue: string | null = null;
      for (const sec of sections) {
        const items: any[] = Array.isArray(sec?.items) ? sec.items : [];
        const bodywork = items.find(
          (it) => typeof it?.name === 'string' && it.name.toLowerCase().includes('bodywork'),
        );
        if (bodywork && typeof bodywork.value === 'string') {
          bodyworkValue = bodywork.value;
          break;
        }
      }
      if (bodyworkValue != null) {
        const v = bodyworkValue.trim().toLowerCase();
        let washUpdate: boolean | null = null;
        if (v === 'to be cleaned' || v === 'needs external wash' || v === 'needs wash') {
          washUpdate = true;
        } else if (v === 'washed and clean') {
          washUpdate = false;
        }
        if (washUpdate !== null) {
          await query(
            'UPDATE fleet_vehicles SET needs_external_wash = $1 WHERE reg = $2',
            [washUpdate, reg],
          );
        }
      }
    } catch (err) {
      console.warn('[vehicles/prep] Failed to update needs_external_wash:', err);
    }

    // Low tyre tread alert. The prep checklist is where the change decision is
    // made, so the vehicle manager is bell+emailed at prep (NOT book-out — too
    // late to plan a swap by then) whenever any tyre is at/below the amber
    // threshold. ONE email per prep listing all the low corners. Non-blocking.
    try {
      await notifyLowTreadAtPrep(reg, data);
    } catch (err) {
      console.warn('[vehicles/prep] Low-tread notify failed:', err);
    }

    res.json({ success: true, eventId });
  } catch (error) {
    console.error('[vehicles/prep] save-prep error:', error);
    res.status(500).json({ error: 'Failed to save prep session' });
  }
});

/**
 * Scan a saved prep session for low tyre tread and, if any corner is at/below
 * the amber threshold, fire ONE alert (bell to the vehicle manager + email to
 * info@/will@) listing all the low corners. Best-effort — never throws to the
 * caller.
 */
async function notifyLowTreadAtPrep(reg: string, data: any): Promise<void> {
  const thresholdRaw = await getSystemSetting('tyre_tread_amber_threshold');
  const threshold = (() => {
    const n = parseFloat(thresholdRaw || '');
    return Number.isFinite(n) && n > 0 ? n : DEFAULT_TYRE_TREAD_AMBER_MM;
  })();

  const sections: any[] = Array.isArray(data?.sections) ? data.sections : [];
  const low: { corner: string; depth: number }[] = [];
  for (const sec of sections) {
    const items: any[] = Array.isArray(sec?.items) ? sec.items : [];
    for (const it of items) {
      if (it?.unit !== 'mm') continue;
      const depth = parseFloat(it?.value);
      if (!Number.isFinite(depth) || depth <= 0) continue;
      if (depth <= threshold) {
        // "Front left tyre tread depth" → "Front left"
        const corner = String(it?.name || '')
          .replace(/\s*tyre tread depth\s*/i, '')
          .trim() || String(it?.name || '');
        low.push({ corner, depth });
      }
    }
  }

  if (low.length === 0) return;

  const lowTyres = low.map(l => `${l.corner} (${l.depth}mm)`).join(', ');
  const frontendUrl = process.env.FRONTEND_URL || 'https://staff.oooshtours.co.uk';
  const vehicleId = data?.vehicleId || null;
  const vehicleUrl = vehicleId
    ? `${frontendUrl}/vehicles/fleet/${vehicleId}`
    : `${frontendUrl}/vehicles`;

  const { getVehicleNotificationTargets } = await import('../services/vehicle-notify');
  const targets = await getVehicleNotificationTargets();

  try {
    await emailService.send('low_tread_alert', {
      to: targets.to,
      cc: targets.cc,
      variables: {
        vehicleReg: reg,
        preparedBy: data?.preparedBy || 'staff',
        amberThreshold: String(threshold),
        lowTyres,
        mileage: data?.mileage != null ? String(data.mileage) : 'not recorded',
        vehicleUrl,
      },
    });
  } catch (emailErr) {
    console.warn('[vehicles/prep] Low-tread email failed:', (emailErr as Error).message);
  }

  // Bell for the vehicle manager. email_sent_at set so the escalation
  // scheduler doesn't fire a duplicate. Best-effort per recipient.
  for (const userId of targets.bellUserIds) {
    try {
      await query(
        `INSERT INTO notifications (user_id, type, title, content, entity_type, entity_id, priority, action_url, email_sent_at)
         VALUES ($1, 'compliance', $2, $3, 'fleet_vehicles', $4, 'normal', $5, NOW())`,
        [
          userId,
          `Low tyre tread — ${reg}`,
          `Prepped by ${data?.preparedBy || 'staff'}. Low: ${lowTyres}`,
          vehicleId,
          vehicleId ? `/vehicles/fleet/${vehicleId}` : '/vehicles',
        ],
      );
    } catch (bellErr) {
      console.warn('[vehicles/prep] Low-tread bell failed:', (bellErr as Error).message);
    }
  }
}

/**
 * GET /api/vehicles/get-prep-history?vehicleReg=XXX&limit=10
 * Returns the most recent N prep sessions for a vehicle.
 */
router.get('/get-prep-history', async (req: AuthRequest, res: Response) => {
  try {
    const vehicleReg = req.query.vehicleReg as string | undefined;
    const limit = parseInt((req.query.limit as string) || '10', 10);

    if (!vehicleReg) {
      res.status(400).json({ error: 'vehicleReg is required' });
      return;
    }

    const reg = vehicleReg.toUpperCase();
    const indexKey = `prep-sessions/${reg}/_index.json`;
    const indexData = await readR2Json<{ sessions: any[] }>(indexKey);

    if (!indexData || !Array.isArray(indexData.sessions)) {
      res.json({ sessions: [], total: 0 });
      return;
    }

    // Sort newest first
    const sorted = [...indexData.sessions].sort((a: any, b: any) => {
      const aT = (a.completedAt || a.startedAt || a.date || '');
      const bT = (b.completedAt || b.startedAt || b.date || '');
      return bT.localeCompare(aT);
    });

    const total = sorted.length;
    const slice = sorted.slice(0, Math.max(1, Math.min(limit, 100)));

    // Hydrate each from the full session document so the tab can render
    // tyre values, problems, etc.
    const sessions: any[] = [];
    for (const entry of slice) {
      const full = await readR2Json<any>(`prep-sessions/${reg}/${entry.eventId}.json`);
      if (full) {
        sessions.push(full);
      } else {
        // Index claims a session exists but the document is missing.
        // Return the index entry so at least the date / preparer shows.
        sessions.push({ ...entry, sections: [] });
      }
    }

    res.json({ sessions, total });
  } catch (error) {
    console.error('[vehicles/prep] get-prep-history error:', error);
    res.status(500).json({ error: 'Failed to load prep history' });
  }
});

/**
 * GET /api/vehicles/get-recent-events?limit=10
 * Fetch recent events across all vehicles.
 * Scans per-vehicle indexes and returns the most recent N events.
 */
router.get('/get-recent-events', async (req: AuthRequest, res: Response) => {
  try {
    const limit = parseInt(req.query.limit as string) || 10;

    // List all vehicle event index files
    const objects = await listR2Objects('vehicle-events/');
    const indexKeys = (objects || [])
      .filter(obj => obj.Key?.endsWith('/_index.json'))
      .map(obj => obj.Key!);

    const allEvents: any[] = [];
    for (const key of indexKeys) {
      const indexData = await readR2Json<{ events: any[] }>(key);
      if (indexData?.events) {
        allEvents.push(...indexData.events);
      }
    }

    // Sort by createdAt descending, take limit
    allEvents.sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
    res.json({ events: allEvents.slice(0, limit) });
  } catch (error) {
    console.error('[vehicles/events] Failed to read recent events:', error);
    res.status(500).json({ error: 'Failed to load recent events' });
  }
});

// ── Tracker Assignments ──

/**
 * GET /api/vehicles/get-tracker-assignments
 * Fetch tracker-to-vehicle assignment map from R2.
 */
router.get('/get-tracker-assignments', async (_req: AuthRequest, res: Response) => {
  try {
    const data = await readR2Json<{ assignments: Record<string, string> }>('trackers/assignments.json');
    res.json({ assignments: data?.assignments || {} });
  } catch (error) {
    console.error('[vehicles/trackers] Failed to read assignments:', error);
    res.status(500).json({ error: 'Failed to load tracker assignments' });
  }
});

/**
 * POST /api/vehicles/save-tracker-assignments
 * Save the full tracker assignments map to R2 (replaces existing).
 */
router.post('/save-tracker-assignments', async (req: AuthRequest, res: Response) => {
  try {
    const { assignments } = req.body;
    await writeR2Json('trackers/assignments.json', {
      assignments: assignments || {},
      updatedAt: new Date().toISOString(),
    });
    res.json({ success: true });
  } catch (error) {
    console.error('[vehicles/trackers] Failed to save assignments:', error);
    res.status(500).json({ error: 'Failed to save tracker assignments' });
  }
});

// ── Per-Vehicle Events Query ──

/**
 * GET /api/vehicles/get-events?vehicleReg=XX00XXX&eventType=Book+Out&eventId=xxx
 * Fetch events for a specific vehicle from R2 index.
 * If eventId is provided, returns the full event detail.
 */
router.get('/get-events', async (req: FlexibleVehicleRequest & AuthRequest, res: Response) => {
  try {
    const vehicleReg = (req.query.vehicleReg as string || '').toUpperCase();
    const eventType = req.query.eventType as string | undefined;
    const eventId = req.query.eventId as string | undefined;

    if (!vehicleReg) {
      res.status(400).json({ error: 'vehicleReg is required' });
      return;
    }

    // Freelancer scope: clamp to the session's allocated vehicle reg.
    // Stops a session being used to enumerate event history across the
    // fleet.
    if (isFreelancerBookout(req)) {
      const scope = await getBookoutScope(req);
      if (!scope) {
        res.status(403).json({ error: 'Assignment not found' });
        return;
      }
      if (scope.registration !== vehicleReg) {
        res.status(403).json({ error: 'Events are not for your vehicle' });
        return;
      }
    }

    // If eventId provided, return full event detail
    if (eventId) {
      const event = await readR2Json(`vehicle-events/${vehicleReg}/${eventId}.json`);
      res.json({ event: event || null });
      return;
    }

    // Otherwise return index, optionally filtered by event type
    const indexKey = `vehicle-events/${vehicleReg}/_index.json`;
    const indexData = await readR2Json<{ events: any[] }>(indexKey);
    let events = indexData?.events || [];

    if (eventType) {
      events = events.filter((e: any) => e.eventType === eventType);
    }

    // Sort by createdAt/eventDate descending
    events.sort((a: any, b: any) => (b.createdAt || b.eventDate || '').localeCompare(a.createdAt || a.eventDate || ''));

    // Enrich with opJobId so the Event History UI can deep-link straight
    // into the OP job detail page (alongside the HireHop link). Single
    // round-trip: collect distinct HH job numbers, resolve in one query.
    const hhNums = Array.from(
      new Set(
        events
          .map((e: any) => e.hireHopJob)
          .filter((n: any) => n != null && n !== '')
          .map((n: any) => parseInt(String(n), 10))
          .filter((n: number) => !isNaN(n))
      )
    );
    if (hhNums.length > 0) {
      try {
        const jobsRes = await query(
          'SELECT id, hh_job_number FROM jobs WHERE hh_job_number = ANY($1::int[]) AND is_deleted = false',
          [hhNums]
        );
        const hhToOp = new Map<number, string>();
        for (const row of jobsRes.rows) {
          hhToOp.set(Number(row.hh_job_number), row.id);
        }
        events = events.map((e: any) => {
          const hh = e.hireHopJob != null ? parseInt(String(e.hireHopJob), 10) : NaN;
          return {
            ...e,
            opJobId: !isNaN(hh) ? hhToOp.get(hh) || null : null,
          };
        });
      } catch (err) {
        // Don't fail the whole request if the lookup errors — just omit opJobId.
        console.warn('[vehicles/events] opJobId resolution failed:', err);
      }
    }

    res.json({ events });
  } catch (error) {
    console.error('[vehicles/events] Failed to query events:', error);
    res.status(500).json({ error: 'Failed to load events' });
  }
});

// ── Condition Report PDF Generation ──

/**
 * Build a condition-report PDF from structured data. Returns the raw bytes
 * + a filename. Shared by POST /generate-pdf (live book-out/check-in flow)
 * and POST /events/:eventId/regenerate-pdf (backfill / mis-fire rebuilds).
 */
async function buildConditionReportPdf(data: any): Promise<{ pdfBytes: Uint8Array; filename: string }> {
  // Ported from the standalone Vehicle Module's netlify/functions/generate-pdf.mts
  // (the template that produced the March 2026 PDFs with navy header + record
  // logo + clickable "View full size" links). jsPDF — NOT pdf-lib — because
  // jsPDF ships textWithLink() for clickable hyperlinks and draws its bullets
  // as filled rounded rectangles rather than Unicode chars, sidestepping the
  // WinAnsi "✓" crash that took down the pdf-lib version.
  //
  // Author's comment from the original: "ASCII-safe text (jsPDF Helvetica
  // only supports standard Latin)". Upstream callers are expected to keep
  // briefing/notes text in the WinAnsi range — no em-dashes or curly quotes.
  const jspdfModule = await import('jspdf');
  const JsPDF = (jspdfModule as any).jsPDF
    ?? (jspdfModule as any).default?.jsPDF
    ?? (jspdfModule as any).default;
  if (!JsPDF) throw new Error('jsPDF constructor not found in module exports');

  const pdf: any = new JsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });
  const pageWidth = 210;
  const margin = 15;
  const contentWidth = pageWidth - margin * 2;
  let y = margin;

  // -- Helpers --
  const addText = (
    text: string,
    x: number,
    yPos: number,
    opts?: { size?: number; bold?: boolean; color?: [number, number, number]; align?: 'left' | 'center' | 'right' },
  ) => {
    pdf.setFontSize(opts?.size || 10);
    pdf.setFont('helvetica', opts?.bold ? 'bold' : 'normal');
    const c = opts?.color || [51, 51, 51];
    pdf.setTextColor(c[0], c[1], c[2]);
    const xPos = opts?.align === 'center' ? pageWidth / 2
      : opts?.align === 'right' ? pageWidth - margin : x;
    pdf.text(text, xPos, yPos, opts?.align ? { align: opts.align } : undefined);
  };

  const addLine = (yPos: number) => {
    pdf.setDrawColor(200, 200, 200);
    pdf.setLineWidth(0.3);
    pdf.line(margin, yPos, pageWidth - margin, yPos);
  };

  const addRow = (label: string, value: string, yPos: number) => {
    addText(label, margin, yPos, { size: 9, color: [120, 120, 120] });
    addText(value || '-', margin + 50, yPos, { size: 10, bold: true });
    return yPos + 6;
  };

  const checkNewPage = (needed: number) => {
    if (y + needed > 280) { pdf.addPage(); y = margin; }
  };

  // -- Header with logo --
  pdf.setFillColor(27, 42, 78);
  pdf.rect(0, 0, pageWidth, 38, 'F');

  const logoDataUri = await fetchLogoDataUri();
  if (logoDataUri) {
    try {
      pdf.addImage(logoDataUri, 'PNG', 12, 4, 30, 30);
    } catch (e) {
      console.warn('[vehicles/pdf] Logo embed failed:', e instanceof Error ? e.message : e);
    }
  }

  // Interim assessment = soft check-in (mid-hire swap / freelancer handover).
  // Takes precedence over isCheckIn for titling — it's neither a clean
  // book-out nor a final return.
  const isInterim = data.isInterim === true;
  const isCheckIn = data.isCheckIn === true;
  const reportTitle = isInterim
    ? 'INTERIM VEHICLE ASSESSMENT'
    : isCheckIn ? 'VEHICLE CHECK-IN REPORT' : 'VEHICLE CONDITION REPORT';
  const reportSubtitle = isInterim
    ? 'Mid-Hire Assessment Record'
    : isCheckIn ? 'Return Record' : 'Book-Out Record';

  addText(reportTitle, 0, 15, { size: 18, bold: true, color: [255, 255, 255], align: 'center' });
  addText(reportSubtitle, 0, 23, { size: 11, color: [180, 190, 210], align: 'center' });

  const timestamp = formatFullDateTime(data.eventDateTime || data.eventDate);
  addText(timestamp, 0, 31, { size: 8, color: [140, 150, 170], align: 'center' });

  y = 48;

  // Interim context banner — explains why there's no signature and that the
  // hire is still live.
  if (isInterim) {
    pdf.setFillColor(255, 251, 235);
    pdf.setDrawColor(253, 230, 138);
    pdf.roundedRect(margin, y, contentWidth, 18, 2, 2, 'FD');
    addText('Interim assessment captured during a mid-hire vehicle change.', margin + 4, y + 6.5, {
      size: 9, bold: true, color: [146, 64, 14],
    });
    addText('The hire is continuing on a replacement vehicle. A full check-in will follow when this vehicle returns to base.', margin + 4, y + 12, {
      size: 7.5, color: [146, 64, 14],
    });
    y += 24;
  }

  // -- Vehicle Details --
  addText('VEHICLE DETAILS', margin, y, { size: 11, bold: true, color: [27, 42, 78] });
  y += 3; addLine(y); y += 6;

  y = addRow('Registration', data.vehicleReg, y);
  y = addRow('Type', data.vehicleType || '-', y);
  if (data.vehicleMake) y = addRow('Make', data.vehicleMake, y);
  if (data.vehicleModel) y = addRow('Model', data.vehicleModel, y);
  if (data.vehicleColour) y = addRow('Colour', data.vehicleColour, y);
  y += 4;

  // -- Hire Details --
  addText('HIRE DETAILS', margin, y, { size: 11, bold: true, color: [27, 42, 78] });
  y += 3; addLine(y); y += 6;

  y = addRow('Driver', data.driverName, y);
  if (data.clientEmail) y = addRow('Email', data.clientEmail, y);
  if (data.hireHopJob) y = addRow('HireHop Job', '#' + data.hireHopJob, y);
  y = addRow('Date/Time', timestamp, y);

  // Hire Start / End — render date + time on a single line. Time is
  // optional (some legacy data has dates only). The hire START time is
  // the book-out wall time — it's literally when the hire began, even
  // if that's later than the job's planned out_time. End time falls
  // back to jobs.end_time (the real end of charge).
  const fmtDateTime = (dateStr: string | undefined, timeStr: string | undefined): string => {
    if (!dateStr) return '- (pending hire form)';
    const d = formatDayDate(dateStr);
    return timeStr ? `${d} ${timeStr}` : d;
  };
  y = addRow('Hire Start', fmtDateTime(data.hireStartDate, data.hireStartTime), y);
  y = addRow('Hire End',   fmtDateTime(data.hireEndDate,   data.hireEndTime),   y);

  // Operator audit row — who actually carried out the book-out / check-in.
  // Set server-side from req.user (staff JOIN people) or the freelancer
  // bookout session (people lookup by personId), so it can't be spoofed
  // from the client payload.
  if (data.performedByName) {
    const opLabel = isCheckIn ? 'Checked In By' : 'Booked Out By';
    y = addRow(opLabel, data.performedByName, y);
  }

  if (data.allDrivers && data.allDrivers.length > 0) {
    const driversText = data.allDrivers.join(', ');
    const maxValueWidth = contentWidth - 50;
    const driversLines = pdf.splitTextToSize(driversText, maxValueWidth) as string[];
    if (driversLines.length <= 1) {
      y = addRow('All Drivers', driversText, y);
    } else {
      addText('All Drivers', margin, y, { size: 9, color: [120, 120, 120] });
      for (const line of driversLines) {
        addText(line, margin + 50, y, { size: 10, bold: true });
        y += 5;
      }
      y += 1;
    }
  }
  y += 4;

  // -- Vehicle State --
  if (isCheckIn) {
    addText('VEHICLE STATE COMPARISON', margin, y, { size: 11, bold: true, color: [27, 42, 78] });
    y += 3; addLine(y); y += 6;

    const boMileageStr = data.bookOutMileage != null ? data.bookOutMileage.toLocaleString() + ' miles' : '-';
    const boFuelStr = data.bookOutFuelLevel || '-';
    const boDateStr = data.bookOutDate ? formatDayDate(data.bookOutDate) : '-';
    y = addRow('Book-Out Date', boDateStr, y);
    y = addRow('Book-Out Mileage', boMileageStr, y);
    y = addRow('Book-Out Fuel', boFuelStr, y);
    y += 2; addLine(y); y += 4;

    const currentMileageStr = data.mileage != null ? data.mileage.toLocaleString() + ' miles' : '-';
    y = addRow('Check-In Mileage', currentMileageStr, y);
    y = addRow('Check-In Fuel', data.fuelLevel || '-', y);

    if (data.bookOutMileage != null && data.mileage != null) {
      const milesDiff = data.mileage - data.bookOutMileage;
      y = addRow('Miles Driven', milesDiff.toLocaleString() + ' miles', y);
    }
    if (data.bookOutFuelLevel && data.fuelLevel && data.bookOutFuelLevel !== data.fuelLevel) {
      y = addRow('Fuel Change', `${data.bookOutFuelLevel} -> ${data.fuelLevel}`, y);
    }
    y += 4;

    const damages = data.damageItems || [];
    if (damages.length > 0) {
      checkNewPage(10 + damages.length * 12);
      addText('DAMAGE REPORT', margin, y, { size: 11, bold: true, color: [27, 42, 78] });
      y += 3; addLine(y); y += 6;

      for (let di = 0; di < damages.length; di++) {
        const dmg = damages[di];
        checkNewPage(18);

        const sevColor: [number, number, number] =
          dmg.severity === 'Critical' ? [220, 38, 38] :
          dmg.severity === 'Major' ? [234, 88, 12] :
          [202, 138, 4];

        addText(`${di + 1}. ${dmg.location}`, margin, y, { size: 10, bold: true });

        pdf.setFontSize(8);
        pdf.setTextColor(sevColor[0], sevColor[1], sevColor[2]);
        pdf.text(dmg.severity, margin + 80, y);
        y += 5;

        const descLines = pdf.splitTextToSize(dmg.description, contentWidth - 10) as string[];
        pdf.setFontSize(9);
        pdf.setTextColor(80, 80, 80);
        for (const line of descLines) {
          checkNewPage(5);
          pdf.text(line, margin + 4, y);
          y += 4;
        }

        const dmgPhotos = dmg.photos || [];
        if (dmgPhotos.length > 0) {
          y += 2;
          const thumbW = 30;
          const thumbH = 22;
          checkNewPage(thumbH + 6);
          let thumbX = margin + 4;
          for (let pi = 0; pi < dmgPhotos.length && pi < 5; pi++) {
            const dp = dmgPhotos[pi];
            try {
              if (dp.base64) {
                const dpProps = pdf.getImageProperties(dp.base64);
                const dpRatio = (dpProps.width || 4) / (dpProps.height || 3);
                let tw = thumbW;
                let th = tw / dpRatio;
                if (th > thumbH) { th = thumbH; tw = th * dpRatio; }
                pdf.addImage(dp.base64, 'JPEG', thumbX, y, tw, th, undefined, 'FAST');
              }
            } catch {
              pdf.setDrawColor(200, 200, 200);
              pdf.setFillColor(245, 245, 245);
              pdf.roundedRect(thumbX, y, thumbW, thumbH, 1, 1, 'FD');
            }
            thumbX += thumbW + 3;
          }
          y += thumbH + 2;
        }
        y += 4;
      }
    } else {
      addText('NO DAMAGE REPORTED', margin, y, { size: 11, bold: true, color: [27, 42, 78] });
      y += 3; addLine(y); y += 6;
      addText('No new damage was identified during the check-in inspection.', margin, y, {
        size: 9, color: [80, 80, 80],
      });
      y += 8;
    }
  } else {
    addText('VEHICLE STATE AT BOOK-OUT', margin, y, { size: 11, bold: true, color: [27, 42, 78] });
    y += 3; addLine(y); y += 6;

    const mileageStr = data.mileage != null ? data.mileage.toLocaleString() + ' miles' : '-';
    y = addRow('Mileage', mileageStr, y);
    y = addRow('Fuel Level', data.fuelLevel || '-', y);
    y += 4;
  }

  // -- Briefing Checklist --
  const items = data.briefingItems || [];
  if (items.length > 0) {
    checkNewPage(10 + items.length * 5);
    addText('CLIENT BRIEFING COMPLETED', margin, y, { size: 11, bold: true, color: [27, 42, 78] });
    y += 3; addLine(y); y += 6;

    for (const item of items) {
      // Green filled square instead of a ✓ char — avoids any WinAnsi encoding issue
      pdf.setFillColor(34, 197, 94);
      pdf.roundedRect(margin, y - 3, 3, 3, 0.5, 0.5, 'F');
      addText(String(item), margin + 6, y, { size: 9 });
      y += 5;
    }
    y += 4;
  }

  // -- Book-Out Notes --
  if (data.bookOutNotes) {
    checkNewPage(20);
    addText('NOTES', margin, y, { size: 11, bold: true, color: [27, 42, 78] });
    y += 3; addLine(y); y += 6;

    const noteLines = pdf.splitTextToSize(String(data.bookOutNotes), pageWidth - margin * 2) as string[];
    for (const line of noteLines) {
      checkNewPage(6);
      addText(line, margin, y, { size: 9 });
      y += 5;
    }
    y += 4;
  }

  // -- Condition Photos --
  checkNewPage(20);
  const photosTitle = isCheckIn ? 'CHECK-IN PHOTOS' : 'CONDITION PHOTOS';
  addText(photosTitle, margin, y, { size: 11, bold: true, color: [27, 42, 78] });
  y += 3; addLine(y); y += 6;

  const photos = data.photos || [];
  if (photos.length > 0) {
    const colWidth = contentWidth / 2 - 2;
    const maxPhotoH = 55;

    const getImageDims = (base64: string): { w: number; h: number } => {
      try {
        const props = pdf.getImageProperties(base64);
        return { w: props.width || 4, h: props.height || 3 };
      } catch {
        return { w: 4, h: 3 };
      }
    };

    const fitImage = (imgW: number, imgH: number, maxW: number, maxH: number) => {
      const ratio = imgW / imgH;
      let w = maxW;
      let h = w / ratio;
      if (h > maxH) { h = maxH; w = h * ratio; }
      return { w, h };
    };

    for (let i = 0; i < photos.length; i += 2) {
      const leftDims = getImageDims(photos[i].base64);
      const leftFit = fitImage(leftDims.w, leftDims.h, colWidth, maxPhotoH);
      let rowH = leftFit.h;
      let rightFit = { w: 0, h: 0 };

      if (i + 1 < photos.length) {
        const rightDims = getImageDims(photos[i + 1].base64);
        rightFit = fitImage(rightDims.w, rightDims.h, colWidth, maxPhotoH);
        rowH = Math.max(leftFit.h, rightFit.h);
      }

      checkNewPage(rowH + 12);

      const left = photos[i];
      const leftX = margin;
      try {
        if (left.base64) {
          pdf.addImage(left.base64, 'JPEG', leftX, y, leftFit.w, leftFit.h, undefined, 'FAST');
        }
      } catch {
        pdf.setDrawColor(200, 200, 200);
        pdf.setFillColor(245, 245, 245);
        pdf.roundedRect(leftX, y, colWidth, rowH, 2, 2, 'FD');
      }

      const rightX = margin + colWidth + 4;
      if (i + 1 < photos.length) {
        const right = photos[i + 1];
        try {
          if (right.base64) {
            pdf.addImage(right.base64, 'JPEG', rightX, y, rightFit.w, rightFit.h, undefined, 'FAST');
          }
        } catch {
          pdf.setDrawColor(200, 200, 200);
          pdf.setFillColor(245, 245, 245);
          pdf.roundedRect(rightX, y, colWidth, rowH, 2, 2, 'FD');
        }
      }

      const labelY = y + rowH + 4;

      addText(left.label, leftX, labelY, { size: 7, color: [120, 120, 120] });
      if (left.r2Url) {
        pdf.setFontSize(6);
        pdf.setTextColor(27, 42, 78);
        pdf.textWithLink('View full size', leftX, labelY + 4, { url: left.r2Url });
      }

      if (i + 1 < photos.length) {
        addText(photos[i + 1].label, rightX, labelY, { size: 7, color: [120, 120, 120] });
        if (photos[i + 1].r2Url) {
          pdf.setFontSize(6);
          pdf.setTextColor(27, 42, 78);
          pdf.textWithLink('View full size', rightX, labelY + 4, { url: photos[i + 1].r2Url });
        }
      }

      y += rowH + 12;
    }

    // Honest count: walk-around photos render here; damage photos
    // render in the Damage Report section above. When both exist, say
    // so explicitly rather than just printing the walk-around count
    // and silently dropping the damage figure on the floor.
    const damagePhotoCountWithBody = (data.damageItems || []).reduce(
      (sum: number, d: { photos?: unknown[] }) => sum + ((d.photos && d.photos.length) || 0),
      0,
    );
    if (damagePhotoCountWithBody > 0) {
      addText(
        `${photos.length} walk-around photo${photos.length === 1 ? '' : 's'} + `
          + `${damagePhotoCountWithBody} damage photo${damagePhotoCountWithBody === 1 ? '' : 's'} (see Damage Report above)`,
        margin,
        y,
        { size: 8, color: [120, 120, 120] },
      );
    } else {
      addText(photos.length + ' photos captured', margin, y, { size: 8, color: [120, 120, 120] });
    }
    y += 6;
  } else {
    // No walk-around photos. If damage photos exist, surface that —
    // "No photos captured" right under a section full of damage thumbs
    // (as in the 11 May 2026 screenshot) is misleading.
    const damagePhotoCountEmpty = (data.damageItems || []).reduce(
      (sum: number, d: { photos?: unknown[] }) => sum + ((d.photos && d.photos.length) || 0),
      0,
    );
    if (damagePhotoCountEmpty > 0) {
      addText(
        `No walk-around photos captured — `
          + `${damagePhotoCountEmpty} damage photo${damagePhotoCountEmpty === 1 ? '' : 's'} in the Damage Report above`,
        margin,
        y,
        { size: 9, color: [120, 120, 120] },
      );
    } else {
      addText('No photos captured', margin, y, { size: 9, color: [180, 180, 180] });
    }
    y += 6;
  }

  // -- Signature --
  checkNewPage(40);
  y += 4;
  addText('SIGNATURE', margin, y, { size: 11, bold: true, color: [27, 42, 78] });
  y += 3; addLine(y); y += 6;

  if (isInterim) {
    pdf.setFillColor(248, 250, 252);
    pdf.setDrawColor(203, 213, 225);
    pdf.roundedRect(margin, y, contentWidth, 18, 2, 2, 'FD');
    addText('No signature — interim assessment', margin + 4, y + 6.5, {
      size: 9, bold: true, color: [71, 85, 105],
    });
    addText('Captured during a mid-hire vehicle change; the driver/customer is not necessarily present.', margin + 4, y + 12, {
      size: 7.5, color: [71, 85, 105],
    });
    y += 22;
  } else if (isCheckIn && data.driverPresent === false) {
    pdf.setFillColor(255, 251, 235);
    pdf.setDrawColor(253, 230, 138);
    pdf.roundedRect(margin, y, contentWidth, 14, 2, 2, 'FD');
    addText('Driver was not present at check-in', margin + 4, y + 5.5, {
      size: 9, bold: true, color: [146, 64, 14],
    });
    addText('Vehicle was inspected without the driver in attendance.', margin + 4, y + 10.5, {
      size: 8, color: [146, 64, 14],
    });
    y += 18;
  } else if (data.signatureBase64) {
    try {
      const sigProps = pdf.getImageProperties(data.signatureBase64);
      const sigNatW = sigProps.width || 360;
      const sigNatH = sigProps.height || 140;
      const sigMaxW = 80;
      const sigRatio = sigNatW / sigNatH;
      const sigW = sigMaxW;
      const sigH = sigW / sigRatio;
      pdf.setDrawColor(200, 200, 200);
      pdf.roundedRect(margin, y, sigW + 4, sigH + 4, 2, 2, 'S');
      pdf.addImage(data.signatureBase64, 'PNG', margin + 2, y + 2, sigW, sigH);
      y += sigH + 8;
    } catch (sigErr) {
      console.warn('[vehicles/pdf] Signature embed failed:', sigErr instanceof Error ? sigErr.message : sigErr);
      pdf.setFillColor(250, 250, 250);
      pdf.roundedRect(margin, y, contentWidth, 20, 2, 2, 'FD');
      addText('Signature capture failed', pageWidth / 2, y + 10, {
        size: 9, color: [180, 180, 180], align: 'center',
      });
      y += 25;
    }
  } else if (data.signatureMissing) {
    pdf.setDrawColor(200, 200, 200);
    pdf.setFillColor(250, 250, 250);
    pdf.roundedRect(margin, y, contentWidth, 20, 2, 2, 'FD');
    addText('Signed in person at book-out (signature not retained on this record)', pageWidth / 2, y + 10, {
      size: 9, color: [120, 120, 120], align: 'center',
    });
    y += 25;
  } else {
    pdf.setDrawColor(200, 200, 200);
    pdf.setFillColor(250, 250, 250);
    pdf.roundedRect(margin, y, contentWidth, 20, 2, 2, 'FD');
    addText('No signature captured', pageWidth / 2, y + 10, {
      size: 9, color: [180, 180, 180], align: 'center',
    });
    y += 25;
  }

  addText('Driver: ' + (data.driverName || '-'), margin, y, { size: 9 });
  addText('Date: ' + timestamp, 0, y, { size: 9, align: 'right' });

  // -- Footer on every page --
  const pageCount = pdf.getNumberOfPages();
  for (let p = 1; p <= pageCount; p++) {
    pdf.setPage(p);
    pdf.setFontSize(7);
    pdf.setTextColor(160, 160, 160);
    const generated = new Date().toISOString().split('T')[0];
    const footerLabel = isInterim
      ? 'Interim Vehicle Assessment'
      : isCheckIn ? 'Vehicle Check-In Report' : 'Vehicle Condition Report';
    pdf.text(
      'Ooosh Tours Ltd - ' + footerLabel + ' - Generated ' + generated,
      pageWidth / 2, 292, { align: 'center' },
    );
    pdf.text('Page ' + p + ' of ' + pageCount, pageWidth - margin, 292, { align: 'right' });
  }

  const pdfArrayBuffer = pdf.output('arraybuffer') as ArrayBuffer;
  const pdfBytes = new Uint8Array(pdfArrayBuffer);

  // Filename: REG-DDMMYY-Job12345-book-out.pdf (matches historical naming)
  const eventDateStr = String(data.eventDate || new Date().toISOString().slice(0, 10));
  const dateParts = eventDateStr.split('-'); // YYYY-MM-DD
  const ddmmyy = dateParts.length === 3
    ? dateParts[2] + dateParts[1] + dateParts[0].slice(2)
    : eventDateStr;
  const safeReg = String(data.vehicleReg || 'unknown').replace(/\s+/g, '-');
  const jobPart = data.hireHopJob ? '-Job' + data.hireHopJob : '';
  const docType = isInterim ? 'interim' : isCheckIn ? 'check-in' : 'book-out';
  const filename = `${safeReg}-${ddmmyy}${jobPart}-${docType}.pdf`;

  return { pdfBytes, filename };
}

// Logo cached in-module — fetched once from R2 and held as a data URI so jsPDF
// can embed it via addImage. The `assets/ooosh-logo.png` R2 object is already
// used by the hire agreement PDF so we reuse fetchLogo().
let cachedLogoDataUri: string | null = null;
async function fetchLogoDataUri(): Promise<string | null> {
  if (cachedLogoDataUri) return cachedLogoDataUri;
  const buf = await fetchLogo();
  if (!buf) return null;
  cachedLogoDataUri = `data:image/png;base64,${buf.toString('base64')}`;
  return cachedLogoDataUri;
}

// All date/time strings on the condition-report PDF are rendered in
// Europe/London. Without an explicit timeZone, Node's toLocale*String
// uses the server's TZ (UTC on Hetzner) — during BST that produced
// timestamps an hour behind the wall clock on the PDF.
const PDF_TIME_ZONE = 'Europe/London';

function formatFullDateTime(isoStr?: string): string {
  if (!isoStr) return '-';
  const d = new Date(isoStr);
  if (isNaN(d.getTime())) return isoStr;
  return d.toLocaleDateString('en-GB', {
    weekday: 'short', day: 'numeric', month: 'short', year: 'numeric',
    timeZone: PDF_TIME_ZONE,
  }) + ' at ' + d.toLocaleTimeString('en-GB', {
    hour: '2-digit', minute: '2-digit',
    timeZone: PDF_TIME_ZONE,
  });
}

function formatDayDate(dateStr: string): string {
  if (!dateStr) return '-';
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) return dateStr;
  return d.toLocaleDateString('en-GB', {
    weekday: 'short', day: 'numeric', month: 'short', year: 'numeric',
    timeZone: PDF_TIME_ZONE,
  });
}

/**
 * Look up the canonical hire-window dates AND times for a HireHop job
 * number, used to fall back when the BookOutPage didn't pass them (e.g.
 * hire-form record missing them or freelancer flow with no hire forms
 * loaded). Mirrors the COALESCE pattern in hire-forms.ts:1337 — prefer
 * per-assignment values, fall back to job-level values.
 *
 * Important rules:
 *   - Hire END uses job_end (the real end of charge), NOT return_date
 *     (the +1-day warehouse turnaround buffer). Per CLAUDE.md "Hire
 *     Date Resolution".
 *   - End TIME falls back to jobs.end_time (also the real end of
 *     charge), NOT jobs.return_time.
 *
 * Returns null if no match. start_time / end_time are 'HH:MM' or null.
 */
/**
 * Resolve the operator (book-out / check-in) display name from the
 * authenticated request. Staff: users JOIN people for first+last name,
 * fall back to email. Freelancer bookout: people lookup by personId.
 * Returns null if neither auth context yields a name (caller should
 * skip rendering the row in that case).
 */
async function resolveOperatorName(req: FlexibleVehicleRequest): Promise<string | null> {
  // Freelancer bookout session — narrow scope, use personId
  if (req.bookoutSession?.freelancerPersonId) {
    try {
      const r = await query(
        `SELECT TRIM(CONCAT_WS(' ', first_name, last_name)) AS name
           FROM people WHERE id = $1 LIMIT 1`,
        [req.bookoutSession.freelancerPersonId]
      );
      const name = r.rows[0]?.name?.trim();
      if (name) return name;
    } catch (err) {
      console.warn('[vehicles/pdf] resolveOperatorName freelancer lookup failed:', err);
    }
    return req.bookoutSession.freelancerEmail || null;
  }

  // Staff session
  if (req.user?.id) {
    try {
      const r = await query(
        `SELECT TRIM(CONCAT_WS(' ', p.first_name, p.last_name)) AS name, u.email
           FROM users u
           LEFT JOIN people p ON p.id = u.person_id
          WHERE u.id = $1 LIMIT 1`,
        [req.user.id]
      );
      const row = r.rows[0];
      const name = row?.name?.trim();
      if (name) return name;
      return row?.email || req.user.email || null;
    } catch (err) {
      console.warn('[vehicles/pdf] resolveOperatorName staff lookup failed:', err);
    }
    return req.user.email || null;
  }

  return null;
}

/**
 * Used by regenerate-pdf: look up the original operator's name from the
 * matching vehicle_hire_assignments row's booked_out_by / checked_in_by
 * user reference. JOIN through users → people for the display name.
 */
async function resolveOperatorNameForEvent(
  reg: string,
  hireHopJob: string | number | null | undefined,
  isCheckIn: boolean,
): Promise<string | null> {
  if (!hireHopJob) return null;
  const hhNum = typeof hireHopJob === 'number' ? hireHopJob : parseInt(String(hireHopJob), 10);
  if (!hhNum || isNaN(hhNum)) return null;
  const opCol = isCheckIn ? 'vha.checked_in_by' : 'vha.booked_out_by';
  try {
    const r = await query(
      `SELECT TRIM(CONCAT_WS(' ', p.first_name, p.last_name)) AS name, u.email
         FROM vehicle_hire_assignments vha
         JOIN fleet_vehicles fv ON fv.id = vha.vehicle_id
         LEFT JOIN users u ON u.id = ${opCol}
         LEFT JOIN people p ON p.id = u.person_id
        WHERE fv.reg = $1
          AND vha.hirehop_job_id = $2
          AND ${opCol} IS NOT NULL
        ORDER BY vha.created_at DESC
        LIMIT 1`,
      [reg, hhNum]
    );
    const row = r.rows[0];
    if (!row) return null;
    return (row.name as string)?.trim() || (row.email as string) || null;
  } catch (err) {
    console.warn('[vehicles/pdf] resolveOperatorNameForEvent failed:', err);
    return null;
  }
}

async function resolveJobHireDates(hireHopJob: string | number | null | undefined): Promise<{
  start: string | null;
  end: string | null;
  startTime: string | null;
  endTime: string | null;
}> {
  const empty = { start: null, end: null, startTime: null, endTime: null };
  if (!hireHopJob) return empty;
  const hhNum = typeof hireHopJob === 'number' ? hireHopJob : parseInt(String(hireHopJob), 10);
  if (!hhNum || isNaN(hhNum)) return empty;
  try {
    const result = await query(
      `SELECT
         COALESCE(MAX(vha.hire_start), MAX(j.job_date))    AS resolved_start,
         COALESCE(MAX(vha.hire_end),   MAX(j.job_end))     AS resolved_end,
         COALESCE(MAX(vha.start_time), MAX(j.out_time),
                                       MAX(j.start_time))  AS resolved_start_time,
         COALESCE(MAX(vha.end_time),   MAX(j.end_time))    AS resolved_end_time
         FROM jobs j
         LEFT JOIN vehicle_hire_assignments vha
                ON vha.job_id = j.id
               AND vha.assignment_type = 'self_drive'
               AND vha.status != 'cancelled'
        WHERE j.hh_job_number = $1`,
      [hhNum]
    );
    const row = result.rows[0];
    if (!row) return empty;
    const toIso = (v: unknown): string | null => {
      if (!v) return null;
      const d = new Date(v as string | Date);
      if (isNaN(d.getTime())) return null;
      return d.toISOString().slice(0, 10);
    };
    const toHHMM = (v: unknown): string | null => {
      if (!v) return null;
      const s = String(v);
      // Postgres TIME returns 'HH:MM:SS' or 'HH:MM:SS.ssss'; trim to HH:MM.
      const m = s.match(/^(\d{2}:\d{2})/);
      return m ? m[1]! : null;
    };
    return {
      start: toIso(row.resolved_start),
      end: toIso(row.resolved_end),
      startTime: toHHMM(row.resolved_start_time),
      endTime: toHHMM(row.resolved_end_time),
    };
  } catch (err) {
    console.warn('[vehicles/pdf] resolveJobHireDates failed:', err instanceof Error ? err.message : err);
    return empty;
  }
}

/**
 * POST /api/vehicles/generate-pdf
 * Generate a vehicle condition report PDF (book-out / check-in).
 * Returns base64-encoded PDF + filename.
 */
router.post('/generate-pdf', async (req: FlexibleVehicleRequest, res: Response) => {
  try {
    // Freelancer: the PDF template includes vehicleReg — require it to
    // match the session to stop anyone piggy-backing PDF generation on
    // an unrelated vehicle.
    if (isFreelancerBookout(req)) {
      const scope = await getBookoutScope(req);
      const regInBody = typeof req.body?.vehicleReg === 'string' ? req.body.vehicleReg.toUpperCase() : '';
      if (!scope || !regInBody || regInBody !== scope.registration) {
        res.status(403).json({ error: 'PDF target does not match your vehicle' });
        return;
      }
    }

    // Backstop for missing hire dates / times: BookOutPage only sets
    // hireStartDate/hireEndDate/hireStartTime/hireEndTime when it sees
    // them on the loaded hire form. If no hire form is loaded
    // (freelancer mode, mid-tour driver, or the form has those fields
    // NULL), the PDF would print "(pending hire form)" or no time at
    // all even though the job has perfectly good values. Fall back to
    // the same COALESCE pattern the hire-form PDF builder uses.
    const data = { ...(req.body || {}) };
    const needsAnyFallback = !data.hireStartDate || !data.hireEndDate
      || !data.hireStartTime || !data.hireEndTime;
    if (needsAnyFallback) {
      const resolved = await resolveJobHireDates(data.hireHopJob);
      if (!data.hireStartDate && resolved.start)     data.hireStartDate = resolved.start;
      if (!data.hireEndDate   && resolved.end)       data.hireEndDate   = resolved.end;
      if (!data.hireStartTime && resolved.startTime) data.hireStartTime = resolved.startTime;
      if (!data.hireEndTime   && resolved.endTime)   data.hireEndTime   = resolved.endTime;
    }

    // Operator name — derived server-side, can't be spoofed from the
    // client payload. Staff: users JOIN people. Freelancer: people row
    // for the bookout-session person_id.
    data.performedByName = await resolveOperatorName(req);

    const { pdfBytes, filename } = await buildConditionReportPdf(data);
    const base64Pdf = Buffer.from(pdfBytes).toString('base64');
    res.json({
      pdf: base64Pdf,
      size: pdfBytes.length,
      filename,
    });
  } catch (error) {
    console.error('[vehicles/pdf] Generate condition report error:', error);
    res.status(500).json({ error: 'PDF generation failed' });
  }
});

/**
 * POST /api/vehicles/events/:eventId/regenerate-pdf
 * Rebuild a condition report PDF from data already stored in R2
 * (event JSON + photos + optional signature). Useful when:
 *   - the original PDF generation failed (WinAnsi crash, etc.)
 *   - staff need to re-send the report to a different recipient
 *   - a mis-fire needs a manual fix
 *
 * Body:
 *   { vehicleReg: string,       // required, used to locate the event
 *     email?: string,           // override recipient (defaults to event.clientEmail)
 *     skipEmail?: boolean }     // return PDF only, don't send
 *
 * Returns: { pdf (base64), size, filename, emailSent, emailedTo }
 */
router.post('/events/:eventId/regenerate-pdf', async (req: AuthRequest, res: Response) => {
  try {
    const { eventId } = req.params;
    const { vehicleReg, email: emailOverride, skipEmail } = req.body;

    if (!eventId || !vehicleReg) {
      res.status(400).json({ error: 'eventId (param) and vehicleReg (body) are required' });
      return;
    }

    const reg = String(vehicleReg).toUpperCase();
    const eventKey = `vehicle-events/${reg}/${eventId}.json`;

    // Load event JSON from R2
    const event = await readR2Json<any>(eventKey);
    if (!event) {
      res.status(404).json({ error: `Event not found at ${eventKey}` });
      return;
    }

    // Parse driver name from event.details string (legacy events don't have
    // driverName as a field — it was stuffed into the "details" line-join).
    // Format: "Driver: Mr Desmond Magee\nHireHop Job: 12345\nPhotos: 14 captured\nBriefing completed\nNotes: ..."
    let driverName = event.driverName || '';
    let notes = event.notes || '';
    if (!driverName && typeof event.details === 'string') {
      const driverMatch = event.details.match(/^Driver:\s*(.+)$/m);
      if (driverMatch) driverName = driverMatch[1].trim();
      const notesMatch = event.details.match(/^Notes:\s*([\s\S]+)$/m);
      if (notesMatch) notes = notesMatch[1].trim();
    }

    // List photos stored under events/{eventId}/{REG}/*.jpg and base64 them.
    // Load condition photos from the PUBLIC bucket (`ooosh-vehicle-photos`)
    // where `/upload-photo` writes them. Each photo gets an `r2Url` built
    // from R2_PUBLIC_URL so the jsPDF `textWithLink` "View full size"
    // hyperlinks resolve to publicly-readable objects in clients' browsers.
    const r2PublicBase = process.env.R2_PUBLIC_URL || '';
    const photoBase64s: Array<{ angle: string; label: string; base64: string; r2Url?: string }> = [];
    if (isR2Configured()) {
      const photoPrefix = `events/${eventId}/${reg}/`;
      const photoObjects = await listPublicR2Objects(photoPrefix);
      for (const obj of photoObjects) {
        if (!obj.Key) continue;
        try {
          const photoResp = await getFromPublicR2(obj.Key);
          const stream = photoResp.Body as NodeJS.ReadableStream;
          const chunks: Buffer[] = [];
          for await (const chunk of stream) {
            chunks.push(Buffer.from(chunk as Uint8Array));
          }
          const buf = Buffer.concat(chunks);
          const angle = obj.Key.split('/').pop()?.replace(/\.(jpe?g|png)$/i, '') || 'photo';
          photoBase64s.push({
            angle,
            label: angle,
            base64: buf.toString('base64'),
            r2Url: r2PublicBase ? `${r2PublicBase}/${obj.Key}` : undefined,
          });
        } catch (err) {
          console.warn(`[vehicles/regenerate-pdf] Failed to load photo ${obj.Key}:`, err);
        }
      }
    }

    // Optionally load signature from R2. Expected key pattern:
    // vehicle-events/{REG}/{eventId}_signature.png (persisted going forward
    // by the book-out flow). Missing signature → we print a placeholder
    // instead of failing.
    let signatureBase64: string | undefined;
    const sigKey = event.signatureR2Key || `vehicle-events/${reg}/${eventId}_signature.png`;
    if (isR2Configured()) {
      try {
        const sigResp = await getFromR2(sigKey);
        const sigStream = sigResp.Body as NodeJS.ReadableStream;
        const sigChunks: Buffer[] = [];
        for await (const chunk of sigStream) {
          sigChunks.push(Buffer.from(chunk as Uint8Array));
        }
        signatureBase64 = Buffer.concat(sigChunks).toString('base64');
      } catch {
        // No signature stored — not an error, just missing.
      }
    }

    // Resolve hire dates from the DB (event JSON doesn't carry them; same
    // fallback as /generate-pdf). Important for regenerating PDFs from
    // events that were saved before this column carried hire dates, and
    // for freelancer book-outs where the hire form data wasn't loaded
    // client-side at PDF generation time.
    const resolvedDates = await resolveJobHireDates(event.hireHopJob);

    // Operator name — for regenerated PDFs we want the ORIGINAL operator,
    // not the staff member clicking the regenerate button. Read from the
    // assignment's booked_out_by / checked_in_by user reference.
    const normalisedRegenType = String(event.eventType || '').toLowerCase().replace(/[\s_]+/g, '-');
    const isInterimRegen = normalisedRegenType === 'soft-check-in';
    const isCheckInRegen = event.eventType === 'Check In' || event.eventType === 'check-in';
    const performedByName = await resolveOperatorNameForEvent(
      reg,
      event.hireHopJob,
      isCheckInRegen,
    );

    // Build the PDF
    const { pdfBytes, filename } = await buildConditionReportPdf({
      vehicleReg: reg,
      vehicleType: event.vehicleType || '',
      driverName,
      clientEmail: event.clientEmail || undefined,
      hireHopJob: event.hireHopJob || undefined,
      mileage: event.mileage ?? null,
      fuelLevel: event.fuelLevel || null,
      eventDate: event.eventDate || new Date().toISOString().slice(0, 10),
      eventDateTime: event.createdAt || event.eventDate || new Date().toISOString(),
      hireStartDate: event.hireStartDate || resolvedDates.start || undefined,
      hireEndDate: event.hireEndDate || resolvedDates.end || undefined,
      hireStartTime: event.hireStartTime || resolvedDates.startTime || undefined,
      hireEndTime: event.hireEndTime || resolvedDates.endTime || undefined,
      performedByName: performedByName || undefined,
      photos: photoBase64s,
      briefingItems: Array.isArray(event.briefingItems) ? event.briefingItems : [],
      bookOutNotes: notes,
      signatureBase64,
      signatureMissing: !isInterimRegen && !signatureBase64,
      isCheckIn: isCheckInRegen,
      isInterim: isInterimRegen,
    });

    const base64Pdf = Buffer.from(pdfBytes).toString('base64');

    // Optionally email
    const recipient = emailOverride || event.clientEmail || null;
    let emailSent = false;
    let emailedTo: string | null = null;

    if (!skipEmail && recipient) {
      const isCheckIn = event.eventType === 'Check In' || event.eventType === 'check-in';
      const reportType = isCheckIn ? 'Check-In Report' : 'Condition Report';
      const subject = `Vehicle ${reportType} - ${reg} - ${event.eventDate || new Date().toISOString().slice(0, 10)}`;
      const html = `
        <p>Hi ${driverName || 'there'},</p>
        <p>Please find attached your vehicle ${reportType.toLowerCase()} for <strong>${reg}</strong>.</p>
        <p>If you have any questions, please call us on <strong>+44 (0) 1273 911382</strong>
        or email <a href="mailto:info@oooshtours.co.uk">info@oooshtours.co.uk</a>.</p>
      `;

      const emailResult = await emailService.sendRaw({
        to: recipient,
        subject,
        html,
        variant: 'client',
        attachments: [{
          filename,
          content: Buffer.from(pdfBytes),
          contentType: 'application/pdf',
        }],
      });
      emailSent = emailResult.success;
      emailedTo = recipient;
      if (!emailResult.success) {
        console.warn(`[vehicles/regenerate-pdf] Email to ${recipient} failed:`, emailResult.error);
      }
    }

    res.json({
      pdf: base64Pdf,
      size: pdfBytes.length,
      filename,
      photoCount: photoBase64s.length,
      signatureFound: !!signatureBase64,
      emailSent,
      emailedTo,
    });
  } catch (error) {
    console.error('[vehicles/regenerate-pdf] Error:', error);
    res.status(500).json({ error: 'Regenerate failed', details: error instanceof Error ? error.message : 'Unknown' });
  }
});

// ── Send Email (condition report with PDF attachment) ──

/**
 * POST /api/vehicles/send-email
 * Send an email with optional PDF attachment.
 * Used by book-out/check-in flows to email condition reports.
 */
router.post('/send-email', async (req: FlexibleVehicleRequest, res: Response) => {
  try {
    let { to } = req.body;
    const { subject, html, pdfBase64, pdfFilename, hireHopJob } = req.body;

    if (!subject) {
      res.status(400).json({ error: 'subject is required' });
      return;
    }

    // Email-fallback chain. The condition-report email is fired from the
    // book-out / check-in flow with the customer's email as `to`. When
    // no customer email is on the assignment (HH-synced sole-trader jobs,
    // shell client orgs, freelancer flow before the customer hire form
    // arrived) the frontend used to silently skip the email entirely.
    //
    // New behaviour: when `to` is missing AND `hireHopJob` is provided,
    // resolve the job to its OP UUID, walk the address book via
    // resolveClientEmailTarget, and fall back to info@oooshtours.co.uk
    // with an amber banner + timeline interaction so staff can forward
    // and update the address book.
    let prependBanner: string | undefined;
    let fallbackJobId: string | null = null;
    if (!to) {
      if (!hireHopJob) {
        res.status(400).json({ error: 'to (or hireHopJob for fallback) is required' });
        return;
      }
      const jobLookup = await query(
        `SELECT id FROM jobs WHERE hh_job_number = $1 LIMIT 1`,
        [parseInt(String(hireHopJob), 10)]
      );
      if (jobLookup.rows.length === 0) {
        res.status(400).json({ error: 'to (or hireHopJob for fallback) is required' });
        return;
      }
      fallbackJobId = jobLookup.rows[0].id;
      const target = await resolveClientEmailTarget(fallbackJobId!);
      to = target.primaryEmail;
      if (target.isFallback) {
        prependBanner = buildFallbackBanner({
          jobId: fallbackJobId!,
          clientName: target.clientName,
          jobNumber: target.jobNumber,
          jobName: target.jobName,
        });
      }
    }

    // Freelancer: the condition-report subject and filename always include
    // the vehicle reg (format `Vehicle Condition Report - RX24SZC - ...`
    // and `report-RX24SZC-*.pdf`). Require the session reg to appear in
    // at least one of those before sending — it's a cheap guard against a
    // compromised session being used to broadcast unrelated emails.
    if (isFreelancerBookout(req)) {
      const scope = await getBookoutScope(req);
      if (!scope) {
        res.status(403).json({ error: 'Assignment not found' });
        return;
      }
      const reg = scope.registration;
      const subjectHasReg = typeof subject === 'string' && subject.toUpperCase().includes(reg);
      const filenameHasReg = typeof pdfFilename === 'string' && pdfFilename.toUpperCase().includes(reg);
      if (!subjectHasReg && !filenameHasReg) {
        res.status(403).json({ error: 'Email target does not reference your vehicle' });
        return;
      }
    }

    const attachments = pdfBase64 && pdfFilename ? [{
      filename: pdfFilename,
      content: Buffer.from(pdfBase64, 'base64'),
      contentType: 'application/pdf' as const,
    }] : [];

    // Use the email service's sendRaw for plain emails, or direct nodemailer for attachments
    if (attachments.length > 0) {
      const nodemailer = await import('nodemailer');
      const transporter = nodemailer.createTransport({
        host: process.env.SMTP_HOST || 'smtp.gmail.com',
        port: parseInt(process.env.SMTP_PORT || '587', 10),
        secure: false,
        auth: {
          user: process.env.SMTP_USER || '',
          pass: process.env.SMTP_PASS || '',
        },
      });

      const isTestMode = (process.env.EMAIL_MODE || 'test') === 'test';
      const actualTo = isTestMode && process.env.EMAIL_TEST_REDIRECT
        ? process.env.EMAIL_TEST_REDIRECT : to;

      const mailResult = await transporter.sendMail({
        from: process.env.SMTP_FROM || 'Ooosh Tours <notifications@oooshtours.co.uk>',
        to: actualTo,
        subject: isTestMode ? `[TEST] ${subject}` : subject,
        html: (prependBanner || '') + (html || ''),
        attachments,
      });

      if (fallbackJobId) {
        await logFallbackToTimeline({ jobId: fallbackJobId, templateId: 'condition_report' });
      }
      res.json({ messageId: mailResult.messageId || 'sent', isFallback: !!fallbackJobId });
    } else {
      const result = await emailService.sendRaw({ to, subject, html: (prependBanner || '') + (html || '') });
      if (!result.success) {
        res.status(500).json({ error: result.error || 'Email send failed' });
        return;
      }
      if (fallbackJobId) {
        await logFallbackToTimeline({ jobId: fallbackJobId, templateId: 'condition_report' });
      }
      res.json({ messageId: result.messageId || 'sent', isFallback: !!fallbackJobId });
    }
  } catch (error) {
    console.error('[vehicles/email] Send error:', error);
    res.status(500).json({ error: 'Email send failed', details: error instanceof Error ? error.message : 'Unknown error' });
  }
});

/**
 * POST /api/vehicles/send-condition-report
 * Generate AND email condition-report PDFs for one or more drivers in a
 * single call, fully server-side.
 *
 * Replaces the legacy two-step flow (POST /generate-pdf -> POST /send-email
 * per driver) used by BookOutPage/CheckInPage. That flow returned each
 * 7-9MB base64 PDF to the phone, which then re-uploaded it as the email
 * payload — per driver. On a multi-driver hire that was ~16MB of transfer
 * per driver for PDFs that differ only by the driver name at the top.
 * Here the (already ~800px) photo thumbnails come up once and the per-driver
 * PDFs never leave the server. (Validated against the 10 Jun 2026 Scene
 * Queen book-out, where PDF/email round-trips were ~30s of the 2-min submit.)
 *
 * Body:
 *   {
 *     ...pdfData,                       // same shape as POST /generate-pdf
 *     recipients: [{ driverName, email | null }],
 *     emailMeta?: { driverPresent?, damageCount?, fuelDifference?, milesDriven? }
 *   }
 *
 * Per-recipient email resolution follows the /send-email fallback chain:
 * explicit email -> job-level address book via resolveClientEmailTarget ->
 * info@oooshtours.co.uk with amber banner + timeline interaction.
 *
 * Legacy /generate-pdf + /send-email stay in place for CollectionPage,
 * the offline sync-processors, and events/:id/regenerate-pdf.
 */
router.post('/send-condition-report', async (req: FlexibleVehicleRequest, res: Response) => {
  try {
    const body = req.body || {};
    const recipients = Array.isArray(body.recipients) ? body.recipients : [];
    if (recipients.length === 0) {
      res.status(400).json({ error: 'recipients is required (at least one)' });
      return;
    }

    // Freelancer: the PDF template includes vehicleReg — require it to
    // match the session (same guard as /generate-pdf).
    if (isFreelancerBookout(req)) {
      const scope = await getBookoutScope(req);
      const regInBody = typeof body.vehicleReg === 'string' ? body.vehicleReg.toUpperCase() : '';
      if (!scope || !regInBody || regInBody !== scope.registration) {
        res.status(403).json({ error: 'PDF target does not match your vehicle' });
        return;
      }
    }

    // Same hire-date backstop + operator-name derivation as /generate-pdf.
    const { recipients: _r, emailMeta, ...pdfData } = body;
    const data: any = { ...pdfData };
    const needsAnyFallback = !data.hireStartDate || !data.hireEndDate
      || !data.hireStartTime || !data.hireEndTime;
    if (needsAnyFallback) {
      const resolved = await resolveJobHireDates(data.hireHopJob);
      if (!data.hireStartDate && resolved.start)     data.hireStartDate = resolved.start;
      if (!data.hireEndDate   && resolved.end)       data.hireEndDate   = resolved.end;
      if (!data.hireStartTime && resolved.startTime) data.hireStartTime = resolved.startTime;
      if (!data.hireEndTime   && resolved.endTime)   data.hireEndTime   = resolved.endTime;
    }
    data.performedByName = await resolveOperatorName(req);

    // Job-level fallback recipient (resolved once, reused for any recipient
    // with no email on file).
    let fallbackJobId: string | null = null;
    if (data.hireHopJob) {
      const jobLookup = await query(
        `SELECT id FROM jobs WHERE hh_job_number = $1 LIMIT 1`,
        [parseInt(String(data.hireHopJob), 10)]
      );
      if (jobLookup.rows.length > 0) fallbackJobId = jobLookup.rows[0].id;
    }

    const nodemailer = await import('nodemailer');
    const transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST || 'smtp.gmail.com',
      port: parseInt(process.env.SMTP_PORT || '587', 10),
      secure: false,
      auth: {
        user: process.env.SMTP_USER || '',
        pass: process.env.SMTP_PASS || '',
      },
    });
    const isTestMode = (process.env.EMAIL_MODE || 'test') === 'test';

    const results: Array<{
      driverName: string;
      success: boolean;
      emailedTo?: string;
      isFallback?: boolean;
      filename?: string;
      size?: number;
      error?: string;
    }> = [];

    // Sequential per driver — PDFs share the photo set, and one in-flight
    // jsPDF build at a time keeps memory predictable.
    for (const recipient of recipients) {
      const driverName = String(recipient?.driverName || '').trim() || 'Driver';
      const explicitEmail = recipient?.email ? String(recipient.email).trim() : '';

      try {
        const { pdfBytes, filename } = await buildConditionReportPdf({
          ...data,
          driverName,
          clientEmail: explicitEmail || undefined,
        });

        // Resolve recipient: explicit email, else job-level fallback chain.
        let to = explicitEmail;
        let prependBanner: string | undefined;
        let usedFallback = false;
        if (!to) {
          if (!fallbackJobId) {
            results.push({
              driverName,
              success: false,
              filename,
              size: pdfBytes.length,
              error: 'No email on file and no job to resolve a fallback from',
            });
            continue;
          }
          const target = await resolveClientEmailTarget(fallbackJobId);
          to = target.primaryEmail;
          if (target.isFallback) {
            usedFallback = true;
            prependBanner = buildFallbackBanner({
              jobId: fallbackJobId,
              clientName: target.clientName,
              jobNumber: target.jobNumber,
              jobName: target.jobName,
            });
          }
        }

        const emailParams: ConditionReportEmailParams = {
          vehicleReg: String(data.vehicleReg || ''),
          driverName,
          eventDate: String(data.eventDate || ''),
          isCheckIn: !!data.isCheckIn,
          hireHopJob: data.hireHopJob ? String(data.hireHopJob) : null,
          driverPresent: emailMeta?.driverPresent,
          damageCount: emailMeta?.damageCount,
          fuelDifference: emailMeta?.fuelDifference ?? null,
          milesDriven: emailMeta?.milesDriven ?? null,
        };
        const subject = buildConditionReportSubject(emailParams);
        const html = (prependBanner || '') + buildConditionReportEmailHtml(emailParams);

        const actualTo = isTestMode && process.env.EMAIL_TEST_REDIRECT
          ? process.env.EMAIL_TEST_REDIRECT : to;

        await transporter.sendMail({
          from: process.env.SMTP_FROM || 'Ooosh Tours <notifications@oooshtours.co.uk>',
          to: actualTo,
          subject: isTestMode ? `[TEST] ${subject}` : subject,
          html,
          attachments: [{
            filename,
            content: Buffer.from(pdfBytes),
            contentType: 'application/pdf' as const,
          }],
        });

        if (usedFallback && fallbackJobId) {
          await logFallbackToTimeline({ jobId: fallbackJobId, templateId: 'condition_report' });
        }

        results.push({
          driverName,
          success: true,
          emailedTo: to,
          isFallback: usedFallback,
          filename,
          size: pdfBytes.length,
        });
      } catch (err) {
        console.error(`[vehicles/send-condition-report] Failed for ${driverName}:`, err);
        results.push({
          driverName,
          success: false,
          error: err instanceof Error ? err.message : 'PDF/email failed',
        });
      }
    }

    res.json({ results });
  } catch (error) {
    console.error('[vehicles/send-condition-report] Error:', error);
    res.status(500).json({
      error: 'Condition report send failed',
      details: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

// ── Photo Upload & List ──

/**
 * POST /api/vehicles/upload-photo
 * Upload a photo to R2. Expects multipart form with 'file' and 'key' fields.
 */
const photoUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB
  fileFilter: (_req, file, cb) => {
    if (file.mimetype.startsWith('image/')) {
      cb(null, true);
    } else {
      cb(new Error('Only image files are allowed'));
    }
  },
});

router.post('/upload-photo', (req: FlexibleVehicleRequest, res: Response) => {
  photoUpload.single('file')(req, res, async (err) => {
    if (err) {
      console.error('[vehicles/photos] Multer error:', err);
      res.status(400).json({ error: err.message || 'Upload failed' });
      return;
    }

    try {
      if (!req.file) {
        res.status(400).json({ error: 'No file provided' });
        return;
      }

      const key = req.body.key as string;
      if (!key) {
        res.status(400).json({ error: 'No key provided' });
        return;
      }

      // Sanitise key — prevent path traversal
      const sanitisedKey = key.replace(/\.\./g, '').replace(/^\/+/, '');

      // Freelancer: key must sit under events/{eventId}/{their-reg}/... — the
      // frontend builds keys of shape `events/{eventId}/{REG}/{angle}.jpg`
      // OR `vehicle-events/{REG}/{event-id}_signature.png`. Reject anything
      // that doesn't target their assigned vehicle.
      if (isFreelancerBookout(req)) {
        const scope = await getBookoutScope(req);
        if (!scope) {
          res.status(403).json({ error: 'Assignment not found' });
          return;
        }
        const lower = sanitisedKey.toLowerCase();
        const regLower = scope.registration.toLowerCase();
        const acceptable =
          lower.startsWith(`events/`) && lower.includes(`/${regLower}/`) ||
          lower.startsWith(`vehicle-events/${regLower}/`);
        if (!acceptable) {
          res.status(403).json({ error: 'Upload key does not target your vehicle' });
          return;
        }
      }

      // Route condition-report photos to the PUBLIC bucket
      // (`ooosh-vehicle-photos`) so they can be opened via the "View full
      // size" hyperlinks embedded in the condition report PDFs sent to
      // clients. Anything else (non-event-photo uploads) still goes to the
      // private bucket.
      //
      // The key pattern the frontend sends for condition photos is
      // `events/{eventId}/{REG}/{angle}.jpg` — everything else we keep
      // private by default.
      const isEventPhoto = /^events\//.test(sanitisedKey);
      if (isEventPhoto) {
        await uploadToPublicR2(sanitisedKey, req.file.buffer, req.file.mimetype);
      } else {
        await uploadToR2(sanitisedKey, req.file.buffer, req.file.mimetype);
      }

      res.json({
        url: sanitisedKey,
        key: sanitisedKey,
        bucket: isEventPhoto ? 'ooosh-vehicle-photos' : 'operations',
      });
    } catch (error) {
      console.error('[vehicles/photos] Upload error:', error);
      res.status(500).json({ error: 'Upload failed' });
    }
  });
});

/**
 * GET /api/vehicles/list-photos?prefix=events/xxx/REG/
 * List photos in R2 under a given prefix. Reads from the public bucket
 * (where `/upload-photo` writes condition photos) when the prefix starts
 * with `events/`; private bucket otherwise.
 */
router.get('/list-photos', async (req: AuthRequest, res: Response) => {
  try {
    const prefix = req.query.prefix as string;
    if (!prefix) {
      res.status(400).json({ error: 'prefix is required' });
      return;
    }

    const isEventPhotoPrefix = /^events\//.test(prefix);
    const objects = isEventPhotoPrefix
      ? await listPublicR2Objects(prefix)
      : await listR2Objects(prefix);
    const photos = (objects || [])
      .filter(obj => obj.Key && /\.(jpg|jpeg|png|webp)$/i.test(obj.Key))
      .map(obj => {
        const key = obj.Key!;
        const angle = key.split('/').pop()?.replace(/\.[^.]+$/, '') || '';
        return { angle, key, url: `/api/vehicles/photo/${encodeURIComponent(key)}` };
      });

    res.json({ photos });
  } catch (error) {
    console.error('[vehicles/photos] List error:', error);
    res.status(500).json({ error: 'Failed to list photos' });
  }
});

/**
 * GET /api/vehicles/photo/:key
 * Serve a photo from R2 (streaming proxy). Reads from the public bucket
 * for `events/` keys, private bucket otherwise.
 */
router.get('/photo/*', async (req: AuthRequest, res: Response) => {
  try {
    const key = (req.params as Record<string, string>)[0];
    if (!key) {
      res.status(400).json({ error: 'key is required' });
      return;
    }

    const isEventPhoto = /^events\//.test(key);
    const obj = isEventPhoto ? await getFromPublicR2(key) : await getFromR2(key);
    if (!obj.Body) {
      res.status(404).json({ error: 'Photo not found' });
      return;
    }

    const contentType = obj.ContentType || 'image/jpeg';
    res.setHeader('Content-Type', contentType);
    res.setHeader('Cache-Control', 'public, max-age=86400');

    const bodyBytes = await obj.Body.transformToByteArray();
    res.send(Buffer.from(bodyBytes));
  } catch (error: unknown) {
    if ((error as { name?: string })?.name === 'NoSuchKey') {
      res.status(404).json({ error: 'Photo not found' });
      return;
    }
    console.error('[vehicles/photos] Serve error:', error);
    res.status(500).json({ error: 'Failed to serve photo' });
  }
});

// ── Traccar GPS Proxy ──

const TRACCAR_URL = process.env.TRACCAR_URL || 'https://tracking.oooshtours.co.uk';
const TRACCAR_EMAIL = process.env.TRACCAR_EMAIL || '';
const TRACCAR_PASSWORD = process.env.TRACCAR_PASSWORD || '';

/**
 * POST /api/vehicles/traccar
 * Proxy requests to Traccar GPS tracking server.
 * Body: { endpoint: string, params?: Record<string, string> }
 */
router.post('/traccar', async (req: AuthRequest, res: Response) => {
  try {
    if (!TRACCAR_EMAIL || !TRACCAR_PASSWORD) {
      res.status(503).json({ error: 'Traccar not configured. Set TRACCAR_URL, TRACCAR_EMAIL, TRACCAR_PASSWORD in .env' });
      return;
    }

    const { endpoint, params } = req.body;
    if (!endpoint) {
      res.status(400).json({ error: 'endpoint is required' });
      return;
    }

    // Build URL with query params
    const url = new URL(`/api${endpoint}`, TRACCAR_URL);
    if (params) {
      for (const [key, value] of Object.entries(params as Record<string, string>)) {
        url.searchParams.set(key, value);
      }
    }

    const authHeader = 'Basic ' + Buffer.from(`${TRACCAR_EMAIL}:${TRACCAR_PASSWORD}`).toString('base64');

    const response = await fetch(url.toString(), {
      headers: {
        'Authorization': authHeader,
        'Accept': 'application/json',
      },
    });

    if (!response.ok) {
      const body = await response.text();
      console.error(`[vehicles/traccar] Traccar API error: ${response.status}`, body);
      res.status(response.status).json({ error: `Traccar API error: ${response.status}` });
      return;
    }

    const data = await response.json();
    res.json(data);
  } catch (error) {
    console.error('[vehicles/traccar] Proxy error:', error);
    res.status(500).json({ error: 'Traccar request failed' });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// 6. MILEAGE — /api/vehicles/fleet/:vehicleId/mileage
// ═══════════════════════════════════════════════════════════════════════════

/**
 * GET /api/vehicles/fleet/:vehicleId/mileage
 * Mileage history for a vehicle, most recent first.
 */
router.get('/fleet/:vehicleId/mileage', async (req: AuthRequest, res: Response) => {
  try {
    const { vehicleId } = req.params;
    const { limit = '50', offset = '0' } = req.query;

    const result = await query(
      `SELECT ml.*, CONCAT(p.first_name, ' ', p.last_name) AS recorded_by_name
       FROM vehicle_mileage_log ml
       LEFT JOIN users u ON u.id = ml.recorded_by
       LEFT JOIN people p ON p.id = u.person_id
       WHERE ml.vehicle_id = $1
       ORDER BY ml.recorded_at DESC
       LIMIT $2 OFFSET $3`,
      [vehicleId, Number(limit), Number(offset)]
    );

    const countResult = await query(
      'SELECT COUNT(*) FROM vehicle_mileage_log WHERE vehicle_id = $1',
      [vehicleId]
    );

    // Compute stats
    const statsResult = await query(
      `SELECT
         MIN(mileage) AS min_mileage,
         MAX(mileage) AS max_mileage,
         COUNT(*) AS total_readings,
         MIN(recorded_at) AS first_reading,
         MAX(recorded_at) AS last_reading
       FROM vehicle_mileage_log WHERE vehicle_id = $1`,
      [vehicleId]
    );
    const stats = statsResult.rows[0] || {};

    // Canonical "current mileage" is fleet_vehicles.current_mileage — NOT
    // MAX(log). A stuck-high bad reading in the log must never drive the
    // headline figure (see RX73TBZ, May 2026). One edit on the vehicle then
    // updates the headline everywhere it's shown.
    const fleetRow = await query('SELECT current_mileage FROM fleet_vehicles WHERE id = $1', [vehicleId]);
    const canonicalMileage = fleetRow.rows[0]?.current_mileage ?? null;

    // Average daily mileage (from first to last reading)
    let avgDailyMileage: number | null = null;
    if (stats.first_reading && stats.last_reading && stats.min_mileage != null && stats.max_mileage != null) {
      const daysDiff = (new Date(stats.last_reading as string).getTime() - new Date(stats.first_reading as string).getTime()) / (1000 * 60 * 60 * 24);
      if (daysDiff > 0) {
        avgDailyMileage = Math.round((Number(stats.max_mileage) - Number(stats.min_mileage)) / daysDiff);
      }
    }

    res.json({
      data: result.rows.map(row => ({
        id: row.id,
        vehicleId: row.vehicle_id,
        mileage: Number(row.mileage),
        source: row.source,
        sourceRef: row.source_ref,
        recordedAt: row.recorded_at ? (row.recorded_at as Date).toISOString() : null,
        recordedBy: row.recorded_by,
        recordedByName: row.recorded_by_name,
      })),
      total: Number(countResult.rows[0]?.count || 0),
      stats: {
        currentMileage: canonicalMileage != null ? Number(canonicalMileage) : null,
        totalReadings: Number(stats.total_readings || 0),
        avgDailyMileage,
      },
    });
  } catch (error) {
    console.error('[vehicles/mileage] List error:', error);
    res.status(500).json({ error: 'Failed to load mileage history' });
  }
});

/**
 * POST /api/vehicles/fleet/:vehicleId/mileage
 * Manual mileage entry.
 */
router.post('/fleet/:vehicleId/mileage', async (req: AuthRequest, res: Response) => {
  try {
    const { vehicleId } = req.params;
    const { mileage, source = 'manual', source_ref } = req.body;
    const userId = req.user?.id || null;

    if (!mileage || Number(mileage) <= 0) {
      res.status(400).json({ error: 'Valid mileage is required' });
      return;
    }

    const mileageVal = Number(mileage);

    const result = await query(
      `INSERT INTO vehicle_mileage_log (vehicle_id, mileage, source, source_ref, recorded_by)
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [vehicleId, mileageVal, source, source_ref || null, userId]
    );

    // Update current mileage (only if higher)
    await query(
      `UPDATE fleet_vehicles SET current_mileage = $1, last_mileage_update = NOW()
       WHERE id = $2 AND (current_mileage IS NULL OR current_mileage < $1)`,
      [mileageVal, vehicleId]
    );

    res.status(201).json(result.rows[0]);
  } catch (error) {
    console.error('[vehicles/mileage] Create error:', error);
    res.status(500).json({ error: 'Failed to record mileage' });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// 7. FUEL LOG — /api/vehicles/fleet/:vehicleId/fuel
// ═══════════════════════════════════════════════════════════════════════════

/**
 * GET /api/vehicles/fleet/:vehicleId/fuel
 * Fuel log with stats (cost per mile calculated from full-to-full fills).
 */
router.get('/fleet/:vehicleId/fuel', async (req: AuthRequest, res: Response) => {
  try {
    const { vehicleId } = req.params;
    const { limit = '50', offset = '0' } = req.query;

    const result = await query(
      `SELECT fl.*, CONCAT(p.first_name, ' ', p.last_name) AS created_by_name
       FROM vehicle_fuel_log fl
       LEFT JOIN users u ON u.id = fl.created_by
       LEFT JOIN people p ON p.id = u.person_id
       WHERE fl.vehicle_id = $1
       ORDER BY fl.date DESC, fl.created_at DESC
       LIMIT $2 OFFSET $3`,
      [vehicleId, Number(limit), Number(offset)]
    );

    const countResult = await query(
      'SELECT COUNT(*) FROM vehicle_fuel_log WHERE vehicle_id = $1', [vehicleId]
    );

    // Aggregate stats
    const statsResult = await query(
      `SELECT
         SUM(cost) AS total_cost,
         SUM(litres) AS total_litres,
         COUNT(*) AS fill_count,
         MIN(date) AS first_fill,
         MAX(date) AS last_fill
       FROM vehicle_fuel_log WHERE vehicle_id = $1`,
      [vehicleId]
    );
    const s = statsResult.rows[0] || {};

    // Cost per mile: use mileage range from fuel entries that have mileage_at_fill
    let costPerMile: number | null = null;
    const mileageRange = await query(
      `SELECT MIN(mileage_at_fill) AS min_m, MAX(mileage_at_fill) AS max_m, SUM(cost) AS total_cost
       FROM vehicle_fuel_log
       WHERE vehicle_id = $1 AND mileage_at_fill IS NOT NULL`,
      [vehicleId]
    );
    const mr = mileageRange.rows[0];
    if (mr && mr.min_m != null && mr.max_m != null && Number(mr.max_m) > Number(mr.min_m)) {
      costPerMile = Math.round((Number(mr.total_cost) / (Number(mr.max_m) - Number(mr.min_m))) * 100) / 100;
    }

    res.json({
      data: result.rows.map(row => ({
        id: row.id,
        vehicleId: row.vehicle_id,
        date: formatDate(row.date),
        litres: row.litres ? Number(row.litres) : null,
        cost: Number(row.cost),
        mileageAtFill: row.mileage_at_fill as number | null,
        fullTank: row.full_tank as boolean,
        receiptFile: row.receipt_file,
        notes: row.notes,
        createdBy: row.created_by,
        createdByName: row.created_by_name,
        createdAt: row.created_at ? (row.created_at as Date).toISOString() : null,
      })),
      total: Number(countResult.rows[0]?.count || 0),
      stats: {
        totalCost: s.total_cost ? Number(s.total_cost) : 0,
        totalLitres: s.total_litres ? Number(s.total_litres) : 0,
        fillCount: Number(s.fill_count || 0),
        costPerMile,
      },
    });
  } catch (error) {
    console.error('[vehicles/fuel] List error:', error);
    res.status(500).json({ error: 'Failed to load fuel log' });
  }
});

/**
 * POST /api/vehicles/fleet/:vehicleId/fuel
 * Record a fuel fill.
 */
router.post('/fleet/:vehicleId/fuel', async (req: AuthRequest, res: Response) => {
  try {
    const { vehicleId } = req.params;
    const { date, litres, cost, mileage_at_fill, full_tank = false, notes } = req.body;
    const userId = req.user?.id || null;

    if (!cost || !date) {
      res.status(400).json({ error: 'date and cost are required' });
      return;
    }

    const result = await query(
      `INSERT INTO vehicle_fuel_log (vehicle_id, date, litres, cost, mileage_at_fill, full_tank, notes, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
      [vehicleId, date, litres || null, cost, mileage_at_fill || null, full_tank, notes || null, userId]
    );

    // If mileage provided, also log to mileage_log
    if (mileage_at_fill && Number(mileage_at_fill) > 0) {
      await query(
        `INSERT INTO vehicle_mileage_log (vehicle_id, mileage, source, source_ref, recorded_by)
         VALUES ($1, $2, 'fuel', $3, $4)`,
        [vehicleId, mileage_at_fill, result.rows[0].id, userId]
      ).catch(() => {});
      await query(
        `UPDATE fleet_vehicles SET current_mileage = $1, last_mileage_update = NOW()
         WHERE id = $2 AND (current_mileage IS NULL OR current_mileage < $1)`,
        [mileage_at_fill, vehicleId]
      ).catch(() => {});
    }

    res.status(201).json(result.rows[0]);
  } catch (error) {
    console.error('[vehicles/fuel] Create error:', error);
    res.status(500).json({ error: 'Failed to record fuel' });
  }
});

/**
 * DELETE /api/vehicles/fleet/:vehicleId/fuel/:fuelId
 */
router.delete('/fleet/:vehicleId/fuel/:fuelId', async (req: AuthRequest, res: Response) => {
  try {
    const { vehicleId, fuelId } = req.params;
    const result = await query(
      'DELETE FROM vehicle_fuel_log WHERE id = $1 AND vehicle_id = $2 RETURNING id',
      [fuelId, vehicleId]
    );
    if (result.rows.length === 0) {
      res.status(404).json({ error: 'Fuel record not found' });
      return;
    }
    res.status(204).send();
  } catch (error) {
    console.error('[vehicles/fuel] Delete error:', error);
    res.status(500).json({ error: 'Failed to delete fuel record' });
  }
});

/**
 * GET /api/vehicles/fleet-costs
 * Fleet-wide cost report — aggregates service + fuel costs per vehicle.
 * Query params: from, to (YYYY-MM-DD)
 */
router.get('/fleet-costs', async (req: AuthRequest, res: Response) => {
  try {
    const role = req.user?.role;
    if (role !== 'admin' && role !== 'manager') {
      res.status(403).json({ error: 'Admin or manager role required' });
      return;
    }

    const { from, to } = req.query;
    const fromDate = from ? String(from) : new Date(new Date().getFullYear(), 0, 1).toISOString().split('T')[0];
    const toDate = to ? String(to) : new Date().toISOString().split('T')[0];

    // Service costs by vehicle
    const serviceCosts = await query(
      `SELECT fv.id, fv.reg, fv.make, fv.model, fv.simple_type,
              COALESCE(SUM(sl.cost), 0) AS service_total,
              COUNT(sl.id) AS service_count
       FROM fleet_vehicles fv
       LEFT JOIN vehicle_service_log sl ON sl.vehicle_id = fv.id
         AND sl.service_date BETWEEN $1 AND $2
       WHERE fv.is_active = true AND fv.fleet_group != 'old_sold'
       GROUP BY fv.id, fv.reg, fv.make, fv.model, fv.simple_type
       ORDER BY fv.reg`,
      [fromDate, toDate]
    );

    // Fuel costs by vehicle
    const fuelCosts = await query(
      `SELECT vehicle_id, COALESCE(SUM(cost), 0) AS fuel_total, COUNT(*) AS fuel_count
       FROM vehicle_fuel_log
       WHERE date BETWEEN $1 AND $2
       GROUP BY vehicle_id`,
      [fromDate, toDate]
    );

    const fuelMap = new Map<string, { fuel_total: number; fuel_count: number }>();
    for (const row of fuelCosts.rows) {
      fuelMap.set(row.vehicle_id as string, {
        fuel_total: Number(row.fuel_total),
        fuel_count: Number(row.fuel_count),
      });
    }

    const report = serviceCosts.rows.map(row => {
      const fuel = fuelMap.get(row.id as string) || { fuel_total: 0, fuel_count: 0 };
      const serviceTotal = Number(row.service_total);
      return {
        vehicleId: row.id,
        reg: row.reg,
        make: row.make,
        model: row.model,
        simpleType: row.simple_type,
        serviceCost: serviceTotal,
        serviceCount: Number(row.service_count),
        fuelCost: fuel.fuel_total,
        fuelCount: fuel.fuel_count,
        totalCost: serviceTotal + fuel.fuel_total,
      };
    });

    // Grand totals
    const grandService = report.reduce((sum, r) => sum + r.serviceCost, 0);
    const grandFuel = report.reduce((sum, r) => sum + r.fuelCost, 0);

    res.json({
      data: report,
      period: { from: fromDate, to: toDate },
      totals: {
        serviceCost: grandService,
        fuelCost: grandFuel,
        totalCost: grandService + grandFuel,
        vehicleCount: report.length,
      },
    });
  } catch (error) {
    console.error('[vehicles/fleet-costs] Report error:', error);
    res.status(500).json({ error: 'Failed to generate cost report' });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// 7b. FLEET TURNAROUND SCHEDULE — /api/vehicles/turnaround-schedule
// ═══════════════════════════════════════════════════════════════════════════

/**
 * GET /api/vehicles/turnaround-schedule
 *
 * Van-centric forward-facing view. For each active vehicle, surface its
 * current commitment (if on hire), its next upcoming hire (if any), and the
 * prep window between the two — colour-coded by how comfortable that window
 * is. Compliance flags (MOT/Tax/Insurance/TFL) falling inside the visible
 * range are surfaced alongside.
 *
 * Read-only. Does NOT mutate state. Pairs with AllocationsPage rather than
 * replacing it: allocation lives there (job-centric), prep planning lives
 * here (van-centric). Same underlying data.
 *
 * Query params (all optional):
 *   days        — window length, 7 / 14 / 28 (default 14)
 *   state       — all | on_hire | prep_needed | available (default all)
 *   compliance  — all | flagged (default all — has any MOT/Tax/Insurance/TFL in window)
 *   has_next    — all | yes | no (default all — has a future assignment)
 *   sort        — urgency | returning_soonest | going_out_soonest | reg (default urgency)
 *   q           — partial reg search (case-insensitive)
 *
 * "Forward commitment" statuses on an assignment (per assignment-overlap.ts):
 *   soft, confirmed, booked_out, active
 *
 * Prep window measured against the LINKED job's `return_date` (which already
 * includes Ooosh's +1 day turnaround buffer) — falling back to the
 * assignment's own `hire_end` if no linked job. This matches the realistic
 * warehouse window staff live with, not the theoretical end of charge.
 */
router.get('/turnaround-schedule', async (req: AuthRequest, res: Response) => {
  try {
    const daysParam = Math.max(1, Math.min(60, parseInt(String(req.query.days || '14'), 10) || 14));
    const stateFilter = String(req.query.state || 'all');
    const complianceFilter = String(req.query.compliance || 'all');
    const hasNextFilter = String(req.query.has_next || 'all');
    const sortMode = String(req.query.sort || 'urgency');
    const searchQuery = String(req.query.q || '').trim().toLowerCase();

    // Fetch threshold settings (with fallback defaults if not seeded yet).
    const thresholdResult = await query(
      `SELECT key, value FROM vehicle_compliance_settings
       WHERE key IN (
         'prep_window_amber_threshold_days',
         'prep_window_orange_threshold_days',
         'prep_window_red_threshold_days',
         'mot_warning_days',
         'tax_warning_days',
         'insurance_warning_days'
       )`,
    );
    const settings: Record<string, number> = {
      prep_window_amber_threshold_days: 2,
      prep_window_orange_threshold_days: 1,
      prep_window_red_threshold_days: 0,
      mot_warning_days: 30,
      tax_warning_days: 30,
      insurance_warning_days: 30,
    };
    for (const row of thresholdResult.rows) {
      try {
        const parsed = JSON.parse(row.value as string);
        if (typeof parsed === 'number') settings[row.key as string] = parsed;
      } catch {
        // ignore — fallback already set
      }
    }

    // Pull active vehicles + forward-looking assignments in a single query.
    // The LEFT JOIN to jobs uses the dual match pattern (job_id OR hh_job_number)
    // so V&D staff-allocation rows (which carry only hirehop_job_id) surface
    // alongside hire-form rows.
    const vehiclesResult = await query(`
      SELECT
        fv.id,
        fv.reg,
        fv.simple_type,
        fv.hire_status,
        fv.mot_due,
        fv.tax_due,
        fv.insurance_due,
        fv.tfl_due,
        fv.current_mileage,
        fv.next_service_due,
        fv.needs_external_wash
      FROM fleet_vehicles fv
      WHERE fv.is_active = true
        AND COALESCE(fv.fleet_group, 'active') = 'active'
      ORDER BY fv.reg
    `);

    type VehicleRow = {
      id: string;
      reg: string;
      simple_type: string | null;
      hire_status: string | null;
      mot_due: string | null;
      tax_due: string | null;
      insurance_due: string | null;
      tfl_due: string | null;
      current_mileage: number | null;
      next_service_due: number | null;
      needs_external_wash: boolean | null;
    };
    const vehicles = vehiclesResult.rows as VehicleRow[];
    if (vehicles.length === 0) {
      res.json({ data: [], thresholds: settings, total: 0 });
      return;
    }

    const vehicleIds = vehicles.map(v => v.id);

    // Forward-looking assignments per van. Include anything whose effective
    // end is today or later — this captures both "currently out" (booked_out
    // / active) and "upcoming" (soft / confirmed) rows.
    const assignmentsResult = await query(`
      SELECT
        vha.id            AS assignment_id,
        vha.vehicle_id    AS vehicle_id,
        vha.status        AS status,
        vha.hire_start    AS asg_hire_start,
        vha.hire_end      AS asg_hire_end,
        vha.booked_out_at AS booked_out_at,
        vha.checked_in_at AS checked_in_at,
        vha.status_changed_at AS status_changed_at,
        vha.job_id        AS job_id,
        vha.hirehop_job_id AS hirehop_job_id,
        j.id              AS job_uuid,
        j.hh_job_number   AS job_number,
        j.job_name        AS job_name,
        j.client_name     AS client_name,
        j.job_date        AS job_date,
        j.job_end         AS job_end_date,
        j.return_date     AS job_return_date,
        j.pipeline_status AS pipeline_status
      FROM vehicle_hire_assignments vha
      LEFT JOIN jobs j ON (
        (vha.job_id IS NOT NULL AND j.id = vha.job_id)
        OR (vha.job_id IS NULL AND j.hh_job_number = vha.hirehop_job_id)
      )
      WHERE vha.vehicle_id = ANY($1::uuid[])
        AND vha.status IN ('soft', 'confirmed', 'booked_out', 'active')
        AND COALESCE(j.return_date, j.job_end, vha.hire_end) >= CURRENT_DATE
      ORDER BY vha.vehicle_id, COALESCE(vha.hire_start, j.job_date) ASC NULLS LAST
    `, [vehicleIds]);

    type AssignmentRow = {
      assignment_id: string;
      vehicle_id: string;
      status: 'soft' | 'confirmed' | 'booked_out' | 'active';
      asg_hire_start: string | null;
      asg_hire_end: string | null;
      booked_out_at: string | null;
      checked_in_at: string | null;
      status_changed_at: string | null;
      job_id: string | null;
      hirehop_job_id: number | null;
      job_uuid: string | null;
      job_number: number | null;
      job_name: string | null;
      client_name: string | null;
      job_date: string | null;
      job_end_date: string | null;
      job_return_date: string | null;
      pipeline_status: string | null;
    };

    // Group assignments by vehicle, then dedupe by job within each van.
    //
    // BUG GUARD (May 2026): self-drive client hires can land TWO assignment
    // rows for the same (vehicle, job) pair — one created when staff
    // allocated the van (status='confirmed') and one when the customer
    // submitted their hire form (status='booked_out'). Both pass the
    // "forward commitment" filter. Without dedup, the booked_out row
    // becomes "current" and the confirmed row becomes "next" — surfacing
    // the SAME job as both "coming back" and "going out next".
    //
    // Dedup rule: per (vehicle, job-key), keep one row. Job-key is the
    // OP UUID when present, otherwise the HH job number, otherwise fall
    // back to the assignment ID (so unlinked rows stay distinct). Winner
    // is the most-progressed status (active > booked_out > confirmed > soft),
    // tie-broken by latest status_changed_at.
    const STATUS_RANK: Record<AssignmentRow['status'], number> = {
      active: 4,
      booked_out: 3,
      confirmed: 2,
      soft: 1,
    };
    function jobKey(a: AssignmentRow): string {
      if (a.job_uuid) return `uuid:${a.job_uuid}`;
      if (a.hirehop_job_id) return `hh:${a.hirehop_job_id}`;
      return `asg:${a.assignment_id}`;
    }
    function pickWinner(a: AssignmentRow, b: AssignmentRow): AssignmentRow {
      if (STATUS_RANK[a.status] !== STATUS_RANK[b.status]) {
        return STATUS_RANK[a.status] > STATUS_RANK[b.status] ? a : b;
      }
      const at = a.status_changed_at ? new Date(a.status_changed_at).getTime() : 0;
      const bt = b.status_changed_at ? new Date(b.status_changed_at).getTime() : 0;
      return at >= bt ? a : b;
    }

    const byVehicle = new Map<string, AssignmentRow[]>();
    for (const row of assignmentsResult.rows as AssignmentRow[]) {
      const list = byVehicle.get(row.vehicle_id) || [];
      list.push(row);
      byVehicle.set(row.vehicle_id, list);
    }
    // Dedup pass per van.
    for (const [vid, rows] of byVehicle.entries()) {
      const byJob = new Map<string, AssignmentRow>();
      for (const r of rows) {
        const k = jobKey(r);
        const existing = byJob.get(k);
        byJob.set(k, existing ? pickWinner(existing, r) : r);
      }
      // Preserve hire_start ordering (the original SQL ORDER BY).
      // pg returns TIMESTAMPTZ as JS Date — sort numerically by epoch so the
      // comparator works whether the column comes back as Date or string.
      // NULL hire_start AND NULL job_date sorts last.
      const deduped = Array.from(byJob.values()).sort((a, b) => {
        const at = a.asg_hire_start ? new Date(a.asg_hire_start).getTime()
          : (a.job_date ? new Date(a.job_date).getTime() : Number.MAX_SAFE_INTEGER);
        const bt = b.asg_hire_start ? new Date(b.asg_hire_start).getTime()
          : (b.job_date ? new Date(b.job_date).getTime() : Number.MAX_SAFE_INTEGER);
        return at - bt;
      });
      byVehicle.set(vid, deduped);
    }

    // Helpers for date math.
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const windowEnd = new Date(today);
    windowEnd.setDate(windowEnd.getDate() + daysParam);

    function parseDate(s: string | null): Date | null {
      if (!s) return null;
      const d = new Date(s);
      return isNaN(d.getTime()) ? null : d;
    }
    function diffDays(later: Date, earlier: Date): number {
      const ms = later.getTime() - earlier.getTime();
      return Math.round(ms / (1000 * 60 * 60 * 24));
    }
    function fmtDate(d: Date): string {
      return d.toISOString().slice(0, 10);
    }

    // Resolve per-assignment effective dates (assignment override > job).
    function resolveAssignmentDates(a: AssignmentRow): { start: Date | null; end: Date | null } {
      const start = parseDate(a.asg_hire_start) || parseDate(a.job_date);
      // For end: prefer job.return_date (includes +1 buffer) → job_end → asg.hire_end
      const end = parseDate(a.job_return_date) || parseDate(a.job_end_date) || parseDate(a.asg_hire_end);
      return { start, end };
    }

    // Compute prep window urgency.
    function urgencyForWindow(days: number | null): 'green' | 'amber' | 'orange' | 'red' | 'none' {
      if (days === null) return 'none';
      if (days <= settings.prep_window_red_threshold_days) return 'red';
      if (days <= settings.prep_window_orange_threshold_days) return 'orange';
      if (days <= settings.prep_window_amber_threshold_days) return 'amber';
      return 'green';
    }

    type Assignment = {
      id: string;
      status: AssignmentRow['status'];
      jobId: string | null;
      hhJobNumber: number | null;
      jobName: string | null;
      clientName: string | null;
      pipelineStatus: string | null;
      hireStart: string | null;
      hireEnd: string | null;
    };

    type ComplianceFlag = {
      kind: 'MOT' | 'Tax' | 'Insurance' | 'TFL';
      date: string;
      daysUntil: number;
      urgency: 'soon' | 'overdue';
    };

    type Row = {
      vehicleId: string;
      reg: string;
      simpleType: string | null;
      hireStatus: string | null;
      currentHire: Assignment | null;
      nextHire: Assignment | null;
      comingBack: string | null; // ISO date
      goingOutNext: string | null; // ISO date
      prepWindowDays: number | null;
      prepUrgency: 'green' | 'amber' | 'orange' | 'red' | 'none';
      complianceFlags: ComplianceFlag[];
      needsExternalWash: boolean;
    };

    const rows: Row[] = vehicles.map((v) => {
      const assignments = byVehicle.get(v.id) || [];

      // Categorise into current (booked_out / active) and upcoming (everything else).
      // There should be at most one current per van.
      let currentRow: AssignmentRow | null = null;
      const upcomingRows: AssignmentRow[] = [];
      for (const a of assignments) {
        if (a.status === 'booked_out' || a.status === 'active') {
          // If multiple current somehow, pick the one with the latest status_changed_at.
          if (!currentRow) currentRow = a;
          else if (a.status_changed_at && currentRow.status_changed_at
            && new Date(a.status_changed_at) > new Date(currentRow.status_changed_at)) {
            currentRow = a;
          }
        } else {
          upcomingRows.push(a);
        }
      }

      // Pick the earliest upcoming (already sorted by hire_start ASC).
      const nextRow = upcomingRows[0] || null;

      const current = currentRow ? (() => {
        const { start, end } = resolveAssignmentDates(currentRow);
        const a: Assignment = {
          id: currentRow.assignment_id,
          status: currentRow.status,
          jobId: currentRow.job_uuid,
          hhJobNumber: currentRow.job_number,
          jobName: currentRow.job_name,
          clientName: currentRow.client_name,
          pipelineStatus: currentRow.pipeline_status,
          hireStart: start ? fmtDate(start) : null,
          hireEnd: end ? fmtDate(end) : null,
        };
        return a;
      })() : null;

      const next = nextRow ? (() => {
        const { start, end } = resolveAssignmentDates(nextRow);
        const a: Assignment = {
          id: nextRow.assignment_id,
          status: nextRow.status,
          jobId: nextRow.job_uuid,
          hhJobNumber: nextRow.job_number,
          jobName: nextRow.job_name,
          clientName: nextRow.client_name,
          pipelineStatus: nextRow.pipeline_status,
          hireStart: start ? fmtDate(start) : null,
          hireEnd: end ? fmtDate(end) : null,
        };
        return a;
      })() : null;

      // Compute prep window. Only meaningful when we have both a current
      // return date and a next hire start.
      let prepWindowDays: number | null = null;
      if (current?.hireEnd && next?.hireStart) {
        const returnDate = parseDate(current.hireEnd)!;
        const nextStart = parseDate(next.hireStart)!;
        prepWindowDays = diffDays(nextStart, returnDate);
      }
      // If no current hire (van is here now) but has a next, the "prep
      // window" is from today to next start — still useful operationally.
      if (!current && next?.hireStart) {
        const nextStart = parseDate(next.hireStart)!;
        prepWindowDays = diffDays(nextStart, today);
      }

      // Compliance flags within the visible window.
      const complianceChecks: { kind: ComplianceFlag['kind']; date: string | null }[] = [
        { kind: 'MOT', date: v.mot_due },
        { kind: 'Tax', date: v.tax_due },
        { kind: 'Insurance', date: v.insurance_due },
        { kind: 'TFL', date: v.tfl_due },
      ];
      const flags: ComplianceFlag[] = [];
      for (const check of complianceChecks) {
        const d = parseDate(check.date);
        if (!d) continue;
        const days = diffDays(d, today);
        // Show if overdue OR falls within the visible window.
        if (days < 0) {
          flags.push({ kind: check.kind, date: check.date!, daysUntil: days, urgency: 'overdue' });
        } else if (days <= daysParam) {
          flags.push({ kind: check.kind, date: check.date!, daysUntil: days, urgency: 'soon' });
        }
      }

      return {
        vehicleId: v.id,
        reg: v.reg,
        simpleType: v.simple_type,
        hireStatus: v.hire_status,
        currentHire: current,
        nextHire: next,
        comingBack: current?.hireEnd || null,
        goingOutNext: next?.hireStart || null,
        prepWindowDays,
        prepUrgency: urgencyForWindow(prepWindowDays),
        complianceFlags: flags,
        needsExternalWash: v.needs_external_wash === true,
      } as Row;
    });

    // Apply filters.
    let filtered = rows;
    if (stateFilter !== 'all') {
      const stateMap: Record<string, string> = {
        on_hire: 'On Hire',
        prep_needed: 'Prep Needed',
        available: 'Available',
      };
      const target = stateMap[stateFilter];
      if (target) filtered = filtered.filter(r => r.hireStatus === target);
    }
    if (complianceFilter === 'flagged') {
      filtered = filtered.filter(r => r.complianceFlags.length > 0);
    }
    if (hasNextFilter === 'yes') {
      filtered = filtered.filter(r => r.nextHire !== null);
    } else if (hasNextFilter === 'no') {
      filtered = filtered.filter(r => r.nextHire === null);
    }
    if (searchQuery) {
      filtered = filtered.filter(r => r.reg.toLowerCase().includes(searchQuery));
    }

    // Sort.
    function dateAsc(a: string | null, b: string | null): number {
      if (!a && !b) return 0;
      if (!a) return 1;
      if (!b) return -1;
      return a.localeCompare(b);
    }
    if (sortMode === 'returning_soonest') {
      filtered.sort((a, b) => dateAsc(a.comingBack, b.comingBack) || a.reg.localeCompare(b.reg));
    } else if (sortMode === 'going_out_soonest') {
      filtered.sort((a, b) => dateAsc(a.goingOutNext, b.goingOutNext) || a.reg.localeCompare(b.reg));
    } else if (sortMode === 'reg') {
      filtered.sort((a, b) => a.reg.localeCompare(b.reg));
    } else {
      // urgency (default): shortest prep window first, NULLs last. Ties → next hire start.
      filtered.sort((a, b) => {
        const aw = a.prepWindowDays;
        const bw = b.prepWindowDays;
        if (aw === null && bw === null) return dateAsc(a.goingOutNext, b.goingOutNext) || a.reg.localeCompare(b.reg);
        if (aw === null) return 1;
        if (bw === null) return -1;
        if (aw !== bw) return aw - bw;
        return dateAsc(a.goingOutNext, b.goingOutNext) || a.reg.localeCompare(b.reg);
      });
    }

    res.json({
      data: filtered,
      thresholds: {
        amber: settings.prep_window_amber_threshold_days,
        orange: settings.prep_window_orange_threshold_days,
        red: settings.prep_window_red_threshold_days,
      },
      window: {
        days: daysParam,
        startISO: fmtDate(today),
        endISO: fmtDate(windowEnd),
      },
      total: rows.length,
      filtered: filtered.length,
    });
  } catch (error) {
    console.error('[vehicles/turnaround-schedule] Error:', error);
    res.status(500).json({ error: 'Failed to load turnaround schedule' });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// 8. COMPLIANCE SETTINGS — /api/vehicles/compliance/*
// ═══════════════════════════════════════════════════════════════════════════

/**
 * GET /api/vehicles/compliance/settings
 * Return all compliance settings.
 */
router.get('/compliance/settings', async (_req: AuthRequest, res: Response) => {
  try {
    const result = await query('SELECT key, value, updated_at FROM vehicle_compliance_settings ORDER BY key');
    const settings: Record<string, unknown> = {};
    for (const row of result.rows) {
      try {
        settings[row.key as string] = JSON.parse(row.value as string);
      } catch {
        settings[row.key as string] = row.value;
      }
    }
    res.json(settings);
  } catch (error) {
    console.error('[vehicles/compliance] Settings fetch error:', error);
    res.status(500).json({ error: 'Failed to load compliance settings' });
  }
});

/**
 * PUT /api/vehicles/compliance/settings
 * Update compliance settings (admin/manager only).
 * Body: { key: value, key: value, ... }
 */
router.put('/compliance/settings', async (req: AuthRequest, res: Response) => {
  try {
    const role = req.user?.role;
    if (role !== 'admin' && role !== 'manager') {
      res.status(403).json({ error: 'Admin or manager role required' });
      return;
    }

    const updates = req.body as Record<string, unknown>;
    const userId = req.user!.id;

    for (const [key, value] of Object.entries(updates)) {
      await query(
        `INSERT INTO vehicle_compliance_settings (key, value, updated_at, updated_by)
         VALUES ($1, $2::jsonb, NOW(), $3)
         ON CONFLICT (key) DO UPDATE SET value = $2::jsonb, updated_at = NOW(), updated_by = $3`,
        [key, JSON.stringify(value), userId]
      );
    }

    res.json({ ok: true });
  } catch (error) {
    console.error('[vehicles/compliance] Settings update error:', error);
    res.status(500).json({ error: 'Failed to update compliance settings' });
  }
});

/**
 * GET /api/vehicles/compliance/check
 * Run compliance check on demand (returns alerts without creating notifications).
 */
router.get('/compliance/check', async (_req: AuthRequest, res: Response) => {
  try {
    const { runComplianceCheck } = await import('../services/compliance-checker');
    const result = await runComplianceCheck(false);
    res.json(result);
  } catch (error) {
    console.error('[vehicles/compliance] Check error:', error);
    res.status(500).json({ error: 'Failed to run compliance check' });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// NETLIFY PROXY CATCH-ALL (for remaining VM functions not yet migrated)
// ═══════════════════════════════════════════════════════════════════════════

const NETLIFY_BASE = process.env.VEHICLE_MODULE_URL || 'https://ooosh-vehicles.netlify.app';

router.all('/:functionName', proxyToNetlify);
router.all('/:functionName/*', proxyToNetlify);

async function proxyToNetlify(req: Request, res: Response): Promise<void> {
  const functionName = req.params.functionName as string;

  // Don't proxy routes we handle natively
  if (['fleet', 'jobs', 'hirehop'].includes(functionName)) {
    res.status(404).json({ error: 'Not found' });
    return;
  }

  const subPath = req.params[0] ? `/${req.params[0]}` : '';
  const netlifyUrl = `${NETLIFY_BASE}/.netlify/functions/${functionName}${subPath}`;
  const queryString = new URL(req.url, 'http://localhost').search;
  const targetUrl = `${netlifyUrl}${queryString}`;

  try {
    const headers: Record<string, string> = {
      'Content-Type': req.headers['content-type'] || 'application/json',
    };

    if (req.headers.authorization) {
      headers['Authorization'] = req.headers.authorization as string;
    }

    const authReq = req as AuthRequest;
    if (authReq.user) {
      headers['X-OP-User-Id'] = authReq.user.id;
      headers['X-OP-User-Email'] = authReq.user.email;
      headers['X-OP-User-Role'] = authReq.user.role;
    }

    const fetchOptions: RequestInit = {
      method: req.method,
      headers,
    };

    if (req.method !== 'GET' && req.method !== 'HEAD' && req.body) {
      fetchOptions.body = JSON.stringify(req.body);
    }

    const response = await fetch(targetUrl, fetchOptions);
    res.status(response.status);

    const contentType = response.headers.get('content-type');
    if (contentType) {
      res.setHeader('Content-Type', contentType);
    }

    const body = await response.text();
    res.send(body);
  } catch (error) {
    console.error(`[Vehicle Proxy] Error forwarding to ${targetUrl}:`, error);
    res.status(502).json({
      error: 'Vehicle Module proxy error',
      detail: error instanceof Error ? error.message : 'Unknown error',
    });
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// MAPPERS
// ═══════════════════════════════════════════════════════════════════════════

/** Map a fleet_vehicles DB row to the VM's Vehicle interface shape */
function mapDbRowToVehicle(row: Record<string, unknown>, opts: { includeFinance?: boolean } = {}) {
  // Finance is admin-only — stripped unless the caller explicitly opts in
  // (default false so any new call site fails closed rather than leaking).
  const includeFinance = opts.includeFinance === true;
  const num = (v: unknown) => (v == null || v === '' ? null : Number(v));
  const fin = <T,>(v: T): T | null => (includeFinance ? v : null);

  // Finance agreement figures + derived totals (see migration 104).
  const cashPrice = num(row.cash_price);
  const depositPaid = num(row.deposit_paid);
  const amountFinanced = num(row.amount_financed);
  const monthlyPayment = num(row.monthly_payment);
  const financeTermMonths = num(row.finance_term_months);
  const financeFees = Array.isArray(row.finance_fees)
    ? (row.finance_fees as Array<{ label?: string; amount?: number }>)
    : [];
  const financeFeesTotal = financeFees.reduce((s, f) => s + (Number(f.amount) || 0), 0);
  const repayments = (monthlyPayment || 0) * (financeTermMonths || 0);
  const isFinanced = repayments > 0 || (amountFinanced || 0) > 0;
  // Total ACTUALLY paid over the van's life: financed → deposit + repayments +
  // fees; owned outright → cash price + fees. Null when nothing's entered.
  const anyFinanceData =
    cashPrice != null || depositPaid != null || amountFinanced != null ||
    monthlyPayment != null || financeTermMonths != null || financeFees.length > 0;
  const totalPayable = !anyFinanceData
    ? null
    : isFinanced
      ? (depositPaid || 0) + repayments + financeFeesTotal
      : (cashPrice || 0) + financeFeesTotal;
  // The financing premium over the cash price (only meaningful when financed
  // AND a cash price was recorded).
  const costOfFinance =
    isFinanced && cashPrice != null && totalPayable != null ? totalPayable - cashPrice : null;

  // Files: strip finance-flagged docs for non-admins so they never reach a
  // non-admin browser (the general Files UI also filters them out for everyone
  // so they only surface in the admin Finance section).
  const rawFiles = Array.isArray(row.files) ? (row.files as Array<Record<string, unknown>>) : [];
  const files = includeFinance ? rawFiles : rawFiles.filter(f => f.is_finance !== true);

  return {
    id: row.id as string,
    reg: row.reg as string,
    vehicleType: (row.vehicle_type as string) || '',
    simpleType: (row.simple_type as string) || '',
    gearbox: (row.gearbox as string | null) || null,
    make: (row.make as string) || '',
    model: (row.model as string) || '',
    colour: (row.colour as string) || '',
    seats: row.seats as number | null,
    damageStatus: (row.damage_status as string) || '',
    serviceStatus: (row.service_status as string) || '',
    hireStatus: (row.hire_status as string) || '',
    motDue: formatDate(row.mot_due),
    taxDue: formatDate(row.tax_due),
    tflDue: formatDate(row.tfl_due),
    lastServiceDate: formatDate(row.last_service_date),
    warrantyExpires: formatDate(row.warranty_expires),
    lastServiceMileage: row.last_service_mileage as number | null,
    nextServiceDue: row.next_service_due as number | null,
    ulezCompliant: row.ulez_compliant as boolean,
    spareKey: row.spare_key as boolean,
    wifiNetwork: row.wifi_network as string | null,
    // "Needs external wash" marker — carwash to-do, not a fault (migration 114)
    needsExternalWash: row.needs_external_wash === true,
    // Finance (admin-only — null for non-admins)
    financeWith: fin(row.finance_with as string | null),
    financeEnds: fin(formatDate(row.finance_ends)),
    financeStart: fin(formatDate(row.finance_start)),
    financeReference: fin(row.finance_reference as string | null),
    cashPrice: fin(cashPrice),
    depositPaid: fin(depositPaid),
    amountFinanced: fin(amountFinanced),
    monthlyPayment: fin(monthlyPayment),
    financeTermMonths: fin(financeTermMonths),
    financeFees: includeFinance ? financeFees : [],
    financeFeesTotal: fin(financeFeesTotal),
    totalPayable: fin(totalPayable),
    costOfFinance: fin(costOfFinance),
    salePrice: fin(num(row.sale_price)),
    saleNotes: fin(row.sale_notes as string | null),
    // Disposal + removal — operational, visible to all staff
    soldDate: formatDate(row.sold_date),
    removalChecklist: Array.isArray(row.removal_checklist) ? row.removal_checklist : [],
    co2PerKm: row.co2_per_km ? Number(row.co2_per_km) : null,
    recommendedTyrePsiFront: row.recommended_tyre_psi_front ? Number(row.recommended_tyre_psi_front) : null,
    recommendedTyrePsiRear: row.recommended_tyre_psi_rear ? Number(row.recommended_tyre_psi_rear) : null,
    isOldSold: (row.fleet_group as string) === 'old_sold',
    // Extra fields not in VM's original Vehicle but useful
    fuelType: row.fuel_type as string | null,
    mpg: row.mpg ? Number(row.mpg) : null,
    fleetGroup: row.fleet_group as string,
    isActive: row.is_active as boolean,
    mondayItemId: row.monday_item_id as string | null,
    // Insurance
    insuranceDue: formatDate(row.insurance_due),
    insuranceProvider: row.insurance_provider as string | null,
    insurancePolicyNumber: row.insurance_policy_number as string | null,
    // Booked-in dates
    motBookedInDate: formatDate(row.mot_booked_in_date),
    serviceBookedInDate: formatDate(row.service_booked_in_date),
    insuranceBookedInDate: formatDate(row.insurance_booked_in_date),
    taxBookedInDate: formatDate(row.tax_booked_in_date),
    // Mileage
    currentMileage: row.current_mileage as number | null,
    lastMileageUpdate: row.last_mileage_update ? (row.last_mileage_update as Date).toISOString() : null,
    // V5 / VE103B fields
    vin: row.vin as string | null,
    dateFirstReg: formatDate(row.date_first_reg),
    v5Type: row.v5_type as string | null,
    bodyType: row.body_type as string | null,
    maxMassKg: row.max_mass_kg as number | null,
    vehicleCategory: row.vehicle_category as string | null,
    cylinderCapacityCc: row.cylinder_capacity_cc as number | null,
    // Extended details (migration 015)
    oilType: row.oil_type as string | null,
    coolantType: row.coolant_type as string | null,
    tyreSize: row.tyre_size as string | null,
    lastRossettsServiceDate: formatDate(row.last_rossetts_service_date),
    lastRossettsServiceNotes: row.last_rossetts_service_notes as string | null,
    servicePlanStatus: row.service_plan_status as string | null,
    rossettsApplicable: row.rossetts_applicable === true,
    seatLayout: row.seat_layout as string | null,
    notes: (row.notes as string | null) ?? null,
    setupChecklist: Array.isArray(row.setup_checklist) ? row.setup_checklist : [],
    files,
  };
}

/**
 * Map an OP jobs row to the VM's HireHopJob interface shape.
 * Note: items[] will be empty — line item data is fetched separately
 * via the HireHop items_to_supply_list endpoint when needed.
 */
function mapJobRowToHireHopJob(row: Record<string, unknown>) {
  const HIREHOP_STATUS_LABELS: Record<number, string> = {
    0: 'Enquiry', 1: 'Provisional', 2: 'Booked', 3: 'Prepped',
    4: 'Part Dispatched', 5: 'Dispatched', 6: 'Returned Incomplete',
    7: 'Returned', 8: 'Requires Attention', 9: 'Cancelled',
    10: 'Not Interested', 11: 'Completed',
  };

  const status = Number(row.status ?? 0);

  return {
    id: row.hh_job_number as number,
    jobName: (row.job_name as string) || '',
    company: (row.company_name as string) || (row.client_name as string) || '',
    contactName: (row.client_name as string) || '',
    contactEmail: '', // Not stored in OP jobs table — fetched from HireHop on demand if needed
    status,
    statusLabel: HIREHOP_STATUS_LABELS[status] || 'Unknown',
    outDate: formatDate(row.out_date),
    jobDate: formatDate(row.job_date),
    jobEndDate: formatDate(row.job_end),
    returnDate: formatDate(row.return_date),
    items: Array.isArray(row.line_items) ? row.line_items : (typeof row.line_items === 'string' ? JSON.parse(row.line_items) : []),
    depot: row.depot_name ? null : null, // OP stores depot_name (string), not depot ID
    notes: row.notes as string | null,
  };
}

/** Format a date value to YYYY-MM-DD string */
function formatDate(val: unknown): string {
  if (!val) return '';
  // Handle Date objects (returned by pg for DATE/TIMESTAMP columns)
  if (val instanceof Date) {
    const y = val.getFullYear();
    const m = String(val.getMonth() + 1).padStart(2, '0');
    const d = String(val.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }
  const s = String(val);
  const match = s.match(/^(\d{4}-\d{2}-\d{2})/);
  return match ? match[1]! : '';
}

export default router;
