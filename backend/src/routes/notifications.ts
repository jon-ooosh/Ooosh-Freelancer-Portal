import { Router, Response } from 'express';
import { query } from '../config/database';
import { authenticate, AuthRequest } from '../middleware/auth';
import { z } from 'zod';

const router = Router();
router.use(authenticate);

// ── GET /api/notifications — bell dropdown (legacy, kept for backward compat) ──
router.get('/', async (req: AuthRequest, res: Response) => {
  try {
    const { unread_only, limit = '20' } = req.query;

    // Check if snoozed_until column exists (migration 045)
    const colCheck = await query(`
      SELECT 1 FROM information_schema.columns
      WHERE table_name = 'notifications' AND column_name = 'snoozed_until'
    `);
    const hasSnoozed = colCheck.rows.length > 0;

    let sql = `
      SELECT * FROM notifications
      WHERE user_id = $1
    `;
    const params: unknown[] = [req.user!.id];
    let paramIndex = 2;

    if (unread_only === 'true') {
      sql += ` AND is_read = false`;
    }

    // Hide snoozed notifications from bell (only if column exists)
    if (hasSnoozed) {
      sql += ` AND (snoozed_until IS NULL OR snoozed_until <= NOW())`;
    }

    sql += ` ORDER BY created_at DESC LIMIT $${paramIndex}`;
    params.push(parseInt(limit as string));

    const result = await query(sql, params);

    // Unread count
    const countSql = hasSnoozed
      ? `SELECT COUNT(*) FROM notifications WHERE user_id = $1 AND is_read = false AND (snoozed_until IS NULL OR snoozed_until <= NOW())`
      : `SELECT COUNT(*) FROM notifications WHERE user_id = $1 AND is_read = false`;
    const countResult = await query(countSql, [req.user!.id]);

    res.json({
      data: result.rows,
      unread_count: parseInt(countResult.rows[0].count),
    });
  } catch (error) {
    console.error('List notifications error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── POST /api/notifications/read — mark notifications as read ──
router.post('/read', async (req: AuthRequest, res: Response) => {
  try {
    const { notification_ids } = req.body;

    if (notification_ids && Array.isArray(notification_ids) && notification_ids.length > 0) {
      await query(
        `UPDATE notifications SET is_read = true, read_at = NOW()
         WHERE id = ANY($1) AND user_id = $2`,
        [notification_ids, req.user!.id]
      );
    } else {
      await query(
        `UPDATE notifications SET is_read = true, read_at = NOW()
         WHERE user_id = $1 AND is_read = false`,
        [req.user!.id]
      );
    }

    res.json({ success: true });
  } catch (error) {
    console.error('Mark read error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// INBOX ENDPOINTS
// ═══════════════════════════════════════════════════════════════════════════

// ── GET /api/notifications/inbox — paginated inbox with tabs ──
router.get('/inbox', async (req: AuthRequest, res: Response) => {
  try {
    const { tab = 'all', status = 'all', page = '1', limit = '30' } = req.query;
    const userId = req.user!.id;
    const pageNum = Math.max(1, parseInt(page as string));
    const limitNum = Math.min(100, parseInt(limit as string));
    const offset = (pageNum - 1) * limitNum;

    // Check if ALL new columns exist (migration 045 may have partially applied)
    const colCheck = await query(`
      SELECT column_name FROM information_schema.columns
      WHERE table_name = 'notifications'
        AND column_name IN ('priority', 'source_user_id', 'snoozed_until', 'acknowledged_at', 'action_url')
    `);
    const existingCols = new Set(colCheck.rows.map((r: Record<string, unknown>) => r.column_name));
    const hasNewColumns = existingCols.size >= 5; // all 5 key columns must exist

    const conditions: string[] = ['n.user_id = $1'];
    const params: unknown[] = [userId];
    let pIdx = 2;

    // Tab filter
    if (tab === 'mentions') {
      conditions.push(`n.type = 'mention'`);
    } else if (tab === 'follow_ups') {
      conditions.push(`n.type = 'follow_up'`);
    } else if (tab === 'system') {
      conditions.push(`n.type IN ('compliance', 'chase_alert', 'hire_form', 'referral', 'system')`);
    }

    // Status filter
    if (status === 'unread') {
      conditions.push(`n.is_read = false`);
    } else if (status === 'read') {
      conditions.push(`n.is_read = true`);
    }

    // Exclude snoozed (only if column exists)
    if (hasNewColumns && tab !== 'follow_ups') {
      conditions.push(`(n.snoozed_until IS NULL OR n.snoozed_until <= NOW())`);
    }

    const whereClause = conditions.join(' AND ');

    // Build query depending on available columns
    const selectCols = hasNewColumns
      ? `n.*, su.first_name AS source_first_name, su.last_name AS source_last_name`
      : `n.id, n.user_id, n.type, n.title, n.content, n.entity_type, n.entity_id,
         n.is_read, n.read_at, n.created_at,
         NULL::text AS source_first_name, NULL::text AS source_last_name,
         NULL::text AS action_url, 'normal'::text AS priority,
         NULL::timestamptz AS acknowledged_at, NULL::timestamptz AS nudged_at,
         NULL::timestamptz AS due_date, NULL::timestamptz AS snoozed_until,
         NULL::uuid AS source_user_id, NULL::uuid AS interaction_id,
         NULL::timestamptz AS email_sent_at`;
    const joinClause = hasNewColumns
      ? `LEFT JOIN users su ON su.id = n.source_user_id`
      : ``;
    const orderClause = hasNewColumns
      ? `ORDER BY
           CASE WHEN n.priority = 'urgent' THEN 0
                WHEN n.priority = 'high' THEN 1
                WHEN n.priority = 'normal' THEN 2
                ELSE 3 END,
           CASE WHEN n.is_read = false THEN 0 ELSE 1 END,
           n.created_at DESC`
      : `ORDER BY CASE WHEN n.is_read = false THEN 0 ELSE 1 END, n.created_at DESC`;

    const [dataResult, countResult] = await Promise.all([
      query(`
        SELECT ${selectCols}
        FROM notifications n
        ${joinClause}
        WHERE ${whereClause}
        ${orderClause}
        LIMIT $${pIdx} OFFSET $${pIdx + 1}
      `, [...params, limitNum, offset]),
      query(`
        SELECT COUNT(*) FROM notifications n WHERE ${whereClause}
      `, params),
    ]);

    // Tab counts
    let tabCountsRow;
    if (hasNewColumns) {
      const tabCounts = await query(`
        SELECT
          COUNT(*) FILTER (WHERE is_read = false AND (snoozed_until IS NULL OR snoozed_until <= NOW())) AS all_unread,
          COUNT(*) FILTER (WHERE type = 'mention' AND is_read = false) AS mentions_unread,
          COUNT(*) FILTER (WHERE type = 'follow_up' AND (snoozed_until IS NULL OR snoozed_until <= NOW()) AND acknowledged_at IS NULL) AS follow_ups_active,
          COUNT(*) FILTER (WHERE type IN ('compliance', 'chase_alert', 'hire_form', 'referral', 'system') AND is_read = false) AS system_unread
        FROM notifications
        WHERE user_id = $1
      `, [userId]);
      tabCountsRow = tabCounts.rows[0];
    } else {
      const tabCounts = await query(`
        SELECT
          COUNT(*) FILTER (WHERE is_read = false) AS all_unread,
          COUNT(*) FILTER (WHERE type = 'mention' AND is_read = false) AS mentions_unread,
          0 AS follow_ups_active,
          COUNT(*) FILTER (WHERE type IN ('compliance', 'chase_alert', 'hire_form', 'referral', 'system') AND is_read = false) AS system_unread
        FROM notifications
        WHERE user_id = $1
      `, [userId]);
      tabCountsRow = tabCounts.rows[0];
    }

    const total = parseInt(countResult.rows[0].count);

    res.json({
      data: dataResult.rows,
      tab_counts: tabCountsRow,
      pagination: {
        page: pageNum,
        limit: limitNum,
        total,
        totalPages: Math.ceil(total / limitNum),
      },
    });
  } catch (error) {
    console.error('Inbox error:', error);
    res.status(500).json({ error: 'Internal server error', details: error instanceof Error ? error.message : String(error) });
  }
});

// ── GET /api/notifications/sent — notifications created by current user ──
router.get('/sent', async (req: AuthRequest, res: Response) => {
  try {
    const { page = '1', limit = '20' } = req.query;
    const userId = req.user!.id;
    const pageNum = Math.max(1, parseInt(page as string));
    const limitNum = Math.min(100, parseInt(limit as string));
    const offset = (pageNum - 1) * limitNum;

    // Check if new columns exist
    const colCheck = await query(`
      SELECT column_name FROM information_schema.columns
      WHERE table_name = 'notifications' AND column_name = 'source_user_id'
    `);
    if (colCheck.rows.length === 0) {
      // Migration 045 hasn't run — no sent data available
      return res.json({ data: [], pagination: { page: 1, total: 0, totalPages: 0 } });
    }

    // Get notifications this user created (mentions they sent)
    const result = await query(`
      SELECT n.id, n.type, n.title, n.content, n.entity_type, n.entity_id,
             n.interaction_id, n.action_url, n.created_at,
             n.user_id AS recipient_id,
             n.is_read, n.read_at, n.acknowledged_at, n.nudged_at,
             ru.first_name AS recipient_first_name,
             ru.last_name AS recipient_last_name
      FROM notifications n
      JOIN users ru ON ru.id = n.user_id
      WHERE n.source_user_id = $1
      ORDER BY n.created_at DESC
      LIMIT $2 OFFSET $3
    `, [userId, limitNum, offset]);

    const countResult = await query(
      `SELECT COUNT(*) FROM notifications WHERE source_user_id = $1`,
      [userId]
    );

    res.json({
      data: result.rows,
      pagination: {
        page: pageNum,
        total: parseInt(countResult.rows[0].count),
        totalPages: Math.ceil(parseInt(countResult.rows[0].count) / limitNum),
      },
    });
  } catch (error) {
    console.error('Sent notifications error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── POST /api/notifications/:id/acknowledge ──
router.post('/:id/acknowledge', async (req: AuthRequest, res: Response) => {
  try {
    const result = await query(
      `UPDATE notifications
       SET acknowledged_at = NOW(), is_read = true, read_at = COALESCE(read_at, NOW())
       WHERE id = $1 AND user_id = $2
       RETURNING *`,
      [req.params.id, req.user!.id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Notification not found' });
    }
    res.json({ data: result.rows[0] });
  } catch (error) {
    console.error('Acknowledge error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── POST /api/notifications/:id/snooze ──
const snoozeSchema = z.object({
  snooze_until: z.string().datetime({ offset: true }),
});

router.post('/:id/snooze', async (req: AuthRequest, res: Response) => {
  try {
    const { snooze_until } = snoozeSchema.parse(req.body);
    const result = await query(
      `UPDATE notifications
       SET snoozed_until = $1, is_read = true, read_at = COALESCE(read_at, NOW())
       WHERE id = $2 AND user_id = $3
       RETURNING *`,
      [snooze_until, req.params.id, req.user!.id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Notification not found' });
    }
    res.json({ data: result.rows[0] });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({ error: 'Invalid snooze date', details: error.errors });
    }
    console.error('Snooze error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── POST /api/notifications/:id/nudge — sender nudges an unread recipient ──
router.post('/:id/nudge', async (req: AuthRequest, res: Response) => {
  try {
    // Only the sender can nudge
    const result = await query(
      `UPDATE notifications
       SET nudged_at = NOW(), snoozed_until = NULL, is_read = false, read_at = NULL
       WHERE id = $1 AND source_user_id = $2
       RETURNING *`,
      [req.params.id, req.user!.id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Notification not found or you are not the sender' });
    }
    res.json({ data: result.rows[0] });
  } catch (error) {
    console.error('Nudge error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── POST /api/notifications/follow-up — create a follow-up reminder ──
const followUpSchema = z.object({
  title: z.string().min(1).max(500),
  content: z.string().optional().nullable(),
  due_date: z.string().datetime({ offset: true }),
  entity_type: z.string().optional().nullable(),
  entity_id: z.string().uuid().optional().nullable(),
  action_url: z.string().optional().nullable(),
  priority: z.enum(['low', 'normal', 'high', 'urgent']).optional().default('normal'),
});

router.post('/follow-up', async (req: AuthRequest, res: Response) => {
  try {
    const data = followUpSchema.parse(req.body);
    const userId = req.user!.id;

    const result = await query(
      `INSERT INTO notifications
         (user_id, type, title, content, entity_type, entity_id, action_url,
          priority, source_user_id, due_date, snoozed_until)
       VALUES ($1, 'follow_up', $2, $3, $4, $5, $6, $7, $1, $8, $8)
       RETURNING *`,
      [
        userId, data.title, data.content || null,
        data.entity_type || null, data.entity_id || null, data.action_url || null,
        data.priority, data.due_date,
      ]
    );

    res.status(201).json({ data: result.rows[0] });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({ error: 'Invalid follow-up data', details: error.errors });
    }
    console.error('Create follow-up error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// USER NOTIFICATION PREFERENCES
// ═══════════════════════════════════════════════════════════════════════════

const VALID_TYPES = ['mention', 'chase_alert', 'compliance', 'hire_form', 'referral', 'follow_up', 'system'];

// ── GET /api/notifications/preferences ──
router.get('/preferences', async (req: AuthRequest, res: Response) => {
  try {
    const result = await query(
      `SELECT notification_type, delivery_method FROM user_notification_preferences WHERE user_id = $1`,
      [req.user!.id]
    );

    // Build map with defaults for types without explicit preference
    const prefs: Record<string, string> = {};
    for (const t of VALID_TYPES) {
      prefs[t] = 'both'; // default
    }
    for (const row of result.rows) {
      prefs[row.notification_type] = row.delivery_method;
    }

    res.json({ data: prefs });
  } catch (error) {
    console.error('Get preferences error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── PUT /api/notifications/preferences ──
const prefsSchema = z.record(
  z.string(),
  z.enum(['notification', 'email', 'both', 'none'])
);

router.put('/preferences', async (req: AuthRequest, res: Response) => {
  try {
    const prefs = prefsSchema.parse(req.body);
    const userId = req.user!.id;

    for (const [type, method] of Object.entries(prefs)) {
      if (!VALID_TYPES.includes(type)) continue;
      await query(
        `INSERT INTO user_notification_preferences (user_id, notification_type, delivery_method)
         VALUES ($1, $2, $3)
         ON CONFLICT (user_id, notification_type) DO UPDATE SET delivery_method = $3, updated_at = NOW()`,
        [userId, type, method]
      );
    }

    res.json({ success: true });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({ error: 'Invalid preferences', details: error.errors });
    }
    console.error('Update preferences error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
