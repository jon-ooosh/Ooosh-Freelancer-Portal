import { Router, Response } from 'express';
import { query } from '../config/database';
import { authenticate, AuthRequest } from '../middleware/auth';

const router = Router();
router.use(authenticate);

// GET /api/users — list users (for @mention lookups)
router.get('/', async (req: AuthRequest, res: Response) => {
  try {
    const result = await query(
      `SELECT u.id, u.email, u.role,
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

export default router;
