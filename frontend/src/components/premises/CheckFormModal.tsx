/**
 * Add or change a premises check (docs/PREMISES-COMPLIANCE-SPEC.md).
 *
 * How often it comes round uses the To Do module's own repeat form
 * (RecurrenceFields) and its words, so "every year on 1 Jan" and "12 months
 * after the last one" mean exactly what they mean on a repeating to-do. The
 * page does no date arithmetic: the server works out the next due date.
 *
 * On a change, only the fields that actually changed are sent — so renaming a
 * check can't move its due date.
 */
import { useEffect, useMemo, useState } from 'react';
import { api } from '../../services/api';
import { ukToday } from '../../lib/ukDate';
import SearchPicker, { PickerOption } from '../SearchPicker';
import { RecurrenceFields, RepeatValue } from '../RecurrenceFields';
import {
  CheckKind, KIND_HINT, KIND_LABEL, METER_UNITS, PremisesCheck, PremisesMeta, VISIBILITY_LABEL, VISIBILITY_RANK, Visibility,
} from './premisesCopy';

interface FormState {
  title: string;
  kind: CheckKind;
  heading_id: string;
  place_id: string;
  visibility: Visibility;
  owner_person_id: string;
  contractor: PickerOption | null;
  responsibility: 'ours' | 'landlord';
  repeats: boolean;
  repeat: RepeatValue;
  next_due: string;
  remind_days_before: number;
  location_note: string;
  why_note: string;
  notes: string;
  /** Meter readings. */
  unit: string;
  meter_serial: string;
  /** A rotating test's call points — one per line. */
  points: string;
  /** A Staff Document this check feeds (e.g. the fire risk assessment) — spec §16. */
  staff_document_id: string;
}

const DEFAULT_REMIND: Record<CheckKind, number> = { visit: 30, renewal: 30, test: 0, reading: 0 };

function initialState(meta: PremisesMeta, check: PremisesCheck | null): FormState {
  const firstActive = (list: { id: string; retired_at: string | null }[]) => list.find(x => !x.retired_at)?.id ?? '';
  return {
    title: check?.title ?? '',
    kind: check?.kind ?? 'visit',
    heading_id: check?.heading_id ?? firstActive(meta.headings),
    place_id: check?.place_id ?? firstActive(meta.places),
    visibility: check?.visibility ?? 'all',
    owner_person_id: check?.owner_person_id ?? '',
    contractor: check?.contractor_org_id ? { value: check.contractor_org_id, label: check.contractor_name ?? 'Organisation' } : null,
    responsibility: check?.responsibility ?? 'ours',
    repeats: check ? !!check.repeat_mode : true,
    repeat: check?.repeat_mode && check.repeat_rule
      ? { mode: check.repeat_mode, rule: check.repeat_rule, endsOn: null, endsAfter: null, text: check.repeat_text }
      : { mode: 'after_done', rule: { freq: 'year', interval: 1 }, endsOn: null, endsAfter: null, text: '' },
    next_due: check?.next_due ?? '',
    remind_days_before: check?.remind_days_before ?? 30,
    location_note: check?.location_note ?? '',
    why_note: check?.why_note ?? '',
    notes: check?.notes ?? '',
    unit: check?.unit ?? 'kWh',
    meter_serial: check?.meter_serial ?? '',
    points: (check?.points ?? []).join('\n'),
    staff_document_id: check?.staff_document_id ?? '',
  };
}

/** What the API takes, from the form. */
function toPayload(f: FormState) {
  return {
    title: f.title.trim(),
    kind: f.kind,
    heading_id: f.heading_id,
    place_id: f.place_id,
    visibility: f.visibility,
    owner_person_id: f.owner_person_id || null,
    contractor_org_id: f.contractor?.value ?? null,
    responsibility: f.responsibility,
    repeat: f.repeats ? { mode: f.repeat.mode, rule: f.repeat.rule } : null,
    next_due: f.next_due || null,
    remind_days_before: f.remind_days_before,
    location_note: f.location_note.trim() || null,
    why_note: f.why_note.trim() || null,
    notes: f.notes.trim() || null,
    unit: f.kind === 'reading' ? (f.unit.trim() || null) : null,
    meter_serial: f.kind === 'reading' ? (f.meter_serial.trim() || null) : null,
    points: f.kind === 'test' ? f.points.split('\n').map(p => p.trim()).filter(Boolean) : [],
    staff_document_id: f.staff_document_id || null,
  };
}

async function searchOrgs(q: string): Promise<PickerOption[]> {
  const res = await api.get<{ data: { id: string; name: string; type: string | null }[] }>(
    `/organisations?search=${encodeURIComponent(q)}&limit=10`);
  return (res.data || []).map(o => ({ value: o.id, label: o.name, hint: o.type ?? undefined }));
}

export default function CheckFormModal({ meta, check, onClose, onSaved }: {
  meta: PremisesMeta;
  /** null = a new check. */
  check: PremisesCheck | null;
  onClose: () => void;
  onSaved: (saved: PremisesCheck) => void;
}) {
  const [f, setF] = useState<FormState>(() => initialState(meta, check));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const set = <K extends keyof FormState>(k: K, v: FormState[K]) => setF(prev => ({ ...prev, [k]: v }));
  // Staff Documents to link to. Manager-tier list; if it can't be read the picker just shows what's linked.
  const [staffDocs, setStaffDocs] = useState<{ id: string; title: string }[]>([]);
  useEffect(() => {
    api.get<{ data: { id: string; title: string }[] }>('/staff-documents')
      .then(r => setStaffDocs((r.data || []).map(d => ({ id: d.id, title: d.title }))))
      .catch(() => { /* optional */ });
  }, []);
  const docMissing = !!check?.staff_document_id && !staffDocs.some(d => d.id === check.staff_document_id);

  const startsOn = f.next_due || ukToday();
  const isAdmin = meta.can.admin;
  const visChoices: Visibility[] = isAdmin ? ['all', 'managers', 'admins'] : ['all', 'managers'];

  // A <select> must carry a retired or departed current value, or it renders blank and saves blank.
  const headings = meta.headings.filter(h => !h.retired_at || h.id === f.heading_id);
  const places = meta.places.filter(p => !p.retired_at || p.id === f.place_id);
  const ownerMissing = !!check?.owner_person_id && !meta.people.some(p => p.person_id === check.owner_person_id);

  const ownerProblem = useMemo(() => {
    const o = meta.people.find(p => p.person_id === f.owner_person_id);
    if (!o) return null;
    return o.rank < VISIBILITY_RANK[f.visibility] ? `${o.name ?? 'They'} can't see a ${VISIBILITY_LABEL[f.visibility].toLowerCase()} check` : null;
  }, [meta.people, f.owner_person_id, f.visibility]);

  async function save() {
    setSaving(true); setError(null);
    try {
      const payload = toPayload(f);
      let res: { data: PremisesCheck };
      if (!check) {
        res = await api.post<{ data: PremisesCheck }>('/premises/checks', payload);
      } else {
        const before = toPayload(initialState(meta, check)) as Record<string, unknown>;
        const changed: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(payload)) {
          if (JSON.stringify(v) !== JSON.stringify(before[k])) changed[k] = v;
        }
        res = Object.keys(changed).length
          ? await api.patch<{ data: PremisesCheck }>(`/premises/checks/${check.id}`, changed)
          : { data: check };
      }
      onSaved(res.data);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save it');
      setSaving(false);
    }
  }

  const label = 'block text-xs font-medium text-gray-600 mb-1';
  const input = 'w-full px-3 py-2 border border-gray-300 rounded text-sm bg-white';

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/50" onClick={() => { if (!saving) onClose(); }} />
      <div className="relative bg-white rounded-xl shadow-xl w-full max-w-2xl mx-4 p-6 max-h-[92vh] overflow-y-auto">
        <h3 className="text-lg font-semibold text-gray-900 mb-4">{check ? 'Change check' : 'Add a check'}</h3>

        <div className="space-y-4">
          <div>
            <label className={label} htmlFor="pc-title">Name</label>
            <input id="pc-title" value={f.title} onChange={e => set('title', e.target.value)} maxLength={200}
              placeholder="e.g. Gas safety inspection" className={input} autoFocus={!check} />
          </div>

          <div>
            <span className={label}>What kind of check</span>
            <div className="grid sm:grid-cols-2 gap-2">
              {(['visit', 'test', 'renewal', 'reading'] as CheckKind[]).map(k => (
                <button key={k} type="button" onClick={() => {
                  setF(prev => ({ ...prev, kind: k, remind_days_before: check ? prev.remind_days_before : DEFAULT_REMIND[k] }));
                }}
                  className={`text-left rounded border px-3 py-2 ${f.kind === k ? 'border-ooosh-600 bg-ooosh-50' : 'border-gray-200 hover:bg-gray-50'}`}>
                  <span className="block text-sm font-medium text-gray-900">{KIND_LABEL[k]}</span>
                  <span className="block text-xs text-gray-500 mt-0.5">{KIND_HINT[k]}</span>
                </button>
              ))}
            </div>
          </div>

          <div className="grid sm:grid-cols-2 gap-3">
            <div>
              <label className={label} htmlFor="pc-heading">Heading</label>
              <select id="pc-heading" value={f.heading_id} onChange={e => set('heading_id', e.target.value)} className={input}>
                {headings.map(h => <option key={h.id} value={h.id}>{h.name}{h.retired_at ? ' (retired)' : ''}</option>)}
              </select>
            </div>
            <div>
              <label className={label} htmlFor="pc-place">Place</label>
              <select id="pc-place" value={f.place_id} onChange={e => set('place_id', e.target.value)} className={input}>
                {places.map(p => <option key={p.id} value={p.id}>{p.name}{p.retired_at ? ' (retired)' : ''}</option>)}
              </select>
            </div>
          </div>

          <div className="grid sm:grid-cols-2 gap-3">
            <div>
              <label className={label} htmlFor="pc-owner">Who looks after it</label>
              <select id="pc-owner" value={f.owner_person_id} onChange={e => set('owner_person_id', e.target.value)} className={input}>
                <option value="">Nobody yet (no reminders)</option>
                {ownerMissing && <option value={check!.owner_person_id!}>{check!.owner_name ?? 'Unknown'}</option>}
                {meta.people.map(p => (
                  <option key={p.person_id} value={p.person_id}>{p.name ?? 'Unnamed'}</option>
                ))}
              </select>
              {ownerProblem && <p className="text-xs text-red-700 mt-1">{ownerProblem}</p>}
            </div>
            <div>
              <label className={label} htmlFor="pc-vis">Who can see it</label>
              <select id="pc-vis" value={f.visibility} onChange={e => set('visibility', e.target.value as Visibility)} className={input}>
                {!visChoices.includes(f.visibility) && <option value={f.visibility}>{VISIBILITY_LABEL[f.visibility]}</option>}
                {visChoices.map(v => <option key={v} value={v}>{VISIBILITY_LABEL[v]}</option>)}
              </select>
              <p className="text-xs text-gray-500 mt-1">Its certificates follow it. Never freelancers.</p>
            </div>
          </div>

          <div className="grid sm:grid-cols-2 gap-3">
            {f.kind === 'visit' && (
              <div>
                <span className={label}>Contractor</span>
                <SearchPicker value={f.contractor} onChange={v => set('contractor', v)} loadOptions={searchOrgs}
                  minChars={2} placeholder="Search the address book…" />
              </div>
            )}
            <div>
              <span className={label}>Whose job is it</span>
              <div className="flex gap-4 text-sm py-2">
                <label className="inline-flex items-center gap-1.5">
                  <input type="radio" checked={f.responsibility === 'ours'} onChange={() => set('responsibility', 'ours')} /> Ours
                </label>
                <label className="inline-flex items-center gap-1.5">
                  <input type="radio" checked={f.responsibility === 'landlord'} onChange={() => set('responsibility', 'landlord')} />
                  The landlord's (we keep the copy)
                </label>
              </div>
            </div>
          </div>

          {f.kind === 'reading' && (
            <div className="grid sm:grid-cols-2 gap-3">
              <div>
                <label className={label} htmlFor="pc-unit">Unit</label>
                <select id="pc-unit" value={f.unit} onChange={e => set('unit', e.target.value)} className={input}>
                  {!METER_UNITS.includes(f.unit) && <option value={f.unit}>{f.unit || '—'}</option>}
                  {METER_UNITS.map(u => <option key={u} value={u}>{u}</option>)}
                </select>
              </div>
              <div>
                <label className={label} htmlFor="pc-serial">Meter serial number</label>
                <input id="pc-serial" value={f.meter_serial} onChange={e => set('meter_serial', e.target.value)} maxLength={60}
                  placeholder="Optional — it's on the meter" className={input} />
              </div>
            </div>
          )}
          {f.kind === 'test' && (
            <div>
              <label className={label} htmlFor="pc-points">Call points to rotate through</label>
              <textarea id="pc-points" value={f.points} onChange={e => set('points', e.target.value)} rows={3}
                placeholder={'One per line, in order — e.g.\nCP1 Front door\nCP2 Warehouse'} className={input} />
              <p className="text-xs text-gray-500 mt-1">
                Each test asks for the next one along, and the To Do says which. Leave empty if it doesn't rotate.
              </p>
            </div>
          )}

          <div className="rounded border border-gray-200 p-3 space-y-3">
            <span className={label}>How often</span>
            <div className="flex flex-wrap gap-4 text-sm">
              <label className="inline-flex items-center gap-1.5">
                <input type="radio" checked={f.repeats} onChange={() => set('repeats', true)} /> It comes round
              </label>
              <label className="inline-flex items-center gap-1.5">
                <input type="radio" checked={!f.repeats} onChange={() => set('repeats', false)} /> One date only (a rent review, a lease break)
              </label>
            </div>
            <div className="grid sm:grid-cols-2 gap-3">
              <div>
                <label className={label} htmlFor="pc-due">Next due</label>
                <input id="pc-due" type="date" value={f.next_due} onChange={e => set('next_due', e.target.value)} className={input} />
                <p className="text-xs text-gray-500 mt-1">Leave empty until you know — it fills in when it's first recorded. On a schedule, the schedule counts from this date.</p>
              </div>
              <div>
                <label className={label} htmlFor="pc-remind">Remind them</label>
                <div className="flex items-center gap-2 text-sm">
                  <input id="pc-remind" type="number" min={0} max={365} value={f.remind_days_before}
                    onChange={e => set('remind_days_before', Math.max(0, Math.min(365, Math.round(Number(e.target.value) || 0))))}
                    className="w-20 px-2 py-2 border border-gray-300 rounded" />
                  <span className="text-gray-600">days before it's due (0 = on the day)</span>
                </div>
              </div>
            </div>
            {f.repeats && (
              <>
                <p className="text-xs text-gray-500">
                  "After the last one is done" counts from the day it was actually done — every 12 months from the last gas
                  visit. "On a schedule" keeps to the calendar — every year on 1 Jan, every Thursday — counting from
                  the next due date above.
                </p>
                <RecurrenceFields value={f.repeat} onChange={v => set('repeat', v)} startsOn={startsOn} showEnds={false} />
              </>
            )}
          </div>

          <div className="grid sm:grid-cols-2 gap-3">
            <div>
              <label className={label} htmlFor="pc-where">Where it is</label>
              <input id="pc-where" value={f.location_note} onChange={e => set('location_note', e.target.value)} maxLength={500}
                placeholder="e.g. Boiler cupboard, warehouse mezzanine" className={input} />
            </div>
            <div>
              <label className={label} htmlFor="pc-why">Why we do it</label>
              <input id="pc-why" value={f.why_note} onChange={e => set('why_note', e.target.value)} maxLength={1000}
                placeholder="e.g. Insurer asks for it every year" className={input} />
            </div>
          </div>
          <div>
            <label className={label} htmlFor="pc-notes">Notes</label>
            <textarea id="pc-notes" value={f.notes} onChange={e => set('notes', e.target.value)} rows={2} maxLength={4000} className={input} />
          </div>
          <div>
            <label className={label} htmlFor="pc-doc">Staff document it feeds</label>
            <select id="pc-doc" value={f.staff_document_id} onChange={e => set('staff_document_id', e.target.value)} className={input}>
              <option value="">None</option>
              {docMissing && <option value={check!.staff_document_id!}>{check!.staff_document_title ?? 'Linked document'}</option>}
              {staffDocs.map(d => <option key={d.id} value={d.id}>{d.title}</option>)}
            </select>
            <p className="text-xs text-gray-500 mt-1">e.g. the fire risk assessment. Recording this check then reminds you to issue a new version.</p>
          </div>
        </div>

        {error && <p className="text-sm text-red-700 mt-4">{error}</p>}
        <div className="flex justify-end gap-2 mt-5">
          <button type="button" onClick={onClose} disabled={saving}
            className="px-3 py-1.5 text-sm rounded border border-gray-300 hover:bg-gray-50 disabled:opacity-40">Cancel</button>
          <button type="button" onClick={() => void save()}
            disabled={saving || !f.title.trim() || !f.heading_id || !f.place_id || !!ownerProblem || (f.repeats && !f.repeat.text)}
            className="px-3 py-1.5 text-sm rounded bg-ooosh-600 text-white hover:bg-ooosh-700 disabled:opacity-40">
            {saving ? 'Saving…' : check ? 'Save' : 'Add check'}
          </button>
        </div>
      </div>
    </div>
  );
}
