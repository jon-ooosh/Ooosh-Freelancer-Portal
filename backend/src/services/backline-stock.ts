/**
 * Backline stock fetch for the Backline Matcher.
 *
 * Ported from the standalone `alternative-hirehop-stock` Netlify app (Jun 2026)
 * when the Backline Matcher moved into OP. Pulls backline equipment from
 * HireHop's bulk stock export endpoint — the SAME endpoint + EXPORT credentials
 * the Staging Calculator uses (`services/staging-stock.ts`), NOT the API token.
 *
 * Strategy: ONE export call (no category filter) → filter to backline
 * categories client-side. This mirrors the original Netlify app, which ran this
 * way in production for years. An earlier per-parent-category approach made five
 * rapid calls and tripped HireHop's export rate limit (429). One call is both
 * proven and far less likely to be throttled; a single 429 retry covers the rest.
 *
 * Uses the same EXPORT credentials the Staging Calculator uses
 * (`HIREHOP_EXPORT_ID` + `HIREHOP_EXPORT_KEY`), NOT the API token. Cached briefly
 * in-process (stock changes rarely; the matcher hits this on every search). Not
 * routed through the broker — different auth, one bulk call.
 */

const HIREHOP_EXPORT_URL = 'https://myhirehop.com/modules/stock/export_data.php';

// All backline category IDs (from the original get-stock.js). Everything except
// vehicles (370-371), rehearsal (450) and storage (449). The export returns ALL
// stock in one call; we keep only items whose CATEGORY_ID is in this set.
const BACKLINE_CATEGORY_IDS = new Set<number>([
  372, 373, 374, 375, 376, 377, 378, // Guitars (amps, cabs, combos, FX)
  379, 380, 381, 382, 383, 384, // Basses
  385, 386, 387, 388, 389, 390, 391, 392, 393, 394, 395, 396, 397, 398, // Drums
  399, 400, 401, 402, 403, 404, // Keyboards
  406, 407, 408, 409, 410, // Backline accessories
]);

const CACHE_TTL_MS = 5 * 60 * 1000;

export interface BacklineStockItem {
  id: number;
  name: string;
  altName: string | null;
  category: string;
  categoryPath: string | null;
  categoryId: number;
  quantity: number;
  pricePerDay: number | null;
  imageUrl: string | null;
}

/* eslint-disable @typescript-eslint/no-explicit-any */
type RawItem = Record<string, any>;

let cache: { items: BacklineStockItem[]; at: number } | null = null;

function exportCreds(): { id: string; key: string } {
  const id = process.env.HIREHOP_EXPORT_ID;
  // The STOCK export key may differ from the webhook-verification HIREHOP_EXPORT_KEY;
  // prefer the dedicated var, fall back to the shared one (mirrors staging-stock.ts).
  const key = process.env.HIREHOP_STOCK_EXPORT_KEY || process.env.HIREHOP_EXPORT_KEY;
  if (!id || !key) {
    throw new Error(
      'Missing HireHop export credentials. Set HIREHOP_EXPORT_ID and ' +
        'HIREHOP_STOCK_EXPORT_KEY (or HIREHOP_EXPORT_KEY) env vars.',
    );
  }
  return { id, key };
}

async function fetchAllStock(): Promise<RawItem[]> {
  const { id, key } = exportCreds();
  const params = new URLSearchParams({ id, key, sidx: 'TITLE', sord: 'asc' });
  const url = `${HIREHOP_EXPORT_URL}?${params.toString()}`;

  // One 429 retry — the export endpoint occasionally throttles under load.
  let lastStatus = 0;
  for (let attempt = 0; attempt < 2; attempt++) {
    if (attempt > 0) await new Promise((r) => setTimeout(r, 1500));
    const response = await fetch(url);
    if (response.ok) {
      const data = await response.json();
      return Array.isArray(data) ? data : [];
    }
    lastStatus = response.status;
    if (response.status !== 429) break; // only retry rate-limits
  }
  throw new Error(`HireHop export returned ${lastStatus}`);
}

function mapItem(item: RawItem): BacklineStockItem {
  return {
    id: Number(item.ID),
    name: item.NAME,
    altName: item.ALT_NAME || null,
    category: item.CATEGORY,
    categoryPath: item.BREADCRUMBS || null,
    categoryId: Number(item.CATEGORY_ID),
    quantity: Number(item.QTY) || 0,
    pricePerDay: item.PRICE_1 != null ? Number(item.PRICE_1) : null,
    imageUrl: item.IMAGE_URL || null,
  };
}

/** Fetch all backline stock (cached ~5 min). Deduped by stock ID. */
export async function fetchBacklineStock(): Promise<BacklineStockItem[]> {
  if (cache && Date.now() - cache.at < CACHE_TTL_MS) {
    return cache.items;
  }

  const raw = await fetchAllStock();
  const seen = new Set<number>();
  const items: BacklineStockItem[] = [];

  for (const r of raw) {
    const catId = Number(r.CATEGORY_ID);
    if (!BACKLINE_CATEGORY_IDS.has(catId)) continue;
    const id = Number(r.ID);
    if (!Number.isFinite(id) || seen.has(id)) continue;
    seen.add(id);
    items.push(mapItem(r));
  }

  console.log(`[Backline] export returned ${raw.length} items, ${items.length} backline`);
  cache = { items, at: Date.now() };
  return items;
}
