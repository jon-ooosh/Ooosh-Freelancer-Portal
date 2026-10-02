/**
 * Phase 1 — Collect. Ported from `collector.py`.
 *
 * Resolves each monitored venue's Discovery API id, then pulls upcoming music
 * events per venue into `tf_events`. Window is [today, today + maxWeeks]: we
 * collect from *today* (not today + minLeadWeeks) so a tour's true earliest
 * visible date is known — the "too imminent / already running" drop happens at
 * detection against that true first date, not by hiding near dates here.
 */
import { query } from '../../config/database';
import { MONITORED_VENUES, MonitoredVenue } from './venues';
import { tmGet, tmDateTime, TmResponse } from './ticketmaster';

// In-process cache of resolved website-id → discovery-id (venues rarely change).
const resolvedVenueCache = new Map<string, string>();

/* eslint-disable @typescript-eslint/no-explicit-any */

function extractVenueId(data: TmResponse | null, venue: MonitoredVenue): string | null {
  const found: any[] = data?._embedded?.venues ?? [];
  const nameLower = venue.name.toLowerCase();
  for (const v of found) {
    const vName = String(v.name ?? '').toLowerCase();
    if (vName && (nameLower.includes(vName) || vName.includes(nameLower))) return v.id ?? null;
  }
  for (const v of found) {
    const vCity = String(v.city?.name ?? '').toLowerCase();
    if (vCity === venue.city.toLowerCase()) return v.id ?? null;
  }
  return null;
}

async function resolveVenueId(venue: MonitoredVenue): Promise<string | null> {
  const cached = resolvedVenueCache.get(venue.tmWebsiteId);
  if (cached) return cached;

  let data = await tmGet('venues.json', {
    keyword: venue.name,
    city: venue.city,
    countryCode: 'GB',
    size: 5,
  });
  let id = extractVenueId(data, venue);

  if (!id) {
    data = await tmGet('venues.json', { keyword: venue.name, countryCode: 'GB', size: 10 });
    id = extractVenueId(data, venue);
  }

  if (id) {
    resolvedVenueCache.set(venue.tmWebsiteId, id);
    console.log('[leads/collect] resolved %s → %s', venue.name, id);
  } else {
    console.warn('[leads/collect] could not resolve venue id for %s', venue.name);
  }
  return id;
}

async function upsertEvent(e: {
  tmEventId: string;
  eventName: string;
  artistName: string;
  tmArtistId: string;
  venueName: string;
  venueCity: string;
  eventDate: string;
  genre?: string;
  subgenre?: string;
}): Promise<boolean> {
  const result = await query(
    `INSERT INTO tf_events (tm_event_id, event_name, artist_name, tm_artist_id, venue_name, venue_city, event_date, genre, subgenre, processed)
     VALUES ($1,$2,$3,$4,$5,$6,NULLIF($7,'')::date,$8,$9, FALSE)
     ON CONFLICT (tm_event_id) DO UPDATE SET
       event_name = EXCLUDED.event_name,
       artist_name = EXCLUDED.artist_name,
       venue_name = EXCLUDED.venue_name,
       venue_city = EXCLUDED.venue_city,
       event_date = EXCLUDED.event_date
     RETURNING (xmax = 0) AS inserted`,
    [
      e.tmEventId, e.eventName, e.artistName, e.tmArtistId,
      e.venueName, e.venueCity, e.eventDate, e.genre ?? '', e.subgenre ?? '',
    ],
  );
  return Boolean(result.rows[0]?.inserted);
}

function parseEvent(event: any, venue: MonitoredVenue) {
  const attractions: any[] = event?._embedded?.attractions ?? [];
  const artistName = attractions[0]?.name ?? event?.name ?? '';
  const tmArtistId = attractions[0]?.id ?? '';
  const cls = (event?.classifications ?? [])[0] ?? {};
  return {
    tmEventId: String(event?.id ?? ''),
    eventName: String(event?.name ?? ''),
    artistName: String(artistName),
    tmArtistId: String(tmArtistId),
    venueName: venue.name,
    venueCity: venue.city,
    eventDate: String(event?.dates?.start?.localDate ?? ''),
    genre: String(cls?.genre?.name ?? ''),
    subgenre: String(cls?.subGenre?.name ?? ''),
  };
}

async function collectForVenue(venue: MonitoredVenue, discoveryId: string, start: Date, end: Date): Promise<number> {
  let newCount = 0;
  let page = 0;
  let totalPages = 1;

  while (page < totalPages) {
    const data = await tmGet('events.json', {
      venueId: discoveryId,
      classificationName: 'Music',
      startDateTime: tmDateTime(start),
      endDateTime: tmDateTime(end),
      countryCode: 'GB',
      size: 100,
      page,
      sort: 'date,asc',
    });
    if (!data) break;
    totalPages = data.page?.totalPages ?? 1;
    const events: any[] = data._embedded?.events ?? [];
    if (events.length === 0) break;
    for (const ev of events) {
      const parsed = parseEvent(ev, venue);
      if (!parsed.tmEventId) continue;
      if (await upsertEvent(parsed)) newCount += 1;
    }
    page += 1;
  }
  return newCount;
}

export interface CollectSummary {
  venuesResolved: number;
  venuesCollected: number;
  newEvents: number;
}

/** Collect events across all monitored venues for the [today, today+maxWeeks] window. */
export async function collectAll(maxWeeks: number): Promise<CollectSummary> {
  const start = new Date();
  const end = new Date(start.getTime() + maxWeeks * 7 * 24 * 60 * 60 * 1000);

  let venuesResolved = 0;
  let venuesCollected = 0;
  let newEvents = 0;

  for (const venue of MONITORED_VENUES) {
    const discoveryId = venue.tmDiscoveryId ?? (await resolveVenueId(venue));
    if (!discoveryId) continue;
    venuesResolved += 1;
    newEvents += await collectForVenue(venue, discoveryId, start, end);
    venuesCollected += 1;
  }

  const summary = { venuesResolved, venuesCollected, newEvents };
  console.log('[leads/collect] done:', summary);
  return summary;
}
