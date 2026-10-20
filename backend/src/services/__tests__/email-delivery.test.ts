/**
 * Email delivery problems — hearing back from Resend.
 *
 * Worth a test rather than a careful reading:
 *
 * THE SIGNATURE. The webhook is public; only the Svix signature keeps a
 * stranger from flagging every client address as bouncing. Checked against
 * Svix's own published example, so a wrong key decoding or signed-content
 * order fails here rather than in production (where every real event would
 * simply be refused with a 400 and nobody would notice).
 *
 * THE CC CASE. Resend checks each recipient separately — the To can be
 * delivered while a CC is blocked (job 16893). The alert must name the CC,
 * and a delivery to the To must never clear the CC's flag.
 *
 * NO ALERT LOOP. An alert about one of our own addresses must never be
 * emailed to info@, or a blocked info@ would alert about itself forever.
 */
jest.mock('../../config/database', () => ({ query: jest.fn() }));
jest.mock('../email-service', () => ({
  emailService: { sendRaw: jest.fn() },
}));
// middleware/auth demands JWT_SECRET at import time; only its role list is read.
jest.mock('../../middleware/auth', () => ({ MANAGER_ROLES: ['admin', 'manager', 'weekend_manager'] }));

import { query } from '../../config/database';
import { emailService, jobNumberForLog } from '../email-service';
import {
  verifyResendSignature,
  normaliseAddress,
  processResendEvent,
  eventDetail,
  type ResendEmailEvent,
} from '../email-delivery';

const mockQuery = query as jest.MockedFunction<typeof query>;
const mockSendRaw = emailService.sendRaw as jest.MockedFunction<typeof emailService.sendRaw>;

// jobNumberForLog lives in email-service, which is mocked above for the
// webhook tests — pull the real one for its own tests.
const realJobNumberForLog: typeof jobNumberForLog =
  jest.requireActual('../email-service').jobNumberForLog;

describe('verifyResendSignature (Svix)', () => {
  // https://docs.svix.com/receiving/verifying-payloads/how-manual — "Example signatures"
  const example = {
    secret: 'whsec_plJ3nmyCDGBKInavdOK15jsl',
    body: '{"event_type":"ping","data":{"success":true}}',
    id: 'msg_loFOjxBNrRLzqYUf',
    timestamp: '1731705121',
    signatureHeader: 'v1,rAvfW3dJ/X/qxhsaXPOyyCGmRKsaKWcsNccKXlIktD0=',
  };

  it('accepts Svix\'s published example', () => {
    expect(verifyResendSignature({ ...example, nowSeconds: 1731705121 })).toBe(true);
  });

  it('accepts when any one of several signatures matches', () => {
    expect(verifyResendSignature({
      ...example,
      signatureHeader: `v1,bm9ldHUjKzFob2VudXRob2VodWUzMjRvdWVvdW9ldQo= ${example.signatureHeader}`,
      nowSeconds: 1731705121,
    })).toBe(true);
  });

  it('refuses a changed body', () => {
    expect(verifyResendSignature({ ...example, body: example.body.replace('true', 'false'), nowSeconds: 1731705121 })).toBe(false);
  });

  it('refuses the wrong secret', () => {
    expect(verifyResendSignature({ ...example, secret: 'whsec_c29tZXRoaW5nZWxzZQ==', nowSeconds: 1731705121 })).toBe(false);
  });

  it('refuses a timestamp more than 5 minutes off (replay)', () => {
    expect(verifyResendSignature({ ...example, nowSeconds: 1731705121 + 6 * 60 })).toBe(false);
  });

  it('refuses missing headers', () => {
    expect(verifyResendSignature({ ...example, signatureHeader: undefined, nowSeconds: 1731705121 })).toBe(false);
    expect(verifyResendSignature({ ...example, id: undefined, nowSeconds: 1731705121 })).toBe(false);
  });
});

describe('normaliseAddress', () => {
  it('lower-cases, trims and unwraps a display name', () => {
    expect(normaliseAddress(' Megan <Megan@VariousArtistsManagement.com> ')).toBe('megan@variousartistsmanagement.com');
    expect(normaliseAddress('TYLRRYDR@gmail.com')).toBe('tylrrydr@gmail.com');
  });
});

describe('jobNumberForLog', () => {
  it('takes the jobNumber template variable first', () => {
    expect(realJobNumberForLog('16893', 'Insurance Excess Pre-Authorisation - Cassyette')).toBe(16893);
    expect(realJobNumberForLog('#16893', 'x')).toBe(16893);
  });
  it('falls back to a #number in the subject (raw sends)', () => {
    expect(realJobNumberForLog(undefined, 'Payment summary — Cassyette (#16893)')).toBe(16893);
  });
  it('is null when there is no plain job number', () => {
    expect(realJobNumberForLog('J-1234', 'Your Ooosh Tours verification code')).toBeNull();
    expect(realJobNumberForLog(undefined, 'Driver hire form')).toBeNull();
  });
});

describe('eventDetail', () => {
  it('keeps Resend\'s own reason', () => {
    expect(eventDetail('suppressed', {
      suppressed: { message: 'The recipient\'s email address is on the suppression list because it has a recent history of producing hard bounces.' },
    })).toMatch(/recent history of producing hard bounces/);
    expect(eventDetail('bounced', {
      bounce: { type: 'Permanent', subType: 'General', message: 'Address not found', diagnosticCode: ['smtp; 550 5.1.1 does not exist'] },
    })).toBe('Permanent bounce (General) — Address not found — smtp; 550 5.1.1 does not exist');
  });
});

// ── The webhook flow, against a fake database ────────────────────────────

const JOB_ID = '22222222-2222-4222-8222-222222222222';
const LOG_ID = '33333333-3333-4333-8333-333333333333';
const EVENT_ID = '44444444-4444-4444-8444-444444444444';

interface FakeDb {
  loggedTo?: string;           // email_log.recipient (the To)
  jobNumber?: number | null;
  problemOpen?: boolean | null; // null = no row
  recentlyAlerted?: boolean;
  duplicate?: boolean;
  managers?: string[];
}

/** Route each query by its SQL; record every statement for assertions. */
function fakeDb(db: FakeDb) {
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  mockQuery.mockImplementation((async (sql: string, params: unknown[] = []) => {
    calls.push({ sql, params });
    const rows = (r: unknown[]) => ({ rows: r });
    if (/FROM email_log WHERE message_id/.test(sql)) {
      return rows(db.loggedTo ? [{ id: LOG_ID, template_id: 'driver_hire_form', recipient: db.loggedTo, subject: 'Driver hire form for 16893', job_number: db.jobNumber ?? null }] : []);
    }
    if (/FROM jobs WHERE hh_job_number/.test(sql)) {
      return rows(db.jobNumber ? [{ id: JOB_ID, hh_job_number: db.jobNumber, job_name: 'Cassyette' }] : []);
    }
    if (/FROM people/.test(sql) || /FROM organisations/.test(sql)) return rows([]);
    if (/INSERT INTO email_delivery_events/.test(sql)) return rows(db.duplicate ? [] : [{ id: EVENT_ID }]);
    if (/SELECT resolved_at FROM email_address_problems/.test(sql)) {
      return rows(db.problemOpen == null ? [] : [{ resolved_at: db.problemOpen ? null : new Date() }]);
    }
    if (/alerted = true\s+AND job_id IS NOT DISTINCT FROM/.test(sql)) return rows(db.recentlyAlerted ? [{ '?column?': 1 }] : []);
    if (/FROM users/.test(sql)) return rows((db.managers || ['u1', 'u2']).map((id) => ({ id })));
    return rows([]);
  }) as never);
  return calls;
}

const suppressedForCc: ResendEmailEvent = {
  type: 'email.suppressed',
  data: {
    email_id: 're_1',
    created_at: '2026-10-20T10:00:00.000Z',
    to: ['megan@variousartistsmanagement.com'],
    subject: 'Driver hire form for 16893',
    suppressed: { message: 'Recipient is on the suppression list.', type: 'OnAccountSuppressionList' },
  },
};

const has = (calls: Array<{ sql: string }>, re: RegExp) => calls.some((c) => re.test(c.sql));
const count = (calls: Array<{ sql: string }>, re: RegExp) => calls.filter((c) => re.test(c.sql)).length;

beforeEach(() => {
  mockQuery.mockReset();
  mockSendRaw.mockReset();
  mockSendRaw.mockResolvedValue({ success: true });
});

describe('processResendEvent — a failure', () => {
  it('records, flags, notes the job, bells every manager and emails info@ (naming the CC)', async () => {
    const calls = fakeDb({ loggedTo: 'tylrrydr@gmail.com', jobNumber: 16893, problemOpen: null });
    await processResendEvent(suppressedForCc, 'msg_1');

    const ev = calls.find((c) => /INSERT INTO email_delivery_events/.test(c.sql))!;
    expect(ev.params.slice(0, 4)).toEqual(['msg_1', 'suppressed', 're_1', 'megan@variousartistsmanagement.com']);
    expect(ev.params[8]).toBe(JOB_ID);

    expect(has(calls, /INSERT INTO email_address_problems/)).toBe(true);

    const note = calls.find((c) => /INSERT INTO interactions/.test(c.sql))!;
    expect(note.params[0]).toMatch(/NOT delivered to megan@variousartistsmanagement\.com \(CC\)/);
    expect(note.params[1]).toBe(JOB_ID);

    const bells = calls.filter((c) => /INSERT INTO notifications/.test(c.sql));
    expect(bells).toHaveLength(2);
    expect(bells[0].params[5]).toBe(`/jobs/${JOB_ID}`);         // click-through to the job
    expect(bells[0].params[3]).toBe('job');
    expect(bells[0].sql).toMatch(/email_sent_at/);               // info@ is emailed directly

    expect(mockSendRaw).toHaveBeenCalledTimes(1);
    const sent = mockSendRaw.mock.calls[0][0];
    expect(sent.to).toBe('info@oooshtours.co.uk');
    expect(sent.subject).toBe('Email not delivered: megan@variousartistsmanagement.com (job #16893)');
    expect(sent.html).toMatch(/\(on CC\)/);

    expect(has(calls, /UPDATE email_delivery_events SET alerted = true/)).toBe(true);
  });

  it('does nothing more on a retry of the same webhook', async () => {
    const calls = fakeDb({ loggedTo: 'tylrrydr@gmail.com', jobNumber: 16893, duplicate: true });
    await processResendEvent(suppressedForCc, 'msg_1');
    expect(has(calls, /INSERT INTO email_address_problems/)).toBe(false);
    expect(has(calls, /INSERT INTO notifications/)).toBe(false);
    expect(mockSendRaw).not.toHaveBeenCalled();
  });

  it('a second failure for an already-flagged address on the same job today only notes the timeline', async () => {
    const calls = fakeDb({ loggedTo: 'tylrrydr@gmail.com', jobNumber: 16893, problemOpen: true, recentlyAlerted: true });
    await processResendEvent(suppressedForCc, 'msg_2');
    expect(has(calls, /INSERT INTO interactions/)).toBe(true);
    expect(has(calls, /INSERT INTO notifications/)).toBe(false);
    expect(mockSendRaw).not.toHaveBeenCalled();
  });

  it('a re-opened problem alerts again even if alerted today', async () => {
    const calls = fakeDb({ loggedTo: 'tylrrydr@gmail.com', jobNumber: 16893, problemOpen: false, recentlyAlerted: true });
    await processResendEvent(suppressedForCc, 'msg_3');
    expect(count(calls, /INSERT INTO notifications/)).toBe(2);
    expect(mockSendRaw).toHaveBeenCalledTimes(1);
  });

  it('never emails info@ about one of our own addresses (no alert loop)', async () => {
    const calls = fakeDb({ problemOpen: null });
    await processResendEvent({
      ...suppressedForCc,
      data: { ...suppressedForCc.data, to: ['info@oooshtours.co.uk'] },
    }, 'msg_4');
    expect(count(calls, /INSERT INTO notifications/)).toBe(2);
    expect(mockSendRaw).not.toHaveBeenCalled();
  });

  it('a send failure alerts but does not flag the address', async () => {
    const calls = fakeDb({ loggedTo: 'a@b.com', jobNumber: null });
    await processResendEvent({ type: 'email.failed', data: { email_id: 're_9', to: ['a@b.com'], subject: 'x', failed: { reason: 'reached_daily_quota' } } }, 'msg_5');
    expect(has(calls, /email_address_problems/)).toBe(false);
    expect(mockSendRaw).toHaveBeenCalledTimes(1);
  });

  it('ignores event types it does not act on', async () => {
    const calls = fakeDb({});
    await processResendEvent({ type: 'email.opened', data: { to: ['a@b.com'] } }, 'msg_6');
    expect(calls).toHaveLength(0);
  });
});

describe('processResendEvent — a delivery clears the flag', () => {
  it('clears only for an email created after the last failure, and never one that failed for this address', async () => {
    const calls = fakeDb({});
    await processResendEvent({
      type: 'email.delivered',
      data: { email_id: 're_2', created_at: '2026-10-21T09:00:00.000Z', to: ['Megan@VariousArtistsManagement.com'] },
    }, 'msg_7');
    const upd = calls.find((c) => /UPDATE email_address_problems/.test(c.sql))!;
    expect(upd.sql).toMatch(/resolved_how = 'delivered'/);
    expect(upd.sql).toMatch(/last_seen_at < \$2::timestamptz/);
    expect(upd.sql).toMatch(/NOT EXISTS/);
    expect(upd.params).toEqual(['megan@variousartistsmanagement.com', '2026-10-21T09:00:00.000Z', 're_2']);
  });

  it('does not clear without a creation time to compare', async () => {
    const calls = fakeDb({});
    await processResendEvent({ type: 'email.delivered', data: { email_id: 're_3', to: ['a@b.com'] } }, 'msg_8');
    expect(calls).toHaveLength(0);
  });
});
