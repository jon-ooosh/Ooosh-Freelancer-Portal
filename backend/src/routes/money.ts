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
import { sendPaymentEmail, sendExcessEmail, sendLastMinuteAlert } from '../services/money-emails';
import { calculateVatAdjustment } from '../services/vat-adjustment';

const router = Router();
router.use(authenticate);

// ── HireHop bank account labels (for emails) ──
const PAYMENT_METHODS_LABELS: Record<string, string> = {
  stripe_gbp: 'Stripe GBP',
  worldpay: 'Worldpay',
  amex: 'Amex',
  wise_bacs: 'bank transfer',
  till_cash: 'cash',
  paypal: 'PayPal',
  lloyds_bank: 'bank transfer',
  rolled_over: 'account balance',
};

// ── Schemas ──

const recordPaymentSchema = z.object({
  payment_type: z.enum(['deposit', 'balance', 'excess', 'refund', 'excess_refund', 'other']),
  amount: z.number().min(0.01),
  payment_method: z.enum([
    'stripe_gbp', 'worldpay', 'amex', 'wise_bacs', 'till_cash', 'paypal', 'lloyds_bank', 'rolled_over',
  ]),
  payment_reference: z.string().max(255).optional(),
  notes: z.string().max(1000).optional(),
  excess_id: z.string().uuid().optional(),
  push_to_hirehop: z.boolean().default(true),
});

// ── POST /api/money/sync-values — Bulk-update job_value for jobs missing values ──
// Called on jobs/pipeline page load to populate cached hire values from HH billing

router.post('/sync-values', async (req: AuthRequest, res: Response) => {
  try {
    // Find HH-linked jobs with no job_value (or job_value = 0)
    const jobsResult = await query(
      `SELECT id, hh_job_number FROM jobs
       WHERE hh_job_number IS NOT NULL
         AND (job_value IS NULL OR job_value = 0)
         AND status NOT IN (9, 10, 11)
       ORDER BY updated_at DESC
       LIMIT 20`
    );

    if (jobsResult.rows.length === 0) {
      res.json({ data: { updated: 0 } });
      return;
    }

    let updated = 0;
    // Process sequentially to avoid rate limiting (billing_list is per-job)
    for (const job of jobsResult.rows) {
      try {
        const billingRes = await hhBroker.get('/php_functions/billing_list.php',
          { main_id: job.hh_job_number, type: 1 },
          { priority: 'low', cacheTTL: 300 }
        );

        if (billingRes.success && billingRes.data) {
          const bl = billingRes.data as Record<string, any>;
          if (bl.rows && Array.isArray(bl.rows)) {
            for (const row of bl.rows) {
              if (parseInt(row.kind ?? '0') === 0) {
                const accrued = parseFloat(row.accrued || row.data?.accrued || '0');
                if (accrued > 0) {
                  await query(`UPDATE jobs SET job_value = $1 WHERE id = $2`, [accrued, job.id]);
                  updated++;
                }
                break;
              }
            }
          }
        }
      } catch { /* skip individual failures */ }
    }

    res.json({ data: { updated, checked: jobsResult.rows.length } });
  } catch (error) {
    console.error('[money] Sync values error:', error);
    res.status(500).json({ error: 'Failed to sync job values' });
  }
});

// ── GET /api/money/:jobId/vat-adjustment — International VAT adjustment calculation ──

router.get('/:jobId/vat-adjustment', async (req: AuthRequest, res: Response) => {
  try {
    const { jobId } = req.params;

    const jobResult = await query(
      `SELECT id, hh_job_number, job_date, job_end, out_date, return_date FROM jobs WHERE id = $1`,
      [jobId]
    );

    if (jobResult.rows.length === 0) {
      res.status(404).json({ error: 'Job not found' });
      return;
    }

    const job = jobResult.rows[0];
    if (!job.hh_job_number) {
      res.json({ data: null }); // No HH link, no VAT adjustment possible
      return;
    }

    // Calculate hire days from job dates
    const startDate = job.job_date || job.out_date;
    const endDate = job.job_end || job.return_date;
    let hireDays = 1;
    if (startDate && endDate) {
      hireDays = Math.max(1, Math.ceil(
        (new Date(endDate).getTime() - new Date(startDate).getTime()) / (1000 * 60 * 60 * 24)
      ));
    }

    const result = await calculateVatAdjustment(job.hh_job_number, hireDays);
    res.json({ data: result });
  } catch (error) {
    console.error('[money] VAT adjustment error:', error);
    res.status(500).json({ error: 'Failed to calculate VAT adjustment' });
  }
});

// ── GET /api/money/:jobId/summary — Full financial summary for a job ──

router.get('/:jobId/summary', async (req: AuthRequest, res: Response) => {
  try {
    const { jobId } = req.params;

    // Get the job from OP database (need hh_job_number for HH API calls)
    const jobResult = await query(
      `SELECT id, hh_job_number, client_id, client_name, company_name, job_date, job_end, out_date, return_date
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
          // billing_list.php needs main_id and type=1 for job billing
          hhBroker.get('/php_functions/billing_list.php', { main_id: hhJobId, type: 1 }, { priority: 'high', cacheTTL: 60 }),
          hhBroker.get('/api/job_data.php', { job: hhJobId }, { priority: 'high', cacheTTL: 60 }),
        ]);
        if (billingRes.success) hhBilling = billingRes.data;
        if (jobDataRes.success) hhJobData = jobDataRes.data;
      } catch (hhError) {
        console.error('[money] HireHop fetch failed (non-fatal):', hhError);
      }
    }

    // Parse HireHop financial data from billing_list.php
    // Returns { rows, subs, banks, page, total, records }
    // Row kinds: 0=Job total (accrued), 1=Invoice, 2=Credit note, 3=Payment application, 6=Deposit
    const bl = hhBilling as Record<string, any> | null;

    let hireValueExVat = 0;
    const deposits: Array<{
      id: number; amount: number; date: string; description: string | null;
      memo: string | null; is_excess: boolean; is_refund: boolean;
      bank_name: string | null; entered_by: string | null;
    }> = [];
    let totalHireDeposits = 0;
    let totalExcessDeposits = 0;

    // Extract banks array for resolving bank IDs to names
    const banks: Array<{ ID: number; NAME: string }> = bl?.banks || bl?.rows?.[0]?.data?.banks || [];
    function getBankName(accAccountId: number | null): string | null {
      if (!accAccountId) return null;
      const bank = banks.find(b => b.ID === accAccountId);
      return bank?.NAME || null;
    }

    if (bl?.rows && Array.isArray(bl.rows)) {
      for (const row of bl.rows) {
        const kind = parseInt(row.kind ?? '0');
        const data = row.data || {};

        if (kind === 0) {
          // Job total row — accrued field has the ex-VAT hire value
          hireValueExVat = parseFloat(row.accrued || data.accrued || data.ACCRUED || '0');
        } else if (kind === 6) {
          // Deposit row — credit at row level, details in data
          const creditAmount = parseFloat(row.credit || data.credit || '0');
          const description = String(data.DESCRIPTION || row.desc || '');
          const memo = String(data.MEMO || '');
          const isExcess = isExcessPayment(description + ' ' + memo);
          const depositId = parseInt(data.ID || row.number || String(row.id).replace('e', '') || '0');
          const isRefund = creditAmount < 0;
          const absAmount = Math.abs(creditAmount);

          if (absAmount > 0) {
            // Only add hire deposits to the Payment History display
            // Excess deposits are shown in the Insurance Excess section instead (from OP job_excess records)
            if (!isExcess) {
              deposits.push({
                id: depositId,
                amount: absAmount,
                date: data.DATE || row.date || '',
                description: description || null,
                memo: memo || null,
                is_excess: false,
                is_refund: isRefund,
                bank_name: getBankName(data.ACC_ACCOUNT_ID),
                entered_by: data.CREATE_USER_NAME || null,
              });
            }

            // But still count ALL deposits in financial totals
            if (!isRefund) {
              if (isExcess) { totalExcessDeposits += absAmount; }
              else { totalHireDeposits += absAmount; }
            } else {
              if (isExcess) { totalExcessDeposits -= absAmount; }
              else { totalHireDeposits -= absAmount; }
            }
          }
        } else if (kind === 3) {
          // Payment application (refund against a specific deposit)
          const creditAmount = parseFloat(row.credit || data.credit || '0');
          const description = String(data.DESCRIPTION || row.desc || '');
          const memo = String(data.MEMO || '');
          const isExcess = isExcessPayment(description + ' ' + memo);
          const appId = parseInt(data.ID || row.number || String(row.id).replace('e', '') || '0');
          const absAmount = Math.abs(creditAmount);

          // Only show payment applications with a description (skip auto-applications)
          if (absAmount > 0 && description) {
            if (!isExcess) {
              deposits.push({
                id: appId,
                amount: absAmount,
                date: data.DATE || row.date || '',
                description: description || null,
                memo: memo || null,
                is_excess: false,
                is_refund: true, // Payment applications are refunds
                bank_name: getBankName(data.ACC_ACCOUNT_ID),
                entered_by: data.CREATE_USER_NAME || null,
              });
            }

            // Count refunds in totals
            if (isExcess) { totalExcessDeposits -= absAmount; }
            else { totalHireDeposits -= absAmount; }
          }
        } else if (kind === 2) {
          // Credit note — negative debit, classified same as deposits
          const creditAmount = -(parseFloat(row.debit || data.debit || '0'));
          const description = String(data.DESCRIPTION || row.desc || '');
          const isExcess = isExcessPayment(description);

          if (Math.abs(creditAmount) > 0) {
            if (isExcess) { totalExcessDeposits += creditAmount; }
            else { totalHireDeposits += creditAmount; }
          }
        }
      }
    }

    const vatRate = 0.20;
    const vatAmount = hireValueExVat * vatRate;
    const hireValueIncVat = hireValueExVat + vatAmount;
    const totalDeposits = totalHireDeposits + totalExcessDeposits;
    // Balance = hire value inc VAT minus hire deposits only (excess deposits are separate)
    const balanceOutstanding = hireValueIncVat - totalHireDeposits;

    // Side-effect: update cached job_value on jobs table so pipeline/jobs pages show correct value
    if (hireValueExVat > 0 && job.id) {
      query(
        `UPDATE jobs SET job_value = $1 WHERE id = $2 AND (job_value IS NULL OR job_value != $1)`,
        [hireValueExVat, job.id]
      ).catch(() => {}); // Fire-and-forget, non-blocking
    }

    // Get OP excess data for this job
    const excessResult = await query(
      `SELECT je.*, d.full_name AS driver_name, fv.reg AS vehicle_reg,
              COALESCE(d.full_name, je.client_name, 'Job-level excess') AS display_name
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
      ? excessRecords.some((r: any) => r.excess_status === 'needed') ? 'needed'
        : excessRecords.every((r: any) => ['taken', 'waived', 'not_required', 'pre_auth', 'reimbursed', 'partially_reimbursed', 'fully_claimed', 'rolled_over'].includes(r.excess_status)) ? 'collected'
        : excessRecords[0].excess_status
      : null;

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

    // Check for international VAT adjustment
    let vatAdjustment: any = null;
    if (hhJobId && hireValueExVat > 0) {
      try {
        const startDate = job.job_date || job.out_date;
        const endDate = job.job_end || job.return_date;
        let hireDays = 1;
        if (startDate && endDate) {
          hireDays = Math.max(1, Math.ceil(
            (new Date(endDate).getTime() - new Date(startDate).getTime()) / (1000 * 60 * 60 * 24)
          ));
        }
        vatAdjustment = await calculateVatAdjustment(hhJobId, hireDays);
      } catch { /* non-fatal */ }
    }

    // If VAT adjustment applies, override the VAT figures
    const effectiveVatAmount = vatAdjustment ? vatAdjustment.adjustedVat : vatAmount;
    const effectiveHireValueIncVat = hireValueExVat + effectiveVatAmount;
    const effectiveBalanceOutstanding = effectiveHireValueIncVat - totalHireDeposits;

    // Calculate deposit requirements using effective (VAT-adjusted) total
    let requiredDeposit = Math.max(effectiveHireValueIncVat * 0.25, 100);
    if (effectiveHireValueIncVat < 400) requiredDeposit = effectiveHireValueIncVat;
    if (effectiveHireValueIncVat === 0) requiredDeposit = 0;
    const depositPaid = totalHireDeposits >= (requiredDeposit - 5); // £5 tolerance
    const depositPercent = effectiveHireValueIncVat > 0 ? Math.min(100, (totalHireDeposits / effectiveHireValueIncVat) * 100) : 0;

    res.json({
      data: {
        job: {
          id: job.id,
          hh_job_number: hhJobId,
          client_name: job.client_name || job.company_name,
        },
        financial: {
          hire_value_ex_vat: hireValueExVat,
          hire_value_inc_vat: effectiveHireValueIncVat,
          vat_amount: effectiveVatAmount,
          original_vat_amount: vatAdjustment ? vatAmount : undefined,
          original_hire_value_inc_vat: vatAdjustment ? hireValueIncVat : undefined,
          vat_adjusted: !!vatAdjustment,
          vat_saved: vatAdjustment ? vatAdjustment.vatSaved : 0,
          total_deposits: totalDeposits,
          total_hire_deposits: totalHireDeposits,
          total_excess_deposits: totalExcessDeposits,
          balance_outstanding: effectiveBalanceOutstanding,
          required_deposit: requiredDeposit,
          deposit_paid: depositPaid,
          deposit_percent: depositPercent,
          deposits,
        },
        excess: {
          records: excessRecords,
          total_required: excessRequired,
          total_collected: excessCollected,
          status: excessStatus,
        },
        vat_adjustment: vatAdjustment,
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
            ELSE 'partially_paid'
          END,
          payment_method = $2,
          payment_reference = $3,
          payment_date = NOW(),
          updated_at = NOW()
        WHERE id = $4`,
        [amount, payment_method, payment_reference || null, excess_id]
      );
    }

    // Status transition: deposit payment on enquiry/provisional → Booked
    // A deposit (or full payment) means the job is confirmed
    if ((payment_type === 'deposit' || payment_type === 'balance') && amount > 0) {
      try {
        const statusResult = await query(
          `SELECT pipeline_status, hh_job_number FROM jobs WHERE id = $1`,
          [job.id]
        );
        const currentStatus = statusResult.rows[0]?.pipeline_status;
        const hhNum = statusResult.rows[0]?.hh_job_number;

        if (currentStatus && ['new_enquiry', 'quoting', 'chasing', 'provisional'].includes(currentStatus)) {
          // Move to confirmed in OP
          await query(
            `UPDATE jobs SET pipeline_status = 'confirmed', pipeline_status_changed_at = NOW(), updated_at = NOW() WHERE id = $1`,
            [job.id]
          );
          console.log(`[money] Job ${job.id} moved to confirmed (deposit received)`);

          // Push status to HireHop (status 2 = Booked)
          if (hhNum) {
            try {
              await hhBroker.post('/frames/status_save.php', {
                job: hhNum,
                status: 2, // Booked
                no_webhook: 1,
              }, { priority: 'high' });
              // Update local HH status
              await query(
                `UPDATE jobs SET status = 2, status_name = 'Booked', hh_status = 2 WHERE id = $1`,
                [job.id]
              );
              console.log(`[money] HH job ${hhNum} status updated to Booked`);
            } catch {
              console.error('[money] HH status update to Booked failed (non-fatal)');
            }
          }
        }
      } catch (err) {
        console.error('[money] Status transition failed (non-fatal):', err);
      }
    }

    // Push to HireHop as deposit (if requested and job has HH number)
    // Uses the two-step process: 1) Create deposit, 2) Trigger Xero sync
    let hhDepositId: number | null = null;
    let xeroSynced = false;
    if (push_to_hirehop && job.hh_job_number && payment_type !== 'refund' && payment_method !== 'rolled_over') {
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
        const formattedDate = new Date().toLocaleDateString('en-GB', { day: '2-digit', month: '2-digit', year: 'numeric' });
        const methodLabel = PAYMENT_METHODS_LABELS[payment_method] || payment_method.replace(/_/g, ' ');
        const typeLabel = payment_type === 'excess' ? 'excess' : payment_type === 'deposit' ? 'deposit' : payment_type;
        const description = `${job.hh_job_number} - ${typeLabel}`;
        const memo = `${typeLabel.charAt(0).toUpperCase() + typeLabel.slice(1)} ${formattedDate} via ${methodLabel}${payment_reference ? ` (Ref: ${payment_reference})` : ''}${notes ? ` — ${notes}` : ''} (recorded via Ooosh OP)`;

        // STEP 1: Create the deposit with full HireHop params
        const hhBankId = getHHBankId(payment_method);
        const depositParams: Record<string, unknown> = {
          ID: 0, // 0 = create new
          DATE: currentDate,
          DESCRIPTION: description,
          AMOUNT: amount,
          MEMO: memo,
          ACC_ACCOUNT_ID: hhBankId,
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

    // ── Email triggers (fire-and-forget) ──
    try {
      const bankLabel = PAYMENT_METHODS_LABELS[payment_method] || payment_method;

      if (payment_type === 'excess') {
        // Excess payment email — only if linked to an excess record
        if (excess_id) {
          sendExcessEmail({
            templateId: 'excess_payment_confirmed',
            excessId: excess_id,
            jobId: job.id,
            amount,
            paymentMethod: payment_method,
          }).catch(e => console.error('[money] Excess email failed:', e));
        }
        // Excess payments never trigger booking confirmation or last-minute alerts
      } else {
        // Hire payment email
        const currentStatus = (await query(`SELECT pipeline_status FROM jobs WHERE id = $1`, [job.id])).rows[0]?.pipeline_status;
        const isConfirming = currentStatus === 'confirmed';

        sendPaymentEmail({
          jobId: job.id,
          amount,
          bankName: bankLabel,
          paymentType: payment_type,
          isConfirmingBooking: isConfirming,
        }).catch(e => console.error('[money] Payment email failed:', e));

        // Last-minute alert if job starts within 3 days
        if (isConfirming) {
          sendLastMinuteAlert(job.id).catch(e => console.error('[money] Last-minute alert failed:', e));
        }
      }
    } catch (emailErr) {
      console.error('[money] Email trigger error (non-fatal):', emailErr);
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
            ELSE 'partially_paid'
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

/**
 * Map OP payment method to HireHop bank account ID.
 * These IDs correspond to the bank accounts configured in HireHop:
 *   165 = Amex
 *   168 = Till (Cash)
 *   169 = Worldpay (all cards EXCEPT AMEX) — default for card in office
 *   170 = Lloyds Bank
 *   173 = Paypal
 *   265 = Wise - Current Account (BACS) — bank transfers
 *   267 = Stripe GBP — online card payments via Payment Portal
 */
function getHHBankId(paymentMethod: string): number {
  const mapping: Record<string, number> = {
    stripe_gbp: 267,       // Stripe GBP
    worldpay: 169,         // Worldpay (all cards EXCEPT AMEX)
    amex: 165,             // Amex
    wise_bacs: 265,        // Wise - Current Account (BACS)
    till_cash: 168,        // Till (Cash)
    paypal: 173,           // Paypal
    lloyds_bank: 170,      // Lloyds Bank
    rolled_over: 265,      // Default to Wise for rollovers
  };
  return mapping[paymentMethod] || 169; // Default to Worldpay
}

/**
 * Detect if a deposit description/memo indicates an excess payment.
 * Matches the same keywords as the Payment Portal's isExcessPayment().
 */
function isExcessPayment(text: string): boolean {
  const lower = text.toLowerCase();
  return /excess|insurance|xs|top.?up/.test(lower);
}

export default router;
