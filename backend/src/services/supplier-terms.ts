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

export type TermBasis = 'invoice_date' | 'end_of_invoice_month';

export interface SupplierTerms {
  basis: TermBasis;
  days: number;
  source: 'manual' | 'xero' | 'default';
}

export const DEFAULT_TERMS_DAYS = 30;
export const DEFAULT_TERMS: SupplierTerms = { basis: 'invoice_date', days: DEFAULT_TERMS_DAYS, source: 'default' };

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
