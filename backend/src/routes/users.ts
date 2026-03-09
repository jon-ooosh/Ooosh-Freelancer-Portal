import { Router, Response } from 'express';
import { z } from 'zod';
import { query } from '../config/database';
import { authenticate, authorize, AuthRequest } from '../middleware/auth';
import { validate } from '../middleware/validate';

const router = Router();
router.use(authenticate);

// GET /api/users — list users (for @mention lookups)
router.get('/', async (req: AuthRequest, res: Response) => {
  try {
    const result = await query(
      `SELECT u.id, u.email, u.role, u.is_active,
        p.first_name, p.last_name
       FROM users u
       LEFT JOIN people p ON p.id = u.person_id
       WHERE u.is_active = true
       ORDER BY p.first_name, p.last_name`
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
  role: z.enum(['admin', 'manager', 'staff', 'general_assistant', 'weekend_manager']).optional(),
  is_active: z.boolean().optional(),
});

// PUT /api/users/:id — update a user (admin/manager only)
router.put('/:id', authorize('admin', 'manager'), validate(updateUserSchema), async (req: AuthRequest, res: Response) => {
  try {
    const { id } = req.params;
    const { first_name, last_name, email, role, is_active } = req.body;

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

    if (userUpdates.length > 0) {
      userParams.push(id);
      await query(
        `UPDATE users SET ${userUpdates.join(', ')} WHERE id = $${userParamIndex}`,
        userParams
      );
    }

    // Return updated user
    const result = await query(
      `SELECT u.id, u.email, u.role, u.is_active,
        p.first_name, p.last_name
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

export default router;
