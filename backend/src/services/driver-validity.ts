/**
 * Driver document validity — THE single definition.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * Before Aug 2026 there were six consumers of "is this driver's paperwork
 * valid", split across two families of columns, with four subtly different
 * rules and nothing keeping them in step:
 *
 *   hire-form router        idenfy_check_date+90 / dvla_check_date+30
 *   driver detail pills     idenfy_check_date+90 / dvla_check_date+30
 *   driver detail badge     raw licence_valid_to, DVLA not checked at all
 *   drivers list badge      raw licence_valid_to / raw dvla_valid_until
 *   drivers list SQL        raw licence_valid_to / raw dvla_valid_until
 *   assign picker + gate    raw licence_valid_to / raw dvla_valid_until
 *
 * Neither `dvla_valid_until` nor `licence_valid_to` was editable anywhere in
 * the OP UI, so a staff fix moved the pill and left the gate stale. Job 16291
 * (Peter Christopherson, 19 Aug 2026): green pills on his own page, hard 400
 * out of the assign picker, and no field in the UI that could reconcile them.
 *
 * THE MODEL
 * ---------
 * Humans and the hire form set a FROM date only — the day the document was
 * issued or the check was run, which is the easiest thing to read off a
 * document and unambiguous in a way "valid until" never was. This module
 * derives every expiry from it, and `persistableWindows()` writes those
 * expiries back to the `*_valid_until` columns on EVERY driver write.
 *
 *   group     FROM                  doc's own expiry    derived window
 *   -------   -------------------   -----------------   -------------------------
 *   licence   idenfy_check_date     licence_valid_to    licence_check_valid_until
 *   dvla      dvla_check_date       —                   dvla_valid_until
 *   poa1      poa1_doc_date         —                   poa1_valid_until
 *   poa2      poa2_doc_date         —                   poa2_valid_until
 *   passport  passport_check_date   passport_expiry     passport_valid_until
 *
 * The derived columns stay as real stored columns rather than moving the
 * arithmetic into the app, so the SQL consumers (drivers-list status CASE,
 * assign picker, quick-assign gate) keep working unchanged and simply become
 * correct. => Never write a `*_valid_until` column directly. Set the FROM date
 * and call persistableWindows().
 *
 * INTEGRITY GUARD
 * ---------------
 * A check date with no licence identity behind it is not evidence of anything.
 * When iDenfy DENIES a check it can still return a checkDate with no document
 * data, so the driver row ends up with `idenfy_check_date` set and
 * `licence_issued_by` NULL. The hire-form router already refused to trust that
 * shape; the driver-detail pill did not, and rendered a confident green
 * "16 Nov 2026" for a driver with no licence, no name and no files
 * (manjagoproduction@, 18 Aug 2026). `trusted: false` is how that shape is
 * represented here, and an untrusted licence yields a NULL window everywhere.
 */

/** Ooosh acceptance windows, in days from the FROM date. */
export const VALIDITY_WINDOW_DAYS = {
  licence: 90,
  dvla: 30,
  poa: 90,
  passport: 30,
} as const;

export interface DocWindow {
  /** The FROM date that generated this window (YYYY-MM-DD), or null. */
  from: string | null;
  /** Derived expiry (YYYY-MM-DD), or null when it cannot be derived. */
  until: string | null;
  /** Set when the document's own expiry cut the window short. */
  cappedBy: string | null;
  /** until is present and not in the past. */
  valid: boolean;
  /** False when the underlying record isn't trustworthy — see INTEGRITY GUARD. */
  trusted: boolean;
  /** Human-readable reason when !trusted. */
  untrustedReason: string | null;
}

export interface DriverValidity {
  licence: DocWindow;
  dvla: DocWindow;
  poa1: DocWindow;
  poa2: DocWindow;
  passport: DocWindow;
  isUkDriver: boolean;
}

/** Columns this module reads. Loose typing — callers pass raw pg rows. */
export interface DriverValidityInput {
  idenfy_check_date?: unknown;
  licence_valid_to?: unknown;
  licence_issued_by?: unknown;
  licence_issue_country?: unknown;
  licence_next_check_due?: unknown;
  dvla_check_date?: unknown;
  dvla_valid_until?: unknown;
  poa1_doc_date?: unknown;
  poa1_valid_until?: unknown;
  poa2_doc_date?: unknown;
  poa2_valid_until?: unknown;
  passport_check_date?: unknown;
  passport_expiry?: unknown;
  passport_valid_until?: unknown;
}

const EMPTY_WINDOW: DocWindow = {
  from: null, until: null, cappedBy: null,
  valid: false, trusted: true, untrustedReason: null,
};

/**
 * Coerce anything pg or the hire-form app hands us into YYYY-MM-DD.
 *
 * Handles: pg DATE columns (JS Date objects), `idenfy_check_date` (VARCHAR(50)
 * holding a raw ISO timestamp), and plain date strings. Returns null rather
 * than throwing on junk.
 */
export function toYmd(value: unknown): string | null {
  if (value === null || value === undefined || value === '') return null;
  if (value instanceof Date) {
    if (isNaN(value.getTime())) return null;
    return value.toISOString().slice(0, 10);
  }
  const s = String(value).trim();
  if (!s) return null;
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  const d = new Date(s);
  if (isNaN(d.getTime())) return null;
  const y = d.getUTCFullYear();
  if (y < 1900 || y > 2100) return null;
  return d.toISOString().slice(0, 10);
}

/**
 * Add days to a YYYY-MM-DD in UTC.
 *
 * Deliberately UTC-anchored: constructing a local Date and calling
 * toISOString() shifts the answer by a day under BST, which is how per-day
 * arithmetic has drifted elsewhere in this codebase.
 */
export function addDaysYmd(ymd: string | null, days: number): string | null {
  if (!ymd) return null;
  const [y, m, d] = ymd.split('-').map(Number);
  if (!y || !m || !d) return null;
  const t = Date.UTC(y, m - 1, d) + days * 86400000;
  return new Date(t).toISOString().slice(0, 10);
}

/** Earlier of two YYYY-MM-DD values; null-tolerant. */
function minYmd(a: string | null, b: string | null): string | null {
  if (!a) return b;
  if (!b) return a;
  return a < b ? a : b;
}

/** Today in UTC as YYYY-MM-DD. Comparisons are plain string compares. */
export function todayYmd(): string {
  return new Date().toISOString().slice(0, 10);
}

function buildWindow(opts: {
  from: string | null;
  days: number;
  docExpiry?: string | null;
  trusted?: boolean;
  untrustedReason?: string | null;
  today: string;
}): DocWindow {
  const { from, days, docExpiry = null, today } = opts;
  const trusted = opts.trusted !== false;
  if (!trusted) {
    return {
      from, until: null, cappedBy: null,
      valid: false, trusted: false,
      untrustedReason: opts.untrustedReason || 'Record is not trusted',
    };
  }
  const windowEnd = addDaysYmd(from, days);
  const until = minYmd(windowEnd, docExpiry);
  return {
    from,
    until,
    cappedBy: until && docExpiry && until === docExpiry && until !== windowEnd ? docExpiry : null,
    valid: until !== null && until >= today,
    trusted: true,
    untrustedReason: null,
  };
}

/**
 * Compute every document window for a driver.
 *
 * `today` is injectable so callers can evaluate validity against a hire date
 * rather than now, and so tests are deterministic.
 */
export function computeDriverValidity(
  driver: DriverValidityInput | null | undefined,
  today: string = todayYmd(),
): DriverValidity {
  if (!driver) {
    return {
      licence: { ...EMPTY_WINDOW }, dvla: { ...EMPTY_WINDOW },
      poa1: { ...EMPTY_WINDOW }, poa2: { ...EMPTY_WINDOW },
      passport: { ...EMPTY_WINDOW }, isUkDriver: false,
    };
  }

  const issuedBy = typeof driver.licence_issued_by === 'string'
    ? driver.licence_issued_by.trim() : '';
  const isUkDriver = issuedBy === 'DVLA' || driver.licence_issue_country === 'GB';

  // ── Licence: iDenfy check + 90d, capped at the licence's own expiry ────────
  // Untrusted without a licence identity (see INTEGRITY GUARD above).
  const idenfyCheck = toYmd(driver.idenfy_check_date);
  const licenceExpiry = toYmd(driver.licence_valid_to);
  let licence: DocWindow;
  if (!issuedBy) {
    licence = buildWindow({
      from: idenfyCheck, days: VALIDITY_WINDOW_DAYS.licence, today,
      trusted: false,
      untrustedReason: idenfyCheck
        ? 'Identity check recorded but no licence details came back — re-verification needed'
        : 'No licence check on record',
    });
  } else if (idenfyCheck) {
    licence = buildWindow({
      from: idenfyCheck, days: VALIDITY_WINDOW_DAYS.licence,
      docExpiry: licenceExpiry, today,
    });
  } else {
    // Legacy fallback: licence_next_check_due stores an already-computed expiry.
    const legacy = toYmd(driver.licence_next_check_due);
    licence = {
      from: null, until: legacy, cappedBy: null,
      valid: legacy !== null && legacy >= today,
      trusted: true, untrustedReason: null,
    };
  }

  const dvla = buildWindow({
    from: toYmd(driver.dvla_check_date), days: VALIDITY_WINDOW_DAYS.dvla, today,
  });

  // POA1 and POA2 are fully independent — either may lapse while the other
  // stands. Callers decide whether they need one or both.
  const poa1 = buildWindow({
    from: toYmd(driver.poa1_doc_date), days: VALIDITY_WINDOW_DAYS.poa, today,
  });
  const poa2 = buildWindow({
    from: toYmd(driver.poa2_doc_date), days: VALIDITY_WINDOW_DAYS.poa, today,
  });

  // Passport: checked like the DVLA (check + 30d), capped at the passport's
  // own printed expiry.
  const passport = buildWindow({
    from: toYmd(driver.passport_check_date), days: VALIDITY_WINDOW_DAYS.passport,
    docExpiry: toYmd(driver.passport_expiry), today,
  });

  return { licence, dvla, poa1, poa2, passport, isUkDriver };
}

/**
 * The derived `*_valid_until` values to persist for a driver.
 *
 * Call on every write path that touches a FROM date so the gate columns can
 * never drift from the displayed windows again. Returns plain
 * column -> YYYY-MM-DD|null, ready to fold into an UPDATE.
 */
export function persistableWindows(
  driver: DriverValidityInput,
): Record<string, string | null> {
  const v = computeDriverValidity(driver);
  return {
    licence_check_valid_until: v.licence.trusted ? v.licence.until : null,
    dvla_valid_until: v.dvla.until,
    poa1_valid_until: v.poa1.until,
    poa2_valid_until: v.poa2.until,
    passport_valid_until: v.passport.until,
  };
}

/**
 * Pairs of (derived expiry column, FROM column, window length) that can be
 * reconciled in either direction.
 *
 * The licence pair is deliberately absent: its FROM date is `idenfy_check_date`,
 * which the webhook always writes, and its window is additionally capped by the
 * licence's own expiry — so it is not invertible.
 */
const INVERTIBLE_PAIRS: Array<[derived: string, from: string, days: number]> = [
  ['dvla_valid_until', 'dvla_check_date', VALIDITY_WINDOW_DAYS.dvla],
  ['poa1_valid_until', 'poa1_doc_date', VALIDITY_WINDOW_DAYS.poa],
  ['poa2_valid_until', 'poa2_doc_date', VALIDITY_WINDOW_DAYS.poa],
  ['passport_valid_until', 'passport_check_date', VALIDITY_WINDOW_DAYS.passport],
];

/**
 * Back-compute FROM dates for callers that only know the expiry.
 *
 * Some legacy hire-form paths write an expiry and no check date — e.g. the DVLA
 * processing page posts `dvlaValidUntil: today + 30d` on its own. Without this,
 * such a write would leave the FROM date stale and the next derivation would
 * clobber a perfectly good expiry with an older one. Reconciling the pair here
 * means the model stays coherent whichever end a caller writes to, and the
 * legacy paths keep working untouched.
 *
 * Only fills a FROM date that is ABSENT from the same write — an explicit FROM
 * date always wins.
 */
export function backfillFromDates(
  incoming: Record<string, unknown>,
): Record<string, string | null> {
  const out: Record<string, string | null> = {};
  for (const [derivedCol, fromCol, days] of INVERTIBLE_PAIRS) {
    if (!(derivedCol in incoming)) continue;
    if (fromCol in incoming && incoming[fromCol]) continue;
    const until = toYmd(incoming[derivedCol]);
    if (!until) continue;
    out[fromCol] = addDaysYmd(until, -days);
  }
  return out;
}

/** FROM-date columns. A write touching any of these must re-derive. */
export const VALIDITY_SOURCE_COLUMNS = [
  'idenfy_check_date',
  'licence_valid_to',
  'licence_issued_by',
  'licence_next_check_due',
  'dvla_check_date',
  'poa1_doc_date',
  'poa2_doc_date',
  'passport_check_date',
  'passport_expiry',
] as const;

/** True when a set of columns being written requires re-deriving the windows. */
export function touchesValidity(columns: Iterable<string>): boolean {
  const sources = new Set<string>(VALIDITY_SOURCE_COLUMNS);
  for (const c of columns) if (sources.has(c)) return true;
  return false;
}
