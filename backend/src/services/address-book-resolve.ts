/**
 * Find-or-create for the address book — people by EXACT email, organisations
 * by EXACT (case/space-normalised) name, and the person ↔ org link.
 *
 * Shared by the website enquiry intake (`routes/enquiry-intake.ts`) and the
 * Lead Finder's "Add to address book" (`routes/leads.ts`), so a person or band
 * arriving from either place resolves the same way.
 *
 * Exact only, deliberately (jon, Oct 2026): auto-linking an inbound contact on
 * a fuzzy match is a risk. Where staff are in the loop (Leads), the soft
 * "did you mean…?" suggestions come from `services/leads/matcher.ts` and a
 * human picks — this module never guesses.
 */
import { query } from '../config/database';

/** "Jo Bloggs Smith" → { first: "Jo", last: "Bloggs Smith" }. */
export function splitName(full: string): { first: string; last: string } {
  const parts = full.trim().split(/\s+/);
  return { first: parts[0] || full.trim(), last: parts.slice(1).join(' ') };
}

/** The most recently updated live person with this email (case-insensitive). */
export async function findPersonByEmail(email: string): Promise<string | null> {
  const r = await query(
    `SELECT id FROM people
     WHERE LOWER(email) = $1 AND is_deleted = false
     ORDER BY updated_at DESC LIMIT 1`,
    [email.trim().toLowerCase()],
  );
  return (r.rows[0]?.id as string | undefined) ?? null;
}

export async function findOrCreatePersonByEmail(input: {
  email: string;
  firstName: string;
  lastName: string;
  phone?: string | null;
  notes: string;
  createdBy: string;
}): Promise<{ id: string; outcome: 'existing' | 'created' }> {
  const email = input.email.trim().toLowerCase();
  const existing = await findPersonByEmail(email);
  if (existing) return { id: existing, outcome: 'existing' };
  const created = await query(
    `INSERT INTO people (first_name, last_name, email, phone, notes, created_by)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
    [input.firstName, input.lastName, email, input.phone ?? null, input.notes, input.createdBy],
  );
  return { id: created.rows[0].id as string, outcome: 'created' };
}

/**
 * Exact normalised-name lookup. One hit → its id. None → null. Two or more →
 * null + ambiguous (don't guess between them).
 */
export async function findOrgByExactName(name: string): Promise<{ id: string | null; ambiguous: boolean }> {
  const r = await query(
    `SELECT id FROM organisations
     WHERE LOWER(TRIM(name)) = LOWER(TRIM($1)) AND is_deleted = false
     LIMIT 2`,
    [name],
  );
  if (r.rows.length === 1) return { id: r.rows[0].id as string, ambiguous: false };
  return { id: null, ambiguous: r.rows.length > 1 };
}

export async function createOrganisation(input: {
  name: string;
  type: string;
  notes: string;
  createdBy: string;
}): Promise<string> {
  const r = await query(
    `INSERT INTO organisations (name, type, notes, created_by)
     VALUES ($1, $2, $3, $4) RETURNING id`,
    [input.name.trim(), input.type, input.notes, input.createdBy],
  );
  return r.rows[0].id as string;
}

/**
 * Exact name match → link; no match → create; several exact matches → leave
 * unlinked (ambiguous — a human sorts it out).
 */
export async function resolveOrCreateOrganisation(input: {
  name: string;
  type: string;
  notes: string;
  createdBy: string;
}): Promise<{ id: string | null; outcome: 'existing' | 'created' | 'unlinked' }> {
  const found = await findOrgByExactName(input.name);
  if (found.id) return { id: found.id, outcome: 'existing' };
  if (found.ambiguous) return { id: null, outcome: 'unlinked' };
  return { id: await createOrganisation(input), outcome: 'created' };
}

/** Add an active person ↔ org role unless one already exists. Returns true if it added one. */
export async function linkPersonToOrganisation(personId: string, orgId: string, role: string): Promise<boolean> {
  const existing = await query(
    `SELECT id FROM person_organisation_roles
     WHERE person_id = $1 AND organisation_id = $2 AND status = 'active' LIMIT 1`,
    [personId, orgId],
  );
  if (existing.rows.length > 0) return false;
  await query(
    `INSERT INTO person_organisation_roles (person_id, organisation_id, role, status)
     VALUES ($1, $2, $3, 'active')`,
    [personId, orgId, role],
  );
  return true;
}

/**
 * A shared inbox rather than a person — info@, bookings@, hello@… Saving one
 * as a "person" gives the address book someone called "Info". The Lead
 * Finder offers these as the ORGANISATION's email instead.
 */
const GENERIC_MAILBOXES = new Set([
  'info', 'information', 'hello', 'hi', 'contact', 'contactus', 'enquiries', 'enquiry', 'inquiries',
  'booking', 'bookings', 'management', 'mgmt', 'admin', 'office', 'mail', 'email', 'general',
  'team', 'press', 'media', 'pr', 'music', 'band', 'tour', 'touring', 'live', 'shows', 'agent',
  'agency', 'support', 'sales', 'studio', 'label', 'records', 'hq', 'all',
]);

export function isGenericMailbox(email: string | null | undefined): boolean {
  const local = (email ?? '').trim().toLowerCase().split('@')[0];
  if (!local) return false;
  return GENERIC_MAILBOXES.has(local.replace(/[^a-z]/g, ''));
}

/**
 * Put a shared inbox on an organisation: as its email if it has none, otherwise
 * noted (never overwrites an email staff entered). Returns what it did.
 */
export async function addOrganisationEmail(orgId: string, email: string, source: string): Promise<'set' | 'noted' | 'already'> {
  const r = await query(`SELECT email, notes FROM organisations WHERE id = $1`, [orgId]);
  const row = r.rows[0];
  if (!row) return 'already';
  const clean = email.trim();
  const current = (row.email as string | null)?.trim() || '';
  if (current.toLowerCase() === clean.toLowerCase() || (row.notes as string | null)?.toLowerCase().includes(clean.toLowerCase())) {
    return 'already';
  }
  if (!current) {
    await query(`UPDATE organisations SET email = $2, updated_at = NOW() WHERE id = $1`, [orgId, clean]);
    return 'set';
  }
  await query(
    `UPDATE organisations
        SET notes = CASE WHEN notes IS NULL OR notes = '' THEN $2 ELSE notes || E'\\n' || $2 END,
            updated_at = NOW()
      WHERE id = $1`,
    [orgId, `Other email: ${clean} (${source})`],
  );
  return 'noted';
}

