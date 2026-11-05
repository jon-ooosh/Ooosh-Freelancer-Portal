import { TABLES, judgeWrite, sameAsDefault } from '../repair-zod4-update-defaults';

const spec = (entityType: string) => TABLES.find((t) => t.entityType === entityType)!;
const verdicts = (findings: { field: string; verdict: string }[]) =>
  Object.fromEntries(findings.map((f) => [f.field, f.verdict]));

describe('sameAsDefault', () => {
  it('reads numeric strings, JSON strings and arrays', () => {
    expect(sameAsDefault(0, '0.00')).toBe(true);
    expect(sameAsDefault(0, '45.00')).toBe(false);
    expect(sameAsDefault([], '[]')).toBe(true);
    expect(sameAsDefault([], [])).toBe(true);
    expect(sameAsDefault([], [{ code: 'TT99' }])).toBe(false);
    expect(sameAsDefault([], {})).toBe(true);      // a wiped JSONB list reads {}
    expect(sameAsDefault([], '{}')).toBe(true);
    expect(sameAsDefault(false, false)).toBe(true);
    expect(sameAsDefault(false, null)).toBe(false);
  });
});

describe('drivers (diff audit)', () => {
  it('Mark as Referred: everything it wiped is restored (Willoughby Robinson)', () => {
    const before = {
      referral_status: null, referral_date: null,
      requires_referral: true, licence_points: 6,
      licence_endorsements: [{ code: 'TT99' }], has_convictions: true,
    };
    const after = {
      referral_status: 'pending', referral_date: '2026-11-05',
      requires_referral: false, licence_points: 0,
      licence_endorsements: '[]', has_convictions: false,
    };
    expect(verdicts(judgeWrite(spec('driver'), before, after))).toEqual({
      requires_referral: 'restore',
      licence_points: 'restore',
      licence_endorsements: 'restore',
      has_convictions: 'restore',
    });
  });

  it('Edit form: points set to 0 is a person\'s change; a wiped referral is not', () => {
    const before = { full_name: 'A', licence_points: 3, requires_referral: true };
    const after = { full_name: 'B', licence_points: 0, requires_referral: false };
    expect(verdicts(judgeWrite(spec('driver'), before, after))).toEqual({ requires_referral: 'restore' });
  });
});

describe('people (full-row audit)', () => {
  const blank = {
    tags: [], files: [], preferred_contact_method: 'email', is_freelancer: false,
    skills: [], is_insured_on_vehicles: false, is_approved: false, has_tshirt: false,
  };
  const freelancer = {
    ...blank, tags: ['crew'], is_freelancer: true, skills: ['driver'],
    is_insured_on_vehicles: true, is_approved: true, has_tshirt: true,
  };

  it('Edit person form: freelancer flags restored, tags left alone', () => {
    const after = { ...blank, tags: ['crew'], mobile: '07…' }; // tags sent → only the form fits
    expect(verdicts(judgeWrite(spec('people'), freelancer, after))).toEqual({
      is_freelancer: 'restore', skills: 'restore', is_insured_on_vehicles: 'restore',
      is_approved: 'restore', has_tshirt: 'restore',
    });
  });

  it('Freelancer panel: tags and is_freelancer restored, its own ticks left alone', () => {
    const after = { ...blank, skills: ['driver'], is_insured_on_vehicles: true, is_approved: true, has_tshirt: false };
    expect(verdicts(judgeWrite(spec('people'), freelancer, after))).toEqual({
      tags: 'restore', is_freelancer: 'restore',
    });
  });

  it('a mobile-only edit: only the edit form or quote contacts fit, so the freelancer ticks are restored', () => {
    const before = { ...freelancer, mobile: null };
    const after = { ...blank, mobile: '07700900123' };
    expect(verdicts(judgeWrite(spec('people'), before, after))).toEqual({
      tags: 'review', is_freelancer: 'restore', skills: 'restore',
      is_insured_on_vehicles: 'restore', is_approved: 'restore', has_tshirt: 'restore',
    });
  });

  it('a freelancer-panel-only change: only the panel fits, so its own ticks are left alone', () => {
    const before = { ...freelancer, freelancer_references: null };
    const after = { ...blank, freelancer_references: 'ok' };
    expect(verdicts(judgeWrite(spec('people'), before, after))).toEqual({
      tags: 'restore', is_freelancer: 'restore',
    });
  });

  it('nothing else changed and everything at its default: fields some screen sends are REVIEW', () => {
    expect(verdicts(judgeWrite(spec('people'), freelancer, blank))).toEqual({
      tags: 'review', is_freelancer: 'restore', skills: 'review',
      is_insured_on_vehicles: 'review', is_approved: 'review', has_tshirt: 'review',
    });
  });

  it('a write no screen could have made is ignored (partial after row)', () => {
    expect(judgeWrite(spec('people'), freelancer, { id: 'x', first_name: 'A', is_freelancer: true })).toEqual([]);
  });
});

describe('storage tenancies (after-only audit)', () => {
  const defaults = {
    status: 'active', access_type: 'door_code',
    billing_mode: 'manual', billing_cadence: 'monthly', rate_review_cadence: 'annual',
  };
  const before = { ...defaults, status: 'notice', billing_mode: 'recurring', rate_review_cadence: 'biennial' };

  it('weekly_rate is not judged — the edit route never writes it', () => {
    expect(TABLES.find((t) => t.entityType === 'storage_tenancies')!.defaults).not.toHaveProperty('weekly_rate');
  });

  it('edit form: rate review restored, the form\'s own fields left alone', () => {
    const after = { ...defaults, status: 'notice', billing_mode: 'recurring', notes: 'x' };
    expect(verdicts(judgeWrite(spec('storage_tenancies'), before, after))).toEqual({ rate_review_cadence: 'restore' });
  });

  it('notes edit (everything defaulted): rate review restored, form fields REVIEW', () => {
    expect(verdicts(judgeWrite(spec('storage_tenancies'), before, { ...defaults, notes: 'x' }))).toEqual({
      rate_review_cadence: 'restore', status: 'review', billing_mode: 'review',
    });
  });

  it('no earlier record of the value: flagged to check by hand', () => {
    expect(verdicts(judgeWrite(spec('storage_tenancies'), {}, { ...defaults }))).toEqual({
      rate_review_cadence: 'no-record',
    });
  });
});

describe('held items', () => {
  it('photos taken to none are restored', () => {
    const f = judgeWrite(spec('held_items'), { photos: [{ url: 'a' }] }, { photos: [], status: 'cancelled' });
    expect(verdicts(f)).toEqual({ photos: 'restore' });
    expect(f[0].before).toEqual([{ url: 'a' }]);
  });
});
