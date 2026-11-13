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

/** Ooosh purple, as in the logo. */
const OOOSH_PURPLE = '#833781';

/**
 * The record from the Ooosh logo, drawn as shapes so it stays sharp in print. Measured
 * off the logo file (units are its pixels, centred on the record's label): outer ring,
 * disc cut flat across the bottom, thin white ring, white label, purple hole.
 * Spans x −398…398, y −398…169.
 */
const RECORD_EMBLEM =
  `<clipPath id="ooosh-record-cut"><rect x="-400" y="-400" width="800" height="569"/></clipPath>` +
  `<g clip-path="url(#ooosh-record-cut)">` +
  `<circle r="394" fill="none" stroke="${OOOSH_PURPLE}" stroke-width="8"/>` +
  `<circle r="362" fill="${OOOSH_PURPLE}"/>` +
  `<circle r="153.5" fill="none" stroke="#ffffff" stroke-width="4"/>` +
  `<circle r="109.5" fill="#ffffff"/>` +
  `<circle r="21.5" fill="${OOOSH_PURPLE}"/>` +
  `</g>`;
const EMBLEM_W = 796;
const EMBLEM_H = 567;

/**
 * Put the Ooosh record in the middle of a QR code's SVG (from the `qrcode` package,
 * made with error correction H). It sits on a white square of whole modules about 27%
 * of the code across — about 7% of its area, well inside the 30% that H can rebuild.
 * Anything that isn't the expected SVG is returned as it is.
 */
export function withCentreLogo(svg: string, margin: number): string {
  const m = /viewBox="0 0 (\d+) (\d+)"/.exec(svg);
  const end = svg.lastIndexOf('</svg>');
  if (!m || end < 0) return svg;
  const size = Number(m[1]);
  const modules = size - 2 * margin;
  let box = Math.round(modules * 0.27);
  if (box % 2 !== modules % 2) box -= 1;          // same parity → sits exactly on the grid
  if (box < 5) return svg;
  const at = (size - box) / 2;
  const w = box - 1.4;                               // a little white all round
  const h = (w * EMBLEM_H) / EMBLEM_W;
  const logo =
    `<rect x="${at}" y="${at}" width="${box}" height="${box}" rx="1" fill="#ffffff"/>` +
    `<svg x="${(size - w) / 2}" y="${(size - h) / 2}" width="${w}" height="${h}" viewBox="-398 -398 ${EMBLEM_W} ${EMBLEM_H}" shape-rendering="geometricPrecision">` +
    RECORD_EMBLEM +
    `</svg>`;
  return svg.slice(0, end) + logo + svg.slice(end);
}
