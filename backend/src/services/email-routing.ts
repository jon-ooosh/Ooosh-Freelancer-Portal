/**
 * Email routing — per-bucket recipient overrides per job.
 *
 * The base behaviour ("every client email goes to the primary job_contact")
 * is fine for ~95% of jobs. Per-role routing exists for the cases where
 * staff want a specific email category to go to someone other than the
 * primary — typically invoices to an accountant, hire forms to a tour
 * manager, etc.
 *
 * Storage: `jobs.email_routing JSONB` (migration 102). Sparse map of
 * `{ bucket: string[] }` where the value is an array of person UUIDs.
 * Empty / absent bucket = "use the default primary path." Empty array
 * also means default (treat as not-set).
 *
 * Resolution at send time:
 *  1. Look up the template's bucket via TEMPLATE_BUCKETS.
 *  2. If `jobs.email_routing[bucket]` has any person UUIDs, those become
 *     the recipient list — first = `to`, rest = CC. Any UUID that has no
 *     email is silently skipped; if every override is unreachable, we
 *     fall through to the default path (so a stale override doesn't
 *     accidentally drop the email).
 *  3. If the bucket is empty/absent OR the template has no bucket
 *     mapping, the caller's existing `getJobEmailRecipients`-based
 *     resolution is used (primary job_contact, etc.).
 */
import { query } from '../config/database';

export type EmailBucket =
  | 'bookings_payments'
  | 'send_invoice'
  | 'hire_forms'
  | 'carnet'
  | 'excess'
  | 'delivery_on_day';

/** Canonical bucket list — render order on the picker UI follows this array. */
export const EMAIL_BUCKETS: ReadonlyArray<{
  id: EmailBucket;
  label: string;
  description: string;
}> = [
  {
    id: 'bookings_payments',
    label: 'Bookings & payments',
    description: 'Booking confirmations, payment receipts, last-minute alerts.',
  },
  {
    id: 'send_invoice',
    label: 'Send invoice',
    description: 'Invoices and statements (often a different person — accountant / finance).',
  },
  {
    id: 'hire_forms',
    label: 'Hire forms & driver',
    description: 'Hire form send/chase emails to drivers.',
  },
  {
    id: 'carnet',
    label: 'Carnet',
    description: 'ATA Carnet request form send/chase emails.',
  },
  {
    id: 'excess',
    label: 'Insurance excess',
    description: 'Excess payment confirmations, pre-auth holds, reimbursements, claims.',
  },
  {
    id: 'delivery_on_day',
    label: 'Delivery / on-the-day',
    description: 'Delivery notes, collection confirmations, check-in summaries.',
  },
];

/**
 * Map known template IDs to buckets. Templates not listed here are
 * unrouted — they always go to the default primary path.
 *
 * Internal/staff/freelancer templates (referral_alert, mid_tour_driver,
 * compliance_reminder, under_dispatched_warning, freelancer_assignment,
 * file_resend, ooh_return_*, hire_form_fallback_alert, etc.) are
 * deliberately omitted — those have their own routing rules and the
 * client per-bucket override doesn't apply.
 */
export const TEMPLATE_BUCKETS: Readonly<Record<string, EmailBucket>> = {
  // Bookings & payments
  booking_confirmed_deposit: 'bookings_payments',
  payment_received: 'bookings_payments',
  last_minute_booking: 'bookings_payments',
  job_cancelled_client: 'bookings_payments',

  // Send invoice — reserved for future invoice-sending flow. Currently
  // OP doesn't send invoices directly (HireHop/Xero do); this bucket is
  // here so the picker UI surfaces the slot and a future template can
  // land cleanly.

  // Hire forms & driver-facing client emails
  hire_form_request: 'hire_forms',
  hire_form_chase: 'hire_forms',

  // Carnet request form
  carnet_request: 'carnet',
  carnet_request_chase: 'carnet',

  // Insurance excess (every active lifecycle template)
  excess_payment_confirmed: 'excess',
  excess_preauth_confirmed: 'excess',
  excess_preauth_released: 'excess',
  excess_partial_received: 'excess',
  excess_reimbursed: 'excess',
  excess_partially_reimbursed: 'excess',
  excess_claimed: 'excess',
  excess_rolled_over_applied: 'excess',

  // Delivery / on-the-day
  delivery_note: 'delivery_on_day',
  collection_confirmation: 'delivery_on_day',
  vehicle_checked_in: 'delivery_on_day',
};

/**
 * Resolve a routing override for a (job, template). Returns the primary
 * email + first name + CCs based on the bucket's UUID list, or `null`
 * if no override applies (caller should use default resolution).
 *
 * Stale UUIDs (deleted people, people with no email) are silently
 * skipped. If EVERY UUID is unreachable, returns `null` to let the
 * default path take over rather than dropping the email.
 */
export async function resolveRoutingOverride(
  jobId: string,
  templateId: string
): Promise<{
  primaryEmail: string;
  primaryFirstName: string | null;
  ccEmails: string[];
} | null> {
  const bucket = TEMPLATE_BUCKETS[templateId];
  if (!bucket) return null;

  const jobRow = await query(
    `SELECT email_routing FROM jobs WHERE id = $1`,
    [jobId]
  );
  if (jobRow.rows.length === 0) return null;

  const routing = (jobRow.rows[0].email_routing || {}) as Record<string, string[] | undefined>;
  const personIds = Array.isArray(routing[bucket]) ? routing[bucket]! : [];
  if (personIds.length === 0) return null;

  // Look up the configured people, preserving the picker's order.
  // Skip emailless / deleted rows silently.
  const peopleRows = await query(
    `SELECT id, first_name, email
     FROM people
     WHERE id = ANY($1::uuid[])
       AND is_deleted = false
       AND email IS NOT NULL AND email <> ''`,
    [personIds]
  );
  if (peopleRows.rows.length === 0) return null;

  // Restore picker order (Postgres ANY doesn't preserve it).
  const byId = new Map<string, { first_name: string | null; email: string }>(
    peopleRows.rows.map((r: any) => [r.id, { first_name: r.first_name, email: r.email }])
  );
  const ordered = personIds.map(id => byId.get(id)).filter((x): x is { first_name: string | null; email: string } => !!x);
  if (ordered.length === 0) return null;

  const primary = ordered[0];
  return {
    primaryEmail: primary.email,
    primaryFirstName: primary.first_name || primary.email.split('@')[0] || null,
    ccEmails: ordered.slice(1).map(p => p.email),
  };
}
