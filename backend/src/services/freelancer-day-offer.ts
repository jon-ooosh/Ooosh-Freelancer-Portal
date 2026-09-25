/**
 * The freelancer day OFFER — the email, the token and the reply (spec §9.4).
 *
 * Until this existed, "Offer the day" wrote a row and told nobody. The person
 * found out when somebody rang them, which made `offered` a fiction: it meant
 * "we intend to ask", not "we asked". This is the part that actually asks.
 *
 * THE LINK IS A BEARER CREDENTIAL, and deliberately so — same posture as the
 * OOH parking form and the storage T&Cs. The worst a stolen one does is answer
 * one day's availability for one person, which the person turning up (or not)
 * immediately contradicts. That is why the token is stored in the clear: a
 * chase has to re-send the SAME link, which a hash would prevent.
 *
 * NOTHING HERE MUTATES ON A GET. Mail scanners — Outlook's Safe Links,
 * corporate filters, some mobile clients — follow every URL in an email before
 * a human sees it. A one-click accept link would therefore accept on the
 * freelancer's behalf, silently, for a day they may not have read about yet.
 * So the email links to a PAGE carrying the intent, and only an explicit POST
 * from that page records anything.
 */
import { randomBytes } from 'node:crypto';
import { query } from '../config/database';
import emailService from '../services/email-service';
import { frontendLink } from '../config/app-urls';
import { greetingName } from './display-name';
import { getBooking, recordResponse, type DayBooking } from './freelancer-days';

/** Long, URL-safe, and the same shape the OOH parking token uses. */
function newToken(): string {
  return randomBytes(24).toString('base64url');
}

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

/** "Thursday 8 October 2026" — a date somebody can check against their diary. */
export function formatBookingDate(dateIso: string): string {
  const [y, m, d] = dateIso.split('-').map(Number);
  const dt = new Date(Date.UTC(y, (m ?? 1) - 1, d));
  return Number.isNaN(dt.getTime()) ? dateIso
    : dt.toLocaleDateString('en-GB', {
        weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC',
      });
}

/** "A full day", "09:00 – 17:00 (8 hours)" — what they are actually agreeing to. */
export function describeDuration(b: Pick<DayBooking, 'durationType' | 'startTime' | 'endTime'>): string {
  if (b.durationType === 'full_day') return 'A full day';
  if (b.durationType === 'half_day') return 'Half a day';
  if (!b.startTime || !b.endTime) return 'Set hours';
  const toMin = (t: string) => {
    const [h, m] = t.split(':').map(Number);
    return (h ?? 0) * 60 + (m ?? 0);
  };
  const hours = Math.round(((toMin(b.endTime) - toMin(b.startTime)) / 60) * 100) / 100;
  const length = hours < 1 ? `${Math.round(hours * 60)} minutes`
    : `${hours} ${hours === 1 ? 'hour' : 'hours'}`;
  return `${b.startTime} – ${b.endTime} (${length})`;
}

/** "£180 for the day", "£20/hr" — never a bare number with no unit. */
export function describeRate(b: Pick<DayBooking, 'rateType' | 'agreedRate'>): string {
  if (b.agreedRate === null || b.agreedRate === undefined) return 'To be confirmed';
  const amount = `£${Number(b.agreedRate).toFixed(2)}`;
  switch (b.rateType) {
    case 'hourly': return `${amount} per hour`;
    case 'half_day': return `${amount} for the half day`;
    case 'fixed': return `${amount} for the job`;
    default: return `${amount} for the day`;
  }
}

/**
 * Issue (or reuse) the token for a booking.
 *
 * Reuses an existing one on purpose: the +1-day chase in §9.4 sends the same
 * email again, and a freelancer who kept the first message must not find that
 * its buttons have quietly stopped working.
 */
export async function ensureResponseToken(bookingId: string): Promise<string> {
  const existing = await query(
    `SELECT response_token FROM freelancer_day_bookings WHERE id = $1`, [bookingId]);
  const current = existing.rows[0]?.response_token as string | undefined;
  if (current) return current;

  const token = newToken();
  await query(
    `UPDATE freelancer_day_bookings SET response_token = $2, updated_at = NOW() WHERE id = $1`,
    [bookingId, token]
  );
  return token;
}

export function responseUrl(token: string, intent?: 'accept' | 'decline'): string {
  const base = frontendLink(`/freelancer-day/${token}`);
  return intent ? `${base}?r=${intent}` : base;
}

/**
 * Why a link is not usable, when it isn't.
 *
 * A dead link must never render as a blank page or a bare 404 — the person is
 * standing in a corridor with their phone out, and "this didn't work" tells
 * them nothing about whether they are expected at the yard tomorrow. Each
 * reason below gets its own sentence on the page, and every one of them ends by
 * telling them to ring us.
 */
export type TokenRejection = 'unknown' | 'passed' | 'answered' | 'cancelled' | 'completed';

export interface ResolvedOffer {
  ok: boolean;
  reason?: TokenRejection;
  booking?: DayBooking;
  personName?: string;
}

export async function resolveResponseToken(token: string): Promise<ResolvedOffer> {
  if (!token || token.length < 16) return { ok: false, reason: 'unknown' };

  const r = await query(
    `SELECT b.id, p.first_name, p.preferred_name
       FROM freelancer_day_bookings b
       JOIN people p ON p.id = b.person_id
      WHERE b.response_token = $1`,
    [token]
  );
  if (r.rows.length === 0) return { ok: false, reason: 'unknown' };

  const booking = await getBooking(r.rows[0].id as string);
  if (!booking) return { ok: false, reason: 'unknown' };

  const personName = greetingName({
    first_name: r.rows[0].first_name as string | null,
    preferred_name: r.rows[0].preferred_name as string | null,
  });
  const base = { booking, personName };

  // Order matters: say the most useful thing. "We cancelled this" beats "this
  // date has passed" for a cancelled day that is also in the past, because the
  // first explains why nobody expects them and the second does not.
  if (booking.status === 'cancelled') return { ok: false, reason: 'cancelled', ...base };
  if (booking.status === 'completed') return { ok: false, reason: 'completed', ...base };
  if (booking.status !== 'offered') return { ok: false, reason: 'answered', ...base };
  if (booking.bookingDate < todayIso()) return { ok: false, reason: 'passed', ...base };

  return { ok: true, ...base };
}

/**
 * Record an answer that arrived through the public link.
 *
 * THE TOKEN IS NOT CLEARED, which is a deliberate departure from the §9.4
 * sketch ("cleared on response"). Clearing it was tested and felt wrong:
 * clicking the button in an email twice is ordinary behaviour — you accept on
 * Monday, then on Thursday you reopen the message to check what time you said
 * you would be there — and a cleared token answers that with "we do not
 * recognise that link", which reads like something has gone wrong with your
 * booking.
 *
 * Leaving it live costs nothing. `resolveResponseToken` refuses anything that
 * is not still `offered`, so a second press cannot double-record; it renders
 * "you already said yes to this one" and the day's details, which is what they
 * came back for. The link still dies when the date passes.
 */
export async function recordTokenResponse(
  token: string,
  response: 'accepted' | 'declined',
  note: string | null,
): Promise<ResolvedOffer> {
  const resolved = await resolveResponseToken(token);
  if (!resolved.ok || !resolved.booking) return resolved;

  await recordResponse(resolved.booking.id, response, note);

  const after = await getBooking(resolved.booking.id);
  return { ok: true, booking: after ?? resolved.booking, personName: resolved.personName };
}

interface OfferRecipient {
  email: string | null;
  first_name: string | null;
  preferred_name: string | null;
}

async function loadRecipient(personId: string): Promise<OfferRecipient | null> {
  const r = await query(
    `SELECT email, first_name, preferred_name FROM people WHERE id = $1 AND is_deleted = false`,
    [personId]
  );
  return (r.rows[0] as OfferRecipient) ?? null;
}

export type OfferSendResult =
  | { sent: true }
  | { sent: false; why: 'backdated' | 'no_email' | 'not_offered' | 'gone' | 'failed'; detail?: string };

/**
 * Send the offer email for a booking.
 *
 * NEVER FAILS THE BOOKING. The row is the record; the email is a courtesy on
 * top of it. If mail is down, a day that exists and has not been announced is
 * far better than losing the booking — and `offer_email_sent_at` stays NULL, so
 * it is visible rather than assumed.
 *
 * A BACKDATED BOOKING IS NEVER EMAILED. Recording a day after the fact is
 * legitimate — the form calls it "Record the day" — and emailing somebody to
 * ask whether they are free last Tuesday is nonsense that makes us look like we
 * are not paying attention.
 */
export async function sendOfferEmail(
  bookingId: string,
  opts: { resend?: boolean } = {}
): Promise<OfferSendResult> {
  const booking = await getBooking(bookingId);
  if (!booking) return { sent: false, why: 'gone' };
  if (booking.status !== 'offered') return { sent: false, why: 'not_offered' };
  if (booking.bookingDate < todayIso()) return { sent: false, why: 'backdated' };

  const person = await loadRecipient(booking.personId);
  if (!person?.email) return { sent: false, why: 'no_email' };

  const token = await ensureResponseToken(bookingId);

  // emailService.send RESOLVES with { success: false } on a delivery failure —
  // it only throws on a programming error. Checking the result is what stops
  // offer_email_sent_at recording "we told them" when SMTP was down and nobody
  // was told anything.
  let result;
  try {
    result = await emailService.send('freelancer_day_offer', {
      to: person.email,
      variables: {
        freelancerName: greetingName(person),
        bookingDate: formatBookingDate(booking.bookingDate),
        duration: describeDuration(booking),
        rate: describeRate(booking),
        // "what are they doing" is optional on the form; the template hides the
        // whole row rather than printing an empty box.
        notes: booking.notes || '',
        acceptUrl: responseUrl(token, 'accept'),
        declineUrl: responseUrl(token, 'decline'),
        viewUrl: responseUrl(token),
        // The engine has NO {{else}} and cannot nest {{#if}}, so every branch is
        // its own flat block with its own flag. A chase adds a line; a first
        // send simply has none, which is why there is no complementary flag
        // here any more.
        isChase: opts.resend ? 'yes' : '',
      },
    });
  } catch (err) {
    console.error(`[freelancer-day-offer] send threw for booking ${bookingId}:`, err);
    return { sent: false, why: 'failed', detail: err instanceof Error ? err.message : String(err) };
  }
  if (!result.success) {
    console.error(`[freelancer-day-offer] send failed for booking ${bookingId}: ${result.error}`);
    return { sent: false, why: 'failed', detail: result.error };
  }

  await query(
    `UPDATE freelancer_day_bookings SET offer_email_sent_at = NOW(), updated_at = NOW() WHERE id = $1`,
    [bookingId]
  );
  return { sent: true };
}

/**
 * Tell somebody their day's details moved, without re-asking (§9.4 item 6).
 *
 * Only to somebody who was actually told about the day in the first place. An
 * "update" to a booking whose offer never went is the first they would hear of
 * it, and it would read as a change to something they never knew existed.
 */
export async function sendUpdatedEmail(bookingId: string): Promise<OfferSendResult> {
  const booking = await getBooking(bookingId);
  if (!booking) return { sent: false, why: 'gone' };

  const stamped = await query(
    `SELECT offer_email_sent_at FROM freelancer_day_bookings WHERE id = $1`, [bookingId]);
  if (!stamped.rows[0]?.offer_email_sent_at) return { sent: false, why: 'not_offered' };

  const person = await loadRecipient(booking.personId);
  if (!person?.email) return { sent: false, why: 'no_email' };

  let result;
  try {
    result = await emailService.send('freelancer_day_updated', {
      to: person.email,
      variables: {
        freelancerName: greetingName(person),
        bookingDate: formatBookingDate(booking.bookingDate),
        duration: describeDuration(booking),
        rate: describeRate(booking),
        notes: booking.notes || '',
      },
    });
  } catch (err) {
    console.error(`[freelancer-day-offer] update email threw for ${bookingId}:`, err);
    return { sent: false, why: 'failed', detail: err instanceof Error ? err.message : String(err) };
  }
  if (!result.success) {
    console.error(`[freelancer-day-offer] update email failed for ${bookingId}: ${result.error}`);
    return { sent: false, why: 'failed', detail: result.error };
  }
  return { sent: true };
}

/**
 * Tell somebody a day they had is off (§9.4, decision 4).
 *
 * Only for a day they had actually been told about. Cancelling a booking that
 * never sent an offer — a backdated record, or one cancelled before the mail
 * went — must stay silent, or the first they hear from us is that something
 * they never knew existed has been called off.
 */
export async function sendCancellationEmail(
  bookingId: string,
  reason: string,
  // Read BEFORE the cancel, by the caller. By the time this runs the row says
  // `cancelled`, so the booking itself can no longer tell us whether they had
  // agreed to come — and "you had accepted this" is the difference between a
  // note and an apology.
  priorStatus: DayBooking['status'],
): Promise<OfferSendResult> {
  const booking = await getBooking(bookingId);
  if (!booking) return { sent: false, why: 'gone' };

  const stamped = await query(
    `SELECT offer_email_sent_at FROM freelancer_day_bookings WHERE id = $1`, [bookingId]);
  if (!stamped.rows[0]?.offer_email_sent_at) return { sent: false, why: 'not_offered' };

  const person = await loadRecipient(booking.personId);
  if (!person?.email) return { sent: false, why: 'no_email' };

  let result;
  try {
    result = await emailService.send('freelancer_day_cancelled', {
      to: person.email,
      variables: {
        freelancerName: greetingName(person),
        bookingDate: formatBookingDate(booking.bookingDate),
        duration: describeDuration(booking),
        // Their own reason, not a status code. Blank is fine — the sentence
        // around it reads properly without one.
        reason: reason || '',
        hadAccepted: priorStatus === 'accepted' ? 'yes' : '',
        hadNotAccepted: priorStatus === 'accepted' ? '' : 'yes',
      },
    });
  } catch (err) {
    console.error(`[freelancer-day-offer] cancellation email threw for ${bookingId}:`, err);
    return { sent: false, why: 'failed', detail: err instanceof Error ? err.message : String(err) };
  }
  if (!result.success) {
    console.error(`[freelancer-day-offer] cancellation email failed for ${bookingId}: ${result.error}`);
    return { sent: false, why: 'failed', detail: result.error };
  }
  return { sent: true };
}
