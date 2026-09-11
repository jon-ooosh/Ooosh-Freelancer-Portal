/**
 * Per-job conversation summary (Auto-Chase Phase 2, spec §7.1)
 *
 * An AI digest (Haiku) of the ingested email thread(s) on a job, for staff who
 * open the job and want the gist without reading every email. Complements the
 * timeline email-collapse (which HIDES detail) by surfacing "what's been
 * discussed + whose move is it next". That "whose move" line is also a future
 * auto-chase suppression signal (§10) — don't chase over a live conversation.
 *
 * Caching model: the summary is cached in `job_comms_summaries` (one row per
 * job) and regenerated only when new mail lands. Staleness is COMPUTED at read
 * time — compare the job's live email-interaction count / newest timestamp
 * against what the cached summary was generated from — so nothing has to touch
 * the Gmail ingest hot path. Regeneration is lazy (the next viewer of a stale
 * job triggers it), which bounds token spend to jobs someone actually looks at.
 *
 * Cheap (Haiku, ~sub-penny) and cacheable, so owning the summary + placing it
 * exactly where we want in OP beats Gmail's native card (which no API exposes).
 */
import { query } from '../config/database';
import { getAnthropicClient, isAnthropicConfigured } from '../config/anthropic';

// Spec §4: Haiku for summaries — cheap, cacheable, well within ability. Bump an
// individual call to sonnet if long rumbling threads ever lose nuance.
const MODEL_ID = 'claude-haiku-4-5';
const MAX_TOKENS = 600;

const SYSTEM_PROMPT = `You summarise the email conversation between Ooosh Tours (a music & event transport / backline / rehearsal hire company) and a client about a specific hire. The reader is Ooosh internal staff opening the job — they want the gist at a glance without reading every message.

Produce:
- headline: ONE short line stating the CURRENT state / what's outstanding — ideally "whose move is it next" (e.g. "Awaiting client's confirmation of the second van", "We owe them revised dates", "Client happy, ready to book"). This is the single most useful line.
- summary: 3-6 short sentences covering what's been discussed, any decisions or requests the client made, and — most importantly — what's still open and whose move it is next. Lead with what matters operationally.

HARD RULES:
- Ground EVERYTHING only in the emails provided. Never invent details, dates, prices, or commitments not present in the messages.
- If some message bodies have been stripped (older than the retention window), work from the snippet provided and don't flag the gap — just summarise what you can see.
- Neutral, factual, internal tone — this is a staff note, not a client-facing message. British English.
- Plain text only. No markdown, no bullet characters, no preamble like "Here's a summary".

Return ONLY the tool call.`;

const SCHEMA = {
  type: 'object' as const,
  properties: {
    headline: { type: 'string', description: 'One short line: the current state / whose move is next.' },
    summary: { type: 'string', description: 'Plain-text digest, 3-6 short sentences.' },
  },
  required: ['headline', 'summary'],
  additionalProperties: false,
};

export interface JobCommsSummary {
  headline: string | null;
  summary: string;
  emailCount: number;
  lastEmailAt: string | null;
  model: string | null;
  generatedAt: string;
}

export interface JobCommsSummaryStatus {
  /** The cached summary, or null if none generated yet. */
  summary: JobCommsSummary | null;
  /** Live email-interaction count on the job right now. */
  currentEmailCount: number;
  /** Newest email-interaction timestamp right now (ISO), or null. */
  latestEmailAt: string | null;
  /** True when there are emails to summarise (i.e. generation is possible). */
  available: boolean;
  /** True when the cache exists but new mail has landed since it was generated. */
  stale: boolean;
}

/** Live email-interaction stats for a job (drives staleness + availability). */
async function getEmailStats(jobId: string): Promise<{ count: number; lastAt: string | null }> {
  const r = await query(
    `SELECT COUNT(*)::int AS n, MAX(created_at) AS last_at
       FROM interactions
      WHERE job_id = $1 AND type = 'email'`,
    [jobId],
  );
  const row = r.rows[0] || {};
  return {
    count: Number(row.n) || 0,
    lastAt: row.last_at ? new Date(row.last_at).toISOString() : null,
  };
}

function mapRow(row: Record<string, unknown> | undefined): JobCommsSummary | null {
  if (!row) return null;
  return {
    headline: (row.headline as string | null) ?? null,
    summary: String(row.summary ?? ''),
    emailCount: Number(row.email_count) || 0,
    lastEmailAt: row.last_email_at ? new Date(row.last_email_at as string).toISOString() : null,
    model: (row.model as string | null) ?? null,
    generatedAt: new Date(row.generated_at as string).toISOString(),
  };
}

/**
 * Read the cached summary + compute staleness/availability. Does NOT generate.
 * Cheap — one small SELECT + one COUNT/MAX.
 */
export async function getJobCommsSummaryStatus(jobId: string): Promise<JobCommsSummaryStatus> {
  const [cacheRes, stats] = await Promise.all([
    query(
      `SELECT job_id, headline, summary, email_count, last_email_at, model, generated_at
         FROM job_comms_summaries WHERE job_id = $1`,
      [jobId],
    ),
    getEmailStats(jobId),
  ]);
  const cached = mapRow(cacheRes.rows[0]);

  // Stale when new mail has landed since generation. Email count is monotonic
  // (an email can't be un-ingested) so count-changed OR newer-timestamp is a
  // sound signal; a body being stripped by retention doesn't change either and
  // must NOT trigger a regen (the summary predates the strip and is the point).
  let stale = false;
  if (cached) {
    if (stats.count !== cached.emailCount) stale = true;
    else if (
      stats.lastAt &&
      (!cached.lastEmailAt || new Date(stats.lastAt) > new Date(cached.lastEmailAt))
    ) {
      stale = true;
    }
  }

  return {
    summary: cached,
    currentEmailCount: stats.count,
    latestEmailAt: stats.lastAt,
    available: stats.count > 0,
    stale,
  };
}

interface ThreadRow {
  email_direction: string | null;
  email_from: string | null;
  email_subject: string | null;
  content: string | null;
  email_snippet: string | null;
  created_at: string;
}

/** Assemble the grounding prompt: light job context + the email chain. */
async function buildUserPrompt(jobId: string): Promise<{ prompt: string; emailCount: number; lastAt: string | null } | null> {
  const jobRes = await query(
    `SELECT hh_job_number, job_name, client_name, pipeline_status
       FROM jobs WHERE id = $1 AND is_deleted = false`,
    [jobId],
  );
  if (jobRes.rows.length === 0) return null;
  const j = jobRes.rows[0];

  const threadRes = await query(
    `SELECT email_direction, email_from, email_subject, content, email_snippet, created_at
       FROM interactions
      WHERE job_id = $1 AND type = 'email'
      ORDER BY created_at ASC
      LIMIT 40`,
    [jobId],
  );
  if (threadRes.rows.length === 0) return null;

  const lines: string[] = [];
  lines.push('Summarise the email conversation for this hire.');
  lines.push('');
  if (j.job_name) lines.push(`Job: ${j.job_name}`);
  if (j.hh_job_number) lines.push(`Job number: #${j.hh_job_number}`);
  if (j.client_name) lines.push(`Client: ${j.client_name}`);
  if (j.pipeline_status) lines.push(`Pipeline status: ${j.pipeline_status}`);
  lines.push('');
  lines.push('Email chain (oldest first):');
  lines.push('"""');
  for (const r of threadRes.rows as ThreadRow[]) {
    const who = r.email_direction === 'outbound' ? 'Ooosh' : (r.email_from || 'Client');
    const when = r.created_at ? new Date(r.created_at).toISOString().slice(0, 10) : '';
    const bodyRaw = r.content ?? r.email_snippet ?? '';
    const body = String(bodyRaw).replace(/\s+/g, ' ').trim().slice(0, 1200);
    lines.push(`[${when}] ${who}${r.email_subject ? ` — ${r.email_subject}` : ''}`);
    lines.push(body || '(no body)');
    lines.push('');
  }
  lines.push('"""');

  // Cap the whole chain so a huge conversation doesn't blow the context.
  const prompt = lines.join('\n').slice(0, 24000);
  const stats = await getEmailStats(jobId);
  return { prompt, emailCount: stats.count, lastAt: stats.lastAt };
}

/**
 * Generate (or regenerate) the summary for a job and cache it. Returns null when
 * there are no emails to summarise. Throws if Anthropic isn't configured (caller
 * should guard / 503).
 */
export async function generateJobCommsSummary(
  jobId: string,
  userId?: string | null,
): Promise<JobCommsSummary | null> {
  if (!isAnthropicConfigured()) {
    throw new Error('ANTHROPIC_API_KEY not configured — cannot summarise conversations.');
  }
  const built = await buildUserPrompt(jobId);
  if (!built) return null; // job missing or no emails yet

  const client = getAnthropicClient();
  const response = await client.messages.create({
    model: MODEL_ID,
    max_tokens: MAX_TOKENS,
    system: [{ type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }],
    messages: [{ role: 'user', content: built.prompt }],
    tools: [
      {
        name: 'report_summary',
        description: 'Return the conversation summary — headline + plain-text summary.',
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        input_schema: SCHEMA as any,
      },
    ],
    tool_choice: { type: 'tool', name: 'report_summary' },
  });

  const toolBlock = response.content.find((b) => b.type === 'tool_use');
  if (!toolBlock || toolBlock.type !== 'tool_use') {
    throw new Error('Claude did not return a conversation summary');
  }
  const out = toolBlock.input as { headline?: string; summary?: string };
  const headline = (out.headline || '').trim() || null;
  const summary = (out.summary || '').trim();
  if (!summary) throw new Error('Empty conversation summary returned');

  const upsert = await query(
    `INSERT INTO job_comms_summaries
       (job_id, headline, summary, email_count, last_email_at, model, generated_at, generated_by)
     VALUES ($1, $2, $3, $4, $5, $6, NOW(), $7)
     ON CONFLICT (job_id) DO UPDATE
       SET headline = EXCLUDED.headline, summary = EXCLUDED.summary,
           email_count = EXCLUDED.email_count, last_email_at = EXCLUDED.last_email_at,
           model = EXCLUDED.model, generated_at = NOW(), generated_by = EXCLUDED.generated_by
     RETURNING job_id, headline, summary, email_count, last_email_at, model, generated_at`,
    [jobId, headline, summary, built.emailCount, built.lastAt, MODEL_ID, userId ?? null],
  );
  return mapRow(upsert.rows[0]);
}
