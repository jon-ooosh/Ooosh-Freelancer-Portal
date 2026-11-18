/**
 * The social media planner — Marketing › Content (docs/BUSINESS-FIGURES-SPEC.md §8e).
 * Every staff login (jon, 18 Nov 2026 — staff-wide; Matt runs it). All logic in
 * services/marketing-content.ts. Nothing is deleted: a post is 'dropped', content archived.
 *
 *   GET    /posts?view=calendar&from=&to= | view=board | view=ideas
 *   GET    /posts/:id                  one post with its content
 *   POST   /posts                      a new post (or idea)
 *   PATCH  /posts/:id                  change it (only the fields sent)
 *   GET    /themes                     themes used before (suggestions)
 *   GET    /links                      tracked links to pick for a post (managed on the Links tab)
 *   GET    /assets?search=&archived=   the content library
 *   POST   /assets                     add content (a Drive link)
 *   PATCH  /assets/:id                 change / archive it
 *   GET    /hashtag-sets               saved hashtag sets
 *   POST   /hashtag-sets               save one { name, tags } (same name = replace)
 *   DELETE /hashtag-sets/:id
 */
import { Router, Response } from 'express';
import { z } from 'zod';
import { authenticate, authorize, AuthRequest, STAFF_ROLES } from '../middleware/auth';
import { validate, partialForUpdate } from '../middleware/validate';
import {
  ASSET_KINDS, ContentError, POST_CHANNELS, POST_FORMATS, POST_STATUSES, createAsset, createPost, deleteHashtagSet,
  getPost, listAssets, listHashtagSets, listLinkChoices, listPosts, listThemes, saveHashtagSet, updateAsset, updatePost,
} from '../services/marketing-content';

const router = Router();
router.use(authenticate);
router.use(authorize(...STAFF_ROLES));

const ymd = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'must be a date (YYYY-MM-DD)');
const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'must be a time (HH:MM)');
const idParam = z.object({ id: z.string().guid() });
const optId = z.string().guid().nullable().optional();
const optText = (max: number) => z.string().max(max).nullable().optional();

function fail(res: Response, where: string, err: unknown) {
  if (err instanceof ContentError) { res.status(err.status).json({ error: err.message }); return; }
  console.error(`[marketing-content] ${where}:`, err);
  res.status(500).json({ error: 'Something went wrong — please try again.' });
}

// ── Posts ─────────────────────────────────────────────────────────────────────

router.get('/posts', async (req: AuthRequest, res: Response) => {
  try {
    const view = String(req.query.view || 'board');
    if (view === 'calendar') {
      const from = String(req.query.from || '');
      const to = String(req.query.to || '');
      if (!ymd.safeParse(from).success || !ymd.safeParse(to).success) { res.status(400).json({ error: 'from and to are dates' }); return; }
      res.json({ data: await listPosts({ view: 'calendar', from, to }) });
      return;
    }
    res.json({ data: await listPosts({ view: view === 'ideas' ? 'ideas' : 'board' }) });
  } catch (err) { fail(res, 'list posts', err); }
});

router.get('/posts/:id', validate(idParam, 'params'), async (req: AuthRequest, res: Response) => {
  try {
    const p = await getPost(String(req.params.id));
    if (!p) { res.status(404).json({ error: 'Post not found' }); return; }
    res.json({ data: p });
  } catch (err) { fail(res, 'get post', err); }
});

const postSchema = z.object({
  title: z.string().trim().min(1).max(200),
  publish_date: ymd.nullable().optional(),
  publish_time: hhmm.nullable().optional(),
  channels: z.array(z.enum(POST_CHANNELS)).max(4).optional(),
  format: z.enum(POST_FORMATS).nullable().optional(),
  caption: optText(5000),
  hashtags: optText(2000),
  theme: optText(60),
  status: z.enum(POST_STATUSES).optional(),
  owner_person_id: optId,
  job_id: optId,
  organisation_id: optId,
  credit_person_id: optId,
  tracked_link_id: optId,
  live_url: optText(1000),
  notes: optText(5000),
  asset_ids: z.array(z.string().guid()).max(50).optional(),
});

router.post('/posts', validate(postSchema), async (req: AuthRequest, res: Response) => {
  try {
    res.status(201).json({ data: await createPost(req.body, req.user!.id) });
  } catch (err) { fail(res, 'create post', err); }
});

router.patch('/posts/:id', validate(idParam, 'params'), validate(partialForUpdate(postSchema)), async (req: AuthRequest, res: Response) => {
  try {
    res.json({ data: await updatePost(String(req.params.id), req.body, req.user!.id) });
  } catch (err) { fail(res, 'update post', err); }
});

router.get('/themes', async (_req: AuthRequest, res: Response) => {
  try { res.json({ data: await listThemes() }); } catch (err) { fail(res, 'themes', err); }
});

router.get('/links', async (_req: AuthRequest, res: Response) => {
  try { res.json({ data: await listLinkChoices() }); } catch (err) { fail(res, 'links', err); }
});

// ── The content library ──────────────────────────────────────────────────────

router.get('/assets', async (req: AuthRequest, res: Response) => {
  try {
    res.json({ data: await listAssets({ search: typeof req.query.search === 'string' ? req.query.search : undefined, archived: req.query.archived === '1' }) });
  } catch (err) { fail(res, 'list assets', err); }
});

const assetSchema = z.object({
  title: z.string().trim().min(1).max(200),
  url: z.string().trim().min(1).max(2000),
  kind: z.enum(ASSET_KINDS).optional(),
  credit_person_id: optId,
  job_id: optId,
  organisation_id: optId,
  notes: optText(2000),
});

router.post('/assets', validate(assetSchema), async (req: AuthRequest, res: Response) => {
  try {
    res.status(201).json({ data: await createAsset(req.body, { userId: req.user!.id, source: 'staff' }) });
  } catch (err) { fail(res, 'create asset', err); }
});

router.patch('/assets/:id', validate(idParam, 'params'),
  validate(partialForUpdate(assetSchema.extend({ archived: z.boolean().optional() }))), async (req: AuthRequest, res: Response) => {
    try {
      res.json({ data: await updateAsset(String(req.params.id), req.body) });
    } catch (err) { fail(res, 'update asset', err); }
  });

// ── Saved hashtag sets ───────────────────────────────────────────────────────

router.get('/hashtag-sets', async (_req: AuthRequest, res: Response) => {
  try { res.json({ data: await listHashtagSets() }); } catch (err) { fail(res, 'hashtag sets', err); }
});

router.post('/hashtag-sets', validate(z.object({ name: z.string().trim().min(1).max(80), tags: z.string().trim().min(1).max(2000) })),
  async (req: AuthRequest, res: Response) => {
    try { res.json({ data: await saveHashtagSet(req.body.name, req.body.tags, req.user!.id) }); } catch (err) { fail(res, 'save hashtag set', err); }
  });

router.delete('/hashtag-sets/:id', validate(idParam, 'params'), async (req: AuthRequest, res: Response) => {
  try { res.json({ data: await deleteHashtagSet(String(req.params.id)) }); } catch (err) { fail(res, 'delete hashtag set', err); }
});

export default router;
