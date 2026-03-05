import { Router, Response } from 'express';
import { z } from 'zod';
import { query } from '../config/database';
import { authenticate, AuthRequest } from '../middleware/auth';
import { validate } from '../middleware/validate';
import { logAudit } from '../middleware/audit';

const router = Router();
router.use(authenticate);

const createInteractionSchema = z.object({
  type: z.enum(['note', 'email', 'call', 'meeting', 'mention']),
  content: z.string().min(1),
  // Polymorphic linking — at least one must be provided
  person_id: z.string().uuid().optional().nullable(),
  organisation_id: z.string().uuid().optional().nullable(),
  job_id: z.string().uuid().optional().nullable(),
  opportunity_id: z.string().uuid().optional().nullable(),
  venue_id: z.string().uuid().optional().nullable(),
  // @mentions
  mentioned_user_ids: z.array(z.string().uuid()).optional().default([]),
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

// POST /api/interactions — create a note, log a call, etc.
router.post('/', validate(createInteractionSchema), async (req: AuthRequest, res: Response) => {
  try {
    const {
      type, content, person_id, organisation_id, job_id, opportunity_id, venue_id,
      mentioned_user_ids,
    } = req.body;

    const result = await query(
      `INSERT INTO interactions (type, content, person_id, organisation_id, job_id, opportunity_id, venue_id, mentioned_user_ids, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING *`,
      [type, content, person_id, organisation_id, job_id, opportunity_id, venue_id, mentioned_user_ids, req.user!.id]
    );

    await logAudit(req.user!.id, 'interactions', result.rows[0].id, 'create', null, result.rows[0]);

    // TODO: Phase 1 — send in-app + email notifications to mentioned_user_ids via Socket.io

    res.status(201).json(result.rows[0]);
  } catch (error) {
    console.error('Create interaction error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
