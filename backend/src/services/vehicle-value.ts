/**
 * Estimated vehicle value — THE definition (docs/INCIDENT-CLAIMS-SPEC.md §6.6).
 *
 * A deliberately rough replacement-value estimate for the broker's
 * "approximate vehicle value" box (and the vehicle page). Never stored —
 * computed at read time from:
 *
 *   base  = what the van cost, ignoring finance charges: cash_price, or
 *           deposit_paid + amount_financed when no cash price was recorded
 *           (migration 104 — the cash price already excludes finance charges)
 *   start = date_first_reg (≈ when we got it — jon, Sep 2026)
 *
 * The curve (jon, Sep 2026) is not a straight line: an immediate drop on day
 * one, then a yearly rate that starts high and falls by a step each year,
 * never below a floor. Part-years compound pro rata. All four numbers live in
 * system_settings (category 'claims').
 *
 * Figures are EX-VAT: cash_price is stored inc-VAT, and we're VAT-registered
 * and recover VAT, so insurers settle net of it.
 *
 * cash_price is admin-only finance data, so non-admins get the estimate
 * rounded to the nearest £500 — enough for a claim form, not a back door to
 * the purchase price.
 */
import { getSystemSettings } from '../routes/system-settings';

export interface DepreciationCurve {
  initialDropPct: number;   // e.g. 10 — off on the start date
  firstYearPct: number;     // e.g. 17 — year 1's rate
  yearlyStepPct: number;    // e.g. 1  — each later year's rate is this much lower
  floorPct: number;         // e.g. 5  — the rate never falls below this
}

export const DEFAULT_CURVE: DepreciationCurve = {
  initialDropPct: 10,
  firstYearPct: 17,
  yearlyStepPct: 1,
  floorPct: 5,
};

const VAT_DIVISOR = 1.2;
const MS_PER_YEAR = 365.25 * 24 * 60 * 60 * 1000;

/** The yearly rate (as a fraction) for year index i (0 = the first year). */
export function rateForYear(i: number, curve: DepreciationCurve): number {
  const pct = Math.max(curve.floorPct, curve.firstYearPct - curve.yearlyStepPct * i);
  return Math.min(Math.max(pct, 0), 100) / 100;
}

/**
 * Pure: value of `base` after depreciating from `start` to `asOf` on `curve`.
 * Returns null for unusable inputs. A start date in the future just applies
 * the day-one drop.
 */
export function depreciate(base: number, start: Date, asOf: Date, curve: DepreciationCurve): number | null {
  if (!Number.isFinite(base) || base <= 0) return null;
  if (Number.isNaN(start.getTime()) || Number.isNaN(asOf.getTime())) return null;

  let value = base * (1 - Math.min(Math.max(curve.initialDropPct, 0), 100) / 100);
  const years = Math.max(0, (asOf.getTime() - start.getTime()) / MS_PER_YEAR);
  const whole = Math.floor(years);
  for (let i = 0; i < whole; i++) value *= 1 - rateForYear(i, curve);
  const part = years - whole;
  if (part > 0) value *= Math.pow(1 - rateForYear(whole, curve), part);
  return value;
}

export async function loadDepreciationCurve(): Promise<DepreciationCurve> {
  const s = await getSystemSettings([
    'vehicle_value_initial_drop_pct',
    'vehicle_value_first_year_pct',
    'vehicle_value_yearly_step_pct',
    'vehicle_value_floor_pct',
  ]);
  const num = (v: string | null, fallback: number) => {
    const n = parseFloat(v ?? '');
    return Number.isFinite(n) && n >= 0 ? n : fallback;
  };
  return {
    initialDropPct: num(s.vehicle_value_initial_drop_pct, DEFAULT_CURVE.initialDropPct),
    firstYearPct: num(s.vehicle_value_first_year_pct, DEFAULT_CURVE.firstYearPct),
    yearlyStepPct: num(s.vehicle_value_yearly_step_pct, DEFAULT_CURVE.yearlyStepPct),
    floorPct: num(s.vehicle_value_floor_pct, DEFAULT_CURVE.floorPct),
  };
}

export interface VehicleValueInput {
  cash_price?: unknown;
  deposit_paid?: unknown;
  amount_financed?: unknown;
  date_first_reg?: unknown;
}

export interface VehicleValueEstimate {
  value_ex_vat: number;       // already rounded for the caller's role
  rounded_to: number;         // 100 (admin) or 500 (everyone else)
  start_date: string;         // YYYY-MM-DD the curve ran from
}

function toNum(v: unknown): number | null {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** The base price the curve starts from, or null when nothing usable is recorded. */
export function basePrice(row: VehicleValueInput): number | null {
  const cash = toNum(row.cash_price);
  if (cash != null && cash > 0) return cash;
  const dep = toNum(row.deposit_paid);
  const fin = toNum(row.amount_financed);
  if (dep == null && fin == null) return null;
  const sum = (dep || 0) + (fin || 0);
  return sum > 0 ? sum : null;
}

/**
 * Estimate for one fleet_vehicles row (needs cash_price / deposit_paid /
 * amount_financed / date_first_reg selected). Null when either the price or
 * the first-registration date is missing — no guessing.
 */
export async function estimateVehicleValue(
  row: VehicleValueInput,
  opts: { isAdmin: boolean; asOf?: Date; curve?: DepreciationCurve },
): Promise<VehicleValueEstimate | null> {
  const base = basePrice(row);
  if (base == null || !row.date_first_reg) return null;
  const start = row.date_first_reg instanceof Date
    ? row.date_first_reg
    : new Date(`${String(row.date_first_reg).slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(start.getTime())) return null;

  const curve = opts.curve ?? await loadDepreciationCurve();
  const incVat = depreciate(base, start, opts.asOf ?? new Date(), curve);
  if (incVat == null) return null;

  const roundTo = opts.isAdmin ? 100 : 500;
  return {
    value_ex_vat: Math.round(incVat / VAT_DIVISOR / roundTo) * roundTo,
    rounded_to: roundTo,
    start_date: start.toISOString().slice(0, 10),
  };
}
