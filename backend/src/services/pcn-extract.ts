/**
 * PCN document extraction via Claude vision.
 *
 * Backs POST /api/pcns/extract. Reads an uploaded photo/PDF of a parking or
 * traffic charge notice and returns structured JSON for the Log PCN modal to
 * pre-fill. Extraction is the PRIMARY entry path; manual entry is the fallback
 * when extraction fails or needs correcting. Ports the prompt from the legacy
 * Netlify `extract.js`.
 *
 * Mirrors services/cost-receipt-extract.ts (model, prompt caching, structured
 * output, deterministic parse fallback). Shares the Claude vision scaffolding
 * via services/document-extract.ts.
 */
import { extractDocument } from './document-extract';

const FINE_TYPES = ['private_pcn', 'council_pcn', 'police_nip', 'toll', 'other'] as const;

const SYSTEM_PROMPT = `You are extracting structured data from UK parking / traffic charge notices for a vehicle-hire company. Documents include private parking charge notices (PCNs), local-authority council PCNs, police Notices of Intended Prosecution (NIPs), toll / congestion / clean-air-zone charges (Dart Charge, TfL, CAZ), and rental-company pass-through letters (e.g. Enterprise).

Return ONLY valid JSON matching the supplied schema. No markdown, no commentary, no code fences.

fine_type — classify the document:
  private_pcn  — private parking company charge notice
  council_pcn  — local authority civil enforcement PCN
  police_nip   — police Notice of Intended Prosecution (speeding, red light, etc.)
  toll         — unpaid toll / congestion / clean-air / Dart charge
  other        — anything else (use when genuinely unclear)

Extraction rules:
- reference: the PCN / ticket / notice reference number exactly as printed.
- vehicle_reg: the vehicle registration, UPPERCASE with no spaces (e.g. "RX22SWN").
- offence_date: format YYYY-MM-DD. UK dates are usually DD/MM/YYYY. Null if not visible.
- offence_time: 24-hour HH:MM. Null if not visible.
- location: where the offence occurred (street, car park, zone).
- issuing_authority: who issued the notice (council name, parking company, police force, toll operator). For a rental pass-through, use the ORIGINAL issuer, not the rental company.
- fine_amount: the full charge in pounds (number only, no symbol). Null if not visible.
- reduced_amount: the discounted early-payment amount in pounds, if shown. Null otherwise.
- reduced_deadline / final_deadline: format YYYY-MM-DD. final_deadline is the last date to pay or appeal. Null if not visible.
- offence_description: a short summary of the alleged contravention as printed.
- confidence: "high" when every key field reads cleanly; "medium" with some guessing; "low" on poor image quality or non-PCN input.
- notes: any uncertainties or things a human should double-check. Empty string if none.
Use null for any field you genuinely cannot read.`;

const SCHEMA = {
  type: 'object' as const,
  properties: {
    reference: { type: ['string', 'null'] },
    vehicle_reg: { type: ['string', 'null'] },
    offence_date: { type: ['string', 'null'] },
    offence_time: { type: ['string', 'null'] },
    location: { type: ['string', 'null'] },
    issuing_authority: { type: ['string', 'null'] },
    offence_description: { type: ['string', 'null'] },
    fine_amount: { type: ['number', 'null'] },
    reduced_amount: { type: ['number', 'null'] },
    reduced_deadline: { type: ['string', 'null'] },
    final_deadline: { type: ['string', 'null'] },
    fine_type: { type: 'string', enum: [...FINE_TYPES] },
    confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
    notes: { type: ['string', 'null'] },
  },
  required: [
    'reference', 'vehicle_reg', 'offence_date', 'offence_time', 'location',
    'issuing_authority', 'offence_description', 'fine_amount', 'reduced_amount',
    'reduced_deadline', 'final_deadline', 'fine_type', 'confidence', 'notes',
  ],
  additionalProperties: false,
};

export interface ExtractedPcn {
  reference: string | null;
  vehicle_reg: string | null;
  offence_date: string | null;
  offence_time: string | null;
  location: string | null;
  issuing_authority: string | null;
  offence_description: string | null;
  fine_amount: number | null;
  reduced_amount: number | null;
  reduced_deadline: string | null;
  final_deadline: string | null;
  fine_type: typeof FINE_TYPES[number];
  confidence: 'high' | 'medium' | 'low';
  notes: string | null;
}

export async function extractPcn(
  files: { buffer: Buffer; mimeType: string }[],
): Promise<ExtractedPcn> {
  // Feed every uploaded page (front + back of a paper notice, or a multi-page
  // PDF) into one call so the model reads them together. The structured schema
  // only captures the defined fields — payment instructions on the back page
  // are retained as a stored document + attached to client emails, NOT pulled
  // into a field we'd have to stand behind.
  const parsed = await extractDocument<ExtractedPcn>({
    files,
    systemPrompt: SYSTEM_PROMPT,
    schema: SCHEMA,
    userInstruction: 'Extract the details from this charge notice (pages may include the front and back of one notice).',
    logTag: 'pcn-extract',
  });

  // Normalise the reg the same way the matcher does (uppercase, no spaces).
  if (parsed.vehicle_reg) parsed.vehicle_reg = parsed.vehicle_reg.toUpperCase().replace(/\s/g, '');
  if (!FINE_TYPES.includes(parsed.fine_type)) parsed.fine_type = 'other';

  return parsed;
}
