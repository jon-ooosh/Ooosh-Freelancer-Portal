/**
 * Every multi-step save runs on ONE borrowed connection (SECURITY-AUDIT-BRIEF B.5).
 *
 * `query('BEGIN')` through the shared pool is no transaction at all: each
 * statement goes to whichever connection is free. Under load (a full pool,
 * requests queueing) the BEGIN is left open on a connection that then swallows
 * other requests' writes, a failed save half-commits, and the left-open locks
 * stall everything behind them — all reproduced on a real database in Oct 2026
 * before these three paths were moved onto `getClient()`.
 *
 * Per path: every statement goes to the borrowed connection, a failure undoes
 * it there (never COMMIT), and the connection goes back exactly once either
 * way. The fake connection throws on a second release, as `pg` does — which is
 * what the hire-form save did on its duplicate and van-clash paths.
 *
 * No database: the pool and the connection are fakes that record what they're
 * asked. The routes are called through the router's own table.
 */
import type { Router } from 'express';

jest.mock('../../config/database', () => ({ query: jest.fn(), getClient: jest.fn(), getPool: jest.fn() }));
jest.mock('../../services/assignment-overlap', () => ({
  ...jest.requireActual('../../services/assignment-overlap'),
  findOverlappingAssignments: jest.fn(),
  buildConflictPayload: jest.fn(() => ({ error: 'That van is already out on those dates' })),
}));
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-only-jwt-secret';
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-only-session-secret';

// Required, not imported: an import is hoisted above the env lines.
const db = require('../../config/database');
const overlap = require('../../services/assignment-overlap');
const { replaceCostLines } = require('../../services/cost-lines');
const pipelineRouter: Router = require('../pipeline').default;
const hireFormsRouter: Router = require('../hire-forms').default;

const JOB = '0b6f2a52-6a1f-4c55-9b0e-7c1d2e3f4a5b';
const ORG = '1c7e3b63-7b2a-4d66-8c1f-8d2e3f4a5b6c';
const USER = '2d8f4c74-8c3b-4e77-9d2a-9e3f4a5b6c7d';
const P1 = '3e9a5d85-9d4c-4f88-8e3b-af4a5b6c7d8e';
const P2 = '4fab6e96-ae5d-4a99-9f4c-ba5b6c7d8e9f';
const DRIVER = '5abc7fa7-bf6e-4baa-8a5d-cb6c7d8e9fa0';
const VAN = '6bcd80b8-c07f-4cbb-9b6e-dc7d8e9fa0b1';

const flat = (sql: unknown) => String(sql).replace(/\s+/g, ' ').trim();
const TX_WORD = /^(BEGIN|COMMIT|ROLLBACK)\b/i;

/** A borrowed connection that records every statement. `answer` decides each reply; throwing fails it. */
function fakeConnection(answer: (sql: string) => unknown[] = () => [{ id: 'row-1' }]) {
  const sent: string[] = [];
  let releases = 0;
  const client = {
    sent,
    get releases() { return releases; },
    query: jest.fn(async (sql: string) => {
      const s = flat(sql);
      sent.push(s);
      return { rows: answer(s), rowCount: 1 };
    }),
    release: jest.fn(() => {
      releases += 1;
      if (releases > 1) throw new Error('Release called on client which has already been released to the pool.');
    }),
  };
  (db.getClient as jest.Mock).mockResolvedValue(client);
  // A path that borrows with getPool().connect() gets the same fake.
  const poolQuery = jest.fn(async () => ({ rows: [{ id: 'row-1' }] }));
  (db.getPool as jest.Mock).mockReturnValue({ connect: jest.fn(async () => client), query: poolQuery });
  return { client, poolQuery };
}

const failOn = (pattern: RegExp, answer: (sql: string) => unknown[] = () => [{ id: 'row-1' }]) => (sql: string) => {
  if (pattern.test(sql)) throw Object.assign(new Error('insert or update violates foreign key constraint'), { code: '23503' });
  return answer(sql);
};

/** What went to the shared pool — reads are fine there, a transaction word or one of the save's writes is not. */
const poolSql = () => (db.query as jest.Mock).mock.calls.map((c: unknown[]) => flat(c[0]));

function fakeRes() {
  const res: any = { statusCode: 200, body: undefined };
  res.status = (c: number) => { res.statusCode = c; return res; };
  res.json = (b: unknown) => { res.body = b; return res; };
  res.send = (b?: unknown) => { res.body = b; return res; };
  return res;
}

/** Run a route's own handlers in order (skipping `skip` leading ones, e.g. the auth). Throws what they throw. */
async function call(router: Router, method: string, path: string, req: Record<string, unknown>, skip = 0) {
  const layer = (router.stack as any[]).find((l) => l.route?.path === path && l.route.methods[method]);
  if (!layer) throw new Error(`no route ${method} ${path}`);
  const res = fakeRes();
  const fullReq = { method: method.toUpperCase(), originalUrl: path, params: {}, query: {}, user: { id: USER, email: 'a@example.com', role: 'admin' }, ...req };
  for (const s of layer.route.stack.slice(skip)) {
    let nexted = false;
    await s.handle(fullReq, res, () => { nexted = true; });
    if (!nexted) break;
  }
  return res;
}

beforeEach(() => {
  jest.clearAllMocks();
  (db.query as jest.Mock).mockResolvedValue({ rows: [{ id: JOB, client_id: ORG }] });
  jest.spyOn(console, 'error').mockImplementation(() => {});
  jest.spyOn(console, 'warn').mockImplementation(() => {});
  jest.spyOn(console, 'log').mockImplementation(() => {});
});
afterEach(() => jest.restoreAllMocks());

// ── services/cost-lines.ts replaceCostLines ─────────────────────────────────

describe('replaceCostLines', () => {
  const lines = [
    { description: 'Driver fee', amount_gross: 250, amount_vat: 0, xero_account_code: '320' },
    { description: 'Fuel', amount_gross: 60, amount_vat: 10, xero_account_code: '410' },
  ];

  it('deletes and re-inserts on one borrowed connection, commits there, hands it back once', async () => {
    const { client } = fakeConnection();
    await replaceCostLines('cost-1', lines);
    expect(client.sent.map((s) => s.slice(0, 25))).toEqual([
      'BEGIN', 'DELETE FROM cost_lines WH', 'INSERT INTO cost_lines (c', 'INSERT INTO cost_lines (c', 'COMMIT',
    ]);
    expect(client.releases).toBe(1);
    // Only the read-back after the commit goes to the pool.
    expect(poolSql().some((s) => TX_WORD.test(s) || /cost_lines/.test(s) && !/^SELECT/.test(s))).toBe(false);
  });

  it('a failed insert rolls back on the same connection, never commits, and still hands it back once', async () => {
    let inserts = 0;
    const { client } = fakeConnection((sql) => {
      if (/^INSERT INTO cost_lines/.test(sql) && ++inserts === 2) throw new Error('boom');
      return [];
    });
    await expect(replaceCostLines('cost-1', lines)).rejects.toThrow('boom');
    expect(client.sent[client.sent.length - 1]).toBe('ROLLBACK');
    expect(client.sent).not.toContain('COMMIT');
    expect(client.releases).toBe(1);
    expect(poolSql()).toEqual([]);
  });
});

// ── routes/pipeline.ts PUT /:jobId/contacts ─────────────────────────────────

describe('PUT /pipeline/:jobId/contacts', () => {
  const body = { person_ids: [P1, P2], primary_person_id: P1 };

  it('replaces the contacts on one borrowed connection and hands it back once', async () => {
    const { client } = fakeConnection();
    const res = await call(pipelineRouter, 'put', '/:jobId/contacts', { params: { jobId: JOB }, body });
    expect(res.statusCode).toBe(204);
    expect(client.sent.map((s) => s.slice(0, 26))).toEqual([
      'BEGIN', 'DELETE FROM job_contacts W', 'INSERT INTO job_contacts (', 'INSERT INTO job_contacts (', 'COMMIT',
    ]);
    expect(client.releases).toBe(1);
    expect(poolSql().some((s) => TX_WORD.test(s) || /job_contacts/.test(s))).toBe(false);
  });

  it('a failed insert keeps the old contacts: ROLLBACK on that connection, 500, handed back once', async () => {
    const { client } = fakeConnection(failOn(/^INSERT INTO job_contacts/));
    const res = await call(pipelineRouter, 'put', '/:jobId/contacts', { params: { jobId: JOB }, body });
    expect(res.statusCode).toBe(500);
    expect(client.sent).toEqual(['BEGIN', expect.stringMatching(/^DELETE FROM job_contacts/), expect.stringMatching(/^INSERT/), 'ROLLBACK']);
    expect(client.releases).toBe(1);
    expect(poolSql().some((s) => TX_WORD.test(s) || /job_contacts/.test(s))).toBe(false);
  });
});

// ── routes/pipeline.ts POST /:jobId/contacts/add-person ─────────────────────

describe('POST /pipeline/:jobId/contacts/add-person', () => {
  it('links and ticks the person on one borrowed connection and hands it back once', async () => {
    const { client } = fakeConnection((sql) => (/^SELECT id FROM person_organisation_roles/.test(sql) ? [] : [{ id: 'row-1' }]));
    const res = await call(pipelineRouter, 'post', '/:jobId/contacts/add-person', {
      params: { jobId: JOB }, body: { person_id: P1, role: 'Tour Manager', set_as_primary: true },
    });
    expect(res.statusCode).toBe(201);
    expect(res.body).toEqual({ person_id: P1 });
    expect(client.sent.map((s) => s.slice(0, 32))).toEqual([
      'BEGIN',
      'SELECT id FROM person_organisati',
      'INSERT INTO person_organisation_',
      'UPDATE job_contacts SET is_prima',
      'INSERT INTO job_contacts (job_id',
      'COMMIT',
    ]);
    expect(client.releases).toBe(1);
    expect(poolSql().some((s) => TX_WORD.test(s) || /person_organisation_roles|job_contacts/.test(s))).toBe(false);
  });

  it('a failed tick undoes the new person and the org link: ROLLBACK, 500, handed back once', async () => {
    const { client } = fakeConnection(failOn(/^INSERT INTO job_contacts/, () => [{ id: P2 }]));
    const res = await call(pipelineRouter, 'post', '/:jobId/contacts/add-person', {
      params: { jobId: JOB }, body: { first_name: 'New', last_name: 'Person' },
    });
    expect(res.statusCode).toBe(500);
    expect(client.sent[0]).toBe('BEGIN');
    expect(client.sent[1]).toMatch(/^INSERT INTO people/);
    expect(client.sent[client.sent.length - 1]).toBe('ROLLBACK');
    expect(client.sent).not.toContain('COMMIT');
    expect(client.releases).toBe(1);
    expect(poolSql().some((s) => TX_WORD.test(s) || /INSERT INTO people/.test(s))).toBe(false);
  });
});

// ── routes/hire-forms.ts POST / — the duplicate and van-clash paths ─────────

describe('POST /hire-forms (connection handed back once)', () => {
  const form = {
    full_name: 'Dee Driver', email: 'dee@example.com', job_id: JOB, hirehop_job_id: 16001, vehicle_id: VAN,
    hire_start: '2026-11-02', hire_end: '2026-11-06',
  };
  // The returning driver is found by email; the assignment check decides the path.
  const answers = (existingAssignment: boolean) => (sql: string) => {
    if (/^SELECT id FROM drivers WHERE email/.test(sql)) return [{ id: DRIVER }];
    if (/^SELECT id FROM vehicle_hire_assignments/.test(sql)) return existingAssignment ? [{ id: 'asg-1' }] : [];
    return [{ id: DRIVER }];
  };

  it('a re-submitted form (duplicate) commits, answers 200 and hands the connection back once', async () => {
    const { client } = fakeConnection(answers(true));
    const res = await call(hireFormsRouter, 'post', '/', { body: { ...form } }, 1);
    expect(res.statusCode).toBe(200);
    expect(res.body.deduplicated).toBe(true);
    expect(client.sent[0]).toBe('BEGIN');
    expect(client.sent[client.sent.length - 1]).toBe('COMMIT');
    expect(client.releases).toBe(1);
  });

  it('a van clash rolls back, answers 409 and hands the connection back once', async () => {
    (overlap.findOverlappingAssignments as jest.Mock).mockResolvedValue([{ id: 'other-asg' }]);
    const { client } = fakeConnection(answers(false));
    const res = await call(hireFormsRouter, 'post', '/', { body: { ...form } }, 1);
    expect(res.statusCode).toBe(409);
    expect(client.sent[client.sent.length - 1]).toBe('ROLLBACK');
    expect(client.sent).not.toContain('COMMIT');
    expect(client.releases).toBe(1);
  });
});
