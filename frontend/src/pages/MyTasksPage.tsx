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
 */

import { useCallback, useEffect, useState } from 'react';
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

export default function MyTasksPage() {
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
      });
      setTitle('');
      setDueDate('');
      setRemindOn('');
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
      <div>
        <h1 className="text-xl font-semibold text-gray-900">My To Do</h1>
      </div>

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
                  </div>
                </div>
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

