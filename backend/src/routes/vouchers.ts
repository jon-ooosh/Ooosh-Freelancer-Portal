/**
 * Vouchers (docs/GOODWILL-CREDIT-SPEC.md §16) — a goodwill credit with a code on it.
 * Logic in services/vouchers.ts; withdrawing one is the usual POST /goodwill/:id/withdraw.
 * Never a public route: only staff check a code.
 *
 *   GET  /                 manager — every voucher, newest first (Money › Vouchers)
 *   POST /                 manager — make one or more { value_inc_vat, reason, expires_on?, person_id?, organisation_id?, count? }
 *   GET  /lookup?code=     staff   — the voucher behind a code, and why it can't be used (if it can't)
 *   POST /hold-on-job      staff   — { code, job_id } hold the whole voucher for this hire
 *
 * The shop till checks and spreads a voucher itself (POST /shop/voucher) and uses it up
 * with the sale.
 */
import { Router, Response } from 'express';
import { z } from 'zod';
import { authenticate, authorize, AuthRequest, MANAGER_ROLES, STAFF_ROLES } from '../middleware/auth';
import { validate } from '../middleware/validate';
import { logAudit } from '../middleware/audit';
import { ukToday } from '../services/uk-date';
import { GoodwillError } from '../services/goodwill-credits';
import { findVoucher, holdVoucherForJob, listVouchers, makeVouchers, voucherProblem } from '../services/vouchers';

const router = Router();
router.use(authenticate);
router.use(authorize(...STAFF_ROLES));

function fail(res: Response, err: unknown, what: string) {
  if (err instanceof GoodwillError) { res.status(err.status).json({ error: err.message }); return; }
  console.error(`[vouchers] ${what}:`, err);
  res.status(500).json({ error: 'Something went wrong — please try again.' });
}

router.get('/', authorize(...MANAGER_ROLES), async (_req: AuthRequest, res: Response) => {
  try {
    res.json({ data: await listVouchers() });
  } catch (err) { fail(res, err, 'list'); }
});

const makeSchema = z.object({
  value_inc_vat: z.number().positive().max(10000),
  reason: z.string().trim().min(1).max(2000),
  expires_on: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  person_id: z.string().guid().nullable().optional(),
  organisation_id: z.string().guid().nullable().optional(),
  count: z.number().int().min(1).max(50).optional(),
}).refine((d) => !(d.person_id && d.organisation_id), { message: 'A voucher is for a person OR an organisation (or nobody) — pick one' })
  .refine((d) => !d.expires_on || d.expires_on >= ukToday(), { message: 'The use-by date can’t be in the past' });

router.post('/', authorize(...MANAGER_ROLES), validate(makeSchema), async (req: AuthRequest, res: Response) => {
  try {
    const made = await makeVouchers({
      valueIncVat: req.body.value_inc_vat, reason: req.body.reason, expiresOn: req.body.expires_on ?? null,
      personId: req.body.person_id ?? null, organisationId: req.body.organisation_id ?? null, count: req.body.count ?? 1,
    }, req.user!.id);
    for (const g of made) await logAudit(req.user!.id, 'goodwill_credits', g.id, 'create', null, { voucher: true, ...req.body });
    res.status(201).json({ data: made });
  } catch (err) { fail(res, err, 'make'); }
});

router.get('/lookup', async (req: AuthRequest, res: Response) => {
  try {
    const credit = await findVoucher(String(req.query.code || ''));
    const jobId = typeof req.query.job_id === 'string' ? req.query.job_id : null;
    res.json({ data: { credit, problem: voucherProblem(credit, jobId) } });
  } catch (err) { fail(res, err, 'lookup'); }
});

router.post('/hold-on-job', validate(z.object({ code: z.string().trim().min(1).max(40), job_id: z.string().guid() })), async (req: AuthRequest, res: Response) => {
  try {
    const g = await holdVoucherForJob(req.body.code, req.body.job_id, req.user!.id);
    await logAudit(req.user!.id, 'goodwill_credits', g.id, 'reserve', null, { voucher: true, job_id: req.body.job_id });
    res.json({ data: g });
  } catch (err) { fail(res, err, 'hold on job'); }
});

export default router;
