import { Router, Response } from 'express';
import { query } from '../config/database';
import { authenticate, AuthRequest } from '../middleware/auth';

const router = Router();
router.use(authenticate);

// GET /api/notifications — list notifications for the current user
router.get('/', async (req: AuthRequest, res: Response) => {
  try {
    const { unread_only, limit = '20' } = req.query;

    let sql = `
      SELECT * FROM notifications
      WHERE user_id = $1
    `;
    const params: unknown[] = [req.user!.id];
    let paramIndex = 2;

    if (unread_only === 'true') {
      sql += ` AND is_read = false`;
    }

    sql += ` ORDER BY created_at DESC LIMIT $${paramIndex}`;
    params.push(parseInt(limit as string));

    const result = await query(sql, params);

    // Also get unread count
    const countResult = await query(
      'SELECT COUNT(*) FROM notifications WHERE user_id = $1 AND is_read = false',
      [req.user!.id]
    );

    res.json({
      data: result.rows,
      unread_count: parseInt(countResult.rows[0].count),
    });
  } catch (error) {
    console.error('List notifications error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/notifications/read — mark notifications as read
router.post('/read', async (req: AuthRequest, res: Response) => {
  try {
    const { notification_ids } = req.body;

    if (notification_ids && Array.isArray(notification_ids) && notification_ids.length > 0) {
      // Mark specific notifications as read
      await query(
        `UPDATE notifications SET is_read = true, read_at = NOW()
         WHERE id = ANY($1) AND user_id = $2`,
        [notification_ids, req.user!.id]
      );
    } else {
      // Mark all as read
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

export default router;
