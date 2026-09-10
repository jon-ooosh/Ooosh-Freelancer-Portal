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
  /**
   * Staff adjudication of the iDenfy verdict. Outranks everything below it: a
   * driver iDenfy rejected is not "Approved" and not merely "In Progress",
   * whatever their dates say. Omitted here until Sep 2026, so a flagged driver
   * still badged green in the list while their own page said otherwise.
   */
  identity_check_status?: string | null;
  signature_date: string | null;
  /**
   * HH job the driver has started a hire form for but NOT signed for (from
   * `unsignedJobNumberSql` on the backend). A signature never expires, so a
   * returning driver mid-form for a new hire otherwise reads "Approved" while
   * nothing joins them to it (Cameron Williams-Hill / 16618, Sep 2026).
   */
  unsigned_job_number?: number | null;
  licence_valid_to: string | null;
  dvla_valid_until?: string | null;
  poa1_valid_until: string | null;
  /**
   * Only applies to non-UK licence holders — UK drivers do a DVLA check
   * instead. Which regime a driver is in is decided by the two licence fields
   * below, mirroring services/driver-validity.ts `isUkLicence`.
   */
  passport_valid_until?: string | null;
  licence_issued_by?: string | null;
  licence_issue_country?: string | null;
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

/**
 * Mirrors `isUkLicence` in backend/src/services/driver-validity.ts. Accepts the
 * country as a code OR a name — the hire-form webhook writes the name
 * ("United Kingdom"), not the code.
 */
function isUkLicence(driver: DriverStatusInput): boolean {
  const issuedBy = (driver.licence_issued_by || '').trim().toUpperCase();
  if (issuedBy.includes('DVLA') || issuedBy === 'DVA') return true;
  const country = (driver.licence_issue_country || '').trim().toUpperCase();
  return ['GB', 'UK', 'GBR', 'UNITED KINGDOM', 'GREAT BRITAIN'].includes(country);
}

export function deriveDriverStatus(driver: DriverStatusInput): DriverStatus {
  const green = 'bg-green-100 text-green-700';
  const amber = 'bg-amber-100 text-amber-700';
  const red = 'bg-red-100 text-red-700';

  // Photo ID adjudication comes FIRST — an unresolved or rejected iDenfy check
  // already blocks assignment and withholds the agreement, so the badge has to
  // say so rather than reading "Approved" off dates iDenfy didn't accept.
  if (driver.identity_check_status === 'needs_review') {
    return { label: 'ID Check Needed', colour: red };
  }
  if (driver.identity_check_status === 'rejected') {
    return { label: 'ID Rejected', colour: red };
  }

  if (driver.requires_referral) {
    if (driver.referral_status === 'approved') return { label: 'Approved', colour: green };
    if (driver.referral_status === 'waived') return { label: 'Approved (Waived)', colour: green };
    if (driver.referral_status === 'declined') return { label: 'Not Approved', colour: red };
    if (driver.referral_status === 'pending') return { label: 'Referred & Waiting', colour: amber };
    return { label: 'Refer to Insurers', colour: red };
  }

  if (driver.unsigned_job_number || !driver.signature_date) {
    return { label: 'In Progress', colour: 'bg-blue-100 text-blue-700' };
  }

  if (
    isExpired(driver.licence_valid_to) ||
    isExpired(driver.dvla_valid_until) ||
    isExpired(driver.poa1_valid_until) ||
    (!isUkLicence(driver) && isExpired(driver.passport_valid_until))
  ) {
    return { label: 'Expired', colour: amber };
  }

  return { label: 'Approved', colour: green };
}
