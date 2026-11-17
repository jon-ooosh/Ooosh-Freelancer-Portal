import { Router, Response } from 'express';
import { z } from 'zod';
import { authenticate, AuthRequest, authorize, STAFF_ROLES, MANAGER_ROLES } from '../middleware/auth';
import { validate } from '../middleware/validate';
import { logAudit } from '../middleware/audit';
import { query } from '../config/database';
import { ukToday } from '../services/uk-date';
import {
  listForOwner, listForContext, ownerChoicesForJob, getGoodwillCredit, offerGoodwill, editGoodwill,
  reserveGoodwill, unreserveGoodwill, markGoodwillApplied, withdrawGoodwill, GoodwillError, listOnJob,
} from '../services/goodwill-credits';
import { checkReservedGoodwill } from '../services/goodwill-check';

// Goodwill credit (docs/GOODWILL-CREDIT-SPEC.md). Managers offer, change, withdraw
// and take a credit off a job; any staff role reserves it on a job and marks it
// applied (jon, 16 Nov 2026). All logic lives in services/goodwill-credits.ts.
const router = Router();
router.use(authenticate);
router.use(authorize(...STAFF_ROLES));

const uuid = z.string().guid();
const ymd = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const amount = z.number().positive().max(100000);  // NUMERIC(10,2) rounds to the penny
const isUuid = (v: unknown): v is string => typeof v === 'string' && /^[0-9a-f-]{36}$/i.test(v);
const idList = (v: unknown): string[] => (typeof v === 'string' ? v.split(',').filter(isUuid) : []);

function fail(res: Response, err: unknown, what: string) {
  if (err instanceof GoodwillError) { res.status(err.status).json({ error: err.message }); return; }
  console.error(`Goodwill ${what} error:`, err);
  res.status(500).json({ error: 'Internal server error' });
}

// ?organisation_id= | ?person_id= — every credit they hold (the Goodwill tab)
router.get('/', async (req: AuthRequest, res: Response) => {
  try {
    const organisationId = isUuid(req.query.organisation_id) ? req.query.organisation_id : undefined;
    const personId = isUuid(req.query.person_id) ? req.query.person_id : undefined;
    if (!organisationId && !personId) { res.status(400).json({ error: 'organisation_id or person_id required' }); return; }
    res.json({ data: await listForOwner({ organisationId, personId }) });
  } catch (err) { fail(res, err, 'list'); }
});

// The Client History note: ?org_ids=a,b&person_ids=c,d&job_id= — a saved job adds its
// own contacts; New Enquiry passes the contacts picked so far.
router.get('/context', async (req: AuthRequest, res: Response) => {
  try {
    const jobId = isUuid(req.query.job_id) ? req.query.job_id : null;
    const personIds = idList(req.query.person_ids);
    if (jobId) {
      const c = await query(`SELECT person_id FROM job_contacts WHERE job_id = $1`, [jobId]);
      personIds.push(...c.rows.map((r) => r.person_id as string));
    }
    res.json({ data: await listForContext({ orgIds: idList(req.query.org_ids), personIds, jobId }) });
  } catch (err) { fail(res, err, 'context'); }
});

// Reserved or used on this job — the job header chip and the close-out ledger line (phase 2)
router.get('/on-job/:jobId', async (req: AuthRequest, res: Response) => {
  try {
    if (!isUuid(req.params.jobId)) { res.status(400).json({ error: 'Bad job id' }); return; }
    res.json({ data: await listOnJob(String(req.params.jobId)) });
  } catch (err) { fail(res, err, 'on job'); }
});

// "Check now" — read HireHop for one reserved credit straight away (spec §6.1)
router.post('/:id/check', async (req: AuthRequest, res: Response) => {
  try {
    const id = String(req.params.id);
    if (!isUuid(id)) { res.status(400).json({ error: 'Bad id' }); return; }
    const g = await checkReservedGoodwill(id, 'live');  // the one place it reads HireHop live — a person asked
    if (!g) { res.status(404).json({ error: 'Goodwill credit not found' }); return; }
    res.json({ data: g });
  } catch (err) { fail(res, err, 'check'); }
});

// Who a credit offered from this job could be for (the offer modal's "For")
router.get('/owner-choices/:jobId', async (req: AuthRequest, res: Response) => {
  try {
    if (!isUuid(req.params.jobId)) { res.status(400).json({ error: 'Bad job id' }); return; }
    res.json({ data: await ownerChoicesForJob(String(req.params.jobId)) });
  } catch (err) { fail(res, err, 'owner choices'); }
});

const offerSchema = z.object({
  organisation_id: uuid.optional().nullable(),
  person_id: uuid.optional().nullable(),
  amount_ex_vat: amount,
  reason: z.string().trim().min(1).max(2000),
  source_kind: z.enum(['close_out', 'problem', 'cancellation', 'organisation', 'person']),
  source_job_id: uuid.optional().nullable(),
  source_issue_id: uuid.optional().nullable(),
  expires_on: ymd.optional().nullable(),
}).refine((d) => (!!d.organisation_id) !== (!!d.person_id), {
  message: 'A credit is for an organisation OR a person — pick one',
}).refine((d) => !d.expires_on || d.expires_on >= ukToday(), {
  message: 'The use-by date can’t be in the past',
});

router.post('/', authorize(...MANAGER_ROLES), validate(offerSchema), async (req: AuthRequest, res: Response) => {
  try {
    const g = await offerGoodwill(req.body, req.user!.id);
    await logAudit(req.user!.id, 'goodwill_credits', g.id, 'create', null, req.body);
    res.status(201).json({ data: g });
  } catch (err) { fail(res, err, 'offer'); }
});

// Edit: every field optional and no defaults, so nothing unsent is overwritten.
const editSchema = z.object({
  amount_ex_vat: amount.optional(),
  reason: z.string().trim().min(1).max(2000).optional(),
  expires_on: ymd.optional(),
}).refine((d) => !d.expires_on || d.expires_on >= ukToday(), {
  message: 'The use-by date can’t be in the past',
});

router.patch('/:id', authorize(...MANAGER_ROLES), validate(editSchema), async (req: AuthRequest, res: Response) => {
  try {
    const id = String(req.params.id);
    if (!isUuid(id)) { res.status(400).json({ error: 'Bad id' }); return; }
    const before = await getGoodwillCredit(id);
    const g = await editGoodwill(id, req.body, req.user!.id);
    await logAudit(req.user!.id, 'goodwill_credits', id, 'update', before as unknown as Record<string, unknown>, req.body);
    res.json({ data: g });
  } catch (err) { fail(res, err, 'edit'); }
});

const reserveSchema = z.object({
  job_id: uuid,
  reserved_for: z.enum(['hire', 'invoice']),
  amount_ex_vat: amount,
  invoice_number: z.string().trim().max(40).optional().nullable(),
});

router.post('/:id/reserve', validate(reserveSchema), async (req: AuthRequest, res: Response) => {
  try {
    const id = String(req.params.id);
    if (!isUuid(id)) { res.status(400).json({ error: 'Bad id' }); return; }
    const g = await reserveGoodwill(id, req.body, req.user!.id);
    await logAudit(req.user!.id, 'goodwill_credits', id, 'reserve', null, req.body);
    res.json({ data: g });
  } catch (err) { fail(res, err, 'reserve'); }
});

router.post('/:id/unreserve', authorize(...MANAGER_ROLES), async (req: AuthRequest, res: Response) => {
  try {
    const id = String(req.params.id);
    if (!isUuid(id)) { res.status(400).json({ error: 'Bad id' }); return; }
    const g = await unreserveGoodwill(id, req.user!.id);
    await logAudit(req.user!.id, 'goodwill_credits', id, 'unreserve', null, null);
    res.json({ data: g });
  } catch (err) { fail(res, err, 'unreserve'); }
});

router.post('/:id/applied', validate(z.object({ amount_ex_vat: amount.optional().nullable() })), async (req: AuthRequest, res: Response) => {
  try {
    const id = String(req.params.id);
    if (!isUuid(id)) { res.status(400).json({ error: 'Bad id' }); return; }
    const g = await markGoodwillApplied(id, req.body.amount_ex_vat ?? null, req.user!.id);
    await logAudit(req.user!.id, 'goodwill_credits', id, 'applied', null, req.body);
    res.json({ data: g });
  } catch (err) { fail(res, err, 'applied'); }
});

router.post('/:id/withdraw', authorize(...MANAGER_ROLES), validate(z.object({ reason: z.string().trim().min(1).max(2000) })), async (req: AuthRequest, res: Response) => {
  try {
    const id = String(req.params.id);
    if (!isUuid(id)) { res.status(400).json({ error: 'Bad id' }); return; }
    const g = await withdrawGoodwill(id, req.body.reason, req.user!.id);
    await logAudit(req.user!.id, 'goodwill_credits', id, 'withdraw', null, req.body);
    res.json({ data: g });
  } catch (err) { fail(res, err, 'withdraw'); }
});

export default router;
