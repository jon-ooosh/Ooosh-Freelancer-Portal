/**
 * VAT Adjustment Service — International VAT calculation for non-UK hires.
 *
 * Ported from Payment Portal vat-adjustment.js (v4, nominals-based, penny-perfect).
 *
 * Approach:
 * 1. Detect trigger item ("Non-standard VAT rules...") in job items list
 * 2. Extract non-UK days from trigger item quantity
 * 3. Build ACC_NOMINAL → VAT category mapping from items
 * 4. Fetch job_margins.php for exact revenue per nominal group
 * 5. Apply HMRC VAT rules per category
 */
import { hhBroker } from './hirehop-broker';

// The two HireHop items (virtual, category 369). Both names start "Non-standard VAT
// rules", so each is matched on its own words — never on the shared prefix alone:
//   "… - number of days outside of UK"           qty = the non-UK days
//   "… - van hire starts and ends outside the UK" (Oct 2026) vehicles zero-rated whatever the length
const VAT_ITEM_PREFIX = /non-standard vat/i;
const VAT_OUTSIDE_ITEM = /starts\s+and\s+ends\s+outside/i;
const itemNameOf = (item: any): string => String(item.title || item.NAME || item.name || '');
const isNonUkDaysItem = (item: any) => VAT_ITEM_PREFIX.test(itemNameOf(item)) && !VAT_OUTSIDE_ITEM.test(itemNameOf(item));
const isOutsideItem = (item: any) => VAT_OUTSIDE_ITEM.test(itemNameOf(item));

// Standard UK VAT rate
const UK_VAT_RATE = 0.20;

// Vehicle category IDs in HireHop
const VEHICLE_CATEGORY_IDS = [369, 370, 371];

// Always-20% category IDs (storage, rehearsal rooms)
const ALWAYS_20_CATEGORY_IDS = [449, 450];

// Always-20% keyword matches
const ALWAYS_20_KEYWORDS = ['delivery', 'shop', 've103', 'collection', 'admin', 'fee'];

// Min hire days for vehicle zero-rating on entire hire
export const VEHICLE_ZERO_RATE_MIN_DAYS = 31;

/**
 * Vehicles (Ooosh! Tours guide to VAT on hires, Jan 2025; HMRC 744A/741A): zero-rated
 * ONLY on a hire of 31+ days, or one that starts AND ends outside the UK. Otherwise the
 * whole vehicle hire is UK VAT at 20% — it is never split by UK / non-UK days (that is
 * equipment's rule). Until Oct 2026 vehicles under 31 days were split by days, here and
 * in the payment portal — jon caught it on 14 Oct.
 */
export function vehiclesZeroRated(hireDays: number, startsAndEndsOutsideUk: boolean): boolean {
  return hireDays >= VEHICLE_ZERO_RATE_MIN_DAYS || startsAndEndsOutsideUk;
}

/** The "starts and ends outside the UK" item is on the job (quantity 1 or more). */
export function vehicleHireOutsideUk(rawItems: any[]): boolean {
  const item = rawItems.find(isOutsideItem);
  return !!item && (parseFloat(item.qty ?? item.QTY ?? '1') || 0) > 0;
}

/** The three VAT treatments, per HireHop nominal (ACC_NOMINAL on the job's items). */
export type VatClass = 'vehicle' | 'equipment' | 'always20';

/** The job's items as HireHop lists them (fresh when `fresh`). Null when HireHop could not be read. */
export async function readSupplyItems(hhJobId: number, fresh = false): Promise<any[] | null> {
  const itemsRes = await hhBroker.get<any>('/frames/items_to_supply_list.php',
    { job: hhJobId }, { priority: 'high', cacheTTL: fresh ? -1 : 300 });
  if (!itemsRes.success || !itemsRes.data) return null;
  return Array.isArray(itemsRes.data) ? itemsRes.data : (itemsRes.data.items || itemsRes.data.rows || []);
}

/** The "Non-standard VAT rules" item's quantity — the non-UK days. 0 when the job has none. */
export function nonUkDaysOf(rawItems: any[]): number {
  const trigger = rawItems.find(isNonUkDaysItem);
  return trigger ? (parseInt(trigger.qty || trigger.QTY || '0') || 0) : 0;
}

/** Hire days from a job's start and end, as the Money tab and the VAT endpoint count them. */
export function hireDaysBetween(start: unknown, end: unknown): number {
  if (!start || !end) return 1;
  return Math.max(1, Math.ceil(
    (new Date(end as string).getTime() - new Date(start as string).getTime()) / (1000 * 60 * 60 * 24)
  ));
}

/**
 * Which VAT treatment each nominal (ACC_NOMINAL, as a string; '0' for none)
 * gets. A nominal holding any vehicle is a vehicle nominal. Nominals not
 * listed are equipment. THE classification: the portal figure and the EU
 * invoice split (eu-vat-split.ts) must agree, so both read it from here.
 */
export function classifyNominals(rawItems: any[]): Record<string, VatClass> {
  const nominalClassification: Record<string, VatClass> = {};

  for (const item of rawItems) {
    const nominal = item.ACC_NOMINAL;
    const nominalKey = nominal != null ? String(nominal) : '0';
    const categoryId = parseInt(item.CATEGORY_ID || '0');
    const kind = parseInt(item.kind || '0');
    const itemName = (item.title || item.NAME || item.name || '').toLowerCase();
    const isVirtual = item.VIRTUAL === '1' || item.VIRTUAL === 1;

    if (isVirtual || kind === 0) continue;

    const currentClass = nominalClassification[nominalKey];

    if (VEHICLE_CATEGORY_IDS.includes(categoryId)) {
      nominalClassification[nominalKey] = 'vehicle';
    } else if (kind === 4) {
      if (currentClass !== 'vehicle') nominalClassification[nominalKey] = 'always20';
    } else if (ALWAYS_20_CATEGORY_IDS.includes(categoryId)) {
      if (currentClass !== 'vehicle') nominalClassification[nominalKey] = 'always20';
    } else if (ALWAYS_20_KEYWORDS.some(kw => itemName.includes(kw))) {
      if (currentClass !== 'vehicle') nominalClassification[nominalKey] = 'always20';
    } else {
      if (!currentClass) nominalClassification[nominalKey] = 'equipment';
    }
  }
  return nominalClassification;
}

export interface VatBreakdownCategory {
  category: string;
  subtotalNet: number;
  subtotalVat: number;
  subtotalGross: number;
  vatSaved: number;
  rule: string;
}

export interface VatAdjustmentResult {
  applies: true;
  hireDays: number;
  ukDays: number;
  nonUkDays: number;
  totalNet: number;
  vehicleRevenue: number;
  equipmentRevenue: number;
  always20Revenue: number;
  originalVat: number;
  adjustedVat: number;
  originalTotalIncVat: number;
  adjustedTotal: number;
  vatSaved: number;
  breakdown: VatBreakdownCategory[];
  explanationText: string;
}

/**
 * Does the job carry a "Non-standard VAT rules" item — a non-UK day count, or
 * the vehicle hire starting and ending outside the UK? The hire close-out asks before raising an invoice: until the
 * invoice-line VAT split is built (HIRE-CLOSE-OUT-SPEC.md §10.1) such a job is
 * invoiced by hand. Null when HireHop could not be read.
 */
export async function hasNonStandardVatItem(hhJobId: number): Promise<boolean | null> {
  const itemsRes = await hhBroker.get<any>('/frames/items_to_supply_list.php',
    { job: hhJobId }, { priority: 'high', cacheTTL: 300 });
  if (!itemsRes.success || !itemsRes.data) return null;
  const rawItems: any[] = Array.isArray(itemsRes.data) ? itemsRes.data : (itemsRes.data.items || itemsRes.data.rows || []);
  return nonUkDaysOf(rawItems) > 0 || vehicleHireOutsideUk(rawItems);
}

export async function calculateVatAdjustment(
  hhJobId: number,
  hireDays: number,
): Promise<VatAdjustmentResult | null> {
  try {
    // Step 1: Fetch job items to find trigger and build nominal map
    const itemsRes = await hhBroker.get<any>('/frames/items_to_supply_list.php',
      { job: hhJobId },
      { priority: 'high', cacheTTL: 300 }
    );

    if (!itemsRes.success || !itemsRes.data) return null;

    const rawItems = Array.isArray(itemsRes.data)
      ? itemsRes.data
      : (itemsRes.data.items || itemsRes.data.rows || []);

    // Step 2: The two items — non-UK days, and a vehicle hire starting and ending outside the UK
    const nonUkDays = Math.min(nonUkDaysOf(rawItems), hireDays);
    const outside = vehicleHireOutsideUk(rawItems);
    const ukDays = Math.max(0, hireDays - nonUkDays);

    if (nonUkDays <= 0 && !outside) return null; // neither item = standard UK VAT

    // Step 3: Build ACC_NOMINAL → VAT category mapping
    const nominalClassification = classifyNominals(rawItems);

    // Step 4: Fetch job_margins.php for exact revenue per nominal
    const marginsRes = await hhBroker.get<any>('/php_functions/job_margins.php',
      { job_id: hhJobId },
      { priority: 'high', cacheTTL: 300 }
    );

    if (!marginsRes.success || !marginsRes.data) return null;

    const margins = marginsRes.data;
    if (margins.error) return null;

    const totalRevenue = parseFloat(margins.total_revenue || '0');
    const nominals = margins.nominals || [];

    // Step 5: Sum nominal revenues into VAT categories
    let vehicleRevenue = 0;
    let equipmentRevenue = 0;
    let always20Revenue = 0;

    for (const nom of nominals) {
      const idx = nom.idx;
      const revenue = parseFloat(nom.revenue || '0');
      if (revenue === 0) continue;

      const accNominal = String(idx - 100);
      const classification = nominalClassification[accNominal] || 'equipment';

      switch (classification) {
        case 'vehicle': vehicleRevenue += revenue; break;
        case 'always20': always20Revenue += revenue; break;
        default: equipmentRevenue += revenue; break;
      }
    }

    // Step 6: Apply HMRC VAT rules per category
    const ukProportion = hireDays > 0 ? ukDays / hireDays : 1;

    // Vehicles
    let vehicleVat: number;
    let vehicleVatReason: string;
    if (vehiclesZeroRated(hireDays, outside)) {
      vehicleVat = 0;
      vehicleVatReason = hireDays >= VEHICLE_ZERO_RATE_MIN_DAYS
        ? `0% VAT (${hireDays} days, 31+ to international business)`
        : '0% VAT (hire starts and ends outside the UK)';
    } else {
      vehicleVat = vehicleRevenue * UK_VAT_RATE;
      vehicleVatReason = 'Full 20% UK VAT (vehicle hire under 31 days that starts or ends in the UK)';
    }

    // Equipment
    const equipmentVat = equipmentRevenue * ukProportion * UK_VAT_RATE;
    const equipmentVatReason = `Proportional: ${ukDays} UK days @ 20%, ${nonUkDays} non-UK days @ 0%`;

    // Always 20%
    const always20Vat = always20Revenue * UK_VAT_RATE;
    const always20VatReason = 'Full 20% UK VAT (services/delivery/crew)';

    // Totals
    const originalVat = totalRevenue * UK_VAT_RATE;
    const adjustedVat = vehicleVat + equipmentVat + always20Vat;
    const vatSaved = originalVat - adjustedVat;
    const originalTotalIncVat = totalRevenue + originalVat;
    const adjustedTotal = totalRevenue + adjustedVat;

    // Build breakdown
    const breakdown: VatBreakdownCategory[] = [];

    if (vehicleRevenue > 0) {
      breakdown.push({
        category: 'Vehicles',
        subtotalNet: vehicleRevenue,
        subtotalVat: vehicleVat,
        subtotalGross: vehicleRevenue + vehicleVat,
        vatSaved: (vehicleRevenue * UK_VAT_RATE) - vehicleVat,
        rule: vehicleVatReason,
      });
    }

    if (equipmentRevenue > 0) {
      breakdown.push({
        category: 'Equipment & Backline',
        subtotalNet: equipmentRevenue,
        subtotalVat: equipmentVat,
        subtotalGross: equipmentRevenue + equipmentVat,
        vatSaved: (equipmentRevenue * UK_VAT_RATE) - equipmentVat,
        rule: equipmentVatReason,
      });
    }

    if (always20Revenue > 0) {
      breakdown.push({
        category: 'Services, Delivery & Other',
        subtotalNet: always20Revenue,
        subtotalVat: always20Vat,
        subtotalGross: always20Revenue + always20Vat,
        vatSaved: 0,
        rule: always20VatReason,
      });
    }

    return {
      applies: true,
      hireDays, ukDays, nonUkDays,
      totalNet: totalRevenue,
      vehicleRevenue, equipmentRevenue, always20Revenue,
      originalVat, adjustedVat, originalTotalIncVat, adjustedTotal, vatSaved,
      breakdown,
      explanationText: 'As an international business customer, your hire qualifies for partial VAT zero-rating under HMRC Notice 741A. The figures below show the correct VAT treatment based on the proportion of UK and non-UK days.',
    };
  } catch (error) {
    console.error('[vat-adjustment] Calculation error:', error);
    return null;
  }
}
