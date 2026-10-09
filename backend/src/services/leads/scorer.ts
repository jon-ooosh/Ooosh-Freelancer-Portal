/**
 * Phase 3 — AI scoring. Ported from `ai_filter.py`.
 *
 * Scores each detected lead 1-10 against the Ooosh ideal-client profile and
 * assigns a tier. Upgrades over the original: structured outputs (json_schema,
 * no fragile ```json``` fence-stripping) + prompt caching on the static system
 * prompt (identical across every batch → served at ~10% input cost from batch
 * 2). Model: Claude Sonnet (CLAUDE_SONNET_MODEL).
 *
 * Runs AFTER address-book matching, so a lead matched to a client carries its
 * OOOSH history (enquiries, bookings, losses and why, retros) into the prompt
 * and the score weighs it. A matched lead is re-scored once its history is in
 * view (`history_scored_at` NULL → score again).
 */
import {
  getAnthropicClient,
  isAnthropicConfigured,
  readStructuredJson,
  CLAUDE_SONNET_MODEL,
} from '../../config/anthropic';
import { query } from '../../config/database';
import { describeHistory, ClientHistory } from './history';

const MODEL_ID = CLAUDE_SONNET_MODEL;
const BATCH_SIZE = 30;
// 30 assessments plus headroom for thinking — thinking counts towards
// max_tokens on Sonnet 5.5.
const MAX_TOKENS = 12000;

const SYSTEM_PROMPT = `You are a lead qualification assistant for OOOSH Tours, a UK-based company that provides:
- Splitter van hire for touring bands
- Backline equipment rental (amps, drums, etc.)
- Rehearsal spaces

OOOSH is based in Shoreham-by-Sea, West Sussex, UK.

Your job is to assess whether touring artists are good potential leads for OOOSH's services.

## Client Tiers

**Tier 1 — Highest Value** (international act needing van + backline):
- Based in USA, Canada, Australia, New Zealand, or distant European countries (Scandinavia, Eastern Europe, etc.)
- Flying into the UK for a tour (not driving from nearby countries)
- Likely to need BOTH vehicle hire AND backline equipment
- EXCLUDE: French, Belgian, Dutch, German bands — they typically drive across with their own gear

**Tier 2 — High Value** (local band needing van hire):
- Based within approximately 70 miles of Shoreham-by-Sea, West Sussex
- This includes London, south coast (Brighton, Southampton, Portsmouth), some Home Counties
- Likely to need van hire; may collect or have delivery/collection arranged

**Tier 3 — Standard Value**:
- Any other touring band that's a plausible customer
- May need backline even if not van hire

## Genre Guidance
INCLUDE: Rock, indie, metal, punk, pop-rock, folk, folk-rock, country, jazz, soul, funk, R&B, singer-songwriter, alternative — basically any "band" music with live instruments
EXCLUDE: DJs, electronic acts (unless clearly a live band setup), comedy, theatre, spoken word, tribute/cover bands

## Size Guidance
- Sweet spot: venues 200-2,000 capacity
- Acts playing venues over ~2,500 capacity are likely too big (they travel with their own gear/production)
- Very small pub gigs (<100 capacity) are unlikely to be worthwhile leads

## Scoring (1-10)
- 9-10: Perfect fit — international touring act, right size, band music, multiple UK dates
- 7-8: Strong lead — good fit on most criteria
- 5-6: Moderate — could be a customer but not ideal
- 3-4: Weak — unlikely to be a customer but possible
- 1-2: Poor fit — wrong genre, too big, too small, or not relevant

Be decisive. If you're unsure about an artist, make your best guess rather than skipping.
If you genuinely cannot identify an artist at all, give them a score of 4 and note it in reasoning.

## Existing-client history
Some artists come with an "OOOSH history" line — what OOOSH's own records say about past enquiries with this act. When present, weigh it heavily; it is better evidence than the general profile:
- Repeat bookers (jobs booked, good retros) are the best leads there are — score them 8-10 even if the profile fit is only moderate.
- A run of lost quotes with nothing booked means another quote is unlikely to land — score down (3-5) and say why, unless the most recent enquiry was booked.
- Read the lost reasons: repeatedly lost on Price or to a Competitor is a weak lead; one-off Timing / Availability losses matter much less.
- Bookings cancelled after confirming, and retros "with issues", are warning signs.
- "Flagged Do Not Hire" → score 1 and say so in reasoning.
- "No enquiries or hires on record" is neutral — score on the profile.
- "Cold outreach from us with no reply" is NOT a loss — they never quoted or declined. At most a mild signal; don't score down for one.
History does not change origin_country or client_tier; those describe the act.
Mention the history in reasoning whenever it moved the score.
Valid skip_reason values: "tribute", "comedy", "too_big", "dj", "not_music", "electronic", "theatre", "unknown_insufficient_data".`;

const SCHEMA = {
  type: 'object' as const,
  properties: {
    assessments: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          artist_name: { type: 'string' },
          origin_country: { type: 'string' },
          is_international: { type: 'boolean' },
          client_tier: { type: 'integer', enum: [1, 2, 3] },
          relevance_score: { type: 'integer' },
          reasoning: { type: 'string' },
          skip: { type: 'boolean' },
          skip_reason: { type: ['string', 'null'] },
        },
        required: ['artist_name', 'origin_country', 'is_international', 'client_tier', 'relevance_score', 'reasoning', 'skip', 'skip_reason'],
        additionalProperties: false,
      },
    },
  },
  required: ['assessments'],
  additionalProperties: false,
};

interface Assessment {
  artist_name: string;
  origin_country: string;
  is_international: boolean;
  client_tier: number;
  relevance_score: number;
  reasoning: string;
  skip: boolean;
  skip_reason: string | null;
}

interface LeadRow {
  id: string;
  artist_name: string;
  uk_date_count: number;
  first_date: string | null;
  last_date: string | null;
  venues: string[];
  all_dates: string[];
  client_history: ClientHistory | null;
}

function buildPrompt(batch: LeadRow[]): string {
  const lines = ['Assess the following artists/tours for OOOSH lead potential:\n'];
  batch.forEach((t, i) => {
    lines.push(`--- Artist ${i + 1} ---`);
    lines.push(`Name: ${t.artist_name}`);
    lines.push(`UK dates: ${t.uk_date_count}`);
    lines.push(`Date range: ${t.first_date ?? '?'} to ${t.last_date ?? '?'}`);
    lines.push(`Venues: ${(t.venues ?? []).join(', ')}`);
    if (t.client_history) lines.push(`OOOSH history: ${describeHistory(t.client_history)}`);
    lines.push('');
  });
  lines.push(`Assess all ${batch.length} artists. Return one assessment per artist, matching artist_name exactly.`);
  return lines.join('\n');
}

async function callClaude(batch: LeadRow[]): Promise<Assessment[]> {
  const client = getAnthropicClient();
  const response = await client.messages.create({
    model: MODEL_ID,
    max_tokens: MAX_TOKENS,
    system: [{ type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }],
    messages: [{ role: 'user', content: buildPrompt(batch) }],
    // Structured outputs (json_schema) — replaced forced tool-use (400 on Sonnet 5.5).
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    output_config: { effort: 'low', format: { type: 'json_schema', schema: SCHEMA as any } } as any,
  });

  const input = readStructuredJson<{ assessments?: Assessment[] }>(response, 'leads/score');
  return input.assessments ?? [];
}

export interface ScoreSummary {
  scored: number;
  skipped: number;
  failed: number;
}

export async function scoreLeads(): Promise<ScoreSummary> {
  if (!isAnthropicConfigured()) {
    console.warn('[leads/score] ANTHROPIC_API_KEY not set — skipping scoring');
    return { scored: 0, skipped: 0, failed: 0 };
  }

  const result = await query(
    `SELECT id, artist_name, uk_date_count, first_date, last_date, venues, all_dates, client_history
       FROM leads
      WHERE status = 'new'
        AND (relevance_score IS NULL
             OR (matched_organisation_id IS NOT NULL AND history_scored_at IS NULL))
      ORDER BY uk_date_count DESC`,
  );
  const leads = result.rows as LeadRow[];
  if (leads.length === 0) return { scored: 0, skipped: 0, failed: 0 };

  const s: ScoreSummary = { scored: 0, skipped: 0, failed: 0 };

  for (let i = 0; i < leads.length; i += BATCH_SIZE) {
    const batch = leads.slice(i, i + BATCH_SIZE);
    let assessments: Assessment[] = [];
    try {
      assessments = await callClaude(batch);
    } catch (err) {
      console.error('[leads/score] batch %d failed:', i / BATCH_SIZE + 1, err);
      s.failed += batch.length;
      continue;
    }
    const byName = new Map(assessments.map((a) => [a.artist_name.toLowerCase(), a]));

    for (const lead of batch) {
      const a = byName.get(lead.artist_name.toLowerCase());
      if (!a) {
        s.failed += 1;
        continue;
      }
      const isSkip = Boolean(a.skip);
      // A matched lead's ai_summary is the tour + history line the matcher
      // wrote — keep it; only an unmatched lead takes the reasoning as summary.
      await query(
        `UPDATE leads SET
           relevance_score = $2, client_tier = $3, origin_country = $4,
           is_international = $5, reasoning = $6,
           ai_summary = CASE WHEN matched_organisation_id IS NULL THEN $6 ELSE ai_summary END,
           history_scored_at = CASE WHEN matched_organisation_id IS NOT NULL THEN NOW() ELSE history_scored_at END,
           scored_at = NOW(), updated_at = NOW(),
           status = CASE WHEN $7 THEN 'not_relevant' ELSE status END,
           status_reason = CASE WHEN $7 THEN $8 ELSE status_reason END
         WHERE id = $1`,
        [
          lead.id, a.relevance_score, a.client_tier, a.origin_country,
          a.is_international, a.reasoning, isSkip, a.skip_reason ?? 'skipped',
        ],
      );
      if (isSkip) s.skipped += 1;
      else s.scored += 1;
    }
  }

  console.log('[leads/score] done:', s);
  return s;
}
