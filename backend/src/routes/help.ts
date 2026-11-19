import { Router, Response } from 'express';
import { z } from 'zod';
import { authenticate, AuthRequest, authorize, STAFF_ROLES } from '../middleware/auth';
import { validate } from '../middleware/validate';
import { query } from '../config/database';

// Help guides (help/README.md). The guides themselves are files bundled into the frontend;
// this is only "Something wrong or missing on this page?" — a bell for the admins, because
// a guide is corrected in the code, not edited in OP.
const router = Router();
router.use(authenticate);
router.use(authorize(...STAFF_ROLES));

const feedbackSchema = z.object({
  slug: z.string().regex(/^[a-z0-9-]{1,80}$/),
  title: z.string().min(1).max(200),
  message: z.string().min(1).max(1000),
});

router.post('/feedback', validate(feedbackSchema), async (req: AuthRequest, res: Response) => {
  try {
    const { slug, title, message } = req.body as z.infer<typeof feedbackSchema>;
    const who = await query(
      `SELECT NULLIF(TRIM(CONCAT_WS(' ', COALESCE(NULLIF(p.preferred_name, ''), p.first_name), p.last_name)), '') AS name
         FROM users u LEFT JOIN people p ON p.id = u.person_id WHERE u.id = $1`,
      [req.user!.id],
    );
    const from = who.rows[0]?.name || req.user!.email;
    await query(
      `INSERT INTO notifications (user_id, type, title, content, action_url, priority)
       SELECT u.id, 'help_feedback', $1::varchar, $2::text, $3::text, 'normal'
         FROM users u WHERE u.role = 'admin' AND u.is_active = true`,
      [`Help guide needs a look: ${title}`.slice(0, 255), `${from}: ${message}`, `/help/${slug}`],
    );
    res.json({ data: { ok: true } });
  } catch (err) {
    console.error('[help] feedback error:', err);
    res.status(500).json({ error: 'Could not send that' });
  }
});

export default router;
