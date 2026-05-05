/**
 * Out-of-Hours return — public parking-form endpoints + staff endpoints.
 *
 * Public endpoints (token auth, no JWT):
 *   GET  /api/ooh-return/by-token/:token              — load context for the form
 *   GET  /api/ooh-return/by-token/:token/prefill      — Traccar position
 *   POST /api/ooh-return/by-token/:token/submit       — record parking submission
 *
 * Staff endpoints (JWT auth):
 *   POST  /api/ooh-return/assignments/:id/send-info   — send/resend info email
 *   PATCH /api/ooh-return/assignments/:id/toggle      — set return_overnight + optional resend
 */
import { Router, Request, Response } from 'express';
import { z } from 'zod';
import rateLimit from 'express-rate-limit';
import { query } from '../config/database';
import { authenticate, AuthRequest, STAFF_ROLES, authorize } from '../middleware/auth';
import { validate } from '../middleware/validate';
import {
  resolveParkingToken,
  recordOohParkingSubmission,
  sendOohInfoEmailsForJob,
} from '../services/ooh-return';
import { getLatestPositionForReg } from '../services/traccar-server';

const router = Router();

// ── Public rate limits ──────────────────────────────────────────────
const publicLimiter = rateLimit({
  windowMs: 60_000,
  max: 30,
  message: { error: 'Too many requests' },
  standardHeaders: true,
  legacyHeaders: false,
});

// ── Public: load form context ───────────────────────────────────────
router.get('/by-token/:token', publicLimiter, async (req: Request, res: Response) => {
  const token = String(req.params.token);
  const ctx = await resolveParkingToken(token);
  if (!ctx) {
    res.status(404).json({ error: 'Link is no longer valid (van may already be checked in).' });
    return;
  }
  res.json({
    data: {
      vehicleReg: ctx.vehicleReg,
      jobNumber: ctx.hhJobNumber,
      jobName: ctx.jobName,
      driverName: ctx.driverName,
      alreadySubmitted: ctx.alreadySubmitted,
    },
  });
});

// ── Public: Traccar prefill ─────────────────────────────────────────
router.get('/by-token/:token/prefill', publicLimiter, async (req: Request, res: Response) => {
  const token = String(req.params.token);
  const ctx = await resolveParkingToken(token);
  if (!ctx) {
    res.status(404).json({ error: 'Link is no longer valid' });
    return;
  }
  const position = await getLatestPositionForReg(ctx.vehicleReg);
  res.json({
    data: position
      ? {
          latitude: position.latitude,
          longitude: position.longitude,
          fixTime: position.fixTime,
          ageSeconds: position.ageSeconds,
        }
      : null,
  });
});

// ── Public: submit parking confirmation ─────────────────────────────
const submitLimiter = rateLimit({
  windowMs: 60_000,
  max: 10,
  message: { error: 'Too many submissions — try again in a minute' },
  standardHeaders: true,
  legacyHeaders: false,
});

const submitSchema = z.object({
  latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180),
  notes: z.string().max(2000).optional().nullable(),
});

router.post(
  '/by-token/:token/submit',
  submitLimiter,
  validate(submitSchema),
  async (req: Request, res: Response) => {
    const token = String(req.params.token);
    const ctx = await resolveParkingToken(token);
    if (!ctx) {
      res.status(404).json({ error: 'Link is no longer valid' });
      return;
    }

    const body = req.body as z.infer<typeof submitSchema>;
    try {
      await recordOohParkingSubmission({
        assignmentId: ctx.assignmentId,
        jobId: ctx.jobId,
        hhJobNumber: ctx.hhJobNumber,
        vehicleReg: ctx.vehicleReg,
        driverName: ctx.driverName,
        lat: body.latitude,
        lng: body.longitude,
        notes: body.notes ?? null,
        isResubmission: ctx.alreadySubmitted,
      });
      res.json({ success: true });
    } catch (err) {
      console.error('[ooh-return] submit error:', err);
      res.status(500).json({ error: 'Failed to record submission' });
    }
  }
);

// ── Staff: send/resend info email ───────────────────────────────────
router.post(
  '/assignments/:id/send-info',
  authenticate,
  authorize(...STAFF_ROLES),
  async (req: AuthRequest, res: Response) => {
    try {
      const id = String(req.params.id);
      const result = await query(
        `SELECT job_id FROM vehicle_hire_assignments WHERE id = $1`,
        [id]
      );
      const row = result.rows[0] as { job_id: string } | undefined;
      if (!row) {
        res.status(404).json({ error: 'Assignment not found' });
        return;
      }
      const summary = await sendOohInfoEmailsForJob(row.job_id, { force: true });
      res.json({ success: true, ...summary });
    } catch (err) {
      console.error('[ooh-return] send-info error:', err);
      res.status(500).json({ error: 'Failed to send OOH info email' });
    }
  }
);

// ── Staff: toggle return_overnight ──────────────────────────────────
const toggleSchema = z.object({
  return_overnight: z.boolean().nullable(),
  send_email_now: z.boolean().optional(),
});

router.patch(
  '/assignments/:id/toggle',
  authenticate,
  authorize(...STAFF_ROLES),
  validate(toggleSchema),
  async (req: AuthRequest, res: Response) => {
    try {
      const id = String(req.params.id);
      const body = req.body as z.infer<typeof toggleSchema>;

      const result = await query(
        `UPDATE vehicle_hire_assignments
           SET return_overnight = $1, updated_at = NOW()
         WHERE id = $2
         RETURNING job_id, vehicle_id`,
        [body.return_overnight, id]
      );
      const row = result.rows[0] as { job_id: string; vehicle_id: string | null } | undefined;
      if (!row) {
        res.status(404).json({ error: 'Assignment not found' });
        return;
      }

      let emailSummary: { vehicleCount: number; emailsSent: number; emailsSkipped: number } | null = null;
      if (body.send_email_now && body.return_overnight === true) {
        emailSummary = await sendOohInfoEmailsForJob(row.job_id, { force: true });
      }

      res.json({ success: true, emailSummary });
    } catch (err) {
      console.error('[ooh-return] toggle error:', err);
      res.status(500).json({ error: 'Failed to update return_overnight' });
    }
  }
);

export default router;
