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

    // Fetch org-to-org relationships
    const relationships = await query(
      `SELECT r.*,
        fo.name as from_org_name, fo.type as from_org_type,
        tor.name as to_org_name, tor.type as to_org_type
       FROM organisation_relationships r
       JOIN organisations fo ON fo.id = r.from_org_id
       JOIN organisations tor ON tor.id = r.to_org_id
       WHERE (r.from_org_id = $1 OR r.to_org_id = $1)
       ORDER BY r.status ASC, r.created_at DESC`,
      [req.params.id]
    );

    // Fetch jobs linked via job_organisations
    const linkedJobs = await query(
      `SELECT jo.*, j.job_name, j.hh_job_number, j.pipeline_status, j.job_date, j.return_date, j.job_value
       FROM job_organisations jo
       JOIN jobs j ON j.id = jo.job_id AND j.is_deleted = false
       WHERE jo.organisation_id = $1
       ORDER BY j.job_date DESC NULLS LAST
       LIMIT 20`,
      [req.params.id]
    );

    const org = result.rows[0];
    org.relationships = relationships.rows;
    org.linked_jobs = linkedJobs.rows;

    res.json(org);
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

    const clientVersion = req.body.version;
    const fields = Object.entries(req.body).filter(([k, v]) => v !== undefined && k !== 'version');
    if (fields.length === 0) {
      res.json(current.rows[0]);
      return;
    }

    const setClauses = fields.map(([key], i) => `${key} = $${i + 1}`);
    setClauses.push(`updated_at = NOW()`);
    setClauses.push(`version = version + 1`);
    const values = fields.map(([, v]) => v);
    values.push(req.params.id);

    let whereClause = `id = $${values.length} AND is_deleted = false`;
    if (clientVersion !== undefined) {
      values.push(clientVersion);
      whereClause += ` AND version = $${values.length}`;
    }

    const result = await query(
      `UPDATE organisations SET ${setClauses.join(', ')} WHERE ${whereClause} RETURNING *`,
      values
    );

    if (result.rows.length === 0 && clientVersion !== undefined) {
      res.status(409).json({ error: 'This record was modified by someone else. Please reload and try again.' });
      return;
    }

    await logAudit(req.user!.id, 'organisations', req.params.id as string, 'update', current.rows[0], result.rows[0]);

    res.json(result.rows[0]);
  } catch (error) {
    console.error('Update organisation error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ============================================================================
// ORGANISATION RELATIONSHIPS — Org-to-org links
// ============================================================================

const createRelationshipSchema = z.object({
  from_org_id: z.string().uuid(),
  to_org_id: z.string().uuid(),
  relationship_type: z.enum(['manages', 'books_for', 'does_accounts_for', 'promotes', 'supplies', 'represents', 'other']),
  status: z.enum(['active', 'historical']).optional().default('active'),
  start_date: z.string().optional().nullable(),
  end_date: z.string().optional().nullable(),
  notes: z.string().optional().nullable(),
});

const updateRelationshipSchema = z.object({
  relationship_type: z.enum(['manages', 'books_for', 'does_accounts_for', 'promotes', 'supplies', 'represents', 'other']).optional(),
  status: z.enum(['active', 'historical']).optional(),
  start_date: z.string().optional().nullable(),
  end_date: z.string().optional().nullable(),
  notes: z.string().optional().nullable(),
});

// GET /api/organisations/:id/relationships
router.get('/:id/relationships', async (req: AuthRequest, res: Response) => {
  try {
    const result = await query(
      `SELECT r.*,
        fo.name as from_org_name, fo.type as from_org_type,
        tor.name as to_org_name, tor.type as to_org_type
       FROM organisation_relationships r
       JOIN organisations fo ON fo.id = r.from_org_id
       JOIN organisations tor ON tor.id = r.to_org_id
       WHERE (r.from_org_id = $1 OR r.to_org_id = $1)
       ORDER BY r.status ASC, r.created_at DESC`,
      [req.params.id]
    );
    res.json({ data: result.rows });
  } catch (error) {
    console.error('Get org relationships error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/organisations/:id/relationships
router.post('/:id/relationships', validate(createRelationshipSchema), async (req: AuthRequest, res: Response) => {
  try {
    const { from_org_id, to_org_id, relationship_type, status, start_date, end_date, notes } = req.body;

    // Verify both orgs exist
    const fromOrg = await query('SELECT id FROM organisations WHERE id = $1 AND is_deleted = false', [from_org_id]);
    const toOrg = await query('SELECT id FROM organisations WHERE id = $1 AND is_deleted = false', [to_org_id]);
    if (fromOrg.rows.length === 0 || toOrg.rows.length === 0) {
      res.status(404).json({ error: 'One or both organisations not found' });
      return;
    }

    const result = await query(
      `INSERT INTO organisation_relationships (from_org_id, to_org_id, relationship_type, status, start_date, end_date, notes, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING *`,
      [from_org_id, to_org_id, relationship_type, status, start_date, end_date, notes, req.user!.id]
    );

    // Fetch with joined org names for response
    const full = await query(
      `SELECT r.*,
        fo.name as from_org_name, fo.type as from_org_type,
        tor.name as to_org_name, tor.type as to_org_type
       FROM organisation_relationships r
       JOIN organisations fo ON fo.id = r.from_org_id
       JOIN organisations tor ON tor.id = r.to_org_id
       WHERE r.id = $1`,
      [result.rows[0].id]
    );

    res.status(201).json(full.rows[0]);
  } catch (error: any) {
    if (error.constraint === 'uq_org_relationship') {
      res.status(409).json({ error: 'This relationship already exists' });
      return;
    }
    if (error.constraint === 'chk_no_self_relationship') {
      res.status(400).json({ error: 'An organisation cannot have a relationship with itself' });
      return;
    }
    console.error('Create org relationship error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// PUT /api/organisations/:orgId/relationships/:relId
router.put('/:orgId/relationships/:relId', validate(updateRelationshipSchema), async (req: AuthRequest, res: Response) => {
  try {
    const fields = Object.entries(req.body).filter(([, v]) => v !== undefined);
    if (fields.length === 0) {
      res.status(400).json({ error: 'No fields to update' });
      return;
    }

    const setClauses = fields.map(([key], i) => `${key} = $${i + 1}`);
    setClauses.push('updated_at = NOW()');
    const values = fields.map(([, v]) => v);
    values.push(req.params.relId);

    const result = await query(
      `UPDATE organisation_relationships SET ${setClauses.join(', ')} WHERE id = $${values.length} RETURNING *`,
      values
    );

    if (result.rows.length === 0) {
      res.status(404).json({ error: 'Relationship not found' });
      return;
    }

    // Fetch full with joined names
    const full = await query(
      `SELECT r.*,
        fo.name as from_org_name, fo.type as from_org_type,
        tor.name as to_org_name, tor.type as to_org_type
       FROM organisation_relationships r
       JOIN organisations fo ON fo.id = r.from_org_id
       JOIN organisations tor ON tor.id = r.to_org_id
       WHERE r.id = $1`,
      [result.rows[0].id]
    );

    res.json(full.rows[0]);
  } catch (error) {
    console.error('Update org relationship error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// DELETE /api/organisations/:orgId/relationships/:relId
router.delete('/:orgId/relationships/:relId', async (req: AuthRequest, res: Response) => {
  try {
    const result = await query(
      'DELETE FROM organisation_relationships WHERE id = $1 RETURNING *',
      [req.params.relId]
    );
    if (result.rows.length === 0) {
      res.status(404).json({ error: 'Relationship not found' });
      return;
    }
    res.status(204).send();
  } catch (error) {
    console.error('Delete org relationship error:', error);
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

// GET /api/organisations/:id/suggestions — suggest related orgs for job roles
// e.g. select a band → suggest its management company as client
router.get('/:id/suggestions', async (req: AuthRequest, res: Response) => {
  try {
    // Get all active relationships for this org
    const result = await query(
      `SELECT r.relationship_type, r.from_org_id, r.to_org_id,
        o.id as org_id, o.name as org_name, o.type as org_type
       FROM organisation_relationships r
       JOIN organisations o ON o.id = CASE WHEN r.from_org_id = $1 THEN r.to_org_id ELSE r.from_org_id END
       WHERE (r.from_org_id = $1 OR r.to_org_id = $1)
         AND r.status = 'active'
         AND o.is_deleted = false
       ORDER BY o.name`,
      [req.params.id]
    );

    // Map relationships to suggested job roles
    const suggestions = result.rows.map(row => {
      const isFrom = row.from_org_id === req.params.id;
      const relType = row.relationship_type;
      // Determine suggested job role based on relationship
      let suggestedRole = 'client';
      if (relType === 'manages' && isFrom) suggestedRole = 'client'; // band's manager → client
      if (relType === 'manages' && !isFrom) suggestedRole = 'management'; // managed by → management
      if (relType === 'books_for') suggestedRole = 'client';
      if (relType === 'promotes' && isFrom) suggestedRole = 'promoter';
      if (relType === 'promotes' && !isFrom) suggestedRole = 'promoter';
      if (relType === 'supplies') suggestedRole = 'supplier';
      if (relType === 'represents') suggestedRole = isFrom ? 'management' : 'client';

      return {
        org_id: row.org_id,
        org_name: row.org_name,
        org_type: row.org_type,
        relationship_type: relType,
        suggested_role: suggestedRole,
        direction: isFrom ? 'outgoing' : 'incoming',
      };
    });

    res.json({ data: suggestions });
  } catch (error) {
    console.error('Get org suggestions error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
