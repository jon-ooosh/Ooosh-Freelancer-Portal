/**
 * My Review — the reviewee's side. docs/STAFF-RECORDS-SPEC.md §5.3, §5.5.
 *
 * Two states, one page:
 *   before — the prep questions, answerable until the meeting happens
 *   after  — the agreed write-up, so it stays readable rather than living
 *            only in an email
 *
 * WHAT IS DELIBERATELY NOT HERE: the reviewer's private notes and their own
 * prep answers. "Shared summary" is the half written knowing it would be read;
 * a field that is sometimes shared is a leak, and one that MIGHT be read gets
 * self-censored into uselessness (§5.4). The endpoint behind this page selects
 * column by column for the same reason.
 *
 * The tab this lives on only appears when there IS a review — it is a
 * once-a-year thing and does not earn permanent space.
 */

import { useCallback, useEffect, useState } from 'react';
import { api } from '../services/api';

interface Answer { q: string; a: string }

interface MyReview {
  id: string;
  review_type: string;
  scheduled_for: string;
  status: 'proposed' | 'confirmed' | 'completed' | 'cancelled';
  completed_at: string | null;
  shared_summary: string | null;
  outcome: string | null;
  next_review_due: string | null;
  self_assessment: Answer[] | null;
  self_assessment_submitted_at: string | null;
}

interface Payload { data: MyReview | null; questions: string[]; linked: boolean }

function fmtDate(iso: string | null): string {
  if (!iso) return '';
  const [y, m, d] = iso.slice(0, 10).split('-').map(Number);
  return new Date(Date.UTC(y!, m! - 1, d!)).toLocaleDateString('en-GB', {
    weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC',
  });
}

export default function MyReviewPage() {
  const [payload, setPayload] = useState<Payload | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  const load = useCallback(async () => {
    setLoadError(null);
    try {
      const res = await api.get<Payload>('/staff-calendar/me/review');
      setPayload(res);
      // Seed from whatever they have already written, keyed by question text
      // so a reworded question simply comes back blank rather than showing an
      // answer to something else.
      const seed: Record<string, string> = {};
      for (const prev of res.data?.self_assessment ?? []) seed[prev.q] = prev.a;
      setAnswers(seed);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : 'Could not load your review');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!payload?.data) return;
    setSaving(true);
    setSaved(false);
    try {
      await api.post(`/staff-calendar/me/review/${payload.data.id}/answers`, {
        answers: payload.questions.map(q => ({ q, a: answers[q] ?? '' })),
      });
      setSaved(true);
      await load();
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : 'Could not save your answers');
    } finally {
      setSaving(false);
    }
  }

  if (loading) return <p className="text-sm text-gray-500">Loading…</p>;

  if (loadError) {
    return (
      <div className="rounded border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">
        {loadError}
      </div>
    );
  }

  const review = payload?.data;
  if (!review) {
    return (
      <div className="space-y-2">
        <h1 className="text-xl font-semibold text-gray-900">My Review</h1>
        <p className="text-sm text-gray-500">Nothing booked at the moment.</p>
      </div>
    );
  }

  const done = review.status === 'completed';

  return (
    <div className="space-y-6 max-w-3xl">
      <div>
        <h1 className="text-xl font-semibold text-gray-900">My Review</h1>
        <p className="text-sm text-gray-600 mt-1">
          {done
            ? `Completed ${fmtDate(review.completed_at)}`
            : fmtDate(review.scheduled_for)}
        </p>
      </div>

      {done ? (
        <>
          <div className="bg-white rounded-lg border border-gray-200 p-5">
            <h2 className="text-sm font-semibold text-gray-900 mb-2">What we agreed</h2>
            {review.shared_summary?.trim() ? (
              <p className="text-sm text-gray-800 whitespace-pre-wrap leading-relaxed">
                {review.shared_summary}
              </p>
            ) : (
              <p className="text-sm text-gray-400">Nothing written up yet.</p>
            )}
            {review.next_review_due && (
              <p className="text-xs text-gray-500 mt-4">
                Next one due around {fmtDate(review.next_review_due)}.
              </p>
            )}
          </div>
          <p className="text-sm text-gray-600">
            Anything you agreed to do is on your <strong>My To Do</strong> list. If the write-up
            doesn’t match how you remember it, say so and it’ll be changed.
          </p>
        </>
      ) : (
        <>
          <div className="rounded-lg border border-ooosh-200 bg-ooosh-50 px-4 py-3">
            <p className="text-sm text-gray-800">
              Have a think about these before we meet — there are no right answers and nothing here
              is a test. I’m answering the same questions, and we’ll compare notes.
            </p>
            <p className="text-xs text-gray-600 mt-2">
              Pay is looked at <strong>after</strong> the conversation, not in it, so you don’t have
              to weigh up what’s safe to say.
            </p>
          </div>

          <form onSubmit={submit} className="space-y-5">
            {payload!.questions.map((q, i) => (
              <div key={q} className="bg-white rounded-lg border border-gray-200 p-4">
                <label htmlFor={`q${i}`} className="block text-sm font-medium text-gray-900 mb-2">
                  {q}
                </label>
                <textarea
                  id={`q${i}`}
                  rows={3}
                  value={answers[q] ?? ''}
                  onChange={e => setAnswers(a => ({ ...a, [q]: e.target.value }))}
                  className="w-full px-3 py-2 border border-gray-300 rounded text-sm"
                />
              </div>
            ))}

            <div className="flex items-center gap-3">
              <button
                type="submit"
                disabled={saving}
                className="px-4 py-2 text-sm rounded bg-ooosh-600 text-white hover:bg-ooosh-700 disabled:opacity-40"
              >
                {saving ? 'Saving…' : review.self_assessment_submitted_at ? 'Update my answers' : 'Send my answers'}
              </button>
              {saved && <span className="text-sm text-emerald-700">Saved.</span>}
              {review.self_assessment_submitted_at && !saved && (
                <span className="text-xs text-gray-500">
                  You can keep changing these until we meet.
                </span>
              )}
            </div>
          </form>
        </>
      )}
    </div>
  );
}
