/**
 * ResendConfirmationModal — pick who gets the booking/payment confirmation email.
 *
 * Mirrors the hire-form send-link / FileEmailModal picker: tick contacts already
 * on the job, or type a one-off address (e.g. an accountant chasing a payment).
 * Posts to POST /money/:jobId/resend-confirmation with an explicit `recipients`
 * override — the backend uses the first as `to`, the rest as CC.
 */
import { useEffect, useMemo, useState } from 'react';
import { api } from '../services/api';

interface ContactOption {
  email: string;
  name: string;
  source: string;
}

interface ResendConfirmationModalProps {
  jobId: string;
  /** Deposit figure shown in the email. Passed straight through. */
  amount: number;
  onClose: () => void;
  /** Fired after a send attempt with a ready-to-render result banner. */
  onResult: (result: { ok: boolean; text: string }) => void;
}

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export default function ResendConfirmationModal({
  jobId,
  amount,
  onClose,
  onResult,
}: ResendConfirmationModalProps) {
  const [contacts, setContacts] = useState<ContactOption[]>([]);
  const [loadingContacts, setLoadingContacts] = useState(false);
  const [selectedEmails, setSelectedEmails] = useState<Set<string>>(new Set());
  const [extraEmail, setExtraEmail] = useState('');
  const [extraEmails, setExtraEmails] = useState<string[]>([]);
  const [externalAck, setExternalAck] = useState(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;
    setLoadingContacts(true);
    api.get<{ contacts: ContactOption[] }>(`/hire-forms/email-contacts/${jobId}`)
      .then(res => {
        if (cancelled) return;
        const list = res.contacts || [];
        setContacts(list);
        // Pre-tick the first reachable contact so the common one-recipient case
        // is a single click.
        const first = list.find(c => c.email && c.email.trim());
        if (first) setSelectedEmails(new Set([first.email]));
      })
      .catch(err => {
        if (!cancelled) console.error('Load contacts failed:', err);
      })
      .finally(() => {
        if (!cancelled) setLoadingContacts(false);
      });
    return () => { cancelled = true; };
  }, [jobId]);

  function toggleContact(email: string) {
    setSelectedEmails(prev => {
      const next = new Set(prev);
      if (next.has(email)) next.delete(email);
      else next.add(email);
      return next;
    });
  }

  function addExtraEmail() {
    const trimmed = extraEmail.trim();
    if (!trimmed) return;
    if (!EMAIL_REGEX.test(trimmed)) {
      setError('Not a valid email address.');
      return;
    }
    if (extraEmails.includes(trimmed) || selectedEmails.has(trimmed)) {
      setError('That email is already on the recipient list.');
      return;
    }
    setExtraEmails(prev => [...prev, trimmed]);
    setExtraEmail('');
    setError('');
  }

  function removeExtraEmail(email: string) {
    setExtraEmails(prev => prev.filter(e => e !== email));
  }

  const recipients = useMemo(() => {
    const fromContacts = contacts
      .filter(c => selectedEmails.has(c.email))
      .map(c => ({ email: c.email, name: c.name && c.name !== 'Client' ? c.name : '' }));
    const fromExtras = extraEmails.map(email => ({ email, name: '' }));
    return [...fromContacts, ...fromExtras];
  }, [contacts, selectedEmails, extraEmails]);

  const canSend = recipients.length > 0 && externalAck && !sending;

  async function handleSend() {
    if (!canSend) return;
    setSending(true);
    setError('');
    try {
      const resp = await api.post<{
        data: { sent: boolean; reason?: string; error?: string; is_fallback?: boolean };
      }>(`/money/${jobId}/resend-confirmation`, {
        amount,
        is_confirming_booking: true,
        recipients,
      });
      const r = resp.data;
      if (r.sent) {
        const to = recipients[0].email;
        const extra = recipients.length > 1 ? ` (+${recipients.length - 1} CC'd)` : '';
        onResult({ ok: true, text: `Confirmation email sent to ${to}${extra}.` });
        onClose();
      } else {
        setError(
          r.reason === 'no_recipient'
            ? 'Not sent — no valid recipient. Pick a contact or add an email.'
            : `Not sent — ${r.error || 'email send failed'}. Try again in a moment.`
        );
      }
    } catch (err) {
      console.error('Resend confirmation error:', err);
      setError(err instanceof Error ? err.message : 'Send failed');
    } finally {
      setSending(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" onClick={onClose}>
      <div
        className="bg-white rounded-xl shadow-2xl w-full max-w-2xl max-h-[90vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-6 py-4 border-b border-gray-200 flex items-center justify-between">
          <div>
            <h2 className="text-lg font-bold text-gray-800">Resend confirmation</h2>
            <p className="text-xs text-gray-500 mt-0.5">
              Send the booking/payment confirmation to people on this job, or a one-off address.
            </p>
          </div>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600">
            <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        <div className="p-6 space-y-5">
          {/* Contacts picker */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">
              Contacts on this job
            </label>
            {loadingContacts ? (
              <p className="text-xs text-gray-400 py-2">Loading contacts…</p>
            ) : contacts.length === 0 ? (
              <p className="text-xs text-gray-400 py-2 italic">No contacts on file. Add an email below.</p>
            ) : (
              <div className="space-y-1.5 max-h-48 overflow-y-auto border border-gray-200 rounded-lg p-2">
                {contacts.map(c => (
                  <label key={c.email} className="flex items-start gap-2 px-2 py-1.5 hover:bg-gray-50 rounded cursor-pointer">
                    <input
                      type="checkbox"
                      checked={selectedEmails.has(c.email)}
                      onChange={() => toggleContact(c.email)}
                      className="mt-0.5 w-4 h-4 rounded border-gray-300 text-ooosh-600 focus:ring-ooosh-500"
                    />
                    <div className="flex-1 min-w-0">
                      <p className="text-sm text-gray-800 truncate">
                        {c.name && c.name !== 'Client' ? `${c.name} ` : ''}
                        <span className="text-gray-500">&lt;{c.email}&gt;</span>
                      </p>
                      <p className="text-xs text-gray-400">{c.source}</p>
                    </div>
                  </label>
                ))}
              </div>
            )}
          </div>

          {/* Free-text "add another email" */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">
              Add another email
            </label>
            <div className="flex gap-2">
              <input
                type="email"
                value={extraEmail}
                onChange={(e) => { setExtraEmail(e.target.value); setError(''); }}
                onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addExtraEmail(); } }}
                placeholder="name@example.com"
                className="flex-1 px-3 py-2 text-sm border border-gray-300 rounded-lg focus:border-ooosh-500 focus:outline-none focus:ring-1 focus:ring-ooosh-500"
              />
              <button
                onClick={addExtraEmail}
                disabled={!extraEmail.trim()}
                className="px-3 py-2 text-sm font-medium text-ooosh-700 border border-ooosh-200 rounded-lg hover:bg-ooosh-50 disabled:opacity-40 disabled:cursor-not-allowed"
              >
                Add
              </button>
            </div>
            {extraEmails.length > 0 && (
              <div className="mt-2 flex flex-wrap gap-1.5">
                {extraEmails.map(email => (
                  <span key={email} className="inline-flex items-center gap-1.5 px-2 py-1 bg-blue-50 border border-blue-200 rounded text-xs text-blue-700">
                    {email}
                    <button onClick={() => removeExtraEmail(email)} className="text-blue-500 hover:text-blue-700">
                      <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M6 18L18 6M6 6l12 12" />
                      </svg>
                    </button>
                  </span>
                ))}
              </div>
            )}
          </div>

          {/* External-share sanity check */}
          {recipients.length > 0 && (
            <label className="flex items-start gap-2 p-3 bg-amber-50 border border-amber-200 rounded-lg cursor-pointer">
              <input
                type="checkbox"
                checked={externalAck}
                onChange={(e) => setExternalAck(e.target.checked)}
                className="mt-0.5 w-4 h-4 rounded border-amber-300 text-amber-600 focus:ring-amber-500"
              />
              <div className="text-sm text-amber-900">
                <p className="font-medium">I'm sending this to the recipient(s) above.</p>
                <p className="text-xs text-amber-700 mt-0.5">Sanity check before the email goes out. Tick to enable Send.</p>
              </div>
            </label>
          )}

          {error && (
            <div className="bg-red-50 border border-red-200 rounded-lg p-3 text-sm text-red-700">{error}</div>
          )}
        </div>

        <div className="px-6 py-4 border-t border-gray-200 flex items-center justify-between">
          <p className="text-xs text-gray-500">
            {recipients.length > 0
              ? `Sending to ${recipients.length} recipient${recipients.length === 1 ? '' : 's'}`
              : 'No recipients selected'}
          </p>
          <div className="flex gap-2">
            <button onClick={onClose} className="px-4 py-2 text-sm text-gray-700 hover:bg-gray-100 rounded-lg">
              Cancel
            </button>
            <button
              onClick={handleSend}
              disabled={!canSend}
              className="px-4 py-2 text-sm font-medium bg-ooosh-600 text-white rounded-lg hover:bg-ooosh-700 disabled:opacity-40 disabled:cursor-not-allowed"
            >
              {sending ? 'Sending…' : 'Send'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
