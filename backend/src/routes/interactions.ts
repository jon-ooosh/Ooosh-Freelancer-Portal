import { Router, Response } from 'express';
import { z } from 'zod';
import { query } from '../config/database';
import { authenticate, AuthRequest } from '../middleware/auth';
import { validate } from '../middleware/validate';
import { logAudit } from '../middleware/audit';

const router = Router();
router.use(authenticate);

const createInteractionSchema = z.object({
  type: z.enum(['note', 'email', 'call', 'meeting', 'mention', 'chase', 'status_transition']),
  content: z.string().min(1),
  // Polymorphic linking — at least one must be provided
  person_id: z.string().uuid().optional().nullable(),
  organisation_id: z.string().uuid().optional().nullable(),
  job_id: z.string().uuid().optional().nullable(),
  opportunity_id: z.string().uuid().optional().nullable(),
  venue_id: z.string().uuid().optional().nullable(),
  // @mentions
  mentioned_user_ids: z.array(z.string().uuid()).optional().default([]),
  // Chase-specific fields
  chase_method: z.enum(['phone', 'email', 'text', 'whatsapp']).optional().nullable(),
  chase_response: z.string().optional().nullable(),
  // Optional: override next chase date (otherwise auto-calculated)
  next_chase_date: z.string().optional().nullable(),
});

// GET /api/interactions — timeline for an entity
router.get('/', async (req: AuthRequest, res: Response) => {
  try {
    const { person_id, organisation_id, job_id, venue_id, page = '1', limit = '50' } = req.query;
    const offset = (parseInt(page as string) - 1) * parseInt(limit as string);

    let sql = `
      SELECT i.*,
        u.email as created_by_email,
        CONCAT(p.first_name, ' ', p.last_name) as created_by_name
      FROM interactions i
      LEFT JOIN users u ON u.id = i.created_by
      LEFT JOIN people p ON p.id = u.person_id
      WHERE 1=1
    `;
    const params: unknown[] = [];
    let paramIndex = 1;

    if (person_id) {
      sql += ` AND i.person_id = $${paramIndex}`;
      params.push(person_id);
      paramIndex++;
    }
    if (organisation_id) {
      sql += ` AND i.organisation_id = $${paramIndex}`;
      params.push(organisation_id);
      paramIndex++;
    }
    if (job_id) {
      sql += ` AND i.job_id = $${paramIndex}`;
      params.push(job_id);
      paramIndex++;
    }
    if (venue_id) {
      sql += ` AND i.venue_id = $${paramIndex}`;
      params.push(venue_id);
      paramIndex++;
    }

    sql += ` ORDER BY i.created_at DESC LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`;
    params.push(parseInt(limit as string), offset);

    const result = await query(sql, params);

    res.json({ data: result.rows });
  } catch (error) {
    console.error('List interactions error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/interactions — create a note, log a call, chase, etc.
router.post('/', validate(createInteractionSchema), async (req: AuthRequest, res: Response) => {
  try {
    const {
      type, content, person_id, organisation_id, job_id, opportunity_id, venue_id,
      mentioned_user_ids, chase_method, chase_response, next_chase_date,
    } = req.body;

    // If linked to a job, snapshot current status for tracking
    let jobStatusAt: number | null = null;
    let jobStatusNameAt: string | null = null;
    let pipelineStatusAt: string | null = null;
    if (job_id) {
      const jobResult = await query(
        `SELECT status, status_name, pipeline_status FROM jobs WHERE id = $1 AND is_deleted = false`,
        [job_id]
      );
      if (jobResult.rows.length > 0) {
        jobStatusAt = jobResult.rows[0].status;
        jobStatusNameAt = jobResult.rows[0].status_name;
        pipelineStatusAt = jobResult.rows[0].pipeline_status;
      }
    }

    const result = await query(
      `INSERT INTO interactions (type, content, person_id, organisation_id, job_id, opportunity_id, venue_id,
        mentioned_user_ids, created_by, job_status_at_creation, job_status_name_at_creation,
        pipeline_status_at_creation, chase_method, chase_response)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
       RETURNING *`,
      [type, content, person_id, organisation_id, job_id, opportunity_id, venue_id,
        mentioned_user_ids, req.user!.id, jobStatusAt, jobStatusNameAt,
        pipelineStatusAt, chase_method || null, chase_response || null]
    );

    // Chase side-effects: auto-increment chase_count, set next_chase_date
    if (type === 'chase' && job_id) {
      const chaseDate = next_chase_date || null;
      await query(
        `UPDATE jobs SET
          chase_count = chase_count + 1,
          last_chased_at = NOW(),
          next_chase_date = CASE
            WHEN $1::date IS NOT NULL THEN $1::date
            ELSE (CURRENT_DATE + (COALESCE(chase_interval_days, 3) || ' days')::interval)::date
          END,
          updated_at = NOW()
        WHERE id = $2`,
        [chaseDate, job_id]
      );
    }

    await logAudit(req.user!.id, 'interactions', result.rows[0].id, 'create', null, result.rows[0]);

    // Send in-app notifications to mentioned users
    if (mentioned_user_ids && mentioned_user_ids.length > 0) {
      const creatorResult = await query(
        `SELECT CONCAT(p.first_name, ' ', p.last_name) as name
         FROM users u JOIN people p ON p.id = u.person_id WHERE u.id = $1`,
        [req.user!.id]
      );
      const creatorName = creatorResult.rows[0]?.name || 'Someone';

      const entityType = person_id ? 'people' : organisation_id ? 'organisations' : venue_id ? 'venues' : null;
      const entityId = person_id || organisation_id || venue_id || null;

      for (const userId of mentioned_user_ids) {
        if (userId === req.user!.id) continue; // Don't notify yourself

        const notifResult = await query(
          `INSERT INTO notifications (user_id, type, title, content, entity_type, entity_id)
           VALUES ($1, 'mention', $2, $3, $4, $5)
           RETURNING *`,
          [
            userId,
            `${creatorName} mentioned you`,
            content.length > 200 ? content.slice(0, 200) + '...' : content,
            entityType,
            entityId,
          ]
        );

        // Emit real-time notification via Socket.io
        const io = req.app.get('io');
        if (io) {
          io.to(`user:${userId}`).emit('notification', notifResult.rows[0]);
        }
      }
    }

    res.status(201).json(result.rows[0]);
  } catch (error) {
    console.error('Create interaction error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// PUT /api/interactions/:id/move — move an interaction to a different entity
const moveInteractionSchema = z.object({
  target_type: z.enum(['person_id', 'organisation_id', 'venue_id']),
  target_id: z.string().uuid(),
});

router.put('/:id/move', validate(moveInteractionSchema), async (req: AuthRequest, res: Response) => {
  try {
    const { target_type, target_id } = req.body;

    // Verify interaction exists
    const current = await query('SELECT * FROM interactions WHERE id = $1', [req.params.id]);
    if (current.rows.length === 0) {
      res.status(404).json({ error: 'Interaction not found' });
      return;
    }

    // Clear all entity links and set the new one
    const result = await query(
      `UPDATE interactions
       SET person_id = CASE WHEN $1 = 'person_id' THEN $2::uuid ELSE NULL END,
           organisation_id = CASE WHEN $1 = 'organisation_id' THEN $2::uuid ELSE NULL END,
           venue_id = CASE WHEN $1 = 'venue_id' THEN $2::uuid ELSE NULL END
       WHERE id = $3
       RETURNING *`,
      [target_type, target_id, req.params.id]
    );

    await logAudit(req.user!.id, 'interactions', req.params.id as string, 'update', current.rows[0], result.rows[0]);

    res.json(result.rows[0]);
  } catch (error) {
    console.error('Move interaction error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
