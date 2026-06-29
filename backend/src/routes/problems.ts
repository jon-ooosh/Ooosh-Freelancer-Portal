/**
 * Job Problems / Issues Register
 *
 * Cross-module register for things that need a human to chase on a job —
 * vehicle damage, missing items, breakdowns, client disputes, mid-tour
 * scratches that need handling at check-in. NOT to be confused with
 * routes/issues.ts which is the OP platform bug tracker.
 *
 * Storage: dedicated job_issues table (migration 075). Phase 1 used
 * job_requirements with requirement_type='issue' — that data was migrated
 * into job_issues by the migration; the public API surface here stayed
 * stable (/api/problems/*) so callers didn't notice the storage swap.
 *
 * Anchors per issue: job (mandatory) + optional vehicle / driver / person
 * / client_organisation / hh_stock_item / barcode. The smart-picker on
 * the Job Detail panel populates these from the job's actual context, so
 * staff don't type "RX22SXL" — they pick it.
 *
 * RBAC: any STAFF_ROLES user can create / progress / close. The audit
 * trail in job_issue_events records who did what.
 */
import { Router, Response } from 'express';
import multer from 'multer';
import path from 'path';
import { v4 as uuid } from 'uuid';
import { z } from 'zod';
import { query } from '../config/database';
import { authenticate, authorize, AuthRequest, STAFF_ROLES } from '../middleware/auth';
import { validate } from '../middleware/validate';
import { uploadToR2, deleteFromR2, isR2Configured } from '../config/r2';
import {
  logIssueEvent as logEvent,
  getDefaultVehicleIssueWatchers,
  notifyIssueRecipients,
  sendVehicleIssueAlertEmail,
} from '../services/job-issues';

const router = Router();
router.use(authenticate);
router.use(authorize(...STAFF_ROLES));

// Multer for issue-level file uploads (job_issue_files table — distinct
// from interaction-level attachments which live in interactions.files
// JSONB and are handled by /api/files/upload?attachment_only=true).
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }, // 10 MB
});

function detectFileType(ext: string): 'photo' | 'pdf' | 'other' {
  const e = ext.toLowerCase();
  if (['.jpg', '.jpeg', '.png', '.gif', '.webp', '.heic'].includes(e)) return 'photo';
  if (e === '.pdf') return 'pdf';
  return 'other';
}

const VALID_CATEGORIES = ['damaged', 'missing', 'broken', 'dispute', 'breakdown', 'other'] as const;
const VALID_STATUSES = ['open', 'investigating', 'awaiting_quote', 'quoted', 'actioned', 'resolved', 'written_off', 'cancelled'] as const;
const VALID_SEVERITY = ['low', 'normal', 'urgent'] as const;
const VALID_SOURCES = ['manual', 'vehicle', 'backline', 'transport', 'client', 'driver'] as const;
const VALID_RESOLUTION = ['claim_excess', 'charge_client', 'write_off', 'replaced', 'other'] as const;
const VALID_SURFACES = ['vehicle_check_in', 'next_hire', 'next_book_out', 'job_close_out'] as const;

const createSchema = z.object({
  // job_id is now optional (migration 081). Vehicle-only issues — prep
  // flags between hires — have no active job. Validation below enforces
  // "at least one of job_id or vehicle_id must be set" to match the
  // job_issues_anchor_check DB constraint.
  job_id: z.string().uuid().optional().nullable(),
  category: z.enum(VALID_CATEGORIES),
  source_module: z.enum(VALID_SOURCES).default('manual'),
  severity: z.enum(VALID_SEVERITY).default('normal'),
  summary: z.string().trim().min(2).max(255),
  description: z.string().trim().max(10000).optional().nullable(),
  // Anchors (all optional)
  vehicle_id: z.string().uuid().optional().nullable(),
  driver_id: z.string().uuid().optional().nullable(),
  person_id: z.string().uuid().optional().nullable(),
  client_organisation_id: z.string().uuid().optional().nullable(),
  hh_stock_item_id: z.number().int().optional().nullable(),
  hh_stock_item_name: z.string().max(255).optional().nullable(),
  barcode: z.string().max(100).optional().nullable(),
  // Stable identifier for "the same thing" — used by the auto-create
  // dedup helper (find-or-append) to recognise recurring problems.
  // Prep checklist items have stable IDs (e.g. fire_extinguisher).
  // Manual entry / check-in damage with no checklist context can omit.
  component_key: z.string().max(100).optional().nullable(),
  // Behaviour
  due_date: z.string().optional().nullable(),
  surface_on: z.enum(VALID_SURFACES).optional().nullable(),
  watchers: z.array(z.string().uuid()).optional(),
  assigned_to: z.string().uuid().optional().nullable(),
}).refine(
  (data) => Boolean(data.job_id) || Boolean(data.vehicle_id),
  { message: 'At least one of job_id or vehicle_id is required', path: ['job_id'] }
);

const updateSchema = z.object({
  status: z.enum(VALID_STATUSES).optional(),
  category: z.enum(VALID_CATEGORIES).optional(),
  severity: z.enum(VALID_SEVERITY).optional(),
  summary: z.string().trim().min(2).max(255).optional(),
  description: z.string().trim().max(10000).optional().nullable(),
  // Anchors editable. job_id can be set on a vehicle-only issue when
  // a hire surfaces it (staff manually links from IssueDetailPage).
  job_id: z.string().uuid().optional().nullable(),
  vehicle_id: z.string().uuid().optional().nullable(),
  driver_id: z.string().uuid().optional().nullable(),
  person_id: z.string().uuid().optional().nullable(),
  client_organisation_id: z.string().uuid().optional().nullable(),
  hh_stock_item_id: z.number().int().optional().nullable(),
  hh_stock_item_name: z.string().max(255).optional().nullable(),
  barcode: z.string().max(100).optional().nullable(),
  component_key: z.string().max(100).optional().nullable(),
  // Workflow
  assigned_to: z.string().uuid().optional().nullable(),
  due_date: z.string().optional().nullable(),
  surface_on: z.enum(VALID_SURFACES).optional().nullable(),
  resolution_path: z.enum(VALID_RESOLUTION).optional().nullable(),
  estimated_cost: z.number().nonnegative().optional().nullable(),
  actual_cost: z.number().nonnegative().optional().nullable(),
  excess_id: z.string().uuid().optional().nullable(),
});

const commentSchema = z.object({
  body: z.string().trim().min(1).max(10000),
});

// ── Helpers ──────────────────────────────────────────────────────────────

function isResolvedStatus(s: string): boolean {
  return s === 'resolved' || s === 'written_off' || s === 'cancelled';
}

/**
 * Attach already-uploaded R2 photos to an issue. Skips keys that are
 * already linked to the issue so a reflag carrying the same photo set
 * doesn't duplicate. Photos referenced here are uploaded outside the
 * usual /:id/files endpoint (e.g. by the check-in flow which writes to
 * the public vehicle-photos bucket under `events/...`), so we just
 * record the key + a sensible filename and let downstream consumers
 * resolve the URL via R2_PUBLIC_URL.
 */
async function attachExternalIssuePhotos(
  issueId: string, userId: string, r2Keys: string[],
): Promise<number> {
  if (!r2Keys.length) return 0;
  let added = 0;
  for (const key of r2Keys) {
    const trimmed = key.trim();
    if (!trimmed) continue;
    // Dedup against existing rows on this issue with the same r2_key.
    const exists = await query(
      `SELECT 1 FROM job_issue_files WHERE issue_id = $1 AND r2_key = $2 LIMIT 1`,
      [issueId, trimmed]
    );
    if (exists.rowCount && exists.rowCount > 0) continue;
    const filename = trimmed.split('/').pop() || 'damage.jpg';
    await query(
      `INSERT INTO job_issue_files
         (issue_id, r2_key, filename, file_type, content_type, uploaded_by)
       VALUES ($1, $2, $3, 'photo', 'image/jpeg', $4)`,
      [issueId, trimmed, filename, userId]
    );
    added++;
  }
  if (added > 0) {
    await logEvent(issueId, userId, 'file_added', `${added} damage photo(s) attached`, {
      source: 'auto_attach', count: added,
    });
  }
  return added;
}

// Issue event logging, watcher seeding, severity→priority mapping, and
// notification firing all live in services/job-issues.ts (imported above)
// so the vehicle-swap flow shares one source of truth with this route.

const ISSUE_SELECT = `
  ji.id, ji.job_id, ji.vehicle_id, ji.driver_id, ji.person_id,
  ji.client_organisation_id, ji.hh_stock_item_id, ji.hh_stock_item_name, ji.barcode,
  ji.component_key,
  ji.category, ji.source_module, ji.severity, ji.status, ji.resolution_path,
  ji.summary, ji.description,
  ji.reported_by, ji.assigned_to, ji.watchers,
  ji.due_date, ji.surface_on,
  ji.estimated_cost, ji.actual_cost, ji.excess_id,
  ji.created_at, ji.updated_at, ji.resolved_at,
  j.hh_job_number, j.job_name, j.client_name, j.company_name,
  fv.reg AS vehicle_reg, fv.simple_type AS vehicle_type,
  d.full_name AS driver_name,
  CONCAT(p.first_name, ' ', p.last_name) AS person_name,
  o.name AS client_organisation_name,
  CONCAT(rp.first_name, ' ', rp.last_name) AS reported_by_name,
  CONCAT(ap.first_name, ' ', ap.last_name) AS assigned_to_name
`;

const ISSUE_JOIN = `
  FROM job_issues ji
  LEFT JOIN jobs j ON j.id = ji.job_id
  LEFT JOIN fleet_vehicles fv ON fv.id = ji.vehicle_id
  LEFT JOIN drivers d ON d.id = ji.driver_id
  LEFT JOIN people p ON p.id = ji.person_id
  LEFT JOIN organisations o ON o.id = ji.client_organisation_id
  LEFT JOIN users ru ON ru.id = ji.reported_by
  LEFT JOIN people rp ON rp.id = ru.person_id
  LEFT JOIN users au ON au.id = ji.assigned_to
  LEFT JOIN people ap ON ap.id = au.person_id
`;

// ── Smart picker — context lookup for "+ Log Problem" form ───────────────
//
// Given a job ID, returns the universe of things you might log a problem
// against: vehicles + drivers on this hire, line items on the job (from
// HH-derived line_items column), people on the job, and the client org.
// Drives the dropdowns so staff don't type "RX22SXL" — they pick it.
router.get('/picker/:jobId', async (req: AuthRequest, res: Response) => {
  try {
    const { jobId } = req.params;

    const jobResult = await query(
      `SELECT j.id, j.hh_job_number, j.job_name, j.client_id, j.line_items,
              o.id AS organisation_id, o.name AS organisation_name
       FROM jobs j
       LEFT JOIN organisations o ON o.id = j.client_id
       WHERE j.id = $1 AND j.is_deleted = false`,
      [jobId]
    );
    if (jobResult.rowCount === 0) return res.status(404).json({ error: 'Job not found' });
    const job = jobResult.rows[0];

    // Vehicles on this hire — vehicle_hire_assignments joined with fleet_vehicles
    const vehiclesResult = await query(
      `SELECT DISTINCT fv.id, fv.reg, fv.simple_type, fv.make, fv.model,
              vha.status AS assignment_status
       FROM vehicle_hire_assignments vha
       JOIN fleet_vehicles fv ON fv.id = vha.vehicle_id
       WHERE vha.job_id = $1
         AND vha.status NOT IN ('cancelled')
       ORDER BY fv.reg`,
      [jobId]
    );

    // Drivers on this hire
    const driversResult = await query(
      `SELECT DISTINCT d.id, d.full_name, d.email
       FROM vehicle_hire_assignments vha
       JOIN drivers d ON d.id = vha.driver_id
       WHERE vha.job_id = $1 AND vha.status NOT IN ('cancelled')
       ORDER BY d.full_name`,
      [jobId]
    );

    // People linked to the job via job_organisations + their org roles
    const peopleResult = await query(
      `SELECT DISTINCT p.id, p.first_name, p.last_name, por.role,
              o.name AS organisation_name
       FROM job_organisations jo
       JOIN organisations o ON o.id = jo.organisation_id
       JOIN person_organisation_roles por ON por.organisation_id = o.id
       JOIN people p ON p.id = por.person_id
       WHERE jo.job_id = $1
         AND p.is_deleted = false
         AND (por.end_date IS NULL OR por.end_date > CURRENT_DATE)
       ORDER BY p.first_name, p.last_name
       LIMIT 100`,
      [jobId]
    );

    // Line items from HH sync. line_items is JSONB; we surface item-kind rows
    // (kind=2, with stock data) for the dropdown — kind=3 prompts and
    // virtuals are filtered out as they're not meaningful "things" to fault.
    let lineItems: Array<{ list_id: number | null; title: string; qty: number | string; category_id?: string }> = [];
    if (job.line_items && Array.isArray(job.line_items)) {
      lineItems = job.line_items
        .filter((item: { kind?: number; VIRTUAL?: string | number; title?: string; LIST_ID?: string | number }) => {
          // Real items only — drop kind:3 prompts, kind:0 headers, virtuals
          return item && item.kind === 2 && !item.VIRTUAL && item.title;
        })
        .map((item: { LIST_ID?: string | number; title?: string; qty?: string | number; CATEGORY_ID?: string }) => ({
          list_id: item.LIST_ID ? Number(item.LIST_ID) : null,
          title: item.title || '',
          qty: item.qty || 1,
          category_id: item.CATEGORY_ID,
        }))
        .slice(0, 200);
    }

    res.json({
      data: {
        job: {
          id: job.id,
          hh_job_number: job.hh_job_number,
          job_name: job.job_name,
          client_organisation_id: job.organisation_id,
          client_organisation_name: job.organisation_name,
        },
        vehicles: vehiclesResult.rows,
        drivers: driversResult.rows,
        people: peopleResult.rows,
        line_items: lineItems,
      },
    });
  } catch (err) {
    console.error('Picker context error:', err);
    res.status(500).json({ error: 'Failed to load picker context' });
  }
});

// ── Create ───────────────────────────────────────────────────────────────

router.post('/', validate(createSchema), async (req: AuthRequest, res: Response) => {
  try {
    const body = req.body as z.infer<typeof createSchema>;

    // job_id is optional (vehicle-only issues). When supplied, validate it
    // and use its client_id as a default for client_organisation_id. When
    // omitted, the issue must be vehicle-anchored — refine() on the schema
    // already enforced that; the DB CHECK constraint is the belt-and-braces.
    let clientOrgId: string | null = body.client_organisation_id ?? null;
    if (body.job_id) {
      const job = await query(
        `SELECT id, client_id FROM jobs WHERE id = $1 AND is_deleted = false`,
        [body.job_id]
      );
      if (job.rowCount === 0) return res.status(404).json({ error: 'Job not found' });
      clientOrgId = body.client_organisation_id ?? job.rows[0].client_id ?? null;
    }

    // Seed fleet-wide default watchers (migration 082). Dedup so an
    // explicit `body.watchers` containing one of the defaults doesn't
    // double up. Skip when the actor is in the default set — they're
    // implicitly tracking via being the reporter.
    const defaultWatchers = await getDefaultVehicleIssueWatchers();
    const watchers = Array.from(new Set([...(body.watchers ?? []), ...defaultWatchers]));

    const insert = await query(
      `INSERT INTO job_issues (
         job_id, vehicle_id, driver_id, person_id, client_organisation_id,
         hh_stock_item_id, hh_stock_item_name, barcode, component_key,
         category, source_module, severity, summary, description,
         reported_by, assigned_to, watchers, due_date, surface_on
       ) VALUES (
         $1, $2, $3, $4, $5,
         $6, $7, $8, $9,
         $10, $11, $12, $13, $14,
         $15, $16, $17, $18, $19
       )
       RETURNING id`,
      [
        body.job_id ?? null, body.vehicle_id ?? null, body.driver_id ?? null, body.person_id ?? null, clientOrgId,
        body.hh_stock_item_id ?? null, body.hh_stock_item_name ?? null, body.barcode ?? null, body.component_key ?? null,
        body.category, body.source_module, body.severity, body.summary, body.description ?? null,
        req.user!.id, body.assigned_to ?? null, watchers, body.due_date ?? null, body.surface_on ?? null,
      ]
    );

    const issueId = insert.rows[0].id;

    await logEvent(issueId, req.user!.id, 'created', body.summary, {
      category: body.category, severity: body.severity, source_module: body.source_module,
    });

    await notifyIssueRecipients(
      issueId, req.user!.id, body.severity,
      `New issue: ${body.summary.slice(0, 80)}`,
      `${body.category} — ${body.severity}`,
    );

    // Direct email for vehicle damage/breakdown (gated internally on
    // vehicle anchor + category) — see sendVehicleIssueAlertEmail.
    await sendVehicleIssueAlertEmail(issueId, 'logged');

    // Activity Timeline echo so the issue shows on the job's timeline.
    // Skipped for vehicle-only issues (no job to anchor against).
    if (body.job_id) {
      await query(
        `INSERT INTO interactions (type, content, job_id, created_by)
         VALUES ('note', $1, $2, $3)`,
        [
          `⚠️ Issue logged (${body.category}${body.severity === 'urgent' ? ', urgent' : ''}): ${body.summary}`,
          body.job_id, req.user!.id,
        ]
      );
    }

    // Fetch the full row for the response (with all the joined names).
    const full = await query(`SELECT ${ISSUE_SELECT} ${ISSUE_JOIN} WHERE ji.id = $1`, [issueId]);
    res.status(201).json({ data: full.rows[0] });
  } catch (err) {
    console.error('Create issue error:', err);
    res.status(500).json({ error: 'Failed to create issue' });
  }
});

// ── Update ───────────────────────────────────────────────────────────────

router.patch('/:id', validate(updateSchema), async (req: AuthRequest, res: Response) => {
  try {
    const id = req.params.id as string;
    const body = req.body as z.infer<typeof updateSchema>;

    const existing = await query(`SELECT * FROM job_issues WHERE id = $1`, [id]);
    if (existing.rowCount === 0) return res.status(404).json({ error: 'Issue not found' });
    const before = existing.rows[0];

    const updates: string[] = [];
    const params: unknown[] = [id];
    const editable: Array<keyof z.infer<typeof updateSchema>> = [
      'status', 'category', 'severity', 'summary', 'description',
      'vehicle_id', 'driver_id', 'person_id', 'client_organisation_id',
      'hh_stock_item_id', 'hh_stock_item_name', 'barcode',
      'assigned_to', 'due_date', 'surface_on',
      'resolution_path', 'estimated_cost', 'actual_cost', 'excess_id',
    ];
    for (const key of editable) {
      if (key in body) {
        params.push((body as Record<string, unknown>)[key]);
        updates.push(`${key} = $${params.length}`);
      }
    }
    if (updates.length === 0) return res.status(400).json({ error: 'No updatable fields supplied' });

    // resolved_at clock — set when transitioning into a resolved state, clear on reopen.
    if ('status' in body && body.status) {
      if (isResolvedStatus(body.status) && !isResolvedStatus(before.status)) {
        updates.push(`resolved_at = NOW()`);
      } else if (!isResolvedStatus(body.status) && isResolvedStatus(before.status)) {
        updates.push(`resolved_at = NULL`);
      }
    }
    updates.push(`updated_at = NOW()`);

    await query(`UPDATE job_issues SET ${updates.join(', ')} WHERE id = $1`, params);

    // Event log — one entry per meaningful field change.
    if ('status' in body && body.status && body.status !== before.status) {
      await logEvent(id, req.user!.id, 'status_change', null, {
        from_status: before.status, to_status: body.status,
      });
    }
    if ('assigned_to' in body && body.assigned_to !== before.assigned_to) {
      await logEvent(id, req.user!.id, 'assignment', null, {
        from_assignee: before.assigned_to, to_assignee: body.assigned_to ?? null,
      });
    }
    if ('severity' in body && body.severity && body.severity !== before.severity) {
      await logEvent(id, req.user!.id, 'severity_change', null, {
        from: before.severity, to: body.severity,
      });
    }
    if ('due_date' in body && body.due_date !== (before.due_date && before.due_date.toISOString().split('T')[0])) {
      await logEvent(id, req.user!.id, 'due_date_change', null, {
        from: before.due_date, to: body.due_date ?? null,
      });
    }
    if (('estimated_cost' in body || 'actual_cost' in body)) {
      await logEvent(id, req.user!.id, 'cost_estimate', null, {
        estimated: body.estimated_cost ?? before.estimated_cost,
        actual: body.actual_cost ?? before.actual_cost,
      });
    }

    // Notifications on meaningful state changes. Watchers + assignee +
    // reporter get pinged when status flips, severity bumps, or
    // assignment changes — they're the people tracking this issue.
    const effectiveSeverity = body.severity || before.severity;
    if ('status' in body && body.status && body.status !== before.status) {
      const title = isResolvedStatus(body.status)
        ? `Issue resolved: ${before.summary?.slice(0, 80) || 'Issue'}`
        : `Issue status changed: ${body.status}`;
      await notifyIssueRecipients(
        id, req.user!.id, effectiveSeverity, title,
        `Was ${before.status} → now ${body.status}`,
        { includeReporter: true }
      );
    }
    if ('severity' in body && body.severity && body.severity !== before.severity) {
      await notifyIssueRecipients(
        id, req.user!.id, body.severity,
        `Issue severity changed: ${body.severity}`,
        `Was ${before.severity} → now ${body.severity}`,
        { includeReporter: true }
      );
    }
    if ('assigned_to' in body && body.assigned_to !== before.assigned_to && body.assigned_to) {
      // Notify the NEW assignee specifically — they may not have been
      // on the watchers/reporter list yet. notifyIssueRecipients reads
      // the post-update row so the new assignee is now in the set.
      await notifyIssueRecipients(
        id, req.user!.id, effectiveSeverity,
        `You've been assigned an issue: ${before.summary?.slice(0, 80) || 'Issue'}`,
        `Assigned by issue update`,
      );
    }

    const full = await query(`SELECT ${ISSUE_SELECT} ${ISSUE_JOIN} WHERE ji.id = $1`, [id]);
    res.json({ data: full.rows[0] });
  } catch (err) {
    console.error('Update issue error:', err);
    res.status(500).json({ error: 'Failed to update issue' });
  }
});

// ── Auto-create with dedup ───────────────────────────────────────────────
//
// For modules that automatically flag problems (PrepPage / CheckInPage
// / backline de-prep / etc.) where the same component can recur across
// sessions. Matches against (vehicle_id, component_key, status NOT IN
// terminal); if found, appends a `reflagged` event and returns the
// existing issue. If not, creates a new issue.
//
// Manual creates from a human-driven form continue to use POST /api/
// problems (no dedup) — staff intentionally creating a fresh issue
// shouldn't be silently merged into an existing one.

const autoCreateSchema = z.object({
  // Required for dedup
  vehicle_id: z.string().uuid(),
  component_key: z.string().min(1).max(100),
  // Classification
  category: z.enum(VALID_CATEGORIES),
  source_module: z.enum(VALID_SOURCES),
  severity: z.enum(VALID_SEVERITY).default('normal'),
  summary: z.string().trim().min(2).max(255),
  description: z.string().trim().max(10000).optional().nullable(),
  // Optional anchor extras
  job_id: z.string().uuid().optional().nullable(),
  // HH job number alternative for callers that don't know the OP UUID
  // (the check-in flow carries the HireHop number from book-out). Resolved
  // to job_id server-side; ignored when job_id is supplied directly.
  hirehop_job_number: z.number().int().optional().nullable(),
  driver_id: z.string().uuid().optional().nullable(),
  hh_stock_item_id: z.number().int().optional().nullable(),
  hh_stock_item_name: z.string().max(255).optional().nullable(),
  barcode: z.string().max(100).optional().nullable(),
  // Context for the reflag event when an existing issue matches
  reflag_context: z.object({
    source: z.string().max(50).optional(),    // e.g. 'prep', 'checkin'
    mileage: z.number().int().optional().nullable(),
    reported_by_name: z.string().max(200).optional().nullable(),
    note: z.string().max(1000).optional().nullable(),
  }).optional().nullable(),
  // R2 keys for damage photos already uploaded by the caller. Persisted
  // into job_issue_files so the issue carries its photos for later use
  // (e.g. the TTS360 repair-quote send path, which reads from
  // job_issue_files rather than knowing about the original event keys).
  // Idempotent: existing rows with the same r2_key on the same issue are
  // skipped, so a reflag with the same photo set doesn't duplicate.
  r2_photo_keys: z.array(z.string().max(500)).max(20).optional().nullable(),
});

router.post('/auto-create', validate(autoCreateSchema), async (req: AuthRequest, res: Response) => {
  try {
    const body = req.body as z.infer<typeof autoCreateSchema>;

    // Resolve job linkage. Callers can pass the OP UUID directly, or the
    // HH job number (the check-in flow only knows the HireHop number from
    // book-out). Without this, check-in damage issues were vehicle-only —
    // invisible on the Job Detail issues panel and the "has issues" filter.
    let jobId: string | null = body.job_id ?? null;
    let jobClientOrgId: string | null = null;
    if (!jobId && body.hirehop_job_number) {
      const jobLookup = await query(
        `SELECT id, client_id FROM jobs WHERE hh_job_number = $1 AND is_deleted = false LIMIT 1`,
        [body.hirehop_job_number]
      );
      if (jobLookup.rowCount && jobLookup.rowCount > 0) {
        jobId = jobLookup.rows[0].id;
        jobClientOrgId = jobLookup.rows[0].client_id ?? null;
      }
    } else if (jobId) {
      const jobLookup = await query(
        `SELECT client_id FROM jobs WHERE id = $1 AND is_deleted = false`,
        [jobId]
      );
      jobClientOrgId = jobLookup.rows[0]?.client_id ?? null;
    }

    // Look for an open issue matching (vehicle, component). Pick the most
    // recently updated if somehow more than one exists (shouldn't, but the
    // dedup index is partial not unique — favour latest).
    const existing = await query(
      `SELECT id, job_id FROM job_issues
       WHERE vehicle_id = $1
         AND component_key = $2
         AND status NOT IN ('resolved', 'written_off', 'cancelled')
       ORDER BY updated_at DESC
       LIMIT 1`,
      [body.vehicle_id, body.component_key]
    );

    if (existing.rowCount && existing.rowCount > 0) {
      // Append reflag event + bump updated_at.
      const issueId = existing.rows[0].id;
      const ctx = body.reflag_context ?? {};
      const eventBody = `Re-flagged${ctx.source ? ` during ${ctx.source}` : ''}${
        ctx.reported_by_name ? ` by ${ctx.reported_by_name}` : ''
      }${ctx.mileage ? ` at ${ctx.mileage} miles` : ''}${ctx.note ? `: ${ctx.note}` : ''}`;
      await logEvent(issueId, req.user!.id, 'reflagged', eventBody, {
        source_module: body.source_module,
        reflag_context: ctx,
        new_summary: body.summary,
      });
      // Backfill job linkage if the original issue pre-dates it (or was
      // created from a context that didn't know the job).
      if (jobId && !existing.rows[0].job_id) {
        await query(
          `UPDATE job_issues SET job_id = $2,
                  client_organisation_id = COALESCE(client_organisation_id, $3),
                  updated_at = NOW()
           WHERE id = $1`,
          [issueId, jobId, jobClientOrgId]
        );
      } else {
        await query(`UPDATE job_issues SET updated_at = NOW() WHERE id = $1`, [issueId]);
      }

      // Reflag pings watchers + assignee + reporter — the original
      // reporter cares that "their" issue is still happening.
      await notifyIssueRecipients(
        issueId, req.user!.id, body.severity,
        `Issue re-flagged: ${body.summary.slice(0, 80)}`,
        eventBody,
        { includeReporter: true }
      );

      // Persist any photos the caller already uploaded to R2 (e.g. the
      // check-in flow's damage-photo keys). Dedup'd by r2_key.
      if (body.r2_photo_keys?.length) {
        await attachExternalIssuePhotos(issueId, req.user!.id, body.r2_photo_keys);
      }

      // Direct email for vehicle damage/breakdown (gated internally on
      // vehicle anchor + category). After photo attach so the photo count
      // in the email is accurate.
      await sendVehicleIssueAlertEmail(issueId, 're-flagged');

      const full = await query(`SELECT ${ISSUE_SELECT} ${ISSUE_JOIN} WHERE ji.id = $1`, [issueId]);
      return res.status(200).json({ data: full.rows[0], was_existing: true });
    }

    // No match — fresh insert. Seed fleet-wide default watchers
    // (migration 082) so PrepPage / CheckInPage auto-creates reach
    // whoever's watching the fleet without staff having to add
    // watchers manually each time.
    const defaultWatchers = await getDefaultVehicleIssueWatchers();
    const insert = await query(
      `INSERT INTO job_issues (
         job_id, vehicle_id, driver_id, client_organisation_id,
         hh_stock_item_id, hh_stock_item_name, barcode, component_key,
         category, source_module, severity, summary, description,
         reported_by, watchers
       ) VALUES (
         $1, $2, $3, $4,
         $5, $6, $7, $8,
         $9, $10, $11, $12, $13,
         $14, $15::uuid[]
       )
       RETURNING id`,
      [
        jobId, body.vehicle_id, body.driver_id ?? null, jobClientOrgId,
        body.hh_stock_item_id ?? null, body.hh_stock_item_name ?? null, body.barcode ?? null, body.component_key,
        body.category, body.source_module, body.severity, body.summary, body.description ?? null,
        req.user!.id, defaultWatchers,
      ]
    );

    const issueId = insert.rows[0].id;
    await logEvent(issueId, req.user!.id, 'created', body.summary, {
      category: body.category, severity: body.severity, source_module: body.source_module,
      component_key: body.component_key,
    });

    await notifyIssueRecipients(
      issueId, req.user!.id, body.severity,
      `New issue: ${body.summary.slice(0, 80)}`,
      `${body.category} — flagged from ${body.source_module}`,
    );

    if (body.r2_photo_keys?.length) {
      await attachExternalIssuePhotos(issueId, req.user!.id, body.r2_photo_keys);
    }

    // Direct email for vehicle damage/breakdown (gated internally on
    // vehicle anchor + category). After photo attach so the photo count
    // in the email is accurate.
    await sendVehicleIssueAlertEmail(issueId, 'logged');

    // Activity Timeline echo so the issue shows on the job's timeline —
    // matches the manual POST / behaviour.
    if (jobId) {
      await query(
        `INSERT INTO interactions (type, content, job_id, created_by)
         VALUES ('note', $1, $2, $3)`,
        [
          `⚠️ Issue logged (${body.category}${body.severity === 'urgent' ? ', urgent' : ''}): ${body.summary}`,
          jobId, req.user!.id,
        ]
      );
    }

    const full = await query(`SELECT ${ISSUE_SELECT} ${ISSUE_JOIN} WHERE ji.id = $1`, [issueId]);
    res.status(201).json({ data: full.rows[0], was_existing: false });
  } catch (err) {
    console.error('Auto-create issue error:', err);
    res.status(500).json({ error: 'Failed to auto-create issue' });
  }
});

// ── Damage repair quote (TTS360) ─────────────────────────────────────────
//
// One email per call, covering one or more issues that share a single
// vehicle. Called from two places:
//   1. The check-in submit flow when staff tick "Also send damage photos
//      to TTS360 for repair quote" — bulk send across all damage issues
//      just created.
//   2. The IssueDetailPage "Send for repair quote" / "Resend" buttons
//      — single-issue send for the recovery / resend path.
//
// On success: each issue gets a `quote_requested` event in
// job_issue_events and (if not already past the quote stage) its
// status flips to `awaiting_quote`. See services/damage-repair-quote.ts.

const repairQuoteSchema = z.object({
  issue_ids: z.array(z.string().uuid()).min(1).max(20),
  notes_override: z.string().trim().max(5000).optional().nullable(),
});

router.post(
  '/send-repair-quote-request',
  validate(repairQuoteSchema),
  async (req: AuthRequest, res: Response) => {
    try {
      const { sendDamageRepairQuote } = await import('../services/damage-repair-quote');
      const body = req.body as z.infer<typeof repairQuoteSchema>;

      // Resolve display name for the "Sent by" metadata. Cheap join
      // through users → people; if it fails we fall back to the email.
      let sentByName: string | null = null;
      try {
        const nameResult = await query(
          `SELECT CONCAT(p.first_name, ' ', p.last_name) AS name, u.email
             FROM users u LEFT JOIN people p ON p.id = u.person_id WHERE u.id = $1`,
          [req.user!.id]
        );
        const row = nameResult.rows[0] as { name: string | null; email: string | null } | undefined;
        sentByName = row?.name?.trim() || row?.email || null;
      } catch {
        // ignore — sender attribution is nice-to-have, not essential.
      }

      const result = await sendDamageRepairQuote({
        issueIds: body.issue_ids,
        sentByUserId: req.user!.id,
        sentByName,
        notesOverride: body.notes_override ?? null,
      });

      if (!result.success) {
        return res.status(result.error?.includes('not configured') ? 503 : 502).json({
          error: result.error || 'Email send failed',
          recipients: result.recipients,
        });
      }

      res.json({
        success: true,
        email_log_id: result.email_log_id,
        recipients: result.recipients,
        issue_ids: result.issue_ids,
        photo_count: result.photo_count,
      });
    } catch (err) {
      console.error('Send damage repair quote error:', err);
      res.status(500).json({ error: 'Failed to send damage repair quote' });
    }
  }
);

// ── Files ────────────────────────────────────────────────────────────────
//
// Issue-level files (job_issue_files table). DISTINCT from interaction
// attachments — these are documents/photos attached to the issue itself
// (e.g. a contractor's quote PDF, an insurer letter, a damage photo
// taken outside a comment thread). Interaction attachments handle the
// "this comment has a photo" case.

router.post('/:id/files', upload.single('file'), async (req: AuthRequest, res: Response) => {
  try {
    if (!isR2Configured()) {
      return res.status(503).json({ error: 'File storage not configured' });
    }
    if (!req.file) {
      return res.status(400).json({ error: 'No file provided' });
    }

    const issueId = req.params.id as string;
    const exists = await query(`SELECT 1 FROM job_issues WHERE id = $1`, [issueId]);
    if (exists.rowCount === 0) return res.status(404).json({ error: 'Issue not found' });

    const ext = path.extname(req.file.originalname).toLowerCase();
    const fileId = uuid();
    const key = `files/job_issues/${issueId}/${fileId}${ext}`;

    await uploadToR2(key, req.file.buffer, req.file.mimetype);

    const comment = typeof req.body.comment === 'string' ? req.body.comment.trim() : null;
    const fileTypeOverride = typeof req.body.file_type === 'string' ? req.body.file_type.trim() : null;
    const fileType = fileTypeOverride || detectFileType(ext);

    const insert = await query(
      `INSERT INTO job_issue_files
         (id, issue_id, r2_key, filename, file_type, content_type, size_bytes, comment, uploaded_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING id, r2_key, filename, file_type, content_type, size_bytes, comment, uploaded_at`,
      [
        fileId, issueId, key, req.file.originalname, fileType,
        req.file.mimetype, req.file.size, comment, req.user!.id,
      ]
    );

    await logEvent(issueId, req.user!.id, 'file_added', req.file.originalname, {
      file_id: fileId, file_type: fileType, size_bytes: req.file.size,
    });
    await query(`UPDATE job_issues SET updated_at = NOW() WHERE id = $1`, [issueId]);

    res.status(201).json({ data: insert.rows[0] });
  } catch (err) {
    console.error('Issue file upload error:', err);
    res.status(500).json({ error: 'Failed to upload file' });
  }
});

router.delete('/:id/files/:fileId', async (req: AuthRequest, res: Response) => {
  try {
    const issueId = req.params.id as string;
    const fileId = req.params.fileId as string;

    const row = await query(
      `SELECT r2_key, filename FROM job_issue_files WHERE id = $1 AND issue_id = $2`,
      [fileId, issueId]
    );
    if (row.rowCount === 0) return res.status(404).json({ error: 'File not found' });

    await deleteFromR2(row.rows[0].r2_key).catch(err => {
      // Best-effort R2 cleanup. If R2 fails, log but still remove the DB row
      // — the alternative leaves an orphan row pointing at a key that may
      // or may not exist, which is worse.
      console.error('R2 delete failed (continuing):', err);
    });

    await query(`DELETE FROM job_issue_files WHERE id = $1`, [fileId]);

    await logEvent(issueId, req.user!.id, 'file_removed', row.rows[0].filename, {
      file_id: fileId,
    });
    await query(`UPDATE job_issues SET updated_at = NOW() WHERE id = $1`, [issueId]);

    res.json({ ok: true });
  } catch (err) {
    console.error('Issue file delete error:', err);
    res.status(500).json({ error: 'Failed to delete file' });
  }
});

// ── Comment ──────────────────────────────────────────────────────────────

router.post('/:id/comments', validate(commentSchema), async (req: AuthRequest, res: Response) => {
  try {
    const id = req.params.id as string;
    const { body } = req.body as { body: string };
    const exists = await query(`SELECT 1 FROM job_issues WHERE id = $1`, [id]);
    if (exists.rowCount === 0) return res.status(404).json({ error: 'Issue not found' });

    await logEvent(id, req.user!.id, 'comment', body);
    // Touch updated_at so the issue sorts correctly on the global page.
    await query(`UPDATE job_issues SET updated_at = NOW() WHERE id = $1`, [id]);

    res.status(201).json({ ok: true });
  } catch (err) {
    console.error('Add comment error:', err);
    res.status(500).json({ error: 'Failed to add comment' });
  }
});

// ── Watch / unwatch ──────────────────────────────────────────────────────

router.post('/:id/watch', async (req: AuthRequest, res: Response) => {
  try {
    const id = req.params.id as string;
    await query(
      `UPDATE job_issues SET watchers = array_append(watchers, $2)
       WHERE id = $1 AND NOT (watchers && ARRAY[$2]::uuid[])`,
      [id, req.user!.id]
    );
    res.json({ ok: true });
  } catch (err) {
    console.error('Watch error:', err);
    res.status(500).json({ error: 'Failed to watch' });
  }
});

router.post('/:id/unwatch', async (req: AuthRequest, res: Response) => {
  try {
    const id = req.params.id as string;
    await query(
      `UPDATE job_issues SET watchers = array_remove(watchers, $2) WHERE id = $1`,
      [id, req.user!.id]
    );
    res.json({ ok: true });
  } catch (err) {
    console.error('Unwatch error:', err);
    res.status(500).json({ error: 'Failed to unwatch' });
  }
});

// ── Summary (dashboard NeedsAttention bucket) ────────────────────────────
// MUST be registered before the `/:id` route, otherwise Express matches
// `GET /api/problems/summary` against `/:id` and tries to UUID-cast 'summary'.

router.get('/summary', async (_req: AuthRequest, res: Response) => {
  try {
    const result = await query(
      `SELECT
         COUNT(*) FILTER (WHERE ji.status NOT IN ('resolved', 'written_off', 'cancelled')) AS open_total,
         COUNT(*) FILTER (WHERE ji.status NOT IN ('resolved', 'written_off', 'cancelled')
                            AND ji.severity = 'urgent') AS urgent_total,
         COUNT(*) FILTER (WHERE ji.status NOT IN ('resolved', 'written_off', 'cancelled')
                            AND ji.category = 'damaged') AS damaged_open,
         COUNT(*) FILTER (WHERE ji.status NOT IN ('resolved', 'written_off', 'cancelled')
                            AND ji.category = 'missing') AS missing_open,
         COUNT(*) FILTER (WHERE ji.status NOT IN ('resolved', 'written_off', 'cancelled')
                            AND ji.category = 'broken') AS broken_open,
         COUNT(*) FILTER (WHERE ji.status NOT IN ('resolved', 'written_off', 'cancelled')
                            AND ji.category = 'dispute') AS dispute_open,
         COUNT(*) FILTER (WHERE ji.status NOT IN ('resolved', 'written_off', 'cancelled')
                            AND ji.category = 'breakdown') AS breakdown_open
       FROM job_issues ji`
    );
    const top = await query(
      `SELECT ji.id, ji.job_id, ji.category, ji.severity, ji.summary, ji.created_at,
              j.hh_job_number, j.job_name, j.client_name
       FROM job_issues ji
       LEFT JOIN jobs j ON j.id = ji.job_id
       WHERE ji.status NOT IN ('resolved', 'written_off', 'cancelled')
       ORDER BY
         CASE WHEN ji.severity = 'urgent' THEN 0 ELSE 1 END,
         ji.created_at DESC
       LIMIT 5`
    );
    res.json({ data: { ...result.rows[0], items: top.rows } });
  } catch (err) {
    console.error('Issue summary error:', err);
    res.status(500).json({ error: 'Failed to fetch summary' });
  }
});

// ── Get one (with timeline) ──────────────────────────────────────────────

router.get('/:id', async (req: AuthRequest, res: Response) => {
  try {
    const id = req.params.id as string;
    const issueResult = await query(`SELECT ${ISSUE_SELECT} ${ISSUE_JOIN} WHERE ji.id = $1`, [id]);
    if (issueResult.rowCount === 0) return res.status(404).json({ error: 'Issue not found' });

    const eventsResult = await query(
      `SELECT e.id, e.event_type, e.body, e.metadata, e.created_at,
              CONCAT(p.first_name, ' ', p.last_name) AS created_by_name
       FROM job_issue_events e
       LEFT JOIN users u ON u.id = e.created_by
       LEFT JOIN people p ON p.id = u.person_id
       WHERE e.issue_id = $1
       ORDER BY e.created_at ASC`,
      [id]
    );

    const filesResult = await query(
      `SELECT f.id, f.r2_key, f.filename, f.file_type, f.content_type, f.size_bytes, f.comment, f.uploaded_at,
              CONCAT(p.first_name, ' ', p.last_name) AS uploaded_by_name
       FROM job_issue_files f
       LEFT JOIN users u ON u.id = f.uploaded_by
       LEFT JOIN people p ON p.id = u.person_id
       WHERE f.issue_id = $1
       ORDER BY f.uploaded_at DESC`,
      [id]
    );

    // Comments (interactions filtered to this issue). The legacy
    // `events` array carries TYPED audit transitions (created /
    // status_change / etc.); comments now live in `interactions` with
    // issue_id set — repointed from job_issue_events.event_type='comment'
    // by Phase F. IssueDetailPage merges both streams at render time.
    const commentsResult = await query(
      `SELECT i.id, i.content, i.created_at, i.created_by, i.parent_interaction_id,
              i.mentioned_user_ids, i.files, i.reactions,
              CONCAT(p.first_name, ' ', p.last_name) AS created_by_name,
              u.email AS created_by_email
       FROM interactions i
       LEFT JOIN users u ON u.id = i.created_by
       LEFT JOIN people p ON p.id = u.person_id
       WHERE i.issue_id = $1
       ORDER BY i.created_at ASC`,
      [id]
    );

    res.json({
      data: {
        ...issueResult.rows[0],
        events: eventsResult.rows,
        files: filesResult.rows,
        comments: commentsResult.rows,
      },
    });
  } catch (err) {
    console.error('Get issue error:', err);
    res.status(500).json({ error: 'Failed to fetch issue' });
  }
});

// ── List per job ─────────────────────────────────────────────────────────

router.get('/job/:jobId', async (req: AuthRequest, res: Response) => {
  try {
    const { jobId } = req.params;
    const result = await query(
      `SELECT ${ISSUE_SELECT} ${ISSUE_JOIN}
       WHERE ji.job_id = $1
       ORDER BY
         CASE WHEN ji.status IN ('resolved', 'written_off', 'cancelled') THEN 1 ELSE 0 END,
         CASE WHEN ji.severity = 'urgent' THEN 0 WHEN ji.severity = 'normal' THEN 1 ELSE 2 END,
         ji.created_at DESC`,
      [jobId]
    );
    res.json({ data: result.rows });
  } catch (err) {
    console.error('List job issues error:', err);
    res.status(500).json({ error: 'Failed to fetch issues' });
  }
});

// ── List per anchor — vehicle / person / org ─────────────────────────────

router.get('/by-vehicle/:vehicleId', async (req: AuthRequest, res: Response) => {
  try {
    const { vehicleId } = req.params;
    const result = await query(
      `SELECT ${ISSUE_SELECT} ${ISSUE_JOIN}
       WHERE ji.vehicle_id = $1
       ORDER BY ji.created_at DESC`,
      [vehicleId]
    );
    res.json({ data: result.rows });
  } catch (err) {
    console.error('List vehicle issues error:', err);
    res.status(500).json({ error: 'Failed to fetch issues' });
  }
});

router.get('/by-organisation/:orgId', async (req: AuthRequest, res: Response) => {
  try {
    const { orgId } = req.params;
    const result = await query(
      `SELECT ${ISSUE_SELECT} ${ISSUE_JOIN}
       WHERE ji.client_organisation_id = $1
       ORDER BY ji.created_at DESC`,
      [orgId]
    );
    res.json({ data: result.rows });
  } catch (err) {
    console.error('List org issues error:', err);
    res.status(500).json({ error: 'Failed to fetch issues' });
  }
});

router.get('/by-person/:personId', async (req: AuthRequest, res: Response) => {
  try {
    const { personId } = req.params;
    const result = await query(
      `SELECT ${ISSUE_SELECT} ${ISSUE_JOIN}
       WHERE ji.person_id = $1 OR ji.driver_id IN (
         SELECT id FROM drivers WHERE person_id = $1
       )
       ORDER BY ji.created_at DESC`,
      [personId]
    );
    res.json({ data: result.rows });
  } catch (err) {
    console.error('List person issues error:', err);
    res.status(500).json({ error: 'Failed to fetch issues' });
  }
});

// ── Global list (Operations > Problems page) ─────────────────────────────

router.get('/', async (req: AuthRequest, res: Response) => {
  try {
    const { status, category, severity, source, search, assigned_to, page = '1', limit = '50' } = req.query;
    const offset = (parseInt(page as string) - 1) * parseInt(limit as string);

    const conditions: string[] = [];
    const params: unknown[] = [];

    const statusParam = (status as string) || 'open';
    if (statusParam === 'open') {
      conditions.push(`ji.status NOT IN ('resolved', 'written_off', 'cancelled')`);
    } else if (statusParam === 'resolved') {
      conditions.push(`ji.status IN ('resolved', 'written_off')`);
    } else if (statusParam !== 'all') {
      params.push(statusParam);
      conditions.push(`ji.status = $${params.length}`);
    }
    if (category) {
      params.push(category);
      conditions.push(`ji.category = $${params.length}`);
    }
    if (severity) {
      params.push(severity);
      conditions.push(`ji.severity = $${params.length}`);
    }
    if (source) {
      params.push(source);
      conditions.push(`ji.source_module = $${params.length}`);
    }
    if (assigned_to) {
      if (assigned_to === 'unassigned') {
        conditions.push(`ji.assigned_to IS NULL`);
      } else {
        params.push(assigned_to);
        conditions.push(`ji.assigned_to = $${params.length}`);
      }
    }
    if (search && (search as string).trim()) {
      params.push(`%${(search as string).trim()}%`);
      conditions.push(
        `(ji.summary ILIKE $${params.length} OR ji.description ILIKE $${params.length}
          OR j.job_name ILIKE $${params.length} OR j.client_name ILIKE $${params.length}
          OR fv.reg ILIKE $${params.length} OR ji.barcode ILIKE $${params.length}
          OR CAST(j.hh_job_number AS TEXT) ILIKE $${params.length})`
      );
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    const countResult = await query(
      `SELECT COUNT(*) ${ISSUE_JOIN} ${where}`,
      params
    );

    params.push(parseInt(limit as string));
    params.push(offset);
    const result = await query(
      `SELECT ${ISSUE_SELECT} ${ISSUE_JOIN} ${where}
       ORDER BY
         CASE WHEN ji.status IN ('resolved', 'written_off', 'cancelled') THEN 1 ELSE 0 END,
         CASE WHEN ji.severity = 'urgent' THEN 0 WHEN ji.severity = 'normal' THEN 1 ELSE 2 END,
         ji.created_at DESC
       LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params
    );

    res.json({
      data: result.rows,
      pagination: {
        page: parseInt(page as string),
        limit: parseInt(limit as string),
        total: parseInt(countResult.rows[0].count),
        totalPages: Math.ceil(parseInt(countResult.rows[0].count) / parseInt(limit as string)),
      },
    });
  } catch (err) {
    console.error('List issues error:', err);
    res.status(500).json({ error: 'Failed to fetch issues' });
  }
});

export default router;
