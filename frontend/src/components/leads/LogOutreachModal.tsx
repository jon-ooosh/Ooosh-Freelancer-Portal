/**
 * "Log outreach" — we've contacted this band. Records a note on the lead and,
 * by default, opens a Cold enquiry in the pipeline whose first chase falls in
 * N days, so the normal chase model reminds us to follow up. OP only — nothing
 * goes to HireHop. If they never reply, the enquiry auto-loses as "No Decision"
 * and the band's history shows it as unanswered outreach, not a loss.
 */
import { useEffect, useState } from 'react';
import { api } from '../../services/api';
import LeadModal from './LeadModal';
import type { Lead } from './leadTypes';

interface Person { id: string; name: string; email: string | null; role: string; }

const CHASE_OPTIONS = [3, 5, 7, 10, 14, 21];

export default function LogOutreachModal({ lead, onClose, onDone, onAddToAddressBook }: {
  lead: Lead;
  onClose: () => void;
  onDone: (result: { jobId: string | null; chaseInDays: number }) => void;
  /** Not in the address book yet → offer to do that first. */
  onAddToAddressBook: () => void;
}) {
  const inBook = Boolean(lead.matched_organisation_id);
  const [note, setNote] = useState('');
  const [createEnquiry, setCreateEnquiry] = useState(inBook);
  const [chaseIn, setChaseIn] = useState(7);
  const [people, setPeople] = useState<Person[] | null>(inBook ? null : []);
  const [picked, setPicked] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!inBook) return;
    let alive = true;
    (async () => {
      try {
        const r = await api.get<{ data: { people: Person[] } }>(`/leads/${lead.id}/enquiry-preview`);
        if (!alive) return;
        setPeople(r.data.people);
        setPicked(r.data.people[0] ? [r.data.people[0].id] : []);
      } catch (e) {
        if (alive) { setPeople([]); setError(e instanceof Error ? e.message : 'Failed to load contacts'); }
      }
    })();
    return () => { alive = false; };
  }, [lead.id, inBook]);

  const toggle = (id: string) => setPicked((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));

  const submit = async () => {
    setSaving(true); setError(null);
    try {
      const r = await api.post<{ data: { job_id: string | null } }>(`/leads/${lead.id}/log-outreach`, {
        note: note.trim() || null,
        create_enquiry: createEnquiry,
        chase_in_days: chaseIn,
        contact_person_ids: createEnquiry ? picked : [],
        primary_contact_person_id: createEnquiry ? (picked[0] ?? null) : null,
      });
      onDone({ jobId: r.data.job_id, chaseInDays: chaseIn });
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to log outreach');
      setSaving(false);
    }
  };

  const chaseDate = (() => {
    const d = new Date(); d.setDate(d.getDate() + chaseIn);
    return d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });
  })();

  return (
    <LeadModal
      title={`Log outreach — ${lead.artist_name}`}
      onClose={onClose}
      footer={(
        <>
          <button onClick={onClose} className="px-3 py-2 text-sm text-gray-600 hover:text-gray-800">Cancel</button>
          <button onClick={submit} disabled={saving || (inBook && people == null)}
            className="px-4 py-2 rounded-lg bg-[#7B5EA7] text-white text-sm font-medium hover:bg-[#6a4f92] disabled:opacity-50">
            {saving ? 'Saving…' : createEnquiry ? 'Log + create enquiry' : 'Log outreach'}
          </button>
        </>
      )}
    >
      <label className="block mb-4">
        <span className="block text-xs text-gray-500 mb-1">What did you send? (optional)</span>
        <textarea value={note} onChange={(e) => setNote(e.target.value)} rows={2} maxLength={2000}
          placeholder="e.g. Emailed their manager about vans + backline for the November run"
          className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm" />
      </label>

      <label className={`flex items-start gap-2 ${inBook ? 'cursor-pointer' : 'opacity-60'}`}>
        <input type="checkbox" className="mt-0.5" disabled={!inBook} checked={createEnquiry} onChange={() => setCreateEnquiry(!createEnquiry)} />
        <span>
          <span className="block font-medium text-gray-900">Put it in the pipeline so we follow up</span>
          <span className="block text-xs text-gray-500">
            A Cold enquiry (OP only, not HireHop) whose first chase falls when you choose. If they never reply it
            closes itself and doesn’t count against them.
          </span>
        </span>
      </label>
      {!inBook && (
        <p className="mt-2 ml-6 text-xs text-amber-700">
          {lead.artist_name} isn’t in the address book yet.{' '}
          <button onClick={onAddToAddressBook} className="underline hover:text-amber-900">Add them first</button>
          {' '}to put this in the pipeline — or just log it.
        </p>
      )}

      {inBook && createEnquiry && (
        <div className="mt-3 ml-6 space-y-3">
          <label className="flex items-center gap-2">
            <span className="text-gray-700">Chase in</span>
            <select value={chaseIn} onChange={(e) => setChaseIn(Number(e.target.value))}
              className="rounded border border-gray-300 px-2 py-1 text-sm">
              {CHASE_OPTIONS.map((d) => <option key={d} value={d}>{d} days</option>)}
            </select>
            <span className="text-xs text-gray-400">({chaseDate})</span>
          </label>
          {people == null ? (
            <div className="text-xs text-gray-400">Loading contacts…</div>
          ) : people.length > 0 ? (
            <div>
              <div className="text-xs text-gray-500 mb-1">Who you contacted (first ticked = primary):</div>
              <ul className="space-y-1">
                {people.map((p) => (
                  <li key={p.id}>
                    <label className="flex items-center gap-2 cursor-pointer">
                      <input type="checkbox" checked={picked.includes(p.id)} onChange={() => toggle(p.id)} />
                      <span className="text-gray-900">{p.name}</span>
                      <span className="text-xs text-gray-400">· {p.role}{p.email ? ` · ${p.email}` : ''}</span>
                    </label>
                  </li>
                ))}
              </ul>
            </div>
          ) : (
            <p className="text-xs text-gray-400">No people linked to this band yet — the enquiry will have no contact.</p>
          )}
        </div>
      )}
      {error && <div className="mt-3 rounded-lg bg-red-50 text-red-800 px-3 py-2">{error}</div>}
    </LeadModal>
  );
}
