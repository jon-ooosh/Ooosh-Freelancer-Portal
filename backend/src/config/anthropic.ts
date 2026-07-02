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
