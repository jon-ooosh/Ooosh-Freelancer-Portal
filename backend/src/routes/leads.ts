/**
 * Leads — the Lead Finder (Tour Finder → OP). Spec: docs/TOUR-FINDER-SPEC.md.
 *
 * Endpoints:
 *   GET   /                          — list leads (?view=hidden for dismissed / not relevant)  STAFF
 *   GET   /runs/latest               — most recent pipeline run (status + counts)              STAFF
 *   GET   /runs                      — search history (last 30 runs + how many leads each found) STAFF
 *   GET   /:id/events                — the lead's activity timeline                             STAFF
 *   GET   /settings                  — the 'leads' system-settings (+ default search window)   STAFF
 *   POST  /run                       — kick off a pipeline run (optional {from, to} window)    MANAGER
 *   POST  /process-existing          — match → score → research existing leads, no crawl       MANAGER
 *   POST  /cancel                    — stop a stuck run                                         MANAGER
 *   PATCH /:id                       — lifecycle (status / assignment)                          STAFF
 *   POST  /:id/dismiss               — dismiss with a reason ("not a fit" suppresses the act)   STAFF
 *   POST  /:id/restore               — undo a dismiss (and any suppression)                     STAFF
 *   POST  /:id/confirm-match         — link a suggested org as the match                        STAFF
 *   POST  /:id/reject-match          — "none of these" — never suggest them again               STAFF
 *   GET   /:id/address-book-preview  — similar orgs + which contacts we already hold            STAFF
 *   POST  /:id/add-to-address-book   — create / pick the band org, add chosen contacts          STAFF
 *   GET   /:id/enquiry-preview       — the org + its people, to pick enquiry contacts           STAFF
 *   POST  /:id/start-enquiry         — OP-native enquiry from this lead (never pushes to HH)    STAFF
 *   POST  /:id/log-outreach          — "I've contacted them": note + optional Cold enquiry so
 *                                      the pipeline chases the follow-up                          STAFF
 *   POST  /:id/research              — "Research again": contact research for this one lead,
 *                                      in the background                                          STAFF
 *   POST  /:id/contacts              — add a contact by hand (kept through any re-research)      STAFF
 *   DELETE /:id/contacts/:idx        — remove a contact                                          STAFF
 *   GET   /:id/tour-jobs/candidates  — the band's other jobs, to link one by hand                STAFF
 *   POST  /:id/tour-jobs             — link a job to this tour (by job id or HireHop number)    STAFF
 *   POST  /:id/tour-jobs/:jobId/confirm — confirm a suggested job                               STAFF
 *   DELETE /:id/tour-jobs/:jobId     — unlink (never re-linked automatically)                   STAFF
 */
import { Router, Response } from 'express';
import { z } from 'zod';
import { query } from '../config/database';
import { authenticate, authorize, AuthRequest, STAFF_ROLES, MANAGER_ROLES } from '../middleware/auth';
import { validate } from '../middleware/validate';
import { logAudit } from '../middleware/audit';
import { isTicketmasterConfigured } from '../services/leads/ticketmaster';
import { isAnthropicConfigured } from '../config/anthropic';
import {
  isRunActive, createRun, runPipeline, runProcessExisting, sweepZombieLeadRuns,
  defaultSearchWindow, MAX_WINDOW_DAYS,
} from '../services/leads/pipeline';
import {
  linkLeadToOrg, linkKnownContacts, findOrgNameCandidates, normaliseArtist, MatchCandidate,
} from '../services/leads/matcher';
import {
  splitName, findPersonByEmail, findOrCreatePersonByEmail, findOrgByExactName,
  createOrganisation, linkPersonToOrganisation, isGenericMailbox, addOrganisationEmail,
} from '../services/address-book-resolve';
import { createPipelineEnquiry, EnquiryValidationError } from '../services/pipeline-enquiry';
import { logLeadEvent } from '../services/leads/events';
import { dateOnly } from '../services/leads/dates';
import { researchLead } from '../services/leads/researcher';
import { liveTourJobSql, syncTourJobs, TOUR_JOB_OUTCOME_SQL, noteLinkedJobs, noteUnlinkedJob } from '../services/leads/tour-jobs';
import { ukToday, ukDatePlus } from '../services/uk-date';

const router = Router();
router.use(authenticate);
// Staff only — a no-op today (only staff hold a staff token) but it keeps this
// router closed if a non-staff login shape is ever added (Oct 2026 audit).
router.use(authorize(...STAFF_ROLES));

const LEAD_COLUMNS = `
  id, artist_name, tm_artist_id, uk_date_count, first_date, last_date, venues, all_dates,
  relevance_score, client_tier, origin_country, is_international, reasoning, ai_summary, scored_at,
  matched_organisation_id, match_confidence, match_candidates, match_via, rejected_org_ids, stream, contacts,
  client_history, history_scored_at, known_contacts,
  status, status_reason, status_note, assigned_to, converted_job_id, created_at, updated_at,
  first_run_id, contacted_at, researched_at, research_status, external_links`;

// Same columns, prefixed for the list query's joins.
const LEAD_COLUMNS_PREFIXED = LEAD_COLUMNS.split(',').map((c) => `l.${c.trim()}`).join(', ');

const HIDDEN_STATUSES = `('dismissed', 'not_relevant')`;

/**
 * Where a lead has got to — the Leads page tabs. ONE definition (the frontend
 * reads `stage` off the row rather than re-deriving it):
 *   review    — new / reviewing: nobody has acted yet
 *   contacted — outreach logged, no enquiry
 *   pipeline  — an enquiry exists (Start enquiry, or outreach with an enquiry), or
 *               an open / booked job for this tour is linked (tour-jobs.ts)
 *   dismissed — dismissed, or the AI marked it not relevant
 */
const STAGE_SQL = `CASE
    WHEN l.status IN ${HIDDEN_STATUSES} THEN 'dismissed'
    WHEN l.converted_job_id IS NOT NULL OR l.status = 'converted' OR ${liveTourJobSql('l')} THEN 'pipeline'
    WHEN l.status = 'contacted' THEN 'contacted'
    ELSE 'review' END`;

/** "First name" of whoever did an event — users → people. */
const EVENT_ACTOR_SQL = `(SELECT COALESCE(NULLIF(pp.preferred_name, ''), pp.first_name)
     FROM users uu JOIN people pp ON pp.id = uu.person_id WHERE uu.id = e.user_id)`;

/** Researched contact type → person ↔ org role (PERSON_ORG_ROLES). */
const CONTACT_ROLE: Record<string, string> = {
  manager: 'Manager',
  booking_agent: 'Booking Agent',
  tour_manager: 'Tour Manager',
  band: 'General Contact',
  general: 'General Contact',
};

interface LeadContact {
  contact_type: string;
  contact_name: string | null;
  contact_email: string | null;
  contact_phone: string | null;
  source: string | null;
  confidence: string;
  manual?: boolean;
}

/** DATE → 'YYYY-MM-DD' (timezone-safe — see dates.ts). */
const ymd = dateOnly;

async function loadLead(id: string) {
  const r = await query(`SELECT ${LEAD_COLUMNS} FROM leads WHERE id = $1`, [id]);
  return r.rows[0] ?? null;
}

// GET /api/leads — list. Default: open leads (dismissed / not relevant hidden).
// ?view=hidden → ONLY the dismissed / not-relevant ones (the Dismissed tab).
router.get('/', authorize(...STAFF_ROLES), async (req: AuthRequest, res: Response) => {
  try {
    const stream = typeof req.query.stream === 'string' ? req.query.stream : null;
    const status = typeof req.query.status === 'string' ? req.query.status : null;
    const minScore = req.query.min_score ? Number(req.query.min_score) : null;
    const hiddenView = req.query.view === 'hidden';
    const includeHidden = req.query.include_hidden === '1';

    const where: string[] = [];
    const params: unknown[] = [];
    if (stream) { params.push(stream); where.push(`l.stream = $${params.length}`); }
    if (status) { params.push(status); where.push(`l.status = $${params.length}`); }
    else if (hiddenView) { where.push(`l.status IN ${HIDDEN_STATUSES}`); }
    else if (!includeHidden) { where.push(`l.status NOT IN ${HIDDEN_STATUSES}`); }
    if (minScore != null && Number.isFinite(minScore)) { params.push(minScore); where.push(`l.relevance_score >= $${params.length}`); }

    // prev_* = the act's previous tour lead, so "you passed last time because…"
    // (and "flag their next tour") shows on the new one.
    const result = await query(
      `SELECT ${LEAD_COLUMNS_PREFIXED}, o.name AS matched_org_name, ${STAGE_SQL} AS stage,
              le.event AS last_event, le.detail AS last_event_detail, le.created_at AS last_event_at,
              le.actor AS last_event_by, tj.tour_jobs,
              cj.hh_job_number AS converted_job_number, cj.job_name AS converted_job_name,
              cj.pipeline_status AS converted_job_status,
              prev.id AS prev_lead_id, prev.status AS prev_status, prev.status_reason AS prev_status_reason,
              prev.status_note AS prev_status_note, prev.first_date AS prev_first_date,
              prev.last_date AS prev_last_date, prev.converted_job_id AS prev_converted_job_id
         FROM leads l
         LEFT JOIN organisations o ON o.id = l.matched_organisation_id
         LEFT JOIN jobs cj ON cj.id = l.converted_job_id AND cj.is_deleted = false
         LEFT JOIN LATERAL (
           SELECT p.id, p.status, p.status_reason, p.status_note, p.first_date, p.last_date, p.converted_job_id
             FROM leads p
            WHERE lower(p.artist_name) = lower(l.artist_name) AND p.id <> l.id
              AND p.first_date < l.first_date
            ORDER BY p.first_date DESC
            LIMIT 1
         ) prev ON true
         LEFT JOIN LATERAL (
           SELECT e.event, e.detail, e.created_at, ${EVENT_ACTOR_SQL} AS actor
             FROM lead_events e WHERE e.lead_id = l.id
            ORDER BY e.created_at DESC LIMIT 1
         ) le ON true
         LEFT JOIN LATERAL (
           SELECT COALESCE(json_agg(json_build_object(
                    'job_id', j.id, 'hh_job_number', j.hh_job_number, 'job_name', j.job_name,
                    'status', ltj.status, 'link_type', ltj.link_type, 'outcome', ${TOUR_JOB_OUTCOME_SQL},
                    'pipeline_status', j.pipeline_status, 'lost_reason', j.lost_reason, 'job_value', j.job_value,
                    'start', COALESCE(j.out_date, j.job_date), 'end', COALESCE(j.return_date, j.job_end))
                  ORDER BY COALESCE(j.out_date, j.job_date)), '[]'::json) AS tour_jobs
             FROM lead_tour_jobs ltj JOIN jobs j ON j.id = ltj.job_id AND j.is_deleted = false
            WHERE ltj.lead_id = l.id AND ltj.status IN ('linked', 'suggested')
         ) tj ON true
       ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
       ORDER BY ${hiddenView ? 'l.updated_at DESC' : 'l.relevance_score DESC NULLS LAST, l.first_date ASC NULLS LAST'}
       LIMIT 2000`,
      params,
    );
    // The Dismissed tab's count, without loading those rows until it's opened.
    const hidden = await query(`SELECT COUNT(*)::int AS n FROM leads WHERE status IN ${HIDDEN_STATUSES}`);
    res.json({ data: result.rows, hidden_count: hidden.rows[0].n });
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
              COALESCE(NULLIF(p.preferred_name, ''), p.first_name) AS triggered_by_name
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

// GET /api/leads/runs — search history: the last 30 runs, newest first, with
// how many leads each one FOUND (first_run_id) — the batch picker + History panel.
router.get('/runs', authorize(...STAFF_ROLES), async (_req: AuthRequest, res: Response) => {
  try {
    const r = await query(
      `SELECT lr.id, lr.trigger, lr.status, lr.counts, lr.error, lr.started_at, lr.finished_at,
              COALESCE(NULLIF(p.preferred_name, ''), p.first_name) AS triggered_by_name,
              (SELECT COUNT(*)::int FROM leads l WHERE l.first_run_id = lr.id) AS leads_found
         FROM lead_runs lr
         LEFT JOIN users u ON u.id = lr.triggered_by
         LEFT JOIN people p ON p.id = u.person_id
        ORDER BY lr.started_at DESC LIMIT 30`,
    );
    res.json({ data: r.rows });
  } catch (error) {
    console.error('[leads] runs error:', error);
    res.status(500).json({ error: 'Failed to load search history' });
  }
});

// GET /api/leads/settings — the 'leads' config knobs, plus today's default
// search window so the Run panel can pre-fill its dates.
router.get('/settings', authorize(...STAFF_ROLES), async (_req: AuthRequest, res: Response) => {
  try {
    const r = await query(
      `SELECT key, value, label, value_type, sort_order FROM system_settings
        WHERE category = 'leads' ORDER BY sort_order, key`,
    );
    res.json({ data: r.rows, default_window: await defaultSearchWindow(), max_window_days: MAX_WINDOW_DAYS });
  } catch (error) {
    console.error('[leads] settings error:', error);
    res.status(500).json({ error: 'Failed to load settings' });
  }
});

// POST /api/leads/run — kick off a pipeline run in the background.
// Optional body { from, to } (YYYY-MM-DD): find tours STARTING in that window.
const runSchema = z.object({
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
}).refine((b) => Boolean(b.from) === Boolean(b.to), { message: 'Give both a from and a to date, or neither' });
router.post('/run', authorize(...MANAGER_ROLES), validate(runSchema), async (req: AuthRequest, res: Response) => {
  try {
    if (!isTicketmasterConfigured()) {
      return res.status(503).json({ error: 'Ticketmaster not configured', detail: 'Set TICKETMASTER_API_KEY on the server.' });
    }
    if (!isAnthropicConfigured()) {
      return res.status(503).json({ error: 'Anthropic not configured', detail: 'Set ANTHROPIC_API_KEY on the server.' });
    }
    const body = req.body as z.infer<typeof runSchema>;
    let window: { from: string; to: string } | undefined;
    if (body.from && body.to) {
      const today = ukToday();
      if (body.from < today) return res.status(400).json({ error: 'The search can’t start in the past' });
      if (body.to < body.from) return res.status(400).json({ error: 'The end date is before the start date' });
      const days = (new Date(body.to).getTime() - new Date(body.from).getTime()) / 86_400_000;
      if (!Number.isFinite(days)) return res.status(400).json({ error: 'Invalid dates' });
      if (days > MAX_WINDOW_DAYS) return res.status(400).json({ error: `Keep the window to a year or less (Ticketmaster call budget)` });
      window = { from: body.from, to: body.to };
    }
    if (await isRunActive()) {
      return res.status(409).json({ error: 'A lead search is already running' });
    }
    const runId = await createRun(req.user?.id ?? null, 'manual');
    // Fire-and-forget: the pipeline updates lead_runs itself; the page polls it.
    setImmediate(() => { void runPipeline(runId, window); });
    res.status(202).json({ data: { run_id: runId } });
  } catch (error) {
    console.error('[leads] run error:', error);
    res.status(500).json({ error: 'Failed to start lead search' });
  }
});

// POST /api/leads/process-existing — match + score + research existing leads (no TM crawl).
router.post('/process-existing', authorize(...MANAGER_ROLES), async (req: AuthRequest, res: Response) => {
  try {
    if (await isRunActive()) return res.status(409).json({ error: 'A lead search is already running' });
    const runId = await createRun(req.user?.id ?? null, 'manual');
    setImmediate(() => { void runProcessExisting(runId); });
    res.status(202).json({ data: { run_id: runId } });
  } catch (error) {
    console.error('[leads] process-existing error:', error);
    res.status(500).json({ error: 'Failed to start processing' });
  }
});

// POST /api/leads/cancel — stop/reset any stuck run (marks running runs failed).
router.post('/cancel', authorize(...MANAGER_ROLES), async (_req: AuthRequest, res: Response) => {
  try {
    const swept = await sweepZombieLeadRuns('Cancelled by staff');
    res.json({ data: { cancelled: swept } });
  } catch (error) {
    console.error('[leads] cancel error:', error);
    res.status(500).json({ error: 'Failed to cancel run' });
  }
});

// GET /api/leads/:id/events — the lead's timeline, newest first.
router.get('/:id/events', authorize(...STAFF_ROLES), async (req: AuthRequest, res: Response) => {
  try {
    const r = await query(
      `SELECT e.id, e.event, e.detail, e.created_at, e.run_id, ${EVENT_ACTOR_SQL} AS actor
         FROM lead_events e WHERE e.lead_id = $1
        ORDER BY e.created_at DESC LIMIT 100`,
      [req.params.id],
    );
    res.json({ data: r.rows });
  } catch (error) {
    console.error('[leads] events error:', error);
    res.status(500).json({ error: 'Failed to load activity' });
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
    if (body.status !== undefined) await logLeadEvent(r.rows[0].id, 'status', { detail: body.status, userId: req.user?.id });
    res.json({ data: r.rows[0] });
  } catch (error) {
    console.error('[leads] patch error:', error);
    res.status(500).json({ error: 'Failed to update lead' });
  }
});

// POST /api/leads/:id/dismiss — dismiss with a reason.
//   not_a_fit       — never show this act again (suppressed: the detector skips
//                     them; their other open tours are dismissed too).
//   timing          — too close / already sorted for THIS tour. Next tour shows.
//   next_time       — not this time; their next tour arrives flagged with this.
//   already_handled — in touch / dealing with it elsewhere.
//   other           — needs a note.
const DISMISS_REASONS = ['not_a_fit', 'timing', 'next_time', 'already_handled', 'other'] as const;
const dismissSchema = z.object({
  reason: z.enum(DISMISS_REASONS),
  note: z.string().max(1000).nullable().optional(),
}).refine((b) => b.reason !== 'other' || Boolean(b.note?.trim()), { message: 'Add a note for "Other"' });
router.post('/:id/dismiss', authorize(...STAFF_ROLES), validate(dismissSchema), async (req: AuthRequest, res: Response) => {
  try {
    const { reason, note } = req.body as z.infer<typeof dismissSchema>;
    const lead = await loadLead(req.params.id as string);
    if (!lead) return res.status(404).json({ error: 'Lead not found' });
    const cleanNote = note?.trim() || null;

    if (reason === 'not_a_fit') {
      await query(
        `INSERT INTO lead_suppressions (artist_key, artist_name, tm_artist_id, reason, note, created_by)
         VALUES ($1, $2, $3, 'not_a_fit', $4, $5)
         ON CONFLICT (artist_key) DO UPDATE SET
           note = EXCLUDED.note, tm_artist_id = COALESCE(EXCLUDED.tm_artist_id, lead_suppressions.tm_artist_id)`,
        [normaliseArtist(lead.artist_name), lead.artist_name, lead.tm_artist_id ?? null, cleanNote, req.user?.id ?? null],
      );
      // Their other open tours go too — "don't show this band again" means now as well.
      await query(
        `UPDATE leads SET status = 'dismissed', status_reason = 'not_a_fit', status_note = $2, updated_at = NOW()
          WHERE id <> $1 AND status NOT IN ${HIDDEN_STATUSES} AND status <> 'converted'
            AND (lower(artist_name) = lower($3) OR (COALESCE($4, '') <> '' AND tm_artist_id = $4))`,
        [lead.id, cleanNote, lead.artist_name, lead.tm_artist_id ?? null],
      );
    }

    await query(
      `UPDATE leads SET status = 'dismissed', status_reason = $2, status_note = $3, updated_at = NOW() WHERE id = $1`,
      [lead.id, reason, cleanNote],
    );
    await logLeadEvent(lead.id, 'dismissed', { detail: `${reason}${cleanNote ? ` — ${cleanNote}` : ''}`, userId: req.user?.id });
    res.json({ data: await loadLead(lead.id) });
  } catch (error) {
    console.error('[leads] dismiss error:', error);
    res.status(500).json({ error: 'Failed to dismiss lead' });
  }
});

// POST /api/leads/:id/restore — back to 'new'; lifts a "not a fit" suppression.
router.post('/:id/restore', authorize(...STAFF_ROLES), async (req: AuthRequest, res: Response) => {
  try {
    const lead = await loadLead(req.params.id as string);
    if (!lead) return res.status(404).json({ error: 'Lead not found' });
    await query(`DELETE FROM lead_suppressions WHERE artist_key = $1`, [normaliseArtist(lead.artist_name)]);
    await query(
      `UPDATE leads SET status = 'new', status_reason = NULL, status_note = NULL, updated_at = NOW() WHERE id = $1`,
      [lead.id],
    );
    await logLeadEvent(lead.id, 'restored', { userId: req.user?.id });
    await syncTourJobs(lead.id);
    res.json({ data: await loadLead(lead.id) });
  } catch (error) {
    console.error('[leads] restore error:', error);
    res.status(500).json({ error: 'Failed to restore lead' });
  }
});

// POST /api/leads/:id/confirm-match — link a suggested org as the match.
const confirmSchema = z.object({ organisation_id: z.string().uuid() });
router.post('/:id/confirm-match', authorize(...STAFF_ROLES), validate(confirmSchema), async (req: AuthRequest, res: Response) => {
  try {
    const orgId = (req.body as z.infer<typeof confirmSchema>).organisation_id;
    const lead = await loadLead(req.params.id as string);
    if (!lead) return res.status(404).json({ error: 'Lead not found' });
    const org = await query(`SELECT id FROM organisations WHERE id = $1 AND is_deleted = false`, [orgId]);
    if (!org.rows[0]) return res.status(404).json({ error: 'Organisation not found' });

    // A job-name suggestion (management / agency org) keeps its narrower history scope.
    const cand = ((lead.match_candidates ?? []) as MatchCandidate[]).find((c) => c.id === orgId);
    await linkLeadToOrg(lead.id, orgId, cand?.via === 'job_name' ? 'job_name' : 'org_name', { enrichOrg: true });
    await logLeadEvent(lead.id, 'match_confirmed', { detail: cand?.name ?? null, userId: req.user?.id });
    await syncTourJobs(lead.id);
    res.json({ data: await loadLead(lead.id) });
  } catch (error) {
    console.error('[leads] confirm-match error:', error);
    res.status(500).json({ error: 'Failed to confirm match' });
  }
});

// POST /api/leads/:id/reject-match — "None of these" → cold, and remember the
// rejected orgs so the next run doesn't suggest them again.
router.post('/:id/reject-match', authorize(...STAFF_ROLES), async (req: AuthRequest, res: Response) => {
  try {
    const r = await query(
      `UPDATE leads SET
         rejected_org_ids = ARRAY(
           SELECT DISTINCT x FROM unnest(
             rejected_org_ids || ARRAY(SELECT (c->>'id')::uuid FROM jsonb_array_elements(match_candidates) c WHERE c ? 'id')
           ) x),
         match_confidence = 'none', matched_organisation_id = NULL, match_via = NULL,
         match_candidates = '[]'::jsonb, stream = 'cold', updated_at = NOW()
       WHERE id = $1 RETURNING ${LEAD_COLUMNS}`,
      [req.params.id],
    );
    if (!r.rows[0]) return res.status(404).json({ error: 'Lead not found' });
    await logLeadEvent(r.rows[0].id, 'match_rejected', { userId: req.user?.id });
    res.json({ data: r.rows[0] });
  } catch (error) {
    console.error('[leads] reject-match error:', error);
    res.status(500).json({ error: 'Failed to reject match' });
  }
});

// GET /api/leads/:id/address-book-preview — before "Add to address book":
// similar orgs already there ("did you mean…?") and which researched contacts
// are already people (exact email).
router.get('/:id/address-book-preview', authorize(...STAFF_ROLES), async (req: AuthRequest, res: Response) => {
  try {
    const lead = await loadLead(req.params.id as string);
    if (!lead) return res.status(404).json({ error: 'Lead not found' });

    // "Did you mean…?": orgs booked under jobs named after the band (the
    // management-company case) first, then similar org names.
    const target = normaliseArtist(lead.artist_name);
    const rejected = new Set((lead.rejected_org_ids ?? []) as string[]);
    const jobNamed = ((lead.match_candidates ?? []) as MatchCandidate[]).filter((c) => c.via === 'job_name');
    const byName = (await findOrgNameCandidates(lead.artist_name)).filter((c) => !jobNamed.some((j) => j.id === c.id));
    const similar = [...jobNamed, ...byName]
      .filter((c) => !rejected.has(c.id))
      .slice(0, 6)
      .map((c) => ({ ...c, exact: normaliseArtist(c.name) === target }));

    const contacts = await Promise.all(((lead.contacts ?? []) as LeadContact[]).map(async (c, idx) => {
      const email = c.contact_email?.trim() || null;
      let existing: { id: string; name: string } | null = null;
      if (email) {
        const pid = await findPersonByEmail(email);
        if (pid) {
          const p = await query(
            `SELECT CONCAT(COALESCE(NULLIF(p.preferred_name, ''), p.first_name), ' ', p.last_name) AS name FROM people p WHERE p.id = $1`,
            [pid],
          );
          existing = { id: pid, name: String(p.rows[0]?.name ?? '').trim() };
        }
      }
      return {
        idx, ...c, can_add: Boolean(email), existing_person: existing,
        role: CONTACT_ROLE[c.contact_type] ?? 'General Contact',
        // info@ / bookings@ … — offered as the band's own email, not a person.
        generic: isGenericMailbox(email),
      };
    }));

    res.json({ data: { proposed_name: lead.artist_name, similar, contacts } });
  } catch (error) {
    console.error('[leads] address-book preview error:', error);
    res.status(500).json({ error: 'Failed to load preview' });
  }
});

// POST /api/leads/:id/add-to-address-book — staff-gated create (never automatic):
// pick an existing org OR create the band org, then add the chosen researched
// contacts (exact-email find-or-create, linked with their role).
const addSchema = z.object({
  organisation_id: z.string().uuid().optional(),
  create_name: z.string().trim().min(1).max(300).optional(),
  // Each chosen researched contact: add as a PERSON (with the name staff
  // typed — the research often has none, or just "info") or as the band's own
  // EMAIL (shared inboxes: info@, bookings@…).
  contacts: z.array(z.object({
    idx: z.number().int().min(0),
    as: z.enum(['person', 'org_email']).default('person'),
    name: z.string().trim().max(200).nullable().optional(),
  })).optional(),
  /** Older client shape: indexes, added as people under the researched name. */
  contact_indexes: z.array(z.number().int().min(0)).optional(),
}).refine((b) => Boolean(b.organisation_id) !== Boolean(b.create_name), { message: 'Pick an existing organisation or give a name to create' });
router.post('/:id/add-to-address-book', authorize(...STAFF_ROLES), validate(addSchema), async (req: AuthRequest, res: Response) => {
  try {
    const body = req.body as z.infer<typeof addSchema>;
    const userId = req.user!.id;
    const lead = await loadLead(req.params.id as string);
    if (!lead) return res.status(404).json({ error: 'Lead not found' });

    let orgId: string;
    let created = false;
    if (body.organisation_id) {
      const org = await query(`SELECT id FROM organisations WHERE id = $1 AND is_deleted = false`, [body.organisation_id]);
      if (!org.rows[0]) return res.status(404).json({ error: 'Organisation not found' });
      orgId = body.organisation_id;
    } else {
      const name = body.create_name!;
      const clash = await findOrgByExactName(name);
      if (clash.id || clash.ambiguous) {
        return res.status(409).json({ error: `An organisation called "${name}" already exists — pick it from the list instead.` });
      }
      const tour = [ymd(lead.first_date), ymd(lead.last_date)].filter(Boolean).join(' to ');
      orgId = await createOrganisation({
        name, type: 'band', createdBy: userId,
        notes: `Created from the Lead Finder${tour ? ` (UK tour ${tour})` : ''}.`,
      });
      created = true;
      await logAudit(userId, 'organisations', orgId, 'create', null, { name, type: 'band', source: 'lead_finder', lead_id: lead.id });
    }

    // Contacts — only ones with an email (exact-email match is the dedup).
    const contacts = (lead.contacts ?? []) as LeadContact[];
    const added: { name: string; outcome: 'existing' | 'created' }[] = [];
    const orgEmails: { email: string; outcome: 'set' | 'noted' | 'already' }[] = [];
    const skipped: string[] = [];
    const chosen = body.contacts
      ?? (body.contact_indexes ?? []).map((idx) => ({ idx, as: 'person' as const, name: null }));
    const seenIdx = new Set<number>();
    for (const choice of chosen) {
      if (seenIdx.has(choice.idx)) continue;
      seenIdx.add(choice.idx);
      const c = contacts[choice.idx];
      if (!c) continue;
      const email = c.contact_email?.trim();
      if (!email) { skipped.push(c.contact_name || c.contact_type); continue; }
      if (choice.as === 'org_email') {
        orgEmails.push({ email, outcome: await addOrganisationEmail(orgId, email, `Lead Finder, ${c.source || 'research'}`) });
        continue;
      }
      // Staff's typed name wins; then the researched name; then the email's
      // local part as a last resort. (An EXISTING person keeps their name.)
      const typed = choice.name?.trim() || c.contact_name?.trim() || '';
      const { first, last } = typed ? splitName(typed) : { first: email.split('@')[0], last: '' };
      const person = await findOrCreatePersonByEmail({
        email, firstName: first, lastName: last, phone: c.contact_phone?.trim() || null,
        notes: `Added from the Lead Finder — ${c.contact_type.replace('_', ' ')} for ${lead.artist_name}${c.source ? ` (found via ${c.source})` : ''}.`,
        createdBy: userId,
      });
      await linkPersonToOrganisation(person.id, orgId, CONTACT_ROLE[c.contact_type] ?? 'General Contact');
      added.push({ name: typed || email, outcome: person.outcome });
    }

    // Picking an existing org is a confirmed match (warm); a band created here
    // is in the address book but has no relationship yet (stays cold).
    const cand = ((lead.match_candidates ?? []) as MatchCandidate[]).find((c) => c.id === orgId);
    // Re-adding contacts to the band this lead already created keeps it 'created'
    // (cold) — re-linking must not quietly promote it to a warm "match".
    const keepCreated = lead.matched_organisation_id === orgId && lead.match_via === 'created';
    const via = created || keepCreated ? 'created' : cand?.via === 'job_name' ? 'job_name' : 'org_name';
    await linkLeadToOrg(lead.id, orgId, via, { enrichOrg: true });
    {
      const orgName = (await query(`SELECT name FROM organisations WHERE id = $1`, [orgId])).rows[0]?.name ?? 'organisation';
      const bits = [`${created ? 'Created' : 'Linked'} ${orgName}`];
      if (added.length) bits.push(`${added.length} contact(s)`);
      if (orgEmails.length) bits.push(`band email ${orgEmails.map((e) => e.email).join(', ')}`);
      await logLeadEvent(lead.id, 'address_book', { detail: bits.join(' · '), userId });
    }
    await linkKnownContacts();
    await syncTourJobs(lead.id);

    res.json({ data: {
      lead: await loadLead(lead.id), organisation_id: orgId, created,
      contacts_added: added, org_emails: orgEmails, contacts_skipped: skipped,
    } });
  } catch (error) {
    console.error('[leads] add-to-address-book error:', error);
    res.status(500).json({ error: 'Failed to add to address book' });
  }
});

// GET /api/leads/:id/enquiry-preview — the matched org and its active people,
// so staff choose who goes on the enquiry.
router.get('/:id/enquiry-preview', authorize(...STAFF_ROLES), async (req: AuthRequest, res: Response) => {
  try {
    const lead = await loadLead(req.params.id as string);
    if (!lead) return res.status(404).json({ error: 'Lead not found' });
    if (!lead.matched_organisation_id) return res.status(400).json({ error: 'Add this band to the address book first' });
    const org = await query(`SELECT id, name, type FROM organisations WHERE id = $1`, [lead.matched_organisation_id]);
    const people = await query(
      `SELECT p.id, CONCAT(COALESCE(NULLIF(p.preferred_name, ''), p.first_name), ' ', p.last_name) AS name,
              p.email, por.role
         FROM person_organisation_roles por
         JOIN people p ON p.id = por.person_id AND p.is_deleted = false
        WHERE por.organisation_id = $1 AND por.status = 'active'
        ORDER BY por.is_primary DESC NULLS LAST, p.first_name`,
      [lead.matched_organisation_id],
    );
    res.json({ data: { organisation: org.rows[0] ?? null, people: people.rows } });
  } catch (error) {
    console.error('[leads] enquiry preview error:', error);
    res.status(500).json({ error: 'Failed to load preview' });
  }
});

/**
 * Create an OP-native pipeline enquiry from a lead, via the shared
 * createPipelineEnquiry (same path as the staff form and the website intake).
 * OP only — never pushes to HireHop. Used by Start enquiry and Log outreach.
 * Throws a { status, message } object for the route to return.
 */
async function createEnquiryFromLead(
  lead: Record<string, any>, // eslint-disable-line @typescript-eslint/no-explicit-any
  userId: string,
  opts: {
    contactIds: string[];
    primaryId: string | null | undefined;
    details: string | null | undefined;
    /** Log outreach: the note goes on the enquiry and the first chase is this many days out. */
    outreach?: { note: string | null; chaseInDays: number };
  },
): Promise<string> {
  if (!lead.matched_organisation_id) throw { status: 400, message: 'Add this band to the address book first' };
  // A job for this tour already exists (quoted / booked) — a second enquiry would
  // duplicate it in the pipeline and in the band's history.
  const live = await query(
    `SELECT j.id, j.hh_job_number FROM lead_tour_jobs ltj JOIN jobs j ON j.id = ltj.job_id
      WHERE ltj.lead_id = $1 AND ltj.status = 'linked' AND j.is_deleted = false AND j.dismissed_at IS NULL
        AND (${TOUR_JOB_OUTCOME_SQL}) IN ('open', 'booked')
      LIMIT 1`,
    [lead.id],
  );
  if (live.rows[0]) {
    throw {
      status: 409,
      message: `There's already a job for this tour${live.rows[0].hh_job_number ? ` (#${live.rows[0].hh_job_number})` : ''} — use that rather than a new enquiry`,
      job_id: live.rows[0].id,
    };
  }
  if (lead.converted_job_id) {
    const existing = await query(`SELECT id FROM jobs WHERE id = $1 AND is_deleted = false`, [lead.converted_job_id]);
    if (existing.rows[0]) throw { status: 409, message: 'An enquiry already exists for this lead', job_id: lead.converted_job_id };
  }
  const org = await query(`SELECT id, name FROM organisations WHERE id = $1 AND is_deleted = false`, [lead.matched_organisation_id]);
  if (!org.rows[0]) throw { status: 404, message: 'The matched organisation no longer exists' };
  const orgName = org.rows[0].name as string;

  const first = ymd(lead.first_date);
  const last = ymd(lead.last_date);
  const venues = ((lead.venues ?? []) as string[]).join(', ');
  const dates = ((lead.all_dates ?? []) as string[]).join(', ');
  const tourLine = `${lead.artist_name} touring the UK — ${lead.uk_date_count} date(s)${first ? `, ${first} to ${last ?? '?'}` : ''}.`;
  const details = opts.details?.trim() || (opts.outreach
    ? `Cold outreach — we contacted ${lead.artist_name} about their UK tour. ${tourLine}${opts.outreach.note ? ` ${opts.outreach.note}` : ''}`
    : `${tourLine} Found by the Lead Finder.`);
  const notesLines = ['— Lead Finder —'];
  if (opts.outreach) notesLines.push(`Outreach: we contacted them first${opts.outreach.note ? ` — ${opts.outreach.note}` : ''}. Not a client enquiry yet.`);
  if (lead.relevance_score != null) {
    notesLines.push(`Score ${lead.relevance_score}/10${lead.client_tier ? ` · Tier ${lead.client_tier}` : ''}${lead.origin_country ? ` · ${lead.origin_country}` : ''}`);
  }
  if (dates) notesLines.push(`Tour dates: ${dates}`);
  if (venues) notesLines.push(`Venues: ${venues}`);
  if (lead.ai_summary) notesLines.push(String(lead.ai_summary));
  if (lead.reasoning && lead.reasoning !== lead.ai_summary) notesLines.push(`Assessment: ${lead.reasoning}`);

  const isWarm = lead.stream === 'warm';
  const bandDiffers = normaliseArtist(orgName) !== normaliseArtist(lead.artist_name);
  const contactIds = Array.from(new Set(opts.contactIds));
  const primary = opts.primaryId && contactIds.includes(opts.primaryId) ? opts.primaryId : (contactIds[0] ?? null);

  let nextChase: string | null = null;
  if (opts.outreach) nextChase = ukDatePlus(opts.outreach.chaseInDays);

  const job = await createPipelineEnquiry({
    client_name: orgName,
    client_id: lead.matched_organisation_id,
    // Booked under a management / agency org → keep the band in the job name.
    band_name: bandDiffers ? lead.artist_name : null,
    details,
    notes: notesLines.join('\n'),
    // Existing pipeline values (validated by the job edit form): 'repeat' =
    // returning client, 'cold_lead' = cold. leads.converted_job_id is what
    // marks it as Lead-Finder-sourced.
    enquiry_source: isWarm ? 'repeat' : 'cold_lead',
    likelihood: isWarm ? 'warm' : 'cold',
    job_date: first,
    job_end: last,
    contact_person_ids: contactIds.length ? contactIds : null,
    primary_contact_person_id: primary,
    next_chase_date: nextChase,
    chase_interval_days: opts.outreach ? opts.outreach.chaseInDays : null,
  }, userId);
  return job.id as string;
}

function sendLeadError(res: Response, error: unknown, fallback: string, label: string): void {
  if (error instanceof EnquiryValidationError) { res.status(400).json({ error: error.message }); return; }
  if (error && typeof error === 'object' && 'status' in error && 'message' in error) {
    const e = error as { status: number; message: string; job_id?: string };
    res.status(e.status).json({ error: e.message, ...(e.job_id ? { job_id: e.job_id } : {}) });
    return;
  }
  console.error(`[leads] ${label} error:`, error);
  res.status(500).json({ error: fallback });
}

// POST /api/leads/:id/start-enquiry — they're interested: a real enquiry.
const enquirySchema = z.object({
  contact_person_ids: z.array(z.string().uuid()).default([]),
  primary_contact_person_id: z.string().uuid().nullable().optional(),
  details: z.string().max(5000).nullable().optional(),
});
router.post('/:id/start-enquiry', authorize(...STAFF_ROLES), validate(enquirySchema), async (req: AuthRequest, res: Response) => {
  try {
    const body = req.body as z.infer<typeof enquirySchema>;
    const lead = await loadLead(req.params.id as string);
    if (!lead) return res.status(404).json({ error: 'Lead not found' });
    const jobId = await createEnquiryFromLead(lead, req.user!.id, {
      contactIds: body.contact_person_ids, primaryId: body.primary_contact_person_id, details: body.details,
    });
    await query(
      `UPDATE leads SET converted_job_id = $2, status = 'converted', updated_at = NOW() WHERE id = $1`,
      [lead.id, jobId],
    );
    await logLeadEvent(lead.id, 'enquiry', { detail: 'Enquiry started', userId: req.user!.id });
    res.status(201).json({ data: { job_id: jobId, lead: await loadLead(lead.id) } });
  } catch (error) {
    sendLeadError(res, error, 'Failed to create enquiry', 'start-enquiry');
  }
});

// POST /api/leads/:id/log-outreach — "we've contacted them". Records the note
// on the lead (status 'contacted' — off the dashboard card) and, by default,
// opens a Cold enquiry in the pipeline whose first chase is `chase_in_days`
// out, so the chase model reminds us to follow up. An unanswered outreach that
// the 09:00 auto-loser later closes as "No Decision" is NOT counted as a loss in
// the band's history (services/leads/history.ts).
const outreachSchema = z.object({
  note: z.string().max(2000).nullable().optional(),
  create_enquiry: z.boolean().default(true),
  chase_in_days: z.number().int().min(1).max(90).default(7),
  contact_person_ids: z.array(z.string().uuid()).default([]),
  primary_contact_person_id: z.string().uuid().nullable().optional(),
});
router.post('/:id/log-outreach', authorize(...STAFF_ROLES), validate(outreachSchema), async (req: AuthRequest, res: Response) => {
  try {
    const body = req.body as z.infer<typeof outreachSchema>;
    const userId = req.user!.id;
    const lead = await loadLead(req.params.id as string);
    if (!lead) return res.status(404).json({ error: 'Lead not found' });
    const note = body.note?.trim() || null;

    let jobId: string | null = null;
    if (body.create_enquiry) {
      jobId = await createEnquiryFromLead(lead, userId, {
        contactIds: body.contact_person_ids, primaryId: body.primary_contact_person_id, details: null,
        outreach: { note, chaseInDays: body.chase_in_days },
      });
      // On the job's timeline too, so whoever picks up the chase sees what was sent.
      await query(
        `INSERT INTO interactions (type, content, job_id, created_by, pipeline_status_at_creation, source)
         VALUES ('note', $1, $2, $3, 'new_enquiry', 'system')`,
        [`Cold outreach logged from the Lead Finder${note ? `: ${note}` : '.'} First chase in ${body.chase_in_days} day(s).`, jobId, userId],
      );
    }

    await query(
      `UPDATE leads SET status = 'contacted', status_note = $2, contacted_at = NOW(),
         converted_job_id = COALESCE($3, converted_job_id), updated_at = NOW()
       WHERE id = $1`,
      [lead.id, note, jobId],
    );
    await logLeadEvent(lead.id, 'outreach', {
      detail: [note, jobId ? `Cold enquiry, first chase in ${body.chase_in_days} days` : null].filter(Boolean).join(' · ') || null,
      userId,
    });
    res.status(201).json({ data: { job_id: jobId, lead: await loadLead(lead.id) } });
  } catch (error) {
    sendLeadError(res, error, 'Failed to log outreach', 'log-outreach');
  }
});

// POST /api/leads/:id/research — "Research again". A web search can take a
// minute, longer than the proxy will hold a request open, so it runs in the
// background: the lead is marked 'running' and the page polls until it clears.
// A 'running' mark older than 5 minutes is a casualty of a restart — allowed again.
router.post('/:id/research', authorize(...STAFF_ROLES), async (req: AuthRequest, res: Response) => {
  try {
    if (!isAnthropicConfigured()) return res.status(503).json({ error: 'Anthropic not configured' });
    const r = await query(
      `UPDATE leads SET research_status = 'running', updated_at = NOW()
        WHERE id = $1 AND NOT (COALESCE(research_status, '') = 'running' AND updated_at > NOW() - INTERVAL '5 minutes')
        RETURNING id`,
      [req.params.id],
    );
    if (!r.rows[0]) {
      const exists = await query(`SELECT 1 FROM leads WHERE id = $1`, [req.params.id]);
      return exists.rows[0]
        ? res.status(409).json({ error: 'Already researching this lead' })
        : res.status(404).json({ error: 'Lead not found' });
    }
    const userId = req.user?.id ?? null;
    await logLeadEvent(r.rows[0].id, 'research_requested', { userId });
    setImmediate(() => { void researchLead(r.rows[0].id, userId); });
    res.status(202).json({ data: await loadLead(r.rows[0].id) });
  } catch (error) {
    console.error('[leads] research error:', error);
    res.status(500).json({ error: 'Failed to start research' });
  }
});

// POST /api/leads/:id/contacts — a contact found by hand. Marked manual so a
// later re-research never drops it; Add to address book treats it like any other.
const contactSchema = z.object({
  contact_type: z.enum(['manager', 'band', 'tour_manager', 'booking_agent', 'general']),
  contact_name: z.string().trim().max(200).nullable().optional(),
  contact_email: z.string().trim().email().max(300).nullable().optional().or(z.literal('')),
  contact_phone: z.string().trim().max(50).nullable().optional(),
  note: z.string().trim().max(300).nullable().optional(),
}).refine((b) => Boolean(b.contact_name || b.contact_email || b.contact_phone), { message: 'Give at least a name, email or phone' });
router.post('/:id/contacts', authorize(...STAFF_ROLES), validate(contactSchema), async (req: AuthRequest, res: Response) => {
  try {
    const b = req.body as z.infer<typeof contactSchema>;
    const lead = await loadLead(req.params.id as string);
    if (!lead) return res.status(404).json({ error: 'Lead not found' });
    const who = req.user?.id
      ? (await query(
          `SELECT COALESCE(NULLIF(p.preferred_name, ''), p.first_name) AS n FROM users u JOIN people p ON p.id = u.person_id WHERE u.id = $1`,
          [req.user.id],
        )).rows[0]?.n
      : null;
    const contact: LeadContact = {
      contact_type: b.contact_type,
      contact_name: b.contact_name || null,
      contact_email: b.contact_email || null,
      contact_phone: b.contact_phone || null,
      source: [`added by ${who ?? 'staff'}`, b.note || null].filter(Boolean).join(' — '),
      confidence: 'high',
      manual: true,
    };
    const contacts = [...((lead.contacts ?? []) as LeadContact[]), contact];
    await query(`UPDATE leads SET contacts = $2, updated_at = NOW() WHERE id = $1`, [lead.id, JSON.stringify(contacts)]);
    await logLeadEvent(lead.id, 'contact_added', {
      detail: [contact.contact_name, contact.contact_email, contact.contact_type.replace('_', ' ')].filter(Boolean).join(' · '),
      userId: req.user?.id,
    });
    await linkKnownContacts();
    res.status(201).json({ data: await loadLead(lead.id) });
  } catch (error) {
    console.error('[leads] add contact error:', error);
    res.status(500).json({ error: 'Failed to add contact' });
  }
});

// DELETE /api/leads/:id/contacts/:idx — drop a contact (wrong person, dead email…).
router.delete('/:id/contacts/:idx', authorize(...STAFF_ROLES), async (req: AuthRequest, res: Response) => {
  try {
    const idx = Number(req.params.idx);
    const lead = await loadLead(req.params.id as string);
    if (!lead) return res.status(404).json({ error: 'Lead not found' });
    const contacts = (lead.contacts ?? []) as LeadContact[];
    if (!Number.isInteger(idx) || idx < 0 || idx >= contacts.length) return res.status(404).json({ error: 'Contact not found' });
    const [removed] = contacts.splice(idx, 1);
    await query(`UPDATE leads SET contacts = $2, updated_at = NOW() WHERE id = $1`, [lead.id, JSON.stringify(contacts)]);
    await logLeadEvent(lead.id, 'contact_removed', {
      detail: [removed.contact_name, removed.contact_email].filter(Boolean).join(' · ') || removed.contact_type,
      userId: req.user?.id,
    });
    await linkKnownContacts();
    res.json({ data: await loadLead(lead.id) });
  } catch (error) {
    console.error('[leads] remove contact error:', error);
    res.status(500).json({ error: 'Failed to remove contact' });
  }
});

// GET /api/leads/:id/tour-jobs/candidates — the band's recent jobs (any dates),
// so staff can link one the date window missed.
router.get('/:id/tour-jobs/candidates', authorize(...STAFF_ROLES), async (req: AuthRequest, res: Response) => {
  try {
    const lead = await loadLead(req.params.id as string);
    if (!lead) return res.status(404).json({ error: 'Lead not found' });
    if (!lead.matched_organisation_id) return res.json({ data: [] });
    const r = await query(
      `SELECT j.id AS job_id, j.hh_job_number, j.job_name, ${TOUR_JOB_OUTCOME_SQL} AS outcome,
              COALESCE(j.out_date, j.job_date) AS start, COALESCE(j.return_date, j.job_end) AS "end"
         FROM jobs j
        WHERE j.is_deleted = false
          AND (j.client_id = $1 OR j.id IN (SELECT jo.job_id FROM job_organisations jo WHERE jo.organisation_id = $1))
          AND j.id NOT IN (SELECT ltj.job_id FROM lead_tour_jobs ltj WHERE ltj.lead_id = $2 AND ltj.status <> 'rejected')
        ORDER BY COALESCE(j.out_date, j.job_date) DESC NULLS LAST
        LIMIT 15`,
      [lead.matched_organisation_id, lead.id],
    );
    res.json({ data: r.rows });
  } catch (error) {
    console.error('[leads] tour-job candidates error:', error);
    res.status(500).json({ error: 'Failed to load jobs' });
  }
});

// POST /api/leads/:id/tour-jobs — link a job to this tour by hand.
const linkJobSchema = z.object({
  job_id: z.string().uuid().optional(),
  hh_job_number: z.coerce.number().int().positive().optional(),
}).refine((b) => Boolean(b.job_id) !== Boolean(b.hh_job_number), { message: 'Give a job or a HireHop job number' });
router.post('/:id/tour-jobs', authorize(...STAFF_ROLES), validate(linkJobSchema), async (req: AuthRequest, res: Response) => {
  try {
    const b = req.body as z.infer<typeof linkJobSchema>;
    const lead = await loadLead(req.params.id as string);
    if (!lead) return res.status(404).json({ error: 'Lead not found' });
    const j = b.job_id
      ? await query(`SELECT id, hh_job_number, job_name FROM jobs WHERE id = $1 AND is_deleted = false`, [b.job_id])
      : await query(`SELECT id, hh_job_number, job_name FROM jobs WHERE hh_job_number = $1 AND is_deleted = false LIMIT 1`, [b.hh_job_number]);
    if (!j.rows[0]) return res.status(404).json({ error: b.hh_job_number ? `No job #${b.hh_job_number} found` : 'Job not found' });
    await query(
      `INSERT INTO lead_tour_jobs (lead_id, job_id, status, link_type, created_by) VALUES ($1, $2, 'linked', 'manual', $3)
       ON CONFLICT (lead_id, job_id) DO UPDATE SET status = 'linked', link_type = 'manual', created_by = $3, updated_at = NOW()`,
      [lead.id, j.rows[0].id, req.user?.id ?? null],
    );
    await logLeadEvent(lead.id, 'tour_job_linked', {
      detail: `${j.rows[0].hh_job_number ? `#${j.rows[0].hh_job_number} ` : ''}${j.rows[0].job_name ?? ''}`.trim(), userId: req.user?.id,
    });
    await noteLinkedJobs(lead.id, req.user?.id ?? null);
    res.status(201).json({ data: await loadLead(lead.id) });
  } catch (error) {
    console.error('[leads] link tour job error:', error);
    res.status(500).json({ error: 'Failed to link job' });
  }
});

// POST /api/leads/:id/tour-jobs/:jobId/confirm — a suggested (named-after-the-band) job is this tour's.
router.post('/:id/tour-jobs/:jobId/confirm', authorize(...STAFF_ROLES), async (req: AuthRequest, res: Response) => {
  try {
    const r = await query(
      `UPDATE lead_tour_jobs SET status = 'linked', created_by = $3, updated_at = NOW()
        WHERE lead_id = $1 AND job_id = $2 RETURNING job_id`,
      [req.params.id, req.params.jobId, req.user?.id ?? null],
    );
    if (!r.rows[0]) return res.status(404).json({ error: 'Not linked to this lead' });
    const j = await query(`SELECT hh_job_number, job_name FROM jobs WHERE id = $1`, [req.params.jobId]);
    await logLeadEvent(req.params.id as string, 'tour_job_linked', {
      detail: `${j.rows[0]?.hh_job_number ? `#${j.rows[0].hh_job_number} ` : ''}${j.rows[0]?.job_name ?? ''} (confirmed)`.trim(), userId: req.user?.id,
    });
    await noteLinkedJobs(req.params.id as string, req.user?.id ?? null);
    res.json({ data: await loadLead(req.params.id as string) });
  } catch (error) {
    console.error('[leads] confirm tour job error:', error);
    res.status(500).json({ error: 'Failed to confirm job' });
  }
});

// DELETE /api/leads/:id/tour-jobs/:jobId — not this tour's job. Kept as
// 'rejected' so the automatic link never puts it back.
router.delete('/:id/tour-jobs/:jobId', authorize(...STAFF_ROLES), async (req: AuthRequest, res: Response) => {
  try {
    const r = await query(
      `UPDATE lead_tour_jobs SET status = 'rejected', created_by = $3, updated_at = NOW()
        WHERE lead_id = $1 AND job_id = $2 RETURNING job_id`,
      [req.params.id, req.params.jobId, req.user?.id ?? null],
    );
    if (!r.rows[0]) return res.status(404).json({ error: 'Not linked to this lead' });
    await noteUnlinkedJob(req.params.id as string, req.params.jobId as string, 'unlinked on the Leads page', req.user?.id ?? null);
    const j = await query(`SELECT hh_job_number, job_name FROM jobs WHERE id = $1`, [req.params.jobId]);
    await logLeadEvent(req.params.id as string, 'tour_job_unlinked', {
      detail: `${j.rows[0]?.hh_job_number ? `#${j.rows[0].hh_job_number} ` : ''}${j.rows[0]?.job_name ?? ''}`.trim(), userId: req.user?.id,
    });
    res.json({ data: await loadLead(req.params.id as string) });
  } catch (error) {
    console.error('[leads] unlink tour job error:', error);
    res.status(500).json({ error: 'Failed to unlink job' });
  }
});

export default router;
