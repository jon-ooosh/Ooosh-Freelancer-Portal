/**
 * Backline overview API — aggregate backline prep data across jobs.
 *
 * Reads from job_requirements (type='backline') + jobs table + hh_derived_flags
 * to produce a warehouse-friendly overview of what needs prepping and de-prepping.
 *
 * Uses HireHop status (jobs.status integer) as primary filter since OP pipeline_status
 * can lag behind HH — many jobs are confirmed in HH but still show as enquiry in OP.
 */

import { Router, Response } from 'express';
import { query } from '../config/database';
import { authenticate, authorize, AuthRequest, STAFF_ROLES } from '../middleware/auth';

const router = Router();
router.use(authenticate);
router.use(authorize(...STAFF_ROLES));

// HH statuses: 0=Enquiry, 1=Provisional, 2=Booked, 3=Prepped, 5=Dispatched,
//              6=Returned Incomplete, 7=Returned, 11=Completed
// For "going out" we want: Provisional(1), Booked(2), Prepped(3), Dispatched(5)
// For "coming back" we want: Dispatched(5), Returned Incomplete(6), Returned(7), Booked(2), Prepped(3)

router.get('/overview', async (req: AuthRequest, res: Response) => {
  try {
    const days = Math.min(Math.max(parseInt(req.query.days as string) || 7, 1), 30);
    const now = new Date();
    const endDate = new Date(now);
    endDate.setDate(endDate.getDate() + days);
    const nowStr = now.toISOString().slice(0, 10);
    const endStr = endDate.toISOString().slice(0, 10);

    // Jobs going out: use HH status as primary filter (more reliable than OP pipeline_status)
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
         AND (j.status IN (1, 2, 3, 5)
              OR j.pipeline_status IN ('confirmed', 'prepped', 'provisional', 'dispatched'))
       ORDER BY j.job_date ASC`,
      [nowStr, endStr]
    );

    // Jobs returning: only jobs that have actually gone out (HH status >= 5 Dispatched)
    // OR OP pipeline confirms they're out/returning. Excludes jobs still being prepped.
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
         AND (j.status IN (5, 6, 7)
              OR j.pipeline_status IN ('dispatched', 'returned_incomplete', 'returned'))
       ORDER BY j.id, jr.phase DESC`,
      [nowStr, endStr]
    );

    // Build job rows — sort returning by return_date (DISTINCT ON breaks ordering)
    const goingOut = goingOutResult.rows.map(row => mapJobRow(row, 'out'));
    const returning = returningResult.rows
      .map(row => mapJobRow(row, 'return'))
      .sort((a, b) => {
        const da = a.returnDate ? new Date(a.returnDate).getTime() : 0;
        const db = b.returnDate ? new Date(b.returnDate).getTime() : 0;
        return da - db;
      });

    // Aggregate stats
    // For remaining prep time: exclude jobs where backline status is 'done'
    // OR where HH status is prepped(3) or dispatched(5) — work is done even if card wasn't updated
    const goingOutStats = buildStats(goingOut);
    const returningStats = buildStats(returning);

    res.json({
      data: {
        goingOut: { stats: goingOutStats, jobs: goingOut },
        returning: { stats: returningStats, jobs: returning },
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
}

function mapJobRow(row: any, _direction: 'out' | 'return'): BacklineJob {
  const flags = row.hh_derived_flags as DerivedFlags | null;
  const hhStatus = row.hh_status || 0;
  // Consider effectively done if: explicitly marked done, OR HH shows prepped/dispatched+
  const effectivelyDone = row.backline_status === 'done' || hhStatus >= 3;

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
