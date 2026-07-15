/**
 * Quote-PDF versions — extract, diff, read (Auto-Chase §7.3)
 *
 * Sits on top of quote-harvest.ts: harvests-if-stale, lazily vision-extracts the
 * line items from each stored quote PDF (bounded to jobs someone opens — the
 * job_comms_summaries pattern), and diffs consecutive versions so staff see
 * exactly what changed between quotes ("5 Jun had 2×snare stand + 4×wedge; 7 Jun
 * has 2×snare stand + 3×wedge"). The email chain says what was DISCUSSED; the
 * PDF diff shows what was actually QUOTED. Cross-referenced by the dispute
 * helper (comms-query.ts).
 *
 * Surfaces on the Activity Timeline (not the Money tab — money's about money,
 * things belong with the comms). Quote PDFs never enter jobs.files.
 */
import { query } from '../config/database';
import { getFromR2 } from '../config/r2';
import { isAnthropicConfigured } from '../config/anthropic';
import { extractDocument } from './document-extract';
import { harvestQuotesForJob, shouldHarvest } from './quote-harvest';
import { isGmailConfigured } from '../config/gmail';

// Cap how many un-extracted versions we vision-extract in one read, so a first
// view of a job with a long quote history doesn't block for too long — the rest
// extract on the next view.
const EXTRACT_PER_CALL = 12;

export interface QuoteLineItem {
  description: string;
  qty: number | null;
  unit_price: number | null;
  discount: number | null;
  price: number | null;
}
interface QuoteExtract {
  items: QuoteLineItem[];
  quote_total: number | null;
}

const EXTRACT_SYSTEM_PROMPT = `You read a single-page (or multi-page) Ooosh Tours quote PDF and return its line items. Ooosh is a music/event transport, backline and rehearsal hire company. The quote is a table with columns: Qty, Description, Unit Price, Discount, Price (line total).

Return every billable line item in the quote's line-item table, in the order they appear.

For each item:
- description: the item description exactly as written (e.g. "4' x 4' Litedeck", "Premium LWB Splitter Van", "Snare stand").
- qty: the quantity as a number (e.g. 2). Null if not shown.
- unit_price: the per-unit price as a number in GBP, no currency symbol (e.g. 25.00). Null if not shown.
- discount: the discount as a number if shown (percent or amount as printed). Null if none.
- price: the line total (right-most Price column) as a number in GBP. Null if not shown.
- quote_total: the overall quote total as a number in GBP, if a total row is shown. Null otherwise.

RULES:
- Only real line items — skip header rows, section titles, blank rows, and the totals/subtotal/VAT rows (capture the grand total in quote_total instead).
- Numbers only for numeric fields — strip "£", commas, and any trailing text.
- Do not invent items or quantities. If a value isn't legible, use null.

Return ONLY the tool call.`;

const EXTRACT_SCHEMA = {
  type: 'object' as const,
  properties: {
    items: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          description: { type: 'string' },
          qty: { type: ['number', 'null'] },
          unit_price: { type: ['number', 'null'] },
          discount: { type: ['number', 'null'] },
          price: { type: ['number', 'null'] },
        },
        required: ['description', 'qty', 'unit_price', 'discount', 'price'],
        additionalProperties: false,
      },
    },
    quote_total: { type: ['number', 'null'] },
  },
  required: ['items', 'quote_total'],
  additionalProperties: false,
};

interface VersionRow {
  id: string;
  received_at: string;
  filename: string | null;
  r2_key: string;
  items: QuoteExtract | null;
  extracted_at: string | null;
}

async function loadVersionRows(jobId: string): Promise<VersionRow[]> {
  const r = await query(
    `SELECT id, received_at, filename, r2_key, items, extracted_at
       FROM job_quote_versions
      WHERE job_id = $1
      ORDER BY received_at ASC, created_at ASC`,
    [jobId],
  );
  return r.rows as VersionRow[];
}

/** Read the PDF bytes for a stored version out of R2. */
async function readVersionPdf(r2Key: string): Promise<Buffer> {
  const object = await getFromR2(r2Key);
  if (!object.Body) throw new Error(`Quote PDF missing in R2: ${r2Key}`);
  // AWS SDK v3 stream → bytes.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const arr = await (object.Body as any).transformToByteArray();
  return Buffer.from(arr);
}

/** Vision-extract one version's line items and persist them. */
export async function extractQuoteVersion(versionId: string): Promise<QuoteExtract | null> {
  if (!isAnthropicConfigured()) return null;
  const r = await query(`SELECT r2_key FROM job_quote_versions WHERE id = $1`, [versionId]);
  const key = r.rows[0]?.r2_key;
  if (!key) return null;
  const bytes = await readVersionPdf(key);
  const extracted = await extractDocument<QuoteExtract>({
    files: { buffer: bytes, mimeType: 'application/pdf' },
    systemPrompt: EXTRACT_SYSTEM_PROMPT,
    schema: EXTRACT_SCHEMA,
    userInstruction: 'Extract the line items from this quote PDF.',
    logTag: 'quote-extract',
  });
  await query(
    `UPDATE job_quote_versions SET items = $2, extracted_at = NOW() WHERE id = $1`,
    [versionId, JSON.stringify(extracted)],
  );
  return extracted;
}

// ── Diffing ─────────────────────────────────────────────────────────────────
function normDesc(s: string): string {
  return String(s || '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/[.,;:]+$/, '')
    .trim();
}
function numEq(a: number | null, b: number | null): boolean {
  if (a == null && b == null) return true;
  if (a == null || b == null) return false;
  return Math.abs(a - b) < 0.005;
}

export type QuoteDiffKind = 'added' | 'removed' | 'qty' | 'price';
export interface QuoteDiffLine {
  description: string;
  kind: QuoteDiffKind;
  from?: { qty: number | null; price: number | null };
  to?: { qty: number | null; price: number | null };
}
export interface QuoteVersionDiff {
  fromId: string;
  toId: string;
  fromDate: string;
  toDate: string;
  lines: QuoteDiffLine[];
}

/** Diff two extracted versions, matching line items by normalised description. */
function diffTwo(prev: VersionRow, curr: VersionRow): QuoteDiffLine[] {
  const pItems = prev.items?.items ?? [];
  const cItems = curr.items?.items ?? [];
  const pMap = new Map<string, QuoteLineItem>();
  const cMap = new Map<string, QuoteLineItem>();
  for (const it of pItems) pMap.set(normDesc(it.description), it);
  for (const it of cItems) cMap.set(normDesc(it.description), it);

  const lines: QuoteDiffLine[] = [];
  // Removed + changed (walk the previous version).
  for (const [key, p] of pMap) {
    const c = cMap.get(key);
    if (!c) {
      lines.push({ description: p.description, kind: 'removed', from: { qty: p.qty, price: p.price } });
    } else if (!numEq(p.qty, c.qty)) {
      lines.push({ description: c.description, kind: 'qty', from: { qty: p.qty, price: p.price }, to: { qty: c.qty, price: c.price } });
    } else if (!numEq(p.price, c.price)) {
      lines.push({ description: c.description, kind: 'price', from: { qty: p.qty, price: p.price }, to: { qty: c.qty, price: c.price } });
    }
  }
  // Added (in current, not previous).
  for (const [key, c] of cMap) {
    if (!pMap.has(key)) {
      lines.push({ description: c.description, kind: 'added', to: { qty: c.qty, price: c.price } });
    }
  }
  return lines;
}

export interface JobQuoteVersionsResult {
  available: boolean;
  configured: boolean; // Gmail + Anthropic both usable
  versions: Array<{
    id: string;
    receivedAt: string;
    filename: string | null;
    r2Key: string;
    quoteTotal: number | null;
    itemCount: number;
    extracted: boolean;
  }>;
  diffs: QuoteVersionDiff[];
}

/**
 * The read path for a job's quote versions. Harvests-if-stale (or forced),
 * lazily extracts un-extracted versions, and returns versions + consecutive
 * diffs. Never throws on a harvest/extract hiccup — returns what it has.
 */
export async function getJobQuoteVersions(
  jobId: string,
  opts: { forceHarvest?: boolean } = {},
): Promise<JobQuoteVersionsResult> {
  const configured = isGmailConfigured() && isAnthropicConfigured();

  // Harvest new PDFs if warranted (best-effort).
  if (isGmailConfigured()) {
    try {
      if (opts.forceHarvest || (await shouldHarvest(jobId))) {
        await harvestQuotesForJob(jobId);
      }
    } catch (err) {
      console.error('[quote-versions] harvest failed:', err);
    }
  }

  let rows = await loadVersionRows(jobId);

  // Lazily extract any un-extracted versions (bounded per call).
  if (isAnthropicConfigured()) {
    const pending = rows.filter((r) => !r.items).slice(0, EXTRACT_PER_CALL);
    for (const row of pending) {
      try {
        await extractQuoteVersion(row.id);
      } catch (err) {
        console.error(`[quote-versions] extract ${row.id} failed:`, err);
      }
    }
    if (pending.length) rows = await loadVersionRows(jobId);
  }

  const versions = rows.map((r) => ({
    id: r.id,
    receivedAt: new Date(r.received_at).toISOString(),
    filename: r.filename,
    r2Key: r.r2_key,
    quoteTotal: r.items?.quote_total ?? null,
    itemCount: r.items?.items?.length ?? 0,
    extracted: r.extracted_at != null,
  }));

  // Consecutive diffs, only between pairs where both sides are extracted.
  const diffs: QuoteVersionDiff[] = [];
  for (let i = 1; i < rows.length; i++) {
    const prev = rows[i - 1];
    const curr = rows[i];
    if (!prev.items || !curr.items) continue;
    diffs.push({
      fromId: prev.id,
      toId: curr.id,
      fromDate: new Date(prev.received_at).toISOString(),
      toDate: new Date(curr.received_at).toISOString(),
      lines: diffTwo(prev, curr),
    });
  }

  return { available: rows.length > 0, configured, versions, diffs };
}

/**
 * Grounding block for the dispute helper (comms-query.ts §7.2): a compact
 * text rendering of the quote versions + what changed between them. Null when a
 * job has no (extracted) quote versions.
 */
export async function buildQuoteVersionContext(jobId: string): Promise<string | null> {
  const rows = await loadVersionRows(jobId);
  const extracted = rows.filter((r) => r.items);
  if (extracted.length === 0) return null;

  const lines: string[] = [];
  lines.push('Quote PDF versions (from the emailed quotes — the physical trail of what was quoted, oldest first):');
  lines.push('"""');
  for (let i = 0; i < extracted.length; i++) {
    const r = extracted[i];
    const when = new Date(r.received_at).toISOString().slice(0, 16).replace('T', ' ');
    lines.push(`Quote version ${i + 1} — ${when}${r.items?.quote_total != null ? ` (total £${r.items.quote_total})` : ''}:`);
    for (const it of r.items?.items ?? []) {
      const qty = it.qty != null ? `${it.qty}× ` : '';
      const price = it.price != null ? ` — £${it.price}` : '';
      lines.push(`  ${qty}${it.description}${price}`);
    }
    if (i > 0) {
      const changed = diffTwo(extracted[i - 1], r);
      if (changed.length) {
        lines.push(`  Changes vs version ${i}:`);
        for (const c of changed) {
          if (c.kind === 'added') lines.push(`    + added ${c.to?.qty != null ? c.to.qty + '× ' : ''}${c.description}`);
          else if (c.kind === 'removed') lines.push(`    - removed ${c.from?.qty != null ? c.from.qty + '× ' : ''}${c.description}`);
          else if (c.kind === 'qty') lines.push(`    ~ ${c.description}: qty ${c.from?.qty} → ${c.to?.qty}`);
          else lines.push(`    ~ ${c.description}: price £${c.from?.price} → £${c.to?.price}`);
        }
      }
    }
    lines.push('');
  }
  lines.push('"""');
  return lines.join('\n').slice(0, 12000);
}

// ── Bulk cold-start sweep (optional) ────────────────────────────────────────
export interface QuoteSweepSummary {
  configured: boolean;
  jobsScanned: number;
  jobsWithQuotes: number;
  stored: number;
  error?: string;
}

/**
 * One-off harvest across the open pipeline so quote versions are populated
 * without waiting for each job's timeline to be opened. Harvest only (no
 * extraction — that stays lazy-on-view). Admin-triggered; runs in the background.
 */
export async function sweepQuoteVersions(
  opts: { limit?: number; sink?: QuoteSweepSummary } = {},
): Promise<QuoteSweepSummary> {
  const summary: QuoteSweepSummary = opts.sink ?? {
    configured: isGmailConfigured(),
    jobsScanned: 0,
    jobsWithQuotes: 0,
    stored: 0,
  };
  if (!isGmailConfigured()) return summary;

  const limit = Math.min(Math.max(opts.limit ?? 500, 1), 2000);
  const jobs = await query(
    `SELECT id FROM jobs
      WHERE is_deleted = false
        AND hh_job_number IS NOT NULL
        AND pipeline_status IN ('new_enquiry','quoting','paused','provisional','confirmed')
      ORDER BY updated_at DESC
      LIMIT $1`,
    [limit],
  );

  for (const row of jobs.rows) {
    try {
      const res = await harvestQuotesForJob(row.id);
      summary.jobsScanned++;
      if (res.versionsTotal > 0) summary.jobsWithQuotes++;
      summary.stored += res.stored;
    } catch (err) {
      console.error(`[quote-sweep] job ${row.id} failed:`, err);
    }
  }
  return summary;
}
