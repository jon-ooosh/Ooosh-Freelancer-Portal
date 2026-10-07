/**
 * One compact line about the latest search — replaces the old paragraph.
 * Running: pulse + elapsed + Stop. Done: when · who · window, then chips;
 * "N new" filters the page to that batch. "History" opens the search history.
 */
import type { LeadRun } from './leadTypes';
import { fmtDate } from './leadTypes';

function when(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}

function Chip({ children, tone = 'gray', onClick, title }: { children: React.ReactNode; tone?: 'gray' | 'purple' | 'green' | 'amber'; onClick?: () => void; title?: string }) {
  const cls = {
    gray: 'bg-gray-100 text-gray-700', purple: 'bg-purple-100 text-purple-800',
    green: 'bg-green-100 text-green-800', amber: 'bg-amber-100 text-amber-800',
  }[tone];
  const base = `inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-medium ${cls}`;
  return onClick
    ? <button onClick={onClick} title={title} className={`${base} hover:ring-1 hover:ring-current`}>{children}</button>
    : <span title={title} className={base}>{children}</span>;
}

export default function RunStrip({ run, elapsed, canRun, onStop, onHistory, onShowBatch }: {
  run: LeadRun | null;
  elapsed: number;
  canRun: boolean;
  onStop: () => void;
  onHistory: () => void;
  onShowBatch: (runId: string) => void;
}) {
  if (!run) return null;
  const c = run.counts;

  if (run.status === 'running') {
    return (
      <div className="flex flex-wrap items-center gap-3 rounded-lg bg-blue-50 px-4 py-2.5 mb-4 text-sm text-blue-800">
        <span className="inline-block animate-pulse">●</span>
        <span><b>Searching…</b> {Math.floor(elapsed / 60)}m {elapsed % 60}s — runs in the background; this page updates itself.</span>
        {canRun && <button onClick={onStop} className="ml-auto text-xs text-red-700 hover:underline">■ Stop</button>}
      </div>
    );
  }

  if (run.status === 'failed') {
    return (
      <div className="flex flex-wrap items-center gap-3 rounded-lg bg-red-50 px-4 py-2.5 mb-4 text-sm text-red-800">
        <span><b>Last search failed</b> {when(run.finished_at)} — {run.error || 'unknown error'}</span>
        <button onClick={onHistory} className="ml-auto text-xs hover:underline">History →</button>
      </div>
    );
  }

  const reprocess = c?.mode === 'process_existing';
  const research = c?.research;
  const withContacts = research?.withContacts;
  return (
    <div className="rounded-lg border border-gray-200 bg-white px-4 py-2.5 mb-4 text-sm">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
        <span className="text-gray-500">
          <b className="text-gray-800">{reprocess ? 'Re-processed existing leads' : 'Last search'}</b>
          {' '}{when(run.finished_at)}{run.triggered_by_name ? ` · ${run.triggered_by_name}` : ''}
          {!reprocess && c?.window ? ` · tours starting ${fmtDate(c.window.from)} – ${fmtDate(c.window.to)}` : ''}
        </span>
        <span className="flex flex-wrap gap-1.5">
          {!reprocess && (
            <Chip tone="purple" onClick={() => onShowBatch(run.id)} title="Show the leads this search found">
              {c?.detection?.toursCreated ?? 0} new
            </Chip>
          )}
          {(c?.matching?.exact ?? 0) > 0 && <Chip tone="green" title="Matched to bands in your address book">{c?.matching?.exact} known bands</Chip>}
          {(c?.matching?.partial ?? 0) > 0 && <Chip tone="amber" title="Possible address-book matches to confirm">{c?.matching?.partial} possible matches</Chip>}
          {research && (
            <Chip title="Leads whose contacts were researched this time">
              {research.researched} researched{withContacts != null ? ` · ${withContacts} with contacts` : ''}
            </Chip>
          )}
        </span>
        <button onClick={onHistory} className="ml-auto text-xs text-[#7B5EA7] hover:underline whitespace-nowrap">Search history →</button>
      </div>
      {(research?.failed ?? 0) > 0 && research?.lastError && (
        <div className="mt-1 text-xs text-amber-700">⚠ Research errored on {research.failed} lead(s): {research.lastError}</div>
      )}
    </div>
  );
}
