import { Router, Response } from 'express';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { query } from '../config/database';
import { authenticate, authorize, AuthRequest } from '../middleware/auth';
import { validate } from '../middleware/validate';
import { getSystemSetting } from './system-settings';

const router = Router();
router.use(authenticate);

// GET /api/users — list users (for @mention lookups, team management)
//
// `?assignable=true` narrows the list to people who can actually be given
// something to do. The users table also holds service and integration logins
// (System Service), shared-terminal logins and test accounts: they hold a role
// so automated writes are authorised, but nobody reads their inbox, so offering
// them in a "who should this go to" picker is noise at best and a reminder
// fired into the void at worst.
//
// The test for a real person is a CURRENT employment record — the same one
// services/staff-notifications.ts uses to pick approvers, and the distinction
// services/staff-employment.ts documents ("service and test accounts have
// logins but are not employees"). Deliberately not a name or email match: those
// accounts get renamed, and a hardcoded list rots silently. It also drops
// people who have LEFT, whose login may outlive them by a while.
//
// GATED ON A SETTING, and this is the important part. The test is only correct
// once staff_employment is POPULATED. Half-populated is the dangerous state:
// the filter engages on the first record and hides every colleague who hasn't
// got one yet, which is far worse than the service logins it removes. No
// threshold can tell "populated" from "half-populated" without being arbitrary,
// so a human declares it (migration 232, default OFF). Until then every picker
// behaves exactly as before.
const ASSIGNABLE_SETTING_KEY = 'assignable_users_require_employment';
const ASSIGNABLE_CLAUSE = `EXISTS (
          SELECT 1 FROM staff_employment se
           WHERE se.person_id = u.person_id
             AND se.employment_status = 'employed')`;

router.get('/', async (req: AuthRequest, res: Response) => {
  try {
    const includeInactive = req.query.include_inactive === 'true';
    const assignableOnly =
      req.query.assignable === 'true' &&
      (await getSystemSetting(ASSIGNABLE_SETTING_KEY)) === 'true';

    const runQuery = (filterAssignable: boolean) => {
      const conditions: string[] = [];
      if (!includeInactive) conditions.push('u.is_active = true');
      if (filterAssignable) conditions.push(ASSIGNABLE_CLAUSE);
      const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
      return query(
        `SELECT u.id, u.email, u.role, u.is_active, u.last_login, u.avatar_url, u.hh_user_id,
        p.first_name, p.last_name, p.preferred_name
       FROM users u
       LEFT JOIN people p ON p.id = u.person_id
       ${whereClause}
       ORDER BY u.is_active DESC, p.first_name, p.last_name`
      );
    };

    let result = await runQuery(assignableOnly);

    // Safety valve, mirroring approverUserIds() in staff-notifications.ts: an
    // EMPTY picker is a far worse failure than a slightly noisy one. If no one
    // has an employment record yet, hand back the unfiltered list and say why,
    // rather than leaving staff unable to assign anything to anybody.
    if (assignableOnly && result.rows.length === 0) {
      console.warn(
        '[users] ?assignable=true matched nobody — no active login has an ' +
        "'employed' staff_employment record. Falling back to the full list. " +
        'Set employment records up on /staff/admin to silence this.'
      );
      result = await runQuery(false);
    }

    res.json({ data: result.rows });
  } catch (error) {
    console.error('List users error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

const updateUserSchema = z.object({
  first_name: z.string().min(1).optional(),
  last_name: z.string().min(1).optional(),
  email: z.string().email().optional(),
  role: z.enum(['admin', 'manager', 'staff', 'general_assistant', 'weekend_manager', 'freelancer']).optional(),
  is_active: z.boolean().optional(),
  hh_user_id: z.number().int().positive().nullable().optional(),
});

// PUT /api/users/:id — update a user (admin/manager only)
router.put('/:id', authorize('admin', 'manager'), validate(updateUserSchema), async (req: AuthRequest, res: Response) => {
  try {
    const { id } = req.params;
    const { first_name, last_name, email, role, is_active, hh_user_id } = req.body;

    // Update person record (name)
    if (first_name || last_name) {
      const updates: string[] = [];
      const params: unknown[] = [];
      let paramIndex = 1;

      if (first_name) {
        updates.push(`first_name = $${paramIndex}`);
        params.push(first_name);
        paramIndex++;
      }
      if (last_name) {
        updates.push(`last_name = $${paramIndex}`);
        params.push(last_name);
        paramIndex++;
      }

      params.push(id);
      await query(
        `UPDATE people SET ${updates.join(', ')}
         WHERE id = (SELECT person_id FROM users WHERE id = $${paramIndex})`,
        params
      );
    }

    // Update user record (email, role, active)
    const userUpdates: string[] = [];
    const userParams: unknown[] = [];
    let userParamIndex = 1;

    if (email) {
      userUpdates.push(`email = $${userParamIndex}`);
      userParams.push(email.toLowerCase());
      userParamIndex++;

      // Also update email on the person record
      await query(
        `UPDATE people SET email = $1 WHERE id = (SELECT person_id FROM users WHERE id = $2)`,
        [email.toLowerCase(), id]
      );
    }
    if (role) {
      userUpdates.push(`role = $${userParamIndex}`);
      userParams.push(role);
      userParamIndex++;
    }
    if (is_active !== undefined) {
      userUpdates.push(`is_active = $${userParamIndex}`);
      userParams.push(is_active);
      userParamIndex++;
    }
    if (hh_user_id !== undefined) {
      userUpdates.push(`hh_user_id = $${userParamIndex}`);
      userParams.push(hh_user_id);
      userParamIndex++;
    }

    if (userUpdates.length > 0) {
      userParams.push(id);
      await query(
        `UPDATE users SET ${userUpdates.join(', ')} WHERE id = $${userParamIndex}`,
        userParams
      );
    }

    // Return updated user
    const result = await query(
      `SELECT u.id, u.email, u.role, u.is_active, u.avatar_url, u.hh_user_id,
        p.first_name, p.last_name, p.preferred_name
       FROM users u
       LEFT JOIN people p ON p.id = u.person_id
       WHERE u.id = $1`,
      [id]
    );

    res.json(result.rows[0]);
  } catch (error) {
    console.error('Update user error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

const forcePasswordSchema = z.object({
  new_password: z.string().min(8),
});

// POST /api/users/:id/force-password — admin sets a new password for a user
router.post('/:id/force-password', authorize('admin'), validate(forcePasswordSchema), async (req: AuthRequest, res: Response) => {
  try {
    const { id } = req.params;
    const { new_password } = req.body;

    const userCheck = await query('SELECT id FROM users WHERE id = $1', [id]);
    if (userCheck.rows.length === 0) {
      res.status(404).json({ error: 'User not found' });
      return;
    }

    const newHash = await bcrypt.hash(new_password, 12);
    await query(
      `UPDATE users SET password_hash = $1, force_password_change = true, password_changed_at = NOW() WHERE id = $2`,
      [newHash, id]
    );

    res.json({ success: true, message: 'Password reset. User will be prompted to change it on next login.' });
  } catch (error) {
    console.error('Force password error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── COT card register (admin-managed) ───────────────────────────────────────
// Admin sets each staff member's company card (last 4 + a friendly label). The
// cost-capture flow auto-fills the card holder + last 4 from this server-side —
// staff never type card details.

// GET /api/users/cot-cards — the register (admin only)
router.get('/cot-cards', authorize('admin'), async (_req: AuthRequest, res: Response) => {
  try {
    const result = await query(
      `SELECT u.id, u.email, u.is_active, u.cot_card_last4, u.cot_card_label,
              p.first_name, p.last_name,
              a.status AS agreement_status, c.completed_at AS agreement_completed_at
         FROM users u
         LEFT JOIN people p ON p.id = u.person_id
         LEFT JOIN staff_documents d ON d.slug = 'cot-card-agreement'
         LEFT JOIN staff_document_assignments a ON a.user_id = u.id AND a.document_id = d.id
         LEFT JOIN staff_document_completions c ON c.id = a.current_completion_id
        WHERE u.role <> 'freelancer'
        ORDER BY u.is_active DESC, p.first_name, p.last_name`
    );
    res.json({ data: result.rows });
  } catch (error) {
    console.error('List COT cards error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

const cotCardSchema = z.object({
  cot_card_last4: z.string().regex(/^\d{4}$/).nullable().optional(),
  cot_card_label: z.string().trim().max(60).nullable().optional(),
});

// PATCH /api/users/:id/cot-card — admin sets a staff member's company card
router.patch('/:id/cot-card', authorize('admin'), async (req: AuthRequest, res: Response) => {
  try {
    const parse = cotCardSchema.safeParse(req.body);
    if (!parse.success) { res.status(400).json({ error: 'Invalid input', issues: parse.error.issues }); return; }
    const { cot_card_last4, cot_card_label } = parse.data;
    const sets: string[] = [];
    const vals: unknown[] = [];
    if (cot_card_last4 !== undefined) { vals.push(cot_card_last4 || null); sets.push(`cot_card_last4 = $${vals.length}`); }
    if (cot_card_label !== undefined) { vals.push(cot_card_label || null); sets.push(`cot_card_label = $${vals.length}`); }
    if (!sets.length) { res.status(400).json({ error: 'Nothing to update' }); return; }
    vals.push(req.params.id);
    const r = await query(
      `UPDATE users SET ${sets.join(', ')} WHERE id = $${vals.length} RETURNING id, cot_card_last4, cot_card_label`,
      vals,
    );
    if (!r.rows.length) { res.status(404).json({ error: 'User not found' }); return; }
    // Issuing/updating a card seeds any COT-card-holder-targeted staff document
    // (e.g. the card Authorised User Agreement) for this user. Fire-and-forget.
    import('../services/staff-documents')
      .then((m) => m.syncCotCardHolderDocuments())
      .catch((e) => console.error('COT card doc sync failed:', e));
    res.json({ data: r.rows[0] });
  } catch (error) {
    console.error('Update COT card error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
