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
