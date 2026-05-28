/**
 * encryption.ts — Application-level AES-256-GCM encryption for sensitive PII.
 *
 * Used to encrypt fields that must never sit in the database as plaintext:
 * client bank details (first consumer), and — on jon's timeline — driver
 * hire-form data, card-receipt scans metadata, freelancer PII.
 *
 * Format on disk: `iv:authTag:ciphertext` (all hex). The IV is random per
 * encryption (12 bytes, GCM standard), so encrypting the same plaintext twice
 * yields different ciphertext — that's correct and expected.
 *
 * ── Key management (READ THIS) ─────────────────────────────────────────────
 * The key comes from the ENCRYPTION_KEY env var: 64 hex chars = 32 bytes,
 * generated via `openssl rand -hex 32`.
 *
 * The key must NEVER change once data has been encrypted with it. Rotating or
 * losing the key makes every encrypted field permanently unrecoverable — there
 * is no recovery path. jon holds the key in a safe place; it goes into
 * /var/www/ooosh-portal/backend/.env on the server.
 *
 * Decrypt ONLY in the API response layer, and only for authorised users
 * (admin/manager). Never decrypt inside a SQL query or log decrypted values.
 *
 * If ENCRYPTION_KEY is unset, isEncryptionConfigured() returns false and the
 * encrypt/decrypt functions throw — callers should guard with that helper and
 * degrade cleanly (e.g. refuse to save bank details rather than storing them
 * in plaintext).
 */
import crypto from 'crypto';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12; // GCM standard nonce length
const KEY_LENGTH = 32; // 256 bits

let cachedKey: Buffer | null = null;

/** Resolve and validate the encryption key from env. Cached after first read. */
function getKey(): Buffer {
  if (cachedKey) return cachedKey;
  const raw = process.env.ENCRYPTION_KEY;
  if (!raw) {
    throw new Error(
      'ENCRYPTION_KEY is not set. Cannot encrypt/decrypt PII. ' +
        'Generate with `openssl rand -hex 32` and add to backend/.env.'
    );
  }
  if (!/^[0-9a-fA-F]{64}$/.test(raw)) {
    throw new Error(
      'ENCRYPTION_KEY must be exactly 64 hex characters (32 bytes). ' +
        'Generate with `openssl rand -hex 32`.'
    );
  }
  const key = Buffer.from(raw, 'hex');
  if (key.length !== KEY_LENGTH) {
    throw new Error(`ENCRYPTION_KEY decoded to ${key.length} bytes, expected ${KEY_LENGTH}.`);
  }
  cachedKey = key;
  return key;
}

/**
 * True when ENCRYPTION_KEY is present and well-formed. Guard with this before
 * calling encrypt/decrypt so routes can 503/refuse cleanly on a server that
 * hasn't had the key provisioned yet, rather than throwing a 500.
 */
export function isEncryptionConfigured(): boolean {
  try {
    getKey();
    return true;
  } catch {
    return false;
  }
}

/** Encrypt a UTF-8 string. Returns `iv:authTag:ciphertext` (hex). */
export function encrypt(plaintext: string): string {
  const key = getKey();
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return `${iv.toString('hex')}:${authTag.toString('hex')}:${ciphertext.toString('hex')}`;
}

/** Decrypt a value produced by encrypt(). Throws on tamper / wrong key / bad format. */
export function decrypt(stored: string): string {
  const key = getKey();
  const parts = stored.split(':');
  if (parts.length !== 3) {
    throw new Error('Invalid encrypted value format (expected iv:authTag:ciphertext)');
  }
  const [ivHex, authTagHex, ciphertextHex] = parts;
  const iv = Buffer.from(ivHex!, 'hex');
  const authTag = Buffer.from(authTagHex!, 'hex');
  const ciphertext = Buffer.from(ciphertextHex!, 'hex');
  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);
  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return plaintext.toString('utf8');
}

/** Encrypt a JSON-serialisable object. */
export function encryptJson(obj: unknown): string {
  return encrypt(JSON.stringify(obj));
}

/** Decrypt and JSON-parse a value produced by encryptJson(). */
export function decryptJson<T = unknown>(stored: string): T {
  return JSON.parse(decrypt(stored)) as T;
}

/**
 * Best-effort decrypt: returns null instead of throwing on any failure.
 * Useful in response-mapping loops where one bad row shouldn't 500 the whole
 * list. Logs the failure for diagnosis (without the value itself).
 */
export function tryDecrypt(stored: string | null | undefined): string | null {
  if (!stored) return null;
  try {
    return decrypt(stored);
  } catch (err) {
    console.error('[encryption] decrypt failed (returning null):', err instanceof Error ? err.message : err);
    return null;
  }
}

/** Best-effort decryptJson — null on any failure. */
export function tryDecryptJson<T = unknown>(stored: string | null | undefined): T | null {
  if (!stored) return null;
  try {
    return decryptJson<T>(stored);
  } catch (err) {
    console.error('[encryption] decryptJson failed (returning null):', err instanceof Error ? err.message : err);
    return null;
  }
}
