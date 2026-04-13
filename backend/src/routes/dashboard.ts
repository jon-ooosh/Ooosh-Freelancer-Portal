import { Router, Response } from 'express';
import { query } from '../config/database';
import { authenticate, AuthRequest } from '../middleware/auth';

const router = Router();
router.use(authenticate);

// ── GET /api/dashboard/operations — aggregated operational data for Command Centre ──
router.get('/operations', async (req: AuthRequest, res: Response) => {
  try {
    const results = await Promise.all([
      // 1. Today's schedule — going out
      // Jobs with out_date or job_date = today, confirmed/prepped only (NOT dispatched — once out, it's on hire)
      query(`
        SELECT j.id, j.hh_job_number, j.job_name, j.status, j.pipeline_status,
               j.client_name, j.company_name, j.venue_name,
               j.job_date, j.job_end, j.out_date, j.return_date,
               j.out_time, j.return_time, j.end_time
        FROM jobs j
        WHERE j.is_deleted = false
          AND j.status IN (2, 3)
          AND (
            COALESCE(j.out_date, j.job_date)::date = CURRENT_DATE
          )
        ORDER BY j.out_time ASC NULLS LAST, COALESCE(j.out_date, j.job_date) ASC
        LIMIT 20
      `),

      // 2. Today's schedule — returning (smart: effective_return = return_date - 24h)
      // Dispatched jobs where the effective return date is today
      query(`
        SELECT j.id, j.hh_job_number, j.job_name, j.status, j.pipeline_status,
               j.client_name, j.company_name, j.venue_name,
               j.job_date, j.job_end, j.out_date, j.return_date,
               j.out_time, j.return_time, j.end_time
        FROM jobs j
        WHERE j.is_deleted = false
          AND j.status IN (4, 5)
          AND j.return_date IS NOT NULL
          AND (j.return_date - interval '24 hours')::date = CURRENT_DATE
        ORDER BY j.return_time ASC NULLS LAST, j.return_date ASC
        LIMIT 20
      `),

      // 3. Tomorrow's counts — going out
      query(`
        SELECT COUNT(*) as count
        FROM jobs
        WHERE is_deleted = false
          AND status IN (2, 3)
          AND COALESCE(out_date, job_date)::date = CURRENT_DATE + 1
      `),

      // 4. Tomorrow's counts — returning
      query(`
        SELECT COUNT(*) as count
        FROM jobs
        WHERE is_deleted = false
          AND status IN (4, 5)
          AND return_date IS NOT NULL
          AND (return_date - interval '24 hours')::date = CURRENT_DATE + 1
      `),

      // 5. Coming up — next 14 days, grouped by date (departures + returns)
      // Departures
      query(`
        SELECT j.id, j.hh_job_number, j.job_name, j.client_name, j.company_name,
               COALESCE(j.out_date, j.job_date)::date as event_date,
               'departure' as event_type
        FROM jobs j
        WHERE j.is_deleted = false
          AND j.status IN (1, 2, 3)
          AND COALESCE(j.out_date, j.job_date)::date > CURRENT_DATE
          AND COALESCE(j.out_date, j.job_date)::date <= CURRENT_DATE + 14
        ORDER BY event_date ASC
      `),

      // Returns (using smart date)
      query(`
        SELECT j.id, j.hh_job_number, j.job_name, j.client_name, j.company_name,
               (j.return_date - interval '24 hours')::date as event_date,
               'return' as event_type
        FROM jobs j
        WHERE j.is_deleted = false
          AND j.status IN (2, 3, 4, 5)
          AND j.return_date IS NOT NULL
          AND (j.return_date - interval '24 hours')::date > CURRENT_DATE
          AND (j.return_date - interval '24 hours')::date <= CURRENT_DATE + 14
        ORDER BY event_date ASC
      `),

      // 6. Needs attention — overdue returns
      query(`
        SELECT j.id, j.hh_job_number, j.job_name, j.client_name, j.company_name,
               j.return_date, j.venue_name
        FROM jobs j
        WHERE j.is_deleted = false
          AND j.status IN (4, 5)
          AND j.return_date IS NOT NULL
          AND (j.return_date - interval '24 hours')::date < CURRENT_DATE
        ORDER BY j.return_date ASC
        LIMIT 10
      `),

      // 7. Chases due
      query(`
        SELECT j.id, j.hh_job_number, j.job_name, j.client_name, j.company_name,
               j.next_chase_date, j.job_value, j.pipeline_status
        FROM jobs j
        WHERE j.is_deleted = false
          AND j.pipeline_status NOT IN ('confirmed', 'lost')
          AND j.next_chase_date IS NOT NULL
          AND j.next_chase_date <= CURRENT_DATE
        ORDER BY j.next_chase_date ASC, j.job_value DESC NULLS LAST
        LIMIT 10
      `),

      // 8. Pending referrals count
      query(`
        SELECT COUNT(*) as count
        FROM drivers
        WHERE requires_referral = true
          AND referral_status IN ('pending', 'submitted')
          AND is_active = true
      `),

      // 9. Excess awaiting collection
      query(`
        SELECT COUNT(*) as count,
               COALESCE(SUM(je.excess_amount_required), 0) as total_amount
        FROM job_excess je
        JOIN vehicle_hire_assignments vha ON vha.id = je.assignment_id
        WHERE je.excess_status IN ('needed', 'pending')
          AND vha.status IN ('soft', 'confirmed', 'booked_out', 'active')
      `),

      // 10. Transport ops summary — counts by ops_status
      query(`
        SELECT
          CASE WHEN q.status = 'cancelled' THEN 'cancelled'
               ELSE COALESCE(q.ops_status, 'todo')
          END as ops_status,
          COUNT(*) as count
        FROM quotes q
        WHERE q.is_deleted = false
          AND q.status != 'cancelled'
          AND q.job_date >= CURRENT_DATE - 7
          AND q.job_date <= CURRENT_DATE + 30
        GROUP BY
          CASE WHEN q.status = 'cancelled' THEN 'cancelled'
               ELSE COALESCE(q.ops_status, 'todo')
          END
      `),

      // 11. Transport — unassigned quotes (need crew)
      query(`
        SELECT COUNT(*) as count
        FROM quotes q
        WHERE q.is_deleted = false
          AND q.status NOT IN ('cancelled', 'completed')
          AND COALESCE(q.ops_status, 'todo') IN ('todo', 'arranging')
          AND q.job_date >= CURRENT_DATE
          AND NOT EXISTS (
            SELECT 1 FROM quote_assignments qa
            WHERE qa.quote_id = q.id AND qa.status != 'cancelled'
          )
      `),

      // 12. Fleet summary
      query(`
        SELECT
          COUNT(*) FILTER (WHERE is_active = true AND fleet_group != 'old_sold') as active_count,
          COUNT(*) as total_count,
          COUNT(*) FILTER (WHERE mot_due IS NOT NULL AND mot_due < CURRENT_DATE + 30 AND is_active = true AND fleet_group != 'old_sold') as mot_due_soon,
          COUNT(*) FILTER (WHERE insurance_due IS NOT NULL AND insurance_due < CURRENT_DATE + 30 AND is_active = true AND fleet_group != 'old_sold') as insurance_due_soon,
          COUNT(*) FILTER (WHERE tax_due IS NOT NULL AND tax_due < CURRENT_DATE + 30 AND is_active = true AND fleet_group != 'old_sold') as tax_due_soon
        FROM fleet_vehicles
      `),

      // 13. Pipeline stats
      query(`
        SELECT
          pipeline_status,
          COUNT(*) as count,
          COALESCE(SUM(job_value), 0) as total_value
        FROM jobs
        WHERE is_deleted = false
          AND pipeline_status IS NOT NULL
          AND pipeline_status NOT IN ('confirmed', 'lost')
        GROUP BY pipeline_status
        ORDER BY pipeline_status
      `),

      // 14. Pipeline total active value
      query(`
        SELECT COALESCE(SUM(job_value), 0) as total
        FROM jobs
        WHERE is_deleted = false
          AND pipeline_status NOT IN ('confirmed', 'lost')
          AND pipeline_status IS NOT NULL
      `),

      // 15. Stat card counts
      query(`
        SELECT
          (SELECT COUNT(*) FROM jobs WHERE is_deleted = false AND status IN (5)) as on_hire_count,
          (SELECT COUNT(*) FROM jobs WHERE is_deleted = false AND status IN (2, 3) AND COALESCE(out_date, job_date)::date = CURRENT_DATE) as going_out_count,
          (SELECT COUNT(*) FROM jobs WHERE is_deleted = false AND status IN (4, 5) AND return_date IS NOT NULL AND (return_date - interval '24 hours')::date = CURRENT_DATE) as coming_back_count,
          (SELECT COUNT(*) FROM jobs WHERE is_deleted = false AND status IN (4, 5) AND return_date IS NOT NULL AND (return_date - interval '24 hours')::date < CURRENT_DATE) as overdue_count,
          (SELECT COUNT(*) FROM jobs WHERE is_deleted = false AND pipeline_status NOT IN ('confirmed', 'lost') AND next_chase_date IS NOT NULL AND next_chase_date <= CURRENT_DATE) as chases_due_count,
          (SELECT COUNT(*) FROM jobs WHERE is_deleted = false AND pipeline_status IS NOT NULL AND pipeline_status NOT IN ('confirmed', 'lost')) as open_enquiries_count
      `),

      // 16. Today's transport quotes (departures with crew/vehicle info)
      query(`
        SELECT q.id, q.job_type, q.job_date, q.arrival_time,
               q.venue_name, q.ops_status, q.status as quote_status,
               j.id as job_id, j.hh_job_number, j.job_name, j.client_name,
               COALESCE(
                 (SELECT json_agg(json_build_object(
                   'first_name', p.first_name,
                   'last_name', p.last_name,
                   'role', qa.role
                 ))
                 FROM quote_assignments qa
                 LEFT JOIN people p ON p.id = qa.person_id
                 WHERE qa.quote_id = q.id AND qa.status != 'cancelled'
                ), '[]'::json) as crew
        FROM quotes q
        LEFT JOIN jobs j ON j.id = q.job_id
        WHERE q.is_deleted = false
          AND q.status NOT IN ('cancelled')
          AND q.job_date::date = CURRENT_DATE
        ORDER BY q.arrival_time ASC NULLS LAST
      `),

      // 17. Vehicle hire assignments for today's departures (driver/vehicle info)
      query(`
        SELECT vha.id, vha.job_id, vha.vehicle_id, vha.driver_id, vha.status as assignment_status,
               fv.reg, fv.simple_type, fv.make, fv.model,
               d.full_name as driver_name,
               j.id as job_uuid, j.hh_job_number, j.job_name
        FROM vehicle_hire_assignments vha
        LEFT JOIN fleet_vehicles fv ON fv.id = vha.vehicle_id
        LEFT JOIN drivers d ON d.id = vha.driver_id
        LEFT JOIN jobs j ON j.id = vha.job_id
        WHERE vha.status IN ('confirmed', 'booked_out', 'active')
          AND j.is_deleted = false
          AND j.status IN (2, 3, 4, 5)
          AND COALESCE(j.out_date, j.job_date)::date = CURRENT_DATE
      `),

      // 18. Team activity this week
      query(`
        SELECT
          CONCAT(p.first_name, ' ', p.last_name) as name,
          u.id as user_id,
          COUNT(i.id) as interaction_count,
          MAX(i.created_at) as last_active
        FROM users u
        JOIN people p ON p.id = u.person_id
        LEFT JOIN interactions i ON i.created_by = u.id AND i.created_at >= date_trunc('week', NOW())
        WHERE u.is_active = true
        GROUP BY u.id, p.first_name, p.last_name
        ORDER BY interaction_count DESC
      `),

      // 19. Recent activity (last 15)
      query(`
        SELECT i.id, i.type, i.content, i.created_at,
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
          END as entity_type,
          i.person_id, i.organisation_id, i.venue_id
        FROM interactions i
        LEFT JOIN users u ON u.id = i.created_by
        LEFT JOIN people p ON p.id = u.person_id
        ORDER BY i.created_at DESC
        LIMIT 15
      `),

      // 20. Pending referrals detail (up to 5)
      query(`
        SELECT d.id, d.full_name, d.referral_status, d.licence_points,
               d.updated_at
        FROM drivers d
        WHERE d.requires_referral = true
          AND d.referral_status IN ('pending', 'submitted')
          AND d.is_active = true
        ORDER BY d.updated_at DESC
        LIMIT 5
      `),

      // 21. Pending excess detail (up to 5)
      query(`
        SELECT je.id AS excess_id, je.excess_status, je.excess_amount_required,
               d.full_name AS driver_name,
               fv.reg AS vehicle_reg,
               j.id as job_uuid, j.hh_job_number, j.job_name
        FROM job_excess je
        JOIN vehicle_hire_assignments vha ON vha.id = je.assignment_id
        LEFT JOIN drivers d ON d.id = vha.driver_id
        LEFT JOIN fleet_vehicles fv ON fv.id = vha.vehicle_id
        LEFT JOIN jobs j ON j.id = vha.job_id
        WHERE je.excess_status IN ('needed', 'pending')
          AND vha.status IN ('soft', 'confirmed', 'booked_out', 'active')
        ORDER BY vha.hire_start ASC NULLS LAST
        LIMIT 5
      `),
    ]);

    const [
      goingOutResult, returningResult,
      tomorrowGoingOutResult, tomorrowReturningResult,
      upcomingDeparturesResult, upcomingReturnsResult,
      overdueReturnsResult, chasesDueResult,
      referralCountResult, excessCountResult,
      transportOpsResult, unassignedTransportResult,
      fleetSummaryResult, pipelineStatsResult,
      pipelineValueResult, statCardsResult,
      todayTransportResult, todayVehiclesResult,
      teamActivityResult, recentActivityResult,
      pendingReferralsResult, pendingExcessResult,
    ] = results;

    // Merge upcoming departures + returns into a timeline
    const upcomingEvents = [
      ...upcomingDeparturesResult.rows,
      ...upcomingReturnsResult.rows,
    ].sort((a, b) => {
      const dateA = new Date(a.event_date).getTime();
      const dateB = new Date(b.event_date).getTime();
      return dateA - dateB;
    });

    // Group transport ops by status
    const transportOpsSummary: Record<string, number> = {};
    for (const row of transportOpsResult.rows) {
      transportOpsSummary[row.ops_status as string] = parseInt(row.count as string);
    }

    res.json({
      stat_cards: statCardsResult.rows[0],
      today: {
        going_out: goingOutResult.rows,
        returning: returningResult.rows,
        transport_quotes: todayTransportResult.rows,
        vehicle_assignments: todayVehiclesResult.rows,
      },
      tomorrow: {
        going_out_count: parseInt(tomorrowGoingOutResult.rows[0].count as string),
        returning_count: parseInt(tomorrowReturningResult.rows[0].count as string),
      },
      upcoming_events: upcomingEvents,
      needs_attention: {
        overdue_returns: overdueReturnsResult.rows,
        chases_due: chasesDueResult.rows,
        referral_count: parseInt(referralCountResult.rows[0].count as string),
        referrals: pendingReferralsResult.rows,
        excess_count: parseInt(excessCountResult.rows[0].count as string),
        excess_total: parseFloat(excessCountResult.rows[0].total_amount as string),
        excess_items: pendingExcessResult.rows,
      },
      transport_ops: {
        summary: transportOpsSummary,
        unassigned_count: parseInt(unassignedTransportResult.rows[0].count as string),
      },
      fleet: fleetSummaryResult.rows[0],
      pipeline: {
        by_status: pipelineStatsResult.rows,
        active_value: parseFloat(pipelineValueResult.rows[0].total as string),
      },
      team_activity: teamActivityResult.rows,
      recent_activity: recentActivityResult.rows,
    });
  } catch (error) {
    console.error('Dashboard operations error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

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
