/**
 * stripe-webhook.ts — inbound Stripe webhook receiver.
 *
 * Mounted at POST /api/webhooks/stripe in index.ts with express.raw() BEFORE the
 * global express.json() — signature verification needs the raw request body.
 *
 * Handles:
 *   payment_intent.canceled          → release the matching held pre-auth (catches
 *                                       holds voided out-of-band / auto-expired).
 *   charge.dispute.created/updated/closed → flag the excess + email info@ (chargebacks
 *                                       only ever arrive via webhook).
 *   charge.refunded                  → email info@ (notify only; staff reconcile).
 *
 * Idempotency: stripe_events table. A row is inserted on receipt; processed_at is
 * stamped only after the handler succeeds. A failed handler returns 500 so Stripe
 * retries, and the un-stamped row lets the retry reprocess.
 */
import type { Request, Response } from 'express';
import { query } from '../config/database';
import { getStripeClient, isStripeConfigured } from '../config/stripe';
import { emailService } from './email-service';
import { markExcessReleased } from './excess-preauth';

// Minimal structural types for the webhook payload fields we read. The Stripe v22
// SDK doesn't merge its resource types into the default export's namespace, and
// the codebase avoids naming `Stripe.*` types, so we type just what we use.
type StripeEventLike = { id: string; type: string; data: { object: unknown } };
type PaymentIntentObj = { id: string };
type DisputeObj = {
  id: string;
  payment_intent: string | { id: string } | null;
  amount: number;
  currency: string | null;
  reason: string | null;
  status: string | null;
};
type RefundListItem = { id: string; amount: number; created: number };
type ChargeObj = {
  id: string;
  payment_intent: string | { id: string } | null;
  amount_refunded: number;
  refunds?: { data?: RefundListItem[] };
};

function piId(pi: string | { id: string } | null | undefined): string | null {
  if (!pi) return null;
  return typeof pi === 'string' ? pi : pi.id;
}

const ALERT_EMAIL = 'info@oooshtours.co.uk';

interface ExcessRow {
  id: string;
  job_id: string | null;
  hirehop_job_id: number | null;
  client_name: string | null;
  excess_status: string;
}

async function findExcessByPaymentIntent(pi: string | null): Promise<ExcessRow | null> {
  if (!pi) return null;
  const r = await query(
    `SELECT id, job_id, hirehop_job_id, client_name, excess_status
     FROM job_excess WHERE stripe_payment_intent_id = $1
     ORDER BY updated_at DESC LIMIT 1`,
    [pi]
  );
  return r.rows[0] || null;
}

function jobRef(ex: ExcessRow | null): string {
  if (!ex) return '(no matching OP excess record)';
  const bits = [
    ex.client_name || null,
    ex.hirehop_job_id ? `HH job #${ex.hirehop_job_id}` : null,
  ].filter(Boolean);
  return bits.join(' · ') || `excess ${ex.id}`;
}

async function alertInfo(subject: string, lines: string[]): Promise<void> {
  const html = `<p>${lines.join('</p><p>')}</p>`;
  await emailService.sendRaw({ to: ALERT_EMAIL, subject, html, variant: 'internal' })
    .catch((e) => console.error('[stripe-webhook] alert email failed:', e));
}

async function processStripeEvent(event: StripeEventLike): Promise<void> {
  switch (event.type) {
    case 'payment_intent.canceled': {
      const pi = event.data.object as PaymentIntentObj;
      const ex = await findExcessByPaymentIntent(pi.id);
      if (ex) {
        const released = await markExcessReleased(ex.id, 'Stripe hold canceled (webhook)');
        if (released) console.log(`[stripe-webhook] Released excess ${ex.id} on PI ${pi.id} cancel`);
      }
      break;
    }
    case 'charge.dispute.created':
    case 'charge.dispute.updated':
    case 'charge.dispute.closed': {
      const dispute = event.data.object as DisputeObj;
      const ex = await findExcessByPaymentIntent(piId(dispute.payment_intent));

      // Map Stripe dispute status → our flag. Closed disputes resolve to won/lost.
      let flag: 'open' | 'won' | 'lost' = 'open';
      if (event.type === 'charge.dispute.closed') {
        flag = dispute.status === 'won' ? 'won' : 'lost';
      }
      if (ex) {
        await query(
          `UPDATE job_excess SET dispute_status = $1, disputed_at = COALESCE(disputed_at, NOW()), updated_at = NOW() WHERE id = $2`,
          [flag, ex.id]
        );
      }
      const amount = (dispute.amount / 100).toFixed(2);
      await alertInfo(
        `⚠ Stripe chargeback ${flag === 'open' ? 'opened' : flag} — £${amount}`,
        [
          `A Stripe dispute is now <strong>${flag === 'open' ? 'open' : flag}</strong> for £${amount} (${dispute.currency?.toUpperCase()}).`,
          `Reason: ${dispute.reason || 'unknown'}. Stripe dispute id: ${dispute.id}.`,
          `OP excess: ${jobRef(ex)}.`,
          flag === 'open'
            ? `Action needed: respond in the Stripe dashboard before the evidence deadline. The excess record is flagged on the Money tab.`
            : `No further action — recorded for the audit trail.`,
        ]
      );
      break;
    }
    case 'charge.refunded': {
      const charge = event.data.object as ChargeObj;
      const piRef = piId(charge.payment_intent);
      const refunded = (charge.amount_refunded / 100).toFixed(2);

      // Use the latest refund's id for dedup — OP-initiated reimburse (Jun 2026)
      // pre-records a refund_leg keyed `stripe_refund_<id>` so this webhook
      // becomes a no-op for refunds OP itself triggered. Falls back to charge.id
      // only if Stripe doesn't include the refunds list (shouldn't happen on
      // charge.refunded but defensive).
      const latestRefund = charge.refunds?.data
        ?.slice()
        .sort((a, b) => b.created - a.created)[0];
      const sourceRefForDedup = latestRefund
        ? `stripe_refund_${latestRefund.id}`
        : `stripe_charge_${charge.id}`;
      const stripeRefundId = latestRefund?.id || null;

      // Two paths arrive here: refund of an EXCESS (stripe_payment_intent_id
      // on job_excess matches) or refund of a HIRE PAYMENT (stripe_payment_intent
      // on job_payments matches the original payment). Try excess first, then
      // hire. Differentiate the email content so staff aren't told "no matching
      // excess" when it was a hire payment refund the whole time.
      const ex = await findExcessByPaymentIntent(piRef);
      let subject: string;
      let bodyLines: string[];

      if (ex && piRef) {
        // ── Excess refund path ──
        let unwindNote: string;
        try {
          const { unwindRefundOnExcess } = await import('./excess-refund');
          const result = await unwindRefundOnExcess({
            excessId: ex.id,
            amount: parseFloat(refunded),
            source: 'stripe_webhook',
            sourceRef: sourceRefForDedup,
            method: 'stripe_gbp',
            notes: `Stripe charge ${charge.id}`,
          });
          unwindNote = result.updated
            ? `OP excess auto-marked <strong>${result.newStatus}</strong> to match Stripe — no further action needed.`
            : `OP excess not changed: ${result.reason}. Reconcile manually if needed.`;
        } catch (err) {
          console.error('[stripe-webhook] charge.refunded excess unwind failed:', err);
          unwindNote = `OP excess auto-unwind failed — please reconcile manually on the Money tab.`;
        }
        subject = `Stripe excess refund recorded — £${refunded}`;
        bodyLines = [
          `A refund of £${refunded} was processed in Stripe for charge ${charge.id}.`,
          `OP excess: ${jobRef(ex)}.`,
          unwindNote,
        ];
      } else if (piRef) {
        // ── Hire payment refund path ──
        // Find the original payment in job_payments. Then check whether a
        // matching refund leg already exists in job_payments (OP-originated
        // refunds insert one with payment_reference = the Stripe refund id).
        const origPayment = await query(
          `SELECT jp.id, jp.job_id, jp.hirehop_job_id, jp.hirehop_deposit_id, jp.amount,
                  jp.client_name, j.job_name
           FROM job_payments jp
           LEFT JOIN jobs j ON j.id = jp.job_id
           WHERE jp.stripe_payment_intent = $1
             AND jp.payment_type IN ('deposit', 'balance', 'other')
           ORDER BY jp.payment_date DESC LIMIT 1`,
          [piRef]
        );
        const origRow = origPayment.rows[0] || null;

        if (!origRow) {
          subject = `Stripe refund recorded — £${refunded}`;
          bodyLines = [
            `A refund of £${refunded} was processed in Stripe for charge ${charge.id}.`,
            `No matching OP record found (neither excess nor hire payment) — reconcile manually if needed.`,
          ];
        } else {
          // Check for existing refund leg by Stripe refund id (OP-originated)
          // OR by Stripe charge id (defensive). If found, dedup.
          let alreadyRecorded = false;
          if (stripeRefundId) {
            const dedup = await query(
              `SELECT id FROM job_payments
               WHERE job_id = $1 AND payment_type = 'refund'
                 AND (payment_reference = $2 OR payment_reference = $3)
               LIMIT 1`,
              [origRow.job_id, stripeRefundId, `stripe_refund_${stripeRefundId}`]
            );
            alreadyRecorded = dedup.rows.length > 0;
          }

          if (alreadyRecorded) {
            subject = `Stripe refund recorded — £${refunded} (already on OP)`;
            bodyLines = [
              `A refund of £${refunded} was processed in Stripe for charge ${charge.id}.`,
              `Hire payment on ${jobRef({ id: '', job_id: null, hirehop_job_id: origRow.hirehop_job_id, client_name: origRow.client_name, excess_status: '' })} — already recorded in OP. No action needed.`,
            ];
          } else {
            // OP-originated path failed mid-flight OR this is a Stripe-dashboard
            // refund — create the missing OP `job_payments` refund row so the
            // Money tab balance / payment history stays accurate.
            try {
              await query(
                `INSERT INTO job_payments
                  (job_id, hirehop_job_id, payment_type, amount, payment_method,
                   payment_reference, stripe_payment_intent, payment_status, source,
                   hirehop_deposit_id, client_name, notes, payment_date)
                 VALUES ($1, $2, 'refund', $3, 'stripe_gbp', $4, $5, 'completed', 'stripe_webhook', $6, $7, $8, NOW())`,
                [
                  origRow.job_id,
                  origRow.hirehop_job_id,
                  parseFloat(refunded),
                  stripeRefundId || null,
                  piRef,
                  origRow.hirehop_deposit_id,
                  origRow.client_name,
                  `Auto-recorded from Stripe webhook (charge ${charge.id})`,
                ]
              );
              subject = `Stripe hire payment refund recorded — £${refunded}`;
              bodyLines = [
                `A refund of £${refunded} was processed in Stripe for charge ${charge.id}.`,
                `Hire payment on <strong>${origRow.client_name || '—'}</strong> · HH job #${origRow.hirehop_job_id || '—'}${origRow.job_name ? ` (${origRow.job_name})` : ''}.`,
                `OP <strong>auto-recorded</strong> this refund in the payment history — no further action needed. Note: HireHop paperwork (negative payment-application) was NOT pushed by this webhook — verify it's there manually if needed.`,
              ];
            } catch (insertErr) {
              console.error('[stripe-webhook] hire payment refund auto-record failed:', insertErr);
              subject = `Stripe refund recorded — £${refunded}`;
              bodyLines = [
                `A refund of £${refunded} was processed in Stripe for charge ${charge.id}.`,
                `Hire payment on ${origRow.client_name} · HH job #${origRow.hirehop_job_id}. OP failed to auto-record — please reconcile manually on the Money tab.`,
              ];
            }
          }
        }
      } else {
        subject = `Stripe refund recorded — £${refunded}`;
        bodyLines = [
          `A refund of £${refunded} was processed in Stripe for charge ${charge.id}.`,
          `No PaymentIntent on the charge — couldn't look up the matching OP record. Reconcile manually if needed.`,
        ];
      }

      await alertInfo(subject, bodyLines);
      break;
    }
    default:
      // Subscribed to a narrow set; ignore anything else quietly.
      console.log(`[stripe-webhook] Ignoring unhandled event type: ${event.type}`);
  }
}

export async function handleStripeWebhook(req: Request, res: Response): Promise<void> {
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!isStripeConfigured() || !secret) {
    // 503 (not 400) — keeps Stripe's endpoint "alive" rather than treating it as
    // a hard failure, and signals a config gap clearly in logs.
    res.status(503).send('Stripe not configured');
    return;
  }

  const sig = req.headers['stripe-signature'];
  let event: StripeEventLike;
  try {
    // req.body is a Buffer here (express.raw mount). constructEvent verifies the
    // signature and returns the parsed, typed event (we read it structurally).
    event = getStripeClient().webhooks.constructEvent(req.body, sig as string, secret);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[stripe-webhook] signature verification failed:', msg);
    res.status(400).send(`Webhook signature verification failed`);
    return;
  }

  try {
    // Idempotency: skip if already fully processed.
    const existing = await query(`SELECT processed_at FROM stripe_events WHERE id = $1`, [event.id]);
    if (existing.rows.length > 0 && existing.rows[0].processed_at) {
      res.json({ received: true, duplicate: true });
      return;
    }
    await query(
      `INSERT INTO stripe_events (id, type) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING`,
      [event.id, event.type]
    );

    await processStripeEvent(event);

    await query(`UPDATE stripe_events SET processed_at = NOW() WHERE id = $1`, [event.id]);
    res.json({ received: true });
  } catch (err) {
    // Return 500 so Stripe retries; processed_at stays null so the retry reprocesses.
    console.error('[stripe-webhook] processing error:', err);
    res.status(500).send('processing error');
  }
}
