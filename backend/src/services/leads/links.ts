/**
 * The act's own links — official website and socials — so contact research
 * starts from the band's real site instead of a bare name, and staff can
 * click through when they're digging by hand.
 *
 * Sources (both free):
 *   - Ticketmaster: the attraction record's `externalLinks` (homepage,
 *     instagram, facebook, twitter, youtube, spotify, musicbrainz…). We
 *     already hold `tm_artist_id`; one call per lead researched.
 *   - MusicBrainz: only when Ticketmaster gives us the act's MusicBrainz id
 *     (searching MusicBrainz by name would risk the wrong act). Its URL
 *     relations add the official homepage, Bandcamp, socials. MusicBrainz asks
 *     for at most one request per second and an identifying User-Agent.
 *
 * Never throws — a lead with no links is just researched by name, as before.
 */
import { tmGet } from './ticketmaster';

export type ArtistLinks = Record<string, string[]>;

const MB_USER_AGENT = 'OooshOperations/1.0 ( info@oooshtours.co.uk )';
let lastMbCall = 0;

/** Which bucket a social URL belongs in. */
function classify(url: string): string {
  const u = url.toLowerCase();
  if (u.includes('instagram.com')) return 'instagram';
  if (u.includes('facebook.com')) return 'facebook';
  if (u.includes('twitter.com') || u.includes('//x.com')) return 'twitter';
  if (u.includes('tiktok.com')) return 'tiktok';
  if (u.includes('youtube.com') || u.includes('youtu.be')) return 'youtube';
  if (u.includes('bandcamp.com')) return 'bandcamp';
  if (u.includes('spotify.com')) return 'spotify';
  if (u.includes('linktr.ee')) return 'linktree';
  return 'other';
}

function add(links: ArtistLinks, key: string, url: unknown): void {
  if (typeof url !== 'string' || !/^https?:\/\//i.test(url)) return;
  const list = links[key] ?? (links[key] = []);
  if (!list.some((x) => x.toLowerCase() === url.toLowerCase())) list.push(url);
}

/* eslint-disable @typescript-eslint/no-explicit-any */
async function fromTicketmaster(tmArtistId: string, links: ArtistLinks): Promise<string | null> {
  const data = await tmGet(`attractions/${encodeURIComponent(tmArtistId)}.json`, {});
  const ext: Record<string, any[]> | undefined = data?.externalLinks;
  if (!ext) return null;
  let mbid: string | null = null;
  for (const [key, entries] of Object.entries(ext)) {
    for (const e of entries ?? []) {
      if (key === 'musicbrainz') { if (typeof e?.id === 'string') mbid = e.id; continue; }
      add(links, key === 'homepage' ? 'homepage' : key, e?.url);
    }
  }
  return mbid;
}

async function fromMusicBrainz(mbid: string, links: ArtistLinks): Promise<void> {
  if (!/^[0-9a-f-]{36}$/i.test(mbid)) return;
  const wait = 1100 - (Date.now() - lastMbCall);
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastMbCall = Date.now();
  const resp = await fetch(`https://musicbrainz.org/ws/2/artist/${mbid}?inc=url-rels&fmt=json`, {
    headers: { 'User-Agent': MB_USER_AGENT, Accept: 'application/json' },
    signal: AbortSignal.timeout(15_000),
  });
  if (!resp.ok) return;
  const body = (await resp.json()) as { relations?: any[] };
  for (const rel of body.relations ?? []) {
    const url = rel?.url?.resource;
    if (rel?.type === 'official homepage') add(links, 'homepage', url);
    else if (rel?.type === 'bandcamp') add(links, 'bandcamp', url);
    else if (rel?.type === 'social network' || rel?.type === 'youtube' || rel?.type === 'video channel') {
      if (typeof url === 'string') add(links, classify(url), url);
    }
  }
  add(links, 'musicbrainz', `https://musicbrainz.org/artist/${mbid}`);
}
/* eslint-enable @typescript-eslint/no-explicit-any */

/** Official site + socials for an act. `{}` when nothing is known. */
export async function fetchArtistLinks(tmArtistId: string | null | undefined): Promise<ArtistLinks> {
  const links: ArtistLinks = {};
  if (!tmArtistId) return links;
  try {
    const mbid = await fromTicketmaster(tmArtistId, links);
    if (mbid) await fromMusicBrainz(mbid, links);
  } catch (err) {
    console.warn('[leads/links] link lookup failed for %s:', tmArtistId, err instanceof Error ? err.message : err);
  }
  return links;
}

/** Lines for the research prompt — the places to look first. */
export function describeLinks(links: ArtistLinks): string | null {
  const order = ['homepage', 'linktree', 'instagram', 'facebook', 'bandcamp', 'twitter', 'tiktok', 'youtube', 'musicbrainz'];
  const lines = order.filter((k) => links[k]?.length).map((k) => `- ${k}: ${links[k].slice(0, 2).join(', ')}`);
  return lines.length ? lines.join('\n') : null;
}
