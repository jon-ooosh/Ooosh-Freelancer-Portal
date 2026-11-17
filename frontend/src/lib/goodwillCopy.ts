/**
 * Goodwill credit — the words and the sums (docs/GOODWILL-CREDIT-SPEC.md).
 * Shared by the offer modal, the Client History note, the use modal and the
 * Goodwill tab, so they all say the same thing.
 */

export type GoodwillStatus = 'offered' | 'reserved' | 'used' | 'withdrawn' | 'expired';

export interface GoodwillCredit {
  id: string;
  ref: string;
  organisation_id: string | null;
  person_id: string | null;
  owner_name: string;
  amount_ex_vat: number;
  reason: string;
  source_kind: 'close_out' | 'problem' | 'cancellation' | 'organisation' | 'person' | 'referral';
  source_job_id: string | null;
  source_job_number: number | null;
  source_issue_id: string | null;
  offered_by_name: string | null;
  offered_at: string;
  expires_on: string;
  status: GoodwillStatus;
  reserved_job_id: string | null;
  reserved_job_number: number | null;
  reserved_for: 'hire' | 'invoice' | null;
  reserved_invoice_number: string | null;
  reserved_amount_ex_vat: number | null;
  reserved_at: string | null;
  used_amount_ex_vat: number | null;
  used_at: string | null;
  used_how: string | null;
  withdrawn_at: string | null;
  withdrawn_reason: string | null;
  /** What the HireHop read-back last found wrong (spec §6.2); null = nothing. */
  check_problem: string | null;
  last_checked_at: string | null;
  used_hh_ref: string | null;
}

export interface GoodwillOwner { kind: 'organisation' | 'person'; id: string; name: string; role?: string }

export const money = (n: number) => `£${(Math.round(n * 100) / 100).toFixed(2)}`;
/** The usual 20% total: £100 → "£120.00". Illustrative — VAT follows what the credit comes off. */
export const grossAt20 = (n: number) => money(Math.round(n * 120) / 100);
/** "£100.00+VAT (£120.00)" — the credit is net. */
export const plusVat = (n: number) => `${money(n)}+VAT (${grossAt20(n)})`;

/** '2027-11-16' → '16th Nov 2027'. A DATE string is a calendar day, never shifted; a
 *  timestamp is shown as its UK day. */
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** 1 → '1st', 2 → '2nd', 11 → '11th', 22 → '22nd'. */
export function ordinal(n: number): string {
  const teen = n % 100 >= 11 && n % 100 <= 13;
  const suffix = teen ? 'th' : ({ 1: 'st', 2: 'nd', 3: 'rd' } as Record<number, string>)[n % 10] || 'th';
  return `${n}${suffix}`;
}
export function gwDay(value: string | null | undefined): string {
  if (!value) return '—';
  const isDate = /^\d{4}-\d{2}-\d{2}$/.test(value);
  const d = new Date(isDate ? `${value}T12:00:00Z` : value);
  if (Number.isNaN(d.getTime())) return value;
  // "16th Nov 2027" — jon, 17 Nov 2026.
  // Numbers from Intl (for the UK day of a timestamp), month names from a fixed list —
  // en-GB "short" months read "Sept" in some browsers and "Sep" in others.
  const parts = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'numeric', year: 'numeric', timeZone: isDate ? 'UTC' : 'Europe/London' }).formatToParts(d);
  const get = (t: string) => Number(parts.find((x) => x.type === t)?.value || 0);
  return `${ordinal(get('day'))} ${MONTHS[get('month') - 1] ?? ''} ${get('year')}`;
}

export const STATUS_LABEL: Record<GoodwillStatus, string> = {
  offered: 'To use', reserved: 'Reserved', used: 'Used', withdrawn: 'Withdrawn', expired: 'Expired',
};
export const STATUS_PILL: Record<GoodwillStatus, string> = {
  offered: 'bg-green-100 text-green-800',
  reserved: 'bg-amber-100 text-amber-800',
  used: 'bg-ooosh-100 text-ooosh-800',
  withdrawn: 'bg-gray-100 text-gray-600',
  expired: 'bg-gray-100 text-gray-600',
};

/** The points for staff to put in their own email to the client — OP sends nothing (spec §5). */
export function emailPoints(g: { ref: string; owner_name: string; amount_ex_vat: number; expires_on: string }): string {
  return [
    `- ${plusVat(g.amount_ex_vat)} off a future hire with Ooosh, or towards anything you still owe us, for ${g.owner_name}`,
    `- Use it by ${gwDay(g.expires_on)} (for a hire, the booking must be made by then)`,
    `- Used once, up to ${money(g.amount_ex_vat)}+VAT - anything unused lapses`,
    `- Not exchangeable for cash`,
    `- Quote ${g.ref} when you book`,
  ].join('\n');
}

/** The text staff type into the HireHop line's note / the credit note's description. */
export const hireHopNote = (ref: string) => `Goodwill credit ${ref}`;

/** Copy to the clipboard; false when the browser refused. */
export async function copyText(text: string): Promise<boolean> {
  try { await navigator.clipboard.writeText(text); return true; } catch { return false; }
}
