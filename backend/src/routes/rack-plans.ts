/**
 * Rack Planner — backend (Phase 1: storage + classify + drift; no UI yet).
 * Design: docs/RACK-PLANNER-SPEC.md.
 *
 * Public (token auth, no JWT — defined BEFORE the auth gate):
 *   GET  /api/rack-plans/public/:token        — saved layout + live drift
 *
 * Staff (STAFF_ROLES):
 *   GET  /api/rack-plans/by-job/:jobId         — get-or-create plan + picker + drift
 *   PUT  /api/rack-plans/:id                    — save layout
 *   POST /api/rack-plans/stock-photo/:listId    — set owned front-panel photo (R2 key)
 */
import { Router, Request, Response } from 'express';
import { randomBytes } from 'crypto';
import { z } from 'zod';
import rateLimit from 'express-rate-limit';
import { query } from '../config/database';
import { authenticate, AuthRequest, STAFF_ROLES, authorize } from '../middleware/auth';
import { validate } from '../middleware/validate';
import { HHLineItem } from '../services/hirehop-job-sync';
import { classifyRackItems, pickableItems, ClassifiedRackItem } from '../services/rack-classify';

const router = Router();

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface RackPlanRow {
  id: string;
  job_id: string;
  hh_job_number: number | null;
  title: string | null;
  view_token: string;
  layout: { nodes?: unknown[]; arrows?: unknown[] };
  updated_at: string;
}

/** Pull every hh_item_id / hh row reference out of a saved layout document. */
function placedItemIds(layout: { nodes?: any[] }): Set<number> {
  const ids = new Set<number>();
  for (const node of layout?.nodes ?? []) {
    if (typeof node?.hh_item_id === 'number') ids.add(node.hh_item_id);
    for (const it of node?.items ?? []) {
      if (typeof it?.hh_item_id === 'number') ids.add(it.hh_item_id);
    }
  }
  return ids;
}

/**
 * Drift = the live diff between a saved plan and current HireHop.
 *  - removed: placed rows no longer on the job (red-hole for U-items, quiet otherwise)
 *  - unplaced: current pickable rows not referenced by the plan ("on job, unplaced")
 */
function computeDrift(
  layout: { nodes?: any[] },
  classified: ClassifiedRackItem[],
) {
  const placed = placedItemIds(layout);
  const currentIds = new Set(classified.map((c) => c.itemId));

  const removed: number[] = [];
  for (const id of placed) {
    if (!currentIds.has(id)) removed.push(id);
  }

  const unplaced = pickableItems(classified).filter((c) => !placed.has(c.itemId));

  return { removed, unplaced };
}

/** Merge owned front-panel photos onto the classified items by stock list_id. */
async function attachPhotos(classified: ClassifiedRackItem[]) {
  const listIds = [...new Set(classified.map((c) => c.listId).filter((n) => n > 0))];
  if (listIds.length === 0) return classified.map((c) => ({ ...c, frontPhotoKey: null as string | null }));

  const result = await query(
    `SELECT list_id, front_photo_key FROM rack_stock_items WHERE list_id = ANY($1)`,
    [listIds],
  );
  const map = new Map<number, string | null>(
    result.rows.map((r: any) => [Number(r.list_id), r.front_photo_key]),
  );
  return classified.map((c) => ({ ...c, frontPhotoKey: map.get(c.listId) ?? null }));
}

/** Classify a job's stored line items. */
function classifyJob(lineItems: unknown): ClassifiedRackItem[] {
  const items: HHLineItem[] = Array.isArray(lineItems) ? (lineItems as HHLineItem[]) : [];
  return classifyRackItems(items);
}

// ── Public: view-only by token (no JWT) ─────────────────────────────────────
const publicLimiter = rateLimit({
  windowMs: 60_000,
  max: 60,
  message: { error: 'Too many requests' },
  standardHeaders: true,
  legacyHeaders: false,
});

router.get('/public/:token', publicLimiter, async (req: Request, res: Response) => {
  const token = String(req.params.token);
  const result = await query(
    `SELECT p.id, p.job_id, p.hh_job_number, p.title, p.layout,
            j.line_items, j.job_name
       FROM rack_plans p
       JOIN jobs j ON j.id = p.job_id
      WHERE p.view_token = $1`,
    [token],
  );
  if (result.rows.length === 0) {
    res.status(404).json({ error: 'Plan not found' });
    return;
  }
  const row = result.rows[0];
  const classified = await attachPhotos(classifyJob(row.line_items));
  const drift = computeDrift(row.layout, classified);

  res.json({
    data: {
      title: row.title,
      jobName: row.job_name,
      hhJobNumber: row.hh_job_number,
      layout: row.layout,
      drift,
    },
  });
});

// ── Staff auth gate ─────────────────────────────────────────────────────────
router.use(authenticate, authorize(...STAFF_ROLES));

// GET /by-job/:jobId — get-or-create the plan, classify current items, drift.
router.get('/by-job/:jobId', async (req: AuthRequest, res: Response) => {
  const jobId = String(req.params.jobId);
  if (!UUID_RE.test(jobId)) {
    res.status(400).json({ error: 'jobId must be an OP job UUID' });
    return;
  }

  const jobResult = await query(
    `SELECT id, hh_job_number, job_name, line_items FROM jobs WHERE id = $1 AND is_deleted = false`,
    [jobId],
  );
  if (jobResult.rows.length === 0) {
    res.status(404).json({ error: 'Job not found' });
    return;
  }
  const job = jobResult.rows[0];

  // Get-or-create the plan (one per job).
  let planResult = await query(
    `SELECT id, job_id, hh_job_number, title, view_token, layout, updated_at
       FROM rack_plans WHERE job_id = $1`,
    [jobId],
  );
  if (planResult.rows.length === 0) {
    const token = randomBytes(24).toString('hex');
    planResult = await query(
      `INSERT INTO rack_plans (job_id, hh_job_number, view_token, created_by)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (job_id) DO UPDATE SET updated_at = NOW()
       RETURNING id, job_id, hh_job_number, title, view_token, layout, updated_at`,
      [jobId, job.hh_job_number ?? null, token, req.user?.id ?? null],
    );
  }
  const plan = planResult.rows[0] as RackPlanRow;

  const classified = await attachPhotos(classifyJob(job.line_items));
  const drift = computeDrift(plan.layout, classified);

  res.json({
    data: {
      plan: {
        id: plan.id,
        jobId: plan.job_id,
        hhJobNumber: plan.hh_job_number,
        title: plan.title,
        viewToken: plan.view_token,
        layout: plan.layout,
        updatedAt: plan.updated_at,
      },
      jobName: job.job_name,
      picker: pickableItems(classified),
      drift,
    },
  });
});

// GET /summary/:jobId — does a non-empty plan exist? (read-only, never creates a row).
router.get('/summary/:jobId', async (req: AuthRequest, res: Response) => {
  const jobId = String(req.params.jobId);
  if (!UUID_RE.test(jobId)) {
    res.status(400).json({ error: 'jobId must be an OP job UUID' });
    return;
  }
  const result = await query(
    `SELECT view_token, layout FROM rack_plans WHERE job_id = $1`,
    [jobId],
  );
  if (result.rows.length === 0) {
    res.json({ data: { hasPlan: false } });
    return;
  }
  const row = result.rows[0];
  const nodeCount = Array.isArray(row.layout?.nodes) ? row.layout.nodes.length : 0;
  res.json({ data: { hasPlan: nodeCount > 0, nodeCount, viewToken: row.view_token } });
});

// PUT /:id — save the layout document.
const layoutSchema = z.object({
  title: z.string().max(200).optional(),
  layout: z
    .object({
      nodes: z.array(z.any()).default([]),
      arrows: z.array(z.any()).default([]),
    })
    .passthrough(),
});

router.put('/:id', validate(layoutSchema), async (req: AuthRequest, res: Response) => {
  const id = String(req.params.id);
  if (!UUID_RE.test(id)) {
    res.status(400).json({ error: 'Invalid plan id' });
    return;
  }
  const { title, layout } = req.body as z.infer<typeof layoutSchema>;

  const result = await query(
    `UPDATE rack_plans
        SET layout = $1,
            title = COALESCE($2, title),
            updated_at = NOW()
      WHERE id = $3
      RETURNING id, updated_at`,
    [JSON.stringify(layout), title ?? null, id],
  );
  if (result.rows.length === 0) {
    res.status(404).json({ error: 'Plan not found' });
    return;
  }
  res.json({ data: { id: result.rows[0].id, updatedAt: result.rows[0].updated_at } });
});

// POST /stock-photo/:listId — set the owned front-panel photo (R2 key already uploaded).
const photoSchema = z.object({
  front_photo_key: z.string().min(1).max(500),
  name: z.string().max(300).optional(),
});

router.post('/stock-photo/:listId', validate(photoSchema), async (req: AuthRequest, res: Response) => {
  const listId = Number(req.params.listId);
  if (!Number.isInteger(listId) || listId <= 0) {
    res.status(400).json({ error: 'Invalid listId' });
    return;
  }
  const { front_photo_key, name } = req.body as z.infer<typeof photoSchema>;

  await query(
    `INSERT INTO rack_stock_items (list_id, front_photo_key, name_cache, updated_by, updated_at)
     VALUES ($1, $2, $3, $4, NOW())
     ON CONFLICT (list_id) DO UPDATE
        SET front_photo_key = EXCLUDED.front_photo_key,
            name_cache = COALESCE(EXCLUDED.name_cache, rack_stock_items.name_cache),
            updated_by = EXCLUDED.updated_by,
            updated_at = NOW()`,
    [listId, front_photo_key, name ?? null, req.user?.id ?? null],
  );
  res.json({ data: { listId, frontPhotoKey: front_photo_key } });
});

export default router;
