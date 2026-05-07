/**
 * Shared attachment primitives for messaging surfaces (ActivityTimeline +
 * ThreadView, and any future composer that wants to attach files to
 * interactions).
 *
 * Types
 * - InteractionAttachment: shape stored in interactions.files JSONB. Tolerant
 *   of legacy `url`/`name` keys from pre-messaging files-tab uploads.
 * - PendingAttachment: client-side state while a file is uploading via
 *   POST /api/files/upload?attachment_only=true. Holds a local id for the
 *   strip UI plus an optional object-URL preview for images.
 *
 * Components
 * - AttachmentImage: authenticated thumbnail for image attachments. Fetches
 *   the bytes via api.blob and renders an object URL (revoked on unmount).
 *   Wraps in an <a> so clicking opens the full file in a new tab via the
 *   existing /api/files/download route.
 * - AttachmentPill: clickable pill for non-image attachments. Same /download
 *   route, opens in a new tab.
 * - AttachmentList: dispatches between the two based on content-type /
 *   filename extension. Returns null if empty.
 * - PendingAttachmentStrip: row of preview chips for in-flight + uploaded
 *   pending attachments, with × to remove.
 *
 * Hook
 * - useAttachments(): one composer's worth of pending-upload state, plus
 *   addFiles / addFromClipboard / remove / clear / payloadFromState helpers.
 *   Each composer instance calls the hook independently.
 */

import { useState, useEffect } from 'react';
import { api } from '../../services/api';

export interface InteractionAttachment {
  r2_key?: string;
  // Files-tab uploads use `url` (legacy), interaction attachments use `r2_key`.
  url?: string;
  filename?: string;
  // Files-tab uploads use `name` (legacy).
  name?: string;
  content_type?: string;
  size_bytes?: number;
  thumbnail_key?: string | null;
  uploaded_at?: string;
}

export interface PendingAttachment {
  localId: string;
  filename: string;
  size_bytes: number;
  content_type: string;
  status: 'uploading' | 'uploaded' | 'failed';
  r2_key?: string;
  thumbnail_key?: string | null;
  preview_url?: string;
  error?: string;
}

export function isImageAttachment(att: InteractionAttachment): boolean {
  if (att.content_type?.startsWith('image/')) return true;
  const name = att.filename || att.name || '';
  return /\.(jpg|jpeg|png|gif|webp|svg)$/i.test(name);
}

export function attachmentKey(att: InteractionAttachment): string | null {
  return att.r2_key || att.url || null;
}

/**
 * Filter an array of pending attachments down to the metadata blob shape
 * accepted by POST /api/interactions. Drops uploads that are still in
 * flight or failed.
 */
export function attachmentsForPayload(items: PendingAttachment[]) {
  return items
    .filter((a) => a.status === 'uploaded' && a.r2_key)
    .map((a) => ({
      r2_key: a.r2_key!,
      filename: a.filename,
      content_type: a.content_type,
      size_bytes: a.size_bytes,
      thumbnail_key: a.thumbnail_key ?? null,
    }));
}

export function AttachmentImage({ att }: { att: InteractionAttachment }) {
  const [src, setSrc] = useState<string | null>(null);
  const [error, setError] = useState(false);
  const [lightbox, setLightbox] = useState(false);

  useEffect(() => {
    let revoked: string | null = null;
    let cancelled = false;
    const key = attachmentKey(att);
    if (!key) { setError(true); return; }

    api.blob(`/files/download?key=${encodeURIComponent(key)}`)
      .then(({ blob }) => {
        if (cancelled) return;
        const url = URL.createObjectURL(blob);
        revoked = url;
        setSrc(url);
      })
      .catch(() => { if (!cancelled) setError(true); });

    return () => {
      cancelled = true;
      if (revoked) URL.revokeObjectURL(revoked);
    };
  }, [att]);

  // Escape closes the lightbox.
  useEffect(() => {
    if (!lightbox) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setLightbox(false);
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [lightbox]);

  if (error) {
    return (
      <div className="border border-gray-200 rounded p-2 text-xs text-gray-400 bg-gray-50">
        {att.filename || att.name || 'Image'} (failed to load)
      </div>
    );
  }
  if (!src) {
    return (
      <div className="border border-gray-200 rounded p-2 text-xs text-gray-400 bg-gray-50 animate-pulse">
        Loading…
      </div>
    );
  }
  // Click → in-page lightbox using the SAME blob URL we already have.
  // The previous link-out went to /api/files/download which requires JWT
  // headers and 401s when opened directly in a new tab.
  return (
    <>
      <button
        type="button"
        onClick={() => setLightbox(true)}
        className="inline-block p-0 border-0 bg-transparent cursor-zoom-in"
        title={att.filename || att.name || 'attachment'}
      >
        <img
          src={src}
          alt={att.filename || att.name || 'attachment'}
          className="max-w-[240px] max-h-[180px] rounded border border-gray-200 object-cover hover:opacity-90 transition-opacity"
        />
      </button>

      {lightbox && (
        <div
          className="fixed inset-0 bg-black/80 flex items-center justify-center z-50 cursor-zoom-out"
          onClick={() => setLightbox(false)}
        >
          <div className="relative max-w-[95vw] max-h-[95vh] flex flex-col" onClick={(e) => e.stopPropagation()}>
            <img
              src={src}
              alt={att.filename || att.name || 'attachment'}
              className="max-w-[95vw] max-h-[88vh] rounded shadow-2xl object-contain bg-white"
            />
            <div className="flex items-center justify-between mt-2 px-2">
              <span className="text-white text-xs truncate">{att.filename || att.name || 'attachment'}</span>
              <div className="flex items-center gap-2">
                <a
                  href={src}
                  download={att.filename || att.name || 'attachment'}
                  className="text-white text-xs px-2 py-1 rounded bg-white/10 hover:bg-white/20 transition-colors"
                >
                  Download
                </a>
                <button
                  type="button"
                  onClick={() => setLightbox(false)}
                  className="text-white text-xs px-2 py-1 rounded bg-white/10 hover:bg-white/20 transition-colors"
                  title="Close (Esc)"
                >
                  Close
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

export function AttachmentPill({ att }: { att: InteractionAttachment }) {
  const name = att.filename || att.name || 'file';
  const key = attachmentKey(att);
  const sizeLabel = typeof att.size_bytes === 'number'
    ? ` · ${(att.size_bytes / 1024).toFixed(0)} KB`
    : '';
  const [downloading, setDownloading] = useState(false);

  // Click → authenticated blob fetch → trigger download / preview in a new
  // tab. We can't link directly to /api/files/download because the
  // download endpoint requires the JWT in the Authorization header, which
  // browsers don't attach to ordinary <a target=_blank> navigations.
  // Same pattern as FileUpload / DriverDetailPage.
  async function handleClick(e: React.MouseEvent) {
    e.preventDefault();
    if (!key || downloading) return;
    setDownloading(true);
    try {
      const { blob, contentType } = await api.blob(`/files/download?key=${encodeURIComponent(key)}`);
      const url = URL.createObjectURL(blob);
      // PDFs + plain text we open in a new tab (preview); everything else
      // we trigger as a download with the proper filename.
      const previewTypes = ['application/pdf', 'text/plain'];
      if (previewTypes.includes(contentType)) {
        window.open(url, '_blank', 'noopener,noreferrer');
      } else {
        const a = document.createElement('a');
        a.href = url;
        a.download = name;
        document.body.appendChild(a);
        a.click();
        a.remove();
      }
      // Revoke after a short delay so the new tab / download has time to
      // grab the bytes.
      setTimeout(() => URL.revokeObjectURL(url), 30_000);
    } catch (err) {
      console.error('Attachment download failed:', err);
    } finally {
      setDownloading(false);
    }
  }

  return (
    <button
      type="button"
      onClick={handleClick}
      disabled={!key || downloading}
      className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md border border-gray-200 bg-white text-xs text-gray-700 hover:bg-gray-50 hover:border-gray-300 transition-colors disabled:opacity-50"
    >
      <span className="text-gray-400">📎</span>
      <span className="font-medium">{name}</span>
      <span className="text-gray-400">{sizeLabel}</span>
      {downloading && <span className="text-[10px] text-gray-400">…</span>}
    </button>
  );
}

export function AttachmentList({ files }: { files?: InteractionAttachment[] }) {
  if (!files || files.length === 0) return null;
  const images = files.filter(isImageAttachment);
  const others = files.filter((f) => !isImageAttachment(f));
  return (
    <div className="mt-2 space-y-2">
      {images.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {images.map((att, i) => (
            <AttachmentImage key={`img-${i}`} att={att} />
          ))}
        </div>
      )}
      {others.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {others.map((att, i) => (
            <AttachmentPill key={`pill-${i}`} att={att} />
          ))}
        </div>
      )}
    </div>
  );
}

export function PendingAttachmentStrip({
  items, onRemove,
}: {
  items: PendingAttachment[];
  onRemove: (localId: string) => void;
}) {
  if (items.length === 0) return null;
  return (
    <div className="flex flex-wrap gap-2 mt-2">
      {items.map((p) => (
        <div
          key={p.localId}
          className={`relative inline-flex items-center gap-1.5 px-2 py-1 rounded-md border text-xs ${
            p.status === 'failed'
              ? 'bg-red-50 border-red-200 text-red-700'
              : p.status === 'uploaded'
              ? 'bg-gray-50 border-gray-200 text-gray-700'
              : 'bg-amber-50 border-amber-200 text-amber-700 animate-pulse'
          }`}
        >
          {p.preview_url
            ? <img src={p.preview_url} alt={p.filename} className="w-6 h-6 object-cover rounded" />
            : <span className="text-gray-400">📎</span>}
          <span className="font-medium max-w-[150px] truncate">{p.filename}</span>
          {p.status === 'uploading' && <span className="text-[10px]">uploading…</span>}
          {p.status === 'failed' && <span className="text-[10px]">failed</span>}
          <button
            type="button"
            onClick={() => onRemove(p.localId)}
            className="hover:text-red-600 ml-0.5"
            aria-label={`Remove ${p.filename}`}
          >
            ×
          </button>
        </div>
      ))}
    </div>
  );
}

/**
 * One composer's worth of pending-attachment state.
 *
 * Each composer instance (top-level, reply, ThreadView reply) calls this
 * hook independently; they don't share state. The hook handles parallel
 * upload with optimistic placeholder rows + preview-URL lifecycle.
 */
export function useAttachments() {
  const [pending, setPending] = useState<PendingAttachment[]>([]);

  async function uploadOne(file: File): Promise<{
    success: boolean;
    r2_key?: string;
    thumbnail_key?: string | null;
    error?: string;
  }> {
    try {
      const fd = new FormData();
      fd.append('file', file);
      fd.append('attachment_only', 'true');
      const result = await api.upload<{ r2_key: string; thumbnail_key?: string | null }>('/files/upload', fd);
      return { success: true, r2_key: result.r2_key, thumbnail_key: result.thumbnail_key ?? null };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : 'Upload failed' };
    }
  }

  async function addFiles(files: FileList | File[]) {
    const list = Array.from(files);
    if (list.length === 0) return;

    const placeholders: PendingAttachment[] = list.map((f) => ({
      localId: `att-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      filename: f.name,
      size_bytes: f.size,
      content_type: f.type || 'application/octet-stream',
      status: 'uploading' as const,
      preview_url: f.type.startsWith('image/') ? URL.createObjectURL(f) : undefined,
    }));
    setPending((prev) => [...prev, ...placeholders]);

    await Promise.all(list.map(async (f, i) => {
      const result = await uploadOne(f);
      setPending((prev) => prev.map((p) => p.localId === placeholders[i].localId
        ? {
            ...p,
            status: result.success ? 'uploaded' as const : 'failed' as const,
            r2_key: result.r2_key,
            thumbnail_key: result.thumbnail_key ?? null,
            error: result.error,
          }
        : p
      ));
    }));
  }

  /**
   * Pull image data out of a paste event and queue it as an upload.
   * Caller MUST also call e.preventDefault() in the same handler — we
   * leave that to them so plain-text pastes flow through normally.
   */
  function pasteFromEvent(e: React.ClipboardEvent): boolean {
    const items = e.clipboardData?.items;
    if (!items || items.length === 0) return false;
    const files: File[] = [];
    for (const item of items) {
      if (item.kind === 'file' && item.type.startsWith('image/')) {
        const f = item.getAsFile();
        if (f) files.push(f);
      }
    }
    if (files.length === 0) return false;
    addFiles(files);
    return true;
  }

  function remove(localId: string) {
    setPending((prev) => {
      const found = prev.find((p) => p.localId === localId);
      if (found?.preview_url) URL.revokeObjectURL(found.preview_url);
      return prev.filter((p) => p.localId !== localId);
    });
  }

  function clear() {
    setPending((prev) => {
      for (const p of prev) {
        if (p.preview_url) URL.revokeObjectURL(p.preview_url);
      }
      return [];
    });
  }

  return {
    pending,
    addFiles,
    pasteFromEvent,
    remove,
    clear,
    payload: () => attachmentsForPayload(pending),
    hasInFlight: pending.some((p) => p.status === 'uploading'),
  };
}
