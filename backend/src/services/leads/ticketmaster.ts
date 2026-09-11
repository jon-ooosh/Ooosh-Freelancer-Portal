/**
 * Ticketmaster Discovery API client for the Lead Finder.
 *
 * Ported from the standalone tool's `collector.py` / `tour_detector.py` TM
 * helpers. Not routed through the HireHop broker (different API) — but reuses
 * the same discipline: a per-second throttle + a per-run call cap so a runaway
 * loop can't blow through TM's 5,000/day allowance.
 *
 * Inert when TICKETMASTER_API_KEY isn't set — `isTicketmasterConfigured()` lets
 * the route 503 cleanly (same pattern as Stripe/Anthropic config).
 */
import dotenv from 'dotenv';

dotenv.config({ quiet: true });

const BASE_URL = 'https://app.ticketmaster.com/discovery/v2';
const RATE_LIMIT_PER_SECOND = 4; // stay under TM's 5/s
const PER_RUN_CALL_CAP = 4500; // stay under TM's 5,000/day

export function isTicketmasterConfigured(): boolean {
  return Boolean(process.env.TICKETMASTER_API_KEY);
}

let lastCall = 0;
let callsThisRun = 0;

/** Reset the per-run call counter (called at the start of each pipeline run). */
export function resetTicketmasterCallBudget(): void {
  callsThisRun = 0;
}

export function getTicketmasterCallCount(): number {
  return callsThisRun;
}

async function throttle(): Promise<void> {
  const minInterval = 1000 / RATE_LIMIT_PER_SECOND;
  const elapsed = Date.now() - lastCall;
  if (elapsed < minInterval) {
    await new Promise((r) => setTimeout(r, minInterval - elapsed));
  }
  lastCall = Date.now();
}

/* eslint-disable @typescript-eslint/no-explicit-any */
export type TmResponse = Record<string, any>;

/**
 * GET against the Discovery API. Returns null on budget-exhausted or error
 * (callers treat null as "no data" and move on — a single flaky call must not
 * abort the whole run).
 */
export async function tmGet(
  endpoint: string,
  params: Record<string, string | number>,
): Promise<TmResponse | null> {
  if (callsThisRun >= PER_RUN_CALL_CAP) {
    console.warn('[leads/tm] per-run call cap reached (%d)', PER_RUN_CALL_CAP);
    return null;
  }
  await throttle();

  const apiKey = process.env.TICKETMASTER_API_KEY || '';
  const qs = new URLSearchParams({ apikey: apiKey });
  for (const [k, v] of Object.entries(params)) qs.set(k, String(v));

  const url = `${BASE_URL}/${endpoint}?${qs.toString()}`;
  callsThisRun += 1;

  try {
    const resp = await fetch(url, { signal: AbortSignal.timeout(30_000) });
    if (resp.status === 429) {
      console.warn('[leads/tm] rate limit hit, backing off 2s');
      await new Promise((r) => setTimeout(r, 2000));
      return tmGet(endpoint, params); // retry once
    }
    if (!resp.ok) {
      console.error('[leads/tm] %s → HTTP %d', endpoint, resp.status);
      return null;
    }
    return (await resp.json()) as TmResponse;
  } catch (err) {
    console.error('[leads/tm] %s error:', endpoint, err);
    return null;
  }
}

/** ISO 8601 with Z suffix, as TM expects for startDateTime / endDateTime. */
export function tmDateTime(d: Date): string {
  return d.toISOString().replace(/\.\d{3}Z$/, 'Z');
}
