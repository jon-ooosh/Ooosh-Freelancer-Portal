import { hasDocumentFor, documentPresence, normaliseTag } from '../driver-documents';

// The tags the hire form's upload path actually writes (opUploadFile's tagMap
// in the driver-verification repo), and the labels staff uploads set.
const HIRE_FORM_FILES = [
  { tag: 'licence_front', url: 'a' },
  { tag: 'licence_back', url: 'b' },
  { tag: 'selfie', url: 'c' },
  { tag: 'poa1', url: 'd' },
  { tag: 'poa2', url: 'e' },
  { tag: 'dvla_check', url: 'f' },
  { tag: 'signature', url: 'g' },
];

describe('normaliseTag', () => {
  it('folds the spellings the upload paths disagree on', () => {
    expect(normaliseTag('Licence Front')).toBe('licencefront');
    expect(normaliseTag('licence_front')).toBe('licencefront');
    expect(normaliseTag('LICENCE-FRONT')).toBe('licencefront');
  });
  it('is empty for anything that is not a string', () => {
    expect(normaliseTag(null)).toBe('');
    expect(normaliseTag(42)).toBe('');
  });
});

describe('hasDocumentFor', () => {
  it('recognises every tag the hire form writes', () => {
    expect(documentPresence(HIRE_FORM_FILES)).toEqual({
      identity: true, poa1: true, poa2: true, dvla: true, passport: false, signature: true,
    });
  });

  it('recognises the labels a staff upload sets', () => {
    expect(hasDocumentFor('poa1', [{ label: 'Proof of Address 1' }])).toBe(true);
    expect(hasDocumentFor('dvla', [{ label: 'DVLA Check Code' }])).toBe(true);
  });

  it('keeps POA1 and POA2 apart', () => {
    expect(hasDocumentFor('poa1', [{ tag: 'poa2' }])).toBe(false);
    expect(hasDocumentFor('poa2', [{ tag: 'poa1' }])).toBe(false);
  });

  it('is false, never throwing, for the shapes a driver row can hold', () => {
    expect(hasDocumentFor('poa1', null)).toBe(false);
    expect(hasDocumentFor('poa1', undefined)).toBe(false);
    expect(hasDocumentFor('poa1', [])).toBe(false);
    expect(hasDocumentFor('poa1', 'not json')).toBe(false);
    expect(hasDocumentFor('poa1', [null, 'junk'])).toBe(false);
  });

  it('accepts the column as raw JSON text as well as parsed', () => {
    expect(hasDocumentFor('poa1', JSON.stringify([{ tag: 'poa1' }]))).toBe(true);
  });

  it('ignores a file with no tag or label at all', () => {
    expect(hasDocumentFor('poa1', [{ url: 'x', name: 'scan.pdf' }])).toBe(false);
  });
});
