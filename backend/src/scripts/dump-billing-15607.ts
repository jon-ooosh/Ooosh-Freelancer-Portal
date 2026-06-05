/**
 * One-shot: dump billing_list.php rows for a job so we can see exactly how
 * HireHop publishes the kind=3 payment-application twins for an
 * excess-deposit-applied-to-hire-invoice case (job 15607 / Brandon Morales).
 *
 * Confirms the OP money.ts hire-balance bug: the £450 of excess applied to
 * the hire invoice isn't being credited to the hire side. We need to know,
 * per kind=3 row: data.ID (dedup key), OWNER, OWNER_DEPOSIT, parent_is,
 * credit sign, and desc/MEMO — to decide whether to classify by
 * OWNER_DEPOSIT membership (portal's approach) vs description keyword.
 *
 * Run on the server:
 *   cd /var/www/ooosh-portal/backend
 *   npx tsx src/scripts/dump-billing-15607.ts 15607
 */
import { hhBroker } from '../services/hirehop-broker';

async function main() {
  const jobNumber = parseInt(process.argv[2] || '15607', 10);
  console.log(`\n=== billing_list.php for HH job ${jobNumber} ===\n`);

  const resp = await hhBroker.get<{ rows?: Array<Record<string, unknown>>; banks?: unknown }>(
    '/php_functions/billing_list.php',
    { main_id: jobNumber, type: 1 },
    { priority: 'high', cacheTTL: 0, skipCache: true }
  );

  if (!resp.success || !resp.data) {
    console.error('Fetch failed:', resp.error || 'no data');
    process.exit(1);
  }

  const rows = (resp.data.rows as Array<Record<string, unknown>>) || [];
  console.log(`Total rows: ${rows.length}\n`);

  for (const row of rows) {
    const data = (row.data as Record<string, unknown>) || {};
    const kind = row.kind;
    const summary: Record<string, unknown> = {
      kind,
      id: row.id,
      number: row.number,
      desc: row.desc,
      credit: row.credit,
      debit: row.debit,
      accrued: row.accrued,
      owing: row.owing,
      status: row.status,
    };
    // The fields that drive kind=3 classification:
    if (String(kind) === '3' || String(kind) === '6') {
      summary['data.ID'] = data.ID;
      summary['data.OWNER'] = data.OWNER;
      summary['data.OWNER_DEPOSIT'] = data.OWNER_DEPOSIT;
      summary['data.parent_is'] = data.parent_is;
      summary['data.DESCRIPTION'] = data.DESCRIPTION;
      summary['data.MEMO'] = data.MEMO;
      summary['data.ACC_ACCOUNT_ID'] = data.ACC_ACCOUNT_ID;
    }
    console.log(JSON.stringify(summary));
  }

  console.log('\n=== done ===\n');
  process.exit(0);
}

main().catch((err) => {
  console.error('Script error:', err);
  process.exit(1);
});
