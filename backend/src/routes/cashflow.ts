/**
 * Cash forecast — admin only (docs/CASHFLOW-FORECAST-SPEC.md).
 *
 *   GET  /forecast                 the whole page (?fresh=1 re-reads Xero + Stripe)
 *   GET/PUT /settings              target, overdraft, YouLend, Stripe, excess timing
 *   GET  /check-in, POST /check-in the Monday balances (accounts + cards)
 *   /accounts, /cards              where the cash is, and the cards' terms
 *   /planned                       planned items — rules and schedules
 *   GET  /xero/bills               unpaid Xero bills, with what jon has said about each
 *   PUT  /bill-flags/:id           "paid — Xero is behind" / "paid by card" / "ignore"
 *   PUT  /excluded-contacts/:id    leave every bill from a supplier out
 *   GET  /xero/contacts            supplier search, for linking a planned item
 *
 * Nothing here writes to Xero, Stripe or HireHop. These are jon's planning
 * inputs, nothing more.
 */
import { Router, Response } from 'express';
import { z } from 'zod';
import { authenticate, authorize, AuthRequest } from '../middleware/auth';
import { validate } from '../middleware/validate';
import { getClient, query } from '../config/database';
import { buildForecast } from '../services/cashflow-forecast';
import {
  RECEIPT_SPEND_DAYS, SETTING_FIELDS, cardReceiptSpend, forgetXeroBillsCache, loadAccounts, loadCardReceipts, loadBillFlags, loadCards, loadPlannedItems,
  loadSettings, loadXeroBills, measureStripeShare, readStripe,
} from '../services/cashflow-sources';
import { addDays, isIsoDate, nextDates } from '../services/cashflow-schedule';
import { ukToday } from '../services/uk-date';
import { isXeroConfigured } from '../config/xero';
import { xeroBroker } from '../services/xero-broker';

const router = Router();
router.use(authenticate);
// The YouLend balance, the overdraft and the card figures are for the admin only.
router.use(authorize('admin'));

const isoDate = z.string().refine((v) => isIsoDate(v), 'must be a date (YYYY-MM-DD)');
const money = z.number().finite().min(-10_000_000).max(10_000_000);
const day = z.number().int().min(1).max(31);
const idParam = z.object({ id: z.string().guid() });

function fail(res: Response, where: string, err: unknown) {
  console.error(`[cashflow] ${where}:`, err);
  res.status(500).json({ error: 'Something went wrong — please try again.' });
}

// ── The forecast ───────────────────────────────────────────────────────────

router.get('/forecast', async (req: AuthRequest, res: Response) => {
  try {
    res.json({ data: await buildForecast({ fresh: req.query.fresh === '1' }) });
  } catch (err) {
    fail(res, 'forecast', err);
  }
});

// ── Settings ───────────────────────────────────────────────────────────────

router.get('/settings', async (_req: AuthRequest, res: Response) => {
  try {
    const [settings, measured] = await Promise.all([loadSettings(), measureStripeShare()]);
    res.json({ data: { settings, measuredStripeShare: measured } });
  } catch (err) {
    fail(res, 'settings', err);
  }
});

const settingsSchema = z.object({
  targetFloor: money.optional(),
  overdraftLimit: z.number().finite().min(0).max(10_000_000).optional(),
  youlendRate: z.number().min(0).max(1).optional(),
  youlendRemaining: z.number().min(0).max(10_000_000).optional(),
  youlendAsOf: isoDate.nullable().optional(),
  stripeShare: z.number().min(0).max(1).optional(),
  stripeFeeRate: z.number().min(0).max(0.2).optional(),
  stripePayoutDays: z.number().int().min(0).max(30).optional(),
  excessRefundDays: z.number().int().min(0).max(120).optional(),
  countOverdueBills: z.boolean().optional(),
  countOverdueBalances: z.boolean().optional(),
  suggestBankTransfer: z.boolean().optional(),
}).strict();

router.put('/settings', validate(settingsSchema), async (req: AuthRequest, res: Response) => {
  try {
    const body = req.body as Record<string, unknown>;
    for (const f of SETTING_FIELDS) {
      if (!(f.field in body)) continue;
      const v = body[f.field];
      const text = v === null || v === undefined ? null : String(v);
      await query(
        `INSERT INTO cashflow_settings (key, value, updated_at, updated_by) VALUES ($1, $2, NOW(), $3)
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW(), updated_by = EXCLUDED.updated_by`,
        [f.key, text, req.user!.id],
      );
    }
    res.json({ data: await loadSettings() });
  } catch (err) {
    fail(res, 'settings update', err);
  }
});

// ── The Monday check-in ────────────────────────────────────────────────────

router.get('/check-in', async (_req: AuthRequest, res: Response) => {
  try {
    const [accounts, cards, stripe] = await Promise.all([loadAccounts(), loadCards(), readStripe(true)]);
    res.json({
      data: {
        today: ukToday(),
        accounts,
        cards,
        stripe: stripe.ok
          ? { live: true, available: stripe.available, pending: stripe.pending.reduce((s, p) => s + p.amount, 0) }
          : { live: false, reason: stripe.reason },
      },
    });
  } catch (err) {
    fail(res, 'check-in read', err);
  }
});

const checkInSchema = z.object({
  asOf: isoDate,
  accounts: z.array(z.object({ id: z.string().guid(), balance: money })).max(50),
  cards: z.array(z.object({ id: z.string().guid(), balance: money })).max(50),
});

router.post('/check-in', validate(checkInSchema), async (req: AuthRequest, res: Response) => {
  const body = req.body as z.infer<typeof checkInSchema>;
  if (body.asOf > ukToday()) {
    res.status(400).json({ error: "A check-in can't be dated in the future." });
    return;
  }
  const client = await getClient();
  try {
    await client.query('BEGIN');
    for (const a of body.accounts) {
      await client.query(
        `INSERT INTO cashflow_balance_snapshots (account_id, balance, as_of, entered_by) VALUES ($1, $2, $3, $4)`,
        [a.id, a.balance, body.asOf, req.user!.id],
      );
    }
    for (const c of body.cards) {
      await client.query(
        `INSERT INTO cashflow_balance_snapshots (card_id, balance, as_of, entered_by) VALUES ($1, $2, $3, $4)`,
        [c.id, c.balance, body.asOf, req.user!.id],
      );
    }
    await client.query('COMMIT');
    res.json({ data: { saved: body.accounts.length + body.cards.length } });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    fail(res, 'check-in save', err);
  } finally {
    client.release();
  }
});

// ── Accounts ───────────────────────────────────────────────────────────────

router.get('/accounts', async (req: AuthRequest, res: Response) => {
  try {
    res.json({ data: await loadAccounts(req.query.all === '1') });
  } catch (err) {
    fail(res, 'accounts', err);
  }
});

const accountSchema = z.object({
  name: z.string().trim().min(1).max(100),
  kind: z.enum(['bank', 'savings', 'cash', 'stripe']),
  isMain: z.boolean().optional(),
  isActive: z.boolean().optional(),
});

router.post('/accounts', validate(accountSchema), async (req: AuthRequest, res: Response) => {
  try {
    const b = req.body as z.infer<typeof accountSchema>;
    const r = await query(
      `INSERT INTO cashflow_accounts (name, kind, is_main, sort_order)
       VALUES ($1, $2, $3, COALESCE((SELECT MAX(sort_order) FROM cashflow_accounts), 0) + 10) RETURNING id`,
      [b.name, b.kind, !!b.isMain],
    );
    if (b.isMain) await query(`UPDATE cashflow_accounts SET is_main = FALSE WHERE id <> $1`, [r.rows[0].id]);
    res.json({ data: { id: r.rows[0].id } });
  } catch (err) {
    fail(res, 'account create', err);
  }
});

router.patch('/accounts/:id', validate(idParam, 'params'), validate(accountSchema.partial()), async (req: AuthRequest, res: Response) => {
  try {
    const b = req.body as Partial<z.infer<typeof accountSchema>>;
    const r = await query(
      `UPDATE cashflow_accounts SET
         name = COALESCE($2, name), kind = COALESCE($3, kind),
         is_main = COALESCE($4, is_main), is_active = COALESCE($5, is_active)
       WHERE id = $1 RETURNING id`,
      [req.params.id, b.name ?? null, b.kind ?? null, b.isMain ?? null, b.isActive ?? null],
    );
    if (!r.rows.length) { res.status(404).json({ error: 'Account not found' }); return; }
    if (b.isMain) await query(`UPDATE cashflow_accounts SET is_main = FALSE WHERE id <> $1`, [req.params.id]);
    res.json({ data: { id: req.params.id } });
  } catch (err) {
    fail(res, 'account update', err);
  }
});

// ── Cards ──────────────────────────────────────────────────────────────────

router.get('/cards', async (req: AuthRequest, res: Response) => {
  try {
    // Each card with what its logged receipts say (for the Settings hint).
    const today = ukToday();
    const windowStart = addDays(today, -RECEIPT_SPEND_DAYS + 1);
    const [cards, receipts] = await Promise.all([loadCards(req.query.all === '1'), loadCardReceipts(windowStart)]);
    res.json({
      data: cards.map((c) => {
        const spend = cardReceiptSpend(receipts, c.costPaymentMethod, null, today, windowStart);
        return { ...c, receiptsMonthly: spend.monthly, receiptsCount: spend.count };
      }),
    });
  } catch (err) {
    fail(res, 'cards', err);
  }
});

const cardSchema = z.object({
  name: z.string().trim().min(1).max(100),
  monthlyRate: z.number().min(0).max(0.2),
  statementDay: day.nullable(),
  paymentDay: day.nullable(),
  creditLimit: z.number().min(0).max(10_000_000).nullable(),
  plan: z.enum(['full', 'minimum', 'fixed']),
  minPct: z.number().min(0).max(100).nullable(),
  fixedAmount: z.number().min(0).max(10_000_000).nullable(),
  fixedEvery: z.enum(['week', 'month']).nullable(),
  fixedWeekday: z.number().int().min(1).max(7).nullable(),
  typicalMonthlySpend: z.number().min(0).max(10_000_000).nullable(),
  costPaymentMethod: z.enum(['cot_card', 'amex', 'lloyds_cc']).nullable().optional(),
  isActive: z.boolean().optional(),
});

const METHOD_LABELS: Record<string, string> = { cot_card: 'COT card', amex: 'Amex', lloyds_cc: 'Lloyds card' };

/** One card per Costs payment method (unique index, migration 328). */
async function methodTaken(method: string | null | undefined, exceptId: string | null): Promise<string | null> {
  if (!method) return null;
  const r = await query(
    `SELECT name FROM cashflow_cards WHERE cost_payment_method = $1 AND ($2::uuid IS NULL OR id <> $2::uuid) LIMIT 1`,
    [method, exceptId],
  );
  return r.rows.length ? `${r.rows[0].name} already takes receipts paid by ${METHOD_LABELS[method] || method}.` : null;
}

/** A plan must carry what it needs, or the forecast silently pays nothing. */
function cardProblem(c: z.infer<typeof cardSchema>): string | null {
  if (c.plan !== 'fixed' && !c.paymentDay) return 'Set the payment day.';
  if (c.plan === 'minimum' && !c.minPct) return 'Set the minimum payment %.';
  if (c.plan === 'fixed') {
    if (!c.fixedAmount || !c.fixedEvery) return 'Set the fixed amount and how often.';
    if (c.fixedEvery === 'week' && !c.fixedWeekday) return 'Set the day of the week.';
    if (c.fixedEvery === 'month' && !c.paymentDay) return 'Set the payment day.';
  }
  return null;
}

const cardValues = (c: z.infer<typeof cardSchema>) => [
  c.name, c.monthlyRate, c.statementDay, c.paymentDay, c.creditLimit, c.plan, c.minPct,
  c.fixedAmount, c.fixedEvery, c.fixedWeekday, c.typicalMonthlySpend, c.costPaymentMethod ?? null,
];

router.post('/cards', validate(cardSchema), async (req: AuthRequest, res: Response) => {
  try {
    const c = req.body as z.infer<typeof cardSchema>;
    const problem = cardProblem(c) || await methodTaken(c.costPaymentMethod, null);
    if (problem) { res.status(400).json({ error: problem }); return; }
    const r = await query(
      `INSERT INTO cashflow_cards (name, monthly_rate, statement_day, payment_day, credit_limit, plan, min_pct,
         fixed_amount, fixed_every, fixed_weekday, typical_monthly_spend, cost_payment_method, sort_order)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12, COALESCE((SELECT MAX(sort_order) FROM cashflow_cards), 0) + 10)
       RETURNING id`,
      cardValues(c),
    );
    res.json({ data: { id: r.rows[0].id } });
  } catch (err) {
    fail(res, 'card create', err);
  }
});

router.put('/cards/:id', validate(idParam, 'params'), validate(cardSchema), async (req: AuthRequest, res: Response) => {
  try {
    const c = req.body as z.infer<typeof cardSchema>;
    const problem = cardProblem(c) || await methodTaken(c.costPaymentMethod, String(req.params.id));
    if (problem) { res.status(400).json({ error: problem }); return; }
    const r = await query(
      `UPDATE cashflow_cards SET name = $2, monthly_rate = $3, statement_day = $4, payment_day = $5, credit_limit = $6,
         plan = $7, min_pct = $8, fixed_amount = $9, fixed_every = $10, fixed_weekday = $11, typical_monthly_spend = $12,
         cost_payment_method = CASE WHEN $15::boolean THEN $13 ELSE cost_payment_method END,
         is_active = COALESCE($14, is_active), updated_at = NOW()
       WHERE id = $1 RETURNING id`,
      // An edit that doesn't mention the receipts link keeps it (e.g. "Stop counting").
      [req.params.id, ...cardValues(c), c.isActive ?? null, c.costPaymentMethod !== undefined],
    );
    if (!r.rows.length) { res.status(404).json({ error: 'Card not found' }); return; }
    res.json({ data: { id: req.params.id } });
  } catch (err) {
    fail(res, 'card update', err);
  }
});

// ── Planned items ──────────────────────────────────────────────────────────

router.get('/planned', async (req: AuthRequest, res: Response) => {
  try {
    res.json({ data: await loadPlannedItems(req.query.all === '1') });
  } catch (err) {
    fail(res, 'planned', err);
  }
});

const plannedSchema = z.object({
  label: z.string().trim().min(1).max(200),
  category: z.enum(['overheads', 'payroll', 'vat', 'tax', 'instalments', 'one_off', 'income', 'other']),
  kind: z.enum(['rule', 'schedule']),
  amount: z.number().positive().max(10_000_000).nullable().optional(),
  frequency: z.enum(['once', 'weekly', 'monthly', 'quarterly', 'yearly']).nullable().optional(),
  startDate: isoDate.nullable().optional(),
  endDate: isoDate.nullable().optional(),
  dates: z.array(z.object({ date: isoDate, amount: z.number().positive().max(10_000_000) })).max(520).optional(),
  expectedTotal: z.number().positive().max(10_000_000).nullable().optional(),
  xeroContactId: z.string().max(100).nullable().optional(),
  xeroContactName: z.string().max(200).nullable().optional(),
  xeroBillId: z.string().max(100).nullable().optional(),
  xeroBillLabel: z.string().max(200).nullable().optional(),
  notes: z.string().max(2000).nullable().optional(),
  isActive: z.boolean().optional(),
});
type PlannedBody = z.infer<typeof plannedSchema>;

function plannedProblem(b: PlannedBody): string | null {
  if (b.kind === 'rule') {
    if (!b.amount || !b.frequency || !b.startDate) return 'A repeating payment needs an amount, how often, and a first date.';
    if (b.endDate && b.endDate < b.startDate) return 'The end date is before the first date.';
  } else if (!b.dates || b.dates.length === 0) {
    return 'A schedule needs at least one payment.';
  }
  return null;
}

/** Save the item and (for a schedule) replace its payment rows, in one transaction. */
async function savePlanned(b: PlannedBody, userId: string, id: string | null): Promise<string | null> {
  const client = await getClient();
  try {
    await client.query('BEGIN');
    const isRule = b.kind === 'rule';
    const direction = b.category === 'income' ? 'in' : 'out';
    const values = [
      b.label, b.category, direction, b.kind,
      isRule ? b.amount ?? null : null, isRule ? b.frequency ?? null : null,
      isRule ? b.startDate ?? null : null, isRule ? b.endDate ?? null : null,
      isRule ? null : b.expectedTotal ?? null,
      b.xeroContactId || null, b.xeroContactName || null,
      isRule ? null : b.xeroBillId || null, isRule ? null : b.xeroBillLabel || null,
      b.notes || null,
    ];
    let itemId = id;
    if (id) {
      const r = await client.query(
        `UPDATE cashflow_planned_items SET label = $2, category = $3, direction = $4, kind = $5, amount = $6, frequency = $7,
           start_date = $8, end_date = $9, expected_total = $10, xero_contact_id = $11, xero_contact_name = $12,
           xero_bill_id = $13, xero_bill_label = $14, notes = $15, is_active = COALESCE($16, is_active), updated_at = NOW()
         WHERE id = $1 RETURNING id`,
        [id, ...values, b.isActive ?? null],
      );
      if (!r.rows.length) { await client.query('ROLLBACK'); return null; }
    } else {
      const r = await client.query(
        `INSERT INTO cashflow_planned_items (label, category, direction, kind, amount, frequency, start_date, end_date,
           expected_total, xero_contact_id, xero_contact_name, xero_bill_id, xero_bill_label, notes, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING id`,
        [...values, userId],
      );
      itemId = r.rows[0].id;
    }
    await client.query(`DELETE FROM cashflow_planned_item_dates WHERE item_id = $1`, [itemId]);
    if (!isRule) {
      for (const d of b.dates || []) {
        await client.query(
          `INSERT INTO cashflow_planned_item_dates (item_id, due_date, amount) VALUES ($1, $2, $3)`,
          [itemId, d.date, d.amount],
        );
      }
    }
    await client.query('COMMIT');
    return itemId;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

router.post('/planned', validate(plannedSchema), async (req: AuthRequest, res: Response) => {
  try {
    const b = req.body as PlannedBody;
    const problem = plannedProblem(b);
    if (problem) { res.status(400).json({ error: problem }); return; }
    const id = await savePlanned(b, req.user!.id, null);
    res.json({ data: { id } });
  } catch (err) {
    fail(res, 'planned create', err);
  }
});

router.put('/planned/:id', validate(idParam, 'params'), validate(plannedSchema), async (req: AuthRequest, res: Response) => {
  try {
    const b = req.body as PlannedBody;
    const problem = plannedProblem(b);
    if (problem) { res.status(400).json({ error: problem }); return; }
    const id = await savePlanned(b, req.user!.id, String(req.params.id));
    if (!id) { res.status(404).json({ error: 'Planned item not found' }); return; }
    res.json({ data: { id } });
  } catch (err) {
    fail(res, 'planned update', err);
  }
});

router.delete('/planned/:id', validate(idParam, 'params'), async (req: AuthRequest, res: Response) => {
  try {
    const r = await query(`DELETE FROM cashflow_planned_items WHERE id = $1 RETURNING id`, [req.params.id]);
    if (!r.rows.length) { res.status(404).json({ error: 'Planned item not found' }); return; }
    res.json({ data: { deleted: true } });
  } catch (err) {
    fail(res, 'planned delete', err);
  }
});

const previewSchema = z.object({
  frequency: z.enum(['once', 'weekly', 'monthly', 'quarterly', 'yearly']),
  startDate: isoDate,
  endDate: isoDate.nullable().optional(),
});

// The next three dates a repeating payment falls on — so a mistyped day shows at once.
router.post('/planned/preview', validate(previewSchema), async (req: AuthRequest, res: Response) => {
  const b = req.body as z.infer<typeof previewSchema>;
  res.json({ data: { dates: nextDates({ frequency: b.frequency, start: b.startDate, end: b.endDate }, ukToday(), 3) } });
});

// ── Xero bills ─────────────────────────────────────────────────────────────

router.get('/xero/bills', async (req: AuthRequest, res: Response) => {
  try {
    const [bills, flags, planned] = await Promise.all([loadXeroBills(req.query.fresh === '1'), loadBillFlags(), loadPlannedItems()]);
    if (!bills.ok) { res.json({ data: { ok: false, reason: bills.reason, bills: [] } }); return; }
    const plannedByBill = new Map(planned.filter((p) => p.xeroBillId).map((p) => [p.xeroBillId as string, p.id]));
    res.json({
      data: {
        ok: true,
        today: ukToday(),
        bills: bills.bills
          .map((b) => ({
            ...b,
            flag: flags.byBill.get(b.id) || null,
            contactExcluded: !!(b.contactId && flags.excludedContacts.has(b.contactId)),
            plannedItemId: plannedByBill.get(b.id) || null,
          }))
          .sort((a, b) => (a.due || '').localeCompare(b.due || '')),
        excludedContacts: [...flags.excludedContacts.entries()].map(([id, name]) => ({ id, name })),
      },
    });
  } catch (err) {
    fail(res, 'xero bills', err);
  }
});

const billFlagSchema = z.object({
  flag: z.enum(['paid_xero_behind', 'paid_by_card', 'ignore']).nullable(),
  billLabel: z.string().max(300).optional(),
});

router.put('/bill-flags/:id', validate(z.object({ id: z.string().min(1).max(100) }), 'params'), validate(billFlagSchema), async (req: AuthRequest, res: Response) => {
  try {
    const b = req.body as z.infer<typeof billFlagSchema>;
    if (b.flag === null) {
      await query(`DELETE FROM cashflow_bill_flags WHERE xero_invoice_id = $1`, [req.params.id]);
    } else {
      await query(
        `INSERT INTO cashflow_bill_flags (xero_invoice_id, flag, bill_label, set_by) VALUES ($1, $2, $3, $4)
         ON CONFLICT (xero_invoice_id) DO UPDATE SET flag = EXCLUDED.flag, bill_label = EXCLUDED.bill_label,
           set_by = EXCLUDED.set_by, set_at = NOW()`,
        [req.params.id, b.flag, b.billLabel || null, req.user!.id],
      );
    }
    res.json({ data: { ok: true } });
  } catch (err) {
    fail(res, 'bill flag', err);
  }
});

const excludeSchema = z.object({
  excluded: z.boolean(),
  contactName: z.string().max(200).optional(),
  reason: z.string().max(500).optional(),
});

router.put('/excluded-contacts/:id', validate(z.object({ id: z.string().min(1).max(100) }), 'params'), validate(excludeSchema), async (req: AuthRequest, res: Response) => {
  try {
    const b = req.body as z.infer<typeof excludeSchema>;
    if (!b.excluded) {
      await query(`DELETE FROM cashflow_excluded_contacts WHERE xero_contact_id = $1`, [req.params.id]);
    } else {
      await query(
        `INSERT INTO cashflow_excluded_contacts (xero_contact_id, contact_name, reason, set_by) VALUES ($1, $2, $3, $4)
         ON CONFLICT (xero_contact_id) DO UPDATE SET contact_name = EXCLUDED.contact_name, reason = EXCLUDED.reason,
           set_by = EXCLUDED.set_by, set_at = NOW()`,
        [req.params.id, b.contactName || null, b.reason || null, req.user!.id],
      );
    }
    res.json({ data: { ok: true } });
  } catch (err) {
    fail(res, 'excluded contact', err);
  }
});

router.post('/xero/refresh', async (_req: AuthRequest, res: Response) => {
  forgetXeroBillsCache();
  res.json({ data: { ok: true } });
});

router.get('/xero/contacts', async (req: AuthRequest, res: Response) => {
  try {
    const search = typeof req.query.search === 'string' ? req.query.search.trim() : '';
    if (!search || !isXeroConfigured()) { res.json({ data: [] }); return; }
    const contacts = await xeroBroker.searchContacts(search, 10);
    res.json({ data: contacts.map((c) => ({ id: c.ContactID, name: c.Name })) });
  } catch (err) {
    fail(res, 'xero contacts', err);
  }
});

export default router;
