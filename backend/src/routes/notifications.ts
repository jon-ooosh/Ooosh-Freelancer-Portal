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
    const limitNum = parseInt(limit as string);

    let dataRows: Record<string, unknown>[];
    let unreadCount: number;

    // Try with snoozed_until filter, fall back to simple query
    try {
      let sql = `SELECT * FROM notifications WHERE user_id = $1`;
      if (unread_only === 'true') sql += ` AND is_read = false`;
      sql += ` AND (snoozed_until IS NULL OR snoozed_until <= NOW())`;
      sql += ` ORDER BY created_at DESC LIMIT $2`;
      const result = await query(sql, [req.user!.id, limitNum]);
      dataRows = result.rows;

      const countResult = await query(
        `SELECT COUNT(*) FROM notifications WHERE user_id = $1 AND is_read = false AND (snoozed_until IS NULL OR snoozed_until <= NOW())`,
        [req.user!.id]
      );
      unreadCount = parseInt(countResult.rows[0].count);
    } catch {
      // Fallback: snoozed_until column doesn't exist
      let sql = `SELECT * FROM notifications WHERE user_id = $1`;
      if (unread_only === 'true') sql += ` AND is_read = false`;
      sql += ` ORDER BY created_at DESC LIMIT $2`;
      const result = await query(sql, [req.user!.id, limitNum]);
      dataRows = result.rows;

      const countResult = await query(
        `SELECT COUNT(*) FROM notifications WHERE user_id = $1 AND is_read = false`,
        [req.user!.id]
      );
      unreadCount = parseInt(countResult.rows[0].count);
    }

    res.json({
      data: dataRows,
      unread_count: unreadCount,
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
    const {
      tab = 'all',
      status = 'all',
      page = '1',
      limit = '30',
      q,
      sort = 'priority',
      include_acknowledged = 'false',
    } = req.query;
    const userId = req.user!.id;
    const pageNum = Math.max(1, parseInt(page as string));
    const limitNum = Math.min(100, parseInt(limit as string));
    const offset = (pageNum - 1) * limitNum;

    // Build WHERE conditions + a single shared param array (`whereParams`).
    // Both data and count queries use the same WHERE; data query appends
    // limit/offset on top.
    const conditions: string[] = ['n.user_id = $1'];
    const whereParams: unknown[] = [userId];
    let nextParam = 2;

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

    // Search across title + content. Plain ILIKE — no fancy ranking; the
    // inbox is small per-user and a basic match keeps it predictable.
    if (q && typeof q === 'string' && q.trim()) {
      conditions.push(`(n.title ILIKE $${nextParam} OR n.content ILIKE $${nextParam})`);
      whereParams.push(`%${q.trim()}%`);
      nextParam++;
    }

    const baseWhere = conditions.join(' AND ');

    // Try full query with new columns, fall back to simple query on error
    let dataRows: Record<string, unknown>[];
    let total: number;
    let tabCountsRow: Record<string, unknown>;
    let usedFullQuery = false;

    try {
      // Full query — uses new columns from migration 045/046
      const conditionsFull: string[] = [...conditions];
      if (tab !== 'follow_ups') {
        conditionsFull.push(`(n.snoozed_until IS NULL OR n.snoozed_until <= NOW())`);
      }
      // Hide acknowledged items by default — once a user clicks Done, the
      // notification has served its purpose. Toggle "include_acknowledged"
      // brings them back. Tab counts are independent (always count
      // unread / active regardless of this flag).
      if (include_acknowledged !== 'true') {
        conditionsFull.push(`n.acknowledged_at IS NULL`);
      }
      const fullWhere = conditionsFull.join(' AND ');

      // Sort options: priority (default — urgent/high/normal/low + unread first),
      // newest, oldest. The list is small per-user so a single ORDER BY
      // does the work without an index dance.
      let orderBy: string;
      if (sort === 'newest') {
        orderBy = 'n.created_at DESC';
      } else if (sort === 'oldest') {
        orderBy = 'n.created_at ASC';
      } else {
        orderBy = `CASE WHEN n.priority = 'urgent' THEN 0
               WHEN n.priority = 'high' THEN 1
               WHEN n.priority = 'normal' THEN 2
               ELSE 3 END,
          CASE WHEN n.is_read = false THEN 0 ELSE 1 END,
          n.created_at DESC`;
      }

      const limitParam = nextParam;
      const offsetParam = nextParam + 1;

      // Thread root preview: when the notification points at a reply
      // ("Pete replied in a thread you're in"), surface a snippet of the
      // root message + the root author's name so the inbox card has
      // context without forcing the user to expand the thread. The two
      // LEFT JOINs walk reply → root → author; we COALESCE so non-thread
      // notifications just see NULL.
      const [dataResult, countResult] = await Promise.all([
        query(`
          SELECT n.*,
                 sp.first_name AS source_first_name,
                 sp.last_name  AS source_last_name,
                 root.content  AS thread_root_preview,
                 root.id       AS thread_root_id,
                 COALESCE(NULLIF(CONCAT(rootp.first_name, ' ', rootp.last_name), ' '), rootu.email)
                   AS thread_root_author
          FROM notifications n
          LEFT JOIN users  su ON su.id = n.source_user_id
          LEFT JOIN people sp ON sp.id = su.person_id
          LEFT JOIN interactions reply ON reply.id = n.interaction_id
          LEFT JOIN interactions root  ON root.id = COALESCE(reply.parent_interaction_id, reply.id)
          LEFT JOIN users  rootu ON rootu.id = root.created_by
          LEFT JOIN people rootp ON rootp.id = rootu.person_id
          WHERE ${fullWhere}
          ORDER BY ${orderBy}
          LIMIT $${limitParam} OFFSET $${offsetParam}
        `, [...whereParams, limitNum, offset]),
        query(`SELECT COUNT(*) FROM notifications n WHERE ${fullWhere}`, whereParams),
      ]);

      const tc = await query(`
        SELECT
          COUNT(*) FILTER (WHERE is_read = false AND (snoozed_until IS NULL OR snoozed_until <= NOW())) AS all_unread,
          COUNT(*) FILTER (WHERE type = 'mention' AND is_read = false) AS mentions_unread,
          COUNT(*) FILTER (WHERE type = 'follow_up' AND (snoozed_until IS NULL OR snoozed_until <= NOW()) AND acknowledged_at IS NULL) AS follow_ups_active,
          COUNT(*) FILTER (WHERE type IN ('compliance', 'chase_alert', 'hire_form', 'referral', 'system') AND is_read = false) AS system_unread
        FROM notifications WHERE user_id = $1
      `, [userId]);

      dataRows = dataResult.rows;
      total = parseInt(countResult.rows[0].count);
      tabCountsRow = tc.rows[0];
      usedFullQuery = true;
    } catch (fullErr) {
      console.warn('[Inbox] Full query failed, falling back to simple:', (fullErr as Error).message);

      // Simple fallback — only uses original columns. Reuses whereParams
      // with the correct placeholder numbering.
      const limitParam = nextParam;
      const offsetParam = nextParam + 1;
      const [dataResult, countResult] = await Promise.all([
        query(`
          SELECT n.id, n.user_id, n.type, n.title, n.content, n.entity_type, n.entity_id,
                 n.is_read, n.read_at, n.created_at,
                 NULL::text AS source_first_name, NULL::text AS source_last_name,
                 NULL::text AS action_url, 'normal'::text AS priority,
                 NULL::timestamptz AS acknowledged_at, NULL::timestamptz AS nudged_at,
                 NULL::timestamptz AS due_date, NULL::timestamptz AS snoozed_until,
                 NULL::uuid AS source_user_id, NULL::uuid AS interaction_id,
                 NULL::timestamptz AS email_sent_at
          FROM notifications n
          WHERE ${baseWhere}
          ORDER BY CASE WHEN n.is_read = false THEN 0 ELSE 1 END, n.created_at DESC
          LIMIT $${limitParam} OFFSET $${offsetParam}
        `, [...whereParams, limitNum, offset]),
        query(`SELECT COUNT(*) FROM notifications n WHERE ${baseWhere}`, whereParams),
      ]);

      const tc = await query(`
        SELECT
          COUNT(*) FILTER (WHERE is_read = false) AS all_unread,
          COUNT(*) FILTER (WHERE type = 'mention' AND is_read = false) AS mentions_unread,
          0::bigint AS follow_ups_active,
          COUNT(*) FILTER (WHERE type IN ('compliance', 'chase_alert', 'hire_form', 'referral', 'system') AND is_read = false) AS system_unread
        FROM notifications WHERE user_id = $1
      `, [userId]);

      dataRows = dataResult.rows;
      total = parseInt(countResult.rows[0].count);
      tabCountsRow = tc.rows[0];
    }

    res.json({
      data: dataRows,
      tab_counts: tabCountsRow,
      fallback: !usedFullQuery,
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

    let dataRows: Record<string, unknown>[];
    let totalCount: number;

    try {
      // Full query with new columns
      const result = await query(`
        SELECT n.id, n.type, n.title, n.content, n.entity_type, n.entity_id,
               n.interaction_id, n.action_url, n.created_at,
               n.user_id AS recipient_id,
               n.is_read, n.read_at, n.acknowledged_at, n.nudged_at,
               rp.first_name AS recipient_first_name,
               rp.last_name AS recipient_last_name
        FROM notifications n
        JOIN users ru ON ru.id = n.user_id
        JOIN people rp ON rp.id = ru.person_id
        WHERE n.source_user_id = $1
        ORDER BY n.created_at DESC
        LIMIT $2 OFFSET $3
      `, [userId, limitNum, offset]);

      const countResult = await query(
        `SELECT COUNT(*) FROM notifications WHERE source_user_id = $1`,
        [userId]
      );
      dataRows = result.rows;
      totalCount = parseInt(countResult.rows[0].count);
    } catch (sentErr) {
      console.warn('[Sent] Full query failed, returning empty:', (sentErr as Error).message);
      dataRows = [];
      totalCount = 0;
    }

    res.json({
      data: dataRows,
      pagination: {
        page: pageNum,
        total: totalCount,
        totalPages: Math.ceil(totalCount / limitNum),
      },
    });
  } catch (error) {
    console.error('Sent notifications error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── POST /api/notifications/:id/acknowledge ──
// Cascade: when the notification is linked to a `reminder` requirement, also
// mark the underlying requirement as done. The reminder is a single piece of
// work where "I dealt with the inbox alert" effectively means "I dealt with
// the reminder" — without this, the hourly scanner would re-spam tomorrow
// even though the user has just clicked Done. Other requirement types
// (hire_forms, excess, etc.) keep their own status workflow on the job page;
// the cascade is intentionally reminder-only.
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
    const notif = result.rows[0];

    // Cascade for reminder-type requirements
    if (notif.entity_type === 'job_requirements' && notif.entity_id) {
      try {
        await query(
          `UPDATE job_requirements
           SET status = 'done',
               notes = COALESCE(notes, '') ||
                       E'\n[Marked done via inbox acknowledgement]',
               updated_at = NOW()
           WHERE id = $1
             AND requirement_type = 'reminder'
             AND status NOT IN ('done', 'cancelled')`,
          [notif.entity_id]
        );
      } catch (cascadeErr) {
        console.warn('[Notifications] Reminder ack cascade failed:', cascadeErr);
      }
    }

    res.json({ data: notif });
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

// ── POST /api/notifications/bulk-acknowledge — clear-down helper ─────────────
//
// Bulk-acknowledges every notification matching the supplied filter for the
// current user. Used by the "Clear all dealt with" / "Clear visible" inbox
// action. Filters mirror the GET /inbox params so the UI can clear "what
// the user is currently looking at" without a separate filtering language.
//
// Idempotent: setting acknowledged_at when it's already set is a no-op (the
// COALESCE preserves the original timestamp).

const bulkAckSchema = z.object({
  tab: z.enum(['all', 'mentions', 'follow_ups', 'system']).optional(),
  type: z.string().optional(),
  // 'read' = acknowledge already-read items only (the safe default — won't
  // touch unread notifications that the user hasn't seen yet)
  // 'all'  = acknowledge everything in scope including unread
  scope: z.enum(['read', 'all']).default('read'),
  ids: z.array(z.string().uuid()).optional(),
});

router.post('/bulk-acknowledge', async (req: AuthRequest, res: Response) => {
  try {
    const { tab, type, scope, ids } = bulkAckSchema.parse(req.body);
    const userId = req.user!.id;

    const conditions: string[] = ['user_id = $1', 'acknowledged_at IS NULL'];
    const params: unknown[] = [userId];
    let nextParam = 2;

    if (Array.isArray(ids) && ids.length > 0) {
      conditions.push(`id = ANY($${nextParam}::uuid[])`);
      params.push(ids);
      nextParam++;
    }
    if (tab === 'mentions') {
      conditions.push(`type = 'mention'`);
    } else if (tab === 'follow_ups') {
      conditions.push(`type = 'follow_up'`);
    } else if (tab === 'system') {
      conditions.push(`type IN ('compliance', 'chase_alert', 'hire_form', 'referral', 'system')`);
    }
    if (type) {
      conditions.push(`type = $${nextParam}`);
      params.push(type);
      nextParam++;
    }
    if (scope === 'read') {
      conditions.push('is_read = true');
    }

    const result = await query(
      `UPDATE notifications
       SET acknowledged_at = NOW(),
           is_read = true,
           read_at = COALESCE(read_at, NOW())
       WHERE ${conditions.join(' AND ')}
       RETURNING id`,
      params
    );

    // Return the actual IDs that were just touched so the frontend can
    // hand them back to /bulk-unacknowledge if the user undoes.
    res.json({
      cleared: result.rows.length,
      ids: result.rows.map((r: { id: string }) => r.id),
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({ error: 'Invalid request', details: error.errors });
    }
    console.error('Bulk-acknowledge error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── POST /api/notifications/:id/unacknowledge — undo a Done click ──────────
//
// Revert a single notification's acknowledged state (clears
// acknowledged_at). Pairs with the existing /:id/acknowledge — the inbox
// shows a 5-second "Undo" toast after Done so a fat-finger tap doesn't
// permanently bury something.
//
// Mirror behaviour for the reminder cascade: if the original ack flipped
// a `reminder` requirement to status='done', we restore it to 'in_progress'
// (we don't know the prior status with certainty, but in_progress is the
// non-terminal default — staff can adjust if it was something else).
router.post('/:id/unacknowledge', async (req: AuthRequest, res: Response) => {
  try {
    const result = await query(
      `UPDATE notifications
       SET acknowledged_at = NULL
       WHERE id = $1 AND user_id = $2 AND acknowledged_at IS NOT NULL
       RETURNING *`,
      [req.params.id, req.user!.id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Notification not found or not acknowledged' });
    }
    const notif = result.rows[0];

    // Reverse the reminder cascade if applicable.
    if (notif.entity_type === 'job_requirements' && notif.entity_id) {
      try {
        await query(
          `UPDATE job_requirements
           SET status = 'in_progress',
               notes = REGEXP_REPLACE(COALESCE(notes, ''), E'\\n?\\[Marked done via inbox acknowledgement\\]', '', 'g'),
               updated_at = NOW()
           WHERE id = $1
             AND requirement_type = 'reminder'
             AND status = 'done'`,
          [notif.entity_id]
        );
      } catch (cascadeErr) {
        console.warn('[Notifications] Reminder un-ack cascade failed:', cascadeErr);
      }
    }

    res.json({ data: notif });
  } catch (error) {
    console.error('Unacknowledge error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── POST /api/notifications/bulk-unacknowledge — undo a Clear-read ────────
const bulkUnackSchema = z.object({
  ids: z.array(z.string().uuid()).min(1).max(500),
});

router.post('/bulk-unacknowledge', async (req: AuthRequest, res: Response) => {
  try {
    const { ids } = bulkUnackSchema.parse(req.body);
    const result = await query(
      `UPDATE notifications
       SET acknowledged_at = NULL
       WHERE id = ANY($1::uuid[]) AND user_id = $2 AND acknowledged_at IS NOT NULL
       RETURNING id`,
      [ids, req.user!.id]
    );
    res.json({ restored: result.rows.length });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({ error: 'Invalid request', details: error.errors });
    }
    console.error('Bulk-unacknowledge error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── POST /api/notifications/:id/action — actionable notifications (Phase E) ──
//
// Generic action runner. A notification's `actions` JSONB carries an array
// of {kind, label, params, success_message?} entries; the client posts
// {action_index} and the server dispatches by `kind` to a small whitelist
// of internal handlers. New kinds require a code change — deliberately —
// so this can never become an arbitrary RPC channel.
//
// Spec: docs/MESSAGING-SPEC.md §5.3.
//
// Whitelisted kinds (initial cut):
//   - mark_chased: log a `chase` interaction on the linked job
//   - complete_requirement: flip a job_requirements row to status='done'
//   - mark_handled: log a 'note' interaction with optional content
//
// `snooze` is intentionally NOT a server kind — it's a UI affordance the
// client handles by opening the existing snooze modal. Same with `resend_
// email` until we have a clear set of templates that benefit from a
// resend button.

interface NotificationAction {
  kind: string;
  label: string;
  params?: Record<string, unknown>;
  success_message?: string;
}

const actionRequestSchema = z.object({
  action_index: z.number().int().nonnegative(),
});

router.post('/:id/action', async (req: AuthRequest, res: Response) => {
  try {
    const { action_index } = actionRequestSchema.parse(req.body);

    const lookup = await query(
      `SELECT * FROM notifications WHERE id = $1 AND user_id = $2`,
      [req.params.id, req.user!.id]
    );
    if (lookup.rows.length === 0) {
      return res.status(404).json({ error: 'Notification not found' });
    }
    const notif = lookup.rows[0];

    if (notif.acknowledged_at) {
      return res.status(409).json({ error: 'Notification already actioned' });
    }

    const actions = (notif.actions || []) as NotificationAction[];
    if (action_index >= actions.length) {
      return res.status(400).json({ error: 'action_index out of range' });
    }
    const action = actions[action_index];
    if (!action || typeof action.kind !== 'string') {
      return res.status(400).json({ error: 'Invalid action entry' });
    }

    let summary = '';

    if (action.kind === 'mark_chased') {
      const jobId = (action.params?.job_id as string | undefined) || notif.entity_id;
      if (!jobId || notif.entity_type !== 'jobs') {
        return res.status(400).json({ error: 'mark_chased requires a job-anchored notification' });
      }
      const chaseMethod = (action.params?.chase_method as string | undefined) || null;
      const interactionResult = await query(
        `INSERT INTO interactions (type, content, job_id, created_by, chase_method, source)
         VALUES ('chase', $1, $2, $3, $4, 'system')
         RETURNING id`,
        [`Chase logged from inbox: ${notif.title}`, jobId, req.user!.id, chaseMethod]
      );
      // Bump chase: the interactions endpoint normally handles the date
      // calculation, but we wrote the row directly to keep this endpoint
      // self-contained. Apply the same sacred-future rule (only bump if
      // not already future-dated).
      await query(
        `UPDATE jobs SET
           chase_count = chase_count + 1,
           last_chased_at = NOW(),
           next_chase_date = CASE
             WHEN next_chase_date IS NULL OR next_chase_date <= CURRENT_DATE
               THEN (CURRENT_DATE + (COALESCE(chase_interval_days, 5) || ' days')::interval)::date
             ELSE next_chase_date
           END,
           updated_at = NOW()
         WHERE id = $1`,
        [jobId]
      );
      summary = `Logged chase on job (interaction ${interactionResult.rows[0].id}).`;
    }

    else if (action.kind === 'complete_requirement') {
      const requirementId = (action.params?.requirement_id as string | undefined) || notif.entity_id;
      if (!requirementId || notif.entity_type !== 'job_requirements') {
        return res.status(400).json({ error: 'complete_requirement requires a job_requirements-anchored notification' });
      }
      const updateResult = await query(
        `UPDATE job_requirements
         SET status = 'done',
             notes = COALESCE(notes, '') || E'\n[Marked done via inbox action]',
             updated_at = NOW()
         WHERE id = $1
           AND status NOT IN ('done', 'cancelled')
         RETURNING id, status`,
        [requirementId]
      );
      if (updateResult.rows.length === 0) {
        return res.status(409).json({ error: 'Requirement already done or not found' });
      }
      summary = 'Requirement marked done.';
    }

    else if (action.kind === 'mark_handled') {
      const note = action.params?.note as string | undefined;
      // Optional interaction note. Skipped if the notification has no
      // entity to attach it to, or if note is missing.
      if (note && note.trim() && notif.entity_type && notif.entity_id) {
        const fkMap: Record<string, string> = {
          jobs: 'job_id', people: 'person_id', organisations: 'organisation_id', venues: 'venue_id',
        };
        const fk = fkMap[notif.entity_type];
        if (fk) {
          await query(
            `INSERT INTO interactions (type, content, ${fk}, created_by) VALUES ('note', $1, $2, $3)`,
            [note.trim(), notif.entity_id, req.user!.id]
          );
        }
      }
      summary = 'Marked handled.';
    }

    else {
      return res.status(400).json({ error: `Unknown action kind: ${action.kind}` });
    }

    // On success: acknowledge the notification.
    const ackResult = await query(
      `UPDATE notifications
       SET acknowledged_at = NOW(), is_read = true, read_at = COALESCE(read_at, NOW())
       WHERE id = $1
       RETURNING *`,
      [req.params.id]
    );

    res.json({
      success: true,
      summary: action.success_message || summary,
      notification: ackResult.rows[0],
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({ error: 'Invalid request', details: error.errors });
    }
    console.error('Action error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
