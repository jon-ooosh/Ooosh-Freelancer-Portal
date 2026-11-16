/**
 * Goodwill read-back — docs/GOODWILL-CREDIT-SPEC.md §6, phase 2.
 *
 * OP never WRITES a goodwill credit to HireHop; staff apply it by hand with the
 * credit's code (GW-0012) in a line's Item Note / Item Memo or a credit note's
 * description. This READS HireHop to see that it happened:
 *
 *   A. every RESERVED credit: read its job's supply list and billing; the code on a
 *      line, or on an APPROVED credit note, marks it used. Nothing after 24h, a
 *      draft credit note, a line with the code but no discount, or a credit note
 *      bigger than the credit → `check_problem` (a warning, never a gate).
 *   B. the stored supply lines of every live job (jobs.line_items, refreshed by the
 *      HireHop sync, which keeps Item Note / Item Memo since phase 2): a code on a
 *      job it ISN'T reserved on is linked to that job if it's free, else flagged.
 *
 * Proven against HireHop by `scripts/goodwill-readback-probe.ts` (spec §13.3):
 * Item Note = `ADDITIONAL`, Item Memo = `TECHNICAL`, a draft credit note reads
 * status 0 / credit 0 and the approved one status 2 / its value.
 *
 * The amount used is the staff member's word (reserved_amount_ex_vat): a line's
 * money also involves MULTIPLIER and PRICE_TYPE, so OP doesn't re-derive it.
 */
import { query } from '../config/database';
import { hhBroker } from './hirehop-broker';
import {
  type GoodwillCredit, getGoodwillCredit, getGoodwillByRef, noteGoodwill, EFFECTIVE_STATUS_SQL, FREE_TO_RESERVE_SQL,
} from './goodwill-credits';

const SYSTEM_USER_ID = '00000000-0000-0000-0000-000000000000';
const WAIT_BEFORE_FLAG_MS = 24 * 60 * 60 * 1000;

// ── Pure: reading HireHop's answers and deciding ─────────────────────────────

/** Every GW code in a piece of text, upper-cased, once each. */
export function codesIn(text: string): string[] {
  return Array.from(new Set((text.match(/\bGW-\d{4,}\b/gi) || []).map((c) => c.toUpperCase())));
}

export interface SupplyLine { id: number; text: string; unitPrice: number; price: number }
export interface CreditNoteRow { number: string; description: string; approved: boolean; gross: number }

const num = (v: unknown) => { const n = parseFloat(String(v ?? '')); return Number.isFinite(n) ? n : 0; };

/** items_to_supply_list.php → lines with ALL their text joined (title, Item Note, Item Memo…). */
export function parseSupplyList(data: unknown): SupplyLine[] {
  const d = data as any;
  const rows: any[] = Array.isArray(d) ? d : (d?.items || d?.rows || []);
  return rows.filter((r) => r && typeof r === 'object').map((r) => ({
    id: Number(r.ID ?? r.ITEM_ID ?? 0),
    text: Object.values(r).filter((v) => typeof v === 'string').join(' \u0001 '),
    unitPrice: num(r.UNIT_PRICE),
    price: num(r.PRICE),
  }));
}

/** billing_list.php → its credit notes (kind 2). A draft is status 0 (routes/money.ts, job 16668). */
export function parseBilling(data: unknown): CreditNoteRow[] {
  const rows: any[] = (data as any)?.rows || [];
  return rows.filter((r) => Number(r?.kind) === 2).map((r) => {
    const d = r.data || {};
    return {
      number: String(r.number ?? d.NUMBER ?? ''),
      description: String(d.DESCRIPTION ?? r.desc ?? ''),
      approved: parseInt(String(r.status ?? d.STATUS ?? d.status ?? '0'), 10) !== 0,
      gross: num(r.credit ?? d.credit),
    };
  });
}

export type Decision =
  | { outcome: 'used'; how: 'line' | 'credit_note'; hhRef: string; problem: string | null }
  | { outcome: 'waiting'; problem: string | null };

/** What a reserved credit's HireHop job says. Pure — the tests drive it directly. */
export function decideGoodwill(
  g: Pick<GoodwillCredit, 'ref' | 'amount_ex_vat' | 'reserved_amount_ex_vat' | 'reserved_at'>,
  read: { lines: SupplyLine[]; creditNotes: CreditNoteRow[] },
  now: Date = new Date(),
): Decision {
  const lines = read.lines.filter((l) => codesIn(l.text).includes(g.ref));
  if (lines.length > 0) {
    const discounted = lines.some((l) => l.unitPrice > 0 && l.price < l.unitPrice - 0.0001);
    return {
      outcome: 'used', how: 'line', hhRef: lines.map((l) => l.id).join(','),
      problem: discounted ? null : `The HireHop line with ${g.ref} isn't discounted — check the goodwill came off`,
    };
  }
  const notes = read.creditNotes.filter((c) => codesIn(c.description).includes(g.ref));
  const approved = notes.filter((c) => c.approved);
  if (approved.length > 0) {
    const net = g.reserved_amount_ex_vat ?? g.amount_ex_vat;
    const gross = approved.reduce((s, c) => s + c.gross, 0);
    // Credit notes carry VAT; 20% is the most the credit can be worth gross.
    const tooBig = gross > net * 1.2 + 0.01;
    return {
      outcome: 'used', how: 'credit_note', hhRef: approved.map((c) => c.number || '(no number)').join(','),
      problem: tooBig ? `The credit note (£${gross.toFixed(2)}) is more than the credit (£${net.toFixed(2)} + VAT)` : null,
    };
  }
  if (notes.length > 0) return { outcome: 'waiting', problem: `The credit note with ${g.ref} is still a draft in HireHop` };
  const reservedAt = g.reserved_at ? new Date(g.reserved_at).getTime() : now.getTime();
  return {
    outcome: 'waiting',
    problem: now.getTime() - reservedAt > WAIT_BEFORE_FLAG_MS ? `No line or credit note with ${g.ref} in HireHop yet` : null,
  };
}

// ── HireHop + database ───────────────────────────────────────────────────────

async function readJob(hhJobNumber: number): Promise<{ lines: SupplyLine[]; creditNotes: CreditNoteRow[] } | null> {
  const [items, billing] = await Promise.all([
    hhBroker.get<unknown>('/frames/items_to_supply_list.php', { job: hhJobNumber }, { priority: 'low', cacheTTL: 120 }),
    hhBroker.get<unknown>('/php_functions/billing_list.php', { main_id: hhJobNumber, type: 1 }, { priority: 'low', cacheTTL: 120 }),
  ]);
  // The broker RESOLVES {success:false} on a rate limit — never treat that as "nothing there".
  if (!items.success || !billing.success) return null;
  return { lines: parseSupplyList(items.data), creditNotes: parseBilling(billing.data) };
}

/** A one-off FYI bell (no resolve_key — it asks nothing), to whoever offered the credit. */
async function tellOfferer(g: GoodwillCredit, title: string, content: string, jobId: string | null) {
  try {
    const r = await query(`SELECT offered_by FROM goodwill_credits WHERE id = $1`, [g.id]);
    const userId = r.rows[0]?.offered_by;
    if (!userId) return;
    await query(
      `INSERT INTO notifications (user_id, type, title, content, entity_type, entity_id, action_url, priority)
       VALUES ($1, 'system', $2, $3, 'goodwill_credit', $4, $5, 'normal')`,
      [userId, title, content, g.id, jobId ? `/jobs/${jobId}` : null],
    );
  } catch (e) {
    console.warn('[goodwill-check] bell failed:', e);
  }
}

async function setProblem(id: string, problem: string | null) {
  await query(`UPDATE goodwill_credits SET check_problem = $2, last_checked_at = NOW() WHERE id = $1`, [id, problem]);
}

/**
 * Check one RESERVED credit against its job in HireHop. Returns the credit as it
 * now stands. Never throws on a HireHop failure — it just tries again next time.
 */
export async function checkReservedGoodwill(id: string): Promise<GoodwillCredit | null> {
  const g = await getGoodwillCredit(id);
  if (!g || g.status !== 'reserved' || !g.reserved_job_id) return g;
  const job = await query(`SELECT hh_job_number FROM jobs WHERE id = $1`, [g.reserved_job_id]);
  const hh = Number(job.rows[0]?.hh_job_number);
  if (!hh) return g;
  const read = await readJob(hh);
  if (!read) return g;

  const d = decideGoodwill(g, read);
  if (d.outcome === 'used') {
    const amount = g.reserved_amount_ex_vat ?? g.amount_ex_vat;
    // Guarded on status, so a "Mark as applied" in the meantime wins.
    const r = await query(
      `UPDATE goodwill_credits SET status = 'used', used_amount_ex_vat = $2, used_at = NOW(), used_by = NULL,
              used_how = $3, used_hh_ref = $4, check_problem = $5, last_checked_at = NOW(), updated_at = NOW()
        WHERE id = $1 AND status = 'reserved' RETURNING id`,
      [g.id, amount, d.how, d.hhRef, d.problem],
    );
    if (r.rows.length > 0) {
      const lapsed = g.amount_ex_vat - amount;
      await noteGoodwill(g,
        `🎁 Goodwill credit ${g.ref} found in HireHop (${d.how === 'line' ? 'on a line' : `credit note ${d.hhRef}`}) — used: £${amount.toFixed(2)} + VAT off.`
        + (lapsed > 0.004 ? ` The other £${lapsed.toFixed(2)} + VAT lapses.` : '')
        + (d.problem ? ` ⚠ ${d.problem}.` : ''),
        SYSTEM_USER_ID, [g.reserved_job_id]);
    }
  } else if (d.problem !== g.check_problem) {
    await setProblem(g.id, d.problem);
  } else {
    await query(`UPDATE goodwill_credits SET last_checked_at = NOW() WHERE id = $1`, [g.id]);
  }
  return getGoodwillCredit(id);
}

/** B: a GW code on a job's stored lines that isn't reserved there. */
async function handleCodeOnJob(ref: string, job: { id: string; hh_job_number: number }) {
  const g = await getGoodwillByRef(ref);
  if (!g) {
    console.warn(`[goodwill-check] ${ref} is on job ${job.hh_job_number} but no such goodwill credit exists`);
    return;
  }
  if (g.reserved_job_id === job.id && (g.status === 'reserved' || g.status === 'used')) return; // A's job

  if (g.status === 'offered') {
    // Free: link it to this job, as if someone had pressed "Use on this job", then check it.
    const r = await query(
      `UPDATE goodwill_credits g
          SET status = 'reserved', reserved_job_id = $2, reserved_for = 'hire', reserved_invoice_number = NULL,
              reserved_amount_ex_vat = g.amount_ex_vat, reserved_by = NULL, reserved_at = NOW(),
              check_problem = NULL, updated_at = NOW()
        WHERE g.id = $1 AND ${FREE_TO_RESERVE_SQL}
        RETURNING g.id`,
      [g.id, job.id],
    );
    if (r.rows.length === 0) return;
    await noteGoodwill(g, `🎁 Goodwill credit ${g.ref} found on this job in HireHop without being reserved in OP — linked to it.`, SYSTEM_USER_ID, [job.id]);
    const after = await checkReservedGoodwill(g.id);
    await tellOfferer(g, `Goodwill ${g.ref} used on job ${job.hh_job_number}`,
      `${g.ref} (${g.owner_name}) was put on job ${job.hh_job_number} in HireHop without being reserved in OP. OP has linked it`
      + `${after?.status === 'used' ? ` and marked it used (recorded at the full £${g.amount_ex_vat.toFixed(2)} + VAT; whatever didn't come off lapses)` : ''}.`,
      job.id);
    return;
  }

  // Already spoken for elsewhere, or no longer usable: flag it, and tell the offerer once.
  const where = g.reserved_job_number ? `job ${g.reserved_job_number}` : 'another job';
  const problem = g.status === 'reserved' || g.status === 'used'
    ? `${g.ref} is also on job ${job.hh_job_number} in HireHop — it's ${g.status} on ${where} and can only be used once`
    : `${g.ref} is on job ${job.hh_job_number} in HireHop, but the credit is ${g.status}`;
  if (g.check_problem === problem) return;
  await setProblem(g.id, problem);
  await tellOfferer(g, `Goodwill ${g.ref}: check job ${job.hh_job_number}`, problem, job.id);
}

/** The scheduled check (every 30 min, `config/scheduler.ts`). Never throws. */
export async function runGoodwillCheck(): Promise<{ checked: number; codesSeen: number }> {
  let checked = 0;
  let codesSeen = 0;
  try {
    // A — reserved credits whose job is still live.
    const reserved = await query(
      `SELECT g.id FROM goodwill_credits g
         JOIN jobs rj ON rj.id = g.reserved_job_id
        WHERE (${EFFECTIVE_STATUS_SQL}) = 'reserved' AND rj.hh_job_number IS NOT NULL AND rj.is_deleted = false`,
    );
    for (const row of reserved.rows) {
      try { await checkReservedGoodwill(row.id); checked++; } catch (e) { console.warn(`[goodwill-check] ${row.id}:`, e); }
    }

    // B — codes on stored lines. A plain-string regex (never E'') — CLAUDE.md "Data handling".
    const jobs = await query(
      `SELECT id, hh_job_number, line_items::text AS lines FROM jobs
        WHERE is_deleted = false AND pipeline_status NOT IN ('lost', 'cancelled')
          AND line_items::text ~* 'GW-[0-9]{4}'`,
    );
    for (const j of jobs.rows) {
      for (const ref of codesIn(j.lines)) {
        try { await handleCodeOnJob(ref, j); codesSeen++; } catch (e) { console.warn(`[goodwill-check] ${ref} on ${j.hh_job_number}:`, e); }
      }
    }
  } catch (e) {
    console.error('[goodwill-check] run failed:', e);
  }
  return { checked, codesSeen };
}
