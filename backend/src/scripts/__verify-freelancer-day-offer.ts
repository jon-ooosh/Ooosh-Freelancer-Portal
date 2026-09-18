/**
 * §9.4 — the yard-day OFFER: token lifecycle, dead-link reasons, and the rule
 * that a failed send must never claim somebody was told.
 *
 *   DATABASE_URL=postgresql://…/scratch… npx tsx src/scripts/__verify-freelancer-day-offer.ts
 *
 * Wants its OWN scratch database, like every suite in this module.
 *
 * NOTE ON EMAIL: nothing here has SMTP configured, so every send FAILS — which
 * is the more interesting half of the contract anyway. `emailService.send`
 * resolves with `{ success: false }` rather than throwing, so a version of this
 * code that only caught exceptions would stamp `offer_email_sent_at` and claim
 * a freelancer had been asked when nobody had. That is asserted below.
 */
import { query } from '../config/database';
import { createBooking, cancelBooking, recordResponse, getBooking } from '../services/freelancer-days';
import {
  ensureResponseToken, resolveResponseToken, recordTokenResponse,
  sendOfferEmail, sendCancellationEmail, responseUrl,
  formatBookingDate, describeDuration, describeRate,
} from '../services/freelancer-day-offer';

let pass = 0, fail = 0;
function check(name: string, cond: boolean, detail?: unknown) {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}`, detail !== undefined ? JSON.stringify(detail) : ''); }
}

const iso = (offsetDays: number) =>
  new Date(Date.now() + offsetDays * 86400000).toISOString().slice(0, 10);

async function main() {
  if (!/scratch|_test\b/.test(process.env.DATABASE_URL ?? '')) {
    console.error('Refusing to run: DATABASE_URL must name a scratch database.');
    process.exit(1);
  }
  const tag = Math.random().toString(36).slice(2, 8);

  // ── 0. Pure formatting — what a freelancer actually reads ────────────────
  console.log('\n0. How the day is described');
  // en-GB puts a comma after the weekday; the staff calendar's own fmtLongDate
  // renders it the same way, so the email and the app agree.
  check('the date reads as a day somebody can check against a diary',
    formatBookingDate('2026-10-08') === 'Thursday, 8 October 2026', formatBookingDate('2026-10-08'));
  check('a full day says so', describeDuration({ durationType: 'full_day', startTime: null, endTime: null }) === 'A full day');
  check('timed hours show the span AND the length',
    describeDuration({ durationType: 'hours', startTime: '09:00', endTime: '17:00' }) === '09:00 – 17:00 (8 hours)',
    describeDuration({ durationType: 'hours', startTime: '09:00', endTime: '17:00' }));
  check('one hour is singular',
    describeDuration({ durationType: 'hours', startTime: '09:00', endTime: '10:00' }) === '09:00 – 10:00 (1 hour)');
  check('under an hour reads in minutes, not 0.75 hours',
    describeDuration({ durationType: 'hours', startTime: '09:00', endTime: '09:45' }) === '09:00 – 09:45 (45 minutes)');
  check('a rate never appears as a bare number',
    describeRate({ rateType: 'day', agreedRate: 180 }) === '£180.00 for the day');
  check('hourly says per hour', describeRate({ rateType: 'hourly', agreedRate: 20 }) === '£20.00 per hour');
  check('no agreed rate says so rather than £0',
    describeRate({ rateType: 'day', agreedRate: null }) === 'To be confirmed');

  // ── Fixture ──────────────────────────────────────────────────────────────
  await query(`ALTER TABLE people ALTER COLUMN created_by DROP NOT NULL`);
  await query(`ALTER TABLE users  ALTER COLUMN person_id  DROP NOT NULL`);
  const u = await query(
    `INSERT INTO users (email,password_hash,role,is_active) VALUES ($1,'x','admin',true) RETURNING id`,
    [`off-${tag}@oooshtours.co.uk`]);
  const userId = u.rows[0].id as string;
  const admin = await query(
    `INSERT INTO people (first_name,last_name,email,created_by) VALUES ('Ad','Min',$2,$1) RETURNING id`,
    [userId, `off-${tag}@oooshtours.co.uk`]);
  await query(`UPDATE users SET person_id=$1 WHERE id=$2`, [admin.rows[0].id, userId]);
  await query(`ALTER TABLE people ALTER COLUMN created_by SET NOT NULL`);
  await query(`ALTER TABLE users  ALTER COLUMN person_id  SET NOT NULL`);

  const withEmail = await query(
    `INSERT INTO people (first_name,last_name,preferred_name,email,is_freelancer,created_by)
     VALUES ('William','Parish','Will',$2,true,$1) RETURNING id`,
    [userId, `will-${tag}@example.com`]);
  const willId = withEmail.rows[0].id as string;

  const noEmail = await query(
    `INSERT INTO people (first_name,last_name,is_freelancer,created_by)
     VALUES ('Nomail','Person',true,$1) RETURNING id`, [userId]);
  const nomailId = noEmail.rows[0].id as string;

  // ── 1. The token ─────────────────────────────────────────────────────────
  console.log('\n1. The token');
  const future = await createBooking(
    { personId: willId, bookingDate: iso(7), agreedRate: 180, notes: 'Van prep' }, userId);
  const t1 = await ensureResponseToken(future.id);
  check('a token is long enough not to be guessed', t1.length >= 24, t1.length);
  check('it is URL-safe', /^[A-Za-z0-9_-]+$/.test(t1));
  const t2 = await ensureResponseToken(future.id);
  check('asking twice returns the SAME token — a chase re-sends the same link', t1 === t2);
  check('the response URL carries the intent without acting on it',
    responseUrl(t1, 'accept').endsWith(`/freelancer-day/${t1}?r=accept`), responseUrl(t1, 'accept'));

  // ── 2. Resolving a link ──────────────────────────────────────────────────
  console.log('\n2. What a link resolves to');
  const live = await resolveResponseToken(t1);
  check('a live offer is usable', live.ok === true, live.reason);
  check('and greets them by the name they go by', live.personName === 'Will', live.personName);
  check('a token we have never issued is unknown',
    (await resolveResponseToken('a'.repeat(32))).reason === 'unknown');
  check('a short or empty token is unknown without hitting the database',
    (await resolveResponseToken('')).reason === 'unknown');

  const past = await createBooking({ personId: willId, bookingDate: iso(-3), agreedRate: 180 }, userId);
  const pastToken = await ensureResponseToken(past.id);
  check('a day that has already passed says PASSED, not "not found"',
    (await resolveResponseToken(pastToken)).reason === 'passed');

  const killed = await createBooking({ personId: willId, bookingDate: iso(9), agreedRate: 180 }, userId);
  const killedToken = await ensureResponseToken(killed.id);
  await cancelBooking(killed.id, 'Job fell through', userId);
  check('a cancelled day says CANCELLED — the most useful thing we can tell them',
    (await resolveResponseToken(killedToken)).reason === 'cancelled');

  const answered = await createBooking({ personId: willId, bookingDate: iso(11), agreedRate: 180 }, userId);
  const answeredToken = await ensureResponseToken(answered.id);
  await recordResponse(answered.id, 'accepted', null);
  check('an already-answered day says ANSWERED',
    (await resolveResponseToken(answeredToken)).reason === 'answered');
  check('and carries the booking so the page can say WHICH way they answered',
    (await resolveResponseToken(answeredToken)).booking?.status === 'accepted');

  // ── 3. Replying through the link ─────────────────────────────────────────
  console.log('\n3. Replying');
  const reply = await recordTokenResponse(t1, 'accepted', 'See you at 9');
  check('accepting records the acceptance', reply.booking?.status === 'accepted', reply.booking?.status);
  check('the optional note is kept', reply.booking?.responseNote === 'See you at 9');
  const after = await query(`SELECT response_token FROM freelancer_day_bookings WHERE id = $1`, [future.id]);
  check('the link STAYS live — reopening the email to check your start time must work',
    after.rows[0].response_token === t1, after.rows[0].response_token);
  const second = await recordTokenResponse(t1, 'declined', null);
  check('but pressing it again cannot double-record', second.ok === false);
  check('and says "you already answered" rather than "unrecognised link"',
    second.reason === 'answered', second.reason);
  check('still showing which way they answered, which is what they came back for',
    second.booking?.status === 'accepted', second.booking?.status);

  const declining = await createBooking({ personId: willId, bookingDate: iso(13), agreedRate: 180 }, userId);
  const declineToken = await ensureResponseToken(declining.id);
  const declined = await recordTokenResponse(declineToken, 'declined', null);
  check('declining needs no reason at all (§9.4 decision 3)',
    declined.booking?.status === 'declined' && declined.booking?.responseNote === null);

  // ── 4. When the email does NOT go ────────────────────────────────────────
  console.log('\n4. Who does not get emailed, and why');
  const backdated = await createBooking({ personId: willId, bookingDate: iso(-5), agreedRate: 180 }, userId);
  const bdResult = await sendOfferEmail(backdated.id);
  check('a backdated day is never emailed — asking if they are free last Tuesday is nonsense',
    bdResult.sent === false && bdResult.why === 'backdated', bdResult);
  const bdRow = await query(`SELECT offer_email_sent_at FROM freelancer_day_bookings WHERE id=$1`, [backdated.id]);
  check('and nothing is stamped, so it is visible that nobody was told',
    bdRow.rows[0].offer_email_sent_at === null);

  const noMailBooking = await createBooking({ personId: nomailId, bookingDate: iso(6), agreedRate: 100 }, userId);
  const nmResult = await sendOfferEmail(noMailBooking.id);
  check('somebody with no email address is reported, not silently skipped',
    nmResult.sent === false && nmResult.why === 'no_email', nmResult);

  const cancelledBooking = await createBooking({ personId: willId, bookingDate: iso(15), agreedRate: 180 }, userId);
  await cancelBooking(cancelledBooking.id, 'nope', userId);
  const cancelledSend = await sendOfferEmail(cancelledBooking.id);
  check('a cancelled booking is not offered again',
    cancelledSend.sent === false && cancelledSend.why === 'not_offered', cancelledSend);

  // THE ONE THAT MATTERS: no SMTP here, so the send fails.
  console.log('\n5. A failed send must never claim somebody was told');
  const willFail = await createBooking({ personId: willId, bookingDate: iso(17), agreedRate: 180 }, userId);
  const failed = await sendOfferEmail(willFail.id);
  check('a delivery failure reports sent:false — send() RESOLVES false, it does not throw',
    failed.sent === false && failed.why === 'failed', failed);
  const failRow = await query(`SELECT offer_email_sent_at, response_token FROM freelancer_day_bookings WHERE id=$1`, [willFail.id]);
  check('offer_email_sent_at stays NULL after a failed send',
    failRow.rows[0].offer_email_sent_at === null, failRow.rows[0].offer_email_sent_at);
  check('but the token was still issued, so a resend reaches the same link',
    typeof failRow.rows[0].response_token === 'string');

  // ── 6. The cancellation note ─────────────────────────────────────────────
  console.log('\n6. Telling them a day is off (§9.4 decision 4)');
  const neverTold = await createBooking({ personId: willId, bookingDate: iso(19), agreedRate: 180 }, userId);
  const before = await getBooking(neverTold.id);
  await cancelBooking(neverTold.id, 'changed our minds', userId);
  const silent = await sendCancellationEmail(neverTold.id, 'changed our minds', before!.status);
  check('somebody never told about a day is not told it is cancelled',
    silent.sent === false && silent.why === 'not_offered', silent);

  const told = await createBooking({ personId: willId, bookingDate: iso(21), agreedRate: 180 }, userId);
  await query(`UPDATE freelancer_day_bookings SET offer_email_sent_at = NOW() WHERE id = $1`, [told.id]);
  const toldBefore = await getBooking(told.id);
  await cancelBooking(told.id, 'job pulled', userId);
  const attempted = await sendCancellationEmail(told.id, 'job pulled', toldBefore!.status);
  check('somebody who WAS told gets the cancellation (it reaches the send, which fails with no SMTP)',
    attempted.sent === false && attempted.why === 'failed', attempted);

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => { console.error('CRASH:', e); process.exit(1); });
