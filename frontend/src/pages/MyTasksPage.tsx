/**
 * My To Do — the things that need doing, on the person who owns them.
 *
 * docs/STAFF-RECORDS-SPEC.md §6. A fourth tab on the Me page beside My Time,
 * Documents and Profile.
 *
 * Phase 3 ships the manual source. Phase 4 adds tasks created by a staff
 * review, which arrive here with source_type 'staff_review' and need no change
 * to this page — the badge on a task says where it came from.
 *
 * The point worth not losing (§6.2): an action the COMPANY owes somebody lands
 * on the responsible person's own list, beside their own work. That is what
 * stops "we'll sort your training" quietly evaporating between reviews.
 *
 * TO DO PHASE 1 (docs/TASKS-SPEC.md §4–§5): three VIEWS of the same rows —
 * Mine, Assigned by me, Everyone — in `?view=` so a bell can deep-link. Anyone
 * can give anyone a task; the owner can hand it back; whoever set it keeps
 * their own follow-up date. Private tasks never reach the Everyone view for
 * anybody but their owner, their setter and admins (enforced server-side).
 */

import { useCallback, useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api } from '../services/api';

interface Task {
  id: string;
  title: string;
  detail: string | null;
  due_date: string | null;
  next_chase_date: string | null;
  status: 'open' | 'done' | 'cancelled';
  source_type: string;
  source_id: string | null;
  created_at: string;
  completed_at: string | null;
  person_id: string;
  owner_name: string | null;
  created_by: string | null;
  is_private: boolean;
  follow_up_on: string | null;
  set_by_person_id: string | null;
  set_by_name: string | null;
  handed_back_reason: string | null;
  handed_back_by_name: string | null;
}

/** Somebody a task can be given to — GET /staff-tasks/people. */
interface Person { person_id: string; name: string | null }

/** Set by somebody other than its owner — i.e. given to them. */
function setBySomeoneElse(t: Task): boolean {
  return !!t.set_by_person_id && t.set_by_person_id !== t.person_id;
}

const VIEWS = [
  { id: 'mine', label: 'Mine' },
  { id: 'assigned', label: 'Assigned by me' },
  { id: 'everyone', label: 'Everyone' },
] as const;
type ViewId = (typeof VIEWS)[number]['id'];

/**
 * The To Do tab: a header, the three views, and the people list they share.
 * The views mount rather than route, like the Me page's own tabs.
 */
export default function ToDoPage() {
  const [params, setParams] = useSearchParams();
  const raw = params.get('view');
  const view: ViewId = VIEWS.some(v => v.id === raw) ? (raw as ViewId) : 'mine';
  const [people, setPeople] = useState<Person[]>([]);

  useEffect(() => {
    // Only the "For" picker needs it; failing leaves "Me" as the one choice.
    api.get<{ data: Person[] }>('/staff-tasks/people')
      .then(res => setPeople(res.data))
      .catch(() => undefined);
  }, []);

  function select(v: ViewId) {
    const next = new URLSearchParams(params);
    next.set('view', v);
    setParams(next, { replace: true });
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-xl font-semibold text-gray-900">To Do</h1>
        <div className="flex gap-1 rounded-lg bg-gray-100 p-1" role="tablist" aria-label="To Do views">
          {VIEWS.map(v => (
            <button key={v.id} role="tab" aria-selected={view === v.id}
              onClick={() => select(v.id)}
              className={`px-3 py-1 text-sm rounded-md ${view === v.id
                ? 'bg-white shadow-sm text-gray-900 font-medium' : 'text-gray-600 hover:text-gray-900'}`}>
              {v.label}
            </button>
          ))}
        </div>
      </div>
      {view === 'mine' && <MineView people={people} />}
      {view === 'assigned' && <AssignedView people={people} />}
      {view === 'everyone' && <EveryoneView />}
    </div>
  );
}

/** "3 Oct" / "3 Oct 2025" — for the finished list. '—' on anything unparseable. */
function fmtShort(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso.length === 10 ? `${iso}T00:00:00Z` : iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleDateString('en-GB', {
    day: 'numeric', month: 'short',
    year: d.getUTCFullYear() === new Date().getFullYear() ? undefined : 'numeric',
    timeZone: 'UTC',
  });
}

function fmtDue(iso: string | null): { text: string; tone: string } {
  if (!iso) return { text: 'No date', tone: 'text-gray-400' };
  const [y, m, d] = iso.split('-').map(Number);
  const due = new Date(Date.UTC(y, m - 1, d));
  const today = new Date();
  const todayUtc = Date.UTC(today.getFullYear(), today.getMonth(), today.getDate());
  const days = Math.round((due.getTime() - todayUtc) / 86_400_000);
  const text = due.toLocaleDateString('en-GB', {
    day: 'numeric', month: 'short',
    year: due.getUTCFullYear() === today.getFullYear() ? undefined : 'numeric',
    timeZone: 'UTC',
  });
  if (days < 0) return { text: `${text} · ${-days}d overdue`, tone: 'text-red-700 font-medium' };
  if (days === 0) return { text: `${text} · today`, tone: 'text-amber-700 font-medium' };
  if (days <= 7) return { text: `${text} · in ${days}d`, tone: 'text-amber-700' };
  return { text, tone: 'text-gray-500' };
}

const SOURCE_LABEL: Record<string, string> = {
  staff_review: 'From your review',
};

function MineView({ people }: { people: Person[] }) {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [linked, setLinked] = useState(true);
  const [loading, setLoading] = useState(true);
  // Distinguished from "no tasks" deliberately: an empty list and a failed
  // load look identical otherwise, which is exactly how the staff-records
  // file list hid three 500s on the day it shipped.
  const [loadError, setLoadError] = useState<string | null>(null);
  const [showDone, setShowDone] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);

  const [title, setTitle] = useState('');
  const [dueDate, setDueDate] = useState('');
  // Left blank the server derives it: the due date if there is one, else a
  // fortnight out. That second case is the point — a task with no deadline
  // would otherwise never resurface.
  const [remindOn, setRemindOn] = useState('');
  // '' = me. Anyone can give anyone a task (TASKS-SPEC §5.1).
  const [forPerson, setForPerson] = useState('');
  const [isPrivate, setIsPrivate] = useState(false);
  const [adding, setAdding] = useState(false);

  const load = useCallback(async () => {
    setLoadError(null);
    try {
      const res = await api.get<{ data: Task[]; linked: boolean }>(
        `/staff-tasks/mine?includeDone=${showDone}`);
      setTasks(res.data);
      setLinked(res.linked);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : 'Could not load your to-do list');
    } finally {
      setLoading(false);
    }
  }, [showDone]);

  useEffect(() => { void load(); }, [load]);

  async function add(e: React.FormEvent) {
    e.preventDefault();
    if (!title.trim()) return;
    setAdding(true);
    try {
      await api.post('/staff-tasks', {
        title: title.trim(),
        dueDate: dueDate || null,
        // Only sent when they picked one — omitted means "derive it", which is
        // not the same as "never remind me".
        ...(remindOn ? { nextChaseDate: remindOn } : {}),
        ...(forPerson ? { personId: forPerson } : {}),
        ...(isPrivate ? { isPrivate: true } : {}),
      });
      setTitle('');
      setDueDate('');
      setRemindOn('');
      setIsPrivate(false);
      // "For" is left as it was — giving three things to one person in a row
      // is the common case.
      await load();
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : 'Could not add the task');
    } finally {
      setAdding(false);
    }
  }

  async function setStatus(task: Task, status: Task['status']) {
    setBusyId(task.id);
    try {
      await api.patch(`/staff-tasks/${task.id}`, { status });
      await load();
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : 'Could not update the task');
    } finally {
      setBusyId(null);
    }
  }

  async function handBack(task: Task) {
    const reason = window.prompt(
      `Hand “${task.title}” back to ${task.set_by_name || 'whoever set it'}? Say why:`);
    if (reason === null) return;
    if (!reason.trim()) { setLoadError('Say why you’re handing it back.'); return; }
    setBusyId(task.id);
    try {
      await api.post(`/staff-tasks/${task.id}/hand-back`, { reason: reason.trim() });
      await load();
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : 'Could not hand it back');
    } finally {
      setBusyId(null);
    }
  }

  async function saveEdit(task: Task, patch: Record<string, string | null>) {
    // Only what changed — so a title fix doesn't reset the chase stamp, which
    // re-dating deliberately does.
    const changed: Record<string, string | null> = {};
    if (patch.title !== task.title) changed.title = patch.title;
    if ((patch.detail ?? null) !== (task.detail ?? null)) changed.detail = patch.detail;
    if ((patch.dueDate || null) !== (task.due_date || null)) changed.dueDate = patch.dueDate || null;
    if ((patch.nextChaseDate || null) !== (task.next_chase_date || null)) {
      changed.nextChaseDate = patch.nextChaseDate || null;
    }
    if (Object.keys(changed).length === 0) { setEditingId(null); return; }
    setBusyId(task.id);
    try {
      await api.patch(`/staff-tasks/${task.id}`, changed);
      setEditingId(null);
      await load();
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : 'Could not save the task');
    } finally {
      setBusyId(null);
    }
  }

  const open = tasks.filter(t => t.status === 'open');
  const done = tasks.filter(t => t.status === 'done');

  return (
    <div className="space-y-6">

      {loadError && (
        <div className="rounded border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">
          {loadError}
        </div>
      )}

      {!linked && !loading && (
        <div className="rounded border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
          Your login isn’t linked to a staff record yet, so there’s nothing to show.
          An admin can link it on the Staff page.
        </div>
      )}

      <form onSubmit={add} className="bg-white rounded-lg border border-gray-200 p-4">
        <div className="flex flex-wrap items-end gap-3">
          <label className="flex-1 min-w-[16rem] text-sm">
            <span className="block text-xs text-gray-600 mb-1">Add something</span>
            <input
              value={title}
              onChange={e => setTitle(e.target.value)}
              placeholder="e.g. Book Will’s first-aid refresher"
              maxLength={300}
              className="w-full px-3 py-2 border border-gray-300 rounded text-sm"
            />
          </label>
          <label className="text-sm">
            <span className="block text-xs text-gray-600 mb-1">Remind me</span>
            <input
              type="date"
              value={remindOn}
              onChange={e => setRemindOn(e.target.value)}
              className="px-3 py-2 border border-gray-300 rounded text-sm"
            />
          </label>
          <label className="text-sm">
            <span className="block text-xs text-gray-600 mb-1">Due</span>
            <input
              type="date"
              value={dueDate}
              onChange={e => setDueDate(e.target.value)}
              className="px-3 py-2 border border-gray-300 rounded text-sm"
            />
          </label>
          <label className="text-sm">
            <span className="block text-xs text-gray-600 mb-1">For</span>
            <select value={forPerson} onChange={e => setForPerson(e.target.value)}
              className="px-3 py-2 border border-gray-300 rounded text-sm bg-white">
              <option value="">Me</option>
              {people.map(p => <option key={p.person_id} value={p.person_id}>{p.name ?? 'Unnamed'}</option>)}
            </select>
          </label>
          <label className="text-sm inline-flex items-center gap-1.5 text-gray-700 pb-2"
            title="Only you, whoever it's for, and admins will see it">
            <input type="checkbox" checked={isPrivate} onChange={e => setIsPrivate(e.target.checked)}
              className="h-4 w-4 rounded border-gray-300" />
            Private
          </label>
          <button
            type="submit"
            disabled={!title.trim() || adding}
            className="px-4 py-2 text-sm rounded bg-ooosh-600 text-white hover:bg-ooosh-700 disabled:opacity-40"
          >
            {adding ? 'Adding…' : 'Add'}
          </button>
        </div>
      </form>

      {loading ? (
        <p className="text-sm text-gray-500">Loading…</p>
      ) : (
        <div className="bg-white rounded-lg border border-gray-200 divide-y divide-gray-100">
          {open.length === 0 ? (
            <p className="px-4 py-6 text-sm text-gray-400">
              {loadError ? 'Your list couldn’t be loaded.' : 'Nothing outstanding.'}
            </p>
          ) : open.map(task => {
            const due = fmtDue(task.due_date);
            if (editingId === task.id) {
              return (
                <TaskEditRow key={task.id} task={task} busy={busyId === task.id}
                  onCancel={() => setEditingId(null)}
                  onSave={patch => void saveEdit(task, patch)} />
              );
            }
            return (
              <div key={task.id} className="flex items-start gap-3 px-4 py-3">
                <input
                  type="checkbox"
                  checked={false}
                  disabled={busyId === task.id}
                  onChange={() => void setStatus(task, 'done')}
                  className="mt-1 h-4 w-4 rounded border-gray-300 text-ooosh-600"
                  aria-label={`Mark "${task.title}" done`}
                />
                <div className="min-w-0 flex-1">
                  <div className="text-sm text-gray-900">{task.title}</div>
                  {task.detail && <div className="text-xs text-gray-500 mt-0.5">{task.detail}</div>}
                  <div className="flex flex-wrap items-center gap-2 mt-1">
                    <span className={`text-xs ${due.tone}`}>{due.text}</span>
                    {task.next_chase_date && (
                      <span className="text-[11px] text-gray-400">
                        nudge {new Date(task.next_chase_date).toLocaleDateString('en-GB',
                          { day: 'numeric', month: 'short' })}
                      </span>
                    )}
                    {SOURCE_LABEL[task.source_type] && (
                      <span className="text-[11px] px-1.5 py-0.5 rounded bg-ooosh-50 text-ooosh-700">
                        {SOURCE_LABEL[task.source_type]}
                      </span>
                    )}
                    {setBySomeoneElse(task) && task.source_type !== 'staff_review' && (
                      <span className="text-[11px] px-1.5 py-0.5 rounded bg-blue-50 text-blue-700">
                        from {task.set_by_name || 'someone'}
                      </span>
                    )}
                    {task.is_private && (
                      <span className="text-[11px] px-1.5 py-0.5 rounded bg-gray-100 text-gray-600">private</span>
                    )}
                  </div>
                  {task.handed_back_reason && (
                    <div className="text-xs text-amber-800 mt-1">
                      Handed back by {task.handed_back_by_name || 'someone'}: “{task.handed_back_reason}”
                    </div>
                  )}
                </div>
                {setBySomeoneElse(task) && (
                  <button
                    onClick={() => void handBack(task)}
                    disabled={busyId === task.id}
                    className="text-xs text-gray-500 hover:text-gray-800 disabled:opacity-40 shrink-0"
                    title={`Give it back to ${task.set_by_name || 'whoever set it'}, with a reason`}
                  >
                    Hand back
                  </button>
                )}
                <button
                  onClick={() => setEditingId(task.id)}
                  disabled={busyId === task.id}
                  className="text-xs text-ooosh-600 hover:text-ooosh-800 disabled:opacity-40 shrink-0"
                >
                  Edit
                </button>
                <button
                  onClick={() => void setStatus(task, 'cancelled')}
                  disabled={busyId === task.id}
                  className="text-xs text-gray-400 hover:text-gray-600 disabled:opacity-40 shrink-0"
                  title="Not doing this after all"
                >
                  Drop
                </button>
              </div>
            );
          })}
        </div>
      )}

      <div>
        <button
          onClick={() => setShowDone(v => !v)}
          className="text-sm text-ooosh-600 hover:underline"
        >
          {showDone ? 'Hide' : 'Show'} recently finished
        </button>
        {showDone && !loading && (
          <div className="mt-3 bg-white rounded-lg border border-gray-200 divide-y divide-gray-100">
            {done.length === 0 ? (
              <p className="px-4 py-4 text-sm text-gray-400">Nothing finished in the last 30 days.</p>
            ) : done.map(task => (
              <div key={task.id} className="flex items-center gap-3 px-4 py-2">
                <input
                  type="checkbox"
                  checked
                  disabled={busyId === task.id}
                  onChange={() => void setStatus(task, 'open')}
                  className="h-4 w-4 rounded border-gray-300 text-ooosh-600"
                  aria-label={`Re-open "${task.title}"`}
                />
                <span className="text-sm text-gray-500 line-through min-w-0 flex-1">{task.title}</span>
                <span className="text-xs text-gray-400 whitespace-nowrap">
                  {task.due_date && <>due {fmtShort(task.due_date)} · </>}
                  done {fmtShort(task.completed_at)}
                  {task.due_date && task.completed_at && task.completed_at.slice(0, 10) > task.due_date && (
                    <span className="text-amber-700"> (late)</span>
                  )}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

/** Edit an open to-do in place: wording, detail, due date, when to be nudged. */
function TaskEditRow({ task, busy, onCancel, onSave }: {
  task: Task;
  busy: boolean;
  onCancel: () => void;
  onSave: (patch: Record<string, string | null>) => void;
}) {
  const [title, setTitle] = useState(task.title);
  const [detail, setDetail] = useState(task.detail ?? '');
  const [dueDate, setDueDate] = useState(task.due_date ?? '');
  const [remindOn, setRemindOn] = useState(task.next_chase_date ?? '');

  return (
    <div className="px-4 py-3 bg-gray-50 space-y-2">
      <input value={title} onChange={e => setTitle(e.target.value)} maxLength={300}
        aria-label="Title"
        className="w-full px-3 py-2 border border-gray-300 rounded text-sm bg-white" />
      <textarea value={detail} onChange={e => setDetail(e.target.value)} rows={2} maxLength={4000}
        placeholder="Detail (optional)"
        className="w-full px-3 py-2 border border-gray-300 rounded text-sm bg-white" />
      <div className="flex flex-wrap items-end gap-3">
        <label className="text-sm">
          <span className="block text-xs text-gray-600 mb-1">Due</span>
          <input type="date" value={dueDate} onChange={e => setDueDate(e.target.value)}
            className="px-3 py-2 border border-gray-300 rounded text-sm bg-white" />
        </label>
        <label className="text-sm">
          <span className="block text-xs text-gray-600 mb-1">Remind me</span>
          <input type="date" value={remindOn} onChange={e => setRemindOn(e.target.value)}
            className="px-3 py-2 border border-gray-300 rounded text-sm bg-white" />
        </label>
        <span className="text-[11px] text-gray-400 pb-2 max-w-[16rem]">
          Blank = never nudge. Moving the due date moves the reminder with it unless you set one here.
        </span>
        <div className="ml-auto flex gap-2">
          <button onClick={onCancel} disabled={busy}
            className="px-3 py-1.5 text-sm rounded border border-gray-300 bg-white hover:bg-gray-50 disabled:opacity-40">
            Cancel
          </button>
          <button
            onClick={() => onSave({
              title: title.trim(), detail: detail.trim() || null,
              dueDate: dueDate || null, nextChaseDate: remindOn || null,
            })}
            disabled={busy || !title.trim()}
            className="px-3 py-1.5 text-sm rounded bg-ooosh-600 text-white hover:bg-ooosh-700 disabled:opacity-40">
            {busy ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * What I gave to other people (spec §5.2), with MY follow-up date — the
 * setter's own clock, separate from the owner's nudge. "Reset the follow-up"
 * is just moving that date; the server re-arms it.
 */
function AssignedView({ people }: { people: Person[] }) {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const res = await api.get<{ data: Task[] }>('/staff-tasks/assigned');
      setTasks(res.data);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load the tasks you set');
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => { void load(); }, [load]);

  async function patch(task: Task, body: Record<string, unknown>) {
    setBusyId(task.id);
    try {
      await api.patch(`/staff-tasks/${task.id}`, body);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not update the task');
    } finally {
      setBusyId(null);
    }
  }

  const open = tasks.filter(t => t.status === 'open');
  const done = tasks.filter(t => t.status === 'done');

  if (loading) return <p className="text-sm text-gray-500">Loading…</p>;
  return (
    <div className="space-y-4">
      {error && (
        <div className="rounded border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">{error}</div>
      )}
      <div className="bg-white rounded-lg border border-gray-200 divide-y divide-gray-100">
        {open.length === 0 ? (
          <p className="px-4 py-6 text-sm text-gray-400">
            {error ? 'Couldn’t load these.' : 'Nothing you’ve given anyone is still open.'}
          </p>
        ) : open.map(task => {
          const due = fmtDue(task.due_date);
          return (
            <div key={task.id} className="px-4 py-3 flex flex-wrap items-center gap-x-4 gap-y-2">
              <div className="min-w-0 flex-1">
                <div className="text-sm text-gray-900">{task.title}</div>
                <div className="flex flex-wrap items-center gap-2 mt-1">
                  <span className={`text-xs ${due.tone}`}>{due.text}</span>
                  {task.is_private && (
                    <span className="text-[11px] px-1.5 py-0.5 rounded bg-gray-100 text-gray-600">private</span>
                  )}
                </div>
              </div>
              <label className="text-xs text-gray-600">
                <span className="block mb-0.5">With</span>
                <select value={task.person_id} disabled={busyId === task.id}
                  onChange={e => void patch(task, { personId: e.target.value })}
                  className="px-2 py-1 border border-gray-300 rounded text-sm bg-white">
                  {/* Keep the current owner selectable even if they are not in
                      the picker (a login since deactivated) — a select with no
                      matching option renders blank and would save blank. */}
                  {!people.some(p => p.person_id === task.person_id) && (
                    <option value={task.person_id}>{task.owner_name ?? 'Unknown'}</option>
                  )}
                  {people.map(p => <option key={p.person_id} value={p.person_id}>{p.name ?? 'Unnamed'}</option>)}
                </select>
              </label>
              <label className="text-xs text-gray-600">
                <span className="block mb-0.5">Follow up</span>
                <input type="date" value={task.follow_up_on ?? ''} disabled={busyId === task.id}
                  onChange={e => void patch(task, { followUpOn: e.target.value || null })}
                  className="px-2 py-1 border border-gray-300 rounded text-sm" />
              </label>
              <button onClick={() => {
                if (window.confirm(`Drop “${task.title}”? It comes off ${task.owner_name || 'their'} list.`)) {
                  void patch(task, { status: 'cancelled' });
                }
              }}
                disabled={busyId === task.id}
                className="text-xs text-gray-400 hover:text-gray-600 disabled:opacity-40">
                Drop
              </button>
            </div>
          );
        })}
      </div>
      {done.length > 0 && (
        <div>
          <h2 className="text-sm font-medium text-gray-700 mb-2">Done in the last 30 days</h2>
          <div className="bg-white rounded-lg border border-gray-200 divide-y divide-gray-100">
            {done.map(task => (
              <div key={task.id} className="flex items-center gap-3 px-4 py-2">
                <span className="text-sm text-gray-500 line-through min-w-0 flex-1">{task.title}</span>
                <span className="text-xs text-gray-400 whitespace-nowrap">
                  {task.owner_name} · done {fmtShort(task.completed_at)}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
      <p className="text-xs text-gray-400">
        “Follow up” is your own reminder to check on it — separate from theirs. Move it to reset it;
        clear it to stop. You’ll hear when it’s done, and if they hand it back.
      </p>
    </div>
  );
}

/** Every open task, grouped by owner (spec §4). Read-only: a glance, not a workbench. */
function EveryoneView() {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.get<{ data: Task[] }>('/staff-tasks/everyone')
      .then(res => setTasks(res.data))
      .catch(err => setError(err instanceof Error ? err.message : 'Could not load everyone’s tasks'))
      .finally(() => setLoading(false));
  }, []);

  if (loading) return <p className="text-sm text-gray-500">Loading…</p>;
  if (error) {
    return <div className="rounded border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">{error}</div>;
  }
  if (tasks.length === 0) return <p className="text-sm text-gray-400">Nobody has anything open.</p>;

  const groups = new Map<string, Task[]>();
  for (const t of tasks) {
    const key = t.owner_name || 'Unnamed';
    groups.set(key, [...(groups.get(key) ?? []), t]);
  }

  return (
    <div className="space-y-4">
      {[...groups.entries()].map(([owner, list]) => (
        <div key={owner} className="bg-white rounded-lg border border-gray-200">
          <div className="px-4 py-2 border-b border-gray-100 flex items-center gap-2">
            <span className="text-sm font-medium text-gray-900">{owner}</span>
            <span className="text-xs text-gray-400">{list.length} open</span>
          </div>
          <ul className="divide-y divide-gray-100">
            {list.map(t => {
              const due = fmtDue(t.due_date);
              return (
                <li key={t.id} className="px-4 py-2 flex flex-wrap items-center gap-x-3 gap-y-1">
                  <span className="text-sm text-gray-800 min-w-0 flex-1">{t.title}</span>
                  {t.is_private && (
                    <span className="text-[11px] px-1.5 py-0.5 rounded bg-gray-100 text-gray-600">private</span>
                  )}
                  {setBySomeoneElse(t) && (
                    <span className="text-[11px] text-gray-400">from {t.set_by_name || 'someone'}</span>
                  )}
                  <span className={`text-xs ${due.tone}`}>{due.text}</span>
                </li>
              );
            })}
          </ul>
        </div>
      ))}
      <p className="text-xs text-gray-400">
        Private to-dos only appear here for the person they belong to, whoever set them, and admins.
      </p>
    </div>
  );
}

