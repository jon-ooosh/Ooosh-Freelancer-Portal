/**
 * Job Problems / Issues Register
 *
 * Cross-module register for "things that need a human to chase" on a job —
 * vehicle damage, missing items, breakdowns, client disputes. NOT the same
 * as routes/issues.ts which is the OP platform bug tracker (different
 * register, different audience).
 *
 * Storage: rides on job_requirements with requirement_type='issue'. We get
 * chase dates, notes, status workflow, activity log, dashboard surfacing
 * for free (see migration 074). Public surface lives at /api/problems/* so
 * if the storage moves to a dedicated job_problems table later — for cross-
 * job linkage, equipment FK, structured event history — callers don't need
 * to change.
 *
 * Categories (validated server-side):
 *   damaged   — physical damage, follows existing damage_review pattern
 *   missing   — items missing/lost
 *   broken    — mechanical / electrical fault
 *   dispute   — client dispute (price, scope, etc.)
 *   other     — catch-all
 *
 * Status (single text column on job_requirements):
 *   not_started ≡ "Open"
 *   in_progress ≡ "Working on it"
 *   done        ≡ "Resolved"
 *   blocked     ≡ "Blocked / Awaiting"
 *   cancelled   ≡ "Cancelled / withdrawn"
 *
 * Severity:
 *   normal | urgent — urgent bubbles to the top of the dashboard bucket
 *   and triggers immediate notification (when the notif scheduler picks
 *   the right mapping — for now severity is informational only).
 */
import { Router, Response } from 'express';
import { z } from 'zod';
import { query } from '../config/database';
import { authenticate, authorize, AuthRequest, STAFF_ROLES } from '../middleware/auth';
import { validate } from '../middleware/validate';

const router = Router();
router.use(authenticate);
// Any staff can log/view/edit problems — no narrower RBAC.
router.use(authorize(...STAFF_ROLES));

const VALID_CATEGORIES = ['damaged', 'missing', 'broken', 'dispute', 'other'] as const;
const VALID_STATUSES = ['not_started', 'in_progress', 'done', 'blocked', 'cancelled'] as const;
const VALID_SEVERITY = ['normal', 'urgent'] as const;
const VALID_SOURCES = ['vehicle', 'backline', 'transport', 'manual'] as const;

const createSchema = z.object({
  job_id: z.string().uuid(),
  category: z.enum(VALID_CATEGORIES),
  summary: z.string().trim().min(2).max(200),
  notes: z.string().trim().max(5000).optional().nullable(),
  severity: z.enum(VALID_SEVERITY).default('normal'),
  source_module: z.enum(VALID_SOURCES).default('manual'),
  due_date: z.string().optional().nullable(),
});

const updateSchema = z.object({
  status: z.enum(VALID_STATUSES).optional(),
  category: z.enum(VALID_CATEGORIES).optional(),
  summary: z.string().trim().min(2).max(200).optional(),
  notes: z.string().trim().max(5000).optional().nullable(),
  severity: z.enum(VALID_SEVERITY).optional(),
  due_date: z.string().optional().nullable(),
});

// ── Create ───────────────────────────────────────────────────────────────

router.post('/', validate(createSchema), async (req: AuthRequest, res: Response) => {
  try {
    const { job_id, category, summary, notes, severity, source_module, due_date } = req.body;

    // Verify the job exists.
    const job = await query('SELECT id, hh_job_number FROM jobs WHERE id = $1 AND is_deleted = false', [job_id]);
    if (job.rowCount === 0) {
      return res.status(404).json({ error: 'Job not found' });
    }

    const result = await query(
      `INSERT INTO job_requirements (
         job_id, requirement_type, phase, status, custom_label, notes,
         issue_category, severity, source_module, due_date,
         is_auto, source, created_by
       ) VALUES (
         $1, 'issue', 'post_hire', 'not_started', $2, $3,
         $4, $5, $6, $7,
         false, 'manual', $8
       )
       RETURNING id, job_id, status, issue_category, severity, custom_label, notes,
                 source_module, due_date, created_at`,
      [job_id, summary, notes || null, category, severity, source_module, due_date || null, req.user!.id]
    );

    // Log to activity timeline so the issue shows up on the job's history.
    await query(
      `INSERT INTO interactions (type, content, job_id, created_by)
       VALUES ('note', $1, $2, $3)`,
      [`⚠️ Issue logged (${category}${severity === 'urgent' ? ', urgent' : ''}): ${summary}`, job_id, req.user!.id]
    );

    res.status(201).json({ data: result.rows[0] });
  } catch (err) {
    console.error('Create problem error:', err);
    res.status(500).json({ error: 'Failed to create problem' });
  }
});

// ── Update ───────────────────────────────────────────────────────────────

router.patch('/:id', validate(updateSchema), async (req: AuthRequest, res: Response) => {
  try {
    const { id } = req.params;
    const updates: string[] = [];
    const params: unknown[] = [id];
    const fieldMap: Record<string, string> = {
      status: 'status',
      category: 'issue_category',
      summary: 'custom_label',
      notes: 'notes',
      severity: 'severity',
      due_date: 'due_date',
    };
    for (const [key, col] of Object.entries(fieldMap)) {
      if (key in req.body) {
        params.push(req.body[key]);
        updates.push(`${col} = $${params.length}`);
      }
    }
    if (updates.length === 0) {
      return res.status(400).json({ error: 'No updatable fields supplied' });
    }
    updates.push(`updated_at = NOW()`);

    const result = await query(
      `UPDATE job_requirements SET ${updates.join(', ')}
       WHERE id = $1 AND requirement_type = 'issue'
       RETURNING id, job_id, status, issue_category, severity, custom_label, notes,
                 source_module, due_date, updated_at`,
      params
    );
    if (result.rowCount === 0) {
      return res.status(404).json({ error: 'Issue not found' });
    }

    // Log status changes to the activity timeline so the trail survives.
    if ('status' in req.body) {
      await query(
        `INSERT INTO interactions (type, content, job_id, created_by)
         VALUES ('note', $1, $2, $3)`,
        [`⚠️ Issue status → ${req.body.status}`, result.rows[0].job_id, req.user!.id]
      );
    }
    res.json({ data: result.rows[0] });
  } catch (err) {
    console.error('Update problem error:', err);
    res.status(500).json({ error: 'Failed to update problem' });
  }
});

// ── List per job ─────────────────────────────────────────────────────────

router.get('/job/:jobId', async (req: AuthRequest, res: Response) => {
  try {
    const { jobId } = req.params;
    const result = await query(
      `SELECT jr.id, jr.job_id, jr.status, jr.issue_category, jr.severity,
              jr.custom_label AS summary, jr.notes, jr.source_module,
              jr.due_date, jr.created_at, jr.updated_at,
              p.first_name || ' ' || p.last_name AS created_by_name
       FROM job_requirements jr
       LEFT JOIN users u ON u.id = jr.created_by
       LEFT JOIN people p ON p.id = u.person_id
       WHERE jr.job_id = $1 AND jr.requirement_type = 'issue'
       ORDER BY
         CASE WHEN jr.status IN ('done', 'cancelled') THEN 1 ELSE 0 END,
         CASE WHEN jr.severity = 'urgent' THEN 0 ELSE 1 END,
         jr.created_at DESC`,
      [jobId]
    );
    res.json({ data: result.rows });
  } catch (err) {
    console.error('List problems for job error:', err);
    res.status(500).json({ error: 'Failed to fetch problems' });
  }
});

// ── List global ──────────────────────────────────────────────────────────

router.get('/', async (req: AuthRequest, res: Response) => {
  try {
    const { status, category, severity, source, search, page = '1', limit = '50' } = req.query;
    const offset = (parseInt(page as string) - 1) * parseInt(limit as string);

    const conditions: string[] = [`jr.requirement_type = 'issue'`];
    const params: unknown[] = [];

    // 'open' is the default; client can pass status=open|resolved|all|<exact>
    const statusParam = (status as string) || 'open';
    if (statusParam === 'open') {
      conditions.push(`jr.status NOT IN ('done', 'cancelled')`);
    } else if (statusParam === 'resolved') {
      conditions.push(`jr.status = 'done'`);
    } else if (statusParam !== 'all') {
      params.push(statusParam);
      conditions.push(`jr.status = $${params.length}`);
    }
    if (category) {
      params.push(category);
      conditions.push(`jr.issue_category = $${params.length}`);
    }
    if (severity) {
      params.push(severity);
      conditions.push(`jr.severity = $${params.length}`);
    }
    if (source) {
      params.push(source);
      conditions.push(`jr.source_module = $${params.length}`);
    }
    if (search && (search as string).trim()) {
      params.push(`%${(search as string).trim()}%`);
      conditions.push(
        `(jr.custom_label ILIKE $${params.length} OR jr.notes ILIKE $${params.length}
          OR j.job_name ILIKE $${params.length} OR j.client_name ILIKE $${params.length}
          OR CAST(j.hh_job_number AS TEXT) ILIKE $${params.length})`
      );
    }

    const where = conditions.join(' AND ');

    const countResult = await query(
      `SELECT COUNT(*) FROM job_requirements jr
       LEFT JOIN jobs j ON j.id = jr.job_id
       WHERE ${where}`,
      params
    );

    params.push(parseInt(limit as string));
    params.push(offset);
    const result = await query(
      `SELECT jr.id, jr.job_id, jr.status, jr.issue_category, jr.severity,
              jr.custom_label AS summary, jr.notes, jr.source_module,
              jr.due_date, jr.created_at, jr.updated_at,
              j.hh_job_number, j.job_name, j.client_name, j.company_name,
              j.pipeline_status, j.status AS hh_status
       FROM job_requirements jr
       LEFT JOIN jobs j ON j.id = jr.job_id
       WHERE ${where}
       ORDER BY
         CASE WHEN jr.status IN ('done', 'cancelled') THEN 1 ELSE 0 END,
         CASE WHEN jr.severity = 'urgent' THEN 0 ELSE 1 END,
         jr.created_at DESC
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
    console.error('List problems error:', err);
    res.status(500).json({ error: 'Failed to fetch problems' });
  }
});

// ── Summary (for dashboard NeedsAttention bucket + headline counts) ──────

router.get('/summary', async (_req: AuthRequest, res: Response) => {
  try {
    const result = await query(
      `SELECT
         COUNT(*) FILTER (WHERE jr.status NOT IN ('done', 'cancelled')) AS open_total,
         COUNT(*) FILTER (WHERE jr.status NOT IN ('done', 'cancelled') AND jr.severity = 'urgent') AS urgent_total,
         COUNT(*) FILTER (WHERE jr.status NOT IN ('done', 'cancelled') AND jr.issue_category = 'damaged') AS damaged_open,
         COUNT(*) FILTER (WHERE jr.status NOT IN ('done', 'cancelled') AND jr.issue_category = 'missing') AS missing_open,
         COUNT(*) FILTER (WHERE jr.status NOT IN ('done', 'cancelled') AND jr.issue_category = 'broken') AS broken_open,
         COUNT(*) FILTER (WHERE jr.status NOT IN ('done', 'cancelled') AND jr.issue_category = 'dispute') AS dispute_open
       FROM job_requirements jr
       WHERE jr.requirement_type = 'issue'`
    );
    const top = await query(
      `SELECT jr.id, jr.job_id, jr.issue_category, jr.severity,
              jr.custom_label AS summary, jr.created_at,
              j.hh_job_number, j.job_name, j.client_name
       FROM job_requirements jr
       LEFT JOIN jobs j ON j.id = jr.job_id
       WHERE jr.requirement_type = 'issue'
         AND jr.status NOT IN ('done', 'cancelled')
       ORDER BY
         CASE WHEN jr.severity = 'urgent' THEN 0 ELSE 1 END,
         jr.created_at DESC
       LIMIT 5`
    );
    res.json({ data: { ...result.rows[0], items: top.rows } });
  } catch (err) {
    console.error('Problem summary error:', err);
    res.status(500).json({ error: 'Failed to fetch summary' });
  }
});

export default router;
