/**
 * Warehouse kiosk session — narrow-scope JWT held in sessionStorage.
 *
 * Distinct from the staff auth store (Zustand) so the kiosk can run without
 * polluting / being polluted by a logged-in staff session in another tab.
 * Token is minted by POST /api/warehouse/auth/pin (12h TTL).
 */
const STORAGE_KEY = 'warehouse_session_token';

export function getWarehouseToken(): string | null {
  try {
    return sessionStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}

export function setWarehouseToken(token: string): void {
  try {
    sessionStorage.setItem(STORAGE_KEY, token);
  } catch {
    // storage unavailable — caller will discover via subsequent 401s
  }
}

export function clearWarehouseToken(): void {
  try {
    sessionStorage.removeItem(STORAGE_KEY);
  } catch {
    // ignore
  }
}

/**
 * Fetch wrapper that injects the warehouse session token. 401 from the
 * server returns a thrown { unauthorized: true } so callers can redirect
 * to the PIN page.
 */
export async function warehouseFetch(
  input: string,
  init: RequestInit = {}
): Promise<Response> {
  const token = getWarehouseToken();
  const headers = new Headers(init.headers || {});
  if (token) headers.set('Authorization', `Bearer ${token}`);
  if (!headers.has('Content-Type') && init.body && !(init.body instanceof FormData)) {
    headers.set('Content-Type', 'application/json');
  }
  const response = await fetch(input, { ...init, headers });
  if (response.status === 401) {
    clearWarehouseToken();
    throw Object.assign(new Error('Unauthorized'), { unauthorized: true });
  }
  return response;
}
