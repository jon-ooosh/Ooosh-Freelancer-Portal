import { faceNeedsReview, isIdentityAuthorised, identityHoldReason } from '../identity-review';

describe('faceNeedsReview', () => {
  it('flags an explicit non-match', () => {
    expect(faceNeedsReview('FACE_MISMATCH')).toBe(true);
    expect(faceNeedsReview('NO_FACE_FOUND')).toBe(true);
    expect(faceNeedsReview('face_mismatch')).toBe(true); // case-insensitive
    expect(faceNeedsReview(' FACE_MISMATCH ')).toBe(true);
  });

  it('does not flag a match', () => {
    expect(faceNeedsReview('FACE_MATCH')).toBe(false);
  });

  it('does NOT flag an absent result', () => {
    // A passport-only session runs no face comparison. Treating "no result" as
    // a failure would raise a false review on every second-document upload.
    expect(faceNeedsReview(null)).toBe(false);
    expect(faceNeedsReview(undefined)).toBe(false);
    expect(faceNeedsReview('')).toBe(false);
  });
});

describe('isIdentityAuthorised', () => {
  it('holds back an unresolved or rejected check', () => {
    expect(isIdentityAuthorised('needs_review')).toBe(false);
    expect(isIdentityAuthorised('rejected')).toBe(false);
  });

  it('authorises a staff-accepted check', () => {
    expect(isIdentityAuthorised('accepted')).toBe(true);
  });

  it('fails OPEN on no concern or an unknown status', () => {
    // Matches isDriverAuthorisedForAgreement: a data gap must never silently
    // block a driver. Only an explicit hold state holds.
    expect(isIdentityAuthorised(null)).toBe(true);
    expect(isIdentityAuthorised(undefined)).toBe(true);
    expect(isIdentityAuthorised('something_unexpected')).toBe(true);
  });
});

describe('identityHoldReason', () => {
  it('explains only the states that actually hold', () => {
    expect(identityHoldReason('needs_review')).toMatch(/compare the selfie/i);
    expect(identityHoldReason('rejected')).toMatch(/not authorised/i);
    expect(identityHoldReason('accepted')).toBeNull();
    expect(identityHoldReason(null)).toBeNull();
  });
});
