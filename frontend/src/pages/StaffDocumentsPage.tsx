import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react';
import { api } from '../services/api';
import MarkdownLite from '../components/MarkdownLite';
import { useAuthStore } from '../hooks/useAuthStore';
import { hasManagerRole } from '../lib/roles';
import { DocFormModal, VersionModal, ViewModal, DocRow, UserRow, ApprovalStatus } from './StaffDocumentsAdminPage';
import { openR2Key, openAuthedFile } from '../lib/openAuthedFile';

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
  current_completion_id: string | null;
  pdf_r2_key: string | null;
  completed_at: string | null;
}
interface LibraryDoc { id: string; slug: string; title: string; category: string; version: number | null; }
interface ReviewOwed {
  id: string; title: string; category: string;
  content_review_due_date: string | null; content_reviewed_at: string | null; version: number | null;
}
export interface MineData { todo: Assignment[]; completed: Assignment[]; library: LibraryDoc[]; reviewsOwed: ReviewOwed[] }

interface ViewData {
  id: string; title: string; category: string; completion_mode: Mode; tick_label: string | null;
  version: number | null; file_r2_key: string | null; file_name: string | null; body: string;
  assignment: { id: string; status: string } | null;
}

const CATEGORY_LABEL: Record<string, string> = {
  policy: 'Policy', agreement: 'Agreement', training: 'Training',
  official_doc: 'Official doc', contract: 'Contract', other: 'Document',
};

/**
 * How many documents are waiting for this person to sign or confirm — the
 * number on the Me › Documents tab. It is exactly the page's "Needs you"
 * list (the server's `todo`), so the badge and the page cannot disagree.
 */
export function countDocsWaiting(mine: MineData | null | undefined): number {
  return mine?.todo?.length ?? 0;
}

// "4 Jan 2026". A malformed date renders as a dash rather than "Invalid Date".
function fmt(d: string | null): string {
  if (!d) return '—';
  const dt = new Date(d);
  if (Number.isNaN(dt.getTime())) return '—';
  return dt.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
}

async function openR2File(key: string) {
  await openR2Key(key);
}

// Signed copy via the ownership-checked endpoint (never a raw key).
async function openCompletionPdf(completionId: string) {
  await openAuthedFile(`/staff-documents/completions/${completionId}/pdf`, 'completion.pdf');
}

// Shared Tailwind for the page's buttons. Mobile gets a 44px tap target.
const BTN_PRIMARY = 'inline-flex items-center justify-center min-h-[44px] sm:min-h-0 px-4 py-2 rounded-lg bg-ooosh-600 text-white text-sm font-semibold hover:bg-ooosh-700 disabled:bg-slate-300 disabled:cursor-not-allowed transition-colors';
const BTN_SECONDARY = 'inline-flex items-center justify-center min-h-[44px] sm:min-h-0 px-3.5 py-2 rounded-lg border border-gray-300 bg-white text-gray-700 text-sm hover:bg-gray-50 transition-colors';
const LINK = 'inline-flex items-center min-h-[44px] sm:min-h-0 text-[13px] text-ooosh-600 hover:underline';

export default function StaffDocumentsPage() {
  const [data, setData] = useState<MineData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [viewerId, setViewerId] = useState<string | null>(null);
  const [viewerAssignment, setViewerAssignment] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [justDone, setJustDone] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [authored, setAuthored] = useState<DocRow[]>([]);
  const [users, setUsers] = useState<UserRow[]>([]);
  const [form, setForm] = useState<{ open: boolean; doc: DocRow | null }>({ open: false, doc: null });
  const [versionDoc, setVersionDoc] = useState<DocRow | null>(null);
  const [viewProposal, setViewProposal] = useState<DocRow | null>(null);
  const role = useAuthStore((s) => s.user?.role);
  const canPublish = hasManagerRole(role);

  const load = useCallback(async () => {
    try {
      setLoading(true);
      const [mine, auth, us] = await Promise.all([
        api.get<{ data: MineData }>('/staff-documents/mine'),
        api.get<{ data: DocRow[] }>('/staff-documents/authored').catch(() => ({ data: [] as DocRow[] })),
        api.get<{ data: UserRow[] }>('/users').catch(() => ({ data: [] as UserRow[] })),
      ]);
      setData(mine.data);
      setAuthored(auth.data);
      setUsers(us.data);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load');
    } finally {
      setLoading(false);
    }
  }, []);

  const flash = (msg: string) => {
    setActionError(null);
    setToast(msg);
    setTimeout(() => setToast(null), 4000);
  };

  const submitForApproval = async (id: string) => {
    try {
      await api.post(`/staff-documents/${id}/submit`, {});
      flash('Sent for approval.');
      load();
    } catch (e) {
      setActionError(e instanceof Error ? e.message : 'Could not send for approval.');
    }
  };

  const markReviewed = async (id: string) => {
    if (!window.confirm('Mark as reviewed — you confirm the content is still current?')) return;
    try {
      await api.post(`/staff-documents/${id}/mark-reviewed`, {});
      flash('Thanks — review recorded.');
      load();
    } catch (e) {
      setActionError(e instanceof Error ? e.message : 'Could not record the review.');
    }
  };

  useEffect(() => { load(); }, [load]);

  const openViewer = (documentId: string, assignmentId: string | null) => {
    setViewerId(documentId);
    setViewerAssignment(assignmentId);
  };
  const closeViewer = () => { setViewerId(null); setViewerAssignment(null); };
  const onCompleted = () => {
    // Remember which row was just done so it can be picked out in the Done list.
    setJustDone(viewerAssignment);
    closeViewer();
    flash('Done — thank you.');
    load();
  };

  // Reference library: filtered by title, grouped by category in a fixed order.
  const libraryGroups = useMemo(() => {
    const q = query.trim().toLowerCase();
    const groups = new Map<string, LibraryDoc[]>();
    for (const d of data?.library ?? []) {
      if (q && !d.title.toLowerCase().includes(q)) continue;
      const label = CATEGORY_LABEL[d.category] || 'Document';
      if (!groups.has(label)) groups.set(label, []);
      groups.get(label)!.push(d);
    }
    const order = Object.values(CATEGORY_LABEL);
    return [...groups.entries()].sort((a, b) => order.indexOf(a[0]) - order.indexOf(b[0]));
  }, [data, query]);

  const header = (
    <div className="flex flex-wrap items-end justify-between gap-3">
      <div className="min-w-0">
        <h2 className="text-xl font-semibold text-gray-900">Documents</h2>
        <p className="mt-0.5 text-sm text-gray-500">Policies, agreements and guides for you to read and sign.</p>
      </div>
      <button onClick={() => setForm({ open: true, doc: null })}
        className="shrink-0 whitespace-nowrap inline-flex items-center min-h-[44px] sm:min-h-0 px-3.5 py-2 rounded-lg border border-ooosh-300 bg-white text-ooosh-700 text-sm font-medium hover:bg-ooosh-50 transition-colors">
        + New document
      </button>
    </div>
  );

  const modals = (
    <>
      {viewerId && (
        <DocumentViewer
          documentId={viewerId}
          assignmentId={viewerAssignment}
          onClose={closeViewer}
          onCompleted={onCompleted}
        />
      )}
      {form.open && (
        <DocFormModal doc={form.doc} users={users} canPublish={canPublish}
          onClose={() => setForm({ open: false, doc: null })}
          onSaved={() => { setForm({ open: false, doc: null }); load(); }} />
      )}
      {versionDoc && (
        <VersionModal doc={versionDoc} onClose={() => setVersionDoc(null)}
          onSaved={() => { setVersionDoc(null); load(); }} />
      )}
      {viewProposal && (
        <ViewModal doc={viewProposal} canReview={false} onApprove={() => {}} onReject={() => {}}
          onClose={() => setViewProposal(null)} />
      )}
    </>
  );

  // Three states before any content: still loading, failed, or loaded. A
  // failed load must never fall through to "You're all up to date".
  if (!data) {
    return (
      <div className="flex flex-col gap-[18px] sm:gap-5">
        {header}
        {loading ? (
          <div className="bg-white border border-gray-200 rounded-xl p-6 text-sm text-gray-500">Loading your documents…</div>
        ) : (
          <div className="bg-white border border-red-200 rounded-xl p-5 flex flex-wrap items-center justify-between gap-3">
            <div className="min-w-0">
              <div className="text-[15px] font-semibold text-red-800">Couldn't load your documents</div>
              <div className="mt-0.5 text-[13px] text-red-700">{error || 'Something went wrong.'}</div>
            </div>
            <button onClick={load} className={BTN_SECONDARY}>Try again</button>
          </div>
        )}
        {modals}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-[18px] sm:gap-5">
      {header}

      {error && <div className="px-3.5 py-2.5 rounded-lg bg-red-50 border border-red-200 text-sm text-red-800">Couldn't refresh: {error}</div>}
      {actionError && <div className="px-3.5 py-2.5 rounded-lg bg-red-50 border border-red-200 text-sm text-red-800">{actionError}</div>}
      {toast && <div className="px-3.5 py-2.5 rounded-lg bg-emerald-50 border border-emerald-200 text-sm text-emerald-800">{toast}</div>}

      {/* To do — "Needs you" */}
      {data.todo.length > 0 && (
        <section className="flex flex-col gap-2.5">
          <h3 className="text-[11px] font-semibold uppercase tracking-[.06em] text-amber-800">
            Needs you · {data.todo.length}
          </h3>
          <div className="grid gap-3 grid-cols-[repeat(auto-fill,minmax(min(340px,100%),1fr))]">
            {data.todo.map((a) => (
              <div key={a.id} className="bg-white border border-amber-200 rounded-xl px-5 py-[18px] flex flex-col gap-3">
                <div className="flex items-start justify-between gap-2.5">
                  <div className="min-w-0">
                    <div className="text-base font-semibold text-gray-900">{a.title}</div>
                    <div className="mt-[3px] text-[13px] text-gray-500">
                      {CATEGORY_LABEL[a.category] || 'Document'}
                      {a.version != null && <> · version {a.version}</>}
                      {a.status === 'lapsed' && <> · your last signature has lapsed</>}
                    </div>
                  </div>
                  <span className="shrink-0 whitespace-nowrap px-[9px] py-[3px] rounded-full bg-amber-100 text-amber-800 text-xs font-medium">
                    {a.completion_mode === 'sign' ? 'Signature needed' : 'Read and confirm'}
                  </span>
                </div>
                <button onClick={() => openViewer(a.document_id, a.id)} className={`${BTN_PRIMARY} self-start`}>
                  {a.completion_mode === 'sign' ? 'Read and sign' : 'Read and confirm'}
                </button>
              </div>
            ))}
          </div>
        </section>
      )}

      {data.todo.length === 0 && (
        <div className="flex items-center gap-3 px-5 py-4 rounded-xl bg-emerald-50 border border-emerald-200">
          <span className="shrink-0 w-7 h-7 rounded-full bg-emerald-500 text-white flex items-center justify-center text-sm font-bold">✓</span>
          <div>
            <div className="text-[15px] font-semibold text-emerald-800">You're all up to date</div>
            <div className="mt-px text-[13px] text-emerald-700">Nothing to read or sign right now.</div>
          </div>
        </div>
      )}

      {/* Documents you own — content review due */}
      {data.reviewsOwed.map((r) => (
        <div key={r.id} className="bg-white border border-gray-200 rounded-xl px-5 py-4 flex flex-wrap items-center justify-between gap-4">
          <div className="min-w-0">
            <div className="mb-1 text-xs font-semibold text-amber-800">
              You look after this{r.content_review_due_date && <> · review due {fmt(r.content_review_due_date)}</>}
            </div>
            <div className="text-[15px] font-semibold text-gray-900">{r.title}</div>
            <div className="mt-0.5 text-[13px] text-gray-500">
              {CATEGORY_LABEL[r.category] || 'Document'}
              {r.content_reviewed_at && <> · last reviewed {fmt(r.content_reviewed_at)}</>}
              {' · '}Check it's still accurate. If it needs changing,{' '}
              {canPublish ? 'publish a new version from Manage Documents' : 'ask a manager to publish a new version'}.
            </div>
          </div>
          <div className="flex gap-2">
            <button onClick={() => openViewer(r.id, null)} className={BTN_SECONDARY}>View</button>
            <button onClick={() => markReviewed(r.id)} className={BTN_PRIMARY}>Still accurate</button>
          </div>
        </div>
      ))}

      {(data.completed.length > 0 || data.library.length > 0) && (
        <div className="flex flex-wrap items-start gap-4">
          {/* Completed */}
          {data.completed.length > 0 && (
            <section className="flex-[1_1_420px] min-w-0 bg-white border border-gray-200 rounded-xl overflow-hidden">
              <div className="px-5 py-3.5 border-b border-gray-100">
                <h3 className="text-[17px] font-semibold text-gray-900">Done</h3>
                <p className="mt-0.5 text-[13px] text-gray-500">What you've signed or confirmed, and when it renews</p>
              </div>
              {data.completed.map((a) => (
                <div key={a.id}
                  className={`flex flex-wrap sm:flex-nowrap items-center gap-x-3.5 gap-y-1 px-5 py-[13px] border-b border-gray-100 last:border-b-0 ${a.id === justDone ? 'bg-green-50' : 'bg-white'}`}>
                  <span className="shrink-0 w-[22px] h-[22px] rounded-full bg-emerald-100 text-emerald-700 flex items-center justify-center text-xs font-bold">✓</span>
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-medium text-gray-900">{a.title}</div>
                    <div className="mt-0.5 text-xs text-gray-500">
                      {a.completion_mode === 'sign' ? 'Signed' : a.completion_mode === 'tick' ? 'Confirmed' : 'Completed'} {fmt(a.completed_at)}
                      {a.expires_at && <> · renews {fmt(a.expires_at)}</>}
                    </div>
                  </div>
                  <div className="flex gap-3 whitespace-nowrap pl-9 sm:pl-0">
                    {a.pdf_r2_key && a.current_completion_id && (
                      <button onClick={() => openCompletionPdf(a.current_completion_id!)} className={LINK}>
                        Signed copy
                      </button>
                    )}
                    <button onClick={() => openViewer(a.document_id, null)} className={LINK}>View</button>
                  </div>
                </div>
              ))}
            </section>
          )}

          {/* Reference library */}
          {data.library.length > 0 && (
            <section className="flex-[1_1_320px] min-w-0 bg-white border border-gray-200 rounded-xl overflow-hidden">
              <div className="px-5 pt-3.5 pb-3 border-b border-gray-100 flex flex-col gap-2.5">
                <h3 className="text-[17px] font-semibold text-gray-900">Reference library</h3>
                <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search guides and policies"
                  className="px-3 py-2 border border-gray-300 rounded-lg text-base sm:text-sm focus:outline-none focus:border-ooosh-500 focus:ring-1 focus:ring-ooosh-500" />
              </div>
              {libraryGroups.map(([cat, docs]) => (
                <div key={cat} className="pb-1">
                  <div className="px-5 pt-2 pb-1 text-[11px] font-semibold uppercase tracking-[.06em] text-gray-500">{cat}</div>
                  {docs.map((d) => (
                    <button key={d.id} onClick={() => openViewer(d.id, null)}
                      className="w-full flex items-center justify-between gap-2.5 min-h-[44px] sm:min-h-0 px-5 py-[9px] text-left text-sm text-gray-900 hover:bg-gray-50">
                      <span className="min-w-0">{d.title}</span>
                      <span className="text-gray-400">›</span>
                    </button>
                  ))}
                </div>
              ))}
              {libraryGroups.length === 0 && <div className="px-5 py-3.5 text-[13px] text-gray-500">Nothing matches.</div>}
            </section>
          )}
        </div>
      )}

      {/* My proposals — documents this user has created */}
      {authored.length > 0 && (
        <section className="bg-white border border-gray-200 rounded-xl overflow-hidden">
          <div className="px-5 py-3.5 border-b border-gray-100">
            <h3 className="text-[17px] font-semibold text-gray-900">Your drafts</h3>
            <p className="mt-0.5 text-[13px] text-gray-500">Documents you've written — a manager approves them before they go out</p>
          </div>
          {authored.map((d) => {
            const pill = APPROVAL_PILL[d.approval_status] ?? APPROVAL_PILL.draft;
            return (
              <div key={d.id} className="px-5 py-[13px] border-b border-gray-100 last:border-b-0 flex flex-col gap-2">
                <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
                  <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1 min-w-0">
                    <span className="text-sm font-medium text-gray-900">{d.title}</span>
                    <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${pill.c}`}>{pill.t}</span>
                    <span className="text-xs text-gray-400">{CATEGORY_LABEL[d.category] || d.category}</span>
                  </div>
                  <div className="flex flex-wrap items-center gap-x-3.5 gap-y-1">
                    <button onClick={() => setViewProposal(d)} className={LINK}>View</button>
                    {d.approval_status !== 'approved' && (
                      <>
                        <button onClick={() => setForm({ open: true, doc: d })} className={LINK}>Edit</button>
                        <button onClick={() => setVersionDoc(d)} className={LINK}>Content</button>
                      </>
                    )}
                    {d.approval_status === 'draft' && (
                      <button onClick={() => submitForApproval(d.id)}
                        className="inline-flex items-center min-h-[44px] sm:min-h-0 px-3 py-1.5 rounded-lg bg-ooosh-600 text-white text-[13px] font-semibold hover:bg-ooosh-700">
                        Send for approval
                      </button>
                    )}
                  </div>
                </div>
                {d.approval_status === 'draft' && d.review_notes && (
                  <div className="px-3 py-2 rounded-lg bg-red-50 text-[13px] text-red-800">Changes asked for: {d.review_notes}</div>
                )}
              </div>
            );
          })}
        </section>
      )}

      {modals}
    </div>
  );
}

const APPROVAL_PILL: Record<ApprovalStatus, { t: string; c: string }> = {
  draft: { t: 'Draft', c: 'bg-gray-100 text-gray-600' },
  pending_approval: { t: 'Waiting for approval', c: 'bg-amber-100 text-amber-800' },
  approved: { t: 'Approved', c: 'bg-emerald-100 text-emerald-800' },
};

// ── Signature pad ───────────────────────────────────────────────────────────
// A small pointer-events pad for this modal's footer. The book-out
// SignatureCapture is shared with the vehicle and claim flows and carries its
// own label and "Clear & Re-sign" chrome, and it can't tell the parent when ink
// lands — which the "Add your signature first" button needs. Output matches it:
// a PNG on a white background.

interface SignaturePadHandle {
  getBlob: () => Promise<Blob | null>;
  clear: () => void;
}

const SignaturePad = forwardRef<SignaturePadHandle, { onChange: (hasInk: boolean) => void }>(
  function SignaturePad({ onChange }, ref) {
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const drawing = useRef(false);
    const hasInk = useRef(false);

    const paintBlank = useCallback(() => {
      const canvas = canvasRef.current;
      const ctx = canvas?.getContext('2d');
      if (!canvas || !ctx) return;
      const rect = canvas.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      canvas.width = Math.max(1, Math.round(rect.width * dpr));
      canvas.height = Math.max(1, Math.round(rect.height * dpr));
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, rect.width, rect.height);
      ctx.strokeStyle = '#111827';
      ctx.lineWidth = 2.2;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
    }, []);

    useEffect(() => { paintBlank(); }, [paintBlank]);

    const clear = useCallback(() => {
      paintBlank();
      hasInk.current = false;
      onChange(false);
    }, [paintBlank, onChange]);

    useImperativeHandle(ref, () => ({
      getBlob: () => new Promise<Blob | null>((resolve) => {
        const canvas = canvasRef.current;
        if (!canvas || !hasInk.current) { resolve(null); return; }
        canvas.toBlob((b) => resolve(b), 'image/png');
      }),
      clear,
    }), [clear]);

    const point = (e: React.PointerEvent<HTMLCanvasElement>) => {
      const rect = e.currentTarget.getBoundingClientRect();
      return { x: e.clientX - rect.left, y: e.clientY - rect.top };
    };

    return (
      <div className="flex flex-col gap-1.5">
        <div className="flex items-center justify-between text-[13px] text-gray-600">
          <span>Sign here</span>
          <button type="button" onClick={clear} className="min-h-[44px] sm:min-h-0 px-1 text-[13px] text-ooosh-600 hover:underline">Clear</button>
        </div>
        <canvas
          ref={canvasRef}
          className="w-full h-[130px] bg-white border border-dashed border-slate-300 rounded-[10px] cursor-crosshair"
          style={{ touchAction: 'none' }}
          onPointerDown={(e) => {
            const ctx = e.currentTarget.getContext('2d');
            if (!ctx) return;
            e.currentTarget.setPointerCapture(e.pointerId);
            drawing.current = true;
            const { x, y } = point(e);
            ctx.beginPath();
            ctx.moveTo(x, y);
          }}
          onPointerMove={(e) => {
            if (!drawing.current) return;
            const ctx = e.currentTarget.getContext('2d');
            if (!ctx) return;
            const { x, y } = point(e);
            ctx.lineTo(x, y);
            ctx.stroke();
            if (!hasInk.current) { hasInk.current = true; onChange(true); }
          }}
          onPointerUp={() => { drawing.current = false; }}
          onPointerCancel={() => { drawing.current = false; }}
        />
      </div>
    );
  },
);

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
  const [signed, setSigned] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const sigRef = useRef<SignaturePadHandle>(null);

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
  const needsSignature = doc?.completion_mode === 'sign';
  const ready = agreed && (!needsSignature || signed) && !submitting;

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

  const meta = doc
    ? `${CATEGORY_LABEL[doc.category] || 'Document'}${doc.version != null ? ` · version ${doc.version}` : ''}`
    : '';
  const buttonLabel = submitting
    ? 'Saving…'
    : needsSignature
      ? (signed ? 'Sign and send' : 'Add your signature first')
      : 'Confirm';

  // Centred modal on desktop; a bottom sheet on a phone.
  return (
    <div className="fixed inset-0 z-50 bg-gray-900/45 flex items-end sm:items-center justify-center sm:p-4" onClick={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        className="bg-white w-full sm:max-w-[640px] max-h-[92%] sm:max-h-[90vh] rounded-t-2xl sm:rounded-[14px] shadow-2xl flex flex-col overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between gap-3 pl-[22px] pr-3 sm:pr-[22px] py-4 border-b border-gray-100">
          <div className="min-w-0">
            <h3 className="text-[17px] font-semibold text-gray-900">{doc?.title || 'Document'}</h3>
            {meta && <div className="mt-0.5 text-xs text-gray-500">{meta}</div>}
          </div>
          <button onClick={onClose} aria-label="Close"
            className="shrink-0 w-11 h-11 sm:w-auto sm:h-auto flex items-center justify-center text-[22px] leading-none text-gray-400 hover:text-gray-700">×</button>
        </div>

        <div className="px-[22px] py-5 overflow-y-auto text-[15px] leading-[1.65] text-gray-800">
          {loading && <div className="text-gray-500">Loading…</div>}
          {err && <div className="mb-3 p-3 rounded-lg bg-red-50 border border-red-200 text-red-800 text-sm">{err}</div>}

          {doc && !loading && (
            <>
              {doc.file_r2_key && (
                <button onClick={() => openR2File(doc.file_r2_key!)}
                  className={`${BTN_SECONDARY} mb-4`}>
                  📄 Open {doc.file_name || 'document'}
                </button>
              )}
              {doc.body && <MarkdownLite text={doc.body} />}
            </>
          )}
        </div>

        {doc && !loading && canComplete && (
          <div className="px-[22px] pt-[18px] pb-[max(18px,env(safe-area-inset-bottom))] border-t border-gray-100 bg-gray-50 flex flex-col gap-3.5">
            {needsSignature && <SignaturePad ref={sigRef} onChange={setSigned} />}
            <label className="flex items-start gap-2.5 text-sm text-gray-700 cursor-pointer">
              <input type="checkbox" className="mt-0.5 w-4 h-4 shrink-0 accent-ooosh-600" checked={agreed} onChange={(e) => setAgreed(e.target.checked)} />
              <span>{doc.tick_label || 'I’ve read this and agree to it.'}</span>
            </label>
            <button
              onClick={submit}
              disabled={!ready}
              className="self-stretch sm:self-start inline-flex items-center justify-center min-h-[44px] sm:min-h-0 px-5 py-2.5 rounded-lg bg-ooosh-600 text-white text-[15px] font-semibold hover:bg-ooosh-700 disabled:bg-slate-300 disabled:cursor-not-allowed transition-colors"
            >
              {buttonLabel}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
