import { useCallback, useEffect, useState } from 'react';
import { api } from '../services/api';
import MarkdownLite from '../components/MarkdownLite';

export type Mode = 'read_only' | 'tick' | 'sign';
export type Category = 'policy' | 'agreement' | 'training' | 'official_doc' | 'contract' | 'other';
export type Visibility = 'everyone' | 'assignees' | 'owner_admin';
export type TargetType = 'all_staff' | 'role' | 'list' | 'cot_card_holders';
export type ApprovalStatus = 'draft' | 'pending_approval' | 'approved';

export interface DocRow {
  id: string; slug: string; title: string; category: Category;
  completion_mode: Mode; tick_label: string | null; visibility: Visibility;
  target_type: TargetType; target_roles: string[] | null; target_user_ids: string[] | null;
  chase_interval_days: number | null; escalate_after_days: number | null; review_interval_months: number | null;
  is_active: boolean; current_version: number | null;
  approval_status: ApprovalStatus; review_notes: string | null;
  shareable_with_freelancers: boolean;
  tags: string[] | null;
  owner_user_ids: string[] | null;
  content_review_interval_months: number | null;
  content_review_due_date: string | null;
  content_reviewed_at: string | null;
  author_name?: string | null;
  pending_count: number; completed_count: number; lapsed_count: number;
}
export interface UserRow { id: string; email: string; first_name: string | null; last_name: string | null; }

const STAFF_ROLES = ['admin', 'manager', 'staff', 'general_assistant', 'weekend_manager'];
const CATEGORIES: Category[] = ['policy', 'agreement', 'training', 'official_doc', 'contract', 'other'];
// Categories that may be shared into the freelancer portal (must match backend).
const SHAREABLE_CATEGORIES: Category[] = ['policy', 'training', 'other'];

async function uploadDocFile(file: File): Promise<{ file_r2_key: string; file_name: string }> {
  const fd = new FormData();
  fd.append('file', file);
  fd.append('attachment_only', 'true');
  const res = await api.upload<{ r2_key: string; filename: string }>('/files/upload', fd);
  return { file_r2_key: res.r2_key, file_name: res.filename };
}

// ── Tag input (freeform chips; Enter / comma adds, suggestions from existing) ─
function TagInput({ tags, setTags, suggestions }: {
  tags: string[]; setTags: (t: string[]) => void; suggestions: string[];
}) {
  const [text, setText] = useState('');
  const add = (raw: string) => {
    const t = raw.trim().toLowerCase().replace(/,+$/, '').slice(0, 40);
    if (t && !tags.includes(t)) setTags([...tags, t]);
    setText('');
  };
  const remaining = suggestions.filter((s) => !tags.includes(s)).slice(0, 8);
  return (
    <div>
      <div className="flex flex-wrap gap-1.5 mb-1.5">
        {tags.map((t) => (
          <span key={t} className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-purple-100 text-purple-800 text-xs">
            {t}
            <button type="button" onClick={() => setTags(tags.filter((x) => x !== t))} className="text-purple-500 hover:text-purple-800">×</button>
          </span>
        ))}
      </div>
      <input
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); add(text); }
          else if (e.key === 'Backspace' && !text && tags.length) setTags(tags.slice(0, -1));
        }}
        onBlur={() => text && add(text)}
        placeholder="e.g. vehicles, money, staging — Enter to add"
        className="w-full border rounded-md px-2 py-1.5 text-sm"
      />
      {remaining.length > 0 && (
        <div className="flex flex-wrap gap-1 mt-1.5">
          {remaining.map((s) => (
            <button key={s} type="button" onClick={() => add(s)} className="px-2 py-0.5 rounded-full bg-gray-100 text-gray-600 text-xs hover:bg-gray-200">+ {s}</button>
          ))}
        </div>
      )}
    </div>
  );
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
          <details className="mt-2 text-xs text-gray-600 bg-gray-50 rounded-md border border-gray-200 p-2">
            <summary className="cursor-pointer font-medium text-gray-700">Formatting help (markdown)</summary>
            <table className="mt-2 w-full">
              <tbody className="align-top">
                <tr><td className="py-0.5 pr-3 font-mono text-purple-700 whitespace-nowrap">**bold**</td><td>bold text</td></tr>
                <tr><td className="py-0.5 pr-3 font-mono text-purple-700 whitespace-nowrap"># Heading</td><td>large heading (## / ### for smaller)</td></tr>
                <tr><td className="py-0.5 pr-3 font-mono text-purple-700 whitespace-nowrap">1. item</td><td>numbered list (each on its own line)</td></tr>
                <tr><td className="py-0.5 pr-3 font-mono text-purple-700 whitespace-nowrap">- item</td><td>bullet list</td></tr>
                <tr><td className="py-0.5 pr-3 font-mono text-purple-700 whitespace-nowrap">[text](https://…)</td><td>a link</td></tr>
                <tr><td className="py-0.5 pr-3 text-gray-500 whitespace-nowrap">blank line</td><td>starts a new paragraph</td></tr>
              </tbody>
            </table>
            <p className="mt-2 text-gray-400">Use <strong>Preview</strong> (top right) to see how it'll look.</p>
          </details>
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
export function DocFormModal({ doc, users, canPublish = true, tagSuggestions = [], onClose, onSaved }: {
  doc: DocRow | null; users: UserRow[]; canPublish?: boolean; tagSuggestions?: string[]; onClose: () => void; onSaved: () => void;
}) {
  const editing = !!doc;
  const [saveAsDraft, setSaveAsDraft] = useState(false);
  const [title, setTitle] = useState(doc?.title || '');
  const [category, setCategory] = useState<Category>(doc?.category || 'policy');
  const [mode, setMode] = useState<Mode>(doc?.completion_mode || 'read_only');
  const [tickLabel, setTickLabel] = useState(doc?.tick_label || '');
  const [visibility, setVisibility] = useState<Visibility>(doc?.visibility || 'assignees');
  const [targetType, setTargetType] = useState<TargetType>(doc?.target_type || 'list');
  const [roles, setRoles] = useState<string[]>(doc?.target_roles || []);
  const [userIds, setUserIds] = useState<string[]>(doc?.target_user_ids || []);
  // Sensible defaults for a new tracked document (overwritable).
  const [chase, setChase] = useState<string>(doc ? (doc.chase_interval_days?.toString() || '') : '7');
  const [escalate, setEscalate] = useState<string>(doc ? (doc.escalate_after_days?.toString() || '') : '14');
  const [review, setReview] = useState<string>(doc ? (doc.review_interval_months?.toString() || '') : '12');
  const [shareable, setShareable] = useState<boolean>(doc?.shareable_with_freelancers ?? false);
  const canShare = SHAREABLE_CATEGORIES.includes(category);
  const [tags, setTags] = useState<string[]>(doc?.tags || []);
  const [ownerIds, setOwnerIds] = useState<string[]>(doc?.owner_user_ids || []);
  const [contentReview, setContentReview] = useState<string>(doc ? (doc.content_review_interval_months?.toString() || '') : '12');
  const [isActive, setIsActive] = useState(doc?.is_active ?? true);
  const [body, setBody] = useState('');
  const [file, setFile] = useState<{ file_r2_key: string; file_name: string } | null>(null);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState('');

  const numOrNull = (s: string) => s.trim() ? Number(s) : null;

  const dirty = editing
    ? (title !== doc!.title || category !== doc!.category || mode !== doc!.completion_mode
        || (tickLabel || '') !== (doc!.tick_label || '') || visibility !== doc!.visibility
        || targetType !== doc!.target_type || isActive !== doc!.is_active
        || chase !== (doc!.chase_interval_days?.toString() || '')
        || escalate !== (doc!.escalate_after_days?.toString() || '')
        || review !== (doc!.review_interval_months?.toString() || '')
        || shareable !== (doc!.shareable_with_freelancers ?? false)
        || contentReview !== (doc!.content_review_interval_months?.toString() || '')
        || JSON.stringify(roles) !== JSON.stringify(doc!.target_roles || [])
        || JSON.stringify(userIds) !== JSON.stringify(doc!.target_user_ids || [])
        || JSON.stringify(tags) !== JSON.stringify(doc!.tags || [])
        || JSON.stringify(ownerIds) !== JSON.stringify(doc!.owner_user_ids || []))
    : !!(title || body.trim() || file || tickLabel || roles.length || userIds.length || chase || escalate || review || tags.length || ownerIds.length);
  const attemptClose = () => { if (dirty && !window.confirm('Discard your changes?')) return; onClose(); };

  const submit = async () => {
    setErr('');
    if (!title.trim()) { setErr('Title is required.'); return; }
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
        shareable_with_freelancers: canShare ? shareable : false,
        tags: tags.length ? tags : null,
        owner_user_ids: ownerIds.length ? ownerIds : null,
        content_review_interval_months: numOrNull(contentReview),
      };
      if (editing) {
        await api.patch(`/staff-documents/${doc!.id}`, { ...config, is_active: isActive });
      } else {
        await api.post('/staff-documents', {
          ...config,
          body: body.trim() || null, file_r2_key: file?.file_r2_key || null, file_name: file?.file_name || null,
          save_as_draft: canPublish ? saveAsDraft : true,
        });
      }
      onSaved();
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Save failed.');
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4" onClick={attemptClose}>
      <div className="bg-white rounded-lg shadow-xl max-w-2xl w-full max-h-[92vh] flex flex-col" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between px-5 py-3 border-b">
          <h3 className="font-semibold text-gray-900">{editing ? 'Edit document' : 'New document'}</h3>
          <button onClick={attemptClose} className="text-gray-400 hover:text-gray-700 text-xl">×</button>
        </div>
        <div className="p-5 overflow-y-auto space-y-4">
          {err && <div className="p-3 rounded bg-red-50 text-red-700 text-sm">{err}</div>}

          <div className="grid grid-cols-2 gap-3">
            <label className="text-sm col-span-2">Title
              <input value={title} onChange={(e) => setTitle(e.target.value)} className="mt-1 w-full border rounded-md px-2 py-1.5" />
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

          <div className="text-sm">
            <div className="mb-1 text-gray-700">Tags <span className="text-gray-400 font-normal">— for search & filtering (e.g. vehicles, money, staging)</span></div>
            <TagInput tags={tags} setTags={setTags} suggestions={tagSuggestions} />
          </div>

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
          <div className="rounded-md border border-gray-200 p-2.5">
            <label className={`flex items-center gap-2 text-sm ${canShare ? 'text-gray-700' : 'text-gray-400'}`}>
              <input type="checkbox" checked={canShare && shareable} disabled={!canShare}
                onChange={(e) => setShareable(e.target.checked)} />
              🔗 Share with freelancers (shows in the portal Resources section)
            </label>
            <p className="text-xs mt-1 text-gray-400">
              {canShare
                ? 'Freelancers will be able to read this. Fine for guides & general policies.'
                : `“${category}” documents are internal only — switch to policy / training / other to allow sharing.`}
            </p>
          </div>

          <div className="rounded-md border border-gray-200 p-2.5 space-y-2">
            <div className="text-sm font-medium text-gray-700">Ownership &amp; content review</div>
            <div className="text-sm">
              <div className="mb-1 text-gray-600">Owner(s) — responsible for keeping it current</div>
              <div className="border rounded-md p-2 max-h-32 overflow-y-auto space-y-1">
                {users.map((u) => (
                  <label key={u.id} className="flex items-center gap-2">
                    <input type="checkbox" checked={ownerIds.includes(u.id)}
                      onChange={(e) => setOwnerIds((prev) => e.target.checked ? [...prev, u.id] : prev.filter((x) => x !== u.id))} />
                    {[u.first_name, u.last_name].filter(Boolean).join(' ') || u.email}
                  </label>
                ))}
              </div>
            </div>
            <label className="text-sm block">Owner reviews content every (months)
              <input value={contentReview} onChange={(e) => setContentReview(e.target.value.replace(/\D/g, ''))}
                placeholder="never" className="mt-1 w-40 border rounded-md px-2 py-1.5" />
              <span className="block text-xs text-gray-400 mt-1">
                The owner(s) / author are reminded to check it's still accurate and mark it reviewed. Separate from staff re-signing below.
              </span>
            </label>
          </div>

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
          {!editing && (canPublish ? (
            <label className="flex items-center gap-2 text-sm text-gray-700">
              <input type="checkbox" checked={saveAsDraft} onChange={(e) => setSaveAsDraft(e.target.checked)} />
              Save as a draft (don't publish yet)
            </label>
          ) : (
            <p className="text-xs text-gray-600 bg-amber-50 rounded p-2">This will be saved as a <strong>draft</strong>. Build it up, then submit it for a manager to approve before it goes out.</p>
          ))}
          {editing && (
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={isActive} onChange={(e) => setIsActive(e.target.checked)} />
              Active (untick to retire — stops chasing, hides from staff)
            </label>
          )}
          {editing && <p className="text-xs text-gray-400">To change the document text, use "New version" on the list — that re-flags anyone who already completed it.</p>}
        </div>
        <div className="px-5 py-3 border-t flex justify-end gap-2">
          <button onClick={attemptClose} className="px-4 py-2 text-sm text-gray-600">Cancel</button>
          <button onClick={submit} disabled={saving} className="px-5 py-2 rounded-md bg-purple-700 text-white text-sm font-medium disabled:opacity-50">
            {saving ? 'Saving…' : editing ? 'Save' : (canPublish && !saveAsDraft ? 'Create & publish' : 'Save draft')}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── New version modal ─────────────────────────────────────────────────────────
export function VersionModal({ doc, onClose, onSaved }: { doc: DocRow; onClose: () => void; onSaved: () => void }) {
  const [body, setBody] = useState('');
  const [file, setFile] = useState<{ file_r2_key: string; file_name: string } | null>(null);
  const [changeNote, setChangeNote] = useState('');
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState('');
  const [loadingRaw, setLoadingRaw] = useState(true);
  const [initialBody, setInitialBody] = useState('');
  const [initialFileKey, setInitialFileKey] = useState('');

  // Pre-fill from the current version so a new version starts from the existing
  // text, not a blank page.
  useEffect(() => {
    (async () => {
      try {
        const res = await api.get<{ data: { body: string | null; file_r2_key: string | null; file_name: string | null } }>(`/staff-documents/${doc.id}/raw`);
        if (res.data.body) { setBody(res.data.body); setInitialBody(res.data.body); }
        if (res.data.file_r2_key) {
          setFile({ file_r2_key: res.data.file_r2_key, file_name: res.data.file_name || 'document' });
          setInitialFileKey(res.data.file_r2_key);
        }
      } catch { /* start blank if the current version can't be read */ }
      finally { setLoadingRaw(false); }
    })();
  }, [doc.id]);

  const dirty = body !== initialBody || (file?.file_r2_key || '') !== initialFileKey || !!changeNote.trim();
  const attemptClose = () => { if (dirty && !window.confirm('Discard your changes?')) return; onClose(); };

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
    <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4" onClick={attemptClose}>
      <div className="bg-white rounded-lg shadow-xl max-w-2xl w-full max-h-[92vh] flex flex-col" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between px-5 py-3 border-b">
          <h3 className="font-semibold text-gray-900">New version — {doc.title}</h3>
          <button onClick={attemptClose} className="text-gray-400 hover:text-gray-700 text-xl">×</button>
        </div>
        <div className="p-5 overflow-y-auto space-y-3">
          {err && <div className="p-3 rounded bg-red-50 text-red-700 text-sm">{err}</div>}
          <p className="text-xs text-amber-700 bg-amber-50 rounded p-2">Publishing a new version re-flags everyone who completed the previous one to review/re-sign. Edit the current text below.</p>
          {loadingRaw ? <div className="text-sm text-gray-500">Loading current version…</div>
            : <ContentEditor body={body} setBody={setBody} file={file} setFile={setFile} />}
          <label className="text-sm block">Change note
            <input value={changeNote} onChange={(e) => setChangeNote(e.target.value)} placeholder="What changed" className="mt-1 w-full border rounded-md px-2 py-1.5" />
          </label>
        </div>
        <div className="px-5 py-3 border-t flex justify-end gap-2">
          <button onClick={attemptClose} className="px-4 py-2 text-sm text-gray-600">Cancel</button>
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
  completed_at: string | null; pdf_r2_key: string | null; completion_id: string | null; expires_at: string | null;
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
  const openPdf = async (completionId: string) => {
    const { blob } = await api.blob(`/staff-documents/completions/${completionId}/pdf`);
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
                      {r.pdf_r2_key && r.completion_id && <button onClick={() => openPdf(r.completion_id!)} className="text-xs text-purple-700">Signed copy</button>}
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

// ── Read-only view modal (with inline approve / request-changes) ──────────────
export function ViewModal({ doc, canReview, onApprove, onReject, onClose }: {
  doc: DocRow; canReview: boolean; onApprove: () => void; onReject: () => void; onClose: () => void;
}) {
  const [data, setData] = useState<{ body: string | null; file_r2_key: string | null; file_name: string | null } | null>(null);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    (async () => {
      try { const r = await api.get<{ data: { body: string | null; file_r2_key: string | null; file_name: string | null } }>(`/staff-documents/${doc.id}/raw`); setData(r.data); }
      catch { /* ignore */ } finally { setLoading(false); }
    })();
  }, [doc.id]);
  const openFile = async (key: string) => {
    const { blob } = await api.blob(`/files/download?key=${encodeURIComponent(key)}`);
    window.open(URL.createObjectURL(blob), '_blank');
  };
  const reviewable = canReview && doc.approval_status === 'pending_approval';
  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4" onClick={onClose}>
      <div className="bg-white rounded-lg shadow-xl max-w-2xl w-full max-h-[90vh] flex flex-col" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between px-5 py-3 border-b">
          <h3 className="font-semibold text-gray-900 truncate">{doc.title}</h3>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-700 text-xl">×</button>
        </div>
        <div className="p-5 overflow-y-auto">
          {loading ? <div className="text-gray-500">Loading…</div> : data ? (
            <>
              {data.file_r2_key && (
                <button onClick={() => openFile(data.file_r2_key!)} className="mb-4 px-4 py-2 rounded-md border border-gray-300 text-sm text-gray-700 hover:bg-gray-50">
                  📄 Open {data.file_name || 'document'}
                </button>
              )}
              {data.body && <MarkdownLite text={data.body} />}
              {!data.body && !data.file_r2_key && <div className="text-gray-400 text-sm">No content.</div>}
            </>
          ) : <div className="text-gray-400">Couldn't load the content.</div>}
        </div>
        {reviewable && (
          <div className="px-5 py-3 border-t flex justify-end gap-2">
            <button onClick={onReject} className="px-4 py-2 rounded-md border border-red-300 text-red-600 text-sm">Request changes</button>
            <button onClick={onApprove} className="px-5 py-2 rounded-md bg-green-600 text-white text-sm font-medium hover:bg-green-700">Approve &amp; publish</button>
          </div>
        )}
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
  const [viewDoc, setViewDoc] = useState<DocRow | null>(null);
  const [search, setSearch] = useState('');
  const [tagFilter, setTagFilter] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    const [d, u] = await Promise.all([
      api.get<{ data: DocRow[] }>('/staff-documents'),
      api.get<{ data: UserRow[] }>('/users'),
    ]);
    setDocs(d.data); setUsers(u.data); setLoading(false);
  }, []);
  useEffect(() => { load(); }, [load]);

  const approve = async (id: string) => { await api.post(`/staff-documents/${id}/approve`, {}); setViewDoc(null); load(); };
  const reject = async (id: string) => {
    const reason = window.prompt('Request changes — note to the author (optional):');
    if (reason === null) return; // cancelled
    await api.post(`/staff-documents/${id}/reject`, { reason });
    setViewDoc(null);
    load();
  };
  const del = async (id: string) => {
    if (!window.confirm('Delete this document? This cannot be undone.')) return;
    try { await api.delete(`/staff-documents/${id}`); load(); }
    catch (e) { alert(e instanceof Error ? e.message : 'Could not delete.'); }
  };
  const markReviewed = async (id: string) => {
    if (!window.confirm('Mark this document as reviewed — content confirmed still current?')) return;
    try { await api.post(`/staff-documents/${id}/mark-reviewed`, {}); load(); }
    catch (e) { alert(e instanceof Error ? e.message : 'Could not mark reviewed.'); }
  };
  const userName = (id: string) => {
    const u = users.find((x) => x.id === id);
    return u ? ([u.first_name, u.last_name].filter(Boolean).join(' ') || u.email) : '—';
  };

  const todayStr = new Date().toISOString().slice(0, 10);
  // DATE columns serialise to a full ISO timestamp in JSON — compare date parts.
  const reviewDue = (d: DocRow) => !!d.content_review_due_date && d.content_review_due_date.slice(0, 10) <= todayStr;
  const allTags = Array.from(new Set(docs.flatMap((d) => d.tags || []))).sort();
  const q = search.trim().toLowerCase();
  const filtered = docs.filter((d) => {
    if (tagFilter && !(d.tags || []).includes(tagFilter)) return false;
    if (!q) return true;
    return d.title.toLowerCase().includes(q)
      || (d.tags || []).some((t) => t.includes(q))
      || (d.author_name || '').toLowerCase().includes(q)
      || d.category.includes(q);
  });

  const modeLabel: Record<Mode, string> = { read_only: 'Read only', tick: 'Tick', sign: 'Sign' };
  const approvalPill = (s: ApprovalStatus) => s === 'draft' ? { t: 'Draft', c: 'bg-gray-100 text-gray-600' }
    : s === 'pending_approval' ? { t: 'Pending approval', c: 'bg-amber-100 text-amber-700' }
    : null;

  return (
    <div className="max-w-5xl mx-auto p-4 sm:p-6">
      <div className="flex items-center justify-between mb-1">
        <h1 className="text-2xl font-bold text-gray-900">Staff Documents</h1>
        <button onClick={() => setForm({ open: true, doc: null })}
          className="px-4 py-2 rounded-md bg-purple-700 text-white text-sm font-medium hover:bg-purple-800">+ New document</button>
      </div>
      <p className="text-gray-500 mb-6">Create and manage the policies, agreements and guides staff read and sign.</p>

      {!loading && docs.length > 0 && (
        <div className="mb-4 flex flex-col sm:flex-row sm:items-center gap-2">
          <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search title, tag, author…"
            className="border rounded-md px-3 py-1.5 text-sm w-full sm:w-72" />
          {allTags.length > 0 && (
            <div className="flex flex-wrap items-center gap-1.5">
              {allTags.map((t) => (
                <button key={t} onClick={() => setTagFilter(tagFilter === t ? null : t)}
                  className={`px-2 py-0.5 rounded-full text-xs ${tagFilter === t ? 'bg-purple-700 text-white' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'}`}>
                  {t}
                </button>
              ))}
              {tagFilter && <button onClick={() => setTagFilter(null)} className="text-xs text-gray-500 underline">clear</button>}
            </div>
          )}
        </div>
      )}

      {loading ? <div className="text-gray-500">Loading…</div> : (
        <div className="bg-white border border-gray-200 rounded-lg overflow-x-auto">
          <table className="min-w-full text-sm">
            <thead><tr className="text-left text-gray-500 border-b">
              <th className="py-2 px-4">Title</th><th className="py-2 px-3">Mode</th><th className="py-2 px-3">Applies to</th>
              <th className="py-2 px-3">Status</th><th className="py-2 px-3">v</th><th className="py-2 px-3"></th>
            </tr></thead>
            <tbody>
              {filtered.map((d) => (
                <tr key={d.id} className={`border-b border-gray-100 ${d.is_active ? '' : 'opacity-50'}`}>
                  <td className="py-2 px-4">
                    <div className="font-medium text-gray-900 flex flex-wrap items-center gap-2">
                      {d.title}
                      {approvalPill(d.approval_status) && (
                        <span className={`px-1.5 py-0.5 rounded text-[10px] font-medium ${approvalPill(d.approval_status)!.c}`}>{approvalPill(d.approval_status)!.t}</span>
                      )}
                      {reviewDue(d) && <span className="px-1.5 py-0.5 rounded text-[10px] font-medium bg-amber-100 text-amber-700">Review due</span>}
                    </div>
                    <div className="text-xs text-gray-400">
                      {d.category}{!d.is_active && ' · retired'}{d.author_name && ` · by ${d.author_name}`}
                      {d.owner_user_ids && d.owner_user_ids.length > 0 && ` · owner: ${d.owner_user_ids.map(userName).join(', ')}`}
                    </div>
                    {d.tags && d.tags.length > 0 && (
                      <div className="flex flex-wrap gap-1 mt-1">
                        {d.tags.map((t) => <span key={t} className="px-1.5 py-0.5 rounded-full bg-purple-50 text-purple-700 text-[10px]">{t}</span>)}
                      </div>
                    )}
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
                    <button onClick={() => setViewDoc(d)} className={`text-xs px-1 ${d.approval_status === 'pending_approval' ? 'text-green-700 font-medium hover:underline' : 'text-gray-600 hover:text-purple-700'}`}>
                      {d.approval_status === 'pending_approval' ? 'Review' : 'View'}
                    </button>
                    <button onClick={() => setForm({ open: true, doc: d })} className="text-xs text-gray-600 hover:text-purple-700 px-1">Edit</button>
                    <button onClick={() => setVersionDoc(d)} className="text-xs text-gray-600 hover:text-purple-700 px-1">New version</button>
                    {d.completion_mode !== 'read_only' && (
                      <button onClick={() => setMatrixDoc(d)} className="text-xs text-gray-600 hover:text-purple-700 px-1">Who's done</button>
                    )}
                    {reviewDue(d) && (
                      <button onClick={() => markReviewed(d.id)} className="text-xs text-amber-700 hover:text-amber-900 px-1">Mark reviewed</button>
                    )}
                    <button onClick={() => del(d.id)} className="text-xs text-red-500 hover:text-red-700 px-1">Delete</button>
                  </td>
                </tr>
              ))}
              {filtered.length === 0 && (
                <tr><td colSpan={6} className="py-6 text-center text-gray-400">
                  {docs.length === 0 ? 'No documents yet — create one.' : 'No documents match your search.'}
                </td></tr>
              )}
            </tbody>
          </table>
        </div>
      )}

      {form.open && <DocFormModal doc={form.doc} users={users} tagSuggestions={allTags}
        onClose={() => setForm({ open: false, doc: null })} onSaved={() => { setForm({ open: false, doc: null }); load(); }} />}
      {versionDoc && <VersionModal doc={versionDoc} onClose={() => setVersionDoc(null)} onSaved={() => { setVersionDoc(null); load(); }} />}
      {matrixDoc && <MatrixModal doc={matrixDoc} onClose={() => setMatrixDoc(null)} />}
      {viewDoc && <ViewModal doc={viewDoc} canReview onApprove={() => approve(viewDoc.id)} onReject={() => reject(viewDoc.id)} onClose={() => setViewDoc(null)} />}
    </div>
  );
}
