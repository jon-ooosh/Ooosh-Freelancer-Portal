/**
 * Backline overview API — aggregate backline prep data across jobs.
 *
 * Reads from job_requirements (type='backline') + jobs table + hh_derived_flags
 * to produce a warehouse-friendly overview of what needs prepping and de-prepping.
 */

import { Router, Response } from 'express';
import { query } from '../config/database';
import { authenticate, authorize, AuthRequest } from '../middleware/auth';

const router = Router();
router.use(authenticate);
router.use(authorize('admin', 'manager', 'staff'));

// ── Backline overview — aggregate stats for warehouse team ─────────────

router.get('/overview', async (req: AuthRequest, res: Response) => {
  try {
    const days = Math.min(Math.max(parseInt(req.query.days as string) || 7, 1), 30);
    const now = new Date();
    const endDate = new Date(now);
    endDate.setDate(endDate.getDate() + days);
    const nowStr = now.toISOString().slice(0, 10);
    const endStr = endDate.toISOString().slice(0, 10);

    // Jobs going out within the period with backline requirements
    const goingOutResult = await query(
      `SELECT j.id, j.job_name, j.hh_job_number, j.job_date, j.return_date,
              j.company_name, j.client_name, j.pipeline_status,
              jr.id AS req_id, jr.status AS backline_status, jr.notes AS backline_notes,
              j.hh_derived_flags
       FROM jobs j
       JOIN job_requirements jr ON jr.job_id = j.id AND jr.requirement_type = 'backline'
       WHERE j.is_deleted = false
         AND j.job_date >= $1
         AND j.job_date <= $2
         AND j.pipeline_status IN ('confirmed', 'prepped', 'provisional', 'dispatched')
       ORDER BY j.job_date ASC`,
      [nowStr, endStr]
    );

    // Jobs returning within the period (need de-prep)
    const returningResult = await query(
      `SELECT j.id, j.job_name, j.hh_job_number, j.job_date, j.return_date,
              j.company_name, j.client_name, j.pipeline_status,
              jr.id AS req_id, jr.status AS backline_status, jr.notes AS backline_notes,
              j.hh_derived_flags
       FROM jobs j
       JOIN job_requirements jr ON jr.job_id = j.id AND jr.requirement_type = 'backline'
       WHERE j.is_deleted = false
         AND j.return_date >= $1
         AND j.return_date <= $2
         AND j.pipeline_status IN ('dispatched', 'returned_incomplete', 'returned', 'prepped', 'confirmed')
       ORDER BY j.return_date ASC`,
      [nowStr, endStr]
    );

    // Build job rows
    const goingOut = goingOutResult.rows.map(row => mapJobRow(row, 'out'));
    const returning = returningResult.rows.map(row => mapJobRow(row, 'return'));

    // Aggregate stats — prep time only for NOT-done jobs
    const goingOutStats = {
      jobCount: goingOut.length,
      notStarted: goingOut.filter(j => j.backlineStatus === 'not_started').length,
      inProgress: goingOut.filter(j => j.backlineStatus === 'in_progress').length,
      done: goingOut.filter(j => j.backlineStatus === 'done').length,
      problem: goingOut.filter(j => j.backlineStatus === 'blocked').length,
      totalItems: goingOut.reduce((sum, j) => sum + j.itemCount, 0),
      totalPrepMins: goingOut.reduce((sum, j) => sum + j.prepTimeMins, 0),
      remainingPrepMins: goingOut
        .filter(j => j.backlineStatus !== 'done')
        .reduce((sum, j) => sum + j.prepTimeMins, 0),
    };

    const returningStats = {
      jobCount: returning.length,
      totalItems: returning.reduce((sum, j) => sum + j.itemCount, 0),
      totalDeprepMins: returning.reduce((sum, j) => sum + j.deprepTimeMins, 0),
      remainingDeprepMins: returning
        .filter(j => j.backlineStatus !== 'done')
        .reduce((sum, j) => sum + j.deprepTimeMins, 0),
    };

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

function mapJobRow(row: any, direction: 'out' | 'return') {
  const flags = row.hh_derived_flags as DerivedFlags | null;
  return {
    id: row.id,
    reqId: row.req_id,
    jobName: row.job_name,
    hhJobNumber: row.hh_job_number,
    jobDate: row.job_date,
    returnDate: row.return_date,
    client: row.company_name || row.client_name,
    status: row.pipeline_status,
    backlineStatus: row.backline_status,
    itemCount: flags?.backline_item_count || 0,
    prepTimeMins: flags?.prep_time_by_category?.backline || 0,
    deprepTimeMins: flags?.prep_time_by_category?.backline || 0,
  };
}

export default router;
