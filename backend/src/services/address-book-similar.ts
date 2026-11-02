/**
 * "Did you mean…?" while CREATING a person or organisation.
 *
 * Fuzzy on purpose (pg_trgm, installed in migration 001): "Jon Smith" finds
 * "John Smith", "The 1000 Mods" finds "1000mods". It only ever WARNS — the
 * form still saves (warnings, not gates). The after-the-fact clean-up is the
 * Duplicates page (routes/duplicates.ts), which matches exactly.
 */
import { query } from '../config/database';
import { phoneDigitsForSearch } from './address-book-search';

export interface SimilarRecord {
  id: string;
  name: string;
  detail: string | null;
  reason: string;
}

const PERSON_NAME_THRESHOLD = 0.45;
const ORG_NAME_THRESHOLD = 0.4;

export async function findSimilarPeople(input: { first?: string; last?: string; phone?: string; excludeId?: string }): Promise<SimilarRecord[]> {
  const fullName = `${(input.first || '').trim()} ${(input.last || '').trim()}`.trim();
  const phone = input.phone ? phoneDigitsForSearch(input.phone) : null;
  if (fullName.length < 4 && !phone) return [];

  const r = await query(
    `SELECT p.id, CONCAT(p.first_name, ' ', p.last_name) AS name, p.email,
            (SELECT string_agg(o.name, ', ') FROM person_organisation_roles por
               JOIN organisations o ON o.id = por.organisation_id AND o.is_deleted = false
              WHERE por.person_id = p.id AND por.status = 'active') AS orgs,
            similarity(LOWER(CONCAT(p.first_name, ' ', p.last_name)), LOWER($1)) AS score,
            ($2::text IS NOT NULL AND regexp_replace(CONCAT_WS(' ', p.mobile, p.phone, p.international_phone), '\\D', '', 'g') LIKE '%' || $2::text || '%') AS phone_match
       FROM people p
      WHERE p.is_deleted = false
        AND ($3::uuid IS NULL OR p.id <> $3::uuid)
        AND (
          (LENGTH($1) >= 4 AND similarity(LOWER(CONCAT(p.first_name, ' ', p.last_name)), LOWER($1)) >= $4)
          OR ($2::text IS NOT NULL AND regexp_replace(CONCAT_WS(' ', p.mobile, p.phone, p.international_phone), '\\D', '', 'g') LIKE '%' || $2::text || '%')
        )
      ORDER BY phone_match DESC, score DESC
      LIMIT 5`,
    [fullName, phone, input.excludeId || null, PERSON_NAME_THRESHOLD]
  );
  return r.rows.map((row: any) => ({
    id: row.id,
    name: row.name,
    detail: [row.orgs, row.email].filter(Boolean).join(' · ') || null,
    reason: row.phone_match ? 'Same phone number' : 'Similar name',
  }));
}

export async function findSimilarOrganisations(input: { name?: string; excludeId?: string }): Promise<SimilarRecord[]> {
  const name = (input.name || '').trim();
  if (name.length < 3) return [];

  // Compare without a leading "The " so "The 1000 Mods" and "1000mods" meet
  const r = await query(
    `SELECT o.id, o.name, o.type,
            similarity(regexp_replace(LOWER(o.name), '^the\\s+', ''), regexp_replace(LOWER($1), '^the\\s+', '')) AS score
       FROM organisations o
      WHERE o.is_deleted = false
        AND ($2::uuid IS NULL OR o.id <> $2::uuid)
        AND similarity(regexp_replace(LOWER(o.name), '^the\\s+', ''), regexp_replace(LOWER($1), '^the\\s+', '')) >= $3
      ORDER BY score DESC
      LIMIT 5`,
    [name, input.excludeId || null, ORG_NAME_THRESHOLD]
  );
  return r.rows.map((row: any) => ({
    id: row.id,
    name: row.name,
    detail: row.type || null,
    reason: Number(row.score) >= 0.99 ? 'Same name' : 'Similar name',
  }));
}
