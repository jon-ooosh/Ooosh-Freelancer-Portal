/**
 * Shop-sales HireHop probe — settle the last unknowns before any push code.
 *
 * BACKGROUND
 * ----------
 * `docs/SHOP-SALES-SPEC.md` designs an OP-side till that writes sale lines and
 * payments to a permanently-dispatched weekly "Shop Sales" HireHop job. Driving
 * the HireHop UI with the Network tab open (scratch job 16735, Sep 2026) already
 * settled the stock model and the ID scheme — see §2.1 of the spec:
 *
 *   - sale stock is addressed `a<id>` (picklist `a25` ↔ consumables ID 25),
 *     hire stock is `b<id>`
 *   - sale lines come back as `kind: 1` (NOT 2 — a `kind === 2` filter misses them)
 *   - the shelf count drops at DISPATCH, and a line added to an ALREADY-dispatched
 *     job decrements immediately
 *   - deleting the line puts the stock back
 *
 * What the UI capture CANNOT tell us is whether OUR credentials and OUR proven
 * codepath can reproduce it. The HireHop UI posts `items_batch_save.php` from a
 * logged-in browser session; every write in this codebase goes through
 * `/api/save_job.php` with a token (`cost-recharge-hh.ts`, `pcn-recharge.ts`).
 * Those are different doors into the same building.
 *
 * WHAT THIS SCRIPT ANSWERS
 * ------------------------
 *   Q1  Does `/modules/consumables/list.php` work through the broker with our
 *       token, and what does a row actually look like? (READ-ONLY.)
 *       Decides whether the catalogue mirror needs the separate export
 *       credentials that `backline-stock.ts` uses, or just the normal token.
 *
 *   Q2  Does `/api/save_job.php` accept `items: {"a<id>": 1}` for SALE stock?
 *       If it does, §6.1 of the spec stands and we reuse the recharge pattern.
 *       If it rejects the `a` prefix we adopt `items_batch_save.php` instead,
 *       and the §15 reuse table changes. (WRITE — needs --write.)
 *
 *   Q3  What does the resulting line look like on the supply list — `kind`,
 *       `LIST_ID`, and crucially whether `UNIT_PRICE` arrives already populated
 *       from stock. If it does, a list-price sale needs no `items_save.php`
 *       step at all, roughly halving the per-sale call budget. (READ-ONLY.)
 *
 *   Q4  Does `items_picklist_avail.php` return availability for `a<id>` the way
 *       it does for `b<id>` in `backline-matcher.ts`? This is what lets the till
 *       warn "3 of these are reserved for a job on Thursday" (spec §2.3).
 *       (READ-ONLY.)
 *
 *   Q5  Can we remove the line again through the broker, and does the shelf
 *       count return? Also the cleanup step, so the probe leaves no trace.
 *       (WRITE — needs --write.)
 *
 * SAFETY
 * ------
 * Reads run unconditionally. Writes require `--write` AND a `--job` that is a
 * genuine scratch job. The script adds ONE unit of ONE cheap item and removes it
 * again in Q5; if Q5 fails it says so loudly, because on a dispatched job that
 * leaves real stock consumed.
 *
 * USAGE
 * -----
 *   cd backend
 *   npx tsx src/scripts/shop-stock-probe.ts --job=16735 --stock=25          # reads only
 *   npx tsx src/scripts/shop-stock-probe.ts --job=16735 --stock=25 --write  # full probe
 *
 * Defaults are the Sep 2026 scratch job (16735) and 1" green fluoro tape (25).
 */
import hhBroker from '../services/hirehop-broker';

/* eslint-disable @typescript-eslint/no-explicit-any */

const argv = process.argv.slice(2);
function flag(name: string): string | null {
  const hit = argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : null;
}
const HH_JOB = Number(flag('job') || 16735);
const STOCK_ID = Number(flag('stock') || 25);
const DO_WRITE = argv.includes('--write');

function head(title: string) {
  console.log(`\n${'─'.repeat(72)}\n${title}\n${'─'.repeat(72)}`);
}

/** Pull the supply list fresh (never cached — we are watching it change). */
async function readSupplyList(): Promise<any[]> {
  const res = await hhBroker.get<any>('/frames/items_to_supply_list.php',
    { job: HH_JOB }, { priority: 'high', cacheTTL: -1, skipCache: true });
  const d = res?.data;
  return Array.isArray(d) ? d : (d?.items || d?.rows || []);
}

/** Shelf count for STOCK_ID straight from the consumables module. */
async function readShelfCount(): Promise<number | null> {
  const res = await hhBroker.get<any>('/modules/consumables/list.php',
    { unq: STOCK_ID, rows: 20, page: 1 }, { priority: 'high', cacheTTL: -1, skipCache: true });
  const row = (res?.data as any)?.data?.[0];
  return row ? Number(row.QUANTITY) : null;
}

async function q1() {
  head('Q1 — /modules/consumables/list.php through the broker (READ-ONLY)');
  const res = await hhBroker.get<any>('/modules/consumables/list.php',
    { rows: 20, page: 1, del: 0 }, { priority: 'high', cacheTTL: -1, skipCache: true });

  console.log(`success=${res?.success} error=${res?.error ?? 'none'}`);
  if (!res?.success) {
    console.log('  => The normal token does NOT reach this endpoint. The catalogue mirror');
    console.log('     will need the export credentials, as backline-stock.ts uses.');
    return;
  }
  const data: any = res.data;
  console.log(`totalRecords=${data?.totalRecords} pages=${data?.total} rowsReturned=${data?.data?.length}`);
  if (data?.data?.[0]) {
    // NB: this is the first row of the WHOLE sale-stock catalogue in HireHop's
    // default order — it has nothing to do with --job. Q1 never looks at the job.
    console.log('\nFirst row of the catalogue, verbatim (NOT from the job):');
    console.log(JSON.stringify(data.data[0], null, 2));
    const withMax = (data.data as any[]).filter((r) => Number(r.MAX_DISCOUNT) < 100);
    console.log(`\nMAX_DISCOUNT < 100 on this page: ${withMax.length}` +
      (withMax.length ? ` → ${withMax.map((r) => `${r.TITLE} (${r.MAX_DISCOUNT})`).join(', ')}` : ''));
  }
  console.log(`\nheads (categories): ${JSON.stringify(data?.heads)}`);
  console.log('  => Normal token works. Mirror can use the broker.');
}

async function q2q3(): Promise<string | null> {
  head(`Q2 — save_job.php with items: {"a${STOCK_ID}": 1}  (WRITE)`);
  if (!DO_WRITE) { console.log('SKIPPED — pass --write to run.'); return null; }

  const before = await readSupplyList();
  const beforeIds = new Set(before.map((i) => String(i.ID)));
  const shelfBefore = await readShelfCount();
  console.log(`supply list has ${before.length} lines; shelf count = ${shelfBefore}`);

  const payload = { job: HH_JOB, items: JSON.stringify({ [`a${STOCK_ID}`]: 1 }), no_webhook: 1 };
  console.log(`\npayload: ${JSON.stringify(payload)}`);
  const res = await hhBroker.post<any>('/api/save_job.php', payload, { priority: 'high' });
  console.log(`response: ${JSON.stringify(res)}`);

  if (!res?.success) {
    console.log('\n  => save_job.php REJECTED the "a" prefix.');
    console.log('     Spec §6.1 must switch to items_batch_save.php, and the §15 reuse of');
    console.log('     the cost-recharge pattern no longer applies. This is the branch that');
    console.log('     costs us the most rework, so confirm it rather than assuming.');
    return null;
  }

  await new Promise((r) => setTimeout(r, 1500));

  head('Q3 — what the new line looks like (READ-ONLY)');
  const after = await readSupplyList();
  const line = after.find((i) => !beforeIds.has(String(i.ID)) && String(i.LIST_ID) === String(STOCK_ID));
  if (!line) {
    console.log('  !! Line added but NOT found on the supply list. Inspect the job by hand.');
    console.log(`     supply list went ${before.length} → ${after.length} lines.`);
    return null;
  }
  console.log(JSON.stringify(line, null, 2));
  console.log(`\n  kind        = ${line.kind}   (expect 1 for sale stock — NOT 2)`);
  console.log(`  LIST_ID     = ${line.LIST_ID}`);
  console.log(`  UNIT_PRICE  = ${line.UNIT_PRICE}`);
  console.log(`  VAT_RATE    = ${line.VAT_RATE}  (a tax-TYPE index, not a percentage — spec §2.2)`);
  const priced = Number(line.UNIT_PRICE) > 0;
  console.log(priced
    ? '  => Price auto-filled from stock: a LIST-PRICE sale needs no items_save.php step.'
    : '  => Price did NOT auto-fill: every sale needs the items_save.php price step.');

  const shelfAfter = await readShelfCount();
  console.log(`\n  shelf count ${shelfBefore} → ${shelfAfter}` +
    (shelfBefore !== null && shelfAfter !== null && shelfAfter < shelfBefore
      ? '  (consumed immediately — job is dispatched, as the model expects)'
      : '  (unchanged — job is NOT dispatched, so nothing was consumed)'));

  return String(line.ID);
}

async function q4() {
  head(`Q4 — items_picklist_avail.php for a${STOCK_ID} (READ-ONLY)`);
  const res = await hhBroker.get<any>('/php_functions/items_picklist_avail.php',
    { job: HH_JOB, items: JSON.stringify([`a${STOCK_ID}`]) },
    { priority: 'high', cacheTTL: -1, skipCache: true });
  console.log(`success=${res?.success} error=${res?.error ?? 'none'}`);
  console.log(JSON.stringify(res?.data, null, 2));
  const keyed = res?.data && typeof res.data === 'object' ? (res.data as any)[`a${STOCK_ID}`] : undefined;
  console.log(keyed !== undefined
    ? '\n  => Availability IS returned for sale stock. The till can show free-vs-reserved (spec §2.3).'
    : '\n  => No a-keyed row came back. Availability warnings need another route — or drop to shelf count only.');
}

async function q5(lineId: string | null) {
  head('Q5 — remove the line again (WRITE + cleanup)');
  if (!DO_WRITE) { console.log('SKIPPED — pass --write to run.'); return; }
  if (!lineId) { console.log('SKIPPED — Q2 did not produce a line to remove.'); return; }

  const shelfBefore = await readShelfCount();

  // Deletion is its OWN endpoint — `items_delete.php`, captured from the HireHop
  // UI 23 Sep 2026 returning {"success":["b9154"],"ids":["b9154"]}. It is NOT a
  // `delete:` key on save_job.php: that returned success:true and did nothing
  // (spec §2.5), which is why this probe reads back rather than trusting a 200.
  //
  // `b` here prefixes a supply-list LINE id, not a stock id — a different
  // namespace from the `a`/`b` picklist scheme used to ADD (spec §2.1).
  //
  // The exact request field is still a guess, so try the likely shapes in turn
  // and stop at whichever actually removes the line. Safe: each attempt is
  // verified by reading the list back, not by its response.
  const attempts: Array<{ label: string; params: Record<string, string | number> }> = [
    { label: 'items=["b<id>"]', params: { job: HH_JOB, items: JSON.stringify([`b${lineId}`]), no_webhook: 1 } },
    { label: 'ids=["b<id>"]', params: { job: HH_JOB, ids: JSON.stringify([`b${lineId}`]), no_webhook: 1 } },
    { label: 'id=b<id>', params: { job: HH_JOB, id: `b${lineId}`, no_webhook: 1 } },
  ];

  let res: any = null;
  for (const attempt of attempts) {
    console.log(`\n  trying ${attempt.label}: ${JSON.stringify(attempt.params)}`);
    res = await hhBroker.post<any>('/php_functions/items_delete.php', attempt.params, { priority: 'high' });
    console.log(`  response: ${JSON.stringify(res)}`);
    await new Promise((r) => setTimeout(r, 1200));
    const check = await readSupplyList();
    if (!check.find((i) => String(i.ID) === lineId)) {
      console.log(`  => GONE. The working shape is: ${attempt.label}`);
      break;
    }
    console.log('  => line still present; trying the next shape.');
  }

  const after = await readSupplyList();
  const still = after.find((i) => String(i.ID) === lineId);
  const shelf = await readShelfCount();
  console.log(`\n  line still present: ${still ? 'YES' : 'no'}`);
  console.log(`  shelf count now: ${shelf}`);

  if (still) {
    console.log('\n  !! REMOVAL FAILED — the line is still on the job.');
    console.log('  !! Window B reversals (spec §8) will need a different endpoint.');
    // Only alarm about consumed stock if the shelf ACTUALLY moved. Stock is
    // consumed at dispatch (spec §2.1), so on a job below status 5 a failed
    // cleanup leaves a stray line and nothing else — saying otherwise sends
    // someone hunting a stock discrepancy that was never there.
    if (shelf !== null && shelfBefore !== null && shelf < shelfBefore) {
      console.log(`  !! Stock ${STOCK_ID} went ${shelfBefore} → ${shelf}: the job is dispatched, so a`);
      console.log('  !! unit is really consumed. Delete the line in the HireHop UI to put it back.');
    } else {
      console.log('  (Shelf count unchanged — the job is below dispatched, so no stock moved.');
      console.log('   The stray line is cosmetic; delete it in the HireHop UI when convenient.)');
    }
  } else {
    console.log('  => Removal works through the broker. Window B reversals are viable.');
  }
}

async function main() {
  console.log(`Shop-stock probe — HH job ${HH_JOB}, sale stock ${STOCK_ID}, write=${DO_WRITE}`);
  if (!DO_WRITE) console.log('(read-only pass — add --write for Q2/Q5)');

  await q1();
  const lineId = await q2q3();
  await q4();
  await q5(lineId);

  head('Summary');
  console.log('Record the answers in docs/SHOP-SALES-SPEC.md §18 and delete this script');
  console.log('once the push code lands — it is a one-shot, like hh-deposit-release-probe.ts.');
}

main()
  .then(() => process.exit(0))
  .catch((e) => { console.error('\nProbe failed:', e instanceof Error ? e.message : e); process.exit(1); });
