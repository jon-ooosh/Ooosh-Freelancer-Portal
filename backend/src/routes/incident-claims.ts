/**
 * Incident & possible insurance claims — the case file (Vehicles › Claims).
 * docs/INCIDENT-CLAIMS-SPEC.md, Phase 1.
 *
 * A case is ALWAYS opened from a Problem (spec D1): POST /from-problem/:issueId,
 * or /out-of-the-blue, which logs the Problem first and then opens the case.
 * The broker is never contacted automatically (D4); review, policyholder
 * signing, the broker PDF and sending are MANAGER_ROLES only (D5).
 *
 * Files live under the claims/ R2 prefix, which GET /api/files/download
 * role-gates (never files/, which any freelancer can read).
 *
 * One PUBLIC route, mounted before the auth gate: the broker PDF's
 * "View full size" photo links (§11) — an unguessable per-case token.
 */
import { Router, Request, Response } from 'express';
import multer from 'multer';
import path from 'path';
import crypto from 'crypto';
import rateLimit from 'express-rate-limit';
import { v4 as uuid } from 'uuid';
import { z } from 'zod';
import { query } from '../config/database';
import { authenticate, authorize, AuthRequest, STAFF_ROLES, MANAGER_ROLES } from '../middleware/auth';
import { validate } from '../middleware/validate';
import { uploadToR2, deleteFromR2, getFromR2, isR2Configured } from '../config/r2';
import {
  CLAIM_STAGES, CLAIM_OUTCOMES, STAGE_LABEL,
  createClaimFromIssue, logClaimEvent, notifyClaimFollowers, claimLabel,
  nextWorkingDay, ukDatePlus, stageNeedsCheckDate, getDefaultClaimWatchers,
} from '../services/incident-claims';
import {
  logIssueEvent, getDefaultVehicleIssueWatchers, notifyIssueRecipients,
} from '../services/job-issues';
import { estimateVehicleValue } from '../services/vehicle-value';

const router = Router();

export const CLAIMS_PREFIX = 'claims/';

const isManager = (role: string | undefined) =>
  (MANAGER_ROLES as readonly string[]).includes(role || '');

// ─────────────────────────────────────────────────────────────────────────
// PUBLIC — full-size photo behind the broker PDF's "View full size" links.
// The token is minted when a PDF is first built; it dies 90 days after the
// case closes. Nothing mutates on GET.
// ─────────────────────────────────────────────────────────────────────────

const photoLimiter = rateLimit({
  windowMs: 60_000,
  max: 60,
  message: { error: 'Too many requests' },
  standardHeaders: true,
  legacyHeaders: false,
});

router.get('/photo/:token/:fileId', photoLimiter, async (req: Request, res: Response) => {
  try {
    const token = String(req.params.token || '');
    const fileId = String(req.params.fileId || '');
    if (token.length < 16 || token.length > 128 || !/^[0-9a-f-]{36}$/i.test(fileId)) {
      res.status(404).send('Not found');
      return;
    }
    const r = await query(
      `SELECT f.r2_key, f.content_type, f.filename
       FROM incident_claims c
       JOIN incident_claim_files f ON f.claim_id = c.id
       WHERE c.photo_link_token = $1 AND f.id = $2
         AND c.is_deleted = false
         AND f.file_type = 'photo'
         AND (c.stage <> 'closed' OR c.closed_at IS NULL OR c.closed_at > NOW() - INTERVAL '90 days')`,
      [token, fileId],
    );
    if (r.rowCount === 0) {
      res.status(404).send('This link has expired or is not valid.');
      return;
    }
    const object = await getFromR2(r.rows[0].r2_key);
    if (!object.Body) { res.status(404).send('Not found'); return; }
    res.setHeader('Content-Type', r.rows[0].content_type || 'image/jpeg');
    res.setHeader('Content-Disposition', `inline; filename="${String(r.rows[0].filename).replace(/"/g, '')}"`);
    res.setHeader('Cache-Control', 'private, max-age=3600');
    res.setHeader('X-Robots-Tag', 'noindex');
    const stream = object.Body as NodeJS.ReadableStream & { destroy?: (err?: Error) => void };
    res.on('close', () => { if (!res.writableEnded) stream.destroy?.(); });
    stream.on('error', () => res.destroy());
    stream.pipe(res);
  } catch (err) {
    console.error('Claim photo link error:', err);
    res.status(500).send('Error');
  }
});

router.use(authenticate);
router.use(authorize(...STAFF_ROLES));

// ─────────────────────────────────────────────────────────────────────────
// Shared SELECTs
// ─────────────────────────────────────────────────────────────────────────

const LIST_SELECT = `
  c.id, c.stage, c.outcome, c.closed_at,
  c.origin_issue_id, c.job_id, c.vehicle_id, c.driver_id, c.assignment_id,
  c.hh_job_number, COALESCE(fv.reg, c.vehicle_reg) AS vehicle_reg,
  c.incident_at, c.incident_time_text, c.incident_location, c.notified_on,
  c.broker_ref, c.insurer_ref, c.broker_sent_at,
  c.third_party_claim, c.liability_dispute,
  c.owner_user_id, c.next_check_on,
  c.created_at, c.updated_at,
  j.job_name, j.client_name,
  d.full_name AS driver_name,
  NULLIF(TRIM(CONCAT(op.first_name, ' ', op.last_name)), '') AS owner_name,
  (SELECT COUNT(*)::int FROM job_issues ji WHERE ji.claim_id = c.id) AS problem_count
`;

const LIST_JOIN = `
  FROM incident_claims c
  LEFT JOIN fleet_vehicles fv ON fv.id = c.vehicle_id
  LEFT JOIN jobs j ON j.id = c.job_id
  LEFT JOIN drivers d ON d.id = c.driver_id
  LEFT JOIN users ou ON ou.id = c.owner_user_id
  LEFT JOIN people op ON op.id = ou.person_id
`;

// Dates leave as YYYY-MM-DD strings, never Date objects (a DATE through
// node-postgres becomes local midnight and can shift a day on the way out).
function normaliseDates<T extends Record<string, unknown>>(row: T): T {
  for (const k of ['notified_on', 'next_check_on', 'next_check_sent_for'] as const) {
    const v = row[k];
    if (v instanceof Date) (row as Record<string, unknown>)[k] = v.toISOString().slice(0, 10);
  }
  return row;
}

async function loadClaimRow(id: string) {
  const r = await query(`SELECT * FROM incident_claims WHERE id = $1 AND is_deleted = false`, [id]);
  return r.rows[0] || null;
}

// ─────────────────────────────────────────────────────────────────────────
// Open a case
// ─────────────────────────────────────────────────────────────────────────

const fromProblemSchema = z.object({
  third_party_claim: z.boolean().optional(),
});

router.post('/from-problem/:issueId', validate(fromProblemSchema), async (req: AuthRequest, res: Response) => {
  try {
    const issueId = String(req.params.issueId);
    const body = req.body as z.infer<typeof fromProblemSchema>;
    const result = await createClaimFromIssue(issueId, req.user!.id, { thirdPartyClaim: body.third_party_claim });
    if (!result.existing) {
      const c = await loadClaimRow(result.claimId);
      await notifyClaimFollowers(result.claimId, req.user!.id,
        `Possible insurance claim opened — ${claimLabel(c || {})}`,
        'A Problem has been flagged as a possible insurance claim.');
    }
    res.status(result.existing ? 200 : 201).json({ data: { id: result.claimId, existing: result.existing } });
  } catch (err) {
    const status = (err as { status?: number }).status;
    if (status === 404) { res.status(404).json({ error: 'Problem not found' }); return; }
    console.error('Open claim from problem error:', err);
    res.status(500).json({ error: 'Failed to open claim' });
  }
});

// A claim out of the blue, after the hire (§3.1). Still Problem-first: logs a
// `dispute` Problem on the van (and the hire, if staff picked one from the
// /pcns/match lookup), then opens the case with third_party_claim set.
const outOfTheBlueSchema = z.object({
  vehicle_id: z.string().uuid(),
  alleged_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  job_id: z.string().uuid().optional().nullable(),
  driver_id: z.string().uuid().optional().nullable(),
  summary: z.string().trim().min(2).max(255),
  description: z.string().trim().max(10000).optional().nullable(),
});

router.post('/out-of-the-blue', validate(outOfTheBlueSchema), async (req: AuthRequest, res: Response) => {
  try {
    const body = req.body as z.infer<typeof outOfTheBlueSchema>;
    const userId = req.user!.id;

    let clientOrgId: string | null = null;
    if (body.job_id) {
      const job = await query(`SELECT client_id FROM jobs WHERE id = $1 AND is_deleted = false`, [body.job_id]);
      if (job.rowCount === 0) { res.status(404).json({ error: 'Job not found' }); return; }
      clientOrgId = job.rows[0].client_id ?? null;
    }
    const watchers = await getDefaultVehicleIssueWatchers();
    const ins = await query(
      `INSERT INTO job_issues (
         job_id, vehicle_id, driver_id, client_organisation_id,
         category, source_module, severity, summary, description, reported_by, watchers
       ) VALUES ($1, $2, $3, $4, 'dispute', 'manual', 'normal', $5, $6, $7, $8::uuid[])
       RETURNING id`,
      [body.job_id ?? null, body.vehicle_id, body.driver_id ?? null, clientOrgId,
       body.summary, body.description ?? null, userId, watchers],
    );
    const issueId: string = ins.rows[0].id;
    await logIssueEvent(issueId, userId, 'created', body.summary, {
      category: 'dispute', severity: 'normal', source_module: 'manual', alleged_date: body.alleged_date,
    });
    await notifyIssueRecipients(issueId, userId, 'normal', `New issue: ${body.summary.slice(0, 80)}`, 'dispute — third-party claim');
    if (body.job_id) {
      await query(
        `INSERT INTO interactions (type, content, job_id, created_by, source)
         VALUES ('note', $1, $2, $3, 'system')`,
        [`⚠️ Third-party claim logged (${body.alleged_date}): ${body.summary}`, body.job_id, userId],
      );
    }

    const result = await createClaimFromIssue(issueId, userId, {
      thirdPartyClaim: true, incidentDate: body.alleged_date,
    });
    const c = await loadClaimRow(result.claimId);
    await notifyClaimFollowers(result.claimId, userId,
      `Third-party claim logged — ${claimLabel(c || {})}`,
      `Alleged incident on ${body.alleged_date}.`);
    res.status(201).json({ data: { id: result.claimId, issue_id: issueId } });
  } catch (err) {
    console.error('Out-of-the-blue claim error:', err);
    res.status(500).json({ error: 'Failed to log the claim' });
  }
});

// ─────────────────────────────────────────────────────────────────────────
// Lists
// ─────────────────────────────────────────────────────────────────────────

router.get('/', async (req: AuthRequest, res: Response) => {
  try {
    const { stage = 'active', search, vehicle_id } = req.query as Record<string, string | undefined>;
    const page = Math.max(1, parseInt(String(req.query.page || '1'), 10) || 1);
    const limit = Math.min(200, Math.max(1, parseInt(String(req.query.limit || '50'), 10) || 50));

    const conds: string[] = ['c.is_deleted = false'];
    const params: unknown[] = [];
    if (stage === 'active') conds.push(`c.stage <> 'closed'`);
    else if (stage !== 'all') {
      if (!(CLAIM_STAGES as readonly string[]).includes(stage)) { res.status(400).json({ error: 'Invalid stage' }); return; }
      params.push(stage);
      conds.push(`c.stage = $${params.length}`);
    }
    if (vehicle_id) { params.push(vehicle_id); conds.push(`c.vehicle_id = $${params.length}`); }
    if (search && search.trim()) {
      params.push(`%${search.trim()}%`);
      const p = `$${params.length}`;
      conds.push(`(COALESCE(fv.reg, c.vehicle_reg) ILIKE ${p} OR REPLACE(COALESCE(fv.reg, c.vehicle_reg), ' ', '') ILIKE REPLACE(${p}, ' ', '')
                  OR CAST(c.hh_job_number AS TEXT) ILIKE ${p} OR c.broker_ref ILIKE ${p} OR c.insurer_ref ILIKE ${p}
                  OR c.incident_location ILIKE ${p} OR d.full_name ILIKE ${p} OR j.job_name ILIKE ${p})`);
    }
    const where = `WHERE ${conds.join(' AND ')}`;

    const count = await query(`SELECT COUNT(*)::int AS n ${LIST_JOIN} ${where}`, params);
    params.push(limit, (page - 1) * limit);
    const rows = await query(
      `SELECT ${LIST_SELECT} ${LIST_JOIN} ${where}
       ORDER BY CASE WHEN c.stage = 'closed' THEN 1 ELSE 0 END,
                c.next_check_on NULLS FIRST,
                c.created_at DESC
       LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params,
    );
    const total = count.rows[0].n as number;
    res.json({
      data: rows.rows.map(normaliseDates),
      pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
    });
  } catch (err) {
    console.error('List claims error:', err);
    res.status(500).json({ error: 'Failed to fetch claims' });
  }
});

const byEntity = (column: 'vehicle_id' | 'job_id' | 'driver_id') =>
  async (req: AuthRequest, res: Response) => {
    try {
      const r = await query(
        `SELECT ${LIST_SELECT} ${LIST_JOIN}
         WHERE c.is_deleted = false AND c.${column} = $1
         ORDER BY CASE WHEN c.stage = 'closed' THEN 1 ELSE 0 END, c.created_at DESC`,
        [String(req.params.id)],
      );
      res.json({ data: r.rows.map(normaliseDates) });
    } catch (err) {
      console.error(`Claims by ${column} error:`, err);
      res.status(500).json({ error: 'Failed to fetch claims' });
    }
  };

router.get('/by-vehicle/:id', byEntity('vehicle_id'));
router.get('/by-job/:id', byEntity('job_id'));
router.get('/by-driver/:id', byEntity('driver_id'));

// ─────────────────────────────────────────────────────────────────────────
// One case
// ─────────────────────────────────────────────────────────────────────────

router.get('/:id', async (req: AuthRequest, res: Response) => {
  try {
    const id = String(req.params.id);
    const r = await query(
      `SELECT c.*, COALESCE(fv.reg, c.vehicle_reg) AS vehicle_reg,
              fv.make AS vehicle_make, fv.model AS vehicle_model, fv.cylinder_capacity_cc AS vehicle_cc,
              fv.cash_price, fv.deposit_paid, fv.amount_financed, fv.date_first_reg,
              j.job_name, j.client_name, j.job_date, j.job_end,
              d.full_name AS driver_name,
              NULLIF(TRIM(CONCAT(op.first_name, ' ', op.last_name)), '') AS owner_name,
              NULLIF(TRIM(CONCAT(pp.first_name, ' ', pp.last_name)), '') AS policyholder_user_name
       FROM incident_claims c
       LEFT JOIN fleet_vehicles fv ON fv.id = c.vehicle_id
       LEFT JOIN jobs j ON j.id = c.job_id
       LEFT JOIN drivers d ON d.id = c.driver_id
       LEFT JOIN users ou ON ou.id = c.owner_user_id
       LEFT JOIN people op ON op.id = ou.person_id
       LEFT JOIN users pu ON pu.id = c.policyholder_user_id
       LEFT JOIN people pp ON pp.id = pu.person_id
       WHERE c.id = $1 AND c.is_deleted = false`,
      [id],
    );
    if (r.rowCount === 0) { res.status(404).json({ error: 'Claim not found' }); return; }
    const claim = r.rows[0];

    // Value estimate — admins get £100 rounding, everyone else £500 (§6.6).
    const estimate = await estimateVehicleValue(claim, { isAdmin: req.user!.role === 'admin' });
    delete claim.cash_price; delete claim.deposit_paid; delete claim.amount_financed;
    delete claim.photo_link_token;

    const [problems, events, files, drivers] = await Promise.all([
      query(
        `SELECT ji.id, ji.summary, ji.category, ji.status, ji.severity, ji.created_at, ji.component_key
         FROM job_issues ji WHERE ji.claim_id = $1 ORDER BY ji.created_at`,
        [id],
      ),
      query(
        `SELECT e.id, e.event_type, to_char(e.event_date, 'YYYY-MM-DD') AS event_date,
                e.body, e.metadata, e.created_at,
                NULLIF(TRIM(CONCAT(p.first_name, ' ', p.last_name)), '') AS created_by_name
         FROM incident_claim_events e
         LEFT JOIN users u ON u.id = e.created_by
         LEFT JOIN people p ON p.id = u.person_id
         WHERE e.claim_id = $1
         ORDER BY e.created_at DESC`,
        [id],
      ),
      query(
        `SELECT f.id, f.r2_key, f.thumb_r2_key, f.filename, f.file_type, f.content_type, f.size_bytes,
                f.caption, f.taken_at, f.uploaded_at,
                NULLIF(TRIM(CONCAT(p.first_name, ' ', p.last_name)), '') AS uploaded_by_name
         FROM incident_claim_files f
         LEFT JOIN users u ON u.id = f.uploaded_by
         LEFT JOIN people p ON p.id = u.person_id
         WHERE f.claim_id = $1
         ORDER BY f.uploaded_at`,
        [id],
      ),
      // Everyone who could have been driving: drivers on this van on this hire
      // (or on the whole hire when the case has no van yet). Names only here —
      // the identified driver's declarations are fetched separately below.
      claim.job_id || claim.hh_job_number
        ? query(
          `SELECT DISTINCT ON (d.id)
                  d.id AS driver_id, d.full_name, vha.id AS assignment_id, vha.vehicle_id,
                  (vha.hire_form_pdf_key IS NOT NULL) AS has_hire_form
           FROM vehicle_hire_assignments vha
           JOIN drivers d ON d.id = vha.driver_id
           WHERE vha.status <> 'cancelled'
             AND ($1::uuid IS NULL OR vha.vehicle_id = $1)
             AND ((vha.job_id IS NOT NULL AND vha.job_id = $2)
                  OR (vha.job_id IS NULL AND $3::int IS NOT NULL AND vha.hirehop_job_id = $3))
           ORDER BY d.id, (vha.hire_form_pdf_key IS NOT NULL) DESC`,
          [claim.vehicle_id, claim.job_id, claim.hh_job_number],
        )
        : Promise.resolve({ rows: [] as unknown[] }),
    ]);

    // The identified driver's hire-form declarations (§7.3) — for the staff
    // form's "from the hire form" hints and the broker PDF. Staff-only page.
    let hireFormDeclarations: Record<string, unknown> | null = null;
    if (claim.driver_id) {
      const dr = await query(
        `SELECT has_accidents, has_convictions, has_prosecution, has_disability,
                licence_points, licence_endorsements, additional_details
         FROM drivers WHERE id = $1`,
        [claim.driver_id],
      );
      if (dr.rows[0]) {
        const x = dr.rows[0];
        const endorsements = Array.isArray(x.licence_endorsements) ? x.licence_endorsements : [];
        hireFormDeclarations = {
          accidents: !!x.has_accidents,
          // (b) combined: serious convictions OR pending prosecution OR any points / endorsements.
          convictions: !!x.has_convictions || !!x.has_prosecution || Number(x.licence_points || 0) > 0 || endorsements.length > 0,
          disability: !!x.has_disability,
          licence_points: x.licence_points ?? null,
          endorsements,
          additional_details: x.additional_details ?? null,
        };
      }
    }

    res.json({
      data: {
        ...normaliseDates(claim),
        date_first_reg: claim.date_first_reg instanceof Date ? claim.date_first_reg.toISOString().slice(0, 10) : claim.date_first_reg,
        value_estimate: estimate,
        hire_form_declarations: hireFormDeclarations,
        problems: problems.rows,
        events: events.rows,
        files: files.rows,
        drivers: drivers.rows,
        stage_label: STAGE_LABEL[claim.stage as keyof typeof STAGE_LABEL] || claim.stage,
      },
    });
  } catch (err) {
    console.error('Get claim error:', err);
    res.status(500).json({ error: 'Failed to fetch claim' });
  }
});

// ─────────────────────────────────────────────────────────────────────────
// Edit
// ─────────────────────────────────────────────────────────────────────────

const dateStr = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
/** 2026-10-20 → 20/10/2026 for timeline text. */
const ukd = (ymd: string) => ymd.split('-').reverse().join('/');

const patchSchema = z.object({
  vehicle_id: z.string().uuid().nullable().optional(),
  driver_id: z.string().uuid().nullable().optional(),
  notified_on: dateStr.optional(),
  broker_ref: z.string().trim().max(100).nullable().optional(),
  insurer_ref: z.string().trim().max(100).nullable().optional(),
  broker_sent_on: dateStr.nullable().optional(),
  third_party_claim: z.boolean().optional(),
  third_party_claim_notes: z.string().trim().max(5000).nullable().optional(),
  liability_dispute: z.boolean().optional(),
  liability_dispute_notes: z.string().trim().max(5000).nullable().optional(),
  owner_user_id: z.string().uuid().nullable().optional(),
  next_check_on: dateStr.nullable().optional(),
  next_check_note: z.string().trim().max(2000).optional(),
  form_data: z.record(z.unknown()).optional(),
});

router.patch('/:id', validate(patchSchema), async (req: AuthRequest, res: Response) => {
  try {
    const id = String(req.params.id);
    const body = req.body as z.infer<typeof patchSchema>;
    const before = await loadClaimRow(id);
    if (!before) { res.status(404).json({ error: 'Claim not found' }); return; }
    const userId = req.user!.id;

    const sets: string[] = [];
    const params: unknown[] = [id];
    const set = (col: string, val: unknown, cast = '') => {
      params.push(val);
      sets.push(`${col} = $${params.length}${cast}`);
    };

    if ('vehicle_id' in body) {
      set('vehicle_id', body.vehicle_id ?? null);
      let reg: string | null = null;
      if (body.vehicle_id) {
        const v = await query(`SELECT reg FROM fleet_vehicles WHERE id = $1`, [body.vehicle_id]);
        if (v.rowCount === 0) { res.status(404).json({ error: 'Vehicle not found' }); return; }
        reg = v.rows[0].reg;
      }
      set('vehicle_reg', reg);
    }
    if ('driver_id' in body) {
      set('driver_id', body.driver_id ?? null);
      // Keep the assignment in step when the driver is on this hire.
      let assignmentId: string | null = null;
      if (body.driver_id) {
        const a = await query(
          `SELECT id FROM vehicle_hire_assignments
           WHERE driver_id = $1 AND status <> 'cancelled'
             AND ($2::uuid IS NULL OR vehicle_id = $2)
             AND (($3::uuid IS NOT NULL AND job_id = $3) OR ($4::int IS NOT NULL AND job_id IS NULL AND hirehop_job_id = $4))
           ORDER BY created_at DESC LIMIT 1`,
          [body.driver_id, body.vehicle_id ?? before.vehicle_id, before.job_id, before.hh_job_number],
        );
        assignmentId = a.rows[0]?.id ?? null;
      }
      set('assignment_id', assignmentId);
    }
    if (body.notified_on !== undefined) set('notified_on', body.notified_on, '::date');
    if ('broker_ref' in body) set('broker_ref', body.broker_ref || null);
    if ('insurer_ref' in body) set('insurer_ref', body.insurer_ref || null);
    if ('broker_sent_on' in body) set('broker_sent_at', body.broker_sent_on ? `${body.broker_sent_on}T12:00:00Z` : null, '::timestamptz');
    if (body.third_party_claim !== undefined) set('third_party_claim', body.third_party_claim);
    if ('third_party_claim_notes' in body) set('third_party_claim_notes', body.third_party_claim_notes || null);
    if (body.liability_dispute !== undefined) set('liability_dispute', body.liability_dispute);
    if ('liability_dispute_notes' in body) set('liability_dispute_notes', body.liability_dispute_notes || null);
    if ('owner_user_id' in body) set('owner_user_id', body.owner_user_id ?? null);
    if ('next_check_on' in body) set('next_check_on', body.next_check_on ?? null, '::date');
    if (body.form_data) {
      // Whole-object replace; derive the few list/filter columns from it.
      const fd = body.form_data as Record<string, Record<string, unknown> | unknown>;
      const inc = (fd.incident && typeof fd.incident === 'object' ? fd.incident : {}) as Record<string, unknown>;
      set('form_data', JSON.stringify(fd), '::jsonb');
      const date = typeof inc.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(inc.date) ? inc.date : null;
      set('incident_at', date ? `${date}T12:00:00Z` : null, '::timestamptz');
      set('incident_time_text', typeof inc.time === 'string' && inc.time.trim() ? inc.time.trim() : null);
      set('incident_location', typeof inc.place === 'string' && inc.place.trim() ? inc.place.trim() : null);
    }
    if (sets.length === 0) { res.status(400).json({ error: 'Nothing to update' }); return; }
    sets.push('updated_at = NOW()');
    await query(`UPDATE incident_claims SET ${sets.join(', ')} WHERE id = $1`, params);

    // Timeline — one event per meaningful change.
    if ('broker_ref' in body && (body.broker_ref || null) !== before.broker_ref) {
      await logClaimEvent(id, userId, 'ref_recorded', `Boswell ref: ${body.broker_ref || '(cleared)'}`);
    }
    if ('insurer_ref' in body && (body.insurer_ref || null) !== before.insurer_ref) {
      await logClaimEvent(id, userId, 'ref_recorded', `Markerstudy ref: ${body.insurer_ref || '(cleared)'}`);
    }
    if (body.third_party_claim !== undefined && body.third_party_claim !== before.third_party_claim) {
      await logClaimEvent(id, userId, 'complication', body.third_party_claim ? 'Third-party claim against our policy flagged' : 'Third-party claim flag cleared');
    }
    if (body.liability_dispute !== undefined && body.liability_dispute !== before.liability_dispute) {
      await logClaimEvent(id, userId, 'complication', body.liability_dispute ? 'Liability dispute with the hirer flagged' : 'Liability dispute flag cleared');
    }
    if ('owner_user_id' in body && (body.owner_user_id ?? null) !== before.owner_user_id) {
      await logClaimEvent(id, userId, 'owner_change', null, { from: before.owner_user_id, to: body.owner_user_id ?? null });
      if (body.owner_user_id && body.owner_user_id !== userId) {
        await notifyClaimFollowers(id, userId, `You now own claim — ${claimLabel(before)}`,
          'You\'ll get a bell on its next check date.', { onlyUserIds: [body.owner_user_id] });
      }
    }
    if ('next_check_on' in body) {
      const beforeDate = before.next_check_on instanceof Date ? before.next_check_on.toISOString().slice(0, 10) : before.next_check_on;
      if ((body.next_check_on ?? null) !== (beforeDate ?? null) || body.next_check_note) {
        await logClaimEvent(id, userId, 'next_check',
          [body.next_check_on ? `Next check ${ukd(body.next_check_on)}` : 'Next check date cleared', body.next_check_note].filter(Boolean).join(' — '),
          { from: beforeDate ?? null, to: body.next_check_on ?? null });
      }
    }
    if ('driver_id' in body && (body.driver_id ?? null) !== before.driver_id) {
      let name: string | null = null;
      if (body.driver_id) {
        const d = await query(`SELECT full_name FROM drivers WHERE id = $1`, [body.driver_id]);
        name = d.rows[0]?.full_name ?? null;
      }
      await logClaimEvent(id, userId, 'driver_set', name ? `Driver at the time: ${name}` : 'Driver cleared', { driver_id: body.driver_id ?? null });
    }
    if ('broker_sent_on' in body) {
      await logClaimEvent(id, userId, 'milestone', 'Docs sent to broker', { kind: 'broker_sent' }, { eventDate: body.broker_sent_on ?? null });
    }
    if (body.notified_on !== undefined) {
      const beforeNotified = before.notified_on instanceof Date ? before.notified_on.toISOString().slice(0, 10) : before.notified_on;
      if (body.notified_on !== beforeNotified) {
        await logClaimEvent(id, userId, 'milestone', 'Date we were notified corrected', { kind: 'notified' }, { eventDate: body.notified_on });
      }
    }
    if (body.form_data) await logClaimEvent(id, userId, 'form_saved', 'Form answers updated');

    res.json({ data: { ok: true } });
  } catch (err) {
    console.error('Update claim error:', err);
    res.status(500).json({ error: 'Failed to update claim' });
  }
});

// Log an update + set the next check date in one go (§9.2 — "logging any
// update asks when to next check").
const updateSchema = z.object({
  note: z.string().trim().min(1).max(10000),
  next_check_on: dateStr.nullable().optional(),
});

router.post('/:id/updates', validate(updateSchema), async (req: AuthRequest, res: Response) => {
  try {
    const id = String(req.params.id);
    const body = req.body as z.infer<typeof updateSchema>;
    const c = await loadClaimRow(id);
    if (!c) { res.status(404).json({ error: 'Claim not found' }); return; }
    await logClaimEvent(id, req.user!.id, 'comment', body.note);
    if (body.next_check_on !== undefined) {
      await query(`UPDATE incident_claims SET next_check_on = $2::date, updated_at = NOW() WHERE id = $1`, [id, body.next_check_on]);
      await logClaimEvent(id, req.user!.id, 'next_check',
        body.next_check_on ? `Next check ${ukd(body.next_check_on)}` : 'Next check date cleared',
        { to: body.next_check_on });
    } else {
      await query(`UPDATE incident_claims SET updated_at = NOW() WHERE id = $1`, [id]);
    }
    await notifyClaimFollowers(id, req.user!.id, `Claim update — ${claimLabel(c)}`, 'A new update was logged on the case.', { priority: 'low' });
    res.status(201).json({ data: { ok: true } });
  } catch (err) {
    console.error('Claim update error:', err);
    res.status(500).json({ error: 'Failed to log update' });
  }
});

// Milestones with a date that's often logged after the fact (§4).
const milestoneSchema = z.object({
  kind: z.enum(['processed', 'repair_booked', 'other']),
  date: dateStr,
  note: z.string().trim().max(2000).optional(),
});
const MILESTONE_LABEL: Record<string, string> = {
  processed: 'Claim processed / approved',
  repair_booked: 'Repair booked',
  other: 'Milestone',
};

router.post('/:id/milestones', validate(milestoneSchema), async (req: AuthRequest, res: Response) => {
  try {
    const id = String(req.params.id);
    const body = req.body as z.infer<typeof milestoneSchema>;
    if (!(await loadClaimRow(id))) { res.status(404).json({ error: 'Claim not found' }); return; }
    await logClaimEvent(id, req.user!.id, 'milestone',
      [MILESTONE_LABEL[body.kind], body.note].filter(Boolean).join(' — '),
      { kind: body.kind }, { eventDate: body.date });
    await query(`UPDATE incident_claims SET updated_at = NOW() WHERE id = $1`, [id]);
    res.status(201).json({ data: { ok: true } });
  } catch (err) {
    console.error('Claim milestone error:', err);
    res.status(500).json({ error: 'Failed to add milestone' });
  }
});

router.patch('/:id/milestones/:eventId', validate(z.object({ date: dateStr })), async (req: AuthRequest, res: Response) => {
  try {
    const r = await query(
      `UPDATE incident_claim_events SET event_date = $3::date
       WHERE id = $2 AND claim_id = $1 AND event_type = 'milestone'
       RETURNING id`,
      [String(req.params.id), String(req.params.eventId), (req.body as { date: string }).date],
    );
    if (!r.rowCount) { res.status(404).json({ error: 'Milestone not found' }); return; }
    res.json({ data: { ok: true } });
  } catch (err) {
    console.error('Claim milestone edit error:', err);
    res.status(500).json({ error: 'Failed to edit milestone' });
  }
});

// ─────────────────────────────────────────────────────────────────────────
// Stage
// ─────────────────────────────────────────────────────────────────────────

const stageSchema = z.object({
  stage: z.enum(CLAIM_STAGES),
  outcome: z.enum(CLAIM_OUTCOMES).optional(),
  note: z.string().trim().max(5000).optional(),
});

// Moves that are a manager's decision (spec D5): reviewing, sending, closing,
// and re-opening a closed case.
const MANAGER_TARGETS: ReadonlySet<string> = new Set(['reviewed', 'with_broker', 'closed']);

router.post('/:id/stage', validate(stageSchema), async (req: AuthRequest, res: Response) => {
  try {
    const id = String(req.params.id);
    const body = req.body as z.infer<typeof stageSchema>;
    const c = await loadClaimRow(id);
    if (!c) { res.status(404).json({ error: 'Claim not found' }); return; }
    if (body.stage === c.stage) { res.status(400).json({ error: 'Already at that stage' }); return; }
    if ((MANAGER_TARGETS.has(body.stage) || c.stage === 'closed') && !isManager(req.user!.role)) {
      res.status(403).json({ error: 'Only a manager or admin can do that' });
      return;
    }
    if (body.stage === 'form_out') {
      // Phase 2 builds the client form + links; until then nothing would chase.
      res.status(400).json({ error: 'Sending the form to the client arrives with the client form (Phase 2).' });
      return;
    }
    if (body.stage === 'closed' && !body.outcome) {
      res.status(400).json({ error: 'Pick an outcome to close the case' });
      return;
    }

    const sets = ['stage = $2', 'updated_at = NOW()'];
    const params: unknown[] = [id, body.stage];
    if (body.stage === 'closed') {
      params.push(body.outcome);
      sets.push(`outcome = $${params.length}`, 'closed_at = NOW()', 'next_check_on = NULL');
    } else {
      if (c.stage === 'closed') sets.push('outcome = NULL', 'closed_at = NULL');
      let next: string | null = null;
      if (body.stage === 'submitted') next = nextWorkingDay();            // "waiting for review"
      else if (stageNeedsCheckDate(body.stage) && (c.stage === 'closed' || !c.next_check_on)) next = ukDatePlus(14);
      if (next) { params.push(next); sets.push(`next_check_on = $${params.length}::date`); }
      if (body.stage === 'with_broker' && !c.broker_sent_at) sets.push('broker_sent_at = NOW()');
    }
    await query(`UPDATE incident_claims SET ${sets.join(', ')} WHERE id = $1`, params);

    const label = STAGE_LABEL[body.stage];
    await logClaimEvent(id, req.user!.id, 'stage_change',
      [body.stage === 'closed' ? `Closed — ${body.outcome!.replace('_', ' ')}` : label, body.note].filter(Boolean).join(' — '),
      { from: c.stage, to: body.stage, outcome: body.outcome ?? null });
    if (body.stage === 'with_broker' && !c.broker_sent_at) {
      await logClaimEvent(id, req.user!.id, 'milestone', 'Docs sent to broker (marked by hand)', { kind: 'broker_sent' }, { eventDate: ukDatePlus(0) });
    }
    await notifyClaimFollowers(id, req.user!.id, `Claim ${body.stage === 'closed' ? 'closed' : 'moved on'} — ${claimLabel(c)}`, label);
    res.json({ data: { ok: true } });
  } catch (err) {
    console.error('Claim stage error:', err);
    res.status(500).json({ error: 'Failed to change stage' });
  }
});

// ─────────────────────────────────────────────────────────────────────────
// Problems on the case
// ─────────────────────────────────────────────────────────────────────────

router.post('/:id/problems', validate(z.object({ issue_id: z.string().uuid() })), async (req: AuthRequest, res: Response) => {
  try {
    const id = String(req.params.id);
    const issueId = (req.body as { issue_id: string }).issue_id;
    if (!(await loadClaimRow(id))) { res.status(404).json({ error: 'Claim not found' }); return; }
    const r = await query(
      `UPDATE job_issues SET claim_id = $2, updated_at = NOW()
       WHERE id = $1 AND (claim_id IS NULL OR claim_id = $2)
       RETURNING summary`,
      [issueId, id],
    );
    if (!r.rowCount) { res.status(409).json({ error: 'That Problem is already on another claim' }); return; }
    await logClaimEvent(id, req.user!.id, 'problem_linked', r.rows[0].summary, { issue_id: issueId });
    await logIssueEvent(issueId, req.user!.id, 'claim_linked', 'Linked to an insurance claim', { claim_id: id });
    await query(`UPDATE incident_claims SET updated_at = NOW() WHERE id = $1`, [id]);
    res.status(201).json({ data: { ok: true } });
  } catch (err) {
    console.error('Link problem error:', err);
    res.status(500).json({ error: 'Failed to link Problem' });
  }
});

router.delete('/:id/problems/:issueId', async (req: AuthRequest, res: Response) => {
  try {
    const id = String(req.params.id);
    const issueId = String(req.params.issueId);
    const c = await loadClaimRow(id);
    if (!c) { res.status(404).json({ error: 'Claim not found' }); return; }
    if (c.origin_issue_id === issueId) {
      res.status(400).json({ error: 'The Problem the case was opened from stays linked' });
      return;
    }
    const r = await query(
      `UPDATE job_issues SET claim_id = NULL, updated_at = NOW() WHERE id = $1 AND claim_id = $2 RETURNING summary`,
      [issueId, id],
    );
    if (!r.rowCount) { res.status(404).json({ error: 'Not linked' }); return; }
    await logClaimEvent(id, req.user!.id, 'problem_unlinked', r.rows[0].summary, { issue_id: issueId });
    await logIssueEvent(issueId, req.user!.id, 'claim_unlinked', 'Removed from the insurance claim', { claim_id: id });
    res.json({ data: { ok: true } });
  } catch (err) {
    console.error('Unlink problem error:', err);
    res.status(500).json({ error: 'Failed to unlink Problem' });
  }
});

// Open Problems on the same van that could be linked (the picker).
router.get('/:id/linkable-problems', async (req: AuthRequest, res: Response) => {
  try {
    const c = await loadClaimRow(String(req.params.id));
    if (!c) { res.status(404).json({ error: 'Claim not found' }); return; }
    const r = await query(
      `SELECT ji.id, ji.summary, ji.category, ji.status, ji.created_at, j.hh_job_number
       FROM job_issues ji LEFT JOIN jobs j ON j.id = ji.job_id
       WHERE ji.claim_id IS NULL
         AND (($1::uuid IS NOT NULL AND ji.vehicle_id = $1) OR ($2::uuid IS NOT NULL AND ji.job_id = $2))
       ORDER BY ji.created_at DESC
       LIMIT 50`,
      [c.vehicle_id, c.job_id],
    );
    res.json({ data: r.rows });
  } catch (err) {
    console.error('Linkable problems error:', err);
    res.status(500).json({ error: 'Failed to fetch Problems' });
  }
});

// ─────────────────────────────────────────────────────────────────────────
// Files — claims/ prefix (role-gated in files.ts). Photos arrive already
// compressed client-side, with an optional small `thumb` for the broker PDF.
// ─────────────────────────────────────────────────────────────────────────

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 15 * 1024 * 1024, files: 2 } });
const FILE_TYPES = ['photo', 'police_report', 'broker_correspondence', 'repair_quote', 'other'] as const;

router.post('/:id/files', upload.fields([{ name: 'file', maxCount: 1 }, { name: 'thumb', maxCount: 1 }]), async (req: AuthRequest, res: Response) => {
  try {
    if (!isR2Configured()) { res.status(503).json({ error: 'File storage not configured' }); return; }
    const id = String(req.params.id);
    const files = req.files as Record<string, Express.Multer.File[]> | undefined;
    const file = files?.file?.[0];
    if (!file) { res.status(400).json({ error: 'No file provided' }); return; }
    if (!(await loadClaimRow(id))) { res.status(404).json({ error: 'Claim not found' }); return; }

    const ext = (path.extname(file.originalname) || '').toLowerCase().replace(/[^.a-z0-9]/g, '').slice(0, 10);
    const isImage = (file.mimetype || '').startsWith('image/');
    const requested = String(req.body.file_type || '');
    const fileType = (FILE_TYPES as readonly string[]).includes(requested) ? requested : (isImage ? 'photo' : 'other');
    const fileId = uuid();
    const key = `${CLAIMS_PREFIX}${id}/${fileId}${ext}`;
    await uploadToR2(key, file.buffer, file.mimetype || 'application/octet-stream');

    let thumbKey: string | null = null;
    const thumb = files?.thumb?.[0];
    if (thumb && (thumb.mimetype || '').startsWith('image/')) {
      thumbKey = `${CLAIMS_PREFIX}${id}/${fileId}_thumb.jpg`;
      await uploadToR2(thumbKey, thumb.buffer, 'image/jpeg');
    }

    const takenRaw = typeof req.body.taken_at === 'string' ? req.body.taken_at : '';
    const takenAt = takenRaw && !Number.isNaN(new Date(takenRaw).getTime()) ? new Date(takenRaw).toISOString() : null;
    const caption = typeof req.body.caption === 'string' && req.body.caption.trim() ? req.body.caption.trim().slice(0, 500) : null;

    await query(
      `INSERT INTO incident_claim_files
         (id, claim_id, r2_key, thumb_r2_key, filename, file_type, content_type, size_bytes, caption, taken_at, uploaded_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      [fileId, id, key, thumbKey, file.originalname.slice(0, 255), fileType, file.mimetype, file.size, caption, takenAt, req.user!.id],
    );
    await logClaimEvent(id, req.user!.id, 'file_added', file.originalname.slice(0, 255), { file_id: fileId, file_type: fileType });
    await query(`UPDATE incident_claims SET updated_at = NOW() WHERE id = $1`, [id]);
    res.status(201).json({ data: { id: fileId } });
  } catch (err) {
    console.error('Claim file upload error:', err);
    res.status(500).json({ error: 'Failed to upload file' });
  }
});

router.patch('/:id/files/:fileId', validate(z.object({
  caption: z.string().trim().max(500).nullable().optional(),
  file_type: z.enum(FILE_TYPES).optional(),
})), async (req: AuthRequest, res: Response) => {
  try {
    const body = req.body as { caption?: string | null; file_type?: string };
    const sets: string[] = [];
    const params: unknown[] = [String(req.params.fileId), String(req.params.id)];
    if ('caption' in body) { params.push(body.caption || null); sets.push(`caption = $${params.length}`); }
    if (body.file_type) { params.push(body.file_type); sets.push(`file_type = $${params.length}`); }
    if (!sets.length) { res.status(400).json({ error: 'Nothing to update' }); return; }
    const r = await query(`UPDATE incident_claim_files SET ${sets.join(', ')} WHERE id = $1 AND claim_id = $2 RETURNING id`, params);
    if (!r.rowCount) { res.status(404).json({ error: 'File not found' }); return; }
    res.json({ data: { ok: true } });
  } catch (err) {
    console.error('Claim file edit error:', err);
    res.status(500).json({ error: 'Failed to update file' });
  }
});

// Removing evidence from an insurance case file is a manager's call.
router.delete('/:id/files/:fileId', authorize(...MANAGER_ROLES), async (req: AuthRequest, res: Response) => {
  try {
    const id = String(req.params.id);
    const fileId = String(req.params.fileId);
    const r = await query(
      `DELETE FROM incident_claim_files WHERE id = $1 AND claim_id = $2 RETURNING r2_key, thumb_r2_key, filename`,
      [fileId, id],
    );
    if (!r.rowCount) { res.status(404).json({ error: 'File not found' }); return; }
    for (const k of [r.rows[0].r2_key, r.rows[0].thumb_r2_key]) {
      if (k) await deleteFromR2(k).catch((e) => console.error('R2 delete failed (continuing):', e));
    }
    await logClaimEvent(id, req.user!.id, 'file_removed', r.rows[0].filename, { file_id: fileId });
    res.json({ data: { ok: true } });
  } catch (err) {
    console.error('Claim file delete error:', err);
    res.status(500).json({ error: 'Failed to delete file' });
  }
});

// ─────────────────────────────────────────────────────────────────────────
// Watch
// ─────────────────────────────────────────────────────────────────────────

router.post('/:id/watch', async (req: AuthRequest, res: Response) => {
  try {
    await query(
      `UPDATE incident_claims SET watchers = array_append(watchers, $2::uuid)
       WHERE id = $1 AND NOT (watchers && ARRAY[$2::uuid])`,
      [String(req.params.id), req.user!.id],
    );
    res.json({ data: { ok: true } });
  } catch (err) {
    console.error('Claim watch error:', err);
    res.status(500).json({ error: 'Failed to watch' });
  }
});

router.post('/:id/unwatch', async (req: AuthRequest, res: Response) => {
  try {
    await query(`UPDATE incident_claims SET watchers = array_remove(watchers, $2::uuid) WHERE id = $1`, [String(req.params.id), req.user!.id]);
    res.json({ data: { ok: true } });
  } catch (err) {
    console.error('Claim unwatch error:', err);
    res.status(500).json({ error: 'Failed to unwatch' });
  }
});

// ─────────────────────────────────────────────────────────────────────────
// Broker PDF (§11) — MANAGER_ROLES only
// ─────────────────────────────────────────────────────────────────────────

/** The case's photo-link token, minted on first use. */
async function ensurePhotoLinkToken(claimId: string): Promise<string> {
  const token = crypto.randomBytes(24).toString('base64url');
  const r = await query(
    `UPDATE incident_claims SET photo_link_token = COALESCE(photo_link_token, $2)
     WHERE id = $1 RETURNING photo_link_token`,
    [claimId, token],
  );
  return r.rows[0].photo_link_token as string;
}

// Preview — built fresh, not stored, not sent.
router.get('/:id/pdf', authorize(...MANAGER_ROLES), async (req: AuthRequest, res: Response) => {
  try {
    const id = String(req.params.id);
    if (!(await loadClaimRow(id))) { res.status(404).json({ error: 'Claim not found' }); return; }
    const token = await ensurePhotoLinkToken(id);
    const { buildClaimPdf } = await import('../services/claim-pdf');
    const { bytes, filename } = await buildClaimPdf(id, { photoLinkToken: token });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="${filename}"`);
    res.send(Buffer.from(bytes));
  } catch (err) {
    console.error('Claim PDF preview error:', err);
    res.status(500).json({ error: 'Failed to build the PDF' });
  }
});

// Policyholder signature — the logged-in manager signs for Ooosh.
const signSchema = z.object({
  signature_png_base64: z.string().min(100).max(2_000_000),
  print_name: z.string().trim().min(2).max(120),
});

router.post('/:id/sign', authorize(...MANAGER_ROLES), validate(signSchema), async (req: AuthRequest, res: Response) => {
  try {
    const id = String(req.params.id);
    const body = req.body as z.infer<typeof signSchema>;
    if (!(await loadClaimRow(id))) { res.status(404).json({ error: 'Claim not found' }); return; }
    const png = Buffer.from(body.signature_png_base64.replace(/^data:image\/png;base64,/, ''), 'base64');
    if (png.length < 100 || png.subarray(1, 4).toString('ascii') !== 'PNG') {
      res.status(400).json({ error: 'Signature is not a PNG' });
      return;
    }
    const key = `${CLAIMS_PREFIX}${id}/policyholder-signature-${Date.now()}.png`;
    await uploadToR2(key, png, 'image/png');
    await query(
      `UPDATE incident_claims SET policyholder_user_id = $2, policyholder_signature_key = $3,
              policyholder_signed_name = $4, policyholder_signed_at = NOW(), updated_at = NOW()
       WHERE id = $1`,
      [id, req.user!.id, key, body.print_name],
    );
    await logClaimEvent(id, req.user!.id, 'policyholder_signed', `Signed for Ooosh by ${body.print_name}`);
    res.json({ data: { ok: true } });
  } catch (err) {
    console.error('Claim sign error:', err);
    res.status(500).json({ error: 'Failed to save the signature' });
  }
});

// Send to the broker — builds the PDF, freezes it to R2, emails it, moves the
// case to with_broker. The single point where anything leaves for the broker.
const sendSchema = z.object({
  note: z.string().trim().max(5000).optional(),
});

router.post('/:id/send-to-broker', authorize(...MANAGER_ROLES), validate(sendSchema), async (req: AuthRequest, res: Response) => {
  try {
    const id = String(req.params.id);
    const body = req.body as z.infer<typeof sendSchema>;
    const c = await loadClaimRow(id);
    if (!c) { res.status(404).json({ error: 'Claim not found' }); return; }
    // Only a case whose answers are in (submitted / reviewed) or already with the
    // broker (an updated PDF) can go — never an open or closed one.
    if (!['submitted', 'reviewed', 'with_broker'].includes(c.stage)) {
      res.status(400).json({ error: 'Only a completed case can be sent — mark the form complete first' });
      return;
    }
    if (!c.policyholder_signed_at) {
      res.status(400).json({ error: 'Sign as policyholder before sending to the broker' });
      return;
    }
    const { getSystemSetting } = await import('./system-settings');
    const to = (await getSystemSetting('claims_broker_email'))?.trim();
    if (!to) { res.status(400).json({ error: 'No broker email set (Settings › Claims)' }); return; }

    const token = await ensurePhotoLinkToken(id);
    const { buildClaimPdf } = await import('../services/claim-pdf');
    const { bytes, filename } = await buildClaimPdf(id, { photoLinkToken: token });
    const pdfKey = `${CLAIMS_PREFIX}${id}/broker-${Date.now()}.pdf`;
    await uploadToR2(pdfKey, Buffer.from(bytes), 'application/pdf');

    const { emailService } = await import('../services/email-service');
    const reg = c.vehicle_reg || 'vehicle';
    const subject = `Motor claim — Ooosh! Tours — ${reg}${c.incident_at ? ` — ${new Date(c.incident_at).toLocaleDateString('en-GB')}` : ''}${c.hh_job_number ? ` (#${c.hh_job_number})` : ''}`;
    const esc = (s: string) => s.replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch] as string));
    const html = `
      <p>Hello,</p>
      <p>Please find attached our completed motor claim form for vehicle <strong>${esc(reg)}</strong>${c.hh_job_number ? ` (our job #${c.hh_job_number})` : ''}.</p>
      ${body.note ? `<p>${esc(body.note).replace(/\n/g, '<br>')}</p>` : ''}
      <p>Photographs are shown as thumbnails in the PDF; each has a "View full size" link.</p>
      <p>Kind regards,<br>Ooosh! Tours Ltd</p>`;
    const result = await emailService.sendRaw({
      to,
      subject,
      html,
      variant: 'client',
      attachments: [{ filename, content: Buffer.from(bytes), contentType: 'application/pdf' }],
    });
    if (!result.success) {
      await logClaimEvent(id, req.user!.id, 'broker_send_failed', result.error || 'Email failed', { pdf_key: pdfKey });
      res.status(502).json({ error: result.error || 'The email could not be sent — nothing was marked as sent' });
      return;
    }

    await query(
      `UPDATE incident_claims SET broker_pdf_key = $2, broker_sent_at = NOW(), stage = 'with_broker',
              next_check_on = $3::date, updated_at = NOW()
       WHERE id = $1`,
      [id, pdfKey, ukDatePlus(14)],
    );
    await logClaimEvent(id, req.user!.id, 'broker_sent', `Sent to ${to}`, { pdf_key: pdfKey, from_stage: c.stage });
    await logClaimEvent(id, req.user!.id, 'milestone', 'Docs sent to broker', { kind: 'broker_sent' }, { eventDate: ukDatePlus(0) });
    await notifyClaimFollowers(id, req.user!.id, `Claim sent to broker — ${claimLabel(c)}`, `Sent to ${to}.`);
    res.json({ data: { ok: true, pdf_key: pdfKey } });
  } catch (err) {
    console.error('Send claim to broker error:', err);
    res.status(500).json({ error: 'Failed to send to the broker' });
  }
});

// Estimated vehicle value for the vehicle page (§6.6). Rounded by role inside
// estimateVehicleValue — the raw purchase price never leaves the server here.
router.get('/meta/vehicle-value/:vehicleId', async (req: AuthRequest, res: Response) => {
  try {
    const v = await query(
      `SELECT cash_price, deposit_paid, amount_financed, date_first_reg FROM fleet_vehicles WHERE id = $1`,
      [String(req.params.vehicleId)],
    );
    if (v.rowCount === 0) { res.status(404).json({ error: 'Vehicle not found' }); return; }
    const estimate = await estimateVehicleValue(v.rows[0], { isAdmin: req.user!.role === 'admin' });
    res.json({ data: estimate });
  } catch (err) {
    console.error('Vehicle value error:', err);
    res.status(500).json({ error: 'Failed to estimate value' });
  }
});

// Staff pick lists for owner + watchers.
router.get('/meta/users', async (_req: AuthRequest, res: Response) => {
  try {
    const r = await query(
      `SELECT u.id, NULLIF(TRIM(CONCAT(p.first_name, ' ', p.last_name)), '') AS name, u.email, u.role
       FROM users u LEFT JOIN people p ON p.id = u.person_id
       WHERE u.is_active = true AND u.role <> 'freelancer'
       ORDER BY p.first_name NULLS LAST, u.email`,
    );
    res.json({ data: r.rows, default_watchers: await getDefaultClaimWatchers() });
  } catch (err) {
    console.error('Claim users error:', err);
    res.status(500).json({ error: 'Failed to fetch users' });
  }
});

export default router;
