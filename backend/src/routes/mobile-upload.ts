/**
 * mobile-upload.ts — public, token-authenticated file capture from a phone.
 *
 * Paired with the "Scan with phone" QR flow: a staff member mints a token on a
 * laptop (see e.g. excess.ts POST /:id/receipt-upload-token), the phone scans
 * the QR and lands here. Auth is the token alone — no login. Scoped to one
 * purpose + target, short-lived, single-use.
 *
 *   GET  /api/mobile-upload/:token         — context + validity (laptop polls this too)
 *   POST /api/mobile-upload/:token         — upload the file, run the side-effect
 */
import { Router, Request, Response } from 'express';
import rateLimit from 'express-rate-limit';
import multer from 'multer';
import path from 'path';
import { v4 as uuid } from 'uuid';
import { query } from '../config/database';
import { uploadToR2, isR2Configured } from '../config/r2';
import {
  resolveMobileUploadToken,
  consumeMobileUploadToken,
} from '../services/mobile-upload-token';

const router = Router();

const publicLimiter = rateLimit({
  windowMs: 60_000,
  max: 30,
  message: { error: 'Too many requests' },
  standardHeaders: true,
  legacyHeaders: false,
});

const ALLOWED_EXT = ['.jpg', '.jpeg', '.png', '.heic', '.webp', '.pdf'];
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024 }, // 15MB — phone photos
  fileFilter: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (ALLOWED_EXT.includes(ext)) cb(null, true);
    else cb(new Error(`File type ${ext} not allowed`));
  },
});

// ── Public: context + validity (also polled by the laptop to detect completion) ──
router.get('/:token', publicLimiter, async (req: Request, res: Response) => {
  const ctx = await resolveMobileUploadToken(String(req.params.token));
  if (!ctx) {
    res.status(404).json({ error: 'Link not found' });
    return;
  }
  res.json({
    data: {
      purpose: ctx.purpose,
      title: ctx.title,
      subtitle: ctx.subtitle,
      consumed: ctx.consumed,
      expired: ctx.expired,
    },
  });
});

// ── Public: upload the file + run the purpose side-effect ──
router.post('/:token', publicLimiter, upload.single('file'), async (req: Request, res: Response) => {
  try {
    if (!isR2Configured()) {
      res.status(503).json({ error: 'File storage not configured' });
      return;
    }
    const token = String(req.params.token);
    const ctx = await resolveMobileUploadToken(token);
    if (!ctx) {
      res.status(404).json({ error: 'Link not found' });
      return;
    }
    if (ctx.expired) {
      res.status(410).json({ error: 'This link has expired. Generate a new QR on the laptop.' });
      return;
    }
    if (ctx.consumed) {
      res.status(409).json({ error: 'This link has already been used.' });
      return;
    }
    if (!req.file) {
      res.status(400).json({ error: 'No file provided' });
      return;
    }

    const ext = path.extname(req.file.originalname).toLowerCase();
    const key = `files/attachments/mobile/${ctx.purpose}/${ctx.targetId}/${uuid()}${ext}`;
    await uploadToR2(key, req.file.buffer, req.file.mimetype);

    // Purpose-specific side-effect.
    if (ctx.purpose === 'excess_receipt') {
      const dateStr = new Date().toISOString().split('T')[0];
      const current = await query(`SELECT notes FROM job_excess WHERE id = $1`, [ctx.targetId]);
      if (current.rows.length === 0) {
        res.status(404).json({ error: 'Excess record no longer exists' });
        return;
      }
      const note = `[${dateStr}] Receipt scan attached (via phone).`;
      const newNotes = current.rows[0].notes ? `${current.rows[0].notes}\n${note}` : note;
      await query(
        `UPDATE job_excess SET
          receipt_url         = $1,
          receipt_uploaded_at = NOW(),
          receipt_required    = FALSE,
          notes               = $2,
          updated_at          = NOW()
        WHERE id = $3`,
        [key, newNotes, ctx.targetId]
      );
    }

    await consumeMobileUploadToken(token, key);
    res.json({ success: true });
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : String(error);
    console.error('[mobile-upload] upload error:', errMsg, error);
    res.status(500).json({ error: 'Upload failed', detail: errMsg });
  }
});

export default router;
