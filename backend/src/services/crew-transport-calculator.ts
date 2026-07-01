/**
 * Crew/Transport Calculator — Core Calculation Engine
 *
 * Ported from the standalone Ooosh D&C Calculator.
 * Three job types: delivery, collection, crewed
 * Two pricing modes: hourly, dayrate
 *
 * ─────────────────────────────────────────────────────────────────────────
 * CANONICAL ENGINE — SINGLE SOURCE OF TRUTH.
 * This file is imported by BOTH the backend (routes/quotes.ts, the save +
 * HireHop-push path) AND the frontend (components/TransportCalculator.tsx,
 * the calculator modal display) via the Vite/tsconfig `@calc` alias. The
 * number the modal shows is computed here, and the number saved + pushed to
 * HireHop is computed here — so they can never drift.
 *
 * RULES for anyone editing this file:
 *   • Keep it PURE — no Node-only or backend-only imports (it gets bundled
 *     into the browser). Plain TS + Math/String/Array only.
 *   • Keep it free of unused locals/params — the frontend typechecks it under
 *     stricter tsconfig flags (noUnusedLocals / noUnusedParameters) than the
 *     backend, so an unused var here breaks the frontend build.
 * ─────────────────────────────────────────────────────────────────────────
 */

export interface CalculatorSettings {
  freelancer_hourly_day: number;
  freelancer_hourly_night: number;
  client_hourly_day: number;
  client_hourly_night: number;
  driver_day_rate: number;
  admin_cost_per_hour: number;
  fuel_price_per_litre: number;
  handover_time_mins: number;
  unload_time_mins: number;
  expense_markup_percent: number;
  min_hours_threshold: number;
  min_client_charge_floor: number;
  day_rate_client_markup: number;
  fuel_efficiency_mpg: number;  // Actually miles per litre in our system
  expense_variance_threshold: number;  // % threshold for expense variance flagging
}

// Per-expense charge mode (three-state). Replaces the binary includedInCharge:
//   included     = in our fixed quote, client pays it now
//   not_included = client sorts it separately (not our money)
//   recharge     = we incur it; client billed the ACTUAL + markup post-hire
//                  (the amount here is an indicative estimate, not the charge)
export type ExpenseChargeMode = 'included' | 'not_included' | 'recharge';

export interface ExpenseItem {
  type: string;        // fuel, parking, tolls, hotel, per_diem, other
  description: string;
  amount: number;
  includedInCharge?: boolean;  // legacy binary — derived from chargeMode for back-compat
  chargeMode?: ExpenseChargeMode;
}

// Back-compat: derive the three-state from whichever the caller sent.
export function expenseChargeMode(e: { chargeMode?: ExpenseChargeMode; includedInCharge?: boolean }): ExpenseChargeMode {
  if (e.chargeMode) return e.chargeMode;
  return e.includedInCharge === false ? 'not_included' : 'included';
}

export interface CalculatorInput {
  jobType: 'delivery' | 'collection' | 'crewed';
  calculationMode: 'hourly' | 'dayrate';
  distanceMiles: number;       // One-way van leg distance
  driveTimeMins: number;       // One-way van leg time
  arrivalTime: string;         // HH:MM — when the person needs to arrive at venue
  workDurationHrs?: number;    // Crewed jobs: hours of work on site
  numDays?: number;            // Day rate mode: number of days
  setupExtraHrs?: number;      // Extra setup/pack-down time (hours)
  setupPremium?: number;       // Flat premium for setup (£)
  travelMethod: 'vehicle' | 'public_transport';
  // Travel-method semantics:
  //   D&C delivery:    'vehicle'         = van there + van back (round trip)
  //                    'public_transport'= van one way + transport the other way (typical)
  //   D&C collection:  same as delivery (one direction by van, the other by transport when public_transport)
  //   Crewed:          'vehicle'         = van both ways
  //                    'public_transport'= transport both ways (no van)
  travelTimeMins?: number;     // Time on the public-transport leg(s). For D&C: one-way. For crewed: round-trip total.
  travelCost?: number;         // Fare for the public-transport leg(s). Same convention as travelTimeMins.
  dayRateOverride?: number;    // Override freelancer day rate
  clientRateOverride?: number; // Override client charge (per-day in dayrate mode, total in hourly mode)
  applyMinHours?: boolean;     // Hourly mode: enforce the minimum-hours floor. Defaults to true
                               // (undefined/null are treated as true) so existing callers are unchanged.
  oohOverride?: { earlyStartMins: number; lateFinishMins: number } | null;
                               // Hourly mode: manual out-of-hours override. When set, these values
                               // replace the auto OOH split derived from arrival/drive time.
  expenses: ExpenseItem[];
}

export interface CalculatedCosts {
  clientChargeLabour: number;
  clientChargeFuel: number;
  clientChargeExpenses: number;
  clientChargeTransport: number;
  clientChargeTotal: number;
  clientChargeTotalRounded: number;
  freelancerFee: number;
  freelancerFeeRounded: number;
  expectedFuelCost: number;
  expensesIncluded: number;
  expensesNotIncluded: number;
  expensesRecharge: number;   // declared "recharge post-hire" estimates (billed at actual + markup)
  ourTotalCost: number;
  ourMargin: number;
  estimatedTimeMinutes: number;
  estimatedTimeHours: number;
  autoEarlyStartMinutes: number;
  autoLateFinishMinutes: number;
  departureTimeMinutes: number;
  finishTimeMinutes: number;
  breakdown: CostBreakdown;
}

export interface CostBreakdown {
  driveTimeMinsOneWay: number;
  driveTimeMinsReturn: number;
  handoverMins: number;
  unloadMins: number;
  setupMins: number;
  workMins: number;
  totalEngagedMins: number;
  normalHours: number;
  oohHours: number;
  freelancerNormalRate: number;
  freelancerOohRate: number;
  clientNormalRate: number;
  clientOohRate: number;
  adminCost: number;
  fuelCost: number;
}

// ── Helpers ──────────────────────────────────────────────────────────────

/** Parse "HH:MM" to minutes since midnight */
function parseTime(hhmm: string): number {
  const [h, m] = hhmm.split(':').map(Number);
  return (h || 0) * 60 + (m || 0);
}

/** Round to nearest £5 */
function roundToFive(n: number): number {
  return Math.ceil(n / 5) * 5;
}

/**
 * Calculate OOH (out-of-hours) minutes.
 * Normal hours: 08:00–23:00 (480–1380 mins)
 * OOH: before 08:00 or after 23:00
 */
function calculateOohSplit(startMins: number, endMins: number): { normalMins: number; oohMins: number } {
  const DAY_START = 8 * 60;   // 08:00
  const DAY_END = 23 * 60;    // 23:00

  // Handle overnight (end next day) — cap at 24h
  const totalMins = endMins > startMins ? endMins - startMins : (1440 - startMins) + endMins;

  let normalMins = 0;
  let oohMins = 0;

  // Walk through each minute and classify
  // More efficient: calculate overlap with normal window
  let current = startMins;
  let remaining = totalMins;

  while (remaining > 0) {
    const normCurrent = current % 1440; // Wrap around midnight

    if (normCurrent >= DAY_START && normCurrent < DAY_END) {
      // In normal hours — count until end of normal window or end of engagement
      const minsUntilDayEnd = DAY_END - normCurrent;
      const chunk = Math.min(remaining, minsUntilDayEnd);
      normalMins += chunk;
      remaining -= chunk;
      current += chunk;
    } else {
      // In OOH — count until start of normal window or end of engagement
      let minsUntilDayStart: number;
      if (normCurrent < DAY_START) {
        minsUntilDayStart = DAY_START - normCurrent;
      } else {
        // After 23:00, next normal start is next day 08:00
        minsUntilDayStart = (1440 - normCurrent) + DAY_START;
      }
      const chunk = Math.min(remaining, minsUntilDayStart);
      oohMins += chunk;
      remaining -= chunk;
      current += chunk;
    }
  }

  return { normalMins, oohMins };
}

// ── Main Calculator ──────────────────────────────────────────────────────

export function calculateCosts(input: CalculatorInput, settings: CalculatorSettings): CalculatedCosts {
  const {
    jobType, calculationMode, distanceMiles, driveTimeMins, arrivalTime,
    workDurationHrs = 0, numDays = 1, setupExtraHrs = 0, setupPremium = 0,
    travelMethod, travelTimeMins = 0, travelCost = 0,
    dayRateOverride, clientRateOverride, applyMinHours, oohOverride = null, expenses,
  } = input;

  // Min-hours floor is on unless explicitly disabled (undefined/null → on).
  const enforceMinHours = applyMinHours !== false;
  const setupMins = setupExtraHrs * 60;

  // ── Leg model ──
  // For D&C: one direction is by van (the delivery/collection direction), the other depends on travelMethod.
  //   travelMethod='vehicle'         → van both ways (rare; round-trip in van)
  //   travelMethod='public_transport'→ van one way + public transport the other way (typical)
  // For crewed: same method both ways.
  //   travelMethod='vehicle'         → van both ways
  //   travelMethod='public_transport'→ public transport both ways (no van)
  const isDC = jobType === 'delivery' || jobType === 'collection';
  let vanLegs: number;
  let transportLegs: number;
  if (travelMethod === 'vehicle') {
    vanLegs = 2;
    transportLegs = 0;
  } else {
    // public_transport
    if (isDC) {
      vanLegs = 1;
      transportLegs = 1;
    } else {
      // Crewed by public transport — no van at all; treat travelTimeMins/travelCost as round-trip totals (×1)
      vanLegs = 0;
      transportLegs = 1;
    }
  }

  // ── Fuel calculation ──
  // fuel = (vanMiles * fuelPricePerLitre) / milesPerLitre
  const totalMiles = distanceMiles * vanLegs;
  const fuelCost = (totalMiles * settings.fuel_price_per_litre) / settings.fuel_efficiency_mpg;

  // ── Time calculation ──
  const driveOneWay = driveTimeMins;            // user input is one-way van time
  const totalDriveMins = driveTimeMins * vanLegs;
  const transportMins = transportLegs * (travelTimeMins || 0);
  const handoverMins = vanLegs > 0 ? settings.handover_time_mins : 0;
  const unloadMins = isDC ? settings.unload_time_mins : 0;
  const workMins = workDurationHrs * 60;

  // Total engaged time — driver paid for both legs (van leg + transport leg if any) plus on-site time
  let totalEngagedMins: number;
  if (jobType === 'crewed') {
    totalEngagedMins = totalDriveMins + transportMins + workMins + setupMins;
  } else {
    totalEngagedMins = totalDriveMins + transportMins + handoverMins + unloadMins + setupMins;
  }

  // Departure time = arrival time - drive time
  const arrivalMins = parseTime(arrivalTime);
  const departureMins = arrivalMins - driveOneWay;
  const finishMins = departureMins + totalEngagedMins;

  // ── OOH split ──
  // Manual override (hourly only): caller supplies early-start / late-finish minutes
  // directly. Otherwise derive the split from the departure/finish times.
  const overrideEarly = oohOverride && calculationMode !== 'dayrate' ? Math.max(0, oohOverride.earlyStartMins || 0) : null;
  const overrideLate = oohOverride && calculationMode !== 'dayrate' ? Math.max(0, oohOverride.lateFinishMins || 0) : null;
  let normalMins: number;
  let oohMins: number;
  if (overrideEarly !== null && overrideLate !== null) {
    oohMins = overrideEarly + overrideLate;
    normalMins = Math.max(0, totalEngagedMins - oohMins);
  } else {
    ({ normalMins, oohMins } = calculateOohSplit(
      departureMins < 0 ? departureMins + 1440 : departureMins,
      finishMins % 1440
    ));
  }

  const normalHours = normalMins / 60;
  const oohHours = oohMins / 60;
  const totalHours = totalEngagedMins / 60;

  // ── Expenses ──
  // Exclude fuel from expense sums — fuel is calculated separately from distance.
  // Three-state: 'included' counts toward the client charge; 'not_included' and
  // 'recharge' are both excluded from the fixed quote (recharge bills at actual
  // post-hire), but tracked separately so the quote can itemise them.
  const fuelExpense = expenses.find(e => e.type === 'fuel');
  const fuelMode = fuelExpense ? expenseChargeMode(fuelExpense) : 'included';
  const fuelIncludedInCharge = fuelMode === 'included';
  const expensesIncluded = expenses
    .filter(e => e.type !== 'fuel' && expenseChargeMode(e) === 'included')
    .reduce((sum, e) => sum + e.amount, 0);
  const expensesNotIncluded = expenses
    .filter(e => e.type !== 'fuel' && expenseChargeMode(e) === 'not_included')
    .reduce((sum, e) => sum + e.amount, 0);
  const expensesRecharge = expenses
    .filter(e => e.type !== 'fuel' && expenseChargeMode(e) === 'recharge')
    .reduce((sum, e) => sum + e.amount, 0);
  const expenseMarkup = expensesIncluded * (settings.expense_markup_percent / 100);

  let freelancerFee: number;
  let clientChargeLabour: number;
  let adminCost: number;

  if (calculationMode === 'dayrate') {
    // ── Day Rate Mode ──
    const baseRate = dayRateOverride || settings.driver_day_rate;
    freelancerFee = (baseRate * numDays) + setupPremium;

    if (clientRateOverride) {
      // Override is the per-day client rate — multiply by numDays to get the labour total
      clientChargeLabour = (clientRateOverride * numDays) + setupPremium;
    } else {
      clientChargeLabour = freelancerFee * settings.day_rate_client_markup;
    }
    adminCost = 0; // No hourly admin in day rate mode

  } else {
    // ── Hourly Mode ──
    // Freelancer fee: normal hours × day rate + OOH hours × night rate
    const freelancerNormal = normalHours * settings.freelancer_hourly_day;
    const freelancerOoh = oohHours * settings.freelancer_hourly_night;
    freelancerFee = freelancerNormal + freelancerOoh + setupPremium;

    // Enforce minimum hours
    if (enforceMinHours && totalHours < settings.min_hours_threshold && totalHours > 0) {
      const minFreelancerFee = settings.min_hours_threshold * settings.freelancer_hourly_day + setupPremium;
      freelancerFee = Math.max(freelancerFee, minFreelancerFee);
    }

    if (clientRateOverride) {
      clientChargeLabour = clientRateOverride;
    } else {
      // Client charge: normal hours × client day rate + OOH hours × client night rate
      const clientNormal = normalHours * settings.client_hourly_day;
      const clientOoh = oohHours * settings.client_hourly_night;
      clientChargeLabour = clientNormal + clientOoh;

      // Enforce minimum hours for client too
      if (enforceMinHours && totalHours < settings.min_hours_threshold && totalHours > 0) {
        const minClientCharge = settings.min_hours_threshold * settings.client_hourly_day;
        clientChargeLabour = Math.max(clientChargeLabour, minClientCharge);
      }
    }

    // Admin cost — added to client labour charge and to our cost
    adminCost = totalHours * settings.admin_cost_per_hour;
    clientChargeLabour += adminCost;
  }

  // ── Totals ──
  // Fuel charge: include in client charge if fuel is marked as "included in charge"
  const clientChargeFuel = fuelIncludedInCharge ? fuelCost : 0;
  // Client expenses: charge for included expenses (in quote) with markup
  const clientChargeExpenses = expensesIncluded + expenseMarkup;
  // Transport cost (train fare etc.): always passed to client with markup, and counted as our cost
  const transportCostTotal = transportLegs * (travelCost || 0);
  const clientChargeTransport = transportCostTotal * (1 + settings.expense_markup_percent / 100);
  const clientChargeTotal = clientChargeLabour + clientChargeFuel + clientChargeExpenses + clientChargeTransport;
  const clientChargeTotalRounded = Math.max(Math.round(clientChargeTotal), settings.min_client_charge_floor);

  const freelancerFeeRounded = roundToFive(freelancerFee);
  const ourTotalCost = freelancerFeeRounded + fuelCost + expensesIncluded + transportCostTotal + adminCost;
  const ourMargin = clientChargeTotalRounded - ourTotalCost;

  return {
    clientChargeLabour: round2(clientChargeLabour),
    clientChargeFuel: round2(clientChargeFuel),
    clientChargeExpenses: round2(clientChargeExpenses),
    clientChargeTransport: round2(clientChargeTransport),
    clientChargeTotal: round2(clientChargeTotal),
    clientChargeTotalRounded,
    freelancerFee: round2(freelancerFee),
    freelancerFeeRounded,
    expectedFuelCost: round2(fuelCost),
    expensesIncluded: round2(expensesIncluded),
    expensesNotIncluded: round2(expensesNotIncluded),
    // Recharge estimate total: the recharge-flagged expense lines + fuel when
    // fuel itself is set to recharge (its estimate is the computed fuel cost).
    expensesRecharge: round2(expensesRecharge + (fuelMode === 'recharge' ? fuelCost : 0)),
    ourTotalCost: round2(ourTotalCost),
    ourMargin: round2(ourMargin),
    estimatedTimeMinutes: Math.round(totalEngagedMins),
    estimatedTimeHours: round2(totalHours),
    autoEarlyStartMinutes: overrideEarly !== null
      ? Math.round(overrideEarly)
      : Math.round(oohMins > 0 && departureMins < 480 ? 480 - Math.max(departureMins, 0) : 0),
    autoLateFinishMinutes: overrideLate !== null
      ? Math.round(overrideLate)
      : Math.round(oohMins > 0 && finishMins > 1380 ? finishMins - 1380 : 0),
    departureTimeMinutes: Math.round(departureMins < 0 ? departureMins + 1440 : departureMins),
    finishTimeMinutes: Math.round(finishMins % 1440),
    breakdown: {
      driveTimeMinsOneWay: driveOneWay,
      driveTimeMinsReturn: vanLegs >= 2 ? driveOneWay : 0,
      handoverMins,
      unloadMins,
      setupMins: Math.round(setupMins),
      workMins: Math.round(workMins),
      totalEngagedMins: Math.round(totalEngagedMins),
      normalHours: round2(normalHours),
      oohHours: round2(oohHours),
      freelancerNormalRate: settings.freelancer_hourly_day,
      freelancerOohRate: settings.freelancer_hourly_night,
      clientNormalRate: settings.client_hourly_day,
      clientOohRate: settings.client_hourly_night,
      adminCost: round2(adminCost),
      fuelCost: round2(fuelCost),
    },
  };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * Apply crew-count multiplication to a calculated result.
 * Per-crew costs (labour, fee, total, margin) scale by headcount; fuel /
 * transport / expenses are accounted for once at the trip level and do not.
 *
 * Used by BOTH the backend save path and the frontend display so a multi-crew
 * quote shows and saves the same figure.
 */
export function applyCrewMultiplier(single: CalculatedCosts, crewCount: number): CalculatedCosts {
  if (crewCount <= 1) return single;
  const scaledClientRounded = Math.round(single.clientChargeTotalRounded * crewCount);
  const scaledOurCost = round2(single.ourTotalCost * crewCount);
  return {
    ...single,
    clientChargeLabour: round2(single.clientChargeLabour * crewCount),
    clientChargeTotal: round2(single.clientChargeTotal * crewCount),
    clientChargeTotalRounded: scaledClientRounded,
    freelancerFee: round2(single.freelancerFee * crewCount),
    freelancerFeeRounded: Math.ceil((single.freelancerFeeRounded * crewCount) / 5) * 5,
    ourTotalCost: scaledOurCost,
    ourMargin: round2(scaledClientRounded - scaledOurCost),
  };
}
