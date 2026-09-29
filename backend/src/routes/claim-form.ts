/**
 * PUBLIC — the possible-claim client form (docs/INCIDENT-CLAIMS-SPEC.md Phase 2).
 *
 * Every route here is token-authenticated by the link in the URL; there is no
 * staff auth. Mounted at /api/claim-form. Rules that hold throughout:
 *
 *   - Nothing mutates on a GET (mail scanners follow links) — "opened" is a POST
 *     the page makes.
 *   - A link only ever sees driver NAMES. Personal details stay in OP; the
 *     driver's declaration answers appear only after the emailed code (D6/D7).
 *   - Only the client sections of the form are readable/writable — never the
 *     Ooosh-only ones (insured, cover, our vehicle value).
 *   - Staff-uploaded files are never shown: a link sees only files uploaded
 *     through the case's links.
 *   - Everything stops once the case leaves open / form_out.
 */
import { Router, Request, Response } from 'express';
import multer from 'multer';
import path from 'path';
import rateLimit from 'express-rate-limit';
import { v4 as uuid } from 'uuid';
import { query } from '../config/database';
import { uploadToR2, getFromR2, deleteFromR2, isR2Configured } from '../config/r2';
import {
  CLAIM_SECTIONS, CLIENT_SECTION_KEYS, sanitiseSection, resolveOutlineType,
} from '../services/claim-form-fields';
import {
  logClaimEvent, notifyClaimFollowers, claimLabel, nextWorkingDay, SHARED_BY_DEFAULT,
} from '../services/incident-claims';
import {
  LinkRow, OPEN_STAGES, resolveLink, driversOnVan, createAndSendLink, maskEmail,
  sendDriverCode, verifyDriverCode, readDriverSession, saveDamageMarks, saveSketch, hireFormDeclarations,
} from '../services/claim-links';

const router = Router();

const readLimiter = rateLimit({ windowMs: 60_000, max: 90, message: { error: 'Too many requests' }, standardHeaders: true, legacyHeaders: false });
const writeLimiter = rateLimit({ windowMs: 60_000, max: 40, message: { error: 'Too many requests' }, standardHeaders: true, legacyHeaders: false });
const codeLimiter = rateLimit({ windowMs: 60_000, max: 6, message: { error: 'Too many requests' }, standardHeaders: true, legacyHeaders: false });

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 15 * 1024 * 1024, files: 2 } });
const MAX_LINK_FILES = 60;

type Handler = (req: Request, res: Response, link: LinkRow) => Promise<void>;

/** Resolve the token; 404 for unknown / revoked. `needOpen` = writes need an open case. */
function withLink(needOpen: boolean, fn: Handler) {
  return async (req: Request, res: Response) => {
    try {
      const link = await resolveLink(String(req.params.token || ''));
      if (!link) { res.status(404).json({ error: 'This link is not valid. Please contact Ooosh.' }); return; }
      if (needOpen && !OPEN_STAGES.has(link.stage)) {
        res.status(409).json({ error: 'This form has been submitted and is now closed. Please contact Ooosh with anything else.' });
        return;
      }
      await fn(req, res, link);
    } catch (err) {
      console.error('[claim-form] error:', err);
      res.status(500).json({ error: 'Something went wrong — please try again.' });
    }
  };
}

const actorLabel = (link: LinkRow) =>
  `via link — ${link.filled_by_name || link.recipient_name || link.recipient_email || 'client'}`;

async function touch(claimId: string) {
  await query(`UPDATE incident_claims SET updated_at = NOW() WHERE id = $1`, [claimId]);
}

// ── Read ─────────────────────────────────────────────────────────────────

router.get('/:token', readLimiter, withLink(false, async (_req, res, link) => {
  const c = await query(
    `SELECT c.form_data, c.sections_done, c.damage_marks, c.sketch_key, c.driver_signed_at, c.driver_signed_name,
            c.driver_id, c.incident_at,
            COALESCE(fv.reg, c.vehicle_reg) AS reg, fv.make, fv.model, fv.vehicle_type, fv.simple_type, fv.outline_type,
            j.job_name
     FROM incident_claims c
     LEFT JOIN fleet_vehicles fv ON fv.id = c.vehicle_id
     LEFT JOIN jobs j ON j.id = c.job_id
     WHERE c.id = $1`,
    [link.claim_id],
  );
  const row = c.rows[0];
  const form = (row.form_data || {}) as Record<string, unknown>;
  const clientForm: Record<string, unknown> = {};
  for (const key of CLIENT_SECTION_KEYS) {
    if (form[key] !== undefined) clientForm[key] = form[key];
    if (form[`${key}_involved`] !== undefined) clientForm[`${key}_involved`] = form[`${key}_involved`];
  }
  const [drivers, files] = await Promise.all([
    driversOnVan(link),
    query(
      `SELECT f.id, f.filename, f.file_type, f.caption, f.content_type
       FROM incident_claim_files f
       JOIN incident_claim_links l ON l.id = f.uploaded_via_link_id AND l.claim_id = f.claim_id
       WHERE f.claim_id = $1 ORDER BY f.uploaded_at`,
      [link.claim_id],
    ),
  ]);
  res.json({
    data: {
      closed: !OPEN_STAGES.has(link.stage),
      vehicle: { reg: row.reg, make_model: [row.make, row.model].filter(Boolean).join(' '), outline: resolveOutlineType(row) },
      hh_job_number: link.hh_job_number,
      job_name: row.job_name,
      recipient_name: link.recipient_name,
      filled_as: link.filled_as,
      filled_by_name: link.filled_by_name,
      form: clientForm,
      sections_done: row.sections_done || {},
      damage_marks: row.damage_marks || [],
      has_sketch: !!row.sketch_key,
      driver_signed: !!row.driver_signed_at,
      driver_signed_name: row.driver_signed_at ? row.driver_signed_name : null,
      drivers: drivers.map((d) => ({ id: d.id, name: d.name, has_email: !!d.email })),
      files: files.rows,
    },
  });
}));

router.post('/:token/opened', writeLimiter, withLink(false, async (_req, res, link) => {
  const r = await query(
    `UPDATE incident_claim_links
        SET last_opened_at = NOW(),
            first_opened_at = COALESCE(first_opened_at, NOW()),
            status = CASE WHEN status = 'sent' THEN 'opened' ELSE status END
      WHERE id = $1
      RETURNING (first_opened_at = last_opened_at) AS first_time`,
    [link.id],
  );
  if (r.rows[0]?.first_time) {
    await logClaimEvent(link.claim_id, null, 'link_opened', `Form opened by ${link.recipient_name || link.recipient_email || 'a recipient'}`);
  }
  res.json({ data: { ok: true } });
}));

// ── "Who's filling this in?" + passing it on ─────────────────────────────

router.post('/:token/who', writeLimiter, withLink(true, async (req, res, link) => {
  const as = req.body?.as === 'driver' ? 'driver' : req.body?.as === 'witness' ? 'witness' : null;
  const name = typeof req.body?.name === 'string' ? req.body.name.trim().slice(0, 120) : '';
  if (!as || name.length < 2) { res.status(400).json({ error: 'Tell us your name and whether you were driving.' }); return; }
  await query(`UPDATE incident_claim_links SET filled_as = $2, filled_by_name = $3 WHERE id = $1`, [link.id, as, name]);
  await markDone(link.claim_id, 'who');
  await logClaimEvent(link.claim_id, null, 'who_filling', `${name} is filling in the form (${as === 'driver' ? 'was driving' : 'was not driving'})`);
  res.json({ data: { ok: true } });
}));

router.post('/:token/forward', writeLimiter, withLink(true, async (req, res, link) => {
  const name = typeof req.body?.name === 'string' ? req.body.name.trim().slice(0, 120) : '';
  const email = typeof req.body?.email === 'string' ? req.body.email.trim().slice(0, 200) : '';
  if (name.length < 2 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    res.status(400).json({ error: 'Please give their name and a valid email address.' });
    return;
  }
  const count = await query(`SELECT COUNT(*)::int AS n FROM incident_claim_links WHERE claim_id = $1`, [link.claim_id]);
  if (count.rows[0].n >= 25) { res.status(429).json({ error: 'This form has been passed on a lot — please contact Ooosh.' }); return; }
  const result = await createAndSendLink({
    claimId: link.claim_id, name, email, role: 'forwarded', handedOffFrom: link.id, createdBy: null,
    forwardedByName: link.filled_by_name || link.recipient_name || null,
  });
  if (!result.sent) { res.status(502).json({ error: 'We could not send the email — please check the address and try again.' }); return; }
  await query(`UPDATE incident_claim_links SET status = 'handed_off' WHERE id = $1 AND status IN ('sent', 'opened')`, [link.id]);
  await logClaimEvent(link.claim_id, null, 'handed_off',
    `${link.filled_by_name || link.recipient_name || 'A recipient'} passed the form on to ${name} (${maskEmail(email)})`,
    { from_link: link.id, to_link: result.linkId });
  res.json({ data: { ok: true } });
}));

// Non-driver asks the driver to do their part — the driver's email stays in OP.
router.post('/:token/send-to-driver', writeLimiter, withLink(true, async (req, res, link) => {
  const driverId = String(req.body?.driver_id || '');
  const d = (await driversOnVan(link)).find((x) => x.id === driverId);
  if (!d) { res.status(404).json({ error: 'That driver is not on this van.' }); return; }
  if (!d.email) { res.status(409).json({ error: "We don't have an email for that driver — please let us know how to reach them." }); return; }
  const result = await createAndSendLink({
    claimId: link.claim_id, name: d.name, email: d.email, driverId: d.id, role: 'driver', createdBy: null,
    forwardedByName: link.filled_by_name || link.recipient_name || null,
  });
  if (!result.sent) { res.status(502).json({ error: 'We could not send the email — please try again shortly.' }); return; }
  await logClaimEvent(link.claim_id, null, 'sent_to_driver', `Driver's part sent to ${d.name} by ${link.filled_by_name || link.recipient_name || 'a recipient'}`);
  res.json({ data: { ok: true, name: d.name, masked_email: maskEmail(d.email) } });
}));

// ── Sections ─────────────────────────────────────────────────────────────

async function markDone(claimId: string, key: string) {
  await query(
    `UPDATE incident_claims
        SET sections_done = sections_done || jsonb_build_object($2::text, to_jsonb(NOW())), updated_at = NOW()
      WHERE id = $1 AND NOT (sections_done ? $2::text)`,
    [claimId, key],
  );
}

router.post('/:token/section/:key', writeLimiter, withLink(true, async (req, res, link) => {
  const key = String(req.params.key);
  const def = CLAIM_SECTIONS.find((s) => s.key === key && s.who === 'client');
  if (!def) { res.status(404).json({ error: 'Unknown section' }); return; }
  const clean = sanitiseSection(def, req.body?.data);
  // Merge into form_data without touching any other section (Ooosh-only ones included).
  const patch: Record<string, unknown> = { [key]: clean };
  if (def.gate) {
    const g = req.body?.gate;
    patch[`${key}_involved`] = typeof g === 'boolean' ? g : null;
  }
  const inc = key === 'incident' && !Array.isArray(clean) ? clean : null;
  await query(
    `UPDATE incident_claims
        SET form_data = form_data || $2::jsonb,
            incident_at = CASE WHEN $3::boolean THEN $4::timestamptz ELSE incident_at END,
            incident_time_text = CASE WHEN $3::boolean THEN $5 ELSE incident_time_text END,
            incident_location = CASE WHEN $3::boolean THEN $6 ELSE incident_location END,
            updated_at = NOW()
      WHERE id = $1`,
    [
      link.claim_id, JSON.stringify(patch), !!inc,
      inc && typeof inc.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(inc.date) ? `${inc.date}T12:00:00Z` : null,
      inc && typeof inc.time === 'string' && inc.time.trim() ? inc.time.trim() : null,
      inc && typeof inc.place === 'string' && inc.place.trim() ? inc.place.trim() : null,
    ],
  );
  const first = await query(`SELECT (sections_done ? $2::text) AS done FROM incident_claims WHERE id = $1`, [link.claim_id, key]);
  if (!first.rows[0]?.done) {
    await markDone(link.claim_id, key);
    await logClaimEvent(link.claim_id, null, 'section_saved', `${def.title} completed (${actorLabel(link)})`);
  }
  res.json({ data: { ok: true } });
}));

// ── Driver's part (code → session → declarations + signature) ───────────

router.post('/:token/driver/code', codeLimiter, withLink(true, async (req, res, link) => {
  const r = await sendDriverCode(link, String(req.body?.driver_id || ''));
  if (!r.ok) { res.status(r.status).json({ error: r.error }); return; }
  res.json({ data: { masked_email: r.masked } });
}));

router.post('/:token/driver/verify', codeLimiter, withLink(true, async (req, res, link) => {
  const driverId = String(req.body?.driver_id || '');
  const r = await verifyDriverCode(link, driverId, String(req.body?.code || ''));
  if (!r.ok) { res.status(r.status).json({ error: r.error }); return; }
  const d = (await driversOnVan(link)).find((x) => x.id === driverId);
  await query(`UPDATE incident_claim_links SET filled_as = 'driver', filled_by_name = COALESCE(filled_by_name, $2) WHERE id = $1`, [link.id, d?.name ?? null]);
  await logClaimEvent(link.claim_id, null, 'driver_verified', `${d?.name || 'Driver'} confirmed they were driving (email code)`);
  res.json({ data: { session: r.session } });
}));

function requireDriver(req: Request, res: Response, link: LinkRow): string | null {
  const driverId = readDriverSession(link, req.header('x-claim-driver-session'));
  if (!driverId) { res.status(401).json({ error: 'Please confirm with the emailed code again.' }); return null; }
  return driverId;
}

router.post('/:token/driver/details', writeLimiter, withLink(false, async (req, res, link) => {
  const driverId = requireDriver(req, res, link);
  if (!driverId) return;
  const [d, c, decl] = await Promise.all([
    query(`SELECT full_name FROM drivers WHERE id = $1`, [driverId]),
    query(`SELECT form_data, driver_signed_at, driver_signed_name, driver_id FROM incident_claims WHERE id = $1`, [link.claim_id]),
    hireFormDeclarations(driverId),
  ]);
  const form = (c.rows[0]?.form_data || {}) as Record<string, unknown>;
  const signedByThisDriver = c.rows[0]?.driver_id === driverId && !!c.rows[0]?.driver_signed_at;
  res.json({
    data: {
      name: d.rows[0]?.full_name || '',
      hire_form: decl,
      answers: c.rows[0]?.driver_id === driverId ? (form.driver || {}) : {},
      signed: signedByThisDriver,
      signed_name: signedByThisDriver ? c.rows[0].driver_signed_name : null,
    },
  });
}));

router.post('/:token/driver/save', writeLimiter, withLink(true, async (req, res, link) => {
  const driverId = requireDriver(req, res, link);
  if (!driverId) return;
  const def = CLAIM_SECTIONS.find((s) => s.key === 'driver')!;
  const clean = sanitiseSection(def, req.body?.data);
  const sig = typeof req.body?.signature_png_base64 === 'string' ? req.body.signature_png_base64 : '';
  const printName = typeof req.body?.print_name === 'string' ? req.body.print_name.trim().slice(0, 120) : '';
  if (!sig || printName.length < 2) { res.status(400).json({ error: 'Please sign and print your name.' }); return; }
  const png = Buffer.from(sig.replace(/^data:image\/png;base64,/, ''), 'base64');
  if (png.length < 100 || png.length > 2_000_000 || png.subarray(1, 4).toString('ascii') !== 'PNG') {
    res.status(400).json({ error: 'The signature did not come through — please sign again.' });
    return;
  }
  const key = `claims/${link.claim_id}/driver-signature-${Date.now()}.png`;
  await uploadToR2(key, png, 'image/png');

  const before = await query(`SELECT driver_id FROM incident_claims WHERE id = $1`, [link.claim_id]);
  const assignment = await query(
    `SELECT id FROM vehicle_hire_assignments
     WHERE driver_id = $1 AND status <> 'cancelled'
       AND ($2::uuid IS NULL OR vehicle_id = $2)
       AND (($3::uuid IS NOT NULL AND job_id = $3) OR ($4::int IS NOT NULL AND job_id IS NULL AND hirehop_job_id = $4))
     ORDER BY created_at DESC LIMIT 1`,
    [driverId, link.vehicle_id, link.job_id, link.hh_job_number],
  );
  await query(
    `UPDATE incident_claims
        SET form_data = form_data || jsonb_build_object('driver', $2::jsonb),
            driver_id = $3, assignment_id = COALESCE($4, assignment_id),
            driver_declaration = $2::jsonb,
            driver_signature_key = $5, driver_signed_name = $6, driver_signed_at = NOW(),
            updated_at = NOW()
      WHERE id = $1`,
    [link.claim_id, JSON.stringify(clean), driverId, assignment.rows[0]?.id ?? null, key, printName],
  );
  await markDone(link.claim_id, 'driver');
  const d = await query(`SELECT full_name FROM drivers WHERE id = $1`, [driverId]);
  const prev = before.rows[0]?.driver_id;
  await logClaimEvent(link.claim_id, null, 'driver_signed',
    `${d.rows[0]?.full_name || 'The driver'} completed and signed the driver declaration${prev && prev !== driverId ? ' (a different driver had been set on the case)' : ''}`);
  res.json({ data: { ok: true } });
}));

// ── Files ────────────────────────────────────────────────────────────────

router.post('/:token/files', writeLimiter, upload.fields([{ name: 'file', maxCount: 1 }, { name: 'thumb', maxCount: 1 }]),
  withLink(true, async (req, res, link) => {
    if (!isR2Configured()) { res.status(503).json({ error: 'Uploads are unavailable right now — please try later.' }); return; }
    const files = req.files as Record<string, Express.Multer.File[]> | undefined;
    const file = files?.file?.[0];
    if (!file) { res.status(400).json({ error: 'No file received.' }); return; }
    const mime = file.mimetype || '';
    const isImage = mime.startsWith('image/');
    if (!isImage && mime !== 'application/pdf') { res.status(415).json({ error: 'Photos or PDFs only, please.' }); return; }
    const n = await query(`SELECT COUNT(*)::int AS n FROM incident_claim_files WHERE claim_id = $1 AND uploaded_via_link_id IS NOT NULL`, [link.claim_id]);
    if (n.rows[0].n >= MAX_LINK_FILES) { res.status(429).json({ error: 'That is the most files we can take here — please email any more to us.' }); return; }

    const requested = String(req.body?.file_type || '');
    const fileType = isImage ? 'photo' : requested === 'police_report' ? 'police_report' : 'other';
    const ext = (path.extname(file.originalname) || (isImage ? '.jpg' : '.pdf')).toLowerCase().replace(/[^.a-z0-9]/g, '').slice(0, 10);
    const fileId = uuid();
    const key = `claims/${link.claim_id}/${fileId}${ext}`;
    await uploadToR2(key, file.buffer, mime);
    let thumbKey: string | null = null;
    const thumb = files?.thumb?.[0];
    if (thumb && (thumb.mimetype || '').startsWith('image/')) {
      thumbKey = `claims/${link.claim_id}/${fileId}_thumb.jpg`;
      await uploadToR2(thumbKey, thumb.buffer, 'image/jpeg');
    }
    const takenRaw = typeof req.body?.taken_at === 'string' ? req.body.taken_at : '';
    const takenAt = takenRaw && !Number.isNaN(new Date(takenRaw).getTime()) ? new Date(takenRaw).toISOString() : null;
    const caption = typeof req.body?.caption === 'string' && req.body.caption.trim() ? req.body.caption.trim().slice(0, 500) : null;
    await query(
      `INSERT INTO incident_claim_files
         (id, claim_id, r2_key, thumb_r2_key, filename, file_type, content_type, size_bytes, caption, taken_at,
          share_with_insurer, uploaded_via_link_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
      [fileId, link.claim_id, key, thumbKey, file.originalname.slice(0, 255), fileType, mime, file.size, caption, takenAt,
       SHARED_BY_DEFAULT.has(fileType), link.id],
    );
    await logClaimEvent(link.claim_id, null, 'file_added', `${file.originalname.slice(0, 255)} (${actorLabel(link)})`, { file_id: fileId, file_type: fileType });
    await touch(link.claim_id);
    res.status(201).json({ data: { id: fileId, filename: file.originalname.slice(0, 255), file_type: fileType, caption } });
  }));

/** A file this case's links uploaded — never a staff upload. */
async function linkFile(link: LinkRow, fileId: string) {
  if (!/^[0-9a-f-]{36}$/i.test(fileId)) return null;
  const r = await query(
    `SELECT f.id, f.r2_key, f.thumb_r2_key, f.content_type, f.filename
     FROM incident_claim_files f
     JOIN incident_claim_links l ON l.id = f.uploaded_via_link_id AND l.claim_id = f.claim_id
     WHERE f.id = $1 AND f.claim_id = $2`,
    [fileId, link.claim_id],
  );
  return r.rows[0] || null;
}

router.get('/:token/files/:fileId/thumb', readLimiter, withLink(false, async (req, res, link) => {
  const f = await linkFile(link, String(req.params.fileId));
  if (!f || !(f.content_type || '').startsWith('image/')) { res.status(404).end(); return; }
  const obj = await getFromR2(f.thumb_r2_key || f.r2_key);
  if (!obj.Body) { res.status(404).end(); return; }
  res.setHeader('Content-Type', f.thumb_r2_key ? 'image/jpeg' : f.content_type);
  res.setHeader('Cache-Control', 'private, max-age=600');
  const stream = obj.Body as NodeJS.ReadableStream & { destroy?: () => void };
  res.on('close', () => { if (!res.writableEnded) stream.destroy?.(); });
  stream.on('error', () => res.destroy());
  stream.pipe(res);
}));

router.patch('/:token/files/:fileId', writeLimiter, withLink(true, async (req, res, link) => {
  const f = await linkFile(link, String(req.params.fileId));
  if (!f) { res.status(404).json({ error: 'File not found' }); return; }
  const caption = typeof req.body?.caption === 'string' ? req.body.caption.trim().slice(0, 500) || null : null;
  await query(`UPDATE incident_claim_files SET caption = $2 WHERE id = $1`, [f.id, caption]);
  res.json({ data: { ok: true } });
}));

router.delete('/:token/files/:fileId', writeLimiter, withLink(true, async (req, res, link) => {
  const f = await linkFile(link, String(req.params.fileId));
  if (!f) { res.status(404).json({ error: 'File not found' }); return; }
  await query(`DELETE FROM incident_claim_files WHERE id = $1`, [f.id]);
  for (const k of [f.r2_key, f.thumb_r2_key]) if (k) await deleteFromR2(k).catch(() => undefined);
  await logClaimEvent(link.claim_id, null, 'file_removed', `${f.filename} (${actorLabel(link)})`);
  res.json({ data: { ok: true } });
}));

// ── Damage marks + sketch ────────────────────────────────────────────────

router.post('/:token/damage', writeLimiter, withLink(true, async (req, res, link) => {
  const marks = await saveDamageMarks(link.claim_id, req.body?.marks, req.body?.png_base64, { userId: null, label: actorLabel(link) });
  res.json({ data: { marks } });
}));

router.post('/:token/sketch', writeLimiter, upload.single('file'), withLink(true, async (req, res, link) => {
  const file = req.file;
  if (!file || !(file.mimetype || '').startsWith('image/')) { res.status(400).json({ error: 'Please add a drawing or a photo of one.' }); return; }
  await saveSketch(link.claim_id, file, { userId: null, label: actorLabel(link) });
  res.json({ data: { ok: true } });
}));

router.get('/:token/sketch', readLimiter, withLink(false, async (_req, res, link) => {
  const r = await query(`SELECT sketch_key FROM incident_claims WHERE id = $1`, [link.claim_id]);
  const key = r.rows[0]?.sketch_key;
  if (!key) { res.status(404).end(); return; }
  const obj = await getFromR2(key);
  if (!obj.Body) { res.status(404).end(); return; }
  res.setHeader('Content-Type', key.endsWith('.png') ? 'image/png' : 'image/jpeg');
  res.setHeader('Cache-Control', 'no-store');
  (obj.Body as NodeJS.ReadableStream).pipe(res);
}));

// ── Submit ───────────────────────────────────────────────────────────────

router.post('/:token/submit', writeLimiter, withLink(true, async (_req, res, link) => {
  const c = await query(`SELECT sections_done, driver_signed_at, stage FROM incident_claims WHERE id = $1`, [link.claim_id]);
  const done = (c.rows[0]?.sections_done || {}) as Record<string, unknown>;
  const missing = ['who', ...CLIENT_SECTION_KEYS].filter((k) => !done[k])
    .map((k) => (k === 'who' ? "Who's filling this in" : CLAIM_SECTIONS.find((s) => s.key === k)?.title || k));
  if (!c.rows[0]?.driver_signed_at) missing.push("The driver's declaration and signature");
  if (missing.length) { res.status(400).json({ error: 'Not quite finished', missing }); return; }

  await query(
    `UPDATE incident_claims
        SET stage = 'submitted', submitted_at = NOW(), submitted_via_link_id = $2,
            next_check_on = $3::date, updated_at = NOW()
      WHERE id = $1 AND stage IN ('open', 'form_out')`,
    [link.claim_id, link.id, nextWorkingDay()],
  );
  await query(`UPDATE incident_claim_links SET status = 'submitted' WHERE claim_id = $1 AND status <> 'revoked'`, [link.claim_id]);
  await logClaimEvent(link.claim_id, null, 'stage_change', `Form submitted by ${link.filled_by_name || link.recipient_name || 'the client'}`,
    { from: c.rows[0].stage, to: 'submitted', via_link: link.id });
  await notifyClaimFollowers(link.claim_id, null, `Claim form submitted — ${claimLabel(link)}`, 'The client has submitted the incident form. It needs a manager to review.');
  res.json({ data: { ok: true } });
}));

export default router;
