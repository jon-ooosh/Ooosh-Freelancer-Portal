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
 *
 * Going Out is windowed + displayed on the OUTGOING date (COALESCE(out_date,
 * job_date)) — that's when kit physically leaves, which is what the warehouse
 * plans against (often the same as job start, sometimes a day earlier).
 * Coming Back is windowed on return_date and reads the POST-HIRE (de-prep) card.
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

// Band name for a job (searchable) — first org linked with role='band'.
const BAND_NAME_SQL = `
  (SELECT o.name FROM job_organisations jo
     JOIN organisations o ON o.id = jo.organisation_id
   WHERE jo.job_id = j.id AND jo.role = 'band' LIMIT 1) AS band_name`;

// Shared row shape. Going-out lists key on the outgoing date; returning lists
// key on return_date. Location joins from the pre-hire card (returning cards
// won't usually have one, which is fine — location is a pre-hire concept).
const ROW_COLS = `
  j.id, j.job_name, j.hh_job_number, j.job_date, j.out_date, j.return_date,
  j.company_name, j.client_name, j.pipeline_status, j.status AS hh_status,
  jr.id AS req_id, jr.status AS backline_status, jr.notes AS backline_notes,
  jr.hh_mismatch, jr.hh_mismatch_detail,
  j.hh_derived_flags,
  ${BAND_NAME_SQL},
  bl.location_type, bl.vehicle_reg AS location_reg, bl.detail AS location_detail`;

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
    // Windowed + ordered on the outgoing date (COALESCE(out_date, job_date)).
    const goingOutResult = await query(
      `SELECT ${ROW_COLS}
       FROM jobs j
       JOIN job_requirements jr ON jr.job_id = j.id AND jr.requirement_type = 'backline' AND jr.phase = 'pre_hire'
       LEFT JOIN backline_locations bl ON bl.job_requirement_id = jr.id
       WHERE j.is_deleted = false
         AND COALESCE(j.out_date, j.job_date) >= $1
         AND COALESCE(j.out_date, j.job_date) <= $2
         AND ${OPERATIONAL_GOING_OUT_SQL}
       ORDER BY COALESCE(j.out_date, j.job_date) ASC`,
      [nowStr, endStr]
    );

    // Jobs returning: only jobs that have actually gone out (HH status >= 5 Dispatched)
    // OR OP pipeline confirms they're out/returning. Excludes jobs still being prepped.
    // HH status 8 (Requires Attention) is included — represents "returned with problems".
    // DISTINCT ON prefers the POST-HIRE (de-prep) card so "Coming Back" reflects de-prep,
    // not the already-done prep card.
    //
    // DEPARTURE-DATE GATE: the warehouse checks items out in HH the day BEFORE a van
    // physically leaves, so a not-yet-departed job can already be HH-5 while OP holds
    // it at 'prepped'. That HH-5 alone would wrongly pull it into Coming Back. Require
    // the outgoing date to have actually arrived (COALESCE(out_date, job_date) <= today)
    // — HH 6/7/8 (definitively returned) always satisfy this anyway. A not-yet-left job
    // stays where it belongs, in Going Out.
    const returningResult = await query(
      `SELECT DISTINCT ON (j.id) ${ROW_COLS}, jr.phase
       FROM jobs j
       JOIN job_requirements jr ON jr.job_id = j.id AND jr.requirement_type = 'backline'
       LEFT JOIN backline_locations bl ON bl.job_requirement_id = jr.id
       WHERE j.is_deleted = false
         AND j.return_date >= $1
         AND j.return_date <= $2
         AND COALESCE(j.out_date, j.job_date)::date <= CURRENT_DATE
         AND (j.status IN (5, 6, 7, 8)
              OR j.pipeline_status IN ('dispatched', 'returned_incomplete', 'returned'))
       ORDER BY j.id, CASE WHEN jr.phase = 'post_hire' THEN 0 ELSE 1 END`,
      [nowStr, endStr]
    );

    // Overdue going out: outgoing date < today AND operationally booked but not yet
    // dispatched (matches "going out" rule, restricted to past dates). Caps lookback
    // at 30 days. The auto-lose scheduler at 09:00 sweeps stale enquiries/provisional
    // separately — those don't surface here.
    const overdueOutResult = await query(
      `SELECT ${ROW_COLS},
              (CURRENT_DATE - COALESCE(j.out_date, j.job_date)::date) AS days_overdue
       FROM jobs j
       JOIN job_requirements jr ON jr.job_id = j.id AND jr.requirement_type = 'backline' AND jr.phase = 'pre_hire'
       LEFT JOIN backline_locations bl ON bl.job_requirement_id = jr.id
       WHERE j.is_deleted = false
         AND COALESCE(j.out_date, j.job_date) < $1
         AND COALESCE(j.out_date, j.job_date) >= $1::date - INTERVAL '30 days'
         AND ${OPERATIONAL_GOING_OUT_SQL}
         AND jr.status != 'done'
       ORDER BY COALESCE(j.out_date, j.job_date) ASC`,
      [nowStr]
    );

    // Overdue returning: return_date < today AND not yet returned (HH < 7).
    // Tightened to require the van to have actually gone out — a job stuck in
    // enquiry/provisional with a stale return_date isn't "overdue back", it's
    // stale data that the auto-lose scheduler will clear. Prefers post-hire card.
    const overdueReturnResult = await query(
      `SELECT DISTINCT ON (j.id) ${ROW_COLS}, jr.phase,
              (CURRENT_DATE - j.return_date::date) AS days_overdue
       FROM jobs j
       JOIN job_requirements jr ON jr.job_id = j.id AND jr.requirement_type = 'backline'
       LEFT JOIN backline_locations bl ON bl.job_requirement_id = jr.id
       WHERE j.is_deleted = false
         AND j.return_date < $1
         AND j.return_date >= $1::date - INTERVAL '30 days'
         AND COALESCE(j.out_date, j.job_date)::date <= CURRENT_DATE
         AND (j.status IN (5, 6) OR j.pipeline_status IN ('dispatched', 'returned_incomplete'))
       ORDER BY j.id, CASE WHEN jr.phase = 'post_hire' THEN 0 ELSE 1 END`,
      [nowStr]
    );

    // Optional heads-up planning queries: provisional and/or enquiry going-out
    // jobs surfaced separately from operational stats. Run only when toggled on
    // by the caller. Same date window as operational; same per-row data shape.
    const provisionalGoingOut = includeProvisional
      ? await query(
          `SELECT ${ROW_COLS}
           FROM jobs j
           JOIN job_requirements jr ON jr.job_id = j.id AND jr.requirement_type = 'backline' AND jr.phase = 'pre_hire'
           LEFT JOIN backline_locations bl ON bl.job_requirement_id = jr.id
           WHERE j.is_deleted = false
             AND COALESCE(j.out_date, j.job_date) >= $1
             AND COALESCE(j.out_date, j.job_date) <= $2
             AND ${PROVISIONAL_GOING_OUT_SQL}
           ORDER BY COALESCE(j.out_date, j.job_date) ASC`,
          [nowStr, endStr]
        )
      : null;

    const enquiryGoingOut = includeEnquiry
      ? await query(
          `SELECT ${ROW_COLS}
           FROM jobs j
           JOIN job_requirements jr ON jr.job_id = j.id AND jr.requirement_type = 'backline' AND jr.phase = 'pre_hire'
           LEFT JOIN backline_locations bl ON bl.job_requirement_id = jr.id
           WHERE j.is_deleted = false
             AND COALESCE(j.out_date, j.job_date) >= $1
             AND COALESCE(j.out_date, j.job_date) <= $2
             AND ${ENQUIRY_GOING_OUT_SQL}
           ORDER BY COALESCE(j.out_date, j.job_date) ASC`,
          [nowStr, endStr]
        )
      : null;

    // Build job rows — sort returning by return_date (DISTINCT ON breaks ordering)
    const goingOut = goingOutResult.rows.map(row => mapJobRow(row));
    const returning = returningResult.rows
      .map(row => mapJobRow(row))
      .sort((a, b) => {
        const da = a.returnDate ? new Date(a.returnDate).getTime() : 0;
        const db = b.returnDate ? new Date(b.returnDate).getTime() : 0;
        return da - db;
      });
    const overdueOut = overdueOutResult.rows.map(row => mapJobRow(row));
    const overdueReturning = overdueReturnResult.rows
      .map(row => mapJobRow(row))
      .sort((a, b) => {
        const da = a.returnDate ? new Date(a.returnDate).getTime() : 0;
        const db = b.returnDate ? new Date(b.returnDate).getTime() : 0;
        return da - db;
      });
    const provisionalJobs = provisionalGoingOut?.rows.map(row => mapJobRow(row)) ?? null;
    const enquiryJobs = enquiryGoingOut?.rows.map(row => mapJobRow(row)) ?? null;

    // Aggregate stats — operational only. The unconfirmed buckets carry their
    // own counts but deliberately don't roll up into the headline figures.
    // Going-out lists measure prep; returning lists measure de-prep.
    const goingOutStats = buildStats(goingOut, 'prep');
    const returningStats = buildStats(returning, 'deprep');
    const overdueOutStats = buildStats(overdueOut, 'prep');
    const overdueReturnStats = buildStats(overdueReturning, 'deprep');

    res.json({
      data: {
        goingOut: { stats: goingOutStats, jobs: goingOut },
        returning: { stats: returningStats, jobs: returning },
        overdueOut: { stats: overdueOutStats, jobs: overdueOut },
        overdueReturning: { stats: overdueReturnStats, jobs: overdueReturning },
        unconfirmed: {
          provisional: provisionalJobs
            ? { stats: buildStats(provisionalJobs, 'prep'), jobs: provisionalJobs }
            : null,
          enquiry: enquiryJobs
            ? { stats: buildStats(enquiryJobs, 'prep'), jobs: enquiryJobs }
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
       RETURNING id, status, job_id, phase, notes`,
      [status, requirementId]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Backline requirement not found' });
    }

    // Problem status → make sure a register issue exists (deduped per job
    // inside the helper). Same hook as the requirements PATCH path.
    const updated = result.rows[0];
    if (status === 'blocked' && updated.job_id) {
      const { ensureBacklineProblemIssue } = await import('../services/job-issues');
      ensureBacklineProblemIssue({
        jobId: updated.job_id,
        requirementId: updated.id,
        phase: updated.phase,
        notes: updated.notes,
        actorUserId: req.user!.id,
      }).catch((err) => console.warn('[backline] issue hook failed:', err));
    }

    res.json({ data: { id: updated.id, status: updated.status } });
  } catch (err) {
    console.error('Error updating backline status:', err);
    res.status(500).json({ error: 'Failed to update status' });
  }
});

// ── "Where is it?" location tracking ────────────────────────────────────

const LOCATION_TYPES = ['van', 'loading_bay', 'rehearsal', 'other'];

/**
 * Context for the location modal: current location, vans allocated to this job
 * (to pre-fill the reg picker), and the active fleet regs (suggestions).
 */
router.get('/location-context/:requirementId', async (req: AuthRequest, res: Response) => {
  try {
    const { requirementId } = req.params;
    const reqRow = await query(
      `SELECT jr.id, jr.job_id, j.hh_job_number
       FROM job_requirements jr
       JOIN jobs j ON j.id = jr.job_id
       WHERE jr.id = $1 AND jr.requirement_type = 'backline'`,
      [requirementId]
    );
    if (reqRow.rows.length === 0) {
      return res.status(404).json({ error: 'Backline requirement not found' });
    }
    const { job_id, hh_job_number } = reqRow.rows[0];

    const [locResult, allocResult, fleetResult] = await Promise.all([
      query(
        `SELECT location_type, vehicle_reg, detail FROM backline_locations
         WHERE job_requirement_id = $1`,
        [requirementId]
      ),
      // Vans allocated to this job (dual-match: hire-form rows carry job_id,
      // staff-allocation rows carry only hirehop_job_id). Soft-cancelled rows
      // excluded.
      query(
        `SELECT DISTINCT fv.reg
         FROM vehicle_hire_assignments vha
         JOIN fleet_vehicles fv ON fv.id = vha.vehicle_id
         WHERE (vha.job_id = $1 OR ($2::int IS NOT NULL AND vha.hirehop_job_id = $2))
           AND vha.vehicle_id IS NOT NULL
           AND vha.status != 'cancelled'
         ORDER BY fv.reg`,
        [job_id, hh_job_number ?? null]
      ),
      query(
        `SELECT reg FROM fleet_vehicles WHERE is_active = true AND reg IS NOT NULL ORDER BY reg`,
        []
      ),
    ]);

    const loc = locResult.rows[0]
      ? {
          type: locResult.rows[0].location_type,
          reg: locResult.rows[0].vehicle_reg,
          detail: locResult.rows[0].detail,
        }
      : null;

    res.json({
      data: {
        location: loc,
        allocatedRegs: allocResult.rows.map(r => r.reg).filter(Boolean),
        fleetRegs: fleetResult.rows.map(r => r.reg).filter(Boolean),
      },
    });
  } catch (err) {
    console.error('Error fetching backline location context:', err);
    res.status(500).json({ error: 'Failed to fetch location context' });
  }
});

/** Upsert the current location for a backline card. */
router.put('/location/:requirementId', async (req: AuthRequest, res: Response) => {
  try {
    const { requirementId } = req.params;
    const { location_type, vehicle_reg, detail } = req.body;

    if (!LOCATION_TYPES.includes(location_type)) {
      return res.status(400).json({ error: `Invalid location_type: ${location_type}` });
    }

    const reqRow = await query(
      `SELECT id, job_id, status FROM job_requirements
       WHERE id = $1 AND requirement_type = 'backline'`,
      [requirementId]
    );
    if (reqRow.rows.length === 0) {
      return res.status(404).json({ error: 'Backline requirement not found' });
    }
    // Gate: can't stage kit that's still "to do" — it has to be at least being
    // worked on before it can physically be somewhere.
    if (reqRow.rows[0].status === 'not_started') {
      return res.status(400).json({
        error: 'Mark the backline as Working On It or Done before recording where it is.',
      });
    }

    const reg = location_type === 'van' ? (vehicle_reg?.trim() || null) : null;
    const det = typeof detail === 'string' ? detail.trim().slice(0, 500) || null : null;

    const result = await query(
      `INSERT INTO backline_locations
         (job_requirement_id, job_id, location_type, vehicle_reg, detail, updated_by, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, NOW())
       ON CONFLICT (job_requirement_id) DO UPDATE
         SET location_type = EXCLUDED.location_type,
             vehicle_reg = EXCLUDED.vehicle_reg,
             detail = EXCLUDED.detail,
             updated_by = EXCLUDED.updated_by,
             updated_at = NOW()
       RETURNING location_type, vehicle_reg, detail`,
      [requirementId, reqRow.rows[0].job_id, location_type, reg, det, req.user!.id]
    );

    res.json({
      data: {
        type: result.rows[0].location_type,
        reg: result.rows[0].vehicle_reg,
        detail: result.rows[0].detail,
      },
    });
  } catch (err) {
    console.error('Error saving backline location:', err);
    res.status(500).json({ error: 'Failed to save location' });
  }
});

/** Clear the recorded location for a backline card. */
router.delete('/location/:requirementId', async (req: AuthRequest, res: Response) => {
  try {
    const { requirementId } = req.params;
    await query('DELETE FROM backline_locations WHERE job_requirement_id = $1', [requirementId]);
    res.json({ data: { cleared: true } });
  } catch (err) {
    console.error('Error clearing backline location:', err);
    res.status(500).json({ error: 'Failed to clear location' });
  }
});

// ── Helpers ────────────────────────────────────────────────────────────

interface DerivedFlags {
  backline_item_count?: number;
  prep_time_by_category?: { backline?: number };
}

interface BacklineLocation {
  type: 'van' | 'loading_bay' | 'rehearsal' | 'other';
  reg: string | null;
  detail: string | null;
}

interface BacklineJob {
  id: string;
  reqId: string;
  jobName: string;
  hhJobNumber: number | null;
  jobDate: string | null;
  outDate: string | null;
  returnDate: string | null;
  client: string;
  bandName: string | null;
  pipelineStatus: string;
  hhStatus: number;
  backlineStatus: string;
  itemCount: number;
  prepTimeMins: number;
  deprepTimeMins: number;
  effectivelyDone: boolean; // true if backline_status=done OR HH status >= prepped
  hasMismatch: boolean;     // true if HH items changed since last action
  mismatchDetail: string | null;
  location: BacklineLocation | null;
  daysOverdue?: number;     // populated for overdue lists only
}

function mapJobRow(row: any): BacklineJob {
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
    outDate: row.out_date || row.job_date,
    returnDate: row.return_date,
    client: row.company_name || row.client_name,
    bandName: row.band_name || null,
    pipelineStatus: row.pipeline_status,
    hhStatus,
    backlineStatus: row.backline_status,
    itemCount: flags?.backline_item_count || 0,
    prepTimeMins: flags?.prep_time_by_category?.backline || 0,
    deprepTimeMins: flags?.prep_time_by_category?.backline || 0,
    effectivelyDone,
    hasMismatch: row.hh_mismatch === true,
    mismatchDetail: row.hh_mismatch_detail || null,
    location: row.location_type
      ? { type: row.location_type, reg: row.location_reg || null, detail: row.location_detail || null }
      : null,
    daysOverdue: row.days_overdue !== undefined && row.days_overdue !== null
      ? Math.max(0, parseInt(String(row.days_overdue), 10) || 0)
      : undefined,
  };
}

/**
 * Aggregate stats. `mode` decides what "done" means:
 *  - 'prep'   → prep done (effectivelyDone: card done OR HH prepped/dispatched)
 *  - 'deprep' → de-prep card done (backlineStatus === 'done'); HH status is
 *               irrelevant because a returning job is always HH-dispatched+.
 */
function buildStats(jobs: BacklineJob[], mode: 'prep' | 'deprep') {
  const isDone = (j: BacklineJob) => (mode === 'deprep' ? j.backlineStatus === 'done' : j.effectivelyDone);
  return {
    jobCount: jobs.length,
    notStarted: jobs.filter(j => j.backlineStatus === 'not_started' && !isDone(j)).length,
    inProgress: jobs.filter(j => j.backlineStatus === 'in_progress').length,
    done: jobs.filter(j => isDone(j)).length,
    problem: jobs.filter(j => j.backlineStatus === 'blocked').length,
    totalItems: jobs.reduce((sum, j) => sum + j.itemCount, 0),
    totalPrepMins: jobs.reduce((sum, j) => sum + j.prepTimeMins, 0),
    totalDeprepMins: jobs.reduce((sum, j) => sum + j.deprepTimeMins, 0),
    remainingPrepMins: jobs
      .filter(j => !j.effectivelyDone)
      .reduce((sum, j) => sum + j.prepTimeMins, 0),
    // De-prep remaining = returning jobs whose de-prep card isn't 'done'.
    remainingDeprepMins: jobs
      .filter(j => j.backlineStatus !== 'done')
      .reduce((sum, j) => sum + j.deprepTimeMins, 0),
  };
}

export default router;
