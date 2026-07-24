/**
 * Dispute helper — natural-language Q&A over a job's email chain (spec §7.2)
 *
 * Because Phase 1 ingests full email bodies, the whole conversation for a job is
 * searchable. "Where's X??" / "when did they ask to drop the second van?"
 * becomes a question answered from the actual emails — Claude surfaces the
 * relevant message(s) with dates + quotes, or says it can't find it. This is the
 * richer sibling of the per-job summary (comms-summary.ts): the summary gives
 * the gist, this answers a specific question.
 *
 * Grounded strictly in the ingested `type='email'` interactions — never guesses.
 * Sonnet 5 (spec §4) because it's reasoning over a chain to pin "who asked for
 * what, when". The email chain is sent as a prompt-cached block so repeated
 * questions about the same job reuse it cheaply.
 */
import { query } from '../config/database';
import { getAnthropicClient, isAnthropicConfigured } from '../config/anthropic';
import { buildQuoteVersionContext } from './quote-versions';

const MODEL_ID = 'claude-sonnet-5';
const MAX_TOKENS = 900;

const SYSTEM_PROMPT = `You answer an Ooosh Tours staff member's question about a client conversation for a specific hire. You are given the full email chain, and — when available — the succession of QUOTE PDF versions we emailed (with what changed between them). Answer ONLY from what you are given. This is used to settle "who asked for what, when" (disputes, "where's my X?", "did we confirm the dates?", "when did the second van come off the quote?").

RULES:
- Ground every claim in the material provided. Quote the relevant line(s) and give the DATE. For quote-version facts, cite which version and its date (e.g. "the 7 Jun quote dropped from 2 to 1 snare stand"). Never guess, infer beyond what's written, or invent.
- Cross-reference the two when useful: the emails show what was DISCUSSED, the quote versions show what was actually QUOTED (e.g. "client asked to drop X on the 3rd → gone from the 4 Jun quote").
- If the answer isn't in the emails or quote versions, say so plainly (e.g. "I can't find anything about that on this job") — do not speculate.
- Lead with the direct answer, then the supporting quote/version + date. If several are relevant, walk through them in date order.
- Attribute correctly: messages are marked as from the client or from Ooosh. Don't confuse who said what.
- Concise and factual — this is an internal staff tool, not a client-facing message. British English. Plain text; short quotes in quotation marks are fine.

Return ONLY the tool call with your answer.`;

const SCHEMA = {
  type: 'object' as const,
  properties: {
    answer: { type: 'string', description: 'Plain-text answer grounded in the emails, with dates + quotes.' },
  },
  required: ['answer'],
  additionalProperties: false,
};

interface ThreadRow {
  email_direction: string | null;
  email_from: string | null;
  email_subject: string | null;
  content: string | null;
  email_snippet: string | null;
  created_at: string;
}

/** Build the email-chain context block for a job. Null if job missing / no emails. */
async function buildChainContext(jobId: string): Promise<string | null> {
  const jobRes = await query(
    `SELECT hh_job_number, job_name, client_name FROM jobs WHERE id = $1 AND is_deleted = false`,
    [jobId],
  );
  if (jobRes.rows.length === 0) return null;
  const j = jobRes.rows[0];

  const threadRes = await query(
    `SELECT email_direction, email_from, email_subject, content, email_snippet, created_at
       FROM interactions
      WHERE job_id = $1 AND type = 'email'
      ORDER BY created_at ASC
      LIMIT 60`,
    [jobId],
  );
  if (threadRes.rows.length === 0) return null;

  const lines: string[] = [];
  if (j.job_name) lines.push(`Job: ${j.job_name}`);
  if (j.hh_job_number) lines.push(`Job number: #${j.hh_job_number}`);
  if (j.client_name) lines.push(`Client: ${j.client_name}`);
  lines.push('');
  lines.push('Email chain (oldest first):');
  lines.push('"""');
  for (const r of threadRes.rows as ThreadRow[]) {
    const who = r.email_direction === 'outbound' ? 'Ooosh' : (r.email_from || 'Client');
    const when = r.created_at ? new Date(r.created_at).toISOString().slice(0, 10) : '';
    const bodyRaw = r.content ?? r.email_snippet ?? '';
    const body = String(bodyRaw).replace(/\s+/g, ' ').trim().slice(0, 1500);
    lines.push(`[${when}] ${who}${r.email_subject ? ` — ${r.email_subject}` : ''}`);
    lines.push(body || '(no body)');
    lines.push('');
  }
  lines.push('"""');
  // Cap the whole chain so a huge conversation doesn't blow the context.
  return lines.join('\n').slice(0, 40000);
}

/**
 * Answer a staff question about a job's email chain. Returns { answer } grounded
 * in the emails, or null when there are no emails to query. Throws if Anthropic
 * isn't configured (caller guards / 503).
 */
export async function answerCommsQuery(jobId: string, question: string): Promise<{ answer: string } | null> {
  if (!isAnthropicConfigured()) {
    throw new Error('ANTHROPIC_API_KEY not configured — cannot answer comms queries.');
  }
  const q = (question || '').trim();
  if (!q) throw new Error('No question provided');

  const [chain, quoteCtx] = await Promise.all([
    buildChainContext(jobId),
    buildQuoteVersionContext(jobId).catch(() => null),
  ]);
  if (!chain) return null;

  // Cache the (large, stable) context blocks so repeated questions on the same
  // job in a session reuse them — only the question below varies.
  const content: Array<{ type: 'text'; text: string; cache_control?: { type: 'ephemeral' } }> = [
    { type: 'text', text: chain, cache_control: { type: 'ephemeral' } },
  ];
  if (quoteCtx) content.push({ type: 'text', text: quoteCtx, cache_control: { type: 'ephemeral' } });
  content.push({ type: 'text', text: `Question: ${q}` });

  const client = getAnthropicClient();
  const response = await client.messages.create({
    model: MODEL_ID,
    max_tokens: MAX_TOKENS,
    system: [{ type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }],
    messages: [{ role: 'user', content }],
    tools: [
      {
        name: 'report_answer',
        description: 'Return the answer to the question, grounded in the emails.',
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        input_schema: SCHEMA as any,
      },
    ],
    tool_choice: { type: 'tool', name: 'report_answer' },
  });

  const toolBlock = response.content.find((b) => b.type === 'tool_use');
  if (!toolBlock || toolBlock.type !== 'tool_use') {
    throw new Error('Claude did not return an answer');
  }
  const out = toolBlock.input as { answer?: string };
  const answer = (out.answer || '').trim();
  if (!answer) throw new Error('Empty answer returned');
  return { answer };
}
