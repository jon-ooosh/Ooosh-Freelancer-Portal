import { Router, Response } from 'express';
import { z } from 'zod';
import { query } from '../config/database';
import { authenticate, authorize, AuthRequest, STAFF_ROLES } from '../middleware/auth';
import { validate } from '../middleware/validate';
import { hhBroker } from '../services/hirehop-broker';
import { writeBackStatusToHireHop } from '../services/hirehop-writeback';

const router = Router();
router.use(authenticate);
router.use(authorize(...STAFF_ROLES));

// ── Valid statuses (non-linear — any to any) ─────────────────────────────

const VALID_STATUSES = ['not_started', 'in_progress', 'done', 'blocked'] as const;

// ── List requirements for a job ──────────────────────────────────────────

router.get('/job/:jobId', async (req: AuthRequest, res: Response) => {
  try {
    const { jobId } = req.params;
    const phase = req.query.phase as string | undefined;
    const phaseFilter = phase && ['pre_hire', 'post_hire'].includes(phase)
      ? `AND jr.phase = '${phase}'`
      : '';
    const result = await query(
      `SELECT jr.*,
              rtd.label AS type_label,
              rtd.icon AS type_icon,
              rtd.steps AS type_steps,
              p.first_name || ' ' || p.last_name AS assigned_to_name
       FROM job_requirements jr
       JOIN requirement_type_definitions rtd ON rtd.type = jr.requirement_type
       LEFT JOIN users u ON u.id = jr.assigned_to
       LEFT JOIN people p ON p.id = u.person_id
       WHERE jr.job_id = $1 ${phaseFilter}
       ORDER BY jr.sort_order, rtd.sort_order, jr.created_at`,
      [jobId]
    );
    res.json({ data: result.rows });
  } catch (err) {
    console.error('Error fetching job requirements:', err);
    res.status(500).json({ error: 'Failed to fetch requirements' });
  }
});

// ── Bulk fetch requirements for multiple jobs (for Jobs list progress) ───

router.post('/bulk', async (req: AuthRequest, res: Response) => {
  try {
    const { job_ids, phase } = req.body;
    if (!Array.isArray(job_ids) || job_ids.length === 0) {
      return res.json({ data: {} });
    }
    // Limit to 500 job IDs
    const ids = job_ids.slice(0, 500);
    // Optional phase filter: 'pre_hire' for the Jobs/Going Out/Out Now view
    // (don't sum post-hire close-out into the prep progress bar), 'post_hire'
    // for the Returns view. Omitted = both, the original behaviour.
    const phaseFilter = phase === 'pre_hire' || phase === 'post_hire'
      ? `AND jr.phase = '${phase}'`
      : '';
    const result = await query(
      `SELECT jr.job_id, jr.status, jr.requirement_type
       FROM job_requirements jr
       WHERE jr.job_id = ANY($1) ${phaseFilter}`,
      [ids]
    );
    // Group by job_id for easy lookup
    const grouped: Record<string, { total: number; done: number; blocked: number }> = {};
    for (const row of result.rows) {
      if (!grouped[row.job_id]) {
        grouped[row.job_id] = { total: 0, done: 0, blocked: 0 };
      }
      grouped[row.job_id].total++;
      if (row.status === 'done') grouped[row.job_id].done++;
      if (row.status === 'blocked') grouped[row.job_id].blocked++;
    }
    res.json({ data: grouped });
  } catch (err) {
    console.error('Error fetching bulk requirements:', err);
    res.status(500).json({ error: 'Failed to fetch requirements' });
  }
});

// ── Bulk close-out progress (for Returns page) ─────────────────────────

router.post('/closeout-progress', async (req: AuthRequest, res: Response) => {
  try {
    const { job_ids } = req.body;
    if (!Array.isArray(job_ids) || job_ids.length === 0) {
      return res.json({ data: {} });
    }
    const ids = job_ids.slice(0, 500);

    // Fetch all post_hire requirements for these jobs
    const result = await query(
      `SELECT jr.id, jr.job_id, jr.requirement_type, jr.status, jr.custom_label,
              rtd.label AS type_label, rtd.icon AS type_icon
       FROM job_requirements jr
       JOIN requirement_type_definitions rtd ON rtd.type = jr.requirement_type
       WHERE jr.job_id = ANY($1) AND jr.phase = 'post_hire'
       ORDER BY rtd.sort_order`,
      [ids]
    );

    // ── HH billing auto-detection (invoice + payment reconciliation) ──
    // Find jobs with invoice/payment_reconcile still at not_started and check HH billing
    const jobsNeedingBillingCheck = new Set<string>();
    const reqMap: Record<string, { id: string; type: string }[]> = {};
    for (const row of result.rows) {
      if ((row.requirement_type === 'invoice' || row.requirement_type === 'payment_reconcile')
          && row.status === 'not_started') {
        jobsNeedingBillingCheck.add(row.job_id);
        if (!reqMap[row.job_id]) reqMap[row.job_id] = [];
        reqMap[row.job_id].push({ id: row.id, type: row.requirement_type });
      }
    }

    // Look up HH job numbers for these jobs (limit to 10 to avoid rate limiting)
    if (jobsNeedingBillingCheck.size > 0) {
      const checkIds = Array.from(jobsNeedingBillingCheck).slice(0, 10);
      const hhNumbers = await query(
        `SELECT id, hh_job_number FROM jobs WHERE id = ANY($1) AND hh_job_number IS NOT NULL`,
        [checkIds]
      );

      for (const job of hhNumbers.rows) {
        try {
          const billingRes = await hhBroker.get('/php_functions/billing_list.php',
            { main_id: job.hh_job_number, type: 1 },
            { priority: 'low', cacheTTL: 300 }
          );

          if (billingRes.success && billingRes.data) {
            const bl = billingRes.data as Record<string, any>;
            if (bl.rows && Array.isArray(bl.rows)) {
              let hasInvoice = false;
              let allInvoicesPaid = true;
              let hasAnyBillingRow = false;
              let totalOwed = 0;

              for (const row of bl.rows) {
                const kind = parseInt(row.kind ?? '0');
                const data = row.data || row;

                if (kind === 1) {
                  // Invoice row
                  const invoiceStatus = parseInt(data.STATUS || data.status || '0');
                  const isProforma = invoiceStatus === 0;
                  const invoiceDesc = String(data.DESCRIPTION || row.desc || '');
                  if (!isProforma && !invoiceDesc.toLowerCase().includes('proforma')) {
                    hasInvoice = true;
                    hasAnyBillingRow = true;
                    const owing = parseFloat(data.OWING || data.owing || row.owing || '0');
                    if (owing > 0.01) {
                      allInvoicesPaid = false;
                      totalOwed += owing;
                    }
                  }
                } else if (kind === 0) {
                  hasAnyBillingRow = true;
                }
              }

              const reqs = reqMap[job.id] || [];
              for (const req of reqs) {
                if (req.type === 'invoice' && hasInvoice) {
                  await query(
                    `UPDATE job_requirements SET status = 'in_progress', updated_at = NOW()
                     WHERE id = $1 AND status = 'not_started'`,
                    [req.id]
                  );
                  const row = result.rows.find(r => r.id === req.id);
                  if (row) row.status = 'in_progress';
                }
                if (req.type === 'payment_reconcile' && hasInvoice && allInvoicesPaid) {
                  // All invoices have £0 owed — payment is reconciled
                  await query(
                    `UPDATE job_requirements SET status = 'done', updated_at = NOW()
                     WHERE id = $1 AND status = 'not_started'`,
                    [req.id]
                  );
                  const row = result.rows.find(r => r.id === req.id);
                  if (row) row.status = 'done';
                }
              }
            }
          }
        } catch (hhErr) {
          // Don't fail the whole request if HH billing check fails for one job
          console.warn(`[Closeout] HH billing check failed for job ${job.id}:`, hhErr);
        }
      }
    }

    // Group by job_id: { jobId: { items: [...], summary: { total, done, blocked } } }
    const grouped: Record<string, {
      items: Array<{ type: string; label: string; icon: string; status: string; custom_label: string | null }>;
      total: number;
      done: number;
      blocked: number;
      in_progress: number;
    }> = {};

    for (const row of result.rows) {
      if (!grouped[row.job_id]) {
        grouped[row.job_id] = { items: [], total: 0, done: 0, blocked: 0, in_progress: 0 };
      }
      grouped[row.job_id].items.push({
        type: row.requirement_type,
        label: row.type_label,
        icon: row.type_icon,
        status: row.status,
        custom_label: row.custom_label,
      });
      grouped[row.job_id].total++;
      if (row.status === 'done') grouped[row.job_id].done++;
      if (row.status === 'blocked') grouped[row.job_id].blocked++;
      if (row.status === 'in_progress') grouped[row.job_id].in_progress++;
    }
    res.json({ data: grouped });
  } catch (err) {
    console.error('Error fetching closeout progress:', err);
    res.status(500).json({ error: 'Failed to fetch closeout progress' });
  }
});

// ── Add a requirement to a job ───────────────────────────────────────────

const addRequirementSchema = z.object({
  requirement_type: z.string().min(1),
  custom_label: z.string().optional().nullable(),
  notes: z.string().optional().nullable(),
  assigned_to: z.string().uuid().optional().nullable(),
  due_date: z.string().optional().nullable(),
  status: z.enum(VALID_STATUSES).optional().nullable(),
  current_step: z.string().optional().nullable(),
  source: z.string().optional().nullable(),
  source_id: z.string().uuid().optional().nullable(),
  phase: z.enum(['pre_hire', 'post_hire']).optional().nullable(),
  event_trigger: z.enum(['confirmed', 'cancelled', 'lost']).optional().nullable(),
  delivery_method: z.enum(['notification', 'email', 'both']).optional().nullable(),
});

router.post('/job/:jobId', validate(addRequirementSchema), async (req: AuthRequest, res: Response) => {
  try {
    const { jobId } = req.params;
    const { requirement_type, custom_label, notes, assigned_to, due_date, status, current_step, source, source_id, phase, event_trigger, delivery_method } = req.body;

    // Verify the requirement type exists
    const typeCheck = await query('SELECT type, steps FROM requirement_type_definitions WHERE type = $1', [requirement_type]);
    if (typeCheck.rows.length === 0) {
      return res.status(400).json({ error: `Unknown requirement type: ${requirement_type}` });
    }

    // For non-custom types, check uniqueness within the same phase
    const reqPhase = phase || 'pre_hire';
    if (requirement_type !== 'custom' && requirement_type !== 'reminder') {
      const existing = await query(
        'SELECT id FROM job_requirements WHERE job_id = $1 AND requirement_type = $2 AND phase = $3',
        [jobId, requirement_type, reqPhase]
      );
      if (existing.rows.length > 0) {
        return res.status(409).json({ error: `Requirement type '${requirement_type}' already exists for this job (${reqPhase})` });
      }
    }

    // For multi-step types, set initial step if not provided
    const typeDef = typeCheck.rows[0];
    let initialStep = current_step;
    if (typeDef.steps && !initialStep) {
      const steps = typeDef.steps as string[];
      initialStep = steps[0];
    }

    // Get max sort_order for this job
    const maxOrder = await query(
      'SELECT COALESCE(MAX(sort_order), 0) + 10 AS next_order FROM job_requirements WHERE job_id = $1',
      [jobId]
    );

    const result = await query(
      `INSERT INTO job_requirements (job_id, requirement_type, custom_label, notes, assigned_to, due_date, status, current_step, source, source_id, sort_order, created_by, phase, event_trigger, delivery_method)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
       RETURNING *`,
      [jobId, requirement_type, custom_label || null, notes || null, assigned_to || null, due_date || null,
       status || 'not_started', initialStep || null, source || 'manual', source_id || null,
       maxOrder.rows[0].next_order, req.user!.id, reqPhase, event_trigger || null, delivery_method || 'both']
    );

    res.status(201).json({ data: result.rows[0] });
  } catch (err) {
    console.error('Error adding requirement:', err);
    res.status(500).json({ error: 'Failed to add requirement' });
  }
});

// ── Apply a template to a job ────────────────────────────────────────────

router.post('/job/:jobId/template/:templateId', async (req: AuthRequest, res: Response) => {
  try {
    const { jobId, templateId } = req.params;

    const template = await query('SELECT * FROM requirement_templates WHERE id = $1 AND is_active = true', [templateId]);
    if (template.rows.length === 0) {
      return res.status(404).json({ error: 'Template not found' });
    }

    const types = template.rows[0].requirement_types as string[];
    const added: string[] = [];
    const skipped: string[] = [];

    for (const reqType of types) {
      // Check if already exists
      const existing = await query(
        'SELECT id FROM job_requirements WHERE job_id = $1 AND requirement_type = $2',
        [jobId, reqType]
      );
      if (existing.rows.length > 0) {
        skipped.push(reqType);
        continue;
      }

      // Get type definition for initial step
      const typeDef = await query('SELECT steps FROM requirement_type_definitions WHERE type = $1', [reqType]);
      const steps = typeDef.rows[0]?.steps as string[] | null;
      const initialStep = steps ? steps[0] : null;

      const maxOrder = await query(
        'SELECT COALESCE(MAX(sort_order), 0) + 10 AS next_order FROM job_requirements WHERE job_id = $1',
        [jobId]
      );

      await query(
        `INSERT INTO job_requirements (job_id, requirement_type, status, current_step, source, sort_order, created_by)
         VALUES ($1, $2, 'not_started', $3, 'template', $4, $5)`,
        [jobId, reqType, initialStep, maxOrder.rows[0].next_order, req.user!.id]
      );
      added.push(reqType);
    }

    res.json({ data: { added, skipped, template_name: template.rows[0].name } });
  } catch (err) {
    console.error('Error applying template:', err);
    res.status(500).json({ error: 'Failed to apply template' });
  }
});

// ── Update a requirement (status, step, notes, assigned_to, etc.) ────────

const updateRequirementSchema = z.object({
  status: z.enum(VALID_STATUSES).optional(),
  current_step: z.string().nullable().optional(),
  notes: z.string().nullable().optional(),
  assigned_to: z.string().uuid().nullable().optional(),
  due_date: z.string().nullable().optional(),
  custom_label: z.string().nullable().optional(),
  sort_order: z.number().optional(),
});

router.patch('/:id', validate(updateRequirementSchema), async (req: AuthRequest, res: Response) => {
  try {
    const { id } = req.params;
    const updates = req.body;

    // Build dynamic update
    const setClauses: string[] = ['updated_at = NOW()'];
    const values: unknown[] = [];
    let paramIdx = 1;

    for (const [key, value] of Object.entries(updates)) {
      if (value !== undefined) {
        setClauses.push(`${key} = $${paramIdx}`);
        values.push(value);
        paramIdx++;
      }
    }

    values.push(id);
    const result = await query(
      `UPDATE job_requirements SET ${setClauses.join(', ')} WHERE id = $${paramIdx} RETURNING *`,
      values
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Requirement not found' });
    }

    const updated = result.rows[0];

    // ── Close-out cascades: when one requirement is resolved, auto-resolve related ones ──
    if (updated.phase === 'post_hire' && updates.status === 'done') {
      // Invoice sent → also resolve client follow-up (sending the invoice IS the follow-up)
      if (updated.requirement_type === 'invoice') {
        await query(
          `UPDATE job_requirements SET status = 'done', updated_at = NOW()
           WHERE job_id = $1 AND requirement_type = 'client_followup' AND phase = 'post_hire'
             AND status IN ('not_started', 'in_progress')`,
          [updated.job_id]
        );
      }
    }

    // ── Auto-transition confirmed → prepping ────────────────────────────────
    // When a physical prep requirement (vehicle/backline/rehearsal) moves to "Working On It"
    // and the job is still marked Confirmed, bump the job into Prepping. This mirrors the
    // reality that staff have started work on the job. One-way — never auto-reverts.
    // Crew/transport/hire_forms/excess/etc. don't count — they're people/paperwork, not prep.
    const PREP_TRIGGER_TYPES = ['vehicle', 'backline', 'rehearsal'];
    if (
      updated.phase === 'pre_hire'
      && updates.status === 'in_progress'
      && PREP_TRIGGER_TYPES.includes(updated.requirement_type)
    ) {
      const jobRes = await query(
        `SELECT id, pipeline_status, hh_job_number FROM jobs WHERE id = $1 AND is_deleted = false`,
        [updated.job_id]
      );
      if (jobRes.rows.length > 0 && jobRes.rows[0].pipeline_status === 'confirmed') {
        await query(
          `UPDATE jobs
             SET pipeline_status = 'prepping',
                 pipeline_status_changed_at = NOW(),
                 updated_at = NOW()
           WHERE id = $1`,
          [updated.job_id]
        );
        await query(
          `INSERT INTO interactions (type, content, job_id, created_by, pipeline_status_at_creation)
           VALUES ('status_transition', $1, $2, $3, 'confirmed')`,
          [
            `Status changed: Confirmed → Prepping (auto — ${updated.requirement_type} marked Working On It)`,
            updated.job_id,
            req.user!.id,
          ]
        );
        // Push to HireHop (fire-and-forget — don't block the response)
        writeBackStatusToHireHop(updated.job_id, 'prepping', req.user!.email || req.user!.id)
          .catch((err) => console.error('[auto-transition] HH write-back failed:', err));
      }
    }

    res.json({ data: updated });
  } catch (err) {
    console.error('Error updating requirement:', err);
    res.status(500).json({ error: 'Failed to update requirement' });
  }
});

// ── Delete a requirement ─────────────────────────────────────────────────

router.delete('/:id', async (req: AuthRequest, res: Response) => {
  try {
    const { id } = req.params;
    const reason = (req.query.reason as string) || null;

    // Fetch the requirement before deleting (for audit trail)
    const existing = await query(
      `SELECT jr.*, rtd.label AS type_label
       FROM job_requirements jr
       JOIN requirement_type_definitions rtd ON rtd.type = jr.requirement_type
       WHERE jr.id = $1`,
      [id]
    );
    if (existing.rows.length === 0) {
      return res.status(404).json({ error: 'Requirement not found' });
    }
    const reqData = existing.rows[0];

    // Delete the requirement
    await query('DELETE FROM job_requirements WHERE id = $1', [id]);

    // Cascade: delete any pending inbox notifications linked to this
    // requirement. Without this they stay in users' inboxes as ghost
    // alerts pointing at a now-missing entity. (The escalation scheduler
    // wouldn't re-email them, but they look broken in the UI.)
    try {
      await query(
        `DELETE FROM notifications
         WHERE entity_type = 'job_requirements' AND entity_id = $1`,
        [id]
      );
    } catch (cascadeErr) {
      console.warn('[Requirements] Failed to cascade-delete notifications:', cascadeErr);
    }

    // Log to activity timeline (interactions table)
    const content = reason
      ? `Removed requirement: ${reqData.type_label || reqData.requirement_type} — Reason: ${reason}`
      : `Removed requirement: ${reqData.type_label || reqData.requirement_type}`;
    await query(
      `INSERT INTO interactions (type, content, job_id, created_by)
       VALUES ('note', $1, $2, $3)`,
      [content, reqData.job_id, req.user!.id]
    );

    res.json({ data: { deleted: true } });
  } catch (err) {
    console.error('Error deleting requirement:', err);
    res.status(500).json({ error: 'Failed to delete requirement' });
  }
});

// ── List requirement type definitions ────────────────────────────────────

router.get('/types', async (_req: AuthRequest, res: Response) => {
  try {
    const result = await query(
      'SELECT * FROM requirement_type_definitions WHERE is_active = true ORDER BY sort_order'
    );
    res.json({ data: result.rows });
  } catch (err) {
    console.error('Error fetching requirement types:', err);
    res.status(500).json({ error: 'Failed to fetch types' });
  }
});

// ── List templates ───────────────────────────────────────────────────────

router.get('/templates', async (_req: AuthRequest, res: Response) => {
  try {
    const result = await query(
      'SELECT * FROM requirement_templates WHERE is_active = true ORDER BY sort_order'
    );
    res.json({ data: result.rows });
  } catch (err) {
    console.error('Error fetching templates:', err);
    res.status(500).json({ error: 'Failed to fetch templates' });
  }
});

export default router;
