/**
 * Monday Working-Terms Import
 *
 * Reads a CSV or XLSX exported from the Monday.com address-book board and
 * populates:
 *   - people.working_terms_type / working_terms_credit_days
 *   - people.do_not_hire (flag only, not a working_terms value)
 *   - people.phone + people.mobile (only when OP is NULL)
 *   - organisations.working_terms_type / working_terms_credit_days
 *   - organisations.do_not_hire
 *   - organisations.phone (only when OP is NULL)
 *
 * Match strategy: email, case-insensitive. The same email on both a person
 * and an org gets both rows updated.
 *
 * Column detection: case-insensitive header-name matching. Expected header
 * labels (either the exact string or a substring match):
 *   Email | E-mail
 *   Working terms | Payment terms
 *   Phone 1 | Phone
 *   Phone 2 | Mobile
 *
 * Value mapping for Monday "Working terms" column:
 *   "DO NOT HIRE"       → do_not_hire=true, working_terms_type='usual'
 *   "CREDIT ..."        → working_terms_type='credit', credit_days=30
 *   "FLEX BALANCE ..."  → working_terms_type='flex_balance'
 *   "NO DEPOSIT ..."    → working_terms_type='no_deposit'
 *   "USUAL ..."         → working_terms_type='usual'
 *   "CUSTOM ..."        → working_terms_type='custom'
 *   "OLD DETAILS ..."   → skipped (row reported, no DB write)
 *   blank               → no working_terms change, still considers phones
 *
 * Phone backfill:
 *   Only fills OP columns that are currently NULL/empty. Never overwrites.
 *   For people: Monday Phone 1 → OP phone, Monday Phone 2 → OP mobile.
 *   For orgs: Monday Phone 1 → OP phone (orgs only have one phone column).
 *
 * Usage (dry-run, default):
 *   cd backend
 *   npx tsx src/scripts/import-monday-working-terms.ts --file /tmp/monday-clients.csv
 *
 * Commit for real:
 *   npx tsx src/scripts/import-monday-working-terms.ts --file /tmp/monday-clients.csv --commit
 */

import * as XLSX from 'xlsx';
import { Pool } from 'pg';
import dotenv from 'dotenv';

dotenv.config();

// ── CLI ─────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const getArg = (flag: string): string | undefined => {
  const idx = args.indexOf(flag);
  return idx >= 0 ? args[idx + 1] : undefined;
};
const filePath = getArg('--file');
const commit = args.includes('--commit');

if (!filePath) {
  console.error('Usage: npx tsx src/scripts/import-monday-working-terms.ts --file <path> [--commit]');
  process.exit(1);
}

// ── Working-terms value parsing ─────────────────────────────────────────

type TermsResult = {
  kind: 'terms' | 'do_not_hire' | 'old_details' | 'blank' | 'unrecognised';
  working_terms_type: 'usual' | 'flex_balance' | 'no_deposit' | 'credit' | 'custom' | null;
  credit_days: number | null;
  do_not_hire: boolean;
  raw: string;
};

function parseWorkingTerms(raw: unknown): TermsResult {
  const s = String(raw ?? '').trim();
  const empty: TermsResult = {
    kind: 'blank', working_terms_type: null, credit_days: null, do_not_hire: false, raw: s,
  };
  if (!s) return empty;

  const upper = s.toUpperCase();

  if (upper.startsWith('DO NOT HIRE')) {
    return { kind: 'do_not_hire', working_terms_type: 'usual', credit_days: null, do_not_hire: true, raw: s };
  }
  if (upper.startsWith('OLD DETAILS')) {
    return { kind: 'old_details', working_terms_type: null, credit_days: null, do_not_hire: false, raw: s };
  }
  if (upper.startsWith('CREDIT')) {
    return { kind: 'terms', working_terms_type: 'credit', credit_days: 30, do_not_hire: false, raw: s };
  }
  if (upper.startsWith('FLEX BALANCE')) {
    return { kind: 'terms', working_terms_type: 'flex_balance', credit_days: null, do_not_hire: false, raw: s };
  }
  if (upper.startsWith('NO DEPOSIT')) {
    return { kind: 'terms', working_terms_type: 'no_deposit', credit_days: null, do_not_hire: false, raw: s };
  }
  if (upper.startsWith('USUAL')) {
    return { kind: 'terms', working_terms_type: 'usual', credit_days: null, do_not_hire: false, raw: s };
  }
  if (upper.startsWith('CUSTOM')) {
    return { kind: 'terms', working_terms_type: 'custom', credit_days: null, do_not_hire: false, raw: s };
  }

  return { kind: 'unrecognised', working_terms_type: null, credit_days: null, do_not_hire: false, raw: s };
}

// ── Header detection ─────────────────────────────────────────────────────

/**
 * Find the column letter (A, B, C…) whose header cell matches any of the
 * given patterns. Headers are short strings (≤ 50 chars) — this guards
 * against instruction-blob rows where a keyword appears inside a longer
 * sentence.
 */
function findColumn(headerRow: Record<string, unknown>, patterns: RegExp[]): string | null {
  for (const [col, cell] of Object.entries(headerRow)) {
    const label = String(cell ?? '').trim();
    if (!label || label.length > 50) continue;
    const norm = label.replace(/^<+\s*/, '').trim().toLowerCase();
    for (const pattern of patterns) {
      if (pattern.test(norm)) return col;
    }
  }
  return null;
}

// ── Phone tidying ────────────────────────────────────────────────────────

/**
 * Clean a phone value pulled from Excel:
 *   - trim whitespace
 *   - if it's scientific notation (e.g. "4.47767E+11"), expand to a plain int
 *   - if it's 10 digits starting with 7, prepend 0 (Excel strips leading zeros
 *     on UK mobiles: 07740947440 → 7740947440)
 */
function cleanPhone(raw: unknown): string | null {
  let s = String(raw ?? '').trim();
  if (!s) return null;

  // Scientific notation (from numeric Excel cells)
  if (/^-?\d+(\.\d+)?e[+-]?\d+$/i.test(s)) {
    const n = Number(s);
    if (Number.isFinite(n)) s = String(Math.round(n));
  }

  // UK mobile: 10 digits starting with 7 → prepend missing 0
  if (/^7\d{9}$/.test(s)) return '0' + s;

  return s;
}

// ── Main ─────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(`Monday working-terms import — ${commit ? 'LIVE' : 'DRY RUN'}`);
  console.log(`File: ${filePath}`);
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

  const wb = XLSX.readFile(filePath!, { raw: false });
  const firstSheet = wb.SheetNames[0];
  const sheet = wb.Sheets[firstSheet];
  const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, { header: 'A', defval: '' });

  if (rows.length < 2) {
    console.error('File has fewer than 2 rows — nothing to import.');
    process.exit(1);
  }

  // Detect header row — look for a row where we can resolve BOTH email and
  // working-terms columns via strict (short-cell) matching. This skips
  // instruction blobs / section banners that happen to contain keywords.
  const emailPatterns = [/^e-?mail$/i];
  const termsPatterns = [/^working\s*terms$/i, /^payment\s*terms$/i];
  const phone1Patterns = [/^phone(\s*1)?$/i];
  const phone2Patterns = [/^phone\s*2$/i, /^mobile$/i];

  let headerRowIdx = -1;
  for (let i = 0; i < Math.min(rows.length, 30); i++) {
    const hasEmail = findColumn(rows[i], emailPatterns);
    const hasTerms = findColumn(rows[i], termsPatterns);
    if (hasEmail && hasTerms) { headerRowIdx = i; break; }
  }
  if (headerRowIdx < 0) {
    console.error('Could not find a header row with both "Email" and "Working terms" columns in the first 30 rows.');
    console.error('Check that the CSV/XLSX has a row with short header cells matching those labels.');
    process.exit(1);
  }

  const headerRow = rows[headerRowIdx];
  const dataRows = rows.slice(headerRowIdx + 1);

  const emailCol = findColumn(headerRow, emailPatterns);
  const termsCol = findColumn(headerRow, termsPatterns);
  const phone1Col = findColumn(headerRow, phone1Patterns);
  const phone2Col = findColumn(headerRow, phone2Patterns);

  console.log(`Header row: ${headerRowIdx + 1}`);
  console.log(`  Email column:       ${emailCol ?? '(not found — cannot proceed)'}`);
  console.log(`  Working-terms col:  ${termsCol ?? '(not found — terms will not be imported)'}`);
  console.log(`  Phone 1 column:     ${phone1Col ?? '(not found — phones will not be imported)'}`);
  console.log(`  Phone 2 column:     ${phone2Col ?? '(not found)'}`);
  console.log('');

  if (!emailCol) process.exit(1);

  const pool = new Pool({ connectionString: process.env.DATABASE_URL });

  const stats = {
    rows: 0,
    skippedNoEmail: 0,
    matchedPeople: 0,
    matchedOrgs: 0,
    unmatched: 0,
    termsSet: 0,
    doNotHireSet: 0,
    phoneBackfilled: 0,
    oldDetailsSkipped: 0,
    unrecognised: [] as string[],
    termsByKind: { terms: 0, do_not_hire: 0, old_details: 0, blank: 0, unrecognised: 0 },
  };

  try {
    for (const row of dataRows) {
      stats.rows++;
      const emailRaw = String(row[emailCol] ?? '').trim();
      if (!emailRaw) { stats.skippedNoEmail++; continue; }
      const email = emailRaw.toLowerCase();

      const terms = termsCol ? parseWorkingTerms(row[termsCol]) : parseWorkingTerms('');
      stats.termsByKind[terms.kind]++;
      if (terms.kind === 'old_details') stats.oldDetailsSkipped++;
      if (terms.kind === 'unrecognised') stats.unrecognised.push(`${email} → "${terms.raw}"`);

      const phone1 = phone1Col ? cleanPhone(row[phone1Col]) : null;
      const phone2 = phone2Col ? cleanPhone(row[phone2Col]) : null;

      // Find matches (may hit person AND/OR org)
      const [peopleRes, orgsRes] = await Promise.all([
        pool.query(
          `SELECT id, first_name, last_name, phone, mobile,
                  working_terms_type, do_not_hire
             FROM people
            WHERE LOWER(email) = $1 AND is_deleted = false`,
          [email]
        ),
        pool.query(
          `SELECT id, name, phone, working_terms_type, do_not_hire
             FROM organisations
            WHERE LOWER(email) = $1 AND is_deleted = false`,
          [email]
        ),
      ]);

      const matchedAny = peopleRes.rows.length > 0 || orgsRes.rows.length > 0;
      if (!matchedAny) { stats.unmatched++; continue; }

      // People updates
      for (const p of peopleRes.rows) {
        stats.matchedPeople++;
        const label = `${p.first_name} ${p.last_name} <${email}>`;
        const changes: string[] = [];

        // Working terms — only write if Monday says something we understand
        if (terms.kind === 'terms' || terms.kind === 'do_not_hire') {
          if (p.working_terms_type !== terms.working_terms_type || p.do_not_hire !== terms.do_not_hire) {
            changes.push(
              `terms: ${p.working_terms_type ?? 'null'}→${terms.working_terms_type}` +
              (terms.credit_days ? ` (${terms.credit_days}d)` : '') +
              (terms.do_not_hire ? ' [DO NOT HIRE]' : '')
            );
            stats.termsSet++;
            if (terms.do_not_hire) stats.doNotHireSet++;
            if (commit) {
              await pool.query(
                `UPDATE people
                   SET working_terms_type = $2,
                       working_terms_credit_days = COALESCE($3, working_terms_credit_days),
                       do_not_hire = $4,
                       do_not_hire_reason = CASE WHEN $4 AND do_not_hire_reason IS NULL
                                                  THEN 'Imported from Monday "DO NOT HIRE" tag'
                                                  ELSE do_not_hire_reason END,
                       do_not_hire_set_at = CASE WHEN $4 AND do_not_hire_set_at IS NULL
                                                  THEN NOW() ELSE do_not_hire_set_at END,
                       do_not_hire_set_by = CASE WHEN $4 AND do_not_hire_set_by IS NULL
                                                  THEN 'monday-import' ELSE do_not_hire_set_by END,
                       updated_at = NOW()
                 WHERE id = $1`,
                [p.id, terms.working_terms_type, terms.credit_days, terms.do_not_hire]
              );
            }
          }
        }

        // Phone backfill — only if OP is NULL/empty
        const wantPhone = phone1 && (!p.phone || p.phone.trim() === '');
        const wantMobile = phone2 && (!p.mobile || p.mobile.trim() === '');
        if (wantPhone || wantMobile) {
          const phoneParts: string[] = [];
          if (wantPhone) phoneParts.push(`phone: ∅→${phone1}`);
          if (wantMobile) phoneParts.push(`mobile: ∅→${phone2}`);
          changes.push(phoneParts.join(', '));
          stats.phoneBackfilled++;
          if (commit) {
            await pool.query(
              `UPDATE people
                 SET phone = CASE WHEN (phone IS NULL OR phone = '') AND $2 IS NOT NULL
                                  THEN $2 ELSE phone END,
                     mobile = CASE WHEN (mobile IS NULL OR mobile = '') AND $3 IS NOT NULL
                                   THEN $3 ELSE mobile END,
                     updated_at = NOW()
               WHERE id = $1`,
              [p.id, wantPhone ? phone1 : null, wantMobile ? phone2 : null]
            );
          }
        }

        if (changes.length > 0) {
          console.log(`  ✓ PERSON  ${label}  →  ${changes.join(' | ')}`);
        }
      }

      // Org updates
      for (const o of orgsRes.rows) {
        stats.matchedOrgs++;
        const label = `${o.name} <${email}>`;
        const changes: string[] = [];

        if (terms.kind === 'terms' || terms.kind === 'do_not_hire') {
          if (o.working_terms_type !== terms.working_terms_type || o.do_not_hire !== terms.do_not_hire) {
            changes.push(
              `terms: ${o.working_terms_type ?? 'null'}→${terms.working_terms_type}` +
              (terms.credit_days ? ` (${terms.credit_days}d)` : '') +
              (terms.do_not_hire ? ' [DO NOT HIRE]' : '')
            );
            stats.termsSet++;
            if (terms.do_not_hire) stats.doNotHireSet++;
            if (commit) {
              await pool.query(
                `UPDATE organisations
                   SET working_terms_type = $2,
                       working_terms_credit_days = COALESCE($3, working_terms_credit_days),
                       do_not_hire = $4,
                       do_not_hire_reason = CASE WHEN $4 AND do_not_hire_reason IS NULL
                                                  THEN 'Imported from Monday "DO NOT HIRE" tag'
                                                  ELSE do_not_hire_reason END,
                       do_not_hire_set_at = CASE WHEN $4 AND do_not_hire_set_at IS NULL
                                                  THEN NOW() ELSE do_not_hire_set_at END,
                       do_not_hire_set_by = CASE WHEN $4 AND do_not_hire_set_by IS NULL
                                                  THEN 'monday-import' ELSE do_not_hire_set_by END,
                       updated_at = NOW()
                 WHERE id = $1`,
                [o.id, terms.working_terms_type, terms.credit_days, terms.do_not_hire]
              );
            }
          }
        }

        // Orgs only have one phone column — prefer phone1
        const orgPhoneValue = phone1 ?? phone2;
        const wantOrgPhone = orgPhoneValue && (!o.phone || o.phone.trim() === '');
        if (wantOrgPhone) {
          changes.push(`phone: ∅→${orgPhoneValue}`);
          stats.phoneBackfilled++;
          if (commit) {
            await pool.query(
              `UPDATE organisations
                 SET phone = CASE WHEN (phone IS NULL OR phone = '') THEN $2 ELSE phone END,
                     updated_at = NOW()
               WHERE id = $1`,
              [o.id, orgPhoneValue]
            );
          }
        }

        if (changes.length > 0) {
          console.log(`  ✓ ORG     ${label}  →  ${changes.join(' | ')}`);
        }
      }
    }
  } finally {
    await pool.end();
  }

  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(`Summary — ${commit ? 'LIVE' : 'DRY RUN'}`);
  console.log(`  Rows read:             ${stats.rows}`);
  console.log(`  Skipped (no email):    ${stats.skippedNoEmail}`);
  console.log(`  Matched people:        ${stats.matchedPeople}`);
  console.log(`  Matched orgs:          ${stats.matchedOrgs}`);
  console.log(`  Unmatched emails:      ${stats.unmatched}`);
  console.log(`  Working-terms writes:  ${stats.termsSet}`);
  console.log(`     ↳ DO NOT HIRE set:  ${stats.doNotHireSet}`);
  console.log(`  Phone backfills:       ${stats.phoneBackfilled}`);
  console.log(`  OLD DETAILS skipped:   ${stats.oldDetailsSkipped}`);
  console.log('');
  console.log('  Terms kinds in source:');
  console.log(`     terms:         ${stats.termsByKind.terms}`);
  console.log(`     do_not_hire:   ${stats.termsByKind.do_not_hire}`);
  console.log(`     old_details:   ${stats.termsByKind.old_details}`);
  console.log(`     blank:         ${stats.termsByKind.blank}`);
  console.log(`     unrecognised:  ${stats.termsByKind.unrecognised}`);
  if (stats.unrecognised.length > 0) {
    console.log('\n  Unrecognised terms (left untouched):');
    for (const u of stats.unrecognised.slice(0, 20)) console.log(`     ${u}`);
    if (stats.unrecognised.length > 20) console.log(`     …and ${stats.unrecognised.length - 20} more`);
  }
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  if (!commit) {
    console.log('This was a dry run. Re-run with --commit to apply changes.');
  }
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
