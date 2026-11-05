/**
 * Band watch — "tell me when this band is next over" (docs/TOUR-FINDER-SPEC.md §21).
 *
 * The Lead Finder search starts from venues; a watch starts from a band we
 * know. One watch per organisation (`band_watches`, migration 324), started
 * from the lost / cancelled / completed close-outs (ticked by default) or the
 * org page, and stopped by hand only — a band that splits up just never comes up.
 *
 * Once a day (config/scheduler.ts) every watch due its weekly check asks
 * Ticketmaster for every date its act has in the UK and Europe. The dates are
 * grouped into tours; a tour starting too soon to sell into is dropped
 * (`lead_lookahead_min_weeks`, the search's own rule). Each tour becomes an
 * ordinary WARM lead (`match_via = 'watch'`, `watch_id` set): scored with the
 * band's history, linked to its jobs, first on the dashboard card. The person
 * who last ticked the watch gets a bell.
 *
 * Matching a band to its Ticketmaster act: a lead that already has it, else
 * exactly ONE act with the same normalised name. None or several go on the
 * "Match these" list for a person to pick. Never a fuzzy guess.
 *
 * Nothing here ever fails the action that called it (a close-out, a click).
 */
import { query } from '../../config/database';
import { getSystemSetting } from '../../routes/system-settings';
import { MANAGER_ROLES, STAFF_ROLES } from '../../middleware/auth';
import { ALTERNATIVE_QUOTE_LOST_REASON } from '../job-groups';
import { ukDatePlus } from '../uk-date';
import {
  tmGet, tmDateTime, isTicketmasterConfigured, resetTicketmasterCallBudget,
} from './ticketmaster';
import { normaliseArtist } from './normalise';
import { linkLeadToOrg } from './matcher';
import { syncTourJobs, liveTourJobSql } from './tour-jobs';
import { scoreLeads } from './scorer';
import { logLeadEvent } from './events';
import { isRunActive } from './pipeline';
import {
  TourDate, UkPosition, UK_POSITION_TEXT, groupIntoTours, ukPosition, actSearchNames,
} from './watch-tours';

export type { TourDate, UkPosition };

/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * How a watch is matched to its Ticketmaster act:
 *   pending     — not looked up yet (or Ticketmaster didn't answer)
 *   auto        — exactly one act with the name, or a lead already had it
 *   confirmed   — a person picked it
 *   needs_match — several possible acts: a person picks on "Match these"
 *   unknown     — Ticketmaster has never heard of the name; looked up again monthly
 *   not_found   — a PERSON said it isn't on Ticketmaster; never looked up again
 */
export type TmMatch = 'pending' | 'auto' | 'confirmed' | 'needs_match' | 'unknown' | 'not_found';

/** Org types that are a company, not a band — never ticked by default, never in the back catalogue. */
export const NOT_A_BAND_TYPES = [
  'management', 'label', 'agency', 'promoter', 'venue', 'festival', 'supplier', 'hire_company', 'booking_agent',
];

/** How often an 'unknown' watch is looked up again, in case the act appears on Ticketmaster. */
const UNKNOWN_RETRY_SQL = `INTERVAL '30 days'`;

/** One Ticketmaster act offered on the "Match these" list. */
export interface TmCandidate {
  id: string;
  name: string;
  segment: string | null;
  genre: string | null;
  /** Upcoming events Ticketmaster lists for the act, anywhere. */
  upcoming: number | null;
  url: string | null;
  /** Same name as the band once normalised (normaliseArtist). */
  exact: boolean;
}

/** The UK and Europe, by Ticketmaster's venue country code. GB is the UK. */
const EUROPE = new Set([
  'GB', 'IE', 'FR', 'DE', 'NL', 'BE', 'LU', 'ES', 'PT', 'IT', 'AT', 'CH', 'DK', 'SE', 'NO',
  'FI', 'IS', 'PL', 'CZ', 'SK', 'HU', 'SI', 'HR', 'RO', 'BG', 'GR', 'EE', 'LV', 'LT', 'MT', 'CY',
]);

/** Ticketmaster lists extras (parking, upgrades) as events on the act — never a show. */
const ADD_ON_PATTERNS = [
  'parking', 'car park', 'upgrade', 'hospitality', 'meet & greet', 'meet and greet',
  'vip package', 'shuttle', 'coach travel', 'merch',
];

/** How far ahead to ask Ticketmaster (~18 months). */
const LOOKAHEAD_DAYS = 548;
/** Weekly, with slack so a daily run at a fixed time always catches it. */
const CHECK_INTERVAL_SQL = `INTERVAL '6 days 12 hours'`;
/** Watches checked per run — about 400–800 Ticketmaster calls, well inside 5,000 a day. */
const RUN_CHECK_LIMIT = 400;
const RUN_MATCH_LIMIT = 100;

// ── Matching a band to its Ticketmaster act ──────────────────────────────────

function toCandidate(a: any, wanted: string): TmCandidate | null {
  const id = typeof a?.id === 'string' ? a.id : null;
  const name = typeof a?.name === 'string' ? a.name : null;
  if (!id || !name) return null;
  const cls = (a?.classifications ?? [])[0] ?? {};
  return {
    id,
    name,
    segment: typeof cls?.segment?.name === 'string' ? cls.segment.name : null,
    genre: typeof cls?.genre?.name === 'string' ? cls.genre.name : null,
    upcoming: typeof a?.upcomingEvents?._total === 'number' ? a.upcomingEvents._total : null,
    url: typeof a?.url === 'string' ? a.url : null,
    exact: normaliseArtist(name) === wanted,
  };
}

/**
 * Ticketmaster acts called something like `name` — exact name matches first,
 * then music acts, then the busiest. `null` when Ticketmaster didn't answer.
 */
export async function searchTicketmasterActs(name: string): Promise<TmCandidate[] | null> {
  const wanted = normaliseArtist(name);
  if (!wanted) return [];
  const data = await tmGet('attractions.json', { keyword: name.trim(), size: 20 });
  if (!data) return null;
  const list = ((data._embedded?.attractions ?? []) as any[])
    .map((a) => toCandidate(a, wanted))
    .filter((c): c is TmCandidate => c !== null);
  return sortCandidates(list);
}

function sortCandidates(list: TmCandidate[]): TmCandidate[] {
  const rank = (c: TmCandidate) => (c.exact ? 0 : 2) + (c.segment === 'Music' ? 0 : 1);
  return list.sort((a, b) => rank(a) - rank(b) || (b.upcoming ?? 0) - (a.upcoming ?? 0));
}

export interface ActLookup {
  /** known = exactly one act with the name; ambiguous = several, or only similar names; unknown = nothing. */
  status: 'known' | 'ambiguous' | 'unknown';
  /** The act, when known. */
  act: TmCandidate | null;
  /** Acts with exactly the name (any of the names tried). */
  exactCount: number;
  candidates: TmCandidate[];
  /** The names looked up (actSearchNames). */
  searched: string[];
}

/**
 * Look an organisation up on Ticketmaster by every name it could go by
 * (actSearchNames — "Skindred LLP" is searched as "Skindred"). `null` when
 * Ticketmaster didn't answer.
 */
export async function findActForName(orgName: string): Promise<ActLookup | null> {
  const names = actSearchNames(orgName);
  const wanted = new Set(names.map(normaliseArtist));
  const byId = new Map<string, TmCandidate>();
  for (const n of names) {
    const found = await searchTicketmasterActs(n);
    if (found === null) return null;
    for (const c of found) {
      const prev = byId.get(c.id);
      byId.set(c.id, { ...c, exact: wanted.has(normaliseArtist(c.name)) || Boolean(prev?.exact) });
    }
  }
  const all = sortCandidates(Array.from(byId.values()));
  const exact = all.filter((c) => c.exact);
  const status = exact.length === 1 ? 'known' : all.length === 0 ? 'unknown' : 'ambiguous';
  return { status, act: status === 'known' ? exact[0] : null, exactCount: exact.length, candidates: all.slice(0, 8), searched: names };
}

/**
 * Find a watch's Ticketmaster act. Only touches a watch still 'pending' or
 * 'unknown', so a person's choice is never overwritten. Returns the state it
 * ended in; 'pending' / 'unknown' unchanged when Ticketmaster didn't answer
 * (the next daily run tries again).
 */
export async function matchWatch(watchId: string): Promise<TmMatch | null> {
  const w = await query(
    `SELECT bw.id, bw.tm_match, o.id AS org_id, o.name
       FROM band_watches bw JOIN organisations o ON o.id = bw.organisation_id
      WHERE bw.id = $1`,
    [watchId],
  );
  const row = w.rows[0];
  if (!row) return null;
  if (row.tm_match !== 'pending' && row.tm_match !== 'unknown') return row.tm_match as TmMatch;

  const set = async (
    state: 'auto' | 'needs_match' | 'unknown',
    act: { id: string; name: string } | null,
    candidates: TmCandidate[] = [],
  ): Promise<TmMatch> => {
    await query(
      `UPDATE band_watches SET tm_match = $2, tm_attraction_id = $3, tm_attraction_name = $4,
         tm_candidates = $5, tm_looked_up_at = NOW(), updated_at = NOW()
       WHERE id = $1 AND tm_match IN ('pending', 'unknown')`,
      [watchId, state, act?.id ?? null, act?.name ?? null, JSON.stringify(candidates)],
    );
    return state;
  };

  // 1. A lead already linked to this band knows its act. Not one matched via
  //    a management company's job names — that act is the company's band, not
  //    necessarily this org.
  const fromLead = await query(
    `SELECT tm_artist_id, artist_name FROM leads
      WHERE matched_organisation_id = $1 AND COALESCE(tm_artist_id, '') <> ''
        AND COALESCE(match_via, 'org_name') <> 'job_name'
      ORDER BY updated_at DESC LIMIT 1`,
    [row.org_id],
  );
  if (fromLead.rows[0]) {
    return set('auto', { id: fromLead.rows[0].tm_artist_id, name: fromLead.rows[0].artist_name });
  }

  // 2. Ticketmaster, by every name the org could go by.
  if (!isTicketmasterConfigured()) return row.tm_match as TmMatch;
  const look = await findActForName(row.name as string);
  if (look === null) return row.tm_match as TmMatch;
  if (look.status === 'known' && look.act) return set('auto', look.act);
  // 3. Several possible acts — a person picks on "Match these". Nothing at
  //    all — 'unknown', looked up again monthly (usually not a band, or one
  //    Ticketmaster doesn't sell).
  return look.status === 'ambiguous' ? set('needs_match', null, look.candidates) : set('unknown', null);
}

/**
 * A person's answer on the "Match these" list (or "Wrong band?"): this act,
 * or not on Ticketmaster at all. Clears the last check so the new act is
 * checked straight away.
 */
export async function setWatchMatch(
  watchId: string,
  act: { id: string; name: string } | null,
): Promise<boolean> {
  const r = await query(
    `UPDATE band_watches SET
       tm_match = $2, tm_attraction_id = $3, tm_attraction_name = $4,
       last_tm_check_at = NULL, updated_at = NOW()
     WHERE id = $1`,
    [watchId, act ? 'confirmed' : 'not_found', act?.id ?? null, act?.name ?? null],
  );
  return (r.rowCount ?? 0) > 0;
}

/** Look the act up again from scratch (the org was renamed, or Ticketmaster was down). */
export async function resetWatchMatch(watchId: string): Promise<void> {
  await query(
    `UPDATE band_watches SET tm_match = 'pending', tm_attraction_id = NULL, tm_attraction_name = NULL,
       tm_candidates = '[]', last_tm_check_at = NULL, updated_at = NOW()
     WHERE id = $1`,
    [watchId],
  );
}

// ── Starting and stopping ─────────────────────────────────────────────────────

/**
 * Watch a band. Ticking it again (a later close-out) records that job and
 * person; a stopped watch starts again. A new watch looks up its act in the
 * background.
 */
export async function startWatch(
  orgId: string,
  opts: {
    jobId?: string | null;
    userId: string | null;
    /** A look-up already done (the back catalogue) — saves looking it up again. */
    lookup?: ActLookup | null;
    /** Leave a new watch 'pending' for the next daily run to look up (bulk watching). */
    deferLookup?: boolean;
  },
): Promise<{ id: string; created: boolean; restarted: boolean }> {
  const before = await query(`SELECT stopped_at FROM band_watches WHERE organisation_id = $1`, [orgId]);
  const look = opts.lookup ?? null;
  const preset: { state: TmMatch; act: TmCandidate | null; candidates: TmCandidate[] } = !look
    ? { state: 'pending', act: null, candidates: [] }
    : look.status === 'known' && look.act
      ? { state: 'auto', act: look.act, candidates: [] }
      : look.status === 'ambiguous'
        ? { state: 'needs_match', act: null, candidates: look.candidates }
        : { state: 'unknown', act: null, candidates: [] };
  const r = await query(
    `INSERT INTO band_watches
       (organisation_id, started_from_job_id, started_by, last_ticked_job_id, last_ticked_by, last_ticked_at,
        tm_match, tm_attraction_id, tm_attraction_name, tm_candidates, tm_looked_up_at)
     VALUES ($1, $2, $3, $2, $3, NOW(), $4, $5, $6, $7, CASE WHEN $4 = 'pending' THEN NULL ELSE NOW() END)
     ON CONFLICT (organisation_id) DO UPDATE SET
       last_ticked_job_id = COALESCE(EXCLUDED.last_ticked_job_id, band_watches.last_ticked_job_id),
       last_ticked_by = COALESCE(EXCLUDED.last_ticked_by, band_watches.last_ticked_by),
       last_ticked_at = NOW(),
       stopped_at = NULL, stopped_by = NULL, updated_at = NOW()
     RETURNING id, tm_match`,
    [orgId, opts.jobId ?? null, opts.userId, preset.state, preset.act?.id ?? null, preset.act?.name ?? null,
      JSON.stringify(preset.candidates)],
  );
  const id = r.rows[0].id as string;
  if (r.rows[0].tm_match === 'pending' && !opts.deferLookup) {
    setImmediate(() => {
      matchWatch(id).catch((err) => console.error('[band-watch] matching %s failed:', id, err));
    });
  }
  return {
    id,
    created: !before.rows[0],
    restarted: Boolean(before.rows[0]?.stopped_at),
  };
}

export async function stopWatch(watchId: string, userId: string | null): Promise<boolean> {
  const r = await query(
    `UPDATE band_watches SET stopped_at = NOW(), stopped_by = $2, updated_at = NOW()
      WHERE id = $1 AND stopped_at IS NULL`,
    [watchId, userId],
  );
  return (r.rowCount ?? 0) > 0;
}

/**
 * The close-out modals' "Watch this band" tick (routes/pipeline.ts,
 * routes/cancellations.ts). Never on an alternative-quote loss (not a real
 * loss). Never throws: a watch must not fail the status change.
 */
export async function startWatchFromCloseOut(args: {
  jobId: string;
  organisationId: string;
  userId: string | null;
  lostReason?: string | null;
}): Promise<void> {
  try {
    if (args.lostReason === ALTERNATIVE_QUOTE_LOST_REASON) return;
    const org = await query(
      `SELECT id FROM organisations WHERE id = $1 AND is_deleted = false`,
      [args.organisationId],
    );
    if (!org.rows[0]) return;
    await startWatch(args.organisationId, { jobId: args.jobId, userId: args.userId });
  } catch (err) {
    console.error('[band-watch] close-out watch for job %s failed (non-fatal):', args.jobId, err);
  }
}

export interface WatchSummary {
  id: string;
  tm_match: TmMatch;
  tm_attraction_name: string | null;
  started_at: string;
  stopped_at: string | null;
  last_tm_check_at: string | null;
}

async function watchFor(orgId: string): Promise<WatchSummary | null> {
  const r = await query(
    `SELECT id, tm_match, tm_attraction_name, started_at, stopped_at, last_tm_check_at
       FROM band_watches WHERE organisation_id = $1`,
    [orgId],
  );
  return (r.rows[0] as WatchSummary | undefined) ?? null;
}

export async function getWatchForOrg(orgId: string): Promise<WatchSummary | null> {
  return watchFor(orgId);
}

/** Why the close-out tick starts ticked or not — the modal words its hint from it. */
export type TickWhy =
  | 'watching'      // already watched — ticking again notes this job against it
  | 'stopped'       // someone stopped watching them — unticked
  | 'not_a_band'    // the client is a company type — unticked, pick the band
  | 'tm_known'      // Ticketmaster knows the name — ticked
  | 'tm_similar'    // Ticketmaster only has similar names — unticked
  | 'tm_unknown'    // Ticketmaster has never heard of the name — unticked
  | 'tm_unchecked'; // couldn't ask Ticketmaster (not set up, or no answer in time) — ticked

export interface WatchTarget {
  organisation_id: string;
  name: string;
  type: string | null;
  source: 'band' | 'client';
  watch: WatchSummary | null;
  /** Ticketmaster's act for the name, when it knows one. */
  tm_act_name: string | null;
  tm_upcoming: number | null;
  default_on: boolean;
  why: TickWhy;
}

/** A close-out shouldn't wait on Ticketmaster for long: past this, the tick is decided without it. */
const TICK_LOOKUP_TIMEOUT_MS = 4000;

/**
 * What the close-out tick offers to watch, and whether it starts ticked
 * (spec §21.8). The band is the job's Band org, else its client org (often the
 * band itself). It starts ticked only when Ticketmaster knows the name — one
 * quick look-up — or when it couldn't be asked; never for a band someone
 * stopped watching or a client that is a company type. `null` when the job
 * has neither org; the modal then lets a person pick one.
 */
export async function watchTargetForJob(jobId: string): Promise<WatchTarget | null> {
  const band = await query(
    `SELECT o.id, o.name, o.type FROM job_organisations jo
       JOIN organisations o ON o.id = jo.organisation_id AND o.is_deleted = false
      WHERE jo.job_id = $1 AND jo.role = 'band'
      ORDER BY jo.is_primary DESC, jo.created_at
      LIMIT 1`,
    [jobId],
  );
  let row = band.rows[0];
  let source: 'band' | 'client' = 'band';
  if (!row) {
    const client = await query(
      `SELECT o.id, o.name, o.type FROM jobs j
         JOIN organisations o ON o.id = j.client_id AND o.is_deleted = false
        WHERE j.id = $1`,
      [jobId],
    );
    row = client.rows[0];
    source = 'client';
  }
  if (!row) return null;

  const watch = await watchFor(row.id);
  const base = {
    organisation_id: row.id as string, name: row.name as string, type: (row.type ?? null) as string | null,
    source, watch, tm_act_name: null as string | null, tm_upcoming: null as number | null,
  };
  const decide = (default_on: boolean, why: TickWhy, act?: { name: string; upcoming?: number | null } | null): WatchTarget =>
    ({ ...base, tm_act_name: act?.name ?? null, tm_upcoming: act?.upcoming ?? null, default_on, why });

  if (watch && !watch.stopped_at) {
    return decide(true, 'watching', watch.tm_attraction_name ? { name: watch.tm_attraction_name } : null);
  }
  if (watch?.stopped_at) return decide(false, 'stopped');
  if (source === 'client' && NOT_A_BAND_TYPES.includes(base.type ?? '')) return decide(false, 'not_a_band');

  // A lead already linked to this org knows its act.
  const fromLead = await query(
    `SELECT artist_name FROM leads
      WHERE matched_organisation_id = $1 AND COALESCE(tm_artist_id, '') <> ''
        AND COALESCE(match_via, 'org_name') <> 'job_name'
      ORDER BY updated_at DESC LIMIT 1`,
    [row.id],
  );
  if (fromLead.rows[0]) return decide(true, 'tm_known', { name: fromLead.rows[0].artist_name });

  if (!isTicketmasterConfigured()) return decide(true, 'tm_unchecked');
  let look: ActLookup | null = null;
  try {
    look = await Promise.race([
      findActForName(base.name),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), TICK_LOOKUP_TIMEOUT_MS)),
    ]);
  } catch (err) {
    console.warn('[band-watch] tick look-up failed for org %s:', row.id, err);
  }
  if (!look) return decide(true, 'tm_unchecked');
  if (look.exactCount >= 1) {
    const act = look.act ?? look.candidates.find((c) => c.exact) ?? null;
    return decide(true, 'tm_known', act ? { name: act.name, upcoming: act.upcoming } : null);
  }
  return decide(false, look.status === 'ambiguous' ? 'tm_similar' : 'tm_unknown');
}

// ── The check ─────────────────────────────────────────────────────────────────

/** "UK, DE, NL" in the order the tour reaches them. */
function countryList(tour: TourDate[]): string {
  const seen: string[] = [];
  for (const d of tour) {
    const c = d.country === 'GB' ? 'UK' : d.country;
    if (!seen.includes(c)) seen.push(c);
  }
  return seen.join(', ');
}

/** '2027-03-15' → '15 Mar 2027'. */
function fmtDay(ymd: string): string {
  const [y, m, d] = ymd.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('en-GB', {
    day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC',
  });
}

/** The lead's summary sentence — replaces the search's "touring the UK" line. */
function tourLine(name: string, tour: TourDate[]): string {
  const first = tour[0].date;
  const last = tour[tour.length - 1].date;
  return `${name} — watched band touring again: ${tour.length} date(s) in ${countryList(tour)}, `
    + `${fmtDay(first)} to ${fmtDay(last)} (${UK_POSITION_TEXT[ukPosition(tour)]}).`;
}

/**
 * Every date the act has in the UK and Europe from today, one per day and
 * venue, oldest first. `null` when Ticketmaster didn't answer — a partial list
 * could split a tour wrongly, so it's all or nothing.
 */
async function fetchEuropeanDates(attractionId: string): Promise<TourDate[] | null> {
  const start = new Date();
  const end = new Date(Date.now() + LOOKAHEAD_DAYS * 86_400_000);
  const out: TourDate[] = [];
  let page = 0;
  let totalPages = 1;
  // Ticketmaster refuses size × page beyond 1,000; three pages of 200 is plenty for one act.
  while (page < totalPages && page < 3) {
    const data = await tmGet('events.json', {
      attractionId,
      startDateTime: tmDateTime(start),
      endDateTime: tmDateTime(end),
      size: 200,
      page,
      sort: 'date,asc',
    });
    if (!data) return null;
    totalPages = Number(data.page?.totalPages ?? 1) || 1;
    for (const ev of (data._embedded?.events ?? []) as any[]) {
      const name = String(ev?.name ?? '').toLowerCase();
      if (ADD_ON_PATTERNS.some((p) => name.includes(p))) continue;
      if (String(ev?.dates?.status?.code ?? '').toLowerCase() === 'cancelled') continue;
      const v = (ev?._embedded?.venues ?? [])[0] ?? {};
      const country = String(v?.country?.countryCode ?? '').toUpperCase();
      if (!EUROPE.has(country)) continue;
      const date = String(ev?.dates?.start?.localDate ?? '');
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
      out.push({ date, venue: String(v?.name ?? 'Unknown'), city: String(v?.city?.name ?? ''), country });
    }
    page += 1;
  }
  // One show is often listed several times (packages, resale): one per day and venue.
  const seen = new Set<string>();
  return out
    .filter((d) => {
      const key = `${d.date}|${d.venue.toLowerCase()}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
}

interface DueWatch {
  id: string;
  organisation_id: string;
  org_name: string;
  tm_attraction_id: string;
  tm_attraction_name: string | null;
  last_ticked_by: string | null;
  started_by: string | null;
  last_ticked_job_id: string | null;
  started_from_job_id: string | null;
}

/**
 * Record one tour as a lead. Same act (by watch, name or Ticketmaster id) with
 * overlapping dates = the same tour, as the search does (spec §14 item 5), so
 * a tour the search already found is tagged, never duplicated. Returns the
 * lead and whether it is new to the watch (a new lead, or a found one tagged
 * for the first time) — those get a bell.
 */
async function recordTour(w: DueWatch, tour: TourDate[]): Promise<{ leadId: string; isNew: boolean } | null> {
  const first = tour[0].date;
  const last = tour[tour.length - 1].date;
  const artist = w.tm_attraction_name || w.org_name;
  const position = ukPosition(tour);
  const ukCount = tour.filter((d) => d.country === 'GB').length;
  const venues = Array.from(new Set(tour.map((d) => d.venue)));
  const allDates = Array.from(new Set(tour.map((d) => d.date)));
  const line = tourLine(artist, tour);

  const existing = await query(
    `SELECT id, watch_id, lead_source, matched_organisation_id FROM leads
      WHERE (watch_id = $1 OR lower(artist_name) = lower($2) OR lower(artist_name) = lower($3)
             OR (COALESCE($4::text, '') <> '' AND tm_artist_id = $4::text))
        AND first_date IS NOT NULL
        AND first_date <= $6::date AND COALESCE(last_date, first_date) >= $5::date
      ORDER BY (watch_id IS NOT DISTINCT FROM $1) DESC, first_date ASC
      LIMIT 1`,
    [w.id, artist, w.org_name, w.tm_attraction_id, first, last],
  );
  const found = existing.rows[0];

  if (found && found.lead_source === 'band_watch') {
    // Our own lead from an earlier check — keep its dates current. Status,
    // score and contacts are left alone.
    await query(
      `UPDATE leads SET uk_date_count = $2, first_date = $3::date, last_date = $4::date, venues = $5,
         all_dates = $6, tour_dates = $7, uk_position = $8, watch_id = $9, updated_at = NOW()
       WHERE id = $1`,
      [found.id, ukCount, first, last, JSON.stringify(venues), JSON.stringify(allDates),
        JSON.stringify(tour), position, w.id],
    );
    return { leadId: found.id, isNew: !found.watch_id };
  }

  if (found) {
    // The search found this tour first. Tag it and add the European picture;
    // its UK-date fields stay the search's.
    await query(
      `UPDATE leads SET watch_id = $2, tour_dates = $3, uk_position = $4, updated_at = NOW() WHERE id = $1`,
      [found.id, w.id, JSON.stringify(tour), position],
    );
    if (!found.matched_organisation_id) {
      await linkLeadToOrg(found.id, w.organisation_id, 'watch', { enrichOrg: true, tourLine: line });
    }
    if (!found.watch_id) {
      await logLeadEvent(found.id, 'watched', { detail: `${w.org_name} is a watched band` });
      await syncTourJobs(found.id);
    }
    return { leadId: found.id, isNew: !found.watch_id };
  }

  const ins = await query(
    `INSERT INTO leads (artist_name, tm_artist_id, uk_date_count, first_date, last_date, venues, all_dates,
                        tour_dates, uk_position, watch_id, lead_source)
     VALUES ($1, $2, $3, $4::date, $5::date, $6, $7, $8, $9, $10, 'band_watch')
     ON CONFLICT DO NOTHING
     RETURNING id`,
    [artist, w.tm_attraction_id, ukCount, first, last, JSON.stringify(venues), JSON.stringify(allDates),
      JSON.stringify(tour), position, w.id],
  );
  const leadId = ins.rows[0]?.id as string | undefined;
  if (!leadId) return null;
  await linkLeadToOrg(leadId, w.organisation_id, 'watch', { enrichOrg: true, tourLine: line });
  await logLeadEvent(leadId, 'watch_found', {
    detail: `${tour.length} date(s), ${UK_POSITION_TEXT[position]}`,
  });
  await syncTourJobs(leadId);
  return { leadId, isNew: true };
}

interface TourResult {
  first: string;
  last: string;
  dates: number;
  uk_position: UkPosition;
  countries: string;
  lead_id?: string;
  skipped?: 'too_soon' | 'suppressed';
}

/** Check one watch. Returns the leads new to it, or null if Ticketmaster didn't answer. */
async function checkWatch(w: DueWatch, floor: string): Promise<{ newLeadIds: string[]; tours: number } | null> {
  const dates = await fetchEuropeanDates(w.tm_attraction_id);
  if (dates === null) {
    await query(
      `UPDATE band_watches SET last_tm_result = $2, updated_at = NOW() WHERE id = $1`,
      [w.id, JSON.stringify({ checked_at: new Date().toISOString(), error: 'Ticketmaster didn’t answer — tried again tomorrow' })],
    );
    return null;
  }

  // "Not a fit — don't show again" on the Leads page still counts.
  const artist = w.tm_attraction_name || w.org_name;
  const supp = await query(
    `SELECT 1 FROM lead_suppressions WHERE artist_key = $1 OR (tm_artist_id IS NOT NULL AND tm_artist_id = $2) LIMIT 1`,
    [normaliseArtist(artist), w.tm_attraction_id],
  );
  const suppressed = supp.rows.length > 0;

  const results: TourResult[] = [];
  const newLeadIds: string[] = [];
  for (const tour of groupIntoTours(dates)) {
    const r: TourResult = {
      first: tour[0].date,
      last: tour[tour.length - 1].date,
      dates: tour.length,
      uk_position: ukPosition(tour),
      countries: countryList(tour),
    };
    if (r.first < floor) r.skipped = 'too_soon';
    else if (suppressed) r.skipped = 'suppressed';
    else {
      const rec = await recordTour(w, tour);
      if (rec) {
        r.lead_id = rec.leadId;
        if (rec.isNew) newLeadIds.push(rec.leadId);
      }
    }
    results.push(r);
  }

  await query(
    `UPDATE band_watches SET last_tm_check_at = NOW(), last_tm_result = $2, updated_at = NOW() WHERE id = $1`,
    [w.id, JSON.stringify({ checked_at: new Date().toISOString(), european_dates: dates.length, tours: results })],
  );
  return { newLeadIds, tours: results.filter((r) => r.lead_id).length };
}

/** Who hears about a watch's new tour: whoever last ticked it, else the managers. */
async function watchRecipients(w: DueWatch): Promise<string[]> {
  const who = w.last_ticked_by ?? w.started_by;
  if (who) {
    const u = await query(
      `SELECT id FROM users
        WHERE id = $1 AND is_active = true AND COALESCE(login_disabled, false) = false
          AND role = ANY($2::text[])`,
      [who, [...STAFF_ROLES]],
    );
    if (u.rows[0]) return [who];
  }
  const m = await query(
    `SELECT id FROM users
      WHERE is_active = true AND COALESCE(login_disabled, false) = false AND role = ANY($1::text[])`,
    [[...MANAGER_ROLES]],
  );
  return m.rows.map((r) => r.id as string);
}

/** More new tours than this for one person in one run → one summary bell instead. */
const BELLS_PER_PERSON = 3;

/**
 * FYI bells for new tours — after scoring, so a lead the scorer threw out
 * doesn't ring. One bell per tour, unless one person would get more than
 * BELLS_PER_PERSON in a run (the back catalogue's first check can find a lot
 * at once): then one bell lists them and links to Leads, watched only.
 */
async function bellNewLeads(items: Array<{ leadId: string; watch: DueWatch }>): Promise<number> {
  interface Ring { leadId: string; artist: string; title: string; content: string }
  const byPerson = new Map<string, Ring[]>();
  for (const { leadId, watch } of items) {
    try {
      const l = await query(
        `SELECT l.artist_name, l.first_date::text AS first_date, l.last_date::text AS last_date,
                l.uk_position, jsonb_array_length(COALESCE(l.tour_dates, '[]'::jsonb)) AS n
           FROM leads l
          WHERE l.id = $1 AND l.status NOT IN ('dismissed', 'not_relevant') AND NOT ${liveTourJobSql('l')}`,
        [leadId],
      );
      const lead = l.rows[0];
      if (!lead) continue;
      const jobId = watch.last_ticked_job_id ?? watch.started_from_job_id;
      const job = jobId
        ? (await query(`SELECT hh_job_number FROM jobs WHERE id = $1`, [jobId])).rows[0]
        : null;
      const n = Number(lead.n) || 0;
      const ring: Ring = {
        leadId,
        artist: lead.artist_name,
        title: `👁 ${lead.artist_name} is touring again`,
        content: `${n} date${n === 1 ? '' : 's'} from ${fmtDay(lead.first_date)} to ${fmtDay(lead.last_date ?? lead.first_date)}`
          + ` — ${UK_POSITION_TEXT[(lead.uk_position ?? 'none') as UkPosition]}.`
          + ` A band you asked us to watch${job?.hh_job_number ? ` (job #${job.hh_job_number})` : ''}.`
          + ' Open the lead to get in touch while it’s early.',
      };
      for (const userId of await watchRecipients(watch)) {
        const list = byPerson.get(userId) ?? [];
        list.push(ring);
        byPerson.set(userId, list);
      }
    } catch (err) {
      console.error('[band-watch] bell for lead %s failed (non-fatal):', leadId, err);
    }
  }

  let sent = 0;
  for (const [userId, rings] of byPerson) {
    try {
      if (rings.length > BELLS_PER_PERSON) {
        const bands = Array.from(new Set(rings.map((r) => r.artist)));
        const names = bands.slice(0, 5).join(', ') + (bands.length > 5 ? ` and ${bands.length - 5} more` : '');
        const tours = rings.length > bands.length ? ` (${rings.length} tours)` : '';
        await query(
          `INSERT INTO notifications (user_id, type, title, content, entity_type, entity_id, action_url, priority)
           VALUES ($1, 'system', $2, $3, NULL, NULL, '/jobs/leads?type=watched', 'normal')`,
          [userId, `👁 ${bands.length} watched band${bands.length === 1 ? ' is' : 's are'} touring again${tours}`,
            `${names}. They’re on Leads › To review — filtered to watched bands.`],
        );
        sent += 1;
        continue;
      }
      for (const r of rings) {
        await query(
          `INSERT INTO notifications (user_id, type, title, content, entity_type, entity_id, action_url, priority)
           VALUES ($1, 'system', $2, $3, 'leads', $4, $5, 'normal')`,
          [userId, r.title, r.content, r.leadId, `/jobs/leads?lead=${r.leadId}`],
        );
        sent += 1;
      }
    } catch (err) {
      console.error('[band-watch] bells for user %s failed (non-fatal):', userId, err);
    }
  }
  return sent;
}

export interface BandWatchCheckSummary {
  matched: number;
  needsMatch: number;
  checked: number;
  failed: number;
  tours: number;
  newLeads: number;
  bells: number;
  skipped: string | null;
}

/**
 * The band watch's Ticketmaster jobs share one call budget (and the search's —
 * see isRunActive), so only one runs at a time: the check, or the back
 * catalogue's look-up (back-catalogue.ts).
 */
let tmJob: 'check' | 'back_catalogue' | null = null;

export function isBandWatchCheckRunning(): boolean {
  return tmJob === 'check';
}

/** Take the Ticketmaster budget for a job, or say what has it. */
export function claimTicketmaster(kind: 'check' | 'back_catalogue'): string | null {
  if (tmJob === 'check') return 'a band watch check is already running';
  if (tmJob === 'back_catalogue') return 'the past-bands look-up is running';
  tmJob = kind;
  return null;
}

export function releaseTicketmaster(kind: 'check' | 'back_catalogue'): void {
  if (tmJob === kind) tmJob = null;
}

/**
 * The daily run: look up acts for new watches, then check every watch due its
 * weekly check (oldest first). `manual` = "Check now" on the Leads page: runs
 * even with the setting off, and checks every matched watch not checked in
 * the last hour. `onlyWatchId` = one watch, straight after a person matched it.
 */
export async function runBandWatchCheck(
  opts: { manual?: boolean; onlyWatchId?: string } = {},
): Promise<BandWatchCheckSummary> {
  const s: BandWatchCheckSummary = {
    matched: 0, needsMatch: 0, checked: 0, failed: 0, tours: 0, newLeads: 0, bells: 0, skipped: null,
  };
  if (!opts.manual && (await getSystemSetting('band_watch_enabled')) === 'false') { s.skipped = 'switched off'; return s; }
  if (!isTicketmasterConfigured()) { s.skipped = 'Ticketmaster isn’t set up'; return s; }
  // One Ticketmaster call budget is shared with the search — never both at once.
  if (await isRunActive()) { s.skipped = 'a lead search is running'; return s; }
  const busy = claimTicketmaster('check');
  if (busy) { s.skipped = busy; return s; }

  try {
    resetTicketmasterCallBudget();
    const only = opts.onlyWatchId ?? null;

    // 1. Acts for watches never looked up (or Ticketmaster was down last
    //    time), and 'unknown' ones due their monthly look-up.
    const pending = await query(
      `SELECT bw.id FROM band_watches bw
         JOIN organisations o ON o.id = bw.organisation_id AND o.is_deleted = false
        WHERE bw.stopped_at IS NULL
          AND (bw.tm_match = 'pending'
               OR (bw.tm_match = 'unknown'
                   AND (bw.tm_looked_up_at IS NULL OR bw.tm_looked_up_at < NOW() - ${UNKNOWN_RETRY_SQL})))
          AND ($2::uuid IS NULL OR bw.id = $2::uuid)
        ORDER BY (bw.tm_match = 'pending') DESC, bw.created_at
        LIMIT $1`,
      [RUN_MATCH_LIMIT, only],
    );
    for (const p of pending.rows) {
      const m = await matchWatch(p.id).catch(() => null);
      if (m === 'auto') s.matched += 1;
      else if (m === 'needs_match') s.needsMatch += 1;
    }

    // 2. The watches due a check.
    const dueSql = opts.manual
      ? `(bw.last_tm_check_at IS NULL OR bw.last_tm_check_at < NOW() - INTERVAL '1 hour')`
      : `(bw.last_tm_check_at IS NULL OR bw.last_tm_check_at < NOW() - ${CHECK_INTERVAL_SQL})`;
    const due = await query(
      `SELECT bw.id, bw.organisation_id, o.name AS org_name, bw.tm_attraction_id, bw.tm_attraction_name,
              bw.last_ticked_by, bw.started_by, bw.last_ticked_job_id, bw.started_from_job_id
         FROM band_watches bw
         JOIN organisations o ON o.id = bw.organisation_id AND o.is_deleted = false
        WHERE bw.stopped_at IS NULL
          AND bw.tm_match IN ('auto', 'confirmed') AND COALESCE(bw.tm_attraction_id, '') <> ''
          AND ($2::uuid IS NULL OR bw.id = $2::uuid)
          AND ($2::uuid IS NOT NULL OR ${dueSql})
        ORDER BY bw.last_tm_check_at NULLS FIRST
        LIMIT $1`,
      [RUN_CHECK_LIMIT, only],
    );

    const minWeeks = Number(await getSystemSetting('lead_lookahead_min_weeks'));
    const floor = ukDatePlus((Number.isFinite(minWeeks) ? minWeeks : 3) * 7);
    const fresh: Array<{ leadId: string; watch: DueWatch }> = [];
    for (const w of due.rows as DueWatch[]) {
      try {
        const r = await checkWatch(w, floor);
        if (!r) { s.failed += 1; continue; }
        s.checked += 1;
        s.tours += r.tours;
        for (const leadId of r.newLeadIds) fresh.push({ leadId, watch: w });
      } catch (err) {
        s.failed += 1;
        console.error('[band-watch] check of watch %s failed:', w.id, err);
      }
    }

    // 3. Score the new leads with their history, then tell people.
    s.newLeads = fresh.length;
    if (fresh.length) {
      try { await scoreLeads(); } catch (err) { console.error('[band-watch] scoring failed:', err); }
      s.bells = await bellNewLeads(fresh);
    }
  } finally {
    releaseTicketmaster('check');
  }
  console.log('[band-watch] check done:', s);
  return s;
}
