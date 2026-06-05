/**
 * Cost receipt extraction via Claude vision.
 *
 * Backs POST /api/costs/extract. Reads an uploaded image or PDF receipt and
 * returns structured JSON (supplier, date, gross/VAT/net, description, Xero
 * category code, confidence) for the capture modal to pre-fill. Reduces both
 * manual data entry and misclassification risk that surfaced in live testing.
 *
 * Model: Claude Haiku 4.5 — fast, ~£0.001/receipt at current rates, and the
 * structured-output + vision combo gives reliable JSON.
 *
 * Prompt caching: the system prompt + category list is byte-identical across
 * every call (no timestamps, no user-specific text), so we put one
 * cache_control breakpoint on it. After the first request it serves from
 * cache at ~10% input cost.
 *
 * Supplier canonicalisation: when the extracted name resembles an existing
 * Xero contact (case-insensitive substring match), we replace it with Xero's
 * canonical form — stops duplicate suppliers from typo variants. Returned
 * alongside `supplier_matched: {from, to}` so the UI can show what changed.
 */
import { getAnthropicClient, isAnthropicConfigured } from '../config/anthropic';
import { xeroBroker } from './xero-broker';

const MODEL_ID = 'claude-haiku-4-5';
const MAX_TOKENS = 1024;

// Xero account codes the OP capture modal exposes — keep in step with
// COST_CATEGORIES in frontend/src/components/CostCaptureModal.tsx.
const CATEGORY_CODES = [
  '320', '325', '326', '399', '406', '409', '410', '411',
  '473', '764', '310', '425', '494', '710', '720', '429',
] as const;

const SYSTEM_PROMPT = `You are extracting structured cost data from UK receipts and invoices for accounting at a music tour-support company (vehicles, backline equipment, crew).

Return ONLY valid JSON matching the supplied schema. No markdown, no commentary, no code fences.

Allowed category_code values (pick the best fit from the receipt's contents, or null if unclear):
  320 — Freelance crew invoices (engineers, drivers, techs invoicing their time/fees)
  325 — Travel: taxis, trains, buses, on-trip parking (crew getting around)
  326 — Sub-hire of equipment from other companies
  399 — Parking fines / PCNs (penalty tickets, not normal parking)
  406 — Vehicle servicing & upkeep (oils, tyres, MOT, scheduled service, parts for upkeep)
  409 — Vehicle repairs (bodywork, glass, mechanical fixes, accident repairs)
  410 — Fuel (petrol, diesel, road diesel)
  411 — Parking (everyday parking charges — NOT fines)
  473 — Equipment repairs & spares (instrument repairs, cables, spare parts for backline gear)
  764 — New equipment (backline, staging, capex purchases of new gear)
  310 — Shop stock (items for resale)
  425 — Postage & couriers
  494 — Office supplies (milk, cleaning products, stationery, kitchen)
  710 — Office equipment (desks, chairs, lights, non-IT)
  720 — Computer equipment (laptops, monitors, keyboards, peripherals)
  429 — Anything else not covered above

Extraction rules:
- Amounts are pounds: parse "£12.50" → 12.50. Use null when not visible.
- VAT: ONLY treat the cost as VAT-bearing if the document explicitly shows a VAT amount or a VAT line/number. Many UK sole-traders and freelancers are not VAT-registered and their invoices show NO VAT — for those, set amount_vat to 0, amount_net equal to amount_gross, and vat_treatment to "no_vat". When a VAT amount IS shown, set vat_treatment to "standard" and return the actual gross/net/vat from the document. NEVER invent or assume 20% VAT that isn't printed.
- If only a gross total is visible and no VAT is shown, treat it as no_vat (net = gross, vat = 0).
- supplier: the merchant's canonical company name as printed on the receipt header (e.g. "TTS360 Ltd", "Shell U.K. Limited", "Halfords Autocentres") — NOT the tagline, address line, or "thank you" line. Strip trailing punctuation.
- cost_date: format YYYY-MM-DD. Receipt dates are usually DD/MM/YYYY (UK). Null if not visible.
- job_number: if the document clearly references an Ooosh job/booking number (e.g. "Job 15291", "#15291", "Attention: Ooosh Tours (#15291)", "your ref 15291"), return JUST the digits as a string. Otherwise null. Do NOT guess from invoice numbers, phone numbers, postcodes, dates, or amounts — only a clear job/booking reference.
- description: 1-2 line summary of what was bought (e.g. "Brake pads and disc rotors", "5 packs of D'Addario strings").
- confidence: "high" when every key field reads cleanly; "medium" with some guessing on amounts or supplier; "low" on poor image quality or non-receipt input.
- Vehicle work: prefer 406 for routine maintenance, 409 for accident/breakage repairs.
- Fuel always 410. Parking always 411 (or 399 for fines).
- Crew invoices (named individual sending an invoice for their services) → 320.`;

const SCHEMA = {
  type: 'object' as const,
  properties: {
    supplier: { type: ['string', 'null'] },
    cost_date: { type: ['string', 'null'] },
    amount_gross: { type: ['number', 'null'] },
    amount_vat: { type: ['number', 'null'] },
    amount_net: { type: ['number', 'null'] },
    vat_treatment: { type: 'string', enum: ['standard', 'no_vat'] },
    job_number: { type: ['string', 'null'] },
    description: { type: ['string', 'null'] },
    category_code: {
      anyOf: [
        { type: 'string', enum: [...CATEGORY_CODES] },
        { type: 'null' },
      ],
    },
    confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
  },
  required: [
    'supplier', 'cost_date', 'amount_gross', 'amount_vat', 'amount_net',
    'vat_treatment', 'job_number', 'description', 'category_code', 'confidence',
  ],
  additionalProperties: false,
};

export interface ExtractedReceipt {
  supplier: string | null;
  cost_date: string | null;
  amount_gross: number | null;
  amount_vat: number | null;
  amount_net: number | null;
  vat_treatment: 'standard' | 'no_vat';
  job_number: string | null;
  description: string | null;
  category_code: string | null;
  confidence: 'high' | 'medium' | 'low';
  /** Set when we canonicalised supplier against an existing Xero contact. */
  supplier_matched?: { from: string; to: string };
}

const SUPPORTED_IMAGE_TYPES = new Set([
  'image/jpeg', 'image/png', 'image/gif', 'image/webp',
]);

function buildContentBlock(mimeType: string, base64: string) {
  if (mimeType === 'application/pdf') {
    return {
      type: 'document' as const,
      source: {
        type: 'base64' as const,
        media_type: 'application/pdf' as const,
        data: base64,
      },
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

/**
 * Try to canonicalise the extracted supplier name against Xero contacts.
 * Case-insensitive substring match either way ("TTS 360" vs "TTS360 Ltd") —
 * fine for typo-class duplicates without over-matching. Fails silently if
 * Xero is unreachable.
 */
async function canonicaliseSupplier(
  extracted: string,
): Promise<{ canonical: string; matched: boolean }> {
  try {
    const contacts = await xeroBroker.searchContacts(extracted, 5);
    const lower = extracted.toLowerCase();
    const hit = contacts.find((c) => {
      const cl = c.Name.toLowerCase();
      return cl === lower || cl.includes(lower) || lower.includes(cl);
    });
    if (hit && hit.Name !== extracted) {
      return { canonical: hit.Name, matched: true };
    }
  } catch {
    /* Xero down — keep extracted name */
  }
  return { canonical: extracted, matched: false };
}

export async function extractReceipt(buffer: Buffer, mimeType: string): Promise<ExtractedReceipt> {
  if (!isAnthropicConfigured()) {
    throw new Error('ANTHROPIC_API_KEY not configured');
  }
  const client = getAnthropicClient();
  const contentBlock = buildContentBlock(mimeType, buffer.toString('base64'));

  const response = await client.messages.create({
    model: MODEL_ID,
    max_tokens: MAX_TOKENS,
    // One cache_control breakpoint on the system prompt — its bytes are
    // identical across every call so this hits the cache from request 2.
    system: [
      {
        type: 'text',
        text: SYSTEM_PROMPT,
        cache_control: { type: 'ephemeral' },
      },
    ],
    messages: [
      {
        role: 'user',
        content: [
          contentBlock,
          { type: 'text', text: 'Extract the details from this receipt.' },
        ],
      },
    ],
    // Structured-output constraint: response will be valid JSON matching SCHEMA.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    output_config: { format: { type: 'json_schema', schema: SCHEMA as any } } as any,
  });

  // Pull the JSON text out of the response content blocks.
  const textBlock = response.content.find((b) => b.type === 'text');
  if (!textBlock || textBlock.type !== 'text') {
    throw new Error('Claude returned no text content');
  }
  let parsed: ExtractedReceipt;
  try {
    parsed = JSON.parse(textBlock.text);
  } catch {
    // Structured outputs should make this unreachable, but if Claude wraps in
    // a code fence on a flake, dig out the JSON object.
    const m = textBlock.text.match(/\{[\s\S]*\}/);
    if (!m) throw new Error('Claude returned unparseable response');
    parsed = JSON.parse(m[0]);
  }

  // Xero supplier canonicalisation — non-blocking, best-effort.
  if (parsed.supplier && parsed.supplier.trim()) {
    const { canonical, matched } = await canonicaliseSupplier(parsed.supplier.trim());
    if (matched) {
      parsed.supplier_matched = { from: parsed.supplier, to: canonical };
      parsed.supplier = canonical;
    }
  }

  // Telemetry — cache hits should appear from request 2 onwards.
  if (response.usage?.cache_read_input_tokens) {
    console.log(
      `[receipt-extract] cache read: ${response.usage.cache_read_input_tokens} tokens, ` +
        `confidence: ${parsed.confidence}`,
    );
  }

  return parsed;
}
