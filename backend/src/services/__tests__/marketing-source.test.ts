import { cleanAttribution, cleanHeardAbout, cleanPath, cleanReferrer, trackedSource } from '../marketing-source';

describe('cleaning what the website sends', () => {
  it('keeps only the site and path of a referrer, and drops our own site', () => {
    expect(cleanReferrer('https://www.google.com/search?q=splitter+van+hire&client=x')).toBe('www.google.com/search');
    expect(cleanReferrer('https://www.facebook.com/')).toBe('www.facebook.com');
    expect(cleanReferrer('https://www.oooshtours.co.uk/splitter-vans')).toBeNull();
    expect(cleanReferrer('javascript:alert(1)')).toBeNull();
    expect(cleanReferrer('not a url')).toBeNull();
  });

  it('keeps only the path of the landing page', () => {
    expect(cleanPath('https://www.oooshtours.co.uk/backline?utm_source=x#top')).toBe('/backline');
    expect(cleanPath('/splitter-vans?gclid=abc')).toBe('/splitter-vans');
  });

  it('caps lengths, strips markup characters, and ignores unknown keys', () => {
    const a = cleanAttribution({ utm_source: `<script>${'x'.repeat(500)}`, utm_campaign: 'winter', evil: 'drop me' });
    expect(a?.utm_source?.length).toBe(200);
    expect(a?.utm_source).not.toContain('<');
    expect(a).not.toHaveProperty('evil');
    expect(a?.utm_campaign).toBe('winter');
  });

  it('takes the tracked-link code as `ol`', () => {
    expect(cleanAttribution({ ol: 'hm-dec' })?.link_code).toBe('hm-dec');
  });

  it('is null when nothing useful came through', () => {
    expect(cleanAttribution(null)).toBeNull();
    expect(cleanAttribution('a string')).toBeNull();
    expect(cleanAttribution({ landing_page: '/contact', referrer: 'https://www.oooshtours.co.uk/' })).toBeNull();
  });

  it('refuses a first-seen time in the future or years ago', () => {
    expect(cleanAttribution({ utm_source: 'x', first_seen_at: '2099-01-01T00:00:00Z' })?.first_seen_at).toBeNull();
    expect(cleanAttribution({ utm_source: 'x', first_seen_at: '2001-01-01T00:00:00Z' })?.first_seen_at).toBeNull();
  });

  it('accepts only the known "heard about us" answers', () => {
    expect(cleanHeardAbout('print')).toBe('print');
    expect(cleanHeardAbout('returning')).toBe('returning');
    expect(cleanHeardAbout('bribery')).toBeNull();
    expect(cleanHeardAbout(3)).toBeNull();
  });
});

describe('trackedSource — one label for where the website says they came from', () => {
  it('prefers a tracked link, then ad clicks, then campaign tags, then the referring site', () => {
    expect(trackedSource({ link_code: 'hm-dec', gclid: 'x' })).toBe('Tracked link: hm-dec');
    expect(trackedSource({ gclid: 'abc' })).toBe('Google ad');
    expect(trackedSource({ fbclid: 'abc' })).toBe('Facebook / Instagram');
    expect(trackedSource({ utm_source: 'google', utm_medium: 'cpc' })).toBe('Google ad');
    expect(trackedSource({ utm_source: 'instagram', utm_medium: 'social' })).toBe('Facebook / Instagram');
    expect(trackedSource({ utm_source: 'hm', utm_medium: 'print' })).toBe('Campaign: hm / print');
    expect(trackedSource({ referrer: 'www.google.co.uk/search' })).toBe('Google search');
    expect(trackedSource({ referrer: 'chatgpt.com' })).toBe('AI assistant');
    expect(trackedSource({ referrer: 'www.brightonmusicblog.com/listings' })).toBe('Website: brightonmusicblog.com');
    expect(trackedSource(null)).toBeNull();
    expect(trackedSource({})).toBeNull();
  });
});
