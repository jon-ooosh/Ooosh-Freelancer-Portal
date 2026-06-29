/**
 * Shared document-extraction primitive (Claude vision → structured JSON).
 *
 * The common scaffolding behind every "upload a document → Claude extracts
 * fields → typed JSON" flow: the Anthropic call with a prompt-cached system
 * prompt, the json_schema structured-output constraint, image/PDF content-block
 * building (single or multi-page), JSON parse with a code-fence fallback, and
 * cache telemetry. Per-document prompt, schema, instruction and post-processing
 * stay in the calling service.
 *
 * Consumers:
 *   - services/pcn-extract.ts          (parking/traffic charge notices, multi-page)
 *   - services/cost-receipt-extract.ts (supplier receipts/invoices, single page)
 *   - future: vehicle service-record extractor (same shape — see CLAUDE.md)
 *
 * Model defaults to Claude Haiku 4.5 (fast, ~£0.001/doc, reliable structured
 * output). Prompt caching: the system prompt is byte-identical across calls of a
 * given consumer, so one cache_control breakpoint serves it at ~10% input cost
 * from request 2 onwards.
 */
import { getAnthropicClient, isAnthropicConfigured } from '../config/anthropic';

const DEFAULT_MODEL = 'claude-haiku-4-5';
const DEFAULT_MAX_TOKENS = 1024;

const SUPPORTED_IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);

export interface ExtractFile {
  buffer: Buffer;
  mimeType: string;
}

/** Build an Anthropic content block for one image or PDF page. */
function buildContentBlock(mimeType: string, base64: string) {
  if (mimeType === 'application/pdf') {
    return {
      type: 'document' as const,
      source: { type: 'base64' as const, media_type: 'application/pdf' as const, data: base64 },
    };
  }
  if (SUPPORTED_IMAGE_TYPES.has(mimeType)) {
    return {
      type: 'image' as const,
      source: {
        type: 'base64' as const,
        media_type: mimeType as 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp',
        data: base64,
      },
    };
  }
  throw new Error(`Unsupported file type: ${mimeType} (expected image/jpeg|png|gif|webp or application/pdf)`);
}

export interface ExtractDocumentOpts {
  /** One file, or several pages fed into a single call (e.g. front + back). */
  files: ExtractFile | ExtractFile[];
  systemPrompt: string;
  /** JSON schema the response is constrained to (structured outputs). */
  schema: object;
  /** The user-turn instruction accompanying the document(s). */
  userInstruction: string;
  model?: string;
  maxTokens?: number;
  /** Optional tag for cache-hit telemetry logging. */
  logTag?: string;
}

/**
 * Run a vision extraction and return the parsed JSON typed as T. Throws
 * 'ANTHROPIC_API_KEY not configured' when the client isn't set up (callers
 * surface this as a graceful 503 / "enter manually" path). No post-processing —
 * the caller owns field repair / canonicalisation.
 */
export async function extractDocument<T>(opts: ExtractDocumentOpts): Promise<T> {
  if (!isAnthropicConfigured()) {
    throw new Error('ANTHROPIC_API_KEY not configured');
  }
  const files = Array.isArray(opts.files) ? opts.files : [opts.files];
  if (!files.length) throw new Error('No files provided for extraction');

  const client = getAnthropicClient();
  const contentBlocks = files.map((f) => buildContentBlock(f.mimeType, f.buffer.toString('base64')));

  const response = await client.messages.create({
    model: opts.model ?? DEFAULT_MODEL,
    max_tokens: opts.maxTokens ?? DEFAULT_MAX_TOKENS,
    // One cache_control breakpoint on the system prompt — identical bytes across
    // calls, so it serves from cache from request 2.
    system: [{ type: 'text', text: opts.systemPrompt, cache_control: { type: 'ephemeral' } }],
    messages: [
      {
        role: 'user',
        content: [...contentBlocks, { type: 'text', text: opts.userInstruction }],
      },
    ],
    // Structured-output constraint: response is valid JSON matching the schema.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    output_config: { format: { type: 'json_schema', schema: opts.schema as any } } as any,
  });

  const textBlock = response.content.find((b) => b.type === 'text');
  if (!textBlock || textBlock.type !== 'text') {
    throw new Error('Claude returned no text content');
  }
  let parsed: T;
  try {
    parsed = JSON.parse(textBlock.text);
  } catch {
    // Structured outputs make this near-unreachable, but recover a fenced object
    // on a flake.
    const m = textBlock.text.match(/\{[\s\S]*\}/);
    if (!m) throw new Error('Claude returned unparseable response');
    parsed = JSON.parse(m[0]);
  }

  if (opts.logTag && response.usage?.cache_read_input_tokens) {
    console.log(`[${opts.logTag}] cache read: ${response.usage.cache_read_input_tokens} tokens`);
  }

  return parsed;
}
