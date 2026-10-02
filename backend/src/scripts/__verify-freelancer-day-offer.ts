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
import {
  listNeedsClosing, closeOutBooking, withdrawBooking, amendBooking,
  listForPerson, recordResponse as recordResponseRaw,
} from '../services/freelancer-days';

/** Thin alias so the portal cases read as what the endpoint does. */
const recordResponseViaService = (id: string, r: 'accepted' | 'declined') =>
  recordResponseRaw(id, r, null);
import { runFreelancerOfferChase } from '../services/staff-notifications';

let pass = 0, fail = 0;
function check(name: string, cond: boolean, detail?: unknown) {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}`, detail !== undefined ? JSON.stringify(detail) : ''); }
}

async function refusesTo(name: string, fn: () => Promise<unknown>, match?: RegExp) {
  try { await fn(); fail++; console.log(`  FAIL ${name} — it was ALLOWED`); }
  catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (match && !match.test(msg)) { fail++; console.log(`  FAIL ${name} — wrong error: ${msg}`); }
    else { pass++; console.log(`  ok   ${name} (${msg.slice(0, 58)})`); }
  }
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

  // ── 7. The chase (§9.4) ──────────────────────────────────────────────────
  console.log('\n7. Chasing an unanswered offer');
  // Told 3 days ago, day still in the future, never chased → due.
  const chaseMe = await createBooking({ personId: willId, bookingDate: iso(10), agreedRate: 180 }, userId);
  await query(
    `UPDATE freelancer_day_bookings SET offer_email_sent_at = NOW() - INTERVAL '3 days' WHERE id = $1`,
    [chaseMe.id]);
  // Never told (send failed / backdated record) → must NOT be chased.
  const neverSent = await createBooking({ personId: nomailId, bookingDate: iso(10), agreedRate: 100 }, userId);

  const run1 = await runFreelancerOfferChase(1);
  const chasedRow = await query(
    `SELECT offer_chased_at FROM freelancer_day_bookings WHERE id = $1`, [chaseMe.id]);
  // No SMTP here, so the nudge cannot go — and the stamp must reflect that.
  check('a failed nudge does NOT burn the single chase this booking gets',
    chasedRow.rows[0].offer_chased_at === null, chasedRow.rows[0].offer_chased_at);
  check('and it reports nothing was chased rather than claiming success',
    run1.chased === 0, run1);
  const untold = await query(
    `SELECT offer_chased_at FROM freelancer_day_bookings WHERE id = $1`, [neverSent.id]);
  check('somebody never emailed in the first place is never chased about it',
    untold.rows[0].offer_chased_at === null);

  // Pretend the nudge got through, and prove it cannot fire twice.
  await query(`UPDATE freelancer_day_bookings SET offer_chased_at = NOW() WHERE id = $1`, [chaseMe.id]);
  const before2 = await query(`SELECT offer_chased_at FROM freelancer_day_bookings WHERE id = $1`, [chaseMe.id]);
  await runFreelancerOfferChase(1);
  const after2 = await query(`SELECT offer_chased_at FROM freelancer_day_bookings WHERE id = $1`, [chaseMe.id]);
  check('an already-chased booking is left alone on the next run',
    String(before2.rows[0].offer_chased_at) === String(after2.rows[0].offer_chased_at));

  // Leg 2 — the day before, the alert goes to admin and fires once.
  const tomorrowBooking = await createBooking({ personId: willId, bookingDate: iso(1), agreedRate: 180 }, userId);
  await query(
    `UPDATE freelancer_day_bookings SET offer_email_sent_at = NOW() - INTERVAL '5 days' WHERE id = $1`,
    [tomorrowBooking.id]);
  const run3 = await runFreelancerOfferChase(1);
  const alertRow = await query(
    `SELECT admin_alerted_at, status FROM freelancer_day_bookings WHERE id = $1`, [tomorrowBooking.id]);
  check('the day-before alert fires for tomorrow', alertRow.rows[0].admin_alerted_at !== null, run3);
  check('and it does NOT auto-decline — they may still turn up (§9.4 decision 1)',
    alertRow.rows[0].status === 'offered', alertRow.rows[0].status);
  const firstAlert = String(alertRow.rows[0].admin_alerted_at);
  await runFreelancerOfferChase(1);
  const alertAgain = await query(
    `SELECT admin_alerted_at FROM freelancer_day_bookings WHERE id = $1`, [tomorrowBooking.id]);
  check('and it fires exactly once', String(alertAgain.rows[0].admin_alerted_at) === firstAlert);

  // ── 8. Closing out a passed, unanswered offer (§9.4 item 5) ──────────────
  console.log('\n8. Closing out what was never answered');
  const stale = await createBooking({ personId: willId, bookingDate: iso(-20), agreedRate: 180 }, userId);
  const needs = await listNeedsClosing();
  check('a passed unanswered offer surfaces for closing',
    needs.some(b => b.id === stale.id), needs.length);
  check('a FUTURE offer does not — it is pending, not stale',
    !needs.some(b => b.bookingDate >= iso(0)));

  const lapsed = await closeOutBooking(stale.id, 'lapsed', userId);
  check('writing it off records `lapsed`, not declined or cancelled',
    lapsed.status === 'lapsed', lapsed.status);
  const closedRow = await query(`SELECT closed_by, closed_at FROM freelancer_day_bookings WHERE id=$1`, [stale.id]);
  check('and records WHO wrote it off, and when',
    closedRow.rows[0].closed_by === userId && closedRow.rows[0].closed_at !== null);
  check('it leaves the list once closed',
    !(await listNeedsClosing()).some(b => b.id === stale.id));

  const cameAnyway = await createBooking({ personId: willId, bookingDate: iso(-21), agreedRate: 180 }, userId);
  check('"they came anyway" records a worked day',
    (await closeOutBooking(cameAnyway.id, 'completed', userId)).status === 'completed');

  await refusesTo('closing out a day that has not happened yet',
    () => closeOutBooking(chaseMe.id, 'lapsed', userId), /has not happened yet/i);
  await refusesTo('closing out something already answered',
    () => closeOutBooking(stale.id, 'lapsed', userId), /already|only an unanswered/i);

  // A lapsed day frees the slot: the live-booking index covers offered and
  // accepted only, so the same person can be offered that date again.
  const rebooked = await createBooking({ personId: willId, bookingDate: iso(-20), agreedRate: 180 }, userId);
  check('a written-off day can be booked again — lapsed is not live',
    rebooked.status === 'offered');

  // ── 9. Pulled out vs declined (§9.4 item 7) ──────────────────────────────
  console.log('\n9. Pulled out is not the same as declined');
  const pulled = await createBooking({ personId: willId, bookingDate: iso(25), agreedRate: 180 }, userId);
  await recordResponse(pulled.id, 'accepted', null);
  await refusesTo('recording an acceptance as a decline',
    () => recordResponse(pulled.id, 'declined', null), /already accepted|pulled out/i);
  const withdrawn = await withdrawBooking(pulled.id, 'Got a tour');
  check('pulling out records `withdrew`, with the reason kept',
    withdrawn.status === 'withdrew' && withdrawn.responseNote === 'Got a tour', withdrawn.status);
  const neverAccepted = await createBooking({ personId: willId, bookingDate: iso(26), agreedRate: 180 }, userId);
  await refusesTo('pulling out of a day they never accepted',
    () => withdrawBooking(neverAccepted.id, null), /only an accepted day/i);
  const freed = await createBooking({ personId: willId, bookingDate: iso(25), agreedRate: 180 }, userId);
  check('and it frees the slot — withdrew is not a live status', freed.status === 'offered');

  // ── 10. Amending (§9.4 item 6) ───────────────────────────────────────────
  console.log('\n10. Amending without cancel-and-rebook');
  const amendable = await createBooking({
    personId: willId, bookingDate: iso(30), durationType: 'hours',
    startTime: '09:00', endTime: '17:00', rateType: 'hourly', agreedRate: 20, notes: 'Van prep',
  }, userId);
  await recordResponse(amendable.id, 'accepted', null);

  const rateOnly = await amendBooking(amendable.id, { agreedRate: 25 }, userId);
  check('changing the RATE does not re-ask them',
    rateOnly.reoffered === false && rateOnly.booking.status === 'accepted', rateOnly.booking.status);
  check('but it is a change worth telling them about', rateOnly.changedDetailsOnly === true);
  check('and the expected total is recomputed, not left stale',
    rateOnly.booking.expectedTotal === 200, rateOnly.booking.expectedTotal);

  const notesOnly = await amendBooking(amendable.id, { notes: 'Warehouse instead' }, userId);
  check('changing the NOTES does not re-ask them either',
    notesOnly.reoffered === false && notesOnly.booking.status === 'accepted');

  const timeMoved = await amendBooking(amendable.id, { startTime: '11:00' }, userId);
  check('moving the HOURS re-opens the question',
    timeMoved.reoffered === true && timeMoved.booking.status === 'offered', timeMoved.booking.status);
  const reofferRow = await query(
    `SELECT reoffered_at, amended_at, responded_at, offer_chased_at, admin_alerted_at
       FROM freelancer_day_bookings WHERE id = $1`, [amendable.id]);
  check('the acceptance is cleared — it was for the old hours',
    reofferRow.rows[0].responded_at === null);
  check('the chase stamps reset, so the NEW question gets its own nudge',
    reofferRow.rows[0].offer_chased_at === null && reofferRow.rows[0].admin_alerted_at === null);
  check('and both amended_at and reoffered_at are recorded',
    reofferRow.rows[0].amended_at !== null && reofferRow.rows[0].reoffered_at !== null);

  await recordResponse(amendable.id, 'accepted', null);
  const dayMoved = await amendBooking(amendable.id, { bookingDate: iso(31) }, userId);
  check('moving the DAY re-opens it too — a different day is a different commitment',
    dayMoved.reoffered === true && dayMoved.booking.status === 'offered');

  const noop = await amendBooking(amendable.id, { notes: dayMoved.booking.notes }, userId);
  check('an amendment that changes nothing is a no-op, not a spurious email',
    noop.reoffered === false && noop.changedDetailsOnly === false);

  // Validation still applies on the way in.
  await refusesTo('an amendment with the end before the start',
    () => amendBooking(amendable.id, { startTime: '15:00', endTime: '14:00' }, userId),
    /end time needs to be after the start/i);
  await refusesTo('amending a cancelled booking',
    () => amendBooking(killed.id, { agreedRate: 1 }, userId), /cancelled/i);
  await refusesTo('amending a day already worked',
    () => amendBooking(cameAnyway.id, { agreedRate: 1 }, userId), /done|rewrite/i);

  // Switching a timed day to a whole one must drop the times, or the
  // freelancer_day_times CHECK rejects the update.
  const toFullDay = await amendBooking(amendable.id, { durationType: 'full_day', rateType: 'day' }, userId);
  check('switching to a full day clears the times rather than hitting the CHECK',
    toFullDay.booking.durationType === 'full_day'
      && toFullDay.booking.startTime === null && toFullDay.booking.endTime === null,
    toFullDay.booking);

  // The one-live-booking index has to survive an amendment too.
  const clash = await createBooking({ personId: willId, bookingDate: iso(40), agreedRate: 180 }, userId);
  await createBooking({ personId: willId, bookingDate: iso(41), agreedRate: 180 }, userId);
  await refusesTo('amending a booking onto a day they are already booked',
    () => amendBooking(clash.id, { bookingDate: iso(41) }, userId), /already booked/i);

  // ── 11. What the portal shows and accepts (§9.3) ─────────────────────────
  // The portal endpoints are thin: the SERVICE owns every rule. What is tested
  // here is that the rules exist at all for a logged-in freelancer, because the
  // token path and the portal path are two doors into the same room.
  console.log('\n11. The portal view');
  const other = await query(
    `INSERT INTO people (first_name,last_name,is_freelancer,created_by)
     VALUES ('Someone','Else',true,$1) RETURNING id`, [userId]);
  const otherId = other.rows[0].id as string;

  const mine = await createBooking({ personId: willId, bookingDate: iso(50), agreedRate: 180 }, userId);
  const theirs = await createBooking({ personId: otherId, bookingDate: iso(50), agreedRate: 180 }, userId);

  const willDays = await listForPerson(willId, { limit: 200 });
  check('a freelancer sees their own days',
    willDays.some(b => b.id === mine.id));
  check('and NEVER somebody else\'s',
    !willDays.some(b => b.id === theirs.id), theirs.id);

  // The portal's respond path goes through recordResponse, so the same guards
  // apply as the emailed link: an answered day cannot be answered again.
  await recordResponseViaService(mine.id, 'accepted');
  const reAnswer = await getBooking(mine.id);
  check('accepting through the portal records it', reAnswer?.status === 'accepted');
  await refusesTo('answering a day they already accepted',
    () => recordResponseViaService(mine.id, 'declined'),
    /already accepted|pulled out/i);

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => { console.error('CRASH:', e); process.exit(1); });
