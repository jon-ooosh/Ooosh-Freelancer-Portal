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
import { pushDepositToHH, HH_BANK_IDS } from '../services/hh-deposit';
import { getStripeClient, isStripeConfigured, isStripeError } from '../config/stripe';
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

// ── GET /api/money/overview — Global financial dashboard ──
//
// Reads the OP-cached `job_financials` table (populated write-through from the
// Money tab /summary) + live `job_excess` (excess is OP-owned, real-time) +
// pending `job_payments` refund IOUs. NO HireHop calls — instant. Figures are
// as fresh as the last time each job's Money tab was viewed (or the nightly
// backfill); each row carries last_synced_at so staleness is visible.
//
// Staff-only (admin/manager) — read of cross-job financials. Registered before
// the parametrised /:jobId routes (single-segment path, no collision anyway).
router.get('/overview', authorize('admin', 'manager'), async (_req: AuthRequest, res: Response) => {
  try {
    // Balances outstanding — anything still owed on a non-dead job, biggest
    // first. Jobs with a business-level balance override (admin flagged the HH
    // balance as settled in Xero / written off / etc.) are split into a separate
    // `resolved` list and excluded from the active list + headline total — see
    // migration 111. The override carries reason/notes/who/when for the
    // collapsible "Resolved" section.
    const balancesAll = await query(
      `SELECT jf.job_id, j.hh_job_number, j.job_name,
              COALESCE(j.client_name, j.company_name) AS client_name,
              j.pipeline_status, j.job_date, j.job_end, j.return_date,
              jf.hire_value_inc_vat, jf.total_hire_deposits, jf.balance_outstanding,
              jf.vat_saved, jf.last_synced_at,
              o.reason       AS override_reason,
              o.notes        AS override_notes,
              o.resolved_at  AS override_resolved_at,
              u.name         AS override_resolved_by_name
       FROM job_financials jf
       JOIN jobs j ON j.id = jf.job_id
       LEFT JOIN job_balance_overrides o ON o.job_id = jf.job_id
       LEFT JOIN users u ON u.id = o.resolved_by
       WHERE jf.balance_outstanding > 0.01
         AND COALESCE(j.pipeline_status, '') NOT IN ('lost', 'cancelled')
       ORDER BY jf.balance_outstanding DESC
       LIMIT 400`
    );
    const balances = {
      rows: balancesAll.rows.filter((r: Record<string, unknown>) => !r.override_reason),
    };
    const balancesResolved = {
      rows: balancesAll.rows.filter((r: Record<string, unknown>) => !!r.override_reason),
    };

    // Deposits pending — confirmed-ish jobs with no hire deposit recorded yet.
    const depositsPending = await query(
      `SELECT jf.job_id, j.hh_job_number, j.job_name,
              COALESCE(j.client_name, j.company_name) AS client_name,
              j.pipeline_status, j.job_date, j.out_date,
              jf.hire_value_inc_vat, jf.total_hire_deposits, jf.last_synced_at
       FROM job_financials jf
       JOIN jobs j ON j.id = jf.job_id
       WHERE COALESCE(jf.total_hire_deposits, 0) <= 0.01
         AND jf.hire_value_inc_vat > 0.01
         AND COALESCE(j.pipeline_status, '') IN ('confirmed', 'prepping', 'prepped')
       ORDER BY j.out_date ASC NULLS LAST
       LIMIT 200`
    );

    // Excess held — from the canonical v_excess_held view (single source of
    // truth: max(taken+held−claims−reimburse,0), rolled_over/released/not_required
    // excluded). amount_taken/amount_held kept for the per-row breakdown display.
    const excessHeld = await query(
      `SELECT je.id AS excess_id, je.job_id, j.hh_job_number,
              COALESCE(j.client_name, j.company_name) AS client_name,
              je.excess_status,
              COALESCE(je.excess_amount_taken, 0) AS amount_taken,
              COALESCE(je.amount_held, 0) AS amount_held,
              h.held_amount,
              COALESCE(j.return_date, j.job_end) AS finished_on,
              (COALESCE(j.return_date, j.job_end) < CURRENT_DATE) AS hire_finished
       FROM v_excess_held h
       JOIN job_excess je ON je.id = h.excess_id
       LEFT JOIN jobs j ON j.id = je.job_id
       WHERE h.held_amount > 0.01
       ORDER BY COALESCE(j.return_date, j.job_end) ASC NULLS LAST
       LIMIT 200`
    );

    // Pending refunds — cancellation IOUs awaiting processing, across all jobs.
    const pendingRefunds = await query(
      `SELECT jp.id, jp.job_id, j.hh_job_number,
              COALESCE(j.client_name, j.company_name) AS client_name,
              jp.amount, jp.notes, jp.payment_date
       FROM job_payments jp
       LEFT JOIN jobs j ON j.id = jp.job_id
       WHERE jp.payment_type = 'refund' AND jp.payment_status = 'pending'
       ORDER BY jp.payment_date ASC
       LIMIT 200`
    );

    const sum = (rows: Array<Record<string, unknown>>, col: string) =>
      rows.reduce((acc, r) => acc + parseFloat(String(r[col] ?? 0)), 0);

    // Split excess held into "for upcoming/active hires" (legit to hold) vs
    // "past hire end" (should mostly be reimbursed/rolled over — the
    // actionable backlog). Records with no linked job date count as upcoming.
    let excessHeldUpcoming = 0, excessHeldPast = 0, excessUpcomingCount = 0, excessPastCount = 0;
    for (const r of excessHeld.rows as Array<Record<string, unknown>>) {
      const amt = parseFloat(String(r.held_amount ?? 0));
      if (r.hire_finished === true) { excessHeldPast += amt; excessPastCount++; }
      else { excessHeldUpcoming += amt; excessUpcomingCount++; }
    }

    res.json({
      data: {
        balances_outstanding: balances.rows,
        balances_resolved: balancesResolved.rows,
        deposits_pending: depositsPending.rows,
        excess_held: excessHeld.rows,
        pending_refunds: pendingRefunds.rows,
        totals: {
          balance_outstanding: sum(balances.rows, 'balance_outstanding'),
          balances_count: balances.rows.length,
          balances_resolved_total: sum(balancesResolved.rows, 'balance_outstanding'),
          balances_resolved_count: balancesResolved.rows.length,
          deposits_pending_count: depositsPending.rows.length,
          excess_held: excessHeldUpcoming + excessHeldPast,
          excess_held_count: excessHeld.rows.length,
          excess_held_upcoming: excessHeldUpcoming,
          excess_held_upcoming_count: excessUpcomingCount,
          excess_held_past: excessHeldPast,
          excess_held_past_count: excessPastCount,
          pending_refunds: sum(pendingRefunds.rows, 'amount'),
          pending_refunds_count: pendingRefunds.rows.length,
        },
      },
    });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error('[money] Overview error:', msg);
    res.status(500).json({ error: 'Failed to load money overview', detail: msg });
  }
});

// ── Balance override ("ignore this outstanding balance") — admin only ──
// Business-level resolution of an HH-derived hire balance that the business
// (via Xero) considers settled/written-off. Does NOT touch HireHop or Xero —
// pure OP annotation (migration 111). Excludes the job from the active
// /money/overview Balances Outstanding list + headline total.
const BALANCE_OVERRIDE_REASONS = [
  'xero_settled',        // payment applied in Xero, never fed back to HH
  'internal_discounted', // our own / 100%-discounted job not zeroed in HH
  'hh_xero_corrected',   // since-corrected HH↔Xero error still showing in HH
  'write_off',           // bad debt / goodwill
  'other',
] as const;

const resolveBalanceSchema = z.object({
  reason: z.enum(BALANCE_OVERRIDE_REASONS),
  notes: z.string().max(1000).nullable().optional(),
});

const bulkResolveSchema = z.object({
  reason: z.enum(BALANCE_OVERRIDE_REASONS),
  notes: z.string().max(1000).nullable().optional(),
  job_ids: z.array(z.string().uuid()).max(500).optional(),
  // YYYY-MM-DD — resolve every still-outstanding non-dead job that finished
  // before this date and isn't already overridden. For the old backlog sweep.
  finished_before: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
}).refine((d) => (d.job_ids && d.job_ids.length > 0) || d.finished_before, {
  message: 'Provide job_ids or finished_before',
});

// Resolve a :jobId param (OP UUID or HH job number) to the OP UUID.
async function resolveJobUuid(jobIdParam: string): Promise<string | null> {
  const isUuid = /^[0-9a-f]{8}-/.test(jobIdParam);
  if (isUuid) return jobIdParam;
  const r = await query(`SELECT id FROM jobs WHERE hh_job_number = $1`, [parseInt(jobIdParam)]);
  return r.rows[0]?.id ?? null;
}

// POST /api/money/:jobId/resolve-balance — flag a job's balance as resolved.
router.post('/:jobId/resolve-balance', authorize('admin'), validate(resolveBalanceSchema), async (req: AuthRequest, res: Response) => {
  try {
    const jobUuid = await resolveJobUuid(String(req.params.jobId));
    if (!jobUuid) { res.status(404).json({ error: 'Job not found' }); return; }
    const { reason, notes } = req.body;
    const result = await query(
      `INSERT INTO job_balance_overrides (job_id, reason, notes, resolved_by, resolved_at, updated_at)
       VALUES ($1, $2, $3, $4, NOW(), NOW())
       ON CONFLICT (job_id) DO UPDATE SET
         reason = EXCLUDED.reason, notes = EXCLUDED.notes,
         resolved_by = EXCLUDED.resolved_by, resolved_at = NOW(), updated_at = NOW()
       RETURNING *`,
      [jobUuid, reason, notes ?? null, req.user!.id]
    );
    await query(
      `INSERT INTO audit_log (user_id, entity_type, entity_id, action, after_json)
       VALUES ($1, 'jobs', $2, 'resolve_balance', $3::jsonb)`,
      [req.user!.id, jobUuid, JSON.stringify({ reason, notes: notes ?? null })]
    ).catch((e) => console.error('[money] audit_log insert failed (resolve_balance):', e));
    res.json({ data: result.rows[0], message: 'Balance marked as resolved' });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error('[money] resolve-balance error:', msg);
    res.status(500).json({ error: 'Failed to resolve balance', detail: msg });
  }
});

// DELETE /api/money/:jobId/resolve-balance — undo (un-resolve).
router.delete('/:jobId/resolve-balance', authorize('admin'), async (req: AuthRequest, res: Response) => {
  try {
    const jobUuid = await resolveJobUuid(String(req.params.jobId));
    if (!jobUuid) { res.status(404).json({ error: 'Job not found' }); return; }
    const result = await query(`DELETE FROM job_balance_overrides WHERE job_id = $1 RETURNING *`, [jobUuid]);
    if (result.rows.length === 0) { res.status(404).json({ error: 'No balance override on this job' }); return; }
    await query(
      `INSERT INTO audit_log (user_id, entity_type, entity_id, action, before_json)
       VALUES ($1, 'jobs', $2, 'unresolve_balance', $3::jsonb)`,
      [req.user!.id, jobUuid, JSON.stringify({ reason: result.rows[0].reason, notes: result.rows[0].notes })]
    ).catch((e) => console.error('[money] audit_log insert failed (unresolve_balance):', e));
    res.json({ message: 'Balance override removed' });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error('[money] unresolve-balance error:', msg);
    res.status(500).json({ error: 'Failed to remove balance override', detail: msg });
  }
});

// POST /api/money/balances/bulk-resolve — resolve many at once (multi-select or
// "everything finished before <date>"). For the old 2022/2023 backlog.
router.post('/balances/bulk-resolve', authorize('admin'), validate(bulkResolveSchema), async (req: AuthRequest, res: Response) => {
  try {
    const { reason, notes, job_ids, finished_before } = req.body;
    // Resolve the target set of OP UUIDs.
    let targetIds: string[] = [];
    if (job_ids && job_ids.length > 0) {
      targetIds = job_ids;
    } else if (finished_before) {
      const r = await query(
        `SELECT jf.job_id
         FROM job_financials jf
         JOIN jobs j ON j.id = jf.job_id
         LEFT JOIN job_balance_overrides o ON o.job_id = jf.job_id
         WHERE jf.balance_outstanding > 0.01
           AND COALESCE(j.pipeline_status, '') NOT IN ('lost', 'cancelled')
           AND o.job_id IS NULL
           AND COALESCE(j.return_date, j.job_end)::date < $1::date`,
        [finished_before]
      );
      targetIds = r.rows.map((row: { job_id: string }) => row.job_id);
    }
    if (targetIds.length === 0) { res.json({ resolved: 0, message: 'No matching jobs to resolve' }); return; }

    const result = await query(
      `INSERT INTO job_balance_overrides (job_id, reason, notes, resolved_by, resolved_at, updated_at)
       SELECT unnest($1::uuid[]), $2, $3, $4, NOW(), NOW()
       ON CONFLICT (job_id) DO UPDATE SET
         reason = EXCLUDED.reason, notes = EXCLUDED.notes,
         resolved_by = EXCLUDED.resolved_by, resolved_at = NOW(), updated_at = NOW()
       RETURNING job_id`,
      [targetIds, reason, notes ?? null, req.user!.id]
    );
    await query(
      `INSERT INTO audit_log (user_id, entity_type, entity_id, action, after_json)
       VALUES ($1, 'jobs', NULL, 'bulk_resolve_balance', $2::jsonb)`,
      [req.user!.id, JSON.stringify({ reason, notes: notes ?? null, count: result.rows.length, finished_before: finished_before ?? null })]
    ).catch((e) => console.error('[money] audit_log insert failed (bulk_resolve_balance):', e));
    res.json({ resolved: result.rows.length, message: `Resolved ${result.rows.length} balance(s)` });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error('[money] bulk-resolve error:', msg);
    res.status(500).json({ error: 'Failed to bulk-resolve balances', detail: msg });
  }
});

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

// Refund a hire payment (deposit/balance/other) from the Money tab. Closes the
// "OP first" loop for hire-side money — Stripe-paid deposits refund directly
// via the Stripe API, others record-keep only. Excess refunds go through
// /excess/:id/reimburse instead; this endpoint is hire-side only.
const refundPaymentSchema = z.object({
  hh_deposit_id: z.number().int().positive(),
  amount: z.number().min(0.01),
  method: z.enum(['stripe_gbp', 'worldpay', 'amex', 'wise_bacs', 'till_cash', 'paypal', 'lloyds_bank']),
  reference: z.string().max(255).nullable().optional(),
  notes: z.string().max(1000).nullable().optional(),
  // When set, an existing OP `job_payments` pending-refund IOU (e.g. created by
  // a cancellation) is marked completed instead of inserting a new refund row.
  pending_refund_id: z.number().int().positive().nullable().optional(),
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
              je.amount_held, je.amount_released,
              je.claim_amount, je.reimbursement_amount,
              je.reimbursement_date, je.reimbursement_method,
              je.held_at, je.held_expires_at, je.released_at,
              je.excess_status, je.excess_calculation_basis, je.payment_method,
              je.payment_reference, je.payment_date, je.hh_deposit_id,
              je.stripe_payment_intent_id,
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

    // Count self-drive vehicles (van count). Exclude 'swapped' as well as
    // 'cancelled' — a swapped-out van's assignment lingers with the old
    // vehicle_id, and counting it as a distinct van would inflate the
    // required excess (it's the same hire on a replacement van, not a
    // second van).
    const vanCountResult = await query(
      `SELECT COUNT(DISTINCT vehicle_id) AS van_count
       FROM vehicle_hire_assignments
       WHERE job_id = $1
         AND assignment_type = 'self_drive'
         AND status NOT IN ('cancelled', 'swapped')`,
      [job.id]
    );
    const vanCount = parseInt(vanCountResult.rows[0]?.van_count || '0');

    // Build per-driver breakdown
    const drivers = excessResult.rows.map((r: any) => {
      const required = parseFloat(r.excess_amount_required || 0);
      const taken = parseFloat(r.excess_amount_taken || 0);
      const held = parseFloat(r.amount_held || 0);
      const released = parseFloat(r.amount_released || 0);
      // Coverage = money in our account OR on hold. A pre-auth at full required
      // amount covers the requirement for dispatch purposes (we have collateral
      // even though no money has moved). excess_outstanding nets both off.
      const coverage = taken + held;
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
        // Resolution breakdown — surfaces what actually happened to collected
        // excess (claimed to invoice / reimbursed to client) on the Money tab
        // Insurance Excess card. Without these the card could only show
        // collected vs required, hiding the claim/reimburse split (job 15291).
        claim_amount: parseFloat(r.claim_amount || 0),
        reimbursement_amount: parseFloat(r.reimbursement_amount || 0),
        reimbursement_date: r.reimbursement_date,
        reimbursement_method: r.reimbursement_method,
        // Pre-auth lifecycle (migration 087) — held = on hold (not yet captured);
        // released = was held, then voided without capture (terminal info).
        amount_held: held,
        amount_released: released,
        held_at: r.held_at,
        held_expires_at: r.held_expires_at,
        released_at: r.released_at,
        stripe_payment_intent_id: r.stripe_payment_intent_id,
        excess_outstanding: Math.max(0, required - coverage),
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

    // Totals — collected = money in account + money on hold (migration 087).
    // Held money counts as collected for portal display purposes (client sees
    // their excess is covered, whether by pre-auth or captured payment).
    const totalRequired = drivers.reduce((sum: number, d: any) => sum + d.excess_amount_required, 0);
    const totalCollected = drivers.reduce((sum: number, d: any) => sum + d.excess_amount_taken + d.amount_held, 0);
    const totalOutstanding = Math.max(0, totalRequired - totalCollected);

    // A record is "covered" if it's in a terminal state (waived/reimbursed/claimed/rolled_over/not_required),
    // OR enough money has been taken/held to meet the required amount. This catches the edge case of a
    // pre-auth or 'taken' record that's underfunded (e.g. £600 pre-auth against £1,200 required).
    // Note: 'released' is not covered — the hold ended without capture, no money was kept.
    const terminalStatuses = ['waived', 'rolled_over', 'not_required', 'reimbursed', 'fully_claimed', 'partially_reimbursed'];
    const isCovered = (d: any) => {
      if (terminalStatuses.includes(d.excess_status)) return true;
      if (d.excess_status === 'released') return false; // hold ended, nothing kept
      const required = d.excess_amount_required || 0;
      const coverage = (d.excess_amount_taken || 0) + (d.amount_held || 0);
      return required > 0 && coverage >= required;
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
    // Excess refunds processed directly in HireHop — drives passive unwind of
    // the OP excess record so OP catches up to HH without staff intervention.
    // Closes the Pom Poko / RX22SWN-shape gap where a colleague refunds in HH
    // and then OP can't push (deposit already fully refunded → error 370).
    const hhExcessRefunds: Array<{
      hh_refund_row_id: number; amount: number; date: string;
      description: string | null; memo: string | null;
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
            } else if (isExcess && isRefund) {
              // HH-side excess refund — collect for passive unwind onto the
              // matching OP record (catches refunds done directly in HH).
              hhExcessRefunds.push({
                hh_refund_row_id: depositId,
                amount: absAmount,
                date: data.DATE || row.date || '',
                description: description || null,
                memo: memo || null,
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
              // A kind=3 row booked against a deposit (OWNER_DEPOSIT set) is one
              // of two things, distinguished by OWNER (the invoice it's applied to):
              //   • OWNER non-zero  → deposit applied to an invoice. Already counted
              //     in kind=6; tracked here for invoice reconciliation. (HH dual-
              //     publishes this with an invoice-side twin, deduped by data.ID.)
              //   • OWNER zero + negative credit → deposit REFUNDED to the client
              //     (money out). Subtract from deposit totals + surface as a refund.
              // Proven against job 15577 (application: OWNER=11648, INVOICE_NUMBER
              // set) vs job 16043 (refund: OWNER=0, INVOICE_NUMBER=""). Excess
              // kind=3 rows are left untouched here (handled by the excess flows).
              const appliedToInvoice = data.OWNER != null && parseInt(String(data.OWNER)) > 0;
              if (!isExcess && creditAmount < 0 && !appliedToInvoice) {
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
                totalHireDeposits -= absAmount;
              } else if (!isExcess) {
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

    // Pass 2: HH-side excess refunds → passive unwind on the linked OP record.
    // Catches the Pom Poko shape (staff issues refund in HH, OP never hears).
    // Each refund is dedup'd via the excess.refund_legs JSONB on the helper
    // side, so re-running the Money tab doesn't re-apply.
    if (hhExcessRefunds.length > 0 && job.id) {
      try {
        const { unwindRefundOnExcess } = await import('../services/excess-refund');
        // Pull the job's linked excess records (anything with hh_deposit_id set).
        const linked = await query(
          `SELECT id, hh_deposit_id, excess_status,
                  excess_amount_taken, reimbursement_amount, claim_amount
           FROM job_excess
           WHERE job_id = $1 AND hh_deposit_id IS NOT NULL
             AND excess_status NOT IN ('waived', 'rolled_over', 'released', 'reimbursed')`,
          [job.id]
        );
        // For each HH refund row, pick the best-matching linked record by
        // available cash; fall back to any linked record on the job. If
        // multiple records exist and amounts don't disambiguate, the dedup
        // key (`hh_refund_<rowId>`) still prevents double-apply.
        for (const refund of hhExcessRefunds) {
          if (linked.rows.length === 0) break;
          const byAmount = linked.rows.findIndex((r: any) => {
            const taken = parseFloat(r.excess_amount_taken || '0');
            const reimbursed = parseFloat(r.reimbursement_amount || '0');
            const claimed = parseFloat(r.claim_amount || '0');
            const remaining = taken - reimbursed - claimed;
            return Math.abs(remaining - refund.amount) < 0.01;
          });
          const target = byAmount !== -1 ? linked.rows[byAmount] : linked.rows[0];
          await unwindRefundOnExcess({
            excessId: target.id,
            amount: refund.amount,
            source: 'hh_reconcile',
            sourceRef: `hh_refund_${refund.hh_refund_row_id}`,
            method: null,
            notes: `HH refund row #${refund.hh_refund_row_id}${refund.description ? ` — ${refund.description}` : ''}`,
          }).catch((e) => console.error('[money] HH refund unwind failed (non-fatal):', e));
        }
      } catch (refundReconErr) {
        console.error('[money] HH refund passive reconciliation failed (non-fatal):', refundReconErr);
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

    // Enrich hire-deposit rows with the original Stripe PaymentIntent (when we
    // recorded one in job_payments). The frontend uses this to decide whether
    // OP can originate the refund via the Stripe API or whether it's a
    // record-keeping-only refund (BACS/cash). Best-effort — missing matches
    // just leave stripe_payment_intent undefined.
    if (deposits.length > 0 && job.id) {
      try {
        const hireDepIds = deposits.filter(d => !d.is_refund && d.id).map(d => d.id);
        if (hireDepIds.length > 0) {
          const opPayments = await query(
            `SELECT hirehop_deposit_id, stripe_payment_intent, payment_method
             FROM job_payments
             WHERE job_id = $1 AND hirehop_deposit_id = ANY($2)
               AND payment_type IN ('deposit', 'balance', 'other')`,
            [job.id, hireDepIds]
          );
          const byHhDep = new Map<number, { stripe_payment_intent: string | null; payment_method: string | null }>();
          for (const r of opPayments.rows) {
            byHhDep.set(r.hirehop_deposit_id, {
              stripe_payment_intent: r.stripe_payment_intent || null,
              payment_method: r.payment_method || null,
            });
          }
          for (const d of deposits) {
            if (d.is_refund) continue;
            const match = byHhDep.get(d.id);
            if (match) {
              (d as Record<string, unknown>).stripe_payment_intent = match.stripe_payment_intent;
              (d as Record<string, unknown>).op_payment_method = match.payment_method;
            }
          }
        }
      } catch (enrichErr) {
        console.error('[money] Deposit Stripe-PI enrichment failed (non-fatal):', enrichErr);
      }
    }

    // Pending refunds — OP-only `job_payments` IOUs (e.g. created by a
    // cancellation) awaiting processing. Surfaced so staff can action them from
    // the Money tab via POST /refund-payment with pending_refund_id. No HH/Stripe
    // link yet; the process step picks a deposit to refund against.
    let pendingRefunds: Array<{ id: number; amount: number; method: string | null; notes: string | null; date: string }> = [];
    if (job.id) {
      try {
        const pr = await query(
          `SELECT id, amount, payment_method, notes, payment_date
           FROM job_payments
           WHERE job_id = $1 AND payment_type = 'refund' AND payment_status = 'pending'
           ORDER BY payment_date DESC`,
          [job.id]
        );
        pendingRefunds = pr.rows.map((r: { id: number; amount: string; payment_method: string | null; notes: string | null; payment_date: string }) => ({
          id: r.id,
          amount: parseFloat(r.amount),
          method: r.payment_method || null,
          notes: r.notes || null,
          date: r.payment_date,
        }));
      } catch (e) {
        console.error('[money] Pending refunds fetch failed (non-fatal):', e);
      }
    }

    // Write-through cache for the global /money/overview dashboard. The figures
    // are already computed above; persist them to job_financials so the
    // dashboard can read OP only (no HH calls at page load). Best-effort —
    // never let a cache write break the Money tab. Pre-migration-108 envs
    // simply skip (undefined_table caught here).
    if (job.id) {
      query(
        `INSERT INTO job_financials
           (job_id, hire_value_inc_vat, total_hire_deposits, balance_outstanding, vat_saved, last_synced_at)
         VALUES ($1, $2, $3, $4, $5, NOW())
         ON CONFLICT (job_id) DO UPDATE SET
           hire_value_inc_vat  = EXCLUDED.hire_value_inc_vat,
           total_hire_deposits = EXCLUDED.total_hire_deposits,
           balance_outstanding = EXCLUDED.balance_outstanding,
           vat_saved           = EXCLUDED.vat_saved,
           last_synced_at      = NOW()`,
        [job.id, effectiveHireValueIncVat, totalHireDeposits, effectiveBalanceOutstanding, vatAdjustment ? vatAdjustment.vatSaved : 0]
      ).catch((e) => console.error('[money] job_financials write-through failed (non-fatal):', e.message));
    }

    // Business-level balance override (admin flagged the HH balance as settled
    // in Xero / written off — migration 111). Surfaced as a banner on the Money
    // tab; the live HH balance above is still shown (staff source of truth).
    const overrideResult = await query(
      `SELECT o.reason, o.notes, o.resolved_at, u.name AS resolved_by_name
       FROM job_balance_overrides o
       LEFT JOIN users u ON u.id = o.resolved_by
       WHERE o.job_id = $1`,
      [job.id]
    );
    const balanceOverride = overrideResult.rows[0] ?? null;

    res.json({
      data: {
        job: {
          id: job.id,
          hh_job_number: hhJobId,
          client_name: job.client_name || job.company_name,
        },
        financial: {
          balance_override: balanceOverride,
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
          pending_refunds: pendingRefunds,
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

// ── POST /api/money/:jobId/refund-payment — Refund a hire payment ──
//
// OP-first refund flow for hire payments (deposits, balances, etc.). Mirrors
// the excess /:id/reimburse flow but on the hire-side: looks up the original
// HH deposit, finds the matching OP `job_payments` row (for the Stripe PI),
// calls Stripe → posts negative HH payment application → records in OP.
//
// Stripe-paid deposits: OP originates the refund directly. Other methods (BACS,
// cash, etc.) record-keep only — the real-world money movement happens off
// system. The frontend Refund button is hidden on rows that are already a
// refund leg (HH `credit < 0`).
//
// For excess refunds, use /excess/:id/reimburse instead — that path is wired
// into the `refund_legs` dedup ledger and excess email templates.
router.post('/:jobId/refund-payment', validate(refundPaymentSchema), async (req: AuthRequest, res: Response) => {
  try {
    const jobId = String(req.params.jobId);
    const { hh_deposit_id, amount, method, reference, notes, pending_refund_id } = req.body;

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

    // Look up the matching OP job_payments row — gives us the Stripe PI and
    // original amount for validation. Best-effort: HH-originating deposits
    // may not have an OP row, in which case we just record-keep against HH.
    const opPaymentRes = await query(
      `SELECT id, amount, stripe_payment_intent, payment_method, payment_type
       FROM job_payments
       WHERE job_id = $1 AND hirehop_deposit_id = $2
         AND payment_type IN ('deposit', 'balance', 'other')
       ORDER BY payment_date DESC LIMIT 1`,
      [job.id, hh_deposit_id]
    );
    const originalPayment: { id: number; amount: string; stripe_payment_intent: string | null; payment_method: string; payment_type: string } | null = opPaymentRes.rows[0] || null;
    let stripePaymentIntent = originalPayment?.stripe_payment_intent || null;

    // Validate amount against the original (when we know it). Allow up to the
    // original — staff records partial refunds by calling this endpoint twice.
    if (originalPayment) {
      const originalAmount = parseFloat(originalPayment.amount);
      const alreadyRefundedRes = await query(
        `SELECT COALESCE(SUM(amount), 0) AS refunded
         FROM job_payments
         WHERE job_id = $1 AND hirehop_deposit_id = $2 AND payment_type = 'refund'`,
        [job.id, hh_deposit_id]
      );
      const alreadyRefunded = parseFloat(alreadyRefundedRes.rows[0].refunded || '0');
      const refundable = originalAmount - alreadyRefunded;
      if (amount > refundable + 0.005) {
        res.status(400).json({
          error: 'Refund amount exceeds available',
          detail: `Original: £${originalAmount.toFixed(2)}, already refunded: £${alreadyRefunded.toFixed(2)}, available: £${refundable.toFixed(2)}, requested: £${amount.toFixed(2)}`,
        });
        return;
      }
    }

    // If processing an existing pending IOU, validate it belongs to this job and
    // is still pending BEFORE we move any money (Stripe/HH), so a bad id can't
    // leave a real refund recorded against nothing.
    if (pending_refund_id) {
      const pendingCheck = await query(
        `SELECT id FROM job_payments
         WHERE id = $1 AND job_id = $2 AND payment_type = 'refund' AND payment_status = 'pending'`,
        [pending_refund_id, job.id]
      );
      if (pendingCheck.rows.length === 0) {
        res.status(404).json({ error: 'Pending refund not found, not on this job, or already processed' });
        return;
      }
    }

    // ── PaymentIntent recovery (Stripe refunds) ──────────────────────────────
    // Deposits taken via the payment portal / recorded straight in HireHop often
    // have NO OP job_payments row carrying the Stripe PaymentIntent — the pi_
    // lives only in the HH deposit's memo ("Stripe: https://…/payments/pi_…").
    // Without this, a stripe_gbp refund found no PI and silently fell back to
    // record-only (job 15197 incident: client never actually refunded in Stripe
    // while OP/HH/Xero showed it done). Recover the pi_ from the HH deposit memo
    // so the refund actually hits Stripe.
    if (method === 'stripe_gbp' && !stripePaymentIntent && job.hh_job_number) {
      try {
        const billing = await hhBroker.get('/php_functions/billing_list.php',
          { main_id: job.hh_job_number, type: 1 }, { priority: 'high', cacheTTL: 60 });
        const rows = ((billing.data as { rows?: Array<Record<string, any>> } | null)?.rows) || [];
        const depRow = rows.find((r) => parseInt(String(r?.data?.ID ?? '0')) === Number(hh_deposit_id));
        const memo = String(depRow?.data?.MEMO || '');
        const m = memo.match(/pi_[A-Za-z0-9]+/);
        if (m) {
          stripePaymentIntent = m[0];
          console.log(`[money] Recovered Stripe PI ${stripePaymentIntent} from HH deposit ${hh_deposit_id} memo`);
        }
      } catch (e) {
        console.error('[money] PI recovery from HH memo failed (non-fatal):', e instanceof Error ? e.message : e);
      }
    }

    // Loud-fail: a stripe_gbp refund with no recoverable PaymentIntent must NOT
    // silently record-only — that's how job 15197 looked "done" while the money
    // never moved. Stop before any HH/Xero paperwork and tell staff to refund in
    // Stripe directly (then record here under the actual rail if they want the
    // paperwork). Non-Stripe methods are unaffected — they're record-only by design.
    if (method === 'stripe_gbp' && !stripePaymentIntent) {
      res.status(422).json({
        error: 'No Stripe PaymentIntent found for this deposit',
        detail: 'This is marked as a Stripe refund but OP can\'t find the original Stripe PaymentIntent — neither on the OP payment record nor in the HireHop deposit memo. Refund it directly in the Stripe dashboard. (Picking a non-Stripe method here records the paperwork only and does not move money.)',
      });
      return;
    }

    // ── Step 0: Stripe refund (only when method=stripe_gbp + PI on the row) ──
    let stripeRefundId: string | null = null;
    const stripeRefundPath = method === 'stripe_gbp' && stripePaymentIntent;
    if (stripeRefundPath) {
      if (!isStripeConfigured()) {
        res.status(503).json({ error: 'Stripe not configured' });
        return;
      }
      try {
        const stripe = getStripeClient();
        const refund = await stripe.refunds.create({
          payment_intent: stripePaymentIntent as string,
          amount: Math.round(amount * 100),
        });
        stripeRefundId = refund.id;
        console.log(`[money] Stripe refund created: ${refund.id} (£${amount.toFixed(2)} on PI ${stripePaymentIntent})`);
      } catch (err) {
        const msg = isStripeError(err) ? err.message : (err instanceof Error ? err.message : 'Unknown error');
        console.error('[money] Stripe refund failed:', msg);
        res.status(502).json({ error: 'Stripe refund failed', detail: msg });
        return;
      }
    }

    // ── Step 1: Push negative HH payment application against the deposit ──
    let hhPushError: string | null = null;
    let hhPaymentAppId: number | null = null;
    if (job.hh_job_number) {
      try {
        const currentDate = new Date().toISOString().split('T')[0];
        const hhBankId = HH_BANK_IDS[method] || 265;
        const description = `${job.hh_job_number} - Refund${originalPayment?.payment_type ? ' (' + originalPayment.payment_type + ')' : ''}`;
        const memo = `Hire payment refund — via ${method.replace(/_/g, ' ')}${reference ? ` (ref: ${reference})` : ''} (recorded via Ooosh OP)`;
        const hhResult = await hhBroker.post('/php_functions/billing_payments_save.php', {
          id: 0,
          date: currentDate,
          desc: description,
          paid: amount,
          memo,
          bank: hhBankId,
          OWNER: 0,
          deposit: hh_deposit_id,
          no_webhook: 1,
        }, { priority: 'high' });
        if (!hhResult.success || !hhResult.data) {
          const errText = hhResult.error || 'HireHop did not accept the payment application';
          if (stripeRefundPath) {
            hhPushError = `Stripe refund processed, but HireHop paperwork push failed: ${errText}. Please retry the HH push manually or contact engineering.`;
            console.error('[money] HH refund push failed after Stripe success:', errText);
          } else {
            res.status(502).json({ error: 'HireHop refund failed', detail: errText });
            return;
          }
        } else {
          hhPaymentAppId = (hhResult.data as { hh_id?: number; id?: number; ID?: number }).hh_id
            ?? (hhResult.data as { hh_id?: number; id?: number; ID?: number }).id
            ?? (hhResult.data as { hh_id?: number; id?: number; ID?: number }).ID
            ?? null;
        }
      } catch (hhErr) {
        const msg = hhErr instanceof Error ? hhErr.message : String(hhErr);
        if (stripeRefundPath) {
          hhPushError = `Stripe refund processed, but HireHop push threw: ${msg}.`;
          console.error('[money] HH refund push threw after Stripe success:', msg);
        } else {
          res.status(502).json({ error: 'HireHop push error', detail: msg });
          return;
        }
      }
    }

    // ── Step 2: Record in OP job_payments as a refund leg ──
    const auditNotes = [
      reference ? `Ref: ${reference}` : null,
      notes || null,
      stripeRefundId ? `Stripe refund ${stripeRefundId}` : null,
      hhPaymentAppId ? `HH payment app ${hhPaymentAppId}` : null,
    ].filter(Boolean).join(' — ');

    // For refund rows: payment_reference carries the Stripe refund id (when
    // present) so the webhook can dedup against it. The original PI stays on
    // stripe_payment_intent for cross-reference.
    const refundReferenceCol = stripeRefundId || reference || null;

    let opResult;
    if (pending_refund_id) {
      // Processing an existing pending IOU (e.g. a cancellation refund). Mark it
      // completed in place rather than inserting a duplicate. The validity guard
      // above already confirmed it belongs to this job and is still pending.
      opResult = await query(
        `UPDATE job_payments SET
           payment_status      = 'completed',
           amount              = $2,
           payment_method      = $3,
           payment_reference   = $4,
           stripe_payment_intent = $5,
           hirehop_job_id      = $6,
           hirehop_deposit_id  = $7,
           source              = 'op',
           notes               = $8,
           payment_date        = NOW(),
           recorded_by         = $9
         WHERE id = $1
         RETURNING *`,
        [
          pending_refund_id,
          amount,
          method,
          refundReferenceCol,
          stripePaymentIntent || null,
          job.hh_job_number,
          hh_deposit_id,
          auditNotes || null,
          req.user!.id,
        ]
      );
    } else {
      opResult = await query(
        `INSERT INTO job_payments
          (job_id, hirehop_job_id, payment_type, amount, payment_method,
           payment_reference, stripe_payment_intent, payment_status, source,
           hirehop_deposit_id, client_name, notes, payment_date, recorded_by)
         VALUES ($1, $2, 'refund', $3, $4, $5, $6, 'completed', 'op', $7, $8, $9, NOW(), $10)
         RETURNING *`,
        [
          job.id,
          job.hh_job_number,
          amount,
          method,
          refundReferenceCol,
          stripePaymentIntent || null,
          hh_deposit_id,
          job.client_name,
          auditNotes || null,
          req.user!.id,
        ]
      );
    }

    // ── Step 3: Trigger Xero sync (best-effort — HH push already succeeded, so
    // OP and HH are in sync. Without this the refund lands in HH billing but
    // never posts through to Xero. Mirrors the excess reimburse path. ────────
    if (hhPaymentAppId) {
      try {
        await hhBroker.post('/php_functions/accounting/tasks.php', {
          hh_package_type: 1,
          hh_acc_package_id: 3,
          hh_task: 'post_payment',
          hh_id: hhPaymentAppId,
          hh_acc_id: '',
        }, { priority: 'high' });
        console.log('[money] Xero sync triggered for hire refund payment application');
      } catch (e) {
        console.error('[money] Xero sync for hire refund failed (non-fatal — payment posted, sync may catch up later):', e);
      }
    }

    console.log(`[money] Hire refund recorded: £${amount} on job ${job.id} via ${method}${stripeRefundId ? ` (Stripe ${stripeRefundId})` : ''}${hhPushError ? ' [HH push failed]' : ''}`);
    res.json({
      data: opResult.rows[0],
      ...(stripeRefundId ? { stripe_refund_id: stripeRefundId } : {}),
      ...(hhPaymentAppId ? { hh_payment_application_id: hhPaymentAppId } : {}),
      ...(hhPushError ? { hh_push_error: hhPushError } : {}),
    });
  } catch (error) {
    console.error('[money] Refund payment error:', error);
    res.status(500).json({ error: 'Failed to refund payment' });
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
        // Pre-auth lifecycle (migration 087): money is HELD, not TAKEN. Populate
        // amount_held, held_at, held_expires_at (5-day standard window across
        // Stripe + card-machine), and stripe_payment_intent_id (used by the
        // capture/release endpoints to address the hold via Stripe API).
        // excess_amount_taken stays at 0 — that column means money in our
        // account, which a pre-auth is not.
        await query(
          `UPDATE job_excess SET
            amount_held = $1,
            excess_amount_taken = 0,
            excess_status = 'pre_auth',
            held_at = NOW(),
            held_expires_at = NOW() + INTERVAL '5 days',
            stripe_payment_intent_id = COALESCE($5, stripe_payment_intent_id),
            payment_method = $2,
            payment_reference = $3,
            payment_date = NOW(),
            updated_at = NOW()
          WHERE id = $4`,
          [amount, effectiveMethod, payment_reference || null, resolvedExcessId, stripe_payment_intent || null]
        );
        console.log(`[money] Excess ${resolvedExcessId} set to pre_auth (£${amount} held, expires in 5 days)`);
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

    // ── Refund unwind: when the portal tells us about a refund, auto-flip
    // the matching OP excess record to reimbursed/partially_reimbursed so
    // staff don't have to repeat the action manually. Idempotent across
    // sources (portal + Stripe webhook can both fire for one refund).
    // Only acts when there's a clear excess linkage — generic hire-fee
    // refunds (payment_type='refund' with no excess_id) fall through. ──
    if ((effectivePaymentType === 'excess_refund' ||
         (effectivePaymentType === 'refund' && (excess_id || stripe_payment_intent)))) {
      try {
        const { unwindRefundOnExcess, findExcessByStripePI } = await import('../services/excess-refund');
        let targetExcessId = excess_id || null;
        if (!targetExcessId && stripe_payment_intent) {
          const ex = await findExcessByStripePI(stripe_payment_intent);
          if (ex) targetExcessId = ex.id;
        }
        if (targetExcessId) {
          const result = await unwindRefundOnExcess({
            excessId: targetExcessId,
            amount,
            source: 'payment_event',
            sourceRef: payment_reference || stripe_payment_intent || null,
            method: effectiveMethod,
            notes: `via payment-event from ${effectiveSource}`,
          });
          if (result.updated) {
            console.log(`[money] Refund auto-unwound on excess ${targetExcessId} → ${result.newStatus}`);
          } else {
            console.log(`[money] Refund unwind skipped on excess ${targetExcessId}: ${result.reason}`);
          }
        } else {
          console.log(`[money] Refund event on job ${job.id} — no matching excess record to unwind`);
        }
      } catch (err) {
        console.error('[money] Refund unwind failed (non-fatal, payment-event):', err);
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
