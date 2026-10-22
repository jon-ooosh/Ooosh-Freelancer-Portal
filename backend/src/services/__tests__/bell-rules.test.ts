/**
 * The rule per bell key (services/bell-rules.ts) and how retireDoneBells
 * applies it (services/notification-resolve.ts).
 *
 * Load-bearing:
 *   1. Every rule is a plain EXISTS over the bell row `n`, with no `$n`
 *      parameter — the sweep owns the parameters, and a rule that took one
 *      would silently bind to the key or the record id.
 *   2. The numbers bell-rules.ts copies (it must not import the scanners'
 *      modules) still match the scanners'.
 *   3. `latestOnly` adds the "a newer copy exists" clause, and only for the
 *      rules that ask for it.
 *   4. An instant call is limited to its record; the sweep is not.
 *   5. It never throws.
 * Whether each rule's SQL actually runs is checked against a real database
 * (all migrations applied) before release — see the PR.
 */
jest.mock('../../config/database', () => ({ query: jest.fn(), getClient: jest.fn() }));
jest.mock('../../config/socket', () => ({ emitToUser: jest.fn() }));
jest.mock('../email-service', () => ({ emailService: {}, default: {} }));

import { query } from '../../config/database';
import { BELL_RULES, HOLD_UNTIL_LEAD_DAYS, PIN_ROTATE_DAYS, type BellKey } from '../bell-rules';
import { retireDoneBells, sweepDoneBells } from '../notification-resolve';
import * as holdingReminders from '../holding-reminders';
import * as kioskTill from '../kiosk-till';

const mockQuery = query as jest.MockedFunction<any>;
const KEYS = Object.keys(BELL_RULES) as BellKey[];
/** About the whole system, not one record — so they never look at the bell row. */
const SYSTEM_WIDE: BellKey[] = ['lost_property_chases', 'kiosk_pin_rotation'];
const ID = '6a1e3c55-0d7b-4f62-9a35-2f7c1b8e4d90';

function sql(i = 0): string {
  return String(mockQuery.mock.calls[i][0]).replace(/\s+/g, ' ');
}

beforeEach(() => mockQuery.mockReset());

describe('every rule', () => {
  it.each(KEYS)('%s is a parameter-free EXISTS over the bell row', (key) => {
    const rule = BELL_RULES[key] as { about: string; stillWaiting: string };
    expect(rule.about.length).toBeGreaterThan(10);
    expect(rule.stillWaiting).toMatch(/^\s*EXISTS \(/);
    if (!SYSTEM_WIDE.includes(key)) {
      expect(rule.stillWaiting).toMatch(/\bn\.(entity_id|user_id|title|created_at)\b/);
    }
    expect(rule.stillWaiting).not.toMatch(/\$\d/);
  });
});

describe('copied numbers match the scanners', () => {
  it('hold-until lead days', () => {
    expect(HOLD_UNTIL_LEAD_DAYS).toBe(holdingReminders.HOLD_UNTIL_LEAD_DAYS);
  });
  it('PIN rotation period', () => {
    expect(PIN_ROTATE_DAYS).toBe(kioskTill.PIN_ROTATE_DAYS);
  });
});

describe('retireDoneBells', () => {
  it('retires bells of the key whose rule no longer holds — read AND done', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    await retireDoneBells('problem_open', ID);
    const s = sql();
    expect(s).toContain('UPDATE notifications n');
    expect(s).toContain('acknowledged_at = NOW()');
    expect(s).toContain('n.resolve_key = $1');
    expect(s).toContain('n.acknowledged_at IS NULL');
    expect(s).toContain('AND n.entity_id = $2');
    expect(s).toContain('AND (NOT (EXISTS');
    expect(mockQuery.mock.calls[0][1]).toEqual(['problem_open', ID]);
  });

  it('without a record it is the sweep: every bell of the key', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    await retireDoneBells('kiosk_pin_rotation');
    expect(sql()).not.toContain('n.entity_id = $2');
    expect(mockQuery.mock.calls[0][1]).toEqual(['kiosk_pin_rotation']);
  });

  it.each(KEYS)('%s: the "newer copy" clause only when the rule says latestOnly', async (key) => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    await retireDoneBells(key, ID);
    const latestOnly = (BELL_RULES[key] as { latestOnly?: boolean }).latestOnly === true;
    expect(sql().includes('FROM notifications newer')).toBe(latestOnly);
  });

  it('never throws', async () => {
    const spy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    mockQuery.mockRejectedValueOnce(new Error('syntax error'));
    await expect(retireDoneBells('problem_open', ID)).resolves.toBe(0);
    spy.mockRestore();
  });

  it('the sweep runs every rule, and one broken rule does not stop the rest', async () => {
    const spy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    mockQuery.mockRejectedValueOnce(new Error('syntax error'));
    mockQuery.mockResolvedValue({ rows: [{ id: 'b1', user_id: 'u1' }] });
    const retired = await sweepDoneBells();
    expect(mockQuery).toHaveBeenCalledTimes(KEYS.length);
    expect(retired).toBe(KEYS.length - 1);
    spy.mockRestore();
  });
});
