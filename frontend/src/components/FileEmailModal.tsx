/**
 * FileEmailModal — resend a stored file as an email attachment.
 *
 * Used from the Files tab on Job Detail (and reusable from
 * Person/Org/Venue detail pages later). Loads the existing job-contact
 * picker if entityType is 'jobs', plus a free-text "add another email"
 * field. Includes an explicit "I'm sending externally" sanity tick the
 * user has to acknowledge before the Send button enables, so we don't
 * accidentally fire client docs out the door.
 */
import { useEffect, useMemo, useState } from 'react';
import { api } from '../services/api';

interface ContactOption {
  email: string;
  name: string;
  source: string;
}

interface FileEmailModalProps {
  file: {
    name: string;
    url: string;
    label?: string;
    comment?: string;
  };
  entityType: 'jobs' | 'people' | 'organisations' | 'venues' | 'drivers';
  entityId: string;
  /** Optional human label of where this is being sent from — surfaces in the modal heading */
  contextLabel?: string;
  onClose: () => void;
  onSent?: (sent: number) => void;
}

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export default function FileEmailModal({
  file,
  entityType,
  entityId,
  contextLabel,
  onClose,
  onSent,
}: FileEmailModalProps) {
  const [contacts, setContacts] = useState<ContactOption[]>([]);
  const [loadingContacts, setLoadingContacts] = useState(false);
  const [selectedEmails, setSelectedEmails] = useState<Set<string>>(new Set());
  const [extraEmail, setExtraEmail] = useState('');
  const [extraEmails, setExtraEmails] = useState<string[]>([]);
  const [message, setMessage] = useState('');
  const [externalAck, setExternalAck] = useState(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState('');

  // Pull job contacts via the existing hire-forms helper (it returns the
  // same shape we want — client org email, linked people, band/promoter
  // contacts, HH contact-name match).
  useEffect(() => {
    if (entityType !== 'jobs') return;
    let cancelled = false;
    setLoadingContacts(true);
    api.get<{ contacts: ContactOption[] }>(`/hire-forms/email-contacts/${entityId}`)
      .then(res => {
        if (cancelled) return;
        setContacts(res.contacts || []);
      })
      .catch(err => {
        if (cancelled) return;
        console.error('Load contacts failed:', err);
      })
      .finally(() => {
        if (!cancelled) setLoadingContacts(false);
      });
    return () => { cancelled = true; };
  }, [entityType, entityId]);

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
      .map(c => ({ email: c.email, name: c.name }));
    const fromExtras = extraEmails.map(email => ({ email, name: '' }));
    return [...fromContacts, ...fromExtras];
  }, [contacts, selectedEmails, extraEmails]);

  const allSelectedExternal = useMemo(() => {
    // Treat any address that isn't @oooshtours.co.uk as "external" for the
    // sanity check. If everyone's internal we still ask — explicit confirm
    // is one extra click but never wrong.
    return recipients.length > 0;
  }, [recipients]);

  const canSend = recipients.length > 0 && externalAck && !sending;

  async function handleSend() {
    if (!canSend) return;
    setSending(true);
    setError('');
    try {
      const payload = {
        entity_type: entityType,
        entity_id: entityId,
        file_url: file.url,
        recipients,
        message: message.trim() || undefined,
        external_share_acknowledged: true,
      };
      const result = await api.post<{
        success: boolean;
        sent: number;
        failed: number;
        results: Array<{ email: string; success: boolean; error?: string }>;
      }>('/files/email', payload);
      if (!result.success) {
        const failedList = (result.results || [])
          .filter(r => !r.success)
          .map(r => `${r.email}${r.error ? ` (${r.error})` : ''}`)
          .join(', ');
        setError(`Some sends failed: ${failedList}`);
        if (result.sent > 0) onSent?.(result.sent);
        return;
      }
      onSent?.(result.sent);
      onClose();
    } catch (err) {
      console.error('Send file email error:', err);
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
            <h2 className="text-lg font-bold text-gray-800">Email file</h2>
            <p className="text-xs text-gray-500 mt-0.5">{contextLabel || 'Send this file to one or more people'}</p>
          </div>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600">
            <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        <div className="p-6 space-y-5">
          {/* File info */}
          <div className="bg-gray-50 rounded-lg p-3 border border-gray-200">
            <p className="text-xs text-gray-500 mb-0.5">Sending</p>
            <p className="text-sm font-medium text-gray-800 truncate">{file.name}</p>
            {file.label && <p className="text-xs text-gray-500 mt-0.5">Tag: {file.label}</p>}
          </div>

          {/* Contacts picker (jobs only) */}
          {entityType === 'jobs' && (
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">
                Recipients on this job
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
          )}

          {/* Free-text "add another email" */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">
              {entityType === 'jobs' ? 'Add another email' : 'Send to'}
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

          {/* Optional message */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">
              Message <span className="text-gray-400 text-xs font-normal">(optional)</span>
            </label>
            <textarea
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              rows={3}
              maxLength={2000}
              placeholder="Leave blank for the default 'Please find attached…' line."
              className="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg focus:border-ooosh-500 focus:outline-none focus:ring-1 focus:ring-ooosh-500 resize-none"
            />
          </div>

          {/* External-share sanity check */}
          {allSelectedExternal && (
            <label className="flex items-start gap-2 p-3 bg-amber-50 border border-amber-200 rounded-lg cursor-pointer">
              <input
                type="checkbox"
                checked={externalAck}
                onChange={(e) => setExternalAck(e.target.checked)}
                className="mt-0.5 w-4 h-4 rounded border-amber-300 text-amber-600 focus:ring-amber-500"
              />
              <div className="text-sm text-amber-900">
                <p className="font-medium">I'm sending this to a third party.</p>
                <p className="text-xs text-amber-700 mt-0.5">Sanity check before the file leaves the building. Tick to enable Send.</p>
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
