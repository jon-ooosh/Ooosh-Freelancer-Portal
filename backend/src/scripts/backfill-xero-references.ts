/**
 * Backfill Xero Reference on already-pushed costs.
 *
 * WHY: a cost's supplier invoice number lands in Xero's Reference field ONLY at
 * push time (or via the "Re-sync to Xero" action). The normal "Push now" button
 * (POST /costs/:id/sync-xero) short-circuits anything already pushed and never
 * touches Reference again — and the re-sync action was only reachable via the
 * amber "Re-sync" pill, which only shows when xero_stale=TRUE. So costs pushed
 * before invoice_number extraction was reliable (blank / supplier-name-only
 * Reference) had NO reachable way to get their real invoice number into Xero
 * Reference in place.
 *
 * This script sweeps every pushed, non-terminal-locked cost and re-pushes it
 * IN PLACE via the existing resyncCostToXero engine — which updates the Xero
 * object (never duplicates) and writes the current xeroReference(cost) to
 * Reference. Reconciled spend-money + paid bills are locked by Xero and are
 * reported + skipped (fix those directly in Xero).
 *
 * Re-syncing a cost whose Reference is already correct is a harmless no-op
 * (writes the same value) — so it's safe to run over the whole set.
 *
 * SAFETY: this ONLY updates the Xero object's header/lines to match the OP cost
 * (same as clicking "Re-sync"). It does NOT create new bills/transactions, does
 * NOT move money, does NOT email anyone. Dry-run by default.
 *
 * Usage (cd backend):
 *   npx tsx src/scripts/backfill-xero-references.ts               # dry-run (no writes)
 *   npx tsx src/scripts/backfill-xero-references.ts --commit      # apply
 *   npx tsx src/scripts/backfill-xero-references.ts --supplier=Parcel2Go --commit
 *   npx tsx src/scripts/backfill-xero-references.ts --id=<cost-uuid> --commit
 *   npx tsx src/scripts/backfill-xero-references.ts --limit=5 --commit
 */
import dotenv from 'dotenv';

dotenv.config();

const commit = process.argv.includes('--commit');
const supplierArg = process.argv.find((a) => a.startsWith('--supplier='));
const supplierFilter = supplierArg ? supplierArg.split('=')[1] : null;
const idArg = process.argv.find((a) => a.startsWith('--id='));
const idFilter = idArg ? idArg.split('=')[1] : null;
const limitArg = process.argv.find((a) => a.startsWith('--limit='));
const limit = limitArg ? parseInt(limitArg.split('=')[1], 10) : null;

// Mirror of cost-xero-push.ts xeroReference() so the dry-run can show what the
// Reference WILL become. Keep in step with that helper. (Some suppliers use a
// UUID-shaped invoice number verbatim, e.g. Spotify — that's genuine, keep it.)
function wouldBeReference(invoiceNumber: string | null, supplierName: string | null): string {
  return (invoiceNumber || supplierName || '').toString().trim().slice(0, 255);
}

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error('DATABASE_URL not set');
    process.exit(1);
  }

  // Import after dotenv so config modules see the env.
  const { query } = await import('../config/database');
  const { isXeroConfigured } = await import('../config/xero');
  const { resyncCostToXero } = await import('../services/cost-xero-push');

  if (!isXeroConfigured()) {
    console.error('Xero not configured (XERO_* env vars missing) — nothing to do.');
    process.exit(1);
  }

  // Candidates: pushed to Xero, in a state we can re-sync. Bills (not_yet_paid /
  // reimburse_me) and spend-money (paid-now methods) both land in these states.
  // We flag the two Xero-locked shapes so the dry-run report is honest:
  //   - reconciled spend-money  (xero_sync_state='reconciled')
  //   - paid bill               (payment_status='paid' OR xero_payment_id set,
  //                              only meaningful for BILL_METHODS)
  const filters: string[] = [
    `c.xero_object_id IS NOT NULL`,
    `c.xero_sync_state IN ('bill_created','attached','reconciled')`,
  ];
  const params: unknown[] = [];
  if (idFilter) {
    params.push(idFilter);
    filters.push(`c.id = $${params.length}`);
  }
  if (supplierFilter) {
    params.push(`%${supplierFilter}%`);
    filters.push(`c.supplier_name ILIKE $${params.length}`);
  }

  const sql = `
    SELECT c.id, c.supplier_name, c.invoice_number, c.payment_method,
           c.payment_status, c.xero_payment_id, c.xero_sync_state
      FROM costs c
     WHERE ${filters.join(' AND ')}
     ORDER BY c.created_at ASC
     ${limit ? `LIMIT ${limit}` : ''}
  `;
  const { rows } = await query(sql, params);

  const BILL_METHODS = ['not_yet_paid', 'reimburse_me'];
  const isLocked = (r: any): string | null => {
    const isBill = BILL_METHODS.includes(r.payment_method);
    if (isBill && (r.payment_status === 'paid' || r.xero_payment_id)) return 'paid bill (locked in Xero)';
    if (!isBill && r.xero_sync_state === 'reconciled') return 'reconciled spend-money (locked in Xero)';
    return null;
  };

  console.log(`\n=== Backfill Xero References ${commit ? '(COMMIT)' : '(dry-run)'} ===`);
  console.log(`Candidates: ${rows.length}\n`);

  const actionable: any[] = [];
  const locked: any[] = [];
  for (const r of rows) {
    const lockReason = isLocked(r);
    const ref = wouldBeReference(r.invoice_number, r.supplier_name);
    const invNote = r.invoice_number ? `invoice_number=${r.invoice_number}` : `invoice_number=(none)`;
    const line = `  ${r.id}  ${(r.supplier_name || '(no supplier)').padEnd(28)}  ${invNote}  → Reference="${ref}"`;
    if (lockReason) {
      locked.push({ r, lockReason });
      console.log(`${line}  [SKIP: ${lockReason}]`);
    } else {
      actionable.push(r);
      console.log(line);
    }
  }

  console.log(`\nActionable (will re-sync): ${actionable.length}`);
  console.log(`Locked (skipped): ${locked.length}`);

  if (!commit) {
    console.log(`\nDry-run — no changes made. Re-run with --commit to apply.\n`);
    process.exit(0);
  }

  console.log(`\nRe-syncing ${actionable.length} cost(s) to Xero…\n`);
  let pushed = 0;
  let skippedLocked = 0;
  let skipped = 0;
  let errored = 0;
  for (const r of actionable) {
    try {
      const res = await resyncCostToXero(r.id);
      if (res.pushed) {
        pushed++;
        console.log(`  ✓ ${r.id}  ${r.supplier_name || ''}`);
      } else if (res.locked) {
        skippedLocked++;
        console.log(`  ⊘ ${r.id}  locked: ${res.error || ''}`);
      } else if (res.skipped) {
        skipped++;
        console.log(`  – ${r.id}  skipped: ${res.skipped}`);
      } else {
        errored++;
        console.log(`  ✗ ${r.id}  error: ${res.error || 'unknown'}`);
      }
    } catch (err) {
      errored++;
      console.log(`  ✗ ${r.id}  threw: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  console.log(`\n=== Done ===`);
  console.log(`Re-synced: ${pushed}`);
  console.log(`Locked (Xero): ${skippedLocked}`);
  console.log(`Skipped: ${skipped}`);
  console.log(`Errored: ${errored}\n`);
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
