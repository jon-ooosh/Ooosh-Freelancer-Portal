/**
 * Goodwill read-back probe — docs/GOODWILL-CREDIT-SPEC.md §6.1, the phase 2
 * PRE-REQUISITE. READ-ONLY: it never writes to HireHop or OP.
 *
 * The question: when someone types a goodwill code (e.g. "Goodwill credit GW-TEST")
 * into a line's note in HireHop, does `items_to_supply_list.php` hand that note
 * back to OP? OP has only ever WRITTEN a line note (shop-drain.ts `setLinePrice()`,
 * field `add`); nobody has read one. And does a credit note's description come back
 * from `billing_list.php`?
 *
 * Set-up, on a TEST job in HireHop (an enquiry nobody will send):
 *   1. On any line, give it a discount and type "Goodwill credit GW-TEST" in the
 *      line's note / additional description. Save.
 *   2. Optional: on a job with an approved invoice, raise a small credit note whose
 *      description contains "GW-TEST" (only if you're happy to void it after).
 *
 * Usage:
 *   cd backend
 *   npx tsx src/scripts/goodwill-readback-probe.ts 17123            # looks for GW-TEST
 *   npx tsx src/scripts/goodwill-readback-probe.ts 17123 GW-0012    # another code
 *
 * It prints, for every line on the job: which FIELD (if any) holds the code, the
 * line's name, its price and any discount-looking fields; then the same for the
 * job's billing rows. Paste the output back to Claude.
 */
import pool from '../config/database';
import { hhBroker } from '../services/hirehop-broker';

const jobNumber = Number(process.argv[2]);
const code = (process.argv[3] || 'GW-TEST').toUpperCase();

/** Every field (searching one level into objects) whose text contains the code. */
function fieldsContaining(row: Record<string, unknown>, needle: string, prefix = ''): string[] {
  const hits: string[] = [];
  for (const [k, v] of Object.entries(row || {})) {
    if (v && typeof v === 'object' && !prefix) hits.push(...fieldsContaining(v as Record<string, unknown>, needle, `${k}.`));
    else if (typeof v === 'string' && v.toUpperCase().includes(needle)) hits.push(`${prefix}${k}`);
  }
  return hits;
}

/** Fields whose NAME suggests money or a note — printed so we can see what HireHop calls them. */
function interesting(row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row || {})) {
    if (/price|disc|total|value|add|memo|note|desc|title|name|cust/i.test(k) && (typeof v !== 'object' || v === null)) out[k] = v;
  }
  return out;
}

async function main() {
  if (!Number.isInteger(jobNumber) || jobNumber <= 0) {
    console.error('Usage: npx tsx src/scripts/goodwill-readback-probe.ts <HireHop job number> [CODE]');
    process.exit(1);
  }
  console.log(`Job ${jobNumber}: looking for "${code}"\n`);

  // 1. The supply list — the read the hourly line sync already makes (hirehop-job-sync.ts).
  const items = await hhBroker.get<any>('/frames/items_to_supply_list.php', { job: jobNumber }, { priority: 'low', cacheTTL: 0 });
  if (!items.success) {
    console.log('items_to_supply_list.php failed:', JSON.stringify(items.error ?? null).slice(0, 300));
  } else {
    const data = items.data as any;
    const rows: any[] = Array.isArray(data) ? data : (data?.items || data?.rows || []);
    console.log(`── items_to_supply_list.php: ${rows.length} rows`);
    console.log(`   every field name seen: ${Array.from(new Set(rows.flatMap((r) => Object.keys(r || {})))).sort().join(', ')}\n`);
    let found = 0;
    for (const r of rows) {
      const hits = fieldsContaining(r, code);
      if (hits.length) found++;
      console.log(`${hits.length ? '★ FOUND in ' + hits.join(', ') : '  -'}  kind=${r.kind}  ${JSON.stringify(interesting(r))}`);
    }
    console.log(found ? `\n→ The code IS readable from the supply list (${found} line).` : '\n→ The code was NOT found in any supply-list field.');
  }

  // 2. Billing — credit notes are kind 2 (routes/money.ts reads the same call).
  const billing = await hhBroker.get<any>('/php_functions/billing_list.php', { main_id: jobNumber, type: 1 }, { priority: 'low', cacheTTL: 0 });
  if (!billing.success) {
    console.log('\nbilling_list.php failed:', JSON.stringify(billing.error ?? null).slice(0, 300));
  } else {
    const rows: any[] = (billing.data as any)?.rows || [];
    console.log(`\n── billing_list.php: ${rows.length} rows`);
    for (const r of rows) {
      const hits = fieldsContaining(r, code);
      const d = r.data || {};
      console.log(`${hits.length ? '★ FOUND in ' + hits.join(', ') : '  -'}  kind=${r.kind}  number=${r.number ?? d.NUMBER ?? ''}  desc=${JSON.stringify(d.DESCRIPTION ?? r.desc ?? '')}  credit=${r.credit ?? ''}  debit=${r.debit ?? ''}  status=${d.STATUS ?? ''}`);
    }
  }
}

main()
  .catch((e) => { console.error('Probe failed:', e); process.exitCode = 1; })
  .finally(async () => { await pool.end().catch(() => undefined); setTimeout(() => process.exit(), 500); });
