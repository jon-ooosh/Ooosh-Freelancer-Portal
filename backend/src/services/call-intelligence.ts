/**
 * Call intelligence, stage I-a (docs/CALL-INTELLIGENCE-SPEC.md §I).
 *
 * After a recording is copied to R2 (services/telephony.ts), OP asks Twilio's
 * Conversational Intelligence for a transcript of the recording Twilio still holds.
 * A poll every 2 minutes (config/scheduler.ts) collects finished transcripts, has
 * Claude summarise them, emails a voicemail WITH its summary, then deletes the
 * transcript and the recording from Twilio, so OP keeps the only copy.
 *
 * Why a poll rather than Twilio's "transcript ready" webhook: fewer moving parts
 * (nothing to configure in Twilio, no second signed endpoint), and a missed
 * webhook can never strand a recording in Twilio.
 *
 * Off unless TWILIO_INTELLIGENCE_SERVICE_SID is set; telephony.ts then behaves as
 * before (email at once, delete at once).
 *
 * Rules:
 *   - Transcription is a bonus. A voicemail email never waits more than
 *     VOICEMAIL_WAIT_MINUTES for its summary, and a failed transcript still
 *     deletes the recording from Twilio.
 *   - The full transcript is for admins only (jon, Nov 2026); the summary is for
 *     everyone. Nothing here exposes either — the Calls screen (stage I-b) will.
 */

import { query } from '../config/database';
import { deleteFromR2 } from '../config/r2';
import { CLAUDE_SONNET_MODEL, getAnthropicClient, isAnthropicConfigured, readStructuredJson } from '../config/anthropic';
import { getSystemSetting } from '../routes/system-settings';
import { twilioAuthHeader, deleteTwilioRecording, emailVoicemailForCall } from './telephony';

const INTELLIGENCE_API = 'https://intelligence.twilio.com/v2';
export const VOICEMAIL_WAIT_MINUTES = 5;
/** A transcript still not back after this is given up on. */
const TRANSCRIPT_GIVE_UP_MINUTES = 60;
const MAX_TRANSCRIPT_CHARS = 60_000;

export function isTranscriptionOn(): boolean {
  return !!process.env.TWILIO_INTELLIGENCE_SERVICE_SID;
}

// ── Asking for a transcript ─────────────────────────────────────────────────

type Speaker = 'Caller' | 'Them' | 'Ooosh';

/**
 * Which channel is whom. A <Dial record="…-dual"> recording puts the PARENT leg
 * on channel 1: the caller on an incoming call, our handset on an outgoing one.
 * A voicemail is one channel: the caller.
 */
export function channelSpeakers(callType: string, kind: string): Record<number, Speaker> {
  if (kind === 'voicemail') return { 1: 'Caller' };
  if (callType === 'outbound') return { 1: 'Ooosh', 2: 'Them' };
  return { 1: 'Caller', 2: 'Ooosh' };
}

/** Ask Twilio to transcribe this call's recording. Once per call. */
export async function requestTranscript(callSid: string): Promise<void> {
  const r = await query(
    `SELECT recording_sid, call_type, kind, transcript_sid FROM call_records WHERE unique_call_id = $1`,
    [callSid],
  );
  const row = r.rows[0];
  if (!row?.recording_sid) throw new Error('No recording on this call');
  if (row.transcript_sid) return;

  const speakers = channelSpeakers(row.call_type, row.kind);
  const participants = Object.entries(speakers).map(([ch, who]) => ({
    channel_participant: Number(ch),
    role: who === 'Ooosh' ? 'Agent' : 'Customer',
    full_name: who,
  }));
  const body = new URLSearchParams({
    ServiceSid: process.env.TWILIO_INTELLIGENCE_SERVICE_SID!,
    CustomerKey: callSid,
    Channel: JSON.stringify({ media_properties: { source_sid: row.recording_sid }, participants }),
  });
  const res = await fetch(`${INTELLIGENCE_API}/Transcripts`, {
    method: 'POST',
    headers: { Authorization: twilioAuthHeader(), 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  const json = (await res.json().catch(() => ({}))) as { sid?: string; message?: string; code?: number };
  if (!res.ok || !json.sid) {
    throw new Error(`Twilio transcript request failed: ${json.code ?? res.status} ${json.message ?? ''}`.trim());
  }
  await query(
    `UPDATE call_records
        SET transcript_sid = $2, transcript_status = 'pending', transcript_requested_at = NOW(), updated_at = NOW()
      WHERE unique_call_id = $1`,
    [callSid, json.sid],
  );
}

// ── Collecting transcripts (every 2 minutes) ────────────────────────────────

async function intelligenceGet<T>(url: string): Promise<T> {
  const res = await fetch(url, { headers: { Authorization: twilioAuthHeader() } });
  if (!res.ok) throw new Error(`Twilio Intelligence GET failed: HTTP ${res.status}`);
  return (await res.json()) as T;
}

interface Sentence { media_channel?: number; transcript?: string; text?: string; start_time?: number | string }

/** The transcript as "Caller: …" / "Ooosh: …" lines, in order. */
export function sentencesToText(sentences: Sentence[], speakers: Record<number, Speaker>): string {
  const lines: string[] = [];
  let last: string | null = null;
  for (const s of sentences) {
    const words = (s.transcript ?? s.text ?? '').trim();
    if (!words) continue;
    const who = speakers[Number(s.media_channel)] ?? 'Unknown';
    if (who === last) lines[lines.length - 1] += ` ${words}`;
    else lines.push(`${who}: ${words}`);
    last = who;
  }
  return lines.join('\n');
}

async function fetchTranscriptText(transcriptSid: string, speakers: Record<number, Speaker>): Promise<string> {
  const all: Sentence[] = [];
  let url: string | null = `${INTELLIGENCE_API}/Transcripts/${encodeURIComponent(transcriptSid)}/Sentences?PageSize=1000`;
  for (let page = 0; url && page < 20; page++) {
    const json: { sentences?: Sentence[]; meta?: { next_page_url?: string | null } } = await intelligenceGet(url);
    all.push(...(json.sentences ?? []));
    url = json.meta?.next_page_url || null;
  }
  return sentencesToText(all, speakers);
}

async function deleteTwilioTranscript(transcriptSid: string): Promise<void> {
  const res = await fetch(`${INTELLIGENCE_API}/Transcripts/${encodeURIComponent(transcriptSid)}`, {
    method: 'DELETE', headers: { Authorization: twilioAuthHeader() },
  });
  if (!res.ok && res.status !== 404) throw new Error(`Twilio transcript delete failed: HTTP ${res.status}`);
}

interface PendingRow {
  unique_call_id: string;
  transcript_sid: string;
  recording_sid: string;
  call_type: string;
  kind: string;
  minutes_waiting: number;
  voicemail_emailed_at: string | null;
}

async function finishCall(row: PendingRow): Promise<void> {
  if (row.kind === 'voicemail') {
    await emailVoicemailForCall(row.unique_call_id).catch(err =>
      console.error(`[call-intelligence] voicemail email ${row.unique_call_id}:`, (err as Error).message));
  }
  await deleteTwilioTranscript(row.transcript_sid).catch(err =>
    console.warn(`[call-intelligence] transcript delete ${row.transcript_sid}:`, (err as Error).message));
  await deleteTwilioRecording(row.unique_call_id, row.recording_sid);
}

async function pollOne(row: PendingRow): Promise<void> {
  const t = await intelligenceGet<{ status?: string }>(
    `${INTELLIGENCE_API}/Transcripts/${encodeURIComponent(row.transcript_sid)}`,
  );
  const status = (t.status || '').toLowerCase();

  if (status === 'completed') {
    const text = await fetchTranscriptText(row.transcript_sid, channelSpeakers(row.call_type, row.kind));
    await query(
      `UPDATE call_records SET transcript = $2, transcript_status = 'completed', updated_at = NOW() WHERE unique_call_id = $1`,
      [row.unique_call_id, text.slice(0, MAX_TRANSCRIPT_CHARS)],
    );
    if (text) {
      await analyseCall(row.unique_call_id).catch(err =>
        console.error(`[call-intelligence] summary ${row.unique_call_id}:`, (err as Error).message));
    }
    await finishCall(row);
    return;
  }

  const gaveUp = row.minutes_waiting >= TRANSCRIPT_GIVE_UP_MINUTES;
  if (['failed', 'canceled', 'error'].includes(status) || gaveUp) {
    await query(
      `UPDATE call_records SET transcript_status = 'failed', last_error = $2, updated_at = NOW() WHERE unique_call_id = $1`,
      [row.unique_call_id, gaveUp ? 'transcript not back after an hour' : `transcript ${status}`],
    );
    await finishCall(row);
    return;
  }

  // Still working. A voicemail doesn't wait for ever: send it without the summary.
  if (row.kind === 'voicemail' && !row.voicemail_emailed_at && row.minutes_waiting >= VOICEMAIL_WAIT_MINUTES) {
    await emailVoicemailForCall(row.unique_call_id);
  }
}

let polling = false;

/** Collect finished transcripts; retry any Twilio delete that failed. Never throws. */
export async function runTranscriptPoll(): Promise<{ checked: number; errors: number }> {
  if (!isTranscriptionOn() || polling) return { checked: 0, errors: 0 };
  polling = true;
  let checked = 0;
  let errors = 0;
  try {
    const pending = await query(
      `SELECT unique_call_id, transcript_sid, recording_sid, call_type, kind, voicemail_emailed_at,
              EXTRACT(EPOCH FROM (NOW() - transcript_requested_at)) / 60 AS minutes_waiting
         FROM call_records
        WHERE transcript_status = 'pending' AND transcript_sid IS NOT NULL
        ORDER BY transcript_requested_at
        LIMIT 20`,
    );
    for (const row of pending.rows as PendingRow[]) {
      checked++;
      try { await pollOne({ ...row, minutes_waiting: Number(row.minutes_waiting) }); }
      catch (err) { errors++; console.error(`[call-intelligence] poll ${row.unique_call_id}:`, (err as Error).message); }
    }

    // A recording whose delete from Twilio failed earlier: try again.
    const leftovers = await query(
      `SELECT unique_call_id, recording_sid FROM call_records
        WHERE transcript_status IN ('completed', 'failed') AND recording_sid IS NOT NULL
          AND twilio_recording_deleted_at IS NULL
        LIMIT 20`,
    );
    for (const row of leftovers.rows) {
      try { await deleteTwilioRecording(row.unique_call_id, row.recording_sid); }
      catch (err) { errors++; console.warn(`[call-intelligence] recording delete ${row.recording_sid}:`, (err as Error).message); }
    }

    // A voicemail whose email failed while finishing: try again (for a day).
    const unsent = await query(
      `SELECT unique_call_id FROM call_records
        WHERE kind = 'voicemail' AND voicemail_emailed_at IS NULL AND audio_r2_key IS NOT NULL
          AND transcript_status IN ('completed', 'failed')
          AND recorded_at > NOW() - INTERVAL '1 day'
        LIMIT 10`,
    );
    for (const row of unsent.rows) {
      try { await emailVoicemailForCall(row.unique_call_id); }
      catch (err) { errors++; console.warn(`[call-intelligence] voicemail email ${row.unique_call_id}:`, (err as Error).message); }
    }
  } catch (err) {
    errors++;
    console.error('[call-intelligence] poll failed:', (err as Error).message);
  } finally {
    polling = false;
  }
  return { checked, errors };
}

// ── The summary ─────────────────────────────────────────────────────────────

export const CALL_CATEGORIES = ['enquiry', 'booking', 'job_question', 'complaint', 'supplier', 'personal', 'other'] as const;

const SYSTEM_PROMPT = `You summarise phone calls for Ooosh Tours, a UK company that hires splitter vans, backline
(music equipment) and rehearsal rooms to touring bands, tour managers and production companies.

You get the transcript of one call or voicemail. Lines start with who is speaking: "Ooosh" is our staff;
"Caller" or "Them" is the other person. Transcripts are machine-made, so names and numbers can be misheard.

Write for a busy colleague who will read it on a timeline, in plain British English:
- summary: 2–3 sentences. Who it was (as they introduced themselves), what they wanted, what was agreed or
  left open. Facts only, no padding, no guesses presented as facts.
- category: enquiry (new work), booking (an existing or confirmed booking), job_question (a question about
  a specific job), complaint, supplier (someone selling to or supplying us), personal (no obvious business
  reason — a private call), other.
- sentiment: positive, neutral or negative.
- mentioned_job_numbers: HireHop job or quote numbers said on the call, digits only (usually 4–5 digits).
  Only numbers clearly said as a job/quote/booking number — never phone numbers, prices or dates.
- suggested_action: the one next thing someone at Ooosh should do, e.g. "Send Josh a quote for a Basic,
  10–15 March". Empty string if nothing is needed.
- urgent: true only if the caller needs something today or is stuck (broken down, kit missing at a venue),
  or is complaining.
A voicemail with no words, or only a greeting, gets summary "No message left." and category other.`;

const SCHEMA = {
  type: 'object' as const,
  properties: {
    summary: { type: 'string' },
    category: { type: 'string', enum: [...CALL_CATEGORIES] },
    sentiment: { type: 'string', enum: ['positive', 'neutral', 'negative'] },
    mentioned_job_numbers: { type: 'array', items: { type: 'string' } },
    suggested_action: { type: 'string' },
    urgent: { type: 'boolean' },
  },
  required: ['summary', 'category', 'sentiment', 'mentioned_job_numbers', 'suggested_action', 'urgent'],
  additionalProperties: false,
};

interface Analysis {
  summary: string;
  category: typeof CALL_CATEGORIES[number];
  sentiment: 'positive' | 'neutral' | 'negative';
  mentioned_job_numbers: string[];
  suggested_action: string;
  urgent: boolean;
}

/** Claude reads the stored transcript and fills the summary columns. */
export async function analyseCall(callSid: string): Promise<void> {
  if (!isAnthropicConfigured()) return;
  const r = await query(
    `SELECT call_type, kind, transcript, duration_seconds FROM call_records WHERE unique_call_id = $1`,
    [callSid],
  );
  const row = r.rows[0];
  if (!row?.transcript) return;

  const what = row.kind === 'voicemail' ? 'A voicemail left for us'
    : row.call_type === 'outbound' ? 'A call we made' : 'A call to us';
  const response = await getAnthropicClient().messages.create({
    model: CLAUDE_SONNET_MODEL,
    max_tokens: 1500,
    system: [{ type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }],
    messages: [{ role: 'user', content: `${what}, ${row.duration_seconds ?? '?'} seconds long.\n\n${row.transcript}` }],
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    output_config: { effort: 'low', format: { type: 'json_schema', schema: SCHEMA as any } } as any,
  });
  const a = readStructuredJson<Analysis>(response, 'Call summary');
  const jobs = (a.mentioned_job_numbers || []).map(j => String(j).replace(/\D/g, '')).filter(j => /^\d{3,6}$/.test(j));
  await query(
    `UPDATE call_records
        SET summary = $2, call_category = $3, sentiment = $4, mentioned_job_refs = $5,
            suggested_action = $6, urgent = $7, analysed_at = NOW(), updated_at = NOW()
      WHERE unique_call_id = $1`,
    [callSid, (a.summary || '').trim() || null, a.category, a.sentiment, JSON.stringify(jobs),
      (a.suggested_action || '').trim() || null, !!a.urgent],
  );
}

// ── Retention (nightly) ─────────────────────────────────────────────────────

/** After `telephony_retention_months`: delete the audio and full transcript, keep the summary. */
export async function runCallRetention(): Promise<{ purged: number }> {
  const raw = parseInt((await getSystemSetting('telephony_retention_months').catch(() => null)) || '', 10);
  const months = Number.isFinite(raw) && raw >= 1 ? raw : 24;
  const old = await query(
    `SELECT unique_call_id, audio_r2_key FROM call_records
      WHERE retention_purged_at IS NULL
        AND recorded_at < NOW() - make_interval(months => $1::int)
      LIMIT 200`,
    [months],
  );
  let purged = 0;
  for (const row of old.rows) {
    if (row.audio_r2_key) {
      try { await deleteFromR2(row.audio_r2_key); }
      catch (err) { console.warn(`[call-intelligence] retention R2 delete ${row.audio_r2_key}:`, (err as Error).message); continue; }
    }
    await query(
      `UPDATE call_records SET audio_r2_key = NULL, transcript = NULL, retention_purged_at = NOW(), updated_at = NOW()
        WHERE unique_call_id = $1`,
      [row.unique_call_id],
    );
    purged++;
  }
  return { purged };
}
