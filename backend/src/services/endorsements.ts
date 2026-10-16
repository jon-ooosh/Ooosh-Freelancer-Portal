/**
 * Artist endorsements — THE place that reads and writes them (migration 290,
 * docs/DISCOUNTS-SPEC.md phase 1).
 *
 * A reference, not a calculator: brand, who, the deal as FREE TEXT, who
 * confirmed it and when it was last checked. Rules (jon, 16 Oct 2026):
 *  - it belongs to the ARTIST and follows them; it sits on a band only when the
 *    artist isn't in OP, with `who` saying who. Exactly one of person / org.
 *  - "confirmed" = any staff member got the nod from the brand's rep / A&R.
 *    Recording that stamps last_checked_on = today (UK).
 *  - a check older than STALE_AFTER_MONTHS is flagged; never confirmed is its
 *    own state. No expiry dates — we only ever see a snapshot.
 *  - ended, never deleted.
 */
import { query } from '../config/database';
import { ukToday } from './uk-date';
import { DISPLAY_NAME_SQL } from './display-name';

export const STALE_AFTER_MONTHS = 12;

export type CheckState = 'unconfirmed' | 'current' | 'stale';

export interface Endorsement {
  id: string;
  brand_id: string;
  brand_name: string;
  brand_standard_deal: string | null;
  person_id: string | null;
  person_name: string | null;
  organisation_id: string | null;
  organisation_name: string | null;
  who: string | null;
  deal: string | null;
  confirmed_with: string | null;
  last_checked_on: string | null; // YYYY-MM-DD
  last_checked_by_name: string | null;
  check_state: CheckState;
  notes: string | null;
  status: 'active' | 'ended';
  ended_reason: string | null;
  created_at: string;
  /** Only on forClientContext(): why it applies ("Band" / "Member of X") */
  via?: string;
}

/** SELECT list + joins; `$1` must be today's UK date. */
const SELECT = `
  SELECT e.id, e.brand_id, b.name AS brand_name, b.standard_deal AS brand_standard_deal,
         e.person_id, (SELECT ${DISPLAY_NAME_SQL} FROM people p WHERE p.id = e.person_id) AS person_name,
         e.organisation_id, o.name AS organisation_name,
         e.who, e.deal, e.confirmed_with,
         to_char(e.last_checked_on, 'YYYY-MM-DD') AS last_checked_on,
         (SELECT ${DISPLAY_NAME_SQL} FROM users cu JOIN people p ON p.id = cu.person_id WHERE cu.id = e.last_checked_by) AS last_checked_by_name,
         CASE
           WHEN e.last_checked_on IS NULL THEN 'unconfirmed'
           WHEN e.last_checked_on < ($1::date - INTERVAL '${STALE_AFTER_MONTHS} months') THEN 'stale'
           ELSE 'current'
         END AS check_state,
         e.notes, e.status, e.ended_reason, e.created_at
    FROM artist_endorsements e
    JOIN endorsement_brands b ON b.id = e.brand_id
    LEFT JOIN organisations o ON o.id = e.organisation_id`;

const ORDER = `ORDER BY b.name, COALESCE((SELECT p.last_name FROM people p WHERE p.id = e.person_id), o.name)`;

export async function listEndorsements(filter: {
  personId?: string; organisationId?: string; brandId?: string; state?: CheckState; includeEnded?: boolean;
  /** With organisationId: also its CURRENT members' personal endorsements (the band page) */
  includeMembers?: boolean;
}): Promise<Endorsement[]> {
  const params: unknown[] = [ukToday()];
  const where: string[] = [];
  if (!filter.includeEnded) where.push(`e.status = 'active'`);
  if (filter.personId) { params.push(filter.personId); where.push(`e.person_id = $${params.length}`); }
  if (filter.organisationId) {
    params.push(filter.organisationId);
    const n = params.length;
    where.push(filter.includeMembers
      ? `(e.organisation_id = $${n} OR e.person_id IN (
           SELECT por.person_id FROM person_organisation_roles por
            WHERE por.organisation_id = $${n} AND por.status = 'active'))`
      : `e.organisation_id = $${n}`);
  }
  if (filter.brandId) { params.push(filter.brandId); where.push(`e.brand_id = $${params.length}`); }
  let sql = `${SELECT} ${where.length ? `WHERE ${where.join(' AND ')}` : ''}`;
  if (filter.state) {
    params.push(filter.state);
    sql = `SELECT * FROM (${sql}) x WHERE x.check_state = $${params.length}`;
    return (await query(`${sql} ORDER BY x.brand_name, COALESCE(x.person_name, x.organisation_name)`, params)).rows;
  }
  return (await query(`${sql} ${ORDER}`, params)).rows;
}

export async function getEndorsement(id: string): Promise<Endorsement | null> {
  const r = await query(`${SELECT} WHERE e.id = $2`, [ukToday(), id]);
  return r.rows[0] || null;
}

/**
 * What applies to an enquiry / job for these orgs (client, band): each org's own
 * endorsements, plus the personal ones of its CURRENT members. Active only.
 */
export async function forClientContext(orgIds: string[]): Promise<Endorsement[]> {
  const ids = Array.from(new Set(orgIds.filter(Boolean)));
  if (ids.length === 0) return [];
  const r = await query(
    `SELECT x.*, CASE WHEN x.organisation_id IS NOT NULL THEN 'Band' ELSE 'Member of ' || m.org_names END AS via
       FROM (${SELECT} WHERE e.status = 'active') x
       LEFT JOIN LATERAL (
         SELECT string_agg(mo.name, ', ' ORDER BY mo.name) AS org_names
           FROM person_organisation_roles por
           JOIN organisations mo ON mo.id = por.organisation_id
          WHERE por.person_id = x.person_id AND por.status = 'active' AND por.organisation_id = ANY($2::uuid[])
       ) m ON true
      WHERE x.organisation_id = ANY($2::uuid[])
         OR (x.person_id IS NOT NULL AND m.org_names IS NOT NULL)
      ORDER BY x.brand_name`,
    [ukToday(), ids]
  );
  return r.rows;
}

export interface EndorsementInput {
  brand_id: string;
  person_id?: string | null;
  organisation_id?: string | null;
  who?: string | null;
  deal?: string | null;
  confirmed_with?: string | null;
  notes?: string | null;
  /** Record "confirmed today" as part of this save */
  checked_now?: boolean;
}

const blank = (v: string | null | undefined) => (v && v.trim() ? v.trim() : null);

export async function createEndorsement(input: EndorsementInput, userId: string): Promise<Endorsement> {
  const r = await query(
    `INSERT INTO artist_endorsements
       (brand_id, person_id, organisation_id, who, deal, confirmed_with, notes,
        last_checked_on, last_checked_by, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     RETURNING id`,
    [
      input.brand_id, input.person_id || null, input.organisation_id || null,
      blank(input.who), blank(input.deal), blank(input.confirmed_with), blank(input.notes),
      input.checked_now ? ukToday() : null, input.checked_now ? userId : null, userId,
    ]
  );
  return (await getEndorsement(r.rows[0].id))!;
}

/** Edit the text fields, the brand, or who it sits on ("Move to person"). */
export async function updateEndorsement(id: string, input: EndorsementInput, userId: string): Promise<Endorsement | null> {
  const r = await query(
    `UPDATE artist_endorsements SET
       brand_id = $2, person_id = $3, organisation_id = $4, who = $5, deal = $6,
       confirmed_with = $7, notes = $8,
       last_checked_on = CASE WHEN $9::boolean THEN $10::date ELSE last_checked_on END,
       last_checked_by = CASE WHEN $9::boolean THEN $11::uuid ELSE last_checked_by END,
       updated_at = NOW()
     WHERE id = $1 RETURNING id`,
    [
      id, input.brand_id, input.person_id || null, input.organisation_id || null,
      blank(input.who), blank(input.deal), blank(input.confirmed_with), blank(input.notes),
      !!input.checked_now, ukToday(), userId,
    ]
  );
  return r.rows[0] ? getEndorsement(id) : null;
}

/** "Rep confirmed it again today" — optionally recording who this time. */
export async function markChecked(id: string, userId: string, confirmedWith?: string | null): Promise<Endorsement | null> {
  const r = await query(
    `UPDATE artist_endorsements
        SET last_checked_on = $2, last_checked_by = $3,
            confirmed_with = COALESCE($4, confirmed_with), updated_at = NOW()
      WHERE id = $1 AND status = 'active' RETURNING id`,
    [id, ukToday(), userId, blank(confirmedWith)]
  );
  return r.rows[0] ? getEndorsement(id) : null;
}

export async function endEndorsement(id: string, reason: string | null): Promise<Endorsement | null> {
  const r = await query(
    `UPDATE artist_endorsements
        SET status = 'ended', ended_at = NOW(), ended_reason = $2, updated_at = NOW()
      WHERE id = $1 AND status = 'active' RETURNING id`,
    [id, blank(reason)]
  );
  return r.rows[0] ? getEndorsement(id) : null;
}

// ── Brands ──────────────────────────────────────────────────────────────────

export interface EndorsementBrand { id: string; name: string; standard_deal: string | null; is_active: boolean }

export async function listBrands(includeInactive = false): Promise<EndorsementBrand[]> {
  const r = await query(
    `SELECT id, name, standard_deal, is_active FROM endorsement_brands
      ${includeInactive ? '' : 'WHERE is_active = true'} ORDER BY LOWER(name)`
  );
  return r.rows;
}

/** Add a brand; a name that already exists (any case) comes back as the existing row. */
export async function addBrand(name: string, standardDeal: string | null): Promise<EndorsementBrand> {
  const r = await query(
    `INSERT INTO endorsement_brands (name, standard_deal) VALUES ($1, $2)
     ON CONFLICT ((LOWER(name))) DO UPDATE SET is_active = true, updated_at = NOW()
     RETURNING id, name, standard_deal, is_active`,
    [name.trim(), blank(standardDeal)]
  );
  return r.rows[0];
}

export async function updateBrand(id: string, fields: { name?: string; standard_deal?: string | null; is_active?: boolean }): Promise<EndorsementBrand | null> {
  const r = await query(
    `UPDATE endorsement_brands SET
       name = COALESCE($2, name),
       standard_deal = CASE WHEN $3::boolean THEN $4 ELSE standard_deal END,
       is_active = COALESCE($5, is_active),
       updated_at = NOW()
     WHERE id = $1 RETURNING id, name, standard_deal, is_active`,
    [id, fields.name?.trim() || null, fields.standard_deal !== undefined, blank(fields.standard_deal ?? null), fields.is_active ?? null]
  );
  return r.rows[0] || null;
}
