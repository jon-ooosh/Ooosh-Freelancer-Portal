/**
 * DVSA MOT history — THE definition (docs/VEHICLE-SALES-SPEC.md §3).
 *
 * Talks to the DVSA MOT History API (https://history.mot.api.gov.uk), keeps the
 * last good response per van in `vehicle_mot_history`, and moves
 * `fleet_vehicles.mot_due` FORWARD when DVSA knows of a later expiry (jon,
 * Sep 2026 — the van passed and nobody typed the new date in). It never moves
 * the date backwards: an earlier DVSA date is shown as a warning only.
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

// ── Read / refresh ─────────────────────────────────────────────────────────

export interface VehicleMotView {
  configured: boolean;
  fetchedAt: string | null;
  lastAttemptAt: string | null;
  lastError: string | null;
  summary: MotSummary | null;
  motDue: string | null;             // OP's current mot_due
  comparison: MotDueComparison;      // after any update
}

/** What the Vehicle Detail MOT section shows. Null if the van doesn't exist. */
export async function getVehicleMot(vehicleId: string): Promise<VehicleMotView | null> {
  const res = await query(
    `SELECT to_char(fv.mot_due, 'YYYY-MM-DD') AS mot_due,
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
  return {
    configured: isDvsaConfigured(),
    fetchedAt: row.fetched_at ? (row.fetched_at as Date).toISOString() : null,
    lastAttemptAt: row.last_attempt_at ? (row.last_attempt_at as Date).toISOString() : null,
    lastError: (row.last_error as string | null) ?? null,
    summary,
    motDue,
    comparison: compareMotDue(motDue, summary?.dvsaMotDue ?? null),
  };
}

/**
 * Fetch from DVSA, store, and move mot_due forward if DVSA is later.
 * A failure is recorded on the row (keeping the last good payload) and
 * rethrown as a DvsaError. `actor` is the user id, or 'dvsa-sync' for the
 * weekly run — audit_log.user_id is NOT NULL.
 */
export async function refreshVehicleMot(vehicleId: string, actor: string): Promise<VehicleMotView | null> {
  const v = await query(
    `SELECT reg, to_char(mot_due, 'YYYY-MM-DD') AS mot_due FROM fleet_vehicles WHERE id = $1`,
    [vehicleId],
  );
  if (!v.rows[0]) return null;
  const reg = v.rows[0].reg as string;
  const ourMotDue = (v.rows[0].mot_due as string | null) ?? null;

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

  const { dvsaMotDue } = parseMotPayload(payload);
  if (compareMotDue(ourMotDue, dvsaMotDue) === 'update') {
    // Guarded on the value we read, so a staff edit in between is never overwritten.
    const upd = await query(
      `UPDATE fleet_vehicles SET mot_due = $1::date
        WHERE id = $2 AND (mot_due IS NULL OR mot_due < $1::date)`,
      [dvsaMotDue, vehicleId],
    );
    if ((upd.rowCount ?? 0) > 0) {
      await query(
        `INSERT INTO audit_log (user_id, entity_type, entity_id, action, previous_values, new_values)
         VALUES ($1, 'fleet_vehicle', $2, 'mot_due_from_dvsa', $3, $4)`,
        [actor, vehicleId, JSON.stringify({ mot_due: ourMotDue }), JSON.stringify({ mot_due: dvsaMotDue })],
      ).catch((err) => console.warn('[dvsa-mot] audit insert failed:', err));
      console.log(`[dvsa-mot] ${reg}: mot_due ${ourMotDue ?? '(none)'} → ${dvsaMotDue} from DVSA`);
    }
  }

  return getVehicleMot(vehicleId);
}

/**
 * Weekly run — every active van, one at a time with a small gap. A failure on
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
