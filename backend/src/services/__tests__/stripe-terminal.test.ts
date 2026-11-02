/**
 * Card-reader payments (STRIPE-TERMINAL-SPEC.md) against a fake terminal_sessions
 * table and a fake Stripe.
 *
 * What matters most: one approved card is recorded ONCE however many ways the news
 * arrives (reader webhook, PaymentIntent webhook, the modal's poll), a portal
 * PaymentIntent is never touched, a stale decline on a re-sent payment does not fail
 * it, and the reader stays admin-only unless the setting says otherwise.
 */
export {};

jest.mock('../../config/database', () => ({ query: jest.fn() }));
jest.mock('../record-payment', () => ({
  recordPayment: jest.fn(),
  SYSTEM_SERVICE_USER_ID: '00000000-0000-0000-0000-000000000000',
}));
jest.mock('../email-service', () => ({ emailService: { sendRaw: jest.fn().mockResolvedValue({}) } }));
jest.mock('../money-emails', () => ({
  sendPaymentEmail: jest.fn(), sendExcessEmail: jest.fn(),
  resolveClientEmailTarget: jest.fn(), resolveExcessEmailTarget: jest.fn(),
}));
jest.mock('../shop-sales', () => ({ createShopSale: jest.fn(), validateShopSale: jest.fn() }));
jest.mock('../excess-preauth', () => ({
  ...jest.requireActual('../excess-preauth'),
  recordPreauthHold: jest.fn(),
}));

const fakeStripe = {
  paymentIntents: { retrieve: jest.fn(), cancel: jest.fn(), create: jest.fn() },
  terminal: { readers: { retrieve: jest.fn(), cancelAction: jest.fn(), processPaymentIntent: jest.fn() } },
};
jest.mock('../../config/stripe', () => ({
  getStripeClientFor: () => fakeStripe,
  isStripeError: () => false,
}));

import { query } from '../../config/database';
import { recordPayment } from '../record-payment';
import { emailService } from '../email-service';
import { sendPaymentEmail, sendExcessEmail, resolveClientEmailTarget } from '../money-emails';
import { recordPreauthHold, preauthEligibility } from '../excess-preauth';
import { createShopSale } from '../shop-sales';
import { handleTerminalWebhookEvent, checkSession, canUseTerminal, sendTerminalReceipt, sweepTerminalReceipts, defaultReceiptRecipients } from '../stripe-terminal';

const mockQuery = query as jest.Mock;
const mockRecord = recordPayment as jest.Mock;
const mockEmail = (emailService as unknown as { sendRaw: jest.Mock }).sendRaw;
const mockPaymentEmail = sendPaymentEmail as jest.Mock;
const mockExcessEmail = sendExcessEmail as jest.Mock;
const mockClientTarget = resolveClientEmailTarget as jest.Mock;
const mockRecordPreauth = recordPreauthHold as jest.Mock;
const mockCreateShopSale = createShopSale as jest.Mock;

// ── A tiny terminal_sessions + system_settings ─────────────────────────────

type Row = Record<string, unknown>;
let sessions: Row[];
let settings: Record<string, string>;

function fakeQuery(sql: string, params: unknown[] = []) {
  const s = sql.replace(/\s+/g, ' ');
  if (s.startsWith('SELECT job_date, out_date, job_end, return_date FROM jobs')) {
    return { rows: [{ job_date: '2026-10-20T09:00:00Z', job_end: '2026-10-23T09:00:00Z' }] };
  }
  if (s.includes('FROM system_settings')) {
    const v = settings[params[0] as string];
    return { rows: v === undefined ? [] : [{ value: v }] };
  }
  if (s.startsWith('SELECT * FROM terminal_sessions WHERE payment_intent_id')) {
    return { rows: sessions.filter((r) => r.payment_intent_id === params[0]).map((r) => ({ ...r })) };
  }
  if (s.startsWith('SELECT id FROM terminal_sessions WHERE status')) {
    return { rows: sessions.filter((r) => r.status === 'succeeded' && r.receipt_status === 'pending' && r.overdue).map((r) => ({ id: r.id })) };
  }
  if (s.startsWith('SELECT receipt_sent_to FROM terminal_sessions')) {
    // Same job, not this session, sent by a person, earlier today (`receipt_today`).
    return {
      rows: sessions
        .filter((r) => r.job_id === params[0] && r.id !== params[1] && r.receipt_status === 'sent' && r.receipt_sent_to && r.receipt_today)
        .map((r) => ({ receipt_sent_to: r.receipt_sent_to })),
    };
  }
  if (s.startsWith('SELECT * FROM terminal_sessions WHERE id')) {
    return { rows: sessions.filter((r) => r.id === params[0]).map((r) => ({ ...r })) };
  }
  if (s.startsWith('UPDATE terminal_sessions')) {
    const row = sessions.find((r) => r.id === params[0]);
    if (!row) return { rows: [] };
    // The WHERE status guard is the whole point — honour it.
    const guard = s.match(/status IN \(([^)]+)\)/) || s.match(/AND status = '(\w+)'/);
    if (guard) {
      const allowed = guard[1]!.split(',').map((x) => x.trim().replace(/'/g, ''));
      if (!allowed.includes(row.status as string)) return { rows: [] };
    }
    const receiptGuard = s.match(/AND receipt_status = '(\w+)'/);
    if (receiptGuard && row.receipt_status !== receiptGuard[1]) return { rows: [] };
    const set = s.match(/SET status = '(\w+)'/);
    if (set) row.status = set[1];
    if (s.includes('confirmed_booking = $4')) { row.confirmed_booking = params[3]; row.receipt_status = 'pending'; }
    const rset = s.match(/receipt_status = '(\w+)'/);
    if (rset && !s.includes('AND receipt_status')) row.receipt_status = rset[1];
    else if (s.match(/SET receipt_status = '(\w+)'/)) row.receipt_status = s.match(/SET receipt_status = '(\w+)'/)![1];
    if (s.includes('receipt_status = $2')) { row.receipt_status = params[1]; row.receipt_sent_to = params[2]; }
    if (s.includes('capture_before = $2')) { row.capture_before = params[1]; row.warning = params[2]; row.receipt_status = 'pending'; }
    if (s.includes('shop_sale_id = $2')) { row.shop_sale_id = params[1]; row.warning = params[2]; }
    if (s.includes('failure_code = $2')) { row.failure_code = params[1]; row.failure_message = params[2]; }
    if (s.includes('job_payment_id = $2')) row.job_payment_id = params[1];
    if (s.includes("status = 'record_failed', failure_message = $2")) row.failure_message = params[1];
    return { rows: [{ ...row }] };
  }
  throw new Error(`unexpected SQL: ${s}`);
}

function session(over: Row = {}): Row {
  return {
    id: 'sess-1', job_id: 'job-1', livemode: false, reader_id: 'tmr_1', reader_label: 'Simulated S700',
    payment_intent_id: 'pi_1', payment_type: 'deposit', amount: '50.00', notes: null,
    status: 'pending', failure_code: null, failure_message: null, started_by: 'user-1', ...over,
  };
}

const succeededPi = { id: 'pi_1', status: 'succeeded', amount: 5000, amount_received: 5000, metadata: { source: 'op_terminal' } };

beforeEach(() => {
  jest.clearAllMocks();
  sessions = [session()];
  settings = { stripe_terminal_roles: 'admin' };
  mockQuery.mockImplementation(async (sql: string, params: unknown[]) => fakeQuery(sql, params));
  mockRecord.mockResolvedValue({ status: 200, body: { data: { id: 'pay-1' }, hh_push_error: null } });
  fakeStripe.paymentIntents.retrieve.mockResolvedValue(succeededPi);
});

describe('recording an approved card', () => {
  it('records once when the reader event, the PaymentIntent event and a poll all arrive', async () => {
    const readerEvent = {
      type: 'terminal.reader.action_succeeded', livemode: false,
      data: { object: { id: 'tmr_1', action: { status: 'succeeded', process_payment_intent: { payment_intent: 'pi_1' } } } },
    };
    const piEvent = { type: 'payment_intent.succeeded', livemode: false, data: { object: succeededPi } };

    expect(await handleTerminalWebhookEvent(readerEvent)).toBe(true);
    expect(await handleTerminalWebhookEvent(piEvent)).toBe(true);
    expect(await handleTerminalWebhookEvent(readerEvent)).toBe(true); // Stripe re-delivery
    await checkSession('sess-1');

    expect(mockRecord).toHaveBeenCalledTimes(1);
    const [jobId, input, actor] = mockRecord.mock.calls[0];
    expect(jobId).toBe('job-1');
    expect(input).toMatchObject({
      payment_type: 'deposit', amount: 50, payment_method: 'stripe_gbp',
      stripe_payment_intent: 'pi_1', payment_reference: 'pi_1', source: 'stripe_terminal', push_to_hirehop: true,
    });
    expect(input.notes).toContain('TEST MODE');
    expect(actor).toEqual({ userId: 'user-1', isServiceAccount: false });
    expect(sessions[0]!.status).toBe('succeeded');
    expect(sessions[0]!.job_payment_id).toBe('pay-1');
  });

  it('marks the session record_failed and emails info@ when recording fails', async () => {
    mockRecord.mockResolvedValue({ status: 500, body: { error: 'Failed to record payment' } });
    await handleTerminalWebhookEvent({ type: 'payment_intent.succeeded', livemode: false, data: { object: succeededPi } });
    expect(sessions[0]!.status).toBe('record_failed');
    expect(mockEmail).toHaveBeenCalledTimes(1);
    // A later event must not try again (a retry could double-record).
    await handleTerminalWebhookEvent({ type: 'payment_intent.succeeded', livemode: false, data: { object: succeededPi } });
    expect(mockRecord).toHaveBeenCalledTimes(1);
  });
});

describe('events that are not ours', () => {
  it('ignores a portal PaymentIntent without touching the database', async () => {
    const portalPi = { id: 'pi_portal', status: 'succeeded', amount: 100, metadata: { jobId: '123' } };
    expect(await handleTerminalWebhookEvent({ type: 'payment_intent.succeeded', livemode: true, data: { object: portalPi } })).toBe(false);
    expect(mockQuery).not.toHaveBeenCalled();
    expect(mockRecord).not.toHaveBeenCalled();
  });

  it('ignores a reader event for a PaymentIntent OP did not start', async () => {
    sessions = [];
    const ev = {
      type: 'terminal.reader.action_succeeded', livemode: true,
      data: { object: { id: 'tmr_1', action: { process_payment_intent: { payment_intent: 'pi_other' } } } },
    };
    expect(await handleTerminalWebhookEvent(ev)).toBe(false);
    expect(mockRecord).not.toHaveBeenCalled();
  });
});

describe('declines', () => {
  it('a reader failure marks the session failed', async () => {
    await handleTerminalWebhookEvent({
      type: 'terminal.reader.action_failed', livemode: false,
      data: { object: { id: 'tmr_1', action: { status: 'failed', failure_code: 'card_declined', failure_message: 'Declined', process_payment_intent: { payment_intent: 'pi_1' } } } },
    });
    expect(sessions[0]).toMatchObject({ status: 'failed', failure_code: 'card_declined' });
  });

  it('a poll after Try again does not fail the payment on the PaymentIntent\'s old decline', async () => {
    fakeStripe.paymentIntents.retrieve.mockResolvedValue({
      id: 'pi_1', status: 'requires_payment_method', amount: 5000,
      last_payment_error: { code: 'card_declined', message: 'Your card was declined.' },
    });
    fakeStripe.terminal.readers.retrieve.mockResolvedValue({
      id: 'tmr_1', action: { status: 'in_progress', process_payment_intent: { payment_intent: 'pi_1' } },
    });
    await checkSession('sess-1');
    expect(sessions[0]!.status).toBe('pending');
  });
});

describe('who may use the reader', () => {
  it('is admin only by default', async () => {
    expect(await canUseTerminal('admin')).toBe(true);
    expect(await canUseTerminal('manager')).toBe(false);
    expect(await canUseTerminal('staff')).toBe(false);
    expect(await canUseTerminal(undefined)).toBe(false);
  });

  it('falls back to admin only when the setting is missing', async () => {
    settings = {};
    expect(await canUseTerminal('admin')).toBe(true);
    expect(await canUseTerminal('staff')).toBe(false);
  });

  it('follows the setting once widened, weekend_manager with manager', async () => {
    settings = { stripe_terminal_roles: 'admin, manager, staff' };
    expect(await canUseTerminal('staff')).toBe(true);
    expect(await canUseTerminal('weekend_manager')).toBe(true);
    expect(await canUseTerminal('general_assistant')).toBe(false);
  });
});

describe('Send receipt?', () => {
  beforeEach(() => {
    mockPaymentEmail.mockResolvedValue({ sent: true, toEmail: 'a@client.test', ccEmails: ['b@client.test'] });
  });

  it('holds the client email back when recording, and says whether it confirmed the booking', async () => {
    mockRecord.mockResolvedValue({ status: 200, body: { data: { id: 'pay-1', booking_confirmed: true }, hh_push_error: null } });
    await handleTerminalWebhookEvent({ type: 'payment_intent.succeeded', livemode: false, data: { object: succeededPi } });
    expect(mockRecord.mock.calls[0][1].skip_client_email).toBe(true);
    expect(sessions[0]).toMatchObject({ status: 'succeeded', confirmed_booking: true, receipt_status: 'pending' });
    expect(mockPaymentEmail).not.toHaveBeenCalled();
  });

  it('sends to the picked people, once', async () => {
    sessions = [session({ status: 'succeeded', receipt_status: 'pending', confirmed_booking: false })];
    const picked = [{ email: 'a@client.test', name: 'Ann' }, { email: 'b@client.test' }];
    await sendTerminalReceipt('sess-1', { recipients: picked });
    await sendTerminalReceipt('sess-1', { recipients: picked });
    expect(mockPaymentEmail).toHaveBeenCalledTimes(1);
    expect(mockPaymentEmail.mock.calls[0][0]).toMatchObject({ jobId: 'job-1', amount: 50, isConfirmingBooking: false, bankName: 'card' });
    expect(mockPaymentEmail.mock.calls[0][0].overrideRecipients).toHaveLength(2);
    expect(sessions[0]).toMatchObject({ receipt_status: 'sent', receipt_sent_to: 'a@client.test, b@client.test' });
  });

  it('refuses No receipt when the payment confirmed the booking', async () => {
    sessions = [session({ status: 'succeeded', receipt_status: 'pending', confirmed_booking: true })];
    await expect(sendTerminalReceipt('sess-1', { skip: true })).rejects.toThrow(/confirmed the booking/);
    expect(sessions[0]!.receipt_status).toBe('pending');
  });

  it('records No receipt on an ordinary payment', async () => {
    sessions = [session({ status: 'succeeded', receipt_status: 'pending', confirmed_booking: false })];
    await sendTerminalReceipt('sess-1', { skip: true });
    expect(sessions[0]!.receipt_status).toBe('skipped');
    expect(mockPaymentEmail).not.toHaveBeenCalled();
  });

  it('puts a failed send back to pending so staff can try again', async () => {
    sessions = [session({ status: 'succeeded', receipt_status: 'pending', confirmed_booking: false })];
    mockPaymentEmail.mockResolvedValue({ sent: false, reason: 'error', error: 'SMTP down' });
    await expect(sendTerminalReceipt('sess-1', { recipients: [{ email: 'a@client.test' }] })).rejects.toThrow(/SMTP down/);
    expect(sessions[0]!.receipt_status).toBe('pending');
  });

  it('ticks again anyone a receipt went to on this job earlier today, after the usual people, once each', async () => {
    mockClientTarget.mockResolvedValue({ isFallback: false, primaryEmail: 'a@client.test', ccEmails: [] });
    sessions = [
      session({ id: 'sess-0', payment_intent_id: 'pi_0', status: 'succeeded', receipt_status: 'sent',
        receipt_sent_to: 'payer@desk.test, A@client.test', receipt_today: true }),
      session({ id: 'sess-other-job', job_id: 'job-2', payment_intent_id: 'pi_2', status: 'succeeded', receipt_status: 'sent',
        receipt_sent_to: 'someone@else.test', receipt_today: true }),
      session({ id: 'sess-last-week', payment_intent_id: 'pi_3', status: 'succeeded', receipt_status: 'sent',
        receipt_sent_to: 'old@payer.test', receipt_today: false }),
      session({ status: 'succeeded', receipt_status: 'pending', confirmed_booking: false }),
    ];
    expect(await defaultReceiptRecipients('sess-1')).toEqual(['a@client.test', 'payer@desk.test']);
  });

  it('with no usual recipient, ticks today\'s earlier ones alone', async () => {
    mockClientTarget.mockResolvedValue({ isFallback: true, primaryEmail: 'info@oooshtours.co.uk', ccEmails: [] });
    sessions = [
      session({ id: 'sess-0', payment_intent_id: 'pi_0', status: 'succeeded', receipt_status: 'sent',
        receipt_sent_to: 'payer@desk.test', receipt_today: true }),
      session({ status: 'succeeded', receipt_status: 'pending', confirmed_booking: false }),
    ];
    expect(await defaultReceiptRecipients('sess-1')).toEqual(['payer@desk.test']);
  });

  it('the sweep sends an unanswered receipt to the usual recipient', async () => {
    sessions = [session({ status: 'succeeded', receipt_status: 'pending', confirmed_booking: true, overdue: true })];
    expect(await sweepTerminalReceipts()).toBe(1);
    expect(mockPaymentEmail.mock.calls[0][0].overrideRecipients).toBeUndefined();
    expect(mockPaymentEmail.mock.calls[0][0].isConfirmingBooking).toBe(true);
    expect(sessions[0]!.receipt_status).toBe('auto_sent');
  });
});

describe('the pre-auth rule (copied from the payment portal)', () => {
  const now = new Date('2026-10-18T12:00:00Z');
  it('allows a 4-day hire ending within 5 days', () => {
    expect(preauthEligibility('2026-10-19T09:00:00Z', '2026-10-23T09:00:00Z', now)).toMatchObject({ allowed: true, hireDays: 4 });
  });
  it('refuses a 5-day hire: take a payment', () => {
    expect(preauthEligibility('2026-10-19T09:00:00Z', '2026-10-24T09:00:00Z', now)).toMatchObject({ allowed: false, code: 'long_hire', hireDays: 5 });
  });
  it('refuses a short hire that ends more than 5 days away: too early', () => {
    expect(preauthEligibility('2026-10-28T09:00:00Z', '2026-10-30T09:00:00Z', now)).toMatchObject({ allowed: false, code: 'too_early' });
  });
  it('refuses once the hire has ended', () => {
    expect(preauthEligibility('2026-10-10T09:00:00Z', '2026-10-12T09:00:00Z', now)).toMatchObject({ allowed: false, code: 'too_late' });
  });
  it('refuses without dates', () => {
    expect(preauthEligibility(null, null, now)).toMatchObject({ allowed: false, code: 'no_dates' });
  });
});

describe('a pre-auth on the reader', () => {
  const capturable = {
    id: 'pi_1', status: 'requires_capture', amount: 120000, amount_capturable: 120000,
    metadata: { source: 'op_terminal' },
    latest_charge: { id: 'ch_1', payment_method_details: { card_present: { capture_before: Date.parse('2026-11-14T12:00:00Z') / 1000 } } },
  };

  beforeEach(() => {
    sessions = [session({ payment_type: 'excess_preauth', excess_id: 'ex-1', amount: '1200.00' })];
    fakeStripe.paymentIntents.retrieve.mockResolvedValue(capturable);
    mockRecordPreauth.mockResolvedValue({ id: 'ex-1', excess_status: 'pre_auth' });
  });

  it('is recorded on the excess record once it is capturable, with Stripe\'s expiry, and never as a payment', async () => {
    const ev = {
      type: 'terminal.reader.action_succeeded', livemode: false,
      data: { object: { id: 'tmr_1', action: { status: 'succeeded', process_payment_intent: { payment_intent: 'pi_1' } } } },
    };
    await handleTerminalWebhookEvent(ev);
    await handleTerminalWebhookEvent({ type: 'payment_intent.amount_capturable_updated', livemode: false, data: { object: capturable } });
    expect(mockRecord).not.toHaveBeenCalled();
    expect(mockRecordPreauth).toHaveBeenCalledTimes(1);
    expect(mockRecordPreauth.mock.calls[0][0]).toMatchObject({
      excessId: 'ex-1', amount: 1200, method: 'stripe_gbp', stripePaymentIntentId: 'pi_1', source: 'stripe_terminal',
    });
    expect(mockRecordPreauth.mock.calls[0][0].expiresAt.toISOString()).toBe('2026-11-14T12:00:00.000Z');
    expect(sessions[0]).toMatchObject({ status: 'succeeded', receipt_status: 'pending', warning: null });
  });

  it('warns when the pre-auth would expire before the hire ends', async () => {
    fakeStripe.paymentIntents.retrieve.mockResolvedValue({
      ...capturable,
      latest_charge: { id: 'ch_1', payment_method_details: { card_present: { capture_before: Date.parse('2026-10-21T12:00:00Z') / 1000 } } },
    });
    await handleTerminalWebhookEvent({ type: 'payment_intent.amount_capturable_updated', livemode: false, data: { object: capturable } });
    expect(sessions[0]!.warning).toMatch(/expires .* before the hire ends/);
  });

  it('a pre-auth the record refuses is record_failed, and info@ is told the amount is still held', async () => {
    const { PreauthRecordError } = jest.requireActual('../excess-preauth');
    mockRecordPreauth.mockRejectedValue(new PreauthRecordError('Cannot record a pre-auth on this record'));
    await handleTerminalWebhookEvent({ type: 'payment_intent.amount_capturable_updated', livemode: false, data: { object: capturable } });
    expect(sessions[0]!.status).toBe('record_failed');
    expect(mockEmail.mock.calls[0][0].html).toMatch(/held on the client's card/);
  });

  it('its receipt is the excess pre-auth email', async () => {
    sessions = [session({ payment_type: 'excess_preauth', excess_id: 'ex-1', status: 'succeeded', receipt_status: 'pending', amount: '1200.00' })];
    mockExcessEmail.mockResolvedValue({ sent: true, toEmail: 'driver@client.test', ccEmails: [] });
    await sendTerminalReceipt('sess-1', { recipients: [{ email: 'driver@client.test' }] });
    expect(mockPaymentEmail).not.toHaveBeenCalled();
    expect(mockExcessEmail.mock.calls[0][0]).toMatchObject({ templateId: 'excess_preauth_confirmed', excessId: 'ex-1', amount: 1200 });
  });
});

describe('an excess payment on the reader', () => {
  it('goes through recordPayment as excess on its record', async () => {
    sessions = [session({ payment_type: 'excess', excess_id: 'ex-1' })];
    await handleTerminalWebhookEvent({ type: 'payment_intent.succeeded', livemode: false, data: { object: succeededPi } });
    expect(mockRecord.mock.calls[0][1]).toMatchObject({ payment_type: 'excess', excess_id: 'ex-1', stripe_payment_intent: 'pi_1', skip_client_email: true });
  });
});

describe('a till sale on the reader', () => {
  const payload = {
    input: { kind: 'sale', lines: [{ hhStockId: 25, qty: 2, unitPriceCharged: 7.5 }], soldToJobId: null, recordedIn: 'staff_till', tender: 'card_reader' },
    actor: { id: 'user-1', role: 'admin' },
  };
  const paid = { id: 'pi_1', status: 'succeeded', amount: 1800, amount_received: 1800, metadata: { source: 'op_terminal' } };

  beforeEach(() => {
    sessions = [session({ payment_type: 'shop', job_id: null, amount: '18.00', shop_payload: payload })];
  });

  it('creates the sale only once the card is approved, as card_reader with its PaymentIntent, and never as a job payment', async () => {
    mockCreateShopSale.mockResolvedValue({ id: 'sale-1', kind: 'sale', totals: { gross: 18 }, pushAfter: '' });
    await handleTerminalWebhookEvent({ type: 'payment_intent.succeeded', livemode: false, data: { object: paid } });
    await handleTerminalWebhookEvent({ type: 'payment_intent.succeeded', livemode: false, data: { object: paid } });
    expect(mockRecord).not.toHaveBeenCalled();
    expect(mockCreateShopSale).toHaveBeenCalledTimes(1);
    expect(mockCreateShopSale.mock.calls[0][0]).toMatchObject({ tender: 'card_reader', stripePaymentIntent: 'pi_1', kind: 'sale' });
    expect(mockCreateShopSale.mock.calls[0][1]).toEqual({ id: 'user-1', role: 'admin' });
    expect(sessions[0]).toMatchObject({ status: 'succeeded', shop_sale_id: 'sale-1', warning: null });
  });

  it('warns when the sale comes to a different total than the card was charged', async () => {
    mockCreateShopSale.mockResolvedValue({ id: 'sale-1', kind: 'sale', totals: { gross: 17.5 }, pushAfter: '' });
    await handleTerminalWebhookEvent({ type: 'payment_intent.succeeded', livemode: false, data: { object: paid } });
    expect(sessions[0]!.warning).toMatch(/charged £18.00 but the sale came to £17.50/);
  });

  it('a sale that will not record is record_failed, and info@ is told the money was taken', async () => {
    mockCreateShopSale.mockRejectedValue(new Error('That job is closed.'));
    await handleTerminalWebhookEvent({ type: 'payment_intent.succeeded', livemode: false, data: { object: paid } });
    expect(sessions[0]!.status).toBe('record_failed');
    expect(mockEmail.mock.calls[0][0].html).toMatch(/refund it in the Stripe dashboard/);
  });
});
