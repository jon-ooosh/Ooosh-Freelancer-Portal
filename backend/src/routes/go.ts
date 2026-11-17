/**
 * Tracked links — the public redirect (docs/BUSINESS-FIGURES-SPEC.md §8).
 *
 *   GET /api/go/:code   count the scan, then 302 to the link's page (with campaign tags on our site)
 *   GET /api/go/r/:code a client's personal referral link (services/referrals.ts)
 *
 * go.oooshtours.co.uk/<code> is this same route (nginx rewrites it). No login, no cookies,
 * nothing personal stored. An unknown or paused code goes to the home page — a printed
 * code must never dead-end.
 */
import { Router, Request, Response } from 'express';
import rateLimit from 'express-rate-limit';
import { resolveScan } from '../services/marketing';
import { FALLBACK_URL, isValidCode } from '../services/marketing-links';
import { resolveReferralScan } from '../services/referrals';

const router = Router();

const scanLimiter = rateLimit({ windowMs: 60 * 1000, max: 60, standardHeaders: true, legacyHeaders: false });

// A client's personal referral link (§8d): go.oooshtours.co.uk/r/<code> → the website,
// tagged ol=ref-<code> so the enquiry is linked to them. Unknown → the home page.
router.get('/r/:code', scanLimiter, async (req: Request, res: Response) => {
  const code = String(req.params.code || '').toLowerCase();
  res.set('Cache-Control', 'no-store');
  if (!/^[a-z0-9][a-z0-9-]{0,39}$/.test(code)) {
    res.redirect(302, FALLBACK_URL);
    return;
  }
  try {
    res.redirect(302, await resolveReferralScan(code, req.get('user-agent')));
  } catch (err) {
    console.error('[go] referral redirect failed:', err);
    res.redirect(302, FALLBACK_URL);
  }
});

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
