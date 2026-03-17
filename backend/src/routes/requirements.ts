import { Router, Response } from 'express';
import { z } from 'zod';
import { query } from '../config/database';
import { authenticate, authorize, AuthRequest } from '../middleware/auth';
import { validate } from '../middleware/validate';

const router = Router();
router.use(authenticate);
router.use(authorize('admin', 'manager', 'staff'));

// ── Valid statuses (non-linear — any to any) ─────────────────────────────

const VALID_STATUSES = ['not_started', 'in_progress', 'done', 'blocked'] as const;

// ── List requirements for a job ──────────────────────────────────────────

router.get('/job/:jobId', async (req: AuthRequest, res: Response) => {
  try {
    const { jobId } = req.params;
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
       WHERE jr.job_id = $1
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
    const { job_ids } = req.body;
    if (!Array.isArray(job_ids) || job_ids.length === 0) {
      return res.json({ data: {} });
    }
    // Limit to 500 job IDs
    const ids = job_ids.slice(0, 500);
    const result = await query(
      `SELECT jr.job_id, jr.status, jr.requirement_type
       FROM job_requirements jr
       WHERE jr.job_id = ANY($1)`,
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

// ── Add a requirement to a job ───────────────────────────────────────────

const addRequirementSchema = z.object({
  body: z.object({
    requirement_type: z.string().min(1),
    custom_label: z.string().optional(),
    notes: z.string().optional(),
    assigned_to: z.string().uuid().optional(),
    due_date: z.string().optional(),
    status: z.enum(VALID_STATUSES).optional(),
    current_step: z.string().optional(),
    source: z.string().optional(),
    source_id: z.string().uuid().optional(),
  }),
});

router.post('/job/:jobId', validate(addRequirementSchema), async (req: AuthRequest, res: Response) => {
  try {
    const { jobId } = req.params;
    const { requirement_type, custom_label, notes, assigned_to, due_date, status, current_step, source, source_id } = req.body;

    // Verify the requirement type exists
    const typeCheck = await query('SELECT type, steps FROM requirement_type_definitions WHERE type = $1', [requirement_type]);
    if (typeCheck.rows.length === 0) {
      return res.status(400).json({ error: `Unknown requirement type: ${requirement_type}` });
    }

    // For non-custom types, check uniqueness
    if (requirement_type !== 'custom') {
      const existing = await query(
        'SELECT id FROM job_requirements WHERE job_id = $1 AND requirement_type = $2',
        [jobId, requirement_type]
      );
      if (existing.rows.length > 0) {
        return res.status(409).json({ error: `Requirement type '${requirement_type}' already exists for this job` });
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
      `INSERT INTO job_requirements (job_id, requirement_type, custom_label, notes, assigned_to, due_date, status, current_step, source, source_id, sort_order, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
       RETURNING *`,
      [jobId, requirement_type, custom_label || null, notes || null, assigned_to || null, due_date || null,
       status || 'not_started', initialStep || null, source || 'manual', source_id || null,
       maxOrder.rows[0].next_order, req.user!.id]
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
  body: z.object({
    status: z.enum(VALID_STATUSES).optional(),
    current_step: z.string().nullable().optional(),
    notes: z.string().nullable().optional(),
    assigned_to: z.string().uuid().nullable().optional(),
    due_date: z.string().nullable().optional(),
    custom_label: z.string().nullable().optional(),
    sort_order: z.number().optional(),
  }),
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

    res.json({ data: result.rows[0] });
  } catch (err) {
    console.error('Error updating requirement:', err);
    res.status(500).json({ error: 'Failed to update requirement' });
  }
});

// ── Delete a requirement ─────────────────────────────────────────────────

router.delete('/:id', async (req: AuthRequest, res: Response) => {
  try {
    const { id } = req.params;
    const result = await query('DELETE FROM job_requirements WHERE id = $1 RETURNING id', [id]);
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Requirement not found' });
    }
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
