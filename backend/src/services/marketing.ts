/**
 * The Marketing page — adverts and tracked links (docs/BUSINESS-FIGURES-SPEC.md §8, step 2).
 *
 * Adverts (`marketing_placements`) are where we advertise; tracked links
 * (`marketing_links`) are what goes on the artwork. An enquiry that came through a
 * link carries its code (`job_marketing_source.link_code`, or the campaign tag the
 * link added), so each advert shows scans → enquiries → bookings and its cost per
 * enquiry and per booking. Outcomes use the shared buckets (job-outcomes.ts).
 */
import QRCode from 'qrcode';
import { query } from '../config/database';
import { JOB_BOOKED_SQL, JOB_OUTCOME_SQL } from './job-outcomes';
import { SHORT_LINK_BASE, FALLBACK_URL, deviceOf, forwardUrl, withCentreLogo } from './marketing-links';
import { cancelTask, createTask, listTasksForSource, personIdForUser } from './staff-tasks';

export const CHANNELS = ['print', 'online', 'social', 'search_ads', 'event', 'sponsorship', 'other'] as const;
export const PLACEMENT_STATUSES = ['planned', 'live', 'ended', 'cancelled'] as const;

/** Enquiries that came through a link — by its code, or the campaign tag it adds. */
const LINK_ENQUIRIES_SQL = `
  SELECT COUNT(*)::int AS enquiries,
         COUNT(*) FILTER (WHERE ${JOB_BOOKED_SQL} OR ${JOB_OUTCOME_SQL.cancelled})::int AS booked,
         COALESCE(SUM(j.job_value) FILTER (WHERE ${JOB_BOOKED_SQL}), 0) AS booked_value
    FROM job_marketing_source ms
    JOIN jobs j ON j.id = ms.job_id
   WHERE j.is_deleted = false AND j.dismissed_at IS NULL
     AND (ms.link_code = ANY(codes.list) OR ms.utm_campaign = ANY(codes.list))`;

export interface LinkRow {
  id: string;
  code: string;
  shortUrl: string;
  label: string | null;
  destination: string;
  utmSource: string | null;
  utmMedium: string | null;
  placementId: string | null;
  placementName: string | null;
  isActive: boolean;
  scans: number;
  scans30: number;
  lastScanAt: string | null;
  enquiries: number;
  booked: number;
  bookedValue: number;
}

export async function listLinks(): Promise<LinkRow[]> {
  const r = await query(
    `SELECT l.*, p.name AS placement_name,
            (SELECT COUNT(*)::int FROM marketing_link_scans s WHERE s.link_id = l.id AND s.device IS DISTINCT FROM 'bot') AS scans,
            (SELECT COUNT(*)::int FROM marketing_link_scans s WHERE s.link_id = l.id AND s.device IS DISTINCT FROM 'bot'
                AND s.scanned_at > NOW() - INTERVAL '30 days') AS scans30,
            (SELECT MAX(s.scanned_at) FROM marketing_link_scans s WHERE s.link_id = l.id AND s.device IS DISTINCT FROM 'bot') AS last_scan_at,
            e.enquiries, e.booked, e.booked_value
       FROM marketing_links l
       LEFT JOIN marketing_placements p ON p.id = l.placement_id
       CROSS JOIN LATERAL (SELECT ARRAY[l.code]::text[] AS list) codes
       CROSS JOIN LATERAL (${LINK_ENQUIRIES_SQL}) e
      ORDER BY l.created_at DESC`,
  );
  return r.rows.map((x: Record<string, unknown>) => ({
    id: String(x.id), code: String(x.code), shortUrl: SHORT_LINK_BASE + String(x.code),
    label: (x.label as string) || null, destination: String(x.destination),
    utmSource: (x.utm_source as string) || null, utmMedium: (x.utm_medium as string) || null,
    placementId: (x.placement_id as string) || null, placementName: (x.placement_name as string) || null,
    isActive: !!x.is_active, scans: Number(x.scans) || 0, scans30: Number(x.scans30) || 0,
    lastScanAt: x.last_scan_at ? new Date(x.last_scan_at as string).toISOString() : null,
    enquiries: Number(x.enquiries) || 0, booked: Number(x.booked) || 0, bookedValue: Number(x.booked_value) || 0,
  }));
}

export interface PlacementRow {
  id: string;
  name: string;
  channel: string;
  supplier: string | null;
  cost: number | null;
  startsOn: string | null;
  endsOn: string | null;
  nextDueOn: string | null;
  nextDueNote: string | null;
  proofReceivedOn: string | null;
  artworkUrl: string | null;
  status: string;
  notes: string | null;
  links: number;
  scans: number;
  enquiries: number;
  booked: number;
  bookedValue: number;
}

export async function listPlacements(): Promise<PlacementRow[]> {
  const r = await query(
    `SELECT p.*,
            to_char(p.starts_on, 'YYYY-MM-DD') AS starts, to_char(p.ends_on, 'YYYY-MM-DD') AS ends,
            to_char(p.next_due_on, 'YYYY-MM-DD') AS next_due, to_char(p.proof_received_on, 'YYYY-MM-DD') AS proof_on,
            (SELECT COUNT(*)::int FROM marketing_links l WHERE l.placement_id = p.id) AS links,
            (SELECT COUNT(*)::int FROM marketing_link_scans s JOIN marketing_links l ON l.id = s.link_id
              WHERE l.placement_id = p.id AND s.device IS DISTINCT FROM 'bot') AS scans,
            e.enquiries, e.booked, e.booked_value
       FROM marketing_placements p
       CROSS JOIN LATERAL (SELECT COALESCE(ARRAY(SELECT l.code FROM marketing_links l WHERE l.placement_id = p.id), '{}')::text[] AS list) codes
       CROSS JOIN LATERAL (${LINK_ENQUIRIES_SQL}) e
      ORDER BY CASE p.status WHEN 'live' THEN 0 WHEN 'planned' THEN 1 WHEN 'ended' THEN 2 ELSE 3 END,
               p.starts_on DESC NULLS LAST, p.created_at DESC`,
  );
  return r.rows.map((x: Record<string, unknown>) => ({
    id: String(x.id), name: String(x.name), channel: String(x.channel), supplier: (x.supplier as string) || null,
    cost: x.cost === null ? null : Number(x.cost),
    startsOn: (x.starts as string) || null, endsOn: (x.ends as string) || null,
    nextDueOn: (x.next_due as string) || null, nextDueNote: (x.next_due_note as string) || null,
    proofReceivedOn: (x.proof_on as string) || null, artworkUrl: (x.artwork_url as string) || null,
    status: String(x.status), notes: (x.notes as string) || null,
    links: Number(x.links) || 0, scans: Number(x.scans) || 0,
    enquiries: Number(x.enquiries) || 0, booked: Number(x.booked) || 0, bookedValue: Number(x.booked_value) || 0,
  }));
}

/**
 * The advert's "next one due" as a To Do for whoever set it: one open reminder per
 * advert, replaced when the date or note changes, cancelled when the date is cleared.
 * Never throws — the advert is saved either way.
 */
export async function syncDueReminder(placementId: string, userId: string, role: string | undefined): Promise<void> {
  try {
    const p = await query(
      `SELECT name, to_char(next_due_on, 'YYYY-MM-DD') AS due, next_due_note, status FROM marketing_placements WHERE id = $1`,
      [placementId],
    );
    const row = p.rows[0] as { name: string; due: string | null; next_due_note: string | null; status: string } | undefined;
    const open = (await listTasksForSource('marketing_placement', placementId) as Array<{ id: string; status: string; due_date: string | null; title: string }>)
      .filter((t) => t.status === 'open');
    const title = row ? `Marketing: ${row.next_due_note || 'next one due'} — ${row.name}` : '';
    const wanted = row && row.due && row.status !== 'cancelled' && row.status !== 'ended';
    // Already right? Leave it alone.
    if (wanted && open.length === 1 && open[0].due_date === row!.due && open[0].title === title) return;
    for (const t of open) await cancelTask(t.id, userId, role);
    if (!wanted) return;
    const personId = await personIdForUser(userId);
    if (!personId) return;
    await createTask({ title, dueDate: row!.due, personId, sourceType: 'marketing_placement', sourceId: placementId }, userId, role);
  } catch (err) {
    console.error(`[marketing] reminder for ${placementId} not set (non-fatal):`, err);
  }
}

/** A scan: count it (unless it's a link preview / crawler) and say where to send them. */
export async function resolveScan(code: string, userAgent: string | undefined): Promise<string> {
  const r = await query(
    // Tags left blank on the link come from its advert: who with (as a slug) and the type.
    `SELECT l.id, l.code, l.destination, l.is_active,
            COALESCE(l.utm_source, NULLIF(regexp_replace(regexp_replace(lower(p.supplier), '[^a-z0-9]+', '-', 'g'), '(^-+|-+$)', '', 'g'), '')) AS utm_source,
            COALESCE(l.utm_medium, p.channel) AS utm_medium
       FROM marketing_links l
       LEFT JOIN marketing_placements p ON p.id = l.placement_id
      WHERE l.code = $1`,
    [code.toLowerCase()],
  );
  const link = r.rows[0] as { id: string; code: string; destination: string; utm_source: string | null; utm_medium: string | null; is_active: boolean } | undefined;
  if (!link || !link.is_active) return FALLBACK_URL;
  await query(`INSERT INTO marketing_link_scans (link_id, device) VALUES ($1, $2)`, [link.id, deviceOf(userAgent)])
    .catch((err) => console.error('[marketing] scan not recorded (non-fatal):', err));
  return forwardUrl(link.destination, link);
}

/**
 * The QR code for a link, as SVG: with the Ooosh record in the middle (error correction H,
 * so the covered bit is rebuilt) and plain (M — fewer, bigger squares, for tiny print).
 * The page turns either into a PNG itself.
 */
export async function linkQr(code: string): Promise<{ url: string; svg: string; svgPlain: string }> {
  const url = SHORT_LINK_BASE + code;
  const margin = 2;
  const [withLogo, plain] = await Promise.all([
    QRCode.toString(url, { type: 'svg', errorCorrectionLevel: 'H', margin }),
    QRCode.toString(url, { type: 'svg', errorCorrectionLevel: 'M', margin }),
  ]);
  return { url, svg: withCentreLogo(withLogo, margin), svgPlain: plain };
}
