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
import { extractDocument } from './document-extract';
import { xeroBroker } from './xero-broker';

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
- amount_gross is the TOTAL the customer actually pays, INCLUDING VAT — usually labelled "Total", "Amount due", "Total inc VAT", or the figure on the payment line. It is the LARGEST of the three amounts.
- amount_net is the pre-VAT figure — usually labelled "Subtotal", "Net", or "Total ex VAT". NEVER put the subtotal/net figure in amount_gross when a larger VAT-inclusive total is printed.
- Always check the arithmetic before answering: amount_net + amount_vat must equal amount_gross. If your figures don't add up, re-read the document.
- VAT: ONLY treat the cost as VAT-bearing if the document explicitly shows a VAT amount or a VAT line/number. Many UK sole-traders and freelancers are not VAT-registered and their invoices show NO VAT — for those, set amount_vat to 0, amount_net equal to amount_gross, and vat_treatment to "no_vat". When a VAT amount IS shown, set vat_treatment to "standard" and return the actual gross/net/vat from the document. NEVER invent or assume 20% VAT that isn't printed.
- If only a gross total is visible and no VAT is shown, treat it as no_vat (net = gross, vat = 0).
- invoice_number: the supplier's invoice/receipt reference as printed (e.g. "INV-10472", "138106", "SI-2024-0091") — usually labelled "Invoice No", "Invoice #", "Reference", "Receipt No" or similar, often near the date in the header. Return it exactly as printed (keep any prefix). Null when there genuinely isn't one (common on fuel/till receipts). Do NOT use the order number, customer number, account number, or our job number.
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
    invoice_number: { type: ['string', 'null'] },
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
    'vat_treatment', 'invoice_number', 'job_number', 'description', 'category_code', 'confidence',
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
  invoice_number: string | null;
  job_number: string | null;
  description: string | null;
  category_code: string | null;
  confidence: 'high' | 'medium' | 'low';
  /** Set when we canonicalised supplier against an existing Xero contact. */
  supplier_matched?: { from: string; to: string };
}

const round2 = (n: number) => Math.round(n * 100) / 100;
const close = (a: number, b: number) => Math.abs(a - b) <= 0.02;

/**
 * Arithmetic sanity check on the extracted amounts: net + VAT must equal gross.
 * The model occasionally puts the subtotal in amount_gross (the gross-vs-net
 * mix-up staff reported) — repair the obvious cases deterministically and
 * downgrade confidence on anything that needed real correction, so the modal's
 * banner prompts the user to double-check.
 */
function normaliseAmounts(p: ExtractedReceipt): void {
  const downgrade = () => {
    if (p.confidence === 'high') p.confidence = 'medium';
  };

  // No VAT → net mirrors gross (fill whichever side is missing).
  if (!p.amount_vat || p.amount_vat <= 0) {
    p.amount_vat = p.amount_vat ?? 0;
    if (p.amount_gross != null && p.amount_net == null) p.amount_net = p.amount_gross;
    else if (p.amount_net != null && p.amount_gross == null) p.amount_gross = p.amount_net;
    else if (p.amount_gross != null && p.amount_net != null && !close(p.amount_gross, p.amount_net)) {
      // VAT-free but gross ≠ net — trust the larger figure as the total paid.
      const total = Math.max(p.amount_gross, p.amount_net);
      p.amount_gross = total;
      p.amount_net = total;
      downgrade();
    }
    return;
  }

  const vat = p.amount_vat;
  // Fill a missing side from the other two.
  if (p.amount_gross == null && p.amount_net != null) { p.amount_gross = round2(p.amount_net + vat); return; }
  if (p.amount_net == null && p.amount_gross != null) { p.amount_net = round2(p.amount_gross - vat); return; }
  if (p.amount_gross == null || p.amount_net == null) return;

  if (close(p.amount_net + vat, p.amount_gross)) return; // adds up — done

  // gross + VAT = "net" → the two are simply swapped.
  if (close(p.amount_gross + vat, p.amount_net)) {
    const g = p.amount_net;
    p.amount_net = p.amount_gross;
    p.amount_gross = g;
    downgrade();
    return;
  }
  // gross == net but VAT > 0 → model returned the same figure twice; decide
  // which it is: if VAT ≈ 20% of the figure, it's the net (gross = net + VAT),
  // otherwise treat it as the inc-VAT total (net = gross − VAT).
  if (close(p.amount_gross, p.amount_net)) {
    if (close(vat, round2(p.amount_net * 0.2))) p.amount_gross = round2(p.amount_net + vat);
    else p.amount_net = round2(p.amount_gross - vat);
    downgrade();
    return;
  }
  // Anything else: keep the gross (the figure that drives payment) and VAT,
  // recompute net so the row at least balances.
  p.amount_net = round2(p.amount_gross - vat);
  downgrade();
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
  const parsed = await extractDocument<ExtractedReceipt>({
    files: { buffer, mimeType },
    systemPrompt: SYSTEM_PROMPT,
    schema: SCHEMA,
    userInstruction: 'Extract the details from this receipt.',
    logTag: 'receipt-extract',
  });

  // Deterministic repair of gross/net/VAT arithmetic (downgrades confidence
  // when a correction was needed so the modal flags it for a human check).
  normaliseAmounts(parsed);

  // Xero supplier canonicalisation — non-blocking, best-effort.
  if (parsed.supplier && parsed.supplier.trim()) {
    const { canonical, matched } = await canonicaliseSupplier(parsed.supplier.trim());
    if (matched) {
      parsed.supplier_matched = { from: parsed.supplier, to: canonical };
      parsed.supplier = canonical;
    }
  }

  return parsed;
}
