/**
 * Hire close-out (docs/HIRE-CLOSE-OUT-SPEC.md) — the money steps behind the
 * post-hire cards, one job at a time.
 *
 *   GET  /close-out/:jobId/plan      what Allocate would do (read-only)
 *   POST /close-out/:jobId/run            the card's button: raise the invoice if needed, then allocate (body: allow_not_returned)
 *   POST /close-out/:jobId/raise-invoice  draft → penny check → approve → Xero (body: allow_not_returned)
 *   POST /close-out/:jobId/allocate  allocate hire deposits in HireHop + Xero
 *   POST /close-out/:jobId/complete  HireHop status 11 (body: allow_excess_held)
 *   POST /close-out/:jobId/charge    a charge invoice on a COMPLETED job (body: { reason, lines: [{ type, description, amount }] })
 *
 * Reading the plan is for the whole team (it is the card). Allocating moves
 * nothing out the door but commits the books, and completing ends the job,
 * so both are manager-tier (MANAGER_ROLES — includes weekend_manager).
 */
import { Router, Response } from 'express';
import { authenticate, authorize, AuthRequest, STAFF_ROLES, MANAGER_ROLES } from '../middleware/auth';
import { planHireCloseOut, runHireAllocation, completeHireJob, raiseHireInvoice, runHireCloseOut, JOB_NOT_FOUND } from '../services/hire-close-out';
import { raiseChargeInvoice, CHARGE_TYPES, ChargeLine } from '../services/completed-charges';

const router = Router();
router.use(authenticate);

const fail = (res: Response, err: unknown, fallback: string) => {
  const msg = err instanceof Error ? err.message : fallback;
  const status = msg === JOB_NOT_FOUND ? 404 : /try again in a moment/i.test(msg) ? 409 : 400;
  res.status(status).json({ error: msg });
};

router.get('/:jobId/plan', authorize(...STAFF_ROLES), async (req: AuthRequest, res: Response) => {
  try {
    res.json({ data: await planHireCloseOut(String(req.params.jobId), { fresh: req.query.fresh === '1' }) });
  } catch (err) {
    console.error('[close-out] plan failed:', err);
    fail(res, err, 'Could not read the job\'s money.');
  }
});

router.post('/:jobId/run', authorize(...MANAGER_ROLES), async (req: AuthRequest, res: Response) => {
  try {
    const allowNotReturned = req.body?.allow_not_returned === true;
    res.json({ data: await runHireCloseOut(String(req.params.jobId), req.user?.id ?? null, { allowNotReturned }) });
  } catch (err) {
    console.error('[close-out] run failed:', err);
    fail(res, err, 'Could not finish the job\'s money.');
  }
});

router.post('/:jobId/raise-invoice', authorize(...MANAGER_ROLES), async (req: AuthRequest, res: Response) => {
  try {
    const allowNotReturned = req.body?.allow_not_returned === true;
    res.json({ data: await raiseHireInvoice(String(req.params.jobId), req.user?.id ?? null, { allowNotReturned }) });
  } catch (err) {
    console.error('[close-out] raise-invoice failed:', err);
    fail(res, err, 'Could not raise the invoice.');
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

// A charge after completion (spec §4.6) — money billed to the client, so manager-tier.
// The PCN module raises its own through the same service. Only Misc income from here.
router.post('/:jobId/charge', authorize(...MANAGER_ROLES), async (req: AuthRequest, res: Response) => {
  try {
    const raw = Array.isArray(req.body?.lines) ? req.body.lines : [];
    const lines: ChargeLine[] = raw.slice(0, 5).map((l: any) => ({
      type: (l?.type in CHARGE_TYPES ? l.type : 'misc') as ChargeLine['type'],
      description: String(l?.description ?? '').slice(0, 200),
      amount: Number(l?.amount),
    }));
    if (lines.some((l) => l.type !== 'misc')) {
      res.status(400).json({ error: 'Only Misc income charges are raised here — PCN charges come from the PCN.' });
      return;
    }
    res.json({ data: await raiseChargeInvoice(String(req.params.jobId), req.user?.id ?? null,
      { lines, reason: String(req.body?.reason ?? '').slice(0, 500) }) });
  } catch (err) {
    console.error('[close-out] charge failed:', err);
    fail(res, err, 'Could not raise the charge.');
  }
});

export default router;
