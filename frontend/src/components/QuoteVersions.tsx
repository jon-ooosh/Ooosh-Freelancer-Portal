import { useState, useEffect, useCallback, useRef } from 'react';
import { api } from '../services/api';

/**
 * Quote-PDF version diff (Auto-Chase §7.3).
 *
 * The succession of quote PDFs we emailed for a job — the real physical trail of
 * what was on the job when (HireHop keeps only the latest state). Harvested from
 * the mailbox, vision-extracted, and diffed consecutively so staff see exactly
 * what changed between quotes. Shown on the Activity Timeline; quote PDFs never
 * enter the Files tab.
 *
 * Loading model: the GET returns cached state INSTANTLY and runs harvest +
 * extraction in the BACKGROUND. While `working` (or any version is still being
 * read) we poll so items + diffs fill in live — no blocking, no eternal
 * "reading…". Renders nothing until a job actually has quote PDFs.
 */
type ExtractStatus = 'done' | 'pending' | 'failed';
interface QuoteVersion {
  id: string;
  receivedAt: string;
  filename: string | null;
  r2Key: string;
  quoteTotal: number | null;
  itemCount: number;
  extractStatus: ExtractStatus;
}
interface DiffLine {
  description: string;
  kind: 'added' | 'removed' | 'qty' | 'price';
  from?: { qty: number | null; price: number | null };
  to?: { qty: number | null; price: number | null };
}
interface VersionDiff {
  fromId: string;
  toId: string;
  fromDate: string;
  toDate: string;
  lines: DiffLine[];
}
interface Result {
  available: boolean;
  configured: boolean;
  working: boolean;
  versions: QuoteVersion[];
  diffs: VersionDiff[];
}

const POLL_MS = 4000;
const MAX_POLLS = 45; // ~3 min safety cap

function fmtDateTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}
function money(n: number | null): string {
  return n == null ? '—' : `£${n.toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export default function QuoteVersions({ jobId, emailSignal }: { jobId: string; emailSignal?: number }) {
  const [result, setResult] = useState<Result | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState('');
  // Pre-collapsed by default (the "· N sent" count is enough to invite a click).
  const [collapsed, setCollapsed] = useState(() => {
    const v = localStorage.getItem('ooosh_quoteversions_collapsed');
    return v === null ? true : v === '1';
  });
  const toggleCollapsed = () =>
    setCollapsed((c) => {
      const next = !c;
      localStorage.setItem('ooosh_quoteversions_collapsed', next ? '1' : '0');
      return next;
    });

  const pollRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pollsRef = useRef(0);

  const load = useCallback(async (): Promise<Result | null> => {
    try {
      const res = await api.get<{ data: Result }>(`/auto-chase/quote-versions/${jobId}`);
      setResult(res.data);
      return res.data;
    } catch {
      setResult(null);
      return null;
    } finally {
      setLoading(false);
    }
  }, [jobId]);

  // Poll while the backend is still harvesting/extracting, so items + diffs fill
  // in live. Stops when nothing is in flight (or the safety cap is hit).
  const schedulePoll = useCallback(
    (data: Result | null) => {
      if (pollRef.current) { clearTimeout(pollRef.current); pollRef.current = null; }
      const stillWorking = !!data && (data.working || data.versions.some((v) => v.extractStatus === 'pending'));
      if (!stillWorking || pollsRef.current >= MAX_POLLS) return;
      pollRef.current = setTimeout(async () => {
        pollsRef.current += 1;
        const next = await load();
        schedulePoll(next);
      }, POLL_MS);
    },
    [load],
  );

  useEffect(() => {
    pollsRef.current = 0;
    load().then(schedulePoll);
    return () => { if (pollRef.current) clearTimeout(pollRef.current); };
  }, [load, schedulePoll, emailSignal]);

  const refresh = useCallback(async () => {
    setRefreshing(true);
    setError('');
    try {
      const res = await api.post<{ data: Result }>(`/auto-chase/quote-versions/${jobId}/refresh`, {});
      setResult(res.data);
      pollsRef.current = 0;
      schedulePoll(res.data);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not refresh quotes');
    } finally {
      setRefreshing(false);
    }
  }, [jobId, schedulePoll]);

  async function openPdf(key: string) {
    try {
      const { blob } = await api.blob(`/files/download?key=${encodeURIComponent(key)}`);
      window.open(URL.createObjectURL(blob), '_blank');
    } catch {
      setError('Could not open the quote PDF');
    }
  }

  // Nothing to show: still loading, or the job has no quote PDFs. (A background
  // harvest with 0 results simply never flips `available`, so no-quote jobs stay
  // invisible.)
  if (loading) return null;
  if (!result || !result.available || result.versions.length === 0) return null;

  const diffByTo = new Map(result.diffs.map((d) => [d.toId, d]));

  return (
    <div className="mb-4 rounded-xl border border-indigo-200 bg-indigo-50/60 p-4">
      <div className="flex items-start justify-between gap-3 mb-2">
        <button
          type="button"
          onClick={toggleCollapsed}
          title={collapsed ? 'Expand' : 'Collapse'}
          className="flex items-center gap-2 text-xs font-semibold text-indigo-700 min-w-0"
        >
          <span aria-hidden className="text-indigo-400">{collapsed ? '▸' : '▾'}</span>
          <span aria-hidden>📄</span>
          <span>Quote versions</span>
          <span className="font-normal text-indigo-400">· {result.versions.length} sent</span>
          {result.working && <span className="font-normal text-indigo-300">· reading…</span>}
        </button>
        {!collapsed && (
          <button
            type="button"
            onClick={refresh}
            disabled={refreshing}
            title="Search the mailbox for newer quote PDFs"
            className="text-xs text-indigo-500 hover:text-indigo-700 disabled:opacity-50 shrink-0"
          >
            {refreshing ? 'Checking…' : '↻ Refresh'}
          </button>
        )}
      </div>

      {!collapsed && (
        <ol className="space-y-2.5">
          {result.versions.map((v, i) => {
            const diff = diffByTo.get(v.id);
            return (
              <li key={v.id} className="rounded-lg bg-white/70 border border-indigo-100 p-2.5">
                <div className="flex items-center justify-between gap-2 flex-wrap">
                  <div className="flex items-center gap-2 text-sm">
                    <span className="inline-flex items-center justify-center h-5 w-5 rounded-full bg-indigo-100 text-indigo-700 text-[11px] font-semibold shrink-0">
                      {i + 1}
                    </span>
                    <span className="font-medium text-gray-900">{fmtDateTime(v.receivedAt)}</span>
                    {v.extractStatus === 'done' ? (
                      <>
                        <span className="text-gray-400">·</span>
                        <span className="text-gray-600">{v.itemCount} item{v.itemCount === 1 ? '' : 's'}</span>
                        {v.quoteTotal != null && (
                          <>
                            <span className="text-gray-400">·</span>
                            <span className="text-gray-700 font-medium">{money(v.quoteTotal)}</span>
                          </>
                        )}
                      </>
                    ) : v.extractStatus === 'failed' ? (
                      <span className="text-[11px] text-gray-400">· couldn't read this PDF</span>
                    ) : (
                      <span className="text-[11px] text-amber-500">· reading…</span>
                    )}
                  </div>
                  <button
                    type="button"
                    onClick={() => openPdf(v.r2Key)}
                    className="text-xs font-medium text-indigo-600 hover:text-indigo-800 shrink-0"
                  >
                    Open PDF ↗
                  </button>
                </div>

                {/* What changed vs the previous version. */}
                {i > 0 && v.extractStatus === 'done' && (
                  <div className="mt-1.5 pl-7 text-xs">
                    {!diff ? (
                      <span className="text-gray-400">Comparing…</span>
                    ) : diff.lines.length === 0 ? (
                      <span className="text-gray-400">No line-item changes vs version {i}</span>
                    ) : (
                      <ul className="space-y-0.5">
                        {diff.lines.map((l, k) => (
                          <li key={k} className="flex items-baseline gap-1.5">
                            {l.kind === 'added' && (
                              <span className="text-green-700">
                                <span className="font-semibold">+</span> {l.to?.qty != null ? `${l.to.qty}× ` : ''}{l.description}
                              </span>
                            )}
                            {l.kind === 'removed' && (
                              <span className="text-red-600">
                                <span className="font-semibold">−</span> {l.from?.qty != null ? `${l.from.qty}× ` : ''}{l.description}
                              </span>
                            )}
                            {l.kind === 'qty' && (
                              <span className="text-amber-700">
                                <span className="font-semibold">~</span> {l.description}: qty {l.from?.qty ?? '—'} → {l.to?.qty ?? '—'}
                              </span>
                            )}
                            {l.kind === 'price' && (
                              <span className="text-amber-700">
                                <span className="font-semibold">~</span> {l.description}: {money(l.from?.price ?? null)} → {money(l.to?.price ?? null)}
                              </span>
                            )}
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                )}
              </li>
            );
          })}
        </ol>
      )}

      {!collapsed && error && <p className="mt-2 text-xs text-red-500">{error}</p>}
    </div>
  );
}
