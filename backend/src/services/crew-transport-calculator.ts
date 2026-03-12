/**
 * Crew/Transport Calculator — Core Calculation Engine
 *
 * Ported from the standalone Ooosh D&C Calculator.
 * Three job types: delivery, collection, crewed
 * Two pricing modes: hourly, dayrate
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

export interface ExpenseItem {
  type: string;        // fuel, parking, tolls, hotel, per_diem, other
  description: string;
  amount: number;
  includedInCharge: boolean;  // true = absorbed by us, false = passed to client
}

export interface CalculatorInput {
  jobType: 'delivery' | 'collection' | 'crewed';
  calculationMode: 'hourly' | 'dayrate';
  distanceMiles: number;       // One-way
  driveTimeMins: number;       // One-way
  arrivalTime: string;         // HH:MM — when the person needs to arrive at venue
  workDurationHrs?: number;    // Crewed jobs: hours of work on site
  numDays?: number;            // Day rate mode: number of days
  setupExtraHrs?: number;      // Extra setup/pack-down time (hours)
  setupPremium?: number;       // Flat premium for setup (£)
  travelMethod: 'vehicle' | 'public_transport';
  dayRateOverride?: number;    // Override freelancer day rate
  clientRateOverride?: number; // Override client charge
  expenses: ExpenseItem[];
}

export interface CalculatedCosts {
  clientChargeLabour: number;
  clientChargeFuel: number;
  clientChargeExpenses: number;
  clientChargeTotal: number;
  clientChargeTotalRounded: number;
  freelancerFee: number;
  freelancerFeeRounded: number;
  expectedFuelCost: number;
  expensesIncluded: number;
  expensesNotIncluded: number;
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
    travelMethod, dayRateOverride, clientRateOverride, expenses,
  } = input;

  const setupMins = setupExtraHrs * 60;

  // ── Fuel calculation ──
  // fuel = (totalMiles * fuelPricePerLitre) / milesPerLitre
  const isReturn = jobType !== 'crewed'; // D&C: drive there and back. Crewed: one-way each direction but counted as return too
  const totalMiles = distanceMiles * 2; // Always return trip
  const fuelCost = travelMethod === 'vehicle'
    ? (totalMiles * settings.fuel_price_per_litre) / settings.fuel_efficiency_mpg
    : 0;

  // ── Time calculation ──
  const driveOneWay = driveTimeMins;
  const driveReturn = driveTimeMins; // Same distance back
  const handoverMins = travelMethod === 'vehicle' ? settings.handover_time_mins : 0;
  const unloadMins = (jobType === 'delivery' || jobType === 'collection') ? settings.unload_time_mins : 0;
  const workMins = workDurationHrs * 60;

  // Total engaged time
  let totalEngagedMins: number;
  if (jobType === 'crewed') {
    // Drive there + work + setup + drive back
    totalEngagedMins = driveOneWay + workMins + setupMins + driveReturn;
  } else {
    // D&C: drive there + handover + unload + setup + drive back
    totalEngagedMins = driveOneWay + handoverMins + unloadMins + setupMins + driveReturn;
  }

  // Departure time = arrival time - drive time
  const arrivalMins = parseTime(arrivalTime);
  const departureMins = arrivalMins - driveOneWay;
  const finishMins = departureMins + totalEngagedMins;

  // ── OOH split ──
  const { normalMins, oohMins } = calculateOohSplit(
    departureMins < 0 ? departureMins + 1440 : departureMins,
    finishMins % 1440
  );

  const normalHours = normalMins / 60;
  const oohHours = oohMins / 60;
  const totalHours = totalEngagedMins / 60;

  // ── Expenses ──
  // Exclude fuel from expense sums — fuel is calculated separately from distance
  const fuelExpense = expenses.find(e => e.type === 'fuel');
  const fuelIncludedInCharge = fuelExpense?.includedInCharge ?? true;
  const expensesIncluded = expenses
    .filter(e => e.includedInCharge && e.type !== 'fuel')
    .reduce((sum, e) => sum + e.amount, 0);
  const expensesNotIncluded = expenses
    .filter(e => !e.includedInCharge && e.type !== 'fuel')
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
      clientChargeLabour = clientRateOverride;
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
    if (totalHours < settings.min_hours_threshold && totalHours > 0) {
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
      if (totalHours < settings.min_hours_threshold && totalHours > 0) {
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
  const clientChargeTotal = clientChargeLabour + clientChargeFuel + clientChargeExpenses;
  const clientChargeTotalRounded = Math.max(Math.round(clientChargeTotal), settings.min_client_charge_floor);

  const freelancerFeeRounded = roundToFive(freelancerFee);
  const ourTotalCost = freelancerFeeRounded + fuelCost + expensesIncluded + adminCost;
  const ourMargin = clientChargeTotalRounded - ourTotalCost;

  return {
    clientChargeLabour: round2(clientChargeLabour),
    clientChargeFuel: round2(clientChargeFuel),
    clientChargeExpenses: round2(clientChargeExpenses),
    clientChargeTotal: round2(clientChargeTotal),
    clientChargeTotalRounded,
    freelancerFee: round2(freelancerFee),
    freelancerFeeRounded,
    expectedFuelCost: round2(fuelCost),
    expensesIncluded: round2(expensesIncluded),
    expensesNotIncluded: round2(expensesNotIncluded),
    ourTotalCost: round2(ourTotalCost),
    ourMargin: round2(ourMargin),
    estimatedTimeMinutes: Math.round(totalEngagedMins),
    estimatedTimeHours: round2(totalHours),
    autoEarlyStartMinutes: Math.round(oohMins > 0 && departureMins < 480 ? 480 - Math.max(departureMins, 0) : 0),
    autoLateFinishMinutes: Math.round(oohMins > 0 && finishMins > 1380 ? finishMins - 1380 : 0),
    departureTimeMinutes: Math.round(departureMins < 0 ? departureMins + 1440 : departureMins),
    finishTimeMinutes: Math.round(finishMins % 1440),
    breakdown: {
      driveTimeMinsOneWay: driveOneWay,
      driveTimeMinsReturn: driveReturn,
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
