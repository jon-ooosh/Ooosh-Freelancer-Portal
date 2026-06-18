/**
 * PcnReceiptUploadPage — public, token-authenticated proof-of-payment upload.
 *
 * The driver gets the link in the "pay this charge directly" email (and chase
 * re-sends). No login — the token in the URL is the auth. They snap/upload the
 * receipt; the backend attaches it to the PCN, flips it to "Paid by Driver",
 * and alerts info@. Mounted OUTSIDE the app Layout (no nav shell). Models the
 * MobileReceiptUploadPage public pattern (plain fetch, no api client).
 */
import { useState, useEffect, useRef } from 'react';
import { useParams } from 'react-router-dom';

interface Ctx {
  reference: string | null;
  vehicle_reg: string | null;
  issuing_authority: string | null;
  fine_amount: number | null;
  reduced_amount: number | null;
  reduced_deadline: string | null;
  driver_name: string | null;
  already_uploaded: boolean;
  closed: boolean;
}

const money = (n: number | null) => (n == null ? null : `£${Number(n).toFixed(2)}`);
const fmtDate = (d: string | null) => (d ? new Date(d).toLocaleDateString('en-GB') : '');

export default function PcnReceiptUploadPage() {
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
    fetch(`/api/pcns/public/receipt/${token}`)
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

  useEffect(() => () => { if (previewUrl) URL.revokeObjectURL(previewUrl); }, [previewUrl]);

  function onPick(f: File | null) {
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    setFile(f);
    setPreviewUrl(f && f.type.startsWith('image/') ? URL.createObjectURL(f) : null);
    setError('');
  }

  async function handleUpload() {
    if (!file) return;
    setUploading(true); setError('');
    try {
      const fd = new FormData();
      fd.append('file', file);
      const r = await fetch(`/api/pcns/public/receipt/${token}`, { method: 'POST', body: fd });
      const body = await r.json();
      if (!r.ok) throw new Error(body.error || 'Upload failed');
      setDone(true);
    } catch (err) {
      setError((err as Error).message || 'Upload failed');
    } finally {
      setUploading(false);
    }
  }

  const wrap = 'min-h-screen bg-slate-100 flex items-center justify-center p-4';
  const card = 'w-full max-w-sm bg-white rounded-2xl shadow-sm border border-slate-200 p-6';

  if (loading) {
    return <div className={wrap}><div className={`${card} text-center`}><p className="text-slate-500">Loading…</p></div></div>;
  }
  if (loadError || !ctx) {
    return <div className={wrap}><div className={`${card} text-center`}>
      <p className="text-lg font-semibold text-slate-900 mb-1">Link not available</p>
      <p className="text-sm text-slate-500">{loadError || 'This link is no longer valid. Please contact Ooosh Tours.'}</p>
    </div></div>;
  }
  if (done || ctx.already_uploaded) {
    return <div className={wrap}><div className={`${card} text-center`}>
      <div className="text-4xl mb-2">✅</div>
      <p className="text-lg font-semibold text-slate-900 mb-1">Receipt received — thank you</p>
      <p className="text-sm text-slate-500">We've logged your proof of payment. No further action needed. You can close this page.</p>
    </div></div>;
  }
  if (ctx.closed) {
    return <div className={wrap}><div className={`${card} text-center`}>
      <p className="text-lg font-semibold text-slate-900 mb-1">This charge has moved on</p>
      <p className="text-sm text-slate-500">It's no longer awaiting your payment. If you think that's wrong, please contact Ooosh Tours.</p>
    </div></div>;
  }

  const fineLine = money(ctx.fine_amount)
    ? `${money(ctx.fine_amount)}${money(ctx.reduced_amount) ? ` (${money(ctx.reduced_amount)} if paid by ${fmtDate(ctx.reduced_deadline)})` : ''}`
    : '—';

  return (
    <div className={wrap}>
      <div className={card}>
        <h1 className="text-lg font-bold text-slate-800 mb-1">Upload proof of payment</h1>
        <p className="text-sm text-slate-500 mb-4">
          {ctx.driver_name ? `${ctx.driver_name}, once` : 'Once'} you've paid this charge, upload your receipt here so we can keep it off your account.
        </p>

        <div className="bg-slate-50 rounded-lg p-3 mb-4 text-sm">
          <div className="flex justify-between py-0.5"><span className="text-slate-500">Reference</span><span className="font-medium">{ctx.reference || '—'}</span></div>
          <div className="flex justify-between py-0.5"><span className="text-slate-500">Vehicle</span><span>{ctx.vehicle_reg || '—'}</span></div>
          <div className="flex justify-between py-0.5"><span className="text-slate-500">Authority</span><span>{ctx.issuing_authority || '—'}</span></div>
          <div className="flex justify-between py-0.5"><span className="text-slate-500">Fine</span><span>{fineLine}</span></div>
        </div>

        {previewUrl && (
          <img src={previewUrl} alt="Receipt preview" className="w-full rounded-lg border border-slate-200 mb-4 max-h-72 object-contain" />
        )}

        <input ref={fileInputRef} type="file" accept="image/*,application/pdf" capture="environment"
          onChange={(e) => onPick(e.target.files?.[0] || null)} className="hidden" />
        <button type="button" onClick={() => fileInputRef.current?.click()}
          className="w-full py-3 rounded-xl border border-[#7B5EA7] text-[#7B5EA7] font-medium mb-3">
          {file ? '📷 Retake / choose another' : '📷 Take photo of receipt'}
        </button>

        {error && <p className="text-sm text-red-600 mb-3">{error}</p>}

        <button type="button" onClick={handleUpload} disabled={!file || uploading}
          className="w-full py-3 rounded-xl bg-[#7B5EA7] text-white font-semibold disabled:opacity-50">
          {uploading ? 'Uploading…' : 'Upload receipt'}
        </button>
        <p className="text-xs text-slate-400 text-center mt-3">A photo or PDF of the payment confirmation is fine.</p>
      </div>
    </div>
  );
}
