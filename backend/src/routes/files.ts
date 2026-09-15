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

// 25MB limit, common file types for an operations platform
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 },
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
        `INSERT INTO interactions (id, type, content, ${fkColumn}, created_by, created_at, source)
         VALUES ($1, 'note', $2, $3, $4, NOW(), 'system')`,
        [uuid(), `📎 Uploaded file: ${displayName}`, entity_id, req.user!.id]
      );
    }

    res.status(201).json(fileAttachment);
  } catch (error) {
    console.error('File upload error:', error);
    if (error instanceof multer.MulterError) {
      if (error.code === 'LIMIT_FILE_SIZE') {
        res.status(413).json({ error: 'File too large (max 25MB)' });
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
      'carnet-authority/', // carnet Letter of Authorisation PDFs
      'email-quotes/',   // harvested quote PDFs (auto-chase §7.3 version diff)
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

    // Delete guard — a file with live links out of it is BLOCKED, not silently
    // unlinked. Someone deliberately surfaced this file on a band; removing it
    // from under them without a word is how a rider quietly vanishes mid-tour.
    // Note this only covers EXPLICIT links (job → org). The org → job direction
    // is derived at read time and has no rows to check, so deleting an org's own
    // file does remove it from every job it was surfacing on — correct, because
    // the org owns it.
    const linkedTo = await query(
      `SELECT COALESCE(o.name, 'another record') AS name
         FROM file_links fl
         LEFT JOIN organisations o
           ON o.id = fl.linked_entity_id AND fl.linked_entity_type = 'organisations'
        WHERE fl.r2_key = $1
          AND fl.owner_entity_type = $2
          AND fl.owner_entity_id = $3::uuid`,
      [key, entity_type, entity_id]
    );
    if (linkedTo.rows.length > 0) {
      const names = [...new Set(linkedTo.rows.map((r: { name: string }) => r.name))].join(', ');
      res.status(409).json({
        error: `Can't delete — this file is linked to ${names}. Unlink it there first.`,
      });
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

    // Remove from R2 — skip for external links (type: 'link'), which have an
    // http(s) URL as their "key" and no object in our bucket.
    if (!/^https?:\/\//i.test(String(key))) {
      await deleteFromR2(key);
    }

    // Record as activity interaction
    const fkColumn = getEntityFk(entity_type);
    if (fkColumn) {
      await query(
        `INSERT INTO interactions (id, type, content, ${fkColumn}, created_by, created_at, source)
         VALUES ($1, 'note', $2, $3, $4, NOW(), 'system')`,
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
    // `show_on_jobs` (default true when absent) controls whether an ORG's file
    // surfaces read-through on that org's jobs — the toggle that lets an internal
    // contract stay put while a rider travels. See CROSS-ENTITY-FILES-SPEC.md.
    const allowedFields = ['share_with_freelancer', 'label', 'comment', 'show_on_jobs'];
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

// POST /api/files/add-link — store an external URL as a FileAttachment.
//
// A "link" is a FileAttachment whose `url` is an http(s) address rather than
// an R2 storage key (type: 'link'). We host no bytes — it's a pointer to a
// client's Dropbox / WeTransfer / Google Drive etc. Sits in the same files
// JSONB array as uploaded files so tags, comments, share-with-freelancer and
// the filter row all apply. Generic over every entity type.
router.post('/add-link', async (req: AuthRequest, res: Response) => {
  try {
    const { entity_type, entity_id, url, name, label, comment, share_with_freelancer } = req.body;
    if (!entity_type || !entity_id || !url) {
      res.status(400).json({ error: 'entity_type, entity_id, and url are required' });
      return;
    }

    const validTypes = ['people', 'organisations', 'venues', 'interactions', 'jobs', 'drivers'];
    if (!validTypes.includes(entity_type)) {
      res.status(400).json({ error: 'Invalid entity_type' });
      return;
    }

    // Validate it's a real http(s) URL — guards against javascript: / data:
    // and other unsafe schemes. Bare domains (no scheme) get https:// prepended.
    const raw = String(url).trim();
    let parsed: URL;
    try {
      parsed = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
    } catch {
      res.status(400).json({ error: 'Invalid URL' });
      return;
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      res.status(400).json({ error: 'Only http(s) links are allowed' });
      return;
    }

    const displayName = (name && String(name).trim()) || parsed.hostname.replace(/^www\./, '');

    const fileAttachment: Record<string, unknown> = {
      name: displayName,
      url: parsed.toString(),
      type: 'link',
      uploaded_at: new Date().toISOString(),
      uploaded_by: req.user!.email,
    };
    if (label && String(label).trim()) fileAttachment.label = String(label).trim();
    if (comment && String(comment).trim()) fileAttachment.comment = String(comment).trim();
    if (share_with_freelancer === true) fileAttachment.share_with_freelancer = true;

    await query(
      `UPDATE ${entity_type} SET files = COALESCE(files, '[]'::jsonb) || $1::jsonb, updated_at = NOW() WHERE id = $2`,
      [JSON.stringify([fileAttachment]), entity_id]
    );

    const fkColumn = getEntityFk(entity_type);
    if (fkColumn) {
      const display = label && String(label).trim() ? `${String(label).trim()} (${displayName})` : displayName;
      await query(
        `INSERT INTO interactions (id, type, content, ${fkColumn}, created_by, created_at, source)
         VALUES ($1, 'note', $2, $3, $4, NOW(), 'system')`,
        [uuid(), `🔗 Added link: ${display}`, entity_id, req.user!.id]
      );
    }

    res.status(201).json(fileAttachment);
  } catch (error) {
    console.error('Add link error:', error);
    res.status(500).json({ error: 'Failed to add link' });
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
          `INSERT INTO interactions (id, type, content, ${fkColumn}, created_by, created_at, source)
           VALUES ($1, 'email', $2, $3, $4, NOW(), 'system')`,
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

// ── Cross-entity file surfacing (docs/CROSS-ENTITY-FILES-SPEC.md, Phase 4) ──
//
// A file's bytes live in R2 exactly once. Everything below is about WINDOWS
// onto that one file, and the two directions are deliberately asymmetric:
//
//   org → job   derived at read time from the job's orgs. No rows anywhere, so
//               changing a job's orgs re-derives the set for free.
//   job → org   an explicit `file_links` row, because it must survive the job's
//               client later being changed — the rider stays with the band.

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface StoredFile extends Record<string, unknown> {
  url: string;
  name: string;
}

/** A file is job-visible unless someone has explicitly hidden it. */
function isShownOnJobs(file: Record<string, unknown>): boolean {
  return file.show_on_jobs !== false;
}

// GET /api/files/for-job/:jobId — everything the Job Files tab needs beyond the
// job's own `files` array, in one round trip:
//
//   surfaced — a FLAT list of files borrowed from the job's orgs. Each carries
//              the entity that OWNS it (owner_entity_type / owner_entity_id /
//              owner_name), so the tab can render one list with an origin chip
//              and still write metadata back to the record that holds the file.
//   links    — this job's own files' outgoing links, for the per-file chips
//   orgs     — the orgs on this job, for the "Link to org" picker
router.get('/for-job/:jobId', authorize(...STAFF_ROLES), async (req: AuthRequest, res: Response) => {
  try {
    const jobId = String(req.params.jobId);
    if (!UUID_RE.test(jobId)) {
      res.status(400).json({ error: 'Invalid job id' });
      return;
    }

    const jobResult = await query(
      `SELECT COALESCE(files, '[]'::jsonb) AS files FROM jobs WHERE id = $1`,
      [jobId]
    );
    if (jobResult.rows.length === 0) {
      res.status(404).json({ error: 'Job not found' });
      return;
    }

    // Every org on the job: the explicit job_organisations links PLUS the
    // accounting client, which hangs off jobs.client_id rather than a link row.
    const orgsResult = await query(
      `SELECT o.id, o.name, COALESCE(o.files, '[]'::jsonb) AS files
         FROM organisations o
        WHERE o.id IN (
                SELECT jo.organisation_id FROM job_organisations jo WHERE jo.job_id = $1
                UNION
                SELECT j.client_id FROM jobs j WHERE j.id = $1 AND j.client_id IS NOT NULL
              )
        ORDER BY o.name`,
      [jobId]
    );
    const orgs = orgsResult.rows as Array<{ id: string; name: string; files: StoredFile[] }>;

    // Files OTHER jobs have linked up to one of those orgs. These surface here
    // too — that's the point of linking a rider up to the band: it then appears
    // on the band's other hires. The metadata still lives on the owning job.
    let linkedIn: Array<{
      org_id: string; r2_key: string; job_id: string;
      job_name: string | null; hh_job_number: number | null; job_files: StoredFile[];
    }> = [];
    if (orgs.length > 0) {
      const linkedResult = await query(
        `SELECT fl.linked_entity_id AS org_id, fl.r2_key,
                j.id AS job_id, j.job_name, j.hh_job_number,
                COALESCE(j.files, '[]'::jsonb) AS job_files
           FROM file_links fl
           JOIN jobs j ON j.id = fl.owner_entity_id
          WHERE fl.linked_entity_type = 'organisations'
            AND fl.owner_entity_type = 'jobs'
            AND fl.linked_entity_id = ANY($1::uuid[])
            AND fl.owner_entity_id <> $2::uuid`,
        [orgs.map((o) => o.id), jobId]
      );
      linkedIn = linkedResult.rows;
    }

    // Dedupe by R2 key across the whole tab: the job's own files win, then the
    // first org to offer a given file keeps it. A rider linked to both the band
    // and its management company shows once, not twice.
    const seen = new Set<string>(
      (jobResult.rows[0].files as StoredFile[]).map((f) => f.url)
    );

    const surfaced: Record<string, unknown>[] = [];
    for (const org of orgs) {
      for (const file of org.files) {
        if (!isShownOnJobs(file) || seen.has(file.url)) continue;
        seen.add(file.url);
        surfaced.push({
          ...file,
          source: 'org',
          owner_entity_type: 'organisations',
          owner_entity_id: org.id,
          owner_name: org.name,
        });
      }

      for (const link of linkedIn.filter((l) => l.org_id === org.id)) {
        if (seen.has(link.r2_key)) continue;
        // The link row can outlive the file it points at (the owning job's copy
        // was replaced, say). Nothing to render, so skip rather than 500.
        // No show_on_jobs check here: the link row IS the explicit decision to
        // surface this file. The flag only gates the DERIVED org → job direction,
        // where nobody opted in file-by-file.
        const meta = link.job_files.find((f) => f.url === link.r2_key);
        if (!meta) continue;
        seen.add(link.r2_key);
        surfaced.push({
          ...meta,
          source: 'job',
          // Owned by the JOB that uploaded it, not by the org it travelled
          // through — that's where an edit or an email has to be aimed.
          owner_entity_type: 'jobs',
          owner_entity_id: link.job_id,
          owner_name: link.job_name || (link.hh_job_number ? `Job ${link.hh_job_number}` : 'a job'),
        });
      }
    }

    const linksResult = await query(
      `SELECT fl.id, fl.r2_key, fl.linked_entity_id AS org_id, o.name AS org_name
         FROM file_links fl
         JOIN organisations o ON o.id = fl.linked_entity_id
        WHERE fl.owner_entity_type = 'jobs'
          AND fl.owner_entity_id = $1::uuid
          AND fl.linked_entity_type = 'organisations'
        ORDER BY o.name`,
      [jobId]
    );

    res.json({
      data: {
        surfaced,
        links: linksResult.rows,
        orgs: orgs.map((o) => ({ id: o.id, name: o.name })),
      },
    });
  } catch (error) {
    console.error('Job file surfacing error:', error);
    res.status(500).json({ error: 'Failed to load surfaced files' });
  }
});

// GET /api/files/for-org/:orgId — files that jobs have linked up to this org.
// They stay OWNED by the uploading job; the org just has a window onto them. The
// owner identity rides along so the Org Files tab can show them in the same flat
// list as the org's own files and still write metadata to the right job.
router.get('/for-org/:orgId', authorize(...STAFF_ROLES), async (req: AuthRequest, res: Response) => {
  try {
    const orgId = String(req.params.orgId);
    if (!UUID_RE.test(orgId)) {
      res.status(400).json({ error: 'Invalid organisation id' });
      return;
    }

    const result = await query(
      `SELECT fl.id AS link_id, fl.r2_key, fl.created_at,
              j.id AS job_id, j.job_name, j.hh_job_number,
              COALESCE(j.files, '[]'::jsonb) AS job_files
         FROM file_links fl
         JOIN jobs j ON j.id = fl.owner_entity_id
        WHERE fl.linked_entity_type = 'organisations'
          AND fl.linked_entity_id = $1::uuid
          AND fl.owner_entity_type = 'jobs'
        ORDER BY fl.created_at DESC`,
      [orgId]
    );

    const linked = [];
    for (const row of result.rows) {
      const meta = (row.job_files as StoredFile[]).find((f) => f.url === row.r2_key);
      if (!meta) continue; // link outlived the file — nothing to show
      linked.push({
        ...meta,
        source: 'job',
        link_id: row.link_id,
        owner_entity_type: 'jobs',
        owner_entity_id: row.job_id,
        owner_name: row.job_name || (row.hh_job_number ? `Job ${row.hh_job_number}` : 'a job'),
      });
    }

    res.json({ data: linked });
  } catch (error) {
    console.error('Org linked-file lookup error:', error);
    res.status(500).json({ error: 'Failed to load linked files' });
  }
});

const fileLinkSchema = z.object({
  r2_key: z.string().min(1),
  owner_entity_type: z.literal('jobs'),
  owner_entity_id: z.string().uuid(),
  linked_entity_type: z.literal('organisations'),
  linked_entity_id: z.string().uuid(),
});

// POST /api/files/link — surface an owned file on another entity.
//
// The table is polymorphic on both ends, but the API is deliberately narrow:
// only job → org is a real product action today, and a wide-open endpoint would
// let a caller manufacture links between anything.
router.post('/link', authorize(...STAFF_ROLES), validate(fileLinkSchema), async (req: AuthRequest, res: Response) => {
  try {
    const { r2_key, owner_entity_type, owner_entity_id, linked_entity_type, linked_entity_id } =
      req.body as z.infer<typeof fileLinkSchema>;

    // The file has to actually be on the owning job — otherwise a payload could
    // point a link at any R2 key it liked.
    const owner = await query(
      `SELECT COALESCE(files, '[]'::jsonb) AS files FROM jobs WHERE id = $1`,
      [owner_entity_id]
    );
    if (owner.rows.length === 0) {
      res.status(404).json({ error: 'Job not found' });
      return;
    }
    const file = (owner.rows[0].files as StoredFile[]).find((f) => f.url === r2_key);
    if (!file) {
      res.status(404).json({ error: 'File not found on this job' });
      return;
    }

    const org = await query(`SELECT name FROM organisations WHERE id = $1`, [linked_entity_id]);
    if (org.rows.length === 0) {
      res.status(404).json({ error: 'Organisation not found' });
      return;
    }

    const inserted = await query(
      `INSERT INTO file_links
         (r2_key, owner_entity_type, owner_entity_id, linked_entity_type, linked_entity_id, created_by)
       VALUES ($1, $2, $3::uuid, $4, $5::uuid, $6)
       ON CONFLICT ON CONSTRAINT uq_file_link DO NOTHING
       RETURNING id`,
      [r2_key, owner_entity_type, owner_entity_id, linked_entity_type, linked_entity_id, req.user!.email]
    );

    // Already linked — not an error, the caller wanted it linked and it is.
    if (inserted.rows.length === 0) {
      res.status(200).json({ data: { already_linked: true } });
      return;
    }

    await query(
      `INSERT INTO interactions (id, type, content, organisation_id, created_by, created_at, source)
       VALUES ($1, 'note', $2, $3, $4, NOW(), 'system')`,
      [uuid(), `🔗 Linked file from a job: ${file.label ? `${file.label} (${file.name})` : file.name}`,
       linked_entity_id, req.user!.id]
    );

    res.status(201).json({ data: { id: inserted.rows[0].id } });
  } catch (error) {
    console.error('File link error:', error);
    res.status(500).json({ error: 'Failed to link file' });
  }
});

// DELETE /api/files/link/:id — close the window. The file itself is untouched;
// it stays owned by, and visible on, the job that uploaded it.
router.delete('/link/:id', authorize(...STAFF_ROLES), async (req: AuthRequest, res: Response) => {
  try {
    const id = String(req.params.id);
    if (!UUID_RE.test(id)) {
      res.status(400).json({ error: 'Invalid link id' });
      return;
    }
    const result = await query(`DELETE FROM file_links WHERE id = $1 RETURNING id`, [id]);
    if (result.rows.length === 0) {
      res.status(404).json({ error: 'Link not found' });
      return;
    }
    res.status(204).send();
  } catch (error) {
    console.error('File unlink error:', error);
    res.status(500).json({ error: 'Failed to unlink file' });
  }
});

export default router;
