import { Router, Response } from 'express';
import { z } from 'zod';
import { query, getClient } from '../config/database';
import { authenticate, authorize, AuthRequest } from '../middleware/auth';
import { validate } from '../middleware/validate';
import { logAudit } from '../middleware/audit';

const router = Router();
router.use(authenticate);

// ── Sync Review Queue ─────────────────────────────────────────────────────

// GET /api/data-cleanup/reviews — list pending review items
router.get('/reviews', authorize('admin', 'manager'), async (req: AuthRequest, res: Response) => {
  try {
    const status = (req.query as Record<string, string>).status || 'pending';
    const result = await query(
      `SELECT r.*,
              CASE WHEN r.entity_type = 'organisation' THEN (SELECT name FROM organisations WHERE id = r.entity_id)
                   WHEN r.entity_type = 'person' THEN (SELECT first_name || ' ' || last_name FROM people WHERE id = r.entity_id)
                   ELSE NULL END as entity_name,
              u.email as resolved_by_email
       FROM sync_review_queue r
       LEFT JOIN users u ON r.resolved_by = u.id
       WHERE r.status = $1
       ORDER BY r.created_at DESC
       LIMIT 200`,
      [status]
    );
    res.json({ data: result.rows });
  } catch (error) {
    console.error('Fetch reviews error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/data-cleanup/reviews/count — count pending reviews (for nav badge)
router.get('/reviews/count', async (_req: AuthRequest, res: Response) => {
  try {
    const result = await query(
      `SELECT COUNT(*) as count FROM sync_review_queue WHERE status = 'pending'`
    );
    res.json({ count: parseInt(result.rows[0].count, 10) });
  } catch (error) {
    console.error('Review count error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// PATCH /api/data-cleanup/reviews/:id — resolve or dismiss a review item
router.patch('/reviews/:id', authorize('admin', 'manager'), async (req: AuthRequest, res: Response) => {
  try {
    const { id } = req.params as { id: string };
    const schema = z.object({
      status: z.enum(['resolved', 'dismissed']),
      resolution_note: z.string().optional(),
    });
    const body = schema.parse(req.body);

    await query(
      `UPDATE sync_review_queue SET status = $1, resolved_by = $2, resolved_at = NOW(), resolution_note = $3
       WHERE id = $4`,
      [body.status, req.user!.id, body.resolution_note || null, id]
    );
    res.json({ success: true });
  } catch (error) {
    console.error('Resolve review error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});


// ── Convert Person to Organisation ────────────────────────────────────────

// POST /api/data-cleanup/convert-person-to-org
// Takes a person ID, creates an organisation from it, moves relationships,
// and soft-deletes the person.
router.post('/convert-person-to-org',
  authorize('admin', 'manager'),
  validate(z.object({
    person_id: z.string().uuid(),
    org_type: z.string().min(1).default('band'),
  })),
  async (req: AuthRequest, res: Response) => {
    const { person_id, org_type } = req.body as { person_id: string; org_type: string };
    const client = await getClient();

    try {
      await client.query('BEGIN');

      // Get the person
      const personResult = await client.query(
        `SELECT * FROM people WHERE id = $1 AND is_deleted = false`,
        [person_id]
      );
      if (personResult.rows.length === 0) {
        res.status(404).json({ error: 'Person not found' });
        return;
      }
      const person = personResult.rows[0];
      const orgName = `${person.first_name} ${person.last_name}`.trim();

      // Check if org with same name already exists
      const existingOrg = await client.query(
        `SELECT id, name FROM organisations WHERE lower(name) = lower($1) AND is_deleted = false`,
        [orgName]
      );
      if (existingOrg.rows.length > 0) {
        res.status(409).json({
          error: `Organisation "${existingOrg.rows[0].name}" already exists`,
          existing_org_id: existingOrg.rows[0].id,
        });
        return;
      }

      // Create the organisation
      const orgResult = await client.query(
        `INSERT INTO organisations (name, type, phone, email, notes, tags, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         RETURNING id`,
        [orgName, org_type, person.phone || person.mobile, person.email,
         `Converted from person record. ${person.notes || ''}`.trim(),
         person.tags || [], req.user!.id]
      );
      const newOrgId = orgResult.rows[0].id;

      // Copy external_id_map entries (person → organisation)
      await client.query(
        `INSERT INTO external_id_map (entity_type, entity_id, external_system, external_id)
         SELECT 'organisations', $1, external_system, external_id
         FROM external_id_map WHERE entity_type = 'people' AND entity_id = $2
         ON CONFLICT DO NOTHING`,
        [newOrgId, person_id]
      );

      // Move interactions from person to org
      await client.query(
        `UPDATE interactions SET organisation_id = $1, person_id = NULL WHERE person_id = $2`,
        [newOrgId, person_id]
      );

      // Move job client links if this person was listed as client
      await client.query(
        `UPDATE jobs SET client_id = $1 WHERE client_id = $2`,
        [newOrgId, person_id]
      );

      // Soft-delete the person
      await client.query(
        `UPDATE people SET is_deleted = true, notes = COALESCE(notes, '') || $1, updated_at = NOW()
         WHERE id = $2`,
        [`\n[Converted to organisation: ${orgName} (${newOrgId})]`, person_id]
      );

      await client.query('COMMIT');

      await logAudit(req.user!.id, 'people', person_id, 'update' as const, person, { new_org_id: newOrgId, org_name: orgName, converted_to_org: true });

      res.json({
        success: true,
        organisation_id: newOrgId,
        organisation_name: orgName,
        message: `Converted "${orgName}" from person to ${org_type} organisation`,
      });
    } catch (error) {
      await client.query('ROLLBACK');
      console.error('Convert person to org error:', error);
      res.status(500).json({ error: 'Internal server error' });
    } finally {
      client.release();
    }
  }
);


// ── Bulk Type Correction ──────────────────────────────────────────────────

// POST /api/data-cleanup/bulk-type-update
// Update the type of multiple organisations at once.
router.post('/bulk-type-update',
  authorize('admin', 'manager'),
  validate(z.object({
    organisation_ids: z.array(z.string().uuid()).min(1).max(100),
    new_type: z.string().min(1),
  })),
  async (req: AuthRequest, res: Response) => {
    const { organisation_ids, new_type } = req.body as { organisation_ids: string[]; new_type: string };

    try {
      const result = await query(
        `UPDATE organisations SET type = $1, updated_at = NOW()
         WHERE id = ANY($2) AND is_deleted = false
         RETURNING id, name`,
        [new_type, organisation_ids]
      );

      // Audit each
      for (const row of result.rows) {
        await logAudit(req.user!.id, 'organisations', row.id, 'update', { type: 'old' }, { type: new_type });
      }

      // Resolve any pending review items for these orgs
      await query(
        `UPDATE sync_review_queue SET status = 'resolved', resolved_by = $1, resolved_at = NOW(),
                resolution_note = $2
         WHERE entity_id = ANY($3) AND status = 'pending' AND review_type = 'type_mismatch'`,
        [req.user!.id, `Bulk updated to '${new_type}'`, organisation_ids]
      );

      res.json({
        success: true,
        updated_count: result.rows.length,
        updated: result.rows,
      });
    } catch (error) {
      console.error('Bulk type update error:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  }
);


// ── Organisation Type Stats ───────────────────────────────────────────────

// GET /api/data-cleanup/org-type-stats — breakdown of org types for cleanup overview
router.get('/org-type-stats', authorize('admin', 'manager'), async (_req: AuthRequest, res: Response) => {
  try {
    const result = await query(
      `SELECT type, COUNT(*) as count
       FROM organisations WHERE is_deleted = false
       GROUP BY type ORDER BY count DESC`
    );
    res.json({ data: result.rows });
  } catch (error) {
    console.error('Org type stats error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/data-cleanup/orgs-by-type/:type — list orgs of a specific type
router.get('/orgs-by-type/:type', authorize('admin', 'manager'), async (req: AuthRequest, res: Response) => {
  try {
    const { type } = req.params as { type: string };
    const result = await query(
      `SELECT o.id, o.name, o.type, o.tags, o.created_at,
              (SELECT COUNT(*) FROM person_organisation_roles por WHERE por.organisation_id = o.id AND por.status = 'active') as people_count,
              (SELECT COUNT(*) FROM job_organisations jo WHERE jo.organisation_id = o.id) as jobs_count
       FROM organisations o
       WHERE o.type = $1 AND o.is_deleted = false
       ORDER BY o.name
       LIMIT 500`,
      [type]
    );
    res.json({ data: result.rows });
  } catch (error) {
    console.error('Orgs by type error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});


export default router;
