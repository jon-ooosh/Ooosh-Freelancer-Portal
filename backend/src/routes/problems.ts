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
import { z } from 'zod';
import { query } from '../config/database';
import { authenticate, authorize, AuthRequest, STAFF_ROLES } from '../middleware/auth';
import { validate } from '../middleware/validate';

const router = Router();
router.use(authenticate);
router.use(authorize(...STAFF_ROLES));

const VALID_CATEGORIES = ['damaged', 'missing', 'broken', 'dispute', 'breakdown', 'other'] as const;
const VALID_STATUSES = ['open', 'investigating', 'awaiting_quote', 'quoted', 'actioned', 'resolved', 'written_off', 'cancelled'] as const;
const VALID_SEVERITY = ['low', 'normal', 'urgent'] as const;
const VALID_SOURCES = ['manual', 'vehicle', 'backline', 'transport', 'client', 'driver'] as const;
const VALID_RESOLUTION = ['claim_excess', 'charge_client', 'write_off', 'replaced', 'other'] as const;
const VALID_SURFACES = ['vehicle_check_in', 'next_hire', 'next_book_out', 'job_close_out'] as const;

const createSchema = z.object({
  job_id: z.string().uuid(),
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
  // Behaviour
  due_date: z.string().optional().nullable(),
  surface_on: z.enum(VALID_SURFACES).optional().nullable(),
  watchers: z.array(z.string().uuid()).optional(),
  assigned_to: z.string().uuid().optional().nullable(),
});

const updateSchema = z.object({
  status: z.enum(VALID_STATUSES).optional(),
  category: z.enum(VALID_CATEGORIES).optional(),
  severity: z.enum(VALID_SEVERITY).optional(),
  summary: z.string().trim().min(2).max(255).optional(),
  description: z.string().trim().max(10000).optional().nullable(),
  // Anchors editable
  vehicle_id: z.string().uuid().optional().nullable(),
  driver_id: z.string().uuid().optional().nullable(),
  person_id: z.string().uuid().optional().nullable(),
  client_organisation_id: z.string().uuid().optional().nullable(),
  hh_stock_item_id: z.number().int().optional().nullable(),
  hh_stock_item_name: z.string().max(255).optional().nullable(),
  barcode: z.string().max(100).optional().nullable(),
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

async function logEvent(
  issueId: string, userId: string, eventType: string,
  body: string | null, metadata: Record<string, unknown> | null = null,
) {
  await query(
    `INSERT INTO job_issue_events (issue_id, event_type, body, metadata, created_by)
     VALUES ($1, $2, $3, $4::jsonb, $5)`,
    [issueId, eventType, body, metadata ? JSON.stringify(metadata) : null, userId]
  );
}

const ISSUE_SELECT = `
  ji.id, ji.job_id, ji.vehicle_id, ji.driver_id, ji.person_id,
  ji.client_organisation_id, ji.hh_stock_item_id, ji.hh_stock_item_name, ji.barcode,
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

    const job = await query(
      `SELECT id, client_id FROM jobs WHERE id = $1 AND is_deleted = false`,
      [body.job_id]
    );
    if (job.rowCount === 0) return res.status(404).json({ error: 'Job not found' });

    // Default the client org to the job's client_id if the caller didn't supply one.
    const clientOrgId = body.client_organisation_id ?? job.rows[0].client_id ?? null;
    const watchers = body.watchers ?? [];

    const insert = await query(
      `INSERT INTO job_issues (
         job_id, vehicle_id, driver_id, person_id, client_organisation_id,
         hh_stock_item_id, hh_stock_item_name, barcode,
         category, source_module, severity, summary, description,
         reported_by, assigned_to, watchers, due_date, surface_on
       ) VALUES (
         $1, $2, $3, $4, $5,
         $6, $7, $8,
         $9, $10, $11, $12, $13,
         $14, $15, $16, $17, $18
       )
       RETURNING id`,
      [
        body.job_id, body.vehicle_id ?? null, body.driver_id ?? null, body.person_id ?? null, clientOrgId,
        body.hh_stock_item_id ?? null, body.hh_stock_item_name ?? null, body.barcode ?? null,
        body.category, body.source_module, body.severity, body.summary, body.description ?? null,
        req.user!.id, body.assigned_to ?? null, watchers, body.due_date ?? null, body.surface_on ?? null,
      ]
    );

    const issueId = insert.rows[0].id;

    await logEvent(issueId, req.user!.id, 'created', body.summary, {
      category: body.category, severity: body.severity, source_module: body.source_module,
    });

    // Activity Timeline echo so the issue shows on the job's timeline.
    await query(
      `INSERT INTO interactions (type, content, job_id, created_by)
       VALUES ('note', $1, $2, $3)`,
      [
        `⚠️ Issue logged (${body.category}${body.severity === 'urgent' ? ', urgent' : ''}): ${body.summary}`,
        body.job_id, req.user!.id,
      ]
    );

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

    const full = await query(`SELECT ${ISSUE_SELECT} ${ISSUE_JOIN} WHERE ji.id = $1`, [id]);
    res.json({ data: full.rows[0] });
  } catch (err) {
    console.error('Update issue error:', err);
    res.status(500).json({ error: 'Failed to update issue' });
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
      `SELECT id, r2_key, filename, file_type, content_type, size_bytes, comment, uploaded_at,
              CONCAT(p.first_name, ' ', p.last_name) AS uploaded_by_name
       FROM job_issue_files f
       LEFT JOIN users u ON u.id = f.uploaded_by
       LEFT JOIN people p ON p.id = u.person_id
       WHERE f.issue_id = $1
       ORDER BY f.uploaded_at DESC`,
      [id]
    );

    res.json({
      data: {
        ...issueResult.rows[0],
        events: eventsResult.rows,
        files: filesResult.rows,
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

// ── Summary (dashboard NeedsAttention bucket) ────────────────────────────

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

export default router;
