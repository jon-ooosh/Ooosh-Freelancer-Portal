/**
 * Whose freelancer invoice is this? (docs/FREELANCER-PORTAL-SPEC.md §5, Oct 2026)
 *
 * Fills in "Whose invoice?" when the office uploads a freelancer's invoice, and
 * is what the remittance address falls back to. A suggestion only: staff
 * confirm it, and a wrong one is one click to change. In order:
 *   1. remembered: the person a previous invoice with the same letterhead was
 *      linked to (the name compared as supplier matching does, so
 *      "FJS Productions Ltd" and "FJS Productions" are one name);
 *   2. remittance: the person whose email a previous remittance for that
 *      letterhead went to (staff chose that address, so it is a human answer);
 *   3. name: exactly one freelancer whose name matches the letterhead.
 * Freelancers trading as a company only match by 1 or 2, which is why the
 * choice is remembered once made.
 */
import { query } from '../config/database';
import { normaliseSupplierName } from './supplier-match';
import { fullDisplayName } from './display-name';

export interface SuggestedPerson { id: string; name: string; email: string | null }
export type SuggestSource = 'remembered' | 'remittance' | 'name' | 'none';

async function personRow(id: string): Promise<SuggestedPerson | null> {
  const r = await query(
    `SELECT id, first_name, last_name, preferred_name, email FROM people WHERE id = $1 AND COALESCE(is_deleted, false) = false`,
    [id],
  );
  const p = r.rows[0];
  return p ? { id: p.id, name: fullDisplayName(p), email: p.email || null } : null;
}

/** The one person (freelancers first) with this email address, else null. */
export async function personIdByEmail(email: string): Promise<string | null> {
  const r = await query(
    `SELECT id, is_freelancer FROM people
      WHERE COALESCE(is_deleted, false) = false AND LOWER(TRIM(email)) = LOWER(TRIM($1))
      ORDER BY is_freelancer DESC NULLS LAST`,
    [email],
  );
  const freelancers = r.rows.filter((x) => x.is_freelancer);
  if (freelancers.length === 1) return freelancers[0].id;
  if (!freelancers.length && r.rows.length === 1) return r.rows[0].id;
  return null;
}

export async function suggestInvoicePerson(
  supplierName: string, excludeCostId?: string | null,
): Promise<{ person: SuggestedPerson | null; source: SuggestSource }> {
  const key = normaliseSupplierName(supplierName || '');
  if (!key) return { person: null, source: 'none' };

  // 1 + 2: earlier freelancer invoices with the same letterhead.
  const prior = await query(
    `SELECT supplier_name, person_id, remittance_email
       FROM costs
      WHERE cost_type = 'freelancer_invoice'
        AND (person_id IS NOT NULL OR remittance_email IS NOT NULL)
        AND ($1::uuid IS NULL OR id <> $1)
        AND supplier_name IS NOT NULL
      ORDER BY created_at DESC
      LIMIT 2000`,
    [excludeCostId || null],
  );
  const same = prior.rows.filter((r) => normaliseSupplierName(r.supplier_name) === key);
  const linked = same.find((r) => r.person_id);
  if (linked) {
    const p = await personRow(linked.person_id);
    if (p) return { person: p, source: 'remembered' };
  }
  for (const r of same) {
    if (!r.remittance_email) continue;
    const id = await personIdByEmail(r.remittance_email);
    if (id) {
      const p = await personRow(id);
      if (p) return { person: p, source: 'remittance' };
    }
  }

  // 3: exactly one freelancer by name (legal or preferred first name).
  const people = await query(
    `SELECT id, first_name, last_name, preferred_name, email FROM people
      WHERE COALESCE(is_deleted, false) = false AND is_freelancer = true`,
  );
  const hits = people.rows.filter((p) =>
    normaliseSupplierName(`${p.first_name || ''} ${p.last_name || ''}`) === key
    || (p.preferred_name && normaliseSupplierName(`${p.preferred_name} ${p.last_name || ''}`) === key));
  if (hits.length === 1) {
    const p = hits[0];
    return { person: { id: p.id, name: fullDisplayName(p), email: p.email || null }, source: 'name' };
  }
  return { person: null, source: 'none' };
}
