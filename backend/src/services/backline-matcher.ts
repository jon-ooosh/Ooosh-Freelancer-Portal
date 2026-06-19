/**
 * Backline Matcher — Claude equipment-matching call.
 *
 * Ported from `alternative-hirehop-stock/netlify/functions/find-alternative.js`
 * (Jun 2026) when the matcher moved into OP. Upgrades over the original:
 *   - Structured JSON output (have-it verdict + ranked alternatives with stock
 *     ids) instead of a markdown blob, so the UI renders proper cards with
 *     availability pills + HireHop deep-links.
 *   - Prompt caching on the system prompt (its bytes are identical across every
 *     call) — serves from cache at ~10% input cost from request 2.
 *
 * The well-tuned domain prompt (FT/RT/BD abbreviations, "different model number
 * ≠ variant" precision rules) is ported verbatim — it's the matcher's value.
 *
 * Model: Claude Sonnet 4.6 — the original used Sonnet; the matching is
 * knowledge-heavy over a big stock list, where Sonnet is the right balance.
 */
import { getAnthropicClient, isAnthropicConfigured } from '../config/anthropic';
import type { BacklineStockItem } from './backline-stock';

const MODEL_ID = 'claude-sonnet-4-6';
const MAX_TOKENS = 1500;

const SYSTEM_PROMPT = `You are an equipment specialist for Ooosh Tours, a music and event equipment hire company. Your job is to help staff find alternatives when clients request items that may not be in stock.

You have deep knowledge of musical and event equipment - amps, keyboards, drums, guitars, PA systems, staging, lighting, etc.

IMPORTANT - Common abbreviations in our stock:
- "FT" = Floor Tom (e.g., "16" FT" means "16-inch Floor Tom")
- "RT" = Rack Tom (e.g., "12" RT" means "12-inch Rack Tom")
- "TT" = Tom Tom
- "BD" = Bass Drum / Kick Drum
- "HH" = Hi-Hat
When someone asks for a "floor tom", match items with "FT" in the name. Same for rack toms and "RT", etc.

When deciding the have_it verdict - BE PRECISE about model numbers:
- "exact" = We have this EXACT model (e.g., asked for "GK 1001RB", we have "GK 1001RB")
- "variant" = Same model but trivial difference like colour/finish (e.g., asked for "DW Collector's 16" in natural finish, we have it in Black Ice Sparkle)
- "no" = We don't have this specific model, even if we have OTHER models from the same brand/series

IMPORTANT: Different model NUMBERS are different products, not variants!
- Asked for "GK 800RB" but we only have "GK 1001RB" = "no" (different model, but recommend the 1001RB as an alternative)
- Asked for "Nord Stage 4" but we only have "Nord Stage 3" = "no" (different generation)
- Asked for "Marshall JCM800" but we have "Marshall JCM900" = "no" (different amp)

When recommending alternatives, consider:
- Type and purpose (most important - match the use case)
- Features and capabilities
- Size/scale appropriateness
- If availability is provided, prioritise items that are actually available for the job dates.

For each alternative you recommend, return the stock_id from the supplied list so the system can link it. Use the EXACT id given.

Be honest - if nothing is truly similar, set have_it to "no" and return few or no alternatives rather than forcing bad matches. Don't invent stock that isn't in the list.

Return ONLY valid JSON matching the supplied schema. No markdown, no commentary, no code fences.`;

const SCHEMA = {
  type: 'object' as const,
  properties: {
    have_it: { type: 'string', enum: ['exact', 'variant', 'no'] },
    headline: { type: 'string' },
    what_it_is: { type: 'string' },
    alternatives: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          stock_id: { type: ['integer', 'null'] },
          name: { type: 'string' },
          qty: { type: ['integer', 'null'] },
          why: { type: 'string' },
          key_difference: { type: ['string', 'null'] },
        },
        required: ['stock_id', 'name', 'qty', 'why', 'key_difference'],
        additionalProperties: false,
      },
    },
  },
  required: ['have_it', 'headline', 'what_it_is', 'alternatives'],
  additionalProperties: false,
};

export interface MatcherAlternative {
  stock_id: number | null;
  name: string;
  qty: number | null;
  why: string;
  key_difference: string | null;
  /** Filled in by the route from the availability check (null = not checked). */
  available?: number | null;
}

export interface MatcherResult {
  have_it: 'exact' | 'variant' | 'no';
  headline: string;
  what_it_is: string;
  alternatives: MatcherAlternative[];
}

/**
 * Ask Claude for equipment recommendations. Availability (per stock id) is
 * optional — when provided, the markers are folded into the stock list so
 * Claude can prioritise available items.
 */
export async function matchEquipment(
  request: string,
  stock: BacklineStockItem[],
  availability: Record<number, number> = {},
): Promise<MatcherResult> {
  if (!isAnthropicConfigured()) {
    throw new Error('ANTHROPIC_API_KEY not configured');
  }

  const hasAvailability = Object.keys(availability).length > 0;

  const stockList = stock
    .map((item) => {
      let entry = `${item.id}: ${item.name} [${item.category}] (qty:${item.quantity}`;
      if (hasAvailability && availability[item.id] !== undefined) {
        const avail = availability[item.id];
        if (avail <= 0) entry += ', UNAVAILABLE';
        else if (avail < item.quantity) entry += `, avail:${avail}`;
        else entry += ', available';
      }
      entry += ')';
      return entry;
    })
    .join('\n');

  const userPrompt = `A client has requested: "${request}"

Here is our current backline hire stock (format: id: Name [Category] (qty:X${hasAvailability ? ', availability' : ''})):

${stockList}

Decide whether we have the exact item (or a close variant), give a punchy top recommendation, briefly describe what the requested item is, and list 2-4 alternatives with the stock_id of each from the list above.${hasAvailability ? ' Prioritise items marked available over UNAVAILABLE ones.' : ''}`;

  const client = getAnthropicClient();
  const response = await client.messages.create({
    model: MODEL_ID,
    max_tokens: MAX_TOKENS,
    system: [
      { type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } },
    ],
    messages: [{ role: 'user', content: userPrompt }],
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    output_config: { format: { type: 'json_schema', schema: SCHEMA as any } } as any,
  });

  const textBlock = response.content.find((b) => b.type === 'text');
  if (!textBlock || textBlock.type !== 'text') {
    throw new Error('Claude returned no text content');
  }

  let parsed: MatcherResult;
  try {
    parsed = JSON.parse(textBlock.text);
  } catch {
    const m = textBlock.text.match(/\{[\s\S]*\}/);
    if (!m) throw new Error('Claude returned unparseable response');
    parsed = JSON.parse(m[0]);
  }

  if (response.usage?.cache_read_input_tokens) {
    console.log(
      `[Backline matcher] cache read: ${response.usage.cache_read_input_tokens} tokens`,
    );
  }

  return parsed;
}
