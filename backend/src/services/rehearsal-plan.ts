/**
 * Rehearsal plan — detection intelligence for the Studio Sitter module (Phase A).
 *
 * Pure, read-derived logic. Given a job's HireHop line items + its date window,
 * works out:
 *   - which rehearsal ROOMS are on the job and their FLAVOUR (daytime / evening /
 *     lockout), and whether each needs a studio sitter;
 *   - which EVENINGS need site-wide sitter cover.
 *
 * Load-bearing rules (see docs/REHEARSALS-SPEC.md):
 *   - Classify off the variant stock item; the base room (834/835) is a nested
 *     child component of a variant — ignore it when any variant is present so we
 *     don't double-count. A bare base room with no variant = needs_review.
 *   - Timing gotcha: rehearsals FINISH on the day they finish, NOT 9am the next
 *     morning like vehicles/backline. HireHop's end date carries the 9am-next-
 *     morning rollover, so when the end time is an early-morning rollover the real
 *     last session evening = end_date - 1. (Numan "10–16 Jul 09:00" is really
 *     10th → 22:00 on the 15th.) Sibling to the `return_date +1 buffer` gotcha.
 *
 * No persistence here — the caller attaches the result to hh_derived_flags.
 * Phase B builds the shift table + roster + assignment on top of this.
 */

export type RehearsalFlavour = 'daytime' | 'evening' | 'lockout' | 'base' | 'unknown';

export interface RehearsalRoom {
  room: string;                 // "Room 1" | "Room 2"
  flavour: RehearsalFlavour;
  sitter_needed: boolean;       // evening/lockout ⇒ true; daytime ⇒ false
  list_id: number;
}

export interface RehearsalEvening {
  date: string;                 // YYYY-MM-DD
  sitter_needed: boolean;
}

export interface RehearsalDetail {
  rooms: RehearsalRoom[];
  needs_review: boolean;        // bare base room(s) only — flavour unknown, staff to classify
  sitter_needed: boolean;       // any room on the job needs a sitter
  daytime_only: boolean;        // rooms present, none need a sitter, not needs_review
  first_session_date: string | null;   // YYYY-MM-DD
  last_session_date: string | null;    // YYYY-MM-DD (after the finish-on-the-day rule)
  evenings: RehearsalEvening[];
}

const REHEARSAL_CATEGORY = 450;

// Variant stock items (VIRTUAL) — the real signal for room + flavour + sitter need.
const ROOM_VARIANTS: Record<number, { room: string; flavour: RehearsalFlavour; sitter: boolean }> = {
  851: { room: 'Room 1', flavour: 'lockout', sitter: true },
  853: { room: 'Room 1', flavour: 'daytime', sitter: false },
  854: { room: 'Room 1', flavour: 'evening', sitter: true },
  855: { room: 'Room 2', flavour: 'lockout', sitter: true },
  856: { room: 'Room 2', flavour: 'daytime', sitter: false },
  857: { room: 'Room 2', flavour: 'evening', sitter: true },
};

// Base rooms — nested child components of a variant. Informational only when a
// variant is present; a bare base room (no variant) means staff picked the base
// day-rate item directly and we can't infer the flavour ⇒ needs_review.
const BASE_ROOMS: Record<number, string> = {
  834: 'Room 1',
  835: 'Room 2',
};

/** Minimal line-item shape this module needs (subset of HHLineItem). */
export interface RehearsalLineItem {
  LIST_ID: number;
  CATEGORY_ID: number;
  kind: number;
}

/**
 * Classify the rehearsal rooms on a job from its line items.
 * Applies the base-room-child rule (ignore base rooms when any variant present).
 */
export function classifyRehearsalRooms(items: RehearsalLineItem[]): {
  rooms: RehearsalRoom[];
  needs_review: boolean;
} {
  const rehItems = (items || []).filter(
    (i) => Number(i.CATEGORY_ID) === REHEARSAL_CATEGORY && Number(i.kind) !== 0,
  );

  const variantRooms: RehearsalRoom[] = [];
  const baseRooms: RehearsalRoom[] = [];

  for (const item of rehItems) {
    const listId = Number(item.LIST_ID);
    const variant = ROOM_VARIANTS[listId];
    if (variant) {
      variantRooms.push({
        room: variant.room,
        flavour: variant.flavour,
        sitter_needed: variant.sitter,
        list_id: listId,
      });
      continue;
    }
    const baseRoom = BASE_ROOMS[listId];
    if (baseRoom) {
      baseRooms.push({ room: baseRoom, flavour: 'base', sitter_needed: false, list_id: listId });
    }
  }

  // Variant present ⇒ use variants, ignore base rooms (they're child components).
  if (variantRooms.length > 0) {
    return { rooms: dedupeRooms(variantRooms), needs_review: false };
  }
  // Only bare base room(s) ⇒ can't infer flavour, flag for staff.
  if (baseRooms.length > 0) {
    return { rooms: dedupeRooms(baseRooms), needs_review: true };
  }
  return { rooms: [], needs_review: false };
}

function dedupeRooms(rooms: RehearsalRoom[]): RehearsalRoom[] {
  const seen = new Map<string, RehearsalRoom>();
  for (const r of rooms) {
    const key = `${r.room}|${r.flavour}`;
    if (!seen.has(key)) seen.set(key, r);
  }
  return Array.from(seen.values());
}

/**
 * The finish-on-the-day rule. HireHop end dates are usually entered with the
 * 9am-next-morning convention (like vehicles/backline), so when the end time is
 * an early-morning rollover the true last session evening is the day before.
 *
 * @param endDate    YYYY-MM-DD — the (local) end date from HH
 * @param endHour    0-23 — the (local) end hour from HH
 * @returns YYYY-MM-DD of the true last session evening
 */
export function applyRehearsalEndRule(endDate: string, endHour: number | null): string {
  if (!endDate) return endDate;
  // <= 12:00 is treated as a morning rollover (the job "ends" the next morning).
  if (endHour !== null && endHour <= 12) {
    return addDaysIso(endDate, -1);
  }
  return endDate;
}

/**
 * Expand a date range into one evening per day (inclusive), each carrying the
 * job-level sitter-needed flag (sitter cover is site-wide per evening).
 * Guarded against inverted ranges and runaway spans.
 */
export function deriveRehearsalEvenings(
  firstDate: string | null,
  lastDate: string | null,
  sitterNeeded: boolean,
): RehearsalEvening[] {
  if (!firstDate || !lastDate) return [];
  if (lastDate < firstDate) return [];
  const out: RehearsalEvening[] = [];
  let cursor = firstDate;
  let guard = 0;
  while (cursor <= lastDate && guard < 120) {
    out.push({ date: cursor, sitter_needed: sitterNeeded });
    cursor = addDaysIso(cursor, 1);
    guard++;
  }
  return out;
}

export interface RehearsalDateInfo {
  startDate: string | null;   // YYYY-MM-DD (local)
  endDate: string | null;     // YYYY-MM-DD (local, from HH — pre-rule)
  endHour: number | null;     // 0-23 (local)
}

/**
 * Full plan for a job: rooms + flavour + sitter-needed evenings.
 * `items` = the job's HH line items; `dates` = local start/end extracted from the
 * job (compute the local date/hour in SQL via `AT TIME ZONE 'Europe/London'`).
 */
export function computeRehearsalDetail(
  items: RehearsalLineItem[],
  dates: RehearsalDateInfo,
): RehearsalDetail {
  const { rooms, needs_review } = classifyRehearsalRooms(items);
  const sitterNeeded = rooms.some((r) => r.sitter_needed);
  const firstDate = dates.startDate;
  const lastDate = dates.endDate ? applyRehearsalEndRule(dates.endDate, dates.endHour) : null;
  const evenings = deriveRehearsalEvenings(firstDate, lastDate, sitterNeeded);
  return {
    rooms,
    needs_review,
    sitter_needed: sitterNeeded,
    daytime_only: rooms.length > 0 && !sitterNeeded && !needs_review,
    first_session_date: firstDate,
    last_session_date: lastDate,
    evenings,
  };
}

/** Short human summary for the requirement card notes line. */
export function buildRehearsalSummary(detail: RehearsalDetail | null): string {
  if (!detail || detail.rooms.length === 0) {
    return 'Rehearsal space detected from HireHop items';
  }
  const roomLabel = detail.rooms
    .map((r) => `${r.room}${r.flavour !== 'base' ? ` · ${capitalise(r.flavour)}` : ''}`)
    .join(', ');

  if (detail.needs_review) {
    return `${roomLabel} — confirm daytime/evening (base room booked, flavour unknown)`;
  }
  if (detail.daytime_only) {
    return `${roomLabel} — daytime only, no studio sitter required`;
  }
  const sitterNights = detail.evenings.filter((e) => e.sitter_needed);
  if (sitterNights.length > 0) {
    const first = sitterNights[0].date;
    const last = sitterNights[sitterNights.length - 1].date;
    const range = first === last ? formatShort(first) : `${formatShort(first)}–${formatShort(last)}`;
    return `${roomLabel} — studio sitter needed on ${sitterNights.length} evening${sitterNights.length !== 1 ? 's' : ''} (${range})`;
  }
  return `${roomLabel} — studio sitter needed`;
}

// ── small date helpers (plain YYYY-MM-DD arithmetic, TZ-free) ──────────────

function addDaysIso(iso: string, days: number): string {
  const [y, m, d] = iso.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + days);
  return dt.toISOString().slice(0, 10);
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function formatShort(iso: string): string {
  const [, m, d] = iso.split('-').map(Number);
  return `${d} ${MONTHS[m - 1] ?? '?'}`;
}
function capitalise(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
