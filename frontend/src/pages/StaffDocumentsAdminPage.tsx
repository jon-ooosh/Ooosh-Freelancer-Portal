import { useCallback, useEffect, useState } from 'react';
import { api } from '../services/api';
import MarkdownLite from '../components/MarkdownLite';

type Mode = 'read_only' | 'tick' | 'sign';
type Category = 'policy' | 'agreement' | 'training' | 'official_doc' | 'contract' | 'other';
type Visibility = 'everyone' | 'assignees' | 'owner_admin';
type TargetType = 'all_staff' | 'role' | 'list' | 'cot_card_holders';

interface DocRow {
  id: string; slug: string; title: string; category: Category;
  completion_mode: Mode; tick_label: string | null; visibility: Visibility;
  target_type: TargetType; target_roles: string[] | null; target_user_ids: string[] | null;
  chase_interval_days: number | null; escalate_after_days: number | null; review_interval_months: number | null;
  is_active: boolean; current_version: number | null;
  pending_count: number; completed_count: number; lapsed_count: number;
}
interface UserRow { id: string; email: string; first_name: string | null; last_name: string | null; }

const STAFF_ROLES = ['admin', 'manager', 'staff', 'general_assistant', 'weekend_manager'];
const CATEGORIES: Category[] = ['policy', 'agreement', 'training', 'official_doc', 'contract', 'other'];

async function uploadDocFile(file: File): Promise<{ file_r2_key: string; file_name: string }> {
  const fd = new FormData();
  fd.append('file', file);
  fd.append('attachment_only', 'true');
  const res = await api.upload<{ r2_key: string; filename: string }>('/files/upload', fd);
  return { file_r2_key: res.r2_key, file_name: res.filename };
}

// ── Content editor (write markdown OR upload a file) ──────────────────────────
function ContentEditor({ body, setBody, file, setFile }: {
  body: string; setBody: (s: string) => void;
  file: { file_r2_key: string; file_name: string } | null;
  setFile: (f: { file_r2_key: string; file_name: string } | null) => void;
}) {
  const [tab, setTab] = useState<'write' | 'upload'>(file ? 'upload' : 'write');
  const [preview, setPreview] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [err, setErr] = useState('');

  return (
    <div>
      <div className="flex gap-2 mb-2 text-sm">
        <button type="button" onClick={() => setTab('write')}
          className={`px-3 py-1 rounded ${tab === 'write' ? 'bg-purple-100 text-purple-800' : 'text-gray-500'}`}>Write (markdown)</button>
        <button type="button" onClick={() => setTab('upload')}
          className={`px-3 py-1 rounded ${tab === 'upload' ? 'bg-purple-100 text-purple-800' : 'text-gray-500'}`}>Upload a PDF</button>
      </div>

      {tab === 'write' && (
        <>
          <div className="flex justify-end mb-1">
            <button type="button" onClick={() => setPreview((p) => !p)} className="text-xs text-purple-700">
              {preview ? 'Edit' : 'Preview'}
            </button>
          </div>
          {preview
            ? <div className="border rounded-md p-3 min-h-[160px] bg-gray-50"><MarkdownLite text={body} /></div>
            : <textarea value={body} onChange={(e) => setBody(e.target.value)} rows={10}
                placeholder="Markdown: **bold**, # headings, 1. lists, [links](https://…)"
                className="w-full border border-gray-300 rounded-md p-2 text-sm font-mono resize-y" />}
          <p className="text-xs text-gray-400 mt-1">For anything with images/layout, author it in Google Docs, export a PDF, and use "Upload a PDF" instead.</p>
        </>
      )}

      {tab === 'upload' && (
        <div className="border-2 border-dashed border-gray-300 rounded-md p-4 text-center">
          {file ? (
            <div className="text-sm text-gray-700">
              📄 {file.file_name}
              <button type="button" onClick={() => setFile(null)} className="ml-3 text-red-600 text-xs">Remove</button>
            </div>
          ) : (
            <label className="cursor-pointer text-sm text-purple-700">
              {uploading ? 'Uploading…' : 'Choose a PDF / document to upload'}
              <input type="file" className="hidden" accept=".pdf,.doc,.docx" disabled={uploading}
                onChange={async (e) => {
                  const f = e.target.files?.[0]; if (!f) return;
                  setErr(''); setUploading(true);
                  try { setFile(await uploadDocFile(f)); }
                  catch (er) { setErr(er instanceof Error ? er.message : 'Upload failed'); }
                  finally { setUploading(false); }
                }} />
            </label>
          )}
          {err && <div className="text-xs text-red-600 mt-2">{err}</div>}
        </div>
      )}
    </div>
  );
}

// ── Create / edit config modal ────────────────────────────────────────────────
function DocFormModal({ doc, users, onClose, onSaved }: {
  doc: DocRow | null; users: UserRow[]; onClose: () => void; onSaved: () => void;
}) {
  const editing = !!doc;
  const [slug, setSlug] = useState(doc?.slug || '');
  const [title, setTitle] = useState(doc?.title || '');
  const [category, setCategory] = useState<Category>(doc?.category || 'policy');
  const [mode, setMode] = useState<Mode>(doc?.completion_mode || 'read_only');
  const [tickLabel, setTickLabel] = useState(doc?.tick_label || '');
  const [visibility, setVisibility] = useState<Visibility>(doc?.visibility || 'assignees');
  const [targetType, setTargetType] = useState<TargetType>(doc?.target_type || 'list');
  const [roles, setRoles] = useState<string[]>(doc?.target_roles || []);
  const [userIds, setUserIds] = useState<string[]>(doc?.target_user_ids || []);
  const [chase, setChase] = useState<string>(doc?.chase_interval_days?.toString() || '');
  const [escalate, setEscalate] = useState<string>(doc?.escalate_after_days?.toString() || '');
  const [review, setReview] = useState<string>(doc?.review_interval_months?.toString() || '');
  const [isActive, setIsActive] = useState(doc?.is_active ?? true);
  const [body, setBody] = useState('');
  const [file, setFile] = useState<{ file_r2_key: string; file_name: string } | null>(null);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState('');

  const numOrNull = (s: string) => s.trim() ? Number(s) : null;

  const submit = async () => {
    setErr('');
    if (!title.trim()) { setErr('Title is required.'); return; }
    if (!editing && !slug.trim()) { setErr('Slug is required.'); return; }
    if (!editing && !body.trim() && !file) { setErr('Add content (write markdown or upload a file).'); return; }
    setSaving(true);
    try {
      const config = {
        title: title.trim(), category, completion_mode: mode,
        tick_label: mode === 'read_only' ? null : (tickLabel.trim() || null),
        visibility, target_type: targetType,
        target_roles: targetType === 'role' ? roles : null,
        target_user_ids: targetType === 'list' ? userIds : null,
        chase_interval_days: numOrNull(chase), escalate_after_days: numOrNull(escalate),
        review_interval_months: numOrNull(review),
      };
      if (editing) {
        await api.patch(`/staff-documents/${doc!.id}`, { ...config, is_active: isActive });
      } else {
        await api.post('/staff-documents', {
          slug: slug.trim(), ...config,
          body: body.trim() || null, file_r2_key: file?.file_r2_key || null, file_name: file?.file_name || null,
        });
      }
      onSaved();
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Save failed.');
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4" onClick={onClose}>
      <div className="bg-white rounded-lg shadow-xl max-w-2xl w-full max-h-[92vh] flex flex-col" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between px-5 py-3 border-b">
          <h3 className="font-semibold text-gray-900">{editing ? 'Edit document' : 'New document'}</h3>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-700 text-xl">×</button>
        </div>
        <div className="p-5 overflow-y-auto space-y-4">
          {err && <div className="p-3 rounded bg-red-50 text-red-700 text-sm">{err}</div>}

          <div className="grid grid-cols-2 gap-3">
            <label className="text-sm">Title
              <input value={title} onChange={(e) => setTitle(e.target.value)} className="mt-1 w-full border rounded-md px-2 py-1.5" />
            </label>
            <label className="text-sm">Slug {editing && <span className="text-gray-400">(fixed)</span>}
              <input value={slug} disabled={editing} onChange={(e) => setSlug(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, '-'))}
                className="mt-1 w-full border rounded-md px-2 py-1.5 disabled:bg-gray-100" placeholder="cot-card-agreement" />
            </label>
            <label className="text-sm">Category
              <select value={category} onChange={(e) => setCategory(e.target.value as Category)} className="mt-1 w-full border rounded-md px-2 py-1.5">
                {CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}
              </select>
            </label>
            <label className="text-sm">Completion
              <select value={mode} onChange={(e) => setMode(e.target.value as Mode)} className="mt-1 w-full border rounded-md px-2 py-1.5">
                <option value="read_only">Read only (no tracking)</option>
                <option value="tick">Tick to acknowledge</option>
                <option value="sign">Signature required</option>
              </select>
            </label>
          </div>

          {mode !== 'read_only' && (
            <label className="text-sm block">Confirmation checkbox text
              <input value={tickLabel} onChange={(e) => setTickLabel(e.target.value)}
                placeholder="I have read and agree to the above." className="mt-1 w-full border rounded-md px-2 py-1.5" />
            </label>
          )}

          <div className="grid grid-cols-2 gap-3">
            <label className="text-sm">Visibility
              <select value={visibility} onChange={(e) => setVisibility(e.target.value as Visibility)} className="mt-1 w-full border rounded-md px-2 py-1.5">
                <option value="assignees">Assignees only</option>
                <option value="everyone">Everyone (library)</option>
                <option value="owner_admin">Owner + admin (e.g. contracts)</option>
              </select>
            </label>
            <label className="text-sm">Applies to
              <select value={targetType} onChange={(e) => setTargetType(e.target.value as TargetType)} className="mt-1 w-full border rounded-md px-2 py-1.5">
                <option value="all_staff">All staff</option>
                <option value="role">Specific roles</option>
                <option value="list">Specific people</option>
                <option value="cot_card_holders">COT card holders</option>
              </select>
            </label>
          </div>

          {targetType === 'role' && (
            <div className="text-sm flex flex-wrap gap-3">
              {STAFF_ROLES.map((r) => (
                <label key={r} className="flex items-center gap-1">
                  <input type="checkbox" checked={roles.includes(r)}
                    onChange={(e) => setRoles((prev) => e.target.checked ? [...prev, r] : prev.filter((x) => x !== r))} />
                  {r}
                </label>
              ))}
            </div>
          )}
          {targetType === 'list' && (
            <div className="text-sm border rounded-md p-2 max-h-40 overflow-y-auto space-y-1">
              {users.map((u) => (
                <label key={u.id} className="flex items-center gap-2">
                  <input type="checkbox" checked={userIds.includes(u.id)}
                    onChange={(e) => setUserIds((prev) => e.target.checked ? [...prev, u.id] : prev.filter((x) => x !== u.id))} />
                  {[u.first_name, u.last_name].filter(Boolean).join(' ') || u.email}
                </label>
              ))}
            </div>
          )}
          {mode !== 'read_only' && (
            <div className="grid grid-cols-3 gap-3">
              <label className="text-sm">Chase every (days)
                <input value={chase} onChange={(e) => setChase(e.target.value.replace(/\D/g, ''))} placeholder="none" className="mt-1 w-full border rounded-md px-2 py-1.5" />
              </label>
              <label className="text-sm">Escalate after (days)
                <input value={escalate} onChange={(e) => setEscalate(e.target.value.replace(/\D/g, ''))} placeholder="none" className="mt-1 w-full border rounded-md px-2 py-1.5" />
              </label>
              <label className="text-sm">Renew every (months)
                <input value={review} onChange={(e) => setReview(e.target.value.replace(/\D/g, ''))} placeholder="never" className="mt-1 w-full border rounded-md px-2 py-1.5" />
              </label>
            </div>
          )}

          {!editing && (
            <div>
              <div className="text-sm font-medium text-gray-700 mb-1">Content</div>
              <ContentEditor body={body} setBody={setBody} file={file} setFile={setFile} />
            </div>
          )}
          {editing && (
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={isActive} onChange={(e) => setIsActive(e.target.checked)} />
              Active (untick to retire — stops chasing, hides from staff)
            </label>
          )}
          {editing && <p className="text-xs text-gray-400">To change the document text, use "New version" on the list — that re-flags anyone who already completed it.</p>}
        </div>
        <div className="px-5 py-3 border-t flex justify-end gap-2">
          <button onClick={onClose} className="px-4 py-2 text-sm text-gray-600">Cancel</button>
          <button onClick={submit} disabled={saving} className="px-5 py-2 rounded-md bg-purple-700 text-white text-sm font-medium disabled:opacity-50">
            {saving ? 'Saving…' : editing ? 'Save' : 'Create'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── New version modal ─────────────────────────────────────────────────────────
function VersionModal({ doc, onClose, onSaved }: { doc: DocRow; onClose: () => void; onSaved: () => void }) {
  const [body, setBody] = useState('');
  const [file, setFile] = useState<{ file_r2_key: string; file_name: string } | null>(null);
  const [changeNote, setChangeNote] = useState('');
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState('');

  const submit = async () => {
    setErr('');
    if (!body.trim() && !file) { setErr('Add content.'); return; }
    setSaving(true);
    try {
      const res = await api.post<{ reflagged: number }>(`/staff-documents/${doc.id}/versions`, {
        body: body.trim() || null, file_r2_key: file?.file_r2_key || null, file_name: file?.file_name || null,
        change_note: changeNote.trim() || null,
      });
      onSaved();
      if (res.reflagged > 0) alert(`New version published. ${res.reflagged} person(s) will be asked to review/re-sign.`);
    } catch (e) { setErr(e instanceof Error ? e.message : 'Failed.'); setSaving(false); }
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4" onClick={onClose}>
      <div className="bg-white rounded-lg shadow-xl max-w-2xl w-full max-h-[92vh] flex flex-col" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between px-5 py-3 border-b">
          <h3 className="font-semibold text-gray-900">New version — {doc.title}</h3>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-700 text-xl">×</button>
        </div>
        <div className="p-5 overflow-y-auto space-y-3">
          {err && <div className="p-3 rounded bg-red-50 text-red-700 text-sm">{err}</div>}
          <p className="text-xs text-amber-700 bg-amber-50 rounded p-2">Publishing a new version re-flags everyone who completed the previous one to review/re-sign.</p>
          <ContentEditor body={body} setBody={setBody} file={file} setFile={setFile} />
          <label className="text-sm block">Change note
            <input value={changeNote} onChange={(e) => setChangeNote(e.target.value)} placeholder="What changed" className="mt-1 w-full border rounded-md px-2 py-1.5" />
          </label>
        </div>
        <div className="px-5 py-3 border-t flex justify-end gap-2">
          <button onClick={onClose} className="px-4 py-2 text-sm text-gray-600">Cancel</button>
          <button onClick={submit} disabled={saving} className="px-5 py-2 rounded-md bg-purple-700 text-white text-sm font-medium disabled:opacity-50">
            {saving ? 'Publishing…' : 'Publish version'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Completion matrix modal ───────────────────────────────────────────────────
interface MatrixRow {
  id: string; status: string; user_id: string; email: string;
  first_name: string | null; last_name: string | null;
  completed_at: string | null; pdf_r2_key: string | null; expires_at: string | null;
}
function MatrixModal({ doc, onClose }: { doc: DocRow; onClose: () => void }) {
  const [rows, setRows] = useState<MatrixRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    const res = await api.get<{ data: MatrixRow[] }>(`/staff-documents/${doc.id}/matrix`);
    setRows(res.data); setLoading(false);
  }, [doc.id]);
  useEffect(() => { load(); }, [load]);

  const sync = async () => {
    setSyncing(true);
    try { await api.post(`/staff-documents/${doc.id}/sync`, {}); await load(); }
    finally { setSyncing(false); }
  };
  const openPdf = async (key: string) => {
    const { blob } = await api.blob(`/files/download?key=${encodeURIComponent(key)}`);
    window.open(URL.createObjectURL(blob), '_blank');
  };
  const badge = (s: string) => s === 'completed' ? 'bg-green-100 text-green-700'
    : s === 'lapsed' ? 'bg-amber-100 text-amber-700' : 'bg-gray-100 text-gray-600';

  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4" onClick={onClose}>
      <div className="bg-white rounded-lg shadow-xl max-w-2xl w-full max-h-[90vh] flex flex-col" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between px-5 py-3 border-b">
          <h3 className="font-semibold text-gray-900">Who's completed — {doc.title}</h3>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-700 text-xl">×</button>
        </div>
        <div className="px-5 py-2 border-b flex justify-end">
          <button onClick={sync} disabled={syncing} className="text-xs text-purple-700 disabled:opacity-50">
            {syncing ? 'Syncing…' : '↻ Sync assignments (pick up new targets)'}
          </button>
        </div>
        <div className="p-5 overflow-y-auto">
          {loading ? <div className="text-gray-500">Loading…</div> : rows.length === 0 ? (
            <div className="text-gray-500 text-sm">No one is assigned yet. Use "Sync assignments" once the target set has members.</div>
          ) : (
            <table className="min-w-full text-sm">
              <thead><tr className="text-left text-gray-500 border-b">
                <th className="py-2 pr-3">Staff</th><th className="py-2 px-3">Status</th><th className="py-2 px-3">When</th><th className="py-2 pl-3"></th>
              </tr></thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id} className="border-b border-gray-100">
                    <td className="py-2 pr-3 text-gray-800">{[r.first_name, r.last_name].filter(Boolean).join(' ') || r.email}</td>
                    <td className="py-2 px-3"><span className={`px-2 py-0.5 rounded text-xs ${badge(r.status)}`}>{r.status}</span></td>
                    <td className="py-2 px-3 text-gray-500 text-xs">
                      {r.completed_at ? new Date(r.completed_at).toLocaleDateString('en-GB') : '—'}
                      {r.expires_at && r.status === 'completed' && <> · renews {new Date(r.expires_at).toLocaleDateString('en-GB')}</>}
                    </td>
                    <td className="py-2 pl-3 text-right">
                      {r.pdf_r2_key && <button onClick={() => openPdf(r.pdf_r2_key!)} className="text-xs text-purple-700">Signed copy</button>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────────
export default function StaffDocumentsAdminPage() {
  const [docs, setDocs] = useState<DocRow[]>([]);
  const [users, setUsers] = useState<UserRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [form, setForm] = useState<{ open: boolean; doc: DocRow | null }>({ open: false, doc: null });
  const [versionDoc, setVersionDoc] = useState<DocRow | null>(null);
  const [matrixDoc, setMatrixDoc] = useState<DocRow | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    const [d, u] = await Promise.all([
      api.get<{ data: DocRow[] }>('/staff-documents'),
      api.get<{ data: UserRow[] }>('/users'),
    ]);
    setDocs(d.data); setUsers(u.data); setLoading(false);
  }, []);
  useEffect(() => { load(); }, [load]);

  const modeLabel: Record<Mode, string> = { read_only: 'Read only', tick: 'Tick', sign: 'Sign' };

  return (
    <div className="max-w-5xl mx-auto p-4 sm:p-6">
      <div className="flex items-center justify-between mb-1">
        <h1 className="text-2xl font-bold text-gray-900">Staff Documents</h1>
        <button onClick={() => setForm({ open: true, doc: null })}
          className="px-4 py-2 rounded-md bg-purple-700 text-white text-sm font-medium hover:bg-purple-800">+ New document</button>
      </div>
      <p className="text-gray-500 mb-6">Create and manage the policies, agreements and guides staff read and sign.</p>

      {loading ? <div className="text-gray-500">Loading…</div> : (
        <div className="bg-white border border-gray-200 rounded-lg overflow-x-auto">
          <table className="min-w-full text-sm">
            <thead><tr className="text-left text-gray-500 border-b">
              <th className="py-2 px-4">Title</th><th className="py-2 px-3">Mode</th><th className="py-2 px-3">Applies to</th>
              <th className="py-2 px-3">Status</th><th className="py-2 px-3">v</th><th className="py-2 px-3"></th>
            </tr></thead>
            <tbody>
              {docs.map((d) => (
                <tr key={d.id} className={`border-b border-gray-100 ${d.is_active ? '' : 'opacity-50'}`}>
                  <td className="py-2 px-4">
                    <div className="font-medium text-gray-900">{d.title}</div>
                    <div className="text-xs text-gray-400">{d.category}{!d.is_active && ' · retired'}</div>
                  </td>
                  <td className="py-2 px-3 text-gray-600">{modeLabel[d.completion_mode]}</td>
                  <td className="py-2 px-3 text-gray-600 text-xs">{d.target_type.replace('_', ' ')}</td>
                  <td className="py-2 px-3 text-xs">
                    {d.completion_mode === 'read_only' ? <span className="text-gray-400">—</span> : (
                      <span>
                        <span className="text-green-700">{d.completed_count}✓</span>{' '}
                        <span className="text-gray-500">{d.pending_count} pending</span>
                        {d.lapsed_count > 0 && <span className="text-amber-700"> · {d.lapsed_count} lapsed</span>}
                      </span>
                    )}
                  </td>
                  <td className="py-2 px-3 text-gray-500">{d.current_version ?? '—'}</td>
                  <td className="py-2 px-3 text-right whitespace-nowrap">
                    <button onClick={() => setForm({ open: true, doc: d })} className="text-xs text-gray-600 hover:text-purple-700 px-1">Edit</button>
                    <button onClick={() => setVersionDoc(d)} className="text-xs text-gray-600 hover:text-purple-700 px-1">New version</button>
                    {d.completion_mode !== 'read_only' && (
                      <button onClick={() => setMatrixDoc(d)} className="text-xs text-gray-600 hover:text-purple-700 px-1">Who's done</button>
                    )}
                  </td>
                </tr>
              ))}
              {docs.length === 0 && <tr><td colSpan={6} className="py-6 text-center text-gray-400">No documents yet — create one.</td></tr>}
            </tbody>
          </table>
        </div>
      )}

      {form.open && <DocFormModal doc={form.doc} users={users}
        onClose={() => setForm({ open: false, doc: null })} onSaved={() => { setForm({ open: false, doc: null }); load(); }} />}
      {versionDoc && <VersionModal doc={versionDoc} onClose={() => setVersionDoc(null)} onSaved={() => { setVersionDoc(null); load(); }} />}
      {matrixDoc && <MatrixModal doc={matrixDoc} onClose={() => setMatrixDoc(null)} />}
    </div>
  );
}
