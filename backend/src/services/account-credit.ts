/**
 * Credit on account — a client's overpayment kept for their next hire
 * (docs/CREDIT-ON-ACCOUNT-SPEC.md). Every read and write of `account_credits` goes
 * through here.
 *
 * The money is REAL and never moves here: it stays unallocated on the hire payments
 * of the job it was paid on, in HireHop and Xero, until the close-out of a later job
 * applies it to that job's invoice. This is only OP's note that it is being held for
 * the client (rather than waiting to be refunded) and which job it is put aside for.
 *
 * NOT a voucher. A voucher (`goodwill-credits.ts`) is a promise that becomes a
 * discount, with VAT, a use-by date and a remainder that lapses. This is the client's
 * own cash: no VAT, no expiry, and what one job doesn't need stays on account.
 *
 * One live hold per source job, covering ALL of that job's unallocated hire money.
 * `amount` is what HireHop last said is unallocated there — the close-out plan
 * refreshes it on every live read (`holdForPlan()`), so it can never promise more
 * than the payments really have left. Three states are DERIVED on read, never stored:
 *   - spent: nothing is left on the source job's payments (applied or refunded) — stored
 *     only when the same job is held again later, to free its one live hold;
 *   - reserved: put aside for a job that is still alive;
 *   - a reservation on a job since lost / cancelled reads as held (free) again.
 */
import { query } from '../config/database';
import type { CloseOutPlan } from './hire-close-out';

export type AccountCreditStatus = 'held' | 'reserved' | 'spent' | 'released';

export interface AccountCredit {
  id: string;
  source_job_id: string;
  source_job_number: number | null;
  organisation_id: string;
  client_name: string;
  amount: number;
  amount_checked_at: string;
  note: string | null;
  held_by_name: string | null;
  held_at: string;
  status: AccountCreditStatus;      // the EFFECTIVE status
  reserved_job_id: string | null;   // null when the reservation has been freed
  reserved_job_number: number | null;
  reserved_at: string | null;
  released_at: string | null;
  released_reason: string | null;
}

/** What the close-out plan carries about its own job's hold. */
export interface PlanHold {
  id: string;
  amount: number;
  clientName: string;
  heldByName: string | null;
  heldAt: string;
  reservedJobId: string | null;
  reservedJobNumber: number | null;
}

export class AccountCreditError extends Error {
  constructor(message: string, public status = 400) { super(message); }
}

const PENNY = 0.005;
const gbp = (n: number) => `£${n.toFixed(2)}`;
const round2 = (n: number) => Math.round(n * 100) / 100;

/** `a` = account_credits, `rj` = the reserved job. */
const LIVE_RESERVATION_SQL = `(a.reserved_job_id IS NOT NULL AND rj.id IS NOT NULL AND rj.pipeline_status NOT IN ('lost', 'cancelled'))`;
export const ACCOUNT_CREDIT_STATUS_SQL = `CASE
  WHEN a.status = 'released' THEN 'released'
  WHEN a.status = 'spent' OR a.amount < 0.005 THEN 'spent'
  WHEN ${LIVE_RESERVATION_SQL} THEN 'reserved'
  ELSE 'held' END`;

const personName = (alias: string) =>
  `NULLIF(TRIM(CONCAT_WS(' ', COALESCE(NULLIF(${alias}.preferred_name, ''), ${alias}.first_name), ${alias}.last_name)), '')`;

const SELECT = `
  SELECT a.id, a.source_job_id, sj.hh_job_number AS source_job_number,
         a.organisation_id, COALESCE(o.name, '—') AS client_name,
         a.amount::float AS amount, a.amount_checked_at, a.note,
         ${personName('hp')} AS held_by_name, a.held_at,
         ${ACCOUNT_CREDIT_STATUS_SQL} AS status,
         CASE WHEN ${LIVE_RESERVATION_SQL} THEN a.reserved_job_id END AS reserved_job_id,
         CASE WHEN ${LIVE_RESERVATION_SQL} THEN rj.hh_job_number END AS reserved_job_number,
         CASE WHEN ${LIVE_RESERVATION_SQL} THEN a.reserved_at END AS reserved_at,
         a.released_at, a.released_reason
    FROM account_credits a
    JOIN jobs sj ON sj.id = a.source_job_id
    LEFT JOIN organisations o ON o.id = a.organisation_id
    LEFT JOIN jobs rj ON rj.id = a.reserved_job_id
    LEFT JOIN users hu ON hu.id = a.held_by
    LEFT JOIN people hp ON hp.id = hu.person_id`;

async function getRow(id: string): Promise<AccountCredit | null> {
  const r = await query(`${SELECT} WHERE a.id = $1`, [id]);
  return (r.rows[0] as AccountCredit) || null;
}

/** A line on a job's timeline. Never throws — a note never fails the action. */
async function note(jobIds: Array<string | null | undefined>, text: string, userId: string | null): Promise<void> {
  try {
    for (const jobId of Array.from(new Set(jobIds.filter((j): j is string => !!j)))) {
      await query(`INSERT INTO interactions (job_id, type, content, created_by, source) VALUES ($1, 'note', $2, $3, 'system')`,
        [jobId, text, userId]);
    }
  } catch (e) {
    console.warn('[account-credit] timeline note failed:', e);
  }
}

// ── Holding ──────────────────────────────────────────────────────────────

/**
 * Why this job's unallocated money can't be held on account — null when it can.
 * Only once the job's own invoices are raised and paid: before that every payment
 * looks "spare" to the plan, and it is not.
 */
export function holdBlockReason(plan: Pick<CloseOutPlan,
  'cancellation' | 'blockers' | 'invoice' | 'invoices' | 'allocations' | 'surplus' | 'onAccount'>): string | null {
  if (plan.onAccount) return 'This job\'s spare money is already held on account.';
  if (plan.cancellation) return 'A cancelled job\'s spare money is a refund — use Process on the pending refund.';
  if (plan.blockers.length) return plan.blockers[0];
  if (plan.invoice.netToInvoice >= PENNY || plan.invoice.draft) return 'Raise this job\'s invoice first — until then OP can\'t tell what is spare.';
  if (plan.invoices.length === 0) return 'This job has no invoice yet — until it does OP can\'t tell what is spare.';
  if (plan.allocations.length > 0 || plan.invoices.some((i) => i.owing >= PENNY)) {
    return 'This job\'s own invoice is still owing — allocate the payments to it first.';
  }
  if (surplusTotal(plan.surplus) < PENNY) return 'Nothing is unallocated on this job\'s payments.';
  return null;
}

export const surplusTotal = (surplus: Array<{ amount: number }>) => round2(surplus.reduce((s, x) => s + x.amount, 0));

/**
 * "Hold on account" — any staff. `plan` must be a LIVE read of the job (the route
 * forces one), so the amount is HireHop's, not the page's.
 */
export async function holdOnAccount(plan: CloseOutPlan, userId: string | null, noteText?: string | null): Promise<AccountCredit> {
  const reason = holdBlockReason(plan);
  if (reason) throw new AccountCreditError(reason);
  const amount = surplusTotal(plan.surplus);
  const job = (await query(`SELECT client_id FROM jobs WHERE id = $1`, [plan.jobId])).rows[0];
  if (!job?.client_id) {
    throw new AccountCreditError('This job has no client organisation, so the money couldn\'t be found again on their next job. Add the client first.');
  }
  // An earlier hold on this job whose money has all gone is finished — put it away so a
  // new overpayment on the same job can be held (one live hold per job).
  await query(`UPDATE account_credits SET status = 'spent', updated_at = NOW() WHERE source_job_id = $1 AND status = 'held' AND amount < 0.005`, [plan.jobId]);
  let id: string;
  try {
    const r = await query(
      `INSERT INTO account_credits (source_job_id, organisation_id, amount, note, held_by)
       VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [plan.jobId, job.client_id, amount, noteText?.trim() || null, userId],
    );
    id = r.rows[0].id;
  } catch (e) {
    if ((e as { code?: string })?.code === '23505') throw new AccountCreditError('This job\'s spare money is already held on account.', 409);
    throw e;
  }
  const credit = (await getRow(id))!;
  await note([plan.jobId], `On account: ${gbp(amount)} overpaid on this job is being held for ${credit.client_name} to use on another hire`
    + `${noteText?.trim() ? ` — ${noteText.trim()}` : ''}. It stays on this job's payments in HireHop until then.`, userId);
  return credit;
}

/**
 * The plan's view of its own job's hold. `liveSurplus` is the unallocated total from a
 * LIVE HireHop read with nothing blocking it — the stored amount follows it; pass null
 * when the plan didn't read HireHop (a Completed job's record) or couldn't trust it.
 * Never throws: the close-out plan must not fail over OP's own note.
 */
export async function holdForPlan(jobId: string, liveSurplus: number | null): Promise<PlanHold | null> {
  try {
    if (liveSurplus != null) {
      await query(
        `UPDATE account_credits SET amount = $2, amount_checked_at = NOW(), updated_at = NOW()
          WHERE source_job_id = $1 AND status = 'held' AND amount <> $2`,
        [jobId, round2(liveSurplus)],
      );
    }
    const r = await query(`SELECT * FROM (${SELECT} WHERE a.source_job_id = $1 AND a.status = 'held') x WHERE x.status <> 'spent'`, [jobId]);
    const c = r.rows[0] as AccountCredit | undefined;
    if (!c) return null;
    return {
      id: c.id, amount: c.amount, clientName: c.client_name, heldByName: c.held_by_name, heldAt: c.held_at,
      reservedJobId: c.reserved_job_id, reservedJobNumber: c.reserved_job_number,
    };
  } catch (e) {
    console.warn('[account-credit] could not read the hold for the plan:', e);
    return null;
  }
}

/** "Stop holding" — a manager. The money is back to "to sort" on its own job. */
export async function releaseHold(id: string, userId: string | null, reason: string): Promise<AccountCredit> {
  const before = await getRow(id);
  if (!before) throw new AccountCreditError('Not found', 404);
  if (before.status === 'released') throw new AccountCreditError('It is no longer held on account.');
  if (!reason.trim()) throw new AccountCreditError('Say why it is no longer being held.');
  await query(
    `UPDATE account_credits SET status = 'released', released_by = $2, released_at = NOW(), released_reason = $3,
            reserved_job_id = NULL, reserved_by = NULL, reserved_at = NULL, updated_at = NOW()
      WHERE id = $1 AND status = 'held'`,
    [id, userId, reason.trim()],
  );
  await note([before.source_job_id, before.reserved_job_id],
    `On account: the ${gbp(before.amount)} from job ${before.source_job_number ?? ''} is no longer held for ${before.client_name} — ${reason.trim()}.`, userId);
  return (await getRow(id))!;
}

// ── Using it on a later job ──────────────────────────────────────────────

/** "Use on this job" — any staff. Same client only; nothing moves until that job is invoiced. */
export async function reserveOnJob(id: string, jobId: string, userId: string | null): Promise<AccountCredit> {
  const before = await getRow(id);
  if (!before) throw new AccountCreditError('Not found', 404);
  if (before.status === 'released' || before.status === 'spent') throw new AccountCreditError('That money is no longer on account.');
  if (before.status === 'reserved') {
    throw new AccountCreditError(before.reserved_job_id === jobId
      ? 'It is already put aside for this job.'
      : `It is already put aside for job ${before.reserved_job_number ?? ''} — a manager can take it off that job first.`, 409);
  }
  const job = (await query(
    `SELECT id, hh_job_number, client_id, pipeline_status, is_internal FROM jobs WHERE id = $1`, [jobId])).rows[0];
  if (!job) throw new AccountCreditError('Job not found', 404);
  if (job.id === before.source_job_id) throw new AccountCreditError('That is the job the money is already on.');
  if (job.is_internal) throw new AccountCreditError('An internal job has no client to pay for it.');
  if (['lost', 'cancelled', 'completed'].includes(job.pipeline_status)) {
    throw new AccountCreditError('This job is closed — the money can only be put aside for a live job.');
  }
  if (!job.client_id || String(job.client_id) !== String(before.organisation_id)) {
    throw new AccountCreditError(`This money belongs to ${before.client_name}, and this job has a different client.`);
  }
  // Guarded, so two people on two jobs can't both take it.
  const r = await query(
    `UPDATE account_credits a SET reserved_job_id = $2, reserved_by = $3, reserved_at = NOW(), updated_at = NOW()
      WHERE a.id = $1 AND a.status = 'held' AND a.amount >= 0.005
        AND (a.reserved_job_id IS NULL
             OR NOT EXISTS (SELECT 1 FROM jobs rj WHERE rj.id = a.reserved_job_id AND rj.pipeline_status NOT IN ('lost', 'cancelled')))`,
    [id, jobId, userId],
  );
  if (!r.rowCount) throw new AccountCreditError('Someone has just put it aside for another job.', 409);
  const credit = (await getRow(id))!;
  await note([jobId, before.source_job_id],
    `On account: ${gbp(credit.amount)} held from job ${credit.source_job_number ?? ''} is put aside for job ${job.hh_job_number ?? ''}. `
    + 'It comes off the invoice when that job is invoiced; nothing has moved in HireHop yet.', userId);
  return credit;
}

/** "Take off this job" — a manager. It goes back to being free for the client's other jobs. */
export async function unreserve(id: string, userId: string | null): Promise<AccountCredit> {
  const before = await getRow(id);
  if (!before) throw new AccountCreditError('Not found', 404);
  if (before.status !== 'reserved') throw new AccountCreditError('It isn\'t put aside for a job.');
  await query(
    `UPDATE account_credits SET reserved_job_id = NULL, reserved_by = NULL, reserved_at = NULL, updated_at = NOW()
      WHERE id = $1 AND status = 'held'`,
    [id],
  );
  await note([before.reserved_job_id, before.source_job_id],
    `On account: the ${gbp(before.amount)} held from job ${before.source_job_number ?? ''} is no longer put aside for job ${before.reserved_job_number ?? ''} — it is free to use again.`, userId);
  return (await getRow(id))!;
}

// ── Reads ────────────────────────────────────────────────────────────────

/**
 * The Client History note on an enquiry / job: what this client has on account that is
 * free to use, plus anything put aside for THIS job. Never the job's own hold — the
 * close-out panel shows that.
 */
export async function listForContext(ctx: { organisationId?: string | null; jobId?: string | null }): Promise<AccountCredit[]> {
  if (!ctx.organisationId && !ctx.jobId) return [];
  const r = await query(
    `SELECT * FROM (${SELECT}
       WHERE a.status = 'held'
         AND (a.organisation_id = $1::uuid OR a.reserved_job_id = $2::uuid)
         AND ($2::uuid IS NULL OR a.source_job_id <> $2::uuid)) x
      WHERE (x.status = 'held' AND x.organisation_id = $1::uuid)
         OR (x.status = 'reserved' AND x.reserved_job_id = $2::uuid)
      ORDER BY x.held_at`,
    [ctx.organisationId || null, ctx.jobId || null],
  );
  return r.rows;
}

/** Everything ever held for a client, newest first (their page). */
export async function listForOrganisation(organisationId: string): Promise<AccountCredit[]> {
  return (await query(`${SELECT} WHERE a.organisation_id = $1 ORDER BY a.held_at DESC`, [organisationId])).rows;
}

export async function getAccountCredit(id: string): Promise<AccountCredit | null> {
  return getRow(id);
}
