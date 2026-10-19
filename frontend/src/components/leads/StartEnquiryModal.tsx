/**
 * Start an OP enquiry from a lead. Goes through the same createPipelineEnquiry
 * as the staff New Enquiry form. OP only — nothing is sent to HireHop.
 */
import { useEffect, useState } from 'react';
import { api } from '../../services/api';
import LeadModal from './LeadModal';
import { fmtDateYear, Lead } from './leadTypes';

interface Person { id: string; name: string; email: string | null; role: string; }
interface Preview { organisation: { id: string; name: string; type: string | null } | null; people: Person[]; }

export default function StartEnquiryModal({ lead, onClose, onDone }: {
  lead: Lead;
  onClose: () => void;
  onDone: (jobId: string) => void;
}) {
  const [preview, setPreview] = useState<Preview | null>(null);
  const [picked, setPicked] = useState<string[]>([]);
  const [primary, setPrimary] = useState<string | null>(null);
  const [details, setDetails] = useState(
    `${lead.artist_name} touring the UK — ${lead.uk_date_count} date(s), ${fmtDateYear(lead.first_date)} to ${fmtDateYear(lead.last_date)}. Found by the Lead Finder.`,
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const r = await api.get<{ data: Preview }>(`/leads/${lead.id}/enquiry-preview`);
        if (!alive) return;
        setPreview(r.data);
        const first = r.data.people[0]?.id ?? null;
        setPicked(first ? [first] : []);
        setPrimary(first);
      } catch (e) {
        if (alive) setError(e instanceof Error ? e.message : 'Failed to load');
      }
    })();
    return () => { alive = false; };
  }, [lead.id]);

  const toggle = (id: string) => setPicked((prev) => {
    const next = prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id];
    if (!next.includes(primary ?? '')) setPrimary(next[0] ?? null);
    return next;
  });

  const submit = async () => {
    setSaving(true); setError(null);
    try {
      const r = await api.post<{ data: { job_id: string } }>(`/leads/${lead.id}/start-enquiry`, {
        contact_person_ids: picked, primary_contact_person_id: primary, details: details.trim() || null,
      });
      onDone(r.data.job_id);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to create the enquiry');
      setSaving(false);
    }
  };

  return (
    <LeadModal
      wide
      title={`Start an enquiry — ${lead.artist_name}`}
      onClose={onClose}
      footer={(
        <>
          <button onClick={onClose} className="px-3 py-2 text-sm text-gray-600 hover:text-gray-800">Cancel</button>
          <button onClick={submit} disabled={!preview || saving}
            className="px-4 py-2 rounded-lg bg-[#7B5EA7] text-white text-sm font-medium hover:bg-[#6a4f92] disabled:opacity-50">
            {saving ? 'Creating…' : 'Create enquiry'}
          </button>
        </>
      )}
    >
      {!preview && !error && <div className="text-gray-400 py-6 text-center">Loading…</div>}
      {preview && (
        <>
          <p className="mb-3 text-gray-500">
            Creates a new enquiry in the pipeline for <b className="text-gray-900">{preview.organisation?.name}</b>
            {' '}({lead.stream === 'warm' ? 'returning client' : 'cold lead'}), with the tour dates, venues and the lead’s
            assessment in the notes. It stays in OP — nothing goes to HireHop until you push it.
          </p>
          <div className="text-xs font-semibold uppercase text-gray-400 mb-2">Contacts on the enquiry</div>
          {preview.people.length === 0 ? (
            <p className="text-gray-400 mb-3">No people are linked to this organisation yet — you can add contacts on the job afterwards.</p>
          ) : (
            <ul className="space-y-1.5 mb-3">
              {preview.people.map((p) => (
                <li key={p.id} className="flex items-center gap-2">
                  <input type="checkbox" checked={picked.includes(p.id)} onChange={() => toggle(p.id)} />
                  <span className="font-medium text-gray-900">{p.name}</span>
                  <span className="text-gray-400">· {p.role}{p.email ? ` · ${p.email}` : ''}</span>
                  {picked.includes(p.id) && (
                    <button onClick={() => setPrimary(p.id)}
                      className={`ml-auto text-xs ${primary === p.id ? 'text-amber-600' : 'text-gray-400 hover:text-amber-600'}`}
                      title="Primary contact">
                      {primary === p.id ? '★ primary' : '☆ make primary'}
                    </button>
                  )}
                </li>
              ))}
            </ul>
          )}
          <label className="block">
            <span className="block text-xs font-semibold uppercase text-gray-400 mb-1">Details</span>
            <textarea value={details} onChange={(e) => setDetails(e.target.value)} rows={3} maxLength={5000}
              className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm" />
          </label>
        </>
      )}
      {error && <div className="mt-3 rounded-lg bg-red-50 text-red-800 px-3 py-2">{error}</div>}
    </LeadModal>
  );
}
