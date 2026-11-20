/**
 * Premises & compliance — the documents library (docs/PREMISES-COMPLIANCE-SPEC.md §6, §15).
 *
 * What isn't a check: the lease, insurance schedules, plans and drawings, the
 * asbestos survey, manuals and warranties. Folders hold documents; a
 * document's files are its versions (newest is current — nothing is replaced).
 *
 * THE RULES THIS FILE KEEPS:
 *   * A folder has a visibility; a document may be set TIGHTER, never looser
 *     (a lease copy in an everyone folder can be admins-only, not the reverse).
 *     The effective visibility is the tighter of the two — effectiveSql() /
 *     effectiveVisibility(), one rule for the list and the file gate.
 *   * A document you can't see doesn't exist for you (404, like a check).
 *   * Adding, changing and archiving documents is manager-tier; folders are
 *     admin. Nothing is deleted: documents are archived, folders retired.
 */
import { query } from '../config/database';
import { VISIBILITIES, VIS_RANK as RANK, Visibility, canSee, effectiveVisibility, roleRank, visibleLevels } from './premises-rules';
import { PremisesError } from './premises-errors';
import type { Caller } from './premises';

/** The same rule in SQL (alias d = premises_documents, fo = premises_folders). */
const EFFECTIVE_SQL = `CASE
    WHEN d.visibility = 'admins' OR fo.visibility = 'admins' THEN 'admins'
    WHEN d.visibility = 'managers' OR fo.visibility = 'managers' THEN 'managers'
    ELSE 'all' END`;

function isManager(role: string | undefined) { return roleRank(role) >= 1; }
function isAdmin(role: string | undefined) { return roleRank(role) >= 2; }
const trimOrNull = (v: string | null | undefined) => (v && v.trim() ? v.trim() : null);

/** Every folder and document the caller may see, each document's files newest first. */
export async function getLibrary(role: string | undefined) {
  const levels = visibleLevels(role);
  const folders = await query(
    `SELECT id, name, visibility, sort_order FROM premises_folders
      WHERE retired_at IS NULL AND visibility = ANY($1::text[])
      ORDER BY sort_order, name`, [levels]);
  const docs = await query(
    `SELECT d.id, d.folder_id, d.title, d.visibility, d.place_id, p.name AS place_name, d.notes,
            d.created_at, d.updated_at, ${EFFECTIVE_SQL} AS effective_visibility,
            COALESCE((
              SELECT json_agg(json_build_object('id', f.id, 'r2_key', f.r2_key, 'filename', f.filename,
                                                'content_type', f.content_type, 'size_bytes', f.size_bytes,
                                                'uploaded_by', f.uploaded_by, 'created_at', f.created_at)
                              ORDER BY f.created_at DESC)
                FROM premises_files f WHERE f.document_id = d.id AND f.archived_at IS NULL
            ), '[]'::json) AS files
       FROM premises_documents d
       JOIN premises_folders fo ON fo.id = d.folder_id
       LEFT JOIN premises_places p ON p.id = d.place_id
      WHERE d.archived_at IS NULL AND fo.retired_at IS NULL
        AND ${EFFECTIVE_SQL} = ANY($1::text[])
      ORDER BY d.title`, [levels]);
  return folders.rows.map((f: { id: string }) => ({
    ...f,
    documents: docs.rows.filter((d: { folder_id: string }) => d.folder_id === f.id),
  }));
}

/** Folders for the admin's list — retired ones too. */
export async function listFolders(role: string | undefined) {
  if (!isAdmin(role)) throw new PremisesError('Only an admin can change folders', 403);
  const r = await query(`SELECT id, name, visibility, sort_order, retired_at FROM premises_folders ORDER BY sort_order, name`);
  return r.rows;
}

async function folderFor(folderId: string, role: string | undefined) {
  const r = await query(`SELECT id, visibility, retired_at FROM premises_folders WHERE id = $1`, [folderId]);
  const f = r.rows[0] as { id: string; visibility: Visibility; retired_at: string | null } | undefined;
  if (!f || !canSee(role, f.visibility)) throw new PremisesError('Pick a folder');
  if (f.retired_at) throw new PremisesError('That folder has been retired — pick another');
  return f;
}

/** A document the caller may see, or 404. */
async function visibleDocument(id: string, role: string | undefined) {
  const r = await query(
    `SELECT d.id, d.folder_id, d.visibility, d.archived_at, fo.visibility AS folder_visibility
       FROM premises_documents d JOIN premises_folders fo ON fo.id = d.folder_id WHERE d.id = $1`, [id]);
  const d = r.rows[0] as { id: string; folder_id: string; visibility: string | null; archived_at: string | null; folder_visibility: string } | undefined;
  if (!d || !canSee(role, effectiveVisibility(d.visibility, d.folder_visibility))) throw new PremisesError('Document not found', 404);
  return d;
}

function assertDocVisibility(visibility: string | null, folderVisibility: Visibility, role: string | undefined) {
  if (visibility === null) return;
  if (!(VISIBILITIES as readonly string[]).includes(visibility)) throw new PremisesError('Say who can see it');
  if (!canSee(role, visibility)) throw new PremisesError('You can’t make a document only people above you can see');
  if (RANK[visibility as Visibility] < RANK[folderVisibility]) {
    throw new PremisesError('A document can’t be seen by more people than its folder — move it, or leave it as the folder’s');
  }
}

async function assertPlace(placeId: string | null) {
  if (!placeId) return;
  const r = await query(`SELECT 1 FROM premises_places WHERE id = $1`, [placeId]);
  if (!r.rows.length) throw new PremisesError('Pick a place');
}

export interface DocumentInput {
  folder_id: string;
  title: string;
  visibility: string | null;
  place_id: string | null;
  notes: string | null;
}

export async function createDocument(input: DocumentInput, caller: Caller) {
  if (!isManager(caller.role)) throw new PremisesError('Only a manager can add a document', 403);
  if (!input.title?.trim()) throw new PremisesError('Give it a title');
  const folder = await folderFor(input.folder_id, caller.role);
  assertDocVisibility(input.visibility, folder.visibility, caller.role);
  await assertPlace(input.place_id);
  const r = await query(
    `INSERT INTO premises_documents (folder_id, title, visibility, place_id, notes, created_by)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
    [input.folder_id, input.title.trim().slice(0, 200), input.visibility, input.place_id, trimOrNull(input.notes), caller.userId]);
  return { id: r.rows[0].id as string };
}

/** Change a document — only the fields sent. */
export async function updateDocument(id: string, patch: Partial<DocumentInput>, caller: Caller) {
  if (!isManager(caller.role)) throw new PremisesError('Only a manager can change a document', 403);
  const cur = await visibleDocument(id, caller.role);
  const folderId = patch.folder_id ?? cur.folder_id;
  const folder = patch.folder_id && patch.folder_id !== cur.folder_id
    ? await folderFor(folderId, caller.role)
    : { visibility: cur.folder_visibility as Visibility };
  const visibility = patch.visibility !== undefined ? patch.visibility : cur.visibility;
  assertDocVisibility(visibility, folder.visibility, caller.role);
  if (patch.title !== undefined && !patch.title.trim()) throw new PremisesError('Give it a title');
  if (patch.place_id !== undefined) await assertPlace(patch.place_id);
  await query(
    `UPDATE premises_documents
        SET folder_id = $2, visibility = $3,
            title = COALESCE($4, title),
            place_id = CASE WHEN $5::boolean THEN $6::uuid ELSE place_id END,
            notes = CASE WHEN $7::boolean THEN $8 ELSE notes END,
            updated_at = NOW()
      WHERE id = $1`,
    [id, folderId, visibility, patch.title?.trim().slice(0, 200) ?? null,
     patch.place_id !== undefined, patch.place_id ?? null,
     patch.notes !== undefined, trimOrNull(patch.notes ?? null)]);
}

export async function archiveDocument(id: string, caller: Caller) {
  if (!isManager(caller.role)) throw new PremisesError('Only a manager can archive a document', 403);
  await visibleDocument(id, caller.role);
  await query(`UPDATE premises_documents SET archived_at = NOW(), archived_by = $2 WHERE id = $1 AND archived_at IS NULL`,
    [id, caller.userId]);
}

/** Before a new version is uploaded: a live document the caller may see, and a manager. */
export async function documentForUpload(id: string, caller: Caller) {
  if (!isManager(caller.role)) throw new PremisesError('Only a manager can add a version', 403);
  const d = await visibleDocument(id, caller.role);
  if (d.archived_at) throw new PremisesError('That document has been archived');
  return d;
}

export async function addDocumentFile(documentId: string, f: {
  id: string; r2Key: string; filename: string; contentType: string | null; size: number;
}, caller: Caller) {
  await query(
    `INSERT INTO premises_files (id, document_id, r2_key, filename, content_type, size_bytes, uploaded_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [f.id, documentId, f.r2Key, f.filename.slice(0, 255), f.contentType, f.size, caller.userId]);
  await query(`UPDATE premises_documents SET updated_at = NOW() WHERE id = $1`, [documentId]);
}

// ── Folders (admins) ────────────────────────────────────────────────────────

export async function addFolder(name: string, visibility: string, caller: Caller) {
  if (!isAdmin(caller.role)) throw new PremisesError('Only an admin can change folders', 403);
  if (!name?.trim()) throw new PremisesError('Give it a name');
  if (!(VISIBILITIES as readonly string[]).includes(visibility)) throw new PremisesError('Say who can see it');
  const r = await query(
    `INSERT INTO premises_folders (name, visibility, sort_order)
     VALUES ($1, $2, COALESCE((SELECT MAX(sort_order) FROM premises_folders), 0) + 1) RETURNING id`,
    [name.trim().slice(0, 100), visibility]);
  return { id: r.rows[0].id as string };
}

export async function updateFolder(id: string, patch: { name?: string; visibility?: string; sort_order?: number; retired?: boolean }, caller: Caller) {
  if (!isAdmin(caller.role)) throw new PremisesError('Only an admin can change folders', 403);
  const r = await query(`SELECT id FROM premises_folders WHERE id = $1`, [id]);
  if (!r.rows.length) throw new PremisesError('Not found', 404);
  if (patch.name !== undefined) {
    if (!patch.name.trim()) throw new PremisesError('Give it a name');
    await query(`UPDATE premises_folders SET name = $2 WHERE id = $1`, [id, patch.name.trim().slice(0, 100)]);
  }
  if (patch.visibility !== undefined) {
    if (!(VISIBILITIES as readonly string[]).includes(patch.visibility)) throw new PremisesError('Say who can see it');
    // A document set tighter than the folder stays tighter; a looser one follows
    // the folder (effectiveVisibility takes the tighter of the two).
    await query(`UPDATE premises_folders SET visibility = $2 WHERE id = $1`, [id, patch.visibility]);
  }
  if (patch.sort_order !== undefined) {
    await query(`UPDATE premises_folders SET sort_order = $2 WHERE id = $1`, [id, Math.round(patch.sort_order)]);
  }
  if (patch.retired === true) {
    const used = await query(`SELECT COUNT(*)::int AS n FROM premises_documents WHERE folder_id = $1 AND archived_at IS NULL`, [id]);
    const n = used.rows[0].n as number;
    if (n > 0) throw new PremisesError(`${n} document${n === 1 ? ' is' : 's are'} still in it — move or archive ${n === 1 ? 'it' : 'them'} first`, 409);
    await query(`UPDATE premises_folders SET retired_at = NOW() WHERE id = $1`, [id]);
  } else if (patch.retired === false) {
    await query(`UPDATE premises_folders SET retired_at = NULL WHERE id = $1`, [id]);
  }
}
