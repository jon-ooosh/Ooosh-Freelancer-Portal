/**
 * Backline overview API — aggregate backline prep data across jobs.
 *
 * Reads from job_requirements (type='backline') + jobs table + hh_derived_flags
 * to produce a warehouse-friendly overview of what needs prepping and de-prepping.
 *
 * "Operational" = jobs that are actually booked and warehouse-relevant. This means
 * HH status 2/3/4 (Booked/Prepped/Part Dispatched), or HH 5 + OP pipeline_status =
 * 'prepped' (the "physically prepped, in the yard, waiting for staff to click Mark
 * as Dispatched" state). Provisional + Enquiry are EXCLUDED from operational views
 * because no warehouse work should happen until a hire is actually booked.
 *
 * Heads-up planning views: callers can opt in to seeing provisional and/or enquiry
 * jobs via ?include_provisional=true and/or ?include_enquiry=true. These come back
 * in a separate `unconfirmed` block so warehouse staff can input on capacity without
 * mixing speculative work into the headline stats.
 */

import { Router, Response } from 'express';
import { query } from '../config/database';
import { authenticate, authorize, AuthRequest, STAFF_ROLES } from '../middleware/auth';

const router = Router();
router.use(authenticate);
router.use(authorize(...STAFF_ROLES));

// HH statuses: 0=Enquiry, 1=Provisional, 2=Booked, 3=Prepped, 4=Part Dispatched (Prepping),
//              5=Dispatched, 6=Returned Incomplete, 7=Returned, 8=Requires Attention, 11=Completed

// Operational rule for "going out" — drives the headline stats and per-job lists.
// Booked / Prepped / Part Dispatched, OR HH 5 + OP held at 'prepped'. Excludes
// provisional + enquiry (those route through the heads-up planning queries).
const OPERATIONAL_GOING_OUT_SQL = `
  (j.status IN (2, 3, 4) OR (j.status = 5 AND j.pipeline_status = 'prepped'))
  AND j.pipeline_status NOT IN ('lost', 'cancelled')
`;

// Provisional planning bucket — pipeline_status = 'provisional' (deposit pending)
// or HH 1, with a backline requirement and a future-or-recent date.
const PROVISIONAL_GOING_OUT_SQL = `
  (j.status = 1 OR j.pipeline_status = 'provisional')
  AND j.pipeline_status NOT IN ('lost', 'cancelled')
`;

// Enquiry planning bucket — pre-provisional pipeline stages, HH still at Enquiry.
const ENQUIRY_GOING_OUT_SQL = `
  (j.status = 0 OR j.pipeline_status IN ('new_enquiry', 'quoting', 'paused'))
  AND j.pipeline_status NOT IN ('lost', 'cancelled', 'provisional')
`;

router.get('/overview', async (req: AuthRequest, res: Response) => {
  try {
    const days = Math.min(Math.max(parseInt(req.query.days as string) || 7, 1), 30);
    const includeProvisional = req.query.include_provisional === 'true';
    const includeEnquiry = req.query.include_enquiry === 'true';
    const now = new Date();
    const endDate = new Date(now);
    endDate.setDate(endDate.getDate() + days);
    const nowStr = now.toISOString().slice(0, 10);
    const endStr = endDate.toISOString().slice(0, 10);

    // Operational "going out" — actually-booked work the warehouse needs to prep.
    const goingOutResult = await query(
      `SELECT j.id, j.job_name, j.hh_job_number, j.job_date, j.return_date,
              j.company_name, j.client_name, j.pipeline_status, j.status AS hh_status,
              jr.id AS req_id, jr.status AS backline_status, jr.notes AS backline_notes,
              jr.hh_mismatch, jr.hh_mismatch_detail,
              j.hh_derived_flags
       FROM jobs j
       JOIN job_requirements jr ON jr.job_id = j.id AND jr.requirement_type = 'backline' AND jr.phase = 'pre_hire'
       WHERE j.is_deleted = false
         AND j.job_date >= $1
         AND j.job_date <= $2
         AND ${OPERATIONAL_GOING_OUT_SQL}
       ORDER BY j.job_date ASC`,
      [nowStr, endStr]
    );

    // Jobs returning: only jobs that have actually gone out (HH status >= 5 Dispatched)
    // OR OP pipeline confirms they're out/returning. Excludes jobs still being prepped.
    // HH status 8 (Requires Attention) is included — represents "returned with problems".
    const returningResult = await query(
      `SELECT DISTINCT ON (j.id) j.id, j.job_name, j.hh_job_number, j.job_date, j.return_date,
              j.company_name, j.client_name, j.pipeline_status, j.status AS hh_status,
              jr.id AS req_id, jr.status AS backline_status, jr.notes AS backline_notes,
              jr.hh_mismatch, jr.hh_mismatch_detail,
              j.hh_derived_flags, jr.phase
       FROM jobs j
       JOIN job_requirements jr ON jr.job_id = j.id AND jr.requirement_type = 'backline'
       WHERE j.is_deleted = false
         AND j.return_date >= $1
         AND j.return_date <= $2
         AND (j.status IN (5, 6, 7, 8)
              OR j.pipeline_status IN ('dispatched', 'returned_incomplete', 'returned'))
       ORDER BY j.id, jr.phase DESC`,
      [nowStr, endStr]
    );

    // Overdue going out: job_date < today AND operationally booked but not yet
    // dispatched (matches "going out" rule, restricted to past dates). Caps lookback
    // at 30 days. The auto-lose scheduler at 09:00 sweeps stale enquiries/provisional
    // separately — those don't surface here.
    const overdueOutResult = await query(
      `SELECT j.id, j.job_name, j.hh_job_number, j.job_date, j.return_date,
              j.company_name, j.client_name, j.pipeline_status, j.status AS hh_status,
              jr.id AS req_id, jr.status AS backline_status, jr.notes AS backline_notes,
              jr.hh_mismatch, jr.hh_mismatch_detail,
              j.hh_derived_flags,
              (CURRENT_DATE - j.job_date::date) AS days_overdue
       FROM jobs j
       JOIN job_requirements jr ON jr.job_id = j.id AND jr.requirement_type = 'backline' AND jr.phase = 'pre_hire'
       WHERE j.is_deleted = false
         AND j.job_date < $1
         AND j.job_date >= $1::date - INTERVAL '30 days'
         AND ${OPERATIONAL_GOING_OUT_SQL}
         AND jr.status != 'done'
       ORDER BY j.job_date ASC`,
      [nowStr]
    );

    // Overdue returning: return_date < today AND not yet returned (HH < 7).
    // Tightened to require the van to have actually gone out — a job stuck in
    // enquiry/provisional with a stale return_date isn't "overdue back", it's
    // stale data that the auto-lose scheduler will clear.
    const overdueReturnResult = await query(
      `SELECT DISTINCT ON (j.id) j.id, j.job_name, j.hh_job_number, j.job_date, j.return_date,
              j.company_name, j.client_name, j.pipeline_status, j.status AS hh_status,
              jr.id AS req_id, jr.status AS backline_status, jr.notes AS backline_notes,
              jr.hh_mismatch, jr.hh_mismatch_detail,
              j.hh_derived_flags, jr.phase,
              (CURRENT_DATE - j.return_date::date) AS days_overdue
       FROM jobs j
       JOIN job_requirements jr ON jr.job_id = j.id AND jr.requirement_type = 'backline'
       WHERE j.is_deleted = false
         AND j.return_date < $1
         AND j.return_date >= $1::date - INTERVAL '30 days'
         AND (j.status IN (5, 6) OR j.pipeline_status IN ('dispatched', 'returned_incomplete'))
       ORDER BY j.id, jr.phase DESC`,
      [nowStr]
    );

    // Optional heads-up planning queries: provisional and/or enquiry going-out
    // jobs surfaced separately from operational stats. Run only when toggled on
    // by the caller. Same date window as operational; same per-row data shape.
    const provisionalGoingOut = includeProvisional
      ? await query(
          `SELECT j.id, j.job_name, j.hh_job_number, j.job_date, j.return_date,
                  j.company_name, j.client_name, j.pipeline_status, j.status AS hh_status,
                  jr.id AS req_id, jr.status AS backline_status, jr.notes AS backline_notes,
                  jr.hh_mismatch, jr.hh_mismatch_detail,
                  j.hh_derived_flags
           FROM jobs j
           JOIN job_requirements jr ON jr.job_id = j.id AND jr.requirement_type = 'backline' AND jr.phase = 'pre_hire'
           WHERE j.is_deleted = false
             AND j.job_date >= $1
             AND j.job_date <= $2
             AND ${PROVISIONAL_GOING_OUT_SQL}
           ORDER BY j.job_date ASC`,
          [nowStr, endStr]
        )
      : null;

    const enquiryGoingOut = includeEnquiry
      ? await query(
          `SELECT j.id, j.job_name, j.hh_job_number, j.job_date, j.return_date,
                  j.company_name, j.client_name, j.pipeline_status, j.status AS hh_status,
                  jr.id AS req_id, jr.status AS backline_status, jr.notes AS backline_notes,
                  jr.hh_mismatch, jr.hh_mismatch_detail,
                  j.hh_derived_flags
           FROM jobs j
           JOIN job_requirements jr ON jr.job_id = j.id AND jr.requirement_type = 'backline' AND jr.phase = 'pre_hire'
           WHERE j.is_deleted = false
             AND j.job_date >= $1
             AND j.job_date <= $2
             AND ${ENQUIRY_GOING_OUT_SQL}
           ORDER BY j.job_date ASC`,
          [nowStr, endStr]
        )
      : null;

    // Build job rows — sort returning by return_date (DISTINCT ON breaks ordering)
    const goingOut = goingOutResult.rows.map(row => mapJobRow(row, 'out'));
    const returning = returningResult.rows
      .map(row => mapJobRow(row, 'return'))
      .sort((a, b) => {
        const da = a.returnDate ? new Date(a.returnDate).getTime() : 0;
        const db = b.returnDate ? new Date(b.returnDate).getTime() : 0;
        return da - db;
      });
    const overdueOut = overdueOutResult.rows.map(row => mapJobRow(row, 'out'));
    const overdueReturning = overdueReturnResult.rows
      .map(row => mapJobRow(row, 'return'))
      .sort((a, b) => {
        const da = a.returnDate ? new Date(a.returnDate).getTime() : 0;
        const db = b.returnDate ? new Date(b.returnDate).getTime() : 0;
        return da - db;
      });
    const provisionalJobs = provisionalGoingOut?.rows.map(row => mapJobRow(row, 'out')) ?? null;
    const enquiryJobs = enquiryGoingOut?.rows.map(row => mapJobRow(row, 'out')) ?? null;

    // Aggregate stats — operational only. The unconfirmed buckets carry their
    // own counts but deliberately don't roll up into the headline figures.
    const goingOutStats = buildStats(goingOut);
    const returningStats = buildStats(returning);
    const overdueOutStats = buildStats(overdueOut);
    const overdueReturnStats = buildStats(overdueReturning);

    res.json({
      data: {
        goingOut: { stats: goingOutStats, jobs: goingOut },
        returning: { stats: returningStats, jobs: returning },
        overdueOut: { stats: overdueOutStats, jobs: overdueOut },
        overdueReturning: { stats: overdueReturnStats, jobs: overdueReturning },
        unconfirmed: {
          provisional: provisionalJobs
            ? { stats: buildStats(provisionalJobs), jobs: provisionalJobs }
            : null,
          enquiry: enquiryJobs
            ? { stats: buildStats(enquiryJobs), jobs: enquiryJobs }
            : null,
        },
      },
    });
  } catch (err) {
    console.error('Error fetching backline overview:', err);
    res.status(500).json({ error: 'Failed to fetch backline overview' });
  }
});

// ── PATCH status from overview ──────────────────────────────────────────

router.patch('/status/:requirementId', async (req: AuthRequest, res: Response) => {
  try {
    const { requirementId } = req.params;
    const { status } = req.body;
    const validStatuses = ['not_started', 'in_progress', 'done', 'blocked'];
    if (!validStatuses.includes(status)) {
      return res.status(400).json({ error: `Invalid status: ${status}` });
    }
    const result = await query(
      `UPDATE job_requirements SET status = $1, updated_at = NOW()
       WHERE id = $2 AND requirement_type = 'backline'
       RETURNING id, status`,
      [status, requirementId]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Backline requirement not found' });
    }
    res.json({ data: result.rows[0] });
  } catch (err) {
    console.error('Error updating backline status:', err);
    res.status(500).json({ error: 'Failed to update status' });
  }
});

// ── Helpers ────────────────────────────────────────────────────────────

interface DerivedFlags {
  backline_item_count?: number;
  prep_time_by_category?: { backline?: number };
}

interface BacklineJob {
  id: string;
  reqId: string;
  jobName: string;
  hhJobNumber: number | null;
  jobDate: string | null;
  returnDate: string | null;
  client: string;
  pipelineStatus: string;
  hhStatus: number;
  backlineStatus: string;
  itemCount: number;
  prepTimeMins: number;
  deprepTimeMins: number;
  effectivelyDone: boolean; // true if backline_status=done OR HH status >= prepped
  hasMismatch: boolean;     // true if HH items changed since last action
  mismatchDetail: string | null;
  daysOverdue?: number;     // populated for overdue lists only
}

function mapJobRow(row: any, _direction: 'out' | 'return'): BacklineJob {
  const flags = row.hh_derived_flags as DerivedFlags | null;
  const hhStatus = row.hh_status || 0;
  // Consider effectively done if: explicitly marked done, OR HH shows dispatched+ (5+).
  // HH 4 (Part Dispatched) means prep is IN PROGRESS, not done — must not be effectivelyDone
  // or the page would hide its remaining prep time and treat the job as complete.
  // HH 3 (Prepped) IS done from a prep perspective.
  const effectivelyDone = row.backline_status === 'done' || hhStatus === 3 || hhStatus >= 5;

  return {
    id: row.id,
    reqId: row.req_id,
    jobName: row.job_name,
    hhJobNumber: row.hh_job_number,
    jobDate: row.job_date,
    returnDate: row.return_date,
    client: row.company_name || row.client_name,
    pipelineStatus: row.pipeline_status,
    hhStatus,
    backlineStatus: row.backline_status,
    itemCount: flags?.backline_item_count || 0,
    prepTimeMins: flags?.prep_time_by_category?.backline || 0,
    deprepTimeMins: flags?.prep_time_by_category?.backline || 0,
    effectivelyDone,
    hasMismatch: row.hh_mismatch === true,
    mismatchDetail: row.hh_mismatch_detail || null,
    daysOverdue: row.days_overdue !== undefined && row.days_overdue !== null
      ? Math.max(0, parseInt(String(row.days_overdue), 10) || 0)
      : undefined,
  };
}

function buildStats(jobs: BacklineJob[]) {
  return {
    jobCount: jobs.length,
    notStarted: jobs.filter(j => j.backlineStatus === 'not_started' && !j.effectivelyDone).length,
    inProgress: jobs.filter(j => j.backlineStatus === 'in_progress').length,
    done: jobs.filter(j => j.effectivelyDone).length,
    problem: jobs.filter(j => j.backlineStatus === 'blocked').length,
    totalItems: jobs.reduce((sum, j) => sum + j.itemCount, 0),
    totalPrepMins: jobs.reduce((sum, j) => sum + j.prepTimeMins, 0),
    totalDeprepMins: jobs.reduce((sum, j) => sum + j.deprepTimeMins, 0),
    remainingPrepMins: jobs
      .filter(j => !j.effectivelyDone)
      .reduce((sum, j) => sum + j.prepTimeMins, 0),
    // For de-prep: "effectively done" for prep doesn't mean de-prep is done.
    // De-prep remaining = all returning jobs that haven't been marked 'done' on their post_hire card
    // (or pre_hire card if no post_hire exists). Don't use effectivelyDone here.
    remainingDeprepMins: jobs
      .filter(j => j.backlineStatus !== 'done')
      .reduce((sum, j) => sum + j.deprepTimeMins, 0),
  };
}

export default router;
