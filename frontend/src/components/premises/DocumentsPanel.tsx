/**
 * Premises & compliance › Documents — the library (docs/PREMISES-COMPLIANCE-SPEC.md §6, §15).
 *
 * What isn't a check: the lease, insurance schedules, plans, the asbestos
 * survey, manuals and warranties — in folders, each with a visibility. A
 * document's files are its versions: the newest is current, older ones stay.
 * "Certificates" at the top is read-through: each check's current certificate,
 * filed where it belongs (against its visit), shown here too.
 *
 * Who sees what is the server's (a hidden folder or document never arrives);
 * the buttons follow meta.can and the server checks again.
 */
import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../../services/api';
import { openR2Key } from '../../lib/openAuthedFile';
import {
  FolderRow, LibraryDocument, LibraryFolder, PremisesCheck, PremisesMeta, VISIBILITY_LABEL, VISIBILITY_RANK, Visibility, fmtDate,
} from './premisesCopy';

async function uploadVersion(documentId: string, file: File) {
  const fd = new FormData();
  fd.append('file', file);
  await api.upload(`/premises/documents/${documentId}/files`, fd);
}

const input = 'w-full px-3 py-2 border border-gray-300 rounded text-sm bg-white';
const label = 'block text-xs font-medium text-gray-600 mb-1';

/** Add or change a document. A document may be tighter than its folder, never looser. */
function DocumentFormModal({ meta, folders, doc, onClose, onSaved }: {
  meta: PremisesMeta;
  folders: LibraryFolder[];
  doc: LibraryDocument | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [folderId, setFolderId] = useState(doc?.folder_id ?? folders[0]?.id ?? '');
  const [title, setTitle] = useState(doc?.title ?? '');
  const [placeId, setPlaceId] = useState(doc?.place_id ?? '');
  const [visibility, setVisibility] = useState<Visibility | ''>(doc?.visibility ?? '');
  const [notes, setNotes] = useState(doc?.notes ?? '');
  const [file, setFile] = useState<File | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const folder = folders.find(f => f.id === folderId);
  // Tighter than the folder only — and never above the person choosing.
  const myRank = meta.can.admin ? 2 : meta.can.manage ? 1 : 0;
  const tighter = (['managers', 'admins'] as Visibility[]).filter(v =>
    folder && VISIBILITY_RANK[v] > VISIBILITY_RANK[folder.visibility] && VISIBILITY_RANK[v] <= myRank);
  const visChoice = visibility && tighter.includes(visibility) ? visibility : '';

  async function save() {
    setSaving(true); setError(null);
    const body = { folder_id: folderId, title: title.trim(), place_id: placeId || null, visibility: visChoice || null, notes: notes.trim() || null };
    try {
      let id = doc?.id;
      if (doc) await api.patch(`/premises/documents/${doc.id}`, body);
      else id = (await api.post<{ data: { id: string } }>('/premises/documents', body)).data.id;
      if (file && id) {
        try { await uploadVersion(id, file); }
        catch { setError(`Saved — but "${file.name}" didn't upload. Use "New version" to add it.`); setSaving(false); return; }
      }
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save it');
      setSaving(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/50" onClick={() => { if (!saving) onClose(); }} />
      <div className="relative bg-white rounded-xl shadow-xl w-full max-w-lg mx-4 p-6 max-h-[92vh] overflow-y-auto">
        <h3 className="text-lg font-semibold text-gray-900 mb-4">{doc ? 'Change document' : 'Add a document'}</h3>
        <div className="space-y-3">
          <div>
            <label className={label} htmlFor="pd-title">Title</label>
            <input id="pd-title" value={title} onChange={e => setTitle(e.target.value)} maxLength={200} autoFocus={!doc}
              placeholder="e.g. Lease — Compass House (2024)" className={input} />
          </div>
          <div className="grid sm:grid-cols-2 gap-3">
            <div>
              <label className={label} htmlFor="pd-folder">Folder</label>
              <select id="pd-folder" value={folderId} onChange={e => { setFolderId(e.target.value); setVisibility(''); }} className={input}>
                {folders.map(f => <option key={f.id} value={f.id}>{f.name}</option>)}
              </select>
            </div>
            <div>
              <label className={label} htmlFor="pd-place">Place</label>
              <select id="pd-place" value={placeId} onChange={e => setPlaceId(e.target.value)} className={input}>
                <option value="">—</option>
                {meta.places.filter(p => !p.retired_at || p.id === placeId).map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select>
            </div>
          </div>
          <div>
            <label className={label} htmlFor="pd-vis">Who can see it</label>
            <select id="pd-vis" value={visChoice} onChange={e => setVisibility(e.target.value as Visibility | '')} className={input}>
              <option value="">Same as the folder ({folder ? VISIBILITY_LABEL[folder.visibility].toLowerCase() : '—'})</option>
              {tighter.map(v => <option key={v} value={v}>{VISIBILITY_LABEL[v]}</option>)}
            </select>
            <p className="text-xs text-gray-500 mt-1">It can be tighter than its folder, never looser.</p>
          </div>
          <div>
            <label className={label} htmlFor="pd-notes">Notes</label>
            <textarea id="pd-notes" value={notes} onChange={e => setNotes(e.target.value)} rows={2} maxLength={4000} className={input} />
          </div>
          <div>
            <label className={label} htmlFor="pd-file">{doc ? 'Add a new version (optional)' : 'The file'}</label>
            <input id="pd-file" type="file" onChange={e => { const f = e.target.files?.[0] ?? null; e.target.value = ''; setFile(f); }}
              className="block w-full text-sm text-gray-600 file:mr-3 file:px-3 file:py-1.5 file:rounded file:border-0 file:bg-gray-100 file:text-gray-700" />
            {file && <p className="text-xs text-gray-600 mt-1">{file.name}</p>}
          </div>
        </div>
        {error && <p className="text-sm text-red-700 mt-4">{error}</p>}
        <div className="flex justify-end gap-2 mt-5">
          <button type="button" onClick={onClose} disabled={saving}
            className="px-3 py-1.5 text-sm rounded border border-gray-300 hover:bg-gray-50 disabled:opacity-40">Cancel</button>
          <button type="button" onClick={() => void save()} disabled={saving || !title.trim() || !folderId}
            className="px-3 py-1.5 text-sm rounded bg-ooosh-600 text-white hover:bg-ooosh-700 disabled:opacity-40">
            {saving ? 'Saving…' : doc ? 'Save' : 'Add document'}
          </button>
        </div>
      </div>
    </div>
  );
}

/** Folders — admins: rename, who can see it, order, add, retire. */
function FoldersModal({ onClose }: { onClose: () => void }) {
  const [rows, setRows] = useState<FolderRow[] | null>(null);
  const [names, setNames] = useState<Record<string, string>>({});
  const [adding, setAdding] = useState('');
  const [addVis, setAddVis] = useState<Visibility>('all');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const load = useCallback(async () => setRows((await api.get<{ data: FolderRow[] }>('/premises/folders')).data), []);
  useEffect(() => { load().catch(err => setError(err instanceof Error ? err.message : 'Could not load folders')); }, [load]);

  async function run(fn: () => Promise<unknown>) {
    setBusy(true); setError(null);
    try { await fn(); await load(); } catch (err) { setError(err instanceof Error ? err.message : 'Could not save that'); }
    finally { setBusy(false); }
  }
  function move(i: number, dir: -1 | 1) {
    if (!rows) return;
    const a = rows[i], b = rows[i + dir];
    if (!a || !b) return;
    void run(async () => {
      await api.patch(`/premises/folders/${a.id}`, { sort_order: b.sort_order });
      await api.patch(`/premises/folders/${b.id}`, { sort_order: a.sort_order === b.sort_order ? a.sort_order + dir : a.sort_order });
    });
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/50" onClick={onClose} />
      <div className="relative bg-white rounded-xl shadow-xl w-full max-w-xl mx-4 p-6 max-h-[92vh] overflow-y-auto">
        <h3 className="text-lg font-semibold text-gray-900 mb-1">Folders</h3>
        <p className="text-xs text-gray-500 mb-4">Tightening a folder hides its documents from anyone below; a document set tighter than its folder stays tighter.</p>
        {!rows ? <p className="text-sm text-gray-500">Loading…</p> : (
          <ul className="divide-y divide-gray-100 border border-gray-200 rounded">
            {rows.map((f, i) => (
              <li key={f.id} className="flex flex-wrap items-center gap-2 px-2 py-1.5">
                <input value={names[f.id] ?? f.name} disabled={busy || !!f.retired_at} aria-label={`Name of ${f.name}`}
                  onChange={e => setNames(prev => ({ ...prev, [f.id]: e.target.value }))}
                  onBlur={() => { const v = (names[f.id] ?? f.name).trim(); if (v && v !== f.name) void run(() => api.patch(`/premises/folders/${f.id}`, { name: v })); }}
                  className={`flex-1 min-w-[140px] px-2 py-1 text-sm border border-transparent hover:border-gray-200 rounded ${f.retired_at ? 'text-gray-400 line-through' : ''}`} />
                <select value={f.visibility} disabled={busy || !!f.retired_at} aria-label={`Who can see ${f.name}`}
                  onChange={e => void run(() => api.patch(`/premises/folders/${f.id}`, { visibility: e.target.value }))}
                  className="px-1.5 py-1 text-xs border border-gray-300 rounded bg-white">
                  {(['all', 'managers', 'admins'] as Visibility[]).map(v => <option key={v} value={v}>{VISIBILITY_LABEL[v]}</option>)}
                </select>
                <button type="button" disabled={busy || i === 0} onClick={() => move(i, -1)} className="px-1 text-gray-500 disabled:opacity-30" aria-label={`Move ${f.name} up`}>↑</button>
                <button type="button" disabled={busy || i === rows.length - 1} onClick={() => move(i, 1)} className="px-1 text-gray-500 disabled:opacity-30" aria-label={`Move ${f.name} down`}>↓</button>
                <button type="button" disabled={busy} onClick={() => void run(() => api.patch(`/premises/folders/${f.id}`, { retired: !f.retired_at }))}
                  className="text-xs text-gray-500 hover:text-gray-800 w-20 text-right">{f.retired_at ? 'Bring back' : 'Retire'}</button>
              </li>
            ))}
          </ul>
        )}
        <form className="flex flex-wrap gap-2 mt-3" onSubmit={e => {
          e.preventDefault();
          const v = adding.trim();
          if (v) void run(async () => { await api.post('/premises/folders', { name: v, visibility: addVis }); setAdding(''); });
        }}>
          <input value={adding} onChange={e => setAdding(e.target.value)} maxLength={100} placeholder="Add a folder…"
            className="flex-1 min-w-[160px] px-2 py-1.5 text-sm border border-gray-300 rounded" aria-label="New folder name" />
          <select value={addVis} onChange={e => setAddVis(e.target.value as Visibility)} className="px-2 py-1.5 text-sm border border-gray-300 rounded bg-white" aria-label="Who can see the new folder">
            {(['all', 'managers', 'admins'] as Visibility[]).map(v => <option key={v} value={v}>{VISIBILITY_LABEL[v]}</option>)}
          </select>
          <button type="submit" disabled={busy || !adding.trim()} className="px-3 py-1.5 text-sm rounded bg-ooosh-600 text-white disabled:opacity-40">Add</button>
        </form>
        {error && <p className="text-sm text-red-700 mt-3">{error}</p>}
        <div className="flex justify-end mt-5">
          <button type="button" onClick={onClose} className="px-3 py-1.5 text-sm rounded border border-gray-300 hover:bg-gray-50">Done</button>
        </div>
      </div>
    </div>
  );
}

function DocumentRow({ doc, folder, canManage, onEdit, onChanged, onError }: {
  doc: LibraryDocument;
  folder: LibraryFolder;
  canManage: boolean;
  onEdit: () => void;
  onChanged: () => Promise<void>;
  onError: (m: string | null) => void;
}) {
  const [showOlder, setShowOlder] = useState(false);
  const [uploading, setUploading] = useState(false);
  const current = doc.files[0];
  const older = doc.files.slice(1);
  const open = (key: string, name: string) => void openR2Key(key, name).catch(() => onError('Could not open that file'));

  return (
    <li className="px-4 py-3 space-y-1">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div className="min-w-0">
          <span className="font-medium text-gray-900">{doc.title}</span>
          {doc.place_name && <span className="ml-2 text-xs text-gray-500">{doc.place_name}</span>}
          {doc.effective_visibility !== folder.visibility && (
            <span className="ml-2 text-[11px] text-gray-500 border border-gray-200 rounded px-1 whitespace-nowrap">{VISIBILITY_LABEL[doc.effective_visibility]}</span>
          )}
        </div>
        {canManage && (
          <div className="flex items-center gap-3 text-xs">
            <label className={`text-ooosh-600 hover:underline cursor-pointer ${uploading ? 'opacity-50 pointer-events-none' : ''}`}>
              {uploading ? 'Uploading…' : 'New version'}
              <input type="file" className="hidden" onChange={e => {
                const f = e.target.files?.[0];
                e.target.value = '';
                if (!f) return;
                setUploading(true); onError(null);
                uploadVersion(doc.id, f)
                  .then(onChanged)
                  .catch(err => onError(err instanceof Error ? err.message : 'Could not upload it'))
                  .finally(() => setUploading(false));
              }} />
            </label>
            <button type="button" onClick={onEdit} className="text-gray-500 hover:text-gray-800">Change</button>
            <button type="button" className="text-gray-400 hover:text-gray-700" onClick={() => {
              if (!window.confirm(`Archive “${doc.title}”? It leaves the library; its files are kept.`)) return;
              api.post(`/premises/documents/${doc.id}/archive`, {}).then(onChanged)
                .catch(err => onError(err instanceof Error ? err.message : 'Could not archive it'));
            }}>Archive</button>
          </div>
        )}
      </div>
      {doc.notes && <p className="text-xs text-gray-600 whitespace-pre-wrap">{doc.notes}</p>}
      <div className="text-xs text-gray-600">
        {current ? (
          <>
            <button type="button" className="text-ooosh-600 hover:underline" onClick={() => open(current.r2_key, current.filename)}>{current.filename}</button>
            <span className="text-gray-400"> · added {fmtDate(current.created_at.slice(0, 10))}</span>
            {older.length > 0 && (
              <button type="button" className="ml-2 text-gray-500 hover:text-gray-800" onClick={() => setShowOlder(v => !v)}>
                {showOlder ? 'Hide' : `${older.length} earlier version${older.length === 1 ? '' : 's'}`}
              </button>
            )}
          </>
        ) : <span className="text-amber-700">No file yet</span>}
      </div>
      {showOlder && (
        <ul className="pl-3 border-l border-gray-200 space-y-0.5">
          {older.map(f => (
            <li key={f.id} className="text-xs text-gray-500">
              <button type="button" className="text-ooosh-600 hover:underline" onClick={() => open(f.r2_key, f.filename)}>{f.filename}</button>
              {' · '}{fmtDate(f.created_at.slice(0, 10))}
            </li>
          ))}
        </ul>
      )}
    </li>
  );
}

export default function DocumentsPanel({ meta }: { meta: PremisesMeta }) {
  const [folders, setFolders] = useState<LibraryFolder[] | null>(null);
  const [checks, setChecks] = useState<PremisesCheck[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<LibraryDocument | 'new' | null>(null);
  const [managingFolders, setManagingFolders] = useState(false);
  const [showCerts, setShowCerts] = useState(false);

  const load = useCallback(async () => {
    const [lib, list] = await Promise.all([
      api.get<{ data: LibraryFolder[] }>('/premises/library'),
      api.get<{ data: PremisesCheck[] }>('/premises/checks'),
    ]);
    setFolders(lib.data);
    setChecks(list.data);
  }, []);
  useEffect(() => { load().catch(err => setError(err instanceof Error ? err.message : 'Could not load the library')); }, [load]);
  const reload = async () => { try { await load(); } catch (err) { setError(err instanceof Error ? err.message : 'Could not reload'); } };

  const certs = checks.filter(c => c.current_file_key);
  if (!folders) return error ? <p className="text-sm text-red-700">{error}</p> : <p className="text-sm text-gray-500">Loading…</p>;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-gray-600">The lease, insurance, plans, manuals — anything that isn't a check.</p>
        <div className="flex gap-2">
          {meta.can.admin && (
            <button type="button" onClick={() => setManagingFolders(true)}
              className="px-3 py-1.5 text-sm rounded border border-gray-300 bg-white hover:bg-gray-50">Folders</button>
          )}
          {meta.can.manage && folders.length > 0 && (
            <button type="button" onClick={() => setEditing('new')}
              className="px-3 py-1.5 text-sm rounded bg-ooosh-600 text-white hover:bg-ooosh-700">+ Add a document</button>
          )}
        </div>
      </div>
      {error && <p className="text-sm text-red-700">{error}</p>}

      <div className="bg-white border border-gray-200 rounded-lg">
        <button type="button" onClick={() => setShowCerts(v => !v)}
          className="w-full flex items-center justify-between px-4 py-3 text-left">
          <span className="font-semibold text-gray-900">Certificates <span className="font-normal text-xs text-gray-500">· from the checks, filed by each visit</span></span>
          <span className="text-xs text-gray-500">{certs.length} {showCerts ? '▲' : '▼'}</span>
        </button>
        {showCerts && (
          <ul className="divide-y divide-gray-100 border-t border-gray-100">
            {certs.length === 0 && <li className="px-4 py-3 text-sm text-gray-500">No certificates yet.</li>}
            {certs.map(c => (
              <li key={c.id} className="px-4 py-2 flex flex-wrap items-baseline justify-between gap-2 text-sm">
                <Link to={`/operations/premises/checks/${c.id}`} className="text-gray-900 hover:underline">{c.title}</Link>
                <span className="text-xs text-gray-500">
                  <button type="button" className="text-ooosh-600 hover:underline"
                    onClick={() => void openR2Key(c.current_file_key!, c.current_file_name ?? undefined).catch(() => setError('Could not open that file'))}>
                    {c.current_file_name}
                  </button>
                  {c.last_done_on && <> · {fmtDate(c.last_done_on)}</>}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>

      {folders.map(f => (
        <div key={f.id} className="bg-white border border-gray-200 rounded-lg">
          <div className="flex items-center justify-between px-4 pt-3 pb-2">
            <h3 className="font-semibold text-gray-900">{f.name}</h3>
            {f.visibility !== 'all' && <span className="text-[11px] text-gray-500 border border-gray-200 rounded px-1">{VISIBILITY_LABEL[f.visibility]}</span>}
          </div>
          {f.documents.length === 0 ? (
            <p className="px-4 pb-3 text-sm text-gray-500">Nothing here yet.</p>
          ) : (
            <ul className="divide-y divide-gray-100 border-t border-gray-100">
              {f.documents.map(d => (
                <DocumentRow key={d.id} doc={d} folder={f} canManage={meta.can.manage}
                  onEdit={() => setEditing(d)} onChanged={reload} onError={setError} />
              ))}
            </ul>
          )}
        </div>
      ))}

      {editing && (
        <DocumentFormModal meta={meta} folders={folders} doc={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)} onSaved={() => { setEditing(null); void reload(); }} />
      )}
      {managingFolders && <FoldersModal onClose={() => { setManagingFolders(false); void reload(); }} />}
    </div>
  );
}
