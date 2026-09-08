/**
 * EntityFilesSection — the shared Files surface.
 *
 * Extracted verbatim from the inline `JobFilesSection` that lived in
 * JobDetailPage, then generalised over the entity it hangs off. Upload,
 * drag & drop, external links, tag + comment, freelancer share toggle,
 * inline view, email and delete — all of it works the same whether the
 * files belong to a job, an organisation, a person, a venue or a driver,
 * because the backend `/api/files/*` routes were already entity-generic.
 *
 * Files live in the owning row's `files` JSONB column; `onChanged` is the
 * caller's cue to refetch that row.
 *
 * See docs/CROSS-ENTITY-FILES-SPEC.md (Phase 2).
 */
import { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import { api } from '../services/api';
import FileEmailModal from './FileEmailModal';
import type { FileAttachment } from '@shared/index';

/** Entities with a `files` JSONB column and a Files surface. */
export type FileEntityType = 'jobs' | 'organisations' | 'people' | 'venues' | 'drivers';

// Wording for the "email this file" modal heading, per surface.
const EMAIL_CONTEXT: Record<FileEntityType, string> = {
  jobs: 'Send this file from the job to one or more recipients',
  organisations: 'Send this file from the organisation to one or more recipients',
  people: 'Send this file from the contact to one or more recipients',
  venues: 'Send this file from the venue to one or more recipients',
  drivers: 'Send this file from the driver to one or more recipients',
};

export const FILE_TAGS = [
  'Stage Plot', 'Rider', 'Tour Dates', 'Quote', 'Invoice',
  'Contract', 'Production Schedule', 'Site Map', 'Risk Assessment', 'Other',
] as const;

export function fileTagColour(label: string): string {
  const map: Record<string, string> = {
    'Stage Plot': 'bg-purple-100 text-purple-700',
    'Rider': 'bg-blue-100 text-blue-700',
    'Tour Dates': 'bg-amber-100 text-amber-700',
    'Quote': 'bg-green-100 text-green-700',
    'Invoice': 'bg-emerald-100 text-emerald-700',
    'Contract': 'bg-red-100 text-red-700',
    'Production Schedule': 'bg-indigo-100 text-indigo-700',
    'Site Map': 'bg-teal-100 text-teal-700',
    'Risk Assessment': 'bg-orange-100 text-orange-700',
  };
  return map[label] || 'bg-gray-100 text-gray-600';
}

// Check if a file can be previewed inline
export function isPreviewable(name: string): 'image' | 'pdf' | 'spreadsheet' | null {
  const lower = name.toLowerCase();
  if (/\.(jpg|jpeg|png|gif|webp|svg)$/.test(lower)) return 'image';
  if (/\.pdf$/.test(lower)) return 'pdf';
  if (/\.(xlsx|xls|csv)$/.test(lower)) return 'spreadsheet';
  return null;
}

// ── File Viewer Modal ────────────────────────────────────

// Inline spreadsheet preview (.xlsx / .xls / .csv). SheetJS is loaded lazily
// (dynamic import) so the ~400KB parser stays out of the main bundle and only
// executes when a staff member actually opens a spreadsheet. Renders a
// read-only data table — computed cell values only; complex formatting, charts
// and merged-cell layout are lossy (download for full fidelity).
const SHEET_MAX_ROWS = 500;
const SHEET_MAX_COLS = 50;

function SpreadsheetPreview({ blob }: { blob: Blob }) {
  const [book, setBook] = useState<{ XLSX: typeof import('xlsx'); wb: import('xlsx').WorkBook } | null>(null);
  const [active, setActive] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError('');
    setActive(0);
    (async () => {
      try {
        const XLSX = await import('xlsx');
        const buf = await blob.arrayBuffer();
        const wb = XLSX.read(buf, { type: 'array' });
        if (!cancelled) setBook({ XLSX, wb });
      } catch {
        if (!cancelled) setError('Could not read this spreadsheet — try downloading it instead.');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [blob]);

  const grid = useMemo(() => {
    if (!book) return null;
    const { XLSX, wb } = book;
    const name = wb.SheetNames[active];
    const ws = name ? wb.Sheets[name] : undefined;
    if (!ws) return { rows: [] as string[][], moreRows: 0, moreCols: 0 };
    const aoa = XLSX.utils.sheet_to_json<unknown[]>(ws, { header: 1, blankrows: false, defval: '' });
    const moreRows = Math.max(0, aoa.length - SHEET_MAX_ROWS);
    let moreCols = 0;
    const rows = aoa.slice(0, SHEET_MAX_ROWS).map((r) => {
      const row = Array.isArray(r) ? r : [];
      moreCols = Math.max(moreCols, Math.max(0, row.length - SHEET_MAX_COLS));
      return row.slice(0, SHEET_MAX_COLS).map((c) => (c == null ? '' : String(c)));
    });
    return { rows, moreRows, moreCols };
  }, [book, active]);

  if (loading) {
    return <div className="animate-spin h-8 w-8 border-4 border-ooosh-600 border-t-transparent rounded-full" />;
  }
  if (error || !book || !grid) {
    return <p className="text-sm text-red-600">{error || 'Could not read this spreadsheet.'}</p>;
  }

  const [headerRow, ...bodyRows] = grid.rows;

  return (
    <div className="w-full h-full flex flex-col min-h-0">
      {book.wb.SheetNames.length > 1 && (
        <div className="flex flex-wrap gap-1 mb-2 shrink-0">
          {book.wb.SheetNames.map((name, i) => (
            <button
              key={name}
              type="button"
              onClick={() => setActive(i)}
              className={`px-2 py-1 text-xs rounded border ${
                i === active
                  ? 'bg-ooosh-600 text-white border-ooosh-600'
                  : 'bg-white text-gray-600 border-gray-300 hover:bg-gray-50'
              }`}
            >
              {name}
            </button>
          ))}
        </div>
      )}
      <div className="flex-1 overflow-auto border border-gray-200 rounded min-h-0">
        {grid.rows.length === 0 ? (
          <p className="text-sm text-gray-500 p-4">This sheet is empty.</p>
        ) : (
          <table className="text-xs border-collapse">
            {headerRow && (
              <thead className="sticky top-0 bg-gray-100">
                <tr>
                  {headerRow.map((cell, ci) => (
                    <th key={ci} className="border border-gray-200 px-2 py-1 text-left font-semibold text-gray-700 whitespace-nowrap">
                      {cell}
                    </th>
                  ))}
                </tr>
              </thead>
            )}
            <tbody>
              {bodyRows.map((row, ri) => (
                <tr key={ri} className="odd:bg-white even:bg-gray-50">
                  {(headerRow || []).map((_, ci) => (
                    <td key={ci} className="border border-gray-200 px-2 py-1 text-gray-700 whitespace-nowrap">
                      {row[ci] ?? ''}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      {(grid.moreRows > 0 || grid.moreCols > 0) && (
        <p className="text-xs text-amber-600 mt-2 shrink-0">
          Preview truncated
          {grid.moreRows > 0 ? ` — ${grid.moreRows} more row${grid.moreRows === 1 ? '' : 's'}` : ''}
          {grid.moreCols > 0 ? ` — ${grid.moreCols} more column${grid.moreCols === 1 ? '' : 's'}` : ''}
          . Download for the full file.
        </p>
      )}
    </div>
  );
}

export function FileViewerModal({
  file,
  onClose,
}: {
  file: FileAttachment | null;
  onClose: () => void;
}) {
  const [objectUrl, setObjectUrl] = useState<string | null>(null);
  const [blob, setBlob] = useState<Blob | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const loadFile = useCallback(async () => {
    if (!file) return;
    setLoading(true);
    setError('');
    try {
      const { blob } = await api.blob(`/files/download?key=${encodeURIComponent(file.url)}`);
      const url = URL.createObjectURL(blob);
      setObjectUrl(url);
      setBlob(blob);
    } catch {
      setError('Failed to load file');
    } finally {
      setLoading(false);
    }
  }, [file]);

  useEffect(() => {
    loadFile();
    return () => {
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [file]);

  if (!file) return null;

  const previewType = isPreviewable(file.name);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/50" onClick={onClose} />
      <div className={`relative bg-white rounded-xl shadow-xl w-full mx-4 max-h-[90vh] flex flex-col ${previewType === 'spreadsheet' ? 'max-w-6xl' : 'max-w-4xl'}`}>
        {/* Header */}
        <div className="flex items-center justify-between p-4 border-b border-gray-200">
          <div className="flex items-center gap-3 min-w-0">
            <h3 className="text-sm font-semibold text-gray-900 truncate">{file.name}</h3>
            {file.label && (
              <span className={`inline-flex px-1.5 py-0.5 rounded text-xs font-medium ${fileTagColour(file.label)}`}>
                {file.label}
              </span>
            )}
          </div>
          <div className="flex items-center gap-2">
            {objectUrl && (
              <a
                href={objectUrl}
                download={file.name}
                className="px-3 py-1.5 text-sm border border-gray-300 rounded-lg hover:bg-gray-50"
              >
                Download
              </a>
            )}
            <button
              onClick={onClose}
              className="px-3 py-1.5 text-sm border border-gray-300 rounded-lg hover:bg-gray-50"
            >
              Close
            </button>
          </div>
        </div>

        {/* Comment */}
        {file.comment && (
          <div className="px-4 py-2 bg-gray-50 border-b border-gray-200">
            <p className="text-sm text-gray-600">{file.comment}</p>
          </div>
        )}

        {/* Content */}
        <div className="flex-1 overflow-auto p-4 flex items-center justify-center min-h-[300px]">
          {loading && (
            <div className="animate-spin h-8 w-8 border-4 border-ooosh-600 border-t-transparent rounded-full" />
          )}
          {error && <p className="text-sm text-red-600">{error}</p>}
          {objectUrl && previewType === 'image' && (
            <img src={objectUrl} alt={file.name} className="max-w-full max-h-[70vh] object-contain" />
          )}
          {objectUrl && previewType === 'pdf' && (
            <iframe
              src={objectUrl}
              title={file.name}
              className="w-full h-[70vh] border-0"
            />
          )}
          {blob && previewType === 'spreadsheet' && (
            <SpreadsheetPreview blob={blob} />
          )}
          {objectUrl && !previewType && (
            <div className="text-center">
              <p className="text-sm text-gray-500 mb-3">Preview not available for this file type.</p>
              <a
                href={objectUrl}
                download={file.name}
                className="px-4 py-2 bg-ooosh-600 text-white text-sm font-medium rounded-lg hover:bg-ooosh-700"
              >
                Download File
              </a>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Files Section ───────────────────────────────────────

export default function EntityFilesSection({
  entityType,
  entityId,
  files,
  onChanged,
}: {
  entityType: FileEntityType;
  entityId: string;
  files: FileAttachment[];
  /** Called after any change (upload, link, edit, delete, email) — refetch the entity. */
  onChanged: () => void;
}) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const [selectedTag, setSelectedTag] = useState('');
  const [customTag, setCustomTag] = useState('');
  const [fileComment, setFileComment] = useState('');
  const [deleting, setDeleting] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [filterTag, setFilterTag] = useState('');
  const [viewingFile, setViewingFile] = useState<FileAttachment | null>(null);
  const [emailingFile, setEmailingFile] = useState<FileAttachment | null>(null);
  const [dragOver, setDragOver] = useState(false);

  // Link-adding mode (external URLs — Dropbox/WeTransfer/Drive links etc.)
  const [linkMode, setLinkMode] = useState(false);
  const [linkUrl, setLinkUrl] = useState('');
  const [linkName, setLinkName] = useState('');
  const [addingLink, setAddingLink] = useState(false);

  // When the tag is "Other", the user types a free-text tag instead. This
  // resolves the value actually saved as the label.
  const effectiveTag = selectedTag === 'Other' ? customTag.trim() : selectedTag;
  const resetMeta = () => {
    setSelectedTag('');
    setCustomTag('');
    setFileComment('');
  };

  // Post-save metadata edit — keyed on file URL because that's stable
  // across re-renders (label/comment shift around as users edit).
  const [editingFileUrl, setEditingFileUrl] = useState<string | null>(null);
  const [editLabel, setEditLabel] = useState('');
  const [editCustomTag, setEditCustomTag] = useState('');
  const [editComment, setEditComment] = useState('');
  const [savingEdit, setSavingEdit] = useState(false);

  const effectiveEditTag = editLabel === 'Other' ? editCustomTag.trim() : editLabel;

  const startEdit = (file: FileAttachment) => {
    setEditingFileUrl(file.url);
    setEditLabel(file.label || '');
    setEditCustomTag('');
    setEditComment(file.comment || '');
  };
  const cancelEdit = () => {
    setEditingFileUrl(null);
    setEditLabel('');
    setEditCustomTag('');
    setEditComment('');
  };
  const saveEdit = async (file: FileAttachment) => {
    setSavingEdit(true);
    setError('');
    try {
      await api.patch('/files/update-metadata', {
        entity_type: entityType,
        entity_id: entityId,
        file_url: file.url,
        updates: {
          label: effectiveEditTag.trim() || null,
          comment: editComment.trim() || null,
        },
      });
      cancelEdit();
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update file');
    } finally {
      setSavingEdit(false);
    }
  };

  const handleToggleShare = async (file: FileAttachment) => {
    try {
      await api.patch('/files/update-metadata', {
        entity_type: entityType,
        entity_id: entityId,
        file_url: file.url,
        updates: { share_with_freelancer: !file.share_with_freelancer },
      });
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update share status');
    }
  };

  const uploadFile = async (file: File) => {
    setUploading(true);
    setError('');
    try {
      const formData = new FormData();
      formData.append('file', file);
      formData.append('entity_type', entityType);
      formData.append('entity_id', entityId);
      if (effectiveTag) formData.append('label', effectiveTag);
      if (fileComment.trim()) formData.append('comment', fileComment.trim());

      await api.upload('/files/upload', formData);
      resetMeta();
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Upload failed');
    } finally {
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  const handleUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) void uploadFile(file);
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    const file = e.dataTransfer.files?.[0];
    if (file) void uploadFile(file);
  };

  const addLink = async () => {
    if (!linkUrl.trim()) return;
    setAddingLink(true);
    setError('');
    try {
      await api.post('/files/add-link', {
        entity_type: entityType,
        entity_id: entityId,
        url: linkUrl.trim(),
        name: linkName.trim() || undefined,
        label: effectiveTag || undefined,
        comment: fileComment.trim() || undefined,
      });
      setLinkUrl('');
      setLinkName('');
      setLinkMode(false);
      resetMeta();
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to add link');
    } finally {
      setAddingLink(false);
    }
  };

  const handleDelete = async (fileUrl: string) => {
    if (!confirm('Delete this file?')) return;
    setDeleting(fileUrl);
    try {
      await api.deleteWithBody('/files/delete', {
        key: fileUrl,
        entity_type: entityType,
        entity_id: entityId,
      });
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Delete failed');
    } finally {
      setDeleting(null);
    }
  };

  const existingTags = [...new Set(files.map(f => f.label).filter(Boolean))] as string[];
  const filteredFiles = filterTag
    ? files.filter(f => f.label === filterTag)
    : files;

  return (
    <div className="space-y-6">
      {/* Upload section */}
      <div
        className={`bg-white rounded-xl shadow-sm border p-6 transition-colors ${
          dragOver ? 'border-ooosh-400 ring-2 ring-ooosh-200 bg-ooosh-50/40' : 'border-gray-200'
        }`}
        onDragOver={(e) => { e.preventDefault(); if (!dragOver) setDragOver(true); }}
        onDragLeave={(e) => { e.preventDefault(); setDragOver(false); }}
        onDrop={handleDrop}
      >
        <h3 className="text-sm font-semibold text-gray-700 mb-4">Add File or Link</h3>

        {error && (
          <div className="mb-4 p-3 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700">{error}</div>
        )}

        <div className="space-y-3">
          <div className="flex items-end gap-3 flex-wrap">
            <div>
              <label className="block text-xs font-medium text-gray-500 mb-1">Tag</label>
              <select
                value={selectedTag}
                onChange={(e) => setSelectedTag(e.target.value)}
                className="border border-gray-300 rounded px-3 py-2 text-sm focus:border-ooosh-500 focus:outline-none focus:ring-1 focus:ring-ooosh-500"
              >
                <option value="">No tag</option>
                {FILE_TAGS.map(tag => (
                  <option key={tag} value={tag}>{tag}</option>
                ))}
              </select>
            </div>
            {selectedTag === 'Other' && (
              <div>
                <label className="block text-xs font-medium text-gray-500 mb-1">Custom tag</label>
                <input
                  type="text"
                  value={customTag}
                  onChange={(e) => setCustomTag(e.target.value)}
                  placeholder="e.g. Client Files"
                  className="border border-gray-300 rounded px-3 py-2 text-sm focus:border-ooosh-500 focus:outline-none focus:ring-1 focus:ring-ooosh-500"
                />
              </div>
            )}
            <div className="flex-1 min-w-[200px]">
              <label className="block text-xs font-medium text-gray-500 mb-1">Comment</label>
              <input
                type="text"
                value={fileComment}
                onChange={(e) => setFileComment(e.target.value)}
                placeholder="Optional note about this file or link..."
                className="w-full border border-gray-300 rounded px-3 py-2 text-sm focus:border-ooosh-500 focus:outline-none focus:ring-1 focus:ring-ooosh-500"
              />
            </div>
            <div className="flex items-center gap-2">
              <input
                ref={fileInputRef}
                type="file"
                onChange={handleUpload}
                accept=".pdf,.doc,.docx,.xls,.xlsx,.csv,.txt,.rtf,.jpg,.jpeg,.png,.gif,.webp,.svg,.zip,.rar"
                className="hidden"
                id={`file-upload-${entityId}`}
              />
              <button
                onClick={() => fileInputRef.current?.click()}
                disabled={uploading}
                className="px-4 py-2 bg-ooosh-600 text-white text-sm font-medium rounded-lg hover:bg-ooosh-700 disabled:opacity-50"
              >
                {uploading ? 'Uploading...' : 'Choose File'}
              </button>
              <button
                onClick={() => { setLinkMode(!linkMode); setError(''); }}
                className={`px-4 py-2 text-sm font-medium rounded-lg border transition-colors ${
                  linkMode
                    ? 'bg-ooosh-50 border-ooosh-300 text-ooosh-700'
                    : 'border-gray-300 text-gray-700 hover:bg-gray-50'
                }`}
              >
                🔗 Add Link
              </button>
            </div>
          </div>

          {linkMode && (
            <div className="flex items-end gap-3 flex-wrap pt-2 border-t border-gray-100">
              <div className="flex-1 min-w-[260px]">
                <label className="block text-xs font-medium text-gray-500 mb-1">Link URL</label>
                <input
                  type="url"
                  value={linkUrl}
                  onChange={(e) => setLinkUrl(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') void addLink(); }}
                  placeholder="https://www.dropbox.com/..."
                  className="w-full border border-gray-300 rounded px-3 py-2 text-sm focus:border-ooosh-500 focus:outline-none focus:ring-1 focus:ring-ooosh-500"
                  autoFocus
                />
              </div>
              <div className="flex-1 min-w-[180px]">
                <label className="block text-xs font-medium text-gray-500 mb-1">Display name <span className="text-gray-400">(optional)</span></label>
                <input
                  type="text"
                  value={linkName}
                  onChange={(e) => setLinkName(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') void addLink(); }}
                  placeholder="e.g. Dropbox — full rider"
                  className="w-full border border-gray-300 rounded px-3 py-2 text-sm focus:border-ooosh-500 focus:outline-none focus:ring-1 focus:ring-ooosh-500"
                />
              </div>
              <button
                onClick={() => void addLink()}
                disabled={addingLink || !linkUrl.trim()}
                className="px-4 py-2 bg-ooosh-600 text-white text-sm font-medium rounded-lg hover:bg-ooosh-700 disabled:opacity-50"
              >
                {addingLink ? 'Adding...' : 'Add Link'}
              </button>
            </div>
          )}

          <p className="text-xs text-gray-400">
            PDF, images, docs, spreadsheets. Max 25MB. Drag &amp; drop a file anywhere on this box. Images and PDFs view inline; links open in a new tab.
          </p>
        </div>
      </div>

      {/* File list */}
      <div className="bg-white rounded-xl shadow-sm border border-gray-200 p-6">
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-sm font-semibold text-gray-700">
            Files {files.length > 0 && `(${files.length})`}
          </h3>
          {existingTags.length > 0 && (
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-xs text-gray-400">Filter:</span>
              <button
                onClick={() => setFilterTag('')}
                className={`text-xs px-2 py-0.5 rounded ${
                  !filterTag ? 'bg-ooosh-100 text-ooosh-700 font-medium' : 'text-gray-500 hover:bg-gray-100'
                }`}
              >
                All
              </button>
              {existingTags.map(tag => (
                <button
                  key={tag}
                  onClick={() => setFilterTag(tag === filterTag ? '' : tag)}
                  className={`text-xs px-2 py-0.5 rounded ${
                    filterTag === tag ? 'bg-ooosh-100 text-ooosh-700 font-medium' : 'text-gray-500 hover:bg-gray-100'
                  }`}
                >
                  {tag}
                </button>
              ))}
            </div>
          )}
        </div>

        {filteredFiles.length === 0 ? (
          <p className="text-sm text-gray-400 py-8 text-center">
            {files.length === 0 ? 'No files uploaded yet' : 'No files match this filter'}
          </p>
        ) : (
          <div className="space-y-2">
            {filteredFiles.map((file, idx) => {
              const isLink = file.type === 'link';
              const canPreview = !isLink && isPreviewable(file.name);
              const isEditing = editingFileUrl === file.url;
              const openFile = () => {
                if (isLink) {
                  window.open(file.url, '_blank', 'noopener,noreferrer');
                } else {
                  setViewingFile(file);
                }
              };
              return (
                <div
                  key={file.url || idx}
                  className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between p-3 rounded-lg border border-gray-100 hover:border-gray-200 hover:bg-gray-50 group"
                >
                  <div className="flex items-start gap-3 min-w-0 flex-1">
                    <div className={`w-8 h-8 rounded flex items-center justify-center text-xs font-bold flex-shrink-0 ${
                      isLink ? 'bg-sky-100 text-sky-600' :
                      file.type === 'image' ? 'bg-purple-100 text-purple-600' :
                      file.type === 'document' ? 'bg-blue-100 text-blue-600' :
                      'bg-gray-100 text-gray-500'
                    }`}>
                      {isLink ? '🔗' : file.type === 'image' ? 'IMG' : file.type === 'document' ? 'DOC' : 'FILE'}
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2 min-w-0">
                        <button
                          onClick={openFile}
                          className="text-sm font-medium text-gray-900 hover:text-ooosh-600 truncate text-left"
                        >
                          {file.name}
                          {isLink ? (
                            <span className="text-xs text-gray-400 ml-1">(open link ↗)</span>
                          ) : canPreview ? (
                            <span className="text-xs text-gray-400 ml-1">(click to view)</span>
                          ) : null}
                        </button>
                        {!isEditing && file.label && (
                          <span className={`inline-flex px-1.5 py-0.5 rounded text-xs font-medium flex-shrink-0 ${fileTagColour(file.label)}`}>
                            {file.label}
                          </span>
                        )}
                      </div>
                      {isEditing ? (
                        <div className="mt-2 space-y-2">
                          <div className="flex items-center gap-2 flex-wrap">
                            <label className="text-xs text-gray-500">Tag:</label>
                            <select
                              value={editLabel}
                              onChange={(e) => setEditLabel(e.target.value)}
                              className="text-xs border border-gray-300 rounded px-2 py-1 focus:border-ooosh-500 focus:outline-none focus:ring-1 focus:ring-ooosh-500"
                            >
                              <option value="">No tag</option>
                              {FILE_TAGS.map(tag => (
                                <option key={tag} value={tag}>{tag}</option>
                              ))}
                              {/* Preserve a custom value not in the standard list */}
                              {editLabel && !FILE_TAGS.includes(editLabel as typeof FILE_TAGS[number]) && (
                                <option value={editLabel}>{editLabel}</option>
                              )}
                            </select>
                            {editLabel === 'Other' && (
                              <input
                                type="text"
                                value={editCustomTag}
                                onChange={(e) => setEditCustomTag(e.target.value)}
                                placeholder="Custom tag"
                                className="text-xs border border-gray-300 rounded px-2 py-1 focus:border-ooosh-500 focus:outline-none focus:ring-1 focus:ring-ooosh-500"
                              />
                            )}
                          </div>
                          <input
                            type="text"
                            value={editComment}
                            onChange={(e) => setEditComment(e.target.value)}
                            placeholder="Comment / note about this file"
                            className="w-full text-xs border border-gray-300 rounded px-2 py-1 focus:border-ooosh-500 focus:outline-none focus:ring-1 focus:ring-ooosh-500"
                          />
                          <div className="flex items-center gap-2">
                            <button
                              onClick={() => saveEdit(file)}
                              disabled={savingEdit}
                              className="text-xs px-3 py-1 bg-ooosh-600 text-white rounded hover:bg-ooosh-700 disabled:opacity-50"
                            >
                              {savingEdit ? 'Saving…' : 'Save'}
                            </button>
                            <button
                              onClick={cancelEdit}
                              disabled={savingEdit}
                              className="text-xs px-3 py-1 text-gray-600 hover:bg-gray-100 rounded"
                            >
                              Cancel
                            </button>
                          </div>
                        </div>
                      ) : (
                        <>
                          {file.comment && (
                            <p className="text-xs text-gray-500 mt-0.5 truncate">{file.comment}</p>
                          )}
                          <p className="text-xs text-gray-400">
                            {file.uploaded_by} &middot; {new Date(file.uploaded_at).toLocaleDateString('en-GB', {
                              day: 'numeric', month: 'short', year: 'numeric',
                            })}
                          </p>
                        </>
                      )}
                    </div>
                  </div>
                  {!isEditing && (
                    <div className="flex items-center gap-2 flex-wrap flex-shrink-0 pl-11 sm:pl-0 sm:ml-2">
                      <button
                        onClick={() => handleToggleShare(file)}
                        className={`text-xs px-2 py-0.5 rounded border transition-colors ${
                          file.share_with_freelancer
                            ? 'bg-green-50 border-green-200 text-green-700'
                            : 'bg-gray-50 border-gray-200 text-gray-400 opacity-100 sm:opacity-0 sm:group-hover:opacity-100'
                        }`}
                        title={file.share_with_freelancer ? 'Shared with freelancers — click to unshare' : 'Share with freelancers'}
                      >
                        {file.share_with_freelancer ? 'Shared' : 'Share'}
                      </button>
                      {!isLink && (
                        <button
                          onClick={() => setEmailingFile(file)}
                          className="text-xs text-ooosh-600 hover:text-ooosh-700 font-medium opacity-100 sm:opacity-0 sm:group-hover:opacity-100 transition-opacity"
                          title="Email this file"
                        >
                          Email
                        </button>
                      )}
                      <button
                        onClick={() => startEdit(file)}
                        className="text-xs text-gray-600 hover:text-gray-800 font-medium opacity-100 sm:opacity-0 sm:group-hover:opacity-100 transition-opacity"
                        title="Edit tag / comment"
                      >
                        Edit
                      </button>
                      {!isLink && (
                        <button
                          onClick={() => setViewingFile(file)}
                          className="text-xs text-ooosh-600 hover:text-ooosh-700 font-medium opacity-100 sm:opacity-0 sm:group-hover:opacity-100 transition-opacity"
                        >
                          View
                        </button>
                      )}
                      <button
                        onClick={() => handleDelete(file.url)}
                        disabled={deleting === file.url}
                        className="text-xs text-red-500 hover:text-red-700 font-medium disabled:opacity-50 opacity-100 sm:opacity-0 sm:group-hover:opacity-100 transition-opacity"
                      >
                        {deleting === file.url ? '...' : 'Delete'}
                      </button>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* File viewer modal */}
      {viewingFile && (
        <FileViewerModal
          file={viewingFile}
          onClose={() => setViewingFile(null)}
        />
      )}

      {/* File email modal */}
      {emailingFile && (
        <FileEmailModal
          file={{
            name: emailingFile.name,
            url: emailingFile.url,
            label: emailingFile.label,
            comment: emailingFile.comment,
          }}
          entityType={entityType}
          entityId={entityId}
          contextLabel={EMAIL_CONTEXT[entityType]}
          onClose={() => setEmailingFile(null)}
          onSent={() => {
            setEmailingFile(null);
            onChanged();
          }}
        />
      )}

    </div>
  );
}
