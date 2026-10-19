/**
 * Public accept/decline for a freelancer yard-day offer (spec §9.4).
 *
 * NO JWT. The token in the URL is the credential, same posture as the OOH
 * parking form (`ooh-return.ts`) and the storage T&Cs: a link in an email is a
 * bearer credential, and the worst a stolen one does here is answer one day's
 * availability for one person — which that person turning up, or not,
 * immediately contradicts.
 *
 *   GET  /api/freelancer-days/respond/:token   — what is being offered
 *   POST /api/freelancer-days/respond/:token   — record accept or decline
 *
 * THE GET NEVER WRITES. Mail scanners follow every link in an email before a
 * human sees it, so a GET that accepted would accept on the freelancer's behalf
 * before they had read the message.
 *
 * Staff endpoints for freelancer days live on `staff-calendar.ts` behind auth.
 * This file is public on purpose and should stay small enough to audit at a
 * glance.
 */
import { Router, Request, Response } from 'express';
import { z } from 'zod';
import rateLimit from 'express-rate-limit';
import {
  resolveResponseToken,
  recordTokenResponse,
  formatBookingDate,
  describeDuration,
  describeRate,
  type ResolvedOffer,
} from '../services/freelancer-day-offer';

const router = Router();

// Matches the OOH form's posture. Generous enough that a real person fumbling
// on a train never sees it, tight enough that the endpoint is not a free
// token-guessing oracle.
const publicLimiter = rateLimit({
  windowMs: 60_000,
  max: 20,
  message: { error: 'Too many requests — please wait a minute and try again.' },
  standardHeaders: true,
  legacyHeaders: false,
});

/**
 * What the page is told.
 *
 * A dead link returns 200 with `usable: false` and a REASON, not a bare 404.
 * Somebody standing in a corridor with their phone needs to know whether they
 * are expected at the yard tomorrow; "not found" answers a different question.
 * An unknown token is the one real 404 — there is nothing truthful to say about
 * a booking we cannot identify.
 */
function present(resolved: ResolvedOffer) {
  const b = resolved.booking;
  return {
    usable: resolved.ok,
    reason: resolved.reason ?? null,
    personName: resolved.personName ?? null,
    booking: b ? {
      bookingDate: b.bookingDate,
      bookingDateLabel: formatBookingDate(b.bookingDate),
      duration: describeDuration(b),
      rate: describeRate(b),
      notes: b.notes,
      status: b.status,
    } : null,
  };
}

router.get('/respond/:token', publicLimiter, async (req: Request, res: Response) => {
  try {
    const resolved = await resolveResponseToken(String(req.params.token));
    if (resolved.reason === 'unknown') {
      res.status(404).json({ error: 'That link is not one we recognise.', usable: false, reason: 'unknown' });
      return;
    }
    res.json(present(resolved));
  } catch (err) {
    console.error('[freelancer-days] respond lookup failed:', err);
    res.status(500).json({ error: 'Something went wrong at our end.' });
  }
});

const respondSchema = z.object({
  response: z.enum(['accepted', 'declined']),
  // Optional and stays optional. §9.4 decision 3: a decline is a response, not
  // something to excuse, so nothing here may require a reason.
  note: z.string().max(500).nullish(),
});

router.post('/respond/:token', publicLimiter, async (req: Request, res: Response) => {
  const parsed = respondSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Tell us yes or no.' });
    return;
  }
  try {
    const result = await recordTokenResponse(
      String(req.params.token), parsed.data.response, parsed.data.note ?? null,
    );
    if (!result.ok) {
      const status = result.reason === 'unknown' ? 404 : 409;
      res.status(status).json(present(result));
      return;
    }
    res.json(present(result));
  } catch (err) {
    console.error('[freelancer-days] respond failed:', err);
    res.status(500).json({ error: 'Something went wrong at our end.' });
  }
});

export default router;
