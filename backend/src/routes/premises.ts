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
 *   GET    /checks/:id/reading-check?value=&done_on=&replaced=1   a meter reading against its history (warning only)
 *   POST   /checks/:id/records           record that it was done
 *   POST   /checks/:id/history           { records: [...] } past records, filed later (spec §14)
 *   GET    /meters                       every meter I can see, last reading and use
 *   POST   /records/:id/remove           { reason } — a mistake (manager)
 *   POST   /records/:id/files            multipart `file` — a certificate / report / photo
 *   POST   /files/:id/archive            take a file off (manager or whoever added it)
 *   POST   /places | /headings           { name } (admin)
 *   PATCH  /places/:id | /headings/:id   { name?, sort_order?, retired? } (admin)
 *
 * Phase 3a (spec §15):
 *   POST   /records/:id/advisories       { texts: [...] } add advisories to a record
 *   POST   /advisories/:id/task          make it a To Do
 *   POST   /advisories/:id/done          { done } tick it off (or back on)
 *   GET    /checks/:id/linkable-costs?search=   bills in Costs to link a record to
 *   POST   /records/:id/cost             { cost_id | null } link / unlink the bill
 *   GET    /library                      folders and documents I can see
 *   POST   /documents                    add a document (manager)
 *   PATCH  /documents/:id                change it (manager)
 *   POST   /documents/:id/archive        archive it (manager)
 *   POST   /documents/:id/files          multipart `file` — a new version (manager)
 *   GET    /folders                      every folder, retired too (admin)
 *   POST   /folders                      { name, visibility } (admin)
 *   PATCH  /folders/:id                  { name?, visibility?, sort_order?, retired? } (admin)
 *
 * Phase 3b (spec §16):
 *   POST   /checks/:id/booking           { visit_on, visit_time, letting_in_person_id, note } book / change
 *   POST   /checks/:id/booking/cancel    call the booking off
 *   GET    /visits?from=&to=             booked visits for the staff calendar (what I can see)
 *   GET    /by-organisation/:id          the checks an organisation does for us (org page)
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
  PremisesError, PREMISES_PREFIX, addFile, addPastRecords, addTaxonomy, archiveFile, checkForRecord, checkReading,
  createCheck, deleteCheck, getCheck, getMeta, listChecks, listMeters, previewNextDue, recordCheck, removeRecord,
  retireCheck, unretireCheck, updateCheck, updateTaxonomy,
  addAdvisories, makeAdvisoryTask, setAdvisoryDone, linkableCosts, linkCost,
  bookVisit, cancelBooking, listVisits, listChecksForOrganisation,
} from '../services/premises';
import {
  getLibrary, listFolders, createDocument, updateDocument, archiveDocument, documentForUpload, addDocumentFile,
  addFolder, updateFolder,
} from '../services/premises-library';

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
  // Meter readings (phase 2): the unit and the meter's serial; a rotating test's call points.
  unit: optText(20),
  meter_serial: optText(60),
  points: z.array(z.string().max(80)).max(50).nullable().optional(),
  staff_document_id: z.string().guid().nullable().optional(),
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

router.get('/meters', async (req: AuthRequest, res: Response) => {
  try { res.json({ data: await listMeters(req.user!.role) }); } catch (err) { fail(res, 'meters', err); }
});

router.get('/checks/:id/reading-check', validate(idParam, 'params'), async (req: AuthRequest, res: Response) => {
  try {
    res.json({
      data: await checkReading(String(req.params.id), Number(req.query.value), String(req.query.done_on || ''),
        String(req.query.replaced || '') === '1', req.user!.role),
    });
  } catch (err) { fail(res, 'reading-check', err); }
});

router.get('/checks/:id/next-due', validate(idParam, 'params'), async (req: AuthRequest, res: Response) => {
  try {
    res.json({ data: await previewNextDue(String(req.params.id), String(req.query.done_on || ''), req.user!.role) });
  } catch (err) { fail(res, 'next-due', err); }
});

// ── Booking a visit (phase 3b) ───────────────────────────────────────────────

const bookingSchema = z.object({
  visit_on: ymd,
  visit_time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'must be a time (HH:MM)').nullable(),
  letting_in_person_id: z.string().guid().nullable(),
  note: optText(1000),
});

router.post('/checks/:id/booking', validate(idParam, 'params'), validate(bookingSchema), async (req: AuthRequest, res: Response) => {
  try {
    const b = req.body as z.infer<typeof bookingSchema>;
    res.json({ data: await bookVisit(String(req.params.id), { ...b, note: b.note ?? null }, caller(req)) });
  } catch (err) { fail(res, 'book visit', err); }
});

router.post('/checks/:id/booking/cancel', validate(idParam, 'params'), async (req: AuthRequest, res: Response) => {
  try { res.json({ data: await cancelBooking(String(req.params.id), caller(req)) }); } catch (err) { fail(res, 'cancel booking', err); }
});

router.get('/visits', async (req: AuthRequest, res: Response) => {
  try {
    res.json({ data: await listVisits(String(req.query.from || ''), String(req.query.to || ''), req.user!.role) });
  } catch (err) { fail(res, 'visits', err); }
});

router.get('/by-organisation/:id', validate(idParam, 'params'), async (req: AuthRequest, res: Response) => {
  try { res.json({ data: await listChecksForOrganisation(String(req.params.id), req.user!.role) }); } catch (err) { fail(res, 'by organisation', err); }
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
  point: optText(80),
  advisories: z.array(z.string().max(500)).max(30).nullable().optional(),
});

const toRecordInput = (b: z.infer<typeof recordSchema>) => ({
  done_on: b.done_on,
  outcome: b.outcome ?? null,
  done_by_org_id: b.done_by_org_id ?? null,
  notes: b.notes ?? null,
  next_due: b.next_due ?? null,
  reading_value: b.reading_value ?? null,
  meter_replaced: b.meter_replaced ?? false,
  point: b.point ?? null,
  advisories: b.advisories ?? null,
});

router.post('/checks/:id/records', validate(idParam, 'params'), validate(recordSchema), async (req: AuthRequest, res: Response) => {
  try {
    res.status(201).json({ data: await recordCheck(String(req.params.id), toRecordInput(req.body), caller(req)) });
  } catch (err) { fail(res, 'record', err); }
});

const historySchema = z.object({ records: z.array(recordSchema).min(1).max(50) });

router.post('/checks/:id/history', validate(idParam, 'params'), validate(historySchema), async (req: AuthRequest, res: Response) => {
  try {
    const b = req.body as z.infer<typeof historySchema>;
    res.status(201).json({ data: await addPastRecords(String(req.params.id), b.records.map(toRecordInput), caller(req)) });
  } catch (err) { fail(res, 'history', err); }
});

router.post('/records/:id/remove', validate(idParam, 'params'), validate(reasonSchema), async (req: AuthRequest, res: Response) => {
  try { res.json({ data: await removeRecord(String(req.params.id), req.body.reason ?? null, caller(req)) }); } catch (err) { fail(res, 'remove record', err); }
});

// ── Files ────────────────────────────────────────────────────────────────────

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024, files: 1 } });

/** One file from a multipart body, with a plain answer when it's too big. */
function oneFile(req: AuthRequest, res: Response, next: () => void) {
  upload.single('file')(req, res, (err: unknown) => {
    if (err instanceof multer.MulterError && err.code === 'LIMIT_FILE_SIZE') {
      res.status(413).json({ error: 'That file is over 20 MB' });
      return;
    }
    if (err) { fail(res, 'upload parse', err); return; }
    next();
  });
}

router.post('/records/:id/files', validate(idParam, 'params'), oneFile, async (req: AuthRequest, res: Response) => {
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

// ── Advisories and the bill (phase 3a) ───────────────────────────────────────

router.post('/records/:id/advisories', validate(idParam, 'params'),
  validate(z.object({ texts: z.array(z.string().max(500)).min(1).max(30) })), async (req: AuthRequest, res: Response) => {
    try { res.status(201).json({ data: await addAdvisories(String(req.params.id), req.body.texts, caller(req)) }); } catch (err) { fail(res, 'add advisories', err); }
  });

router.post('/advisories/:id/task', validate(idParam, 'params'), async (req: AuthRequest, res: Response) => {
  try { res.status(201).json({ data: await makeAdvisoryTask(String(req.params.id), caller(req)) }); } catch (err) { fail(res, 'advisory task', err); }
});

router.post('/advisories/:id/done', validate(idParam, 'params'), validate(z.object({ done: z.boolean() })), async (req: AuthRequest, res: Response) => {
  try { await setAdvisoryDone(String(req.params.id), req.body.done, caller(req)); res.json({ data: { ok: true } }); } catch (err) { fail(res, 'advisory done', err); }
});

router.get('/checks/:id/linkable-costs', validate(idParam, 'params'), async (req: AuthRequest, res: Response) => {
  try {
    res.json({ data: await linkableCosts(String(req.params.id), String(req.query.search || ''), req.user!.role) });
  } catch (err) { fail(res, 'linkable costs', err); }
});

router.post('/records/:id/cost', validate(idParam, 'params'), validate(z.object({ cost_id: z.string().guid().nullable() })), async (req: AuthRequest, res: Response) => {
  try { res.json({ data: await linkCost(String(req.params.id), req.body.cost_id, caller(req)) }); } catch (err) { fail(res, 'link cost', err); }
});

// ── The documents library (phase 3a) ─────────────────────────────────────────

router.get('/library', async (req: AuthRequest, res: Response) => {
  try { res.json({ data: await getLibrary(req.user!.role) }); } catch (err) { fail(res, 'library', err); }
});

const documentSchema = z.object({
  folder_id: z.string().guid(),
  title: z.string().min(1).max(200),
  visibility: z.enum(['all', 'managers', 'admins']).nullable(),
  place_id: z.string().guid().nullable(),
  notes: optText(4000),
});

router.post('/documents', validate(documentSchema), async (req: AuthRequest, res: Response) => {
  try {
    const b = req.body as z.infer<typeof documentSchema>;
    res.status(201).json({ data: await createDocument({ ...b, notes: b.notes ?? null }, caller(req)) });
  } catch (err) { fail(res, 'add document', err); }
});

router.patch('/documents/:id', validate(idParam, 'params'), validate(partialForUpdate(documentSchema)), async (req: AuthRequest, res: Response) => {
  try { await updateDocument(String(req.params.id), req.body, caller(req)); res.json({ data: { ok: true } }); } catch (err) { fail(res, 'change document', err); }
});

router.post('/documents/:id/archive', validate(idParam, 'params'), async (req: AuthRequest, res: Response) => {
  try { await archiveDocument(String(req.params.id), caller(req)); res.json({ data: { archived: true } }); } catch (err) { fail(res, 'archive document', err); }
});

router.post('/documents/:id/files', validate(idParam, 'params'), oneFile, async (req: AuthRequest, res: Response) => {
  try {
    if (!isR2Configured()) { res.status(503).json({ error: 'File storage not configured' }); return; }
    const file = req.file;
    if (!file) { res.status(400).json({ error: 'No file provided' }); return; }
    const documentId = String(req.params.id);
    await documentForUpload(documentId, caller(req));
    const ext = (path.extname(file.originalname) || '').toLowerCase().replace(/[^.a-z0-9]/g, '').slice(0, 10);
    const fileId = randomUUID();
    const key = `${PREMISES_PREFIX}library/${documentId}/${fileId}${ext}`;
    await uploadToR2(key, file.buffer, file.mimetype || 'application/octet-stream');
    await addDocumentFile(documentId, {
      id: fileId, r2Key: key, filename: file.originalname || `file${ext}`, contentType: file.mimetype || null, size: file.size,
    }, caller(req));
    res.status(201).json({ data: { id: fileId, r2_key: key } });
  } catch (err) { fail(res, 'upload version', err); }
});

router.get('/folders', async (req: AuthRequest, res: Response) => {
  try { res.json({ data: await listFolders(req.user!.role) }); } catch (err) { fail(res, 'folders', err); }
});

router.post('/folders', validate(z.object({ name: z.string().min(1).max(100), visibility: z.enum(['all', 'managers', 'admins']) })),
  async (req: AuthRequest, res: Response) => {
    try { res.status(201).json({ data: await addFolder(req.body.name, req.body.visibility, caller(req)) }); } catch (err) { fail(res, 'add folder', err); }
  });

router.patch('/folders/:id', validate(idParam, 'params'), validate(z.object({
  name: z.string().min(1).max(100).optional(),
  visibility: z.enum(['all', 'managers', 'admins']).optional(),
  sort_order: z.number().int().optional(),
  retired: z.boolean().optional(),
})), async (req: AuthRequest, res: Response) => {
  try { await updateFolder(String(req.params.id), req.body, caller(req)); res.json({ data: { ok: true } }); } catch (err) { fail(res, 'change folder', err); }
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
