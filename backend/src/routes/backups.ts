import { Router, Response } from 'express';
import { authenticate, authorize, AuthRequest } from '../middleware/auth';
import { listR2Objects, isR2Configured, getFromR2 } from '../config/r2';
import { runBackup } from '../scripts/backup';
import path from 'path';

const router = Router();
router.use(authenticate);
router.use(authorize('admin'));

// GET /api/backups — list available backups
router.get('/', async (_req: AuthRequest, res: Response) => {
  try {
    if (!isR2Configured()) {
      res.status(503).json({ error: 'R2 storage not configured' });
      return;
    }

    const objects = await listR2Objects('backups/');
    const backups = objects
      .filter(obj => obj.Key && obj.Key.endsWith('.sql.gz'))
      .map(obj => ({
        key: obj.Key!,
        filename: path.basename(obj.Key!),
        size: obj.Size || 0,
        sizeMB: ((obj.Size || 0) / (1024 * 1024)).toFixed(2),
        created_at: obj.LastModified?.toISOString() || '',
      }))
      .sort((a, b) => b.created_at.localeCompare(a.created_at));

    res.json({ data: backups });
  } catch (error) {
    console.error('List backups error:', error);
    res.status(500).json({ error: 'Failed to list backups' });
  }
});

// POST /api/backups/trigger — trigger a manual backup
router.post('/trigger', async (_req: AuthRequest, res: Response) => {
  try {
    if (!isR2Configured()) {
      res.status(503).json({ error: 'R2 storage not configured' });
      return;
    }

    const result = await runBackup();
    res.status(201).json({
      message: 'Backup created successfully',
      ...result,
    });
  } catch (error) {
    console.error('Trigger backup error:', error);
    res.status(500).json({ error: 'Backup failed' });
  }
});

// GET /api/backups/download?key=... — download a specific backup
router.get('/download', async (req: AuthRequest, res: Response) => {
  try {
    const { key } = req.query;
    if (!key || typeof key !== 'string' || !key.startsWith('backups/')) {
      res.status(400).json({ error: 'Valid backup key is required' });
      return;
    }

    const object = await getFromR2(key);
    if (!object.Body) {
      res.status(404).json({ error: 'Backup not found' });
      return;
    }

    const filename = path.basename(key);
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Content-Type', 'application/gzip');
    if (object.ContentLength) {
      res.setHeader('Content-Length', object.ContentLength);
    }

    const stream = object.Body as NodeJS.ReadableStream;
    stream.pipe(res);
  } catch (error) {
    console.error('Download backup error:', error);
    res.status(500).json({ error: 'Download failed' });
  }
});

export default router;
