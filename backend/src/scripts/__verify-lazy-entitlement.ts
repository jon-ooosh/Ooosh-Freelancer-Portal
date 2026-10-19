/**
 * The deploy gap: next year's entitlement before the nightly cron has run.
 *
 *   DATABASE_URL=postgresql://…/scratch… npx tsx src/scripts/__verify-lazy-entitlement.ts
 *
 * Wants its own scratch database — it writes fixtures.
 */
import { query } from '../config/database';
import { upsertEmployment, createPattern } from '../services/staff-employment';
import { getBalance, syncEntitlement, ensureEntitlement, ensureEntitlementForAll } from '../services/staff-balance';
import { getImpact } from '../services/staff-leave';

let pass = 0, fail = 0;
function check(name: string, cond: boolean, detail?: unknown) {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}`, detail !== undefined ? JSON.stringify(detail) : ''); }
}

async function main() {
  if (!/scratch|_test\b/.test(process.env.DATABASE_URL ?? '')) {
    console.error('Refusing to run: DATABASE_URL must name a scratch database.');
    process.exit(1);
  }
  const tag = Math.random().toString(36).slice(2, 8);
  const thisYear = new Date().getUTCFullYear();
  const nextYear = thisYear + 1;
  const lastYear = thisYear - 1;

  await query(`ALTER TABLE people ALTER COLUMN created_by DROP NOT NULL`);
  await query(`ALTER TABLE users  ALTER COLUMN person_id  DROP NOT NULL`);
  const u = await query(`INSERT INTO users (email,password_hash,role,is_active) VALUES ($1,'x','admin',true) RETURNING id`, [`lz-${tag}@oooshtours.co.uk`]);
  const userId = u.rows[0].id;
  const p = await query(`INSERT INTO people (first_name,last_name,email,created_by) VALUES ('Lazy','Grant',$2,$1) RETURNING id`, [userId, `lz-${tag}@oooshtours.co.uk`]);
  const personId = p.rows[0].id;
  await query(`UPDATE users SET person_id=$1 WHERE id=$2`, [personId, userId]);
  await query(`ALTER TABLE people ALTER COLUMN created_by SET NOT NULL`);
  await query(`ALTER TABLE users  ALTER COLUMN person_id  SET NOT NULL`);

  await upsertEmployment(personId, { startDate: `${lastYear}-01-01`, jobTitle: 'T' }, userId);
  await createPattern(personId, `${lastYear}-01-01`, [
    ...[0,1,2,3,4].map(weekday => ({ weekday, isWorking: true, startTime: '09:00', endTime: '17:00', breakMinutes: 60 })),
    { weekday: 5, isWorking: false }, { weekday: 6, isWorking: false },
  ], {}, userId);

  // The live situation: this year granted, next year not — the cron has not
  // run since the code that grants it landed.
  await syncEntitlement(personId, thisYear, userId);

  console.log('\n1. Reproducing what the screenshot showed');
  check(`${nextYear} starts at zero, as it did in production`,
    (await getBalance(personId, 'holiday', nextYear)).balanceMinutes === 0);

  console.log('\n2. The read repairs it');
  await ensureEntitlement(personId, nextYear);
  const granted = await getBalance(personId, 'holiday', nextYear);
  check('asking for next year grants it', granted.balanceMinutes === Math.round(5.6 * 2100),
    granted.balanceMinutes);

  const before = granted.balanceMinutes;
  await ensureEntitlement(personId, nextYear);
  await ensureEntitlement(personId, nextYear);
  check('and asking again changes nothing',
    (await getBalance(personId, 'holiday', nextYear)).balanceMinutes === before);

  console.log('\n3. It must NEVER invent a past year');
  await ensureEntitlement(personId, lastYear);
  check(`${lastYear} is left at zero — granting it would invent an allowance nobody can take`,
    (await getBalance(personId, 'holiday', lastYear)).balanceMinutes === 0);
  const pastEntries = await query(
    `SELECT COUNT(*) AS n FROM staff_ledger_entries WHERE person_id = $1 AND leave_year = $2`,
    [personId, lastYear]);
  check('and no ledger entry is posted for it', Number(pastEntries.rows[0].n) === 0);

  console.log('\n4. The impact preview no longer reports a phantom shortfall');
  const imp = await getImpact(personId, `${nextYear}-02-01`, `${nextYear}-02-05`, 'holiday');
  check('booking into next year shows no shortfall', imp.shortfallMinutes === 0, imp.shortfallMinutes);
  check('and is priced against next year', imp.perYear[0]?.year === nextYear, imp.perYear);

  console.log('\n5. Someone with no staff record');
  const u2 = await query(`INSERT INTO users (email,password_hash,role,is_active,person_id) VALUES ($1,'x','staff',true,$2) RETURNING id`,
    [`nostaff-${tag}@oooshtours.co.uk`, personId]);
  const p2 = await query(`INSERT INTO people (first_name,last_name,email,created_by) VALUES ('No','Record',$2,$1) RETURNING id`,
    [userId, `nostaff-${tag}@oooshtours.co.uk`]);
  await query(`UPDATE users SET person_id = $1 WHERE id = $2`, [p2.rows[0].id, u2.rows[0].id]);
  let threw = false;
  try { await ensureEntitlement(p2.rows[0].id, nextYear); } catch { threw = true; }
  check('is a quiet no-op rather than an error', !threw);
  check('and gets no ledger entry',
    (await getBalance(p2.rows[0].id, 'holiday', nextYear)).balanceMinutes === 0);

  console.log('\n6. The team overview');
  await ensureEntitlementForAll(nextYear);
  check('grants everyone employed who is still missing it',
    (await getBalance(personId, 'holiday', nextYear)).balanceMinutes === before);

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
}
main().catch(e => { console.error('\nCRASH:', e); process.exit(1); });
