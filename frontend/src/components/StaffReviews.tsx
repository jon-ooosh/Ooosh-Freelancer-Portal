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
 * things the COMPANY owes are the ones that quietly lapse.
 */

import { useCallback, useEffect, useState } from 'react';
import { api } from '../services/api';

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
}

interface TaskRow {
  id: string;
  title: string;
  due_date: string | null;
  status: string;
  owner_name: string | null;
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
        scheduledFor, reviewType, status: 'confirmed',
      });
      setScheduledFor('');
      setBooking(false);
      await load();
      await onSaved(`Review booked for ${personName}.`);
    } catch (err) {
      onError(err instanceof Error ? err.message : 'Failed to book the review');
    } finally {
      setSaving(false);
    }
  }

  const upcoming = reviews.filter(r => r.status === 'proposed' || r.status === 'confirmed');
  const past = reviews.filter(r => r.status === 'completed' || r.status === 'cancelled');

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
          <button onClick={() => void book()} disabled={!scheduledFor || saving}
            className="px-3 py-1.5 text-sm rounded bg-ooosh-600 text-white hover:bg-ooosh-700 disabled:opacity-40">
            {saving ? 'Saving…' : 'Book'}
          </button>
          <button onClick={() => setBooking(false)} className="text-sm text-gray-500 hover:text-gray-700">
            Cancel
          </button>
        </div>
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

  const loadTasks = useCallback(async () => {
    try {
      const res = await api.get<{ data: TaskRow[] }>(
        `/staff-tasks/person/${personId}?includeDone=true`);
      setTasks(res.data);
    } catch { /* the actions list is a nicety; the review itself still works */ }
  }, [personId]);

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
        {done && review.next_review_due && (
          <span className="text-xs text-gray-400">next due {fmtDate(review.next_review_due)}</span>
        )}
        <span className="ml-auto text-gray-400 text-sm">{open ? '▲' : '▼'}</span>
      </button>

      {open && (
        <div className="border-t border-gray-100 p-3 space-y-3">
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
            {tasks.filter(t => t.status === 'open').length === 0 ? (
              <p className="text-xs text-gray-400 mb-2">Nothing outstanding.</p>
            ) : (
              <ul className="text-sm text-gray-700 mb-2 space-y-0.5">
                {tasks.filter(t => t.status === 'open').map(t => (
                  <li key={t.id} className="flex gap-2">
                    <span>•</span>
                    <span>{t.title}</span>
                    {t.due_date && <span className="text-xs text-gray-400">by {fmtDate(t.due_date)}</span>}
                  </li>
                ))}
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
                it writes the salary record and gives you the figure for the follow-up.
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
          </div>
        </div>
      )}
    </div>
  );
}
