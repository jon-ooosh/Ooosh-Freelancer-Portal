// The functions under test are pure; keep the service's DB / R2 / claims imports out of it.
jest.mock('../incident-claims', () => ({ logClaimEvent: jest.fn(), ukDatePlus: jest.fn() }));
jest.mock('../traccar-server', () => ({ getRouteForReg: jest.fn() }));
jest.mock('../../config/r2', () => ({ uploadToR2: jest.fn() }));
jest.mock('../../config/database', () => ({ query: jest.fn() }));

import { parseIncidentTime, ukLocalToUtc, incidentWindow, pointsToCsv, csvToPoints } from '../claim-gps';

describe('claim-gps', () => {
  it('parseIncidentTime reads the usual ways people write a time', () => {
    expect(parseIncidentTime('about 3pm')).toEqual({ hour: 15, minute: 0 });
    expect(parseIncidentTime('15:30')).toEqual({ hour: 15, minute: 30 });
    expect(parseIncidentTime('3.30 pm')).toEqual({ hour: 15, minute: 30 });
    expect(parseIncidentTime('12am')).toEqual({ hour: 0, minute: 0 });
    expect(parseIncidentTime('12 pm')).toEqual({ hour: 12, minute: 0 });
    expect(parseIncidentTime('around midday')).toEqual({ hour: 12, minute: 0 });
    expect(parseIncidentTime('late evening')).toBeNull();
    expect(parseIncidentTime('25:00')).toBeNull();
    expect(parseIncidentTime(null)).toBeNull();
  });

  it('ukLocalToUtc handles BST and GMT', () => {
    expect(ukLocalToUtc('2026-07-01', 15, 0).toISOString()).toBe('2026-07-01T14:00:00.000Z');
    expect(ukLocalToUtc('2026-12-01', 15, 0).toISOString()).toBe('2026-12-01T15:00:00.000Z');
  });

  it('incidentWindow: ± the time when known, else the whole UK day', () => {
    const t = incidentWindow('2026-07-01', 'about 3pm', 30);
    expect(t.timeKnown).toBe(true);
    expect(t.from.toISOString()).toBe('2026-07-01T13:30:00.000Z');
    expect(t.to.toISOString()).toBe('2026-07-01T14:30:00.000Z');
    const d = incidentWindow('2026-07-01', 'no idea', 30);
    expect(d.timeKnown).toBe(false);
    expect(d.from.toISOString()).toBe('2026-06-30T23:00:00.000Z');
    expect(d.to.toISOString()).toBe('2026-07-01T23:00:00.000Z');
  });

  it('a saved CSV reads back to the same points (addresses with commas and quotes too)', () => {
    const pts = [
      { time: '2026-07-01T14:00:00.000Z', lat: 50.8, lng: -0.17, speedKph: 32.4, course: 90, address: 'Church Rd, Hove "north"' },
      { time: '2026-07-01T14:00:30.000Z', lat: 50.81, lng: -0.16, speedKph: 0, course: null, address: null },
    ];
    expect(csvToPoints(pointsToCsv('RF21PWX', pts))).toEqual(pts);
  });
});
