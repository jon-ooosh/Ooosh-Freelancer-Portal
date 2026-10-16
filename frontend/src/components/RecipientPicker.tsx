/**
 * RecipientPicker — tick contacts on the job and/or type a one-off address.
 *
 * The same picker as ResendConfirmationModal (contacts from
 * /hire-forms/email-contacts/:jobId), lifted out as a controlled piece so the card
 * reader's "Send receipt?" step and the refund modal can share it. The caller owns
 * the list it sends; this reports every change through `onChange`.
 *
 * `preselect`: emails to tick on load — the caller passes whoever the email would go
 * to by itself. Any of them not among the job's contacts is added as a typed address,
 * so nothing pre-chosen is silently dropped. With no `preselect`, the first reachable
 * contact is ticked (the Resend confirmation behaviour).
 */
import { useEffect, useState } from 'react';
import { api } from '../services/api';

export interface PickedRecipient { email: string; name: string }

interface ContactOption { email: string; name: string; source: string }

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

interface Props {
  jobId: string;
  preselect?: string[] | null;
  onChange: (recipients: PickedRecipient[]) => void;
  disabled?: boolean;
}

export default function RecipientPicker({ jobId, preselect, onChange, disabled }: Props) {
  const [contacts, setContacts] = useState<ContactOption[]>([]);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [extras, setExtras] = useState<string[]>([]);
  const [typed, setTyped] = useState('');
  const [error, setError] = useState('');

  // Load once the caller knows what to pre-tick (undefined = still asking).
  useEffect(() => {
    if (preselect === undefined) return;
    let cancelled = false;
    setLoading(true);
    api.get<{ contacts: ContactOption[] }>(`/hire-forms/email-contacts/${jobId}`)
      .then((res) => {
        if (cancelled) return;
        const list = (res.contacts || []).filter((c) => c.email && c.email.trim());
        setContacts(list);
        const lower = (e: string) => e.trim().toLowerCase();
        if (preselect && preselect.length > 0) {
          const inList = new Set(list.map((c) => lower(c.email)));
          setSelected(new Set(list.filter((c) => preselect.some((p) => lower(p) === lower(c.email))).map((c) => c.email)));
          setExtras(preselect.filter((p) => !inList.has(lower(p))));
        } else if (list[0]) {
          setSelected(new Set([list[0].email]));
        }
      })
      .catch(() => { if (!cancelled) setContacts([]); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [jobId, preselect]);

  useEffect(() => {
    const picked = contacts
      .filter((c) => selected.has(c.email))
      .map((c) => ({ email: c.email, name: c.name && c.name !== 'Client' ? c.name : '' }));
    onChange([...picked, ...extras.map((email) => ({ email, name: '' }))]);
  }, [contacts, selected, extras]); // eslint-disable-line react-hooks/exhaustive-deps

  function toggle(email: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(email)) next.delete(email); else next.add(email);
      return next;
    });
  }

  function addTyped() {
    const t = typed.trim();
    if (!t) return;
    if (!EMAIL_REGEX.test(t)) { setError('Not a valid email address.'); return; }
    if (extras.includes(t) || contacts.some((c) => c.email.toLowerCase() === t.toLowerCase())) {
      setError('That email is already on the list.');
      return;
    }
    setExtras((prev) => [...prev, t]);
    setTyped('');
    setError('');
  }

  if (loading) return <p className="text-xs text-gray-500">Loading contacts...</p>;

  return (
    <div className="space-y-2">
      {contacts.length > 0 ? (
        <div className="space-y-1 max-h-40 overflow-y-auto border border-gray-200 rounded-md p-1.5">
          {contacts.map((c) => (
            <label key={c.email} className="flex items-start gap-2 px-2 py-1 hover:bg-gray-50 rounded cursor-pointer">
              <input type="checkbox" checked={selected.has(c.email)} disabled={disabled} onChange={() => toggle(c.email)}
                className="mt-0.5 w-4 h-4 rounded border-gray-300" />
              <span className="text-sm text-gray-800 min-w-0 break-all">
                {c.name && c.name !== 'Client' ? `${c.name} ` : ''}<span className="text-gray-500">&lt;{c.email}&gt;</span>
              </span>
            </label>
          ))}
        </div>
      ) : (
        <p className="text-xs text-gray-500 italic">No contacts with an email on this job. Add one below.</p>
      )}
      {extras.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {extras.map((e) => (
            <span key={e} className="inline-flex items-center gap-1 px-2 py-0.5 bg-blue-50 border border-blue-200 rounded text-xs text-blue-700">
              {e}
              <button type="button" disabled={disabled} onClick={() => setExtras((prev) => prev.filter((x) => x !== e))}
                className="text-blue-500 hover:text-blue-700" aria-label={`Remove ${e}`}>×</button>
            </span>
          ))}
        </div>
      )}
      <div className="flex gap-2">
        <input type="email" value={typed} disabled={disabled} placeholder="Add another email"
          onChange={(e) => { setTyped(e.target.value); setError(''); }}
          onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addTyped(); } }}
          className="flex-1 min-w-0 px-3 py-1.5 text-sm border border-gray-300 rounded-md" />
        <button type="button" onClick={addTyped} disabled={disabled || !typed.trim()}
          className="px-3 py-1.5 text-sm text-ooosh-700 border border-ooosh-200 rounded-md hover:bg-ooosh-50 disabled:opacity-40">
          Add
        </button>
      </div>
      {error && <p className="text-xs text-red-600">{error}</p>}
    </div>
  );
}
