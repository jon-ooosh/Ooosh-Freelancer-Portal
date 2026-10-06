import { normaliseArtist } from '../leads/normalise';
import { bandNameRegex, describeHistory, ClientHistory } from '../leads/history';

const base: ClientHistory = {
  org_id: 'o', org_name: 'Big Mgmt', scope: 'org',
  enquiries: 0, booked: 0, open: 0, lost: 0, cancelled: 0, lost_reasons: [],
  last_enquiry: null, last_booked: null, booked_value: 0,
  retros: { great: 0, ok: 0, issues: 0 }, do_not_hire: false, working_terms: null,
};

describe('normaliseArtist', () => {
  it('drops a leading "the" and punctuation', () => {
    expect(normaliseArtist('The Wedding Present')).toBe('wedding present');
    expect(normaliseArtist('AC/DC')).toBe('ac dc');
    expect(normaliseArtist('  The   1975 ')).toBe('1975');
  });
});

describe('bandNameRegex', () => {
  it('refuses names too short to search the job book safely', () => {
    expect(bandNameRegex('Ride')).toBeNull();
    expect(bandNameRegex('The Yes')).toBeNull();
  });
  it('builds a whole-word, optional-"the" pattern', () => {
    expect(bandNameRegex('The Wedding Present')).toBe('\\m(the[^a-z0-9]+)?wedding[^a-z0-9]+present\\M');
  });
});

describe('describeHistory', () => {
  it('reads as "in the book, no hires" with no jobs', () => {
    expect(describeHistory(base)).toBe('As Big Mgmt: in the address book, but no enquiries or hires on record.');
  });
  it('summarises losses with their reasons and flags Do Not Hire', () => {
    const s = describeHistory({
      ...base, scope: 'band_jobs', enquiries: 10, lost: 9, open: 1,
      lost_reasons: [{ reason: 'Price', count: 6 }, { reason: 'No Decision', count: 3 }],
      last_enquiry: '2025-11-02', do_not_hire: true,
    });
    expect(s).toBe(
      'Via Big Mgmt (jobs named after the band): 10 enquiries — 0 booked, 9 lost (Price ×6, No Decision ×3), 1 still open. '
      + 'Last enquiry 2025-11-02. ⚠ Flagged Do Not Hire.',
    );
  });
});
