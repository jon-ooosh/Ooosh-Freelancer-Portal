/**
 * Auto-Chase admin routes (Phase 1 foundation)
 *
 * Thin control surface for the Gmail ingestion foundation. Everything degrades
 * cleanly when Gmail isn't configured (status returns { configured: false };
 * manual run no-ops). Admin/manager only — this touches mailbox connectivity.
 *
 * Spec: docs/AUTO-CHASE-SPEC.md.
 */
import { Router, Response } from 'express';
import { query } from '../config/database';
import { authenticate, authorize, AuthRequest } from '../middleware/auth';
import { getGmailIngestionStatus, runIngestionForPrimaryMailbox } from '../services/gmail-ingestion';
import { runEmailRetentionSweep } from '../services/email-retention';
import { draftChaseEmail } from '../services/chase-draft';
import { createChaseDraftForJob } from '../services/gmail-draft';
import { isAnthropicConfigured } from '../config/anthropic';
import { isGmailConfigured } from '../config/gmail';

const router = Router();
router.use(authenticate);

// GET /api/auto-chase/status — configuration + connectivity + sync cursor.
router.get('/status', authorize('admin', 'manager'), async (_req: AuthRequest, res: Response) => {
  try {
    const status = await getGmailIngestionStatus();
    res.json({ data: status });
  } catch (error) {
    console.error('[auto-chase] status error:', error);
    res.status(500).json({ error: 'Failed to read auto-chase status' });
  }
});

// POST /api/auto-chase/ingest — manual ingestion run (admin only). Handy for
// establishing the baseline + a first live test before the cron cadence.
router.post('/ingest', authorize('admin'), async (_req: AuthRequest, res: Response) => {
  try {
    const summary = await runIngestionForPrimaryMailbox();
    res.json({ data: summary });
  } catch (error) {
    console.error('[auto-chase] manual ingest error:', error);
    res.status(500).json({ error: 'Ingestion run failed' });
  }
});

// POST /api/auto-chase/retention-sweep — manual retention sweep (admin only).
router.post('/retention-sweep', authorize('admin'), async (_req: AuthRequest, res: Response) => {
  try {
    const summary = await runEmailRetentionSweep();
    res.json({ data: summary });
  } catch (error) {
    console.error('[auto-chase] retention sweep error:', error);
    res.status(500).json({ error: 'Retention sweep failed' });
  }
});

// GET /api/auto-chase/unmatched — open review queue (staff hand-link from here).
router.get('/unmatched', authorize('admin', 'manager'), async (req: AuthRequest, res: Response) => {
  try {
    const limit = Math.min(parseInt(String(req.query.limit || '50'), 10) || 50, 200);
    const result = await query(
      `SELECT id, mailbox, gmail_thread_id, email_from, email_to, email_subject,
              email_snippet, has_attachments, received_at, created_at
         FROM gmail_unmatched_inbound
        WHERE resolved_job_id IS NULL AND dismissed = false
        ORDER BY received_at DESC NULLS LAST, created_at DESC
        LIMIT $1`,
      [limit],
    );
    res.json({ data: result.rows });
  } catch (error) {
    console.error('[auto-chase] unmatched list error:', error);
    res.status(500).json({ error: 'Failed to load unmatched inbound queue' });
  }
});

// POST /api/auto-chase/preview-draft/:jobId — generate an AI chase draft for a
// job and return it as JSON WITHOUT creating a Gmail draft. Lets us judge draft
// quality on real jobs before the Gmail `compose` scope + draft-creation slice
// lands. Admin/manager. Needs ANTHROPIC_API_KEY (already on prod).
router.post('/preview-draft/:jobId', authorize('admin', 'manager'), async (req: AuthRequest, res: Response) => {
  if (!isAnthropicConfigured()) {
    return res.status(503).json({ error: 'Chase drafting unavailable — ANTHROPIC_API_KEY not configured.' });
  }
  try {
    const { draft, context } = await draftChaseEmail(String(req.params.jobId));
    res.json({ data: { draft, context } });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/not found/i.test(message)) return res.status(404).json({ error: message });
    console.error('[auto-chase] preview-draft error:', error);
    res.status(500).json({ error: 'Failed to draft chase' });
  }
});

// POST /api/auto-chase/create-draft/:jobId — generate the AI chase AND create it
// as a real Gmail draft in info@ (threaded onto the client's conversation if we
// have one, else standalone to the primary contact). Staff review + send from
// Gmail; OP never sends. Admin/manager. Needs Gmail compose scope + Anthropic.
router.post('/create-draft/:jobId', authorize('admin', 'manager'), async (req: AuthRequest, res: Response) => {
  if (!isGmailConfigured()) {
    return res.status(503).json({ error: 'Gmail not configured — cannot create drafts.' });
  }
  if (!isAnthropicConfigured()) {
    return res.status(503).json({ error: 'Chase drafting unavailable — ANTHROPIC_API_KEY not configured.' });
  }
  try {
    const result = await createChaseDraftForJob(String(req.params.jobId));
    res.json({ data: result });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/not found/i.test(message)) return res.status(404).json({ error: message });
    if (/no client email/i.test(message)) return res.status(422).json({ error: message });
    console.error('[auto-chase] create-draft error:', error);
    res.status(500).json({ error: message || 'Failed to create chase draft' });
  }
});

export default router;
