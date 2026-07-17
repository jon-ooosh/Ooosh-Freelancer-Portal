/**
 * Phase 2 — Detect. Ported from `tour_detector.py`, with the lookahead fix.
 *
 * For each artist seen at a monitored venue, look up ALL their UK dates in the
 * window, then decide if it's a sellable tour:
 *   - qualifies only if ≥ tourMinDates fall within any tourWindowWeeks window
 *     (the original tool created a lead for every artist — we're stricter, which
 *     cuts noise + AI spend); and
 *   - DROP any tour whose earliest visible UK date is < today + minLeadWeeks.
 *     TM only surfaces future dates, so a band already on the road shows an
 *     earliest date of ~today → dropped. This is the "already running / too
 *     imminent to sell" fix jon asked for.
 *
 * Qualifying tours are upserted into `leads` (deduped on lower(name)+first date);
 * lifecycle + score on an existing lead are preserved on re-detection.
 */
import { query } from '../../config/database';
import { tmGet, tmDateTime } from './ticketmaster';
import { EXCLUDE_CLASSIFICATIONS, EXCLUDE_EVENT_PATTERNS } from './venues';

/* eslint-disable @typescript-eslint/no-explicit-any */

interface StoredEvent {
  tm_event_id: string;
  event_name: string | null;
  genre: string | null;
  subgenre: string | null;
  venue_name: string | null;
  venue_city: string | null;
  event_date: string | null;
}

function shouldExcludeEvent(e: StoredEvent): boolean {
  const name = (e.event_name ?? '').toLowerCase();
  const genre = (e.genre ?? '').toLowerCase();
  const subgenre = (e.subgenre ?? '').toLowerCase();
  for (const cls of EXCLUDE_CLASSIFICATIONS) {
    if (genre.includes(cls.toLowerCase()) || subgenre.includes(cls.toLowerCase())) return true;
  }
  for (const p of EXCLUDE_EVENT_PATTERNS) {
    if (name.includes(p.toLowerCase())) return true;
  }
  return false;
}

/** ≥ minDates fall within any window of windowWeeks? */
function qualifiesAsTour(dates: string[], windowWeeks: number, minDates: number): boolean {
  const parsed = dates
    .filter(Boolean)
    .map((d) => new Date(d).getTime())
    .filter((t) => !Number.isNaN(t))
    .sort((a, b) => a - b);
  if (parsed.length < minDates) return false;
  const windowMs = windowWeeks * 7 * 24 * 60 * 60 * 1000;
  for (let i = 0; i < parsed.length; i++) {
    const count = parsed.filter((t) => t - parsed[i] <= windowMs && t >= parsed[i]).length;
    if (count >= minDates) return true;
  }
  return false;
}

interface UkDate { date: string; venue: string; city: string; tmEventId: string; }

async function findAllUkDates(tmArtistId: string, maxWeeks: number): Promise<UkDate[]> {
  if (!tmArtistId) return [];
  const now = new Date();
  const end = new Date(now.getTime() + maxWeeks * 7 * 24 * 60 * 60 * 1000);
  const all: UkDate[] = [];
  let page = 0;
  let totalPages = 1;

  while (page < totalPages) {
    const data = await tmGet('events.json', {
      attractionId: tmArtistId,
      countryCode: 'GB',
      startDateTime: tmDateTime(now),
      endDateTime: tmDateTime(end),
      size: 100,
      page,
      sort: 'date,asc',
    });
    if (!data) break;
    totalPages = data.page?.totalPages ?? 1;
    const events: any[] = data._embedded?.events ?? [];
    if (events.length === 0) break;
    for (const ev of events) {
      const v = (ev?._embedded?.venues ?? [{}])[0];
      all.push({
        date: String(ev?.dates?.start?.localDate ?? ''),
        venue: String(v?.name ?? 'Unknown'),
        city: String(v?.city?.name ?? 'Unknown'),
        tmEventId: String(ev?.id ?? ''),
      });
    }
    page += 1;
  }

  // Dedup by event id
  const seen = new Set<string>();
  return all.filter((e) => {
    if (seen.has(e.tmEventId)) return false;
    seen.add(e.tmEventId);
    return true;
  });
}

async function upsertLead(
  runId: string,
  tour: {
    artistName: string;
    tmArtistId: string;
    ukDateCount: number;
    firstDate: string;
    lastDate: string;
    venues: string[];
    allDates: string[];
  },
): Promise<'inserted' | 'updated'> {
  const existing = await query(
    `SELECT id FROM leads WHERE lower(artist_name) = lower($1) AND first_date = $2::date`,
    [tour.artistName, tour.firstDate],
  );
  if (existing.rows[0]) {
    await query(
      `UPDATE leads SET uk_date_count=$2, last_date=$3::date, venues=$4, all_dates=$5,
         tm_artist_id=$6, last_run_id=$7, updated_at=NOW()
       WHERE id=$1`,
      [
        existing.rows[0].id, tour.ukDateCount, tour.lastDate,
        JSON.stringify(tour.venues), JSON.stringify(tour.allDates),
        tour.tmArtistId, runId,
      ],
    );
    return 'updated';
  }
  await query(
    `INSERT INTO leads (artist_name, tm_artist_id, uk_date_count, first_date, last_date, venues, all_dates, last_run_id)
     VALUES ($1,$2,$3,$4::date,$5::date,$6,$7,$8)`,
    [
      tour.artistName, tour.tmArtistId, tour.ukDateCount, tour.firstDate, tour.lastDate,
      JSON.stringify(tour.venues), JSON.stringify(tour.allDates), runId,
    ],
  );
  return 'inserted';
}

export interface DetectSummary {
  artistsProcessed: number;
  toursCreated: number;
  toursUpdated: number;
  droppedTooImminent: number;
  droppedNotTour: number;
  skippedExcluded: number;
}

export async function detectTours(
  runId: string,
  opts: { minLeadWeeks: number; maxWeeks: number; tourMinDates: number; tourWindowWeeks: number },
): Promise<DetectSummary> {
  const artists = await query(
    `SELECT tm_artist_id, MAX(artist_name) AS artist_name
       FROM tf_events
      WHERE processed = FALSE AND COALESCE(tm_artist_id, '') <> ''
      GROUP BY tm_artist_id`,
  );

  const minLeadCutoff = new Date(Date.now() + opts.minLeadWeeks * 7 * 24 * 60 * 60 * 1000);

  const s: DetectSummary = {
    artistsProcessed: 0, toursCreated: 0, toursUpdated: 0,
    droppedTooImminent: 0, droppedNotTour: 0, skippedExcluded: 0,
  };

  for (const artist of artists.rows) {
    const tmArtistId = artist.tm_artist_id as string;
    const artistName = artist.artist_name as string;
    s.artistsProcessed += 1;

    const stored = await query(
      `SELECT tm_event_id, event_name, genre, subgenre, venue_name, venue_city, event_date
         FROM tf_events WHERE tm_artist_id = $1`,
      [tmArtistId],
    );
    const events = stored.rows as StoredEvent[];

    // If every stored event is excluded by heuristics, skip the artist entirely.
    if (events.length > 0 && events.every((e) => shouldExcludeEvent(e))) {
      s.skippedExcluded += 1;
      await query(`UPDATE tf_events SET processed = TRUE WHERE tm_artist_id = $1`, [tmArtistId]);
      continue;
    }

    let ukDates = await findAllUkDates(tmArtistId, opts.maxWeeks);
    if (ukDates.length === 0) {
      // Fall back to what we collected directly at monitored venues.
      ukDates = events
        .filter((e) => e.event_date)
        .map((e) => ({
          date: e.event_date as string,
          venue: e.venue_name ?? 'Unknown',
          city: e.venue_city ?? 'Unknown',
          tmEventId: e.tm_event_id,
        }));
    }
    ukDates.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));

    const dates = ukDates.map((d) => d.date).filter(Boolean);
    const venues = Array.from(new Set(ukDates.map((d) => d.venue)));

    await query(`UPDATE tf_events SET processed = TRUE WHERE tm_artist_id = $1`, [tmArtistId]);

    if (dates.length === 0) continue;

    const firstDate = dates[0];
    const lastDate = dates[dates.length - 1];

    // The fix: drop tours whose earliest visible UK date is too soon to sell into.
    if (new Date(firstDate) < minLeadCutoff) {
      s.droppedTooImminent += 1;
      continue;
    }
    if (!qualifiesAsTour(dates, opts.tourWindowWeeks, opts.tourMinDates)) {
      s.droppedNotTour += 1;
      continue;
    }

    const result = await upsertLead(runId, {
      artistName, tmArtistId, ukDateCount: dates.length,
      firstDate, lastDate, venues, allDates: dates,
    });
    if (result === 'inserted') s.toursCreated += 1;
    else s.toursUpdated += 1;
  }

  console.log('[leads/detect] done:', s);
  return s;
}
