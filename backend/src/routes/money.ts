/**
 * Money Routes — Unified financial view per job.
 *
 * Reads from HireHop (hire value, deposits, billing) via the broker,
 * combines with OP data (excess, job_payments), and provides a single
 * financial picture for the Money tab on Job Detail.
 *
 * Also handles recording payments (pushes to HH as deposits).
 */
import { Router, Response } from 'express';
import { z } from 'zod';
import { query } from '../config/database';
import { authenticate, authorize, AuthRequest } from '../middleware/auth';
import { validate } from '../middleware/validate';
import { hhBroker } from '../services/hirehop-broker';

const router = Router();
router.use(authenticate);

// ── Schemas ──

const recordPaymentSchema = z.object({
  payment_type: z.enum(['deposit', 'balance', 'excess', 'refund', 'excess_refund', 'other']),
  amount: z.number().min(0.01),
  payment_method: z.enum(['stripe', 'stripe_preauth', 'bank_transfer', 'card_in_office', 'cash', 'paypal', 'rolled_over']),
  payment_reference: z.string().max(255).optional(),
  notes: z.string().max(1000).optional(),
  excess_id: z.string().uuid().optional(),
  push_to_hirehop: z.boolean().default(true),
});

// ── GET /api/money/:jobId/summary — Full financial summary for a job ──

router.get('/:jobId/summary', async (req: AuthRequest, res: Response) => {
  try {
    const { jobId } = req.params;

    // Get the job from OP database (need hh_job_number for HH API calls)
    const jobResult = await query(
      `SELECT id, hh_job_number, client_id, client_name, company_name
       FROM jobs WHERE id = $1`,
      [jobId]
    );

    if (jobResult.rows.length === 0) {
      res.status(404).json({ error: 'Job not found' });
      return;
    }

    const job = jobResult.rows[0];
    const hhJobId = job.hh_job_number;

    // Fetch HireHop billing data (deposits, payments, hire value)
    let hhBilling: any = null;
    let hhJobData: any = null;

    if (hhJobId) {
      try {
        const [billingRes, jobDataRes] = await Promise.all([
          hhBroker.get('/php_functions/billing_list.php', { job_id: hhJobId }, { priority: 'high', cacheTTL: 60 }),
          hhBroker.get('/api/job_data.php', { job: hhJobId }, { priority: 'high', cacheTTL: 60 }),
        ]);
        if (billingRes.success) hhBilling = billingRes.data;
        if (jobDataRes.success) hhJobData = jobDataRes.data;
        // Debug: log what HH actually returns so we can see field names
        if (hhJobData) {
          console.log('[money] HH job_data fields:', Object.keys(hhJobData as Record<string, unknown>).filter(k =>
            /total|value|price|amount|vat|billing|cost/i.test(k)
          ));
        }
        if (hhBilling) {
          const bd = hhBilling as any;
          console.log('[money] HH billing_list type:', typeof bd, Array.isArray(bd) ? `array[${bd.length}]` : Object.keys(bd).slice(0, 10));
        }
      } catch (hhError) {
        console.error('[money] HireHop fetch failed (non-fatal):', hhError);
      }
    }

    // Parse HireHop financial data
    // job_data.php returns fields like JOB_TOTAL, TOTAL, job_value, etc. — try multiple
    const jd = hhJobData as Record<string, any> | null;
    const hireValueExVat = parseFloat(
      jd?.JOB_TOTAL || jd?.TOTAL || jd?.job_total || jd?.job_value ||
      jd?.HIRE_CHARGE || jd?.hire_charge || jd?.PRICE || '0'
    );
    const vatRate = 0.20; // Standard UK VAT
    const vatAmount = hireValueExVat * vatRate;
    const hireValueIncVat = hireValueExVat + vatAmount;

    // Parse deposits from billing list
    const deposits: Array<{ id: number; amount: number; date: string; memo: string | null }> = [];
    let totalDeposits = 0;

    if (hhBilling) {
      const billingItems = Array.isArray(hhBilling) ? hhBilling : (hhBilling.rows || hhBilling.items || []);
      for (const item of billingItems) {
        const kind = parseInt(item.kind || item.KIND || '0');
        if (kind === 6) { // kind=6 = deposits in HireHop
          const amount = Math.abs(parseFloat(item.total || item.TOTAL || '0'));
          deposits.push({
            id: parseInt(item.id || item.ID || '0'),
            amount,
            date: item.date || item.DATE || '',
            memo: item.memo || item.MEMO || null,
          });
          totalDeposits += amount;
        }
      }
    }

    const balanceOutstanding = hireValueIncVat - totalDeposits;

    // Get OP excess data for this job
    const excessResult = await query(
      `SELECT je.*, d.full_name AS driver_name, fv.reg AS vehicle_reg
       FROM job_excess je
       LEFT JOIN vehicle_hire_assignments vha ON vha.id = je.assignment_id
       LEFT JOIN drivers d ON d.id = vha.driver_id
       LEFT JOIN fleet_vehicles fv ON fv.id = vha.vehicle_id
       WHERE je.job_id = $1`,
      [job.id]
    );

    const excessRecords = excessResult.rows;
    const excessRequired = excessRecords.reduce(
      (sum: number, r: any) => sum + parseFloat(r.excess_amount_required || 0), 0
    );
    const excessCollected = excessRecords.reduce(
      (sum: number, r: any) => sum + parseFloat(r.excess_amount_taken || 0), 0
    );
    const excessStatus = excessRecords.length > 0
      ? excessRecords.some((r: any) => r.excess_status === 'pending') ? 'pending'
        : excessRecords.every((r: any) => ['taken', 'waived', 'not_required'].includes(r.excess_status)) ? 'collected'
        : excessRecords[0].excess_status
      : null;

    // Get OP-recorded payments
    const paymentsResult = await query(
      `SELECT * FROM job_payments WHERE job_id = $1 ORDER BY payment_date DESC`,
      [job.id]
    );

    // Check client balance on account
    let clientBalance = 0;
    if (job.client_id) {
      const balanceResult = await query(
        `SELECT COALESCE(SUM(excess_amount_taken), 0) - COALESCE(SUM(claim_amount), 0) - COALESCE(SUM(reimbursement_amount), 0) AS balance
         FROM job_excess je
         JOIN vehicle_hire_assignments vha ON vha.id = je.assignment_id
         LEFT JOIN jobs j ON j.id = je.job_id
         WHERE j.client_id = $1
           AND je.excess_status IN ('taken', 'rolled_over')
           AND je.job_id != $2`,
        [job.client_id, job.id]
      );
      clientBalance = parseFloat(balanceResult.rows[0]?.balance || '0');
    }

    res.json({
      data: {
        job: {
          id: job.id,
          hh_job_number: hhJobId,
          client_name: job.client_name || job.company_name,
        },
        financial: {
          hire_value_ex_vat: hireValueExVat,
          hire_value_inc_vat: hireValueIncVat,
          vat_amount: vatAmount,
          total_deposits: totalDeposits,
          balance_outstanding: balanceOutstanding,
          deposits,
        },
        excess: {
          records: excessRecords,
          total_required: excessRequired,
          total_collected: excessCollected,
          status: excessStatus,
        },
        payments: paymentsResult.rows,
        client_balance_on_account: clientBalance,
      },
    });
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : String(error);
    console.error('[money] Summary error:', errMsg, error);
    res.status(500).json({ error: 'Failed to load financial summary', detail: errMsg });
  }
});

// ── GET /api/money/:jobId/payments — Payment history for a job ──

router.get('/:jobId/payments', async (req: AuthRequest, res: Response) => {
  try {
    const { jobId } = req.params;

    const result = await query(
      `SELECT jp.*, u.name AS recorded_by_name
       FROM job_payments jp
       LEFT JOIN users u ON u.id = jp.recorded_by
       WHERE jp.job_id = $1
       ORDER BY jp.payment_date DESC`,
      [jobId]
    );

    res.json({ data: result.rows });
  } catch (error) {
    console.error('[money] Payments error:', error);
    res.status(500).json({ error: 'Failed to load payments' });
  }
});

// ── POST /api/money/:jobId/record-payment — Record a payment ──
// Creates in OP job_payments table. Optionally pushes to HireHop as a deposit.

router.post('/:jobId/record-payment', validate(recordPaymentSchema), async (req: AuthRequest, res: Response) => {
  try {
    const { jobId } = req.params;
    const { payment_type, amount, payment_method, payment_reference, notes, excess_id, push_to_hirehop } = req.body;

    // Look up the job
    const jobResult = await query(
      `SELECT id, hh_job_number, client_name, company_name FROM jobs WHERE id = $1`,
      [jobId]
    );

    if (jobResult.rows.length === 0) {
      res.status(404).json({ error: 'Job not found' });
      return;
    }

    const job = jobResult.rows[0];

    // Record in OP
    const paymentResult = await query(
      `INSERT INTO job_payments
        (job_id, hirehop_job_id, payment_type, amount, payment_method,
         payment_reference, payment_status, source, excess_id,
         client_name, recorded_by, notes, payment_date)
       VALUES ($1, $2, $3, $4, $5, $6, 'completed', 'op', $7, $8, $9, $10, NOW())
       RETURNING *`,
      [
        job.id,
        job.hh_job_number,
        payment_type,
        amount,
        payment_method,
        payment_reference || null,
        excess_id || null,
        job.client_name || job.company_name,
        req.user!.id,
        notes || null,
      ]
    );

    const payment = paymentResult.rows[0];

    // If this is an excess payment, update the excess record too
    if (payment_type === 'excess' && excess_id) {
      await query(
        `UPDATE job_excess SET
          excess_amount_taken = COALESCE(excess_amount_taken, 0) + $1,
          excess_status = CASE
            WHEN COALESCE(excess_amount_taken, 0) + $1 >= COALESCE(excess_amount_required, 0) THEN 'taken'
            ELSE 'partial'
          END,
          payment_method = $2,
          payment_reference = $3,
          payment_date = NOW(),
          updated_at = NOW()
        WHERE id = $4`,
        [amount, payment_method, payment_reference || null, excess_id]
      );
    }

    // Push to HireHop as deposit (if requested and job has HH number)
    // Uses the two-step process: 1) Create deposit, 2) Trigger Xero sync
    let hhDepositId: number | null = null;
    let xeroSynced = false;
    if (push_to_hirehop && job.hh_job_number && payment_type !== 'refund') {
      try {
        // Get CLIENT_ID from HireHop job data for the deposit
        let hhClientId: number | null = null;
        try {
          const jobDataRes = await hhBroker.get<Record<string, any>>('/api/job_data.php', { job: job.hh_job_number }, { priority: 'high', cacheTTL: 60 });
          if (jobDataRes.success && jobDataRes.data) {
            hhClientId = jobDataRes.data.CLIENT_ID || jobDataRes.data.client_id || null;
          }
        } catch { /* non-fatal */ }

        const currentDate = new Date().toISOString().split('T')[0];
        const description = `${job.hh_job_number} - ${payment_type}`;
        const memo = buildHHDepositMemo(payment_type, payment_method, payment_reference, notes);

        // STEP 1: Create the deposit with full HireHop params
        const depositParams: Record<string, unknown> = {
          ID: 0, // 0 = create new
          DATE: currentDate,
          DESCRIPTION: description,
          AMOUNT: amount,
          MEMO: memo,
          ACC_ACCOUNT_ID: 267, // Bank account ID (card payments account)
          ACC_PACKAGE_ID: 3,   // 3 = Xero integration
          'CURRENCY[CODE]': 'GBP',
          'CURRENCY[NAME]': 'United Kingdom Pound',
          'CURRENCY[SYMBOL]': '£',
          'CURRENCY[DECIMALS]': 2,
          'CURRENCY[MULTIPLIER]': 1,
          'CURRENCY[NEGATIVE_FORMAT]': 1,
          'CURRENCY[SYMBOL_POSITION]': 0,
          'CURRENCY[DECIMAL_SEPARATOR]': '.',
          'CURRENCY[THOUSAND_SEPARATOR]': ',',
          JOB_ID: job.hh_job_number,
          CLIENT_ID: hhClientId || '',
          local: new Date().toISOString().replace('T', ' ').substring(0, 19),
          tz: 'Europe/London',
          no_webhook: 1,
        };

        console.log('[money] Creating HH deposit for job', job.hh_job_number, '£' + amount);
        const hhResult = await hhBroker.post('/php_functions/billing_deposit_save.php', depositParams, { priority: 'high' });

        if (hhResult.success && hhResult.data) {
          hhDepositId = (hhResult.data as any).hh_id || (hhResult.data as any).id || (hhResult.data as any).ID || null;
          console.log('[money] HH deposit created:', hhDepositId);

          // Update OP record with HH deposit ID
          if (hhDepositId) {
            await query(
              `UPDATE job_payments SET hirehop_deposit_id = $1 WHERE id = $2`,
              [hhDepositId, payment.id]
            );

            // STEP 2: Trigger Xero sync
            try {
              const syncResult = await hhBroker.post('/php_functions/accounting/tasks.php', {
                hh_package_type: 1,
                hh_acc_package_id: 3,  // Xero
                hh_task: 'post_deposit',
                hh_id: hhDepositId,
                hh_acc_id: '',
              }, { priority: 'high' });

              xeroSynced = syncResult.success;
              console.log('[money] Xero sync triggered:', xeroSynced ? 'success' : 'failed');
            } catch (syncError) {
              console.error('[money] Xero sync trigger failed (non-fatal):', syncError);
            }
          }
        } else {
          console.error('[money] HH deposit creation failed:', hhResult.error, hhResult.data);
        }
      } catch (hhError) {
        console.error('[money] HH deposit write-back failed (non-fatal):', hhError);
      }
    }

    res.json({
      data: {
        ...payment,
        hirehop_deposit_id: hhDepositId,
        xero_synced: xeroSynced,
      },
    });
  } catch (error) {
    console.error('[money] Record payment error:', error);
    res.status(500).json({ error: 'Failed to record payment' });
  }
});

// ── POST /api/money/:jobId/payment-event — Receive payment event from external system ──
// Called by Payment Portal (or Stripe webhook) when a payment is processed externally.

router.post('/:jobId/payment-event', async (req: AuthRequest, res: Response) => {
  try {
    const { jobId } = req.params;
    const { payment_type, amount, payment_method, payment_reference, stripe_payment_intent, source, excess_id, notes } = req.body;

    const jobResult = await query(
      `SELECT id, hh_job_number, client_name FROM jobs WHERE id = $1`,
      [jobId]
    );

    if (jobResult.rows.length === 0) {
      res.status(404).json({ error: 'Job not found' });
      return;
    }

    const job = jobResult.rows[0];

    const result = await query(
      `INSERT INTO job_payments
        (job_id, hirehop_job_id, payment_type, amount, payment_method,
         payment_reference, stripe_payment_intent, payment_status, source,
         excess_id, client_name, notes, payment_date)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'completed', $8, $9, $10, $11, NOW())
       RETURNING *`,
      [
        job.id,
        job.hh_job_number,
        payment_type || 'deposit',
        amount,
        payment_method || 'stripe',
        payment_reference || null,
        stripe_payment_intent || null,
        source || 'payment_portal',
        excess_id || null,
        job.client_name,
        notes || null,
      ]
    );

    // Update excess if this is an excess payment
    if ((payment_type === 'excess') && excess_id) {
      await query(
        `UPDATE job_excess SET
          excess_amount_taken = COALESCE(excess_amount_taken, 0) + $1,
          excess_status = CASE
            WHEN COALESCE(excess_amount_taken, 0) + $1 >= COALESCE(excess_amount_required, 0) THEN 'taken'
            ELSE 'partial'
          END,
          payment_method = $2,
          payment_reference = $3,
          payment_date = NOW(),
          updated_at = NOW()
        WHERE id = $4`,
        [amount, payment_method, payment_reference || null, excess_id]
      );
    }

    res.json({ data: result.rows[0] });
  } catch (error) {
    console.error('[money] Payment event error:', error);
    res.status(500).json({ error: 'Failed to record payment event' });
  }
});

// ── Helper ──

function buildHHDepositMemo(
  paymentType: string,
  paymentMethod: string,
  reference?: string | null,
  notes?: string | null,
): string {
  const parts: string[] = [];
  const typeLabel: Record<string, string> = {
    deposit: 'Deposit',
    balance: 'Balance payment',
    excess: 'Insurance excess',
    other: 'Payment',
  };
  parts.push(typeLabel[paymentType] || 'Payment');
  parts.push(`via ${paymentMethod.replace(/_/g, ' ')}`);
  if (reference) parts.push(`Ref: ${reference}`);
  if (notes) parts.push(notes);
  parts.push('(recorded via Ooosh OP)');
  return parts.join(' — ');
}

export default router;
