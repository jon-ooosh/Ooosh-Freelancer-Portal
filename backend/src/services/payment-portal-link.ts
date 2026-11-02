/**
 * Payment portal link — THE place that knows how to build a client's payment link.
 *
 * The client payment portal (jon-ooosh/netlify-functions, `payment.html`) guards each
 * job with a very basic hash so a client can't change the job number in the URL and
 * land on someone else's booking. It is not a secret: it is HireHop's creator user id,
 * the job duration in hours and the job number, concatenated — exactly what the
 * HireHop quote/proforma document template prints:
 *
 *   {{job.user_id}}{{job.duration_hrs}}{{job.reference}}   →   e.g. 1 + 24 + 16805 = "12416805"
 *
 * The portal's `get-job-details-v2` rebuilds the same string from `job_data.php`
 * (`USER` + `DURATION_HRS` + job number) and compares. So the hash changes whenever the
 * hire dates change — deliberately, since a date change changes the price and the
 * quote document is re-issued with a fresh link.
 *
 * Because of that, OP never STORES the hash: it is computed live from HireHop job data
 * (cached by the broker for a few minutes) every time someone asks for the link, so it
 * can never disagree with the current quote document.
 *
 * Used by: Money tab (`GET /money/:jobId/payment-link`) and the pre-hire briefing's
 * copy-paste-to-client block.
 */
import { hhBroker } from './hirehop-broker';
import { getSystemSetting } from '../routes/system-settings';

/** Staff-editable in system_settings (`payment_portal_base_url`); this is the default. */
const DEFAULT_PORTAL_BASE_URL = 'https://payments.oooshtours.co.uk/payment.html';

export interface PaymentPortalLink {
  url: string;
  hash: string;
  hh_job_number: number;
}

/**
 * Pure: build the hash from the raw HireHop job_data fields. Mirrors the portal's
 * `generateJobHash()` byte for byte (missing fields become empty strings there too).
 */
export function buildPaymentPortalHash(
  hhJob: { USER?: unknown; DURATION_HRS?: unknown },
  hhJobNumber: number,
): string {
  const userId = hhJob.USER == null ? '' : String(hhJob.USER);
  const durationHrs = hhJob.DURATION_HRS == null ? '' : String(hhJob.DURATION_HRS);
  return `${userId}${durationHrs}${hhJobNumber}`;
}

export async function getPaymentPortalBaseUrl(): Promise<string> {
  const configured = await getSystemSetting('payment_portal_base_url');
  const base = (configured || '').trim() || DEFAULT_PORTAL_BASE_URL;
  return base.replace(/\/+$/, '');
}

/**
 * Build the current payment portal link for a HireHop job. Returns null when HireHop
 * can't supply the job (unknown number, broker outage) — callers degrade rather than
 * showing a link that would land on the "no longer valid" screen.
 */
export async function getPaymentPortalLink(hhJobNumber: number): Promise<PaymentPortalLink | null> {
  if (!hhJobNumber || !Number.isFinite(hhJobNumber)) return null;

  const res = await hhBroker.get<Record<string, unknown>>(
    '/api/job_data.php',
    { job: hhJobNumber },
    { priority: 'high', cacheTTL: 300 },
  );
  if (!res.success || !res.data || (res.data as { error?: unknown }).error) {
    console.warn(`[payment-portal-link] HireHop job_data failed for HH#${hhJobNumber}: ${res.error || 'no data'}`);
    return null;
  }

  const hash = buildPaymentPortalHash(res.data as { USER?: unknown; DURATION_HRS?: unknown }, hhJobNumber);
  const base = await getPaymentPortalBaseUrl();
  return {
    url: `${base}?jobId=${hhJobNumber}&hash=${hash}`,
    hash,
    hh_job_number: hhJobNumber,
  };
}
