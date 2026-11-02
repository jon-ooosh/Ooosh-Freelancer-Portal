import { Router, Response } from 'express';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { query } from '../config/database';
import { authenticate, authorize, AuthRequest, STAFF_ROLES, MANAGER_ROLES } from '../middleware/auth';
import { validate } from '../middleware/validate';
import { listAssignableStaff } from '../services/assignable-staff';
import { listTrustedDevices, resetSecondFactor, signOutEverywhere, enforcedFrom } from '../services/staff-login-security';

const router = Router();
router.use(authenticate);
// Staff only — a no-op today (only staff hold a staff token) but it keeps this
// router closed if a non-staff login shape is ever added (Oct 2026 audit).
router.use(authorize(...STAFF_ROLES));

// GET /api/users — list users (for @mention lookups, team management)
//
// `?assignable=true` returns only people who can actually be given something to
// do, via services/assignable-staff.ts — THE definition, shared with To Do's
// "For" picker so the two cannot disagree about who exists. It owns the rule
// and its fallback; do not re-derive either here.
router.get('/', async (req: AuthRequest, res: Response) => {
  try {
    if (req.query.assignable === 'true') {
      res.json({ data: await listAssignableStaff() });
      return;
    }

    const includeInactive = req.query.include_inactive === 'true';
    const whereClause = includeInactive ? '' : 'WHERE u.is_active = true';
    const result = await query(
      `SELECT u.id, u.email, u.role, u.is_active, u.last_login, u.avatar_url, u.hh_user_id,
        p.first_name, p.last_name, p.preferred_name
       FROM users u
       LEFT JOIN people p ON p.id = u.person_id
       ${whereClause}
       ORDER BY u.is_active DESC, p.first_name, p.last_name`
    );

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

// ── Login security, per person (STAFF-LOGIN-SECURITY-SPEC §3.7) ───────────
// Manager-tier, except that only an admin may touch another admin. Every write
// lands in audit_log; a reset also tells the person.

async function securityTarget(req: AuthRequest, res: Response): Promise<{ id: string; email: string; role: string; mfa_enrolled_at: Date | null } | null> {
  const r = await query(`SELECT id, email, role, mfa_enrolled_at FROM users WHERE id = $1`, [req.params.id]);
  const target = r.rows[0];
  if (!target) { res.status(404).json({ error: 'User not found' }); return null; }
  if (target.role === 'admin' && req.user!.role !== 'admin') {
    res.status(403).json({ error: "Only an admin can change an admin's login security" });
    return null;
  }
  return target;
}

// GET /api/users/:id/security — enrolment state + trusted devices
router.get('/:id/security', authorize(...MANAGER_ROLES), async (req: AuthRequest, res: Response) => {
  try {
    const target = await securityTarget(req, res);
    if (!target) return;
    const { countPasskeys } = await import('../services/staff-passkeys');
    res.json({
      passkeys: await countPasskeys(target.id),
      mfa_enrolled: !!target.mfa_enrolled_at,
      mfa_enrolled_at: target.mfa_enrolled_at,
      mfa_enforced_from: await enforcedFrom(),
      devices: await listTrustedDevices(target.id),
    });
  } catch (error) {
    console.error('User security read error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/users/:id/security/reset — wipe their second factor; next login re-enrols
router.post('/:id/security/reset', authorize(...MANAGER_ROLES), async (req: AuthRequest, res: Response) => {
  try {
    const target = await securityTarget(req, res);
    if (!target) return;
    await resetSecondFactor(target.id);
    await query(
      `INSERT INTO audit_log (user_id, entity_type, entity_id, action, new_values)
       VALUES ($1, 'users', $2, 'login_security_reset', $3)`,
      [req.user!.id, target.id, JSON.stringify({ by: req.user!.email })],
    ).catch((e) => console.warn('[users] audit insert failed:', e));
    await query(
      `INSERT INTO notifications (user_id, type, title, content, entity_type, entity_id, action_url, priority)
       VALUES ($1, 'login_security_reset', 'Your login security was reset', $2, 'users', $1, '/me?tab=profile', 'high')`,
      [target.id, `${req.user!.email} reset your second factor and signed you out of every device. Your next login will ask for an email code again.`],
    ).catch((e) => console.error('[users] reset bell failed:', e));
    res.json({ success: true });
  } catch (error) {
    console.error('User security reset error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/users/:id/security/sign-out-everywhere — refresh tokens + devices gone
router.post('/:id/security/sign-out-everywhere', authorize(...MANAGER_ROLES), async (req: AuthRequest, res: Response) => {
  try {
    const target = await securityTarget(req, res);
    if (!target) return;
    await signOutEverywhere(target.id);
    await query(
      `INSERT INTO audit_log (user_id, entity_type, entity_id, action, new_values)
       VALUES ($1, 'users', $2, 'signed_out_everywhere', $3)`,
      [req.user!.id, target.id, JSON.stringify({ by: req.user!.email })],
    ).catch((e) => console.warn('[users] audit insert failed:', e));
    res.json({ success: true });
  } catch (error) {
    console.error('User sign-out-everywhere error:', error);
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
