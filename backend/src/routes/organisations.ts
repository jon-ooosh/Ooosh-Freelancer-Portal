import { Router, Response } from 'express';
import { z } from 'zod';
import { query } from '../config/database';
import { authenticate, authorize, AuthRequest } from '../middleware/auth';
import { validate } from '../middleware/validate';
import { logAudit } from '../middleware/audit';

const router = Router();
router.use(authenticate);

const fileSchema = z.object({
  name: z.string(),
  url: z.string().url(),
  type: z.enum(['document', 'image', 'other']),
  uploaded_at: z.string(),
  uploaded_by: z.string(),
});

const createOrgSchema = z.object({
  name: z.string().min(1).max(500),
  type: z.string().min(1), // band, management, label, agency, promoter, venue, festival, supplier, hire_company, booking_agent, unknown, other
  parent_id: z.string().uuid().optional().nullable(),
  website: z.string().url().optional().nullable(),
  email: z.string().email().optional().nullable(),
  phone: z.string().max(50).optional().nullable(),
  address: z.string().optional().nullable(),
  location: z.string().max(500).optional().nullable(),
  notes: z.string().optional().nullable(),
  tags: z.array(z.string()).optional().default([]),
  files: z.array(fileSchema).optional().default([]),
});

const updateOrgSchema = createOrgSchema.partial();

// GET /api/organisations
router.get('/', async (req: AuthRequest, res: Response) => {
  try {
    const { search, type, page = '1', limit = '50' } = req.query;
    const offset = (parseInt(page as string) - 1) * parseInt(limit as string);

    let sql = `
      SELECT o.*,
        (SELECT COUNT(*) FROM person_organisation_roles por
         WHERE por.organisation_id = o.id AND por.status = 'active') as active_people_count,
        parent.name as parent_name
      FROM organisations o
      LEFT JOIN organisations parent ON parent.id = o.parent_id
      WHERE o.is_deleted = false
    `;
    const params: unknown[] = [];
    let paramIndex = 1;

    if (search) {
      sql += ` AND o.name ILIKE $${paramIndex}`;
      params.push(`%${search}%`);
      paramIndex++;
    }

    if (type) {
      sql += ` AND o.type = $${paramIndex}`;
      params.push(type);
      paramIndex++;
    }

    const countResult = await query(
      sql.replace(/SELECT o\.\*.*FROM organisations o/s, 'SELECT COUNT(*) FROM organisations o'),
      params
    );
    const total = parseInt(countResult.rows[0].count);

    sql += ` ORDER BY o.name LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`;
    params.push(parseInt(limit as string), offset);

    const result = await query(sql, params);

    res.json({
      data: result.rows,
      pagination: {
        page: parseInt(page as string),
        limit: parseInt(limit as string),
        total,
        totalPages: Math.ceil(total / parseInt(limit as string)),
      },
    });
  } catch (error) {
    console.error('List organisations error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/organisations/:id
router.get('/:id', async (req: AuthRequest, res: Response) => {
  try {
    const result = await query(
      `SELECT o.*,
        parent.name as parent_name,
        (SELECT json_agg(json_build_object(
          'id', por.id,
          'person_id', por.person_id,
          'person_name', CONCAT(p.first_name, ' ', p.last_name),
          'person_email', p.email,
          'role', por.role,
          'status', por.status,
          'is_primary', por.is_primary,
          'start_date', por.start_date,
          'end_date', por.end_date
        ) ORDER BY por.status, p.last_name)
        FROM person_organisation_roles por
        JOIN people p ON p.id = por.person_id
        WHERE por.organisation_id = o.id
        ) as people,
        (SELECT json_agg(json_build_object('id', sub.id, 'name', sub.name, 'type', sub.type))
         FROM organisations sub WHERE sub.parent_id = o.id AND sub.is_deleted = false
        ) as subsidiaries
      FROM organisations o
      LEFT JOIN organisations parent ON parent.id = o.parent_id
      WHERE o.id = $1 AND o.is_deleted = false`,
      [req.params.id]
    );

    if (result.rows.length === 0) {
      res.status(404).json({ error: 'Organisation not found' });
      return;
    }

    res.json(result.rows[0]);
  } catch (error) {
    console.error('Get organisation error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/organisations
router.post('/', validate(createOrgSchema), async (req: AuthRequest, res: Response) => {
  try {
    const { name, type, parent_id, website, email, phone, address, location, notes, tags, files } = req.body;

    const result = await query(
      `INSERT INTO organisations (name, type, parent_id, website, email, phone, address, location, notes, tags, files, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
       RETURNING *`,
      [name, type, parent_id, website, email?.toLowerCase(), phone, address, location, notes, tags, JSON.stringify(files), req.user!.id]
    );

    await logAudit(req.user!.id, 'organisations', result.rows[0].id, 'create', null, result.rows[0]);

    res.status(201).json(result.rows[0]);
  } catch (error) {
    console.error('Create organisation error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// PUT /api/organisations/:id
router.put('/:id', validate(updateOrgSchema), async (req: AuthRequest, res: Response) => {
  try {
    const current = await query('SELECT * FROM organisations WHERE id = $1 AND is_deleted = false', [req.params.id]);
    if (current.rows.length === 0) {
      res.status(404).json({ error: 'Organisation not found' });
      return;
    }

    const fields = Object.entries(req.body).filter(([, v]) => v !== undefined);
    if (fields.length === 0) {
      res.json(current.rows[0]);
      return;
    }

    const setClauses = fields.map(([key], i) => `${key} = $${i + 1}`);
    setClauses.push(`updated_at = NOW()`);
    const values = fields.map(([, v]) => v);
    values.push(req.params.id);

    const result = await query(
      `UPDATE organisations SET ${setClauses.join(', ')} WHERE id = $${values.length} AND is_deleted = false RETURNING *`,
      values
    );

    await logAudit(req.user!.id, 'organisations', req.params.id as string, 'update', current.rows[0], result.rows[0]);

    res.json(result.rows[0]);
  } catch (error) {
    console.error('Update organisation error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// DELETE /api/organisations/:id — soft delete
router.delete('/:id', authorize('admin', 'manager'), async (req: AuthRequest, res: Response) => {
  try {
    const current = await query('SELECT * FROM organisations WHERE id = $1 AND is_deleted = false', [req.params.id]);
    if (current.rows.length === 0) {
      res.status(404).json({ error: 'Organisation not found' });
      return;
    }

    await query('UPDATE organisations SET is_deleted = true, updated_at = NOW() WHERE id = $1', [req.params.id]);
    await logAudit(req.user!.id, 'organisations', req.params.id as string, 'delete', current.rows[0], null);

    res.status(204).send();
  } catch (error) {
    console.error('Delete organisation error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
