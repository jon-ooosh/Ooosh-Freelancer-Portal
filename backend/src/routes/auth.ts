import { Router, Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import rateLimit from 'express-rate-limit';
import multer from 'multer';
import path from 'path';
import { v4 as uuid } from 'uuid';
import { z } from 'zod';
import { query } from '../config/database';
import { validate } from '../middleware/validate';
import { authenticate, authorize, AuthRequest, MANAGER_ROLES } from '../middleware/auth';
import { signFor, verifyFor } from '../services/tokens';
import {
  secondsBlocked, recordLoginFailure, clearLoginFailures, readTrustedDevice, isEnforcedNow,
  sendLoginCode, verifyLoginCode, markEnrolled, trustThisDevice, deviceLabelFrom, securityInfo,
  listTrustedDevices, revokeTrustedDevice, signOutEverywhere, peekDeviceId, clearDeviceCookie,
} from '../services/staff-login-security';
import {
  countPasskeys, listPasskeys, removePasskey, registrationOptions, verifyRegistration,
  authenticationOptions, verifyAuthentication, generateRecoveryCodes, recoveryCodesLeft,
  useRecoveryCode, PasskeyError,
} from '../services/staff-passkeys';
import { uploadToR2, deleteFromR2, getFromR2, isR2Configured } from '../config/r2';

const router = Router();

// Rate limiting: 10 login attempts per 15 minutes per IP
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: { error: 'Too many login attempts — try again in 15 minutes' },
  standardHeaders: true,
  legacyHeaders: false,
});

// Rate limiting: second-factor steps — the code check shares the login limiter
// (a code is a credential); sending is capped on its own.
const codeSendLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: { error: 'Too many code requests — try again later' },
  standardHeaders: true,
  legacyHeaders: false,
});

// Rate limiting: 20 token refresh attempts per 15 minutes per IP
const refreshLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  message: { error: 'Too many refresh attempts — try again later' },
  standardHeaders: true,
  legacyHeaders: false,
});

const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || '15m';
const JWT_REFRESH_EXPIRES_IN = process.env.JWT_REFRESH_EXPIRES_IN || '7d';

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8),
});

const registerSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8),
  first_name: z.string().min(1),
  last_name: z.string().min(1),
  // No 'freelancer' here: freelancers log in to the PORTAL (people.portal_password_hash,
  // routes/portal.ts), never to OP. A users row with that role would hold a real
  // staff-shaped JWT and reach every authenticate-only route (SECURITY-AUDIT-BRIEF B.3).
  role: z.enum(['admin', 'manager', 'staff', 'general_assistant', 'weekend_manager']).default('staff'),
});

const changePasswordSchema = z.object({
  current_password: z.string().min(1),
  new_password: z.string().min(8),
});

const updateProfileSchema = z.object({
  first_name: z.string().min(1).optional(),
  last_name: z.string().min(1).optional(),
  // "I prefer to be known as". Nullable and allowed to be empty so somebody can
  // clear it and go back to their first name; `displayName.ts` already falls
  // back. Editable here because it is a fact about the person, not employment
  // configuration — it was previously only settable by an admin, and only for
  // somebody who had an employment record at all.
  preferred_name: z.string().max(60).optional().nullable(),
  // Staff's company-card last 4. Optional + nullable so the user can clear it.
  // Stored on users (not people) — it's a staff-only operational field.
  // NOTE: no longer written by any UI — the card is assigned by an admin on the
  // Staff page, which also holds the label and the card agreement. Kept on the
  // endpoint so an older cached bundle can't 400 mid-deploy.
  cot_card_last4: z.string().regex(/^\d{4}$/).optional().nullable(),
});

// Avatar upload config — images only, 5MB limit
const avatarUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const allowed = ['.jpg', '.jpeg', '.png', '.gif', '.webp'];
    const ext = path.extname(file.originalname).toLowerCase();
    if (allowed.includes(ext)) {
      cb(null, true);
    } else {
      cb(new Error(`File type ${ext} not allowed. Use JPG, PNG, GIF, or WebP.`));
    }
  },
});

function generateTokens(user: { id: string; email: string; role: string }) {
  const accessToken = signFor('staff', { id: user.id, email: user.email, role: user.role }, JWT_EXPIRES_IN);
  const refreshToken = signFor('staff_refresh', { id: user.id, type: 'refresh' }, JWT_REFRESH_EXPIRES_IN);

  return { accessToken, refreshToken };
}

// A users-row joined to people, as /login and the second-factor steps load it.
type LoginRow = {
  id: string; email: string; role: string; password_hash: string;
  first_name: string | null; last_name: string | null; preferred_name: string | null;
  avatar_url: string | null; force_password_change: boolean | null;
  mfa_enrolled_at: Date | null; login_disabled: boolean | null;
};

const LOGIN_ROW_SQL = `SELECT u.*, p.first_name, p.last_name, p.preferred_name
       FROM users u JOIN people p ON u.person_id = p.id`;

function userPayload(user: LoginRow) {
  return {
    id: user.id,
    email: user.email,
    role: user.role,
    first_name: user.first_name,
    last_name: user.last_name,
    // What they are actually called. Display code uses this in preference
    // to first_name — see frontend lib/displayName.ts.
    preferred_name: user.preferred_name || null,
    avatar_url: user.avatar_url || null,
    force_password_change: user.force_password_change || false,
  };
}

/** The login is complete: mint the pair, remember the refresh token, answer. */
async function issueSession(res: Response, user: LoginRow): Promise<void> {
  const tokens = generateTokens(user);
  await query(
    'UPDATE users SET refresh_token = $1, last_login = NOW() WHERE id = $2',
    [tokens.refreshToken, user.id]
  );
  res.json({ user: { ...userPayload(user), ...(await securityInfo(user)) }, ...tokens });
}

/** "j***@oooshtours.co.uk" — enough for the person to know which inbox, no more. */
function hintEmail(email: string): string {
  const [local, domain] = email.split('@');
  return `${(local || '').slice(0, 1)}***@${domain ?? ''}`;
}

/** The person a `login_pending` token names, if they may still log in. */
async function userFromPending(token: unknown): Promise<LoginRow | null> {
  if (typeof token !== 'string') return null;
  const p = verifyFor<{ id?: string }>('login_pending', token);
  if (!p?.id) return null;
  const r = await query(
    `${LOGIN_ROW_SQL} WHERE u.id = $1 AND u.is_active = true AND u.role <> 'freelancer' AND u.login_disabled = false`,
    [p.id]
  );
  return (r.rows[0] as LoginRow | undefined) ?? null;
}

/**
 * Which second factors this person may use, and the email code sent if it is one
 * of them (§3.1, §1.2). A passkey holder is offered the passkey; a non-admin keeps
 * the email code as the fallback; an ADMIN with a passkey has the passkey and the
 * recovery codes only — the mandate means the mailbox is no longer a way in.
 */
async function secondFactorOffer(user: LoginRow, req: Request) {
  const passkeys = await countPasskeys(user.id);
  const methods = passkeys > 0 ? (user.role === 'admin' ? ['passkey'] : ['passkey', 'email']) : ['email'];
  const sent = methods.includes('email')
    ? await sendLoginCode(user, deviceLabelFrom(req.headers['user-agent']))
    : null;
  return {
    methods,
    emailHint: hintEmail(user.email),
    codeSent: sent?.ok ?? false,
    codeError: sent && !sent.ok ? sent.error : null,
    recovery: user.role === 'admin' && (await recoveryCodesLeft(user.id)) > 0,
  };
}

/** The second factor passed: enrolled, device trusted if asked, session issued. */
async function finishSecondFactor(req: Request, res: Response, user: LoginRow): Promise<void> {
  await markEnrolled(user.id);
  user.mfa_enrolled_at = user.mfa_enrolled_at ?? new Date();
  if (req.body?.trustDevice !== false) {
    await trustThisDevice(res, user.id, deviceLabelFrom(req.headers['user-agent']));
  }
  await issueSession(res, user);
}

// POST /api/auth/login
router.post('/login', loginLimiter, validate(loginSchema), async (req: Request, res: Response) => {
  try {
    const { email, password } = req.body;

    const result = await query(
      `SELECT u.*, p.first_name, p.last_name, p.preferred_name
       FROM users u JOIN people p ON u.person_id = p.id
       WHERE u.email = $1 AND u.is_active = true AND u.role <> 'freelancer'`,
      [email.toLowerCase()]
    );

    if (result.rows.length === 0) {
      res.status(401).json({ error: 'Invalid email or password' });
      return;
    }

    const user = result.rows[0] as LoginRow;

    // Per-account slowdown (STAFF-LOGIN-SECURITY-SPEC §3.6): a blocked account
    // gets the same 401 as a wrong password, plus retryAfter so the real
    // owner's screen can say how long.
    const wait = await secondsBlocked(user.id);
    if (wait > 0) {
      res.status(401).json({ error: 'Invalid email or password', retryAfter: wait });
      return;
    }

    const validPassword = await bcrypt.compare(password, user.password_hash);
    if (!validPassword) {
      await recordLoginFailure(user);
      res.status(401).json({ error: 'Invalid email or password' });
      return;
    }
    await clearLoginFailures(user.id);

    // The service identity (system@) and anything else switched off: right
    // password, still no login.
    if (user.login_disabled) {
      res.status(401).json({ error: 'Invalid email or password' });
      return;
    }

    // Second factor (§3.1). A trusted device, or a person not yet enrolled
    // before the enforcement date, goes straight in. Everyone else gets a
    // 5-minute pending token and a code in their inbox.
    const trustedDeviceId = await readTrustedDevice(req, user.id);
    const enrolled = !!user.mfa_enrolled_at;
    if (!trustedDeviceId && (enrolled || await isEnforcedNow())) {
      const pending = signFor('login_pending', { id: user.id }, '5m');
      res.json({ pending, ...(await secondFactorOffer(user, req)) });
      return;
    }

    await issueSession(res, user);
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── Second factor (STAFF-LOGIN-SECURITY-SPEC §3) ───────────────────────────

// POST /api/auth/login/send-code — (re)send the code for a pending login
router.post('/login/send-code', codeSendLimiter, async (req: Request, res: Response) => {
  try {
    const user = await userFromPending(req.body?.pending);
    if (!user) { res.status(401).json({ error: 'Your login has expired — start again' }); return; }
    const sent = await sendLoginCode(user, deviceLabelFrom(req.headers['user-agent']));
    if (!sent.ok) { res.status(sent.status).json({ error: sent.error }); return; }
    res.json({ success: true });
  } catch (error) {
    console.error('Login send-code error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/auth/login/code — the second step: code → session (+ trust this device)
router.post('/login/code', loginLimiter, async (req: Request, res: Response) => {
  try {
    const user = await userFromPending(req.body?.pending);
    if (!user) { res.status(401).json({ error: 'Your login has expired — start again' }); return; }
    const code = String(req.body?.code ?? '');
    if (!/^\d{6}$/.test(code)) { res.status(400).json({ error: 'Enter the 6-digit code' }); return; }
    const check = await verifyLoginCode(user.id, code);
    if (!check.ok) { res.status(401).json({ error: check.error }); return; }
    // An admin with a passkey is not let in on the mailbox alone (§1.2).
    if (user.role === 'admin' && (await countPasskeys(user.id)) > 0) {
      res.status(401).json({ error: 'Use your passkey (or a recovery code) — admin logins need one.' });
      return;
    }
    await finishSecondFactor(req, res, user);
  } catch (error) {
    console.error('Login code error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── Passkeys (STAFF-LOGIN-SECURITY-SPEC §3.4) ──────────────────────────────

const passkeyFail = (res: Response, err: unknown, where: string) => {
  if (err instanceof PasskeyError) { res.status(err.status).json({ error: err.message }); return; }
  console.error(`${where} error:`, err);
  res.status(500).json({ error: 'Internal server error' });
};

// POST /api/auth/login/passkey/options — { pending? }: a challenge. With a pending
// token (after the password) only that person's passkeys are offered; without
// one the passkey IS the login and the browser names the person.
router.post('/login/passkey/options', loginLimiter, async (req: Request, res: Response) => {
  try {
    let userId: string | null = null;
    if (req.body?.pending !== undefined) {
      const user = await userFromPending(req.body.pending);
      if (!user) { res.status(401).json({ error: 'Your login has expired — start again' }); return; }
      userId = user.id;
    }
    res.json(await authenticationOptions(userId));
  } catch (err) {
    passkeyFail(res, err, 'Passkey options');
  }
});

// POST /api/auth/login/passkey — { nonce, response, trustDevice }: the signed
// challenge → a session. Both factors at once (§3.4), no password.
router.post('/login/passkey', loginLimiter, async (req: Request, res: Response) => {
  try {
    const { userId } = await verifyAuthentication(String(req.body?.nonce ?? ''), req.body?.response);
    const r = await query(
      `${LOGIN_ROW_SQL} WHERE u.id = $1 AND u.is_active = true AND u.role <> 'freelancer' AND u.login_disabled = false`,
      [userId],
    );
    const user = r.rows[0] as LoginRow | undefined;
    if (!user) { res.status(401).json({ error: 'That login is no longer active' }); return; }
    await clearLoginFailures(user.id);
    await finishSecondFactor(req, res, user);
  } catch (err) {
    passkeyFail(res, err, 'Passkey login');
  }
});

// POST /api/auth/login/recovery — { pending, recoveryCode, trustDevice }: an
// admin without their passkey to hand. Each code works once.
router.post('/login/recovery', loginLimiter, async (req: Request, res: Response) => {
  try {
    const user = await userFromPending(req.body?.pending);
    if (!user) { res.status(401).json({ error: 'Your login has expired — start again' }); return; }
    if (user.role !== 'admin') { res.status(403).json({ error: 'Recovery codes are for admin logins; ask an admin to reset yours.' }); return; }
    if (!(await useRecoveryCode(user.id, String(req.body?.recoveryCode ?? '')))) {
      await recordLoginFailure(user);
      res.status(401).json({ error: 'That recovery code is not valid (each works once).' });
      return;
    }
    await finishSecondFactor(req, res, user);
  } catch (error) {
    console.error('Recovery login error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/auth/security/passkeys/options — about to add a passkey to MY login
router.post('/security/passkeys/options', authenticate, async (req: AuthRequest, res: Response) => {
  try {
    const r = await query(`${LOGIN_ROW_SQL} WHERE u.id = $1`, [req.user!.id]);
    const me = r.rows[0] as LoginRow | undefined;
    if (!me) { res.status(404).json({ error: 'User not found' }); return; }
    const name = [me.preferred_name || me.first_name, me.last_name].filter(Boolean).join(' ') || me.email;
    res.json(await registrationOptions({ id: me.id, email: me.email, name }));
  } catch (err) {
    passkeyFail(res, err, 'Passkey registration options');
  }
});

// POST /api/auth/security/passkeys — { response, label }: the new passkey. Counts
// as enrolment; an ADMIN's first passkey also mints their recovery codes (shown once).
router.post('/security/passkeys', authenticate, async (req: AuthRequest, res: Response) => {
  try {
    const label = String(req.body?.label ?? '') || deviceLabelFrom(req.headers['user-agent']);
    const passkey = await verifyRegistration(req.user!.id, req.body?.response, label);
    await markEnrolled(req.user!.id);
    let recoveryCodes: string[] | null = null;
    if (req.user!.role === 'admin' && (await recoveryCodesLeft(req.user!.id)) === 0) {
      recoveryCodes = await generateRecoveryCodes(req.user!.id);
    }
    res.json({ success: true, passkey, recoveryCodes });
  } catch (err) {
    passkeyFail(res, err, 'Passkey registration');
  }
});

// DELETE /api/auth/security/passkeys/:id — remove one of my passkeys
router.delete('/security/passkeys/:id', authenticate, async (req: AuthRequest, res: Response) => {
  try {
    const ok = await removePasskey(req.user!.id, String(req.params.id));
    if (!ok) { res.status(404).json({ error: 'Passkey not found' }); return; }
    res.json({ success: true });
  } catch (error) {
    console.error('Remove passkey error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/auth/security/recovery-codes — a fresh set of ten (admins); the old set is void
router.post('/security/recovery-codes', authenticate, authorize('admin'), async (req: AuthRequest, res: Response) => {
  try {
    res.json({ recoveryCodes: await generateRecoveryCodes(req.user!.id) });
  } catch (error) {
    console.error('Recovery codes error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/auth/security — my own second-factor state and trusted devices
router.get('/security', authenticate, async (req: AuthRequest, res: Response) => {
  try {
    const r = await query(`SELECT id, email, role, mfa_enrolled_at FROM users WHERE id = $1`, [req.user!.id]);
    const me = r.rows[0];
    if (!me) { res.status(404).json({ error: 'User not found' }); return; }
    const current = peekDeviceId(req, me.id);
    const devices = (await listTrustedDevices(me.id)).map((d) => ({ ...d, current: d.id === current }));
    res.json({
      ...(await securityInfo(me)),
      devices,
      passkeys: await listPasskeys(me.id),
      recovery_codes_left: me.role === 'admin' ? await recoveryCodesLeft(me.id) : null,
    });
  } catch (error) {
    console.error('Security state error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/auth/security/send-code — enrolling from My profile: a code to myself
router.post('/security/send-code', authenticate, codeSendLimiter, async (req: AuthRequest, res: Response) => {
  try {
    const r = await query(`${LOGIN_ROW_SQL} WHERE u.id = $1`, [req.user!.id]);
    const me = r.rows[0] as LoginRow | undefined;
    if (!me) { res.status(404).json({ error: 'User not found' }); return; }
    const sent = await sendLoginCode(me, deviceLabelFrom(req.headers['user-agent']));
    if (!sent.ok) { res.status(sent.status).json({ error: sent.error }); return; }
    res.json({ success: true, emailHint: hintEmail(me.email) });
  } catch (error) {
    console.error('Security send-code error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/auth/security/enrol — the code proves the inbox; this device becomes trusted
router.post('/security/enrol', authenticate, loginLimiter, async (req: AuthRequest, res: Response) => {
  try {
    const code = String(req.body?.code ?? '');
    if (!/^\d{6}$/.test(code)) { res.status(400).json({ error: 'Enter the 6-digit code' }); return; }
    const check = await verifyLoginCode(req.user!.id, code);
    if (!check.ok) { res.status(401).json({ error: check.error }); return; }
    await markEnrolled(req.user!.id);
    let deviceId: string | null = null;
    if (req.body?.trustDevice !== false) {
      deviceId = await trustThisDevice(res, req.user!.id, deviceLabelFrom(req.headers['user-agent']));
    }
    res.json({ success: true, mfa_enrolled: true, deviceId });
  } catch (error) {
    console.error('Security enrol error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// DELETE /api/auth/security/devices/:id — forget one of my trusted devices
router.delete('/security/devices/:id', authenticate, async (req: AuthRequest, res: Response) => {
  try {
    const ok = await revokeTrustedDevice(req.user!.id, String(req.params.id));
    if (!ok) { res.status(404).json({ error: 'Device not found' }); return; }
    if (peekDeviceId(req, req.user!.id) === String(req.params.id)) clearDeviceCookie(res);
    res.json({ success: true });
  } catch (error) {
    console.error('Revoke device error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/auth/security/sign-out-everywhere — every refresh token and device, gone
router.post('/security/sign-out-everywhere', authenticate, async (req: AuthRequest, res: Response) => {
  try {
    await signOutEverywhere(req.user!.id);
    clearDeviceCookie(res);
    res.json({ success: true });
  } catch (error) {
    console.error('Sign out everywhere error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/auth/register — create a STAFF login. Manager-tier (the Staff page's
// "Add user"); only an admin may create another admin.
//
// Until Oct 2026 this route had NO auth at all: anyone on the internet could
// POST { role: 'admin' } and get an admin account plus a refresh token. The
// comment said "admin only in production" and nothing enforced it. Never
// loosen this again.
router.post('/register', authenticate, authorize(...MANAGER_ROLES), validate(registerSchema), async (req: AuthRequest, res: Response) => {
  try {
    const { email, password, first_name, last_name, role } = req.body;

    if (role === 'admin' && req.user?.role !== 'admin') {
      res.status(403).json({ error: 'Only an admin can create an admin login' });
      return;
    }

    // Check if email already exists
    const existing = await query('SELECT id FROM users WHERE email = $1', [email.toLowerCase()]);
    if (existing.rows.length > 0) {
      res.status(409).json({ error: 'Email already registered' });
      return;
    }

    const passwordHash = await bcrypt.hash(password, 12);

    // Create person record first
    const personResult = await query(
      'INSERT INTO people (first_name, last_name, email, created_by) VALUES ($1, $2, $3, $4) RETURNING id',
      [first_name, last_name, email.toLowerCase(), 'system']
    );

    // Create user account linked to person
    const userResult = await query(
      'INSERT INTO users (email, password_hash, role, person_id) VALUES ($1, $2, $3, $4) RETURNING id, email, role',
      [email.toLowerCase(), passwordHash, role, personResult.rows[0].id]
    );

    const user = userResult.rows[0];
    const tokens = generateTokens(user);

    await query('UPDATE users SET refresh_token = $1 WHERE id = $2', [tokens.refreshToken, user.id]);

    // Materialise any all-staff / role-targeted staff documents for the new user.
    if (role !== 'freelancer') {
      import('../services/staff-documents')
        .then((m) => m.syncAllActiveDocuments())
        .catch((e) => console.error('Staff-document sync on register failed:', e));
    }

    res.status(201).json({
      user: { id: user.id, email: user.email, role: user.role, first_name, last_name },
      ...tokens,
    });
  } catch (error) {
    console.error('Registration error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/auth/refresh
router.post('/refresh', refreshLimiter, async (req: Request, res: Response) => {
  try {
    const { refreshToken } = req.body;

    if (!refreshToken) {
      res.status(400).json({ error: 'Refresh token required' });
      return;
    }

    const decoded = verifyFor<{ id: string; type: string }>('staff_refresh', refreshToken);
    if (!decoded) {
      res.status(401).json({ error: 'Invalid or expired refresh token' });
      return;
    }

    if (decoded.type !== 'refresh') {
      res.status(401).json({ error: 'Invalid token type' });
      return;
    }

    const result = await query(
      `SELECT u.*, p.first_name, p.last_name, p.preferred_name
       FROM users u JOIN people p ON u.person_id = p.id
       WHERE u.id = $1 AND u.refresh_token = $2 AND u.is_active = true AND u.role <> 'freelancer'
         AND u.login_disabled = false`,
      [decoded.id, refreshToken]
    );

    if (result.rows.length === 0) {
      res.status(401).json({ error: 'Invalid refresh token' });
      return;
    }

    const user = result.rows[0];

    // Don't rotate the refresh token on refresh — rotation races between open
    // tabs. Refresh tokens still rotate on login + are cleared on logout +
    // nulled when a user is deactivated, so exposure stays bounded.
    const accessToken = signFor('staff', { id: user.id, email: user.email, role: user.role }, JWT_EXPIRES_IN);

    res.json({ accessToken, refreshToken });
  } catch {
    res.status(401).json({ error: 'Invalid or expired refresh token' });
  }
});

// POST /api/auth/logout
router.post('/logout', authenticate, async (req: AuthRequest, res: Response) => {
  try {
    await query('UPDATE users SET refresh_token = NULL WHERE id = $1', [req.user!.id]);
    res.json({ success: true });
  } catch (error) {
    console.error('Logout error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/auth/me
router.get('/me', authenticate, async (req: AuthRequest, res: Response) => {
  try {
    const result = await query(
      `SELECT u.id, u.email, u.role, u.avatar_url, u.force_password_change,
              u.cot_card_last4, u.mfa_enrolled_at,
              p.first_name, p.last_name, p.preferred_name
       FROM users u JOIN people p ON u.person_id = p.id
       WHERE u.id = $1`,
      [req.user!.id]
    );

    if (result.rows.length === 0) {
      res.status(404).json({ error: 'User not found' });
      return;
    }

    const { mfa_enrolled_at: _enrolledAt, ...row } = result.rows[0];
    res.json({ ...row, ...(await securityInfo(result.rows[0])) });
  } catch (error) {
    console.error('Get user error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// PUT /api/auth/profile — update own profile (name, preferred name)
router.put('/profile', authenticate, validate(updateProfileSchema), async (req: AuthRequest, res: Response) => {
  try {
    const { first_name, last_name, preferred_name, cot_card_last4 } = req.body as {
      first_name?: string; last_name?: string;
      preferred_name?: string | null; cot_card_last4?: string | null
    };
    const userId = req.user!.id;

    // people fields (name)
    const peopleUpdates: string[] = [];
    const peopleParams: unknown[] = [];
    let idx = 1;
    if (first_name) { peopleUpdates.push(`first_name = $${idx++}`); peopleParams.push(first_name); }
    if (last_name)  { peopleUpdates.push(`last_name = $${idx++}`);  peopleParams.push(last_name); }
    // `!== undefined`, not a truthy test: '' is how the form says "clear it",
    // and a truthy test would silently ignore that and keep the old value.
    if (preferred_name !== undefined) {
      peopleUpdates.push(`preferred_name = $${idx++}`);
      peopleParams.push(preferred_name?.trim() || null);
    }

    // users fields (COT card last 4)
    const usersUpdates: string[] = [];
    const usersParams: unknown[] = [];
    if (cot_card_last4 !== undefined) {
      usersUpdates.push(`cot_card_last4 = $1`);
      usersParams.push(cot_card_last4); // null clears, string sets
    }

    if (!peopleUpdates.length && !usersUpdates.length) {
      res.status(400).json({ error: 'No fields to update' });
      return;
    }

    if (peopleUpdates.length) {
      peopleParams.push(userId);
      await query(
        `UPDATE people SET ${peopleUpdates.join(', ')}, updated_at = NOW()
         WHERE id = (SELECT person_id FROM users WHERE id = $${idx})`,
        peopleParams
      );
    }
    if (usersUpdates.length) {
      usersParams.push(userId);
      await query(
        `UPDATE users SET ${usersUpdates.join(', ')} WHERE id = $${usersParams.length}`,
        usersParams
      );
    }

    // Return updated user
    const result = await query(
      `SELECT u.id, u.email, u.role, u.avatar_url, u.force_password_change,
              u.cot_card_last4,
              p.first_name, p.last_name, p.preferred_name
       FROM users u JOIN people p ON u.person_id = p.id
       WHERE u.id = $1`,
      [userId]
    );

    res.json(result.rows[0]);
  } catch (error) {
    console.error('Profile update error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/auth/change-password — change own password
router.post('/change-password', authenticate, validate(changePasswordSchema), async (req: AuthRequest, res: Response) => {
  try {
    const { current_password, new_password } = req.body;
    const userId = req.user!.id;

    // Verify current password
    const result = await query('SELECT password_hash FROM users WHERE id = $1', [userId]);
    if (result.rows.length === 0) {
      res.status(404).json({ error: 'User not found' });
      return;
    }

    const valid = await bcrypt.compare(current_password, result.rows[0].password_hash);
    if (!valid) {
      res.status(401).json({ error: 'Current password is incorrect' });
      return;
    }

    const newHash = await bcrypt.hash(new_password, 12);
    await query(
      'UPDATE users SET password_hash = $1, force_password_change = false, password_changed_at = NOW() WHERE id = $2',
      [newHash, userId]
    );

    res.json({ success: true, message: 'Password changed successfully' });
  } catch (error) {
    console.error('Change password error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/auth/avatar — upload profile photo
router.post('/avatar', authenticate, avatarUpload.single('avatar'), async (req: AuthRequest, res: Response) => {
  try {
    if (!isR2Configured()) {
      res.status(503).json({ error: 'File storage not configured' });
      return;
    }

    if (!req.file) {
      res.status(400).json({ error: 'No image provided' });
      return;
    }

    const userId = req.user!.id;
    const ext = path.extname(req.file.originalname).toLowerCase();
    const key = `avatars/${userId}/${uuid()}${ext}`;

    // Delete old avatar if exists
    const existing = await query('SELECT avatar_url FROM users WHERE id = $1', [userId]);
    if (existing.rows[0]?.avatar_url) {
      try {
        await deleteFromR2(existing.rows[0].avatar_url);
      } catch {
        // Old avatar may already be deleted, continue
      }
    }

    await uploadToR2(key, req.file.buffer, req.file.mimetype);
    await query('UPDATE users SET avatar_url = $1 WHERE id = $2', [key, userId]);

    res.json({ avatar_url: key });
  } catch (error) {
    console.error('Avatar upload error:', error);
    if (error instanceof multer.MulterError && error.code === 'LIMIT_FILE_SIZE') {
      res.status(413).json({ error: 'Image too large (max 5MB)' });
      return;
    }
    const message = error instanceof Error ? error.message : 'Upload failed';
    res.status(500).json({ error: message });
  }
});

// DELETE /api/auth/avatar — remove profile photo
router.delete('/avatar', authenticate, async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user!.id;
    const existing = await query('SELECT avatar_url FROM users WHERE id = $1', [userId]);

    if (existing.rows[0]?.avatar_url) {
      try {
        await deleteFromR2(existing.rows[0].avatar_url);
      } catch {
        // Continue even if R2 delete fails
      }
    }

    await query('UPDATE users SET avatar_url = NULL WHERE id = $1', [userId]);
    res.json({ success: true });
  } catch (error) {
    console.error('Avatar delete error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/auth/avatar/:filename — public avatar endpoint (no auth required)
// Looks up which user owns this avatar file and streams it from R2
router.get('/avatar/:filename', async (req: Request, res: Response) => {
  try {
    const { filename } = req.params;
    // Validate filename to prevent path traversal
    if (!filename || filename.includes('/') || filename.includes('..')) {
      res.status(400).json({ error: 'Invalid filename' });
      return;
    }

    if (!isR2Configured()) {
      console.error('[Avatar GET] R2 not configured');
      res.status(503).json({ error: 'File storage not configured' });
      return;
    }

    // Find user with this avatar filename
    const result = await query(
      "SELECT avatar_url FROM users WHERE avatar_url LIKE $1 LIMIT 1",
      [`%/${filename}`]
    );

    if (!result.rows[0]?.avatar_url) {
      console.error(`[Avatar GET] No DB row found for filename: ${filename}`);
      res.status(404).json({ error: 'Avatar not found' });
      return;
    }

    const key = result.rows[0].avatar_url;
    console.log(`[Avatar GET] Found key in DB: ${key}, fetching from R2...`);
    const object = await getFromR2(key);

    if (!object.Body) {
      console.error(`[Avatar GET] R2 returned no Body for key: ${key}`);
      res.status(404).json({ error: 'Avatar not found in storage' });
      return;
    }

    console.log(`[Avatar GET] Streaming avatar, ContentType=${object.ContentType}, ContentLength=${object.ContentLength}`);
    // Cache for 1 hour (avatars don't change often)
    res.setHeader('Cache-Control', 'public, max-age=3600');
    if (object.ContentType) {
      res.setHeader('Content-Type', object.ContentType);
    }
    if (object.ContentLength) {
      res.setHeader('Content-Length', object.ContentLength.toString());
    }

    const stream = object.Body as NodeJS.ReadableStream;
    stream.pipe(res);
  } catch (error) {
    console.error('[Avatar GET] Error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
