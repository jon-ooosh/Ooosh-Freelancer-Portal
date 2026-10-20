/**
 * A UK driver whose proofs of address show a different address from their
 * licence also supplies a passport (agreed with the broker). Order:
 * POA1 → POA2 → passport → DVLA → signature.
 *
 * Until Oct 2026 four router branches ignored the mismatch, and the flag only
 * lived in the driver's browser tab — so a driver who came back from the email
 * link after their POAs went straight to DVLA and signature with no passport.
 * The flag is now stored (drivers.address_mismatch, migration 298) and every
 * branch checks it.
 */
import { calculateNextStep, buildDriverStatusResponse } from '../driver-verification';

type Doc = { valid: boolean; expiryDate: string | null };
const doc = (valid: boolean): Doc => ({ valid, expiryDate: null });

function analysis(o: { uk?: boolean; licence?: boolean; poa?: boolean; dvla?: boolean; passport?: boolean }) {
  const uk = o.uk ?? true;
  const a = {
    licence: doc(o.licence ?? true),
    poa1: { ...doc(o.poa ?? true), provider: null },
    poa2: { ...doc(o.poa ?? true), provider: null },
    dvla: doc(o.dvla ?? false),
    passport: doc(o.passport ?? false),
    isUkDriver: uk,
    allValid: false,
  };
  a.allValid = a.licence.valid && a.poa1.valid && a.poa2.valid && (uk ? a.dvla.valid : a.passport.valid);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return a as any;
}

describe('calculateNextStep — UK driver whose address differs from their licence', () => {
  it.each(['insurance-complete', 'idenfy-complete', 'processing-hub', 'poa2-complete', 'some-other-step'])(
    'asks for the passport before DVLA from %s',
    (step) => {
      expect(calculateNextStep(analysis({}), step, true).step).toBe('passport-upload');
    },
  );

  it('asks for the passport even when DVLA is already done (dvla-check)', () => {
    expect(calculateNextStep(analysis({ dvla: true }), 'dvla-check', true).step).toBe('passport-upload');
  });

  it('asks for the passport even when DVLA is already done (dvla-complete)', () => {
    expect(calculateNextStep(analysis({ dvla: true }), 'dvla-complete', true).step).toBe('passport-upload');
  });

  it('goes on to DVLA once the passport is done', () => {
    expect(calculateNextStep(analysis({ passport: true }), 'passport-complete', true).step).toBe('dvla-check');
    expect(calculateNextStep(analysis({ passport: true }), 'insurance-complete', true).step).toBe('dvla-check');
  });

  it('goes to signature when passport and DVLA are both done', () => {
    expect(calculateNextStep(analysis({ passport: true, dvla: true }), 'insurance-complete', true).step).toBe('signature');
  });

  it('still sends them to POAs first', () => {
    expect(calculateNextStep(analysis({ poa: false }), 'insurance-complete', true).step).toBe('poa-instructions');
  });
});

describe('calculateNextStep — unchanged without a mismatch', () => {
  it('UK driver goes POAs → DVLA → signature, no passport', () => {
    expect(calculateNextStep(analysis({}), 'insurance-complete', false).step).toBe('dvla-check');
    expect(calculateNextStep(analysis({ dvla: true }), 'dvla-check', false).step).toBe('signature');
    expect(calculateNextStep(analysis({}), 'dvla-complete', false).step).toBe('signature');
  });

  it('non-UK driver always needs the passport, flag or not', () => {
    expect(calculateNextStep(analysis({ uk: false }), 'insurance-complete', false).step).toBe('passport-upload');
    expect(calculateNextStep(analysis({ uk: false, passport: true }), 'insurance-complete', true).step).toBe('signature');
  });
});

describe('buildDriverStatusResponse — migration 298 fields', () => {
  it('keeps "never asked" as null rather than false', () => {
    const res = buildDriverStatusResponse({ email: 'driver@example.com' });
    expect(res.insuranceData.hasRecentConvictions).toBeNull();
    expect(res.insuranceData.hasFaultClaims).toBeNull();
    expect(res.addressMismatch).toBeNull();
  });

  it('passes real answers through', () => {
    const res = buildDriverStatusResponse({
      email: 'driver@example.com',
      has_recent_convictions: true,
      has_fault_claims: false,
      address_mismatch: true,
    });
    expect(res.insuranceData.hasRecentConvictions).toBe(true);
    expect(res.insuranceData.hasFaultClaims).toBe(false);
    expect(res.addressMismatch).toBe(true);
  });
});
