/**
 * Pre-Hire Briefing routes.
 *
 *   GET  /api/pre-hire-briefing/:jobId        — return structured briefing
 *   POST /api/pre-hire-briefing/:jobId/send   — render + email to info@
 *   GET  /api/pre-hire-briefing/eligible      — list jobs the daily cron would email today
 *
 * The daily 09:55 scheduler calls the same internal helpers that POST /:jobId/send
 * uses, so manual + scheduled paths produce identical emails.
 */

import { Router, Response } from 'express';
import { authenticate, authorize, AuthRequest, STAFF_ROLES } from '../middleware/auth';
import { buildBriefing, findEligibleJobs } from '../services/pre-hire-briefing';
import { renderBriefingHtml, buildSubject } from '../services/email-templates/pre-hire-briefing';
import { emailService } from '../services/email-service';

const router = Router();

router.use(authenticate);
router.use(authorize(...STAFF_ROLES));

// Recipient for ALL pre-hire briefings — internal shared inbox. Configurable
// via env so we can repoint to a test address before flipping live.
const BRIEFING_RECIPIENT = process.env.PRE_HIRE_BRIEFING_RECIPIENT
  || 'info@oooshtours.co.uk';

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
    console.error('[pre-hire-briefing] build failed:', err);
    res.status(500).json({ error: 'Failed to build briefing' });
  }
});

// ── POST /:jobId/send — render + send the briefing email ────────────────

router.post('/:jobId/send', async (req: AuthRequest, res: Response) => {
  try {
    const jobId = (req.params as Record<string, string>).jobId;
    const briefing = await buildBriefing(jobId);
    if (!briefing) {
      res.status(404).json({ error: 'Job not found' });
      return;
    }
    const html = renderBriefingHtml(briefing);
    const subject = buildSubject(briefing);
    const result = await emailService.send('pre_hire_briefing', {
      to: BRIEFING_RECIPIENT,
      subjectOverride: subject,
      bodyHtmlOverride: html,
    });
    if (!result.success) {
      res.status(500).json({ error: result.error || 'Email send failed' });
      return;
    }
    res.json({
      success: true,
      sent_to: result.redirectedTo || BRIEFING_RECIPIENT,
      subject,
      message_id: result.messageId,
    });
  } catch (err) {
    console.error('[pre-hire-briefing] send failed:', err);
    res.status(500).json({ error: 'Failed to send briefing' });
  }
});

// ── GET /eligible — jobs the cron would pick up today (debug aid) ───────

router.get('/_debug/eligible', async (_req: AuthRequest, res: Response) => {
  try {
    const eligible = await findEligibleJobs();
    res.json({ data: eligible });
  } catch (err) {
    console.error('[pre-hire-briefing] eligible lookup failed:', err);
    res.status(500).json({ error: 'Failed to list eligible jobs' });
  }
});

export default router;
