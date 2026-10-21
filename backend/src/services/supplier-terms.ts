/**
 * Supplier payment terms → bill due dates.
 *
 * One source of truth for "when is this bill due", shared by the costs list
 * endpoint, the mark-paid modal (via the list payload), and the Xero bill push
 * — so they can never disagree. See docs/COSTS-PAYMENT-AUTOMATION-SPEC.md.
 *
 * Resolution precedence per supplier: stored terms (manual override, else
 * Xero-seeded) → default (invoice + 30). Terms are keyed by Xero contact id
 * when known, else lowercased supplier name.
 */
import { query } from '../config/database';
import { getSystemSetting } from '../routes/system-settings';
import { ukDateOf, ukToday } from './uk-date';

export type TermBasis = 'invoice_date' | 'end_of_invoice_month';

export interface SupplierTerms {
  basis: TermBasis;
  days: number;
  source: 'manual' | 'xero' | 'default' | 'freelancer';
}

export const DEFAULT_TERMS_DAYS = 30;
export const DEFAULT_TERMS: SupplierTerms = { basis: 'invoice_date', days: DEFAULT_TERMS_DAYS, source: 'default' };

/**
 * The OLD freelancer rule (Sep to Oct 2026), kept for bills approved before the
 * switch below: the first Friday on or after (invoice date + 7 days). Those
 * bills went to Xero with this date, so they keep it.
 *
 * Returns YYYY-MM-DD, or null with no anchor date. UTC throughout to avoid
 * day-shift.
 */
export function freelancerDueDate(invoiceDate: string | Date | null | undefined): string | null {
  const iso = toIsoDate(invoiceDate);
  if (!iso) return null;
  const d = new Date(`${iso}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return null;
  d.setUTCDate(d.getUTCDate() + 7);                 // one week after the invoice
  const daysToFriday = (5 - d.getUTCDay() + 7) % 7; // 5 = Friday; 0 if already a Friday
  d.setUTCDate(d.getUTCDate() + daysToFriday);
  return d.toISOString().slice(0, 10);
}

/** Ooosh freelancer terms, as a SupplierTerms for display alongside a due date. */
export const FREELANCER_TERMS: SupplierTerms = { basis: 'invoice_date', days: 0, source: 'freelancer' };

/**
 * Ooosh freelancer terms (jon, Oct 2026): paid on the first Friday one week
 * after the invoice is APPROVED, so 8 to 14 days after approval. A Friday
 * approval waits for the Friday after next (14 days); that is what makes
 * "8 to 14 days" true. This is what the "How to invoice Ooosh Tours Ltd" guide
 * and the freelancer welcome email say (FREELANCER-PORTAL-SPEC.md §4).
 *
 * `approvalDay` is the UK calendar day of the approval, YYYY-MM-DD.
 */
export function freelancerDueDateFromApproval(approvalDay: string | null | undefined): string | null {
  if (!approvalDay) return null;
  const d = new Date(`${approvalDay.slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return null;
  d.setUTCDate(d.getUTCDate() + 7);                       // one week after approval
  const daysToFriday = ((5 - d.getUTCDay() + 7) % 7) || 7; // the Friday AFTER that; a Friday moves on a week
  d.setUTCDate(d.getUTCDate() + daysToFriday);
  return d.toISOString().slice(0, 10);
}

/**
 * When the approval rule took over: an ISO instant in system_settings, stamped
 * by migration 301 when it ran (i.e. at deploy). Bills approved before it keep
 * the old invoice-date rule, so nobody's payment moves and OP still agrees with
 * the due date already sent to Xero. Missing or unreadable = the switch hasn't
 * happened, and every bill stays on the old rule.
 */
export const FREELANCER_APPROVAL_RULE_KEY = 'freelancer_terms_approval_from';

export async function getFreelancerApprovalRuleFrom(): Promise<Date | null> {
  try {
    const v = await getSystemSetting(FREELANCER_APPROVAL_RULE_KEY);
    if (!v) return null;
    const d = new Date(v);
    return Number.isNaN(d.getTime()) ? null : d;
  } catch (err) {
    console.warn('[supplier-terms] approval rule date unreadable, using the invoice-date rule:', (err as Error).message);
    return null;
  }
}

function toInstant(v: string | Date | null | undefined): Date | null {
  if (!v) return null;
  const d = v instanceof Date ? v : new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** A freelancer invoice's due date under whichever rule applies to it. */
function freelancerDerivedDueDate(cost: DueDateCost, approvalRuleFrom: Date | null): string | null {
  const approvedAt = toInstant(cost.approved_at);
  if (!approvalRuleFrom || (approvedAt && approvedAt < approvalRuleFrom)) {
    // Old rule: invoice date, falling back to approved_at for a legacy cost
    // captured with no invoice date.
    return freelancerDueDate(cost.cost_date ?? cost.approved_at);
  }
  // Not approved yet: shown as if approved today, so staff still see a date at
  // upload. It settles on the day it is actually approved, before it reaches
  // Xero (bills are pushed on approval).
  return freelancerDueDateFromApproval(approvedAt ? ukDateOf(approvedAt) : ukToday());
}

/**
 * Normalise a date-ish value to YYYY-MM-DD. node-postgres returns DATE columns
 * as Date objects, so every date helper here has to accept both.
 */
function toIsoDate(v: string | Date | null | undefined): string | null {
  if (!v) return null;
  if (typeof v === 'string') return v.slice(0, 10) || null;
  const t = v.getTime?.();
  if (t === undefined || Number.isNaN(t)) return null;
  return v.toISOString().slice(0, 10);
}

/** The subset of a cost row the due-date resolution needs. */
export interface DueDateCost {
  cost_type?: string | null;
  cost_date?: string | Date | null;
  approved_at?: string | Date | null;
  due_date_override?: string | Date | null;
}

export interface ResolvedDueDate {
  /** The due date to show and to send to Xero. */
  dueDate: string | null;
  /** What the rules alone would give — lets the UI offer "reset to default". */
  derivedDueDate: string | null;
  /** The terms that produced `derivedDueDate` (freelancer, or the supplier's). */
  terms: SupplierTerms;
  /** True when a staff override is standing in for the derived date. */
  isOverride: boolean;
}

/**
 * THE due date for a cost. Precedence: staff override → the Ooosh freelancer
 * Friday rule (freelancer invoices only) → the supplier's payment terms.
 *
 * Every surface that shows or sends a due date MUST come through here — the
 * costs list, get-one, the mark-paid modal (via the list payload), the Xero
 * bill push and the Xero re-sync. Deriving it inline anywhere else is how OP
 * and Xero end up disagreeing about when a bill is due.
 *
 * `supplierTerms` is ignored for a freelancer invoice; pass whatever the batch
 * resolver gave you and this picks the right rule. `approvalRuleFrom` is
 * `getFreelancerApprovalRuleFrom()`, read once per request; leave it out and
 * freelancer invoices get the old invoice-date rule.
 */
export function resolveDueDate(
  cost: DueDateCost,
  supplierTerms: SupplierTerms,
  approvalRuleFrom: Date | null = null,
): ResolvedDueDate {
  const override = toIsoDate(cost.due_date_override);
  const isFreelancer = cost.cost_type === 'freelancer_invoice';
  const terms = isFreelancer ? FREELANCER_TERMS : supplierTerms;
  const derived = isFreelancer
    ? freelancerDerivedDueDate(cost, approvalRuleFrom)
    : computeDueDate(cost.cost_date, terms);
  return { dueDate: override ?? derived, derivedDueDate: derived, terms, isOverride: Boolean(override) };
}

/**
 * `resolveDueDate` for a single cost, resolving the supplier's terms for you.
 * Use the batch `buildTermsResolver` + `resolveDueDate` on list endpoints so a
 * page of costs doesn't fire one terms query per row.
 */
export async function resolveDueDateForCost(
  cost: DueDateCost & { xero_contact_id?: string | null; supplier_name?: string | null },
): Promise<ResolvedDueDate> {
  if (cost.cost_type === 'freelancer_invoice') {
    return resolveDueDate(cost, FREELANCER_TERMS, await getFreelancerApprovalRuleFrom());
  }
  return resolveDueDate(cost, await resolveTermsForSupplier(cost.xero_contact_id, cost.supplier_name));
}

/**
 * Candidate term keys for a supplier, most-specific first. The Xero-contact key
 * wins over the name key so a contact-linked supplier's terms apply across every
 * cost that shares the contact id, regardless of name typos.
 */
export function termKeysFor(xeroContactId?: string | null, supplierName?: string | null): string[] {
  const keys: string[] = [];
  if (xeroContactId && xeroContactId.trim()) keys.push(`xero:${xeroContactId.trim()}`);
  if (supplierName && supplierName.trim()) keys.push(`name:${supplierName.trim().toLowerCase()}`);
  return keys;
}

/** The key a NEW terms row should be written under for this supplier. */
export function preferredTermKey(xeroContactId?: string | null, supplierName?: string | null): string | null {
  return termKeysFor(xeroContactId, supplierName)[0] ?? null;
}

/**
 * Due date (YYYY-MM-DD) for an invoice under the given terms. Null when there's
 * no invoice date. UTC throughout to avoid timezone day-shift (cost_date is a
 * DATE). For end_of_invoice_month, the base is the last day of the invoice's
 * month, then + days (so days=0 = pay by EOM, days=30 = EOM + 30).
 *
 * Accepts either a string or a JS Date — node-postgres returns DATE columns as
 * Date objects, so the backend callers (list / get-one) pass a Date here.
 */
export function computeDueDate(invoiceDate: string | Date | null | undefined, terms: SupplierTerms): string | null {
  if (!invoiceDate) return null;
  // Normalise to YYYY-MM-DD. Date objects (pg DATE) → ISO date part; the server
  // runs UTC so midnight-local == midnight-UTC (mirrors dateOnly in cost-xero-push).
  const iso = typeof invoiceDate === 'string'
    ? invoiceDate.slice(0, 10)
    : new Date(invoiceDate).toISOString().slice(0, 10);
  const [y, m, d] = iso.split('-').map((n) => parseInt(n, 10));
  if (!y || !m || !d) return null;
  // Base: invoice date, or the last day of the invoice's month.
  const base = terms.basis === 'end_of_invoice_month'
    ? new Date(Date.UTC(y, m, 0))          // day 0 of next month = last day of this month
    : new Date(Date.UTC(y, m - 1, d));
  base.setUTCDate(base.getUTCDate() + terms.days);
  return base.toISOString().slice(0, 10);
}

interface TermsRow { term_key: string; basis: TermBasis; days: number; source: 'manual' | 'xero' }

/**
 * Resolve effective terms for a set of suppliers in ONE query (for the list
 * endpoint — no N+1). Returns a function mapping a supplier's identity to its
 * resolved terms, defaulting when nothing is stored.
 */
export async function buildTermsResolver(
  suppliers: Array<{ xeroContactId?: string | null; supplierName?: string | null }>,
): Promise<(s: { xeroContactId?: string | null; supplierName?: string | null }) => SupplierTerms> {
  const wantedKeys = new Set<string>();
  for (const s of suppliers) for (const k of termKeysFor(s.xeroContactId, s.supplierName)) wantedKeys.add(k);

  const byKey = new Map<string, TermsRow>();
  if (wantedKeys.size) {
    try {
      const r = await query(
        `SELECT term_key, basis, days, source FROM supplier_payment_terms WHERE term_key = ANY($1)`,
        [Array.from(wantedKeys)],
      );
      for (const row of r.rows as TermsRow[]) byKey.set(row.term_key, row);
    } catch (err) {
      // Never let a terms lookup take down the costs list — degrade to defaults
      // (e.g. if the migration hasn't run yet). Self-heals once it has.
      console.warn('[supplier-terms] resolver query failed, using defaults:', (err as Error).message);
    }
  }

  return (s) => {
    for (const key of termKeysFor(s.xeroContactId, s.supplierName)) {
      const row = byKey.get(key);
      if (row) return { basis: row.basis, days: row.days, source: row.source };
    }
    return DEFAULT_TERMS;
  };
}

/** Resolve effective terms for a single supplier. */
export async function resolveTermsForSupplier(
  xeroContactId?: string | null,
  supplierName?: string | null,
): Promise<SupplierTerms> {
  const keys = termKeysFor(xeroContactId, supplierName);
  if (!keys.length) return DEFAULT_TERMS;
  try {
    const r = await query(
      `SELECT term_key, basis, days, source FROM supplier_payment_terms WHERE term_key = ANY($1)`,
      [keys],
    );
    const byKey = new Map((r.rows as TermsRow[]).map((row) => [row.term_key, row] as const));
    for (const key of keys) {
      const row = byKey.get(key);
      if (row) return { basis: row.basis, days: row.days, source: row.source };
    }
  } catch (err) {
    console.warn('[supplier-terms] resolve query failed, using defaults:', (err as Error).message);
  }
  return DEFAULT_TERMS;
}

/** Upsert a supplier's terms under its preferred key. */
export async function upsertSupplierTerms(input: {
  xeroContactId?: string | null;
  supplierName?: string | null;
  basis: TermBasis;
  days: number;
  source: 'manual' | 'xero';
  userId?: string | null;
}): Promise<void> {
  const termKey = preferredTermKey(input.xeroContactId, input.supplierName);
  if (!termKey) return;
  await query(
    `INSERT INTO supplier_payment_terms (term_key, supplier_name, xero_contact_id, basis, days, source, updated_by, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
     ON CONFLICT (term_key) DO UPDATE SET
       supplier_name = COALESCE(EXCLUDED.supplier_name, supplier_payment_terms.supplier_name),
       xero_contact_id = COALESCE(EXCLUDED.xero_contact_id, supplier_payment_terms.xero_contact_id),
       basis = EXCLUDED.basis, days = EXCLUDED.days, source = EXCLUDED.source,
       updated_by = EXCLUDED.updated_by, updated_at = NOW()`,
    [termKey, input.supplierName ?? null, input.xeroContactId ?? null, input.basis, input.days, input.source, input.userId ?? null],
  );
}

/** True if we already hold a terms row for this supplier (any key). */
async function termsExist(xeroContactId?: string | null, supplierName?: string | null): Promise<boolean> {
  const keys = termKeysFor(xeroContactId, supplierName);
  if (!keys.length) return false;
  const r = await query(`SELECT 1 FROM supplier_payment_terms WHERE term_key = ANY($1) LIMIT 1`, [keys]);
  return r.rows.length > 0;
}

/**
 * Background-seed terms from the Xero contact's PaymentTerms.Bills, the first
 * time we see a Xero-linked supplier with no stored terms. Fire-and-forget,
 * never throws into the caller — a Xero blip just means staff set terms manually.
 */
export async function seedTermsFromXeroIfMissing(xeroContactId?: string | null, supplierName?: string | null): Promise<void> {
  try {
    if (!xeroContactId || !xeroContactId.trim()) return;
    if (await termsExist(xeroContactId, supplierName)) return;
    const { isXeroConfigured } = await import('../config/xero');
    if (!isXeroConfigured()) return;
    const { xeroBroker } = await import('./xero-broker');
    const terms = await xeroBroker.getContactBillTerms(xeroContactId);
    if (!terms) return; // no terms set, or an unsupported Xero term type
    await upsertSupplierTerms({
      xeroContactId, supplierName, basis: terms.basis, days: terms.days, source: 'xero', userId: null,
    });
  } catch (err) {
    console.warn('[supplier-terms] Xero seed failed (non-fatal):', (err as Error).message);
  }
}
