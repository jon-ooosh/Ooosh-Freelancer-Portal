/**
 * MobileReceiptUploadPage — public, token-authenticated receipt capture.
 *
 * Reached by scanning a QR shown on the laptop (the "Scan with phone" flow in
 * ExcessPaymentModal). No login — the token in the URL is the auth. Opens the
 * phone camera, uploads the photo, which the backend attaches to the excess
 * record. Mounted OUTSIDE the app Layout (no nav shell).
 */
import { useState, useEffect, useRef } from 'react';
import { useParams } from 'react-router-dom';

interface Ctx {
  purpose: string;
  title: string;
  subtitle: string | null;
  consumed: boolean;
  expired: boolean;
}

export default function MobileReceiptUploadPage() {
  const { token } = useParams<{ token: string }>();
  const [ctx, setCtx] = useState<Ctx | null>(null);
  const [loadError, setLoadError] = useState('');
  const [loading, setLoading] = useState(true);
  const [file, setFile] = useState<File | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState('');
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/mobile-upload/${token}`)
      .then(async (r) => {
        const body = await r.json();
        if (cancelled) return;
        if (!r.ok) { setLoadError(body.error || 'Link not found'); return; }
        setCtx(body.data);
      })
      .catch(() => { if (!cancelled) setLoadError('Could not load — check your connection.'); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [token]);

  // Revoke object URL on change/unmount to avoid leaks.
  useEffect(() => {
    return () => { if (previewUrl) URL.revokeObjectURL(previewUrl); };
  }, [previewUrl]);

  function onPick(f: File | null) {
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    setFile(f);
    setPreviewUrl(f && f.type.startsWith('image/') ? URL.createObjectURL(f) : null);
    setError('');
  }

  async function handleUpload() {
    if (!file) return;
    setUploading(true);
    setError('');
    try {
      const fd = new FormData();
      fd.append('file', file);
      const r = await fetch(`/api/mobile-upload/${token}`, { method: 'POST', body: fd });
      const body = await r.json();
      if (!r.ok) throw new Error(body.error || 'Upload failed');
      setDone(true);
    } catch (err: any) {
      setError(err.message || 'Upload failed');
    } finally {
      setUploading(false);
    }
  }

  const wrap = 'min-h-screen bg-gray-50 flex items-center justify-center p-4';
  const card = 'w-full max-w-sm bg-white rounded-2xl shadow-sm border border-gray-200 p-6 text-center';

  if (loading) {
    return <div className={wrap}><div className={card}><p className="text-gray-500">Loading…</p></div></div>;
  }
  if (loadError || !ctx) {
    return <div className={wrap}><div className={card}>
      <p className="text-lg font-semibold text-gray-900 mb-1">Link not available</p>
      <p className="text-sm text-gray-500">{loadError || 'This upload link is no longer valid.'}</p>
    </div></div>;
  }
  if (done || ctx.consumed) {
    return <div className={wrap}><div className={card}>
      <div className="text-4xl mb-2">✅</div>
      <p className="text-lg font-semibold text-gray-900 mb-1">Receipt uploaded</p>
      <p className="text-sm text-gray-500">You can close this page and carry on at the laptop.</p>
    </div></div>;
  }
  if (ctx.expired) {
    return <div className={wrap}><div className={card}>
      <p className="text-lg font-semibold text-gray-900 mb-1">Link expired</p>
      <p className="text-sm text-gray-500">Generate a fresh QR code on the laptop and scan it again.</p>
    </div></div>;
  }

  return (
    <div className={wrap}>
      <div className={card}>
        <p className="text-lg font-semibold text-gray-900">{ctx.title}</p>
        {ctx.subtitle && <p className="text-sm text-gray-500 mt-0.5 mb-4">{ctx.subtitle}</p>}

        {previewUrl && (
          <img src={previewUrl} alt="Receipt preview" className="w-full rounded-lg border border-gray-200 mb-4 max-h-72 object-contain" />
        )}

        <input
          ref={fileInputRef}
          type="file"
          accept="image/*,application/pdf"
          capture="environment"
          onChange={(e) => onPick(e.target.files?.[0] || null)}
          className="hidden"
        />
        <button
          type="button"
          onClick={() => fileInputRef.current?.click()}
          className="w-full py-3 rounded-xl border border-ooosh-300 text-ooosh-700 font-medium mb-3"
        >
          {file ? '📷 Retake / choose another' : '📷 Take photo of receipt'}
        </button>

        {error && <p className="text-sm text-red-600 mb-3">{error}</p>}

        <button
          type="button"
          onClick={handleUpload}
          disabled={!file || uploading}
          className="w-full py-3 rounded-xl bg-ooosh-600 text-white font-semibold disabled:opacity-50"
        >
          {uploading ? 'Uploading…' : 'Upload receipt'}
        </button>
      </div>
    </div>
  );
}
