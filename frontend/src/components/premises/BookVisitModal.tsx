/**
 * Book the contractor in — or change the booking (docs/PREMISES-COMPLIANCE-SPEC.md §1.8, §16).
 *
 * "Northside are coming on 14 Dec at 10:00, Sam letting them in." One live
 * booking per check. Saving it turns the check's reminder into "… coming on …
 * — let them in" for whoever is letting them in (else the owner), and puts the
 * visit on the staff calendar. Recording the visit marks it done.
 *
 * Times are quarter hours from QuarterHourSelect (frontend.md "Time inputs").
 */
import { useState } from 'react';
import { api } from '../../services/api';
import { ukToday } from '../../lib/ukDate';
import { QuarterHourSelect } from '../QuarterHourSelect';
import { PremisesCheck, PremisesMeta, VISIBILITY_RANK } from './premisesCopy';

export default function BookVisitModal({ check, meta, onClose, onSaved }: {
  check: PremisesCheck;
  meta: PremisesMeta;
  onClose: () => void;
  onSaved: (updated: PremisesCheck) => void;
}) {
  const today = ukToday();
  const [visitOn, setVisitOn] = useState(check.booking_on ?? '');
  const [timeSet, setTimeSet] = useState(check.booking_id ? !!check.booking_time : true);
  const [visitTime, setVisitTime] = useState(check.booking_time ?? '10:00');
  const [person, setPerson] = useState(check.booking_id ? (check.booking_letting_in_person_id ?? '') : '');
  const [note, setNote] = useState(check.booking_note ?? '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Only people who can open the check — their To Do links to it.
  const people = meta.people.filter(p => p.rank >= VISIBILITY_RANK[check.visibility]);

  async function save() {
    setSaving(true); setError(null);
    try {
      const res = await api.post<{ data: PremisesCheck }>(`/premises/checks/${check.id}/booking`, {
        visit_on: visitOn, visit_time: timeSet ? visitTime : null, letting_in_person_id: person || null, note: note.trim() || null,
      });
      onSaved(res.data);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not book it');
      setSaving(false);
    }
  }

  const label = 'block text-xs font-medium text-gray-600 mb-1';
  const input = 'w-full px-3 py-2 border border-gray-300 rounded text-sm bg-white';

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/50" onClick={() => { if (!saving) onClose(); }} />
      <div className="relative bg-white rounded-xl shadow-xl w-full max-w-md mx-4 p-6 max-h-[92vh] overflow-y-auto">
        <h3 className="text-lg font-semibold text-gray-900 mb-1">{check.booking_id ? 'Change the booking' : 'Book a visit'}</h3>
        <p className="text-sm text-gray-500 mb-4">{check.title}{check.contractor_name ? ` · ${check.contractor_name}` : ''}</p>
        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className={label} htmlFor="bv-date">Coming on</label>
              <input id="bv-date" type="date" min={today} value={visitOn} onChange={e => setVisitOn(e.target.value)} className={input} />
            </div>
            <div>
              <span className={label}>At</span>
              <QuarterHourSelect value={visitTime} onChange={setVisitTime} disabled={!timeSet} aria-label="Time"
                className={`${input} disabled:opacity-40`} />
              <label className="inline-flex items-center gap-1.5 text-xs text-gray-600 mt-1">
                <input type="checkbox" checked={!timeSet} onChange={e => setTimeSet(!e.target.checked)} /> No set time
              </label>
            </div>
          </div>
          <div>
            <label className={label} htmlFor="bv-person">Letting them in</label>
            <select id="bv-person" value={person} onChange={e => setPerson(e.target.value)} className={input}>
              <option value="">Whoever looks after the check{check.owner_name ? ` (${check.owner_name})` : ''}</option>
              {people.map(p => <option key={p.person_id} value={p.person_id}>{p.name ?? 'Unnamed'}</option>)}
            </select>
            <p className="text-xs text-gray-500 mt-1">They get a To Do for the day. It shows on the staff calendar too.</p>
          </div>
          <div>
            <label className={label} htmlFor="bv-note">Note</label>
            <input id="bv-note" value={note} onChange={e => setNote(e.target.value)} maxLength={1000}
              placeholder="e.g. Use the side gate; needs the boiler cupboard key" className={input} />
          </div>
        </div>
        {error && <p className="text-sm text-red-700 mt-4">{error}</p>}
        <div className="flex justify-end gap-2 mt-5">
          <button type="button" onClick={onClose} disabled={saving}
            className="px-3 py-1.5 text-sm rounded border border-gray-300 hover:bg-gray-50 disabled:opacity-40">Cancel</button>
          <button type="button" onClick={() => void save()} disabled={saving || !visitOn || visitOn < today}
            className="px-3 py-1.5 text-sm rounded bg-ooosh-600 text-white hover:bg-ooosh-700 disabled:opacity-40">
            {saving ? 'Saving…' : check.booking_id ? 'Save' : 'Book it'}
          </button>
        </div>
      </div>
    </div>
  );
}
