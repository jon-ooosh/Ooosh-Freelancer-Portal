/**
 * Wise — supplier bill payments (scaffolding).
 *
 * First cut is a READ-ONLY connectivity check so we can confirm the sandbox
 * token works (and discover the business profile id) before building the
 * create-recipient → quote → transfer flow. Admin-only — this surface will
 * grow into money movement. See docs/COSTS-PAYMENT-AUTOMATION-SPEC.md (Part 2).
 */
import { Router, Response } from 'express';
import { authenticate, authorize, AuthRequest } from '../middleware/auth';

const router = Router();
router.use(authenticate);

// Connectivity + profile discovery. Returns { configured, env, connected,
// profileId, businessProfiles } — lets staff verify the Wise creds the moment
// they're set in .env, before any of the payment flow exists.
router.get('/health', authorize('admin'), async (_req: AuthRequest, res: Response) => {
  try {
    const { wiseHealth } = await import('../config/wise');
    res.json({ data: await wiseHealth() });
  } catch (err) {
    console.error('[wise] health error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
