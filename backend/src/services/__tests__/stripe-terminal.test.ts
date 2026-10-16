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
import { handleTerminalWebhookEvent, checkSession, canUseTerminal } from '../stripe-terminal';

const mockQuery = query as jest.Mock;
const mockRecord = recordPayment as jest.Mock;
const mockEmail = (emailService as unknown as { sendRaw: jest.Mock }).sendRaw;

// ── A tiny terminal_sessions + system_settings ─────────────────────────────

type Row = Record<string, unknown>;
let sessions: Row[];
let settings: Record<string, string>;

function fakeQuery(sql: string, params: unknown[] = []) {
  const s = sql.replace(/\s+/g, ' ');
  if (s.includes('FROM system_settings')) {
    const v = settings[params[0] as string];
    return { rows: v === undefined ? [] : [{ value: v }] };
  }
  if (s.startsWith('SELECT * FROM terminal_sessions WHERE payment_intent_id')) {
    return { rows: sessions.filter((r) => r.payment_intent_id === params[0]).map((r) => ({ ...r })) };
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
    const set = s.match(/SET status = '(\w+)'/);
    if (set) row.status = set[1];
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
