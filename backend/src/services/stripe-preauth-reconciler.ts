// stripe-preauth-reconciler.ts — Stripe → OP discovery of pre-auth holds OP never learned about.
//
// WHY THIS EXISTS (job 16523, 15 Aug 2026):
// A client authorised a £1,200 excess hold through the Payment Portal. Stripe delivered
// `payment_intent.amount_capturable_updated` to BOTH webhook destinations; OP's own receiver
// stamped the event "processed" despite having no handler for it, so the portal's follow-up
// `payment-event` call deduplicated against that stamp and wrote nothing. The hold was live on
// the client's card and completely invisible in OP — no excess record, no job_payments row.
//
// The root cause is fixed (keyspace separation in stripe-event-claim.ts + an honest receipt log
// in stripe-webhook.ts), but NOTHING would have caught it. A missed CHARGE self-heals: it creates
// a HireHop deposit, and the Money tab's passive reconciliation matches it back. A pre-auth
// creates NO HireHop deposit — only a job note — so there is no HH-side artefact to reconcile
// against. OP's existing 09:40 expiry sweep only reconciles holds OP ALREADY KNOWS ABOUT.
//
// This closes the loop in the only direction left: ask Stripe what it's actually holding.
//
// SELF-HEAL vs ALERT — the rule:
//   * Hold still live AND the hire hasn't finished  → self-heal (replay payment-event).
//     The excess genuinely needs to be on the job: the dispatch gate, the Money tab and the
//     requirement card all read `job_excess`. The client gets the normal pre-auth confirmation
//     email, which is accurate — the hold IS held.
//   * Anything else (finished hire, unknown job, ambiguous) → ALERT ONLY, never auto-write.
//     Emailing a client "we've taken your £1,200 hold" days after their hire ended would be
//     worse than the gap it fixes. A human decides those.

import { query } from '../config/database';
import { getStripeClient, isStripeConfigured } from '../config/stripe';
import { emailService } from './email-service';
import jwt from 'jsonwebtoken';
import { frontendLink } from '../config/app-urls';

const ALERT_EMAIL = 'info@oooshtours.co.uk';

/** Look-back window. Stripe card auths live ~7 days; 10 gives headroom for a late sweep. */
const DEFAULT_LOOKBACK_DAYS = 10;

/** Hard cap on PaymentIntents examined per run (safety valve, not a real limit at our volume). */
const MAX_PIS = 300;

/** Pipeline statuses meaning "the hire is over" — self-heal is NOT appropriate past these. */
const FINISHED_STATUSES = ['returned_incomplete', 'returned', 'completed', 'cancelled', 'lost'];

interface PaymentIntentLike {
  id: string;
  status: string;
  amount: number;
  created: number;
  metadata?: Record<string, string> | null;
}

export interface PreauthReconcileResult {
  skipped?: string;
  examined: number;
  candidates: number;
  healed: number;
  alerted: number;
  failed: number;
}

interface Orphan {
  pi: PaymentIntentLike;
  hhJob: number;
  amount: number;
  reason: string;
  /** OP job uuid, when we resolved one — lets the alert deep-link to the Money tab. */
  jobUuid?: string | null;
}

/**
 * Scan Stripe for live (`requires_capture`) excess pre-auths that OP has no record of.
 * Self-heals the operationally-live ones, alerts on the rest.
 */
export async function reconcileStripePreauths(
  opts: { lookbackDays?: number; dryRun?: boolean } = {}
): Promise<PreauthReconcileResult> {
  const empty: PreauthReconcileResult = { examined: 0, candidates: 0, healed: 0, alerted: 0, failed: 0 };

  if (!isStripeConfigured()) {
    return { ...empty, skipped: 'stripe_not_configured' };
  }

  const lookbackDays = opts.lookbackDays ?? DEFAULT_LOOKBACK_DAYS;
  const createdAfter = Math.floor(Date.now() / 1000) - lookbackDays * 86400;
  const stripe = getStripeClient();

  // ── 1. Pull recent PaymentIntents from Stripe ──────────────────────────────
  const intents: PaymentIntentLike[] = [];
  let startingAfter: string | undefined;
  try {
    while (intents.length < MAX_PIS) {
      const page = (await stripe.paymentIntents.list({
        created: { gte: createdAfter },
        limit: 100,
        ...(startingAfter ? { starting_after: startingAfter } : {}),
      })) as unknown as { data: PaymentIntentLike[]; has_more: boolean };

      intents.push(...page.data);
      if (!page.has_more || page.data.length === 0) break;
      startingAfter = page.data[page.data.length - 1].id;
    }
  } catch (err) {
    console.error('[preauth-reconcile] Stripe list failed:', err);
    return { ...empty, skipped: 'stripe_list_failed' };
  }

  // ── 2. Narrow to live excess pre-auths that came from our Payment Portal ───
  // Same metadata gate the portal's own webhook uses, so we can never act on a
  // PaymentIntent that isn't one of ours.
  const held = intents.filter((pi) => {
    if (pi.status !== 'requires_capture') return false;
    const m = pi.metadata || {};
    return Boolean(m.jobId) && m.paymentType === 'excess' && m.isPreAuth === 'true';
  });

  if (held.length === 0) {
    return { ...empty, examined: intents.length };
  }

  // ── 3. Which of those does OP already know about? ─────────────────────────
  const piIds = held.map((p) => p.id);
  const known = await query(
    `SELECT stripe_payment_intent_id AS pi FROM job_excess
      WHERE stripe_payment_intent_id = ANY($1::text[])
      UNION
     SELECT stripe_payment_intent AS pi FROM job_payments
      WHERE stripe_payment_intent = ANY($1::text[])`,
    [piIds]
  );
  const knownSet = new Set((known.rows as Array<{ pi: string }>).map((r) => r.pi));

  const orphans: Orphan[] = [];
  for (const pi of held) {
    if (knownSet.has(pi.id)) continue;
    const hhJob = parseInt(String(pi.metadata?.jobId ?? ''), 10);
    if (!Number.isFinite(hhJob)) {
      orphans.push({ pi, hhJob: 0, amount: pi.amount / 100, reason: 'unparseable job number in Stripe metadata' });
      continue;
    }
    orphans.push({ pi, hhJob, amount: pi.amount / 100, reason: '' });
  }

  if (orphans.length === 0) {
    return { ...empty, examined: intents.length };
  }

  console.warn(`[preauth-reconcile] ${orphans.length} live Stripe pre-auth(s) not present in OP`);

  // ── 4. Decide self-heal vs alert, per orphan ──────────────────────────────
  const toHeal: Orphan[] = [];
  const toAlert: Orphan[] = [];

  for (const o of orphans) {
    if (!o.hhJob) {
      toAlert.push(o);
      continue;
    }
    const jobRes = await query(
      `SELECT id, pipeline_status, COALESCE(return_date, job_end) AS hire_end
         FROM jobs WHERE hh_job_number = $1`,
      [o.hhJob]
    );
    if (jobRes.rows.length === 0) {
      toAlert.push({ ...o, reason: `job #${o.hhJob} not found in OP` });
      continue;
    }
    const job = jobRes.rows[0] as { id: string; pipeline_status: string | null; hire_end: Date | null };
    const withJob = { ...o, jobUuid: job.id };

    if (job.pipeline_status && FINISHED_STATUSES.includes(job.pipeline_status)) {
      toAlert.push({ ...withJob, reason: `hire already ${job.pipeline_status} — not auto-applying` });
      continue;
    }
    if (job.hire_end && new Date(job.hire_end).getTime() < Date.now() - 86400_000) {
      toAlert.push({ ...withJob, reason: 'hire end date has passed — not auto-applying' });
      continue;
    }
    toHeal.push(withJob);
  }

  // ── 5. Self-heal via the LIVE payment-event endpoint (one computation path) ─
  // Deliberately replays the exact call the portal should have made, over localhost,
  // rather than writing job_excess directly — so excess creation, requirement sync,
  // the dispatch gate and the client email all behave identically to the happy path.
  let healed = 0;
  let failed = 0;
  if (toHeal.length > 0 && !opts.dryRun) {
    const auth = await mintInternalToken();
    if (!auth) {
      toAlert.push(...toHeal.map((o) => ({ ...o, reason: 'could not authenticate self-heal call' })));
    } else {
      for (const o of toHeal) {
        try {
          const resp = await fetch(`${auth.base}/api/money/${o.hhJob}/payment-event`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${auth.token}` },
            body: JSON.stringify({
              payment_type: 'excess_pre_auth',
              amount: o.amount,
              payment_method: 'stripe_gbp',
              stripe_payment_intent: o.pi.id,
              payment_reference: o.pi.id,
              source: 'payment_portal',
              // Durable idempotency key in the portal keyspace — a second sweep before the
              // first has landed can't double-apply.
              stripe_event_id: `reconcile:${o.pi.id}`,
              notes: 'Recovered by Stripe pre-auth reconciler (portal webhook did not land)',
            }),
          });
          if (resp.ok) {
            healed++;
            console.log(`[preauth-reconcile] healed job ${o.hhJob} — £${o.amount} (${o.pi.id})`);
          } else {
            failed++;
            toAlert.push({ ...o, reason: `self-heal failed: HTTP ${resp.status}` });
          }
        } catch (e) {
          failed++;
          toAlert.push({ ...o, reason: `self-heal errored: ${e instanceof Error ? e.message : String(e)}` });
        }
      }
    }
  }

  // ── 6. Alert on anything we deliberately did not touch ────────────────────
  if (toAlert.length > 0 && !opts.dryRun) {
    await sendOrphanAlert(toAlert, healed);
  }

  return {
    examined: intents.length,
    candidates: orphans.length,
    healed,
    alerted: toAlert.length,
    failed,
  };
}

/** Short-lived admin JWT for the localhost self-call (mirrors job-financials-backfill). */
async function mintInternalToken(): Promise<{ token: string; base: string } | null> {
  const secret = process.env.JWT_SECRET;
  if (!secret) {
    console.warn('[preauth-reconcile] JWT_SECRET not set — cannot self-heal');
    return null;
  }
  const userRes = await query(
    `SELECT id, email, role FROM users
      WHERE is_active = true AND role IN ('admin','manager')
      ORDER BY CASE role WHEN 'admin' THEN 0 ELSE 1 END
      LIMIT 1`
  );
  if (userRes.rows.length === 0) {
    console.warn('[preauth-reconcile] no active admin/manager user — cannot self-heal');
    return null;
  }
  const u = userRes.rows[0] as { id: string; email: string; role: string };
  return {
    token: jwt.sign({ id: u.id, email: u.email, role: u.role }, secret, { expiresIn: '10m' }),
    base: `http://127.0.0.1:${process.env.PORT || 3001}`,
  };
}

async function sendOrphanAlert(orphans: Orphan[], healed: number): Promise<void> {
  const lines: string[] = [
    `Stripe is holding ${orphans.length} excess pre-auth${orphans.length === 1 ? '' : 's'} that OP has no record of and did not auto-apply.`,
    '',
  ];
  for (const o of orphans) {
    const stripeUrl = `https://dashboard.stripe.com/payments/${o.pi.id}`;
    const opUrl = o.jobUuid ? frontendLink(`/jobs/${o.jobUuid}?tab=money`) : null;
    lines.push(
      `<strong>£${o.amount.toFixed(2)}</strong> — ` +
        (opUrl ? `<a href="${opUrl}">job #${o.hhJob}</a>` : `job #${o.hhJob || '(unknown)'}`) +
        ` — ${o.reason || 'not present in OP'} — <a href="${stripeUrl}">view in Stripe</a>` +
        // The raw PaymentIntent id, not just the link: recording the hold in OP
        // needs it pasted into the "Stripe PaymentIntent ID" box on Record
        // Pre-Auth, and that's what stops this alert re-firing tomorrow.
        `<br><code style="font-size:12px;color:#666">${o.pi.id}</code>`
    );
  }
  lines.push('');
  lines.push(
    'Decide per hold: capture / release it in Stripe, or record it against the job on the ' +
      'Money tab (Insurance Excess → Manage → Record Pre-Auth Hold, method Stripe GBP, ' +
      'pasting the PaymentIntent id above). Recording it links the hold to the job, lets ' +
      'you capture or release it from OP, and stops this alert.'
  );
  if (healed > 0) {
    lines.push('');
    lines.push(`(${healed} other hold${healed === 1 ? ' was' : 's were'} applied to their job${healed === 1 ? '' : 's'} automatically.)`);
  }

  await emailService
    .sendRaw({
      to: ALERT_EMAIL,
      subject: `Stripe pre-auth${orphans.length === 1 ? '' : 's'} not recorded in OP (${orphans.length})`,
      html: `<p>${lines.join('</p><p>')}</p>`,
      variant: 'internal',
    })
    .catch((e) => console.error('[preauth-reconcile] alert email failed:', e));
}
