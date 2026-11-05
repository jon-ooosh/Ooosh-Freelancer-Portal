/**
 * Band watches — "tell me when this band is next over". Spec:
 * docs/TOUR-FINDER-SPEC.md §21. The logic is services/leads/band-watch.ts.
 *
 * Endpoints (mounted at /api/band-watches):
 *   GET  /                     — the watch list (?status=active|stopped) + counts            STAFF
 *   GET  /job-target/:jobId    — what a close-out's "Watch this band" tick would watch        STAFF
 *   GET  /org/:orgId           — this organisation's watch, if any                            STAFF
 *   GET  /tm-search?q=         — Ticketmaster acts, to match a watch by hand                  STAFF
 *   GET  /lead/:leadId/people  — who we dealt with at a lead's band, and when we last did     STAFF
 *   POST /                     — watch a band { organisation_id, job_id? }                     STAFF
 *   POST /check-now            — check every watch now, in the background                     MANAGER
 *   POST /:id/stop             — stop watching                                                 STAFF
 *   POST /:id/match            — { tm_attraction_id, tm_attraction_name } | { not_on_ticketmaster }
 *                                | { look_again }                                              STAFF
 *   GET  /back-catalogue       — bands from past jobs, with what Ticketmaster said (§21.8)    STAFF
 *   POST /back-catalogue/look-up — look them up on Ticketmaster, in the background          MANAGER
 *   POST /back-catalogue/watch — watch the chosen ones { organisation_ids }                    STAFF
 *
 * Watches started from a close-out arrive through the status change itself
 * (routes/pipeline.ts, routes/cancellations.ts → startWatchFromCloseOut()).
 */
import { Router, Response } from 'express';
import { z } from 'zod';
import { query } from '../config/database';
import { authenticate, authorize, AuthRequest, STAFF_ROLES, MANAGER_ROLES } from '../middleware/auth';
import { validate } from '../middleware/validate';
import { logAudit } from '../middleware/audit';
import { DISPLAY_NAME_SQL } from '../services/display-name';
import { isTicketmasterConfigured } from '../services/leads/ticketmaster';
import { isRunActive } from '../services/leads/pipeline';
import {
  startWatch, stopWatch, setWatchMatch, resetWatchMatch, matchWatch, watchTargetForJob,
  getWatchForOrg, searchTicketmasterActs, runBandWatchCheck, isBandWatchCheckRunning,
} from '../services/leads/band-watch';
import {
  listBackCatalogue, startBackCatalogueLookup, watchFromBackCatalogue, getLookupProgress, WATCH_BATCH_LIMIT,
} from '../services/leads/back-catalogue';

const router = Router();
router.use(authenticate);
router.use(authorize(...STAFF_ROLES));

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A route param as a plain string ('' if it isn't one). */
function param(req: AuthRequest, key: string): string {
  const v = req.params[key];
  return typeof v === 'string' ? v : '';
}

/** First name + surname of a user, for "ticked by". `uid` is the users.id column. */
const userNameSql = (uid: string) => `(SELECT NULLIF(${DISPLAY_NAME_SQL}, ' ')
     FROM users u JOIN people p ON p.id = u.person_id WHERE u.id = ${uid})`;

// GET /api/band-watches — the Watched bands list. Needs-a-match first, then by name.
router.get('/', async (req: AuthRequest, res: Response) => {
  try {
    const status = req.query.status === 'stopped' ? 'stopped' : 'active';
    const where = status === 'stopped'
      ? `bw.stopped_at IS NOT NULL`
      : `bw.stopped_at IS NULL AND o.is_deleted = false`;
    const r = await query(
      `SELECT bw.id, bw.organisation_id, o.name AS org_name, o.type AS org_type,
              bw.tm_attraction_id, bw.tm_attraction_name, bw.tm_match, bw.tm_candidates,
              bw.started_at, bw.stopped_at, bw.last_ticked_at, bw.last_tm_check_at, bw.last_tm_result,
              sj.id AS started_job_id, sj.hh_job_number AS started_job_number,
              sj.job_name AS started_job_name, sj.pipeline_status AS started_job_status,
              lj.id AS last_job_id, lj.hh_job_number AS last_job_number, lj.pipeline_status AS last_job_status,
              ${userNameSql('bw.started_by')} AS started_by_name,
              ${userNameSql('bw.last_ticked_by')} AS last_ticked_by_name,
              ${userNameSql('bw.stopped_by')} AS stopped_by_name,
              nl.id AS next_lead_id, nl.first_date::text AS next_lead_first_date,
              nl.last_date::text AS next_lead_last_date, nl.status AS next_lead_status
         FROM band_watches bw
         JOIN organisations o ON o.id = bw.organisation_id
         LEFT JOIN jobs sj ON sj.id = bw.started_from_job_id
         LEFT JOIN jobs lj ON lj.id = bw.last_ticked_job_id
         LEFT JOIN LATERAL (
           SELECT l.id, l.first_date, l.last_date, l.status FROM leads l
            WHERE l.watch_id = bw.id AND l.status NOT IN ('dismissed', 'not_relevant')
              AND COALESCE(l.last_date, l.first_date) >= CURRENT_DATE
            ORDER BY l.first_date ASC LIMIT 1
         ) nl ON true
        WHERE ${where}
        ORDER BY (bw.tm_match = 'needs_match') DESC, lower(o.name)
        LIMIT 2000`,
    );
    const counts = await query(
      `SELECT COUNT(*) FILTER (WHERE bw.stopped_at IS NULL AND o.is_deleted = false)::int AS active,
              COUNT(*) FILTER (WHERE bw.stopped_at IS NULL AND o.is_deleted = false
                                 AND bw.tm_match = 'needs_match')::int AS needs_match,
              COUNT(*) FILTER (WHERE bw.stopped_at IS NULL AND o.is_deleted = false
                                 AND bw.tm_match IN ('unknown', 'not_found'))::int AS not_on_ticketmaster,
              COUNT(*) FILTER (WHERE bw.stopped_at IS NOT NULL)::int AS stopped
         FROM band_watches bw JOIN organisations o ON o.id = bw.organisation_id`,
    );
    res.json({
      data: r.rows,
      counts: counts.rows[0],
      checking: isBandWatchCheckRunning(),
      ticketmaster: isTicketmasterConfigured(),
    });
  } catch (error) {
    console.error('[band-watches] list error:', error);
    res.status(500).json({ error: 'Failed to load watched bands' });
  }
});

// GET /api/band-watches/job-target/:jobId — the close-out tick's default band.
router.get('/job-target/:jobId', async (req: AuthRequest, res: Response) => {
  try {
    if (!UUID_RE.test(param(req, 'jobId'))) return res.status(400).json({ error: 'Invalid job' });
    res.json({ data: await watchTargetForJob(param(req, 'jobId')) });
  } catch (error) {
    console.error('[band-watches] job target error:', error);
    res.status(500).json({ error: 'Failed to load the band for this job' });
  }
});

// GET /api/band-watches/org/:orgId — the org page's button.
router.get('/org/:orgId', async (req: AuthRequest, res: Response) => {
  try {
    if (!UUID_RE.test(param(req, 'orgId'))) return res.status(400).json({ error: 'Invalid organisation' });
    res.json({ data: await getWatchForOrg(param(req, 'orgId')) });
  } catch (error) {
    console.error('[band-watches] org watch error:', error);
    res.status(500).json({ error: 'Failed to load the watch' });
  }
});

// GET /api/band-watches/tm-search?q= — Ticketmaster acts by name, for matching by hand.
router.get('/tm-search', async (req: AuthRequest, res: Response) => {
  try {
    const q = typeof req.query.q === 'string' ? req.query.q.trim() : '';
    if (q.length < 2) return res.json({ data: [] });
    if (!isTicketmasterConfigured()) {
      return res.status(503).json({ error: 'Ticketmaster isn’t set up on the server' });
    }
    const found = await searchTicketmasterActs(q.slice(0, 100));
    if (found === null) return res.status(502).json({ error: 'Ticketmaster didn’t answer — try again in a moment' });
    res.json({ data: found.slice(0, 10) });
  } catch (error) {
    console.error('[band-watches] tm search error:', error);
    res.status(500).json({ error: 'Ticketmaster search failed' });
  }
});

// GET /api/band-watches/lead/:leadId/people — the people we dealt with at a
// watched lead's band (its own people, and contacts on its jobs), most recent
// first, with when we were last in touch. After 12–18 months the tour manager
// has often changed (spec §21.2 item 8) — this shows whether to Research again.
router.get('/lead/:leadId/people', async (req: AuthRequest, res: Response) => {
  try {
    if (!UUID_RE.test(param(req, 'leadId'))) return res.status(400).json({ error: 'Invalid lead' });
    const lead = await query(`SELECT matched_organisation_id FROM leads WHERE id = $1`, [param(req, 'leadId')]);
    const orgId = lead.rows[0]?.matched_organisation_id as string | undefined;
    if (!orgId) return res.json({ data: [] });
    const r = await query(
      `WITH org_jobs AS (
         SELECT j.id, j.hh_job_number, COALESCE(j.out_date, j.job_date) AS start
           FROM jobs j
          WHERE j.is_deleted = false
            AND (j.client_id = $1 OR j.id IN (SELECT jo.job_id FROM job_organisations jo WHERE jo.organisation_id = $1))
       ), who AS (
         SELECT por.person_id FROM person_organisation_roles por
          WHERE por.organisation_id = $1 AND por.status = 'active'
         UNION
         SELECT jc.person_id FROM job_contacts jc JOIN org_jobs oj ON oj.id = jc.job_id
       ), ppl AS (
         SELECT p.id, NULLIF(${DISPLAY_NAME_SQL}, ' ') AS name, p.email,
                (SELECT por.role FROM person_organisation_roles por
                  WHERE por.person_id = p.id AND por.organisation_id = $1 AND por.status = 'active'
                  ORDER BY por.is_primary DESC LIMIT 1) AS role,
                (SELECT MAX(i.created_at) FROM interactions i
                  WHERE i.person_id = p.id AND i.type IN ('email', 'call', 'meeting')) AS last_contact_at,
                (SELECT json_build_object('job_id', oj.id, 'hh_job_number', oj.hh_job_number, 'start', oj.start)
                   FROM job_contacts jc JOIN org_jobs oj ON oj.id = jc.job_id
                  WHERE jc.person_id = p.id
                  ORDER BY oj.start DESC NULLS LAST LIMIT 1) AS last_job
           FROM people p
          WHERE p.id IN (SELECT person_id FROM who) AND COALESCE(p.is_deleted, false) = false
       )
       SELECT * FROM ppl
        ORDER BY GREATEST(last_contact_at, (last_job->>'start')::timestamptz) DESC NULLS LAST, name
        LIMIT 10`,
      [orgId],
    );
    res.json({ data: r.rows });
  } catch (error) {
    console.error('[band-watches] lead people error:', error);
    res.status(500).json({ error: 'Failed to load the band’s people' });
  }
});

// POST /api/band-watches — watch a band (org page, or picked on a close-out).
const startSchema = z.object({
  organisation_id: z.string().guid(),
  job_id: z.string().guid().nullable().optional(),
});
router.post('/', validate(startSchema), async (req: AuthRequest, res: Response) => {
  try {
    const { organisation_id, job_id } = req.body as z.infer<typeof startSchema>;
    const org = await query(`SELECT id, name FROM organisations WHERE id = $1 AND is_deleted = false`, [organisation_id]);
    if (!org.rows[0]) return res.status(404).json({ error: 'Organisation not found' });
    const r = await startWatch(organisation_id, { jobId: job_id ?? null, userId: req.user!.id });
    await logAudit(req.user!.id, 'band_watches', r.id, r.created ? 'create' : 'update', null,
      { organisation_id, job_id: job_id ?? null, restarted: r.restarted });
    res.status(r.created ? 201 : 200).json({ data: await getWatchForOrg(organisation_id) });
  } catch (error) {
    console.error('[band-watches] start error:', error);
    res.status(500).json({ error: 'Failed to watch this band' });
  }
});

// POST /api/band-watches/check-now — "Check now" on the Watched bands tab.
router.post('/check-now', authorize(...MANAGER_ROLES), async (_req: AuthRequest, res: Response) => {
  try {
    if (!isTicketmasterConfigured()) {
      return res.status(503).json({ error: 'Ticketmaster isn’t set up on the server' });
    }
    if (isBandWatchCheckRunning()) return res.status(409).json({ error: 'A check is already running' });
    if (getLookupProgress().running) return res.status(409).json({ error: 'The past-bands look-up is running — try again when it finishes' });
    if (await isRunActive()) return res.status(409).json({ error: 'A lead search is running — try again when it finishes' });
    setImmediate(() => {
      runBandWatchCheck({ manual: true }).catch((err) => console.error('[band-watches] check-now failed:', err));
    });
    res.status(202).json({ data: { started: true } });
  } catch (error) {
    console.error('[band-watches] check-now error:', error);
    res.status(500).json({ error: 'Failed to start the check' });
  }
});

// GET /api/band-watches/back-catalogue — bands from past jobs to watch in bulk.
router.get('/back-catalogue', async (_req: AuthRequest, res: Response) => {
  try {
    const { rows, counts } = await listBackCatalogue();
    res.json({ data: rows, counts, lookup: getLookupProgress(), ticketmaster: isTicketmasterConfigured() });
  } catch (error) {
    console.error('[band-watches] back catalogue error:', error);
    res.status(500).json({ error: 'Failed to load past bands' });
  }
});

// POST /api/band-watches/back-catalogue/look-up — look the list up on Ticketmaster.
router.post('/back-catalogue/look-up', authorize(...MANAGER_ROLES), async (_req: AuthRequest, res: Response) => {
  try {
    const why = await startBackCatalogueLookup();
    if (why) return res.status(409).json({ error: why });
    res.status(202).json({ data: { started: true } });
  } catch (error) {
    console.error('[band-watches] back catalogue look-up error:', error);
    res.status(500).json({ error: 'Failed to start the look-up' });
  }
});

// POST /api/band-watches/back-catalogue/watch — watch the ticked bands.
const bulkSchema = z.object({
  organisation_ids: z.array(z.string().guid()).min(1).max(WATCH_BATCH_LIMIT),
});
router.post('/back-catalogue/watch', validate(bulkSchema), async (req: AuthRequest, res: Response) => {
  try {
    const { organisation_ids } = req.body as z.infer<typeof bulkSchema>;
    const r = await watchFromBackCatalogue(organisation_ids, req.user!.id);
    await logAudit(req.user!.id, 'band_watches', req.user!.id, 'bulk_watch', null,
      { source: 'back_catalogue', asked: organisation_ids.length, watched: r.watched });
    res.json({ data: r });
  } catch (error) {
    console.error('[band-watches] back catalogue watch error:', error);
    res.status(500).json({ error: 'Failed to watch those bands' });
  }
});

// POST /api/band-watches/:id/stop
router.post('/:id/stop', async (req: AuthRequest, res: Response) => {
  try {
    if (!UUID_RE.test(param(req, 'id'))) return res.status(400).json({ error: 'Invalid watch' });
    const done = await stopWatch(param(req, 'id'), req.user!.id);
    if (!done) return res.status(404).json({ error: 'Not watching this band' });
    await logAudit(req.user!.id, 'band_watches', param(req, 'id'), 'update', null, { stopped: true });
    res.json({ data: { stopped: true } });
  } catch (error) {
    console.error('[band-watches] stop error:', error);
    res.status(500).json({ error: 'Failed to stop watching' });
  }
});

// POST /api/band-watches/:id/match — a person's answer on "Match these" / "Wrong band?".
const matchSchema = z.union([
  z.object({ tm_attraction_id: z.string().min(1).max(100), tm_attraction_name: z.string().min(1).max(300) }),
  z.object({ not_on_ticketmaster: z.literal(true) }),
  z.object({ look_again: z.literal(true) }),
]);
router.post('/:id/match', validate(matchSchema), async (req: AuthRequest, res: Response) => {
  try {
    const id = param(req, 'id');
    if (!UUID_RE.test(id)) return res.status(400).json({ error: 'Invalid watch' });
    const exists = await query(`SELECT id FROM band_watches WHERE id = $1`, [id]);
    if (!exists.rows[0]) return res.status(404).json({ error: 'Watch not found' });
    const body = req.body as Record<string, unknown>;

    if (body.look_again) {
      await resetWatchMatch(id);
      setImmediate(() => { matchWatch(id).catch((err) => console.error('[band-watches] re-match failed:', err)); });
    } else if (body.not_on_ticketmaster) {
      await setWatchMatch(id, null);
    } else {
      await setWatchMatch(id, { id: String(body.tm_attraction_id), name: String(body.tm_attraction_name) });
      // Check the newly matched act straight away, so the answer shows today.
      setImmediate(() => {
        runBandWatchCheck({ manual: true, onlyWatchId: id })
          .catch((err) => console.error('[band-watches] check after match failed:', err));
      });
    }
    await logAudit(req.user!.id, 'band_watches', id, 'update', null, body);
    res.json({ data: { ok: true } });
  } catch (error) {
    console.error('[band-watches] match error:', error);
    res.status(500).json({ error: 'Failed to save the match' });
  }
});

export default router;
