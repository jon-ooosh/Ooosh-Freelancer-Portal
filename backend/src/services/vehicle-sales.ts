/**
 * Selling a van — THE definition (docs/VEHICLE-SALES-SPEC.md, Phase 1).
 *
 * A sale is a record ALONGSIDE the van, never a change to it: the van stays
 * active and hireable (D2) and "For sale" is a warning, not a gate (D3).
 * Vehicle facts are read live; only the chosen photos are kept (D4–D5).
 *
 * Who may do what (D7): an ADMIN starts a sale, withdraws it, and sets the
 * price, VAT basis and hold-from date. After that any staff member works it —
 * stage (preparing / listed / under offer), description and photos.
 * "Sold" is never set here: it goes through the existing sold modal (Phase 3).
 *
 * Photos need a re-check (D6) when a Problem on the van was created, or
 * re-flagged by a check-in, after `photos_confirmed_at`. That is COMPUTED from
 * job_issues on every read, so it catches every way a Problem can be logged;
 * the bell (`notifyVehicleSaleOfIssue`) is the courtesy on top.
 */
import { v4 as uuid } from 'uuid';
import { query } from '../config/database';
import { uploadToPublicR2, deleteFromPublicR2 } from '../config/r2';
import { DISPLAY_NAME_SQL } from './display-name';

export const OPEN_SALE_STATUSES = ['preparing', 'listed', 'under_offer'] as const;
export type OpenSaleStatus = typeof OPEN_SALE_STATUSES[number];
export type SaleStatus = OpenSaleStatus | 'sold' | 'withdrawn';
export type VatBasis = 'plus' | 'inc';

export class SaleError extends Error {
  constructor(public status: number, message: string) {
    super(message);
    this.name = 'SaleError';
  }
}

// ── Rules (pure) ───────────────────────────────────────────────────────────

export interface SalePatch {
  status?: unknown;
  description?: unknown;
  askingPrice?: unknown;
  vatBasis?: unknown;
  holdFromHire?: unknown;
  closedReason?: unknown;
}

/** YYYY-MM-DD with a real day and a plausible year (2000–2099), or null.
 *  Postgres will happily store year 6 from a mistyped '0006-08-25'. */
export function cleanDate(v: unknown): string | null | undefined {
  if (v === null || v === '') return null;
  if (typeof v !== 'string' || !/^20\d{2}-\d{2}-\d{2}$/.test(v)) return undefined;
  const d = new Date(`${v}T00:00:00Z`);
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== v) return undefined;
  return v;
}

/** A price in pounds, or null. Undefined = invalid. */
export function cleanPrice(v: unknown): number | null | undefined {
  if (v === null || v === '') return null;
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN;
  if (!Number.isFinite(n) || n < 0 || n >= 10_000_000) return undefined;
  return Math.round(n * 100) / 100;
}

/**
 * Turn a PATCH body into column updates, applying D7. Pure — the route and the
 * tests both lean on it. Throws SaleError on anything not allowed.
 */
export function planSalePatch(
  patch: SalePatch,
  role: string,
  currentStatus: SaleStatus,
): Record<string, string | number | null> {
  if (!(OPEN_SALE_STATUSES as readonly string[]).includes(currentStatus)) {
    throw new SaleError(409, 'This sale is closed');
  }
  const isAdmin = role === 'admin';
  const updates: Record<string, string | number | null> = {};

  if (patch.status !== undefined) {
    const s = patch.status;
    if (s === 'sold') throw new SaleError(400, 'Use "Mark sold" to record a sale');
    if (s === 'withdrawn') {
      if (!isAdmin) throw new SaleError(403, 'Only an admin can withdraw a sale');
      updates.status = 'withdrawn';
      const reason = typeof patch.closedReason === 'string' ? patch.closedReason.trim().slice(0, 500) : '';
      updates.closed_reason = reason || null;
    } else if (typeof s === 'string' && (OPEN_SALE_STATUSES as readonly string[]).includes(s)) {
      updates.status = s;
    } else {
      throw new SaleError(400, 'Unknown stage');
    }
  }

  if (patch.description !== undefined) {
    if (patch.description !== null && typeof patch.description !== 'string') {
      throw new SaleError(400, 'Description must be text');
    }
    const d = (patch.description ?? '').trim();
    updates.description = d ? d.slice(0, 5000) : null;
  }

  const adminFields: Array<keyof SalePatch> = ['askingPrice', 'vatBasis', 'holdFromHire'];
  if (!isAdmin && adminFields.some((f) => patch[f] !== undefined)) {
    throw new SaleError(403, 'Only an admin can change the price, VAT or hold date');
  }
  if (patch.askingPrice !== undefined) {
    const p = cleanPrice(patch.askingPrice);
    if (p === undefined) throw new SaleError(400, 'Asking price must be a positive number');
    updates.asking_price = p;
  }
  if (patch.vatBasis !== undefined) {
    if (patch.vatBasis !== 'plus' && patch.vatBasis !== 'inc') throw new SaleError(400, 'VAT must be "plus" or "inc"');
    updates.price_vat_basis = patch.vatBasis;
  }
  if (patch.holdFromHire !== undefined) {
    const d = cleanDate(patch.holdFromHire);
    if (d === undefined) throw new SaleError(400, 'Hold-from date is not a valid date');
    updates.hold_from_hire = d;
  }

  return updates;
}

/** The public-bucket folder a van's book-out photos live in: events/{id}/{REG}/… */
export function safeRegForPhotos(reg: string): string {
  return reg.replace(/\s+/g, '-').toUpperCase();
}

/**
 * Is this a book-out / check-in photo of THIS van? Only those may be referenced
 * by key — never another van's, never anything outside events/.
 */
export function isEventPhotoKeyForVan(key: string, reg: string): boolean {
  if (typeof key !== 'string' || key.includes('..') || key.length > 500) return false;
  const safe = safeRegForPhotos(reg).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^events/[A-Za-z0-9_-]+/${safe}/[A-Za-z0-9_./-]+\\.(jpe?g|png|webp)$`, 'i').test(key);
}

// ── Reads ──────────────────────────────────────────────────────────────────

export interface SalePhoto {
  id: string;
  r2Key: string;
  source: 'event' | 'upload';
  sourceEventId: string | null;
  label: string | null;
  sortOrder: number;
}

export interface RecheckProblem {
  id: string;
  summary: string;
  category: string | null;
  status: string;
  when: string;           // the create / re-flag time that tripped it
  reflagged: boolean;
}

export interface SaleView {
  id: string;
  vehicleId: string;
  reg: string;
  status: SaleStatus;
  askingPrice: number | null;
  vatBasis: VatBasis;
  description: string | null;
  holdFromHire: string | null;
  photosConfirmedAt: string | null;
  startedBy: string | null;
  startedByName: string | null;
  startedAt: string;
  closedAt: string | null;
  closedReason: string | null;
  photos: SalePhoto[];
  recheck: RecheckProblem[];
  bookedUntil: string | null;
  bookedBeyondHold: boolean;
}

/** Latest end date of the van's live hires (soft/confirmed/booked out/active). */
const BOOKED_UNTIL_SQL = `(
  SELECT to_char(MAX(vha.hire_end), 'YYYY-MM-DD')
    FROM vehicle_hire_assignments vha
   WHERE vha.vehicle_id = s.vehicle_id
     AND vha.status IN ('soft', 'confirmed', 'booked_out', 'active')
)`;

function iso(v: unknown): string | null {
  if (!v) return null;
  const d = v instanceof Date ? v : new Date(String(v));
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/** Problems on the van created or re-flagged since the photos were last confirmed. */
async function loadRecheck(vehicleId: string, confirmedAt: Date | null): Promise<RecheckProblem[]> {
  const res = await query(
    `SELECT ji.id, ji.summary, ji.category, ji.status,
            GREATEST(
              CASE WHEN $2::timestamptz IS NULL OR ji.created_at > $2::timestamptz THEN ji.created_at END,
              (SELECT MAX(e.created_at) FROM job_issue_events e
                WHERE e.issue_id = ji.id AND e.event_type = 'reflagged'
                  AND ($2::timestamptz IS NULL OR e.created_at > $2::timestamptz))
            ) AS tripped_at,
            EXISTS (SELECT 1 FROM job_issue_events e
                     WHERE e.issue_id = ji.id AND e.event_type = 'reflagged'
                       AND ($2::timestamptz IS NULL OR e.created_at > $2::timestamptz)) AS reflagged
       FROM job_issues ji
      WHERE ji.vehicle_id = $1
        AND ji.status <> 'cancelled'
        AND (
          $2::timestamptz IS NULL
          OR ji.created_at > $2::timestamptz
          OR EXISTS (SELECT 1 FROM job_issue_events e
                      WHERE e.issue_id = ji.id AND e.event_type = 'reflagged'
                        AND e.created_at > $2::timestamptz)
        )
      ORDER BY tripped_at DESC NULLS LAST
      LIMIT 20`,
    [vehicleId, confirmedAt],
  );
  return res.rows.map((r) => ({
    id: r.id as string,
    summary: (r.summary as string) ?? '',
    category: (r.category as string | null) ?? null,
    status: r.status as string,
    when: iso(r.tripped_at) ?? '',
    reflagged: r.reflagged === true,
  }));
}

export async function getSale(saleId: string): Promise<SaleView | null> {
  const res = await query(
    `SELECT s.*, fv.reg, ${DISPLAY_NAME_SQL} AS started_by_name,
            to_char(s.hold_from_hire, 'YYYY-MM-DD') AS hold_from_hire_str,
            ${BOOKED_UNTIL_SQL} AS booked_until
       FROM vehicle_sales s
       JOIN fleet_vehicles fv ON fv.id = s.vehicle_id
       LEFT JOIN users u ON u.id = s.started_by
       LEFT JOIN people p ON p.id = u.person_id
      WHERE s.id = $1`,
    [saleId],
  );
  const r = res.rows[0];
  if (!r) return null;

  const photos = await query(
    `SELECT id, r2_key, source, source_event_id, label, sort_order
       FROM vehicle_sale_photos WHERE sale_id = $1
      ORDER BY sort_order, added_at`,
    [saleId],
  );

  // A photo-less sale has nothing to re-check.
  const isOpen = (OPEN_SALE_STATUSES as readonly string[]).includes(r.status);
  const recheck = isOpen && photos.rows.length > 0
    ? await loadRecheck(r.vehicle_id, (r.photos_confirmed_at as Date | null) ?? null)
    : [];

  const holdFrom = (r.hold_from_hire_str as string | null) ?? null;
  const bookedUntil = (r.booked_until as string | null) ?? null;
  return {
    id: r.id,
    vehicleId: r.vehicle_id,
    reg: r.reg,
    status: r.status,
    askingPrice: r.asking_price != null ? Number(r.asking_price) : null,
    vatBasis: r.price_vat_basis,
    description: r.description ?? null,
    holdFromHire: holdFrom,
    photosConfirmedAt: iso(r.photos_confirmed_at),
    startedBy: r.started_by ?? null,
    startedByName: (r.started_by_name as string | null)?.trim() || null,
    startedAt: iso(r.started_at) ?? '',
    closedAt: iso(r.closed_at),
    closedReason: r.closed_reason ?? null,
    photos: photos.rows.map((p) => ({
      id: p.id,
      r2Key: p.r2_key,
      source: p.source,
      sourceEventId: p.source_event_id ?? null,
      label: p.label ?? null,
      sortOrder: p.sort_order,
    })),
    recheck,
    bookedUntil,
    bookedBeyondHold: !!(holdFrom && bookedUntil && bookedUntil > holdFrom),
  };
}

export async function getOpenSaleIdForVehicle(vehicleId: string): Promise<string | null> {
  const res = await query(
    `SELECT id FROM vehicle_sales
      WHERE vehicle_id = $1 AND status IN ('preparing', 'listed', 'under_offer')
      LIMIT 1`,
    [vehicleId],
  );
  return (res.rows[0]?.id as string | undefined) ?? null;
}

export interface OpenSaleSummary {
  id: string;
  vehicleId: string;
  reg: string;
  status: OpenSaleStatus;
  holdFromHire: string | null;
  bookedUntil: string | null;
  bookedBeyondHold: boolean;
}

/** Every open sale, for the "For sale" pills (fleet board, allocations, book-out). */
export async function listOpenSales(): Promise<OpenSaleSummary[]> {
  const res = await query(
    `SELECT s.id, s.vehicle_id, s.status, fv.reg,
            to_char(s.hold_from_hire, 'YYYY-MM-DD') AS hold_from_hire,
            ${BOOKED_UNTIL_SQL} AS booked_until
       FROM vehicle_sales s
       JOIN fleet_vehicles fv ON fv.id = s.vehicle_id
      WHERE s.status IN ('preparing', 'listed', 'under_offer')
      ORDER BY fv.reg`,
  );
  return res.rows.map((r) => {
    const holdFrom = (r.hold_from_hire as string | null) ?? null;
    const bookedUntil = (r.booked_until as string | null) ?? null;
    return {
      id: r.id,
      vehicleId: r.vehicle_id,
      reg: r.reg,
      status: r.status,
      holdFromHire: holdFrom,
      bookedUntil,
      bookedBeyondHold: !!(holdFrom && bookedUntil && bookedUntil > holdFrom),
    };
  });
}

// ── Writes ─────────────────────────────────────────────────────────────────

export async function startSale(
  vehicleId: string,
  userId: string,
  input: { askingPrice?: unknown; vatBasis?: unknown; holdFromHire?: unknown },
): Promise<string> {
  const v = await query(`SELECT id, is_active, fleet_group FROM fleet_vehicles WHERE id = $1`, [vehicleId]);
  if (!v.rows[0]) throw new SaleError(404, 'Vehicle not found');
  if (v.rows[0].is_active === false || v.rows[0].fleet_group === 'old_sold') {
    throw new SaleError(409, 'This van has already been removed from the fleet');
  }
  if (await getOpenSaleIdForVehicle(vehicleId)) throw new SaleError(409, 'This van is already for sale');

  const price = cleanPrice(input.askingPrice ?? null);
  if (price === undefined) throw new SaleError(400, 'Asking price must be a positive number');
  const vat = input.vatBasis ?? 'plus';
  if (vat !== 'plus' && vat !== 'inc') throw new SaleError(400, 'VAT must be "plus" or "inc"');
  const hold = cleanDate(input.holdFromHire ?? null);
  if (hold === undefined) throw new SaleError(400, 'Hold-from date is not a valid date');

  try {
    const ins = await query(
      `INSERT INTO vehicle_sales (vehicle_id, asking_price, price_vat_basis, hold_from_hire, started_by)
       VALUES ($1, $2, $3, $4::date, $5) RETURNING id`,
      [vehicleId, price, vat, hold, userId],
    );
    return ins.rows[0].id as string;
  } catch (err) {
    // Two admins pressing Start at once — the partial unique index catches it.
    if ((err as { code?: string }).code === '23505') throw new SaleError(409, 'This van is already for sale');
    throw err;
  }
}

async function loadSaleForWrite(saleId: string): Promise<{ status: SaleStatus; vehicle_id: string; reg: string }> {
  const res = await query(
    `SELECT s.status, s.vehicle_id, fv.reg
       FROM vehicle_sales s JOIN fleet_vehicles fv ON fv.id = s.vehicle_id
      WHERE s.id = $1`,
    [saleId],
  );
  if (!res.rows[0]) throw new SaleError(404, 'Sale not found');
  return res.rows[0];
}

async function assertOpen(saleId: string): Promise<{ vehicle_id: string; reg: string }> {
  const s = await loadSaleForWrite(saleId);
  if (!(OPEN_SALE_STATUSES as readonly string[]).includes(s.status)) throw new SaleError(409, 'This sale is closed');
  return s;
}

export async function updateSale(saleId: string, role: string, patch: SalePatch): Promise<void> {
  const current = await loadSaleForWrite(saleId);
  const updates = planSalePatch(patch, role, current.status);
  const cols = Object.keys(updates);
  if (cols.length === 0) return;

  const sets = cols.map((c, i) => (c === 'hold_from_hire' ? `${c} = $${i + 2}::date` : `${c} = $${i + 2}`));
  if (updates.status === 'withdrawn') sets.push('closed_at = NOW()');
  sets.push('updated_at = NOW()');
  await query(
    `UPDATE vehicle_sales SET ${sets.join(', ')} WHERE id = $1`,
    [saleId, ...cols.map((c) => updates[c])],
  );
}

/** Any change to the photo set counts as "someone has looked at the photos". */
async function stampPhotosConfirmed(saleId: string): Promise<void> {
  await query(
    `UPDATE vehicle_sales SET photos_confirmed_at = NOW(), updated_at = NOW() WHERE id = $1`,
    [saleId],
  );
}

export async function confirmPhotos(saleId: string): Promise<void> {
  await assertOpen(saleId);
  await stampPhotosConfirmed(saleId);
}

async function nextSortOrder(saleId: string): Promise<number> {
  const res = await query(`SELECT COALESCE(MAX(sort_order), -1) + 1 AS n FROM vehicle_sale_photos WHERE sale_id = $1`, [saleId]);
  return Number(res.rows[0]?.n ?? 0);
}

function cleanLabel(v: unknown): string | null {
  return typeof v === 'string' && v.trim() ? v.trim().slice(0, 100) : null;
}

/** Add book-out / check-in photos of this van by key. Duplicates are ignored. */
export async function addEventPhotos(
  saleId: string,
  userId: string,
  photos: Array<{ r2Key?: unknown; sourceEventId?: unknown; label?: unknown }>,
): Promise<number> {
  const sale = await assertOpen(saleId);
  let order = await nextSortOrder(saleId);
  let added = 0;
  for (const p of photos.slice(0, 50)) {
    const key = typeof p.r2Key === 'string' ? p.r2Key : '';
    if (!isEventPhotoKeyForVan(key, sale.reg)) {
      throw new SaleError(400, `Not a photo of ${sale.reg}: ${key.slice(0, 80)}`);
    }
    const eventId = typeof p.sourceEventId === 'string' ? p.sourceEventId.slice(0, 100) : null;
    const ins = await query(
      `INSERT INTO vehicle_sale_photos (sale_id, r2_key, source, source_event_id, label, sort_order, added_by)
       VALUES ($1, $2, 'event', $3, $4, $5, $6)
       ON CONFLICT (sale_id, r2_key) DO NOTHING`,
      [saleId, key, eventId, cleanLabel(p.label), order, userId],
    );
    if ((ins.rowCount ?? 0) > 0) { added++; order++; }
  }
  if (added > 0) await stampPhotosConfirmed(saleId);
  return added;
}

/** A new photo taken for the sale, stored in the PUBLIC bucket (it's for buyers). */
export async function uploadSalePhoto(
  saleId: string,
  userId: string,
  file: { buffer: Buffer; mimetype: string },
  label: unknown,
): Promise<string> {
  await assertOpen(saleId);
  const ext = file.mimetype === 'image/png' ? 'png' : file.mimetype === 'image/webp' ? 'webp' : 'jpg';
  const key = `vehicle-sales/${saleId}/${uuid()}.${ext}`;
  await uploadToPublicR2(key, file.buffer, file.mimetype);
  const ins = await query(
    `INSERT INTO vehicle_sale_photos (sale_id, r2_key, source, label, sort_order, added_by)
     VALUES ($1, $2, 'upload', $3, $4, $5) RETURNING id`,
    [saleId, key, cleanLabel(label), await nextSortOrder(saleId), userId],
  );
  await stampPhotosConfirmed(saleId);
  return ins.rows[0].id as string;
}

export async function updateSalePhotoLabel(saleId: string, photoId: string, label: unknown): Promise<void> {
  await assertOpen(saleId);
  const res = await query(
    `UPDATE vehicle_sale_photos SET label = $3 WHERE id = $2 AND sale_id = $1`,
    [saleId, photoId, cleanLabel(label)],
  );
  if ((res.rowCount ?? 0) === 0) throw new SaleError(404, 'Photo not found');
}

/** Save a new order. Ids not on this sale are ignored; missing ones keep their place after. */
export async function reorderSalePhotos(saleId: string, ids: unknown): Promise<void> {
  await assertOpen(saleId);
  if (!Array.isArray(ids)) throw new SaleError(400, 'ids must be a list');
  const list = ids.filter((x): x is string => typeof x === 'string').slice(0, 200);
  for (let i = 0; i < list.length; i++) {
    await query(`UPDATE vehicle_sale_photos SET sort_order = $3 WHERE id = $2 AND sale_id = $1`, [saleId, list[i], i]);
  }
  await stampPhotosConfirmed(saleId);
}

export async function removeSalePhoto(saleId: string, photoId: string): Promise<void> {
  await assertOpen(saleId);
  const res = await query(
    `DELETE FROM vehicle_sale_photos WHERE id = $2 AND sale_id = $1 RETURNING r2_key, source`,
    [saleId, photoId],
  );
  const row = res.rows[0];
  if (!row) throw new SaleError(404, 'Photo not found');
  // Only our own uploads are deleted from storage — a book-out photo belongs
  // to its condition report.
  if (row.source === 'upload') {
    await deleteFromPublicR2(row.r2_key).catch((err) =>
      console.warn('[vehicle-sales] could not delete uploaded photo', row.r2_key, err));
  }
  await stampPhotosConfirmed(saleId);
}

// ── The bell (D6, Q4) ──────────────────────────────────────────────────────

/**
 * A Problem was logged or re-flagged. If its van has an open sale WITH chosen
 * photos, tell whoever started the sale and the default vehicle-issue
 * watchers that the photos may be out of date. Best-effort: never throws.
 */
export async function notifyVehicleSaleOfIssue(issueId: string, actorUserId: string | null): Promise<void> {
  try {
    const res = await query(
      `SELECT s.id AS sale_id, s.started_by, s.vehicle_id, fv.reg, ji.summary
         FROM job_issues ji
         JOIN vehicle_sales s ON s.vehicle_id = ji.vehicle_id
                             AND s.status IN ('preparing', 'listed', 'under_offer')
         JOIN fleet_vehicles fv ON fv.id = s.vehicle_id
        WHERE ji.id = $1
          AND EXISTS (SELECT 1 FROM vehicle_sale_photos ph WHERE ph.sale_id = s.id)`,
      [issueId],
    );
    const row = res.rows[0];
    if (!row) return;

    // Lazy: job-issues imports this module (and pulls in auth/settings).
    const { getDefaultVehicleIssueWatchers } = await import('./job-issues');
    const recipients = new Set<string>();
    if (row.started_by) recipients.add(row.started_by);
    for (const w of await getDefaultVehicleIssueWatchers()) recipients.add(w);
    if (actorUserId) recipients.delete(actorUserId);

    const title = `${row.reg} is for sale — check its sale photos`;
    const content = `A Problem was logged on ${row.reg}: ${String(row.summary ?? '').slice(0, 120)}`;
    const actionUrl = `/vehicles/fleet/${row.vehicle_id}/sale`;
    for (const userId of recipients) {
      await query(
        `INSERT INTO notifications
           (user_id, type, title, content, entity_type, entity_id, action_url, priority, source_user_id)
         VALUES ($1, 'system', $2, $3, 'vehicle_sales', $4, $5, 'normal', $6)`,
        [userId, title, content, row.sale_id, actionUrl, actorUserId],
      );
    }
  } catch (err) {
    console.error('[vehicle-sales] sale photo bell failed (non-fatal):', err);
  }
}

// ── Closing ────────────────────────────────────────────────────────────────

/**
 * The van has left the fleet (the sold / remove modal set fleet_group to
 * 'old_sold'). Any open sale on it closes as SOLD — while a sale is open the
 * danger zone offers "Mark sold", not "Remove without sale", so a removal
 * during a sale is the sale completing. Idempotent; best-effort.
 */
export async function closeOpenSaleOnRemoval(vehicleId: string): Promise<void> {
  try {
    await query(
      `UPDATE vehicle_sales
          SET status = 'sold', closed_at = NOW(), updated_at = NOW(),
              closed_reason = COALESCE(closed_reason, 'Van removed from the fleet')
        WHERE vehicle_id = $1 AND status IN ('preparing', 'listed', 'under_offer')`,
      [vehicleId],
    );
  } catch (err) {
    console.error('[vehicle-sales] could not close the sale on removal:', err);
  }
}
