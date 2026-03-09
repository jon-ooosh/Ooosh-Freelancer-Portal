import { Router, Response } from 'express';
import { query } from '../config/database';
import { authenticate, AuthRequest } from '../middleware/auth';

const router = Router();
router.use(authenticate);

// GET /api/dashboard — aggregated stats for the Command Centre
router.get('/', async (req: AuthRequest, res: Response) => {
  try {
    // Run all queries in parallel for speed
    const [
      countsResult,
      recentActivityResult,
      activityByTypeResult,
      recentPeopleResult,
      recentOrgsResult,
      thisWeekActivityResult,
      teamActivityResult,
      notificationsResult,
    ] = await Promise.all([
      // Entity counts
      query(`
        SELECT
          (SELECT COUNT(*) FROM people WHERE is_deleted = false) as people_count,
          (SELECT COUNT(*) FROM organisations WHERE is_deleted = false) as org_count,
          (SELECT COUNT(*) FROM venues WHERE is_deleted = false) as venue_count,
          (SELECT COUNT(*) FROM interactions) as interaction_count,
          (SELECT COUNT(*) FROM users WHERE is_active = true) as user_count
      `),

      // Recent activity (last 20 interactions across all entities)
      query(`
        SELECT i.id, i.type, i.content, i.created_at,
          i.person_id, i.organisation_id, i.venue_id,
          CONCAT(p.first_name, ' ', p.last_name) as created_by_name,
          CASE
            WHEN i.person_id IS NOT NULL THEN (SELECT CONCAT(first_name, ' ', last_name) FROM people WHERE id = i.person_id)
            WHEN i.organisation_id IS NOT NULL THEN (SELECT name FROM organisations WHERE id = i.organisation_id)
            WHEN i.venue_id IS NOT NULL THEN (SELECT name FROM venues WHERE id = i.venue_id)
          END as entity_name,
          CASE
            WHEN i.person_id IS NOT NULL THEN 'people'
            WHEN i.organisation_id IS NOT NULL THEN 'organisations'
            WHEN i.venue_id IS NOT NULL THEN 'venues'
          END as entity_type
        FROM interactions i
        LEFT JOIN users u ON u.id = i.created_by
        LEFT JOIN people p ON p.id = u.person_id
        ORDER BY i.created_at DESC
        LIMIT 20
      `),

      // Activity breakdown by type (last 30 days)
      query(`
        SELECT type, COUNT(*) as count
        FROM interactions
        WHERE created_at >= NOW() - INTERVAL '30 days'
        GROUP BY type
        ORDER BY count DESC
      `),

      // Recently added people (last 7 days)
      query(`
        SELECT id, first_name, last_name, email, created_at
        FROM people
        WHERE is_deleted = false AND created_at >= NOW() - INTERVAL '7 days'
        ORDER BY created_at DESC
        LIMIT 5
      `),

      // Recently added organisations (last 7 days)
      query(`
        SELECT id, name, type, created_at
        FROM organisations
        WHERE is_deleted = false AND created_at >= NOW() - INTERVAL '7 days'
        ORDER BY created_at DESC
        LIMIT 5
      `),

      // This week's activity count vs last week
      query(`
        SELECT
          COUNT(*) FILTER (WHERE created_at >= date_trunc('week', NOW())) as this_week,
          COUNT(*) FILTER (WHERE created_at >= date_trunc('week', NOW()) - INTERVAL '7 days'
                           AND created_at < date_trunc('week', NOW())) as last_week
        FROM interactions
      `),

      // Team activity (who's been active recently)
      query(`
        SELECT
          CONCAT(p.first_name, ' ', p.last_name) as name,
          u.id as user_id,
          COUNT(i.id) as interaction_count,
          MAX(i.created_at) as last_active
        FROM users u
        JOIN people p ON p.id = u.person_id
        LEFT JOIN interactions i ON i.created_by = u.id AND i.created_at >= NOW() - INTERVAL '7 days'
        WHERE u.is_active = true
        GROUP BY u.id, p.first_name, p.last_name
        ORDER BY interaction_count DESC
      `),

      // Unread notifications for current user
      query(
        `SELECT COUNT(*) as count FROM notifications WHERE user_id = $1 AND is_read = false`,
        [req.user!.id]
      ),
    ]);

    res.json({
      counts: countsResult.rows[0],
      recent_activity: recentActivityResult.rows,
      activity_by_type: activityByTypeResult.rows,
      recent_people: recentPeopleResult.rows,
      recent_orgs: recentOrgsResult.rows,
      this_week_activity: thisWeekActivityResult.rows[0],
      team_activity: teamActivityResult.rows,
      unread_notifications: parseInt(notificationsResult.rows[0].count),
    });
  } catch (error) {
    console.error('Dashboard error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
