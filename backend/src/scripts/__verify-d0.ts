/**
 * D0 verification against a REAL Postgres with every migration applied.
 *
 * Covers the settings readers, the bank-holiday seed, the daily entitlement
 * safety net and the year-end cash-out reminder — including the two things
 * that only show up against real data: that a malformed setting degrades to
 * its default rather than taking the module down, and that the reminder
 * stamps itself so it cannot nag every morning through December.
 *
 *   DATABASE_URL=postgresql://…/scratchd0 npx tsx src/scripts/__verify-d0.ts
 *
 * Refuses to run outside a scratch database — it writes fixtures and briefly
 * relaxes two NOT NULL constraints to seed them.
 */
import { query } from '../config/database';
import { addDaysYmd } from '../services/staff-day-status';
import { upsertEmployment, createPattern } from '../services/staff-employment';
import { getBalance } from '../services/staff-balance';
import { runEntitlementSync } from '../services/staff-balance';
import { runCashOutReminder } from '../services/staff-notifications';
import { getImpact, createRequest, approveRequest } from '../services/staff-leave';
import { createEntry as createOvertime, approveEntry as approveOvertime } from '../services/staff-overtime';
import {
  getStatutoryWeeks, getBankHolidays, getBankHolidaysInRange, getBankHolidayPolicy,
  getProRataRounding, getNoticeDaysWarning, getMinHeadcountByWeekday,
  getAbsenceFlag, getRtwChaseDays, getCashOutReminderDay, DEFAULTS,
} from '../services/staff-settings';
import { getSystemSetting, setSystemSetting, invalidateSystemSettingsCache } from '../routes/system-settings';

let pass = 0, fail = 0;
function check(name: string, cond: boolean, detail?: unknown) {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}`, detail !== undefined ? JSON.stringify(detail) : ''); }
}
async function put(key: string, value: string) {
  await setSystemSetting(key, value);
  invalidateSystemSettingsCache();
}

async function main() {
  if (!/scratch|_test\b/.test(process.env.DATABASE_URL ?? '')) {
    console.error('Refusing to run: DATABASE_URL must name a scratch database.');
    process.exit(1);
  }
  const tag = Math.random().toString(36).slice(2, 8);

  // ── 1. The seed ──────────────────────────────────────────────────────────
  console.log('\n1. Settings seeded by migration 216');
  const rows = await query(`SELECT key, value FROM system_settings WHERE category = 'staff_time' ORDER BY key`);
  check('every §13 key exists', rows.rows.length >= 13, rows.rows.length);
  check('statutory weeks reads 5.6', (await getStatutoryWeeks()) === 5.6);
  check('bank holiday policy reads use_allowance', (await getBankHolidayPolicy()) === 'use_allowance');
  check('pro-rata rounding reads up_half_day', (await getProRataRounding()) === 'up_half_day');
  check('notice warning reads 14', (await getNoticeDaysWarning()) === 14);
  check('rtw chase reads 7', (await getRtwChaseDays()) === 7);
  check('cash-out reminder day reads 8', (await getCashOutReminderDay()) === 8);
  const flag = await getAbsenceFlag();
  check('absence flag reads 3 spells / 3 months', flag.spells === 3 && flag.months === 3, flag);
  check('min headcount starts empty', Object.keys(await getMinHeadcountByWeekday()).length === 0);

  // ── 2. Bank holidays ─────────────────────────────────────────────────────
  console.log('\n2. Bank holidays');
  const bh2026 = await getBankHolidays(2026);
  const bh2027 = await getBankHolidays(2027);
  check('2026 has all eight', bh2026.length === 8, bh2026);
  check('Boxing Day 2026 is substituted to Mon 28 Dec',
    bh2026.includes('2026-12-28') && !bh2026.includes('2026-12-26'), bh2026.slice(-3));
  check('2027 substitutes BOTH Christmas and Boxing Day',
    bh2027.includes('2027-12-27') && bh2027.includes('2027-12-28'), bh2027.slice(-3));
  check('Good Friday 2027 is 26 March', bh2027.includes('2027-03-26'), bh2027);
  const across = await getBankHolidaysInRange('2026-12-20', '2027-01-05');
  check('a range spanning new year picks up both years',
    across.join() === '2026-12-25,2026-12-28,2027-01-01', across);

  // Bank holidays must NOT be pattern exceptions — that would silently hand
  // everyone eight free days that no ledger entry paid for.
  const exceptions = await query(
    `SELECT COUNT(*) AS n FROM staff_pattern_exceptions WHERE exception_date IN ('2026-12-25','2026-12-28')`);
  check('they are NOT seeded as non-working pattern exceptions',
    Number(exceptions.rows[0].n) === 0, exceptions.rows[0]);

  // ── 3. A bad value degrades, it does not break ───────────────────────────
  console.log('\n3. Malformed settings fall back');
  await put('staff.statutory_weeks', 'five point six');
  check('a non-numeric week count falls back to the default',
    (await getStatutoryWeeks()) === DEFAULTS.statutoryWeeks);
  await put('staff.bank_holidays_policy', 'nonsense');
  check('an unknown policy falls back to use_allowance',
    (await getBankHolidayPolicy()) === 'use_allowance');
  await put('staff.min_headcount_by_weekday', '{not json');
  check('broken JSON falls back to no floor',
    Object.keys(await getMinHeadcountByWeekday()).length === 0);
  await put('staff.bank_holidays.2026', '2026-01-01, rubbish ,2025-12-25,2026-04-03');
  const cleaned = await getBankHolidays(2026);
  check('junk and wrong-year dates are dropped, good ones kept',
    cleaned.join() === '2026-01-01,2026-04-03', cleaned);
  // Put them back for the rest of the run.
  await put('staff.statutory_weeks', '5.6');
  await put('staff.bank_holidays_policy', 'use_allowance');
  await put('staff.min_headcount_by_weekday', '{}');
  await put('staff.bank_holidays.2026',
    '2026-01-01,2026-04-03,2026-04-06,2026-05-04,2026-05-25,2026-08-31,2026-12-25,2026-12-28');

  // ── Fixture ──────────────────────────────────────────────────────────────
  await query(`ALTER TABLE people ALTER COLUMN created_by DROP NOT NULL`);
  await query(`ALTER TABLE users  ALTER COLUMN person_id  DROP NOT NULL`);
  const u = await query(
    `INSERT INTO users (email, password_hash, role, is_active) VALUES ($1,'x','admin',true) RETURNING id`,
    [`d0-${tag}@oooshtours.co.uk`]);
  const userId = u.rows[0].id;
  const p = await query(
    `INSERT INTO people (first_name, last_name, email, created_by) VALUES ('D0','Tester',$2,$1) RETURNING id`,
    [userId, `d0-${tag}@oooshtours.co.uk`]);
  const personId = p.rows[0].id;
  await query(`UPDATE users SET person_id = $1 WHERE id = $2`, [personId, userId]);
  await query(`ALTER TABLE people ALTER COLUMN created_by SET NOT NULL`);
  await query(`ALTER TABLE users  ALTER COLUMN person_id  SET NOT NULL`);

  await upsertEmployment(personId, { startDate: '2026-01-01', jobTitle: 'Tester' }, userId);
  // A plain 35-hour week: 5 × 420 min.
  await createPattern(personId, '2026-01-01', [
    ...[0, 1, 2, 3, 4].map(weekday => ({
      weekday, isWorking: true, startTime: '09:00', endTime: '17:00', breakMinutes: 60,
    })),
    { weekday: 5, isWorking: false }, { weekday: 6, isWorking: false },
  ], {}, userId);

  // ── 4. The entitlement safety net ────────────────────────────────────────
  console.log('\n4. Entitlement sync (the 1 January grant, run daily)');
  const first = await runEntitlementSync(2027);
  const mine = first.changed.find(c => c.personId === personId);
  check('the first run of a year grants the entitlement', !!mine, first.changed.length);
  // 5.6 weeks × 2100 min/week = 11760.
  check('and grants 5.6 weeks of the contracted week',
    mine?.postedMinutes === Math.round(5.6 * 2100), mine?.postedMinutes);
  check('it reports WHY it posted', mine?.reason === 'Initial grant', mine?.reason);

  const second = await runEntitlementSync(2027);
  check('a second run the same day posts nothing',
    !second.changed.some(c => c.personId === personId), second.changed);
  const third = await runEntitlementSync(2027);
  check('…and a third, so a daily cron is safe',
    !third.changed.some(c => c.personId === personId));
  const bal = await getBalance(personId, 'holiday', 2027);
  check('the balance is granted exactly once', bal.balanceMinutes === Math.round(5.6 * 2100),
    bal.balanceMinutes);

  // A mid-year hours change should top the allowance up on the next nightly run.
  await createPattern(personId, '2027-07-01', [
    ...[0, 1, 2, 3].map(weekday => ({
      weekday, isWorking: true, startTime: '09:00', endTime: '17:00', breakMinutes: 60,
    })),
    { weekday: 4, isWorking: false }, { weekday: 5, isWorking: false }, { weekday: 6, isWorking: false },
  ], {}, userId);
  const afterChange = await runEntitlementSync(2027);
  const adj = afterChange.changed.find(c => c.personId === personId);
  check('an hours change is picked up by the next run', !!adj && adj.postedMinutes < 0, adj);
  check('and is described as a recalculation', adj?.reason === 'Recalculated', adj?.reason);

  // ── 5. Thresholds actually drive behaviour ───────────────────────────────
  console.log('\n5. Settings change what staff see');
  // A few days out, not a year: the notice warning is about SHORT notice, and
  // the first version of this test asked for a date 356 days away.
  const soon = addDaysYmd(new Date().toISOString().slice(0, 10), 6);
  const near = await getImpact(personId, soon, soon, 'holiday');
  check('a request inside the notice window warns',
    near.warnings.some(w => w.includes('notice')), near.warnings);
  await put('staff.notice_days_warning', '0');
  const relaxed = await getImpact(personId, soon, soon, 'holiday');
  check('setting the notice threshold to 0 removes that warning',
    !relaxed.warnings.some(w => w.includes('notice')), relaxed.warnings);
  await put('staff.notice_days_warning', '14');

  await put('staff.min_headcount_by_weekday', '{"0":3}');
  const floored = await getImpact(personId, '2027-09-06', '2027-09-06', 'holiday');
  check('a coverage floor produces its own warning',
    floored.warnings.some(w => w.includes('at least 3')), floored.warnings);
  await put('staff.min_headcount_by_weekday', '{}');
  const unfloored = await getImpact(personId, '2027-09-06', '2027-09-06', 'holiday');
  check('with no floor the original thin-cover warning is still given',
    unfloored.warnings.some(w => w.toLowerCase().includes('nobody would be in')), unfloored.warnings);

  // ── 6. The year-end cash-out REMINDER ────────────────────────────────────
  console.log('\n6. Year-end cash-out reminder');
  const ot = await createOvertime({
    personId, workDate: '2027-11-10', minutes: 120, reason: 'Late get-out',
  }, userId);
  await approveOvertime(ot, null, userId);

  const notDec = await runCashOutReminder(new Date(Date.UTC(2027, 9, 20)));
  check('it does nothing in October', !notDec.sent && notDec.skippedReason === 'not December', notDec);
  const tooEarly = await runCashOutReminder(new Date(Date.UTC(2027, 11, 2)));
  check('…nor on 2 December, before the configured day',
    !tooEarly.sent && tooEarly.skippedReason === 'before 8 December', tooEarly);

  const sent = await runCashOutReminder(new Date(Date.UTC(2027, 11, 8)));
  check('it sends on the configured day', sent.sent === true, sent.skippedReason);
  check('and reports the banked figure', sent.totalMinutes === 120, sent.totalMinutes);
  check('naming who it is for', sent.people.some(x => x.personId === personId), sent.people);

  const again = await runCashOutReminder(new Date(Date.UTC(2027, 11, 9)));
  check('it does NOT nag the next morning',
    !again.sent && again.skippedReason === 'already sent this year', again);
  check('the stamp records the year',
    (await getSystemSetting('staff.overtime_cashout_reminded_year')) === '2027');

  // Crucially: it must not have MOVED anything.
  const bank = await getBalance(personId, 'overtime', 2027);
  check('the reminder posted NOTHING to the ledger — the sweep is still a button',
    bank.balanceMinutes === 120, bank.balanceMinutes);

  await put('staff.overtime_cashout_reminded_year', '');
  await put('staff.overtime_year_end', 'expire');
  const expirePolicy = await runCashOutReminder(new Date(Date.UTC(2027, 11, 8)));
  check('under an `expire` policy it stays quiet',
    !expirePolicy.sent && expirePolicy.skippedReason === 'policy is not cash_out', expirePolicy);
  await put('staff.overtime_year_end', 'cash_out');

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch(e => { console.error('\nCRASH:', e); process.exit(1); });
