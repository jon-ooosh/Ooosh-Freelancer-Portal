/**
 * Platform Issues Tracker
 *
 * Lightweight internal tracker under Operations → Issues. Anyone logged in
 * can log a bug, feature request, question, or see the backlog. Admins and
 * managers triage status.
 *
 * On issue creation we fire an email alert to jon@oooshtours.co.uk so
 * issues don't get lost during the go-live period.
 */
import { Router, Response } from 'express';
import { z } from 'zod';
import { query } from '../config/database';
import { authenticate, authorize, AuthRequest } from '../middleware/auth';
import { emailService } from '../services/email-service';

const router = Router();
router.use(authenticate);

const ALERT_RECIPIENT = 'jon@oooshtours.co.uk';

// Staff roles (everyone who isn't a freelancer) — the whole team needs to
// log and see issues during bedding-in.
const STAFF_ROLES = ['admin', 'manager', 'staff', 'general_assistant', 'weekend_manager'] as const;

// Only admin/manager can change workflow fields
const TRIAGE_ROLES = ['admin', 'manager'] as const;

// ── Helpers ─────────────────────────────────────────────────────────────────

function categoryLabel(c: string): string {
  return {
    bug: 'Bug',
    feature_request: 'Feature request',
    question: 'Question',
    roadmap: 'Roadmap',
    other: 'Other',
  }[c] || c;
}

function severityLabel(s: string): string {
  return {
    low: 'Low',
    normal: 'Normal',
    high: 'High',
    urgent: 'URGENT',
  }[s] || s;
}

// ── Schemas ─────────────────────────────────────────────────────────────────

const createSchema = z.object({
  title: z.string().trim().min(3).max(300),
  description: z.string().trim().max(10000).optional().nullable(),
  category: z.enum(['bug', 'feature_request', 'question', 'roadmap', 'other']).optional(),
  severity: z.enum(['low', 'normal', 'high', 'urgent']).optional(),
  area: z.string().trim().max(50).optional().nullable(),
  page_url: z.string().trim().max(1000).optional().nullable(),
});

const updateSchema = z.object({
  title: z.string().trim().min(3).max(300).optional(),
  description: z.string().trim().max(10000).optional().nullable(),
  category: z.enum(['bug', 'feature_request', 'question', 'roadmap', 'other']).optional(),
  severity: z.enum(['low', 'normal', 'high', 'urgent']).optional(),
  status: z.enum(['new', 'seen', 'in_progress', 'done', 'deferred', 'wont_fix']).optional(),
  area: z.string().trim().max(50).optional().nullable(),
  page_url: z.string().trim().max(1000).optional().nullable(),
  assigned_to: z.string().uuid().optional().nullable(),
  resolution_notes: z.string().trim().max(10000).optional().nullable(),
});

const commentSchema = z.object({
  body: z.string().trim().min(1).max(10000),
});

// ── List ────────────────────────────────────────────────────────────────────

router.get('/', async (req: AuthRequest, res: Response) => {
  try {
    const { status, category, area, search, mine, limit = '200' } = req.query;

    const conditions: string[] = [];
    const params: unknown[] = [];

    if (status && typeof status === 'string') {
      // Comma-separated list of statuses
      const statuses = status.split(',').map(s => s.trim()).filter(Boolean);
      if (statuses.length) {
        params.push(statuses);
        conditions.push(`i.status = ANY($${params.length})`);
      }
    }

    if (category && typeof category === 'string') {
      params.push(category);
      conditions.push(`i.category = $${params.length}`);
    }

    if (area && typeof area === 'string') {
      params.push(area);
      conditions.push(`i.area = $${params.length}`);
    }

    if (search && typeof search === 'string') {
      params.push(`%${search}%`);
      conditions.push(`(i.title ILIKE $${params.length} OR i.description ILIKE $${params.length})`);
    }

    if (mine === 'true' && req.user) {
      params.push(req.user.id);
      conditions.push(`i.created_by = $${params.length}`);
    }

    const whereClause = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

    params.push(Math.min(parseInt(limit as string) || 200, 500));

    const sql = `
      SELECT
        i.*,
        reporter.email  AS reporter_email,
        reporter.name   AS reporter_name,
        assignee.email  AS assignee_email,
        assignee.name   AS assignee_name,
        (SELECT COUNT(*) FROM platform_issue_comments c WHERE c.issue_id = i.id) AS comment_count
      FROM platform_issues i
      LEFT JOIN users reporter ON reporter.id = i.created_by
      LEFT JOIN users assignee ON assignee.id = i.assigned_to
      ${whereClause}
      ORDER BY
        CASE i.status
          WHEN 'new' THEN 1
          WHEN 'seen' THEN 2
          WHEN 'in_progress' THEN 3
          WHEN 'deferred' THEN 4
          WHEN 'done' THEN 5
          WHEN 'wont_fix' THEN 6
          ELSE 99
        END,
        CASE i.severity
          WHEN 'urgent' THEN 1
          WHEN 'high' THEN 2
          WHEN 'normal' THEN 3
          WHEN 'low' THEN 4
          ELSE 99
        END,
        i.created_at DESC
      LIMIT $${params.length}
    `;

    const result = await query(sql, params);

    // Stats for the dashboard-style header
    const statsResult = await query(`
      SELECT status, COUNT(*)::int AS count
      FROM platform_issues
      GROUP BY status
    `);
    const stats: Record<string, number> = {};
    for (const row of statsResult.rows) {
      stats[row.status] = row.count;
    }

    res.json({ data: result.rows, stats });
  } catch (err) {
    console.error('List issues error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── Get one (with comments) ─────────────────────────────────────────────────

router.get('/:id', async (req: AuthRequest, res: Response) => {
  try {
    const { id } = req.params;

    const issueResult = await query(
      `
      SELECT
        i.*,
        reporter.email  AS reporter_email,
        reporter.name   AS reporter_name,
        assignee.email  AS assignee_email,
        assignee.name   AS assignee_name
      FROM platform_issues i
      LEFT JOIN users reporter ON reporter.id = i.created_by
      LEFT JOIN users assignee ON assignee.id = i.assigned_to
      WHERE i.id = $1
      `,
      [id]
    );

    if (!issueResult.rows.length) {
      res.status(404).json({ error: 'Issue not found' });
      return;
    }

    const commentsResult = await query(
      `
      SELECT c.*, u.email AS author_email, u.name AS author_name
      FROM platform_issue_comments c
      LEFT JOIN users u ON u.id = c.author_id
      WHERE c.issue_id = $1
      ORDER BY c.created_at ASC
      `,
      [id]
    );

    res.json({ data: { ...issueResult.rows[0], comments: commentsResult.rows } });
  } catch (err) {
    console.error('Get issue error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── Create ──────────────────────────────────────────────────────────────────

router.post('/', authorize(...STAFF_ROLES), async (req: AuthRequest, res: Response) => {
  try {
    const parse = createSchema.safeParse(req.body);
    if (!parse.success) {
      res.status(400).json({ error: 'Invalid input', issues: parse.error.issues });
      return;
    }

    const data = parse.data;

    const insert = await query(
      `
      INSERT INTO platform_issues
        (title, description, category, severity, area, page_url, created_by)
      VALUES ($1, $2, $3, $4, $5, $6, $7)
      RETURNING *
      `,
      [
        data.title,
        data.description ?? null,
        data.category ?? 'bug',
        data.severity ?? 'normal',
        data.area ?? null,
        data.page_url ?? null,
        req.user!.id,
      ]
    );

    const issue = insert.rows[0];

    // Fire-and-forget email alert
    const reporterName = req.user!.email; // name may not be on the JWT — use email for identification
    const frontendBase = process.env.FRONTEND_URL || 'https://staff.oooshtours.co.uk';
    emailService
      .send('platform_issue_reported', {
        to: ALERT_RECIPIENT,
        variables: {
          title: issue.title,
          description: issue.description || '(no description)',
          categoryLabel: categoryLabel(issue.category),
          severityLabel: severityLabel(issue.severity),
          area: issue.area || '—',
          pageUrl: issue.page_url || '—',
          reporterName,
          issueUrl: `${frontendBase}/operations/issues/${issue.id}`,
        },
      })
      .catch(err => console.error('[issues] alert email failed:', err));

    res.status(201).json({ data: issue });
  } catch (err) {
    console.error('Create issue error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── Update ──────────────────────────────────────────────────────────────────
// Everyone can edit their OWN issue's description/title/page_url/area.
// Only admin/manager can change status, severity, assigned_to, resolution_notes.

router.patch('/:id', async (req: AuthRequest, res: Response) => {
  try {
    const { id } = req.params;
    const parse = updateSchema.safeParse(req.body);
    if (!parse.success) {
      res.status(400).json({ error: 'Invalid input', issues: parse.error.issues });
      return;
    }

    const existing = await query(`SELECT * FROM platform_issues WHERE id = $1`, [id]);
    if (!existing.rows.length) {
      res.status(404).json({ error: 'Issue not found' });
      return;
    }

    const current = existing.rows[0];
    const isTriage = TRIAGE_ROLES.includes(req.user!.role as (typeof TRIAGE_ROLES)[number]);
    const isOwner = current.created_by === req.user!.id;

    // Triage-only fields
    const triageFields = ['status', 'severity', 'assigned_to', 'resolution_notes'] as const;
    const attemptedTriageFields = triageFields.filter(f => parse.data[f] !== undefined);
    if (attemptedTriageFields.length && !isTriage) {
      res.status(403).json({ error: 'Only admin/manager can change status, severity, assignment, or resolution notes' });
      return;
    }

    // Non-triage fields require ownership (or triage)
    const contentFields = ['title', 'description', 'category', 'area', 'page_url'] as const;
    const attemptedContentFields = contentFields.filter(f => parse.data[f] !== undefined);
    if (attemptedContentFields.length && !isOwner && !isTriage) {
      res.status(403).json({ error: 'You can only edit issues you created' });
      return;
    }

    // Build SET clause
    const setClauses: string[] = [];
    const params: unknown[] = [];
    for (const [key, value] of Object.entries(parse.data)) {
      if (value === undefined) continue;
      params.push(value);
      setClauses.push(`${key} = $${params.length}`);
    }

    // Auto-set resolved_at when flipping to done/wont_fix
    if (parse.data.status) {
      if (['done', 'wont_fix'].includes(parse.data.status) && !current.resolved_at) {
        setClauses.push(`resolved_at = NOW()`);
      } else if (!['done', 'wont_fix'].includes(parse.data.status) && current.resolved_at) {
        setClauses.push(`resolved_at = NULL`);
      }
    }

    if (!setClauses.length) {
      res.json({ data: current });
      return;
    }

    params.push(id);
    const result = await query(
      `UPDATE platform_issues SET ${setClauses.join(', ')} WHERE id = $${params.length} RETURNING *`,
      params
    );

    res.json({ data: result.rows[0] });
  } catch (err) {
    console.error('Update issue error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── Delete ──────────────────────────────────────────────────────────────────
// Admin only — keeps the audit trail intact by default. Comments cascade.

router.delete('/:id', authorize('admin'), async (req: AuthRequest, res: Response) => {
  try {
    const { id } = req.params;
    const result = await query(`DELETE FROM platform_issues WHERE id = $1 RETURNING id`, [id]);
    if (!result.rows.length) {
      res.status(404).json({ error: 'Issue not found' });
      return;
    }
    res.json({ success: true });
  } catch (err) {
    console.error('Delete issue error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── Comments ────────────────────────────────────────────────────────────────

router.post('/:id/comments', authorize(...STAFF_ROLES), async (req: AuthRequest, res: Response) => {
  try {
    const { id } = req.params;
    const parse = commentSchema.safeParse(req.body);
    if (!parse.success) {
      res.status(400).json({ error: 'Invalid input', issues: parse.error.issues });
      return;
    }

    const issueCheck = await query(`SELECT id FROM platform_issues WHERE id = $1`, [id]);
    if (!issueCheck.rows.length) {
      res.status(404).json({ error: 'Issue not found' });
      return;
    }

    const result = await query(
      `
      INSERT INTO platform_issue_comments (issue_id, author_id, body)
      VALUES ($1, $2, $3)
      RETURNING *
      `,
      [id, req.user!.id, parse.data.body]
    );

    // Bump the issue's updated_at
    await query(`UPDATE platform_issues SET updated_at = NOW() WHERE id = $1`, [id]);

    res.status(201).json({ data: result.rows[0] });
  } catch (err) {
    console.error('Create comment error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
