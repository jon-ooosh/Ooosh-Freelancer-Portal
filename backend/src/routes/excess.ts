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
import { authenticate, authorize, AuthRequest } from '../middleware/auth';
import { validate } from '../middleware/validate';
import { emailService } from '../services/email-service';
import { hhBroker } from '../services/hirehop-broker';
import { pushDepositToHH } from '../services/hh-deposit';

const router = Router();
router.use(authenticate);

// ── Schemas ──

const updateExcessSchema = z.object({
  excess_amount_required: z.number().min(0).nullable().optional(),
  excess_amount_taken: z.number().min(0).optional(),
  excess_calculation_basis: z.string().nullable().optional(),
  excess_status: z.enum(['not_required', 'needed', 'taken', 'partially_paid', 'pre_auth', 'waived', 'fully_claimed', 'partially_reimbursed', 'reimbursed', 'rolled_over']).optional(),
  payment_method: z.string().max(30).nullable().optional(),
  payment_reference: z.string().max(200).nullable().optional(),
  xero_contact_id: z.string().max(100).nullable().optional(),
  xero_contact_name: z.string().max(200).nullable().optional(),
  client_name: z.string().max(200).nullable().optional(),
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
}).refine(
  (val) => val.total_collected !== undefined || val.amount !== undefined,
  { message: 'Either total_collected or amount must be provided' }
);

const claimSchema = z.object({
  amount: z.number().positive(),
  invoice_id: z.number().int().positive().nullable().optional(), // HH invoice ID (required for HH-linked records)
  notes: z.string().nullable().optional(),
});

const reimburseSchema = z.object({
  amount: z.number().min(0),
  method: z.enum(['stripe_gbp', 'worldpay', 'amex', 'wise_bacs', 'till_cash', 'paypal', 'lloyds_bank']),
});

const waiveSchema = z.object({
  reason: z.string().min(1),
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
    //   - 'rolled_over' is EXCLUDED here because that means it's already been
    //     chained forward to a newer record (which is the real source).
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
         AND je2.excess_status IN ('taken', 'partially_paid')
         AND j2.client_id = (SELECT client_id FROM jobs WHERE id = $2)
         AND j2.client_id IS NOT NULL
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

// ── GET /api/excess/ledger — Client excess ledger ──

router.get('/ledger', authorize('admin', 'manager'), async (_req: AuthRequest, res: Response) => {
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

router.get('/ledger/:xeroContactId', authorize('admin', 'manager'), async (req: AuthRequest, res: Response) => {
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
    const { total_collected, amount: bodyAmount, method, reference, notes, push_to_hirehop } = req.body;

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
          // Mark the previous record as rolled_over (terminal — cash has moved on).
          await query(
            `UPDATE job_excess
             SET excess_status = 'rolled_over',
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

router.post('/:id/claim', authorize('admin', 'manager'), validate(claimSchema), async (req: AuthRequest, res: Response) => {
  try {
    const { id } = req.params;
    const { amount, invoice_id, notes } = req.body;

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

      // ── Push the application to HireHop ──────────────────────────────
      // bank=169 (Worldpay default) is just metadata — no real cash moves; the
      // deposit is already in the bank, this just reallocates it from
      // "deposit liability" → "invoice paid" (which the invoice line item's
      // ACC_NOMINAL_ID then routes to the right Xero revenue account).
      const currentDate = new Date().toISOString().split('T')[0];
      const description = `${current.hirehop_job_id} - Excess applied to invoice`;
      const memo = notes
        ? `Excess claim — ${notes} (recorded via Ooosh OP)`
        : `Excess claim — applied to invoice (recorded via Ooosh OP)`;

      console.log(`[excess] Claim: applying £${amount} of deposit ${current.hh_deposit_id} to invoice ${invoice_id} on job ${current.hirehop_job_id}`);
      const hhResult = await hhBroker.post('/php_functions/billing_payments_save.php', {
        id: 0,
        date: currentDate,
        desc: description,
        paid: amount,
        memo: memo,
        bank: 169, // Worldpay default — metadata only, no real bank movement
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
    const noteEntry = notes
      ? `[${dateStr}] £${amount.toFixed(2)}: ${notes}`
      : `[${dateStr}] £${amount.toFixed(2)} claim`;
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

router.post('/:id/reimburse', authorize('admin', 'manager'), validate(reimburseSchema), async (req: AuthRequest, res: Response) => {
  try {
    const { id } = req.params;
    const { amount, method } = req.body;

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
    // Partial only if there's still UNACCOUNTED-FOR balance after this reimburse.
    // Must factor in prior claims, otherwise a £100 deposit with £40 claimed +
    // £60 reimbursed flags as partial when it's actually fully resolved.
    const isPartial = (alreadyReimbursed + amount + claimed) < amountTaken - 0.005;

    // ── Step 1: Find the original HH deposit ID (for HH-linked records) ─────
    let hhDepositId: number | null = null;
    let hhPaymentAppId: number | null = null;
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
      if (!hhDepositId) {
        res.status(422).json({
          error: 'Cannot locate original HireHop deposit',
          detail: current.payment_method === 'rolled_over'
            ? 'This excess was rolled over from a previous hire and the chain back to the original HireHop deposit is broken. Use the "Link HH Deposit" action on the Money tab to attach this record to the correct HireHop deposit before reimbursing.'
            : 'No excess deposit found on the linked HireHop job. Use the "Link HH Deposit" action on the Money tab to attach the correct HireHop deposit, or check that the original payment was recorded through OP.',
        });
        return;
      }

      // ── Step 2: Push the refund payment application to HireHop ───────────
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
        res.status(502).json({
          error: 'HireHop refund failed',
          detail: hhResult.error || 'HireHop did not accept the payment application. OP record not updated. Please retry, or contact engineering if this persists.',
        });
        return;
      }

      hhPaymentAppId = (hhResult.data as any).hh_id || (hhResult.data as any).id || (hhResult.data as any).ID || null;
      console.log(`[excess] HH payment application created: ${hhPaymentAppId}`);
    }

    // ── Step 3: Update the OP record (only reached if HH push succeeded, or
    // this is an OP-only record with nothing to push). ─────────────────────
    const result = await query(
      `UPDATE job_excess SET
        excess_status = $1,
        reimbursement_amount = COALESCE(reimbursement_amount, 0) + $2,
        reimbursement_date = NOW(),
        reimbursement_method = $3,
        updated_at = NOW()
      WHERE id = $4
      RETURNING *`,
      [isPartial ? 'partially_reimbursed' : 'reimbursed', amount, method, id]
    );

    const excess = result.rows[0];

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

    res.json({
      data: { ...excess, hh_payment_application_id: hhPaymentAppId },
      ...(isHhLinked ? {} : { op_only: true }),
    });
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : String(error);
    console.error('[excess] Reimburse error:', errMsg, error);
    res.status(500).json({ error: 'Failed to record reimbursement', detail: errMsg });
  }
});

// HireHop bank account IDs (shared with money.ts)
const HH_BANK_IDS: Record<string, number> = {
  stripe_gbp: 267, worldpay: 169, amex: 165, wise_bacs: 265,
  till_cash: 168, paypal: 173, lloyds_bank: 170, rolled_over: 265,
};

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

router.post('/:id/override', authorize('admin', 'manager'), validate(overrideSchema), async (req: AuthRequest, res: Response) => {
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

router.post('/:id/move', authorize('admin', 'manager'), validate(moveExcessSchema), async (req: AuthRequest, res: Response) => {
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

router.post('/:id/link-deposit', authorize('admin', 'manager'), validate(linkDepositSchema), async (req: AuthRequest, res: Response) => {
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

router.post('/:id/unlink-deposit', authorize('admin', 'manager'), async (req: AuthRequest, res: Response) => {
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
