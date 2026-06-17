/**
 * OOH approach reminder.
 *
 * Runs frequently during closed hours (scheduler: every 3 min, 17:00–08:59
 * Europe/London). For each van that's out on an OOH-flagged hire and hasn't
 * confirmed its parking yet, checks the live Traccar position; when the van
 * comes within the geofence radius of base, texts the driver the parking link.
 *
 * One-shot per assignment via `ooh_sms_sent_at`. Non-blocking — anything that
 * can't be texted (no/invalid number, country off the allowlist, no GPS fix)
 * is simply skipped; the driver still has the two OOH emails, so no regression.
 *
 * Part 1 of docs/OOH-SMS-AND-COMPLIANCE-SPEC.md.
 */
import { randomBytes } from 'node:crypto';
import { getCountryCallingCode, type CountryCode } from 'libphonenumber-js';
import { query } from '../config/database';
import { getLatestPositionForReg } from './traccar-server';
import { getSystemSettings } from '../routes/system-settings';
import { smsService, normaliseMsisdn } from './sms-service';
import { getFrontendUrl } from '../config/app-urls';

/** Great-circle distance in miles. */
function haversineMiles(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 3958.8; // Earth radius in miles
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// Skip a fix older than this — don't text on a stale position.
const MAX_FIX_AGE_SECONDS = 20 * 60;

export async function runOohApproachScan(): Promise<{
  checked: number;
  texted: number;
  skipped: number;
}> {
  const out = { checked: 0, texted: 0, skipped: 0 };

  if (!smsService.isConfigured()) return out;

  const settings = await getSystemSettings([
    'ooh_base_lat',
    'ooh_base_lng',
    'ooh_sms_radius_miles',
    'ooh_sms_country_allowlist',
  ]);
  const baseLat = parseFloat(settings.ooh_base_lat || '');
  const baseLng = parseFloat(settings.ooh_base_lng || '');
  if (!isFinite(baseLat) || !isFinite(baseLng)) {
    console.warn('[ooh-sms] base lat/lng not set — skipping approach scan');
    return out;
  }
  const radius = parseFloat(settings.ooh_sms_radius_miles || '1') || 1;

  // Allowlist is matched on calling code ("44"), not ISO region — +44 is shared
  // across GB/GG/JE/IM so a real UK mobile can resolve to "GG". Config entries
  // may be ISO codes ("GB") or dialling codes ("+44"/"44"); both → calling code.
  const allowCodes = new Set<string>();
  for (const entry of (settings.ooh_sms_country_allowlist || 'GB').split(',').map(s => s.trim()).filter(Boolean)) {
    if (/^\+?\d{1,4}$/.test(entry)) {
      allowCodes.add(entry.replace(/^\+/, ''));
    } else if (/^[A-Za-z]{2}$/.test(entry)) {
      try {
        allowCodes.add(getCountryCallingCode(entry.toUpperCase() as CountryCode));
      } catch {
        /* unknown ISO code — ignore */
      }
    }
  }

  // Armed set: OOH-flagged, still out, not yet confirmed, not yet texted, has a
  // van + a phone, and the hire is due back today/tomorrow (kills the "drives
  // past base mid-tour" false fire).
  const result = await query(
    `SELECT
       vha.id                AS assignment_id,
       fv.reg                AS vehicle_reg,
       d.full_name           AS driver_name,
       d.phone               AS driver_phone,
       d.phone_country       AS driver_phone_country,
       vha.ooh_parking_token AS parking_token
     FROM vehicle_hire_assignments vha
     JOIN jobs j ON j.id = vha.job_id
     LEFT JOIN fleet_vehicles fv ON fv.id = vha.vehicle_id
     LEFT JOIN drivers d ON d.id = vha.driver_id
     WHERE vha.return_overnight = TRUE
       AND vha.status IN ('booked_out', 'active')
       AND vha.ooh_returned_at IS NULL
       AND vha.ooh_sms_sent_at IS NULL
       AND vha.vehicle_id IS NOT NULL
       AND fv.reg IS NOT NULL
       AND d.phone IS NOT NULL
       AND COALESCE(vha.hire_end, j.job_end::date) <= (CURRENT_DATE + INTERVAL '1 day')::date`,
  );

  interface Row {
    assignment_id: string;
    vehicle_reg: string;
    driver_name: string | null;
    driver_phone: string | null;
    driver_phone_country: string | null;
    parking_token: string | null;
  }

  for (const row of result.rows as Row[]) {
    out.checked++;

    const msisdn = normaliseMsisdn(row.driver_phone, row.driver_phone_country);
    if (!msisdn) {
      out.skipped++;
      continue;
    }
    if (allowCodes.size > 0 && !allowCodes.has(msisdn.callingCode)) {
      out.skipped++;
      continue;
    }

    const pos = await getLatestPositionForReg(row.vehicle_reg);
    if (!pos || pos.ageSeconds > MAX_FIX_AGE_SECONDS) {
      out.skipped++;
      continue;
    }

    const dist = haversineMiles(pos.latitude, pos.longitude, baseLat, baseLng);
    if (dist > radius) {
      out.skipped++;
      continue;
    }

    // Within range. Ensure a parking token exists (book-out usually set one).
    let token = row.parking_token;
    if (!token) {
      token = randomBytes(24).toString('base64url');
      await query(
        `UPDATE vehicle_hire_assignments SET ooh_parking_token = $1 WHERE id = $2`,
        [token, row.assignment_id],
      );
    }

    const parkingFormUrl = `${getFrontendUrl()}/return-parking/${token}`;
    const send = await smsService.send('ooh_return_approach', {
      to: msisdn.e164,
      variables: {
        driverName: row.driver_name || 'there',
        vehicleReg: row.vehicle_reg,
        parkingFormUrl,
      },
    });

    if (send.success) {
      await query(
        `UPDATE vehicle_hire_assignments SET ooh_sms_sent_at = NOW() WHERE id = $1`,
        [row.assignment_id],
      );
      out.texted++;
    } else {
      out.skipped++;
    }
  }

  return out;
}
