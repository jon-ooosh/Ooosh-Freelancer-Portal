import { Router, Response } from 'express';
import { authenticate, authorize, AuthRequest, STAFF_ROLES } from '../middleware/auth';
import { isHireHopConfigured } from '../config/hirehop';
import { previewHireHopSync, syncContactsFromHireHop } from '../services/hirehop-sync';
import { previewHireHopJobSync, syncJobsFromHireHop } from '../services/hirehop-job-sync';
import { query } from '../config/database';
import { hhBroker } from '../services/hirehop-broker';

const router = Router();
router.use(authenticate);
router.use(authorize(...STAFF_ROLES));

// GET /api/hirehop/status — check if HireHop is configured
router.get('/status', async (_req: AuthRequest, res: Response) => {
  res.json({
    configured: isHireHopConfigured(),
    domain: process.env.HIREHOP_DOMAIN || 'myhirehop.com',
  });
});

// GET /api/hirehop/preview — preview what would be synced (dry run)
router.get('/preview', async (_req: AuthRequest, res: Response) => {
  try {
    if (!isHireHopConfigured()) {
      res.status(400).json({ error: 'HireHop not configured. Set HIREHOP_API_TOKEN in .env' });
      return;
    }

    const preview = await previewHireHopSync();
    res.json(preview);
  } catch (error) {
    console.error('HireHop preview error:', error);
    res.status(500).json({ error: error instanceof Error ? error.message : 'Preview failed' });
  }
});

// POST /api/hirehop/sync — run the contact sync from HireHop
router.post('/sync', async (req: AuthRequest, res: Response) => {
  try {
    if (!isHireHopConfigured()) {
      res.status(400).json({ error: 'HireHop not configured. Set HIREHOP_API_TOKEN in .env' });
      return;
    }

    const result = await syncContactsFromHireHop(req.user!.id);
    res.json(result);
  } catch (error) {
    console.error('HireHop sync error:', error);
    res.status(500).json({ error: error instanceof Error ? error.message : 'Sync failed' });
  }
});

// ── Job Sync ─────────────────────────────────────────────────────────────

// GET /api/hirehop/jobs/preview — preview what jobs would be synced
router.get('/jobs/preview', async (_req: AuthRequest, res: Response) => {
  try {
    if (!isHireHopConfigured()) {
      res.status(400).json({ error: 'HireHop not configured. Set HIREHOP_API_TOKEN in .env' });
      return;
    }

    const preview = await previewHireHopJobSync();
    res.json(preview);
  } catch (error) {
    console.error('HireHop job preview error:', error);
    res.status(500).json({ error: error instanceof Error ? error.message : 'Job preview failed' });
  }
});

// POST /api/hirehop/jobs/sync — run the job sync from HireHop
router.post('/jobs/sync', async (req: AuthRequest, res: Response) => {
  try {
    if (!isHireHopConfigured()) {
      res.status(400).json({ error: 'HireHop not configured. Set HIREHOP_API_TOKEN in .env' });
      return;
    }

    // Log sync start
    const logResult = await query(
      `INSERT INTO sync_log (sync_type, triggered_by) VALUES ('jobs', 'manual') RETURNING id`
    );
    const logId = logResult.rows[0].id;

    const result = await syncJobsFromHireHop(req.user!.id);

    // Log sync completion
    await query(
      `UPDATE sync_log SET status = 'completed', completed_at = NOW(), result = $1 WHERE id = $2`,
      [JSON.stringify(result), logId]
    );

    res.json(result);
  } catch (error) {
    console.error('HireHop job sync error:', error);
    res.status(500).json({ error: error instanceof Error ? error.message : 'Job sync failed' });
  }
});

// GET /api/hirehop/jobs/last-sync — get last sync info
router.get('/jobs/last-sync', async (_req: AuthRequest, res: Response) => {
  try {
    const result = await query(
      `SELECT * FROM sync_log WHERE sync_type = 'jobs' ORDER BY started_at DESC LIMIT 1`
    );
    res.json(result.rows[0] || null);
  } catch {
    res.json(null);
  }
});

// GET /api/hirehop/jobs — list synced jobs from our DB
router.get('/jobs', async (req: AuthRequest, res: Response) => {
  try {
    const {
      status, search, ooh_only, manager, service_type,
      date_from, date_to, date_field,
      has_issues, has_retro, overdue,
      sort,
      page = '1', limit = '50',
    } = req.query;
    const offset = (parseInt(page as string) - 1) * parseInt(limit as string);

    let whereClause = 'WHERE is_deleted = false';
    const params: unknown[] = [];

    if (status !== undefined && status !== '') {
      const statuses = (status as string).split(',').map(s => parseInt(s.trim())).filter(n => !isNaN(n));
      if (statuses.length > 0) {
        params.push(statuses);
        whereClause += ` AND status = ANY($${params.length})`;
      }
    }

    // Date range. Defaults to filtering on return_date (used by the Returns
    // page); pass date_field=job_date to filter on departure date instead.
    const allowedDateFields: Record<string, string> = {
      return_date: 'return_date',
      job_date: 'job_date',
      job_end: 'job_end',
    };
    const dateColumn = allowedDateFields[(date_field as string) || 'return_date'] || 'return_date';
    if (date_from && (date_from as string).trim()) {
      params.push((date_from as string).trim());
      whereClause += ` AND ${dateColumn}::date >= $${params.length}`;
    }
    if (date_to && (date_to as string).trim()) {
      params.push((date_to as string).trim());
      whereClause += ` AND ${dateColumn}::date <= $${params.length}`;
    }

    if (search && (search as string).trim()) {
      params.push(`%${(search as string).trim()}%`);
      whereClause += ` AND (job_name ILIKE $${params.length} OR client_name ILIKE $${params.length} OR company_name ILIKE $${params.length} OR venue_name ILIKE $${params.length} OR CAST(hh_job_number AS TEXT) ILIKE $${params.length})`;
    }

    // OOH return filter — only show jobs with at least one assignment
    // currently flagged for out-of-hours return (and still open).
    if (ooh_only === 'true' || ooh_only === '1') {
      whereClause += ` AND EXISTS (
        SELECT 1 FROM vehicle_hire_assignments vha
        WHERE vha.job_id = jobs.id
          AND vha.return_overnight = TRUE
          AND vha.status NOT IN ('cancelled', 'returned')
      )`;
    }

    // Manager filter — matches against either of the two manager slots.
    if (manager) {
      params.push(manager);
      whereClause += ` AND (jobs.manager1_person_id = $${params.length} OR jobs.manager2_person_id = $${params.length})`;
    }

    // Has-issues filter — jobs with at least one OPEN problem-register row
    // (job_issues — Stage 2 storage, migration 075) OR any requirement
    // stuck in "Problem" (blocked) status, e.g. backline flagged at
    // de-prep before the register hook existed. The old query checked
    // requirement_type='issue' which migration 075 retired (all rows
    // soft-cancelled), so it could never match anything.
    // V&D-suspended requirements carry status='blocked' but are "not
    // required", not problems — excluded per the suspension convention.
    if (has_issues === 'true' || has_issues === '1') {
      whereClause += ` AND (
        EXISTS (
          SELECT 1 FROM job_issues ji
          WHERE ji.job_id = jobs.id
            AND ji.status NOT IN ('resolved', 'written_off', 'cancelled')
        )
        OR EXISTS (
          SELECT 1 FROM job_requirements jr
          WHERE jr.job_id = jobs.id
            AND jr.status = 'blocked'
            AND (jr.notes IS NULL OR jr.notes NOT LIKE '%[Suspended: Van & Driver]%')
        )
      )`;
    }

    // Overdue filter — return_date in the past AND not completed. Server-side
    // so it composes correctly with pagination + the "All" status pill. Was
    // previously a client-side post-filter, which broke when the first page
    // was dominated by completed jobs (overdue-by-definition can't be
    // status=11, so the page would filter to empty).
    if (overdue === '1' || overdue === 'true') {
      whereClause += ` AND return_date::date < CURRENT_DATE AND status != 11`;
    }

    // Has-retro filter — only jobs that have had a "Job retro:" interaction
    // logged. Distinct from has_issues; useful on Returns/Completed to find
    // jobs the team has actually retrospected vs ones still pending one.
    // Pass has_retro=0 to invert (jobs WITHOUT a retro yet).
    if (has_retro === '1' || has_retro === 'true') {
      whereClause += ` AND EXISTS (
        SELECT 1 FROM interactions i
        WHERE i.job_id = jobs.id AND i.content LIKE 'Job retro:%'
      )`;
    } else if (has_retro === '0' || has_retro === 'false') {
      whereClause += ` AND NOT EXISTS (
        SELECT 1 FROM interactions i
        WHERE i.job_id = jobs.id AND i.content LIKE 'Job retro:%'
      )`;
    }

    // Service type filter — comma-separated requirement_type values
    // (vehicle, backline, rehearsal). Matches if the job has ANY listed
    // type as a non-cancelled pre-hire requirement.
    if (service_type) {
      const types = (service_type as string).split(',');
      params.push(types);
      whereClause += ` AND EXISTS (
        SELECT 1 FROM job_requirements jr
        WHERE jr.job_id = jobs.id
          AND jr.phase = 'pre_hire'
          AND jr.status != 'cancelled'
          AND jr.requirement_type = ANY($${params.length})
      )`;
    }

    const countResult = await query(
      `SELECT COUNT(*) FROM jobs ${whereClause}`,
      params
    );

    // Sort whitelist. Default keeps the historical "newest job_date first"
    // behaviour the Jobs page relies on. Returns page passes one of the
    // return_*-flavoured options to surface the longest-overdue close-outs
    // first (or to walk return dates ascending/descending).
    const allowedSorts: Record<string, string> = {
      job_date_desc:  'job_date DESC NULLS LAST',
      job_date_asc:   'job_date ASC NULLS LAST',
      return_desc:    'return_date DESC NULLS LAST',
      return_asc:     'return_date ASC NULLS LAST',
      // "Most overdue first" — oldest return date wins. Excluded-completed
      // jobs naturally fall in line with the rest. NULL last.
      overdue:        'return_date ASC NULLS LAST',
    };
    const orderBy = allowedSorts[(sort as string) || 'job_date_desc'] || 'job_date DESC NULLS LAST';

    params.push(parseInt(limit as string));
    params.push(offset);
    // Surface has_ooh_return per row so the Out Now list can render the
    // moon badge inline. Same EXISTS-shape as the filter — kept as a
    // computed column rather than a join so we don't duplicate rows.
    const jobsResult = await query(
      `SELECT jobs.*,
         EXISTS (
           SELECT 1 FROM vehicle_hire_assignments vha
           WHERE vha.job_id = jobs.id
             AND vha.return_overnight = TRUE
             AND vha.status NOT IN ('cancelled', 'returned')
         ) AS has_ooh_return,
         jf.hire_value_inc_vat::float8 AS hire_value_inc_vat
       FROM jobs
       LEFT JOIN job_financials jf ON jf.job_id = jobs.id
       ${whereClause}
       ORDER BY ${orderBy}
       LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params
    );

    res.json({
      data: jobsResult.rows,
      pagination: {
        page: parseInt(page as string),
        limit: parseInt(limit as string),
        total: parseInt(countResult.rows[0].count),
        totalPages: Math.ceil(parseInt(countResult.rows[0].count) / parseInt(limit as string)),
      },
    });
  } catch (error) {
    console.error('Jobs list error:', error);
    res.status(500).json({ error: 'Failed to load jobs' });
  }
});

// POST /api/hirehop/jobs/retros-bulk — bulk fetch the latest "Job retro" interaction
// per job. Used by the Returns & Completed page to surface a snippet column
// (rating + first ~80 chars of notes) without N+1 queries. Retro data is
// stored as an interaction with content starting "Job retro: <rating>\n<notes>"
// — see pipeline.ts completion handler.
router.post('/jobs/retros-bulk', async (req: AuthRequest, res: Response) => {
  try {
    const { job_ids } = req.body;
    if (!Array.isArray(job_ids) || job_ids.length === 0) {
      return res.json({ data: {} });
    }
    const ids = job_ids.slice(0, 500);
    const result = await query(
      `SELECT DISTINCT ON (i.job_id) i.job_id, i.content, i.created_at
       FROM interactions i
       WHERE i.job_id = ANY($1) AND i.content LIKE 'Job retro:%'
       ORDER BY i.job_id, i.created_at DESC`,
      [ids]
    );
    const data: Record<string, { rating: string; notes: string; created_at: string }> = {};
    for (const row of result.rows) {
      const lines = (row.content as string).split('\n');
      const ratingMatch = /^Job retro:\s*(.+)$/.exec(lines[0] || '');
      // First line is "Job retro: <rating>". Notes are subsequent lines until
      // a "Follow-up:" line (which we don't include in the snippet).
      const noteLines: string[] = [];
      for (let i = 1; i < lines.length; i++) {
        if (lines[i].startsWith('Follow-up:')) break;
        noteLines.push(lines[i]);
      }
      data[row.job_id] = {
        rating: (ratingMatch ? ratingMatch[1] : 'unknown').trim().toLowerCase(),
        notes: noteLines.join(' ').trim(),
        created_at: row.created_at,
      };
    }
    res.json({ data });
  } catch (error) {
    console.error('Retros bulk error:', error);
    res.status(500).json({ error: 'Failed to load retros' });
  }
});

// GET /api/hirehop/jobs/:id — get a single job by ID
router.get('/jobs/:id', async (req: AuthRequest, res: Response) => {
  try {
    const { id } = req.params;
    const result = await query(
      `SELECT * FROM jobs WHERE id = $1 AND is_deleted = false`,
      [id]
    );

    if (result.rows.length === 0) {
      res.status(404).json({ error: 'Job not found' });
      return;
    }

    // Compute has_client_email: true if we can reach the client via OP's address book.
    // Mirrors getJobEmailRecipients so the Job Detail banner matches send behaviour.
    // Five levels: (0) per-job contacts (job_contacts — migration 086),
    // (1) people linked via roles to client or any linked org,
    // (2) client org's own email, (3) any org linked via job_organisations
    // with an email (client, band, promoter, etc. — any role counts),
    // (4) jobs.client_name string matching a Person's first+last name.
    const reachable = await query(
      `SELECT 1
       FROM jobs j
       WHERE j.id = $1
         AND (
           EXISTS (
             SELECT 1 FROM job_contacts jc
             JOIN people p ON p.id = jc.person_id
             WHERE jc.job_id = j.id
               AND p.is_deleted = false
               AND p.email IS NOT NULL AND p.email <> ''
           )
           OR EXISTS (
             SELECT 1 FROM people p
             JOIN person_organisation_roles por ON por.person_id = p.id AND por.status = 'active'
             WHERE p.email IS NOT NULL AND p.email <> ''
               AND (
                 por.organisation_id = j.client_id
                 OR por.organisation_id IN (SELECT organisation_id FROM job_organisations WHERE job_id = j.id)
               )
           )
           OR EXISTS (
             SELECT 1 FROM organisations o
             WHERE o.id = j.client_id AND o.email IS NOT NULL AND o.email <> ''
           )
           OR EXISTS (
             SELECT 1 FROM organisations o
             JOIN job_organisations jo ON jo.organisation_id = o.id
             WHERE jo.job_id = j.id
               AND o.email IS NOT NULL AND o.email <> ''
           )
           OR EXISTS (
             SELECT 1 FROM people p
             WHERE p.is_deleted = false
               AND p.first_name IS NOT NULL AND p.last_name IS NOT NULL
               AND p.email IS NOT NULL AND p.email <> ''
               AND lower(trim(concat(p.first_name, ' ', p.last_name))) = lower(trim(j.client_name))
           )
         )
       LIMIT 1`,
      [id]
    );

    res.json({
      ...result.rows[0],
      has_client_email: reachable.rows.length > 0,
    });
  } catch (error) {
    console.error('Job detail error:', error);
    res.status(500).json({ error: 'Failed to load job' });
  }
});

// ── On-demand Sync + Derivation ─────────────────────────────────────────

// POST /api/hirehop/jobs/:jobId/sync — on-demand sync for a single job
// Fetches fresh line items from HH and runs requirement derivation.
// Also checks for status mismatch between OP and HH.
// Called by "Sync now" button and auto-sync on Job Detail page load.
router.post('/jobs/:jobId/sync', authenticate, async (req: AuthRequest, res: Response) => {
  try {
    const jobId = req.params.jobId as string;

    // Look up the job
    const jobResult = await query(
      `SELECT id, hh_job_number, pipeline_status, status FROM jobs WHERE id = $1 AND is_deleted = false`,
      [jobId]
    );

    if (jobResult.rows.length === 0) {
      res.status(404).json({ error: 'Job not found' });
      return;
    }

    const job = jobResult.rows[0];

    if (!job.hh_job_number) {
      res.json({ success: true, message: 'No HireHop job linked', items: [], derivation: null });
      return;
    }

    // Fetch fresh line items (high priority, bypass cache)
    const { fetchLineItemsOnDemand } = await import('../services/hirehop-job-sync');
    const items = await fetchLineItemsOnDemand(job.hh_job_number);

    // Store them
    await query(
      `UPDATE jobs SET line_items = $1, line_items_synced_at = NOW(), updated_at = NOW()
       WHERE id = $2`,
      [JSON.stringify(items), jobId]
    );

    // Run requirement derivation
    const { deriveRequirementsForJob } = await import('../services/hh-requirement-derivation');
    const derivation = await deriveRequirementsForJob(jobId);

    // Check for status mismatch between OP pipeline_status and actual HH status
    let statusMismatch: { op_status: string; hh_status: number; hh_status_name: string } | null = null;
    try {
      const hhJobRes = await hhBroker.get('/api/job_data.php', { job: job.hh_job_number }, { priority: 'high', cacheTTL: 0 });
      if (hhJobRes.success && hhJobRes.data) {
        const hhData = hhJobRes.data as Record<string, any>;
        const actualHHStatus = parseInt(hhData.STATUS ?? hhData.status ?? '-1');
        if (actualHHStatus >= 0) {
          // Update our cached HH status
          await query(`UPDATE jobs SET status = $1, hh_status = $1, updated_at = NOW() WHERE id = $2`, [actualHHStatus, jobId]);

          // Check if OP pipeline_status maps to a different HH status than what HH actually has
          const PIPELINE_TO_HH: Record<string, number> = {
            new_enquiry: 0, quoting: 0, chasing: 0, paused: 0,
            provisional: 1, confirmed: 2,
            prepping: 4, prepped: 3, dispatched: 5,
            returned_incomplete: 6, returned: 7,
            completed: 11, cancelled: 9, lost: 10,
          };
          const HH_STATUS_NAMES: Record<number, string> = {
            0: 'Enquiry', 1: 'Provisional', 2: 'Booked', 3: 'Prepped',
            4: 'Part Dispatched', 5: 'Dispatched', 6: 'Returned Incomplete',
            7: 'Returned', 8: 'Requires Attention', 9: 'Cancelled',
            10: 'Not Interested', 11: 'Completed',
          };
          const expectedHH = PIPELINE_TO_HH[job.pipeline_status || ''];
          // Suppress the banner for expected-state pairs where OP and HH intentionally differ:
          // OP=prepped + HH=5 (Dispatched): HH has no distinct "prepped" state; HH jumps to 5 on checkout
          //   while the van still sits prepped in the yard. The mismatch is expected, not drift.
          const isExpectedPair =
            (job.pipeline_status === 'prepped' && actualHHStatus === 5);
          if (expectedHH !== undefined && expectedHH !== actualHHStatus && !isExpectedPair) {
            statusMismatch = {
              op_status: job.pipeline_status,
              hh_status: actualHHStatus,
              hh_status_name: HH_STATUS_NAMES[actualHHStatus] || `Unknown (${actualHHStatus})`,
            };
          }
        }
      }
    } catch {
      // Non-fatal — status check is best-effort
    }

    res.json({
      success: true,
      itemCount: items.length,
      derivation,
      statusMismatch,
    });
  } catch (error) {
    console.error('On-demand sync error:', error);
    res.status(500).json({ error: error instanceof Error ? error.message : 'Sync failed' });
  }
});

// GET /api/hirehop/jobs/:jobId/derived-flags — get derived flags + seat availability
// Lightweight read (no HH call) — reads from cached hh_derived_flags on the job.
router.get('/jobs/:jobId/derived-flags', authenticate, async (req: AuthRequest, res: Response) => {
  try {
    const jobId = req.params.jobId as string;
    // Accept OP UUID or HireHop job number — staff-allocation rows on the
    // Allocations page only carry hirehop_job_id (job_id is NULL until a
    // hire form is submitted), so callers wanting to look up slot modes
    // for those rows can pass the HH number directly without resolving
    // the UUID first.
    const isUuid = /^[0-9a-f]{8}-/.test(jobId);
    const jobResult = await query(
      isUuid
        ? `SELECT hh_derived_flags, line_items_synced_at, is_van_and_driver, vehicle_slot_modes, self_drive_van_override FROM jobs WHERE id = $1`
        : `SELECT hh_derived_flags, line_items_synced_at, is_van_and_driver, vehicle_slot_modes, self_drive_van_override FROM jobs WHERE hh_job_number = $1`,
      [isUuid ? jobId : parseInt(jobId, 10)]
    );

    if (jobResult.rows.length === 0) {
      res.status(404).json({ error: 'Job not found' });
      return;
    }

    const job = jobResult.rows[0];
    const flags = job.hh_derived_flags;

    // If seat config is set, also fetch seat availability
    let seatAvailability = null;
    if (flags?.seat_config && flags?.has_vehicle) {
      const { checkSeatAvailability } = await import('../services/hh-requirement-derivation');
      // We don't have items here but can reconstruct from flags
      seatAvailability = await (checkSeatAvailability as any)(flags, []);
    }

    res.json({
      flags,
      lastSynced: job.line_items_synced_at,
      vehicleSlotModes: job.vehicle_slot_modes || {},
      // Sequential-swap override: the staff-declared real simultaneous
      // self-drive van count (null = use HH-derived). Drives the structure
      // control on the vehicle requirement card.
      selfDriveVanOverride: job.self_drive_van_override ?? null,
      // Legacy field — kept for one release for any lingering clients
      isVanAndDriver: flags?.has_vehicle && flags?.self_drive_count === 0,
      seatAvailability,
    });
  } catch (error) {
    console.error('Derived flags error:', error);
    res.status(500).json({ error: 'Failed to load derived flags' });
  }
});

// PATCH /api/hirehop/jobs/:jobId/vehicle-slot-mode — set mode for a single van slot
router.patch('/jobs/:jobId/vehicle-slot-mode', authenticate, async (req: AuthRequest, res: Response) => {
  try {
    const jobId = req.params.jobId as string;
    const { itemId, slotIndex, mode } = req.body as { itemId?: number | string; slotIndex?: number; mode?: string };

    if (itemId === undefined || slotIndex === undefined || !mode) {
      res.status(400).json({ error: 'itemId, slotIndex, and mode are required' });
      return;
    }
    if (mode !== 'self_drive' && mode !== 'van_and_driver') {
      res.status(400).json({ error: 'mode must be self_drive or van_and_driver' });
      return;
    }
    if (!Number.isInteger(slotIndex) || slotIndex < 0) {
      res.status(400).json({ error: 'slotIndex must be a non-negative integer' });
      return;
    }

    const key = String(itemId);
    const current = await query(
      `SELECT vehicle_slot_modes FROM jobs WHERE id = $1`,
      [jobId]
    );
    if (current.rows.length === 0) {
      res.status(404).json({ error: 'Job not found' });
      return;
    }

    const modes: Record<string, string[]> = current.rows[0].vehicle_slot_modes || {};
    const arr = Array.isArray(modes[key]) ? [...modes[key]] : [];
    // Pad with 'self_drive' up to slotIndex so index alignment is preserved
    while (arr.length <= slotIndex) arr.push('self_drive');
    arr[slotIndex] = mode;
    modes[key] = arr;

    await query(
      `UPDATE jobs SET vehicle_slot_modes = $1, updated_at = NOW() WHERE id = $2`,
      [JSON.stringify(modes), jobId]
    );

    // Re-derive requirements after slot change
    const { deriveRequirementsForJob } = await import('../services/hh-requirement-derivation');
    const derivation = await deriveRequirementsForJob(jobId);

    res.json({ success: true, vehicleSlotModes: modes, derivation });
  } catch (error) {
    console.error('Vehicle slot mode error:', error);
    res.status(500).json({ error: 'Failed to update' });
  }
});

// PATCH /api/hirehop/jobs/:jobId/vehicle-count-override — declare the real
// simultaneous self-drive van count for a sequential-swap hire (HH lists
// qty-2 but it's one van swapped mid-hire). count=null clears the override
// (back to HH-derived). Re-derives so excess + requirements update.
router.patch('/jobs/:jobId/vehicle-count-override', authenticate, async (req: AuthRequest, res: Response) => {
  try {
    const jobId = req.params.jobId as string;
    const { count, note } = req.body as { count?: number | null; note?: string };

    if (count !== null && count !== undefined && (!Number.isInteger(count) || count < 0)) {
      res.status(400).json({ error: 'count must be a non-negative integer or null' });
      return;
    }

    const exists = await query(`SELECT id FROM jobs WHERE id = $1`, [jobId]);
    if (exists.rows.length === 0) {
      res.status(404).json({ error: 'Job not found' });
      return;
    }

    await query(
      `UPDATE jobs SET self_drive_van_override = $1, vehicle_structure_note = $2, updated_at = NOW() WHERE id = $3`,
      [count ?? null, note ?? null, jobId]
    );

    const { deriveRequirementsForJob } = await import('../services/hh-requirement-derivation');
    const derivation = await deriveRequirementsForJob(jobId);

    res.json({ success: true, selfDriveVanOverride: count ?? null, derivation });
  } catch (error) {
    console.error('Vehicle count override error:', error);
    res.status(500).json({ error: 'Failed to update' });
  }
});

// PATCH /api/hirehop/jobs/:jobId/van-and-driver — legacy job-level toggle (kept for transitional clients)
// Applies the chosen mode to every current vehicle slot.
router.patch('/jobs/:jobId/van-and-driver', authenticate, async (req: AuthRequest, res: Response) => {
  try {
    const jobId = req.params.jobId as string;
    const { isVanAndDriver } = req.body;
    const mode = isVanAndDriver ? 'van_and_driver' : 'self_drive';

    // Read current flags to know which slots exist
    const jobRow = await query(
      `SELECT hh_derived_flags, line_items FROM jobs WHERE id = $1`,
      [jobId]
    );
    if (jobRow.rows.length === 0) {
      res.status(404).json({ error: 'Job not found' });
      return;
    }
    const flags = jobRow.rows[0].hh_derived_flags;
    const slots: Array<{ item_id: number; slot_index: number }> = flags?.vehicle_slots || [];

    // Rebuild slot modes map
    const modes: Record<string, string[]> = {};
    for (const slot of slots) {
      const key = String(slot.item_id);
      if (!modes[key]) modes[key] = [];
      while (modes[key].length <= slot.slot_index) modes[key].push('self_drive');
      modes[key][slot.slot_index] = mode;
    }

    await query(
      `UPDATE jobs SET vehicle_slot_modes = $1, is_van_and_driver = $2, updated_at = NOW() WHERE id = $3`,
      [JSON.stringify(modes), !!isVanAndDriver, jobId]
    );

    const { deriveRequirementsForJob } = await import('../services/hh-requirement-derivation');
    const derivation = await deriveRequirementsForJob(jobId);

    res.json({ success: true, isVanAndDriver: !!isVanAndDriver, vehicleSlotModes: modes, derivation });
  } catch (error) {
    console.error('Van & driver toggle error:', error);
    res.status(500).json({ error: 'Failed to update' });
  }
});

// PATCH /api/hirehop/jobs/:jobId/internal — mark a job as internal (garage
// visits, MOTs, our own vehicle movements booked in HH to keep stock
// accurate). Mutes the client-facing chain: hire forms + excess requirements
// are soft-suspended, the job drops out of /money/overview aggregates, the
// hire-form auto-emailer and last-minute booking alert skip it. Crew &
// Transport, vehicle allocation, and the Turnaround Schedule stay live.
router.patch('/jobs/:jobId/internal', async (req: AuthRequest, res: Response) => {
  try {
    const jobId = req.params.jobId as string;
    const isInternal = !!req.body.isInternal;

    const updated = await query(
      `UPDATE jobs SET is_internal = $1, updated_at = NOW()
       WHERE id = $2 AND is_deleted = false
       RETURNING id, is_internal`,
      [isInternal, jobId]
    );
    if (updated.rows.length === 0) {
      res.status(404).json({ error: 'Job not found' });
      return;
    }

    // Audit trail — the toggle changes money reporting, so log who flipped it.
    // Logged before the re-derivation so the timeline entry survives even if
    // derivation hits a transient error.
    try {
      await query(
        `INSERT INTO interactions (type, content, job_id, created_by)
         VALUES ('note', $1, $2, $3)`,
        [
          isInternal
            ? '🔧 Job marked as Internal — hire forms, excess and money tracking muted (crew & transport unaffected)'
            : 'Job un-marked as Internal — hire forms, excess and money tracking re-enabled',
          jobId,
          req.user!.id,
        ]
      );
    } catch (logErr) {
      console.warn('Internal toggle: timeline log failed (non-fatal):', logErr);
    }

    // Re-derive so hire_forms/excess suspend (or restore) immediately rather
    // than waiting for the next 30-min sync. The flag update above is the
    // primary action — a derivation failure shouldn't make the toggle look
    // like it didn't happen (the scheduled sync re-derives within 30 min).
    let derivation = null;
    try {
      const { deriveRequirementsForJob } = await import('../services/hh-requirement-derivation');
      derivation = await deriveRequirementsForJob(jobId);
    } catch (deriveErr) {
      console.error('Internal toggle: re-derivation failed (flag saved, sync will catch up):', deriveErr);
    }

    res.json({ success: true, isInternal, derivation });
  } catch (error) {
    console.error('Internal job toggle error:', error);
    res.status(500).json({ error: 'Failed to update' });
  }
});

// GET /api/hirehop/mappings — show synced records
router.get('/mappings', async (_req: AuthRequest, res: Response) => {
  try {
    const mappings = await query(
      `SELECT
         eim.entity_type, eim.external_id as hirehop_id, eim.synced_at,
         CASE
           WHEN eim.entity_type = 'people' THEN (SELECT CONCAT(p.first_name, ' ', p.last_name) FROM people p WHERE p.id = eim.entity_id)
           WHEN eim.entity_type = 'organisations' THEN (SELECT o.name FROM organisations o WHERE o.id = eim.entity_id)
           WHEN eim.entity_type = 'venues' THEN (SELECT v.name FROM venues v WHERE v.id = eim.entity_id)
           WHEN eim.entity_type = 'jobs' THEN (SELECT j.job_name FROM jobs j WHERE j.id = eim.entity_id)
           ELSE NULL
         END as name
       FROM external_id_map eim
       WHERE eim.external_system = 'hirehop' OR eim.external_system = 'hirehop_venue'
       ORDER BY eim.synced_at DESC
       LIMIT 100`
    );

    const counts = await query(
      `SELECT entity_type, COUNT(*) as count
       FROM external_id_map
       WHERE external_system IN ('hirehop', 'hirehop_venue')
       GROUP BY entity_type`
    );

    res.json({
      mappings: mappings.rows,
      counts: counts.rows,
    });
  } catch (error) {
    console.error('Mappings error:', error);
    res.status(500).json({ error: 'Failed to load mappings' });
  }
});

export default router;
