/**
 * Money Routes — Unified financial view per job.
 *
 * Reads from HireHop (hire value, deposits, billing) via the broker,
 * combines with OP data (excess, job_payments), and provides a single
 * financial picture for the Money tab on Job Detail.
 *
 * Also handles recording payments (pushes to HH as deposits).
 */
import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { query } from '../config/database';
import { authenticate, authorize, AuthRequest } from '../middleware/auth';
import { validate } from '../middleware/validate';
import { hhBroker } from '../services/hirehop-broker';
import { sendPaymentEmail, sendExcessEmail, sendLastMinuteAlert } from '../services/money-emails';
import { calculateVatAdjustment } from '../services/vat-adjustment';

const router = Router();

/**
 * Flexible auth: accepts either JWT Bearer token OR X-API-Key header.
 * JWT auth populates req.user as normal. API key auth verifies against
 * api_keys table and sets req.user to a minimal service user object.
 */
async function authenticateFlexible(req: Request, res: Response, next: NextFunction) {
  const apiKey = req.headers['x-api-key'] as string | undefined;

  if (apiKey) {
    // API key auth — for Payment Portal and external services
    try {
      const keyPrefix = apiKey.substring(0, 8);
      const keyResult = await query(
        `SELECT id, name, service, permissions FROM api_keys WHERE key_prefix = $1 AND is_active = true`,
        [keyPrefix]
      );
      if (keyResult.rows.length === 0) {
        res.status(403).json({ error: 'Invalid API key' });
        return;
      }
      // Update last_used_at (fire and forget)
      query(`UPDATE api_keys SET last_used_at = NOW() WHERE id = $1`, [keyResult.rows[0].id]).catch(() => {});
      // Set a minimal service user so downstream code works
      (req as any).user = { id: keyResult.rows[0].id, role: 'service', name: keyResult.rows[0].service };
      next();
    } catch (err) {
      res.status(500).json({ error: 'API key verification failed' });
    }
    return;
  }

  // Fall back to JWT auth
  authenticate(req as AuthRequest, res, next);
}

// Apply flexible auth to all money routes
router.use(authenticateFlexible as any);

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

// ── GET /api/money/job-lookup/:hhJobNumber — Look up OP job by HireHop job number ──
// Used by Payment Portal to resolve HH job numbers to OP UUIDs for subsequent API calls.
// Returns core job details needed by the portal.

router.get('/job-lookup/:hhJobNumber', async (req: AuthRequest, res: Response) => {
  try {
    const hhJobNumber = parseInt(req.params.hhJobNumber as string);
    if (isNaN(hhJobNumber)) {
      res.status(400).json({ error: 'Invalid HireHop job number' });
      return;
    }

    const result = await query(
      `SELECT id, hh_job_number, job_name, client_name, company_name,
              pipeline_status, status, status_name,
              job_date, job_end, out_date, return_date
       FROM jobs WHERE hh_job_number = $1`,
      [hhJobNumber]
    );

    if (result.rows.length === 0) {
      res.status(404).json({ error: 'Job not found' });
      return;
    }

    res.json({ data: result.rows[0] });
  } catch (error) {
    console.error('[money] Job lookup error:', error);
    res.status(500).json({ error: 'Job lookup failed' });
  }
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

// ── GET /api/money/:jobId/excess-info — Excess details for Payment Portal ──
// Replaces monday-driver-excess.js — provides per-driver excess breakdown,
// van count, total required, pre-auth eligibility, and payment status.
// Callable with API key auth (for portal) or JWT auth (for OP staff).

router.get('/:jobId/excess-info', async (req: AuthRequest, res: Response) => {
  try {
    const { jobId } = req.params;
    const jobIdStr = Array.isArray(jobId) ? jobId[0]! : jobId;

    // Look up job (accept UUID or HH job number)
    const isUuid = /^[0-9a-f]{8}-/.test(jobIdStr);
    const jobResult = await query(
      isUuid
        ? `SELECT id, hh_job_number, job_name, job_date, job_end, out_date, return_date, duration_days FROM jobs WHERE id = $1`
        : `SELECT id, hh_job_number, job_name, job_date, job_end, out_date, return_date, duration_days FROM jobs WHERE hh_job_number = $1`,
      [isUuid ? jobIdStr : parseInt(jobIdStr)]
    );

    if (jobResult.rows.length === 0) {
      res.status(404).json({ error: 'Job not found' });
      return;
    }

    const job = jobResult.rows[0];

    // Calculate hire duration
    const startDate = job.job_date || job.out_date;
    const endDate = job.job_end || job.return_date;
    let hireDays = job.duration_days || 1;
    if (startDate && endDate) {
      hireDays = Math.max(1, Math.ceil(
        (new Date(endDate).getTime() - new Date(startDate).getTime()) / (1000 * 60 * 60 * 24)
      ));
    }

    // Pre-auth eligibility: hire ≤ 4 days AND hire end within 5 days from now
    const hireEndDate = endDate ? new Date(endDate) : null;
    const daysUntilEnd = hireEndDate
      ? Math.ceil((hireEndDate.getTime() - Date.now()) / (1000 * 60 * 60 * 24))
      : null;
    let preAuthMethod: 'pre-auth' | 'payment' | 'too_early' = 'payment';
    if (hireDays <= 4) {
      if (daysUntilEnd !== null && daysUntilEnd <= 5) {
        preAuthMethod = 'pre-auth';
      } else {
        preAuthMethod = 'too_early';
      }
    }

    // Get per-driver excess records with vehicle and driver info
    const excessResult = await query(
      `SELECT je.id AS excess_id, je.excess_amount_required, je.excess_amount_taken,
              je.excess_status, je.excess_calculation_basis, je.payment_method,
              je.payment_reference, je.payment_date, je.hh_deposit_id,
              je.suggested_collection_method, je.client_name,
              d.id AS driver_id, d.full_name AS driver_name,
              d.licence_points, d.requires_referral,
              fv.id AS vehicle_id, fv.reg AS vehicle_reg, fv.simple_type AS vehicle_type,
              vha.assignment_type, vha.status AS assignment_status
       FROM job_excess je
       LEFT JOIN vehicle_hire_assignments vha ON vha.id = je.assignment_id
       LEFT JOIN fleet_vehicles fv ON fv.id = vha.vehicle_id
       LEFT JOIN drivers d ON d.id = vha.driver_id
       WHERE je.job_id = $1
         AND je.excess_status != 'not_required'
       ORDER BY je.excess_amount_required DESC NULLS LAST`,
      [job.id]
    );

    // Count self-drive vehicles (van count)
    const vanCountResult = await query(
      `SELECT COUNT(DISTINCT vehicle_id) AS van_count
       FROM vehicle_hire_assignments
       WHERE job_id = $1
         AND assignment_type = 'self_drive'
         AND status != 'cancelled'`,
      [job.id]
    );
    const vanCount = parseInt(vanCountResult.rows[0]?.van_count || '0');

    // Build per-driver breakdown
    const drivers = excessResult.rows.map((r: any) => {
      const required = parseFloat(r.excess_amount_required || 0);
      const taken = parseFloat(r.excess_amount_taken || 0);
      return {
        // Canonical OP fields
        excess_id: r.excess_id,
        id: r.excess_id, // alias for Payment Portal compat
        driver_id: r.driver_id,
        driver_name: r.driver_name,
        vehicle_id: r.vehicle_id,
        vehicle_reg: r.vehicle_reg,
        vehicle_type: r.vehicle_type,
        excess_amount_required: required,
        excess_amount: required, // alias for Payment Portal compat (expects 'excess_amount')
        excess: required, // alias — Payment Portal sorts on `.excess`
        excess_amount_taken: taken,
        excess_outstanding: Math.max(0, required - taken),
        excess_status: r.excess_status,
        excess_calculation_basis: r.excess_calculation_basis,
        payment_method: r.payment_method,
        payment_reference: r.payment_reference,
        payment_date: r.payment_date,
        licence_points: r.licence_points,
        requires_referral: r.requires_referral,
        suggested_collection_method: r.suggested_collection_method,
      };
    });

    // Totals
    const totalRequired = drivers.reduce((sum: number, d: any) => sum + d.excess_amount_required, 0);
    const totalCollected = drivers.reduce((sum: number, d: any) => sum + d.excess_amount_taken, 0);
    const totalOutstanding = Math.max(0, totalRequired - totalCollected);
    const resolvedStatuses = ['taken', 'waived', 'rolled_over', 'not_required', 'reimbursed', 'partially_reimbursed', 'fully_claimed', 'pre_auth'];
    const driversCleared = drivers.filter((d: any) => resolvedStatuses.includes(d.excess_status)).length;
    const driversPending = drivers.filter((d: any) => !resolvedStatuses.includes(d.excess_status)).length;

    res.json({
      data: {
        job_id: job.id,
        hirehop_job_id: job.hh_job_number,
        job_name: job.job_name,
        job_date: job.job_date || job.out_date,
        job_end: job.job_end || job.return_date,
        hire_duration_days: hireDays,
        van_count: vanCount,
        // Pre-auth eligibility
        pre_auth: {
          method: preAuthMethod,  // 'pre-auth' | 'payment' | 'too_early'
          eligible: preAuthMethod === 'pre-auth',
          days_until_end: daysUntilEnd,
          reason: preAuthMethod === 'payment'
            ? `Hire is ${hireDays} days (>4), regular payment required`
            : preAuthMethod === 'too_early'
              ? `Hire is ≤4 days but ends in ${daysUntilEnd} days (>5 days away)`
              : `Hire is ≤4 days and ends within 5 days`,
        },
        // Per-driver breakdown (sorted by excess amount descending)
        drivers,
        // Aggregates
        totals: {
          total_excess_required: totalRequired,
          total_excess_collected: totalCollected,
          total_excess_outstanding: totalOutstanding,
          drivers_total: drivers.length,
          drivers_cleared: driversCleared,
          drivers_pending: driversPending,
          // Standard per-van fallback (£1,200) — used by portal when no driver-specific data
          standard_per_van: 1200,
          standard_total: vanCount * 1200,
        },
      },
    });
  } catch (error) {
    console.error('[money] Excess info error:', error);
    res.status(500).json({ error: 'Failed to load excess info' });
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
    const jobId = req.params.jobId as string;

    // Get the job from OP database (accept UUID or HH job number)
    const isUuid = /^[0-9a-f]{8}-/.test(jobId);
    const jobResult = await query(
      isUuid
        ? `SELECT id, hh_job_number, client_id, client_name, company_name, job_date, job_end, out_date, return_date
           FROM jobs WHERE id = $1`
        : `SELECT id, hh_job_number, client_id, client_name, company_name, job_date, job_end, out_date, return_date
           FROM jobs WHERE hh_job_number = $1`,
      [isUuid ? jobId : parseInt(jobId)]
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
    // Track HH excess deposits separately for reconciliation
    const hhExcessDeposits: Array<{
      hh_deposit_id: number; amount: number; date: string;
      description: string | null; memo: string | null;
      bank_name: string | null;
    }> = [];
    let totalHireDeposits = 0;
    let totalExcessDeposits = 0;
    // Track deposit money applied to invoices via kind=3 (for invoice reconciliation)
    let hireDepositAppliedToInvoices = 0;
    // Collect approved invoices for reconciliation (detect direct invoice payments)
    const approvedInvoices: Array<{ amount: number; owing: number }> = [];

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
            if (!isExcess) {
              // Hire deposit — show in Payment History
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
            } else if (!isRefund) {
              // Excess deposit — collect for reconciliation (skip refunds, they're payment apps)
              hhExcessDeposits.push({
                hh_deposit_id: depositId,
                amount: absAmount,
                date: data.DATE || row.date || '',
                description: description || null,
                memo: memo || null,
                bank_name: getBankName(data.ACC_ACCOUNT_ID),
              });
            }

            // Count ALL deposits in financial totals
            if (!isRefund) {
              if (isExcess) { totalExcessDeposits += absAmount; }
              else { totalHireDeposits += absAmount; }
            } else {
              if (isExcess) { totalExcessDeposits -= absAmount; }
              else { totalHireDeposits -= absAmount; }
            }
          }
        } else if (kind === 1) {
          // Invoice row — collect approved invoices for reconciliation.
          // Approved invoices with owing=0 prove that money was received,
          // even if that money didn't come through a kind=6 deposit.
          const invoiceAmount = parseFloat(row.debit || data.debit || row.accrued || data.accrued || data.ACCRUED || '0');
          const invoiceOwing = parseFloat(row.owing ?? data.owing ?? data.OWING ?? '0');
          const invoiceStatus = parseInt(row.status ?? data.STATUS ?? data.status ?? '0');
          const invoiceDesc = String(data.DESCRIPTION || row.desc || '');
          const isProforma = invoiceStatus === 0 || invoiceDesc.toLowerCase().includes('proforma');

          if (!isProforma && invoiceAmount > 0) {
            approvedInvoices.push({
              amount: invoiceAmount,
              owing: Math.max(invoiceOwing, 0),
            });
          }
        } else if (kind === 3) {
          // Payment application — can be:
          // 1. Deposit applied to invoice (OWNER_DEPOSIT present): already counted in kind=6, no total change
          // 2. Direct invoice payment (no OWNER_DEPOSIT, positive credit): new money, handled by reconciliation
          // 3. Actual refund (negative credit): subtract from totals
          const creditAmount = parseFloat(row.credit || data.credit || '0');
          const description = String(data.DESCRIPTION || row.desc || '');
          const memo = String(data.MEMO || '');
          const isExcess = isExcessPayment(description + ' ' + memo);
          const appId = parseInt(data.ID || row.number || String(row.id).replace('e', '') || '0');
          const absAmount = Math.abs(creditAmount);
          const ownerDepositId = data.OWNER_DEPOSIT;

          if (absAmount > 0) {
            if (ownerDepositId) {
              // Deposit applied to invoice — deposit already counted in kind=6.
              // Track for reconciliation so we know how much of the invoice was
              // paid via deposits vs direct payments.
              if (!isExcess) {
                hireDepositAppliedToInvoices += absAmount;
              }
            } else if (creditAmount < 0 && description) {
              // Negative credit = actual refund — subtract from totals
              if (!isExcess) {
                deposits.push({
                  id: appId,
                  amount: absAmount,
                  date: data.DATE || row.date || '',
                  description: description || null,
                  memo: memo || null,
                  is_excess: false,
                  is_refund: true,
                  bank_name: getBankName(data.ACC_ACCOUNT_ID),
                  entered_by: data.CREATE_USER_NAME || null,
                });
              }
              if (isExcess) { totalExcessDeposits -= absAmount; }
              else { totalHireDeposits -= absAmount; }
            } else if (creditAmount > 0 && description) {
              // Direct invoice payment (positive credit, no OWNER_DEPOSIT).
              // Show in payment history as a payment (not a refund).
              // The financial total is handled by invoice reconciliation below.
              if (!isExcess) {
                deposits.push({
                  id: appId,
                  amount: absAmount,
                  date: data.DATE || row.date || '',
                  description: description || null,
                  memo: memo || null,
                  is_excess: false,
                  is_refund: false,
                  bank_name: getBankName(data.ACC_ACCOUNT_ID),
                  entered_by: data.CREATE_USER_NAME || null,
                });
              }
            }
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

    // ── Invoice Reconciliation: detect direct invoice payments ──
    // Compare what approved invoices show as paid (debit - owing) against how much
    // deposit money was applied to those invoices (kind=3 rows with OWNER_DEPOSIT).
    // The gap = direct invoice payments that bypassed the deposit system.
    // This fixes the bug where payments applied directly to invoices (not via a
    // kind=6 deposit) were missing from the balance calculation.
    let totalPaidOnApprovedInvoices = 0;
    for (const inv of approvedInvoices) {
      const paidOnInvoice = inv.amount - inv.owing;
      if (paidOnInvoice > 0.01) {
        totalPaidOnApprovedInvoices += paidOnInvoice;
      }
    }
    const directInvoicePayments = Math.max(totalPaidOnApprovedInvoices - hireDepositAppliedToInvoices, 0);
    if (directInvoicePayments > 0.01) {
      totalHireDeposits += directInvoicePayments;
    }

    // ── Passive Reconciliation: match HH excess deposits → OP excess records ──
    // Fire-and-forget: doesn't block the response, but links HH deposits to OP records
    // so they stay in sync for future loads and reimbursement lookups.
    let reconciliationResults: Array<{ hh_deposit_id: number; excess_id: string; action: string }> = [];
    if (hhExcessDeposits.length > 0 && job.id) {
      try {
        reconciliationResults = await reconcileExcessDeposits(job.id, hhExcessDeposits);
      } catch (reconcileErr) {
        console.error('[money] Reconciliation failed (non-fatal):', reconcileErr);
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

    // Build list of unmatched HH excess deposits (not linked to any OP record)
    // These can be manually linked by staff via the UI
    const linkedHHDepositIds = new Set<number>();
    for (const rec of excessRecords) {
      if (rec.hh_deposit_id) linkedHHDepositIds.add(rec.hh_deposit_id);
    }
    // Also check job_payments for any HH deposit IDs linked to excess payments
    const jpLinkedResult = await query(
      `SELECT DISTINCT hirehop_deposit_id FROM job_payments
       WHERE job_id = $1 AND hirehop_deposit_id IS NOT NULL AND payment_type = 'excess'`,
      [job.id]
    );
    for (const row of jpLinkedResult.rows) {
      linkedHHDepositIds.add(row.hirehop_deposit_id);
    }

    const unmatchedHHExcessDeposits = hhExcessDeposits.filter(
      d => !linkedHHDepositIds.has(d.hh_deposit_id)
    );

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
        // Reconciliation info for the frontend
        reconciliation: {
          actions: reconciliationResults,
          unmatched_hh_deposits: unmatchedHHExcessDeposits,
        },
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

      // Hire form email: if job has self-drive vehicle and starts within 10 days, send now
      triggerHireFormEmailOnConfirmation(job.id).catch(err =>
        console.error('[money] Hire form email on confirmation failed (record-payment):', err)
      );
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

            // Also link HH deposit to job_excess record (for reconciliation)
            if (payment_type === 'excess' && excess_id) {
              query(
                `UPDATE job_excess SET hh_deposit_id = $1, hh_reconciled_at = NOW(), hh_reconcile_source = 'op_push' WHERE id = $2`,
                [hhDepositId, excess_id]
              ).catch(() => {}); // non-fatal, fire-and-forget
            }

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
// The portal creates the HH deposit itself — this endpoint records it in OP + handles status transitions.

const paymentEventSchema = z.object({
  payment_type: z.enum(['deposit', 'balance', 'excess', 'excess_pre_auth', 'refund', 'excess_refund', 'other']),
  amount: z.number().min(0),
  payment_method: z.string().max(50).optional(),
  payment_reference: z.string().max(255).optional(),
  stripe_payment_intent: z.string().max(255).optional(),
  source: z.string().max(50).optional(),
  excess_id: z.string().uuid().optional(),
  hh_deposit_id: z.number().int().optional(),
  notes: z.string().max(1000).optional(),
});

router.post('/:jobId/payment-event', validate(paymentEventSchema), async (req: AuthRequest, res: Response) => {
  try {
    const jobId = req.params.jobId as string;
    const {
      payment_type, amount, payment_method, payment_reference,
      stripe_payment_intent, source, excess_id, hh_deposit_id, notes,
    } = req.body;

    // Accept UUID or HH job number
    const isUuid = /^[0-9a-f]{8}-/.test(jobId);
    const jobResult = await query(
      isUuid
        ? `SELECT id, hh_job_number, client_name FROM jobs WHERE id = $1`
        : `SELECT id, hh_job_number, client_name FROM jobs WHERE hh_job_number = $1`,
      [isUuid ? jobId : parseInt(jobId)]
    );

    if (jobResult.rows.length === 0) {
      res.status(404).json({ error: 'Job not found' });
      return;
    }

    const job = jobResult.rows[0];
    const effectiveMethod = payment_method || 'stripe_gbp';
    const effectiveSource = source || 'payment_portal';
    const isPreAuth = payment_type === 'excess_pre_auth';
    const effectivePaymentType = isPreAuth ? 'excess' : (payment_type || 'deposit');

    // Record in job_payments audit log
    const result = await query(
      `INSERT INTO job_payments
        (job_id, hirehop_job_id, payment_type, amount, payment_method,
         payment_reference, stripe_payment_intent, payment_status, source,
         excess_id, hirehop_deposit_id, client_name, notes, payment_date)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, NOW())
       RETURNING *`,
      [
        job.id,
        job.hh_job_number,
        effectivePaymentType,
        amount,
        effectiveMethod,
        payment_reference || null,
        stripe_payment_intent || null,
        isPreAuth ? 'pre_auth' : 'completed',
        effectiveSource,
        excess_id || null,
        hh_deposit_id || null,
        job.client_name,
        notes || null,
      ]
    );

    const payment = result.rows[0];

    // ── Update excess if this is an excess payment or pre-auth ──
    if ((effectivePaymentType === 'excess') && excess_id) {
      if (isPreAuth) {
        // Pre-auth: card hold taken, not yet charged. Set status to 'pre_auth'.
        await query(
          `UPDATE job_excess SET
            excess_amount_taken = $1,
            excess_status = 'pre_auth',
            payment_method = $2,
            payment_reference = $3,
            payment_date = NOW(),
            updated_at = NOW()
          WHERE id = $4`,
          [amount, effectiveMethod, payment_reference || null, excess_id]
        );
        console.log(`[money] Excess ${excess_id} set to pre_auth (£${amount})`);
      } else {
        // Actual excess payment
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
          [amount, effectiveMethod, payment_reference || null, excess_id]
        );
      }

      // Link HH deposit to excess record for reconciliation
      if (hh_deposit_id) {
        query(
          `UPDATE job_excess SET hh_deposit_id = $1, hh_reconciled_at = NOW(), hh_reconcile_source = 'payment_portal' WHERE id = $2`,
          [hh_deposit_id, excess_id]
        ).catch(() => {}); // fire-and-forget
      }
    }

    // ── Status transition: deposit/balance payment on pre-confirmed job → Confirmed ──
    // Portal already creates the HH deposit, so we only update OP status + push HH status.
    let statusChanged = false;
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
          statusChanged = true;
          console.log(`[money] Job ${job.id} moved to confirmed (payment portal deposit received)`);

          // Push status to HireHop (status 2 = Booked)
          if (hhNum) {
            try {
              await hhBroker.post('/frames/status_save.php', {
                job: hhNum,
                status: 2, // Booked
                no_webhook: 1,
              }, { priority: 'high' });
              await query(
                `UPDATE jobs SET status = 2, status_name = 'Booked', hh_status = 2 WHERE id = $1`,
                [job.id]
              );
              console.log(`[money] HH job ${hhNum} status updated to Booked via payment-event`);
            } catch {
              console.error('[money] HH status update to Booked failed (non-fatal, payment-event)');
            }
          }
        }
      } catch (err) {
        console.error('[money] Status transition failed (non-fatal, payment-event):', err);
      }

      // Hire form email: if job has self-drive vehicle and starts within 10 days, send now
      triggerHireFormEmailOnConfirmation(job.id).catch(err =>
        console.error('[money] Hire form email on confirmation failed (payment-event):', err)
      );
    }

    // ── Email triggers (fire-and-forget) ──
    try {
      if (effectivePaymentType === 'excess' && excess_id) {
        // Excess payment/pre-auth email
        sendExcessEmail({
          templateId: isPreAuth ? 'excess_preauth_confirmed' : 'excess_payment_confirmed',
          excessId: excess_id,
          jobId: job.id,
          amount,
          paymentMethod: effectiveMethod,
        }).catch(e => console.error('[money] Excess email failed (payment-event):', e));
      } else if (effectivePaymentType !== 'refund' && effectivePaymentType !== 'excess_refund') {
        // Hire deposit/balance email
        const bankLabel = PAYMENT_METHODS_LABELS[effectiveMethod] || effectiveMethod;
        sendPaymentEmail({
          jobId: job.id,
          amount,
          bankName: bankLabel,
          paymentType: effectivePaymentType,
          isConfirmingBooking: statusChanged,
        }).catch(e => console.error('[money] Payment email failed (payment-event):', e));

        // Last-minute alert if job starts within 3 days and we just confirmed
        if (statusChanged) {
          sendLastMinuteAlert(job.id).catch(e => console.error('[money] Last-minute alert failed (payment-event):', e));
        }
      }
    } catch (emailErr) {
      console.error('[money] Email trigger error (non-fatal, payment-event):', emailErr);
    }

    res.json({
      data: {
        ...payment,
        status_changed: statusChanged,
        is_pre_auth: isPreAuth,
      },
    });
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

/**
 * Passive reconciliation: match HH excess deposits to OP excess records.
 *
 * For each HH excess deposit found in billing_list:
 * 1. Skip if already linked (hh_deposit_id on job_excess, or hirehop_deposit_id on job_payments)
 * 2. Find a matching OP excess record (same job, status 'needed' or 'partially_paid')
 * 3. Update the OP record: set hh_deposit_id, update excess_amount_taken + status
 *
 * Matching strategy:
 * - First try exact amount match (HH deposit amount == excess_amount_required - excess_amount_taken)
 * - Then try any record with status 'needed' or 'partially_paid' (first one)
 * - If no match, the deposit stays unmatched (shown as "unmatched" in the UI for manual linking)
 */
async function reconcileExcessDeposits(
  jobId: string,
  hhExcessDeposits: Array<{ hh_deposit_id: number; amount: number; date: string; description: string | null; memo: string | null; bank_name: string | null }>,
): Promise<Array<{ hh_deposit_id: number; excess_id: string; action: string }>> {
  const results: Array<{ hh_deposit_id: number; excess_id: string; action: string }> = [];

  // Get all HH deposit IDs already linked in OP (either on job_excess or job_payments)
  const [linkedExcess, linkedPayments] = await Promise.all([
    query(
      `SELECT hh_deposit_id FROM job_excess WHERE job_id = $1 AND hh_deposit_id IS NOT NULL`,
      [jobId]
    ),
    query(
      `SELECT hirehop_deposit_id FROM job_payments WHERE job_id = $1 AND hirehop_deposit_id IS NOT NULL AND payment_type = 'excess'`,
      [jobId]
    ),
  ]);

  const alreadyLinked = new Set<number>([
    ...linkedExcess.rows.map((r: any) => r.hh_deposit_id),
    ...linkedPayments.rows.map((r: any) => r.hirehop_deposit_id),
  ]);

  // Get excess records for this job that could be matched
  const excessRecords = await query(
    `SELECT id, excess_amount_required, excess_amount_taken, excess_status, hh_deposit_id
     FROM job_excess WHERE job_id = $1
     ORDER BY created_at ASC`,
    [jobId]
  );

  // Build a mutable list of available records (not yet linked to an HH deposit)
  const availableRecords = excessRecords.rows.filter(
    (r: any) => !r.hh_deposit_id && ['needed', 'partially_paid'].includes(r.excess_status)
  );

  for (const hhDep of hhExcessDeposits) {
    if (alreadyLinked.has(hhDep.hh_deposit_id)) continue;

    // Try to find a matching OP excess record
    // Strategy 1: exact remaining-amount match
    let matchIdx = availableRecords.findIndex((r: any) => {
      const remaining = Math.max(0, parseFloat(r.excess_amount_required || 0) - parseFloat(r.excess_amount_taken || 0));
      return Math.abs(remaining - hhDep.amount) < 0.01; // penny tolerance
    });

    // Strategy 2: if no exact match, try amount-required match (fresh record, nothing taken yet)
    if (matchIdx === -1) {
      matchIdx = availableRecords.findIndex((r: any) => {
        const required = parseFloat(r.excess_amount_required || 0);
        return Math.abs(required - hhDep.amount) < 0.01 && parseFloat(r.excess_amount_taken || 0) === 0;
      });
    }

    // Strategy 3: just take the first available 'needed' record
    if (matchIdx === -1 && availableRecords.length > 0) {
      matchIdx = 0;
    }

    if (matchIdx === -1) continue; // No record to match — will show as unmatched in UI

    const record = availableRecords[matchIdx];
    const currentTaken = parseFloat(record.excess_amount_taken || 0);
    const newTaken = currentTaken + hhDep.amount;
    const required = parseFloat(record.excess_amount_required || 0);
    const newStatus = required > 0 && newTaken >= required ? 'taken' : 'partially_paid';

    try {
      await query(
        `UPDATE job_excess SET
          hh_deposit_id = $1,
          hh_reconciled_at = NOW(),
          hh_reconcile_source = 'auto_match',
          excess_amount_taken = $2,
          excess_status = $3,
          payment_date = COALESCE(payment_date, $4::timestamptz),
          updated_at = NOW()
        WHERE id = $5`,
        [hhDep.hh_deposit_id, newTaken, newStatus, hhDep.date || new Date().toISOString(), record.id]
      );

      results.push({ hh_deposit_id: hhDep.hh_deposit_id, excess_id: record.id, action: 'auto_matched' });
      console.log(`[money] Reconciled: HH deposit ${hhDep.hh_deposit_id} (£${hhDep.amount}) → excess ${record.id} (status: ${newStatus})`);

      // Remove from available list so it can't be double-matched
      availableRecords.splice(matchIdx, 1);
      alreadyLinked.add(hhDep.hh_deposit_id);
    } catch (err) {
      console.error(`[money] Failed to reconcile HH deposit ${hhDep.hh_deposit_id}:`, err);
    }
  }

  return results;
}

async function triggerHireFormEmailOnConfirmation(jobId: string): Promise<void> {
  const jobData = await query(
    `SELECT job_date, is_van_and_driver, hh_job_number FROM jobs WHERE id = $1`,
    [jobId]
  );
  if (jobData.rows.length === 0) return;
  const { job_date, is_van_and_driver, hh_job_number } = jobData.rows[0];
  if (is_van_and_driver || !hh_job_number || !job_date) return;

  const daysUntilStart = Math.ceil((new Date(job_date).getTime() - Date.now()) / (1000 * 60 * 60 * 24));
  if (daysUntilStart > 10) return;

  const hfReq = await query(
    `SELECT id, status FROM job_requirements WHERE job_id = $1 AND requirement_type = 'hire_forms'`,
    [jobId]
  );
  if (hfReq.rows.length === 0 || hfReq.rows[0].status !== 'not_started') return;

  const { sendHireFormEmailForJob } = await import('../services/hire-form-auto-email');
  console.log(`[money] Job ${hh_job_number} confirmed with ${daysUntilStart} days to go — triggering hire form email`);

  const jobRow = await query(
    `SELECT j.id, j.hh_job_number, j.job_name, j.job_date, j.company_name, j.client_name, j.client_id,
            jr.id AS req_id
     FROM jobs j JOIN job_requirements jr ON jr.job_id = j.id AND jr.requirement_type = 'hire_forms'
     WHERE j.id = $1`,
    [jobId]
  );
  if (jobRow.rows.length > 0) {
    await sendHireFormEmailForJob(jobRow.rows[0], false);
  }
}

export default router;
