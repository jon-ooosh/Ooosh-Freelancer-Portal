import { Router, Response } from 'express';
import { authenticate, authorize, AuthRequest } from '../middleware/auth';
import { isHireHopConfigured } from '../config/hirehop';
import { previewHireHopSync, syncContactsFromHireHop } from '../services/hirehop-sync';
import { previewHireHopJobSync, syncJobsFromHireHop } from '../services/hirehop-job-sync';
import { query } from '../config/database';
import { hhBroker } from '../services/hirehop-broker';

const router = Router();
router.use(authenticate);
router.use(authorize('admin', 'manager', 'staff', 'general_assistant', 'weekend_manager'));

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
    const { status, search, page = '1', limit = '50' } = req.query;
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

    if (search && (search as string).trim()) {
      params.push(`%${(search as string).trim()}%`);
      whereClause += ` AND (job_name ILIKE $${params.length} OR client_name ILIKE $${params.length} OR company_name ILIKE $${params.length} OR venue_name ILIKE $${params.length} OR CAST(hh_job_number AS TEXT) ILIKE $${params.length})`;
    }

    const countResult = await query(
      `SELECT COUNT(*) FROM jobs ${whereClause}`,
      params
    );

    params.push(parseInt(limit as string));
    params.push(offset);
    const jobsResult = await query(
      `SELECT * FROM jobs ${whereClause}
       ORDER BY job_date DESC NULLS LAST
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
    // Mirrors getJobEmailRecipients exactly so the Job Detail banner matches send behaviour.
    // Three levels: (1) people linked via roles to client org, (2) client org's own email,
    // (3) jobs.client_name string matching a Person's first+last name.
    const reachable = await query(
      `SELECT 1
       FROM jobs j
       WHERE j.id = $1
         AND (
           EXISTS (
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
             WHERE jo.job_id = j.id AND jo.role = 'client'
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
    const jobResult = await query(
      `SELECT hh_derived_flags, line_items_synced_at, is_van_and_driver, vehicle_slot_modes FROM jobs WHERE id = $1`,
      [jobId]
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
