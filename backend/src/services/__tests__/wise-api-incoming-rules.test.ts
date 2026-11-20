/**
 * Money IN vs money OUT from the Wise API. The fixtures are the real payloads read
 * from the live business account on 20 Nov 2026: #2501093374 (O I B RE, £2,363.64 in —
 * the transfer Wise never emailed about), #2500963573 (Penguin, £30 in), #2498670518
 * (Rock-It Cargo, £660 OUT) and a DVLA Direct Debit (out). A supplier payment taken
 * as a client payment would mark a job paid, so every "out" shape must be refused.
 */
import {
  readActivityAmount, isIncomingTransferActivity, toIncomingPayment, parseWiseTransferCreated, stripTags, samePayer,
} from '../wise-api-incoming-rules';
import type { WiseActivity, WiseTransfer } from '../../config/wise';

const oibActivity: WiseActivity = {
  id: 'TU9ORVRBUllfQUNUSVZJVFk6OjY3NTY1NDA6OlRSQU5TRkVSOjoyNTAxMDkzMzc0', type: 'TRANSFER',
  resource: { type: 'TRANSFER', id: '2501093374' }, title: '<strong>O I B RE LTD SW</strong>', description: '',
  primaryAmount: '<positive>+ 2,363.64 GBP</positive>', status: 'COMPLETED',
  createdOn: '2026-11-17T16:35:13.971Z',
};
const oibTransfer: WiseTransfer = {
  id: 2501093374, targetAccount: 1183847413, sourceAccount: null, reference: 'MUTATIONS X 3',
  details: { reference: 'MUTATIONS X 3' }, created: '2026-11-17 16:35:13',
  sourceCurrency: 'GBP', sourceValue: 2363.64, targetCurrency: 'GBP', targetValue: 2363.64,
};
const rockItActivity: WiseActivity = {
  id: 'x', type: 'TRANSFER', resource: { type: 'TRANSFER', id: '2498670518' },
  title: '<strong>ROCK-IT CARGO LIMITED</strong>', description: 'Sent by William Matthew Parish',
  primaryAmount: '660 GBP', status: 'COMPLETED', createdOn: '2026-11-16T14:08:37.107Z',
};
const rockItTransfer: WiseTransfer = {
  id: 2498670518, targetAccount: 487877670, sourceAccount: 286049894, reference: 'LON-105438-001',
  details: { reference: 'LON-105438-001' }, created: '2026-11-16 14:08:36',
  sourceCurrency: 'GBP', sourceValue: 660, targetCurrency: 'GBP', targetValue: 660,
};
const dvlaActivity: WiseActivity = {
  id: 'y', type: 'DIRECT_DEBIT_TRANSACTION', resource: { type: 'DIRECT_DEBIT_TRANSACTION', id: '41464649' },
  title: '<strong>Driver & Vehicle Licensing Agency</strong>', description: 'Sent',
  primaryAmount: '360 GBP', status: 'COMPLETED', createdOn: '2026-11-13T08:36:25.493Z',
};

describe('readActivityAmount', () => {
  it('reads money in', () => {
    expect(readActivityAmount('<positive>+ 2,363.64 GBP</positive>')).toEqual({ incoming: true, amount: 2363.64, currency: 'GBP' });
    expect(readActivityAmount('<positive>+ 30 GBP</positive>')).toEqual({ incoming: true, amount: 30, currency: 'GBP' });
  });
  it('reads money out as not incoming', () => {
    expect(readActivityAmount('810 GBP')).toEqual({ incoming: false, amount: 810, currency: 'GBP' });
    expect(readActivityAmount('- 810 GBP').incoming).toBe(false);
  });
  it('needs BOTH the positive marker and the plus sign', () => {
    expect(readActivityAmount('+ 30 GBP').incoming).toBe(false);
    expect(readActivityAmount('<positive>30 GBP</positive>').incoming).toBe(false);
  });
  it('copes with nothing readable', () => {
    expect(readActivityAmount(null)).toEqual({ incoming: false, amount: null, currency: null });
    expect(readActivityAmount('')).toEqual({ incoming: false, amount: null, currency: null });
  });
});

describe('isIncomingTransferActivity', () => {
  it('accepts a completed transfer in', () => {
    expect(isIncomingTransferActivity(oibActivity)).toBe(true);
  });
  it('refuses money out, direct debits and unfinished transfers', () => {
    expect(isIncomingTransferActivity(rockItActivity)).toBe(false);
    expect(isIncomingTransferActivity(dvlaActivity)).toBe(false);
    expect(isIncomingTransferActivity({ ...oibActivity, status: 'IN_PROGRESS' })).toBe(false);
    expect(isIncomingTransferActivity({ ...oibActivity, type: 'BALANCE_DEPOSIT', resource: { type: 'BALANCE_DEPOSIT', id: '1' } })).toBe(false);
    expect(isIncomingTransferActivity(null)).toBe(false);
  });
});

describe('toIncomingPayment', () => {
  it('turns the O I B RE transfer into what the email parser would have given', () => {
    const r = toIncomingPayment(oibActivity, oibTransfer);
    expect(r).toEqual({
      ok: true,
      receivedAt: new Date('2026-11-17T16:35:13.971Z'),
      parsed: {
        payerName: 'O I B RE LTD SW', amount: 2363.64, currency: 'GBP', fee: null,
        amountCredited: 2363.64, reference: 'MUTATIONS X 3', transferNumber: '2501093374',
      },
    });
  });

  it('refuses a transfer that came from one of our balances, even if the activity looked like money in', () => {
    const lying: WiseActivity = { ...rockItActivity, primaryAmount: '<positive>+ 660 GBP</positive>' };
    const r = toIncomingPayment(lying, rockItTransfer);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/money out/);
  });

  it('refuses a real outgoing payment at the first check', () => {
    expect(toIncomingPayment(rockItActivity, rockItTransfer).ok).toBe(false);
  });

  it('refuses when Wise leaves out where the money came from', () => {
    const { sourceAccount: _drop, ...noSource } = oibTransfer;
    const r = toIncomingPayment(oibActivity, noSource as WiseTransfer);
    expect(r.ok).toBe(false);
  });

  it('refuses when the activity and the transfer disagree on the amount', () => {
    expect(toIncomingPayment(oibActivity, { ...oibTransfer, targetValue: 2363.65 }).ok).toBe(false);
    expect(toIncomingPayment(oibActivity, { ...oibTransfer, targetCurrency: 'EUR' }).ok).toBe(false);
  });

  it('refuses a transfer record for a different number', () => {
    expect(toIncomingPayment(oibActivity, { ...oibTransfer, id: 2500963573 }).ok).toBe(false);
    expect(toIncomingPayment(oibActivity, null).ok).toBe(false);
  });

  it('keeps what was SENT as the amount and works out a fee', () => {
    const r = toIncomingPayment(
      { ...oibActivity, primaryAmount: '<positive>+ 2,343.84 GBP</positive>' },
      { ...oibTransfer, sourceValue: 2346, targetValue: 2343.84 },
    );
    expect(r.ok && r.parsed).toMatchObject({ amount: 2346, amountCredited: 2343.84, fee: 2.16 });
  });

  it('takes the reference from details first, and empty becomes null', () => {
    const r = toIncomingPayment(oibActivity, { ...oibTransfer, details: { reference: '  ' }, reference: '' });
    expect(r.ok && r.parsed.reference).toBeNull();
  });

  it('falls back to the transfer time when the activity has none', () => {
    const r = toIncomingPayment({ ...oibActivity, createdOn: null }, oibTransfer);
    expect(r.ok && r.receivedAt.toISOString()).toBe('2026-11-17T16:35:13.000Z');
  });
});

describe('parseWiseTransferCreated', () => {
  it('reads Wise\'s zone-less time as UTC', () => {
    expect(parseWiseTransferCreated('2026-11-17 16:35:13')?.toISOString()).toBe('2026-11-17T16:35:13.000Z');
  });
  it('respects an explicit zone and rejects junk', () => {
    expect(parseWiseTransferCreated('2026-11-17T16:35:13Z')?.toISOString()).toBe('2026-11-17T16:35:13.000Z');
    expect(parseWiseTransferCreated('not a date')).toBeNull();
    expect(parseWiseTransferCreated(null)).toBeNull();
  });
});

describe('stripTags / samePayer', () => {
  const norm = (s: string | null | undefined) => (s || '').toUpperCase().replace(/\b(LTD|LIMITED)\b/g, ' ').replace(/[^A-Z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
  it('strips Wise\'s markup', () => {
    expect(stripTags('<strong>Driver &amp; Vehicle</strong>')).toBe('Driver & Vehicle');
  });
  it('matches the same payer however Wise spaced it', () => {
    expect(samePayer('O I B RE LTD SW', 'OIB RE LTD SW', norm)).toBe(true);
    expect(samePayer('PENGUIN MEDIA HIRE LTD', 'Penguin Media Hire', norm)).toBe(true);
    expect(samePayer('PENGUIN MEDIA', 'HEBSON', norm)).toBe(false);
    expect(samePayer('', '', norm)).toBe(false);
  });
});
