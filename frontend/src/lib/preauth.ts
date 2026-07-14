/**
 * preauth.ts — single source of truth for how a pre-authorisation hold is
 * described in the UI.
 *
 * Before this, RequirementCard, MoneyTab and ExcessPaymentModal each hand-wrote
 * their own pre-auth copy and had drifted into contradicting each other (one
 * surface said "held, releasing imminently, no action needed" while another said
 * "expired, likely already released, verify"). Everything now derives its wording
 * from describePreauth() so they physically cannot disagree.
 *
 * The model is deliberately BINARY — a hold is either Held or Released, never a
 * "maybe". The truth for a stuck past-expiry Stripe hold is resolved server-side
 * (POST /api/excess/:id/reconcile-preauth + the opportunistic self-heal on
 * Money-tab / Overview load); this helper only renders the state the record is
 * actually in.
 */

export interface PreauthLike {
  excess_status?: string | null;
  amount_held?: number | string | null;
  amount_released?: number | string | null;
  held_at?: string | null;
  held_expires_at?: string | null;
  released_at?: string | null;
  payment_method?: string | null;
  stripe_payment_intent_id?: string | null;
}

export type PreauthTone = 'held' | 'released' | 'none';

export interface PreauthDescription {
  tone: PreauthTone;
  isHold: boolean;        // currently a live hold (status pre_auth)
  wasHold: boolean;       // released after having been held (audit fact worth keeping)
  pastExpiry: boolean;    // pre_auth whose expected release window has elapsed
  isStripe: boolean;      // Stripe channel — can be queried/cancelled (vs card-machine)
  amount: number;         // held amount (held) or released amount (released)
  label: string;          // pill text
  labelColour: string;    // tailwind text colour for the pill
  headline: string;       // primary one-liner
  compact: string;        // short line for tight rows
  detail: string;         // action guidance (held) / audit note (released)
  stripeUrl: string | null; // deep-link to the Stripe dashboard for this PaymentIntent
}

/** Deep-link to the exact PaymentIntent in the Stripe dashboard. */
export function stripePaymentUrl(pi?: string | null): string | null {
  return pi ? `https://dashboard.stripe.com/payments/${pi}` : null;
}

const num = (v: unknown): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};
const gbp = (n: number): string =>
  `£${n.toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const gbpDate = (d?: string | null): string | null =>
  d ? new Date(d).toLocaleDateString('en-GB') : null;

export function describePreauth(rec: PreauthLike): PreauthDescription {
  const status = rec.excess_status || '';
  const isStripe = rec.payment_method === 'stripe_gbp';
  const stripeUrl = isStripe ? stripePaymentUrl(rec.stripe_payment_intent_id) : null;

  if (status === 'pre_auth') {
    const amount = num(rec.amount_held);
    const expStr = gbpDate(rec.held_expires_at);
    const pastExpiry = rec.held_expires_at != null && new Date(rec.held_expires_at).getTime() < Date.now();
    // Binary "held": capture if claiming, otherwise it releases on its own.
    // No "maybe" copy even past expiry — the server-side reconcile flips the
    // record to Released once the hold is confirmed gone, and this re-renders.
    const headline = `${gbp(amount)} pre-authorisation held${expStr ? ` — releases ${expStr}` : ''}.`;
    return {
      tone: 'held',
      isHold: true,
      wasHold: false,
      pastExpiry,
      isStripe,
      amount,
      label: 'Pre-auth Held',
      labelColour: 'text-sky-700',
      headline,
      compact: `Held${expStr ? ` · releases ${expStr}` : ''}`,
      detail: 'Capture now if you’re claiming for damage; otherwise it releases on its own — nothing to do.',
      stripeUrl,
    };
  }

  if (status === 'released') {
    const amount = num(rec.amount_released);
    const heldStr = gbpDate(rec.held_at);
    const relStr = gbpDate(rec.released_at);
    const window = heldStr && relStr ? ` ${heldStr}–${relStr}` : relStr ? ` (released ${relStr})` : '';
    return {
      tone: 'released',
      isHold: false,
      wasHold: amount > 0,
      pastExpiry: false,
      isStripe,
      amount,
      label: 'Pre-auth Released',
      labelColour: 'text-gray-500',
      headline: `${gbp(amount)} pre-authorisation was held${window} and released without capture.`,
      compact: `Released${relStr ? ` ${relStr}` : ''}`,
      detail: 'No money was taken. No action needed — kept for the record.',
      stripeUrl,
    };
  }

  return {
    tone: 'none', isHold: false, wasHold: false, pastExpiry: false, isStripe,
    amount: 0, label: '', labelColour: '', headline: '', compact: '', detail: '', stripeUrl,
  };
}
