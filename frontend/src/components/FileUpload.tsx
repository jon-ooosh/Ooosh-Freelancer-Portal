import { useState, useRef } from 'react';
import { api } from '../services/api';

interface FileAttachment {
  name: string;
  label?: string;
  url: string;
  type: 'document' | 'image' | 'other';
  uploaded_at: string;
  uploaded_by: string;
}

interface FileUploadProps {
  entityType: 'people' | 'organisations' | 'venues' | 'interactions';
  entityId: string;
  files: FileAttachment[];
  onFilesChanged: (files: FileAttachment[]) => void;
  onActivityCreated?: () => void;
  readOnly?: boolean;
}

const FILE_ICONS: Record<string, string> = {
  document: 'M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z',
  image: 'M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z',
  other: 'M7 21h10a2 2 0 002-2V9.414a1 1 0 00-.293-.707l-5.414-5.414A1 1 0 0012.586 3H7a2 2 0 00-2 2v14a2 2 0 002 2z',
};

const LABEL_SUGGESTIONS = [
  'Tech spec', 'Stage plot', 'Receipt', 'Map', 'XS scan',
  'Contract', 'Risk assessment', 'Photo', 'Invoice', 'Other',
];

export default function FileUpload({ entityType, entityId, files, onFilesChanged, onActivityCreated, readOnly }: FileUploadProps) {
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState('');
  const [pendingFiles, setPendingFiles] = useState<File[]>([]);
  const [label, setLabel] = useState('');
  const fileInputRef = useRef<HTMLInputElement>(null);

  function handleFileSelected(e: React.ChangeEvent<HTMLInputElement>) {
    const selectedFiles = e.target.files;
    if (!selectedFiles || selectedFiles.length === 0) return;
    setPendingFiles(Array.from(selectedFiles));
    setLabel('');
    if (fileInputRef.current) fileInputRef.current.value = '';
  }

  async function handleUpload() {
    if (pendingFiles.length === 0) return;

    setUploading(true);
    setError('');

    try {
      let updatedFiles = [...files];
      for (const file of pendingFiles) {
        const formData = new FormData();
        formData.append('file', file);
        formData.append('entity_type', entityType);
        formData.append('entity_id', entityId);
        if (label.trim()) {
          formData.append('label', label.trim());
        }

        const result = await api.upload<FileAttachment>('/files/upload', formData);
        updatedFiles = [...updatedFiles, result];
      }
      onFilesChanged(updatedFiles);
      setPendingFiles([]);
      setLabel('');
      onActivityCreated?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Upload failed');
    } finally {
      setUploading(false);
    }
  }

  function handleCancelPending() {
    setPendingFiles([]);
    setLabel('');
  }

  async function handleDelete(file: FileAttachment) {
    if (!confirm(`Delete "${file.label || file.name}"?`)) return;

    try {
      await api.deleteWithBody('/files/delete', {
        key: file.url,
        entity_type: entityType,
        entity_id: entityId,
      });
      onFilesChanged(files.filter(f => f.url !== file.url));
      onActivityCreated?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Delete failed');
    }
  }

  function handleDownload(file: FileAttachment) {
    window.open(`/api/files/download?key=${encodeURIComponent(file.url)}`, '_blank');
  }

  function formatDate(dateStr: string) {
    return new Date(dateStr).toLocaleDateString('en-GB', {
      day: 'numeric', month: 'short', year: 'numeric',
    });
  }

  return (
    <div>
      <label className="block text-xs font-medium text-gray-500 uppercase tracking-wider mb-2">Files</label>

      {error && (
        <div className="bg-red-50 text-red-700 px-3 py-1.5 rounded text-xs mb-2">{error}</div>
      )}

      {/* File list */}
      {files.length > 0 && (
        <div className="space-y-1.5 mb-3">
          {files.map((file, idx) => (
            <div key={idx} className="flex items-center gap-2 p-2 bg-gray-50 rounded border border-gray-100 group">
              <svg className="w-4 h-4 text-gray-400 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d={FILE_ICONS[file.type] || FILE_ICONS.other} />
              </svg>
              <button
                type="button"
                onClick={() => handleDownload(file)}
                className="flex-1 text-left text-sm truncate"
                title={file.name}
              >
                {file.label ? (
                  <>
                    <span className="text-ooosh-600 hover:text-ooosh-700 font-medium">{file.label}</span>
                    <span className="text-gray-400 text-xs ml-1.5">({file.name})</span>
                  </>
                ) : (
                  <span className="text-ooosh-600 hover:text-ooosh-700">{file.name}</span>
                )}
              </button>
              <span className="text-xs text-gray-400 hidden sm:inline whitespace-nowrap">{formatDate(file.uploaded_at)}</span>
              {!readOnly && (
                <button
                  type="button"
                  onClick={() => handleDelete(file)}
                  className="text-gray-300 hover:text-red-500 opacity-0 group-hover:opacity-100 transition-opacity"
                  title="Delete file"
                >
                  <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                  </svg>
                </button>
              )}
            </div>
          ))}
        </div>
      )}

      {/* Pending file upload with label */}
      {pendingFiles.length > 0 && (
        <div className="mb-3 p-3 bg-ooosh-50 border border-ooosh-200 rounded space-y-2">
          <div className="text-sm text-gray-700">
            {pendingFiles.length === 1
              ? <span className="font-medium">{pendingFiles[0].name}</span>
              : <span className="font-medium">{pendingFiles.length} files selected</span>
            }
          </div>
          <div>
            <input
              type="text"
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              placeholder="Label (e.g. Tech spec, Stage plot, Receipt...)"
              className="w-full px-2.5 py-1.5 text-sm border border-gray-300 rounded focus:border-ooosh-400 focus:ring-1 focus:ring-ooosh-400 outline-none"
            />
            <div className="flex flex-wrap gap-1 mt-1.5">
              {LABEL_SUGGESTIONS.map((suggestion) => (
                <button
                  key={suggestion}
                  type="button"
                  onClick={() => setLabel(suggestion)}
                  className={`text-xs px-2 py-0.5 rounded border transition-colors ${
                    label === suggestion
                      ? 'bg-ooosh-100 border-ooosh-300 text-ooosh-700'
                      : 'bg-white border-gray-200 text-gray-500 hover:border-ooosh-300 hover:text-ooosh-600'
                  }`}
                >
                  {suggestion}
                </button>
              ))}
            </div>
          </div>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={handleUpload}
              disabled={uploading}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm bg-ooosh-600 text-white rounded hover:bg-ooosh-700 disabled:opacity-50 transition-colors"
            >
              {uploading ? (
                <>
                  <svg className="w-4 h-4 animate-spin" fill="none" viewBox="0 0 24 24">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                  </svg>
                  Uploading...
                </>
              ) : (
                <>
                  <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12" />
                  </svg>
                  Upload
                </>
              )}
            </button>
            <button
              type="button"
              onClick={handleCancelPending}
              className="px-3 py-1.5 text-sm text-gray-500 hover:text-gray-700 transition-colors"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* Select file button */}
      {!readOnly && pendingFiles.length === 0 && (
        <div>
          <input
            ref={fileInputRef}
            type="file"
            onChange={handleFileSelected}
            multiple
            className="hidden"
            accept=".pdf,.doc,.docx,.xls,.xlsx,.csv,.txt,.rtf,.jpg,.jpeg,.png,.gif,.webp,.svg,.zip,.rar"
          />
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            disabled={uploading}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm border border-dashed border-gray-300 rounded hover:border-ooosh-400 hover:text-ooosh-600 text-gray-500 transition-colors disabled:opacity-50"
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
            </svg>
            Upload file
          </button>
          <p className="text-xs text-gray-400 mt-1">PDF, images, documents up to 10MB</p>
        </div>
      )}
    </div>
  );
}
