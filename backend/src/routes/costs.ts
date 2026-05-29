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
import { query } from '../config/database';
import { authenticate, authorize, AuthRequest, STAFF_ROLES } from '../middleware/auth';

const router = Router();
router.use(authenticate);

// Manager+ can verify a payable; only admin can approve / mark paid.
const VERIFY_ROLES = ['admin', 'manager'] as const;
const ADMIN_ONLY = ['admin'] as const;

// ── Schemas ─────────────────────────────────────────────────────────────────

const COST_TYPES = ['overhead', 'job', 'vehicle', 'stock', 'parts', 'freelancer_invoice'] as const;
const PAYMENT_METHODS = ['cot_card', 'petty_cash', 'paypal', 'reimburse_me', 'not_yet_paid', 'other'] as const;
const PAYMENT_STATUSES = ['paid', 'awaiting_payment', 'awaiting_invoice'] as const;
const RECHARGE_MODES = ['none', 'full', 'partial'] as const;

const money = z.number().nonnegative().finite();

const createSchema = z.object({
  supplier_name: z.string().trim().max(200).optional().nullable(),
  cost_date: z.string().trim().max(20).optional().nullable(),
  amount_gross: money.optional().nullable(),
  amount_vat: money.optional().nullable(),
  amount_net: money.optional().nullable(),
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
  receipt_r2_key: z.string().trim().max(500).optional().nullable(),
  receipt_filename: z.string().trim().max(200).optional().nullable(),
  status: z.enum(['draft', 'confirmed', 'resolved']).optional(),
  notes: z.string().trim().max(10000).optional().nullable(),
});

// Update accepts the same fields, all optional.
const updateSchema = createSchema.partial();

const rechargeSchema = z.object({
  recharge_mode: z.enum(['full', 'partial']),
  recharge_amount: money.optional().nullable(),
});

const allocationSchema = z.object({
  allocations: z.array(z.object({
    job_id: z.string().uuid().optional().nullable(),
    quote_assignment_id: z.string().uuid().optional().nullable(),
    amount: money,
    recharge: z.boolean().optional(),
    notes: z.string().trim().max(2000).optional().nullable(),
  })).min(1),
});

// Columns a staff member may set directly via create/update (whitelist —
// workflow timestamps + Xero state are server-controlled).
const WRITABLE = [
  'supplier_name', 'cost_date', 'amount_gross', 'amount_vat', 'amount_net', 'currency',
  'description', 'category', 'xero_account_code', 'cost_type', 'payment_method',
  'cot_card_holder', 'cot_card_last4', 'payment_status', 'job_id', 'vehicle_id',
  'quote_assignment_id', 'platform_issue_id', 'vehicle_service_log_id', 'vehicle_fuel_log_id',
  'recharge_mode', 'recharge_amount', 'receipt_r2_key', 'receipt_filename', 'status', 'notes',
] as const;

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
    const { view, cost_type, status, payment_status, job_id, vehicle_id, search, limit = '200' } = req.query;

    const conditions: string[] = [];
    const params: unknown[] = [];

    if (view === 'payable') {
      conditions.push(`c.payment_status <> 'paid'`);
    } else if (view === 'recharge') {
      conditions.push(`c.recharge_mode <> 'none' AND c.recharged_to_hh_at IS NULL`);
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
        fv.reg AS vehicle_reg
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

    // Headline counts for the hub tabs.
    const stats = await query(`
      SELECT
        COUNT(*) FILTER (WHERE payment_status <> 'paid')::int AS payable,
        COUNT(*) FILTER (WHERE recharge_mode <> 'none' AND recharged_to_hh_at IS NULL)::int AS recharge_pending,
        COUNT(*) FILTER (WHERE payment_method = 'cot_card' AND xero_sync_state <> 'reconciled')::int AS reconcile_pending,
        COALESCE(SUM(amount_gross) FILTER (WHERE payment_status <> 'paid'), 0)::numeric AS payable_total
      FROM costs
    `);

    res.json({ data: result.rows, stats: stats.rows[0] });
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
  const outstanding = result.rows.filter(
    (r) => r.status !== 'resolved' || (r.recharge_mode !== 'none' && !r.recharged_to_hh_at) || r.payment_status !== 'paid',
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

router.get('/xero/accounts', authorize(...VERIFY_ROLES), async (_req: AuthRequest, res: Response) => {
  try {
    const { isXeroConfigured } = await import('../config/xero');
    if (!isXeroConfigured()) {
      return res.status(503).json({ error: 'Xero not configured (XERO_CLIENT_ID / XERO_CLIENT_SECRET missing)' });
    }
    const { xeroBroker } = await import('../services/xero-broker');
    const accounts = await xeroBroker.getAccounts();
    res.json({ data: accounts });
  } catch (err) {
    console.error('[costs] xero accounts error:', err);
    res.status(502).json({ error: 'Xero request failed', detail: err instanceof Error ? err.message : String(err) });
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
    res.json({ data: { ...result.rows[0], allocations: allocations.rows } });
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

    // A payable (not yet paid / awaiting payment) enters the approval workflow.
    // If the booker is uploading it, they vouch for it inline → 'verified'.
    let approvalState: string | null = null;
    if (data.payment_status === 'not_yet_paid' || data.payment_status === 'awaiting_payment') {
      approvalState = 'verified';
    }

    const cols = ['uploaded_by', 'approval_state'];
    const vals: unknown[] = [req.user!.id, approvalState];
    for (const c of WRITABLE) {
      if (data[c] !== undefined) { cols.push(c); vals.push(data[c]); }
    }
    const placeholders = vals.map((_, i) => `$${i + 1}`).join(', ');

    const result = await query(
      `INSERT INTO costs (${cols.join(', ')}) VALUES (${placeholders}) RETURNING *`,
      vals,
    );
    res.status(201).json({ data: result.rows[0] });
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
    res.json({ data: result.rows[0] });
  } catch (err) {
    console.error('[costs] update error:', err);
    res.status(500).json({ error: 'Internal server error' });
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

    const amount = recharge_mode === 'full' ? (cost.amount_gross ?? recharge_amount) : recharge_amount;
    const result = await query(
      `UPDATE costs SET recharge_mode = $1, recharge_amount = $2 WHERE id = $3 RETURNING *`,
      [recharge_mode, amount, req.params.id],
    );
    await audit(req.user!.id, req.params.id as string, 'recharge_flag',
      { recharge_mode: cost.recharge_mode, recharge_amount: cost.recharge_amount },
      { recharge_mode, recharge_amount: amount });
    res.json({ data: result.rows[0], hh_pushed: false, note: 'Recharge flagged. HireHop push pending stock-item config.' });
  } catch (err) {
    console.error('[costs] recharge error:', err);
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

router.post('/:id/approve', authorize(...ADMIN_ONLY), async (req: AuthRequest, res: Response) => {
  try {
    const result = await query(
      `UPDATE costs SET approval_state = 'approved', approved_by = $1, approved_at = NOW()
       WHERE id = $2 RETURNING *`,
      [req.user!.id, req.params.id],
    );
    if (!result.rows.length) { res.status(404).json({ error: 'Cost not found' }); return; }
    await audit(req.user!.id, req.params.id as string, 'cost_approved', null, { approval_state: 'approved' });
    res.json({ data: result.rows[0] });
  } catch (err) {
    console.error('[costs] approve error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

const paySchema = z.object({
  paid_method: z.string().trim().max(40).optional().nullable(),
  paid_date: z.string().trim().max(20).optional().nullable(),
});

router.post('/:id/pay', authorize(...ADMIN_ONLY), async (req: AuthRequest, res: Response) => {
  try {
    const parse = paySchema.safeParse(req.body ?? {});
    if (!parse.success) { res.status(400).json({ error: 'Invalid input', issues: parse.error.issues }); return; }
    const { paid_method } = parse.data;

    const result = await query(
      `UPDATE costs
       SET approval_state = 'paid', payment_status = 'paid',
           paid_by = $1, paid_at = NOW(), paid_method = COALESCE($2, paid_method)
       WHERE id = $3 RETURNING *`,
      [req.user!.id, paid_method ?? null, req.params.id],
    );
    if (!result.rows.length) { res.status(404).json({ error: 'Cost not found' }); return; }
    await audit(req.user!.id, req.params.id as string, 'cost_paid', null, { approval_state: 'paid', paid_method });
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
