/**
 * shop-reconcile.ts — does the week's shop job in HireHop still match what OP
 * put on it? And what did the week take?
 *
 * Step 9 of `docs/SHOP-SALES-SPEC.md` (§12). The spec first framed the check
 * as "lines inc VAT == payments". Built instead as two sides compared against
 * OP's OWN record, because that is exact and says which side broke:
 *
 *   GOODS  — OP's ex-VAT total of every line it pushed and hasn't removed,
 *            vs HireHop's job net total (billing `kind = 0` `accrued`, the
 *            figure `job-value-sync.ts` reads). Ex-VAT on both sides, so no
 *            VAT-rounding noise. A mismatch = a line added or deleted by hand.
 *   MONEY  — what OP took less what it refunded, vs the deposits' unallocated
 *            balances in HireHop (`readDepositAvailability`, the refund code's
 *            own reading). A mismatch = a payment typed or deleted by hand.
 *            Only checked until the week is invoiced — after that the money is
 *            applied to the invoice and "unallocated" means something else.
 *   LINES  — every line OP pushed is still on the job, and the job is still at
 *            dispatched or later. A status regression silently un-sells the
 *            whole week (§2.1).
 *
 * ⚠️ What this CANNOT see: a sale line CHECKED IN by mistake. The line stays on
 * the job at the same price, so goods and lines still agree — only the shelf
 * count moves. That stays a procedure rule ("never check in sale lines").
 *
 * The check runs inside the drain lock, so it never sees a sale half-pushed.
 * A sale whose payment is still retrying is NOT a mismatch: OP only counts
 * what it has recorded as pushed, which is exactly what HireHop should hold.
 */
import { query } from '../config/database';
import hhBroker from './hirehop-broker';
import { readBillingRows, readDepositAvailability } from './hh-deposit-release';
import { readJobLineIds, withShopDrainLock } from './shop-drain';
import { saleRef } from './shop-sale-ref';
import { emailService } from './email-service';
import { tenderLabel } from './shop-tenders';
import { getFrontendUrl } from '../config/app-urls';
import { DISPLAY_NAME_SQL } from './display-name';

/* eslint-disable @typescript-eslint/no-explicit-any */

// Same reasoning as the Xero-sync alert: only jon can fix a HireHop/Xero
// discrepancy, so the alarm goes to him and nobody else (jon, Sep 2026).
const SHOP_ALERT_RECIPIENT = 'jon@oooshtours.co.uk';

/** How long a sale may sit queued past its hold before it counts as stuck. */
const STUCK_MINUTES = 30;

const PENNY = 0.005;
const round2 = (n: number) => Math.round(n * 100) / 100;

function addDays(iso: string, n: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

// ── The week's takings ───────────────────────────────────────────────────

export interface TenderTotals {
  tender: string;
  sales: number;
  taken: number;
  refunded: number;
  net: number;
}

export interface WeekSummary {
  periodStart: string;
  periodEnd: string;
  /** Money taken, by how it was paid. Excludes "their bill". */
  byTender: TenderTotals[];
  taken: number;
  refunded: number;
  net: number;
  /** Put on bands' bills — sold, but no money taken. */
  onTheirBill: { sales: number; net: number };
  /** Sales not (yet) in HireHop — the money is real, the push isn't done. */
  notPushed: number;
}

/**
 * Everything sold in the week Mon–Sun (UK dates), wherever it went — the shop
 * job AND bands' jobs, because the drawer doesn't care which job a sale is on.
 * A queued or failed sale still counts: the customer has paid, even if
 * HireHop hasn't heard yet. Only a cancelled one never happened.
 */
export async function getWeekSummary(periodStart: string): Promise<WeekSummary> {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(periodStart)) throw new Error('Week start must be YYYY-MM-DD.');
  const periodEnd = addDays(periodStart, 6);

  const r = await query(
    `SELECT kind, status, tender, gross_amount
       FROM shop_sales
      WHERE kind IN ('sale', 'reversal')
        AND status <> 'cancelled'
        AND (created_at AT TIME ZONE 'Europe/London')::date BETWEEN $1::date AND $2::date`,
    [periodStart, periodEnd],
  );

  const map = new Map<string, TenderTotals>();
  const onTheirBill = { sales: 0, net: 0 };
  let notPushed = 0;
  for (const row of r.rows) {
    const gross = Math.abs(Number(row.gross_amount) || 0);
    const isSale = row.kind === 'sale';
    if (row.status !== 'pushed') notPushed++;
    if (row.tender === 'invoice_later') {
      if (isSale) onTheirBill.sales++;
      onTheirBill.net = round2(onTheirBill.net + (isSale ? gross : -gross));
      continue;
    }
    const key = String(row.tender || 'unknown');
    const t = map.get(key) ?? { tender: key, sales: 0, taken: 0, refunded: 0, net: 0 };
    if (isSale) { t.sales++; t.taken = round2(t.taken + gross); } else { t.refunded = round2(t.refunded + gross); }
    t.net = round2(t.taken - t.refunded);
    map.set(key, t);
  }
  const byTender = [...map.values()].sort((a, b) => b.net - a.net);
  const taken = round2(byTender.reduce((s, t) => s + t.taken, 0));
  const refunded = round2(byTender.reduce((s, t) => s + t.refunded, 0));
  return {
    periodStart, periodEnd, byTender, taken, refunded,
    net: round2(taken - refunded), onTheirBill, notPushed,
  };
}

// ── One sitter's evening ─────────────────────────────────────────────────

export interface ShiftShopSummary {
  sales: number;
  /** Money actually taken tonight, inc VAT. Excludes "their bill". */
  taken: number;
  byTender: Array<{ tender: string; label: string; amount: number }>;
  onTheirBill: number;
  /** Sitter sales staff haven't ticked off yet. */
  toReview: number;
}

/**
 * What the till took on one sitter shift — for the lock-up report (the sitter
 * sees it; staff see it on the report) and its handover-thread summary. A
 * cancelled sale never happened; a queued or failed one still took money.
 */
export async function getShiftShopSummary(shiftId: string): Promise<ShiftShopSummary> {
  const r = await query(
    `SELECT tender, gross_amount, needs_review, reviewed_at
       FROM shop_sales
      WHERE shift_id = $1 AND kind = 'sale' AND status <> 'cancelled'`,
    [shiftId],
  );
  const by = new Map<string, number>();
  let taken = 0; let onTheirBill = 0; let toReview = 0;
  for (const row of r.rows) {
    const g = Number(row.gross_amount) || 0;
    if (row.needs_review && !row.reviewed_at) toReview++;
    if (row.tender === 'invoice_later') { onTheirBill = round2(onTheirBill + g); continue; }
    taken = round2(taken + g);
    by.set(row.tender, round2((by.get(row.tender) ?? 0) + g));
  }
  return {
    sales: r.rows.length,
    taken,
    byTender: [...by.entries()].map(([tender, amount]) => ({ tender, label: tenderLabel(tender), amount }))
      .sort((a, b) => b.amount - a.amount),
    onTheirBill,
    toReview,
  };
}

/** "3 sales, £18.50 — Cash £6.00 · Card (Worldpay) £12.50" — one line for a thread or email. */
export function describeShiftShop(s: ShiftShopSummary): string {
  if (!s.sales) return 'No shop sales tonight.';
  const parts = s.byTender.map((t) => `${t.label} £${t.amount.toFixed(2)}`);
  if (s.onTheirBill) parts.push(`on bands' bills £${s.onTheirBill.toFixed(2)}`);
  return `${s.sales} sale${s.sales === 1 ? '' : 's'}, £${s.taken.toFixed(2)} taken — ${parts.join(' · ')}`;
}

// ── The balance check ────────────────────────────────────────────────────

export interface ShopCheck {
  checkedAt: string;
  ok: boolean;
  hhJobNumber: number;
  /** HireHop job status, or null if it couldn't be read. */
  status: number | null;
  invoiced: boolean;
  goods: { expected: number; actual: number | null; ok: boolean | null };
  /** Null once invoiced — see the header comment. */
  money: { expected: number; actual: number | null; ok: boolean | null } | null;
  missingLines: Array<{ ref: string | null; name: string; lineId: number }>;
  /** Plain-English list of what's wrong. Empty when ok. */
  problems: string[];
}

/** Why a job status would release the week's stock, or null if it's fine. */
function statusProblem(status: number | null): string | null {
  if (status == null) return null;
  // Consumption holds at dispatched (5) and after, and is RELEASED below it —
  // and by cancelling (§2.1, confirmed by jon). 10 = not interested.
  if (status < 5 || status === 9 || status === 10) {
    return `The job's HireHop status is ${status} — sale stock is only consumed at dispatched (5) or later, so the week's stock is back on the shelf.`;
  }
  return null;
}

/**
 * Check one week's shop job against OP's record. Reads HireHop (three calls),
 * stores the result on the period, and marks the week invoiced the first time
 * an invoice appears on the job — closing the gap where OP never knew.
 */
export async function checkShopPeriod(periodId: string): Promise<ShopCheck> {
  const p = await query(`SELECT id, hh_job_number FROM shop_sale_periods WHERE id = $1`, [periodId]);
  const hhJobNumber = p.rows[0]?.hh_job_number ? Number(p.rows[0].hh_job_number) : null;
  if (!hhJobNumber) throw new Error('That week has no HireHop job yet.');

  // Inside the drain lock: never compare against a sale that is mid-push.
  const result = await withShopDrainLock(async (): Promise<ShopCheck> => {
    const [jobRes, billing, lineIds, expected] = await Promise.all([
      hhBroker.get<any>('/api/job_data.php', { job: hhJobNumber }, { priority: 'low', cacheTTL: -1, skipCache: true }),
      readBillingRows(hhJobNumber),
      readJobLineIds(hhJobNumber),
      query(
        `SELECT
           (SELECT COALESCE(SUM(l.line_net), 0) FROM shop_sale_lines l
              JOIN shop_sales s ON s.id = l.sale_id
             WHERE s.kind = 'sale' AND s.hh_job_number = $1
               AND l.hh_line_id IS NOT NULL AND l.hh_line_removed_at IS NULL) AS goods,
           (SELECT COALESCE(SUM(gross_amount), 0) FROM shop_sales
             WHERE kind = 'sale' AND hh_job_number = $1 AND hh_deposit_id IS NOT NULL) AS paid,
           (SELECT COALESCE(SUM(ABS(gross_amount)), 0) FROM shop_sales
             WHERE kind = 'reversal' AND hh_job_number = $1 AND hh_refund_id IS NOT NULL) AS refunded`,
        [hhJobNumber],
      ),
    ]);

    const status = jobRes?.success && jobRes.data?.STATUS != null ? parseFloat(String(jobRes.data.STATUS)) : null;
    const invoiced = billing.some((row: any) => parseInt(row.kind ?? '0') === 1);
    const problems: string[] = [];

    // Goods — ex-VAT on both sides.
    const goodsExpected = round2(Number(expected.rows[0].goods));
    const totalRow = billing.find((row: any) => parseInt(row.kind ?? '0') === 0);
    const goodsActualRaw = totalRow ? parseFloat(totalRow.accrued ?? totalRow.data?.accrued ?? '') : NaN;
    const goodsActual = Number.isFinite(goodsActualRaw) ? round2(goodsActualRaw) : null;
    const goodsOk = goodsActual == null ? null : Math.abs(goodsActual - goodsExpected) < PENNY;
    if (goodsActual == null) problems.push("Couldn't read the job's net total from HireHop.");
    else if (!goodsOk) {
      problems.push(`Goods: OP put £${goodsExpected.toFixed(2)} ex-VAT on the job, HireHop shows £${goodsActual.toFixed(2)} — `
        + 'a line has been added or removed outside the till.');
    }

    // Money — until invoiced.
    let money: ShopCheck['money'] = null;
    if (!invoiced) {
      const moneyExpected = round2(Number(expected.rows[0].paid) - Number(expected.rows[0].refunded));
      let moneyActual = 0;
      for (const row of billing) {
        if (parseInt(row.kind ?? '0') !== 6) continue;
        if (!(parseFloat(row.credit ?? row.data?.credit ?? '0') > 0)) continue;   // refunds/negatives aren't deposits
        const id = parseInt(row.data?.ID || row.number || '0');
        const dep = id ? readDepositAvailability(billing, id) : null;
        if (dep) moneyActual += dep.available;
      }
      moneyActual = round2(moneyActual);
      const moneyOk = Math.abs(moneyActual - moneyExpected) < PENNY;
      money = { expected: moneyExpected, actual: moneyActual, ok: moneyOk };
      if (!moneyOk) {
        problems.push(`Money: OP took £${moneyExpected.toFixed(2)} net of refunds, HireHop holds £${moneyActual.toFixed(2)} — `
          + 'a payment has been added, removed or refunded outside the till.');
      }
    }

    // Lines — every one OP pushed is still there.
    const missingLines: ShopCheck['missingLines'] = [];
    if (lineIds) {
      const ours = await query(
        `SELECT l.hh_line_id, l.name_snapshot, s.sale_number
           FROM shop_sale_lines l JOIN shop_sales s ON s.id = l.sale_id
          WHERE s.kind = 'sale' AND s.hh_job_number = $1
            AND l.hh_line_id IS NOT NULL AND l.hh_line_removed_at IS NULL`,
        [hhJobNumber],
      );
      for (const l of ours.rows) {
        if (!lineIds.has(String(l.hh_line_id))) {
          missingLines.push({
            ref: l.sale_number ? saleRef(Number(l.sale_number)) : null,
            name: l.name_snapshot,
            lineId: Number(l.hh_line_id),
          });
        }
      }
      if (missingLines.length) {
        problems.push(`${missingLines.length} line${missingLines.length === 1 ? '' : 's'} OP pushed ${missingLines.length === 1 ? 'is' : 'are'} no longer on the job: `
          + missingLines.map((m) => `${m.name}${m.ref ? ` (${m.ref})` : ''}`).join(', ') + '.');
      }
    } else {
      problems.push("Couldn't read the job's lines from HireHop.");
    }

    const sp = statusProblem(status);
    if (sp) problems.push(sp);

    return {
      checkedAt: new Date().toISOString(),
      ok: problems.length === 0,
      hhJobNumber, status, invoiced,
      goods: { expected: goodsExpected, actual: goodsActual, ok: goodsOk },
      money, missingLines, problems,
    };
  });

  await query(
    `UPDATE shop_sale_periods
        SET last_checked_at = NOW(), last_check_ok = $2, last_check = $3::jsonb,
            invoiced_at = COALESCE(invoiced_at, CASE WHEN $4 THEN NOW() END)
      WHERE id = $1`,
    [periodId, result.ok, JSON.stringify(result), result.invoiced],
  );
  return result;
}

// ── The scanner ──────────────────────────────────────────────────────────

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/**
 * Every 15 minutes: check each recent, un-invoiced week, and chase stuck or
 * failed transactions. Emails jon ONCE per distinct problem — a week alerts
 * again only when what's wrong changes, and a sale only once until retried.
 */
export async function runShopReconcileScan(): Promise<{ weeks: number; alerted: number; stuck: number }> {
  let alerted = 0;

  const periods = await query(
    `SELECT id, period_start::text AS period_start, hh_job_number, alert_signature
       FROM shop_sale_periods
      WHERE hh_job_number IS NOT NULL AND invoiced_at IS NULL
        AND period_start >= CURRENT_DATE - 35
      ORDER BY period_start`,
  );
  for (const p of periods.rows) {
    try {
      const check = await checkShopPeriod(p.id);
      const signature = check.ok ? null : JSON.stringify(check.problems);
      if (signature && signature !== p.alert_signature) {
        await emailService.sendRaw({
          to: SHOP_ALERT_RECIPIENT,
          subject: `[Shop] Week of ${p.period_start} (HireHop job ${p.hh_job_number}) doesn't match the till`,
          html: `<p>The balance check on the shop job for the week of <strong>${p.period_start}</strong> `
            + `(HireHop job ${p.hh_job_number}) found:</p><ul>`
            + check.problems.map((x) => `<li>${escapeHtml(x)}</li>`).join('')
            + `</ul><p>Details are on the Shop Till page, under <em>This week</em>. `
            + `You won't hear about this again unless what's wrong changes.</p>`,
          variant: 'internal',
        });
        alerted++;
      }
      if (signature !== p.alert_signature) {
        await query(`UPDATE shop_sale_periods SET alert_signature = $2 WHERE id = $1`, [p.id, signature]);
      }
    } catch (err) {
      // A HireHop wobble is not a finding. Log it; the next pass tries again.
      console.error(`[shop-reconcile] check of week ${p.period_start} failed:`, err instanceof Error ? err.message : err);
    }
  }

  // Stuck or failed transactions — one email for the batch.
  const stuck = await query(
    `SELECT id, kind, status, sale_number, gross_amount, push_error, created_at
       FROM shop_sales
      WHERE stuck_alerted_at IS NULL
        AND (status = 'failed'
             OR (status = 'queued' AND push_after < NOW() - ($1 || ' minutes')::interval))
      ORDER BY created_at`,
    [String(STUCK_MINUTES)],
  );
  if (stuck.rows.length) {
    const items = stuck.rows.map((s: any) => {
      const what = s.kind === 'consumption' ? 'Stock use' : s.kind === 'reversal' ? 'Refund' : 'Sale';
      const ref = s.sale_number ? ` ${saleRef(Number(s.sale_number))}` : '';
      const money = s.kind === 'consumption' ? '' : ` £${Math.abs(Number(s.gross_amount)).toFixed(2)}`;
      const why = s.status === 'failed'
        ? `failed: ${s.push_error || 'no reason recorded'}`
        : `still queued ${STUCK_MINUTES}+ minutes after it was due${s.push_error ? ` (last error: ${s.push_error})` : ''}`;
      return `<li>${what}${ref}${money} — ${escapeHtml(why)}</li>`;
    });
    try {
      await emailService.sendRaw({
        to: SHOP_ALERT_RECIPIENT,
        subject: `[Shop] ${stuck.rows.length} transaction${stuck.rows.length === 1 ? '' : 's'} not reaching HireHop`,
        html: `<p>These till transactions haven't reached HireHop:</p><ul>${items.join('')}</ul>`
          + `<p>They're under <em>Needs attention</em> on the Shop Till page, with Retry.</p>`,
        variant: 'internal',
      });
      await query(`UPDATE shop_sales SET stuck_alerted_at = NOW() WHERE id = ANY($1::uuid[])`,
        [stuck.rows.map((s: any) => s.id)]);
      alerted++;
    } catch (err) {
      console.error('[shop-reconcile] stuck-sale alert failed:', err instanceof Error ? err.message : err);
    }
  }

  // Sitter sales nobody has reviewed — a nudge, not an alarm (jon, Sep 2026:
  // "important things buried in a place no one is otherwise looking").
  const reminded = await remindUnreviewedSitterSales();

  return { weeks: periods.rows.length, alerted: alerted + reminded, stuck: stuck.rows.length };
}

async function setting(key: string, fallback: string): Promise<string> {
  try {
    const r = await query(`SELECT value FROM system_settings WHERE key = $1`, [key]);
    const v = r.rows[0]?.value;
    return v != null && String(v).trim() !== '' ? String(v).trim() : fallback;
  } catch {
    return fallback;
  }
}

/**
 * Once a sitter sale has sat unreviewed for `shop_review_reminder_hours`, email
 * `shop_review_reminder_to` (default info@) one reminder covering every such
 * sale, each reminded only once. Returns 1 if a reminder went, else 0.
 */
async function remindUnreviewedSitterSales(): Promise<number> {
  const hours = Number(await setting('shop_review_reminder_hours', '12'));
  const to = await setting('shop_review_reminder_to', 'info@oooshtours.co.uk');
  if (!Number.isFinite(hours) || hours <= 0) return 0;

  const due = await query(
    `SELECT s.id, s.sale_number, s.gross_amount, s.tender, s.created_at,
            NULLIF(${DISPLAY_NAME_SQL}, ' ') AS sitter
       FROM shop_sales s
       LEFT JOIN people p ON p.id = s.recorded_by_person_id
      WHERE s.needs_review AND s.reviewed_at IS NULL AND s.review_reminded_at IS NULL
        AND s.status <> 'cancelled'
        AND s.created_at < NOW() - ($1 || ' hours')::interval
      ORDER BY s.created_at`,
    [String(hours)],
  );
  if (!due.rows.length) return 0;

  const url = `${getFrontendUrl()}/money/shop?tab=review`;
  const items = due.rows.map((s: any) =>
    `<li>${s.sale_number ? saleRef(Number(s.sale_number)) + ' — ' : ''}£${Number(s.gross_amount).toFixed(2)} `
    + `${escapeHtml(tenderLabel(s.tender))}${s.sitter ? ` (${escapeHtml(s.sitter)})` : ''}, `
    + `${new Date(s.created_at).toLocaleString('en-GB', { timeZone: 'Europe/London', dateStyle: 'medium', timeStyle: 'short' })}</li>`);
  try {
    await emailService.sendRaw({
      to,
      subject: `[Shop] ${due.rows.length} sitter sale${due.rows.length === 1 ? '' : 's'} waiting to be reviewed`,
      html: `<p>These shop sales were taken by a studio sitter and haven't been checked yet:</p><ul>${items.join('')}</ul>`
        + `<p><a href="${url}">Review them on the Shop Till page</a> — a quick look that each one makes sense.</p>`,
      variant: 'internal',
    });
    await query(`UPDATE shop_sales SET review_reminded_at = NOW() WHERE id = ANY($1::uuid[])`,
      [due.rows.map((s: any) => s.id)]);
    return 1;
  } catch (err) {
    console.error('[shop-reconcile] review reminder failed:', err instanceof Error ? err.message : err);
    return 0;
  }
}
