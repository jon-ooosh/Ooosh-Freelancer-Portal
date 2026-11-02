/**
 * stripe-terminal.ts — in-person card payments on the Stripe Reader S700
 * (docs/STRIPE-TERMINAL-SPEC.md, Phases 0–1).
 *
 * Server-driven: OP creates the PaymentIntent and pushes it to the reader by API;
 * nothing runs on the laptop. The result comes back three ways, all funnelled into
 * `applyPaymentIntent()`:
 *   1. the webhook (terminal.reader.action_succeeded / _failed, payment_intent.succeeded / _payment_failed)
 *   2. the modal's poll with `check` (asks Stripe directly — the missing-webhook case)
 *   3. Cancel, which re-reads the PaymentIntent when Stripe refuses to cancel a taken card
 *
 * Recording is `recordPayment()` — THE chain (OP row, HireHop deposit, Booked push,
 * client email, hooks), never a copy. The money is in the Stripe balance, so it is
 * recorded as `stripe_gbp` on HireHop bank 267 exactly like portal money (the
 * PayPal-via-Stripe precedent: the refund paths key on that method + the PaymentIntent).
 * `job_payments.source = 'stripe_terminal'` and the HireHop memo say it was the reader.
 *
 * Idempotency: `terminal_sessions` (migration 291). Recording flips the row
 * pending|failed → recording in ONE statement; whoever wins that records, everyone
 * else no-ops. A webhook re-delivery, the poll and a second webhook for the same
 * payment can never record it twice.
 *
 * Test mode (`system_settings.stripe_terminal_mode = 'test'`) runs the same code on
 * STRIPE_TEST_SECRET_KEY against a simulated reader, and records the result for real
 * (jon, 16 Oct 2026 — prove it end to end on a dummy job; the HireHop deposit carries
 * "TEST MODE" in its memo so it is easy to void).
 */
import { query } from '../config/database';
import { getStripeClientFor, isStripeError } from '../config/stripe';
import { recordPayment, SYSTEM_SERVICE_USER_ID } from './record-payment';
import { emailService } from './email-service';
import { sendPaymentEmail, sendExcessEmail, resolveClientEmailTarget, resolveExcessEmailTarget } from './money-emails';
import { recordPreauthHold, preauthEligibility, PreauthRecordError } from './excess-preauth';
import { createShopSale, validateShopSale, type CreateShopSaleInput, type ShopActor } from './shop-sales';

// Structural types for the fields we read (the codebase avoids naming Stripe.* types).
type ReaderAction = {
  type?: string;
  status?: string;
  failure_code?: string | null;
  failure_message?: string | null;
  process_payment_intent?: { payment_intent?: string | { id: string } | null } | null;
} | null;
type ReaderLike = {
  id: string;
  label?: string | null;
  status?: string | null;
  device_type?: string | null;
  deleted?: boolean;
  action?: ReaderAction;
};
type PaymentIntentLike = {
  id: string;
  status: string;
  amount: number;
  amount_received?: number;
  amount_capturable?: number;
  latest_charge?: string | { id: string; payment_method_details?: { card_present?: { capture_before?: number | null } | null } | null } | null;
  metadata?: Record<string, string> | null;
  last_payment_error?: { code?: string | null; decline_code?: string | null; message?: string | null } | null;
};

export type TerminalMode = 'test' | 'live';
/** deposit / balance = hire money (Record Payment); excess / excess_preauth = the excess
 *  Manage modal (Phase 2). An excess_preauth is a manual-capture PaymentIntent. */
export type TerminalPaymentType = 'deposit' | 'balance' | 'excess' | 'excess_preauth' | 'shop';

export interface TerminalSession {
  id: string;
  job_id: string | null;
  livemode: boolean;
  reader_id: string;
  reader_label: string | null;
  payment_intent_id: string;
  payment_type: TerminalPaymentType;
  amount: string;
  notes: string | null;
  status: 'pending' | 'failed' | 'recording' | 'succeeded' | 'record_failed' | 'cancelled';
  failure_code: string | null;
  failure_message: string | null;
  hh_push_error: string | null;
  job_payment_id: string | null;
  /** This payment moved the job to Booked — its email is the booking confirmation. */
  confirmed_booking: boolean;
  /** "Send receipt?" — see migration 292. NULL on sessions from before it. */
  receipt_status: 'pending' | 'sending' | 'sent' | 'auto_sent' | 'skipped' | 'failed' | null;
  receipt_sent_to: string | null;
  /** The excess record an excess payment / pre-auth lands on (migration 293). */
  excess_id: string | null;
  /** A pre-auth's real expiry, from Stripe. */
  capture_before: string | null;
  /** Something staff must read on the result screen. */
  warning: string | null;
  /** A till sale (Phase 3): the basket waits here until the card is approved. */
  shop_payload: { input: CreateShopSaleInput; actor: ShopActor } | null;
  shop_sale_id: string | null;
  /** A studio sitter who started it (people, no users row). */
  started_by_person_id: string | null;
  started_by: string | null;
  started_at: string;
  finished_at: string | null;
}

/** Marks a PaymentIntent as ours. The portal's own PaymentIntents never carry it. */
const PI_SOURCE = 'op_terminal';
const ALERT_EMAIL = 'info@oooshtours.co.uk';

/** A card the simulated reader declines (Stripe's generic-decline test number). */
const TEST_DECLINE_CARD = '4000000000000002';

export class TerminalError extends Error {
  constructor(message: string, public status = 400) { super(message); }
}

// ── Settings ──────────────────────────────────────────────────────────────

async function readSetting(key: string): Promise<string | null> {
  const r = await query(`SELECT value FROM system_settings WHERE key = $1`, [key]);
  return r.rows[0]?.value ?? null;
}

export async function getTerminalMode(): Promise<TerminalMode> {
  return (await readSetting('stripe_terminal_mode')) === 'live' ? 'live' : 'test';
}

/**
 * May this role use the reader? `stripe_terminal_roles` is admin-only while testing
 * (spec §1.12). An unreadable or empty setting means admin only — never everyone.
 */
export async function canUseTerminal(role: string | undefined): Promise<boolean> {
  if (!role) return false;
  const raw = (await readSetting('stripe_terminal_roles').catch(() => null)) || 'admin';
  const roles = raw.split(',').map((r) => r.trim()).filter(Boolean);
  if (roles.includes(role)) return true;
  // weekend_manager ≡ manager everywhere (CLAUDE.md RBAC).
  return role === 'weekend_manager' && roles.includes('manager');
}

/** Whether the key for this mode is on the server, so the UI can say so plainly. */
export function isModeConfigured(mode: TerminalMode): boolean {
  return Boolean(mode === 'live' ? process.env.STRIPE_SECRET_KEY : process.env.STRIPE_TEST_SECRET_KEY);
}

// ── Readers ───────────────────────────────────────────────────────────────

export interface ReaderSummary { id: string; label: string; status: string; device_type: string | null }

function summarise(r: ReaderLike): ReaderSummary {
  return { id: r.id, label: r.label || r.id, status: r.status || 'unknown', device_type: r.device_type || null };
}

/**
 * Test mode has no hardware, so make sure a simulated reader exists (and a test
 * Location for it to belong to). Idempotent — only creates when there is none.
 */
async function ensureSimulatedReader(): Promise<void> {
  const stripe = getStripeClientFor(false);
  const existing = await stripe.terminal.readers.list({ limit: 1 });
  if (existing.data.length > 0) return;

  const locs = await stripe.terminal.locations.list({ limit: 1 });
  const locationId = locs.data[0]?.id || (await stripe.terminal.locations.create({
    display_name: 'Ooosh (test)',
    address: { line1: '13 Stanford Road', city: 'Brighton', postal_code: 'BN1 5DJ', country: 'GB' },
  })).id;

  // 'simulated-s700' matches the hardware; older API versions only know the
  // WisePOS E simulator, which behaves the same for a server-driven payment.
  try {
    await stripe.terminal.readers.create({ registration_code: 'simulated-s700', location: locationId, label: 'Simulated S700' });
  } catch {
    await stripe.terminal.readers.create({ registration_code: 'simulated-wpe', location: locationId, label: 'Simulated reader' });
  }
  console.log('[terminal] Created a simulated reader in test mode');
}

/** Readers for the current mode, online ones first. */
export async function listReaders(): Promise<{ mode: TerminalMode; readers: ReaderSummary[] }> {
  const mode = await getTerminalMode();
  if (!isModeConfigured(mode)) {
    throw new TerminalError(
      mode === 'live'
        ? 'The live Stripe key is not set on the server.'
        : 'The card reader is in test mode but STRIPE_TEST_SECRET_KEY is not set on the server.',
      503,
    );
  }
  if (mode === 'test') await ensureSimulatedReader();
  const stripe = getStripeClientFor(mode === 'live');
  const list = await stripe.terminal.readers.list({ limit: 20 });
  const readers = (list.data as ReaderLike[]).map(summarise)
    .sort((a, b) => Number(b.status === 'online') - Number(a.status === 'online'));
  return { mode, readers };
}

// ── Sessions ──────────────────────────────────────────────────────────────

async function getSession(id: string): Promise<TerminalSession | null> {
  const r = await query(`SELECT * FROM terminal_sessions WHERE id = $1`, [id]);
  return r.rows[0] || null;
}

async function getSessionByPi(piId: string): Promise<TerminalSession | null> {
  const r = await query(`SELECT * FROM terminal_sessions WHERE payment_intent_id = $1`, [piId]);
  return r.rows[0] || null;
}

/** Stripe's reader errors, in words a person at the desk can act on. */
function readerErrorMessage(err: unknown): { code: string; message: string } {
  const code = isStripeError(err) ? (err.code || err.type) : 'error';
  const known: Record<string, string> = {
    terminal_reader_busy: 'The reader is busy with another payment. Wait for it to finish, then press Try again.',
    terminal_reader_offline: 'The reader is offline. Check it is switched on and on the Wi-Fi, then press Try again.',
    terminal_reader_timeout: 'The reader did not answer in time. Press Try again.',
    terminal_reader_hardware_fault: 'The reader reported a fault. Restart it, then press Try again.',
  };
  const message = known[code] || (err instanceof Error ? err.message : 'The reader could not take the payment.');
  return { code, message };
}

async function markFailed(id: string, code: string | null, message: string | null): Promise<void> {
  await query(
    `UPDATE terminal_sessions
        SET status = 'failed', failure_code = $2, failure_message = $3, updated_at = NOW()
      WHERE id = $1 AND status = 'pending'`,
    [id, code, message],
  );
}

/** Push the session's PaymentIntent to its reader. A refusal leaves the session `failed`. */
async function sendToReader(session: TerminalSession): Promise<void> {
  const stripe = getStripeClientFor(session.livemode);
  try {
    await stripe.terminal.readers.processPaymentIntent(session.reader_id, { payment_intent: session.payment_intent_id });
  } catch (err) {
    const { code, message } = readerErrorMessage(err);
    console.warn(`[terminal] process_payment_intent refused for session ${session.id}: ${code}`);
    await markFailed(session.id, code, message);
  }
}

export interface StartPaymentInput {
  jobId: string;
  amount: number;
  paymentType: TerminalPaymentType;
  readerId: string;
  notes?: string | null;
  userId: string;
  /** Required for excess / excess_preauth. */
  excessId?: string | null;
}

/** The job's hire dates, as the portal reads them for the pre-auth rule. */
async function jobHireDates(jobId: string): Promise<{ start: Date | null; end: Date | null }> {
  const r = await query(`SELECT job_date, out_date, job_end, return_date FROM jobs WHERE id = $1`, [jobId]);
  const j = r.rows[0] || {};
  const start = j.job_date || j.out_date || null;
  const end = j.job_end || j.return_date || null;
  return { start: start ? new Date(start) : null, end: end ? new Date(end) : null };
}

/**
 * What the excess Manage modal may offer on the reader for this record: an excess
 * payment (any time the record still needs money), and a pre-auth only when the
 * portal's rule allows it (preauthEligibility) and the record has nothing on it yet.
 */
export async function excessReaderOptions(excessId: string): Promise<{
  outstanding: number;
  payment: { allowed: boolean; reason: string };
  preauth: { allowed: boolean; reason: string; code: string };
}> {
  const r = await query(
    `SELECT id, job_id, excess_status, excess_amount_required, excess_amount_taken, amount_held, hh_deposit_id
       FROM job_excess WHERE id = $1`,
    [excessId],
  );
  const ex = r.rows[0];
  if (!ex || !ex.job_id) throw new TerminalError('Excess record not found', 404);
  const required = Number(ex.excess_amount_required || 0);
  const taken = Number(ex.excess_amount_taken || 0);
  const held = Number(ex.amount_held || 0);
  const outstanding = Math.max(0, Math.round((required - taken) * 100) / 100);

  // Same states the modal offers "Record Excess Payment" from. A top-up on a record
  // already tied to a HireHop deposit (a rollover chain) goes through the normal form,
  // which carries the chain-break warning — the reader doesn't duplicate it.
  const collectable = ['needed', 'pending', 'partially_paid'].includes(ex.excess_status);
  const chainTopUp = ex.hh_deposit_id != null && !['needed', 'pending'].includes(ex.excess_status);
  const payment = !collectable
    ? { allowed: false, reason: `Nothing to collect: the record is ${String(ex.excess_status).replace(/_/g, ' ')}.` }
    : chainTopUp
      ? { allowed: false, reason: 'This record is tied to a rolled-forward HireHop deposit. Use Record Excess Payment, which handles the chain.' }
      : { allowed: true, reason: '' };

  const clean = ['needed', 'pending'].includes(ex.excess_status) && held === 0 && taken === 0;
  let preauth: { allowed: boolean; reason: string; code: string };
  if (!clean) {
    preauth = { allowed: false, code: 'not_clean', reason: 'A pre-auth needs a record with nothing collected or held yet.' };
  } else {
    const { start, end } = await jobHireDates(ex.job_id);
    const e = preauthEligibility(start, end);
    preauth = { allowed: e.allowed, reason: e.reason, code: e.code };
  }
  return { outstanding, payment, preauth };
}

/** Create the PaymentIntent, record the pending session, send it to the reader. */
export async function startTerminalPayment(input: StartPaymentInput): Promise<TerminalSession> {
  const { jobId, amount, paymentType, readerId, notes, userId } = input;
  const isExcess = paymentType === 'excess' || paymentType === 'excess_preauth';
  const isPreauth = paymentType === 'excess_preauth';
  const mode = await getTerminalMode();
  const livemode = mode === 'live';
  if (!isModeConfigured(mode)) throw new TerminalError('The Stripe key for the card reader is not set on the server.', 503);

  const jobRes = await query(`SELECT id, hh_job_number, job_name FROM jobs WHERE id = $1`, [jobId]);
  const job = jobRes.rows[0];
  if (!job) throw new TerminalError('Job not found', 404);

  const pence = Math.round(amount * 100);
  if (pence < 100) throw new TerminalError('A card payment must be at least £1.00.');

  // Excess: the record must be this job's, and what's being asked must be allowed now —
  // checked here as well as in the modal, so a stale screen can't take a pre-auth the
  // rule no longer permits.
  let excessId: string | null = null;
  if (isExcess) {
    if (!input.excessId) throw new TerminalError('Which excess record is this for?');
    const own = await query(`SELECT id FROM job_excess WHERE id = $1 AND job_id = $2`, [input.excessId, job.id]);
    if (own.rows.length === 0) throw new TerminalError('That excess record is not on this job.', 404);
    const opts = await excessReaderOptions(input.excessId);
    const allowed = isPreauth ? opts.preauth : opts.payment;
    if (!allowed.allowed) throw new TerminalError(allowed.reason);
    excessId = input.excessId;
  }

  const stripe = getStripeClientFor(livemode);
  let reader: ReaderLike;
  try {
    reader = (await stripe.terminal.readers.retrieve(readerId)) as ReaderLike;
  } catch {
    throw new TerminalError('That reader was not found. Refresh the reader list.');
  }
  if (reader.deleted) throw new TerminalError('That reader has been removed from Stripe.');

  const createPi = (extended: boolean) => stripe.paymentIntents.create({
    amount: pence,
    currency: 'gbp',
    payment_method_types: ['card_present'],
    // A pre-auth is authorised now and captured (or released) later from the excess
    // record, exactly like the portal's. Extended authorisation asks for the longer
    // in-person window (the account is "Car rentals" — spec §1.5); the real expiry
    // comes back on the charge as capture_before and is what OP stores.
    capture_method: isPreauth ? 'manual' : 'automatic',
    ...(isPreauth && extended ? { payment_method_options: { card_present: { request_extended_authorization: true } } } : {}),
    description: `Job ${job.hh_job_number ?? ''} ${isPreauth ? 'excess pre-auth' : paymentType} (card reader)`.replace(/\s+/g, ' '),
    metadata: {
      source: PI_SOURCE,
      jobId: job.id,
      hhJobNumber: job.hh_job_number ? String(job.hh_job_number) : '',
      paymentType,
      op_user_id: userId,
      ...(excessId ? { excessId } : {}),
    },
  });
  let pi: Awaited<ReturnType<typeof createPi>>;
  try {
    pi = await createPi(isPreauth);
  } catch (err) {
    // If Stripe won't take extended authorisation (account or card network not
    // eligible), take the ordinary in-person pre-auth instead. Its real expiry still
    // comes back as capture_before, and the result screen warns if it is shorter than
    // the hire.
    if (!isPreauth || !/extended_authorization/i.test(err instanceof Error ? err.message : '')) throw err;
    console.warn('[terminal] extended authorisation refused, using a standard pre-auth:', err instanceof Error ? err.message : err);
    pi = await createPi(false);
  }

  const ins = await query(
    `INSERT INTO terminal_sessions
       (job_id, livemode, reader_id, reader_label, payment_intent_id, payment_type, amount, notes, started_by, excess_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     RETURNING *`,
    [job.id, livemode, reader.id, reader.label || null, pi.id, paymentType, pence / 100, notes || null, userId, excessId],
  );
  const session: TerminalSession = ins.rows[0];

  await sendToReader(session);
  return (await getSession(session.id))!;
}

/**
 * Record an approved card. Only the caller that flips the row to `recording` gets
 * past the first statement — everyone else returns having done nothing.
 */
async function recordApproved(session: TerminalSession, pi: PaymentIntentLike): Promise<void> {
  const claim = await query(
    `UPDATE terminal_sessions SET status = 'recording', updated_at = NOW()
      WHERE id = $1 AND status IN ('pending', 'failed')
      RETURNING *`,
    [session.id],
  );
  if (claim.rows.length === 0) return;
  const s: TerminalSession = claim.rows[0];

  // A walk-in till sale has no job, so this comes before the job check below.
  if (s.payment_type === 'shop') {
    await recordApprovedShop(s, pi);
    return;
  }

  if (!s.job_id) {
    await query(
      `UPDATE terminal_sessions SET status = 'record_failed', failure_message = $2, finished_at = NOW(), updated_at = NOW() WHERE id = $1`,
      [s.id, 'The job this payment was for no longer exists.'],
    );
    return;
  }

  if (s.payment_type === 'excess_preauth') {
    await recordApprovedPreauth(s, pi);
    return;
  }

  const amount = (pi.amount_received ?? pi.amount) / 100;
  // Rides into the HireHop memo ("… via Stripe GBP (Ref: pi_…) - <notes>"), which is
  // what tells someone in HireHop or Xero that this was the reader, and a test.
  const noteParts = [
    s.livemode ? 'Card reader' : 'Card reader TEST MODE - not real money',
    s.reader_label,
    s.notes,
  ].filter(Boolean);

  let result: { status: number; body: { error?: string; hh_push_error?: string | null; data?: { id?: string; booking_confirmed?: boolean } } };
  try {
    result = await recordPayment(s.job_id, {
      payment_type: s.payment_type as 'deposit' | 'balance' | 'excess',
      amount,
      ...(s.payment_type === 'excess' && s.excess_id ? { excess_id: s.excess_id } : {}),
      payment_method: 'stripe_gbp',
      payment_reference: pi.id,
      notes: noteParts.join(' - '),
      push_to_hirehop: true,
      stripe_payment_intent: pi.id,
      source: 'stripe_terminal',
      // The panel asks "Send receipt?" instead (sendTerminalReceipt below).
      skip_client_email: true,
    }, {
      userId: s.started_by || SYSTEM_SERVICE_USER_ID,
      isServiceAccount: !s.started_by,
    });
  } catch (err) {
    result = { status: 500, body: { error: err instanceof Error ? err.message : String(err) } };
  }

  if (result.status === 200) {
    await query(
      `UPDATE terminal_sessions
          SET status = 'succeeded', job_payment_id = $2, hh_push_error = $3,
              confirmed_booking = $4, receipt_status = 'pending',
              failure_code = NULL, failure_message = NULL, finished_at = NOW(), updated_at = NOW()
        WHERE id = $1`,
      [s.id, result.body.data?.id || null, result.body.hh_push_error || null, !!result.body.data?.booking_confirmed],
    );
    console.log(`[terminal] Recorded £${amount.toFixed(2)} (${pi.id}) on job ${s.job_id}${s.livemode ? '' : ' [TEST]'}`);
    return;
  }

  // The card was charged but OP could not record it. Nothing retries this on its own
  // (a retry could double-record if the first attempt got part-way), so say so loudly.
  const reason = result.body.error || `recordPayment returned ${result.status}`;
  await query(
    `UPDATE terminal_sessions SET status = 'record_failed', failure_message = $2, finished_at = NOW(), updated_at = NOW() WHERE id = $1`,
    [s.id, reason],
  );
  console.error(`[terminal] Card approved but recording FAILED for session ${s.id} (${pi.id}): ${reason}`);
  await emailService.sendRaw({
    to: ALERT_EMAIL,
    subject: `⚠ Card reader payment NOT recorded - £${amount.toFixed(2)}`,
    html: `<p>A card payment of <strong>£${amount.toFixed(2)}</strong> was approved on the reader${s.livemode ? '' : ' (TEST MODE)'} but OP could not record it.</p>
<p>Reason: ${reason}</p>
<p>Stripe PaymentIntent: ${pi.id}. The money has been taken - an admin records it by hand on the job's Money tab (method Stripe (Online), reference ${pi.id}).</p>`,
    variant: 'internal',
  }).catch((e) => console.error('[terminal] alert email failed:', e));
}

/**
 * Record an authorised pre-auth on its excess record — recordPreauthHold(), the same
 * path the Manage modal's "Record Pre-Auth" uses — with Stripe's real expiry.
 * Nothing goes to HireHop (that happens at capture). The money is NOT taken: if
 * recording fails the authorisation is still live on the card, so the alert says so.
 */
async function recordApprovedPreauth(s: TerminalSession, piIn: PaymentIntentLike): Promise<void> {
  const stripe = getStripeClientFor(s.livemode);
  let pi = piIn;
  try {
    pi = (await stripe.paymentIntents.retrieve(piIn.id, { expand: ['latest_charge'] })) as PaymentIntentLike;
  } catch (err) {
    console.warn('[terminal] could not expand latest_charge for capture_before:', err instanceof Error ? err.message : err);
  }
  const charge = pi.latest_charge && typeof pi.latest_charge === 'object' ? pi.latest_charge : null;
  const cb = charge?.payment_method_details?.card_present?.capture_before;
  const captureBefore = cb ? new Date(cb * 1000) : null;
  const amount = (pi.amount_capturable || pi.amount) / 100;

  // The hold must last the hire. The rule already only offers a pre-auth within 5 days
  // of the end; this is the check that Stripe's real window agrees.
  let warning: string | null = null;
  if (s.job_id && captureBefore) {
    const { end } = await jobHireDates(s.job_id);
    if (end && captureBefore.getTime() < end.getTime()) {
      const fmt = (d: Date) => d.toLocaleDateString('en-GB', { timeZone: 'Europe/London', weekday: 'short', day: 'numeric', month: 'short' });
      warning = `This pre-auth expires on ${fmt(captureBefore)}, before the hire ends on ${fmt(end)}. Release it and take a payment instead, or capture it before it expires.`;
    }
  }

  try {
    await recordPreauthHold({
      excessId: s.excess_id || '',
      amount,
      method: 'stripe_gbp',
      reference: pi.id,
      stripePaymentIntentId: pi.id,
      expiresAt: captureBefore,
      notes: [s.livemode ? 'Card reader' : 'Card reader TEST MODE - not real money', s.reader_label, s.notes].filter(Boolean).join(' - '),
      userId: s.started_by,
      source: 'stripe_terminal',
    });
  } catch (err) {
    const reason = err instanceof PreauthRecordError ? `${err.message}${err.detail ? ` - ${err.detail}` : ''}` : (err instanceof Error ? err.message : String(err));
    await query(
      `UPDATE terminal_sessions SET status = 'record_failed', failure_message = $2, finished_at = NOW(), updated_at = NOW() WHERE id = $1`,
      [s.id, reason],
    );
    console.error(`[terminal] Pre-auth authorised but recording FAILED for session ${s.id} (${pi.id}): ${reason}`);
    await emailService.sendRaw({
      to: ALERT_EMAIL,
      subject: `⚠ Card reader pre-auth NOT recorded - £${amount.toFixed(2)}`,
      html: `<p>A pre-auth of <strong>£${amount.toFixed(2)}</strong> was authorised on the reader${s.livemode ? '' : ' (TEST MODE)'} but OP could not record it on the excess record.</p>
<p>Reason: ${reason}</p>
<p>Stripe PaymentIntent: ${pi.id}. Nothing has been taken, but the amount is held on the client's card. Either record it on the excess (Record Pre-Auth, method Stripe, PaymentIntent ${pi.id}) or cancel it in the Stripe dashboard to release it.</p>`,
      variant: 'internal',
    }).catch((e) => console.error('[terminal] alert email failed:', e));
    return;
  }

  await query(
    `UPDATE terminal_sessions
        SET status = 'succeeded', capture_before = $2, warning = $3, receipt_status = 'pending',
            failure_code = NULL, failure_message = NULL, finished_at = NOW(), updated_at = NOW()
      WHERE id = $1`,
    [s.id, captureBefore ? captureBefore.toISOString() : null, warning],
  );
  console.log(`[terminal] Pre-auth £${amount.toFixed(2)} (${pi.id}) recorded on excess ${s.excess_id}, expires ${captureBefore?.toISOString() || 'unknown'}${s.livemode ? '' : ' [TEST]'}`);
}

/**
 * A till sale's card was approved: NOW create the sale, exactly as the till would
 * (createShopSale — tender 'card_reader', bank 267), with the PaymentIntent on it so
 * a Refund goes back to the card. Its receipt is the till's own (shop-receipts.ts),
 * sent by the till once it sees the sale — so no "Send receipt?" here.
 */
async function recordApprovedShop(s: TerminalSession, pi: PaymentIntentLike): Promise<void> {
  const charged = (pi.amount_received ?? pi.amount) / 100;
  const payload = s.shop_payload;
  let saleId: string | null = null;
  let warning: string | null = null;
  let reason: string | null = null;
  if (!payload) {
    reason = 'The basket for this payment was not saved.';
  } else {
    try {
      const created = await createShopSale(
        { ...payload.input, kind: 'sale', tender: 'card_reader', stripePaymentIntent: pi.id },
        payload.actor,
      );
      saleId = created.id;
      if (Math.abs(created.totals.gross - charged) >= 0.005) {
        warning = `The card was charged £${charged.toFixed(2)} but the sale came to £${created.totals.gross.toFixed(2)} (a price changed in between). Check the sale.`;
      }
    } catch (err) {
      reason = err instanceof Error ? err.message : String(err);
    }
  }

  if (saleId) {
    await query(
      `UPDATE terminal_sessions
          SET status = 'succeeded', shop_sale_id = $2, warning = $3,
              failure_code = NULL, failure_message = NULL, finished_at = NOW(), updated_at = NOW()
        WHERE id = $1`,
      [s.id, saleId, warning],
    );
    console.log(`[terminal] Shop sale ${saleId} recorded, £${charged.toFixed(2)} (${pi.id})${s.livemode ? '' : ' [TEST]'}`);
    return;
  }

  await query(
    `UPDATE terminal_sessions SET status = 'record_failed', failure_message = $2, finished_at = NOW(), updated_at = NOW() WHERE id = $1`,
    [s.id, reason],
  );
  console.error(`[terminal] Shop card approved but the sale was NOT recorded (session ${s.id}, ${pi.id}): ${reason}`);
  await emailService.sendRaw({
    to: ALERT_EMAIL,
    subject: `⚠ Card reader shop sale NOT recorded - £${charged.toFixed(2)}`,
    html: `<p>A shop sale of <strong>£${charged.toFixed(2)}</strong> was paid on the card reader${s.livemode ? '' : ' (TEST MODE)'} but OP could not record the sale.</p>
<p>Reason: ${reason}</p>
<p>Stripe PaymentIntent: ${pi.id}. The money has been taken - either refund it in the Stripe dashboard, or ring the sale up on the till by hand (method Stripe) so the stock and the money are recorded.</p>`,
    variant: 'internal',
  }).catch((e) => console.error('[terminal] alert email failed:', e));
}

export interface StartShopPaymentInput {
  /** The till's basket — createShopSale's input, minus the tender (it is the reader). */
  input: Omit<CreateShopSaleInput, 'tender' | 'kind' | 'stripePaymentIntent'>;
  actor: ShopActor;
  readerId: string;
}

/**
 * Take a till sale on the reader. The basket is priced and checked FIRST
 * (validateShopSale — the same checks createShopSale makes), and the amount sent
 * to the reader is the server's total, never the till's. The prices are frozen on
 * the session so the sale created after the tap charges what the card was charged.
 */
export async function startShopTerminalPayment(opts: StartShopPaymentInput): Promise<TerminalSession> {
  const mode = await getTerminalMode();
  const livemode = mode === 'live';
  if (!isModeConfigured(mode)) throw new TerminalError('The Stripe key for the card reader is not set on the server.', 503);

  const input: CreateShopSaleInput = { ...opts.input, kind: 'sale', tender: 'card_reader' };
  let checked: Awaited<ReturnType<typeof validateShopSale>>;
  try {
    checked = await validateShopSale(input, opts.actor);
  } catch (err) {
    throw new TerminalError(err instanceof Error ? err.message : 'Could not price that basket.');
  }
  const pence = Math.round(checked.totals.gross * 100);
  // Stripe's own floor for a GBP card payment.
  if (pence < 30) throw new TerminalError('A card payment must be at least £0.30.');
  const frozen: CreateShopSaleInput = {
    ...input,
    lines: checked.priced.map((l) => ({ hhStockId: l.hhStockId, qty: l.qty, unitPriceCharged: l.unitPriceCharged })),
  };

  const stripe = getStripeClientFor(livemode);
  let reader: ReaderLike;
  try {
    reader = (await stripe.terminal.readers.retrieve(opts.readerId)) as ReaderLike;
  } catch {
    throw new TerminalError('That reader was not found. Refresh the reader list.');
  }
  if (reader.deleted) throw new TerminalError('That reader has been removed from Stripe.');

  const pi = await stripe.paymentIntents.create({
    amount: pence,
    currency: 'gbp',
    payment_method_types: ['card_present'],
    capture_method: 'automatic',
    description: `Shop sale (card reader${input.recordedIn === 'sitter_till' ? ', sitter till' : ''})`,
    metadata: {
      source: PI_SOURCE,
      paymentType: 'shop',
      ...(input.soldToJobId ? { jobId: input.soldToJobId } : {}),
      ...(opts.actor.id ? { op_user_id: opts.actor.id } : {}),
      ...(opts.actor.personId ? { op_person_id: opts.actor.personId } : {}),
    },
  });

  const ins = await query(
    `INSERT INTO terminal_sessions
       (job_id, livemode, reader_id, reader_label, payment_intent_id, payment_type, amount, notes,
        started_by, started_by_person_id, shop_payload)
     VALUES ($1, $2, $3, $4, $5, 'shop', $6, $7, $8, $9, $10)
     RETURNING *`,
    [
      input.soldToJobId || null, livemode, reader.id, reader.label || null, pi.id, pence / 100,
      input.notes || null, opts.actor.id || null, opts.actor.personId || null,
      JSON.stringify({ input: frozen, actor: opts.actor }),
    ],
  );
  const session: TerminalSession = ins.rows[0];
  await sendToReader(session);
  return (await getSession(session.id))!;
}

/** For the kiosk till: it may only see and act on sessions a kiosk sale started. */
export async function sessionStartedByKiosk(id: string): Promise<boolean> {
  const r = await query(`SELECT 1 FROM terminal_sessions WHERE id = $1 AND shop_payload->'actor'->>'via' = 'kiosk'`, [id]);
  return r.rows.length > 0;
}

/** For the sitter till: a sitter may only see and act on sessions they started. */
export async function sessionStartedByPerson(id: string, personId: string): Promise<boolean> {
  const r = await query(`SELECT 1 FROM terminal_sessions WHERE id = $1 AND started_by_person_id = $2`, [id, personId]);
  return r.rows.length > 0;
}

/** Approved: a payment that succeeded, or a pre-auth that is now waiting to be captured. */
function isApproved(session: TerminalSession, pi: PaymentIntentLike): boolean {
  return pi.status === 'succeeded' || (session.payment_type === 'excess_preauth' && pi.status === 'requires_capture');
}

/**
 * Bring a session in line with what Stripe says about its PaymentIntent.
 *
 * `trustLastError`: only a fresh `payment_intent.payment_failed` event may mark the
 * session failed from the PaymentIntent. A PaymentIntent keeps its `last_payment_error`
 * after Try again re-sends it, so a poll reading it then would fail a payment that is
 * still waiting for the card — polls read the reader's action instead.
 */
async function applyPaymentIntent(session: TerminalSession, pi: PaymentIntentLike, trustLastError: boolean): Promise<void> {
  if (isApproved(session, pi)) {
    await recordApproved(session, pi);
  } else if (pi.status === 'canceled') {
    await query(
      `UPDATE terminal_sessions SET status = 'cancelled', finished_at = NOW(), updated_at = NOW()
        WHERE id = $1 AND status IN ('pending', 'failed')`,
      [session.id],
    );
  } else if (trustLastError && pi.status === 'requires_payment_method' && pi.last_payment_error) {
    const e = pi.last_payment_error;
    await markFailed(session.id, e.decline_code || e.code || 'declined', e.message || 'The card was declined.');
  }
}

/** Ask Stripe directly (the poll's `check`, and the missing-webhook case). */
export async function checkSession(id: string): Promise<TerminalSession | null> {
  const session = await getSession(id);
  if (!session) return null;
  if (session.status !== 'pending' && session.status !== 'failed') return session;

  const stripe = getStripeClientFor(session.livemode);
  const pi = (await stripe.paymentIntents.retrieve(session.payment_intent_id)) as PaymentIntentLike;
  await applyPaymentIntent(session, pi, false);

  // A decline or a reader-side failure (card removed, timed out): the reader's action
  // for THIS PaymentIntent says what happened.
  const after = await getSession(id);
  if (after?.status === 'pending') {
    try {
      const reader = (await stripe.terminal.readers.retrieve(session.reader_id)) as ReaderLike;
      const action = reader.action;
      const actionPi = action?.process_payment_intent?.payment_intent;
      const actionPiId = typeof actionPi === 'string' ? actionPi : actionPi?.id;
      if (action?.status === 'failed' && actionPiId === session.payment_intent_id) {
        await markFailed(id, action.failure_code || 'reader_failed', action.failure_message || 'The reader could not take the card.');
      }
    } catch (err) {
      console.warn('[terminal] reader read failed during check:', err instanceof Error ? err.message : err);
    }
  }
  return getSession(id);
}

export async function readSession(id: string, check: boolean): Promise<TerminalSession | null> {
  return check ? checkSession(id) : getSession(id);
}

/** Try again after a decline: the SAME PaymentIntent (never a new one — no double charge). */
export async function retrySession(id: string): Promise<TerminalSession> {
  const session = await checkSession(id);
  if (!session) throw new TerminalError('Payment not found', 404);
  if (session.status !== 'failed' && session.status !== 'pending') return session;
  await query(
    `UPDATE terminal_sessions SET status = 'pending', failure_code = NULL, failure_message = NULL, updated_at = NOW()
      WHERE id = $1 AND status IN ('failed', 'pending')`,
    [id],
  );
  await sendToReader({ ...session, status: 'pending' });
  return (await getSession(id))!;
}

/**
 * Cancel before a card is taken: clear the reader, then cancel the PaymentIntent so it
 * can never be charged later. If Stripe says the card was already taken, the
 * PaymentIntent is re-read and recorded instead — the honest outcome.
 */
export async function cancelSession(id: string): Promise<TerminalSession> {
  const session = await getSession(id);
  if (!session) throw new TerminalError('Payment not found', 404);
  if (session.status !== 'pending' && session.status !== 'failed') return session;

  const stripe = getStripeClientFor(session.livemode);
  try {
    await stripe.terminal.readers.cancelAction(session.reader_id);
  } catch (err) {
    // No action in progress (already declined / cleared) is fine; anything else is logged.
    console.warn('[terminal] cancel_action:', err instanceof Error ? err.message : err);
  }
  try {
    await stripe.paymentIntents.cancel(session.payment_intent_id);
  } catch (err) {
    console.warn('[terminal] PaymentIntent cancel refused:', err instanceof Error ? err.message : err);
  }
  const pi = (await stripe.paymentIntents.retrieve(session.payment_intent_id)) as PaymentIntentLike;
  await applyPaymentIntent(session, pi, false);
  const after = (await getSession(id))!;
  if (after.status === 'pending' || after.status === 'failed') {
    throw new TerminalError('Stripe would not cancel this payment. Press Check status.', 409);
  }
  return after;
}

/** Test mode only: tap a pretend card on the simulated reader. */
export async function simulateTap(id: string, outcome: 'approve' | 'decline'): Promise<TerminalSession> {
  const session = await getSession(id);
  if (!session) throw new TerminalError('Payment not found', 404);
  if (session.livemode) throw new TerminalError('Simulated cards only work in test mode.');
  if (session.status !== 'pending') return session;

  const stripe = getStripeClientFor(false);
  try {
    await stripe.testHelpers.terminal.readers.presentPaymentMethod(
      session.reader_id,
      outcome === 'decline' ? { type: 'card_present', card_present: { number: TEST_DECLINE_CARD } } : {},
    );
  } catch (err) {
    const { code, message } = readerErrorMessage(err);
    await markFailed(id, code, message);
  }
  // The webhook normally lands within a second; checking here means the modal is
  // right even if the test webhook endpoint is not set up.
  return (await checkSession(id))!;
}

/**
 * The Stripe client a PaymentIntent belongs to. Everything is live except a card-reader
 * session started in test mode, so the existing capture / release / refund paths can act
 * on a test pre-auth or payment without knowing about test mode. Falls back to live.
 */
export async function stripeClientForPaymentIntent(piId: string | null | undefined): Promise<ReturnType<typeof getStripeClientFor>> {
  if (piId) {
    try {
      const r = await query(`SELECT livemode FROM terminal_sessions WHERE payment_intent_id = $1`, [piId]);
      if (r.rows[0] && r.rows[0].livemode === false) return getStripeClientFor(false);
    } catch { /* table missing on a fresh DB — live */ }
  }
  return getStripeClientFor(true);
}

// ── Receipt ───────────────────────────────────────────────────────────────

/** How long a recorded payment waits for "Send receipt?" before OP sends it itself. */
const RECEIPT_WAIT_MINUTES = 15;

export interface ReceiptRecipient { email: string; name?: string | null }

/**
 * Answer "Send receipt?" for a recorded reader payment.
 *  - `recipients` given → the usual payment email to them (first is To, the rest CC).
 *  - `recipients` null → the usual recipient (the job's address-book resolution).
 *  - `skip` → no email; refused when the payment confirmed the booking, because that
 *    email is the booking confirmation, not just a receipt.
 * Claimed pending → sending in one statement, so the panel and the sweep can't both send.
 * A failed send from the panel goes back to pending so staff can try again.
 */
export async function sendTerminalReceipt(
  id: string,
  opts: { recipients?: ReceiptRecipient[] | null; skip?: boolean; auto?: boolean },
): Promise<TerminalSession> {
  const session = await getSession(id);
  if (!session) throw new TerminalError('Payment not found', 404);
  if (session.status !== 'succeeded' || !session.job_id) throw new TerminalError('This payment has not been recorded.');
  if (session.receipt_status !== 'pending') return session;
  if (opts.skip && session.confirmed_booking) {
    throw new TerminalError('This payment confirmed the booking, so the client must get the confirmation email.');
  }

  const claim = await query(
    `UPDATE terminal_sessions SET receipt_status = 'sending', updated_at = NOW()
      WHERE id = $1 AND receipt_status = 'pending' RETURNING id`,
    [id],
  );
  if (claim.rows.length === 0) return (await getSession(id))!;

  if (opts.skip) {
    await query(
      `UPDATE terminal_sessions SET receipt_status = 'skipped', receipt_at = NOW(), updated_at = NOW() WHERE id = $1`,
      [id],
    );
    return (await getSession(id))!;
  }

  const recipients = (opts.recipients || []).map((r) => ({ email: r.email.trim(), name: r.name || null })).filter((r) => r.email);
  let sent: { sent: boolean; reason?: string; error?: string; toEmail?: string; ccEmails?: string[] };
  try {
    sent = session.excess_id && (session.payment_type === 'excess' || session.payment_type === 'excess_preauth')
      // The excess emails OP already sends for these (portal pre-auth / excess payment).
      ? await sendExcessEmail({
          templateId: session.payment_type === 'excess_preauth' ? 'excess_preauth_confirmed' : 'excess_payment_confirmed',
          excessId: session.excess_id,
          jobId: session.job_id,
          amount: Number(session.amount),
          paymentMethod: 'stripe_gbp',
          ...(recipients.length > 0 ? { overrideRecipients: recipients } : {}),
        })
      : await sendPaymentEmail({
          jobId: session.job_id,
          amount: Number(session.amount),
          bankName: 'card',
          paymentType: session.payment_type,
          isConfirmingBooking: session.confirmed_booking,
          ...(recipients.length > 0 ? { overrideRecipients: recipients } : {}),
        });
  } catch (err) {
    sent = { sent: false, reason: 'error', error: err instanceof Error ? err.message : String(err) };
  }

  if (sent.sent) {
    const to = [sent.toEmail, ...(sent.ccEmails || [])].filter(Boolean).join(', ');
    await query(
      `UPDATE terminal_sessions SET receipt_status = $2, receipt_sent_to = $3, receipt_at = NOW(), updated_at = NOW() WHERE id = $1`,
      [id, opts.auto ? 'auto_sent' : 'sent', to || null],
    );
    return (await getSession(id))!;
  }

  const reason = sent.reason === 'no_recipient' ? 'No email address found for this job.' : (sent.error || 'The email could not be sent.');
  if (opts.auto) {
    await query(`UPDATE terminal_sessions SET receipt_status = 'failed', updated_at = NOW() WHERE id = $1`, [id]);
    await emailService.sendRaw({
      to: ALERT_EMAIL,
      subject: `Card reader receipt NOT sent - £${Number(session.amount).toFixed(2)}`,
      html: `<p>A card reader payment of £${Number(session.amount).toFixed(2)} was recorded, but nobody answered "Send receipt?" and the automatic email failed.</p>
<p>Reason: ${reason}</p><p>Send the client their ${session.confirmed_booking ? 'booking confirmation' : 'payment receipt'} from the job's Money tab (Resend confirmation).</p>`,
      variant: 'internal',
    }).catch((e) => console.error('[terminal] receipt alert email failed:', e));
    return (await getSession(id))!;
  }
  await query(`UPDATE terminal_sessions SET receipt_status = 'pending', updated_at = NOW() WHERE id = $1`, [id]);
  throw new TerminalError(`Not sent - ${reason}`);
}

/**
 * Who "Send receipt?" pre-ticks: whoever the email would go to by itself
 * (`resolveClientEmailTarget`, the one recipient rule), plus anyone staff sent a
 * reader receipt to on this job earlier today. The usual list is empty when it would
 * only be the info@ safety net, so staff pick or type an address instead.
 *
 * Earlier today only (jon, 21 Oct 2026): the address typed for the hire payment is
 * ticked again for the excess a minute later, but a payer at the desk is not a job
 * contact, so a receipt weeks later doesn't go to them unasked. Only receipts a person
 * sent (`sent`), never the sweep's `auto_sent` to the usual recipient.
 */
export async function defaultReceiptRecipients(id: string): Promise<string[]> {
  const session = await getSession(id);
  if (!session?.job_id) return [];
  const usual = await usualReceiptRecipients(session);
  const earlier = await query(
    `SELECT receipt_sent_to FROM terminal_sessions
      WHERE job_id = $1 AND id <> $2 AND receipt_status = 'sent' AND receipt_sent_to IS NOT NULL
        AND (receipt_at AT TIME ZONE 'Europe/London')::date = (NOW() AT TIME ZONE 'Europe/London')::date
      ORDER BY receipt_at`,
    [session.job_id, session.id],
  );
  const out: string[] = [];
  const seen = new Set<string>();
  for (const e of [...usual, ...earlier.rows.flatMap((r) => String(r.receipt_sent_to).split(','))]) {
    const email = e.trim();
    if (email && !seen.has(email.toLowerCase())) {
      seen.add(email.toLowerCase());
      out.push(email);
    }
  }
  return out;
}

/** Whoever this payment's email would go to by itself. */
async function usualReceiptRecipients(session: TerminalSession): Promise<string[]> {
  if (!session.job_id) return [];
  if (session.excess_id && (session.payment_type === 'excess' || session.payment_type === 'excess_preauth')) {
    // Excess emails go to the driver with the job's contacts copied — the same rule
    // sendExcessEmail sends by.
    const d = await query(
      `SELECT vha.driver_id FROM job_excess je LEFT JOIN vehicle_hire_assignments vha ON vha.id = je.assignment_id WHERE je.id = $1`,
      [session.excess_id],
    );
    const t = await resolveExcessEmailTarget(
      d.rows[0]?.driver_id || null,
      session.job_id,
      session.payment_type === 'excess_preauth' ? 'excess_preauth_confirmed' : 'excess_payment_confirmed',
    );
    if (t.isFallback) return [];
    return [t.recipientEmail, ...t.ccList].filter(Boolean);
  }
  const target = await resolveClientEmailTarget(
    session.job_id,
    session.confirmed_booking ? 'booking_confirmed_deposit' : 'payment_received',
  );
  if (target.isFallback) return [];
  return [target.primaryEmail, ...target.ccEmails].filter(Boolean);
}

/**
 * The safety net (scheduler, every 5 minutes): a recorded payment nobody answered
 * "Send receipt?" for within RECEIPT_WAIT_MINUTES gets the usual email anyway, so no
 * payment — and no booking confirmation — goes without one.
 */
export async function sweepTerminalReceipts(): Promise<number> {
  const r = await query(
    `SELECT id FROM terminal_sessions
      WHERE status = 'succeeded' AND receipt_status = 'pending'
        AND finished_at < NOW() - make_interval(mins => $1)
      ORDER BY finished_at LIMIT 20`,
    [RECEIPT_WAIT_MINUTES],
  );
  let sent = 0;
  for (const row of r.rows) {
    try {
      const s = await sendTerminalReceipt(row.id, { recipients: null, auto: true });
      if (s.receipt_status === 'auto_sent') sent += 1;
    } catch (err) {
      console.error(`[terminal] receipt sweep failed for ${row.id}:`, err instanceof Error ? err.message : err);
    }
  }
  if (sent > 0) console.log(`[terminal] Receipt sweep sent ${sent} unanswered receipt(s)`);
  return sent;
}

// ── Webhook ───────────────────────────────────────────────────────────────

const TERMINAL_EVENT_TYPES = new Set([
  'terminal.reader.action_succeeded',
  'terminal.reader.action_failed',
  'payment_intent.succeeded',
  'payment_intent.payment_failed',
  // A pre-auth (manual capture) never "succeeds" at the reader — it becomes capturable.
  'payment_intent.amount_capturable_updated',
]);

export function isTerminalEventType(type: string): boolean {
  return TERMINAL_EVENT_TYPES.has(type);
}

/**
 * Handle a webhook event for a reader payment.
 * @returns true if it was one of ours (the receiver keeps its receipt row), false if not.
 */
export async function handleTerminalWebhookEvent(event: { type: string; livemode?: boolean; data: { object: unknown } }): Promise<boolean> {
  let piId: string | null = null;
  let piFromEvent: PaymentIntentLike | null = null;
  let readerAction: ReaderAction = null;

  if (event.type.startsWith('terminal.reader.')) {
    const reader = event.data.object as ReaderLike;
    readerAction = reader.action || null;
    const p = readerAction?.process_payment_intent?.payment_intent;
    piId = typeof p === 'string' ? p : p?.id || null;
  } else {
    piFromEvent = event.data.object as PaymentIntentLike;
    if (piFromEvent.metadata?.source !== PI_SOURCE) return false;
    piId = piFromEvent.id;
  }
  if (!piId) return false;

  const session = await getSessionByPi(piId);
  if (!session) return false;

  if (event.type === 'terminal.reader.action_failed') {
    await markFailed(session.id, readerAction?.failure_code || 'reader_failed', readerAction?.failure_message || 'The reader could not take the card.');
    return true;
  }

  // Re-read the PaymentIntent rather than trusting the reader event's snapshot —
  // a reader success says the action finished, the PaymentIntent says the money moved.
  const pi = piFromEvent && event.type === 'payment_intent.succeeded'
    ? piFromEvent
    : (await getStripeClientFor(session.livemode).paymentIntents.retrieve(piId)) as PaymentIntentLike;
  await applyPaymentIntent(session, pi, event.type === 'payment_intent.payment_failed');
  return true;
}
