/**
 * Backline Matcher — backend for the AI equipment-matching tool.
 *
 * Replaces the standalone `alternative-hirehop-stock` Netlify app (Jun 2026).
 * Staff describe what a client asked for; Claude finds the closest alternatives
 * in our HireHop backline stock. Every search is logged to `backline_demand`
 * (replacing Monday board 2227909940) as purchasing intelligence.
 *
 * Endpoints (all STAFF_ROLES):
 *   POST /match            — the AI match. Body { request, jobNumber? }.
 *   GET  /stock            — raw backline stock (debug / future filtering).
 *   GET  /demand           — demand-tracker list (sortable/searchable).
 *   PATCH /demand/:id       — manual status / notes correction.
 *
 * Availability: when a HH job number is supplied, we check per-item availability
 * for the full backline list via the broker (chunked) and feed it into the
 * prompt so Claude prioritises what's actually free for the job dates. The
 * "do we have it" verdict stored on the demand row is Claude's per-search
 * snapshot — live truth happens here at search time, the table shows last-known.
 */
import { Router, Response } from 'express';
import { z } from 'zod';
import { query } from '../config/database';
import { authenticate, authorize, AuthRequest, STAFF_ROLES } from '../middleware/auth';
import { hhBroker } from '../services/hirehop-broker';
import { fetchBacklineStock } from '../services/backline-stock';
import { matchEquipment, MatcherResult } from '../services/backline-matcher';
import { isAnthropicConfigured } from '../config/anthropic';

const router = Router();
router.use(authenticate, authorize(...STAFF_ROLES));

// ── Helpers ──────────────────────────────────────────────────────────

/** Normalise a request string for the demand-tracker upsert key. */
function normaliseRequest(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^\w\s]/g, '')
    .replace(/\s+/g, ' ');
}

/** Map Claude's have_it verdict to the demand-tracker status value. */
function haveItStatus(verdict: MatcherResult['have_it']): 'yes' | 'no' | 'sort_of' {
  if (verdict === 'exact') return 'yes';
  if (verdict === 'variant') return 'sort_of';
  return 'no';
}

/**
 * Per-item availability for a job, via the broker (chunked, rate-limited,
 * cached). Returns a map of stock id → available qty. Best-effort: a failure
 * returns an empty map so the match still runs (just without availability).
 */
async function checkAvailability(
  stockIds: number[],
  jobNumber: string,
): Promise<Record<number, number>> {
  const result: Record<number, number> = {};
  const chunkSize = 50;
  try {
    for (let i = 0; i < stockIds.length; i += chunkSize) {
      const chunk = stockIds.slice(i, i + chunkSize);
      const itemsParam = JSON.stringify(chunk.map((id) => `b${id}`));
      const resp = await hhBroker.get<any>(
        '/php_functions/items_picklist_avail.php',
        { job: jobNumber, items: itemsParam },
        { priority: 'high', cacheTTL: 300 },
      );
      const data: any = resp.success ? resp.data : resp;
      if (data && typeof data === 'object') {
        for (const key of Object.keys(data)) {
          if (!key.startsWith('b')) continue;
          const id = parseInt(key.substring(1), 10);
          const val = data[key];
          const avail =
            val && typeof val === 'object' && val.available !== undefined
              ? Number(val.available)
              : Number(val);
          if (Number.isFinite(avail)) result[id] = avail;
        }
      }
    }
  } catch (err) {
    console.error('[Backline matcher] availability check failed:', err);
    return {};
  }
  return result;
}

/** Resolve a HH job number to dates + name for display + hire-days. */
async function lookupJob(jobNumber: string): Promise<{
  jobNumber: string;
  jobName: string;
  outDate: string | null;
  returnDate: string | null;
  hireDays: number;
} | null> {
  const r = await query(
    `SELECT hh_job_number, job_name, out_date, return_date, job_date, job_end
       FROM jobs WHERE hh_job_number = $1 LIMIT 1`,
    [parseInt(jobNumber, 10)],
  );
  if (r.rows.length === 0) return null;
  const j = r.rows[0];
  const out = j.out_date || j.job_date;
  const ret = j.return_date || j.job_end;
  let hireDays = 0;
  if (out && ret) {
    const diff = Math.ceil(
      Math.abs(new Date(ret).getTime() - new Date(out).getTime()) / 86400000,
    );
    hireDays = diff || 1;
  }
  const toDate = (d: any) => (d ? new Date(d).toISOString().substring(0, 10) : null);
  return {
    jobNumber,
    jobName: j.job_name || `Job ${jobNumber}`,
    outDate: toDate(out),
    returnDate: toDate(ret),
    hireDays,
  };
}

/** Upsert the demand-tracker row for this request. Fire-and-forget safe. */
async function logDemand(
  request: string,
  verdict: MatcherResult['have_it'],
  jobNumber: string | null,
  hireDays: number,
): Promise<void> {
  const normalised = normaliseRequest(request);
  if (!normalised) return;
  const status = haveItStatus(verdict);
  const jobRef = jobNumber ? [String(jobNumber)] : [];
  await query(
    `INSERT INTO backline_demand
       (normalised_request, display_request, request_count, total_hire_days,
        job_refs, have_it_status, source, first_requested_at, last_requested_at)
     VALUES ($1, $2, 1, $3, $4, $5, 'matcher', NOW(), NOW())
     ON CONFLICT (normalised_request) DO UPDATE SET
       request_count    = backline_demand.request_count + 1,
       total_hire_days  = backline_demand.total_hire_days + $3,
       job_refs         = (
         SELECT ARRAY(SELECT DISTINCT unnest(backline_demand.job_refs || $4::text[]))
       ),
       have_it_status   = $5,
       display_request  = $2,
       last_requested_at = NOW(),
       updated_at       = NOW()`,
    [normalised, request.trim(), hireDays, jobRef, status],
  );
}

// ── Routes ───────────────────────────────────────────────────────────

const matchSchema = z.object({
  request: z.string().min(1).max(500),
  jobNumber: z.union([z.string(), z.number()]).optional(),
});

router.post('/match', async (req: AuthRequest, res: Response) => {
  if (!isAnthropicConfigured()) {
    return res.status(503).json({
      success: false,
      error: 'AI matching is not configured (ANTHROPIC_API_KEY missing).',
    });
  }
  const parsed = matchSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ success: false, error: 'request (1-500 chars) required.' });
  }
  const { request } = parsed.data;
  const jobNumber =
    parsed.data.jobNumber != null && /^\d+$/.test(String(parsed.data.jobNumber))
      ? String(parsed.data.jobNumber)
      : null;

  try {
    const stock = await fetchBacklineStock();
    if (stock.length === 0) {
      return res.status(502).json({
        success: false,
        error: 'No backline stock returned from HireHop. Check directly.',
      });
    }

    // Job context + availability (best-effort).
    let job = null;
    let availability: Record<number, number> = {};
    if (jobNumber) {
      job = await lookupJob(jobNumber);
      availability = await checkAvailability(
        stock.map((s) => s.id),
        jobNumber,
      );
    }

    const result = await matchEquipment(request, stock, availability);

    // Annotate the shown alternatives with availability + a HireHop link.
    const stockById = new Map(stock.map((s) => [s.id, s]));
    const alternatives = result.alternatives.map((alt) => {
      const stockItem = alt.stock_id != null ? stockById.get(alt.stock_id) : undefined;
      return {
        ...alt,
        qty: alt.qty ?? stockItem?.quantity ?? null,
        available: alt.stock_id != null && availability[alt.stock_id] !== undefined
          ? availability[alt.stock_id]
          : null,
        imageUrl: stockItem?.imageUrl ?? null,
      };
    });

    // Log demand (await — serverless-style reliability is moot here, but it's cheap).
    try {
      await logDemand(request, result.have_it, jobNumber, job?.hireDays ?? 0);
    } catch (err) {
      console.error('[Backline matcher] demand log failed:', err);
    }

    return res.json({
      success: true,
      request,
      job,
      result: { ...result, alternatives },
      stockCount: stock.length,
      availabilityChecked: Object.keys(availability).length > 0,
    });
  } catch (err) {
    console.error('[Backline matcher] match error:', err);
    return res.status(500).json({
      success: false,
      error: 'Matching failed',
      details: String(err),
    });
  }
});

/** Raw backline stock — debug / future filtering. */
router.get('/stock', async (_req: AuthRequest, res: Response) => {
  try {
    const stock = await fetchBacklineStock();
    return res.json({ success: true, count: stock.length, items: stock });
  } catch (err) {
    console.error('[Backline matcher] stock error:', err);
    return res.status(502).json({ success: false, error: 'Failed to fetch stock', details: String(err) });
  }
});

/** Demand-tracker list. Sortable + searchable. */
router.get('/demand', async (req: AuthRequest, res: Response) => {
  const q = String(req.query.q || '').trim();
  // Click-to-sort whitelist: a `<field>_asc/_desc` pair per sortable column,
  // each with a stable `request_count DESC` tiebreaker so the LIMIT 500 picks a
  // deterministic top-500. Legacy keys (count/recent/days/name) kept for the
  // old dropdown-driven callers.
  const sortMap: Record<string, string> = {
    // legacy
    count: 'request_count DESC',
    recent: 'last_requested_at DESC',
    days: 'total_hire_days DESC',
    name: 'display_request ASC',
    // click-to-sort pairs
    name_asc: 'display_request ASC, request_count DESC',
    name_desc: 'display_request DESC, request_count DESC',
    request_count_asc: 'request_count ASC, last_requested_at DESC',
    request_count_desc: 'request_count DESC, last_requested_at DESC',
    hire_days_asc: 'total_hire_days ASC, request_count DESC',
    hire_days_desc: 'total_hire_days DESC, request_count DESC',
    have_it_asc: 'have_it_status ASC, request_count DESC',
    have_it_desc: 'have_it_status DESC, request_count DESC',
    last_asked_asc: 'last_requested_at ASC, request_count DESC',
    last_asked_desc: 'last_requested_at DESC, request_count DESC',
    // Priority sort: high → low, with unset (NULL) always last regardless of
    // direction, tiebroken by most-asked.
    priority_asc: "CASE priority WHEN 'high' THEN 1 WHEN 'medium' THEN 2 WHEN 'low' THEN 3 ELSE 4 END DESC, request_count DESC",
    priority_desc: "CASE priority WHEN 'high' THEN 1 WHEN 'medium' THEN 2 WHEN 'low' THEN 3 ELSE 4 END ASC, request_count DESC",
  };
  const orderBy = sortMap[String(req.query.sort || 'count')] || sortMap.count;
  const status = String(req.query.status || '').trim();
  const priorityFilter = String(req.query.priority || '').trim();
  const acquisitionFilter = String(req.query.acquisition || '').trim();

  const conditions: string[] = [];
  const params: any[] = [];
  if (q) {
    params.push(`%${q}%`);
    conditions.push(`display_request ILIKE $${params.length}`);
  }
  if (['yes', 'no', 'sort_of', 'used_to'].includes(status)) {
    params.push(status);
    conditions.push(`have_it_status = $${params.length}`);
  }
  if ((['high', 'medium', 'low'] as string[]).includes(priorityFilter)) {
    params.push(priorityFilter);
    conditions.push(`priority = $${params.length}`);
  }
  if ((['getting_soon', 'ordered', 'not_getting', 'none'] as string[]).includes(acquisitionFilter)) {
    params.push(acquisitionFilter);
    conditions.push(`acquisition_status = $${params.length}`);
  }
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

  try {
    const r = await query(
      `SELECT id, display_request, request_count, total_hire_days, job_refs,
              have_it_status, priority, acquisition_status, notes, source,
              first_requested_at, last_requested_at
         FROM backline_demand ${where}
        ORDER BY ${orderBy}
        LIMIT 500`,
      params,
    );
    return res.json({ success: true, count: r.rows.length, items: r.rows });
  } catch (err) {
    console.error('[Backline matcher] demand list error:', err);
    return res.status(500).json({ success: false, error: 'Failed to load demand' });
  }
});

/**
 * Ad-hoc manual add to the demand tracker — WITHOUT going through the AI
 * matcher. For "this got broken, we need a replacement" / "someone suggested we
 * stock this". Optionally links to job(s) (which double as the "needed by"
 * indicator) and carries a note. Dated by `last_requested_at = NOW()`.
 *
 * Merge-on-conflict (same key as the matcher): if the item is already tracked
 * we union in the job refs, refresh the date, append the note, and optionally
 * update the have-it status — but we do NOT bump request_count (that's the
 * genuine "matcher asks" signal) and we don't downgrade an existing row's
 * source from 'matcher' to 'manual'.
 */
const HAVE_IT_VALUES = ['yes', 'no', 'sort_of', 'used_to'] as const;
const PRIORITY_VALUES = ['high', 'medium', 'low'] as const;
const ACQUISITION_VALUES = ['none', 'getting_soon', 'ordered', 'not_getting'] as const;

const createDemandSchema = z.object({
  request: z.string().min(1).max(500),
  notes: z.string().max(1000).optional(),
  have_it_status: z.enum(HAVE_IT_VALUES).optional(),
  priority: z.enum(PRIORITY_VALUES).optional(),
  acquisition_status: z.enum(ACQUISITION_VALUES).optional(),
  jobNumbers: z.array(z.union([z.string(), z.number()])).optional(),
});

router.post('/demand', async (req: AuthRequest, res: Response) => {
  const parsed = createDemandSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ success: false, error: 'request (1-500 chars) required.' });
  }
  const { request, notes, have_it_status, priority } = parsed.data;
  const normalised = normaliseRequest(request);
  if (!normalised) {
    return res.status(400).json({ success: false, error: 'request must contain letters or numbers.' });
  }
  // Keep only digit-shaped job numbers, distinct.
  const jobRefs = Array.from(
    new Set(
      (parsed.data.jobNumbers || [])
        .map((n) => String(n).trim())
        .filter((n) => /^\d+$/.test(n)),
    ),
  );
  const note = notes?.trim() || null;
  // Treat acquisition 'none' as "not provided" so a merge never clobbers an
  // existing plan (e.g. 'ordered') with the default. The have-it=In-stock rule
  // (acquisition auto-clears to 'none') is applied in the CASE below.
  const acqParam =
    parsed.data.acquisition_status && parsed.data.acquisition_status !== 'none'
      ? parsed.data.acquisition_status
      : null;
  try {
    const r = await query(
      `INSERT INTO backline_demand
         (normalised_request, display_request, request_count, total_hire_days,
          job_refs, have_it_status, notes, source, priority, acquisition_status,
          first_requested_at, last_requested_at)
       VALUES ($1, $2, 1, 0, $3, COALESCE($4, 'no'), $5, 'manual', $6,
               CASE WHEN COALESCE($4, 'no') = 'yes' THEN 'none' ELSE COALESCE($7, 'none') END,
               NOW(), NOW())
       ON CONFLICT (normalised_request) DO UPDATE SET
         job_refs = (
           SELECT ARRAY(SELECT DISTINCT unnest(backline_demand.job_refs || $3::text[]))
         ),
         have_it_status = COALESCE($4, backline_demand.have_it_status),
         priority = COALESCE($6, backline_demand.priority),
         acquisition_status = CASE
           WHEN COALESCE($4, backline_demand.have_it_status) = 'yes' THEN 'none'
           ELSE COALESCE($7, backline_demand.acquisition_status)
         END,
         notes = CASE
                   WHEN $5::text IS NULL THEN backline_demand.notes
                   WHEN backline_demand.notes IS NULL OR backline_demand.notes = '' THEN $5
                   ELSE backline_demand.notes || E'\n' || $5
                 END,
         display_request = $2,
         last_requested_at = NOW(),
         updated_at = NOW()
       RETURNING id, (xmax = 0) AS inserted`,
      [normalised, request.trim(), jobRefs, have_it_status || null, note, priority || null, acqParam],
    );
    return res.json({
      success: true,
      id: r.rows[0].id,
      merged: !r.rows[0].inserted,
    });
  } catch (err) {
    console.error('[Backline matcher] demand create error:', err);
    return res.status(500).json({ success: false, error: 'Failed to add item' });
  }
});

/** Manual correction of a demand row's status / priority / plan / notes. */
const patchSchema = z.object({
  have_it_status: z.enum(HAVE_IT_VALUES).optional(),
  priority: z.enum(PRIORITY_VALUES).nullable().optional(),
  acquisition_status: z.enum(ACQUISITION_VALUES).optional(),
  notes: z.string().max(1000).nullable().optional(),
});

router.patch('/demand/:id', async (req: AuthRequest, res: Response) => {
  const parsed = patchSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ success: false, error: 'Invalid body' });
  }
  const sets: string[] = [];
  const params: any[] = [];
  if (parsed.data.have_it_status !== undefined) {
    params.push(parsed.data.have_it_status);
    sets.push(`have_it_status = $${params.length}`);
    // Flipping to In stock clears the acquisition plan — nothing left to get.
    if (parsed.data.have_it_status === 'yes' && parsed.data.acquisition_status === undefined) {
      sets.push(`acquisition_status = 'none'`);
    }
  }
  if (parsed.data.priority !== undefined) {
    params.push(parsed.data.priority); // may be null to clear
    sets.push(`priority = $${params.length}`);
  }
  if (parsed.data.acquisition_status !== undefined) {
    params.push(parsed.data.acquisition_status);
    sets.push(`acquisition_status = $${params.length}`);
  }
  if (parsed.data.notes !== undefined) {
    params.push(parsed.data.notes);
    sets.push(`notes = $${params.length}`);
  }
  if (sets.length === 0) {
    return res.status(400).json({ success: false, error: 'Nothing to update' });
  }
  params.push(req.params.id);
  try {
    const r = await query(
      `UPDATE backline_demand SET ${sets.join(', ')}, updated_at = NOW()
        WHERE id = $${params.length} RETURNING id`,
      params,
    );
    if (r.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Not found' });
    }
    return res.json({ success: true });
  } catch (err) {
    console.error('[Backline matcher] demand patch error:', err);
    return res.status(500).json({ success: false, error: 'Failed to update' });
  }
});

export default router;
