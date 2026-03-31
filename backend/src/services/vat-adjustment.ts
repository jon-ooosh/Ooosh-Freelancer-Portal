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

// Trigger item pattern
const VAT_TRIGGER_NAME_PATTERN = /non-standard vat/i;

// Standard UK VAT rate
const UK_VAT_RATE = 0.20;

// Vehicle category IDs in HireHop
const VEHICLE_CATEGORY_IDS = [369, 370, 371];

// Always-20% category IDs (storage, rehearsal rooms)
const ALWAYS_20_CATEGORY_IDS = [449, 450];

// Always-20% keyword matches
const ALWAYS_20_KEYWORDS = ['delivery', 'shop', 've103', 'collection', 'admin', 'fee'];

// Min hire days for vehicle zero-rating on entire hire
const VEHICLE_ZERO_RATE_MIN_DAYS = 31;

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
      : (itemsRes.data.items || []);

    // Step 2: Find trigger item and extract non-UK days
    const triggerItem = rawItems.find((item: any) => {
      const itemName = item.title || item.NAME || item.name || '';
      return VAT_TRIGGER_NAME_PATTERN.test(itemName);
    });

    if (!triggerItem) return null; // No trigger = standard UK VAT

    const nonUkDays = parseInt(triggerItem.qty || triggerItem.QTY || '0');
    const ukDays = Math.max(0, hireDays - nonUkDays);

    if (nonUkDays <= 0) return null;

    // Step 3: Build ACC_NOMINAL → VAT category mapping
    const nominalClassification: Record<string, string> = {};

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
    if (vehicleRevenue > 0 && hireDays >= VEHICLE_ZERO_RATE_MIN_DAYS) {
      vehicleVat = 0;
      vehicleVatReason = `0% VAT (${hireDays} days, 31+ to international business)`;
    } else {
      vehicleVat = vehicleRevenue * ukProportion * UK_VAT_RATE;
      vehicleVatReason = `Proportional: ${ukDays} UK days @ 20%, ${nonUkDays} non-UK days @ 0%`;
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
