/**
 * The kiosk tablet lock (services/kiosk-devices.ts, STAFF-LOGIN-SECURITY-SPEC §9).
 *
 * Properties that are load-bearing:
 *
 *   1. **The lock fails closed.** Only an explicit 'false' turns it off — a
 *      missing or mistyped setting must lock the PIN, never open it.
 *   2. **A set-up code is forgiving to type and works once.** Case, spaces and
 *      the dash don't matter; the code is stored hashed and the row is made live
 *      in the same statement that clears the hash.
 *   3. **Only a kiosk_device cookie names a tablet.** A token minted for any
 *      other audience (a staff trusted device, say) is not one, and is refused
 *      before the database is asked.
 */
jest.mock('../../config/database', () => ({ query: jest.fn(), getClient: jest.fn() }));
jest.mock('../../routes/system-settings', () => ({ getSystemSetting: jest.fn() }));
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-only-jwt-secret';

// Required, not imported: an import is hoisted above the env line.
/* eslint-disable @typescript-eslint/no-var-requires */
const { query } = require('../../config/database');
const { getSystemSetting } = require('../../routes/system-settings');
const kd = require('../kiosk-devices') as typeof import('../kiosk-devices');
const { signFor } = require('../tokens') as typeof import('../tokens');

const mockQuery = query as jest.Mock;
const mockSetting = getSystemSetting as jest.Mock;
const ADMIN = '587685f2-68f0-443d-ab1a-0129dbfe8f42';
const TABLET = '7d0c2b4e-5a61-4f3e-9c8d-1b2a3c4d5e6f';

function fakeRes() {
  return { cookie: jest.fn() } as unknown as import('express').Response & { cookie: jest.Mock };
}

beforeEach(() => {
  mockQuery.mockReset();
  mockSetting.mockReset();
});

describe('kioskDeviceLockOn', () => {
  it.each([
    [null, true],
    ['', true],
    ['true', true],
    ['yes please', true],
    ['false', false],
    [' FALSE ', false],
  ])('setting %p → lock on = %p', async (value, on) => {
    mockSetting.mockResolvedValue(value);
    expect(await kd.kioskDeviceLockOn()).toBe(on);
  });
});

describe('set-up codes', () => {
  it('are XXXX-XXXX from an alphabet with no 0, O, 1 or I', () => {
    for (let i = 0; i < 200; i++) {
      expect(kd.newSetupCode()).toMatch(/^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/);
    }
  });

  it('ignore case, spaces and the dash when typed', () => {
    expect(kd.normaliseSetupCode(' k7mp-q4xr ')).toBe('K7MPQ4XR');
    expect(kd.normaliseSetupCode('K7MP Q4XR')).toBe('K7MPQ4XR');
    expect(kd.normaliseSetupCode(undefined)).toBe('');
  });

  it('typed loosely on the tablet, match the hash stored when the admin made it', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ id: TABLET, label: 'Warehouse iPad', setup_expires_at: new Date() }] });
    const made = await kd.startKioskSetup('Warehouse iPad', ADMIN);
    const storedHash = mockQuery.mock.calls[0][1][1];
    expect(storedHash).toMatch(/^[0-9a-f]{64}$/);
    expect(storedHash).not.toContain(made.code); // hashed at rest

    mockQuery.mockResolvedValueOnce({ rows: [{ id: TABLET, label: 'Warehouse iPad' }] });
    const res = fakeRes();
    const typed = made.code.toLowerCase().replace('-', ' ');
    expect(await kd.completeKioskSetup(res, typed)).toEqual({ label: 'Warehouse iPad' });
    const [sql, params] = mockQuery.mock.calls[1];
    expect(params[0]).toBe(storedHash);
    // Made live and the code spent in ONE statement, and only while it is live.
    expect(sql).toMatch(/SET activated_at = NOW\(\), setup_code_hash = NULL/);
    expect(sql).toMatch(/activated_at IS NULL AND revoked_at IS NULL/);
    expect(sql).toMatch(/setup_expires_at > NOW\(\)/);
    // The tablet's cookie: httpOnly, the warehouse routes only.
    expect(res.cookie).toHaveBeenCalledWith('op_kiosk_device', expect.any(String),
      expect.objectContaining({ httpOnly: true, path: '/api/warehouse', sameSite: 'strict' }));
  });

  it('a wrong, used or expired code sets no cookie', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    const res = fakeRes();
    expect(await kd.completeKioskSetup(res, 'ABCD-EFGH')).toBeNull();
    expect(res.cookie).not.toHaveBeenCalled();
  });

  it('a code of the wrong length never reaches the database', async () => {
    const res = fakeRes();
    expect(await kd.completeKioskSetup(res, '1234')).toBeNull();
    expect(mockQuery).not.toHaveBeenCalled();
  });
});

describe('kioskDeviceFrom', () => {
  const reqWith = (cookie?: string) =>
    ({ cookies: cookie ? { op_kiosk_device: cookie } : {} }) as unknown as import('express').Request;

  it('no cookie → not a tablet, and no query', async () => {
    expect(await kd.kioskDeviceFrom(reqWith())).toBeNull();
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('a token for another audience is not a tablet, and no query', async () => {
    const other = signFor('trusted_device', { deviceId: TABLET, userId: ADMIN }, '1d');
    expect(await kd.kioskDeviceFrom(reqWith(other))).toBeNull();
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('a live tablet is found by the id in its cookie', async () => {
    const cookie = signFor('kiosk_device', { deviceId: TABLET }, '1d');
    mockQuery.mockResolvedValueOnce({ rows: [{ id: TABLET }] });
    expect(await kd.kioskDeviceFrom(reqWith(cookie))).toBe(TABLET);
    const [sql, params] = mockQuery.mock.calls[0];
    expect(params).toEqual([TABLET]);
    expect(sql).toMatch(/activated_at IS NOT NULL AND revoked_at IS NULL/);
  });

  it('a forgotten tablet (no live row) is not a tablet', async () => {
    const cookie = signFor('kiosk_device', { deviceId: TABLET }, '1d');
    mockQuery.mockResolvedValueOnce({ rows: [] });
    expect(await kd.kioskDeviceFrom(reqWith(cookie))).toBeNull();
  });
});
