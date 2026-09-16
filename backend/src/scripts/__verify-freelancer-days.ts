/**
 * Phase E — freelancer day bookings, against a REAL Postgres.
 *
 *   DATABASE_URL=postgresql://…/scratch… npx tsx src/scripts/__verify-freelancer-days.ts
 *
 * Wants its own scratch database; the spend summary is company-wide, so another
 * script's bookings would change the totals.
 */
import { query } from '../config/database';
import { upsertEmployment, createPattern } from '../services/staff-employment';
import {
  createBooking, recordResponse, markCompleted, cancelBooking, recordInvoice,
  listForRange, listBookableFreelancers, getSpendSummary, computeExpectedTotal,
  hoursBetween,
} from '../services/freelancer-days';

let pass = 0, fail = 0;
function check(name: string, cond: boolean, detail?: unknown) {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}`, detail !== undefined ? JSON.stringify(detail) : ''); }
}
async function refuses(name: string, fn: () => Promise<unknown>, match?: RegExp) {
  try { await fn(); fail++; console.log(`  FAIL ${name} — it was ALLOWED`); }
  catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (match && !match.test(msg)) { fail++; console.log(`  FAIL ${name} — wrong error: ${msg}`); }
    else { pass++; console.log(`  ok   ${name} (${msg.slice(0, 62)})`); }
  }
}

async function main() {
  if (!/scratch|_test\b/.test(process.env.DATABASE_URL ?? '')) {
    console.error('Refusing to run: DATABASE_URL must name a scratch database.');
    process.exit(1);
  }
  const tag = Math.random().toString(36).slice(2, 8);

  // ── 1. The money arithmetic, pure ────────────────────────────────────────
  console.log('\n1. What a booking is expected to cost');
  check('a day rate is the day rate',
    computeExpectedTotal({ rateType: 'day', agreedRate: 180, durationType: 'full_day' }) === 180);
  check('a half-day rate is taken as agreed, not halved again',
    computeExpectedTotal({ rateType: 'half_day', agreedRate: 100, durationType: 'half_day' }) === 100);
  check('hourly multiplies by the hours',
    computeExpectedTotal({ rateType: 'hourly', agreedRate: 20, durationType: 'hours',
      startTime: '09:00', endTime: '17:30' }) === 170, 
    computeExpectedTotal({ rateType: 'hourly', agreedRate: 20, durationType: 'hours',
      startTime: '09:00', endTime: '17:30' }));
  check('a fixed price is taken at face value',
    computeExpectedTotal({ rateType: 'fixed', agreedRate: 250, durationType: 'hours',
      startTime: '09:00', endTime: '12:00' }) === 250);
  check('no rate means no expected total',
    computeExpectedTotal({ rateType: 'day', agreedRate: null, durationType: 'full_day' }) === null);
  check('hourly with no times cannot be totalled',
    computeExpectedTotal({ rateType: 'hourly', agreedRate: 20, durationType: 'hours' }) === null);
  check('hours are counted to the half', hoursBetween('09:00', '17:30') === 8.5);

  // ── Fixture ──────────────────────────────────────────────────────────────
  await query(`ALTER TABLE people ALTER COLUMN created_by DROP NOT NULL`);
  await query(`ALTER TABLE users  ALTER COLUMN person_id  DROP NOT NULL`);
  const u = await query(`INSERT INTO users (email,password_hash,role,is_active) VALUES ($1,'x','admin',true) RETURNING id`, [`fd-${tag}@oooshtours.co.uk`]);
  const userId = u.rows[0].id;
  const admin = await query(`INSERT INTO people (first_name,last_name,email,created_by) VALUES ('Ad','Min',$2,$1) RETURNING id`, [userId, `fd-${tag}@oooshtours.co.uk`]);
  await query(`UPDATE users SET person_id=$1 WHERE id=$2`, [admin.rows[0].id, userId]);
  await query(`ALTER TABLE people ALTER COLUMN created_by SET NOT NULL`);
  await query(`ALTER TABLE users  ALTER COLUMN person_id  SET NOT NULL`);

  const free = await query(
    `INSERT INTO people (first_name, last_name, preferred_name, email, is_freelancer, created_by, default_day_rate, default_half_day_rate)
     VALUES ('Robert','Hands','Bob',$2,true,$1,180,100) RETURNING id`,
    [userId, `bob-${tag}@example.com`]);
  const bobId = free.rows[0].id;

  // A staff member, to prove they cannot be booked as a freelancer.
  const st = await query(`INSERT INTO people (first_name,last_name,email,created_by) VALUES ('Staff','Member',$2,$1) RETURNING id`,
    [userId, `staff-${tag}@oooshtours.co.uk`]);
  const staffId = st.rows[0].id;
  await upsertEmployment(staffId, { startDate: '2026-01-01', jobTitle: 'T' }, userId);
  await createPattern(staffId, '2026-01-01', [
    ...[0,1,2,3,4].map(weekday => ({ weekday, isWorking: true, startTime: '09:00', endTime: '17:00', breakMinutes: 60 })),
    { weekday: 5, isWorking: false }, { weekday: 6, isWorking: false },
  ], {}, userId);

  // ── 2. Who can be booked ─────────────────────────────────────────────────
  console.log('\n2. Who can be booked');
  const bookable = await listBookableFreelancers();
  const bob = bookable.find(b => b.personId === bobId);
  check('a freelancer is offered, under the name they go by',
    bob?.name === 'Bob Hands', bob?.name);
  check('with their default rates to pre-fill',
    bob?.defaultDayRate === 180 && bob?.defaultHalfDayRate === 100, bob);
  check('a staff member is NOT offered', !bookable.some(b => b.personId === staffId));
  await refuses('booking a staff member as a freelancer',
    () => createBooking({ personId: staffId, bookingDate: '2026-10-07' }, userId),
    /staff, not a freelancer/i);

  // ── 3. Booking ───────────────────────────────────────────────────────────
  console.log('\n3. Booking a day');
  const b1 = await createBooking({
    personId: bobId, bookingDate: '2026-10-07', durationType: 'full_day',
    rateType: 'day', agreedRate: 180, notes: 'Van prep',
  }, userId);
  check('it starts as an OFFER, not a commitment', b1.status === 'offered', b1.status);
  check('the agreed rate is snapshot on the booking', b1.agreedRate === 180);
  check('and the expected total computed', b1.expectedTotal === 180);

  await refuses('a second live booking for the same person that day',
    () => createBooking({ personId: bobId, bookingDate: '2026-10-07' }, userId),
    /already booked that day/i);
  await refuses('times on a full-day booking',
    () => createBooking({ personId: bobId, bookingDate: '2026-10-08',
      durationType: 'full_day', startTime: '09:00', endTime: '17:00' }, userId),
    /only a timed booking carries times/i);
  await refuses('a timed booking with no times',
    () => createBooking({ personId: bobId, bookingDate: '2026-10-08', durationType: 'hours' }, userId),
    /needs both a start and an end/i);
  await refuses('an hourly rate on a whole day',
    () => createBooking({ personId: bobId, bookingDate: '2026-10-08',
      durationType: 'full_day', rateType: 'hourly', agreedRate: 20 }, userId),
    /hourly rate needs the hours/i);

  const b2 = await createBooking({
    personId: bobId, bookingDate: '2026-10-08', durationType: 'hours',
    startTime: '09:00', endTime: '13:00', rateType: 'hourly', agreedRate: 20,
  }, userId);
  check('a timed booking totals from the hours', b2.expectedTotal === 80, b2.expectedTotal);

  // ── 4. The calendar lane ─────────────────────────────────────────────────
  console.log('\n4. What the calendar sees');
  const lane = await listForRange('2026-10-05', '2026-10-11');
  check('both bookings appear', lane.length === 2, lane.map(x => x.bookingDate));

  await recordResponse(b1.id, 'accepted', null);
  const declined = await createBooking({ personId: bobId, bookingDate: '2026-10-09' }, userId);
  await recordResponse(declined.id, 'declined', 'Already working that day');
  const afterDecline = await listForRange('2026-10-05', '2026-10-11');
  check('a DECLINED day leaves the calendar — the headcount must not count it',
    !afterDecline.some(x => x.id === declined.id), afterDecline.map(x => x.status));
  check('a declined booking frees the date for another offer',
    (await createBooking({ personId: bobId, bookingDate: '2026-10-09' }, userId)).status === 'offered');

  // ── 5. Completing and invoicing ──────────────────────────────────────────
  console.log('\n5. Doing the work and being paid for it');
  const done = await markCompleted(b1.id);
  check('a day can be marked done', done.status === 'completed');
  await refuses('marking a declined day done', () => markCompleted(declined.id), /declined/i);

  const invoiced = await recordInvoice(b1.id, { received: true, amount: 180 });
  check('the invoice is recorded', invoiced.invoiceReceived && invoiced.invoiceAmount === 180);
  const queried = await recordInvoice(b2.id, { received: true, amount: 120, queried: true, queryNotes: 'Expected 80' });
  check('and can be flagged when it differs from what was expected',
    queried.invoiceQueried === true, queried);

  // ── 6. Expected spend ────────────────────────────────────────────────────
  console.log('\n6. What it is expected to cost');
  const spend = await getSpendSummary('2026-10-01', '2026-10-31');
  check('completed days are counted', spend.completedDays === 1, spend);
  check('expected spend sums live and completed days only',
    spend.expectedTotal === 180 + 80, spend.expectedTotal);
  check('invoiced total is what actually arrived',
    spend.invoicedTotal === 180 + 120, spend.invoicedTotal);
  check('a queried invoice is surfaced', spend.queried === 1, spend.queried);

  // ── 7. Cancelling ────────────────────────────────────────────────────────
  console.log('\n7. Cancelling');
  const c = await cancelBooking(b2.id, 'No longer needed', userId);
  check('it cancels', c.status === 'cancelled');
  check('and leaves the calendar',
    !(await listForRange('2026-10-05', '2026-10-11')).some(x => x.id === b2.id));
  await refuses('cancelling twice', () => cancelBooking(b2.id, 'again', userId), /already cancelled/i);

  // ── 8. Nothing here touches staff time ───────────────────────────────────
  console.log('\n8. Separation from staff time (spec §9.1)');
  const ledger = await query(
    `SELECT COUNT(*) AS n FROM staff_ledger_entries WHERE person_id = $1`, [bobId]);
  check('a freelancer gets NO ledger entries', Number(ledger.rows[0].n) === 0);
  const emp = await query(
    `SELECT COUNT(*) AS n FROM staff_employment WHERE person_id = $1`, [bobId]);
  check('and no employment record', Number(emp.rows[0].n) === 0);
  const pat = await query(
    `SELECT COUNT(*) AS n FROM staff_working_patterns WHERE person_id = $1`, [bobId]);
  check('and no working pattern', Number(pat.rows[0].n) === 0);

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
}
main().catch(e => { console.error('\nCRASH:', e); process.exit(1); });
