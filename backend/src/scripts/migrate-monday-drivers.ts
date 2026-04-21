/**
 * Monday.com → OP migration for driver records (Board A — Driver Database).
 *
 * Reads the global driver board, upserts into OP `drivers` table by email
 * (case-insensitive), and stashes `monday_item_id` for audit. Files are NOT
 * migrated here — they need a separate script (migrate-monday-driver-files.ts).
 *
 * Match strategy:
 *   - By email (case-insensitive). If an existing driver row has the same
 *     email, fields are upserted via COALESCE by default (preserves OP edits
 *     over a freshly imported Monday blank).
 *   - `--force` flag overwrites OP fields with Monday values (useful to
 *     re-sync after you've corrected data on Monday).
 *   - `monday_item_id` is ALWAYS written (for audit + later file migration).
 *
 * Usage:
 *   cd backend
 *
 *   # 1. Discovery — prints every Board A column with a sample of values so
 *   #    you can verify the column-id mapping before migrating:
 *   npx tsx src/scripts/migrate-monday-drivers.ts --discover
 *
 *   # 2. Dry-run — shows what would be written, touches nothing:
 *   npx tsx src/scripts/migrate-monday-drivers.ts
 *
 *   # 3. Single driver for end-to-end test:
 *   npx tsx src/scripts/migrate-monday-drivers.ts --only-email jon@oooshtours.co.uk --commit
 *
 *   # 4. Full commit:
 *   npx tsx src/scripts/migrate-monday-drivers.ts --commit
 *
 *   # 5. Force-overwrite mode (use AFTER initial commit if Monday is the
 *   #    authoritative source for this run):
 *   npx tsx src/scripts/migrate-monday-drivers.ts --commit --force
 *
 * Required env vars:
 *   DATABASE_URL
 *   MONDAY_API_TOKEN
 *   MONDAY_BOARD_ID_DRIVERS    (defaults to 9798399405 if unset)
 *
 * Skips rows when:
 *   - email column is blank (can't match)
 *   - full_name is blank (would violate NOT NULL)
 */

import { Pool } from 'pg';
import dotenv from 'dotenv';

dotenv.config();

// ── CLI args ─────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const COMMIT = args.includes('--commit');
const FORCE = args.includes('--force');
const DISCOVER = args.includes('--discover');
const onlyEmailIdx = args.indexOf('--only-email');
const ONLY_EMAIL = onlyEmailIdx >= 0 ? args[onlyEmailIdx + 1]?.toLowerCase().trim() : undefined;

// ── Env ──────────────────────────────────────────────────────────────────

const MONDAY_API_TOKEN = process.env.MONDAY_API_TOKEN;
const DRIVER_BOARD_ID = process.env.MONDAY_BOARD_ID_DRIVERS || '9798399405';

if (!MONDAY_API_TOKEN) {
  console.error('Missing MONDAY_API_TOKEN');
  process.exit(1);
}
if (!process.env.DATABASE_URL) {
  console.error('Missing DATABASE_URL');
  process.exit(1);
}

// ── Column mapping ───────────────────────────────────────────────────────
//
// Real column IDs from Monday Board A (9798399405), verified via --discover
// on 21 Apr 2026. The board has an "IGNORE EVERYTHING PAST HERE >>>" divider
// column (color_mkxw8p5b) — columns BELOW it are Monday workaround helpers
// and are not migrated.
//
// NOT migrated (deliberately):
//   - Derived per-doc status columns (Licence/POA/DVLA/Passport/POA system-set
//     status) — these are computed from dates at query time in OP.
//   - "Calculated xs" — excess is computed live from DVLA points.
//   - File columns — handled by migrate-monday-driver-files.ts (Phase 4).
//   - "Driver country" — redundant with nationality.
//   - Everything below the divider (poa1URL/poa2URL, Licence Ending, duplicate
//     Driver Name, Created Date, Last Updated, helper-label columns).

const DRIVER_COLS = {
  // Identity
  email: 'email_mktrgzj',
  phoneCountry: 'text_mkty5hzk',
  phoneNumber: 'text_mktrfqe2',
  firstName: 'text_mkwhc7a',
  lastName: 'text_mkwhm2n5',
  dateOfBirth: 'date_mktr2x01',
  nationality: 'text_mktrdh72',

  // Address
  homeAddress: 'long_text_mktr2jhb',
  licenceAddress: 'long_text_mktrs5a0',

  // Licence
  licenceNumber: 'text_mktrrv38',
  licenceIssuedBy: 'text_mktrz69',
  licenceValidFrom: 'date_mktrmdx5',
  licenceValidTo: 'date_mktrwk94',
  licenceNextCheckDue: 'date_mktsbgpy',
  licencePoints: 'text_mkwfhvve',
  licenceEndorsements: 'text_mkwf6e1n',
  datePassedTest: 'date_mktr93jq',

  // Document expiry dates
  poa1ValidUntil: 'date_mktr1keg',
  poa2ValidUntil: 'date_mktra1a6',
  dvlaValidUntil: 'date_mktrmjfr',
  passportValidUntil: 'date_mkvxy5t1',

  // Document providers
  poa1Provider: 'text_mkyarprf',
  poa2Provider: 'text_mkyapcr6',

  // Questionnaire (statuses with Yes/No text)
  hasDisability: 'status',                 // the default "status" column — repurposed
  hasConvictions: 'color_mktr4w0',
  hasProsecution: 'color_mktrbt3x',
  hasAccidents: 'color_mktraeas',
  hasInsuranceIssues: 'color_mktrpe6q',
  hasDrivingBan: 'color_mktr2t8a',
  additionalDetails: 'long_text_mktr1a66',

  // Aggregated statuses
  insuranceStatus: 'color_mkxvxskq',       // "Approved" / "Referral" / "Failed"
  overallStatus: 'color_mkye2thx',         // "Approved" / "Action Required" / "Not Approved"

  // iDenfy
  idenfyCheckDate: 'text_mkvv2z8p',
  idenfyScanRef: 'text_mkwbn8bx',

  // Signature
  signatureDate: 'date_mkw4apb7',
} as const;

// ── Monday helpers ───────────────────────────────────────────────────────

interface MondayColumn { id: string; text: string | null; value: string | null; type?: string; title?: string }
interface MondayItem {
  id: string;
  name: string;
  column_values: MondayColumn[];
}

async function mondayQuery<T>(query: string, variables?: Record<string, unknown>): Promise<T> {
  const res = await fetch('https://api.monday.com/v2', {
    method: 'POST',
    headers: {
      'Authorization': MONDAY_API_TOKEN!,
      'Content-Type': 'application/json',
      'API-Version': '2024-01',
    },
    body: JSON.stringify({ query, variables }),
  });
  if (!res.ok) throw new Error(`Monday HTTP ${res.status}: ${await res.text()}`);
  const body = await res.json() as { data?: T; errors?: Array<{ message: string }> };
  if (body.errors && body.errors.length > 0) {
    throw new Error('Monday errors: ' + body.errors.map((e) => e.message).join('; '));
  }
  return body.data as T;
}

async function discoverColumns(boardId: string): Promise<void> {
  console.log(`\n=== DISCOVERY: Board ${boardId} columns ===\n`);

  const colsResponse = await mondayQuery<{ boards: Array<{ columns: Array<{ id: string; title: string; type: string }> }> }>(`
    query ($boardId: ID!) {
      boards(ids: [$boardId]) {
        columns { id title type }
      }
    }
  `, { boardId });

  const columns = colsResponse.boards[0].columns;
  console.log(`Found ${columns.length} columns:\n`);
  for (const col of columns) {
    console.log(`  ${col.id.padEnd(40)} type=${col.type.padEnd(12)} title="${col.title}"`);
  }

  // Grab first 3 rows to show sample values
  console.log(`\n=== SAMPLE: First 3 rows ===\n`);
  const sampleResponse = await mondayQuery<{ boards: Array<{ items_page: { items: MondayItem[] } }> }>(`
    query ($boardId: ID!) {
      boards(ids: [$boardId]) {
        items_page(limit: 3) {
          items {
            id
            name
            column_values { id text value }
          }
        }
      }
    }
  `, { boardId });

  for (const item of sampleResponse.boards[0].items_page.items) {
    console.log(`── Item ${item.id} — "${item.name}"`);
    for (const cv of item.column_values) {
      if (cv.text || cv.value) {
        const text = (cv.text || '').slice(0, 80);
        console.log(`    ${cv.id.padEnd(40)} text="${text}"`);
      }
    }
    console.log('');
  }

  console.log('Review the mapping in DRIVER_COLS at the top of this script against');
  console.log('the columns above. Update any mismatches, then run a dry-run:');
  console.log('  npx tsx src/scripts/migrate-monday-drivers.ts\n');
}

interface DriverItemsPageResponse {
  boards: Array<{ items_page: { cursor: string | null; items: MondayItem[] } }>;
}

async function fetchAllDriverItems(boardId: string): Promise<MondayItem[]> {
  // Pull every column — we don't know yet exactly which IDs are populated,
  // and the board is only ~150 rows so the payload is manageable.
  const all: MondayItem[] = [];
  let cursor: string | null = null;
  do {
    const query = `
      query ($boardId: ID!, $cursor: String) {
        boards(ids: [$boardId]) {
          items_page(limit: 100, cursor: $cursor) {
            cursor
            items {
              id
              name
              column_values { id text value }
            }
          }
        }
      }
    `;
    const data: DriverItemsPageResponse = await mondayQuery<DriverItemsPageResponse>(
      query, { boardId, cursor }
    );
    const page = data.boards[0].items_page;
    all.push(...page.items);
    cursor = page.cursor;
  } while (cursor);
  return all;
}

// ── Value extractors ─────────────────────────────────────────────────────

function cv(item: MondayItem, columnId: string): MondayColumn | undefined {
  return item.column_values.find((c) => c.id === columnId);
}

function cvText(item: MondayItem, columnId: string): string | null {
  const v = cv(item, columnId)?.text;
  const trimmed = (v ?? '').trim();
  return trimmed === '' ? null : trimmed;
}

function cvEmail(item: MondayItem, columnId: string): string | null {
  // Email columns come as JSON in value: {"email":"a@b.com","text":"label"}
  const raw = cv(item, columnId)?.value;
  if (!raw) return cvText(item, columnId);
  try {
    const parsed = JSON.parse(raw);
    return (parsed.email || parsed.text || '').trim().toLowerCase() || null;
  } catch {
    return cvText(item, columnId)?.toLowerCase() || null;
  }
}

function cvPhone(item: MondayItem, columnId: string): { phone: string | null; country: string | null } {
  const raw = cv(item, columnId)?.value;
  if (!raw) return { phone: cvText(item, columnId), country: null };
  try {
    const parsed = JSON.parse(raw);
    return {
      phone: parsed.phone?.trim() || null,
      country: parsed.countryShortName || parsed.country || null,
    };
  } catch {
    return { phone: cvText(item, columnId), country: null };
  }
}

/** Parse a Monday date column → ISO YYYY-MM-DD (or null). */
function cvDate(item: MondayItem, columnId: string): string | null {
  const raw = cv(item, columnId)?.value;
  if (!raw) {
    // fall back to text: "Jan 15, 2026" style
    const text = cvText(item, columnId);
    return text ? parseDate(text) : null;
  }
  try {
    const parsed = JSON.parse(raw);
    if (parsed.date) return parsed.date;
  } catch { /* fall through */ }
  return cvText(item, columnId);
}

function cvNumber(item: MondayItem, columnId: string): number | null {
  const text = cvText(item, columnId);
  if (!text) return null;
  const parsed = Number(text);
  return isNaN(parsed) ? null : parsed;
}

function cvBool(item: MondayItem, columnId: string): boolean {
  // Monday status columns: "Yes" / "No", or checkbox "checked" / "v"
  const text = cvText(item, columnId)?.toLowerCase() || '';
  return text === 'yes' || text === 'true' || text === 'checked' || text === 'v' || text === '1';
}

/** Robust date string → ISO YYYY-MM-DD. Handles "15 Jan 2026", "2026-01-15", etc. */
function parseDate(s: string | null): string | null {
  if (!s) return null;
  const trimmed = s.trim();
  if (!trimmed || trimmed.startsWith('1970-01-01')) return null;
  if (/^\d{4}-\d{2}-\d{2}/.test(trimmed)) return trimmed.slice(0, 10);
  const d = new Date(trimmed);
  if (isNaN(d.getTime())) return null;
  const y = d.getUTCFullYear();
  if (y < 1900 || y > 2100) return null;
  return `${y}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}

// ── Mapping: Monday item → driver row ────────────────────────────────────

interface DriverRow {
  monday_item_id: string;
  full_name: string;
  email: string;
  phone: string | null;
  phone_country: string | null;
  date_of_birth: string | null;
  nationality: string | null;
  address_full: string | null;
  licence_address: string | null;
  licence_number: string | null;
  licence_issued_by: string | null;
  licence_valid_from: string | null;
  licence_valid_to: string | null;
  licence_next_check_due: string | null;
  licence_points: number;
  licence_endorsements: unknown[];
  date_passed_test: string | null;
  poa1_valid_until: string | null;
  poa2_valid_until: string | null;
  dvla_valid_until: string | null;
  passport_valid_until: string | null;
  poa1_provider: string | null;
  poa2_provider: string | null;
  dvla_check_date: string | null;
  has_disability: boolean;
  has_convictions: boolean;
  has_prosecution: boolean;
  has_accidents: boolean;
  has_insurance_issues: boolean;
  has_driving_ban: boolean;
  additional_details: string | null;
  insurance_status: string | null;
  overall_status: string | null;
  requires_referral: boolean;
  referral_status: string | null;
  referral_notes: string | null;
  idenfy_check_date: string | null;
  idenfy_scan_ref: string | null;
  signature_date: string | null;
}

/** Parse Monday's licenceEndorsements text into a JSON array.
 *  Values look like '[{"code":"SP30","points":3,...}]' or literally "None".
 *  Returns [] for missing/None/invalid. */
function parseEndorsements(raw: string | null): unknown[] {
  if (!raw) return [];
  const trimmed = raw.trim();
  if (!trimmed || trimmed.toLowerCase() === 'none') return [];
  try {
    const parsed = JSON.parse(trimmed);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/** Derive dvla_check_date from dvla_valid_until by subtracting 30 days.
 *  Matches the convention used in driver-verification.ts:807 + DriverDetailPage:224.
 *  Returns null if validUntil is missing or unparseable. */
function deriveDvlaCheckDate(validUntil: string | null): string | null {
  if (!validUntil) return null;
  const d = new Date(validUntil);
  if (isNaN(d.getTime())) return null;
  d.setUTCDate(d.getUTCDate() - 30);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}

function itemToDriver(item: MondayItem): DriverRow | { skip: string } {
  const email = cvEmail(item, DRIVER_COLS.email);
  if (!email) return { skip: 'no email' };

  // Compose full_name: prefer firstName + lastName, fall back to item.name.
  const firstName = cvText(item, DRIVER_COLS.firstName);
  const lastName = cvText(item, DRIVER_COLS.lastName);
  let fullName = [firstName, lastName].filter(Boolean).join(' ').trim();
  if (!fullName) fullName = item.name?.trim() || '';
  if (!fullName) return { skip: 'no name' };

  // Referral derivation:
  //   - Directly from insurance_status === "Referral" (standard route — DVLA
  //     points or questionnaire triggered it)
  //   - ALSO from overall_status when it's anything non-"Approved" (e.g.
  //     "Manual review needed", "Action Required"). These are human overrides
  //     on Monday that don't surface via insurance_status. We flag them as
  //     pending referrals so staff can clear them via the DriverDetailPage
  //     resolve-referral panel.
  //
  // overall_status itself is NOT migrated — OP computes it live from doc dates
  // and referral state, so storing a Monday-computed value would go stale.
  const insuranceStatus = cvText(item, DRIVER_COLS.insuranceStatus);
  const overallStatusRaw = cvText(item, DRIVER_COLS.overallStatus);
  const insuranceReferral = insuranceStatus?.toLowerCase() === 'referral';
  const overallReferral = !!overallStatusRaw && overallStatusRaw.toLowerCase() !== 'approved';
  const requiresReferral = insuranceReferral || overallReferral;

  let referralNotes: string | null = null;
  if (requiresReferral) {
    if (insuranceReferral) {
      referralNotes = 'Migrated from Monday.com — insurance_status was "Referral". Resolve via panel below or clear if no longer applicable.';
    } else {
      referralNotes = `Migrated from Monday.com — original overall status: "${overallStatusRaw}". Resolve via panel below or clear if no longer applicable.`;
    }
  }

  const dvlaValidUntil = cvDate(item, DRIVER_COLS.dvlaValidUntil);

  return {
    monday_item_id: item.id,
    full_name: fullName,
    email,
    phone: cvText(item, DRIVER_COLS.phoneNumber),
    phone_country: cvText(item, DRIVER_COLS.phoneCountry),
    date_of_birth: cvDate(item, DRIVER_COLS.dateOfBirth),
    nationality: cvText(item, DRIVER_COLS.nationality),
    address_full: cvText(item, DRIVER_COLS.homeAddress),
    licence_address: cvText(item, DRIVER_COLS.licenceAddress),
    licence_number: cvText(item, DRIVER_COLS.licenceNumber),
    licence_issued_by: cvText(item, DRIVER_COLS.licenceIssuedBy),
    licence_valid_from: cvDate(item, DRIVER_COLS.licenceValidFrom),
    licence_valid_to: cvDate(item, DRIVER_COLS.licenceValidTo),
    licence_next_check_due: cvDate(item, DRIVER_COLS.licenceNextCheckDue),
    licence_points: cvNumber(item, DRIVER_COLS.licencePoints) || 0,
    licence_endorsements: parseEndorsements(cvText(item, DRIVER_COLS.licenceEndorsements)),
    date_passed_test: cvDate(item, DRIVER_COLS.datePassedTest),
    poa1_valid_until: cvDate(item, DRIVER_COLS.poa1ValidUntil),
    poa2_valid_until: cvDate(item, DRIVER_COLS.poa2ValidUntil),
    dvla_valid_until: dvlaValidUntil,
    passport_valid_until: cvDate(item, DRIVER_COLS.passportValidUntil),
    poa1_provider: cvText(item, DRIVER_COLS.poa1Provider),
    poa2_provider: cvText(item, DRIVER_COLS.poa2Provider),
    dvla_check_date: deriveDvlaCheckDate(dvlaValidUntil),
    has_disability: cvBool(item, DRIVER_COLS.hasDisability),
    has_convictions: cvBool(item, DRIVER_COLS.hasConvictions),
    has_prosecution: cvBool(item, DRIVER_COLS.hasProsecution),
    has_accidents: cvBool(item, DRIVER_COLS.hasAccidents),
    has_insurance_issues: cvBool(item, DRIVER_COLS.hasInsuranceIssues),
    has_driving_ban: cvBool(item, DRIVER_COLS.hasDrivingBan),
    additional_details: cvText(item, DRIVER_COLS.additionalDetails),
    insurance_status: insuranceStatus,
    overall_status: null,                         // let OP compute live
    requires_referral: requiresReferral,
    referral_status: requiresReferral ? 'pending' : null,
    referral_notes: referralNotes,
    idenfy_check_date: cvText(item, DRIVER_COLS.idenfyCheckDate),
    idenfy_scan_ref: cvText(item, DRIVER_COLS.idenfyScanRef),
    signature_date: cvDate(item, DRIVER_COLS.signatureDate),
  };
}

// ── DB upsert ────────────────────────────────────────────────────────────

async function upsertDriver(pool: Pool, d: DriverRow): Promise<'inserted' | 'updated'> {
  // Match by email (case-insensitive). If found, update with COALESCE policy
  // (preserve non-null OP values) unless --force is set.
  const existing = await pool.query(
    `SELECT id FROM drivers WHERE LOWER(email) = LOWER($1) AND is_active = true LIMIT 1`,
    [d.email]
  );

  const cols = [
    ['monday_item_id', d.monday_item_id],
    ['full_name', d.full_name],
    ['email', d.email],
    ['phone', d.phone],
    ['phone_country', d.phone_country],
    ['date_of_birth', d.date_of_birth],
    ['nationality', d.nationality],
    ['address_full', d.address_full],
    ['licence_address', d.licence_address],
    ['licence_number', d.licence_number],
    ['licence_issued_by', d.licence_issued_by],
    ['licence_valid_from', d.licence_valid_from],
    ['licence_valid_to', d.licence_valid_to],
    ['licence_next_check_due', d.licence_next_check_due],
    ['licence_points', d.licence_points],
    ['licence_endorsements', JSON.stringify(d.licence_endorsements)],
    ['date_passed_test', d.date_passed_test],
    ['poa1_valid_until', d.poa1_valid_until],
    ['poa2_valid_until', d.poa2_valid_until],
    ['dvla_valid_until', d.dvla_valid_until],
    ['passport_valid_until', d.passport_valid_until],
    ['poa1_provider', d.poa1_provider],
    ['poa2_provider', d.poa2_provider],
    ['dvla_check_date', d.dvla_check_date],
    ['has_disability', d.has_disability],
    ['has_convictions', d.has_convictions],
    ['has_prosecution', d.has_prosecution],
    ['has_accidents', d.has_accidents],
    ['has_insurance_issues', d.has_insurance_issues],
    ['has_driving_ban', d.has_driving_ban],
    ['additional_details', d.additional_details],
    ['insurance_status', d.insurance_status],
    ['overall_status', d.overall_status],
    ['requires_referral', d.requires_referral],
    ['referral_status', d.referral_status],
    ['referral_notes', d.referral_notes],
    ['idenfy_check_date', d.idenfy_check_date],
    ['idenfy_scan_ref', d.idenfy_scan_ref],
    ['signature_date', d.signature_date],
  ] as const;

  if (existing.rows.length > 0) {
    // UPDATE. monday_item_id is always overwritten for audit. Other fields
    // use COALESCE in default mode, or blind overwrite in --force mode.
    // NOTE: booleans (has_*, requires_referral) bypass COALESCE because
    // `false` would be preserved as non-null — use --force or trust the Monday
    // value. We trust Monday here (Monday is source of truth at migration time).
    // Fields where Monday is authoritative — always overwrite, ignore COALESCE.
    // Booleans and points can't be meaningfully COALESCE'd (false/0 aren't
    // null but also aren't "authoritative"). licence_endorsements defaults to
    // '[]'::jsonb which is non-null, so it would never update via COALESCE.
    // overall_status is always set to null by the migration (OP computes it
    // live) — needs to overwrite any stale value from a prior run.
    //
    // NOT in alwaysOverwrite (intentional): referral_status, referral_notes,
    // dvla_check_date — staff resolutions and hire-form data should persist
    // across re-runs of the migration (COALESCE preserves them).
    const alwaysOverwrite = new Set([
      'monday_item_id',
      'has_disability', 'has_convictions', 'has_prosecution',
      'has_accidents', 'has_insurance_issues', 'has_driving_ban',
      'requires_referral',
      'licence_points',
      'licence_endorsements',
      'overall_status',
    ]);
    const setParts: string[] = [];
    const params: unknown[] = [];
    let idx = 1;
    for (const [col, val] of cols) {
      params.push(val);
      if (FORCE || alwaysOverwrite.has(col)) {
        setParts.push(`${col} = $${idx}`);
      } else {
        setParts.push(`${col} = COALESCE(${col}, $${idx})`);
      }
      idx++;
    }
    params.push(existing.rows[0].id);
    await pool.query(
      `UPDATE drivers SET ${setParts.join(', ')}, updated_at = NOW() WHERE id = $${idx}`,
      params
    );
    return 'updated';
  } else {
    // INSERT
    const colNames = cols.map(([c]) => c);
    const placeholders = cols.map((_, i) => `$${i + 1}`);
    const params = cols.map(([, v]) => v);
    await pool.query(
      `INSERT INTO drivers (${colNames.join(', ')}, source, is_active)
       VALUES (${placeholders.join(', ')}, 'monday_migration', true)`,
      params
    );
    return 'inserted';
  }
}

// ── Main ─────────────────────────────────────────────────────────────────

async function main() {
  console.log(`migrate-monday-drivers`);
  console.log(`  board_id   = ${DRIVER_BOARD_ID}`);
  console.log(`  mode       = ${DISCOVER ? 'DISCOVER' : (COMMIT ? 'COMMIT' : 'DRY-RUN')}`);
  console.log(`  force      = ${FORCE}`);
  if (ONLY_EMAIL) console.log(`  only-email = ${ONLY_EMAIL}`);
  console.log('');

  if (DISCOVER) {
    await discoverColumns(DRIVER_BOARD_ID);
    return;
  }

  const pool = new Pool({ connectionString: process.env.DATABASE_URL });

  try {
    console.log(`Fetching items from Monday board ${DRIVER_BOARD_ID}...`);
    const items = await fetchAllDriverItems(DRIVER_BOARD_ID);
    console.log(`Fetched ${items.length} items.\n`);

    let inserted = 0;
    let updated = 0;
    let skipped = 0;
    const skipReasons = new Map<string, number>();
    const sampleRows: DriverRow[] = [];

    for (const item of items) {
      const mapped = itemToDriver(item);
      if ('skip' in mapped) {
        skipped++;
        skipReasons.set(mapped.skip, (skipReasons.get(mapped.skip) || 0) + 1);
        continue;
      }

      if (ONLY_EMAIL && mapped.email.toLowerCase() !== ONLY_EMAIL) continue;

      if (sampleRows.length < 5) sampleRows.push(mapped);

      if (COMMIT) {
        const result = await upsertDriver(pool, mapped);
        if (result === 'inserted') inserted++;
        else updated++;
        if ((inserted + updated) % 10 === 0) {
          console.log(`  ... ${inserted + updated} processed`);
        }
      } else {
        // Dry-run: check whether this WOULD be an insert or update
        const existing = await pool.query(
          `SELECT id FROM drivers WHERE LOWER(email) = LOWER($1) AND is_active = true LIMIT 1`,
          [mapped.email]
        );
        if (existing.rows.length > 0) updated++;
        else inserted++;
      }
    }

    // Summary
    console.log('\n=== SUMMARY ===');
    console.log(`  ${COMMIT ? 'Inserted' : 'Would insert'}: ${inserted}`);
    console.log(`  ${COMMIT ? 'Updated' : 'Would update'}:  ${updated}`);
    console.log(`  Skipped:                        ${skipped}`);
    if (skipReasons.size > 0) {
      console.log('  Skip reasons:');
      for (const [reason, count] of skipReasons.entries()) {
        console.log(`    - ${reason}: ${count}`);
      }
    }

    if (!COMMIT && sampleRows.length > 0) {
      console.log(`\n=== SAMPLE (first ${sampleRows.length} mapped rows) ===`);
      for (const row of sampleRows) {
        console.log(`\n── ${row.full_name} <${row.email}> (Monday ${row.monday_item_id})`);
        const visible: [string, unknown][] = [
          ['phone', `${row.phone_country || ''}${row.phone || ''}`.trim()],
          ['date_of_birth', row.date_of_birth],
          ['nationality', row.nationality],
          ['licence_number', row.licence_number],
          ['licence_issued_by', row.licence_issued_by],
          ['licence_valid_to', row.licence_valid_to],
          ['licence_next_check_due', row.licence_next_check_due],
          ['licence_points', row.licence_points],
          ['licence_endorsements', row.licence_endorsements.length > 0 ? JSON.stringify(row.licence_endorsements) : null],
          ['poa1_valid_until', row.poa1_valid_until],
          ['poa2_valid_until', row.poa2_valid_until],
          ['poa1_provider', row.poa1_provider],
          ['poa2_provider', row.poa2_provider],
          ['dvla_valid_until', row.dvla_valid_until],
          ['dvla_check_date (derived)', row.dvla_check_date],
          ['passport_valid_until', row.passport_valid_until],
          ['insurance_status', row.insurance_status],
          ['requires_referral', row.requires_referral],
          ['referral_status', row.referral_status],
          ['referral_notes', row.referral_notes],
          ['signature_date', row.signature_date],
        ];
        for (const [k, v] of visible) {
          if (v !== null && v !== '' && v !== false) {
            console.log(`    ${k}: ${v}`);
          }
        }
      }
      console.log('\nIf these look right, run with --commit to write.\n');
    }
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
