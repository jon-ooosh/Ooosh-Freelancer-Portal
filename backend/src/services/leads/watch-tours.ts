/**
 * The band watch's tour and name rules (docs/TOUR-FINDER-SPEC.md §21) — pure,
 * so they can be tested without a database. Used by band-watch.ts.
 */
import { normaliseArtist } from './normalise';

export interface TourDate { date: string; venue: string; city: string; country: string; }

export type UkPosition = 'start' | 'end' | 'both' | 'middle' | 'none';

/** A month with no dates splits two tours. */
export const TOUR_GAP_DAYS = 30;

export const UK_POSITION_TEXT: Record<UkPosition, string> = {
  start: 'starts in the UK',
  end: 'ends in the UK',
  both: 'starts and ends in the UK',
  middle: 'UK dates in the middle',
  none: 'no UK dates',
};

/** Days from a to b (YYYY-MM-DD). */
function dayDiff(a: string, b: string): number {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);
}

/** Split dates (sorted) into tours wherever there is a gap of more than `gapDays`. */
export function groupIntoTours(dates: TourDate[], gapDays = TOUR_GAP_DAYS): TourDate[][] {
  const tours: TourDate[][] = [];
  let current: TourDate[] = [];
  for (const d of dates) {
    const prev = current[current.length - 1];
    if (prev && dayDiff(prev.date, d.date) > gapDays) {
      tours.push(current);
      current = [];
    }
    current.push(d);
  }
  if (current.length) tours.push(current);
  return tours;
}

/** Where a tour's UK dates sit (spec §21.2 item 9). GB is the UK; Ireland is not. */
export function ukPosition(tour: TourDate[]): UkPosition {
  const isUk = (d: TourDate) => d.country === 'GB';
  if (tour.length === 0 || !tour.some(isUk)) return 'none';
  const first = isUk(tour[0]);
  const last = isUk(tour[tour.length - 1]);
  if (first && last) return 'both';
  if (first) return 'start';
  if (last) return 'end';
  return 'middle';
}

/** A company ending a band's invoice name carries but its stage name doesn't. */
const LEGAL_SUFFIX = /[\s,.-]+(ltd|limited|llp|plc|inc|incorporated|llc|gmbh|pty)\.?\s*$/i;

/**
 * The names to look a band up by on Ticketmaster. An org is often the band's
 * company ("Skindred LLP", "Brother Strut Limited", "TENDER / Bad Balloon Ltd"),
 * which Ticketmaster has never heard of: drop the company endings and try each
 * side of " / " (spaces required, so "AC/DC" stays whole). Nothing to drop →
 * just the name. At most three names, no duplicates.
 */
export function actSearchNames(orgName: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const part of orgName.split(/\s+\/\s+/)) {
    let n = part.trim();
    for (let i = 0; i < 3 && LEGAL_SUFFIX.test(n); i++) n = n.replace(LEGAL_SUFFIX, '').trim();
    const key = normaliseArtist(n);
    if (key.length < 2 || seen.has(key)) continue;
    seen.add(key);
    out.push(n);
  }
  const trimmed = orgName.trim();
  return (out.length ? out : [trimmed]).slice(0, 3);
}

