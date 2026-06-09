/**
 * Notify-client modal for held items. Loads candidate recipients (linked job
 * contacts + owner org/person emails + any contact on the record), lets staff
 * tick who to send to, add a new email, add a short message, or skip. For lost
 * property the backend attaches the item photos and uses the "we found lost
 * property" template; for incoming it's the "your items arrived" template.
 *
 * Shared by the desktop detail modal and the mobile quick-log post-save step so
 * both surfaces offer the identical notify flow.
 */
import { useEffect, useState } from 'react';
import { api } from '../../services/api';
import type { HeldItem } from '../../../../shared/types';

interface Candidate { email: string; name: string; source: string }

const SOURCE_LABEL: Record<string, string> = {
  record_contact: 'On this item',
  owner_person: 'Owner',
  owner_org: 'Client org',
  job_contact_primary: 'Job contact (primary)',
  job_contact: 'Job contact',
  client_person: 'Client contact',
  client_org: 'Client org',
  client_name_match: 'Name match',
};

export function NotifyClientModal({ item, onClose, onSent }: {
  item: HeldItem;
  onClose: () => void;
  onSent: (sentCount: number) => void;
}) {
  const isLost = item.kind === 'lost_property';
  const [candidates, setCandidates] = useState<Candidate[]>([]);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [newEmail, setNewEmail] = useState('');
  const [extra, setExtra] = useState<string[]>([]);
  const [message, setMessage] = useState('');
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [err, setErr] = useState('');

  useEffect(() => {
    api.get<{ data: Candidate[] }>(`/holding/${item.id}/notify-contacts`)
      .then((r) => {
        setCandidates(r.data);
        // Pre-tick the most likely recipient (first candidate) so the common
        // case is one tap → Send.
        if (r.data[0]) setPicked(new Set([r.data[0].email.toLowerCase()]));
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [item.id]);

  function toggle(email: string) {
    setPicked((cur) => {
      const next = new Set(cur);
      const k = email.toLowerCase();
      if (next.has(k)) next.delete(k); else next.add(k);
      return next;
    });
  }

  function addEmail() {
    const e = newEmail.trim();
    if (!e || !e.includes('@')) { setErr('Enter a valid email'); return; }
    if (!extra.includes(e) && !candidates.some((c) => c.email.toLowerCase() === e.toLowerCase())) {
      setExtra((x) => [...x, e]);
    }
    setPicked((cur) => new Set(cur).add(e.toLowerCase()));
    setNewEmail(''); setErr('');
  }

  const allOptions = [...candidates, ...extra.map((e) => ({ email: e, name: '', source: 'manual' }))];
  const recipients = allOptions.filter((c) => picked.has(c.email.toLowerCase()));

  async function send() {
    setSending(true); setErr('');
    try {
      const r = await api.post<{ sent: number; failed: number }>(`/holding/${item.id}/notify`, {
        recipients: recipients.map((c) => ({ email: c.email, name: c.name || undefined })),
        message: message.trim() || undefined,
      });
      onSent(r.sent ?? recipients.length);
    } catch (e) { setErr(e instanceof Error ? e.message : 'Send failed'); setSending(false); }
  }

  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex items-start justify-center p-4 overflow-y-auto" onClick={onClose}>
      <div className="bg-white rounded-xl shadow-xl w-full max-w-lg my-8" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between px-5 py-4 border-b">
          <h3 className="font-semibold text-slate-800">{isLost ? '🔍 Notify client — lost property' : '✉ Notify client — items arrived'}</h3>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-600 text-xl leading-none">×</button>
        </div>
        <div className="p-5 space-y-4">
          <p className="text-sm text-slate-500">
            {isLost
              ? 'Lets the client know we found their property (the photo[s] are attached). Pick who to send to.'
              : 'Lets the client know their items have arrived. Pick who to send to.'}
          </p>

          <div>
            <label className="block text-xs font-medium text-slate-500 mb-1">Send to</label>
            {loading && <p className="text-slate-400 text-sm py-2">Loading contacts…</p>}
            {!loading && allOptions.length === 0 && (
              <p className="text-slate-400 text-sm py-1">No contacts on file — add an email below.</p>
            )}
            <div className="space-y-1.5">
              {allOptions.map((c) => (
                <label key={c.email} className="flex items-center gap-2 text-sm border border-slate-200 rounded-lg px-3 py-2 cursor-pointer hover:bg-slate-50">
                  <input type="checkbox" className="w-4 h-4" checked={picked.has(c.email.toLowerCase())} onChange={() => toggle(c.email)} />
                  <span className="flex-1">
                    {c.name ? <span className="font-medium text-slate-700">{c.name} </span> : null}
                    <span className="text-slate-500">{c.email}</span>
                  </span>
                  {c.source !== 'manual' && <span className="text-[10px] text-slate-400">{SOURCE_LABEL[c.source] || c.source}</span>}
                </label>
              ))}
            </div>
          </div>

          <div className="flex items-center gap-2">
            <input value={newEmail} onChange={(e) => setNewEmail(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && addEmail()}
              placeholder="Add another email…" className="flex-1 border border-slate-300 rounded-lg px-3 py-2 text-sm" />
            <button onClick={addEmail} className="px-3 py-2 text-sm bg-slate-100 text-slate-700 rounded-lg">Add</button>
          </div>

          <div>
            <label className="block text-xs font-medium text-slate-500 mb-1">Add a note (optional)</label>
            <textarea value={message} onChange={(e) => setMessage(e.target.value)} rows={2}
              className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm" placeholder="Anything to add to the email…" />
          </div>

          {err && <p className="text-red-600 text-sm">{err}</p>}

          <div className="flex justify-end gap-2 pt-1">
            <button onClick={onClose} className="px-4 py-2 text-sm text-slate-600">Don't send</button>
            <button onClick={send} disabled={sending || recipients.length === 0}
              className="px-4 py-2 text-sm bg-[#7B5EA7] text-white rounded-lg disabled:opacity-50">
              {sending ? 'Sending…' : `Send to ${recipients.length || 0}`}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
