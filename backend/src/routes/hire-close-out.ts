/**
 * Hire close-out (docs/HIRE-CLOSE-OUT-SPEC.md) — the money steps behind the
 * post-hire cards, one job at a time.
 *
 *   GET  /close-out/:jobId/plan      what Allocate would do (read-only)
 *   POST /close-out/:jobId/allocate  allocate hire deposits in HireHop + Xero
 *   POST /close-out/:jobId/complete  HireHop status 11 (body: allow_excess_held)
 *
 * Reading the plan is for the whole team (it is the card). Allocating moves
 * nothing out the door but commits the books, and completing ends the job,
 * so both are manager-tier (MANAGER_ROLES — includes weekend_manager).
 */
import { Router, Response } from 'express';
import { authenticate, authorize, AuthRequest, STAFF_ROLES, MANAGER_ROLES } from '../middleware/auth';
import { planHireCloseOut, runHireAllocation, completeHireJob } from '../services/hire-close-out';

const router = Router();
router.use(authenticate);

const fail = (res: Response, err: unknown, fallback: string) => {
  const msg = err instanceof Error ? err.message : fallback;
  const status = /does not exist/i.test(msg) ? 404 : /try again in a moment/i.test(msg) ? 409 : 400;
  res.status(status).json({ error: msg });
};

router.get('/:jobId/plan', authorize(...STAFF_ROLES), async (req: AuthRequest, res: Response) => {
  try {
    res.json({ data: await planHireCloseOut(String(req.params.jobId)) });
  } catch (err) {
    console.error('[close-out] plan failed:', err);
    fail(res, err, 'Could not read the job\'s money.');
  }
});

router.post('/:jobId/allocate', authorize(...MANAGER_ROLES), async (req: AuthRequest, res: Response) => {
  try {
    res.json({ data: await runHireAllocation(String(req.params.jobId), req.user?.id ?? null) });
  } catch (err) {
    console.error('[close-out] allocate failed:', err);
    fail(res, err, 'Could not allocate the payments.');
  }
});

router.post('/:jobId/complete', authorize(...MANAGER_ROLES), async (req: AuthRequest, res: Response) => {
  try {
    const allowExcessHeld = req.body?.allow_excess_held === true;
    res.json({ data: await completeHireJob(String(req.params.jobId), req.user?.id ?? null, { allowExcessHeld }) });
  } catch (err) {
    console.error('[close-out] complete failed:', err);
    fail(res, err, 'Could not complete the job.');
  }
});

export default router;
