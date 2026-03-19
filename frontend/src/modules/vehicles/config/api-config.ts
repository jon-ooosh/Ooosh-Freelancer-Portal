/**
 * Centralized API configuration.
 *
 * In standalone mode (Netlify): base = '/.netlify/functions', no auth headers.
 * In embedded mode (OP app):    base = '/api/vehicles', Bearer token from OP auth store.
 *
 * All API modules import `apiBase` and `apiFetch` from here instead of
 * hardcoding `/.netlify/functions`.
 */

interface ApiConfig {
  /** Base URL for all backend function calls */
  baseUrl: string
  /** Returns auth headers to attach to every API request */
  getAuthHeaders: () => Record<string, string>
  /** Optional: refresh the access token and return new headers. Called on 401. */
  refreshToken?: () => Promise<Record<string, string>>
}

const config: ApiConfig = {
  baseUrl: '/.netlify/functions',
  getAuthHeaders: () => ({}),
}

/**
 * Configure the API layer for embedded mode.
 * Call once at app init before any API calls.
 *
 * Example (OP integration):
 *   configureApi({
 *     baseUrl: '/api/vehicles',
 *     getAuthHeaders: () => {
 *       const token = useAuthStore.getState().accessToken
 *       return token ? { Authorization: `Bearer ${token}` } : {}
 *     },
 *     refreshToken: async () => {
 *       // call /api/auth/refresh, store new tokens, return new headers
 *     },
 *   })
 */
export function configureApi(overrides: Partial<ApiConfig>) {
  Object.assign(config, overrides)
}

/** Current API base URL */
export function getApiBase(): string {
  return config.baseUrl
}

/** Current auth headers (empty in standalone mode) */
export function getAuthHeaders(): Record<string, string> {
  return config.getAuthHeaders()
}

/**
 * Fetch wrapper that:
 * 1. Prepends the configured base URL (if path is relative)
 * 2. Merges in auth headers
 * 3. Auto-refreshes token on 401 and retries once
 *
 * Drop-in replacement for `fetch(url, init)` in API modules.
 */
export async function apiFetch(
  path: string,
  init?: RequestInit,
): Promise<Response> {
  // If the path is already absolute (starts with http or /api/), don't prepend base
  const isAbsolute = path.startsWith('http') || (path.startsWith('/api/') && !path.startsWith(config.baseUrl))
  const url = isAbsolute ? path : `${config.baseUrl}${path.startsWith('/') ? path : `/${path}`}`

  const headers: Record<string, string> = {
    ...config.getAuthHeaders(),
    ...(init?.headers as Record<string, string> | undefined),
  }

  let response = await fetch(url, { ...init, headers })

  // On 401, try refreshing the token and retrying once
  if (response.status === 401 && config.refreshToken) {
    try {
      const newHeaders = await config.refreshToken()
      const retryHeaders: Record<string, string> = {
        ...newHeaders,
        ...(init?.headers as Record<string, string> | undefined),
      }
      response = await fetch(url, { ...init, headers: retryHeaders })
    } catch {
      // Refresh failed — return original 401 response
    }
  }

  return response
}

/**
 * Build a full API URL from a function path.
 * Useful when constructing URLs for fetch calls that need query params.
 */
export function apiUrl(path: string): string {
  return `${config.baseUrl}${path.startsWith('/') ? path : `/${path}`}`
}
