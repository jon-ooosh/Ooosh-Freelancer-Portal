/**
 * HireHop deposit-release probe — settle the "error 370" unknowns before code.
 *
 * BACKGROUND (job 15628, 9 Sep 2026)
 * ----------------------------------
 * OP's Money-tab refund posts `billing_payments_save.php` with `OWNER: 0,
 * deposit: <id>` — HireHop's grammar for "take money back OUT of this deposit".
 * That only works while the deposit still holds unallocated money. Once the
 * deposit has been fully APPLIED to an invoice, HireHop rejects the refund with
 * error **370** ("nothing left on this deposit to refund").
 *
 * On 15628 the £1,419.28 balance deposit had been applied to OT-INV-12182 in
 * full, then a £199.11 credit note left the invoice £91.12 overpaid. The Stripe
 * refund succeeded (money genuinely left our account) and the HireHop leg then
 * failed 370 — leaving OP, HireHop and Xero disagreeing with no record of why.
 *
 * The manual fix that WORKED (verified in the HireHop UI, admin mode): reduce
 * the deposit→invoice application by the refund amount, which releases that
 * much back onto the deposit, then refund the freed balance. Two writes.
 *
 * WHAT THIS SCRIPT IS FOR
 * -----------------------
 * We have never issued an `id != 0` (edit) call to `billing_payments_save.php`
 * — every callsite in this codebase creates rows with `id: 0`. Before OP
 * automates the release, three things must stop being guesses:
 *
 *   Q1  Does HireHop publish a deposit's UNALLOCATED (refundable) balance
 *       directly, as `owing` on the kind=6 row? The 15628 screenshots suggest
 *       yes (the deposit read `Owed -£91.12` after the application was reduced
 *       and `£0.00` once refunded). If so, OP's pre-flight check is a field
 *       read rather than derived arithmetic — far more robust.
 *       ANSWERED READ-ONLY. No flags needed.
 *
 *   Q2  Does a NEW NEGATIVE application (`OWNER: <invoice>, deposit: <id>,
 *       paid: -<amount>`) release the money? This is append-only, leaves an
 *       audit trail, and needs no edit — strongly preferred if it works.
 *
 *   Q3  Failing that, does EDITING the existing application down
 *       (`id: <appId>, paid: <reduced>`) work over the API as it does in the
 *       UI? Destructive, so second choice.
 *
 *   Q4  After a successful release, does the refund (`OWNER: 0`) now succeed
 *       where it previously returned 370?
 *
 * SAFETY
 * ------
 *   - READ-ONLY by default. Q1 is answered with no writes at all.
 *   - Q2/Q3/Q4 send nothing without `--commit`; without it the exact payload is
 *     printed for inspection.
 *   - Every write is followed by a fresh re-read (cache bypassed) and a
 *     before/after diff, so the effect is observed rather than assumed.
 *   - Refuses to run against a job with real client money unless
 *     `--allow-live` is passed. Use the TESTING 123 job (#16668).
 *   - Touches HireHop ONLY. Never writes to OP's database, never calls Stripe,
 *     and never triggers the Xero sync unless `--xero` is passed.
 *
 * USAGE (on the server — needs Redis + HH creds)
 * ----------------------------------------------
 *   cd /var/www/ooosh-portal/backend
 *
 *   # Q1 — dump the billing tree and test the `owing` hypothesis. No writes.
 *   npx tsx src/scripts/hh-deposit-release-probe.ts --job=16668
 *
 *   # Q2 — plan a £10 release via a negative application (prints payload only)
 *   npx tsx src/scripts/hh-deposit-release-probe.ts --job=16668 --deposit=<id> --amount=10 --method=negative
 *   # ...then actually send it, and re-read to see what changed:
 *   npx tsx src/scripts/hh-deposit-release-probe.ts --job=16668 --deposit=<id> --amount=10 --method=negative --commit
 *
 *   # Q3 — same, editing the existing application down instead
 *   npx tsx src/scripts/hh-deposit-release-probe.ts --job=16668 --deposit=<id> --amount=10 --method=edit --commit
 *
 *   # Q4 — release, then immediately attempt the refund that used to 370
 *   npx tsx src/scripts/hh-deposit-release-probe.ts --job=16668 --deposit=<id> --amount=10 --method=negative --commit --refund
 *
 * Add `--xero` to also fire the post_payment sync on the refund (leave it off
 * on the test job unless you want to tidy Xero afterwards).
 */
import { hhBroker } from '../services/hirehop-broker';

function arg(name: string): string | undefined {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.split('=').slice(1).join('=') : undefined;
}
const jobArg = arg('job');
const depositArg = arg('deposit');
const amountArg = arg('amount');
const method = (arg('method') || 'negative') as 'negative' | 'edit';
const commit = process.argv.includes('--commit');
const doRefund = process.argv.includes('--refund');
const doXero = process.argv.includes('--xero');
const allowLive = process.argv.includes('--allow-live');

// The disposable job this probe is meant for. Anything else needs --allow-live,
// because a botched release on a real job leaves an invoice showing money owing.
const TEST_HH_JOB = 16668;

const money = (n: number) => `${n < 0 ? '-' : ''}£${Math.abs(n).toFixed(2)}`;

type Row = Record<string, any>;

interface Movement {
  appId: number;
  kind: 'application' | 'refund';
  invoiceId: number;
  /** Signed, from the DEPOSIT's point of view: positive = money left the deposit. */
  movedOut: number;
  date: string;
  bank: number | null;
  desc: string;
  memo: string;
  side: string;
}

interface DepositView {
  id: number;
  description: string;
  credit: number;           // cash received on this deposit
  rawOwing: number | null;  // HH's own `owing` field, verbatim
  movements: Movement[];
  movedOut: number;         // sum of movements (derived)
  derivedAvailable: number; // credit - movedOut
}

/** True once at least one row told us which twin it is, so signs are trustworthy. */
let sawParentIs = false;

async function readBilling(hhJob: number): Promise<Row[]> {
  const res = await hhBroker.get<{ rows?: Row[] }>(
    '/php_functions/billing_list.php',
    { main_id: hhJob, type: 1 },
    { priority: 'high', cacheTTL: 0, skipCache: true },
  );
  if (!res.success) throw new Error(`billing_list failed: ${res.error}`);
  return res.data?.rows || [];
}

/**
 * Raw dump — the PRIMARY evidence this probe exists to collect. Everything
 * below is my interpretation of these rows; this is what HireHop actually said.
 * Read this first if a derived number looks wrong.
 */
function dumpRaw(rows: Row[]) {
  console.log(`\n── RAW billing_list rows (kind 3 + 6) ${'─'.repeat(28)}`);
  for (const row of rows) {
    const kind = parseInt(row.kind ?? '0');
    if (kind !== 3 && kind !== 6) continue;
    const d = row.data || {};
    console.log(`  kind=${kind} id=${d.ID ?? '?'} parent_is=${row.parent_is ?? d.parent_is ?? '(absent)'} ` +
      `credit=${row.credit ?? d.credit ?? '?'} debit=${row.debit ?? '?'} owing=${row.owing ?? d.owing ?? d.OWED ?? '(absent)'} ` +
      `OWNER=${d.OWNER ?? '?'} OWNER_DEPOSIT=${d.OWNER_DEPOSIT ?? '?'} bank=${d.ACC_ACCOUNT_ID ?? '?'} ` +
      `desc="${String(d.DESCRIPTION || row.desc || '').slice(0, 44)}"`);
  }
}

/**
 * Build a per-deposit view.
 *
 * SIGN HANDLING — the thing most likely to mislead us here. HireHop
 * dual-publishes each payment application as TWO kind=3 rows sharing one
 * data.ID: a deposit-side twin (credit < 0, parent_is="deposit") and an
 * invoice-side twin (credit > 0, parent_is="invoice"). routes/money.ts dedups
 * on data.ID and takes Math.abs(), which is safe there because OWNER tells it
 * the direction. It is NOT safe here: the whole point of the Q2 probe is a
 * NEGATIVE application, whose twins have the opposite signs to a normal one, so
 * abs() would read a release as another £10 leaving the deposit.
 *
 * So we key on the DEPOSIT-SIDE twin and keep the sign: movedOut = -credit.
 * A normal application (credit -10) gives movedOut +10; a release (credit +10)
 * gives movedOut -10, correctly handing the money back.
 *
 * If no row carries parent_is we fall back to dedup-on-ID with abs() and say so
 * loudly, because then the release reading cannot be trusted.
 */
function buildDeposits(rows: Row[]): DepositView[] {
  const deposits = new Map<number, DepositView>();
  for (const row of rows) {
    if (parseInt(row.kind ?? '0') !== 6) continue;
    const d = row.data || {};
    const id = parseInt(d.ID || row.number || '0');
    if (!id) continue;
    const credit = parseFloat(row.credit ?? d.credit ?? '0');
    const rawOwing = row.owing ?? d.owing ?? d.OWED ?? d.OWING;
    deposits.set(id, {
      id,
      description: String(d.DESCRIPTION || row.desc || ''),
      credit,
      rawOwing: rawOwing == null || rawOwing === '' ? null : parseFloat(String(rawOwing)),
      movements: [],
      movedOut: 0,
      derivedAvailable: credit,
    });
  }

  const seen = new Set<number>();
  for (const row of rows) {
    if (parseInt(row.kind ?? '0') !== 3) continue;
    const d = row.data || {};
    const side = String(row.parent_is ?? d.parent_is ?? '');
    if (side) sawParentIs = true;
    const appId = parseInt(d.ID || '0');
    const depId = d.OWNER_DEPOSIT != null ? parseInt(String(d.OWNER_DEPOSIT)) : 0;
    const dep = deposits.get(depId);
    if (!dep) continue;

    // Prefer the deposit-side twin (sign-safe). Without parent_is, fall back to
    // one row per data.ID and absolute value.
    if (side) {
      if (side !== 'deposit') continue;
    } else {
      if (appId && seen.has(appId)) continue;
      if (appId) seen.add(appId);
    }

    const signedCredit = parseFloat(row.credit ?? d.credit ?? '0');
    const movedOut = side ? -signedCredit : Math.abs(signedCredit);
    const invoiceId = d.OWNER != null ? parseInt(String(d.OWNER)) : 0;
    dep.movements.push({
      appId,
      // OWNER=0 on a deposit-child row is a REFUND out to the client, not an
      // invoice application. It still spends the deposit, so it must reduce the
      // free balance — omitting it would report a refunded deposit as still
      // refundable and invite a double refund.
      kind: invoiceId > 0 ? 'application' : 'refund',
      invoiceId,
      movedOut,
      date: String(d.DATE || row.date || ''),
      bank: d.ACC_ACCOUNT_ID != null ? Number(d.ACC_ACCOUNT_ID) : null,
      desc: String(d.DESCRIPTION || row.desc || ''),
      memo: String(d.MEMO || ''),
      side: side || '(inferred)',
    });
    dep.movedOut += movedOut;
  }

  for (const dep of deposits.values()) dep.derivedAvailable = dep.credit - dep.movedOut;
  return [...deposits.values()];
}

function printDeposits(label: string, deps: DepositView[]) {
  console.log(`\n── ${label} ${'─'.repeat(Math.max(0, 60 - label.length))}`);
  if (deps.length === 0) { console.log('  (no deposits on this job)'); return; }
  for (const d of deps) {
    const apps = d.movements.filter((m) => m.kind === 'application');
    const refunds = d.movements.filter((m) => m.kind === 'refund');
    console.log(`  Deposit ${d.id} — ${d.description || '(no description)'}`);
    console.log(`    received        ${money(d.credit)}`);
    console.log(`    moved out       ${money(d.movedOut)}  (${apps.length} application${apps.length === 1 ? '' : 's'}, ${refunds.length} refund${refunds.length === 1 ? '' : 's'})`);
    console.log(`    derived free    ${money(d.derivedAvailable)}   <- credit - movements`);
    console.log(`    HH raw 'owing'  ${d.rawOwing == null ? '(absent)' : money(d.rawOwing)}`);
    for (const m of d.movements) {
      const target = m.kind === 'application' ? `invoice ${m.invoiceId}` : 'client (refund)';
      console.log(`      ${m.kind === 'application' ? 'app' : 'ref'} ${m.appId} -> ${target}  ${money(m.movedOut)}  ${m.date}  bank=${m.bank ?? '?'}  side=${m.side}`);
    }
  }
  if (!sawParentIs) {
    console.log(`  ! No row carried parent_is — signs are INFERRED. A release reading may be wrong;`);
    console.log(`    check the RAW dump above before trusting the after-figures.`);
  }
}

/**
 * Q1: is HH's `owing` on a deposit the same number as credit - applications?
 * Sign is reported rather than assumed — the 15628 UI showed it negative.
 */
function reportOwingHypothesis(deps: DepositView[]) {
  console.log(`\n── Q1: is deposit.owing the refundable balance? ${'─'.repeat(16)}`);
  const withOwing = deps.filter((d) => d.rawOwing != null);
  if (withOwing.length === 0) {
    console.log('  INCONCLUSIVE — no deposit row carried an `owing` field.');
    console.log('  => OP must DERIVE availability from kind=3 applications.');
    return;
  }
  let sameSign = 0, flipped = 0, mismatch = 0;
  for (const d of withOwing) {
    const raw = d.rawOwing as number;
    const derived = d.derivedAvailable;
    const matchesDirect = Math.abs(raw - derived) < 0.005;
    const matchesFlipped = Math.abs(-raw - derived) < 0.005;
    const verdict = matchesDirect ? 'MATCHES (same sign)'
      : matchesFlipped ? 'MATCHES (sign flipped — owing is negated)'
      : `MISMATCH (owing ${money(raw)} vs derived ${money(derived)})`;
    if (matchesDirect) sameSign++; else if (matchesFlipped) flipped++; else mismatch++;
    console.log(`  deposit ${d.id}: ${verdict}`);
  }
  if (mismatch > 0) {
    console.log('  => DO NOT trust `owing`. Derive from kind=3 applications instead.');
  } else if (flipped > 0 && sameSign > 0) {
    console.log('  => INCONSISTENT SIGN across deposits. Derive instead.');
  } else if (flipped > 0) {
    console.log('  => `owing` is the refundable balance, NEGATED. Use Math.abs(owing).');
  } else {
    console.log('  => `owing` is the refundable balance directly. Safe as the pre-flight check.');
  }
  console.log('  (Only meaningful once at least one deposit is PARTLY applied — on a');
  console.log('   job where every deposit is 0%% or 100%% applied both readings agree.)');
}

async function main() {
  if (!jobArg) {
    console.error('Missing --job=<hh job number>. See the header comment for usage.');
    process.exit(1);
  }
  const hhJob = parseInt(jobArg);
  if (!Number.isFinite(hhJob)) { console.error('--job must be a number'); process.exit(1); }
  if (hhJob !== TEST_HH_JOB && !allowLive) {
    console.error(`Refusing to probe job ${hhJob}: this script is for the disposable test job (${TEST_HH_JOB}).`);
    console.error('A failed release leaves an invoice showing money owing. Pass --allow-live if you really mean it.');
    process.exit(1);
  }

  console.log(`\n=== HireHop deposit-release probe — job ${hhJob} ===`);
  console.log(`mode: ${commit ? 'COMMIT (will write to HireHop)' : 'DRY RUN (no writes)'}`);

  const beforeRows = await readBilling(hhJob);
  dumpRaw(beforeRows);
  const before = buildDeposits(beforeRows);
  printDeposits('BEFORE', before);
  reportOwingHypothesis(before);

  if (!depositArg || !amountArg) {
    console.log('\nNo --deposit/--amount given — stopping after the read-only pass (Q1).');
    console.log('To probe the release (Q2/Q3), re-run with --deposit=<id> --amount=<gbp>.');
    return;
  }

  const depositId = parseInt(depositArg);
  const amount = parseFloat(amountArg);
  if (!Number.isFinite(depositId) || !Number.isFinite(amount) || amount <= 0) {
    console.error('--deposit must be a number and --amount a positive number'); process.exit(1);
  }
  const dep = before.find((d) => d.id === depositId);
  if (!dep) { console.error(`Deposit ${depositId} not found on job ${hhJob}.`); process.exit(1); }
  const apps = dep.movements.filter((m) => m.kind === 'application' && m.movedOut > 0);
  if (apps.length === 0) {
    console.error(`Deposit ${depositId} has no invoice application — there is nothing to release.`);
    console.error(`It already has ${money(dep.derivedAvailable)} free, so a refund should work without a release.`);
    process.exit(1);
  }
  if (apps.length > 1) {
    console.error(`Deposit ${depositId} is applied to ${apps.length} invoices. This probe only handles the single-application case.`);
    process.exit(1);
  }
  const app = apps[0];
  if (amount > app.movedOut + 0.005) {
    console.error(`Cannot release ${money(amount)} — the application to invoice ${app.invoiceId} is only ${money(app.movedOut)}.`);
    process.exit(1);
  }

  const today = new Date().toISOString().split('T')[0];
  const bank = app.bank ?? 265;

  // Q2 — append-only: a NEW application carrying a negative amount.
  const negativePayload = {
    id: 0,
    date: today,
    desc: `${hhJob} - Release from invoice (probe)`,
    paid: -amount,
    memo: `Probe: release ${money(amount)} back onto deposit ${depositId} (via Ooosh OP probe)`,
    bank,
    OWNER: app.invoiceId,
    deposit: depositId,
    correction: 0,
    no_webhook: 1,
  };
  // Q3 — destructive: edit the existing application down.
  const editPayload = {
    id: app.appId,
    date: app.date ? String(app.date).split(' ')[0] : today,
    desc: app.desc,
    paid: Number((app.movedOut - amount).toFixed(2)),
    memo: app.memo,
    bank,
    OWNER: app.invoiceId,
    deposit: depositId,
    correction: 0,
    no_webhook: 1,
  };
  const payload = method === 'edit' ? editPayload : negativePayload;

  console.log(`\n── PLAN: release ${money(amount)} from invoice ${app.invoiceId} back onto deposit ${depositId} ──`);
  console.log(`  method: ${method === 'edit' ? 'Q3 EDIT existing application (destructive)' : 'Q2 NEW NEGATIVE application (append-only)'}`);
  console.log(`  billing_payments_save.php payload:`);
  console.log(JSON.stringify(payload, null, 2));

  if (!commit) {
    console.log('\nDRY RUN — nothing sent. Re-run with --commit to send it.');
    return;
  }

  const relRes = await hhBroker.post<Record<string, any>>('/php_functions/billing_payments_save.php', payload, { priority: 'high' });
  console.log(`\n  release response: ${JSON.stringify(relRes)}`);
  if (!relRes.success) {
    console.log(`  => ${method} FAILED (${relRes.error}).`);
    console.log(`     ${method === 'negative' ? 'Try --method=edit.' : 'Both variants rejected — the release cannot be automated; keep it manual.'}`);
  }

  const afterRows = await readBilling(hhJob);
  dumpRaw(afterRows);
  const afterRelease = buildDeposits(afterRows);
  printDeposits('AFTER RELEASE', afterRelease);
  const depAfter = afterRelease.find((d) => d.id === depositId);
  if (depAfter) {
    const gained = depAfter.derivedAvailable - dep.derivedAvailable;
    console.log(`\n  free balance on deposit ${depositId}: ${money(dep.derivedAvailable)} -> ${money(depAfter.derivedAvailable)} (${gained >= 0 ? '+' : ''}${money(gained)})`);
    console.log(`  => release ${Math.abs(gained - amount) < 0.005 ? 'WORKED — exactly the amount asked for.' : 'DID NOT land as expected. Do not automate this variant.'}`);
  }

  if (!doRefund) {
    console.log('\nStopping before the refund leg. Add --refund to prove the 370 is gone.');
    return;
  }

  // Q4 — the refund that previously returned 370.
  const refundPayload = {
    id: 0,
    date: today,
    desc: `${hhJob} - Refund (probe)`,
    paid: amount,
    memo: `Probe: refund ${money(amount)} from deposit ${depositId} (via Ooosh OP probe)`,
    bank,
    OWNER: 0,
    deposit: depositId,
    no_webhook: 1,
  };
  console.log(`\n── Q4: refund ${money(amount)} from deposit ${depositId} ──`);
  console.log(JSON.stringify(refundPayload, null, 2));
  const refRes = await hhBroker.post<Record<string, any>>('/php_functions/billing_payments_save.php', refundPayload, { priority: 'high' });
  console.log(`  refund response: ${JSON.stringify(refRes)}`);
  if (!refRes.success) {
    console.log(`  => refund STILL REJECTED (${refRes.error}).${String(refRes.error) === '370' ? ' Same 370 — the release did not actually free the money.' : ''}`);
  } else {
    console.log('  => refund ACCEPTED. The release + refund sequence is safe to automate.');
  }

  const refundAppId = refRes.success
    ? ((refRes.data as any)?.hh_id ?? (refRes.data as any)?.id ?? (refRes.data as any)?.ID ?? null)
    : null;

  if (doXero && refundAppId) {
    const sync = await hhBroker.post('/php_functions/accounting/tasks.php',
      { hh_package_type: 1, hh_acc_package_id: 3, hh_task: 'post_payment', hh_id: refundAppId, hh_acc_id: '' },
      { priority: 'high' });
    console.log(`  Xero post_payment: ${sync.success ? 'triggered' : `failed (${sync.error})`}`);
  } else if (refundAppId) {
    console.log(`  (Xero sync SKIPPED — pass --xero to fire post_payment on application ${refundAppId}.)`);
  }

  const finalRows = await readBilling(hhJob);
  dumpRaw(finalRows);
  printDeposits('AFTER REFUND', buildDeposits(finalRows));
}

main()
  .then(() => process.exit(0))
  .catch((e) => { console.error('\nProbe failed:', e instanceof Error ? e.message : e); process.exit(1); });
