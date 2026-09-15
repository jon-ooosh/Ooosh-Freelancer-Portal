/**
 * Regression guard for the shape of dates on GET /driver-verification/status.
 *
 * node-postgres hands back a DATE column as a JS Date object. Rendering one with
 * String(d) gives "Mon Dec 27 2021 00:00:00 GMT+0000 (…)" — which contains a 'T'
 * inside "GMT", so the old .split('T')[0] produced "Mon Dec 27 2021 00:00:00 GM".
 * The hire form puts datePassedTest straight into an <input type="date">, and a
 * date input SILENTLY refuses to render a value it cannot parse: the field just
 * looks empty. That is how a returning driver lost their "Date passed driving
 * test" on every hire while the value sat correctly in the database.
 *
 * Every date the hire form consumes must therefore come back as YYYY-MM-DD.
 */
import { buildDriverStatusResponse } from '../driver-verification';

const YMD = /^\d{4}-\d{2}-\d{2}$/;

describe('buildDriverStatusResponse date formatting', () => {
  it('renders a pg Date object as YYYY-MM-DD, not a locale toString', () => {
    const res = buildDriverStatusResponse({
      email: 'driver@example.com',
      date_passed_test: new Date('2021-12-27T00:00:00.000Z'),
    });

    expect(res.insuranceData.datePassedTest).toBe('2021-12-27');
  });

  it('produces a value an <input type="date"> can actually display', () => {
    const res = buildDriverStatusResponse({
      email: 'driver@example.com',
      date_passed_test: new Date('2021-12-27T00:00:00.000Z'),
    });

    // The old output ("Mon Dec 27 2021 00:00:00 GM") passed a truthy check and
    // so slipped through every `|| ''` fallback on the way to the browser.
    expect(res.insuranceData.datePassedTest).toMatch(YMD);
    expect(Number.isNaN(new Date(res.insuranceData.datePassedTest).getTime())).toBe(false);
  });

  it('passes an already-normalised string through unchanged', () => {
    const res = buildDriverStatusResponse({
      email: 'driver@example.com',
      date_passed_test: '2021-12-27',
    });

    expect(res.insuranceData.datePassedTest).toBe('2021-12-27');
  });

  it('reports a missing date as an empty string, never "Invalid Date"', () => {
    for (const missing of [null, undefined, '']) {
      const res = buildDriverStatusResponse({
        email: 'driver@example.com',
        date_passed_test: missing,
      });
      expect(res.insuranceData.datePassedTest).toBe('');
    }
  });

  it('normalises every other date it hands the hire form', () => {
    const res = buildDriverStatusResponse({
      email: 'driver@example.com',
      date_of_birth: new Date('1986-05-12T00:00:00.000Z'),
      licence_valid_to: new Date('2030-04-04T00:00:00.000Z'),
      poa1_valid_until: new Date('2026-11-01T00:00:00.000Z'),
      poa2_valid_until: new Date('2026-11-01T00:00:00.000Z'),
      dvla_valid_until: new Date('2026-10-01T00:00:00.000Z'),
      passport_valid_until: new Date('2026-10-01T00:00:00.000Z'),
      date_passed_test: new Date('2021-12-27T00:00:00.000Z'),
    });

    for (const value of [
      res.dateOfBirth,
      res.licenseValidTo,
      res.poa1ValidUntil,
      res.poa2ValidUntil,
      res.dvlaValidUntil,
      res.passportValidUntil,
      res.insuranceData.datePassedTest,
    ]) {
      expect(value).toMatch(YMD);
    }
  });
});
