/**
 * Leads — the Lead Finder (Tour Finder → OP). Spec: docs/TOUR-FINDER-SPEC.md.
 *
 * Endpoints:
 *   GET   /                          — list leads (?view=hidden for dismissed / not relevant)  STAFF
 *   GET   /runs/latest               — most recent pipeline run (status + counts)              STAFF
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
  createOrganisation, linkPersonToOrganisation,
} from '../services/address-book-resolve';
import { createPipelineEnquiry, EnquiryValidationError } from '../services/pipeline-enquiry';

const router = Router();
router.use(authenticate);

const LEAD_COLUMNS = `
  id, artist_name, tm_artist_id, uk_date_count, first_date, last_date, venues, all_dates,
  relevance_score, client_tier, origin_country, is_international, reasoning, ai_summary, scored_at,
  matched_organisation_id, match_confidence, match_candidates, match_via, rejected_org_ids, stream, contacts,
  client_history, history_scored_at, known_contacts,
  status, status_reason, status_note, assigned_to, converted_job_id, created_at, updated_at`;

// Same columns, prefixed for the list query's joins.
const LEAD_COLUMNS_PREFIXED = LEAD_COLUMNS.split(',').map((c) => `l.${c.trim()}`).join(', ');

const HIDDEN_STATUSES = `('dismissed', 'not_relevant')`;

/** Researched contact type → person ↔ org role (PERSON_ORG_ROLES). */
const CONTACT_ROLE: Record<string, string> = {
  manager: 'Manager',
  booking_agent: 'Booking Agent',
  tour_manager: 'Tour Manager',
  general: 'General Contact',
};

interface LeadContact {
  contact_type: string;
  contact_name: string | null;
  contact_email: string | null;
  contact_phone: string | null;
  source: string | null;
  confidence: string;
}

function ymd(v: unknown): string | null {
  if (!v) return null;
  const d = new Date(v as string);
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}

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
      `SELECT ${LEAD_COLUMNS_PREFIXED}, o.name AS matched_org_name,
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
       ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
       ORDER BY ${hiddenView ? 'l.updated_at DESC' : 'l.relevance_score DESC NULLS LAST, l.first_date ASC NULLS LAST'}
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
      const today = new Date().toISOString().slice(0, 10);
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

    const target = normaliseArtist(lead.artist_name);
    const similar = (await findOrgNameCandidates(lead.artist_name))
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
      return { idx, ...c, can_add: Boolean(email), existing_person: existing, role: CONTACT_ROLE[c.contact_type] ?? 'General Contact' };
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
  contact_indexes: z.array(z.number().int().min(0)).default([]),
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
    const skipped: string[] = [];
    for (const idx of Array.from(new Set(body.contact_indexes))) {
      const c = contacts[idx];
      if (!c) continue;
      const email = c.contact_email?.trim();
      if (!email) { skipped.push(c.contact_name || c.contact_type); continue; }
      const { first, last } = c.contact_name?.trim() ? splitName(c.contact_name) : { first: email.split('@')[0], last: '' };
      const person = await findOrCreatePersonByEmail({
        email, firstName: first, lastName: last, phone: c.contact_phone?.trim() || null,
        notes: `Added from the Lead Finder — ${c.contact_type.replace('_', ' ')} for ${lead.artist_name}${c.source ? ` (found via ${c.source})` : ''}.`,
        createdBy: userId,
      });
      await linkPersonToOrganisation(person.id, orgId, CONTACT_ROLE[c.contact_type] ?? 'General Contact');
      added.push({ name: c.contact_name || email, outcome: person.outcome });
    }

    // Picking an existing org is a confirmed match (warm); a band created here
    // is in the address book but has no relationship yet (stays cold).
    const cand = ((lead.match_candidates ?? []) as MatchCandidate[]).find((c) => c.id === orgId);
    const via = created ? 'created' : cand?.via === 'job_name' ? 'job_name' : 'org_name';
    await linkLeadToOrg(lead.id, orgId, via, { enrichOrg: true });
    await linkKnownContacts();

    res.json({ data: { lead: await loadLead(lead.id), organisation_id: orgId, created, contacts_added: added, contacts_skipped: skipped } });
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

// POST /api/leads/:id/start-enquiry — create an OP-native pipeline enquiry via
// the shared createPipelineEnquiry (same path as the staff form and the website
// intake). OP only — never pushes to HireHop.
const enquirySchema = z.object({
  contact_person_ids: z.array(z.string().uuid()).default([]),
  primary_contact_person_id: z.string().uuid().nullable().optional(),
  details: z.string().max(5000).nullable().optional(),
});
router.post('/:id/start-enquiry', authorize(...STAFF_ROLES), validate(enquirySchema), async (req: AuthRequest, res: Response) => {
  try {
    const body = req.body as z.infer<typeof enquirySchema>;
    const userId = req.user!.id;
    const lead = await loadLead(req.params.id as string);
    if (!lead) return res.status(404).json({ error: 'Lead not found' });
    if (!lead.matched_organisation_id) return res.status(400).json({ error: 'Add this band to the address book first' });
    if (lead.converted_job_id) {
      const existing = await query(`SELECT id FROM jobs WHERE id = $1 AND is_deleted = false`, [lead.converted_job_id]);
      if (existing.rows[0]) return res.status(409).json({ error: 'An enquiry already exists for this lead', job_id: lead.converted_job_id });
    }
    const org = await query(`SELECT id, name FROM organisations WHERE id = $1 AND is_deleted = false`, [lead.matched_organisation_id]);
    if (!org.rows[0]) return res.status(404).json({ error: 'The matched organisation no longer exists' });
    const orgName = org.rows[0].name as string;

    const first = ymd(lead.first_date);
    const last = ymd(lead.last_date);
    const venues = ((lead.venues ?? []) as string[]).join(', ');
    const dates = ((lead.all_dates ?? []) as string[]).join(', ');
    const details = body.details?.trim() ||
      `${lead.artist_name} touring the UK — ${lead.uk_date_count} date(s)${first ? `, ${first} to ${last ?? '?'}` : ''}. Found by the Lead Finder.`;
    const notesLines = ['— Lead Finder —'];
    if (lead.relevance_score != null) {
      notesLines.push(`Score ${lead.relevance_score}/10${lead.client_tier ? ` · Tier ${lead.client_tier}` : ''}${lead.origin_country ? ` · ${lead.origin_country}` : ''}`);
    }
    if (dates) notesLines.push(`Tour dates: ${dates}`);
    if (venues) notesLines.push(`Venues: ${venues}`);
    if (lead.ai_summary) notesLines.push(String(lead.ai_summary));
    if (lead.reasoning && lead.reasoning !== lead.ai_summary) notesLines.push(`Assessment: ${lead.reasoning}`);

    const isWarm = lead.stream === 'warm';
    const bandDiffers = normaliseArtist(orgName) !== normaliseArtist(lead.artist_name);
    const contactIds = Array.from(new Set(body.contact_person_ids));
    const primary = body.primary_contact_person_id && contactIds.includes(body.primary_contact_person_id)
      ? body.primary_contact_person_id : (contactIds[0] ?? null);

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
    }, userId);

    await query(
      `UPDATE leads SET converted_job_id = $2, status = 'converted', updated_at = NOW() WHERE id = $1`,
      [lead.id, job.id],
    );
    res.status(201).json({ data: { job_id: job.id, lead: await loadLead(lead.id) } });
  } catch (error) {
    if (error instanceof EnquiryValidationError) return res.status(400).json({ error: error.message });
    console.error('[leads] start-enquiry error:', error);
    res.status(500).json({ error: 'Failed to create enquiry' });
  }
});

export default router;
