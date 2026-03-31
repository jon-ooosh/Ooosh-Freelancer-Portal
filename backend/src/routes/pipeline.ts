import { Router, Response } from 'express';
import { z } from 'zod';
import { query } from '../config/database';
import { authenticate, authorize, AuthRequest } from '../middleware/auth';
import { validate } from '../middleware/validate';
import { logAudit } from '../middleware/audit';
import { writeBackStatusToHireHop } from '../services/hirehop-writeback';
import { sendLastMinuteAlert } from '../services/money-emails';

const router = Router();
router.use(authenticate);
router.use(authorize('admin', 'manager', 'staff'));

// Pipeline status labels for transition logging
const PIPELINE_LABELS: Record<string, string> = {
  new_enquiry: 'Enquiries',
  quoting: 'Enquiries',
  chasing: 'Chasing',
  paused: 'Paused Enquiry',
  provisional: 'Provisional',
  confirmed: 'Confirmed',
  lost: 'Lost',
};

// ── Pipeline list with filtering ───────────────────────────────────────────

router.get('/', async (req: AuthRequest, res: Response) => {
  try {
    const {
      status, likelihood, manager, chase_status, has_hh_job,
      date_from, date_to, search,
      page = '1', limit = '50', sort = 'next_chase_date', order = 'asc',
    } = req.query;

    const params: unknown[] = [];
    let paramIndex = 1;
    const conditions: string[] = ['j.is_deleted = false'];

    // Pipeline status filter (comma-separated)
    if (status) {
      const statuses = (status as string).split(',');
      conditions.push(`j.pipeline_status = ANY($${paramIndex})`);
      params.push(statuses);
      paramIndex++;
    }

    // Likelihood filter
    if (likelihood) {
      conditions.push(`j.likelihood = $${paramIndex}`);
      params.push(likelihood);
      paramIndex++;
    }

    // Manager filter
    if (manager) {
      conditions.push(`(j.manager1_person_id = $${paramIndex} OR j.manager2_person_id = $${paramIndex})`);
      params.push(manager);
      paramIndex++;
    }

    // Chase status filter
    if (chase_status === 'overdue') {
      conditions.push(`j.next_chase_date < CURRENT_DATE`);
    } else if (chase_status === 'due_today') {
      conditions.push(`j.next_chase_date = CURRENT_DATE`);
    } else if (chase_status === 'due_this_week') {
      conditions.push(`j.next_chase_date BETWEEN CURRENT_DATE AND CURRENT_DATE + INTERVAL '7 days'`);
    }

    // Has HireHop job filter
    if (has_hh_job === 'true') {
      conditions.push(`j.hh_job_number IS NOT NULL`);
    } else if (has_hh_job === 'false') {
      conditions.push(`j.hh_job_number IS NULL`);
    }

    // Date range filter (job dates)
    if (date_from) {
      conditions.push(`j.job_date >= $${paramIndex}`);
      params.push(date_from);
      paramIndex++;
    }
    if (date_to) {
      conditions.push(`j.job_end <= $${paramIndex}`);
      params.push(date_to);
      paramIndex++;
    }

    // Search
    if (search) {
      conditions.push(`(j.job_name ILIKE $${paramIndex} OR j.client_name ILIKE $${paramIndex} OR j.company_name ILIKE $${paramIndex} OR CAST(j.hh_job_number AS TEXT) ILIKE $${paramIndex})`);
      params.push(`%${search}%`);
      paramIndex++;
    }

    const where = conditions.join(' AND ');

    // Sortable columns whitelist
    const sortableColumns: Record<string, string> = {
      next_chase_date: 'j.next_chase_date',
      job_value: 'j.job_value',
      job_date: 'j.job_date',
      created_at: 'j.created_at',
      pipeline_status_changed_at: 'j.pipeline_status_changed_at',
      chase_count: 'j.chase_count',
    };
    const sortCol = sortableColumns[sort as string] || 'j.next_chase_date';
    const sortOrder = order === 'desc' ? 'DESC' : 'ASC';

    // Count total
    const countResult = await query(`SELECT COUNT(*) FROM jobs j WHERE ${where}`, params);
    const total = parseInt(countResult.rows[0].count);

    // Fetch jobs
    const pageNum = parseInt(page as string);
    const limitNum = parseInt(limit as string);
    const offset = (pageNum - 1) * limitNum;

    const jobsResult = await query(
      `SELECT j.*,
        m1p.first_name as manager1_first_name, m1p.last_name as manager1_last_name,
        m2p.first_name as manager2_first_name, m2p.last_name as manager2_last_name,
        (SELECT o.name FROM job_organisations jo JOIN organisations o ON o.id = jo.organisation_id
         WHERE jo.job_id = j.id AND jo.role = 'band' LIMIT 1) as band_name,
        (SELECT json_agg(json_build_object('id', jo.id, 'role', jo.role, 'organisation_name', o.name, 'organisation_type', o.type, 'organisation_id', jo.organisation_id))
         FROM job_organisations jo JOIN organisations o ON o.id = jo.organisation_id
         WHERE jo.job_id = j.id) as linked_organisations
      FROM jobs j
      LEFT JOIN people m1p ON m1p.id = j.manager1_person_id
      LEFT JOIN people m2p ON m2p.id = j.manager2_person_id
      WHERE ${where}
      ORDER BY ${sortCol} ${sortOrder} NULLS LAST, j.created_at DESC
      LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`,
      [...params, limitNum, offset]
    );

    res.json({
      data: jobsResult.rows,
      pagination: {
        page: pageNum,
        limit: limitNum,
        total,
        totalPages: Math.ceil(total / limitNum),
      },
    });
  } catch (error) {
    console.error('Pipeline list error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── Pipeline stats (for summary bar and dashboard) ─────────────────────────

router.get('/stats', async (_req: AuthRequest, res: Response) => {
  try {
    // Counts and values by pipeline status
    const byStatus = await query(`
      SELECT
        pipeline_status,
        COUNT(*) as count,
        COALESCE(SUM(job_value), 0) as total_value
      FROM jobs
      WHERE is_deleted = false
        AND pipeline_status IS NOT NULL
      GROUP BY pipeline_status
      ORDER BY pipeline_status
    `);

    // Chase stats
    const chaseStats = await query(`
      SELECT
        COUNT(*) FILTER (WHERE next_chase_date < CURRENT_DATE) as overdue,
        COUNT(*) FILTER (WHERE next_chase_date = CURRENT_DATE) as due_today,
        COUNT(*) FILTER (WHERE next_chase_date BETWEEN CURRENT_DATE + 1 AND CURRENT_DATE + 7) as due_this_week
      FROM jobs
      WHERE is_deleted = false
        AND pipeline_status NOT IN ('confirmed', 'lost')
        AND next_chase_date IS NOT NULL
    `);

    // Total active pipeline value (excl. confirmed and lost)
    const activeValue = await query(`
      SELECT COALESCE(SUM(job_value), 0) as total
      FROM jobs
      WHERE is_deleted = false
        AND pipeline_status NOT IN ('confirmed', 'lost')
    `);

    res.json({
      by_status: byStatus.rows,
      chase: chaseStats.rows[0],
      active_pipeline_value: parseFloat(activeValue.rows[0].total),
    });
  } catch (error) {
    console.error('Pipeline stats error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── Jobs due for chasing ───────────────────────────────────────────────────

router.get('/chase-due', async (_req: AuthRequest, res: Response) => {
  try {
    const result = await query(`
      SELECT j.*,
        m1p.first_name as manager1_first_name, m1p.last_name as manager1_last_name
      FROM jobs j
      LEFT JOIN people m1p ON m1p.id = j.manager1_person_id
      WHERE j.is_deleted = false
        AND j.pipeline_status NOT IN ('confirmed', 'lost')
        AND j.next_chase_date IS NOT NULL
        AND j.next_chase_date <= CURRENT_DATE
      ORDER BY j.next_chase_date ASC, j.job_value DESC NULLS LAST
    `);

    res.json({ data: result.rows });
  } catch (error) {
    console.error('Chase-due error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── Create new Ooosh-native enquiry ────────────────────────────────────────

const createEnquirySchema = z.object({
  // Required
  client_name: z.string().min(1),
  details: z.string().optional().nullable(),  // "What they want" — optional if service_types selected
  // Dates (all optional — enquiry may not have dates yet)
  out_date: z.string().optional().nullable(),      // Outgoing / equipment leaves
  job_date: z.string().optional().nullable(),      // Job start
  job_end: z.string().optional().nullable(),       // Job finish
  return_date: z.string().optional().nullable(),   // Returning / equipment back
  // Optional
  job_name: z.string().optional().nullable(),
  client_id: z.string().uuid().optional().nullable(),
  venue_id: z.string().uuid().optional().nullable(),
  venue_name: z.string().optional().nullable(),
  enquiry_source: z.enum(['phone', 'email', 'web_form', 'referral', 'cold_lead', 'forum', 'repeat', 'other']).optional().nullable(),
  job_value: z.number().optional().nullable(),
  likelihood: z.enum(['hot', 'warm', 'cold']).optional().default('warm'),
  notes: z.string().optional().nullable(),
  manager1_person_id: z.string().uuid().optional().nullable(),
  // Chase scheduling at creation
  next_chase_date: z.string().optional().nullable(),
  chase_interval_days: z.number().optional().nullable(),
  chase_alert_user_id: z.string().uuid().optional().nullable(),
  service_types: z.array(z.enum(['self_drive_van', 'backline', 'rehearsal'])).optional().nullable(),
  band_name: z.string().optional().nullable(),
});

router.post('/enquiry', validate(createEnquirySchema), async (req: AuthRequest, res: Response) => {
  try {
    const {
      client_name, out_date, job_date, job_end, return_date, job_name,
      client_id, venue_id, venue_name, enquiry_source,
      job_value, likelihood, notes, manager1_person_id,
      next_chase_date, chase_interval_days, chase_alert_user_id,
      service_types, band_name,
    } = req.body;
    let { details } = req.body;

    // Service type labels
    const serviceLabels: Record<string, string> = {
      self_drive_van: 'Self-drive van',
      backline: 'Backline',
      rehearsal: 'Rehearsal',
    };
    const selectionPart = service_types && service_types.length > 0
      ? service_types.map((t: string) => serviceLabels[t] || t).join(' + ')
      : null;

    // Require either details or service_types
    if (!details && !selectionPart) {
      res.status(400).json({ error: 'Please provide a description or select a service type' });
      return;
    }

    // If no details text, use service type labels
    if (!details && selectionPart) {
      details = selectionPart;
    }

    // Auto-generate job name: "Band - Client - Selection" (with regular dashes)
    let finalJobName = job_name;
    if (!finalJobName) {
      const parts: string[] = [];
      if (band_name) parts.push(band_name);
      parts.push(client_name);
      if (selectionPart) parts.push(selectionPart);
      finalJobName = parts.join(' - ');
    }

    // Resolve manager: use provided person_id, or look up the current user's person_id
    let managerId = manager1_person_id || null;
    if (!managerId) {
      const userResult = await query(
        `SELECT person_id FROM users WHERE id = $1`,
        [req.user!.id]
      );
      managerId = userResult.rows[0]?.person_id || null;
    }

    const chaseIntervalDays = chase_interval_days || 3;
    const chaseDate = next_chase_date || null;
    // If no chase date given, default to interval from today
    const chaseDateSql = chaseDate
      ? `$17::date`
      : `CURRENT_DATE + ($17 || ' days')::interval`;

    const result = await query(
      `INSERT INTO jobs (
        job_name, details, out_date, job_date, job_end, return_date,
        client_id, client_name, company_name,
        venue_id, venue_name,
        enquiry_source, job_value, likelihood, notes,
        manager1_person_id,
        status, status_name,
        pipeline_status, pipeline_status_changed_at,
        chase_interval_days, next_chase_date,
        created_by
      ) VALUES (
        $1, $2, $3, $4, $5, $6,
        $7, $8, $8,
        $9, $10,
        $11, $12, $13, $14,
        $15,
        0, 'Enquiry',
        'new_enquiry', NOW(),
        $18, ${chaseDateSql},
        $16
      ) RETURNING *`,
      [
        finalJobName, details, out_date || null, job_date || null, job_end || null, return_date || null,
        client_id || null, client_name,
        venue_id || null, venue_name || null,
        enquiry_source || null, job_value || null, likelihood || 'warm', notes || null,
        managerId,
        req.user!.id,
        chaseDate || String(chaseIntervalDays),
        chaseIntervalDays,
      ]
    );

    // Log creation as an interaction on the job timeline
    await query(
      `INSERT INTO interactions (type, content, job_id, created_by, pipeline_status_at_creation)
       VALUES ('status_transition', $1, $2, $3, 'new_enquiry')`,
      [`New enquiry created: ${finalJobName}`, result.rows[0].id, req.user!.id]
    );

    await logAudit(req.user!.id, 'jobs', result.rows[0].id, 'create', null, result.rows[0]);

    // Create chase alert notification if requested
    if (chase_alert_user_id) {
      await query(
        `INSERT INTO notifications (user_id, type, title, content, entity_type, entity_id)
         VALUES ($1, 'chase_alert', $2, $3, 'jobs', $4)`,
        [
          chase_alert_user_id,
          `Chase reminder: ${finalJobName}`,
          `Chase due for ${client_name} — ${finalJobName}`,
          result.rows[0].id,
        ]
      );
    }

    // Auto-create job requirements based on service type selections
    if (service_types && service_types.length > 0) {
      const jobId = result.rows[0].id;
      // Map service types to requirement types
      const requirementMap: Record<string, string[]> = {
        self_drive_van: ['vehicle', 'hire_forms', 'excess'],
        backline: ['backline'],
        rehearsal: ['rehearsal'],
      };
      const reqTypes = new Set<string>();
      for (const st of service_types) {
        const mapped = requirementMap[st];
        if (mapped) mapped.forEach(t => reqTypes.add(t));
      }
      for (const reqType of reqTypes) {
        try {
          // Check if already exists (unique constraint is deferred so ON CONFLICT won't work)
          const exists = await query(
            `SELECT 1 FROM job_requirements WHERE job_id = $1 AND requirement_type = $2 LIMIT 1`,
            [jobId, reqType]
          );
          if (exists.rows.length === 0) {
            await query(
              `INSERT INTO job_requirements (job_id, requirement_type, status, created_by, source)
               VALUES ($1, $2, 'not_started', $3, 'enquiry_form')`,
              [jobId, reqType, req.user!.id]
            );
          }
        } catch (reqErr) {
          console.error(`Failed to create requirement ${reqType} for job ${jobId}:`, reqErr);
        }
      }
    }

    res.status(201).json(result.rows[0]);
  } catch (error) {
    console.error('Create enquiry error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── Update pipeline status (with transition logging) ───────────────────────

const updateStatusSchema = z.object({
  pipeline_status: z.enum(['new_enquiry', 'quoting', 'chasing', 'paused', 'provisional', 'confirmed', 'lost']),
  // Context fields depending on status
  hold_reason: z.string().optional().nullable(),
  hold_reason_detail: z.string().optional().nullable(),
  confirmed_method: z.enum(['deposit', 'full_payment', 'po', 'manual']).optional().nullable(),
  lost_reason: z.string().optional().nullable(),
  lost_detail: z.string().optional().nullable(),
  transition_note: z.string().optional().nullable(),  // Why the status changed
});

router.patch('/:id/status', validate(updateStatusSchema), async (req: AuthRequest, res: Response) => {
  try {
    const jobId = req.params.id as string;
    const {
      pipeline_status, hold_reason, hold_reason_detail,
      confirmed_method, lost_reason, lost_detail, transition_note,
    } = req.body;

    // Get current state
    const current = await query(
      `SELECT * FROM jobs WHERE id = $1 AND is_deleted = false`,
      [jobId]
    );
    if (current.rows.length === 0) {
      res.status(404).json({ error: 'Job not found' });
      return;
    }

    const currentJob = current.rows[0];
    const fromStatus = currentJob.pipeline_status;

    // Build update fields
    const updates: string[] = [
      `pipeline_status = $1`,
      `pipeline_status_changed_at = NOW()`,
      `updated_at = NOW()`,
    ];
    const updateParams: unknown[] = [pipeline_status];
    let pIdx = 2;

    // Status-specific fields
    if (pipeline_status === 'paused') {
      updates.push(`hold_reason = $${pIdx}`);
      updateParams.push(hold_reason || null);
      pIdx++;
      updates.push(`hold_reason_detail = $${pIdx}`);
      updateParams.push(hold_reason_detail || null);
      pIdx++;
    } else if (pipeline_status === 'confirmed') {
      updates.push(`confirmed_method = $${pIdx}`);
      updateParams.push(confirmed_method || null);
      pIdx++;
      updates.push(`confirmed_at = NOW()`);
    } else if (pipeline_status === 'lost') {
      updates.push(`lost_reason = $${pIdx}`);
      updateParams.push(lost_reason || null);
      pIdx++;
      updates.push(`lost_detail = $${pIdx}`);
      updateParams.push(lost_detail || null);
      pIdx++;
      updates.push(`lost_at = NOW()`);
    }

    // Clear hold fields when moving out of paused
    if (fromStatus === 'paused' && pipeline_status !== 'paused') {
      updates.push(`hold_reason = NULL`);
      updates.push(`hold_reason_detail = NULL`);
    }

    // Clear lost fields when moving out of lost (re-opening)
    if (fromStatus === 'lost' && pipeline_status !== 'lost') {
      updates.push(`lost_reason = NULL`);
      updates.push(`lost_detail = NULL`);
      updates.push(`lost_at = NULL`);
    }

    updateParams.push(jobId);
    const result = await query(
      `UPDATE jobs SET ${updates.join(', ')} WHERE id = $${pIdx} RETURNING *`,
      updateParams
    );

    // Log the transition as an interaction
    const fromLabel = PIPELINE_LABELS[fromStatus] || fromStatus;
    const toLabel = PIPELINE_LABELS[pipeline_status] || pipeline_status;
    const transitionContent = transition_note
      ? `Status changed: ${fromLabel} → ${toLabel} — ${transition_note}`
      : `Status changed: ${fromLabel} → ${toLabel}`;

    await query(
      `INSERT INTO interactions (type, content, job_id, created_by, pipeline_status_at_creation)
       VALUES ('status_transition', $1, $2, $3, $4)`,
      [transitionContent, jobId, req.user!.id, fromStatus]
    );

    await logAudit(req.user!.id, 'jobs', jobId, 'update', currentJob, result.rows[0]);

    // Last-minute booking alert (any route to confirmed, job starts within 3 days)
    if (pipeline_status === 'confirmed') {
      sendLastMinuteAlert(jobId).catch(e => console.error('[Pipeline] Last-minute alert failed:', e));
    }

    // Write back to HireHop (async, non-blocking — don't fail the response if HH is down)
    writeBackStatusToHireHop(jobId, pipeline_status, req.user!.email || req.user!.id)
      .then(wb => {
        if (!wb.success) console.warn(`[Pipeline] HH write-back note: ${wb.message}`);
      })
      .catch(err => console.error('[Pipeline] HH write-back error:', err));

    res.json(result.rows[0]);
  } catch (error) {
    console.error('Update pipeline status error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── Update pipeline fields (likelihood, chase date, value, etc.) ───────────

const updatePipelineSchema = z.object({
  likelihood: z.enum(['hot', 'warm', 'cold']).optional().nullable(),
  next_chase_date: z.string().optional().nullable(),
  chase_interval_days: z.number().min(1).max(90).optional(),
  job_value: z.number().optional().nullable(),
  quote_status: z.enum(['not_quoted', 'quoted', 'revised', 'accepted']).optional().nullable(),
  enquiry_source: z.enum(['phone', 'email', 'web_form', 'referral', 'cold_lead', 'forum', 'repeat', 'other']).optional().nullable(),
  notes: z.string().optional().nullable(),
});

router.patch('/:id', validate(updatePipelineSchema), async (req: AuthRequest, res: Response) => {
  try {
    const jobId = req.params.id as string;
    const fields = req.body;

    // Get current state
    const current = await query(
      `SELECT * FROM jobs WHERE id = $1 AND is_deleted = false`,
      [jobId]
    );
    if (current.rows.length === 0) {
      res.status(404).json({ error: 'Job not found' });
      return;
    }

    // Build dynamic update
    const updates: string[] = ['updated_at = NOW()'];
    const params: unknown[] = [];
    let pIdx = 1;

    const allowedFields = [
      'likelihood', 'next_chase_date', 'chase_interval_days',
      'job_value', 'quote_status', 'enquiry_source', 'notes',
    ];

    for (const field of allowedFields) {
      if (field in fields) {
        updates.push(`${field} = $${pIdx}`);
        params.push(fields[field]);
        pIdx++;
      }
    }

    if (params.length === 0) {
      res.status(400).json({ error: 'No fields to update' });
      return;
    }

    params.push(jobId);
    const result = await query(
      `UPDATE jobs SET ${updates.join(', ')} WHERE id = $${pIdx} RETURNING *`,
      params
    );

    await logAudit(req.user!.id, 'jobs', jobId, 'update', current.rows[0], result.rows[0]);

    res.json(result.rows[0]);
  } catch (error) {
    console.error('Update pipeline fields error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── Client trading history ────────────────────────────────────────────────
// Returns recent jobs for a client (by org ID or client name) for context

router.get('/client-history', async (req: AuthRequest, res: Response) => {
  try {
    const { client_id, client_name, exclude_job_id } = req.query;

    if (!client_id && !client_name) {
      res.status(400).json({ error: 'client_id or client_name required' });
      return;
    }

    const params: unknown[] = [];
    let paramIndex = 1;
    const conditions: string[] = ['j.is_deleted = false'];

    if (client_id) {
      conditions.push(`j.client_id = $${paramIndex}`);
      params.push(client_id);
      paramIndex++;
    } else {
      conditions.push(`(j.client_name ILIKE $${paramIndex} OR j.company_name ILIKE $${paramIndex})`);
      params.push(client_name);
      paramIndex++;
    }

    if (exclude_job_id) {
      conditions.push(`j.id != $${paramIndex}`);
      params.push(exclude_job_id);
      paramIndex++;
    }

    const where = conditions.join(' AND ');

    const result = await query(
      `SELECT
        j.id, j.hh_job_number, j.job_name, j.status, j.status_name,
        j.pipeline_status, j.job_date, j.job_end, j.job_value,
        j.client_name, j.company_name, j.likelihood,
        j.created_at
      FROM jobs j
      WHERE ${where}
      ORDER BY j.job_date DESC NULLS LAST, j.created_at DESC
      LIMIT 20`,
      params
    );

    // Summary stats (use only the client filter, not exclude_job_id)
    const statsConditions: string[] = ['j.is_deleted = false'];
    const statsParams: unknown[] = [];
    if (client_id) {
      statsConditions.push(`j.client_id = $1`);
      statsParams.push(client_id);
    } else {
      statsConditions.push(`(j.client_name ILIKE $1 OR j.company_name ILIKE $1)`);
      statsParams.push(client_name);
    }
    const statsResult = await query(
      `SELECT
        COUNT(*) as total_jobs,
        COUNT(*) FILTER (WHERE pipeline_status = 'confirmed' OR status = 2) as confirmed_jobs,
        COUNT(*) FILTER (WHERE pipeline_status = 'lost' OR status IN (9, 10)) as lost_jobs,
        COALESCE(SUM(job_value) FILTER (WHERE pipeline_status = 'confirmed' OR status = 2), 0) as total_confirmed_value,
        COALESCE(SUM(job_value), 0) as total_value,
        MIN(job_date) as first_job_date,
        MAX(job_date) as last_job_date
      FROM jobs j
      WHERE ${statsConditions.join(' AND ')}`,
      statsParams
    );

    // If we have a client_id (org), fetch org details for context (do_not_hire, working_terms, notes)
    let client_info = null;
    if (client_id) {
      const orgResult = await query(
        `SELECT id, name, do_not_hire, do_not_hire_reason,
                working_terms_type, working_terms_credit_days, working_terms_notes,
                notes as internal_notes
         FROM organisations WHERE id = $1`,
        [client_id]
      );
      if (orgResult.rows.length > 0) {
        client_info = orgResult.rows[0];
      }
    }

    res.json({
      jobs: result.rows,
      stats: statsResult.rows[0],
      client_info,
    });
  } catch (error) {
    console.error('Client history error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ============================================================================
// JOB ORGANISATIONS — Multi-org links per job (band, client, promoter, etc.)
// ============================================================================

const createJobOrgSchema = z.object({
  organisation_id: z.string().uuid(),
  role: z.enum(['band', 'client', 'promoter', 'venue_operator', 'management', 'label', 'supplier', 'other']),
  is_primary: z.boolean().optional().default(false),
  notes: z.string().optional().nullable(),
});

// GET /api/pipeline/:jobId/organisations
router.get('/:jobId/organisations', async (req: AuthRequest, res: Response) => {
  try {
    const result = await query(
      `SELECT jo.*, o.name as organisation_name, o.type as organisation_type
       FROM job_organisations jo
       JOIN organisations o ON o.id = jo.organisation_id AND o.is_deleted = false
       WHERE jo.job_id = $1
       ORDER BY jo.role, o.name`,
      [req.params.jobId]
    );
    res.json({ data: result.rows });
  } catch (error) {
    console.error('Get job organisations error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/pipeline/:jobId/organisations
router.post('/:jobId/organisations', validate(createJobOrgSchema), async (req: AuthRequest, res: Response) => {
  try {
    const { organisation_id, role, is_primary, notes } = req.body;

    // Verify job exists
    const job = await query('SELECT id FROM jobs WHERE id = $1 AND is_deleted = false', [req.params.jobId]);
    if (job.rows.length === 0) {
      res.status(404).json({ error: 'Job not found' });
      return;
    }

    const result = await query(
      `INSERT INTO job_organisations (job_id, organisation_id, role, is_primary, notes, created_by)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`,
      [req.params.jobId, organisation_id, role, is_primary, notes, req.user!.id]
    );

    // Fetch with org name
    const full = await query(
      `SELECT jo.*, o.name as organisation_name, o.type as organisation_type
       FROM job_organisations jo
       JOIN organisations o ON o.id = jo.organisation_id
       WHERE jo.id = $1`,
      [result.rows[0].id]
    );

    res.status(201).json(full.rows[0]);
  } catch (error: any) {
    if (error.constraint === 'uq_job_org_role') {
      res.status(409).json({ error: 'This organisation already has this role on this job' });
      return;
    }
    console.error('Create job organisation error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// DELETE /api/pipeline/:jobId/organisations/:linkId
router.delete('/:jobId/organisations/:linkId', async (req: AuthRequest, res: Response) => {
  try {
    const result = await query(
      'DELETE FROM job_organisations WHERE id = $1 AND job_id = $2 RETURNING *',
      [req.params.linkId, req.params.jobId]
    );
    if (result.rows.length === 0) {
      res.status(404).json({ error: 'Link not found' });
      return;
    }
    res.status(204).send();
  } catch (error) {
    console.error('Delete job organisation error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ============================================================================
// JOB FIELD EDITING — Inline edit of key job fields from Job Detail page
// ============================================================================

const editJobSchema = z.object({
  job_name: z.string().min(1).optional(),
  out_date: z.string().optional().nullable(),
  job_date: z.string().optional().nullable(),
  job_end: z.string().optional().nullable(),
  return_date: z.string().optional().nullable(),
  client_id: z.string().uuid().optional().nullable(),
  client_name: z.string().optional().nullable(),
  hh_job_number: z.union([z.string(), z.number()]).optional().nullable(),
  job_value: z.number().optional().nullable(),
  likelihood: z.enum(['hot', 'warm', 'cold']).optional().nullable(),
  next_chase_date: z.string().optional().nullable(),
  details: z.string().optional().nullable(),
  notes: z.string().optional().nullable(),
});

router.patch('/:id/edit', validate(editJobSchema), async (req: AuthRequest, res: Response) => {
  try {
    const jobId = req.params.id as string;
    const fields = req.body;

    // Get current state
    const current = await query(
      `SELECT * FROM jobs WHERE id = $1 AND is_deleted = false`,
      [jobId]
    );
    if (current.rows.length === 0) {
      res.status(404).json({ error: 'Job not found' });
      return;
    }

    const currentJob = current.rows[0];

    // Parse hh_job_number: accept URL like https://myhirehop.com/job.php?id=15564
    if ('hh_job_number' in fields && fields.hh_job_number !== null && fields.hh_job_number !== undefined) {
      const raw = String(fields.hh_job_number).trim();
      const urlMatch = raw.match(/[?&]id=(\d+)/);
      if (urlMatch) {
        fields.hh_job_number = parseInt(urlMatch[1], 10);
      } else {
        const parsed = parseInt(raw, 10);
        if (isNaN(parsed)) {
          res.status(400).json({ error: 'Invalid hh_job_number — provide a number or HireHop URL' });
          return;
        }
        fields.hh_job_number = parsed;
      }
    }

    // Build dynamic update
    const updates: string[] = ['updated_at = NOW()'];
    const params: unknown[] = [];
    let pIdx = 1;

    const allowedFields = [
      'job_name', 'out_date', 'job_date', 'job_end', 'return_date',
      'client_id', 'client_name', 'hh_job_number', 'job_value',
      'likelihood', 'next_chase_date', 'details', 'notes',
    ];

    const changedFields: string[] = [];

    for (const field of allowedFields) {
      if (field in fields) {
        const oldVal = currentJob[field];
        const newVal = fields[field];
        // Track what actually changed for the interaction log
        if (String(oldVal ?? '') !== String(newVal ?? '')) {
          changedFields.push(`${field}: ${oldVal ?? '(empty)'} → ${newVal ?? '(empty)'}`);
        }
        updates.push(`${field} = $${pIdx}`);
        params.push(newVal ?? null);
        pIdx++;
      }
    }

    if (params.length === 0) {
      res.status(400).json({ error: 'No fields to update' });
      return;
    }

    params.push(jobId);
    const result = await query(
      `UPDATE jobs SET ${updates.join(', ')} WHERE id = $${pIdx} RETURNING *`,
      params
    );

    // Log changes as an interaction
    if (changedFields.length > 0) {
      const content = `Job details updated: ${changedFields.join('; ')}`;
      await query(
        `INSERT INTO interactions (type, content, job_id, created_by, pipeline_status_at_creation)
         VALUES ('note', $1, $2, $3, $4)`,
        [content, jobId, req.user!.id, currentJob.pipeline_status]
      );
    }

    await logAudit(req.user!.id, 'jobs', jobId, 'update', currentJob, result.rows[0]);

    res.json(result.rows[0]);
  } catch (error: any) {
    console.error('Edit job fields error:', error);
    // Surface constraint violations (e.g. duplicate hh_job_number)
    if (error?.code === '23505') {
      res.status(409).json({ error: 'Duplicate value — a job with that HireHop number already exists' });
      return;
    }
    res.status(500).json({ error: error?.message || 'Internal server error' });
  }
});

// ============================================================================
// PUSH TO HIREHOP — Create a new HireHop job from an Ooosh-native enquiry
// ============================================================================

router.post('/:id/push-hirehop', async (req: AuthRequest, res: Response) => {
  try {
    const jobId = req.params.id as string;

    // Get job
    const jobResult = await query(
      `SELECT * FROM jobs WHERE id = $1 AND is_deleted = false`,
      [jobId]
    );
    if (jobResult.rows.length === 0) {
      res.status(404).json({ error: 'Job not found' });
      return;
    }

    const job = jobResult.rows[0];

    if (job.hh_job_number) {
      res.status(409).json({ error: `Job already linked to HireHop job #${job.hh_job_number}` });
      return;
    }

    if (!job.job_date || !job.job_end) {
      const missing = [];
      if (!job.job_date) missing.push('start date');
      if (!job.job_end) missing.push('end date');
      res.status(400).json({ error: `Cannot create in HireHop: ${missing.join(' and ')} required` });
      return;
    }

    // Look up HireHop client_id from external_id_map
    let hhClientId: number | null = null;
    if (job.client_id) {
      const extMap = await query(
        `SELECT external_id FROM external_id_map WHERE entity_type = 'person' AND entity_id = $1 AND external_system = 'hirehop'
         UNION
         SELECT external_id FROM external_id_map WHERE entity_type = 'organisation' AND entity_id = $1 AND external_system = 'hirehop'`,
        [job.client_id]
      );
      if (extMap.rows.length > 0) {
        hhClientId = parseInt(extMap.rows[0].external_id, 10);
      }
    }

    // Format dates as YYYY-MM-DD hh:mm (HireHop expects this, use UTC to avoid timezone drift)
    const formatHHDate = (d: string | null): string | undefined => {
      if (!d) return undefined;
      try {
        const date = new Date(d);
        const yyyy = date.getUTCFullYear();
        const mm = String(date.getUTCMonth() + 1).padStart(2, '0');
        const dd = String(date.getUTCDate()).padStart(2, '0');
        const hh = String(date.getUTCHours()).padStart(2, '0');
        const min = String(date.getUTCMinutes()).padStart(2, '0');
        return `${yyyy}-${mm}-${dd} ${hh}:${min}`;
      } catch {
        return undefined;
      }
    };

    // Look up venue name if we have a venue_id
    let venueName = job.venue_name || undefined;
    if (!venueName && job.venue_id) {
      const venueResult = await query('SELECT name FROM venues WHERE id = $1', [job.venue_id]);
      if (venueResult.rows.length > 0) {
        venueName = venueResult.rows[0].name;
      }
    }

    // Look up the current user's HireHop user ID for manager assignment
    let hhUserId: number | null = null;
    if (req.user?.id) {
      const userResult = await query('SELECT hh_user_id FROM users WHERE id = $1', [req.user.id]);
      if (userResult.rows.length > 0 && userResult.rows[0].hh_user_id) {
        hhUserId = userResult.rows[0].hh_user_id;
      }
    }

    // Build HireHop job payload
    // HH API: `name` is required for new jobs, `job_name` is the job title
    const hhBody: Record<string, unknown> = {
      job: 0, // 0 = create new
      name: job.client_name || job.job_name || 'New Job', // required for new
      job_name: job.job_name || '',
      no_webhook: 1,
    };

    // Set manager to the OP user's HH account (avoids "API ONLY" as manager)
    if (hhUserId) hhBody.user = hhUserId;

    if (hhClientId) hhBody.client_id = hhClientId;
    if (job.company_name) hhBody.company = job.company_name;
    if (venueName) hhBody.venue = venueName;

    const outDate = formatHHDate(job.out_date);
    const startDate = formatHHDate(job.job_date);
    const endDate = formatHHDate(job.job_end);
    const toDate = formatHHDate(job.return_date);

    // If job_end is set but no separate out/return dates, default them
    const effectiveOut = outDate || startDate;
    const effectiveReturn = toDate || endDate;

    // HireHop save_job.php date fields
    if (effectiveOut) hhBody.out = effectiveOut;
    if (startDate) hhBody.start = startDate;
    if (endDate) {
      hhBody.end = endDate;
    }
    if (effectiveReturn) {
      hhBody.to = effectiveReturn;
    }

    // Explicitly calculate charge period (HH doesn't auto-calculate from dates via API)
    const chargeOutDate = new Date(job.out_date || job.job_date);
    const chargeInDate = new Date(job.return_date || job.job_end);
    if (!isNaN(chargeOutDate.getTime()) && !isNaN(chargeInDate.getTime())) {
      const diffMs = chargeInDate.getTime() - chargeOutDate.getTime();
      const totalHours = Math.max(0, diffMs / (1000 * 60 * 60));
      const chargeDays = Math.floor(totalHours / 24);
      const chargeHours = Math.round(totalHours % 24);
      hhBody.charge_days = chargeDays;
      hhBody.charge_hrs = chargeHours;
    }

    console.log('[Pipeline] Pushing to HireHop:', {
      out: hhBody.out, start: hhBody.start, end: hhBody.end, to: hhBody.to,
      charge_days: hhBody.charge_days, charge_hrs: hhBody.charge_hrs,
    });

    // POST to HireHop via broker
    const { hhBroker } = await import('../services/hirehop-broker');
    const hhResponse = await hhBroker.post<{ job?: number; JOB_ID?: number }>(
      '/api/save_job.php',
      hhBody,
      { priority: 'high' }
    );

    if (!hhResponse.success || !hhResponse.data) {
      console.error('[Pipeline] HireHop job creation failed:', hhResponse.error);
      res.status(502).json({ error: `HireHop API error: ${hhResponse.error || 'Unknown error'}` });
      return;
    }

    // Log full response to understand structure
    console.log('[Pipeline] HireHop save_job response:', JSON.stringify(hhResponse.data));

    // HireHop save_job.php returns various field names depending on version
    // Note: we sent job=0 for create, so HH may echo back job=0 — need to find the CREATED job number
    const data = hhResponse.data as Record<string, unknown>;
    // Try multiple possible field names; skip zero (which is our input for "create new")
    const candidates = [data.JOB_ID, data.NUMBER, data.job_number, data.id, data.ID, data.job_id];
    // Also check data.job but only if it's non-zero (we sent 0 for create)
    if (data.job && Number(data.job) > 0) candidates.unshift(data.job);
    const hhJobNumber = candidates.find(v => v !== undefined && v !== null && v !== '' && Number(v) > 0);
    if (!hhJobNumber) {
      console.error('[Pipeline] HireHop response missing job ID. Full response:', JSON.stringify(data));
      res.status(502).json({ error: 'HireHop did not return a job ID' });
      return;
    }

    // Write back the HH job number to OP
    await query(
      `UPDATE jobs SET hh_job_number = $1, updated_at = NOW() WHERE id = $2`,
      [hhJobNumber, jobId]
    );

    // Log as interaction
    await query(
      `INSERT INTO interactions (type, content, job_id, created_by, pipeline_status_at_creation)
       VALUES ('note', $1, $2, $3, $4)`,
      [`Created HireHop job #${hhJobNumber}`, jobId, req.user!.id, job.pipeline_status]
    );

    await logAudit(req.user!.id, 'jobs', jobId, 'update', job, { ...job, hh_job_number: hhJobNumber });

    res.json({ hh_job_number: hhJobNumber });
  } catch (error: any) {
    const msg = error?.message || String(error);
    console.error('Push to HireHop error:', msg, error);
    res.status(500).json({ error: `Failed to push to HireHop: ${msg}` });
  }
});

// ── Sync client change to HireHop ─────────────────────────────────────────

router.post('/:id/sync-client-to-hh', async (req: AuthRequest, res: Response) => {
  try {
    const jobId = req.params.id as string;

    // Get job
    const jobResult = await query(
      `SELECT id, hh_job_number, client_id, client_name, company_name, pipeline_status FROM jobs WHERE id = $1 AND is_deleted = false`,
      [jobId]
    );
    if (jobResult.rows.length === 0) {
      res.status(404).json({ error: 'Job not found' });
      return;
    }

    const job = jobResult.rows[0];

    if (!job.hh_job_number) {
      res.status(400).json({ error: 'Job is not linked to HireHop' });
      return;
    }

    // Look up HireHop client_id from external_id_map
    let hhClientId: number | null = null;
    if (job.client_id) {
      const extMap = await query(
        `SELECT external_id FROM external_id_map WHERE entity_type = 'organisation' AND entity_id = $1 AND external_system = 'hirehop'
         UNION
         SELECT external_id FROM external_id_map WHERE entity_type = 'person' AND entity_id = $1 AND external_system = 'hirehop'`,
        [job.client_id]
      );
      if (extMap.rows.length > 0) {
        hhClientId = parseInt(extMap.rows[0].external_id, 10);
      }
    }

    // Fetch organisation details for full contact sync
    let orgDetails: { name: string; email: string | null; phone: string | null; address: string | null; location: string | null } | null = null;
    if (job.client_id) {
      const orgResult = await query(
        `SELECT name, email, phone, address, location FROM organisations WHERE id = $1`,
        [job.client_id]
      );
      if (orgResult.rows.length > 0) {
        orgDetails = orgResult.rows[0];
      }
    }

    const { hhBroker } = await import('../services/hirehop-broker');

    // Step 1: Create/update contact in HireHop address book via job_save_contact.php
    const contactName = orgDetails?.name || job.client_name || job.company_name || '';
    const contactPayload: Record<string, unknown> = {
      JOB_ID: job.hh_job_number,
      NAME: contactName,
      COMPANY: contactName,
      CLIENT: 1,
      no_webhook: 1,
    };

    // Include existing HH client ID to update rather than create a duplicate
    if (hhClientId) {
      contactPayload.CLIENT_ID = hhClientId;
    }

    // Add address, email, phone from org details if available
    if (orgDetails) {
      // Build full address from address + location fields
      const addressParts = [orgDetails.address, orgDetails.location].filter(Boolean);
      if (addressParts.length > 0) {
        contactPayload.ADDRESS = addressParts.join(', ');
      }
      if (orgDetails.email) {
        contactPayload.EMAIL = orgDetails.email;
      }
      if (orgDetails.phone) {
        contactPayload.TELEPHONE = orgDetails.phone;
      }
    }

    const contactResponse = await hhBroker.post(
      '/php_functions/job_save_contact.php',
      contactPayload,
      { priority: 'high' }
    );

    if (!contactResponse.success) {
      console.error('[Pipeline] HireHop contact sync failed:', contactResponse.error);
      res.status(502).json({ error: `HireHop contact API error: ${contactResponse.error || 'Unknown error'}` });
      return;
    }

    // Extract the returned HH contact ID and store in external_id_map
    const returnedHhClientId = (contactResponse.data as any)?.id;
    if (returnedHhClientId && job.client_id) {
      await query(
        `INSERT INTO external_id_map (entity_type, entity_id, external_system, external_id)
         VALUES ('organisation', $1, 'hirehop', $2)
         ON CONFLICT (entity_type, entity_id, external_system) DO UPDATE SET external_id = $2, synced_at = NOW()`,
        [job.client_id, String(returnedHhClientId)]
      );
      hhClientId = returnedHhClientId;
      console.log('[Pipeline] HireHop contact created/updated, ID:', returnedHhClientId);
    }

    // Step 2: Update the job's client link via save_job.php
    const jobBody: Record<string, unknown> = {
      job: job.hh_job_number,
      name: job.client_name || '',
      company: job.company_name || job.client_name || '',
      no_webhook: 1,
    };

    if (hhClientId) jobBody.client_id = hhClientId;

    const hhResponse = await hhBroker.post(
      '/api/save_job.php',
      jobBody,
      { priority: 'high' }
    );

    if (!hhResponse.success) {
      console.error('[Pipeline] HireHop job client link failed:', hhResponse.error);
      // Contact was already synced, so we warn but don't fully fail
      console.warn('[Pipeline] Contact was synced but job client link failed for HH job #' + job.hh_job_number);
    }

    // Build a summary of what was synced
    const syncedFields: string[] = ['name'];
    if (orgDetails?.email) syncedFields.push('email');
    if (orgDetails?.phone) syncedFields.push('phone');
    if (orgDetails?.address || orgDetails?.location) syncedFields.push('address');

    console.log('[Pipeline] Client synced to HireHop job #' + job.hh_job_number + ':', contactName, '(fields:', syncedFields.join(', ') + ')');

    // Log as interaction on the job
    await query(
      `INSERT INTO interactions (type, content, job_id, created_by, pipeline_status_at_creation)
       VALUES ('note', $1, $2, $3, $4)`,
      [
        `Synced client "${contactName}" to HireHop job #${job.hh_job_number} (contact details: ${syncedFields.join(', ')})`,
        jobId,
        req.user!.id,
        job.pipeline_status,
      ]
    );

    await logAudit(req.user!.id, 'jobs', jobId, 'update', { client_synced: false }, { client_synced: true, hh_job_number: job.hh_job_number, synced_fields: syncedFields });

    res.json({ success: true, message: `Client synced to HireHop job #${job.hh_job_number} (${syncedFields.join(', ')})` });
  } catch (error: any) {
    const msg = error?.message || String(error);
    console.error('Sync client to HireHop error:', msg, error);
    res.status(500).json({ error: `Failed to sync client to HireHop: ${msg}` });
  }
});

export default router;
