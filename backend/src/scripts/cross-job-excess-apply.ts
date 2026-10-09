/**
 * Cross-job excess → invoice apply (PROOF + interim manual tool).
 *
 * Applies part of a held excess deposit (sitting on one HireHop job) to an
 * OUTSTANDING INVOICE ON A DIFFERENT, SAME-CLIENT HireHop job. This is exactly
 * what our existing `POST /api/excess/:id/claim` endpoint already does — it
 * posts a deposit→invoice payment application via `billing_payments_save.php`
 * with OWNER=<invoice id> + deposit=<deposit id> and never checks the invoice
 * belongs to the excess's own job. The ONLY thing missing from the product is a
 * picker that can surface another job's invoice; the backend mechanism is the
 * same as a normal claim / a rollover claim.
 *
 * PURPOSE 1 — proof: confirm HireHop's API accepts the application when the
 *   target invoice is on an UNRELATED same-client job (not in the excess's
 *   rollover chain). If it does, the cross-job-apply feature is real-settlement;
 *   if HH rejects, we fall back to the tracking-only model. Dry-run shows the
 *   exact payload before anything is sent.
 *
 * PURPOSE 2 — interim tool: until the cross-job invoice picker UI exists, this
 *   is the safe way to perform a genuine cross-job excess application.
 *
 * Mirrors the `/claim` endpoint precisely (same billing_payments_save fields,
 * same Xero post_payment sync, same OP claim_amount accumulation + status
 * rule). Does NOT do the reimburse leg — refund the remainder via the Money
 * tab's Manage → Reimburse afterwards.
 *
 * SAFETY:
 *   - Dry-run by default. Prints the source excess, the resolved target
 *     invoice, and the exact HH payload. Sends NOTHING without --commit.
 *   - On --commit, HH push happens FIRST; OP is updated only if HH accepts
 *     (502-equivalent abort leaves OP untouched — same contract as the route).
 *   - Refuses if: excess has no hh_deposit_id, amount > available balance,
 *     target invoice not found / already paid / owing < amount, or the target
 *     job is a different client than the excess (override with --allow-cross-client).
 *
 * Usage (run on the server — needs DB + Redis + HH creds):
 *   cd /var/www/ooosh-portal/backend
 *   # dry-run: apply £137.62 of 15865's excess to job 15278's invoice
 *   npx tsx src/scripts/cross-job-excess-apply.ts --excess-job=15865 --target-job=15278 --amount=137.62
 *   # then, if the plan looks right:
 *   npx tsx src/scripts/cross-job-excess-apply.ts --excess-job=15865 --target-job=15278 --amount=137.62 --commit
 *
 * Disambiguation flags (only if the script asks):
 *   --excess-id=<uuid>     pick a specific excess record (if the job has >1)
 *   --invoice-id=<hh id>   pick a specific target invoice (if the job has >1 open)
 *   --allow-cross-client   proceed even though target job is a different client
 */
import { query } from '../config/database';
import { hhBroker } from '../services/hirehop-broker';

function arg(name: string): string | undefined {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.split('=').slice(1).join('=') : undefined;
}
const commit = process.argv.includes('--commit');
const allowCrossClient = process.argv.includes('--allow-cross-client');
const excessJob = arg('excess-job');
const excessId = arg('excess-id');
const targetJob = arg('target-job');
const invoiceIdArg = arg('invoice-id');
const amount = Number(arg('amount'));

function die(msg: string): never { console.error(`\n✗ ${msg}\n`); process.exit(1); }
const money = (n: number) => `£${n.toFixed(2)}`;

async function main() {
  if ((!excessJob && !excessId) || !targetJob || !(amount > 0)) {
    die('Required: (--excess-job=<HH#> or --excess-id=<uuid>) AND --target-job=<HH#> AND --amount=<n>');
  }

  // ── 1. Resolve the source excess record ──────────────────────────────────
  const excessRows = await query(
    excessId
      ? `SELECT je.*, j.hh_job_number AS src_hh, j.client_id AS src_client_id, j.client_name AS src_client_name
           FROM job_excess je JOIN jobs j ON j.id = je.job_id WHERE je.id = $1`
      : `SELECT je.*, j.hh_job_number AS src_hh, j.client_id AS src_client_id, j.client_name AS src_client_name
           FROM job_excess je JOIN jobs j ON j.id = je.job_id
          WHERE j.hh_job_number = $1
            AND COALESCE(je.excess_amount_taken,0) > 0
            AND je.hh_deposit_id IS NOT NULL
          ORDER BY je.created_at DESC`,
    [excessId || excessJob]
  );
  if (excessRows.rows.length === 0) die('No excess record found (with money taken + a HireHop deposit linked) for that job/id.');
  if (excessRows.rows.length > 1) {
    console.error('\nMultiple candidate excess records — re-run with --excess-id=<uuid>:');
    for (const r of excessRows.rows) {
      console.error(`  ${r.id}  status=${r.excess_status}  taken=${money(Number(r.excess_amount_taken||0))}  deposit=${r.hh_deposit_id}  ${r.display_name || ''}`);
    }
    process.exit(1);
  }
  const ex = excessRows.rows[0];
  const taken = Number(ex.excess_amount_taken || 0);
  const claimed = Number(ex.claim_amount || 0);
  const reimbursed = Number(ex.reimbursement_amount || 0);
  const available = taken - claimed - reimbursed;

  if (!ex.hh_deposit_id) die('Excess record has no hh_deposit_id — link the HireHop deposit first (Money tab → Link HH Deposit).');
  if (amount > available + 0.005) die(`Amount ${money(amount)} exceeds available balance ${money(available)} (taken ${money(taken)} − claimed ${money(claimed)} − reimbursed ${money(reimbursed)}).`);

  // ── 2. Resolve the target invoice on the OTHER job ───────────────────────
  const targetJobRows = await query(
    `SELECT id, hh_job_number, client_id, client_name FROM jobs WHERE hh_job_number = $1`,
    [targetJob]
  );
  if (targetJobRows.rows.length === 0) die(`Target job ${targetJob} not found in OP.`);
  const tj = targetJobRows.rows[0];

  // Same-client guard — the correctness boundary for cross-job apply.
  const sameClient = ex.src_client_id && tj.client_id && String(ex.src_client_id) === String(tj.client_id);
  if (!sameClient && !allowCrossClient) {
    die(`Target job ${targetJob} (${tj.client_name || 'unknown client'}) is a DIFFERENT client than the excess job ${ex.src_hh} (${ex.src_client_name || 'unknown'}). Applying one client's excess to another client's invoice is almost always wrong. Re-run with --allow-cross-client only if you're certain.`);
  }

  const billing = await hhBroker.get<{ rows?: Array<Record<string, any>> }>(
    '/php_functions/billing_list.php',
    { main_id: targetJob, type: 1 },
    { priority: 'high', cacheTTL: 0, skipCache: true }
  );
  if (!billing.success || !billing.data) die(`Could not load HireHop billing for job ${targetJob}: ${billing.error || 'no data'}`);

  const openInvoices: Array<{ id: number; number: string; desc: string; owing: number }> = [];
  for (const row of billing.data.rows || []) {
    if (parseInt(row.kind ?? '0') !== 1) continue;
    const owing = Number(row.owing ?? row.data?.owing ?? 0);
    if (owing <= 0.005) continue;
    const id = parseInt(row.data?.ID || row.number || String(row.id).replace('b', '') || '0');
    if (!id) continue;
    openInvoices.push({ id, number: String(row.number || row.data?.NUMBER || id), desc: String(row.data?.DESCRIPTION || row.desc || ''), owing });
  }
  if (openInvoices.length === 0) die(`No outstanding invoices on job ${targetJob}. (Need an APPROVED invoice with owing > 0 to apply against — a proforma/quote won't do.)`);

  let invoice = invoiceIdArg ? openInvoices.find((i) => String(i.id) === invoiceIdArg) : (openInvoices.length === 1 ? openInvoices[0] : undefined);
  if (!invoice) {
    console.error(`\nMultiple open invoices on job ${targetJob} — re-run with --invoice-id=<hh id>:`);
    for (const i of openInvoices) console.error(`  id=${i.id}  ${i.number}  owing=${money(i.owing)}  ${i.desc}`);
    process.exit(1);
  }
  if (amount > invoice.owing + 0.005) die(`Amount ${money(amount)} exceeds the invoice's owing ${money(invoice.owing)} (invoice ${invoice.number}).`);

  // ── 3. Show the plan (the exact HH payload) ──────────────────────────────
  const currentDate = new Date().toISOString().split('T')[0];
  const description = `${ex.src_hh} - Excess applied to invoice (cross-job → ${targetJob})`;
  const memo = `Excess claim — cross-job apply to job ${targetJob} invoice ${invoice.number} (recorded via Ooosh OP)`;
  const payload = {
    id: 0, date: currentDate, desc: description, paid: amount, memo,
    bank: 169, OWNER: invoice.id, deposit: ex.hh_deposit_id, correction: 0, no_webhook: 1,
  };

  console.log('\n─────────────────────────────────────────────────────────────');
  console.log(' CROSS-JOB EXCESS APPLY' + (commit ? '  [COMMIT]' : '  [DRY-RUN]'));
  console.log('─────────────────────────────────────────────────────────────');
  console.log(` Source excess     : ${ex.id}`);
  console.log(`   on HH job       : ${ex.src_hh}  (${ex.src_client_name || '—'})`);
  console.log(`   HH deposit id   : ${ex.hh_deposit_id}   ← the real money (may physically sit on a rolled-from job)`);
  console.log(`   status / taken  : ${ex.excess_status} / ${money(taken)}`);
  console.log(`   available now   : ${money(available)}  (claimed ${money(claimed)} + reimbursed ${money(reimbursed)} already)`);
  console.log(` Target invoice    : ${invoice.number} (HH id ${invoice.id}) on job ${targetJob} (${tj.client_name || '—'})`);
  console.log(`   owing           : ${money(invoice.owing)}`);
  console.log(`   same client?    : ${sameClient ? 'yes ✓' : 'NO ⚠ (override in effect)'}`);
  console.log(` Amount to apply   : ${money(amount)}`);
  console.log('\n billing_payments_save.php payload:');
  console.log('  ' + JSON.stringify(payload));
  console.log('\n After this: excess available → ' + money(available - amount) + `; invoice owing → ${money(invoice.owing - amount)}.`);
  console.log(' (Reimburse the remaining ' + money(available - amount) + ' via Money tab → Manage → Reimburse, method Wise.)');

  if (!commit) {
    console.log('\n DRY-RUN — nothing sent. Re-run with --commit to apply.\n');
    process.exit(0);
  }

  // ── 4. Commit: HH first, OP only on success (same contract as /claim) ─────
  console.log('\n → Posting application to HireHop…');
  const hhResult = await hhBroker.post<Record<string, any>>('/php_functions/billing_payments_save.php', payload, { priority: 'high' });
  if (!hhResult.success || !hhResult.data) {
    die(`HireHop REJECTED the cross-job application: ${hhResult.error || 'no data'}. OP NOT updated. ` +
        `If HH refuses cross-job specifically, the feature must use the tracking-only model instead.`);
  }
  const appId = hhResult.data.hh_id || hhResult.data.id || hhResult.data.ID || null;
  console.log(`   ✓ HH accepted. Application id: ${appId}`);

  if (appId) {
    try {
      await hhBroker.post('/php_functions/accounting/tasks.php',
        { hh_package_type: 1, hh_acc_package_id: 3, hh_task: 'post_payment', hh_id: appId, hh_acc_id: '' },
        { priority: 'high' });
      console.log('   ✓ Xero post_payment sync triggered.');
    } catch (e) {
      console.warn('   ⚠ Xero sync failed (non-fatal — HH application posted, reconciliation will catch up):', e);
    }
  }

  const newClaim = claimed + amount;
  const fullyConsumed = (newClaim + reimbursed) >= taken - 0.005;
  const newStatus = fullyConsumed && reimbursed < 0.005 ? 'fully_claimed' : ex.excess_status;
  const noteEntry = `[${currentDate}] ${money(amount)} cross-job claim → job ${targetJob} invoice ${invoice.number}`;
  const newClaimNotes = ex.claim_notes ? `${ex.claim_notes}\n${noteEntry}` : noteEntry;

  await query(
    `UPDATE job_excess SET claim_amount = $1, claim_notes = $2, excess_status = $3, updated_at = NOW() WHERE id = $4`,
    [newClaim, newClaimNotes, newStatus, ex.id]
  );
  console.log(`   ✓ OP excess updated: claim_amount → ${money(newClaim)}, status → ${newStatus}.`);
  console.log(`\n Done. Target job ${targetJob} invoice ${invoice.number} should now read ${money(invoice.owing - amount)} owing.`);
  console.log(` Remaining ${money(available - amount)} on the excess — reimburse via the Money tab.\n`);
  process.exit(0);
}

main().catch((err) => { console.error('\nScript error:', err); process.exit(1); });
