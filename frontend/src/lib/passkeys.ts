/**
 * Passkeys on the client (STAFF-LOGIN-SECURITY-SPEC §3.4). The browser does the
 * cryptography (@simplewebauthn/browser over navigator.credentials); these three
 * calls are the whole conversation with the server.
 */
import { startRegistration, startAuthentication, browserSupportsWebAuthn } from '@simplewebauthn/browser';
import type { PublicKeyCredentialCreationOptionsJSON, PublicKeyCredentialRequestOptionsJSON } from '@simplewebauthn/browser';
import { api } from '../services/api';

export function passkeysSupported(): boolean {
  try { return browserSupportsWebAuthn(); } catch { return false; }
}

/** "The person closed the Face ID sheet" — not an error to shout about. */
export function wasCancelled(err: unknown): boolean {
  const name = (err as { name?: string } | null)?.name;
  return name === 'NotAllowedError' || name === 'AbortError';
}

export interface NewPasskey { id: string; label: string; backed_up: boolean; created_at: string; last_used_at: string | null }

/** Add a passkey to MY login (logged in). An admin's first one returns recovery codes, once. */
export async function registerPasskey(label: string): Promise<{ passkey: NewPasskey; recoveryCodes: string[] | null }> {
  const optionsJSON = await api.post<PublicKeyCredentialCreationOptionsJSON>('/auth/security/passkeys/options', {});
  const response = await startRegistration({ optionsJSON });
  return api.post<{ passkey: NewPasskey; recoveryCodes: string[] | null }>('/auth/security/passkeys', { response, label });
}

export interface PasskeyLoginResult<U> { user: U; accessToken: string; refreshToken: string }

/**
 * Log in with a passkey. With `pending` (after the password) it is the second
 * factor; without, the browser names the person and it is the whole login.
 */
export async function loginWithPasskey<U>(pending: string | null, trustDevice: boolean): Promise<PasskeyLoginResult<U>> {
  const { options, nonce } = await api.post<{ options: PublicKeyCredentialRequestOptionsJSON; nonce: string }>(
    '/auth/login/passkey/options', pending ? { pending } : {},
  );
  const response = await startAuthentication({ optionsJSON: options });
  return api.post<PasskeyLoginResult<U>>('/auth/login/passkey', { nonce, response, trustDevice });
}
