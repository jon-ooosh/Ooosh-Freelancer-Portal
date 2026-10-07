/**
 * FreelancerTasksPanel — the list of things a freelancer has to do on a day
 * booking (staff calendar) or a studio sitter's evening (Rehearsals roster).
 * docs/STAFF-CALENDAR-SPEC.md §21; every rule lives in
 * backend services/freelancer-tasks.ts.
 *
 * A live list: add, change or remove at any time. Nothing emails the freelancer
 * on a change — "Send update" is a deliberate press (and tonight's sitter gets
 * one 16:00 summary if anything changed). A van prep ticks itself when the prep
 * sheet for that van is saved.
 */

import { useCallback, useEffect, useState } from 'react';
import { api } from '../services/api';

type Owner = { bookingId: string } | { shiftId: string };

interface Task {
  id: string;
  taskType: 'van_prep' | 'other';
  vehicleId: string | null;
  vehicleReg: string | null;
  hhJobNumber: number | null;
  jobName: string | null;
  description: string | null;
  status: 'open' | 'done' | 'cancelled';
  doneAt: string | null;
  doneByName: string | null;
  doneVia: 'prep_saved' | 'portal' | 'staff' | null;
  title: string;
}

interface OwnerInfo {
  date: string;
  live: boolean;
  hasPerson: boolean;
  hasEmail: boolean;
  lastNotifiedAt: string | null;
  changesSinceNotified: number;
}

interface Van { id: string; reg: string; simple_type: string | null }

function fmtWhen(iso: string): string {
  const d = new Date(iso);
  return isNaN(d.getTime()) ? '' : d.toLocaleString('en-GB', {
    weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit',
  });
}

const DONE_VIA: Record<string, string> = {
  prep_saved: 'prep sheet saved',
  portal: 'ticked on the portal',
  staff: 'ticked here',
};

export default function FreelancerTasksPanel({ owner, onOpenCountChange }: {
  owner: Owner;
  /** Reports the open-task count after every load, so a parent can update a
   *  badge WITHOUT reloading itself (a parent reload would unmount this panel
   *  mid-edit). */
  onOpenCountChange?: (n: number) => void;
}) {
  const ownerQuery = 'bookingId' in owner ? `bookingId=${owner.bookingId}` : `shiftId=${owner.shiftId}`;
  const ownerBody = 'bookingId' in owner ? { bookingId: owner.bookingId } : { shiftId: owner.shiftId };

  const [tasks, setTasks] = useState<Task[]>([]);
  const [info, setInfo] = useState<OwnerInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sentNote, setSentNote] = useState<string | null>(null);

  // The add / edit form. editingId null = adding.
  const [formOpen, setFormOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [fType, setFType] = useState<'van_prep' | 'other'>('van_prep');
  const [fVan, setFVan] = useState('');
  const [fJob, setFJob] = useState('');
  const [fText, setFText] = useState('');
  const [vans, setVans] = useState<Van[] | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await api.get<{ data: Task[]; owner: OwnerInfo }>(`/freelancer-tasks?${ownerQuery}`);
      const list = r.data ?? [];
      setTasks(list);
      setInfo(r.owner ?? null);
      setError(null);
      onOpenCountChange?.(list.filter(t => t.status === 'open').length);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load tasks');
    } finally {
      setLoading(false);
    }
    // onOpenCountChange deliberately left out: a parent passing an inline arrow
    // would otherwise re-fire the load on every parent render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ownerQuery]);

  useEffect(() => { void load(); }, [load]);

  // The van list only when somebody opens the form.
  useEffect(() => {
    if (!formOpen || vans) return;
    api.get<{ data: Van[] }>('/vehicles/fleet')
      .then(r => setVans([...(r.data ?? [])].sort((a, b) => a.reg.localeCompare(b.reg))))
      .catch(() => setVans([]));
  }, [formOpen, vans]);

  async function act(fn: () => Promise<unknown>) {
    setBusy(true);
    setError(null);
    setSentNote(null);
    try {
      await fn();
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'That did not work');
    } finally {
      setBusy(false);
    }
  }

  function openAdd() {
    setEditingId(null);
    setFType('van_prep'); setFVan(''); setFJob(''); setFText('');
    setFormOpen(true);
  }

  function openEdit(t: Task) {
    setEditingId(t.id);
    setFType(t.taskType);
    setFVan(t.vehicleId ?? '');
    setFJob(t.hhJobNumber ? String(t.hhJobNumber) : '');
    setFText(t.description ?? '');
    setFormOpen(true);
  }

  async function saveForm() {
    const job = fJob.trim() === '' ? null : Number(fJob.trim());
    if (job !== null && (!Number.isInteger(job) || job <= 0)) { setError('The job number should be a number'); return; }
    const payload = {
      vehicleId: fVan || null,
      hhJobNumber: job,
      description: fText.trim() || null,
    };
    await act(async () => {
      if (editingId) await api.patch(`/freelancer-tasks/${editingId}`, payload);
      else await api.post('/freelancer-tasks', { ...ownerBody, taskType: fType, ...payload });
      setFormOpen(false);
    });
  }

  async function sendUpdate() {
    setBusy(true);
    setError(null);
    try {
      await api.post('/freelancer-tasks/send-update', ownerBody);
      setSentNote('Sent');
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'The update did not send');
    } finally {
      setBusy(false);
    }
  }

  if (loading) return <div className="text-xs text-gray-400">Loading tasks…</div>;

  const editable = !!info?.live;
  const openCount = tasks.filter(t => t.status === 'open').length;

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm font-medium text-gray-900">Tasks</span>
        {openCount > 0 && <span className="text-xs text-gray-500">{openCount} to do</span>}
        {editable && !formOpen && (
          <button onClick={openAdd} disabled={busy}
            className="text-xs px-2 py-1 rounded border border-gray-300 hover:bg-gray-50 disabled:opacity-50">
            + Add a task
          </button>
        )}
        {editable && info?.hasPerson && (
          <span className="ml-auto flex items-center gap-2">
            <span className="text-[11px] text-gray-400">
              {info.lastNotifiedAt
                ? info.changesSinceNotified > 0
                  ? `${info.changesSinceNotified} change${info.changesSinceNotified !== 1 ? 's' : ''} since last sent`
                  : `Last sent ${fmtWhen(info.lastNotifiedAt)}`
                : 'Not sent yet'}
            </span>
            <button onClick={() => void sendUpdate()} disabled={busy || !info.hasEmail}
              title={info.hasEmail ? 'Email them the current list' : 'We have no email address for them'}
              className="text-xs px-2 py-1 rounded border border-purple-300 text-purple-700 hover:bg-purple-50 disabled:opacity-50">
              Send update
            </button>
            {sentNote && <span className="text-[11px] text-emerald-700">{sentNote}</span>}
          </span>
        )}
      </div>

      {editable && !info?.hasPerson && (
        <p className="text-[11px] text-gray-500">Nobody is on this evening yet — tasks will go to whoever is.</p>
      )}
      {error && <p className="text-xs text-red-600">{error}</p>}

      {tasks.length === 0 && !formOpen && (
        <p className="text-xs text-gray-400">{editable ? 'Nothing on the list.' : 'No tasks.'}</p>
      )}

      {tasks.length > 0 && (
        <ul className="space-y-1">
          {tasks.map(t => (
            <li key={t.id} className="flex items-start gap-2 text-sm">
              <input type="checkbox" className="mt-1" checked={t.status === 'done'}
                disabled={busy || !editable}
                title={t.status === 'done' ? 'Re-open' : 'Tick off'}
                onChange={() => void act(() => api.post(`/freelancer-tasks/${t.id}/done`, { done: t.status !== 'done' }))} />
              <div className="min-w-0 flex-1">
                <div className={t.status === 'done' ? 'text-gray-400 line-through' : 'text-gray-900'}>
                  {t.title}
                  {t.jobName && <span className="text-gray-400"> · {t.jobName}</span>}
                </div>
                {t.taskType === 'van_prep' && t.description && (
                  <div className="text-xs text-gray-500">{t.description}</div>
                )}
                {t.status === 'done' && t.doneAt && (
                  <div className="text-[11px] text-emerald-700">
                    Done {fmtWhen(t.doneAt)}{t.doneByName ? ` by ${t.doneByName}` : ''}{t.doneVia ? ` (${DONE_VIA[t.doneVia]})` : ''}
                  </div>
                )}
              </div>
              {editable && t.status === 'open' && (
                <span className="flex gap-2 shrink-0">
                  <button onClick={() => openEdit(t)} disabled={busy} className="text-xs text-gray-500 hover:underline">Edit</button>
                  <button onClick={() => void act(() => api.post(`/freelancer-tasks/${t.id}/cancel`, {}))}
                    disabled={busy} className="text-xs text-red-500 hover:underline">Remove</button>
                </span>
              )}
            </li>
          ))}
        </ul>
      )}

      {formOpen && (
        <div className="p-3 rounded border border-gray-200 bg-gray-50 space-y-2">
          {!editingId && (
            <div className="flex gap-3 text-sm">
              <label className="flex items-center gap-1">
                <input type="radio" checked={fType === 'van_prep'} onChange={() => setFType('van_prep')} /> Prep a van
              </label>
              <label className="flex items-center gap-1">
                <input type="radio" checked={fType === 'other'} onChange={() => setFType('other')} /> Something else
              </label>
            </div>
          )}
          {fType === 'van_prep' && (
            <select value={fVan} onChange={e => setFVan(e.target.value)}
              className="w-full text-sm border border-gray-300 rounded px-2 py-1.5 bg-white">
              <option value="">{vans === null ? 'Loading vans…' : 'Pick the van'}</option>
              {(vans ?? []).map(v => (
                <option key={v.id} value={v.id}>{v.reg}{v.simple_type ? ` — ${v.simple_type}` : ''}</option>
              ))}
              {/* A van no longer in the active fleet must still show, or the
                  select renders blank and saves that blank (frontend.md). */}
              {fVan && vans && !vans.some(v => v.id === fVan) && (
                <option value={fVan}>{tasks.find(t => t.id === editingId)?.vehicleReg ?? 'Current van'}</option>
              )}
            </select>
          )}
          <textarea value={fText} onChange={e => setFText(e.target.value)} rows={2} maxLength={500}
            placeholder={fType === 'van_prep' ? 'Anything to add (optional)' : 'What needs doing'}
            className="w-full text-sm border border-gray-300 rounded px-2 py-1.5" />
          <input value={fJob} onChange={e => setFJob(e.target.value)} inputMode="numeric"
            placeholder="Job number (optional)"
            className="w-48 text-sm border border-gray-300 rounded px-2 py-1.5" />
          <div className="flex gap-2">
            <button onClick={() => void saveForm()} disabled={busy}
              className="px-3 py-1.5 text-sm rounded bg-ooosh-600 text-white hover:bg-ooosh-700 disabled:opacity-50">
              {editingId ? 'Save' : 'Add'}
            </button>
            <button onClick={() => setFormOpen(false)} disabled={busy}
              className="px-3 py-1.5 text-sm rounded border border-gray-300 hover:bg-white">Cancel</button>
          </div>
        </div>
      )}
    </div>
  );
}
