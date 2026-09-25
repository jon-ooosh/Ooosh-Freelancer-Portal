/**
 * Shop till API — ad-hoc sales, internal consumption and the sale-stock lookup.
 *
 * `docs/SHOP-SALES-SPEC.md`. Reads serve the till from the local catalogue
 * mirror (`shop_stock_cache`), so searching or pricing an item makes ZERO
 * HireHop calls — a counter with a customer waiting cannot sit behind a 327
 * storm. Writes land in Postgres only; the drain to HireHop is steps 5–6.
 *
 * The one read that DOES hit HireHop is availability (§2.3), and only for items
 * already in the basket — a dozen calls a day at this volume.
 */
import { Router, Response } from 'express';
import { query } from '../config/database';
import { authenticate, authorize, AuthRequest, STAFF_ROLES, MANAGER_ROLES } from '../middleware/auth';
import hhBroker from '../services/hirehop-broker';
import {
  searchShopStock, findShopStockByBarcode, getShopStockItem,
  getReorderList, getCacheAge, getAvailabilityJob, hhLocalNow,
} from '../services/shop-stock';
import {
  createShopSale, listShopSales, cancelShopSale, retryShopSale,
  reverseShopSale, settleShopRefund, reviewShopSales,
  maxDiscountPctForRole, priceLines, totalsFor,
  getConsumptionSummary, getConsumptionLog,
} from '../services/shop-sales';

/* eslint-disable @typescript-eslint/no-explicit-any */

const router = Router();
router.use(authenticate);
// STAFF_ROLES, not a hardcoded list — spelling out ('admin','manager','staff')
// silently locks out weekend_manager and general_assistant, which has already
// shipped as a live bug once.
router.use(authorize(...STAFF_ROLES));

// ── Catalogue (zero HireHop calls) ───────────────────────────────────────

router.get('/stock/search', async (req: AuthRequest, res: Response) => {
  try {
    const q = String(req.query.q || '');
    const limit = req.query.limit ? Number(req.query.limit) : undefined;
    const items = await searchShopStock(q, { limit });
    res.json({ data: items });
  } catch (err) {
    console.error('[shop] stock search failed:', err);
    res.status(500).json({ error: 'Could not search shop stock.' });
  }
});

/**
 * Barcode lookup. Deliberately NOT category-filtered: if someone physically
 * scanned it they are holding it, and refusing to price a thing in the
 * customer's hand is a gate that strands staff (§2.4).
 */
router.get('/stock/barcode/:code', async (req: AuthRequest, res: Response) => {
  try {
    const item = await findShopStockByBarcode(String(req.params.code));
    if (!item) return res.status(404).json({ error: 'No stock item with that barcode.' });
    res.json({ data: item });
  } catch (err) {
    console.error('[shop] barcode lookup failed:', err);
    res.status(500).json({ error: 'Could not look up that barcode.' });
  }
});

/** How stale the mirror is, so the till can say "stock as of 6 min ago". */
router.get('/stock/status', async (_req: AuthRequest, res: Response) => {
  try {
    res.json({ data: await getCacheAge() });
  } catch (err) {
    console.error('[shop] cache status failed:', err);
    res.status(500).json({ error: 'Could not read the catalogue status.' });
  }
});

/** Items at or below reorder level — ALL sale stock, not just shop categories. */
router.get('/stock/reorder', async (_req: AuthRequest, res: Response) => {
  try {
    res.json({ data: await getReorderList() });
  } catch (err) {
    console.error('[shop] reorder list failed:', err);
    res.status(500).json({ error: 'Could not build the reorder list.' });
  }
});

router.get('/stock/:id(\\d+)', async (req: AuthRequest, res: Response) => {
  try {
    const item = await getShopStockItem(Number(req.params.id));
    if (!item) return res.status(404).json({ error: 'Stock item not found.' });
    res.json({ data: item });
  } catch (err) {
    console.error('[shop] stock read failed:', err);
    res.status(500).json({ error: 'Could not read that stock item.' });
  }
});

/**
 * Live availability for items in the basket (§2.3).
 *
 * The mirror holds the SHELF count; this is what is actually free once other
 * jobs' reservations are taken off — the difference between "we have 15" and
 * "14 are free, 1 is on a job leaving Thursday". A warning, never a block.
 *
 * ⚠️ EVERY PARAMETER HERE IS COPIED FROM A CAPTURE of HireHop's own UI, not
 * from its API docs (§2.9). The first version guessed the row shape from
 * `routes/staging.ts` and returned nothing at all. What the UI actually sends:
 *
 *     GET /php_functions/picklist_get_availability.php
 *       job          = 16735
 *       global_depot = 1
 *       rows         = [{"ID":25,"TYPE":1,"AVAILABLE":1,"GLOBAL":0}, …]
 *       local        = 2026-09-23 16:47:05     ← Europe/London, not UTC
 *       tz           = Europe/London
 *
 * `TYPE: 1` IS correct for sale stock (hire rows in the same capture carry
 * `TYPE: 2`) — the guess that failed was the surrounding shape: staging's
 * `ITEM_ID`/`STOCK` keys and `GLOBAL: 1`, and above all the missing `job`.
 *
 * A walk-in has no job, so we ask against a configured one (migration 242) —
 * the weekly shop job once step 6 creates it. Unset means don't ask, and the
 * till then says so rather than implying nothing is reserved.
 */
router.post('/stock/availability', async (req: AuthRequest, res: Response) => {
  try {
    const ids: number[] = Array.isArray(req.body?.stockIds)
      ? req.body.stockIds.map(Number).filter((n: number) => Number.isFinite(n)).slice(0, 50)
      : [];
    if (!ids.length) return res.json({ data: {} });

    const job = await getAvailabilityJob();
    if (!job) {
      // Honest silence beats a confident wrong answer: the till shows the shelf
      // count and flags that reservations were not checked.
      return res.json({ data: {} });
    }

    const rows = ids.map((id) => ({ ID: id, TYPE: 1, AVAILABLE: 1, GLOBAL: 0 }));
    const resp = await hhBroker.get<any>('/php_functions/picklist_get_availability.php', {
      job,
      global_depot: 1,
      rows: JSON.stringify(rows),
      local: hhLocalNow(),
      tz: 'Europe/London',
    }, { priority: 'high', cacheTTL: 60 });

    const out: Record<string, { available: number | null }> = {};
    const data: any = resp?.success ? resp.data : null;
    const responseRows: any[] = data?.rows || (Array.isArray(data) ? data : []);

    if (!responseRows.length) {
      console.warn('[shop] availability returned no rows. job=%s sent=%j success=%s raw=%j',
        job, rows, resp?.success, resp?.success ? resp.data : resp?.error);
    }

    for (const row of responseRows) {
      out[String(row.ID)] = {
        available: row.AVAILABLE != null ? parseInt(row.AVAILABLE, 10) : null,
      };
    }
    res.json({ data: out });
  } catch (err) {
    // A HireHop wobble must never stop a sale.
    console.error('[shop] availability lookup failed:', err);
    res.json({ data: {} });
  }
});

// ── Job routing (step 7) ─────────────────────────────────────────────────

/**
 * The bands in the rehearsal rooms today — the till's one-tap shortlist, from
 * the same rehearsal data the sitter roster uses. Two in → two buttons.
 */
router.get('/jobs/today', async (_req: AuthRequest, res: Response) => {
  try {
    const { listJobsInToday } = await import('../services/shop-routing');
    res.json({ data: await listJobsInToday() });
  } catch (err) {
    console.error('[shop] jobs-in-today failed:', err);
    res.status(500).json({ error: "Could not load today's bands." });
  }
});

/** Any open job, by HireHop number or name — for the band not in a room today. */
router.get('/jobs/search', async (req: AuthRequest, res: Response) => {
  try {
    const { searchSellableJobs } = await import('../services/shop-routing');
    res.json({ data: await searchSellableJobs(String(req.query.q || '')) });
  } catch (err) {
    console.error('[shop] job search failed:', err);
    res.status(500).json({ error: 'Could not search jobs.' });
  }
});

// ── Sales ────────────────────────────────────────────────────────────────

/** What this user may discount, so the till can show the ceiling up front. */
router.get('/discount-cap', async (req: AuthRequest, res: Response) => {
  try {
    const pct = await maxDiscountPctForRole(req.user?.role);
    res.json({ data: { maxDiscountPct: pct } });
  } catch (err) {
    console.error('[shop] discount cap failed:', err);
    res.status(500).json({ error: 'Could not read the discount limit.' });
  }
});

/**
 * Price a basket without committing it.
 *
 * "Never silently move money" — the till shows the recomputed figure, including
 * what the discount actually comes to, before anyone takes payment.
 */
router.post('/quote', async (req: AuthRequest, res: Response) => {
  try {
    const priced = await priceLines(req.body?.lines || []);
    res.json({ data: { lines: priced, totals: totalsFor(priced) } });
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : 'Could not price that basket.' });
  }
});

router.post('/sales', async (req: AuthRequest, res: Response) => {
  try {
    // A shift belongs only to sales taken on the sitter till (portal routes).
    const result = await createShopSale({ ...req.body, shiftId: null }, {
      id: req.user!.id,
      role: req.user!.role,
    });
    res.status(201).json({ data: result });
  } catch (err) {
    // Validation failures here are things a human needs to read and act on
    // ("that's a 25% discount, your limit is 10%"), so pass the message through.
    res.status(400).json({ error: err instanceof Error ? err.message : 'Could not record that sale.' });
  }
});

router.get('/sales', async (req: AuthRequest, res: Response) => {
  try {
    const limit = req.query.limit ? Number(req.query.limit) : undefined;
    const since = req.query.since ? String(req.query.since) : undefined;
    const attention = req.query.attention === '1' || req.query.attention === 'true';
    const review = req.query.review === '1' || req.query.review === 'true';
    res.json({ data: await listShopSales({ limit, since, attention, review }) });
  } catch (err) {
    console.error('[shop] sales list failed:', err);
    res.status(500).json({ error: 'Could not load shop sales.' });
  }
});

/**
 * Cancel. Inside the push hold this is a true undo (Window A, §8) — nothing has
 * reached HireHop or Xero. Once pushed it refuses and says so, rather than
 * pretending to have unwound money that is already in Xero.
 */
router.post('/sales/:id/cancel', async (req: AuthRequest, res: Response) => {
  try {
    const result = await cancelShopSale(
      String(req.params.id),
      { id: req.user!.id },
      req.body?.reason ?? null,
    );
    if (!result.cancelled) return res.status(409).json({ error: result.message });
    res.json({ data: { cancelled: true } });
  } catch (err) {
    console.error('[shop] cancel failed:', err);
    res.status(500).json({ error: 'Could not cancel that sale.' });
  }
});

/**
 * Refund a sale that has already reached HireHop (Window B, §8): lines come off
 * the job and a refund is applied against its deposit.
 *
 * MANAGER_ROLES — money out of the door (CLAUDE.md RBAC). A cancel inside the
 * hold stays open to all staff, because nothing has moved yet.
 *
 * The drain is kicked straight away rather than left for the next tick: whoever
 * pressed Refund is standing with the customer and wants to see it land. The
 * drain lock makes that safe alongside the scheduler.
 */
router.post('/sales/:id/reverse', authorize(...MANAGER_ROLES), async (req: AuthRequest, res: Response) => {
  try {
    const result = await reverseShopSale(
      String(req.params.id),
      { id: req.user!.id },
      { reason: String(req.body?.reason ?? ''), moneyReturned: req.body?.moneyReturned === true },
    );
    import('../services/shop-drain')
      .then(({ drainShop }) => drainShop())
      .catch((err) => console.error('[shop] post-refund drain failed:', err instanceof Error ? err.message : err));
    res.status(201).json({ data: result });
  } catch (err) {
    // Written to be read by the person at the counter ("already refunded",
    // "the week has been invoiced"), so pass it through.
    res.status(400).json({ error: err instanceof Error ? err.message : 'Could not refund that sale.' });
  }
});

/**
 * Email a receipt (step 11, §2.10) — a VAT receipt for a sale, a refund
 * receipt for a reversal. Any staff: it's a document about money that already
 * moved, not a money decision.
 */
router.post('/sales/:id/receipt', async (req: AuthRequest, res: Response) => {
  try {
    const { sendShopReceipt } = await import('../services/shop-receipts');
    const result = await sendShopReceipt(String(req.params.id), String(req.body?.to ?? ''), { id: req.user!.id });
    if (!result.sent) return res.status(502).json({ error: `The receipt didn't send: ${result.error}` });
    res.json({ data: { sent: true } });
  } catch (err) {
    // "That went on the band's bill", "not an email address" — for the person at the till.
    res.status(400).json({ error: err instanceof Error ? err.message : 'Could not send that receipt.' });
  }
});

/** Addresses to offer for a receipt: where earlier ones went, then the job's contacts. */
router.get('/sales/:id/receipt/suggestions', async (req: AuthRequest, res: Response) => {
  try {
    const { receiptSuggestions } = await import('../services/shop-receipts');
    res.json({ data: await receiptSuggestions(String(req.params.id)) });
  } catch (err) {
    console.error('[shop] receipt suggestions failed:', err);
    res.json({ data: [] });   // a convenience — typing the address still works
  }
});

/** A job's contacts with an email — the checkout's receipt box, before the sale exists. */
router.get('/jobs/:jobId/receipt-contacts', async (req: AuthRequest, res: Response) => {
  try {
    const { jobReceiptContacts } = await import('../services/shop-receipts');
    res.json({ data: await jobReceiptContacts(String(req.params.jobId)) });
  } catch (err) {
    console.error('[shop] job receipt contacts failed:', err);
    res.json({ data: [] });
  }
});

/**
 * Tick off sitter sales (§5) — one, or a batch ("all of last night's look
 * fine"). Any staff: it's a check, not a money decision.
 */
router.post('/sales/review', async (req: AuthRequest, res: Response) => {
  try {
    const ids: string[] = Array.isArray(req.body?.ids) ? req.body.ids.map(String).slice(0, 200) : [];
    res.json({ data: { reviewed: await reviewShopSales(ids, { id: req.user!.id }) } });
  } catch (err) {
    console.error('[shop] review failed:', err);
    res.status(500).json({ error: 'Could not mark those as reviewed.' });
  }
});

/**
 * The customer has their money back — cash from the drawer, or a refund keyed
 * on the card terminal. OP cannot do that part itself until Stripe, so this is
 * the tick that clears an outstanding refund.
 */
router.post('/sales/:id/refund-settled', async (req: AuthRequest, res: Response) => {
  try {
    const result = await settleShopRefund(String(req.params.id), { id: req.user!.id });
    if (!result.settled) return res.status(409).json({ error: result.message });
    res.json({ data: { settled: true } });
  } catch (err) {
    console.error('[shop] refund settle failed:', err);
    res.status(500).json({ error: 'Could not mark that refund as done.' });
  }
});

/**
 * This week's shop job — and create it if it doesn't exist yet.
 *
 * Creation is normally incidental: the first sale of a week brings the job into
 * being. But "the first sale" is a poor moment to discover the client id is
 * wrong, so this exposes it directly — useful for testing, and useful on a
 * Monday morning when someone wants to know the week is ready.
 *
 * MANAGER_ROLES on the create: it makes a real HireHop job against a real
 * client, which is a decision rather than a refresh.
 */
router.get('/period', async (_req: AuthRequest, res: Response) => {
  try {
    const { weekStart } = await import('../services/shop-period');
    const start = weekStart(new Date());
    const r = await query(
      `SELECT id, period_start::text, period_end::text, hh_job_number, invoiced_at
         FROM shop_sale_periods WHERE period_start = $1`, [start],
    );
    res.json({ data: { periodStart: start, period: r.rows[0] || null } });
  } catch (err) {
    console.error('[shop] period read failed:', err);
    res.status(500).json({ error: "Could not read this week's shop job." });
  }
});

router.post('/period/ensure', authorize(...MANAGER_ROLES), async (_req: AuthRequest, res: Response) => {
  try {
    const { getOrCreateShopPeriod } = await import('../services/shop-period');
    res.json({ data: await getOrCreateShopPeriod(new Date()) });
  } catch (err) {
    // These messages are written to be read by a human who now has to go and
    // fix something in HireHop, so pass them through rather than flattening
    // them to "something went wrong".
    res.status(400).json({ error: err instanceof Error ? err.message : 'Could not create this week\'s shop job.' });
  }
});

/**
 * A week's takings plus the last balance check on its shop job (step 9).
 * `start` is the Monday; defaults to this week. Reads Postgres only — the
 * check itself is stored by the 15-minute scan, or run on demand below.
 */
router.get('/week', async (req: AuthRequest, res: Response) => {
  try {
    const { weekStart } = await import('../services/shop-period');
    const { getWeekSummary } = await import('../services/shop-reconcile');
    const start = req.query.start ? String(req.query.start) : weekStart(new Date());
    const summary = await getWeekSummary(start);
    const p = await query(
      `SELECT id, hh_job_number, invoiced_at, last_checked_at, last_check_ok, last_check
         FROM shop_sale_periods WHERE period_start = $1`, [summary.periodStart],
    );
    res.json({ data: { summary, period: p.rows[0] || null } });
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : 'Could not load that week.' });
  }
});

/** Run the balance check now rather than waiting for the scan. Reads HireHop only. */
router.post('/week/:periodId/check', async (req: AuthRequest, res: Response) => {
  try {
    const { checkShopPeriod } = await import('../services/shop-reconcile');
    res.json({ data: await checkShopPeriod(String(req.params.periodId)) });
  } catch (err) {
    console.error('[shop] balance check failed:', err);
    res.status(400).json({ error: err instanceof Error ? err.message : 'Could not run the check.' });
  }
});

/**
 * What we have used ourselves — grouped by item, and the event log.
 *
 * HireHop keeps a per-item adjustment trail, so "what happened to this item" is
 * already answerable there. What it cannot do is "what did we burn through last
 * month", which needs opening every item in turn. That is the question this
 * answers, and it is the one that drives reordering.
 */
router.get('/consumption', async (req: AuthRequest, res: Response) => {
  try {
    const days = req.query.days ? Number(req.query.days) : 30;
    const [summary, log] = await Promise.all([
      getConsumptionSummary(days),
      getConsumptionLog(days),
    ]);
    res.json({ data: { days, summary, log } });
  } catch (err) {
    console.error('[shop] consumption read failed:', err);
    res.status(500).json({ error: 'Could not load stock usage.' });
  }
});

/**
 * Put a failed transaction back in the queue, once whatever broke is fixed.
 * Re-keying it instead would lose who recorded it and when.
 */
router.post('/sales/:id/retry', async (req: AuthRequest, res: Response) => {
  try {
    const result = await retryShopSale(String(req.params.id));
    if (!result.requeued) return res.status(409).json({ error: result.message });
    res.json({ data: { requeued: true } });
  } catch (err) {
    console.error('[shop] retry failed:', err);
    res.status(500).json({ error: 'Could not requeue that transaction.' });
  }
});

/**
 * Force a drain pass rather than waiting for the scheduler.
 *
 * MANAGER_ROLES: it makes real HireHop writes happen sooner than they otherwise
 * would, which is a decision rather than a refresh.
 */
router.post('/drain', authorize(...MANAGER_ROLES), async (_req: AuthRequest, res: Response) => {
  try {
    const { drainShop } = await import('../services/shop-drain');
    res.json({ data: await drainShop() });
  } catch (err) {
    console.error('[shop] manual drain failed:', err);
    res.status(500).json({ error: 'Drain failed — see the server log.' });
  }
});

export default router;
