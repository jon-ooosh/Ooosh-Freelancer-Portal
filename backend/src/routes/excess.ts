/**
 * Excess Routes — Insurance excess financial lifecycle tracking.
 *
 * Manages the excess amount required for self-drive hires:
 * needed → taken → (fully_claimed | partially_reimbursed | reimbursed | rolled_over)
 *
 * Also handles excess rules (points-based tiers, referral triggers)
 * and the client excess ledger (running balance per client).
 */
import { Router, Response } from 'express';
import { z } from 'zod';
import { query } from '../config/database';
import { sendExcessEmail } from '../services/money-emails';
import { syncExcessRequirementStatus } from '../services/excess-requirement-sync';
import { authenticate, authorize, AuthRequest, STAFF_ROLES, MANAGER_ROLES } from '../middleware/auth';
import { validate } from '../middleware/validate';
import { emailService } from '../services/email-service';
import { hhBroker } from '../services/hirehop-broker';
import { pushDepositToHH, HH_BANK_IDS } from '../services/hh-deposit';
import { getStripeClient, isStripeConfigured, isStripeError } from '../config/stripe';
import { encryptJson, tryDecryptJson, isEncryptionConfigured } from '../services/encryption';
import { createMobileUploadToken } from '../services/mobile-upload-token';
import { attachExcessReceipt } from '../services/excess-receipt';

const router = Router();
router.use(authenticate);
// Whole-team gate — every excess endpoint requires a staff JWT (no freelancers).
// Per-route `authorize(...MANAGER_ROLES)` / `authorize('admin')` below tightens
// further for manager-tier actions (reimburse, waive, override, move, bank
// details). Everything else falls through to the staff baseline so the warehouse
// / general assistants can take excess, top it up, pre-auth, capture/claim
// damage, mark holds released, attach receipts, and link HH deposits — all
// without an admin/manager bottleneck. The May 2026 RBAC widening: staff were
// being blocked from `record-preauth` / `capture` / `claim` / `receipt` /
// `link-deposit` / `unlink-deposit` because those carried inline admin/manager
// gates. Removed. Reimburse / waive / override / move / bank-details reads
// stay restricted (money out the door + PII).
router.use(authorize(...STAFF_ROLES));

// ── Schemas ──

const updateExcessSchema = z.object({
  excess_amount_required: z.number().min(0).nullable().optional(),
  excess_amount_taken: z.number().min(0).optional(),
  excess_calculation_basis: z.string().nullable().optional(),
  excess_status: z.enum(['not_required', 'needed', 'taken', 'partially_paid', 'pre_auth', 'released', 'waived', 'fully_claimed', 'partially_reimbursed', 'reimbursed', 'rolled_over']).optional(),
  payment_method: z.string().max(30).nullable().optional(),
  payment_reference: z.string().max(200).nullable().optional(),
  xero_contact_id: z.string().max(100).nullable().optional(),
  xero_contact_name: z.string().max(200).nullable().optional(),
  client_name: z.string().max(200).nullable().optional(),
  held_on_account: z.boolean().optional(),
});

// Excess payment schema.
//
// `total_collected` is the new total (absolute set, not delta-add). Replaces
// the old additive `amount` to make the modal idempotent — clicking save twice
// can't double the collected amount the way it did historically.
//
// `amount` is still accepted for backwards compatibility (existing API
// consumers that haven't been updated) — when present and `total_collected`
// is absent, it's interpreted as a delta to add.
const paymentSchema = z.object({
  total_collected: z.number().min(0).optional(),
  amount: z.number().min(0).optional(),
  method: z.enum(['stripe_gbp', 'worldpay', 'amex', 'wise_bacs', 'till_cash', 'paypal', 'lloyds_bank', 'rolled_over']),
  reference: z.string().max(200).nullable().optional(),
  notes: z.string().max(1000).nullable().optional(),
  push_to_hirehop: z.boolean().default(true),
  // Soft-enforce reimburse-after-nibble: when staff tries to top up an excess
  // that already has a chain linkage (hh_deposit_id), the endpoint returns 409
  // with a chain-break warning. Setting this to true acknowledges the warning
  // and lets the call proceed (admin/manager override-style, no DB role check
  // needed — the warning itself is the gate). See Jun 2026 build notes.
  acknowledge_chain_break: z.boolean().optional(),
}).refine(
  (val) => val.total_collected !== undefined || val.amount !== undefined,
  { message: 'Either total_collected or amount must be provided' }
);

const claimSchema = z.object({
  amount: z.number().positive(),
  invoice_id: z.number().int().positive().nullable().optional(), // HH invoice ID (required for HH-linked records)
  notes: z.string().nullable().optional(),
  // Cross-job apply (CROSS-JOB-EXCESS-APPLY-SPEC): the invoice may live on a
  // DIFFERENT same-client job than the excess. When set, used for the audit
  // memo + the same-client guard. Omitted = invoice is on the excess's own job.
  target_hh_job: z.number().int().positive().nullable().optional(),
  // Bank the application is attributed to in HireHop/Xero. Confirmable in the UI,
  // defaulted from the source deposit's real bank. Omitted → resolved server-side
  // (see resolveDepositBankId). NOT hardcoded to Worldpay any more.
  bank: z.number().int().positive().nullable().optional(),
  // Manager-only escape hatch for the rare genuine cross-CLIENT apply.
  allow_cross_client: z.boolean().optional(),
});

// Capture-a-pre-auth schema (migration 087). Converts held money → taken money.
//
// Stripe-channel: triggers an API capture on the stored stripe_payment_intent_id.
// Card-machine channels (worldpay/amex/till_cash): passive record — staff captured
// on the terminal, OP just persists what happened and creates the HH deposit so
// Xero sees the money. For card machines, receipt_url should be populated with
// the R2 key of the receipt scan (mandatory in UI, soft-warned at backend level).
//
// Optional invoice_id makes this an atomic "capture & apply" — captured deposit
// gets immediately applied to a specific HH invoice (same mechanism as /claim).
// Reason: most captures correspond to a known charge (damage, underfuelling),
// so doing it one step avoids a "captured but not claimed" intermediate state.
const captureSchema = z.object({
  amount: z.number().positive(),
  method: z.enum(['stripe_gbp', 'worldpay', 'amex', 'till_cash']).default('stripe_gbp'),
  invoice_id: z.number().int().positive().nullable().optional(),
  receipt_url: z.string().max(500).nullable().optional(),
  reason: z.string().max(200).nullable().optional(),
  notes: z.string().max(1000).nullable().optional(),
});

// Release-a-pre-auth schema (migration 087). Voids a held pre-auth without
// capturing any of it. For Stripe-channel: calls stripe.paymentIntents.cancel
// (best-effort — may already be auto-voided). For card-machine: passive record;
// the acquirer's hold expires on its own clock.
const releaseSchema = z.object({
  reason: z.string().max(200).nullable().optional(),
  notes: z.string().max(1000).nullable().optional(),
});

// Record-a-pre-auth schema (PR 3). Staff-facing manual entry of a pre-auth hold
// taken on the Worldpay/Amex card machine (or cash held, or a manual Stripe
// hold). Distinct from the portal's payment-event path (which creates Stripe
// holds online). This is "I just held £1,200 on the terminal, log it as held".
//   - No money moves to our account → no HH deposit pushed here. The HH deposit
//     is created later at capture time (when the hold becomes real money).
//   - receipt_required is set TRUE for card-machine methods until a scan is added.
//   - Flows straight into the existing capture/release lifecycle.
const recordPreauthSchema = z.object({
  amount: z.number().positive(),
  method: z.enum(['worldpay', 'amex', 'till_cash', 'stripe_gbp']).default('worldpay'),
  reference: z.string().max(200).nullable().optional(), // terminal auth code, etc.
  stripe_payment_intent_id: z.string().max(200).nullable().optional(), // only if a manual Stripe hold
  expires_in_days: z.number().int().min(1).max(30).optional(), // default 5
  notes: z.string().max(1000).nullable().optional(),
});

// Receipt-scan upload schema (PR 3). receipt_url is the R2 key of an uploaded
// scan (uploaded via /api/files/upload first). Clears the receipt_required flag.
const receiptSchema = z.object({
  receipt_url: z.string().min(1).max(500),
});

// Client bank details for reimbursement (PR 3). Stored ENCRYPTED, scoped to the
// job_excess record. UK = holder + sort code + account number; international =
// holder + IBAN + SWIFT/BIC + bank country. Structured for a future Wise recipient.
const bankDetailsSchema = z.object({
  type: z.enum(['uk', 'international']),
  accountHolder: z.string().min(1).max(200),
  sortCode: z.string().max(20).optional(),
  accountNumber: z.string().max(40).optional(),
  iban: z.string().max(50).optional(),
  swiftBic: z.string().max(20).optional(),
  bankCountry: z.string().max(100).optional(),
});

const reimburseSchema = z.object({
  amount: z.number().min(0),
  method: z.enum(['stripe_gbp', 'worldpay', 'amex', 'wise_bacs', 'till_cash', 'paypal', 'lloyds_bank']),
  // Captured at reimburse time when the method is a bank transfer. Stored
  // encrypted on this record + stamps bank_details_last_used_at.
  bank_details: bankDetailsSchema.nullable().optional(),
  // When this reimbursement leaves a residual (refunding LESS than the held
  // balance), classify what happens to the remainder:
  //   false/omitted → "still owed to client" — record stays partially_reimbursed,
  //                    the residual remains HELD (we'll refund it later).
  //   true          → "retained by Ooosh" (damage/admin) — the residual is booked
  //                    as a claim (claim_amount += residual), record flips to
  //                    reimbursed, held → 0. No HH push (the money was already
  //                    applied/used in HireHop; this just classifies it in OP).
  // Without this distinction a retained residual sits as phantom-held forever —
  // OP told the client "£30 retained" but never recorded it as a claim, so the
  // canonical held formula kept showing the £30 (e.g. job 14871).
  retain_residual: z.boolean().optional(),
  // Escape hatch for the Stripe loud-fail guard. When method='stripe_gbp' but the
  // record carries no PaymentIntent we can refund against, the endpoint REFUSES
  // (422) rather than silently recording-and-emailing a refund that never reaches
  // Stripe (the silent-swallow bug behind jobs 15433/15489/15544/… — Jun 2026).
  // Setting this true is staff explicitly saying "I've already refunded this in
  // the Stripe dashboard, just record it in OP" — a deliberate record-only path.
  acknowledge_no_stripe_refund: z.boolean().optional(),
});

const waiveSchema = z.object({
  reason: z.string().min(1),
});

// "Mark as Externally Resolved" — cleanup action for records where money has
// already flowed in AND back out of OP's awareness (e.g. excess collected via
// pre-PR-630 portal flow + refunded directly in HH or Stripe before PR 4
// shipped). Sets both excess_amount_taken AND reimbursement_amount to `amount`
// in one step, flips to `reimbursed`, no HH push. Requires a reason for audit.
// See the May 2026 Jonathan Morley / RX22SWN incident for the canonical use case.
const externallyResolvedSchema = z.object({
  amount: z.number().min(0.01),
  method: z.enum(['stripe_gbp', 'worldpay', 'amex', 'wise_bacs', 'till_cash', 'paypal', 'lloyds_bank']),
  reference: z.string().max(200).nullable().optional(),
  reason: z.string().min(1).max(500),
});

const overrideSchema = z.object({
  reason: z.enum([
    'client_on_credit',
    'pre_auth_to_follow',
    'ooosh_staff_vehicle',
    'balance_on_account',
    'other',
  ]),
  notes: z.string().max(500).optional(),
});

const moveExcessSchema = z.object({
  xero_contact_id: z.string().max(100).optional().default(''),
  xero_contact_name: z.string().max(200),
  client_name: z.string().max(200).optional(),
  person_id: z.string().uuid().nullable().optional().or(z.literal('')),
  reason: z.string().max(500).optional(),
});

const createExcessSchema = z.object({
  job_id: z.string().uuid(),
  hirehop_job_id: z.number().int().nullable().optional(),
  excess_amount_required: z.number().min(0).nullable().optional(),
  excess_calculation_basis: z.string().nullable().optional(),
  client_name: z.string().max(200).optional(),
  assignment_id: z.string().uuid().nullable().optional(),
  notes: z.string().max(1000).optional(),
});

// ── POST /api/excess/create — Manually create an excess record from the Money tab ──
// Allows tracking excess at the job level without requiring a hire form first.

router.post('/create', validate(createExcessSchema), async (req: AuthRequest, res: Response) => {
  try {
    const {
      job_id, hirehop_job_id, excess_amount_required,
      excess_calculation_basis, client_name,
      assignment_id, notes,
    } = req.body;

    // Look up job to populate client info if not provided
    const jobResult = await query(
      `SELECT id, hh_job_number, client_name, company_name, client_id FROM jobs WHERE id = $1`,
      [job_id]
    );
    if (jobResult.rows.length === 0) {
      res.status(404).json({ error: 'Job not found' });
      return;
    }
    const job = jobResult.rows[0];

    const effectiveClientName = client_name || job.client_name || job.company_name || null;
    const effectiveHHJobId = hirehop_job_id || job.hh_job_number || null;

    const result = await query(
      `INSERT INTO job_excess (
        job_id, hirehop_job_id, assignment_id,
        excess_amount_required, excess_calculation_basis,
        excess_status, client_name, notes, created_by
      ) VALUES ($1, $2, $3, $4, $5, 'needed', $6, $7, $8)
      RETURNING *`,
      [
        job_id,
        effectiveHHJobId,
        assignment_id || null,
        excess_amount_required ?? null,
        excess_calculation_basis || null,
        effectiveClientName,
        notes || null,
        req.user!.id,
      ]
    );

    console.log(`[excess] Manual excess record created: job=${job_id}, amount=${excess_amount_required || 'TBD'}, client=${effectiveClientName}`);
    res.status(201).json({ data: result.rows[0] });
  } catch (error) {
    console.error('[excess] Create error:', error);
    res.status(500).json({ error: 'Failed to create excess record' });
  }
});

// ── POST /api/excess/create-from-hh — Create excess record pre-linked to an HH deposit ──
// Used when an excess deposit exists in HireHop but has no OP record.
// Creates the OP record with the HH deposit already linked (no push back to HH).

const createFromHHSchema = z.object({
  job_id: z.string().uuid(),
  hh_deposit_id: z.number().int().min(1),
  amount: z.number().min(0.01),
  client_name: z.string().max(200).optional(),
});

router.post('/create-from-hh', validate(createFromHHSchema), async (req: AuthRequest, res: Response) => {
  try {
    const { job_id, hh_deposit_id, amount, client_name } = req.body;

    // Look up job
    const jobResult = await query(
      `SELECT id, hh_job_number, client_name, company_name FROM jobs WHERE id = $1`,
      [job_id]
    );
    if (jobResult.rows.length === 0) {
      res.status(404).json({ error: 'Job not found' });
      return;
    }
    const job = jobResult.rows[0];

    // Check this HH deposit isn't already linked
    const dupeCheck = await query(
      `SELECT id FROM job_excess WHERE hh_deposit_id = $1`,
      [hh_deposit_id]
    );
    if (dupeCheck.rows.length > 0) {
      res.status(409).json({ error: 'This HireHop deposit is already linked to an excess record' });
      return;
    }

    const effectiveClientName = client_name || job.client_name || job.company_name || null;

    const result = await query(
      `INSERT INTO job_excess (
        job_id, hirehop_job_id,
        excess_amount_required, excess_amount_taken,
        excess_calculation_basis, excess_status,
        client_name, hh_deposit_id, hh_reconciled_at, hh_reconcile_source,
        payment_date, created_by
      ) VALUES ($1, $2, $3, $3, 'Imported from HireHop deposit', 'taken', $4, $5, NOW(), 'manual_link', NOW(), $6)
      RETURNING *`,
      [
        job_id,
        job.hh_job_number || null,
        amount,
        effectiveClientName,
        hh_deposit_id,
        req.user!.id,
      ]
    );

    console.log(`[excess] Created from HH deposit: job=${job_id}, hh_deposit=${hh_deposit_id}, £${amount}`);
    res.status(201).json({ data: result.rows[0] });
  } catch (error) {
    console.error('[excess] Create from HH error:', error);
    res.status(500).json({ error: 'Failed to create excess record from HH deposit' });
  }
});

// ── GET /api/excess — List excess records ──

router.get('/', async (req: AuthRequest, res: Response) => {
  try {
    const {
      status, hirehop_job_id, xero_contact_id, person_id, job_id,
      payment_method, search, sort,
      page = '1', limit = '50',
    } = req.query;
    const offset = (parseInt(page as string) - 1) * parseInt(limit as string);
    const pageLimit = parseInt(limit as string);

    let where = 'WHERE 1=1';
    const params: unknown[] = [];

    if (status) {
      params.push(status);
      where += ` AND je.excess_status = $${params.length}`;
    }
    if (hirehop_job_id) {
      params.push(parseInt(hirehop_job_id as string));
      where += ` AND je.hirehop_job_id = $${params.length}`;
    }
    if (xero_contact_id) {
      params.push(xero_contact_id);
      where += ` AND je.xero_contact_id = $${params.length}`;
    }
    if (person_id) {
      params.push(person_id);
      where += ` AND je.person_id = $${params.length}`;
    }
    if (job_id) {
      params.push(job_id);
      where += ` AND je.job_id = $${params.length}`;
    }
    if (payment_method) {
      params.push(payment_method);
      where += ` AND je.payment_method = $${params.length}`;
    }
    if (search) {
      params.push(`%${(search as string).toLowerCase()}%`);
      where += ` AND (LOWER(je.client_name) LIKE $${params.length} OR LOWER(d.full_name) LIKE $${params.length} OR LOWER(j.job_name) LIKE $${params.length})`;
    }

    // Joins needed for search/sort (shared between count and data queries)
    const joins = `
      LEFT JOIN vehicle_hire_assignments vha ON vha.id = je.assignment_id
      LEFT JOIN fleet_vehicles fv ON fv.id = vha.vehicle_id
      LEFT JOIN drivers d ON d.id = vha.driver_id
      LEFT JOIN jobs j ON j.id = je.job_id`;

    const countResult = await query(
      `SELECT COUNT(*) FROM job_excess je ${joins} ${where}`,
      params
    );
    const total = parseInt(countResult.rows[0].count);

    // Sort options
    const sortOptions: Record<string, string> = {
      newest: 'je.created_at DESC',
      oldest: 'je.created_at ASC',
      payment_date_desc: 'je.payment_date DESC NULLS LAST',
      payment_date_asc: 'je.payment_date ASC NULLS LAST',
      reimbursed_date_desc: 'je.reimbursement_date DESC NULLS LAST',
      reimbursed_date_asc: 'je.reimbursement_date ASC NULLS LAST',
      amount_high: 'je.excess_amount_required DESC NULLS LAST',
      amount_low: 'je.excess_amount_required ASC NULLS LAST',
      collected_high: 'je.excess_amount_taken DESC',
      collected_low: 'je.excess_amount_taken ASC',
      client_az: 'je.client_name ASC NULLS LAST',
      client_za: 'je.client_name DESC NULLS LAST',
    };
    const orderBy = sortOptions[sort as string] || 'je.created_at DESC';

    const dataParams = [...params, pageLimit, offset];
    const result = await query(
      `SELECT je.*,
        vha.vehicle_id,
        vha.hirehop_job_name,
        vha.hire_start,
        vha.hire_end,
        vha.assignment_type,
        fv.reg AS vehicle_reg,
        d.full_name AS driver_name,
        j.job_name
      FROM job_excess je
      ${joins}
      ${where}
      ORDER BY ${orderBy}
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
    console.error('[excess] List error:', error);
    res.status(500).json({ error: 'Failed to load excess records' });
  }
});

// NOTE: Excess calculation engine (rules CRUD + calculate endpoint) REMOVED.
// All excess calculations are done within the hire form app (Netlify).
// The OP only stores/tracks the excess amount passed through from the hire form.
// The excess_rules table still exists in the DB but is not used by any endpoint.

// ── GET /api/excess/:id/outstanding-invoices ──────────────────────────────
// Lists invoices on the excess record's HH job that still have an outstanding
// balance, so staff can pick which one to apply a claim against. Reads HH live
// (no cache) — staff just created the invoice in HH UI moments ago, we need
// fresh data.
//
// Returns kind:1 (invoice) rows with `owing > 0` from billing_list.php. The
// claim endpoint then takes the chosen invoice's HH ID, the deposit's HH ID
// (already on the excess record), and pushes the application via
// billing_payments_save.php.

router.get('/:id/outstanding-invoices', async (req: AuthRequest, res: Response) => {
  try {
    const { id } = req.params;
    const result = await query(
      `SELECT hirehop_job_id FROM job_excess WHERE id = $1`,
      [id]
    );
    if (result.rows.length === 0) {
      res.status(404).json({ error: 'Excess record not found' });
      return;
    }
    const hhJobId = result.rows[0].hirehop_job_id;
    if (!hhJobId) {
      res.status(422).json({
        error: 'Excess record is not linked to a HireHop job',
        detail: 'Cannot list outstanding invoices for an OP-only excess record. Claims against this record need to be recorded manually outside HireHop.',
      });
      return;
    }

    // billing_list.php returns the full job billing tree. We want kind:1 (invoices).
    // owing > 0 means the invoice still has balance to apply against.
    const billingRes = await hhBroker.get('/php_functions/billing_list.php',
      { main_id: hhJobId, type: 1 },
      { priority: 'high', cacheTTL: 0 }
    );

    if (!billingRes.success || !billingRes.data) {
      res.status(502).json({
        error: 'Could not load HireHop billing for this job',
        detail: billingRes.error || 'HireHop did not return billing data. Try again, or check the job status in HireHop.',
      });
      return;
    }

    const bl = billingRes.data as Record<string, any>;
    const invoices: Array<{ id: number; number: string; description: string; amount: number; owing: number; date: string | null }> = [];
    for (const row of bl.rows || []) {
      const kind = parseInt(row.kind ?? '0');
      if (kind !== 1) continue; // only invoices
      const owing = Number(row.owing ?? row.data?.owing ?? 0);
      if (owing <= 0.005) continue; // already paid
      const invoiceId = parseInt(row.data?.ID || row.number || String(row.id).replace('b', '') || '0');
      if (!invoiceId) continue;
      invoices.push({
        id: invoiceId,
        number: String(row.data?.NUMBER || row.number || ''),
        description: String(row.data?.DESCRIPTION || row.desc || ''),
        amount: Number(row.data?.NET ?? row.debit ?? 0) + Number(row.data?.TAX ?? 0),
        owing,
        date: row.data?.TAX_POINT || row.date || null,
      });
    }

    res.json({ data: invoices });
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : String(error);
    console.error('[excess] Outstanding invoices error:', errMsg);
    res.status(500).json({ error: 'Failed to load outstanding invoices', detail: errMsg });
  }
});

// Shared: fetch a HireHop job's open (owing > 0) invoices via billing_list.php.
type OpenInvoice = { id: number; number: string; description: string; amount: number; owing: number; date: string | null };
async function fetchOpenInvoicesForJob(hhJobId: number | string): Promise<OpenInvoice[]> {
  const billingRes = await hhBroker.get('/php_functions/billing_list.php',
    { main_id: hhJobId, type: 1 }, { priority: 'low', cacheTTL: 30 });
  if (!billingRes.success || !billingRes.data) return [];
  const bl = billingRes.data as Record<string, any>;
  const invoices: OpenInvoice[] = [];
  for (const row of bl.rows || []) {
    if (parseInt(row.kind ?? '0') !== 1) continue;
    const owing = Number(row.owing ?? row.data?.owing ?? 0);
    if (owing <= 0.005) continue;
    const invoiceId = parseInt(row.data?.ID || row.number || String(row.id).replace('b', '') || '0');
    if (!invoiceId) continue;
    invoices.push({
      id: invoiceId,
      number: String(row.data?.NUMBER || row.number || ''),
      description: String(row.data?.DESCRIPTION || row.desc || ''),
      amount: Number(row.data?.NET ?? row.debit ?? 0) + Number(row.data?.TAX ?? 0),
      owing,
      date: row.data?.TAX_POINT || row.date || null,
    });
  }
  return invoices;
}

// ── GET /api/excess/:id/cross-job-invoices ─────────────────────────────────
// Same-client open invoices on OTHER jobs, for the cross-job apply picker
// (CROSS-JOB-EXCESS-APPLY-SPEC). Scoped to the excess's client_id — the
// correctness boundary AND the size bound. Pre-filtered via the job_financials
// cache (balance_outstanding > 0) so we only hit HH billing for jobs that
// actually owe; capped at 25 jobs. Lazy-load this only when staff expand the
// "apply to another job" section.

router.get('/:id/cross-job-invoices', async (req: AuthRequest, res: Response) => {
  try {
    const { id } = req.params;
    const excess = await query(
      `SELECT je.hirehop_job_id, j.client_id, j.client_name
         FROM job_excess je LEFT JOIN jobs j ON j.id = je.job_id WHERE je.id = $1`,
      [id]
    );
    if (excess.rows.length === 0) { res.status(404).json({ error: 'Excess record not found' }); return; }
    const { hirehop_job_id, client_id } = excess.rows[0];
    if (!client_id) { res.json({ data: { jobs: [], reason: 'no_client' } }); return; }

    // Candidate same-client jobs with a cached outstanding balance (excluding
    // this excess's own job). job_financials is the fast pre-filter; we only
    // fetch live HH billing for these few.
    const candidates = await query(
      `SELECT j.hh_job_number, j.job_name, jf.balance_outstanding
         FROM jobs j JOIN job_financials jf ON jf.job_id = j.id
        WHERE j.client_id = $1
          AND j.hh_job_number IS NOT NULL
          AND ($2::int IS NULL OR j.hh_job_number <> $2)
          AND jf.balance_outstanding > 0.01
          AND COALESCE(j.is_deleted, false) = false
        ORDER BY jf.balance_outstanding DESC
        LIMIT 25`,
      [client_id, hirehop_job_id || null]
    );

    const jobs: Array<{ hh_job_number: number; job_name: string | null; invoices: OpenInvoice[] }> = [];
    for (const c of candidates.rows) {
      const invoices = await fetchOpenInvoicesForJob(c.hh_job_number);
      if (invoices.length > 0) jobs.push({ hh_job_number: c.hh_job_number, job_name: c.job_name || null, invoices });
    }
    res.json({ data: { jobs, capped: candidates.rows.length >= 25 } });
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : String(error);
    console.error('[excess] Cross-job invoices error:', errMsg);
    res.status(500).json({ error: 'Failed to load cross-job invoices', detail: errMsg });
  }
});

// ── GET /api/excess/:id/job-invoices/:hhJobNumber ──────────────────────────
// Targeted lookup: open invoices on a SPECIFIC job (the "or enter a job number"
// fallback). Returns a same_client flag so the UI can warn before a manager
// override, rather than hard-blocking the lookup itself.

router.get('/:id/job-invoices/:hhJobNumber', async (req: AuthRequest, res: Response) => {
  try {
    const { id, hhJobNumber } = req.params;
    const hhNum = parseInt(String(hhJobNumber), 10);
    if (!hhNum) { res.status(400).json({ error: 'Invalid job number' }); return; }

    const ctx = await query(
      `SELECT
         (SELECT j.client_id FROM job_excess je JOIN jobs j ON j.id = je.job_id WHERE je.id = $1) AS src_client,
         (SELECT client_id FROM jobs WHERE hh_job_number = $2) AS tgt_client,
         (SELECT job_name FROM jobs WHERE hh_job_number = $2) AS tgt_job_name`,
      [id, hhNum]
    );
    const { src_client, tgt_client, tgt_job_name } = ctx.rows[0] || {};
    const sameClient = !!src_client && !!tgt_client && String(src_client) === String(tgt_client);
    const invoices = await fetchOpenInvoicesForJob(hhNum);
    res.json({ data: { hh_job_number: hhNum, job_name: tgt_job_name || null, same_client: sameClient, invoices } });
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : String(error);
    console.error('[excess] Job invoices lookup error:', errMsg);
    res.status(500).json({ error: 'Failed to load job invoices', detail: errMsg });
  }
});

// ── GET /api/excess/:id/available-rollover ─────────────────────────────────
// "Does this client have a rolled-over excess balance available to apply to
// THIS excess record?" — drives the "Apply Rolled Over Excess" action in the
// Money tab modal so staff don't have to navigate Manage → Record Payment →
// pick "Rolled Over from Previous Hire" (which is misleading UX since no money
// is moving).
//
// Walks the client's excess history: finds the latest record with held cash
// (status taken/partially_paid AND has hh_deposit_id) that hasn't already been
// chained forward via 'rolled_over' status. Available amount =
// taken − claimed − reimbursed.
//
// Returns { available: false } if nothing applicable. Otherwise returns the
// amount + source HH job + source HH deposit ID for the UI to display
// ("£1,200 available from job #15577") and pre-fill the form.

router.get('/:id/available-rollover', async (req: AuthRequest, res: Response) => {
  try {
    const { id } = req.params;
    const result = await query(`SELECT * FROM job_excess WHERE id = $1`, [id]);
    if (result.rows.length === 0) {
      res.status(404).json({ error: 'Excess record not found' });
      return;
    }
    const current = result.rows[0];
    if (!current.job_id) {
      res.json({ data: { available: false, reason: 'no_job' } });
      return;
    }

    // Find candidate source records for the same client. Status filter:
    //   - 'taken' / 'partially_paid' = live record with cash
    //   - 'rolled_over' = was marked rolled over BUT may not actually have been
    //     chained forward (e.g. legacy flow that only flipped this record's
    //     status without creating a child record). The cash is still in the
    //     bank, just labelled "rolled over" without a chain. We INCLUDE these
    //     and rely on the NOT EXISTS guard below to skip records that HAVE
    //     been chained forward (would otherwise double-allocate the cash).
    // We also exclude the current record itself, and require hh_deposit_id so
    // the chain back to the original HireHop deposit is intact.
    const candidates = await query(
      `SELECT je2.id, je2.hh_deposit_id,
              je2.excess_amount_taken, je2.claim_amount, je2.reimbursement_amount,
              je2.excess_status, je2.payment_method,
              j2.hh_job_number AS source_hh_job
       FROM job_excess je2
       JOIN jobs j2 ON j2.id = je2.job_id
       WHERE je2.id <> $1
         AND je2.job_id <> $2
         AND je2.hh_deposit_id IS NOT NULL
         AND je2.excess_status IN ('taken', 'partially_paid', 'rolled_over')
         AND j2.client_id = (SELECT client_id FROM jobs WHERE id = $2)
         AND j2.client_id IS NOT NULL
         -- Exclude records that have already been chained forward to a LIVE
         -- record (same hh_deposit_id, taken/partially_paid status). Without
         -- this we'd double-allocate cash that's already been earmarked.
         AND NOT EXISTS (
           SELECT 1 FROM job_excess je3
           WHERE je3.hh_deposit_id = je2.hh_deposit_id
             AND je3.id <> je2.id
             AND je3.id <> $1
             AND je3.excess_status IN ('taken', 'partially_paid')
         )
       ORDER BY je2.updated_at DESC
       LIMIT 5`,
      [id, current.job_id]
    );

    // Pick the first candidate with positive available balance.
    for (const row of candidates.rows) {
      const taken = parseFloat(row.excess_amount_taken || 0);
      const claimed = parseFloat(row.claim_amount || 0);
      const reimbursed = parseFloat(row.reimbursement_amount || 0);
      const available = taken - claimed - reimbursed;
      if (available > 0.005) {
        res.json({
          data: {
            available: true,
            amount_available: Number(available.toFixed(2)),
            source_excess_id: row.id,
            source_hh_deposit_id: row.hh_deposit_id,
            source_hh_job: row.source_hh_job ? Number(row.source_hh_job) : null,
            // Helpful for UI defaults: pre-fill min(required, available) so
            // applying never over-collects.
            suggested_apply_amount: Math.min(
              available,
              parseFloat(current.excess_amount_required || 0) - parseFloat(current.excess_amount_taken || 0)
            ),
          },
        });
        return;
      }
    }

    res.json({ data: { available: false } });
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : String(error);
    console.error('[excess] Available rollover error:', errMsg);
    res.status(500).json({ error: 'Failed to check rollover availability', detail: errMsg });
  }
});

// ── GET /api/excess/:id/rollover-chain ─────────────────────────────────────
// "Follow the thread" of a rolled-over excess: all records sharing this
// record's HireHop deposit, ordered oldest→newest, so the UI can render
// "#15577 → #15865 → #15912 (reimbursed)". Rollover copies the same
// hh_deposit_id forward, so a shared deposit id IS the chain. Returns just this
// record (chain length 1) when there's no rollover.

router.get('/:id/rollover-chain', async (req: AuthRequest, res: Response) => {
  try {
    const { id } = req.params;
    const rec = await query(`SELECT hh_deposit_id FROM job_excess WHERE id = $1`, [id]);
    if (rec.rows.length === 0) { res.status(404).json({ error: 'Excess record not found' }); return; }
    const depositId = rec.rows[0].hh_deposit_id;
    if (!depositId) { res.json({ data: { deposit_id: null, current_id: id, chain: [] } }); return; }

    const chain = await query(
      `SELECT je.id, je.excess_status,
              je.excess_amount_taken, je.claim_amount, je.reimbursement_amount, je.amount_held,
              je.created_at, j.hh_job_number, j.job_name
         FROM job_excess je LEFT JOIN jobs j ON j.id = je.job_id
        WHERE je.hh_deposit_id = $1
        ORDER BY je.created_at ASC`,
      [depositId]
    );
    res.json({ data: { deposit_id: depositId, current_id: id, chain: chain.rows } });
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : String(error);
    console.error('[excess] Rollover chain error:', errMsg);
    res.status(500).json({ error: 'Failed to load rollover chain', detail: errMsg });
  }
});

// ── GET /api/excess/ledger — Client excess ledger ──

router.get('/ledger', authorize(...MANAGER_ROLES), async (_req: AuthRequest, res: Response) => {
  try {
    const result = await query(
      `SELECT * FROM client_excess_ledger ORDER BY balance_held DESC`
    );
    res.json({ data: result.rows });
  } catch (error) {
    console.error('[excess] Ledger error:', error);
    res.status(500).json({ error: 'Failed to load excess ledger' });
  }
});

// ── GET /api/excess/ledger/:xeroContactId — Single client ledger ──

router.get('/ledger/:xeroContactId', authorize(...MANAGER_ROLES), async (req: AuthRequest, res: Response) => {
  try {
    const xeroContactId = String(req.params.xeroContactId);

    const summaryResult = await query(
      `SELECT * FROM client_excess_ledger WHERE xero_contact_id = $1`,
      [xeroContactId]
    );

    // Ledger view grouping keys (migration 063):
    //   - real xero_contact_id → a Xero contact ID
    //   - 'name:<client_name>' → records without xero_contact_id but with client_name
    //     (typical for portal/derivation-created records before the proper Xero
    //     contact ID sync is wired in — see CLAUDE.md Step 3 Phase A)
    //   - 'UNLINKED' → records with neither
    const isUnlinked = xeroContactId === 'UNLINKED';
    const isNameKey = xeroContactId.startsWith('name:');
    const nameFromKey = isNameKey ? xeroContactId.substring(5) : null;

    let whereClause: string;
    let whereParams: any[];
    if (isUnlinked) {
      whereClause = 'je.xero_contact_id IS NULL AND (je.client_name IS NULL OR je.client_name = \'\')';
      whereParams = [];
    } else if (isNameKey) {
      whereClause = 'je.xero_contact_id IS NULL AND je.client_name = $1';
      whereParams = [nameFromKey];
    } else {
      whereClause = 'je.xero_contact_id = $1';
      whereParams = [xeroContactId];
    }

    const historyResult = await query(
      `SELECT je.*,
        vha.hirehop_job_name,
        vha.hire_start,
        vha.hire_end,
        fv.reg AS vehicle_reg,
        d.full_name AS driver_name,
        j.job_name
      FROM job_excess je
      LEFT JOIN vehicle_hire_assignments vha ON vha.id = je.assignment_id
      LEFT JOIN fleet_vehicles fv ON fv.id = vha.vehicle_id
      LEFT JOIN drivers d ON d.id = vha.driver_id
      LEFT JOIN jobs j ON j.id = je.job_id
      WHERE ${whereClause}
      ORDER BY je.created_at DESC`,
      whereParams
    );

    res.json({
      summary: summaryResult.rows[0] || null,
      history: historyResult.rows,
    });
  } catch (error) {
    console.error('[excess] Client ledger error:', error);
    res.status(500).json({ error: 'Failed to load client ledger' });
  }
});

// ── GET /api/excess/:id — Single excess record ──

router.get('/:id', async (req: AuthRequest, res: Response) => {
  try {
    const { id } = req.params;

    const result = await query(
      `SELECT je.*,
        vha.vehicle_id,
        vha.hirehop_job_name,
        vha.hire_start,
        vha.hire_end,
        fv.reg AS vehicle_reg,
        d.full_name AS driver_name,
        j.job_name
      FROM job_excess je
      LEFT JOIN vehicle_hire_assignments vha ON vha.id = je.assignment_id
      LEFT JOIN fleet_vehicles fv ON fv.id = vha.vehicle_id
      LEFT JOIN drivers d ON d.id = vha.driver_id
      LEFT JOIN jobs j ON j.id = je.job_id
      WHERE je.id = $1`,
      [id]
    );

    if (result.rows.length === 0) {
      res.status(404).json({ error: 'Excess record not found' });
      return;
    }

    res.json({ data: result.rows[0] });
  } catch (error) {
    console.error('[excess] Detail error:', error);
    res.status(500).json({ error: 'Failed to load excess record' });
  }
});

// ── PUT /api/excess/:id — Update excess record ──

/**
 * Recompute excess_status from (required, taken) when amounts change.
 *
 * Intent: keep the status a live reflection of reality vs expectation. If staff
 * edits the required amount up, the portal/UI should immediately see the new
 * shortfall; if an earlier payment now covers the new required, status promotes.
 *
 * Protected statuses (not auto-touched): `waived`, `reimbursed`, `rolled_over`,
 * `fully_claimed`, `partially_reimbursed`, `pre_auth`. These represent explicit
 * manual or webhook-driven states where the status carries meaning beyond just
 * coverage (e.g. pre_auth = card hold, not a completed charge). Staff can
 * still transition them explicitly via the dedicated actions on the modal.
 *
 * Also skipped when `excess_status` is explicitly present in the update payload
 * — the caller has taken responsibility for status.
 */
function deriveExcessStatus(currentStatus: string, required: number, taken: number): string {
  const PROTECTED = new Set([
    'waived',
    'reimbursed',
    'rolled_over',
    'fully_claimed',
    'partially_reimbursed',
    'pre_auth',
    'released', // Migration 087: pre-auth voided without capture — terminal, don't demote
  ]);
  if (PROTECTED.has(currentStatus)) return currentStatus;

  // Required = 0 (or not set) means nothing needed — but only flip TO
  // not_required if we're not already in a collected state. An explicit
  // not_required record is the "rollover covers it" surface.
  if (!required || required <= 0) {
    if (taken > 0) return currentStatus; // keep taken/partially_paid as-is
    return 'not_required';
  }

  // Required > 0 — derive from coverage
  if (taken >= required) return 'taken';
  if (taken > 0) return 'partially_paid';
  return 'needed';
}

/**
 * Resolve which HireHop bank a held deposit actually sits on, for use as the
 * (metadata-only) bank on a deposit→invoice application. Replaces the old
 * hardcoded `bank: 169` (Worldpay) which mis-attributed every claim — surfaced
 * by the cross-job apply proof (a Wise-collected excess showed as Worldpay).
 *
 * The bank id is NOT load-bearing in OP (classification is keyword-based), but
 * it drives the HH/Xero bank attribution + the displayed bank name, so it
 * should be right. Resolution order:
 *   1. The record's own payment_method, if it's a real bank method.
 *   2. Walk the rollover chain by hh_deposit_id to the ORIGINATING record (the
 *      one that first took the money — its method is the true bank; a
 *      'rolled_over' method is NOT, it always maps to 265 regardless).
 *   3. null → caller decides (and the UI surfaces a confirmable field so a
 *      human catches it).
 * A `bank` passed explicitly from the confirmable UI field always wins over this.
 */
async function resolveDepositBankId(record: {
  payment_method?: string | null;
  hh_deposit_id?: number | null;
}): Promise<number | null> {
  const isReal = (m?: string | null) => !!m && m !== 'rolled_over' && HH_BANK_IDS[m] != null;
  if (isReal(record.payment_method)) return HH_BANK_IDS[record.payment_method as string];

  if (record.hh_deposit_id) {
    const origin = await query(
      `SELECT payment_method FROM job_excess
       WHERE hh_deposit_id = $1 AND payment_method IS NOT NULL AND payment_method <> 'rolled_over'
       ORDER BY created_at ASC LIMIT 1`,
      [record.hh_deposit_id]
    );
    const m = origin.rows[0]?.payment_method as string | undefined;
    if (isReal(m)) return HH_BANK_IDS[m as string];
  }
  return null;
}

router.put('/:id', validate(updateExcessSchema), async (req: AuthRequest, res: Response) => {
  try {
    const { id } = req.params;
    const updates = { ...req.body };

    // If the update changes either amount but doesn't set status explicitly,
    // auto-derive the status so callers (edit modal, hire-form writes, etc.)
    // don't get stuck on a stale `not_required` / `taken` when the numbers
    // no longer support it.
    const touchesRequired = Object.prototype.hasOwnProperty.call(updates, 'excess_amount_required');
    const touchesTaken = Object.prototype.hasOwnProperty.call(updates, 'excess_amount_taken');
    const statusExplicitlySet = Object.prototype.hasOwnProperty.call(updates, 'excess_status');

    if ((touchesRequired || touchesTaken) && !statusExplicitlySet) {
      const currentResult = await query(
        `SELECT excess_amount_required, excess_amount_taken, excess_status FROM job_excess WHERE id = $1`,
        [id]
      );
      if (currentResult.rows.length === 0) {
        res.status(404).json({ error: 'Excess record not found' });
        return;
      }
      const row = currentResult.rows[0];
      const newRequired = touchesRequired
        ? Number(updates.excess_amount_required ?? 0)
        : Number(row.excess_amount_required ?? 0);
      const newTaken = touchesTaken
        ? Number(updates.excess_amount_taken ?? 0)
        : Number(row.excess_amount_taken ?? 0);
      const derived = deriveExcessStatus(row.excess_status, newRequired, newTaken);
      if (derived !== row.excess_status) {
        updates.excess_status = derived;
      }
    }

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
      `UPDATE job_excess SET ${setClauses.join(', ')} WHERE id = $${params.length} RETURNING *`,
      params
    );

    if (result.rows.length === 0) {
      res.status(404).json({ error: 'Excess record not found' });
      return;
    }

    res.json({ data: result.rows[0] });
  } catch (error) {
    console.error('[excess] Update error:', error);
    res.status(500).json({ error: 'Failed to update excess record' });
  }
});

// ── POST /api/excess/:id/payment — Record payment ──

router.post('/:id/payment', validate(paymentSchema), async (req: AuthRequest, res: Response) => {
  try {
    const { id } = req.params;
    const { total_collected, amount: bodyAmount, method, reference, notes, push_to_hirehop, acknowledge_chain_break } = req.body;

    // Look up the existing record so we can compute the delta (new money) when
    // the caller passes total_collected (absolute set), and so we have
    // hirehop_job_id for the HH push.
    const existing = await query(
      `SELECT je.*, j.hh_job_number FROM job_excess je
       LEFT JOIN jobs j ON j.id = je.job_id
       WHERE je.id = $1`,
      [id]
    );

    if (existing.rows.length === 0) {
      res.status(404).json({ error: 'Excess record not found' });
      return;
    }

    const previous = existing.rows[0];
    const previousTaken = parseFloat(previous.excess_amount_taken || 0);

    // Determine new total + delta. New callers send `total_collected` (absolute).
    // Legacy callers (or rollover flows that haven't been migrated) send
    // `amount` (delta).
    let newTotal: number;
    let delta: number;
    if (total_collected !== undefined) {
      newTotal = total_collected;
      delta = newTotal - previousTaken;
    } else {
      delta = bodyAmount;
      newTotal = previousTaken + delta;
    }

    if (newTotal < 0) {
      res.status(400).json({ error: 'Total collected cannot be negative' });
      return;
    }

    // Idempotent no-op: total_collected matches what's already on file. Don't
    // touch the record, don't insert a payment row, don't push HH.
    if (Math.abs(delta) < 0.005) {
      res.json({
        data: previous,
        delta: 0,
        idempotent: true,
        hh_push_error: null,
      });
      return;
    }

    // Soft-enforce reimburse-after-nibble (Jun 2026): block top-ups against
    // chain-linked records unless the caller explicitly acknowledges they're
    // breaking the rollover chain. The 15047 scenario — staff rolls forward
    // £1148, then tries to top up £52 — would push a second HH deposit that
    // can't ride the chain forward to future hires. We force the operational
    // decision: reimburse the residual and re-collect fresh OR proceed knowing
    // the £52 won't follow the chain.
    //
    // Skipped for: rollover writes themselves (method='rolled_over' — that IS
    // the chain extension), payments that reduce/match the existing total
    // (delta <= 0 covered by no-op above), and explicit ack.
    const isChainLinked = previous.hh_deposit_id != null;
    const isTopUpAfterCollection = delta > 0.005
      && !['needed', 'pending'].includes(previous.excess_status);
    if (isChainLinked && isTopUpAfterCollection && method !== 'rolled_over' && !acknowledge_chain_break) {
      const required = parseFloat(previous.excess_amount_required || '0');
      const residual = Math.max(0, required - previousTaken);
      res.status(409).json({
        error: 'chain_break_warning',
        message: 'This excess is linked to a HireHop deposit chain (rolled over from a previous hire). Adding more money here creates a second HH deposit that will NOT follow the chain forward to future rollovers.',
        details: {
          chain_break: true,
          current_collected: previousTaken,
          required,
          residual,
          suggested_action: 'reimburse_residual',
          suggestion_reason: 'Reimburse the residual back to the client and collect a fresh full amount, OR re-submit with acknowledge_chain_break:true to proceed (the top-up will be tracked in OP but won\'t link to HireHop for future rollovers).',
        },
      });
      return;
    }

    if (delta < 0) {
      // Lowering total_collected is a correction — allow it, but don't push HH
      // (you'd need a reverse deposit / refund flow). Typically used to fix a
      // double-record like the 15624 incident.
      const result = await query(
        `UPDATE job_excess SET
          excess_amount_taken = $1,
          excess_status = CASE
            WHEN $1 >= COALESCE(excess_amount_required, 0) THEN 'taken'
            WHEN $1 > 0 THEN 'partially_paid'
            ELSE 'needed'
          END,
          payment_method = $2,
          payment_reference = $3,
          updated_at = NOW()
        WHERE id = $4
        RETURNING *`,
        [newTotal, method, reference || null, id]
      );

      // Sync requirement status (might flip back from 'done')
      if (previous.job_id) {
        syncExcessRequirementStatus(previous.job_id).catch(e =>
          console.error('[excess] syncExcessRequirementStatus failed (correction):', e)
        );
      }

      res.json({
        data: result.rows[0],
        delta,
        correction: true,
        hh_push_error: null,
      });
      return;
    }

    // Positive delta — real new payment. Update the record absolutely.
    const result = await query(
      `UPDATE job_excess SET
        excess_amount_taken = $1,
        excess_status = CASE
          WHEN $1 >= COALESCE(excess_amount_required, 0) THEN 'taken'
          ELSE 'partially_paid'
        END,
        payment_method = $2,
        payment_reference = $3,
        payment_date = NOW(),
        updated_at = NOW()
      WHERE id = $4
      RETURNING *`,
      [newTotal, method, reference || null, id]
    );

    // Rolled-over payments need extra bookkeeping so the cash chain stays linked
    // to the original HH deposit. Without this, reimbursing the rolled-over excess
    // later has no way to find the HH deposit (which lives on the original hire's
    // job, not this one) and can't push the refund to HireHop.
    //
    //   1. Find the most recent excess record for the same client that's still
    //      holding cash (status taken/partially_paid/rolled_over) AND has an
    //      hh_deposit_id we can chain to.
    //   2. Copy that hh_deposit_id onto this new record (marked auto_match).
    //   3. Flip the previous record's status to 'rolled_over' (terminal — money's
    //      moved on to this hire).
    //
    // Best-effort: failures are logged but don't reject the payment. If the
    // linkage breaks, the reimburse endpoint will fail loudly later (by design)
    // so staff get a clear error rather than a silent drift.
    const excess = result.rows[0];
    const isRolledOver = method === 'rolled_over';
    let previousJobNumber: string | undefined;
    let rolloverLinked = false;
    if (isRolledOver) {
      try {
        const prev = await query(
          `SELECT je2.id, je2.hh_deposit_id, j2.hh_job_number
           FROM job_excess je2
           JOIN jobs j2 ON j2.id = je2.job_id
           WHERE je2.id <> $1
             AND je2.job_id <> $2
             AND je2.hh_deposit_id IS NOT NULL
             AND je2.excess_status IN ('taken', 'partially_paid', 'rolled_over')
             AND j2.client_id = (SELECT client_id FROM jobs WHERE id = $2)
             AND j2.client_id IS NOT NULL
           ORDER BY je2.updated_at DESC
           LIMIT 1`,
          [id, excess.job_id]
        );
        if (prev.rows.length > 0) {
          const prevRow = prev.rows[0];
          if (prevRow.hh_job_number) {
            previousJobNumber = String(prevRow.hh_job_number);
          }
          // Copy the original HH deposit ID forward so reimbursement can find it.
          await query(
            `UPDATE job_excess
             SET hh_deposit_id = $1,
                 hh_reconcile_source = COALESCE(hh_reconcile_source, 'auto_match'),
                 hh_reconciled_at = COALESCE(hh_reconciled_at, NOW()),
                 updated_at = NOW()
             WHERE id = $2 AND hh_deposit_id IS NULL`,
            [prevRow.hh_deposit_id, id]
          );
          // Mark the previous record as rolled_over (terminal — cash has moved
          // on to this child). Clear held_on_account: it's no longer parked, it's
          // been applied to a real hire.
          await query(
            `UPDATE job_excess
             SET excess_status = 'rolled_over',
                 held_on_account = FALSE,
                 updated_at = NOW()
             WHERE id = $1`,
            [prevRow.id]
          );
          rolloverLinked = true;
          console.log(`[excess] Rollover linked: new record ${id} inherits hh_deposit_id ${prevRow.hh_deposit_id} from ${prevRow.id}; previous flipped to rolled_over`);

          // Drop a note on the new HH job so HireHop staff can see the linkage
          // without having to dig into OP. Best-effort — don't reject the
          // rollover if HH note posting fails.
          if (excess.hirehop_job_id && prevRow.hh_deposit_id && prevRow.hh_job_number) {
            try {
              const noteText = `£${delta.toFixed(2)} excess held against deposit #${prevRow.hh_deposit_id} on job #${prevRow.hh_job_number} — rolled over from previous hire. (${new Date().toLocaleDateString('en-GB')})`;
              await hhBroker.get('/api/job_note.php', {
                job: excess.hirehop_job_id,
                note: noteText,
              }, { priority: 'low' });
              console.log(`[excess] HH job note posted on job ${excess.hirehop_job_id}: rolled-over linkage`);
            } catch (e) {
              console.error('[excess] HH job note post failed (non-fatal):', e);
            }
          }
        } else {
          console.warn(`[excess] Rollover recorded on ${id} but no previous record with hh_deposit_id found for this client. Reimbursement will fail until manually linked.`);
        }
      } catch (e) {
        console.error('[excess] Rollover linkage failed (non-fatal):', e);
      }
    }

    // Insert a job_payments row so payment history stays consistent with the
    // /money/:jobId/record-payment path. Without this, payments recorded via
    // the Manage modal never appear in payment history (one of the bugs that
    // hid the 15624 issue from staff).
    let jobPaymentId: string | null = null;
    try {
      const paymentRow = await query(
        `INSERT INTO job_payments
          (job_id, hirehop_job_id, payment_type, amount, payment_method,
           payment_reference, payment_status, source, excess_id,
           client_name, recorded_by, notes, payment_date)
         VALUES ($1, $2, 'excess', $3, $4, $5, 'completed', $6, $7, $8, $9, $10, NOW())
         RETURNING id`,
        [
          excess.job_id,
          previous.hh_job_number || null,
          delta,
          method,
          reference || null,
          isRolledOver ? 'op_rollover' : 'op_excess_modal',
          id,
          previous.client_name || null,
          req.user?.id || null,
          notes || null,
        ]
      );
      jobPaymentId = paymentRow.rows[0]?.id || null;
    } catch (err) {
      // Non-fatal — the excess record itself is already updated, payment
      // history just won't show the row. Log loudly for diagnosis.
      console.error('[excess] Failed to insert job_payments row (non-fatal):', err);
    }

    // Push to HireHop as a deposit. Skip when:
    //   - caller opted out (push_to_hirehop=false)
    //   - this is a rollover (cash didn't physically move, the previous deposit ID is reused)
    //   - the OP record isn't linked to a HH job (no hirehop_job_id)
    //   - the record already has hh_deposit_id (don't double-push when a top-up
    //     is being recorded against a record that already has a HH deposit; the
    //     top-up will need a separate manual HH entry — flagged in response)
    let hhPushError: string | null = null;
    let pushedHHDepositId: number | null = null;
    const shouldPush = push_to_hirehop && !isRolledOver && previous.hh_job_number;
    if (shouldPush) {
      if (previous.hh_deposit_id) {
        hhPushError = `Excess record already linked to HH deposit ${previous.hh_deposit_id}. Top-up of £${delta.toFixed(2)} not pushed — record manually in HireHop and link via Manage > Link to HH.`;
        console.warn('[excess] Skipped HH push:', hhPushError);
      } else {
        const pushResult = await pushDepositToHH({
          hhJobNumber: Number(previous.hh_job_number),
          amount: delta,
          paymentMethod: method,
          paymentReference: reference || null,
          paymentType: 'excess',
          notes: notes || null,
        });
        hhPushError = pushResult.error;
        pushedHHDepositId = pushResult.hhDepositId;

        if (pushResult.hhDepositId) {
          // Back-link to job_excess and job_payments so the reconciliation
          // queries on Money tab don't show the deposit as orphaned.
          try {
            await query(
              `UPDATE job_excess
               SET hh_deposit_id = $1,
                   hh_reconciled_at = NOW(),
                   hh_reconcile_source = 'op_push'
               WHERE id = $2 AND hh_deposit_id IS NULL`,
              [pushResult.hhDepositId, id]
            );
            if (jobPaymentId) {
              await query(
                `UPDATE job_payments SET hirehop_deposit_id = $1 WHERE id = $2`,
                [pushResult.hhDepositId, jobPaymentId]
              );
            }
          } catch (linkErr) {
            console.error('[excess] HH deposit linkage update failed (non-fatal):', linkErr);
          }
        }
      }
    }

    sendExcessEmail({
      templateId: isRolledOver ? 'excess_rolled_over_applied' : 'excess_payment_confirmed',
      excessId: id as string,
      jobId: excess.job_id,
      amount: delta,
      paymentMethod: method,
      previousJobNumber,
    }).catch(e => console.error('[excess] Payment email failed:', e));

    // Promote the excess requirement to 'done' if coverage is now met
    if (excess.job_id) {
      syncExcessRequirementStatus(excess.job_id).catch(e =>
        console.error('[excess] syncExcessRequirementStatus failed (payment):', e)
      );
    }

    // Re-fetch so the response reflects any rollover-linkage / HH-push updates.
    const refreshed = (isRolledOver || pushedHHDepositId)
      ? await query(`SELECT * FROM job_excess WHERE id = $1`, [id])
      : null;
    const responseData = refreshed && refreshed.rows.length > 0 ? refreshed.rows[0] : result.rows[0];

    res.json({
      data: responseData,
      delta,
      hh_push_error: hhPushError,
      hh_deposit_id: pushedHHDepositId,
      ...(isRolledOver ? { rollover_linked: rolloverLinked } : {}),
    });
  } catch (error) {
    console.error('[excess] Payment error:', error);
    res.status(500).json({ error: 'Failed to record payment' });
  }
});

// ── POST /api/excess/:id/capture — Capture a held pre-auth ──
//
// Converts "held" money into "taken" money. Three-step chain:
//   1. Stripe capture (if method=stripe_gbp) OR passive record (card-machine)
//   2. HH deposit creation (records the money in HireHop + Xero)
//   3. Optional: apply deposit to a HH invoice (atomic capture-and-claim)
//
// Stripe capture is ONE-SHOT — Stripe doesn't support multiple partial captures
// per PaymentIntent. So a £200 capture of a £1200 hold means:
//   - £200 lands in our Stripe GBP account (excess_amount_taken)
//   - £1000 auto-released by Stripe (amount_released)
//   - The hold is gone (amount_held → 0)
// Card-machine pre-auths have the same one-shot constraint.
//
// Loud-fail policy with compensation:
//   - Record not in 'pre_auth' state → 400
//   - amount > amount_held → 400
//   - method=stripe_gbp without stripe_payment_intent_id → 422 (linkage missing)
//   - Stripe capture fails → 502, no state change
//   - HH deposit fails AFTER Stripe capture succeeded → refund the Stripe capture
//     (compensation), then 502 with detail. OP record left unchanged.
//   - HH apply-to-invoice fails AFTER deposit created → leave deposit standing,
//     update OP record with the deposit + warn staff "captured but not applied"
//     (least bad — money is correctly tracked, just not earmarked to invoice).
//
// Receipt scan: required at UI level for card-machine methods (PR 2). Backend
// accepts the receipt_url and stores it on the file system — see receipt_required
// column behaviour. PR 1 does not yet surface receipt-missing as a hard block.

// ── POST /api/excess/:id/record-preauth — Record a manual pre-auth hold ──
//
// Staff-facing entry for a pre-auth taken on the card machine (Worldpay/Amex),
// cash held, or a manual Stripe hold. Sets the record to 'pre_auth' with the
// hold in amount_held (NOT excess_amount_taken — no money is in our account
// yet). No HireHop deposit is pushed — that happens at capture time. The record
// then flows into the existing Capture / Release lifecycle.
//
// Only valid from a "no money yet" state (needed / pending). A record already
// holding or carrying money is rejected — you don't stack a hold on top.

router.post('/:id/record-preauth', validate(recordPreauthSchema), async (req: AuthRequest, res: Response) => {
  try {
    const { id } = req.params;
    const { amount, method, reference, stripe_payment_intent_id, expires_in_days, notes } = req.body;

    const currentResult = await query(
      `SELECT je.*, j.hh_job_number FROM job_excess je
       LEFT JOIN jobs j ON j.id = je.job_id
       WHERE je.id = $1`,
      [id]
    );
    if (currentResult.rows.length === 0) {
      res.status(404).json({ error: 'Excess record not found' });
      return;
    }
    const current = currentResult.rows[0];

    // Guard: only record a hold when there's no money/hold already on the record.
    // 'needed'/'pending' are the collectable pre-money states. Anything else
    // (taken, pre_auth, fully_claimed, etc.) means money or a hold is already
    // attached and a fresh hold would be ambiguous.
    const alreadyHeld = parseFloat(current.amount_held || '0');
    const alreadyTaken = parseFloat(current.excess_amount_taken || '0');
    if (!['needed', 'pending'].includes(current.excess_status) || alreadyHeld > 0 || alreadyTaken > 0) {
      res.status(400).json({
        error: 'Cannot record a pre-auth on this record',
        detail: `Status is "${current.excess_status}" with £${alreadyTaken.toFixed(2)} taken and £${alreadyHeld.toFixed(2)} held. Pre-auth holds can only be recorded on a record that is still Needed with nothing collected. If a hold already exists, capture or release it first.`,
      });
      return;
    }

    const holdDays = expires_in_days || 5;
    // Only card-machine CARD methods produce a paper receipt to scan
    // (Worldpay/Amex). Stripe has an electronic trail; cash-held has no card
    // receipt — so neither flags a receipt as required.
    const needsReceipt = method === 'worldpay' || method === 'amex';

    const dateStr = new Date().toISOString().split('T')[0];
    const preauthNote = `[${dateStr}] Pre-auth hold of £${amount.toFixed(2)} recorded via ${method.replace(/_/g, ' ')}${reference ? ` (ref ${reference})` : ''}${notes ? `. ${notes}` : ''}. Expires in ${holdDays} days.`;
    const newNotes = current.notes ? `${current.notes}\n${preauthNote}` : preauthNote;

    const result = await query(
      `UPDATE job_excess SET
        amount_held              = $1,
        excess_amount_taken      = 0,
        excess_status            = 'pre_auth',
        held_at                  = NOW(),
        held_expires_at          = NOW() + ($2 || ' days')::interval,
        payment_method           = $3,
        payment_reference        = $4,
        stripe_payment_intent_id = COALESCE($5, stripe_payment_intent_id),
        receipt_required         = $6,
        notes                    = $7,
        updated_at               = NOW()
      WHERE id = $8
      RETURNING *`,
      [
        amount,                       // $1
        String(holdDays),             // $2
        method,                       // $3
        reference || null,            // $4
        stripe_payment_intent_id || null, // $5
        needsReceipt,                 // $6
        newNotes,                     // $7
        id,                           // $8
      ]
    );

    // Audit row in job_payments (payment_status='pre_auth' — not completed). Keeps
    // the hold visible in payment history, consistent with the portal path in money.ts.
    try {
      await query(
        `INSERT INTO job_payments
          (job_id, hirehop_job_id, payment_type, amount, payment_method,
           payment_reference, payment_status, source, excess_id,
           client_name, recorded_by, notes, payment_date)
         VALUES ($1, $2, 'excess', $3, $4, $5, 'pre_auth', 'op_excess_modal', $6, $7, $8, $9, NOW())`,
        [
          current.job_id,
          current.hh_job_number || null,
          amount,
          method,
          reference || null,
          id,
          current.client_name || null,
          req.user?.id || null,
          notes || `Pre-auth hold recorded (expires ${holdDays}d)`,
        ]
      );
    } catch (err) {
      console.error('[excess] Failed to insert job_payments row for pre-auth (non-fatal):', err);
    }

    // Held money counts as coverage — sync requirement status.
    if (current.job_id) {
      syncExcessRequirementStatus(current.job_id).catch(e =>
        console.error('[excess] syncExcessRequirementStatus failed (record-preauth):', e)
      );
    }

    console.log(`[excess] Pre-auth recorded: ${id}, £${amount} held via ${method}, expires ${holdDays}d`);
    res.json({ data: result.rows[0] });
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : String(error);
    console.error('[excess] Record-preauth error:', errMsg, error);
    res.status(500).json({ error: 'Failed to record pre-auth hold', detail: errMsg });
  }
});

// ── POST /api/excess/:id/receipt — Attach a card-machine receipt scan ──
//
// receipt_url is the R2 key of a scan uploaded via /api/files/upload. Clears the
// receipt_required to-do flag. Card-machine excess (worldpay/amex/cash) needs a
// receipt for audit — surfaced as an amber to-do (NeedsAttention bucket) until set.

router.post('/:id/receipt', validate(receiptSchema), async (req: AuthRequest, res: Response) => {
  try {
    const { id } = req.params;
    const { receipt_url } = req.body;

    const exists = await query(`SELECT id FROM job_excess WHERE id = $1`, [id]);
    if (exists.rows.length === 0) {
      res.status(404).json({ error: 'Excess record not found' });
      return;
    }

    // Sets receipt_url + appends to the job's Files tab (shared with the phone path).
    await attachExcessReceipt({ excessId: id as string, key: receipt_url, uploadedBy: req.user?.id || null });

    const result = await query(`SELECT * FROM job_excess WHERE id = $1`, [id]);
    res.json({ data: result.rows[0] });
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : String(error);
    console.error('[excess] Receipt-attach error:', errMsg, error);
    res.status(500).json({ error: 'Failed to attach receipt', detail: errMsg });
  }
});

// ── POST /api/excess/:id/receipt-upload-token — Mint a phone-handoff token ──
//
// Used by the "Scan with phone" QR flow: returns a short-lived token + the URL
// the phone should open. The phone uploads the receipt via the public
// /api/mobile-upload/:token endpoint, which attaches it to this excess record.

router.post('/:id/receipt-upload-token', async (req: AuthRequest, res: Response) => {
  try {
    const { id } = req.params;
    const exists = await query(`SELECT id FROM job_excess WHERE id = $1`, [id]);
    if (exists.rows.length === 0) {
      res.status(404).json({ error: 'Excess record not found' });
      return;
    }
    const { token, expiresAt } = await createMobileUploadToken({
      purpose: 'excess_receipt',
      targetId: id as string,
      createdBy: req.user?.id || null,
    });
    const base = process.env.FRONTEND_URL || '';
    res.json({
      data: {
        token,
        expires_at: expiresAt,
        url: `${base}/m/receipt/${token}`,
      },
    });
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : String(error);
    console.error('[excess] Receipt-upload-token error:', errMsg, error);
    res.status(500).json({ error: 'Failed to create upload token', detail: errMsg });
  }
});

// ── GET /api/excess/:id/bank-details — Decrypt stored bank details ──
//
// Returns the decrypted bank details for THIS record. Admin/manager only — this
// is PII. Decryption happens here (response layer), never in SQL or logs.

router.get('/:id/bank-details', authorize(...MANAGER_ROLES), async (req: AuthRequest, res: Response) => {
  try {
    const { id } = req.params;
    const result = await query(
      `SELECT bank_details_encrypted, bank_details_last_used_at, bank_details_updated_at
       FROM job_excess WHERE id = $1`,
      [id]
    );
    if (result.rows.length === 0) {
      res.status(404).json({ error: 'Excess record not found' });
      return;
    }
    const row = result.rows[0];
    if (!row.bank_details_encrypted) {
      res.json({ data: null });
      return;
    }
    if (!isEncryptionConfigured()) {
      res.status(503).json({ error: 'Encryption not configured — cannot decrypt bank details (ENCRYPTION_KEY missing).' });
      return;
    }
    const details = tryDecryptJson(row.bank_details_encrypted);
    res.json({
      data: details,
      last_used_at: row.bank_details_last_used_at,
      updated_at: row.bank_details_updated_at,
    });
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : String(error);
    console.error('[excess] Bank-details fetch error:', errMsg, error);
    res.status(500).json({ error: 'Failed to fetch bank details', detail: errMsg });
  }
});

// ── GET /api/excess/:id/previous-bank-details — Reuse-from-previous lookup ──
//
// Finds the same client's most recent OTHER excess record carrying bank details,
// so staff can copy them across rather than re-typing. Returns the decrypted
// details + when they were last used (staleness heads-up — staff reconfirm with
// the client as standard). Admin/manager only.

router.get('/:id/previous-bank-details', authorize(...MANAGER_ROLES), async (req: AuthRequest, res: Response) => {
  try {
    const { id } = req.params;
    if (!isEncryptionConfigured()) {
      res.json({ data: null, available: false });
      return;
    }

    // Resolve this record's client so we only offer the same client's details.
    const self = await query(
      `SELECT je.id, j.client_id
       FROM job_excess je LEFT JOIN jobs j ON j.id = je.job_id
       WHERE je.id = $1`,
      [id]
    );
    if (self.rows.length === 0) {
      res.status(404).json({ error: 'Excess record not found' });
      return;
    }
    const clientId = self.rows[0].client_id;
    if (!clientId) {
      res.json({ data: null, available: false });
      return;
    }

    const prev = await query(
      `SELECT je.bank_details_encrypted, je.bank_details_last_used_at,
              je.bank_details_updated_at, j.hh_job_number
       FROM job_excess je
       JOIN jobs j ON j.id = je.job_id
       WHERE je.id <> $1
         AND j.client_id = $2
         AND je.bank_details_encrypted IS NOT NULL
       ORDER BY je.bank_details_updated_at DESC NULLS LAST
       LIMIT 1`,
      [id, clientId]
    );
    if (prev.rows.length === 0) {
      res.json({ data: null, available: false });
      return;
    }
    const row = prev.rows[0];
    const details = tryDecryptJson(row.bank_details_encrypted);
    if (!details) {
      res.json({ data: null, available: false });
      return;
    }
    res.json({
      data: details,
      available: true,
      last_used_at: row.bank_details_last_used_at,
      updated_at: row.bank_details_updated_at,
      source_hh_job: row.hh_job_number || null,
    });
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : String(error);
    console.error('[excess] Previous-bank-details lookup error:', errMsg, error);
    res.status(500).json({ error: 'Failed to look up previous bank details', detail: errMsg });
  }
});

router.post('/:id/capture', validate(captureSchema), async (req: AuthRequest, res: Response) => {
  try {
    const { id } = req.params;
    const { amount, method, invoice_id, receipt_url, reason, notes } = req.body;

    const currentResult = await query(
      `SELECT je.*, j.hh_job_number, j.client_name AS job_client_name
       FROM job_excess je
       LEFT JOIN jobs j ON j.id = je.job_id
       WHERE je.id = $1`,
      [id]
    );
    if (currentResult.rows.length === 0) {
      res.status(404).json({ error: 'Excess record not found' });
      return;
    }
    const current = currentResult.rows[0];

    // ── Validation ───────────────────────────────────────────────────────────
    if (current.excess_status !== 'pre_auth') {
      res.status(400).json({
        error: 'Excess is not in pre-auth state',
        detail: `Current status: ${current.excess_status}. Capture only applies to pre-auth holds.`,
      });
      return;
    }
    const amountHeld = parseFloat(current.amount_held || '0');
    if (amountHeld <= 0) {
      res.status(400).json({
        error: 'No money held on this record',
        detail: 'amount_held is zero. The hold may have already been captured or released.',
      });
      return;
    }
    if (amount > amountHeld + 0.005) {
      res.status(400).json({
        error: 'Capture amount exceeds held amount',
        detail: `Held: £${amountHeld.toFixed(2)}, requested: £${amount.toFixed(2)}`,
      });
      return;
    }

    const amountReleased = Math.max(0, amountHeld - amount);

    // ── Step 1: Stripe capture (or passive record for card-machine) ─────────
    let stripeChargeId: string | null = null;
    let stripeWarning: string | null = null;

    if (method === 'stripe_gbp') {
      if (!isStripeConfigured()) {
        res.status(503).json({
          error: 'Stripe not configured',
          detail: 'STRIPE_SECRET_KEY not set on server. Cannot capture Stripe pre-auths until configured.',
        });
        return;
      }
      if (!current.stripe_payment_intent_id) {
        res.status(422).json({
          error: 'Stripe PaymentIntent ID missing',
          detail: 'This record has no stripe_payment_intent_id, so we cannot address the hold via the Stripe API. Verify the hold was actually taken via Stripe (Payment Portal), or use the passive-record path with method=worldpay/amex if the hold was on the card machine.',
        });
        return;
      }

      try {
        const stripe = getStripeClient();
        const captured = await stripe.paymentIntents.capture(
          current.stripe_payment_intent_id,
          {
            amount_to_capture: Math.round(amount * 100), // pence
            metadata: {
              excess_id: String(id),
              op_job_id: current.job_id || '',
              hh_job_number: String(current.hirehop_job_id || ''),
              capture_reason: reason || '',
              captured_by_op: 'true',
            },
          }
        );
        // The PaymentIntent now has a latest_charge — that's the charge to refund
        // if HH fails later. Capture the charge ID for compensation.
        stripeChargeId = typeof captured.latest_charge === 'string'
          ? captured.latest_charge
          : (captured.latest_charge?.id || null);
        console.log(`[excess] Stripe capture OK: PI ${current.stripe_payment_intent_id} → £${amount} captured, charge ${stripeChargeId}, £${amountReleased.toFixed(2)} auto-released`);
      } catch (err) {
        const errMsg = isStripeError(err)
          ? `${err.type}: ${err.message}`
          : (err instanceof Error ? err.message : String(err));
        console.error('[excess] Stripe capture failed:', errMsg, err);
        res.status(502).json({
          error: 'Stripe capture failed',
          detail: errMsg,
        });
        return;
      }
    } else {
      // Card-machine capture is passive — staff captured on the terminal, OP
      // just records what happened. Receipt scan strongly recommended for audit;
      // surfaced as amber "outstanding" if missing (UI lives in PR 2).
      console.log(`[excess] Passive capture recorded: method=${method}, £${amount} captured (£${amountReleased.toFixed(2)} released on acquirer clock)`);
      if (!receipt_url) {
        stripeWarning = 'Card-machine capture recorded without a receipt scan. Upload one when convenient — it surfaces as an outstanding to-do until added.';
      }
    }

    // ── Step 2: Push HH deposit ──────────────────────────────────────────────
    let hhDepositId: number | null = null;
    let hhPushError: string | null = null;
    let hhPaymentAppId: number | null = null;

    if (current.hirehop_job_id) {
      const depositDesc = invoice_id
        ? `Excess captured & applied (job ${current.hirehop_job_id})`
        : `Excess captured (job ${current.hirehop_job_id}${reason ? ` — ${reason}` : ''})`;

      const pushResult = await pushDepositToHH({
        hhJobNumber: current.hirehop_job_id,
        amount,
        paymentMethod: method,
        paymentReference: stripeChargeId || current.stripe_payment_intent_id || null,
        paymentType: 'excess',
        notes: notes || `Captured from pre-auth (£${amountReleased.toFixed(2)} released)`,
      });

      hhDepositId = pushResult.hhDepositId;
      hhPushError = pushResult.error;

      if (hhPushError && stripeChargeId) {
        // Compensation: HH failed after we captured real money in Stripe.
        // Refund the capture to leave the world consistent. We've now lost the
        // hold + the £1000 that auto-released (can't get those back), but at
        // least we don't have orphaned money in Stripe that HH/Xero doesn't
        // know about.
        try {
          const stripe = getStripeClient();
          await stripe.refunds.create({
            charge: stripeChargeId,
            reason: 'requested_by_customer',
            metadata: {
              op_compensation: 'true',
              excess_id: String(id),
              reason: 'HH deposit creation failed after Stripe capture',
            },
          });
          console.log(`[excess] Compensation refund issued for charge ${stripeChargeId} after HH deposit failure`);
        } catch (refundErr) {
          const msg = refundErr instanceof Error ? refundErr.message : String(refundErr);
          console.error(`[excess] CRITICAL: HH push failed AND compensation refund failed. Manual intervention needed for charge ${stripeChargeId}. Refund error: ${msg}`);
        }

        res.status(502).json({
          error: 'HireHop deposit failed; Stripe capture has been refunded',
          detail: hhPushError,
        });
        return;
      } else if (hhPushError) {
        // No Stripe capture to unwind (card-machine path). Surface and bail.
        res.status(502).json({
          error: 'HireHop deposit failed',
          detail: hhPushError,
        });
        return;
      }

      // ── Step 3: Optional apply-to-invoice (atomic capture-and-claim) ──────
      if (invoice_id && hhDepositId) {
        try {
          const currentDate = new Date().toISOString().split('T')[0];
          const applyDesc = `${current.hirehop_job_id} - Excess applied to invoice`;
          const applyMemo = reason
            ? `Captured & applied — ${reason} (via Ooosh OP)`
            : `Captured & applied to invoice (via Ooosh OP)`;

          const applyResult = await hhBroker.post('/php_functions/billing_payments_save.php', {
            id: 0,
            date: currentDate,
            desc: applyDesc,
            paid: amount,
            memo: applyMemo,
            bank: 169,
            OWNER: invoice_id,
            deposit: hhDepositId,
            correction: 0,
            no_webhook: 1,
          }, { priority: 'high' });

          if (applyResult.success && applyResult.data) {
            hhPaymentAppId = (applyResult.data as Record<string, unknown>).hh_id as number
              || (applyResult.data as Record<string, unknown>).id as number
              || null;
            // Trigger Xero sync for the application
            if (hhPaymentAppId) {
              try {
                await hhBroker.post('/php_functions/accounting/tasks.php', {
                  hh_package_type: 1,
                  hh_acc_package_id: 3,
                  hh_task: 'post_payment',
                  hh_id: hhPaymentAppId,
                  hh_acc_id: '',
                }, { priority: 'high' });
              } catch (e) {
                console.error('[excess] Xero sync for capture-apply failed (non-fatal):', e);
              }
            }
          } else {
            // Deposit succeeded, apply-to-invoice failed. Don't unwind the
            // deposit — money is correctly recorded in HH/Xero, just not
            // earmarked to the invoice yet. Surface as warning.
            stripeWarning = `Captured & deposited £${amount.toFixed(2)}, but applying to invoice ${invoice_id} failed: ${applyResult.error || 'unknown'}. Apply manually in HireHop or via the Claim action.`;
            console.warn('[excess] Capture apply-to-invoice failed:', applyResult.error);
          }
        } catch (e) {
          stripeWarning = `Captured & deposited £${amount.toFixed(2)}, but applying to invoice ${invoice_id} threw: ${e instanceof Error ? e.message : String(e)}`;
          console.error('[excess] Capture apply-to-invoice threw:', e);
        }
      }
    }

    // ── Step 4: Update OP record ─────────────────────────────────────────────
    // The hold has concluded. Status becomes:
    //   - 'fully_claimed' if invoice_id was provided AND apply succeeded
    //   - 'taken' otherwise (money is in our account, no invoice link yet)
    const claimApplied = Boolean(invoice_id && hhPaymentAppId);
    const newStatus = claimApplied ? 'fully_claimed' : 'taken';
    const newClaimAmount = claimApplied ? amount : (parseFloat(current.claim_amount || '0'));

    const dateStr = new Date().toISOString().split('T')[0];
    const captureNote = `[${dateStr}] Captured £${amount.toFixed(2)} from £${amountHeld.toFixed(2)} hold (£${amountReleased.toFixed(2)} released)${reason ? ` — ${reason}` : ''}${notes ? `. ${notes}` : ''}`;
    const newNotes = current.notes
      ? `${current.notes}\n${captureNote}`
      : captureNote;
    const newClaimNotes = claimApplied
      ? (current.claim_notes
          ? `${current.claim_notes}\n[${dateStr}] £${amount.toFixed(2)}: applied at capture${notes ? ` — ${notes}` : ''}`
          : `[${dateStr}] £${amount.toFixed(2)}: applied at capture${notes ? ` — ${notes}` : ''}`)
      : current.claim_notes;

    // receipt_required: TRUE only for card-machine CARD methods (Worldpay/Amex)
    // when no scan was supplied. Stripe (electronic trail) and cash-held (no card
    // receipt) don't flag one.
    const needsReceipt = (method === 'worldpay' || method === 'amex') && !receipt_url;

    const result = await query(
      `UPDATE job_excess SET
        amount_held              = 0,
        amount_released          = COALESCE(amount_released, 0) + $1,
        excess_amount_taken      = COALESCE(excess_amount_taken, 0) + $2,
        excess_status            = $3,
        payment_method           = $4,
        payment_reference        = COALESCE($5, payment_reference),
        payment_date             = NOW(),
        released_at              = CASE WHEN $1 > 0 THEN NOW() ELSE released_at END,
        hh_deposit_id            = COALESCE($6, hh_deposit_id),
        hh_reconciled_at         = COALESCE(hh_reconciled_at, NOW()),
        hh_reconcile_source      = COALESCE(hh_reconcile_source, 'op_push'),
        claim_amount             = $7,
        claim_date               = CASE WHEN $8 THEN NOW() ELSE claim_date END,
        claim_notes              = $9,
        notes                    = $10,
        receipt_required         = $11,
        receipt_url              = COALESCE($13, receipt_url),
        receipt_uploaded_at      = CASE WHEN $13 IS NOT NULL THEN NOW() ELSE receipt_uploaded_at END,
        updated_at               = NOW()
      WHERE id = $12
      RETURNING *`,
      [
        amountReleased,                    // $1
        amount,                             // $2
        newStatus,                          // $3
        method,                             // $4
        stripeChargeId,                     // $5
        hhDepositId,                        // $6
        newClaimAmount,                     // $7
        claimApplied,                       // $8
        newClaimNotes,                      // $9
        newNotes,                           // $10
        needsReceipt,                       // $11
        id,                                 // $12
        receipt_url || null,                // $13
      ]
    );

    // Sync requirement status (coverage may now be met)
    if (current.job_id) {
      syncExcessRequirementStatus(current.job_id).catch(e =>
        console.error('[excess] syncExcessRequirementStatus failed (capture):', e)
      );
    }

    res.json({
      data: result.rows[0],
      stripe_charge_id: stripeChargeId,
      hh_deposit_id: hhDepositId,
      hh_payment_application_id: hhPaymentAppId,
      amount_captured: amount,
      amount_released: amountReleased,
      ...(stripeWarning ? { warning: stripeWarning } : {}),
    });
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : String(error);
    console.error('[excess] Capture error:', errMsg, error);
    res.status(500).json({ error: 'Failed to capture pre-auth', detail: errMsg });
  }
});

// ── POST /api/excess/:id/release — Release a held pre-auth without capture ──
//
// Voids the hold. For Stripe-channel: calls stripe.paymentIntents.cancel on
// the stored PaymentIntent — money never moves, hold is gone. For card-machine:
// passive record — the acquirer's hold expires on its own timer (typically
// 5-30 days depending on card), OP just records that we don't intend to claim.
//
// Idempotent on the Stripe side — if the PI is already canceled (e.g. expired
// past Stripe's 7-day window before we got here), the cancel call succeeds
// quietly and we proceed.
//
// Status transitions: pre_auth → released (terminal).

router.post('/:id/release', validate(releaseSchema), async (req: AuthRequest, res: Response) => {
  try {
    const { id } = req.params;
    const { reason, notes } = req.body;

    const currentResult = await query(`SELECT * FROM job_excess WHERE id = $1`, [id]);
    if (currentResult.rows.length === 0) {
      res.status(404).json({ error: 'Excess record not found' });
      return;
    }
    const current = currentResult.rows[0];

    if (current.excess_status !== 'pre_auth') {
      res.status(400).json({
        error: 'Excess is not in pre-auth state',
        detail: `Current status: ${current.excess_status}. Release only applies to pre-auth holds.`,
      });
      return;
    }
    const amountHeld = parseFloat(current.amount_held || '0');

    // ── Stripe cancel (best-effort) ──
    let stripeOutcome: string | null = null;
    if (current.payment_method === 'stripe_gbp' && current.stripe_payment_intent_id && isStripeConfigured()) {
      try {
        const stripe = getStripeClient();
        const cancelled = await stripe.paymentIntents.cancel(
          current.stripe_payment_intent_id,
          { cancellation_reason: 'abandoned' }
        );
        stripeOutcome = `cancelled (status: ${cancelled.status})`;
        console.log(`[excess] Stripe PI ${current.stripe_payment_intent_id} cancelled, status: ${cancelled.status}`);
      } catch (err) {
        // Common case: PI is already canceled (expired) — Stripe returns an
        // invalid_request_error. Treat as success (the hold is gone either way).
        if (isStripeError(err) && err.type === 'StripeInvalidRequestError') {
          stripeOutcome = `already cancelled (Stripe: ${err.message})`;
          console.log(`[excess] Stripe PI already cancelled: ${err.message}`);
        } else {
          // Other Stripe errors — log but don't block the release. The OP-side
          // truth is that we're choosing not to claim this hold, and Stripe
          // will auto-void on its own clock if our explicit cancel failed.
          const errMsg = err instanceof Error ? err.message : String(err);
          stripeOutcome = `cancel call failed (will auto-void): ${errMsg}`;
          console.warn('[excess] Stripe cancel failed (non-fatal, will auto-void):', errMsg);
        }
      }
    } else if (current.payment_method === 'stripe_gbp' && !current.stripe_payment_intent_id) {
      stripeOutcome = 'stripe_gbp method but no PI on record — Stripe will auto-void; nothing to call';
    } else {
      stripeOutcome = `passive release (${current.payment_method}) — acquirer auto-voids on its own clock`;
    }

    // ── Update OP record ──
    const dateStr = new Date().toISOString().split('T')[0];
    const releaseNote = `[${dateStr}] Released £${amountHeld.toFixed(2)} hold${reason ? ` — ${reason}` : ''}${notes ? `. ${notes}` : ''}. ${stripeOutcome}`;
    const newNotes = current.notes
      ? `${current.notes}\n${releaseNote}`
      : releaseNote;

    const result = await query(
      `UPDATE job_excess SET
        amount_released = COALESCE(amount_released, 0) + amount_held,
        amount_held     = 0,
        excess_status   = 'released',
        released_at     = NOW(),
        notes           = $1,
        updated_at      = NOW()
      WHERE id = $2
      RETURNING *`,
      [newNotes, id]
    );

    // Sync requirement status — released means we have no money for this
    // requirement, may need to flip back to outstanding.
    if (current.job_id) {
      syncExcessRequirementStatus(current.job_id).catch(e =>
        console.error('[excess] syncExcessRequirementStatus failed (release):', e)
      );
    }

    res.json({
      data: result.rows[0],
      amount_released: amountHeld,
      stripe_outcome: stripeOutcome,
    });
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : String(error);
    console.error('[excess] Release error:', errMsg, error);
    res.status(500).json({ error: 'Failed to release pre-auth', detail: errMsg });
  }
});

// ── POST /api/excess/:id/claim — Record damage claim (apply deposit to invoice) ──
//
// Applies part of the held deposit to a HireHop invoice on the current job. The
// invoice's line items carry the Xero nominal (e.g. "Vehicle damage", "Misc
// income") so claims against different categories route to the right place
// without OP needing to know about nominals.
//
// Multi-claim support: claims accumulate. Each call adds to `claim_amount`,
// appends to `claim_notes`. Status moves to `fully_claimed` only when the
// accumulated claims fully consume `excess_amount_taken` AND there's no
// reimbursement. Otherwise stays at the current (typically `taken`) status so
// the available balance stays clear.
//
// Loud-fail policy:
//   - HH-linked record without `hh_deposit_id` → 422 (linkage missing).
//   - Claim amount > available balance → 400.
//   - HH apply-to-invoice fails → 502, OP record untouched.
//   - OP-only record (no `hirehop_job_id`) → claim recorded in OP only,
//     response flagged `op_only: true`.

router.post('/:id/claim', validate(claimSchema), async (req: AuthRequest, res: Response) => {
  try {
    const { id } = req.params;
    const { amount, invoice_id, notes, target_hh_job, bank, allow_cross_client } = req.body;

    const currentResult = await query(`SELECT * FROM job_excess WHERE id = $1`, [id]);
    if (currentResult.rows.length === 0) {
      res.status(404).json({ error: 'Excess record not found' });
      return;
    }
    const current = currentResult.rows[0];
    const amountTaken = parseFloat(current.excess_amount_taken || '0');
    const alreadyClaimed = parseFloat(current.claim_amount || '0');
    const alreadyReimbursed = parseFloat(current.reimbursement_amount || '0');
    const available = amountTaken - alreadyClaimed - alreadyReimbursed;

    if (amount > available + 0.005) {
      res.status(400).json({
        error: 'Claim amount exceeds available balance',
        detail: `Available: £${available.toFixed(2)} (taken £${amountTaken.toFixed(2)} − claimed £${alreadyClaimed.toFixed(2)} − reimbursed £${alreadyReimbursed.toFixed(2)}), requested: £${amount.toFixed(2)}`,
      });
      return;
    }

    const isHhLinked = Boolean(current.hirehop_job_id);
    let hhPaymentAppId: number | null = null;

    if (isHhLinked) {
      // Need both: a deposit ID (where the cash sits) + an invoice ID (what we're applying to).
      if (!current.hh_deposit_id) {
        res.status(422).json({
          error: 'Cannot locate original HireHop deposit',
          detail: current.payment_method === 'rolled_over'
            ? 'This excess was rolled over from a previous hire and the chain back to the original HireHop deposit is broken. Use the "Link HH Deposit" action on the Money tab to attach this record to the correct HireHop deposit before claiming.'
            : 'No HireHop deposit ID linked to this excess record. Use the "Link HH Deposit" action on the Money tab before claiming.',
        });
        return;
      }
      if (!invoice_id) {
        res.status(400).json({
          error: 'Invoice required',
          detail: 'Pick a HireHop invoice to apply the claim against. Create the invoice in HireHop first if none exists yet.',
        });
        return;
      }

      // ── Cross-job apply: same-client guard ───────────────────────────
      // When the invoice lives on a different job (target_hh_job set + differs
      // from the excess's own job), it MUST be the same client unless a manager
      // explicitly overrides. The picker enforces this, but the endpoint is the
      // real boundary — applying one client's money to another's invoice is the
      // dangerous case. See CROSS-JOB-EXCESS-APPLY-SPEC.
      const isCrossJob = target_hh_job != null && Number(target_hh_job) !== Number(current.hirehop_job_id);
      if (isCrossJob && !allow_cross_client) {
        const clientCheck = await query(
          `SELECT
             (SELECT client_id FROM jobs WHERE hh_job_number = $1) AS src_client,
             (SELECT client_id FROM jobs WHERE hh_job_number = $2) AS tgt_client`,
          [current.hirehop_job_id, target_hh_job]
        );
        const { src_client, tgt_client } = clientCheck.rows[0] || {};
        if (!src_client || !tgt_client || String(src_client) !== String(tgt_client)) {
          res.status(409).json({
            error: 'Cross-client apply blocked',
            detail: `The target invoice (job ${target_hh_job}) belongs to a different client than this excess (job ${current.hirehop_job_id}). Applying one client's money to another client's invoice is almost always wrong. A manager can override with allow_cross_client if this is genuinely intended.`,
            code: 'cross_client_blocked',
          });
          return;
        }
      }

      // ── Push the application to HireHop ──────────────────────────────
      // The application's `bank` is metadata only — no real cash moves; the
      // deposit is already in the bank, this just reallocates it from
      // "deposit liability" → "invoice paid" (the invoice line's ACC_NOMINAL_ID
      // routes it to the right Xero revenue account). It still drives the HH/Xero
      // bank attribution + displayed bank name, so resolve it from the source
      // deposit's real bank (confirmable `bank` from the UI wins). Never the old
      // hardcoded Worldpay default.
      const resolvedBank = (bank as number | undefined) ?? (await resolveDepositBankId(current)) ?? 169;
      const currentDate = new Date().toISOString().split('T')[0];
      const description = isCrossJob
        ? `${current.hirehop_job_id} - Excess applied to invoice (cross-job → ${target_hh_job})`
        : `${current.hirehop_job_id} - Excess applied to invoice`;
      const crossJobTag = isCrossJob ? ` (cross-job → job ${target_hh_job})` : '';
      const memo = notes
        ? `Excess claim — ${notes}${crossJobTag} (recorded via Ooosh OP)`
        : `Excess claim — applied to invoice${crossJobTag} (recorded via Ooosh OP)`;

      console.log(`[excess] Claim: applying £${amount} of deposit ${current.hh_deposit_id} (bank ${resolvedBank}) to invoice ${invoice_id}${isCrossJob ? ` on job ${target_hh_job} (cross-job)` : ` on job ${current.hirehop_job_id}`}`);
      const hhResult = await hhBroker.post('/php_functions/billing_payments_save.php', {
        id: 0,
        date: currentDate,
        desc: description,
        paid: amount,
        memo: memo,
        bank: resolvedBank,
        OWNER: invoice_id,
        deposit: current.hh_deposit_id,
        correction: 0,
        no_webhook: 1,
      }, { priority: 'high' });

      if (!hhResult.success || !hhResult.data) {
        console.error('[excess] HH claim apply failed:', hhResult.error, hhResult.data);
        res.status(502).json({
          error: 'HireHop application failed',
          detail: hhResult.error || 'HireHop did not accept the deposit-to-invoice application. OP record not updated. Confirm the invoice is approved and has owing balance, then retry.',
        });
        return;
      }

      hhPaymentAppId = (hhResult.data as any).hh_id || (hhResult.data as any).id || (hhResult.data as any).ID || null;
      console.log(`[excess] HH claim application created: ${hhPaymentAppId}`);

      // Trigger Xero sync (post_payment — same as reimburse, NOT post_deposit).
      // Best-effort: HH application already succeeded, so OP and HH are in sync;
      // failed Xero sync just means a delay until next reconciliation pass.
      if (hhPaymentAppId) {
        try {
          await hhBroker.post('/php_functions/accounting/tasks.php', {
            hh_package_type: 1,
            hh_acc_package_id: 3,
            hh_task: 'post_payment',
            hh_id: hhPaymentAppId,
            hh_acc_id: '',
          }, { priority: 'high' });
          console.log('[excess] Xero sync triggered for claim application');
        } catch (e) {
          console.error('[excess] Xero sync for claim failed (non-fatal — application posted, sync may catch up later):', e);
        }
      }
    }

    // ── Update the OP record ─────────────────────────────────────────────
    // Accumulate claim_amount; append notes with timestamp separator so multiple
    // claim events stay traceable.
    const newClaimTotal = alreadyClaimed + amount;
    const fullyConsumed = (newClaimTotal + alreadyReimbursed) >= amountTaken - 0.005;
    // Only move to fully_claimed when claims fully consume the deposit AND no
    // reimbursement has occurred. Otherwise leave status as-is (typically
    // 'taken') so it's clear there's still a balance to nibble or refund.
    const newStatus = fullyConsumed && alreadyReimbursed < 0.005
      ? 'fully_claimed'
      : current.excess_status;

    const dateStr = new Date().toISOString().split('T')[0];
    const crossJobNote = target_hh_job != null && Number(target_hh_job) !== Number(current.hirehop_job_id)
      ? ` → job ${target_hh_job} invoice`
      : '';
    const noteEntry = notes
      ? `[${dateStr}] £${amount.toFixed(2)}${crossJobNote}: ${notes}`
      : `[${dateStr}] £${amount.toFixed(2)} claim${crossJobNote}`;
    const newNotes = current.claim_notes
      ? `${current.claim_notes}\n${noteEntry}`
      : noteEntry;

    const result = await query(
      `UPDATE job_excess SET
        excess_status = $1,
        claim_amount = $2,
        claim_date = NOW(),
        claim_notes = $3,
        updated_at = NOW()
      WHERE id = $4
      RETURNING *`,
      [newStatus, newClaimTotal, newNotes, id]
    );

    const excess = result.rows[0];
    sendExcessEmail({
      templateId: 'excess_claimed',
      excessId: id as string,
      jobId: excess.job_id,
      amount,
      reason: notes || undefined,
    }).catch(e => console.error('[excess] Claim email failed:', e));

    if (excess.job_id) {
      syncExcessRequirementStatus(excess.job_id).catch(e =>
        console.error('[excess] syncExcessRequirementStatus failed (claim):', e)
      );
    }

    res.json({
      data: { ...excess, hh_payment_application_id: hhPaymentAppId },
      ...(isHhLinked ? {} : { op_only: true }),
    });
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : String(error);
    console.error('[excess] Claim error:', errMsg, error);
    res.status(500).json({ error: 'Failed to record claim', detail: errMsg });
  }
});

// ── POST /api/excess/:id/reimburse — Record reimbursement ──
// Pushes a payment application (refund) to HireHop against the original excess deposit.
// Uses billing_payments_save.php (NOT billing_deposit_save.php — negative deposits are wrong).
//
// Loud-fail policy: if the excess record is linked to an HH job, we MUST find the
// original deposit and push the refund — otherwise we'd create a silent gap between
// OP (showing reimbursed) and HireHop/Xero (still holding the deposit). On failure
// we return 422/502 with detail and leave the OP record untouched.
//
// OP-only excess records (no hirehop_job_id) are still allowed — manual housekeeping
// only, no HH/Xero touchpoint to drift from. Response includes op_only: true so the
// UI can flag it.

router.post('/:id/reimburse', authorize(...MANAGER_ROLES), validate(reimburseSchema), async (req: AuthRequest, res: Response) => {
  try {
    const { id } = req.params;
    const { amount, method, bank_details, retain_residual, acknowledge_no_stripe_refund } = req.body;

    // Get the current excess record to determine partial vs full
    const currentResult = await query(`SELECT * FROM job_excess WHERE id = $1`, [id]);
    if (currentResult.rows.length === 0) {
      res.status(404).json({ error: 'Excess record not found' });
      return;
    }
    const current = currentResult.rows[0];
    const amountTaken = parseFloat(current.excess_amount_taken || '0');
    const alreadyReimbursed = parseFloat(current.reimbursement_amount || '0');
    const claimed = parseFloat(current.claim_amount || '0');
    const remaining = amountTaken - alreadyReimbursed - claimed;
    if (amount > remaining + 0.005) {
      res.status(400).json({
        error: 'Reimbursement amount exceeds amount available',
        detail: `Available: £${remaining.toFixed(2)}, requested: £${amount.toFixed(2)}`,
      });
      return;
    }
    // "Partial refund" (client got back LESS than the full held balance) — drives
    // the email template + retained-amount line. Must factor in prior claims,
    // otherwise a £100 deposit with £40 claimed + £60 reimbursed flags as partial
    // when it's actually fully resolved.
    const isPartial = (alreadyReimbursed + amount + claimed) < amountTaken - 0.005;

    // The unaccounted-for balance left AFTER this reimburse (taken minus everything
    // reimbursed + claimed). Positive only when isPartial.
    const residual = Math.max(amountTaken - alreadyReimbursed - amount - claimed, 0);
    // When staff flag the residual as retained (kept by Ooosh — damage/admin),
    // book it as a claim so held → 0 and the record fully resolves. Otherwise it
    // stays genuinely HELD (still owed to the client, to be refunded later).
    const retainResidual = !!retain_residual && residual > 0.005;
    const newClaimAmount = retainResidual ? claimed + residual : claimed;
    // Record is fully resolved when there's no unaccounted balance OR the residual
    // is being retained as a claim. Only the "still owed" case stays partial.
    const resolvedStatus = (!isPartial || retainResidual) ? 'reimbursed' : 'partially_reimbursed';

    // ── Step 0: Stripe refund — when method=stripe_gbp + the record carries a
    // PaymentIntent reference, OP originates the refund directly via the Stripe
    // API. Closes the "OP first" loop so staff don't have to bounce out to the
    // Stripe dashboard or the portal. For other methods (BACS, cash, etc.)
    // skipped — the real-world money movement happens off-system. ─────────────
    //
    // PI resolution: the dedicated stripe_payment_intent_id column is the canonical
    // source, but the portal's straight-charge path historically only wrote the PI
    // into payment_reference (NOT the column) — so fall back to payment_reference
    // when it's a pi_ value. Without this fallback the refund silently no-op'd and
    // OP/HH/email all claimed a refund Stripe never saw (jobs 15433/15489/15544/
    // 15781/15235/15358/15503/15996 — Jun 2026).
    const looksLikeStripePi = (v: unknown): v is string =>
      typeof v === 'string' && /^pi_[A-Za-z0-9]+$/.test(v.trim());
    const resolvedPi: string | null =
      (looksLikeStripePi(current.stripe_payment_intent_id) ? current.stripe_payment_intent_id.trim() : null) ||
      (looksLikeStripePi(current.payment_reference) ? current.payment_reference.trim() : null);

    let stripeRefundId: string | null = null;
    const stripeRefundPath = method === 'stripe_gbp' && !!resolvedPi;

    // Loud-fail guard (no silent swallows): a Stripe reimbursement with no PI to
    // refund against MUST NOT silently record + email a refund that never fires.
    // Refuse unless staff explicitly acknowledge they've already refunded in the
    // Stripe dashboard (record-only). Mirrors the missing-HH-deposit loud fail.
    if (method === 'stripe_gbp' && !resolvedPi && !acknowledge_no_stripe_refund) {
      res.status(422).json({
        error: 'No Stripe PaymentIntent on this record',
        code: 'no_stripe_pi',
        detail: 'This excess has no Stripe PaymentIntent stored, so OP cannot issue the refund via the Stripe API. Refund it in the Stripe dashboard, then tick "Already refunded in Stripe — record only", or link the PaymentIntent to this record and try again.',
      });
      return;
    }

    if (stripeRefundPath) {
      if (!isStripeConfigured()) {
        res.status(503).json({
          error: 'Stripe not configured',
          detail: 'Stripe API key is missing. Use a different reimburse method, or contact engineering.',
        });
        return;
      }
      try {
        const stripe = getStripeClient();
        const refund = await stripe.refunds.create({
          payment_intent: resolvedPi as string,
          amount: Math.round(amount * 100),
        });
        stripeRefundId = refund.id;
        console.log(`[excess] Stripe refund created: ${refund.id} (£${amount.toFixed(2)} on PI ${resolvedPi})`);
      } catch (err) {
        const msg = isStripeError(err) ? err.message : (err instanceof Error ? err.message : 'Unknown error');
        console.error('[excess] Stripe refund failed:', msg);
        res.status(502).json({
          error: 'Stripe refund failed',
          detail: msg,
        });
        return;
      }
    }

    // ── Step 1: Find the original HH deposit ID (for HH-linked records) ─────
    let hhDepositId: number | null = null;
    let hhPaymentAppId: number | null = null;
    let hhPushError: string | null = null;  // surfaced to staff when stripe path can't push HH paperwork
    const isHhLinked = Boolean(current.hirehop_job_id);

    if (isHhLinked) {
      // Priority 1: hh_deposit_id directly on the excess record (set by money.ts
      // record-payment, by passive reconciliation, or by the rollover linkage in
      // the payment endpoint above).
      if (current.hh_deposit_id) {
        hhDepositId = current.hh_deposit_id;
        console.log(`[excess] Found HH deposit ID on excess record: ${hhDepositId}`);
      }
      // Priority 2: most recent matching job_payments row.
      if (!hhDepositId) {
        const paymentResult = await query(
          `SELECT hirehop_deposit_id FROM job_payments
           WHERE excess_id = $1 AND hirehop_deposit_id IS NOT NULL
           ORDER BY payment_date DESC LIMIT 1`,
          [id]
        );
        if (paymentResult.rows.length > 0 && paymentResult.rows[0].hirehop_deposit_id) {
          hhDepositId = paymentResult.rows[0].hirehop_deposit_id;
          console.log(`[excess] Found HH deposit ID from job_payments: ${hhDepositId}`);
        }
      }
      // Priority 3: scan HH billing for an excess-tagged deposit on this job.
      if (!hhDepositId) {
        console.log(`[excess] Searching HH billing for excess deposits on job ${current.hirehop_job_id}`);
        try {
          const billingRes = await hhBroker.get('/php_functions/billing_list.php',
            { main_id: current.hirehop_job_id, type: 1 },
            { priority: 'high', cacheTTL: 0 }
          );
          if (billingRes.success && billingRes.data) {
            const bl = billingRes.data as Record<string, any>;
            for (const row of bl.rows || []) {
              if (parseInt(row.kind ?? '0') === 6) { // Deposit/Payment
                const desc = String(row.data?.DESCRIPTION || row.desc || '').toLowerCase();
                const memo = String(row.data?.MEMO || '').toLowerCase();
                const isExcess = /excess|insurance|xs|top.?up/.test(desc + ' ' + memo);
                if (isExcess) {
                  hhDepositId = parseInt(row.data?.ID || row.number || String(row.id).replace('e', '') || '0');
                  console.log(`[excess] Found excess deposit in HH billing: ${hhDepositId} (desc: "${desc}")`);
                  break;
                }
              }
            }
          }
        } catch (e) {
          console.error('[excess] HH billing search failed during reimburse:', e);
        }
      }

      // No deposit found → loud fail. The cash chain is broken, refusing to drift.
      // Exception: when Stripe has already moved the money (Step 0), HH paperwork
      // is a record-keeping nice-to-have, not a money gate — capture the gap as
      // hh_push_error and continue. The Stripe webhook will surface the refund
      // to staff via info@ in parallel.
      if (!hhDepositId) {
        if (stripeRefundPath) {
          hhPushError = current.payment_method === 'rolled_over'
            ? 'Stripe refund processed, but the HireHop deposit chain back to the original deposit is broken — OP record updated, but you may need to manually create the negative HH payment application to keep HH books matching.'
            : 'Stripe refund processed, but no matching HireHop deposit was found for paperwork — OP record updated. Check the linked HH job and add a manual negative payment application if needed.';
          console.warn(`[excess] Stripe refund succeeded but HH deposit lookup failed for excess ${id}`);
        } else {
          res.status(422).json({
            error: 'Cannot locate original HireHop deposit',
            detail: current.payment_method === 'rolled_over'
              ? 'This excess was rolled over from a previous hire and the chain back to the original HireHop deposit is broken. Use the "Link HH Deposit" action on the Money tab to attach this record to the correct HireHop deposit before reimbursing.'
              : 'No excess deposit found on the linked HireHop job. Use the "Link HH Deposit" action on the Money tab to attach the correct HireHop deposit, or check that the original payment was recorded through OP.',
          });
          return;
        }
      }



      // ── Step 2: Push the refund payment application to HireHop ───────────
      if (hhDepositId) {
        const currentDate = new Date().toISOString().split('T')[0];
        const hhBankId = HH_BANK_IDS[method] || 265;
        const description = `${current.hirehop_job_id} - Excess refund${isPartial ? ' (partial)' : ''}`;
        const memo = `Insurance excess ${isPartial ? 'partial ' : ''}reimbursement — via ${method.replace(/_/g, ' ')} (recorded via Ooosh OP)`;

        console.log(`[excess] Creating HH payment application (refund) for job ${current.hirehop_job_id}, £${amount} against deposit ${hhDepositId}`);
        const hhResult = await hhBroker.post('/php_functions/billing_payments_save.php', {
          id: 0,
          date: currentDate,
          desc: description,
          paid: amount,
          memo: memo,
          bank: hhBankId,
          OWNER: 0,
          deposit: hhDepositId,
          no_webhook: 1,
        }, { priority: 'high' });

        if (!hhResult.success || !hhResult.data) {
          console.error('[excess] HH payment application creation failed:', hhResult.error, hhResult.data);
          if (stripeRefundPath) {
            // Stripe already moved the money — record the gap rather than abort.
            hhPushError = `Stripe refund processed, but HireHop paperwork push failed: ${hhResult.error || 'unknown error'}. OP record updated. Please retry the HH push manually or contact engineering.`;
          } else {
            res.status(502).json({
              error: 'HireHop refund failed',
              detail: hhResult.error || 'HireHop did not accept the payment application. OP record not updated. Please retry, or contact engineering if this persists.',
            });
            return;
          }
        } else {
          hhPaymentAppId = (hhResult.data as any).hh_id || (hhResult.data as any).id || (hhResult.data as any).ID || null;
          console.log(`[excess] HH payment application created: ${hhPaymentAppId}`);
        }
      }
    }

    // ── Step 3: Update the OP record (only reached if HH push succeeded, or
    // this is an OP-only record with nothing to push). ─────────────────────
    const result = await query(
      `UPDATE job_excess SET
        excess_status = $1,
        held_on_account = FALSE,
        reimbursement_amount = COALESCE(reimbursement_amount, 0) + $2,
        reimbursement_date = NOW(),
        reimbursement_method = $3,
        claim_amount = $5,
        -- Backfill the canonical PI column when we resolved it from
        -- payment_reference, so the charge.refunded webhook + future ops match.
        stripe_payment_intent_id = COALESCE(stripe_payment_intent_id, $7),
        notes = CASE WHEN $6::numeric > 0
                  THEN COALESCE(notes, '') || ' [£' || to_char($6::numeric, 'FM999990.00')
                       || ' residual retained as claim ' || to_char(NOW(), 'YYYY-MM-DD') || ']'
                  ELSE notes END,
        updated_at = NOW()
      WHERE id = $4
      RETURNING *`,
      [resolvedStatus, amount, method, id, newClaimAmount, retainResidual ? residual : 0, stripeRefundPath ? resolvedPi : null]
    );

    const excess = result.rows[0];

    // ── Persist client bank details (encrypted) when supplied ──────────────
    // Captured at reimburse time for bank-transfer methods. Scoped to this
    // record; stamps last_used_at so a future reuse-lookup can flag staleness.
    let bankDetailsWarning: string | null = null;
    if (bank_details) {
      if (!isEncryptionConfigured()) {
        // Don't store PII in plaintext if the key is missing. The reimbursement
        // itself already succeeded — surface a warning rather than failing.
        bankDetailsWarning = 'Reimbursement recorded, but bank details were NOT saved: encryption key not configured on the server (ENCRYPTION_KEY). Details were not stored in plaintext.';
        console.warn('[excess] Bank details provided but ENCRYPTION_KEY not set — not storing.');
      } else {
        try {
          const encrypted = encryptJson(bank_details);
          await query(
            `UPDATE job_excess SET
              bank_details_encrypted    = $1,
              bank_details_last_used_at = NOW(),
              bank_details_updated_at   = NOW(),
              updated_at                = NOW()
            WHERE id = $2`,
            [encrypted, id]
          );
        } catch (e) {
          bankDetailsWarning = 'Reimbursement recorded, but saving bank details failed. Re-enter on the record if you need them stored.';
          console.error('[excess] Bank details encryption/store failed (non-fatal):', e);
        }
      }
    } else if (excess.bank_details_encrypted) {
      // Reimbursing against already-stored details — stamp last_used_at so the
      // staleness heads-up stays accurate on future hires.
      await query(
        `UPDATE job_excess SET bank_details_last_used_at = NOW(), updated_at = NOW() WHERE id = $1`,
        [id]
      ).catch(e => console.error('[excess] bank_details_last_used_at stamp failed (non-fatal):', e));
    }

    // ── Step 4: Trigger Xero sync (best-effort — HH push already succeeded,
    // so OP and HH are in sync. If Xero sync fails the next sync will pick it
    // up). Logged so engineering can investigate. ──────────────────────────
    if (hhPaymentAppId) {
      try {
        await hhBroker.post('/php_functions/accounting/tasks.php', {
          hh_package_type: 1,
          hh_acc_package_id: 3,
          hh_task: 'post_payment',
          hh_id: hhPaymentAppId,
          hh_acc_id: '',
        }, { priority: 'high' });
        console.log('[excess] Xero sync triggered for payment application');
      } catch (e) {
        console.error('[excess] Xero sync for refund failed (non-fatal — payment posted, sync may catch up later):', e);
      }
    }

    // Send reimbursement email
    sendExcessEmail({
      templateId: isPartial ? 'excess_partial_reimbursed' : 'excess_reimbursed',
      excessId: id as string,
      jobId: excess.job_id,
      amount,
      paymentMethod: method,
      refundAmount: amount,
      originalAmount: amountTaken,
      retainedAmount: isPartial ? amountTaken - amount : 0,
    }).catch(e => console.error('[excess] Reimburse email failed:', e));

    if (excess.job_id) {
      syncExcessRequirementStatus(excess.job_id).catch(e =>
        console.error('[excess] syncExcessRequirementStatus failed (reimburse):', e)
      );
    }

    // Refund-leg ledger: when OP initiated a Stripe refund, pre-record the
    // dedup leg so the incoming `charge.refunded` webhook (which always fires
    // for OP-initiated refunds too) sees an existing entry and no-ops. Source
    // ref shape MUST match what `stripe-webhook.ts charge.refunded` produces.
    if (stripeRefundId) {
      await query(
        `UPDATE job_excess
         SET refund_legs = COALESCE(refund_legs, '[]'::jsonb) || $1::jsonb
         WHERE id = $2`,
        [
          JSON.stringify([{
            source: 'manual',
            ref: `stripe_refund_${stripeRefundId}`,
            amount,
            at: new Date().toISOString(),
          }]),
          id,
        ]
      ).catch(e => console.error('[excess] Refund leg append failed (non-fatal):', e));
    } else if (method === 'stripe_gbp') {
      // Record-only path: staff acknowledged they refunded in the Stripe dashboard
      // (no PI on record to fire the API). Stamp a leg so the silent-failure
      // detector (scheduler) treats this as resolved, not a swallowed refund.
      await query(
        `UPDATE job_excess
         SET refund_legs = COALESCE(refund_legs, '[]'::jsonb) || $1::jsonb,
             notes = COALESCE(notes, '') || $3,
             updated_at = NOW()
         WHERE id = $2`,
        [
          JSON.stringify([{
            source: 'manual',
            ref: 'recorded_only',
            amount,
            at: new Date().toISOString(),
          }]),
          id,
          ` [${new Date().toISOString().split('T')[0]} Stripe refund recorded only — done manually in Stripe dashboard, not via OP]`,
        ]
      ).catch(e => console.error('[excess] Record-only leg append failed (non-fatal):', e));
    }

    res.json({
      data: { ...excess, hh_payment_application_id: hhPaymentAppId },
      ...(isHhLinked ? {} : { op_only: true }),
      ...(bankDetailsWarning ? { warning: bankDetailsWarning } : {}),
      ...(stripeRefundId ? { stripe_refund_id: stripeRefundId } : {}),
      ...(!stripeRefundId && method === 'stripe_gbp' ? { stripe_recorded_only: true } : {}),
      ...(hhPushError ? { hh_push_error: hhPushError } : {}),
    });
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : String(error);
    console.error('[excess] Reimburse error:', errMsg, error);
    res.status(500).json({ error: 'Failed to record reimbursement', detail: errMsg });
  }
});

// ── POST /api/excess/:id/mark-externally-resolved ──
// Cleanup action: money flowed in and back out of OP's awareness (e.g. portal
// charged + HH-side refund pre-dating the auto-reconciliation). Sets
// excess_amount_taken AND reimbursement_amount to `amount` in one shot, flips
// to `reimbursed`, does NOT push to HH (the HH side is already correct, that's
// the whole point). Inherits the router-level STAFF_ROLES gate — same tier as
// recording payments / reimbursing.
//
// Conservative guard: rejects records that have ANY existing payment activity
// (amount_taken > 0, amount_held > 0, claim_amount > 0, reimbursement_amount > 0
// or hh_deposit_id IS NOT NULL) — those should go through the normal payment /
// reimburse paths, not this cleanup. The use case is records that look like
// "nothing ever happened" but money has actually moved out-of-band.

router.post('/:id/mark-externally-resolved', validate(externallyResolvedSchema), async (req: AuthRequest, res: Response) => {
  try {
    const { id } = req.params;
    const { amount, method, reference, reason } = req.body;

    const cur = await query(
      `SELECT excess_amount_taken, amount_held, claim_amount, reimbursement_amount,
              hh_deposit_id, excess_status, notes, job_id
       FROM job_excess WHERE id = $1`,
      [id]
    );
    if (cur.rows.length === 0) {
      res.status(404).json({ error: 'Excess record not found' });
      return;
    }
    const row = cur.rows[0];

    const hasActivity =
      parseFloat(row.excess_amount_taken || '0') > 0.005 ||
      parseFloat(row.amount_held || '0') > 0.005 ||
      parseFloat(row.claim_amount || '0') > 0.005 ||
      parseFloat(row.reimbursement_amount || '0') > 0.005 ||
      row.hh_deposit_id != null;
    if (hasActivity) {
      res.status(409).json({
        error: 'record_has_activity',
        detail: 'This record already has payment / claim / reimburse activity or a HireHop deposit linkage. Use Record Payment / Reimburse / Unlink HireHop Deposit instead — Mark as Externally Resolved is only for records that look like nothing happened but money actually moved out-of-band.',
      });
      return;
    }

    const dateStr = new Date().toISOString().split('T')[0];
    const noteLine = `[${dateStr} Externally Resolved] £${amount.toFixed(2)} via ${method}${reference ? ` (${reference})` : ''} — ${reason}. Record marked as collected-then-reimbursed to match external system; no HH push.`;
    const newNotes = row.notes ? `${row.notes}\n${noteLine}` : noteLine;

    const result = await query(
      `UPDATE job_excess SET
        excess_amount_taken = $1,
        reimbursement_amount = $1,
        excess_status = 'reimbursed',
        held_on_account = FALSE,
        payment_method = $2,
        payment_reference = $3,
        payment_date = COALESCE(payment_date, NOW()),
        reimbursement_date = NOW(),
        reimbursement_method = $2,
        notes = $4,
        updated_at = NOW()
       WHERE id = $5
       RETURNING *`,
      [amount, method, reference || null, newNotes, id]
    );

    // Re-derive the close-out requirement state.
    if (row.job_id) {
      const { syncExcessRequirementStatus } = await import('../services/excess-requirement-sync');
      syncExcessRequirementStatus(row.job_id).catch((e) =>
        console.error('[excess] syncExcessRequirementStatus failed (externally-resolved):', e)
      );
    }

    await query(
      `INSERT INTO audit_log (user_id, entity_type, entity_id, action, before_json, after_json)
       VALUES ($1, 'job_excess', $2, 'mark_externally_resolved', $3::jsonb, $4::jsonb)`,
      [
        req.user!.id,
        id,
        JSON.stringify({
          excess_status: row.excess_status,
          excess_amount_taken: row.excess_amount_taken,
          reimbursement_amount: row.reimbursement_amount,
        }),
        JSON.stringify({
          excess_status: 'reimbursed',
          excess_amount_taken: amount,
          reimbursement_amount: amount,
          reason,
        }),
      ]
    ).catch((err) => console.error('[excess] audit_log insert failed (externally-resolved):', err));

    console.log(`[excess] Externally resolved ${id} (by user ${req.user!.id}) — £${amount} via ${method}: ${reason}`);
    res.json({ data: result.rows[0], message: 'Record marked as externally resolved' });
  } catch (error) {
    console.error('[excess] mark-externally-resolved error:', error);
    res.status(500).json({ error: 'Failed to mark record as externally resolved' });
  }
});

// ── POST /api/excess/:id/waive — Waive excess (admin only) ──

router.post('/:id/waive', authorize('admin'), validate(waiveSchema), async (req: AuthRequest, res: Response) => {
  try {
    const { id } = req.params;
    const { reason } = req.body;

    const result = await query(
      `UPDATE job_excess SET
        excess_status = 'waived',
        claim_notes = $1,
        updated_at = NOW()
      WHERE id = $2
      RETURNING *`,
      [reason, id]
    );

    if (result.rows.length === 0) {
      res.status(404).json({ error: 'Excess record not found' });
      return;
    }

    const excess = result.rows[0];
    if (excess.job_id) {
      syncExcessRequirementStatus(excess.job_id).catch(e =>
        console.error('[excess] syncExcessRequirementStatus failed (waive):', e)
      );
    }

    res.json({ data: result.rows[0] });
  } catch (error) {
    console.error('[excess] Waive error:', error);
    res.status(500).json({ error: 'Failed to waive excess' });
  }
});

// ── POST /api/excess/:id/override — Manager override to allow dispatch without excess ──

router.post('/:id/override', authorize(...MANAGER_ROLES), validate(overrideSchema), async (req: AuthRequest, res: Response) => {
  try {
    const { id } = req.params;
    const { reason, notes } = req.body;

    const overrideNotes = reason === 'other' ? (notes || 'No details provided') : reason.replace(/_/g, ' ');

    const result = await query(
      `UPDATE job_excess SET
        dispatch_override = true,
        dispatch_override_reason = $1,
        dispatch_override_by = $2,
        dispatch_override_at = NOW(),
        notes = CASE WHEN notes IS NULL THEN $3 ELSE notes || E'\n' || $3 END,
        updated_at = NOW()
      WHERE id = $4
      RETURNING *`,
      [overrideNotes, req.user!.id, `Override: ${overrideNotes}`, id]
    );

    if (result.rows.length === 0) {
      res.status(404).json({ error: 'Excess record not found' });
      return;
    }

    res.json({ data: result.rows[0] });
  } catch (error) {
    console.error('[excess] Override error:', error);
    res.status(500).json({ error: 'Failed to record override' });
  }
});

// ── POST /api/excess/:id/move — Move excess to a different Xero contact / person ──

router.post('/:id/move', authorize(...MANAGER_ROLES), validate(moveExcessSchema), async (req: AuthRequest, res: Response) => {
  try {
    const { id } = req.params;
    const { xero_contact_id, xero_contact_name, client_name, person_id, reason } = req.body;

    console.log('[excess] Move attempt:', { id, xero_contact_id, xero_contact_name, client_name, person_id, reason });

    const effectiveClientName = client_name || xero_contact_name;

    const result = await query(
      `UPDATE job_excess SET
        xero_contact_id = $1,
        xero_contact_name = $2,
        client_name = $3,
        person_id = $4,
        notes = CASE WHEN notes IS NULL THEN $5 ELSE notes || E'\n' || $5 END,
        updated_at = NOW()
      WHERE id = $6
      RETURNING *`,
      [
        xero_contact_id || null,
        xero_contact_name,
        effectiveClientName,
        person_id || null,
        `Moved to ${xero_contact_name}${reason ? ': ' + reason : ''}`,
        id,
      ]
    );

    if (result.rows.length === 0) {
      res.status(404).json({ error: 'Excess record not found' });
      return;
    }

    res.json({ data: result.rows[0] });
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : String(error);
    console.error('[excess] Move error:', errMsg, error);
    res.status(500).json({ error: 'Failed to move excess record', detail: errMsg });
  }
});

// ── POST /api/excess/:id/link-deposit — Manually link an HH deposit to this excess record ──
// Used when auto-reconciliation can't match (e.g. deposit description doesn't contain excess keywords)

const linkDepositSchema = z.object({
  hh_deposit_id: z.number().int().min(1),
  amount: z.number().min(0.01).optional(), // If provided, also updates excess_amount_taken
});

router.post('/:id/link-deposit', validate(linkDepositSchema), async (req: AuthRequest, res: Response) => {
  try {
    const { id } = req.params;
    const { hh_deposit_id, amount } = req.body;

    // Check the excess record exists
    const currentResult = await query(`SELECT * FROM job_excess WHERE id = $1`, [id]);
    if (currentResult.rows.length === 0) {
      res.status(404).json({ error: 'Excess record not found' });
      return;
    }

    const current = currentResult.rows[0];

    // Check this HH deposit isn't already linked to another excess record
    const dupeCheck = await query(
      `SELECT id FROM job_excess WHERE hh_deposit_id = $1 AND id != $2`,
      [hh_deposit_id, id]
    );
    if (dupeCheck.rows.length > 0) {
      res.status(409).json({ error: 'This HireHop deposit is already linked to another excess record' });
      return;
    }

    // Build the update
    const updateParts = [
      'hh_deposit_id = $1',
      'hh_reconciled_at = NOW()',
      `hh_reconcile_source = 'manual_link'`,
      'updated_at = NOW()',
    ];
    const params: unknown[] = [hh_deposit_id];

    // If amount provided, update the excess amount taken and status
    if (amount) {
      const currentTaken = parseFloat(current.excess_amount_taken || 0);
      const newTaken = currentTaken + amount;
      const required = parseFloat(current.excess_amount_required || 0);
      const newStatus = required > 0 && newTaken >= required ? 'taken' : 'partially_paid';

      params.push(newTaken, newStatus);
      updateParts.push(`excess_amount_taken = $${params.length - 1}`);
      updateParts.push(`excess_status = $${params.length}`);
      updateParts.push(`payment_date = COALESCE(payment_date, NOW())`);
    }

    params.push(id);
    const result = await query(
      `UPDATE job_excess SET ${updateParts.join(', ')} WHERE id = $${params.length} RETURNING *`,
      params
    );

    console.log(`[excess] Manual link: HH deposit ${hh_deposit_id} → excess ${id} (by user ${req.user!.id})`);
    res.json({ data: result.rows[0] });
  } catch (error) {
    console.error('[excess] Link deposit error:', error);
    res.status(500).json({ error: 'Failed to link deposit' });
  }
});

// ── POST /api/excess/:id/unlink-deposit — Remove the HH deposit link ──
//
// Used when a HireHop deposit was wrongly linked to this excess record (e.g.
// the classifier picked it up as excess but it was actually a hire payment,
// such as a Stripe URL containing "xs" in its path). "Undoes" the
// reconciliation: zeroes amount_taken + payment metadata, and recomputes
// status via deriveExcessStatus so a fresh `needed`/`not_required` surface
// is presented to staff and the portal.

router.post('/:id/unlink-deposit', async (req: AuthRequest, res: Response) => {
  try {
    const { id } = req.params;

    const current = await query(
      `SELECT excess_amount_required, excess_status FROM job_excess WHERE id = $1`,
      [id]
    );
    if (current.rows.length === 0) {
      res.status(404).json({ error: 'Excess record not found' });
      return;
    }
    const row = current.rows[0];
    const newStatus = deriveExcessStatus(
      row.excess_status,
      Number(row.excess_amount_required || 0),
      0 // taken is being zeroed
    );

    const result = await query(
      `UPDATE job_excess SET
        hh_deposit_id = NULL,
        hh_reconciled_at = NULL,
        hh_reconcile_source = NULL,
        excess_amount_taken = 0,
        payment_method = NULL,
        payment_reference = NULL,
        payment_date = NULL,
        excess_status = $2,
        updated_at = NOW()
      WHERE id = $1 RETURNING *`,
      [id, newStatus]
    );

    if (result.rows.length === 0) {
      res.status(404).json({ error: 'Excess record not found' });
      return;
    }

    console.log(`[excess] Unlinked HH deposit from excess ${id} (by user ${req.user!.id}) — reset taken to 0, status → ${newStatus}`);
    res.json({ data: result.rows[0] });
  } catch (error) {
    console.error('[excess] Unlink deposit error:', error);
    res.status(500).json({ error: 'Failed to unlink deposit' });
  }
});

// ── GET /api/excess/by-person/:personId — Excess history for a person (address book) ──

router.get('/by-person/:personId', async (req: AuthRequest, res: Response) => {
  try {
    const { personId } = req.params;

    const result = await query(
      `SELECT je.*,
        vha.hirehop_job_name,
        vha.hire_start,
        vha.hire_end,
        fv.reg AS vehicle_reg,
        d.full_name AS driver_name,
        j.job_name
      FROM job_excess je
      LEFT JOIN vehicle_hire_assignments vha ON vha.id = je.assignment_id
      LEFT JOIN fleet_vehicles fv ON fv.id = vha.vehicle_id
      LEFT JOIN drivers d ON d.id = vha.driver_id
      LEFT JOIN jobs j ON j.id = je.job_id
      WHERE je.person_id = $1
         OR vha.driver_id IN (SELECT id FROM drivers WHERE person_id = $1)
      ORDER BY je.created_at DESC`,
      [personId]
    );

    // Calculate summary
    const records = result.rows;
    const totalTaken = records.reduce((sum: number, r: any) => sum + parseFloat(r.excess_amount_taken || 0), 0);
    const totalClaimed = records.reduce((sum: number, r: any) => sum + parseFloat(r.claim_amount || 0), 0);
    const totalReimbursed = records.reduce((sum: number, r: any) => sum + parseFloat(r.reimbursement_amount || 0), 0);
    const pendingCount = records.filter((r: any) => r.excess_status === 'needed' || r.excess_status === 'pending').length;

    res.json({
      summary: {
        total_hires: records.length,
        total_taken: totalTaken,
        total_claimed: totalClaimed,
        total_reimbursed: totalReimbursed,
        balance_held: totalTaken - totalClaimed - totalReimbursed,
        pending_count: pendingCount,
      },
      history: records,
    });
  } catch (error) {
    console.error('[excess] By person error:', error);
    res.status(500).json({ error: 'Failed to load person excess history' });
  }
});

// ── GET /api/excess/by-org/:orgId — Excess history for an organisation (address book) ──

router.get('/by-org/:orgId', async (req: AuthRequest, res: Response) => {
  try {
    const { orgId } = req.params;

    // Find excess records where the job's client org matches, or xero_contact matches org's external ID
    const result = await query(
      `SELECT je.*,
        vha.hirehop_job_name,
        vha.hire_start,
        vha.hire_end,
        fv.reg AS vehicle_reg,
        d.full_name AS driver_name,
        j.job_name
      FROM job_excess je
      LEFT JOIN vehicle_hire_assignments vha ON vha.id = je.assignment_id
      LEFT JOIN fleet_vehicles fv ON fv.id = vha.vehicle_id
      LEFT JOIN drivers d ON d.id = vha.driver_id
      LEFT JOIN jobs j ON j.id = je.job_id
      WHERE j.client_id = $1
         OR je.xero_contact_id IN (
           SELECT external_id FROM external_id_map
           WHERE entity_type = 'organisation' AND entity_id = $1 AND source = 'xero'
         )
      ORDER BY je.created_at DESC`,
      [orgId]
    );

    const records = result.rows;
    const totalTaken = records.reduce((sum: number, r: any) => sum + parseFloat(r.excess_amount_taken || 0), 0);
    const totalClaimed = records.reduce((sum: number, r: any) => sum + parseFloat(r.claim_amount || 0), 0);
    const totalReimbursed = records.reduce((sum: number, r: any) => sum + parseFloat(r.reimbursement_amount || 0), 0);
    const pendingCount = records.filter((r: any) => r.excess_status === 'needed' || r.excess_status === 'pending').length;

    res.json({
      summary: {
        total_hires: records.length,
        total_taken: totalTaken,
        total_claimed: totalClaimed,
        total_reimbursed: totalReimbursed,
        balance_held: totalTaken - totalClaimed - totalReimbursed,
        pending_count: pendingCount,
      },
      history: records,
    });
  } catch (error) {
    console.error('[excess] By org error:', error);
    res.status(500).json({ error: 'Failed to load organisation excess history' });
  }
});

// ── GET /api/excess/client-balance/:xeroContactId — Quick balance check for auto-suggest ──

router.get('/client-balance/:xeroContactId', async (req: AuthRequest, res: Response) => {
  try {
    const { xeroContactId } = req.params;

    const result = await query(
      `SELECT * FROM client_excess_ledger WHERE xero_contact_id = $1`,
      [xeroContactId]
    );

    if (result.rows.length === 0) {
      res.json({ data: { balance_held: 0, rolled_over_count: 0, has_balance: false } });
      return;
    }

    const ledger = result.rows[0];
    res.json({
      data: {
        ...ledger,
        has_balance: parseFloat(ledger.balance_held) > 0 || parseInt(ledger.rolled_over_count) > 0,
      },
    });
  } catch (error) {
    console.error('[excess] Client balance error:', error);
    res.status(500).json({ error: 'Failed to check client balance' });
  }
});

export default router;
