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
import { getGmailIngestionStatus, runIngestionForAllMailboxes, getAllGmailIngestionStatus } from '../services/gmail-ingestion';
import { runEmailRetentionSweep } from '../services/email-retention';
import { draftChaseEmail, learnChaseVoice } from '../services/chase-draft';
import { createChaseDraftForJob } from '../services/gmail-draft';
import { getJobCommsSummaryStatus, generateJobCommsSummary } from '../services/comms-summary';
import { answerCommsQuery } from '../services/comms-query';
import { backfillOpenPipelineThreads, type BackfillScope, type BackfillSummary } from '../services/gmail-backfill';
import { getJobQuoteVersions, sweepQuoteVersions, type QuoteSweepSummary } from '../services/quote-versions';
import { runDueAutoChases } from '../services/auto-chase-runner';
import { isAnthropicConfigured } from '../config/anthropic';
import { isGmailConfigured, getPrimaryMailbox } from '../config/gmail';

const router = Router();
router.use(authenticate);

/**
 * First name of the logged-in staff member, for personalising the chase
 * sign-off. `users` has no name columns — join `people` via person_id. Returns
 * null on any miss so the draft falls back to "the Ooosh team".
 */
async function senderFirstName(userId?: string): Promise<string | null> {
  if (!userId) return null;
  try {
    const r = await query(
      `SELECT p.first_name, p.last_name
         FROM users u JOIN people p ON p.id = u.person_id
        WHERE u.id = $1`,
      [userId],
    );
    const row = r.rows[0];
    if (!row) return null;
    const name = String(row.first_name || row.last_name || '').trim();
    return name || null;
  } catch {
    return null;
  }
}

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

// POST /api/auto-chase/ingest — manual ingestion run across ALL mailboxes (admin
// only): info@ (full) + every configured manager mailbox (matched-only). Handy for
// establishing a new mailbox's baseline + a first live test before the cron cadence.
router.post('/ingest', authorize('admin'), async (_req: AuthRequest, res: Response) => {
  try {
    const summaries = await runIngestionForAllMailboxes();
    res.json({ data: summaries });
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

// ── Manual attribution backstops on ingested emails ────────────────────────
// Two human controls over what the deterministic matcher attached (spec §5.3a):
//   * detach / move  — accuracy backstop ("this isn't job A" / "→ actually B").
//     STAFF_ROLES: a mis-attach is low-harm + recoverable, and correcting it is
//     day-to-day work.
//   * hide / unhide  — confidentiality backstop. Drops an email off the all-staff
//     timeline + the AI reads (summary / dispute helper) but keeps it visible to
//     ADMIN, audit preserved. Admin-only: hiding conceals, so it must not be a
//     lever a staff member can pull on (e.g.) a client complaint about themselves.
// All scoped to ingested emails (type='email' AND gmail_message_id IS NOT NULL)
// so this route can't touch staff notes / money-audit rows.
async function loadIngestedEmail(id: string): Promise<{ id: string; job_id: string | null } | null> {
  const r = await query(
    `SELECT id, job_id FROM interactions
      WHERE id = $1 AND type = 'email' AND gmail_message_id IS NOT NULL`,
    [id],
  );
  return r.rows[0] ?? null;
}

// POST /api/auto-chase/emails/:id/hide — hide an ingested email from the
// all-staff timeline (admin still sees it). Admin only.
router.post('/emails/:id/hide', authorize('admin'), async (req: AuthRequest, res: Response) => {
  try {
    const row = await loadIngestedEmail(String(req.params.id));
    if (!row) return res.status(404).json({ error: 'Ingested email not found' });
    await query(
      `UPDATE interactions SET hidden_at = NOW(), hidden_by = $2 WHERE id = $1`,
      [row.id, req.user?.id ?? null],
    );
    res.json({ data: { id: row.id, hidden: true } });
  } catch (error) {
    console.error('[auto-chase] hide email error:', error);
    res.status(500).json({ error: 'Failed to hide email' });
  }
});

// POST /api/auto-chase/emails/:id/unhide — restore a hidden email. Admin only.
router.post('/emails/:id/unhide', authorize('admin'), async (req: AuthRequest, res: Response) => {
  try {
    const row = await loadIngestedEmail(String(req.params.id));
    if (!row) return res.status(404).json({ error: 'Ingested email not found' });
    await query(`UPDATE interactions SET hidden_at = NULL, hidden_by = NULL WHERE id = $1`, [row.id]);
    res.json({ data: { id: row.id, hidden: false } });
  } catch (error) {
    console.error('[auto-chase] unhide email error:', error);
    res.status(500).json({ error: 'Failed to unhide email' });
  }
});

// POST /api/auto-chase/emails/:id/detach — "this isn't this job". Tombstone:
// keeps job_id so the email stays on the timeline as a greyed "removed from this
// job · Re-attach" line (recoverable if the detach was wrong), but flags it
// detached so it drops out of the AI reads (summary / dispute helper). STAFF_ROLES.
router.post('/emails/:id/detach', authorize(...STAFF_ROLES), async (req: AuthRequest, res: Response) => {
  try {
    const row = await loadIngestedEmail(String(req.params.id));
    if (!row) return res.status(404).json({ error: 'Ingested email not found' });
    await query(
      `UPDATE interactions SET detached_at = NOW(), detached_by = $2 WHERE id = $1`,
      [row.id, req.user?.id ?? null],
    );
    res.json({ data: { id: row.id, detached: true } });
  } catch (error) {
    console.error('[auto-chase] detach email error:', error);
    res.status(500).json({ error: 'Failed to detach email' });
  }
});

// POST /api/auto-chase/emails/:id/reattach — undo a detach (clears the tombstone).
router.post('/emails/:id/reattach', authorize(...STAFF_ROLES), async (req: AuthRequest, res: Response) => {
  try {
    const row = await loadIngestedEmail(String(req.params.id));
    if (!row) return res.status(404).json({ error: 'Ingested email not found' });
    await query(`UPDATE interactions SET detached_at = NULL, detached_by = NULL WHERE id = $1`, [row.id]);
    res.json({ data: { id: row.id, detached: false } });
  } catch (error) {
    console.error('[auto-chase] reattach email error:', error);
    res.status(500).json({ error: 'Failed to reattach email' });
  }
});

// POST /api/auto-chase/emails/:id/move — re-home to a different job. Body:
// { job_id }. Clears any detach tombstone (the email now belongs to the target).
// STAFF_ROLES.
router.post('/emails/:id/move', authorize(...STAFF_ROLES), async (req: AuthRequest, res: Response) => {
  try {
    const targetJobId = String(req.body?.job_id || '').trim();
    if (!targetJobId) return res.status(400).json({ error: 'job_id is required' });
    const row = await loadIngestedEmail(String(req.params.id));
    if (!row) return res.status(404).json({ error: 'Ingested email not found' });
    const target = await query(`SELECT id FROM jobs WHERE id = $1 AND is_deleted = false`, [targetJobId]);
    if (target.rows.length === 0) return res.status(404).json({ error: 'Target job not found' });
    await query(
      `UPDATE interactions
          SET job_id = $2,
              reattached_from_job_id = $3,
              reattached_at = NOW(),
              reattached_by = $4,
              detached_at = NULL,
              detached_by = NULL
        WHERE id = $1`,
      [row.id, targetJobId, row.job_id, req.user?.id ?? null],
    );
    res.json({ data: { id: row.id, job_id: targetJobId } });
  } catch (error) {
    console.error('[auto-chase] move email error:', error);
    res.status(500).json({ error: 'Failed to move email' });
  }
});

// GET /api/auto-chase/mailboxes — per-mailbox ingestion status: info@ (full) +
// each manager mailbox (matched-only), each probed live so a delegation gap
// surfaces inline. Admin only (managing which mailboxes we read is sensitive).
router.get('/mailboxes', authorize('admin'), async (_req: AuthRequest, res: Response) => {
  try {
    const status = await getAllGmailIngestionStatus();
    res.json({ data: status });
  } catch (error) {
    console.error('[auto-chase] mailboxes status error:', error);
    res.status(500).json({ error: 'Failed to read mailbox status' });
  }
});

// PUT /api/auto-chase/mailboxes — set the manager-mailbox list. Body:
// { mailboxes: string[] }. Each must be an @oooshtours.co.uk address and not the
// primary info@. Stored in system_settings.gmail_manager_mailboxes (JSON). Admin
// only. Returns the fresh per-mailbox status so the UI reflects connectivity.
router.put('/mailboxes', authorize('admin'), async (req: AuthRequest, res: Response) => {
  try {
    const input = Array.isArray(req.body?.mailboxes) ? req.body.mailboxes : null;
    if (!input) return res.status(400).json({ error: 'mailboxes must be an array' });

    const primary = getPrimaryMailbox().toLowerCase();
    const seen = new Set<string>();
    const clean: string[] = [];
    const rejected: string[] = [];
    for (const item of input) {
      const addr = String(item || '').trim().toLowerCase();
      if (!addr) continue;
      const valid = /^[^@\s]+@oooshtours\.co\.uk$/.test(addr);
      if (!valid || addr === primary) { rejected.push(addr); continue; }
      if (seen.has(addr)) continue;
      seen.add(addr);
      clean.push(addr);
    }
    if (rejected.length > 0) {
      return res.status(400).json({
        error: `Only @oooshtours.co.uk mailboxes (other than ${primary}) can be added. Rejected: ${rejected.join(', ')}`,
      });
    }

    await query(
      `INSERT INTO system_settings (key, value, category, value_type, updated_at, updated_by)
       VALUES ('gmail_manager_mailboxes', $1, 'chase', 'text', NOW(), $2)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW(), updated_by = EXCLUDED.updated_by`,
      [JSON.stringify(clean), req.user?.id ?? null],
    );

    const status = await getAllGmailIngestionStatus();
    res.json({ data: status });
  } catch (error) {
    console.error('[auto-chase] set mailboxes error:', error);
    res.status(500).json({ error: 'Failed to save mailbox list' });
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
    const signOffName = await senderFirstName(req.user?.id);
    const { draft, context } = await draftChaseEmail(String(req.params.jobId), { signOffName });
    res.json({ data: { draft, context } });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/not found/i.test(message)) return res.status(404).json({ error: message });
    console.error('[auto-chase] preview-draft error:', error);
    res.status(500).json({ error: 'Failed to draft chase' });
  }
});

// One-off cold-start pass: search the mailbox for each in-scope job's HH number
// and ingest the matching thread(s) onto that job. Idempotent (RFC822 dedup).
//
// A real run over the whole open pipeline fetches hundreds of Gmail threads +
// ingests thousands of messages — minutes of work, well past nginx's proxy
// timeout. So a real run executes in the BACKGROUND: POST kicks it off and
// returns immediately; GET polls live progress. A dry run (search + count, no
// ingest) is fast, so it stays synchronous. State is in-memory (single process,
// one-off op — a deploy mid-run just means re-run; dedup makes that safe).
let backfillState: {
  running: boolean;
  startedAt: string;
  finishedAt: string | null;
  summary: BackfillSummary;
} | null = null;

// POST /api/auto-chase/backfill — start a run (or return a dry-run result).
// Body: { limit?: number (default 500, max 1000), dryRun?: boolean,
//         scope?: 'enquiries' | 'active' | 'all' (default 'active') }. Admin.
router.post('/backfill', authorize('admin'), async (req: AuthRequest, res: Response) => {
  if (!isGmailConfigured()) {
    return res.status(503).json({ error: 'Gmail not configured — nothing to backfill.' });
  }
  const body = (req.body || {}) as { limit?: number; dryRun?: boolean; scope?: BackfillScope };

  // Dry run is fast — count synchronously.
  if (body.dryRun) {
    try {
      const summary = await backfillOpenPipelineThreads({ limit: body.limit, dryRun: true, scope: body.scope });
      return res.json({ data: summary });
    } catch (error) {
      console.error('[auto-chase] backfill dry-run error:', error);
      return res.status(500).json({ error: 'Backfill dry-run failed' });
    }
  }

  if (backfillState?.running) {
    return res.status(409).json({
      error: 'A backfill is already running — poll GET /api/auto-chase/backfill for progress.',
      data: { running: true, startedAt: backfillState.startedAt, ...backfillState.summary },
    });
  }

  // Start a background run; return immediately with a pollable state.
  // Initial scope is provisional — the service validates + overwrites it.
  const summary: BackfillSummary = {
    configured: true, dryRun: false, scope: body.scope ?? 'active',
    jobsScanned: 0, jobsWithHits: 0, threadsScanned: 0, threadsRejected: 0,
    logged: 0, skipped: 0, duplicates: 0,
  };
  backfillState = { running: true, startedAt: new Date().toISOString(), finishedAt: null, summary };
  backfillOpenPipelineThreads({ limit: body.limit, scope: body.scope, sink: summary })
    .catch((err) => { summary.error = err instanceof Error ? err.message : String(err); })
    .finally(() => {
      if (backfillState) { backfillState.running = false; backfillState.finishedAt = new Date().toISOString(); }
    });

  res.json({ data: { started: true, startedAt: backfillState.startedAt, scope: summary.scope } });
});

// GET /api/auto-chase/backfill — poll the last/current background run's progress.
router.get('/backfill', authorize('admin', 'manager'), (_req: AuthRequest, res: Response) => {
  if (!backfillState) return res.json({ data: { running: false, neverRun: true } });
  res.json({
    data: {
      running: backfillState.running,
      startedAt: backfillState.startedAt,
      finishedAt: backfillState.finishedAt,
      ...backfillState.summary,
    },
  });
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
    const signOffName = await senderFirstName(req.user?.id);
    const result = await createChaseDraftForJob(String(req.params.jobId), signOffName);
    res.json({ data: result });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/not found/i.test(message)) return res.status(404).json({ error: message });
    if (/no client email/i.test(message)) return res.status(422).json({ error: message });
    console.error('[auto-chase] create-draft error:', error);
    res.status(500).json({ error: message || 'Failed to create chase draft' });
  }
});

// POST /api/auto-chase/run-due — run the due-auto-chase pass now (admin). Same
// engine as the daily 08:10 cron — handy for testing without waiting. Honours
// the per-job auto_chase_mode + the auto_chase_send_enabled master switch, so a
// manual run can't send anything the scheduled run wouldn't.
router.post('/run-due', authorize('admin'), async (_req: AuthRequest, res: Response) => {
  try {
    const summary = await runDueAutoChases();
    res.json({ data: summary });
  } catch (error) {
    console.error('[auto-chase] run-due error:', error);
    res.status(500).json({ error: 'Auto-chase run failed' });
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

// POST /api/auto-chase/comms-query/:jobId — dispute helper (§7.2). Answer a
// natural-language question about a job's ingested email chain. STAFF_ROLES —
// operational context on a job the whole team works from. Returns
// { available:false } when there's nothing ingested to query.
router.post('/comms-query/:jobId', authorize(...STAFF_ROLES), async (req: AuthRequest, res: Response) => {
  if (!isAnthropicConfigured()) {
    return res.status(503).json({ error: 'Comms query unavailable — ANTHROPIC_API_KEY not configured.' });
  }
  try {
    const question = String((req.body || {}).question || '');
    if (!question.trim()) return res.status(400).json({ error: 'Ask a question.' });
    const result = await answerCommsQuery(String(req.params.jobId), question);
    if (!result) return res.json({ data: { available: false, answer: null } });
    res.json({ data: { available: true, answer: result.answer } });
  } catch (error) {
    console.error('[auto-chase] comms-query error:', error);
    res.status(500).json({ error: 'Failed to answer the question' });
  }
});

// ── Quote-PDF version diff (spec §7.3) ──────────────────────────────────────
// GET harvests-if-stale + lazy-extracts + returns versions & consecutive diffs.
// Quote PDFs surface on the Activity Timeline; they never enter jobs.files.
// STAFF_ROLES — operational context on a job the whole team works from.

// GET /api/auto-chase/quote-versions/:jobId — versions + diffs (harvest if stale).
router.get('/quote-versions/:jobId', authorize(...STAFF_ROLES), async (req: AuthRequest, res: Response) => {
  try {
    const result = await getJobQuoteVersions(String(req.params.jobId));
    res.json({ data: result });
  } catch (error) {
    console.error('[auto-chase] quote-versions error:', error);
    res.status(500).json({ error: 'Failed to load quote versions' });
  }
});

// POST /api/auto-chase/quote-versions/:jobId/refresh — force a fresh mailbox harvest.
router.post('/quote-versions/:jobId/refresh', authorize(...STAFF_ROLES), async (req: AuthRequest, res: Response) => {
  try {
    const result = await getJobQuoteVersions(String(req.params.jobId), { forceHarvest: true });
    res.json({ data: result });
  } catch (error) {
    console.error('[auto-chase] quote-versions refresh error:', error);
    res.status(500).json({ error: 'Failed to refresh quote versions' });
  }
});

// One-off cold-start sweep over the open pipeline (harvest only — extraction
// stays lazy-on-view). Background like the thread backfill (a real run searches
// the mailbox per job — well past the proxy timeout). Admin.
let quoteSweepState: {
  running: boolean;
  startedAt: string;
  finishedAt: string | null;
  summary: QuoteSweepSummary;
} | null = null;

// POST /api/auto-chase/quote-versions-sweep — start a background sweep. Admin.
router.post('/quote-versions-sweep', authorize('admin'), async (req: AuthRequest, res: Response) => {
  if (!isGmailConfigured()) {
    return res.status(503).json({ error: 'Gmail not configured — nothing to sweep.' });
  }
  if (quoteSweepState?.running) {
    return res.status(409).json({
      error: 'A quote-versions sweep is already running — poll GET /api/auto-chase/quote-versions-sweep.',
      data: { running: true, startedAt: quoteSweepState.startedAt, ...quoteSweepState.summary },
    });
  }
  const limit = Math.min(parseInt(String((req.body || {}).limit || '500'), 10) || 500, 2000);
  const summary: QuoteSweepSummary = { configured: true, jobsScanned: 0, jobsWithQuotes: 0, stored: 0 };
  quoteSweepState = { running: true, startedAt: new Date().toISOString(), finishedAt: null, summary };
  sweepQuoteVersions({ limit, sink: summary })
    .catch((err) => { summary.error = err instanceof Error ? err.message : String(err); })
    .finally(() => {
      if (quoteSweepState) { quoteSweepState.running = false; quoteSweepState.finishedAt = new Date().toISOString(); }
    });
  res.json({ data: { started: true, startedAt: quoteSweepState.startedAt } });
});

// GET /api/auto-chase/quote-versions-sweep — poll the last/current sweep.
router.get('/quote-versions-sweep', authorize('admin', 'manager'), (_req: AuthRequest, res: Response) => {
  if (!quoteSweepState) return res.json({ data: { running: false, neverRun: true } });
  res.json({
    data: {
      running: quoteSweepState.running,
      startedAt: quoteSweepState.startedAt,
      finishedAt: quoteSweepState.finishedAt,
      ...quoteSweepState.summary,
    },
  });
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
