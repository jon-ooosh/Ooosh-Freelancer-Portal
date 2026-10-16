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
import { sendPaymentEmail, resolveClientEmailTarget } from './money-emails';

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
  metadata?: Record<string, string> | null;
  last_payment_error?: { code?: string | null; decline_code?: string | null; message?: string | null } | null;
};

export type TerminalMode = 'test' | 'live';
export type TerminalPaymentType = 'deposit' | 'balance';

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
}

/** Create the PaymentIntent, record the pending session, send it to the reader. */
export async function startTerminalPayment(input: StartPaymentInput): Promise<TerminalSession> {
  const { jobId, amount, paymentType, readerId, notes, userId } = input;
  const mode = await getTerminalMode();
  const livemode = mode === 'live';
  if (!isModeConfigured(mode)) throw new TerminalError('The Stripe key for the card reader is not set on the server.', 503);

  const jobRes = await query(`SELECT id, hh_job_number, job_name FROM jobs WHERE id = $1`, [jobId]);
  const job = jobRes.rows[0];
  if (!job) throw new TerminalError('Job not found', 404);

  const pence = Math.round(amount * 100);
  if (pence < 100) throw new TerminalError('A card payment must be at least £1.00.');

  const stripe = getStripeClientFor(livemode);
  let reader: ReaderLike;
  try {
    reader = (await stripe.terminal.readers.retrieve(readerId)) as ReaderLike;
  } catch {
    throw new TerminalError('That reader was not found. Refresh the reader list.');
  }
  if (reader.deleted) throw new TerminalError('That reader has been removed from Stripe.');

  const pi = await stripe.paymentIntents.create({
    amount: pence,
    currency: 'gbp',
    payment_method_types: ['card_present'],
    capture_method: 'automatic',
    description: `Job ${job.hh_job_number ?? ''} ${paymentType} (card reader)`.replace(/\s+/g, ' '),
    metadata: {
      source: PI_SOURCE,
      jobId: job.id,
      hhJobNumber: job.hh_job_number ? String(job.hh_job_number) : '',
      paymentType,
      op_user_id: userId,
    },
  });

  const ins = await query(
    `INSERT INTO terminal_sessions
       (job_id, livemode, reader_id, reader_label, payment_intent_id, payment_type, amount, notes, started_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     RETURNING *`,
    [job.id, livemode, reader.id, reader.label || null, pi.id, paymentType, pence / 100, notes || null, userId],
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

  if (!s.job_id) {
    await query(
      `UPDATE terminal_sessions SET status = 'record_failed', failure_message = $2, finished_at = NOW(), updated_at = NOW() WHERE id = $1`,
      [s.id, 'The job this payment was for no longer exists.'],
    );
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
      payment_type: s.payment_type,
      amount,
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
<p>Stripe PaymentIntent: ${pi.id}. The money has been taken - record it by hand on the job's Money tab (method Stripe GBP, reference ${pi.id}).</p>`,
    variant: 'internal',
  }).catch((e) => console.error('[terminal] alert email failed:', e));
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
  if (pi.status === 'succeeded') {
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
  let sent: Awaited<ReturnType<typeof sendPaymentEmail>>;
  try {
    sent = await sendPaymentEmail({
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
 * (`resolveClientEmailTarget`, the one recipient rule). Empty when that would only be
 * the info@ safety net, so staff pick or type an address instead.
 */
export async function defaultReceiptRecipients(id: string): Promise<string[]> {
  const session = await getSession(id);
  if (!session?.job_id) return [];
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
