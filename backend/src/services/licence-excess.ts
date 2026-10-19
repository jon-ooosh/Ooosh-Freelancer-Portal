/**
 * Licence excess — THE definition of "what excess does this driver's record attract".
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * Until Oct 2026 OP could not price excess at all. The rule lived entirely in
 * the hire-form app, split across two places:
 *
 *   functions/document-processor.js   calculateInsuranceDecision() — the tiers
 *   src/DVLAProcessingPage.js:700     (base + additional) * 1.2  — in the BROWSER
 *
 * OP only ever received the finished string ("£2,400") and stored it in
 * `drivers.calculated_excess_amount`. That was survivable while the DVLA flow
 * in the driver's own browser was the only way a check could ever be recorded.
 *
 * It stopped being survivable with the Northern Ireland path. A DVA licence has
 * no GB share code, so the check is run by a member of staff at nidirect and
 * typed into OP — and a staff-entered points value with no way to price it
 * means we insure the driver on an assumed clean licence and charge the £1,200
 * floor regardless (Declan Haughian / 16286, Sep 2026, who happened to be
 * clean — the next one might not be).
 *
 * `excess_rules` (migration 017) is NOT this. That table holds a points-tier
 * schema that no endpoint has ever read; see routes/excess.ts. It is dead and
 * this module deliberately does not revive it — the live rule is the
 * Markerstudy one below, and one dead definition plus one live one is better
 * than two live ones that disagree.
 *
 * DUPLICATION, STATED PLAINLY
 * ---------------------------
 * This is a PORT, not a move: the hire-form app still computes its own copy
 * during the DVLA flow. That is deliberate for one release — the DVLA path runs
 * hundreds of times and changing it in the same breath as adding the NI path
 * would put the working path at risk for the sake of the rare one. The
 * follow-up is to have the app call OP and delete its copy. Until that lands,
 * any change to the tiers below MUST be mirrored in
 * `functions/document-processor.js` in the ooosh-driver-verification- repo.
 *
 * SOURCE OF THE NUMBERS
 * ---------------------
 * Markerstudy SDH Hire Process document, as transcribed in the hire-form app:
 *   Base excess £1,000 net, VAT 20%        → £1,200 gross floor for everyone
 *   Clean (0 pts)                          → +£0      = £1,200
 *   1–6 pts (not a single 6-pointer)       → +£0      = £1,200
 *   Single 6-pt SP30 / SP50 / CU80         → +£1,000  = £2,400
 *   9 pts as exactly three 3-pointers      → +£500    = £1,800
 *   Any other 6-pt offence                 → insurer referral
 *   Any other 9-pt shape, or 7, 8, 10+     → insurer referral
 *   Any serious offence code, or a ban     → insurer referral
 *
 * £1,200 is the FLOOR, never a replacement — a surcharge is added on top.
 */

/**
 * Offence codes that go straight to the insurer regardless of points.
 *
 * Copied verbatim from the hire-form app so the two cannot diverge on the list
 * itself. Drink/drugs (DR), dangerous driving (DD), accidents (AC), no
 * insurance (IN10), failure to identify the driver (MS90), totting-up (TT99),
 * and driving while disqualified (BA).
 */
export const SERIOUS_OFFENCE_CODES = [
  'MS90', 'IN10', 'TT99',
  'DD40', 'DD60', 'DD80', 'DD90',
  'AC10', 'AC20', 'AC30',
  'BA10', 'BA30',
  'DR10', 'DR20', 'DR30', 'DR40', 'DR50', 'DR60', 'DR70', 'DR80',
] as const;

/** Six-point offences Markerstudy accept with a surcharge rather than a referral. */
export const SURCHARGEABLE_SIX_POINT_CODES = ['SP30', 'SP50', 'CU80'] as const;

/** Base excess before VAT, in pounds. Everyone pays at least this. */
export const EXCESS_BASE_NET = 1000;

/** VAT rate applied to base + surcharge. */
export const EXCESS_VAT_RATE = 0.2;

export interface LicenceEndorsement {
  code: string;
  points: number;
}

export interface LicenceExcessInput {
  /** Total current penalty points. */
  points: number;
  /** Current endorsements. An empty list with points > 0 is treated as unknown shape. */
  endorsements: LicenceEndorsement[];
  /** A current or previous disqualification. */
  hasDisqualification?: boolean;
}

export interface LicenceExcessResult {
  /**
   * Gross excess in pounds, VAT included — or null when the record must go to
   * the insurer before any figure can be quoted. Null is NOT zero and must
   * never be coerced into one.
   */
  amount: number | null;
  /** Net surcharge added on top of the base, before VAT. */
  surchargeNet: number;
  /** True when the insurer has to decide. `amount` is null in that case. */
  requiresReferral: boolean;
  /** Why — one line per reason, suitable for `referral_notes`. */
  reasons: string[];
  /** One-line audit string for `calculated_excess_basis`. */
  basis: string;
}

/** Gross, VAT-inclusive excess for a given net surcharge. */
function gross(surchargeNet: number): number {
  return Math.round((EXCESS_BASE_NET + surchargeNet) * (1 + EXCESS_VAT_RATE));
}

/** The £1,200 floor every approved driver pays. Exported so callers can seed. */
export const EXCESS_FLOOR_GROSS = gross(0);

function normaliseCode(code: unknown): string {
  return String(code ?? '').trim().toUpperCase();
}

/**
 * THE definition. Pure — no DB, no dates, no side effects, so both the staff
 * panel and any future caller get the same answer from the same inputs.
 *
 * A referral result returns `amount: null` rather than the floor. The caller
 * decides what to store: we do not quote a figure on a record the insurer
 * hasn't seen, and writing the floor would read as "priced and approved".
 */
export function computeLicenceExcess(input: LicenceExcessInput): LicenceExcessResult {
  const points = Number.isFinite(input.points) ? Math.max(0, Math.trunc(input.points)) : 0;
  const endorsements = (input.endorsements || []).map(e => ({
    code: normaliseCode(e?.code),
    points: Number.isFinite(e?.points) ? Math.max(0, Math.trunc(e.points)) : 0,
  }));

  const refer = (reason: string): LicenceExcessResult => ({
    amount: null,
    surchargeNet: 0,
    requiresReferral: true,
    reasons: [reason],
    basis: `Insurer referral required: ${reason}`,
  });

  const approve = (surchargeNet: number, reason: string): LicenceExcessResult => ({
    amount: gross(surchargeNet),
    surchargeNet,
    requiresReferral: false,
    reasons: [],
    basis: surchargeNet > 0
      ? `${reason} — £${EXCESS_BASE_NET} base + £${surchargeNet} surcharge + VAT`
      : `${reason} — £${EXCESS_BASE_NET} base + VAT`,
  });

  const serious = endorsements.filter(e =>
    (SERIOUS_OFFENCE_CODES as readonly string[]).includes(e.code));
  if (serious.length > 0) {
    return refer(`serious driving offence (${serious.map(e => e.code).join(', ')})`);
  }

  if (input.hasDisqualification) {
    return refer('previous ban or disqualification');
  }

  if (points === 0) {
    return approve(0, 'Clean licence, no points');
  }

  if (points <= 6) {
    // A single 6-pointer is the only 6-point shape with a surcharge rather
    // than a referral; 2×3 adding to 6 is standard.
    if (points === 6 && endorsements.length === 1) {
      const code = endorsements[0].code;
      if ((SURCHARGEABLE_SIX_POINT_CODES as readonly string[]).includes(code)) {
        return approve(1000, `Single 6-point ${code}`);
      }
      return refer(`6-point offence ${code} is not on the pre-approved list`);
    }
    return approve(0, `${points} point${points === 1 ? '' : 's'}, within the standard tier`);
  }

  if (points === 9 && endorsements.length === 3 && endorsements.every(e => e.points === 3)) {
    return approve(500, '9 points from three 3-point offences');
  }

  // Everything else — 7, 8, any other 9-point shape, and 10 or more.
  //
  // The 7-and-8 case reaches here because the hire-form app's tiers go
  // `<= 6`, then `=== 9`, then else. That has always been the behaviour; the
  // app just mislabelled it as "10+ points" in the reason it recorded. The
  // DECISION is ported unchanged — only the wording is now accurate, so a
  // referral for 7 points no longer reads as a referral for 10.
  return refer(`${points} points requires insurer referral`);
}
