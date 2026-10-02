/**
 * The van's GPS trace around an incident (docs/INCIDENT-CLAIMS-SPEC.md §14, §21).
 *
 * Staff look at the route on the case page and press Attach to keep it: the
 * points are saved as a CSV case file (`gps_trace`, not shared with insurers
 * unless ticked) and the page redraws the route from that saved copy — no map
 * image (capturing map tiles in a browser is fragile, and the points are the
 * evidence).
 *
 * Traccar's history may not last until a late (e.g. third-party) claim
 * arrives, so the daily job also saves one trace per case on its own as soon
 * as the incident date is known — ±1 hour when the time is known, else the
 * whole day — stamped on gps_auto_captured_at so it's tried once (a Traccar
 * error un-stamps it, so an outage doesn't lose it).
 */
import { v4 as uuid } from 'uuid';
import { query } from '../config/database';
import { uploadToR2 } from '../config/r2';
import { getRouteForReg, type RoutePoint } from './traccar-server';
import { logClaimEvent, ukDatePlus } from './incident-claims';

/** Longest window anyone may ask Traccar for in one go. */
export const MAX_WINDOW_HOURS = 48;

/** Offset of Europe/London from UTC at a moment, in minutes (60 in BST, 0 in GMT). */
function londonOffsetMinutes(at: Date): number {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/London', hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
  }).formatToParts(at);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'));
  return Math.round((asUtc - at.getTime()) / 60000);
}

/** A UK wall-clock time on a date → the real moment. */
export function ukLocalToUtc(date: string, hour: number, minute: number): Date {
  const [y, m, d] = date.split('-').map(Number);
  const guess = new Date(Date.UTC(y, m - 1, d, hour, minute));
  return new Date(guess.getTime() - londonOffsetMinutes(guess) * 60000);
}

/**
 * The time out of the client's free text ("about 3pm", "15:30", "3.30 pm").
 * null when there's no clear time — the caller then uses the whole day.
 */
export function parseIncidentTime(text: string | null | undefined): { hour: number; minute: number } | null {
  if (!text) return null;
  const t = text.toLowerCase();
  let m = /\b(\d{1,2})[:.](\d{2})\s*(am|pm)?\b/.exec(t);
  let hour: number; let minute: number; let ampm: string | undefined;
  if (m) {
    hour = Number(m[1]); minute = Number(m[2]); ampm = m[3];
  } else {
    m = /\b(\d{1,2})\s*(am|pm)\b/.exec(t);
    if (!m) {
      if (/\bnoon\b|\bmidday\b/.test(t)) return { hour: 12, minute: 0 };
      if (/\bmidnight\b/.test(t)) return { hour: 0, minute: 0 };
      return null;
    }
    hour = Number(m[1]); minute = 0; ampm = m[2];
  }
  if (ampm) {
    if (hour < 1 || hour > 12) return null;
    if (ampm === 'pm' && hour !== 12) hour += 12;
    if (ampm === 'am' && hour === 12) hour = 0;
  }
  if (hour > 23 || minute > 59) return null;
  return { hour, minute };
}

/** The window to show / save for a case: ±pad around the time, else the whole UK day. */
export function incidentWindow(date: string, timeText: string | null, padMinutes: number): { from: Date; to: Date; timeKnown: boolean } {
  const time = parseIncidentTime(timeText);
  if (time) {
    const at = ukLocalToUtc(date, time.hour, time.minute);
    return { from: new Date(at.getTime() - padMinutes * 60000), to: new Date(at.getTime() + padMinutes * 60000), timeKnown: true };
  }
  const [y, m, d] = date.split('-').map(Number);
  const next = new Date(Date.UTC(y, m - 1, d + 1)).toISOString().slice(0, 10);
  return { from: ukLocalToUtc(date, 0, 0), to: ukLocalToUtc(next, 0, 0), timeKnown: false };
}

function ukStamp(d: Date): string {
  return d.toLocaleString('en-GB', { timeZone: 'Europe/London', dateStyle: 'short', timeStyle: 'short' });
}

function csvCell(v: unknown): string {
  const s = v == null ? '' : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** The saved file: one row per position, UK time alongside UTC. */
export function pointsToCsv(reg: string, points: RoutePoint[]): string {
  const rows = [['vehicle', 'time_utc', 'time_uk', 'latitude', 'longitude', 'speed_kph', 'course', 'address']];
  for (const p of points) {
    rows.push([reg, p.time, ukStamp(new Date(p.time)), String(p.lat), String(p.lng), String(p.speedKph), p.course == null ? '' : String(p.course), p.address || '']);
  }
  return `${rows.map((r) => r.map(csvCell).join(',')).join('\n')}\n`;
}

/** Read a saved trace back (the page draws the route from it). */
export function csvToPoints(csv: string): RoutePoint[] {
  const lines = csv.split(/\r?\n/).filter(Boolean).slice(1);
  const out: RoutePoint[] = [];
  for (const line of lines) {
    const cells = line.match(/("([^"]|"")*"|[^,]*)(,|$)/g)?.map((c) => c.replace(/,$/, '').replace(/^"|"$/g, '').replace(/""/g, '"')) || [];
    const lat = Number(cells[3]); const lng = Number(cells[4]);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;
    out.push({ time: cells[1], lat, lng, speedKph: Number(cells[5]) || 0, course: cells[6] ? Number(cells[6]) : null, address: cells[7] || null });
  }
  return out;
}

/**
 * Fetch the route and save it as a case file. Returns the number of points
 * saved — 0 means Traccar had nothing for that window (nothing is saved).
 * null = no GPS for this van (Traccar not set up, or no device for the reg).
 */
export async function saveGpsTrace(
  claimId: string, reg: string, from: Date, to: Date,
  actor: { userId: string | null; auto: boolean },
): Promise<{ fileId: string; points: number } | { fileId: null; points: number } | null> {
  const points = await getRouteForReg(reg, from, to);
  if (points === null) return null;
  if (!points.length) return { fileId: null, points: 0 };
  const fileId = uuid();
  const stamp = from.toISOString().slice(0, 16).replace(/[-:T]/g, '');
  const key = `claims/${claimId}/gps-${stamp}-${fileId.slice(0, 8)}.csv`;
  const csv = Buffer.from(pointsToCsv(reg, points), 'utf8');
  await uploadToR2(key, csv, 'text/csv');
  const caption = `GPS ${ukStamp(from)} – ${ukStamp(to)} (${points.length} points)${actor.auto ? ', saved automatically' : ''}`;
  await query(
    `INSERT INTO incident_claim_files
       (id, claim_id, r2_key, filename, file_type, content_type, size_bytes, caption, taken_at, uploaded_by, share_with_insurer)
     VALUES ($1, $2, $3, $4, 'gps_trace', 'text/csv', $5, $6, $7, $8, false)`,
    [fileId, claimId, key, `gps-trace-${reg.replace(/\s+/g, '')}-${stamp}.csv`, csv.length, caption, from.toISOString(), actor.userId],
  );
  await logClaimEvent(claimId, actor.userId, 'gps_saved', caption, { file_id: fileId, from: from.toISOString(), to: to.toISOString() });
  return { fileId, points: points.length };
}

/**
 * Daily: one automatic trace per case as soon as there's a van and an incident
 * date that's over (so a whole-day window is complete). Tried once — the stamp
 * is set first, whatever Traccar says.
 */
export async function runClaimGpsAutoCapture(): Promise<{ saved: number; empty: number; noGps: number; failed: number }> {
  const out = { saved: 0, empty: 0, noGps: 0, failed: 0 };
  const today = ukDatePlus(0);
  const due = await query(
    `UPDATE incident_claims c
        SET gps_auto_captured_at = NOW()
       FROM (SELECT id FROM incident_claims
              WHERE is_deleted = false AND gps_auto_captured_at IS NULL
                AND incident_at IS NOT NULL AND vehicle_reg IS NOT NULL
                AND to_char(incident_at AT TIME ZONE 'UTC', 'YYYY-MM-DD') < $1
              LIMIT 25) d
      WHERE c.id = d.id
      RETURNING c.id, c.vehicle_reg, c.incident_time_text,
                to_char(c.incident_at AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS incident_date`,
    [today],
  );
  for (const c of due.rows) {
    try {
      const w = incidentWindow(c.incident_date, c.incident_time_text, 60);
      const r = await saveGpsTrace(c.id, c.vehicle_reg, w.from, w.to, { userId: null, auto: true });
      if (r === null) out.noGps++;
      else if (r.points === 0) {
        out.empty++;
        await logClaimEvent(c.id, null, 'gps_saved',
          `No GPS positions for ${ukStamp(w.from)} – ${ukStamp(w.to)} (van parked, or Traccar no longer has that day)`);
      } else out.saved++;
    } catch (err) {
      // Traccar unreachable / erroring — un-stamp so tomorrow's run tries again.
      out.failed++;
      await query(`UPDATE incident_claims SET gps_auto_captured_at = NULL WHERE id = $1`, [c.id]).catch(() => undefined);
      console.error(`[claim-gps] auto-capture for case ${c.id} failed:`, err);
    }
  }
  return out;
}
