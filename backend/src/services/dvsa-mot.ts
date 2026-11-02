/**
 * DVSA MOT history — THE definition (docs/VEHICLE-SALES-SPEC.md §3).
 *
 * Talks to the DVSA MOT History API (https://history.mot.api.gov.uk), keeps the
 * last good response per van in `vehicle_mot_history`, and makes DVSA's MOT
 * expiry THE `fleet_vehicles.mot_due` (jon, 14 Oct 2026 — one system-derived
 * date on the board, the overview and the van's page; the safety check against
 * a junk or ten-years-ahead date is the point). `decideMotDue()` is the rule:
 * whenever DVSA has a date, DVSA's date wins — a typed date only lasts until
 * the next check, flagged meanwhile. Never "keep the later one": a date later
 * than the real expiry makes the compliance alert fire late (jon, 14 Oct 2026).
 * Refreshed daily at 07:30, before the 08:00 compliance check.
 *
 * Auth is OAuth 2.0 client credentials via Microsoft Entra ID, plus an API key
 * header. All five values come from the DVSA registration email and live in
 * .env (secrets, not staff-editable config):
 *   DVSA_CLIENT_ID, DVSA_CLIENT_SECRET, DVSA_SCOPE, DVSA_TOKEN_URL, DVSA_API_KEY
 *
 * The client secret expires every 2 years. DVSA emails 30 and 14 days before,
 * so OP doesn't remind — but a rejected credential is reported in plain words
 * rather than as a generic failure.
 *
 * MOT odometer readings are deliberately NOT written to vehicle_mileage_log:
 * many pre-date our ownership, and the log's first/last readings drive the
 * average daily mileage and the Forecast tab's mileage pace.
 */
import { query } from '../config/database';
import { fullDisplayName } from './display-name';
import { retireDoneBells } from './notification-resolve';

const DVSA_API_BASE = 'https://history.mot.api.gov.uk';
const REQUEST_TIMEOUT_MS = 20_000;

// ── Config ─────────────────────────────────────────────────────────────────

interface DvsaConfig {
  clientId: string;
  clientSecret: string;
  scope: string;
  tokenUrl: string;
  apiKey: string;
}

function readConfig(): DvsaConfig | null {
  // Trimmed: a stray space or line-end pasted into .env makes DVSA refuse
  // the value with nothing to show for it.
  const env = (k: string) => process.env[k]?.trim() || undefined;
  const clientId = env('DVSA_CLIENT_ID');
  const clientSecret = env('DVSA_CLIENT_SECRET');
  const scope = env('DVSA_SCOPE');
  const tokenUrl = env('DVSA_TOKEN_URL');
  const apiKey = env('DVSA_API_KEY');
  if (!clientId || !clientSecret || !scope || !tokenUrl || !apiKey) return null;
  return { clientId, clientSecret, scope, tokenUrl, apiKey };
}

export function isDvsaConfigured(): boolean {
  return readConfig() !== null;
}

// ── Errors ─────────────────────────────────────────────────────────────────

export type DvsaErrorKind = 'not_configured' | 'auth' | 'not_found' | 'rate_limited' | 'failed';

export class DvsaError extends Error {
  /** A short, secret-free reason from DVSA / Entra (e.g. "AADSTS7000222 — the client
   *  secret has expired"), shown to staff after the plain sentence. */
  constructor(public kind: DvsaErrorKind, message: string, public detail: string | null = null) {
    super(message);
    this.name = 'DvsaError';
  }
}

/** The Entra codes worth naming in plain words — the rest show as the raw code. */
const ENTRA_CODES: Record<string, string> = {
  AADSTS7000222: 'the client secret has expired',
  AADSTS7000215: 'the client secret is wrong',
  AADSTS700016: 'the client ID is not recognised',
  AADSTS90002: 'the tenant in DVSA_TOKEN_URL is not recognised',
  AADSTS70011: 'DVSA_SCOPE is not valid',
  AADSTS1002012: 'DVSA_SCOPE is not valid',
};

/** Pull the Entra error code out of a token-endpoint error body. Pure. */
export function entraErrorDetail(body: string): string | null {
  const code = body.match(/AADSTS\d+/)?.[0];
  if (code) return ENTRA_CODES[code] ? `${code} — ${ENTRA_CODES[code]}` : code;
  try {
    const err = (JSON.parse(body) as { error?: unknown }).error;
    return typeof err === 'string' ? err : null;
  } catch {
    return null;
  }
}

/** The plain sentence, plus DVSA's own reason when we have one. */
export function explainDvsaError(err: unknown): string {
  if (!(err instanceof DvsaError)) return describeDvsaError('failed');
  return err.detail ? `${describeDvsaError(err.kind)} (DVSA said: ${err.detail})` : describeDvsaError(err.kind);
}

/** The sentence staff see in the MOT history section. */
export function describeDvsaError(kind: DvsaErrorKind): string {
  switch (kind) {
    case 'not_configured':
      return 'DVSA is not set up on this server (DVSA_* settings missing from .env).';
    case 'auth':
      return 'DVSA rejected our credentials — the client secret may have expired, or one of the DVSA_* values in .env is wrong.';
    case 'not_found':
      return 'DVSA has no record of this registration.';
    case 'rate_limited':
      return 'DVSA is limiting our requests right now — try again later.';
    default:
      return 'Could not reach DVSA — try again later.';
  }
}

// ── Token (cached in memory, ~60 min life) ─────────────────────────────────

let cachedToken: { token: string; expiresAt: number } | null = null;

async function getAccessToken(cfg: DvsaConfig): Promise<string> {
  // Refresh a minute early so a token never expires mid-request.
  if (cachedToken && cachedToken.expiresAt - 60_000 > Date.now()) return cachedToken.token;

  let resp: Response;
  try {
    resp = await fetch(cfg.tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: cfg.clientId,
        client_secret: cfg.clientSecret,
        scope: cfg.scope,
      }).toString(),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (err) {
    throw new DvsaError('failed', `DVSA token request failed: ${(err as Error).message}`);
  }

  if (!resp.ok) {
    const body = await resp.text().catch(() => '');
    // Entra answers a bad/expired secret with 400/401 (invalid_client).
    const kind: DvsaErrorKind = resp.status === 400 || resp.status === 401 ? 'auth' : 'failed';
    throw new DvsaError(kind, `DVSA token request returned ${resp.status}: ${body.slice(0, 300)}`, entraErrorDetail(body));
  }

  const json = (await resp.json()) as { access_token?: string; expires_in?: number | string };
  if (!json.access_token) throw new DvsaError('auth', 'DVSA token response had no access_token');
  const lifeSeconds = Number(json.expires_in) || 3600;
  cachedToken = { token: json.access_token, expiresAt: Date.now() + lifeSeconds * 1000 };
  return cachedToken.token;
}

// ── Lookup ─────────────────────────────────────────────────────────────────

/** "RX 21 abc" → "RX21ABC" — the form DVSA's path expects. */
export function normaliseReg(reg: string): string {
  return reg.replace(/\s+/g, '').toUpperCase();
}

/**
 * Raw DVSA response for one registration. Retries once with a fresh token on
 * 401/403 (a token revoked early), then gives up with a typed error.
 */
export async function fetchMotHistoryByReg(reg: string): Promise<unknown> {
  const cfg = readConfig();
  if (!cfg) throw new DvsaError('not_configured', 'DVSA credentials are not configured');

  const url = `${DVSA_API_BASE}/v1/trade/vehicles/registration/${encodeURIComponent(normaliseReg(reg))}`;

  for (let attempt = 0; attempt < 2; attempt++) {
    const token = await getAccessToken(cfg);
    let resp: Response;
    try {
      resp = await fetch(url, {
        headers: {
          Authorization: `Bearer ${token}`,
          'X-API-Key': cfg.apiKey,
          Accept: 'application/json',
        },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (err) {
      throw new DvsaError('failed', `DVSA request failed: ${(err as Error).message}`);
    }

    if (resp.ok) return resp.json();

    if ((resp.status === 401 || resp.status === 403) && attempt === 0) {
      cachedToken = null; // try once more with a fresh token
      continue;
    }
    const body = await resp.text().catch(() => '');
    const kind: DvsaErrorKind =
      resp.status === 404 ? 'not_found'
        : resp.status === 429 ? 'rate_limited'
        : resp.status === 401 || resp.status === 403 ? 'auth'
        : 'failed';
    const apiErr = (() => {
      try { return JSON.parse(body) as { errorCode?: unknown; errorMessage?: unknown }; } catch { return {}; }
    })();
    // DVSA's own words, e.g. "MOTH-FB-03: Your API key is invalid".
    const apiDetail = [apiErr.errorCode, apiErr.errorMessage]
      .filter((x): x is string => typeof x === 'string' && x.trim() !== '').join(': ') || null;
    const detail = kind === 'auth'
      ? `${apiDetail ?? `HTTP ${resp.status}`} — the login worked, so check DVSA_API_KEY`
      : apiDetail;
    throw new DvsaError(kind, `DVSA returned ${resp.status}: ${body.slice(0, 300)}`, detail);
  }
  // Unreachable — the loop either returns or throws.
  throw new DvsaError('failed', 'DVSA request failed');
}

// ── Parsing (pure) ─────────────────────────────────────────────────────────

export interface MotDefect {
  type: string | null;       // ADVISORY, MINOR, MAJOR, DANGEROUS, FAIL, …
  text: string | null;
  dangerous: boolean;
}

export interface MotTest {
  completedDate: string | null;   // ISO date-time
  result: 'PASSED' | 'FAILED' | string;
  expiryDate: string | null;      // YYYY-MM-DD
  odometer: number | null;
  odometerUnit: 'MI' | 'KM' | null;
  odometerResultType: string | null;
  testNumber: string | null;
  location: string | null;        // CVS tests only
  defects: MotDefect[];
}

export interface MotSummary {
  make: string | null;
  model: string | null;
  hasOutstandingRecall: string | null;   // Yes / No / Unknown / Unavailable
  tests: MotTest[];                      // newest first
  /** The date the current MOT runs out, per DVSA: latest PASSED test's expiry,
   *  or — for a van too new to have had one — the first MOT due date. */
  dvsaMotDue: string | null;
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v.trim() !== '' ? v.trim() : null;
}

/** YYYY-MM-DD, or null — DVSA dates are already in this form; guard anyway. */
function isoDate(v: unknown): string | null {
  const s = str(v);
  return s && /^\d{4}-\d{2}-\d{2}/.test(s) ? s.slice(0, 10) : null;
}

export function parseMotPayload(payload: unknown): MotSummary {
  const p = (payload && typeof payload === 'object' ? payload : {}) as Record<string, unknown>;
  const rawTests = Array.isArray(p.motTests) ? p.motTests : [];

  const tests: MotTest[] = rawTests
    .filter((t): t is Record<string, unknown> => !!t && typeof t === 'object')
    .map((t): MotTest => {
      const odo = str(t.odometerValue);
      const odoNum = odo != null && /^\d+$/.test(odo) ? Number(odo) : null;
      const unit = str(t.odometerUnit);
      return {
        completedDate: str(t.completedDate),
        result: str(t.testResult) ?? 'UNKNOWN',
        expiryDate: isoDate(t.expiryDate),
        odometer: odoNum,
        odometerUnit: unit === 'MI' || unit === 'KM' ? unit : null,
        odometerResultType: str(t.odometerResultType),
        testNumber: str(t.motTestNumber),
        location: str(t.location),
        defects: (Array.isArray(t.defects) ? t.defects : [])
          .filter((d): d is Record<string, unknown> => !!d && typeof d === 'object')
          .map((d) => ({
            type: str(d.type),
            text: str(d.text),
            dangerous: d.dangerous === true || str(d.type) === 'DANGEROUS',
          })),
      };
    })
    .sort((a, b) => (b.completedDate ?? '').localeCompare(a.completedDate ?? ''));

  // Latest expiry among PASSED tests. A failed test's expiryDate (if any) is
  // not a valid MOT; a retest pass carries its own expiry.
  const passExpiries = tests
    .filter((t) => t.result === 'PASSED' && t.expiryDate)
    .map((t) => t.expiryDate as string)
    .sort();
  const dvsaMotDue = passExpiries.length > 0
    ? passExpiries[passExpiries.length - 1]
    : isoDate(p.motTestDueDate);

  return {
    make: str(p.make),
    model: str(p.model),
    hasOutstandingRecall: str(p.hasOutstandingRecall),
    tests,
    dvsaMotDue,
  };
}

/**
 * What to do with `mot_due` given DVSA's date (Q3):
 *   'update'  — DVSA is later, or we have no date → move ours forward
 *   'earlier' — DVSA is earlier → warn only, never move a date backwards
 *   'same' / 'none' (DVSA has no date) → nothing
 */
export type MotDueComparison = 'update' | 'earlier' | 'same' | 'none';

export function compareMotDue(ourMotDue: string | null, dvsaMotDue: string | null): MotDueComparison {
  if (!dvsaMotDue) return 'none';
  if (!ourMotDue) return 'update';
  if (dvsaMotDue > ourMotDue) return 'update';
  if (dvsaMotDue < ourMotDue) return 'earlier';
  return 'same';
}

/**
 * THE rule for `fleet_vehicles.mot_due` given DVSA's date (VEHICLE-SALES-SPEC §16–17).
 * Pure.
 *   - DVSA has no date (never fetched, unknown reg) → keep ours as it is.
 *   - DVSA has a date → DVSA's date, either direction, whoever typed ours.
 *
 * A date typed by hand therefore only stands until the next check (daily
 * 07:30), flagged "Manual" meanwhile. Erring early is the safe direction: the
 * worst a stale DVSA date does after a fresh pass is a day of "MOT due" noise,
 * while a typed date later than the real expiry would hide an expired MOT.
 */
export type MotDueSource = 'dvsa' | 'manual';

export interface MotDueDecision {
  motDue: string | null;            // what mot_due should be
  source: MotDueSource | null;      // what mot_due_source should be
  changed: boolean;                 // mot_due moves
}

export function decideMotDue(
  ourMotDue: string | null,
  ourSource: MotDueSource | null,
  dvsaMotDue: string | null,
): MotDueDecision {
  if (!dvsaMotDue) {
    return { motDue: ourMotDue, source: ourSource, changed: false };
  }
  return { motDue: dvsaMotDue, source: 'dvsa', changed: ourMotDue !== dvsaMotDue };
}

/** The bits of the latest test the fleet board shows. Pure. */
export function latestTestSummary(summary: MotSummary): {
  advisories: number | null; result: string | null; testedOn: string | null;
} {
  const latest = summary.tests[0];
  if (!latest) return { advisories: null, result: null, testedOn: null };
  const advisories = latest.defects.filter(isAdvisory).length;
  return {
    advisories,
    result: latest.result === 'PASSED' || latest.result === 'FAILED' ? latest.result : null,
    testedOn: latest.completedDate && /^\d{4}-\d{2}-\d{2}/.test(latest.completedDate) ? latest.completedDate.slice(0, 10) : null,
  };
}

// ── Advisory marks (VEHICLE-SALES-SPEC §18) ────────────────────────────────
//
// DVSA's record can't be changed, so staff record what WE did about each
// advisory / minor item on the LATEST test: 'done' or 'noted', with an optional
// note and who/when. A mark belongs to one test, so a new MOT starts its
// advisories open again. The fleet board's chip counts only unmarked ones.

export type AdvisoryState = 'done' | 'noted';

export interface AdvisoryMark {
  defectKey: string;
  state: AdvisoryState;
  note: string | null;
  markedBy: string | null;   // display name
  markedAt: string;          // ISO
}

/** The defects that can be ticked off — the same ones the chip counts. Pure. */
export function isAdvisory(d: MotDefect): boolean {
  return d.type === 'ADVISORY' || d.type === 'MINOR';
}

/** What a mark hangs on: DVSA's test number, else the test's date. Pure. */
export function motTestKey(t: MotTest): string | null {
  return t.testNumber ?? (t.completedDate ? `date:${t.completedDate}` : null);
}

/**
 * One key per defect on the test, in order — null for anything that isn't an
 * advisory. "TYPE|text#n", n counting identical items so two "tyre worn"
 * advisories on one test are two keys. Pure.
 */
export function advisoryKeys(t: MotTest): Array<string | null> {
  const seen = new Map<string, number>();
  return t.defects.map((d) => {
    if (!isAdvisory(d)) return null;
    const base = `${d.type}|${(d.text ?? '').trim()}`;
    const n = (seen.get(base) ?? 0) + 1;
    seen.set(base, n);
    return `${base}#${n}`;
  });
}

async function readLatestTest(vehicleId: string): Promise<MotTest | null> {
  const res = await query(`SELECT payload FROM vehicle_mot_history WHERE vehicle_id = $1`, [vehicleId]);
  const payload = res.rows[0]?.payload;
  return payload ? parseMotPayload(payload).tests[0] ?? null : null;
}

async function readMarks(vehicleId: string, testKey: string): Promise<AdvisoryMark[]> {
  const res = await query(
    `SELECT m.defect_key, m.state, m.note, m.marked_at,
            p.first_name, p.last_name, p.preferred_name, u.email
       FROM vehicle_mot_advisory_marks m
       LEFT JOIN users u ON u.id = m.marked_by
       LEFT JOIN people p ON p.id = u.person_id
      WHERE m.vehicle_id = $1 AND m.test_key = $2`,
    [vehicleId, testKey],
  );
  return res.rows.map((r) => ({
    defectKey: r.defect_key as string,
    state: r.state as AdvisoryState,
    note: (r.note as string | null) ?? null,
    markedBy: fullDisplayName(r) || null,
    markedAt: (r.marked_at as Date).toISOString(),
  }));
}

/**
 * fleet_vehicles.dvsa_advisories_open — the latest test's advisories with no
 * mark. The ONLY writer of that column; run after a refresh and every mark.
 */
export async function recountOpenAdvisories(vehicleId: string): Promise<void> {
  const latest = await readLatestTest(vehicleId);
  const key = latest ? motTestKey(latest) : null;
  if (!latest || !key) {
    await query(`UPDATE fleet_vehicles SET dvsa_advisories_open = dvsa_advisories WHERE id = $1`, [vehicleId]);
    return;
  }
  const keys = advisoryKeys(latest).filter((k): k is string => k !== null);
  const marked = new Set((await readMarks(vehicleId, key)).map((m) => m.defectKey));
  const open = keys.filter((k) => !marked.has(k)).length;
  await query(`UPDATE fleet_vehicles SET dvsa_advisories_open = $2 WHERE id = $1`, [vehicleId, open]);
}

export type MarkAdvisoryResult = 'ok' | 'no_history' | 'test_changed' | 'unknown_advisory';

/**
 * Mark one advisory on the latest test done / noted, or clear the mark
 * (state null). `testKey` is the test the person was looking at — if DVSA has
 * a newer test since, nothing is written ('test_changed'). Audited either way.
 */
export async function markAdvisory(
  vehicleId: string,
  input: { testKey: string; defectKey: string; state: AdvisoryState | null; note: string | null },
  actor: string,
): Promise<MarkAdvisoryResult> {
  const latest = await readLatestTest(vehicleId);
  const key = latest ? motTestKey(latest) : null;
  if (!latest || !key) return 'no_history';
  if (key !== input.testKey) return 'test_changed';
  if (!advisoryKeys(latest).includes(input.defectKey)) return 'unknown_advisory';

  const before = await query(
    `SELECT state, note FROM vehicle_mot_advisory_marks WHERE vehicle_id = $1 AND test_key = $2 AND defect_key = $3`,
    [vehicleId, key, input.defectKey],
  );
  if (input.state) {
    await query(
      `INSERT INTO vehicle_mot_advisory_marks (vehicle_id, test_key, defect_key, state, note, marked_by)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (vehicle_id, test_key, defect_key) DO UPDATE
         SET state = EXCLUDED.state, note = EXCLUDED.note, marked_by = EXCLUDED.marked_by, marked_at = NOW()`,
      [vehicleId, key, input.defectKey, input.state, input.note, actor],
    );
  } else {
    await query(
      `DELETE FROM vehicle_mot_advisory_marks WHERE vehicle_id = $1 AND test_key = $2 AND defect_key = $3`,
      [vehicleId, key, input.defectKey],
    );
  }
  await query(
    `INSERT INTO audit_log (user_id, entity_type, entity_id, action, previous_values, new_values)
     VALUES ($1, 'fleet_vehicle', $2, $3, $4, $5)`,
    [actor, vehicleId, input.state ? 'mot_advisory_marked' : 'mot_advisory_cleared',
      JSON.stringify({ test_key: key, defect_key: input.defectKey, ...(before.rows[0] ?? {}) }),
      JSON.stringify(input.state ? { state: input.state, note: input.note } : {})],
  ).catch((err) => console.warn('[dvsa-mot] audit insert failed:', err));

  await recountOpenAdvisories(vehicleId);
  return 'ok';
}

// ── Read / refresh ─────────────────────────────────────────────────────────

export interface VehicleMotView {
  configured: boolean;
  fetchedAt: string | null;
  lastAttemptAt: string | null;
  lastError: string | null;
  summary: MotSummary | null;
  motDue: string | null;             // OP's current mot_due
  motDueSource: MotDueSource | null;
  comparison: MotDueComparison;      // after any update — 'earlier' = a later typed date, until the next check
  /** The latest test's key and its advisory marks (§18). */
  latestTestKey: string | null;
  advisoryMarks: AdvisoryMark[];
}

/** What the Vehicle Detail MOT section shows. Null if the van doesn't exist. */
export async function getVehicleMot(vehicleId: string): Promise<VehicleMotView | null> {
  const res = await query(
    `SELECT to_char(fv.mot_due, 'YYYY-MM-DD') AS mot_due, fv.mot_due_source,
            h.payload, h.fetched_at, h.last_attempt_at, h.last_error
       FROM fleet_vehicles fv
       LEFT JOIN vehicle_mot_history h ON h.vehicle_id = fv.id
      WHERE fv.id = $1`,
    [vehicleId],
  );
  const row = res.rows[0];
  if (!row) return null;

  const summary = row.payload ? parseMotPayload(row.payload) : null;
  const motDue = (row.mot_due as string | null) ?? null;
  const latestTestKey = summary?.tests[0] ? motTestKey(summary.tests[0]) : null;
  return {
    configured: isDvsaConfigured(),
    fetchedAt: row.fetched_at ? (row.fetched_at as Date).toISOString() : null,
    lastAttemptAt: row.last_attempt_at ? (row.last_attempt_at as Date).toISOString() : null,
    lastError: (row.last_error as string | null) ?? null,
    summary,
    motDue,
    motDueSource: (row.mot_due_source as MotDueSource | null) ?? null,
    comparison: compareMotDue(motDue, summary?.dvsaMotDue ?? null),
    latestTestKey,
    advisoryMarks: latestTestKey ? await readMarks(vehicleId, latestTestKey) : [],
  };
}

/**
 * Fetch from DVSA, store, cache the summary on the van, and set mot_due by
 * decideMotDue().
 * A failure is recorded on the row (keeping the last good payload) and
 * rethrown as a DvsaError. `actor` is the user id, or 'dvsa-sync' for the
 * daily run — audit_log.user_id is NOT NULL.
 */
export async function refreshVehicleMot(vehicleId: string, actor: string): Promise<VehicleMotView | null> {
  const v = await query(
    `SELECT reg, to_char(mot_due, 'YYYY-MM-DD') AS mot_due, mot_due_source FROM fleet_vehicles WHERE id = $1`,
    [vehicleId],
  );
  if (!v.rows[0]) return null;
  const reg = v.rows[0].reg as string;
  const ourMotDue = (v.rows[0].mot_due as string | null) ?? null;
  const ourSource = (v.rows[0].mot_due_source as MotDueSource | null) ?? null;

  let payload: unknown;
  try {
    payload = await fetchMotHistoryByReg(reg);
  } catch (err) {
    console.warn(`[dvsa-mot] ${reg}: ${(err as Error).message}`);
    await query(
      `INSERT INTO vehicle_mot_history (vehicle_id, last_attempt_at, last_error)
       VALUES ($1, NOW(), $2)
       ON CONFLICT (vehicle_id) DO UPDATE
         SET last_attempt_at = NOW(), last_error = EXCLUDED.last_error`,
      [vehicleId, explainDvsaError(err)],
    );
    throw err instanceof DvsaError ? err : new DvsaError('failed', (err as Error).message);
  }

  await query(
    `INSERT INTO vehicle_mot_history (vehicle_id, payload, fetched_at, last_attempt_at, last_error)
     VALUES ($1, $2, NOW(), NOW(), NULL)
     ON CONFLICT (vehicle_id) DO UPDATE
       SET payload = EXCLUDED.payload, fetched_at = NOW(), last_attempt_at = NOW(), last_error = NULL`,
    [vehicleId, JSON.stringify(payload)],
  );

  const summary = parseMotPayload(payload);
  const latest = latestTestSummary(summary);
  await query(
    `UPDATE fleet_vehicles
        SET dvsa_mot_due = $2::date, dvsa_advisories = $3, dvsa_recall = $4,
            dvsa_latest_result = $5, dvsa_latest_test_on = $6::date, dvsa_checked_at = NOW()
      WHERE id = $1`,
    [vehicleId, summary.dvsaMotDue, latest.advisories, summary.hasOutstandingRecall, latest.result, latest.testedOn],
  );
  // A new test starts its advisories open again; marks on the old one stay as a record.
  await recountOpenAdvisories(vehicleId);

  const decision = decideMotDue(ourMotDue, ourSource, summary.dvsaMotDue);
  // Guarded on the values we read, so a staff edit in between is never overwritten.
  const upd = await query(
    `UPDATE fleet_vehicles SET mot_due = $2::date, mot_due_source = $3
      WHERE id = $1 AND mot_due IS NOT DISTINCT FROM $4::date
        AND mot_due_source IS NOT DISTINCT FROM $5`,
    [vehicleId, decision.motDue, decision.source, ourMotDue, ourSource],
  );
  if (decision.changed && (upd.rowCount ?? 0) > 0) {
    await query(
      `INSERT INTO audit_log (user_id, entity_type, entity_id, action, previous_values, new_values)
       VALUES ($1, 'fleet_vehicle', $2, 'mot_due_from_dvsa', $3, $4)`,
      [actor, vehicleId, JSON.stringify({ mot_due: ourMotDue, mot_due_source: ourSource }),
        JSON.stringify({ mot_due: decision.motDue, mot_due_source: decision.source })],
    ).catch((err) => console.warn('[dvsa-mot] audit insert failed:', err));
    console.log(`[dvsa-mot] ${reg}: mot_due ${ourMotDue ?? '(none)'} → ${decision.motDue} from DVSA`);
    // A new MOT may finish the van's "MOT due" bell.
    await retireDoneBells('compliance_mot', vehicleId);
  }

  return getVehicleMot(vehicleId);
}

/**
 * "Use DVSA date" — a person settles a flagged manual date in DVSA's favour.
 * Returns false when there is no DVSA date to use.
 */
export async function useDvsaMotDue(vehicleId: string, actor: string): Promise<boolean> {
  const before = await query(
    `SELECT to_char(mot_due, 'YYYY-MM-DD') AS mot_due, mot_due_source,
            to_char(dvsa_mot_due, 'YYYY-MM-DD') AS dvsa_mot_due
       FROM fleet_vehicles WHERE id = $1`,
    [vehicleId],
  );
  const r = before.rows[0];
  if (!r || !r.dvsa_mot_due) return false;
  await query(
    `UPDATE fleet_vehicles SET mot_due = dvsa_mot_due, mot_due_source = 'dvsa' WHERE id = $1`,
    [vehicleId],
  );
  await query(
    `INSERT INTO audit_log (user_id, entity_type, entity_id, action, previous_values, new_values)
     VALUES ($1, 'fleet_vehicle', $2, 'mot_due_use_dvsa', $3, $4)`,
    [actor, vehicleId, JSON.stringify({ mot_due: r.mot_due, mot_due_source: r.mot_due_source }),
      JSON.stringify({ mot_due: r.dvsa_mot_due, mot_due_source: 'dvsa' })],
  ).catch((err) => console.warn('[dvsa-mot] audit insert failed:', err));
  await retireDoneBells('compliance_mot', vehicleId);
  return true;
}

/**
 * A manual edit to mot_due (Key Dates, an MOT service record). Typing DVSA's
 * own date counts as DVSA's; anything else is 'manual' and decideMotDue()
 * takes it from there on the next refresh.
 */
export async function markMotDueEdited(vehicleId: string): Promise<void> {
  await query(
    `UPDATE fleet_vehicles
        SET mot_due_source = CASE WHEN mot_due IS NOT NULL AND mot_due = dvsa_mot_due THEN 'dvsa' ELSE 'manual' END
      WHERE id = $1`,
    [vehicleId],
  );
}

let refreshAllRunning = false;

/**
 * "Refresh all from DVSA" (admin, fleet board). Runs in the background — one
 * van every 1.5 s — and refuses to start a second run on top of the first.
 */
export function startRefreshAll(): boolean {
  if (refreshAllRunning) return false;
  refreshAllRunning = true;
  void runScheduledMotRefresh()
    .then((r) => console.log(`[dvsa-mot] refresh-all — ${r.done} done, ${r.failed} failed${r.stopped ? `, stopped (${r.stopped})` : ''}`))
    .catch((err) => console.error('[dvsa-mot] refresh-all failed:', err))
    .finally(() => { refreshAllRunning = false; });
  return true;
}

/**
 * Daily run — every active van, one at a time with a small gap. A failure on
 * one van is recorded and skipped. Stops early on a credential failure: every
 * later van would fail the same way.
 */
export async function runScheduledMotRefresh(): Promise<{ done: number; failed: number; stopped: string | null }> {
  if (!isDvsaConfigured()) {
    console.warn('[dvsa-mot] scheduled run skipped — DVSA_* not configured');
    return { done: 0, failed: 0, stopped: 'not_configured' };
  }
  const res = await query(
    `SELECT id FROM fleet_vehicles
      WHERE is_active = true AND COALESCE(fleet_group, '') <> 'old_sold'
      ORDER BY reg`,
  );
  let done = 0, failed = 0;
  for (const r of res.rows) {
    try {
      await refreshVehicleMot(r.id as string, 'dvsa-sync');
      done++;
    } catch (err) {
      failed++;
      if (err instanceof DvsaError && (err.kind === 'auth' || err.kind === 'rate_limited')) {
        return { done, failed, stopped: err.kind };
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 1500));
  }
  return { done, failed, stopped: null };
}
