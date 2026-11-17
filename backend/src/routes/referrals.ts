/**
 * The referral scheme (docs/BUSINESS-FIGURES-SPEC.md §8d). All logic in services/referrals.ts.
 *
 *   GET    /job/:jobId               staff   — the job's referral, if any
 *   POST   /                         staff   — "Referred by" { jobId, referrerPersonId, how: named | card }
 *   DELETE /:id                      staff   — linked by mistake (only before a thank-you / credit)
 *   POST   /:id/welcome-credit       manager — the friend's welcome credit (a goodwill credit)
 *   GET    /person/:personId         staff   — their personal link + counts
 *   POST   /person/:personId/link    staff   — make their personal link
 *   GET    /overview                 admin   — the offer, the email switch, totals, the list
 *   PUT    /offer                    admin   — a new offer (the old one stays on its referrals)
 *   PUT    /settings                 admin   — { emailsEnabled }
 *   POST   /test                     admin   — emails 2 + 3 to yourself
 *   POST   /:id/thanked              manager — the thank-you was given { detail, sendEmail }
 *   POST   /:id/decline              manager — { reason }
 */
import { Router, Response } from 'express';
import { z } from 'zod';
import { authenticate, authorize, AuthRequest, MANAGER_ROLES, STAFF_ROLES } from '../middleware/auth';
import { validate } from '../middleware/validate';
import {
  ReferralError, createReferral, currentOffer, declineReferral, getJobReferral, getOrCreateReferralLink,
  giveWelcomeCredit, listReferrals, markThanked, personReferralSummary, referralEmailsEnabled, referralTotals,
  removeReferral, sendReferralTestEmails, setOffer, setReferralEmailsEnabled,
} from '../services/referrals';
import { personIdForUser } from '../services/staff-tasks';

const router = Router();
router.use(authenticate);

const id = z.object({ id: z.string().guid() });
const jobParam = z.object({ jobId: z.string().guid() });
const personParam = z.object({ personId: z.string().guid() });

function fail(res: Response, where: string, err: unknown) {
  if (err instanceof ReferralError) {
    res.status(err.status).json({ error: err.message });
    return;
  }
  console.error(`[referrals] ${where}:`, err);
  res.status(500).json({ error: 'Something went wrong — please try again.' });
}

// ── Staff ────────────────────────────────────────────────────────────────────

router.get('/job/:jobId', authorize(...STAFF_ROLES), validate(jobParam, 'params'), async (req: AuthRequest, res: Response) => {
  try {
    const [referral, offer] = await Promise.all([getJobReferral(String(req.params.jobId)), currentOffer()]);
    res.json({ data: { referral, offerCreditExVat: offer.friendCreditExVat } });
  } catch (err) { fail(res, 'job', err); }
});

router.post('/', authorize(...STAFF_ROLES), validate(z.object({
  jobId: z.string().guid(),
  referrerPersonId: z.string().guid(),
  how: z.enum(['named', 'card']),
})), async (req: AuthRequest, res: Response) => {
  try {
    const newId = await createReferral(req.body, req.user!.id);
    res.status(201).json({ data: await getJobReferral(req.body.jobId), id: newId });
  } catch (err) { fail(res, 'create', err); }
});

router.delete('/:id', authorize(...STAFF_ROLES), validate(id, 'params'), async (req: AuthRequest, res: Response) => {
  try {
    await removeReferral(String(req.params.id), req.user!.id);
    res.json({ data: { removed: true } });
  } catch (err) { fail(res, 'remove', err); }
});

router.post('/:id/welcome-credit', authorize(...MANAGER_ROLES), validate(id, 'params'),
  validate(z.object({ amountExVat: z.number().positive().max(10000).nullable().optional() })), async (req: AuthRequest, res: Response) => {
    try {
      const creditId = await giveWelcomeCredit(String(req.params.id), { amountExVat: req.body.amountExVat ?? null }, req.user!.id);
      res.json({ data: { creditId } });
    } catch (err) { fail(res, 'welcome credit', err); }
  });

router.get('/person/:personId', authorize(...STAFF_ROLES), validate(personParam, 'params'), async (req: AuthRequest, res: Response) => {
  try {
    res.json({ data: await personReferralSummary(String(req.params.personId)) });
  } catch (err) { fail(res, 'person', err); }
});

router.post('/person/:personId/link', authorize(...STAFF_ROLES), validate(personParam, 'params'), async (req: AuthRequest, res: Response) => {
  try {
    await getOrCreateReferralLink(String(req.params.personId), req.user!.id);
    res.json({ data: await personReferralSummary(String(req.params.personId)) });
  } catch (err) { fail(res, 'make link', err); }
});

// ── Thank-you / decline (managers) ───────────────────────────────────────────

router.post('/:id/thanked', authorize(...MANAGER_ROLES), validate(id, 'params'), validate(z.object({
  detail: z.string().max(300),
  sendEmail: z.boolean(),
})), async (req: AuthRequest, res: Response) => {
  try {
    await markThanked(String(req.params.id), req.body, req.user!.id);
    res.json({ data: { ok: true } });
  } catch (err) { fail(res, 'thanked', err); }
});

router.post('/:id/decline', authorize(...MANAGER_ROLES), validate(id, 'params'),
  validate(z.object({ reason: z.string().trim().min(1).max(300) })), async (req: AuthRequest, res: Response) => {
    try {
      await declineReferral(String(req.params.id), req.body.reason, req.user!.id);
      res.json({ data: { ok: true } });
    } catch (err) { fail(res, 'decline', err); }
  });

// ── Admin: Marketing › Referrals ─────────────────────────────────────────────

router.get('/overview', authorize('admin'), async (_req: AuthRequest, res: Response) => {
  try {
    const [offer, emailsEnabled, totals, referrals] = await Promise.all([currentOffer(), referralEmailsEnabled(), referralTotals(), listReferrals()]);
    res.json({ data: { offer, emailsEnabled, totals, referrals } });
  } catch (err) { fail(res, 'overview', err); }
});

router.put('/offer', authorize('admin'), validate(z.object({
  referrerReward: z.string().trim().max(200).nullable(),
  friendOffer: z.string().trim().max(200).nullable(),
  friendCreditExVat: z.number().positive().max(10000).nullable(),
})), async (req: AuthRequest, res: Response) => {
  try {
    res.json({ data: await setOffer(req.body, req.user!.id) });
  } catch (err) { fail(res, 'offer', err); }
});

router.put('/settings', authorize('admin'), validate(z.object({ emailsEnabled: z.boolean() })), async (req: AuthRequest, res: Response) => {
  try {
    await setReferralEmailsEnabled(!!req.body.emailsEnabled, req.user!.id);
    res.json({ data: { emailsEnabled: await referralEmailsEnabled() } });
  } catch (err) { fail(res, 'settings', err); }
});

router.post('/test', authorize('admin'), async (req: AuthRequest, res: Response) => {
  try {
    const r = await sendReferralTestEmails(req.user!.email, await personIdForUser(req.user!.id));
    if (!r.ok) {
      res.status(502).json({ error: `The test emails didn't send: ${r.error || 'unknown error'}` });
      return;
    }
    res.json({ data: { sentTo: req.user!.email } });
  } catch (err) { fail(res, 'test', err); }
});

export default router;
