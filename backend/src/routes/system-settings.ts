/**
 * System Settings — generic key/text-value config (gate codes, addresses, URLs, toggles).
 * Distinct from calculator_settings (DECIMAL only) and picklist_items (lists).
 *
 * Read: any authenticated staff role. Write: admin/manager only.
 */
import { Router, Response } from 'express';
import { z } from 'zod';
import { query } from '../config/database';
import { authenticate, authorize, AuthRequest } from '../middleware/auth';
import { validate } from '../middleware/validate';

const router = Router();
router.use(authenticate);

// GET /api/system-settings — list all (optionally filtered by category)
router.get('/', async (req: AuthRequest, res: Response) => {
  try {
    const category = typeof req.query.category === 'string' ? req.query.category : null;
    const result = category
      ? await query(
          `SELECT key, value, label, category, value_type, sort_order
           FROM system_settings WHERE category = $1 ORDER BY sort_order, key`,
          [category]
        )
      : await query(
          `SELECT key, value, label, category, value_type, sort_order
           FROM system_settings ORDER BY category, sort_order, key`
        );
    res.json({ data: result.rows });
  } catch (error) {
    console.error('[system-settings] list error:', error);
    res.status(500).json({ error: 'Failed to load system settings' });
  }
});

// PUT /api/system-settings — bulk update (admin/manager only)
const updateSchema = z.object({
  settings: z.record(z.string(), z.string().nullable()),
});

router.put('/', authorize('admin', 'manager'), validate(updateSchema), async (req: AuthRequest, res: Response) => {
  try {
    const { settings } = req.body as z.infer<typeof updateSchema>;
    for (const [key, value] of Object.entries(settings)) {
      await query(
        `UPDATE system_settings SET value = $1, updated_at = NOW(), updated_by = $2 WHERE key = $3`,
        [value, req.user!.id, key]
      );
    }
    invalidateSystemSettingsCache();
    res.json({ success: true });
  } catch (error) {
    console.error('[system-settings] update error:', error);
    res.status(500).json({ error: 'Failed to update system settings' });
  }
});

// ── TEMPORARY: SMS connectivity test ─────────────────────────────────
// Powers the "Send test SMS" button in the OOH Settings section. Confirms the
// Twilio credentials work end-to-end without waiting for a van to approach base.
// In test mode (SMS_MODE=test) the message redirects to SMS_TEST_REDIRECT
// regardless of the number entered.
// REMOVE this route + the Settings button + smsService.sendTest() once go-live
// is confirmed. Tracked in the GitHub reminder issue.
router.post('/test-sms', authorize('admin', 'manager'), async (req: AuthRequest, res: Response) => {
  try {
    const { smsService } = await import('../services/sms-service');
    const supplied = typeof req.body?.to === 'string' ? req.body.to.trim() : '';
    const to = supplied || process.env.SMS_TEST_REDIRECT || '';
    if (!to) {
      return res.status(400).json({ error: 'No number supplied and SMS_TEST_REDIRECT is not set.' });
    }
    const result = await smsService.sendTest(to);
    if (!result.success) {
      return res.status(result.skipped ? 503 : 502).json({ error: result.error || 'SMS send failed' });
    }
    res.json({ success: true, redirectedTo: result.redirectedTo || null });
  } catch (error) {
    console.error('[system-settings] test-sms error:', error);
    res.status(500).json({ error: 'Test SMS failed' });
  }
});

// TEMPORARY: run the OOH approach geofence scan on demand (the cron only runs
// 17:00–08:59). Lets staff test the geofence in daylight. REMOVE with the test
// SMS button after go-live. Tracked in the GitHub reminder issue.
router.post('/run-ooh-scan', authorize('admin', 'manager'), async (_req: AuthRequest, res: Response) => {
  try {
    const { runOohApproachScan } = await import('../services/ooh-sms-approach');
    const summary = await runOohApproachScan();
    res.json({ success: true, ...summary });
  } catch (error) {
    console.error('[system-settings] run-ooh-scan error:', error);
    res.status(500).json({ error: 'Scan failed' });
  }
});

export default router;

// ── Helper for backend code that needs to read settings ──────────────

/**
 * Look up a single system_settings value by key. Returns null if missing/empty.
 * Cached briefly in-process to avoid hammering the DB on each email send.
 */
const cache = new Map<string, { value: string | null; expiresAt: number }>();
const CACHE_MS = 60_000;

export async function getSystemSetting(key: string): Promise<string | null> {
  const now = Date.now();
  const cached = cache.get(key);
  if (cached && cached.expiresAt > now) return cached.value;

  const result = await query(
    `SELECT value FROM system_settings WHERE key = $1`,
    [key]
  );
  const value = (result.rows[0]?.value as string | null | undefined) ?? null;
  cache.set(key, { value, expiresAt: now + CACHE_MS });
  return value;
}

export async function getSystemSettings(keys: string[]): Promise<Record<string, string | null>> {
  const out: Record<string, string | null> = {};
  for (const k of keys) out[k] = await getSystemSetting(k);
  return out;
}

export function invalidateSystemSettingsCache(): void {
  cache.clear();
}
