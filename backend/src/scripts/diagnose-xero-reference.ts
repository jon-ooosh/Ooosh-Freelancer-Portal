/**
 * Diagnose: does the Xero Reference we send actually land in Xero?
 *
 * For each matched cost, prints what OP would send as Reference vs what Xero
 * currently stores on the pushed object (bill = ACCPAY invoice, spend-money =
 * bank transaction), plus the Xero object's Status. READ-ONLY — no writes.
 *
 * Usage (cd backend):
 *   npx tsx src/scripts/diagnose-xero-reference.ts --id=<cost-uuid>
 *   npx tsx src/scripts/diagnose-xero-reference.ts --supplier="Hi-Q Portslade"
 *   npx tsx src/scripts/diagnose-xero-reference.ts --supplier=Hi-Q --limit=3
 */
import dotenv from 'dotenv';

dotenv.config();

const idArg = process.argv.find((a) => a.startsWith('--id='));
const idFilter = idArg ? idArg.split('=')[1] : null;
const supplierArg = process.argv.find((a) => a.startsWith('--supplier='));
const supplierFilter = supplierArg ? supplierArg.split('=')[1] : null;
const limitArg = process.argv.find((a) => a.startsWith('--limit='));
const limit = limitArg ? parseInt(limitArg.split('=')[1], 10) : 10;

const BILL_METHODS = ['not_yet_paid', 'reimburse_me'];

function opReference(invoiceNumber: string | null, supplierName: string | null): string {
  return (invoiceNumber || supplierName || '').toString().trim().slice(0, 255);
}

async function main() {
  if (!process.env.DATABASE_URL) { console.error('DATABASE_URL not set'); process.exit(1); }
  if (!idFilter && !supplierFilter) { console.error('Pass --id=<uuid> or --supplier=<name>'); process.exit(1); }

  const { query } = await import('../config/database');
  const { isXeroConfigured } = await import('../config/xero');
  const { xeroBroker } = await import('../services/xero-broker');
  if (!isXeroConfigured()) { console.error('Xero not configured'); process.exit(1); }

  const filters: string[] = [`c.xero_object_id IS NOT NULL`];
  const params: unknown[] = [];
  if (idFilter) { params.push(idFilter); filters.push(`c.id = $${params.length}`); }
  if (supplierFilter) { params.push(`%${supplierFilter}%`); filters.push(`c.supplier_name ILIKE $${params.length}`); }

  const { rows } = await query(
    `SELECT id, supplier_name, invoice_number, payment_method, payment_status,
            xero_object_id, xero_payment_id, xero_sync_state
       FROM costs c
      WHERE ${filters.join(' AND ')}
      ORDER BY c.created_at DESC
      LIMIT ${limit}`,
    params,
  );

  console.log(`\n=== Xero Reference diagnosis (${rows.length} cost(s)) ===\n`);
  for (const r of rows) {
    const isBill = BILL_METHODS.includes(r.payment_method);
    const sent = opReference(r.invoice_number, r.supplier_name);
    console.log(`Cost ${r.id}`);
    console.log(`  supplier=${r.supplier_name}  method=${r.payment_method}  ${isBill ? '(BILL/ACCPAY)' : '(SPEND-MONEY)'}`);
    console.log(`  OP invoice_number=${r.invoice_number ?? '(none)'}  → OP would send Reference="${sent}"`);
    console.log(`  OP xero_sync_state=${r.xero_sync_state}  xero_payment_id=${r.xero_payment_id ?? '(none)'}  xero_object_id=${r.xero_object_id}`);
    try {
      const obj = isBill
        ? await xeroBroker.getInvoice(r.xero_object_id)
        : await xeroBroker.getBankTransaction(r.xero_object_id);
      if (!obj) {
        console.log(`  ⚠ Xero object NOT FOUND (deleted/voided in Xero, or wrong id)`);
      } else {
        const xeroRef = obj.Reference ?? '(blank)';
        const xeroStatus = obj.Status ?? obj.status ?? '(?)';
        const isReconciled = obj.IsReconciled ?? '';
        console.log(`  ── Xero stored Reference="${xeroRef}"   Status=${xeroStatus}${isReconciled !== '' ? `  IsReconciled=${isReconciled}` : ''}`);
        if (String(xeroRef) !== sent) {
          console.log(`  ✗ MISMATCH — Xero does not have the invoice number we send.`);
        } else {
          console.log(`  ✓ Match — Xero Reference equals what OP sends.`);
        }
      }
    } catch (err) {
      console.log(`  ⚠ Xero read failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    console.log('');
  }
  process.exit(0);
}

main().catch((err) => { console.error(err); process.exit(1); });
