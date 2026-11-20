/**
 * Wise incoming payments, read from the Wise API — the main source since Nov 2026.
 *
 * Why: Wise did not send its "Money received" email for transfer #2501093374
 * (£2,363.64 from O I B RE, 17 Nov 2026) and the email was OP's only signal, so the
 * payment was missed with no alert. The read-only API token (already used for the
 * cash forecast's balance) can read the account's activity feed and each transfer —
 * proven on the live account 20 Nov 2026. Statements need PSD2 extra authentication
 * and webhook subscriptions need a different kind of token, so OP asks every 5 minutes.
 *
 * Every 5 minutes (when `system_settings.wise_api_incoming_enabled` is 'true'): the last
 * 48 hours of activity → each completed transfer IN that OP has no row for → its
 * transfer record (for the reference) → `storeAndMatchIncoming()`, the same matcher,
 * recording and queue as the email. The email detector stays as the backup; Wise's
 * transfer number keeps one row per payment whichever source sees it first.
 * Money in vs out: services/wise-api-incoming-rules.ts.
 *
 * Also here: "Add a Wise transfer by number" (a person brings one into the queue — it
 * never records itself) and the read-only missed-payments report
 * (scripts/wise-missed-payments.ts).
 */
import { query } from '../config/database';
import { getSystemSetting } from '../routes/system-settings';
import {
  getWiseBusinessProfileId, getWiseTransfer, isWiseConfigured, listWiseActivities, WiseApiError,
  type WiseActivity,
} from '../config/wise';
import { AMOUNT_TOLERANCE, BANK_METHODS, normaliseName, storeAndMatchIncoming, type ParsedWisePayment } from './wise-incoming';
import { isIncomingTransferActivity, samePayer, toIncomingPayment, parseWiseTransferCreated } from './wise-api-incoming-rules';

export const WISE_API_SETTING_KEY = 'wise_api_incoming_enabled';
/** How far back each poll looks. Generous: a poll that failed for a day still catches up. */
export const POLL_LOOKBACK_HOURS = 48;

async function knownTransferNumbers(numbers: string[]): Promise<Set<string>> {
  if (numbers.length === 0) return new Set();
  const r = await query(
    `SELECT DISTINCT transfer_number FROM incoming_bank_payments WHERE transfer_number = ANY($1::text[])`,
    [numbers],
  );
  return new Set(r.rows.map((x: { transfer_number: string }) => String(x.transfer_number)));
}

/**
 * An email row for the same money that never got a transfer number (an email shape
 * without "Transfer Number:"): same amount to the penny, same payer, within a day.
 */
async function findEmailRowWithoutNumber(parsed: ParsedWisePayment, receivedAt: Date): Promise<string | null> {
  const r = await query(
    `SELECT id, payer_name FROM incoming_bank_payments
      WHERE transfer_number IS NULL AND amount > 0 AND ABS(amount - $1) < 0.005
        AND received_at BETWEEN $2::timestamptz - INTERVAL '1 day' AND $2::timestamptz + INTERVAL '1 day'`,
    [parsed.amount, receivedAt],
  );
  const hit = r.rows.find((x: { payer_name: string | null }) => samePayer(x.payer_name, parsed.payerName, normaliseName));
  return hit ? hit.id : null;
}

/** As above, and give that row the transfer number so the next poll knows it. */
async function adoptEmailRowWithoutNumber(parsed: ParsedWisePayment, receivedAt: Date): Promise<string | null> {
  const id = await findEmailRowWithoutNumber(parsed, receivedAt);
  if (!id) return null;
  try {
    await query(
      `UPDATE incoming_bank_payments SET transfer_number = $2 WHERE id = $1 AND transfer_number IS NULL`,
      [id, parsed.transferNumber],
    );
  } catch (err) {
    // Another row took the number in the meantime — either way the payment is in OP.
    console.warn(`[wise-api] could not give row ${id} transfer #${parsed.transferNumber}:`, err instanceof Error ? err.message : err);
  }
  return id;
}

// ── The 5-minute poll ───────────────────────────────────────────────────────

let polling = false;
let lastFailureLoggedAt = 0;
/** Transfers already reported as skipped, so the 48-hour window doesn't log them 576 times. */
const skipLogged = new Set<string>();

export interface PollResult { incoming: number; stored: number; skipped: number }

export async function pollWiseIncoming(): Promise<PollResult | null> {
  if (polling || !isWiseConfigured()) return null;
  if ((await getSystemSetting(WISE_API_SETTING_KEY))?.trim().toLowerCase() !== 'true') return null;
  polling = true;
  try {
    const profileId = await getWiseBusinessProfileId();
    const until = new Date();
    const since = new Date(until.getTime() - POLL_LOOKBACK_HOURS * 3600_000);
    const incoming = (await listWiseActivities(profileId, since, until)).filter(isIncomingTransferActivity);
    const known = await knownTransferNumbers(incoming.map(a => String(a.resource?.id)));
    const result: PollResult = { incoming: incoming.length, stored: 0, skipped: 0 };

    for (const a of incoming) {
      const number = String(a.resource?.id);
      if (known.has(number)) continue;
      try {
        const outcome = await ingestActivity(a);
        if (outcome === 'stored') result.stored++;
        if (outcome === 'skipped') result.skipped++;
      } catch (err) {
        // One bad transfer must not hold up the rest; it is tried again next poll.
        console.error(`[wise-api] transfer #${number} failed:`, err instanceof Error ? err.message : err);
      }
    }
    return result;
  } catch (err) {
    // Token expired, Wise down… The email still works; log once an hour, not every 5 minutes.
    if (Date.now() - lastFailureLoggedAt > 3600_000) {
      lastFailureLoggedAt = Date.now();
      console.error('[wise-api] poll failed:', err instanceof WiseApiError ? `${err.status} ${err.message}` : err);
    }
    return null;
  } finally {
    polling = false;
  }
}

async function ingestActivity(a: WiseActivity): Promise<'stored' | 'duplicate' | 'skipped'> {
  const number = String(a.resource?.id);
  const transfer = await getWiseTransfer(number);
  const check = toIncomingPayment(a, transfer);
  if (!check.ok) {
    if (!skipLogged.has(number)) {
      skipLogged.add(number);
      console.warn(`[wise-api] skipped transfer #${number}: ${check.reason}`);
    }
    return 'skipped';
  }
  if (await adoptEmailRowWithoutNumber(check.parsed, check.receivedAt)) return 'duplicate';
  const outcome = await storeAndMatchIncoming(check.parsed, {
    key: `wise-api:${number}`, source: 'wise_api', mailbox: null, receivedAt: check.receivedAt, subject: null,
  });
  if (outcome === 'stored') {
    console.log(`[wise-api] transfer #${number}: £${check.parsed.amount} from ${check.parsed.payerName} — stored and matched`);
  }
  return outcome;
}

// ── "Add a Wise transfer by number" ────────────────────────────────────────

/** Find a transfer's activity: Wise's feed only filters by time, so look a day either side. */
async function findActivityForTransfer(number: string, created: Date): Promise<WiseActivity | null> {
  const profileId = await getWiseBusinessProfileId();
  const day = 24 * 3600_000;
  const list = await listWiseActivities(profileId, new Date(created.getTime() - day), new Date(created.getTime() + day));
  return list.find(x => String(x.resource?.id) === number && x.resource?.type === 'TRANSFER') || null;
}

async function rowIdForTransfer(number: string): Promise<string | null> {
  const r = await query(
    `SELECT id FROM incoming_bank_payments WHERE transfer_number = $1
      ORDER BY (match_method IS DISTINCT FROM 'duplicate_copy') DESC, created_at LIMIT 1`,
    [number],
  );
  return r.rows[0]?.id ?? null;
}

export type AddByNumberResult =
  | { ok: true; id: string; already: boolean }
  | { ok: false; status: number; error: string };

/**
 * Bring one transfer into the queue by Wise's number — for money Wise shows that OP
 * never saw. Checked exactly like the poll (money in, amounts agree), matched for
 * suggestions, but NEVER recorded and never emailed: the person who added it decides.
 * Already in OP → that row.
 */
export async function addWiseTransferByNumber(input: string, actorLabel: string): Promise<AddByNumberResult> {
  const number = String(input || '').trim().replace(/^#/, '');
  if (!/^\d{6,15}$/.test(number)) {
    return { ok: false, status: 400, error: 'A Wise transfer number is digits only, like 2501093374' };
  }
  if (!isWiseConfigured()) {
    return { ok: false, status: 503, error: 'The Wise API is not set up on the server (WISE_API_TOKEN)' };
  }
  const existing = await rowIdForTransfer(number);
  if (existing) return { ok: true, id: existing, already: true };

  let transfer;
  try {
    transfer = await getWiseTransfer(number);
  } catch (err) {
    if (err instanceof WiseApiError && (err.status === 404 || err.status === 403)) {
      return { ok: false, status: 404, error: `Wise has no transfer #${number} on this account` };
    }
    return { ok: false, status: 502, error: `Wise didn't answer: ${err instanceof Error ? err.message : String(err)}` };
  }
  if (transfer.sourceAccount != null) {
    return { ok: false, status: 400, error: `Transfer #${number} is money we sent, not money in` };
  }
  const created = parseWiseTransferCreated(transfer.created);
  if (!created) return { ok: false, status: 502, error: `Wise doesn't say when #${number} arrived` };

  const activity = await findActivityForTransfer(number, created);
  if (!activity) {
    return { ok: false, status: 404, error: `Couldn't find #${number} in the Wise account's activity around ${created.toLocaleDateString('en-GB', { timeZone: 'Europe/London' })}` };
  }
  const check = toIncomingPayment(activity, transfer);
  if (!check.ok) return { ok: false, status: 400, error: `Not added: ${check.reason}` };

  const adopted = await adoptEmailRowWithoutNumber(check.parsed, check.receivedAt);
  if (adopted) return { ok: true, id: adopted, already: true };

  await storeAndMatchIncoming(check.parsed, {
    key: `wise-api:${number}`, source: 'wise_api', mailbox: null, receivedAt: check.receivedAt, subject: null,
    queueOnly: true, notePrefix: `Added from Wise transfer #${number} by ${actorLabel}`,
  });
  const id = await rowIdForTransfer(number);
  if (!id) return { ok: false, status: 500, error: 'Stored, but the row could not be found again' };
  return { ok: true, id, already: false };
}

// ── Missed-payments report (read-only) ─────────────────────────────────────

export interface MissedTransfer {
  transferNumber: string;
  receivedAt: Date;
  payerName: string | null;
  amount: number;
  currency: string;
  reference: string | null;
  /** Bank payments of the same amount on a job around then — probably recorded by hand. */
  possiblyRecorded: Array<{ hh_job_number: number | null; amount: number; payment_date: string; payment_method: string }>;
  problem?: string;
}

/**
 * Every transfer IN between two dates that OP has no row for. Writes nothing.
 * A hit with `possiblyRecorded` was most likely typed in by hand from the Money tab;
 * one with none is either a Xero-only invoice (storage) or genuinely missed.
 */
export async function findMissedWiseTransfers(since: Date, until: Date): Promise<{ incoming: number; missed: MissedTransfer[] }> {
  const profileId = await getWiseBusinessProfileId();
  const incoming = (await listWiseActivities(profileId, since, until, 200)).filter(isIncomingTransferActivity);
  const known = await knownTransferNumbers(incoming.map(a => String(a.resource?.id)));
  const missed: MissedTransfer[] = [];

  for (const a of incoming) {
    const number = String(a.resource?.id);
    if (known.has(number)) continue;
    await new Promise(r => setTimeout(r, 250)); // gentle on Wise: one transfer read each
    let check;
    try {
      check = toIncomingPayment(a, await getWiseTransfer(number));
    } catch (err) {
      missed.push({
        transferNumber: number, receivedAt: new Date(a.createdOn || 0), payerName: null, amount: 0, currency: '',
        reference: null, possiblyRecorded: [], problem: `transfer read failed: ${err instanceof Error ? err.message : String(err)}`,
      });
      continue;
    }
    if (!check.ok) {
      missed.push({
        transferNumber: number, receivedAt: new Date(a.createdOn || 0), payerName: null, amount: 0, currency: '',
        reference: null, possiblyRecorded: [], problem: check.reason,
      });
      continue;
    }
    if (await findEmailRowWithoutNumber(check.parsed, check.receivedAt)) continue;

    const recorded = await query(
      `SELECT j.hh_job_number, jp.amount, jp.payment_date, jp.payment_method
         FROM job_payments jp
         LEFT JOIN jobs j ON j.id = jp.job_id
        WHERE ABS(jp.amount - $1) <= $2
          AND jp.payment_status = 'completed'
          AND jp.payment_method = ANY($3::text[])
          AND jp.payment_date BETWEEN $4::timestamptz - INTERVAL '14 days' AND $4::timestamptz + INTERVAL '30 days'
        ORDER BY ABS(EXTRACT(EPOCH FROM (jp.payment_date - $4::timestamptz)))
        LIMIT 5`,
      [check.parsed.amount, AMOUNT_TOLERANCE, BANK_METHODS, check.receivedAt],
    );
    missed.push({
      transferNumber: number,
      receivedAt: check.receivedAt,
      payerName: check.parsed.payerName,
      amount: check.parsed.amount,
      currency: check.parsed.currency,
      reference: check.parsed.reference,
      possiblyRecorded: recorded.rows.map((x: { hh_job_number: number | null; amount: string; payment_date: Date | string; payment_method: string }) => ({
        hh_job_number: x.hh_job_number,
        amount: parseFloat(x.amount),
        payment_date: x.payment_date instanceof Date ? x.payment_date.toISOString() : String(x.payment_date),
        payment_method: x.payment_method,
      })),
    });
  }
  missed.sort((x, y) => x.receivedAt.getTime() - y.receivedAt.getTime());
  return { incoming: incoming.length, missed };
}
