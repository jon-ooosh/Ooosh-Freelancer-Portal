/**
 * Anthropic Claude API Configuration
 *
 * Singleton client for the Claude vision-extraction flow (and any future Claude
 * calls in OP). Inert when ANTHROPIC_API_KEY isn't set — `isAnthropicConfigured()`
 * lets callers degrade gracefully (the /api/costs/extract endpoint returns 503
 * cleanly rather than throwing).
 *
 * Required env var:
 *   ANTHROPIC_API_KEY — server-side Anthropic API key
 *
 * Mirrors the Stripe/Xero config pattern.
 */
import Anthropic from '@anthropic-ai/sdk';
import dotenv from 'dotenv';

dotenv.config({ quiet: true });

/**
 * THE model IDs OP uses — change a model here, not in the services.
 *
 * Every Claude caller imports one of these, so a model upgrade is a one-line
 * edit (plus reading the migration notes for any breaking API changes — e.g.
 * Sonnet 5.5 rejects forced `tool_choice`, which is why the callers use
 * structured outputs via `readStructuredJson` below).
 *
 *   CLAUDE_SONNET_MODEL — reasoning / drafting / matching (chase drafts, comms
 *                         Q&A, backline matcher, lead scoring + research,
 *                         vehicle forecast)
 *   CLAUDE_HAIKU_MODEL  — high-volume document extraction + comms summaries
 */
export const CLAUDE_SONNET_MODEL = 'claude-sonnet-5-5';
export const CLAUDE_HAIKU_MODEL = 'claude-haiku-4-5';

let client: Anthropic | null = null;

export function getAnthropicClient(): Anthropic {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error(
      'ANTHROPIC_API_KEY is not set. Add it to backend/.env on the server. ' +
        'AI receipt extraction cannot proceed without it.',
    );
  }
  if (!client) {
    client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  }
  return client;
}

export function isAnthropicConfigured(): boolean {
  return Boolean(process.env.ANTHROPIC_API_KEY);
}

/**
 * Read a structured-output (`output_config.format` json_schema) response as T.
 *
 * Checks the stop reason FIRST — a safety refusal or a truncated reply can't be
 * trusted to match the schema, and JSON.parse on either fails cryptically.
 * Finds the text block by type (a Sonnet 5.5 reply can open with a `thinking`
 * block), then parses with a brace-extraction fallback. `label` prefixes the
 * error messages and the cache telemetry line.
 */
export function readStructuredJson<T>(response: Anthropic.Message, label: string): T {
  if (response.stop_reason === 'refusal') {
    throw new Error(`[${label}] Claude declined this request (safety refusal) — no result`);
  }
  if (response.stop_reason === 'max_tokens') {
    throw new Error(`[${label}] Claude hit the output token limit — the reply was truncated. Raise max_tokens.`);
  }
  const textBlock = response.content.find((b) => b.type === 'text');
  if (!textBlock || textBlock.type !== 'text') {
    throw new Error(`[${label}] Claude returned no text content`);
  }
  if (response.usage?.cache_read_input_tokens) {
    console.log(`[${label}] cache read: ${response.usage.cache_read_input_tokens} tokens`);
  }
  try {
    return JSON.parse(textBlock.text) as T;
  } catch {
    // Structured outputs make this near-unreachable, but recover a fenced object on a flake.
    const m = textBlock.text.match(/\{[\s\S]*\}/);
    if (!m) throw new Error(`[${label}] Claude returned unparseable response`);
    return JSON.parse(m[0]) as T;
  }
}
