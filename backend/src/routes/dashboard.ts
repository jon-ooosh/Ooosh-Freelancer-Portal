import { Router, Response } from 'express';
import { query } from '../config/database';
import { authenticate, AuthRequest } from '../middleware/auth';
import { buildProgressStrips, StripPhase } from '../services/job-progress-strip';

const router = Router();
router.use(authenticate);

// ── POST /api/dashboard/job-progress — bulk per-job progress strips ──
// Body: { jobs: [{ id: string, phase: 'pre_hire' | 'post_hire' }] }
// Returns: { data: { [jobId]: { deprep, client, excess, freelancer, invoicing, payment, vehicle } } }
// Used by the Today block to render the 7-slot status pip strip per job.
router.post('/job-progress', async (req: AuthRequest, res: Response) => {
  try {
    const { jobs } = req.body as { jobs?: Array<{ id: string; phase?: StripPhase }> };
    if (!Array.isArray(jobs) || jobs.length === 0) {
      return res.json({ data: {} });
    }
    const trimmed = jobs.slice(0, 200);
    const ids = trimmed.map(j => j.id).filter(Boolean);
    const phases: Record<string, StripPhase> = {};
    for (const j of trimmed) phases[j.id] = j.phase === 'post_hire' ? 'post_hire' : 'pre_hire';

    if (ids.length === 0) return res.json({ data: {} });

    // Exclude suspended requirements (hire_forms / excess auto-suspended when
    // every van slot is Van & Driver, or the job is marked Internal) —
    // they're "not required" on this job, not a problem, so they shouldn't
    // render as a red prob pill.
    const result = await query(
      `SELECT job_id, requirement_type, status, phase
       FROM job_requirements
       WHERE job_id = ANY($1)
         AND (notes IS NULL OR notes NOT LIKE '%[Suspended:%')`,
      [ids],
    );

    const data = buildProgressStrips(result.rows, phases);
    res.json({ data });
  } catch (err) {
    console.error('Error building job progress strips:', err);
    res.status(500).json({ error: 'Failed to build job progress' });
  }
});

// ── GET /api/dashboard/operations — aggregated operational data for Command Centre ──
router.get('/operations', async (req: AuthRequest, res: Response) => {
  try {
    const results = await Promise.all([
      // 1. Today's schedule — going out
      // Jobs with out_date or job_date = today, NOT yet actually on hire.
      // HH statuses 2 (Booked), 3 (Prepped), 4 (Part Dispatched) are all pre-dispatch.
      // HH 5 (Dispatched) is included only if OP pipeline_status = 'prepped' — HH jumps to 5
      // on checkout but OP treats that as "prepped in yard" until staff clicks "On Hire".
      // Exclude once pipeline_status = 'dispatched' (OP says actually on hire).
      query(`
        SELECT j.id, j.hh_job_number, j.job_name, j.status, j.pipeline_status,
               j.client_name, j.company_name, j.venue_name,
               j.job_date, j.job_end, j.out_date, j.return_date,
               j.out_time, j.return_time, j.end_time,
               EXISTS (
                 SELECT 1 FROM vehicle_hire_assignments vha
                 WHERE vha.job_id = j.id
                   AND vha.return_overnight = TRUE
                   AND vha.status IN ('soft', 'confirmed', 'booked_out', 'active')
               ) AS has_ooh_return
        FROM jobs j
        WHERE j.is_deleted = false
          AND (
            j.status IN (2, 3, 4)
            OR (j.status = 5 AND j.pipeline_status = 'prepped')
          )
          AND (
            COALESCE(j.out_date, j.job_date)::date = CURRENT_DATE
          )
        ORDER BY j.out_time ASC NULLS LAST, COALESCE(j.out_date, j.job_date) ASC
        LIMIT 20
      `),

      // 2. Today's schedule — returning (smart: effective_return = return_date - 24h)
      // Dispatched jobs where the effective return date is today, OR
      // job_end is today/yesterday (matching JobsPage return window logic)
      query(`
        SELECT j.id, j.hh_job_number, j.job_name, j.status, j.pipeline_status,
               j.client_name, j.company_name, j.venue_name,
               j.job_date, j.job_end, j.out_date, j.return_date,
               j.out_time, j.return_time, j.end_time,
               EXISTS (
                 SELECT 1 FROM vehicle_hire_assignments vha
                 WHERE vha.job_id = j.id
                   AND vha.return_overnight = TRUE
                   AND vha.status IN ('booked_out', 'active')
               ) AS has_ooh_return
        FROM jobs j
        WHERE j.is_deleted = false
          AND j.status IN (2, 3, 4, 5, 6)
          AND (
            -- return_date is today
            (j.return_date IS NOT NULL AND j.return_date::date = CURRENT_DATE)
            -- OR job_end is today or yesterday (could return today)
            OR (j.job_end IS NOT NULL AND j.job_end::date IN (CURRENT_DATE, CURRENT_DATE - 1))
            -- OR return_date is tomorrow (today is final day, could come back from midday)
            OR (j.return_date IS NOT NULL AND j.return_date::date = CURRENT_DATE + 1)
          )
        ORDER BY j.return_time ASC NULLS LAST, j.return_date ASC
        LIMIT 20
      `),

      // 3. Tomorrow's counts — going out (same pre-dispatch logic as query 1, shifted +1 day)
      query(`
        SELECT COUNT(*) as count
        FROM jobs
        WHERE is_deleted = false
          AND (
            status IN (2, 3, 4)
            OR (status = 5 AND pipeline_status = 'prepped')
          )
          AND COALESCE(out_date, job_date)::date = CURRENT_DATE + 1
      `),

      // 4. Tomorrow's counts — returning (same return window logic as query 2, shifted +1 day)
      query(`
        SELECT COUNT(*) as count
        FROM jobs
        WHERE is_deleted = false
          AND status IN (2, 3, 4, 5, 6)
          AND (
            (return_date IS NOT NULL AND return_date::date = CURRENT_DATE + 1)
            OR (job_end IS NOT NULL AND job_end::date IN (CURRENT_DATE, CURRENT_DATE + 1))
            OR (return_date IS NOT NULL AND return_date::date = CURRENT_DATE + 2)
          )
      `),

      // 5. Coming up — next 14 days, grouped by date (departures + returns).
      // Status filters aligned with the Today block (queries 1 & 2) so a job
      // that shows in "Going Out Today" or "Returning Today" is also visible
      // on the heat strip. The key inclusion is HH status 5 + OP pipeline
      // 'prepped' — physically prepped but not yet operationally dispatched.
      // Provisional (HH 1) is deliberately excluded — operational warehouse
      // surfaces only count actually-booked work.
      query(`
        SELECT j.id, j.hh_job_number, j.job_name, j.client_name, j.company_name,
               COALESCE(j.out_date, j.job_date)::date as event_date,
               'departure' as event_type
        FROM jobs j
        WHERE j.is_deleted = false
          AND (
            j.status IN (2, 3, 4)
            OR (j.status = 5 AND j.pipeline_status = 'prepped')
          )
          AND j.pipeline_status NOT IN ('lost', 'cancelled')
          AND COALESCE(j.out_date, j.job_date)::date >= CURRENT_DATE
          AND COALESCE(j.out_date, j.job_date)::date <= CURRENT_DATE + 14
        ORDER BY event_date ASC
      `),

      // Returns (using smart date — return_date - 24h matches the "could
      // come back today from midday" logic on JobsPage). Status range
      // matches Today's returning query: 2-6 inclusive.
      query(`
        SELECT j.id, j.hh_job_number, j.job_name, j.client_name, j.company_name,
               (j.return_date - interval '24 hours')::date as event_date,
               'return' as event_type
        FROM jobs j
        WHERE j.is_deleted = false
          AND j.status IN (2, 3, 4, 5, 6)
          AND j.return_date IS NOT NULL
          AND (j.return_date - interval '24 hours')::date > CURRENT_DATE
          AND (j.return_date - interval '24 hours')::date <= CURRENT_DATE + 14
        ORDER BY event_date ASC
      `),

      // 6. Needs attention — overdue COMPLETIONS (jobs that came back but
      // didn't get closed out). HH status 6 = Returned Incomplete, 7 =
      // Returned, 8 = Requires Attention. The "physically out and overdue
      // back" case (status 4/5) lives on the headline stat card and links to
      // /jobs?overdue=1 — those aren't completions yet, the van is still out.
      // Returns the top 10 oldest as items + a separate total count, so the
      // bucket headline reflects the truth (was capped at 10 = misleading).
      query(`
        WITH overdue AS (
          SELECT j.id, j.hh_job_number, j.job_name, j.client_name, j.company_name,
                 j.return_date, j.venue_name,
                 ROW_NUMBER() OVER (ORDER BY j.return_date ASC) AS rn,
                 COUNT(*) OVER () AS total_count
          FROM jobs j
          WHERE j.is_deleted = false
            AND j.status IN (6, 7, 8)
            AND j.return_date IS NOT NULL
            AND j.return_date::date < CURRENT_DATE
        )
        SELECT id, hh_job_number, job_name, client_name, company_name,
               return_date, venue_name, total_count
        FROM overdue
        WHERE rn <= 10
        ORDER BY return_date ASC
      `),

      // 7. Transport arrangements to action — quotes in the next 7 days
      // attached to a CONFIRMED (or pre-dispatch) job where any arranging
      // pill (client introduction / tolls / accommodation / flights) is
      // still outstanding. Enquiries / provisional are excluded — those
      // aren't genuinely upcoming yet. Local D&C quotes default arranging
      // columns to 'not_needed' (NULL) so they're naturally excluded; staff
      // bumps them to 'todo' manually if needed.
      // This replaces the old "Chases Due" bucket — chases now live solely
      // on the stat-card row above, and the post-confirmation pile uses the
      // reminders system.
      query(`
        SELECT q.id AS quote_id, q.job_type, q.job_date, q.arrival_time,
               q.venue_name, q.client_introduction, q.tolls_status,
               q.accommodation_status, q.flight_status, q.ops_status,
               j.id AS job_id, j.hh_job_number, j.job_name, j.client_name, j.company_name
        FROM quotes q
        LEFT JOIN jobs j ON j.id = q.job_id
        WHERE q.is_deleted = false
          AND q.status NOT IN ('cancelled', 'completed')
          AND (
            q.client_introduction IN ('todo', 'working_on_it')
            OR q.tolls_status = 'todo'
            OR q.accommodation_status = 'todo'
            OR q.flight_status = 'todo'
          )
          AND q.job_date IS NOT NULL
          AND q.job_date::date BETWEEN CURRENT_DATE AND CURRENT_DATE + INTERVAL '7 days'
          AND j.pipeline_status IN ('confirmed', 'prepping', 'prepped')
        ORDER BY q.job_date ASC, q.arrival_time ASC NULLS LAST
        LIMIT 10
      `),

      // 7a. Overdue departures — should have left but haven't.
      // Jobs with out_date or job_date in the past, in operational pre-dispatch
      // HH status (2/3/4 = Booked/Prepped/Part Dispatched) OR HH 5 + OP
      // pipeline_status='prepped' (the "physically prepped, in the yard,
      // waiting for staff to click Mark as Dispatched" state — HH jumps to 5
      // on item checkout but OP holds 'prepped' until staff confirms it's
      // actually rolled out the gate). Provisional (HH 1) and Enquiry (HH 0)
      // are deliberately excluded — those route through the stale-enquiry
      // auto-lose scheduler at 09:00, not the warehouse overdue list.
      // Capped at 30 days lookback.
      query(`
        SELECT j.id, j.hh_job_number, j.job_name, j.client_name, j.company_name,
               COALESCE(j.out_date, j.job_date) AS expected_date, j.venue_name,
               j.status AS hh_status, j.pipeline_status,
               (CURRENT_DATE - COALESCE(j.out_date, j.job_date)::date) AS days_overdue
        FROM jobs j
        WHERE j.is_deleted = false
          AND (
            j.status IN (2, 3, 4)
            OR (j.status = 5 AND j.pipeline_status = 'prepped')
          )
          AND j.pipeline_status NOT IN ('lost', 'cancelled', 'completed', 'dispatched', 'returned')
          AND COALESCE(j.out_date, j.job_date)::date < CURRENT_DATE
          AND COALESCE(j.out_date, j.job_date)::date >= CURRENT_DATE - INTERVAL '30 days'
        ORDER BY COALESCE(j.out_date, j.job_date) ASC
        LIMIT 10
      `),

      // 7b. Overdue backline — pre-hire backline not done past job_date.
      // Mirrors backline.ts overdueOut logic; capped to 10 for the widget.
      // Operational filter only — provisional + enquiry are excluded so the
      // warehouse widget reflects actually-booked work, not speculative
      // enquiries (which route through the stale-enquiry auto-lose at 09:00).
      query(`
        SELECT j.id, j.hh_job_number, j.job_name, j.client_name, j.company_name,
               j.job_date, j.status AS hh_status, jr.status AS backline_status,
               (CURRENT_DATE - j.job_date::date) AS days_overdue
        FROM jobs j
        JOIN job_requirements jr ON jr.job_id = j.id
          AND jr.requirement_type = 'backline'
          AND jr.phase = 'pre_hire'
        WHERE j.is_deleted = false
          AND j.job_date::date < CURRENT_DATE
          AND j.job_date::date >= CURRENT_DATE - INTERVAL '30 days'
          AND (j.status IN (2, 3, 4) OR (j.status = 5 AND j.pipeline_status = 'prepped'))
          AND j.pipeline_status NOT IN ('lost', 'cancelled', 'completed', 'returned')
          AND jr.status != 'done'
        ORDER BY j.job_date ASC
        LIMIT 10
      `),

      // 7c. Overdue transport ops — quotes past their job_date that aren't
      // completed or cancelled. Includes legacy "stalled" rows that have
      // drifted past their date without anyone closing them out.
      query(`
        SELECT q.id, q.job_type, q.job_date, q.venue_name, q.ops_status,
               q.status AS quote_status,
               j.id AS job_id, j.hh_job_number, j.job_name, j.client_name,
               (CURRENT_DATE - q.job_date::date) AS days_overdue
        FROM quotes q
        LEFT JOIN jobs j ON j.id = q.job_id
        WHERE q.is_deleted = false
          AND q.status != 'cancelled'
          AND COALESCE(q.ops_status, 'todo') NOT IN ('completed', 'cancelled')
          AND q.job_date::date < CURRENT_DATE
          AND q.job_date::date >= CURRENT_DATE - INTERVAL '30 days'
        ORDER BY q.job_date ASC
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

      // 9. Excess held unreimbursed — finished hires (returned / checking in /
      // completed) where money is actually held with us and the hire ended
      // 5+ days ago. Whitelisted on excess_status to ensure money is actually
      // in our hands: 'taken' and 'partially_paid' only. Excludes 'pre_auth'
      // because Stripe holds auto-release; pre-auth chasing belongs in its
      // own scheduler bucket. Excludes 'needed' / 'pending' because those are
      // "system thinks one is required" not "money is here". Replaces the
      // older "excess awaiting collection" rule (we're good at taking excess
      // up front, slack on returning it).
      query(`
        SELECT COUNT(*) as count, COALESCE(SUM(h.held_amount), 0) as total_amount
        FROM v_excess_held h
        JOIN job_excess je ON je.id = h.excess_id
        LEFT JOIN vehicle_hire_assignments vha ON vha.id = je.assignment_id
        LEFT JOIN jobs j ON j.id = COALESCE(vha.job_id, je.job_id)
        WHERE h.held_amount > 0.01
          AND je.excess_status <> 'pre_auth'
          AND (j.pipeline_status IN ('returned_incomplete','returned','completed')
               OR j.status IN (6, 7, 11))
          AND COALESCE(j.return_date, j.job_end)::date <= CURRENT_DATE - INTERVAL '5 days'
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
      // Aligned with the summary date range so the "Needs crew" count
      // references the same set of quotes shown in the To Do / Arranged piles.
      query(`
        SELECT COUNT(*) as count
        FROM quotes q
        WHERE q.is_deleted = false
          AND q.status NOT IN ('cancelled', 'completed')
          AND COALESCE(q.ops_status, 'todo') IN ('todo', 'arranging')
          AND q.job_date >= CURRENT_DATE
          AND q.job_date <= CURRENT_DATE + 30
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

      // 15. Stat card counts.
      // going_out_count uses the same status filter as the Today section
      // (query 1) so the headline number lines up with the listed jobs —
      // 2/3/4 plus HH 5 still operationally pre-dispatch (pipeline_status
      // = 'prepped'). Excludes jobs OP has marked dispatched.
      query(`
        SELECT
          (SELECT COUNT(*) FROM jobs WHERE is_deleted = false AND status IN (5)) as on_hire_count,
          (SELECT COUNT(*) FROM jobs WHERE is_deleted = false
             AND (status IN (2, 3, 4) OR (status = 5 AND pipeline_status = 'prepped'))
             AND COALESCE(out_date, job_date)::date = CURRENT_DATE) as going_out_count,
          (SELECT COUNT(*) FROM jobs WHERE is_deleted = false AND status IN (2, 3, 4, 5, 6) AND (
            (return_date IS NOT NULL AND return_date::date = CURRENT_DATE)
            OR (job_end IS NOT NULL AND job_end::date IN (CURRENT_DATE, CURRENT_DATE - 1))
            OR (return_date IS NOT NULL AND return_date::date = CURRENT_DATE + 1)
          )) as coming_back_count,
          (SELECT COUNT(*) FROM jobs WHERE is_deleted = false AND status IN (4, 5) AND return_date IS NOT NULL AND return_date::date < CURRENT_DATE) as overdue_count,
          (SELECT COUNT(*) FROM jobs WHERE is_deleted = false AND pipeline_status NOT IN ('confirmed', 'lost') AND next_chase_date IS NOT NULL AND next_chase_date <= CURRENT_DATE) as chases_due_count,
          -- Pre-confirmation statuses only. Whitelist matches the Pipeline page
          -- columns (Enquiries / Chasing-derived / Provisional / Paused) and the
          -- chase-model definition in CLAUDE.md. The previous blacklist swept in
          -- every operational + historical job (prepping / prepped / dispatched /
          -- returned / completed / cancelled) and reported ~1100+ on a fleet
          -- with ~40 actual open enquiries.
          (SELECT COUNT(*) FROM jobs WHERE is_deleted = false AND pipeline_status IN ('new_enquiry', 'quoting', 'paused', 'provisional')) as open_enquiries_count
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

      // 21. Excess held unreimbursed detail — same rule as count above.
      // Show oldest first (longest sitting on our books).
      query(`
        SELECT je.id AS excess_id, je.excess_status,
               h.held_amount AS excess_amount_required,
               COALESCE(d.full_name, j.client_name) AS driver_name,
               fv.reg AS vehicle_reg,
               j.id as job_uuid, j.hh_job_number, j.job_name,
               COALESCE(j.return_date, j.job_end) AS hire_ended_at,
               (CURRENT_DATE - COALESCE(j.return_date, j.job_end)::date) AS days_since_finish
        FROM v_excess_held h
        JOIN job_excess je ON je.id = h.excess_id
        LEFT JOIN vehicle_hire_assignments vha ON vha.id = je.assignment_id
        LEFT JOIN drivers d ON d.id = vha.driver_id
        LEFT JOIN fleet_vehicles fv ON fv.id = vha.vehicle_id
        LEFT JOIN jobs j ON j.id = COALESCE(vha.job_id, je.job_id)
        WHERE h.held_amount > 0.01
          AND je.excess_status <> 'pre_auth'
          AND (j.pipeline_status IN ('returned_incomplete','returned','completed')
               OR j.status IN (6, 7, 11))
          AND COALESCE(j.return_date, j.job_end)::date <= CURRENT_DATE - INTERVAL '5 days'
        ORDER BY COALESCE(j.return_date, j.job_end) ASC
        LIMIT 5
      `),

      // 22. Prep time estimates — today and tomorrow from hh_derived_flags
      query(`
        SELECT
          COALESCE(j.out_date, j.job_date)::date as prep_date,
          COUNT(*) as job_count,
          SUM(COALESCE((j.hh_derived_flags->'prep_time_by_category'->>'vehicles')::int, 0)) as vehicle_prep_mins,
          SUM(COALESCE((j.hh_derived_flags->'prep_time_by_category'->>'backline')::int, 0)) as backline_prep_mins,
          SUM(COALESCE((j.hh_derived_flags->'prep_time_by_category'->>'rehearsals')::int, 0)) as rehearsal_prep_mins,
          SUM(COALESCE((j.hh_derived_flags->>'total_prep_time_mins')::int, 0)) as total_prep_mins,
          SUM(COALESCE((j.hh_derived_flags->>'vehicle_count')::int, 0)) as vehicle_count
        FROM jobs j
        WHERE j.is_deleted = false
          AND j.status IN (2, 3)
          AND j.hh_derived_flags IS NOT NULL
          AND COALESCE(j.out_date, j.job_date)::date IN (CURRENT_DATE, CURRENT_DATE + 1)
        GROUP BY prep_date
        ORDER BY prep_date ASC
      `),

      // 24. On-hire sparkline — last 14 days, count of jobs that would have
      // been on hire on each day (out_date <= day AND return_date >= day).
      // Cheap snapshot from the existing date columns; no status history table
      // needed. Cancelled / lost jobs excluded; pre-deposit enquiries excluded
      // via status filter.
      query(`
        WITH days AS (
          SELECT (CURRENT_DATE - offset_days)::date AS day
          FROM generate_series(13, 0, -1) AS offset_days
        )
        SELECT d.day,
               COUNT(j.id) AS on_hire_count
        FROM days d
        LEFT JOIN jobs j ON j.is_deleted = false
          AND j.status IN (2, 3, 4, 5, 6, 7, 11)
          AND COALESCE(j.out_date, j.job_date)::date <= d.day
          AND COALESCE(j.return_date, j.job_end)::date >= d.day
        GROUP BY d.day
        ORDER BY d.day ASC
      `),

      // 23. De-prep time estimates — returning jobs today and tomorrow
      query(`
        SELECT
          j.return_date::date as deprep_date,
          COUNT(*) as job_count,
          SUM(COALESCE((j.hh_derived_flags->'prep_time_by_category'->>'vehicles')::int, 0)) as vehicle_deprep_mins,
          SUM(COALESCE((j.hh_derived_flags->'prep_time_by_category'->>'backline')::int, 0)) as backline_deprep_mins,
          SUM(COALESCE((j.hh_derived_flags->'prep_time_by_category'->>'rehearsals')::int, 0)) as rehearsal_deprep_mins,
          SUM(COALESCE((j.hh_derived_flags->>'total_prep_time_mins')::int, 0)) as total_deprep_mins,
          SUM(COALESCE((j.hh_derived_flags->>'vehicle_count')::int, 0)) as vehicle_count
        FROM jobs j
        WHERE j.is_deleted = false
          AND j.status IN (4, 5, 6)
          AND j.hh_derived_flags IS NOT NULL
          AND j.return_date IS NOT NULL
          AND (
            j.return_date::date = CURRENT_DATE
            OR j.return_date::date = CURRENT_DATE + 1
            OR (j.job_end IS NOT NULL AND j.job_end::date IN (CURRENT_DATE, CURRENT_DATE - 1))
          )
        GROUP BY deprep_date
        ORDER BY deprep_date ASC
      `),

      // 25. Pre-auth holds expiring soon (migration 087). Stripe / card-machine
      // holds auto-void at the 5-day mark — staff need to capture or release
      // before then or the collateral evaporates. Surface holds expiring within
      // 2 days (and any already-past-expiry that are still pre_auth, i.e. not
      // yet actioned). Soonest-expiring first.
      query(`
        SELECT je.id AS excess_id,
               COALESCE(je.amount_held, 0) AS amount_held,
               je.held_expires_at,
               (je.held_expires_at::date - CURRENT_DATE) AS days_until_expiry,
               COALESCE(d.full_name, je.client_name) AS driver_name,
               fv.reg AS vehicle_reg,
               j.id AS job_uuid, j.hh_job_number, j.job_name
        FROM job_excess je
        LEFT JOIN vehicle_hire_assignments vha ON vha.id = je.assignment_id
        LEFT JOIN drivers d ON d.id = vha.driver_id
        LEFT JOIN fleet_vehicles fv ON fv.id = vha.vehicle_id
        LEFT JOIN jobs j ON j.id = COALESCE(vha.job_id, je.job_id)
        WHERE je.excess_status = 'pre_auth'
          AND je.held_expires_at IS NOT NULL
          AND je.held_expires_at::date >= CURRENT_DATE
          AND je.held_expires_at::date <= CURRENT_DATE + INTERVAL '2 days'
        ORDER BY je.held_expires_at ASC
        LIMIT 10
      `),

      // 26. Card-machine receipt scans outstanding (migration 087). Excess
      // collected/held on a physical terminal (Worldpay/Amex/cash) needs a
      // receipt scan attached for audit. Non-blocking — surfaced as an amber
      // to-do until the scan lands. Newest first.
      query(`
        SELECT je.id AS excess_id,
               COALESCE(je.amount_held, je.excess_amount_taken, 0) AS amount,
               je.payment_method, je.excess_status,
               COALESCE(d.full_name, je.client_name) AS driver_name,
               fv.reg AS vehicle_reg,
               j.id AS job_uuid, j.hh_job_number, j.job_name
        FROM job_excess je
        LEFT JOIN vehicle_hire_assignments vha ON vha.id = je.assignment_id
        LEFT JOIN drivers d ON d.id = vha.driver_id
        LEFT JOIN fleet_vehicles fv ON fv.id = vha.vehicle_id
        LEFT JOIN jobs j ON j.id = COALESCE(vha.job_id, je.job_id)
        WHERE je.receipt_required = TRUE
          AND je.receipt_uploaded_at IS NULL
          -- Forward-looking only: the migration 087 backfill flagged all
          -- historic card records; the requirement applies from 1 Jun 2026.
          AND je.created_at >= DATE '2026-06-01'
          -- Self-retire once the hire is completed.
          AND NOT (COALESCE(j.pipeline_status, '') = 'completed' OR COALESCE(j.status, 0) = 11)
        ORDER BY je.updated_at DESC
        LIMIT 10
      `),
    ]);

    const [
      goingOutResult, returningResult,
      tomorrowGoingOutResult, tomorrowReturningResult,
      upcomingDeparturesResult, upcomingReturnsResult,
      overdueCompletionsResult, clientIntrosResult,
      overdueDeparturesResult, overdueBacklineResult, overdueTransportOpsResult,
      referralCountResult, excessCountResult,
      transportOpsResult, unassignedTransportResult,
      fleetSummaryResult, pipelineStatsResult,
      pipelineValueResult, statCardsResult,
      todayTransportResult, todayVehiclesResult,
      teamActivityResult, recentActivityResult,
      pendingReferralsResult, pendingExcessResult,
      prepTimeResult, onHireSparkResult, deprepTimeResult,
      expiringHoldsResult, receiptsOutstandingResult,
    ] = results;

    // Build the 14-day on-hire series — oldest day first, today last.
    const onHireSpark: number[] = onHireSparkResult.rows.map(
      (row: { on_hire_count: string | number }) => parseInt(String(row.on_hire_count), 10) || 0,
    );

    // Build prep time estimates by day
    const prepEstimates: Record<string, {
      job_count: number; vehicle_count: number;
      vehicle_prep_mins: number; backline_prep_mins: number; rehearsal_prep_mins: number; total_prep_mins: number;
      deprep_job_count: number; deprep_vehicle_count: number;
      vehicle_deprep_mins: number; backline_deprep_mins: number; rehearsal_deprep_mins: number; total_deprep_mins: number;
    }> = {};

    for (const row of prepTimeResult.rows) {
      const dateKey = new Date(row.prep_date as string).toISOString().split('T')[0];
      prepEstimates[dateKey] = {
        job_count: parseInt(row.job_count as string),
        vehicle_count: parseInt(row.vehicle_count as string),
        vehicle_prep_mins: parseInt(row.vehicle_prep_mins as string),
        backline_prep_mins: parseInt(row.backline_prep_mins as string),
        rehearsal_prep_mins: parseInt(row.rehearsal_prep_mins as string),
        total_prep_mins: parseInt(row.total_prep_mins as string),
        deprep_job_count: 0, deprep_vehicle_count: 0,
        vehicle_deprep_mins: 0, backline_deprep_mins: 0, rehearsal_deprep_mins: 0, total_deprep_mins: 0,
      };
    }

    // Merge de-prep data
    for (const row of deprepTimeResult.rows) {
      const dateKey = new Date(row.deprep_date as string).toISOString().split('T')[0];
      if (!prepEstimates[dateKey]) {
        prepEstimates[dateKey] = {
          job_count: 0, vehicle_count: 0,
          vehicle_prep_mins: 0, backline_prep_mins: 0, rehearsal_prep_mins: 0, total_prep_mins: 0,
          deprep_job_count: 0, deprep_vehicle_count: 0,
          vehicle_deprep_mins: 0, backline_deprep_mins: 0, rehearsal_deprep_mins: 0, total_deprep_mins: 0,
        };
      }
      prepEstimates[dateKey].deprep_job_count = parseInt(row.job_count as string);
      prepEstimates[dateKey].deprep_vehicle_count = parseInt(row.vehicle_count as string);
      prepEstimates[dateKey].vehicle_deprep_mins = parseInt(row.vehicle_deprep_mins as string);
      prepEstimates[dateKey].backline_deprep_mins = parseInt(row.backline_deprep_mins as string);
      prepEstimates[dateKey].rehearsal_deprep_mins = parseInt(row.rehearsal_deprep_mins as string);
      prepEstimates[dateKey].total_deprep_mins = parseInt(row.total_deprep_mins as string);
    }

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

    // ── On Today/Tomorrow — ad-hoc to-dos that fall through the cracks ──
    // Currently seeded from storage access requests (open, due today/tomorrow
    // or undated). Built as the general home for future ad-hoc items: union
    // more sources into `onToday` as modules need a "do this soon" surface.
    // Wrapped defensively so a missing storage table (pre-migration env) can't
    // 500 the whole dashboard.
    let onToday: Record<string, unknown>[] = [];
    try {
      const storageAccess = await query(`
        SELECT e.id, e.type, e.description, e.method, e.requested_date, e.status,
               r.name AS room_name,
               COALESCE(e.attendee_name, p.first_name || ' ' || p.last_name) AS attendee
        FROM storage_access_events e
        LEFT JOIN storage_tenancies t ON t.id = e.tenancy_id
        LEFT JOIN storage_rooms r ON r.id = COALESCE(e.room_id, t.room_id)
        LEFT JOIN people p ON p.id = e.attendee_person_id
        WHERE e.status IN ('requested','scheduled')
          AND (e.requested_date IS NULL OR e.requested_date <= CURRENT_DATE + 1)
        ORDER BY e.requested_date NULLS FIRST
        LIMIT 25
      `);
      onToday = storageAccess.rows.map((e) => ({
        source: 'storage_access',
        id: e.id,
        title: `${e.room_name || 'Storage'} — ${String(e.type).replace('_', ' ')}${e.method === 'courier' ? ' 🚚' : ''}`,
        detail: [e.description, e.attendee].filter(Boolean).join(' · '),
        due: e.requested_date,
        href: '/storage?tab=access',
      }));
    } catch (err) {
      console.warn('Dashboard on_today (storage) skipped:', (err as Error).message);
    }

    res.json({
      stat_cards: { ...statCardsResult.rows[0], on_hire_spark: onHireSpark },
      on_today: onToday,
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
        // Renamed from overdue_returns Apr 2026 — bucket now means
        // "jobs returned (HH 6/7/8) but not closed out", not "jobs that should
        // be back but aren't". The latter lives on the headline stat card.
        // The query LIMITs to 10 items; the bucket headline number reflects
        // the FULL count via overdue_completions_total (was capped at 10
        // until May 2026 — misleading when 32 jobs were stuck in close-out).
        overdue_completions: overdueCompletionsResult.rows,
        overdue_completions_total: overdueCompletionsResult.rows[0]
          ? parseInt(overdueCompletionsResult.rows[0].total_count, 10)
          : 0,
        // Backwards-compat alias — old field name kept on the wire for any
        // widget still reading the old key. Drop after one release cycle.
        overdue_returns: overdueCompletionsResult.rows,
        overdue_departures: overdueDeparturesResult.rows,
        overdue_backline: overdueBacklineResult.rows,
        overdue_transport_ops: overdueTransportOpsResult.rows,
        // Aggregate count for "X items need attention" headline. Excludes
        // client intros (separate concept) and referrals/excess counts
        // (live in their own widgets). Uses the FULL completions count, not
        // the LIMIT-10 row count.
        total_overdue_count:
          (overdueCompletionsResult.rows[0]
            ? parseInt(overdueCompletionsResult.rows[0].total_count, 10)
            : 0)
          + overdueDeparturesResult.rows.length
          + overdueBacklineResult.rows.length
          + overdueTransportOpsResult.rows.length,
        client_intros: clientIntrosResult.rows,
        referral_count: parseInt(referralCountResult.rows[0].count as string),
        referrals: pendingReferralsResult.rows,
        // ── Excess (semantics changed Apr 2026) ──
        // These now mean "excess held but not reimbursed, hire finished 5+ days
        // ago" — the post-hire pinch point. Old field names kept for
        // backwards compatibility with widgets still on the wire.
        excess_count: parseInt(excessCountResult.rows[0].count as string),
        excess_total: parseFloat(excessCountResult.rows[0].total_amount as string),
        excess_items: pendingExcessResult.rows,
        // ── Pre-auth holds expiring soon (migration 087) ──
        // Holds within 2 days of auto-voiding — capture or release before the
        // collateral evaporates.
        expiring_holds_count: expiringHoldsResult.rows.length,
        expiring_holds: expiringHoldsResult.rows,
        // ── Card-machine receipt scans outstanding (migration 087) ──
        // Excess collected/held on a physical terminal needs a receipt scan
        // attached. Amber to-do, non-blocking.
        receipts_outstanding_count: receiptsOutstandingResult.rows.length,
        receipts_outstanding: receiptsOutstandingResult.rows,
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
      prep_estimates: prepEstimates,
      team_activity: teamActivityResult.rows,
      recent_activity: recentActivityResult.rows,
    });
  } catch (error) {
    console.error('Dashboard operations error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── GET /api/dashboard/returns-overview — aggregate close-out progress for returns widget ──
router.get('/returns-overview', async (req: AuthRequest, res: Response) => {
  try {
    const results = await Promise.all([
      // 1. Job counts by return status
      query(`
        SELECT
          COUNT(*) FILTER (WHERE j.status IN (6, 7, 8)) as active_returns,
          COUNT(*) FILTER (WHERE j.status = 6) as checking_in,
          COUNT(*) FILTER (WHERE j.status = 7) as returned,
          COUNT(*) FILTER (WHERE j.status = 8) as requires_attention,
          COUNT(*) FILTER (WHERE j.status IN (4, 5) AND j.return_date::date < CURRENT_DATE) as overdue
        FROM jobs j
        WHERE j.is_deleted = false
      `),

      // 2. Close-out requirement status aggregation
      query(`
        SELECT
          jr.requirement_type,
          jr.status,
          COUNT(*) as count
        FROM job_requirements jr
        JOIN jobs j ON j.id = jr.job_id
        WHERE jr.phase = 'post_hire'
          AND j.is_deleted = false
          AND j.status IN (6, 7, 8)
        GROUP BY jr.requirement_type, jr.status
      `),

      // 3. Oldest unresolved return (days since return)
      query(`
        SELECT j.id, j.hh_job_number, j.job_name, j.client_name, j.company_name,
               j.return_date,
               CURRENT_DATE - j.return_date::date as days_since_return
        FROM jobs j
        WHERE j.is_deleted = false
          AND j.status IN (6, 7, 8)
          AND j.return_date IS NOT NULL
        ORDER BY j.return_date ASC
        LIMIT 5
      `),

      // 4. Excess records still pending on returning jobs
      query(`
        SELECT COUNT(*) as count,
               COALESCE(SUM(je.excess_amount_required), 0) as total_amount
        FROM job_excess je
        JOIN jobs j ON j.id = je.job_id
        WHERE je.excess_status IN ('needed', 'pending', 'taken', 'pre_auth')
          AND j.is_deleted = false
          AND j.status IN (6, 7, 8)
      `),
    ]);

    const [countsResult, closeoutResult, oldestResult, excessResult] = results;
    const counts = countsResult.rows[0];

    // Build close-out summary: for each requirement type, count how many are outstanding vs done
    const closeoutByType: Record<string, { total: number; done: number; in_progress: number; not_started: number; blocked: number }> = {};
    for (const row of closeoutResult.rows) {
      const type = row.requirement_type as string;
      if (!closeoutByType[type]) {
        closeoutByType[type] = { total: 0, done: 0, in_progress: 0, not_started: 0, blocked: 0 };
      }
      const count = parseInt(row.count as string);
      closeoutByType[type].total += count;
      const status = row.status as string;
      if (status === 'done') closeoutByType[type].done += count;
      else if (status === 'in_progress') closeoutByType[type].in_progress += count;
      else if (status === 'blocked') closeoutByType[type].blocked += count;
      else closeoutByType[type].not_started += count;
    }

    // Compute outstanding items per type (anything not done)
    const outstanding: Array<{ type: string; outstanding: number; total: number }> = [];
    for (const [type, stats] of Object.entries(closeoutByType)) {
      const notDone = stats.total - stats.done;
      if (notDone > 0) {
        outstanding.push({ type, outstanding: notDone, total: stats.total });
      }
    }

    res.json({
      counts: {
        active_returns: parseInt(counts.active_returns),
        checking_in: parseInt(counts.checking_in),
        returned: parseInt(counts.returned),
        requires_attention: parseInt(counts.requires_attention),
        overdue: parseInt(counts.overdue),
      },
      closeout_by_type: closeoutByType,
      outstanding,
      oldest_returns: oldestResult.rows.map(r => ({
        id: r.id,
        hh_job_number: r.hh_job_number,
        job_name: r.job_name,
        client_name: r.client_name || r.company_name,
        return_date: r.return_date,
        days_since_return: parseInt(r.days_since_return),
      })),
      excess_pending: {
        count: parseInt(excessResult.rows[0]?.count || '0'),
        total_amount: parseFloat(excessResult.rows[0]?.total_amount || '0'),
      },
    });
  } catch (error) {
    console.error('Dashboard returns-overview error:', error);
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

// ── GET /api/dashboard/cancellations-overview ─────────────────────────────
router.get('/cancellations-overview', async (req: AuthRequest, res: Response) => {
  try {
    const results = await Promise.all([
      // 1. Counts
      query(`
        SELECT
          COUNT(*) as total_cancelled,
          COUNT(*) FILTER (WHERE j.cancellation_refund > 0) as pending_refunds,
          COALESCE(SUM(j.cancellation_refund) FILTER (WHERE j.cancellation_refund > 0), 0) as total_refund_due,
          COALESCE(SUM(j.cancellation_fee), 0) as total_fees_retained
        FROM jobs j
        WHERE j.is_deleted = false AND j.pipeline_status = 'cancelled'
      `),

      // 2. Close-out requirements on cancelled jobs
      query(`
        SELECT jr.requirement_type, jr.status, COUNT(*) as count
        FROM job_requirements jr
        JOIN jobs j ON j.id = jr.job_id
        WHERE jr.phase = 'post_hire'
          AND j.is_deleted = false
          AND j.pipeline_status = 'cancelled'
        GROUP BY jr.requirement_type, jr.status
      `),

      // 3. Recent cancellations
      query(`
        SELECT j.id, j.hh_job_number, j.job_name, j.client_name, j.company_name,
               j.cancelled_at, j.cancellation_fee, j.cancellation_refund, j.cancellation_reason
        FROM jobs j
        WHERE j.is_deleted = false AND j.pipeline_status = 'cancelled'
        ORDER BY j.cancelled_at DESC NULLS LAST
        LIMIT 5
      `),
    ]);

    const [countsResult, closeoutResult, recentResult] = results;
    const counts = countsResult.rows[0];

    // Outstanding close-out items
    const outstanding: Array<{ type: string; outstanding: number }> = [];
    const byType: Record<string, { total: number; done: number }> = {};
    for (const row of closeoutResult.rows) {
      const type = row.requirement_type as string;
      if (!byType[type]) byType[type] = { total: 0, done: 0 };
      const count = parseInt(row.count as string);
      byType[type].total += count;
      if (row.status === 'done') byType[type].done += count;
    }
    for (const [type, stats] of Object.entries(byType)) {
      const notDone = stats.total - stats.done;
      if (notDone > 0) outstanding.push({ type, outstanding: notDone });
    }

    res.json({
      counts: {
        total_cancelled: parseInt(counts.total_cancelled),
        pending_refunds: parseInt(counts.pending_refunds),
        total_refund_due: parseFloat(counts.total_refund_due),
        total_fees_retained: parseFloat(counts.total_fees_retained),
      },
      outstanding,
      recent: recentResult.rows,
    });
  } catch (error) {
    console.error('Dashboard cancellations-overview error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
