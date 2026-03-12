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
 * Make a GET request to HireHop API
 */
export async function hireHopGet<T = unknown>(
  endpoint: string,
  params: Record<string, string | number> = {}
): Promise<HireHopResponse<T>> {
  const { token, domain } = getHireHopConfig();

  const url = new URL(`https://${domain}${endpoint}`);
  url.searchParams.set('token', token);
  for (const [key, val] of Object.entries(params)) {
    url.searchParams.set(key, String(val));
  }

  debugLog(`GET ${endpoint}`, params);

  try {
    const response = await fetch(url.toString());
    return parseResponse<T>(response);
  } catch (error) {
    console.error(`HireHop GET ${endpoint} failed:`, error);
    return { success: false, error: String(error) };
  }
}

/**
 * Make a POST request to HireHop API
 */
export async function hireHopPost<T = unknown>(
  endpoint: string,
  body: Record<string, unknown> = {},
  tokenInQuery = false
): Promise<HireHopResponse<T>> {
  const { token, domain } = getHireHopConfig();

  let url = `https://${domain}${endpoint}`;
  if (tokenInQuery) {
    url += `?token=${encodeURIComponent(token)}`;
  }

  const formData = new URLSearchParams();
  if (!tokenInQuery) {
    formData.append('token', token);
  }
  for (const [key, val] of Object.entries(body)) {
    if (val !== undefined && val !== null) {
      formData.append(key, typeof val === 'object' ? JSON.stringify(val) : String(val));
    }
  }

  debugLog(`POST ${endpoint}`, Object.keys(body));

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: formData.toString(),
    });
    return parseResponse<T>(response);
  } catch (error) {
    console.error(`HireHop POST ${endpoint} failed:`, error);
    return { success: false, error: String(error) };
  }
}

/**
 * Parse HireHop response — check for HTML (auth failure) before JSON parsing
 */
async function parseResponse<T>(response: Response): Promise<HireHopResponse<T>> {
  const text = await response.text();

  // Check for HTML response (auth failure)
  if (text.trim().startsWith('<')) {
    console.error('HireHop returned HTML — authentication failed');
    return { success: false, error: 'Authentication failed — check API token', isAuthError: true };
  }

  // Rate limit
  if (response.status === 429) {
    return { success: false, error: 'Rate limited — max 60 requests/minute' };
  }

  try {
    const data = JSON.parse(text);

    if (data.error) {
      return { success: false, error: String(data.error) };
    }

    return { success: true, data: data as T };
  } catch {
    console.error('Failed to parse HireHop response:', text.substring(0, 200));
    return { success: false, error: 'Invalid response format' };
  }
}

/**
 * Rate-limited batch fetcher — respects HireHop's 3/sec, 60/min limits
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
