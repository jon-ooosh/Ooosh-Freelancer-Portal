import { Router, Response } from 'express';
import { query } from '../config/database';
import { authenticate, AuthRequest } from '../middleware/auth';

const router = Router();
router.use(authenticate);

interface DuplicateGroup {
  match_type: string;
  score: number;
  people: Array<{
    id: string;
    first_name: string;
    last_name: string;
    email: string | null;
    mobile: string | null;
    phone: string | null;
    created_at: string;
    organisations: string[];
  }>;
}

// GET /api/duplicates — find potential duplicate people
router.get('/', async (_req: AuthRequest, res: Response) => {
  try {
    const groups: DuplicateGroup[] = [];

    // 1. Exact email matches (highest confidence)
    const emailDups = await query(`
      SELECT p.id, p.first_name, p.last_name, p.email, p.mobile, p.phone, p.created_at
      FROM people p
      WHERE p.is_deleted = false
        AND p.email IS NOT NULL
        AND p.email != ''
        AND EXISTS (
          SELECT 1 FROM people p2
          WHERE p2.id != p.id
            AND p2.is_deleted = false
            AND LOWER(p2.email) = LOWER(p.email)
        )
      ORDER BY LOWER(p.email), p.created_at
    `);

    // Group by email
    const emailGroups = new Map<string, typeof emailDups.rows>();
    for (const row of emailDups.rows) {
      const key = row.email.toLowerCase();
      if (!emailGroups.has(key)) emailGroups.set(key, []);
      emailGroups.get(key)!.push(row);
    }
    for (const people of emailGroups.values()) {
      groups.push({ match_type: 'Exact email match', score: 100, people: await enrichWithOrgs(people) });
    }

    // 2. Exact name matches (first + last, case-insensitive)
    const nameDups = await query(`
      SELECT p.id, p.first_name, p.last_name, p.email, p.mobile, p.phone, p.created_at
      FROM people p
      WHERE p.is_deleted = false
        AND EXISTS (
          SELECT 1 FROM people p2
          WHERE p2.id != p.id
            AND p2.is_deleted = false
            AND LOWER(p2.first_name) = LOWER(p.first_name)
            AND LOWER(p2.last_name) = LOWER(p.last_name)
        )
      ORDER BY LOWER(p.last_name), LOWER(p.first_name), p.created_at
    `);

    // Group by name, exclude any already found via email
    const foundIds = new Set(groups.flatMap(g => g.people.map(p => p.id)));
    const nameGroups = new Map<string, typeof nameDups.rows>();
    for (const row of nameDups.rows) {
      if (foundIds.has(row.id)) continue;
      const key = `${row.first_name.toLowerCase()}|${row.last_name.toLowerCase()}`;
      if (!nameGroups.has(key)) nameGroups.set(key, []);
      nameGroups.get(key)!.push(row);
    }
    for (const people of nameGroups.values()) {
      if (people.length >= 2) {
        groups.push({ match_type: 'Same name', score: 75, people: await enrichWithOrgs(people) });
      }
    }

    // 3. Same mobile/phone number
    const phoneDups = await query(`
      SELECT p.id, p.first_name, p.last_name, p.email, p.mobile, p.phone, p.created_at
      FROM people p
      WHERE p.is_deleted = false
        AND (p.mobile IS NOT NULL AND p.mobile != '' OR p.phone IS NOT NULL AND p.phone != '')
        AND EXISTS (
          SELECT 1 FROM people p2
          WHERE p2.id != p.id
            AND p2.is_deleted = false
            AND (
              (p.mobile IS NOT NULL AND p.mobile != '' AND (p2.mobile = p.mobile OR p2.phone = p.mobile))
              OR (p.phone IS NOT NULL AND p.phone != '' AND (p2.phone = p.phone OR p2.mobile = p.phone))
            )
        )
      ORDER BY COALESCE(p.mobile, p.phone), p.created_at
    `);

    const phoneFoundIds = new Set([...foundIds, ...groups.flatMap(g => g.people.map(p => p.id))]);
    const phoneGroups = new Map<string, typeof phoneDups.rows>();
    for (const row of phoneDups.rows) {
      if (phoneFoundIds.has(row.id)) continue;
      const key = (row.mobile || row.phone || '').replace(/\s/g, '');
      if (!key) continue;
      if (!phoneGroups.has(key)) phoneGroups.set(key, []);
      phoneGroups.get(key)!.push(row);
    }
    for (const people of phoneGroups.values()) {
      if (people.length >= 2) {
        groups.push({ match_type: 'Same phone number', score: 85, people: await enrichWithOrgs(people) });
      }
    }

    // Sort by score descending
    groups.sort((a, b) => b.score - a.score);

    res.json({ data: groups, total: groups.length });
  } catch (error) {
    console.error('Duplicate detection error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/duplicates/merge — merge two people records
router.post('/merge', async (req: AuthRequest, res: Response) => {
  try {
    const { keep_id, merge_id } = req.body;

    if (!keep_id || !merge_id || keep_id === merge_id) {
      res.status(400).json({ error: 'Provide keep_id and merge_id (must be different)' });
      return;
    }

    // Get both records
    const keepResult = await query('SELECT * FROM people WHERE id = $1 AND is_deleted = false', [keep_id]);
    const mergeResult = await query('SELECT * FROM people WHERE id = $1 AND is_deleted = false', [merge_id]);

    if (keepResult.rows.length === 0 || mergeResult.rows.length === 0) {
      res.status(404).json({ error: 'One or both people not found' });
      return;
    }

    const keep = keepResult.rows[0];
    const merge = mergeResult.rows[0];

    // Fill in any null fields on the kept record from the merged record
    const fillFields = [
      'email', 'phone', 'mobile', 'international_phone', 'notes',
      'home_address', 'date_of_birth', 'emergency_contact_name',
      'emergency_contact_phone', 'licence_details',
    ];

    const updates: string[] = [];
    const params: unknown[] = [];
    let paramIndex = 1;

    for (const field of fillFields) {
      if (!keep[field] && merge[field]) {
        updates.push(`${field} = $${paramIndex}`);
        params.push(merge[field]);
        paramIndex++;
      }
    }

    // Merge tags
    const keepTags: string[] = keep.tags || [];
    const mergeTags: string[] = merge.tags || [];
    const combinedTags = [...new Set([...keepTags, ...mergeTags])];
    if (combinedTags.length > keepTags.length) {
      updates.push(`tags = $${paramIndex}`);
      params.push(combinedTags);
      paramIndex++;
    }

    // Merge skills
    const keepSkills: string[] = keep.skills || [];
    const mergeSkills: string[] = merge.skills || [];
    const combinedSkills = [...new Set([...keepSkills, ...mergeSkills])];
    if (combinedSkills.length > keepSkills.length) {
      updates.push(`skills = $${paramIndex}`);
      params.push(combinedSkills);
      paramIndex++;
    }

    // Update kept record with merged fields
    if (updates.length > 0) {
      params.push(keep_id);
      await query(
        `UPDATE people SET ${updates.join(', ')} WHERE id = $${paramIndex}`,
        params
      );
    }

    // Move all relationships from merged to kept
    await query(
      `UPDATE person_organisation_roles SET person_id = $1 WHERE person_id = $2`,
      [keep_id, merge_id]
    );

    // Move all interactions from merged to kept
    await query(
      `UPDATE interactions SET person_id = $1 WHERE person_id = $2`,
      [keep_id, merge_id]
    );

    // Move notifications entity references
    await query(
      `UPDATE notifications SET entity_id = $1 WHERE entity_type = 'people' AND entity_id = $2`,
      [keep_id, merge_id]
    );

    // Soft-delete the merged record
    await query(
      `UPDATE people SET is_deleted = true, notes = COALESCE(notes, '') || $1 WHERE id = $2`,
      [`\n[Merged into ${keep.first_name} ${keep.last_name} on ${new Date().toISOString().split('T')[0]}]`, merge_id]
    );

    // If the merged person had a user account, reassign it
    await query(
      `UPDATE users SET person_id = $1 WHERE person_id = $2`,
      [keep_id, merge_id]
    );

    res.json({
      message: `Merged "${merge.first_name} ${merge.last_name}" into "${keep.first_name} ${keep.last_name}"`,
      kept_id: keep_id,
    });
  } catch (error) {
    console.error('Merge error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/duplicates/dismiss — mark two records as not duplicates
router.post('/dismiss', async (req: AuthRequest, res: Response) => {
  try {
    const { person_ids } = req.body;
    if (!Array.isArray(person_ids) || person_ids.length < 2) {
      res.status(400).json({ error: 'Provide person_ids array with at least 2 IDs' });
      return;
    }

    // Add a tag to both so they won't be flagged again
    for (const id of person_ids) {
      await query(
        `UPDATE people SET tags = array_append(
           CASE WHEN tags IS NULL THEN ARRAY[]::text[] ELSE tags END,
           $1
         ) WHERE id = $2 AND NOT ($1 = ANY(COALESCE(tags, ARRAY[]::text[])))`,
        [`not-duplicate:${person_ids.filter((pid: string) => pid !== id).join(',')}`, id]
      );
    }

    res.json({ success: true });
  } catch (error) {
    console.error('Dismiss error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

async function enrichWithOrgs(people: Array<{ id: string; first_name: string; last_name: string; email: string | null; mobile: string | null; phone: string | null; created_at: string }>) {
  return Promise.all(people.map(async (p) => {
    const orgs = await query(
      `SELECT o.name FROM person_organisation_roles por
       JOIN organisations o ON o.id = por.organisation_id
       WHERE por.person_id = $1 AND por.status = 'active'`,
      [p.id]
    );
    return { ...p, organisations: orgs.rows.map((o: { name: string }) => o.name) };
  }));
}

export default router;
