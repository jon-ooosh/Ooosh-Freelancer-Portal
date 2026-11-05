/**
 * Puts back values that edit routes wiped between the zod 4 upgrade (deployed
 * 2 Nov 2026) and the partialForUpdate() fix (middleware/validate.ts).
 *
 * What went wrong: zod 4 applies a field's `.default()` even inside
 * `.partial()`, so every field an edit DIDN'T send was saved as its starting
 * value. "Mark as Referred to Insurer" sends two fields, and the driver came
 * back with requires_referral = false, 0 points and no endorsements
 * (Willoughby Robinson, 5 Nov 2026).
 *
 * How a damaging write is recognised: it resets EVERY defaulted field its
 * caller didn't send, all at once. So for each audited edit we ask which of
 * the known callers (the screens that call that route, listed per table below)
 * could have produced it, then:
 *   - a field that none of those callers sends, which went from a real value
 *     to the default → RESTORE (it can only have been the bug);
 *   - a field that some of them send → REVIEW (it may have been a person's
 *     deliberate change — shown, restored only with --include-review);
 *   - a write no caller fits → not this bug, ignored.
 * A value is put back only if it is STILL the default now — anything changed
 * since is left alone and listed as "already changed".
 *
 * Not covered, on purpose:
 *   - storage_rooms: the room form sends both defaulted fields every time.
 *   - vehicle_hire_assignments: nothing in the app calls PUT /assignments/:id,
 *     and that route keeps no audit trail.
 *   - costs, cash-flow accounts, PCNs: their schemas have no defaults.
 *
 * Usage:
 *   cd backend
 *   npx tsx src/scripts/repair-zod4-update-defaults.ts                    # dry run — report only
 *   npx tsx src/scripts/repair-zod4-update-defaults.ts --commit           # put back the RESTORE rows
 *   npx tsx src/scripts/repair-zod4-update-defaults.ts --commit --include-review   # …and the REVIEW rows
 *   … --entity <uuid>     only one record
 *   … --since <ISO time>  window start (default: 2026-11-02T15:00:00Z, when the upgrade merged)
 *
 * Re-running is safe: a restored value is no longer the default, so it is
 * skipped as "already changed".
 */

import { Pool, PoolClient } from 'pg';
import dotenv from 'dotenv';

dotenv.config();

const SYSTEM_USER_ID = '00000000-0000-0000-0000-000000000000';
const DEFAULT_SINCE = '2026-11-02T15:00:00Z';

// ── Table definitions ───────────────────────────────────────────────────────

type Row = Record<string, unknown>;

export interface Caller {
  /** The screen that calls the edit route. */
  name: string;
  /** Which of the table's defaulted fields this caller sends every time. */
  sends: string[];
  /** Optional extra test that this write came from this caller. */
  matches?: (before: Row | null, after: Row) => boolean;
  /**
   * The only other columns this caller can change (whole-row audits only).
   * An edit that changed anything else didn't come from it. Leave out for a
   * caller that can change anything.
   */
  touches?: string[];
}

export interface TableSpec {
  entityType: string;     // audit_log.entity_type
  table: string;
  title: string;
  /**
   * How the edit route audits:
   *  - 'full': previous_values and new_values are whole rows
   *  - 'diff': both hold only the fields that changed (drivers)
   *  - 'after': previous_values is null; the value before comes from the
   *    entity's previous audit row that holds the field
   */
  audit: 'full' | 'diff' | 'after';
  /** The defaulted fields of the create schema, and their default. */
  defaults: Record<string, unknown>;
  callers: Caller[];
  labelSql: string;       // SELECT id, label … WHERE id = ANY($1::uuid[])
  note?: string;          // printed under a record where something is restored
  noteFields?: string[];  // …only when one of these fields is restored
}

const DRIVER_FORM_FIELDS = [
  'licence_issue_country', 'licence_points',
  'has_disability', 'has_convictions', 'has_prosecution',
  'has_accidents', 'has_insurance_issues', 'has_driving_ban',
];
const touchesReferral = (_b: Row | null, a: Row) => 'referral_status' in a || 'referral_date' in a;

export const TABLES: TableSpec[] = [
  {
    entityType: 'driver',
    table: 'drivers',
    title: 'DRIVERS',
    audit: 'diff',
    defaults: {
      licence_issue_country: 'GB',
      licence_points: 0,
      licence_endorsements: [],
      has_disability: false,
      has_convictions: false,
      has_prosecution: false,
      has_accidents: false,
      has_insurance_issues: false,
      has_driving_ban: false,
      requires_referral: false,
      source: 'hire_form',
    },
    callers: [
      // DriverDetailPage startEditing(): sends the licence + questionnaire
      // fields, never referral_status / referral_date.
      { name: 'Edit driver form', sends: DRIVER_FORM_FIELDS, matches: (b, a) => !touchesReferral(b, a) },
      // "Mark as Referred to Insurer" and the referral-date Save send only
      // referral_status / referral_date.
      { name: 'Referral buttons', sends: [], matches: touchesReferral },
    ],
    labelSql: `SELECT id, COALESCE(full_name, '?') || COALESCE(' <' || email || '>', '') AS label
                 FROM drivers WHERE id = ANY($1::uuid[])`,
    note: 'Referral put back. Check whether a hire agreement went to this driver while it was cleared.',
    noteFields: ['requires_referral'],
  },
  {
    entityType: 'people',
    table: 'people',
    title: 'PEOPLE',
    audit: 'full',
    defaults: {
      tags: [],
      files: [],
      preferred_contact_method: 'email',
      is_freelancer: false,
      skills: [],
      is_insured_on_vehicles: false,
      is_approved: false,
      has_tshirt: false,
    },
    callers: [
      {
        name: 'Edit person form', sends: ['tags', 'preferred_contact_method'],
        // PersonFormData in frontend/src/components/PersonForm.tsx
        touches: ['first_name', 'last_name', 'preferred_name', 'email', 'phone', 'mobile', 'international_phone',
          'home_address', 'date_of_birth', 'notes', 'working_terms_type', 'working_terms_credit_days', 'working_terms_notes'],
      },
      {
        name: 'Freelancer panel', sends: ['skills', 'is_insured_on_vehicles', 'is_approved', 'has_tshirt'],
        touches: ['freelancer_joined_date', 'freelancer_next_review_date', 'licence_details',
          'emergency_contact_name', 'emergency_contact_phone', 'freelancer_references'],
      },
      { name: 'Quote contacts (mobile)', sends: [], touches: ['mobile'] },
    ],
    labelSql: `SELECT id, TRIM(COALESCE(first_name, '') || ' ' || COALESCE(last_name, '')) AS label
                 FROM people WHERE id = ANY($1::uuid[])`,
  },
  {
    entityType: 'organisations',
    table: 'organisations',
    title: 'ORGANISATIONS',
    audit: 'full',
    defaults: { tags: [], files: [] },
    callers: [
      {
        name: 'Edit organisation form', sends: ['tags'],
        // OrgFormData in frontend/src/components/OrganisationForm.tsx
        touches: ['name', 'type', 'parent_id', 'website', 'email', 'phone', 'address', 'location', 'notes',
          'working_terms_type', 'working_terms_credit_days', 'working_terms_notes', 'account_owner_user_id'],
      },
      { name: 'Name sync / type change', sends: [], touches: ['name', 'type'] },
    ],
    labelSql: `SELECT id, name AS label FROM organisations WHERE id = ANY($1::uuid[])`,
  },
  {
    entityType: 'venues',
    table: 'venues',
    title: 'VENUES',
    audit: 'full',
    defaults: { tags: [], files: [] },
    callers: [
      {
        name: 'Edit venue form', sends: ['tags'],
        // VenueFormData in frontend/src/components/VenueForm.tsx
        touches: ['name', 'organisation_id', 'address', 'city', 'postcode', 'country', 'load_in_address',
          'loading_bay_info', 'access_codes', 'parking_info', 'approach_notes', 'technical_notes',
          'general_notes', 'default_miles_from_base', 'default_drive_time_mins', 'default_return_cost'],
      },
      { name: 'Transport calculator', sends: [], touches: ['default_miles_from_base', 'default_drive_time_mins'] },
    ],
    labelSql: `SELECT id, name AS label FROM venues WHERE id = ANY($1::uuid[])`,
  },
  {
    entityType: 'held_items',
    table: 'held_items',
    title: 'HELD ITEMS',
    audit: 'after',
    defaults: { photos: [] },
    // The receipt page does send photos, but always the existing ones plus
    // new ones — it can never take an item from some photos to none. So no
    // caller can clear photos deliberately.
    callers: [{ name: 'Held item edit', sends: [] }],
    labelSql: `SELECT id, COALESCE(description, client_name_text, 'held item') AS label
                 FROM held_items WHERE id = ANY($1::uuid[])`,
  },
  {
    entityType: 'storage_tenancies',
    table: 'storage_tenancies',
    title: 'STORAGE TENANCIES',
    audit: 'after',
    // weekly_rate has a default too, but the edit route only writes the
    // columns on its allow-list, and weekly_rate isn't one — rates were safe.
    defaults: {
      status: 'active',
      access_type: 'door_code',
      billing_mode: 'manual',
      billing_cadence: 'monthly',
      rate_review_cadence: 'annual',
    },
    callers: [
      { name: 'Tenancy edit form', sends: ['status', 'access_type', 'billing_mode', 'billing_cadence'] },
      { name: 'Tenancy notes', sends: [] },
    ],
    labelSql: `SELECT t.id, COALESCE(o.name, '?') || ' — ' || COALESCE(r.name, '?') AS label
                 FROM storage_tenancies t
                 LEFT JOIN storage_rooms r ON r.id = t.room_id
                 LEFT JOIN organisations o ON o.id = t.organisation_id
                WHERE t.id = ANY($1::uuid[])`,
    note: 'Billing settings put back. Check for a storage bill or reminder missed since this edit.',
    noteFields: ['billing_mode', 'billing_cadence'],
  },
];

// ── Pure decision logic (unit-tested) ───────────────────────────────────────

/** Audit rows can hold a JSONB value as a JSON string (drivers' endorsements). */
// A wiped JSONB list can also read `{}`: node-postgres sends an empty JS
// array as the Postgres array literal '{}', which JSONB stores as an empty
// OBJECT (people.files / organisations.files, reproduced Nov 2026).
function asArray(v: unknown): unknown[] | null {
  if (Array.isArray(v)) return v;
  if (typeof v === 'string') {
    try {
      return asArray(JSON.parse(v));
    } catch { return null; }
  }
  if (v && typeof v === 'object' && Object.keys(v).length === 0) return [];
  return null;
}

export function hasValue(v: unknown): boolean {
  return v !== null && v !== undefined;
}

/** True when `v` is the field's default (numeric strings and JSON strings allowed). */
export function sameAsDefault(def: unknown, v: unknown): boolean {
  if (!hasValue(v)) return false;
  if (Array.isArray(def)) {
    const arr = asArray(v);
    return arr !== null && arr.length === 0;
  }
  if (typeof def === 'number') return Number(v) === def;
  return String(v) === String(def);
}

export interface Finding {
  field: string;
  verdict: 'restore' | 'review' | 'no-record';
  before: unknown;
  callers: string[];
}

/**
 * Judge one audited edit. `before` / `after` are the field values either side
 * of it (for 'diff' audits, only the fields that changed).
 */
export function judgeWrite(spec: TableSpec, before: Row | null, after: Row): Finding[] {
  const fields = Object.keys(spec.defaults);

  // The other columns this edit changed (whole-row audits only).
  const otherChanged: string[] = [];
  if (spec.audit === 'full' && before) {
    for (const k of Object.keys(after)) {
      if (k in spec.defaults || k === 'updated_at' || k === 'version') continue;
      if (JSON.stringify(before[k] ?? null) !== JSON.stringify(after[k] ?? null)) otherChanged.push(k);
    }
  }

  // Which callers could have produced this write? Each one resets every
  // defaulted field it doesn't send, so all of those must now be the default.
  const fits = spec.callers.filter((c) => {
    if (c.matches && !c.matches(before, after)) return false;
    if (c.touches && otherChanged.some((k) => !c.touches!.includes(k))) return false;
    for (const f of fields) {
      if (c.sends.includes(f)) continue;
      if (!(f in after)) {
        // A diff audit leaves unchanged fields out — fine. Any other audit
        // missing the field isn't a whole-row edit from the route.
        if (spec.audit === 'diff') continue;
        return false;
      }
      if (!sameAsDefault(spec.defaults[f], after[f])) return false;
    }
    return true;
  });
  if (fits.length === 0) return [];

  const out: Finding[] = [];
  for (const f of fields) {
    const def = spec.defaults[f];
    if (!(f in after) || !sameAsDefault(def, after[f])) continue;
    const senders = fits.filter((c) => c.sends.includes(f));
    if (senders.length === fits.length) continue; // every fitting caller sent it — deliberate

    const knowBefore = before !== null && f in before;
    if (!knowBefore) {
      // Only meaningful where the before value comes from history.
      if (spec.audit === 'after' && senders.length === 0) {
        out.push({ field: f, verdict: 'no-record', before: undefined, callers: fits.map((c) => c.name) });
      }
      continue;
    }
    const was = before![f];
    if (!hasValue(was) || sameAsDefault(def, was)) continue; // nothing was lost
    out.push({
      field: f,
      verdict: senders.length === 0 ? 'restore' : 'review',
      before: was,
      callers: fits.map((c) => c.name),
    });
  }
  return out;
}

// ── Database side ───────────────────────────────────────────────────────────

interface AuditRow {
  id: string;
  entity_id: string;
  action: string;
  previous_values: Row | null;
  new_values: Row | null;
  created_at: Date;
  by_email: string | null;
}

interface Damage extends Finding {
  entityId: string;
  at: Date;
  by: string | null;
}

function show(v: unknown): string {
  if (v === undefined) return '(unknown)';
  if (typeof v === 'string') return JSON.stringify(v);
  const s = JSON.stringify(v);
  return s.length > 120 ? `${s.slice(0, 117)}...` : s;
}

function ukTime(d: Date): string {
  return d.toLocaleString('en-GB', { timeZone: 'Europe/London', dateStyle: 'medium', timeStyle: 'short' });
}

function argValue(name: string): string | null {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] ?? null : null;
}

async function columnTypes(client: PoolClient, table: string): Promise<Record<string, string>> {
  const r = await client.query<{ column_name: string; data_type: string }>(
    `SELECT column_name, data_type FROM information_schema.columns WHERE table_name = $1`,
    [table],
  );
  return Object.fromEntries(r.rows.map((x) => [x.column_name, x.data_type]));
}

/** Shape a value for node-postgres: JSONB must be stringified, text[] stays an array. */
function toParam(type: string | undefined, v: unknown): unknown {
  if (type === 'jsonb' || type === 'json') {
    const arr = asArray(v);
    return JSON.stringify(arr ?? v);
  }
  if (type === 'ARRAY') return asArray(v) ?? v;
  return v;
}

async function findDamage(client: PoolClient, spec: TableSpec, since: string, entity: string | null): Promise<Damage[]> {
  const params: unknown[] = [spec.entityType, since];
  let entityFilter = '';
  if (entity) { params.push(entity); entityFilter = `AND a.entity_id = $3`; }

  const edits = await client.query<AuditRow>(
    `SELECT a.id, a.entity_id, a.action, a.previous_values, a.new_values, a.created_at, u.email AS by_email
       FROM audit_log a
       LEFT JOIN users u ON u.id::text = a.user_id
      WHERE a.entity_type = $1 AND a.action = 'update' AND a.created_at >= $2 ${entityFilter}
      ORDER BY a.created_at`,
    params,
  );
  if (edits.rows.length === 0) return [];

  // For 'after' audits, the value before an edit is the latest earlier audit
  // row of the same record that holds the field.
  let history: AuditRow[] = [];
  if (spec.audit === 'after') {
    const ids = [...new Set(edits.rows.map((r) => r.entity_id))];
    history = (await client.query<AuditRow>(
      `SELECT a.id, a.entity_id, a.action, a.previous_values, a.new_values, a.created_at, NULL AS by_email
         FROM audit_log a
        WHERE a.entity_type = $1 AND a.entity_id = ANY($2::text[])
        ORDER BY a.created_at`,
      [spec.entityType, ids],
    )).rows;
  }

  const out: Damage[] = [];
  for (const row of edits.rows) {
    const after = row.new_values;
    if (!after || typeof after !== 'object') continue;

    let before: Row | null = row.previous_values;
    if (spec.audit === 'after') {
      before = {};
      const earlier = history.filter((h) => h.entity_id === row.entity_id && h.created_at < row.created_at && h.id !== row.id);
      for (const f of Object.keys(spec.defaults)) {
        for (let i = earlier.length - 1; i >= 0; i--) {
          const nv = earlier[i].new_values;
          if (nv && typeof nv === 'object' && f in nv) { before[f] = nv[f]; break; }
        }
      }
    } else if (spec.audit === 'full' && (!before || typeof before !== 'object')) {
      continue; // e.g. the do-not-hire audit row — not a whole-row edit
    }

    for (const f of judgeWrite(spec, before, after)) {
      out.push({ ...f, entityId: row.entity_id, at: row.created_at, by: row.by_email });
    }
  }
  return out;
}

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error('DATABASE_URL not set');
    process.exit(1);
  }
  const commit = process.argv.includes('--commit');
  const includeReview = process.argv.includes('--include-review');
  const since = argValue('--since') || DEFAULT_SINCE;
  const entity = argValue('--entity');

  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const client = await pool.connect();
  const totals = { restored: 0, review: 0, noRecord: 0, alreadyChanged: 0 };

  try {
    console.log(`Mode: ${commit ? `COMMIT (will write${includeReview ? ', including REVIEW rows' : ''})` : 'DRY RUN (no changes)'}`);
    console.log(`Edits since ${since}${entity ? `, record ${entity} only` : ''}\n`);

    for (const spec of TABLES) {
      const damage = await findDamage(client, spec, since, entity);

      // One finding per record + field: the latest edit that wiped it.
      const latest = new Map<string, Damage>();
      for (const d of damage) latest.set(`${d.entityId}|${d.field}`, d);
      const byEntity = new Map<string, Damage[]>();
      for (const d of latest.values()) {
        if (!byEntity.has(d.entityId)) byEntity.set(d.entityId, []);
        byEntity.get(d.entityId)!.push(d);
      }
      if (byEntity.size === 0) { console.log(`${spec.title}: nothing found\n`); continue; }

      const ids = [...byEntity.keys()];
      const labels = new Map(
        (await client.query<{ id: string; label: string }>(spec.labelSql, [ids])).rows.map((r) => [String(r.id), r.label]),
      );
      const types = await columnTypes(client, spec.table);
      const cols = Object.keys(spec.defaults).filter((c) => types[c]);
      const current = new Map(
        (await client.query<Row>(`SELECT id, ${cols.join(', ')} FROM ${spec.table} WHERE id = ANY($1::uuid[])`, [ids]))
          .rows.map((r) => [String(r.id), r]),
      );

      console.log(`${spec.title}`);
      for (const id of ids) {
        const now = current.get(id);
        console.log(`  ${labels.get(id) ?? '(record gone)'}  [${id}]`);
        if (!now) { console.log('    record no longer exists — skipped'); continue; }

        const toWrite: Damage[] = [];
        for (const d of byEntity.get(id)!) {
          const stillDefault = sameAsDefault(spec.defaults[d.field], now[d.field]);
          const when = `${ukTime(d.at)} by ${d.by ?? 'unknown'} (${d.callers.join(' / ')})`;
          if (!stillDefault) {
            totals.alreadyChanged++;
            console.log(`    already changed  ${d.field}: now ${show(now[d.field])} — left alone`);
          } else if (d.verdict === 'no-record') {
            totals.noRecord++;
            console.log(`    CHECK BY HAND    ${d.field}: wiped ${when}; no earlier record of its value`);
          } else if (d.verdict === 'review' && !includeReview) {
            totals.review++;
            console.log(`    REVIEW           ${d.field}: ${show(now[d.field])} → ${show(d.before)}  (wiped ${when}; may have been deliberate)`);
          } else {
            toWrite.push(d);
            console.log(`    ${commit ? 'RESTORED' : 'RESTORE '}         ${d.field}: ${show(now[d.field])} → ${show(d.before)}  (wiped ${when})`);
          }
        }
        if (toWrite.length === 0) continue;
        if (spec.note && toWrite.some((d) => spec.noteFields?.includes(d.field))) console.log(`    ⚠ ${spec.note}`);
        totals.restored += toWrite.length;
        if (!commit) continue;

        try {
          await client.query('BEGIN');
          const locked = (await client.query<Row>(
            `SELECT id, ${cols.join(', ')} FROM ${spec.table} WHERE id = $1 FOR UPDATE`, [id],
          )).rows[0];
          // Re-check under the lock — someone may have just edited it.
          const ready = toWrite.filter((d) => locked && sameAsDefault(spec.defaults[d.field], locked[d.field]));
          if (ready.length > 0) {
            const params: unknown[] = [];
            const sets = ready.map((d) => {
              params.push(toParam(types[d.field], d.before));
              return `${d.field} = $${params.length}`;
            });
            if (types.version) sets.push('version = version + 1');
            if (types.updated_at) sets.push('updated_at = NOW()');
            params.push(id);
            await client.query(`UPDATE ${spec.table} SET ${sets.join(', ')} WHERE id = $${params.length}`, params);
            await client.query(
              `INSERT INTO audit_log (user_id, entity_type, entity_id, action, previous_values, new_values)
               VALUES ($1, $2, $3, 'repair', $4, $5)`,
              [
                SYSTEM_USER_ID, spec.entityType, id,
                JSON.stringify(Object.fromEntries(ready.map((d) => [d.field, locked![d.field]]))),
                JSON.stringify({
                  ...Object.fromEntries(ready.map((d) => [d.field, d.before])),
                  reason: 'Put back after the zod 4 edit-defaults bug (repair-zod4-update-defaults.ts)',
                }),
              ],
            );
          }
          await client.query('COMMIT');
          if (ready.length < toWrite.length) console.log('    (some fields changed while running — left alone)');
        } catch (err) {
          await client.query('ROLLBACK').catch(() => {});
          console.error(`    FAILED to write this record: ${(err as Error).message}`);
        }
      }
      console.log('');
    }

    console.log('Summary');
    console.log(`  ${commit ? 'restored' : 'would restore'}: ${totals.restored}`);
    console.log(`  review (not restored${includeReview ? '' : ' — add --include-review'}): ${totals.review}`);
    console.log(`  check by hand: ${totals.noRecord}`);
    console.log(`  already changed since: ${totals.alreadyChanged}`);
  } finally {
    client.release();
    await pool.end();
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
