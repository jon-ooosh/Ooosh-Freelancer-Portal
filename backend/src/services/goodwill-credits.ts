/**
 * Goodwill credit — "£X + VAT off your next hire (or what you owe), use by …".
 * docs/GOODWILL-CREDIT-SPEC.md. Every read and write of `goodwill_credits` goes
 * through here.
 *
 * A PROMISE, not money: nothing here touches HireHop or Xero. Staff apply it by
 * hand in HireHop with the GW code in the line's note / credit note's description.
 *
 * Held by an organisation OR a person (DB CHECK). Two states are DERIVED on read,
 * never stored (`EFFECTIVE_STATUS_SQL`):
 *   - expired: offered and past its use-by date (UK date);
 *   - a credit reserved for a HIRE whose job has since gone lost / cancelled reads
 *     as offered again. One reserved against an INVOICE stays reserved — a
 *     cancelled job still owes its fee invoice.
 * So there is no sweep and no hook on the four job-closing paths.
 */
import { query } from '../config/database';
import { ukDatePlus } from './uk-date';
import { logIssueEvent } from './job-issues';
import { makeVoucherCode, exVatOf } from './voucher-rules';

export type GoodwillStatus = 'offered' | 'reserved' | 'used' | 'withdrawn' | 'expired';
export type GoodwillSourceKind = 'close_out' | 'problem' | 'cancellation' | 'organisation' | 'person' | 'referral' | 'voucher';

export interface GoodwillCredit {
  id: string;
  ref: string;
  organisation_id: string | null;
  person_id: string | null;
  owner_name: string;
  amount_ex_vat: number;
  reason: string;
  source_kind: GoodwillSourceKind;
  source_job_id: string | null;
  source_job_number: number | null;
  source_issue_id: string | null;
  offered_by_name: string | null;
  offered_at: string;
  expires_on: string;            // YYYY-MM-DD
  status: GoodwillStatus;        // the EFFECTIVE status
  reserved_job_id: string | null;
  reserved_job_number: number | null;
  reserved_for: 'hire' | 'invoice' | null;
  reserved_invoice_number: string | null;
  reserved_amount_ex_vat: number | null;
  reserved_at: string | null;
  used_amount_ex_vat: number | null;
  used_at: string | null;
  used_how: string | null;
  withdrawn_at: string | null;
  withdrawn_reason: string | null;
  /** What the HireHop read-back last found wrong (spec §6.2); null = nothing. */
  check_problem: string | null;
  last_checked_at: string | null;
  used_hh_ref: string | null;
  /** A voucher (spec §16): the code the client is given, and its face value INC VAT. Null on plain goodwill. */
  voucher_code: string | null;
  voucher_value_inc_vat: number | null;
  /** Used at the shop till: that sale. */
  used_shop_sale_id: string | null;
}

export class GoodwillError extends Error {
  constructor(message: string, public status = 400) { super(message); }
}

const UK_TODAY_SQL = `(NOW() AT TIME ZONE 'Europe/London')::date`;

/** The status a person sees. `g` = goodwill_credits, `rj` = the reserved job. */
export const EFFECTIVE_STATUS_SQL = `CASE
  WHEN g.status = 'reserved' AND g.reserved_for = 'hire' AND rj.pipeline_status IN ('lost', 'cancelled')
    THEN CASE WHEN g.expires_on < ${UK_TODAY_SQL} THEN 'expired' ELSE 'offered' END
  WHEN g.status = 'offered' AND g.expires_on < ${UK_TODAY_SQL} THEN 'expired'
  ELSE g.status END`;

/** "Still free to reserve", for a guarded UPDATE on `goodwill_credits g` — the same answer as
 *  EFFECTIVE_STATUS_SQL = 'offered', written so two people reserving at once can't both win. */
export const FREE_TO_RESERVE_SQL = `g.expires_on >= ${UK_TODAY_SQL}
        AND (g.status = 'offered'
             OR (g.status = 'reserved' AND g.reserved_for = 'hire'
                 AND EXISTS (SELECT 1 FROM jobs rj WHERE rj.id = g.reserved_job_id AND rj.pipeline_status IN ('lost', 'cancelled'))))`;

const SELECT = `
  SELECT g.id, g.ref, g.organisation_id, g.person_id,
         CASE WHEN g.organisation_id IS NULL AND g.person_id IS NULL THEN 'Anyone with the code'
              ELSE COALESCE(o.name, NULLIF(TRIM(CONCAT_WS(' ', COALESCE(NULLIF(p.preferred_name, ''), p.first_name), p.last_name)), ''), '—') END AS owner_name,
         g.amount_ex_vat::float AS amount_ex_vat, g.reason, g.source_kind,
         g.source_job_id, sj.hh_job_number AS source_job_number, g.source_issue_id,
         NULLIF(TRIM(CONCAT_WS(' ', COALESCE(NULLIF(op.preferred_name, ''), op.first_name), op.last_name)), '') AS offered_by_name,
         g.offered_at, to_char(g.expires_on, 'YYYY-MM-DD') AS expires_on,
         ${EFFECTIVE_STATUS_SQL} AS status,
         g.reserved_job_id, rj.hh_job_number AS reserved_job_number,
         g.reserved_for, g.reserved_invoice_number,
         g.reserved_amount_ex_vat::float AS reserved_amount_ex_vat, g.reserved_at,
         g.used_amount_ex_vat::float AS used_amount_ex_vat, g.used_at, g.used_how,
         g.withdrawn_at, g.withdrawn_reason, g.check_problem, g.last_checked_at, g.used_hh_ref,
         g.voucher_code, g.voucher_value_inc_vat::float AS voucher_value_inc_vat, g.used_shop_sale_id
    FROM goodwill_credits g
    LEFT JOIN organisations o ON o.id = g.organisation_id
    LEFT JOIN people p ON p.id = g.person_id
    LEFT JOIN jobs sj ON sj.id = g.source_job_id
    LEFT JOIN jobs rj ON rj.id = g.reserved_job_id
    LEFT JOIN users ou ON ou.id = g.offered_by
    LEFT JOIN people op ON op.id = ou.person_id`;

const money = (n: number) => `£${n.toFixed(2)}`;
const plusVat = (n: number) => `${money(n)}+VAT (${money(Math.round(n * 120) / 100)})`;
/** How a credit's value reads on a timeline: a voucher by its face value (inc VAT). */
export function creditValueText(g: { amount_ex_vat: number; voucher_value_inc_vat: number | null }): string {
  return g.voucher_value_inc_vat != null ? `${money(g.voucher_value_inc_vat)} voucher (inc VAT)` : plusVat(g.amount_ex_vat);
}
/** 1 → '1st', 2 → '2nd', 11 → '11th', 22 → '22nd'. */
function ordinal(n: number): string {
  const teen = n % 100 >= 11 && n % 100 <= 13;
  const suffix = teen ? 'th' : ({ 1: 'st', 2: 'nd', 3: 'rd' } as Record<number, string>)[n % 10] || 'th';
  return `${n}${suffix}`;
}
/** '2027-11-16' → '16th Nov 2027' (a DATE string, read as a calendar day — never shifted by a time zone). */
export const day = (ymd: string) => {
  const d = new Date(`${ymd}T12:00:00Z`);
  if (Number.isNaN(d.getTime())) return ymd;
  const month = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][d.getUTCMonth()];
  return `${ordinal(d.getUTCDate())} ${month} ${d.getUTCFullYear()}`;
};

async function getRow(id: string): Promise<GoodwillCredit | null> {
  const r = await query(`${SELECT} WHERE g.id = $1`, [id]);
  return (r.rows[0] as GoodwillCredit) || null;
}

export async function getGoodwillCredit(id: string): Promise<GoodwillCredit | null> {
  return getRow(id);
}

/** By its printed code (GW-0012), any case. */
export async function getGoodwillByRef(ref: string): Promise<GoodwillCredit | null> {
  const r = await query(`${SELECT} WHERE g.ref = $1`, [ref.toUpperCase()]);
  return (r.rows[0] as GoodwillCredit) || null;
}

/** A voucher by its code (already normalised — voucher-rules.ts `normaliseVoucherCode()`). */
export async function getGoodwillByVoucherCode(code: string): Promise<GoodwillCredit | null> {
  const r = await query(`${SELECT} WHERE g.voucher_code = $1`, [code]);
  return (r.rows[0] as GoodwillCredit) || null;
}

/** Every voucher, newest first (Money › Vouchers). */
export async function listVoucherCredits(limit = 300): Promise<GoodwillCredit[]> {
  return (await query(`${SELECT} WHERE g.voucher_code IS NOT NULL ORDER BY g.offered_at DESC LIMIT $1`, [limit])).rows;
}

/** Reserved or used on this job — the job's goodwill chip and the close-out ledger line. */
export async function listOnJob(jobId: string): Promise<GoodwillCredit[]> {
  const r = await query(
    `SELECT * FROM (${SELECT} WHERE g.reserved_job_id = $1) x
      WHERE x.status IN ('reserved', 'used')
      ORDER BY x.reserved_at`,
    [jobId],
  );
  return r.rows;
}

/** Every credit an org or person holds, newest first (the Goodwill tab). */
export async function listForOwner(owner: { organisationId?: string; personId?: string }): Promise<GoodwillCredit[]> {
  if (owner.organisationId) {
    return (await query(`${SELECT} WHERE g.organisation_id = $1 ORDER BY g.offered_at DESC`, [owner.organisationId])).rows;
  }
  if (owner.personId) {
    return (await query(`${SELECT} WHERE g.person_id = $1 ORDER BY g.offered_at DESC`, [owner.personId])).rows;
  }
  return [];
}

/**
 * What applies to an enquiry / job (the Client History note): credits still to
 * use held by any of these orgs or people — or by a person who is a current
 * member of one of these orgs — plus anything reserved on THIS job.
 */
export async function listForContext(ctx: { orgIds: string[]; personIds: string[]; jobId?: string | null }): Promise<GoodwillCredit[]> {
  const orgIds = Array.from(new Set(ctx.orgIds.filter(Boolean)));
  const personIds = Array.from(new Set(ctx.personIds.filter(Boolean)));
  if (orgIds.length === 0 && personIds.length === 0 && !ctx.jobId) return [];
  const r = await query(
    `SELECT * FROM (${SELECT}
       WHERE g.organisation_id = ANY($1::uuid[])
          OR g.person_id = ANY($2::uuid[])
          OR g.person_id IN (SELECT por.person_id FROM person_organisation_roles por
                              WHERE por.organisation_id = ANY($1::uuid[]) AND por.status = 'active')
          OR ($3::uuid IS NOT NULL AND g.reserved_job_id = $3::uuid)
     ) x
     WHERE x.status = 'offered' OR (x.status = 'reserved' AND x.reserved_job_id = $3::uuid)
     ORDER BY x.offered_at`,
    [orgIds, personIds, ctx.jobId || null],
  );
  return r.rows;
}

/** Who a credit offered from this job could be for: band, client org, the job's contacts. */
export async function ownerChoicesForJob(jobId: string): Promise<Array<{ kind: 'organisation' | 'person'; id: string; name: string; role: string }>> {
  const r = await query(
    `SELECT 'organisation' AS kind, o.id, o.name, 'Band' AS role, 0 AS ord
       FROM job_organisations jo JOIN organisations o ON o.id = jo.organisation_id
      WHERE jo.job_id = $1 AND jo.role = 'band' AND COALESCE(o.is_deleted, false) = false
     UNION ALL
     SELECT 'organisation', o.id, o.name, 'Client', 1
       FROM jobs j JOIN organisations o ON o.id = j.client_id
      WHERE j.id = $1 AND COALESCE(o.is_deleted, false) = false
     UNION ALL
     SELECT 'person', p.id,
            TRIM(CONCAT_WS(' ', COALESCE(NULLIF(p.preferred_name, ''), p.first_name), p.last_name)),
            CASE WHEN jc.is_primary THEN 'Main contact' ELSE 'Contact' END,
            CASE WHEN jc.is_primary THEN 2 ELSE 3 END
       FROM job_contacts jc JOIN people p ON p.id = jc.person_id
      WHERE jc.job_id = $1 AND COALESCE(p.is_deleted, false) = false
     ORDER BY 5, 3`,
    [jobId],
  );
  // The same org can be band AND client — keep its first (band) row.
  const seen = new Set<string>();
  return r.rows.filter((row) => (seen.has(row.id) ? false : (seen.add(row.id), true)))
    .map(({ kind, id, name, role }) => ({ kind, id, name, role }));
}

/** A line on the timelines this credit touches. Never throws — a note never fails the action. */
export async function noteGoodwill(g: GoodwillCredit, text: string, userId: string, jobIds: Array<string | null>) {
  try {
    const jobs = Array.from(new Set(jobIds.filter((j): j is string => !!j)));
    for (const jobId of jobs) {
      await query(`INSERT INTO interactions (job_id, type, content, created_by, source) VALUES ($1, 'note', $2, $3, 'system')`,
        [jobId, text, userId]);
    }
    // A voucher held by nobody ("anyone with the code") has no owner timeline.
    if (g.organisation_id || g.person_id) {
      await query(
        `INSERT INTO interactions (organisation_id, person_id, type, content, created_by, source) VALUES ($1, $2, 'note', $3, $4, 'system')`,
        [g.organisation_id, g.person_id, text, userId],
      );
    }
    if (g.source_issue_id) await logIssueEvent(g.source_issue_id, userId, 'money', text);
  } catch (e) {
    console.warn('[goodwill] timeline note failed:', e);
  }
}

export interface OfferInput {
  organisation_id?: string | null;
  person_id?: string | null;
  amount_ex_vat: number;
  reason: string;
  source_kind: GoodwillSourceKind;
  source_job_id?: string | null;
  source_issue_id?: string | null;
  expires_on?: string | null;
  /**
   * Make it a VOUCHER (spec §16): a random code, this face value INC VAT (amount_ex_vat is
   * then worked out from it and ignored if sent). A voucher may be held by nobody.
   */
  voucher_value_inc_vat?: number | null;
}

export async function offerGoodwill(input: OfferInput, userId: string): Promise<GoodwillCredit> {
  const voucher = input.voucher_value_inc_vat != null;
  if (voucher && !(input.voucher_value_inc_vat! > 0)) throw new GoodwillError('A voucher needs a value');
  if (input.organisation_id && input.person_id) throw new GoodwillError('A credit is for an organisation OR a person — pick one');
  if (!voucher && !input.organisation_id && !input.person_id) throw new GoodwillError('A credit is for an organisation OR a person — pick one');
  const amountExVat = voucher ? exVatOf(input.voucher_value_inc_vat!) : input.amount_ex_vat;
  let id: string | null = null;
  // A fresh code each try — two the same is vanishingly unlikely, but the column is UNIQUE.
  for (let attempt = 0; attempt < 5 && !id; attempt++) {
    try {
      const r = await query(
        `INSERT INTO goodwill_credits
           (organisation_id, person_id, amount_ex_vat, reason, source_kind, source_job_id, source_issue_id, offered_by, expires_on,
            voucher_code, voucher_value_inc_vat)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
         RETURNING id`,
        [input.organisation_id || null, input.person_id || null, amountExVat, input.reason.trim(),
          input.source_kind, input.source_job_id || null, input.source_issue_id || null, userId,
          input.expires_on || ukDatePlus(365),
          voucher ? makeVoucherCode() : null, voucher ? input.voucher_value_inc_vat : null],
      );
      id = r.rows[0].id;
    } catch (err) {
      if (!(voucher && (err as { code?: string })?.code === '23505' && String((err as { constraint?: string }).constraint || '').includes('voucher_code'))) throw err;
    }
  }
  if (!id) throw new GoodwillError('Could not make a voucher code — please try again', 500);
  const g = (await getRow(id))!;
  await noteGoodwill(g, voucher
    ? `🎟️ Voucher ${g.ref} made${g.organisation_id || g.person_id ? ` for ${g.owner_name}` : ''}: ${creditValueText(g)}, single use, use by ${day(g.expires_on)}. Why: ${g.reason}`
    : `🎁 Goodwill credit ${g.ref} offered to ${g.owner_name}: ${plusVat(g.amount_ex_vat)} off a future hire or money owed, use by ${day(g.expires_on)}. Why: ${g.reason}`,
  userId, [g.source_job_id]);
  return g;
}

/** A manager's edit — amount, reason, use-by. Not once it's used or withdrawn. */
export async function editGoodwill(id: string, patch: { amount_ex_vat?: number; reason?: string; expires_on?: string }, userId: string): Promise<GoodwillCredit> {
  const before = await getRow(id);
  if (!before) throw new GoodwillError('Goodwill credit not found', 404);
  if (before.status === 'used' || before.status === 'withdrawn') throw new GoodwillError(`This credit is ${before.status} — it can't be changed`);
  if (before.voucher_code && patch.amount_ex_vat !== undefined && Math.abs(patch.amount_ex_vat - before.amount_ex_vat) > 0.004) {
    throw new GoodwillError("A voucher's value is what the client was told — withdraw it and make a new one");
  }
  const sets: string[] = [];
  const vals: unknown[] = [];
  if (patch.amount_ex_vat !== undefined) { vals.push(patch.amount_ex_vat); sets.push(`amount_ex_vat = $${vals.length}`); }
  if (patch.reason !== undefined) { vals.push(patch.reason.trim()); sets.push(`reason = $${vals.length}`); }
  if (patch.expires_on !== undefined) { vals.push(patch.expires_on); sets.push(`expires_on = $${vals.length}`); }
  if (sets.length === 0) return before;
  vals.push(id);
  await query(`UPDATE goodwill_credits SET ${sets.join(', ')}, updated_at = NOW() WHERE id = $${vals.length}`, vals);
  const g = (await getRow(id))!;
  const changes = [
    patch.amount_ex_vat !== undefined && g.amount_ex_vat !== before.amount_ex_vat ? `amount ${money(before.amount_ex_vat)} → ${money(g.amount_ex_vat)}+VAT` : '',
    patch.expires_on !== undefined && g.expires_on !== before.expires_on ? `use by ${day(before.expires_on)} → ${day(g.expires_on)}` : '',
  ].filter(Boolean).join(', ');
  if (changes) await noteGoodwill(g, `🎁 Goodwill credit ${g.ref} changed: ${changes}`, userId, []);
  return g;
}

export interface ReserveInput {
  job_id: string;
  reserved_for: 'hire' | 'invoice';
  amount_ex_vat: number;
  invoice_number?: string | null;
}

/** "Use on this job" — any staff. Holds it for one job so nobody uses it twice. */
export async function reserveGoodwill(id: string, input: ReserveInput, userId: string): Promise<GoodwillCredit> {
  const before = await getRow(id);
  if (!before) throw new GoodwillError('Goodwill credit not found', 404);
  if (before.status !== 'offered') {
    throw new GoodwillError(before.status === 'reserved'
      ? `It's already reserved on job ${before.reserved_job_number ?? ''}`.trim()
      : `This credit is ${before.status}`);
  }
  if (input.amount_ex_vat > before.amount_ex_vat + 0.004) throw new GoodwillError(`It's only worth ${money(before.amount_ex_vat)}+VAT`);
  const job = await query(`SELECT id FROM jobs WHERE id = $1 AND is_deleted = false`, [input.job_id]);
  if (job.rows.length === 0) throw new GoodwillError('Job not found', 404);
  // "Still free to use" is repeated in the WHERE, so two people reserving at once can't both win.
  const r = await query(
    `UPDATE goodwill_credits g
        SET status = 'reserved', reserved_job_id = $2, reserved_for = $3, reserved_invoice_number = $4,
            reserved_amount_ex_vat = $5, reserved_by = $6, reserved_at = NOW(), check_problem = NULL, updated_at = NOW()
      WHERE g.id = $1 AND ${FREE_TO_RESERVE_SQL}
      RETURNING g.id`,
    [id, input.job_id, input.reserved_for, input.reserved_for === 'invoice' ? (input.invoice_number || null) : null,
      input.amount_ex_vat, userId],
  );
  if (r.rows.length === 0) throw new GoodwillError('Someone else has just used or reserved it — reload and check', 409);
  const g = (await getRow(id))!;
  const where = g.reserved_for === 'invoice'
    ? `against ${g.reserved_invoice_number || 'an invoice'} (a credit note in HireHop with ${g.ref} in its description)`
    : `off the hire (a discount in HireHop with "Goodwill credit ${g.ref}" in the line's note)`;
  await noteGoodwill(g, `🎁 Goodwill credit ${g.ref} reserved on this job: ${money(input.amount_ex_vat)}+VAT ${where}.`, userId, [g.reserved_job_id]);
  return g;
}

/** Take a reservation off a job — a manager. Back to offered; the use-by date doesn't move. */
export async function unreserveGoodwill(id: string, userId: string): Promise<GoodwillCredit> {
  const before = await getRow(id);
  if (!before) throw new GoodwillError('Goodwill credit not found', 404);
  if (before.status !== 'reserved') throw new GoodwillError('It isn\'t reserved on a job');
  await query(
    `UPDATE goodwill_credits SET status = 'offered', reserved_job_id = NULL, reserved_for = NULL,
            reserved_invoice_number = NULL, reserved_amount_ex_vat = NULL, reserved_by = NULL, reserved_at = NULL,
            check_problem = NULL, updated_at = NOW()
      WHERE id = $1 AND status = 'reserved'`,
    [id],
  );
  const g = (await getRow(id))!;
  await noteGoodwill(g, `🎁 Goodwill credit ${g.ref} taken off job ${before.reserved_job_number ?? ''} — it's free to use again.`, userId, [before.reserved_job_id]);
  return g;
}

/** "Mark as applied" — any staff, once it's in HireHop. Used; whatever it didn't take lapses. */
export async function markGoodwillApplied(id: string, amountExVat: number | null, userId: string): Promise<GoodwillCredit> {
  const before = await getRow(id);
  if (!before) throw new GoodwillError('Goodwill credit not found', 404);
  if (before.status !== 'reserved') throw new GoodwillError('Reserve it on a job first');
  const amount = amountExVat ?? before.reserved_amount_ex_vat ?? before.amount_ex_vat;
  if (amount <= 0 || amount > before.amount_ex_vat + 0.004) throw new GoodwillError(`Between £0.01 and ${money(before.amount_ex_vat)}`);
  await query(
    `UPDATE goodwill_credits SET status = 'used', used_amount_ex_vat = $2, used_at = NOW(), used_by = $3,
            used_how = 'manual', check_problem = NULL, updated_at = NOW()
      WHERE id = $1 AND status = 'reserved'`,
    [id, amount, userId],
  );
  const g = (await getRow(id))!;
  const lapsed = before.amount_ex_vat - amount;
  await noteGoodwill(g, `🎁 Goodwill credit ${g.ref} applied on this job: ${money(amount)}+VAT off.${lapsed > 0.004 ? ` The other ${money(lapsed)}+VAT lapses.` : ''}`,
    userId, [g.reserved_job_id]);
  return g;
}

/** Withdraw — a manager, with a reason. Never deleted. */
export async function withdrawGoodwill(id: string, reason: string, userId: string): Promise<GoodwillCredit> {
  const before = await getRow(id);
  if (!before) throw new GoodwillError('Goodwill credit not found', 404);
  if (before.status === 'used' || before.status === 'withdrawn') throw new GoodwillError(`It's already ${before.status}`);
  await query(
    `UPDATE goodwill_credits SET status = 'withdrawn', withdrawn_by = $2, withdrawn_at = NOW(), withdrawn_reason = $3,
            updated_at = NOW()
      WHERE id = $1 AND status IN ('offered', 'reserved')`,
    [id, userId, reason.trim()],
  );
  const g = (await getRow(id))!;
  await noteGoodwill(g, `🎁 Goodwill credit ${g.ref} withdrawn. Why: ${reason.trim()}`, userId, [before.reserved_job_id]);
  return g;
}
