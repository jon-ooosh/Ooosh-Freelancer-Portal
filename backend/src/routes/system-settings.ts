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
