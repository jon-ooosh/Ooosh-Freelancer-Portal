import { checkDestination, deviceOf, forwardUrl, isValidCode, normaliseCode } from '../marketing-links';

describe('link codes', () => {
  it('makes a tidy code from a name', () => {
    expect(normaliseCode('  Brighton Source — Dec Issue! ')).toBe('brighton-source-dec-issue');
    expect(normaliseCode("Jon's QR")).toBe('jons-qr');
    expect(normaliseCode('x'.repeat(80)).length).toBe(60);
  });
  it('accepts only lowercase letters, digits and dashes, not starting with a dash', () => {
    expect(isValidCode('hm-dec')).toBe(true);
    expect(isValidCode('-hm')).toBe(false);
    expect(isValidCode('HM')).toBe(false);
    expect(isValidCode('a/b')).toBe(false);
  });
});

describe('destinations', () => {
  it('wants a full http(s) address', () => {
    expect(checkDestination('https://www.oooshtours.co.uk/backline')).toBe('https://www.oooshtours.co.uk/backline');
    expect(() => checkDestination('www.oooshtours.co.uk')).toThrow();
    expect(() => checkDestination('javascript:alert(1)')).toThrow();
  });
});

describe('forwardUrl', () => {
  it('adds campaign tags and the code on our own site', () => {
    const u = new URL(forwardUrl('https://www.oooshtours.co.uk/splitter-vans', { code: 'hm-dec', utm_source: 'hm', utm_medium: 'print' }));
    expect(u.pathname).toBe('/splitter-vans');
    expect(u.searchParams.get('utm_source')).toBe('hm');
    expect(u.searchParams.get('utm_medium')).toBe('print');
    expect(u.searchParams.get('utm_campaign')).toBe('hm-dec');
    expect(u.searchParams.get('ol')).toBe('hm-dec');
  });
  it('never overwrites tags already in the destination', () => {
    const u = new URL(forwardUrl('https://oooshtours.co.uk/?utm_campaign=winter', { code: 'x' }));
    expect(u.searchParams.get('utm_campaign')).toBe('winter');
    expect(u.searchParams.get('ol')).toBe('x');
  });
  it('leaves other sites alone (e.g. the Google review box)', () => {
    expect(forwardUrl('https://g.page/r/CSCv1HhULJ6nEAI/review', { code: 'loo-door' })).toBe('https://g.page/r/CSCv1HhULJ6nEAI/review');
  });
});

describe('deviceOf', () => {
  it('sorts scans roughly, and treats previews and crawlers as bots', () => {
    expect(deviceOf('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)')).toBe('mobile');
    expect(deviceOf('Mozilla/5.0 (Windows NT 10.0; Win64; x64)')).toBe('desktop');
    expect(deviceOf('WhatsApp/2.23')).toBe('bot');
    expect(deviceOf('facebookexternalhit/1.1')).toBe('bot');
    expect(deviceOf(undefined)).toBe('bot');
  });
});
