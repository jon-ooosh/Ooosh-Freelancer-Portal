import { groupIntoTours, ukPosition, actSearchNames, TourDate } from '../leads/watch-tours';

const d = (date: string, country: string): TourDate => ({ date, venue: `${country} venue`, city: '', country });

describe('groupIntoTours', () => {
  it('keeps dates with gaps of a month or less as one tour', () => {
    const tours = groupIntoTours([d('2027-03-01', 'GB'), d('2027-03-10', 'DE'), d('2027-03-31', 'NL')]);
    expect(tours).toHaveLength(1);
    expect(tours[0]).toHaveLength(3);
  });

  it('splits on a gap of more than a month', () => {
    const tours = groupIntoTours([d('2027-03-01', 'GB'), d('2027-03-05', 'GB'), d('2027-06-20', 'DE')]);
    expect(tours.map((t) => t.length)).toEqual([2, 1]);
  });

  it('returns nothing for no dates', () => {
    expect(groupIntoTours([])).toEqual([]);
  });
});

describe('ukPosition', () => {
  it('finds where the UK sits in a tour', () => {
    expect(ukPosition([d('2027-03-01', 'GB'), d('2027-03-03', 'DE')])).toBe('start');
    expect(ukPosition([d('2027-03-01', 'DE'), d('2027-03-03', 'GB')])).toBe('end');
    expect(ukPosition([d('2027-03-01', 'GB'), d('2027-03-02', 'FR'), d('2027-03-03', 'GB')])).toBe('both');
    expect(ukPosition([d('2027-03-01', 'FR'), d('2027-03-02', 'GB'), d('2027-03-03', 'DE')])).toBe('middle');
    expect(ukPosition([d('2027-03-01', 'FR'), d('2027-03-02', 'DE')])).toBe('none');
  });

  it('treats a UK-only tour as starting and ending in the UK', () => {
    expect(ukPosition([d('2027-03-01', 'GB')])).toBe('both');
  });

  it('does not count Ireland as the UK', () => {
    expect(ukPosition([d('2027-03-01', 'IE'), d('2027-03-02', 'IE')])).toBe('none');
  });
});

describe('actSearchNames', () => {
  it('drops company endings', () => {
    expect(actSearchNames('Skindred LLP')).toEqual(['Skindred']);
    expect(actSearchNames('Brother Strut Limited')).toEqual(['Brother Strut']);
    expect(actSearchNames('Soundfangled Ltd')).toEqual(['Soundfangled']);
    expect(actSearchNames('Big Band Music Ltd.')).toEqual(['Big Band Music']);
    expect(actSearchNames('Acme Pty Ltd')).toEqual(['Acme']);
    expect(actSearchNames('Night Owls, Inc.')).toEqual(['Night Owls']);
  });

  it('tries each side of " / "', () => {
    expect(actSearchNames('TENDER / Bad Balloon Ltd')).toEqual(['TENDER', 'Bad Balloon']);
  });

  it('leaves a slash with no spaces alone', () => {
    expect(actSearchNames('AC/DC')).toEqual(['AC/DC']);
  });

  it('keeps a plain name as it is', () => {
    expect(actSearchNames('Sea Power')).toEqual(['Sea Power']);
    expect(actSearchNames('Lambrini Girls')).toEqual(['Lambrini Girls']);
  });

  it('does not strip a word that only looks like an ending', () => {
    expect(actSearchNames('The Limiteds')).toEqual(['The Limiteds']);
    expect(actSearchNames('Incubus')).toEqual(['Incubus']);
  });

  it('falls back to the name when nothing is left', () => {
    expect(actSearchNames('Ltd')).toEqual(['Ltd']);
  });
});

