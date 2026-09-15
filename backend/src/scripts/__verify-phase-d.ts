/**
 * Phase D verification against a REAL Postgres with every migration applied.
 *
 * Per spec §18: six of the eight bugs found building this module were
 * invisible to unit tests and surfaced the moment real SQL ran. This is the
 * absence half of that check, kept in the repo so it can be re-run.
 *
 *   createdb ooosh_scratch
 *   DATABASE_URL=postgresql://…/ooosh_scratch npx tsx src/migrations/run.ts up
 *   DATABASE_URL=postgresql://…/ooosh_scratch npx tsx src/scripts/__verify-phase-d.ts
 *
 * IT WRITES, and it briefly relaxes two NOT NULL constraints to seed its
 * fixture, so it REFUSES to run against a database whose name does not say
 * scratch. Do not remove that guard to "just check something on staging".
 */
import { query } from '../config/database';
import { upsertEmployment, createPattern } from '../services/staff-employment';
import {
  createAbsence, closeAbsence, cancelAbsence, recordRtw, materialiseDays,
  getReclaimCandidates, reclaimLeaveDays, getAbsence, listAbsences,
  getAbsenceReport, listRtwOutstanding, markRtwChased, getSicknessMinutes,
} from '../services/staff-absence';
import { getStaffCalendar, getTodaySummary } from '../services/staff-day-status';
import { createRequest, approveRequest } from '../services/staff-leave';
import { getBalance, postEntry } from '../services/staff-balance';
import { getPayrollReport, payrollCsv } from '../services/staff-overtime';

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
    else { pass++; console.log(`  ok   ${name} (${msg.slice(0, 70)})`); }
  }
}

async function main() {
  const dbUrl = process.env.DATABASE_URL ?? '';
  if (!/scratch|_test\b/.test(dbUrl)) {
    console.error(
      'Refusing to run: DATABASE_URL must name a scratch database.\n' +
      'This script writes fixtures and momentarily relaxes NOT NULL constraints.');
    process.exit(1);
  }

  // Unique per run so the script can be re-run against the same scratch DB.
  const tag = Math.random().toString(36).slice(2, 8);
  // ── Fixture ───────────────────────────────────────────────────────────────
  // Will's unequal four-day week (450/450/555/630) — the case the whole
  // minutes-not-days rule exists for.
  // people.created_by and users.person_id are both NOT NULL and point at each
  // other, so the very first pair cannot be inserted. Relaxed for the two
  // fixture inserts and put straight back — scratch-DB scaffolding only.
  await query(`ALTER TABLE people ALTER COLUMN created_by DROP NOT NULL`);
  await query(`ALTER TABLE users  ALTER COLUMN person_id  DROP NOT NULL`);

  const u = await query(
    `INSERT INTO users (email, password_hash, role, is_active)
     VALUES ($1,'x','admin',true) RETURNING id`, [`tp-${tag}@oooshtours.co.uk`]);
  const userId = u.rows[0].id;
  const p = await query(
    `INSERT INTO people (first_name, last_name, email, created_by)
     VALUES ('Test','Person',$2,$1) RETURNING id`, [userId, `tp-${tag}@oooshtours.co.uk`]);
  const personId = p.rows[0].id;
  await query(`UPDATE users SET person_id = $1 WHERE id = $2`, [personId, userId]);
  await query(`ALTER TABLE people ALTER COLUMN created_by SET NOT NULL`);
  await query(`ALTER TABLE users  ALTER COLUMN person_id  SET NOT NULL`);

  await upsertEmployment(personId, { startDate: '2026-01-01', jobTitle: 'Tester' }, userId);
  await createPattern(personId, '2026-01-01', [
    { weekday: 0, isWorking: true, startTime: '09:00', endTime: '17:30', breakMinutes: 60 }, // Mon 450
    { weekday: 1, isWorking: true, startTime: '09:00', endTime: '17:30', breakMinutes: 60 }, // Tue 450
    { weekday: 2, isWorking: true, startTime: '09:00', endTime: '19:15', breakMinutes: 60 }, // Wed 555
    { weekday: 3, isWorking: true, startTime: '09:00', endTime: '20:30', breakMinutes: 60 }, // Thu 630
    { weekday: 4, isWorking: false },
    { weekday: 5, isWorking: false },
    { weekday: 6, isWorking: false },
  ], {}, userId);

  const cal = await getStaffCalendar('2026-10-05', '2026-10-11', { isAdmin: true, personId });
  check('fixture: unequal week priced from the pattern',
    JSON.stringify(cal[0].days.map(d => d.scheduledMinutes)) === '[450,450,555,630,0,0,0]',
    cal[0].days.map(d => d.scheduledMinutes));

  // ── 1. Non-working days get no row (spec §3.7 / the leave rule) ───────────
  console.log('\n1. Building days');
  const flu = await createAbsence({
    personId, absenceType: 'sickness',
    startDate: '2026-10-07', endDate: '2026-10-12',   // Wed → next Mon, over a weekend
    notes: 'flu', reasonCategory: 'respiratory',
  }, userId);
  check('a spell over a weekend charges only contracted days',
    flu.days.length === 3 && flu.days.map(d => d.date).join() === '2026-10-07,2026-10-08,2026-10-12',
    flu.days.map(d => `${d.date}:${d.minutes}`));
  check('each day snapshots its OWN length, not a notional day',
    flu.days.map(d => d.minutes).join() === '555,630,450', flu.days.map(d => d.minutes));
  check('sickness defaults rtw_required = true', flu.rtwRequired === true);
  check('sickness does not deduct allowance', flu.deductsAllowance === false);

  // ── 2. Hard refusals ──────────────────────────────────────────────────────
  console.log('\n2. The things that must hard-refuse');
  await refuses('a second whole-day absence over the same date',
    () => createAbsence({ personId, absenceType: 'other', startDate: '2026-10-07', endDate: '2026-10-07' }, userId),
    /duplicate key|idx_staff_absence_one_per_day/i);
  await refuses('dates the person is not contracted to work',
    () => createAbsence({ personId, absenceType: 'other', startDate: '2026-10-09', endDate: '2026-10-10' }, userId),
    /contracted to work/i);
  await refuses('a timed period longer than that day is contracted',
    () => createAbsence({ personId, absenceType: 'medical_appointment', startDate: '2026-10-13',
      portion: 'hours', startTime: '09:00', endTime: '19:00' }, userId),
    /longer than/i);

  // ── 3. Two markers in one day, so long as they do not overlap ────────────
  console.log('\n3. Timed markers (jon: "in late AND away early")');
  const late = await createAbsence({ personId, absenceType: 'other', startDate: '2026-10-13',
    portion: 'hours', startTime: '09:00', endTime: '11:00' }, userId);
  const early = await createAbsence({ personId, absenceType: 'medical_appointment', startDate: '2026-10-13',
    portion: 'hours', startTime: '16:00', endTime: '17:30' }, userId);
  check('two non-overlapping markers on one day both stick', !!late.id && !!early.id);
  await refuses('an overlapping marker',
    () => createAbsence({ personId, absenceType: 'other', startDate: '2026-10-13',
      portion: 'hours', startTime: '10:30', endTime: '12:00' }, userId),
    /overlaps an existing/i);
  await refuses('a marker inside a whole day off',
    () => createAbsence({ personId, absenceType: 'other', startDate: '2026-10-08',
      portion: 'hours', startTime: '10:00', endTime: '11:00' }, userId),
    /absent for the whole/i);

  // ── 4. The calendar merge ─────────────────────────────────────────────────
  console.log('\n4. The calendar');
  const admin = (await getStaffCalendar('2026-10-05', '2026-10-13', { isAdmin: true, personId }))[0];
  const d07 = admin.days.find(d => d.date === '2026-10-07')!;
  const d13 = admin.days.find(d => d.date === '2026-10-13')!;
  check('a whole sick day reads absent', d07.status === 'absent', d07.status);
  check('admin sees the absence type', d07.detail?.absenceType === 'sickness', d07.detail);
  check('a day of markers reads partial, not absent', d13.status === 'partial', d13.status);
  check('both windows survive to the calendar',
    JSON.stringify(d13.windows) === '[{"start":"09:00","end":"11:00"},{"start":"16:00","end":"17:30"}]', d13.windows);
  check('the legacy single `window` field still populates', d13.window?.start === '09:00', d13.window);

  const peer = (await getStaffCalendar('2026-10-05', '2026-10-13', { isAdmin: false, personId }))[0];
  const p07 = peer.days.find(d => d.date === '2026-10-07')!;
  const p13 = peer.days.find(d => d.date === '2026-10-13')!;
  check('a PEER sees absent and nothing else', p07.status === 'absent' && p07.detail === undefined, p07);
  check('a peer keeps the time window (operational) but no type',
    p13.windows?.length === 2 && p13.detail === undefined, p13);
  const today = await getTodaySummary('2026-10-07', false);
  check("who's-in masks detail too", today.people.every(r => r.detail === undefined));

  // ── 5. Open-ended absence and lazy catch-up ───────────────────────────────
  console.log('\n5. An open absence');
  const open = await createAbsence({ personId, absenceType: 'sickness', startDate: '2026-10-14' }, userId);
  check('an open absence has no end date', open.isOpen && open.endDate === null);
  const grew = await materialiseDays(open.id, '2026-10-22');
  check('catch-up fills the days that have since happened', grew > 0, grew);
  const again = await materialiseDays(open.id, '2026-10-22');
  check('catch-up is idempotent — a second run adds nothing', again === 0, again);
  const reread = await getAbsence(open.id);
  check('it never materialises past the catch-up date',
    reread!.days.every(d => d.date <= '2026-10-22'), reread!.days.map(d => d.date));

  const closed = await closeAbsence(open.id, '2026-10-15', userId);
  check('closing trims days past the real end date',
    closed.days.every(d => d.date <= '2026-10-15'), closed.days.map(d => d.date));
  check('closing prices the spell in minutes', closed.totalMinutes === 555 + 630, closed.totalMinutes);
  check('working_days is 2.0 for two whole days', Number(closed.workingDays) === 2, closed.workingDays);
  check('closing sets is_open false with an end date', !closed.isOpen && closed.endDate === '2026-10-15');

  // ── 6. Return to work ─────────────────────────────────────────────────────
  console.log('\n6. Return to work');
  const out1 = await listRtwOutstanding();
  check('a closed sickness appears as RTW outstanding',
    out1.some(a => a.id === closed.id), out1.map(a => a.id));
  const stillOut = await createAbsence({ personId, absenceType: 'sickness', startDate: '2026-09-15' }, userId);
  await refuses('recording RTW on a still-open absence',
    () => recordRtw(stillOut.id, { rtwDate: '2026-09-16', fitToReturn: 'yes' }, userId),
    /Close the absence/i);
  await cancelAbsence(stillOut.id, 'verification scaffolding', userId);
  await markRtwChased(closed.id);
  const out2 = await listRtwOutstanding();
  check('the chase stamp is recorded so it fires once',
    out2.find(a => a.id === closed.id)?.chasedAt !== null);
  const rtw = await recordRtw(closed.id, {
    rtwDate: '2026-10-16', fitToReturn: 'yes_with_adjustments',
    adjustments: 'Lighter lifting for a week', notes: 'Fine otherwise',
  }, userId);
  check('RTW keeps all three fit-to-return states',
    rtw.rtwFitToReturn === 'yes_with_adjustments', rtw.rtwFitToReturn);
  check('RTW records who and when', !!rtw.rtwCompletedAt && rtw.rtwByName === 'Test Person', rtw.rtwByName);
  const out3 = await listRtwOutstanding();
  check('it drops off the outstanding list once recorded', !out3.some(a => a.id === closed.id));

  // ── 7. Sickness during booked holiday (§7.4) ──────────────────────────────
  console.log('\n7. Holiday reclaim');
  await postEntry({ personId, account: 'holiday', leaveYear: 2026, entryType: 'entitlement',
    minutes: 12600, effectiveDate: '2026-01-01', sourceType: 'system' }, userId);
  const before = await getBalance(personId, 'holiday', 2026);

  const reqId = await createRequest({ personId, leaveType: 'holiday',
    startDate: '2026-11-02', endDate: '2026-11-04' }, userId);
  await approveRequest(reqId, null, userId);
  const booked = await getBalance(personId, 'holiday', 2026);
  check('approving the holiday debits the ledger',
    booked.balanceMinutes === before.balanceMinutes - (450 + 450 + 555),
    { before: before.balanceMinutes, booked: booked.balanceMinutes });

  const sick = await createAbsence({ personId, absenceType: 'sickness',
    startDate: '2026-11-03', endDate: '2026-11-04' }, userId);
  const cands = await getReclaimCandidates(sick.id);
  check('the overlapping holiday days are offered back',
    cands.length === 2 && cands.map(c => c.date).join() === '2026-11-03,2026-11-04',
    cands.map(c => c.date));

  const rec = await reclaimLeaveDays(sick.id, cands.map(c => c.dayId), userId);
  check('reclaiming credits the right minutes', rec.minutes === 450 + 555, rec);
  const after = await getBalance(personId, 'holiday', 2026);
  check('the balance goes back up by exactly those days',
    after.balanceMinutes === booked.balanceMinutes + 450 + 555,
    { booked: booked.balanceMinutes, after: after.balanceMinutes });

  const entries = await query(
    `SELECT entry_type, minutes FROM staff_ledger_entries
      WHERE person_id = $1 AND source_type = 'absence' ORDER BY effective_date`, [personId]);
  check('the reclaim posts `correction` credits, per §7.4',
    entries.rows.every(r => r.entry_type === 'correction' && Number(r.minutes) > 0), entries.rows);
  const stillLive = await query(
    `SELECT r.status FROM staff_leave_requests r WHERE r.id = $1`, [reqId]);
  check('the original holiday request is untouched and still approved',
    stillLive.rows[0].status === 'approved', stillLive.rows[0]);
  check('a day cannot be reclaimed twice', (await getReclaimCandidates(sick.id)).length === 0);

  const nov = (await getStaffCalendar('2026-11-02', '2026-11-04', { isAdmin: true, personId }))[0];
  check('absence wins the calendar over the booked holiday',
    nov.days[1].status === 'absent' && nov.days[1].detail?.absenceType === 'sickness', nov.days[1]);
  check('admin still sees the holiday underneath it',
    nov.days[1].detail?.leaveType === 'holiday', nov.days[1].detail);
  check('the untouched holiday day still reads as leave',
    nov.days[0].status === 'leave', nov.days[0].status);

  // ── 8. A deducting absence, and unwinding one ─────────────────────────────
  console.log('\n8. Deducting absence and cancellation');
  const bal0 = await getBalance(personId, 'holiday', 2026);
  const goodwill = await createAbsence({ personId, absenceType: 'goodwill',
    startDate: '2026-12-01', endDate: '2026-12-01', deductsAllowance: true }, userId);
  const bal1 = await getBalance(personId, 'holiday', 2026);
  check('a deducting absence debits the allowance',
    bal1.balanceMinutes === bal0.balanceMinutes - 450, { bal0: bal0.balanceMinutes, bal1: bal1.balanceMinutes });

  await cancelAbsence(goodwill.id, 'Entered against the wrong person', userId);
  const bal2 = await getBalance(personId, 'holiday', 2026);
  check('cancelling reverses the debit exactly', bal2.balanceMinutes === bal0.balanceMinutes,
    { bal0: bal0.balanceMinutes, bal2: bal2.balanceMinutes });
  const dec = (await getStaffCalendar('2026-12-01', '2026-12-01', { isAdmin: true, personId }))[0];
  check('a cancelled absence leaves the calendar', dec.days[0].status === 'working', dec.days[0].status);
  const rows = await query(`SELECT is_active FROM staff_absence_days WHERE absence_id = $1`, [goodwill.id]);
  check('but its day rows are retired, not deleted',
    rows.rows.length > 0 && rows.rows.every(r => r.is_active === false), rows.rows);
  check('a cancelled absence is hidden from the default listing',
    !(await listAbsences({ personId })).some(a => a.id === goodwill.id));
  check('…and visible when asked for',
    (await listAbsences({ personId, includeCancelled: true })).some(a => a.id === goodwill.id));
  await refuses('cancelling twice', () => cancelAbsence(goodwill.id, 'again', userId), /already cancelled/i);

  // ── 8b. Corrections that must not strand a ledger entry ──────────────────
  console.log('\n8b. Shortening a deducting absence');
  const balA = await getBalance(personId, 'holiday', 2026);
  const jury = await createAbsence({ personId, absenceType: 'jury_service',
    startDate: '2026-12-07', endDate: '2026-12-10', deductsAllowance: true }, userId);
  const balB = await getBalance(personId, 'holiday', 2026);
  check('four days of jury service debit four days',
    balB.balanceMinutes === balA.balanceMinutes - (450 + 450 + 555 + 630),
    { balA: balA.balanceMinutes, balB: balB.balanceMinutes });

  // Re-closing EARLIER drops day rows. Anything already debited for those days
  // has to come back, or the ledger holds a charge for a day the absence no
  // longer covers — and it is append-only, so it could never be tidied later.
  const shortened = await closeAbsence(jury.id, '2026-12-08', userId);
  check('shortening drops the days past the new end',
    shortened.days.length === 2, shortened.days.map(d => d.date));
  const balC = await getBalance(personId, 'holiday', 2026);
  check('…and gives back exactly what those days had been debited',
    balC.balanceMinutes === balA.balanceMinutes - (450 + 450),
    { balA: balA.balanceMinutes, balC: balC.balanceMinutes });
  check('the spell is re-priced to what it actually was',
    shortened.totalMinutes === 450 + 450, shortened.totalMinutes);
  // Lengthening it again must charge the reversed days a SECOND time.
  const relengthened = await closeAbsence(jury.id, '2026-12-10', userId);
  check('re-lengthening brings the days back',
    relengthened.days.length === 4, relengthened.days.map(d => d.date));
  const balC2 = await getBalance(personId, 'holiday', 2026);
  check('…and charges them again rather than leaving them free',
    balC2.balanceMinutes === balA.balanceMinutes - (450 + 450 + 555 + 630),
    { balA: balA.balanceMinutes, balC2: balC2.balanceMinutes });

  await cancelAbsence(jury.id, 'verification scaffolding', userId);
  const balD = await getBalance(personId, 'holiday', 2026);
  check('cancelling afterwards still lands back where it started',
    balD.balanceMinutes === balA.balanceMinutes, { balA: balA.balanceMinutes, balD: balD.balanceMinutes });

  // ── 8c. An ongoing absence has to be whole days ──────────────────────────
  await refuses('an ongoing HALF-day absence',
    () => createAbsence({ personId, absenceType: 'sickness',
      startDate: '2026-12-14', portion: 'am' }, userId),
    /whole days/i);

  // ── 8d. A future-dated open absence (the bug the fixture nearly missed) ──
  const mat = await createAbsence({ personId, absenceType: 'maternity',
    startDate: '2027-03-01' }, userId);
  check('an absence starting in the future opens with no day rows yet',
    mat.isOpen && mat.days.length === 0, mat.days);
  check('…and the catch-up leaves it alone until it starts',
    (await materialiseDays(mat.id, '2027-02-28')) === 0);
  check('…then fills it once it has', (await materialiseDays(mat.id, '2027-03-05')) > 0);
  await cancelAbsence(mat.id, 'verification scaffolding', userId);

  // ── 9. Reporting by spell ─────────────────────────────────────────────────
  console.log('\n9. Reporting');
  const report = await getAbsenceReport({ from: '2026-01-01', to: '2026-12-31', flagSpells: 3, flagMonths: 24 });
  const mine = report.find(r => r.personId === personId)!;
  check('sickness spells are counted, not just days', mine.spells === 3, mine);
  check('the repeat-absence flag trips at the threshold', mine.flagged === true, mine);
  check('markers are excluded from the sickness report', mine.days === 7, mine.days);

  const sickMin = await getSicknessMinutes('2026-01-01', '2026-12-31');
  check('sickness minutes are summed for payroll', sickMin.get(personId)! > 0, sickMin.get(personId));
  const payroll = await getPayrollReport('2026-01-01', '2026-12-31');
  const prow = payroll.find(r => r.personId === personId)!;
  check('the payroll report carries sickness', prow.sicknessMinutes > 0 && prow.sicknessDays > 0, prow);
  check('the CSV gained columns at the END, not inserted',
    payrollCsv(payroll, '2026-01-01', '2026-12-31').split('\n')[2]
      .endsWith('Unpaid leave (hours),Sickness (days),Sickness (hours)'));

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch(e => { console.error('\nCRASH:', e); process.exit(1); });
