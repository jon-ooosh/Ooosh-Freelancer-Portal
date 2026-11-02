/**
 * Cost Capture & Recharge — Phase 1 foundation (backend API).
 *
 * Staff capture costs/receipts; each `costs` row is the financial spine that
 * can carry job / vehicle / freelancer / issue / service-log facets, feed a
 * client recharge (flag-and-confirm), and run a payables approval workflow.
 *
 * Xero sync, AI extraction, and the frontend land in later PRs — this route
 * owns the data model and the financial workflow. See
 * docs/COST-CAPTURE-RECHARGE-SPEC.md.
 */
import { Router, Response } from 'express';
import { z } from 'zod';
import multer from 'multer';
import { query } from '../config/database';
import { authenticate, authorize, AuthRequest, STAFF_ROLES, isManagerTier } from '../middleware/auth';
import { resolveRemittanceContact, getCostForRemittance, sendRemittance } from '../services/remittance';
import { fetchCostLines, validateCostLines, replaceCostLines, headerVatFromLines, type CostLineInput } from '../services/cost-lines';
import { listFreelancerWork, getInvoiceTolerance, planWorkLinks, writeWorkLinks, WorkLinkError, type WorkLinkRow } from '../services/freelancer-work';
import { suggestInvoicePerson, personIdByEmail } from '../services/freelancer-invoice-person';
import { fullDisplayName } from '../services/display-name';
import { retireDoneBells } from '../services/notification-resolve';
import { planAllocations, writeAllocations, AllocationError, type AllocationInput } from '../services/cost-allocations';
import {
  TERMINAL_RECHARGE, loadRecharge, updateRecharge, hasPerJobRecharges, PER_JOB_ALREADY,
  wholeCostAlready, type RechargeTarget,
} from '../services/cost-recharges';

const router = Router();
router.use(authenticate);
// Staff only — a no-op today (only staff hold a staff token) but it keeps this
// router closed if a non-staff login shape is ever added (Oct 2026 audit).
router.use(authorize(...STAFF_ROLES));

// Multer for the AI-extract endpoint — same 10MB limit as the generic file
// uploader; accepts images + PDF (the receipts staff actually capture).
const extractUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
});

// Manager+ can verify AND approve a payable (incl. one-click "Approve & save");
// only admin can mark paid (money actually leaving + the Xero payment).
const VERIFY_ROLES = ['admin', 'manager'] as const;
const ADMIN_ONLY = ['admin'] as const;

// Curated staff-facing Xero account codes for the cost-capture category picker.
// Ordered as they appear in the dropdown. Names are pulled live from Xero — this
// is just the allowlist of which codes staff routinely code costs to.
const STAFF_COST_ACCOUNT_CODES = [
  '320', // Crew (freelance invoices)
  '325', // Crew costs (bus / taxi)
  '326', // Sub hire of equipment
  '399', // PCNs / fines (usually recharged)
  '406', // Vehicle upkeep (servicing, parts)
  '409', // Vehicle repairs (bodywork, windscreens)
  '473', // Equipment upkeep (amp repairs, spares)
  '310', // Shop stock
  '410', // Fuel
  '411', // Parking
  '425', // Postage / courier
  '429', // Anything else not covered
  '494', // General office expenses (milk, cleaning)
  '710', // Office equipment
  '720', // Computer equipment
  '764', // New equipment (backline / staging)
];

// ── Schemas ─────────────────────────────────────────────────────────────────

const COST_TYPES = ['overhead', 'job', 'vehicle', 'stock', 'parts', 'freelancer_invoice'] as const;
const PAYMENT_METHODS = [
  'cot_card', 'amex', 'lloyds_cc', 'petty_cash', 'paypal', 'wise', 'lloyds_transfer',
  'reimburse_me', 'not_yet_paid',
] as const;
// Pay-later methods land as an authorised ACCPAY bill on approval (vs Spend Money).
const BILL_METHODS = ['not_yet_paid', 'reimburse_me'] as const;
const PAYMENT_STATUSES = ['paid', 'awaiting_payment', 'awaiting_invoice'] as const;
const RECHARGE_MODES = ['none', 'full', 'partial'] as const;
// Xero account codes that count as "running costs" for the recharge auto-inherit
// on recharge-running-costs jobs: Fuel (410), Parking (411), Travel (325).
const RUNNING_COST_CODES = new Set(['410', '411', '325']);

const money = z.number().nonnegative().finite();

// Xero allows 10 attachments per object and the main receipt takes one of them,
// so a cost may carry at most 9 supporting documents.
const MAX_SUPPORTING_DOCUMENTS = 9;

// One cost line. Shared by the create/update payload and PUT /:id/lines so the
// two can't drift.
const costLineInputSchema = z.object({
  description: z.string().trim().max(2000).optional().nullable(),
  amount_gross: money,
  amount_vat: money.optional().nullable(),
  xero_account_code: z.string().trim().max(20).optional().nullable(),
  job_id: z.string().uuid().optional().nullable(),
  crew_fronted: z.boolean().optional(),
  source: z.enum(['manual', 'ai']).optional(),
});

// One job's share of a cost (cost_allocations). Shared by PUT /:id/allocations
// and the create / update payload, so the two can't drift.
const allocationItemSchema = z.object({
  // An existing share, kept (and updated) rather than replaced, so a recharge
  // it carries survives an edit to the split. Omitted = a new share.
  id: z.string().uuid().optional(),
  job_id: z.string().uuid().optional().nullable(),
  quote_assignment_id: z.string().uuid().optional().nullable(),
  amount: money,
  recharge: z.boolean().optional(),
  notes: z.string().trim().max(2000).optional().nullable(),
  // Who pays for THIS job's share (migration 318). Omitted = leave the share
  // as it is (a new share: no recharge, and the cost's own quote/extra answer).
  cost_intent: z.enum(['quote_actual', 'extra']).optional().nullable(),
  recharge_mode: z.enum(RECHARGE_MODES).optional(),
  recharge_amount: money.optional().nullable(),
});

const createSchema = z.object({
  supplier_name: z.string().trim().max(200).optional().nullable(),
  cost_date: z.string().trim().max(20).optional().nullable(),
  amount_gross: money.optional().nullable(),
  amount_vat: money.optional().nullable(),
  amount_net: money.optional().nullable(),
  vat_treatment: z.enum(['standard', 'reclaim_split']).optional(),
  invoice_number: z.string().trim().max(100).optional().nullable(),
  // Staff override for the bill due date. NULL/'' = follow the derived rule
  // (supplier terms, or the freelancer Friday rule). See resolveDueDate().
  due_date_override: z.string().trim().max(20).optional().nullable(),
  // Xero contact id captured when staff pick a real Xero supplier in the
  // autocomplete — lets terms resolve by stable id + seed from Xero.
  xero_contact_id: z.string().trim().max(60).optional().nullable(),
  currency: z.string().trim().length(3).optional(),
  description: z.string().trim().max(10000).optional().nullable(),
  category: z.string().trim().max(100).optional().nullable(),
  xero_account_code: z.string().trim().max(20).optional().nullable(),
  cost_type: z.enum(COST_TYPES).optional(),
  payment_method: z.enum(PAYMENT_METHODS).optional().nullable(),
  cot_card_holder: z.string().trim().max(120).optional().nullable(),
  cot_card_last4: z.string().trim().max(4).optional().nullable(),
  payment_status: z.enum(PAYMENT_STATUSES).optional(),
  job_id: z.string().uuid().optional().nullable(),
  vehicle_id: z.string().uuid().optional().nullable(),
  quote_assignment_id: z.string().uuid().optional().nullable(),
  job_issue_id: z.string().uuid().optional().nullable(),
  vehicle_service_log_id: z.string().uuid().optional().nullable(),
  vehicle_fuel_log_id: z.string().uuid().optional().nullable(),
  recharge_mode: z.enum(RECHARGE_MODES).optional(),
  recharge_amount: money.optional().nullable(),
  cost_intent: z.enum(['quote_actual', 'extra']).optional().nullable(),
  receipt_r2_key: z.string().trim().max(500).optional().nullable(),
  receipt_filename: z.string().trim().max(200).optional().nullable(),
  // Supporting evidence filed alongside the main receipt. Sent whole (idempotent
  // replace) — the modal always posts the full list, so a removal is just a
  // shorter array. Capped at MAX_SUPPORTING_DOCUMENTS so one cost can't blow the
  // Xero per-object attachment limit.
  supporting_documents: z.array(z.object({
    r2_key: z.string().trim().min(1).max(500),
    filename: z.string().trim().min(1).max(200),
    content_type: z.string().trim().max(200).optional().nullable(),
    size_bytes: z.number().int().nonnegative().optional().nullable(),
    uploaded_at: z.string().trim().max(40).optional().nullable(),
    uploaded_by: z.string().uuid().optional().nullable(),
  })).max(MAX_SUPPORTING_DOCUMENTS).optional(),
  status: z.enum(['draft', 'confirmed', 'resolved']).optional(),
  notes: z.string().trim().max(10000).optional().nullable(),
  // A credit — money coming BACK from a supplier (refund / card credit note).
  // The amount is sent as a POSITIVE magnitude like any other; the server
  // stores it negative. See services/cost-credit.ts for the one sign rule.
  is_credit: z.boolean().optional(),
  // The purchase it came back from. Optional: a refund for something never
  // captured in OP is still worth recording.
  refund_of_cost_id: z.string().uuid().optional().nullable(),

  // Control flag (not a column): one-click "Approve & save" on a payable.
  // Honoured only for admin/manager + a payable; ignored otherwise.
  approve: z.boolean().optional(),

  // Cost lines. Written in the same request as the header so the background
  // Xero push (fired immediately below) sees them — a separate PUT would race
  // it and push a one-line bill. See services/cost-lines.ts.
  lines: z.array(costLineInputSchema).max(50).optional(),

  // A freelancer invoice: WHOSE it is, and WHICH of their work it covers
  // (FREELANCER-PORTAL-SPEC §5). `work_items` is not a column: when sent it
  // replaces the cost's cost_work_items (keys from GET /costs/freelancer-work).
  person_id: z.string().uuid().optional().nullable(),
  work_items: z.array(z.object({
    key: z.string().trim().min(3).max(80),
    amount: money,
  })).max(200).optional(),
  // Why it was saved with no work ticked (migration 315). Cleared server-side
  // whenever work is ticked.
  work_unmatched_reason: z.enum(['person_not_in_op', 'work_not_in_op', 'later']).optional().nullable(),
  // The job split, saved with the cost (not a column). When sent it replaces the
  // cost's split; an empty array clears it. See services/cost-allocations.ts.
  allocations: z.array(allocationItemSchema).max(100).optional(),
});

// Update accepts the same fields, all optional.
const updateSchema = createSchema.partial();

const rechargeSchema = z.object({
  recharge_mode: z.enum(['full', 'partial']),
  recharge_amount: money.optional().nullable(),
});

const allocationSchema = z.object({
  // Empty array clears the split (deletes all allocations for the cost).
  allocations: z.array(allocationItemSchema),
});

// Columns a staff member may set directly via create/update (whitelist —
// workflow timestamps + Xero state are server-controlled).
const WRITABLE = [
  'supplier_name', 'cost_date', 'amount_gross', 'amount_vat', 'amount_net', 'vat_treatment',
  'invoice_number', 'due_date_override', 'xero_contact_id', 'currency',
  'description', 'category', 'xero_account_code', 'cost_type', 'payment_method',
  'cot_card_holder', 'cot_card_last4', 'payment_status', 'job_id', 'vehicle_id',
  'quote_assignment_id', 'job_issue_id', 'vehicle_service_log_id', 'vehicle_fuel_log_id',
  // The freelancer a freelancer invoice is from (FREELANCER-PORTAL-SPEC §5),
  // and why no work is ticked on it, when none is.
  'person_id', 'work_unmatched_reason',
  'recharge_mode', 'recharge_amount', 'recharge_status', 'cost_intent', 'receipt_r2_key', 'receipt_filename',
  'supporting_documents', 'status', 'notes',
  // Credits — money coming back. The SIGN is applied by applyCreditSign()
  // (services/cost-credit.ts), never by a caller. See migration 229.
  'is_credit', 'refund_of_cost_id',
] as const;

// ⚠️ node-postgres sends a JS array as a Postgres ARRAY literal ({"..."}), which
// JSONB rejects — and an EMPTY array survives, so the bug only shows once
// someone actually attaches something. Stringify before the generic column loop
// writes it. Same lesson as JSONB_FIELDS in driver-verification.
function serialiseJsonbForWrite(data: Record<string, unknown>) {
  if (data.supporting_documents !== undefined) {
    data.supporting_documents = JSON.stringify(data.supporting_documents ?? []);
  }
}

// A quote_actual cost is already billed via its quote — it can never carry a
// recharge. Coerce recharge off server-side (defence-in-depth; the modal also
// disables the controls) so a stale recharge flag can't slip a double-bill through.
function coerceRechargeForIntent(data: Record<string, unknown>) {
  if (data.cost_intent === 'quote_actual') {
    data.recharge_mode = 'none';
    data.recharge_amount = null;
  }
}

// Keep recharge_status in step with recharge_mode on the generic create/update
// path. The terminal states (recharged_hh / recharged_external / absorbed) are
// only ever set by the push/resolve endpoints — here we only toggle between
// 'pending' (flagged) and NULL (not a recharge). recharge_status is stripped from
// user input by the Zod schemas, so this is the only thing that sets it on write.
function deriveRechargeStatusForWrite(data: Record<string, unknown>, current?: string | null) {
  if (data.recharge_mode === undefined) return; // recharge not being touched
  if (data.recharge_mode === 'none') {
    data.recharge_status = null;
  } else if (!current || !TERMINAL_RECHARGE.has(current)) {
    // Flagging (or re-flagging) for recharge and not already resolved → pending.
    data.recharge_status = 'pending';
  }
}

// `RETURNING *` gives the raw costs row — no hh_job_number / job_name / vehicle_reg,
// because those live on the joined tables. Callers hand that row straight to the
// UI (the capture form's job rows), which
// then had nothing to print and fell back to "(linked job)" / "(captured job)".
// Enrich the row with the display fields the list query already exposes so the
// real job number is shown wherever a saved cost is rendered.
async function withJobLabels<T extends { id?: string; job_id?: string | null; vehicle_id?: string | null; person_id?: string | null }>(row: T): Promise<T> {
  if (!row || (!row.job_id && !row.vehicle_id && !row.person_id)) return row;
  try {
    const r = await query(
      `SELECT j.hh_job_number, j.job_name, fv.reg AS vehicle_reg,
              fp.first_name AS fp_first, fp.last_name AS fp_last, fp.preferred_name AS fp_pref
         FROM costs c
         LEFT JOIN jobs j ON j.id = c.job_id
         LEFT JOIN fleet_vehicles fv ON fv.id = c.vehicle_id
         LEFT JOIN people fp ON fp.id = c.person_id
        WHERE c.id = $1`,
      [row.id],
    );
    return r.rows.length ? { ...row, ...withPersonName(r.rows[0]) } : row;
  } catch {
    return row; // display sugar only — never fail a save over it
  }
}

/**
 * The Recharges tab's `rc_*` columns, folded into one `recharge` object (the
 * recharge this row is about: the whole cost, or one job's share). Rows without
 * them pass through untouched.
 */
function withRechargeRef<R extends Record<string, unknown>>(r: R): R {
  if (!('rc_recharge_mode' in r)) return r;
  const out: Record<string, unknown> = {};
  const recharge: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(r)) {
    if (k.startsWith('rc_')) recharge[k.slice(3)] = v;
    else out[k] = v;
  }
  out.recharge = recharge;
  return out as R;
}

/** A freelancer invoice's freelancer, by name (from fp_* columns a query selected). */
function withPersonName<R extends Record<string, unknown>>(r: R): R & { person_name: string | null } {
  const { fp_first, fp_last, fp_pref, ...rest } = r as Record<string, unknown>;
  const name = fp_first || fp_last
    ? fullDisplayName({ first_name: fp_first as string, last_name: fp_last as string, preferred_name: fp_pref as string | null }) || null
    : null;
  return { ...(rest as R), person_name: name };
}

async function audit(userId: string, costId: string, action: string, prev: unknown, next: unknown) {
  try {
    await query(
      `INSERT INTO audit_log (user_id, entity_type, entity_id, action, previous_values, new_values)
       VALUES ($1, 'cost', $2, $3, $4, $5)`,
      [userId, costId, action, JSON.stringify(prev ?? {}), JSON.stringify(next ?? {})],
    );
  } catch (err) {
    console.warn('[costs] audit log failed (non-fatal):', (err as Error).message);
  }
}

// ── List ──────────────────────────────────────────────────────────────────
// view: all | payable | recharge | reconcile

router.get('/', async (req: AuthRequest, res: Response) => {
  try {
    const { view, cost_type, status, payment_status, job_id, vehicle_id, search, missing_receipt, mine, recharge_status, limit = '200' } = req.query;

    const conditions: string[] = [];
    const params: unknown[] = [];
    // The Recharges tab lists RECHARGES, not costs: one row per job a recharge
    // bills (v_cost_recharges, migration 318), so a split cost recharged to three
    // jobs is three rows. Each row is the cost as it is, plus a `recharge` object
    // for that job: the cost's own columns are never overwritten, because the
    // edit button hands this row straight to the capture form.
    const rechargeView = view === 'recharge';

    // COT receipt chase: company-card costs with no receipt attached. `mine`
    // scopes to the logged-in card-holder (used by the chase notification link).
    if (missing_receipt === '1' || missing_receipt === 'true') {
      conditions.push(`c.payment_method = 'cot_card' AND c.receipt_r2_key IS NULL`);
    }
    if ((mine === '1' || mine === 'true') && req.user?.id) {
      params.push(req.user.id);
      conditions.push(`c.uploaded_by = $${params.length}`);
    }

    if (view === 'payable') {
      conditions.push(`c.payment_status <> 'paid'`);
    } else if (rechargeView) {
      // Default = pending (flagged, not yet resolved). A recharge_status param
      // ('all' or a specific terminal state) drives the absorb/recharged audit slice.
      // The view holds only flagged recharges, so 'all' needs no condition.
      if (recharge_status === 'all') {
        // every recharge, resolved or not
      } else if (typeof recharge_status === 'string' && recharge_status) {
        params.push(recharge_status);
        conditions.push(`r.recharge_status = $${params.length}`);
      } else {
        conditions.push(`r.is_pending`);
      }
    } else if (view === 'reconcile') {
      conditions.push(`c.payment_method = 'cot_card' AND c.xero_sync_state <> 'reconciled'`);
    }

    if (typeof cost_type === 'string' && cost_type) {
      params.push(cost_type);
      conditions.push(`c.cost_type = $${params.length}`);
    }
    if (typeof status === 'string' && status) {
      params.push(status);
      conditions.push(`c.status = $${params.length}`);
    }
    if (typeof payment_status === 'string' && payment_status) {
      params.push(payment_status);
      conditions.push(`c.payment_status = $${params.length}`);
    }
    if (typeof job_id === 'string' && job_id) {
      params.push(job_id);
      // On the Recharges tab, the job the recharge BILLS.
      conditions.push(`${rechargeView ? 'r' : 'c'}.job_id = $${params.length}`);
    }
    if (typeof vehicle_id === 'string' && vehicle_id) {
      params.push(vehicle_id);
      conditions.push(`c.vehicle_id = $${params.length}`);
    }
    if (typeof search === 'string' && search) {
      params.push(`%${search}%`);
      conditions.push(`(c.supplier_name ILIKE $${params.length} OR c.description ILIKE $${params.length})`);
    }

    const whereClause = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const fromClause = rechargeView
      ? 'FROM v_cost_recharges r JOIN costs c ON c.id = r.cost_id'
      : 'FROM costs c';
    // How many rows MATCH, before the limit trims them. The page sums what it
    // has been sent to show a filtered total, and that sum is only honest if it
    // knows whether it is holding the whole set — a money figure that quietly
    // omits row 201 is worse than no figure at all.
    const filterParams = [...params];
    params.push(Math.min(parseInt(limit as string, 10) || 200, 500));

    const sql = `
      SELECT c.*,
        CONCAT(up.first_name, ' ', up.last_name) AS uploaded_by_name,
        j.hh_job_number, j.job_name,
        fv.reg AS vehicle_reg,
        -- Money that came back against this purchase, and (on a credit) what it
        -- came back from. Both are display only — the netting itself needs
        -- nothing, because a credit IS a negative row. See migration 229.
        COALESCE((SELECT SUM(ABS(k.amount_gross)) FROM costs k
                   WHERE k.refund_of_cost_id = c.id AND k.is_credit), 0)::numeric AS refunded_total,
        pc.supplier_name AS refund_parent_supplier,
        pc.invoice_number AS refund_parent_invoice,
        pc.cost_date AS refund_parent_date,
        (SELECT COUNT(*)::int FROM cost_allocations a WHERE a.cost_id = c.id) AS allocation_count,
        (SELECT COALESCE(json_agg(json_build_object(
                  'job_id', a.job_id, 'hh_job_number', aj.hh_job_number,
                  'job_name', aj.job_name, 'amount', a.amount,
                  'recharge_mode', a.recharge_mode, 'recharge_status', a.recharge_status
                ) ORDER BY a.created_at), '[]'::json)
           FROM cost_allocations a
           LEFT JOIN jobs aj ON aj.id = a.job_id
          WHERE a.cost_id = c.id) AS allocation_jobs,
        -- A freelancer invoice's freelancer and how much of their work it is
        -- linked to (FREELANCER-PORTAL-SPEC §5).
        fp.first_name AS fp_first, fp.last_name AS fp_last, fp.preferred_name AS fp_pref,
        (SELECT COUNT(*)::int FROM cost_work_items w WHERE w.cost_id = c.id) AS work_item_count,
        -- What that work is, for the list's "1 job · 3 nights": HireHop jobs
        -- reached through ticked bookings (a run's stops on one job count once),
        -- studio evenings, yard days.
        (SELECT json_build_object(
                  'jobs', COUNT(DISTINCT q.job_id),
                  'nights', COUNT(w.sitter_assignment_id),
                  'days', COUNT(w.day_booking_id))
           FROM cost_work_items w
           LEFT JOIN quote_assignments qa ON qa.id = w.quote_assignment_id
           LEFT JOIN quotes q ON q.id = qa.quote_id
          WHERE w.cost_id = c.id) AS work_summary
        ${rechargeView ? `,
        r.allocation_id AS rc_allocation_id, r.job_id AS rc_job_id,
        rj.hh_job_number AS rc_hh_job_number, rj.job_name AS rc_job_name,
        r.cost_intent AS rc_cost_intent, r.recharge_mode AS rc_recharge_mode,
        r.recharge_amount AS rc_recharge_amount, r.recharge_status AS rc_recharge_status,
        r.recharge_base_amount AS rc_recharge_base_amount,
        r.recharge_markup_type AS rc_recharge_markup_type, r.recharge_markup_value AS rc_recharge_markup_value,
        r.recharge_resolution_note AS rc_recharge_resolution_note, r.recharge_resolved_at AS rc_recharge_resolved_at,
        r.recharged_to_hh_at AS rc_recharged_to_hh_at,
        r.share_gross AS rc_share_gross, r.share_net AS rc_share_net` : ''}
      ${fromClause}
      ${rechargeView ? 'LEFT JOIN jobs rj ON rj.id = r.job_id' : ''}
      LEFT JOIN users u   ON u.id = c.uploaded_by
      LEFT JOIN people up ON up.id = u.person_id
      LEFT JOIN jobs j    ON j.id = c.job_id
      LEFT JOIN fleet_vehicles fv ON fv.id = c.vehicle_id
      LEFT JOIN costs pc ON pc.id = c.refund_of_cost_id
      LEFT JOIN people fp ON fp.id = c.person_id
      ${whereClause}
      ORDER BY c.created_at DESC${rechargeView ? ', rj.hh_job_number NULLS FIRST, r.allocation_id NULLS FIRST' : ''}
      LIMIT $${params.length}
    `;
    const result = await query(sql, params);

    // Resolve per-supplier payment terms in one query and attach the computed
    // due date (+ the terms that produced it) to each row. Single source of
    // truth for the bill due date — the list, mark-paid modal and Xero push all
    // read these. See docs/COSTS-PAYMENT-AUTOMATION-SPEC.md.
    const { buildTermsResolver, resolveDueDate, getFreelancerApprovalRuleFrom } = await import('../services/supplier-terms');
    const resolve = await buildTermsResolver(
      result.rows.map((r) => ({ xeroContactId: r.xero_contact_id, supplierName: r.supplier_name })),
    );
    const approvalRuleFrom = await getFreelancerApprovalRuleFrom();
    const rows = result.rows.map((r) => {
      // resolveDueDate picks the rule (staff override → freelancer Friday terms →
      // supplier terms) — don't branch on cost_type out here, or this list drifts
      // from the Xero push again.
      const { dueDate, derivedDueDate, terms, isOverride } = resolveDueDate(
        r,
        resolve({ xeroContactId: r.xero_contact_id, supplierName: r.supplier_name }),
        approvalRuleFrom,
      );
      return { ...withPersonName(withRechargeRef(r)), terms, due_date: dueDate, due_date_derived: derivedDueDate, due_date_is_override: isOverride };
    });

    // Headline counts for the hub tabs.
    const stats = await query(`
      SELECT
        COUNT(*) FILTER (WHERE payment_status <> 'paid')::int AS payable,
        (SELECT COUNT(*)::int FROM v_cost_recharges WHERE is_pending) AS recharge_pending,
        COUNT(*) FILTER (WHERE payment_method = 'cot_card' AND xero_sync_state <> 'reconciled')::int AS reconcile_pending,
        COALESCE(SUM(amount_gross) FILTER (WHERE payment_status <> 'paid'), 0)::numeric AS payable_total
      FROM costs
    `);

    const matching = await query(`SELECT COUNT(*)::int AS n ${fromClause} ${whereClause}`, filterParams);

    res.json({ data: rows, stats: stats.rows[0], total_matching: matching.rows[0].n });
  } catch (err) {
    console.error('[costs] list error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── Facet lookups ───────────────────────────────────────────────────────────

async function listBy(column: string, value: string, res: Response, extra?: Record<string, unknown>) {
  const result = await query(
    `SELECT c.*, CONCAT(up.first_name, ' ', up.last_name) AS uploaded_by_name,
            EXISTS (SELECT 1 FROM v_cost_recharges r WHERE r.cost_id = c.id AND r.is_pending) AS has_pending_recharge
     FROM costs c
     LEFT JOIN users u ON u.id = c.uploaded_by
     LEFT JOIN people up ON up.id = u.person_id
     WHERE c.${column} = $1
     ORDER BY c.created_at DESC`,
    [value],
  );
  // Outstanding = anything not fully resolved (powers the close-out flag).
  // A recharge is unresolved while flagged but still 'pending' (not pushed to HH,
  // billed externally, or absorbed) — the whole cost's, or any job's share of it.
  const outstanding = result.rows.filter(
    (r) => r.status !== 'resolved'
      || r.has_pending_recharge === true
      || r.payment_status !== 'paid',
  ).length;
  res.json({ data: result.rows, outstanding, ...(extra || {}) });
}

// A job's cost figure is ALLOCATION-AWARE (the single read that honours the
// cost_allocations attribution layer — see docs/COST-CAPTURE-RECHARGE-SPEC.md).
//   (A) costs captured on this job with NO allocations → full amount_gross
//   (B) allocations TO this job (cost captured anywhere) → the allocation amount
// A cost that HAS allocations is attributed purely by its allocations, so it
// only surfaces here via (B) — never both. This prevents the double-count that
// let a split £150 invoice still read as £150 on its capture job while nothing
// landed on the other job (the bug this fixes). The remainder of an
// under-allocated cost (allocations summing to less than gross) is unattributed
// "our cost" and correctly surfaces on no job.
//
// Each row's `amount_gross` is REPLACED with this job's effective share so every
// downstream consumer (MoneyTab JobCostsPanel, capture-modal jobSummary) works
// unchanged. `full_amount_gross` keeps the true cost total; `is_allocation`
// flags a split-in row (rendered distinctly).
//
// A split-in row also carries THIS job's own quote/extra answer and recharge
// (migration 318), so the Money tab files and recharges the share where it
// belongs. `share_net` is what a recharge of the row would start from.
// `recharged_as_whole` marks a split cost that is recharged as one (the old way,
// on its own job): its shares can't be recharged separately as well.
router.get('/by-job/:jobId', async (req: AuthRequest, res: Response) => {
  try {
    const jobId = String(req.params.jobId);
    const jf = await query('SELECT recharge_running_costs FROM jobs WHERE id = $1', [jobId]);

    const result = await query(
      `SELECT c.*, CONCAT(up.first_name, ' ', up.last_name) AS uploaded_by_name,
              capj.hh_job_number AS capture_hh_job_number,
              NULL::numeric AS alloc_amount, NULL::boolean AS alloc_recharge,
              NULL::text AS alloc_notes, NULL::uuid AS allocation_id, false AS is_allocation,
              NULL::varchar AS alloc_cost_intent, NULL::varchar AS alloc_recharge_mode,
              NULL::numeric AS alloc_recharge_amount, NULL::varchar AS alloc_recharge_status,
              NULL::timestamptz AS alloc_recharged_to_hh_at,
              c.amount_net::numeric AS share_net
         FROM costs c
         LEFT JOIN users u ON u.id = c.uploaded_by
         LEFT JOIN people up ON up.id = u.person_id
         LEFT JOIN jobs capj ON capj.id = c.job_id
        WHERE c.job_id = $1
          AND NOT EXISTS (SELECT 1 FROM cost_allocations a WHERE a.cost_id = c.id)
       UNION ALL
       SELECT c.*, CONCAT(up.first_name, ' ', up.last_name) AS uploaded_by_name,
              capj.hh_job_number AS capture_hh_job_number,
              a.amount AS alloc_amount, a.recharge AS alloc_recharge,
              a.notes AS alloc_notes, a.id AS allocation_id, true AS is_allocation,
              a.cost_intent AS alloc_cost_intent, a.recharge_mode AS alloc_recharge_mode,
              a.recharge_amount AS alloc_recharge_amount, a.recharge_status AS alloc_recharge_status,
              a.recharged_to_hh_at AS alloc_recharged_to_hh_at,
              cost_share_net(a.amount, c.amount_gross, c.amount_net) AS share_net
         FROM cost_allocations a
         JOIN costs c ON c.id = a.cost_id
         LEFT JOIN users u ON u.id = c.uploaded_by
         LEFT JOIN people up ON up.id = u.person_id
         LEFT JOIN jobs capj ON capj.id = c.job_id
        WHERE a.job_id = $1
       ORDER BY created_at DESC`,
      [jobId],
    );

    // Lines, so the Money tab can bucket a bundled invoice by what each part
    // actually was rather than dumping the whole thing under the header's
    // category. One query for the lot — a cost with no lines simply gets none,
    // which is the overwhelmingly common case.
    const costIds = [...new Set(result.rows.map((r) => r.id))];
    const linesByCost = new Map<string, unknown[]>();
    if (costIds.length) {
      const lr = await query(
        `SELECT cost_id, line_no, description, amount_gross, amount_vat,
                xero_account_code, job_id, crew_fronted
           FROM cost_lines WHERE cost_id = ANY($1::uuid[]) ORDER BY line_no ASC`,
        [costIds],
      );
      for (const l of lr.rows) {
        if (!linesByCost.has(l.cost_id)) linesByCost.set(l.cost_id, []);
        linesByCost.get(l.cost_id)!.push(l);
      }
    }

    const rows = result.rows.map((row) => {
      const {
        alloc_cost_intent, alloc_recharge_mode, alloc_recharge_amount, alloc_recharge_status,
        alloc_recharged_to_hh_at, ...r
      } = row;
      const fullGross = r.amount_gross;
      const effective = r.is_allocation ? r.alloc_amount : r.amount_gross;
      // This job's own answer on a split-in row; the cost's on a whole one.
      const share = r.is_allocation
        ? {
            cost_intent: alloc_cost_intent ?? r.cost_intent,
            recharge_mode: alloc_recharge_mode ?? 'none',
            recharge_amount: alloc_recharge_amount,
            recharge_status: alloc_recharge_status,
            recharged_to_hh_at: alloc_recharged_to_hh_at,
            recharged_as_whole: (r.recharge_mode ?? 'none') !== 'none',
          }
        : { recharged_as_whole: false };
      return {
        ...r,
        ...share,
        amount_gross: effective,        // this job's share (drives all sums)
        full_amount_gross: fullGross,   // the cost's true total
        allocation_recharge: r.alloc_recharge,
        allocation_notes: r.alloc_notes,
        // Only on a whole-cost row. A split-in row is a SHARE of someone else's
        // payable, so its lines describe a total this job doesn't carry —
        // bucketing by them here would overstate the job.
        lines: r.is_allocation ? [] : (linesByCost.get(r.id) ?? []),
      };
    });

    // Outstanding (close-out flag) is computed over costs genuinely captured
    // against this job — allocation-in rows are another job's payable, tracked
    // there. Preserves pre-allocation behaviour for the common (unsplit) case.
    // The one exception is a share's OWN recharge to this job: billing it is
    // this job's to do, so a pending one counts here.
    const pendingRecharge = (r: { recharge_mode?: string | null; recharge_status?: string | null }) =>
      (r.recharge_mode ?? 'none') !== 'none' && (r.recharge_status ?? 'pending') === 'pending';
    const outstanding = rows.filter(
      (r) => (!r.is_allocation && (
        r.status !== 'resolved'
        || pendingRecharge(r)
        || r.payment_status !== 'paid'
      )) || (r.is_allocation && pendingRecharge(r)),
    ).length;

    res.json({ data: rows, outstanding, recharge_running_costs: jf.rows[0]?.recharge_running_costs ?? false });
  }
  catch (err) { console.error('[costs] by-job error:', err); res.status(500).json({ error: 'Internal server error' }); }
});

router.get('/by-vehicle/:vehicleId', async (req: AuthRequest, res: Response) => {
  try { await listBy('vehicle_id', req.params.vehicleId as string, res); }
  catch (err) { console.error('[costs] by-vehicle error:', err); res.status(500).json({ error: 'Internal server error' }); }
});

router.get('/by-issue/:issueId', async (req: AuthRequest, res: Response) => {
  try { await listBy('job_issue_id', req.params.issueId as string, res); }
  catch (err) { console.error('[costs] by-issue error:', err); res.status(500).json({ error: 'Internal server error' }); }
});

// De-dup check: has this supplier + invoice number already been captured?
// Non-blocking — the modal warns, staff decides. Excludes a given cost id (so
// editing a cost doesn't flag itself). Multi-segment so it doesn't hit /:id.
router.get('/check-invoice', async (req: AuthRequest, res: Response) => {
  try {
    const invoiceNumber = String(req.query.invoice_number || '').trim();
    const supplier = String(req.query.supplier_name || '').trim();
    const excludeId = req.query.exclude_id ? String(req.query.exclude_id) : null;
    if (!invoiceNumber) { res.json({ data: { duplicate: false } }); return; }
    const r = await query(
      `SELECT id, supplier_name, amount_gross, cost_date, payment_status
       FROM costs
       WHERE invoice_number = $1
         AND ($2 = '' OR LOWER(COALESCE(supplier_name, '')) = LOWER($2))
         AND ($3::uuid IS NULL OR id <> $3::uuid)
       ORDER BY created_at DESC
       LIMIT 1`,
      [invoiceNumber, supplier, excludeId]
    );
    res.json({ data: { duplicate: r.rows.length > 0, match: r.rows[0] || null } });
  } catch (err) {
    console.error('[costs] check-invoice error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// De-dup check, the other kind: has this RECEIPT already been added? Fuel and
// till receipts rarely carry an invoice number (the reader is told to leave it
// blank), so the invoice-number check above never sees the commonest duplicate:
// the same fuel receipt uploaded twice, or a card cost typed in and then
// snapped. Same amount to the penny + same date + same supplier (the Xero
// contact when both have one, else the name as supplier-match normalises it).
// Warn only (jon, Oct 2026): two vans can pay the same £10 at the same car park.
router.get('/check-duplicate', async (req: AuthRequest, res: Response) => {
  try {
    const amount = Number(req.query.amount_gross);
    const date = String(req.query.cost_date || '').slice(0, 10);
    const supplier = String(req.query.supplier_name || '').trim();
    const contactId = String(req.query.xero_contact_id || '').trim();
    const excludeId = typeof req.query.exclude_id === 'string' && /^[0-9a-f-]{36}$/i.test(req.query.exclude_id) ? req.query.exclude_id : null;
    // "Did my save land?" — the phone, after a save that got no reply, asks by the
    // photo it uploaded (unique per upload), whatever the supplier was.
    const receiptKey = typeof req.query.receipt_r2_key === 'string' ? req.query.receipt_r2_key.slice(0, 500) : '';
    if (receiptKey) {
      const k = await query(
        `SELECT c.id, c.supplier_name, c.amount_gross, c.cost_date::text AS cost_date, c.description,
                c.payment_method, true AS has_receipt, c.receipt_r2_key
           FROM costs c WHERE c.receipt_r2_key = $1 LIMIT 3`,
        [receiptKey],
      );
      res.json({ data: { duplicates: k.rows } });
      return;
    }
    if (!(amount > 0) || !/^\d{4}-\d{2}-\d{2}$/.test(date) || (!supplier && !contactId)) {
      res.json({ data: { duplicates: [] } });
      return;
    }
    const r = await query(
      `SELECT c.id, c.supplier_name, c.xero_contact_id, c.amount_gross, c.cost_date::text AS cost_date,
              c.description, c.payment_method, c.receipt_r2_key IS NOT NULL AS has_receipt,
              -- The phone, after a save that got no reply, looks for its own photo
              -- here to learn whether the save landed (never a blind re-send).
              c.receipt_r2_key,
              CONCAT(up.first_name, ' ', up.last_name) AS uploaded_by_name
         FROM costs c
         LEFT JOIN users u ON u.id = c.uploaded_by
         LEFT JOIN people up ON up.id = u.person_id
        WHERE c.cost_date = $1::date
          AND ROUND(c.amount_gross * 100) = $2
          AND NOT COALESCE(c.is_credit, false)
          AND ($3::uuid IS NULL OR c.id <> $3::uuid)
        ORDER BY c.created_at DESC
        LIMIT 20`,
      [date, Math.round(amount * 100), excludeId],
    );
    const { normaliseSupplierName } = await import('../services/supplier-match');
    const wanted = supplier ? normaliseSupplierName(supplier) : '';
    const duplicates = r.rows.filter((c) => (contactId && c.xero_contact_id
      ? c.xero_contact_id === contactId
      : Boolean(wanted) && normaliseSupplierName(c.supplier_name || '') === wanted))
      .slice(0, 3)
      .map(({ xero_contact_id: _drop, ...rest }) => rest);
    res.json({ data: { duplicates } });
  } catch (err) {
    console.error('[costs] check-duplicate error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// "Which job?" on the phone (docs/design/cost-capture-redesign/DECISIONS.md, PR 3):
// the jobs that had a van out around a receipt's date, so a fuel or parking
// receipt is one tap from its job. A van counts from two days before its hire to
// two days after (filled before it went, topped up when it came back); a van
// swapped out stops at the swap. `reg` puts that van's job first (the AI read it
// off the receipt); `search` keeps only jobs whose van reg contains it (typing a
// reg into the job search). Each job comes with its van rows, so the phone picks
// the van on the day with the same rule as the laptop (costJobs.ts vansOnDate()).
// Assignments meet jobs by the dual match: staff allocations carry only the
// HireHop number until a hire form lands.
router.get('/van-jobs', async (req: AuthRequest, res: Response) => {
  try {
    const { ukToday } = await import('../services/uk-date');
    const raw = String(req.query.date || '').slice(0, 10);
    const date = /^\d{4}-\d{2}-\d{2}$/.test(raw) ? raw : ukToday();
    const norm = (v: unknown) => String(v || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
    const reg = norm(req.query.reg);
    const search = norm(req.query.search);
    const r = await query(
      `WITH rows AS (
         SELECT j.id AS job_id, vha.vehicle_id, fv.reg, vha.status, vha.swapped_at,
                COALESCE(vha.hire_start, (j.out_date AT TIME ZONE 'Europe/London')::date,
                         (j.job_date AT TIME ZONE 'Europe/London')::date) AS starts,
                COALESCE(CASE WHEN vha.status = 'swapped' THEN (vha.swapped_at AT TIME ZONE 'Europe/London')::date END,
                         vha.hire_end, (j.job_end AT TIME ZONE 'Europe/London')::date) AS ends,
                regexp_replace(upper(fv.reg), '[^A-Z0-9]', '', 'g') AS reg_norm
           FROM vehicle_hire_assignments vha
           JOIN jobs j ON (vha.job_id = j.id OR vha.hirehop_job_id = j.hh_job_number)
           JOIN fleet_vehicles fv ON fv.id = vha.vehicle_id
          WHERE vha.status <> 'cancelled'
            AND j.is_deleted = false
            AND j.pipeline_status NOT IN ('lost', 'cancelled')
       )
       SELECT j.id, j.hh_job_number, j.job_name, COALESCE(j.company_name, j.client_name) AS client,
              COALESCE(j.recharge_running_costs, false) AS recharge_running_costs,
              json_agg(DISTINCT jsonb_build_object(
                'vehicle_id', r.vehicle_id, 'vehicle_reg', r.reg, 'status', r.status,
                'hire_start', r.starts, 'hire_end', r.ends, 'swapped_at', r.swapped_at)) AS vans,
              bool_or($2 <> '' AND r.reg_norm = $2) AS reg_match,
              bool_or(r.starts <= $1::date AND (r.ends IS NULL OR r.ends >= $1::date)) AS on_day,
              MIN(ABS(COALESCE(r.starts, $1::date) - $1::date)) AS distance
         FROM rows r
         JOIN jobs j ON j.id = r.job_id
        WHERE (r.starts IS NULL OR r.starts <= $1::date + 2)
          AND (r.ends IS NULL OR r.ends >= $1::date - 2)
          AND ($3 = '' OR r.reg_norm LIKE '%' || $3 || '%')
        GROUP BY j.id
        ORDER BY reg_match DESC, on_day DESC, distance ASC, j.hh_job_number DESC
        LIMIT 15`,
      [date, reg, search],
    );
    res.json({ data: r.rows.map((x) => ({ ...x, distance: Number(x.distance) })) });
  } catch (err) {
    console.error('[costs] van-jobs error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Due-date preview for the capture modal — what the rules WOULD give for a
// cost that doesn't exist yet, so staff see the derived date at upload time and
// can correct it. Same engine as the list / get-one / Xero push, so the number
// shown here is the number that lands. Multi-segment so it doesn't hit /:id.
// ── Freelancer invoices: whose, and which work (FREELANCER-PORTAL-SPEC §5) ──
// Both before GET /:id, which would otherwise take the path as an id.

// "Whose invoice?": a suggestion from the letterhead (remembered → previous
// remittance address → one freelancer by name). Staff confirm it.
router.get('/freelancer-person-suggest', async (req: AuthRequest, res: Response) => {
  try {
    const name = typeof req.query.supplier_name === 'string' ? req.query.supplier_name.slice(0, 200) : '';
    const costId = typeof req.query.cost_id === 'string' && /^[0-9a-f-]{36}$/i.test(req.query.cost_id) ? req.query.cost_id : null;
    res.json({ data: await suggestInvoicePerson(name, costId) });
  } catch (err) {
    console.error('[costs] freelancer-person-suggest error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// "Which jobs?": the person's finished work (12 months), each with the fee they
// were booked at and the quote's expense estimate, plus whatever is already
// linked to `cost_id`. Work already on another invoice only with include_invoiced=1.
router.get('/freelancer-work', async (req: AuthRequest, res: Response) => {
  try {
    const personId = typeof req.query.person_id === 'string' ? req.query.person_id : '';
    if (!/^[0-9a-f-]{36}$/i.test(personId)) { res.status(400).json({ error: 'person_id is required' }); return; }
    const costId = typeof req.query.cost_id === 'string' && /^[0-9a-f-]{36}$/i.test(req.query.cost_id) ? req.query.cost_id : null;
    const includeInvoiced = req.query.include_invoiced === '1' || req.query.include_invoiced === 'true';
    const [items, tolerance] = await Promise.all([
      listFreelancerWork(personId, { costId, includeInvoiced }),
      getInvoiceTolerance(),
    ]);
    res.json({ data: { items, tolerance } });
  } catch (err) {
    console.error('[costs] freelancer-work error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.get('/due-date-preview', async (req: AuthRequest, res: Response) => {
  try {
    const { resolveDueDateForCost } = await import('../services/supplier-terms');
    const { dueDate, terms } = await resolveDueDateForCost({
      cost_type: req.query.cost_type ? String(req.query.cost_type) : null,
      cost_date: req.query.cost_date ? String(req.query.cost_date) : null,
      // An existing cost's approval time, so a freelancer invoice previews from
      // the day it was approved rather than "as if approved today".
      approved_at: req.query.approved_at ? String(req.query.approved_at) : null,
      supplier_name: req.query.supplier_name ? String(req.query.supplier_name) : null,
      xero_contact_id: req.query.xero_contact_id ? String(req.query.xero_contact_id) : null,
    });
    res.json({ data: { due_date: dueDate, terms } });
  } catch (err) {
    console.error('[costs] due-date-preview error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Default recharge markup config (ex VAT) — drives the resolve modal's
// pre-filled suggestion. Multi-segment so it doesn't collide with /:id below.
router.get('/recharge-defaults', async (_req: AuthRequest, res: Response) => {
  try {
    const { getRechargeMarkupDefaults } = await import('../services/cost-recharge-markup');
    res.json({ data: await getRechargeMarkupDefaults() });
  } catch (err) {
    console.error('[costs] recharge-defaults error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── Xero diagnostics (Custom Connection) ─────────────────────────────────────
// Lets staff verify the Xero creds the moment they're set in .env, before any
// of the sync/bill-create flows land. Multi-segment paths so they don't collide
// with /:id below.

router.get('/xero/health', authorize(...VERIFY_ROLES), async (_req: AuthRequest, res: Response) => {
  try {
    const { xeroBroker } = await import('../services/xero-broker');
    const health = await xeroBroker.health();
    res.json({ data: health });
  } catch (err) {
    console.error('[costs] xero health error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Reconcile probe — "what's on the COT card in Xero that ISN'T in OP".
// Reads SPEND bank transactions on the mapped COT bank account over a window
// and flags which have a matching OP cost (by pushed BankTransactionID, else by
// amount + near date). Doubles as the verification tool for the Codat→Xero feed:
// if this returns transactions, OP can read the COT card and matching is viable;
// if it returns nothing, the card's purchases aren't landing as readable
// BankTransactions (they're sitting as raw, unreconciled statement lines) and we
// need a different route. Read-only, admin/manager.
router.get('/reconcile/xero-cot', authorize(...VERIFY_ROLES), async (req: AuthRequest, res: Response) => {
  try {
    const { isXeroConfigured } = await import('../config/xero');
    if (!isXeroConfigured()) {
      return res.status(503).json({ error: 'Xero not configured (XERO_CLIENT_ID / XERO_CLIENT_SECRET missing)' });
    }
    const { getSystemSetting } = await import('./system-settings');
    const accountId = await getSystemSetting('xero_bank_cot_card');
    if (!accountId) {
      return res.json({
        data: { configured: false, message: 'No Xero bank account mapped for the COT card. Set it in Settings → Xero Bank Accounts (the "Company card (COT)" row) first.' },
      });
    }

    const days = Math.min(Math.max(parseInt(String(req.query.days ?? '30'), 10) || 30, 1), 180);
    const start = new Date(); start.setUTCDate(start.getUTCDate() - days);
    const y = start.getUTCFullYear(), m = start.getUTCMonth() + 1, d = start.getUTCDate();
    const where = `BankAccount.AccountID==Guid("${accountId}") AND Type=="SPEND" AND Date>=DateTime(${y},${m},${d})`;

    const { xeroBroker } = await import('../services/xero-broker');
    const raw = await xeroBroker.getBankTransactions(where);

    // Parse the fields we need, defensively (Xero Date can be /Date(ms)/ or ISO).
    const parseXeroDate = (v: unknown): string | null => {
      if (typeof v !== 'string') return null;
      const ms = v.match(/\/Date\((\d+)/);
      if (ms) return new Date(parseInt(ms[1], 10)).toISOString().slice(0, 10);
      const t = Date.parse(v);
      return Number.isNaN(t) ? null : new Date(t).toISOString().slice(0, 10);
    };
    type XTxn = { BankTransactionID?: string; Date?: string; Total?: number; Reference?: string; IsReconciled?: boolean; Status?: string; Contact?: { Name?: string } };
    const txns = (raw as XTxn[]).map((t) => ({
      bank_transaction_id: t.BankTransactionID ?? null,
      date: parseXeroDate(t.Date),
      total: typeof t.Total === 'number' ? t.Total : Number(t.Total ?? 0),
      reference: t.Reference ?? null,
      contact_name: t.Contact?.Name ?? null,
      is_reconciled: t.IsReconciled === true,
      status: t.Status ?? null,
    }));

    // OP costs to match against: anything pushed (xero_object_id) + every COT
    // card cost in the window (for amount/date fallback matching).
    const opRows = (await query(
      `SELECT id, xero_object_id, amount_gross, cost_date, supplier_name
         FROM costs
        WHERE xero_object_id IS NOT NULL
           OR (payment_method = 'cot_card' AND cost_date >= (CURRENT_DATE - ($1 || ' days')::interval))`,
      [String(days)],
    )).rows as Array<{ id: string; xero_object_id: string | null; amount_gross: string | number | null; cost_date: string | null; supplier_name: string | null }>;

    const byXeroId = new Map(opRows.filter((r) => r.xero_object_id).map((r) => [r.xero_object_id as string, r]));
    const daysBetween = (a: string, b: string) => Math.abs((Date.parse(a) - Date.parse(b)) / 86400000);

    const results = txns.map((tx) => {
      let match: { cost_id: string; matched_by: 'xero_id' | 'amount_date' } | null = null;
      if (tx.bank_transaction_id && byXeroId.has(tx.bank_transaction_id)) {
        match = { cost_id: byXeroId.get(tx.bank_transaction_id)!.id, matched_by: 'xero_id' };
      } else if (tx.date) {
        const cand = opRows.find((r) =>
          r.cost_date && Math.abs(Number(r.amount_gross ?? 0) - tx.total) <= 0.01 && daysBetween(r.cost_date.slice(0, 10), tx.date!) <= 4,
        );
        if (cand) match = { cost_id: cand.id, matched_by: 'amount_date' };
      }
      return { ...tx, op_match: match };
    });

    const unmatched = results.filter((r) => !r.op_match);
    res.json({
      data: {
        configured: true,
        account_id: accountId,
        window: { days, from: start.toISOString().slice(0, 10) },
        fetched: results.length,
        matched: results.length - unmatched.length,
        unmatched_count: unmatched.length,
        unmatched,
      },
    });
  } catch (err) {
    console.error('[costs] xero-cot probe error:', err);
    res.status(502).json({ error: 'Xero request failed', detail: err instanceof Error ? err.message : String(err) });
  }
});

router.get('/xero/accounts', authorize(...STAFF_ROLES), async (req: AuthRequest, res: Response) => {
  try {
    const { isXeroConfigured } = await import('../config/xero');
    if (!isXeroConfigured()) {
      return res.status(503).json({ error: 'Xero not configured (XERO_CLIENT_ID / XERO_CLIENT_SECRET missing)' });
    }
    const { xeroBroker } = await import('../services/xero-broker');
    const accounts = await xeroBroker.getAccounts();

    // Xero returns the whole chart of accounts (100+ rows). Staff only ever code
    // a cost to a small operational subset, so we filter to a curated allowlist
    // (ordered for the picker). ?all=true returns everything for admin/debug.
    // TODO: move STAFF_COST_ACCOUNT_CODES to system_settings if it needs editing
    // without a deploy — stable enough to hardcode for now.
    if (req.query.all === 'true') {
      return res.json({ data: accounts });
    }
    const order = new Map(STAFF_COST_ACCOUNT_CODES.map((c, i) => [c, i]));
    const filtered = accounts
      .filter((a) => order.has(a.Code))
      .sort((a, b) => (order.get(a.Code)! - order.get(b.Code)!));
    res.json({ data: filtered });
  } catch (err) {
    console.error('[costs] xero accounts error:', err);
    res.status(502).json({ error: 'Xero request failed', detail: err instanceof Error ? err.message : String(err) });
  }
});

// Lists Xero bank accounts (Type=BANK, ACTIVE) for the Settings → Xero Bank
// Accounts mapping UI. Returns AccountID, Name, Code, last 4 of bank number.
router.get('/xero/bank-accounts', authorize(...VERIFY_ROLES), async (_req: AuthRequest, res: Response) => {
  try {
    const { isXeroConfigured } = await import('../config/xero');
    if (!isXeroConfigured()) {
      return res.status(503).json({ error: 'Xero not configured (XERO_CLIENT_ID / XERO_CLIENT_SECRET missing)' });
    }
    const { xeroBroker } = await import('../services/xero-broker');
    const accounts = await xeroBroker.getBankAccounts();
    res.json({
      data: accounts.map((a) => ({
        AccountID: a.AccountID,
        Code: a.Code || null,
        Name: a.Name,
        Last4: a.BankAccountNumber ? String(a.BankAccountNumber).slice(-4) : null,
      })),
    });
  } catch (err) {
    console.error('[costs] xero bank-accounts error:', err);
    res.status(502).json({ error: 'Xero request failed', detail: err instanceof Error ? err.message : String(err) });
  }
});

// AI receipt extraction — multipart upload of an image or PDF, returns the
// extracted fields for the capture modal to pre-fill. Inert when
// ANTHROPIC_API_KEY isn't set (clean 503; capture still works manually).
router.post('/extract', authorize(...STAFF_ROLES), extractUpload.single('file'), async (req: AuthRequest, res: Response) => {
  try {
    const { isAnthropicConfigured } = await import('../config/anthropic');
    if (!isAnthropicConfigured()) {
      return res.status(503).json({ error: 'AI extraction not configured (ANTHROPIC_API_KEY missing on server)' });
    }
    if (!req.file) return res.status(400).json({ error: 'No file provided' });

    const { extractReceipt } = await import('../services/cost-receipt-extract');
    const result = await extractReceipt(req.file.buffer, req.file.mimetype);
    res.json({ data: result });
  } catch (err) {
    console.error('[costs] extract error:', err);
    res.status(500).json({ error: 'Extraction failed', detail: err instanceof Error ? err.message : String(err) });
  }
});

// Supplier autocomplete for the capture modal — fuzzy-searches Xero contacts.
// Stops staff creating duplicate suppliers from typos. Free-text entry still
// allowed; the supplier→Xero contact resolution happens at push time.
router.get('/xero/suppliers', authorize(...STAFF_ROLES), async (req: AuthRequest, res: Response) => {
  try {
    const { isXeroConfigured } = await import('../config/xero');
    if (!isXeroConfigured()) return res.json({ data: [] }); // silent fallback — typing still works
    const search = typeof req.query.search === 'string' ? req.query.search : '';
    if (search.trim().length < 2) return res.json({ data: [] });
    const { xeroBroker } = await import('../services/xero-broker');
    const contacts = await xeroBroker.searchContacts(search, 10);
    res.json({ data: contacts });
  } catch (err) {
    // Suggestions are non-blocking — log and degrade silently so a Xero blip
    // doesn't break capture entirely.
    console.error('[costs] xero suppliers error:', err);
    res.json({ data: [] });
  }
});

// ── Supplier payment terms ───────────────────────────────────────────────────
// Per-supplier due-date terms, keyed by Xero contact id (when known) else name.
// Multi-segment paths so they don't collide with /:id below.

const termsSchema = z.object({
  supplier_name: z.string().trim().max(200).optional().nullable(),
  xero_contact_id: z.string().trim().max(60).optional().nullable(),
  basis: z.enum(['invoice_date', 'end_of_invoice_month']),
  days: z.number().int().min(0).max(365),
});

// Resolve the effective terms for a supplier (for the editor to pre-fill).
router.get('/suppliers/terms', async (req: AuthRequest, res: Response) => {
  try {
    const supplierName = typeof req.query.supplier_name === 'string' ? req.query.supplier_name : null;
    const xeroContactId = typeof req.query.xero_contact_id === 'string' ? req.query.xero_contact_id : null;
    const { resolveTermsForSupplier } = await import('../services/supplier-terms');
    const terms = await resolveTermsForSupplier(xeroContactId, supplierName);
    res.json({ data: terms });
  } catch (err) {
    console.error('[costs] get supplier terms error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Set/override a supplier's terms (applies to all their bills). Low-stakes —
// staff still set the real pay date at mark-paid — so STAFF_ROLES, like cost edit.
router.put('/suppliers/terms', authorize(...STAFF_ROLES), async (req: AuthRequest, res: Response) => {
  try {
    const parse = termsSchema.safeParse(req.body);
    if (!parse.success) { res.status(400).json({ error: 'Invalid input', issues: parse.error.issues }); return; }
    const { supplier_name, xero_contact_id, basis, days } = parse.data;
    if (!supplier_name && !xero_contact_id) { res.status(400).json({ error: 'A supplier name or Xero contact id is required' }); return; }
    const { upsertSupplierTerms, resolveTermsForSupplier } = await import('../services/supplier-terms');
    await upsertSupplierTerms({
      supplierName: supplier_name, xeroContactId: xero_contact_id, basis, days, source: 'manual', userId: req.user!.id,
    });
    const terms = await resolveTermsForSupplier(xero_contact_id, supplier_name);
    res.json({ data: terms });
  } catch (err) {
    console.error('[costs] set supplier terms error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── Get one (with allocations) ───────────────────────────────────────────────

router.get('/:id', async (req: AuthRequest, res: Response) => {
  try {
    const result = await query(
      `SELECT c.*,
         CONCAT(up.first_name, ' ', up.last_name) AS uploaded_by_name,
         j.hh_job_number, j.job_name, fv.reg AS vehicle_reg,
         fp.first_name AS fp_first, fp.last_name AS fp_last, fp.preferred_name AS fp_pref
       FROM costs c
       LEFT JOIN users u   ON u.id = c.uploaded_by
       LEFT JOIN people up ON up.id = u.person_id
       LEFT JOIN jobs j    ON j.id = c.job_id
       LEFT JOIN fleet_vehicles fv ON fv.id = c.vehicle_id
       LEFT JOIN people fp ON fp.id = c.person_id
       WHERE c.id = $1`,
      [req.params.id],
    );
    if (!result.rows.length) { res.status(404).json({ error: 'Cost not found' }); return; }

    const allocations = await query(
      `SELECT a.*, j.hh_job_number, j.job_name
       FROM cost_allocations a
       LEFT JOIN jobs j ON j.id = a.job_id
       WHERE a.cost_id = $1 ORDER BY a.created_at ASC`,
      [req.params.id],
    );
    const cost = withPersonName(result.rows[0]);
    const { resolveDueDateForCost } = await import('../services/supplier-terms');
    const { dueDate, derivedDueDate, terms, isOverride } = await resolveDueDateForCost(cost);
    res.json({
      data: {
        ...cost,
        terms,
        due_date: dueDate,
        due_date_derived: derivedDueDate,
        due_date_is_override: isOverride,
        allocations: allocations.rows,
        lines: await fetchCostLines(String(req.params.id)),
      },
    });
  } catch (err) {
    console.error('[costs] get error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── Create ──────────────────────────────────────────────────────────────────

// How much of this purchase hasn't come back yet — drives the Record refund
// modal's ceiling and its "£12.60 left to refund" line. Cheap enough to ask for
// every time the modal opens, which is what keeps two people refunding the same
// purchase twice from both looking fine.
router.get('/:id/refundable', async (req: AuthRequest, res: Response) => {
  try {
    const { remainingRefundable } = await import('../services/cost-credit');
    const balance = await remainingRefundable(String(req.params.id));
    if (!balance) { res.status(404).json({ error: 'Cost not found' }); return; }
    res.json({ data: balance });
  } catch (err) {
    console.error('[costs] refundable error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.post('/', authorize(...STAFF_ROLES), async (req: AuthRequest, res: Response) => {
  try {
    const parse = createSchema.safeParse(req.body);
    if (!parse.success) { res.status(400).json({ error: 'Invalid input', issues: parse.error.issues }); return; }
    const data = parse.data as Record<string, unknown>;

    // ── Credits (money coming back) ────────────────────────────────────────
    // Validated and completed BEFORE anything else: the parent's facets have to
    // be on the row before the recharge/approval logic below reads them, and a
    // credit that can't be reconciled with its purchase must not reach the
    // INSERT at all. See services/cost-credit.ts.
    const isCredit = data.is_credit === true;
    let creditWarnings: string[] = [];
    if (isCredit) {
      const { applyCreditSign, prepareCreditFromParent } = await import('../services/cost-credit');
      if (data.refund_of_cost_id) {
        const prep = await prepareCreditFromParent(String(data.refund_of_cost_id), data);
        if (prep.error) { res.status(400).json({ error: prep.error }); return; }
        creditWarnings = prep.warnings;
      } else {
        // Orphan credit — nothing to inherit, so staff picked the routing
        // themselves. It is still money in, so the same three rules hold.
        data.recharge_mode = 'none';
        data.recharge_amount = null;
        data.payment_status = 'paid';
      }
      applyCreditSign(data, true);
      // No line splitting on a credit in v1. Splitting a partial refund back
      // across the purchase's lines is real work for a rare case, and
      // validateCostLines reconciles against a NEGATIVE total here, so letting
      // lines through would be a half-answer at best.
      delete data.lines;
    }

    // Auto-inherit on "recharge running costs" jobs: a running-cost cost
    // (fuel/parking/travel) linked to a flagged job defaults to Extra + recharge-
    // pending, UNLESS the caller set the intent/recharge explicitly. The modal
    // sends explicit values once it's job-aware; this is the safety net.
    if (data.job_id && data.cost_intent === undefined && data.recharge_mode === undefined
        && RUNNING_COST_CODES.has(String(data.xero_account_code ?? ''))) {
      const jf = await query('SELECT recharge_running_costs FROM jobs WHERE id = $1', [data.job_id]);
      if (jf.rows[0]?.recharge_running_costs) {
        data.cost_intent = 'extra';
        data.recharge_mode = 'full';
      }
    }

    coerceRechargeForIntent(data);
    deriveRechargeStatusForWrite(data);
    serialiseJsonbForWrite(data);

    // Lines are validated BEFORE the insert so a set that doesn't add up can't
    // leave a half-saved cost behind. `lines` is not in WRITABLE, so it never
    // reaches the column loop below.
    const newLines = (data.lines as CostLineInput[] | undefined);
    if (newLines?.length) {
      const problem = validateCostLines(data as never, newLines);
      if (problem) { res.status(400).json({ error: problem }); return; }
      // VAT is an analysis of the total, not part of it, so a cost with lines
      // takes its VAT (and hence net) FROM them. The gross — what we actually
      // owe — is untouched. Derived here rather than trusted from the client so
      // the header can't disagree with its own lines whatever the caller sends.
      Object.assign(data, headerVatFromLines(newLines, data.amount_gross));
    }

    // A payable (anything not already paid) enters the approval workflow. If the
    // booker is uploading it, they vouch for it inline → 'verified'. An approver
    // (manager tier, which includes the weekend manager) can one-click "Approve &
    // save" to skip straight to 'approved' (which fires the bill push for
    // pay-later methods). The form already offered the button to a weekend
    // manager; a hardcoded admin/manager list here quietly ignored it.
    const isPayable = Boolean(data.payment_status && data.payment_status !== 'paid');
    const canApprove = isManagerTier(req.user!.role);
    const approveNow = data.approve === true && isPayable && canApprove;
    let approvalState: string | null = null;
    if (isPayable) approvalState = approveNow ? 'approved' : 'verified';

    // COT-card payments are stamped with the uploader's name + their stored
    // card last 4 (from Profile) — staff no longer enters either every time.
    if (data.payment_method === 'cot_card') {
      const me = await query(
        `SELECT CONCAT(p.first_name, ' ', p.last_name) AS holder, u.cot_card_last4 AS last4
           FROM users u JOIN people p ON p.id = u.person_id WHERE u.id = $1`,
        [req.user!.id],
      );
      if (me.rows[0]) {
        data.cot_card_holder = me.rows[0].holder?.trim() || null;
        data.cot_card_last4 = me.rows[0].last4 || null;
      }
    }

    // "Which jobs?" (FREELANCER-PORTAL-SPEC §5): checked BEFORE the insert, so
    // ticks that aren't this freelancer's can't leave a half-saved cost behind.
    const workItems = data.work_items as { key: string; amount: number }[] | undefined;
    delete data.work_items;
    let workRows: WorkLinkRow[] | null = null;
    if (workItems !== undefined) {
      if (workItems.length && data.cost_type !== 'freelancer_invoice') {
        res.status(400).json({ error: 'Only a freelancer invoice can be linked to their work.' });
        return;
      }
      try {
        workRows = await planWorkLinks(null, (data.person_id as string | null | undefined) || null, workItems);
      } catch (e) {
        if (e instanceof WorkLinkError) { res.status(400).json({ error: e.message }); return; }
        throw e;
      }
    }

    // The job split, sent with the cost: checked against the cost as it will be,
    // BEFORE the insert, and written after it.
    const splitInput = data.allocations as AllocationInput[] | undefined;
    delete data.allocations;
    let splitPlan: Awaited<ReturnType<typeof planAllocations>> | null = null;
    if (splitInput?.length) {
      const hh = data.job_id
        ? (await query('SELECT hh_job_number FROM jobs WHERE id = $1', [data.job_id])).rows[0]?.hh_job_number ?? null
        : null;
      try {
        splitPlan = await planAllocations(null, {
          amount_gross: data.amount_gross as number | null, cost_intent: (data.cost_intent as string) ?? null,
          recharge_mode: (data.recharge_mode as string) ?? 'none', is_credit: isCredit, hh_job_number: hh,
        }, splitInput);
      } catch (e) {
        if (e instanceof AllocationError) { res.status(e.status).json({ error: e.message }); return; }
        throw e;
      }
    }
    // Work ticked: no "why not?" to keep (migration 315).
    if (workRows?.length) data.work_unmatched_reason = null;

    const cols = ['uploaded_by', 'approval_state'];
    const vals: unknown[] = [req.user!.id, approvalState];
    if (approveNow) {
      cols.push('verified_by', 'verified_at', 'approved_by', 'approved_at');
      const now = new Date();
      vals.push(req.user!.id, now, req.user!.id, now);
    }
    for (const c of WRITABLE) {
      if (data[c] !== undefined) { cols.push(c); vals.push(data[c]); }
    }
    const placeholders = vals.map((_, i) => `$${i + 1}`).join(', ');

    const result = await query(
      `INSERT INTO costs (${cols.join(', ')}) VALUES (${placeholders}) RETURNING *`,
      vals,
    );

    // Lines BEFORE the push, not after: the push reads them to build the Xero
    // line items, and a separate round-trip would race it onto a one-line bill.
    if (newLines?.length) await replaceCostLines(result.rows[0].id, newLines);
    if (workRows?.length) await writeWorkLinks(result.rows[0].id, workRows, req.user!.id);
    if (splitPlan) await writeAllocations(result.rows[0].id, splitPlan, req.user!.id);

    // Background push to Xero for paid costs — non-blocking; the cost row's
    // xero_sync_state + xero_error carry success/failure for the UI.
    const { pushCostToXeroBackground } = await import('../services/cost-xero-push');
    pushCostToXeroBackground(result.rows[0].id);

    // First time we see a Xero-linked supplier, seed its payment terms from the
    // Xero contact (fire-and-forget — never blocks capture).
    const created = result.rows[0];
    if (created.xero_contact_id) {
      void import('../services/supplier-terms')
        .then((m) => m.seedTermsFromXeroIfMissing(created.xero_contact_id, created.supplier_name))
        .catch(() => { /* non-fatal — staff can set terms manually */ });
    }

    // The credit landed; what OP can't tidy up by itself is told to a human.
    // After the insert, never before — a bell must not be able to fail a save.
    if (creditWarnings.length) {
      const { notifyCreditNeedsFollowUp } = await import('../services/cost-credit');
      void notifyCreditNeedsFollowUp(created.id, created.supplier_name, Number(created.amount_gross), creditWarnings);
    }

    res.status(201).json({
      data: await withJobLabels(created),
      ...(creditWarnings.length ? { warnings: creditWarnings } : {}),
    });
  } catch (err) {
    console.error('[costs] create error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── Update ────────────────────────────────────────────────────────────────────

router.patch('/:id', authorize(...STAFF_ROLES), async (req: AuthRequest, res: Response) => {
  try {
    const parse = updateSchema.safeParse(req.body);
    if (!parse.success) { res.status(400).json({ error: 'Invalid input', issues: parse.error.issues }); return; }
    const data = parse.data as Record<string, unknown>;
    coerceRechargeForIntent(data);
    serialiseJsonbForWrite(data);

    // "Which jobs?" (FREELANCER-PORTAL-SPEC §5), checked before anything is
    // written. Changing WHOSE invoice it is without re-ticking clears the old
    // ticks: they were the previous person's work.
    const workItems = data.work_items as { key: string; amount: number }[] | undefined;
    delete data.work_items;
    let workRows: WorkLinkRow[] | null = null;
    if (workItems !== undefined || data.person_id !== undefined) {
      const cur = await query('SELECT person_id, cost_type FROM costs WHERE id = $1', [req.params.id]);
      if (!cur.rows.length) { res.status(404).json({ error: 'Cost not found' }); return; }
      const personId = (data.person_id !== undefined ? data.person_id : cur.rows[0].person_id) as string | null;
      const costType = (data.cost_type ?? cur.rows[0].cost_type) as string;
      if (workItems !== undefined) {
        if (workItems.length && costType !== 'freelancer_invoice') {
          res.status(400).json({ error: 'Only a freelancer invoice can be linked to their work.' });
          return;
        }
        try {
          workRows = await planWorkLinks(String(req.params.id), personId || null, workItems);
        } catch (e) {
          if (e instanceof WorkLinkError) { res.status(400).json({ error: e.message }); return; }
          throw e;
        }
      } else if ((personId || null) !== (cur.rows[0].person_id || null)) {
        workRows = [];
      }
    }
    // Work ticked: no "why not?" to keep (migration 315).
    if (workRows?.length) data.work_unmatched_reason = null;

    // Amounts arrive as positive magnitudes from every client, so an edited
    // credit has to be re-signed or it flips to a purchase on save. Which kind
    // of row this IS comes from the table, not the payload — `is_credit` is set
    // once at capture and isn't a thing an edit gets to toggle.
    if (data.amount_gross !== undefined || data.amount_vat !== undefined || data.amount_net !== undefined) {
      const kind = await query('SELECT is_credit FROM costs WHERE id = $1', [req.params.id]);
      if (!kind.rows.length) { res.status(404).json({ error: 'Cost not found' }); return; }
      const { applyCreditSign } = await import('../services/cost-credit');
      applyCreditSign(data, kind.rows[0].is_credit === true);
    }
    delete data.is_credit;
    delete data.refund_of_cost_id;

    // Keep recharge_status in step if recharge_mode is being changed — but never
    // clobber a terminal resolution (already pushed/absorbed) back to pending.
    // Nor take one off: a recharge that is done records a line on the client's
    // HireHop job (or a decision), and clearing it here would leave that line
    // billed with nothing in OP saying so.
    if (data.recharge_mode !== undefined) {
      const cur = await query('SELECT recharge_mode, recharge_status FROM costs WHERE id = $1', [req.params.id]);
      const was = cur.rows[0];
      if (data.recharge_mode === 'none' && was && (was.recharge_mode ?? 'none') !== 'none' && TERMINAL_RECHARGE.has(was.recharge_status)) {
        res.status(409).json({ error: 'This cost has already been recharged to the client, so its recharge can\'t be taken off here.' });
        return;
      }
      deriveRechargeStatusForWrite(data, was?.recharge_status ?? null);
    }

    // The job split, sent with the cost: checked against the cost as it WILL be
    // after this save (so "whole cost or per job" is judged on the final state),
    // before anything is written.
    const splitInput = data.allocations as AllocationInput[] | undefined;
    delete data.allocations;
    let splitPlan: Awaited<ReturnType<typeof planAllocations>> | null = null;
    if (splitInput !== undefined) {
      const cur = await query(
        `SELECT c.amount_gross, c.cost_intent, c.recharge_mode, c.is_credit, c.job_id
           FROM costs c WHERE c.id = $1`,
        [req.params.id],
      );
      if (!cur.rows.length) { res.status(404).json({ error: 'Cost not found' }); return; }
      const will = { ...cur.rows[0], ...data } as Record<string, unknown>;
      const hh = will.job_id
        ? (await query('SELECT hh_job_number FROM jobs WHERE id = $1', [will.job_id])).rows[0]?.hh_job_number ?? null
        : null;
      try {
        splitPlan = await planAllocations(String(req.params.id), {
          amount_gross: will.amount_gross as number | null, cost_intent: (will.cost_intent as string) ?? null,
          recharge_mode: (will.recharge_mode as string) ?? 'none', is_credit: will.is_credit === true, hh_job_number: hh,
        }, splitInput);
      } catch (e) {
        if (e instanceof AllocationError) { res.status(e.status).json({ error: e.message }); return; }
        throw e;
      }
    }

    // A cost is recharged as a whole OR job by job, never both (migration 318).
    // The capture form sends its recharge answer on every save, so only a real
    // recharge is refused here: 'none' on a cost recharged per job is the form
    // agreeing, not a change. A cost-level "part of a quote" would contradict
    // shares that inherit it and are flagged for recharge, so that is refused too.
    // When the split comes in this same request, the plan above has already
    // judged the final state, so the existing shares don't decide it.
    const wantsWholeRecharge = data.recharge_mode !== undefined && data.recharge_mode !== 'none';
    if (!splitPlan && splitInput === undefined && (wantsWholeRecharge || data.cost_intent === 'quote_actual')) {
      const clash = await query(
        `SELECT COUNT(*) FILTER (WHERE recharge_mode <> 'none')::int AS recharged,
                COUNT(*) FILTER (WHERE recharge_mode <> 'none' AND cost_intent IS NULL)::int AS inheriting
           FROM cost_allocations WHERE cost_id = $1`,
        [req.params.id],
      );
      const c = clash.rows[0] || { recharged: 0, inheriting: 0 };
      if (wantsWholeRecharge && c.recharged > 0) {
        res.status(400).json({ error: PER_JOB_ALREADY });
        return;
      }
      if (data.cost_intent === 'quote_actual' && c.inheriting > 0) {
        res.status(400).json({
          error: 'Some jobs\' shares of this cost are being recharged to their clients, so it can\'t all be "part of the quote". '
            + 'Clear those recharges first, or mark each job\'s share on its own.',
        });
        return;
      }
    }

    // Lines are checked against the row as it WILL be — the same PATCH may be
    // changing the total they have to add up to. Validating first means an
    // unbalanced set is refused with nothing written, header included.
    const editedLines = (data.lines as CostLineInput[] | undefined);
    if (editedLines !== undefined) {
      const before = await query(
        'SELECT amount_gross, amount_vat, vat_treatment, xero_sync_state FROM costs WHERE id = $1',
        [req.params.id],
      );
      if (!before.rows.length) { res.status(404).json({ error: 'Cost not found' }); return; }
      if (before.rows[0].xero_sync_state === 'reconciled') {
        res.status(409).json({ error: 'This cost is reconciled in Xero and can no longer be changed.' });
        return;
      }
      // Lines and a job split used to be refused together ("two answers to the
      // same question"). Since the capture form's redesign (Oct 2026) they answer
      // DIFFERENT questions: lines say how the invoice breaks down by category
      // and VAT (they are the Xero line items), the split says which jobs carry
      // it. No line sets a job, and the job read ignores lines on a split-in row
      // (a share's lines would describe a total that job doesn't carry), so
      // both can stand. A freelancer invoice across two jobs whose fee and fuel
      // are at different VAT rates needs both.

      const merged = { ...before.rows[0], ...data };
      const problem = validateCostLines(merged as never, editedLines);
      if (problem) { res.status(400).json({ error: problem }); return; }
      // Lines own the VAT split (see create). Clearing the lines leaves the
      // header's own figures alone — whatever the modal sent with them.
      if (editedLines.length) Object.assign(data, headerVatFromLines(editedLines, merged.amount_gross));
    }

    const sets: string[] = [];
    const vals: unknown[] = [];
    for (const c of WRITABLE) {
      if (data[c] !== undefined) { vals.push(data[c]); sets.push(`${c} = $${vals.length}`); }
    }
    if (!sets.length) {
      // Only the ticks and/or the split changed: nothing on the row itself,
      // nothing for Xero.
      if (workRows || splitPlan) {
        if (workRows) await writeWorkLinks(String(req.params.id), workRows, req.user!.id);
        if (splitPlan) await writeAllocations(String(req.params.id), splitPlan, req.user!.id);
        const row = await query('SELECT * FROM costs WHERE id = $1', [req.params.id]);
        if (!row.rows.length) { res.status(404).json({ error: 'Cost not found' }); return; }
        res.json({ data: await withJobLabels(row.rows[0]) });
        return;
      }
      res.status(400).json({ error: 'No updatable fields supplied' });
      return;
    }

    vals.push(req.params.id);
    const result = await query(
      `UPDATE costs SET ${sets.join(', ')} WHERE id = $${vals.length} RETURNING *`,
      vals,
    );
    if (!result.rows.length) { res.status(404).json({ error: 'Cost not found' }); return; }
    if (workRows) await writeWorkLinks(String(req.params.id), workRows, req.user!.id);
    if (splitPlan) await writeAllocations(String(req.params.id), splitPlan, req.user!.id);
    // A receipt attached (or the purchase changed) may finish someone's
    // "company-card purchases need a receipt" bell.
    if (['receipt_r2_key', 'payment_method', 'cost_date'].some((f) => data[f] !== undefined)) {
      await retireDoneBells('cot_receipts');
    }

    const updated = result.rows[0];
    // Same ordering rule as create: lines land before any push reads them.
    if (editedLines !== undefined) await replaceCostLines(String(req.params.id), editedLines);
    // Already in Xero is decided by the OBJECT ID alone — never by sync state.
    // State says whether the last operation succeeded; it says nothing about
    // whether the object is there. Reading 'error' as "not in Xero" here is half
    // of what created duplicate bills (services/cost-xero-push.ts existsInXero).
    const alreadyPushed = Boolean(updated.xero_object_id);

    if (alreadyPushed) {
      // Already in Xero — we can't silently re-push (it may be reconciled). If a
      // Xero-affecting field changed, flag it stale so the UI warns + offers a
      // manual "Re-sync to Xero". Non-Xero edits (notes, payment_status) leave it alone.
      const XERO_AFFECTING = ['amount_net', 'amount_vat', 'amount_gross', 'xero_account_code',
        'supplier_name', 'description', 'vat_treatment', 'cost_date', 'payment_method', 'invoice_number',
        // The bill's Xero DueDate comes from resolveDueDate(), so an override edit
        // has to be re-syncable or OP and Xero disagree about when it's due.
        'due_date_override',
        // Adding/removing supporting evidence after the push only reaches Xero
        // via a re-sync — without this the doc sits in OP and never lands.
        'supporting_documents',
        // Lines ARE the Xero line items. Changing them changes the bill.
        'lines'];
      if (XERO_AFFECTING.some((f) => data[f] !== undefined) && !updated.xero_stale) {
        const s = await query(`UPDATE costs SET xero_stale=TRUE WHERE id=$1 RETURNING xero_stale`, [updated.id]);
        updated.xero_stale = s.rows[0]?.xero_stale ?? true;
      }
    } else {
      // Genuinely not in Xero (no object id) — background push. The service
      // guards again on the same rule, so a race can't create a second object.
      const { pushCostToXeroBackground } = await import('../services/cost-xero-push');
      pushCostToXeroBackground(updated.id);
    }

    // Seed terms from Xero if a contact id was just attached and none exist yet.
    if (updated.xero_contact_id) {
      void import('../services/supplier-terms')
        .then((m) => m.seedTermsFromXeroIfMissing(updated.xero_contact_id, updated.supplier_name))
        .catch(() => { /* non-fatal — staff can set terms manually */ });
    }

    res.json({ data: await withJobLabels(updated) });
  } catch (err) {
    console.error('[costs] update error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Manual retry — staff-triggered push for anything stuck. Runs the same push
// service synchronously and returns the result for UI feedback.
router.post('/:id/sync-xero', authorize(...STAFF_ROLES), async (req: AuthRequest, res: Response) => {
  try {
    const id = String(req.params.id);
    // The red "Failed" pill's Retry lands here. A cost that already HAS a Xero
    // object needs its figures pushed at the existing one, not a fresh create —
    // and for a bill still awaiting its payment leg, pushCostToXero is exactly
    // the right call (it skips the create and records the payment). So: object
    // present + nothing left for the bill flow to do → re-sync in place.
    const cur = await query(
      'SELECT xero_object_id, xero_payment_id, payment_method, payment_status, settled_externally FROM costs WHERE id = $1',
      [id],
    );
    if (!cur.rows.length) return res.status(404).json({ error: 'Cost not found' });
    const c = cur.rows[0];
    // A bill settled outside OP has NO payment leg — the money moved somewhere
    // we didn't do, so there is nothing to record and recording one would pay
    // the supplier twice. See migration 224.
    const paymentLegOutstanding = Boolean(c.xero_object_id)
      && BILL_METHODS.includes(c.payment_method)
      && c.payment_status === 'paid' && !c.xero_payment_id && !c.settled_externally;

    const svc = await import('../services/cost-xero-push');
    const result = (c.xero_object_id && !paymentLegOutstanding)
      ? await svc.resyncCostToXero(id)
      : await svc.pushCostToXero(id);
    const after = await query('SELECT * FROM costs WHERE id = $1', [id]);
    if (!after.rows.length) return res.status(404).json({ error: 'Cost not found' });
    res.json({ data: after.rows[0], result });
  } catch (err) {
    console.error('[costs] sync-xero error:', err);
    res.status(500).json({ error: 'Internal server error', detail: err instanceof Error ? err.message : String(err) });
  }
});

// Re-sync an edited, already-pushed cost to Xero IN PLACE (updates the existing
// object, never duplicates). Behind the xero_stale flag's "Re-sync to Xero"
// button. 409 if Xero has the object locked (paid bill / reconciled txn).
router.post('/:id/resync-xero', authorize(...STAFF_ROLES), async (req: AuthRequest, res: Response) => {
  try {
    const id = String(req.params.id);
    // dismiss: staff fixed a Xero-locked cost (paid bill / reconciled txn)
    // directly in Xero — just clear the stale flag, don't touch Xero.
    if (req.body?.dismiss === true) {
      const r = await query(`UPDATE costs SET xero_stale=FALSE WHERE id=$1 RETURNING *`, [id]);
      if (!r.rows.length) return res.status(404).json({ error: 'Cost not found' });
      return res.json({ data: r.rows[0], result: { pushed: false, skipped: 'Marked resolved' } });
    }
    const { resyncCostToXero } = await import('../services/cost-xero-push');
    const result = await resyncCostToXero(id);
    const after = await query('SELECT * FROM costs WHERE id = $1', [id]);
    if (!after.rows.length) return res.status(404).json({ error: 'Cost not found' });
    if (result.locked) return res.status(409).json({ error: result.error, data: after.rows[0], result });
    res.json({ data: after.rows[0], result });
  } catch (err) {
    console.error('[costs] resync-xero error:', err);
    res.status(500).json({ error: 'Internal server error', detail: err instanceof Error ? err.message : String(err) });
  }
});

// ── Delete ────────────────────────────────────────────────────────────────────

router.delete('/:id', authorize(...VERIFY_ROLES), async (req: AuthRequest, res: Response) => {
  try {
    const result = await query('DELETE FROM costs WHERE id = $1 RETURNING id', [req.params.id]);
    if (!result.rows.length) { res.status(404).json({ error: 'Cost not found' }); return; }
    await retireDoneBells('cot_receipts');
    res.json({ data: { id: req.params.id, deleted: true } });
  } catch (err) {
    console.error('[costs] delete error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── Recharge (flag-and-confirm) ─────────────────────────────────────────────
// Records the recharge intent + amount. The HireHop chargeable-item push is
// wired in a later PR (needs the generic recharge stock-item IDs in HH); until
// then this stamps recharge_mode/amount so the cost surfaces in the Recharges
// view and on the job's close-out flag.

router.post('/:id/recharge', authorize(...STAFF_ROLES), async (req: AuthRequest, res: Response) => {
  try {
    const parse = rechargeSchema.safeParse(req.body);
    if (!parse.success) { res.status(400).json({ error: 'Invalid input', issues: parse.error.issues }); return; }
    const { recharge_mode, recharge_amount } = parse.data;

    const existing = await query('SELECT * FROM costs WHERE id = $1', [req.params.id]);
    if (!existing.rows.length) { res.status(404).json({ error: 'Cost not found' }); return; }
    const cost = existing.rows[0];
    if (!cost.job_id) { res.status(400).json({ error: 'Cost must be linked to a job before it can be recharged' }); return; }
    if (cost.cost_intent === 'quote_actual') {
      res.status(400).json({ error: 'This cost is part of a quote (already billed via the quote) — mark it as "Extra" to recharge it.' });
      return;
    }
    if (await hasPerJobRecharges(String(req.params.id))) { res.status(400).json({ error: PER_JOB_ALREADY }); return; }

    const amount = recharge_mode === 'full' ? (cost.amount_gross ?? recharge_amount) : recharge_amount;
    // Flagging (or re-flagging) → pending, unless already in a terminal state.
    const nextStatus = TERMINAL_RECHARGE.has(cost.recharge_status) ? cost.recharge_status : 'pending';
    const result = await query(
      `UPDATE costs SET recharge_mode = $1, recharge_amount = $2, recharge_status = $3 WHERE id = $4 RETURNING *`,
      [recharge_mode, amount, nextStatus, req.params.id],
    );
    await audit(req.user!.id, req.params.id as string, 'recharge_flag',
      { recharge_mode: cost.recharge_mode, recharge_amount: cost.recharge_amount },
      { recharge_mode, recharge_amount: amount });
    res.json({ data: result.rows[0], hh_pushed: false, note: 'Recharge flagged. Use "Push to HireHop" to add the billable line.' });
  } catch (err) {
    console.error('[costs] recharge error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Persist the recharge base/markup/final figures the resolve modal computed.
// recharge_amount is the FINAL net (post-markup) figure that bills; the markup
// columns record how it was reached (audit). Coerces recharge_mode→'full' when a
// base is given but no mode, so an unflagged `extra` cost can be billed in one step.
const MARKUP_TYPES = ['greater_of', 'percent', 'fixed', 'none'] as const;
const rechargeFiguresSchema = z.object({
  recharge_mode: z.enum(['full', 'partial']).optional(),
  recharge_amount: money.optional().nullable(),        // final net to bill
  recharge_base_amount: money.optional().nullable(),   // net before markup
  recharge_markup_type: z.enum(MARKUP_TYPES).optional().nullable(),
  recharge_markup_value: money.optional().nullable(),
});

// Written wherever the recharge lives: the whole cost, or one job's share of a
// split cost (`allocation_id`, migration 318).
async function persistRechargeFigures(target: RechargeTarget, figures: z.infer<typeof rechargeFiguresSchema>) {
  const sets: Record<string, unknown> = {};
  if (figures.recharge_mode !== undefined) sets.recharge_mode = figures.recharge_mode;
  else if (figures.recharge_amount != null) sets.recharge_mode = 'full'; // base given, no mode → treat as full
  if (figures.recharge_amount !== undefined) sets.recharge_amount = figures.recharge_amount;
  if (figures.recharge_base_amount !== undefined) sets.recharge_base_amount = figures.recharge_base_amount;
  if (figures.recharge_markup_type !== undefined) sets.recharge_markup_type = figures.recharge_markup_type;
  if (figures.recharge_markup_value !== undefined) sets.recharge_markup_value = figures.recharge_markup_value;
  await updateRecharge(target, sets);
}

// Which recharge a push / resolve is about. No allocation_id = the whole cost.
const rechargeTargetSchema = z.object({ allocation_id: z.string().uuid().optional().nullable() });

/**
 * Check a push / resolve is aimed at a recharge that can take it, BEFORE any
 * figure is written. Returns the refusal to send, or null when it's fine.
 */
async function rechargeTargetProblem(costId: string, allocationId: string | null): Promise<{ status: number; error: string } | null> {
  const t = await loadRecharge(costId, allocationId);
  if (!t) return { status: 404, error: allocationId ? 'That job\'s share of the cost was not found — refresh and try again.' : 'Cost not found' };
  if (t.costIntent === 'quote_actual') {
    return { status: 400, error: 'This cost is part of a quote (already billed via the quote) — it has no recharge to resolve.' };
  }
  if (allocationId) {
    // The whole cost already recharged (the old way) — its shares can't be too.
    if ((t.cost.recharge_mode ?? 'none') !== 'none') return { status: 400, error: wholeCostAlready(t.costHhJobNumber) };
    if (!t.jobId) return { status: 400, error: 'That share isn\'t on a job, so there is no client to recharge.' };
  } else if (await hasPerJobRecharges(costId)) {
    return { status: 400, error: PER_JOB_ALREADY };
  }
  return null;
}

/** Refresh the post-hire close-out card on the job a recharge bills. Never fails the action. */
async function syncRechargeJob(jobId: string | null | undefined) {
  if (!jobId) return;
  const { syncCostResolveRequirementStatus } = await import('../services/cost-requirement-sync');
  await syncCostResolveRequirementStatus(jobId).catch(() => { /* non-fatal */ });
}

// Push the flagged recharge to HireHop as a billable hire line. Explicit staff
// action (never auto-fires). Idempotent — a cost already recharged is a no-op.
// Optional body carries the resolve modal's final figure + markup breakdown.
router.post('/:id/push-recharge', authorize(...STAFF_ROLES), async (req: AuthRequest, res: Response) => {
  try {
    const costId = String(req.params.id);
    const target = rechargeTargetSchema.safeParse(req.body || {});
    if (!target.success) { res.status(400).json({ error: 'Invalid input', issues: target.error.issues }); return; }
    const allocationId = target.data.allocation_id ?? null;
    const problem = await rechargeTargetProblem(costId, allocationId);
    if (problem) { res.status(problem.status).json({ error: problem.error }); return; }

    const figures = rechargeFiguresSchema.safeParse(req.body || {});
    if (figures.success) await persistRechargeFigures({ costId, allocationId }, figures.data);

    const { pushRechargeToHH } = await import('../services/cost-recharge-hh');
    const result = await pushRechargeToHH(costId, allocationId);
    if (result.pushed) {
      await audit(req.user!.id, costId, 'recharge_pushed', null,
        { hh_job: result.hhJobNumber, amount: result.amount, stock: result.stockLabel, allocation_id: allocationId });
      // Refresh the post-hire close-out card on the job this recharge billed.
      await syncRechargeJob((await loadRecharge(costId, allocationId))?.jobId);
    }
    const after = await query('SELECT * FROM costs WHERE id = $1', [costId]);
    res.json({ data: after.rows[0] || null, result });
  } catch (err) {
    console.error('[costs] push-recharge error:', err);
    res.status(500).json({ error: 'Internal server error', detail: err instanceof Error ? err.message : String(err) });
  }
});

// Resolve a recharge WITHOUT a HireHop push: either billed by another means
// (recharged_external — typically the HH job was closed, so a direct Xero invoice
// etc.) or deliberately not billed (absorbed / written off, reason required).
// Terminal — clears the cost out of the Recharges-pending bucket and lets the
// post-hire cost_resolve card go green. Reason is auditable for the "we keep
// absorbing £20 refuels" review.
const resolveRechargeSchema = rechargeFiguresSchema.extend({
  resolution: z.enum(['recharged_external', 'absorbed']),
  note: z.string().trim().max(2000).optional().nullable(),
  // One job's share of a split cost (migration 318); omitted = the whole cost.
  allocation_id: z.string().uuid().optional().nullable(),
});

router.post('/:id/resolve-recharge', authorize(...STAFF_ROLES), async (req: AuthRequest, res: Response) => {
  try {
    const parse = resolveRechargeSchema.safeParse(req.body);
    if (!parse.success) { res.status(400).json({ error: 'Invalid input', issues: parse.error.issues }); return; }
    const { resolution, note, allocation_id: allocationIdInput, ...figures } = parse.data;
    if (resolution === 'absorbed' && !note?.trim()) {
      res.status(400).json({ error: 'A reason is required to absorb / write off a recharge.' }); return;
    }
    const costId = String(req.params.id);
    const allocationId = allocationIdInput ?? null;
    const problem = await rechargeTargetProblem(costId, allocationId);
    if (problem) { res.status(problem.status).json({ error: problem.error }); return; }
    const before = await loadRecharge(costId, allocationId);
    const target: RechargeTarget = { costId, allocationId };

    await persistRechargeFigures(target, figures);
    // Flag for recharge if it wasn't already (so an unflagged extra cost can be
    // resolved in one step), then stamp the terminal resolution.
    await updateRecharge(target, {
      recharge_mode: !before?.rechargeMode || before.rechargeMode === 'none' ? 'full' : before.rechargeMode,
      recharge_status: resolution,
      recharge_resolution_note: note?.trim() || null,
      recharge_resolved_by: req.user!.id,
      recharge_resolved_at: new Date(),
    });
    await audit(req.user!.id, costId, 'recharge_resolved',
      { recharge_status: before?.rechargeStatus ?? null },
      { recharge_status: resolution, note: note?.trim() || null, allocation_id: allocationId });

    // Refresh the post-hire close-out card on the job this recharge bills.
    await syncRechargeJob(before?.jobId);
    const after = await query('SELECT * FROM costs WHERE id = $1', [costId]);
    res.json({ data: after.rows[0] || null });
  } catch (err) {
    console.error('[costs] resolve-recharge error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── Approval workflow (payables) ────────────────────────────────────────────

router.post('/:id/verify', authorize(...VERIFY_ROLES), async (req: AuthRequest, res: Response) => {
  try {
    const result = await query(
      `UPDATE costs SET approval_state = 'verified', verified_by = $1, verified_at = NOW()
       WHERE id = $2 RETURNING *`,
      [req.user!.id, req.params.id],
    );
    if (!result.rows.length) { res.status(404).json({ error: 'Cost not found' }); return; }
    await audit(req.user!.id, req.params.id as string, 'cost_verified', null, { approval_state: 'verified' });
    res.json({ data: result.rows[0] });
  } catch (err) {
    console.error('[costs] verify error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.post('/:id/approve', authorize(...VERIFY_ROLES), async (req: AuthRequest, res: Response) => {
  try {
    const result = await query(
      // Approving answers any open query (FREELANCER-PORTAL-SPEC §5); its note
      // stays in the audit log.
      `UPDATE costs SET approval_state = 'approved', approved_by = $1, approved_at = NOW(),
              queried_at = NULL, queried_by = NULL, query_note = NULL
       WHERE id = $2 RETURNING *`,
      [req.user!.id, req.params.id],
    );
    if (!result.rows.length) { res.status(404).json({ error: 'Cost not found' }); return; }
    await audit(req.user!.id, req.params.id as string, 'cost_approved', null, { approval_state: 'approved' });

    // Pay-later methods create their authorised ACCPAY bill in Xero on approval.
    if ((BILL_METHODS as readonly string[]).includes(result.rows[0].payment_method)) {
      const { pushCostToXeroBackground } = await import('../services/cost-xero-push');
      pushCostToXeroBackground(result.rows[0].id);
    }
    res.json({ data: result.rows[0] });
  } catch (err) {
    console.error('[costs] approve error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── Query a freelancer invoice (FREELANCER-PORTAL-SPEC §5) ───────────────────
// "Why is that so expensive?": the alternative to approving it. Shown as
// Queried in Costs (and, next, in the freelancer's portal). No email: the
// office contacts the freelancer itself (jon). Managers and admins, or whoever
// uploaded it. Approving clears it.

const querySchema = z.object({ note: z.string().trim().min(1, 'Say what the question is').max(2000) });

async function mayQuery(req: AuthRequest, costId: string): Promise<{ ok: true; cost: Record<string, unknown> } | { ok: false; status: number; error: string }> {
  const r = await query('SELECT id, uploaded_by, approval_state, cost_type, queried_at, query_note FROM costs WHERE id = $1', [costId]);
  const cost = r.rows[0];
  if (!cost) return { ok: false, status: 404, error: 'Cost not found' };
  if (cost.cost_type !== 'freelancer_invoice') return { ok: false, status: 400, error: 'Only a freelancer invoice can be queried.' };
  // Manager tier = who approves (VERIFY_ROLES, which authorize() widens to weekend managers).
  if (!isManagerTier(req.user!.role) && cost.uploaded_by !== req.user!.id) {
    return { ok: false, status: 403, error: 'Only a manager, or whoever uploaded it, can query this invoice.' };
  }
  if (cost.approval_state === 'approved' || cost.approval_state === 'paid') {
    return { ok: false, status: 409, error: 'This invoice is already approved, so there is nothing to query.' };
  }
  return { ok: true, cost };
}

router.post('/:id/query', authorize(...STAFF_ROLES), async (req: AuthRequest, res: Response) => {
  try {
    const parse = querySchema.safeParse(req.body ?? {});
    if (!parse.success) { res.status(400).json({ error: parse.error.issues[0]?.message || 'Say what the question is' }); return; }
    const check = await mayQuery(req, String(req.params.id));
    if (!check.ok) { res.status(check.status).json({ error: check.error }); return; }
    const result = await query(
      `UPDATE costs SET queried_at = NOW(), queried_by = $1, query_note = $2 WHERE id = $3 RETURNING *`,
      [req.user!.id, parse.data.note, req.params.id],
    );
    await audit(req.user!.id, String(req.params.id), 'cost_queried', null, { query_note: parse.data.note });
    res.json({ data: await withJobLabels(result.rows[0]) });
  } catch (err) {
    console.error('[costs] query error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.delete('/:id/query', authorize(...STAFF_ROLES), async (req: AuthRequest, res: Response) => {
  try {
    const check = await mayQuery(req, String(req.params.id));
    if (!check.ok) { res.status(check.status).json({ error: check.error }); return; }
    const result = await query(
      `UPDATE costs SET queried_at = NULL, queried_by = NULL, query_note = NULL WHERE id = $1 RETURNING *`,
      [req.params.id],
    );
    await audit(req.user!.id, String(req.params.id), 'cost_query_cleared', { query_note: check.cost.query_note }, null);
    res.json({ data: await withJobLabels(result.rows[0]) });
  } catch (err) {
    console.error('[costs] clear query error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

const paySchema = z.object({
  // The bank/card instrument the payment went out from (drives which Xero bank
  // account the payment posts against). One of the paid-now method keys.
  paid_method: z.string().trim().max(40).optional().nullable(),
  // The date money actually moves — may be future, for a scheduled payment.
  paid_date: z.string().trim().max(20).optional().nullable(),
});

router.post('/:id/pay', authorize(...ADMIN_ONLY), async (req: AuthRequest, res: Response) => {
  try {
    const parse = paySchema.safeParse(req.body ?? {});
    if (!parse.success) { res.status(400).json({ error: 'Invalid input', issues: parse.error.issues }); return; }
    const { paid_method, paid_date } = parse.data;

    const result = await query(
      `UPDATE costs
       SET approval_state = 'paid', payment_status = 'paid',
           paid_by = $1, paid_at = NOW(), paid_method = COALESCE($2, paid_method),
           paid_value_date = COALESCE($3::date, paid_value_date, CURRENT_DATE)
       WHERE id = $4 RETURNING *`,
      [req.user!.id, paid_method ?? null, paid_date || null, req.params.id],
    );
    if (!result.rows.length) { res.status(404).json({ error: 'Cost not found' }); return; }
    await audit(req.user!.id, req.params.id as string, 'cost_paid', null, { approval_state: 'paid', paid_method, paid_date });

    // Record the payment against the Xero bill (pay-later methods). Idempotent —
    // the push skips if the payment is already recorded (xero_payment_id set).
    if ((BILL_METHODS as readonly string[]).includes(result.rows[0].payment_method)) {
      const { pushCostToXeroBackground } = await import('../services/cost-xero-push');
      pushCostToXeroBackground(result.rows[0].id);
    }
    res.json({ data: result.rows[0] });
  } catch (err) {
    console.error('[costs] pay error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── Settle without paying ───────────────────────────────────────────────────
// "It's already been paid — I'm recording that, not asking you to pay it."
//
// Clears a bill off the OP ledger WITHOUT touching Xero. The everyday case (our
// own bill was paid in Xero) is handled automatically by the daily pull-back
// sync; this is the escape hatch for the rest — no bill in Xero, paid by some
// route OP never saw, or the money landed on a different bill someone keyed by
// hand.
//
// `settled_externally` is persisted rather than being a one-off "skip the push":
// paid + no xero_payment_id is the exact shape three other code paths read as
// "this bill still needs its payment recording in Xero", so without the flag the
// next edit to the row would pay the supplier again. ADMIN_ONLY like /pay — it
// doesn't move money, but it closes the book on money that moved.
const settleExternalSchema = z.object({
  // Required: a clean ledger nobody can explain is worse than a dirty one.
  note: z.string().trim().min(3).max(500),
  // When it was actually settled, if known. Defaults to today.
  paid_date: z.string().trim().max(20).optional().nullable(),
});

router.post('/:id/settle-external', authorize(...ADMIN_ONLY), async (req: AuthRequest, res: Response) => {
  try {
    const parse = settleExternalSchema.safeParse(req.body ?? {});
    if (!parse.success) { res.status(400).json({ error: 'A short note saying how it was settled is required', issues: parse.error.issues }); return; }
    const { note, paid_date } = parse.data;

    const before = await query('SELECT payment_status, approval_state FROM costs WHERE id = $1', [req.params.id]);
    if (!before.rows.length) { res.status(404).json({ error: 'Cost not found' }); return; }
    if (before.rows[0].payment_status === 'paid') {
      res.status(400).json({ error: 'This cost is already marked paid.' });
      return;
    }

    // paid_method stays NULL on purpose — no money left an account we know
    // about, so naming one would invent a bank line that doesn't exist.
    const result = await query(
      `UPDATE costs
       SET approval_state = 'paid', payment_status = 'paid',
           settled_externally = TRUE, settled_externally_note = $1,
           paid_by = $2, paid_at = NOW(),
           paid_value_date = COALESCE($3::date, paid_value_date, CURRENT_DATE)
       WHERE id = $4 RETURNING *`,
      [note, req.user!.id, paid_date || null, req.params.id],
    );
    await audit(req.user!.id, req.params.id as string, 'cost_settled_externally',
      before.rows[0], { payment_status: 'paid', settled_externally: true, note, paid_date: paid_date || null });

    res.json({ data: await withJobLabels(result.rows[0]) });
  } catch (err) {
    console.error('[costs] settle-external error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Ask Xero, now, whether any outstanding bill has already been paid there.
// The same sweep the scheduler runs at 07:50 — on the button, for the day you
// don't want to wait until tomorrow to see the ledger clear.
router.post('/sync-xero-payments', authorize(...ADMIN_ONLY), async (_req: AuthRequest, res: Response) => {
  try {
    const { runCostXeroPaymentSync } = await import('../services/cost-xero-payment-sync');
    const result = await runCostXeroPaymentSync();
    res.json({ data: result });
  } catch (err) {
    console.error('[costs] sync-xero-payments error:', err);
    res.status(500).json({ error: err instanceof Error ? err.message : 'Internal server error' });
  }
});

// Pay MANY bills with ONE Xero batch payment — the monthly garage run. Refuses
// the whole selection if any one bill can't be paid, and creates the batch in
// Xero BEFORE marking anything paid here. See services/cost-batch-pay.ts.
// ADMIN_ONLY, same as /:id/pay: this is money out the door, times twenty.
router.post('/pay-batch', authorize(...ADMIN_ONLY), async (req: AuthRequest, res: Response) => {
  try {
    const parse = z.object({
      cost_ids: z.array(z.string().uuid()).min(1).max(200),
      paid_method: z.string().trim().min(1).max(40),
      paid_date: z.string().trim().max(20).optional().nullable(),
      reference: z.string().trim().max(255).optional().nullable(),
    }).safeParse(req.body ?? {});
    if (!parse.success) { res.status(400).json({ error: 'Invalid input', issues: parse.error.issues }); return; }

    const { payCostsAsBatch } = await import('../services/cost-batch-pay');
    const result = await payCostsAsBatch({
      costIds: parse.data.cost_ids,
      paidMethod: parse.data.paid_method,
      paidDate: parse.data.paid_date ?? null,
      reference: parse.data.reference ?? null,
      userId: req.user!.id,
    });
    // A refusal is a 400 with the reason, not a 500 — the caller can act on it.
    if (result.error) { res.status(400).json({ error: result.error }); return; }
    res.json({ data: result });
  } catch (err) {
    console.error('[costs] pay-batch error:', err);
    // The thrown case is the one where Xero HAS the money and we failed to
    // record it. Surface the message verbatim; it names the batch id.
    res.status(500).json({ error: err instanceof Error ? err.message : 'Internal server error' });
  }
});

// ── Remittance advice ───────────────────────────────────────────────────────
// Optional courtesy email confirming a bill/reimbursement has been (or will be)
// paid. Decoupled from /pay — a bad email must never block/unwind a payment.

// Resolve the payee + address for pre-filling the mark-paid modal's tickbox.
router.get('/:id/remittance-contact', authorize(...ADMIN_ONLY), async (req: AuthRequest, res: Response) => {
  try {
    const cost = await getCostForRemittance(req.params.id as string);
    if (!cost) { res.status(404).json({ error: 'Cost not found' }); return; }
    const contact = await resolveRemittanceContact(cost);
    res.json({ data: contact });
  } catch (err) {
    console.error('[costs] remittance-contact error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

const remittanceSchema = z.object({ email: z.string().trim().email().max(200) });

router.post('/:id/send-remittance', authorize(...ADMIN_ONLY), async (req: AuthRequest, res: Response) => {
  try {
    const parse = remittanceSchema.safeParse(req.body ?? {});
    if (!parse.success) { res.status(400).json({ error: 'A valid recipient email is required' }); return; }
    const result = await sendRemittance(req.params.id as string, parse.data.email);
    if (!result.ok) { res.status(502).json({ error: result.error || 'Send failed' }); return; }
    await audit(req.user!.id, req.params.id as string, 'remittance_sent', null, { email: parse.data.email });
    // A freelancer invoice nobody linked yet: the address staff just chose names
    // the freelancer, so link it (FREELANCER-PORTAL-SPEC §5). Only on a clear,
    // single match, and never over an existing link.
    try {
      const c = await query(`SELECT cost_type, person_id FROM costs WHERE id = $1`, [req.params.id]);
      if (c.rows[0]?.cost_type === 'freelancer_invoice' && !c.rows[0].person_id) {
        const personId = await personIdByEmail(parse.data.email);
        if (personId) {
          await query(`UPDATE costs SET person_id = $1 WHERE id = $2 AND person_id IS NULL`, [personId, req.params.id]);
          await audit(req.user!.id, req.params.id as string, 'cost_person_linked', null, { person_id: personId, from: 'remittance' });
        }
      }
    } catch (linkErr) {
      console.error('[costs] remittance person link failed (non-fatal):', linkErr);
    }
    res.json({ data: { sent: true, email: parse.data.email } });
  } catch (err) {
    console.error('[costs] send-remittance error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── Allocations (bundled invoice split) ─────────────────────────────────────
// Saves the whole split for a cost in one transaction. The rules (shares kept by
// id, a share whose recharge is done stays put, the whole-cost-or-per-job rule)
// live in services/cost-allocations.ts, shared with create / update, which take
// `allocations` in the same request as the cost.

router.put('/:id/allocations', authorize(...STAFF_ROLES), async (req: AuthRequest, res: Response) => {
  try {
    const parse = allocationSchema.safeParse(req.body);
    if (!parse.success) { res.status(400).json({ error: 'Invalid input', issues: parse.error.issues }); return; }
    const costId = String(req.params.id);

    const exists = await query(
      `SELECT c.id, c.amount_gross, c.cost_intent, c.recharge_mode, c.is_credit, j.hh_job_number
         FROM costs c LEFT JOIN jobs j ON j.id = c.job_id WHERE c.id = $1`,
      [costId],
    );
    if (!exists.rows.length) { res.status(404).json({ error: 'Cost not found' }); return; }

    let plan;
    try {
      plan = await planAllocations(costId, exists.rows[0], parse.data.allocations);
    } catch (e) {
      if (e instanceof AllocationError) { res.status(e.status).json({ error: e.message }); return; }
      throw e;
    }
    await writeAllocations(costId, plan, req.user!.id);

    const result = await query(
      `SELECT a.*, j.hh_job_number, j.job_name FROM cost_allocations a
       LEFT JOIN jobs j ON j.id = a.job_id
       WHERE a.cost_id = $1 ORDER BY a.created_at ASC`,
      [costId],
    );
    res.json({ data: result.rows });
  } catch (err) {
    console.error('[costs] allocations error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Confirm a near-miss supplier match: "yes, that printed name IS this Xero
// contact". Remembered as an alias so nobody is asked about it again — the
// human goes the last mile once, not every time.
router.post('/supplier-alias', authorize(...STAFF_ROLES), async (req: AuthRequest, res: Response) => {
  try {
    const parse = z.object({
      printed_name: z.string().trim().min(1).max(200),
      xero_contact_id: z.string().trim().min(1).max(60),
      xero_name: z.string().trim().min(1).max(200),
    }).safeParse(req.body);
    if (!parse.success) { res.status(400).json({ error: 'Invalid input', issues: parse.error.issues }); return; }
    const { rememberSupplierAlias } = await import('../services/supplier-match');
    await rememberSupplierAlias(parse.data.printed_name, parse.data.xero_contact_id, parse.data.xero_name, req.user!.id);
    res.json({ data: { remembered: true } });
  } catch (err) {
    console.error('[costs] supplier-alias error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
