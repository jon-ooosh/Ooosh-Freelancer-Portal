import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../services/api';
import MarkdownLite from '../components/MarkdownLite';
import { SignatureCapture, SignatureCaptureHandle } from '../modules/vehicles/components/book-out/SignatureCapture';

type Mode = 'read_only' | 'tick' | 'sign';

interface Assignment {
  id: string;
  status: string;
  assigned_at: string;
  expires_at: string | null;
  document_id: string;
  slug: string;
  title: string;
  category: string;
  completion_mode: Mode;
  tick_label: string | null;
  version: number | null;
  pdf_r2_key: string | null;
  completed_at: string | null;
}
interface LibraryDoc { id: string; slug: string; title: string; category: string; version: number | null; }
interface MineData { todo: Assignment[]; completed: Assignment[]; library: LibraryDoc[] }

interface ViewData {
  id: string; title: string; category: string; completion_mode: Mode; tick_label: string | null;
  version: number | null; file_r2_key: string | null; file_name: string | null; body: string;
  assignment: { id: string; status: string } | null;
}

const CATEGORY_LABEL: Record<string, string> = {
  policy: 'Policy', agreement: 'Agreement', training: 'Training',
  official_doc: 'Official doc', contract: 'Contract', other: 'Document',
};

function fmt(d: string | null): string {
  return d ? new Date(d).toLocaleDateString('en-GB') : '—';
}

async function openR2File(key: string) {
  const { blob } = await api.blob(`/files/download?key=${encodeURIComponent(key)}`);
  window.open(URL.createObjectURL(blob), '_blank');
}

export default function StaffDocumentsPage() {
  const [data, setData] = useState<MineData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [viewerId, setViewerId] = useState<string | null>(null);
  const [viewerAssignment, setViewerAssignment] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setLoading(true);
      const res = await api.get<{ data: MineData }>('/staff-documents/mine');
      setData(res.data);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const openViewer = (documentId: string, assignmentId: string | null) => {
    setViewerId(documentId);
    setViewerAssignment(assignmentId);
  };
  const closeViewer = () => { setViewerId(null); setViewerAssignment(null); };
  const onCompleted = () => {
    closeViewer();
    setToast('Done — thank you.');
    setTimeout(() => setToast(null), 4000);
    load();
  };

  if (loading) return <div className="p-6 text-gray-500">Loading…</div>;

  return (
    <div className="max-w-4xl mx-auto p-4 sm:p-6">
      <h1 className="text-2xl font-bold text-gray-900 mb-1">My Documents</h1>
      <p className="text-gray-500 mb-6">Policies, agreements and guides for you to read and sign.</p>

      {error && <div className="mb-4 p-3 rounded bg-red-50 text-red-700 text-sm">{error}</div>}
      {toast && <div className="mb-4 p-3 rounded bg-green-50 text-green-700 text-sm">{toast}</div>}

      {/* To do */}
      {data && data.todo.length > 0 && (
        <section className="mb-8">
          <h2 className="text-sm font-semibold text-amber-700 uppercase tracking-wide mb-2">
            To do ({data.todo.length})
          </h2>
          <div className="space-y-2">
            {data.todo.map((a) => (
              <div key={a.id} className="flex items-center justify-between gap-3 bg-white border border-amber-200 rounded-lg p-4 shadow-sm">
                <div className="min-w-0">
                  <div className="font-medium text-gray-900 truncate">{a.title}</div>
                  <div className="text-xs text-gray-500 mt-0.5 flex flex-wrap gap-x-2 gap-y-0.5">
                    <span>{CATEGORY_LABEL[a.category] || 'Document'}</span>
                    {a.status === 'lapsed' && <span className="text-amber-700 font-medium">· Renewal due</span>}
                    {a.completion_mode === 'sign' && <span>· Signature required</span>}
                    {a.completion_mode === 'tick' && <span>· Acknowledgement required</span>}
                  </div>
                </div>
                <button
                  onClick={() => openViewer(a.document_id, a.id)}
                  className="shrink-0 px-4 py-2 rounded-md bg-purple-700 text-white text-sm font-medium hover:bg-purple-800"
                >
                  {a.completion_mode === 'sign' ? 'Review & sign' : 'Review & confirm'}
                </button>
              </div>
            ))}
          </div>
        </section>
      )}

      {data && data.todo.length === 0 && (
        <div className="mb-8 p-4 rounded-lg bg-green-50 text-green-700 text-sm">
          Nothing to sign right now — you're all up to date. ✓
        </div>
      )}

      {/* Completed */}
      {data && data.completed.length > 0 && (
        <section className="mb-8">
          <h2 className="text-sm font-semibold text-gray-500 uppercase tracking-wide mb-2">Completed</h2>
          <div className="space-y-2">
            {data.completed.map((a) => (
              <div key={a.id} className="flex items-center justify-between gap-3 bg-white border border-gray-200 rounded-lg p-4">
                <div className="min-w-0">
                  <div className="font-medium text-gray-900 truncate">{a.title}</div>
                  <div className="text-xs text-gray-500 mt-0.5">
                    Completed {fmt(a.completed_at)}
                    {a.expires_at && <> · renews {fmt(a.expires_at)}</>}
                  </div>
                </div>
                <div className="shrink-0 flex items-center gap-2">
                  {a.pdf_r2_key && (
                    <button onClick={() => openR2File(a.pdf_r2_key!)}
                      className="px-3 py-1.5 rounded-md border border-gray-300 text-sm text-gray-700 hover:bg-gray-50">
                      Signed copy
                    </button>
                  )}
                  <button onClick={() => openViewer(a.document_id, null)}
                    className="px-3 py-1.5 rounded-md text-sm text-purple-700 hover:bg-purple-50">
                    View
                  </button>
                </div>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* Reference library */}
      {data && data.library.length > 0 && (
        <section>
          <h2 className="text-sm font-semibold text-gray-500 uppercase tracking-wide mb-2">Reference library</h2>
          <div className="space-y-2">
            {data.library.map((d) => (
              <button key={d.id} onClick={() => openViewer(d.id, null)}
                className="w-full text-left flex items-center justify-between gap-3 bg-white border border-gray-200 rounded-lg p-4 hover:bg-gray-50">
                <span className="font-medium text-gray-900 truncate">{d.title}</span>
                <span className="text-xs text-gray-400">{CATEGORY_LABEL[d.category] || 'Document'}</span>
              </button>
            ))}
          </div>
        </section>
      )}

      {viewerId && (
        <DocumentViewer
          documentId={viewerId}
          assignmentId={viewerAssignment}
          onClose={closeViewer}
          onCompleted={onCompleted}
        />
      )}
    </div>
  );
}

function DocumentViewer({ documentId, assignmentId, onClose, onCompleted }: {
  documentId: string;
  assignmentId: string | null;
  onClose: () => void;
  onCompleted: () => void;
}) {
  const [doc, setDoc] = useState<ViewData | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [agreed, setAgreed] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const sigRef = useRef<SignatureCaptureHandle>(null);

  useEffect(() => {
    (async () => {
      try {
        setLoading(true);
        const res = await api.get<{ data: ViewData }>(`/staff-documents/${documentId}/view`);
        setDoc(res.data);
      } catch (e) {
        setErr(e instanceof Error ? e.message : 'Failed to load document');
      } finally {
        setLoading(false);
      }
    })();
  }, [documentId]);

  // Can only complete when opened from a to-do (assignmentId present) and the
  // document actually requires it.
  const canComplete = !!assignmentId && !!doc && doc.completion_mode !== 'read_only';

  const submit = async () => {
    if (!doc || !assignmentId) return;
    try {
      setSubmitting(true);
      setErr(null);
      let signature: string | undefined;
      if (doc.completion_mode === 'sign') {
        const blob = await sigRef.current?.getBlob();
        if (!blob) { setErr('Please add your signature before continuing.'); setSubmitting(false); return; }
        signature = await new Promise<string>((resolve) => {
          const fr = new FileReader();
          fr.onload = () => resolve(fr.result as string);
          fr.readAsDataURL(blob);
        });
      }
      await api.post(`/staff-documents/assignments/${assignmentId}/complete`, { agreed: true, signature });
      onCompleted();
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Could not save.');
      setSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4" onClick={onClose}>
      <div className="bg-white rounded-lg shadow-xl max-w-2xl w-full max-h-[90vh] flex flex-col" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between px-5 py-3 border-b">
          <h3 className="font-semibold text-gray-900 truncate">{doc?.title || 'Document'}</h3>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-700 text-xl leading-none">×</button>
        </div>

        <div className="p-5 overflow-y-auto">
          {loading && <div className="text-gray-500">Loading…</div>}
          {err && <div className="mb-3 p-3 rounded bg-red-50 text-red-700 text-sm">{err}</div>}

          {doc && !loading && (
            <>
              {doc.file_r2_key && (
                <button onClick={() => openR2File(doc.file_r2_key!)}
                  className="mb-4 px-4 py-2 rounded-md border border-gray-300 text-sm text-gray-700 hover:bg-gray-50">
                  📄 Open {doc.file_name || 'document'}
                </button>
              )}
              {doc.body && <MarkdownLite text={doc.body} />}

              {canComplete && (
                <div className="mt-6 pt-5 border-t">
                  {doc.completion_mode === 'sign' && (
                    <div className="mb-4">
                      <SignatureCapture ref={sigRef} label="Your signature" />
                    </div>
                  )}
                  <label className="flex items-start gap-2 text-sm text-gray-700 mb-4">
                    <input type="checkbox" className="mt-0.5" checked={agreed} onChange={(e) => setAgreed(e.target.checked)} />
                    <span>{doc.tick_label || 'I confirm I have read and agree to the above.'}</span>
                  </label>
                  <button
                    onClick={submit}
                    disabled={!agreed || submitting}
                    className="px-5 py-2 rounded-md bg-purple-700 text-white text-sm font-medium hover:bg-purple-800 disabled:opacity-50"
                  >
                    {submitting ? 'Saving…' : doc.completion_mode === 'sign' ? 'Sign & submit' : 'Confirm'}
                  </button>
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
