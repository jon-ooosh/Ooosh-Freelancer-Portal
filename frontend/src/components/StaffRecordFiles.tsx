/**
 * Staff Records — the private files section on a staff member's row.
 *
 * Phase 1 of docs/STAFF-RECORDS-SPEC.md. Documents held ABOUT somebody
 * (contract, right-to-work evidence, ID), admin-only, one list per person.
 *
 * NOT "My Documents" (StaffDocumentsPage), which is the handbook and training
 * we publish TO staff and ask them to tick. Opposite direction, opposite access
 * rule — see spec §1.4 for why they are deliberately not the same table.
 *
 * Files open via `openAuthedFile` because the bytes live in the private R2
 * bucket and a plain link doesn't carry the JWT. The backend gates the
 * `staff-records/` prefix on admin (routes/files.ts) — this component being
 * admin-only is the second lock, not the only one.
 *
 * ONE DATED ACTION PER RECORD (spec §22, mig 243). jon sets, per record, when
 * he wants to hear about it again and what should happen then — remind, or
 * flag for deletion — like the remind-me on a job. The form PRE-FILLS the date
 * (suggestActionDate) so the sensible default costs nothing, and the Needs
 * attention list flags any record that should have a date and doesn't. A
 * deletion flag never deletes: it points at the record and a human presses
 * Delete.
 */

import { useCallback, useEffect, useState } from 'react';
import { api } from '../services/api';
import { openAuthedFile } from '../lib/openAuthedFile';
import { useAuthStore } from '../hooks/useAuthStore';

export interface StaffRecordFile {
  id: string;
  label: string;
  doc_type: string;
  r2_key: string;
  filename: string;
  content_type: string | null;
  size_bytes: string | null;
  notes: string | null;
  document_date: string | null;
  expires_on: string | null;
  action_on: string | null;
  action_kind: 'remind' | 'delete';
  action_delivery: 'notification' | 'email' | 'both';
  action_user_id: string | null;
  action_note: string | null;
  action_chased_at: string | null;
  uploaded_at: string;
  uploaded_by_name: string | null;
}

type ActionKind = StaffRecordFile['action_kind'];
type ActionDelivery = StaffRecordFile['action_delivery'];
type ActionRecipient = 'me' | 'admins';

/** The inputs the date suggestion is built from — GET /staff-records/action-defaults. */
interface ActionDefaults { intervals: Record<string, number>; expiryLeadDays: number }

const DELIVERY_OPTIONS: { value: ActionDelivery; label: string }[] = [
  { value: 'both', label: 'Bell + email' },
  { value: 'notification', label: 'Bell only' },
  { value: 'email', label: 'Email only' },
];

function parseYmd(iso: string): Date | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) return null;
  const d = new Date(`${iso}T00:00:00Z`);
  return Number.isNaN(d.getTime()) ? null : d;
}

function toYmd(d: Date): string | null {
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}

/** Add calendar months, clamping to the month's end (31 Jan + 1 → 28/29 Feb). */
function addMonths(iso: string, months: number): string | null {
  const d = parseYmd(iso);
  if (!d) return null;
  const day = d.getUTCDate();
  const out = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + months, 1));
  const lastDay = new Date(Date.UTC(out.getUTCFullYear(), out.getUTCMonth() + 1, 0)).getUTCDate();
  out.setUTCDate(Math.min(day, lastDay));
  return toYmd(out);
}

function addDays(iso: string, days: number): string | null {
  const d = parseYmd(iso);
  if (!d) return null;
  d.setUTCDate(d.getUTCDate() + days);
  return toYmd(d);
}

/**
 * The date the form suggests for a record's action — the two rules that used
 * to be separate automatic clocks, now just a default:
 *   · the lead window before a printed expiry (30 days by default)
 *   · the document date plus the type's re-check interval (DVLA: 12 months)
 * Whichever comes first; '' when neither applies (a contract, say). The admin
 * can change or clear it — whatever is left in the box is what fires.
 */
export function suggestActionDate(
  docType: string, documentDate: string, expiresOn: string, defaults: ActionDefaults | null
): string {
  if (!defaults) return '';
  const candidates: string[] = [];
  if (expiresOn) {
    const d = addDays(expiresOn, -defaults.expiryLeadDays);
    if (d) candidates.push(d);
  }
  const months = defaults.intervals[docType] ?? 0;
  if (documentDate && months > 0) {
    const d = addMonths(documentDate, months);
    if (d) candidates.push(d);
  }
  return candidates.sort()[0] ?? '';
}

// Mirrors the CHECK constraint in migration 231. The label is what a human
// reads; the type is what spec §4's review cycles will read.
export const DOC_TYPES: { value: string; label: string }[] = [
  { value: 'contract', label: 'Employment contract' },
  { value: 'right_to_work', label: 'Right to work' },
  { value: 'passport', label: 'Passport' },
  { value: 'licence', label: 'Driving licence' },
  { value: 'dvla_check', label: 'DVLA check' },
  { value: 'qualification', label: 'Qualification / training' },
  { value: 'medical', label: 'Medical' },
  { value: 'other', label: 'Other' },
];

const TYPE_LABEL: Record<string, string> =
  Object.fromEntries(DOC_TYPES.map(t => [t.value, t.label]));

function fmtSize(bytes: string | null): string {
  const n = Number(bytes);
  if (!n) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function fmtDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
}

function todayYmd(): string {
  return new Date().toISOString().slice(0, 10);
}

export default function StaffRecordFiles({ personId, personName, onError }: {
  personId: string;
  personName: string;
  onError: (msg: string) => void;
}) {
  const [files, setFiles] = useState<StaffRecordFile[]>([]);
  const [loading, setLoading] = useState(true);
  // A failed load and an empty list are NOT the same thing. Without this the
  // component renders "No files yet." over a 500, which is exactly how three
  // failing requests looked calm on screen the day this shipped.
  const [loadError, setLoadError] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);

  // Upload form
  const [pending, setPending] = useState<File | null>(null);
  const [label, setLabel] = useState('');
  const [docType, setDocType] = useState('other');
  // The document's own date — signed, issued or checked. Spec §1.3: we ask for
  // the FROM date and derive expiries from it, never the other way round.
  const [documentDate, setDocumentDate] = useState('');
  // The expiry printed ON the document — a different fact from the date above,
  // and the one the reminder fires on.
  const [expiresOn, setExpiresOn] = useState('');
  // The one dated action. Pre-filled from the fields above until the admin
  // types their own date — after that it is theirs and stays put.
  const [actionOn, setActionOn] = useState('');
  const [actionTouched, setActionTouched] = useState(false);
  const [actionKind, setActionKind] = useState<ActionKind>('remind');
  const [actionDelivery, setActionDelivery] = useState<ActionDelivery>('both');
  const [actionRecipient, setActionRecipient] = useState<ActionRecipient>('me');
  const [actionNote, setActionNote] = useState('');
  const [defaults, setDefaults] = useState<ActionDefaults | null>(null);
  const [editing, setEditing] = useState<StaffRecordFile | null>(null);
  const myUserId = useAuthStore(s => s.user?.id ?? null);

  useEffect(() => {
    // A failure here only costs the pre-fill; the form still works by hand.
    api.get<{ data: ActionDefaults }>('/staff-records/action-defaults')
      .then(res => setDefaults(res.data))
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    if (!actionTouched) setActionOn(suggestActionDate(docType, documentDate, expiresOn, defaults));
  }, [docType, documentDate, expiresOn, defaults, actionTouched]);

  const load = useCallback(async () => {
    setLoadError(null);
    try {
      const res = await api.get<{ data: StaffRecordFile[] }>(`/staff-records/${personId}/files`);
      setFiles(res.data);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to load files';
      setLoadError(msg);
      onError(msg);
    } finally {
      setLoading(false);
    }
  }, [personId, onError]);

  useEffect(() => { void load(); }, [load]);

  async function upload() {
    if (!pending) return;
    setUploading(true);
    try {
      const fd = new FormData();
      fd.append('file', pending);
      // Blank label is allowed — the server falls back to the filename rather
      // than refusing the upload.
      fd.append('label', label.trim());
      fd.append('doc_type', docType);
      if (documentDate) fd.append('document_date', documentDate);
      if (expiresOn) fd.append('expires_on', expiresOn);
      if (actionOn) fd.append('action_on', actionOn);
      fd.append('action_kind', actionKind);
      fd.append('action_delivery', actionDelivery);
      fd.append('action_recipient', actionRecipient);
      if (actionNote.trim()) fd.append('action_note', actionNote.trim());
      await api.upload<{ data: StaffRecordFile }>(`/staff-records/${personId}/files`, fd);
      setPending(null);
      setLabel('');
      setDocType('other');
      setDocumentDate('');
      setExpiresOn('');
      setActionOn('');
      setActionTouched(false);
      setActionKind('remind');
      setActionNote('');
      await load();
    } catch (err) {
      onError(err instanceof Error ? err.message : 'Upload failed');
    } finally {
      setUploading(false);
    }
  }

  async function retype(file: StaffRecordFile, doc_type: string) {
    setBusyId(file.id);
    try {
      await api.patch(`/staff-records/files/${file.id}`, { doc_type });
      await load();
    } catch (err) {
      onError(err instanceof Error ? err.message : 'Failed to update the file');
    } finally {
      setBusyId(null);
    }
  }

  async function remove(file: StaffRecordFile) {
    // The bytes really are deleted — worth saying so before they click.
    if (!window.confirm(`Delete "${file.label}"? The file itself is removed permanently; the record that it existed is kept.`)) return;
    setBusyId(file.id);
    try {
      await api.delete(`/staff-records/files/${file.id}`);
      await load();
    } catch (err) {
      onError(err instanceof Error ? err.message : 'Failed to delete the file');
    } finally {
      setBusyId(null);
    }
  }

  async function open(file: StaffRecordFile) {
    try {
      await openAuthedFile(`/files/download?key=${encodeURIComponent(file.r2_key)}`, file.filename);
    } catch (err) {
      onError(err instanceof Error ? err.message : 'Could not open the file');
    }
  }

  return (
    <div>
      <h3 className="text-sm font-medium text-gray-900 mb-1">Private records</h3>
      <p className="text-xs text-gray-500 mb-3">
        Documents held about {personName} — contract, right to work, ID. Admin only;
        {' '}{personName.split(' ')[0]} cannot see these. Not the same as Documents &amp; Training,
        which is what we publish to staff.
      </p>

      {loading ? (
        <p className="text-sm text-gray-500">Loading…</p>
      ) : loadError ? (
        <p className="text-sm text-red-700 mb-3 rounded border border-red-200 bg-red-50 px-3 py-2">
          Couldn’t load these files — {loadError}
        </p>
      ) : files.length === 0 ? (
        <p className="text-sm text-gray-400 mb-3">No files yet.</p>
      ) : (
        <ul className="divide-y divide-gray-100 border border-gray-200 rounded mb-3">
          {files.map(f => (
            <li key={f.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2">
              <button
                onClick={() => void open(f)}
                className="text-sm text-ooosh-700 hover:text-ooosh-900 hover:underline text-left min-w-0 truncate"
                title={f.filename}
              >
                {f.label}
              </button>
              <select
                value={f.doc_type}
                disabled={busyId === f.id}
                onChange={e => void retype(f, e.target.value)}
                className="text-[11px] border border-gray-200 rounded px-1 py-0.5 text-gray-600 bg-white"
                aria-label={`Document type for ${f.label}`}
              >
                {DOC_TYPES.map(t => <option key={t.value} value={t.value}>{t.label}</option>)}
              </select>
              <ActionChip file={f} />
              <span className="text-xs text-gray-400 ml-auto whitespace-nowrap">
                {f.expires_on
                  ? <span className={
                      f.expires_on < new Date().toISOString().slice(0, 10)
                        ? 'text-red-700 font-medium' : 'text-amber-700'
                    }>expires {fmtDate(f.expires_on)} · </span>
                  : null}
                {f.document_date
                  ? <span className="text-gray-600">dated {fmtDate(f.document_date)} · </span>
                  : null}
                {fmtDate(f.uploaded_at)}
                {f.uploaded_by_name && ` · ${f.uploaded_by_name}`}
                {fmtSize(f.size_bytes) && ` · ${fmtSize(f.size_bytes)}`}
              </span>
              <button
                onClick={() => setEditing(f)}
                disabled={busyId === f.id}
                className="text-xs text-ooosh-600 hover:text-ooosh-800 disabled:opacity-40 shrink-0"
              >
                Dates
              </button>
              <button
                onClick={() => void remove(f)}
                disabled={busyId === f.id}
                className="text-xs text-red-600 hover:text-red-800 disabled:opacity-40 shrink-0"
              >
                Delete
              </button>
            </li>
          ))}
        </ul>
      )}

      <div className="flex flex-wrap items-end gap-3">
        <label className="text-sm">
          <span className="block text-xs text-gray-600 mb-1">File</span>
          <input
            type="file"
            onChange={e => {
              const f = e.target.files?.[0] ?? null;
              setPending(f);
              // Pre-fill the label from the filename so the common case is one
              // click; they can still type something better.
              if (f && !label.trim()) setLabel(f.name.replace(/\.[^.]+$/, ''));
            }}
            className="text-sm file:mr-2 file:px-2 file:py-1 file:rounded file:border-0 file:text-xs file:bg-gray-100 file:text-gray-700"
          />
        </label>
        <label className="text-sm">
          <span className="block text-xs text-gray-600 mb-1">Label</span>
          <input
            value={label}
            onChange={e => setLabel(e.target.value)}
            placeholder="e.g. Contract signed Mar 2025"
            maxLength={200}
            className="w-56 px-2 py-1.5 border border-gray-300 rounded text-sm"
          />
        </label>
        <label className="text-sm">
          <span className="block text-xs text-gray-600 mb-1">Document date</span>
          <input
            type="date"
            value={documentDate}
            onChange={e => setDocumentDate(e.target.value)}
            className="px-2 py-1.5 border border-gray-300 rounded text-sm"
          />
        </label>
        <label className="text-sm">
          <span className="block text-xs text-gray-600 mb-1">Expires</span>
          <input
            type="date"
            value={expiresOn}
            onChange={e => setExpiresOn(e.target.value)}
            className="px-2 py-1.5 border border-gray-300 rounded text-sm"
          />
        </label>
        <label className="text-sm">
          <span className="block text-xs text-gray-600 mb-1">Type</span>
          <select
            value={docType}
            onChange={e => setDocType(e.target.value)}
            className="px-2 py-1.5 border border-gray-300 rounded text-sm bg-white"
          >
            {DOC_TYPES.map(t => <option key={t.value} value={t.value}>{t.label}</option>)}
          </select>
        </label>
        <button
          onClick={() => void upload()}
          disabled={!pending || uploading}
          className="px-3 py-1.5 text-sm rounded bg-ooosh-600 text-white hover:bg-ooosh-700 disabled:opacity-40"
        >
          {uploading ? 'Uploading…' : 'Upload'}
        </button>
      </div>
      <ActionFields
        className="mt-3"
        actionOn={actionOn}
        onActionOn={v => { setActionOn(v); setActionTouched(true); }}
        onSuggest={() => { setActionTouched(false); }}
        kind={actionKind} onKind={setActionKind}
        delivery={actionDelivery} onDelivery={setActionDelivery}
        recipient={actionRecipient} onRecipient={setActionRecipient}
        note={actionNote} onNote={setActionNote}
      />
      <p className="text-xs text-gray-400 mt-2">
        PDFs, documents and images up to 25MB. <strong>Document date</strong> is when it was
        signed, issued or checked; <strong>expires</strong> is the date printed on the document
        itself. <strong>Then</strong> is when you want to hear about it again — suggested from
        those two dates, yours to change. {TYPE_LABEL[docType]} files are kept until you delete
        them; “flag for deletion” reminds you, it never deletes on its own.
      </p>

      {editing && (
        <RecordDatesModal
          file={editing}
          defaults={defaults}
          myUserId={myUserId}
          onClose={() => setEditing(null)}
          onSaved={async () => { setEditing(null); await load(); }}
          onError={onError}
        />
      )}
    </div>
  );
}

/** What the record will do next, at a glance. Red once due. */
function ActionChip({ file }: { file: StaffRecordFile }) {
  if (!file.action_on) return null;
  const due = file.action_on <= todayYmd();
  const isDelete = file.action_kind === 'delete';
  const style = due
    ? 'bg-red-50 text-red-700 border-red-200'
    : isDelete ? 'bg-gray-50 text-gray-700 border-gray-200' : 'bg-amber-50 text-amber-800 border-amber-200';
  return (
    <span className={`text-[11px] px-1.5 py-0.5 rounded border whitespace-nowrap ${style}`}
      title={file.action_note || undefined}>
      {isDelete ? (due ? 'Due for deletion' : `Delete by ${fmtDate(file.action_on)}`)
                : `${due ? 'Due' : 'Remind'} ${fmtDate(file.action_on)}`}
    </span>
  );
}

/** The "then" fields — shared by the upload form and the edit modal. */
function ActionFields({
  className = '', actionOn, onActionOn, onSuggest, kind, onKind, delivery, onDelivery,
  recipient, onRecipient, note, onNote,
}: {
  className?: string;
  actionOn: string; onActionOn: (v: string) => void; onSuggest: () => void;
  kind: ActionKind; onKind: (v: ActionKind) => void;
  delivery: ActionDelivery; onDelivery: (v: ActionDelivery) => void;
  recipient: ActionRecipient; onRecipient: (v: ActionRecipient) => void;
  note: string; onNote: (v: string) => void;
}) {
  return (
    <div className={`flex flex-wrap items-end gap-3 ${className}`}>
      <label className="text-sm">
        <span className="block text-xs text-gray-600 mb-1">Then, on</span>
        <input type="date" value={actionOn} onChange={e => onActionOn(e.target.value)}
          className="px-2 py-1.5 border border-gray-300 rounded text-sm" />
      </label>
      <label className="text-sm">
        <span className="block text-xs text-gray-600 mb-1">Do</span>
        <select value={kind} onChange={e => onKind(e.target.value as ActionKind)}
          className="px-2 py-1.5 border border-gray-300 rounded text-sm bg-white">
          <option value="remind">Remind me</option>
          <option value="delete">Flag for deletion</option>
        </select>
      </label>
      <label className="text-sm">
        <span className="block text-xs text-gray-600 mb-1">By</span>
        <select value={delivery} onChange={e => onDelivery(e.target.value as ActionDelivery)}
          className="px-2 py-1.5 border border-gray-300 rounded text-sm bg-white">
          {DELIVERY_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
      </label>
      <label className="text-sm">
        <span className="block text-xs text-gray-600 mb-1">Tell</span>
        <select value={recipient} onChange={e => onRecipient(e.target.value as ActionRecipient)}
          className="px-2 py-1.5 border border-gray-300 rounded text-sm bg-white">
          <option value="me">Me</option>
          <option value="admins">All admins</option>
        </select>
      </label>
      <label className="text-sm flex-1 min-w-[10rem]">
        <span className="block text-xs text-gray-600 mb-1">Note (optional)</span>
        <input value={note} onChange={e => onNote(e.target.value)} maxLength={500}
          placeholder="e.g. ask for this year's check code"
          className="w-full px-2 py-1.5 border border-gray-300 rounded text-sm" />
      </label>
      <button type="button" onClick={onSuggest}
        className="text-xs text-ooosh-600 hover:underline pb-2" title="Re-fill the date from the document dates">
        Suggest
      </button>
      {actionOn && (
        <button type="button" onClick={() => onActionOn('')}
          className="text-xs text-gray-500 hover:underline pb-2">
          No date
        </button>
      )}
    </div>
  );
}

/** Edit a record's dates and its action after upload. */
function RecordDatesModal({ file, defaults, myUserId, onClose, onSaved, onError }: {
  file: StaffRecordFile;
  defaults: ActionDefaults | null;
  myUserId: string | null;
  onClose: () => void;
  onSaved: () => Promise<void>;
  onError: (msg: string) => void;
}) {
  const [documentDate, setDocumentDate] = useState(file.document_date ?? '');
  const [expiresOn, setExpiresOn] = useState(file.expires_on ?? '');
  const [actionOn, setActionOn] = useState(file.action_on ?? '');
  const [kind, setKind] = useState<ActionKind>(file.action_kind);
  const [delivery, setDelivery] = useState<ActionDelivery>(file.action_delivery);
  // Stored as a user id; shown as "me" only when it IS me. Somebody else's id
  // reads as "All admins" here, which is the honest nearest option — saving
  // would re-point it at me or at everyone, never at a stranger.
  const [recipient, setRecipient] = useState<ActionRecipient>(
    file.action_user_id && file.action_user_id === myUserId ? 'me' : 'admins');
  const [note, setNote] = useState(file.action_note ?? '');
  const [saving, setSaving] = useState(false);

  async function save() {
    setSaving(true);
    try {
      await api.patch(`/staff-records/files/${file.id}`, {
        document_date: documentDate,
        expires_on: expiresOn,
        action_on: actionOn,
        action_kind: kind,
        action_delivery: delivery,
        action_recipient: recipient,
        action_note: note.trim() || null,
      });
      await onSaved();
    } catch (err) {
      onError(err instanceof Error ? err.message : 'Failed to save the dates');
      setSaving(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/50" onClick={() => { if (!saving) onClose(); }} />
      <div className="relative bg-white rounded-xl shadow-xl w-full max-w-2xl mx-4 p-6 max-h-[90vh] overflow-y-auto">
        <h3 className="text-lg font-semibold text-gray-900 mb-1">{file.label}</h3>
        <p className="text-xs text-gray-500 mb-4">
          {TYPE_LABEL[file.doc_type] ?? file.doc_type}. Changing the “then” date or what it does
          re-arms the reminder.
        </p>
        <div className="flex flex-wrap items-end gap-3 mb-3">
          <label className="text-sm">
            <span className="block text-xs text-gray-600 mb-1">Document date</span>
            <input type="date" value={documentDate} onChange={e => setDocumentDate(e.target.value)}
              className="px-2 py-1.5 border border-gray-300 rounded text-sm" />
          </label>
          <label className="text-sm">
            <span className="block text-xs text-gray-600 mb-1">Expires</span>
            <input type="date" value={expiresOn} onChange={e => setExpiresOn(e.target.value)}
              className="px-2 py-1.5 border border-gray-300 rounded text-sm" />
          </label>
        </div>
        <ActionFields
          actionOn={actionOn} onActionOn={setActionOn}
          onSuggest={() => setActionOn(suggestActionDate(file.doc_type, documentDate, expiresOn, defaults))}
          kind={kind} onKind={setKind}
          delivery={delivery} onDelivery={setDelivery}
          recipient={recipient} onRecipient={setRecipient}
          note={note} onNote={setNote}
        />
        <div className="flex justify-end gap-2 mt-5">
          <button onClick={onClose} disabled={saving}
            className="px-3 py-1.5 text-sm rounded border border-gray-300 hover:bg-gray-50 disabled:opacity-40">
            Cancel
          </button>
          <button onClick={() => void save()} disabled={saving}
            className="px-3 py-1.5 text-sm rounded bg-ooosh-600 text-white hover:bg-ooosh-700 disabled:opacity-40">
            {saving ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  );
}
