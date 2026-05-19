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
import { verifyApiKey } from '../middleware/api-key';
import { hhBroker } from '../services/hirehop-broker';
import { pushDepositToHH } from '../services/hh-deposit';
import { sendPaymentEmail, sendExcessEmail, sendLastMinuteAlert } from '../services/money-emails';
import {
  triggerHireFormEmailOnConfirmation as triggerHireFormEmailOnConfirmationShared,
  hireFormResultIsAnomaly,
  sendConfirmationSilentSkipAlert,
  type SilentSkipIssue,
} from '../services/confirmation-hooks';
import { calculateVatAdjustment } from '../services/vat-adjustment';
import { syncExcessRequirementStatus } from '../services/excess-requirement-sync';
import { emailService } from '../services/email-service';
import { getFrontendUrl } from '../config/app-urls';

const router = Router();

/**
 * Flexible auth: accepts either JWT Bearer token OR X-API-Key header.
 * JWT auth populates req.user as normal. API key auth verifies against
 * api_keys table and sets req.user to a minimal service user object.
 */
async function authenticateFlexible(req: Request, res: Response, next: NextFunction) {
  const apiKey = req.headers['x-api-key'] as string | undefined;

  if (apiKey) {
    // API key auth — for Payment Portal and external services. Uses the
    // shared verifier which does full-key bcrypt comparison (the previous
    // inline implementation matched on key_prefix only, accepting anything
    // starting with `ppk_live`).
    try {
      const matched = await verifyApiKey(apiKey);
      if (!matched) {
        res.status(403).json({ error: 'Invalid API key' });
        return;
      }
      (req as any).user = { id: matched.id, role: 'service', name: matched.service };
      next();
    } catch (err) {
      console.error('[money] API key verification error:', err);
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

// `amount` is the new money to record (delta).
//
// `total_collected` (optional, excess only): the absolute new total on the
// excess record. When present, the backend computes the delta (new - previous)
// and uses that as the payment `amount`. This makes the Excess form
// idempotent — clicking "Record" twice with the same total_collected can't
// double the collected amount on the excess record.
const recordPaymentSchema = z.object({
  payment_type: z.enum(['deposit', 'balance', 'excess', 'refund', 'excess_refund', 'other']),
  amount: z.number().min(0).optional(),
  total_collected: z.number().min(0).optional(),
  payment_method: z.enum([
    'stripe_gbp', 'worldpay', 'amex', 'wise_bacs', 'till_cash', 'paypal', 'lloyds_bank', 'rolled_over',
  ]),
  payment_reference: z.string().max(255).optional(),
  notes: z.string().max(1000).optional(),
  excess_id: z.string().uuid().optional(),
  push_to_hirehop: z.boolean().default(true),
}).refine(
  (val) => (val.amount !== undefined && val.amount >= 0.01) || val.total_collected !== undefined,
  { message: 'Either amount (>= 0.01) or total_collected must be provided' }
);

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

    // Get per-driver excess records with vehicle and driver info.
    //
    // The LEFT JOIN on `previous_excess` (LATERAL) walks the rollover chain: when
    // an excess record carries a hh_deposit_id but the deposit lives on a
    // *different* HH job, that's a rolled-over excess. We expose the source HH
    // job number so the payment portal can tell the client "your excess is
    // already held from your previous hire #15676, no further excess payment
    // needed for this hire."
    const excessResult = await query(
      `SELECT je.id AS excess_id, je.excess_amount_required, je.excess_amount_taken,
              je.excess_status, je.excess_calculation_basis, je.payment_method,
              je.payment_reference, je.payment_date, je.hh_deposit_id,
              je.suggested_collection_method, je.client_name,
              d.id AS driver_id, d.full_name AS driver_name,
              d.licence_points, d.requires_referral,
              fv.id AS vehicle_id, fv.reg AS vehicle_reg, fv.simple_type AS vehicle_type,
              vha.assignment_type, vha.status AS assignment_status,
              prev.hh_job_number AS rolled_over_from_hh_job
       FROM job_excess je
       LEFT JOIN vehicle_hire_assignments vha ON vha.id = je.assignment_id
       LEFT JOIN fleet_vehicles fv ON fv.id = vha.vehicle_id
       LEFT JOIN drivers d ON d.id = vha.driver_id
       LEFT JOIN LATERAL (
         SELECT j2.hh_job_number
         FROM job_excess je2
         JOIN jobs j2 ON j2.id = je2.job_id
         WHERE je2.hh_deposit_id = je.hh_deposit_id
           AND je2.id <> je.id
           AND je.payment_method = 'rolled_over'
           AND COALESCE(je2.payment_method, '') <> 'rolled_over'
           AND j2.hh_job_number IS NOT NULL
         ORDER BY je2.created_at ASC
         LIMIT 1
       ) AS prev ON true
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
        excess_amount: required, // alias for Payment Portal compat
        excess: required, // alias — Payment Portal sorts on `.excess`
        excess_amount_taken: taken,
        excess_outstanding: Math.max(0, required - taken),
        excess_status: r.excess_status,
        status: r.excess_status, // alias — Payment Portal checks `.status`
        excess_calculation_basis: r.excess_calculation_basis,
        payment_method: r.payment_method,
        payment_reference: r.payment_reference,
        payment_date: r.payment_date,
        licence_points: r.licence_points,
        requires_referral: r.requires_referral,
        suggested_collection_method: r.suggested_collection_method,
        // Rollover linkage for payment portal display: when this excess was
        // rolled over from a previous hire, expose the source HH job number
        // so the portal can tell the client "your £1,200 excess is held from
        // your previous hire #15676 — no further excess payment needed."
        is_rolled_over: r.payment_method === 'rolled_over',
        rolled_over_from_hh_job: r.rolled_over_from_hh_job
          ? Number(r.rolled_over_from_hh_job)
          : null,
      };
    });

    // Totals
    const totalRequired = drivers.reduce((sum: number, d: any) => sum + d.excess_amount_required, 0);
    const totalCollected = drivers.reduce((sum: number, d: any) => sum + d.excess_amount_taken, 0);
    const totalOutstanding = Math.max(0, totalRequired - totalCollected);

    // A record is "covered" if it's in a terminal state (waived/reimbursed/claimed/rolled_over/not_required),
    // OR enough money has been taken/held to meet the required amount. This catches the edge case of a
    // pre-auth or 'taken' record that's underfunded (e.g. £600 pre-auth against £1,200 required).
    const terminalStatuses = ['waived', 'rolled_over', 'not_required', 'reimbursed', 'fully_claimed', 'partially_reimbursed'];
    const isCovered = (d: any) => {
      if (terminalStatuses.includes(d.excess_status)) return true;
      const required = d.excess_amount_required || 0;
      const taken = d.excess_amount_taken || 0;
      return required > 0 && taken >= required;
    };
    const driversCleared = drivers.filter(isCovered).length;
    const driversPending = drivers.length - driversCleared;

    // Summary flags for Payment Portal — quick checks without parsing driver array
    const hasPreAuth = drivers.some((d: any) => d.excess_status === 'pre_auth');
    const hasPaid = drivers.some((d: any) => d.excess_status === 'taken' || (d.excess_amount_taken > 0 && d.excess_status !== 'pre_auth'));
    const hasRetained = drivers.some((d: any) => d.excess_status === 'rolled_over');
    const allCleared = drivers.length > 0 && driversPending === 0;

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
        // Summary flags — portal-friendly boolean checks
        excess_status_flags: {
          has_pre_auth: hasPreAuth,
          has_paid: hasPaid,
          has_retained: hasRetained,
          all_cleared: allCleared,
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
    // Track credit notes — these reduce HH invoice owing without being real cash,
    // so they must be subtracted from the reconciliation gap to avoid being
    // counted as "direct invoice payments". See job 15627 incident (May 2026).
    let totalCreditNotesApplied = 0;
    // Collect approved invoices for reconciliation (detect direct invoice payments)
    const approvedInvoices: Array<{ amount: number; owing: number }> = [];
    // HireHop dual-publishes a single payment-application as TWO kind=3 rows:
    //   - one as a child of the deposit (parent_is="deposit", negative credit)
    //   - one as a child of the invoice (parent_is="invoice", positive credit)
    // Both rows carry the same data.ID. Without dedup we double-count
    // hireDepositAppliedToInvoices, which clamps directInvoicePayments to 0 and
    // makes side-invoices (e.g. shop sales paid directly) appear unpaid.
    // Track seen application IDs and skip subsequent occurrences.
    const seenApplicationIds = new Set<number>();

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

          // Skip duplicate published views of the same application (see seenApplicationIds note above).
          // Dedup key is data.ID (HH's primary key for the application record). We only dedup when
          // we have a valid ID; falls through if missing so we don't lose data.
          const dedupId = parseInt(data.ID || '0');
          if (dedupId > 0) {
            if (seenApplicationIds.has(dedupId)) {
              console.warn(`[money] Skipping duplicate kind=3 row for application ID ${dedupId} on job ${hhJobId}`);
              continue;
            }
            seenApplicationIds.add(dedupId);
          }

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
          // Credit note. HireHop publishes the value in `row.credit` (positive),
          // not as a negative `row.debit`. HH already nets credit notes off the
          // invoice's `owing` field, so adding them to totalHireDeposits would
          // double-count (the hire-value side already reflects the credit, and
          // PASS 3 reconciliation would also count them as direct invoice
          // payments). Instead track separately and subtract from the
          // reconciliation gap below. Verified against job 15627 (May 2026).
          const creditAmount = parseFloat(
            row.credit || data.credit || (-(parseFloat(row.debit || data.debit || '0'))).toString()
          );
          const description = String(data.DESCRIPTION || row.desc || '');
          const isExcess = isExcessPayment(description);

          if (creditAmount > 0 && !isExcess) {
            totalCreditNotesApplied += creditAmount;
          }
          // Excess credit notes are rare in practice; preserve original behaviour
          // (treat as deposit) for now until we see one in the wild.
          else if (creditAmount > 0 && isExcess) {
            totalExcessDeposits += creditAmount;
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
    // Credit notes reduce an invoice's `owing` without being real cash, so we
    // subtract them from the gap to avoid mistaking the credit-note offset
    // for a direct payment. Verified against job 15627 (May 2026): £24 credit
    // note was inflating totalHireDeposits by £24, producing a phantom £2.40
    // overpayment.
    const directInvoicePayments = Math.max(
      totalPaidOnApprovedInvoices - hireDepositAppliedToInvoices - totalCreditNotesApplied,
      0
    );
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
    const { payment_type, payment_method, payment_reference, notes, push_to_hirehop } = req.body;
    let { amount, excess_id, total_collected } = req.body;

    // Look up the job
    const jobResult = await query(
      `SELECT id, hh_job_number, client_name, company_name, job_name FROM jobs WHERE id = $1`,
      [jobId]
    );

    if (jobResult.rows.length === 0) {
      res.status(404).json({ error: 'Job not found' });
      return;
    }

    const job = jobResult.rows[0];

    // Excess auto-find: if no excess_id passed (frontend used to filter out
    // 'taken' records, leaving the field empty when an existing record was
    // present), look up the most recent record on this job. Prefer
    // pre-collection records first, then fall back to any record so top-ups on
    // already-collected excesses link correctly.
    if (payment_type === 'excess' && !excess_id) {
      const found = await query(
        `SELECT id FROM job_excess
         WHERE job_id = $1
         ORDER BY
           CASE WHEN excess_status IN ('needed','pending','partially_paid','partial') THEN 0 ELSE 1 END,
           updated_at DESC
         LIMIT 1`,
        [job.id]
      );
      if (found.rows.length > 0) {
        excess_id = found.rows[0].id;
        console.log(`[money] Auto-linked excess payment to existing record ${excess_id} on job ${job.id}`);
      }
    }

    // total_collected → amount delta translation. Used by the new "Total
    // collected" UX for excess payments.
    if (total_collected !== undefined && excess_id) {
      const existingExcess = await query(
        `SELECT excess_amount_taken FROM job_excess WHERE id = $1`,
        [excess_id]
      );
      if (existingExcess.rows.length > 0) {
        const previousTaken = parseFloat(existingExcess.rows[0].excess_amount_taken || 0);
        amount = total_collected - previousTaken;

        if (Math.abs(amount) < 0.005) {
          res.json({
            data: { idempotent: true, excess_id, message: 'Total collected already matches — nothing to record.' },
            hh_push_error: null,
          });
          return;
        }

        if (amount < 0) {
          res.status(400).json({
            error: 'Lowering the total collected requires a refund/correction. Use the excess Manage form instead.',
          });
          return;
        }
      }
    }

    if (amount === undefined || amount < 0.01) {
      res.status(400).json({ error: 'Amount must be at least £0.01' });
      return;
    }

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

      // Promote the excess requirement to 'done' if coverage is now met
      syncExcessRequirementStatus(job.id).catch(e =>
        console.error('[money] syncExcessRequirementStatus failed (record-payment):', e)
      );
    }

    // Status transition: deposit payment on enquiry/provisional → Booked
    // A deposit (or full payment) means the job is confirmed.
    //
    // INVARIANT: `statusChanged` is true ONLY when THIS payment moved the job
    // from a pre-confirmed status into 'confirmed'. Once a job is confirmed,
    // any subsequent payment is just a receipt — it must NOT re-trigger
    // booking-confirmation behaviour (booking_confirmed_deposit email,
    // last-minute alert, hire-form auto-send). Use `statusChanged`, never
    // "is currently confirmed", to gate those side effects.
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

      // Hire form email: if job has self-drive vehicle and starts within 10 days, send now.
      // Only fires when this payment actually confirmed the booking — subsequent
      // payments on an already-confirmed job must not re-send the hire form email.
      if (statusChanged) {
        (async () => {
          try {
            const hfResult = await triggerHireFormEmailOnConfirmationShared(job.id);
            const anomaly = hireFormResultIsAnomaly(hfResult);
            if (anomaly) {
              await sendConfirmationSilentSkipAlert({
                jobId: job.id,
                jobNumber: job.hh_job_number,
                jobName: job.job_name ?? null,
                clientName: job.client_name,
                triggerSource: 'status_change',
                issues: [anomaly],
              });
            }
          } catch (err) {
            console.error('[money] Hire form email on confirmation failed (record-payment):', err);
          }
        })();
      }
    }

    // Push to HireHop as deposit (if requested and job has HH number).
    //
    // Failures used to be swallowed silently — the response was 200 OK with
    // hirehop_deposit_id: null and no signal to the user. We now surface the
    // error in the response so the frontend can show a "Saved in OP but HH
    // push failed" banner and prompt for manual link/retry.
    let hhDepositId: number | null = null;
    let xeroSynced = false;
    let hhPushError: string | null = null;
    if (push_to_hirehop && job.hh_job_number && payment_type !== 'refund' && payment_method !== 'rolled_over') {
      const pushResult = await pushDepositToHH({
        hhJobNumber: Number(job.hh_job_number),
        amount,
        paymentMethod: payment_method,
        paymentReference: payment_reference || null,
        paymentType: payment_type,
        notes: notes || null,
      });
      hhDepositId = pushResult.hhDepositId;
      xeroSynced = pushResult.xeroSynced;
      hhPushError = pushResult.error;

      if (hhDepositId) {
        try {
          await query(
            `UPDATE job_payments SET hirehop_deposit_id = $1 WHERE id = $2`,
            [hhDepositId, payment.id]
          );

          // Link HH deposit to job_excess record for reconciliation
          if (payment_type === 'excess' && excess_id) {
            await query(
              `UPDATE job_excess SET hh_deposit_id = $1, hh_reconciled_at = NOW(), hh_reconcile_source = 'op_push' WHERE id = $2 AND hh_deposit_id IS NULL`,
              [hhDepositId, excess_id]
            );
          }
        } catch (linkErr) {
          console.error('[money] HH deposit linkage update failed (non-fatal):', linkErr);
        }
      }
    } else if (push_to_hirehop && !job.hh_job_number) {
      // Caller asked for HH push but the job isn't linked to HireHop yet —
      // surface this so they know the payment is OP-only.
      hhPushError = 'Job is not linked to HireHop yet — payment recorded in OP only. Create the HH job first to enable HH sync.';
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
        // Hire payment email — see invariant comment on `statusChanged` above.
        // `isConfirmingBooking` must reflect "did THIS payment confirm the
        // booking?", not "is the booking currently confirmed?". Subsequent
        // payments on already-confirmed jobs are receipts, not confirmations.
        const payResult = await sendPaymentEmail({
          jobId: job.id,
          amount,
          bankName: bankLabel,
          paymentType: payment_type,
          isConfirmingBooking: statusChanged,
        });
        if (!payResult.sent) {
          console.error(
            `[money] Payment email not sent (record-payment, job ${job.id}): ${payResult.reason}${payResult.error ? ` — ${payResult.error}` : ''}`
          );
          sendConfirmationSilentSkipAlert({
            jobId: job.id,
            jobNumber: job.hh_job_number,
            jobName: job.job_name ?? null,
            clientName: job.client_name,
            triggerSource: 'status_change',
            issues: [{
              kind: 'payment_email',
              reason: payResult.reason === 'no_recipient'
                ? 'no client email found in OP address book (client org has no email and no linked contacts with emails)'
                : 'unexpected error while sending payment confirmation email',
              context: payResult.error,
            }],
          }).catch(e => console.error('[money] Silent-skip alert failed (record-payment):', e));
        }

        // Last-minute alert: only fires when this payment actually confirmed
        // the booking. Receipts on already-confirmed jobs must not re-alert.
        if (statusChanged) {
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
      hh_push_error: hhPushError,
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
        ? `SELECT id, hh_job_number, client_name, job_name FROM jobs WHERE id = $1`
        : `SELECT id, hh_job_number, client_name, job_name FROM jobs WHERE hh_job_number = $1`,
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

    // ── Defence-in-depth: alert when portal-source deposit/balance landed
    //    without a HireHop deposit ID ──
    // The Payment Portal's `handle-stripe-webhook.js` Step 1 (HH deposit
    // create) silently swallows HireHop transient errors (notably 327 rate
    // limit) and proceeds to call us regardless — leaving the OP record
    // orphaned and the HH side empty. Money tab reads HH billing_list live
    // so the balance still shows outstanding while the client got a
    // confirmation email. The proper fix lives in the portal repo (retry on
    // 327/329/429/5xx, bail to Stripe webhook retry on persistent failure).
    // Until that ships everywhere, surface the failure within minutes via
    // a direct email so staff can manually create the HH deposit + link it
    // from the OP Money tab.
    //
    // Scoped to deposit/balance only — excess payments go through a
    // different portal path that may not pass `hh_deposit_id` even on
    // success, so a NULL there is not a reliable failure signal.
    const isPortalDepositOrBalance =
      effectiveSource === 'payment_portal' &&
      !hh_deposit_id &&
      (effectivePaymentType === 'deposit' || effectivePaymentType === 'balance');
    if (isPortalDepositOrBalance) {
      sendPortalHHPushFailedAlert({
        opJobId: job.id,
        hhJobNumber: job.hh_job_number,
        clientName: job.client_name,
        jobName: (job as { job_name?: string }).job_name ?? null,
        amount,
        paymentType: effectivePaymentType,
        paymentReference: payment_reference || null,
        stripePaymentIntent: stripe_payment_intent || null,
      }).catch(e => console.error('[money] Portal HH-push-failed alert send failed:', e));
    }

    // ── Update excess if this is an excess payment or pre-auth ──
    let resolvedExcessId = excess_id || null;

    if (effectivePaymentType === 'excess') {
      // If no excess_id provided, try to find or create a job_excess record
      if (!resolvedExcessId) {
        // Look for an existing job_excess record for this job
        const existingExcess = await query(
          `SELECT id, excess_status FROM job_excess
           WHERE job_id = $1 AND excess_status NOT IN ('reimbursed', 'fully_claimed', 'rolled_over', 'not_required')
           ORDER BY created_at DESC LIMIT 1`,
          [job.id]
        );

        if (existingExcess.rows.length > 0) {
          resolvedExcessId = existingExcess.rows[0].id;
          console.log(`[money] Found existing excess record ${resolvedExcessId} for job ${job.id}`);
        } else {
          // No excess record exists — auto-create one (payment portal charged before hire form submitted)
          const newExcess = await query(
            `INSERT INTO job_excess (
              job_id, hirehop_job_id, excess_amount_required, excess_status,
              client_name, notes, created_by
            ) VALUES ($1, $2, $3, 'needed', $4, $5, $6)
            RETURNING id`,
            [
              job.id,
              job.hh_job_number,
              amount, // Use payment amount as required (default £1,200 from portal)
              job.client_name,
              'Auto-created from payment portal excess payment',
              '00000000-0000-0000-0000-000000000000', // system user
            ]
          );
          resolvedExcessId = newExcess.rows[0].id;
          console.log(`[money] Auto-created excess record ${resolvedExcessId} for job ${job.id} (£${amount})`);
        }

        // Update the job_payments record to link to the resolved excess
        query(
          `UPDATE job_payments SET excess_id = $1 WHERE id = $2`,
          [resolvedExcessId, payment.id]
        ).catch(() => {});
      }

      // Now update the excess record
      if (isPreAuth) {
        await query(
          `UPDATE job_excess SET
            excess_amount_taken = $1,
            excess_status = 'pre_auth',
            payment_method = $2,
            payment_reference = $3,
            payment_date = NOW(),
            updated_at = NOW()
          WHERE id = $4`,
          [amount, effectiveMethod, payment_reference || null, resolvedExcessId]
        );
        console.log(`[money] Excess ${resolvedExcessId} set to pre_auth (£${amount})`);
      } else {
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
          [amount, effectiveMethod, payment_reference || null, resolvedExcessId]
        );
      }

      // Link HH deposit to excess record for reconciliation
      if (hh_deposit_id) {
        query(
          `UPDATE job_excess SET hh_deposit_id = $1, hh_reconciled_at = NOW(), hh_reconcile_source = 'payment_portal' WHERE id = $2`,
          [hh_deposit_id, resolvedExcessId]
        ).catch(() => {}); // fire-and-forget
      }

      // Promote the excess requirement to 'done' if coverage is now met
      syncExcessRequirementStatus(job.id).catch(e =>
        console.error('[money] syncExcessRequirementStatus failed (payment-event):', e)
      );
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

    }

    // ── Hire form email + payment email + silent-skip alerting ──
    // Awaited so the info@ alert (if any) aggregates every issue into a single email.
    // Derivation inside triggerHireFormEmailOnConfirmationShared covers the common
    // "HH-synced job whose requirements hadn't been derived yet" timing gap.
    const silentSkipIssues: SilentSkipIssue[] = [];

    if (statusChanged) {
      try {
        const hfResult = await triggerHireFormEmailOnConfirmationShared(job.id);
        const anomaly = hireFormResultIsAnomaly(hfResult);
        if (anomaly) silentSkipIssues.push(anomaly);
      } catch (err) {
        console.error('[money] Hire form email on confirmation failed (payment-event):', err);
        silentSkipIssues.push({
          kind: 'hire_form_email',
          reason: 'unexpected error while triggering hire form email',
          context: err instanceof Error ? err.message : String(err),
        });
      }
    }

    try {
      if (effectivePaymentType === 'excess' && resolvedExcessId) {
        // Excess payment/pre-auth email (fire-and-forget — no silent-skip alerting)
        sendExcessEmail({
          templateId: isPreAuth ? 'excess_preauth_confirmed' : 'excess_payment_confirmed',
          excessId: resolvedExcessId,
          jobId: job.id,
          amount,
          paymentMethod: effectiveMethod,
        }).catch(e => console.error('[money] Excess email failed (payment-event):', e));
      } else if (effectivePaymentType !== 'refund' && effectivePaymentType !== 'excess_refund' && effectivePaymentType !== 'excess') {
        // Hire deposit/balance email
        const bankLabel = PAYMENT_METHODS_LABELS[effectiveMethod] || effectiveMethod;
        const payResult = await sendPaymentEmail({
          jobId: job.id,
          amount,
          bankName: bankLabel,
          paymentType: effectivePaymentType,
          isConfirmingBooking: statusChanged,
        });
        if (!payResult.sent) {
          const isMissingRecipient = payResult.reason === 'no_recipient';
          console.error(
            `[money] Payment email not sent (payment-event, job ${job.id}): ${payResult.reason}${payResult.error ? ` — ${payResult.error}` : ''}`
          );
          silentSkipIssues.push({
            kind: 'payment_email',
            reason: isMissingRecipient
              ? 'no client email found in OP address book (client org has no email and no linked contacts with emails)'
              : 'unexpected error while sending payment confirmation email',
            context: payResult.error,
          });
        }

        // Last-minute alert if job starts within 3 days and we just confirmed
        if (statusChanged) {
          sendLastMinuteAlert(job.id).catch(e => console.error('[money] Last-minute alert failed (payment-event):', e));
        }
      }
    } catch (emailErr) {
      console.error('[money] Email trigger error (non-fatal, payment-event):', emailErr);
    }

    if (silentSkipIssues.length > 0) {
      sendConfirmationSilentSkipAlert({
        jobId: job.id,
        jobNumber: job.hh_job_number,
        jobName: (job as { job_name?: string }).job_name ?? null,
        clientName: job.client_name,
        triggerSource: 'payment_event',
        issues: silentSkipIssues,
      }).catch(e => console.error('[money] Silent-skip alert failed (payment-event):', e));
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

// HH bank ID mapping moved to services/hh-deposit.ts (shared with excess.ts).

/**
 * Detect if a deposit description/memo indicates an excess payment.
 * Matches the same keywords as the Payment Portal's isExcessPayment().
 *
 * Uses word boundaries to avoid false positives from URLs and longer tokens
 * (e.g. a Stripe URL like pi_...dNxs3kl must NOT trigger on "xs").
 */
function isExcessPayment(text: string): boolean {
  const lower = text.toLowerCase();
  return /\bexcess\b|\binsurance\b|\bxs\b|\btop[- ]?up\b/.test(lower);
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

// ── Portal HH-push-failed alert ──────────────────────────────────────────
// Fired when a payment-event arrives from `source=payment_portal` for a
// deposit/balance payment with no `hh_deposit_id`. Means the portal's Step 1
// (create HH deposit) silently failed but it called us anyway. Sends a
// targeted email so staff can manually create the HH deposit and link it.
//
// Recipient is hardcoded to jon@oooshtours.co.uk for now (the volume is
// expected to be very low — once the portal-side retry fix is fully bedded
// in this should fire ~never). Move to env var if it ever needs to differ.
const PORTAL_HH_FAIL_ALERT_RECIPIENT = 'jon@oooshtours.co.uk';

async function sendPortalHHPushFailedAlert(opts: {
  opJobId: string;
  hhJobNumber: number | string | null;
  clientName: string | null;
  jobName: string | null;
  amount: number;
  paymentType: string;
  paymentReference: string | null;
  stripePaymentIntent: string | null;
}): Promise<void> {
  try {
    const frontendUrl = getFrontendUrl();
    const jobUrl = `${frontendUrl}/jobs/${opts.opJobId}`;
    const escape = (s: string) =>
      s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    const fmtMoney = (n: number) =>
      n.toLocaleString('en-GB', { style: 'currency', currency: 'GBP' });

    const html = `
      <h2 style="margin:0 0 12px;font-size:18px;color:#b91c1c;">Stripe payment received but HireHop deposit was not created</h2>
      <p style="margin:0 0 12px;font-size:14px;color:#334155;line-height:1.5;">
        Job <strong>${escape(String(opts.hhJobNumber ?? '(no HH number)'))}</strong>
        ${opts.jobName ? `(${escape(opts.jobName)})` : ''}
        — ${escape(opts.paymentType)} payment of <strong>${fmtMoney(opts.amount)}</strong>
        landed via the Payment Portal, but the HireHop deposit was not created
        (the portal's Step 1 call to HireHop failed, most likely a transient
        rate-limit / error 327, but it called us anyway).
      </p>
      <p style="margin:0 0 12px;font-size:14px;color:#334155;line-height:1.5;">
        OP recorded the payment + emailed the client a receipt. HireHop has
        no record of the deposit, so the Money tab still shows the balance
        as outstanding.
      </p>
      <p style="margin:0 0 12px;font-size:14px;color:#334155;">
        <strong>Client:</strong> ${escape(opts.clientName || '(not set)')}<br>
        ${opts.paymentReference ? `<strong>Reference:</strong> ${escape(opts.paymentReference)}<br>` : ''}
        ${opts.stripePaymentIntent ? `<strong>Stripe PI:</strong> ${escape(opts.stripePaymentIntent)}<br>` : ''}
      </p>
      <p style="margin:0 0 12px;font-size:14px;color:#334155;line-height:1.5;">
        <strong>Manual fix:</strong>
      </p>
      <ol style="margin:0 0 16px 20px;padding:0;font-size:14px;color:#334155;line-height:1.6;">
        <li>Create the deposit manually in HireHop (Bank: Stripe GBP / 267, Reference: ${opts.paymentReference ? escape(opts.paymentReference) : '(see Stripe)'}).</li>
        <li>On the OP Money tab → Manage on the relevant record → Link to HireHop deposit.</li>
        <li>Verify the Money tab balance is now correct.</li>
      </ol>
      <p style="margin:0;font-size:14px;">
        <a href="${jobUrl}" style="color:#7B5EA7;text-decoration:none;font-weight:600;">View job in Ooosh &rarr;</a>
      </p>
    `;

    await emailService.sendRaw({
      to: PORTAL_HH_FAIL_ALERT_RECIPIENT,
      subject: `[Stripe→HH sync failed] Job #${opts.hhJobNumber ?? opts.opJobId} — manual deposit needed (${fmtMoney(opts.amount)})`,
      html,
      variant: 'internal',
    });

    console.log(
      `[money] Portal HH-push-failed alert sent to ${PORTAL_HH_FAIL_ALERT_RECIPIENT} for job ${opts.hhJobNumber ?? opts.opJobId} (${fmtMoney(opts.amount)} ${opts.paymentType})`
    );
  } catch (err) {
    console.error('[money] sendPortalHHPushFailedAlert failed:', err);
  }
}

export default router;
