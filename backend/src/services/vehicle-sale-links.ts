/**
 * Share links for a van sale — THE definition (docs/VEHICLE-SALES-SPEC.md §6).
 *
 * One link per buyer. What that buyer sees is set by the link's switches, and
 * the switches are applied HERE, server-side: a switched-off section is never
 * sent, not just hidden (§6.3). `shapeForBuyer()` is the only function that
 * builds what leaves OP, and it builds the payload field by field from an
 * allow-list — nothing is spread from a DB row, so a new column can never
 * leak by accident.
 *
 * Never sent, whatever the switches: job names or numbers, client or driver
 * names, costs, purchase price / finance / value estimate, internal notes,
 * the activity log, condition reports.
 *
 * A link stops working when it is revoked or its sale closes (Q6: the page
 * then says only "This vehicle is no longer available").
 */
import crypto from 'crypto';
import { query } from '../config/database';
import { getSystemSetting } from '../routes/system-settings';
import { parseMotPayload, type MotTest } from './dvsa-mot';
import { DISPLAY_NAME_SQL } from './display-name';
import { SaleError, OPEN_SALE_STATUSES } from './vehicle-sales';

// ── Switches ───────────────────────────────────────────────────────────────

export interface LinkSwitches {
  showPrice: boolean;
  showServiceHistory: boolean;
  showMotHistory: boolean;
  showMileageHistory: boolean;
  showDamageHistory: boolean;
}

/** §6.2 defaults. Damage is ON — hiding it is a deliberate choice (D11). */
export const DEFAULT_SWITCHES: LinkSwitches = {
  showPrice: true,
  showServiceHistory: true,
  showMotHistory: true,
  showMileageHistory: false,
  showDamageHistory: true,
};

const SWITCH_COLUMNS: Record<keyof LinkSwitches, string> = {
  showPrice: 'show_price',
  showServiceHistory: 'show_service_history',
  showMotHistory: 'show_mot_history',
  showMileageHistory: 'show_mileage_history',
  showDamageHistory: 'show_damage_history',
};

/** Only real booleans for known switches get through. Pure. */
export function cleanSwitches(input: unknown): Partial<LinkSwitches> {
  const out: Partial<LinkSwitches> = {};
  if (!input || typeof input !== 'object') return out;
  for (const k of Object.keys(SWITCH_COLUMNS) as Array<keyof LinkSwitches>) {
    const v = (input as Record<string, unknown>)[k];
    if (typeof v === 'boolean') out[k] = v;
  }
  return out;
}

// ── What a buyer can see ───────────────────────────────────────────────────

/** Everything the page COULD show — loaded once, then cut down per link. */
export interface FullSaleData {
  reg: string;
  make: string | null;
  model: string | null;
  colour: string | null;
  seats: number | null;
  fuelType: string | null;
  gearbox: string | null;
  bodyType: string | null;
  v5Type: string | null;
  vehicleCategory: string | null;
  vin: string | null;
  dateFirstReg: string | null;
  maxMassKg: number | null;
  engineCc: number | null;
  currentMileage: number | null;
  motDue: string | null;
  taxDue: string | null;
  lastServiceDate: string | null;
  ulezCompliant: boolean | null;
  description: string | null;
  askingPrice: number | null;
  vatBasis: 'plus' | 'inc';
  photos: Array<{ url: string; label: string | null }>;
  service: Array<{ date: string; mileage: number | null; type: string; description: string; garage: string | null }>;
  mot: { fetchedAt: string | null; hasOutstandingRecall: string | null; tests: MotTest[] } | null;
  mileage: Array<{ month: string; mileage: number }>;
  damage: Array<{ date: string; summary: string; status: 'Repaired' | 'Closed' | 'Outstanding' }>;
  contact: string | null;
}

export interface BuyerPayload {
  state: 'available';
  reg: string;
  title: string;
  vehicle: {
    make: string | null; model: string | null; colour: string | null; seats: number | null;
    fuelType: string | null; gearbox: string | null; year: number | null; mileage: number | null;
    bodyType: string | null;
  };
  v5: {
    vin: string | null; dateFirstReg: string | null; bodyType: string | null; typeDesignation: string | null;
    category: string | null; maxMassKg: number | null; engineCc: number | null;
  };
  keyDates: { motDue: string | null; taxDue: string | null; lastServiceDate: string | null; ulezCompliant: boolean | null };
  description: string | null;
  photos: Array<{ url: string; label: string | null }>;
  price?: { amount: number; vatBasis: 'plus' | 'inc' };
  serviceHistory?: FullSaleData['service'];
  motHistory?: FullSaleData['mot'];
  mileageHistory?: FullSaleData['mileage'];
  damageHistory?: FullSaleData['damage'];
  contact: string | null;
}

function yearOf(d: string | null): number | null {
  if (!d || !/^\d{4}-/.test(d)) return null;
  return Number(d.slice(0, 4));
}

/**
 * The ONE place a buyer payload is built. Field by field from an allow-list;
 * optional sections only when their switch is on. Pure.
 */
export function shapeForBuyer(full: FullSaleData, sw: LinkSwitches): BuyerPayload {
  const title = [full.make, full.model].filter(Boolean).join(' ') || full.reg;
  const out: BuyerPayload = {
    state: 'available',
    reg: full.reg,
    title,
    vehicle: {
      make: full.make, model: full.model, colour: full.colour, seats: full.seats,
      fuelType: full.fuelType, gearbox: full.gearbox, year: yearOf(full.dateFirstReg),
      mileage: full.currentMileage, bodyType: full.bodyType,
    },
    v5: {
      vin: full.vin, dateFirstReg: full.dateFirstReg, bodyType: full.bodyType, typeDesignation: full.v5Type,
      category: full.vehicleCategory, maxMassKg: full.maxMassKg, engineCc: full.engineCc,
    },
    keyDates: {
      motDue: full.motDue, taxDue: full.taxDue, lastServiceDate: full.lastServiceDate, ulezCompliant: full.ulezCompliant,
    },
    description: full.description,
    photos: full.photos.map((p) => ({ url: p.url, label: p.label })),
    contact: full.contact,
  };
  if (sw.showPrice && full.askingPrice != null) out.price = { amount: full.askingPrice, vatBasis: full.vatBasis };
  if (sw.showServiceHistory) {
    out.serviceHistory = full.service.map((s) => ({
      date: s.date, mileage: s.mileage, type: s.type, description: s.description, garage: s.garage,
    }));
  }
  if (sw.showMotHistory) out.motHistory = full.mot;
  if (sw.showMileageHistory) out.mileageHistory = full.mileage.map((m) => ({ month: m.month, mileage: m.mileage }));
  if (sw.showDamageHistory) out.damageHistory = full.damage.map((d) => ({ date: d.date, summary: d.summary, status: d.status }));
  return out;
}

/**
 * One reading per month for the buyer's mileage history. The log holds every
 * book-out, check-in and fill-up — and any fat-fingered reading that was later
 * corrected (RX73TBZ, May 2026) — so a raw MAX would show a bad figure. Take
 * each month's LAST reading, drop anything above the van's canonical current
 * mileage, then walk back from the newest month dropping any month higher
 * than a later one (odometers don't go down). Pure.
 */
export function monthlyMileage(
  readings: Array<{ recordedAt: string; mileage: number }>,
  currentMileage: number | null,
): Array<{ month: string; mileage: number }> {
  const byMonth = new Map<string, { at: string; mileage: number }>();
  for (const r of readings) {
    if (!Number.isFinite(r.mileage) || r.mileage <= 0) continue;
    if (currentMileage != null && r.mileage > currentMileage) continue;
    const month = r.recordedAt.slice(0, 7);
    if (!/^\d{4}-\d{2}$/.test(month)) continue;
    const prev = byMonth.get(month);
    if (!prev || r.recordedAt > prev.at) byMonth.set(month, { at: r.recordedAt, mileage: r.mileage });
  }
  const months = [...byMonth.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  const kept: Array<{ month: string; mileage: number }> = [];
  let ceiling = Infinity;
  for (let i = months.length - 1; i >= 0; i--) {
    const [month, { mileage }] = months[i];
    if (mileage > ceiling) continue;
    kept.push({ month, mileage });
    ceiling = mileage;
  }
  return kept.reverse();
}

const SERVICE_TYPE_LABELS: Record<string, string> = {
  service: 'Service', repair: 'Repair', mot: 'MOT', tyre: 'Tyres',
};

/** Problems that are about the van's body or mechanics — not "wifi down". */
const DAMAGE_CATEGORIES = ['damaged', 'broken', 'breakdown'];

function isoDate(v: unknown): string | null {
  if (!v) return null;
  if (typeof v === 'string') return /^\d{4}-\d{2}-\d{2}/.test(v) ? v.slice(0, 10) : null;
  const d = v instanceof Date ? v : new Date(String(v));
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}

/** Load everything for a sale. Staff preview and the public page both use it. */
export async function loadFullSaleData(saleId: string): Promise<FullSaleData | null> {
  const res = await query(
    `SELECT s.description, s.asking_price, s.price_vat_basis,
            fv.id AS vehicle_id, fv.reg, fv.make, fv.model, fv.colour, fv.seats, fv.fuel_type, fv.gearbox,
            fv.body_type, fv.v5_type, fv.vehicle_category, fv.vin, fv.max_mass_kg, fv.cylinder_capacity_cc,
            fv.current_mileage, fv.ulez_compliant,
            to_char(fv.date_first_reg, 'YYYY-MM-DD') AS date_first_reg,
            to_char(fv.mot_due, 'YYYY-MM-DD') AS mot_due,
            to_char(fv.tax_due, 'YYYY-MM-DD') AS tax_due,
            to_char(fv.last_service_date, 'YYYY-MM-DD') AS last_service_date,
            h.payload AS mot_payload, h.fetched_at AS mot_fetched_at
       FROM vehicle_sales s
       JOIN fleet_vehicles fv ON fv.id = s.vehicle_id
       LEFT JOIN vehicle_mot_history h ON h.vehicle_id = fv.id
      WHERE s.id = $1`,
    [saleId],
  );
  const r = res.rows[0];
  if (!r) return null;
  const vehicleId = r.vehicle_id as string;

  const [photos, service, mileage, damage, contact] = await Promise.all([
    query(`SELECT r2_key, label FROM vehicle_sale_photos WHERE sale_id = $1 ORDER BY sort_order, added_at`, [saleId]),
    query(
      `SELECT to_char(service_date, 'YYYY-MM-DD') AS date, mileage, service_type, name, garage
         FROM vehicle_service_log
        WHERE vehicle_id = $1 AND service_type = ANY($2::text[])
          AND service_date IS NOT NULL AND service_date <= CURRENT_DATE
        ORDER BY service_date DESC LIMIT 100`,
      [vehicleId, Object.keys(SERVICE_TYPE_LABELS)],
    ),
    query(
      `SELECT recorded_at, mileage FROM vehicle_mileage_log
        WHERE vehicle_id = $1 AND source <> 'correction' AND recorded_at IS NOT NULL
        ORDER BY recorded_at`,
      [vehicleId],
    ),
    query(
      `SELECT created_at, summary, status FROM job_issues
        WHERE vehicle_id = $1 AND category = ANY($2::text[]) AND status <> 'cancelled'
        ORDER BY created_at DESC LIMIT 50`,
      [vehicleId, DAMAGE_CATEGORIES],
    ),
    getSystemSetting('vehicle_sales_contact'),
  ]);

  // Photos are buyer-facing, so they are served straight from the public bucket.
  const publicBase = (process.env.R2_PUBLIC_URL || '').replace(/\/+$/, '');
  const currentMileage = r.current_mileage != null ? Number(r.current_mileage) : null;
  const motSummary = r.mot_payload ? parseMotPayload(r.mot_payload) : null;

  return {
    reg: r.reg,
    make: r.make ?? null,
    model: r.model ?? null,
    colour: r.colour ?? null,
    seats: r.seats != null ? Number(r.seats) : null,
    fuelType: r.fuel_type ?? null,
    gearbox: r.gearbox === 'auto' ? 'Automatic' : r.gearbox === 'manual' ? 'Manual' : null,
    bodyType: r.body_type ?? null,
    v5Type: r.v5_type ?? null,
    vehicleCategory: r.vehicle_category ?? null,
    vin: r.vin ?? null,
    dateFirstReg: r.date_first_reg ?? null,
    maxMassKg: r.max_mass_kg != null ? Number(r.max_mass_kg) : null,
    engineCc: r.cylinder_capacity_cc != null ? Number(r.cylinder_capacity_cc) : null,
    currentMileage,
    motDue: r.mot_due ?? null,
    taxDue: r.tax_due ?? null,
    lastServiceDate: r.last_service_date ?? null,
    ulezCompliant: typeof r.ulez_compliant === 'boolean' ? r.ulez_compliant : null,
    description: r.description ?? null,
    askingPrice: r.asking_price != null ? Number(r.asking_price) : null,
    vatBasis: r.price_vat_basis === 'inc' ? 'inc' : 'plus',
    photos: publicBase
      ? photos.rows.map((p) => ({ url: `${publicBase}/${p.r2_key}`, label: p.label ?? null }))
      : [],
    service: service.rows.map((s) => ({
      date: s.date,
      mileage: s.mileage != null ? Number(s.mileage) : null,
      type: SERVICE_TYPE_LABELS[s.service_type] ?? 'Other',
      description: String(s.name ?? ''),
      garage: s.garage ?? null,
    })),
    mot: motSummary
      ? {
          fetchedAt: r.mot_fetched_at ? (r.mot_fetched_at as Date).toISOString() : null,
          hasOutstandingRecall: motSummary.hasOutstandingRecall,
          tests: motSummary.tests,
        }
      : null,
    mileage: monthlyMileage(
      mileage.rows.map((m) => ({ recordedAt: (m.recorded_at as Date).toISOString(), mileage: Number(m.mileage) })),
      currentMileage,
    ),
    damage: damage.rows.map((d) => ({
      date: isoDate(d.created_at) ?? '',
      summary: String(d.summary ?? ''),
      status: d.status === 'resolved' ? 'Repaired' : d.status === 'written_off' ? 'Closed' : 'Outstanding',
    })),
    contact: contact?.trim() || null,
  };
}

// ── Links ──────────────────────────────────────────────────────────────────

export interface SaleLink extends LinkSwitches {
  id: string;
  token: string;
  recipientName: string;
  createdAt: string;
  createdByName: string | null;
  revokedAt: string | null;
  viewCount: number;
  lastViewedAt: string | null;
}

function rowToLink(r: Record<string, unknown>): SaleLink {
  const iso = (v: unknown) => (v ? (v as Date).toISOString() : null);
  return {
    id: r.id as string,
    token: r.token as string,
    recipientName: r.recipient_name as string,
    showPrice: r.show_price as boolean,
    showServiceHistory: r.show_service_history as boolean,
    showMotHistory: r.show_mot_history as boolean,
    showMileageHistory: r.show_mileage_history as boolean,
    showDamageHistory: r.show_damage_history as boolean,
    createdAt: iso(r.created_at) ?? '',
    createdByName: ((r.created_by_name as string | null) ?? '').trim() || null,
    revokedAt: iso(r.revoked_at),
    viewCount: Number(r.view_count ?? 0),
    lastViewedAt: iso(r.last_viewed_at),
  };
}

export async function listLinks(saleId: string): Promise<SaleLink[]> {
  const res = await query(
    `SELECT l.*, ${DISPLAY_NAME_SQL} AS created_by_name
       FROM vehicle_sale_links l
       LEFT JOIN users u ON u.id = l.created_by
       LEFT JOIN people p ON p.id = u.person_id
      WHERE l.sale_id = $1
      ORDER BY l.revoked_at IS NOT NULL, l.created_at DESC`,
    [saleId],
  );
  return res.rows.map(rowToLink);
}

async function assertSaleOpen(saleId: string): Promise<void> {
  const res = await query(`SELECT status FROM vehicle_sales WHERE id = $1`, [saleId]);
  if (!res.rows[0]) throw new SaleError(404, 'Sale not found');
  if (!(OPEN_SALE_STATUSES as readonly string[]).includes(res.rows[0].status)) {
    throw new SaleError(409, 'This sale is closed');
  }
}

export async function createLink(saleId: string, userId: string, input: { recipientName?: unknown; switches?: unknown }): Promise<void> {
  await assertSaleOpen(saleId);
  const name = typeof input.recipientName === 'string' ? input.recipientName.trim().slice(0, 200) : '';
  if (!name) throw new SaleError(400, 'Who is this link for?');
  const sw: LinkSwitches = { ...DEFAULT_SWITCHES, ...cleanSwitches(input.switches) };
  const token = crypto.randomBytes(24).toString('base64url');
  await query(
    `INSERT INTO vehicle_sale_links
       (sale_id, token, recipient_name, show_price, show_service_history, show_mot_history,
        show_mileage_history, show_damage_history, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [saleId, token, name, sw.showPrice, sw.showServiceHistory, sw.showMotHistory,
      sw.showMileageHistory, sw.showDamageHistory, userId],
  );
}

/** Change a live link's switches (e.g. "now show them the price"). */
export async function updateLinkSwitches(saleId: string, linkId: string, switches: unknown): Promise<void> {
  await assertSaleOpen(saleId);
  const sw = cleanSwitches(switches);
  const keys = Object.keys(sw) as Array<keyof LinkSwitches>;
  if (keys.length === 0) return;
  const sets = keys.map((k, i) => `${SWITCH_COLUMNS[k]} = $${i + 3}`);
  const res = await query(
    `UPDATE vehicle_sale_links SET ${sets.join(', ')}
      WHERE id = $2 AND sale_id = $1 AND revoked_at IS NULL`,
    [saleId, linkId, ...keys.map((k) => sw[k])],
  );
  if ((res.rowCount ?? 0) === 0) throw new SaleError(404, 'Link not found');
}

export async function revokeLink(saleId: string, linkId: string): Promise<void> {
  const res = await query(
    `UPDATE vehicle_sale_links SET revoked_at = COALESCE(revoked_at, NOW())
      WHERE id = $2 AND sale_id = $1`,
    [saleId, linkId],
  );
  if ((res.rowCount ?? 0) === 0) throw new SaleError(404, 'Link not found');
}

// ── Public ─────────────────────────────────────────────────────────────────

export type PublicResult = BuyerPayload | { state: 'unavailable' };

/**
 * What a buyer's link shows. Unknown / revoked tokens and closed sales all
 * get the same "no longer available" answer — nothing that says which (Q6).
 * `countView` is false for staff previews.
 */
export async function resolvePublicLink(token: string, countView: boolean): Promise<PublicResult> {
  if (!token || token.length < 20 || token.length > 64) return { state: 'unavailable' };
  const res = await query(
    `SELECT l.*, s.status AS sale_status
       FROM vehicle_sale_links l
       JOIN vehicle_sales s ON s.id = l.sale_id
      WHERE l.token = $1`,
    [token],
  );
  const row = res.rows[0];
  if (!row || row.revoked_at || !(OPEN_SALE_STATUSES as readonly string[]).includes(row.sale_status)) {
    return { state: 'unavailable' };
  }
  const full = await loadFullSaleData(row.sale_id);
  if (!full) return { state: 'unavailable' };

  if (countView) {
    await query(
      `UPDATE vehicle_sale_links SET view_count = view_count + 1, last_viewed_at = NOW() WHERE id = $1`,
      [row.id],
    ).catch((err) => console.warn('[vehicle-sale-links] view count failed:', err));
  }
  return shapeForBuyer(full, rowToLink(row));
}
