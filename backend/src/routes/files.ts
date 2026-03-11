import { Router, Response } from 'express';
import multer from 'multer';
import path from 'path';
import { v4 as uuid } from 'uuid';
import { authenticate, authorize, AuthRequest } from '../middleware/auth';
import { uploadToR2, deleteFromR2, getFromR2, isR2Configured } from '../config/r2';
import { query } from '../config/database';

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

    const { entity_type, entity_id, label } = req.body;
    if (!entity_type || !entity_id) {
      res.status(400).json({ error: 'entity_type and entity_id are required' });
      return;
    }

    const validTypes = ['people', 'organisations', 'venues', 'interactions', 'jobs'];
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

    // Validate key starts with files/ to prevent path traversal
    if (!key.startsWith('files/') && !key.startsWith('backups/')) {
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

    const validTypes = ['people', 'organisations', 'venues', 'interactions', 'jobs'];
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

export default router;
