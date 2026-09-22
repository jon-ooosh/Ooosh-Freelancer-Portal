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
 */

import { useCallback, useEffect, useState } from 'react';
import { api } from '../services/api';
import { openAuthedFile } from '../lib/openAuthedFile';

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
  uploaded_at: string;
  uploaded_by_name: string | null;
}

// Mirrors the CHECK constraint in migration 231. The label is what a human
// reads; the type is what spec §4's review cycles will read.
const DOC_TYPES: { value: string; label: string }[] = [
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
  return new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
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
      await api.upload<{ data: StaffRecordFile }>(`/staff-records/${personId}/files`, fd);
      setPending(null);
      setLabel('');
      setDocType('other');
      setDocumentDate('');
      setExpiresOn('');
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
      <p className="text-xs text-gray-400 mt-2">
        PDFs, documents and images up to 25MB. <strong>Document date</strong> is when it was
        signed, issued or checked; <strong>expires</strong> is the date printed on the document
        itself, and you’ll be reminded before it passes. {TYPE_LABEL[docType]} files are kept
        until you delete them; retention rules per type are still to come.
      </p>
    </div>
  );
}
