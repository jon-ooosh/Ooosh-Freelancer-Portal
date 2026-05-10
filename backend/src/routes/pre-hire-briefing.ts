/**
 * Pre-Hire Review routes.
 *
 *   GET  /api/pre-hire-briefing/:jobId            — return structured briefing
 *   GET  /api/pre-hire-briefing/:jobId/last-sent  — last send timestamp + attribution
 *   POST /api/pre-hire-briefing/:jobId/send       — render + email to info@
 *   GET  /api/pre-hire-briefing/_debug/eligible   — list jobs the cron would email today
 *
 * The daily 09:55 scheduler calls the same `sendBriefingEmail` helper that
 * POST /:jobId/send uses, so manual + scheduled paths produce identical
 * emails AND identical audit trails (interaction on the job timeline).
 *
 * Route path is /pre-hire-briefing for stability — UI label is "Pre-Hire Review".
 */

import { Router, Response } from 'express';
import { authenticate, authorize, AuthRequest, STAFF_ROLES } from '../middleware/auth';
import {
  buildBriefing, findEligibleJobs, sendBriefingEmail, getLastBriefingSend,
} from '../services/pre-hire-briefing';

const router = Router();

router.use(authenticate);
router.use(authorize(...STAFF_ROLES));

// ── GET /:jobId — structured briefing for on-screen preview / debugging ──

router.get('/:jobId', async (req: AuthRequest, res: Response) => {
  try {
    const jobId = (req.params as Record<string, string>).jobId;
    const briefing = await buildBriefing(jobId);
    if (!briefing) {
      res.status(404).json({ error: 'Job not found' });
      return;
    }
    res.json({ data: briefing });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[pre-hire-briefing] build failed:', err);
    res.status(500).json({ error: `Failed to build briefing: ${msg}` });
  }
});

// ── GET /:jobId/last-sent — last send timestamp + attribution ───────────

router.get('/:jobId/last-sent', async (req: AuthRequest, res: Response) => {
  try {
    const jobId = (req.params as Record<string, string>).jobId;
    const info = await getLastBriefingSend(jobId);
    res.json({ data: info });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[pre-hire-briefing] last-sent lookup failed:', err);
    res.status(500).json({ error: `Failed to look up last send: ${msg}` });
  }
});

// ── POST /:jobId/send — render + send the briefing email ────────────────

router.post('/:jobId/send', async (req: AuthRequest, res: Response) => {
  try {
    const jobId = (req.params as Record<string, string>).jobId;
    const triggeredBy = req.user?.id || null;
    const result = await sendBriefingEmail(jobId, undefined, triggeredBy);
    if (!result.success) {
      const status = result.error === 'Job not found' ? 404 : 500;
      res.status(status).json({ error: result.error || 'Failed to send briefing' });
      return;
    }
    res.json({
      success: true,
      sent_to: result.sent_to,
      subject: result.subject,
      message_id: result.message_id,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[pre-hire-briefing] send failed:', err);
    res.status(500).json({ error: `Failed to send briefing: ${msg}` });
  }
});

// ── GET /_debug/eligible — jobs the cron would pick up today ────────────

router.get('/_debug/eligible', async (_req: AuthRequest, res: Response) => {
  try {
    const eligible = await findEligibleJobs();
    res.json({ data: eligible });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[pre-hire-briefing] eligible lookup failed:', err);
    res.status(500).json({ error: `Failed to list eligible jobs: ${msg}` });
  }
});

export default router;
