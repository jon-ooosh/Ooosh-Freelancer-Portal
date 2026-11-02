import { useAuthStore } from '../hooks/useAuthStore';
import { getWarehouseToken } from './warehouseSession';

const API_BASE = '/api';

// Token refresh mutex: only one refresh at a time, others wait for it
let refreshPromise: Promise<{ accessToken: string; refreshToken: string }> | null = null;

async function refreshAccessToken(): Promise<{ accessToken: string; refreshToken: string }> {
  // If a refresh is already in progress, wait for it
  if (refreshPromise) {
    return refreshPromise;
  }

  const { refreshToken, setTokens, logout } = useAuthStore.getState();
  if (!refreshToken) {
    throw new Error('No refresh token');
  }

  refreshPromise = (async () => {
    try {
      const response = await fetch(`${API_BASE}/auth/refresh`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refreshToken }),
      });

      if (!response.ok) {
        logout();
        const current = window.location.pathname + window.location.search;
        const target = current && current !== '/login'
          ? `/login?redirect=${encodeURIComponent(current)}`
          : '/login';
        window.location.href = target;
        throw new Error('Session expired');
      }

      const tokens = await response.json();
      setTokens(tokens.accessToken, tokens.refreshToken);
      return tokens;
    } finally {
      refreshPromise = null;
    }
  })();

  return refreshPromise;
}

/** nginx's answers when the server didn't: 502 (down — a deploy restart), 503, 504 (no
 *  reply within 60s). Our own routes use these codes too, but always with a JSON body. */
const NO_REPLY_STATUSES = [502, 503, 504];
const NO_REPLY_MESSAGE = 'No reply from the server - it may be restarting, or still working. Refresh the page to check before trying again.';

/**
 * The reply never came back, so the work may or may not have happened: nginx's own
 * error page on a 502/503/504, or the network dropped (fetch throws a TypeError).
 * Safe to ask again for a READ; for a write, look before repeating it. Job 16169,
 * 21 Oct 2026: a deploy restart cut off the Money tab's reload straight after a card
 * receipt went, and the tab said "Request failed".
 */
export function isNoReply(e: unknown): boolean {
  return e instanceof TypeError || (e as { noReply?: boolean } | null)?.noReply === true;
}

async function request<T>(
  path: string,
  options: RequestInit = {}
): Promise<T> {
  const { accessToken, refreshToken } = useAuthStore.getState();

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(options.headers as Record<string, string>),
  };

  if (accessToken) {
    headers['Authorization'] = `Bearer ${accessToken}`;
  } else if (window.location.pathname.startsWith('/warehouse')) {
    // The warehouse kiosk's PIN session (STAFF-LOGIN-SECURITY-SPEC §4): on the
    // kiosk pages only, and only when nobody is logged in to OP in this browser.
    // The server decides what that session may call; nothing here widens it.
    const kiosk = getWarehouseToken();
    if (kiosk) headers['Authorization'] = `Bearer ${kiosk}`;
  }

  let response = await fetch(`${API_BASE}${path}`, { ...options, headers });

  // If 401, try refreshing the token (mutex ensures only one refresh at a time)
  if (response.status === 401 && refreshToken) {
    try {
      const tokens = await refreshAccessToken();
      headers['Authorization'] = `Bearer ${tokens.accessToken}`;
      response = await fetch(`${API_BASE}${path}`, { ...options, headers });
    } catch {
      throw new Error('Session expired');
    }
  }

  if (!response.ok) {
    // A body that isn't JSON is nginx's own error page, not an answer from us. On a
    // 502/503/504 that means the server never replied (restarting, or still working
    // after nginx's 60s) — say so, rather than a bare "Request failed".
    let noReply = false;
    const error = await response.json().catch(() => {
      noReply = NO_REPLY_STATUSES.includes(response.status);
      return { error: noReply ? NO_REPLY_MESSAGE : 'Request failed' };
    });
    const baseMsg = error.error || `HTTP ${response.status}`;
    // Include `detail` field when the backend provides extra context (e.g. excess
    // reimburse loud-fail messages). Without this, callers only see the headline.
    const fullMsg = error.detail ? `${baseMsg} — ${error.detail}` : baseMsg;
    // Attach status + raw details so callers that need them (e.g. the excess
    // chain-break 409 warning flow) can branch without parsing the message.
    const err = Object.assign(new Error(fullMsg), {
      status: response.status,
      code: error.error || null,
      details: error.details || null,
      // The whole parsed body, for callers that need a field the two shortcuts
      // above don't cover (e.g. the quick-assign gate's `code` +
      // `can_override`, which decide whether to offer the manager override).
      // NB `code` above is historically the error MESSAGE, not a machine code —
      // read `body.code` for that.
      body: error as Record<string, unknown>,
      // The server never answered (isNoReply, above).
      noReply,
    });
    throw err;
  }

  if (response.status === 204) return undefined as T;
  return response.json();
}

async function uploadRequest<T>(
  path: string,
  formData: FormData
): Promise<T> {
  const { accessToken, refreshToken } = useAuthStore.getState();

  const headers: Record<string, string> = {};

  if (accessToken) {
    headers['Authorization'] = `Bearer ${accessToken}`;
  }

  let response = await fetch(`${API_BASE}${path}`, {
    method: 'POST',
    headers,
    body: formData,
  });

  if (response.status === 401 && refreshToken) {
    try {
      const tokens = await refreshAccessToken();
      headers['Authorization'] = `Bearer ${tokens.accessToken}`;
      response = await fetch(`${API_BASE}${path}`, {
        method: 'POST',
        headers,
        body: formData,
      });
    } catch {
      throw new Error('Session expired');
    }
  }

  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: 'Upload failed' }));
    throw new Error(error.error || `HTTP ${response.status}`);
  }

  return response.json();
}

// Fetch a file as a blob with auth headers (for inline viewing).
// Pass an AbortSignal when the caller may lose interest mid-download (a
// thumbnail scrolled back out of view) — receipts run to several MB and
// finishing one nobody will look at just starves the next request.
async function blobRequest(path: string, signal?: AbortSignal): Promise<{ blob: Blob; contentType: string }> {
  const { accessToken, refreshToken } = useAuthStore.getState();

  const headers: Record<string, string> = {};
  if (accessToken) {
    headers['Authorization'] = `Bearer ${accessToken}`;
  }

  let response = await fetch(`${API_BASE}${path}`, { headers, signal });

  if (response.status === 401 && refreshToken) {
    try {
      const tokens = await refreshAccessToken();
      headers['Authorization'] = `Bearer ${tokens.accessToken}`;
      response = await fetch(`${API_BASE}${path}`, { headers, signal });
    } catch {
      throw new Error('Session expired');
    }
  }

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }

  const blob = await response.blob();
  const contentType = response.headers.get('Content-Type') || 'application/octet-stream';
  return { blob, contentType };
}

/**
 * Shared token refresh — used by both the main OP API and the vehicle module
 * to ensure only ONE refresh happens at a time across the whole app.
 */
export async function sharedRefreshToken(): Promise<Record<string, string>> {
  const tokens = await refreshAccessToken();
  return { Authorization: `Bearer ${tokens.accessToken}` };
}

export const api = {
  get: <T>(path: string) => request<T>(path),
  post: <T>(path: string, body: unknown) =>
    request<T>(path, { method: 'POST', body: JSON.stringify(body) }),
  put: <T>(path: string, body: unknown) =>
    request<T>(path, { method: 'PUT', body: JSON.stringify(body) }),
  patch: <T>(path: string, body: unknown) =>
    request<T>(path, { method: 'PATCH', body: JSON.stringify(body) }),
  delete: <T>(path: string) => request<T>(path, { method: 'DELETE' }),
  deleteWithBody: <T>(path: string, body: unknown) =>
    request<T>(path, { method: 'DELETE', body: JSON.stringify(body) }),
  upload: <T>(path: string, formData: FormData) => uploadRequest<T>(path, formData),
  blob: (path: string, signal?: AbortSignal) => blobRequest(path, signal),
};
