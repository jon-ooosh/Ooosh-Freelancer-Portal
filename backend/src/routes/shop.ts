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
import { authenticate, authorize, AuthRequest, STAFF_ROLES, MANAGER_ROLES } from '../middleware/auth';
import hhBroker from '../services/hirehop-broker';
import {
  searchShopStock, findShopStockByBarcode, getShopStockItem,
  getReorderList, getCacheAge,
} from '../services/shop-stock';
import {
  createShopSale, listShopSales, cancelShopSale, retryShopSale,
  maxDiscountPctForRole, priceLines, totalsFor,
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
 * jobs' reservations are taken off. It is the difference between "we have 15"
 * and "12 are free, 3 are on a job leaving Thursday". A warning, never a block.
 *
 * ⚠️ Uses the DATE-based `picklist_get_availability.php`, not the job-scoped
 * `items_picklist_avail.php`. The job-scoped one needs a `job` to answer
 * against, and a walk-in has no job — called without one it just returns the
 * global figure, which is the shelf count we already have and therefore useless
 * (that was the first version's bug). Same endpoint and row shape as
 * `routes/staging.ts`, which is the proven caller.
 *
 * `TYPE: 1` is sale stock; staging passes `TYPE: 2` for hire stock. That comes
 * from the picklist, where sale items key as `a<id>` with `TYPE: 1` and hire as
 * `b<id>` with `TYPE: 2`.
 */
router.post('/stock/availability', async (req: AuthRequest, res: Response) => {
  try {
    const ids: number[] = Array.isArray(req.body?.stockIds)
      ? req.body.stockIds.map(Number).filter((n: number) => Number.isFinite(n)).slice(0, 50)
      : [];
    if (!ids.length) return res.json({ data: {} });

    // Right now — a shop sale leaves today, not on some future hire window.
    const now = new Date();
    const pad = (n: number) => String(n).padStart(2, '0');
    const local = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ` +
                  `${pad(now.getHours())}:${pad(now.getMinutes())}:00`;

    const rows = ids.map((id) => ({ ID: id, TYPE: 1, ITEM_ID: 0, AVAILABLE: 1, STOCK: 1, GLOBAL: 1 }));
    const resp = await hhBroker.get<any>('/php_functions/picklist_get_availability.php', {
      rows: JSON.stringify(rows), local, tz: 'Europe/London', global_depot: 1,
    }, { priority: 'high', cacheTTL: 60 });

    const out: Record<string, { available: number | null; stock: number | null }> = {};
    const data: any = resp?.success ? resp.data : null;
    const responseRows: any[] = data?.rows || (Array.isArray(data) ? data : []);

    if (!responseRows.length) {
      // The TYPE:1 row shape is inferred from the picklist, not observed on THIS
      // endpoint, so an empty result is the thing we most need to see. Log the
      // raw reply rather than guessing again.
      console.warn('[shop] availability returned no rows. sent=%j success=%s raw=%j',
        rows, resp?.success, resp?.success ? resp.data : resp?.error);
    }

    for (const row of responseRows) {
      out[String(row.ID)] = {
        available: row.AVAILABLE != null ? parseInt(row.AVAILABLE, 10) : null,
        stock: row.STOCK != null ? parseInt(row.STOCK, 10) : null,
      };
    }
    // A HireHop wobble must never stop a sale — the caller falls back to the
    // shelf count and shows no reservation line.
    res.json({ data: out });
  } catch (err) {
    console.error('[shop] availability lookup failed:', err);
    res.json({ data: {} });
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
    const result = await createShopSale(req.body, {
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
    res.json({ data: await listShopSales({ limit, since }) });
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
    const { drainShopConsumption } = await import('../services/shop-drain');
    res.json({ data: await drainShopConsumption() });
  } catch (err) {
    console.error('[shop] manual drain failed:', err);
    res.status(500).json({ error: 'Drain failed — see the server log.' });
  }
});

export default router;
