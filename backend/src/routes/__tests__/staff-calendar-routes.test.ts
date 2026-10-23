/**
 * Regression guard: every absence route the frontend calls must exist.
 *
 * Commit 781f2782 (15 Sep 2026) removed the timed absence markers and took
 * POST /absences, GET /absences/:id and GET /me/absences out with them. The
 * Absence page's "Record it" then answered 404 "Not found" for five weeks —
 * found when the first paternity leave was being recorded (Oct 2026). Nothing
 * caught it because the verify script calls the service directly, not the
 * route.
 *
 * This reads the router's own table, so it needs no database — the pool is
 * mocked, and the token module only wants a secret to exist at import time.
 */
import type { Router } from 'express';

jest.mock('../../config/database', () => ({ query: jest.fn(), getClient: jest.fn() }));
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-only-jwt-secret';
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-only-session-secret';

// Required, not imported: an import is hoisted above the env lines.
const router: Router = require('../staff-calendar').default;

interface Layer {
  route?: { path: string; methods: Record<string, boolean> };
}

function has(method: string, path: string): boolean {
  return (router.stack as Layer[]).some(l => l.route?.path === path && l.route.methods[method]);
}

describe('staff-calendar absence routes', () => {
  // StaffAbsencePage.tsx — the Absence page and the Staff page's Absence tab.
  it.each([
    ['get', '/absences'],
    ['post', '/absences'],
    ['get', '/absences/:id'],
    ['post', '/absences/:id/close'],
    ['post', '/absences/:id/rtw'],
    ['post', '/absences/:id/reclaim'],
    ['post', '/absences/:id/cancel'],
    ['get', '/absence-report'],
  ])('%s %s is still there', (method, path) => {
    expect(has(method, path)).toBe(true);
  });

  // MyTimePage.tsx — your own absences, shown as "Absent".
  it('GET /me/absences is still there', () => {
    expect(has('get', '/me/absences')).toBe(true);
  });
});
