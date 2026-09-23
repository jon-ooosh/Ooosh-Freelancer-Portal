/**
 * shop-stock.ts — the SALE-stock catalogue mirror, and THE definition of what a
 * shop item costs the customer.
 *
 * Step 2 of `docs/SHOP-SALES-SPEC.md`. HireHop stays the single stock database;
 * this is a read-through mirror refreshed on a timer so that the till never
 * calls HireHop to search or price an item. A counter with a customer waiting
 * cannot sit behind a 327 rate-limit storm, and a studio sitter asking "how much
 * is a jack lead?" on their phone needs the answer now, on a bad evening.
 *
 * Nothing here moves stock. Every real movement is a HireHop job line or a
 * tally adjustment — see the double-decrement trap in SHOP-SALES-SPEC.md §2.
 *
 * Sibling: `backline-stock.ts` does the same job for HIRE stock, but against a
 * different endpoint, with different credentials, in memory rather than in
 * Postgres. Do not copy its `PRICE_1` read — that field is deprecated on the
 * consumables API.
 */
import hhBroker from './hirehop-broker';
import { query, getClient } from '../config/database';

/* eslint-disable @typescript-eslint/no-explicit-any */

/** HireHop's consumables module. Paginated; 20–200 rows per page. */
const CONSUMABLES_ENDPOINT = '/modules/consumables/list.php';
const PAGE_ROWS = 200;

/** Guard against a runaway loop if HireHop ever reports a silly page count. */
const MAX_PAGES = 50;

/** system_settings key holding the tax-index → percentage map (see below). */
const VAT_MAP_KEY = 'shop_vat_rate_map';

/**
 * HireHop tax-type index → VAT percentage.
 *
 * ⚠️ `VAT_RATE` on a consumables row is an INDEX INTO HIREHOP'S TAX TYPES, not
 * a percentage. The verified item (1" green fluoro tape, Sep 2026) returned
 * `VAT_RATE: 0` while the HireHop UI displayed "Tax rate Standard" — so 0 means
 * the standard rate and emphatically NOT zero-rated. Code that treats this
 * number as a percentage charges no VAT on everything and under-declares the
 * weekly shop invoice.
 *
 * The map lives in `system_settings` so it can be corrected without a deploy,
 * which matters because the shop sells food and drink: in the UK most cold food
 * is zero-rated while canned drinks and confectionery are standard, so a second
 * index genuinely may appear. This constant is only the fallback.
 */
const DEFAULT_VAT_MAP: Record<string, number> = { '0': 20 };

let vatMapCache: { map: Record<string, number>; at: number } | null = null;
const VAT_MAP_TTL_MS = 5 * 60 * 1000;

export interface ShopStockItem {
  hhStockId: number;
  title: string;
  altTitle: string | null;
  partNumber: string | null;
  barcode: string | null;
  categoryId: number | null;
  categoryPath: string | null;
  /** Price A, EX-VAT. Everything HireHop returns is ex-VAT. */
  priceExVat: number | null;
  vatRateIndex: number | null;
  maxDiscount: number | null;
  /** Shelf count as of `refreshedAt`. NOT availability — see §2.3. */
  quantity: number;
  reorderLevel: number | null;
  reorderQty: number | null;
  status: number;
  refreshedAt: string;
}

function rowToItem(r: any): ShopStockItem {
  return {
    hhStockId: Number(r.hh_stock_id),
    title: r.title,
    altTitle: r.alt_title,
    partNumber: r.part_number,
    barcode: r.barcode,
    categoryId: r.category_id != null ? Number(r.category_id) : null,
    categoryPath: r.category_path,
    priceExVat: r.price != null ? Number(r.price) : null,
    vatRateIndex: r.vat_rate_index != null ? Number(r.vat_rate_index) : null,
    maxDiscount: r.max_discount != null ? Number(r.max_discount) : null,
    quantity: Number(r.quantity),
    reorderLevel: r.reorder_level != null ? Number(r.reorder_level) : null,
    reorderQty: r.reorder_qty != null ? Number(r.reorder_qty) : null,
    status: Number(r.status),
    refreshedAt: r.refreshed_at,
  };
}

// ── VAT ──────────────────────────────────────────────────────────────────

/** Load (and briefly cache) the tax-index → percentage map. */
async function loadVatMap(): Promise<Record<string, number>> {
  if (vatMapCache && Date.now() - vatMapCache.at < VAT_MAP_TTL_MS) return vatMapCache.map;

  let map = DEFAULT_VAT_MAP;
  try {
    const r = await query(`SELECT value FROM system_settings WHERE key = $1`, [VAT_MAP_KEY]);
    const raw = r.rows[0]?.value;
    if (raw) {
      const parsed = JSON.parse(raw);
      // Only accept a flat {index: percent} object of finite numbers — a
      // malformed setting must fall back to the default rather than silently
      // zero-rate the shop.
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        const clean: Record<string, number> = {};
        for (const [k, v] of Object.entries(parsed)) {
          const n = Number(v);
          if (Number.isFinite(n) && n >= 0 && n <= 100) clean[k] = n;
        }
        if (Object.keys(clean).length > 0) map = clean;
      }
    }
  } catch (err) {
    console.warn('[shop-stock] VAT map unreadable, using default:', err instanceof Error ? err.message : err);
  }

  vatMapCache = { map, at: Date.now() };
  return map;
}

/**
 * THE definition: HireHop tax index → VAT percentage.
 *
 * Every price shown to a customer or pushed as a payment goes through this.
 * Never inline a 20, and never read `vat_rate_index` as a percentage.
 * An unknown index falls back to the standard rate rather than to zero —
 * over-charging VAT is a correctable error, under-declaring it is not.
 */
export async function resolveVatRate(index: number | null | undefined): Promise<number> {
  const map = await loadVatMap();
  if (index == null) return map['0'] ?? 20;
  return map[String(index)] ?? map['0'] ?? 20;
}

/** Ex-VAT price → what the customer actually pays, rounded to the penny. */
export async function grossPrice(netExVat: number, vatRateIndex: number | null): Promise<number> {
  const rate = await resolveVatRate(vatRateIndex);
  return Math.round(netExVat * (1 + rate / 100) * 100) / 100;
}

// ── Refresh ──────────────────────────────────────────────────────────────

/** One page of HireHop's consumables list. */
async function fetchPage(page: number): Promise<{ rows: any[]; totalPages: number }> {
  const res = await hhBroker.get<any>(CONSUMABLES_ENDPOINT, {
    page,
    rows: PAGE_ROWS,
    del: 0,          // active items only; retired rows are handled below
  }, { priority: 'low', cacheTTL: -1, skipCache: true });

  if (!res.success || !res.data) {
    throw new Error(`HireHop consumables page ${page} failed: ${res.error || 'no data'}`);
  }
  const data: any = res.data;
  return {
    rows: Array.isArray(data.data) ? data.data : [],
    totalPages: Number(data.total) || 1,
  };
}

/**
 * Map one HireHop consumables row.
 *
 * Reads `PRICES._1.PRICE`, NOT `PRICE1` — the numbered fields are marked
 * DEPRECATED in HireHop's API docs and are not guaranteed to track the real
 * price. Hire items carry a `TYPE` inside each PRICES entry; sale items don't,
 * which is a useful smell if something non-sale ever appears here.
 */
function mapRow(r: any): Omit<ShopStockItem, 'refreshedAt'> {
  const priceA = r?.PRICES?._1?.PRICE;
  const crumbs = Array.isArray(r?.crumbs)
    ? r.crumbs.map((c: any) => c?.NAME).filter(Boolean).join(' › ')
    : null;

  return {
    hhStockId: Number(r.ID),
    title: String(r.TITLE ?? '').trim(),
    altTitle: r.ALT_TITLE ? String(r.ALT_TITLE) : null,
    partNumber: r.PART_NUMBER ? String(r.PART_NUMBER) : null,
    barcode: r.BARCODE ? String(r.BARCODE) : null,
    categoryId: r.CATEGORY_ID != null ? Number(r.CATEGORY_ID) : null,
    categoryPath: crumbs || null,
    priceExVat: priceA != null ? Number(priceA) : null,
    vatRateIndex: r.VAT_RATE != null ? Number(r.VAT_RATE) : null,
    maxDiscount: r.MAX_DISCOUNT != null ? Number(r.MAX_DISCOUNT) : null,
    quantity: Number(r.QUANTITY) || 0,
    reorderLevel: r.REORDER_LEVEL !== '' && r.REORDER_LEVEL != null ? Number(r.REORDER_LEVEL) : null,
    reorderQty: r.REORDER_QTY !== '' && r.REORDER_QTY != null ? Number(r.REORDER_QTY) : null,
    status: r.STATUS != null ? Number(r.STATUS) : 0,
  };
}

export interface RefreshResult {
  fetched: number;
  upserted: number;
  retired: number;
  pages: number;
}

/**
 * Pull the whole sale-stock catalogue and replace the mirror.
 *
 * Runs in ONE transaction: a mid-refresh failure leaves the previous catalogue
 * intact rather than a half-updated one, because the till reading a partial
 * catalogue would silently hide items from staff.
 *
 * Items that disappear from HireHop are marked `status = 2` (deleted) rather
 * than removed, so a historic sale line can still resolve the name and price it
 * was sold under.
 */
export async function refreshShopStockCache(): Promise<RefreshResult> {
  const first = await fetchPage(1);
  const totalPages = Math.min(first.totalPages, MAX_PAGES);
  const rows: any[] = [...first.rows];

  for (let page = 2; page <= totalPages; page++) {
    const next = await fetchPage(page);
    rows.push(...next.rows);
  }

  // Dedupe defensively — a paginated feed can repeat a row if the underlying
  // list shifts between page reads.
  const seen = new Set<number>();
  const items: Array<Omit<ShopStockItem, 'refreshedAt'>> = [];
  for (const r of rows) {
    const id = Number(r?.ID);
    if (!Number.isFinite(id) || seen.has(id)) continue;
    seen.add(id);
    items.push(mapRow(r));
  }

  const client = await getClient();
  let retired = 0;
  try {
    await client.query('BEGIN');

    for (const it of items) {
      await client.query(
        `INSERT INTO shop_stock_cache (
           hh_stock_id, title, alt_title, part_number, barcode,
           category_id, category_path, price, cost_price, vat_rate_index,
           max_discount, quantity, reorder_level, reorder_qty, status, refreshed_at
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,NULL,$9,$10,$11,$12,$13,$14,NOW())
         ON CONFLICT (hh_stock_id) DO UPDATE SET
           title = EXCLUDED.title,
           alt_title = EXCLUDED.alt_title,
           part_number = EXCLUDED.part_number,
           barcode = EXCLUDED.barcode,
           category_id = EXCLUDED.category_id,
           category_path = EXCLUDED.category_path,
           price = EXCLUDED.price,
           vat_rate_index = EXCLUDED.vat_rate_index,
           max_discount = EXCLUDED.max_discount,
           quantity = EXCLUDED.quantity,
           reorder_level = EXCLUDED.reorder_level,
           reorder_qty = EXCLUDED.reorder_qty,
           status = EXCLUDED.status,
           refreshed_at = NOW()`,
        [
          it.hhStockId, it.title, it.altTitle, it.partNumber, it.barcode,
          it.categoryId, it.categoryPath, it.priceExVat, it.vatRateIndex,
          it.maxDiscount, it.quantity, it.reorderLevel, it.reorderQty, it.status,
        ],
      );
    }

    // Anything we hold that HireHop no longer lists is retired, not deleted.
    // Guarded on a non-empty fetch: if HireHop returns nothing (an outage, a
    // permissions change), retiring the entire catalogue would empty the till.
    if (items.length > 0) {
      const ids = items.map((i) => i.hhStockId);
      const res = await client.query(
        `UPDATE shop_stock_cache
            SET status = 2, refreshed_at = NOW()
          WHERE status <> 2 AND NOT (hh_stock_id = ANY($1::int[]))`,
        [ids],
      );
      retired = res.rowCount ?? 0;
    }

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }

  console.log(
    `[shop-stock] refreshed ${items.length} sale items across ${totalPages} page(s)` +
    (retired ? `, retired ${retired}` : ''),
  );
  return { fetched: rows.length, upserted: items.length, retired, pages: totalPages };
}

// ── Reads (the till's fast path — zero HireHop calls) ─────────────────────

export interface SearchOpts {
  /** Include hidden (1) and deleted (2) items. Default false — sellable only. */
  includeInactive?: boolean;
  limit?: number;
}

/**
 * Type-ahead search for the till. Matches name, alt name and part number —
 * staff type fragments and part numbers ("gree fl 1", "PROGAFF24"), never
 * sentences, which is why this is trigram rather than full-text.
 */
export async function searchShopStock(q: string, opts: SearchOpts = {}): Promise<ShopStockItem[]> {
  const term = (q || '').trim();
  const limit = Math.min(Math.max(opts.limit ?? 25, 1), 100);
  const statusClause = opts.includeInactive ? '' : 'AND status = 0';

  if (!term) {
    const r = await query(
      `SELECT * FROM shop_stock_cache WHERE TRUE ${statusClause}
        ORDER BY title LIMIT $1`, [limit]);
    return r.rows.map(rowToItem);
  }

  const like = `%${term}%`;
  const r = await query(
    `SELECT * FROM shop_stock_cache
      WHERE (title ILIKE $1 OR alt_title ILIKE $1 OR part_number ILIKE $1)
        ${statusClause}
      ORDER BY
        CASE WHEN title ILIKE $2 THEN 0 ELSE 1 END,
        similarity(title, $3) DESC,
        title
      LIMIT $4`,
    [like, `${term}%`, term, limit],
  );
  return r.rows.map(rowToItem);
}

/** Exact barcode lookup — the scanner's path, and the fastest one. */
export async function findShopStockByBarcode(barcode: string): Promise<ShopStockItem | null> {
  const code = (barcode || '').trim();
  if (!code) return null;
  const r = await query(
    `SELECT * FROM shop_stock_cache WHERE barcode = $1 AND status = 0 LIMIT 1`, [code]);
  return r.rows[0] ? rowToItem(r.rows[0]) : null;
}

export async function getShopStockItem(hhStockId: number): Promise<ShopStockItem | null> {
  const r = await query(`SELECT * FROM shop_stock_cache WHERE hh_stock_id = $1`, [hhStockId]);
  return r.rows[0] ? rowToItem(r.rows[0]) : null;
}

/**
 * Items at or below their reorder level.
 *
 * The real answer to "someone walked in and bought the drum heads that were
 * earmarked for Thursday" is not a cleverer warning at the till — it is knowing
 * on Monday. See SHOP-SALES-SPEC.md §2.3.
 */
export async function getReorderList(): Promise<ShopStockItem[]> {
  const r = await query(
    `SELECT * FROM shop_stock_cache
      WHERE status = 0 AND reorder_level IS NOT NULL AND reorder_level > 0
        AND quantity <= reorder_level
      ORDER BY (quantity - reorder_level), title`,
  );
  return r.rows.map(rowToItem);
}

/** How stale is the mirror? The till shows this so nobody over-trusts a count. */
export async function getCacheAge(): Promise<{ items: number; refreshedAt: string | null }> {
  const r = await query(
    `SELECT COUNT(*)::int AS items, MAX(refreshed_at) AS refreshed_at FROM shop_stock_cache`);
  return { items: r.rows[0]?.items ?? 0, refreshedAt: r.rows[0]?.refreshed_at ?? null };
}
