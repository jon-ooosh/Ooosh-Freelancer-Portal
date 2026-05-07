/**
 * Vehicle notification recipient helper.
 *
 * Centralises who gets vehicle-related alerts (insurance referrals,
 * mid-tour drivers, fleet compliance — MOT/Tax/Insurance/TFL).
 *
 * Direct emails go to info@ (catch-all shared mailbox, anyone in office
 * can pick up) with will@ CC'd (vehicle manager). Bell notifications
 * go ONLY to Will so he sees them in his OP inbox UI without spamming
 * other admins/managers who don't look after vehicles.
 *
 * info@ is hardcoded as the guaranteed fallback. If Will isn't found in
 * the users table (deactivated etc.), the email path still fires — info@
 * always gets the message.
 */

import { query } from '../config/database';

const PRIMARY_EMAIL = 'info@oooshtours.co.uk';
const VEHICLE_MANAGER_EMAIL = 'will@oooshtours.co.uk';

export interface VehicleNotificationTargets {
  /** Primary email recipient — always info@ */
  to: string;
  /** CC list — vehicle manager (Will) when reachable */
  cc: string[];
  /** Bell-notification user IDs — Will only when he's an active user */
  bellUserIds: string[];
}

let cachedTargets: VehicleNotificationTargets | null = null;
let cachedAt = 0;
const CACHE_TTL_MS = 5 * 60 * 1000;

/**
 * Returns recipients for vehicle-related alerts.
 *
 * Cached for 5 minutes. If you've just added/activated Will's user
 * record and need the bell to start firing immediately, call
 * `clearVehicleNotificationCache()`.
 */
export async function getVehicleNotificationTargets(): Promise<VehicleNotificationTargets> {
  if (cachedTargets && Date.now() - cachedAt < CACHE_TTL_MS) {
    return cachedTargets;
  }

  const bellUserIds: string[] = [];
  try {
    const result = await query(
      `SELECT id FROM users WHERE LOWER(email) = LOWER($1) AND is_active = true LIMIT 1`,
      [VEHICLE_MANAGER_EMAIL],
    );
    if (result.rows.length > 0) {
      bellUserIds.push(result.rows[0].id as string);
    } else {
      console.warn(
        `[vehicle-notify] No active user found for ${VEHICLE_MANAGER_EMAIL} — bell notifications will not fire, but emails to info@ + cc will@ still will.`,
      );
    }
  } catch (err) {
    console.error('[vehicle-notify] User lookup failed:', err);
  }

  cachedTargets = {
    to: PRIMARY_EMAIL,
    cc: [VEHICLE_MANAGER_EMAIL],
    bellUserIds,
  };
  cachedAt = Date.now();
  return cachedTargets;
}

export function clearVehicleNotificationCache(): void {
  cachedTargets = null;
  cachedAt = 0;
}
