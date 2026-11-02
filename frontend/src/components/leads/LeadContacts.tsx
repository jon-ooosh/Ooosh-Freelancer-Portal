/**
 * The contacts panel in an expanded lead row:
 *   - the band's own links (official site, socials — from Ticketmaster /
 *     MusicBrainz) to click through when digging by hand;
 *   - researched + hand-added contacts, each removable;
 *   - "+ Add contact" (kept through any later re-research);
 *   - "Research again" — background contact research for just this lead.
 */
import { useState } from 'react';
import { api } from '../../services/api';
import type { Lead } from './leadTypes';

const LINK_LABEL: Record<string, string> = {
  homepage: 'Website', linktree: 'Linktree', instagram: 'Instagram', facebook: 'Facebook', bandcamp: 'Bandcamp',
  twitter: 'X / Twitter', tiktok: 'TikTok', youtube: 'YouTube', spotify: 'Spotify', musicbrainz: 'MusicBrainz',
};
const LINK_ORDER = ['homepage', 'linktree', 'instagram', 'facebook', 'bandcamp', 'twitter', 'tiktok', 'youtube', 'spotify', 'musicbrainz'];

const TYPE_LABEL: Record<string, string> = {
  manager: 'Manager', band: 'Band (direct)', tour_manager: 'Tour manager', booking_agent: 'Booking agent', general: 'General',
};

function ago(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
}

export default function LeadContacts({ lead, onChanged }: { lead: Lead; onChanged: () => void }) {
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState({ contact_type: 'manager', contact_name: '', contact_email: '', contact_phone: '', note: '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const links = lead.external_links ?? {};
  const linkKeys = LINK_ORDER.filter((k) => links[k]?.length);
  const researching = lead.research_status === 'running';

  const call = async (fn: () => Promise<unknown>) => {
    setBusy(true); setError(null);
    try { await fn(); onChanged(); return true; }
    catch (e) { setError(e instanceof Error ? e.message : 'Something went wrong'); return false; }
    finally { setBusy(false); }
  };
  const researchAgain = () => call(() => api.post(`/leads/${lead.id}/research`, {}));
  const remove = (idx: number) => call(() => api.delete(`/leads/${lead.id}/contacts/${idx}`));
  const save = async () => {
    const ok = await call(() => api.post(`/leads/${lead.id}/contacts`, {
      contact_type: form.contact_type,
      contact_name: form.contact_name.trim() || null,
      contact_email: form.contact_email.trim() || null,
      contact_phone: form.contact_phone.trim() || null,
      note: form.note.trim() || null,
    }));
    if (ok) { setAdding(false); setForm({ contact_type: 'manager', contact_name: '', contact_email: '', contact_phone: '', note: '' }); }
  };
  const canSave = Boolean(form.contact_name.trim() || form.contact_email.trim() || form.contact_phone.trim());

  return (
    <div className="mb-2">
      {linkKeys.length > 0 && (
        <p className="mb-2">
          <span className="text-gray-400">Band’s links:</span>{' '}
          {linkKeys.map((k, i) => (
            <span key={k}>
              {i > 0 && <span className="text-gray-300"> · </span>}
              <a href={links[k][0]} target="_blank" rel="noreferrer" className="text-blue-600 hover:underline">{LINK_LABEL[k] ?? k}</a>
            </span>
          ))}
        </p>
      )}

      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 mb-1">
        <span className="text-gray-400">Contacts</span>
        {researching ? (
          <span className="text-blue-700"><span className="inline-block animate-pulse">●</span> Researching… (a minute or so)</span>
        ) : (
          <span className="text-gray-400">
            {lead.research_status === 'found' && `researched ${ago(lead.researched_at)}`}
            {lead.research_status === 'none' && `researched ${ago(lead.researched_at)} — nothing found`}
            {lead.research_status === 'failed' && `research failed ${ago(lead.researched_at)}`}
            {!lead.research_status && (lead.contacts?.length ? '' : 'not researched yet')}
          </span>
        )}
        {!researching && (
          <button onClick={researchAgain} disabled={busy} className="text-[#7B5EA7] hover:underline disabled:opacity-50"
            title="Search the web for this band’s management, direct contact and tour manager again">
            ↻ {lead.research_status ? 'Research again' : 'Research now'}
          </button>
        )}
        {!adding && <button onClick={() => setAdding(true)} className="text-[#7B5EA7] hover:underline">+ Add contact</button>}
      </div>

      {lead.contacts?.length > 0 ? (
        <ul className="space-y-1">
          {lead.contacts.map((c, i) => (
            <li key={i} className="flex flex-wrap items-center gap-x-2">
              <span className="font-medium">{c.contact_name || TYPE_LABEL[c.contact_type] || c.contact_type}</span>
              <span className="text-gray-400">({TYPE_LABEL[c.contact_type] ?? c.contact_type})</span>
              {c.contact_email && <a href={`mailto:${c.contact_email}`} className="text-blue-600 hover:underline">{c.contact_email}</a>}
              {c.contact_phone && <span>{c.contact_phone}</span>}
              <span className={`text-[10px] px-1 rounded ${c.confidence === 'high' ? 'bg-green-100 text-green-700' : c.confidence === 'medium' ? 'bg-amber-100 text-amber-700' : 'bg-gray-100 text-gray-500'}`}>{c.confidence}</span>
              {c.source && <span className="text-gray-400">· {c.source}</span>}
              <button onClick={() => remove(i)} disabled={busy} className="text-gray-300 hover:text-red-600" title="Remove this contact" aria-label="Remove contact">×</button>
            </li>
          ))}
        </ul>
      ) : !adding && lead.stream === 'cold' && !researching ? (
        <p className="text-gray-400">No contacts yet{lead.research_status === 'none' ? ' — research found nothing. Found someone yourself? Add them.' : '.'}</p>
      ) : null}

      {adding && (
        <div className="mt-2 rounded-lg border border-gray-200 bg-white p-2.5 space-y-2 max-w-xl">
          <div className="flex flex-wrap gap-2">
            <select value={form.contact_type} onChange={(e) => setForm({ ...form, contact_type: e.target.value })}
              className="rounded border border-gray-300 px-2 py-1 text-xs">
              {Object.entries(TYPE_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </select>
            <input value={form.contact_name} onChange={(e) => setForm({ ...form, contact_name: e.target.value })} placeholder="Name"
              maxLength={200} className="flex-1 min-w-[8rem] rounded border border-gray-300 px-2 py-1 text-xs" />
          </div>
          <div className="flex flex-wrap gap-2">
            <input value={form.contact_email} onChange={(e) => setForm({ ...form, contact_email: e.target.value })} placeholder="Email"
              type="email" maxLength={300} className="flex-1 min-w-[10rem] rounded border border-gray-300 px-2 py-1 text-xs" />
            <input value={form.contact_phone} onChange={(e) => setForm({ ...form, contact_phone: e.target.value })} placeholder="Phone"
              maxLength={50} className="w-36 rounded border border-gray-300 px-2 py-1 text-xs" />
          </div>
          <input value={form.note} onChange={(e) => setForm({ ...form, note: e.target.value })} placeholder="Where you found it (optional)"
            maxLength={300} className="w-full rounded border border-gray-300 px-2 py-1 text-xs" />
          <div className="flex gap-2 justify-end">
            <button onClick={() => { setAdding(false); setError(null); }} className="px-2 py-1 text-xs text-gray-600 hover:text-gray-800">Cancel</button>
            <button onClick={save} disabled={busy || !canSave}
              className="px-3 py-1 rounded bg-[#7B5EA7] text-white text-xs font-medium hover:bg-[#6a4f92] disabled:opacity-50">Add contact</button>
          </div>
        </div>
      )}
      {error && <div className="mt-1 text-red-700">{error}</div>}
    </div>
  );
}
