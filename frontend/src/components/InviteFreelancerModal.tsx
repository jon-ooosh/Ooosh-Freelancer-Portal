/**
 * InviteFreelancerModal — staff-side "invite to freelance" flow.
 *
 * Two modes:
 *   - existing person: pass `personId` (+ optional name for the heading). One
 *     click flags them a freelancer, opens an application + mints the link.
 *   - brand-new: omit `personId` → collects name + email, creates a shell
 *     person + application in one step.
 *
 * On success it shows the tokenised form link (copy button) + whether the
 * intro email went out, so staff can paste it into WhatsApp themselves too.
 */
import { useState } from 'react';
import { api } from '../services/api';

interface InviteResult {
  person_id: string;
  form_url: string;
  email_result: { success: boolean; skipped?: boolean; error?: string };
}

export default function InviteFreelancerModal({
  personId,
  personName,
  onClose,
  onInvited,
}: {
  personId?: string;
  personName?: string;
  onClose: () => void;
  onInvited?: (personId: string) => void;
}) {
  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [email, setEmail] = useState('');
  const [sendEmail, setSendEmail] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState<InviteResult | null>(null);
  const [copied, setCopied] = useState(false);

  const isNew = !personId;

  async function submit() {
    setError('');
    if (isNew && (!firstName.trim() || !lastName.trim())) {
      setError('Please enter a first and last name.');
      return;
    }
    if (isNew && email.trim() && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email.trim())) {
      setError('Please enter a valid email.');
      return;
    }
    setSubmitting(true);
    try {
      const body = personId
        ? { person_id: personId, send_email: sendEmail }
        : { first_name: firstName.trim(), last_name: lastName.trim(), email: email.trim() || undefined, send_email: sendEmail };
      const r = await api.post<InviteResult>('/freelancers/invite', body);
      setResult(r);
      onInvited?.(r.person_id);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not send the invite.');
    } finally {
      setSubmitting(false);
    }
  }

  function copyLink() {
    if (!result) return;
    navigator.clipboard?.writeText(result.form_url).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={onClose}>
      <div className="bg-white rounded-xl shadow-lg max-w-md w-full p-6" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-start justify-between mb-4">
          <h2 className="text-lg font-bold text-slate-800">
            {isNew ? 'Invite a new freelancer' : `Invite ${personName || 'this person'} to freelance`}
          </h2>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-600 text-xl leading-none">×</button>
        </div>

        {!result ? (
          <>
            {isNew ? (
              <div className="space-y-2 mb-3">
                <div className="grid grid-cols-2 gap-2">
                  <input placeholder="First name" value={firstName} onChange={(e) => setFirstName(e.target.value)} className="border border-slate-300 rounded px-2 py-1.5 text-sm" />
                  <input placeholder="Last name" value={lastName} onChange={(e) => setLastName(e.target.value)} className="border border-slate-300 rounded px-2 py-1.5 text-sm" />
                </div>
                <input placeholder="Email (optional but recommended)" value={email} onChange={(e) => setEmail(e.target.value)} className="border border-slate-300 rounded px-2 py-1.5 text-sm w-full" />
              </div>
            ) : (
              <p className="text-sm text-slate-600 mb-3">
                This flags them as a freelancer, opens a sign-up application, and generates their form link.
              </p>
            )}

            <label className="flex items-center gap-2 text-sm text-slate-700 mb-4">
              <input type="checkbox" checked={sendEmail} onChange={(e) => setSendEmail(e.target.checked)} />
              Email them the sign-up link now
            </label>

            {error && <p className="text-sm text-red-600 mb-3">{error}</p>}
            <div className="flex justify-end gap-2">
              <button onClick={onClose} className="px-3 py-1.5 text-sm border border-slate-300 rounded hover:bg-slate-50">Cancel</button>
              <button onClick={submit} disabled={submitting} className="px-4 py-1.5 text-sm bg-purple-600 text-white rounded font-medium disabled:opacity-50">
                {submitting ? 'Sending…' : 'Send invite'}
              </button>
            </div>
          </>
        ) : (
          <div className="space-y-3">
            <p className="text-sm text-green-700">✓ Invitation created.</p>
            <div>
              <p className="text-xs font-medium text-slate-500 mb-1">Sign-up link</p>
              <div className="flex items-center gap-2">
                <input readOnly value={result.form_url} className="border border-slate-300 rounded px-2 py-1.5 text-xs flex-1 bg-slate-50" onFocus={(e) => e.target.select()} />
                <button onClick={copyLink} className="px-2 py-1.5 text-xs border border-slate-300 rounded hover:bg-slate-50 shrink-0">{copied ? 'Copied' : 'Copy'}</button>
              </div>
            </div>
            <p className="text-sm text-slate-600">
              {result.email_result.success
                ? '📧 Intro email sent.'
                : result.email_result.skipped
                  ? `Email not sent — ${result.email_result.error || 'no email on file.'} Copy the link and send it yourself.`
                  : `Email failed — ${result.email_result.error || 'send it manually via the link above.'}`}
            </p>
            <div className="flex justify-end">
              <button onClick={onClose} className="px-4 py-1.5 text-sm bg-slate-700 text-white rounded font-medium">Done</button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
