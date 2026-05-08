import { Router, Response } from 'express';
import { z } from 'zod';
import { query } from '../config/database';
import { authenticate, authorize, AuthRequest } from '../middleware/auth';
import { validate } from '../middleware/validate';
import { logAudit } from '../middleware/audit';

const router = Router();

// All people routes require authentication
router.use(authenticate);

const fileSchema = z.object({
  name: z.string(),
  url: z.string().url(),
  type: z.enum(['document', 'image', 'other']),
  uploaded_at: z.string(),
  uploaded_by: z.string(),
});

const createPersonSchema = z.object({
  first_name: z.string().min(1).max(255),
  last_name: z.string().min(1).max(255),
  email: z.string().email().optional().nullable(),
  phone: z.string().max(50).optional().nullable(),
  mobile: z.string().max(50).optional().nullable(),
  international_phone: z.string().max(50).optional().nullable(),
  notes: z.string().optional().nullable(),
  tags: z.array(z.string()).optional().default([]),
  files: z.array(fileSchema).optional().default([]),
  preferred_contact_method: z.enum(['email', 'phone', 'mobile', 'whatsapp']).optional().default('email'),
  home_address: z.string().optional().nullable(),
  date_of_birth: z.string().optional().nullable(),
  // Freelancer fields
  is_freelancer: z.boolean().optional().default(false),
  freelancer_joined_date: z.string().optional().nullable(),
  freelancer_next_review_date: z.string().optional().nullable(),
  skills: z.array(z.string()).optional().default([]),
  is_insured_on_vehicles: z.boolean().optional().default(false),
  is_approved: z.boolean().optional().default(false),
  has_tshirt: z.boolean().optional().default(false),
  emergency_contact_name: z.string().max(255).optional().nullable(),
  emergency_contact_phone: z.string().max(50).optional().nullable(),
  licence_details: z.string().optional().nullable(),
  freelancer_references: z.string().optional().nullable(),
  // Working terms
  working_terms_type: z.enum(['usual', 'flex_balance', 'no_deposit', 'credit', 'custom']).optional().nullable(),
  working_terms_credit_days: z.number().int().optional().nullable(),
  working_terms_notes: z.string().optional().nullable(),
  // AI text fields
  ai_summary: z.string().optional().nullable(),
  ai_research: z.string().optional().nullable(),
});

const updatePersonSchema = createPersonSchema.partial();

const personOrgRoleSchema = z.object({
  organisation_id: z.string().uuid(),
  role: z.string().min(1),
  is_primary: z.boolean().default(false),
  start_date: z.string().optional().nullable(),
  notes: z.string().optional().nullable(),
});

// GET /api/people — list with search and pagination
router.get('/', async (req: AuthRequest, res: Response) => {
  try {
    const {
      search, page = '1', limit = '50', tag,
      is_freelancer, is_approved, is_insured, has_tshirt,
      has_email, has_phone, missing_email, missing_phone,
      location, sort, review_status, skills_any,
    } = req.query;
    const offset = (parseInt(page as string) - 1) * parseInt(limit as string);

    let sql = `
      SELECT p.*,
        (SELECT json_agg(json_build_object(
          'id', por.id,
          'organisation_id', por.organisation_id,
          'organisation_name', o.name,
          'role', por.role,
          'status', por.status,
          'is_primary', por.is_primary
        )) FROM person_organisation_roles por
        JOIN organisations o ON o.id = por.organisation_id
        WHERE por.person_id = p.id AND por.status = 'active'
        ) as current_organisations,
        (SELECT MAX(i.created_at) FROM interactions i WHERE i.person_id = p.id) as last_interaction_at
      FROM people p
      WHERE p.is_deleted = false
    `;
    const params: unknown[] = [];
    let paramIndex = 1;

    if (search) {
      sql += ` AND (
        p.first_name ILIKE $${paramIndex} OR
        p.last_name ILIKE $${paramIndex} OR
        p.email ILIKE $${paramIndex} OR
        CONCAT(p.first_name, ' ', p.last_name) ILIKE $${paramIndex}
      )`;
      params.push(`%${search}%`);
      paramIndex++;
    }

    if (tag) {
      sql += ` AND $${paramIndex} = ANY(p.tags)`;
      params.push(tag);
      paramIndex++;
    }

    if (is_freelancer === 'true') {
      sql += ` AND p.is_freelancer = true`;
    }

    if (is_approved === 'true') {
      sql += ` AND p.is_approved = true`;
    }

    if (is_insured === 'true') {
      sql += ` AND p.is_insured_on_vehicles = true`;
    }

    if (has_tshirt === 'true') {
      sql += ` AND p.has_tshirt = true`;
    }

    // Freelancer review status — only relevant when listing freelancers
    if (review_status === 'overdue') {
      sql += ` AND p.freelancer_next_review_date IS NOT NULL AND p.freelancer_next_review_date::date < CURRENT_DATE`;
    } else if (review_status === 'due_soon') {
      sql += ` AND p.freelancer_next_review_date::date BETWEEN CURRENT_DATE AND CURRENT_DATE + INTERVAL '30 days'`;
    } else if (review_status === 'ok') {
      sql += ` AND p.freelancer_next_review_date::date > CURRENT_DATE + INTERVAL '30 days'`;
    } else if (review_status === 'none') {
      sql += ` AND p.freelancer_next_review_date IS NULL`;
    }

    // Skills filter — match any selected skill (OR semantics)
    if (skills_any && typeof skills_any === 'string' && skills_any.trim()) {
      const skillList = skills_any.split(',').map((s) => s.trim()).filter(Boolean);
      if (skillList.length > 0) {
        sql += ` AND p.skills && $${paramIndex}::text[]`;
        params.push(skillList);
        paramIndex++;
      }
    }

    if (has_email === 'true') {
      sql += ` AND p.email IS NOT NULL AND p.email != ''`;
    }

    if (has_phone === 'true') {
      sql += ` AND (p.mobile IS NOT NULL AND p.mobile != '' OR p.phone IS NOT NULL AND p.phone != '')`;
    }

    if (missing_email === 'true') {
      sql += ` AND (p.email IS NULL OR p.email = '')`;
    }

    if (missing_phone === 'true') {
      sql += ` AND (p.mobile IS NULL OR p.mobile = '') AND (p.phone IS NULL OR p.phone = '')`;
    }

    if (location) {
      sql += ` AND p.location ILIKE $${paramIndex}`;
      params.push(`%${location}%`);
      paramIndex++;
    }

    // Count total
    const countResult = await query(
      sql.replace(/SELECT p\.\*.*FROM people p/s, 'SELECT COUNT(*) FROM people p'),
      params
    );
    const total = parseInt(countResult.rows[0].count);

    // Sort
    const sortMap: Record<string, string> = {
      'name': 'p.last_name, p.first_name',
      'recently_added': 'p.created_at DESC',
      'recently_updated': 'p.updated_at DESC',
      'last_contacted': '(SELECT MAX(i.created_at) FROM interactions i WHERE i.person_id = p.id) DESC NULLS LAST',
      'review_due': 'p.freelancer_next_review_date ASC NULLS LAST',
    };
    const orderBy = sortMap[sort as string] || 'p.last_name, p.first_name';

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
    console.error('List people error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/people/skills — distinct skills across all freelancers
// Used to populate the skills multi-select on the People page.
router.get('/skills', async (_req: AuthRequest, res: Response) => {
  try {
    const result = await query(
      `SELECT DISTINCT TRIM(skill) AS skill
       FROM people, UNNEST(skills) AS skill
       WHERE is_freelancer = true AND is_deleted = false
         AND skill IS NOT NULL AND TRIM(skill) <> ''
       ORDER BY skill`
    );
    res.json({ data: result.rows.map((r: { skill: string }) => r.skill) });
  } catch (error) {
    console.error('List skills error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/people/check-email — check if email already exists
router.get('/check-email', async (req: AuthRequest, res: Response) => {
  try {
    const { email, exclude_id } = req.query;
    if (!email || typeof email !== 'string') {
      res.json({ exists: false });
      return;
    }

    let sql = `SELECT id, first_name, last_name FROM people WHERE LOWER(email) = LOWER($1) AND is_deleted = false`;
    const params: unknown[] = [email.trim()];

    if (exclude_id && typeof exclude_id === 'string') {
      sql += ` AND id != $2`;
      params.push(exclude_id);
    }

    sql += ` LIMIT 1`;
    const result = await query(sql, params);

    if (result.rows.length > 0) {
      const match = result.rows[0];
      res.json({
        exists: true,
        match: {
          id: match.id,
          name: `${match.first_name} ${match.last_name}`,
        },
      });
    } else {
      res.json({ exists: false });
    }
  } catch (error) {
    console.error('Check email error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/people/:id — single person with full details
router.get('/:id', async (req: AuthRequest, res: Response) => {
  try {
    const result = await query(
      `SELECT p.*,
        (SELECT json_agg(json_build_object(
          'id', por.id,
          'organisation_id', por.organisation_id,
          'organisation_name', o.name,
          'organisation_type', o.type,
          'role', por.role,
          'status', por.status,
          'is_primary', por.is_primary,
          'start_date', por.start_date,
          'end_date', por.end_date,
          'notes', por.notes
        ) ORDER BY por.status, por.start_date DESC)
        FROM person_organisation_roles por
        JOIN organisations o ON o.id = por.organisation_id
        WHERE por.person_id = p.id
        ) as organisations
      FROM people p
      WHERE p.id = $1 AND p.is_deleted = false`,
      [req.params.id]
    );

    if (result.rows.length === 0) {
      res.status(404).json({ error: 'Person not found' });
      return;
    }

    res.json(result.rows[0]);
  } catch (error) {
    console.error('Get person error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/people — create
router.post('/', validate(createPersonSchema), async (req: AuthRequest, res: Response) => {
  try {
    const {
      first_name, last_name, email, phone, mobile, international_phone,
      notes, tags, files, preferred_contact_method, home_address, date_of_birth,
      is_freelancer, freelancer_joined_date, freelancer_next_review_date,
      skills, is_insured_on_vehicles, is_approved, has_tshirt,
      emergency_contact_name, emergency_contact_phone, licence_details, freelancer_references,
      working_terms_type, working_terms_credit_days, working_terms_notes,
    } = req.body;

    // Default working terms to 'usual' when not explicitly set
    const effectiveWorkingTerms = working_terms_type ?? 'usual';

    const result = await query(
      `INSERT INTO people (
        first_name, last_name, email, phone, mobile, international_phone,
        notes, tags, files, preferred_contact_method, home_address, date_of_birth,
        is_freelancer, freelancer_joined_date, freelancer_next_review_date,
        skills, is_insured_on_vehicles, is_approved, has_tshirt,
        emergency_contact_name, emergency_contact_phone, licence_details, freelancer_references,
        working_terms_type, working_terms_credit_days, working_terms_notes,
        created_by
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27)
       RETURNING *`,
      [
        first_name, last_name, email?.toLowerCase(), phone, mobile, international_phone,
        notes, tags, JSON.stringify(files), preferred_contact_method, home_address, date_of_birth,
        is_freelancer, freelancer_joined_date || null, freelancer_next_review_date || null,
        skills, is_insured_on_vehicles, is_approved, has_tshirt,
        emergency_contact_name, emergency_contact_phone, licence_details, freelancer_references,
        effectiveWorkingTerms, working_terms_credit_days ?? null, working_terms_notes ?? null,
        req.user!.id,
      ]
    );

    await logAudit(req.user!.id, 'people', result.rows[0].id, 'create', null, result.rows[0]);

    res.status(201).json(result.rows[0]);
  } catch (error) {
    console.error('Create person error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// PUT /api/people/:id — update
router.put('/:id', validate(updatePersonSchema), async (req: AuthRequest, res: Response) => {
  try {
    // Get current values for audit
    const current = await query('SELECT * FROM people WHERE id = $1 AND is_deleted = false', [req.params.id]);
    if (current.rows.length === 0) {
      res.status(404).json({ error: 'Person not found' });
      return;
    }

    // Optimistic locking: if client sends version, check it matches
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

    // Build WHERE clause with optional version check
    let whereClause = `id = $${values.length} AND is_deleted = false`;
    if (clientVersion !== undefined) {
      values.push(clientVersion);
      whereClause += ` AND version = $${values.length}`;
    }

    const result = await query(
      `UPDATE people SET ${setClauses.join(', ')} WHERE ${whereClause} RETURNING *`,
      values
    );

    if (result.rows.length === 0 && clientVersion !== undefined) {
      res.status(409).json({ error: 'This record was modified by someone else. Please reload and try again.' });
      return;
    }

    await logAudit(req.user!.id, 'people', req.params.id as string, 'update', current.rows[0], result.rows[0]);

    res.json(result.rows[0]);
  } catch (error) {
    console.error('Update person error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// DELETE /api/people/:id — soft delete
router.delete('/:id', authorize('admin', 'manager'), async (req: AuthRequest, res: Response) => {
  try {
    const current = await query('SELECT * FROM people WHERE id = $1 AND is_deleted = false', [req.params.id]);
    if (current.rows.length === 0) {
      res.status(404).json({ error: 'Person not found' });
      return;
    }

    await query('UPDATE people SET is_deleted = true, updated_at = NOW() WHERE id = $1', [req.params.id]);
    await logAudit(req.user!.id, 'people', req.params.id as string, 'delete', current.rows[0], null);

    res.status(204).send();
  } catch (error) {
    console.error('Delete person error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/people/:id/roles — add organisation role
router.post('/:id/roles', validate(personOrgRoleSchema), async (req: AuthRequest, res: Response) => {
  try {
    const { organisation_id, role, is_primary, start_date, notes } = req.body;

    // If setting as primary, unset any other primary on the SAME organisation
    // (org-scoped exclusivity — at most one primary contact per org).
    if (is_primary) {
      await query(
        `UPDATE person_organisation_roles
         SET is_primary = false, updated_at = NOW()
         WHERE organisation_id = $1 AND status = 'active' AND is_primary = true`,
        [organisation_id]
      );
    }

    const result = await query(
      `INSERT INTO person_organisation_roles (person_id, organisation_id, role, is_primary, start_date, notes)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`,
      [req.params.id, organisation_id, role, is_primary, start_date || new Date().toISOString(), notes]
    );

    await logAudit(req.user!.id, 'person_organisation_roles', result.rows[0].id, 'create', null, result.rows[0]);

    res.status(201).json(result.rows[0]);
  } catch (error) {
    console.error('Add role error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// PUT /api/people/:id/roles/:roleId/end — end a role (marks as historical)
router.put('/:id/roles/:roleId/end', async (req: AuthRequest, res: Response) => {
  try {
    const current = await query(
      'SELECT * FROM person_organisation_roles WHERE id = $1 AND person_id = $2',
      [req.params.roleId, req.params.id]
    );

    if (current.rows.length === 0) {
      res.status(404).json({ error: 'Role not found' });
      return;
    }

    const result = await query(
      `UPDATE person_organisation_roles
       SET status = 'historical', end_date = NOW(), is_primary = false, updated_at = NOW()
       WHERE id = $1 RETURNING *`,
      [req.params.roleId]
    );

    await logAudit(req.user!.id, 'person_organisation_roles', req.params.roleId as string, 'update', current.rows[0], result.rows[0]);

    // NOTE: Phase 5 — trigger relationship movement detection alert here

    res.json(result.rows[0]);
  } catch (error) {
    console.error('End role error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/people/:id/do-not-hire — Toggle do-not-hire flag
router.post('/:id/do-not-hire', authorize('admin', 'manager'), async (req: AuthRequest, res: Response) => {
  try {
    const { do_not_hire, reason } = req.body;
    const result = await query(
      `UPDATE people SET
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
      res.status(404).json({ error: 'Person not found' });
      return;
    }
    await logAudit(req.user!.id, 'people', req.params.id as string, 'update', null, { do_not_hire, reason });
    res.json(result.rows[0]);
  } catch (error) {
    console.error('Do not hire error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── Hire History (jobs linked via org memberships + crew assignments) ────

router.get('/:id/hire-history', async (req: AuthRequest, res: Response) => {
  try {
    const { id } = req.params;
    const page = parseInt(req.query.page as string) || 1;
    const limit = Math.min(parseInt(req.query.limit as string) || 50, 200);
    const offset = (page - 1) * limit;

    // Whitelisted sort + direction
    const SORT_COLUMNS: Record<string, string> = {
      date: 'pj.job_date',
      job_number: 'pj.hh_job_number',
      value: 'pj.job_value',
      status: 'pj.pipeline_status',
    };
    const sortKey = (req.query.sort as string) || 'date';
    const sortColumn = SORT_COLUMNS[sortKey] || SORT_COLUMNS.date;
    const dir = (req.query.dir as string) === 'asc' ? 'ASC' : 'DESC';

    // Optional filters
    const role = (req.query.role as string) || '';
    const linkType = (req.query.link_type as string) || ''; // 'organisation' | 'crew'
    const outcome = (req.query.outcome as string) || '';
    const year = parseInt((req.query.year as string) || '', 10);

    const filterClauses: string[] = [];
    const filterParams: any[] = [];
    if (role) {
      filterParams.push(role);
      filterClauses.push(`pj.link_role = $${filterParams.length + 1}`);
    }
    if (linkType === 'organisation' || linkType === 'crew') {
      filterParams.push(linkType);
      filterClauses.push(`pj.link_type = $${filterParams.length + 1}`);
    }
    if (outcome === 'confirmed') {
      filterClauses.push(`(pj.pipeline_status IN ('confirmed','prepped','dispatched') OR (pj.pipeline_status IS NULL AND pj.status IN (2,3,4,5,8)))`);
    } else if (outcome === 'returned') {
      filterClauses.push(`(pj.pipeline_status IN ('returned','returned_incomplete','completed') OR (pj.pipeline_status IS NULL AND pj.status IN (6,7,11)))`);
    } else if (outcome === 'open') {
      filterClauses.push(`(pj.pipeline_status IN ('new_enquiry','quoting','provisional','paused','chasing') OR (pj.pipeline_status IS NULL AND pj.status IN (0,1)))`);
    } else if (outcome === 'lost') {
      filterClauses.push(`(pj.pipeline_status IN ('lost','cancelled') OR (pj.pipeline_status IS NULL AND pj.status IN (9,10)))`);
    }
    if (Number.isFinite(year) && year > 1900 && year < 3000) {
      filterParams.push(year);
      filterClauses.push(`EXTRACT(YEAR FROM pj.job_date) = $${filterParams.length + 1}`);
    }
    const filterSql = filterClauses.length ? ` WHERE ${filterClauses.join(' AND ')}` : '';

    const personJobsCTE = `
      WITH person_jobs AS (
        -- Jobs via organisation links
        SELECT DISTINCT j.id, j.hh_job_number, j.job_name, j.pipeline_status, j.status,
               j.job_date, j.job_end, j.return_date, j.job_value,
               j.client_name, j.company_name, j.lost_reason, j.lost_detail,
               jo.role AS link_role, o.name AS link_org_name,
               'organisation' AS link_type
        FROM person_organisation_roles por
        JOIN job_organisations jo ON jo.organisation_id = por.organisation_id
        JOIN jobs j ON j.id = jo.job_id AND j.is_deleted = false
        LEFT JOIN organisations o ON o.id = por.organisation_id
        WHERE por.person_id = $1

        UNION

        -- Jobs via crew assignments
        SELECT DISTINCT j.id, j.hh_job_number, j.job_name, j.pipeline_status, j.status,
               j.job_date, j.job_end, j.return_date, j.job_value,
               j.client_name, j.company_name, j.lost_reason, j.lost_detail,
               qa.role AS link_role, NULL AS link_org_name,
               'crew' AS link_type
        FROM quote_assignments qa
        JOIN quotes q ON q.id = qa.quote_id
        JOIN jobs j ON j.id = q.job_id AND j.is_deleted = false
        WHERE qa.person_id = $1 AND qa.status != 'cancelled'
      )`;

    // Fetch jobs (paginated, filtered, sorted)
    const limitParamIdx = filterParams.length + 2;
    const offsetParamIdx = filterParams.length + 3;
    const jobsResult = await query(
      `${personJobsCTE}
       SELECT pj.*,
              (SELECT i.content FROM interactions i
               WHERE i.job_id = pj.id AND i.content LIKE 'Job retro:%'
               ORDER BY i.created_at DESC LIMIT 1
              ) AS retro_content
       FROM person_jobs pj${filterSql}
       ORDER BY ${sortColumn} ${dir} NULLS LAST, pj.hh_job_number DESC
       LIMIT $${limitParamIdx} OFFSET $${offsetParamIdx}`,
      [id, ...filterParams, limit, offset]
    );

    // Count total (filtered)
    const countResult = await query(
      `${personJobsCTE}
       SELECT COUNT(*) AS total FROM person_jobs pj${filterSql}`,
      [id, ...filterParams]
    );
    const total = parseInt(countResult.rows[0]?.total || '0');

    // Stats — always full hire history (unfiltered) so headline cards aren't misleading
    const statsResult = await query(
      `${personJobsCTE}
       SELECT
         COUNT(*) AS total_jobs,
         COUNT(*) FILTER (WHERE pj.pipeline_status = 'completed' OR pj.status = 11) AS completed_jobs,
         COUNT(*) FILTER (WHERE pj.pipeline_status = 'confirmed' OR pj.status = 2) AS confirmed_jobs,
         COUNT(*) FILTER (WHERE pj.pipeline_status = 'lost') AS lost_jobs,
         COALESCE(SUM(pj.job_value) FILTER (WHERE pj.pipeline_status IN ('confirmed','completed','prepped','dispatched','returned','returned_incomplete') OR pj.status BETWEEN 2 AND 11), 0) AS total_value
       FROM person_jobs pj`,
      [id]
    );

    // Retro counts (unfiltered)
    const retroResult = await query(
      `${personJobsCTE}
       SELECT
         COUNT(*) FILTER (WHERE i.content LIKE 'Job retro: Great%') AS retro_great,
         COUNT(*) FILTER (WHERE i.content LIKE 'Job retro: OK%') AS retro_ok,
         COUNT(*) FILTER (WHERE i.content LIKE 'Job retro: Issues%') AS retro_issues
       FROM person_jobs pj
       LEFT JOIN interactions i ON i.job_id = pj.id AND i.content LIKE 'Job retro:%'`,
      [id]
    );

    // Distinct roles + years (unfiltered) for dropdown population
    const facetsResult = await query(
      `${personJobsCTE}
       SELECT
         (SELECT array_agg(DISTINCT pj2.link_role ORDER BY pj2.link_role)
            FROM person_jobs pj2 WHERE pj2.link_role IS NOT NULL) AS roles,
         (SELECT array_agg(DISTINCT EXTRACT(YEAR FROM pj2.job_date)::int ORDER BY EXTRACT(YEAR FROM pj2.job_date)::int DESC)
            FROM person_jobs pj2 WHERE pj2.job_date IS NOT NULL) AS years`,
      [id]
    );

    // Parse retro
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
    console.error('Person hire history error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
