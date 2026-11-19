/**
 * "Are this job's hire agreements out of date with its dates?"
 * (services/hire-agreement-dates.ts `planAgreementRow`).
 *
 * Load-bearing:
 *   1. HH 16892: a row with NO stored dates (it follows the job) whose
 *      agreement printed the old end date IS flagged — the old check missed it.
 *   2. Put the job's dates back (a client who only wanted a price) and nothing
 *      is flagged: the warning goes away by itself.
 *   3. An agreement made before mig 358 (no recorded dates) is only judged
 *      when the row's stored dates have drifted — otherwise we can't tell.
 *   4. Stored dates that drifted are flagged even with no agreement yet, and
 *      the button moves only the stored ones (an unstored date keeps
 *      following the job).
 *   5. A multi-van driver's other-van agreements are judged one by one.
 */
jest.mock('../../config/database', () => ({ query: jest.fn() }));

import { planAgreementRow, hireDateYmd, type AgreementRowInput } from '../hire-agreement-dates';

const base: AgreementRowInput = {
  storedStart: null,
  storedEnd: null,
  printsNowStart: '2026-11-09',
  printsNowEnd: '2026-11-25',
  ownAgreement: null,
  otherVanAgreements: [],
};

describe('planAgreementRow', () => {
  it('flags an extended hire whose row follows the job (HH 16892)', () => {
    const plan = planAgreementRow(
      { ...base, ownAgreement: { printedStart: '2026-11-09', printedEnd: '2026-11-23' } },
      '2026-11-09',
      '2026-11-25',
    );
    expect(plan).toMatchObject({
      storedDrift: false,
      ownStale: true,
      needsAttention: true,
      afterStart: '2026-11-09',
      afterEnd: '2026-11-25',
    });
  });

  it('flags nothing once the dates are put back', () => {
    const plan = planAgreementRow(
      {
        ...base,
        printsNowEnd: '2026-11-23',
        ownAgreement: { printedStart: '2026-11-09', printedEnd: '2026-11-23' },
      },
      '2026-11-09',
      '2026-11-23',
    );
    expect(plan.needsAttention).toBe(false);
  });

  it('flags a start-date change too', () => {
    const plan = planAgreementRow(
      {
        ...base,
        printsNowStart: '2026-11-10',
        ownAgreement: { printedStart: '2026-11-09', printedEnd: '2026-11-25' },
      },
      '2026-11-10',
      '2026-11-25',
    );
    expect(plan.ownStale).toBe(true);
  });

  it('cannot judge an agreement made before the dates were recorded', () => {
    const plan = planAgreementRow(
      { ...base, ownAgreement: { printedStart: null, printedEnd: null } },
      '2026-11-09',
      '2026-11-25',
    );
    expect(plan.needsAttention).toBe(false);
  });

  it('judges an unrecorded agreement as stale when the stored dates drifted', () => {
    const plan = planAgreementRow(
      {
        ...base,
        storedStart: '2026-11-09',
        storedEnd: '2026-11-23',
        printsNowEnd: '2026-11-23',
        ownAgreement: { printedStart: null, printedEnd: null },
      },
      '2026-11-09',
      '2026-11-25',
    );
    expect(plan).toMatchObject({ storedDrift: true, ownStale: true, afterEnd: '2026-11-25' });
  });

  it('flags drifted stored dates with no agreement yet', () => {
    const plan = planAgreementRow(
      { ...base, storedEnd: '2026-11-23', printsNowEnd: '2026-11-23' },
      '2026-11-09',
      '2026-11-25',
    );
    expect(plan).toMatchObject({ storedDrift: true, ownStale: false, needsAttention: true });
  });

  it('moves only the stored date; an unstored one keeps following the job', () => {
    const plan = planAgreementRow(
      { ...base, storedEnd: '2026-11-23', printsNowStart: '2026-11-09', printsNowEnd: '2026-11-23' },
      '2026-11-09',
      '2026-11-25',
    );
    expect(plan.afterStart).toBe('2026-11-09');
    expect(plan.afterEnd).toBe('2026-11-25');
  });

  it('is happy when stored dates already match the job and the agreement matches', () => {
    const plan = planAgreementRow(
      {
        ...base,
        storedStart: '2026-11-09',
        storedEnd: '2026-11-25',
        ownAgreement: { printedStart: '2026-11-09', printedEnd: '2026-11-25' },
      },
      '2026-11-09',
      '2026-11-25',
    );
    expect(plan.needsAttention).toBe(false);
  });

  it('judges each other-van agreement on its own', () => {
    const plan = planAgreementRow(
      {
        ...base,
        ownAgreement: { printedStart: '2026-11-09', printedEnd: '2026-11-25' },
        otherVanAgreements: [
          { printedStart: '2026-11-09', printedEnd: '2026-11-25' },
          { printedStart: '2026-11-09', printedEnd: '2026-11-23' },
          { printedStart: null, printedEnd: null },
        ],
      },
      '2026-11-09',
      '2026-11-25',
    );
    expect(plan.ownStale).toBe(false);
    expect(plan.staleOtherVan).toEqual([1]);
    expect(plan.needsAttention).toBe(true);
  });
});

describe('hireDateYmd', () => {
  it('reads strings and dates the way the agreement PDF does', () => {
    expect(hireDateYmd('2026-11-25')).toBe('2026-11-25');
    expect(hireDateYmd('2026-11-25T09:00:00Z')).toBe('2026-11-25');
    expect(hireDateYmd(new Date('2026-11-25T09:00:00Z'))).toBe('2026-11-25');
    expect(hireDateYmd(null)).toBeUndefined();
    expect(hireDateYmd('')).toBeUndefined();
    expect(hireDateYmd(new Date('nope'))).toBeUndefined();
  });
});
