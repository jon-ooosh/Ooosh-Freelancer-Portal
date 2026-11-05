/**
 * Telephony on Twilio — OP as the phone system (docs/CALL-INTELLIGENCE-SPEC.md §T).
 *
 * Twilio asks OP what to do with each call (routes/telephony.ts) and OP answers in
 * TwiML. This file holds everything those routes need:
 *   - verifying that a request really came from Twilio (X-Twilio-Signature);
 *   - building the TwiML (spoken messages, ringing the bases, voicemail, dialling out);
 *   - turning the digits a handset dialled into a number Twilio can call;
 *   - copying a finished recording to R2, emailing a voicemail, deleting it from Twilio.
 *
 * Rules (spec §T3):
 *   - Answer Twilio fast. Nothing slow (R2, email) happens inside a TwiML reply;
 *     recordings are processed after the reply, wrapped in runHookWithRecovery.
 *   - Twilio is called over REST with the same API key as SMS — no SDK.
 *   - An emergency number is NEVER refused here (see EMERGENCY_NUMBERS).
 *   - Call recordings live under `calls/` (GET /api/files/download: admins only);
 *     voicemails under `voicemails/` (any staff login).
 */

import crypto from 'crypto';
import { query } from '../config/database';
import { uploadToR2, getFromR2 } from '../config/r2';
import { getSystemSettings } from '../routes/system-settings';
import { normaliseMsisdn } from './sms-service';
import { emailService } from './email-service';

export const CALLS_PREFIX = 'calls/';
/** Voicemails are a different matter (jon, Nov 2026): any staff login may open one. */
export const VOICEMAILS_PREFIX = 'voicemails/';

/** 999 / 112 (UK), 911 (a visitor's habit). Always dialled, never refused or recorded. */
const EMERGENCY_NUMBERS = new Set(['999', '112', '911']);

const DEFAULTS = {
  notice: "Hi, you're through to Ooosh Tours. Calls are recorded for quality and training. Connecting you now.",
  greeting: "Thanks for calling Ooosh Tours. Sorry we can't get to the phone, please leave your name and number, and we'll call you back asap. Or email info at oooshtours dot co dot uk.",
  sayOooshAs: 'oosh',
  voice: 'Polly.Amy-Neural',
  ringTimeout: 25,
  bases: ['base1', 'base2'],
  voicemailTo: 'info@oooshtours.co.uk',
};

// ── Config ──────────────────────────────────────────────────────────────────

/** The public address Twilio calls us on — the signature is computed over it. */
export function publicBaseUrl(): string {
  return (process.env.TELEPHONY_PUBLIC_URL || 'https://staff.oooshtours.co.uk').replace(/\/+$/, '');
}

export function telephonyEnvMissing(): string[] {
  const need = ['TWILIO_AUTH_TOKEN', 'TWILIO_SIP_DOMAIN', 'TELEPHONY_CALLER_ID'];
  return need.filter(k => !process.env[k]);
}

export interface TelephonySettings {
  notice: string;
  greeting: string;
  sayOooshAs: string;
  voice: string;
  ringTimeout: number;
  bases: string[];
  voicemailTo: string;
}

/** Every value falls back to the default, so a missing row never breaks the phones. */
export async function getTelephonySettings(): Promise<TelephonySettings> {
  let s: Record<string, string | null> = {};
  try {
    s = await getSystemSettings([
      'telephony_recording_notice', 'telephony_voicemail_greeting', 'telephony_say_ooosh_as',
      'telephony_voice', 'telephony_ring_timeout_seconds', 'telephony_ring_bases',
      'telephony_voicemail_email_to',
    ]);
  } catch (err) {
    console.warn('[telephony] settings read failed, using defaults:', (err as Error).message);
  }
  const text = (v: string | null | undefined, d: string) => (v && v.trim() ? v.trim() : d);
  const timeout = parseInt(s.telephony_ring_timeout_seconds || '', 10);
  const bases = (s.telephony_ring_bases || '')
    .split(',').map(b => b.trim()).filter(b => /^[A-Za-z0-9._-]+$/.test(b));
  return {
    notice: text(s.telephony_recording_notice, DEFAULTS.notice),
    greeting: text(s.telephony_voicemail_greeting, DEFAULTS.greeting),
    sayOooshAs: text(s.telephony_say_ooosh_as, DEFAULTS.sayOooshAs),
    voice: text(s.telephony_voice, DEFAULTS.voice),
    ringTimeout: Number.isFinite(timeout) && timeout >= 5 && timeout <= 120 ? timeout : DEFAULTS.ringTimeout,
    bases: bases.length ? bases : DEFAULTS.bases,
    voicemailTo: text(s.telephony_voicemail_email_to, DEFAULTS.voicemailTo),
  };
}

// ── Signature ───────────────────────────────────────────────────────────────

/**
 * Twilio's request signature: HMAC-SHA1 (key = Auth Token) over the full URL it
 * called, followed by every POST parameter as name+value, sorted by name; base64.
 */
export function computeTwilioSignature(authToken: string, url: string, params: Record<string, unknown>): string {
  const data = Object.keys(params).sort()
    .reduce((acc, k) => acc + k + String(params[k] ?? ''), url);
  return crypto.createHmac('sha1', authToken).update(Buffer.from(data, 'utf-8')).digest('base64');
}

export function isValidTwilioSignature(
  authToken: string, signature: string | undefined, url: string, params: Record<string, unknown>,
): boolean {
  if (!signature) return false;
  const expected = Buffer.from(computeTwilioSignature(authToken, url, params));
  const given = Buffer.from(signature);
  return expected.length === given.length && crypto.timingSafeEqual(expected, given);
}

// ── TwiML ───────────────────────────────────────────────────────────────────

export function xmlEscape(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

/**
 * A <Say>, with every "Ooosh" (also inside "oooshtours") spoken as the sounds-like spelling in Settings
 * (SSML <sub alias>), because a speech engine has never met the word.
 */
export function sayXml(text: string, settings: Pick<TelephonySettings, 'voice' | 'sayOooshAs'>): string {
  const alias = xmlEscape(settings.sayOooshAs);
  const body = xmlEscape(text).replace(/\bO{2,}sh/gi, m => `<sub alias="${alias}">${m}</sub>`);
  return `<Say voice="${xmlEscape(settings.voice)}">${body}</Say>`;
}

export function twiml(inner: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?><Response>${inner}</Response>`;
}

// ── Dialled digits ──────────────────────────────────────────────────────────

export type DialPlan =
  | { kind: 'emergency'; number: string }
  | { kind: 'ok'; e164: string }
  | { kind: 'refused'; reason: 'premium' | 'unparseable' };

/** The user part of a SIP URI: "sip:07700900123@ooosh.sip.twilio.com;user=phone" → "07700900123". */
export function sipUser(uri: string | undefined | null): string {
  const m = /^sips?:([^@;>]+)/i.exec((uri || '').trim());
  return m ? decodeURIComponent(m[1]) : '';
}

/**
 * What a handset dialled → what OP will dial. UK by default (07… → +447…,
 * 01… → +441…); 00… is international. Uses the SMS normaliser, so the address
 * book and the phones read numbers the same way.
 */
export function planDial(dialled: string): DialPlan {
  const raw = dialled.replace(/[\s()-]/g, '');
  if (EMERGENCY_NUMBERS.has(raw)) return { kind: 'emergency', number: raw };
  if (!/^\+?\d{3,16}$/.test(raw)) return { kind: 'refused', reason: 'unparseable' };
  const withPlus = raw.startsWith('00') ? `+${raw.slice(2)}` : raw;
  const n = normaliseMsisdn(withPlus, 'GB');
  if (!n) return { kind: 'refused', reason: 'unparseable' };
  if (/^\+449/.test(n.e164)) return { kind: 'refused', reason: 'premium' };
  return { kind: 'ok', e164: n.e164 };
}

// ── Call records ────────────────────────────────────────────────────────────

export async function recordCallStart(row: {
  callSid: string; callType: 'inbound' | 'outbound'; callerNumber: string | null;
  destNumber: string | null; otherParty: string | null; answeredBy?: string | null;
}): Promise<void> {
  await query(
    `INSERT INTO call_records (unique_call_id, call_type, caller_number, dest_number, other_party_number, answered_by)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (unique_call_id) DO NOTHING`,
    [row.callSid, row.callType, row.callerNumber, row.destNumber, row.otherParty, row.answeredBy ?? null],
  );
}

/** Nobody answered. Stays 'missed' with no audio unless a voicemail arrives. */
export async function markMissed(callSid: string): Promise<void> {
  await query(
    `UPDATE call_records SET kind = 'missed', status = 'no_audio', updated_at = NOW()
      WHERE unique_call_id = $1 AND kind = 'call'`,
    [callSid],
  );
}

export async function markDuration(callSid: string, seconds: number | null): Promise<void> {
  if (seconds == null || !Number.isFinite(seconds)) return;
  await query(
    `UPDATE call_records SET duration_seconds = $2, updated_at = NOW() WHERE unique_call_id = $1`,
    [callSid, Math.round(seconds)],
  );
}

// ── Recordings ──────────────────────────────────────────────────────────────

export function twilioAuthHeader(): string {
  const keySid = process.env.TWILIO_API_KEY_SID;
  const keySecret = process.env.TWILIO_API_KEY_SECRET;
  if (!keySid || !keySecret) throw new Error('TWILIO_API_KEY_SID / TWILIO_API_KEY_SECRET not set');
  return `Basic ${Buffer.from(`${keySid}:${keySecret}`).toString('base64')}`;
}

export interface RecordingCallback {
  callSid: string;
  recordingSid: string;
  recordingUrl: string;
  durationSeconds: number | null;
  kind: 'call' | 'voicemail';
}

/**
 * Copy a finished recording to R2, then EITHER hand it to transcription
 * (TWILIO_INTELLIGENCE_SERVICE_SID set — services/call-intelligence.ts deletes it
 * from Twilio and emails a voicemail once the transcript is back) OR email it if
 * it's a voicemail and delete it from Twilio straight away.
 * IDEMPOTENT — it is retried: the upload overwrites the same key, the email is
 * guarded by voicemail_emailed_at, a transcript is asked for once per recording,
 * and a recording already gone from Twilio (404) counts as deleted.
 */
export async function processRecording(cb: RecordingCallback): Promise<void> {
  // A recording for a call OP never logged (shouldn't happen) still gets a row.
  await recordCallStart({
    callSid: cb.callSid, callType: 'inbound', callerNumber: null, destNumber: null, otherParty: null,
  });

  const res = await fetch(`${cb.recordingUrl}.mp3`, { headers: { Authorization: twilioAuthHeader() } });
  if (!res.ok) throw new Error(`Recording download failed: HTTP ${res.status}`);
  const audio = Buffer.from(await res.arrayBuffer());

  const now = new Date();
  const prefix = cb.kind === 'voicemail' ? VOICEMAILS_PREFIX : CALLS_PREFIX;
  const key = `${prefix}${now.getUTCFullYear()}/${String(now.getUTCMonth() + 1).padStart(2, '0')}/${cb.callSid}-${cb.recordingSid}.mp3`;
  await uploadToR2(key, audio, 'audio/mpeg');

  await query(
    `UPDATE call_records
        SET recording_sid = $2, audio_r2_key = $3, status = 'stored', last_error = NULL,
            kind = CASE WHEN $4 = 'voicemail' THEN 'voicemail' ELSE kind END,
            duration_seconds = COALESCE(duration_seconds, $5),
            updated_at = NOW()
      WHERE unique_call_id = $1`,
    [cb.callSid, cb.recordingSid, key, cb.kind, cb.durationSeconds],
  );

  // Loaded here, not at the top: call-intelligence imports this file.
  const ci = await import('./call-intelligence');
  if (ci.isTranscriptionOn()) {
    try {
      await ci.requestTranscript(cb.callSid);
      return; // the transcript poll finishes the job (email, delete from Twilio)
    } catch (err) {
      // Transcription is a bonus, never a reason to lose the voicemail email.
      console.warn(`[telephony] transcript request failed for ${cb.callSid}:`, (err as Error).message);
      await query(
        `UPDATE call_records SET transcript_status = 'failed', last_error = $2, updated_at = NOW() WHERE unique_call_id = $1`,
        [cb.callSid, `transcript request: ${(err as Error).message}`.slice(0, 500)],
      );
    }
  }

  if (cb.kind === 'voicemail') await emailVoicemailForCall(cb.callSid, audio);
  await deleteTwilioRecording(cb.callSid, cb.recordingSid);
}

/** Delete a recording from Twilio (404 = already gone) and note when. */
export async function deleteTwilioRecording(callSid: string, recordingSid: string): Promise<void> {
  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  if (!accountSid) throw new Error('TWILIO_ACCOUNT_SID not set');
  const del = await fetch(
    `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Recordings/${encodeURIComponent(recordingSid)}.json`,
    { method: 'DELETE', headers: { Authorization: twilioAuthHeader() } },
  );
  if (!del.ok && del.status !== 404) throw new Error(`Twilio recording delete failed: HTTP ${del.status}`);
  await query(
    `UPDATE call_records SET twilio_recording_deleted_at = COALESCE(twilio_recording_deleted_at, NOW()) WHERE unique_call_id = $1`,
    [callSid],
  );
}

/**
 * Email a voicemail to the Settings address — once (voicemail_emailed_at), with
 * the summary when there is one. `audio` saves a trip to R2 when the caller has it.
 */
export async function emailVoicemailForCall(callSid: string, audio?: Buffer): Promise<void> {
  const r = await query(
    `SELECT caller_number, other_party_number, recorded_at, duration_seconds, recording_sid,
            audio_r2_key, voicemail_emailed_at, summary, suggested_action, urgent
       FROM call_records WHERE unique_call_id = $1`,
    [callSid],
  );
  const row = r.rows[0];
  if (!row || row.voicemail_emailed_at || !row.audio_r2_key) return;

  let bytes = audio;
  if (!bytes) {
    const obj = await getFromR2(row.audio_r2_key);
    bytes = Buffer.from(await (obj.Body as { transformToByteArray: () => Promise<Uint8Array> }).transformToByteArray());
  }

  const from: string = row.other_party_number || row.caller_number || 'an unknown number';
  const { voicemailTo } = await getTelephonySettings();
  const when = new Date(row.recorded_at).toLocaleString('en-GB', {
    timeZone: 'Europe/London', weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit',
  });
  const length = row.duration_seconds != null ? `${row.duration_seconds} seconds` : 'unknown length';
  const summary = row.summary
    ? `<p>${xmlEscape(row.summary)}</p>${row.suggested_action ? `<p><strong>Next step:</strong> ${xmlEscape(row.suggested_action)}</p>` : ''}`
    : '<p>No written summary for this one. The recording is attached.</p>';
  const html = `<!doctype html><html><body style="font-family:Arial,sans-serif;font-size:14px;color:#111">
<p><strong>${row.urgent ? 'URGENT: ' : ''}New voicemail</strong> from <strong>${xmlEscape(from)}</strong></p>
<p>${xmlEscape(when)} · ${xmlEscape(length)}</p>
${summary}
</body></html>`;
  const result = await emailService.sendRaw({
    to: voicemailTo,
    subject: `${row.urgent ? 'URGENT ' : ''}Voicemail from ${from}`,
    html,
    skipLayout: true,
    attachments: [{ filename: `voicemail-${row.recording_sid || callSid}.mp3`, content: bytes, contentType: 'audio/mpeg' }],
  });
  // sendRaw resolves { success: false } rather than throwing — throw so the caller retries.
  if (!result.success) throw new Error(`Voicemail email failed: ${result.error || 'unknown error'}`);
  await query(`UPDATE call_records SET voicemail_emailed_at = NOW() WHERE unique_call_id = $1`, [callSid]);
}

export async function markRecordingFailed(callSid: string, error: unknown): Promise<void> {
  const msg = error instanceof Error ? error.message : String(error);
  await query(
    `UPDATE call_records SET status = 'failed', last_error = $2, updated_at = NOW()
      WHERE unique_call_id = $1 AND status <> 'stored'`,
    [callSid, msg.slice(0, 500)],
  ).catch(() => undefined);
}
