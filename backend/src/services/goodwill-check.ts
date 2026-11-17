/**
 * Goodwill read-back — docs/GOODWILL-CREDIT-SPEC.md §6, phase 2.
 *
 * OP never WRITES a goodwill credit to HireHop; staff apply it by hand with the
 * credit's code (GW-0012) in a line's Item Note / Item Memo or a credit note's
 * description. This READS HireHop to see that it happened:
 *
 *   A. every RESERVED credit (hourly): the code on a line of its job, read from
 *      the lines the HireHop sync has ALREADY stored (jobs.line_items — Item Note,
 *      Item Memo and prices kept since phase 2) — no HireHop call of its own.
 *   B. the same stored lines of every live job: a code on a job it ISN'T reserved on
 *      is linked to that job if it's free, else flagged.
 *   C. credit notes (only billing shows them), from billing reads that happen anyway:
 *      the Money tab's summary hands its billing read here (`applyGoodwillFromBilling`),
 *      plus ONE billing call a day per credit reserved against an invoice and not yet
 *      found (`runGoodwillBillingCheck`, 07:40).
 *   "Check HireHop now" (`checkReservedGoodwill(id, 'live')`) reads both live.
 *
 * The code on a line, or on an APPROVED credit note, marks the credit used. Nothing
 * after 24h, a draft credit note, a line with the code but no discount, or a credit
 * note bigger than the credit → `check_problem` (a warning, never a gate). Jon, 17 Nov
 * 2026: no extra HireHop calls for something that can wait an hour.
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

/** A supply line: all its text joined, and its prices (null = not known — a line stored before
 *  prices were kept, so the "isn't discounted" warning can't be judged). */
export interface SupplyLine { id: number; text: string; unitPrice: number | null; price: number | null }
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

/** jobs.line_items (hirehop-job-sync.ts `HHLineItem`) → lines. Prices only once the sync has kept them. */
export function parseStoredLines(items: unknown): SupplyLine[] {
  const rows: any[] = Array.isArray(items) ? items : [];
  const price = (v: unknown) => (v === undefined || v === null || v === '' ? null : num(v));
  return rows.filter((r) => r && typeof r === 'object').map((r) => ({
    id: Number(r.ITEM_ID ?? 0),
    text: [r.ITEM_NAME, r.ADDITIONAL, r.TECHNICAL].filter((v) => typeof v === 'string').join(' \u0001 '),
    unitPrice: price(r.UNIT_PRICE),
    price: price(r.PRICE),
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
  /** False when this look can't tell "not there" from "not looked yet" (an enquiry the line
   *  sync skips, an invoice credit read without billing) — then "nothing yet" is never flagged. */
  canFlagMissing = true,
): Decision {
  const lines = read.lines.filter((l) => codesIn(l.text).includes(g.ref));
  if (lines.length > 0) {
    const unknown = lines.some((l) => l.unitPrice === null || l.price === null);
    const discounted = unknown || lines.some((l) => (l.unitPrice ?? 0) > 0 && (l.price ?? 0) < (l.unitPrice ?? 0) - 0.0001);
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
      problem: tooBig ? `The credit note (£${gross.toFixed(2)}) is more than the credit (£${net.toFixed(2)}+VAT)` : null,
    };
  }
  if (notes.length > 0) return { outcome: 'waiting', problem: `The credit note with ${g.ref} is still a draft in HireHop` };
  const reservedAt = g.reserved_at ? new Date(g.reserved_at).getTime() : now.getTime();
  return {
    outcome: 'waiting',
    problem: canFlagMissing && now.getTime() - reservedAt > WAIT_BEFORE_FLAG_MS ? `No line or credit note with ${g.ref} in HireHop yet` : null,
  };
}

// ── HireHop + database ───────────────────────────────────────────────────────

/** The broker RESOLVES {success:false} on a rate limit — null, never "nothing there". */
async function readLinesLive(hh: number): Promise<SupplyLine[] | null> {
  const r = await hhBroker.get<unknown>('/frames/items_to_supply_list.php', { job: hh }, { priority: 'low', cacheTTL: 120 });
  return r.success ? parseSupplyList(r.data) : null;
}
async function readBilling(hh: number): Promise<CreditNoteRow[] | null> {
  const r = await hhBroker.get<unknown>('/php_functions/billing_list.php', { main_id: hh, type: 1 }, { priority: 'low', cacheTTL: 120 });
  return r.success ? parseBilling(r.data) : null;
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
 * How a check looks at HireHop:
 *   'stored'  — the lines the sync already stored; no HireHop call (the hourly run).
 *   'billing' — stored lines + ONE billing read (the daily run, invoice credits only).
 *   'live'    — both read from HireHop now ("Check HireHop now").
 */
export type CheckMode = 'stored' | 'billing' | 'live';

/**
 * Check one RESERVED credit. Returns the credit as it now stands. Never throws on a
 * HireHop failure — it just tries again next time.
 */
export async function checkReservedGoodwill(id: string, mode: CheckMode = 'stored'): Promise<GoodwillCredit | null> {
  const g = await getGoodwillCredit(id);
  if (!g || g.status !== 'reserved' || !g.reserved_job_id) return g;
  const job = await query(
    `SELECT hh_job_number, status, line_items, line_items_synced_at FROM jobs WHERE id = $1`,
    [g.reserved_job_id],
  );
  const j = job.rows[0];
  const hh = Number(j?.hh_job_number);
  if (!j || !hh) return g;

  let lines: SupplyLine[];
  if (mode === 'live') {
    const live = await readLinesLive(hh);
    if (!live) return g;
    lines = live;
  } else {
    lines = parseStoredLines(j.line_items);
  }
  let creditNotes: CreditNoteRow[] = [];
  let billingRead = false;
  if (mode !== 'stored') {
    const b = await readBilling(hh);
    if (b) { creditNotes = b; billingRead = true; }
  }
  // "Nothing yet" only means something when we've looked where it would be: a hire's line on a
  // job the line sync keeps fresh (HireHop 1–6 — `syncLineItemsForActiveJobs()`; never an enquiry,
  // and a returned / completed job's stored lines can be old), an invoice's credit note in billing.
  const st = Number(j.status);
  const linesCovered = mode === 'live' || (st >= 1 && st <= 6 && !!j.line_items_synced_at);
  const canFlagMissing = g.reserved_for === 'invoice' ? billingRead : linesCovered;
  return applyDecision(g, decideGoodwill(g, { lines, creditNotes }, new Date(), canFlagMissing), canFlagMissing);
}

/** Write what a check decided. `missingJudged` false leaves a "waiting" credit's flag as it was. */
async function applyDecision(g: GoodwillCredit, d: Decision, missingJudged: boolean): Promise<GoodwillCredit | null> {
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
        `🎁 Goodwill credit ${g.ref} found in HireHop (${d.how === 'line' ? 'on a line' : `credit note ${d.hhRef}`}) — used: £${amount.toFixed(2)}+VAT off.`
        + (lapsed > 0.004 ? ` The other £${lapsed.toFixed(2)}+VAT lapses.` : '')
        + (d.problem ? ` ⚠ ${d.problem}.` : ''),
        SYSTEM_USER_ID, [g.reserved_job_id]);
    }
  } else if ((d.problem !== null || missingJudged) && d.problem !== g.check_problem) {
    await setProblem(g.id, d.problem);
  } else {
    await query(`UPDATE goodwill_credits SET last_checked_at = NOW() WHERE id = $1`, [g.id]);
  }
  return getGoodwillCredit(g.id);
}

/** Link a FREE credit to the job its code turned up on, as if someone had pressed "Use on this job". */
async function linkFreeCredit(g: GoodwillCredit, jobId: string, reservedFor: 'hire' | 'invoice'): Promise<boolean> {
  const r = await query(
    `UPDATE goodwill_credits g
        SET status = 'reserved', reserved_job_id = $2, reserved_for = $3, reserved_invoice_number = NULL,
            reserved_amount_ex_vat = g.amount_ex_vat, reserved_by = NULL, reserved_at = NOW(),
            check_problem = NULL, updated_at = NOW()
      WHERE g.id = $1 AND ${FREE_TO_RESERVE_SQL}
      RETURNING g.id`,
    [g.id, jobId, reservedFor],
  );
  if (r.rows.length === 0) return false;
  await noteGoodwill(g, `🎁 Goodwill credit ${g.ref} found on this job in HireHop without being reserved in OP — linked to it.`, SYSTEM_USER_ID, [jobId]);
  return true;
}

async function tellLinked(g: GoodwillCredit, after: GoodwillCredit | null, job: { id: string; hh_job_number: number }) {
  await tellOfferer(g, `Goodwill ${g.ref} used on job ${job.hh_job_number}`,
    `${g.ref} (${g.owner_name}) was put on job ${job.hh_job_number} in HireHop without being reserved in OP. OP has linked it`
    + `${after?.status === 'used' ? ` and marked it used (recorded at the full £${g.amount_ex_vat.toFixed(2)}+VAT; whatever didn't come off lapses)` : ''}.`,
    job.id);
}

/** The same code somewhere it shouldn't be: flag it on the credit, and tell the offerer once. */
async function flagElsewhere(g: GoodwillCredit, job: { id: string; hh_job_number: number }) {
  const where = g.reserved_job_number ? `job ${g.reserved_job_number}` : 'another job';
  const problem = g.status === 'reserved' || g.status === 'used'
    ? `${g.ref} is also on job ${job.hh_job_number} in HireHop — it's ${g.status} on ${where} and can only be used once`
    : `${g.ref} is on job ${job.hh_job_number} in HireHop, but the credit is ${g.status}`;
  if (g.check_problem === problem) return;
  await setProblem(g.id, problem);
  await tellOfferer(g, `Goodwill ${g.ref}: check job ${job.hh_job_number}`, problem, job.id);
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
    if (!(await linkFreeCredit(g, job.id, 'hire'))) return;
    await tellLinked(g, await checkReservedGoodwill(g.id, 'stored'), job);
    return;
  }
  await flagElsewhere(g, job);
}

/** The hourly check (`config/scheduler.ts`, :50 — after the line sync). No HireHop calls. Never throws. */
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
      try { await checkReservedGoodwill(row.id, 'stored'); checked++; } catch (e) { console.warn(`[goodwill-check] ${row.id}:`, e); }
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

/**
 * C, daily (07:40): ONE billing read per credit reserved against an invoice and not yet
 * found — the only HireHop calls the goodwill check makes on its own. Never throws.
 */
export async function runGoodwillBillingCheck(): Promise<{ checked: number }> {
  let checked = 0;
  try {
    const r = await query(
      `SELECT g.id FROM goodwill_credits g
         JOIN jobs rj ON rj.id = g.reserved_job_id
        WHERE (${EFFECTIVE_STATUS_SQL}) = 'reserved' AND g.reserved_for = 'invoice'
          AND rj.hh_job_number IS NOT NULL AND rj.is_deleted = false`,
    );
    for (const row of r.rows) {
      try { await checkReservedGoodwill(row.id, 'billing'); checked++; } catch (e) { console.warn(`[goodwill-check] billing ${row.id}:`, e); }
    }
  } catch (e) {
    console.error('[goodwill-check] billing run failed:', e);
  }
  return { checked };
}

/**
 * C, piggy-backed: the Money tab summary has just read this job's billing from HireHop
 * (`routes/money.ts`) — look for GW codes on its credit notes at no extra cost. Only ever
 * marks a credit used, links a free one, or flags a second use; never sets "nothing yet"
 * (this read never saw the job's lines). Fire-and-forget: never throws.
 */
export async function applyGoodwillFromBilling(jobId: string, billingData: unknown): Promise<void> {
  try {
    const creditNotes = parseBilling(billingData);
    const refs = Array.from(new Set(creditNotes.filter((c) => c.approved).flatMap((c) => codesIn(c.description))));
    if (refs.length === 0) return;
    const jr = await query(`SELECT id, hh_job_number FROM jobs WHERE id = $1`, [jobId]);
    const job = jr.rows[0];
    if (!job) return;
    for (const ref of refs) {
      let g = await getGoodwillByRef(ref);
      if (!g) continue;
      if (g.status === 'offered') {
        if (!(await linkFreeCredit(g, job.id, 'invoice'))) continue;
        g = await getGoodwillCredit(g.id);
        if (!g) continue;
        const after = await applyDecision(g, decideGoodwill(g, { lines: [], creditNotes }, new Date(), false), false);
        await tellLinked(g, after, job);
      } else if (g.status === 'reserved' && g.reserved_job_id === job.id) {
        await applyDecision(g, decideGoodwill(g, { lines: [], creditNotes }, new Date(), false), false);
      } else if (!(g.status === 'used' && g.reserved_job_id === job.id)) {
        await flagElsewhere(g, job);
      }
    }
  } catch (e) {
    console.warn('[goodwill-check] from billing failed:', e);
  }
}

