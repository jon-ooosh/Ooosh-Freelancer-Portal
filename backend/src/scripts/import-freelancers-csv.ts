/**
 * Freelancer Import — reads a CSV (or XLSX) exported from the Monday.com
 * Freelance Crew board and upserts each row into OP's people table with
 * is_freelancer=true and is_approved=true.
 *
 * Usage (dry-run — default):
 *   cd backend
 *   npx tsx src/scripts/import-freelancers-csv.ts --file /tmp/freelancers.csv
 *
 * To actually write changes:
 *   npx tsx src/scripts/import-freelancers-csv.ts --file /tmp/freelancers.csv --commit
 *
 * Match strategy: email (case-insensitive). If an existing person has the
 * same email, their freelancer fields are updated in place — names, phones,
 * notes and tags are preserved (so HH-synced data isn't overwritten).
 * No existing email → a new person is created.
 *
 * Rows are skipped when:
 *   - Column E (Email) is blank — we can't match without it
 *   - Column B (Freelance status) is blank — treated as a layout row
 *   - Column A (Name) is blank or looks like a section header
 *
 * Never imported: password hashes, Jotform IDs, Monday audit fields,
 * file lists (handled separately).
 */

import * as XLSX from 'xlsx';
import { Pool } from 'pg';
import dotenv from 'dotenv';
import path from 'path';

dotenv.config();

// ── CLI args ────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const getArg = (flag: string): string | undefined => {
  const idx = args.indexOf(flag);
  return idx >= 0 ? args[idx + 1] : undefined;
};
const filePath = getArg('--file');
const commit = args.includes('--commit');
// --force overwrites freelancer fields on matched rows rather than COALESCE-ing.
// Use this to correct an earlier import that had bad/missing data.
const force = args.includes('--force');

if (!filePath) {
  console.error('Usage: npx tsx src/scripts/import-freelancers-csv.ts --file <path> [--commit]');
  process.exit(1);
}

// ── Helpers ─────────────────────────────────────────────────────────────

/** Format a JS date as UK DD/MM/YYYY for console output */
function fmtUK(date: Date | string | null | undefined): string {
  if (!date) return '—';
  const d = date instanceof Date ? date : new Date(String(date));
  if (isNaN(d.getTime())) return String(date);
  return `${String(d.getUTCDate()).padStart(2, '0')}/${String(d.getUTCMonth() + 1).padStart(2, '0')}/${d.getUTCFullYear()}`;
}

/** Normalise a CSV cell value to a trimmed string or null.
 *  Handles xlsx-returned Date objects by emitting ISO YYYY-MM-DD. */
function cell(row: Record<string, unknown>, keys: string[]): string | null {
  for (const k of keys) {
    const v = row[k];
    if (v === undefined || v === null) continue;
    if (v instanceof Date) {
      if (isNaN(v.getTime())) continue;
      const y = v.getUTCFullYear();
      const m = String(v.getUTCMonth() + 1).padStart(2, '0');
      const d = String(v.getUTCDate()).padStart(2, '0');
      return `${y}-${m}-${d}`;
    }
    const s = String(v).trim();
    if (s !== '') return s;
  }
  return null;
}

/** Parse a date string in any sensible format → ISO YYYY-MM-DD.
 *  Handles ISO, ISO+time, JS Date.toString output, and UK DD/MM/YYYY.
 *  Treats the 1970 sentinel and blanks as null. */
function parseDate(s: string | null): string | null {
  if (!s) return null;
  const trimmed = s.trim();
  if (!trimmed || trimmed.startsWith('1970-01-01')) return null;

  // ISO YYYY-MM-DD (with optional time after a space or T)
  const isoMatch = trimmed.split(/[ T]/)[0].match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (isoMatch) return `${isoMatch[1]}-${isoMatch[2]}-${isoMatch[3]}`;

  // UK DD/MM/YYYY or DD-MM-YYYY
  const ukMatch = trimmed.match(/^(\d{1,2})[/\-](\d{1,2})[/\-](\d{4})$/);
  if (ukMatch) {
    return `${ukMatch[3]}-${ukMatch[2].padStart(2, '0')}-${ukMatch[1].padStart(2, '0')}`;
  }

  // Fallback — JS Date parser. Catches "Wed Dec 31 1992 00:00:00 GMT+0000".
  const d = new Date(trimmed);
  if (!isNaN(d.getTime()) && d.getUTCFullYear() > 1971) {
    const y = d.getUTCFullYear();
    const m = String(d.getUTCMonth() + 1).padStart(2, '0');
    const day = String(d.getUTCDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  }
  return null;
}

/** Split a full name into first / last on the first space */
function splitName(full: string): { first: string; last: string } {
  const parts = full.trim().split(/\s+/);
  if (parts.length === 1) return { first: parts[0], last: '' };
  return { first: parts[0], last: parts.slice(1).join(' ') };
}

/** Parse "Insured" / "NOT INSURED" / blank → boolean */
function parseInsured(s: string | null): boolean {
  if (!s) return false;
  return s.trim().toLowerCase() === 'insured';
}

/** Parse Yes / No / truthy strings → boolean */
function parseBool(s: string | null): boolean {
  if (!s) return false;
  const low = s.trim().toLowerCase();
  return low === 'yes' || low === 'true' || low === '1' || low === 'y';
}

/** Normalise a phone number. Excel's CSV export often strips the leading
 *  zero from UK mobiles (e.g. 07941991311 → 7941991311) when it parses
 *  unspaced digit strings as numbers. Pad UK-shaped mobiles back to 11
 *  digits; leave international and already-correct numbers alone. */
function normalisePhone(s: string | null): string | null {
  if (!s) return null;
  const trimmed = s.trim();
  if (!trimmed) return null;
  // 10 digits starting with 7 → UK mobile that lost its 0
  if (/^7\d{9}$/.test(trimmed)) return '0' + trimmed;
  return trimmed;
}

/** Build a "Ref 1 OK (12/05/2024) · Ref 2 OK (01/06/2024)" string */
function buildReferences(
  ref1: string | null, date1: string | null,
  ref2: string | null, date2: string | null,
): string | null {
  const parts: string[] = [];
  if (ref1) {
    const d = parseDate(date1);
    parts.push(`Ref 1 ${ref1}${d ? ` (${fmtUK(d)})` : ''}`);
  }
  if (ref2) {
    const d = parseDate(date2);
    parts.push(`Ref 2 ${ref2}${d ? ` (${fmtUK(d)})` : ''}`);
  }
  return parts.length > 0 ? parts.join(' · ') : null;
}

/** Build a "Expires: 15/03/2034" line for licence_details (free-text field) */
function buildLicenceDetails(expiryDate: string | null): string | null {
  const d = parseDate(expiryDate);
  return d ? `Licence expires: ${fmtUK(d)}` : null;
}

/** Combine Skills + Available-for into a deduped skills array */
function buildSkills(skillsRaw: string | null, availableFor: string | null): string[] {
  const collected: string[] = [];
  const add = (s: string | null) => {
    if (!s) return;
    for (const part of s.split(/[,;]/)) {
      const t = part.trim();
      if (t && !collected.includes(t)) collected.push(t);
    }
  };
  add(skillsRaw);
  add(availableFor);
  return collected;
}

// ── Main ────────────────────────────────────────────────────────────────

interface Row {
  name: string | null;
  freelanceStatus: string | null;
  email: string | null;
  phone: string | null;
  mobile: string | null;
  skills: string | null;
  availableFor: string | null;
  insurance: string | null;
  tshirt: string | null;
  homeAddress: string | null;
  licenceExpiry: string | null;
  emergencyName: string | null;
  emergencyPhone: string | null;
  dob: string | null;
  ref1: string | null;
  ref1Date: string | null;
  ref2: string | null;
  ref2Date: string | null;
  approvedDate: string | null;
  nextReview: string | null;
}

function extractRow(raw: Record<string, unknown>): Row {
  // Support both descriptive Monday headers and simple positional headers (A,B,C…)
  return {
    name:            cell(raw, ['Name', 'A']),
    freelanceStatus: cell(raw, ['Freelance status', 'B']),
    email:           cell(raw, ['Email', 'E']),
    // Monday's "Phone number" (G) is typically the freelancer's mobile;
    // "Phone number 2" (H) is an alternative. Map G → mobile, H → phone.
    mobile:          normalisePhone(cell(raw, ['Phone number', 'G'])),
    phone:           normalisePhone(cell(raw, ['Phone number 2', 'H'])),
    skills:          cell(raw, ['Skills', 'D']),
    availableFor:    cell(raw, ['Available for', 'I']),
    insurance:       cell(raw, ['Insurance status', 'K']),
    tshirt:          cell(raw, ['Tshirt?', 'J']),
    homeAddress:     cell(raw, ['Home address', 'S']),
    licenceExpiry:   cell(raw, ['Licence expiry date', 'T']),
    emergencyName:   cell(raw, ['Emergency contact name', 'U']),
    emergencyPhone:  normalisePhone(cell(raw, ['Emergency contact phone', 'V'])),
    dob:             cell(raw, ['Date of birth', 'W']),
    ref1:            cell(raw, ['Reference 1 ok?', 'X']),
    ref1Date:        cell(raw, ['< Date confirmed', 'Y']),
    ref2:            cell(raw, ['Reference 2?', 'Z']),
    ref2Date:        cell(raw, ['< Date confirmed_1', 'AA']), // Monday duplicates column names — xlsx suffixes _1
    approvedDate:    cell(raw, ['Date form approved', 'AE']),
    nextReview:      cell(raw, ['Next review required', 'AF']),
  };
}

async function main() {
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('Freelancer CSV Import');
  console.log(`Mode: ${commit ? 'COMMIT (writing to DB)' : 'DRY-RUN (no changes)'}${force ? ' [FORCE — overwriting existing freelancer fields]' : ''}`);
  console.log(`File: ${path.resolve(filePath!)}`);
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

  const wb = XLSX.readFile(filePath!, { raw: false, dateNF: 'yyyy-mm-dd' });
  const firstSheet = wb.SheetNames[0];
  const sheet = wb.Sheets[firstSheet];
  // header:'A' keys cells by column letter (A,B,C…) regardless of any header row.
  // The Monday export has section banners (rows 1-29) above the real header row,
  // so we can't rely on xlsx auto-detecting headers. defval keeps blanks present.
  const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, { header: 'A', defval: '' });

  console.log(`Parsed ${rows.length} rows from sheet "${firstSheet}"\n`);

  const pool = new Pool({ connectionString: process.env.DATABASE_URL });

  const stats = { considered: 0, skippedNoStatus: 0, skippedNoEmail: 0, skippedHeader: 0, matched: 0, created: 0, errors: 0 };

  try {
    for (const raw of rows) {
      const row = extractRow(raw);
      stats.considered++;

      // Skip layout / section-header rows
      if (!row.name || /^(day|night|weekend)\b/i.test(row.name) || row.name === 'Name') {
        stats.skippedHeader++;
        continue;
      }
      if (!row.freelanceStatus) {
        stats.skippedNoStatus++;
        continue;
      }
      if (!row.email) {
        console.log(`  ⚠ Skipped "${row.name}" — no email`);
        stats.skippedNoEmail++;
        continue;
      }

      const email = row.email.toLowerCase();
      const { first, last } = splitName(row.name);
      const isApproved = /all good/i.test(row.freelanceStatus);
      const skills = buildSkills(row.skills, row.availableFor);
      const licenceDetails = buildLicenceDetails(row.licenceExpiry);
      const references = buildReferences(row.ref1, row.ref1Date, row.ref2, row.ref2Date);
      const joinedDate = parseDate(row.approvedDate);
      const nextReview = parseDate(row.nextReview);
      const dob = parseDate(row.dob);

      // Look up existing person by email
      const existing = await pool.query(
        `SELECT id, first_name, last_name, phone, mobile, tags, skills, notes
         FROM people
         WHERE LOWER(email) = $1 AND is_deleted = false
         LIMIT 1`,
        [email]
      );

      if (existing.rows.length > 0) {
        const p = existing.rows[0];
        stats.matched++;
        console.log(
          `  ✓ MATCH  ${first} ${last} <${email}>  →  existing ${p.id.slice(0, 8)}` +
          `${isApproved ? ' [approved]' : ''}` +
          `${dob ? `  DOB ${fmtUK(dob)}` : ''}` +
          `${joinedDate ? `  joined ${fmtUK(joinedDate)}` : ''}` +
          `${nextReview ? `  review ${fmtUK(nextReview)}` : ''}`
        );

        if (commit) {
          const mergedTags = Array.from(new Set([...(p.tags || []), 'freelancer']));
          const mergedSkills = Array.from(new Set([...(p.skills || []), ...skills]));

          // Default mode keeps existing values via COALESCE (safe first-run).
          // --force overwrites freelancer fields outright (use to correct an
          // earlier import). Tags + skills are always merged.
          const dateExpr = (n: number, col: string) =>
            force ? `$${n}` : `COALESCE($${n}, ${col})`;
          const textExpr = (n: number, col: string) =>
            force ? `NULLIF($${n}, '')` : `COALESCE(NULLIF($${n}, ''), ${col})`;

          await pool.query(
            `UPDATE people SET
               is_freelancer = true,
               is_approved = $2,
               is_insured_on_vehicles = $3,
               has_tshirt = $4,
               skills = $5,
               tags = $6,
               freelancer_joined_date = ${dateExpr(7, 'freelancer_joined_date')},
               freelancer_next_review_date = ${dateExpr(8, 'freelancer_next_review_date')},
               date_of_birth = ${dateExpr(9, 'date_of_birth')},
               home_address = ${textExpr(10, 'home_address')},
               emergency_contact_name = ${textExpr(11, 'emergency_contact_name')},
               emergency_contact_phone = ${textExpr(12, 'emergency_contact_phone')},
               licence_details = ${textExpr(13, 'licence_details')},
               freelancer_references = ${textExpr(14, 'freelancer_references')},
               phone = ${textExpr(15, 'phone')},
               mobile = ${textExpr(16, 'mobile')},
               updated_at = NOW()
             WHERE id = $1`,
            [
              p.id, isApproved, parseInsured(row.insurance), parseBool(row.tshirt),
              mergedSkills, mergedTags, joinedDate, nextReview, dob,
              row.homeAddress, row.emergencyName, row.emergencyPhone,
              licenceDetails, references,
              row.phone, row.mobile,
            ]
          );
        }
      } else {
        stats.created++;
        console.log(
          `  + NEW    ${first} ${last} <${email}>` +
          `${isApproved ? ' [approved]' : ''}` +
          `${row.mobile ? `  mob ${row.mobile}` : ''}` +
          `${row.phone ? `  ph ${row.phone}` : ''}` +
          `${dob ? `  DOB ${fmtUK(dob)}` : ''}` +
          `${joinedDate ? `  joined ${fmtUK(joinedDate)}` : ''}` +
          `${nextReview ? `  review ${fmtUK(nextReview)}` : ''}`
        );

        if (commit) {
          await pool.query(
            `INSERT INTO people (
               first_name, last_name, email, phone, mobile,
               home_address, date_of_birth, tags, skills,
               is_freelancer, freelancer_joined_date, freelancer_next_review_date,
               is_insured_on_vehicles, is_approved, has_tshirt,
               emergency_contact_name, emergency_contact_phone,
               licence_details, freelancer_references,
               created_by
             ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,true,$10,$11,$12,$13,$14,$15,$16,$17,$18,'csv-import')`,
            [
              first, last, email, row.phone, row.mobile,
              row.homeAddress, dob, ['freelancer'], skills,
              joinedDate, nextReview,
              parseInsured(row.insurance), isApproved, parseBool(row.tshirt),
              row.emergencyName, row.emergencyPhone,
              licenceDetails, references,
            ]
          );
        }
      }
    }
  } catch (err) {
    stats.errors++;
    console.error('Error during import:', err);
  } finally {
    await pool.end();
  }

  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('Summary');
  console.log(`  Considered:            ${stats.considered}`);
  console.log(`  Skipped (header/blank): ${stats.skippedHeader}`);
  console.log(`  Skipped (no status):   ${stats.skippedNoStatus}`);
  console.log(`  Skipped (no email):    ${stats.skippedNoEmail}`);
  console.log(`  Matched existing:      ${stats.matched}`);
  console.log(`  Created new:           ${stats.created}`);
  console.log(`  Errors:                ${stats.errors}`);
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

  if (!commit) {
    console.log('\nDRY RUN — no database writes. Re-run with --commit to apply.');
  } else {
    console.log('\nDone.');
  }
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
