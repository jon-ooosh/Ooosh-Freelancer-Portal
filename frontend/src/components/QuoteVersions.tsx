import { useState, useEffect, useCallback } from 'react';
import { api } from '../services/api';

/**
 * Quote-PDF version diff (Auto-Chase §7.3).
 *
 * The succession of quote PDFs we emailed for a job — the real physical trail of
 * what was on the job when (HireHop keeps only the latest state). Harvested from
 * the mailbox, vision-extracted, and diffed consecutively so staff see exactly
 * what changed between quotes. Shown on the Activity Timeline (things belong with
 * the comms; money's about money). Quote PDFs never enter the Files tab.
 *
 * Renders nothing until a job actually has quote PDFs — no noise on jobs without.
 */
interface QuoteVersion {
  id: string;
  receivedAt: string;
  filename: string | null;
  r2Key: string;
  quoteTotal: number | null;
  itemCount: number;
  extracted: boolean;
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
  versions: QuoteVersion[];
  diffs: VersionDiff[];
}

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
  const [collapsed, setCollapsed] = useState(
    () => localStorage.getItem('ooosh_quoteversions_collapsed') === '1',
  );
  const toggleCollapsed = () =>
    setCollapsed((c) => {
      const next = !c;
      localStorage.setItem('ooosh_quoteversions_collapsed', next ? '1' : '0');
      return next;
    });

  const load = useCallback(async () => {
    try {
      const res = await api.get<{ data: Result }>(`/auto-chase/quote-versions/${jobId}`);
      setResult(res.data);
    } catch {
      // Silent — a missing table pre-migration shouldn't break the timeline.
      setResult(null);
    } finally {
      setLoading(false);
    }
  }, [jobId]);

  const refresh = useCallback(async () => {
    setRefreshing(true);
    setError('');
    try {
      const res = await api.post<{ data: Result }>(`/auto-chase/quote-versions/${jobId}/refresh`, {});
      setResult(res.data);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not refresh quotes');
    } finally {
      setRefreshing(false);
    }
  }, [jobId]);

  useEffect(() => { load(); }, [load, emailSignal]);

  async function openPdf(key: string) {
    try {
      const { blob } = await api.blob(`/files/download?key=${encodeURIComponent(key)}`);
      window.open(URL.createObjectURL(blob), '_blank');
    } catch {
      setError('Could not open the quote PDF');
    }
  }

  // Nothing to show: still loading, or the job has no quote PDFs.
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
                  <span className="text-gray-400">·</span>
                  <span className="text-gray-600">{v.itemCount} item{v.itemCount === 1 ? '' : 's'}</span>
                  {v.quoteTotal != null && (
                    <>
                      <span className="text-gray-400">·</span>
                      <span className="text-gray-700 font-medium">{money(v.quoteTotal)}</span>
                    </>
                  )}
                  {!v.extracted && <span className="text-[11px] text-amber-500">· reading…</span>}
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
              {i > 0 && (
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
      {!collapsed && (
        <p className="mt-2 text-[11px] text-indigo-400">
          Harvested from the emailed quote PDFs · ordered by send time
        </p>
      )}
    </div>
  );
}
