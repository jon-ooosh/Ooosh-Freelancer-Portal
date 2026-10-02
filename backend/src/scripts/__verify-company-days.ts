/**
 * Company days (spec §20) against a REAL Postgres with every migration applied.
 *
 *   DATABASE_URL=postgresql://…/scratch… npx tsx src/scripts/__verify-company-days.ts
 *
 * Wants its OWN database — company days apply to everybody, so another
 * script's staff fixtures change what the calendar and the reclaim see.
 * Refuses to run unless the database name says scratch.
 */
import { query } from '../config/database';
import { upsertEmployment, createPattern } from '../services/staff-employment';
import { getStaffCalendar } from '../services/staff-day-status';
import { getBalance, syncEntitlement } from '../services/staff-balance';
import { getImpact, createRequest, approveRequest } from '../services/staff-leave';
import {
  createCompanyDay, cancelCompanyDay, listCompanyDays, listOccurrences,
  getCompanyDayOverlay, getCompanyReclaimCandidates, reclaimForCompanyDay,
  occurrencesInRange,
} from '../services/staff-company-days';
import { runCompanyDaysReview } from '../services/staff-notifications';
import { setSystemSetting, invalidateSystemSettingsCache } from '../routes/system-settings';

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
    else { pass++; console.log(`  ok   ${name} (${msg.slice(0, 60)})`); }
  }
}

async function main() {
  if (!/scratch|_test\b/.test(process.env.DATABASE_URL ?? '')) {
    console.error('Refusing to run: DATABASE_URL must name a scratch database.');
    process.exit(1);
  }
  const tag = Math.random().toString(36).slice(2, 8);

  // ── 1. Recurrence, as pure arithmetic ────────────────────────────────────
  console.log('\n1. Resolving recurrence');
  const xmas = { id: 'x', dayDate: '2026-12-25', label: 'Christmas Day', recurs: true };
  check('a recurring day lands in every year of the window',
    occurrencesInRange(xmas, '2025-01-01', '2028-12-31').map(o => o.date).join() ===
    '2025-12-25,2026-12-25,2027-12-25,2028-12-25',
    occurrencesInRange(xmas, '2025-01-01', '2028-12-31').map(o => o.date));
  check('including years BEFORE it was entered — it is a rule, not a start date',
    occurrencesInRange(xmas, '2024-01-01', '2024-12-31')[0]?.date === '2024-12-25');
  const oneOff = { id: 'o', dayDate: '2026-12-29', label: 'Office closed', recurs: false };
  check('a one-off appears only in its own year',
    occurrencesInRange(oneOff, '2025-01-01', '2028-12-31').length === 1);
  check('and not at all outside the window',
    occurrencesInRange(oneOff, '2027-01-01', '2027-12-31').length === 0);

  const leapDay = { id: 'l', dayDate: '2028-02-29', label: 'Leap day', recurs: true };
  const leapOccs = occurrencesInRange(leapDay, '2026-01-01', '2032-12-31').map(o => o.date);
  check('29 February is SKIPPED in a common year rather than slid to the 28th',
    leapOccs.join() === '2028-02-29,2032-02-29', leapOccs);

  // ── Fixture ──────────────────────────────────────────────────────────────
  await query(`ALTER TABLE people ALTER COLUMN created_by DROP NOT NULL`);
  await query(`ALTER TABLE users  ALTER COLUMN person_id  DROP NOT NULL`);
  const u = await query(`INSERT INTO users (email,password_hash,role,is_active) VALUES ($1,'x','admin',true) RETURNING id`, [`cd-${tag}@oooshtours.co.uk`]);
  const userId = u.rows[0].id;
  const p = await query(`INSERT INTO people (first_name,last_name,email,created_by) VALUES ('Comp','Day',$2,$1) RETURNING id`, [userId, `cd-${tag}@oooshtours.co.uk`]);
  const personId = p.rows[0].id;
  await query(`UPDATE users SET person_id=$1 WHERE id=$2`, [personId, userId]);
  await query(`ALTER TABLE people ALTER COLUMN created_by SET NOT NULL`);
  await query(`ALTER TABLE users  ALTER COLUMN person_id  SET NOT NULL`);

  await upsertEmployment(personId, { startDate: '2026-01-01', jobTitle: 'T' }, userId);
  await createPattern(personId, '2026-01-01', [
    ...[0,1,2,3,4].map(weekday => ({ weekday, isWorking: true, startTime: '09:00', endTime: '17:00', breakMinutes: 60 })),
    { weekday: 5, isWorking: false }, { weekday: 6, isWorking: false },
  ], {}, userId);
  await syncEntitlement(personId, 2027, userId);

  // ── 2. Creating them ─────────────────────────────────────────────────────
  console.log('\n2. Adding company days');
  const christmas = await createCompanyDay(
    { dayDate: '2026-12-25', label: 'Christmas Day', recurs: true }, userId);
  check('a recurring day is created', christmas.recurs === true);
  await refuses('a second recurring day on the same month and day',
    () => createCompanyDay({ dayDate: '2030-12-25', label: 'Christmas again', recurs: true }, userId),
    /already a recurring company day/i);

  // 2027-12-29 is a Wednesday — a contracted day for this fixture.
  const closure = await createCompanyDay(
    { dayDate: '2027-12-29', label: 'Office closed', recurs: false }, userId);
  check('a one-off day is created', closure.recurs === false);
  await refuses('a second one-off on the same date',
    () => createCompanyDay({ dayDate: '2027-12-29', label: 'Again', recurs: false }, userId),
    /already a company day/i);
  await refuses('a day with no name', () => createCompanyDay(
    { dayDate: '2027-06-01', label: '   ' }, userId), /name/i);

  // ── 3. What the calendar does with them ──────────────────────────────────
  console.log('\n3. The calendar');
  const dec = (await getStaffCalendar('2027-12-27', '2027-12-31', { isAdmin: true, personId }))[0];
  const d29 = dec.days.find(d => d.date === '2027-12-29')!;
  check('a company day is not scheduled', d29.status === 'not_scheduled', d29.status);
  check('it carries its label so the grid can say why',
    d29.companyDay === 'Office closed', d29.companyDay);
  check('and costs no contracted minutes', d29.scheduledMinutes === 0);
  const d28 = dec.days.find(d => d.date === '2027-12-28')!;
  check('the day beside it is untouched', d28.status === 'working' && d28.scheduledMinutes === 420, d28);

  // 25 Dec 2027 is a Saturday, already a non-working day for this pattern.
  const xmasWeek = (await getStaffCalendar('2027-12-25', '2027-12-25', { isAdmin: true, personId }))[0];
  check('a company day on a day they already had off is left unlabelled',
    xmasWeek.days[0].status === 'not_scheduled' && xmasWeek.days[0].companyDay === undefined,
    xmasWeek.days[0]);

  // ── 4. It falls out that nothing can be booked on it ─────────────────────
  console.log('\n4. Knock-on effects');
  const impact = await getImpact(personId, '2027-12-29', '2027-12-29', 'holiday');
  check('leave cannot be priced on a company day', impact.workingDays === 0, impact.workingDays);
  check('and the request says so plainly',
    impact.warnings.some(w => /contracted to work/i.test(w)), impact.warnings);

  // Mon 27 to Fri 31 December 2027 is five contracted days, less the company
  // day on the Wednesday. The 27th and 28th ARE bank holidays, and under the
  // use_allowance policy they are charged like any other day — which is the
  // distinction between the two concepts, visible in one assertion.
  const spanning = await getImpact(personId, '2027-12-27', '2027-12-31', 'holiday');
  check('a week spanning it charges the other four days',
    spanning.days.length === 4 && !spanning.days.some(d => d.date === '2027-12-29'),
    spanning.days.map(d => d.date));
  check('…including the bank holidays, which are NOT days off here',
    spanning.days.some(d => d.date === '2027-12-27'), spanning.days.map(d => d.date));

  // ── 5. Giving back holiday it overtook (§20.3) ───────────────────────────
  console.log('\n5. Reclaiming holiday it landed on');
  // Book a day FIRST, then make it a company day — the real sequence.
  const reqId = await createRequest({ personId, leaveType: 'holiday',
    startDate: '2027-11-10', endDate: '2027-11-10' }, userId);
  await approveRequest(reqId, null, userId);
  const booked = await getBalance(personId, 'holiday', 2027);

  const nov = await createCompanyDay(
    { dayDate: '2027-11-10', label: 'Anniversary closure', recurs: false }, userId);
  const cands = await getCompanyReclaimCandidates(nov.id);
  check('the booked day is offered back', cands.length === 1 && cands[0].date === '2027-11-10', cands);
  check('naming who it belongs to', cands[0]?.personId === personId);

  const r = await reclaimForCompanyDay(nov.id, cands.map(c => c.dayId), userId);
  check('giving it back credits the right minutes', r.minutes === 420, r);
  const after = await getBalance(personId, 'holiday', 2027);
  check('the allowance goes back up by exactly that',
    after.balanceMinutes === booked.balanceMinutes + 420,
    { booked: booked.balanceMinutes, after: after.balanceMinutes });
  check('the same day cannot be given back twice',
    (await getCompanyReclaimCandidates(nov.id)).length === 0);
  const entry = await query(
    `SELECT entry_type, minutes, note FROM staff_ledger_entries
      WHERE person_id = $1 AND effective_date = '2027-11-10' AND minutes > 0`, [personId]);
  check('posted as a correction, per §7.4\'s mechanism',
    entry.rows[0]?.entry_type === 'correction', entry.rows[0]);
  const stillApproved = await query(`SELECT status FROM staff_leave_requests WHERE id = $1`, [reqId]);
  check('the original request is untouched', stillApproved.rows[0].status === 'approved');

  // ── 6. Withdrawing one ───────────────────────────────────────────────────
  console.log('\n6. Withdrawing');
  await cancelCompanyDay(closure.id, 'Decided to open after all', userId);
  const reopened = (await getStaffCalendar('2027-12-29', '2027-12-29', { isAdmin: true, personId }))[0];
  check('the day goes back to being a working day',
    reopened.days[0].status === 'working', reopened.days[0].status);
  check('it drops out of the active list',
    !(await listCompanyDays()).some(d => d.id === closure.id));
  check('…and is still there when asked for',
    (await listCompanyDays({ includeCancelled: true })).some(d => d.id === closure.id));
  await refuses('withdrawing it twice',
    () => cancelCompanyDay(closure.id, 'again', userId), /already cancelled/i);

  const balBefore = (await getBalance(personId, 'holiday', 2027)).balanceMinutes;
  await cancelCompanyDay(nov.id, 'Testing the unwind', userId);
  check('withdrawing a day does NOT re-charge holiday that was given back',
    (await getBalance(personId, 'holiday', 2027)).balanceMinutes === balBefore);

  // ── 7. The annual prompt ─────────────────────────────────────────────────
  console.log('\n7. The November prompt');
  const notNov = await runCompanyDaysReview(new Date(Date.UTC(2027, 5, 10)));
  check('it stays quiet in June',
    !notNov.sent && notNov.skippedReason === 'not the review month', notNov);
  const sent = await runCompanyDaysReview(new Date(Date.UTC(2027, 10, 3)));
  check('it asks in November', sent.sent && sent.year === 2028, sent);
  check('listing what already recurs', sent.recurring.includes('Christmas Day'), sent.recurring);
  const again = await runCompanyDaysReview(new Date(Date.UTC(2027, 10, 20)));
  check('and only once', !again.sent && again.skippedReason === 'already asked for this year', again);

  await setSystemSetting('staff.company_days_review_month', '9');
  invalidateSystemSettingsCache();
  const moved = await runCompanyDaysReview(new Date(Date.UTC(2027, 10, 3)));
  check('the review month is configurable',
    !moved.sent && moved.skippedReason === 'not the review month', moved);

  // ── 8. Occurrences for a year ────────────────────────────────────────────
  console.log('\n8. Reading a year');
  const occ2028 = await listOccurrences(2028);
  check('Christmas recurs into a year with no rows of its own',
    occ2028.some(o => o.date === '2028-12-25'), occ2028.map(o => o.date));
  const overlay = await getCompanyDayOverlay('2028-01-01', '2028-12-31');
  check('the overlay agrees with the list', overlay.size === occ2028.length);

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
}
main().catch(e => { console.error('\nCRASH:', e); process.exit(1); });
