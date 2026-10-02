/**
 * Staff Records — key data (NI number, right to work, emergency contact).
 *
 * Phase 2 of docs/STAFF-RECORDS-SPEC.md §3.2, on the expandable staff row
 * beside the private files.
 *
 * Fetched per person rather than read off the roster, deliberately: migration
 * 206's note says NI is "never in a list view", and the same goes for somebody's
 * right-to-work status. The roster carries neither — this component asks for one
 * person's record when their row is opened.
 *
 * The NI number is WRITE-mostly. What comes back on load is a boolean
 * (`has_ni_number`); the number itself only arrives via an explicit "Show"
 * which writes an audit_log row server-side. That is the whole reason the
 * reveal is a button rather than a field that renders pre-filled.
 *
 * Emergency contact is SHOWN, not edited — it already lives on `people` and is
 * written by the freelancer apply flow. Spec §3.2: surface it, don't duplicate it.
 */

import { useCallback, useEffect, useState } from 'react';
import { api } from '../services/api';

interface EmployeeRecord {
  has_ni_number: boolean;
  phone: string | null;
  mobile: string | null;
  home_address: string | null;
  date_of_birth: string | null;
  marital_status: string | null;
  rtw_document_type: string | null;
  rtw_checked_on: string | null;
  rtw_expires_on: string | null;
  emergency_contact_name: string | null;
  emergency_contact_phone: string | null;
  emergency_contact_relationship: string | null;
  emergency_contact_2_name: string | null;
  emergency_contact_2_phone: string | null;
  emergency_contact_2_relationship: string | null;
}

// The documents that actually prove right to work in the UK. Free text would
// make "what did we see?" unanswerable across seven people.
const RTW_DOC_TYPES = [
  'British or Irish passport',
  'Share code (online check)',
  'Biometric residence permit',
  'Birth certificate + NI evidence',
  'Settled / pre-settled status',
  'Other',
];

function fmtDate(iso: string | null): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
}

export default function StaffKeyData({ personId, personName, onSaved, onError }: {
  personId: string;
  personName: string;
  onSaved: (msg: string) => Promise<void>;
  onError: (msg: string) => void;
}) {
  const [rec, setRec] = useState<EmployeeRecord | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [editing, setEditing] = useState(false);

  const [ni, setNi] = useState('');
  const [revealed, setRevealed] = useState<string | null>(null);
  const [revealing, setRevealing] = useState(false);
  const [docType, setDocType] = useState('');
  const [checkedOn, setCheckedOn] = useState('');
  const [expiresOn, setExpiresOn] = useState('');
  // Personal details. These columns have been on `people` since migration 001;
  // what was missing was anywhere to type them, not anywhere to keep them.
  const [phone, setPhone] = useState('');
  const [mobile, setMobile] = useState('');
  const [homeAddress, setHomeAddress] = useState('');
  const [dob, setDob] = useState('');
  const [marital, setMarital] = useState('');
  const [ecName, setEcName] = useState('');
  const [ecPhone, setEcPhone] = useState('');
  const [ecRel, setEcRel] = useState('');

  const load = useCallback(async () => {
    try {
      const res = await api.get<{ data: EmployeeRecord }>(`/staff-calendar/employees/${personId}`);
      setRec(res.data);
      setDocType(res.data.rtw_document_type ?? '');
      setCheckedOn(res.data.rtw_checked_on ?? '');
      setExpiresOn(res.data.rtw_expires_on ?? '');
      setPhone(res.data.phone ?? '');
      setMobile(res.data.mobile ?? '');
      setHomeAddress(res.data.home_address ?? '');
      setDob(res.data.date_of_birth ?? '');
      setMarital(res.data.marital_status ?? '');
      setEcName(res.data.emergency_contact_name ?? '');
      setEcPhone(res.data.emergency_contact_phone ?? '');
      setEcRel(res.data.emergency_contact_relationship ?? '');
    } catch (err) {
      // A person with no employment record 404s here, and that IS fine — the
      // Employment panel already says so. Anything else is a real failure and
      // must not masquerade as "not an employee": treating every error as a
      // 404 is how a broken endpoint renders as a blank space.
      const msg = err instanceof Error ? err.message : '';
      setRec(null);
      if (!/no employment record/i.test(msg)) {
        setLoadError(msg || 'Could not load key data');
      }
    } finally {
      setLoading(false);
    }
  }, [personId]);

  useEffect(() => { void load(); }, [load]);

  async function save() {
    setSaving(true);
    try {
      const body: Record<string, unknown> = {
        rtwDocumentType: docType,
        rtwCheckedOn: checkedOn,
        rtwExpiresOn: expiresOn,
      };
      // Only sent when they typed one. An untouched NI field must not clear
      // a stored number — hence absent rather than ''.
      if (ni.trim()) body.niNumber = ni.trim();
      await api.put(`/staff-calendar/employees/${personId}/key-data`, body);
      // Separate endpoint (the NI write has its own audited path), but one
      // button: this is one form as far as anybody filling it in is concerned.
      await api.put(`/staff-calendar/employees/${personId}/personal`, {
        phone, mobile, homeAddress, dateOfBirth: dob, maritalStatus: marital,
        emergencyContactName: ecName,
        emergencyContactPhone: ecPhone,
        emergencyContactRelationship: ecRel,
      });
      setNi('');
      setRevealed(null);
      setEditing(false);
      await load();
      await onSaved(`Key data saved for ${personName}.`);
    } catch (err) {
      onError(err instanceof Error ? err.message : 'Failed to save');
    } finally {
      setSaving(false);
    }
  }

  async function reveal() {
    setRevealing(true);
    try {
      const res = await api.get<{ data: { niNumber: string | null } }>(
        `/staff-calendar/employees/${personId}/ni-number`);
      setRevealed(res.data.niNumber ?? '(nothing stored)');
    } catch (err) {
      onError(err instanceof Error ? err.message : 'Failed to read the NI number');
    } finally {
      setRevealing(false);
    }
  }

  async function clearNi() {
    if (!window.confirm(`Remove the stored NI number for ${personName}?`)) return;
    setSaving(true);
    try {
      await api.put(`/staff-calendar/employees/${personId}/key-data`, { niNumber: '' });
      setRevealed(null);
      await load();
      await onSaved(`NI number removed for ${personName}.`);
    } catch (err) {
      onError(err instanceof Error ? err.message : 'Failed to remove');
    } finally {
      setSaving(false);
    }
  }

  if (loading) return <div><h3 className="text-sm font-medium text-gray-900 mb-1">Personal &amp; key data</h3><p className="text-sm text-gray-500">Loading…</p></div>;
  if (loadError) return (
    <div>
      <h3 className="text-sm font-medium text-gray-900 mb-1">Personal &amp; key data</h3>
      <p className="text-sm text-red-700 rounded border border-red-200 bg-red-50 px-3 py-2">
        Couldn’t load key data — {loadError}
      </p>
    </div>
  );
  if (!rec) return null;

  const emergency = [
    { name: rec.emergency_contact_name, phone: rec.emergency_contact_phone, rel: rec.emergency_contact_relationship },
    { name: rec.emergency_contact_2_name, phone: rec.emergency_contact_2_phone, rel: rec.emergency_contact_2_relationship },
  ].filter(c => c.name || c.phone);

  return (
    <div>
      <div className="flex items-center justify-between mb-1">
        <h3 className="text-sm font-medium text-gray-900">Personal &amp; key data</h3>
        {!editing && (
          <button onClick={() => setEditing(true)} className="text-xs text-ooosh-600 hover:underline">Edit</button>
        )}
      </div>
      <p className="text-xs text-gray-500 mb-3">
        Payroll and legal record. Admin only — {personName.split(' ')[0]} cannot see this.
      </p>

      {!editing ? (
        <dl className="grid grid-cols-2 sm:grid-cols-4 gap-x-4 gap-y-2 text-sm">
          <div>
            <dt className="text-xs text-gray-500">NI number</dt>
            <dd className="text-gray-900">
              {rec.has_ni_number ? (
                revealed ? (
                  <span className="font-mono">{revealed}</span>
                ) : (
                  <button onClick={() => void reveal()} disabled={revealing}
                    className="text-ooosh-600 hover:underline disabled:opacity-40">
                    {revealing ? 'Reading…' : 'Show'}
                  </button>
                )
              ) : <span className="text-amber-700">Not recorded</span>}
            </dd>
          </div>
          <div>
            <dt className="text-xs text-gray-500">Right to work</dt>
            <dd className="text-gray-900">
              {rec.rtw_document_type || <span className="text-amber-700">Not checked</span>}
            </dd>
          </div>
          <div>
            <dt className="text-xs text-gray-500">Checked on</dt>
            <dd className="text-gray-900">{fmtDate(rec.rtw_checked_on)}</dd>
          </div>
          <div>
            <dt className="text-xs text-gray-500">Permission expires</dt>
            <dd className="text-gray-900">
              {rec.rtw_expires_on ? fmtDate(rec.rtw_expires_on) : <span className="text-gray-400">No limit</span>}
            </dd>
          </div>
          <div>
            <dt className="text-xs text-gray-500">Phone</dt>
            <dd className="text-gray-900">
              {[rec.mobile, rec.phone].filter(Boolean).join(' · ') || <span className="text-gray-400">—</span>}
            </dd>
          </div>
          <div>
            <dt className="text-xs text-gray-500">Date of birth</dt>
            <dd className="text-gray-900">
              {rec.date_of_birth ? fmtDate(rec.date_of_birth) : <span className="text-gray-400">—</span>}
            </dd>
          </div>
          <div>
            <dt className="text-xs text-gray-500">Marital status</dt>
            <dd className="text-gray-900">{rec.marital_status || <span className="text-gray-400">—</span>}</dd>
          </div>
          <div className="col-span-2 sm:col-span-4">
            <dt className="text-xs text-gray-500">Home address</dt>
            <dd className="text-gray-900 whitespace-pre-line">
              {rec.home_address || <span className="text-gray-400">—</span>}
            </dd>
          </div>
          {emergency.length > 0 && (
            <div className="col-span-2 sm:col-span-4">
              <dt className="text-xs text-gray-500">Emergency contact</dt>
              <dd className="text-gray-900">
                {emergency.map((c, i) => (
                  <span key={i} className="mr-3">
                    {c.name || '—'}{c.rel && <span className="text-gray-500"> ({c.rel})</span>}
                    {c.phone && <span className="text-gray-600"> · {c.phone}</span>}
                  </span>
                ))}
              </dd>
            </div>
          )}
        </dl>
      ) : (
        <div className="space-y-3">
          <div className="grid grid-cols-1 sm:grid-cols-4 gap-3">
            <label className="text-sm">
              <span className="block text-xs text-gray-600 mb-1">
                NI number {rec.has_ni_number && <span className="text-gray-400">(one is stored)</span>}
              </span>
              <input value={ni} onChange={e => setNi(e.target.value.toUpperCase())}
                placeholder={rec.has_ni_number ? 'Type to replace' : 'QQ123456C'}
                className="w-full px-2 py-1.5 border border-gray-300 rounded text-sm bg-white font-mono" />
              <span className="block text-xs text-gray-500 mt-1">
                Encrypted at rest. Leave blank to keep what is stored.
              </span>
            </label>
            <label className="text-sm">
              <span className="block text-xs text-gray-600 mb-1">Right to work — what was seen</span>
              <select value={docType} onChange={e => setDocType(e.target.value)}
                className="w-full px-2 py-1.5 border border-gray-300 rounded text-sm bg-white">
                <option value="">Not checked</option>
                {RTW_DOC_TYPES.map(d => <option key={d} value={d}>{d}</option>)}
              </select>
            </label>
            <label className="text-sm">
              <span className="block text-xs text-gray-600 mb-1">Checked on</span>
              <input type="date" value={checkedOn} onChange={e => setCheckedOn(e.target.value)}
                className="w-full px-2 py-1.5 border border-gray-300 rounded text-sm bg-white" />
            </label>
            <label className="text-sm">
              <span className="block text-xs text-gray-600 mb-1">Permission expires</span>
              <input type="date" value={expiresOn} onChange={e => setExpiresOn(e.target.value)}
                className="w-full px-2 py-1.5 border border-gray-300 rounded text-sm bg-white" />
              <span className="block text-xs text-gray-500 mt-1">
                Only for time-limited leave to remain. Blank for no limit.
              </span>
            </label>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-4 gap-3 pt-3 border-t border-gray-100">
            <label className="text-sm">
              <span className="block text-xs text-gray-600 mb-1">Mobile</span>
              <input value={mobile} onChange={e => setMobile(e.target.value)}
                className="w-full px-2 py-1.5 border border-gray-300 rounded text-sm bg-white" />
            </label>
            <label className="text-sm">
              <span className="block text-xs text-gray-600 mb-1">Other phone</span>
              <input value={phone} onChange={e => setPhone(e.target.value)}
                className="w-full px-2 py-1.5 border border-gray-300 rounded text-sm bg-white" />
            </label>
            <label className="text-sm">
              <span className="block text-xs text-gray-600 mb-1">Date of birth</span>
              <input type="date" value={dob} onChange={e => setDob(e.target.value)}
                className="w-full px-2 py-1.5 border border-gray-300 rounded text-sm bg-white" />
            </label>
            <label className="text-sm">
              <span className="block text-xs text-gray-600 mb-1">Marital status</span>
              <input value={marital} onChange={e => setMarital(e.target.value)}
                placeholder="e.g. Married"
                className="w-full px-2 py-1.5 border border-gray-300 rounded text-sm bg-white" />
            </label>
            <label className="text-sm sm:col-span-4">
              <span className="block text-xs text-gray-600 mb-1">Home address</span>
              <textarea value={homeAddress} onChange={e => setHomeAddress(e.target.value)} rows={2}
                className="w-full px-2 py-1.5 border border-gray-300 rounded text-sm bg-white" />
            </label>
            <label className="text-sm sm:col-span-2">
              <span className="block text-xs text-gray-600 mb-1">Emergency contact</span>
              <input value={ecName} onChange={e => setEcName(e.target.value)}
                className="w-full px-2 py-1.5 border border-gray-300 rounded text-sm bg-white" />
            </label>
            <label className="text-sm">
              <span className="block text-xs text-gray-600 mb-1">Their phone</span>
              <input value={ecPhone} onChange={e => setEcPhone(e.target.value)}
                className="w-full px-2 py-1.5 border border-gray-300 rounded text-sm bg-white" />
            </label>
            <label className="text-sm">
              <span className="block text-xs text-gray-600 mb-1">Relationship</span>
              <input value={ecRel} onChange={e => setEcRel(e.target.value)}
                placeholder="e.g. Partner"
                className="w-full px-2 py-1.5 border border-gray-300 rounded text-sm bg-white" />
            </label>
          </div>

          <div className="flex items-center gap-3">
            <button onClick={() => void save()} disabled={saving}
              className="px-3 py-1.5 text-sm rounded bg-ooosh-600 text-white hover:bg-ooosh-700 disabled:opacity-40">
              {saving ? 'Saving…' : 'Save key data'}
            </button>
            <button onClick={() => { setEditing(false); setNi(''); }}
              className="text-sm text-gray-500 hover:text-gray-700">Cancel</button>
            {rec.has_ni_number && (
              <button onClick={() => void clearNi()} disabled={saving}
                className="text-xs text-red-600 hover:text-red-800 ml-auto disabled:opacity-40">
                Remove stored NI number
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
