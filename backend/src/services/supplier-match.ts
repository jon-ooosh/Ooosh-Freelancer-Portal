/**
 * Matching a printed supplier name to an existing Xero contact.
 *
 * The receipt AI reads the name as PRINTED; Xero holds it as the bookkeeper
 * typed it. "High Class-Cleaning LTD" on the letterhead is "High Class Cleaning"
 * in Xero. The first version of this compared lowercased strings by substring
 * containment, which sees no relation between those two — the hyphen and the
 * "LTD" break it both ways — so OP offered to create a second contact for a
 * supplier we already had. Duplicated contacts are painful to unpick later.
 *
 * Three layers, cheapest and most certain first:
 *
 *   1. A LEARNED ALIAS. Someone has confirmed this printed name before. Exact,
 *      instant, and the only thing that will ever handle a trading name that
 *      bears no resemblance to the registered one.
 *   2. A NORMALISED MATCH. Strip case, punctuation and company suffixes from
 *      both sides and compare. Catches the whole "Ltd / &  / hyphen / The"
 *      family without anyone being asked anything.
 *   3. A NEAR MATCH, offered for confirmation — never applied silently. A wrong
 *      auto-merge puts costs against the wrong supplier, which is worse than the
 *      duplicate contact it was trying to avoid. The human goes the last mile,
 *      once, and layer 1 remembers it.
 *
 * See docs/COST-CAPTURE-RECHARGE-SPEC.md.
 */
import { query } from '../config/database';
import { xeroBroker } from './xero-broker';

/** Legal-form and noise words that carry no identity. */
const SUFFIXES = [
  'limited', 'ltd', 'plc', 'llp', 'lp', 'llc', 'inc', 'incorporated',
  'company', 'co', 'group', 'holdings', 'uk', 'gb', 'international',
  'services', 'service', 'trading', 'ta', 'the',
];

/**
 * The comparison key: lowercase, punctuation and spacing gone, company suffixes
 * removed. "High Class-Cleaning LTD" and "High Class Cleaning" both become
 * "highclasscleaning".
 *
 * Suffixes are stripped as whole WORDS before the spaces go, so "Coast Ltd"
 * loses its "Ltd" but "Coastal" keeps its letters.
 */
export function normaliseSupplierName(raw: string): string {
  const words = String(raw || '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9\s]/g, ' ')   // hyphens, dots, apostrophes, commas
    .split(/\s+/)
    .filter(Boolean)
    .filter((w) => !SUFFIXES.includes(w));
  // Everything was a suffix ("The Ltd") — fall back to the raw letters rather
  // than returning an empty key that would collide with every other such name.
  if (!words.length) return String(raw || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  return words.join('');
}

export interface SupplierMatch {
  /** How the match was made — decides whether the UI applies or asks. */
  kind: 'alias' | 'exact' | 'near' | 'none';
  xeroContactId?: string;
  xeroName?: string;
}

/** Levenshtein, capped: we only care whether two short names are 1–2 edits apart. */
function editDistance(a: string, b: string): number {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > 3) return 99;
  const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i += 1) {
    let diag = prev[0];
    prev[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      const tmp = prev[j];
      prev[j] = Math.min(prev[j] + 1, prev[j - 1] + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1));
      diag = tmp;
    }
  }
  return prev[b.length];
}

/**
 * Find the Xero contact a printed supplier name refers to.
 *
 * Never creates anything and never throws — a Xero outage degrades to
 * `kind: 'none'`, which just means staff type the name as printed, exactly as
 * they did before any of this existed.
 */
export async function matchSupplier(printed: string): Promise<SupplierMatch> {
  const name = String(printed || '').trim();
  if (!name) return { kind: 'none' };
  const key = normaliseSupplierName(name);

  // 1. Learned alias — someone already answered this question.
  try {
    const a = await query(
      'SELECT xero_contact_id, xero_name FROM supplier_aliases WHERE alias_key = $1',
      [key],
    );
    if (a.rows.length) {
      void query(
        'UPDATE supplier_aliases SET hit_count = hit_count + 1, last_used_at = NOW() WHERE alias_key = $1',
        [key],
      ).catch(() => { /* a stats bump is never worth failing a capture over */ });
      return { kind: 'alias', xeroContactId: a.rows[0].xero_contact_id, xeroName: a.rows[0].xero_name };
    }
  } catch { /* fall through to Xero */ }

  // 2 + 3. Ask Xero. Search on the NORMALISED words as well as the printed
  // name: handing Xero a hyphenated letterhead string can return nothing at all,
  // which is the other half of why the old matcher missed.
  try {
    const seen = new Map<string, string>();
    for (const term of [name, key.slice(0, 40), name.split(/\s+/)[0]]) {
      if (!term || term.length < 3) continue;
      for (const c of await xeroBroker.searchContacts(term, 10)) seen.set(c.ContactID, c.Name);
      if (seen.size >= 10) break;
    }
    const candidates = [...seen.entries()].map(([id, xname]) => ({
      id, xname, key: normaliseSupplierName(xname),
    }));

    const exact = candidates.find((c) => c.key === key);
    if (exact) return { kind: 'exact', xeroContactId: exact.id, xeroName: exact.xname };

    // One side clearly contains the other ("hiqportslade" vs "hiq"), or a
    // typo's worth of edits apart. Offered, never applied.
    const near = candidates.find((c) => {
      if (c.key.length < 4 || key.length < 4) return false;
      if (c.key.includes(key) || key.includes(c.key)) return true;
      return editDistance(c.key, key) <= 2;
    });
    if (near) return { kind: 'near', xeroContactId: near.id, xeroName: near.xname };
  } catch { /* Xero down — keep the printed name */ }

  return { kind: 'none' };
}

/**
 * Remember a confirmation, so this printed name is never questioned again.
 * Re-pointing an existing alias is allowed — a supplier genuinely can move.
 */
export async function rememberSupplierAlias(
  printed: string, xeroContactId: string, xeroName: string, userId?: string,
): Promise<void> {
  const key = normaliseSupplierName(printed);
  if (!key) return;
  await query(
    `INSERT INTO supplier_aliases (alias_key, printed_name, xero_contact_id, xero_name, confirmed_by)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (alias_key) DO UPDATE
       SET xero_contact_id = EXCLUDED.xero_contact_id,
           xero_name       = EXCLUDED.xero_name,
           printed_name    = EXCLUDED.printed_name,
           confirmed_by    = EXCLUDED.confirmed_by`,
    [key, String(printed).slice(0, 200), xeroContactId, String(xeroName).slice(0, 200), userId ?? null],
  );
}
