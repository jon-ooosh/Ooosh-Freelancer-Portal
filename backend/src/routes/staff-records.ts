/**
 * Staff Records — private files held ABOUT a staff member.
 *
 * Phase 1 of docs/STAFF-RECORDS-SPEC.md §8. Contracts, right-to-work evidence,
 * ID documents: the things that lived on the Monday.com board until it expired
 * and have lived in jon's inbox since.
 *
 * THE ACCESS RULE, and why it is narrower than the rest of the platform:
 * everything here is admin-only, through STAFF_ADMIN_ROLES — the constant the
 * staff calendar already gates employment, salary and reviews on. Not
 * MANAGER_ROLES. This is passports and contracts for seven people; the blast
 * radius of getting it wrong is worse than the inconvenience of a narrow gate
 * (spec §2).
 *
 * THE STORAGE RULE: objects go under `staff-records/`, never `files/`.
 * GET /api/files/download authorises by PREFIX and every other prefix it
 * serves is readable by any authenticated caller, freelancers included. That
 * route carries a matching admin check for this prefix — the two must stay in
 * step, which is why the prefix and the role list are exported from here and
 * imported there rather than written down twice.
 *
 * DATES: each record carries its own document date, printed expiry and — since
 * migration 243 — ONE action date (remind, or flag for deletion) that the
 * 09:45 scan fires on. Staff records win for anything about staff and read
 * nothing from `drivers`: that system checks hire CLIENTS (spec §19.1, §21.3).
 * The action date is pre-filled by the form from the type's interval
 * (GET /action-defaults) and is the admin's to change. Spec §22.
 */

import { Router, Response } from 'express';
import multer from 'multer';
import path from 'path';
import { v4 as uuid } from 'uuid';
import { z } from 'zod';
import { authenticate, authorize, AuthRequest } from '../middleware/auth';
import { validate } from '../middleware/validate';
import { uploadToR2, deleteFromR2, isR2Configured } from '../config/r2';
import { query } from '../config/database';
import { STAFF_ADMIN_ROLES } from '../services/staff-employment';

/** R2 prefix for everything this module stores. Imported by routes/files.ts. */
export const STAFF_RECORDS_PREFIX = 'staff-records/';

/** Who may read a staff record file. Imported by routes/files.ts. */
export const STAFF_RECORD_ROLES = STAFF_ADMIN_ROLES;

const router = Router();
router.use(authenticate);

const adminOnly = authorize(...STAFF_ADMIN_ROLES);

export const DOC_TYPES = [
  'contract', 'right_to_work', 'passport', 'licence',
  'dvla_check', 'qualification', 'medical', 'other',
] as const;

// Same ceiling and extension list as the general file uploader, minus the
// archive formats — nothing about an employment record wants to be a .zip, and
// a type you can't preview is a type nobody checks.
const ALLOWED_EXT = [
  '.pdf', '.doc', '.docx', '.xls', '.xlsx', '.txt', '.rtf',
  '.jpg', '.jpeg', '.png', '.webp', '.heic',
];

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (ALLOWED_EXT.includes(ext)) cb(null, true);
    else cb(new Error(`File type ${ext} not allowed`));
  },
});

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const ACTION_KINDS = ['remind', 'delete'] as const;
const ACTION_DELIVERIES = ['notification', 'email', 'both'] as const;
// Who hears about it. Stored as a user id (or NULL for every admin), but the
// API speaks in these two words so the client never has to know its own id.
const ACTION_RECIPIENTS = ['me', 'admins'] as const;

const updateFileSchema = z.object({
  label: z.string().min(1).max(200).optional(),
  doc_type: z.enum(DOC_TYPES).optional(),
  notes: z.string().max(2000).nullable().optional(),
  // The document's own FROM date — signed / issued / checked. Spec §1.3:
  // never a "valid until", which Phase 6 derives from this instead.
  document_date: z.union([z.string().regex(DATE_RE), z.literal(''), z.null()]).optional(),
  // The expiry printed ON the document. A different fact from document_date,
  // and not derivable from it — see migration 234.
  expires_on: z.union([z.string().regex(DATE_RE), z.literal(''), z.null()]).optional(),
  // The one dated action (mig 243). '' / null clears the date.
  action_on: z.union([z.string().regex(DATE_RE), z.literal(''), z.null()]).optional(),
  action_kind: z.enum(ACTION_KINDS).optional(),
  action_delivery: z.enum(ACTION_DELIVERIES).optional(),
  action_recipient: z.enum(ACTION_RECIPIENTS).optional(),
  action_note: z.string().max(500).nullable().optional(),
});

interface FileRow {
  id: string;
  label: string;
  doc_type: string;
  r2_key: string;
  filename: string;
  content_type: string | null;
  size_bytes: string | null;
  notes: string | null;
  document_date: string | null;
  expires_on: string | null;
  action_on: string | null;
  action_kind: 'remind' | 'delete';
  action_delivery: 'notification' | 'email' | 'both';
  action_user_id: string | null;
  action_note: string | null;
  action_chased_at: string | null;
  uploaded_at: string;
  uploaded_by_name: string | null;
}

const SELECT_FILES = `
  SELECT f.id, f.label, f.doc_type, f.r2_key, f.filename, f.content_type,
         f.size_bytes, f.notes, f.document_date::text AS document_date,
         f.expires_on::text AS expires_on,
         f.action_on::text AS action_on, f.action_kind, f.action_delivery,
         f.action_user_id, f.action_note, f.action_chased_at,
         f.uploaded_at,
         NULLIF(TRIM(COALESCE(up.preferred_name, up.first_name, '') || ' ' ||
                     COALESCE(up.last_name, '')), '') AS uploaded_by_name
    FROM staff_record_files f
    LEFT JOIN users u  ON f.uploaded_by = u.id
    LEFT JOIN people up ON u.person_id = up.id
   WHERE f.deleted_at IS NULL`;

// GET /api/staff-records/action-defaults — what the upload form pre-fills
// the action date from: months per doc_type, and the lead before a printed
// expiry. The rule itself is the form's (suggestActionDate); these are its
// inputs, from system_settings, so they change without a deploy.
router.get('/action-defaults', adminOnly, async (_req: AuthRequest, res: Response) => {
  try {
    const { getReviewIntervals } = await import('../services/staff-doc-cycles');
    const { getDocumentExpiryLeadDays } = await import('../services/staff-settings');
    const [intervals, expiryLeadDays] = await Promise.all([getReviewIntervals(), getDocumentExpiryLeadDays()]);
    res.json({ data: { intervals, expiryLeadDays } });
  } catch (err) {
    console.error('[staff-records] action defaults error:', err);
    res.status(500).json({ error: 'Failed to load the defaults' });
  }
});

// GET /api/staff-records/:personId/files
router.get('/:personId/files', adminOnly, async (req: AuthRequest, res: Response) => {
  try {
    const personId = req.params.personId as string;
    if (!UUID_RE.test(personId)) {
      res.status(400).json({ error: 'personId must be a UUID' });
      return;
    }
    const result = await query(
      `${SELECT_FILES} AND f.person_id = $1 ORDER BY f.uploaded_at DESC`,
      [personId]
    );
    res.json({ data: result.rows as FileRow[] });
  } catch (err) {
    console.error('[staff-records] list files error:', err);
    res.status(500).json({ error: 'Failed to load files' });
  }
});

// POST /api/staff-records/:personId/files  (multipart: file, label, doc_type, notes)
router.post('/:personId/files', adminOnly, upload.single('file'), async (req: AuthRequest, res: Response) => {
  try {
    const personId = req.params.personId as string;
    if (!UUID_RE.test(personId)) {
      res.status(400).json({ error: 'personId must be a UUID' });
      return;
    }
    if (!req.file) {
      res.status(400).json({ error: 'No file provided' });
      return;
    }
    if (!isR2Configured()) {
      res.status(503).json({ error: 'File storage is not configured' });
      return;
    }

    const docType = String(req.body.doc_type || 'other');
    if (!(DOC_TYPES as readonly string[]).includes(docType)) {
      res.status(400).json({ error: 'Unknown document type' });
      return;
    }

    // The person must exist. Without this an upload against a mistyped UUID
    // lands bytes in R2 that no row will ever reference.
    const person = await query('SELECT id FROM people WHERE id = $1', [personId]);
    if (!person.rows.length) {
      res.status(404).json({ error: 'Person not found' });
      return;
    }

    // Label defaults to the filename rather than being required: an upload
    // that is refused for want of a label is an upload that doesn't happen.
    const label = String(req.body.label || '').trim() || req.file.originalname;
    const notes = String(req.body.notes || '').trim() || null;
    const documentDate = String(req.body.document_date || '').trim() || null;
    const expiresOn = String(req.body.expires_on || '').trim() || null;
    const actionOn = String(req.body.action_on || '').trim() || null;
    const actionKind = String(req.body.action_kind || 'remind');
    const actionDelivery = String(req.body.action_delivery || 'both');
    const actionRecipient = String(req.body.action_recipient || 'me');
    // Same 500 cap as the PATCH schema.
    const actionNote = String(req.body.action_note || '').trim().slice(0, 500) || null;
    if (!(ACTION_KINDS as readonly string[]).includes(actionKind)
        || !(ACTION_DELIVERIES as readonly string[]).includes(actionDelivery)
        || !(ACTION_RECIPIENTS as readonly string[]).includes(actionRecipient)) {
      res.status(400).json({ error: 'Unknown action setting' });
      return;
    }
    for (const [name, value] of [['document_date', documentDate], ['expires_on', expiresOn], ['action_on', actionOn]] as const) {
      if (value && !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
        res.status(400).json({ error: `${name} must be YYYY-MM-DD` });
        return;
      }
    }

    const ext = path.extname(req.file.originalname).toLowerCase();
    // The original filename is NOT part of the key — staff name files things
    // like "Will passport.pdf", and an R2 key is visible wherever the key
    // travels. The name is kept in the row, where the admin gate covers it.
    const key = `${STAFF_RECORDS_PREFIX}${personId}/${uuid()}${ext}`;

    await uploadToR2(key, req.file.buffer, req.file.mimetype || 'application/octet-stream');

    let inserted;
    try {
      inserted = await query(
        `INSERT INTO staff_record_files
           (person_id, label, doc_type, r2_key, filename, content_type, size_bytes, notes, document_date, expires_on,
            action_on, action_kind, action_delivery, action_user_id, action_note, uploaded_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::date, $10::date, $11::date, $12, $13, $14, $15, $16)
         RETURNING id`,
        [personId, label, docType, key, req.file.originalname,
         req.file.mimetype || null, req.file.size, notes, documentDate, expiresOn,
         actionOn, actionKind, actionDelivery,
         actionRecipient === 'me' ? req.user!.id : null, actionNote,
         req.user!.id]
      );
    } catch (dbErr) {
      // Don't leave an orphaned object holding someone's passport in a bucket
      // nothing points at.
      await deleteFromR2(key).catch(() => undefined);
      throw dbErr;
    }

    const row = await query(`${SELECT_FILES} AND f.id = $1`, [inserted.rows[0].id]);
    res.status(201).json({ data: row.rows[0] as FileRow });
  } catch (err) {
    console.error('[staff-records] upload error:', err);
    res.status(500).json({ error: err instanceof Error ? err.message : 'Upload failed' });
  }
});

// PATCH /api/staff-records/files/:id — relabel / retype / re-note
router.patch('/files/:id', adminOnly, validate(updateFileSchema), async (req: AuthRequest, res: Response) => {
  try {
    const id = req.params.id as string;
    if (!UUID_RE.test(id)) {
      res.status(400).json({ error: 'id must be a UUID' });
      return;
    }
    const {
      label, doc_type, notes, document_date, expires_on,
      action_on, action_kind, action_delivery, action_recipient, action_note,
    } = req.body as z.infer<typeof updateFileSchema>;

    const sets: string[] = [];
    const params: unknown[] = [];
    if (label !== undefined)    { sets.push(`label = $${params.length + 1}`);    params.push(label); }
    if (doc_type !== undefined) { sets.push(`doc_type = $${params.length + 1}`); params.push(doc_type); }
    if (notes !== undefined)    { sets.push(`notes = $${params.length + 1}`);    params.push(notes || null); }
    // '' clears the date; absent leaves it alone.
    if (document_date !== undefined) {
      sets.push(`document_date = $${params.length + 1}::date`);
      params.push(document_date || null);
    }
    if (expires_on !== undefined) {
      sets.push(`expires_on = $${params.length + 1}::date`);
      params.push(expires_on || null);
    }
    // The action. A CHANGED date or kind is a fresh promise, so it earns a
    // fresh nudge — the same rule as re-dating a to-do. Only when it actually
    // changed: the edit form sends every field, and re-saving an untouched
    // record must not re-fire a reminder that has already gone out. In an
    // UPDATE the right-hand side reads the OLD row, so IS DISTINCT FROM
    // compares before against after.
    const rearm: string[] = [];
    if (action_on !== undefined) {
      const n = params.length + 1;
      sets.push(`action_on = $${n}::date`);
      rearm.push(`action_on IS DISTINCT FROM $${n}::date`);
      params.push(action_on || null);
    }
    if (action_kind !== undefined) {
      const n = params.length + 1;
      sets.push(`action_kind = $${n}::text`);
      rearm.push(`action_kind IS DISTINCT FROM $${n}::text`);
      params.push(action_kind);
    }
    if (rearm.length) {
      sets.push(`action_chased_at = CASE WHEN ${rearm.join(' OR ')} THEN NULL ELSE action_chased_at END`);
    }
    if (action_delivery !== undefined) {
      sets.push(`action_delivery = $${params.length + 1}`);
      params.push(action_delivery);
    }
    if (action_recipient !== undefined) {
      sets.push(`action_user_id = $${params.length + 1}`);
      params.push(action_recipient === 'me' ? req.user!.id : null);
    }
    if (action_note !== undefined) {
      sets.push(`action_note = $${params.length + 1}`);
      params.push(action_note?.trim() || null);
    }
    if (!sets.length) {
      res.status(400).json({ error: 'No fields to update' });
      return;
    }

    params.push(id);
    const updated = await query(
      `UPDATE staff_record_files SET ${sets.join(', ')}
        WHERE id = $${params.length} AND deleted_at IS NULL
        RETURNING id`,
      params
    );
    if (!updated.rows.length) {
      res.status(404).json({ error: 'File not found' });
      return;
    }

    const row = await query(`${SELECT_FILES} AND f.id = $1`, [id]);
    res.json({ data: row.rows[0] as FileRow });
  } catch (err) {
    console.error('[staff-records] update error:', err);
    res.status(500).json({ error: 'Failed to update the file' });
  }
});

// DELETE /api/staff-records/files/:id — soft-delete the row, hard-delete the bytes
router.delete('/files/:id', adminOnly, async (req: AuthRequest, res: Response) => {
  try {
    const id = req.params.id as string;
    if (!UUID_RE.test(id)) {
      res.status(400).json({ error: 'id must be a UUID' });
      return;
    }

    // Soft-delete FIRST so a failed R2 delete can't leave a row pointing at
    // bytes that are already gone. CLAUDE.md's soft-cancel rule: the row is
    // the record that the document existed and who removed it. The BYTES go
    // for real — keeping a passport scan nobody can see is the worst of both.
    const removed = await query(
      `UPDATE staff_record_files
          SET deleted_at = NOW(), deleted_by = $2
        WHERE id = $1 AND deleted_at IS NULL
        RETURNING r2_key`,
      [id, req.user!.id]
    );
    if (!removed.rows.length) {
      res.status(404).json({ error: 'File not found' });
      return;
    }

    try {
      await deleteFromR2(removed.rows[0].r2_key as string);
    } catch (r2Err) {
      // The row is already gone from every surface; a stranded object is a
      // cleanup job, not a failed request the admin should retry.
      console.error('[staff-records] R2 delete failed for', removed.rows[0].r2_key, r2Err);
    }

    res.json({ data: { id } });
  } catch (err) {
    console.error('[staff-records] delete error:', err);
    res.status(500).json({ error: 'Failed to delete the file' });
  }
});

export default router;
