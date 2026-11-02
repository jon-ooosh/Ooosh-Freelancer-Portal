/**
 * Changing and cancelling APPROVED time off (spec §5.4, Oct 2026), against a
 * REAL Postgres with every migration applied — the same reason as the other
 * __verify scripts: the bugs in this module have been in the SQL (triggers,
 * partial indexes, the ledger's constraints), where a unit test cannot see.
 *
 *   createdb ooosh_scratch
 *   DATABASE_URL=postgresql://…/ooosh_scratch npx tsx src/migrations/run.ts up
 *   DATABASE_URL=postgresql://…/ooosh_scratch npx tsx src/scripts/__verify-leave-changes.ts
 *
 * Dates are relative to today, because "days already gone" is the rule under
 * test. IT WRITES (and briefly relaxes two NOT NULL constraints for its
 * fixture), so it REFUSES a database whose name does not say scratch.
 */
import { query } from '../config/database';
import { upsertEmployment, createPattern } from '../services/staff-employment';
import {
  createRequest, approveRequest, declineRequest, withdrawRequest, cancelRequest,
  getRequest, listRequests, getImpact, countPending,
  askToCancel, withdrawCancelAsk, approveCancelAsk, declineCancelAsk,
} from '../services/staff-leave';
import { getBalance, ensureEntitlement } from '../services/staff-balance';
import { getLeaveOverlay, addDaysYmd } from '../services/staff-day-status';
import { createCompanyDay, getCompanyReclaimCandidates, reclaimForCompanyDay } from '../services/staff-company-days';
import { createAbsence, getReclaimCandidates, reclaimLeaveDays } from '../services/staff-absence';
import { ukToday } from '../services/uk-date';

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
    else { pass++; console.log(`  ok   ${name} (${msg.slice(0, 80)})`); }
  }
}

async function main() {
  const dbUrl = process.env.DATABASE_URL ?? '';
  if (!/scratch|_test\b/.test(dbUrl)) {
    console.error('Refusing to run: DATABASE_URL must name a scratch database.');
    process.exit(1);
  }

  const T = ukToday();
  const d = (n: number) => addDaysYmd(T, n);
  const year = Number(T.slice(0, 4));
  const tag = Math.random().toString(36).slice(2, 8);

  // ── Fixture: one person working all seven days, 450 minutes each ─────────
  // Every date is a working day, so the arithmetic below is days × 450.
  await query(`ALTER TABLE people ALTER COLUMN created_by DROP NOT NULL`);
  await query(`ALTER TABLE users  ALTER COLUMN person_id  DROP NOT NULL`);
  const u = await query(
    `INSERT INTO users (email, password_hash, role, is_active)
     VALUES ($1,'x','admin',true) RETURNING id`, [`lc-${tag}@oooshtours.co.uk`]);
  const userId = u.rows[0].id as string;
  const p = await query(
    `INSERT INTO people (first_name, last_name, email, created_by)
     VALUES ('Change','Tester',$2,$1) RETURNING id`, [userId, `lc-${tag}@oooshtours.co.uk`]);
  const personId = p.rows[0].id as string;
  await query(`UPDATE users SET person_id = $1 WHERE id = $2`, [personId, userId]);
  await query(`ALTER TABLE people ALTER COLUMN created_by SET NOT NULL`);
  await query(`ALTER TABLE users  ALTER COLUMN person_id  SET NOT NULL`);

  await upsertEmployment(personId, { startDate: `${year - 1}-01-01`, jobTitle: 'Tester' }, userId);
  await createPattern(personId, `${year - 1}-01-01`,
    [0, 1, 2, 3, 4, 5, 6].map(weekday => ({
      weekday, isWorking: true, startTime: '09:00', endTime: '17:30', breakMinutes: 60,
    })), {}, userId);

  const bal = async (y = year) => (await getBalance(personId, 'holiday', y)).balanceMinutes;
  const book = async (from: string, to: string, halfDays = {}) => {
    const id = await createRequest({ personId, leaveType: 'holiday', startDate: from, endDate: to, halfDays }, userId);
    await approveRequest(id, null, userId);
    return id;
  };
  const liveDays = async (requestId: string) => (await query(
    `SELECT COUNT(*)::int AS n FROM staff_leave_request_days WHERE request_id = $1 AND is_live`, [requestId])).rows[0].n as number;

  // Keep the whole run inside one leave year so the balance checks are simple.
  if (d(60).slice(0, 4) !== String(year) || d(-5).slice(0, 4) !== String(year)) {
    console.log('Skipping: too close to a year boundary for this script’s arithmetic. Re-run in a week.');
    process.exit(0);
  }

  // Grant the year's allowance first — it is granted lazily on read, so
  // without this the first preview would grant it mid-test.
  await ensureEntitlement(personId, year);
  const start = await bal();
  console.log(`Fixture ready — holiday balance ${start}m, today ${T}`);

  // ── 1. A change waits, and changes nothing while it does ─────────────────
  console.log('\n1. Asking to move a booking one day later');
  const a = await book(d(20), d(24));
  check('booking 5 days costs 5 × 450', (await bal()) === start - 2250, await bal());

  await refuses('a change without a note',
    () => createRequest({ personId, leaveType: 'holiday', startDate: d(21), endDate: d(25), replacesRequestId: a }, userId),
    /note is required/i);
  await refuses('a "change" that changes nothing',
    () => createRequest({ personId, leaveType: 'holiday', startDate: d(20), endDate: d(24), note: 'x', replacesRequestId: a }, userId),
    /nothing to change/i);

  const preview = await getImpact(personId, d(21), d(25), 'holiday', {}, undefined, { replacesRequestId: a });
  check('preview: moving by a day is net zero', preview.change?.minutes === 0, preview.change);
  check('preview: only the added day counts as changed', JSON.stringify(preview.change?.changedDates) === JSON.stringify([d(25)]), preview.change);
  check('preview: no own-clash with the booking it replaces', preview.ownClashes.length === 0, preview.ownClashes);

  const c1 = await createRequest({ personId, leaveType: 'holiday', startDate: d(21), endDate: d(25),
    note: 'Moving it a day', replacesRequestId: a }, userId);
  const orig1 = await getRequest(a);
  const ch1 = await getRequest(c1);
  check('the change waits', ch1?.status === 'pending' && ch1.replacesRequestId === a, ch1?.status);
  check('…and its days are not live', (await liveDays(c1)) === 0);
  check('the original still stands, and knows a change is waiting', orig1?.status === 'approved' && orig1.pendingChangeId === c1);
  check('the balance has not moved', (await bal()) === start - 2250);
  const overlay = (await getLeaveOverlay([personId], d(20), d(25))).get(personId) ?? [];
  check('the calendar still shows the original days only',
    overlay.map(o => o.date).join() === [20, 21, 22, 23, 24].map(d).join(), overlay.map(o => o.date));
  check('a waiting change counts as waiting', (await countPending()) >= 1);

  await refuses('a second change while one waits',
    () => createRequest({ personId, leaveType: 'holiday', startDate: d(22), endDate: d(26), note: 'again', replacesRequestId: a }, userId),
    /already waiting/i);
  await refuses('an ask to cancel while a change waits',
    () => askToCancel(a, personId, 'actually cancel', userId), /already waiting/i);
  await refuses('a direct cancel while a change waits',
    () => cancelRequest(a, 'admin', userId), /change to this booking is waiting/i);

  // ── 2. Approving swaps old for new in one go ─────────────────────────────
  console.log('\n2. Approving the change');
  await approveRequest(c1, null, userId);
  const orig1b = await getRequest(a);
  const ch1b = await getRequest(c1);
  check('original is cancelled, with the reason', orig1b?.status === 'cancelled' && /^Changed to/.test(orig1b.cancellationReason ?? ''), orig1b?.cancellationReason);
  check('original knows what replaced it', orig1b?.replacedById === c1);
  check('the change is approved and live', ch1b?.status === 'approved' && (await liveDays(c1)) === 5);
  check('the original is no longer live', (await liveDays(a)) === 0);
  check('the balance is the same five days', (await bal()) === start - 2250, await bal());
  const led = await query(
    `SELECT source_id, entry_type, SUM(minutes)::int AS m FROM staff_ledger_entries
      WHERE person_id = $1 AND source_id IN ($2, $3) GROUP BY 1, 2 ORDER BY 1, 2`, [personId, a, c1]);
  check('ledger shows both facts: original booked and given back, new one booked',
    led.rows.length === 3
    && led.rows.some(r => r.source_id === a && r.entry_type === 'booking' && r.m === -2250)
    && led.rows.some(r => r.source_id === a && r.entry_type === 'cancellation' && r.m === 2250)
    && led.rows.some(r => r.source_id === c1 && r.entry_type === 'booking' && r.m === -2250), led.rows);

  // ── 3. Taking one day out of the middle ──────────────────────────────────
  console.log('\n3. Removing a day from the middle');
  const gap = { [d(23)]: { portion: 'none' as const } };
  const pv2 = await getImpact(personId, d(21), d(25), 'holiday', gap, undefined, { replacesRequestId: c1 });
  check('preview gives one day back', pv2.change?.minutes === -450, pv2.change);
  check('preview lists the day as not off', JSON.stringify(pv2.notOff) === JSON.stringify([d(23)]), pv2.notOff);
  check('preview: removing days raises no cover or notice warning',
    pv2.change?.changedDates.length === 0 && pv2.coverage.length === 0, pv2.warnings);
  const c2 = await createRequest({ personId, leaveType: 'holiday', startDate: d(21), endDate: d(25),
    halfDays: gap, note: 'Need to be in on that day', replacesRequestId: c1 }, userId);
  await approveRequest(c2, null, userId);
  const ch2 = await getRequest(c2);
  check('four days left, the gap day gone', ch2?.days.map(x => x.date).join() === [21, 22, 24, 25].map(d).join(), ch2?.days.map(x => x.date));
  check('the balance gave one day back', (await bal()) === start - 1800, await bal());
  check('a booking changed twice still reads as changed, not cancelled',
    (await getRequest(a))?.replacedById === c1 && (await getRequest(c1))?.replacedById === c2);

  // ── 4. Declined and withdrawn changes leave the booking alone ────────────
  console.log('\n4. Declining and withdrawing a change');
  const c3 = await createRequest({ personId, leaveType: 'holiday', startDate: d(21), endDate: d(22),
    note: 'Shorter', replacesRequestId: c2 }, userId);
  await declineRequest(c3, 'Not this week', userId);
  check('declined: the booking stands', (await getRequest(c2))?.status === 'approved' && (await liveDays(c2)) === 4);
  check('declined: balance untouched', (await bal()) === start - 1800);
  const c4 = await createRequest({ personId, leaveType: 'holiday', startDate: d(21), endDate: d(22),
    note: 'Shorter, again', replacesRequestId: c2 }, userId);
  await withdrawRequest(c4, personId);
  check('withdrawn: the booking stands', (await getRequest(c2))?.status === 'approved' && (await getRequest(c2))?.pendingChangeId === null);

  // ── 5. Asking to cancel ──────────────────────────────────────────────────
  console.log('\n5. Asking to cancel');
  await askToCancel(c2, personId, 'Trip called off', userId);
  let r5 = await getRequest(c2);
  check('the ask is recorded', r5?.cancelAsk?.note === 'Trip called off' && !r5.cancelAsk.declinedAt);
  check('it is on the approvals list', (await listRequests({ cancelAsked: true })).some(x => x.id === c2));
  await refuses('asking twice', () => askToCancel(c2, personId, 'again', userId), /already an ask/i);
  await refuses('a change while a cancel ask waits',
    () => createRequest({ personId, leaveType: 'holiday', startDate: d(21), endDate: d(22), note: 'x', replacesRequestId: c2 }, userId),
    /ask to cancel/i);
  await declineCancelAsk(c2, 'We need you that week', userId);
  r5 = await getRequest(c2);
  check('declined: booking stands, reason kept', r5?.status === 'approved' && r5.cancelAsk?.declineNote === 'We need you that week');
  check('declined: off the approvals list', !(await listRequests({ cancelAsked: true })).some(x => x.id === c2));
  await askToCancel(c2, personId, 'Asking again', userId);
  await withdrawCancelAsk(c2, personId);
  check('withdrawn ask clears it', (await getRequest(c2))?.cancelAsk === null);
  await askToCancel(c2, personId, 'Really called off', userId);
  await approveCancelAsk(c2, userId);
  r5 = await getRequest(c2);
  check('approved: cancelled with their note as the reason', r5?.status === 'cancelled' && r5.cancellationReason === 'Really called off', r5?.cancellationReason);
  check('approved: every hour back', (await bal()) === start, await bal());
  await refuses('somebody else’s booking', async () => {
    const other = await book(d(40), d(40));
    return askToCancel(other, '00000000-0000-0000-0000-000000000000', 'not mine', userId);
  }, /not found/i);

  // ── 6. A holiday already under way ───────────────────────────────────────
  console.log('\n6. A holiday that has started');
  const base6 = await bal();
  const s = await book(d(-2), d(2));
  check('started booking costs 5 days', (await bal()) === base6 - 2250);
  await refuses('cancelling it outright', () => cancelRequest(s, 'admin', userId), /already started/i);
  await refuses('asking to cancel it', () => askToCancel(s, personId, 'x', userId), /already started/i);
  await refuses('dropping a day already gone',
    () => createRequest({ personId, leaveType: 'holiday', startDate: d(-1), endDate: d(2), note: 'x', replacesRequestId: s }, userId),
    /already gone/i);
  await refuses('altering a day already gone',
    () => createRequest({ personId, leaveType: 'holiday', startDate: d(-2), endDate: d(2), note: 'x',
      halfDays: { [d(-1)]: { portion: 'am' } }, replacesRequestId: s }, userId),
    /already gone/i);
  await refuses('adding a day already gone',
    () => createRequest({ personId, leaveType: 'holiday', startDate: d(-3), endDate: d(2), note: 'x', replacesRequestId: s }, userId),
    /already gone/i);
  await refuses('switching its type',
    () => createRequest({ personId, leaveType: 'unpaid', startDate: d(-2), endDate: d(2), note: 'x', replacesRequestId: s }, userId),
    /type can’t change/i);
  // Back in today: today itself is not "gone", so it can be dropped too.
  const early = await createRequest({ personId, leaveType: 'holiday', startDate: d(-2), endDate: d(-1),
    note: 'Coming back early', replacesRequestId: s }, userId);
  await approveRequest(early, null, userId);
  check('coming back early gives the last three days back', (await bal()) === base6 - 900, await bal());
  const earlyReq = await getRequest(early);
  const sReq = await getRequest(s);
  check('the days already gone are carried over as they were',
    JSON.stringify(earlyReq?.days.filter(x => x.date < T).map(x => [x.date, x.minutes, x.portion]))
    === JSON.stringify(sReq?.days.filter(x => x.date < T).map(x => [x.date, x.minutes, x.portion])));

  // ── 7. A day already handed back is never handed back twice ──────────────
  console.log('\n7. Days already given back (the double-credit fix)');
  const base7 = await bal();
  const k = await book(d(50), d(52));
  const cd = await createCompanyDay({ dayDate: d(51), label: `Verify ${tag}` }, userId);
  const cands = (await getCompanyReclaimCandidates(cd.id)).filter(x => x.personId === personId);
  await reclaimForCompanyDay(cd.id, cands.map(x => x.dayId), userId);
  check('company day over the booking hands one day back', (await bal()) === base7 - 900, await bal());
  await cancelRequest(k, 'Not going', userId);
  check('cancelling gives back only the two days still charged', (await bal()) === base7, await bal());

  // Off sick on a day already gone, inside a holiday still under way. The
  // change carries that day over as it was, and must carry the hand-back too,
  // or it charges the sick day again.
  const base7b = await bal();
  const notOff = Object.fromEntries([-2, -1, 0, 1, 2].map(n => [d(n), { portion: 'none' as const }]));
  const t = await book(d(-4), d(4), notOff);                       // d-4, d-3, d3, d4
  check('a booking either side of a gap costs 4 days', (await bal()) === base7b - 1800, await bal());
  const flu = await createAbsence({ personId, absenceType: 'sickness', startDate: d(-3), endDate: d(-3) }, userId);
  const sick = await getReclaimCandidates(flu.id);
  await reclaimLeaveDays(flu.id, sick.map(x => x.dayId), userId);
  check('off sick on one of them hands it back', (await bal()) === base7b - 1350, await bal());
  const pv7 = await getImpact(personId, d(-4), d(3), 'holiday', notOff, undefined, { replacesRequestId: t });
  check('preview of dropping the last day: gives one back', pv7.change?.minutes === -450, pv7.change);
  const t2 = await createRequest({ personId, leaveType: 'holiday', startDate: d(-4), endDate: d(3),
    halfDays: notOff, note: 'Dropping the last day', replacesRequestId: t }, userId);
  await approveRequest(t2, null, userId);
  check('the change does not charge the sick day again', (await bal()) === base7b - 900, await bal());
  const inherited = await query(
    `SELECT reclaimed_absence_id FROM staff_leave_request_days WHERE request_id = $1 AND leave_date = $2::date`, [t2, d(-3)]);
  check('…because the new booking inherits the hand-back', inherited.rows[0]?.reclaimed_absence_id === flu.id, inherited.rows);

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch(e => { console.error('\nCRASH:', e); process.exit(1); });
