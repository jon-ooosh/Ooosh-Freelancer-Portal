/**
 * Verification for the D0 follow-ups: computed bank holidays, the cross-year
 * booking fixes, and the post-sweep overtime residual.
 *
 *   DATABASE_URL=postgresql://…/scratch… npx tsx src/scripts/__verify-d0b.ts
 *
 * Refuses to run outside a scratch database — it writes fixtures.
 */
import { query } from '../config/database';
import { upsertEmployment, createPattern } from '../services/staff-employment';
import { getBalance, syncEntitlement, runEntitlementSyncForOpenYears } from '../services/staff-balance';
import { getImpact, createRequest, approveRequest } from '../services/staff-leave';
import { createEntry as createOvertime, approveEntry as approveOvertime, yearEndCashOut } from '../services/staff-overtime';
import { runCashOutReminder } from '../services/staff-notifications';
import { getBankHolidays } from '../services/staff-settings';
import { setSystemSetting, invalidateSystemSettingsCache } from '../routes/system-settings';

let pass = 0, fail = 0;
function check(name: string, cond: boolean, detail?: unknown) {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}`, detail !== undefined ? JSON.stringify(detail) : ''); }
}
async function put(key: string, value: string) {
  await setSystemSetting(key, value); invalidateSystemSettingsCache();
}

async function main() {
  if (!/scratch|_test\b/.test(process.env.DATABASE_URL ?? '')) {
    console.error('Refusing to run: DATABASE_URL must name a scratch database.');
    process.exit(1);
  }
  const tag = Math.random().toString(36).slice(2, 8);

  // ── 1. Bank holidays are computed, and the setting overrides ─────────────
  console.log('\n1. Bank holidays no longer run out');
  const y2029 = await getBankHolidays(2029);
  check('a year nobody ever seeded still has eight', y2029.length === 8, y2029);
  const y2035 = await getBankHolidays(2035);
  check('so does one ten years out', y2035.length === 8, y2035);
  const seeded = await getBankHolidays(2027);
  check('2027 still matches what migration 216 seeded',
    seeded.join() === '2027-01-01,2027-03-26,2027-03-29,2027-05-03,2027-05-31,2027-08-30,2027-12-27,2027-12-28',
    seeded);

  // The override must be creatable for a year NOBODY seeded — otherwise the
  // whole point of it is lost the moment the seeded years run out.
  const { upsertSystemSetting } = await import('../routes/system-settings');
  await upsertSystemSetting('staff.bank_holidays.2029', '2029-01-01,2029-05-07',
    { label: 'Bank holidays 2029', category: 'staff_time' });
  invalidateSystemSettingsCache();
  check('an override can be created for an unseeded year, and wins outright',
    (await getBankHolidays(2029)).join() === '2029-01-01,2029-05-07',
    await getBankHolidays(2029));

  await upsertSystemSetting('staff.bank_holidays.2029', 'total nonsense',
    { label: 'Bank holidays 2029', category: 'staff_time' });
  invalidateSystemSettingsCache();
  check('an override with nothing usable falls back to computing',
    (await getBankHolidays(2029)).length === 8);

  await upsertSystemSetting('staff.bank_holidays.2029', '',
    { label: 'Bank holidays 2029', category: 'staff_time' });
  invalidateSystemSettingsCache();
  check('clearing it hands the year back to the arithmetic',
    (await getBankHolidays(2029)).length === 8);

  // ── Fixture ──────────────────────────────────────────────────────────────
  await query(`ALTER TABLE people ALTER COLUMN created_by DROP NOT NULL`);
  await query(`ALTER TABLE users  ALTER COLUMN person_id  DROP NOT NULL`);
  const u = await query(`INSERT INTO users (email,password_hash,role,is_active) VALUES ($1,'x','admin',true) RETURNING id`, [`b-${tag}@oooshtours.co.uk`]);
  const userId = u.rows[0].id;
  const p = await query(`INSERT INTO people (first_name,last_name,preferred_name,email,created_by) VALUES ('William','Parish','Will',$2,$1) RETURNING id`, [userId, `b-${tag}@oooshtours.co.uk`]);
  const personId = p.rows[0].id;
  await query(`UPDATE users SET person_id=$1 WHERE id=$2`, [personId, userId]);
  await query(`ALTER TABLE people ALTER COLUMN created_by SET NOT NULL`);
  await query(`ALTER TABLE users  ALTER COLUMN person_id  SET NOT NULL`);

  await upsertEmployment(personId, { startDate: '2026-01-01', jobTitle: 'T' }, userId);
  await createPattern(personId, '2026-01-01', [
    ...[0,1,2,3,4].map(weekday => ({ weekday, isWorking: true, startTime: '09:00', endTime: '17:00', breakMinutes: 60 })),
    { weekday: 5, isWorking: false }, { weekday: 6, isWorking: false },
  ], {}, userId);

  const thisYear = new Date().getUTCFullYear();
  const nextYear = thisYear + 1;

  // ── 2. Preferred name reaches the API ────────────────────────────────────
  console.log('\n2. Preferred name is served');
  const me = await query(
    `SELECT p.first_name, p.preferred_name FROM users u JOIN people p ON p.id = u.person_id WHERE u.id = $1`,
    [userId]);
  check('the record holds both the legal and the preferred name',
    me.rows[0].first_name === 'William' && me.rows[0].preferred_name === 'Will', me.rows[0]);

  // ── 3. Next year is granted in advance ───────────────────────────────────
  console.log('\n3. Booking into next year');
  await syncEntitlement(personId, thisYear, userId);
  const beforeAdvance = await getImpact(personId, `${nextYear}-01-04`, `${nextYear}-01-15`, 'holiday');
  check('without next year granted, the whole request reads as a shortfall',
    beforeAdvance.shortfallMinutes > 0, beforeAdvance.shortfallMinutes);
  check('…though it was never actually blocked — the days exist',
    beforeAdvance.workingDays > 0, beforeAdvance.workingDays);

  await runEntitlementSyncForOpenYears();
  const granted = await getBalance(personId, 'holiday', nextYear);
  check('the nightly sync now grants next year too', granted.balanceMinutes > 0, granted.balanceMinutes);
  const afterAdvance = await getImpact(personId, `${nextYear}-01-04`, `${nextYear}-01-15`, 'holiday');
  check('and the same request no longer shows a shortfall',
    afterAdvance.shortfallMinutes === 0, afterAdvance.shortfallMinutes);
  check('it is priced against NEXT year, not this one',
    afterAdvance.perYear.length === 1 && afterAdvance.perYear[0].year === nextYear, afterAdvance.perYear);

  // ── 4. The straddle bug ──────────────────────────────────────────────────
  console.log('\n4. A request straddling 31 December');
  const straddle = await getImpact(personId, `${thisYear}-12-28`, `${nextYear}-01-06`, 'holiday');
  check('the preview splits the cost across BOTH leave years',
    straddle.perYear.length === 2, straddle.perYear.map(x => x.year));
  check('each year is checked against its own balance',
    straddle.perYear.every(x => x.balanceBefore > 0), straddle.perYear);
  const sumPerYear = straddle.perYear.reduce((s, x) => s + x.minutes, 0);
  check('and the split adds up to the whole request',
    sumPerYear === straddle.totalMinutes, { sumPerYear, total: straddle.totalMinutes });

  const before = {
    a: (await getBalance(personId, 'holiday', thisYear)).balanceMinutes,
    b: (await getBalance(personId, 'holiday', nextYear)).balanceMinutes,
  };
  const reqId = await createRequest({ personId, leaveType: 'holiday',
    startDate: `${thisYear}-12-28`, endDate: `${nextYear}-01-06` }, userId);
  await approveRequest(reqId, null, userId);
  const after = {
    a: (await getBalance(personId, 'holiday', thisYear)).balanceMinutes,
    b: (await getBalance(personId, 'holiday', nextYear)).balanceMinutes,
  };
  // THE point of the fix: what the preview promised is what the ledger did.
  check('the ledger debits this year exactly what the preview said',
    before.a - after.a === straddle.perYear.find(x => x.year === thisYear)!.minutes,
    { debited: before.a - after.a, predicted: straddle.perYear.find(x => x.year === thisYear)!.minutes });
  check('…and next year exactly what the preview said',
    before.b - after.b === straddle.perYear.find(x => x.year === nextYear)!.minutes,
    { debited: before.b - after.b, predicted: straddle.perYear.find(x => x.year === nextYear)!.minutes });
  check('neither year is quietly pushed negative',
    after.a >= 0 && after.b >= 0, after);

  // ── 5. Overtime worked after the sweep ───────────────────────────────────
  console.log('\n5. The New Year\'s Eve long day');
  const e1 = await createOvertime({ personId, workDate: `${thisYear}-11-10`, minutes: 240, reason: 'Late get-out' }, userId);
  await approveOvertime(e1, null, userId);
  await put('staff.overtime_cashout_reminded_year', '');

  const dec = await runCashOutReminder(new Date(Date.UTC(thisYear, 11, 8)));
  check('December reminds about this year', dec.sent && dec.year === thisYear, dec);
  check('and still posts nothing itself',
    (await getBalance(personId, 'overtime', thisYear)).balanceMinutes === 240);

  // Sweep on the 20th, as jon would.
  await yearEndCashOut(thisYear, userId);
  check('the sweep empties the bank',
    (await getBalance(personId, 'overtime', thisYear)).balanceMinutes === 0);

  // Then someone works New Year's Eve. It accrues to the year just swept.
  const e2 = await createOvertime({ personId, workDate: `${thisYear}-12-31`, minutes: 300, reason: 'PA emergency on NYE' }, userId);
  await approveOvertime(e2, null, userId);
  check('NYE overtime lands in the year that was already swept',
    (await getBalance(personId, 'overtime', thisYear)).balanceMinutes === 300);

  const decAgain = await runCashOutReminder(new Date(Date.UTC(thisYear, 11, 30)));
  check('December will not re-nag — it has already sent',
    !decAgain.sent && decAgain.skippedReason === 'already sent for this year and phase', decAgain);

  const jan = await runCashOutReminder(new Date(Date.UTC(nextYear, 0, 6)));
  check('JANUARY catches the leftover, which is the whole point',
    jan.sent && jan.year === thisYear && jan.totalMinutes === 300, jan);
  const janAgain = await runCashOutReminder(new Date(Date.UTC(nextYear, 0, 7)));
  check('…once, not every morning', !janAgain.sent, janAgain.skippedReason);
  check('and it still posts nothing',
    (await getBalance(personId, 'overtime', thisYear)).balanceMinutes === 300);

  await yearEndCashOut(thisYear, userId);
  check('re-running the sweep clears the residual',
    (await getBalance(personId, 'overtime', thisYear)).balanceMinutes === 0);

  await put('staff.overtime_cashout_reminded_year', '');
  const janClean = await runCashOutReminder(new Date(Date.UTC(nextYear, 0, 8)));
  check('with nothing left over, January stays quiet',
    !janClean.sent && janClean.skippedReason === 'nobody has anything banked', janClean);
  const march = await runCashOutReminder(new Date(Date.UTC(nextYear, 2, 8)));
  check('and it does nothing in March', !march.sent && march.skippedReason === 'not December or January', march);

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
}
main().catch(e => { console.error('\nCRASH:', e); process.exit(1); });
