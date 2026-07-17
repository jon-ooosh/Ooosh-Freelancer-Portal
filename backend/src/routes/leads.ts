/**
 * Leads — the Lead Finder (Tour Finder → OP). Spec: docs/TOUR-FINDER-SPEC.md.
 *
 * PR 1: collect → detect → score pipeline + trigger/status + list + lifecycle.
 * Address-book matching, contact research and enrichment land in later slices.
 *
 * Endpoints:
 *   GET   /                 — list leads (filter by stream/status/min score)   STAFF
 *   GET   /runs/latest      — most recent pipeline run (status + counts)        STAFF
 *   GET   /settings         — the 'leads' system-settings (config panel)        STAFF
 *   POST  /run              — kick off a pipeline run (background)              MANAGER
 *   PATCH /:id              — lifecycle action (status / assignment)            STAFF
 */
import { Router, Response } from 'express';
import { z } from 'zod';
import { query } from '../config/database';
import { authenticate, authorize, AuthRequest, STAFF_ROLES, MANAGER_ROLES } from '../middleware/auth';
import { validate } from '../middleware/validate';
import { isTicketmasterConfigured } from '../services/leads/ticketmaster';
import { isAnthropicConfigured } from '../config/anthropic';
import { isRunActive, createRun, runPipeline } from '../services/leads/pipeline';

const router = Router();
router.use(authenticate);

const LEAD_COLUMNS = `
  id, artist_name, tm_artist_id, uk_date_count, first_date, last_date, venues, all_dates,
  relevance_score, client_tier, origin_country, is_international, reasoning, ai_summary, scored_at,
  matched_organisation_id, match_confidence, match_candidates, stream,
  status, status_reason, assigned_to, converted_job_id, created_at, updated_at`;

// GET /api/leads — list. Defaults: hide dismissed/not_relevant, best score first.
router.get('/', authorize(...STAFF_ROLES), async (req: AuthRequest, res: Response) => {
  try {
    const stream = typeof req.query.stream === 'string' ? req.query.stream : null;
    const status = typeof req.query.status === 'string' ? req.query.status : null;
    const minScore = req.query.min_score ? Number(req.query.min_score) : null;
    const includeHidden = req.query.include_hidden === '1';

    const where: string[] = [];
    const params: unknown[] = [];
    if (stream) { params.push(stream); where.push(`stream = $${params.length}`); }
    if (status) { params.push(status); where.push(`status = $${params.length}`); }
    else if (!includeHidden) { where.push(`status NOT IN ('dismissed', 'not_relevant')`); }
    if (minScore != null && Number.isFinite(minScore)) { params.push(minScore); where.push(`relevance_score >= $${params.length}`); }

    const result = await query(
      `SELECT ${LEAD_COLUMNS} FROM leads
       ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
       ORDER BY relevance_score DESC NULLS LAST, first_date ASC NULLS LAST
       LIMIT 500`,
      params,
    );
    res.json({ data: result.rows });
  } catch (error) {
    console.error('[leads] list error:', error);
    res.status(500).json({ error: 'Failed to load leads' });
  }
});

// GET /api/leads/runs/latest — most recent run for the "last run" stamp + polling.
router.get('/runs/latest', authorize(...STAFF_ROLES), async (_req: AuthRequest, res: Response) => {
  try {
    const r = await query(
      `SELECT lr.id, lr.trigger, lr.status, lr.counts, lr.error, lr.started_at, lr.finished_at,
              p.first_name AS triggered_by_name
         FROM lead_runs lr
         LEFT JOIN users u ON u.id = lr.triggered_by
         LEFT JOIN people p ON p.id = u.person_id
        ORDER BY lr.started_at DESC LIMIT 1`,
    );
    res.json({ data: r.rows[0] ?? null });
  } catch (error) {
    console.error('[leads] latest run error:', error);
    res.status(500).json({ error: 'Failed to load run status' });
  }
});

// GET /api/leads/settings — the 'leads' config knobs, for the panel.
router.get('/settings', authorize(...STAFF_ROLES), async (_req: AuthRequest, res: Response) => {
  try {
    const r = await query(
      `SELECT key, value, label, value_type, sort_order FROM system_settings
        WHERE category = 'leads' ORDER BY sort_order, key`,
    );
    res.json({ data: r.rows });
  } catch (error) {
    console.error('[leads] settings error:', error);
    res.status(500).json({ error: 'Failed to load settings' });
  }
});

// POST /api/leads/run — kick off a pipeline run in the background.
router.post('/run', authorize(...MANAGER_ROLES), async (req: AuthRequest, res: Response) => {
  try {
    if (!isTicketmasterConfigured()) {
      return res.status(503).json({ error: 'Ticketmaster not configured', detail: 'Set TICKETMASTER_API_KEY on the server.' });
    }
    if (!isAnthropicConfigured()) {
      return res.status(503).json({ error: 'Anthropic not configured', detail: 'Set ANTHROPIC_API_KEY on the server.' });
    }
    if (await isRunActive()) {
      return res.status(409).json({ error: 'A lead search is already running' });
    }
    const runId = await createRun(req.user?.id ?? null, 'manual');
    // Fire-and-forget: the pipeline updates lead_runs itself; the page polls it.
    setImmediate(() => { void runPipeline(runId); });
    res.status(202).json({ data: { run_id: runId } });
  } catch (error) {
    console.error('[leads] run error:', error);
    res.status(500).json({ error: 'Failed to start lead search' });
  }
});

// PATCH /api/leads/:id — lifecycle action.
const patchSchema = z.object({
  status: z.enum(['new', 'reviewing', 'contacted', 'converted', 'dismissed', 'not_relevant']).optional(),
  status_reason: z.string().max(500).nullable().optional(),
  assigned_to: z.string().uuid().nullable().optional(),
});
router.patch('/:id', authorize(...STAFF_ROLES), validate(patchSchema), async (req: AuthRequest, res: Response) => {
  try {
    const sets: string[] = [];
    const params: unknown[] = [req.params.id];
    const body = req.body as z.infer<typeof patchSchema>;
    for (const field of ['status', 'status_reason', 'assigned_to'] as const) {
      if (body[field] !== undefined) { params.push(body[field]); sets.push(`${field} = $${params.length}`); }
    }
    if (sets.length === 0) return res.status(400).json({ error: 'No fields to update' });
    const r = await query(
      `UPDATE leads SET ${sets.join(', ')}, updated_at = NOW() WHERE id = $1 RETURNING ${LEAD_COLUMNS}`,
      params,
    );
    if (!r.rows[0]) return res.status(404).json({ error: 'Lead not found' });
    res.json({ data: r.rows[0] });
  } catch (error) {
    console.error('[leads] patch error:', error);
    res.status(500).json({ error: 'Failed to update lead' });
  }
});

export default router;
