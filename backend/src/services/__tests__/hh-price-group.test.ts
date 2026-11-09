import { pickPriceGroup } from '../hh-price-group';

describe('pickPriceGroup', () => {
  it('sends nothing when no group is set (HireHop default, A)', () => {
    expect(pickPriceGroup('', '', '2026-11-09')).toBeNull();
    expect(pickPriceGroup(null, null, '2026-11-09')).toBeNull();
  });

  it('holds back until the from-date, then switches on the day itself', () => {
    expect(pickPriceGroup('B', '2027-01-01', '2026-12-31')).toBeNull();
    expect(pickPriceGroup('B', '2027-01-01', '2027-01-01')).toBe(1);
    expect(pickPriceGroup('B', '2027-01-01', '2027-03-15')).toBe(1);
  });

  it('applies straight away with no date', () => {
    expect(pickPriceGroup('C', '', '2026-11-09')).toBe(2);
    expect(pickPriceGroup(' a ', null, '2026-11-09')).toBe(0);
  });

  it('ignores a malformed setting rather than guessing', () => {
    expect(pickPriceGroup('D', '', '2026-11-09')).toBeNull();
    expect(pickPriceGroup('B', '1/1/2027', '2027-02-01')).toBeNull();
  });
});
