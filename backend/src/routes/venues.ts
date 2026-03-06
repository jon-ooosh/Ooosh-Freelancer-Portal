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

const createVenueSchema = z.object({
  name: z.string().min(1).max(500),
  organisation_id: z.string().uuid().optional().nullable(),
  address: z.string().optional().nullable(),
  city: z.string().max(255).optional().nullable(),
  postcode: z.string().max(20).optional().nullable(),
  country: z.string().max(100).optional().nullable(),
  latitude: z.number().optional().nullable(),
  longitude: z.number().optional().nullable(),
  w3w_address: z.string().max(100).optional().nullable(),
  load_in_address: z.string().optional().nullable(),
  loading_bay_info: z.string().optional().nullable(),
  access_codes: z.string().optional().nullable(),
  parking_info: z.string().optional().nullable(),
  approach_notes: z.string().optional().nullable(),
  technical_notes: z.string().optional().nullable(),
  general_notes: z.string().optional().nullable(),
  default_miles_from_base: z.number().optional().nullable(),
  default_drive_time_mins: z.number().int().optional().nullable(),
  default_return_cost: z.number().optional().nullable(),
  tags: z.array(z.string()).optional().default([]),
  files: z.array(fileSchema).optional().default([]),
});

const updateVenueSchema = createVenueSchema.partial();

// GET /api/venues
router.get('/', async (req: AuthRequest, res: Response) => {
  try {
    const { search, city, page = '1', limit = '50' } = req.query;
    const offset = (parseInt(page as string) - 1) * parseInt(limit as string);

    let sql = 'SELECT * FROM venues WHERE is_deleted = false';
    const params: unknown[] = [];
    let paramIndex = 1;

    if (search) {
      sql += ` AND (name ILIKE $${paramIndex} OR address ILIKE $${paramIndex} OR city ILIKE $${paramIndex})`;
      params.push(`%${search}%`);
      paramIndex++;
    }

    if (city) {
      sql += ` AND city ILIKE $${paramIndex}`;
      params.push(`%${city}%`);
      paramIndex++;
    }

    const countResult = await query(sql.replace('SELECT *', 'SELECT COUNT(*)'), params);
    const total = parseInt(countResult.rows[0].count);

    sql += ` ORDER BY name LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`;
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
    console.error('List venues error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/venues/:id
router.get('/:id', async (req: AuthRequest, res: Response) => {
  try {
    const result = await query('SELECT * FROM venues WHERE id = $1 AND is_deleted = false', [req.params.id]);

    if (result.rows.length === 0) {
      res.status(404).json({ error: 'Venue not found' });
      return;
    }

    res.json(result.rows[0]);
  } catch (error) {
    console.error('Get venue error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/venues
router.post('/', validate(createVenueSchema), async (req: AuthRequest, res: Response) => {
  try {
    const {
      name, organisation_id, address, city, postcode, country, latitude, longitude,
      w3w_address, load_in_address, loading_bay_info, access_codes, parking_info,
      approach_notes, technical_notes, general_notes,
      default_miles_from_base, default_drive_time_mins, default_return_cost,
      tags, files,
    } = req.body;

    const result = await query(
      `INSERT INTO venues (
        name, organisation_id, address, city, postcode, country, latitude, longitude,
        w3w_address, load_in_address, loading_bay_info, access_codes, parking_info,
        approach_notes, technical_notes, general_notes,
        default_miles_from_base, default_drive_time_mins, default_return_cost,
        tags, files, created_by
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22)
       RETURNING *`,
      [
        name, organisation_id, address, city, postcode, country, latitude, longitude,
        w3w_address, load_in_address, loading_bay_info, access_codes, parking_info,
        approach_notes, technical_notes, general_notes,
        default_miles_from_base, default_drive_time_mins, default_return_cost,
        tags, JSON.stringify(files), req.user!.id,
      ]
    );

    await logAudit(req.user!.id, 'venues', result.rows[0].id, 'create', null, result.rows[0]);
    res.status(201).json(result.rows[0]);
  } catch (error) {
    console.error('Create venue error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// PUT /api/venues/:id
router.put('/:id', validate(updateVenueSchema), async (req: AuthRequest, res: Response) => {
  try {
    const current = await query('SELECT * FROM venues WHERE id = $1 AND is_deleted = false', [req.params.id]);
    if (current.rows.length === 0) {
      res.status(404).json({ error: 'Venue not found' });
      return;
    }

    const fields = Object.entries(req.body).filter(([, v]) => v !== undefined);
    if (fields.length === 0) {
      res.json(current.rows[0]);
      return;
    }

    const setClauses = fields.map(([key], i) => `${key} = $${i + 1}`);
    setClauses.push('updated_at = NOW()');
    const values = fields.map(([, v]) => v);
    values.push(req.params.id);

    const result = await query(
      `UPDATE venues SET ${setClauses.join(', ')} WHERE id = $${values.length} AND is_deleted = false RETURNING *`,
      values
    );

    await logAudit(req.user!.id, 'venues', req.params.id as string, 'update', current.rows[0], result.rows[0]);
    res.json(result.rows[0]);
  } catch (error) {
    console.error('Update venue error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// DELETE /api/venues/:id — soft delete
router.delete('/:id', authorize('admin', 'manager'), async (req: AuthRequest, res: Response) => {
  try {
    const current = await query('SELECT * FROM venues WHERE id = $1 AND is_deleted = false', [req.params.id]);
    if (current.rows.length === 0) {
      res.status(404).json({ error: 'Venue not found' });
      return;
    }

    await query('UPDATE venues SET is_deleted = true, updated_at = NOW() WHERE id = $1', [req.params.id]);
    await logAudit(req.user!.id, 'venues', req.params.id as string, 'delete', current.rows[0], null);
    res.status(204).send();
  } catch (error) {
    console.error('Delete venue error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
