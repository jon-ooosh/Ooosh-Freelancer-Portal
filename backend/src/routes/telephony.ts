/**
 * Telephony webhooks — Twilio asks, OP answers in TwiML (docs/CALL-INTELLIGENCE-SPEC.md §T3).
 *
 * PUBLIC (no JWT): every request must carry a valid X-Twilio-Signature, checked
 * with TWILIO_AUTH_TOKEN. Unsigned or badly signed → 403. Not configured → 503,
 * which makes Twilio use the fallback set in the Console: the TwiML Bin that
 * rings the bases for an incoming call, the "use a mobile" message for an
 * outgoing one. The phones therefore keep ringing whenever OP can't answer.
 *
 *   POST /inbound          the number          notice → ring the bases (recorded)
 *   POST /inbound-after    <Dial> action       answered → hang up; else voicemail
 *   POST /voicemail-done   <Record> action     hang up
 *   POST /outbound         the SIP domain      a handset dialled out → dial it (recorded)
 *   POST /outbound-after   <Dial> action       note the duration, hang up
 *   POST /recording        recording callbacks copy to R2 (+ voicemail email), delete from Twilio
 *
 * Logic lives in services/telephony.ts.
 */

import { Router, Request, Response, NextFunction } from 'express';
import {
  getTelephonySettings, isValidTwilioSignature, publicBaseUrl, telephonyEnvMissing,
  sayXml, twiml, xmlEscape, sipUser, planDial, recordCallStart, markMissed, markDuration,
  processRecording, markRecordingFailed,
} from '../services/telephony';
import { runHookWithRecovery } from '../services/post-hook-recovery';

const router = Router();

function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

function sendTwiml(res: Response, inner: string): void {
  res.type('text/xml').send(twiml(inner));
}

/** Only Twilio may call these routes. */
function verifyTwilio(req: Request, res: Response, next: NextFunction): void {
  const missing = telephonyEnvMissing();
  if (missing.length) {
    console.warn(`[telephony] not configured (${missing.join(', ')}) — Twilio will use its fallback`);
    res.status(503).send('Telephony not configured');
    return;
  }
  const url = publicBaseUrl() + req.originalUrl;
  const ok = isValidTwilioSignature(
    process.env.TWILIO_AUTH_TOKEN!, req.get('X-Twilio-Signature'), url, (req.body || {}) as Record<string, unknown>,
  );
  if (!ok) {
    console.warn(`[telephony] bad signature on ${req.originalUrl}`);
    res.status(403).send('Forbidden');
    return;
  }
  next();
}

router.use(verifyTwilio);

const base = () => `${publicBaseUrl()}/api/telephony`;

// ── Incoming ────────────────────────────────────────────────────────────────

router.post('/inbound', async (req: Request, res: Response) => {
  const callSid = str(req.body.CallSid);
  const from = str(req.body.From);
  const to = str(req.body.To);
  try {
    await recordCallStart({ callSid, callType: 'inbound', callerNumber: from, destNumber: to, otherParty: from });
  } catch (err) {
    // Logging must never stop the phones ringing.
    console.error('[telephony] could not log inbound call:', (err as Error).message);
  }
  const s = await getTelephonySettings();
  const domain = process.env.TWILIO_SIP_DOMAIN!;
  const sips = s.bases.map(b => `<Sip>sip:${xmlEscape(b)}@${xmlEscape(domain)}</Sip>`).join('');
  sendTwiml(res,
    sayXml(s.notice, s) +
    `<Dial timeout="${s.ringTimeout}" ringTone="uk" record="record-from-answer-dual"` +
    ` recordingStatusCallback="${base()}/recording?kind=call" recordingStatusCallbackEvent="completed"` +
    ` action="${base()}/inbound-after" method="POST">${sips}</Dial>`,
  );
});

router.post('/inbound-after', async (req: Request, res: Response) => {
  const callSid = str(req.body.CallSid);
  const status = str(req.body.DialCallStatus);
  if (status === 'completed') {
    await markDuration(callSid, parseInt(str(req.body.DialCallDuration), 10)).catch(() => undefined);
    sendTwiml(res, '<Hangup/>');
    return;
  }
  await markMissed(callSid).catch(err => console.error('[telephony] markMissed:', (err as Error).message));
  const s = await getTelephonySettings();
  sendTwiml(res,
    sayXml(s.greeting, s) +
    `<Record maxLength="180" playBeep="true" trim="trim-silence"` +
    ` recordingStatusCallback="${base()}/recording?kind=voicemail" recordingStatusCallbackEvent="completed"` +
    ` action="${base()}/voicemail-done" method="POST"/>`,
  );
});

router.post('/voicemail-done', (_req: Request, res: Response) => {
  sendTwiml(res, '<Hangup/>');
});

// ── Outgoing ────────────────────────────────────────────────────────────────

router.post('/outbound', async (req: Request, res: Response) => {
  const callSid = str(req.body.CallSid);
  const fromUser = sipUser(str(req.body.From));
  const dialled = sipUser(str(req.body.To));
  const callerId = process.env.TELEPHONY_CALLER_ID!;
  const plan = planDial(dialled);

  if (plan.kind === 'emergency') {
    // Emergency Calling on the SIP domain should route these before OP is asked.
    // If one reaches us anyway, dial it — never refuse it, never record it.
    sendTwiml(res, `<Dial callerId="${xmlEscape(callerId)}"><Number>${plan.number}</Number></Dial>`);
    return;
  }

  const s = await getTelephonySettings();
  if (plan.kind === 'refused') {
    const msg = plan.reason === 'premium'
      ? "Sorry, premium rate numbers can't be called from this phone."
      : "Sorry, that number wasn't recognised. Please check it and try again.";
    sendTwiml(res, sayXml(msg, s) + '<Hangup/>');
    return;
  }

  try {
    await recordCallStart({
      callSid, callType: 'outbound', callerNumber: fromUser || null, destNumber: plan.e164,
      otherParty: plan.e164, answeredBy: fromUser || null,
    });
  } catch (err) {
    console.error('[telephony] could not log outbound call:', (err as Error).message);
  }
  sendTwiml(res,
    `<Dial callerId="${xmlEscape(callerId)}" answerOnBridge="true" ringTone="uk" record="record-from-answer-dual"` +
    ` recordingStatusCallback="${base()}/recording?kind=call" recordingStatusCallbackEvent="completed"` +
    ` action="${base()}/outbound-after" method="POST"><Number>${xmlEscape(plan.e164)}</Number></Dial>`,
  );
});

router.post('/outbound-after', async (req: Request, res: Response) => {
  const callSid = str(req.body.CallSid);
  if (str(req.body.DialCallStatus) === 'completed') {
    await markDuration(callSid, parseInt(str(req.body.DialCallDuration), 10)).catch(() => undefined);
  }
  sendTwiml(res, '<Hangup/>');
});

// ── Recordings ──────────────────────────────────────────────────────────────

router.post('/recording', (req: Request, res: Response) => {
  // Answer first; the copy to R2 and the email happen after.
  res.status(204).end();

  if (str(req.body.RecordingStatus) !== 'completed') return;
  const cb = {
    callSid: str(req.body.CallSid),
    recordingSid: str(req.body.RecordingSid),
    recordingUrl: str(req.body.RecordingUrl),
    durationSeconds: Number.isFinite(parseInt(str(req.body.RecordingDuration), 10))
      ? parseInt(str(req.body.RecordingDuration), 10) : null,
    kind: (req.query.kind === 'voicemail' ? 'voicemail' : 'call') as 'call' | 'voicemail',
  };
  if (!cb.callSid || !cb.recordingSid || !/^https:\/\/api\.twilio\.com\//.test(cb.recordingUrl)) {
    console.warn('[telephony] recording callback with missing fields — ignored');
    return;
  }
  setImmediate(() => {
    runHookWithRecovery(
      { hookLabel: cb.kind === 'voicemail' ? 'Voicemail recording' : 'Call recording', context: `Twilio call ${cb.callSid}` },
      () => processRecording(cb),
    ).catch(err => markRecordingFailed(cb.callSid, err));
  });
});

export default router;
