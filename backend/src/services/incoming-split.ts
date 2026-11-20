/**
 * Split one Wise transfer across several jobs — the queue's "Split across jobs".
 *
 * Born from #2501093374 (£2,363.64 from O I B RE, ref "MUTATIONS X 3", Nov 2026): one
 * payment for three jobs, which Record could only put on ONE job. A person enters lines
 * (job number, hire or excess, amount) that add up to the transfer to the penny.
 *
 * The rules:
 *   - EVERY line is checked before anything is written (totals, jobs, links, money
 *     already on the job). One bad line refuses the lot, by line — the same rule as
 *     paying bills in a batch (a run that recorded two of three with no record of the
 *     third is worse than one that recorded none).
 *   - A line RECORDS money through services/record-payment.ts (OP row, HireHop deposit
 *     on the Wise bank, excess update, client email — exactly what Record does), or
 *     LINKS to a payment someone already recorded by hand (nothing moves). A line that
 *     looks already recorded is refused with a 409 naming the payment, like Record:
 *     the person chooses "link" or "record anyway".
 *   - Each line is written as 'recording' BEFORE its money moves, then 'recorded'.
 *     HireHop can't do all-or-nothing, so if a line fails the lines before it stay
 *     recorded and the rest wait; the transfer stays in the queue showing what's done,
 *     and finishing it needs only the part that's left.
 *   - The transfer becomes 'recorded' only when the lines that count add up to it.
 *   - One split at a time per transfer (an advisory lock).
 */
import { getClient, query } from '../config/database';
import { recordPayment } from './record-payment';
import {
  AMOUNT_TOLERANCE, describeExisting, findAlreadyRecordedPayment, wisePaymentReference, type ExistingJobPayment,
} from './wise-incoming';
import { checkSplitLines, describeSplit, pence, SPLIT_COUNTING_STATUSES, type SplitLineRequest } from './incoming-split-rules';

/** A 'recording' line older than this was cut off (restart, crash) — it becomes 'failed' with a warning. */
const STALE_RECORDING_MINUTES = 10;

export interface SplitLineConflict {
  /** Index into the request's lines. */
  index: number;
  hh_job_number: number;
  message: string;
  existing: ExistingJobPayment;
}

export interface SplitLineOutcome {
  index: number;
  hh_job_number: number;
  amount: number;
  status: 'recorded' | 'linked' | 'failed' | 'not_started';
  hh_push_error?: string | null;
  error?: string;
}

export type SplitResult =
  | { ok: true; complete: boolean; lines: SplitLineOutcome[] }
  | { ok: false; status: number; error: string; conflicts?: SplitLineConflict[]; lines?: SplitLineOutcome[] };

interface CountingLine { hh_job_number: number | null; payment_type: string; amount: number; status: string }

async function countingLines(incomingId: string): Promise<CountingLine[]> {
  const r = await query(
    `SELECT hh_job_number, payment_type, amount, status FROM incoming_bank_payment_splits
      WHERE incoming_id = $1 AND status = ANY($2::text[]) ORDER BY created_at`,
    [incomingId, [...SPLIT_COUNTING_STATUSES]],
  );
  return r.rows.map((x: { hh_job_number: number | null; payment_type: string; amount: string; status: string }) => ({
    hh_job_number: x.hh_job_number, payment_type: x.payment_type, amount: parseFloat(x.amount), status: x.status,
  }));
}

export async function splitIncomingPayment(
  incomingId: string,
  lines: SplitLineRequest[],
  actor: { id: string; label: string },
): Promise<SplitResult> {
  const client = await getClient();
  let locked = false;
  try {
    const lk = await client.query(`SELECT pg_try_advisory_lock(hashtext($1)) AS ok`, [`incoming-split:${incomingId}`]);
    if (!lk.rows[0]?.ok) return { ok: false, status: 409, error: 'Someone else is splitting this payment right now — try again in a minute' };
    locked = true;

    const rowRes = await query(`SELECT * FROM incoming_bank_payments WHERE id = $1`, [incomingId]);
    const row = rowRes.rows[0];
    if (!row) return { ok: false, status: 404, error: 'Incoming payment not found' };
    if (row.status !== 'unmatched') return { ok: false, status: 400, error: `This payment is already ${row.status}` };
    const total = parseFloat(row.amount);
    if (!(total > 0)) return { ok: false, status: 400, error: 'This payment has no amount to split' };
    if ((row.currency || 'GBP') !== 'GBP') return { ok: false, status: 400, error: `This payment is in ${row.currency} — convert it in Wise first` };

    // A line cut off mid-recording (a restart) can't stay 'recording' forever, or the
    // transfer could never finish. It becomes 'failed' with a warning to check the job:
    // if the money did land, the duplicate check below finds it and offers "link".
    await query(
      `UPDATE incoming_bank_payment_splits
          SET status = 'failed', updated_at = NOW(),
              error = 'Recording was cut off — check job #' || COALESCE(hh_job_number::text, '?') || '''s Money tab: if the payment is there, link to it'
        WHERE incoming_id = $1 AND status = 'recording' AND updated_at < NOW() - make_interval(mins => $2::int)`,
      [incomingId, STALE_RECORDING_MINUTES],
    );
    const done = await countingLines(incomingId);
    if (done.some(d => d.status === 'recording')) {
      return { ok: false, status: 409, error: 'A line of this split is still being recorded — wait a minute and reload' };
    }

    // 1. Totals and shape.
    const problem = checkSplitLines(total, done.map(d => d.amount), lines);
    if (problem) return { ok: false, status: 400, error: problem };

    // 2. Every job exists.
    const numbers = [...new Set(lines.map(l => l.hh_job_number))];
    const jobsRes = await query(`SELECT id, hh_job_number FROM jobs WHERE hh_job_number = ANY($1::int[])`, [numbers]);
    const jobByNumber = new Map<number, string>(jobsRes.rows.map((j: { id: string; hh_job_number: number }) => [Number(j.hh_job_number), j.id]));
    const missing = numbers.filter(n => !jobByNumber.has(n));
    if (missing.length) return { ok: false, status: 400, error: `No job ${missing.map(n => `#${n}`).join(', ')} in OP` };

    // 3. Every link names a real, free payment of that amount on that job.
    const linkRows = new Map<string, { hirehop_deposit_id: number | null }>();
    for (const [i, l] of lines.entries()) {
      if (l.decision !== 'link') continue;
      const p = await query(
        `SELECT jp.id, jp.job_id, jp.amount, jp.hirehop_deposit_id,
                EXISTS (SELECT 1 FROM incoming_bank_payments i WHERE i.job_payment_id = jp.id)
                  OR EXISTS (SELECT 1 FROM incoming_bank_payment_splits s WHERE s.job_payment_id = jp.id) AS taken
           FROM job_payments jp WHERE jp.id = $1`,
        [l.link_payment_id],
      );
      const x = p.rows[0];
      if (!x || x.job_id !== jobByNumber.get(l.hh_job_number)) {
        return { ok: false, status: 400, error: `Line ${i + 1}: that payment isn't on job #${l.hh_job_number}` };
      }
      if (Math.abs(parseFloat(x.amount) - l.amount) > AMOUNT_TOLERANCE) {
        return { ok: false, status: 400, error: `Line ${i + 1}: that payment is £${parseFloat(x.amount).toFixed(2)}, not £${l.amount.toFixed(2)}` };
      }
      if (x.taken) return { ok: false, status: 400, error: `Line ${i + 1}: that payment is already linked to a Wise transfer` };
      linkRows.set(String(l.link_payment_id), { hirehop_deposit_id: x.hirehop_deposit_id ?? null });
    }

    // 4. Money already on the job? Asked of every line still set to plain 'record'.
    const conflicts: SplitLineConflict[] = [];
    const linkedIds = new Set(lines.filter(l => l.decision === 'link').map(l => String(l.link_payment_id)));
    for (const [i, l] of lines.entries()) {
      if (l.decision === 'link' || l.decision === 'record_anyway') continue;
      const existing = await findAlreadyRecordedPayment(jobByNumber.get(l.hh_job_number)!, l.amount, row.received_at);
      if (existing && !linkedIds.has(existing.id)) {
        conflicts.push({ index: i, hh_job_number: l.hh_job_number, message: describeExisting(existing), existing });
      }
    }
    if (conflicts.length) {
      return { ok: false, status: 409, error: 'Some of this money looks already recorded — link it or record it anyway', conflicts };
    }

    // 5. Write, one line at a time. Stop at the first failure.
    const outcomes: SplitLineOutcome[] = lines.map((l, index) => ({ index, hh_job_number: l.hh_job_number, amount: l.amount, status: 'not_started' }));
    const n = done.length + lines.length;
    for (const [i, l] of lines.entries()) {
      const jobId = jobByNumber.get(l.hh_job_number)!;
      if (l.decision === 'link') {
        await query(
          `INSERT INTO incoming_bank_payment_splits
             (incoming_id, job_id, hh_job_number, payment_type, amount, status, job_payment_id, hh_deposit_id, created_by)
           VALUES ($1, $2, $3, $4, $5, 'linked', $6, $7, $8)`,
          [incomingId, jobId, l.hh_job_number, l.payment_type, l.amount, l.link_payment_id,
           linkRows.get(String(l.link_payment_id))?.hirehop_deposit_id ?? null, actor.id],
        );
        outcomes[i].status = 'linked';
        continue;
      }

      const ins = await query(
        `INSERT INTO incoming_bank_payment_splits (incoming_id, job_id, hh_job_number, payment_type, amount, status, created_by)
         VALUES ($1, $2, $3, $4, $5, 'recording', $6) RETURNING id`,
        [incomingId, jobId, l.hh_job_number, l.payment_type, l.amount, actor.id],
      );
      const lineId: string = ins.rows[0].id;
      try {
        const result = await recordPayment(
          jobId,
          {
            payment_type: l.payment_type,
            amount: l.amount,
            payment_method: 'wise_bacs',
            payment_reference: `${wisePaymentReference(row)} (part ${done.length + i + 1} of ${n})`.slice(0, 255),
            notes: `Part of one Wise transfer of £${total.toFixed(2)} split across jobs from the incoming-payments queue`,
            push_to_hirehop: true,
          },
          { userId: actor.id, isServiceAccount: false },
        );
        if (result.status !== 200) {
          const msg = result.body?.error || `record-payment returned ${result.status}`;
          await query(`UPDATE incoming_bank_payment_splits SET status = 'failed', error = $2, updated_at = NOW() WHERE id = $1`, [lineId, msg]);
          outcomes[i] = { ...outcomes[i], status: 'failed', error: msg };
          break;
        }
        const payment = result.body?.data || {};
        const hhErr: string | null = result.body?.hh_push_error || null;
        await query(
          `UPDATE incoming_bank_payment_splits
              SET status = 'recorded', job_payment_id = $2, hh_deposit_id = $3, hh_push_error = $4, updated_at = NOW()
            WHERE id = $1`,
          [lineId, payment.id || null, payment.hirehop_deposit_id || null, hhErr],
        );
        outcomes[i] = { ...outcomes[i], status: 'recorded', hh_push_error: hhErr };
      } catch (err) {
        // We don't know whether the money landed — say so; the duplicate check catches it next time.
        const msg = `Recording stopped with an error (${err instanceof Error ? err.message : String(err)}) — check job #${l.hh_job_number}'s Money tab: if the payment is there, link to it`;
        await query(`UPDATE incoming_bank_payment_splits SET status = 'failed', error = $2, updated_at = NOW() WHERE id = $1`, [lineId, msg]);
        outcomes[i] = { ...outcomes[i], status: 'failed', error: msg };
        break;
      }
    }

    // 6. Finished? Only when what counts adds up to the transfer.
    const now = await countingLines(incomingId);
    const complete = now.every(d => d.status !== 'recording')
      && now.reduce((s, d) => s + pence(d.amount), 0) === pence(total);
    const summary = describeSplit(now);
    if (complete) {
      await query(
        `UPDATE incoming_bank_payments
            SET status = 'recorded', match_method = 'split', resolved_by = $2, resolved_at = NOW(),
                match_notes = $3
          WHERE id = $1 AND status = 'unmatched'`,
        [incomingId, actor.id, `Split across jobs by ${actor.label}: ${summary}`],
      );
    } else {
      await query(
        `UPDATE incoming_bank_payments SET match_notes = $2 WHERE id = $1`,
        [incomingId, `Split part-done by ${actor.label}: ${summary || 'nothing recorded yet'} — £${((pence(total) - now.reduce((s, d) => s + pence(d.amount), 0)) / 100).toFixed(2)} left`],
      );
    }
    if (outcomes.some(o => o.status === 'failed')) {
      return { ok: false, status: 400, error: 'A line could not be recorded — the lines before it are recorded; fix it and finish the split', lines: outcomes };
    }
    return { ok: true, complete, lines: outcomes };
  } finally {
    if (locked) await client.query(`SELECT pg_advisory_unlock(hashtext($1))`, [`incoming-split:${incomingId}`]).catch(() => undefined);
    client.release();
  }
}
