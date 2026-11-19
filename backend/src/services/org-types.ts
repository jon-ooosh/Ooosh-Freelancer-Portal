/**
 * Organisation types — main and "Also" (docs/PREMISES-COMPLIANCE-SPEC.md §8).
 *
 * `organisations.type` is the main type and is read as one value all over the
 * codebase; `organisations.also_types` (mig 356) holds any further ones. These
 * two SQL fragments are THE definitions of "is this org of type X" and "is this
 * a supplier and nothing else", so the Organisations filter, the global search
 * and the client pickers can't disagree.
 */

/** Matches an org whose main type OR an "Also" type is the given value (`$n`). */
export function orgHasTypeSql(alias: string, param: string): string {
  return `(${alias}.type = ${param} OR ${param} = ANY(COALESCE(${alias}.also_types, '{}'::text[])))`;
}

/**
 * A PURE supplier: main type 'supplier' and no other type in "Also". Left out of
 * the client pickers (New Enquiry, a job's client) — a promoter who also
 * supplies us is a client too, so it stays.
 */
export function pureSupplierSql(alias: string): string {
  return `(${alias}.type = 'supplier' AND NOT EXISTS (
    SELECT 1 FROM unnest(COALESCE(${alias}.also_types, '{}'::text[])) AS t(v) WHERE t.v <> 'supplier'))`;
}

/** Clean an "Also" list from a form: known shape, no duplicates, not the main type. */
export function cleanAlsoTypes(raw: unknown, mainType: string | null | undefined): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const v of raw) {
    const t = String(v ?? '').trim().toLowerCase();
    if (!/^[a-z_]{1,50}$/.test(t) || t === mainType || out.includes(t)) continue;
    out.push(t);
  }
  return out.slice(0, 10);
}
