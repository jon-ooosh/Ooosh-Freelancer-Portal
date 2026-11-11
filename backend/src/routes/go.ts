/**
 * Tracked links — the public redirect (docs/BUSINESS-FIGURES-SPEC.md §8).
 *
 *   GET /api/go/:code   count the scan, then 302 to the link's page (with campaign tags on our site)
 *
 * go.oooshtours.co.uk/<code> is this same route (nginx rewrites it). No login, no cookies,
 * nothing personal stored. An unknown or paused code goes to the home page — a printed
 * code must never dead-end.
 */
import { Router, Request, Response } from 'express';
import rateLimit from 'express-rate-limit';
import { resolveScan } from '../services/marketing';
import { FALLBACK_URL, isValidCode } from '../services/marketing-links';

const router = Router();

const scanLimiter = rateLimit({ windowMs: 60 * 1000, max: 60, standardHeaders: true, legacyHeaders: false });

router.get(['/', '/:code'], scanLimiter, async (req: Request, res: Response) => {
  const code = String(req.params.code || '').toLowerCase();
  res.set('Cache-Control', 'no-store');   // every scan must reach us to be counted
  if (!code || !isValidCode(code)) {
    res.redirect(302, FALLBACK_URL);
    return;
  }
  try {
    res.redirect(302, await resolveScan(code, req.get('user-agent')));
  } catch (err) {
    console.error('[go] redirect failed:', err);
    res.redirect(302, FALLBACK_URL);
  }
});

export default router;
