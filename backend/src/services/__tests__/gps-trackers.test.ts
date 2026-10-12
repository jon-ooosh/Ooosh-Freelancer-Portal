// The functions under test are pure; keep the DB out of it.
jest.mock('../../config/database', () => ({ query: jest.fn(), getClient: jest.fn() }));

import { isRealFix, cleanTrackerNumber, cleanImei, cleanIccid, normaliseReg } from '../gps-trackers';

describe('gps-trackers', () => {
  it('isRealFix drops the no-fix 0,0 point and junk, keeps real places', () => {
    expect(isRealFix(0, 0)).toBe(false);
    expect(isRealFix(NaN, -1.47)).toBe(false);
    expect(isRealFix(null, null)).toBe(false);
    expect(isRealFix('53.38', '-1.47')).toBe(false);
    expect(isRealFix(53.387703, -1.478192)).toBe(true);
    // Only BOTH zero is the no-fix marker — the Greenwich meridian is real.
    expect(isRealFix(51.4779, 0)).toBe(true);
  });

  it('cleanTrackerNumber pads a bare number to the label format', () => {
    expect(cleanTrackerNumber('7')).toBe('007');
    expect(cleanTrackerNumber(22)).toBe('022');
    expect(cleanTrackerNumber(' 024 ')).toBe('024');
    expect(cleanTrackerNumber('1000')).toBe('1000');
    expect(cleanTrackerNumber('t-9')).toBe('T-9');
    expect(cleanTrackerNumber('')).toBeUndefined();
    expect(cleanTrackerNumber(null)).toBeUndefined();
  });

  it('cleanImei wants 15 digits', () => {
    expect(cleanImei('864022082913707')).toBe('864022082913707');
    expect(cleanImei('8640 2208 2913 707')).toBe('864022082913707');
    expect(cleanImei('86402208291370')).toBeUndefined();
    expect(cleanImei('86402208291370X')).toBeUndefined();
  });

  it('cleanIccid: empty is null, digits are kept, junk is refused', () => {
    expect(cleanIccid('')).toBeNull();
    expect(cleanIccid(null)).toBeNull();
    expect(cleanIccid('89462038076010096040')).toBe('89462038076010096040');
    expect(cleanIccid('8946203807601009604f')).toBe('8946203807601009604F');
    expect(cleanIccid('12345')).toBeUndefined();
  });

  it('normaliseReg ignores spaces and case', () => {
    expect(normaliseReg('ro23 hlu')).toBe('RO23HLU');
  });
});
