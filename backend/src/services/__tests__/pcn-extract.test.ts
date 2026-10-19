/**
 * Date/time repair for AI-extracted PCN notices.
 *
 * Regression cover for the incident these helpers exist for: a notice printing
 * the offence time to the second ("07:54:33") was glued to a ":00" seconds
 * suffix by the caller, producing an invalid moment. The driver matcher 400'd
 * and the UI reported "Driver match failed", pointing staff at hire data that
 * was perfectly correct (RX21UOB / job 16261, Sep 2026).
 */
import { toHhMm, toIsoDate } from '../pcn-extract';

describe('toHhMm', () => {
  it('drops seconds — the shape that broke the matcher', () => {
    expect(toHhMm('07:54:33')).toBe('07:54');
  });

  it('passes a clean 24-hour time through untouched', () => {
    expect(toHhMm('07:54')).toBe('07:54');
    expect(toHhMm('23:59')).toBe('23:59');
    expect(toHhMm('00:00')).toBe('00:00');
  });

  it('accepts the formats notices actually print', () => {
    expect(toHhMm('7:54')).toBe('07:54');
    expect(toHhMm('07.54')).toBe('07:54');
    expect(toHhMm('0754')).toBe('07:54');
    expect(toHhMm(' 07:54 ')).toBe('07:54');
  });

  it('converts am/pm, including the midnight/midday edges', () => {
    expect(toHhMm('7:54am')).toBe('07:54');
    expect(toHhMm('7:54 PM')).toBe('19:54');
    expect(toHhMm('12:30am')).toBe('00:30');
    expect(toHhMm('12:30pm')).toBe('12:30');
  });

  it('returns null rather than guessing at nonsense', () => {
    expect(toHhMm('')).toBeNull();
    expect(toHhMm('midday')).toBeNull();
    expect(toHhMm('25:00')).toBeNull();
    expect(toHhMm('07:99')).toBeNull();
  });
});

describe('toIsoDate', () => {
  it('passes ISO through untouched', () => {
    expect(toIsoDate('2026-08-21')).toBe('2026-08-21');
  });

  it('reads UK day-first dates', () => {
    expect(toIsoDate('21/08/2026')).toBe('2026-08-21');
    expect(toIsoDate('21-08-2026')).toBe('2026-08-21');
    expect(toIsoDate('21.08.2026')).toBe('2026-08-21');
    expect(toIsoDate('1/8/2026')).toBe('2026-08-01');
    expect(toIsoDate('21/08/26')).toBe('2026-08-21');
  });

  it('does not silently roll a nonsense date over into the next month', () => {
    expect(toIsoDate('31/02/2026')).toBeNull();
    expect(toIsoDate('45/01/2026')).toBeNull();
    expect(toIsoDate('21/13/2026')).toBeNull();
  });

  it('returns null on anything it cannot read', () => {
    expect(toIsoDate('')).toBeNull();
    expect(toIsoDate('last Tuesday')).toBeNull();
  });
});
