/**
 * Read-only report: Wise transfers IN that OP never saw (no row in
 * incoming_bank_payments). Born from transfer #2501093374 (17 Nov 2026), which Wise
 * never emailed about. Writes nothing — for each one a person decides: it was
 * recorded by hand already (the "possibly recorded" column), it was a Xero-only
 * invoice, or it was genuinely missed (Money overview → "Add a Wise transfer by
 * number" brings it into the queue).
 *
 * Needs WISE_API_TOKEN / WISE_ENV=live in backend/.env (the cash forecast's token).
 *
 * Usage (cd backend):
 *   npx tsx src/scripts/wise-missed-payments.ts                       # since 6 Oct 2026 (the email detector went live)
 *   npx tsx src/scripts/wise-missed-payments.ts --since 2026-11-01 --until 2026-11-20
 */
import dotenv from 'dotenv';
import { getPool } from '../config/database';
import { findMissedWiseTransfers } from '../services/wise-api-incoming';

dotenv.config();

function arg(name: string): string | null {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] ?? null : null;
}

function day(s: string | null, fallback: Date): Date {
  if (!s) return fallback;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) throw new Error(`Dates are YYYY-MM-DD, not "${s}"`);
  return new Date(`${s}T00:00:00Z`);
}

async function main() {
  const since = day(arg('--since'), new Date('2026-10-06T00:00:00Z'));
  const untilArg = arg('--until');
  const until = untilArg ? new Date(day(untilArg, new Date()).getTime() + 24 * 3600_000) : new Date();
  console.log(`Wise transfers in, ${since.toISOString().slice(0, 10)} → ${until.toISOString().slice(0, 16)} UTC …`);

  const { incoming, missed } = await findMissedWiseTransfers(since, until);
  console.log(`${incoming} transfer(s) in; ${missed.length} not in OP's Wise queue.\n`);
  for (const m of missed) {
    const when = m.receivedAt.toLocaleString('en-GB', { timeZone: 'Europe/London', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
    if (m.problem) {
      console.log(`#${m.transferNumber}  ${when}  — not readable: ${m.problem}`);
      continue;
    }
    console.log(`#${m.transferNumber}  ${when}  ${m.currency} ${m.amount.toFixed(2)}  from ${m.payerName || '?'}  ref "${m.reference || ''}"`);
    if (m.possiblyRecorded.length) {
      for (const p of m.possiblyRecorded) {
        console.log(`      possibly recorded by hand: job ${p.hh_job_number ?? '?'} £${p.amount.toFixed(2)} ${p.payment_method} on ${p.payment_date.slice(0, 10)}`);
      }
    } else {
      console.log('      no job payment of that amount around then — a Xero-only invoice, or missed');
    }
  }
}

main()
  .then(async () => { await getPool().end(); process.exit(0); })
  .catch(async (err) => { console.error('FAILED:', err instanceof Error ? err.message : err); await getPool().end().catch(() => undefined); process.exit(1); });
