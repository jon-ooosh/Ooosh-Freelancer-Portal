import { useAuthStore } from '../hooks/useAuthStore';

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
        window.location.href = '/login';
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
    const error = await response.json().catch(() => ({ error: 'Request failed' }));
    throw new Error(error.error || `HTTP ${response.status}`);
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

// Fetch a file as a blob with auth headers (for inline viewing)
async function blobRequest(path: string): Promise<{ blob: Blob; contentType: string }> {
  const { accessToken, refreshToken } = useAuthStore.getState();

  const headers: Record<string, string> = {};
  if (accessToken) {
    headers['Authorization'] = `Bearer ${accessToken}`;
  }

  let response = await fetch(`${API_BASE}${path}`, { headers });

  if (response.status === 401 && refreshToken) {
    try {
      const tokens = await refreshAccessToken();
      headers['Authorization'] = `Bearer ${tokens.accessToken}`;
      response = await fetch(`${API_BASE}${path}`, { headers });
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
  blob: (path: string) => blobRequest(path),
};
