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
import { authenticate, authorize, AuthRequest } from '../middleware/auth';
import { validate } from '../middleware/validate';
import { emailService } from '../services/email-service';
import { hhBroker } from '../services/hirehop-broker';

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

const paymentSchema = z.object({
  amount: z.number().min(0),
  method: z.enum(['stripe_gbp', 'worldpay', 'amex', 'wise_bacs', 'till_cash', 'paypal', 'lloyds_bank', 'rolled_over']),
  reference: z.string().max(200).nullable().optional(),
});

const claimSchema = z.object({
  amount: z.number().min(0),
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

// ── GET /api/excess — List excess records ──

router.get('/', async (req: AuthRequest, res: Response) => {
  try {
    const {
      status, hirehop_job_id, xero_contact_id, person_id, job_id,
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

    const countResult = await query(
      `SELECT COUNT(*) FROM job_excess je ${where}`,
      params
    );
    const total = parseInt(countResult.rows[0].count);

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
      LEFT JOIN vehicle_hire_assignments vha ON vha.id = je.assignment_id
      LEFT JOIN fleet_vehicles fv ON fv.id = vha.vehicle_id
      LEFT JOIN drivers d ON d.id = vha.driver_id
      LEFT JOIN jobs j ON j.id = je.job_id
      ${where}
      ORDER BY je.created_at DESC
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
    const { xeroContactId } = req.params;

    const summaryResult = await query(
      `SELECT * FROM client_excess_ledger WHERE xero_contact_id = $1`,
      [xeroContactId]
    );

    // Handle 'UNLINKED' — records with NULL xero_contact_id
    const isUnlinked = xeroContactId === 'UNLINKED';
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
      WHERE ${isUnlinked ? 'je.xero_contact_id IS NULL' : 'je.xero_contact_id = $1'}
      ORDER BY je.created_at DESC`,
      isUnlinked ? [] : [xeroContactId]
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

router.put('/:id', validate(updateExcessSchema), async (req: AuthRequest, res: Response) => {
  try {
    const { id } = req.params;
    const updates = req.body;

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
    const { amount, method, reference } = req.body;

    const result = await query(
      `UPDATE job_excess SET
        excess_amount_taken = COALESCE(excess_amount_taken, 0) + $1,
        excess_status = CASE
          WHEN COALESCE(excess_amount_taken, 0) + $1 >= COALESCE(excess_amount_required, 0) THEN 'taken'
          ELSE 'partially_paid'
        END,
        payment_method = $2,
        payment_reference = $3,
        payment_date = NOW(),
        updated_at = NOW()
      WHERE id = $4
      RETURNING *`,
      [amount, method, reference || null, id]
    );

    if (result.rows.length === 0) {
      res.status(404).json({ error: 'Excess record not found' });
      return;
    }

    // Send excess payment confirmation email
    const excess = result.rows[0];
    sendExcessEmail({
      templateId: 'excess_payment_confirmed',
      excessId: id as string,
      jobId: excess.job_id,
      amount,
      paymentMethod: method,
    }).catch(e => console.error('[excess] Payment email failed:', e));

    res.json({ data: result.rows[0] });
  } catch (error) {
    console.error('[excess] Payment error:', error);
    res.status(500).json({ error: 'Failed to record payment' });
  }
});

// ── POST /api/excess/:id/claim — Record damage claim ──

router.post('/:id/claim', validate(claimSchema), async (req: AuthRequest, res: Response) => {
  try {
    const { id } = req.params;
    const { amount, notes } = req.body;

    const result = await query(
      `UPDATE job_excess SET
        excess_status = 'fully_claimed',
        claim_amount = $1,
        claim_date = NOW(),
        claim_notes = $2,
        updated_at = NOW()
      WHERE id = $3
      RETURNING *`,
      [amount, notes || null, id]
    );

    if (result.rows.length === 0) {
      res.status(404).json({ error: 'Excess record not found' });
      return;
    }

    // Send claim email
    const excess = result.rows[0];
    sendExcessEmail({
      templateId: 'excess_claimed',
      excessId: id as string,
      jobId: excess.job_id,
      amount,
      reason: notes || undefined,
    }).catch(e => console.error('[excess] Claim email failed:', e));

    res.json({ data: result.rows[0] });
  } catch (error) {
    console.error('[excess] Claim error:', error);
    res.status(500).json({ error: 'Failed to record claim' });
  }
});

// ── POST /api/excess/:id/reimburse — Record reimbursement ──
// Pushes a payment application (refund) to HireHop against the original excess deposit.
// Uses billing_payments_save.php (NOT billing_deposit_save.php — negative deposits are wrong).

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
    const isPartial = amount < amountTaken;

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

    // Push refund to HireHop as a payment application against the original deposit
    let hhPaymentAppId: number | null = null;
    if (excess.hirehop_job_id) {
      try {
        // Step 1: Find the original HH deposit ID for this excess
        // First check if we stored it in job_payments when recording the excess payment
        let hhDepositId: number | null = null;

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

        // If not found in job_payments, search HH billing for excess deposits on this job
        if (!hhDepositId) {
          console.log(`[excess] Searching HH billing for excess deposits on job ${excess.hirehop_job_id}`);
          try {
            const billingRes = await hhBroker.get('/php_functions/billing_list.php',
              { main_id: excess.hirehop_job_id, type: 1 },
              { priority: 'high', cacheTTL: 0 } // No cache — need fresh data
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
          } catch { console.error('[excess] HH billing search failed (non-fatal)'); }
        }

        if (hhDepositId) {
          // Step 2: Create payment application (refund) against the deposit
          const currentDate = new Date().toISOString().split('T')[0];
          const hhBankId = HH_BANK_IDS[method] || 265;
          const description = `${excess.hirehop_job_id} - Excess refund${isPartial ? ' (partial)' : ''}`;
          const memo = `Insurance excess ${isPartial ? 'partial ' : ''}reimbursement — via ${method.replace(/_/g, ' ')} (recorded via Ooosh OP)`;

          console.log(`[excess] Creating HH payment application (refund) for job ${excess.hirehop_job_id}, £${amount} against deposit ${hhDepositId}`);
          const hhResult = await hhBroker.post('/php_functions/billing_payments_save.php', {
            id: 0,           // 0 = create new
            date: currentDate,
            desc: description,
            paid: amount,    // Positive amount — it's a payment application (refund)
            memo: memo,
            bank: hhBankId,
            OWNER: 0,
            deposit: hhDepositId,
            no_webhook: 1,
          }, { priority: 'high' });

          if (hhResult.success && hhResult.data) {
            hhPaymentAppId = (hhResult.data as any).hh_id || (hhResult.data as any).id || (hhResult.data as any).ID || null;
            console.log(`[excess] HH payment application created: ${hhPaymentAppId}`);

            // Step 3: Trigger Xero sync (post_payment, not post_deposit)
            if (hhPaymentAppId) {
              try {
                await hhBroker.post('/php_functions/accounting/tasks.php', {
                  hh_package_type: 1,
                  hh_acc_package_id: 3,
                  hh_task: 'post_payment', // Payment application, not deposit
                  hh_id: hhPaymentAppId,
                  hh_acc_id: '',
                }, { priority: 'high' });
                console.log('[excess] Xero sync triggered for payment application');
              } catch { console.error('[excess] Xero sync for refund failed (non-fatal)'); }
            }
          } else {
            console.error('[excess] HH payment application creation failed:', hhResult.error, hhResult.data);
          }
        } else {
          console.log('[excess] No HH excess deposit found to refund against — OP record updated but HH not modified');
        }
      } catch (hhErr) {
        console.error('[excess] HH refund write-back failed (non-fatal):', hhErr);
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

    res.json({ data: { ...excess, hh_payment_application_id: hhPaymentAppId } });
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

router.post('/:id/unlink-deposit', authorize('admin', 'manager'), async (req: AuthRequest, res: Response) => {
  try {
    const { id } = req.params;

    const result = await query(
      `UPDATE job_excess SET
        hh_deposit_id = NULL,
        hh_reconciled_at = NULL,
        hh_reconcile_source = NULL,
        updated_at = NOW()
      WHERE id = $1 RETURNING *`,
      [id]
    );

    if (result.rows.length === 0) {
      res.status(404).json({ error: 'Excess record not found' });
      return;
    }

    console.log(`[excess] Unlinked HH deposit from excess ${id} (by user ${req.user!.id})`);
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
