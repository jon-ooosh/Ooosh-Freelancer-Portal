import { useState, useEffect, useRef, useCallback } from 'react';
import { api } from '../services/api';

/**
 * Per-job conversation summary (Auto-Chase Phase 2, spec §7.1).
 *
 * A cached AI digest of the ingested email thread(s) on a job, shown at the top
 * of the Activity Timeline. Complements the timeline email-collapse (which HIDES
 * detail) by surfacing the gist + "whose move is it next".
 *
 * Behaviour:
 *  - Fetches the cached summary + a computed `stale`/`available` flag.
 *  - Renders nothing when Anthropic isn't configured, or there are no ingested
 *    emails to summarise (nothing to show, no noise).
 *  - Auto-generates once when emails exist but there's no summary yet, or when
 *    new mail has landed since the cache (stale). Regeneration is bounded to
 *    jobs someone actually opens.
 *  - `emailSignal` (the parent's live count of email interactions) re-checks
 *    staleness when the user logs/loads a new email without a full remount.
 */
interface SummaryData {
  headline: string | null;
  summary: string;
  emailCount: number;
  lastEmailAt: string | null;
  model: string | null;
  generatedAt: string;
}
interface StatusResponse {
  summary: SummaryData | null;
  currentEmailCount: number;
  latestEmailAt: string | null;
  available: boolean;
  stale: boolean;
  configured: boolean;
}

function timeAgo(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return '';
  const mins = Math.round((Date.now() - then) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.round(hrs / 24);
  return `${days}d ago`;
}

export default function ConversationSummary({
  jobId,
  emailSignal,
}: {
  jobId: string;
  emailSignal?: number;
}) {
  const [status, setStatus] = useState<StatusResponse | null>(null);
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState('');
  // Guard against firing auto-generation more than once per (job, signal) state.
  const autoTriedRef = useRef<string>('');

  const loadStatus = useCallback(async () => {
    try {
      const res = await api.get<{ data: StatusResponse }>(`/auto-chase/job-summary/${jobId}`);
      setStatus(res.data);
      return res.data;
    } catch {
      // Silent — a missing table pre-migration shouldn't break the timeline.
      setStatus(null);
      return null;
    }
  }, [jobId]);

  const generate = useCallback(async () => {
    setGenerating(true);
    setError('');
    try {
      await api.post(`/auto-chase/job-summary/${jobId}`, {});
      await loadStatus();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not summarise');
    } finally {
      setGenerating(false);
    }
  }, [jobId, loadStatus]);

  // (Re)load whenever the job or the parent's email count changes.
  useEffect(() => {
    loadStatus();
  }, [loadStatus, emailSignal]);

  // Auto-generate once when there's something to summarise and the cache is
  // missing or stale. Keyed on job + signal + staleness so it fires at most once
  // per meaningful state and never loops.
  useEffect(() => {
    if (!status || !status.configured || !status.available || generating) return;
    const needs = !status.summary || status.stale;
    if (!needs) return;
    const key = `${jobId}:${status.currentEmailCount}:${status.stale ? 's' : 'f'}`;
    if (autoTriedRef.current === key) return;
    autoTriedRef.current = key;
    generate();
  }, [status, generating, jobId, generate]);

  // Nothing to show: not configured, or no ingested emails on this job yet.
  if (!status || !status.configured || !status.available) return null;

  const s = status.summary;
  const showSkeleton = generating && !s;

  return (
    <div className="mb-4 rounded-xl border border-purple-200 bg-purple-50/60 p-4">
      <div className="flex items-start justify-between gap-3 mb-1.5">
        <div className="flex items-center gap-2 text-xs font-semibold text-purple-700">
          <span aria-hidden>✨</span>
          <span>Conversation summary</span>
          <span className="font-normal text-purple-400">· {status.currentEmailCount} email{status.currentEmailCount === 1 ? '' : 's'}</span>
        </div>
        {s && (
          <button
            type="button"
            onClick={generate}
            disabled={generating}
            title="Regenerate from the latest emails"
            className="text-xs text-purple-500 hover:text-purple-700 disabled:opacity-50 shrink-0"
          >
            {generating ? 'Refreshing…' : '↻ Refresh'}
          </button>
        )}
      </div>

      {showSkeleton ? (
        <div className="animate-pulse space-y-2 py-1">
          <div className="h-3 w-2/3 rounded bg-purple-200/70" />
          <div className="h-2.5 w-full rounded bg-purple-100" />
          <div className="h-2.5 w-5/6 rounded bg-purple-100" />
        </div>
      ) : s ? (
        <>
          {s.headline && <p className="text-sm font-semibold text-gray-900">{s.headline}</p>}
          <p className="mt-1 text-sm text-gray-700 whitespace-pre-line">{s.summary}</p>
          <div className="mt-2 flex items-center gap-2 text-[11px] text-purple-400">
            <span>AI digest · generated {timeAgo(s.generatedAt)}</span>
            {status.stale && <span className="text-amber-500">· new mail since — refreshing…</span>}
          </div>
        </>
      ) : (
        <p className="text-sm text-gray-500">
          {generating ? 'Summarising conversation…' : 'No summary yet.'}
        </p>
      )}

      {error && <p className="mt-2 text-xs text-red-500">{error}</p>}
    </div>
  );
}
