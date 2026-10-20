/**
 * The hire form may RAISE a referral, never lower one.
 *
 * The insurance questionnaire sends requiresReferral:false + referralReasons:null
 * whenever every answer is "no". Applied as-is that wiped an existing referral —
 * including one the insurer had DECLINED — and the book-out gate
 * (isDriverAuthorisedForAgreement) passes any driver with requires_referral=false.
 */
import { isReferralDowngrade } from '../driver-verification';

describe('isReferralDowngrade', () => {
  it('drops requires_referral=false (a clean questionnaire)', () => {
    expect(isReferralDowngrade('requires_referral', false)).toBe(true);
  });

  it('drops a null or missing requires_referral', () => {
    expect(isReferralDowngrade('requires_referral', null)).toBe(true);
    expect(isReferralDowngrade('requires_referral', undefined)).toBe(true);
  });

  it('keeps requires_referral=true (the form raising a referral)', () => {
    expect(isReferralDowngrade('requires_referral', true)).toBe(false);
  });

  it('drops blanked referral notes', () => {
    expect(isReferralDowngrade('referral_notes', null)).toBe(true);
    expect(isReferralDowngrade('referral_notes', '')).toBe(true);
    expect(isReferralDowngrade('referral_notes', '   ')).toBe(true);
    expect(isReferralDowngrade('referral_notes', [])).toBe(true);
  });

  it('keeps referral notes that say something', () => {
    expect(isReferralDowngrade('referral_notes', ['Driver declared previous accidents'])).toBe(false);
    expect(isReferralDowngrade('referral_notes', '10+ points - requires insurer referral')).toBe(false);
  });

  it('leaves every other field alone, including false booleans', () => {
    expect(isReferralDowngrade('has_accidents', false)).toBe(false);
    expect(isReferralDowngrade('insurance_status', 'Approved')).toBe(false);
    expect(isReferralDowngrade('date_passed_test', null)).toBe(false);
  });
});
