// Shared receipt viewer for captured costs.
//
// Extracted from CostsPage so the Job Detail → Money tab "Job Costs" panel shows
// the same paperwork as the Costs hub. Deliberately typed against a minimal
// shape (not CostRow / JobCostLite) so any surface holding a cost can render it.
//
// Receipts live in the PRIVATE R2 bucket, so a plain <img src="/files/download">
// won't work — the browser doesn't attach the JWT to a direct navigation. Both
// components fetch the blob through the authenticated api.blob() helper and hand
// the browser an object URL instead.

import { useState, useEffect } from 'react';
import { api } from '../../services/api';
import { useAuthedFileUrl } from '../../hooks/useAuthedFileUrl';

export interface ReceiptLike {
  receipt_r2_key?: string | null;
  receipt_filename?: string | null;
  supplier_name?: string | null;
  /** Extra evidence filed with the same payable — surfaced as a "+N" pip. */
  supporting_documents?: { r2_key: string; filename: string }[] | null;
}

// Receipts are stored as `files/attachments/<uploader>/<uuid><ext>`, with the
// extension carried over from the original upload (see routes/files.ts), so the
// key alone tells us whether a thumbnail is even possible. That matters: a PDF
// can't be drawn in a 32px box, and downloading it to work that out is what made
// the Costs list pull ~100MB over ~90 requests before it settled.
const IMAGE_EXT = /\.(jpe?g|png|gif|webp|avif|bmp|heic|heif)$/i;
function looksLikeImage(cost: ReceiptLike): boolean {
  return IMAGE_EXT.test(cost.receipt_r2_key || '') || IMAGE_EXT.test(cost.receipt_filename || '');
}

/**
 * Small receipt thumbnail. Image → thumbnail, PDF/other → 📎 icon.
 * Click opens the lightbox. Renders nothing when there's no receipt on file —
 * callers that want a "no receipt" affordance should render their own.
 *
 * Only image receipts are fetched, and only once the row is actually on screen:
 * the Costs list renders up to 200 rows and every fetch here pulls the FULL
 * original (a 3MB phone photo) through the API. Until real thumbnails exist
 * (files.ts `thumbnail_key`, still a Phase B stub) that restraint is the only
 * thing keeping the page quick.
 */
export function ReceiptThumb({ cost, onOpen, size = 'md' }: {
  cost: ReceiptLike;
  onOpen: () => void;
  size?: 'sm' | 'md';
}) {
  const key = cost.receipt_r2_key;
  // `enabled` is the cheap half: a PDF receipt never makes a thumbnail, so it
  // is never fetched. The rest — waiting for the row to scroll into range,
  // aborting if it scrolls away again — is the hook's job.
  const { ref, url, contentType } = useAuthedFileUrl(key, { enabled: looksLikeImage(cost) });
  // Neither the extension nor the content type proves the BROWSER can draw it.
  // A .heic straight off an iPhone is a genuine image/heic and every browser
  // but Safari refuses it, which rendered an empty box where the 📎 belonged.
  // Same story for a truncated upload. Only the decode is the last word, so
  // mirror DocumentThumb and keep a local flag for it. (Same-shape state as
  // the hook's own `failed`, which only covers the fetch.)
  const [imgFailed, setImgFailed] = useState(false);
  // A new file in the same slot deserves a fresh attempt.
  useEffect(() => { setImgFailed(false); }, [url]);
  // The extension got us this far; the content type is what decides. A
  // mislabelled upload falls back to the 📎 rather than a broken <img>.
  const thumb = url && !imgFailed && contentType.startsWith('image/') ? url : null;

  if (!key) return null;
  const box = size === 'sm' ? 'w-6 h-6' : 'w-8 h-8';
  // Supporting docs are extra evidence on the same payable. A count pip is
  // enough here — the documents themselves are managed in the capture modal.
  const extra = cost.supporting_documents?.length ?? 0;
  return (
    <span ref={ref} className="relative inline-flex shrink-0">
      <button onClick={onOpen} title={extra ? `View receipt (+${extra} supporting)` : 'View receipt'}
        className={`shrink-0 ${box} rounded border border-gray-200 overflow-hidden bg-gray-50 flex items-center justify-center hover:border-purple-400`}>
        {thumb
          ? <img src={thumb} alt="receipt" className="w-full h-full object-cover" onError={() => setImgFailed(true)} />
          : <span className="text-sm">📎</span>}
      </button>
      {extra > 0 && (
        <span className="absolute -top-1 -right-1 px-1 min-w-[14px] text-[9px] leading-[14px] text-center font-semibold
                         text-white bg-purple-600 rounded-full pointer-events-none">
          +{extra}
        </span>
      )}
    </span>
  );
}

/** Lightbox — image inline, PDF in an iframe. Backdrop / ✕ / Escape to close. */
export function ReceiptPreview({ cost, onClose }: { cost: ReceiptLike; onClose: () => void }) {
  const [url, setUrl] = useState<string | null>(null);
  const [type, setType] = useState('');
  const [err, setErr] = useState('');
  const key = cost.receipt_r2_key;
  useEffect(() => {
    if (!key) { setErr('No receipt on file'); return; }
    let objUrl = ''; let cancelled = false;
    api.blob(`/files/download?key=${encodeURIComponent(key)}`)
      .then(({ blob, contentType }) => {
        if (cancelled) return;
        setType(contentType);
        objUrl = URL.createObjectURL(blob);
        setUrl(objUrl);
      })
      .catch(() => { if (!cancelled) setErr('Failed to load receipt'); });
    return () => { cancelled = true; if (objUrl) URL.revokeObjectURL(objUrl); };
  }, [key]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="fixed inset-0 z-50 bg-black/70 flex items-center justify-center p-4" onClick={onClose}>
      <div className="bg-white rounded-lg shadow-xl max-w-3xl w-full max-h-[90vh] overflow-hidden flex flex-col" onClick={(e) => e.stopPropagation()}>
        <div className="px-4 py-2.5 border-b border-gray-200 flex items-center justify-between">
          <span className="text-sm font-medium text-gray-700 truncate">{cost.receipt_filename || cost.supplier_name || 'Receipt'}</span>
          <div className="flex items-center gap-3">
            {url && <a href={url} target="_blank" rel="noreferrer" className="text-xs text-purple-600 hover:underline">Open full</a>}
            <button onClick={onClose} className="text-gray-400 hover:text-gray-700">✕</button>
          </div>
        </div>
        <div className="flex-1 overflow-auto bg-gray-100 flex items-center justify-center min-h-[300px]">
          {err ? <p className="text-sm text-gray-500 p-6">{err}</p>
            : !url ? <p className="text-sm text-gray-400 p-6">Loading…</p>
            : type.includes('pdf') ? <iframe src={url} title="receipt" className="w-full h-[75vh]" />
            : <img src={url} alt="receipt" className="max-w-full max-h-[80vh] object-contain" />}
        </div>
      </div>
    </div>
  );
}
