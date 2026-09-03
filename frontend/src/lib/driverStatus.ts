/**
 * Driver status badge — the single frontend definition.
 *
 * Mirrors the SQL CASE in backend/src/routes/drivers.ts (the list endpoint's
 * status filter). Keep the two in step: the pills on /drivers filter through
 * the SQL, so a mismatch means clicking "Expired" returns rows badged
 * "Approved".
 *
 * This used to be implemented twice — DriversPage checked licence + DVLA + POA1
 * while DriverDetailPage checked licence + POA1 and omitted DVLA entirely, so a
 * driver with a lapsed DVLA check read "Expired" in the list and "Approved" on
 * their own page (Peter Christopherson, job 16291, Aug 2026).
 */

export interface DriverStatusInput {
  requires_referral: boolean;
  referral_status: string | null;
  signature_date: string | null;
  licence_valid_to: string | null;
  dvla_valid_until?: string | null;
  poa1_valid_until: string | null;
}

export interface DriverStatus {
  label: string;
  colour: string;
}

/**
 * A date that is present AND in the past. Missing dates are NOT expired —
 * iDenfy frequently fails to extract licence_valid_to, and treating a gap as an
 * expiry would badge half the fleet red. Gaps surface on the per-document pills.
 */
function isExpired(date: string | null | undefined): boolean {
  if (!date) return false;
  const d = new Date(date);
  if (isNaN(d.getTime())) return false;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return d < today;
}

export function deriveDriverStatus(driver: DriverStatusInput): DriverStatus {
  const green = 'bg-green-100 text-green-700';
  const amber = 'bg-amber-100 text-amber-700';
  const red = 'bg-red-100 text-red-700';

  if (driver.requires_referral) {
    if (driver.referral_status === 'approved') return { label: 'Approved', colour: green };
    if (driver.referral_status === 'waived') return { label: 'Approved (Waived)', colour: green };
    if (driver.referral_status === 'declined') return { label: 'Not Approved', colour: red };
    if (driver.referral_status === 'pending') return { label: 'Referred & Waiting', colour: amber };
    return { label: 'Refer to Insurers', colour: red };
  }

  if (!driver.signature_date) return { label: 'In Progress', colour: 'bg-blue-100 text-blue-700' };

  if (
    isExpired(driver.licence_valid_to) ||
    isExpired(driver.dvla_valid_until) ||
    isExpired(driver.poa1_valid_until)
  ) {
    return { label: 'Expired', colour: amber };
  }

  return { label: 'Approved', colour: green };
}
