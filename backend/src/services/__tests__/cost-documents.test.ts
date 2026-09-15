import {
  collectDocuments,
  hasDocuments,
  sanitiseAttachmentName,
  suffixFilename,
  guessContentType,
  MAX_XERO_ATTACHMENTS,
  type DocumentSource,
} from '../cost-documents';

const base = (over: Partial<DocumentSource> = {}): DocumentSource => ({
  receipt_r2_key: null,
  receipt_filename: null,
  supporting_documents: null,
  ...over,
});

describe('collectDocuments', () => {
  it('puts the main receipt first, then supporting docs in order', () => {
    const docs = collectDocuments(base({
      receipt_r2_key: 'files/a', receipt_filename: 'invoice.pdf',
      supporting_documents: [
        { r2_key: 'files/b', filename: 'fuel.jpg' },
        { r2_key: 'files/c', filename: 'train.pdf' },
      ],
    }));
    expect(docs.map((d) => d.filename)).toEqual(['invoice.pdf', 'fuel.jpg', 'train.pdf']);
    expect(docs.map((d) => d.r2Key)).toEqual(['files/a', 'files/b', 'files/c']);
  });

  it('renames duplicate filenames so Xero cannot silently overwrite one', () => {
    // Xero keys attachments by filename — without this, the second receipt.pdf
    // replaces the first and simply does not exist on the bill.
    const docs = collectDocuments(base({
      receipt_r2_key: 'files/a', receipt_filename: 'receipt.pdf',
      supporting_documents: [
        { r2_key: 'files/b', filename: 'receipt.pdf' },
        { r2_key: 'files/c', filename: 'receipt.pdf' },
      ],
    }));
    expect(docs.map((d) => d.filename)).toEqual(['receipt.pdf', 'receipt-1.pdf', 'receipt-2.pdf']);
    // Every file still points at its own object.
    expect(new Set(docs.map((d) => d.r2Key)).size).toBe(3);
  });

  it('treats a filename collision case-insensitively', () => {
    const docs = collectDocuments(base({
      receipt_r2_key: 'files/a', receipt_filename: 'Receipt.PDF',
      supporting_documents: [{ r2_key: 'files/b', filename: 'receipt.pdf' }],
    }));
    expect(docs.map((d) => d.filename)).toEqual(['Receipt.PDF', 'receipt-1.pdf']);
  });

  it('is deterministic, so a re-sync overwrites rather than duplicating', () => {
    const cost = base({
      receipt_r2_key: 'files/a', receipt_filename: 'receipt.pdf',
      supporting_documents: [{ r2_key: 'files/b', filename: 'receipt.pdf' }],
    });
    expect(collectDocuments(cost)).toEqual(collectDocuments(cost));
  });

  it('caps the set at the Xero per-object limit', () => {
    const many = Array.from({ length: 20 }, (_, i) => ({ r2_key: `files/${i}`, filename: `doc${i}.pdf` }));
    const docs = collectDocuments(base({
      receipt_r2_key: 'files/main', receipt_filename: 'main.pdf', supporting_documents: many,
    }));
    expect(docs).toHaveLength(MAX_XERO_ATTACHMENTS);
    expect(docs[0].filename).toBe('main.pdf'); // the receipt is never the one dropped
  });

  it('skips malformed entries rather than attaching a broken key', () => {
    const docs = collectDocuments(base({
      supporting_documents: [
        { r2_key: '', filename: 'nokey.pdf' },
        { r2_key: 'files/b', filename: '' },
        { r2_key: 'files/c', filename: 'good.pdf' },
      ],
    }));
    expect(docs.map((d) => d.filename)).toEqual(['good.pdf']);
  });

  it('takes the stored content type when present, else guesses', () => {
    const docs = collectDocuments(base({
      supporting_documents: [
        { r2_key: 'files/a', filename: 'scan', content_type: 'application/pdf' },
        { r2_key: 'files/b', filename: 'photo.jpg' },
      ],
    }));
    expect(docs.map((d) => d.contentType)).toEqual(['application/pdf', 'image/jpeg']);
  });

  it('returns nothing when the cost has no paperwork', () => {
    expect(collectDocuments(base())).toEqual([]);
  });
});

describe('sanitiseAttachmentName', () => {
  it('strips path separators and newlines Xero rejects', () => {
    expect(sanitiseAttachmentName('sub/dir\\file.pdf')).toBe('sub-dir-file.pdf');
    expect(sanitiseAttachmentName('bad\r\nname.pdf')).toBe('bad-name.pdf');
  });
  it('never yields an empty name', () => {
    expect(sanitiseAttachmentName('   ')).toBe('document');
    expect(sanitiseAttachmentName('/')).toBe('-');
  });
});

describe('suffixFilename', () => {
  it('keeps the extension', () => {
    expect(suffixFilename('receipt.pdf', 1)).toBe('receipt-1.pdf');
    expect(suffixFilename('a.b.pdf', 2)).toBe('a.b-2.pdf');
  });
  it('handles a name with no extension, and a dotfile', () => {
    expect(suffixFilename('receipt', 1)).toBe('receipt-1');
    expect(suffixFilename('.hidden', 1)).toBe('.hidden-1');
  });
});

describe('hasDocuments', () => {
  it('is true for a receipt alone, supporting docs alone, or both', () => {
    expect(hasDocuments(base({ receipt_r2_key: 'files/a' }))).toBe(true);
    expect(hasDocuments(base({ supporting_documents: [{ r2_key: 'files/b', filename: 'x.pdf' }] }))).toBe(true);
  });
  it('is false for nothing, an empty array, or a keyless entry', () => {
    expect(hasDocuments(base())).toBe(false);
    expect(hasDocuments(base({ supporting_documents: [] }))).toBe(false);
    expect(hasDocuments(base({ supporting_documents: [{ filename: 'x.pdf' }] }))).toBe(false);
  });
});

describe('guessContentType', () => {
  it('maps the formats staff actually upload', () => {
    expect(guessContentType('a.PDF')).toBe('application/pdf');
    expect(guessContentType('a.jpeg')).toBe('image/jpeg');
    expect(guessContentType('a.heic')).toBe('image/heic');
  });
  it('falls back rather than guessing wrong', () => {
    expect(guessContentType('noextension')).toBe('application/octet-stream');
  });
});
