/**
 * Wise incoming payments — bank transfers noticed from Wise's "Money received from …"
 * emails and matched to jobs.
 *
 * Why email, not the Wise API: a personal API token on a Wise Business account cannot
 * read balance statements or receive incoming-payment webhooks (UK accounts, Oct 2026),
 * but Wise emails jon@ for every credit. Those emails are already flowing through the
 * Gmail ingestion loop (jon@ is a manager mailbox), so this is a detector in that loop
 * plus a matcher, not a new integration.
 *
 * Trust: an email is not money. We only accept mail from noreply@wise.com whose DKIM
 * signature Gmail reports as passing for wise.com (`Authentication-Results`), and whose
 * subject is "Money received from …". Everything else from Wise (Direct Debits,
 * "Transfer sent", statements) is ignored.
 *
 * Amount: "Amount received" — what the client SENT. jon's rule: Xero handles the fee,
 * so the fee-netted "Amount paid into account" is kept for information only.
 *
 * Matching, stopping at the first tier that yields exactly ONE job:
 *   1. a job number in the reference (5-7 digits that exist in `jobs.hh_job_number`)
 *   2. a HireHop invoice number ("OT-INV-12345", or bare digits) on a recent job's billing
 *   (3. Xero invoice numbers "OT-6787" are deliberately NOT matched — rare, usually
 *       non-HireHop things like storage; see the unmatched queue)
 *   4. payer name against client / company names of jobs with money outstanding —
 *      EVIDENCE only, never a match on its own.
 *
 * Confident = one candidate job AND the amount equals (within AMOUNT_TOLERANCE) one of
 * the figures the portal offers: deposit, half, remaining balance, or the excess
 * outstanding. A confident match is recorded through services/record-payment.ts — the
 * same code a staff "Record Payment" click runs (OP row, HireHop deposit on the Wise
 * bank, excess update, Booked push, client email). No email to info@ for those.
 *
 * Anything else stays `unmatched`: shown on the Money overview and emailed ONCE to
 * info@ with the details and a link to resolve it. Nothing is ever deleted — a
 * payment that isn't a job's is marked `ignored` with a note.
 */
import { query } from '../config/database';
import { hhBroker } from './hirehop-broker';
import { emailService } from './email-service';
import { frontendLink } from '../config/app-urls';
import { getSystemSetting } from '../routes/system-settings';
import { recordPayment, SYSTEM_SERVICE_USER_ID, type RecordPaymentType } from './record-payment';

export const WISE_SENDER = 'noreply@wise.com';
/** Pennies of slack when comparing the amount sent against an expected figure (jon: "a couple"). */
export const AMOUNT_TOLERANCE = 0.02;
/** Default payer names to ignore (own transfers in). Staff-editable: system_settings.wise_ignore_payers (comma-separated). */
const DEFAULT_IGNORE_PAYERS = ['J WOOD'];
/** How many recent jobs the invoice-number tier may read billing for (one HH call each, cached). */
const INVOICE_SEARCH_POOL = 80;

export interface WiseEmailInput {
  mailbox: string;
  /** RFC822 Message-ID (or gmail:<id> fallback) — the dedup key. */
  rfcMessageId: string;
  from: string | null;
  subject: string | null;
  /** Plain-text body (or crude HTML→text) as produced by gmail-ingestion. */
  body: string;
  headers: Array<{ name: string; value: string }>;
  /** Gmail internalDate (ms since epoch, as a string) or null. */
  internalDate: string | null;
}

export interface ParsedWisePayment {
  payerName: string | null;
  amount: number;
  currency: string;
  fee: number | null;
  amountCredited: number | null;
  reference: string | null;
  transferNumber: string | null;
}

export interface IncomingCandidate {
  job_id: string;
  hh_job_number: number;
  job_name: string | null;
  client_name: string | null;
  /** How this job came up: job_number · hh_invoice · payer_name */
  via: string;
  /** Figures the amount was compared against (for the resolve UI / email). */
  expected?: { deposit: number; half: number; remaining: number; excess: number };
}

// ── Detection ──────────────────────────────────────────────────────────────

export function isWiseMoneyReceivedEmail(from: string | null, subject: string | null): boolean {
  if (!from || !subject) return false;
  if (!from.toLowerCase().includes(WISE_SENDER)) return false;
  return /^\s*money received from\b/i.test(subject);
}

/**
 * Gmail writes the result of its own DKIM check into `Authentication-Results`
 * (and `ARC-Authentication-Results`). Accept only a pass signed by wise.com.
 */
export function wiseDkimPasses(headers: Array<{ name: string; value: string }>): boolean {
  const re = /dkim=pass[^;]*header\.[id]=@?(?:[\w-]+\.)*wise\.com\b/i;
  return headers.some(h =>
    /^(arc-)?authentication-results$/i.test(h.name) && re.test(h.value),
  );
}

// ── Parsing ────────────────────────────────────────────────────────────────

function toNumber(s: string | undefined | null): number | null {
  if (!s) return null;
  const n = parseFloat(s.replace(/,/g, ''));
  return Number.isFinite(n) ? n : null;
}

/**
 * Parse the fields out of a "Money received" email. Tolerant of the table markers
 * and line breaks Gmail puts into the text part — everything is matched on a
 * whitespace-normalised copy. Returns null when the amount can't be found.
 *
 * Seen shapes (Oct 2026):
 *   "You received 463.32 GBP from Raygun Records Lim."
 *   "From: X Amount received: 2,275.20 GBP Reference: JOB 16325 Transfer Number: #2371061680"
 *   "Amount received: 2,346 GBP Fee: 2.16 GBP Amount paid into account: 2,343.84 GBP Reference: …"
 */
export function parseWiseMoneyReceived(body: string, subject: string | null): ParsedWisePayment | null {
  const text = (body || '').replace(/<[^>]+>/g, ' ').replace(/[|]/g, ' ').replace(/\s+/g, ' ').trim();

  const received = text.match(/Amount received:\s*([\d,]+(?:\.\d{1,2})?)\s*([A-Z]{3})/i)
    || text.match(/You received\s+([\d,]+(?:\.\d{1,2})?)\s+([A-Z]{3})\s+from/i);
  const amount = toNumber(received?.[1]);
  if (amount == null || amount <= 0) return null;
  const currency = (received?.[2] || 'GBP').toUpperCase();

  let payerName: string | null = null;
  const fromField = text.match(/\bFrom:\s*(.+?)\s+Amount received:/i);
  if (fromField) payerName = fromField[1].trim();
  if (!payerName) {
    const headline = text.match(/You received\s+[\d,.]+\s+[A-Z]{3}\s+from\s+(.+?)\.\s/i);
    if (headline) payerName = headline[1].trim();
  }
  if (!payerName && subject) {
    const s = subject.match(/money received from\s+(.+)$/i);
    if (s) payerName = s[1].trim();
  }

  const fee = toNumber(text.match(/\bFee:\s*([\d,]+(?:\.\d{1,2})?)\s*[A-Z]{3}/i)?.[1]);
  const credited = toNumber(text.match(/Amount paid into account:\s*([\d,]+(?:\.\d{1,2})?)/i)?.[1]);
  const reference = text.match(/\bReference:\s*(.*?)\s*(?:Transfer Number:|See how Wise|$)/i)?.[1]?.trim() || null;
  const transferNumber = text.match(/Transfer Number:\s*#?(\d+)/i)?.[1] || null;

  return {
    payerName: payerName ? payerName.replace(/\s+/g, ' ').slice(0, 200) : null,
    amount,
    currency,
    fee,
    amountCredited: credited,
    reference: reference ? reference.slice(0, 500) : null,
    transferNumber,
  };
}

// ── Matching ───────────────────────────────────────────────────────────────

function normaliseName(s: string | null | undefined): string {
  return (s || '')
    .toUpperCase()
    .replace(/\b(LTD|LIMITED|LLP|LLC|INC|PLC|T\/A|THE)\b/g, ' ')
    .replace(/[^A-Z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Job-number-looking tokens: 5-7 digits (HireHop will tip from 5 to 6 to 7 digits). */
function extractNumberTokens(reference: string | null): number[] {
  if (!reference) return [];
  const out = new Set<number>();
  for (const m of reference.matchAll(/\b(\d{5,7})\b/g)) out.add(parseInt(m[1], 10));
  return [...out];
}

/** "OT-INV-12345" → 12345 (HireHop invoice numbers). */
function extractHhInvoiceTokens(reference: string | null): number[] {
  if (!reference) return [];
  const out = new Set<number>();
  for (const m of reference.matchAll(/OT[\s-]*INV[\s-]*(\d{3,7})/gi)) out.add(parseInt(m[1], 10));
  return [...out];
}

function referenceHintsExcess(reference: string | null): boolean {
  return /\bexcess\b|\bxs\b|\binsurance\b/i.test(reference || '');
}

interface JobRow {
  id: string;
  hh_job_number: number;
  job_name: string | null;
  client_name: string | null;
  company_name: string | null;
  job_value: string | null;
  pipeline_status: string | null;
}

interface MoneyPosition {
  hireValueIncVat: number;
  depositsPaid: number;
  remaining: number;
  requiredDeposit: number;
  half: number;
  depositPaid: boolean;
  excessOutstanding: number;
  invoiceNumbers: string[];
}

/**
 * What this job expects: mirrors the portal's option maths (get-job-details-v2:
 * deposit = max(25%, £100), full when under £400; half = round(50%)) and the
 * briefing's excess outstanding (required − taken over the job's job_excess rows).
 * Hire value inc VAT comes from job_financials (VAT-adjusted, refreshed nightly and
 * on every Money-tab open) with jobs.job_value × 1.2 as the fallback; deposits are
 * read live from HireHop so this morning's card payment is already counted.
 */
async function getMoneyPosition(job: JobRow): Promise<MoneyPosition> {
  const fin = await query(
    `SELECT hire_value_inc_vat FROM job_financials WHERE job_id = $1`,
    [job.id],
  );
  let hireValueIncVat = parseFloat(fin.rows[0]?.hire_value_inc_vat ?? '') || 0;
  if (!hireValueIncVat) hireValueIncVat = (parseFloat(job.job_value || '') || 0) * 1.2;

  let depositsPaid = 0;
  const invoiceNumbers: string[] = [];
  const billing = await hhBroker.get<any>(
    '/php_functions/billing_list.php',
    { main_id: job.hh_job_number, type: 1 },
    { priority: 'low', cacheTTL: 60 },
  );
  if (billing.success && billing.data && Array.isArray((billing.data as any).rows)) {
    for (const row of (billing.data as any).rows) {
      const kind = parseInt(row.kind ?? '0');
      const data = row.data || {};
      if (kind === 1) {
        const num = String(data.NUMBER || row.number || '').trim();
        if (num) invoiceNumbers.push(num);
        continue;
      }
      if (kind !== 6) continue;
      const credit = parseFloat(row.credit || data.credit || '0');
      if (credit <= 0) continue;
      const text = `${data.DESCRIPTION || row.desc || ''} ${data.MEMO || ''}`.toLowerCase();
      if (/\bexcess\b|\binsurance\b|\bxs\b|\btop[- ]?up\b/.test(text)) continue;
      depositsPaid += credit;
    }
  }

  const ex = await query(
    `SELECT je.excess_amount_required, je.excess_amount_taken, je.excess_status
       FROM job_excess je
       LEFT JOIN vehicle_hire_assignments vha ON vha.id = je.assignment_id
      WHERE (je.job_id = $1 OR vha.job_id = $1)
        AND je.excess_status NOT IN ('reimbursed', 'fully_claimed', 'rolled_over', 'not_required', 'released', 'waived')`,
    [job.id],
  );
  let excessRequired = 0;
  let excessTaken = 0;
  for (const r of ex.rows) {
    excessRequired += parseFloat(r.excess_amount_required) || 0;
    excessTaken += parseFloat(r.excess_amount_taken) || 0;
  }

  const remaining = Math.max(0, hireValueIncVat - depositsPaid);
  let requiredDeposit = Math.max(hireValueIncVat * 0.25, 100);
  if (hireValueIncVat < 400) requiredDeposit = hireValueIncVat;
  const depositPaid = depositsPaid >= requiredDeposit - 5; // portal's £5 tolerance
  return {
    hireValueIncVat,
    depositsPaid,
    remaining,
    requiredDeposit: Math.min(requiredDeposit, remaining),
    half: Math.round(hireValueIncVat * 0.5),
    depositPaid,
    excessOutstanding: Math.max(0, excessRequired - excessTaken),
    invoiceNumbers,
  };
}

const JOB_COLS = `id, hh_job_number, job_name, client_name, company_name, job_value, pipeline_status`;

async function jobsByHhNumbers(numbers: number[]): Promise<JobRow[]> {
  if (numbers.length === 0) return [];
  const r = await query(`SELECT ${JOB_COLS} FROM jobs WHERE hh_job_number = ANY($1::int[])`, [numbers]);
  return r.rows as JobRow[];
}

/** Tier 2: find recent jobs whose HireHop billing carries one of these invoice numbers. */
async function jobsByHhInvoiceNumbers(invoiceNumbers: number[]): Promise<JobRow[]> {
  if (invoiceNumbers.length === 0) return [];
  const pool = await query(
    `SELECT ${JOB_COLS} FROM jobs
      WHERE hh_job_number IS NOT NULL
        AND (pipeline_status IS NULL OR pipeline_status NOT IN ('cancelled', 'lost'))
        AND (job_end IS NULL OR job_end >= NOW() - INTERVAL '120 days')
      ORDER BY job_date DESC NULLS LAST
      LIMIT $1`,
    [INVOICE_SEARCH_POOL],
  );
  const wanted = new Set(invoiceNumbers.map(n => String(n)));
  const hits: JobRow[] = [];
  for (const job of pool.rows as JobRow[]) {
    try {
      const billing = await hhBroker.get<any>(
        '/php_functions/billing_list.php',
        { main_id: job.hh_job_number, type: 1 },
        { priority: 'low', cacheTTL: 600 },
      );
      const rows = billing.success ? ((billing.data as any)?.rows || []) : [];
      for (const row of rows) {
        if (parseInt(row.kind ?? '0') !== 1) continue;
        const num = String(row.data?.NUMBER || row.number || '');
        const digits = num.replace(/\D/g, '').replace(/^0+/, '');
        if (digits && wanted.has(digits)) { hits.push(job); break; }
      }
    } catch (err) {
      console.warn(`[wise-incoming] billing read failed for HH#${job.hh_job_number}:`, err);
    }
  }
  return hits;
}

/** Tier 4 (evidence only): jobs with money outstanding whose client/company resembles the payer. */
async function jobsByPayerName(payerName: string | null): Promise<JobRow[]> {
  const needle = normaliseName(payerName);
  if (needle.length < 4) return [];
  const r = await query(
    `SELECT ${JOB_COLS} FROM jobs j
      WHERE j.hh_job_number IS NOT NULL
        AND (j.pipeline_status IS NULL OR j.pipeline_status NOT IN ('cancelled', 'lost', 'completed'))
        AND (j.job_end IS NULL OR j.job_end >= NOW() - INTERVAL '60 days')
      ORDER BY j.job_date DESC NULLS LAST
      LIMIT 400`,
  );
  return (r.rows as JobRow[]).filter(j => {
    const a = normaliseName(j.client_name);
    const b = normaliseName(j.company_name);
    return (a && (a.includes(needle) || needle.includes(a))) || (b && (b.includes(needle) || needle.includes(b)));
  }).slice(0, 8);
}

async function ignoredPayers(): Promise<string[]> {
  const raw = await getSystemSetting('wise_ignore_payers');
  const list = raw && raw.trim() ? raw.split(',') : DEFAULT_IGNORE_PAYERS;
  return list.map(normaliseName).filter(Boolean);
}

export interface MatchOutcome {
  kind: 'ignored' | 'confident' | 'unmatched';
  method: string;
  notes: string;
  candidates: IncomingCandidate[];
  /** Set for a confident match. */
  job?: JobRow;
  paymentType?: RecordPaymentType;
}

function near(a: number, b: number): boolean {
  return b > 0 && Math.abs(a - b) <= AMOUNT_TOLERANCE + 1e-9;
}

export async function matchIncomingPayment(p: {
  payerName: string | null; amount: number; currency: string; reference: string | null;
}): Promise<MatchOutcome> {
  if (p.currency !== 'GBP') {
    return { kind: 'unmatched', method: 'non_gbp', notes: `Received in ${p.currency} — convert in Wise and record the GBP figure by hand (jon's practice).`, candidates: [] };
  }
  const ignore = await ignoredPayers();
  const payerNorm = normaliseName(p.payerName);
  if (payerNorm && ignore.some(x => x === payerNorm)) {
    return { kind: 'ignored', method: 'ignored_payer', notes: `Payer "${p.payerName}" is on the ignore list (own transfer in).`, candidates: [] };
  }

  const notes: string[] = [];
  let candidates: IncomingCandidate[] = [];
  const seen = new Set<string>();
  const add = (jobs: JobRow[], via: string) => {
    for (const j of jobs) {
      if (seen.has(j.id)) continue;
      seen.add(j.id);
      candidates.push({ job_id: j.id, hh_job_number: j.hh_job_number, job_name: j.job_name, client_name: j.client_name || j.company_name, via });
    }
  };

  // Tier 1 — job number in the reference
  const numberTokens = extractNumberTokens(p.reference);
  const invoiceTokens = extractHhInvoiceTokens(p.reference);
  const byJobNumber = await jobsByHhNumbers(numberTokens.filter(n => !invoiceTokens.includes(n)));
  add(byJobNumber, 'job_number');
  if (byJobNumber.length > 0) notes.push(`job number in reference: ${byJobNumber.map(j => j.hh_job_number).join(', ')}`);

  // Tier 2 — HireHop invoice number (explicit OT-INV-…, or bare digits when nothing else hit)
  if (candidates.length === 0) {
    const invTokens = invoiceTokens.length > 0 ? invoiceTokens : numberTokens;
    if (invTokens.length > 0) {
      const byInvoice = await jobsByHhInvoiceNumbers(invTokens);
      add(byInvoice, 'hh_invoice');
      if (byInvoice.length > 0) notes.push(`HireHop invoice number in reference`);
    }
  }

  // Tier 4 — payer name, evidence only
  const byPayer = await jobsByPayerName(p.payerName);
  const strongCandidates = [...candidates];
  if (byPayer.length > 0) {
    add(byPayer, 'payer_name');
    notes.push(`payer name resembles ${byPayer.length} job(s)`);
  }

  // Attach expected figures to every candidate (cheap: a few HH reads, cached)
  const jobById = new Map<string, JobRow>();
  for (const j of [...byJobNumber, ...byPayer]) jobById.set(j.id, j);
  for (const c of candidates) {
    let job = jobById.get(c.job_id);
    if (!job) {
      const r = await query(`SELECT ${JOB_COLS} FROM jobs WHERE id = $1`, [c.job_id]);
      job = r.rows[0] as JobRow | undefined;
      if (job) jobById.set(job.id, job);
    }
    if (!job) continue;
    try {
      const pos = await getMoneyPosition(job);
      c.expected = { deposit: round2(pos.requiredDeposit), half: round2(pos.half), remaining: round2(pos.remaining), excess: round2(pos.excessOutstanding) };
      c.via += pos.depositPaid ? '' : '';
      (c as any)._depositPaid = pos.depositPaid;
    } catch (err) {
      console.warn(`[wise-incoming] money position failed for HH#${c.hh_job_number}:`, err);
    }
  }

  // Confident only on ONE strong candidate whose figures explain the amount
  if (strongCandidates.length === 1 && strongCandidates[0].expected) {
    const c = strongCandidates[0];
    const e = c.expected!;
    const hireHit = near(p.amount, e.deposit) || near(p.amount, e.half) || near(p.amount, e.remaining);
    const excessHit = near(p.amount, e.excess);
    const hint = referenceHintsExcess(p.reference);
    let paymentType: RecordPaymentType | null = null;
    if (hireHit && excessHit) paymentType = hint ? 'excess' : null; // ambiguous unless the reference says excess
    else if (excessHit) paymentType = 'excess';
    else if (hireHit) paymentType = hint ? null : ((c as any)._depositPaid ? 'balance' : 'deposit');
    if (paymentType) {
      return {
        kind: 'confident',
        method: c.via,
        notes: `${notes.join('; ')}; £${p.amount.toFixed(2)} matches ${paymentType === 'excess' ? 'the excess outstanding' : 'a hire figure'} on HH#${c.hh_job_number}`,
        candidates,
        job: jobById.get(c.job_id)!,
        paymentType,
      };
    }
    notes.push(`amount £${p.amount.toFixed(2)} does not equal deposit £${e.deposit}, half £${e.half}, remaining £${e.remaining} or excess £${e.excess}`);
  } else if (strongCandidates.length > 1) {
    notes.push('more than one job referenced');
  } else if (strongCandidates.length === 0) {
    notes.push('no job or invoice number in the reference');
  }

  // Strip the private marker before persisting
  for (const c of candidates) delete (c as any)._depositPaid;
  return { kind: 'unmatched', method: strongCandidates.length > 0 ? 'amount_mismatch' : 'no_reference', notes: notes.join('; '), candidates };
}

function round2(n: number): number { return Math.round(n * 100) / 100; }

// ── Recording ──────────────────────────────────────────────────────────────

function wisePaymentReference(row: { transfer_number: string | null; reference: string | null }): string {
  const parts = [row.transfer_number ? `Wise #${row.transfer_number}` : 'Wise', row.reference || ''].filter(Boolean);
  return parts.join(' - ').slice(0, 255);
}

/**
 * Record an incoming payment on a job through the shared record-payment path and
 * stamp the row. Used by the automatic matcher and by the resolve endpoint.
 */
export async function recordIncomingPaymentOnJob(opts: {
  incomingId: string;
  jobId: string;
  paymentType: RecordPaymentType;
  amount?: number;
  actorUserId: string | null;
  matchMethod: string;
  matchNotes: string;
}): Promise<{ ok: boolean; error?: string; hh_push_error?: string | null }> {
  const rowRes = await query(`SELECT * FROM incoming_bank_payments WHERE id = $1`, [opts.incomingId]);
  const row = rowRes.rows[0];
  if (!row) return { ok: false, error: 'Incoming payment not found' };
  if (row.status === 'recorded') return { ok: false, error: 'Already recorded' };

  const amount = opts.amount ?? parseFloat(row.amount);
  const result = await recordPayment(
    opts.jobId,
    {
      payment_type: opts.paymentType,
      amount,
      payment_method: 'wise_bacs',
      payment_reference: wisePaymentReference(row),
      notes: opts.actorUserId ? 'Recorded from the Wise incoming-payments queue' : 'Recorded automatically from the Wise "Money received" email',
      push_to_hirehop: true,
    },
    { userId: opts.actorUserId || SYSTEM_SERVICE_USER_ID, isServiceAccount: !opts.actorUserId },
  );
  if (result.status !== 200) {
    const msg = result.body?.error || `record-payment returned ${result.status}`;
    await query(
      `UPDATE incoming_bank_payments SET match_method = $2, match_notes = $3 WHERE id = $1`,
      [opts.incomingId, opts.matchMethod, `${opts.matchNotes}; recording failed: ${msg}`],
    );
    return { ok: false, error: msg };
  }
  const payment = result.body?.data || {};
  await query(
    `UPDATE incoming_bank_payments
        SET status = 'recorded', matched_job_id = $2, payment_type = $3, job_payment_id = $4,
            hh_deposit_id = $5, hh_push_error = $6, match_method = $7, match_notes = $8,
            resolved_by = $9, resolved_at = NOW()
      WHERE id = $1`,
    [opts.incomingId, opts.jobId, opts.paymentType, payment.id || null, payment.hirehop_deposit_id || null,
     result.body?.hh_push_error || null, opts.matchMethod, opts.matchNotes, opts.actorUserId],
  );
  return { ok: true, hh_push_error: result.body?.hh_push_error || null };
}

export async function ignoreIncomingPayment(incomingId: string, actorUserId: string, note: string): Promise<void> {
  await query(
    `UPDATE incoming_bank_payments
        SET status = 'ignored', match_notes = $3, resolved_by = $2, resolved_at = NOW()
      WHERE id = $1 AND status <> 'recorded'`,
    [incomingId, actorUserId, note],
  );
}

// ── Alert email ────────────────────────────────────────────────────────────

function esc(s: unknown): string {
  return String(s ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch] as string));
}

async function alertRecipient(): Promise<string> {
  const configured = await getSystemSetting('wise_alert_email');
  return (configured || '').trim() || 'info@oooshtours.co.uk';
}

/** One email per unmatched payment, to info@ (or system_settings.wise_alert_email). */
export async function sendUnmatchedIncomingAlert(incomingId: string): Promise<void> {
  const r = await query(`SELECT * FROM incoming_bank_payments WHERE id = $1`, [incomingId]);
  const row = r.rows[0];
  if (!row || row.alert_sent_at) return;
  const amount = parseFloat(row.amount);
  const link = frontendLink(`/money?incoming=${row.id}`);
  const candidates: IncomingCandidate[] = Array.isArray(row.candidates) ? row.candidates : [];
  const candidateHtml = candidates.length
    ? `<p><strong>Possible jobs:</strong></p><ul>${candidates.map(c =>
        `<li>#${esc(c.hh_job_number)} ${esc(c.job_name || '')} — ${esc(c.client_name || '')} <em>(${esc(c.via.replace('_', ' '))})</em>${
          c.expected ? ` — expects deposit £${c.expected.deposit.toFixed(2)}, half £${c.expected.half.toFixed(2)}, remaining £${c.expected.remaining.toFixed(2)}, excess £${c.expected.excess.toFixed(2)}` : ''
        }</li>`).join('')}</ul>`
    : `<p>No job could be found from the reference or the payer name.</p>`;
  const html = `
    <p>A bank transfer has arrived in Wise that OP could not match to a job on its own.</p>
    <table cellpadding="4" style="border-collapse:collapse">
      <tr><td><strong>From</strong></td><td>${esc(row.payer_name || 'unknown')}</td></tr>
      <tr><td><strong>Amount sent</strong></td><td>£${amount.toFixed(2)}${row.fee ? ` (fee £${parseFloat(row.fee).toFixed(2)}, £${parseFloat(row.amount_credited || row.amount).toFixed(2)} landed)` : ''}</td></tr>
      <tr><td><strong>Reference</strong></td><td>${esc(row.reference || '(none)')}</td></tr>
      <tr><td><strong>Transfer</strong></td><td>${esc(row.transfer_number ? `#${row.transfer_number}` : '')}</td></tr>
      <tr><td><strong>Received</strong></td><td>${new Date(row.received_at).toLocaleString('en-GB')}</td></tr>
      <tr><td><strong>Why unmatched</strong></td><td>${esc(row.match_notes || '')}</td></tr>
    </table>
    ${candidateHtml}
    <p><a href="${esc(link)}">Match it to a job in OP</a> — pick the job and whether it is hire money or the excess, and OP records it, creates the HireHop deposit and emails the client.</p>
  `;
  const subjectRef = row.reference ? ` (ref "${String(row.reference).slice(0, 40)}")` : '';
  const res = await emailService.sendRaw({
    to: await alertRecipient(),
    subject: `Wise payment needs matching: £${amount.toFixed(2)} from ${row.payer_name || 'unknown'}${subjectRef}`,
    html,
    variant: 'internal',
  });
  if (res.success) {
    await query(`UPDATE incoming_bank_payments SET alert_sent_at = NOW() WHERE id = $1`, [row.id]);
  } else {
    console.error(`[wise-incoming] alert email failed for ${row.id}: ${res.error || 'unknown'}`);
  }
}

async function sendHhPushFailedAlert(incomingId: string, hhPushError: string): Promise<void> {
  const r = await query(
    `SELECT i.*, j.hh_job_number AS job_hh FROM incoming_bank_payments i LEFT JOIN jobs j ON j.id = i.matched_job_id WHERE i.id = $1`,
    [incomingId],
  );
  const row = r.rows[0];
  if (!row) return;
  await emailService.sendRaw({
    to: await alertRecipient(),
    subject: `Wise payment recorded in OP but HireHop push failed: £${parseFloat(row.amount).toFixed(2)} on job ${row.job_hh}`,
    html: `<p>OP matched a Wise transfer of £${parseFloat(row.amount).toFixed(2)} from ${esc(row.payer_name)} to job #${esc(row.job_hh)} and recorded it, but the HireHop deposit push failed:</p>
           <p><code>${esc(hhPushError)}</code></p>
           <p>Use <strong>Link HH Deposit</strong> on the job's Money tab once the deposit exists in HireHop, or retry from there.</p>`,
    variant: 'internal',
  }).catch(err => console.error('[wise-incoming] HH-push-failed alert failed:', err));
}

// ── Entry point from the Gmail ingestion loop ──────────────────────────────

/**
 * Handle one Wise "Money received" email: verify, parse, store, match, and either
 * record it or queue it with an alert. Idempotent on the RFC822 Message-ID.
 * Never throws — a failure here must not stall the mailbox batch.
 */
export async function handleWiseEmail(input: WiseEmailInput): Promise<'stored' | 'duplicate' | 'rejected' | 'unparsed'> {
  try {
    if (!wiseDkimPasses(input.headers)) {
      console.warn(`[wise-incoming] DKIM check failed for "${input.subject}" (${input.rfcMessageId}) — rejected`);
      return 'rejected';
    }
    const dupe = await query(`SELECT 1 FROM incoming_bank_payments WHERE gmail_message_id = $1`, [input.rfcMessageId]);
    if (dupe.rows.length > 0) return 'duplicate';

    const parsed = parseWiseMoneyReceived(input.body, input.subject);
    const receivedAt = input.internalDate ? new Date(parseInt(input.internalDate, 10)) : new Date();

    if (!parsed) {
      // Template changed? Store what we can so it is visible, and alert — the
      // failure mode must be loud, not a silent fall back to the old manual process.
      const ins = await query(
        `INSERT INTO incoming_bank_payments
           (gmail_message_id, mailbox, received_at, payer_name, amount, currency, reference, email_subject, status, match_method, match_notes)
         VALUES ($1, $2, $3, $4, 0, 'GBP', NULL, $5, 'unmatched', 'unparsed', $6)
         ON CONFLICT (gmail_message_id) DO NOTHING RETURNING id`,
        [input.rfcMessageId, input.mailbox, receivedAt, (input.subject || '').replace(/^money received from\s*/i, '').slice(0, 200), input.subject,
         'Could not read the amount from the Wise email — the email template may have changed. Open the email in the mailbox and record the payment by hand.'],
      );
      if (ins.rows[0]) await sendUnmatchedIncomingAlert(ins.rows[0].id);
      return 'unparsed';
    }

    const ins = await query(
      `INSERT INTO incoming_bank_payments
         (gmail_message_id, mailbox, received_at, payer_name, amount, currency, fee, amount_credited, reference, transfer_number, email_subject)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       ON CONFLICT (gmail_message_id) DO NOTHING RETURNING id`,
      [input.rfcMessageId, input.mailbox, receivedAt, parsed.payerName, parsed.amount, parsed.currency, parsed.fee,
       parsed.amountCredited, parsed.reference, parsed.transferNumber, input.subject],
    );
    const id: string | undefined = ins.rows[0]?.id;
    if (!id) return 'duplicate';

    const outcome = await matchIncomingPayment(parsed);
    await query(
      `UPDATE incoming_bank_payments SET match_method = $2, match_notes = $3, candidates = $4 WHERE id = $1`,
      [id, outcome.method, outcome.notes, JSON.stringify(outcome.candidates)],
    );

    if (outcome.kind === 'ignored') {
      await query(`UPDATE incoming_bank_payments SET status = 'ignored', resolved_at = NOW() WHERE id = $1`, [id]);
      console.log(`[wise-incoming] ignored £${parsed.amount} from ${parsed.payerName}: ${outcome.notes}`);
      return 'stored';
    }

    if (outcome.kind === 'confident' && outcome.job && outcome.paymentType) {
      const rec = await recordIncomingPaymentOnJob({
        incomingId: id, jobId: outcome.job.id, paymentType: outcome.paymentType,
        actorUserId: null, matchMethod: outcome.method, matchNotes: outcome.notes,
      });
      if (rec.ok) {
        console.log(`[wise-incoming] recorded £${parsed.amount} from ${parsed.payerName} as ${outcome.paymentType} on HH#${outcome.job.hh_job_number}`);
        if (rec.hh_push_error) await sendHhPushFailedAlert(id, rec.hh_push_error);
        return 'stored';
      }
      // Recording failed → fall through to the queue + alert so a human picks it up
      console.error(`[wise-incoming] auto-record failed for ${id}: ${rec.error}`);
    }

    await sendUnmatchedIncomingAlert(id);
    return 'stored';
  } catch (err) {
    console.error(`[wise-incoming] failed to handle Wise email ${input.rfcMessageId}:`, err);
    return 'rejected';
  }
}
