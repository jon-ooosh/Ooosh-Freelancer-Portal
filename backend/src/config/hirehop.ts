/**
 * HireHop API Client
 *
 * Handles authentication, error handling (HTML detection), and rate limiting.
 * Based on patterns from OOOSH Driver Verification Project.
 */
import dotenv from 'dotenv';

dotenv.config();

const DEBUG_MODE = process.env.DEBUG_MODE === 'true';

function debugLog(...args: unknown[]) {
  if (DEBUG_MODE) {
    console.log('[HireHop]', ...args);
  }
}

export interface HireHopConfig {
  token: string;
  domain: string;
}

export interface HireHopResponse<T = unknown> {
  success: boolean;
  data?: T;
  error?: string;
  isAuthError?: boolean;
}

export function getHireHopConfig(): HireHopConfig {
  const token = process.env.HIREHOP_API_TOKEN;
  const domain = process.env.HIREHOP_DOMAIN || 'myhirehop.com';

  if (!token) {
    throw new Error('HIREHOP_API_TOKEN not configured');
  }

  return { token, domain };
}

export function isHireHopConfigured(): boolean {
  return !!process.env.HIREHOP_API_TOKEN;
}

/**
 * Make a GET request to HireHop API.
 * Routes through the centralised broker for rate limiting, caching, and deduplication.
 */
export async function hireHopGet<T = unknown>(
  endpoint: string,
  params: Record<string, string | number> = {}
): Promise<HireHopResponse<T>> {
  debugLog(`GET ${endpoint}`, params);

  // Lazy import to avoid circular dependency at module load time
  const { hhBroker } = await import('../services/hirehop-broker');
  return hhBroker.get<T>(endpoint, params, { priority: 'low' });
}

/**
 * Make a POST request to HireHop API.
 * Routes through the centralised broker for rate limiting.
 */
export async function hireHopPost<T = unknown>(
  endpoint: string,
  body: Record<string, unknown> = {},
  _tokenInQuery = false
): Promise<HireHopResponse<T>> {
  debugLog(`POST ${endpoint}`, Object.keys(body));

  // Lazy import to avoid circular dependency at module load time
  const { hhBroker } = await import('../services/hirehop-broker');
  return hhBroker.post<T>(endpoint, body, { priority: 'low' });
}

/**
 * Rate-limited batch fetcher — delegates to broker.
 * Kept for backward compatibility. New code should use hhBroker.batch() directly.
 */
export async function hireHopBatch<T>(
  requests: Array<() => Promise<HireHopResponse<T>>>,
  delayMs = 350
): Promise<HireHopResponse<T>[]> {
  const results: HireHopResponse<T>[] = [];
  for (const req of requests) {
    results.push(await req());
    if (delayMs > 0) {
      await new Promise(resolve => setTimeout(resolve, delayMs));
    }
  }
  return results;
}
