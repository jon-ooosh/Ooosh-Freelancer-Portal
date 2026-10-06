/**
 * "Add to address book" for a lead — staff-gated, never automatic.
 * Shows similar organisations already in the book ("did you mean…?") so a
 * duplicate band isn't created, then adds the chosen researched contacts
 * (matched by exact email — someone we already hold is linked, not duplicated).
 */
import { useEffect, useState } from 'react';
import { api } from '../../services/api';
import LeadModal from './LeadModal';
import type { Lead, LeadContact } from './leadTypes';

interface SimilarOrg { id: string; name: string; type: string | null; similarity: number | null; exact: boolean; via?: 'org_name' | 'job_name'; job_count?: number; }
interface PreviewContact extends LeadContact {
  idx: number;
  can_add: boolean;
  existing_person: { id: string; name: string } | null;
  role: string;
}
interface Preview { proposed_name: string; similar: SimilarOrg[]; contacts: PreviewContact[]; }

export default function AddToAddressBookModal({ lead, onClose, onDone }: {
  lead: Lead;
  onClose: () => void;
  onDone: (message: string) => void;
}) {
  const [preview, setPreview] = useState<Preview | null>(null);
  const [choice, setChoice] = useState<string>('new'); // 'new' or an org id
  const [name, setName] = useState(lead.artist_name);
  const [picked, setPicked] = useState<Set<number>>(new Set());
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const r = await api.get<{ data: Preview }>(`/leads/${lead.id}/address-book-preview`);
        if (!alive) return;
        setPreview(r.data);
        const exact = r.data.similar.find((s) => s.exact);
        if (exact) setChoice(exact.id);
        // Pre-tick contacts we can add that the research was reasonably sure of.
        setPicked(new Set(r.data.contacts.filter((c) => c.can_add && c.confidence !== 'low').map((c) => c.idx)));
      } catch (e) {
        if (alive) setError(e instanceof Error ? e.message : 'Failed to load');
      }
    })();
    return () => { alive = false; };
  }, [lead.id]);

  const toggle = (idx: number) => setPicked((prev) => {
    const next = new Set(prev);
    if (next.has(idx)) next.delete(idx); else next.add(idx);
    return next;
  });

  const submit = async () => {
    setSaving(true); setError(null);
    try {
      const body = choice === 'new'
        ? { create_name: name.trim(), contact_indexes: Array.from(picked) }
        : { organisation_id: choice, contact_indexes: Array.from(picked) };
      const r = await api.post<{ data: { created: boolean; contacts_added: { outcome: string }[]; contacts_skipped: string[] } }>(
        `/leads/${lead.id}/add-to-address-book`, body,
      );
      const d = r.data;
      const added = d.contacts_added.length;
      onDone(`${d.created ? 'Created' : 'Linked'} ${choice === 'new' ? name.trim() : preview?.similar.find((s) => s.id === choice)?.name ?? 'the organisation'}`
        + (added ? `, with ${added} contact${added === 1 ? '' : 's'}` : '') + '.');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to add');
      setSaving(false);
    }
  };

  const exactExists = preview?.similar.some((s) => s.exact);

  return (
    <LeadModal
      wide
      title={`Add ${lead.artist_name} to the address book`}
      onClose={onClose}
      footer={(
        <>
          <button onClick={onClose} className="px-3 py-2 text-sm text-gray-600 hover:text-gray-800">Cancel</button>
          <button onClick={submit} disabled={!preview || saving || (choice === 'new' && !name.trim())}
            className="px-4 py-2 rounded-lg bg-[#7B5EA7] text-white text-sm font-medium hover:bg-[#6a4f92] disabled:opacity-50">
            {saving ? 'Saving…' : choice === 'new' ? 'Create band' : 'Link to this organisation'}
          </button>
        </>
      )}
    >
      {!preview && !error && <div className="text-gray-400 py-6 text-center">Checking the address book…</div>}
      {preview && (
        <>
          <div className="text-xs font-semibold uppercase text-gray-400 mb-2">Organisation</div>
          {preview.similar.length > 0 && (
            <p className="mb-2 text-gray-500">
              {exactExists ? 'This name is already in the address book — link to it rather than creating a duplicate.' : 'Similar names already in the address book — is it one of these?'}
            </p>
          )}
          <div className="space-y-1.5">
            {preview.similar.map((s) => (
              <label key={s.id} className={`flex items-center gap-2 rounded-lg border px-3 py-2 cursor-pointer ${choice === s.id ? 'border-[#7B5EA7] bg-purple-50' : 'border-gray-200 hover:bg-gray-50'}`}>
                <input type="radio" name="org-choice" checked={choice === s.id} onChange={() => setChoice(s.id)} />
                <span className="font-medium text-gray-900">{s.name}</span>
                <span className="text-xs text-gray-400">
                  {s.type ?? 'org'}{s.exact ? ' · same name'
                    : s.via === 'job_name' ? ` · ${s.job_count} job${s.job_count === 1 ? '' : 's'} named after the band`
                    : s.similarity != null ? ` · ${(s.similarity * 100).toFixed(0)}% similar` : ''}
                </span>
                <a href={`/organisations/${s.id}`} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()}
                  className="ml-auto text-xs text-blue-600 hover:underline">open ↗</a>
              </label>
            ))}
            <label className={`flex items-center gap-2 rounded-lg border px-3 py-2 cursor-pointer ${choice === 'new' ? 'border-[#7B5EA7] bg-purple-50' : 'border-gray-200 hover:bg-gray-50'}`}>
              <input type="radio" name="org-choice" checked={choice === 'new'} onChange={() => setChoice('new')} />
              <span className="text-gray-900 whitespace-nowrap">Create a new band:</span>
              <input value={name} onChange={(e) => { setName(e.target.value); setChoice('new'); }} maxLength={300}
                className="flex-1 min-w-0 rounded border border-gray-300 px-2 py-1 text-sm" />
            </label>
          </div>

          <div className="text-xs font-semibold uppercase text-gray-400 mt-5 mb-2">Contacts from the research</div>
          {preview.contacts.length === 0 ? (
            <p className="text-gray-400">No contacts were found for this act.</p>
          ) : (
            <ul className="space-y-1.5">
              {preview.contacts.map((c) => (
                <li key={c.idx}>
                  <label className={`flex items-start gap-2 ${c.can_add ? 'cursor-pointer' : 'opacity-60'}`}>
                    <input type="checkbox" className="mt-0.5" disabled={!c.can_add} checked={picked.has(c.idx)} onChange={() => toggle(c.idx)} />
                    <span>
                      <span className="font-medium text-gray-900">{c.contact_name || c.contact_email || c.contact_type}</span>
                      <span className="text-gray-400"> · {c.role}</span>
                      {c.contact_email && <span className="text-gray-500"> · {c.contact_email}</span>}
                      <span className={`ml-1 text-[10px] px-1 rounded ${c.confidence === 'high' ? 'bg-green-100 text-green-700' : c.confidence === 'medium' ? 'bg-amber-100 text-amber-700' : 'bg-gray-100 text-gray-500'}`}>{c.confidence}</span>
                      {c.existing_person && <span className="block text-xs text-green-700">Already in the address book as {c.existing_person.name} — will be linked, not duplicated.</span>}
                      {!c.can_add && <span className="block text-xs text-gray-400">No email address — can’t be added safely (we match people by email).</span>}
                    </span>
                  </label>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
      {error && <div className="mt-3 rounded-lg bg-red-50 text-red-800 px-3 py-2">{error}</div>}
    </LeadModal>
  );
}
