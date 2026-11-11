/**
 * Where an enquiry came from, for marketing (docs/BUSINESS-FIGURES-SPEC.md §7).
 *
 * Two sources, kept apart:
 *   - heard_about — what the client TOLD us (website dropdown, or staff on New
 *     Enquiry / the job page). Optional everywhere; never blocks an enquiry.
 *   - the website's tags — campaign tags / ad click ids / referrer of the client's
 *     first visit (and of the visit they enquired on, when it had its own tags).
 *     Sent by the enquiry form through its Worker. Anyone can craft a link, so
 *     every value is cleaned, length-capped and only ever stored — never shown as HTML.
 *
 * "Came in by" (phone / email / website) is a different question and stays
 * jobs.enquiry_source.
 */
import { query } from '../config/database';

/** What they told us. The website form and staff choose from the same list. */
export const HEARD_ABOUT_LABELS: Record<string, string> = {
  google_search: 'Google search',
  google_ad: 'Google ad',
  social: 'Facebook / Instagram',
  print: 'Magazine / print',
  recommendation: 'Recommendation',
  returning: 'Used us before',
  ai: 'Asked an AI (ChatGPT etc.)',
  saw_at_venue: 'Saw us at a venue',
  other: 'Other',
};

/** The same list as a tuple, for zod. */
export const HEARD_ABOUT_VALUES = ['google_search', 'google_ad', 'social', 'print', 'recommendation', 'returning', 'ai', 'saw_at_venue', 'other'] as const;

const OWN_SITE = /(^|\.)oooshtours\.co\.uk$/i;
const CAP = 200;

export interface Attribution {
  utm_source: string | null;
  utm_medium: string | null;
  utm_campaign: string | null;
  utm_term: string | null;
  utm_content: string | null;
  gclid: string | null;
  fbclid: string | null;
  link_code: string | null;
  referrer: string | null;
  landing_page: string | null;
  first_seen_at: string | null;
}

/** A short, single-line string, or null. Strips control characters and anything that looks like markup. */
function clean(v: unknown, max = CAP): string | null {
  if (typeof v !== 'string') return null;
  // eslint-disable-next-line no-control-regex
  const s = v.replace(/[\u0000-\u001f\u007f<>]/g, ' ').replace(/\s+/g, ' ').trim();
  return s ? s.slice(0, max) : null;
}

/** Site + path of a URL, without its query or fragment (which can carry personal data). Our own site → null. */
export function cleanReferrer(v: unknown): string | null {
  const s = clean(v, 1000);
  if (!s) return null;
  try {
    const u = new URL(s);
    if (!/^https?:$/.test(u.protocol)) return null;
    if (OWN_SITE.test(u.hostname)) return null;
    return `${u.hostname}${u.pathname === '/' ? '' : u.pathname}`.slice(0, 300);
  } catch {
    return null;
  }
}

/** A path on our site (no query / fragment), e.g. '/splitter-vans'. */
export function cleanPath(v: unknown): string | null {
  const s = clean(v, 1000);
  if (!s) return null;
  try {
    const u = new URL(s, 'https://www.oooshtours.co.uk');
    return u.pathname.slice(0, 300) || null;
  } catch {
    return null;
  }
}

function cleanWhen(v: unknown): string | null {
  const s = clean(v, 40);
  if (!s) return null;
  const t = Date.parse(s);
  if (Number.isNaN(t)) return null;
  const now = Date.now();
  if (t > now + 86_400_000 || t < now - 2 * 365 * 86_400_000) return null;   // no future, nothing over 2 years old
  return new Date(t).toISOString();
}

/** Clean one attribution object from the form. Null when nothing useful is in it. */
export function cleanAttribution(raw: unknown): Attribution | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const a: Attribution = {
    utm_source: clean(r.utm_source),
    utm_medium: clean(r.utm_medium),
    utm_campaign: clean(r.utm_campaign),
    utm_term: clean(r.utm_term),
    utm_content: clean(r.utm_content),
    gclid: clean(r.gclid, 300),
    fbclid: clean(r.fbclid, 300),
    link_code: clean(r.ol ?? r.link_code, 100),
    referrer: cleanReferrer(r.referrer),
    landing_page: cleanPath(r.landing_page),
    first_seen_at: cleanWhen(r.first_seen_at),
  };
  const useful = Object.entries(a).some(([k, v]) => v !== null && k !== 'first_seen_at' && k !== 'landing_page');
  return useful ? a : null;
}

export function cleanHeardAbout(v: unknown): string | null {
  return typeof v === 'string' && v in HEARD_ABOUT_LABELS ? v : null;
}

/**
 * Where the website says they came from, as one label — for grouping. Strongest
 * signal first: an Ooosh tracked link, an ad click id, campaign tags, then the
 * site that sent them. Null when the website saw nothing.
 */
export function trackedSource(a: Partial<Attribution> | null): string | null {
  if (!a) return null;
  if (a.link_code) return `Tracked link: ${a.link_code}`;
  if (a.gclid) return 'Google ad';
  if (a.fbclid) return 'Facebook / Instagram';
  const src = (a.utm_source || '').toLowerCase();
  const medium = (a.utm_medium || '').toLowerCase();
  if (src) {
    if (src.includes('google') && /cpc|ppc|paid|ad/.test(medium)) return 'Google ad';
    if (/facebook|instagram|^fb$|^ig$|meta/.test(src)) return 'Facebook / Instagram';
    return `Campaign: ${a.utm_source}${a.utm_medium ? ` / ${a.utm_medium}` : ''}`;
  }
  const ref = (a.referrer || '').toLowerCase();
  if (ref) {
    const host = ref.split('/')[0];
    if (/(^|\.)google\./.test(host)) return 'Google search';
    if (/(^|\.)bing\.com$|duckduckgo|yahoo\./.test(host)) return 'Other search engine';
    if (/facebook\.com$|instagram\.com$|fb\.me$|l\.facebook/.test(host)) return 'Facebook / Instagram';
    if (/chatgpt\.com$|openai\.com$|perplexity\.ai$|claude\.ai$|gemini\.google/.test(host)) return 'AI assistant';
    return `Website: ${host.replace(/^www\./, '')}`;
  }
  return null;
}

export interface MarketingInput {
  heardAbout?: unknown;
  heardAboutDetail?: unknown;
  first?: unknown;
  last?: unknown;
}

/**
 * Store what we know about where a job's enquiry came from. Fills in, never wipes:
 * a staff edit of heard_about leaves the website's tags alone, and vice versa.
 * Never throws — an enquiry is never lost over its marketing data.
 */
export async function saveMarketingSource(jobId: string, input: MarketingInput): Promise<void> {
  try {
    const heard = cleanHeardAbout(input.heardAbout);
    const detail = clean(input.heardAboutDetail, 300);
    const first = cleanAttribution(input.first);
    const last = cleanAttribution(input.last);
    if (!heard && !detail && !first && !last) return;
    const f = first || ({} as Partial<Attribution>);
    await query(
      `INSERT INTO job_marketing_source
         (job_id, heard_about, heard_about_detail, utm_source, utm_medium, utm_campaign, utm_term, utm_content,
          gclid, fbclid, link_code, referrer, landing_page, first_seen_at, last_touch)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15::jsonb)
       ON CONFLICT (job_id) DO UPDATE SET
         heard_about        = COALESCE(EXCLUDED.heard_about, job_marketing_source.heard_about),
         heard_about_detail = COALESCE(EXCLUDED.heard_about_detail, job_marketing_source.heard_about_detail),
         utm_source   = COALESCE(EXCLUDED.utm_source, job_marketing_source.utm_source),
         utm_medium   = COALESCE(EXCLUDED.utm_medium, job_marketing_source.utm_medium),
         utm_campaign = COALESCE(EXCLUDED.utm_campaign, job_marketing_source.utm_campaign),
         utm_term     = COALESCE(EXCLUDED.utm_term, job_marketing_source.utm_term),
         utm_content  = COALESCE(EXCLUDED.utm_content, job_marketing_source.utm_content),
         gclid        = COALESCE(EXCLUDED.gclid, job_marketing_source.gclid),
         fbclid       = COALESCE(EXCLUDED.fbclid, job_marketing_source.fbclid),
         link_code    = COALESCE(EXCLUDED.link_code, job_marketing_source.link_code),
         referrer     = COALESCE(EXCLUDED.referrer, job_marketing_source.referrer),
         landing_page = COALESCE(EXCLUDED.landing_page, job_marketing_source.landing_page),
         first_seen_at = COALESCE(EXCLUDED.first_seen_at, job_marketing_source.first_seen_at),
         last_touch   = COALESCE(EXCLUDED.last_touch, job_marketing_source.last_touch),
         updated_at   = NOW()`,
      [jobId, heard, detail, f.utm_source ?? null, f.utm_medium ?? null, f.utm_campaign ?? null, f.utm_term ?? null,
        f.utm_content ?? null, f.gclid ?? null, f.fbclid ?? null, f.link_code ?? null, f.referrer ?? null,
        f.landing_page ?? null, f.first_seen_at ?? null, last ? JSON.stringify(last) : null],
    );
  } catch (err) {
    console.error(`[marketing-source] job ${jobId} not saved (non-fatal):`, err);
  }
}

/** Staff changing "heard about us" on the job page — an explicit choice, so it can also be cleared. */
export async function setHeardAbout(jobId: string, heardAbout: string | null, detail: string | null): Promise<void> {
  const heard = heardAbout === null ? null : cleanHeardAbout(heardAbout);
  if (heardAbout !== null && !heard) throw new Error('Unknown "heard about us" choice');
  await query(
    `INSERT INTO job_marketing_source (job_id, heard_about, heard_about_detail)
     VALUES ($1, $2, $3)
     ON CONFLICT (job_id) DO UPDATE SET heard_about = EXCLUDED.heard_about,
       heard_about_detail = EXCLUDED.heard_about_detail, updated_at = NOW()`,
    [jobId, heard, clean(detail, 300)],
  );
}

/** A job's marketing source for the job page: what they told us and what the website saw. */
export async function getMarketingSource(jobId: string): Promise<{ heardAbout: string | null; heardAboutDetail: string | null; tracked: string | null; campaign: string | null } | null> {
  const r = await query(`SELECT * FROM job_marketing_source WHERE job_id = $1`, [jobId]);
  const row = r.rows[0] as (Attribution & { heard_about: string | null; heard_about_detail: string | null; last_touch: Partial<Attribution> | null }) | undefined;
  if (!row) return null;
  return {
    heardAbout: row.heard_about,
    heardAboutDetail: row.heard_about_detail,
    tracked: trackedSource(row),
    campaign: row.utm_campaign,
  };
}
