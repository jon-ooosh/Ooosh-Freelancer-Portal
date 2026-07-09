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
import { authenticate, authorize, AuthRequest, STAFF_ROLES } from '../middleware/auth';
import { getGmailIngestionStatus, runIngestionForPrimaryMailbox } from '../services/gmail-ingestion';
import { runEmailRetentionSweep } from '../services/email-retention';
import { draftChaseEmail, learnChaseVoice } from '../services/chase-draft';
import { createChaseDraftForJob } from '../services/gmail-draft';
import { getJobCommsSummaryStatus, generateJobCommsSummary } from '../services/comms-summary';
import { backfillOpenPipelineThreads } from '../services/gmail-backfill';
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

// POST /api/auto-chase/backfill — one-off cold-start pass: search the mailbox
// for each open-pipeline job's HH number and ingest the matching thread(s) onto
// that job. Idempotent (RFC822 dedup), so safe to run repeatedly a limit at a
// time. Body: { limit?: number (default 50, max 200), dryRun?: boolean }. Admin.
router.post('/backfill', authorize('admin'), async (req: AuthRequest, res: Response) => {
  if (!isGmailConfigured()) {
    return res.status(503).json({ error: 'Gmail not configured — nothing to backfill.' });
  }
  try {
    const body = (req.body || {}) as { limit?: number; dryRun?: boolean };
    const summary = await backfillOpenPipelineThreads({ limit: body.limit, dryRun: body.dryRun });
    res.json({ data: summary });
  } catch (error) {
    console.error('[auto-chase] backfill error:', error);
    res.status(500).json({ error: 'Backfill run failed' });
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

// ── Per-job conversation summary (spec §7.1) ────────────────────────────────
// GET returns the cached summary + computed staleness/availability (no AI call,
// cheap). POST generates/regenerates synchronously. Any staff role — this is
// operational context on a job the whole team works from.

// GET /api/auto-chase/job-summary/:jobId — cached summary + staleness flags.
router.get('/job-summary/:jobId', authorize(...STAFF_ROLES), async (req: AuthRequest, res: Response) => {
  try {
    const status = await getJobCommsSummaryStatus(String(req.params.jobId));
    res.json({ data: { ...status, configured: isAnthropicConfigured() } });
  } catch (error) {
    console.error('[auto-chase] job-summary status error:', error);
    res.status(500).json({ error: 'Failed to load conversation summary' });
  }
});

// POST /api/auto-chase/job-summary/:jobId — (re)generate the summary. Returns
// { available:false } when there's nothing ingested to summarise yet.
router.post('/job-summary/:jobId', authorize(...STAFF_ROLES), async (req: AuthRequest, res: Response) => {
  if (!isAnthropicConfigured()) {
    return res.status(503).json({ error: 'Summaries unavailable — ANTHROPIC_API_KEY not configured.' });
  }
  try {
    const summary = await generateJobCommsSummary(String(req.params.jobId), req.user?.id ?? null);
    if (!summary) return res.json({ data: { available: false, summary: null } });
    res.json({ data: { available: true, summary, stale: false } });
  } catch (error) {
    console.error('[auto-chase] job-summary generate error:', error);
    res.status(500).json({ error: 'Failed to summarise conversation' });
  }
});

// POST /api/auto-chase/voice/learn — distil example client emails + our replies
// into a PROPOSED chase_voice_instructions note (§9.3). Does NOT save — returns
// the proposal for the human to review + save via the Settings PUT. Manager-tier
// (this shapes every future client-facing chase). Needs Anthropic.
router.post('/voice/learn', authorize('admin', 'manager'), async (req: AuthRequest, res: Response) => {
  if (!isAnthropicConfigured()) {
    return res.status(503).json({ error: 'Voice learning unavailable — ANTHROPIC_API_KEY not configured.' });
  }
  try {
    const body = (req.body || {}) as { examples?: string; current?: string };
    const examples = String(body.examples || '').trim();
    if (!examples) return res.status(400).json({ error: 'Paste some example emails to learn from.' });
    const proposed = await learnChaseVoice(examples, body.current ?? null);
    res.json({ data: { proposed } });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error('[auto-chase] voice learn error:', error);
    res.status(500).json({ error: message || 'Failed to learn chase voice' });
  }
});

export default router;
