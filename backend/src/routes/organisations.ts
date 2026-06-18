import { Router, Response } from 'express';
import { z } from 'zod';
import { query, getClient } from '../config/database';
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
  // Working terms
  working_terms_type: z.enum(['usual', 'flex_balance', 'no_deposit', 'credit', 'custom']).optional().nullable(),
  working_terms_credit_days: z.number().int().optional().nullable(),
  working_terms_notes: z.string().optional().nullable(),
  // AI text fields
  ai_summary: z.string().optional().nullable(),
  ai_research: z.string().optional().nullable(),
});

const updateOrgSchema = createOrgSchema.partial();

// GET /api/organisations
router.get('/', async (req: AuthRequest, res: Response) => {
  try {
    const { search, type, page = '1', limit = '50', tag, has_email, has_people, missing_email, missing_phone, location, sort } = req.query;
    const offset = (parseInt(page as string) - 1) * parseInt(limit as string);

    let sql = `
      SELECT o.*,
        (SELECT COUNT(*) FROM person_organisation_roles por
         WHERE por.organisation_id = o.id AND por.status = 'active') as active_people_count,
        parent.name as parent_name,
        (SELECT MAX(i.created_at) FROM interactions i WHERE i.organisation_id = o.id) as last_interaction_at
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

    if (tag) {
      sql += ` AND $${paramIndex} = ANY(o.tags)`;
      params.push(tag);
      paramIndex++;
    }

    if (has_email === 'true') {
      sql += ` AND o.email IS NOT NULL AND o.email != ''`;
    }

    if (has_people === 'true') {
      sql += ` AND (SELECT COUNT(*) FROM person_organisation_roles por WHERE por.organisation_id = o.id AND por.status = 'active') > 0`;
    }

    if (missing_email === 'true') {
      sql += ` AND (o.email IS NULL OR o.email = '')`;
    }

    if (missing_phone === 'true') {
      sql += ` AND (o.phone IS NULL OR o.phone = '')`;
    }

    if (location) {
      sql += ` AND o.location ILIKE $${paramIndex}`;
      params.push(`%${location}%`);
      paramIndex++;
    }

    const countResult = await query(
      sql.replace(/SELECT o\.\*.*FROM organisations o/s, 'SELECT COUNT(*) FROM organisations o'),
      params
    );
    const total = parseInt(countResult.rows[0].count);

    const sortMap: Record<string, string> = {
      'name': 'o.name',
      'recently_added': 'o.created_at DESC',
      'recently_updated': 'o.updated_at DESC',
      'last_contacted': '(SELECT MAX(i.created_at) FROM interactions i WHERE i.organisation_id = o.id) DESC NULLS LAST',
    };
    const orderBy = sortMap[sort as string] || 'o.name';

    sql += ` ORDER BY ${orderBy} LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`;
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

    // Total hire history count — UNION of job_organisations links AND jobs.client_id direct links
    // (matches the hire-history endpoint, so the tab badge agrees with the tab content).
    const linkedJobCountResult = await query(
      `SELECT COUNT(*) AS total FROM (
         SELECT jo.job_id FROM job_organisations jo
         JOIN jobs j ON j.id = jo.job_id AND j.is_deleted = false
         WHERE jo.organisation_id = $1
         UNION
         SELECT j2.id FROM jobs j2
         WHERE j2.client_id = $1 AND j2.is_deleted = false
           AND j2.id NOT IN (SELECT jo2.job_id FROM job_organisations jo2 WHERE jo2.organisation_id = $1)
       ) AS combined`,
      [req.params.id]
    );

    const org = result.rows[0];
    org.relationships = relationships.rows;
    org.linked_jobs = linkedJobs.rows;
    org.linked_job_count = parseInt(linkedJobCountResult.rows[0]?.total || '0', 10);

    res.json(org);
  } catch (error) {
    console.error('Get organisation error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/organisations/:id/contact-candidates
// Active contact people for an org, expanded across related orgs (Org>Org via
// organisation_relationships — e.g. a band's management company). Mirrors the
// New Enquiry job cascade (/pipeline/:jobId/contacts) but org-scoped. Used by
// the storage lead-contact picker. ACTIVE roles only (por.status='active') —
// ended roles carry status='historical' and must NOT surface.
router.get('/:id/contact-candidates', async (req: AuthRequest, res: Response) => {
  try {
    const result = await query(
      `WITH related AS (
         SELECT $1::uuid AS org_id, 0 AS priority
         UNION
         SELECT CASE WHEN r.from_org_id = $1 THEN r.to_org_id ELSE r.from_org_id END, 1
         FROM organisation_relationships r
         WHERE (r.from_org_id = $1 OR r.to_org_id = $1) AND r.status = 'active'
       )
       SELECT DISTINCT ON (p.id)
              p.id AS person_id, p.first_name, p.last_name, p.email, p.phone,
              por.role, por.is_primary AS is_org_primary,
              o.id AS source_org_id, o.name AS source_org_name, rel.priority
       FROM related rel
       JOIN person_organisation_roles por ON por.organisation_id = rel.org_id AND por.status = 'active'
       JOIN organisations o ON o.id = rel.org_id AND o.is_deleted = false
       JOIN people p ON p.id = por.person_id AND p.is_deleted = false
       ORDER BY p.id, rel.priority, por.is_primary DESC`,
      [req.params.id]
    );
    const candidates = result.rows
      .map((r: Record<string, unknown>) => ({
        person_id: r.person_id,
        name: `${r.first_name || ''} ${r.last_name || ''}`.trim(),
        email: r.email,
        role: r.role,
        is_org_primary: r.is_org_primary,
        source_org_id: r.source_org_id,
        source_org_name: r.source_org_name,
        own_org: r.priority === 0,
      }))
      // Display order: own-org first, then org-primary, then name
      .sort((a, b) => Number(b.own_org) - Number(a.own_org)
        || Number(b.is_org_primary) - Number(a.is_org_primary)
        || a.name.localeCompare(b.name));
    res.json({ data: candidates });
  } catch (error) {
    console.error('Get org contact candidates error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/organisations
router.post('/', validate(createOrgSchema), async (req: AuthRequest, res: Response) => {
  try {
    const {
      name, type, parent_id, website, email, phone, address, location, notes, tags, files,
      working_terms_type, working_terms_credit_days, working_terms_notes,
    } = req.body;

    // Default working terms to 'usual' when not explicitly set
    const effectiveWorkingTerms = working_terms_type ?? 'usual';

    const result = await query(
      `INSERT INTO organisations (
        name, type, parent_id, website, email, phone, address, location, notes, tags, files,
        working_terms_type, working_terms_credit_days, working_terms_notes, created_by
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
       RETURNING *`,
      [
        name, type, parent_id, website, email?.toLowerCase(), phone, address, location, notes, tags, JSON.stringify(files),
        effectiveWorkingTerms, working_terms_credit_days ?? null, working_terms_notes ?? null,
        req.user!.id,
      ]
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

// Person added to this org — either link an existing person by id, or
// create a new lightweight person record in the same request.
const orgPersonLinkSchema = z.object({
  person_id: z.string().uuid().optional(),
  new_person: z.object({
    first_name: z.string().min(1).max(255),
    last_name: z.string().min(1).max(255),
    email: z.string().email().optional().nullable(),
    mobile: z.string().max(50).optional().nullable(),
    phone: z.string().max(50).optional().nullable(),
  }).optional(),
  role: z.string().min(1).max(255),
  is_primary: z.boolean().optional().default(false),
  start_date: z.string().optional().nullable(),
  notes: z.string().optional().nullable(),
}).refine(d => (!!d.person_id) !== (!!d.new_person), {
  message: 'Provide exactly one of person_id or new_person',
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
// Soft-end: marks the relationship historical (status + end_date) rather than
// destroying the row, so "Future Agency used to manage this band" survives as
// an audit trail. Falls back to a hard delete only when a historical twin of
// the same (from, to, type) already exists — the unique constraint
// uq_org_relationship would block the soft-end, and the audit is already
// preserved by that existing historical row.
router.delete('/:orgId/relationships/:relId', async (req: AuthRequest, res: Response) => {
  try {
    const result = await query(
      `UPDATE organisation_relationships
       SET status = 'historical', end_date = NOW(), updated_at = NOW()
       WHERE id = $1 AND status = 'active'
       RETURNING *`,
      [req.params.relId]
    );

    if (result.rows.length === 0) {
      // Either it doesn't exist, or it's already historical — confirm which.
      const existing = await query(
        'SELECT id FROM organisation_relationships WHERE id = $1',
        [req.params.relId]
      );
      if (existing.rows.length === 0) {
        res.status(404).json({ error: 'Relationship not found' });
        return;
      }
      // Already historical — idempotent no-op.
    }

    res.status(204).send();
  } catch (error: any) {
    // Unique-constraint clash: a historical twin already exists. The audit is
    // preserved by that row, so hard-delete this active duplicate.
    if (error?.code === '23505') {
      try {
        await query('DELETE FROM organisation_relationships WHERE id = $1', [req.params.relId]);
        res.status(204).send();
        return;
      } catch (delErr) {
        console.error('Delete org relationship fallback error:', delErr);
      }
    }
    console.error('Delete org relationship error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/organisations/:id/people — attach a person to this org
// Mirror of POST /api/people/:id/roles but driven from the org side, so
// you can add a contact without leaving the org detail page. Accepts
// either person_id (existing) or new_person (creates + links atomically).
router.post('/:id/people', validate(orgPersonLinkSchema), async (req: AuthRequest, res: Response) => {
  const orgId = req.params.id as string;
  const { person_id, new_person, role, is_primary, start_date, notes } = req.body;

  const orgCheck = await query(
    'SELECT id FROM organisations WHERE id = $1 AND is_deleted = false',
    [orgId]
  );
  if (orgCheck.rows.length === 0) {
    res.status(404).json({ error: 'Organisation not found' });
    return;
  }

  const client = await getClient();
  try {
    await client.query('BEGIN');

    let resolvedPersonId: string;
    let createdPerson: Record<string, unknown> | null = null;

    if (person_id) {
      const exists = await client.query(
        'SELECT id FROM people WHERE id = $1 AND is_deleted = false',
        [person_id]
      );
      if (exists.rows.length === 0) {
        await client.query('ROLLBACK');
        res.status(404).json({ error: 'Person not found' });
        return;
      }
      resolvedPersonId = person_id;
    } else {
      const np = new_person as { first_name: string; last_name: string; email?: string | null; mobile?: string | null; phone?: string | null };
      const personResult = await client.query(
        `INSERT INTO people (first_name, last_name, email, mobile, phone, created_by)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING *`,
        [np.first_name, np.last_name, np.email?.toLowerCase() || null, np.mobile || null, np.phone || null, req.user!.id]
      );
      createdPerson = personResult.rows[0];
      resolvedPersonId = personResult.rows[0].id;
    }

    if (is_primary) {
      // Org-scoped exclusivity: at most one primary per organisation.
      await client.query(
        `UPDATE person_organisation_roles
         SET is_primary = false, updated_at = NOW()
         WHERE organisation_id = $1 AND status = 'active' AND is_primary = true`,
        [orgId]
      );
    }

    const roleResult = await client.query(
      `INSERT INTO person_organisation_roles (person_id, organisation_id, role, is_primary, start_date, notes)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`,
      [resolvedPersonId, orgId, role, is_primary, start_date || new Date().toISOString(), notes || null]
    );

    await client.query('COMMIT');

    if (createdPerson) {
      await logAudit(req.user!.id, 'people', resolvedPersonId, 'create', null, createdPerson);
    }
    await logAudit(req.user!.id, 'person_organisation_roles', roleResult.rows[0].id, 'create', null, roleResult.rows[0]);

    res.status(201).json({ role: roleResult.rows[0], person: createdPerson });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Add person to org error:', error);
    res.status(500).json({ error: 'Internal server error' });
  } finally {
    client.release();
  }
});

// POST /api/organisations/:id/dismiss-suggestion — hide a smart suggestion
// banner permanently for this org (e.g. "could this be a band?"). Stable
// keys are defined frontend-side; backend just stores them as opaque text
// and uses array_append-with-no-duplicates so repeated dismissals are safe.
const dismissSuggestionSchema = z.object({
  key: z.string().min(1).max(100),
});

router.post(
  '/:id/dismiss-suggestion',
  validate(dismissSuggestionSchema),
  async (req: AuthRequest, res: Response) => {
    const orgId = req.params.id as string;
    const { key } = req.body as { key: string };

    try {
      const result = await query(
        `UPDATE organisations
         SET dismissed_suggestions =
               CASE WHEN $2 = ANY(dismissed_suggestions)
                    THEN dismissed_suggestions
                    ELSE array_append(dismissed_suggestions, $2)
               END,
             updated_at = NOW()
         WHERE id = $1 AND is_deleted = false
         RETURNING dismissed_suggestions`,
        [orgId, key]
      );

      if (result.rows.length === 0) {
        res.status(404).json({ error: 'Organisation not found' });
        return;
      }

      await logAudit(req.user!.id, 'organisations', orgId, 'update', null, {
        dismissed_suggestion: key,
      });

      res.json({ dismissed_suggestions: result.rows[0].dismissed_suggestions });
    } catch (error) {
      console.error('Dismiss suggestion error:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  }
);

// PUT /api/organisations/:id/people/:roleId/primary — toggle primary contact
// Org-scoped exclusivity: at most one active role per organisation can be
// `is_primary = true`. Promoting one demotes any others on the same org.
// Demoting is allowed (zero primaries is a valid state).
const togglePrimarySchema = z.object({
  is_primary: z.boolean(),
});

router.put(
  '/:id/people/:roleId/primary',
  validate(togglePrimarySchema),
  async (req: AuthRequest, res: Response) => {
    const orgId = req.params.id as string;
    const roleId = req.params.roleId as string;
    const { is_primary } = req.body as { is_primary: boolean };

    const client = await getClient();
    try {
      await client.query('BEGIN');

      const existing = await client.query(
        `SELECT * FROM person_organisation_roles
         WHERE id = $1 AND organisation_id = $2 AND status = 'active'`,
        [roleId, orgId]
      );
      if (existing.rows.length === 0) {
        await client.query('ROLLBACK');
        res.status(404).json({ error: 'Role not found on this organisation' });
        return;
      }

      if (is_primary) {
        // Demote any other active primaries on this org first
        await client.query(
          `UPDATE person_organisation_roles
           SET is_primary = false, updated_at = NOW()
           WHERE organisation_id = $1 AND status = 'active' AND id <> $2 AND is_primary = true`,
          [orgId, roleId]
        );
      }

      const updated = await client.query(
        `UPDATE person_organisation_roles
         SET is_primary = $1, updated_at = NOW()
         WHERE id = $2
         RETURNING *`,
        [is_primary, roleId]
      );

      await client.query('COMMIT');

      await logAudit(
        req.user!.id,
        'person_organisation_roles',
        roleId,
        'update',
        existing.rows[0],
        updated.rows[0]
      );

      res.json(updated.rows[0]);
    } catch (error) {
      await client.query('ROLLBACK');
      console.error('Toggle primary error:', error);
      res.status(500).json({ error: 'Internal server error' });
    } finally {
      client.release();
    }
  }
);

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

// ============================================================================
// MERGE — combine two duplicate organisations
// ============================================================================
// Loser is `:id` in the URL. Keeper is `keep_id` in the body. Loser's FK rows
// are reassigned to keeper, scalar fields are filled where keeper is null,
// arrays are unioned, and loser is soft-deleted with a backref note.
// Always transactional — partial failure rolls back.

// GET /api/organisations/:id/merge-preview?keep_id=...
// Returns counts of what will move so the UI can show a confirmation summary.
router.get('/:id/merge-preview', authorize('admin', 'manager'), async (req: AuthRequest, res: Response) => {
  try {
    const loserId = req.params.id as string;
    const keepId = (req.query as Record<string, string>).keep_id;

    if (!keepId || keepId === loserId) {
      res.status(400).json({ error: 'Provide keep_id (must differ from :id)' });
      return;
    }

    const both = await query(
      `SELECT id, name, type, do_not_hire FROM organisations WHERE id = ANY($1) AND is_deleted = false`,
      [[loserId, keepId]]
    );
    if (both.rows.length !== 2) {
      res.status(404).json({ error: 'One or both organisations not found' });
      return;
    }
    const keeper = both.rows.find(r => r.id === keepId)!;
    const loser = both.rows.find(r => r.id === loserId)!;

    const [people, jobs, jobOrgs, venues, interactions, rels, subs, jobIssues, extIds] = await Promise.all([
      query(`SELECT COUNT(*)::int AS n FROM person_organisation_roles WHERE organisation_id = $1`, [loserId]),
      query(`SELECT COUNT(*)::int AS n FROM jobs WHERE client_id = $1`, [loserId]),
      query(`SELECT COUNT(*)::int AS n FROM job_organisations WHERE organisation_id = $1`, [loserId]),
      query(`SELECT COUNT(*)::int AS n FROM venues WHERE organisation_id = $1`, [loserId]),
      query(`SELECT COUNT(*)::int AS n FROM interactions WHERE organisation_id = $1`, [loserId]),
      query(`SELECT COUNT(*)::int AS n FROM organisation_relationships WHERE from_org_id = $1 OR to_org_id = $1`, [loserId]),
      query(`SELECT COUNT(*)::int AS n FROM organisations WHERE parent_id = $1 AND is_deleted = false`, [loserId]),
      query(`SELECT COUNT(*)::int AS n FROM job_issues WHERE client_organisation_id = $1`, [loserId]),
      query(`SELECT external_system, external_id FROM external_id_map WHERE entity_type = 'organisations' AND entity_id = ANY($1)`, [[loserId, keepId]]),
    ]);

    const keeperExt = extIds.rows.filter(r => r.external_id && r.external_id !== '').reduce((acc: Record<string, string[]>, r: { external_system: string; external_id: string }) => {
      acc[r.external_system] = acc[r.external_system] || [];
      acc[r.external_system].push(r.external_id);
      return acc;
    }, {});

    res.json({
      keeper: { id: keeper.id, name: keeper.name, type: keeper.type, do_not_hire: keeper.do_not_hire },
      loser: { id: loser.id, name: loser.name, type: loser.type, do_not_hire: loser.do_not_hire },
      counts: {
        people: people.rows[0].n,
        jobs_as_client: jobs.rows[0].n,
        job_organisation_links: jobOrgs.rows[0].n,
        venues: venues.rows[0].n,
        interactions: interactions.rows[0].n,
        relationships: rels.rows[0].n,
        child_organisations: subs.rows[0].n,
        job_issues: jobIssues.rows[0].n,
      },
      external_ids: keeperExt,
    });
  } catch (error) {
    console.error('Org merge preview error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/organisations/:id/merge — merge :id (loser) INTO body.keep_id (keeper)
router.post('/:id/merge',
  authorize('admin', 'manager'),
  validate(z.object({ keep_id: z.string().uuid() })),
  async (req: AuthRequest, res: Response) => {
    const loserId = req.params.id as string;
    const { keep_id: keepId } = req.body as { keep_id: string };

    if (keepId === loserId) {
      res.status(400).json({ error: 'keep_id must differ from :id' });
      return;
    }

    const client = await getClient();
    try {
      await client.query('BEGIN');

      // Lock both rows in a deterministic order to avoid deadlocks
      const lockOrder = [loserId, keepId].sort();
      const lockRes = await client.query(
        `SELECT * FROM organisations WHERE id = ANY($1) AND is_deleted = false ORDER BY id FOR UPDATE`,
        [lockOrder]
      );
      if (lockRes.rows.length !== 2) {
        await client.query('ROLLBACK');
        res.status(404).json({ error: 'One or both organisations not found' });
        return;
      }
      const keeper = lockRes.rows.find(r => r.id === keepId)!;
      const loser = lockRes.rows.find(r => r.id === loserId)!;

      // ── 1. Fill null scalar fields on keeper from loser ──────────────────
      const fillFields = [
        'website', 'email', 'phone', 'address', 'location', 'notes',
        'working_terms_type', 'working_terms_credit_days', 'working_terms_notes',
        'ai_summary', 'ai_research', 'parent_id',
      ];
      const updates: string[] = [];
      const params: unknown[] = [];
      let paramIndex = 1;
      for (const field of fillFields) {
        const keeperVal = keeper[field];
        const loserVal = loser[field];
        const keeperEmpty = keeperVal === null || keeperVal === undefined || keeperVal === '';
        if (keeperEmpty && loserVal !== null && loserVal !== undefined && loserVal !== '') {
          // parent_id: don't accidentally point keeper at itself or at the loser
          if (field === 'parent_id' && (loserVal === keepId || loserVal === loserId)) continue;
          updates.push(`${field} = $${paramIndex}`);
          params.push(loserVal);
          paramIndex++;
        }
      }

      // Union tags
      const keeperTags: string[] = keeper.tags || [];
      const loserTags: string[] = loser.tags || [];
      const combinedTags = [...new Set([...keeperTags, ...loserTags])];
      if (combinedTags.length > keeperTags.length) {
        updates.push(`tags = $${paramIndex}`);
        params.push(combinedTags);
        paramIndex++;
      }

      // Union files
      const keeperFiles = Array.isArray(keeper.files) ? keeper.files : [];
      const loserFiles = Array.isArray(loser.files) ? loser.files : [];
      if (loserFiles.length > 0) {
        // Dedupe by url to avoid double-listing the same file
        const seen = new Set(keeperFiles.map((f: { url?: string }) => f.url).filter(Boolean));
        const merged = [...keeperFiles];
        for (const f of loserFiles) {
          if (!f.url || !seen.has(f.url)) {
            merged.push(f);
            if (f.url) seen.add(f.url);
          }
        }
        if (merged.length > keeperFiles.length) {
          updates.push(`files = $${paramIndex}::jsonb`);
          params.push(JSON.stringify(merged));
          paramIndex++;
        }
      }

      // Append a backref note to keeper.notes so future readers can trace
      const today = new Date().toISOString().split('T')[0];
      const backrefNote = `\n[Merged from "${loser.name}" (${loserId}) on ${today} by ${req.user!.email || req.user!.id}]`;
      // If we already updated notes from null, append to that; otherwise append to existing.
      const notesIdx = updates.findIndex(u => u.startsWith('notes = '));
      if (notesIdx >= 0) {
        // We're filling notes from loser — tack the backref onto that value
        params[notesIdx] = String(params[notesIdx] || '') + backrefNote;
      } else {
        // Append to existing keeper.notes
        updates.push(`notes = COALESCE(notes, '') || $${paramIndex}`);
        params.push(backrefNote);
        paramIndex++;
      }

      updates.push(`updated_at = NOW()`);
      updates.push(`version = version + 1`);
      params.push(keepId);
      await client.query(
        `UPDATE organisations SET ${updates.join(', ')} WHERE id = $${paramIndex}`,
        params
      );

      // ── 2. Reassign all FK references from loser to keeper ───────────────

      // person_organisation_roles — no unique constraint, plain reassign
      await client.query(
        `UPDATE person_organisation_roles SET organisation_id = $1, updated_at = NOW() WHERE organisation_id = $2`,
        [keepId, loserId]
      );

      // jobs.client_id
      await client.query(
        `UPDATE jobs SET client_id = $1, updated_at = NOW() WHERE client_id = $2`,
        [keepId, loserId]
      );

      // job_organisations — UNIQUE(job_id, organisation_id, role).
      // First delete any loser rows that would collide with existing keeper rows on the same (job, role).
      await client.query(
        `DELETE FROM job_organisations
         WHERE organisation_id = $1
           AND (job_id, role) IN (
             SELECT job_id, role FROM job_organisations WHERE organisation_id = $2
           )`,
        [loserId, keepId]
      );
      // Reassign the rest
      await client.query(
        `UPDATE job_organisations SET organisation_id = $1, updated_at = NOW() WHERE organisation_id = $2`,
        [keepId, loserId]
      );

      // venues.organisation_id
      await client.query(
        `UPDATE venues SET organisation_id = $1, updated_at = NOW() WHERE organisation_id = $2`,
        [keepId, loserId]
      );

      // interactions.organisation_id
      await client.query(
        `UPDATE interactions SET organisation_id = $1 WHERE organisation_id = $2`,
        [keepId, loserId]
      );

      // organisation_relationships — UNIQUE(from, to, type, status), CHECK(from != to).
      // 1. Delete edges that would become self-referencing (loser↔keeper edges)
      await client.query(
        `DELETE FROM organisation_relationships
         WHERE (from_org_id = $1 AND to_org_id = $2)
            OR (from_org_id = $2 AND to_org_id = $1)`,
        [loserId, keepId]
      );
      // 2. Delete loser→other rows that would collide with existing keeper→same-other rows
      await client.query(
        `DELETE FROM organisation_relationships r
         WHERE r.from_org_id = $1
           AND EXISTS (
             SELECT 1 FROM organisation_relationships r2
             WHERE r2.from_org_id = $2
               AND r2.to_org_id = r.to_org_id
               AND r2.relationship_type = r.relationship_type
               AND r2.status = r.status
           )`,
        [loserId, keepId]
      );
      // 3. Same for inbound edges (other→loser collides with other→keeper)
      await client.query(
        `DELETE FROM organisation_relationships r
         WHERE r.to_org_id = $1
           AND EXISTS (
             SELECT 1 FROM organisation_relationships r2
             WHERE r2.to_org_id = $2
               AND r2.from_org_id = r.from_org_id
               AND r2.relationship_type = r.relationship_type
               AND r2.status = r.status
           )`,
        [loserId, keepId]
      );
      // 4. Reassign survivors
      await client.query(
        `UPDATE organisation_relationships SET from_org_id = $1, updated_at = NOW() WHERE from_org_id = $2`,
        [keepId, loserId]
      );
      await client.query(
        `UPDATE organisation_relationships SET to_org_id = $1, updated_at = NOW() WHERE to_org_id = $2`,
        [keepId, loserId]
      );

      // organisations.parent_id (children of loser become children of keeper)
      await client.query(
        `UPDATE organisations SET parent_id = $1, updated_at = NOW()
         WHERE parent_id = $2 AND is_deleted = false AND id != $1`,
        [keepId, loserId]
      );

      // job_issues.client_organisation_id
      await client.query(
        `UPDATE job_issues SET client_organisation_id = $1 WHERE client_organisation_id = $2`,
        [keepId, loserId]
      );

      // external_id_map — UNIQUE(entity_type, entity_id, external_system).
      // Reassign loser rows to keeper, dropping ones where keeper already has a row for that system.
      // (Keeper's existing external_id wins; loser's HH/Xero IDs that conflict are recorded in notes via backref.)
      const conflictingExtIds = await client.query(
        `SELECT l.external_system, l.external_id, k.external_id AS keeper_external_id
         FROM external_id_map l
         JOIN external_id_map k
           ON k.entity_type = 'organisations' AND k.entity_id = $1 AND k.external_system = l.external_system
         WHERE l.entity_type = 'organisations' AND l.entity_id = $2
           AND l.external_id != k.external_id`,
        [keepId, loserId]
      );
      // Drop conflicting loser rows
      await client.query(
        `DELETE FROM external_id_map
         WHERE entity_type = 'organisations' AND entity_id = $1
           AND external_system IN (
             SELECT external_system FROM external_id_map
             WHERE entity_type = 'organisations' AND entity_id = $2
           )`,
        [loserId, keepId]
      );
      // Reassign survivors
      await client.query(
        `UPDATE external_id_map SET entity_id = $1
         WHERE entity_type = 'organisations' AND entity_id = $2`,
        [keepId, loserId]
      );
      // If we dropped any conflicting external IDs, append them to keeper notes for audit
      if (conflictingExtIds.rows.length > 0) {
        const lines = conflictingExtIds.rows
          .map((r: { external_system: string; external_id: string; keeper_external_id: string }) =>
            `  - ${r.external_system}: keeper has ${r.keeper_external_id}, loser had ${r.external_id} (discarded)`)
          .join('\n');
        await client.query(
          `UPDATE organisations SET notes = COALESCE(notes, '') || $1 WHERE id = $2`,
          [`\n[External ID conflicts dropped during merge:\n${lines}\n]`, keepId]
        );
      }

      // notifications — entity references (not FK, just a string)
      await client.query(
        `UPDATE notifications SET entity_id = $1
         WHERE entity_type = 'organisations' AND entity_id = $2`,
        [keepId, loserId]
      );

      // sync_review_queue — pending review items
      await client.query(
        `UPDATE sync_review_queue SET entity_id = $1
         WHERE entity_type = 'organisation' AND entity_id = $2`,
        [keepId, loserId]
      );

      // ── 3. Soft-delete the loser with a forward-pointing note ────────────
      await client.query(
        `UPDATE organisations SET is_deleted = true,
           notes = COALESCE(notes, '') || $1,
           updated_at = NOW(), version = version + 1
         WHERE id = $2`,
        [`\n[Merged into "${keeper.name}" (${keepId}) on ${today} by ${req.user!.email || req.user!.id}]`, loserId]
      );

      await client.query('COMMIT');

      await logAudit(req.user!.id, 'organisations', loserId, 'delete' as const, loser, {
        merged_into: keepId,
        merged_into_name: keeper.name,
        external_id_conflicts: conflictingExtIds.rows,
      });
      await logAudit(req.user!.id, 'organisations', keepId, 'update' as const, keeper, {
        merged_from: loserId,
        merged_from_name: loser.name,
      });

      res.json({
        success: true,
        kept_id: keepId,
        kept_name: keeper.name,
        merged_id: loserId,
        merged_name: loser.name,
        external_id_conflicts: conflictingExtIds.rows,
        message: `Merged "${loser.name}" into "${keeper.name}"`,
      });
    } catch (error) {
      await client.query('ROLLBACK');
      console.error('Org merge error:', error);
      res.status(500).json({ error: 'Internal server error' });
    } finally {
      client.release();
    }
  }
);


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

// GET /api/organisations/:id/relationship-suggestions
// "Quick associate" cheap win: orgs connected to this one through a shared
// person (via person_organisation_roles) that aren't ALREADY directly related.
// Distinct from /:id/suggestions, which returns orgs already in a relationship.
router.get('/:id/relationship-suggestions', async (req: AuthRequest, res: Response) => {
  try {
    const result = await query(
      `SELECT DISTINCT o.id, o.name, o.type,
              p.first_name || ' ' || p.last_name AS via_person
       FROM person_organisation_roles por1
       JOIN person_organisation_roles por2
         ON por2.person_id = por1.person_id
        AND por2.organisation_id <> por1.organisation_id
       JOIN organisations o ON o.id = por2.organisation_id AND o.is_deleted = false
       JOIN people p ON p.id = por1.person_id AND p.is_deleted = false
       WHERE por1.organisation_id = $1
         AND por1.status = 'active'
         AND por2.status = 'active'
         AND o.id NOT IN (
           SELECT CASE WHEN r.from_org_id = $1 THEN r.to_org_id ELSE r.from_org_id END
           FROM organisation_relationships r
           WHERE (r.from_org_id = $1 OR r.to_org_id = $1) AND r.status = 'active'
         )
       ORDER BY o.name
       LIMIT 8`,
      [req.params.id]
    );
    res.json({ data: result.rows });
  } catch (error) {
    console.error('Get relationship suggestions error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/organisations/:id/do-not-hire — Toggle do-not-hire flag
router.post('/:id/do-not-hire', authorize('admin', 'manager'), async (req: AuthRequest, res: Response) => {
  try {
    const { do_not_hire, reason } = req.body;
    const result = await query(
      `UPDATE organisations SET
        do_not_hire = $1,
        do_not_hire_reason = $2,
        do_not_hire_set_at = CASE WHEN $1 THEN NOW() ELSE NULL END,
        do_not_hire_set_by = CASE WHEN $1 THEN $3 ELSE NULL END,
        updated_at = NOW()
      WHERE id = $4 AND is_deleted = false
      RETURNING id, do_not_hire, do_not_hire_reason`,
      [do_not_hire, do_not_hire ? (reason || null) : null, req.user?.email || 'unknown', req.params.id]
    );
    if (result.rows.length === 0) {
      res.status(404).json({ error: 'Organisation not found' });
      return;
    }
    await logAudit(req.user!.id, 'organisations', req.params.id as string, 'update', null, { do_not_hire, reason });
    res.json(result.rows[0]);
  } catch (error) {
    console.error('Do not hire error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── Hire History (all jobs linked to this org) ──────────────────────────

router.get('/:id/hire-history', async (req: AuthRequest, res: Response) => {
  try {
    const { id } = req.params;
    const page = parseInt(req.query.page as string) || 1;
    const limit = Math.min(parseInt(req.query.limit as string) || 50, 200);
    const offset = (page - 1) * limit;

    // Whitelisted sort + direction (no string interpolation of user input into SQL).
    const SORT_COLUMNS: Record<string, string> = {
      date: 'j.job_date',
      job_number: 'j.hh_job_number',
      value: 'j.job_value',
      status: 'j.pipeline_status',
    };
    const sortKey = (req.query.sort as string) || 'date';
    const sortColumn = SORT_COLUMNS[sortKey] || SORT_COLUMNS.date;
    const dir = (req.query.dir as string) === 'asc' ? 'ASC' : 'DESC';

    // Optional filters.
    const role = (req.query.role as string) || '';
    const outcome = (req.query.outcome as string) || '';
    const year = parseInt((req.query.year as string) || '', 10);

    const filterClauses: string[] = [];
    const filterParams: any[] = [];
    if (role) {
      filterParams.push(role);
      filterClauses.push(`oj.role = $${filterParams.length + 1}`); // +1 because $1 is id
    }
    if (outcome === 'confirmed') {
      filterClauses.push(`(j.pipeline_status IN ('confirmed','prepped','dispatched') OR (j.pipeline_status IS NULL AND j.status IN (2,3,4,5,8)))`);
    } else if (outcome === 'returned') {
      filterClauses.push(`(j.pipeline_status IN ('returned','returned_incomplete','completed') OR (j.pipeline_status IS NULL AND j.status IN (6,7,11)))`);
    } else if (outcome === 'open') {
      filterClauses.push(`(j.pipeline_status IN ('new_enquiry','quoting','provisional','paused','chasing') OR (j.pipeline_status IS NULL AND j.status IN (0,1)))`);
    } else if (outcome === 'lost') {
      filterClauses.push(`(j.pipeline_status IN ('lost','cancelled') OR (j.pipeline_status IS NULL AND j.status IN (9,10)))`);
    }
    if (Number.isFinite(year) && year > 1900 && year < 3000) {
      filterParams.push(year);
      filterClauses.push(`EXTRACT(YEAR FROM j.job_date) = $${filterParams.length + 1}`);
    }
    const filterSql = filterClauses.length ? ` AND ${filterClauses.join(' AND ')}` : '';

    // Use a CTE to unify jobs linked via job_organisations AND via jobs.client_id
    // This ensures hire history shows ALL jobs for the org, regardless of how the link was created.
    const jobLinkCTE = `
      WITH org_jobs AS (
        SELECT jo.job_id, jo.role
        FROM job_organisations jo
        WHERE jo.organisation_id = $1
        UNION
        SELECT j2.id AS job_id, 'client' AS role
        FROM jobs j2
        WHERE j2.client_id = $1 AND j2.is_deleted = false
          AND j2.id NOT IN (SELECT jo2.job_id FROM job_organisations jo2 WHERE jo2.organisation_id = $1)
      )`;

    // Count total (respects filters so the pagination tracks the visible list)
    const countResult = await query(
      `${jobLinkCTE}
       SELECT COUNT(*) AS total
       FROM org_jobs oj
       JOIN jobs j ON j.id = oj.job_id AND j.is_deleted = false
       WHERE 1=1${filterSql}`,
      [id, ...filterParams]
    );
    const total = parseInt(countResult.rows[0]?.total || '0');

    // Fetch jobs with retro interaction
    const limitParamIdx = filterParams.length + 2; // $1 is id; filters are $2..; then limit, offset
    const offsetParamIdx = filterParams.length + 3;
    const jobsResult = await query(
      `${jobLinkCTE}
       SELECT
         oj.role,
         j.id, j.hh_job_number, j.job_name, j.pipeline_status, j.status,
         j.job_date, j.job_end, j.return_date, j.job_value,
         j.client_name, j.company_name, j.lost_reason, j.lost_detail,
         (SELECT i.content FROM interactions i
          WHERE i.job_id = j.id AND i.content LIKE 'Job retro:%'
          ORDER BY i.created_at DESC LIMIT 1
         ) AS retro_content
       FROM org_jobs oj
       JOIN jobs j ON j.id = oj.job_id AND j.is_deleted = false
       WHERE 1=1${filterSql}
       ORDER BY ${sortColumn} ${dir} NULLS LAST, j.hh_job_number DESC
       LIMIT $${limitParamIdx} OFFSET $${offsetParamIdx}`,
      [id, ...filterParams, limit, offset]
    );

    // Compute summary stats
    const statsResult = await query(
      `${jobLinkCTE}
       SELECT
         COUNT(*) AS total_jobs,
         COUNT(*) FILTER (WHERE j.pipeline_status = 'completed' OR j.status = 11) AS completed_jobs,
         COUNT(*) FILTER (WHERE j.pipeline_status = 'confirmed' OR j.status = 2) AS confirmed_jobs,
         COUNT(*) FILTER (WHERE j.pipeline_status = 'lost') AS lost_jobs,
         COALESCE(SUM(j.job_value) FILTER (WHERE j.pipeline_status IN ('confirmed','completed','prepped','dispatched','returned','returned_incomplete') OR j.status BETWEEN 2 AND 11), 0) AS total_value
       FROM org_jobs oj
       JOIN jobs j ON j.id = oj.job_id AND j.is_deleted = false`,
      [id]
    );

    // Count retros by rating
    const retroResult = await query(
      `${jobLinkCTE}
       SELECT
         COUNT(*) FILTER (WHERE i.content LIKE 'Job retro: Great%') AS retro_great,
         COUNT(*) FILTER (WHERE i.content LIKE 'Job retro: OK%') AS retro_ok,
         COUNT(*) FILTER (WHERE i.content LIKE 'Job retro: Issues%') AS retro_issues
       FROM org_jobs oj
       JOIN jobs j ON j.id = oj.job_id AND j.is_deleted = false
       LEFT JOIN interactions i ON i.job_id = j.id AND i.content LIKE 'Job retro:%'`,
      [id]
    );

    // Distinct roles + years across the whole hire history (unfiltered) — populates filter dropdowns
    const facetsResult = await query(
      `${jobLinkCTE}
       SELECT
         (SELECT array_agg(DISTINCT oj.role ORDER BY oj.role)
            FROM org_jobs oj
            JOIN jobs j ON j.id = oj.job_id AND j.is_deleted = false
            WHERE oj.role IS NOT NULL) AS roles,
         (SELECT array_agg(DISTINCT EXTRACT(YEAR FROM j.job_date)::int ORDER BY EXTRACT(YEAR FROM j.job_date)::int DESC)
            FROM org_jobs oj
            JOIN jobs j ON j.id = oj.job_id AND j.is_deleted = false
            WHERE j.job_date IS NOT NULL) AS years`,
      [id]
    );

    // Parse retro from content string
    const jobs = jobsResult.rows.map(row => {
      let retro_rating: string | null = null;
      let retro_notes: string | null = null;
      let retro_follow_up: string | null = null;
      if (row.retro_content) {
        const lines = (row.retro_content as string).split('\n');
        const ratingLine = lines[0] || '';
        if (ratingLine.includes('Great')) retro_rating = 'great';
        else if (ratingLine.includes('Issues')) retro_rating = 'issues';
        else if (ratingLine.includes('OK')) retro_rating = 'ok';
        const noteLines: string[] = [];
        for (let i = 1; i < lines.length; i++) {
          if (lines[i].startsWith('Follow-up:')) {
            retro_follow_up = lines[i].replace('Follow-up:', '').trim() || null;
          } else if (lines[i].trim()) {
            noteLines.push(lines[i].trim());
          }
        }
        retro_notes = noteLines.length > 0 ? noteLines.join(' ') : null;
      }
      const { retro_content, ...rest } = row;
      return { ...rest, retro_rating, retro_notes, retro_follow_up };
    });

    res.json({
      data: jobs,
      stats: {
        ...statsResult.rows[0],
        ...retroResult.rows[0],
      },
      facets: {
        roles: facetsResult.rows[0]?.roles || [],
        years: facetsResult.rows[0]?.years || [],
      },
      pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
    });
  } catch (error) {
    console.error('Hire history error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
