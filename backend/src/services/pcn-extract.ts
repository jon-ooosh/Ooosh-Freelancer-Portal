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
- issued_date: the date the notice itself was issued / dated / printed (often labelled "Date of Notice", "Date Issued", "Issue Date", or the letter date) — distinct from the offence date. Format YYYY-MM-DD. Null if not visible.
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
    issued_date: { type: ['string', 'null'] },
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
    'reference', 'vehicle_reg', 'offence_date', 'offence_time', 'issued_date', 'location',
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
  /**
   * The offence time exactly as printed on the notice, when it carries more
   * than the normalised HH:MM (e.g. "07:54:33"). Derived server-side, never
   * asked of the model. This is the figure quoted back to a driver or client;
   * `offence_time` is the machine-usable one. Null when the two would match.
   */
  offence_time_raw: string | null;
  issued_date: string | null;
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

// ─────────────────────────────────────────────────────────────────────────
// Deterministic post-parse repair (mirrors cost-receipt-extract.ts).
//
// The prompt ASKS for YYYY-MM-DD and 24-hour HH:MM, but nothing enforced it,
// and a value that's off-format is worse than a missing one: an <input
// type="date"|"time"> silently refuses to DISPLAY a value it can't parse while
// React still holds the bad string underneath, so staff see an empty box and
// send junk. That's what broke the driver matcher on a notice printing the
// offence time to the second — "07:54:33" + the caller's ":00" seconds suffix
// became "07:54:33:00", an invalid moment, and the 400 surfaced as the generic
// "Driver match failed" (PCN on RX21UOB / job 16261, Sep 2026).
// ─────────────────────────────────────────────────────────────────────────

/** Coerce a date the model returned into YYYY-MM-DD. UK notices are day-first. */
export function toIsoDate(raw: string): string | null {
  const s = raw.trim();
  let y: number, mo: number, d: number;
  // Already ISO-ish (also catches YYYY/MM/DD).
  let m = s.match(/^(\d{4})[-/. ](\d{1,2})[-/. ](\d{1,2})$/);
  if (m) {
    y = Number(m[1]); mo = Number(m[2]); d = Number(m[3]);
  } else {
    // Day-first: DD/MM/YYYY, DD-MM-YY, 21.08.2026 …
    m = s.match(/^(\d{1,2})[-/. ](\d{1,2})[-/. ](\d{2}|\d{4})$/);
    if (!m) return null;
    d = Number(m[1]); mo = Number(m[2]);
    y = Number(m[3]);
    if (m[3].length === 2) y += 2000;
  }
  // Round-trip so a nonsense date (31/02) is rejected rather than rolled over.
  const dt = new Date(Date.UTC(y, mo - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) return null;
  return `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

/**
 * Coerce a time the model returned into 24-hour HH:MM.
 * Tolerates seconds ("07:54:33"), dots ("07.54"), bare digits ("0754") and
 * am/pm ("7:54am"). Seconds are dropped HERE ONLY — the string as printed on
 * the notice is preserved on offence_time_raw, because that's the figure we
 * quote back to a driver or client and we don't tidy up evidence.
 */
export function toHhMm(raw: string): string | null {
  const s = raw.trim().toLowerCase();
  const ampm = /(a\.?m\.?|p\.?m\.?)\.?$/.exec(s);
  const core = (ampm ? s.slice(0, ampm.index) : s).trim();
  let h: number, mi: number;
  let m = core.match(/^(\d{1,2})[:.h ](\d{2})(?:[:.](\d{2}))?$/);
  if (m) {
    h = Number(m[1]); mi = Number(m[2]);
  } else {
    m = core.match(/^(\d{3,4})$/); // 0754 / 754
    if (!m) return null;
    const n = m[1].padStart(4, '0');
    h = Number(n.slice(0, 2)); mi = Number(n.slice(2));
  }
  if (ampm) {
    const pm = ampm[1].startsWith('p');
    if (h === 12) h = pm ? 12 : 0;
    else if (pm) h += 12;
  }
  if (h > 23 || mi > 59) return null;
  return `${String(h).padStart(2, '0')}:${String(mi).padStart(2, '0')}`;
}

/**
 * Repair the date/time fields in place. An unrepairable value is NULLED and the
 * confidence downgraded — better an obviously-empty field the human fills in
 * than an invisible bad one that fails three screens later. Whatever the model
 * read is kept verbatim in `notes` so nothing is silently discarded.
 */
function normalisePcnDateTimes(p: ExtractedPcn): void {
  const unreadable: string[] = [];
  const downgrade = () => { if (p.confidence === 'high') p.confidence = 'medium'; };

  const DATE_FIELDS = ['offence_date', 'issued_date', 'reduced_deadline', 'final_deadline'] as const;
  for (const f of DATE_FIELDS) {
    const raw = p[f];
    if (!raw) continue;
    const iso = toIsoDate(raw);
    if (iso === raw) continue;      // already clean
    if (iso) { p[f] = iso; downgrade(); continue; }
    unreadable.push(`${f.replace(/_/g, ' ')} "${raw}"`);
    p[f] = null;
    downgrade();
  }

  // Preserve exactly what the notice printed, then derive the machine-usable
  // HH:MM alongside it. Raw is only kept when it actually carries more than the
  // normalised form, so the common clean case doesn't store a duplicate.
  const rawTime = p.offence_time ? p.offence_time.trim() : null;
  const hhmm = rawTime ? toHhMm(rawTime) : null;
  p.offence_time = hhmm;
  p.offence_time_raw = rawTime && rawTime !== hhmm ? rawTime : null;
  if (rawTime && !hhmm) {
    unreadable.push(`offence time "${rawTime}"`);
    downgrade();
  }

  if (unreadable.length) {
    const note = `Could not read: ${unreadable.join('; ')} — please check against the notice.`;
    p.notes = p.notes ? `${p.notes} ${note}` : note;
  }
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
  normalisePcnDateTimes(parsed);

  return parsed;
}
