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

export interface ReceiptLike {
  receipt_r2_key?: string | null;
  receipt_filename?: string | null;
  supplier_name?: string | null;
}

/**
 * Small receipt thumbnail. Image → thumbnail, PDF/other → 📎 icon.
 * Click opens the lightbox. Renders nothing when there's no receipt on file —
 * callers that want a "no receipt" affordance should render their own.
 */
export function ReceiptThumb({ cost, onOpen, size = 'md' }: {
  cost: ReceiptLike;
  onOpen: () => void;
  size?: 'sm' | 'md';
}) {
  const [url, setUrl] = useState<string | null>(null);
  const [isImage, setIsImage] = useState(false);
  const key = cost.receipt_r2_key;
  useEffect(() => {
    if (!key) return;
    let objUrl = ''; let cancelled = false;
    api.blob(`/files/download?key=${encodeURIComponent(key)}`)
      .then(({ blob, contentType }) => {
        if (cancelled) return;
        if (contentType.startsWith('image/')) {
          setIsImage(true);
          objUrl = URL.createObjectURL(blob);
          setUrl(objUrl);
        }
      })
      .catch(() => {});
    return () => { cancelled = true; if (objUrl) URL.revokeObjectURL(objUrl); };
  }, [key]);
  if (!key) return null;
  const box = size === 'sm' ? 'w-6 h-6' : 'w-8 h-8';
  return (
    <button onClick={onOpen} title="View receipt"
      className={`shrink-0 ${box} rounded border border-gray-200 overflow-hidden bg-gray-50 flex items-center justify-center hover:border-purple-400`}>
      {isImage && url ? <img src={url} alt="receipt" className="w-full h-full object-cover" /> : <span className="text-sm">📎</span>}
    </button>
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
