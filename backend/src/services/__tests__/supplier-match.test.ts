/**
 * Supplier name normalisation — the comparison key that decides whether OP
 * recognises an existing Xero contact or offers to create a duplicate.
 *
 * The live miss that prompted this: "High Class-Cleaning LTD" on the letterhead
 * vs "High Class Cleaning" in Xero. Lowercasing and substring-containment sees
 * no relation between them (the hyphen and the "LTD" break it in both
 * directions), so OP offered a second contact for a supplier we already had.
 *
 * Too aggressive is as bad as too lax: collapsing two genuinely different
 * suppliers onto one key would file costs against the wrong company.
 */
jest.mock('../../config/database', () => ({ query: jest.fn() }));
jest.mock('../xero-broker', () => ({ xeroBroker: { searchContacts: jest.fn() } }));

import { normaliseSupplierName } from '../supplier-match';

const same = (a: string, b: string) =>
  expect(normaliseSupplierName(a)).toBe(normaliseSupplierName(b));
const differ = (a: string, b: string) =>
  expect(normaliseSupplierName(a)).not.toBe(normaliseSupplierName(b));

describe('normaliseSupplierName', () => {
  it('matches the case that started this — hyphen and LTD', () => {
    same('High Class-Cleaning LTD', 'High Class Cleaning');
  });

  it('ignores case, spacing and punctuation', () => {
    same('T.Reeve & Son Ltd.', 'T Reeve and Son Limited');
    same('  Hi-Q   Portslade ', 'HiQ Portslade');
  });

  it('ignores company suffixes however they are written', () => {
    same('Autoscreen Sussex', 'Autoscreen Sussex Ltd');
    same('Canva UK Operations Ltd', 'Canva Operations');
    same('Mailchimp', 'The Mailchimp Company');
  });

  it('strips suffixes as whole words, never as letters', () => {
    // "Coastal" must not lose its "co"; "Limitless" must not lose "limit".
    expect(normaliseSupplierName('Coastal Tyres')).toBe('coastaltyres');
    expect(normaliseSupplierName('Limitless Audio')).toBe('limitlessaudio');
  });

  it('keeps genuinely different suppliers apart', () => {
    differ('T.Reeve & Son', 'T.Read & Son');
    differ('Hi-Q Portslade', 'Hi-Q Hove');
    differ('Shell', 'Shelley');
  });

  it('does not collapse a suffix-only name to an empty key', () => {
    // Two different all-suffix names must not become the same (empty) key —
    // that would map every one of them onto whichever contact matched first.
    expect(normaliseSupplierName('The Ltd')).not.toBe('');
    differ('The Ltd', 'UK Group');
  });

  it('survives junk without throwing', () => {
    expect(normaliseSupplierName('')).toBe('');
    expect(normaliseSupplierName('   ')).toBe('');
    expect(normaliseSupplierName('***')).toBe('');
  });
});
