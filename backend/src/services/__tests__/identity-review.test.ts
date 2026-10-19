import { faceNeedsReview, idenfyNeedsReview, isIdentityAuthorised, identityHoldReason } from '../identity-review';

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

describe('idenfyNeedsReview', () => {
  it('flags a REJECTED DOCUMENT even when the face matched perfectly', () => {
    // The two drivers that prompted the Sep 2026 widening. Both had a perfect
    // face match and a document iDenfy refused, so the face-only test passed
    // them straight through to a green 90-day licence window.
    expect(idenfyNeedsReview({ overall: 'DENIED', faceResult: 'FACE_MATCH' })).toBe(true);  // Jo Walker / 16249
    expect(idenfyNeedsReview({ overall: 'DENIED', faceResult: 'FACE_MATCH' })).toBe(true);  // Simon Halliday / 15551
  });

  it('flags SUSPECTED', () => {
    expect(idenfyNeedsReview({ overall: 'SUSPECTED', faceResult: 'FACE_MATCH' })).toBe(true);
    expect(idenfyNeedsReview({ overall: 'suspected' })).toBe(true);
    expect(idenfyNeedsReview({ overall: ' DENIED ' })).toBe(true);
  });

  it('does NOT flag EXPIRED — an abandoned session is not a failed check', () => {
    // iDenfy fires EXPIRED when the driver never completes the flow. Flagging
    // it would raise a review on innocent drivers several times a week and the
    // flag would stop being believed. What an expired session must not do is
    // leave evidence behind, which is handled in the hire-form app.
    expect(idenfyNeedsReview({ overall: 'EXPIRED' })).toBe(false);
    expect(idenfyNeedsReview({ overall: 'EXPIRED', faceResult: null })).toBe(false);
  });

  it('still flags a face mismatch on an otherwise APPROVED check', () => {
    expect(idenfyNeedsReview({ overall: 'APPROVED', faceResult: 'FACE_MISMATCH' })).toBe(true);
    expect(idenfyNeedsReview({ overall: 'APPROVED', faceResult: 'AUTO_UNVERIFIABLE' })).toBe(true);
  });

  it('passes a clean check', () => {
    expect(idenfyNeedsReview({ overall: 'APPROVED', faceResult: 'FACE_MATCH' })).toBe(false);
  });

  it('does not flag on an absent verdict', () => {
    // A step that posts only POA dates carries no verdict; it must not raise one.
    expect(idenfyNeedsReview({})).toBe(false);
    expect(idenfyNeedsReview({ overall: null, faceResult: null })).toBe(false);
  });
});
