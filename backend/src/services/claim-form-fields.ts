/**
 * The possible-claim form — THE field catalogue (docs/INCIDENT-CLAIMS-SPEC.md §7).
 *
 * One definition read by three things, so they can't drift:
 *   - the staff form on the case page (frontend, via the `@claimform` alias —
 *     same arrangement as `@calc` for the transport calculator)
 *   - the broker PDF (services/claim-pdf.ts)
 *   - the client form (Phase 2)
 *
 * Answers live in incident_claims.form_data as { [section.key]: { [field.key]: value } }.
 * A `list` section stores an ARRAY of rows instead.
 *
 * PURE — no imports. The frontend bundles this file directly.
 *
 * NOT here, deliberately:
 *   - the insured block (system_settings 'claims_*' — never shown to clients)
 *   - vehicle make / model / CC / reg (fleet_vehicles)
 *   - driver name / DOB / address / licence (drivers — joined in the broker PDF
 *     only, never sent client-side: spec D6)
 */

export type ClaimFieldKind = 'text' | 'textarea' | 'yesno' | 'choice' | 'multi' | 'date' | 'money';

export interface ClaimFieldDef {
  key: string;
  label: string;
  kind: ClaimFieldKind;
  options?: readonly string[];
  /**
   * Only shown (and only printed) when another field in the SAME section/row has
   * this value — or, for a multi-choice field, includes it.
   */
  showIf?: { key: string; equals: string | boolean };
  placeholder?: string;
  /** Pre-filled value for a brand-new case. */
  defaultValue?: string | boolean;
  /** Needed (while shown) before the client form counts the section as done. */
  required?: boolean;
  /** Needed when any of these yes/no fields in the same section is Yes. */
  requiredWhenAnyYes?: readonly string[];
  /** Shortest acceptable text when required. */
  minLength?: number;
  /** Checked whenever filled in: a bad email / phone number can't be saved from the client form. */
  format?: 'email' | 'phone';
}

export interface ClaimSectionDef {
  key: string;
  title: string;
  /** Who fills it: staff-only sections never appear on the client form. */
  who: 'client' | 'staff' | 'driver';
  /** A `list` section is repeatable rows (people, other vehicles). */
  list?: { itemLabel: string; addLabel: string };
  /** For list sections: a yes/no gate stored at form_data[`${key}_involved`]. */
  gate?: { label: string };
  fields: readonly ClaimFieldDef[];
  hint?: string;
  /** At least one of these fields (per row, for a list) must be filled in, while shown. */
  oneOf?: { keys: readonly string[]; label: string };
}

export const DRIVER_TYPE_OPTIONS = [
  'On Hire (driver details below)',
  'Policyholder or Named Driver',
  'Employee/Contract Agency Driver',
  'Spouse of Employee/Director',
  'Child of Employee/Director',
  'Other Relative/Friend',
  'Parked (last known driver details below)',
  'Theft/Vandalism claim (last known driver details below)',
] as const;

export const USE_OPTIONS = [
  'Carriage of own goods',
  'Carriage of third party goods',
  'Business of Employer',
  'Social Domestic and Pleasure',
] as const;

export const OWNERSHIP_OPTIONS = ['Owned', 'Hired', 'Leased/Outstanding Finance', 'Loaned'] as const;

export const PERSON_ROLE_OPTIONS = [
  'Passenger in our van',
  'Witness',
  'Other driver',
  'Owner of other vehicle/property',
  'Other',
] as const;

export const TITLE_OPTIONS = ['Mr', 'Mrs', 'Ms', 'Miss', 'Mx', 'Dr', 'Other'] as const;

export const CLAIM_SECTIONS: readonly ClaimSectionDef[] = [
  {
    key: 'incident',
    title: 'When and where',
    who: 'client',
    fields: [
      { key: 'date', label: 'Date', kind: 'date', required: true },
      { key: 'time', label: 'Time (approx.)', kind: 'text', placeholder: 'e.g. about 3pm' },
      { key: 'place', label: 'Place (junction name and town)', kind: 'textarea', required: true },
      { key: 'purpose', label: 'Purpose of journey', kind: 'text' },
      { key: 'goods', label: 'Goods being carried at the time', kind: 'text', placeholder: 'e.g. band equipment' },
      { key: 'our_speed', label: 'Speed of our vehicle', kind: 'text' },
      { key: 'other_speed', label: 'Speed of other vehicle', kind: 'text' },
      { key: 'speed_limit', label: 'Speed limit for the road', kind: 'text' },
      { key: 'lights', label: 'What lights were in use?', kind: 'text' },
      { key: 'weather', label: 'Weather conditions', kind: 'text' },
      { key: 'visibility', label: 'Visibility', kind: 'text' },
      { key: 'road_conditions', label: 'Road conditions', kind: 'text' },
      { key: 'warning_devices', label: 'Were warning lights / horn used?', kind: 'text' },
      { key: 'concerns', label: 'Any concerns about the incident?', kind: 'yesno' },
      { key: 'concerns_detail', label: 'Describe the concerns', kind: 'textarea', showIf: { key: 'concerns', equals: true }, required: true },
    ],
  },
  {
    key: 'police',
    title: 'Police',
    who: 'client',
    fields: [
      { key: 'informed', label: 'Were the police informed?', kind: 'yesno', required: true },
      { key: 'reference', label: 'Police reference number', kind: 'text', showIf: { key: 'informed', equals: true } },
      { key: 'officer_name', label: "Officer's name", kind: 'text', showIf: { key: 'informed', equals: true } },
      { key: 'officer_number', label: "Officer's number", kind: 'text', showIf: { key: 'informed', equals: true } },
      { key: 'station', label: 'Which station?', kind: 'text', showIf: { key: 'informed', equals: true } },
      { key: 'potential_prosecution', label: 'Potential prosecution?', kind: 'yesno', showIf: { key: 'informed', equals: true } },
    ],
    oneOf: { keys: ['reference', 'station'], label: 'Police reference number or station' },
  },
  {
    key: 'people',
    title: 'People involved',
    who: 'client',
    hint: 'Anyone who was there: passengers, witnesses, the other driver, anyone hurt. Only a name is needed - add a phone number or email if you have one.',
    gate: { label: 'Was anyone else there, or did anyone see it happen?' },
    list: { itemLabel: 'Person', addLabel: 'Add a person' },
    fields: [
      { key: 'roles', label: 'Who are they?', kind: 'multi', options: PERSON_ROLE_OPTIONS },
      // The broker's "witness type" (Passenger / Employee / Independent) is derived from this in the PDF.
      { key: 'knows_us', label: 'Do they know you or the driver (band, crew, colleague)?', kind: 'yesno', showIf: { key: 'roles', equals: 'Witness' } },
      { key: 'name', label: 'Name', kind: 'text', required: true },
      { key: 'phone', label: 'Phone', kind: 'text', format: 'phone' },
      { key: 'email', label: 'Email', kind: 'text', format: 'email' },
      { key: 'address', label: 'Address', kind: 'textarea' },
      { key: 'injured', label: 'Injured?', kind: 'yesno' },
      { key: 'notes', label: 'Notes', kind: 'textarea' },
    ],
  },
  {
    key: 'other_vehicles',
    title: 'Other vehicles or property',
    who: 'client',
    gate: { label: 'Was another vehicle or property involved?' },
    list: { itemLabel: 'Vehicle / property', addLabel: 'Add a vehicle or property' },
    fields: [
      { key: 'make_model', label: 'Make and model (or what the property was)', kind: 'text' },
      { key: 'reg', label: 'Registration number', kind: 'text' },
      { key: 'owner_name', label: "Owner's name", kind: 'text' },
      { key: 'owner_address', label: "Owner's address (with postcode)", kind: 'textarea' },
      { key: 'phone_day', label: 'Daytime phone', kind: 'text', format: 'phone' },
      { key: 'phone_mobile', label: 'Mobile', kind: 'text', format: 'phone' },
      { key: 'insurer', label: 'Insurance company and policy number', kind: 'text' },
      { key: 'driver_name', label: "Driver's name", kind: 'text' },
      { key: 'damage', label: 'Details of damage', kind: 'textarea' },
      { key: 'passengers', label: 'Number of passengers', kind: 'text' },
    ],
    oneOf: { keys: ['make_model', 'reg'], label: 'Make and model, or registration' },
  },
  {
    key: 'damage',
    title: 'Damage to our van',
    who: 'client',
    fields: [
      { key: 'description', label: 'Description of the damage', kind: 'textarea', required: true, placeholder: 'Write "none" if our van wasn\'t damaged.' },
      { key: 'airbags', label: 'Did airbags deploy?', kind: 'yesno' },
    ],
  },
  {
    key: 'account',
    title: 'Your version of events',
    who: 'client',
    fields: [
      {
        key: 'description',
        label: 'What happened, in detail',
        kind: 'textarea',
        placeholder: 'Include the direction of the vehicles and your approximate speed before and at the point of impact.',
        required: true,
        minLength: 20,
      },
      { key: 'at_fault', label: 'Does the driver consider themselves at fault?', kind: 'yesno', required: true },
      { key: 'not_at_fault_why', label: 'If not, why not?', kind: 'textarea', showIf: { key: 'at_fault', equals: false }, required: true },
      { key: 'attend_court', label: 'Is the driver prepared to attend court if required?', kind: 'yesno' },
      { key: 'driver_injured', label: 'Was the driver injured?', kind: 'yesno' },
    ],
  },
  {
    key: 'driver',
    title: 'Driver declaration',
    who: 'driver',
    hint: 'Name, date of birth, address and licence come from the hire form and are added to the broker PDF only.',
    fields: [
      { key: 'title', label: 'Title', kind: 'choice', options: TITLE_OPTIONS, required: true },
      { key: 'occupation', label: 'Occupation', kind: 'text', required: true },
      { key: 'details_changed', label: 'Has anything changed since the hire form (address, phone)?', kind: 'yesno' },
      { key: 'changes', label: 'What has changed?', kind: 'textarea', showIf: { key: 'details_changed', equals: true }, required: true },
      { key: 'decl_accidents', label: '(a) Accident or claim in the past 3 years?', kind: 'yesno', required: true },
      { key: 'decl_convictions', label: '(b) Driving conviction in the last 5 years, or prosecution pending?', kind: 'yesno', required: true },
      { key: 'decl_disability', label: '(c) Defect in vision or hearing, or any physical or mental disability?', kind: 'yesno', required: true },
      {
        key: 'decl_details', label: 'Full details if yes to any of the above', kind: 'textarea',
        requiredWhenAnyYes: ['decl_accidents', 'decl_convictions', 'decl_disability'],
      },
    ],
  },
  {
    key: 'cover',
    title: 'Policy details',
    who: 'staff',
    fields: [
      { key: 'driver_type', label: 'Driver type', kind: 'choice', options: DRIVER_TYPE_OPTIONS, defaultValue: DRIVER_TYPE_OPTIONS[0] },
      { key: 'use', label: 'Use', kind: 'choice', options: USE_OPTIONS, defaultValue: USE_OPTIONS[0] },
      { key: 'ownership', label: 'Ownership', kind: 'choice', options: OWNERSHIP_OPTIONS, defaultValue: 'Owned' },
      { key: 'owner_details', label: 'Owner / finance company contact details', kind: 'textarea', showIf: { key: 'ownership', equals: 'NOT:Owned' } },
    ],
  },
  {
    key: 'non_hire_driver',
    title: 'Driver not on a hire',
    who: 'staff',
    hint: "Only when the driver isn't a hire client — one of us or a freelancer (to the garage, a non-HireHop job). "
      + "A hire client's details come from their hire form instead. Printed in the broker PDF's driver block — "
      + 'set "Driver type" under Policy details to match.',
    fields: [
      { key: 'name', label: 'Full name', kind: 'text' },
      { key: 'date_of_birth', label: 'Date of birth', kind: 'date' },
      { key: 'address', label: 'Address (with postcode)', kind: 'textarea' },
      { key: 'phone', label: 'Mobile', kind: 'text', format: 'phone' },
      { key: 'licence', label: 'Licence (type, categories, year passed)', kind: 'text', placeholder: 'e.g. Full UK, B + C1, passed 2009' },
    ],
  },
  {
    key: 'our_vehicle',
    title: 'Our vehicle',
    who: 'staff',
    fields: [
      { key: 'value', label: 'Approx. vehicle value (£, ex-VAT)', kind: 'money' },
      { key: 'repair_cost', label: 'Approx. repair cost, if known (£)', kind: 'money' },
      { key: 'in_use', label: 'Is the vehicle in use?', kind: 'yesno' },
      { key: 'location', label: 'If not, where is it?', kind: 'text', showIf: { key: 'in_use', equals: false } },
      { key: 'storage_charges', label: 'Are storage charges being incurred?', kind: 'yesno' },
      { key: 'repairer_instructed', label: 'Has a repairer been instructed?', kind: 'yesno' },
      { key: 'repairer_details', label: 'Repairer name and contact details', kind: 'textarea', showIf: { key: 'repairer_instructed', equals: true } },
    ],
  },
];

/** The broker's declaration, verbatim (spec Appendix A.18). */
export const BROKER_DECLARATION =
  'To comply with the conditions of your policy no admission of liability or blame should be made either verbally or in writing. ' +
  'All documents concerning the incident should be sent to the company immediately and unanswered. ' +
  'I/We declare that the above statements are true and complete to the best of my/our belief.';

/** Privacy notice (spec §7.4 — approved by jon, Sep 2026). */
export const CLAIM_PRIVACY_NOTICE =
  'How we use this information. Ooosh! Tours Ltd uses what you tell us on this form - including details of passengers, ' +
  'witnesses, other drivers and anyone injured - only to deal with this incident: to assess it, arrange repairs and, if ' +
  'needed, make or defend an insurance claim. We may share it with our insurance broker (Alan Boswell Group), our insurers, ' +
  'repairers, legal advisers and the police where required. If you include details of other people, please give only ' +
  "what's needed for the claim. We keep incident records for 7 years after the case is closed, as insurance records " +
  'require. To ask what we hold about you, email info@oooshtours.co.uk.';

type Row = Record<string, unknown>;

/** Is this field visible given the other answers in its section / row? */
export function isFieldShown(field: ClaimFieldDef, row: Row | null | undefined): boolean {
  if (!field.showIf) return true;
  const v = row?.[field.showIf.key];
  const want = field.showIf.equals;
  if (typeof want === 'string' && want.startsWith('NOT:')) {
    return v != null && v !== '' && v !== want.slice(4);
  }
  if (Array.isArray(v)) return v.includes(want);
  return v === want;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * A filled-in email / phone that doesn't look right — the message, or null.
 * Phones can be from anywhere, so the check is loose: digits, spaces and
 * + ( ) - . only, with 7–15 digits.
 */
export function fieldFormatError(field: ClaimFieldDef, v: unknown): string | null {
  if (!field.format || typeof v !== 'string' || !v.trim()) return null;
  const t = v.trim();
  if (field.format === 'email') return EMAIL_RE.test(t) ? null : "That email address doesn't look right";
  const digits = t.replace(/\D/g, '').length;
  return /^[+()\-.\s\d]+$/.test(t) && digits >= 7 && digits <= 15
    ? null
    : 'Use digits only (with + and the country code if abroad)';
}

/** Is this field needed, given the other answers in its row? */
export function isFieldRequired(field: ClaimFieldDef, row: Row | null | undefined): boolean {
  if (!isFieldShown(field, row)) return false;
  if (field.required) return true;
  return !!field.requiredWhenAnyYes?.some((k) => row?.[k] === true);
}

function rowMissing(def: ClaimSectionDef, row: Row, prefix: string): string[] {
  const out: string[] = [];
  for (const f of def.fields) {
    if (!isFieldRequired(f, row)) continue;
    const v = row[f.key];
    const short = f.minLength && typeof v === 'string' && v.trim().length < f.minLength;
    if (!hasValue(v) || short) out.push(`${prefix}${f.label}${short ? ' (a little more detail, please)' : ''}`);
  }
  if (def.oneOf) {
    const shown = def.fields.filter((f) => def.oneOf!.keys.includes(f.key) && isFieldShown(f, row));
    if (shown.length && !shown.some((f) => hasValue(row[f.key]))) out.push(`${prefix}${def.oneOf.label}`);
  }
  return out;
}

/**
 * What the client form still needs before this section counts as done —
 * labels, empty when complete. `form` is the whole form_data.
 */
export function sectionMissing(def: ClaimSectionDef, form: Record<string, unknown>): string[] {
  const value = form[def.key];
  if (def.list) {
    const rows = Array.isArray(value) ? (value as Row[]) : [];
    const gate = form[`${def.key}_involved`];
    if (def.gate && rows.length === 0) {
      if (gate === false) return [];
      return [gate === true ? `At least one ${def.list.itemLabel.toLowerCase()}` : def.gate.label];
    }
    return rows.flatMap((r, i) => rowMissing(def, r || {}, `${def.list!.itemLabel} ${i + 1}: `));
  }
  const row = value && typeof value === 'object' && !Array.isArray(value) ? (value as Row) : {};
  return rowMissing(def, row, '');
}

/** Emails / phone numbers that don't look right in what was sent for a section. */
export function sectionFormatErrors(def: ClaimSectionDef, value: unknown): string[] {
  const rows = def.list ? (Array.isArray(value) ? (value as Row[]) : []) : [value && typeof value === 'object' ? (value as Row) : {}];
  const out: string[] = [];
  rows.forEach((r, i) => {
    for (const f of def.fields) {
      const err = fieldFormatError(f, r?.[f.key]);
      if (err) out.push(`${def.list ? `${def.list.itemLabel} ${i + 1}: ` : ''}${f.label} — ${err.toLowerCase()}`);
    }
  });
  return out;
}

/** Has a value worth printing (empty strings, empty arrays and null don't count). */
export function hasValue(v: unknown): boolean {
  if (v == null) return false;
  if (typeof v === 'string') return v.trim() !== '';
  if (Array.isArray(v)) return v.length > 0;
  return true;
}

/** Format one answer for display / the PDF. */
export function formatAnswer(field: ClaimFieldDef, v: unknown): string {
  if (!hasValue(v)) return '';
  if (field.kind === 'yesno') return v === true ? 'Yes' : v === false ? 'No' : String(v);
  if (field.kind === 'multi' && Array.isArray(v)) return v.join(', ');
  if (field.kind === 'money') {
    const n = Number(v);
    return Number.isFinite(n) ? `£${n.toLocaleString('en-GB', { maximumFractionDigits: 2 })}` : String(v);
  }
  if (field.kind === 'date' && typeof v === 'string' && /^\d{4}-\d{2}-\d{2}/.test(v)) {
    const [y, m, d] = v.slice(0, 10).split('-');
    return `${d}/${m}/${y}`;
  }
  return String(v);
}

/** Defaults for a brand-new case (staff sections only carry defaults). */
export function defaultFormData(): Record<string, Row> {
  const out: Record<string, Row> = {};
  for (const s of CLAIM_SECTIONS) {
    if (s.list) continue;
    for (const f of s.fields) {
      if (f.defaultValue !== undefined) {
        out[s.key] = out[s.key] || {};
        out[s.key][f.key] = f.defaultValue;
      }
    }
  }
  return out;
}

/** Sections a client link may write (never the Ooosh-only ones, never the driver's). */
export const CLIENT_SECTION_KEYS: readonly string[] = CLAIM_SECTIONS.filter((s) => s.who === 'client').map((s) => s.key);

/** The client form's checklist, in order: who's filling in, the client sections, the driver's part. */
export const CLIENT_CHECKLIST: ReadonlyArray<{ key: string; title: string }> = [
  { key: 'who', title: "Who's filling this in" },
  ...CLAIM_SECTIONS.filter((s) => s.who === 'client').map((s) => ({ key: s.key, title: s.title })),
  { key: 'driver', title: 'Driver declaration' },
];

const MAX_TEXT = 10000;
const MAX_ROWS = 30;

/** Coerce one answer to its field's kind; undefined = drop it. */
function sanitiseValue(field: ClaimFieldDef, v: unknown): unknown {
  if (v === null) return null;
  switch (field.kind) {
    case 'yesno':
      return typeof v === 'boolean' ? v : undefined;
    case 'money': {
      if (v === '') return null;
      const n = Number(v);
      return Number.isFinite(n) && n >= 0 && n < 1e9 ? n : undefined;
    }
    case 'multi':
      return Array.isArray(v)
        ? v.filter((x): x is string => typeof x === 'string' && (!field.options || field.options.includes(x))).slice(0, 20)
        : undefined;
    case 'choice':
      return typeof v === 'string' && (v === '' || !field.options || field.options.includes(v)) ? v : undefined;
    case 'date':
      return typeof v === 'string' && (v === '' || /^\d{4}-\d{2}-\d{2}$/.test(v)) ? v : undefined;
    default:
      return typeof v === 'string' ? v.slice(0, MAX_TEXT) : undefined;
  }
}

function sanitiseRow(def: ClaimSectionDef, raw: unknown): Row {
  const out: Row = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  for (const f of def.fields) {
    if (!(f.key in (raw as Row))) continue;
    const v = sanitiseValue(f, (raw as Row)[f.key]);
    if (v !== undefined) out[f.key] = v;
  }
  return out;
}

/**
 * Validate what a client (or anyone untrusted) sent for one section against
 * the catalogue: unknown keys dropped, values coerced to their field's kind.
 * A list section returns an array of rows; a plain section one row.
 */
export function sanitiseSection(def: ClaimSectionDef, raw: unknown): Row | Row[] {
  if (def.list) {
    return Array.isArray(raw) ? raw.slice(0, MAX_ROWS).map((r) => sanitiseRow(def, r)) : [];
  }
  return sanitiseRow(def, raw);
}

export type OutlineType = 'vito' | 'sprinter_mwb' | 'sprinter_lwb' | 'generic';

/**
 * Which van drawing to mark damage on. The vehicle's own outline_type wins;
 * otherwise a guess from its model / hire category text; generic if nothing
 * matches (spec §10.1).
 */
export function resolveOutlineType(v: {
  outline_type?: string | null;
  model?: string | null;
  make?: string | null;
  vehicle_type?: string | null;
  simple_type?: string | null;
}): OutlineType {
  const set = v.outline_type;
  if (set === 'vito' || set === 'sprinter_mwb' || set === 'sprinter_lwb' || set === 'generic') return set;
  const text = [v.make, v.model, v.vehicle_type, v.simple_type].filter(Boolean).join(' ').toLowerCase();
  if (/\bvito\b|v-?class|\bv\s?class\b/.test(text)) return 'vito';
  if (/\blwb\b|\bl3\b|\bxlwb\b/.test(text)) return 'sprinter_lwb';
  if (/\bmwb\b|\bl2\b/.test(text)) return 'sprinter_mwb';
  if (/sprinter/.test(text)) return 'sprinter_mwb';
  return 'generic';
}

export interface DamageMark {
  x: number;       // 0–100, percent of the drawing's width
  y: number;       // 0–100, percent of its height
  kind: 'cross' | 'arrow';
  angle?: number;  // arrows only, degrees
  note?: string;
}

/** Validate damage marks from an untrusted source. */
export function sanitiseDamageMarks(raw: unknown): DamageMark[] {
  if (!Array.isArray(raw)) return [];
  const out: DamageMark[] = [];
  for (const m of raw.slice(0, 60)) {
    if (!m || typeof m !== 'object') continue;
    const r = m as Row;
    const x = Number(r.x);
    const y = Number(r.y);
    if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || x > 100 || y < 0 || y > 100) continue;
    const kind = r.kind === 'arrow' ? 'arrow' : 'cross';
    const mark: DamageMark = { x: Math.round(x * 100) / 100, y: Math.round(y * 100) / 100, kind };
    if (kind === 'arrow') {
      const a = Number(r.angle);
      mark.angle = Number.isFinite(a) ? ((Math.round(a) % 360) + 360) % 360 : 0;
    }
    if (typeof r.note === 'string' && r.note.trim()) mark.note = r.note.trim().slice(0, 200);
    out.push(mark);
  }
  return out;
}
