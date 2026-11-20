/**
 * Wise (TransferWise) API client — scaffolding for supplier bill payments.
 *
 * Single gateway for ALL Wise API communication (same pattern as the Stripe /
 * Xero / HireHop brokers): auth, base-URL switching, timeout, and error
 * surfacing live here so the (eventual) SCA request-signing lives in ONE place.
 * See docs/COSTS-PAYMENT-AUTOMATION-SPEC.md (Part 2).
 *
 * This first cut is READ-ONLY — a health/profile check to prove connectivity in
 * the sandbox. No money moves. The create-recipient → quote → transfer flow
 * lands once connectivity is confirmed.
 *
 * Required env vars:
 *   WISE_API_TOKEN  — personal API token (sandbox token for the spike; the live
 *                     token only when we go live, locked to the server IP).
 *   WISE_ENV        — 'sandbox' (default) | 'live'. Picks the API base URL.
 *   WISE_PROFILE_ID — optional; the business profile id. If unset, the health
 *                     check discovers it from GET /v1/profiles.
 *
 * Sandbox is a SEPARATE account (register at sandbox.transferwise.tech) — a live
 * token can't be used against sandbox and vice versa.
 */

const WISE_LIVE_BASE = 'https://api.transferwise.com';
const WISE_SANDBOX_BASE = 'https://api.sandbox.transferwise.tech';

export function isWiseConfigured(): boolean {
  return Boolean(process.env.WISE_API_TOKEN);
}

export function wiseEnv(): 'sandbox' | 'live' {
  return process.env.WISE_ENV === 'live' ? 'live' : 'sandbox';
}

export function wiseBaseUrl(): string {
  return wiseEnv() === 'live' ? WISE_LIVE_BASE : WISE_SANDBOX_BASE;
}

export class WiseApiError extends Error {
  constructor(public status: number, message: string, public detail?: unknown) {
    super(message);
    this.name = 'WiseApiError';
  }
}

/**
 * Low-level authenticated request to the Wise API. Throws WiseApiError on a
 * non-2xx response or network/timeout failure. Callers should guard with
 * isWiseConfigured() first (or be ready for the thrown "not configured" error).
 *
 * NOTE: funding a transfer (the final money-movement step) is restricted on a
 * standard API token by PSD2 — see the spec. This helper is fine for everything
 * up to and including creating transfers; auto-funding needs the SCA-signed flow
 * (added later, gated behind Wise enabling API funding for the account).
 */
export async function wiseFetch<T = unknown>(
  method: string,
  path: string,
  opts: { query?: Record<string, string | number>; body?: unknown; timeoutMs?: number } = {},
): Promise<T> {
  const token = process.env.WISE_API_TOKEN;
  if (!token) {
    throw new WiseApiError(503, 'WISE_API_TOKEN is not set. Add it to backend/.env on the server.');
  }

  const url = new URL(path, wiseBaseUrl());
  for (const [k, v] of Object.entries(opts.query ?? {})) url.searchParams.set(k, String(v));

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 20_000);
  try {
    const res = await fetch(url.toString(), {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
      signal: controller.signal,
    });
    const text = await res.text();
    const json = text ? safeJson(text) : null;
    if (!res.ok) {
      throw new WiseApiError(res.status, `Wise API ${method} ${path} → ${res.status}`, json ?? text);
    }
    return json as T;
  } catch (err) {
    if (err instanceof WiseApiError) throw err;
    const msg = err instanceof Error ? err.message : String(err);
    throw new WiseApiError(502, `Wise API request failed: ${msg}`);
  } finally {
    clearTimeout(timer);
  }
}

function safeJson(text: string): unknown {
  try { return JSON.parse(text); } catch { return text; }
}

export interface WiseProfile {
  id: number;
  type: 'personal' | 'business';
  // Wise returns a richer object; we only need id + type for the health check.
  [k: string]: unknown;
}

/** List the token's profiles (personal + business). The business profile id is
 *  what every later transfer call needs. */
export async function getWiseProfiles(): Promise<WiseProfile[]> {
  return wiseFetch<WiseProfile[]>('GET', '/v1/profiles');
}

export interface WiseHealth {
  configured: boolean;
  env: 'sandbox' | 'live';
  connected: boolean;
  profileId?: number;
  businessProfiles?: Array<{ id: number; type: string }>;
  error?: string;
}

/** Connectivity check — proves the token works and surfaces the business
 *  profile id (so staff don't have to dig it out of the Wise dashboard). */
export async function wiseHealth(): Promise<WiseHealth> {
  const env = wiseEnv();
  if (!isWiseConfigured()) return { configured: false, env, connected: false };
  try {
    const profiles = await getWiseProfiles();
    const business = profiles.filter((p) => p.type === 'business');
    const configured = process.env.WISE_PROFILE_ID ? Number(process.env.WISE_PROFILE_ID) : undefined;
    return {
      configured: true,
      env,
      connected: true,
      profileId: configured ?? business[0]?.id,
      businessProfiles: business.map((p) => ({ id: p.id, type: p.type })),
    };
  } catch (err) {
    return {
      configured: true,
      env,
      connected: false,
      error: err instanceof WiseApiError ? `${err.status}: ${err.message}` : String(err),
    };
  }
}

export interface WiseBalance {
  currency: string;
  value: number;
}

/**
 * The business profile's balances (one per currency) — read-only, allowed on a
 * read-only personal API token. NOT the balance STATEMENT endpoint, which Wise
 * gates behind extra authentication for UK/EU profiles (PSD2). Used by the cash
 * forecast (docs/CASHFLOW-FORECAST-SPEC.md §13.3).
 */
export async function getWiseBalances(): Promise<WiseBalance[]> {
  let profileId = process.env.WISE_PROFILE_ID ? Number(process.env.WISE_PROFILE_ID) : null;
  if (!profileId) {
    const business = (await getWiseProfiles()).find((p) => p.type === 'business');
    if (!business) throw new WiseApiError(404, 'This Wise token has no business profile.');
    profileId = business.id;
  }
  const rows = await wiseFetch<Array<{ currency?: string; amount?: { value?: number; currency?: string } }>>(
    'GET', `/v4/profiles/${profileId}/balances`, { query: { types: 'STANDARD' } },
  );
  return (rows || []).map((r) => ({
    currency: String(r.amount?.currency || r.currency || ''),
    value: Number(r.amount?.value) || 0,
  }));
}

/** The business profile id: WISE_PROFILE_ID, else discovered from the token's profiles. */
export async function getWiseBusinessProfileId(): Promise<number> {
  if (process.env.WISE_PROFILE_ID) return Number(process.env.WISE_PROFILE_ID);
  const business = (await getWiseProfiles()).find((p) => String(p.type).toLowerCase() === 'business');
  if (!business) throw new WiseApiError(404, 'This Wise token has no business profile.');
  return business.id;
}

/** One row of the profile's activity feed — every movement on the account, in or out. */
export interface WiseActivity {
  id: string;
  type: string;
  resource?: { type?: string; id?: string } | null;
  /** Counterparty name, wrapped in HTML (`<strong>O I B RE LTD SW</strong>`). */
  title?: string | null;
  description?: string | null;
  /** `<positive>+ 2,363.64 GBP</positive>` for money in; `810 GBP` for money out. */
  primaryAmount?: string | null;
  status?: string | null;
  createdOn?: string | null;
}

/**
 * The profile's activity feed between two times, every page (`cursor` → `nextCursor`,
 * 100 a page). Read-only, allowed on a personal token — unlike balance STATEMENTS,
 * which need PSD2 extra authentication (tested on the live account, 20 Nov 2026).
 * Wise doesn't say which order the pages come in, so callers must not assume one.
 */
export async function listWiseActivities(profileId: number, since: Date, until: Date, maxPages = 20): Promise<WiseActivity[]> {
  const out: WiseActivity[] = [];
  const seen = new Set<string>();
  let cursor: string | null = null;
  for (let page = 0; page < maxPages; page++) {
    const q: Record<string, string | number> = { since: since.toISOString(), until: until.toISOString(), size: 100 };
    if (cursor) q.nextCursor = cursor;
    const res = await wiseFetch<{ cursor?: string | null; activities?: WiseActivity[] }>(
      'GET', `/v1/profiles/${profileId}/activities`, { query: q },
    );
    let added = 0;
    for (const a of res?.activities || []) {
      if (!a?.id || seen.has(a.id)) continue;
      seen.add(a.id);
      out.push(a);
      added++;
    }
    cursor = res?.cursor || null;
    // A page with nothing new means the cursor isn't moving — stop rather than loop.
    if (!cursor || added === 0) break;
  }
  return out;
}

/** A transfer as `GET /v1/transfers/{id}` returns it (the fields OP reads). */
export interface WiseTransfer {
  id: number;
  /** null on money IN (it didn't come from one of our balances); set on money we sent. */
  sourceAccount?: number | null;
  targetAccount?: number | null;
  reference?: string | null;
  details?: { reference?: string | null } | null;
  sourceCurrency?: string | null;
  sourceValue?: number | null;
  targetCurrency?: string | null;
  targetValue?: number | null;
  created?: string | null;
}

/** One transfer by Wise's number — incoming ones too (that is where the reference lives). */
export async function getWiseTransfer(transferId: string | number): Promise<WiseTransfer> {
  return wiseFetch<WiseTransfer>('GET', `/v1/transfers/${encodeURIComponent(String(transferId))}`);
}
