import { useEffect, useMemo, useState } from 'react';
import { api } from '../services/api';

// Combine two same-client pre-hire bookings into one. The survivor (the more-
// committed booking) keeps its identity and gains the combined date range; the
// other is retired as cancelled with its deposit reattributed to the survivor
// in HireHop. See CLAUDE.md "Combine bookings" + backend pipeline.ts.

interface Candidate {
  id: string;
  hh_job_number: number | null;
  job_name: string | null;
  pipeline_status: string;
  out_date: string | null;
  job_date: string | null;
  job_end: string | null;
  return_date: string | null;
  job_value: number | null;
}

interface JobSummary {
  id: string;
  hh_job_number: number | null;
  job_name: string | null;
  client_name: string | null;
  pipeline_status: string;
  out_date: string | null;
  job_date: string | null;
  job_end: string | null;
  return_date: string | null;
  deposit_total: number;
  deposits: Array<{ amount: number; bank: string | null; date: string }>;
}

interface PreviewResp {
  can_combine: boolean;
  blocks: string[];
  survivor: JobSummary;
  absorbed: JobSummary;
  combined_dates: { out_date: string; job_date: string; job_end: string; return_date: string };
  deposit_to_move: number;
}

interface Props {
  jobId: string;
  onClose: () => void;
  /** Called after a successful combine — receives the survivor's job id. */
  onCombined: (survivorId: string) => void;
}

const fmtDate = (d: string | null) =>
  d ? new Date(d).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) : '—';

const STATUS_LABELS: Record<string, string> = {
  new_enquiry: 'Enquiry', quoting: 'Enquiry', paused: 'Paused',
  provisional: 'Provisional', confirmed: 'Confirmed', prepped: 'Prepped', prepping: 'Prepping',
};

export default function CombineBookingsModal({ jobId, onClose, onCombined }: Props) {
  const [candidates, setCandidates] = useState<Candidate[]>([]);
  const [clientName, setClientName] = useState<string | null>(null);
  const [loadingList, setLoadingList] = useState(true);
  const [search, setSearch] = useState('');

  const [preview, setPreview] = useState<PreviewResp | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [confirmText, setConfirmText] = useState('');
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  useEffect(() => {
    (async () => {
      try {
        const res = await api.get<{ data: Candidate[]; client_name: string | null }>(
          `/pipeline/${jobId}/combine-candidates`
        );
        setCandidates(res.data);
        setClientName(res.client_name);
      } catch (e: any) {
        setError(e?.message || 'Failed to load bookings');
      } finally {
        setLoadingList(false);
      }
    })();
  }, [jobId]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return candidates;
    return candidates.filter(c =>
      (c.job_name || '').toLowerCase().includes(q) ||
      String(c.hh_job_number || '').includes(q)
    );
  }, [candidates, search]);

  const loadPreview = async (otherId: string) => {
    setPreviewLoading(true);
    setError(null);
    setConfirmText('');
    try {
      const res = await api.get<PreviewResp>(`/pipeline/${jobId}/combine-preview?with=${otherId}`);
      setPreview(res);
    } catch (e: any) {
      setError(e?.message || 'Failed to build preview');
    } finally {
      setPreviewLoading(false);
    }
  };

  const submit = async () => {
    if (!preview) return;
    setSubmitting(true);
    setError(null);
    try {
      const res = await api.post<{ success: boolean; survivor_id: string; deposit_moved: number; hh_warnings: string[] }>(
        `/pipeline/${preview.survivor.id}/combine`,
        {
          absorb_job_id: preview.absorbed.id,
          out_date: preview.combined_dates.out_date,
          job_date: preview.combined_dates.job_date,
          job_end: preview.combined_dates.job_end,
          return_date: preview.combined_dates.return_date,
        }
      );
      if (res.hh_warnings && res.hh_warnings.length > 0) {
        alert('Combined, but with HireHop warnings — please check:\n\n• ' + res.hh_warnings.join('\n• '));
      }
      onCombined(res.survivor_id);
    } catch (e: any) {
      setError(e?.message || 'Failed to combine bookings');
      setSubmitting(false);
    }
  };

  const confirmTarget = preview ? String(preview.absorbed.hh_job_number || 'COMBINE') : '';
  const confirmOk = preview?.can_combine && confirmText.trim() === confirmTarget;

  return (
    <div className="fixed inset-0 bg-black/40 z-50 flex items-start justify-center p-4 overflow-y-auto" onClick={onClose}>
      <div className="bg-white rounded-xl shadow-xl w-full max-w-2xl my-8" onClick={e => e.stopPropagation()}>
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b">
          <h2 className="text-lg font-bold text-gray-900">🔀 Combine bookings</h2>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 text-xl leading-none">×</button>
        </div>

        <div className="px-5 py-4">
          {error && (
            <div className="mb-3 text-sm text-red-700 bg-red-50 border border-red-200 rounded-lg p-3">{error}</div>
          )}

          {!preview ? (
            <>
              <p className="text-sm text-gray-600 mb-3">
                Pick another pre-hire booking{clientName ? ` for ${clientName}` : ''} to merge into one.
                The more-committed booking is kept; the other is retired and its deposit moved across.
              </p>
              {loadingList ? (
                <p className="text-sm text-gray-500">Loading bookings…</p>
              ) : candidates.length === 0 ? (
                <p className="text-sm text-gray-500">No other pre-hire bookings for this client to combine with.</p>
              ) : (
                <>
                  <input
                    value={search}
                    onChange={e => setSearch(e.target.value)}
                    placeholder="Search by job name or HireHop #"
                    className="w-full mb-3 px-3 py-2 border border-gray-300 rounded-lg text-sm"
                  />
                  <div className="space-y-2 max-h-80 overflow-y-auto">
                    {filtered.map(c => (
                      <button
                        key={c.id}
                        onClick={() => loadPreview(c.id)}
                        disabled={previewLoading}
                        className="w-full text-left px-3 py-2.5 border border-gray-200 rounded-lg hover:border-ooosh-400 hover:bg-ooosh-50 disabled:opacity-50 transition-colors"
                      >
                        <div className="flex items-center justify-between gap-2">
                          <span className="font-medium text-gray-900 truncate">
                            {c.hh_job_number ? `#${c.hh_job_number} · ` : ''}{c.job_name || 'Untitled'}
                          </span>
                          <span className="text-xs px-2 py-0.5 bg-gray-100 text-gray-600 rounded-full shrink-0">
                            {STATUS_LABELS[c.pipeline_status] || c.pipeline_status}
                          </span>
                        </div>
                        <div className="text-xs text-gray-500 mt-0.5">
                          {fmtDate(c.out_date || c.job_date)} – {fmtDate(c.return_date || c.job_end)}
                        </div>
                      </button>
                    ))}
                    {filtered.length === 0 && <p className="text-sm text-gray-500">No bookings match your search.</p>}
                  </div>
                </>
              )}
            </>
          ) : (
            <>
              {/* Preview */}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mb-3">
                <div className="border border-green-200 bg-green-50 rounded-lg p-3">
                  <div className="text-xs font-semibold text-green-700 uppercase tracking-wide mb-1">Kept</div>
                  <div className="font-medium text-gray-900">
                    {preview.survivor.hh_job_number ? `#${preview.survivor.hh_job_number} · ` : ''}{preview.survivor.job_name || 'Untitled'}
                  </div>
                  <div className="text-xs text-gray-600 mt-1">{STATUS_LABELS[preview.survivor.pipeline_status] || preview.survivor.pipeline_status}</div>
                  <div className="text-xs text-gray-700 mt-2">
                    New dates: <strong>{fmtDate(preview.combined_dates.out_date)}</strong> – <strong>{fmtDate(preview.combined_dates.return_date)}</strong>
                  </div>
                  <div className="text-xs text-gray-700 mt-1">
                    Deposits: <strong>£{(preview.survivor.deposit_total + preview.deposit_to_move).toFixed(2)}</strong>
                    {preview.deposit_to_move > 0 && <span className="text-gray-500"> (incl. £{preview.deposit_to_move.toFixed(2)} moved across)</span>}
                  </div>
                </div>
                <div className="border border-red-200 bg-red-50 rounded-lg p-3">
                  <div className="text-xs font-semibold text-red-700 uppercase tracking-wide mb-1">Retired</div>
                  <div className="font-medium text-gray-900">
                    {preview.absorbed.hh_job_number ? `#${preview.absorbed.hh_job_number} · ` : ''}{preview.absorbed.job_name || 'Untitled'}
                  </div>
                  <div className="text-xs text-gray-600 mt-1">{STATUS_LABELS[preview.absorbed.pipeline_status] || preview.absorbed.pipeline_status}</div>
                  <div className="text-xs text-gray-700 mt-2">
                    → Cancelled, no fee. Deposit <strong>£{preview.deposit_to_move.toFixed(2)}</strong> moved to the kept booking.
                  </div>
                </div>
              </div>

              {preview.blocks.length > 0 ? (
                <div className="mb-3 text-sm text-red-700 bg-red-50 border border-red-200 rounded-lg p-3">
                  <div className="font-semibold mb-1">Can't combine these yet:</div>
                  <ul className="list-disc list-inside space-y-1">
                    {preview.blocks.map((b, i) => <li key={i}>{b}</li>)}
                  </ul>
                </div>
              ) : (
                <div className="mb-3">
                  <p className="text-xs text-gray-600 mb-2">
                    This reallocates the deposit in HireHop (and fires a Xero sync). No client emails are sent.
                    Type <strong>{confirmTarget}</strong> to confirm.
                  </p>
                  <input
                    value={confirmText}
                    onChange={e => setConfirmText(e.target.value)}
                    placeholder={`Type ${confirmTarget}`}
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm"
                  />
                </div>
              )}

              <div className="flex items-center justify-between gap-2">
                <button
                  onClick={() => { setPreview(null); setError(null); }}
                  className="text-sm px-3 py-2 text-gray-600 hover:text-gray-800"
                >
                  ← Pick a different booking
                </button>
                <button
                  onClick={submit}
                  disabled={!confirmOk || submitting}
                  className="text-sm px-4 py-2 bg-ooosh-600 text-white rounded-lg hover:bg-ooosh-700 disabled:opacity-40 disabled:cursor-not-allowed font-medium"
                >
                  {submitting ? 'Combining…' : 'Combine bookings'}
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
