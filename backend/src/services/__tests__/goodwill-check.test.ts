/**
 * Goodwill read-back (docs/GOODWILL-CREDIT-SPEC.md §6). The HireHop shapes below are
 * the ones the probe returned on 16 Nov 2026 (spec §13.3): a line with the code in its
 * Item Note (ADDITIONAL) or Item Memo (TECHNICAL), and a credit note as a draft then
 * approved on job 9000.
 */
jest.mock('../../config/database', () => ({ query: jest.fn(), getClient: jest.fn() }));
jest.mock('../hirehop-broker', () => ({ hhBroker: { get: jest.fn() } }));
jest.mock('../job-issues', () => ({ logIssueEvent: jest.fn(async () => undefined) }));

import { codesIn, parseSupplyList, parseBilling, parseStoredLines, decideGoodwill } from '../goodwill-check';

const NOW = new Date('2026-11-18T10:00:00Z');
const credit = (over: Record<string, unknown> = {}) => ({
  ref: 'GW-0012', amount_ex_vat: 100, reserved_amount_ex_vat: 80, reserved_at: '2026-11-18T09:00:00Z', ...over,
});

const amp = (over: Record<string, unknown> = {}) => ({
  ID: 501, kind: 2, title: 'Magnatone Stereo Twilighter 212 combo amp - brown tolex', alt_title: 'supro',
  ADDITIONAL: '', TECHNICAL: '', UNIT_PRICE: '48.000000', PRICE: '45.600000', PRICE_TYPE: '2', value: '3600.000000', ...over,
});
const footswitch = { ID: 502, kind: 2, title: 'Magnatone Double Footswitch (9V)', ADDITIONAL: '', UNIT_PRICE: '2.500000', PRICE: '2.500000' };

const billing = (creditNote: Record<string, unknown>) => ({
  rows: [
    { kind: 0, data: {} },
    { kind: 1, number: 'OT-INV-12417', debit: 11.4, status: 2, data: { DESCRIPTION: 'test' } },
    { kind: 2, ...creditNote },
  ],
});
const draftNote = billing({ number: '', credit: 0, status: 0, data: { DESCRIPTION: 'GW-0012' } });
const approvedNote = (credit: number) => billing({ number: 'OT-CRE-1223', credit, status: 2, data: { DESCRIPTION: 'Goodwill credit GW-0012' } });

describe('codesIn', () => {
  it('finds every code once, any case, and nothing that only looks like one', () => {
    expect(codesIn('Goodwill credit gw-0012 and GW-0012, also GW-12345')).toEqual(['GW-0012', 'GW-12345']);
    expect(codesIn('GW-12 · XGW-0012 · GW-0012X')).toEqual([]);
  });
});

describe('parseSupplyList / parseBilling', () => {
  it('reads the Item Note and the Item Memo, and the prices', () => {
    const lines = parseSupplyList([amp({ TECHNICAL: 'Goodwill credit GW-0012' }), footswitch]);
    expect(lines[0]).toMatchObject({ id: 501, unitPrice: 48, price: 45.6 });
    expect(codesIn(lines[0].text)).toEqual(['GW-0012']);
    expect(parseSupplyList({ items: [amp({ ADDITIONAL: 'Goodwill credit GW-0012' })] })[0].text).toContain('GW-0012');
  });

  it('a draft credit note reads status 0 / £0, the approved one its number and value', () => {
    expect(parseBilling(draftNote)).toEqual([{ number: '', description: 'GW-0012', approved: false, gross: 0 }]);
    expect(parseBilling(approvedNote(11.4))).toEqual([{ number: 'OT-CRE-1223', description: 'Goodwill credit GW-0012', approved: true, gross: 11.4 }]);
  });
});

describe('decideGoodwill', () => {
  const read = (lines: unknown[], bill: unknown = { rows: [] }) => ({ lines: parseSupplyList(lines), creditNotes: parseBilling(bill) });

  it('the code on a discounted line → used, by that line', () => {
    expect(decideGoodwill(credit(), read([amp({ ADDITIONAL: 'Goodwill credit GW-0012' }), footswitch]), NOW))
      .toEqual({ outcome: 'used', how: 'line', hhRef: '501', problem: null });
  });

  it('the code on a line that ISN\'T discounted → used, with a warning', () => {
    const d = decideGoodwill(credit(), read([amp({ TECHNICAL: 'GW-0012', PRICE: '48.000000' })]), NOW);
    expect(d).toMatchObject({ outcome: 'used', how: 'line' });
    expect(d.problem).toMatch(/isn't discounted/);
  });

  it('an approved credit note → used; one bigger than the credit + 20% is flagged', () => {
    expect(decideGoodwill(credit(), read([], approvedNote(96)), NOW)).toEqual({ outcome: 'used', how: 'credit_note', hhRef: 'OT-CRE-1223', problem: null });
    expect(decideGoodwill(credit(), read([], approvedNote(96.02)), NOW).problem).toMatch(/more than the credit \(£80.00\+VAT\)/);
  });

  it('a DRAFT credit note never counts', () => {
    expect(decideGoodwill(credit(), read([], draftNote), NOW)).toEqual({ outcome: 'waiting', problem: 'The credit note with GW-0012 is still a draft in HireHop' });
  });

  it('nothing yet: quiet for a day, then flagged', () => {
    expect(decideGoodwill(credit(), read([footswitch]), NOW)).toEqual({ outcome: 'waiting', problem: null });
    expect(decideGoodwill(credit({ reserved_at: '2026-11-17T09:00:00Z' }), read([footswitch]), NOW).problem)
      .toBe('No line or credit note with GW-0012 in HireHop yet');
  });

  it('another credit\'s code is not this one', () => {
    expect(decideGoodwill(credit(), read([amp({ ADDITIONAL: 'Goodwill credit GW-0013' })]), NOW)).toMatchObject({ outcome: 'waiting' });
  });
});

describe('stored lines (phase 2, jon 17 Nov 2026 — no extra HireHop calls)', () => {
  // What hirehop-job-sync.ts stores on jobs.line_items.
  const stored = (over: Record<string, unknown> = {}) => ({
    ITEM_ID: 701, LIST_ID: 12, ITEM_NAME: 'Magnatone amp', QUANTITY: 1, kind: 2,
    ADDITIONAL: 'Goodwill credit GW-0012', TECHNICAL: '', UNIT_PRICE: 48, PRICE: 45.6, ...over,
  });

  it('reads the code from the stored Item Note or Item Memo, and the prices', () => {
    const [l] = parseStoredLines([stored()]);
    expect(l).toMatchObject({ id: 701, unitPrice: 48, price: 45.6 });
    expect(codesIn(l.text)).toEqual(['GW-0012']);
    expect(codesIn(parseStoredLines([stored({ ADDITIONAL: '', TECHNICAL: 'gw-0012' })])[0].text)).toEqual(['GW-0012']);
    expect(parseStoredLines(null)).toEqual([]);
  });

  it('a line stored before prices were kept is used WITHOUT the "not discounted" warning', () => {
    const lines = parseStoredLines([stored({ UNIT_PRICE: undefined, PRICE: undefined })]);
    expect(lines[0].unitPrice).toBeNull();
    expect(decideGoodwill(credit(), { lines, creditNotes: [] }, NOW)).toEqual({ outcome: 'used', how: 'line', hhRef: '701', problem: null });
  });

  it('a stored line that isn\'t discounted still warns', () => {
    const lines = parseStoredLines([stored({ PRICE: 48 })]);
    expect(decideGoodwill(credit(), { lines, creditNotes: [] }, NOW).problem).toMatch(/isn't discounted/);
  });

  it('"nothing yet" is never flagged when the look couldn\'t have seen it', () => {
    const old = credit({ reserved_at: '2026-11-01T09:00:00Z' });
    expect(decideGoodwill(old, { lines: [], creditNotes: [] }, NOW, false)).toEqual({ outcome: 'waiting', problem: null });
    expect(decideGoodwill(old, { lines: [], creditNotes: [] }, NOW, true).problem).toMatch(/No line or credit note/);
  });
});
