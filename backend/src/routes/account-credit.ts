import { Router, Response } from 'express';
import { z } from 'zod';
import { authenticate, AuthRequest, authorize, STAFF_ROLES, MANAGER_ROLES } from '../middleware/auth';
import { validate } from '../middleware/validate';
import { logAudit } from '../middleware/audit';
import { planHireCloseOut, JOB_NOT_FOUND } from '../services/hire-close-out';
import { clearRefundRemindersHeld, syncRefundReminder } from '../services/cancellation-close';
import {
  holdOnAccount, releaseHold, reserveOnJob, unreserve, listForContext, listForOrganisation, AccountCreditError,
} from '../services/account-credit';

// Credit on account (docs/CREDIT-ON-ACCOUNT-SPEC.md): a client's overpayment kept for
// their next hire. Nothing here touches HireHop or Xero, so any staff role may hold it
// and put it aside for a job; taking a hold or a reservation back off is a manager's.
// All logic lives in services/account-credit.ts.
const router = Router();
router.use(authenticate);
router.use(authorize(...STAFF_ROLES));

const uuid = z.string().guid();
const isUuid = (v: unknown): v is string => typeof v === 'string' && /^[0-9a-f-]{36}$/i.test(v);

function fail(res: Response, err: unknown, what: string) {
  if (err instanceof AccountCreditError) { res.status(err.status).json({ error: err.message }); return; }
  if (err instanceof Error && err.message === JOB_NOT_FOUND) { res.status(404).json({ error: err.message }); return; }
  console.error(`[account-credit] ${what} error:`, err);
  res.status(500).json({ error: 'Internal server error' });
}

// The Client History note: ?organisation_id= (the job's CLIENT) &job_id= (a saved job)
router.get('/context', async (req: AuthRequest, res: Response) => {
  try {
    res.json({ data: await listForContext({
      organisationId: isUuid(req.query.organisation_id) ? req.query.organisation_id : null,
      jobId: isUuid(req.query.job_id) ? req.query.job_id : null,
    }) });
  } catch (err) { fail(res, err, 'context'); }
});

// ?organisation_id= — everything ever held for a client (their page)
router.get('/', async (req: AuthRequest, res: Response) => {
  try {
    if (!isUuid(req.query.organisation_id)) { res.status(400).json({ error: 'organisation_id required' }); return; }
    res.json({ data: await listForOrganisation(req.query.organisation_id) });
  } catch (err) { fail(res, err, 'list'); }
});

// "Hold on account" — the job's whole unallocated amount, read from HireHop now.
// Answers with the fresh close-out plan so the Money tab redraws from one read.
router.post('/hold', validate(z.object({ job_id: uuid, note: z.string().max(500).nullable().optional() })), async (req: AuthRequest, res: Response) => {
  try {
    const plan = await planHireCloseOut(req.body.job_id, { fresh: true });
    const credit = await holdOnAccount(plan, req.user?.id ?? null, req.body.note);
    // A cancelled job: the refund that was due is now being kept, so its reminder goes.
    if (plan.cancellation) {
      await clearRefundRemindersHeld(plan.jobId, req.user?.id ?? null)
        .catch((e) => console.warn('[account-credit] could not clear the refund reminder:', e));
    }
    await logAudit(req.user!.id, 'account_credits', credit.id, 'create', null, { source_job_id: credit.source_job_id, amount: credit.amount });
    res.json({ data: { credit, plan: await planHireCloseOut(req.body.job_id, { fresh: true }) } });
  } catch (err) { fail(res, err, 'hold'); }
});

// "Stop holding" — back to money to sort on its own job
router.post('/:id/release', authorize(...MANAGER_ROLES), validate(z.object({ reason: z.string().min(1).max(500) })), async (req: AuthRequest, res: Response) => {
  try {
    const id = String(req.params.id);
    if (!isUuid(id)) { res.status(400).json({ error: 'Bad id' }); return; }
    const credit = await releaseHold(id, req.user?.id ?? null, req.body.reason);
    await logAudit(req.user!.id, 'account_credits', id, 'update', null, { status: 'released', reason: req.body.reason });
    let plan = await planHireCloseOut(credit.source_job_id, { fresh: true });
    // A cancelled job: no longer kept, so it is a refund due again — put its reminder back.
    if (plan.cancellation && plan.blockers.length === 0) {
      const due = Math.round(plan.surplus.reduce((s, x) => s + x.amount, 0) * 100) / 100;
      await syncRefundReminder(plan.jobId, due, req.user?.id ?? null)
        .catch((e) => console.warn('[account-credit] could not put the refund reminder back:', e));
      plan = await planHireCloseOut(credit.source_job_id, { fresh: true });
    }
    res.json({ data: { credit, plan } });
  } catch (err) { fail(res, err, 'release'); }
});

// "Use on this job"
router.post('/:id/reserve', validate(z.object({ job_id: uuid })), async (req: AuthRequest, res: Response) => {
  try {
    const id = String(req.params.id);
    if (!isUuid(id)) { res.status(400).json({ error: 'Bad id' }); return; }
    const credit = await reserveOnJob(id, req.body.job_id, req.user?.id ?? null);
    await logAudit(req.user!.id, 'account_credits', id, 'update', null, { reserved_job_id: req.body.job_id });
    res.json({ data: credit });
  } catch (err) { fail(res, err, 'reserve'); }
});

// "Take off this job"
router.post('/:id/unreserve', authorize(...MANAGER_ROLES), async (req: AuthRequest, res: Response) => {
  try {
    const id = String(req.params.id);
    if (!isUuid(id)) { res.status(400).json({ error: 'Bad id' }); return; }
    const credit = await unreserve(id, req.user?.id ?? null);
    await logAudit(req.user!.id, 'account_credits', id, 'update', null, { reserved_job_id: null });
    res.json({ data: credit });
  } catch (err) { fail(res, err, 'unreserve'); }
});

export default router;
