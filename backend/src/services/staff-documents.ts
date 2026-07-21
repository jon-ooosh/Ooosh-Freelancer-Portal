/**
 * Staff Documents & Training — assignment resolver + helpers.
 *
 * The document's target_type is the RULE; staff_document_assignments rows are
 * the materialised per-user list. This resolver creates any missing pending
 * assignments for a document's current target set (and fires an "assigned"
 * bell notification). It is idempotent and additive — it never deletes an
 * assignment (audit), so de-targeting a user leaves their history in place.
 *
 * Read-only documents are library reference material and are NOT tracked, so
 * they never materialise assignments.
 *
 * See docs/STAFF-DOCUMENTS-SPEC.md.
 */
import { query } from '../config/database';

export interface StaffDocumentRow {
  id: string;
  slug: string;
  title: string;
  completion_mode: 'read_only' | 'tick' | 'sign';
  target_type: 'all_staff' | 'role' | 'list' | 'cot_card_holders';
  target_roles: string[] | null;
  target_user_ids: string[] | null;
  is_active: boolean;
}

/** Merge simple placeholders in a document body for a given user. */
export function renderDocumentBody(
  body: string | null,
  vars: { name?: string | null; last4?: string | null },
): string {
  if (!body) return '';
  return body
    .replace(/\[name\]/gi, (vars.name || '').trim() || '________')
    .replace(/\[last4\]/gi, (vars.last4 || '').trim() || '____');
}

/** Compute the current target user set for a document. Active non-freelancer users only. */
async function getTargetUserIds(doc: StaffDocumentRow): Promise<string[]> {
  const base = `SELECT id FROM users WHERE is_active = true AND role <> 'freelancer'`;
  switch (doc.target_type) {
    case 'all_staff': {
      const r = await query(base);
      return r.rows.map((x) => x.id as string);
    }
    case 'role': {
      const roles = doc.target_roles || [];
      if (!roles.length) return [];
      const r = await query(`${base} AND role = ANY($1)`, [roles]);
      return r.rows.map((x) => x.id as string);
    }
    case 'cot_card_holders': {
      const r = await query(`${base} AND cot_card_label IS NOT NULL`);
      return r.rows.map((x) => x.id as string);
    }
    case 'list': {
      const ids = doc.target_user_ids || [];
      if (!ids.length) return [];
      const r = await query(`${base} AND id = ANY($1)`, [ids]);
      return r.rows.map((x) => x.id as string);
    }
    default:
      return [];
  }
}

/**
 * Materialise pending assignments for a document's current target set + fire an
 * "assigned" notification to each newly-assigned user. Idempotent, additive.
 * No-op for read-only or inactive documents. Returns the count created.
 */
export async function syncDocumentAssignments(documentId: string): Promise<number> {
  const docRes = await query(
    `SELECT id, slug, title, completion_mode, target_type, target_roles, target_user_ids, is_active
       FROM staff_documents WHERE id = $1`,
    [documentId],
  );
  const doc = docRes.rows[0] as StaffDocumentRow | undefined;
  if (!doc || !doc.is_active || doc.completion_mode === 'read_only') return 0;

  const targetIds = await getTargetUserIds(doc);
  if (!targetIds.length) return 0;

  // Which of the target users have NO assignment row yet?
  const existing = await query(
    `SELECT user_id FROM staff_document_assignments WHERE document_id = $1 AND user_id = ANY($2)`,
    [documentId, targetIds],
  );
  const have = new Set(existing.rows.map((r) => r.user_id as string));
  const toAdd = targetIds.filter((uid) => !have.has(uid));
  if (!toAdd.length) return 0;

  const verb = doc.completion_mode === 'sign' ? 'sign' : 'review and acknowledge';
  let created = 0;
  for (const userId of toAdd) {
    const ins = await query(
      `INSERT INTO staff_document_assignments (document_id, user_id)
       VALUES ($1, $2)
       ON CONFLICT (document_id, user_id) DO NOTHING
       RETURNING id`,
      [documentId, userId],
    );
    if (!ins.rows.length) continue; // race — already existed
    created += 1;
    // Assigned notification (bell; escalation scheduler handles email per prefs).
    await query(
      `INSERT INTO notifications (user_id, type, title, content, entity_type, entity_id, action_url, priority)
       VALUES ($1, 'follow_up', $2, $3, 'staff_documents', $4, '/staff/documents', 'normal')`,
      [userId, `Document to ${verb}: ${doc.title}`,
       `Please ${verb} “${doc.title}” in your Staff Documents.`, documentId],
    ).catch((e) => console.error('[staff-documents] assign notification failed:', e));
  }
  return created;
}

/** Sync every active COT-card-holder-targeted document. Called when a card is issued. */
export async function syncCotCardHolderDocuments(): Promise<void> {
  const r = await query(
    `SELECT id FROM staff_documents
      WHERE is_active = true AND completion_mode <> 'read_only' AND target_type = 'cot_card_holders'`,
  );
  for (const row of r.rows) {
    await syncDocumentAssignments(row.id as string).catch((e) =>
      console.error('[staff-documents] cot-card doc sync failed:', e));
  }
}

/** Sync all active trackable documents (used on new-user create + the daily scheduler). */
export async function syncAllActiveDocuments(): Promise<void> {
  const r = await query(
    `SELECT id FROM staff_documents WHERE is_active = true AND completion_mode <> 'read_only'`,
  );
  for (const row of r.rows) {
    await syncDocumentAssignments(row.id as string).catch((e) =>
      console.error('[staff-documents] active doc sync failed:', e));
  }
}
