import { useEffect, useState } from 'react';
import { api } from '../../services/api';
import { ukToday } from '../../lib/ukDate';
import { openR2Key } from '../../lib/openAuthedFile';
import { DocumentThumb } from './DocumentThumb';

/**
 * Accepting a photo ID check by hand (Nov 2026).
 *
 * When iDenfy can't read a document (an old paper licence) nothing fills in the
 * driver's identity, so accepting asks for what it would have read: name, date
 * of birth, licence number, issuer, country, dates, address. Katje / job 16831
 * was accepted with her name still reading as her email address because nothing
 * asked.
 *
 * The check date is asked for, never pre-filled with today: one click must not
 * both accept the ID and start a validity window. A date already on the record
 * (iDenfy's, or one typed earlier) is shown as it is.
 *
 * The server holds the rules (`planIdentityDecision` in
 * backend/src/services/identity-review.ts) — which fields are required, the age
 * limits, who may reverse a rejection. This form only collects and explains.
 */

export type IdentityFieldKey =
  | 'full_name' | 'date_of_birth' | 'nationality'
  | 'licence_number' | 'licence_issued_by' | 'licence_issue_country'
  | 'licence_valid_from' | 'licence_valid_to' | 'licence_address'
  | 'idenfy_check_date';

const FIELDS: Array<{ key: IdentityFieldKey; label: string; type?: 'date'; required?: boolean; hint?: string; wide?: boolean }> = [
  { key: 'full_name', label: 'Full name', required: true, hint: 'As printed on the licence', wide: true },
  { key: 'date_of_birth', label: 'Date of birth', type: 'date', required: true },
  { key: 'nationality', label: 'Nationality' },
  { key: 'licence_number', label: 'Licence number', required: true },
  { key: 'licence_issued_by', label: 'Issued by', required: true, hint: 'The authority, e.g. DVLA' },
  { key: 'licence_issue_country', label: 'Country of issue', required: true },
  { key: 'licence_valid_from', label: 'Valid from', type: 'date' },
  { key: 'licence_valid_to', label: 'Licence expires', type: 'date' },
  { key: 'licence_address', label: 'Address on the licence', wide: true },
  { key: 'idenfy_check_date', label: 'Date you checked the documents', type: 'date', required: true, hint: 'Starts the 90-day identity window' },
];

const MIN_AGE = 23;
const REFER_OVER = 75;

function ageOn(dob: string, today: string): number | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dob)) return null;
  const [by, bm, bd] = dob.split('-').map(Number);
  const [ty, tm, td] = today.split('-').map(Number);
  return ty - by - (tm < bm || (tm === bm && td < bd) ? 1 : 0);
}

export function AcceptIdentityModal({ driverId, mode, initial, fullLicence, images, onClose, onDone }: {
  driverId: string;
  /** 'accept' a check waiting for review, or 'reverse' a rejection (managers). */
  mode: 'accept' | 'reverse';
  /** The record's current values, as YYYY-MM-DD for dates. */
  initial: Record<IdentityFieldKey, string>;
  fullLicence: boolean;
  images: Array<{ label: string; url: string; name?: string }>;
  onClose: () => void;
  onDone: (raisedReferral: string | null) => void;
}) {
  // A name that is just the email address is no name at all.
  const [form, setForm] = useState<Record<IdentityFieldKey, string>>(() => ({
    ...initial,
    full_name: initial.full_name.includes('@') ? '' : initial.full_name,
  }));
  const [isFull, setIsFull] = useState(fullLicence);
  const [notes, setNotes] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !saving) onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, saving]);

  const today = ukToday();
  const age = ageOn(form.date_of_birth, today);
  const missing = FIELDS.filter(f => f.required && !form[f.key].trim()).map(f => f.label.toLowerCase());
  const reasonNeeded = mode === 'reverse';
  const canSave = !saving && missing.length === 0 && isFull
    && !(age !== null && age < MIN_AGE)
    && (!reasonNeeded || notes.trim() !== '');

  async function save() {
    setSaving(true);
    setError('');
    try {
      // Only what has a value: a blank box leaves the record as it is.
      const details: Record<string, string | boolean> = { full_licence: isFull };
      for (const f of FIELDS) {
        const v = form[f.key].trim();
        if (v) details[f.key] = v;
      }
      const res = await api.post<{ data: { raised_referral?: string | null } }>(
        `/drivers/${driverId}/resolve-identity`,
        { outcome: 'accepted', notes, details },
      );
      onDone(res.data?.raised_referral ?? null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save that — please try again.');
      setSaving(false);
    }
  }

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4" onClick={() => { if (!saving) onClose(); }}>
      <div className="bg-white rounded-lg shadow-xl max-w-2xl w-full max-h-[90vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
        <div className="px-6 py-4 border-b">
          <h3 className="text-lg font-semibold">
            {mode === 'reverse' ? 'Accept this photo ID after all' : 'Accept this photo ID'}
          </h3>
          <p className="text-sm text-gray-500 mt-1">
            Fill in what iDenfy would have read from the licence. Check each one against the images.
          </p>
        </div>

        <div className="px-6 py-4 space-y-4">
          {images.length > 0 && (
            <div className="flex flex-wrap gap-3">
              {images.map((img) => (
                <div key={img.label} className="flex flex-col items-center gap-1">
                  <DocumentThumb
                    fileKey={img.url}
                    filename={img.name}
                    onOpen={() => { openR2Key(img.url, img.name).catch(() => { /* ignore */ }); }}
                  />
                  <span className="text-[11px] text-gray-500">{img.label}</span>
                </div>
              ))}
            </div>
          )}

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            {FIELDS.map((f) => (
              <label key={f.key} className={`block ${f.wide ? 'sm:col-span-2' : ''}`}>
                <span className="block text-xs text-gray-600 mb-1">
                  {f.label}{f.required && <span className="text-red-500"> *</span>}
                </span>
                <input
                  type={f.type || 'text'}
                  value={form[f.key]}
                  max={f.type === 'date' && f.key !== 'licence_valid_to' ? today : undefined}
                  onChange={(e) => setForm({ ...form, [f.key]: e.target.value })}
                  className="w-full rounded border border-gray-300 px-3 py-1.5 text-sm focus:border-ooosh-500 focus:outline-none focus:ring-1 focus:ring-ooosh-500"
                />
                {f.hint && <span className="block text-[11px] text-gray-400 mt-0.5">{f.hint}</span>}
              </label>
            ))}
          </div>

          <label className="flex items-start gap-2 text-sm text-gray-700">
            <input type="checkbox" checked={isFull} onChange={(e) => setIsFull(e.target.checked)} className="mt-0.5" />
            <span>This is a <strong>full</strong> licence, not provisional or learner</span>
          </label>

          {age !== null && age < MIN_AGE && (
            <p className="text-sm text-red-700 bg-red-50 border border-red-200 rounded px-3 py-2">
              The driver is {age}. We can&rsquo;t insure drivers under {MIN_AGE}.
            </p>
          )}
          {age !== null && age > REFER_OVER && (
            <p className="text-sm text-amber-800 bg-amber-50 border border-amber-200 rounded px-3 py-2">
              The driver is {age}. Accepting will flag them for an insurer referral, as the automatic check does for over-{REFER_OVER}s.
            </p>
          )}
          <p className="text-xs text-gray-500">
            Covered as standard: licences from the UK, Ireland, the EU, Norway, Iceland, Liechtenstein, Switzerland,
            Australia, the USA, Canada, New Zealand and South Africa. Any other country needs referring to the insurer
            (Insurance referral panel on this page).
          </p>

          <label className="block">
            <span className="block text-xs text-gray-600 mb-1">
              {reasonNeeded ? <>Why is this being accepted after all? <span className="text-red-500">*</span></> : 'Notes (optional)'}
            </span>
            <textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              rows={2}
              placeholder="e.g. paper licence iDenfy can't read; photos re-sent and checked"
              className="w-full rounded border border-gray-300 px-3 py-2 text-sm focus:border-ooosh-500 focus:outline-none focus:ring-1 focus:ring-ooosh-500"
            />
          </label>

          {missing.length > 0 && (
            <p className="text-xs text-gray-500">Still needed: {missing.join(', ')}.</p>
          )}
          {error && <p className="text-sm text-red-600">{error}</p>}
        </div>

        <div className="px-6 py-4 border-t flex justify-end gap-2">
          <button type="button" onClick={onClose} disabled={saving}
            className="px-4 py-2 rounded-lg text-sm text-gray-700 hover:bg-gray-100 disabled:opacity-50">
            Cancel
          </button>
          <button type="button" onClick={save} disabled={!canSave}
            className="px-4 py-2 bg-green-600 text-white rounded-lg hover:bg-green-700 text-sm font-medium disabled:opacity-50">
            {saving ? 'Saving…' : '✓ Accept'}
          </button>
        </div>
      </div>
    </div>
  );
}
