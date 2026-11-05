/**
 * "Have they read it?" for freelancer documents (jon, Nov 2026;
 * docs/FREELANCER-PORTAL-SPEC.md §8, migration 333). THE definition: the
 * portal's Resources, the dashboard banner, the Staff Documents list and the
 * freelancer's record all ask this.
 *
 * - A document asks for a read when it is shared with freelancers, live
 *   (active + approved) and `freelancer_read_required` is on.
 * - A read belongs to a VERSION: "New version" on the Staff Documents page asks
 *   everyone again; an edit to the title or settings doesn't.
 * - Who is asked: approved freelancers with a portal login (not the office's
 *   shared portal account, which is staff).
 * - Nothing is blocked by an unread document. The portal reminds; staff see who.
 *   A tick proves they tapped it, not that they read it: it is a dated record
 *   that they were given it (like signing for a parcel).
 */
import { query } from '../config/database';

/** The documents that ask freelancers for a read, on `d` (staff_documents). */
const READ_REQUIRED_DOC_SQL = `d.is_active = true AND d.approval_status = 'approved'
  AND d.shareable_with_freelancers = true AND d.freelancer_read_required = true`;

/** The freelancers who are asked, on `p` (people). */
export const READ_AUDIENCE_SQL = `p.is_freelancer = true AND p.is_approved = true
  AND COALESCE(p.is_deleted, false) = false
  AND COALESCE(p.is_portal_shared_account, false) = false
  AND p.portal_password_hash IS NOT NULL`;

export interface UnreadDocument { id: string; title: string }

/** The documents this freelancer still has to read (current versions), oldest first. */
export async function unreadFor(personId: string): Promise<UnreadDocument[]> {
  const r = await query(
    `SELECT d.id, d.title
       FROM staff_documents d
       JOIN staff_document_versions v ON v.document_id = d.id AND v.is_current = true
      WHERE ${READ_REQUIRED_DOC_SQL}
        AND NOT EXISTS (SELECT 1 FROM freelancer_document_reads r
                         WHERE r.version_id = v.id AND r.person_id = $1)
      ORDER BY d.created_at, d.title`,
    [personId],
  );
  return r.rows.map((x) => ({ id: x.id as string, title: x.title as string }));
}

/** When this freelancer read each document's current version: document id → ISO time. */
export async function readTimesFor(personId: string): Promise<Map<string, string>> {
  const r = await query(
    `SELECT v.document_id, r.read_at
       FROM freelancer_document_reads r
       JOIN staff_document_versions v ON v.id = r.version_id AND v.is_current = true
      WHERE r.person_id = $1`,
    [personId],
  );
  return new Map(r.rows.map((x) => [x.document_id as string, new Date(x.read_at).toISOString()]));
}

/**
 * Record that a freelancer has read a document's current version. Refuses a
 * document that doesn't ask for a read (or isn't live). A second tap is a no-op
 * that returns the first time.
 */
export async function markRead(
  personId: string, documentId: string,
): Promise<{ ok: true; readAt: string } | { ok: false; reason: 'not_found' }> {
  const doc = await query(
    `SELECT v.id AS version_id
       FROM staff_documents d
       JOIN staff_document_versions v ON v.document_id = d.id AND v.is_current = true
      WHERE d.id = $1 AND ${READ_REQUIRED_DOC_SQL}`,
    [documentId],
  );
  const versionId = doc.rows[0]?.version_id as string | undefined;
  if (!versionId) return { ok: false, reason: 'not_found' };
  await query(
    `INSERT INTO freelancer_document_reads (document_id, version_id, person_id)
     VALUES ($1, $2, $3)
     ON CONFLICT (version_id, person_id) DO NOTHING`,
    [documentId, versionId, personId],
  );
  const r = await query(
    `SELECT read_at FROM freelancer_document_reads WHERE version_id = $1 AND person_id = $2`,
    [versionId, personId],
  );
  return { ok: true, readAt: new Date(r.rows[0].read_at).toISOString() };
}

export interface DocumentReaders {
  version: number | null;
  read: { personId: string; name: string; readAt: string }[];
  notYet: { personId: string; name: string; lastLogin: string | null }[];
}

/** For staff: who has read a document's current version, and who hasn't yet. */
export async function readersOf(documentId: string): Promise<DocumentReaders> {
  const v = await query(
    `SELECT id, version FROM staff_document_versions WHERE document_id = $1 AND is_current = true`,
    [documentId],
  );
  const versionId = v.rows[0]?.id as string | undefined;
  const people = await query(
    `SELECT p.id, p.first_name, p.last_name, p.preferred_name, p.portal_last_login, r.read_at
       FROM people p
       LEFT JOIN freelancer_document_reads r ON r.person_id = p.id AND r.version_id = $1
      WHERE ${READ_AUDIENCE_SQL}
      ORDER BY p.first_name, p.last_name`,
    [versionId ?? null],
  );
  const name = (x: Record<string, unknown>) =>
    [x.preferred_name || x.first_name, x.last_name].filter(Boolean).join(' ').trim() || 'Freelancer';
  const read = people.rows.filter((x) => x.read_at)
    .map((x) => ({ personId: x.id as string, name: name(x), readAt: new Date(x.read_at).toISOString() }))
    .sort((a, b) => b.readAt.localeCompare(a.readAt));
  const notYet = people.rows.filter((x) => !x.read_at)
    .map((x) => ({ personId: x.id as string, name: name(x), lastLogin: x.portal_last_login ? new Date(x.portal_last_login).toISOString() : null }));
  return { version: (v.rows[0]?.version as number | undefined) ?? null, read, notYet };
}

export interface PersonDocumentRead { id: string; title: string; version: number; readAt: string | null }

/** For a freelancer's record: every document that asks for a read, and when they read it. */
export async function documentsForPerson(personId: string): Promise<PersonDocumentRead[]> {
  const r = await query(
    `SELECT d.id, d.title, v.version, r.read_at
       FROM staff_documents d
       JOIN staff_document_versions v ON v.document_id = d.id AND v.is_current = true
       LEFT JOIN freelancer_document_reads r ON r.version_id = v.id AND r.person_id = $1
      WHERE ${READ_REQUIRED_DOC_SQL}
      ORDER BY d.created_at, d.title`,
    [personId],
  );
  return r.rows.map((x) => ({
    id: x.id as string, title: x.title as string, version: Number(x.version),
    readAt: x.read_at ? new Date(x.read_at).toISOString() : null,
  }));
}
