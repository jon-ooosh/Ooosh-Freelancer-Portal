/**
 * staff_tasks — the ownership rule, which is the whole security surface here.
 *
 * Unlike the rest of the staff-records module this is NOT admin-only: every
 * staff member manages their own list. That makes `assertCanTouch` the only
 * thing between "my list" and "everyone's list", so it is worth pinning down:
 *
 *   - you may touch your own task
 *   - an admin may touch anyone's
 *   - somebody else's task reports "not found", NOT "forbidden" — telling a
 *     person a task exists but isn't theirs is itself a small leak
 *   - assigning a task to somebody else is an admin act
 */
jest.mock('../../config/database', () => ({ query: jest.fn(), getClient: jest.fn() }));
// staff-settings reaches through routes/system-settings to middleware/auth,
// which demands JWT_SECRET at import time. Mocked so a unit test of THIS
// module doesn't need the whole auth stack booted.
jest.mock('../staff-settings', () => ({ getTaskChaseDays: jest.fn(async () => 14) }));

import { query } from '../../config/database';
import { createTask, updateTask, cancelTask } from '../staff-tasks';

const mockQuery = query as jest.MockedFunction<typeof query>;

const ME = 'user-1';
const MY_PERSON = 'person-1';
const THEIR_PERSON = 'person-2';
const TASK = '11111111-2222-3333-4444-555555555555';

function rows(...results: unknown[][]) {
  for (const r of results) {
    mockQuery.mockResolvedValueOnce({ rows: r } as never);
  }
}

beforeEach(() => mockQuery.mockReset());

describe('task ownership', () => {
  it('lets somebody tick their own task', async () => {
    rows(
      [{ person_id: MY_PERSON }],        // assertCanTouch: the task's owner
      [{ person_id: MY_PERSON }],        // personIdForUser: me
      [],                                // the UPDATE
      [{ id: TASK, status: 'done' }],    // re-read
    );
    const out = await updateTask(TASK, { status: 'done' }, ME, 'staff');
    expect(out.status).toBe('done');
  });

  it('refuses somebody else’s task, and calls it "not found"', async () => {
    rows(
      [{ person_id: THEIR_PERSON }],
      [{ person_id: MY_PERSON }],
    );
    await expect(updateTask(TASK, { status: 'done' }, ME, 'staff'))
      .rejects.toThrow('Task not found');
  });

  it('lets an admin touch anyone’s task without a person lookup', async () => {
    rows(
      [{ person_id: THEIR_PERSON }],
      [],
      [{ id: TASK, status: 'done' }],
    );
    const out = await updateTask(TASK, { status: 'done' }, ME, 'admin');
    expect(out.status).toBe('done');
    // An admin short-circuits before personIdForUser — 3 calls, not 4.
    expect(mockQuery).toHaveBeenCalledTimes(3);
  });

  it('applies the same rule to cancelling', async () => {
    rows(
      [{ person_id: THEIR_PERSON }],
      [{ person_id: MY_PERSON }],
    );
    await expect(cancelTask(TASK, ME, 'staff')).rejects.toThrow('Task not found');
  });

  it('cancels rather than deletes', async () => {
    rows([{ person_id: MY_PERSON }], [{ person_id: MY_PERSON }], []);
    await cancelTask(TASK, ME, 'staff');
    const sql = mockQuery.mock.calls[2]![0] as string;
    expect(sql).toMatch(/status = 'cancelled'/);
    expect(sql).not.toMatch(/DELETE/i);
  });
});

describe('creating a task', () => {
  it('defaults to the caller’s own list', async () => {
    rows(
      [{ person_id: MY_PERSON }],         // personIdForUser
      [{ id: TASK }],                     // INSERT
      [{ id: TASK, title: 'Do it' }],     // re-read
    );
    await createTask({ title: 'Do it' }, ME, 'staff');
    expect(mockQuery.mock.calls[1]![1]![0]).toBe(MY_PERSON);
  });

  it('chases on the due date when there is one', async () => {
    rows([{ person_id: MY_PERSON }], [{ id: TASK }], [{ id: TASK }]);
    await createTask({ title: 'Do it', dueDate: '2026-11-30' }, ME, 'staff');
    const params = mockQuery.mock.calls[1]![1] as unknown[];
    expect(params[4]).toBe('2026-11-30');   // next_chase_date
  });

  it('chases in a fortnight when there is NO due date — the case that would otherwise rot', async () => {
    rows([{ person_id: MY_PERSON }], [{ id: TASK }], [{ id: TASK }]);
    await createTask({ title: 'Sort the shelving' }, ME, 'staff');
    const params = mockQuery.mock.calls[1]![1] as unknown[];
    const expected = new Date();
    expected.setUTCDate(expected.getUTCDate() + 14);
    expect(params[4]).toBe(expected.toISOString().slice(0, 10));
  });

  it('honours an explicit "never nudge me"', async () => {
    rows([{ person_id: MY_PERSON }], [{ id: TASK }], [{ id: TASK }]);
    await createTask({ title: 'Someday', nextChaseDate: null }, ME, 'staff');
    const params = mockQuery.mock.calls[1]![1] as unknown[];
    expect(params[4]).toBeNull();
  });

  it('stops a non-admin assigning work to somebody else', async () => {
    rows([{ person_id: MY_PERSON }]);
    await expect(createTask({ title: 'Do it', personId: THEIR_PERSON }, ME, 'staff'))
      .rejects.toThrow(/Only an admin/);
  });

  it('lets an admin assign to somebody else', async () => {
    rows([{ id: TASK }], [{ id: TASK }]);
    await createTask({ title: 'Do it', personId: THEIR_PERSON }, ME, 'admin');
    expect(mockQuery.mock.calls[0]![1]![0]).toBe(THEIR_PERSON);
  });

  it('defaults source_type to manual, so review actions can override it', async () => {
    rows([{ person_id: MY_PERSON }], [{ id: TASK }], [{ id: TASK }]);
    await createTask({ title: 'Do it' }, ME, 'staff');
    const params = mockQuery.mock.calls[1]![1] as unknown[];
    // COALESCE($6,'manual') — null here means the default applies. ($6, not
    // $5: next_chase_date was inserted ahead of it in migration 234.)
    expect(params[5]).toBeNull();
  });

  it('links a review action to its review', async () => {
    const REVIEW = '99999999-8888-7777-6666-555555555555';
    rows([{ id: REVIEW }], [{ id: TASK }], [{ id: TASK }]);
    await createTask(
      { title: 'Book the refresher', personId: THEIR_PERSON, sourceType: 'staff_review', sourceId: REVIEW },
      ME, 'admin'
    );
    // calls[0] is the review lookup; calls[1] the INSERT.
    const params = mockQuery.mock.calls[1]![1] as unknown[];
    expect(params[5]).toBe('staff_review');
    expect(params[6]).toBe(REVIEW);
  });

  it('refuses a review action from a non-admin', async () => {
    rows([{ person_id: MY_PERSON }]);
    await expect(createTask(
      { title: 'x', sourceType: 'staff_review', sourceId: TASK }, ME, 'staff'
    )).rejects.toThrow(/Only an admin can add a review action/);
  });

  it('refuses a review action against a review that does not exist', async () => {
    rows([]);
    await expect(createTask(
      { title: 'x', personId: THEIR_PERSON, sourceType: 'staff_review', sourceId: TASK }, ME, 'admin'
    )).rejects.toThrow(/Review not found/);
  });

  it('rejects an empty title', async () => {
    await expect(createTask({ title: '   ' }, ME, 'staff')).rejects.toThrow(/needs a title/);
  });

  it('rejects a malformed due date', async () => {
    await expect(createTask({ title: 'x', dueDate: '22/09/2026' }, ME, 'staff'))
      .rejects.toThrow(/YYYY-MM-DD/);
  });
});

describe('re-dating clears the chase stamp', () => {
  it('so a renewed promise earns a fresh nudge', async () => {
    rows([{ person_id: MY_PERSON }], [{ person_id: MY_PERSON }], [], [{ id: TASK }]);
    await updateTask(TASK, { dueDate: '2026-10-01' }, ME, 'staff');
    expect(mockQuery.mock.calls[2]![0] as string).toMatch(/chased_at = NULL/);
  });

  it('stops chasing a finished task', async () => {
    rows([{ person_id: MY_PERSON }], [{ person_id: MY_PERSON }], [], [{ id: TASK }]);
    await updateTask(TASK, { status: 'done' }, ME, 'staff');
    const sql = mockQuery.mock.calls[2]![0] as string;
    const params = mockQuery.mock.calls[2]![1] as unknown[];
    const m = sql.match(/next_chase_date = \$(\d+)/);
    expect(m).not.toBeNull();
    expect(params[Number(m![1]) - 1]).toBeNull();
  });

  // Postgres rejects an UPDATE that assigns one column twice, so every
  // combination an edit form can send must produce exactly one of each.
  const once = (sql: string, col: string) =>
    (sql.match(new RegExp(`\\b${col} =`, 'g')) ?? []).length;

  it('assigns the chase date once when due and remind dates change together', async () => {
    rows([{ person_id: MY_PERSON }], [{ person_id: MY_PERSON }], [], [{ id: TASK }]);
    await updateTask(TASK, { dueDate: '2026-10-01', nextChaseDate: '2026-09-28' }, ME, 'staff');
    const sql = mockQuery.mock.calls[2]![0] as string;
    const params = mockQuery.mock.calls[2]![1] as unknown[];
    expect(once(sql, 'next_chase_date')).toBe(1);
    expect(once(sql, 'chased_at')).toBe(1);
    // The explicit chase date wins over the one derived from the due date.
    const m = sql.match(/next_chase_date = \$(\d+)/);
    expect(params[Number(m![1]) - 1]).toBe('2026-09-28');
  });

  it('assigns the chase date once when re-dated and finished together', async () => {
    rows([{ person_id: MY_PERSON }], [{ person_id: MY_PERSON }], [], [{ id: TASK }]);
    await updateTask(TASK, { dueDate: '2026-10-01', status: 'done' }, ME, 'staff');
    const sql = mockQuery.mock.calls[2]![0] as string;
    expect(once(sql, 'next_chase_date')).toBe(1);
  });

  it('clears completed_at when a done task is re-opened', async () => {
    rows([{ person_id: MY_PERSON }], [{ person_id: MY_PERSON }], [], [{ id: TASK }]);
    await updateTask(TASK, { status: 'open' }, ME, 'staff');
    expect(mockQuery.mock.calls[2]![0] as string).toMatch(/completed_at = NULL/);
  });
});
