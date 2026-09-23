/**
 * Staff reviews — the admin surface. docs/STAFF-RECORDS-SPEC.md §5.
 *
 * Three things this page is shaped by, all of them decisions rather than
 * layout choices:
 *
 * 1. PAY IS NOT DECIDED IN THE ROOM (§5.1). The salary box lives in the
 *    COMPLETE step, not on the review form, and the help text says the figure
 *    goes to them in the follow-up. If somebody knows their pay is being set
 *    in that hour, every honest answer to "what isn't going well" costs them
 *    money, and the development conversation does not happen.
 *
 * 2. TWO NOTES FIELDS, NEVER ONE (§5.4). "Shared summary" is what they see;
 *    "private notes" is not. Labelled unmistakably, because a field that is
 *    sometimes shared is a leak — and one that MIGHT be read gets self-
 *    censored into uselessness.
 *
 * 3. SCHEDULING IS A CONFIRMATION, NOT A BOOKING SYSTEM (§5.2). Seven people
 *    once a year is a conversation; agree the date however you like and record
 *    it here. There is deliberately no propose/counter flow.
 *
 * Actions agreed at a review become `staff_tasks` rows (§6) so they land on
 * the owner's own My To Do — including jon's, which is the whole point: the
 * things the COMPANY owes are the ones that quietly lapse. Each is LINKED to
 * its review (reviewId → source_type 'staff_review'), which is what puts it in
 * the follow-up email, the "From your review" badge and the check-in below.
 *
 * THE CHECK-IN (§5.6, §22): half-way to the next review, "Since last review"
 * lists every action from the last completed one, whoever owns it, and asks
 * whether they happened. Ticking it off clears the Needs attention row.
 */

import { useCallback, useEffect, useState } from 'react';
import { api } from '../services/api';

interface Answer { q: string; a: string }

interface Review {
  id: string;
  review_type: string;
  scheduled_for: string;
  status: 'proposed' | 'confirmed' | 'completed' | 'cancelled';
  completed_at: string | null;
  shared_summary: string | null;
  private_notes: string | null;
  outcome: string | null;
  next_review_due: string | null;
  salary_history_id: string | null;
  self_assessment: Answer[] | null;
  self_assessment_submitted_at: string | null;
  invited_at: string | null;
  follow_up_sent_at: string | null;
  checkin_done_at: string | null;
}

interface TaskRow {
  id: string;
  title: string;
  due_date: string | null;
  status: string;
  owner_name: string | null;
}

/** A review's actions, whoever owns them. Cancelled ones are left out. */
async function fetchReviewActions(reviewId: string): Promise<TaskRow[]> {
  const res = await api.get<{ data: TaskRow[] }>(`/staff-tasks/review/${reviewId}`);
  return res.data.filter(t => t.status !== 'cancelled');
}

/** One action line: what, who, by when, and whether it happened. */
function ActionLine({ task }: { task: TaskRow }) {
  const done = task.status === 'done';
  return (
    <li className="flex flex-wrap gap-x-2">
      <span className={done ? 'text-emerald-600' : 'text-gray-400'}>{done ? '✓' : '•'}</span>
      <span className={done ? 'text-gray-500 line-through' : ''}>{task.title}</span>
      {task.owner_name && <span className="text-xs text-gray-500">— {task.owner_name}</span>}
      {task.due_date && <span className="text-xs text-gray-400">by {fmtDate(task.due_date)}</span>}
    </li>
  );
}

export interface ReviewPerson { personId: string; name: string }

const TYPES = [
  { value: 'annual', label: 'Annual' },
  { value: 'quarterly', label: 'Quarterly' },
  { value: 'probation', label: 'Probation' },
  { value: 'ad_hoc', label: 'Ad hoc' },
];

const STATUS_STYLE: Record<string, string> = {
  proposed: 'bg-amber-100 text-amber-800',
  confirmed: 'bg-blue-100 text-blue-800',
  completed: 'bg-emerald-100 text-emerald-800',
  cancelled: 'bg-gray-200 text-gray-600',
};

function fmtDate(iso: string | null): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
}

export default function StaffReviews({ personId, personName, people, onSaved, onError }: {
  personId: string;
  personName: string;
  /** For the action owner picker — an action is often owed BY the company. */
  people: ReviewPerson[];
  onSaved: (msg: string) => Promise<void>;
  onError: (msg: string) => void;
}) {
  const [reviews, setReviews] = useState<Review[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const [booking, setBooking] = useState(false);
  const [scheduledFor, setScheduledFor] = useState('');
  const [reviewType, setReviewType] = useState('annual');
  // Recording one that already happened, so years of past reviews can be typed
  // in. It skips straight to completed and sends nobody anything — the invite
  // and the write-up are for reviews that are actually about to happen.
  const [backdating, setBackdating] = useState(false);

  const [openId, setOpenId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoadError(null);
    try {
      const res = await api.get<{ data: Review[] }>(`/staff-calendar/employees/${personId}/reviews`);
      setReviews(res.data);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : 'Could not load reviews');
    } finally {
      setLoading(false);
    }
  }, [personId]);

  useEffect(() => { void load(); }, [load]);

  async function book() {
    if (!scheduledFor) return;
    setSaving(true);
    try {
      await api.post(`/staff-calendar/employees/${personId}/reviews`, {
        scheduledFor, reviewType,
        status: backdating ? 'completed' : 'confirmed',
        // A past review is recorded as already done. Marking it completed on
        // creation also means no invite goes out for a meeting that happened
        // in 2023.
        ...(backdating ? { completedAt: new Date(scheduledFor).toISOString() } : {}),
      });
      setScheduledFor('');
      setBooking(false);
      await load();
      await onSaved(backdating
        ? `Past review recorded for ${personName}.`
        : `Review booked for ${personName}.`);
      setBackdating(false);
    } catch (err) {
      onError(err instanceof Error ? err.message : 'Failed to book the review');
    } finally {
      setSaving(false);
    }
  }

  const upcoming = reviews.filter(r => r.status === 'proposed' || r.status === 'confirmed');
  const past = reviews.filter(r => r.status === 'completed' || r.status === 'cancelled');
  // Newest completed review — what a check-in follows up. Sorted here rather
  // than trusting the list order, which is by scheduled date.
  const lastDone = reviews
    .filter(r => r.status === 'completed')
    .sort((a, b) => (b.completed_at ?? b.scheduled_for).localeCompare(a.completed_at ?? a.scheduled_for))[0];

  return (
    <div>
      <div className="flex items-center justify-between mb-1">
        <h3 className="text-sm font-medium text-gray-900">Reviews</h3>
        {!booking && (
          <button onClick={() => setBooking(true)} className="text-xs text-ooosh-600 hover:underline">
            Book one
          </button>
        )}
      </div>
      <p className="text-xs text-gray-500 mb-3">
        Agree a date with {personName.split(' ')[0]} however you like, then record it here.
        Pay is settled after the meeting, not in it.
      </p>

      {loadError && (
        <p className="text-sm text-red-700 rounded border border-red-200 bg-red-50 px-3 py-2 mb-3">
          {loadError}
        </p>
      )}

      {booking && (
        <div className="flex flex-wrap items-end gap-3 mb-3 p-3 rounded bg-gray-50 border border-gray-200">
          <label className="text-sm">
            <span className="block text-xs text-gray-600 mb-1">Date agreed</span>
            <input type="date" value={scheduledFor} onChange={e => setScheduledFor(e.target.value)}
              className="px-2 py-1.5 border border-gray-300 rounded text-sm bg-white" />
          </label>
          <label className="text-sm">
            <span className="block text-xs text-gray-600 mb-1">Type</span>
            <select value={reviewType} onChange={e => setReviewType(e.target.value)}
              className="px-2 py-1.5 border border-gray-300 rounded text-sm bg-white">
              {TYPES.map(t => <option key={t.value} value={t.value}>{t.label}</option>)}
            </select>
          </label>
          <label className="text-sm inline-flex items-center gap-1.5 text-gray-700">
            <input type="checkbox" checked={backdating} onChange={e => setBackdating(e.target.checked)}
              className="w-3.5 h-3.5 rounded border-gray-300" />
            Already happened
          </label>
          <button onClick={() => void book()} disabled={!scheduledFor || saving}
            className="px-3 py-1.5 text-sm rounded bg-ooosh-600 text-white hover:bg-ooosh-700 disabled:opacity-40">
            {saving ? 'Saving…' : backdating ? 'Record it' : 'Book'}
          </button>
          <button onClick={() => setBooking(false)} className="text-sm text-gray-500 hover:text-gray-700">
            Cancel
          </button>
        </div>
      )}

      {!loading && lastDone && upcoming.length === 0 && (
        <SinceLastReview
          review={lastDone}
          personId={personId}
          personName={personName}
          onChanged={async (msg) => { await load(); await onSaved(msg); }}
          onError={onError}
        />
      )}

      {loading ? (
        <p className="text-sm text-gray-500">Loading…</p>
      ) : reviews.length === 0 ? (
        <p className="text-sm text-gray-400">No reviews recorded yet.</p>
      ) : (
        <div className="space-y-2">
          {[...upcoming, ...past].map(r => (
            <ReviewRow
              key={r.id}
              review={r}
              personId={personId}
              personName={personName}
              people={people}
              open={openId === r.id}
              onToggle={() => setOpenId(openId === r.id ? null : r.id)}
              onChanged={async (msg) => { await load(); await onSaved(msg); }}
              onError={onError}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function ReviewRow({ review, personId, personName, people, open, onToggle, onChanged, onError }: {
  review: Review; personId: string; personName: string; people: ReviewPerson[];
  open: boolean; onToggle: () => void;
  onChanged: (msg: string) => Promise<void>; onError: (msg: string) => void;
}) {
  const done = review.status === 'completed';
  const [shared, setShared] = useState(review.shared_summary ?? '');
  const [priv, setPriv] = useState(review.private_notes ?? '');
  const [newSalary, setNewSalary] = useState('');
  const [salaryFrom, setSalaryFrom] = useState('');
  const [saving, setSaving] = useState(false);
  const [tasks, setTasks] = useState<TaskRow[]>([]);
  const [actionTitle, setActionTitle] = useState('');
  const [actionOwner, setActionOwner] = useState(personId);
  const [actionDue, setActionDue] = useState('');

  // THIS review's actions, whoever owns them. It used to read the reviewee's
  // whole to-do list, which showed unrelated tasks and hid every action owed
  // by somebody else — the company's own, which §6.2 says matter most.
  const loadTasks = useCallback(async () => {
    try {
      setTasks(await fetchReviewActions(review.id));
    } catch { /* the actions list is a nicety; the review itself still works */ }
  }, [review.id]);

  useEffect(() => { if (open) void loadTasks(); }, [open, loadTasks]);

  async function save() {
    setSaving(true);
    try {
      await api.post(`/staff-calendar/employees/${personId}/reviews`, {
        id: review.id,
        scheduledFor: review.scheduled_for,
        sharedSummary: shared,
        privateNotes: priv,
      });
      await onChanged('Review saved.');
    } catch (err) {
      onError(err instanceof Error ? err.message : 'Failed to save');
    } finally { setSaving(false); }
  }

  async function cancel() {
    if (!window.confirm('Call this review off? It stays on the record as cancelled.')) return;
    setSaving(true);
    try {
      await api.post(`/staff-calendar/employees/${personId}/reviews`, {
        id: review.id,
        scheduledFor: review.scheduled_for,
        status: 'cancelled',
      });
      await onChanged('Review cancelled.');
    } catch (err) {
      onError(err instanceof Error ? err.message : 'Failed to cancel');
    } finally { setSaving(false); }
  }

  async function complete() {
    setSaving(true);
    try {
      await api.post(`/staff-calendar/employees/${personId}/reviews/${review.id}/complete`, {
        sharedSummary: shared,
        privateNotes: priv,
        newSalary: newSalary.trim() ? Number(newSalary) : null,
        salaryEffectiveFrom: salaryFrom || null,
      });
      await onChanged(`Review completed for ${personName}.`);
    } catch (err) {
      onError(err instanceof Error ? err.message : 'Failed to complete the review');
    } finally { setSaving(false); }
  }

  async function addAction() {
    if (!actionTitle.trim()) return;
    setSaving(true);
    try {
      // personId here is the OWNER, not the reviewee — an action the company
      // owes goes on whoever is responsible, which is the §6.2 mechanism.
      await api.post('/staff-tasks', {
        title: actionTitle.trim(),
        personId: actionOwner,
        dueDate: actionDue || null,
        reviewId: review.id,
      });
      setActionTitle('');
      setActionDue('');
      await loadTasks();
    } catch (err) {
      onError(err instanceof Error ? err.message : 'Failed to add the action');
    } finally { setSaving(false); }
  }

  return (
    <div className="rounded border border-gray-200">
      <button onClick={onToggle} className="w-full flex items-center gap-2 px-3 py-2 text-left hover:bg-gray-50">
        <span className={`text-[11px] px-1.5 py-0.5 rounded ${STATUS_STYLE[review.status]}`}>
          {review.status}
        </span>
        <span className="text-sm text-gray-900">{fmtDate(review.scheduled_for)}</span>
        <span className="text-xs text-gray-500">
          {TYPES.find(t => t.value === review.review_type)?.label ?? review.review_type}
        </span>
        {review.salary_history_id && (
          <span className="text-[11px] px-1.5 py-0.5 rounded bg-emerald-50 text-emerald-700">
            pay change
          </span>
        )}
        {!done && review.self_assessment_submitted_at && (
          <span className="text-[11px] px-1.5 py-0.5 rounded bg-emerald-50 text-emerald-700">
            they’ve answered
          </span>
        )}
        {!done && !review.invited_at && (
          <span className="text-[11px] px-1.5 py-0.5 rounded bg-amber-50 text-amber-700">
            not told yet
          </span>
        )}
        {done && review.follow_up_sent_at && (
          <span className="text-[11px] px-1.5 py-0.5 rounded bg-emerald-50 text-emerald-700">
            write-up sent
          </span>
        )}
        {done && review.next_review_due && (
          <span className="text-xs text-gray-400">next due {fmtDate(review.next_review_due)}</span>
        )}
        <span className="ml-auto text-gray-400 text-sm">{open ? '▲' : '▼'}</span>
      </button>

      {open && (
        <div className="border-t border-gray-100 p-3 space-y-3">
          {review.self_assessment && review.self_assessment.length > 0 && (
            <div className="rounded border border-ooosh-200 bg-ooosh-50 p-3">
              <h4 className="text-xs font-semibold text-gray-900 mb-2">
                What {personName.split(' ')[0]} wrote beforehand
                {review.self_assessment_submitted_at && (
                  <span className="ml-2 font-normal text-gray-500">
                    {fmtDate(review.self_assessment_submitted_at)}
                  </span>
                )}
              </h4>
              <dl className="space-y-2">
                {review.self_assessment.filter(x => x.a?.trim()).map((x, i) => (
                  <div key={i}>
                    <dt className="text-xs text-gray-600">{x.q}</dt>
                    <dd className="text-sm text-gray-900 whitespace-pre-wrap mt-0.5">{x.a}</dd>
                  </div>
                ))}
              </dl>
              <p className="text-[11px] text-gray-500 mt-2">
                Read this before the meeting — comparing two sets of answers is the point of
                asking in advance.
              </p>
            </div>
          )}

          {!done && !review.self_assessment_submitted_at && (
            <p className="text-xs text-gray-500">
              {personName.split(' ')[0]} hasn’t sent their answers yet.
              {review.invited_at ? ' They were told when it was booked.' : ' They have not been told about this review.'}
            </p>
          )}

          <label className="block text-sm">
            <span className="block text-xs text-gray-600 mb-1">
              Shared summary — <strong>{personName.split(' ')[0]} sees this</strong>
            </span>
            <textarea value={shared} onChange={e => setShared(e.target.value)} rows={4}
              placeholder="What you agreed, in the words you'd put in the follow-up email."
              className="w-full px-2 py-1.5 border border-gray-300 rounded text-sm" />
          </label>

          <label className="block text-sm">
            <span className="block text-xs text-gray-600 mb-1">
              Private notes — <strong>admin only</strong>, never shown to them
            </span>
            <textarea value={priv} onChange={e => setPriv(e.target.value)} rows={3}
              placeholder="Your own observations, concerns not yet raised, pay reasoning."
              className="w-full px-2 py-1.5 border border-gray-300 rounded text-sm bg-gray-50" />
          </label>

          {/* Actions — the highest-value part of the whole module (§6). */}
          <div>
            <span className="block text-xs text-gray-600 mb-1">
              Actions — these land on the owner’s My To Do
            </span>
            {tasks.length === 0 ? (
              <p className="text-xs text-gray-400 mb-2">No actions from this review yet.</p>
            ) : (
              <ul className="text-sm text-gray-700 mb-2 space-y-0.5">
                {tasks.map(t => <ActionLine key={t.id} task={t} />)}
              </ul>
            )}
            <div className="flex flex-wrap items-end gap-2">
              <input value={actionTitle} onChange={e => setActionTitle(e.target.value)}
                placeholder="e.g. Book the first-aid refresher"
                className="flex-1 min-w-[14rem] px-2 py-1.5 border border-gray-300 rounded text-sm" />
              <select value={actionOwner} onChange={e => setActionOwner(e.target.value)}
                className="px-2 py-1.5 border border-gray-300 rounded text-sm bg-white"
                aria-label="Who owns this action">
                {people.map(p => (
                  <option key={p.personId} value={p.personId}>
                    {p.personId === personId ? `${p.name} (them)` : p.name}
                  </option>
                ))}
              </select>
              <input type="date" value={actionDue} onChange={e => setActionDue(e.target.value)}
                className="px-2 py-1.5 border border-gray-300 rounded text-sm" />
              <button onClick={() => void addAction()} disabled={!actionTitle.trim() || saving}
                className="px-3 py-1.5 text-sm rounded border border-gray-300 hover:bg-gray-50 disabled:opacity-40">
                Add action
              </button>
            </div>
          </div>

          {!done && (
            <div className="rounded bg-gray-50 border border-gray-200 p-3">
              <p className="text-xs text-gray-600 mb-2">
                <strong>Pay is settled after the meeting.</strong> Fill this in when you’ve decided —
                marking the review complete writes the salary record and emails
                {' '}{personName.split(' ')[0]} the write-up: the shared summary, the agreed actions
                and this figure.
              </p>
              <div className="flex flex-wrap items-end gap-3">
                <label className="text-sm">
                  <span className="block text-xs text-gray-600 mb-1">New salary (optional)</span>
                  <input value={newSalary} onChange={e => setNewSalary(e.target.value.replace(/[^\d.]/g, ''))}
                    inputMode="decimal" placeholder="32000"
                    className="w-32 px-2 py-1.5 border border-gray-300 rounded text-sm bg-white" />
                </label>
                <label className="text-sm">
                  <span className="block text-xs text-gray-600 mb-1">Effective from</span>
                  <input type="date" value={salaryFrom} onChange={e => setSalaryFrom(e.target.value)}
                    className="px-2 py-1.5 border border-gray-300 rounded text-sm bg-white" />
                </label>
              </div>
            </div>
          )}

          <div className="flex items-center gap-3">
            <button onClick={() => void save()} disabled={saving}
              className="px-3 py-1.5 text-sm rounded border border-gray-300 hover:bg-gray-50 disabled:opacity-40">
              {saving ? 'Saving…' : 'Save notes'}
            </button>
            {!done && (
              <button onClick={() => void complete()} disabled={saving}
                className="px-3 py-1.5 text-sm rounded bg-ooosh-600 text-white hover:bg-ooosh-700 disabled:opacity-40">
                Mark complete
              </button>
            )}
            {done && review.completed_at && (
              <span className="text-xs text-gray-500">
                Completed {fmtDate(review.completed_at)}
              </span>
            )}
            {!done && review.status !== 'cancelled' && (
              <button onClick={() => void cancel()} disabled={saving}
                className="ml-auto text-xs text-red-600 hover:text-red-800 disabled:opacity-40">
                Call it off
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * "Since last review" — the check-in agenda (spec §5.6, §22). Shown only when
 * nothing is booked: once the next review is in the diary, that is where the
 * conversation happens.
 */
function SinceLastReview({ review, personId, personName, onChanged, onError }: {
  review: Review; personId: string; personName: string;
  onChanged: (msg: string) => Promise<void>; onError: (msg: string) => void;
}) {
  const [tasks, setTasks] = useState<TaskRow[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let live = true;
    fetchReviewActions(review.id)
      .then(t => { if (live) setTasks(t); })
      .catch(() => { if (live) setFailed(true); });
    return () => { live = false; };
  }, [review.id]);

  async function markDone() {
    setSaving(true);
    try {
      await api.post(`/staff-calendar/employees/${personId}/reviews/${review.id}/checkin`, {});
      await onChanged(`Check-in recorded for ${personName}.`);
    } catch (err) {
      onError(err instanceof Error ? err.message : 'Failed to record the check-in');
    } finally { setSaving(false); }
  }

  const open = tasks?.filter(t => t.status === 'open').length ?? 0;

  return (
    <div className="rounded border border-ooosh-200 bg-ooosh-50 p-3 mb-3">
      <div className="flex flex-wrap items-center gap-2 mb-2">
        <h4 className="text-xs font-semibold text-gray-900">
          Since last review ({fmtDate(review.completed_at ?? review.scheduled_for)})
        </h4>
        {tasks && (
          <span className="text-xs text-gray-500">
            {tasks.length === 0 ? 'no actions agreed' : `${open} of ${tasks.length} still open`}
          </span>
        )}
        <span className="ml-auto">
          {review.checkin_done_at ? (
            <span className="text-xs text-emerald-700">Checked in {fmtDate(review.checkin_done_at)}</span>
          ) : (
            <button onClick={() => void markDone()} disabled={saving}
              className="px-2 py-1 text-xs rounded border border-gray-300 bg-white hover:bg-gray-50 disabled:opacity-40">
              {saving ? 'Saving…' : 'Check-in done'}
            </button>
          )}
        </span>
      </div>
      {failed ? (
        <p className="text-xs text-red-700">Couldn’t load the actions from that review.</p>
      ) : tasks === null ? (
        <p className="text-xs text-gray-500">Loading…</p>
      ) : tasks.length > 0 ? (
        <ul className="text-sm text-gray-700 space-y-0.5">
          {tasks.map(t => <ActionLine key={t.id} task={t} />)}
        </ul>
      ) : null}
      <p className="text-[11px] text-gray-500 mt-2">
        Half-way to the next review, go through these with {personName.split(' ')[0]} — including
        the ones you owe. Ticking it off clears the “Check-in due” prompt.
      </p>
    </div>
  );
}
