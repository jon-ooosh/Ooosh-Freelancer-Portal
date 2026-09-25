/**
 * Repeating to-dos — the "Custom recurrence" form, after Google Calendar's
 * (jon, Sep 2026). docs/TASKS-SPEC.md §6.
 *
 * THE PAGE DOES NO DATE ARITHMETIC. What a rule means and when it falls is
 * decided once, in backend services/task-recurrence.ts; this form asks it via
 * POST /staff-tasks/series/preview and shows the answer ("Every month on the
 * first Tuesday — next: 6 Oct, 3 Nov, 1 Dec"). Two copies of that logic would
 * drift, which is the failure CLAUDE.md's helper rule exists to stop.
 *
 * Weekdays are 0 = Monday … 6 = Sunday, matching the M T W T F S S row.
 */

import { useEffect, useState } from 'react';
import { api } from '../services/api';

export type RepeatMode = 'schedule' | 'after_done';
export type Freq = 'day' | 'week' | 'month' | 'year';

export interface RepeatRule {
  freq: Freq;
  interval: number;
  weekdays?: number[];
  monthly?: { type: 'day'; day: number } | { type: 'nth'; n: number; weekday: number };
}

/** Everything the form decides — sent as-is to POST/PATCH /staff-tasks/series. */
export interface RepeatValue {
  mode: RepeatMode;
  rule: RepeatRule;
  endsOn: string | null;
  endsAfter: number | null;
  /** The server's words for it, for showing once chosen. */
  text: string;
}

const DAY_LETTERS = ['M', 'T', 'W', 'T', 'F', 'S', 'S'];
const DAY_NAMES = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
const NTH = [
  { n: 1, label: 'first' }, { n: 2, label: 'second' }, { n: 3, label: 'third' },
  { n: 4, label: 'fourth' }, { n: -1, label: 'last' },
];

/** "Tue 6 Oct" — no comma inside, so a list of them reads cleanly. */
function fmt(ymd: string): string {
  const d = new Date(`${ymd}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return ymd;
  const wd = d.toLocaleDateString('en-GB', { weekday: 'short', timeZone: 'UTC' });
  const dm = d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' });
  return `${wd} ${dm}`;
}

/** 0 = Monday for a YYYY-MM-DD — only to pre-select sensible defaults. */
function weekdayOf(ymd: string): number {
  const d = new Date(`${ymd}T00:00:00Z`);
  return Number.isNaN(d.getTime()) ? 0 : (d.getUTCDay() + 6) % 7;
}
function dayOf(ymd: string): number {
  const d = new Date(`${ymd}T00:00:00Z`);
  return Number.isNaN(d.getTime()) ? 1 : d.getUTCDate();
}

/** A sensible starting rule for a start date: weekly, on that weekday. */
export function defaultRepeat(startsOn: string): RepeatValue {
  return {
    mode: 'schedule',
    rule: { freq: 'week', interval: 1, weekdays: [weekdayOf(startsOn)] },
    endsOn: null, endsAfter: null, text: '',
  };
}

/**
 * The fields themselves — used by the create pop-up and the edit form.
 * Controlled: `value` in, `onChange` out. `startsOn` anchors the preview.
 */
export function RecurrenceFields({ value, onChange, startsOn }: {
  value: RepeatValue;
  onChange: (v: RepeatValue) => void;
  startsOn: string;
}) {
  const [dates, setDates] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const { mode, rule } = value;

  // Ask the server what this means, a moment after the last change.
  useEffect(() => {
    let live = true;
    const t = setTimeout(() => {
      api.post<{ data: { text: string; dates: string[] } }>('/staff-tasks/series/preview',
        { mode, rule, startsOn })
        .then(res => {
          if (!live) return;
          setError(null);
          setDates(res.data.dates);
          if (res.data.text !== value.text) onChange({ ...value, text: res.data.text });
        })
        .catch(err => { if (live) { setError(err instanceof Error ? err.message : 'That doesn’t work'); setDates([]); } });
    }, 250);
    return () => { live = false; clearTimeout(t); };
    // value.text is written here; depending on it would loop.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [JSON.stringify(rule), mode, startsOn]);

  const setRule = (patch: Partial<RepeatRule>) => onChange({ ...value, rule: { ...rule, ...patch } });

  function setFreq(freq: Freq) {
    const next: RepeatRule = { freq, interval: rule.interval };
    if (freq === 'week') next.weekdays = [weekdayOf(startsOn)];
    if (freq === 'month') next.monthly = { type: 'day', day: dayOf(startsOn) };
    onChange({ ...value, rule: next });
  }

  const monthly = rule.monthly ?? { type: 'day' as const, day: dayOf(startsOn) };
  const endsKind = value.endsOn ? 'on' : value.endsAfter ? 'after' : 'never';

  return (
    <div className="space-y-4 text-sm">
      <div className="flex gap-4">
        <label className="inline-flex items-center gap-1.5">
          <input type="radio" checked={mode === 'schedule'} onChange={() => onChange({ ...value, mode: 'schedule' })} />
          On a schedule
        </label>
        <label className="inline-flex items-center gap-1.5"
          title="Like the bins: the next one counts from when the last was actually done">
          <input type="radio" checked={mode === 'after_done'} onChange={() => onChange({ ...value, mode: 'after_done' })} />
          After the last one is done
        </label>
      </div>

      <div className="flex items-center gap-2">
        <span className="text-gray-700">{mode === 'after_done' ? 'Next one' : 'Repeat every'}</span>
        <input type="number" min={1} max={99} value={rule.interval}
          onChange={e => setRule({ interval: Math.max(1, Math.min(99, Math.round(Number(e.target.value) || 1))) })}
          className="w-16 px-2 py-1.5 border border-gray-300 rounded" aria-label="How many" />
        <select value={rule.freq} onChange={e => setFreq(e.target.value as Freq)}
          className="px-2 py-1.5 border border-gray-300 rounded bg-white" aria-label="Unit">
          {(['day', 'week', 'month', 'year'] as Freq[]).map(f => (
            <option key={f} value={f}>{rule.interval === 1 ? f : `${f}s`}</option>
          ))}
        </select>
        {mode === 'after_done' && <span className="text-gray-500">after the last one is done</span>}
      </div>

      {mode === 'schedule' && rule.freq === 'week' && (
        <div>
          <p className="text-gray-700 mb-1.5">Repeat on</p>
          <div className="flex gap-1.5">
            {DAY_LETTERS.map((l, i) => {
              const on = (rule.weekdays ?? []).includes(i);
              return (
                <button key={i} type="button" aria-pressed={on} aria-label={DAY_NAMES[i]}
                  onClick={() => {
                    const cur = rule.weekdays ?? [];
                    const next = on ? cur.filter(d => d !== i) : [...cur, i].sort();
                    setRule({ weekdays: next.length ? next : cur }); // never none
                  }}
                  className={`h-8 w-8 rounded-full text-xs font-medium ${on
                    ? 'bg-ooosh-600 text-white' : 'bg-gray-100 text-gray-700 hover:bg-gray-200'}`}>
                  {l}
                </button>
              );
            })}
          </div>
        </div>
      )}

      {mode === 'schedule' && rule.freq === 'month' && (
        <div className="space-y-2">
          <label className="flex items-center gap-2">
            <input type="radio" checked={monthly.type === 'day'}
              onChange={() => setRule({ monthly: { type: 'day', day: dayOf(startsOn) } })} />
            On day
            <input type="number" min={1} max={31} disabled={monthly.type !== 'day'}
              value={monthly.type === 'day' ? monthly.day : dayOf(startsOn)}
              onChange={e => setRule({ monthly: { type: 'day', day: Math.max(1, Math.min(31, Math.round(Number(e.target.value) || 1))) } })}
              className="w-16 px-2 py-1 border border-gray-300 rounded disabled:opacity-50" aria-label="Day of the month" />
            <span className="text-xs text-gray-400">(31 lands on the last day of shorter months)</span>
          </label>
          <label className="flex flex-wrap items-center gap-2">
            <input type="radio" checked={monthly.type === 'nth'}
              onChange={() => setRule({ monthly: { type: 'nth', n: Math.min(4, Math.ceil(dayOf(startsOn) / 7)), weekday: weekdayOf(startsOn) } })} />
            On the
            <select disabled={monthly.type !== 'nth'} value={monthly.type === 'nth' ? monthly.n : 1}
              onChange={e => monthly.type === 'nth' && setRule({ monthly: { ...monthly, n: Number(e.target.value) } })}
              className="px-2 py-1 border border-gray-300 rounded bg-white disabled:opacity-50" aria-label="Which">
              {NTH.map(o => <option key={o.n} value={o.n}>{o.label}</option>)}
            </select>
            <select disabled={monthly.type !== 'nth'} value={monthly.type === 'nth' ? monthly.weekday : 0}
              onChange={e => monthly.type === 'nth' && setRule({ monthly: { ...monthly, weekday: Number(e.target.value) } })}
              className="px-2 py-1 border border-gray-300 rounded bg-white disabled:opacity-50" aria-label="Weekday">
              {DAY_NAMES.map((d, i) => <option key={i} value={i}>{d}</option>)}
            </select>
          </label>
        </div>
      )}

      <div className="space-y-1.5">
        <p className="text-gray-700">Ends</p>
        <label className="flex items-center gap-2">
          <input type="radio" checked={endsKind === 'never'} onChange={() => onChange({ ...value, endsOn: null, endsAfter: null })} />
          Never
        </label>
        <label className="flex items-center gap-2">
          <input type="radio" checked={endsKind === 'on'}
            onChange={() => onChange({ ...value, endsAfter: null, endsOn: value.endsOn || startsOn })} />
          On
          <input type="date" min={startsOn} disabled={endsKind !== 'on'} value={value.endsOn ?? ''}
            onChange={e => onChange({ ...value, endsOn: e.target.value || null })}
            className="px-2 py-1 border border-gray-300 rounded disabled:opacity-50" aria-label="End date" />
        </label>
        <label className="flex items-center gap-2">
          <input type="radio" checked={endsKind === 'after'}
            onChange={() => onChange({ ...value, endsOn: null, endsAfter: value.endsAfter || 10 })} />
          After
          <input type="number" min={1} max={999} disabled={endsKind !== 'after'} value={value.endsAfter ?? 10}
            onChange={e => onChange({ ...value, endsAfter: Math.max(1, Math.round(Number(e.target.value) || 1)) })}
            className="w-20 px-2 py-1 border border-gray-300 rounded disabled:opacity-50" aria-label="How many times" />
          times
        </label>
      </div>

      <div className="rounded bg-gray-50 border border-gray-200 px-3 py-2">
        {error ? (
          <p className="text-xs text-red-700">{error}</p>
        ) : (
          <>
            <p className="text-sm text-gray-900">{value.text || '…'}</p>
            {dates.length > 0 && (
              <p className="text-xs text-gray-500 mt-0.5">
                {mode === 'after_done' ? 'If each is done on the day: ' : 'Next: '}
                {dates.map(fmt).join(', ')}
              </p>
            )}
          </>
        )}
      </div>
    </div>
  );
}

/** The pop-up the add form opens from "Repeats → Custom…". */
export function RecurrenceModal({ initial, startsOn, onDone, onCancel }: {
  initial: RepeatValue;
  startsOn: string;
  onDone: (v: RepeatValue) => void;
  onCancel: () => void;
}) {
  const [value, setValue] = useState<RepeatValue>(initial);
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/50" onClick={onCancel} />
      <div className="relative bg-white rounded-xl shadow-xl w-full max-w-md mx-4 p-6 max-h-[90vh] overflow-y-auto">
        <h3 className="text-lg font-semibold text-gray-900 mb-4">Repeat</h3>
        <RecurrenceFields value={value} onChange={setValue} startsOn={startsOn} />
        <div className="flex justify-end gap-2 mt-5">
          <button type="button" onClick={onCancel}
            className="px-3 py-1.5 text-sm rounded border border-gray-300 hover:bg-gray-50">Cancel</button>
          <button type="button" onClick={() => onDone(value)} disabled={!value.text}
            className="px-3 py-1.5 text-sm rounded bg-ooosh-600 text-white hover:bg-ooosh-700 disabled:opacity-40">Done</button>
        </div>
      </div>
    </div>
  );
}

/** One repeating to-do as the list pages show it. */
export interface Series {
  id: string;
  title: string;
  detail: string | null;
  person_id: string;
  owner_name: string | null;
  mode: RepeatMode;
  rule: RepeatRule;
  starts_on: string;
  ends_on: string | null;
  ends_after: number | null;
  status: 'proposed' | 'active' | 'declined' | 'ended';
  decline_reason: string | null;
  ended_reason: string | null;
  is_private: boolean;
  created_by: string | null;
  set_by_person_id: string | null;
  set_by_name: string | null;
  next_on: string | null;
  last_done_at: string | null;
  rule_text: string;
}

/**
 * Change a repeating to-do — for whoever set it, or an admin (the person asked
 * can accept, decline or stop, not rewrite). Changes apply from the next one.
 */
export function SeriesEditModal({ series, people, onClose, onSaved, onError }: {
  series: Series;
  people: { person_id: string; name: string | null }[];
  onClose: () => void;
  onSaved: () => Promise<void>;
  onError: (msg: string) => void;
}) {
  const [title, setTitle] = useState(series.title);
  const [owner, setOwner] = useState(series.person_id);
  const [value, setValue] = useState<RepeatValue>({
    mode: series.mode, rule: series.rule, endsOn: series.ends_on, endsAfter: series.ends_after, text: series.rule_text,
  });
  const [saving, setSaving] = useState(false);

  async function save() {
    setSaving(true);
    try {
      await api.patch(`/staff-tasks/series/${series.id}`, {
        title: title.trim(),
        mode: value.mode, rule: value.rule,
        endsOn: value.endsOn ?? '', endsAfter: value.endsAfter,
        ...(owner !== series.person_id ? { personId: owner } : {}),
      });
      await onSaved();
    } catch (err) {
      onError(err instanceof Error ? err.message : 'Could not save it');
      setSaving(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/50" onClick={() => { if (!saving) onClose(); }} />
      <div className="relative bg-white rounded-xl shadow-xl w-full max-w-md mx-4 p-6 max-h-[90vh] overflow-y-auto">
        <h3 className="text-lg font-semibold text-gray-900 mb-4">Change repeating to-do</h3>
        <div className="space-y-3 mb-4">
          <input value={title} onChange={e => setTitle(e.target.value)} maxLength={300} aria-label="Title"
            className="w-full px-3 py-2 border border-gray-300 rounded text-sm" />
          <label className="block text-sm">
            <span className="block text-xs text-gray-600 mb-1">For</span>
            <select value={owner} onChange={e => setOwner(e.target.value)}
              className="w-full px-3 py-2 border border-gray-300 rounded text-sm bg-white">
              {!people.some(p => p.person_id === series.person_id) && (
                <option value={series.person_id}>{series.owner_name ?? 'Unknown'}</option>
              )}
              {people.map(p => <option key={p.person_id} value={p.person_id}>{p.name ?? 'Unnamed'}</option>)}
            </select>
            {owner !== series.person_id && (
              <span className="block text-xs text-amber-700 mt-1">
                They’ll be asked to accept it; the one currently open is dropped.
              </span>
            )}
          </label>
        </div>
        <RecurrenceFields value={value} onChange={setValue} startsOn={series.starts_on} />
        <p className="text-xs text-gray-400 mt-3">Changes apply from the next one — the one already open keeps its date.</p>
        <div className="flex justify-end gap-2 mt-5">
          <button type="button" onClick={onClose} disabled={saving}
            className="px-3 py-1.5 text-sm rounded border border-gray-300 hover:bg-gray-50 disabled:opacity-40">Cancel</button>
          <button type="button" onClick={() => void save()} disabled={saving || !title.trim()}
            className="px-3 py-1.5 text-sm rounded bg-ooosh-600 text-white hover:bg-ooosh-700 disabled:opacity-40">
            {saving ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  );
}
