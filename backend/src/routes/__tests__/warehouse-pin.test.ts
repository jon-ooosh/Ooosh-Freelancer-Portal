/**
 * POST /api/warehouse/auth/pin — where the kiosk PIN works (STAFF-LOGIN-SECURITY-SPEC §9).
 *
 * Load-bearing:
 *
 *   1. **Where is checked BEFORE the PIN.** A device that isn't a set-up
 *      tablet gets the same 403 whatever was typed, so it can't test guesses.
 *      (Checked after, "403 = right PIN, wrong place" told anyone the PIN was
 *      right — the log on 28 Oct 2026 read exactly that way.)
 *   2. **The 403 says what to do** (`code: 'kiosk_device_required'` opens the
 *      set-up box on the PIN page).
 *   3. **A set-up tablet with the right PIN gets a session and its cookie renewed.**
 *   4. **The lock can be switched off** (`kiosk_device_required = 'false'`).
 *
 * The handler is called directly (no HTTP library in this repo); the pool and
 * the setting store are mocked, so no database is needed.
 */
import type { Router, Request, Response } from 'express';

jest.mock('../../config/database', () => ({ query: jest.fn(), getClient: jest.fn() }));
jest.mock('../system-settings', () => ({ getSystemSetting: jest.fn() }));
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-only-jwt-secret';
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-only-session-secret';
process.env.WAREHOUSE_PIN = '482913';

// Required, not imported: an import is hoisted above the env lines.
/* eslint-disable @typescript-eslint/no-var-requires */
const { query } = require('../../config/database');
const { getSystemSetting } = require('../system-settings');
const router: Router = require('../warehouse').default;
const { signFor, verifyFor } = require('../../services/tokens') as typeof import('../../services/tokens');

const mockQuery = query as jest.Mock;
const mockSetting = getSystemSetting as jest.Mock;
const TABLET = '7d0c2b4e-5a61-4f3e-9c8d-1b2a3c4d5e6f';

interface Layer {
  route?: { path: string; methods: Record<string, boolean>; stack: Array<{ handle: (req: Request, res: Response) => Promise<void> }> };
}

/** The PIN route's own handler (the last in its stack, after the rate limiter). */
function pinHandler() {
  const layer = (router.stack as Layer[]).find(l => l.route?.path === '/auth/pin' && l.route.methods.post);
  if (!layer?.route) throw new Error('POST /auth/pin is missing');
  return layer.route.stack[layer.route.stack.length - 1].handle;
}

function call(pin: string, cookie?: string) {
  const req = { body: { pin }, ip: '::ffff:81.153.150.40', cookies: cookie ? { op_kiosk_device: cookie } : {} } as unknown as Request;
  const out: { status: number; body: any; cookie: jest.Mock } = { status: 200, body: undefined, cookie: jest.fn() };
  const res = {
    status(code: number) { out.status = code; return this; },
    json(body: unknown) { out.body = body; return this; },
    cookie: out.cookie,
  } as unknown as Response;
  return pinHandler()(req, res).then(() => out);
}

function settings(lock: string | null, ips = '') {
  mockSetting.mockImplementation(async (key: string) =>
    key === 'kiosk_device_required' ? lock : key === 'kiosk_allowed_ips' ? ips : null);
}

beforeEach(() => {
  mockQuery.mockReset();
  mockSetting.mockReset();
});

describe('POST /auth/pin with the tablet lock on', () => {
  it('no tablet cookie + WRONG pin → 403 (not 401): nothing to learn about the PIN', async () => {
    settings('true');
    const out = await call('000000');
    expect(out.status).toBe(403);
    expect(out.body.code).toBe('kiosk_device_required');
  });

  it('no tablet cookie + right pin → the same 403', async () => {
    settings('true');
    const out = await call('482913');
    expect(out.status).toBe(403);
    expect(out.body.code).toBe('kiosk_device_required');
    expect(out.body.token).toBeUndefined();
  });

  it('a missing setting counts as ON', async () => {
    settings(null);
    expect((await call('482913')).status).toBe(403);
  });

  it('a set-up tablet + wrong pin → 401', async () => {
    settings('true');
    mockQuery.mockResolvedValueOnce({ rows: [{ id: TABLET }] });
    const out = await call('000000', signFor('kiosk_device', { deviceId: TABLET }, '1d'));
    expect(out.status).toBe(401);
    expect(out.cookie).not.toHaveBeenCalled();
  });

  it('a set-up tablet + right pin → a till-and-collections session, last-used noted, cookie renewed', async () => {
    settings('true');
    mockQuery
      .mockResolvedValueOnce({ rows: [{ id: TABLET }] })   // kioskDeviceFrom
      .mockResolvedValueOnce({ rows: [] });                // markKioskDeviceUsed
    const out = await call('482913', signFor('kiosk_device', { deviceId: TABLET }, '1d'));
    expect(out.status).toBe(200);
    const claims = verifyFor<{ scope: string; scopes: string[] }>('warehouse', out.body.token);
    expect(claims?.scope).toBe('warehouse_session');
    expect(claims?.scopes).toEqual(['collections', 'till']);
    expect(mockQuery.mock.calls[1][1]).toEqual([TABLET, '81.153.150.40']);
    expect(out.cookie).toHaveBeenCalledWith('op_kiosk_device', expect.any(String), expect.objectContaining({ httpOnly: true }));
  });

  it('a forgotten tablet (cookie still on it) → 403', async () => {
    settings('true');
    mockQuery.mockResolvedValueOnce({ rows: [] });
    const out = await call('482913', signFor('kiosk_device', { deviceId: TABLET }, '1d'));
    expect(out.status).toBe(403);
  });
});

describe('POST /auth/pin with the tablet lock off', () => {
  it('any device + right pin → a session, and the database is not asked', async () => {
    settings('false');
    const out = await call('482913');
    expect(out.status).toBe(200);
    expect(typeof out.body.token).toBe('string');
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('a listed address that does not match still refuses, before the PIN', async () => {
    settings('false', '95.144.185.166');
    const out = await call('000000');
    expect(out.status).toBe(403);
  });
});

describe('the tablet routes exist', () => {
  it.each([
    ['post', '/device/setup'],
    ['get', '/devices'],
    ['post', '/devices'],
    ['delete', '/devices/:id'],
  ])('%s %s', (method, path) => {
    expect((router.stack as Layer[]).some(l => l.route?.path === path && l.route.methods[method])).toBe(true);
  });
});
