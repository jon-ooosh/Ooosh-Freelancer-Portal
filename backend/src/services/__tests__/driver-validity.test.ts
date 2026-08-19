import {
  computeDriverValidity,
  persistableWindows,
  addDaysYmd,
  toYmd,
  touchesValidity,
} from '../driver-validity';

// Fixed "today" so these never rot.
const TODAY = '2026-08-19';

describe('addDaysYmd', () => {
  it('is UTC-anchored across a BST boundary', () => {
    // Local-Date + toISOString() drifts a day under BST; this must not.
    expect(addDaysYmd('2026-06-15', 90)).toBe('2026-09-13');
    expect(addDaysYmd('2026-03-28', 30)).toBe('2026-04-27');
  });
  it('crosses month and year ends', () => {
    expect(addDaysYmd('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDaysYmd('2026-02-28', 1)).toBe('2026-03-01'); // 2026 is not a leap year
  });
  it('returns null for null input', () => {
    expect(addDaysYmd(null, 30)).toBeNull();
  });
});

describe('toYmd', () => {
  it('accepts the raw ISO timestamp the iDenfy webhook writes to a VARCHAR column', () => {
    expect(toYmd('2026-08-18T12:26:19.937Z')).toBe('2026-08-18');
  });
  it('accepts a pg DATE column (JS Date)', () => {
    expect(toYmd(new Date(Date.UTC(2026, 7, 9)))).toBe('2026-08-09');
  });
  it('returns null for empty and junk', () => {
    expect(toYmd('')).toBeNull();
    expect(toYmd(null)).toBeNull();
    expect(toYmd('not a date')).toBeNull();
  });
});

describe('licence integrity guard', () => {
  // manjagoproduction@, 18 Aug 2026: iDenfy DENIED, so a checkDate was written
  // with no document data behind it. The detail page rendered a confident green
  // "16 Nov 2026" for a driver with no licence, no name and no files.
  const denied = {
    idenfy_check_date: '2026-08-18T12:26:19.937Z',
    licence_issued_by: null,
    licence_valid_to: null,
  };

  it('does not manufacture a window from a check date with no licence identity', () => {
    const v = computeDriverValidity(denied, TODAY);
    expect(v.licence.trusted).toBe(false);
    expect(v.licence.until).toBeNull();
    expect(v.licence.valid).toBe(false);
    expect(v.licence.untrustedReason).toMatch(/re-verification/i);
  });

  it('persists NULL rather than a green window for an untrusted licence', () => {
    expect(persistableWindows(denied).licence_check_valid_until).toBeNull();
  });

  it('trusts the same check date once licence details are present', () => {
    const v = computeDriverValidity({ ...denied, licence_issued_by: 'DVLA' }, TODAY);
    expect(v.licence.trusted).toBe(true);
    expect(v.licence.until).toBe('2026-11-16');
    expect(v.licence.valid).toBe(true);
  });

  it('treats whitespace-only licence_issued_by as absent', () => {
    const v = computeDriverValidity({ ...denied, licence_issued_by: '   ' }, TODAY);
    expect(v.licence.trusted).toBe(false);
  });
});

describe('window derivation', () => {
  it("caps the licence window at the licence's own expiry", () => {
    const v = computeDriverValidity({
      idenfy_check_date: '2026-08-09',
      licence_issued_by: 'DVLA',
      licence_valid_to: '2026-09-01', // sooner than check + 90d
    }, TODAY);
    expect(v.licence.until).toBe('2026-09-01');
    expect(v.licence.cappedBy).toBe('2026-09-01');
  });

  it('leaves cappedBy unset when the 90-day window is the binding limit', () => {
    const v = computeDriverValidity({
      idenfy_check_date: '2026-08-09',
      licence_issued_by: 'DVLA',
      licence_valid_to: '2029-04-18',
    }, TODAY);
    expect(v.licence.until).toBe('2026-11-07');
    expect(v.licence.cappedBy).toBeNull();
  });

  it('derives DVLA as check + 30d', () => {
    // Peter Christopherson, job 16291: dvla_check_date was editable and moved,
    // dvla_valid_until was not and stayed at a stale 2026-05-28.
    const v = computeDriverValidity({ dvla_check_date: '2026-08-13' }, TODAY);
    expect(v.dvla.from).toBe('2026-08-13');
    expect(v.dvla.until).toBe('2026-09-12');
    expect(v.dvla.valid).toBe(true);
  });

  it("caps the passport window at the passport's printed expiry", () => {
    const v = computeDriverValidity({
      passport_check_date: '2026-08-01',
      passport_expiry: '2026-08-20',
    }, TODAY);
    expect(v.passport.until).toBe('2026-08-20');
    expect(v.passport.cappedBy).toBe('2026-08-20');
  });

  it('treats POA1 and POA2 as fully independent', () => {
    const v = computeDriverValidity({
      poa1_doc_date: '2026-06-07', // + 90d => 2026-09-05, still valid
      poa2_doc_date: '2026-01-01', // + 90d => 2026-04-01, lapsed
    }, TODAY);
    expect(v.poa1.valid).toBe(true);
    expect(v.poa2.valid).toBe(false);
  });

  it('counts a window expiring today as still valid', () => {
    const v = computeDriverValidity({ dvla_check_date: addDaysYmd(TODAY, -30) }, TODAY);
    expect(v.dvla.until).toBe(TODAY);
    expect(v.dvla.valid).toBe(true);
  });
});

describe('persistableWindows', () => {
  it('reproduces the stored value it was back-computed from (migration 192 is value-preserving)', () => {
    // Backfill sets poa1_doc_date = poa1_valid_until - 90d; re-deriving must
    // land on exactly the original expiry, so nobody's status moves on deploy.
    const original = '2026-09-05';
    const derived = persistableWindows({ poa1_doc_date: addDaysYmd(original, -90) });
    expect(derived.poa1_valid_until).toBe(original);
  });

  it('emits null for every window with no FROM date', () => {
    expect(persistableWindows({})).toEqual({
      licence_check_valid_until: null,
      dvla_valid_until: null,
      poa1_valid_until: null,
      poa2_valid_until: null,
      passport_valid_until: null,
    });
  });
});

describe('touchesValidity', () => {
  it('fires on a FROM-date write and ignores unrelated columns', () => {
    expect(touchesValidity(['dvla_check_date'])).toBe(true);
    expect(touchesValidity(['poa1_doc_date', 'phone'])).toBe(true);
    expect(touchesValidity(['phone', 'address_full'])).toBe(false);
  });
});
