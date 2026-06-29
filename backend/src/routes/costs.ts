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
import { authenticate, authorize, AuthRequest, STAFF_ROLES } from '../middleware/auth';

const router = Router();
router.use(authenticate);

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

const money = z.number().nonnegative().finite();

const createSchema = z.object({
  supplier_name: z.string().trim().max(200).optional().nullable(),
  cost_date: z.string().trim().max(20).optional().nullable(),
  amount_gross: money.optional().nullable(),
  amount_vat: money.optional().nullable(),
  amount_net: money.optional().nullable(),
  vat_treatment: z.enum(['standard', 'reclaim_split']).optional(),
  invoice_number: z.string().trim().max(100).optional().nullable(),
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
  platform_issue_id: z.string().uuid().optional().nullable(),
  vehicle_service_log_id: z.string().uuid().optional().nullable(),
  vehicle_fuel_log_id: z.string().uuid().optional().nullable(),
  recharge_mode: z.enum(RECHARGE_MODES).optional(),
  recharge_amount: money.optional().nullable(),
  cost_intent: z.enum(['quote_actual', 'extra']).optional().nullable(),
  receipt_r2_key: z.string().trim().max(500).optional().nullable(),
  receipt_filename: z.string().trim().max(200).optional().nullable(),
  status: z.enum(['draft', 'confirmed', 'resolved']).optional(),
  notes: z.string().trim().max(10000).optional().nullable(),
  // Control flag (not a column): one-click "Approve & save" on a payable.
  // Honoured only for admin/manager + a payable; ignored otherwise.
  approve: z.boolean().optional(),
});

// Update accepts the same fields, all optional.
const updateSchema = createSchema.partial();

const rechargeSchema = z.object({
  recharge_mode: z.enum(['full', 'partial']),
  recharge_amount: money.optional().nullable(),
});

const allocationSchema = z.object({
  // Empty array clears the split (deletes all allocations for the cost).
  allocations: z.array(z.object({
    job_id: z.string().uuid().optional().nullable(),
    quote_assignment_id: z.string().uuid().optional().nullable(),
    amount: money,
    recharge: z.boolean().optional(),
    notes: z.string().trim().max(2000).optional().nullable(),
  })),
});

// Columns a staff member may set directly via create/update (whitelist —
// workflow timestamps + Xero state are server-controlled).
const WRITABLE = [
  'supplier_name', 'cost_date', 'amount_gross', 'amount_vat', 'amount_net', 'vat_treatment',
  'invoice_number', 'xero_contact_id', 'currency',
  'description', 'category', 'xero_account_code', 'cost_type', 'payment_method',
  'cot_card_holder', 'cot_card_last4', 'payment_status', 'job_id', 'vehicle_id',
  'quote_assignment_id', 'platform_issue_id', 'vehicle_service_log_id', 'vehicle_fuel_log_id',
  'recharge_mode', 'recharge_amount', 'recharge_status', 'cost_intent', 'receipt_r2_key', 'receipt_filename', 'status', 'notes',
] as const;

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
const TERMINAL_RECHARGE = new Set(['recharged_hh', 'recharged_external', 'absorbed']);
function deriveRechargeStatusForWrite(data: Record<string, unknown>, current?: string | null) {
  if (data.recharge_mode === undefined) return; // recharge not being touched
  if (data.recharge_mode === 'none') {
    data.recharge_status = null;
  } else if (!current || !TERMINAL_RECHARGE.has(current)) {
    // Flagging (or re-flagging) for recharge and not already resolved → pending.
    data.recharge_status = 'pending';
  }
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
    const { view, cost_type, status, payment_status, job_id, vehicle_id, search, missing_receipt, mine, limit = '200' } = req.query;

    const conditions: string[] = [];
    const params: unknown[] = [];

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
    } else if (view === 'recharge') {
      // Pending = flagged for recharge and not yet resolved (pushed/external/absorbed).
      conditions.push(`c.recharge_mode <> 'none' AND COALESCE(c.recharge_status, 'pending') = 'pending'`);
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
      conditions.push(`c.job_id = $${params.length}`);
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
    params.push(Math.min(parseInt(limit as string, 10) || 200, 500));

    const sql = `
      SELECT c.*,
        CONCAT(up.first_name, ' ', up.last_name) AS uploaded_by_name,
        j.hh_job_number, j.job_name,
        fv.reg AS vehicle_reg,
        (SELECT COUNT(*)::int FROM cost_allocations a WHERE a.cost_id = c.id) AS allocation_count
      FROM costs c
      LEFT JOIN users u   ON u.id = c.uploaded_by
      LEFT JOIN people up ON up.id = u.person_id
      LEFT JOIN jobs j    ON j.id = c.job_id
      LEFT JOIN fleet_vehicles fv ON fv.id = c.vehicle_id
      ${whereClause}
      ORDER BY c.created_at DESC
      LIMIT $${params.length}
    `;
    const result = await query(sql, params);

    // Resolve per-supplier payment terms in one query and attach the computed
    // due date (+ the terms that produced it) to each row. Single source of
    // truth for the bill due date — the list, mark-paid modal and Xero push all
    // read these. See docs/COSTS-PAYMENT-AUTOMATION-SPEC.md.
    const { buildTermsResolver, computeDueDate, freelancerDueDate } = await import('../services/supplier-terms');
    const resolve = await buildTermsResolver(
      result.rows.map((r) => ({ xeroContactId: r.xero_contact_id, supplierName: r.supplier_name })),
    );
    const rows = result.rows.map((r) => {
      // Freelancer invoices follow Ooosh terms (first Friday +1wk after approval),
      // not supplier/Xero terms. The Friday date only exists once approved — until
      // then we fall back to the standard terms display.
      if (r.cost_type === 'freelancer_invoice' && r.approved_at) {
        const terms = { basis: 'invoice_date' as const, days: 0, source: 'freelancer' as const };
        return { ...r, terms, due_date: freelancerDueDate(r.approved_at) };
      }
      const terms = resolve({ xeroContactId: r.xero_contact_id, supplierName: r.supplier_name });
      return { ...r, terms, due_date: computeDueDate(r.cost_date, terms) };
    });

    // Headline counts for the hub tabs.
    const stats = await query(`
      SELECT
        COUNT(*) FILTER (WHERE payment_status <> 'paid')::int AS payable,
        COUNT(*) FILTER (WHERE recharge_mode <> 'none' AND COALESCE(recharge_status, 'pending') = 'pending')::int AS recharge_pending,
        COUNT(*) FILTER (WHERE payment_method = 'cot_card' AND xero_sync_state <> 'reconciled')::int AS reconcile_pending,
        COALESCE(SUM(amount_gross) FILTER (WHERE payment_status <> 'paid'), 0)::numeric AS payable_total
      FROM costs
    `);

    res.json({ data: rows, stats: stats.rows[0] });
  } catch (err) {
    console.error('[costs] list error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── Facet lookups ───────────────────────────────────────────────────────────

async function listBy(column: string, value: string, res: Response) {
  const result = await query(
    `SELECT c.*, CONCAT(up.first_name, ' ', up.last_name) AS uploaded_by_name
     FROM costs c
     LEFT JOIN users u ON u.id = c.uploaded_by
     LEFT JOIN people up ON up.id = u.person_id
     WHERE c.${column} = $1
     ORDER BY c.created_at DESC`,
    [value],
  );
  // Outstanding = anything not fully resolved (powers the close-out flag).
  // A recharge is unresolved while flagged but still 'pending' (not pushed to HH,
  // billed externally, or absorbed).
  const outstanding = result.rows.filter(
    (r) => r.status !== 'resolved'
      || (r.recharge_mode !== 'none' && (r.recharge_status ?? 'pending') === 'pending')
      || r.payment_status !== 'paid',
  ).length;
  res.json({ data: result.rows, outstanding });
}

router.get('/by-job/:jobId', async (req: AuthRequest, res: Response) => {
  try { await listBy('job_id', req.params.jobId as string, res); }
  catch (err) { console.error('[costs] by-job error:', err); res.status(500).json({ error: 'Internal server error' }); }
});

router.get('/by-vehicle/:vehicleId', async (req: AuthRequest, res: Response) => {
  try { await listBy('vehicle_id', req.params.vehicleId as string, res); }
  catch (err) { console.error('[costs] by-vehicle error:', err); res.status(500).json({ error: 'Internal server error' }); }
});

router.get('/by-issue/:issueId', async (req: AuthRequest, res: Response) => {
  try { await listBy('platform_issue_id', req.params.issueId as string, res); }
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
         j.hh_job_number, j.job_name, fv.reg AS vehicle_reg
       FROM costs c
       LEFT JOIN users u   ON u.id = c.uploaded_by
       LEFT JOIN people up ON up.id = u.person_id
       LEFT JOIN jobs j    ON j.id = c.job_id
       LEFT JOIN fleet_vehicles fv ON fv.id = c.vehicle_id
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
    const cost = result.rows[0];
    const { resolveTermsForSupplier, computeDueDate } = await import('../services/supplier-terms');
    const terms = await resolveTermsForSupplier(cost.xero_contact_id, cost.supplier_name);
    res.json({ data: { ...cost, terms, due_date: computeDueDate(cost.cost_date, terms), allocations: allocations.rows } });
  } catch (err) {
    console.error('[costs] get error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── Create ──────────────────────────────────────────────────────────────────

router.post('/', authorize(...STAFF_ROLES), async (req: AuthRequest, res: Response) => {
  try {
    const parse = createSchema.safeParse(req.body);
    if (!parse.success) { res.status(400).json({ error: 'Invalid input', issues: parse.error.issues }); return; }
    const data = parse.data as Record<string, unknown>;
    coerceRechargeForIntent(data);
    deriveRechargeStatusForWrite(data);

    // A payable (anything not already paid) enters the approval workflow. If the
    // booker is uploading it, they vouch for it inline → 'verified'. An approver
    // (admin/manager) can one-click "Approve & save" to skip straight to
    // 'approved' (which fires the bill push for pay-later methods).
    const isPayable = Boolean(data.payment_status && data.payment_status !== 'paid');
    const canApprove = ['admin', 'manager'].includes(req.user!.role);
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

    res.status(201).json({ data: created });
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

    // Keep recharge_status in step if recharge_mode is being changed — but never
    // clobber a terminal resolution (already pushed/absorbed) back to pending.
    if (data.recharge_mode !== undefined) {
      const cur = await query('SELECT recharge_status FROM costs WHERE id = $1', [req.params.id]);
      deriveRechargeStatusForWrite(data, cur.rows[0]?.recharge_status ?? null);
    }

    const sets: string[] = [];
    const vals: unknown[] = [];
    for (const c of WRITABLE) {
      if (data[c] !== undefined) { vals.push(data[c]); sets.push(`${c} = $${vals.length}`); }
    }
    if (!sets.length) { res.status(400).json({ error: 'No updatable fields supplied' }); return; }

    vals.push(req.params.id);
    const result = await query(
      `UPDATE costs SET ${sets.join(', ')} WHERE id = $${vals.length} RETURNING *`,
      vals,
    );
    if (!result.rows.length) { res.status(404).json({ error: 'Cost not found' }); return; }

    const updated = result.rows[0];
    const alreadyPushed = Boolean(updated.xero_object_id) && ['bill_created', 'attached', 'reconciled'].includes(updated.xero_sync_state);

    if (alreadyPushed) {
      // Already in Xero — we can't silently re-push (it may be reconciled). If a
      // Xero-affecting field changed, flag it stale so the UI warns + offers a
      // manual "Re-sync to Xero". Non-Xero edits (notes, payment_status) leave it alone.
      const XERO_AFFECTING = ['amount_net', 'amount_vat', 'amount_gross', 'xero_account_code',
        'supplier_name', 'description', 'vat_treatment', 'cost_date', 'payment_method', 'invoice_number'];
      if (XERO_AFFECTING.some((f) => data[f] !== undefined) && !updated.xero_stale) {
        const s = await query(`UPDATE costs SET xero_stale=TRUE WHERE id=$1 RETURNING xero_stale`, [updated.id]);
        updated.xero_stale = s.rows[0]?.xero_stale ?? true;
      }
    } else if (!updated.xero_object_id || updated.xero_sync_state === 'error' || updated.xero_sync_state === 'pending') {
      // Not yet in Xero — background push (the service guards on state).
      const { pushCostToXeroBackground } = await import('../services/cost-xero-push');
      pushCostToXeroBackground(updated.id);
    }

    // Seed terms from Xero if a contact id was just attached and none exist yet.
    if (updated.xero_contact_id) {
      void import('../services/supplier-terms')
        .then((m) => m.seedTermsFromXeroIfMissing(updated.xero_contact_id, updated.supplier_name))
        .catch(() => { /* non-fatal — staff can set terms manually */ });
    }

    res.json({ data: updated });
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
    const { pushCostToXero } = await import('../services/cost-xero-push');
    const result = await pushCostToXero(id);
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

async function persistRechargeFigures(costId: string, figures: z.infer<typeof rechargeFiguresSchema>) {
  const sets: string[] = [];
  const vals: unknown[] = [];
  const push = (col: string, v: unknown) => { vals.push(v); sets.push(`${col} = $${vals.length}`); };
  if (figures.recharge_mode !== undefined) push('recharge_mode', figures.recharge_mode);
  else if (figures.recharge_amount != null) push('recharge_mode', 'full'); // base given, no mode → treat as full
  if (figures.recharge_amount !== undefined) push('recharge_amount', figures.recharge_amount);
  if (figures.recharge_base_amount !== undefined) push('recharge_base_amount', figures.recharge_base_amount);
  if (figures.recharge_markup_type !== undefined) push('recharge_markup_type', figures.recharge_markup_type);
  if (figures.recharge_markup_value !== undefined) push('recharge_markup_value', figures.recharge_markup_value);
  if (!sets.length) return;
  vals.push(costId);
  await query(`UPDATE costs SET ${sets.join(', ')} WHERE id = $${vals.length}`, vals);
}

// Push the flagged recharge to HireHop as a billable hire line. Explicit staff
// action (never auto-fires). Idempotent — a cost already recharged is a no-op.
// Optional body carries the resolve modal's final figure + markup breakdown.
router.post('/:id/push-recharge', authorize(...STAFF_ROLES), async (req: AuthRequest, res: Response) => {
  try {
    const costId = String(req.params.id);
    const figures = rechargeFiguresSchema.safeParse(req.body || {});
    if (figures.success) await persistRechargeFigures(costId, figures.data);

    const { pushRechargeToHH } = await import('../services/cost-recharge-hh');
    const result = await pushRechargeToHH(costId);
    if (result.pushed) {
      await audit(req.user!.id, costId, 'recharge_pushed', null,
        { hh_job: result.hhJobNumber, amount: result.amount, stock: result.stockLabel });
      // Refresh the post-hire close-out card now this recharge is resolved.
      const job = await query('SELECT job_id FROM costs WHERE id = $1', [costId]);
      if (job.rows[0]?.job_id) {
        const { syncCostResolveRequirementStatus } = await import('../services/cost-requirement-sync');
        await syncCostResolveRequirementStatus(job.rows[0].job_id).catch(() => { /* non-fatal */ });
      }
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
});

router.post('/:id/resolve-recharge', authorize(...STAFF_ROLES), async (req: AuthRequest, res: Response) => {
  try {
    const parse = resolveRechargeSchema.safeParse(req.body);
    if (!parse.success) { res.status(400).json({ error: 'Invalid input', issues: parse.error.issues }); return; }
    const { resolution, note, ...figures } = parse.data;
    if (resolution === 'absorbed' && !note?.trim()) {
      res.status(400).json({ error: 'A reason is required to absorb / write off a recharge.' }); return;
    }
    const costId = String(req.params.id);
    const existing = await query('SELECT * FROM costs WHERE id = $1', [costId]);
    if (!existing.rows.length) { res.status(404).json({ error: 'Cost not found' }); return; }
    const before = existing.rows[0];
    if (before.cost_intent === 'quote_actual') {
      res.status(400).json({ error: 'This cost is part of a quote (already billed via the quote) — it has no recharge to resolve.' }); return;
    }

    await persistRechargeFigures(costId, figures);
    // Flag for recharge if it wasn't already (so an unflagged extra cost can be
    // resolved in one step), then stamp the terminal resolution.
    const result = await query(
      `UPDATE costs SET
         recharge_mode = CASE WHEN recharge_mode = 'none' OR recharge_mode IS NULL THEN 'full' ELSE recharge_mode END,
         recharge_status = $1,
         recharge_resolution_note = $2,
         recharge_resolved_by = $3,
         recharge_resolved_at = NOW()
       WHERE id = $4 RETURNING *`,
      [resolution, note?.trim() || null, req.user!.id, costId],
    );
    await audit(req.user!.id, costId, 'recharge_resolved',
      { recharge_status: before.recharge_status },
      { recharge_status: resolution, note: note?.trim() || null });

    // Refresh the post-hire close-out card.
    if (result.rows[0]?.job_id) {
      const { syncCostResolveRequirementStatus } = await import('../services/cost-requirement-sync');
      await syncCostResolveRequirementStatus(result.rows[0].job_id).catch(() => { /* non-fatal */ });
    }
    res.json({ data: result.rows[0] });
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
      `UPDATE costs SET approval_state = 'approved', approved_by = $1, approved_at = NOW()
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

// ── Allocations (bundled invoice split) ─────────────────────────────────────
// Replaces all allocations for a cost in one transaction.

router.put('/:id/allocations', authorize(...STAFF_ROLES), async (req: AuthRequest, res: Response) => {
  try {
    const parse = allocationSchema.safeParse(req.body);
    if (!parse.success) { res.status(400).json({ error: 'Invalid input', issues: parse.error.issues }); return; }
    const { allocations } = parse.data;

    const exists = await query('SELECT id FROM costs WHERE id = $1', [req.params.id]);
    if (!exists.rows.length) { res.status(404).json({ error: 'Cost not found' }); return; }

    await query('BEGIN');
    try {
      await query('DELETE FROM cost_allocations WHERE cost_id = $1', [req.params.id]);
      for (const a of allocations) {
        await query(
          `INSERT INTO cost_allocations (cost_id, job_id, quote_assignment_id, amount, recharge, notes)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [req.params.id, a.job_id ?? null, a.quote_assignment_id ?? null, a.amount, a.recharge ?? false, a.notes ?? null],
        );
      }
      await query('COMMIT');
    } catch (txErr) {
      await query('ROLLBACK');
      throw txErr;
    }

    const result = await query(
      `SELECT a.*, j.hh_job_number, j.job_name FROM cost_allocations a
       LEFT JOIN jobs j ON j.id = a.job_id
       WHERE a.cost_id = $1 ORDER BY a.created_at ASC`,
      [req.params.id],
    );
    res.json({ data: result.rows });
  } catch (err) {
    console.error('[costs] allocations error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
