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
 *
 * RESTYLE (Me area handoff, Sep 2026): the same calls and rules as before, in
 * the My Time look — a quick-add card that is always there, a green strip
 * that confirms what just happened (with Undo on a tick or a drop), and Mine
 * grouped by when things are due. Presentation only: nothing here decides
 * anything the server didn't already.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
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
  /** Where the source badge links back to (a van sale's follow-up → its sale page). */
  source_link?: string | null;
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

/**
 * How many open to-dos are due today or overdue — the To Do tab's badge.
 * Pure so the Me header can reuse it on the same /staff-tasks/mine rows.
 * `today` is the LOCAL date (YYYY-MM-DD), never a UTC slice; ISO dates sort
 * as strings, so a plain comparison is enough.
 */
export function countDueNow(tasks: { status: string; due_date: string | null }[], today: string): number {
  return tasks.filter(t => t.status === 'open' && !!t.due_date && t.due_date <= today).length;
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

/**
 * "New": given to me by somebody else in the last day. A presentation hint
 * only — the server keeps no "seen" flag, so this is the nearest honest cue.
 */
function isFresh(t: Task): boolean {
  if (!setBySomeoneElse(t)) return false;
  const made = new Date(t.created_at).getTime();
  return !Number.isNaN(made) && Date.now() - made < 86_400_000;
}

/** "Will" from "Will Harris" — for "Give to Will" and "From Will". */
function firstName(name: string | null | undefined): string {
  return (name ?? '').trim().split(/\s+/)[0] || 'them';
}

/** "WH" from "Will Harris" — the little avatar circles. */
function initials(name: string | null | undefined): string {
  const parts = (name ?? '').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return '?';
  return ((parts[0][0] ?? '') + (parts.length > 1 ? parts[parts.length - 1][0] ?? '' : '')).toUpperCase();
}

// ── Shared look ────────────────────────────────────────────────────────────
// The My Time card and header idioms, so the Me tabs read as one thing.

const CARD = 'bg-white border border-gray-200 rounded-xl';
const SUBHEAD = 'px-4 sm:px-5 py-2.5 bg-gray-50 border-b border-gray-100 text-[11px] font-semibold uppercase tracking-[.06em]';
/** A text-button action. 44px tall on a phone so a thumb can hit it. */
const ACT = 'text-[13px] whitespace-nowrap min-h-[44px] sm:min-h-0 hover:underline disabled:opacity-40 disabled:no-underline';
/** Inputs are 16px on a phone — anything smaller and iOS zooms in on focus. */
const INPUT = 'px-3 py-2 border border-gray-300 rounded-lg text-base sm:text-sm bg-white';
const ERROR_BOX = 'rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800';

function Badge({ tone, children, title }: { tone: string; children: React.ReactNode; title?: string }) {
  return (
    <span title={title} className={`text-[11px] font-medium px-[7px] py-0.5 rounded-full whitespace-nowrap ${tone}`}>
      {children}
    </span>
  );
}
const BADGE = {
  fresh: 'bg-amber-100 text-amber-800',
  review: 'bg-ooosh-100 text-ooosh-700',
  from: 'bg-indigo-50 text-indigo-800',
  list: 'bg-emerald-50 text-emerald-700',
  repeat: 'bg-ooosh-50 text-ooosh-700',
  private: 'bg-gray-100 text-gray-600',
};

/**
 * The round tick. 22px to look at; the ::after reaches out to 44px so it is
 * still easy to hit on a phone without pushing the title across.
 */
function TickCircle({ onClick, disabled, label, title, small }: {
  onClick: () => void; disabled?: boolean; label: string; title?: string; small?: boolean;
}) {
  return (
    <button type="button" onClick={onClick} disabled={disabled} aria-label={label} title={title}
      className={`relative flex-none mt-px rounded-full border-2 border-slate-300 bg-white
        hover:border-ooosh-600 hover:bg-ooosh-50 disabled:opacity-30 disabled:hover:border-slate-300
        disabled:hover:bg-white disabled:cursor-not-allowed after:content-[''] after:absolute
        ${small ? 'w-5 h-5 after:-inset-3' : 'w-[22px] h-[22px] after:-inset-[11px]'}`} />
  );
}

/** A side-column card header: title and a one-line explanation. */
function CardHead({ title, sub, right }: { title: string; sub?: React.ReactNode; right?: React.ReactNode }) {
  return (
    <div className="px-4 sm:px-[18px] py-3.5 border-b border-gray-100 flex items-start justify-between gap-3">
      <div className="min-w-0">
        <div className="text-[15px] font-semibold text-gray-900">{title}</div>
        {sub && <div className="text-xs text-gray-500 mt-0.5">{sub}</div>}
      </div>
      {right}
    </div>
  );
}

/**
 * A chip that opens the browser's date picker. The input is invisible and
 * opened with showPicker(); browsers without it fall back to focusing it
 * (the My Time "Earlier…" chip does the same).
 */
function PickDateChip({ value, selected, emptyLabel, ariaLabel, onChange }: {
  value: string; selected: boolean; emptyLabel: string; ariaLabel: string; onChange: (v: string) => void;
}) {
  const ref = useRef<HTMLInputElement>(null);
  return (
    <span className="relative flex-none">
      <button type="button"
        onClick={() => {
          const el = ref.current as (HTMLInputElement & { showPicker?: () => void }) | null;
          try { el?.showPicker ? el.showPicker() : el?.focus(); } catch { el?.focus(); }
        }}
        className={`${CHIP} border-dashed ${selected ? CHIP_ON : 'bg-white border-slate-300 text-gray-700 font-medium hover:border-ooosh-300'}`}>
        {selected && value ? fmtDay(value) : emptyLabel}
      </button>
      <input ref={ref} type="date" tabIndex={-1} aria-label={ariaLabel}
        min={ymdFromToday(0)} value={value}
        onChange={e => onChange(e.target.value)}
        className="absolute inset-0 w-full h-full opacity-0 pointer-events-none" />
    </span>
  );
}
const CHIP = 'inline-flex items-center px-[11px] py-[5px] min-h-[44px] sm:min-h-0 rounded-full border text-[13px] whitespace-nowrap flex-none';
const CHIP_ON = 'bg-ooosh-600 border-ooosh-600 text-white font-semibold';
const CHIP_OFF = 'bg-white border-gray-300 text-gray-700 font-medium hover:border-ooosh-300';

/** What just happened, and (for a tick or a drop) a way back. */
interface Flash { text: string; undo?: () => Promise<void> }
type FlashFn = (text: string, undo?: () => Promise<void>) => void;

const VIEWS = [
  { id: 'mine', label: 'Mine' },
  { id: 'assigned', label: 'Assigned by me' },
  { id: 'lists', label: 'Lists' },
  { id: 'everyone', label: 'Everyone' },
] as const;
type ViewId = (typeof VIEWS)[number]['id'];

/** What each view hands up for the summary beside the view switch. */
type SummaryFn = (text: string) => void;

/**
 * The To Do tab: the quick-add card, the green strip, any repeating to-do
 * somebody wants to give me, the four views, and the people list they share.
 * The views mount rather than route, like the Me page's own tabs.
 */
export default function ToDoPage() {
  const [params, setParams] = useSearchParams();
  const raw = params.get('view');
  const view: ViewId = VIEWS.some(v => v.id === raw) ? (raw as ViewId) : 'mine';
  const [people, setPeople] = useState<Person[]>([]);
  const [me, setMe] = useState<string | null>(null);
  const [summary, setSummary] = useState('');
  const [pageError, setPageError] = useState<string | null>(null);
  // Bumped after the quick-add or an Undo, so whichever view is showing reloads.
  const [refreshKey, setRefreshKey] = useState(0);
  const refresh = useCallback(() => setRefreshKey(k => k + 1), []);

  // My repeating to-dos — here rather than in Mine because the "wants to give
  // you" banners sit above the views and show whichever one is open.
  const [mySeries, setMySeries] = useState<Series[]>([]);
  const loadMySeries = useCallback(async () => {
    try {
      const r = await api.get<{ data: Series[] }>('/staff-tasks/series/mine');
      setMySeries(r.data);
    } catch { /* secondary: a failure here shouldn't blank the page */ }
  }, []);
  useEffect(() => { void loadMySeries(); }, [loadMySeries, refreshKey]);

  const [flashMsg, setFlashMsg] = useState<Flash | null>(null);
  const flashTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const flash: FlashFn = useCallback((text: string, undo?: () => Promise<void>) => {
    if (flashTimer.current) clearTimeout(flashTimer.current);
    setFlashMsg({ text, undo });
    flashTimer.current = setTimeout(() => setFlashMsg(null), 6000);
  }, []);
  useEffect(() => () => { if (flashTimer.current) clearTimeout(flashTimer.current); }, []);

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
    setSummary('');
    setParams(next, { replace: true });
  }

  async function respond(x: Series, accept: boolean) {
    let reason: string | null = null;
    if (!accept) {
      reason = window.prompt(`Decline “${x.title}”? Say why — ${x.set_by_name || 'they'} will see it:`);
      if (reason === null) return;
      if (!reason.trim()) { setPageError('Say why you’re declining.'); return; }
    }
    setPageError(null);
    try {
      await api.post(`/staff-tasks/series/${x.id}/respond`, { accept, reason });
      flash(accept
        ? `Accepted “${x.title}” — it’s on your list.`
        : `Declined — ${firstName(x.set_by_name)} will see why.`);
      refresh();
    } catch (err) {
      setPageError(err instanceof Error ? err.message : 'Could not answer');
    }
  }

  async function runUndo(f: Flash) {
    setFlashMsg(null);
    try {
      await f.undo?.();
      // Whichever view is showing now reloads — it may not be the one that
      // made the strip.
      refresh();
    } catch (err) {
      setPageError(err instanceof Error ? err.message : 'Could not undo that');
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <h1 className="sr-only">To Do</h1>

      <QuickAdd others={others} flash={flash} onError={setPageError}
        onAdded={refresh} />

      {flashMsg && (
        <div role="status"
          className="flex items-center justify-between gap-3 px-3.5 py-2.5 rounded-lg border border-emerald-200 bg-emerald-50 text-sm text-emerald-800">
          <span className="min-w-0">{flashMsg.text}</span>
          {flashMsg.undo && (
            <button type="button" onClick={() => void runUndo(flashMsg)}
              className="font-semibold hover:underline min-h-[44px] sm:min-h-0 px-1">Undo</button>
          )}
        </div>
      )}

      {pageError && <div className={ERROR_BOX}>{pageError}</div>}

      {mySeries.filter(x => x.status === 'proposed').map(x => (
        <div key={x.id}
          className="flex flex-wrap items-center justify-between gap-x-4 gap-y-3 px-4 sm:px-[18px] py-3.5 rounded-xl border border-amber-200 bg-amber-50">
          <p className="text-sm text-gray-900 leading-normal min-w-0">
            <strong>{x.set_by_name || 'Someone'}</strong> wants to give you a repeating to-do:
            {' '}<strong>“{x.title}”</strong> — {x.rule_text.charAt(0).toLowerCase() + x.rule_text.slice(1)}.
          </p>
          <div className="flex gap-2">
            <button onClick={() => void respond(x, true)}
              className="px-3.5 py-2 min-h-[44px] sm:min-h-0 text-sm font-semibold rounded-lg bg-ooosh-600 text-white hover:bg-ooosh-700 whitespace-nowrap">
              Accept
            </button>
            <button onClick={() => void respond(x, false)}
              className="px-3.5 py-2 min-h-[44px] sm:min-h-0 text-sm font-medium rounded-lg border border-gray-300 bg-white text-gray-700 hover:bg-gray-50 whitespace-nowrap">
              Decline…
            </button>
          </div>
        </div>
      ))}

      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap gap-[3px] rounded-lg bg-gray-100 p-[3px]" role="tablist" aria-label="To Do views">
          {VIEWS.map(v => (
            <button key={v.id} role="tab" aria-selected={view === v.id}
              onClick={() => select(v.id)}
              className={`px-3.5 py-1.5 min-h-[44px] sm:min-h-0 text-sm rounded-md whitespace-nowrap ${view === v.id
                ? 'bg-white shadow-sm text-gray-900 font-semibold' : 'text-gray-500 font-medium hover:text-gray-900'}`}>
              {v.label}
            </button>
          ))}
        </div>
        {summary && <div className="text-[13px] text-gray-500">{summary}</div>}
      </div>

      {view === 'mine' && (
        <MineView people={people} series={mySeries} reloadSeries={loadMySeries}
          refreshKey={refreshKey} flash={flash} onSummary={setSummary} />
      )}
      {view === 'assigned' && (
        <AssignedView people={people} refreshKey={refreshKey} flash={flash} onSummary={setSummary} />
      )}
      {view === 'lists' && (
        <ListsView people={people} me={me} refreshKey={refreshKey} flash={flash} onSummary={setSummary} />
      )}
      {view === 'everyone' && <EveryoneView people={people} refreshKey={refreshKey} onSummary={setSummary} />}
    </div>
  );
}

type RepeatPreset = 'none' | 'week' | 'month' | 'custom';

/**
 * The two one-tap repeats, in exactly the shape the Custom form builds for the
 * same choice (RecurrenceFields: defaultRepeat for weekly; setFreq('month')
 * for monthly, on the start date's day). The server's words for it come back
 * on the series; nothing here works out when it falls.
 */
function presetRepeat(preset: RepeatPreset, startsOn: string, custom: RepeatValue | null): RepeatValue | null {
  if (preset === 'week') return defaultRepeat(startsOn);
  if (preset === 'month') {
    const day = Number(startsOn.slice(8, 10));
    return {
      mode: 'schedule',
      rule: { freq: 'month', interval: 1, monthly: { type: 'day', day: day >= 1 && day <= 31 ? day : 1 } },
      endsOn: null, endsAfter: null, text: '',
    };
  }
  if (preset === 'custom') return custom;
  return null;
}

/** Days to the next given weekday (0 = Sunday … 6 = Saturday), never 0. */
function daysToNext(weekday: number): number {
  const d = (weekday - new Date().getDay() + 7) % 7;
  return d === 0 ? 7 : d;
}

/**
 * The quick add — always there, for the common case: a title, a due chip,
 * who it's for, whether it repeats. Custom repeats open the full Repeat form.
 * The same two calls, with the same payloads, as the add form it replaces.
 */
function QuickAdd({ others, flash, onError, onAdded }: {
  others: Person[];
  flash: FlashFn;
  onError: (msg: string | null) => void;
  onAdded: () => void;
}) {
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
  // Repeating (TASKS-SPEC §6): 'none' = a one-off.
  const [preset, setPreset] = useState<RepeatPreset>('none');
  const [custom, setCustom] = useState<RepeatValue | null>(null);
  const [repeatOpen, setRepeatOpen] = useState(false);

  const today = ymdFromToday(0);
  const chips: { value: string; label: string }[] = [
    { value: '', label: 'No date' },
    { value: today, label: 'Today' },
    { value: ymdFromToday(1), label: 'Tomorrow' },
  ];
  const friday = ymdFromToday(daysToNext(5));
  // On a Thursday "Fri" IS tomorrow — one chip for one date.
  if (!chips.some(c => c.value === friday)) chips.push({ value: friday, label: fmtDay(friday) });
  const nextWeek = ymdFromToday(daysToNext(1));
  if (!chips.some(c => c.value === nextWeek)) chips.push({ value: nextWeek, label: 'Next week' });
  const picked = !!dueDate && !chips.some(c => c.value === dueDate);

  const startsOn = dueDate || today;
  const repeating = preset !== 'none';
  const who = forPerson ? others.find(p => p.person_id === forPerson) : undefined;
  const first = forPerson ? firstName(who?.name) : null;

  let hint: string;
  if (first && repeating) hint = `${first} will be asked to accept a repeating to-do before it starts.`;
  else if (first) hint = `It goes on ${first}’s list. You’ll get your own follow-up reminder.`;
  else if (repeating) {
    const words = preset === 'week' ? 'every week' : preset === 'month' ? 'every month'
      : custom?.text ? custom.text.charAt(0).toLowerCase() + custom.text.slice(1) : 'on your custom schedule';
    hint = `Repeats ${words}, starting ${fmtDay(startsOn)}.`;
  } else if (remindOn || dueDate) hint = `We’ll nudge you on ${fmtDay(remindOn || dueDate)}.`;
  else hint = 'No date? We’ll still nudge you in a fortnight so it doesn’t get lost.';

  async function add(e: React.FormEvent) {
    e.preventDefault();
    if (!title.trim() || adding) return;
    setAdding(true);
    onError(null);
    const name = title.trim();
    try {
      const repeat = presetRepeat(preset, startsOn, custom);
      if (repeat) {
        // A repeating one is a SERIES; its first occurrence is made from it.
        // For somebody else the server makes it a proposal they accept or
        // decline (the "wants to give you" banner on their side).
        await api.post('/staff-tasks/series', {
          title: name,
          mode: repeat.mode, rule: repeat.rule,
          startsOn,
          ...(repeat.endsOn ? { endsOn: repeat.endsOn } : {}),
          ...(repeat.endsAfter ? { endsAfter: repeat.endsAfter } : {}),
          ...(forPerson ? { personId: forPerson } : {}),
          ...(isPrivate ? { isPrivate: true } : {}),
        });
        setTitle(''); setDueDate(''); setRemindOn(''); setIsPrivate(false);
        setPreset('none'); setCustom(null);
        flash(first
          ? `Sent to ${first} — they’ll be asked to accept it before it starts.`
          : `Added “${name}” as a repeating to-do.`);
        onAdded();
        return;
      }
      await api.post('/staff-tasks', {
        title: name,
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
      flash(first ? `Given to ${first} — it’s on their list now.` : `Added “${name}”`);
      onAdded();
    } catch (err) {
      onError(err instanceof Error ? err.message : 'Could not add the task');
    } finally {
      setAdding(false);
    }
  }

  const valid = !!title.trim();
  const label = 'text-xs text-gray-500';
  const select = 'px-2 py-[5px] min-h-[44px] sm:min-h-0 border border-gray-300 rounded-lg text-base sm:text-[13px] bg-white text-gray-900';

  return (
    <form onSubmit={add} className={`${CARD} px-4 sm:px-5 py-4 sm:py-[18px] flex flex-col gap-3.5`}>
      <div className="flex gap-3 items-stretch">
        <input
          value={title}
          onChange={e => setTitle(e.target.value)}
          placeholder="Add a to-do… e.g. Book Will’s first-aid refresher"
          aria-label="Add a to-do"
          maxLength={300}
          className="flex-1 min-w-0 px-3.5 py-3 border border-gray-300 rounded-lg text-base text-gray-900"
        />
        <button
          type="submit"
          disabled={!valid || adding}
          className={`px-4 sm:px-[22px] rounded-lg text-[15px] font-semibold text-white whitespace-nowrap ${valid
            ? 'bg-ooosh-600 hover:bg-ooosh-700' : 'bg-slate-300 cursor-not-allowed'}`}
        >
          {adding ? 'Adding…' : first ? `Give to ${first}` : 'Add'}
        </button>
      </div>

      <div className="flex flex-wrap items-center gap-x-5 gap-y-2">
        <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label={repeating ? 'Starts' : 'Due'}>
          <span className={`${label} mr-0.5`}>{repeating ? 'Starts' : 'Due'}</span>
          {/* A repeating one always starts somewhere — no date means today,
              so "No date" goes and Today lights up instead. */}
          {chips.filter(c => !(repeating && c.value === '')).map(c => {
            const on = dueDate === c.value || (repeating && !dueDate && c.value === today);
            return (
              <button key={c.label} type="button" onClick={() => setDueDate(c.value)}
                aria-pressed={on}
                className={`${CHIP} ${on ? CHIP_ON : CHIP_OFF}`}>
                {c.label}
              </button>
            );
          })}
          <PickDateChip value={dueDate} selected={picked} emptyLabel="Pick…"
            ariaLabel={repeating ? 'Pick a start date' : 'Pick a due date'} onChange={setDueDate} />
        </div>

        {/* The owner's own nudge — the old "Remind me" box. Not for a
            repeating one: each occurrence is chased from its own date. */}
        {!repeating && (
          <div className="flex items-center gap-1.5">
            <span className={label}>Remind me</span>
            <PickDateChip value={remindOn} selected={!!remindOn} emptyLabel="Default"
              ariaLabel="Remind me on" onChange={setRemindOn} />
            {remindOn && (
              <button type="button" onClick={() => setRemindOn('')} aria-label="Clear the reminder date"
                className="text-[13px] text-gray-400 hover:text-gray-600 min-h-[44px] min-w-[32px] sm:min-h-0 sm:min-w-0">×</button>
            )}
          </div>
        )}

        <label className="flex items-center gap-1.5">
          <span className={label}>For</span>
          <select value={forPerson} onChange={e => setForPerson(e.target.value)} className={select}>
            <option value="">Me</option>
            {/* Keep a picked person selectable if the list reloads without them. */}
            {forPerson && !others.some(p => p.person_id === forPerson) && (
              <option value={forPerson}>Someone else</option>
            )}
            {others.map(p => <option key={p.person_id} value={p.person_id}>{p.name ?? 'Unnamed'}</option>)}
          </select>
        </label>

        <div className="flex items-center gap-1.5">
          <label className="flex items-center gap-1.5">
            <span className={label}>Repeats</span>
            <select value={preset}
              onChange={e => {
                const v = e.target.value as RepeatPreset;
                if (v === 'custom') setRepeatOpen(true);
                else setPreset(v);
              }}
              className={select}>
              <option value="none">Doesn’t repeat</option>
              <option value="week">Every week</option>
              <option value="month">Every month</option>
              <option value="custom">{preset === 'custom' && custom?.text ? custom.text : 'Custom…'}</option>
            </select>
          </label>
          {preset === 'custom' && (
            <button type="button" onClick={() => setRepeatOpen(true)}
              className="text-[13px] text-ooosh-600 hover:underline min-h-[44px] sm:min-h-0">change</button>
          )}
        </div>

        <label className="flex items-center gap-1.5 text-[13px] text-gray-700 cursor-pointer min-h-[44px] sm:min-h-0"
          title="Only you, whoever it’s for, and admins will see it">
          <input type="checkbox" checked={isPrivate} onChange={e => setIsPrivate(e.target.checked)}
            className="h-4 w-4 m-0 rounded border-gray-300" />
          Private
        </label>
      </div>

      <p className="text-xs text-gray-400">{hint}</p>

      {repeatOpen && (
        <RecurrenceModal
          startsOn={startsOn}
          initial={custom ?? presetRepeat(preset, startsOn, null) ?? defaultRepeat(startsOn)}
          onCancel={() => setRepeatOpen(false)}
          onDone={v => { setCustom(v); setPreset('custom'); setRepeatOpen(false); }}
        />
      )}
    </form>
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

/** "Thu 1 Oct" (with the year when it isn't this one). '—' if unparseable. */
function fmtDay(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso.length === 10 ? `${iso}T00:00:00Z` : iso);
  if (Number.isNaN(d.getTime())) return '—';
  const wd = d.toLocaleDateString('en-GB', { weekday: 'short', timeZone: 'UTC' });
  const dm = d.toLocaleDateString('en-GB', {
    day: 'numeric', month: 'short',
    year: d.getUTCFullYear() === new Date().getFullYear() ? undefined : 'numeric',
    timeZone: 'UTC',
  });
  return `${wd} ${dm}`;
}

/** Whole days from LOCAL today to a YYYY-MM-DD; null when there's no usable date. */
function daysAway(iso: string | null): number | null {
  if (!iso) return null;
  const [y, m, d] = iso.split('-').map(Number);
  const due = Date.UTC(y, m - 1, d);
  if (Number.isNaN(due)) return null;
  const today = new Date();
  const todayUtc = Date.UTC(today.getFullYear(), today.getMonth(), today.getDate());
  return Math.round((due - todayUtc) / 86_400_000);
}

function fmtDue(iso: string | null): { text: string; tone: string } {
  if (!iso) return { text: 'No date', tone: 'text-gray-400' };
  const days = daysAway(iso);
  if (days === null) return { text: '—', tone: 'text-gray-400' };
  if (days < 0) {
    return { text: `${fmtDay(iso)} · ${-days} day${days === -1 ? '' : 's'} overdue`, tone: 'text-red-700' };
  }
  if (days === 0) return { text: 'Due today', tone: 'text-amber-700' };
  if (days === 1) return { text: 'Due tomorrow', tone: 'text-amber-700' };
  return { text: `Due ${fmtDay(iso)}`, tone: 'text-gray-600' };
}

/** Mine's groups, in order. "This week" is the next five days. */
const DUE_GROUPS: { id: string; label: string; tone: string; test: (days: number | null) => boolean }[] = [
  { id: 'overdue', label: 'Overdue', tone: 'text-red-700', test: d => d !== null && d < 0 },
  { id: 'today', label: 'Today', tone: 'text-amber-700', test: d => d === 0 },
  { id: 'week', label: 'This week', tone: 'text-gray-700', test: d => d !== null && d > 0 && d <= 5 },
  { id: 'later', label: 'Later', tone: 'text-gray-500', test: d => d !== null && d > 5 },
  { id: 'none', label: 'No date', tone: 'text-gray-500', test: d => d === null },
];

// A repeating to-do's occurrence carries its series' words instead of a
// badge (SeriesInline), so it isn't listed here.
const SOURCE_LABEL: Record<string, string> = {
  staff_review: 'From your review',
  vehicle_sale: 'Van sale',
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
    <div className={`${CARD} overflow-hidden`}>
      <CardHead title="Repeating" sub="Nothing open for these right now" />
      <div className="divide-y divide-gray-100">
        {idle.map(s => (
          <div key={s.id} className="px-4 sm:px-[18px] py-3 flex flex-wrap items-start justify-between gap-x-3 gap-y-1">
            <div className="min-w-0 flex-1">
              <div className="text-sm text-gray-900">
                {s.title}
                {showOwner && <span className="text-gray-500"> — {s.owner_name}</span>}
              </div>
              <div className="text-xs text-gray-500 mt-[3px]">
                ↻ {s.rule_text}
                {s.status === 'active' && s.next_on && <> · next {fmtDay(s.next_on)}</>}
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
            <div className="flex items-center gap-2.5">
              {s.is_private && <Badge tone={BADGE.private}>Private</Badge>}
              {canChange(s) && s.status !== 'ended' && (
                <button onClick={() => setEditing(s)} className={`${ACT} text-ooosh-600`}>Change</button>
              )}
              {canStop(s) && (s.status === 'active' || s.status === 'proposed') && (
                <button onClick={() => { void stopSeries(s).then(onChanged).catch(e => onError(e instanceof Error ? e.message : 'Could not stop it')); }}
                  className={`${ACT} text-gray-400 hover:text-gray-600`}>Stop</button>
              )}
            </div>
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
    <span className="inline-flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px]">
      <Badge tone={BADGE.repeat} title="Repeats">↻ {series.rule_text}</Badge>
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

function MineView({ people, series, reloadSeries, refreshKey, flash, onSummary }: {
  people: Person[];
  /** GET /staff-tasks/series/mine — loaded by the page for the proposal banners. */
  series: Series[];
  reloadSeries: () => Promise<void>;
  refreshKey: number;
  flash: FlashFn;
  onSummary: SummaryFn;
}) {
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
  const [reminders, setReminders] = useState<JobReminder[]>([]);
  const [problems, setProblems] = useState<MyProblem[]>([]);

  const load = useCallback(async () => {
    setLoadError(null);
    try {
      // Finished ones come too, so "Show recently finished (n)" can say n.
      const res = await api.get<{ data: Task[]; linked: boolean; me?: string }>(
        '/staff-tasks/mine?includeDone=true');
      setTasks(res.data);
      setLinked(res.linked);
      setMe(res.me ?? null);
      // Secondary: a failure here shouldn't blank the list above it.
      api.get<{ data: { reminders: JobReminder[]; problems: MyProblem[] } }>('/staff-tasks/pullins')
        .then(r => { setReminders(r.data.reminders); setProblems(r.data.problems); })
        .catch(() => undefined);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : 'Could not load your to-do list');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load, refreshKey]);

  /** The task list and my repeating to-dos both move when a series row does. */
  const reloadAll = useCallback(async () => {
    await Promise.all([load(), reloadSeries()]);
  }, [load, reloadSeries]);

  /**
   * Undo for a tick or a drop: put it back to open. NEVER for a repeating
   * to-do's occurrence — closing one has already made the next one, so
   * re-opening would leave two open and the module is one-open-at-a-time.
   */
  function undoFor(task: Task): (() => Promise<void>) | undefined {
    if (task.source_type === SERIES) return undefined;
    // Nor when the setter has a follow-up date on it: closing clears their
    // clock and re-opening cannot put it back, so Undo would quietly switch
    // off somebody else's reminder.
    if (task.follow_up_on) return undefined;
    return async () => { await api.patch(`/staff-tasks/${task.id}`, { status: 'open' }); };
  }

  async function setStatus(task: Task, status: Task['status']) {
    setBusyId(task.id);
    try {
      await api.patch(`/staff-tasks/${task.id}`, { status });
      if (status === 'done') {
        flash(task.source_type === SERIES
          ? `Ticked off “${task.title}” — the next one’s on its way.`
          : `Ticked off “${task.title}”`, undoFor(task));
      } else if (status === 'cancelled') {
        flash(`Dropped “${task.title}”`, undoFor(task));
      } else if (status === 'open') {
        flash(`Re-opened “${task.title}”`);
      }
      // A closed occurrence makes the next one (spec §6.3) — the series moves too.
      await (task.source_type === SERIES ? reloadAll() : load());
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : 'Could not update the task');
    } finally {
      setBusyId(null);
    }
  }

  /** Tick a job reminder — through the job module's own endpoint (spec §2). */
  async function tickReminder(r: JobReminder) {
    setBusyId(r.id);
    try {
      await api.patch(`/requirements/${r.id}`, { status: 'done' });
      flash('Reminder ticked off on the job.');
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
      flash(`Back on ${task.list_name ? `the ${task.list_name} list` : 'its list'} for someone else.`);
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
      flash(`Handed back to ${task.set_by_name || 'whoever set it'}.`);
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
      flash('Saved.');
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

  const overdue = open.filter(t => { const d = daysAway(t.due_date); return d !== null && d < 0; }).length;
  const dueToday = open.filter(t => daysAway(t.due_date) === 0).length;
  const summary = loading || loadError ? ''
    : [overdue && `${overdue} overdue`, dueToday && `${dueToday} due today`, `${open.length} open`]
      .filter(Boolean).join(' · ');
  useEffect(() => { onSummary(summary); }, [summary, onSummary]);

  const groups = DUE_GROUPS.map(g => ({
    ...g,
    rows: open.filter(t => g.test(daysAway(t.due_date)))
      .sort((a, b) => (a.due_date ?? '').localeCompare(b.due_date ?? '')),
  })).filter(g => g.rows.length);

  function row(task: Task) {
    const due = fmtDue(task.due_date);
    const opens = notOpenYet(task);
    if (editingId === task.id) {
      return (
        <TaskEditRow key={task.id} task={task} busy={busyId === task.id}
          onCancel={() => setEditingId(null)}
          onSave={patch => void saveEdit(task, patch)} />
      );
    }
    const x = task.source_type === SERIES ? series.find(v => v.id === task.source_id) : undefined;
    return (
      <div key={task.id}
        className="flex flex-wrap sm:flex-nowrap items-start gap-x-3.5 gap-y-0.5 px-4 sm:px-5 py-3.5 border-b border-gray-100 hover:bg-gray-50/40">
        <TickCircle
          onClick={() => void setStatus(task, 'done')}
          disabled={busyId === task.id || !!opens}
          label={`Mark "${task.title}" done`}
          title={opens ? `Can be ticked from ${opens}` : undefined}
        />
        <div className="min-w-0 flex-1">
          <div className="text-[15px] leading-snug text-gray-900">{task.title}</div>
          {task.detail && <div className="text-[13px] text-gray-500 mt-0.5">{task.detail}</div>}
          {task.handed_back_reason && (
            <div className="text-[13px] text-amber-800 mt-[3px]">
              Handed back by {task.handed_back_by_name || 'someone'}: “{task.handed_back_reason}”
            </div>
          )}
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5 mt-[5px]">
            <span className={`text-[13px] font-medium ${due.tone}`}>{due.text}</span>
            {opens && <span className="text-[11px] text-gray-400">opens {opens}</span>}
            {task.next_chase_date && (
              <span className="text-[11px] text-gray-400">nudge {fmtShort(task.next_chase_date)}</span>
            )}
            {isFresh(task) && <Badge tone={BADGE.fresh}>New</Badge>}
            {SOURCE_LABEL[task.source_type] && (
              task.source_link
                ? <Link to={task.source_link} className="hover:opacity-80"><Badge tone={BADGE.review}>{SOURCE_LABEL[task.source_type]}</Badge></Link>
                : <Badge tone={BADGE.review}>{SOURCE_LABEL[task.source_type]}</Badge>
            )}
            {setBySomeoneElse(task) && task.source_type !== 'staff_review' && (
              <Badge tone={BADGE.from} title={task.set_by_name ?? undefined}>From {firstName(task.set_by_name)}</Badge>
            )}
            {task.list_id && <Badge tone={BADGE.list}>{task.list_name || 'A'} list</Badge>}
            {task.is_private && <Badge tone={BADGE.private}>Private</Badge>}
            {x && (
              <SeriesInline series={x} people={people}
                // Your own series you can change; one somebody set for you, only stop.
                // A list's repeating to-do is the list's — changed from Lists.
                canChange={!!me && x.set_by_person_id === me && !x.list_id}
                canStop={!x.list_id}
                onChanged={reloadAll} onError={m => setLoadError(m)} />
            )}
          </div>
        </div>
        {/* Phone: the actions drop to their own line, lined up with the title
            (22px tick + 14px gap = 36px). */}
        <div className="w-full sm:w-auto flex-none flex items-center gap-5 sm:gap-3.5 pl-9 sm:pl-0 sm:pt-0.5">
          <button onClick={() => setEditingId(task.id)} disabled={busyId === task.id}
            className={`${ACT} text-ooosh-600`}>
            Edit
          </button>
          {setBySomeoneElse(task) && task.source_type !== SERIES && (
            <button onClick={() => void handBack(task)} disabled={busyId === task.id}
              className={`${ACT} text-gray-500`}
              title={`Give it back to ${task.set_by_name || 'whoever set it'}, with a reason`}>
              Hand back
            </button>
          )}
          {task.list_id && (
            <button onClick={() => void putBack(task)} disabled={busyId === task.id}
              className={`${ACT} text-gray-500`}
              title={`Back on ${task.list_name || 'the list'} for someone else`}>
              Put back
            </button>
          )}
          <button onClick={() => void setStatus(task, 'cancelled')} disabled={busyId === task.id}
            className={`${ACT} text-gray-400`}
            title="Not doing this after all">
            Drop
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">

      {loadError && <div className={ERROR_BOX}>{loadError}</div>}

      {!linked && !loading && (
        <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
          Your login isn’t linked to a staff record yet, so there’s nothing to show.
          An admin can link it on the Staff page.
        </div>
      )}

      <div className="flex flex-wrap items-start gap-4">
        <div className="flex-[2_1_520px] min-w-0 flex flex-col gap-4">
          <div className={`${CARD} overflow-hidden [&>*:last-child]:border-b-0`}>
            {loading ? (
              <p className="px-5 py-6 text-sm text-gray-500">Loading…</p>
            ) : open.length === 0 ? (
              <p className="px-5 py-9 text-center text-[15px] text-gray-500">
                {loadError ? 'Your list couldn’t be loaded.' : 'Nothing outstanding — nice.'}
              </p>
            ) : groups.flatMap(g => [
              <div key={`h-${g.id}`} className={`${SUBHEAD} flex items-center gap-2 ${g.tone}`}>
                {g.label}<span className="text-gray-400 font-medium">{g.rows.length}</span>
              </div>,
              ...g.rows.map(row),
            ])}
          </div>

          <div className="flex flex-col gap-2.5">
            <button
              onClick={() => setShowDone(v => !v)}
              className="self-start text-sm text-ooosh-600 hover:underline min-h-[44px] sm:min-h-0"
            >
              {showDone ? 'Hide recently finished' : `Show recently finished (${done.length})`}
            </button>
            {showDone && !loading && (
              <div className={`${CARD} overflow-hidden divide-y divide-gray-100`}>
                {done.length === 0 ? (
                  <p className="px-5 py-4 text-sm text-gray-400">Nothing finished in the last 30 days.</p>
                ) : done.map(task => handedBackByMe(task) ? (
                  <div key={task.id} className="flex items-center gap-3.5 px-4 sm:px-5 py-[11px] opacity-70">
                    <span className="w-[22px] h-[22px] shrink-0" aria-hidden />
                    <span className="text-sm text-gray-400 italic min-w-0 flex-1">{task.title}</span>
                    <span className="text-xs text-gray-400 italic text-right">
                      handed back to {task.owner_name || 'whoever set it'}
                      {task.handed_back_at && <> · {fmtShort(task.handed_back_at)}</>}
                    </span>
                  </div>
                ) : (
                  <div key={task.id} className="flex items-center gap-3.5 px-4 sm:px-5 py-[11px]">
                    {/* No re-open for a repeating to-do's occurrence: closing it
                        already made the next one, and re-opening would leave two
                        open at once (one-open-at-a-time, TASKS-SPEC §6.3). */}
                    <button type="button"
                      disabled={busyId === task.id || task.source_type === SERIES}
                      onClick={() => void setStatus(task, 'open')}
                      aria-label={task.source_type === SERIES ? 'Done' : `Re-open "${task.title}"`}
                      title={task.source_type === SERIES ? 'Repeating — the next one is already on your list' : 'Re-open'}
                      className="relative flex-none w-[22px] h-[22px] rounded-full bg-emerald-500 enabled:hover:bg-emerald-600 text-white text-xs font-bold disabled:cursor-default after:content-[''] after:absolute after:-inset-[11px]">
                      ✓
                    </button>
                    <span className="text-sm text-gray-500 line-through min-w-0 flex-1">{task.title}</span>
                    <span className="text-xs text-gray-400 text-right">
                      {task.due_date && <>due {fmtShort(task.due_date)} · </>}
                      done {task.due_date ? fmtShort(task.completed_at) : fmtDay(task.completed_at)}
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

        <div className="flex-[1_1_300px] min-w-0 flex flex-col gap-4">
          <div className={`${CARD} overflow-hidden`}>
            <CardHead title="From jobs" sub="Reminders and problems with your name on" />
            <div className="divide-y divide-gray-100">
              {reminders.map(r => {
                const due = fmtDue(r.due_date);
                return (
                  <div key={r.id} className="flex items-start gap-3 px-4 sm:px-[18px] py-3">
                    <TickCircle small onClick={() => void tickReminder(r)} disabled={busyId === r.id}
                      label={`Mark reminder "${r.custom_label || 'Reminder'}" done`} />
                    <div className="min-w-0 flex-1">
                      <div className="text-sm text-gray-900">{r.custom_label || 'Reminder'}</div>
                      <div className="flex flex-wrap items-center gap-x-1.5 gap-y-1 mt-[3px] text-xs">
                        <span className={`font-medium ${due.tone}`}>{due.text}</span>
                        <Link to={`/jobs/${r.job_id}`} className="text-ooosh-600 hover:underline">
                          Job {r.hh_job_number ?? ''}{r.job_name ? ` · ${r.job_name}` : ''}
                        </Link>
                      </div>
                    </div>
                  </div>
                );
              })}
              {problems.map(p => (
                <div key={p.id} className="flex items-start gap-3 px-4 sm:px-[18px] py-3">
                  <span className="flex-none w-5 h-5 mt-px rounded-full bg-red-100 text-red-700 text-xs font-bold flex items-center justify-center" aria-hidden>!</span>
                  <div className="min-w-0 flex-1">
                    <div className="text-sm text-gray-900">{p.summary}</div>
                    <div className="flex flex-wrap items-center gap-x-1.5 gap-y-1 mt-[3px] text-xs">
                      <span className="px-[7px] py-px rounded-full bg-red-100 text-red-700 font-medium">
                        {p.severity === 'urgent' ? 'Urgent · ' : 'Problem · '}{PROBLEM_STATUS[p.status] ?? p.status}
                      </span>
                      {p.hh_job_number && <span className="text-gray-500">Job {p.hh_job_number}</span>}
                    </div>
                  </div>
                  {/* A Problem has its own workflow (quote, action, resolve) —
                      it is worked on its own page, not ticked off here. */}
                  <Link to={`/operations/problems/${p.id}`}
                    className="text-[13px] font-medium text-ooosh-600 hover:underline shrink-0 min-h-[44px] sm:min-h-0">
                    Open
                  </Link>
                </div>
              ))}
              {reminders.length === 0 && problems.length === 0 && (
                <p className="px-4 sm:px-[18px] py-4 text-[13px] text-gray-500">Nothing from jobs.</p>
              )}
            </div>
          </div>

          <SeriesList
            series={series.filter(x => x.status === 'active')}
            people={people}
            showOwner={false}
            // Your own series you can change; one somebody set for you, only stop.
            canChange={x => !!me && x.set_by_person_id === me}
            canStop={() => true}
            onChanged={reloadAll}
            onError={m => setLoadError(m)}
          />
        </div>
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
    <div className="px-4 sm:px-5 py-3.5 bg-ooosh-50/40 border-b border-gray-100 space-y-2">
      <input value={title} onChange={e => setTitle(e.target.value)} maxLength={300}
        aria-label="Title"
        className={`w-full ${INPUT}`} />
      <textarea value={detail} onChange={e => setDetail(e.target.value)} rows={2} maxLength={4000}
        placeholder="Detail (optional)"
        className={`w-full ${INPUT}`} />
      <div className="flex flex-wrap items-start gap-3">
        <label className="text-sm">
          <span className="block text-xs text-gray-500 mb-1">Due</span>
          <ForwardDateInput value={dueDate} onChange={setDueDate} ariaLabel="Due" className={INPUT} />
        </label>
        <label className="text-sm">
          <span className="block text-xs text-gray-500 mb-1">{remindLabel}</span>
          <ForwardDateInput value={remindOn} onChange={setRemindOn} ariaLabel={remindLabel} className={INPUT} />
        </label>
        <span className="text-[11px] text-gray-400 sm:mt-6 max-w-[16rem]">
          Blank = never nudge. Moving the due date moves the reminder with it unless you set one here.
        </span>
        <div className="ml-auto flex gap-2 sm:mt-5">
          <button onClick={onCancel} disabled={busy}
            className="px-3.5 py-2 min-h-[44px] sm:min-h-0 text-sm font-medium rounded-lg border border-gray-300 bg-white text-gray-700 hover:bg-gray-50 disabled:opacity-40">
            Cancel
          </button>
          <button
            onClick={() => onSave({
              title: title.trim(), detail: detail.trim() || null,
              dueDate: dueDate || null, nextChaseDate: remindOn || null,
            })}
            disabled={busy || !title.trim()}
            className="px-3.5 py-2 min-h-[44px] sm:min-h-0 text-sm font-semibold rounded-lg bg-ooosh-600 text-white hover:bg-ooosh-700 disabled:opacity-40">
            {busy ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  );
}

/** The 26px initials circle beside a name. */
function Avatar({ name, size = 26 }: { name: string | null; size?: 26 | 28 }) {
  return (
    <span aria-hidden
      className={`flex-none rounded-full bg-ooosh-100 text-ooosh-700 text-[11px] font-bold flex items-center justify-center ${size === 28 ? 'w-7 h-7' : 'w-[26px] h-[26px]'}`}>
      {initials(name)}
    </span>
  );
}

/**
 * What I gave to other people (spec §5.2), with MY follow-up date — the
 * setter's own clock, separate from the owner's nudge. "Reset the follow-up"
 * is just moving that date; the server re-arms it.
 */
function AssignedView({ people, refreshKey, flash, onSummary }: {
  people: Person[];
  refreshKey: number;
  flash: FlashFn;
  onSummary: SummaryFn;
}) {
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
  useEffect(() => { void load(); }, [load, refreshKey]);

  async function patch(task: Task, body: Record<string, unknown>, done?: string) {
    setBusyId(task.id);
    try {
      await api.patch(`/staff-tasks/${task.id}`, body);
      if (done) flash(done);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not update the task');
    } finally {
      setBusyId(null);
    }
  }

  const open = tasks.filter(t => t.status === 'open');
  const done = tasks.filter(t => t.status === 'done');

  const summary = loading || error ? '' : `${open.length} still open with other people`;
  useEffect(() => { onSummary(summary); }, [summary, onSummary]);

  if (loading) return <p className="text-sm text-gray-500">Loading…</p>;
  // Phone: two columns — title / who on the first line, date / Drop on the second.
  const cols = 'grid grid-cols-[minmax(0,1fr)_auto] sm:grid-cols-[minmax(0,1fr)_150px_150px_60px]';
  return (
    <div className="flex flex-col gap-4">
      {error && <div className={ERROR_BOX}>{error}</div>}
      <div className={`${CARD} overflow-hidden`}>
        <div className={`${SUBHEAD} ${cols} gap-3.5 text-gray-500 hidden sm:grid`}>
          <span>Task</span><span>With</span><span>Your follow-up</span><span />
        </div>
        {open.length === 0 ? (
          <p className="px-5 py-6 text-sm text-gray-400">
            {error ? 'Couldn’t load these.' : 'Nothing you’ve given anyone is still open.'}
          </p>
        ) : open.map(task => {
          const due = fmtDue(task.due_date);
          return (
            <div key={task.id} className={`${cols} gap-x-3.5 gap-y-2.5 items-center px-4 sm:px-5 py-[13px] border-b border-gray-100`}>
              <div className="min-w-0">
                <div className="text-[15px] text-gray-900">{task.title}</div>
                <div className="flex flex-wrap items-center gap-x-2 gap-y-1 mt-[3px]">
                  <span className={`text-[13px] ${due.tone}`}>{due.text}</span>
                  {task.is_private && <Badge tone={BADGE.private}>Private</Badge>}
                  {task.source_type === SERIES && (() => {
                    const x = series.find(v => v.id === task.source_id);
                    return x ? (
                      <SeriesInline series={x} people={people} canChange canStop
                        onChanged={load} onError={setError} />
                    ) : null;
                  })()}
                </div>
              </div>
              <div className="flex items-center gap-2 min-w-0 justify-end sm:justify-start">
                <Avatar name={task.owner_name} />
                {task.source_type !== SERIES ? (
                  <select value={task.person_id ?? ''} disabled={busyId === task.id}
                    aria-label={`Who “${task.title}” is with`}
                    onChange={e => void patch(task, { personId: e.target.value },
                      `Given to ${firstName(people.find(p => p.person_id === e.target.value)?.name)} instead.`)}
                    className="min-w-0 max-w-[9rem] sm:max-w-none sm:flex-1 py-1 pl-1 pr-6 min-h-[44px] sm:min-h-0 border border-transparent hover:border-gray-300 rounded-md text-base sm:text-sm text-gray-700 bg-transparent truncate">
                    {/* Keep the current owner selectable even if they are not in
                        the picker (a login since deactivated) — a select with no
                        matching option renders blank and would save blank. */}
                    {task.person_id && !people.some(p => p.person_id === task.person_id) && (
                      <option value={task.person_id}>{task.owner_name ?? 'Unknown'}</option>
                    )}
                    {people.map(p => <option key={p.person_id} value={p.person_id}>{p.name ?? 'Unnamed'}</option>)}
                  </select>
                ) : (
                  <span className="text-sm text-gray-700 truncate">{task.owner_name}</span>
                )}
              </div>
              <div className="min-w-0">
                <ForwardDateInput value={task.follow_up_on ?? ''} disabled={busyId === task.id}
                  ariaLabel="Your follow-up"
                  onChange={v => void patch(task, { followUpOn: v || null },
                    v ? `You’ll be reminded to check on it ${fmtDay(v)}.` : 'Follow-up cleared.')}
                  className="w-full min-w-0 px-2 py-1.5 border border-gray-300 rounded-lg text-base sm:text-[13px] text-gray-900 bg-white" />
              </div>
              <button onClick={() => {
                if (window.confirm(`Drop “${task.title}”? It comes off ${task.owner_name || 'their'} list.`)) {
                  void patch(task, { status: 'cancelled' }, `Dropped “${task.title}”`);
                }
              }}
                disabled={busyId === task.id}
                className={`${ACT} text-gray-400 text-right self-center sm:self-start sm:mt-1.5`}>
                Drop
              </button>
            </div>
          );
        })}
        <p className="px-4 sm:px-5 py-3 text-xs text-gray-500 leading-normal">
          “Your follow-up” is your own reminder to check on it — separate from theirs. Move it to reset it;
          clear it to stop. You’ll hear when it’s done, or if they hand it back.
        </p>
      </div>
      {done.length > 0 && (
        <div className={`${CARD} overflow-hidden`}>
          <div className={`${SUBHEAD} text-gray-500`}>Done in the last 30 days</div>
          <div className="divide-y divide-gray-100">
            {done.map(task => (
              <div key={task.id} className="flex items-center gap-3 px-4 sm:px-5 py-[11px]">
                <span className="text-sm text-gray-500 line-through min-w-0 flex-1">{task.title}</span>
                <span className="text-xs text-gray-400 text-right">
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
    </div>
  );
}

/** Every open task, grouped by owner (spec §4). Read-only: a glance, not a workbench. */
function EveryoneView({ people, refreshKey, onSummary }: {
  people: Person[];
  refreshKey: number;
  onSummary: SummaryFn;
}) {
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
  }, [loadSeries, refreshKey]);

  useEffect(() => { onSummary('Everyone’s open to-dos · read-only'); }, [onSummary]);

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
    return <div className={ERROR_BOX}>{error}</div>;
  }
  if (tasks.length === 0) {
    return (
      <div className="flex flex-col gap-4">
        <div className={`${CARD} px-5 py-6 text-sm text-gray-400`}>Nobody has anything open.</div>
        {repeating}
      </div>
    );
  }

  const groups = new Map<string, { list: Task[]; person: boolean }>();
  for (const t of tasks) {
    // Untaken list items come back only when dated (the bins) and group
    // under their list, after the people — the server orders them last.
    const key = t.person_id ? (t.owner_name || 'Unnamed') : `On ${t.list_name || 'a list'} — nobody on it yet`;
    const g = groups.get(key) ?? { list: [], person: !!t.person_id };
    g.list.push(t);
    groups.set(key, g);
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="grid gap-4 items-start grid-cols-[repeat(auto-fill,minmax(min(320px,100%),1fr))]">
        {[...groups.entries()].map(([owner, g]) => (
          <div key={owner} className={`${CARD} overflow-hidden`}>
            <div className="px-4 sm:px-[18px] py-3 border-b border-gray-100 flex items-center gap-2.5">
              {g.person ? <Avatar name={owner} size={28} /> : (
                <span aria-hidden className="flex-none w-7 h-7 rounded-full bg-emerald-50 text-emerald-700 text-xs font-bold flex items-center justify-center">≡</span>
              )}
              <span className="text-[15px] font-semibold text-gray-900 flex-1 min-w-0">{owner}</span>
              <span className="text-xs text-gray-500 whitespace-nowrap">{g.list.length} open</span>
            </div>
            <ul className="divide-y divide-gray-100">
              {g.list.map(t => {
                const due = fmtDue(t.due_date);
                return (
                  <li key={t.id} className="px-4 sm:px-[18px] py-2.5">
                    <div className="text-sm text-gray-900">{t.title}</div>
                    <div className="flex flex-wrap items-center gap-x-2 gap-y-1 mt-0.5">
                      <span className={`text-xs ${due.tone}`}>{due.text}</span>
                      {t.is_private && <Badge tone={BADGE.private}>Private</Badge>}
                      {setBySomeoneElse(t) && (
                        <Badge tone={BADGE.from} title={t.set_by_name ?? undefined}>From {firstName(t.set_by_name)}</Badge>
                      )}
                      {t.list_id && t.person_id && <Badge tone={BADGE.list}>{t.list_name || 'A'} list</Badge>}
                      {t.source_type === SERIES && (() => {
                        const x = series.find(v => v.id === t.source_id);
                        return x ? (
                          <SeriesInline series={x} people={people} canChange={manages(x)} canStop={manages(x)}
                            onChanged={loadSeries} onError={setError} />
                        ) : null;
                      })()}
                    </div>
                  </li>
                );
              })}
            </ul>
          </div>
        ))}
      </div>
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
 * Items belong to nobody until somebody says "I'll do it" — then they move
 * to that person's Mine, still marked "Shopping list", and can be put back.
 * Anyone can add, tick or drop an untaken item. Watchers get the nudges for
 * dated items nobody has taken.
 *
 * One list at a time, picked from the chips: its items come from their own
 * call, and the list is in the URL so a watcher's bell can open it.
 */
function ListsView({ people, me, refreshKey, flash, onSummary }: {
  people: Person[];
  me: string | null;
  refreshKey: number;
  flash: FlashFn;
  onSummary: SummaryFn;
}) {
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

  useEffect(() => { onSummary('Shared lists — take something and it moves to your list'); }, [onSummary]);

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

  useEffect(() => { void loadLists(); }, [loadLists, refreshKey]);
  useEffect(() => { void loadItems(); }, [loadItems, refreshKey]);

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
  async function act(id: string, fn: () => Promise<unknown>, fallback: string, done?: string,
    undo?: () => Promise<void>) {
    setBusyId(id);
    setError(null);
    try {
      await fn();
      if (done) flash(done, undo);
      await reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : fallback);
    } finally {
      setBusyId(null);
    }
  }

  /** Undo a tick or drop — never on a repeating one's occurrence (see MineView). */
  function undoFor(t: Task): (() => Promise<void>) | undefined {
    if (t.source_type === SERIES) return undefined;
    if (t.follow_up_on) return undefined; // see MineView — it would clear the setter's clock
    return async () => { await api.patch(`/staff-tasks/${t.id}`, { status: 'open' }); };
  }

  async function newList() {
    const name = window.prompt('Name the new list (e.g. Cleaning, Van kit):');
    if (!name?.trim()) return;
    setError(null);
    try {
      const r = await api.post<{ data: { id: string } }>('/staff-tasks/lists', { name: name.trim() });
      await loadLists();
      pick(r.data.id);
      flash(`Made the ${name.trim()} list.`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not add the list');
    }
  }

  async function rename(l: TaskList) {
    const name = window.prompt('Rename the list:', l.name);
    if (!name?.trim() || name.trim() === l.name) return;
    await act(l.id, () => api.patch(`/staff-tasks/lists/${l.id}`, { name: name.trim() }), 'Could not rename it',
      `Renamed to ${name.trim()}.`);
  }

  async function archive(l: TaskList) {
    if (!window.confirm(`Archive “${l.name}”? It disappears from Lists. It must be empty first.`)) return;
    await act(l.id, async () => {
      await api.post(`/staff-tasks/lists/${l.id}/archive`, {});
      const next = new URLSearchParams(params);
      next.delete('list');
      setParams(next, { replace: true });
    }, 'Could not archive it', `Archived ${l.name}.`);
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
      flash(`Added “${title.trim()}” to ${current.name}.`);
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
  const upForGrabs = open.filter(t => !t.person_id).length;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2">
        {lists.map(l => (
          <button key={l.id} onClick={() => pick(l.id)} aria-pressed={current?.id === l.id}
            className={`${CHIP} ${current?.id === l.id ? CHIP_ON : CHIP_OFF}`}>
            {l.name}
            {l.open_count > 0 && (
              <span className={`ml-1.5 text-xs ${current?.id === l.id ? 'text-white/80' : 'text-gray-500'}`}>{l.open_count}</span>
            )}
          </button>
        ))}
        <button onClick={() => void newList()}
          className={`${CHIP} border-dashed border-slate-300 bg-white text-gray-600 font-medium hover:border-ooosh-300`}>
          + New list
        </button>
      </div>

      {error && <div className={ERROR_BOX}>{error}</div>}

      {!current ? (
        <div className={`${CARD} px-5 py-6 text-sm text-gray-400`}>No lists yet — add one above.</div>
      ) : (
        <>
          <div className={`${CARD} overflow-hidden`}>
            <div className="px-4 sm:px-[18px] py-3.5 border-b border-gray-100 flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
              <div className="flex items-baseline gap-3 min-w-0">
                <h2 className="text-[15px] font-semibold text-gray-900">{current.name}</h2>
                <span className="text-xs text-gray-500">{upForGrabs} up for grabs</span>
              </div>
              <span className="flex gap-4">
                <button onClick={() => void rename(current)} disabled={busyId === current.id}
                  className={`${ACT} text-ooosh-600`}>Rename</button>
                <button onClick={() => void archive(current)} disabled={busyId === current.id}
                  className={`${ACT} text-gray-400 hover:text-gray-600`}>Archive</button>
              </span>
            </div>

            <div className="px-4 sm:px-[18px] py-2.5 bg-gray-50 border-b border-gray-100 flex flex-wrap items-center gap-x-3 gap-y-1">
              <label className="text-[13px] inline-flex items-center gap-1.5 text-gray-700 cursor-pointer min-h-[44px] sm:min-h-0"
                title="Watchers get the nudges for dated items nobody has taken">
                <input type="checkbox" checked={current.watching} disabled={busyId === current.id}
                  onChange={e => void act(current.id,
                    () => api.post(`/staff-tasks/lists/${current.id}/watch`, { on: e.target.checked }),
                    'Could not change watching',
                    e.target.checked ? `You’re watching ${current.name}.` : `Stopped watching ${current.name}.`)}
                  className="h-4 w-4 rounded border-gray-300" />
                Watch
              </label>
              <span className="text-xs text-gray-500">
                {watchers.length ? `Watching: ${watchers.join(', ')}` : 'Nobody is watching — nudges go nowhere'}
              </span>
            </div>

            <form onSubmit={add} className="px-4 sm:px-[18px] py-3.5 border-b border-gray-100 flex flex-col gap-2.5">
              <div className="flex gap-2.5 items-stretch">
                <input value={title} onChange={e => setTitle(e.target.value)} maxLength={300}
                  placeholder={`Add to ${current.name}… e.g. milk, bin bags`}
                  aria-label={`Add to ${current.name}`}
                  className="flex-1 min-w-0 px-3 py-2.5 border border-gray-300 rounded-lg text-base sm:text-sm" />
                <button type="submit" disabled={!title.trim() || adding}
                  className={`px-4 rounded-lg text-sm font-semibold text-white whitespace-nowrap ${title.trim()
                    ? 'bg-ooosh-600 hover:bg-ooosh-700' : 'bg-slate-300 cursor-not-allowed'}`}>
                  {adding ? 'Adding…' : 'Add'}
                </button>
              </div>
              <input value={detail} onChange={e => setDetail(e.target.value)} maxLength={4000}
                placeholder="Note (optional) — e.g. the 13A fuses, not the 5A"
                aria-label="Note"
                className="w-full px-3 py-2 border border-gray-300 rounded-lg text-base sm:text-[13px]" />
              <div className="flex flex-wrap items-start gap-x-5 gap-y-2">
                <label className="text-sm">
                  <span className="block text-xs text-gray-500 mb-1">{repeat ? 'Starts' : 'Due (optional)'}</span>
                  <ForwardDateInput value={dueDate} onChange={setDueDate} ariaLabel={repeat ? 'Starts' : 'Due'}
                    className="px-2 py-1.5 border border-gray-300 rounded-lg text-base sm:text-[13px] bg-white" />
                </label>
                <label className="text-sm">
                  <span className="block text-xs text-gray-500 mb-1">Repeats</span>
                  <select value={repeat ? 'custom' : 'none'}
                    onChange={e => {
                      if (e.target.value === 'none') setRepeat(null);
                      else setRepeatOpen(true);
                    }}
                    className="px-2 py-1.5 min-h-[44px] sm:min-h-0 border border-gray-300 rounded-lg text-base sm:text-[13px] bg-white">
                    <option value="none">Doesn’t repeat</option>
                    <option value="custom">{repeat ? repeat.text || 'Custom…' : 'Custom…'}</option>
                  </select>
                  {repeat && (
                    <button type="button" onClick={() => setRepeatOpen(true)}
                      className="block text-[11px] text-ooosh-600 hover:underline mt-1">change</button>
                  )}
                </label>
              </div>
            </form>
            {repeatOpen && (
              <RecurrenceModal
                startsOn={dueDate || ymdFromToday(0)}
                initial={repeat ?? defaultRepeat(dueDate || ymdFromToday(0))}
                onCancel={() => setRepeatOpen(false)}
                onDone={v => { setRepeat(v); setRepeatOpen(false); }}
              />
            )}

            <div className="[&>*:last-child]:border-b-0">
              {open.length === 0 ? (
                <p className="px-4 sm:px-[18px] py-6 text-sm text-gray-400">Nothing on {current.name}.</p>
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
                        }, 'Could not save it', 'Saved.');
                      }} />
                  );
                }
                return (
                  <div key={t.id}
                    className="flex flex-wrap sm:flex-nowrap items-start gap-x-3.5 gap-y-0.5 px-4 sm:px-[18px] py-[11px] border-b border-gray-100">
                    <TickCircle
                      // Once taken it's the taker's to tick (from Mine).
                      disabled={taken || busyId === t.id || !!opens}
                      onClick={() => void act(t.id,
                        () => api.patch(`/staff-tasks/${t.id}`, { status: 'done' }), 'Could not tick it',
                        `Ticked off “${t.title}”`, undoFor(t))}
                      label={`Mark "${t.title}" done`}
                      title={opens ? `Can be ticked from ${opens}` : undefined} />
                    <div className="min-w-0 flex-1">
                      <div className={`text-sm ${taken ? 'text-gray-500' : 'text-gray-900'}`}>{t.title}</div>
                      {t.detail && <div className="text-xs text-gray-500 mt-0.5">{t.detail}</div>}
                      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 mt-1 empty:hidden">
                        {t.due_date && <span className={`text-xs font-medium ${due.tone}`}>{due.text}</span>}
                        {opens && <span className="text-[11px] text-gray-400">opens {opens}</span>}
                        {x && (
                          <SeriesInline series={x} people={people} canChange canStop
                            onChanged={reload} onError={setError} />
                        )}
                      </div>
                    </div>
                    <div className="w-full sm:w-auto flex-none flex items-center gap-5 sm:gap-3.5 pl-9 sm:pl-0">
                      {taken ? (
                        <span className="text-xs text-gray-500 py-1">
                          {t.person_id === me ? 'You’re on it — it’s in Mine' : `${t.owner_name || 'Someone'} is on it`}
                        </span>
                      ) : (
                        <>
                          <button onClick={() => void act(t.id,
                            () => api.post(`/staff-tasks/${t.id}/take`, {}), 'Could not take it',
                            `“${t.title}” is on your list now.`)}
                            disabled={busyId === t.id}
                            className="px-[11px] py-[5px] min-h-[44px] sm:min-h-0 rounded-full border border-ooosh-200 bg-ooosh-50 text-ooosh-700 text-xs font-semibold whitespace-nowrap hover:bg-ooosh-100 disabled:opacity-40">
                            I’ll do it
                          </button>
                          <button onClick={() => setEditingId(t.id)}
                            disabled={busyId === t.id}
                            className={`${ACT} text-ooosh-600`}>
                            Edit
                          </button>
                          <button onClick={() => void act(t.id,
                            () => api.patch(`/staff-tasks/${t.id}`, { status: 'cancelled' }), 'Could not drop it',
                            `Dropped “${t.title}”`, undoFor(t))}
                            disabled={busyId === t.id}
                            className={`${ACT} text-gray-400`}
                            title="Not needed after all">
                            Drop
                          </button>
                        </>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          <SeriesList series={series} people={people} showOwner={false}
            canChange={() => true} canStop={() => true}
            onChanged={reload} onError={setError} />

          {done.length > 0 && (
            <div className={`${CARD} overflow-hidden`}>
              <div className={`${SUBHEAD} text-gray-500`}>Done in the last 14 days</div>
              <div className="divide-y divide-gray-100">
                {done.map(t => (
                  <div key={t.id} className="flex items-center gap-3 px-4 sm:px-[18px] py-[11px]">
                    <span className="text-sm text-gray-500 line-through min-w-0 flex-1">{t.title}</span>
                    <span className="text-xs text-gray-400 text-right">
                      {t.owner_name ? `${t.owner_name} · ` : ''}done {fmtShort(t.completed_at)}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}
          <p className="text-xs text-gray-400">
            Anyone can add, tick or drop something here. “I’ll do it” moves it onto your own list;
            “Put back” there returns it. Watchers are nudged about dated items nobody has taken.
          </p>
        </>
      )}
    </div>
  );
}
