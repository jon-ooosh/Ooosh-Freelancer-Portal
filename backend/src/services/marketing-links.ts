/**
 * Tracked links — the pure part (docs/BUSINESS-FIGURES-SPEC.md §8, step 2).
 *
 * A printed QR code or short link points at go.oooshtours.co.uk/<code> (also
 * /api/go/<code>). OP counts the scan and forwards to the link's destination; on
 * our own website it adds campaign tags + `ol=<code>`, which the enquiry form
 * hands back with the enquiry (job_marketing_source.link_code).
 */

/** The address printed on artwork. */
export const SHORT_LINK_BASE = 'https://go.oooshtours.co.uk/';
/** Where a paused, unknown or broken code goes — a printed code must never dead-end. */
export const FALLBACK_URL = 'https://www.oooshtours.co.uk/';

const OWN_SITE = /(^|\.)oooshtours\.co\.uk$/i;

/** 'Brighton Source Dec' → 'brighton-source-dec'. Lowercase letters, digits and dashes; max 60. */
export function normaliseCode(raw: string): string {
  return raw.toLowerCase().trim()
    .replace(/['’]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    .replace(/-+$/g, '');
}

export function isValidCode(code: string): boolean {
  return /^[a-z0-9][a-z0-9-]{0,59}$/.test(code);
}

/** A destination must be a full http(s) address. Returns it tidied, or throws. */
export function checkDestination(raw: string): string {
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    throw new Error('The destination must be a full web address, e.g. https://www.oooshtours.co.uk/splitter-vans');
  }
  if (!/^https?:$/.test(u.protocol)) throw new Error('The destination must start with https:// or http://');
  return u.toString();
}

export function isOwnSite(url: string): boolean {
  try { return OWN_SITE.test(new URL(url).hostname); } catch { return false; }
}

/**
 * Where a scan is sent. On our own site the campaign tags and `ol` are added
 * (never overwriting tags already in the destination); anywhere else — e.g. the
 * Google review box — the destination as it is.
 */
export function forwardUrl(destination: string, link: { code: string; utm_source?: string | null; utm_medium?: string | null }): string {
  let u: URL;
  try { u = new URL(destination); } catch { return FALLBACK_URL; }
  if (!OWN_SITE.test(u.hostname)) return u.toString();
  const set = (k: string, v: string | null | undefined) => { if (v && !u.searchParams.has(k)) u.searchParams.set(k, v); };
  set('utm_source', link.utm_source || 'ooosh-link');
  set('utm_medium', link.utm_medium || 'qr');
  set('utm_campaign', link.code);
  set('ol', link.code);
  return u.toString();
}

/** A rough device type for the scan count. Link previews and crawlers are 'bot' and not counted. */
export function deviceOf(userAgent: string | undefined): 'mobile' | 'desktop' | 'bot' {
  const ua = (userAgent || '').toLowerCase();
  if (!ua || /bot|crawl|spider|preview|facebookexternalhit|whatsapp|slack|discord|telegram|skype|curl|wget|python|headless/.test(ua)) return 'bot';
  if (/mobi|android|iphone|ipad|ipod/.test(ua)) return 'mobile';
  return 'desktop';
}
