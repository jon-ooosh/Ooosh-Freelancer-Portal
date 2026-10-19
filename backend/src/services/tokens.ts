/**
 * THE way to mint and verify a JWT on this platform.
 *
 * One secret (JWT_SECRET) signs every token family — staff logins, kiosk and
 * public sessions, freelancer book-out / prep. Until Oct 2026 nothing but the
 * payload's shape told them apart, so a verifier that forgot its shape check
 * accepted every family. Every token now carries an `aud` naming its family,
 * and every verifier names the one family it accepts: `jsonwebtoken` refuses
 * the rest before any application code runs, so a token minted for one
 * audience can never be VERIFIED by another (SECURITY-AUDIT-BRIEF B.1).
 *
 * The freelancer PORTAL session is deliberately NOT here. It is signed with its
 * own secret (SESSION_SECRET), and the Netlify portal app mints and verifies
 * the same cookie with `jose` — see routes/portal.ts.
 *
 * Adding a family: name it here, mint with signFor(), verify with verifyFor(),
 * give it its own middleware. Never widen an existing audience.
 */
import jwt from 'jsonwebtoken';

export type TokenAudience =
  | 'staff'                   // OP staff access token { id, email, role } — middleware/auth.ts
  | 'staff_refresh'           // { id, type: 'refresh' } — /auth/refresh only
  | 'hire_form'               // public hire-form session — routes/driver-verification.ts
  | 'claim_driver'            // public claim-form driver session — services/claim-links.ts
  | 'warehouse'               // kiosk PIN session — routes/warehouse.ts
  | 'freelancer_bookout'      // one assignment — middleware/freelancer-bookout-auth.ts
  | 'freelancer_prep'         // one van, one task — same file
  | 'freelancer_prep_redeem'; // 15-min link token that becomes a prep session — same file

if (!process.env.JWT_SECRET) {
  throw new Error('FATAL: JWT_SECRET environment variable is required');
}
const JWT_SECRET: string = process.env.JWT_SECRET;

/** Mint a token for exactly one audience. */
export function signFor(aud: TokenAudience, payload: object, expiresIn: string | number): string {
  return jwt.sign(payload, JWT_SECRET, { audience: aud, expiresIn } as jwt.SignOptions);
}

/**
 * The payload if `token` is a valid, unexpired token minted for `aud`;
 * null for a bad signature, an expired token, or any OTHER audience
 * (including a token with no `aud` at all).
 */
export function verifyFor<T extends object = Record<string, unknown>>(aud: TokenAudience, token: string): T | null {
  try {
    return jwt.verify(token, JWT_SECRET, { audience: aud }) as T;
  } catch {
    return null;
  }
}
