/**
 * Chase-draft generation (Auto-Chase Phase 2)
 *
 * Given a job that's due a chase, draft a short "just checking in" email with
 * Claude — grounded strictly in retrieved data (the quote line items, band /
 * dates / service, repeat-vs-first-contact history, and the actual prior email
 * thread once Phase 1 has ingested any). Spec §9.1–9.3.
 *
 * This module ONLY produces the draft text ({ subject, body }). Creating the
 * Gmail draft (threaded onto the original quote email) is a separate slice that
 * needs the `gmail.compose` DWD scope — see routes/auto-chase.ts + config/gmail.ts.
 * A preview endpoint (POST /api/auto-chase/preview-draft/:jobId) returns this
 * text as JSON so draft quality can be judged on real jobs before Gmail writes
 * are wired.
 *
 * Guardrails (§9.2): the "checking in, NOT renegotiating" rails live in the code
 * SYSTEM_PROMPT and can't be edited by staff. The `chase_voice_instructions`
 * system-setting is APPENDED — jon's "more of this / less of that" knob, tunable
 * without a deploy.
 */
import { query } from '../config/database';
import { getAnthropicClient, isAnthropicConfigured } from '../config/anthropic';
import { getSystemSetting } from '../routes/system-settings';
import type { HHLineItem } from './hirehop-job-sync';

// Spec §9.1 calls for Sonnet 5 — the drafting is nuance-heavy (tone varies by
// relationship) and a client-facing email is the one place we don't cut corners.
const MODEL_ID = 'claude-sonnet-5';
const MAX_TOKENS = 800;

// The rails. Staff cannot edit these — the chase-voice setting is appended below.
const SYSTEM_PROMPT = `You draft short chase emails for Ooosh Tours, a music & event transport / backline / rehearsal hire company. A quote went out to a client and we've heard nothing back; you write a brief, warm "just checking in" nudge.

HARD RULES — never break these:
- This is a gentle CHECK-IN, never a renegotiation. Do NOT invent discounts, change prices, add urgency/deadlines, or offer anything not already in the quote.
- Ground every concrete detail (band, dates, what's being hired, job number) ONLY in the data provided. If a detail isn't given, don't mention it. Never guess or fabricate.
- Keep it SHORT — 2 short paragraphs max, ideally 3-5 sentences total. Busy people skim.
- Warm and human, not corporate or pushy. One light question that invites a reply ("any thoughts on the quote?" / "happy to tweak anything?").
- British English. Sign off as "Ooosh" / "the Ooosh team" (no fake individual name).
- If a prior email thread is provided, match its tone and reference it naturally; if it's a first contact, keep it friendly-neutral.
- Plain text only. No markdown, no placeholders like [name], no subject-line clichés ("Just following up!!!").

Return ONLY the tool call with the drafted subject + body.`;

const SCHEMA = {
  type: 'object' as const,
  properties: {
    subject: { type: 'string', description: 'Email subject line. Prefer replying into the existing thread subject if one is given.' },
    body: { type: 'string', description: 'Plain-text email body, ready to send. 2 short paragraphs max.' },
  },
  required: ['subject', 'body'],
  additionalProperties: false,
};

export interface ChaseDraft {
  subject: string;
  body: string;
}

export interface ChaseContext {
  jobId: string;
  hhJobNumber: number | null;
  jobName: string | null;
  clientName: string | null;
  jobValue: number | null;
  outDate: string | null;
  jobEnd: string | null;
  pipelineStatus: string | null;
  itemsSummary: string[];      // human-readable list of what's being hired
  priorChaseCount: number;     // how many times we've chased already
  isRepeatClient: boolean;     // client has prior jobs with us
  priorHireCount: number;
  threadText: string | null;   // concatenated prior email thread (Phase 1), if any
  hasThread: boolean;
}

/** Build a short, human list of what's being hired from the cached HH line items. */
function summariseItems(lineItems: HHLineItem[] | null): string[] {
  if (!Array.isArray(lineItems)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const it of lineItems) {
    // Real hireable items only: skip headers (kind 0), selected prompts (kind 3),
    // and virtual grouping rows. Keep kind 2 (items) + kind 4 (crew/services).
    if (it.kind !== 2 && it.kind !== 4) continue;
    if (it.VIRTUAL) continue;
    const name = (it.ITEM_NAME || '').replace(/^▶\s*/, '').trim();
    if (!name || seen.has(name.toLowerCase())) continue;
    seen.add(name.toLowerCase());
    const qty = it.QUANTITY && it.QUANTITY > 1 ? `${it.QUANTITY}× ` : '';
    out.push(`${qty}${name}`);
    if (out.length >= 20) break;
  }
  return out;
}

/**
 * Assemble the grounding context for a chase draft. Defensive: any optional
 * piece that fails (thread history, hire count) is skipped, not fatal — a draft
 * grounded on just the quote is still useful.
 */
export async function gatherChaseContext(jobId: string): Promise<ChaseContext | null> {
  const jobRes = await query(
    `SELECT id, hh_job_number, job_name, client_name, client_id, job_value,
            out_date, job_end, pipeline_status, line_items,
            COALESCE(auto_chase_count, 0) AS auto_chase_count
       FROM jobs
      WHERE id = $1 AND is_deleted = false`,
    [jobId],
  );
  if (jobRes.rows.length === 0) return null;
  const j = jobRes.rows[0];

  const ctx: ChaseContext = {
    jobId: j.id,
    hhJobNumber: j.hh_job_number ?? null,
    jobName: j.job_name ?? null,
    clientName: j.client_name ?? null,
    jobValue: j.job_value != null ? Number(j.job_value) : null,
    outDate: j.out_date ? new Date(j.out_date).toISOString().slice(0, 10) : null,
    jobEnd: j.job_end ? new Date(j.job_end).toISOString().slice(0, 10) : null,
    pipelineStatus: j.pipeline_status ?? null,
    itemsSummary: summariseItems(j.line_items),
    priorChaseCount: Number(j.auto_chase_count) || 0,
    isRepeatClient: false,
    priorHireCount: 0,
    threadText: null,
    hasThread: false,
  };

  // Repeat-client signal — prior jobs for the same client org (best-effort).
  if (j.client_id) {
    try {
      const hist = await query(
        `SELECT COUNT(*)::int AS n
           FROM jobs
          WHERE client_id = $1 AND id <> $2 AND is_deleted = false
            AND pipeline_status IN ('confirmed','prepped','prepping','dispatched',
                                    'returned_incomplete','returned','completed')`,
        [j.client_id, jobId],
      );
      ctx.priorHireCount = hist.rows[0]?.n ?? 0;
      ctx.isRepeatClient = ctx.priorHireCount > 0;
    } catch {
      /* non-fatal */
    }
  }

  // Prior email thread from Phase 1 ingestion (may be empty until ingestion runs).
  try {
    const thread = await query(
      `SELECT email_direction, email_from, email_subject, content, created_at
         FROM interactions
        WHERE job_id = $1 AND type = 'email'
        ORDER BY created_at ASC
        LIMIT 20`,
      [jobId],
    );
    if (thread.rows.length > 0) {
      const parts = thread.rows.map((r) => {
        const who = r.email_direction === 'outbound' ? 'Ooosh' : (r.email_from || 'Client');
        const when = r.created_at ? new Date(r.created_at).toISOString().slice(0, 10) : '';
        const body = String(r.content || '').replace(/\s+/g, ' ').trim().slice(0, 800);
        return `[${when}] ${who}${r.email_subject ? ` — ${r.email_subject}` : ''}\n${body}`;
      });
      // Cap total thread text so we don't blow the context on a huge chain.
      ctx.threadText = parts.join('\n\n').slice(0, 6000);
      ctx.hasThread = true;
    }
  } catch {
    /* non-fatal */
  }

  return ctx;
}

/** Render the grounding context into the user prompt. */
function buildUserPrompt(ctx: ChaseContext): string {
  const lines: string[] = [];
  lines.push('Draft a check-in chase for this quote. Grounding data:');
  lines.push('');
  if (ctx.jobName) lines.push(`Job: ${ctx.jobName}`);
  if (ctx.hhJobNumber) lines.push(`Job number: #${ctx.hhJobNumber}`);
  if (ctx.clientName) lines.push(`Client: ${ctx.clientName}`);
  if (ctx.outDate) lines.push(`Hire dates: ${ctx.outDate}${ctx.jobEnd && ctx.jobEnd !== ctx.outDate ? ` to ${ctx.jobEnd}` : ''}`);
  if (ctx.jobValue != null) lines.push(`Quote value: £${ctx.jobValue.toFixed(2)} (do NOT state the price in the email unless it was already discussed in the thread — reference "the quote")`);
  if (ctx.itemsSummary.length) lines.push(`What they're hiring: ${ctx.itemsSummary.join(', ')}`);
  lines.push(
    ctx.isRepeatClient
      ? `Relationship: repeat client (${ctx.priorHireCount} prior hire${ctx.priorHireCount === 1 ? '' : 's'} with us — you can be warmer / more familiar).`
      : 'Relationship: first contact / no prior hires on record — friendly-neutral.',
  );
  if (ctx.priorChaseCount > 0) {
    lines.push(`We have already chased ${ctx.priorChaseCount} time(s) with no reply — keep this one light and low-pressure, do not nag.`);
  }
  lines.push('');
  if (ctx.hasThread && ctx.threadText) {
    lines.push('Prior email thread (most recent last) — match its tone, reply naturally into it:');
    lines.push('"""');
    lines.push(ctx.threadText);
    lines.push('"""');
  } else {
    lines.push('No prior email thread on record — this is effectively a first nudge after the quote went out.');
  }
  return lines.join('\n');
}

/**
 * Draft a chase email for a job. Returns { subject, body } + the context used.
 * Throws if Anthropic isn't configured (caller should guard / 503).
 */
export async function draftChaseEmail(
  jobId: string,
): Promise<{ draft: ChaseDraft; context: ChaseContext }> {
  if (!isAnthropicConfigured()) {
    throw new Error('ANTHROPIC_API_KEY not configured — cannot draft chases.');
  }
  const context = await gatherChaseContext(jobId);
  if (!context) throw new Error(`Job ${jobId} not found`);

  // Append the tunable chase-voice knob (§9.2) to the code rails.
  const chaseVoice = (await getSystemSetting('chase_voice_instructions')) || '';
  const system = chaseVoice.trim()
    ? [
        { type: 'text' as const, text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' as const } },
        { type: 'text' as const, text: `ADDITIONAL VOICE GUIDANCE (from Ooosh, obey unless it conflicts with a HARD RULE):\n${chaseVoice.trim()}` },
      ]
    : [{ type: 'text' as const, text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' as const } }];

  const client = getAnthropicClient();
  const response = await client.messages.create({
    model: MODEL_ID,
    max_tokens: MAX_TOKENS,
    system,
    messages: [{ role: 'user', content: buildUserPrompt(context) }],
    tools: [
      {
        name: 'report_draft',
        description: 'Return the drafted chase email — subject + plain-text body.',
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        input_schema: SCHEMA as any,
      },
    ],
    tool_choice: { type: 'tool', name: 'report_draft' },
  });

  const toolBlock = response.content.find((b) => b.type === 'tool_use');
  if (toolBlock && toolBlock.type === 'tool_use') {
    const out = toolBlock.input as ChaseDraft;
    return { draft: { subject: out.subject, body: out.body }, context };
  }
  throw new Error('Claude did not return a chase draft');
}
