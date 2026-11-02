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
 * DRAFT vs SENT (mig 262, jon Sep 2026): typing autosaves into a PRIVATE
 * draft (`self_assessment_draft`) that the reviewer never reads. Only "Submit
 * to reviewer" writes `self_assessment`, which is what they see. So somebody
 * can mull their answers over for days and send once they're happy — and
 * autosave can't hand the reviewer a half-finished sentence.
 *
 * The tab this lives on only appears when there IS a review — it is a
 * once-a-year thing and does not earn permanent space.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
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
  // Mig 262. Optional: an older backend won't send them.
  self_assessment_draft?: Answer[] | null;
  self_assessment_draft_saved_at?: string | null;
}

interface Payload { data: MyReview | null; questions: string[]; linked: boolean }

/** One action from the review — GET /staff-tasks/review/:id/mine. */
interface ActionTask {
  id: string;
  title: string;
  due_date: string | null;
  status: string;
  owner_name: string | null;
  /** Mine, rather than the manager's or the company's. */
  is_mine: boolean;
}

type SaveState = 'idle' | 'saving' | 'saved' | 'error';

const AUTOSAVE_MS = 800;

// ── Dates ────────────────────────────────────────────────────────────────────
// Date-only strings (YYYY-MM-DD) are handled as UTC calendar days so a
// timezone can't move them; "today" is the LOCAL date, never
// toISOString().slice(0,10), which is yesterday before 1am in BST.

function localToday(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function parseDay(iso: string | null | undefined): Date | null {
  if (!iso) return null;
  const [y, m, d] = iso.slice(0, 10).split('-').map(Number);
  if (!y || !m || !d) return null;
  const date = new Date(Date.UTC(y, m - 1, d));
  return Number.isNaN(date.getTime()) ? null : date;
}

function fmtDate(iso: string | null): string {
  const date = parseDay(iso);
  if (!date) return '';
  return date.toLocaleDateString('en-GB', {
    weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC',
  });
}

function fmtDay(iso: string | null, opts: Intl.DateTimeFormatOptions): string {
  const date = parseDay(iso);
  return date ? date.toLocaleDateString('en-GB', { ...opts, timeZone: 'UTC' }) : '';
}

/** A timestamp (not a date-only string), shown in the viewer's own zone. */
function fmtStamp(ts: string | null | undefined): string {
  if (!ts) return '';
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'long' });
}

function relativeDays(iso: string): string {
  const target = parseDay(iso);
  const today = parseDay(localToday());
  if (!target || !today) return '';
  const days = Math.round((target.getTime() - today.getTime()) / 86_400_000);
  if (days === 0) return 'today';
  if (days === 1) return 'tomorrow';
  if (days === -1) return 'yesterday';
  return days > 0 ? `in ${days} days` : `${-days} days ago`;
}

function reviewTitle(type: string): string {
  switch (type) {
    case 'annual': return 'Your annual review';
    case 'quarterly': return 'Your quarterly review';
    case 'probation': return 'Your probation review';
    default: return 'Your review';
  }
}

function toMap(list: Answer[] | null | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const prev of list ?? []) {
    if (prev && typeof prev.q === 'string') out[prev.q] = String(prev.a ?? '');
  }
  return out;
}

const CARD = 'bg-white border border-gray-200 rounded-xl';

export default function MyReviewPage() {
  const [payload, setPayload] = useState<Payload | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [answers, setAnswers] = useState<Record<string, string>>({});

  const [saveState, setSaveState] = useState<SaveState>('idle');
  const [saveError, setSaveError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  // Autosave plumbing. The timer and the latest answers live in refs so the
  // debounce always sends what is on screen NOW, and a slow reply for an older
  // save can't overwrite the status of a newer one (seq).
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pending = useRef<{ reviewId: string; body: { answers: Answer[] } } | null>(null);
  const seq = useRef(0);

  const load = useCallback(async () => {
    setLoadError(null);
    try {
      const res = await api.get<Payload>('/staff-calendar/me/review');
      setPayload(res);
      // Seed from whatever they have already written, keyed by question text
      // so a reworded question simply comes back blank rather than showing an
      // answer to something else. The private draft wins over what was sent:
      // it is the newer of the two (submitting clears it).
      const draft = res.data?.self_assessment_draft;
      setAnswers(toMap(draft && draft.length ? draft : res.data?.self_assessment));
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : 'Could not load your review');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const flush = useCallback(async () => {
    if (timer.current) { clearTimeout(timer.current); timer.current = null; }
    const job = pending.current;
    pending.current = null;
    if (!job) return;
    const mine = ++seq.current;
    try {
      await api.put(`/staff-calendar/me/review/${job.reviewId}/draft`, job.body);
      if (mine === seq.current) { setSaveState('saved'); setSaveError(null); }
    } catch (err) {
      if (mine === seq.current) {
        setSaveState('error');
        setSaveError(err instanceof Error ? err.message : 'Could not save your draft');
        // Keep it queued so "Try again" (or the next keystroke) resends it.
        if (!pending.current) pending.current = job;
      }
    }
  }, []);

  // Leaving the tab mid-debounce must not lose the last few words: send what
  // is queued on unmount, fire-and-forget (nothing left to show a status on).
  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
    const job = pending.current;
    if (job) void api.put(`/staff-calendar/me/review/${job.reviewId}/draft`, job.body).catch(() => {});
  }, []);

  // Closing the browser mid-save: ask first.
  useEffect(() => {
    if (saveState !== 'saving' && saveState !== 'error') return;
    const warn = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = ''; };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [saveState]);

  function onType(q: string, value: string) {
    if (!payload?.data) return;
    const next = { ...answers, [q]: value };
    setAnswers(next);
    pending.current = {
      reviewId: payload.data.id,
      body: { answers: payload.questions.map(x => ({ q: x, a: next[x] ?? '' })) },
    };
    setSaveState('saving');
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => { void flush(); }, AUTOSAVE_MS);
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!payload?.data) return;
    // The submit carries everything on screen, so a queued draft save is moot.
    if (timer.current) { clearTimeout(timer.current); timer.current = null; }
    pending.current = null;
    seq.current++;
    setSubmitting(true);
    setSubmitError(null);
    try {
      const res = await api.post<{ data: MyReview | null }>(
        `/staff-calendar/me/review/${payload.data.id}/answers`,
        { answers: payload.questions.map(q => ({ q, a: answers[q] ?? '' })) },
      );
      // Merge, don't replace, and leave `answers` alone — they may have kept
      // typing while this was in flight.
      if (res.data) setPayload(p => (p ? { ...p, data: { ...p.data!, ...res.data! } } : p));
      setSaveState('idle');
      setSaveError(null);
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : 'Could not send your answers');
    } finally {
      setSubmitting(false);
    }
  }

  if (loading) return <p className="text-sm text-gray-500">Loading…</p>;

  if (loadError) {
    return (
      <div className="max-w-[860px] rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800 flex flex-wrap items-center justify-between gap-3">
        <span>{loadError}</span>
        <button
          type="button"
          onClick={() => { setLoading(true); void load(); }}
          className="min-h-[44px] px-3 rounded-lg border border-red-200 bg-white text-sm font-medium text-red-800 hover:bg-red-100"
        >
          Try again
        </button>
      </div>
    );
  }

  const review = payload?.data;
  if (!review) {
    return (
      <div className={`${CARD} max-w-[860px] px-4 py-5 sm:px-6 sm:py-[22px]`}>
        <div className="text-[17px] font-semibold text-gray-900">My Review</div>
        <p className="text-sm text-gray-500 mt-1">
          {payload && !payload.linked
            ? 'Your login isn’t linked to a staff record, so there’s no review to show.'
            : 'Nothing booked at the moment.'}
        </p>
      </div>
    );
  }

  if (review.status === 'completed') return <AfterMeeting review={review} />;

  const questions = payload!.questions;
  const answered = questions.filter(q => (answers[q] ?? '').trim()).length;
  const pct = questions.length ? Math.round((answered / questions.length) * 100) : 0;

  const sentAt = review.self_assessment_submitted_at;
  const sentMap = toMap(review.self_assessment);
  // "Unsent" is judged against what the reviewer actually has, not against
  // whether a draft row exists — typing and then undoing is not a change.
  const unsent = !!sentAt && questions.some(q => (answers[q] ?? '') !== (sentMap[q] ?? ''));
  const allSent = !!sentAt && !unsent;

  const day = parseDay(review.scheduled_for);
  const monthTile = fmtDay(review.scheduled_for, { month: 'short' }).toUpperCase();
  const dayTile = day ? String(day.getUTCDate()) : '';
  const when = fmtDay(review.scheduled_for, { weekday: 'long', day: 'numeric', month: 'long' });
  const rel = relativeDays(review.scheduled_for);

  const buttonLabel = submitting
    ? 'Sending…'
    : !sentAt ? 'Submit to reviewer'
    : unsent ? 'Send my changes'
    : '✓ All sent';

  let draftNote: { text: string; tone: 'grey' | 'red' } | null = null;
  if (saveState === 'saving') draftNote = { text: 'Saving…', tone: 'grey' };
  else if (saveState === 'saved') draftNote = { text: 'Draft saved — only you can see it until you send.', tone: 'grey' };
  else if (saveState === 'error') {
    draftNote = {
      text: `Your draft didn’t save${saveError ? ` (${saveError})` : ''}. What you’ve typed is still here — don’t close this page yet.`,
      tone: 'red',
    };
  } else if (!sentAt) draftNote = { text: 'Answers save as you type. Only you can see them until you send.', tone: 'grey' };

  return (
    <div className="flex flex-col gap-4 max-w-[860px]">
      {/* Date card + prep progress */}
      <div className={`${CARD} px-4 py-5 sm:px-6 sm:py-[22px] flex flex-wrap items-center justify-between gap-6`}>
        <div className="flex items-center gap-[18px] min-w-0">
          <div className="w-16 flex-none rounded-[10px] border border-ooosh-200 overflow-hidden text-center" aria-hidden="true">
            <div className="bg-ooosh-600 text-white text-[11px] font-semibold tracking-[.06em] py-[3px]">{monthTile}</div>
            <div className="text-[26px] font-semibold text-gray-900 pt-1 pb-1.5 leading-tight">{dayTile}</div>
          </div>
          <div className="min-w-0">
            <div className="text-xl font-semibold text-gray-900">{reviewTitle(review.review_type)}</div>
            <div className="text-sm text-gray-500 mt-[3px]">
              {when}{rel ? ` · ${rel}` : ''}
            </div>
          </div>
        </div>
        {questions.length > 0 && (
          <div className="min-w-[220px] flex-[0_1_280px]">
            <div className="flex justify-between text-[13px] text-gray-700 mb-1.5">
              <span>Your prep</span>
              <span className="font-semibold">{answered} of {questions.length} answered</span>
            </div>
            <div
              className="h-2 rounded-full bg-ooosh-100 overflow-hidden"
              role="progressbar" aria-valuemin={0} aria-valuemax={questions.length} aria-valuenow={answered}
              aria-label="Questions answered"
            >
              <div className="h-full bg-ooosh-600 rounded-full transition-[width]" style={{ width: `${pct}%` }} />
            </div>
          </div>
        )}
      </div>

      {/* Reassurance */}
      <div className="px-4 py-4 sm:px-5 rounded-xl bg-ooosh-50 border border-ooosh-200 text-sm text-gray-800 leading-relaxed">
        Have a think about these before we meet — there are no right answers and nothing here is a
        test. Your manager is answering the same questions and you’ll compare notes.{' '}
        <strong>Pay is looked at after the conversation, not in it</strong>, so you don’t have to
        weigh up what’s safe to say.
      </div>

      <form onSubmit={submit} className="flex flex-col gap-4">
        {questions.map((q, i) => {
          const has = !!(answers[q] ?? '').trim();
          return (
            <div key={q} className={`${CARD} p-4 sm:px-5 sm:py-[18px] flex gap-3 sm:gap-4`}>
              <span
                className={`flex-none w-7 h-7 rounded-full text-[13px] font-bold flex items-center justify-center ${
                  has ? 'bg-ooosh-600 text-white' : 'bg-gray-100 text-gray-500'
                }`}
                aria-hidden="true"
              >
                {i + 1}
              </span>
              <div className="flex-1 min-w-0 flex flex-col gap-2.5">
                <label htmlFor={`q${i}`} className="text-[15px] font-semibold text-gray-900 leading-snug">
                  {q}
                </label>
                <textarea
                  id={`q${i}`}
                  rows={3}
                  value={answers[q] ?? ''}
                  onChange={e => onType(q, e.target.value)}
                  placeholder="A few lines is plenty"
                  className="w-full px-3 py-2.5 border border-gray-300 rounded-lg text-base sm:text-[15px] leading-normal resize-y focus:outline-none focus:ring-2 focus:ring-ooosh-200 focus:border-ooosh-600"
                />
              </div>
            </div>
          );
        })}

        <div className="flex flex-wrap items-center gap-x-[14px] gap-y-2">
          <button
            type="submit"
            disabled={submitting || allSent || (!sentAt && answered === 0)}
            className={`min-h-[44px] px-5 rounded-lg text-[15px] font-semibold ${
              allSent
                ? 'bg-emerald-50 text-emerald-800 border border-emerald-200 cursor-default'
                : 'bg-ooosh-600 text-white hover:bg-ooosh-700 disabled:opacity-40'
            }`}
          >
            {buttonLabel}
          </button>
          <div className="flex flex-col gap-1 min-w-0 flex-1 basis-[240px]">
            {sentAt && (
              <span className="text-[13px] text-emerald-700">
                Sent {fmtStamp(sentAt)}. You can keep changing these until we meet.
              </span>
            )}
            {unsent && (
              <span className="text-[13px] font-medium text-amber-800">
                You have changes your reviewer hasn’t seen yet.
              </span>
            )}
            {draftNote && (
              <span className={`text-[13px] ${draftNote.tone === 'red' ? 'text-red-700' : 'text-gray-500'}`} role={draftNote.tone === 'red' ? 'alert' : undefined}>
                {draftNote.text}
                {saveState === 'error' && (
                  <button
                    type="button"
                    onClick={() => { setSaveState('saving'); void flush(); }}
                    className="ml-2 underline font-medium min-h-[44px] sm:min-h-0"
                  >
                    Try again
                  </button>
                )}
              </span>
            )}
            {submitError && (
              <span className="text-[13px] text-red-700" role="alert">
                Not sent: {submitError}. Your answers are still here.
              </span>
            )}
          </div>
        </div>
      </form>
    </div>
  );
}

/**
 * After the meeting: the write-up, and what came out of it.
 *
 * Every action the review produced, whoever owns it — the company's side
 * included, because those are the ones most likely to lapse (spec §6.2) and
 * the reviewee is the person who notices. Read through the reviewee-scoped
 * GET /staff-tasks/review/:id/mine, which checks the review is theirs and
 * keeps somebody else's private action out.
 */
function AfterMeeting({ review }: { review: MyReview }) {
  const [actions, setActions] = useState<ActionTask[] | null>(null);
  const [actionsError, setActionsError] = useState(false);

  useEffect(() => {
    let live = true;
    api.get<{ data: ActionTask[] }>(`/staff-tasks/review/${review.id}/mine`)
      .then(res => { if (live) setActions(res.data ?? []); })
      .catch(() => { if (live) setActionsError(true); });
    return () => { live = false; };
  }, [review.id]);

  const nextDue = fmtDay(review.next_review_due, { month: 'long', year: 'numeric' });

  return (
    <div className="flex flex-col gap-4 max-w-[860px]">
      <div className={`${CARD} px-4 py-5 sm:px-6 sm:py-[22px] flex flex-wrap items-center justify-between gap-4`}>
        <div className="min-w-0">
          <div className="text-xl font-semibold text-gray-900">{reviewTitle(review.review_type)}</div>
          <div className="text-sm text-gray-500 mt-[3px]">
            Done on {fmtDate(review.completed_at ?? review.scheduled_for)}
          </div>
        </div>
        <span className="text-xs font-semibold px-2.5 py-1 rounded-full bg-emerald-100 text-emerald-800">
          Completed
        </span>
      </div>

      <div className={`${CARD} px-4 py-5 sm:px-6 sm:py-[22px] flex flex-col gap-3`}>
        <div className="text-[17px] font-semibold text-gray-900">What we agreed</div>
        {review.shared_summary?.trim() ? (
          <p className="text-[15px] text-gray-800 whitespace-pre-wrap leading-[1.65]">
            {review.shared_summary}
          </p>
        ) : (
          <p className="text-[15px] text-gray-400">Nothing written up yet.</p>
        )}
        {nextDue && (
          <div className="text-[13px] text-gray-500 pt-3 border-t border-gray-100">
            Next one due around {nextDue}.
          </div>
        )}
      </div>

      <div className={`${CARD} overflow-hidden`}>
        <div className="px-4 sm:px-5 py-3.5 border-b border-gray-100 flex flex-wrap items-baseline justify-between gap-3">
          <span className="text-[17px] font-semibold text-gray-900">Things to do from it</span>
          <Link
            to="/me?tab=todo"
            className="text-sm text-ooosh-600 hover:underline inline-flex items-center min-h-[44px] sm:min-h-0"
          >
            On your To Do →
          </Link>
        </div>
        {actions === null && !actionsError && (
          <p className="px-4 sm:px-5 py-3 text-sm text-gray-500">Loading…</p>
        )}
        {actionsError && (
          <p className="px-4 sm:px-5 py-3 text-sm text-red-700">
            Couldn’t load your actions just now — they’re still on your To Do.
          </p>
        )}
        {actions && actions.length === 0 && (
          <p className="px-4 sm:px-5 py-3 text-sm text-gray-500">
            Nothing on your list from this one.
          </p>
        )}
        {actions?.map(a => {
          const done = a.status !== 'open';
          const by = fmtDay(a.due_date, { day: 'numeric', month: 'short' });
          return (
            <div key={a.id} className="px-4 sm:px-5 py-3 border-b border-gray-100 last:border-b-0 flex justify-between gap-3">
              <span className={`text-sm ${done ? 'text-gray-400 line-through' : 'text-gray-900'}`}>{a.title}</span>
              <span className="text-[13px] text-gray-500 whitespace-nowrap">
                {done ? 'Done'
                  : `${a.is_mine ? 'You' : (a.owner_name?.split(' ')[0] || 'Ooosh')}${by ? ` · by ${by}` : ''}`}
              </span>
            </div>
          );
        })}
      </div>

      <p className="text-sm text-gray-600 leading-relaxed">
        If the write-up doesn’t match how you remember it, say so and it’ll be changed.
      </p>
    </div>
  );
}
