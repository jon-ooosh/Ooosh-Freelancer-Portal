/**
 * Cancellation Calculator Service
 *
 * Implements Ooosh T&Cs clause 7:
 *   7.1 — Pre-hire cancellation (before hire starts)
 *   7.3 — Early return (after hire has started)
 *
 * Uses post-VAT-adjustment figures when available for maximum accuracy.
 */

// ── Types ──────────────────────────────────────────────────────────────────

export type CancellationTier = '>7_days' | '2_to_7_days' | '<2_days';

export type HireType = 'vehicle' | 'backline' | 'week';

export interface PreHireCancellationInput {
  /** Post-VAT-adjusted ex-VAT hire fee */
  totalHireCost: number;
  /** Job start date */
  hireStartDate: Date;
  /** Date cancellation is being processed (defaults to now) */
  cancellationDate?: Date;
  /** Optional transport/crew costs to add on top */
  transportCharges?: number;
  /** Total hire days (needed for <2 day cap comparison) */
  totalHireDays?: number;
}

export interface CancellationResult {
  /** Amount retained (cancellation charge) */
  fee: number;
  /** Amount to refund */
  refund: number;
  /** Which T&C tier applies */
  tier: CancellationTier;
  /** Calendar days between cancellation and hire start */
  noticeDays: number;
  /** Human-readable breakdown */
  breakdown: string;
  /** Structured fee breakdown lines (only relevant tiers shown) */
  feeBreakdown: Array<{ label: string; amount: number }>;
  /** Copyable summary sentence in UK English */
  summary: string;
  /** Whether the £25+VAT (£30) minimum was used instead of percentage */
  minimumApplied: boolean;
  /** Transport charges included in fee */
  transportIncluded: number;
}

export interface EarlyReturnInput {
  hireType: HireType;
  /** Total hire cost for the full period */
  totalHireCost: number;
  /** Total hire days (calendar) */
  totalHireDays: number;
  /** Days actually used */
  daysUsed: number;
}

export interface EarlyReturnResult {
  /** Amount charged */
  charge: number;
  /** Amount refunded */
  refund: number;
  /** Human-readable breakdown */
  breakdown: string;
}

// ── Constants ──────────────────────────────────────────────────────────────

/** £25 + VAT = £30 minimum cancellation fee */
const MIN_CANCELLATION_FEE = 30;

/** Minimum charge period: 7 calendar days */
const MIN_CHARGE_DAYS = 7;

// ── Pre-Hire Cancellation (Clause 7.1) ─────────────────────────────────

export function calculatePreHireCancellation(input: PreHireCancellationInput): CancellationResult {
  const {
    totalHireCost,
    hireStartDate,
    cancellationDate = new Date(),
    transportCharges = 0,
    totalHireDays,
  } = input;

  // Calculate notice period in calendar days
  const start = new Date(hireStartDate);
  start.setHours(0, 0, 0, 0);
  const cancel = new Date(cancellationDate);
  cancel.setHours(0, 0, 0, 0);
  const noticeDays = Math.ceil((start.getTime() - cancel.getTime()) / (1000 * 60 * 60 * 24));

  let fee: number;
  let tier: CancellationTier;
  let minimumApplied = false;
  const breakdownParts: string[] = [];

  if (noticeDays > 7) {
    // >7 days notice: 10% of hire fee, minimum £25+VAT
    tier = '>7_days';
    const percentFee = totalHireCost * 0.10;
    if (percentFee < MIN_CANCELLATION_FEE) {
      fee = MIN_CANCELLATION_FEE;
      minimumApplied = true;
      breakdownParts.push(`10% of £${totalHireCost.toFixed(2)} = £${percentFee.toFixed(2)}, minimum £30 (£25+VAT) applied`);
    } else {
      fee = percentFee;
      breakdownParts.push(`10% of £${totalHireCost.toFixed(2)} = £${fee.toFixed(2)}`);
    }
    breakdownParts.push(`Notice period: ${noticeDays} days (>7 days — clause 7.1)`);
  } else if (noticeDays >= 2) {
    // 2-7 days notice: 25% of hire fee, minimum £25+VAT
    tier = '2_to_7_days';
    const percentFee = totalHireCost * 0.25;
    if (percentFee < MIN_CANCELLATION_FEE) {
      fee = MIN_CANCELLATION_FEE;
      minimumApplied = true;
      breakdownParts.push(`25% of £${totalHireCost.toFixed(2)} = £${percentFee.toFixed(2)}, minimum £30 (£25+VAT) applied`);
    } else {
      fee = percentFee;
      breakdownParts.push(`25% of £${totalHireCost.toFixed(2)} = £${fee.toFixed(2)}`);
    }
    breakdownParts.push(`Notice period: ${noticeDays} days (2-7 days — clause 7.1)`);
  } else {
    // <2 days notice: 100% OR one week + early return sliding scale, whichever is LESSER
    tier = '<2_days';
    const fullCharge = totalHireCost;

    // Calculate the capped amount: one full week + sliding scale on remainder
    const hireDays = totalHireDays || 14; // Fallback to 14 if not provided
    const earlyReturn = calculateEarlyReturn({
      hireType: 'vehicle',
      totalHireCost,
      totalHireDays: hireDays,
      daysUsed: 0, // Pre-hire: not started yet
    });
    const cappedCharge = earlyReturn.charge;

    if (cappedCharge < fullCharge) {
      fee = cappedCharge;
      breakdownParts.push(`100% = £${fullCharge.toFixed(2)}, capped at one week + sliding scale = £${cappedCharge.toFixed(2)} (lesser applies — clause 7.1/7.3)`);
    } else {
      fee = fullCharge;
      breakdownParts.push(`100% of hire charge = £${fullCharge.toFixed(2)}`);
    }
    breakdownParts.push(`Notice period: ${Math.max(0, noticeDays)} day${noticeDays !== 1 ? 's' : ''} (<2 days — clause 7.1)`);
  }

  // Build structured fee breakdown (only relevant tiers for this hire length)
  const hireDays = totalHireDays || 14;
  const feeBreakdown = buildFeeBreakdown(tier, totalHireCost, hireDays, fee, minimumApplied);

  // Add transport charges
  if (transportCharges > 0) {
    fee += transportCharges;
    feeBreakdown.push({ label: 'Transport/crew charges', amount: transportCharges });
    breakdownParts.push(`Transport/crew charges: £${transportCharges.toFixed(2)}`);
  }

  // Calculate refund
  const refund = Math.max(0, totalHireCost - fee + transportCharges);

  breakdownParts.push(`Cancellation fee: £${fee.toFixed(2)}`);
  breakdownParts.push(`Refund due: £${refund.toFixed(2)}`);

  // Build copyable summary sentence
  const feeRounded = Math.round(fee * 100) / 100;
  const refundRounded = Math.round(refund * 100) / 100;
  const noticeText = Math.max(0, noticeDays);
  const tierText = tier === '>7_days' ? 'more than 7 days\' notice' :
    tier === '2_to_7_days' ? `${noticeText} days' notice` :
    `less than 2 days' notice`;
  const summary = refundRounded > 0
    ? `Cancelled with ${tierText}. £${feeRounded.toFixed(2)} retained as cancellation fee per hire terms (clause 7.1). Refund of £${refundRounded.toFixed(2)} to be processed.`
    : `Cancelled with ${tierText}. Full hire charge of £${feeRounded.toFixed(2)} retained as cancellation fee per hire terms (clause 7.1).`;

  return {
    fee: feeRounded,
    refund: refundRounded,
    tier,
    noticeDays: Math.max(0, noticeDays),
    breakdown: breakdownParts.join('\n'),
    feeBreakdown,
    summary,
    minimumApplied,
    transportIncluded: transportCharges,
  };
}

// ── Early Return (Clause 7.3) ──────────────────────────────────────────

export function calculateEarlyReturn(input: EarlyReturnInput): EarlyReturnResult {
  const { hireType, totalHireCost, totalHireDays, daysUsed } = input;
  const breakdownParts: string[] = [];

  if (daysUsed >= totalHireDays) {
    return {
      charge: totalHireCost,
      refund: 0,
      breakdown: 'Full hire period used — no refund applicable.',
    };
  }

  let charge: number;

  switch (hireType) {
    case 'vehicle': {
      const dailyRate = totalHireCost / totalHireDays;
      const chargedDays = Math.max(daysUsed, MIN_CHARGE_DAYS);

      // Refund tiers based on calendar day position
      const refundAmount = calculateTieredRefund(chargedDays, totalHireDays, dailyRate);
      charge = totalHireCost - refundAmount;

      breakdownParts.push(`Daily rate: £${dailyRate.toFixed(2)}/day`);
      breakdownParts.push(`Days used: ${daysUsed} (minimum charge: ${chargedDays} days)`);
      if (refundAmount > 0) breakdownParts.push(`Tiered refund: £${refundAmount.toFixed(2)}`);
      break;
    }

    case 'backline': {
      const billableTotal = calendarToBillable(totalHireDays);
      const billableCharged = calendarToBillable(Math.max(daysUsed, MIN_CHARGE_DAYS));
      const dailyRate = totalHireCost / billableTotal;

      const refundAmount = calculateTieredRefund(billableCharged, billableTotal, dailyRate);
      charge = totalHireCost - refundAmount;

      breakdownParts.push(`Backline billing: ${billableTotal} billable days (from ${totalHireDays} calendar)`);
      breakdownParts.push(`Charged: ${billableCharged} billable days (min ${calendarToBillable(MIN_CHARGE_DAYS)})`);
      if (refundAmount > 0) breakdownParts.push(`Tiered refund: £${refundAmount.toFixed(2)}`);
      break;
    }

    case 'week': {
      const totalWeeks = Math.ceil(totalHireDays / 7);
      const weeklyRate = totalHireCost / totalWeeks;
      const usedWeeks = Math.max(1, Math.ceil(daysUsed / 7));
      const chargedDays = usedWeeks * 7;
      const totalDaysEquiv = totalWeeks * 7;
      const dayRate = weeklyRate / 7;

      const refundAmount = calculateTieredRefund(chargedDays, totalDaysEquiv, dayRate);
      charge = totalHireCost - refundAmount;

      breakdownParts.push(`Weekly rate: £${weeklyRate.toFixed(2)}/week`);
      breakdownParts.push(`Weeks used: ${usedWeeks} of ${totalWeeks} (minimum: 1 week)`);
      if (refundAmount > 0) breakdownParts.push(`Tiered refund: £${refundAmount.toFixed(2)}`);
      break;
    }
  }

  const refund = Math.max(0, totalHireCost - charge);
  breakdownParts.push(`Charge: £${charge.toFixed(2)}`);
  breakdownParts.push(`Refund: £${refund.toFixed(2)}`);

  return {
    charge: Math.round(charge * 100) / 100,
    refund: Math.round(refund * 100) / 100,
    breakdown: breakdownParts.join('\n'),
  };
}

// ── Helpers ────────────────────────────────────────────────────────────

/**
 * Build a structured fee breakdown showing only the tiers relevant to this hire.
 */
function buildFeeBreakdown(
  tier: CancellationTier,
  totalHireCost: number,
  hireDays: number,
  fee: number,
  minimumApplied: boolean,
): Array<{ label: string; amount: number }> {
  const lines: Array<{ label: string; amount: number }> = [];

  if (tier === '>7_days') {
    if (minimumApplied) {
      lines.push({ label: 'Minimum cancellation fee (£25+VAT)', amount: fee });
    } else {
      lines.push({ label: '10% cancellation fee', amount: fee });
    }
    return lines;
  }

  if (tier === '2_to_7_days') {
    if (minimumApplied) {
      lines.push({ label: 'Minimum cancellation fee (£25+VAT)', amount: fee });
    } else {
      lines.push({ label: '25% cancellation fee', amount: fee });
    }
    return lines;
  }

  // <2 days — show the per-period breakdown
  const dailyRate = totalHireCost / hireDays;

  if (hireDays <= 7) {
    // Short hire: full charge, one line
    lines.push({ label: `Full hire (${hireDays} day${hireDays !== 1 ? 's' : ''})`, amount: fee });
    return lines;
  }

  // First 7 days always fully charged
  const first7 = Math.round(7 * dailyRate * 100) / 100;
  lines.push({ label: 'First 7 days (full rate)', amount: first7 });

  // Days 8-14 at 50% charge (i.e. 50% refunded)
  if (hireDays > 7) {
    const daysInBand = Math.min(hireDays, 14) - 7;
    const bandCost = daysInBand * dailyRate;
    const retained = Math.round(bandCost * 0.5 * 100) / 100;
    lines.push({ label: `Days 8-${Math.min(hireDays, 14)} (50% retained)`, amount: retained });
  }

  // Days 15-30 at 25% charge (i.e. 75% refunded)
  if (hireDays > 14) {
    const daysInBand = Math.min(hireDays, 30) - 14;
    const bandCost = daysInBand * dailyRate;
    const retained = Math.round(bandCost * 0.25 * 100) / 100;
    lines.push({ label: `Days 15-${Math.min(hireDays, 30)} (25% retained)`, amount: retained });
  }

  // Days 31+ at 10% charge (i.e. 90% refunded)
  if (hireDays > 30) {
    const daysInBand = hireDays - 30;
    const bandCost = daysInBand * dailyRate;
    const retained = Math.round(bandCost * 0.1 * 100) / 100;
    lines.push({ label: `Days 31-${hireDays} (10% retained)`, amount: retained });
  }

  return lines;
}

/**
 * Calculate tiered refund based on calendar day position.
 * Tiers (T&C clause 7.3):
 *   Days 8-14:  50% refund per day
 *   Days 15-30: 75% refund per day
 *   Days 31+:   90% refund per day
 *
 * @param chargedDays - Days already charged (minimum 7)
 * @param totalDays - Total hire period days
 * @param dailyRate - Rate per day
 */
function calculateTieredRefund(chargedDays: number, totalDays: number, dailyRate: number): number {
  let refund = 0;
  const start = chargedDays + 1; // First refundable day

  // Days in 8-14 band (50% refund)
  if (start <= 14 && totalDays >= 8) {
    const bandStart = Math.max(start, 8);
    const bandEnd = Math.min(totalDays, 14);
    const days = Math.max(0, bandEnd - bandStart + 1);
    refund += days * dailyRate * 0.50;
  }

  // Days in 15-30 band (75% refund)
  if (start <= 30 && totalDays >= 15) {
    const bandStart = Math.max(start, 15);
    const bandEnd = Math.min(totalDays, 30);
    const days = Math.max(0, bandEnd - bandStart + 1);
    refund += days * dailyRate * 0.75;
  }

  // Days in 31+ band (90% refund)
  if (totalDays >= 31 && start <= totalDays) {
    const bandStart = Math.max(start, 31);
    const days = Math.max(0, totalDays - bandStart + 1);
    refund += days * dailyRate * 0.90;
  }

  return refund;
}

/**
 * Convert calendar days to billable days (backline 4-day billing cycle).
 * Days 1-4 billable, days 5-7 free each week.
 */
function calendarToBillable(calendarDays: number): number {
  const fullWeeks = Math.floor(calendarDays / 7);
  const remainingDays = calendarDays % 7;
  return fullWeeks * 4 + Math.min(remainingDays, 4);
}
