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
import { authenticate, AuthRequest, STAFF_ROLES, MANAGER_ROLES, authorize } from '../middleware/auth';
import { validate } from '../middleware/validate';
import {
  resolveParkingToken,
  recordOohParkingSubmission,
  sendOohInfoEmailsForJob,
} from '../services/ooh-return';
import { getLatestPositionForReg } from '../services/traccar-server';
import {
  resolveJobId,
  resolveVehicleId,
  getOohVanDrivers,
  createViolation,
  getRecentOohReturns,
  getDriverCompliance,
  setDriverBlock,
  getBlockThreshold,
  OOH_VIOLATION_TYPES,
  type OohViolationType,
  type OohSeverity,
} from '../services/ooh-compliance';

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
  // Manager override to allow OOH for a driver who has lost the privilege.
  override: z.boolean().optional(),
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

      // Enforcement: turning OOH ON for a blocked driver needs a manager override.
      if (body.return_overnight === true) {
        const chk = await query(
          `SELECT vha.driver_id, d.full_name AS driver_name, COALESCE(d.ooh_blocked, FALSE) AS blocked
             FROM vehicle_hire_assignments vha
             LEFT JOIN drivers d ON d.id = vha.driver_id
            WHERE vha.id = $1`,
          [id],
        );
        const chkRow = chk.rows[0] as
          | { driver_id: string | null; driver_name: string | null; blocked: boolean }
          | undefined;
        if (!chkRow) {
          res.status(404).json({ error: 'Assignment not found' });
          return;
        }
        if (chkRow.blocked) {
          const isManager = (MANAGER_ROLES as readonly string[]).includes(req.user!.role);
          if (!body.override) {
            res.status(409).json({
              error: 'driver_blocked',
              message: `${chkRow.driver_name || 'This driver'} has lost OOH return privileges.`,
              driverName: chkRow.driver_name,
              canOverride: isManager,
            });
            return;
          }
          if (!isManager) {
            res.status(403).json({ error: 'Only a manager can override an OOH block.' });
            return;
          }
          // Manager override proceeds — recorded on the job timeline below.
        }
      }

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

      // Record a manager override on the job timeline for audit.
      if (body.return_overnight === true && body.override) {
        try {
          await query(
            `INSERT INTO interactions (job_id, type, content, created_by)
             VALUES ($1, 'note', $2, $3)`,
            [
              row.job_id,
              `🌙 OOH block overridden — manager allowed OOH return for a driver who had lost the privilege.`,
              req.user!.id,
            ],
          );
        } catch (logErr) {
          console.warn('[ooh-return] failed to log override interaction:', logErr);
        }
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

// ── Compliance (Part 2) ─────────────────────────────────────────────

/**
 * Staff: context for the check-in "OOH steps followed?" capture. Returns whether
 * the (job, vehicle) is an OOH return and the drivers on it (for the attribution
 * picker), plus the block threshold.
 */
router.get(
  '/check-in-context',
  authenticate,
  authorize(...STAFF_ROLES),
  async (req: AuthRequest, res: Response) => {
    try {
      const jobId = await resolveJobId({
        job_id: typeof req.query.job_id === 'string' ? req.query.job_id : null,
        hh_job_number: req.query.hh_job_number ? Number(req.query.hh_job_number) : null,
      });
      const vehicleId = await resolveVehicleId({
        vehicle_id: typeof req.query.vehicle_id === 'string' ? req.query.vehicle_id : null,
        reg: typeof req.query.reg === 'string' ? req.query.reg : null,
      });
      if (!jobId || !vehicleId) {
        res.json({ data: { isOoh: false, drivers: [], threshold: await getBlockThreshold() } });
        return;
      }
      const drivers = await getOohVanDrivers(jobId, vehicleId);
      res.json({
        data: {
          isOoh: drivers.length > 0,
          jobId,
          vehicleId,
          drivers,
          threshold: await getBlockThreshold(),
        },
      });
    } catch (err) {
      console.error('[ooh-return] check-in-context error:', err);
      res.status(500).json({ error: 'Failed to load OOH check-in context' });
    }
  }
);

// Staff: record a parking violation (from check-in untick OR retro-flag).
const violationSchema = z.object({
  job_id: z.string().uuid().optional().nullable(),
  hh_job_number: z.number().int().optional().nullable(),
  vehicle_id: z.string().uuid().optional().nullable(),
  reg: z.string().optional().nullable(),
  driver_id: z.string().uuid().optional().nullable(),
  assignment_id: z.string().uuid().optional().nullable(),
  type: z.enum(['parked_blocking', 'parked_outside_yard', 'left_without_telling_us', 'other']),
  severity: z.enum(['minor', 'serious']).optional(),
  notes: z.string().max(2000).optional().nullable(),
  occurred_on: z.string().optional().nullable(),
});

router.post(
  '/violations',
  authenticate,
  authorize(...STAFF_ROLES),
  validate(violationSchema),
  async (req: AuthRequest, res: Response) => {
    try {
      const body = req.body as z.infer<typeof violationSchema>;
      const jobId = await resolveJobId({ job_id: body.job_id, hh_job_number: body.hh_job_number });
      const vehicleId = await resolveVehicleId({ vehicle_id: body.vehicle_id, reg: body.reg });
      const result = await createViolation({
        jobId,
        vehicleId,
        driverId: body.driver_id ?? null,
        assignmentId: body.assignment_id ?? null,
        type: body.type as OohViolationType,
        severity: (body.severity as OohSeverity) || 'serious',
        notes: body.notes ?? null,
        occurredOn: body.occurred_on ?? null,
        loggedBy: req.user!.id,
      });
      res.status(201).json({ data: result });
    } catch (err) {
      console.error('[ooh-return] create violation error:', err);
      res.status(500).json({ error: 'Failed to record violation' });
    }
  }
);

// Staff: dismiss (clear) a mis-attributed/incorrect violation — soft, audit kept.
router.patch(
  '/violations/:id/dismiss',
  authenticate,
  authorize(...STAFF_ROLES),
  async (req: AuthRequest, res: Response) => {
    try {
      const reason = typeof req.body?.reason === 'string' ? req.body.reason : null;
      const r = await query(
        `UPDATE ooh_return_violations
            SET dismissed = TRUE, dismiss_reason = $1, dismissed_by = $2, dismissed_at = NOW()
          WHERE id = $3 RETURNING id`,
        [reason, req.user!.id, String(req.params.id)],
      );
      if (!r.rows[0]) {
        res.status(404).json({ error: 'Violation not found' });
        return;
      }
      res.json({ success: true });
    } catch (err) {
      console.error('[ooh-return] dismiss violation error:', err);
      res.status(500).json({ error: 'Failed to dismiss violation' });
    }
  }
);

// Staff: recent OOH returns for the dashboard retro-flag list.
router.get(
  '/recent-returns',
  authenticate,
  authorize(...STAFF_ROLES),
  async (req: AuthRequest, res: Response) => {
    try {
      const days = Math.min(Math.max(parseInt(String(req.query.days || '3'), 10) || 3, 1), 30);
      const data = await getRecentOohReturns(days);
      res.json({ data });
    } catch (err) {
      console.error('[ooh-return] recent-returns error:', err);
      res.status(500).json({ error: 'Failed to load recent OOH returns' });
    }
  }
);

// Staff: a driver's OOH compliance summary (violations + block status).
router.get(
  '/drivers/:driverId/compliance',
  authenticate,
  authorize(...STAFF_ROLES),
  async (req: AuthRequest, res: Response) => {
    try {
      const data = await getDriverCompliance(String(req.params.driverId));
      if (!data) {
        res.status(404).json({ error: 'Driver not found' });
        return;
      }
      res.json({ data });
    } catch (err) {
      console.error('[ooh-return] driver compliance error:', err);
      res.status(500).json({ error: 'Failed to load driver compliance' });
    }
  }
);

// Manager+: apply a block (suggest-and-confirm — never auto-applied).
router.post(
  '/drivers/:driverId/block',
  authenticate,
  authorize(...MANAGER_ROLES),
  async (req: AuthRequest, res: Response) => {
    try {
      const reason = typeof req.body?.reason === 'string' ? req.body.reason : null;
      await setDriverBlock(String(req.params.driverId), true, reason, req.user!.id);
      res.json({ success: true });
    } catch (err) {
      console.error('[ooh-return] block error:', err);
      res.status(500).json({ error: 'Failed to block driver' });
    }
  }
);

// Admin only: lift a block (giving another chance — a considered decision).
router.post(
  '/drivers/:driverId/unblock',
  authenticate,
  authorize('admin'),
  async (req: AuthRequest, res: Response) => {
    try {
      await setDriverBlock(String(req.params.driverId), false, null, req.user!.id);
      res.json({ success: true });
    } catch (err) {
      console.error('[ooh-return] unblock error:', err);
      res.status(500).json({ error: 'Failed to unblock driver' });
    }
  }
);

export default router;

// Expose the canonical type list for any UI that needs it.
export { OOH_VIOLATION_TYPES };
