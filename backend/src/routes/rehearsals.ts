/**
 * Rehearsals — per-job details, band profile, and the client info pack.
 *
 * See docs/REHEARSAL-INFO-AND-PROFILE-SPEC.md. All endpoints STAFF_ROLES.
 * The studio-sitter roster lives under /api/studio-sitters (separate router);
 * this router carries the "everything about a studio job" surface that grew
 * out of it.
 */
import { Router, Response } from 'express';
import { z } from 'zod';
import { authenticate, authorize, AuthRequest, STAFF_ROLES } from '../middleware/auth';
import {
  resolveRehearsalAnchorOrg,
  getRehearsalJobDetails,
  upsertRehearsalJobDetails,
  getRehearsalProfile,
  upsertRehearsalProfile,
  addProfileFile,
  updateProfileFile,
  removeProfileFile,
  getLastInfoPackSent,
  sendInfoPack,
  previewInfoPack,
} from '../services/rehearsal-details';

const router = Router();
router.use(authenticate, authorize(...STAFF_ROLES));

// GET /api/rehearsals/job/:jobId — details + resolved band anchor + profile + last sent
router.get('/job/:jobId', async (req: AuthRequest, res: Response) => {
  try {
    const jobId = String(req.params.jobId);
    const [details, anchorOrg] = await Promise.all([
      getRehearsalJobDetails(jobId),
      resolveRehearsalAnchorOrg(jobId),
    ]);
    const [profile, lastInfoPackSent] = await Promise.all([
      anchorOrg ? getRehearsalProfile(anchorOrg.id) : Promise.resolve(null),
      anchorOrg ? getLastInfoPackSent(anchorOrg.id) : Promise.resolve(null),
    ]);
    res.json({ data: { details, anchorOrg, profile, lastInfoPackSent } });
  } catch (err) {
    console.error('[rehearsals] job get error:', err);
    res.status(500).json({ error: 'Failed to load rehearsal details' });
  }
});

// PUT /api/rehearsals/job/:jobId — upsert per-job intake
// Overrides keys must be band-standing profile field names (per-hire override of
// the band's usual). Keeps junk keys out of the JSONB.
const OVERRIDE_KEYS = [
  'room_setup', 'mic_list', 'power_notes', 'pa_monitoring', 'usual_backline',
  'desk', 'load_in_access', 'regular_contact',
] as const;
const jobDetailsSchema = z.object({
  pa_setup: z.string().max(4000).nullable().optional(),
  backline_notes: z.string().max(4000).nullable().optional(),
  cars_count: z.number().int().min(0).max(999).nullable().optional(),
  dropoff_pickup: z.string().max(4000).nullable().optional(),
  notes: z.string().max(4000).nullable().optional(),
  // Accept any string-keyed map; keys are whitelist-filtered below so a buggy /
  // stale client can't stash junk keys in the JSONB.
  overrides: z.record(z.string(), z.string().max(4000)).optional(),
});
router.put('/job/:jobId', async (req: AuthRequest, res: Response) => {
  const parsed = jobDetailsSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Invalid input' }); return; }
  try {
    const fields = { ...parsed.data };
    if (fields.overrides) {
      const clean: Record<string, string> = {};
      for (const k of OVERRIDE_KEYS) {
        const v = fields.overrides[k];
        if (typeof v === 'string' && v.trim()) clean[k] = v;
      }
      fields.overrides = clean;
    }
    const data = await upsertRehearsalJobDetails(String(req.params.jobId), fields);
    res.json({ data });
  } catch (err) {
    console.error('[rehearsals] job put error:', err);
    res.status(500).json({ error: 'Failed to save rehearsal details' });
  }
});

// GET /api/rehearsals/profile/:orgId — band rehearsal profile
router.get('/profile/:orgId', async (req: AuthRequest, res: Response) => {
  try {
    res.json({ data: await getRehearsalProfile(String(req.params.orgId)) });
  } catch (err) {
    console.error('[rehearsals] profile get error:', err);
    res.status(500).json({ error: 'Failed to load rehearsal profile' });
  }
});

// PUT /api/rehearsals/profile/:orgId — upsert band profile
const preferenceSchema = z.object({ label: z.string().max(200), value: z.string().max(2000) });
const profileSchema = z.object({
  room_setup: z.string().max(4000).nullable().optional(),
  mic_list: z.string().max(4000).nullable().optional(),
  power_notes: z.string().max(4000).nullable().optional(),
  pa_monitoring: z.string().max(4000).nullable().optional(),
  usual_backline: z.string().max(4000).nullable().optional(),
  desk: z.string().max(2000).nullable().optional(),
  load_in_access: z.string().max(4000).nullable().optional(),
  regular_contact: z.string().max(2000).nullable().optional(),
  internal_notes: z.string().max(8000).nullable().optional(),
  preferences: z.array(preferenceSchema).max(100).optional(),
});
router.put('/profile/:orgId', async (req: AuthRequest, res: Response) => {
  const parsed = profileSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Invalid input' }); return; }
  try {
    const data = await upsertRehearsalProfile(String(req.params.orgId), parsed.data);
    res.json({ data });
  } catch (err) {
    console.error('[rehearsals] profile put error:', err);
    res.status(500).json({ error: 'Failed to save rehearsal profile' });
  }
});

// POST /api/rehearsals/profile/:orgId/files — attach a desk file (r2_key from upload)
const fileSchema = z.object({
  r2_key: z.string().min(1).max(1024),
  filename: z.string().min(1).max(512),
  content_type: z.string().max(200).nullable().optional(),
  size_bytes: z.number().int().nonnegative().nullable().optional(),
  label: z.string().max(200).nullable().optional(),
  comment: z.string().max(2000).nullable().optional(),
});
router.post('/profile/:orgId/files', async (req: AuthRequest, res: Response) => {
  const parsed = fileSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Invalid file' }); return; }
  try {
    const data = await addProfileFile(String(req.params.orgId), {
      ...parsed.data,
      uploaded_at: new Date().toISOString(),
      uploaded_by: req.user?.id ?? null,
    });
    res.json({ data });
  } catch (err) {
    console.error('[rehearsals] profile file add error:', err);
    res.status(500).json({ error: 'Failed to attach file' });
  }
});

// PATCH /api/rehearsals/profile/:orgId/files/:key — edit a desk file's tag / comment
const fileUpdateSchema = z.object({
  label: z.string().max(200).nullable().optional(),
  comment: z.string().max(2000).nullable().optional(),
});
router.patch('/profile/:orgId/files/:key', async (req: AuthRequest, res: Response) => {
  const parsed = fileUpdateSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Invalid input' }); return; }
  try {
    const key = decodeURIComponent(String(req.params.key));
    const data = await updateProfileFile(String(req.params.orgId), key, parsed.data);
    if (!data) { res.status(404).json({ error: 'Profile not found' }); return; }
    res.json({ data });
  } catch (err) {
    console.error('[rehearsals] profile file update error:', err);
    res.status(500).json({ error: 'Failed to update file' });
  }
});

// DELETE /api/rehearsals/profile/:orgId/files/:key — remove a desk file (base64-safe key)
router.delete('/profile/:orgId/files/:key', async (req: AuthRequest, res: Response) => {
  try {
    const key = decodeURIComponent(String(req.params.key));
    const data = await removeProfileFile(String(req.params.orgId), key);
    if (!data) { res.status(404).json({ error: 'Profile not found' }); return; }
    res.json({ data });
  } catch (err) {
    console.error('[rehearsals] profile file remove error:', err);
    res.status(500).json({ error: 'Failed to remove file' });
  }
});

// GET /api/rehearsals/job/:jobId/info-pack-preview — rendered subject + HTML, no send
router.get('/job/:jobId/info-pack-preview', async (req: AuthRequest, res: Response) => {
  try {
    const data = await previewInfoPack(String(req.params.jobId));
    res.json({ data });
  } catch (err) {
    console.error('[rehearsals] info-pack-preview error:', err);
    res.status(500).json({ error: err instanceof Error ? err.message : 'Failed to preview info pack' });
  }
});

// POST /api/rehearsals/job/:jobId/send-info-pack — send + stamp
router.post('/job/:jobId/send-info-pack', async (req: AuthRequest, res: Response) => {
  try {
    const result = await sendInfoPack(String(req.params.jobId), req.user?.id ?? null);
    res.json({ data: result });
  } catch (err) {
    console.error('[rehearsals] send-info-pack error:', err);
    res.status(500).json({ error: err instanceof Error ? err.message : 'Failed to send info pack' });
  }
});

export default router;
