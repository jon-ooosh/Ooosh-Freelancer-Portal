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
import multer from 'multer';
import rateLimit from 'express-rate-limit';
import { query } from '../config/database';
import { authenticate, AuthRequest, STAFF_ROLES, authorize } from '../middleware/auth';
import { validate } from '../middleware/validate';
import { uploadToPublicR2 } from '../config/r2';
import { HHLineItem } from '../services/hirehop-job-sync';
import { classifyRackItems, pickableItems, ClassifiedRackItem } from '../services/rack-classify';

const router = Router();

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const R2_PUBLIC_URL = process.env.R2_PUBLIC_URL || '';

/** Front-panel photos are stored in front_photo_key as a full public URL. */
function photoToUrl(stored: string | null): string | null {
  if (!stored) return null;
  if (/^https?:\/\//i.test(stored)) return stored;
  return R2_PUBLIC_URL ? `${R2_PUBLIC_URL}/${stored}` : stored;
}

/** Map of HireHop list_id → public front-panel photo URL. */
async function getPhotoMap(listIds: number[]): Promise<Record<number, string>> {
  const ids = [...new Set(listIds.filter((n) => n > 0))];
  if (ids.length === 0) return {};
  const result = await query(
    `SELECT list_id, front_photo_key FROM rack_stock_items WHERE list_id = ANY($1) AND front_photo_key IS NOT NULL`,
    [ids],
  );
  const map: Record<number, string> = {};
  for (const r of result.rows) {
    const url = photoToUrl(r.front_photo_key);
    if (url) map[Number(r.list_id)] = url;
  }
  return map;
}

const photoUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
});

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
    result.rows.map((r: any) => [Number(r.list_id), photoToUrl(r.front_photo_key)]),
  );
  return classified.map((c) => ({ ...c, frontPhotoKey: map.get(c.listId) ?? null }));
}

/** All hh_list_id referenced by a saved layout (nodes + built-here items). */
function layoutListIds(layout: { nodes?: any[] }): number[] {
  const ids: number[] = [];
  for (const n of layout?.nodes ?? []) {
    if (typeof n?.hh_list_id === 'number') ids.push(n.hh_list_id);
    for (const it of n?.items ?? []) if (typeof it?.hh_list_id === 'number') ids.push(it.hh_list_id);
  }
  return ids;
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
  // Photos resolved live by list_id (so a photo uploaded after the plan was
  // saved still shows on the client view).
  const photos = await getPhotoMap(layoutListIds(row.layout));

  res.json({
    data: {
      title: row.title,
      jobName: row.job_name,
      hhJobNumber: row.hh_job_number,
      layout: row.layout,
      photos,
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
    `SELECT p.view_token, p.layout, p.updated_at,
            TRIM(COALESCE(pe.first_name, '') || ' ' || COALESCE(pe.last_name, '')) AS edited_by
       FROM rack_plans p
       LEFT JOIN users u ON u.id = p.updated_by
       LEFT JOIN people pe ON pe.id = u.person_id
      WHERE p.job_id = $1`,
    [jobId],
  );
  if (result.rows.length === 0) {
    res.json({ data: { hasPlan: false } });
    return;
  }
  const row = result.rows[0];
  const nodeCount = Array.isArray(row.layout?.nodes) ? row.layout.nodes.length : 0;
  res.json({
    data: {
      hasPlan: nodeCount > 0, nodeCount, viewToken: row.view_token,
      updatedAt: row.updated_at, editedBy: row.edited_by || null,
    },
  });
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
            updated_by = $3,
            updated_at = NOW()
      WHERE id = $4
      RETURNING id, updated_at`,
    [JSON.stringify(layout), title ?? null, req.user?.id ?? null, id],
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

// POST /photo/:listId — upload a front-panel photo (multipart). Stored in the
// PUBLIC R2 bucket so the login-free client view can show it. Lazy-seeded: one
// photo per HireHop stock item, reused on every future job.
router.post('/photo/:listId', photoUpload.single('file'), async (req: AuthRequest, res: Response) => {
  const listId = Number(req.params.listId);
  if (!Number.isInteger(listId) || listId <= 0) {
    res.status(400).json({ error: 'Invalid listId' });
    return;
  }
  const file = (req as Request & { file?: Express.Multer.File }).file;
  if (!file) {
    res.status(400).json({ error: 'No file uploaded' });
    return;
  }
  if (!/^image\//.test(file.mimetype)) {
    res.status(400).json({ error: 'File must be an image' });
    return;
  }
  if (!R2_PUBLIC_URL) {
    res.status(503).json({ error: 'Public photo storage not configured (R2_PUBLIC_URL)' });
    return;
  }

  const ext = (file.originalname.split('.').pop() || 'jpg').toLowerCase().replace(/[^a-z0-9]/g, '') || 'jpg';
  const key = `rack-photos/${listId}-${Date.now()}.${ext}`;
  await uploadToPublicR2(key, file.buffer, file.mimetype);
  const url = `${R2_PUBLIC_URL}/${key}`;

  await query(
    `INSERT INTO rack_stock_items (list_id, front_photo_key, updated_by, updated_at)
     VALUES ($1, $2, $3, NOW())
     ON CONFLICT (list_id) DO UPDATE
        SET front_photo_key = EXCLUDED.front_photo_key,
            updated_by = EXCLUDED.updated_by,
            updated_at = NOW()`,
    [listId, url, req.user?.id ?? null],
  );
  res.json({ data: { listId, url } });
});

export default router;
