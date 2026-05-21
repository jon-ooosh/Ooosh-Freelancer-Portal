/**
 * Stripe Client Configuration
 *
 * Wraps the Stripe Node SDK with a singleton client and configured options.
 * Use this module — DO NOT instantiate Stripe directly elsewhere — so that
 * key rotation, retry policy, and API version pinning live in one place.
 *
 * Required env vars:
 *   STRIPE_SECRET_KEY     — restricted key with PaymentIntents (R/W) + Refunds (R/W)
 *                            + Charges (R) + Disputes (R) scopes.
 *   STRIPE_WEBHOOK_SECRET — for verifying inbound webhook signatures (PR 3).
 *                          Not required for outbound API calls (capture / refund / cancel).
 *
 * Stripe API version is pinned so behaviour doesn't shift under us when Stripe
 * releases new versions. Bump deliberately, test in dev, then deploy.
 */
import Stripe from 'stripe';

// Pin to the SDK's bundled LatestApiVersion — Stripe v22.1.1 only accepts this
// exact version string in apiVersion. Bumping the SDK pulls in a new version
// string here automatically (the type narrows to whatever Stripe SDK exports).
type StripeInstance = InstanceType<typeof Stripe>;

let stripeClient: StripeInstance | null = null;

/**
 * Returns the singleton Stripe client. Throws if STRIPE_SECRET_KEY is not set —
 * callers should either guard with isStripeConfigured() before calling, or be
 * comfortable with the throw (the alternative is a silent no-op that drops
 * real money movement requests on the floor).
 */
export function getStripeClient(): StripeInstance {
  if (!process.env.STRIPE_SECRET_KEY) {
    throw new Error(
      'STRIPE_SECRET_KEY is not set. Add it to backend/.env on the server. ' +
      'Stripe operations (capture, refund, cancel) cannot proceed without it.'
    );
  }

  if (!stripeClient) {
    stripeClient = new Stripe(process.env.STRIPE_SECRET_KEY, {
      typescript: true,
      appInfo: {
        name: 'Ooosh Operations Platform',
        version: '1.0.0',
      },
      maxNetworkRetries: 2,
      timeout: 20_000,
    });
    console.log('[stripe] Client initialised (using SDK default API version)');
  }

  return stripeClient;
}

/**
 * Check whether Stripe is configured before attempting an operation. Useful in
 * routes that have both a Stripe-channel and a passive-record code path — we
 * want to give a clean 503 if staff try to capture a Stripe pre-auth on a
 * server that's missing the key, rather than throwing an unhandled exception.
 */
export function isStripeConfigured(): boolean {
  return Boolean(process.env.STRIPE_SECRET_KEY);
}

/**
 * Lightweight type guard for Stripe-thrown errors. Stripe SDK errors all carry
 * a `.type` field starting with "Stripe" (e.g. "StripeInvalidRequestError",
 * "StripeAPIError"). We avoid importing the class type directly because the
 * SDK's type exports vary between versions; the runtime shape is stable.
 */
export interface StripeErrorShape {
  type: string;
  message: string;
  code?: string;
  statusCode?: number;
}

export function isStripeError(err: unknown): err is StripeErrorShape {
  return (
    typeof err === 'object' &&
    err !== null &&
    'type' in err &&
    typeof (err as { type: unknown }).type === 'string' &&
    String((err as { type: unknown }).type).startsWith('Stripe')
  );
}
