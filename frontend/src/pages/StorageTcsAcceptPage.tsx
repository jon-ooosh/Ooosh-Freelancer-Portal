import { useEffect, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';

interface TcsContext {
  roomName: string;
  organisationName: string | null;
  version: string | null;
  body: string | null;
  alreadyAccepted: boolean;
}

/**
 * Public storage T&Cs acceptance page — token-authenticated, no Layout wrapper.
 * Mounted at /storage-tcs/:token (see App.tsx). Mirrors the OOH parking page.
 */
export default function StorageTcsAcceptPage() {
  const { token } = useParams<{ token: string }>();
  const [ctx, setCtx] = useState<TcsContext | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [name, setName] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState('');
  const [done, setDone] = useState(false);

  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const drawing = useRef(false);
  const hasInk = useRef(false);

  useEffect(() => {
    (async () => {
      try {
        const res = await fetch(`/api/storage/tcs/by-token/${token}`);
        if (!res.ok) {
          const j = await res.json().catch(() => ({}));
          setLoadError(j.error || 'This link is no longer valid.');
        } else {
          const j = await res.json();
          setCtx(j.data);
        }
      } catch {
        setLoadError('Could not load the terms. Please try again.');
      } finally {
        setLoading(false);
      }
    })();
  }, [token]);

  function pos(e: React.PointerEvent<HTMLCanvasElement>) {
    const c = canvasRef.current!;
    const r = c.getBoundingClientRect();
    return { x: (e.clientX - r.left) * (c.width / r.width), y: (e.clientY - r.top) * (c.height / r.height) };
  }
  function start(e: React.PointerEvent<HTMLCanvasElement>) {
    drawing.current = true;
    const ctx2 = canvasRef.current!.getContext('2d')!;
    const p = pos(e);
    ctx2.beginPath();
    ctx2.moveTo(p.x, p.y);
  }
  function move(e: React.PointerEvent<HTMLCanvasElement>) {
    if (!drawing.current) return;
    const ctx2 = canvasRef.current!.getContext('2d')!;
    const p = pos(e);
    ctx2.lineWidth = 2;
    ctx2.lineCap = 'round';
    ctx2.strokeStyle = '#1e293b';
    ctx2.lineTo(p.x, p.y);
    ctx2.stroke();
    hasInk.current = true;
  }
  function end() { drawing.current = false; }
  function clearSig() {
    const c = canvasRef.current;
    if (c) c.getContext('2d')!.clearRect(0, 0, c.width, c.height);
    hasInk.current = false;
  }

  async function submit() {
    if (!name.trim()) { setSubmitError('Please enter your name.'); return; }
    setSubmitting(true);
    setSubmitError('');
    try {
      const signature = hasInk.current ? canvasRef.current!.toDataURL('image/png') : null;
      const res = await fetch(`/api/storage/tcs/by-token/${token}/accept`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ accepted_by_name: name.trim(), signature }),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        setSubmitError(j.error || 'Could not record your acceptance. Please try again.');
      } else {
        setDone(true);
      }
    } catch {
      setSubmitError('Could not record your acceptance. Please try again.');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="min-h-screen bg-slate-100 py-8 px-4">
      <div className="max-w-2xl mx-auto">
        <div className="bg-[#7B5EA7] text-white rounded-t-xl px-6 py-5">
          <h1 className="text-xl font-bold">Ooosh Tours — Storage Terms</h1>
          <p className="text-sm text-purple-100">Transport · Backline · Rehearsals</p>
        </div>
        <div className="bg-white rounded-b-xl shadow p-6">
          {loading && <p className="text-slate-500">Loading…</p>}
          {loadError && <p className="text-red-600">{loadError}</p>}

          {ctx && !done && (
            <>
              {ctx.alreadyAccepted ? (
                <div className="rounded-lg bg-green-50 border border-green-200 p-4 text-green-800">
                  These terms have already been accepted. No further action needed.
                </div>
              ) : (
                <>
                  <p className="text-sm text-slate-600 mb-1">
                    Storage unit: <strong>{ctx.roomName}</strong>
                    {ctx.organisationName ? ` · ${ctx.organisationName}` : ''}
                  </p>
                  {ctx.version && <p className="text-xs text-slate-400 mb-4">Version {ctx.version}</p>}
                  <div
                    className="prose prose-sm max-w-none border border-slate-200 rounded-lg p-4 max-h-80 overflow-y-auto mb-5 text-slate-700"
                    dangerouslySetInnerHTML={{ __html: ctx.body || '<p>(No terms text set.)</p>' }}
                  />
                  <label className="block text-sm font-medium text-slate-700 mb-1">Your full name</label>
                  <input
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    className="w-full border border-slate-300 rounded-lg px-3 py-2 mb-4"
                    placeholder="e.g. Jane Smith"
                  />
                  <label className="block text-sm font-medium text-slate-700 mb-1">Signature</label>
                  <canvas
                    ref={canvasRef}
                    width={560}
                    height={160}
                    className="w-full border border-slate-300 rounded-lg bg-white touch-none"
                    onPointerDown={start}
                    onPointerMove={move}
                    onPointerUp={end}
                    onPointerLeave={end}
                  />
                  <button onClick={clearSig} className="text-xs text-slate-500 underline mt-1 mb-4">Clear signature</button>

                  {submitError && <p className="text-red-600 text-sm mb-3">{submitError}</p>}
                  <button
                    onClick={submit}
                    disabled={submitting}
                    className="w-full bg-[#7B5EA7] text-white rounded-lg py-3 font-semibold disabled:opacity-50"
                  >
                    {submitting ? 'Submitting…' : 'I accept these terms'}
                  </button>
                </>
              )}
            </>
          )}

          {done && (
            <div className="rounded-lg bg-green-50 border border-green-200 p-5 text-center">
              <p className="text-2xl mb-2">✓</p>
              <p className="text-green-800 font-medium">Thank you — your acceptance has been recorded.</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
