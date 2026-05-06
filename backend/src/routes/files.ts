import { Router, Response } from 'express';
import multer from 'multer';
import path from 'path';
import { v4 as uuid } from 'uuid';
import { z } from 'zod';
import { authenticate, authorize, AuthRequest, STAFF_ROLES } from '../middleware/auth';
import { validate } from '../middleware/validate';
import { uploadToR2, deleteFromR2, getFromR2, isR2Configured } from '../config/r2';
import { query } from '../config/database';
import emailService from '../services/email-service';

const router = Router();
router.use(authenticate);

// 10MB limit, common file types for an operations platform
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const allowed = [
      // Documents
      '.pdf', '.doc', '.docx', '.xls', '.xlsx', '.csv', '.txt', '.rtf',
      // Images
      '.jpg', '.jpeg', '.png', '.gif', '.webp', '.svg',
      // Other common
      '.zip', '.rar',
    ];
    const ext = path.extname(file.originalname).toLowerCase();
    if (allowed.includes(ext)) {
      cb(null, true);
    } else {
      cb(new Error(`File type ${ext} not allowed`));
    }
  },
});

function getFileType(ext: string): 'document' | 'image' | 'other' {
  const imageExts = ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.svg'];
  const docExts = ['.pdf', '.doc', '.docx', '.xls', '.xlsx', '.csv', '.txt', '.rtf'];
  if (imageExts.includes(ext)) return 'image';
  if (docExts.includes(ext)) return 'document';
  return 'other';
}

// Map entity_type to the interaction FK column
function getEntityFk(entityType: string): string | null {
  const map: Record<string, string> = {
    people: 'person_id',
    organisations: 'organisation_id',
    venues: 'venue_id',
    jobs: 'job_id',
  };
  return map[entityType] || null;
}

// POST /api/files/upload — upload a file to R2 and return metadata
//
// Two modes:
//
// 1) **Default (entity-anchored).** Caller supplies entity_type + entity_id;
//    file is uploaded, appended to the entity's `files` JSONB, and a
//    companion `📎 Uploaded file: …` interaction is written to the
//    activity timeline. Used by the Files tab on every detail page.
//
// 2) **`attachment_only=true` (interaction attachments).** Caller is staging
//    files to attach to a forthcoming `POST /api/interactions` call. We
//    upload to R2 and return ONLY the metadata blob; no entity files
//    JSONB write, no companion interaction. The caller passes the returned
//    metadata verbatim in the `attachments` array on the next interaction
//    POST. See docs/MESSAGING-SPEC.md §5.4.
router.post('/upload', upload.single('file'), async (req: AuthRequest, res: Response) => {
  try {
    if (!isR2Configured()) {
      res.status(503).json({ error: 'File storage not configured' });
      return;
    }

    if (!req.file) {
      res.status(400).json({ error: 'No file provided' });
      return;
    }

    // Mode 2: attachment_only — short-circuit, return metadata only.
    if (req.body.attachment_only === 'true' || req.body.attachment_only === true) {
      const ext = path.extname(req.file.originalname).toLowerCase();
      const fileId = uuid();
      // Scoped under user id so a casual reader can't enumerate someone
      // else's pending uploads via the download endpoint's prefix check.
      const key = `files/attachments/${req.user!.id}/${fileId}${ext}`;

      await uploadToR2(key, req.file.buffer, req.file.mimetype);

      res.status(201).json({
        r2_key: key,
        filename: req.file.originalname,
        content_type: req.file.mimetype,
        size_bytes: req.file.size,
        thumbnail_key: null, // generated lazily on first render — Phase B follow-up
      });
      return;
    }

    const { entity_type, entity_id, label, comment } = req.body;
    if (!entity_type || !entity_id) {
      res.status(400).json({ error: 'entity_type and entity_id are required' });
      return;
    }

    const validTypes = ['people', 'organisations', 'venues', 'interactions', 'jobs', 'drivers'];
    if (!validTypes.includes(entity_type)) {
      res.status(400).json({ error: 'Invalid entity_type' });
      return;
    }

    const ext = path.extname(req.file.originalname).toLowerCase();
    const fileId = uuid();
    const key = `files/${entity_type}/${entity_id}/${fileId}${ext}`;

    await uploadToR2(key, req.file.buffer, req.file.mimetype);

    const fileAttachment: Record<string, unknown> = {
      name: req.file.originalname,
      url: key,
      type: getFileType(ext),
      uploaded_at: new Date().toISOString(),
      uploaded_by: req.user!.email,
    };

    if (label && label.trim()) {
      fileAttachment.label = label.trim();
    }
    if (comment && comment.trim()) {
      fileAttachment.comment = comment.trim();
    }

    // Append to entity's files JSONB array
    await query(
      `UPDATE ${entity_type} SET files = COALESCE(files, '[]'::jsonb) || $1::jsonb, updated_at = NOW() WHERE id = $2`,
      [JSON.stringify([fileAttachment]), entity_id]
    );

    // Record as activity interaction
    const fkColumn = getEntityFk(entity_type);
    if (fkColumn) {
      const displayName = label && label.trim() ? `${label.trim()} (${req.file.originalname})` : req.file.originalname;
      await query(
        `INSERT INTO interactions (id, type, content, ${fkColumn}, created_by, created_at)
         VALUES ($1, 'note', $2, $3, $4, NOW())`,
        [uuid(), `📎 Uploaded file: ${displayName}`, entity_id, req.user!.id]
      );
    }

    res.status(201).json(fileAttachment);
  } catch (error) {
    console.error('File upload error:', error);
    if (error instanceof multer.MulterError) {
      if (error.code === 'LIMIT_FILE_SIZE') {
        res.status(413).json({ error: 'File too large (max 10MB)' });
        return;
      }
    }
    const message = error instanceof Error ? error.message : 'Upload failed';
    res.status(500).json({ error: message });
  }
});

// GET /api/files/download?key=... — stream file from R2
router.get('/download', async (req: AuthRequest, res: Response) => {
  try {
    const { key } = req.query;
    if (!key || typeof key !== 'string') {
      res.status(400).json({ error: 'key is required' });
      return;
    }

    // Validate key starts with known prefix to prevent path traversal
    const allowedPrefixes = [
      'files/',
      'backups/',
      'avatars/',
      'completion/',     // portal completion photos + signatures
      'delivery-notes/', // completion delivery-note PDFs
    ];
    if (!allowedPrefixes.some((p) => key.startsWith(p))) {
      res.status(403).json({ error: 'Invalid file key' });
      return;
    }

    const object = await getFromR2(key);

    if (!object.Body) {
      res.status(404).json({ error: 'File not found' });
      return;
    }

    const filename = path.basename(key);
    res.setHeader('Content-Disposition', `inline; filename="${filename}"`);
    if (object.ContentType) {
      res.setHeader('Content-Type', object.ContentType);
    }
    if (object.ContentLength) {
      res.setHeader('Content-Length', object.ContentLength);
    }

    // Stream the response
    const stream = object.Body as NodeJS.ReadableStream;
    stream.pipe(res);
  } catch (error) {
    console.error('File download error:', error);
    res.status(500).json({ error: 'Download failed' });
  }
});

// DELETE /api/files/delete — remove a file from R2 and the entity's files array
router.delete('/delete', async (req: AuthRequest, res: Response) => {
  try {
    const { key, entity_type, entity_id } = req.body;
    if (!key || !entity_type || !entity_id) {
      res.status(400).json({ error: 'key, entity_type, and entity_id are required' });
      return;
    }

    const validTypes = ['people', 'organisations', 'venues', 'interactions', 'jobs', 'drivers'];
    if (!validTypes.includes(entity_type)) {
      res.status(400).json({ error: 'Invalid entity_type' });
      return;
    }

    // Get file info before deleting (for activity log)
    let deletedFileName = 'file';
    const entity = await query(`SELECT files FROM ${entity_type} WHERE id = $1`, [entity_id]);
    if (entity.rows.length > 0) {
      const matchingFile = (entity.rows[0].files || []).find(
        (f: { url: string }) => f.url === key
      );
      if (matchingFile) {
        deletedFileName = matchingFile.label || matchingFile.name;
      }

      const files = (entity.rows[0].files || []).filter(
        (f: { url: string }) => f.url !== key
      );
      await query(
        `UPDATE ${entity_type} SET files = $1::jsonb, updated_at = NOW() WHERE id = $2`,
        [JSON.stringify(files), entity_id]
      );
    }

    // Remove from R2
    await deleteFromR2(key);

    // Record as activity interaction
    const fkColumn = getEntityFk(entity_type);
    if (fkColumn) {
      await query(
        `INSERT INTO interactions (id, type, content, ${fkColumn}, created_by, created_at)
         VALUES ($1, 'note', $2, $3, $4, NOW())`,
        [uuid(), `🗑️ Deleted file: ${deletedFileName}`, entity_id, req.user!.id]
      );
    }

    res.status(204).send();
  } catch (error) {
    console.error('File delete error:', error);
    res.status(500).json({ error: 'Delete failed' });
  }
});

// PATCH /api/files/update-metadata — update file metadata (e.g. share_with_freelancer toggle)
router.patch('/update-metadata', async (req: AuthRequest, res: Response) => {
  try {
    const { entity_type, entity_id, file_url, updates } = req.body;
    if (!entity_type || !entity_id || !file_url || !updates) {
      res.status(400).json({ error: 'entity_type, entity_id, file_url, and updates are required' });
      return;
    }

    const validTypes = ['people', 'organisations', 'venues', 'interactions', 'jobs', 'drivers'];
    if (!validTypes.includes(entity_type)) {
      res.status(400).json({ error: 'Invalid entity_type' });
      return;
    }

    // Only allow safe metadata fields to be updated
    const allowedFields = ['share_with_freelancer', 'label', 'comment'];
    const safeUpdates: Record<string, unknown> = {};
    for (const key of Object.keys(updates)) {
      if (allowedFields.includes(key)) {
        safeUpdates[key] = updates[key];
      }
    }

    const entity = await query(`SELECT files FROM ${entity_type} WHERE id = $1`, [entity_id]);
    if (entity.rows.length === 0) {
      res.status(404).json({ error: 'Entity not found' });
      return;
    }

    const files = (entity.rows[0].files || []).map(
      (f: Record<string, unknown>) => f.url === file_url ? { ...f, ...safeUpdates } : f
    );

    await query(
      `UPDATE ${entity_type} SET files = $1::jsonb, updated_at = NOW() WHERE id = $2`,
      [JSON.stringify(files), entity_id]
    );

    res.json({ success: true });
  } catch (error) {
    console.error('File metadata update error:', error);
    res.status(500).json({ error: 'Update failed' });
  }
});

// ── POST /api/files/email — send a stored file as an email attachment ──
//
// Generic resend tool used from the Files tab on Job/Person/Org/Venue
// detail pages. Pulls the file bytes from R2, composes a friendly
// message, sends to one or more recipients, and logs an `email`
// interaction on the linked entity for audit. Staff-only; freelancer
// access is via the `share_with_freelancer` flag on the file itself
// (handled separately by the portal route).
//
// The `external_share_acknowledged` flag is a deliberate sanity-check —
// the UI asks staff to tick a box before any email leaves the building.
// Stops accidental sends to non-Ooosh email addresses.

const STAFF_ENTITY_TYPES = ['jobs', 'people', 'organisations', 'venues', 'drivers'] as const;

const sendFileEmailSchema = z.object({
  entity_type: z.enum(STAFF_ENTITY_TYPES),
  entity_id: z.string().uuid(),
  file_url: z.string().min(1),
  recipients: z.array(z.object({
    email: z.string().email('Invalid email address'),
    name: z.string().max(120).optional(),
  })).min(1, 'At least one recipient required').max(10),
  message: z.string().max(2000).optional(),
  external_share_acknowledged: z.literal(true, {
    errorMap: () => ({ message: 'Please confirm you intend to send this externally.' }),
  }),
});

const ENTITY_FK_MAP: Record<string, string> = {
  people: 'person_id',
  organisations: 'organisation_id',
  venues: 'venue_id',
  jobs: 'job_id',
};

router.post('/email', authorize(...STAFF_ROLES), validate(sendFileEmailSchema), async (req: AuthRequest, res: Response) => {
  try {
    const { entity_type, entity_id, file_url, recipients, message } = req.body as {
      entity_type: typeof STAFF_ENTITY_TYPES[number];
      entity_id: string;
      file_url: string;
      recipients: Array<{ email: string; name?: string }>;
      message?: string;
    };

    // Look up the entity + locate the file metadata in its JSONB array
    const entityResult = await query(
      `SELECT files FROM ${entity_type} WHERE id = $1`,
      [entity_id]
    );
    if (entityResult.rows.length === 0) {
      res.status(404).json({ error: 'Entity not found' });
      return;
    }
    const files = (entityResult.rows[0].files || []) as Array<Record<string, unknown>>;
    const file = files.find((f) => f.url === file_url);
    if (!file) {
      res.status(404).json({ error: 'File not found on this entity' });
      return;
    }

    // Path-traversal / safety check on the R2 key — only allow files we own
    if (!String(file.url).startsWith('files/') && !String(file.url).startsWith('delivery-notes/')) {
      res.status(403).json({ error: 'Unsupported file location' });
      return;
    }

    // Pull bytes from R2
    let attachmentBuffer: Buffer | null = null;
    let contentType = String(file.contentType || '') || 'application/octet-stream';
    try {
      const r2Result = await getFromR2(String(file.url));
      if (!r2Result.Body) {
        res.status(404).json({ error: 'File body missing in storage' });
        return;
      }
      const chunks: Buffer[] = [];
      const stream = r2Result.Body as NodeJS.ReadableStream & AsyncIterable<Buffer>;
      for await (const chunk of stream) {
        chunks.push(Buffer.from(chunk as Uint8Array));
      }
      attachmentBuffer = Buffer.concat(chunks);
      if (r2Result.ContentType) contentType = r2Result.ContentType;
    } catch (err) {
      console.error('[file-email] R2 read failed:', err);
      res.status(502).json({ error: 'Could not read file from storage' });
      return;
    }

    // Assemble per-job context for the email body if we're on a job
    let jobRefLine = '';
    let jobReferenceLabel = '';
    if (entity_type === 'jobs') {
      const jobLookup = await query(
        `SELECT hh_job_number, job_name FROM jobs WHERE id = $1`,
        [entity_id]
      );
      if (jobLookup.rows.length > 0) {
        const j = jobLookup.rows[0];
        if (j.hh_job_number) {
          jobReferenceLabel = `#${j.hh_job_number}`;
          jobRefLine = `Job ref: #${j.hh_job_number}`;
        }
        if (j.job_name) {
          jobRefLine = jobReferenceLabel
            ? `${jobRefLine} — ${j.job_name}`
            : `Job: ${j.job_name}`;
        }
      }
    }

    const senderName = `${req.user?.email || 'the Ooosh team'}`;
    const fileName = String(file.name || path.basename(String(file.url)));

    // Compose lead paragraph: custom message wins if provided, otherwise default
    const defaultLead = jobReferenceLabel
      ? `Please find attached the document for job ${jobReferenceLabel}.`
      : `Please find attached the document.`;
    const leadParagraph = message?.trim() || defaultLead;

    const subjectLine = jobReferenceLabel
      ? `Document from Ooosh Tours — ${fileName} (job ${jobReferenceLabel})`
      : `Document from Ooosh Tours — ${fileName}`;

    // Send per recipient (parallel — small N, capped at 10)
    const results = await Promise.all(recipients.map(async (recipient) => {
      try {
        const result = await emailService.send('file_resend', {
          to: recipient.email,
          variables: {
            recipientName: recipient.name?.trim() || 'there',
            leadParagraph,
            fileName,
            jobRefLine,
            senderName,
            subjectLine,
          },
          attachments: [{
            filename: fileName,
            content: attachmentBuffer!,
            contentType,
          }],
        });
        return { email: recipient.email, success: result.success, error: result.error };
      } catch (err) {
        return {
          email: recipient.email,
          success: false,
          error: err instanceof Error ? err.message : 'Send failed',
        };
      }
    }));

    const sentEmails = results.filter(r => r.success).map(r => r.email);
    const failedEmails = results.filter(r => !r.success).map(r => r.email);

    // Log interaction so the action is visible on Activity Timeline
    const fkColumn = ENTITY_FK_MAP[entity_type];
    if (fkColumn && sentEmails.length > 0) {
      const fileLabel = file.label ? ` (${file.label})` : '';
      const content = `📎 Sent file "${fileName}"${fileLabel} to ${sentEmails.join(', ')}`;
      try {
        await query(
          `INSERT INTO interactions (id, type, content, ${fkColumn}, created_by, created_at)
           VALUES ($1, 'email', $2, $3, $4, NOW())`,
          [uuid(), content, entity_id, req.user!.id]
        );
      } catch (err) {
        // Non-fatal — email already left
        console.error('[file-email] Interaction log failed:', err);
      }
    }

    res.json({
      success: failedEmails.length === 0,
      sent: sentEmails.length,
      failed: failedEmails.length,
      results,
    });
  } catch (error) {
    console.error('File email error:', error);
    res.status(500).json({ error: 'Email send failed' });
  }
});

export default router;
