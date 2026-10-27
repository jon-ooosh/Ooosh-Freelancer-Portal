/**
 * The completion chaser's text at the 2nd reminder, and the one link the email
 * and the text share (jon, Oct 2026, after HH 16535: a van collection whose
 * freelancer never used the portal; the email's button went straight to the
 * completion page, which closes a job that never went through Start with no
 * van recorded).
 */
export {};

jest.mock('../../config/database', () => ({ query: jest.fn() }));
jest.mock('../email-service', () => ({ emailService: { sendRaw: jest.fn() } }));
jest.mock('../../routes/system-settings', () => ({ getSystemSetting: jest.fn() }));
jest.mock('../sms-service', () => {
  const actual = jest.requireActual('../sms-service');
  return { ...actual, smsService: { send: jest.fn() } };
});

import { query } from '../../config/database';
import { emailService } from '../email-service';
import { smsService, plainSmsText } from '../sms-service';
import { getSystemSetting } from '../../routes/system-settings';
import smsTemplates from '../sms-templates';
import {
  completionLink,
  textableNumber,
  completionTextVariables,
  runCompletionChase,
} from '../completion-chaser';

const mockQuery = query as jest.Mock;
const mockEmail = emailService.sendRaw as jest.Mock;
const mockSms = smsService.send as jest.Mock;
const mockSetting = getSystemSetting as jest.Mock;

const PORTAL = 'https://freelancer.oooshtours.co.uk';
const QID = 'aead9e70-5958-4715-a6a4-0fc55fe2a810';

describe('completionLink', () => {
  it('sends a delivery or collection that has not started to the Start screen', () => {
    expect(completionLink({ id: QID, job_type: 'collection', what_is_it: 'vehicle', van_leg_done_at: null }))
      .toBe(`${PORTAL}/job/${QID}/start`);
    expect(completionLink({ id: QID, job_type: 'delivery', what_is_it: 'equipment', van_leg_done_at: null }))
      .toBe(`${PORTAL}/job/${QID}/start`);
  });

  it('sends one whose van step is done to the completion page', () => {
    expect(completionLink({ id: QID, job_type: 'collection', what_is_it: 'vehicle', van_leg_done_at: new Date() }))
      .toBe(`${PORTAL}/job/${QID}/complete`);
  });

  it('sends crew and People work to the completion page', () => {
    expect(completionLink({ id: QID, job_type: 'crewed', what_is_it: null, van_leg_done_at: null }))
      .toBe(`${PORTAL}/job/${QID}/complete`);
    expect(completionLink({ id: QID, job_type: 'delivery', what_is_it: 'people', van_leg_done_at: null }))
      .toBe(`${PORTAL}/job/${QID}/complete`);
  });
});

describe('textableNumber', () => {
  it('prefers the mobile column', () => {
    expect(textableNumber({ freelancer_mobile: '07911 123456', freelancer_phone: '07922 654321' }))
      .toBe('+447911123456');
  });

  it('never texts a landline, but finds a mobile kept in another column', () => {
    expect(textableNumber({ freelancer_mobile: '01273 911382' })).toBeNull();
    expect(textableNumber({ freelancer_mobile: null, freelancer_phone: '07911 123456' })).toBe('+447911123456');
    expect(textableNumber({ freelancer_international_phone: '+33 6 12 34 56 78' })).toBe('+33612345678');
  });

  it('gives up quietly with no usable number', () => {
    expect(textableNumber({})).toBeNull();
    expect(textableNumber({ freelancer_mobile: 'ask Jim' })).toBeNull();
  });
});

describe('the text', () => {
  function render(vars: Record<string, string>): string {
    let body = smsTemplates.completion_chase.body;
    for (const [k, v] of Object.entries(vars)) body = body.split(`{{${k}}}`).join(v);
    return body;
  }

  it('reads naturally with the venue and the Start link', () => {
    const vars = completionTextVariables(
      { id: QID, job_type: 'collection', what_is_it: 'vehicle', van_leg_done_at: null, venue_name: 'Heathrow' },
      'collection',
    );
    expect(render(vars)).toBe(
      `Ooosh! Tours: your collection at Heathrow isn't marked as done yet. Please finish it here: ${PORTAL}/job/${QID}/start`,
    );
  });

  it('stays plain text and within two segments, however long the venue', () => {
    const vars = completionTextVariables(
      {
        id: QID, job_type: 'collection', what_is_it: 'equipment', van_leg_done_at: new Date(),
        venue_name: 'Théâtre de l’Étoile – Salle Pleyel, Rue du Faubourg Saint-Honoré, Paris',
      },
      'collection',
    );
    const body = render(vars);
    expect(body).toMatch(/^[\x20-\x7E]+$/);
    expect(body.length).toBeLessThanOrEqual(306); // two concatenated segments
    expect(vars.venuePart).toBe(' at Theatre de l\'Etoile - Salle');
  });

  it('drops the venue phrase when there is no venue', () => {
    expect(completionTextVariables(
      { id: QID, job_type: 'crewed', what_is_it: null, van_leg_done_at: null, venue_name: null }, 'crew job',
    ).venuePart).toBe('');
  });

  it('plainSmsText cuts to length without a trailing space', () => {
    expect(plainSmsText('The Corn Exchange Brighton', 18)).toBe('The Corn Exchange');
  });
});

describe('runCompletionChase', () => {
  const base = {
    id: QID, job_type: 'collection', what_is_it: 'vehicle', job_name: 'A4A x Throes - Self-drive van',
    venue_name: 'Heathrow', job_date: '2026-10-26', arrival_time: '09:00', van_leg_done_at: null,
    freelancer_id: 'p1', freelancer_email: 'lewis@example.com', freelancer_first_name: 'Lewis',
    freelancer_last_name: 'Hoadley', freelancer_preferred_name: null, freelancer_mobile: '07911 123456',
    freelancer_international_phone: null, freelancer_phone: null, agreed_rate: null,
  };

  function candidates(rows: Array<Record<string, unknown>>) {
    mockQuery.mockImplementation(async (sql: string) => {
      if (sql.includes('hours_past')) return { rows };
      if (sql.trim().startsWith('UPDATE quotes')) return { rows: [{ id: QID }] };
      return { rows: [] };
    });
  }

  beforeEach(() => {
    jest.useFakeTimers({ now: new Date('2026-10-26T15:00:00Z'), doNotFake: ['nextTick', 'setImmediate'] });
    mockQuery.mockReset();
    mockEmail.mockReset().mockResolvedValue({ success: true });
    mockSms.mockReset().mockResolvedValue({ success: true });
    mockSetting.mockReset().mockResolvedValue('true');
  });
  afterEach(() => jest.useRealTimers());

  it('texts once, with the 2nd reminder, to their mobile, with the Start link', async () => {
    candidates([{ ...base, hours_past: 6.2, completion_reminder_level: 1 }]);
    const out = await runCompletionChase();
    expect(out.texted).toBe(1);
    expect(mockSms).toHaveBeenCalledTimes(1);
    expect(mockSms).toHaveBeenCalledWith('completion_chase', {
      to: '+447911123456',
      variables: { kind: 'collection', venuePart: ' at Heathrow', link: `${PORTAL}/job/${QID}/start` },
    });
    // The email's button goes to the same place.
    expect(mockEmail.mock.calls[0][0].html).toContain(`href="${PORTAL}/job/${QID}/start"`);
  });

  it('texts when a run jumps straight past level 2 to 3', async () => {
    candidates([{ ...base, hours_past: 15, completion_reminder_level: 1 }]);
    expect((await runCompletionChase()).texted).toBe(1);
  });

  it('does not text again at level 3 once level 2 has been', async () => {
    candidates([{ ...base, hours_past: 15, completion_reminder_level: 2 }]);
    await runCompletionChase();
    expect(mockSms).not.toHaveBeenCalled();
    expect(mockEmail).toHaveBeenCalled();
  });

  it('does not text with the first reminder', async () => {
    candidates([{ ...base, hours_past: 2.5, completion_reminder_level: 0 }]);
    await runCompletionChase();
    expect(mockSms).not.toHaveBeenCalled();
  });

  it('sends the emails but no text when the setting is off', async () => {
    mockSetting.mockResolvedValue('false');
    candidates([{ ...base, hours_past: 6.2, completion_reminder_level: 1 }]);
    const out = await runCompletionChase();
    expect(mockSms).not.toHaveBeenCalled();
    expect(out.sent).toBe(1);
  });

  it('never texts the shared Ooosh crew account, or someone with only a landline', async () => {
    candidates([
      { ...base, hours_past: 6.2, completion_reminder_level: 1, freelancer_email: 'info@oooshtours.co.uk' },
      { ...base, hours_past: 6.2, completion_reminder_level: 1, freelancer_id: 'p2',
        freelancer_email: 'landline@example.com', freelancer_mobile: '01273 911382' },
    ]);
    const out = await runCompletionChase();
    expect(mockSms).not.toHaveBeenCalled();
    expect(out.sent).toBe(2);
  });

  it('a failed text never stops the email', async () => {
    mockSms.mockResolvedValue({ success: false, error: 'Twilio error' });
    candidates([{ ...base, hours_past: 6.2, completion_reminder_level: 1 }]);
    const out = await runCompletionChase();
    expect(out.sent).toBe(1);
    expect(out.texted).toBe(0);
  });
});
