/**
 * Jon's review request email (docs/BUSINESS-FIGURES-SPEC.md §8c).
 *
 *   GET  /stop?t=…              PUBLIC — "Don't ask me again?" with a button (never acts on the click
 *   POST /stop                  PUBLIC   alone: mail scanners open every link in an email)
 *   GET  /job/:jobId            staff — this job's state (pending / sent / skipped / not sent + why)
 *   PUT  /job/:jobId/skip       staff — the "don't send" tick { skip }
 *   GET  /overview              admin — the switch, counts, the last 50
 *   PUT  /settings              admin — { enabled }
 *   POST /test                  admin — the real email to yourself
 */
import { Router, Request, Response } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { authenticate, authorize, AuthRequest, STAFF_ROLES } from '../middleware/auth';
import { validate } from '../middleware/validate';
import {
  emailFromStopToken, getJobReviewState, recordOptOut, reviewOverview,
  sendTestReviewEmail, setJobReviewSkip, setReviewRequestsEnabled,
} from '../services/review-requests';

const router = Router();

// ── Public: "Don't ask me again" ────────────────────────────────────────────

const stopLimiter = rateLimit({ windowMs: 60 * 1000, max: 30, standardHeaders: true, legacyHeaders: false });

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function page(title: string, body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title></head>
<body style="margin:0;background:#f8fafc;font-family:Arial,Helvetica,sans-serif;color:#1e293b;">
<div style="max-width:440px;margin:48px auto;padding:28px 24px;background:#fff;border:1px solid #e2e8f0;border-radius:12px;">
<p style="margin:0 0 18px;font-weight:bold;color:#7B5EA7;">Ooosh! Tours</p>${body}</div></body></html>`;
}

router.get('/stop', stopLimiter, (req: Request, res: Response) => {
  const t = typeof req.query.t === 'string' ? req.query.t : '';
  const email = emailFromStopToken(t);
  res.set('Cache-Control', 'no-store');
  if (!email) {
    res.status(400).send(page('Link not recognised', `<p style="line-height:1.6;">Sorry, this link isn't working. Just reply to Jon's email and we'll take you off.</p>`));
    return;
  }
  res.send(page("Don't ask me again", `
<p style="line-height:1.6;margin:0 0 18px;">Stop Jon's "how did it go?" emails to <strong>${esc(email)}</strong>?</p>
<form method="post" action="stop" style="margin:0;">
  <input type="hidden" name="t" value="${esc(t)}">
  <button type="submit" style="background:#7B5EA7;color:#fff;border:0;border-radius:8px;padding:12px 20px;font-size:15px;font-weight:bold;cursor:pointer;">Yes, don't ask me again</button>
</form>
<p style="line-height:1.6;margin:18px 0 0;font-size:13px;color:#64748b;">This only stops these review requests. Emails about your bookings still come as normal.</p>`));
});

router.post('/stop', stopLimiter, async (req: Request, res: Response) => {
  const t = typeof req.body?.t === 'string' ? req.body.t : '';
  const email = emailFromStopToken(t);
  res.set('Cache-Control', 'no-store');
  if (!email) {
    res.status(400).send(page('Link not recognised', `<p style="line-height:1.6;">Sorry, this link isn't working. Just reply to Jon's email and we'll take you off.</p>`));
    return;
  }
  try {
    await recordOptOut(email);
    res.send(page('Done', `<p style="line-height:1.6;margin:0;">Done — we won't ask <strong>${esc(email)}</strong> again. Thanks for hiring with us.</p>`));
  } catch (err) {
    console.error('[review-requests] opt-out not recorded:', err);
    res.status(500).send(page('Something went wrong', `<p style="line-height:1.6;">Sorry, that didn't save. Please try again, or just reply to Jon's email.</p>`));
  }
});

// ── Staff ────────────────────────────────────────────────────────────────────

const jobParam = z.object({ jobId: z.string().guid() });

router.get('/job/:jobId', authenticate, authorize(...STAFF_ROLES), validate(jobParam, 'params'), async (req: AuthRequest, res: Response) => {
  try {
    res.json({ data: await getJobReviewState(String(req.params.jobId)) });
  } catch (err) {
    console.error('[review-requests] job state:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.put('/job/:jobId/skip', authenticate, authorize(...STAFF_ROLES), validate(jobParam, 'params'),
  validate(z.object({ skip: z.boolean() })), async (req: AuthRequest, res: Response) => {
    try {
      res.json({ data: await setJobReviewSkip(String(req.params.jobId), !!req.body.skip, req.user!.id) });
    } catch (err) {
      console.error('[review-requests] skip:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

router.get('/overview', authenticate, authorize('admin'), async (_req: AuthRequest, res: Response) => {
  try {
    res.json({ data: await reviewOverview() });
  } catch (err) {
    console.error('[review-requests] overview:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.put('/settings', authenticate, authorize('admin'), validate(z.object({ enabled: z.boolean() })), async (req: AuthRequest, res: Response) => {
  try {
    await setReviewRequestsEnabled(!!req.body.enabled, req.user!.id);
    res.json({ data: await reviewOverview() });
  } catch (err) {
    console.error('[review-requests] settings:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.post('/test', authenticate, authorize('admin'), async (req: AuthRequest, res: Response) => {
  try {
    const r = await sendTestReviewEmail(req.user!.email);
    if (!r.ok) {
      res.status(502).json({ error: `The test email didn't send: ${r.error || 'unknown error'}` });
      return;
    }
    res.json({ data: { sentTo: req.user!.email, jobNumber: r.jobNumber || null } });
  } catch (err) {
    console.error('[review-requests] test:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
