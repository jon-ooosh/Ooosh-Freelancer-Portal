import { Router, Response } from 'express';
import { z } from 'zod';
import { query } from '../config/database';
import { authenticate, authorize, AuthRequest, STAFF_ROLES } from '../middleware/auth';
import { validate } from '../middleware/validate';
import { logAudit } from '../middleware/audit';
import { writeBackStatusToHireHop, writeBackJobNameToHireHop } from '../services/hirehop-writeback';
import { hhBroker } from '../services/hirehop-broker';
import { sendLastMinuteAlert } from '../services/money-emails';
import emailService from '../services/email-service';
import { getFrontendUrl } from '../config/app-urls';
import {
  triggerHireFormEmailOnConfirmation,
  hireFormResultIsAnomaly,
  sendConfirmationSilentSkipAlert,
} from '../services/confirmation-hooks';
import { alertReturnedWithStillBookedOutVans } from '../services/vehicle-emails';

const router = Router();
router.use(authenticate);
router.use(authorize(...STAFF_ROLES));

// Pipeline status labels for transition logging.
// 'chasing' is intentionally NOT a value here — it's a derived view (a job
// with next_chase_date <= today and a pre-confirmed status), surfaced via
// is_chasing on the API response. The Kanban renders it as a column but
// pipeline_status itself never holds 'chasing'.
const PIPELINE_LABELS: Record<string, string> = {
  new_enquiry: 'Enquiries',
  quoting: 'Enquiries',
  paused: 'Paused Enquiry',
  provisional: 'Provisional',
  confirmed: 'Confirmed',
  lost: 'Lost',
  cancelled: 'Cancelled',
};

// ── Pipeline list with filtering ───────────────────────────────────────────

router.get('/', async (req: AuthRequest, res: Response) => {
  try {
    const {
      status, likelihood, manager, chase_status, has_hh_job,
      date_from, date_to, search,
      service_type,            // Comma-separated requirement_type values (vehicle, backline, rehearsal)
      value_min, value_max,    // Job value bucket bounds (£)
      chase_count_min,         // e.g. "3" for "chased 3+ times"
      chase_count_max,         // e.g. "0" for "never chased"
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

    // Service type filter — checks job_requirements for matching requirement_type.
    // Comma-separated; matches if the job has ANY of the listed requirement types.
    if (service_type) {
      const types = (service_type as string).split(',');
      conditions.push(`EXISTS (
        SELECT 1 FROM job_requirements jr
        WHERE jr.job_id = j.id
          AND jr.phase = 'pre_hire'
          AND jr.status != 'cancelled'
          AND jr.requirement_type = ANY($${paramIndex})
      )`);
      params.push(types);
      paramIndex++;
    }

    // Value bucket filter
    if (value_min) {
      conditions.push(`j.job_value >= $${paramIndex}`);
      params.push(parseFloat(value_min as string));
      paramIndex++;
    }
    if (value_max) {
      conditions.push(`j.job_value <= $${paramIndex}`);
      params.push(parseFloat(value_max as string));
      paramIndex++;
    }

    // Chase count filter
    if (chase_count_min) {
      conditions.push(`COALESCE(j.chase_count, 0) >= $${paramIndex}`);
      params.push(parseInt(chase_count_min as string));
      paramIndex++;
    }
    if (chase_count_max) {
      conditions.push(`COALESCE(j.chase_count, 0) <= $${paramIndex}`);
      params.push(parseInt(chase_count_max as string));
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
         WHERE jo.job_id = j.id) as linked_organisations,
        (j.next_chase_date IS NOT NULL
         AND j.next_chase_date <= CURRENT_DATE
         AND j.pipeline_status IN ('new_enquiry', 'quoting', 'paused', 'provisional')) as is_chasing
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
        AND pipeline_status NOT IN ('confirmed', 'lost', 'cancelled')
        AND next_chase_date IS NOT NULL
    `);

    // Total active pipeline value (excl. confirmed and lost)
    const activeValue = await query(`
      SELECT COALESCE(SUM(job_value), 0) as total
      FROM jobs
      WHERE is_deleted = false
        AND pipeline_status NOT IN ('confirmed', 'lost', 'cancelled')
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

// ── Distinct managers (for filter dropdown) ────────────────────────────────
//
// Returns every person currently referenced as manager1 or manager2 on any
// non-deleted job. Used by the Pipeline + Lost/Cancelled filter dropdowns to
// avoid loading the full /users or /people lists.

router.get('/managers', async (_req: AuthRequest, res: Response) => {
  try {
    const result = await query(`
      SELECT DISTINCT p.id, p.first_name, p.last_name
      FROM people p
      WHERE p.id IN (
        SELECT manager1_person_id FROM jobs WHERE is_deleted = false AND manager1_person_id IS NOT NULL
        UNION
        SELECT manager2_person_id FROM jobs WHERE is_deleted = false AND manager2_person_id IS NOT NULL
      )
      ORDER BY p.first_name, p.last_name
    `);
    res.json({ data: result.rows });
  } catch (error) {
    console.error('Pipeline managers error:', error);
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
        AND j.pipeline_status NOT IN ('confirmed', 'lost', 'cancelled')
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
  out_time: z.string().optional().nullable(),      // Time equipment leaves (HH:MM), default 09:00
  start_time: z.string().optional().nullable(),    // Time charging starts (HH:MM), default 09:00
  return_time: z.string().optional().nullable(),   // Time equipment back (HH:MM), default 09:00
  end_time: z.string().optional().nullable(),      // Time charging ends (HH:MM), default 09:00
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
  // Per-job contact selection — landed in migration 086. The modal sends
  // the people staff ticked as contacts on this hire (a subset of the
  // client org's people), with one optional `primary_contact_person_id`
  // marking the lead. Routing graduation that ACTUALLY reads this lives
  // in the next phase; this just persists the choice.
  contact_person_ids: z.array(z.string().uuid()).optional().nullable(),
  primary_contact_person_id: z.string().uuid().optional().nullable(),
});

router.post('/enquiry', validate(createEnquirySchema), async (req: AuthRequest, res: Response) => {
  try {
    const {
      client_name, out_date, job_date, job_end, return_date, job_name,
      client_id, venue_id, venue_name, enquiry_source,
      job_value, likelihood, notes, manager1_person_id,
      next_chase_date, chase_interval_days, chase_alert_user_id,
      service_types, band_name,
      contact_person_ids, primary_contact_person_id,
      out_time, start_time, return_time, end_time,
    } = req.body;
    let { details } = req.body;

    // Sanity-check the date/time ordering before we persist
    const dateTimeError = validateJobDateTimes({
      out_date: out_date ?? null,
      job_date: job_date ?? null,
      job_end: job_end ?? null,
      return_date: return_date ?? null,
      out_time: out_time ?? null,
      start_time: start_time ?? null,
      return_time: return_time ?? null,
      end_time: end_time ?? null,
    });
    if (dateTimeError) {
      res.status(400).json({ error: dateTimeError });
      return;
    }

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

    // Server-side fallback: if the form sent only client_name (no client_id)
    // and an existing organisation has that exact name, auto-link it. Catches
    // cases where the user typed a known client but didn't click the
    // dropdown row, leaving the job stranded as text-only.
    let resolvedClientId = client_id || null;
    if (!resolvedClientId && client_name) {
      const lookup = await query(
        `SELECT id FROM organisations
         WHERE LOWER(TRIM(name)) = LOWER(TRIM($1)) AND is_deleted = false
         LIMIT 2`,
        [client_name]
      );
      if (lookup.rows.length === 1) {
        resolvedClientId = lookup.rows[0].id;
      }
      // 0 matches → leave null (text only — possibly a new client). 2+ matches
      // → ambiguous, also leave null and let staff link manually.
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
        out_time, start_time, return_time, end_time,
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
        $19, $20, $21, $22,
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
        resolvedClientId, client_name,
        venue_id || null, venue_name || null,
        enquiry_source || null, job_value || null, likelihood || 'warm', notes || null,
        managerId,
        req.user!.id,
        chaseDate || String(chaseIntervalDays),
        chaseIntervalDays,
        out_time || '09:00', start_time || out_time || '09:00', return_time || '09:00', end_time || '09:00',
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
        `INSERT INTO notifications (user_id, type, title, content, entity_type, entity_id, priority, action_url, source_user_id)
         VALUES ($1, 'chase_alert', $2, $3, 'jobs', $4, 'normal', $5, $6)`,
        [
          chase_alert_user_id,
          `Chase reminder: ${finalJobName}`,
          `Chase due for ${client_name} — ${finalJobName}`,
          result.rows[0].id,
          `/jobs/${result.rows[0].id}`,
          req.user!.id,
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

    // Per-job contact selection (migration 086). Stores which of the
    // client org's people are actually on THIS hire. Routing graduation
    // (Phase C) will read this; for now it's just the audit + display
    // signal so the cascade picker in the modal has somewhere to land
    // its ticks.
    if (contact_person_ids && contact_person_ids.length > 0) {
      const createdJobId = result.rows[0].id;
      for (const personId of contact_person_ids) {
        try {
          const isPrimary = primary_contact_person_id === personId;
          await query(
            `INSERT INTO job_contacts (job_id, person_id, is_primary, created_by)
             VALUES ($1, $2, $3, $4)
             ON CONFLICT (job_id, person_id) DO NOTHING`,
            [createdJobId, personId, isPrimary, req.user!.id]
          );
        } catch (contactErr) {
          console.error(`Failed to link contact ${personId} to job ${createdJobId}:`, contactErr);
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
  pipeline_status: z.enum(['new_enquiry', 'quoting', 'paused', 'provisional', 'confirmed', 'lost', 'cancelled',
    'prepped', 'dispatched', 'returned_incomplete', 'returned', 'completed']),
  // Context fields depending on status
  hold_reason: z.string().optional().nullable(),
  hold_reason_detail: z.string().optional().nullable(),
  // Optional revisit date when pausing. By default a transition to `paused`
  // clears next_chase_date — staff can opt-in to a future revisit via the
  // pause modal, which sends an ISO date here. Survives the sacred-future
  // rule on any subsequent contact-type interaction.
  revisit_date: z.string().optional().nullable(),
  confirmed_method: z.enum(['deposit', 'full_payment', 'po', 'manual']).optional().nullable(),
  lost_reason: z.string().optional().nullable(),
  lost_detail: z.string().optional().nullable(),
  transition_note: z.string().optional().nullable(),  // Why the status changed
  // Completion retro
  retro_rating: z.enum(['great', 'ok', 'issues']).optional().nullable(),
  retro_notes: z.string().optional().nullable(),
  retro_follow_up: z.string().optional().nullable(),
  retro_follow_up_date: z.string().optional().nullable(),
  retro_reminders: z.array(z.object({
    text: z.string(),
    date: z.string(),
    delivery: z.enum(['notification', 'email', 'both']).default('both'),
    priority: z.enum(['normal', 'high', 'urgent']).default('normal'),
    user_id: z.string().uuid().nullable().optional(),
  })).optional().nullable(),
  // Requirement IDs the user explicitly chose to KEEP alive past lost/cancelled.
  // Everything else open on the job is auto-cancelled by the cleanup pass below.
  // Kept items get keep_after_close=true so background scanners (reminder
  // scanner, hire-form auto-emailer, etc.) still fire them. See CLAUDE.md →
  // "Lost / Cancelled cleanup pattern".
  keep_requirement_ids: z.array(z.string().uuid()).optional().nullable(),
});

router.patch('/:id/status', validate(updateStatusSchema), async (req: AuthRequest, res: Response) => {
  try {
    const jobId = req.params.id as string;
    const {
      pipeline_status, hold_reason, hold_reason_detail, revisit_date,
      confirmed_method, lost_reason, lost_detail, transition_note,
      retro_rating, retro_notes, retro_follow_up, retro_follow_up_date,
      retro_reminders, keep_requirement_ids,
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
      // Chase-clearing rule on pause: by default a paused enquiry drops out
      // of the chase pile (matches lost/cancelled/confirmed). Staff can
      // opt-in to a future revisit via the pause modal — that date survives
      // here and re-enters Chasing naturally when it falls due (existing
      // is_chasing derivation already includes 'paused'). The sacred-future
      // rule then protects it from accidental shortening on subsequent
      // contact-type interactions.
      if (revisit_date) {
        updates.push(`next_chase_date = $${pIdx}::date`);
        updateParams.push(revisit_date);
        pIdx++;
      } else {
        updates.push(`next_chase_date = NULL`);
      }
    } else if (pipeline_status === 'confirmed') {
      updates.push(`confirmed_method = $${pIdx}`);
      updateParams.push(confirmed_method || null);
      pIdx++;
      updates.push(`confirmed_at = NOW()`);
      // Clear chase date — once confirmed, chasing belongs to the reminders
      // system, not the enquiry chase pipeline.
      updates.push(`next_chase_date = NULL`);
    } else if (pipeline_status === 'lost') {
      updates.push(`lost_reason = $${pIdx}`);
      updateParams.push(lost_reason || null);
      pIdx++;
      updates.push(`lost_detail = $${pIdx}`);
      updateParams.push(lost_detail || null);
      pIdx++;
      updates.push(`lost_at = NOW()`);
      // Clear chase date — lost jobs don't need chasing
      updates.push(`next_chase_date = NULL`);
    } else if (pipeline_status === 'cancelled') {
      // Cancellation fields are populated by the cancellations route (POST /api/cancellations/:id/process)
      // The pipeline status change here just sets the status; the cancellation route handles the full workflow.
      // Clear chase date — cancelled jobs don't need chasing
      updates.push(`next_chase_date = NULL`);
      updates.push(`cancelled_at = NOW()`);
    } else if (pipeline_status === 'provisional') {
      // Auto-bump chase: moving INTO provisional from a pre-confirmed enquiry
      // stage signals "we have movement, expect a deposit/decision soon".
      // Bump next_chase_date forward by chase_interval_days — but only if the
      // current chase date is null/today/past. A future-dated chase is a
      // deliberate user decision and must not be shortened.
      const enquiryStages = ['new_enquiry', 'quoting', 'paused'];
      if (enquiryStages.includes(fromStatus)) {
        updates.push(`next_chase_date = CASE
          WHEN next_chase_date IS NULL OR next_chase_date <= CURRENT_DATE
            THEN (CURRENT_DATE + (COALESCE(chase_interval_days, 5) || ' days')::interval)::date
          ELSE next_chase_date
        END`);
      }
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

    // Clear cancellation fields when moving out of cancelled (re-opening)
    if (fromStatus === 'cancelled' && pipeline_status !== 'cancelled') {
      updates.push(`cancelled_at = NULL`);
      updates.push(`cancelled_by = NULL`);
      updates.push(`cancellation_reason = NULL`);
      updates.push(`cancellation_fee = NULL`);
      updates.push(`cancellation_refund = NULL`);
      updates.push(`cancellation_notice_days = NULL`);
      updates.push(`cancellation_notes = NULL`);
      updates.push(`cancellation_tier = NULL`);
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

    // Log completion retro as a separate interaction (so it's visible on timeline)
    if (pipeline_status === 'completed' && (retro_rating || retro_notes || retro_follow_up)) {
      const ratingLabels: Record<string, string> = { great: 'Great', ok: 'OK', issues: 'Issues' };
      const retroParts = [`Job retro: ${ratingLabels[retro_rating || 'ok'] || retro_rating}`];
      if (retro_notes) retroParts.push(retro_notes);
      if (retro_follow_up) retroParts.push(`Follow-up: ${retro_follow_up}`);
      await query(
        `INSERT INTO interactions (type, content, job_id, created_by, pipeline_status_at_creation)
         VALUES ('note', $1, $2, $3, 'completed')`,
        [retroParts.join('\n'), jobId, req.user!.id]
      );

      // Create follow-up notifications from reminders array (or legacy single reminder)
      const jobName = currentJob.job_name || currentJob.client_name || `Job ${currentJob.hh_job_number || ''}`;
      const remindersList = retro_reminders && retro_reminders.length > 0
        ? retro_reminders
        : (retro_follow_up && retro_follow_up_date
          ? [{ text: retro_follow_up, date: retro_follow_up_date, delivery: 'both' as const, user_id: null }]
          : []);

      for (const reminder of remindersList) {
        try {
          const targetUserId = reminder.user_id || req.user!.id;
          const dueDate = new Date(reminder.date + 'T09:00:00Z').toISOString();

          await query(
            `INSERT INTO notifications
               (user_id, type, title, content, entity_type, entity_id, action_url,
                priority, source_user_id, due_date, snoozed_until)
             VALUES ($1, 'follow_up', $2, $3, 'jobs', $4, $5, $6, $7, $8, $8)`,
            [
              targetUserId,
              `Follow-up: ${jobName}`,
              reminder.text,
              jobId,
              `/jobs/${jobId}?tab=timeline`,
              reminder.priority || 'normal',
              req.user!.id,
              dueDate,
            ]
          );
        } catch (followUpErr) {
          console.warn('[Pipeline] Failed to create follow-up notification:', followUpErr);
        }
      }
    }

    await logAudit(req.user!.id, 'jobs', jobId, 'update', currentJob, result.rows[0]);

    // Safety net: flag if the job just moved INTO 'returned' but vans on the
    // job are still booked out. Non-blocking — emails info@ so staff spot it.
    if (pipeline_status === 'returned' && fromStatus !== 'returned') {
      void alertReturnedWithStillBookedOutVans({
        jobId,
        triggerSource: `Manual UI (user ${req.user!.email || req.user!.id})`,
      });
    }

    // Lost cleanup — flag the items the user opted to keep alive past close-out.
    // The actual auto-cancellation pass runs AFTER the event-trigger pass below
    // so triggered reminders get to fire & self-mark-done first.
    // (Cancelled transitions go through cancellations.ts, which has its own
    // equivalent pass — see CLAUDE.md → "Lost / Cancelled cleanup pattern".)
    if (pipeline_status === 'lost' && fromStatus !== 'lost') {
      const keepIds = Array.isArray(keep_requirement_ids) ? keep_requirement_ids : [];
      if (keepIds.length > 0) {
        try {
          await query(
            `UPDATE job_requirements
             SET keep_after_close = true,
                 notes = COALESCE(notes, '') ||
                         E'\n[Kept alive after job marked lost]',
                 updated_at = NOW()
             WHERE id = ANY($1::uuid[])
               AND job_id = $2
               AND status NOT IN ('done', 'cancelled')`,
            [keepIds, jobId]
          );
        } catch (cancelErr) {
          console.warn('[Pipeline] Failed to flag kept requirements on lost:', cancelErr);
        }
      }
    }

    // Fire event-triggered reminders (reminder requirements with matching event_trigger)
    if (['confirmed', 'cancelled', 'lost'].includes(pipeline_status)) {
      try {
        const triggered = await query(
          `SELECT jr.id, jr.custom_label, jr.assigned_to, jr.notes, jr.delivery_method, jr.job_id
           FROM job_requirements jr
           WHERE jr.job_id = $1
             AND jr.requirement_type = 'reminder'
             AND jr.event_trigger = $2
             AND jr.status NOT IN ('done', 'cancelled')`,
          [jobId, pipeline_status]
        );

        const jobName = currentJob.job_name || currentJob.client_name || `Job ${currentJob.hh_job_number || ''}`;
        for (const rem of triggered.rows) {
          const targetUserId = rem.assigned_to || req.user!.id;
          const title = `Reminder triggered: ${rem.custom_label || 'Reminder'}`;
          const content = `Job ${pipeline_status} — ${rem.custom_label || 'Reminder'} (${jobName})`;
          const deliveryMethod = rem.delivery_method || 'both';

          // Respect delivery_method: 'notification' → low priority (no email escalation),
          // 'email' → send email immediately + mark as emailed, 'both' → normal escalation
          const priority = deliveryMethod === 'notification' ? 'low' : 'high';
          const emailSentClause = deliveryMethod === 'email' ? `, email_sent_at = NOW()` : '';

          await query(
            `INSERT INTO notifications (user_id, type, title, content, entity_type, entity_id, action_url, priority, source_user_id)
             VALUES ($1, 'follow_up', $2, $3, 'jobs', $4, $5, $6, $7)`,
            [targetUserId, title, content, rem.job_id, `/jobs/${rem.job_id}?tab=overview`, priority, req.user!.id]
          );

          // If email-only or both, send email immediately for event triggers (they're time-sensitive)
          if (deliveryMethod === 'email' || deliveryMethod === 'both') {
            try {
              const userResult = await query('SELECT u.email, p.first_name FROM users u LEFT JOIN people p ON p.id = u.person_id WHERE u.id = $1', [targetUserId]);
              if (userResult.rows.length > 0 && userResult.rows[0].email) {
                await emailService.sendRaw({
                  to: userResult.rows[0].email,
                  subject: title,
                  html: `<p>Hi ${userResult.rows[0].first_name || ''},</p>
                         <p>Your reminder "<strong>${rem.custom_label || 'Reminder'}</strong>" has been triggered because the job <strong>${jobName}</strong> is now <strong>${pipeline_status}</strong>.</p>
                         ${rem.notes ? `<p>Notes: ${rem.notes}</p>` : ''}
                         <p><a href="${getFrontendUrl()}/jobs/${rem.job_id}?tab=overview">View Job</a></p>`,
                });
              }
            } catch (emailErr) {
              console.warn('[Pipeline] Event trigger email failed:', emailErr);
            }
          }

          // Mark the reminder as done
          await query(`UPDATE job_requirements SET status = 'done', updated_at = NOW() WHERE id = $1`, [rem.id]);
        }

        if (triggered.rows.length > 0) {
          console.log(`[Pipeline] Fired ${triggered.rows.length} event-triggered reminder(s) for job ${jobId} → ${pipeline_status}`);
        }
      } catch (triggerErr) {
        console.warn('[Pipeline] Event trigger check failed:', triggerErr);
      }
    }

    // Lost cleanup — second half. After the event-trigger pass has fired (and
    // self-marked-done) any reminders set to trigger on 'lost', sweep up
    // everything else still open and not explicitly kept.
    if (pipeline_status === 'lost' && fromStatus !== 'lost') {
      try {
        const swept = await query(
          `UPDATE job_requirements
           SET status = 'cancelled',
               notes = COALESCE(notes, '') ||
                       E'\n[Auto-cancelled: job marked lost]',
               updated_at = NOW()
           WHERE job_id = $1
             AND status NOT IN ('done', 'cancelled')
             AND keep_after_close = false
           RETURNING id`,
          [jobId]
        );
        if (swept.rows.length > 0) {
          console.log(`[Pipeline] Auto-cancelled ${swept.rows.length} open requirement(s) on lost transition for job ${jobId}`);
        }
      } catch (cancelErr) {
        console.warn('[Pipeline] Failed to sweep open requirements on lost:', cancelErr);
      }
    }

    // Last-minute booking alert (any route to confirmed, job starts within 3 days)
    if (pipeline_status === 'confirmed') {
      sendLastMinuteAlert(jobId).catch(e => console.error('[Pipeline] Last-minute alert failed:', e));

      // Hire form email: runs HH-derivation inline (covers HH-synced jobs whose
      // requirements hadn't yet been derived) and fires the hire form request
      // email if the job has a self-drive vehicle and starts within 10 days.
      // Silent skips alert info@oooshtours.co.uk so they don't go unnoticed.
      (async () => {
        try {
          const hfResult = await triggerHireFormEmailOnConfirmation(jobId);
          const anomaly = hireFormResultIsAnomaly(hfResult);
          if (anomaly) {
            const jobRow = await query(
              `SELECT hh_job_number, job_name, client_name FROM jobs WHERE id = $1`,
              [jobId]
            );
            const j = jobRow.rows[0] || {};
            await sendConfirmationSilentSkipAlert({
              jobId,
              jobNumber: j.hh_job_number,
              jobName: j.job_name ?? null,
              clientName: j.client_name ?? null,
              triggerSource: 'status_change',
              issues: [anomaly],
            });
          }
        } catch (err) {
          console.error('[Pipeline] Hire form email on confirmation failed:', err);
        }
      })();
    }

    // Lost cascade — mirror the cancellation flow. Without this the
    // transport/crew quotes + assignments keep showing as active work on
    // Transport Ops even though the parent job is dead. We skip the
    // freelancer email for past-dated jobs (backfill / historical data
    // import) so cleaning up old records doesn't spam anyone.
    if (pipeline_status === 'lost' && fromStatus !== 'lost') {
      try {
        // Pull crew before we cancel assignments so we still have the data
        const crewResult = await query(
          `SELECT qa.role, p.first_name, p.last_name, p.email
             FROM quote_assignments qa
             JOIN people p ON p.id = qa.person_id
             WHERE qa.quote_id IN (SELECT id FROM quotes WHERE job_id = $1 AND is_deleted = false)
               AND qa.status NOT IN ('cancelled', 'declined')
               AND qa.is_ooosh_crew = false
               AND p.email IS NOT NULL`,
          [jobId]
        );

        await query(
          `UPDATE quotes
             SET status = 'cancelled',
                 ops_status = 'cancelled',
                 status_changed_at = NOW(),
                 status_changed_by = $2,
                 cancelled_reason = COALESCE(cancelled_reason, 'Parent job marked lost'),
                 updated_at = NOW()
           WHERE job_id = $1
             AND is_deleted = false
             AND status NOT IN ('cancelled', 'completed')`,
          [jobId, req.user!.id]
        );

        await query(
          `UPDATE quote_assignments SET status = 'cancelled', updated_at = NOW()
           WHERE quote_id IN (SELECT id FROM quotes WHERE job_id = $1 AND is_deleted = false)
             AND status NOT IN ('cancelled', 'declined')`,
          [jobId]
        );

        // Vehicle hire assignment sweep. Without this, speculative/orphan
        // rows (derivation-engine pre-allocations, quick-assign, even stray
        // booked_out rows on test jobs) get left behind on a lost job and
        // keep blocking syncFleetHireStatus from transitioning the van to
        // 'Prep Needed'. Mirrors the cancellations.ts /process flow.
        // Dual job match catches V&D-style rows (job_id IS NULL).
        const hhJobNumber = currentJob.hh_job_number ?? null;
        const sweptVha = await query(
          `UPDATE vehicle_hire_assignments
             SET status = 'cancelled',
                 status_changed_at = NOW(),
                 notes = COALESCE(notes, '') ||
                         E'\n[Auto-cancelled: job marked lost]',
                 updated_at = NOW()
           WHERE (job_id = $1
                  OR (job_id IS NULL AND hirehop_job_id = $2::integer))
             AND status NOT IN ('cancelled', 'returned', 'swapped')
           RETURNING id, vehicle_id`,
          [jobId, hhJobNumber]
        );
        if (sweptVha.rows.length > 0) {
          console.log(`[Pipeline lost cascade] Cancelled ${sweptVha.rows.length} open vehicle_hire_assignment(s) for job ${jobId}`);
          // Recompute fleet hire_status for each affected vehicle so the
          // cached projection catches up immediately.
          const { syncFleetHireStatus } = await import('../services/fleet-hire-status-sync');
          const seen = new Set<string>();
          for (const r of sweptVha.rows) {
            if (r.vehicle_id && !seen.has(r.vehicle_id)) {
              seen.add(r.vehicle_id);
              try { await syncFleetHireStatus(r.vehicle_id); }
              catch (e) { console.warn('[Pipeline lost cascade] syncFleetHireStatus failed:', e); }
            }
          }
        }

        // Email only for future-dated jobs. currentJob.job_date is a Date
        // or ISO string; compare on calendar-day to be friendly to TZ.
        const rawJobDate = currentJob.job_date ? new Date(currentJob.job_date as string | Date) : null;
        const today = new Date(); today.setHours(0, 0, 0, 0);
        const isFuture = !!rawJobDate && !Number.isNaN(rawJobDate.getTime()) && rawJobDate >= today;

        if (isFuture && crewResult.rows.length > 0) {
          const jobNumber = currentJob.hh_job_number ? `J-${currentJob.hh_job_number}` : 'NEW';
          const jobName = currentJob.job_name || 'Untitled';
          const jobDates = [currentJob.job_date, currentJob.job_end].filter(Boolean).map(
            (d: string | Date) => new Date(d).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })
          ).join(' — ');
          for (const crew of crewResult.rows) {
            emailService.send('job_cancelled_crew', {
              to: crew.email,
              variables: {
                crewName: `${crew.first_name || ''} ${crew.last_name || ''}`.trim() || 'there',
                jobName,
                jobNumber,
                jobDates,
                crewRole: crew.role || 'Crew',
              },
            }).catch(err => console.error(`[Pipeline lost cascade] Email failed for ${crew.email}:`, err));
          }
        }
      } catch (cascadeErr) {
        console.error('[Pipeline] Lost cascade failed:', cascadeErr);
      }
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
  chase_alert_user_id: z.string().uuid().optional().nullable(),
  chase_alert_delivery: z.enum(['bell', 'bell_email', 'none']).optional().nullable(),
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
      'chase_alert_user_id', 'chase_alert_delivery',
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
    const { client_id, client_name, exclude_job_id, band_id } = req.query;

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

    // Band history — if band_id provided, fetch jobs linked to this band via job_organisations
    let band_history = null;
    if (band_id) {
      const bandJobs = await query(
        `SELECT
          j.id, j.hh_job_number, j.job_name, j.status, j.status_name,
          j.pipeline_status, j.job_date, j.job_end, j.job_value,
          j.client_name, j.company_name, j.likelihood,
          j.created_at
        FROM jobs j
        JOIN job_organisations jo ON jo.job_id = j.id
        WHERE jo.organisation_id = $1
          AND jo.role = 'band'
          AND j.is_deleted = false
          ${exclude_job_id ? `AND j.id != $2` : ''}
        ORDER BY j.job_date DESC NULLS LAST, j.created_at DESC
        LIMIT 20`,
        exclude_job_id ? [band_id, exclude_job_id] : [band_id]
      );

      const bandStats = await query(
        `SELECT
          COUNT(*) as total_jobs,
          COUNT(*) FILTER (WHERE j.pipeline_status = 'confirmed' OR j.status = 2) as confirmed_jobs,
          COUNT(*) FILTER (WHERE j.pipeline_status = 'lost' OR j.status IN (9, 10)) as lost_jobs,
          COALESCE(SUM(j.job_value) FILTER (WHERE j.pipeline_status = 'confirmed' OR j.status = 2), 0) as total_confirmed_value,
          COALESCE(SUM(j.job_value), 0) as total_value
        FROM jobs j
        JOIN job_organisations jo ON jo.job_id = j.id
        WHERE jo.organisation_id = $1
          AND jo.role = 'band'
          AND j.is_deleted = false`,
        [band_id]
      );

      const bandOrg = await query(
        `SELECT id, name, do_not_hire, do_not_hire_reason, notes as internal_notes
         FROM organisations WHERE id = $1`,
        [band_id]
      );

      band_history = {
        jobs: bandJobs.rows,
        stats: bandStats.rows[0],
        band_info: bandOrg.rows[0] || null,
      };
    }

    res.json({
      jobs: result.rows,
      stats: statsResult.rows[0],
      client_info,
      band_history,
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
// JOB CONTACTS — per-job contact selection (job_contacts, migration 086)
// ============================================================================
// Round 6 (May 2026): writes from outside the New Enquiry form. Lets staff
// manage per-hire contacts on existing jobs (including HH-synced ones with
// zero job_contacts rows). The shape mirrors job_organisations: GET returns
// current state + candidates, PUT does idempotent replace, POST adds a
// person in one shot (search-existing or create-new + link to client org).

// GET /api/pipeline/:jobId/contacts
// Returns: { ticked: [{ person_id, name, email, is_primary, role }],
//            candidates: [{ person_id, name, email, role, source_org_name, source_org_id, is_org_primary }] }
// Candidates: all people via person_organisation_roles on client_id OR any
// org linked via job_organisations. Deduped by person_id (ticked first source wins).
router.get('/:jobId/contacts', async (req: AuthRequest, res: Response) => {
  try {
    const jobId = req.params.jobId as string;

    // Currently ticked
    const tickedResult = await query(
      `SELECT jc.person_id, jc.is_primary, jc.role_override,
              p.first_name, p.last_name, p.email, p.phone
       FROM job_contacts jc
       JOIN people p ON p.id = jc.person_id AND p.is_deleted = false
       WHERE jc.job_id = $1
       ORDER BY jc.is_primary DESC, p.first_name ASC`,
      [jobId]
    );

    // All candidate people from client org + any linked org. DISTINCT ON
    // person_id keeps the first source per person (sorted so client wins
    // over linked orgs, primary contacts surface ahead of generals).
    const candidatesResult = await query(
      `SELECT DISTINCT ON (p.id)
              p.id AS person_id,
              p.first_name, p.last_name, p.email, p.phone,
              por.role, por.is_primary AS is_org_primary,
              o.id AS source_org_id, o.name AS source_org_name,
              CASE WHEN o.id = j.client_id THEN 0 ELSE 1 END AS source_priority
       FROM jobs j
       JOIN person_organisation_roles por ON por.status = 'active'
       JOIN organisations o ON o.id = por.organisation_id AND o.is_deleted = false
       JOIN people p ON p.id = por.person_id AND p.is_deleted = false
       WHERE j.id = $1
         AND (
           o.id = j.client_id
           OR o.id IN (SELECT organisation_id FROM job_organisations WHERE job_id = j.id)
         )
       ORDER BY p.id, source_priority, por.is_primary DESC`,
      [jobId]
    );

    const ticked = tickedResult.rows.map((r: any) => ({
      person_id: r.person_id,
      name: `${r.first_name || ''} ${r.last_name || ''}`.trim(),
      email: r.email,
      phone: r.phone,
      is_primary: r.is_primary,
      role_override: r.role_override,
    }));

    const candidates = candidatesResult.rows.map((r: any) => ({
      person_id: r.person_id,
      name: `${r.first_name || ''} ${r.last_name || ''}`.trim(),
      email: r.email,
      phone: r.phone,
      role: r.role,
      is_org_primary: r.is_org_primary,
      source_org_id: r.source_org_id,
      source_org_name: r.source_org_name,
    }));

    res.json({ ticked, candidates });
  } catch (error) {
    console.error('Get job contacts error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// PUT /api/pipeline/:jobId/contacts
// Idempotent replace. Body: { person_ids: string[], primary_person_id: string | null }
// At most one primary (enforced by partial unique index; passing a primary
// not in person_ids is a 400). Empty person_ids clears all contacts on the job.
const putJobContactsSchema = z.object({
  person_ids: z.array(z.string().uuid()),
  primary_person_id: z.string().uuid().nullable().optional(),
});

router.put('/:jobId/contacts', validate(putJobContactsSchema), async (req: AuthRequest, res: Response) => {
  try {
    const jobId = req.params.jobId as string;
    const { person_ids, primary_person_id } = req.body as z.infer<typeof putJobContactsSchema>;

    if (primary_person_id && !person_ids.includes(primary_person_id)) {
      res.status(400).json({ error: 'primary_person_id must be one of person_ids' });
      return;
    }

    // Verify job exists
    const jobCheck = await query('SELECT id FROM jobs WHERE id = $1 AND is_deleted = false', [jobId]);
    if (jobCheck.rows.length === 0) {
      res.status(404).json({ error: 'Job not found' });
      return;
    }

    // Transactional replace: delete all existing, insert the new set.
    // Simpler than a diff for a small list and keeps the audit clean.
    await query('BEGIN');
    try {
      await query('DELETE FROM job_contacts WHERE job_id = $1', [jobId]);
      for (const personId of person_ids) {
        const isPrimary = personId === primary_person_id;
        await query(
          `INSERT INTO job_contacts (job_id, person_id, is_primary, created_by)
           VALUES ($1, $2, $3, $4)`,
          [jobId, personId, isPrimary, req.user!.id]
        );
      }
      await query('COMMIT');
    } catch (txErr) {
      await query('ROLLBACK');
      throw txErr;
    }

    await logAudit(req.user!.id, 'jobs', jobId, 'update', {}, {
      job_contacts_updated: true,
      contact_count: person_ids.length,
      primary_person_id: primary_person_id || null,
    });

    res.status(204).send();
  } catch (error) {
    console.error('Update job contacts error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/pipeline/:jobId/contacts/add-person
// One-shot helper: link an existing person to the client org (if not already)
// AND tick them on the job. Used by the Add-contact UI on Job Detail and by
// the picker promote checkbox. Optionally creates a new person inline.
// Body: { person_id?, first_name?, last_name?, email?, phone?, role?,
//         set_as_primary?: boolean }
// Exactly one of person_id or (first_name + last_name) must be supplied.
const addContactSchema = z.object({
  person_id: z.string().uuid().optional(),
  first_name: z.string().optional(),
  last_name: z.string().optional(),
  email: z.string().email().optional().or(z.literal('')),
  phone: z.string().optional(),
  role: z.string().optional(),
  set_as_primary: z.boolean().optional(),
});

router.post('/:jobId/contacts/add-person', validate(addContactSchema), async (req: AuthRequest, res: Response) => {
  try {
    const jobId = req.params.jobId as string;
    const { person_id, first_name, last_name, email, phone, role, set_as_primary } =
      req.body as z.infer<typeof addContactSchema>;

    if (!person_id && !(first_name && last_name)) {
      res.status(400).json({ error: 'Provide either person_id or first_name+last_name' });
      return;
    }

    const jobResult = await query(
      'SELECT id, client_id FROM jobs WHERE id = $1 AND is_deleted = false',
      [jobId]
    );
    if (jobResult.rows.length === 0) {
      res.status(404).json({ error: 'Job not found' });
      return;
    }
    const clientId = jobResult.rows[0].client_id;

    await query('BEGIN');
    try {
      let resolvedPersonId = person_id;

      // Create person if needed
      if (!resolvedPersonId) {
        const createResult = await query(
          `INSERT INTO people (first_name, last_name, email, phone, created_by)
           VALUES ($1, $2, $3, $4, $5)
           RETURNING id`,
          [first_name, last_name, email || null, phone || null, req.user!.id]
        );
        resolvedPersonId = createResult.rows[0].id;
      }

      // Link to client org via person_organisation_roles if a client org
      // exists and the link doesn't already (active row).
      if (clientId) {
        const existingLink = await query(
          `SELECT id FROM person_organisation_roles
           WHERE person_id = $1 AND organisation_id = $2 AND status = 'active'
           LIMIT 1`,
          [resolvedPersonId, clientId]
        );
        if (existingLink.rows.length === 0) {
          await query(
            `INSERT INTO person_organisation_roles
             (person_id, organisation_id, role, status, created_by)
             VALUES ($1, $2, $3, 'active', $4)`,
            [resolvedPersonId, clientId, role || 'General Contact', req.user!.id]
          );
        }
      }

      // If set_as_primary, clear any current primary on the job first
      // (the partial unique index would otherwise reject the insert).
      if (set_as_primary) {
        await query(
          `UPDATE job_contacts SET is_primary = false
           WHERE job_id = $1 AND is_primary = true`,
          [jobId]
        );
      }

      // Tick on the job
      await query(
        `INSERT INTO job_contacts (job_id, person_id, is_primary, created_by)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (job_id, person_id) DO UPDATE
           SET is_primary = EXCLUDED.is_primary OR job_contacts.is_primary`,
        [jobId, resolvedPersonId, !!set_as_primary, req.user!.id]
      );

      await query('COMMIT');
      res.status(201).json({ person_id: resolvedPersonId });
    } catch (txErr) {
      await query('ROLLBACK');
      throw txErr;
    }
  } catch (error) {
    console.error('Add job contact error:', error);
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
  out_time: z.string().optional().nullable(),
  start_time: z.string().optional().nullable(),
  return_time: z.string().optional().nullable(),
  end_time: z.string().optional().nullable(),
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

    // Sanity-check date/time ordering — merge any incoming overrides with the
    // current persisted values so a partial PATCH (e.g. just out_time) is
    // checked against everything else.
    const dateTimeKeys = ['out_date', 'job_date', 'job_end', 'return_date',
      'out_time', 'start_time', 'return_time', 'end_time'] as const;
    if (dateTimeKeys.some(k => k in fields)) {
      const merged: Record<string, Date | string | null> = {};
      for (const k of dateTimeKeys) {
        merged[k] = (k in fields) ? (fields[k] ?? null) : currentJob[k];
      }
      const dateTimeError = validateJobDateTimes(merged as Parameters<typeof validateJobDateTimes>[0]);
      if (dateTimeError) {
        res.status(400).json({ error: dateTimeError });
        return;
      }
    }

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
      'out_time', 'start_time', 'return_time', 'end_time',
      'client_id', 'client_name', 'hh_job_number', 'job_value',
      'likelihood', 'next_chase_date', 'details', 'notes',
    ];

    const changedFields: string[] = [];
    const fieldLabels: Record<string, string> = {
      job_name: 'Job name', out_date: 'Outgoing date', job_date: 'Job start',
      job_end: 'Job end', return_date: 'Return date', out_time: 'Out time',
      start_time: 'Start time', return_time: 'Return time', end_time: 'End time',
      client_name: 'Client',
      hh_job_number: 'HH job #', job_value: 'Job value', likelihood: 'Likelihood',
      next_chase_date: 'Next chase', details: 'Details', notes: 'Notes',
    };
    const dateFields = new Set(['out_date', 'job_date', 'job_end', 'return_date', 'next_chase_date']);
    const timeFields = new Set(['out_time', 'start_time', 'return_time', 'end_time']);
    const formatLogValue = (field: string, val: unknown): string => {
      if (val === null || val === undefined || val === '') return '(empty)';
      if (dateFields.has(field)) {
        try {
          const d = new Date(val as string);
          if (!isNaN(d.getTime())) return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
        } catch { /* fall through */ }
      }
      if (timeFields.has(field)) {
        const s = String(val);
        return s.length >= 5 ? s.slice(0, 5) : s;
      }
      return String(val);
    };

    for (const field of allowedFields) {
      if (field in fields) {
        const oldVal = currentJob[field];
        const newVal = fields[field];
        // Track what actually changed for the interaction log
        if (String(oldVal ?? '') !== String(newVal ?? '')) {
          changedFields.push(`${fieldLabels[field] || field}: ${formatLogValue(field, oldVal)} → ${formatLogValue(field, newVal)}`);
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

    // Push job_name to HireHop if it changed — otherwise the next 30-min HH
    // job sync will clobber the rename with HireHop's stale value.
    let hhWritebackWarning: string | undefined;
    if (
      'job_name' in fields &&
      String(currentJob.job_name ?? '') !== String(fields.job_name ?? '') &&
      result.rows[0].hh_job_number
    ) {
      const wb = await writeBackJobNameToHireHop(
        jobId,
        String(fields.job_name ?? ''),
        req.user!.email,
      );
      if (!wb.success) {
        hhWritebackWarning = `Saved locally, but HireHop sync failed: ${wb.message}. The next HireHop sync may overwrite this rename.`;
      }
    }

    res.json({ ...result.rows[0], ...(hhWritebackWarning ? { hh_writeback_warning: hhWritebackWarning } : {}) });
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
// HireHop datetime helpers (shared by push-hirehop and push-dates-to-hh)
// ============================================================================

/**
 * Merge a TIMESTAMPTZ date column with an optional separate TIME column into
 * HireHop's "YYYY-MM-DD HH:MM" format. The explicit time column wins over any
 * time portion embedded in the date column. Falls back to fallbackTime when
 * neither is set (HireHop's standard 09:00 default for date-only entries).
 */
function buildHHDateTime(
  dateValue: Date | string | null | undefined,
  timeValue: string | null | undefined,
  fallbackTime = '09:00',
): string | undefined {
  if (!dateValue) return undefined;
  const d = new Date(dateValue);
  if (isNaN(d.getTime())) return undefined;
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  let timeStr: string;
  if (timeValue) {
    timeStr = String(timeValue).slice(0, 5); // PG TIME → 'HH:MM:SS', take HH:MM
  } else {
    const hh = d.getUTCHours();
    const min = d.getUTCMinutes();
    timeStr = (hh === 0 && min === 0)
      ? fallbackTime
      : `${String(hh).padStart(2, '0')}:${String(min).padStart(2, '0')}`;
  }
  return `${yyyy}-${mm}-${dd} ${timeStr}`;
}

/**
 * Calculate HireHop duration_days, duration_hrs, duration_locked from start
 * and end datetimes (in HH "YYYY-MM-DD HH:MM" format, UTC).
 *
 * HireHop stores duration_hrs as TOTAL hours of the hire (e.g. 4-day job →
 * days=4, hrs=96), NOT the remainder after days. Sending hrs=0 alongside
 * days=N makes the HH UI display "N days (1 hours)" — confirmed via job
 * 15833 (4 days/96 hrs) and 15335 (6 days/144 hrs).
 *
 * duration_locked=0 keeps HH auto-recalculating duration on subsequent date
 * edits.
 */
function calcHHDuration(
  startDateTime: string | undefined,
  endDateTime: string | undefined,
): { duration_days: number; duration_hrs: number; duration_locked: 0 } | null {
  if (!startDateTime || !endDateTime) return null;
  const startMs = Date.parse(startDateTime.replace(' ', 'T') + ':00Z');
  const endMs = Date.parse(endDateTime.replace(' ', 'T') + ':00Z');
  if (isNaN(startMs) || isNaN(endMs)) return null;
  const totalHours = Math.max(0, (endMs - startMs) / (1000 * 60 * 60));
  return {
    duration_days: Math.floor(totalHours / 24),
    duration_hrs: Math.round(totalHours),
    duration_locked: 0,
  };
}

/**
 * Validate that OP date+time values respect the natural ordering:
 *   out_datetime ≤ start_datetime ≤ end_datetime ≤ return_datetime
 *
 * Without this, OP can push invalid combos to HireHop (e.g. Out 15:00 on
 * day X, Start 09:00 on day X) which HH stores but its pricing engine
 * gets confused by — visible side-effects include unstable charge-period
 * displays and HH webhook responses bouncing the bad value back to OP,
 * overwriting subsequent OP edits.
 *
 * Returns null on success; a human-readable error string on failure.
 * Missing fields are skipped (we only validate pairs where both sides
 * have values).
 */
function validateJobDateTimes(job: {
  out_date: Date | string | null;
  job_date: Date | string | null;
  job_end: Date | string | null;
  return_date: Date | string | null;
  out_time: string | null;
  start_time: string | null;
  return_time: string | null;
  end_time: string | null;
}): string | null {
  const out = buildHHDateTime(job.out_date, job.out_time);
  const start = buildHHDateTime(job.job_date, job.start_time || job.out_time);
  const end = buildHHDateTime(job.job_end, job.end_time);
  const to = buildHHDateTime(job.return_date, job.return_time);
  const ms = (s?: string) => (s ? Date.parse(s.replace(' ', 'T') + ':00Z') : NaN);
  const oMs = ms(out), sMs = ms(start), eMs = ms(end), tMs = ms(to);
  // Out > Start is allowed on the same calendar day (e.g. charge starts 09:00,
  // client collects at 15:00 — Outgoing here is the physical handover time).
  // Cross-day Out-after-Start stays blocked: the inbound HH sync would clobber
  // out_date back to job_date on the next pull (HH only sees the clamped value
  // — see buildHHJobDateTimes — so OP's intended later date is unrecoverable).
  const sameDay = out && start && out.slice(0, 10) === start.slice(0, 10);
  if (!isNaN(oMs) && !isNaN(sMs) && oMs > sMs && !sameDay) {
    return 'Outgoing date must be on or before Job Start date.';
  }
  if (!isNaN(sMs) && !isNaN(eMs) && sMs > eMs) {
    return 'Job Start date/time must be on or before Job End date/time.';
  }
  if (!isNaN(eMs) && !isNaN(tMs) && eMs > tMs) {
    return 'Job End date/time must be on or before Returning date/time.';
  }
  return null;
}

/**
 * Build the four HireHop datetime fields (out / start / end / to) plus the
 * duration block from a job row that has the four date columns and the four
 * time columns (out_time / start_time / return_time / end_time).
 *
 * Time mapping (one OP time → one HH time, no implicit linking on the server
 * side — the UI handles linked-by-default with manual unlink):
 *   - HH out   = out_date    + out_time
 *   - HH start = job_date    + start_time (falls back to out_time if null,
 *                                          for legacy rows pre-migration 066)
 *   - HH end   = job_end     + end_time   (falls back to 09:00 if null)
 *   - HH to    = return_date + return_time
 *
 * Clamping rule: when OP's Out is later than Start (allowed only on the same
 * calendar day — see validateJobDateTimes), HH receives `out = start`. HH's
 * data model rejects out > start, and HH's chargeable period is start→end
 * regardless, so clamping the time portion only is lossless from HH's point of
 * view. OP retains the user's real Outgoing time in `out_time` for Dashboard
 * widgets, prep schedules, etc.
 */
function buildHHJobDateTimes(job: {
  out_date: Date | string | null;
  job_date: Date | string | null;
  job_end: Date | string | null;
  return_date: Date | string | null;
  out_time: string | null;
  start_time: string | null;
  return_time: string | null;
  end_time: string | null;
}): {
  out?: string;
  start?: string;
  end?: string;
  to?: string;
  duration?: { duration_days: number; duration_hrs: number; duration_locked: 0 };
} {
  let out = buildHHDateTime(job.out_date, job.out_time);
  const start = buildHHDateTime(job.job_date, job.start_time || job.out_time);
  const end = buildHHDateTime(job.job_end, job.end_time);
  const to = buildHHDateTime(job.return_date, job.return_time);
  if (out && start) {
    const oMs = Date.parse(out.replace(' ', 'T') + ':00Z');
    const sMs = Date.parse(start.replace(' ', 'T') + ':00Z');
    if (!isNaN(oMs) && !isNaN(sMs) && oMs > sMs) {
      out = start;
    }
  }
  const duration = calcHHDuration(start, end) ?? undefined;
  return { out, start, end, to, duration };
}

// ============================================================================
// PUSH DATES TO HIREHOP — Sync OP dates to HireHop after editing in OP
// ============================================================================

router.post('/:id/push-dates-to-hh', async (req: AuthRequest, res: Response) => {
  try {
    const jobId = req.params.id as string;

    const jobResult = await query(
      `SELECT id, hh_job_number, out_date, job_date, job_end, return_date,
              out_time, start_time, return_time, end_time
         FROM jobs WHERE id = $1 AND is_deleted = false`,
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

    const dateTimeError = validateJobDateTimes(job);
    if (dateTimeError) {
      res.status(400).json({ error: dateTimeError });
      return;
    }

    const { out, start, end, to, duration } = buildHHJobDateTimes(job);

    const dateParams: Record<string, unknown> = {
      job: job.hh_job_number,
      no_webhook: 1,
    };
    if (out) dateParams.out = out;
    if (start) dateParams.start = start;
    if (end) dateParams.end = end;
    if (to) dateParams.to = to;
    if (duration) {
      dateParams.duration_days = duration.duration_days;
      dateParams.duration_hrs = duration.duration_hrs;
      dateParams.duration_locked = duration.duration_locked;
    }

    await hhBroker.post('/api/save_job.php', dateParams, { priority: 'high' });

    console.log(`[Pipeline] Pushed dates to HH job ${job.hh_job_number}:`, {
      out, start, end, to,
      duration_days: duration?.duration_days, duration_hrs: duration?.duration_hrs,
    });

    res.json({ success: true, hh_job_number: job.hh_job_number });
  } catch (error) {
    console.error('Push dates to HH error:', error);
    res.status(500).json({ error: 'Failed to update dates on HireHop' });
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

    const dateTimeError = validateJobDateTimes(job);
    if (dateTimeError) {
      res.status(400).json({ error: dateTimeError });
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

    // Fetch organisation details early so we can include contact info in job creation
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

    // Primary per-job contact (job_contacts, migration 086). When set, this
    // person becomes the HH contact NAME/EMAIL/TELEPHONE; the org name stays
    // as COMPANY. Falls through to org name in both NAME and COMPANY (today's
    // behaviour) when no primary is ticked.
    let primaryContact: { name: string; email: string | null; phone: string | null } | null = null;
    {
      const pcResult = await query(
        `SELECT p.first_name, p.last_name, p.email, p.phone
         FROM job_contacts jc
         JOIN people p ON p.id = jc.person_id
         WHERE jc.job_id = $1
           AND jc.is_primary = true
           AND p.is_deleted = false
         LIMIT 1`,
        [jobId]
      );
      if (pcResult.rows.length > 0) {
        const r = pcResult.rows[0];
        const fullName = `${r.first_name || ''} ${r.last_name || ''}`.trim();
        if (fullName) {
          primaryContact = {
            name: fullName,
            email: r.email || null,
            phone: r.phone || null,
          };
        }
      }
    }

    // Build HireHop job payload
    // HH API: `name` is required for new jobs, `job_name` is the job title
    const hhBody: Record<string, unknown> = {
      job: 0, // 0 = create new
      // Prefer per-job primary contact's name, then job's client_name (free text),
      // then job_name as last resort.
      name: primaryContact?.name || job.client_name || job.job_name || 'New Job',
      job_name: job.job_name || '',
      no_webhook: 1,
    };

    // Set manager to the OP user's HH account (avoids "API ONLY" as manager)
    if (hhUserId) hhBody.user = hhUserId;

    if (hhClientId) hhBody.client_id = hhClientId;
    if (job.company_name) hhBody.company = job.company_name;
    if (venueName) hhBody.venue = venueName;

    // Include contact fields in job creation — save_job.php may populate the auto-created contact
    // Primary per-job contact's email/phone wins over the org's when set.
    const initialEmail = primaryContact?.email || orgDetails?.email;
    const initialPhone = primaryContact?.phone || orgDetails?.phone;
    if (initialEmail) hhBody.email = initialEmail;
    if (initialPhone) hhBody.telephone = initialPhone;

    const { out, start, end, to, duration } = buildHHJobDateTimes(job);

    // If job_end is set but no separate out/return dates, default them
    const effectiveOut = out || start;
    const effectiveReturn = to || end;

    // HireHop job_save.php date fields (per API docs):
    // out = equipment reserved from (compulsory), start = charging from (compulsory),
    // end = job ends, to = equipment available again
    if (effectiveOut) hhBody.out = effectiveOut;
    if (start) hhBody.start = start;
    if (end) hhBody.end = end;
    if (effectiveReturn) hhBody.to = effectiveReturn;

    if (duration) {
      hhBody.duration_days = duration.duration_days;
      hhBody.duration_hrs = duration.duration_hrs;
      hhBody.duration_locked = duration.duration_locked;
    }

    console.log('[Pipeline] Creating job in HireHop:', {
      out: hhBody.out, start: hhBody.start, end: hhBody.end, to: hhBody.to,
      duration_days: hhBody.duration_days, duration_hrs: hhBody.duration_hrs,
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

    // Extract the HH client_id that save_job.php auto-creates — needed to update (not duplicate) the contact
    const hhAutoClientId = (data.client_id ?? data.CLIENT_ID ?? data.clientId) as number | undefined;
    if (hhAutoClientId) {
      console.log(`[Pipeline] save_job.php returned client_id=${hhAutoClientId}`);
      if (!hhClientId) hhClientId = Number(hhAutoClientId);
    }
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

    // ── Push client contact details (email, phone, address) to HireHop ──
    const syncedFields: string[] = ['name'];
    let contactSyncNote = '';
    try {
      if (orgDetails && (orgDetails.email || orgDetails.phone || orgDetails.address)) {
        // If save_job didn't return a client_id, read the HH job to get it
        if (!hhClientId) {
          console.log(`[Pipeline] No hhClientId from save_job response — reading HH job #${hhJobNumber} to get client_id`);
          const jobDataResp = await hhBroker.get<Record<string, unknown>>(
            '/api/job_data.php',
            { job: Number(hhJobNumber) },
            { priority: 'high', cacheTTL: 0 }
          );
          if (jobDataResp.success && jobDataResp.data) {
            const jd = jobDataResp.data;
            const fetchedClientId = jd.CLIENT_ID ?? jd.client_id ?? jd.clientId;
            if (fetchedClientId && Number(fetchedClientId) > 0) {
              hhClientId = Number(fetchedClientId);
              console.log(`[Pipeline] Got hhClientId=${hhClientId} from job_data.php`);
            }
          }
        }

        // When a primary per-job contact (job_contacts, migration 086) is set,
        // NAME is the person, COMPANY is the org. Otherwise both fall back to
        // the org name (today's behaviour — no regression).
        const orgName = orgDetails.name || job.client_name || job.company_name || '';
        const nameForHh = primaryContact?.name || orgName;
        const companyForHh = orgName || primaryContact?.name || '';
        const contactPayload: Record<string, unknown> = {
          JOB_ID: hhJobNumber,
          NAME: nameForHh,
          COMPANY: companyForHh,
          CLIENT: 1,
          no_webhook: 1,
        };
        if (primaryContact) {
          syncedFields.push('primary contact');
        }

        // CLIENT_ID is critical — without it, HH creates a new unlinked contact instead of updating
        if (hhClientId) {
          contactPayload.CLIENT_ID = hhClientId;
          console.log(`[Pipeline] Updating existing HH contact ${hhClientId} with email/phone`);
        } else {
          console.warn(`[Pipeline] No hhClientId available — job_save_contact may create a duplicate contact`);
        }

        const addressParts = [orgDetails.address, orgDetails.location].filter(Boolean);
        if (addressParts.length > 0) {
          contactPayload.ADDRESS = addressParts.join(', ');
          syncedFields.push('address');
        }
        // Primary contact's email/phone takes precedence over the org's when set.
        const emailForHh = primaryContact?.email || orgDetails.email;
        const phoneForHh = primaryContact?.phone || orgDetails.phone;
        if (emailForHh) {
          contactPayload.EMAIL = emailForHh;
          syncedFields.push('email');
        }
        if (phoneForHh) {
          contactPayload.TELEPHONE = phoneForHh;
          syncedFields.push('phone');
        }

        console.log(`[Pipeline] Sending contact payload to HH:`, JSON.stringify(contactPayload));

        const contactResponse = await hhBroker.post(
          '/php_functions/job_save_contact.php',
          contactPayload,
          { priority: 'high' }
        );

        console.log(`[Pipeline] job_save_contact response:`, JSON.stringify(contactResponse.data));

        if (contactResponse.success) {
          // Store HH contact ID mapping
          const returnedHhClientId = (contactResponse.data as any)?.id || (contactResponse.data as any)?.ID || (contactResponse.data as any)?.CLIENT_ID;
          if (returnedHhClientId && job.client_id) {
            await query(
              `INSERT INTO external_id_map (entity_type, entity_id, external_system, external_id)
               VALUES ('organisation', $1, 'hirehop', $2)
               ON CONFLICT (entity_type, entity_id, external_system) DO UPDATE SET external_id = $2, synced_at = NOW()`,
              [job.client_id, String(returnedHhClientId)]
            );
          }
          contactSyncNote = ` (contact details: ${syncedFields.join(', ')})`;
          console.log(`[Pipeline] Client contact synced to HH job #${hhJobNumber}:`, syncedFields.join(', '));
        } else {
          console.warn(`[Pipeline] Client contact sync failed for HH job #${hhJobNumber}:`, contactResponse.error);
          console.warn(`[Pipeline] Contact response data:`, JSON.stringify(contactResponse));
        }
      }
    } catch (contactErr) {
      console.warn('[Pipeline] Non-critical: client contact sync failed:', contactErr);
    }

    // ── Push band name as client_ref (Client Reference) in HireHop ──
    let bandName: string | null = null;
    try {
      const bandResult = await query(
        `SELECT o.name FROM job_organisations jo
         JOIN organisations o ON o.id = jo.organisation_id
         WHERE jo.job_id = $1 AND jo.role = 'band'
         LIMIT 1`,
        [jobId]
      );
      if (bandResult.rows.length > 0) {
        bandName = bandResult.rows[0].name;
      }

      if (bandName) {
        await hhBroker.post(
          '/api/save_job.php',
          { job: hhJobNumber, client_ref: bandName, no_webhook: 1 },
          { priority: 'high' }
        );
        syncedFields.push('band→client_ref');
        contactSyncNote = ` (contact details: ${syncedFields.join(', ')})`;
        console.log(`[Pipeline] Band name "${bandName}" set as client_ref on HH job #${hhJobNumber}`);
      }
    } catch (refErr) {
      console.warn('[Pipeline] Non-critical: client_ref push failed:', refErr);
    }

    // Log as interaction
    await query(
      `INSERT INTO interactions (type, content, job_id, created_by, pipeline_status_at_creation)
       VALUES ('note', $1, $2, $3, $4)`,
      [`Created HireHop job #${hhJobNumber}${contactSyncNote}`, jobId, req.user!.id, job.pipeline_status]
    );

    await logAudit(req.user!.id, 'jobs', jobId, 'update', job, { ...job, hh_job_number: hhJobNumber });

    res.json({ hh_job_number: hhJobNumber, synced_fields: syncedFields });
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

    // Primary per-job contact (job_contacts, migration 086). When set, NAME +
    // EMAIL + TELEPHONE come from the person; COMPANY stays as the org name.
    let primaryContact: { name: string; email: string | null; phone: string | null } | null = null;
    {
      const pcResult = await query(
        `SELECT p.first_name, p.last_name, p.email, p.phone
         FROM job_contacts jc
         JOIN people p ON p.id = jc.person_id
         WHERE jc.job_id = $1
           AND jc.is_primary = true
           AND p.is_deleted = false
         LIMIT 1`,
        [jobId]
      );
      if (pcResult.rows.length > 0) {
        const r = pcResult.rows[0];
        const fullName = `${r.first_name || ''} ${r.last_name || ''}`.trim();
        if (fullName) {
          primaryContact = {
            name: fullName,
            email: r.email || null,
            phone: r.phone || null,
          };
        }
      }
    }

    const { hhBroker } = await import('../services/hirehop-broker');

    // Step 1: Create/update contact in HireHop address book via job_save_contact.php
    const orgName = orgDetails?.name || job.client_name || job.company_name || '';
    const nameForHh = primaryContact?.name || orgName;
    const companyForHh = orgName || primaryContact?.name || '';
    const contactPayload: Record<string, unknown> = {
      JOB_ID: job.hh_job_number,
      NAME: nameForHh,
      COMPANY: companyForHh,
      CLIENT: 1,
      no_webhook: 1,
    };

    // Include existing HH client ID to update rather than create a duplicate
    if (hhClientId) {
      contactPayload.CLIENT_ID = hhClientId;
    }

    // Add address, email, phone — primary contact's email/phone wins when set.
    if (orgDetails) {
      // Build full address from address + location fields
      const addressParts = [orgDetails.address, orgDetails.location].filter(Boolean);
      if (addressParts.length > 0) {
        contactPayload.ADDRESS = addressParts.join(', ');
      }
    }
    const emailForHh = primaryContact?.email || orgDetails?.email;
    const phoneForHh = primaryContact?.phone || orgDetails?.phone;
    if (emailForHh) {
      contactPayload.EMAIL = emailForHh;
    }
    if (phoneForHh) {
      contactPayload.TELEPHONE = phoneForHh;
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
    if (primaryContact) syncedFields.push('primary contact');
    if (emailForHh) syncedFields.push('email');
    if (phoneForHh) syncedFields.push('phone');
    if (orgDetails?.address || orgDetails?.location) syncedFields.push('address');

    console.log('[Pipeline] Client synced to HireHop job #' + job.hh_job_number + ':', nameForHh, '(fields:', syncedFields.join(', ') + ')');

    // Log as interaction on the job
    await query(
      `INSERT INTO interactions (type, content, job_id, created_by, pipeline_status_at_creation)
       VALUES ('note', $1, $2, $3, $4)`,
      [
        `Synced client "${nameForHh}" to HireHop job #${job.hh_job_number} (contact details: ${syncedFields.join(', ')})`,
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
