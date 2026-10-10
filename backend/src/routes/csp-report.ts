/**
 * POST /api/csp-report — where the browser sends Content-Security-Policy
 * violation reports (SECURITY-AUDIT-BRIEF B.1, Oct 2026).
 *
 * PUBLIC, no auth: the browser posts these on its own, with no token. The
 * policy itself is set by nginx (deploy/nginx-ooosh-portal.conf) and starts
 * as Report-Only, so nothing is blocked — this route is how we learn what the
 * policy would break before it is enforced. Reports land in the service log
 * (journalctl -u ooosh-portal | grep csp-report).
 *
 * Browsers send the legacy `application/csp-report` body or the newer
 * `application/reports+json`; express.json() is told to accept both. Nothing
 * from the body is trusted or stored — it is logged, truncated, and dropped.
 */
import express, { Router, Request, Response } from 'express';
import rateLimit from 'express-rate-limit';

const router = Router();

const reportLimiter = rateLimit({
  windowMs: 60_000,
  max: 60,
  message: { error: 'Too many reports' },
  standardHeaders: true,
  legacyHeaders: false,
});

router.post(
  '/',
  reportLimiter,
  express.json({ type: ['application/json', 'application/csp-report', 'application/reports+json'], limit: '20kb' }),
  (req: Request, res: Response) => {
    const body = req.body as unknown;
    // Legacy shape: { "csp-report": {...} }. Reporting API shape: [{ body: {...} }].
    const reports: unknown[] = Array.isArray(body)
      ? body.map((r) => (r && typeof r === 'object' && 'body' in r ? (r as { body: unknown }).body : r))
      : [body && typeof body === 'object' && 'csp-report' in body ? (body as Record<string, unknown>)['csp-report'] : body];
    for (const r of reports) {
      const o = (r && typeof r === 'object' ? r : {}) as Record<string, unknown>;
      // Both shapes use kebab-case keys; pick the few that say what was blocked.
      const line = {
        directive: o['effective-directive'] ?? o['effectiveDirective'] ?? o['violated-directive'],
        blocked: o['blocked-uri'] ?? o['blockedURL'],
        page: o['document-uri'] ?? o['documentURL'],
        sample: o['script-sample'] ?? o['sample'],
        disposition: o['disposition'],
      };
      console.warn('[csp-report]', JSON.stringify(line).slice(0, 600));
    }
    res.status(204).end();
  },
);

export default router;
