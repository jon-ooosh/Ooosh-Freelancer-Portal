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
 * The window is staff-choosable per run ("tours starting between X and Y");
 * the default is [today + minLeadWeeks, today + maxWeeks] from the settings. A
 * tour qualifies on its FIRST UK date falling inside the window.
 *
 * Acts staff marked "Not a fit — don't show again" (`lead_suppressions`) are
 * skipped before any Ticketmaster call is spent on them.
 *
 * Qualifying tours are upserted into `leads`. A re-detected tour is the same
 * lead if its dates OVERLAP an existing lead for the act — not only if the first
 * date is identical — so Ticketmaster adding or dropping an opening date
 * doesn't resurface a tour staff already dismissed. Lifecycle + score on an
 * existing lead are preserved on re-detection.
 */
import { query } from '../../config/database';
import { tmGet, tmDateTime } from './ticketmaster';
import { EXCLUDE_CLASSIFICATIONS, EXCLUDE_EVENT_PATTERNS } from './venues';
import { normaliseArtist } from './normalise';

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

/** All the act's UK dates from TODAY (so the true first date is known) to `end`. */
async function findAllUkDates(tmArtistId: string, end: Date): Promise<UkDate[]> {
  if (!tmArtistId) return [];
  const now = new Date();
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
  // Same act (by name, or by Ticketmaster id) with overlapping dates = the
  // same tour. An identical first date wins if there's a choice — it's the row
  // the unique (lower(name), first_date) index would otherwise collide with.
  const existing = await query(
    `SELECT id FROM leads
      WHERE (lower(artist_name) = lower($1) OR (COALESCE($2, '') <> '' AND tm_artist_id = $2))
        AND first_date <= $4::date AND COALESCE(last_date, first_date) >= $3::date
      ORDER BY (first_date = $3::date) DESC, first_date ASC
      LIMIT 1`,
    [tour.artistName, tour.tmArtistId, tour.firstDate, tour.lastDate],
  );
  if (existing.rows[0]) {
    await query(
      `UPDATE leads SET uk_date_count=$2, first_date=$3::date, last_date=$4::date, venues=$5, all_dates=$6,
         tm_artist_id=$7, last_run_id=$8, updated_at=NOW()
       WHERE id=$1`,
      [
        existing.rows[0].id, tour.ukDateCount, tour.firstDate, tour.lastDate,
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
  /** First UK date before the window start (already running / too imminent). */
  droppedTooImminent: number;
  /** First UK date after the window end. */
  droppedAfterWindow: number;
  droppedNotTour: number;
  skippedExcluded: number;
  skippedSuppressed: number;
}

export interface SearchWindow {
  /** Tours must START on or after this date (YYYY-MM-DD). */
  from: string;
  /** …and on or before this one (YYYY-MM-DD). */
  to: string;
}

export async function detectTours(
  runId: string,
  opts: { window: SearchWindow; tourMinDates: number; tourWindowWeeks: number },
): Promise<DetectSummary> {
  const artists = await query(
    `SELECT tm_artist_id, MAX(artist_name) AS artist_name
       FROM tf_events
      WHERE processed = FALSE AND COALESCE(tm_artist_id, '') <> ''
      GROUP BY tm_artist_id`,
  );

  // Look past the window end by one tour-window, so a tour that starts inside
  // the window is seen whole (its date count and last date are right).
  const lookupEnd = new Date(`${opts.window.to}T23:59:59Z`);
  lookupEnd.setUTCDate(lookupEnd.getUTCDate() + opts.tourWindowWeeks * 7);

  const supp = await query(`SELECT artist_key, tm_artist_id FROM lead_suppressions`);
  const suppressedKeys = new Set(supp.rows.map((r) => r.artist_key as string));
  const suppressedTmIds = new Set(supp.rows.map((r) => r.tm_artist_id as string | null).filter(Boolean) as string[]);

  const s: DetectSummary = {
    artistsProcessed: 0, toursCreated: 0, toursUpdated: 0,
    droppedTooImminent: 0, droppedAfterWindow: 0, droppedNotTour: 0,
    skippedExcluded: 0, skippedSuppressed: 0,
  };

  for (const artist of artists.rows) {
    const tmArtistId = artist.tm_artist_id as string;
    const artistName = artist.artist_name as string;
    s.artistsProcessed += 1;

    if (suppressedTmIds.has(tmArtistId) || suppressedKeys.has(normaliseArtist(artistName))) {
      s.skippedSuppressed += 1;
      await query(`UPDATE tf_events SET processed = TRUE WHERE tm_artist_id = $1`, [tmArtistId]);
      continue;
    }

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

    let ukDates = await findAllUkDates(tmArtistId, lookupEnd);
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

    // The fix: drop tours whose earliest visible UK date is too soon to sell
    // into (before the window) — or, on a targeted search, after it. Dates are
    // TM local YYYY-MM-DD strings, so compare as strings (no timezone drift).
    if (firstDate < opts.window.from) {
      s.droppedTooImminent += 1;
      continue;
    }
    if (firstDate > opts.window.to) {
      s.droppedAfterWindow += 1;
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
