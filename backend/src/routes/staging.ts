/**
 * Staging Calculator — backend for the embedded staging tool.
 *
 * The calculator UI itself is the original vanilla-JS app, served statically from
 * frontend/public/staging-calculator.html and embedded in an iframe modal on Job
 * Detail. This route replaces the 4 Netlify functions it used to call
 * (ooosh-utilities) — repointed from /.netlify/functions/staging-* to /api/staging/*.
 *
 * Endpoints:
 *   GET    /stock                 — staging equipment from HireHop export (staff)
 *   GET    /job?job=<hh>          — job dates for date pre-fill (staff, reads OP jobs)
 *   POST   /availability          — date-based availability check via HireHop (staff)
 *   POST   /push                  — push parts to HH job + create a staging_plan + HH note (staff)
 *   GET    /plans/:jobId          — list staging plans for a job (staff; OP uuid or HH number)
 *   PATCH  /plans/:id             — toggle share_with_freelancer (staff)
 *   DELETE /plans/:id             — delete a staging plan (staff)
 *   GET    /plan/:slug            — PUBLIC: resolve stage config for the 3D viewer (short link)
 *
 * HireHop item-map prefixes (per save_job.php API docs — confirmed Jun 2026):
 *   a<id> = sales/consumable   ·   b<id> = hire/rental stock   ·   c<id> = labour
 * IDs are namespaced PER TABLE, so the same number means different things per
 * prefix: b740 = a Pioneer DJM900 (hire table), a740 = MagTape gaffa (sales
 * table). Consumables (gaffa tape #740, velcro tape #1013) are sales-table items,
 * NOT rental stock — pushing them as b<id> hit the unrelated hire item. The
 * calculator tags consumables `saleItem:true` and they go out as a<id>.
 * (The earlier s<id> guess was wrong — save_job.php silently ignored it.)
 */
import { Router, Request, Response } from 'express';
import { z } from 'zod';
import crypto from 'crypto';
import { query } from '../config/database';
import { authenticate, authorize, AuthRequest, STAFF_ROLES } from '../middleware/auth';
import { hhBroker } from '../services/hirehop-broker';
import { fetchStagingStock } from '../services/staging-stock';
import { frontendLink } from '../config/app-urls';

const router = Router();

// HireHop item-map prefix for sale/consumable stock (vs 'b' = hire). Per the
// save_job.php API docs: a=sales, b=hire, c=labour. See header note.
const SALE_ITEM_PREFIX = 'a';
const HIRE_ITEM_PREFIX = 'b';

// ════════════════════════════════════════════════════════════════════════
// PUBLIC — 3D viewer short-link resolver. MUST be before the staff auth gate.
// The stage-view.html viewer opens /stage-view.html?p=<slug>, fetches this to
// get the stage config, and renders. Clients open this link unauthenticated.
// ════════════════════════════════════════════════════════════════════════

router.get('/plan/:slug', async (req: Request, res: Response) => {
  try {
    const slug = String(req.params.slug);
    if (!/^[A-Za-z0-9_-]{4,40}$/.test(slug)) {
      return res.status(400).json({ success: false, error: 'Invalid link' });
    }
    const result = await query(
      `SELECT stage_config, summary FROM staging_plans WHERE slug = $1`,
      [slug],
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Stage preview not found' });
    }
    return res.json({ success: true, config: result.rows[0].stage_config, summary: result.rows[0].summary });
  } catch (err) {
    console.error('[Staging] plan resolve error:', err);
    return res.status(500).json({ success: false, error: 'Failed to load stage preview' });
  }
});

// ── Everything below is staff-only ──────────────────────────────────────
router.use(authenticate, authorize(...STAFF_ROLES));

/** Staging equipment stock from HireHop. */
router.get('/stock', async (_req: AuthRequest, res: Response) => {
  try {
    const { stock, rawCounts } = await fetchStagingStock();
    return res.json({ success: true, stock, rawCounts, timestamp: new Date().toISOString() });
  } catch (err) {
    console.error('[Staging] stock fetch error:', err);
    return res.status(502).json({ success: false, error: 'Failed to fetch stock from HireHop', details: String(err) });
  }
});

/** Job dates for the calculator's date pre-fill. Reads OP's jobs table (HH-synced). */
router.get('/job', async (req: AuthRequest, res: Response) => {
  const jobNum = String(req.query.job || '');
  if (!/^\d+$/.test(jobNum)) {
    return res.status(400).json({ success: false, error: 'Valid job number required.' });
  }
  try {
    const result = await query(
      `SELECT hh_job_number, job_name, job_date, job_end, status
         FROM jobs WHERE hh_job_number = $1 LIMIT 1`,
      [parseInt(jobNum, 10)],
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, error: `Job ${jobNum} not found in OP.` });
    }
    const j = result.rows[0];
    const toDate = (d: any) => (d ? new Date(d).toISOString().substring(0, 10) : null);
    return res.json({
      success: true,
      job: { id: j.hh_job_number, name: j.job_name || '', startDate: toDate(j.job_date), endDate: toDate(j.job_end), status: j.status },
    });
  } catch (err) {
    console.error('[Staging] job fetch error:', err);
    return res.status(500).json({ success: false, error: 'Failed to fetch job' });
  }
});

/** Date-based availability check via HireHop picklist_get_availability. */
const availabilitySchema = z.object({
  items: z.array(z.object({ id: z.union([z.number(), z.string()]) })).min(1).max(50),
  startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
});

router.post('/availability', async (req: AuthRequest, res: Response) => {
  const parsed = availabilitySchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ success: false, error: 'items (max 50) + startDate (YYYY-MM-DD) required.' });
  }
  const { items, startDate, endDate } = parsed.data;

  const rows = items.map((item) => ({ ID: item.id, TYPE: 2, ITEM_ID: 0, AVAILABLE: 1, STOCK: 1, GLOBAL: 1 }));

  try {
    const startMap = await callAvailability(rows, `${startDate} 09:00:00`);
    let endMap: Record<string, any> | null = null;
    if (endDate && endDate !== startDate) {
      endMap = await callAvailability(rows, `${endDate} 09:00:00`);
    }

    const availability: Record<string, any> = {};
    for (const item of items) {
      const id = String(item.id);
      const startData = startMap[id] || { stock: 0, available: 0 };
      if (endMap) {
        const endData = endMap[id] || { stock: 0, available: 0 };
        availability[id] = { stock: startData.stock, available: Math.min(startData.available, endData.available) };
      } else {
        availability[id] = startData;
      }
    }

    return res.json({
      success: true,
      availability,
      checkedAt: `${startDate} 09:00:00`,
      endCheckedAt: endDate ? `${endDate} 09:00:00` : null,
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    console.error('[Staging] availability error:', err);
    return res.status(502).json({ success: false, error: 'Failed to check availability', details: String(err) });
  }
});

async function callAvailability(rows: any[], localDatetime: string): Promise<Record<string, any>> {
  const resp = await hhBroker.get<any>(
    '/php_functions/picklist_get_availability.php',
    { rows: JSON.stringify(rows), local: localDatetime, tz: 'Europe/London', global_depot: 1 },
    { priority: 'high', skipCache: true },
  );
  if (!resp.success) throw new Error(resp.error || 'HireHop availability call failed');
  const data: any = resp.data;
  const responseRows = data.rows || (Array.isArray(data) ? data : []);
  const result: Record<string, any> = {};
  for (const row of responseRows) {
    result[String(row.ID)] = {
      stock: parseInt(row.STOCK) || 0,
      available: parseInt(row.AVAILABLE) || 0,
      global: parseInt(row.GLOBAL) || 0,
    };
  }
  return result;
}

/** Push calculated parts to a HireHop job, store the stage plan, drop a HH note. */
const pushSchema = z.object({
  jobId: z.union([z.number(), z.string()]).transform((v) => String(v)),
  items: z.array(z.object({
    hirehopId: z.union([z.number(), z.string()]),
    qty: z.number().positive(),
    saleItem: z.boolean().optional(),
  })).min(1),
  stageConfig: z.record(z.any()).optional(),
  stageSummary: z.string().max(500).optional(),
});

/** Mint a short 3D share link from a stage config WITHOUT pushing items to a job.
 * Used by the in-calculator Open/Copy buttons so they get a short link too (the
 * row is job-less + ephemeral — it never shows on a job's Staging tab). */
router.post('/preview-link', async (req: AuthRequest, res: Response) => {
  const parsed = z.object({
    stageConfig: z.record(z.any()),
    stageSummary: z.string().max(500).optional(),
  }).safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ success: false, error: 'stageConfig required.' });
  }
  try {
    const slug = await mintUniqueSlug();
    const shareLink = frontendLink(`/stage-view.html?p=${slug}`);
    await query(
      `INSERT INTO staging_plans (job_id, hh_job_number, slug, stage_config, summary, three_d_url, created_by)
       VALUES (NULL, NULL, $1, $2, $3, $4, $5)`,
      [slug, parsed.data.stageConfig, parsed.data.stageSummary || null, shareLink, req.user?.id || null],
    );
    return res.json({ success: true, shareLink });
  } catch (err) {
    console.error('[Staging] preview-link error:', err);
    return res.status(500).json({ success: false, error: 'Failed to create preview link' });
  }
});

router.post('/push', async (req: AuthRequest, res: Response) => {
  const parsed = pushSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ success: false, error: 'jobId + items[] required.' });
  }
  const { jobId, items, stageConfig, stageSummary } = parsed.data;
  if (!/^\d+$/.test(jobId)) {
    return res.status(400).json({ success: false, error: 'Valid HireHop job number required.' });
  }
  const hhJobNumber = parseInt(jobId, 10);

  // Build the HireHop items map: { "b<id>": qty } for hire, { "a<id>": qty } for sale/consumable.
  const itemsMap: Record<string, number> = {};
  let totalQty = 0;
  for (const item of items) {
    if (!item.hirehopId || !item.qty || item.qty <= 0) continue;
    const prefix = item.saleItem ? SALE_ITEM_PREFIX : HIRE_ITEM_PREFIX;
    const key = `${prefix}${item.hirehopId}`;
    itemsMap[key] = (itemsMap[key] || 0) + item.qty;
    totalQty += item.qty;
  }
  if (Object.keys(itemsMap).length === 0) {
    return res.status(400).json({ success: false, error: 'No valid items to push.' });
  }
  console.log(`[Staging] push job ${hhJobNumber} itemsMap:`, JSON.stringify(itemsMap));

  // 1) Create the staging_plan first so the HH note can carry the SHORT 3D link.
  let shareLink: string | null = null;
  let planId: string | null = null;
  if (stageConfig && Object.keys(stageConfig).length > 0) {
    const slug = await mintUniqueSlug();
    shareLink = frontendLink(`/stage-view.html?p=${slug}`);
    const jobRow = await query(`SELECT id FROM jobs WHERE hh_job_number = $1 LIMIT 1`, [hhJobNumber]);
    const opJobId = jobRow.rows[0]?.id || null;
    const inserted = await query(
      `INSERT INTO staging_plans (job_id, hh_job_number, slug, stage_config, summary, three_d_url, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
      [opJobId, hhJobNumber, slug, stageConfig, stageSummary || null, shareLink, req.user?.id || null],
    );
    planId = inserted.rows[0].id;
  }

  // 2) Push items to HireHop.
  const pushResp = await hhBroker.post<any>(
    '/api/save_job.php',
    { job: hhJobNumber, items: JSON.stringify(itemsMap), no_webhook: 1 },
    { priority: 'high' },
  );
  console.log(`[Staging] save_job response for job ${hhJobNumber}:`, JSON.stringify(pushResp).slice(0, 600));
  if (!pushResp.success) {
    // Roll back the plan row — nothing was added to HH, so a dangling plan/link is misleading.
    if (planId) await query(`DELETE FROM staging_plans WHERE id = $1`, [planId]).catch(() => {});
    return res.status(502).json({ success: false, error: `HireHop rejected the items: ${pushResp.error}` });
  }

  // 3) Drop a job note with the short 3D link (best-effort — items are already in).
  try {
    const ts = new Date().toLocaleString('en-GB');
    let note = `🏗️ Staging Calculator — items added automatically`;
    if (stageSummary) note += `\n${stageSummary}`;
    note += `\n${Object.keys(itemsMap).length} item types, ${totalQty} total pieces added.`;
    if (shareLink) note += `\n\n3D Stage Preview:\n${shareLink}`;
    note += `\n\nAdded: ${ts}`;
    // notes_save.php (main_id/type) is the endpoint the original staging tool used and
    // that works; /api/job_note.php 404s. POST via broker (token auto-added).
    const noteResp = await hhBroker.post('/php_functions/notes_save.php', { main_id: hhJobNumber, type: 1, note }, { priority: 'low' });
    if (!noteResp.success) console.warn('[Staging] job note post failed (non-fatal):', noteResp.error);
  } catch (noteErr) {
    console.warn('[Staging] job note failed (non-fatal):', noteErr);
  }

  return res.json({
    success: true,
    jobId: hhJobNumber,
    itemTypes: Object.keys(itemsMap).length,
    totalQuantity: totalQty,
    planId,
    shareLink,
    timestamp: new Date().toISOString(),
  });
});

/** List staging plans for a job (accepts OP uuid or HH job number). */
router.get('/plans/:jobId', async (req: AuthRequest, res: Response) => {
  const jobId = String(req.params.jobId);
  const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(jobId);
  try {
    const result = await query(
      isUuid
        ? `SELECT * FROM staging_plans WHERE job_id = $1 ORDER BY created_at DESC`
        : `SELECT * FROM staging_plans WHERE hh_job_number = $1 ORDER BY created_at DESC`,
      [isUuid ? jobId : parseInt(jobId, 10)],
    );
    return res.json({ data: result.rows });
  } catch (err) {
    console.error('[Staging] plans list error:', err);
    return res.status(500).json({ error: 'Failed to load staging plans' });
  }
});

/** Toggle share-with-freelancer on a staging plan. */
router.patch('/plans/:id', async (req: AuthRequest, res: Response) => {
  const share = z.object({ share_with_freelancer: z.boolean() }).safeParse(req.body);
  if (!share.success) return res.status(400).json({ error: 'share_with_freelancer (boolean) required' });
  try {
    const result = await query(
      `UPDATE staging_plans SET share_with_freelancer = $1, updated_at = NOW() WHERE id = $2 RETURNING *`,
      [share.data.share_with_freelancer, req.params.id],
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Staging plan not found' });
    return res.json({ data: result.rows[0] });
  } catch (err) {
    console.error('[Staging] plan update error:', err);
    return res.status(500).json({ error: 'Failed to update staging plan' });
  }
});

/** Delete a staging plan (hard delete — disposable calc artefact). */
router.delete('/plans/:id', async (req: AuthRequest, res: Response) => {
  try {
    const result = await query(`DELETE FROM staging_plans WHERE id = $1 RETURNING id`, [req.params.id]);
    if (result.rows.length === 0) return res.status(404).json({ error: 'Staging plan not found' });
    return res.json({ success: true });
  } catch (err) {
    console.error('[Staging] plan delete error:', err);
    return res.status(500).json({ error: 'Failed to delete staging plan' });
  }
});

async function mintUniqueSlug(): Promise<string> {
  for (let i = 0; i < 6; i++) {
    const slug = crypto.randomBytes(6).toString('base64url'); // 8 url-safe chars
    const existing = await query(`SELECT 1 FROM staging_plans WHERE slug = $1`, [slug]);
    if (existing.rows.length === 0) return slug;
  }
  // Extremely unlikely fallback
  return crypto.randomBytes(12).toString('base64url');
}

export default router;
