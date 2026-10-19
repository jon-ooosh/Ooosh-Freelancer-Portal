/**
 * What a re-opened sign-up form is allowed to hand back to the freelancer.
 *
 * The form is gated by a token, not a login, so this is the boundary between
 * "their own documents, so they don't re-upload what we already hold" and
 * "everything staff have ever attached to this person".
 */
import { documentsOnFile } from '../freelancer-documents';

const at = (iso: string) => ({ uploaded_at: iso });

describe('documentsOnFile', () => {
  it('returns a document filed under the spelling the form used to write', () => {
    // Pre-Sept-2026 sign-ups filed the DVLA check as 'DVLA Summary'.
    const out = documentsOnFile([
      { url: 'files/freelancers/p1/dvla.pdf', name: 'summary.pdf', label: 'DVLA Summary', ...at('2026-09-21T11:18:12Z') },
    ]);
    expect(out).toEqual([
      { r2_key: 'files/freelancers/p1/dvla.pdf', label: 'DVLA Check', filename: 'summary.pdf', content_type: undefined },
    ]);
  });

  it('matches on the tag as well as the label', () => {
    const out = documentsOnFile([
      { url: 'files/freelancers/p1/front.jpg', name: 'front.jpg', tag: 'licence_front', ...at('2026-09-21T11:10:40Z') },
    ]);
    expect(out.map((d) => d.label)).toEqual(['Licence Front']);
  });

  it('hands back the newest file for a slot, not the first', () => {
    const out = documentsOnFile([
      { url: 'old', name: 'blurry.jpg', label: 'Licence Back', ...at('2026-09-21T11:10:54Z') },
      { url: 'new', name: 'clear.jpg', label: 'Licence Back', ...at('2026-09-22T09:00:00Z') },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].r2_key).toBe('new');
  });

  it('never hands back a document the form did not ask for', () => {
    const out = documentsOnFile([
      { url: 'files/people/p1/contract.pdf', name: 'contract.pdf', label: 'Signed contract', ...at('2026-09-21T12:00:00Z') },
      { url: 'files/people/p1/notes.pdf', name: 'notes.pdf', label: 'Interview notes', ...at('2026-09-21T12:00:00Z') },
    ]);
    expect(out).toEqual([]);
  });

  it('hands back a document staff uploaded by hand, under the canonical label', () => {
    // Staff-uploaded files live under files/people/... — the apply form never
    // minted that key, which is why submit accepts a key already on the record.
    const out = documentsOnFile([
      { url: 'files/people/p1/abc.pdf', name: 'dvla.pdf', label: 'DVLA Check', ...at('2026-09-21T13:00:00Z') },
    ]);
    expect(out).toEqual([
      { r2_key: 'files/people/p1/abc.pdf', label: 'DVLA Check', filename: 'dvla.pdf', content_type: undefined },
    ]);
  });

  it('survives a null, a string column and junk entries', () => {
    expect(documentsOnFile(null)).toEqual([]);
    expect(documentsOnFile('not json')).toEqual([]);
    expect(documentsOnFile([null, 'x', { label: 'Passport' }])).toEqual([]);  // no url ⇒ nothing to hand back
    expect(documentsOnFile(JSON.stringify([
      { url: 'k', name: 'p.jpg', label: 'Passport', uploaded_at: '2026-09-21T10:00:00Z' },
    ]))).toHaveLength(1);
  });
});
