import { Router, Response } from 'express';
import { query } from '../config/database';
import { authenticate, AuthRequest } from '../middleware/auth';

const router = Router();
router.use(authenticate);

// GET /api/dashboard — aggregated stats for the Command Centre
router.get('/', async (req: AuthRequest, res: Response) => {
  try {
    // Run all queries in parallel for speed
    const results = await Promise.all([
      // Entity counts (including jobs)
      query(`
        SELECT
          (SELECT COUNT(*) FROM people WHERE is_deleted = false) as people_count,
          (SELECT COUNT(*) FROM organisations WHERE is_deleted = false) as org_count,
          (SELECT COUNT(*) FROM venues WHERE is_deleted = false) as venue_count,
          (SELECT COUNT(*) FROM interactions) as interaction_count,
          (SELECT COUNT(*) FROM users WHERE is_active = true) as user_count,
          (SELECT COUNT(*) FROM jobs WHERE is_deleted = false AND status IN (0,1,2,3,4,5,6,7,8)) as active_job_count
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

      // Job status breakdown (active statuses)
      query(`
        SELECT status, COUNT(*) as count
        FROM jobs
        WHERE is_deleted = false AND status IN (0,1,2,3,4,5,6,7,8)
        GROUP BY status
        ORDER BY status
      `),

      // Upcoming jobs — starting in the next 14 days
      query(`
        SELECT id, hh_job_number, job_name, status, client_name, company_name,
               venue_name, job_date, job_end, out_date
        FROM jobs
        WHERE is_deleted = false
          AND status IN (1,2,3)
          AND job_date >= NOW()
          AND job_date <= NOW() + INTERVAL '14 days'
        ORDER BY job_date ASC
        LIMIT 10
      `),

      // Overdue returns — return_date in the past but status is still dispatched
      query(`
        SELECT id, hh_job_number, job_name, status, client_name, company_name,
               venue_name, return_date, job_date
        FROM jobs
        WHERE is_deleted = false
          AND status IN (4,5)
          AND return_date < NOW()
        ORDER BY return_date ASC
        LIMIT 10
      `),

      // Recent enquiries — newest enquiries/provisionals
      query(`
        SELECT id, hh_job_number, job_name, status, client_name, company_name,
               venue_name, job_date, created_date
        FROM jobs
        WHERE is_deleted = false
          AND status IN (0,1)
        ORDER BY created_date DESC
        LIMIT 8
      `),

      // Pending referrals — drivers needing manual insurer referral
      query(`
        SELECT d.id, d.full_name, d.email, d.referral_status, d.referral_date,
               d.licence_points, d.updated_at,
               vha.hirehop_job_id, vha.hirehop_job_name,
               j.job_name, j.id AS job_uuid
        FROM drivers d
        LEFT JOIN vehicle_hire_assignments vha
          ON vha.driver_id = d.id
          AND vha.status IN ('soft', 'confirmed')
          AND vha.assignment_type = 'self_drive'
        LEFT JOIN jobs j ON j.id = vha.job_id
        WHERE d.requires_referral = true
          AND d.referral_status IN ('pending', 'submitted')
          AND d.is_active = true
        ORDER BY d.updated_at DESC
        LIMIT 10
      `),

      // Pending excess — assignments with unresolved excess
      query(`
        SELECT je.id AS excess_id, je.excess_status, je.excess_amount_required,
               vha.id AS assignment_id, vha.hirehop_job_id, vha.hirehop_job_name, vha.hire_start,
               d.full_name AS driver_name, d.email AS driver_email,
               fv.reg AS vehicle_reg,
               j.job_name, j.id AS job_uuid
        FROM job_excess je
        JOIN vehicle_hire_assignments vha ON vha.id = je.assignment_id
        LEFT JOIN drivers d ON d.id = vha.driver_id
        LEFT JOIN fleet_vehicles fv ON fv.id = vha.vehicle_id
        LEFT JOIN jobs j ON j.id = vha.job_id
        WHERE je.excess_status = 'pending'
          AND vha.status IN ('soft', 'confirmed', 'booked_out', 'active')
        ORDER BY vha.hire_start ASC NULLS LAST
        LIMIT 10
      `),
    ]);

    const [
      countsResult, recentActivityResult, activityByTypeResult,
      recentPeopleResult, recentOrgsResult, thisWeekActivityResult,
      teamActivityResult, notificationsResult, jobStatusBreakdownResult,
      upcomingJobsResult, overdueReturnsResult, recentEnquiriesResult,
      pendingReferralsResult, pendingExcessResult,
    ] = results;

    res.json({
      counts: countsResult.rows[0],
      recent_activity: recentActivityResult.rows,
      activity_by_type: activityByTypeResult.rows,
      recent_people: recentPeopleResult.rows,
      recent_orgs: recentOrgsResult.rows,
      this_week_activity: thisWeekActivityResult.rows[0],
      team_activity: teamActivityResult.rows,
      unread_notifications: parseInt(notificationsResult.rows[0].count),
      job_status_breakdown: jobStatusBreakdownResult.rows,
      upcoming_jobs: upcomingJobsResult.rows,
      overdue_returns: overdueReturnsResult.rows,
      recent_enquiries: recentEnquiriesResult.rows,
      pending_referrals: pendingReferralsResult.rows,
      pending_excess: pendingExcessResult.rows,
    });
  } catch (error) {
    console.error('Dashboard error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
