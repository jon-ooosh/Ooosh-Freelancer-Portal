/**
 * "Send merch form" — emails the public inbound merch-delivery form link to
 * chosen client contacts (client-picker controlled, never a blast). Reuses the
 * same contact picker as the hire form. Sits on the Job Detail Overview.
 */
import { useState } from 'react';
import { api } from '../services/api';

interface EmailContact { email: string; name: string; source: string }

export default function SendMerchFormButton({ jobId, hhJobNumber }: { jobId: string; hhJobNumber: number }) {
  const [open, setOpen] = useState(false);
  const [contacts, setContacts] = useState<EmailContact[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [custom, setCustom] = useState('');
  const [message, setMessage] = useState('');
  const [loading, setLoading] = useState(false);
  const [sending, setSending] = useState(false);
  const [result, setResult] = useState('');

  async function openPicker() {
    setOpen(true); setResult(''); setLoading(true);
    try {
      const data = await api.get<{ contacts: EmailContact[] }>(`/hire-forms/email-contacts/${jobId}`);
      setContacts(data.contacts || []);
      setSelected(new Set((data.contacts || []).map((c) => c.email)));
    } catch { setContacts([]); } finally { setLoading(false); }
  }

  function toggle(email: string) {
    setSelected((cur) => { const n = new Set(cur); n.has(email) ? n.delete(email) : n.add(email); return n; });
  }

  async function send() {
    const recipients = contacts.filter((c) => selected.has(c.email)).map((c) => ({ email: c.email, name: c.name }));
    if (custom.trim()) recipients.push({ email: custom.trim(), name: '' });
    if (recipients.length === 0) { setResult('Pick at least one recipient.'); return; }
    setSending(true); setResult('');
    try {
      const r = await api.post<{ sent: number; failed: number }>('/holding/send-merch-form', {
        hh_job_number: hhJobNumber, recipients, message: message || null,
      });
      setResult(`✓ Sent to ${r.sent} recipient${r.sent !== 1 ? 's' : ''}${r.failed ? ` (${r.failed} failed)` : ''}.`);
      setTimeout(() => setOpen(false), 1600);
    } catch (e) { setResult(e instanceof Error ? e.message : 'Send failed'); } finally { setSending(false); }
  }

  return (
    <>
      <button onClick={openPicker} className="text-xs text-[#7B5EA7] font-medium hover:underline">📨 Send merch delivery form</button>

      {open && (
        <div className="fixed inset-0 z-40 bg-black/40 flex items-start justify-center p-4 overflow-y-auto" onClick={() => setOpen(false)}>
          <div className="bg-white rounded-xl shadow-xl w-full max-w-md my-8" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between px-5 py-4 border-b">
              <h3 className="font-semibold text-slate-800">Send merch delivery form</h3>
              <button onClick={() => setOpen(false)} className="text-slate-400 text-xl leading-none">×</button>
            </div>
            <div className="p-5 space-y-3">
              <p className="text-xs text-slate-500">Emails the client a link to tell us what they're sending. They'll get printable labels back.</p>
              {loading ? <p className="text-slate-400 text-sm">Loading contacts…</p> : (
                <>
                  <div className="space-y-1 max-h-48 overflow-y-auto border border-slate-200 rounded-lg p-2">
                    {contacts.length === 0 && <p className="text-slate-400 text-xs">No saved contacts — add one below.</p>}
                    {contacts.map((c) => (
                      <label key={c.email} className="flex items-center gap-2 text-sm py-1">
                        <input type="checkbox" checked={selected.has(c.email)} onChange={() => toggle(c.email)} />
                        <span className="flex-1">{c.name || c.email} <span className="text-xs text-slate-400">{c.name ? `· ${c.email}` : ''} · {c.source}</span></span>
                      </label>
                    ))}
                  </div>
                  <input className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm" value={custom} onChange={(e) => setCustom(e.target.value)} placeholder="Add another email…" />
                  <textarea className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm" rows={2} value={message} onChange={(e) => setMessage(e.target.value)} placeholder="Optional note to include…" />
                </>
              )}
              {result && <p className={`text-sm ${result.startsWith('✓') ? 'text-green-600' : 'text-red-600'}`}>{result}</p>}
              <div className="flex justify-end gap-2">
                <button onClick={() => setOpen(false)} className="px-4 py-2 text-sm text-slate-600">Cancel</button>
                <button onClick={send} disabled={sending} className="px-4 py-2 text-sm bg-[#7B5EA7] text-white rounded-lg disabled:opacity-50">{sending ? 'Sending…' : 'Send'}</button>
              </div>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
