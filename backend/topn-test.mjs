import pg from 'pg';
const pool = new pg.Pool({ host: '/tmp/pgsock', port: 55433, user: 'postgres', database: 'postgres' });
const q = (t, p) => pool.query(t, p);
const { reconcileJobExcessTopN } = await import('./dist/services/excess-topn.js');
let pass = 0, fail = 0;

async function scenario(name, { vans = 1, internal = false, pipeline = 'confirmed', drivers: ds }, expect) {
  await q('TRUNCATE jobs, drivers, vehicle_hire_assignments, job_excess');
  const job = (await q(
    `INSERT INTO jobs (is_internal, pipeline_status, hh_derived_flags) VALUES ($1,$2,$3) RETURNING id`,
    [internal, pipeline, JSON.stringify({ self_drive_count: vans })])).rows[0].id;
  for (const d of ds) {
    const drv = (await q(`INSERT INTO drivers (full_name, calculated_excess_amount) VALUES ($1,$2) RETURNING id`,
      [d.name, d.liability])).rows[0].id;
    const asg = (await q(`INSERT INTO vehicle_hire_assignments (driver_id, status) VALUES ($1,$2) RETURNING id`,
      [drv, d.asgStatus || 'confirmed'])).rows[0].id;
    await q(`INSERT INTO job_excess (job_id, assignment_id, excess_status, excess_amount_required,
               excess_amount_taken, amount_held, reimbursement_amount, hh_deposit_id)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [job, asg, d.status, d.required ?? 0, d.taken ?? 0, d.held ?? 0, d.reimbursed ?? 0, d.deposit ?? null]);
  }
  const res = await reconcileJobExcessTopN(q, job);
  const after = (await q(
    `SELECT d.full_name AS n, je.excess_status AS s, je.excess_amount_required::float AS r
       FROM job_excess je JOIN vehicle_hire_assignments vha ON vha.id=je.assignment_id
       LEFT JOIN drivers d ON d.id=vha.driver_id WHERE je.job_id=$1 ORDER BY d.full_name`, [job])).rows;
  const got = after.map(r => `${r.n}=${r.s}/${r.r}`).join(' ');
  const ok = got === expect.state && (expect.blocked === undefined || res.blocked.length === expect.blocked);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name.padEnd(52)} ${got}${res.blocked.length ? `  [blocked:${res.blocked.length}]` : ''}`);
  if (!ok) { console.log(`      wanted: ${expect.state}${expect.blocked !== undefined ? ` blocked:${expect.blocked}` : ''}`); fail++; } else pass++;
  return { job, res };
}

console.log('\n── REGRESSION: terminal records occupy slots (job 15777) ──');
await scenario('COMPLETED hire, reimbursed + covered — untouched', { vans: 1, pipeline: 'completed', drivers: [
  { name: 'Cameron', liability: 1200, status: 'reimbursed', required: 1200, taken: 1200, reimbursed: 1200, deposit: 8123 },
  { name: 'Robbie',  liability: 1200, status: 'not_required', required: 0 },
]}, { state: 'Cameron=reimbursed/1200 Robbie=not_required/0' });

await scenario('LIVE hire, reimbursed slot — still not promoted', { vans: 1, drivers: [
  { name: 'Cameron', liability: 1200, status: 'reimbursed', required: 1200, taken: 1200, reimbursed: 1200 },
  { name: 'Robbie',  liability: 1200, status: 'not_required', required: 0 },
]}, { state: 'Cameron=reimbursed/1200 Robbie=not_required/0' });

await scenario('LIVE hire, WAIVED slot — no charge invented', { vans: 1, drivers: [
  { name: 'Alice', liability: 1200, status: 'waived', required: 0 },
  { name: 'Bob',   liability: 1800, status: 'not_required', required: 0 },
]}, { state: 'Alice=waived/0 Bob=not_required/0', blocked: 0 });

await scenario('LIVE hire, rolled-over slot — no charge invented', { vans: 1, drivers: [
  { name: 'Alice', liability: 1200, status: 'rolled_over', required: 1200, taken: 1200 },
  { name: 'Bob',   liability: 1200, status: 'not_required', required: 0 },
]}, { state: 'Alice=rolled_over/1200 Bob=not_required/0' });

await scenario('2 vans: 1 reimbursed slot leaves 1 to fill', { vans: 2, drivers: [
  { name: 'Alice', liability: 1200, status: 'reimbursed', required: 1200, taken: 1200, reimbursed: 1200 },
  { name: 'Bob',   liability: 1800, status: 'not_required', required: 0 },
  { name: 'Carol', liability: 1200, status: 'not_required', required: 0 },
]}, { state: 'Alice=reimbursed/1200 Bob=pending/1800 Carol=not_required/0' });

console.log('\n── Lifecycle guard ──');
for (const st of ['returned', 'returned_incomplete', 'completed', 'cancelled', 'lost']) {
  await scenario(`${st}: no reshuffle`, { vans: 1, pipeline: st, drivers: [
    { name: 'Alice', liability: 1200, status: 'pending', required: 1200 },
    { name: 'Bob',   liability: 1800, status: 'not_required', required: 0 },
  ]}, { state: 'Alice=pending/1200 Bob=not_required/0' });
}
await scenario('dispatched: mid-tour driver STILL ranked', { vans: 1, pipeline: 'dispatched', drivers: [
  { name: 'Alice', liability: 1200, status: 'pending', required: 1200 },
  { name: 'Bob',   liability: 1800, status: 'not_required', required: 0 },
]}, { state: 'Alice=not_required/0 Bob=pending/1800' });

console.log('\n── The original leaks ──');
await scenario('LEAK: clean submits first, referral second', { vans: 1, drivers: [
  { name: 'Alice', liability: 1200, status: 'pending', required: 1200 },
  { name: 'Bob',   liability: 1800, status: 'not_required', required: 0 },
]}, { state: 'Alice=not_required/0 Bob=pending/1800' });

await scenario('LEAK: quick-assign flat 1200 on a referral', { vans: 1, drivers: [
  { name: 'Bob', liability: 1800, status: 'pending', required: 1200 },
]}, { state: 'Bob=pending/1800' });

await scenario('all equal — incumbent keeps the slot', { vans: 1, drivers: [
  { name: 'Alice', liability: 1200, status: 'pending', required: 1200 },
  { name: 'Bob',   liability: 1200, status: 'not_required', required: 0 },
  { name: 'Carol', liability: 1200, status: 'not_required', required: 0 },
]}, { state: 'Alice=pending/1200 Bob=not_required/0 Carol=not_required/0' });

await scenario('2 vans, 4 drivers — top 2 by amount', { vans: 2, drivers: [
  { name: 'Alice', liability: 1200, status: 'pending', required: 1200 },
  { name: 'Bob',   liability: 1200, status: 'pending', required: 1200 },
  { name: 'Carol', liability: 2400, status: 'not_required', required: 0 },
  { name: 'Dave',  liability: 1800, status: 'not_required', required: 0 },
]}, { state: 'Alice=not_required/0 Bob=not_required/0 Carol=pending/2400 Dave=pending/1800' });

console.log('\n── The money guard ──');
await scenario('paid incumbent — frozen, warn instead', { vans: 1, drivers: [
  { name: 'Alice', liability: 1200, status: 'taken', required: 1200, taken: 1200, deposit: 7767 },
  { name: 'Bob',   liability: 1800, status: 'not_required', required: 0 },
]}, { state: 'Alice=taken/1200 Bob=not_required/0', blocked: 1 });

await scenario('live pre-auth hold — frozen, warn', { vans: 1, drivers: [
  { name: 'Alice', liability: 1200, status: 'pre_auth', required: 1200, held: 1200 },
  { name: 'Bob',   liability: 1800, status: 'not_required', required: 0 },
]}, { state: 'Alice=pre_auth/1200 Bob=not_required/0', blocked: 1 });

await scenario('paid incumbent already highest — no warning', { vans: 1, drivers: [
  { name: 'Alice', liability: 1800, status: 'taken', required: 1800, taken: 1800 },
  { name: 'Bob',   liability: 1200, status: 'not_required', required: 0 },
]}, { state: 'Alice=taken/1800 Bob=not_required/0', blocked: 0 });

console.log('\n── Exclusions & stability ──');
await scenario('internal job — nothing promoted', { vans: 1, internal: true, drivers: [
  { name: 'Alice', liability: 1200, status: 'not_required', required: 0 },
  { name: 'Bob',   liability: 1800, status: 'not_required', required: 0 },
]}, { state: 'Alice=not_required/0 Bob=not_required/0' });

await scenario('cancelled driver demoted, live one promoted', { vans: 1, drivers: [
  { name: 'Alice', liability: 1800, status: 'pending', required: 1800, asgStatus: 'cancelled' },
  { name: 'Bob',   liability: 1200, status: 'not_required', required: 0 },
]}, { state: 'Alice=not_required/0 Bob=pending/1200' });

await scenario('cancelled driver HOLDING MONEY stays frozen', { vans: 1, drivers: [
  { name: 'Alice', liability: 1200, status: 'taken', required: 1200, taken: 1200, asgStatus: 'cancelled' },
  { name: 'Bob',   liability: 1200, status: 'not_required', required: 0 },
]}, { state: 'Alice=taken/1200 Bob=not_required/0' });

{
  const { job } = await scenario('idempotent: first pass', { vans: 1, drivers: [
    { name: 'Alice', liability: 1200, status: 'pending', required: 1200 },
    { name: 'Bob',   liability: 1800, status: 'not_required', required: 0 },
  ]}, { state: 'Alice=not_required/0 Bob=pending/1800' });
  const second = await reconcileJobExcessTopN(q, job);
  const ok = second.changed === false;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${'idempotent: second pass no change'.padEnd(52)} changed=${second.changed}`);
  ok ? pass++ : fail++;

  const dry = await reconcileJobExcessTopN(q, job, { dryRun: true });
  const ok2 = dry.changed === false;
  console.log(`${ok2 ? 'PASS' : 'FAIL'}  ${'dryRun on settled job reports no change'.padEnd(52)} changed=${dry.changed}`);
  ok2 ? pass++ : fail++;
}

{
  await q('TRUNCATE jobs, drivers, vehicle_hire_assignments, job_excess');
  const job = (await q(`INSERT INTO jobs (pipeline_status, hh_derived_flags) VALUES ('confirmed',$1) RETURNING id`,
    [JSON.stringify({ self_drive_count: 1 })])).rows[0].id;
  for (const d of [{ n: 'Alice', l: 1200, s: 'pending', r: 1200 }, { n: 'Bob', l: 1800, s: 'not_required', r: 0 }]) {
    const drv = (await q(`INSERT INTO drivers (full_name, calculated_excess_amount) VALUES ($1,$2) RETURNING id`, [d.n, d.l])).rows[0].id;
    const asg = (await q(`INSERT INTO vehicle_hire_assignments (driver_id) VALUES ($1) RETURNING id`, [drv])).rows[0].id;
    await q(`INSERT INTO job_excess (job_id, assignment_id, excess_status, excess_amount_required) VALUES ($1,$2,$3,$4)`, [job, asg, d.s, d.r]);
  }
  const dry = await reconcileJobExcessTopN(q, job, { dryRun: true });
  const st = (await q(`SELECT string_agg(d.full_name || '=' || je.excess_status || '/' || je.excess_amount_required::float, ' ' ORDER BY d.full_name) AS st
     FROM job_excess je JOIN vehicle_hire_assignments vha ON vha.id=je.assignment_id
     LEFT JOIN drivers d ON d.id=vha.driver_id WHERE je.job_id=$1`, [job])).rows[0].st;
  const ok = dry.changed === true && dry.correctTotal === 1800 && st === 'Alice=pending/1200 Bob=not_required/0';
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${'dryRun reports change but writes nothing'.padEnd(52)} db: ${st}`);
  ok ? pass++ : fail++;
}

console.log(`\n${pass} passed, ${fail} failed`);
await pool.end();
process.exit(fail ? 1 : 0);
