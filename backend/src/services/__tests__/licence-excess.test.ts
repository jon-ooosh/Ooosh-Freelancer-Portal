import {
  computeLicenceExcess,
  EXCESS_FLOOR_GROSS,
  SERIOUS_OFFENCE_CODES,
} from '../licence-excess';

const clean = { points: 0, endorsements: [] };

describe('computeLicenceExcess — approved tiers', () => {
  it('prices a clean licence at the £1,200 floor', () => {
    const r = computeLicenceExcess(clean);
    expect(r.amount).toBe(1200);
    expect(EXCESS_FLOOR_GROSS).toBe(1200);
    expect(r.requiresReferral).toBe(false);
    expect(r.surchargeNet).toBe(0);
  });

  it('leaves 3 points at the floor', () => {
    const r = computeLicenceExcess({ points: 3, endorsements: [{ code: 'SP30', points: 3 }] });
    expect(r.amount).toBe(1200);
    expect(r.requiresReferral).toBe(false);
  });

  it('leaves two 3-pointers adding to 6 at the floor', () => {
    const r = computeLicenceExcess({
      points: 6,
      endorsements: [{ code: 'SP30', points: 3 }, { code: 'TS10', points: 3 }],
    });
    expect(r.amount).toBe(1200);
    expect(r.requiresReferral).toBe(false);
  });

  it.each(['SP30', 'SP50', 'CU80'])('surcharges a single 6-point %s to £2,400', (code) => {
    const r = computeLicenceExcess({ points: 6, endorsements: [{ code, points: 6 }] });
    expect(r.amount).toBe(2400);
    expect(r.surchargeNet).toBe(1000);
    expect(r.requiresReferral).toBe(false);
    expect(r.basis).toContain(code);
  });

  it('surcharges exactly three 3-pointers at 9 points to £1,800', () => {
    const r = computeLicenceExcess({
      points: 9,
      endorsements: [
        { code: 'SP30', points: 3 },
        { code: 'SP50', points: 3 },
        { code: 'TS10', points: 3 },
      ],
    });
    expect(r.amount).toBe(1800);
    expect(r.surchargeNet).toBe(500);
    expect(r.requiresReferral).toBe(false);
  });
});

describe('computeLicenceExcess — referrals', () => {
  it('quotes NO figure on a referral — null, never the floor', () => {
    const r = computeLicenceExcess({ points: 12, endorsements: [{ code: 'SP30', points: 12 }] });
    expect(r.amount).toBeNull();
    expect(r.requiresReferral).toBe(true);
  });

  it.each([...SERIOUS_OFFENCE_CODES])('refers on serious code %s whatever the points', (code) => {
    const r = computeLicenceExcess({ points: 3, endorsements: [{ code, points: 3 }] });
    expect(r.requiresReferral).toBe(true);
    expect(r.amount).toBeNull();
    expect(r.reasons.join(' ')).toContain(code);
  });

  it('refers on a disqualification even with a clean points total', () => {
    const r = computeLicenceExcess({ ...clean, hasDisqualification: true });
    expect(r.requiresReferral).toBe(true);
    expect(r.reasons.join(' ')).toMatch(/ban or disqualification/);
  });

  it('refers on a 6-point offence that is not pre-approved', () => {
    const r = computeLicenceExcess({ points: 6, endorsements: [{ code: 'CD10', points: 6 }] });
    expect(r.requiresReferral).toBe(true);
    expect(r.reasons.join(' ')).toContain('CD10');
  });

  it('refers on 9 points that are not three 3-pointers', () => {
    const r = computeLicenceExcess({
      points: 9,
      endorsements: [{ code: 'SP30', points: 6 }, { code: 'TS10', points: 3 }],
    });
    expect(r.requiresReferral).toBe(true);
  });

  // 7 and 8 fall through `<= 6` and `=== 9` into the referral arm. That is the
  // ported behaviour, not a new rule — see the comment in licence-excess.ts.
  it.each([7, 8, 10, 11, 20])('refers on %i points', (points) => {
    const r = computeLicenceExcess({ points, endorsements: [] });
    expect(r.requiresReferral).toBe(true);
    expect(r.amount).toBeNull();
  });

  it('names the real points total in the reason, not "10+"', () => {
    expect(computeLicenceExcess({ points: 7, endorsements: [] }).reasons[0])
      .toContain('7 points');
  });
});

describe('computeLicenceExcess — input hygiene', () => {
  it('lower-cased and padded offence codes still match', () => {
    const r = computeLicenceExcess({ points: 6, endorsements: [{ code: ' sp30 ', points: 6 }] });
    expect(r.amount).toBe(2400);
  });

  it('treats junk points as zero rather than throwing', () => {
    const r = computeLicenceExcess({ points: NaN as unknown as number, endorsements: [] });
    expect(r.amount).toBe(1200);
  });

  it('never returns a negative or fractional amount', () => {
    const r = computeLicenceExcess({ points: -3 as unknown as number, endorsements: [] });
    expect(r.amount).toBe(1200);
    expect(Number.isInteger(r.amount)).toBe(true);
  });
});
