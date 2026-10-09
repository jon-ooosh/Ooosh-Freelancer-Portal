/**
 * PUBLIC personal calendar feed (staff calendar spec §10, built Oct 2026).
 *
 *   GET /api/staff-calendar-feed/:token.ics — one person's own time, as iCal
 *
 * NO JWT: a phone's calendar app cannot log in, so the long random token in
 * the URL is the credential. What goes in the feed is decided ONLY by
 * services/staff-ical.ts — the person's own time off, home days and company
 * days, and nothing about anybody else. The signed-in half (get the link,
 * reset it) lives on staff-calendar.ts as /me/calendar-feed.
 *
 * Kept small so it can be audited at a glance.
 */
import { Router, Request, Response } from 'express';
import rateLimit from 'express-rate-limit';
import { resolveFeedToken, buildFeedEvents, renderIcs } from '../services/staff-ical';

const router = Router();

// Calendar services poll from shared addresses, so this is looser than the
// form endpoints — but still not a free token-guessing oracle.
const feedLimiter = rateLimit({
  windowMs: 60_000,
  max: 60,
  message: 'Too many requests',
  standardHeaders: true,
  legacyHeaders: false,
});

router.get('/:file', feedLimiter, async (req: Request, res: Response) => {
  try {
    const token = String(req.params.file).replace(/\.ics$/i, '');
    const personId = await resolveFeedToken(token);
    if (!personId) { res.status(404).type('text/plain').send('This calendar link is not recognised.'); return; }
    const ics = renderIcs(await buildFeedEvents(personId), 'Ooosh — my time');
    res.set('Cache-Control', 'private, max-age=900');
    res.type('text/calendar; charset=utf-8').send(ics);
  } catch (err) {
    console.error('[staff-calendar-feed] error:', err);
    res.status(500).type('text/plain').send('The calendar could not be built just now.');
  }
});

export default router;
