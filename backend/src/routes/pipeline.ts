import { Router, Response } from 'express';
import { z } from 'zod';
import { query } from '../config/database';
import { authenticate, authorize, AuthRequest } from '../middleware/auth';
import { validate } from '../middleware/validate';
import { logAudit } from '../middleware/audit';

const router = Router();
router.use(authenticate);
router.use(authorize('admin', 'manager', 'staff'));

// Pipeline status labels for transition logging
const PIPELINE_LABELS: Record<string, string> = {
  new_enquiry: 'New Enquiry',
  quoting: 'Quoting',
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
      conditions.push(`(j.job_name ILIKE $${paramIndex} OR j.client_name ILIKE $${paramIndex} OR j.company_name ILIKE $${paramIndex})`);
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
        m2p.first_name as manager2_first_name, m2p.last_name as manager2_last_name
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
  details: z.string().min(1),              // "What they want"
  job_date: z.string(),                    // Start date
  job_end: z.string(),                     // End date
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
});

router.post('/enquiry', validate(createEnquirySchema), async (req: AuthRequest, res: Response) => {
  try {
    const {
      client_name, details, job_date, job_end, job_name,
      client_id, venue_id, venue_name, enquiry_source,
      job_value, likelihood, notes, manager1_person_id,
    } = req.body;

    // Auto-generate job name if not provided
    const finalJobName = job_name || `${client_name} — ${new Date(job_date).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}`;

    // Resolve manager: use provided person_id, or look up the current user's person_id
    let managerId = manager1_person_id || null;
    if (!managerId) {
      const userResult = await query(
        `SELECT person_id FROM users WHERE id = $1`,
        [req.user!.id]
      );
      managerId = userResult.rows[0]?.person_id || null;
    }

    const result = await query(
      `INSERT INTO jobs (
        job_name, details, job_date, job_end,
        client_id, client_name, company_name,
        venue_id, venue_name,
        enquiry_source, job_value, likelihood, notes,
        manager1_person_id,
        status, status_name,
        pipeline_status, pipeline_status_changed_at,
        chase_interval_days, next_chase_date,
        created_by
      ) VALUES (
        $1, $2, $3, $4,
        $5, $6, $6,
        $7, $8,
        $9, $10, $11, $12,
        $13,
        0, 'Enquiry',
        'new_enquiry', NOW(),
        3, CURRENT_DATE + INTERVAL '3 days',
        $14
      ) RETURNING *`,
      [
        finalJobName, details, job_date, job_end,
        client_id || null, client_name,
        venue_id || null, venue_name || null,
        enquiry_source || null, job_value || null, likelihood || 'warm', notes || null,
        managerId,
        req.user!.id,
      ]
    );

    // Log creation as an interaction on the job timeline
    await query(
      `INSERT INTO interactions (type, content, job_id, created_by, pipeline_status_at_creation)
       VALUES ('status_transition', $1, $2, $3, 'new_enquiry')`,
      [`New enquiry created: ${finalJobName}`, result.rows[0].id, req.user!.id]
    );

    await logAudit(req.user!.id, 'jobs', result.rows[0].id, 'create', null, result.rows[0]);

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

export default router;
