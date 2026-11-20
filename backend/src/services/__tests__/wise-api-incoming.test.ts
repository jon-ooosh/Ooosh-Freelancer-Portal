/**
 * The 5-minute Wise API poll and "Add a Wise transfer by number"
 * (services/wise-api-incoming.ts): off means off, a known transfer is never re-read,
 * money out is never stored, and a person's add never records or emails.
 */
export {};

jest.mock('../../config/database', () => ({ query: jest.fn(), getClient: jest.fn() }));
jest.mock('../../routes/system-settings', () => ({ getSystemSetting: jest.fn() }));
jest.mock('../../config/wise', () => {
  class WiseApiError extends Error { constructor(public status: number, msg: string) { super(msg); } }
  return {
    WiseApiError,
    isWiseConfigured: jest.fn(() => true),
    getWiseBusinessProfileId: jest.fn(async () => 6756540),
    listWiseActivities: jest.fn(),
    getWiseTransfer: jest.fn(),
  };
});
jest.mock('../wise-incoming', () => ({
  AMOUNT_TOLERANCE: 0.02,
  BANK_METHODS: ['wise_bacs'],
  normaliseName: (s: string | null | undefined) => (s || '').toUpperCase().trim(),
  storeAndMatchIncoming: jest.fn(async () => 'stored'),
}));

import { query } from '../../config/database';
import { getSystemSetting } from '../../routes/system-settings';
import { listWiseActivities, getWiseTransfer, WiseApiError } from '../../config/wise';
import { storeAndMatchIncoming } from '../wise-incoming';
import { pollWiseIncoming, addWiseTransferByNumber } from '../wise-api-incoming';

const mQuery = query as jest.Mock;
const mSetting = getSystemSetting as jest.Mock;
const mList = listWiseActivities as jest.Mock;
const mTransfer = getWiseTransfer as jest.Mock;
const mStore = storeAndMatchIncoming as jest.Mock;

const inAct = (id: string, amount: string, name: string) => ({
  id: `a${id}`, type: 'TRANSFER', resource: { type: 'TRANSFER', id }, title: `<strong>${name}</strong>`,
  primaryAmount: `<positive>+ ${amount} GBP</positive>`, status: 'COMPLETED', createdOn: '2026-11-17T16:35:13.971Z',
});
const outAct = { id: 'aout', type: 'TRANSFER', resource: { type: 'TRANSFER', id: '2498670518' },
  title: '<strong>ROCK-IT CARGO LIMITED</strong>', primaryAmount: '660 GBP', status: 'COMPLETED', createdOn: '2026-11-16T14:08:37Z' };
const inTransfer = (id: string, value: number, ref: string) => ({
  id: Number(id), sourceAccount: null, details: { reference: ref }, reference: ref, created: '2026-11-17 16:35:13',
  sourceCurrency: 'GBP', sourceValue: value, targetCurrency: 'GBP', targetValue: value,
});

/** query mock: answer by the SQL it is given. */
function db(opts: { known?: string[]; emailRowsWithoutNumber?: Array<{ id: string; payer_name: string }>; rowByNumber?: Record<string, string> }) {
  mQuery.mockImplementation(async (sql: string, params: unknown[]) => {
    if (sql.includes('SELECT DISTINCT transfer_number')) {
      const wanted = params[0] as string[];
      return { rows: (opts.known || []).filter(n => wanted.includes(n)).map(n => ({ transfer_number: n })) };
    }
    if (sql.includes('transfer_number IS NULL AND amount > 0')) return { rows: opts.emailRowsWithoutNumber || [] };
    if (sql.includes('SELECT id FROM incoming_bank_payments WHERE transfer_number = $1')) {
      const id = opts.rowByNumber?.[params[0] as string];
      return { rows: id ? [{ id }] : [] };
    }
    return { rows: [] };
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  mSetting.mockResolvedValue('true');
});

describe('pollWiseIncoming', () => {
  it('does nothing while the switch is off', async () => {
    mSetting.mockResolvedValue('false');
    expect(await pollWiseIncoming()).toBeNull();
    expect(mList).not.toHaveBeenCalled();
  });

  it('stores a new transfer in, skips known ones without reading them, never touches money out', async () => {
    mList.mockResolvedValue([inAct('2501093374', '2,363.64', 'O I B RE LTD SW'), inAct('2500963573', '30', 'PENGUIN MEDIA HIRE LTD'), outAct]);
    mTransfer.mockImplementation(async (id: string) => inTransfer(id, id === '2501093374' ? 2363.64 : 30, 'X'));
    db({ known: ['2500963573'] });

    const r = await pollWiseIncoming();

    expect(r).toEqual({ incoming: 2, stored: 1, skipped: 0 });
    expect(mTransfer).toHaveBeenCalledTimes(1);
    expect(mTransfer).toHaveBeenCalledWith('2501093374');
    expect(mStore).toHaveBeenCalledTimes(1);
    const [parsed, meta] = mStore.mock.calls[0];
    expect(parsed).toMatchObject({ amount: 2363.64, payerName: 'O I B RE LTD SW', transferNumber: '2501093374' });
    expect(meta).toMatchObject({ key: 'wise-api:2501093374', source: 'wise_api', mailbox: null });
    expect(meta.queueOnly).toBeUndefined();
  });

  it('skips a transfer whose record says it came from our own balance', async () => {
    mList.mockResolvedValue([inAct('2501093374', '2,363.64', 'O I B RE LTD SW')]);
    mTransfer.mockResolvedValue({ ...inTransfer('2501093374', 2363.64, 'X'), sourceAccount: 286049894 });
    db({});
    const r = await pollWiseIncoming();
    expect(r).toEqual({ incoming: 1, stored: 0, skipped: 1 });
    expect(mStore).not.toHaveBeenCalled();
  });

  it('adopts an email row that has no transfer number instead of making a second row', async () => {
    mList.mockResolvedValue([inAct('2501093374', '2,363.64', 'O I B RE LTD SW')]);
    mTransfer.mockResolvedValue(inTransfer('2501093374', 2363.64, 'X'));
    db({ emailRowsWithoutNumber: [{ id: 'row-1', payer_name: 'O I B RE LTD SW' }] });
    await pollWiseIncoming();
    expect(mStore).not.toHaveBeenCalled();
    expect(mQuery.mock.calls.some(([sql]) => String(sql).includes('SET transfer_number = $2'))).toBe(true);
  });

  it('carries on past one transfer that fails', async () => {
    mList.mockResolvedValue([inAct('1111111', '10', 'A'), inAct('2222222', '20', 'B')]);
    mTransfer.mockImplementation(async (id: string) => {
      if (id === '1111111') throw new Error('boom');
      return inTransfer(id, 20, 'Y');
    });
    db({});
    const r = await pollWiseIncoming();
    expect(r).toEqual({ incoming: 2, stored: 1, skipped: 0 });
  });

  it('returns null (and stays quiet) when Wise is down', async () => {
    mList.mockRejectedValue(new Error('down'));
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(await pollWiseIncoming()).toBeNull();
  });
});

describe('addWiseTransferByNumber', () => {
  it('refuses something that is not a transfer number', async () => {
    const r = await addWiseTransferByNumber('abc', 'jon');
    expect(r).toMatchObject({ ok: false, status: 400 });
    expect(mTransfer).not.toHaveBeenCalled();
  });

  it('returns the existing row when OP already has the transfer', async () => {
    db({ rowByNumber: { '2501093374': 'existing-row' } });
    expect(await addWiseTransferByNumber('#2501093374', 'jon')).toEqual({ ok: true, id: 'existing-row', already: true });
    expect(mTransfer).not.toHaveBeenCalled();
  });

  it('refuses money we sent', async () => {
    db({});
    mTransfer.mockResolvedValue({ ...inTransfer('2498670518', 660, 'LON'), sourceAccount: 286049894 });
    const r = await addWiseTransferByNumber('2498670518', 'jon');
    expect(r).toMatchObject({ ok: false, status: 400 });
    expect(mStore).not.toHaveBeenCalled();
  });

  it('says so when Wise has no such transfer', async () => {
    db({});
    mTransfer.mockRejectedValue(new (WiseApiError as unknown as new (s: number, m: string) => Error)(404, 'nope'));
    expect(await addWiseTransferByNumber('2501093374', 'jon')).toMatchObject({ ok: false, status: 404 });
  });

  it('queues a transfer in — never recorded, never emailed — and returns its row', async () => {
    let stored = false;
    mQuery.mockImplementation(async (sql: string) => {
      if (sql.includes('SELECT id FROM incoming_bank_payments WHERE transfer_number = $1')) return { rows: stored ? [{ id: 'new-row' }] : [] };
      return { rows: [] };
    });
    mStore.mockImplementation(async () => { stored = true; return 'stored'; });
    mTransfer.mockResolvedValue(inTransfer('2501093374', 2363.64, 'MUTATIONS X 3'));
    mList.mockResolvedValue([outAct, inAct('2501093374', '2,363.64', 'O I B RE LTD SW')]);

    const r = await addWiseTransferByNumber('2501093374', 'jon@example.com');

    expect(r).toEqual({ ok: true, id: 'new-row', already: false });
    const [parsed, meta] = mStore.mock.calls[0];
    expect(parsed).toMatchObject({ reference: 'MUTATIONS X 3', amount: 2363.64 });
    expect(meta).toMatchObject({ queueOnly: true, source: 'wise_api' });
    expect(meta.notePrefix).toContain('jon@example.com');
  });
});
