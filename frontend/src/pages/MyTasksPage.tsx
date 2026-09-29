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
import { Link, useSearchParams } from 'react-router-dom';
import { api } from '../services/api';
import ForwardDateInput, { ymdFromToday } from '../components/ForwardDateInput';
import {
  RecurrenceModal, SeriesEditModal, defaultRepeat, type RepeatValue, type Series,
} from '../components/RecurrenceFields';
import { useAuthStore } from '../hooks/useAuthStore';

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
  /** NULL for a list item nobody has taken yet (spec §7). */
  person_id: string | null;
  owner_name: string | null;
  list_id: string | null;
  list_name: string | null;
  created_by: string | null;
  is_private: boolean;
  follow_up_on: string | null;
  set_by_person_id: string | null;
  set_by_name: string | null;
  handed_back_by: string | null;
  handed_back_reason: string | null;
  handed_back_by_name: string | null;
  handed_back_at: string | null;
  /**
   * A repeating to-do can't be ticked before this date (YYYY-MM-DD), or a row
   * of clicks would walk through the weeks ahead. NULL = can be ticked now.
   * The server works it out and refuses an early tick; this only greys the box.
   */
  opens_on: string | null;
}

/** Not open yet → "opens Tue 6 Oct"; otherwise null. */
function notOpenYet(task: Task): string | null {
  const today = new Date().toLocaleDateString('en-CA');
  if (!task.opens_on || task.opens_on <= today) return null;
  return new Date(`${task.opens_on}T00:00:00Z`)
    .toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });
}

/** Somebody a task can be given to — GET /staff-tasks/people. */
interface Person { person_id: string; name: string | null }

/**
 * Set by somebody other than its owner — i.e. given to them. Not a list item:
 * whoever added "milk" to Shopping didn't give it to the person who took it.
 */
function setBySomeoneElse(t: Task): boolean {
  return !t.list_id && !!t.set_by_person_id && t.set_by_person_id !== t.person_id;
}

/** Label-height spacer: lines a control up with inputs that sit under a label. */
const LABEL_SPACER = <span className="block text-xs mb-1 select-none" aria-hidden>&nbsp;</span>;

const VIEWS = [
  { id: 'mine', label: 'Mine' },
  { id: 'assigned', label: 'Assigned by me' },
  { id: 'lists', label: 'Lists' },
  { id: 'everyone', label: 'Everyone' },
] as const;
type ViewId = (typeof VIEWS)[number]['id'];

/**
 * The To Do tab: a header, the four views, and the people list they share.
 * The views mount rather than route, like the Me page's own tabs.
 */
export default function ToDoPage() {
  const [params, setParams] = useSearchParams();
  const raw = params.get('view');
  const view: ViewId = VIEWS.some(v => v.id === raw) ? (raw as ViewId) : 'mine';
  const [people, setPeople] = useState<Person[]>([]);
  const [me, setMe] = useState<string | null>(null);

  useEffect(() => {
    // Only the pickers need it; failing leaves "Me" as the one choice.
    api.get<{ data: Person[]; me?: string | null }>('/staff-tasks/people')
      .then(res => { setPeople(res.data); setMe(res.me ?? null); })
      .catch(() => undefined);
  }, []);
  // The "For" picker leaves me out: "Me" is already its first option, and
  // me again by name read like two different people (jon, Sep 2026).
  const others = people.filter(p => p.person_id !== me);

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
      {view === 'mine' && <MineView people={people} others={others} />}
      {view === 'assigned' && <AssignedView people={people} />}
      {view === 'lists' && <ListsView people={people} me={me} />}
      {view === 'everyone' && <EveryoneView people={people} />}
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

// A repeating to-do's occurrence carries its series' words instead of a
// badge (SeriesInline), so it isn't listed here.
const SOURCE_LABEL: Record<string, string> = {
  staff_review: 'From your review',
};

const SERIES = 'staff_task_series';

/** "Stop" a repeating to-do — owner, setter or admin; the server decides. */
async function stopSeries(s: Series): Promise<void> {
  const reason = window.prompt(`Stop “${s.title}” repeating? Nothing more will be made — the one open now stays. Why (optional)?`);
  if (reason === null) return;
  await api.post(`/staff-tasks/series/${s.id}/end`, { reason: reason.trim() || null });
}

/**
 * The Repeating list, as each view shows it. `manage` decides which rows get
 * Change / Stop — a convenience only; the server enforces who may.
 */
function SeriesList({ series, people, showOwner, canChange, canStop, onChanged, onError }: {
  series: Series[];
  people: Person[];
  showOwner: boolean;
  canChange: (s: Series) => boolean;
  canStop: (s: Series) => boolean;
  onChanged: () => Promise<void>;
  onError: (msg: string) => void;
}) {
  const [editing, setEditing] = useState<Series | null>(null);
  // A series with one open shows ON that row (SeriesInline) — listing it here
  // too is what made the views show everything twice. Here: only the ones
  // with nothing open right now.
  const idle = series.filter(s => !s.open_task_id);
  if (!idle.length) return null;
  return (
    <div>
      <h2 className="text-sm font-medium text-gray-700 mb-2">Repeating — nothing open right now</h2>
      <div className="bg-white rounded-lg border border-gray-200 divide-y divide-gray-100">
        {idle.map(s => (
          <div key={s.id} className="px-4 py-2.5 flex flex-wrap items-center gap-x-3 gap-y-1">
            <div className="min-w-0 flex-1">
              <div className="text-sm text-gray-900">
                {s.title}
                {showOwner && <span className="text-gray-500"> — {s.owner_name}</span>}
              </div>
              <div className="text-xs text-gray-500 mt-0.5">
                {s.rule_text}
                {s.status === 'active' && s.next_on && <> · next {fmtShort(s.next_on)}</>}
                {s.last_done_at && <> · last done {fmtShort(s.last_done_at)}</>}
              </div>
              {s.status === 'proposed' && (
                <div className="text-xs text-amber-700 mt-0.5">Waiting for {s.owner_name || 'them'} to accept</div>
              )}
              {s.status === 'declined' && (
                <div className="text-xs text-red-700 mt-0.5">Declined{s.decline_reason ? `: “${s.decline_reason}”` : ''}</div>
              )}
              {s.status === 'ended' && (
                <div className="text-xs text-gray-400 mt-0.5">Stopped{s.ended_reason ? `: ${s.ended_reason}` : ''}</div>
              )}
            </div>
            {s.is_private && (
              <span className="text-[11px] px-1.5 py-0.5 rounded bg-gray-100 text-gray-600">private</span>
            )}
            {canChange(s) && s.status !== 'ended' && (
              <button onClick={() => setEditing(s)} className="text-xs text-ooosh-600 hover:text-ooosh-800">Change</button>
            )}
            {canStop(s) && (s.status === 'active' || s.status === 'proposed') && (
              <button onClick={() => { void stopSeries(s).then(onChanged).catch(e => onError(e instanceof Error ? e.message : 'Could not stop it')); }}
                className="text-xs text-gray-400 hover:text-gray-600">Stop</button>
            )}
          </div>
        ))}
      </div>
      {editing && (
        <SeriesEditModal series={editing} people={people}
          onClose={() => setEditing(null)}
          onSaved={async () => { setEditing(null); await onChanged(); }}
          onError={onError} />
      )}
    </div>
  );
}

/**
 * A repeating to-do's words and controls, on the row of its open occurrence:
 * "↻ Every week on Tue · change · stop repeating". One row per thing.
 */
function SeriesInline({ series, people, canChange, canStop, onChanged, onError }: {
  series: Series;
  people: Person[];
  canChange: boolean;
  canStop: boolean;
  onChanged: () => Promise<void>;
  onError: (msg: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  return (
    <span className="inline-flex flex-wrap items-center gap-2 text-[11px]">
      <span className="px-1.5 py-0.5 rounded bg-ooosh-50 text-ooosh-700" title="Repeats">↻ {series.rule_text}</span>
      {canChange && (
        <button onClick={() => setEditing(true)} className="text-ooosh-600 hover:underline">change</button>
      )}
      {canStop && (
        <button
          onClick={() => { void stopSeries(series).then(onChanged)
            .catch(e => onError(e instanceof Error ? e.message : 'Could not stop it')); }}
          className="text-gray-400 hover:text-gray-600">stop repeating</button>
      )}
      {editing && (
        <SeriesEditModal series={series} people={people}
          onClose={() => setEditing(false)}
          onSaved={async () => { setEditing(false); await onChanged(); }}
          onError={onError} />
      )}
    </span>
  );
}

/** My job reminders and my Problems (spec §2, phase 4) — read-through. */
interface JobReminder {
  id: string; custom_label: string | null; notes: string | null; due_date: string | null;
  job_id: string; hh_job_number: number | null; job_name: string | null;
}
interface MyProblem {
  id: string; summary: string; status: string; severity: string;
  job_id: string | null; hh_job_number: number | null;
}
const PROBLEM_STATUS: Record<string, string> = {
  open: 'Open', investigating: 'Investigating', awaiting_quote: 'Awaiting quote',
  quoted: 'Quoted', actioned: 'Actioned',
};

function MineView({ people, others }: { people: Person[]; others: Person[] }) {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [linked, setLinked] = useState(true);
  // My person id, from /mine — to tell my rows from ones I handed back.
  const [me, setMe] = useState<string | null>(null);
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
  // Repeating (TASKS-SPEC §6): null = a one-off.
  const [repeat, setRepeat] = useState<RepeatValue | null>(null);
  const [repeatOpen, setRepeatOpen] = useState(false);
  const [series, setSeries] = useState<Series[]>([]);
  const [reminders, setReminders] = useState<JobReminder[]>([]);
  const [problems, setProblems] = useState<MyProblem[]>([]);

  const load = useCallback(async () => {
    setLoadError(null);
    try {
      const res = await api.get<{ data: Task[]; linked: boolean; me?: string }>(
        `/staff-tasks/mine?includeDone=${showDone}`);
      setTasks(res.data);
      setLinked(res.linked);
      setMe(res.me ?? null);
      // Secondary: a failure here shouldn't blank the list above it.
      api.get<{ data: Series[] }>('/staff-tasks/series/mine')
        .then(r => setSeries(r.data))
        .catch(() => undefined);
      api.get<{ data: { reminders: JobReminder[]; problems: MyProblem[] } }>('/staff-tasks/pullins')
        .then(r => { setReminders(r.data.reminders); setProblems(r.data.problems); })
        .catch(() => undefined);
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
      if (repeat) {
        // A repeating one is a SERIES; its first occurrence is made from it.
        await api.post('/staff-tasks/series', {
          title: title.trim(),
          mode: repeat.mode, rule: repeat.rule,
          startsOn: dueDate || ymdFromToday(0),
          ...(repeat.endsOn ? { endsOn: repeat.endsOn } : {}),
          ...(repeat.endsAfter ? { endsAfter: repeat.endsAfter } : {}),
          ...(forPerson ? { personId: forPerson } : {}),
          ...(isPrivate ? { isPrivate: true } : {}),
        });
        setTitle(''); setDueDate(''); setRemindOn(''); setIsPrivate(false); setRepeat(null);
        await load();
        return;
      }
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

  async function respond(x: Series, accept: boolean) {
    let reason: string | null = null;
    if (!accept) {
      reason = window.prompt(`Decline “${x.title}”? Say why — ${x.set_by_name || 'they'} will see it:`);
      if (reason === null) return;
      if (!reason.trim()) { setLoadError('Say why you’re declining.'); return; }
    }
    try {
      await api.post(`/staff-tasks/series/${x.id}/respond`, { accept, reason });
      await load();
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : 'Could not answer');
    }
  }

  /** Tick a job reminder — through the job module's own endpoint (spec §2). */
  async function tickReminder(r: JobReminder) {
    setBusyId(r.id);
    try {
      await api.patch(`/requirements/${r.id}`, { status: 'done' });
      await load();
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : 'Could not tick the reminder');
    } finally {
      setBusyId(null);
    }
  }

  /** A taken list item goes back on its list. */
  async function putBack(task: Task) {
    setBusyId(task.id);
    try {
      await api.post(`/staff-tasks/${task.id}/release`, {});
      await load();
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : 'Could not put it back');
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
    const changed = changedFields(task, patch);
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

  // A task I handed back is someone else's now — it only appears (greyed) in
  // my recently finished, never in my open list.
  const handedBackByMe = (t: Task) => !!me && t.handed_back_by === me && t.person_id !== me;
  const open = tasks.filter(t => t.status === 'open' && !handedBackByMe(t));
  const done = tasks.filter(t => t.status === 'done' || handedBackByMe(t));

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
        {/* items-start: every control sits under a same-height label, so the
            boxes line up in a row and the date shortcuts hang BELOW them
            (jon, Sep 2026). */}
        <div className="flex flex-wrap items-start gap-3">
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
          {!repeat && (
            <label className="text-sm">
              <span className="block text-xs text-gray-600 mb-1">Remind me</span>
              <ForwardDateInput value={remindOn} onChange={setRemindOn} ariaLabel="Remind me" />
            </label>
          )}
          <label className="text-sm">
            <span className="block text-xs text-gray-600 mb-1">{repeat ? 'Starts' : 'Due'}</span>
            <ForwardDateInput value={dueDate} onChange={setDueDate} ariaLabel={repeat ? 'Starts' : 'Due'} />
          </label>
          <label className="text-sm">
            <span className="block text-xs text-gray-600 mb-1">Repeats</span>
            <select value={repeat ? 'custom' : 'none'}
              onChange={e => {
                if (e.target.value === 'none') setRepeat(null);
                else setRepeatOpen(true);
              }}
              className="px-3 py-2 border border-gray-300 rounded text-sm bg-white">
              <option value="none">Doesn’t repeat</option>
              <option value="custom">{repeat ? repeat.text || 'Custom…' : 'Custom…'}</option>
            </select>
            {repeat && (
              <button type="button" onClick={() => setRepeatOpen(true)}
                className="block text-[11px] text-ooosh-600 hover:underline mt-1">change</button>
            )}
          </label>
          <label className="text-sm">
            <span className="block text-xs text-gray-600 mb-1">For</span>
            <select value={forPerson} onChange={e => setForPerson(e.target.value)}
              className="px-3 py-2 border border-gray-300 rounded text-sm bg-white">
              <option value="">Me</option>
              {others.map(p => <option key={p.person_id} value={p.person_id}>{p.name ?? 'Unnamed'}</option>)}
            </select>
          </label>
          <div className="text-sm">
            {LABEL_SPACER}
            <label className="inline-flex items-center gap-1.5 text-gray-700 py-2"
              title="Only you, whoever it's for, and admins will see it">
              <input type="checkbox" checked={isPrivate} onChange={e => setIsPrivate(e.target.checked)}
                className="h-4 w-4 rounded border-gray-300" />
              Private
            </label>
          </div>
          <div className="text-sm">
            {LABEL_SPACER}
            <button
              type="submit"
              disabled={!title.trim() || adding}
              className="px-4 py-2 text-sm rounded bg-ooosh-600 text-white hover:bg-ooosh-700 disabled:opacity-40"
            >
              {adding ? 'Adding…' : 'Add'}
            </button>
          </div>
        </div>
        {repeat && forPerson && (
          <p className="text-xs text-amber-700 mt-2">
            They’ll be asked to accept a repeating to-do before it starts.
          </p>
        )}
      </form>
      {repeatOpen && (
        <RecurrenceModal
          startsOn={dueDate || ymdFromToday(0)}
          initial={repeat ?? defaultRepeat(dueDate || ymdFromToday(0))}
          onCancel={() => setRepeatOpen(false)}
          onDone={v => { setRepeat(v); setRepeatOpen(false); }}
        />
      )}

      {series.filter(x => x.status === 'proposed').map(x => (
        <div key={x.id} className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3">
          <p className="text-sm text-gray-900">
            <strong>{x.set_by_name || 'Someone'}</strong> wants to give you a repeating to-do:
            {' '}<strong>“{x.title}”</strong> — {x.rule_text.charAt(0).toLowerCase() + x.rule_text.slice(1)}.
          </p>
          <div className="flex gap-2 mt-2">
            <button onClick={() => void respond(x, true)}
              className="px-3 py-1 text-sm rounded bg-ooosh-600 text-white hover:bg-ooosh-700">Accept</button>
            <button onClick={() => void respond(x, false)}
              className="px-3 py-1 text-sm rounded border border-gray-300 bg-white hover:bg-gray-50">Decline…</button>
          </div>
        </div>
      ))}

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
            const opens = notOpenYet(task);
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
                  disabled={busyId === task.id || !!opens}
                  onChange={() => void setStatus(task, 'done')}
                  className="mt-1 h-4 w-4 rounded border-gray-300 text-ooosh-600 disabled:opacity-30"
                  aria-label={`Mark "${task.title}" done`}
                  title={opens ? `Can be ticked from ${opens}` : undefined}
                />
                <div className="min-w-0 flex-1">
                  <div className="text-sm text-gray-900">{task.title}</div>
                  {task.detail && <div className="text-xs text-gray-500 mt-0.5">{task.detail}</div>}
                  <div className="flex flex-wrap items-center gap-2 mt-1">
                    <span className={`text-xs ${due.tone}`}>{due.text}</span>
                    {opens && <span className="text-[11px] text-gray-400">opens {opens}</span>}
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
                    {task.list_id && (
                      <span className="text-[11px] px-1.5 py-0.5 rounded bg-emerald-50 text-emerald-700">
                        from {task.list_name || 'a list'}
                      </span>
                    )}
                    {task.is_private && (
                      <span className="text-[11px] px-1.5 py-0.5 rounded bg-gray-100 text-gray-600">private</span>
                    )}
                    {task.source_type === SERIES && (() => {
                      const x = series.find(v => v.id === task.source_id);
                      return x ? (
                        <SeriesInline series={x} people={people}
                          // Your own series you can change; one somebody set for you, only stop.
                          // A list's repeating to-do is the list's — changed from Lists.
                          canChange={!!me && x.set_by_person_id === me && !x.list_id}
                          canStop={!x.list_id}
                          onChanged={load} onError={m => setLoadError(m)} />
                      ) : null;
                    })()}
                  </div>
                  {task.handed_back_reason && (
                    <div className="text-xs text-amber-800 mt-1">
                      Handed back by {task.handed_back_by_name || 'someone'}: “{task.handed_back_reason}”
                    </div>
                  )}
                </div>
                {task.list_id && (
                  <button
                    onClick={() => void putBack(task)}
                    disabled={busyId === task.id}
                    className="text-xs text-gray-500 hover:text-gray-800 disabled:opacity-40 shrink-0"
                    title={`Back on ${task.list_name || 'the list'} for someone else`}
                  >
                    Put back
                  </button>
                )}
                {setBySomeoneElse(task) && task.source_type !== SERIES && (
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

      {(reminders.length > 0 || problems.length > 0) && (
        <div>
          <h2 className="text-sm font-medium text-gray-700 mb-2">From jobs</h2>
          <div className="bg-white rounded-lg border border-gray-200 divide-y divide-gray-100">
            {reminders.map(r => {
              const due = fmtDue(r.due_date);
              return (
                <div key={r.id} className="flex items-start gap-3 px-4 py-3">
                  <input type="checkbox" checked={false} disabled={busyId === r.id}
                    onChange={() => void tickReminder(r)}
                    className="mt-1 h-4 w-4 rounded border-gray-300 text-ooosh-600"
                    aria-label={`Mark reminder "${r.custom_label || 'Reminder'}" done`} />
                  <div className="min-w-0 flex-1">
                    <div className="text-sm text-gray-900">{r.custom_label || 'Reminder'}</div>
                    <div className="flex flex-wrap items-center gap-2 mt-1">
                      <span className={`text-xs ${due.tone}`}>{due.text}</span>
                      <span className="text-[11px] px-1.5 py-0.5 rounded bg-amber-50 text-amber-800">job reminder</span>
                      <Link to={`/jobs/${r.job_id}`} className="text-[11px] text-ooosh-600 hover:underline">
                        Job {r.hh_job_number ?? ''}{r.job_name ? ` · ${r.job_name}` : ''}
                      </Link>
                    </div>
                  </div>
                </div>
              );
            })}
            {problems.map(p => (
              <div key={p.id} className="flex items-start gap-3 px-4 py-3">
                <span className="mt-0.5 w-4 shrink-0 text-center text-sm font-semibold text-red-500" aria-hidden>!</span>
                <div className="min-w-0 flex-1">
                  <div className="text-sm text-gray-900">{p.summary}</div>
                  <div className="flex flex-wrap items-center gap-2 mt-1">
                    <span className={`text-[11px] px-1.5 py-0.5 rounded ${p.severity === 'urgent'
                      ? 'bg-red-50 text-red-700' : 'bg-gray-100 text-gray-600'}`}>
                      Problem · {PROBLEM_STATUS[p.status] ?? p.status}
                    </span>
                    {p.hh_job_number && <span className="text-[11px] text-gray-500">Job {p.hh_job_number}</span>}
                  </div>
                </div>
                {/* A Problem has its own workflow (quote, action, resolve) —
                    it is worked on its own page, not ticked off here. */}
                <Link to={`/operations/problems/${p.id}`}
                  className="text-xs text-ooosh-600 hover:text-ooosh-800 shrink-0">
                  Open
                </Link>
              </div>
            ))}
          </div>
        </div>
      )}

      <SeriesList
        series={series.filter(x => x.status === 'active')}
        people={people}
        showOwner={false}
        // Your own series you can change; one somebody set for you, only stop.
        canChange={x => !!me && x.set_by_person_id === me}
        canStop={() => true}
        onChanged={load}
        onError={m => setLoadError(m)}
      />

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
            ) : done.map(task => handedBackByMe(task) ? (
              <div key={task.id} className="flex items-center gap-3 px-4 py-2 opacity-70">
                <span className="h-4 w-4 shrink-0" aria-hidden />
                <span className="text-sm text-gray-400 italic min-w-0 flex-1">{task.title}</span>
                <span className="text-xs text-gray-400 italic whitespace-nowrap">
                  handed back to {task.owner_name || 'whoever set it'}
                  {task.handed_back_at && <> · {fmtShort(task.handed_back_at)}</>}
                </span>
              </div>
            ) : (
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
/**
 * What an edit actually changed — only that is sent, so a title fix doesn't
 * reset the chase stamp, which re-dating deliberately does.
 */
function changedFields(task: Task, patch: Record<string, string | null>): Record<string, string | null> {
  const changed: Record<string, string | null> = {};
  if (patch.title !== task.title) changed.title = patch.title;
  if ((patch.detail ?? null) !== (task.detail ?? null)) changed.detail = patch.detail;
  if ((patch.dueDate || null) !== (task.due_date || null)) changed.dueDate = patch.dueDate || null;
  if ((patch.nextChaseDate || null) !== (task.next_chase_date || null)) {
    changed.nextChaseDate = patch.nextChaseDate || null;
  }
  return changed;
}

function TaskEditRow({ task, busy, onCancel, onSave, remindLabel = 'Remind me' }: {
  task: Task;
  busy: boolean;
  onCancel: () => void;
  onSave: (patch: Record<string, string | null>) => void;
  /** On a list item the nudge goes to the list's watchers, not "me". */
  remindLabel?: string;
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
      <div className="flex flex-wrap items-start gap-3">
        <label className="text-sm">
          <span className="block text-xs text-gray-600 mb-1">Due</span>
          <ForwardDateInput value={dueDate} onChange={setDueDate} ariaLabel="Due" />
        </label>
        <label className="text-sm">
          <span className="block text-xs text-gray-600 mb-1">{remindLabel}</span>
          <ForwardDateInput value={remindOn} onChange={setRemindOn} ariaLabel={remindLabel} />
        </label>
        <span className="text-[11px] text-gray-400 mt-6 max-w-[16rem]">
          Blank = never nudge. Moving the due date moves the reminder with it unless you set one here.
        </span>
        <div className="ml-auto flex gap-2 mt-5">
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

  const [series, setSeries] = useState<Series[]>([]);

  const load = useCallback(async () => {
    setError(null);
    try {
      const res = await api.get<{ data: Task[] }>('/staff-tasks/assigned');
      setTasks(res.data);
      api.get<{ data: Series[] }>('/staff-tasks/series/assigned')
        .then(r => setSeries(r.data))
        .catch(() => undefined);
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
            <div key={task.id} className="px-4 py-3 flex flex-wrap items-start gap-x-4 gap-y-2">
              <div className="min-w-0 flex-1">
                <div className="text-sm text-gray-900">{task.title}</div>
                <div className="flex flex-wrap items-center gap-2 mt-1">
                  <span className={`text-xs ${due.tone}`}>{due.text}</span>
                  {task.is_private && (
                    <span className="text-[11px] px-1.5 py-0.5 rounded bg-gray-100 text-gray-600">private</span>
                  )}
                  {task.source_type === SERIES && (() => {
                    const x = series.find(v => v.id === task.source_id);
                    return x ? (
                      <SeriesInline series={x} people={people} canChange canStop
                        onChanged={load} onError={setError} />
                    ) : null;
                  })()}
                </div>
              </div>
              {task.source_type !== SERIES && <label className="text-xs text-gray-600">
                <span className="block mb-0.5">With</span>
                <select value={task.person_id ?? ''} disabled={busyId === task.id}
                  onChange={e => void patch(task, { personId: e.target.value })}
                  className="px-2 py-1 border border-gray-300 rounded text-sm bg-white">
                  {/* Keep the current owner selectable even if they are not in
                      the picker (a login since deactivated) — a select with no
                      matching option renders blank and would save blank. */}
                  {task.person_id && !people.some(p => p.person_id === task.person_id) && (
                    <option value={task.person_id}>{task.owner_name ?? 'Unknown'}</option>
                  )}
                  {people.map(p => <option key={p.person_id} value={p.person_id}>{p.name ?? 'Unnamed'}</option>)}
                </select>
              </label>}
              <label className="text-xs text-gray-600">
                <span className="block mb-0.5">Follow up</span>
                <ForwardDateInput value={task.follow_up_on ?? ''} disabled={busyId === task.id}
                  ariaLabel="Follow up"
                  onChange={v => void patch(task, { followUpOn: v || null })}
                  className="px-2 py-1 border border-gray-300 rounded text-sm" />
              </label>
              <button onClick={() => {
                if (window.confirm(`Drop “${task.title}”? It comes off ${task.owner_name || 'their'} list.`)) {
                  void patch(task, { status: 'cancelled' });
                }
              }}
                disabled={busyId === task.id}
                className="text-xs text-gray-400 hover:text-gray-600 disabled:opacity-40 mt-5">
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
      <SeriesList series={series} people={people} showOwner
        canChange={() => true} canStop={() => true}
        onChanged={load} onError={setError} />
      <p className="text-xs text-gray-400">
        “Follow up” is your own reminder to check on it — separate from theirs. Move it to reset it;
        clear it to stop. You’ll hear when it’s done, and if they hand it back.
      </p>
    </div>
  );
}

/** Every open task, grouped by owner (spec §4). Read-only: a glance, not a workbench. */
function EveryoneView({ people }: { people: Person[] }) {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [series, setSeries] = useState<Series[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const user = useAuthStore(s => s.user);

  const loadSeries = useCallback(async () => {
    try {
      const r = await api.get<{ data: Series[] }>('/staff-tasks/series/everyone');
      setSeries(r.data);
    } catch { /* the task list above still stands */ }
  }, []);

  useEffect(() => {
    api.get<{ data: Task[] }>('/staff-tasks/everyone')
      .then(res => setTasks(res.data))
      .catch(err => setError(err instanceof Error ? err.message : 'Could not load everyone’s tasks'))
      .finally(() => setLoading(false));
    void loadSeries();
  }, [loadSeries]);

  // Whoever set a series, or an admin, may change it — how an admin re-homes
  // a leaver's repeating to-dos (spec §6.5). The server enforces the same.
  const manages = (x: Series) => user?.role === 'admin' || (!!user && x.created_by === user.id);
  const repeating = (
    <SeriesList series={series} people={people} showOwner
      canChange={manages} canStop={manages}
      onChanged={loadSeries} onError={setError} />
  );

  if (loading) return <p className="text-sm text-gray-500">Loading…</p>;
  if (error) {
    return <div className="rounded border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">{error}</div>;
  }
  if (tasks.length === 0) {
    return <div className="space-y-4"><p className="text-sm text-gray-400">Nobody has anything open.</p>{repeating}</div>;
  }

  const groups = new Map<string, Task[]>();
  for (const t of tasks) {
    // Untaken list items come back only when dated (the bins) and group
    // under their list, after the people — the server orders them last.
    const key = t.person_id ? (t.owner_name || 'Unnamed') : `On ${t.list_name || 'a list'} — nobody on it yet`;
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
                  {t.list_id && t.person_id && (
                    <span className="text-[11px] text-gray-400">from {t.list_name || 'a list'}</span>
                  )}
                  {t.source_type === SERIES && (() => {
                    const x = series.find(v => v.id === t.source_id);
                    return x ? (
                      <SeriesInline series={x} people={people} canChange={manages(x)} canStop={manages(x)}
                        onChanged={loadSeries} onError={setError} />
                    ) : null;
                  })()}
                  <span className={`text-xs ${due.tone}`}>{due.text}</span>
                </li>
              );
            })}
          </ul>
        </div>
      ))}
      {repeating}
      <p className="text-xs text-gray-400">
        Private to-dos only appear here for the person they belong to, whoever set them, and admins.
      </p>
    </div>
  );
}

/** A shared list as GET /staff-tasks/lists returns it. */
interface TaskList {
  id: string;
  name: string;
  open_count: number;
  taken_count: number;
  watching: boolean;
  watchers: (string | null)[];
}

/**
 * Lists (spec §7, phase 3): Shopping, Building, and whatever else gets added.
 * Items belong to nobody until somebody says "I'll take it" — then they move
 * to that person's Mine, still marked "from Shopping", and can be put back.
 * Anyone can add, tick or drop an untaken item. Watchers get the nudges for
 * dated items nobody has taken.
 */
function ListsView({ people, me }: { people: Person[]; me: string | null }) {
  const [params, setParams] = useSearchParams();
  const [lists, setLists] = useState<TaskList[]>([]);
  const [items, setItems] = useState<Task[]>([]);
  const [series, setSeries] = useState<Series[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const [title, setTitle] = useState('');
  // "The 13A fuses, not the 5A" — items can carry a note (spec §7).
  const [detail, setDetail] = useState('');
  const [dueDate, setDueDate] = useState('');
  const [repeat, setRepeat] = useState<RepeatValue | null>(null);
  const [repeatOpen, setRepeatOpen] = useState(false);
  const [adding, setAdding] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);

  // The list is in the URL so a watcher's bell can open it directly.
  const listParam = params.get('list');
  const current = lists.find(l => l.id === listParam) ?? lists[0] ?? null;

  const loadLists = useCallback(async () => {
    try {
      const r = await api.get<{ data: TaskList[] }>('/staff-tasks/lists');
      setLists(r.data);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load the lists');
    } finally {
      setLoading(false);
    }
  }, []);

  const currentId = current?.id ?? null;
  const loadItems = useCallback(async () => {
    if (!currentId) { setItems([]); setSeries([]); return; }
    try {
      const r = await api.get<{ data: { items: Task[]; series: Series[] } }>(
        `/staff-tasks/lists/${currentId}/items`);
      setItems(r.data.items);
      setSeries(r.data.series);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load the list');
    }
  }, [currentId]);

  useEffect(() => { void loadLists(); }, [loadLists]);
  useEffect(() => { void loadItems(); }, [loadItems]);

  /** Counts on the chips and the items below both change on every action. */
  const reload = useCallback(async () => {
    await Promise.all([loadLists(), loadItems()]);
  }, [loadLists, loadItems]);

  function pick(id: string) {
    const next = new URLSearchParams(params);
    next.set('list', id);
    setParams(next, { replace: true });
  }

  /** One wrapper for every button here: busy, error, reload. */
  async function act(id: string, fn: () => Promise<unknown>, fallback: string) {
    setBusyId(id);
    setError(null);
    try {
      await fn();
      await reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : fallback);
    } finally {
      setBusyId(null);
    }
  }

  async function newList() {
    const name = window.prompt('Name the new list (e.g. Cleaning, Van kit):');
    if (!name?.trim()) return;
    setError(null);
    try {
      const r = await api.post<{ data: { id: string } }>('/staff-tasks/lists', { name: name.trim() });
      await loadLists();
      pick(r.data.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not add the list');
    }
  }

  async function rename(l: TaskList) {
    const name = window.prompt('Rename the list:', l.name);
    if (!name?.trim() || name.trim() === l.name) return;
    await act(l.id, () => api.patch(`/staff-tasks/lists/${l.id}`, { name: name.trim() }), 'Could not rename it');
  }

  async function archive(l: TaskList) {
    if (!window.confirm(`Archive “${l.name}”? It disappears from Lists. It must be empty first.`)) return;
    await act(l.id, async () => {
      await api.post(`/staff-tasks/lists/${l.id}/archive`, {});
      const next = new URLSearchParams(params);
      next.delete('list');
      setParams(next, { replace: true });
    }, 'Could not archive it');
  }

  async function add(e: React.FormEvent) {
    e.preventDefault();
    if (!current || !title.trim()) return;
    setAdding(true);
    setError(null);
    try {
      if (repeat) {
        // A list's repeating to-do (the bins): owned by nobody, needs nobody's
        // acceptance — each one due lands on the list (spec §6.4).
        await api.post('/staff-tasks/series', {
          title: title.trim(),
          ...(detail.trim() ? { detail: detail.trim() } : {}),
          mode: repeat.mode, rule: repeat.rule,
          startsOn: dueDate || ymdFromToday(0),
          ...(repeat.endsOn ? { endsOn: repeat.endsOn } : {}),
          ...(repeat.endsAfter ? { endsAfter: repeat.endsAfter } : {}),
          listId: current.id,
        });
      } else {
        await api.post(`/staff-tasks/lists/${current.id}/items`, {
          title: title.trim(),
          ...(detail.trim() ? { detail: detail.trim() } : {}),
          ...(dueDate ? { dueDate } : {}),
        });
      }
      setTitle(''); setDetail(''); setDueDate(''); setRepeat(null);
      await reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not add it');
    } finally {
      setAdding(false);
    }
  }

  if (loading) return <p className="text-sm text-gray-500">Loading…</p>;

  const open = items.filter(t => t.status === 'open');
  const done = items.filter(t => t.status === 'done');
  const watchers = current ? current.watchers.filter((w): w is string => !!w) : [];

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        {lists.map(l => (
          <button key={l.id} onClick={() => pick(l.id)}
            className={`px-3 py-1.5 text-sm rounded-full border ${current?.id === l.id
              ? 'border-ooosh-600 bg-ooosh-50 text-ooosh-800 font-medium'
              : 'border-gray-300 bg-white text-gray-700 hover:bg-gray-50'}`}>
            {l.name}
            {l.open_count > 0 && <span className="ml-1.5 text-xs text-gray-500">{l.open_count}</span>}
          </button>
        ))}
        <button onClick={() => void newList()}
          className="px-3 py-1.5 text-sm rounded-full border border-dashed border-gray-300 text-gray-600 hover:bg-gray-50">
          + New list
        </button>
      </div>

      {error && (
        <div className="rounded border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">{error}</div>
      )}

      {!current ? (
        <p className="text-sm text-gray-400">No lists yet — add one above.</p>
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
            <h2 className="text-base font-medium text-gray-900">{current.name}</h2>
            <label className="text-sm inline-flex items-center gap-1.5 text-gray-700"
              title="Watchers get the nudges for dated items nobody has taken">
              <input type="checkbox" checked={current.watching} disabled={busyId === current.id}
                onChange={e => void act(current.id,
                  () => api.post(`/staff-tasks/lists/${current.id}/watch`, { on: e.target.checked }),
                  'Could not change watching')}
                className="h-4 w-4 rounded border-gray-300" />
              Watch
            </label>
            <span className="text-xs text-gray-500">
              {watchers.length ? `Watching: ${watchers.join(', ')}` : 'Nobody is watching — nudges go nowhere'}
            </span>
            <span className="ml-auto flex gap-3">
              <button onClick={() => void rename(current)} disabled={busyId === current.id}
                className="text-xs text-ooosh-600 hover:text-ooosh-800 disabled:opacity-40">Rename</button>
              <button onClick={() => void archive(current)} disabled={busyId === current.id}
                className="text-xs text-gray-400 hover:text-gray-600 disabled:opacity-40">Archive</button>
            </span>
          </div>

          <form onSubmit={add} className="bg-white rounded-lg border border-gray-200 p-4">
            <div className="flex flex-wrap items-start gap-3">
              <label className="flex-1 min-w-[16rem] text-sm">
                <span className="block text-xs text-gray-600 mb-1">Add to {current.name}</span>
                <input value={title} onChange={e => setTitle(e.target.value)} maxLength={300}
                  placeholder="e.g. Milk, bin bags, fix the loading bay light"
                  className="w-full px-3 py-2 border border-gray-300 rounded text-sm" />
              </label>
              <label className="text-sm">
                <span className="block text-xs text-gray-600 mb-1">{repeat ? 'Starts' : 'Due (optional)'}</span>
                <ForwardDateInput value={dueDate} onChange={setDueDate} ariaLabel={repeat ? 'Starts' : 'Due'} />
              </label>
              <label className="text-sm">
                <span className="block text-xs text-gray-600 mb-1">Repeats</span>
                <select value={repeat ? 'custom' : 'none'}
                  onChange={e => {
                    if (e.target.value === 'none') setRepeat(null);
                    else setRepeatOpen(true);
                  }}
                  className="px-3 py-2 border border-gray-300 rounded text-sm bg-white">
                  <option value="none">Doesn’t repeat</option>
                  <option value="custom">{repeat ? repeat.text || 'Custom…' : 'Custom…'}</option>
                </select>
                {repeat && (
                  <button type="button" onClick={() => setRepeatOpen(true)}
                    className="block text-[11px] text-ooosh-600 hover:underline mt-1">change</button>
                )}
              </label>
              <div className="text-sm">
                {LABEL_SPACER}
                <button type="submit" disabled={!title.trim() || adding}
                  className="px-4 py-2 text-sm rounded bg-ooosh-600 text-white hover:bg-ooosh-700 disabled:opacity-40">
                  {adding ? 'Adding…' : 'Add'}
                </button>
              </div>
            </div>
            <input value={detail} onChange={e => setDetail(e.target.value)} maxLength={4000}
              placeholder="Note (optional) — e.g. the 13A fuses, not the 5A"
              aria-label="Note"
              className="mt-3 w-full px-3 py-2 border border-gray-300 rounded text-sm" />
          </form>
          {repeatOpen && (
            <RecurrenceModal
              startsOn={dueDate || ymdFromToday(0)}
              initial={repeat ?? defaultRepeat(dueDate || ymdFromToday(0))}
              onCancel={() => setRepeatOpen(false)}
              onDone={v => { setRepeat(v); setRepeatOpen(false); }}
            />
          )}

          <div className="bg-white rounded-lg border border-gray-200 divide-y divide-gray-100">
            {open.length === 0 ? (
              <p className="px-4 py-6 text-sm text-gray-400">Nothing on {current.name}.</p>
            ) : open.map(t => {
              const due = fmtDue(t.due_date);
              const taken = !!t.person_id;
              const opens = notOpenYet(t);
              const x = t.source_type === SERIES ? series.find(v => v.id === t.source_id) : undefined;
              if (editingId === t.id) {
                // Anyone may edit an untaken item — move the bins to Thursday
                // this week, fix "mlik" — without dropping and re-adding it.
                return (
                  <TaskEditRow key={t.id} task={t} busy={busyId === t.id}
                    remindLabel="Nudge watchers"
                    onCancel={() => setEditingId(null)}
                    onSave={patch => {
                      const changed = changedFields(t, patch);
                      if (Object.keys(changed).length === 0) { setEditingId(null); return; }
                      void act(t.id, async () => {
                        await api.patch(`/staff-tasks/${t.id}`, changed);
                        setEditingId(null);
                      }, 'Could not save it');
                    }} />
                );
              }
              return (
                <div key={t.id} className="flex items-start gap-3 px-4 py-3">
                  <input type="checkbox" checked={false}
                    // Once taken it's the taker's to tick (from Mine).
                    disabled={taken || busyId === t.id || !!opens}
                    onChange={() => void act(t.id,
                      () => api.patch(`/staff-tasks/${t.id}`, { status: 'done' }), 'Could not tick it')}
                    className="mt-1 h-4 w-4 rounded border-gray-300 text-ooosh-600 disabled:opacity-30"
                    aria-label={`Mark "${t.title}" done`}
                    title={opens ? `Can be ticked from ${opens}` : undefined} />
                  <div className="min-w-0 flex-1">
                    <div className={`text-sm ${taken ? 'text-gray-500' : 'text-gray-900'}`}>{t.title}</div>
                    {t.detail && <div className="text-xs text-gray-500 mt-0.5">{t.detail}</div>}
                    <div className="flex flex-wrap items-center gap-2 mt-1">
                      {t.due_date && <span className={`text-xs ${due.tone}`}>{due.text}</span>}
                      {opens && <span className="text-[11px] text-gray-400">opens {opens}</span>}
                      {taken && (
                        <span className="text-[11px] px-1.5 py-0.5 rounded bg-blue-50 text-blue-700">
                          {t.person_id === me ? 'You’re on it — it’s in Mine' : `${t.owner_name || 'Someone'} is on it`}
                        </span>
                      )}
                      {x && (
                        <SeriesInline series={x} people={people} canChange canStop
                          onChanged={reload} onError={setError} />
                      )}
                    </div>
                  </div>
                  {!taken && (
                    <>
                      <button onClick={() => void act(t.id,
                        () => api.post(`/staff-tasks/${t.id}/take`, {}), 'Could not take it')}
                        disabled={busyId === t.id}
                        className="text-xs text-ooosh-600 hover:text-ooosh-800 disabled:opacity-40 shrink-0">
                        I’ll take it
                      </button>
                      <button onClick={() => setEditingId(t.id)}
                        disabled={busyId === t.id}
                        className="text-xs text-ooosh-600 hover:text-ooosh-800 disabled:opacity-40 shrink-0">
                        Edit
                      </button>
                      <button onClick={() => void act(t.id,
                        () => api.patch(`/staff-tasks/${t.id}`, { status: 'cancelled' }), 'Could not drop it')}
                        disabled={busyId === t.id}
                        className="text-xs text-gray-400 hover:text-gray-600 disabled:opacity-40 shrink-0"
                        title="Not needed after all">
                        Drop
                      </button>
                    </>
                  )}
                </div>
              );
            })}
          </div>

          <SeriesList series={series} people={people} showOwner={false}
            canChange={() => true} canStop={() => true}
            onChanged={reload} onError={setError} />

          {done.length > 0 && (
            <div>
              <h2 className="text-sm font-medium text-gray-700 mb-2">Done in the last 14 days</h2>
              <div className="bg-white rounded-lg border border-gray-200 divide-y divide-gray-100">
                {done.map(t => (
                  <div key={t.id} className="flex items-center gap-3 px-4 py-2">
                    <span className="text-sm text-gray-500 line-through min-w-0 flex-1">{t.title}</span>
                    <span className="text-xs text-gray-400 whitespace-nowrap">
                      {t.owner_name ? `${t.owner_name} · ` : ''}done {fmtShort(t.completed_at)}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}
          <p className="text-xs text-gray-400">
            Anyone can add, tick or drop something here. “I’ll take it” moves it onto your own list;
            “Put back” there returns it. Watchers are nudged about dated items nobody has taken.
          </p>
        </>
      )}
    </div>
  );
}

