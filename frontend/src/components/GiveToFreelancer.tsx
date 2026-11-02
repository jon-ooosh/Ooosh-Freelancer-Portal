/**
 * "Give to a freelancer" — put a prep for THIS van on the list of somebody
 * booked in today or tomorrow (a yard day or a studio-sitter evening).
 * docs/STAFF-CALENDAR-SPEC.md §21.4, phase 3.
 *
 * Renders NOTHING unless somebody is booked (jon, Oct 2026): no booked
 * freelancer, no button. Freelancers out on driving jobs never appear — tasks
 * belong to yard days and sitter evenings only.
 *
 * It only adds the task. Telling them is the usual route: "Send update" on
 * their booking, or the 16:00 summary for tonight's sitter — the success line
 * says which.
 */

import { useEffect, useState } from 'react';
import { api } from '../services/api';
import ModalShell from './ModalShell';
import SearchPicker, { type PickerOption } from './SearchPicker';

interface Booked {
  owner: { kind: 'booking' | 'shift'; id: string };
  date: string;
  personName: string;
  kind: 'yard_day' | 'sitter';
  unconfirmed: boolean;
  /** Vans already on their list as an open prep. */
  vanIds: string[];
}

// One fetch serves every button on the page (the prep queue shows a card per
// van). Cached for a minute; a successful "give" refreshes it for everybody.
let cache: { at: number; data: Booked[] } | null = null;
let inflight: Promise<Booked[]> | null = null;
const listeners = new Set<(d: Booked[]) => void>();

function fetchBooked(force = false): Promise<Booked[]> {
  if (!force && cache && Date.now() - cache.at < 60_000) return Promise.resolve(cache.data);
  if (inflight && !force) return inflight;
  inflight = api.get<{ data: Booked[] }>('/freelancer-tasks/booked')
    .then(r => {
      cache = { at: Date.now(), data: r.data ?? [] };
      listeners.forEach(l => l(cache!.data));
      return cache.data;
    })
    .catch(() => [] as Booked[]) // fail quiet: the button is a convenience, not a page
    .finally(() => { inflight = null; });
  return inflight;
}

function todayIso(): string {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'Europe/London' });
}

function whenLabel(date: string): string {
  if (date === todayIso()) return 'today';
  const d = new Date(`${date}T12:00:00Z`);
  if (Number.isNaN(d.getTime())) return date;
  const t = new Date(`${todayIso()}T12:00:00Z`);
  t.setUTCDate(t.getUTCDate() + 1);
  return d.toISOString().slice(0, 10) === t.toISOString().slice(0, 10) ? 'tomorrow' : date;
}

function describe(b: Booked): string {
  const when = whenLabel(b.date);
  return b.kind === 'sitter'
    ? `studio sitter ${when === 'today' ? 'tonight' : `${when} evening`}`
    : `in ${when}${b.unconfirmed ? ' (not confirmed yet)' : ''}`;
}

async function searchJobs(q: string): Promise<PickerOption[]> {
  const r = await api.get<{ data: Array<{ id: string; hh_job_number: number | null; job_name: string | null; client_name: string | null }> }>(
    `/hirehop/jobs?search=${encodeURIComponent(q)}&limit=10`);
  return (r.data ?? []).map(j => ({
    value: j.id,
    label: j.hh_job_number ? `#${j.hh_job_number}` : (j.job_name || j.client_name || 'Job'),
    hint: j.hh_job_number ? (j.job_name || j.client_name || undefined) : undefined,
  }));
}

export default function GiveToFreelancer({ vehicleId, reg, className }: {
  vehicleId: string;
  reg: string;
  className?: string;
}) {
  const [booked, setBooked] = useState<Booked[] | null>(null);
  const [open, setOpen] = useState(false);
  const [pick, setPick] = useState<Booked | null>(null);
  const [job, setJob] = useState<PickerOption | null>(null);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    const onData = (d: Booked[]) => { if (live) setBooked(d); };
    listeners.add(onData);
    void fetchBooked().then(onData);
    return () => { live = false; listeners.delete(onData); };
  }, []);

  if (!booked || booked.length === 0) return null;

  const hasVan = (b: Booked) => b.vanIds.includes(vehicleId);
  const given = booked.filter(hasVan);

  function close() {
    setOpen(false); setPick(null); setJob(null); setNote(''); setError(null);
  }

  async function give() {
    if (!pick) { setError('Pick who it is for'); return; }
    setBusy(true);
    setError(null);
    try {
      await api.post('/freelancer-tasks', {
        ...(pick.owner.kind === 'booking' ? { bookingId: pick.owner.id } : { shiftId: pick.owner.id }),
        taskType: 'van_prep',
        vehicleId,
        jobId: job?.value ?? null,
        description: note.trim() || null,
      });
      const first = pick.personName.split(' ')[0];
      setDone(pick.kind === 'sitter' && whenLabel(pick.date) === 'today'
        ? `On ${first}'s list. They will see it on the portal, and in the 16:00 summary if it is not 16:00 yet.`
        : `On ${first}'s list. They will see it on the portal — use "Send update" on their booking if you want to email them.`);
      close();
      await fetchBooked(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'That did not work');
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <span className={`inline-flex flex-col items-end gap-0.5 ${className ?? ''}`}>
        <button type="button" onClick={() => { setDone(null); setOpen(true); }}
          className="rounded-lg border border-sky-300 bg-sky-50 px-3 py-1.5 text-xs font-medium text-sky-800 hover:bg-sky-100">
          {given.length > 0 ? `Given to ${given.map(g => g.personName.split(' ')[0]).join(', ')}` : 'Give to a freelancer'}
        </button>
        {done && <span className="max-w-xs text-right text-[11px] text-emerald-700">{done}</span>}
      </span>

      {open && (
        <ModalShell title={`Give the ${reg} prep to…`} subtitle="People booked in today or tomorrow" onClose={close} width="max-w-lg">
          <div className="space-y-3">
            <ul className="space-y-1.5">
              {booked.map(b => {
                const active = pick?.owner.id === b.owner.id;
                const already = hasVan(b);
                return (
                  <li key={b.owner.id}>
                    <button type="button" disabled={already}
                      onClick={() => setPick(b)}
                      className={`w-full text-left px-3 py-2 rounded-lg border text-sm ${
                        active ? 'border-ooosh-400 bg-ooosh-50' : 'border-gray-200 hover:bg-gray-50'
                      } disabled:opacity-50 disabled:hover:bg-transparent`}>
                      <span className="font-medium text-gray-900">{b.personName}</span>
                      <span className="text-gray-500"> · {describe(b)}</span>
                      {already && <span className="ml-1 text-xs text-gray-400">(already on their list)</span>}
                    </button>
                  </li>
                );
              })}
            </ul>
            <SearchPicker value={job} onChange={setJob} loadOptions={searchJobs} minChars={2}
              placeholder="For a job (optional) — type a number, band or client" />
            <textarea value={note} onChange={e => setNote(e.target.value)} rows={2} maxLength={500}
              placeholder="Anything to add (optional)"
              className="w-full text-sm border border-gray-300 rounded-lg px-3 py-2" />
            {error && <p className="text-sm text-red-700" role="alert">{error}</p>}
            <div className="flex justify-end gap-2 pt-2 border-t border-gray-100">
              <button type="button" onClick={close}
                className="px-4 py-2 text-sm rounded-lg border border-gray-300 bg-white hover:bg-gray-50">Cancel</button>
              <button type="button" onClick={() => void give()} disabled={busy || !pick}
                className="px-4 py-2 text-sm font-medium rounded-lg bg-ooosh-600 text-white hover:bg-ooosh-700 disabled:opacity-50">
                {busy ? 'Adding…' : 'Add to their list'}
              </button>
            </div>
          </div>
        </ModalShell>
      )}
    </>
  );
}
