/**
 * Backline stock fetch for the Backline Matcher.
 *
 * Ported from the standalone `alternative-hirehop-stock` Netlify app (Jun 2026)
 * when the Backline Matcher moved into OP. Pulls backline equipment from
 * HireHop's bulk stock export endpoint — the SAME endpoint + EXPORT credentials
 * the Staging Calculator uses (`services/staging-stock.ts`), NOT the API token.
 *
 * Strategy: fetch each backline PARENT category with depot=1 and concatenate.
 * The export returns a category AND all its descendants in one call (proven by
 * the staging integration — a no-cat fetch can come back truncated). The five
 * backline parents (guitars/basses/drums/keyboards/accessories) cover the full
 * 372-410 backline category range. Deduped by stock ID.
 *
 * Cached briefly in-process (stock changes rarely; the matcher hits this on
 * every search). Not routed through the broker — different auth, one bulk call.
 */

const HIREHOP_EXPORT_URL = 'https://myhirehop.com/modules/stock/export_data.php';

// Backline parent categories. The export pulls each parent + its descendants,
// so these five cover the whole backline range (372-410) enumerated in the
// original get-stock.js. Everything except vehicles (370-371), rehearsal (450)
// and storage (449).
const BACKLINE_PARENT_CATEGORIES = [
  372, // Guitars (amps, cabs, combos, FX)
  379, // Basses (amps, cabs, combos)
  385, // Drums (kits, hardware, cymbals)
  399, // Keyboards (keys, amps, pedals)
  406, // Backline accessories (stands, cases, etc.)
];

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

async function fetchCategory(catId: number): Promise<RawItem[]> {
  const { id, key } = exportCreds();
  const params = new URLSearchParams({
    id,
    key,
    depot: '1',
    cat: String(catId),
    sidx: 'TITLE',
    sord: 'asc',
  });
  const response = await fetch(`${HIREHOP_EXPORT_URL}?${params.toString()}`);
  if (!response.ok) {
    throw new Error(`HireHop export returned ${response.status} for cat ${catId}`);
  }
  const data = await response.json();
  return Array.isArray(data) ? data : [];
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

  const seen = new Set<number>();
  const items: BacklineStockItem[] = [];

  for (const catId of BACKLINE_PARENT_CATEGORIES) {
    const raw = await fetchCategory(catId);
    for (const r of raw) {
      const id = Number(r.ID);
      if (!Number.isFinite(id) || seen.has(id)) continue;
      seen.add(id);
      items.push(mapItem(r));
    }
  }

  console.log(`[Backline] export returned ${items.length} backline items`);
  cache = { items, at: Date.now() };
  return items;
}
