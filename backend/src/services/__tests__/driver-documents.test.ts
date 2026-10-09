import {
  hasDocumentFor,
  documentPresence,
  normaliseDocToken,
  resolveDocumentKey,
} from '../driver-documents';

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

describe('normaliseDocToken', () => {
  it('folds the spellings the upload paths disagree on', () => {
    expect(normaliseDocToken('Licence Front')).toBe('licencefront');
    expect(normaliseDocToken('licence_front')).toBe('licencefront');
    expect(normaliseDocToken('LICENCE-FRONT')).toBe('licencefront');
  });
  it('is empty for anything that is not a string', () => {
    expect(normaliseDocToken(null)).toBe('');
    expect(normaliseDocToken(42)).toBe('');
  });
});

describe('resolveDocumentKey', () => {
  // This is what the snapshot PDF resolves its pages with. It used to be a
  // second copy of these lists, and matching on exact strings dropped every
  // licence and POA image for months (Adam Coelho / job 16063).
  it('resolves both British and American licence spellings', () => {
    expect(resolveDocumentKey({ tag: 'licence_front' })).toBe('licenceFront');
    expect(resolveDocumentKey({ label: 'License Front' })).toBe('licenceFront');
    expect(resolveDocumentKey({ label: 'Licence Back' })).toBe('licenceBack');
  });

  it('prefers the tag over the label', () => {
    expect(resolveDocumentKey({ tag: 'poa2', label: 'Proof of Address 1' })).toBe('poa2');
  });

  it('never lets "Proof of Address 2" fall into POA1', () => {
    // poa1 accepts the bare 'proofofaddress'; the lookup is exact, not prefix.
    expect(resolveDocumentKey({ label: 'Proof of Address 2' })).toBe('poa2');
    expect(resolveDocumentKey({ label: 'Proof of Address' })).toBe('poa1');
  });

  it('returns null for a file with no recognisable tag or label', () => {
    expect(resolveDocumentKey({ name: 'scan.pdf' } as never)).toBeNull();
    expect(resolveDocumentKey({ tag: 'something_else' })).toBeNull();
  });
});

describe('hasDocumentFor', () => {
  it('recognises every tag the hire form writes', () => {
    expect(documentPresence(HIRE_FORM_FILES)).toEqual({
      identity: true, poa1: true, poa2: true, dvla: true, passport: false, signature: true,
    });
  });

  it('counts the selfie alone as identity evidence', () => {
    // The licence images arrive from iDenfy separately from the selfie, so the
    // group is present as soon as any one of the three is.
    expect(hasDocumentFor('identity', [{ tag: 'selfie' }])).toBe(true);
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
