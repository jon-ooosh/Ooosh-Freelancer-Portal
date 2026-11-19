/**
 * Premises & compliance — Operations › Premises & compliance
 * (docs/PREMISES-COMPLIANCE-SPEC.md). Every staff login; what each one sees is
 * decided per check by its visibility, in services/premises.ts, which holds
 * all the logic. Adding, changing and retiring checks is manager-tier;
 * recording is anyone who can see the check; places and headings are admin.
 *
 *   GET    /meta                         places, headings, who can own a check, what I may do
 *   GET    /checks?include_retired=1     the register
 *   GET    /checks/:id                   one check with its records and files
 *   POST   /checks                       add a check
 *   PATCH  /checks/:id                   change it (only the fields sent)
 *   POST   /checks/:id/retire            { reason }
 *   POST   /checks/:id/unretire
 *   DELETE /checks/:id                   only when nothing was ever recorded on it
 *   GET    /checks/:id/next-due?done_on= what recording on that day would set
 *   POST   /checks/:id/records           record that it was done
 *   POST   /records/:id/remove           { reason } — a mistake (manager)
 *   POST   /records/:id/files            multipart `file` — a certificate / report / photo
 *   POST   /files/:id/archive            take a file off (manager or whoever added it)
 *   POST   /places | /headings           { name } (admin)
 *   PATCH  /places/:id | /headings/:id   { name?, sort_order?, retired? } (admin)
 */
import { Router, Response } from 'express';
import { z } from 'zod';
import multer from 'multer';
import path from 'path';
import { randomUUID } from 'crypto';
import { authenticate, authorize, AuthRequest, STAFF_ROLES } from '../middleware/auth';
import { validate, partialForUpdate } from '../middleware/validate';
import { uploadToR2, isR2Configured } from '../config/r2';
import {
  PremisesError, PREMISES_PREFIX, addFile, addTaxonomy, archiveFile, checkForRecord, createCheck, deleteCheck,
  getCheck, getMeta, listChecks, previewNextDue, recordCheck, removeRecord, retireCheck, unretireCheck,
  updateCheck, updateTaxonomy,
} from '../services/premises';

const router = Router();
router.use(authenticate);
router.use(authorize(...STAFF_ROLES));

const ymd = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'must be a date (YYYY-MM-DD)');
const idParam = z.object({ id: z.string().guid() });
const optText = (max: number) => z.string().max(max).nullable().optional();

function fail(res: Response, where: string, err: unknown) {
  if (err instanceof PremisesError) { res.status(err.status).json({ error: err.message }); return; }
  console.error(`[premises] ${where}:`, err);
  res.status(500).json({ error: 'Something went wrong — please try again.' });
}

const caller = (req: AuthRequest) => ({ userId: req.user!.id, role: req.user!.role });

// ── The register and one check ───────────────────────────────────────────────

router.get('/meta', async (req: AuthRequest, res: Response) => {
  try { res.json({ data: await getMeta(req.user!.role, req.user!.id) }); } catch (err) { fail(res, 'meta', err); }
});

router.get('/checks', async (req: AuthRequest, res: Response) => {
  try {
    res.json({ data: await listChecks(req.user!.role, String(req.query.include_retired || '') === '1') });
  } catch (err) { fail(res, 'list', err); }
});

router.get('/checks/:id', validate(idParam, 'params'), async (req: AuthRequest, res: Response) => {
  try { res.json({ data: await getCheck(String(req.params.id), req.user!.role) }); } catch (err) { fail(res, 'get', err); }
});

const checkSchema = z.object({
  title: z.string().min(1).max(200),
  kind: z.enum(['visit', 'test', 'reading', 'renewal']),
  heading_id: z.string().guid(),
  place_id: z.string().guid(),
  visibility: z.enum(['all', 'managers', 'admins']),
  owner_person_id: z.string().guid().nullable(),
  contractor_org_id: z.string().guid().nullable(),
  responsibility: z.enum(['ours', 'landlord']),
  repeat: z.object({ mode: z.enum(['schedule', 'after_done']), rule: z.record(z.string(), z.unknown()) }).nullable(),
  next_due: ymd.nullable(),
  remind_days_before: z.number().int().min(0).max(365),
  location_note: optText(500),
  why_note: optText(1000),
  notes: optText(4000),
});

router.post('/checks', validate(checkSchema), async (req: AuthRequest, res: Response) => {
  try {
    const b = req.body as z.infer<typeof checkSchema>;
    res.status(201).json({
      data: await createCheck({
        ...b, location_note: b.location_note ?? null, why_note: b.why_note ?? null, notes: b.notes ?? null,
      }, caller(req)),
    });
  } catch (err) { fail(res, 'create', err); }
});

router.patch('/checks/:id', validate(idParam, 'params'), validate(partialForUpdate(checkSchema)), async (req: AuthRequest, res: Response) => {
  try {
    res.json({ data: await updateCheck(String(req.params.id), req.body, caller(req)) });
  } catch (err) { fail(res, 'update', err); }
});

const reasonSchema = z.object({ reason: z.string().max(500).nullable().optional() });

router.post('/checks/:id/retire', validate(idParam, 'params'), validate(reasonSchema), async (req: AuthRequest, res: Response) => {
  try { res.json({ data: await retireCheck(String(req.params.id), req.body.reason ?? null, caller(req)) }); } catch (err) { fail(res, 'retire', err); }
});

router.post('/checks/:id/unretire', validate(idParam, 'params'), async (req: AuthRequest, res: Response) => {
  try { res.json({ data: await unretireCheck(String(req.params.id), caller(req)) }); } catch (err) { fail(res, 'unretire', err); }
});

router.delete('/checks/:id', validate(idParam, 'params'), async (req: AuthRequest, res: Response) => {
  try { await deleteCheck(String(req.params.id), caller(req)); res.json({ data: { deleted: true } }); } catch (err) { fail(res, 'delete', err); }
});

router.get('/checks/:id/next-due', validate(idParam, 'params'), async (req: AuthRequest, res: Response) => {
  try {
    res.json({ data: await previewNextDue(String(req.params.id), String(req.query.done_on || ''), req.user!.role) });
  } catch (err) { fail(res, 'next-due', err); }
});

// ── Recording it ─────────────────────────────────────────────────────────────

const recordSchema = z.object({
  done_on: ymd,
  outcome: z.enum(['pass', 'advisories', 'fail']).nullable().optional(),
  done_by_org_id: z.string().guid().nullable().optional(),
  notes: optText(4000),
  next_due: ymd.nullable().optional(),
  reading_value: z.number().finite().nullable().optional(),
  meter_replaced: z.boolean().optional(),
});

router.post('/checks/:id/records', validate(idParam, 'params'), validate(recordSchema), async (req: AuthRequest, res: Response) => {
  try {
    const b = req.body as z.infer<typeof recordSchema>;
    res.status(201).json({
      data: await recordCheck(String(req.params.id), {
        done_on: b.done_on,
        outcome: b.outcome ?? null,
        done_by_org_id: b.done_by_org_id ?? null,
        notes: b.notes ?? null,
        next_due: b.next_due ?? null,
        reading_value: b.reading_value ?? null,
        meter_replaced: b.meter_replaced ?? false,
      }, caller(req)),
    });
  } catch (err) { fail(res, 'record', err); }
});

router.post('/records/:id/remove', validate(idParam, 'params'), validate(reasonSchema), async (req: AuthRequest, res: Response) => {
  try { res.json({ data: await removeRecord(String(req.params.id), req.body.reason ?? null, caller(req)) }); } catch (err) { fail(res, 'remove record', err); }
});

// ── Files ────────────────────────────────────────────────────────────────────

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024, files: 1 } });

router.post('/records/:id/files', validate(idParam, 'params'), (req: AuthRequest, res: Response, next) => {
  upload.single('file')(req, res, (err: unknown) => {
    if (err instanceof multer.MulterError && err.code === 'LIMIT_FILE_SIZE') {
      res.status(413).json({ error: 'That file is over 20 MB' });
      return;
    }
    if (err) { fail(res, 'upload parse', err); return; }
    next();
  });
}, async (req: AuthRequest, res: Response) => {
  try {
    if (!isR2Configured()) { res.status(503).json({ error: 'File storage not configured' }); return; }
    const file = req.file;
    if (!file) { res.status(400).json({ error: 'No file provided' }); return; }
    const recordId = String(req.params.id);
    const checkId = await checkForRecord(recordId, req.user!.role);
    const ext = (path.extname(file.originalname) || '').toLowerCase().replace(/[^.a-z0-9]/g, '').slice(0, 10);
    const fileId = randomUUID();
    const key = `${PREMISES_PREFIX}${checkId}/${recordId}/${fileId}${ext}`;
    await uploadToR2(key, file.buffer, file.mimetype || 'application/octet-stream');
    await addFile(recordId, {
      id: fileId, r2Key: key, filename: file.originalname || `file${ext}`, contentType: file.mimetype || null, size: file.size,
    }, caller(req));
    res.status(201).json({ data: { id: fileId, r2_key: key } });
  } catch (err) { fail(res, 'upload', err); }
});

router.post('/files/:id/archive', validate(idParam, 'params'), async (req: AuthRequest, res: Response) => {
  try { await archiveFile(String(req.params.id), caller(req)); res.json({ data: { archived: true } }); } catch (err) { fail(res, 'archive file', err); }
});

// ── Places and headings (admin) ──────────────────────────────────────────────

const nameSchema = z.object({ name: z.string().min(1).max(100) });
const taxonomyPatch = z.object({
  name: z.string().min(1).max(100).optional(),
  sort_order: z.number().int().optional(),
  retired: z.boolean().optional(),
});

for (const kind of ['places', 'headings'] as const) {
  router.post(`/${kind}`, validate(nameSchema), async (req: AuthRequest, res: Response) => {
    try { res.status(201).json({ data: await addTaxonomy(kind, req.body.name, caller(req)) }); } catch (err) { fail(res, `add ${kind}`, err); }
  });
  router.patch(`/${kind}/:id`, validate(idParam, 'params'), validate(taxonomyPatch), async (req: AuthRequest, res: Response) => {
    try { await updateTaxonomy(kind, String(req.params.id), req.body, caller(req)); res.json({ data: { ok: true } }); } catch (err) { fail(res, `change ${kind}`, err); }
  });
}

export default router;
