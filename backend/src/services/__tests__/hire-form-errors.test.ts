/**
 * The hire form's error alerts: which reports email info@, and the limits that
 * stop a retrying driver, or someone posting junk, from flooding the inbox.
 */
import { shouldAlert, jobNumberFromUrl, realEmail, MAX_ALERTS_PER_HOUR } from '../hire-form-errors';

describe('shouldAlert', () => {
  it('emails the first critical error for a driver on a page', () => {
    expect(shouldAlert('critical', 0, 0)).toBe(true);
  });

  it('never emails a warning or info report', () => {
    expect(shouldAlert('warning', 0, 0)).toBe(false);
    expect(shouldAlert('info', 0, 0)).toBe(false);
  });

  it('does not email the same driver + page again within the hour', () => {
    expect(shouldAlert('critical', 1, 1)).toBe(false);
  });

  it('still emails a different driver while others have alerted', () => {
    expect(shouldAlert('critical', 0, MAX_ALERTS_PER_HOUR - 1)).toBe(true);
  });

  it('stops at the hourly cap', () => {
    expect(shouldAlert('critical', 0, MAX_ALERTS_PER_HOUR)).toBe(false);
  });
});

describe('jobNumberFromUrl', () => {
  it('reads the job from the form URL', () => {
    expect(jobNumberFromUrl('https://hireforms.oooshtours.co.uk/?step=poa1&email=a%40b.com&job=16281&routed=1')).toBe('16281');
    expect(jobNumberFromUrl('https://hireforms.oooshtours.co.uk/?job=16281')).toBe('16281');
  });

  it('is null without one', () => {
    expect(jobNumberFromUrl('https://hireforms.oooshtours.co.uk/')).toBeNull();
    expect(jobNumberFromUrl(null)).toBeNull();
    expect(jobNumberFromUrl('https://x/?job=abc')).toBeNull();
  });
});

describe('realEmail', () => {
  it("drops the reporter's 'unknown' placeholder", () => {
    expect(realEmail('unknown')).toBeNull();
    expect(realEmail('')).toBeNull();
    expect(realEmail(null)).toBeNull();
  });

  it('lower-cases a real one', () => {
    expect(realEmail(' Jo@Example.com ')).toBe('jo@example.com');
  });
});
