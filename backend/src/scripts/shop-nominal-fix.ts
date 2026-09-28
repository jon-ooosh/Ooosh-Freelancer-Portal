/**
 * Put every HireHop sales-stock item on the "Shop Sales" nominal group.
 *
 * WHY: most sale items were created on HireHop's DEFAULT nominal group
 * ("Backline hire"), so shop sales reached Xero as 200 Income – Backline Hire
 * instead of 270 Sales – Shop (seen on OT-INV-12253, 28 Sep 2026). jon: every
 * shop item belongs on 270. Forward-looking only — invoices already in Xero
 * keep their codes.
 *
 * HOW (captured from HireHop's UI, 28 Sep 2026):
 *   - `ACC_NOMINAL` on an item is HireHop's OWN nominal-group id, which HireHop
 *     maps to a Xero account (Settings › Accounting). 6 = "Shop Sales" (→ 270),
 *     24 = "Backline hire". Blank = the default group.
 *   - POST /modules/consumables/save.php saves the WHOLE item — title, prices,
 *     cost, VAT, category and all — so this reads each item from
 *     /modules/consumables/list.php and sends every field back unchanged except
 *     ACC_NOMINAL. Sending only the nominal would risk blanking the rest.
 *   - The save answers with the item as HireHop now holds it. That is the
 *     read-back: nominal must be 6 AND every other field this compares must be
 *     unchanged, or the run STOPS at that item (success:true has lied before).
 *
 * Usage (cd backend):
 *   npx tsx src/scripts/shop-nominal-fix.ts                 # dry-run: what would change
 *   npx tsx src/scripts/shop-nominal-fix.ts --id=828 --commit    # one item first
 *   npx tsx src/scripts/shop-nominal-fix.ts --limit=10 --commit  # a few
 *   npx tsx src/scripts/shop-nominal-fix.ts --commit             # the rest
 *
 * Re-running is safe: items already on 6 are skipped.
 */
import dotenv from 'dotenv';

dotenv.config();

/* eslint-disable @typescript-eslint/no-explicit-any */

const SHOP_SALES_NOMINAL = '6';
const LIST = '/modules/consumables/list.php';
const SAVE = '/modules/consumables/save.php';

const commit = process.argv.includes('--commit');
const idArg = process.argv.find((a) => a.startsWith('--id='));
const onlyId = idArg ? Number(idArg.split('=')[1]) : null;
const limitArg = process.argv.find((a) => a.startsWith('--limit='));
const limit = limitArg ? Number(limitArg.split('=')[1]) : Infinity;

const str = (v: unknown) => (v == null ? '' : String(v));
const price = (item: any, k: string) => Number(item?.PRICES?.[k]?.PRICE ?? 0);

/** The fields the UI sends, rebuilt from the item as listed — only ACC_NOMINAL changes. */
function payloadFor(item: any): Record<string, unknown> {
  const prices: Record<string, { PRICE: number; TYPE: number }> = {};
  for (const k of ['_1', '_2', '_3']) {
    // The list doesn't return TYPE; the UI sent 0 (one-off, as sale stock is sold).
    prices[k] = { PRICE: price(item, k), TYPE: Number(item?.PRICES?.[k]?.TYPE ?? 0) };
  }
  return {
    ID: item.ID,
    TITLE: str(item.TITLE),
    ALT_TITLE: str(item.ALT_TITLE),
    IMAGE_ID: item.IMAGE_ID ?? 0,
    PART_NUMBER: str(item.PART_NUMBER),
    BARCODE: str(item.BARCODE),
    MEMO: str(item.MEMO),
    CATEGORY_ID: item.CATEGORY_ID,
    EXCLUDE_FROM_WEBSHOP: item.EXCLUDE_FROM_WEBSHOP ?? 0,
    VAT_RATE: item.VAT_RATE ?? 0,
    MAX_DISCOUNT: item.MAX_DISCOUNT ?? 100,
    ACC_NOMINAL: SHOP_SALES_NOMINAL,
    ACC_NOMINAL_PO: str(item.ACC_NOMINAL_PO),
    COST_PRICE: str(item.COST_PRICE),
    BOUGHT_FROM: str(item.BOUGHT_FROM),
    REORDER_LEVEL: str(item.REORDER_LEVEL),
    REORDER_QTY: item.REORDER_QTY ?? 0,
    WEIGHT: item.WEIGHT ?? 0,
    LOCATION: str(item.LOCATION),
    WIDTH: item.WIDTH ?? 0,
    LENGTH: item.LENGTH ?? 0,
    HEIGHT: item.HEIGHT ?? 0,
    VOLUME: item.VOLUME ?? 0,
    COUNTRY_ORIGIN: str(item.COUNTRY_ORIGIN),
    HS_CODE: str(item.HS_CODE),
    STATUS: item.STATUS ?? 0,
    FLAG: item.FLAG ?? 0,
    PRICES: JSON.stringify(prices),
    DEPOT_LIMITS: JSON.stringify(Array.isArray(item.DEPOT_LIMITS) ? item.DEPOT_LIMITS : []),
  };
}

/** What must be identical before and after, apart from the nominal. */
function fingerprint(item: any): Record<string, string> {
  return {
    TITLE: str(item.TITLE),
    PART_NUMBER: str(item.PART_NUMBER),
    BARCODE: str(item.BARCODE),
    CATEGORY_ID: str(item.CATEGORY_ID),
    VAT_RATE: str(item.VAT_RATE),
    MAX_DISCOUNT: str(item.MAX_DISCOUNT),
    STATUS: str(item.STATUS),
    COST_PRICE: Number(item.COST_PRICE || 0).toFixed(2),
    BOUGHT_FROM: str(item.BOUGHT_FROM),
    PRICE_A: price(item, '_1').toFixed(2),
    PRICE_B: price(item, '_2').toFixed(2),
    PRICE_C: price(item, '_3').toFixed(2),
  };
}

async function main() {
  const { default: hhBroker } = await import('../services/hirehop-broker');

  // Every active sales-stock item.
  const items: any[] = [];
  for (let page = 1; ; page++) {
    const res = await hhBroker.get<any>(LIST, { page, rows: 200, del: 0 },
      { priority: 'low', cacheTTL: -1, skipCache: true });
    if (!res.success || !res.data) throw new Error(`Listing page ${page} failed: ${res.error || 'no data'}`);
    const rows: any[] = Array.isArray((res.data as any).data) ? (res.data as any).data : [];
    items.push(...rows);
    if (page >= (Number((res.data as any).total) || 1)) break;
  }

  const byNominal = new Map<string, number>();
  for (const it of items) {
    const k = str(it.ACC_NOMINAL) || '(default)';
    byNominal.set(k, (byNominal.get(k) || 0) + 1);
  }
  console.log(`${items.length} sales-stock items. By nominal group id:`);
  for (const [k, n] of [...byNominal].sort((a, b) => b[1] - a[1])) console.log(`  ${k.padEnd(10)} ${n}`);

  let todo = items.filter((it) => str(it.ACC_NOMINAL) !== SHOP_SALES_NOMINAL);
  if (onlyId != null) todo = todo.filter((it) => Number(it.ID) === onlyId);
  todo = todo.slice(0, limit);
  console.log(`\n${todo.length} to move to group ${SHOP_SALES_NOMINAL} ("Shop Sales").`);

  if (!commit) {
    for (const it of todo.slice(0, 15)) console.log(`  ${it.ID}  ${it.TITLE}  (now ${str(it.ACC_NOMINAL) || 'default'})`);
    if (todo.length > 15) console.log(`  … and ${todo.length - 15} more`);
    console.log('\nDry run — nothing changed. Add --commit (try --id=<one item> first).');
    process.exit(0);
  }

  let done = 0;
  for (const it of todo) {
    const before = fingerprint(it);
    const res = await hhBroker.post<any>(SAVE, payloadFor(it), { priority: 'low' });
    const saved = res.success ? (res.data as any)?.data?.find?.((r: any) => Number(r.ID) === Number(it.ID)) : null;
    if (!saved) {
      console.error(`\nSTOPPED at ${it.ID} "${it.TITLE}": HireHop ${res.success ? 'did not return the item' : `refused: ${res.error}`}.`);
      console.error(`${done} item(s) moved before this. Check this one in HireHop before re-running.`);
      process.exit(1);
    }
    const after = fingerprint(saved);
    const changed = Object.keys(before).filter((k) => before[k] !== after[k]);
    if (str(saved.ACC_NOMINAL) !== SHOP_SALES_NOMINAL || changed.length) {
      console.error(`\nSTOPPED at ${it.ID} "${it.TITLE}": read-back is wrong.`);
      console.error(`  nominal now: ${str(saved.ACC_NOMINAL) || '(blank)'}`);
      for (const k of changed) console.error(`  ${k}: "${before[k]}" → "${after[k]}"`);
      console.error(`${done} item(s) moved before this. Put this item right in HireHop before re-running.`);
      process.exit(1);
    }
    done++;
    console.log(`  ✓ ${it.ID}  ${it.TITLE}`);
  }
  console.log(`\nDone — ${done} item(s) now on "Shop Sales".`);
  process.exit(0);
}

main().catch((err) => {
  console.error('Failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});
