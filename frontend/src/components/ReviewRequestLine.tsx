/**
 * One line on the job page about Jon's review request email
 * (docs/BUSINESS-FIGURES-SPEC.md §8c): before it goes, a "send" tick staff can
 * untick ("don't send"); after, what happened — sent to whom, or why not.
 * Backend: routes/review-requests.ts.
 */
import { useEffect, useState } from 'react';
import { api } from '../services/api';

interface ReviewState {
  status: 'pending' | 'skipped' | 'sent' | 'not_sent';
  reason: string | null;
  sentTo: string | null;
  sentAt: string | null;
}

/** Booked onwards — an enquiry never gets the email, so there's nothing to tick yet. */
const SHOWN_FROM = ['confirmed', 'prepped', 'dispatched', 'returned_incomplete', 'returned', 'completed'];

const RULES = "Sent the day after the job is Completed — not if it's completed more than 10 days after the return, "
  + 'if this client was asked in the last year, or if they asked not to be asked again. Replies go to Jon.';

function shortDate(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'Europe/London' });
}

export default function ReviewRequestLine({ jobId, pipelineStatus, isInternal }: { jobId: string; pipelineStatus: string; isInternal: boolean }) {
  const [state, setState] = useState<ReviewState | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const shown = !isInternal && SHOWN_FROM.includes(pipelineStatus);

  useEffect(() => {
    if (!shown) return;
    let live = true;
    api.get<{ data: ReviewState }>(`/review-requests/job/${jobId}`)
      .then((r) => { if (live) setState(r.data); })
      .catch(() => { /* the line just doesn't show */ });
    return () => { live = false; };
  }, [jobId, pipelineStatus, shown]);

  if (!shown || !state) return null;

  const setSkip = async (skip: boolean) => {
    setSaving(true);
    setError(null);
    try {
      const r = await api.put<{ data: ReviewState }>(`/review-requests/job/${jobId}/skip`, { skip });
      setState(r.data);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="mt-2 text-xs text-gray-500" title={RULES}>
      {(state.status === 'pending' || state.status === 'skipped') && (
        <label className="inline-flex items-center gap-1.5 cursor-pointer">
          <input
            type="checkbox"
            checked={state.status === 'pending'}
            disabled={saving}
            onChange={(e) => setSkip(!e.target.checked)}
          />
          {state.status === 'pending'
            ? <span>Send Jon's review email the day after this is completed</span>
            : <span>Jon's review email: <strong className="font-medium text-gray-700">not sending</strong> (ticked "don't send")</span>}
        </label>
      )}
      {state.status === 'sent' && (
        <span>✓ Jon's review email sent{state.sentTo ? ` to ${state.sentTo}` : ''}{state.sentAt ? ` on ${shortDate(state.sentAt)}` : ''}</span>
      )}
      {state.status === 'not_sent' && (
        <span>Jon's review email not sent — {state.reason || 'no reason recorded'}</span>
      )}
      {error && <span className="ml-2 text-red-600">{error}</span>}
    </div>
  );
}
