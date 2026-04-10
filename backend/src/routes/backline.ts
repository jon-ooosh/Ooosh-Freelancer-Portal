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

router.get('/overview', async (_req: AuthRequest, res: Response) => {
  try {
    const now = new Date();
    const sevenDaysOut = new Date(now);
    sevenDaysOut.setDate(sevenDaysOut.getDate() + 7);
    const nowStr = now.toISOString().slice(0, 10);
    const sevenStr = sevenDaysOut.toISOString().slice(0, 10);

    // Jobs going out in next 7 days with backline requirements
    const goingOutResult = await query(
      `SELECT j.id, j.job_name, j.hh_job_number, j.job_date, j.return_date,
              j.company_name, j.client_name, j.pipeline_status,
              jr.status AS backline_status, jr.notes AS backline_notes,
              j.hh_derived_flags
       FROM jobs j
       JOIN job_requirements jr ON jr.job_id = j.id AND jr.requirement_type = 'backline'
       WHERE j.is_deleted = false
         AND j.job_date >= $1
         AND j.job_date <= $2
         AND j.pipeline_status IN ('confirmed', 'prepped', 'provisional')
       ORDER BY j.job_date ASC`,
      [nowStr, sevenStr]
    );

    // Jobs returning in next 7 days (need de-prep)
    const returningResult = await query(
      `SELECT j.id, j.job_name, j.hh_job_number, j.job_date, j.return_date,
              j.company_name, j.client_name, j.pipeline_status,
              jr.status AS backline_status, jr.notes AS backline_notes,
              j.hh_derived_flags
       FROM jobs j
       JOIN job_requirements jr ON jr.job_id = j.id AND jr.requirement_type = 'backline'
       WHERE j.is_deleted = false
         AND j.return_date >= $1
         AND j.return_date <= $2
         AND j.pipeline_status IN ('dispatched', 'returned_incomplete', 'returned', 'prepped')
       ORDER BY j.return_date ASC`,
      [nowStr, sevenStr]
    );

    // Build aggregate stats
    const goingOut = goingOutResult.rows.map(row => {
      const flags = row.hh_derived_flags as { backline_item_count?: number; prep_time_by_category?: { backline?: number } } | null;
      return {
        id: row.id,
        jobName: row.job_name,
        hhJobNumber: row.hh_job_number,
        jobDate: row.job_date,
        client: row.company_name || row.client_name,
        status: row.pipeline_status,
        backlineStatus: row.backline_status,
        itemCount: flags?.backline_item_count || 0,
        prepTimeMins: flags?.prep_time_by_category?.backline || 0,
      };
    });

    const returning = returningResult.rows.map(row => {
      const flags = row.hh_derived_flags as { backline_item_count?: number; prep_time_by_category?: { backline?: number } } | null;
      return {
        id: row.id,
        jobName: row.job_name,
        hhJobNumber: row.hh_job_number,
        returnDate: row.return_date,
        client: row.company_name || row.client_name,
        status: row.pipeline_status,
        backlineStatus: row.backline_status,
        itemCount: flags?.backline_item_count || 0,
        deprepTimeMins: flags?.prep_time_by_category?.backline || 0, // Same figure for de-prep
      };
    });

    const goingOutStats = {
      jobCount: goingOut.length,
      notStarted: goingOut.filter(j => j.backlineStatus === 'not_started').length,
      inProgress: goingOut.filter(j => j.backlineStatus === 'in_progress').length,
      done: goingOut.filter(j => j.backlineStatus === 'done').length,
      problem: goingOut.filter(j => j.backlineStatus === 'blocked').length,
      totalItems: goingOut.reduce((sum, j) => sum + j.itemCount, 0),
      totalPrepMins: goingOut.reduce((sum, j) => sum + j.prepTimeMins, 0),
    };

    const returningStats = {
      jobCount: returning.length,
      totalItems: returning.reduce((sum, j) => sum + j.itemCount, 0),
      totalDeprepMins: returning.reduce((sum, j) => sum + j.deprepTimeMins, 0),
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

export default router;
