import { useState, useEffect, useRef } from 'react';
import { api } from '../services/api';
import { Link } from 'react-router-dom';

interface PersonFormData {
  first_name: string;
  last_name: string;
  email: string;
  phone: string;
  mobile: string;
  international_phone: string;
  preferred_contact_method: string;
  home_address: string;
  date_of_birth: string;
  notes: string;
  tags: string[];
  // Freelancer — the detail fields (skills, dates, approval, docs, references)
  // now live on the Person's "Freelancer" tab. This toggle is just the gateway
  // that flags someone as a freelancer and reveals that tab.
  is_freelancer: boolean;
  working_terms_type: string;
  working_terms_credit_days: string;
  working_terms_notes: string;
}

interface PersonFormProps {
  personId?: string | null;
  onSaved: () => void;
  onCancel: () => void;
}

const emptyForm: PersonFormData = {
  first_name: '',
  last_name: '',
  email: '',
  phone: '',
  mobile: '',
  international_phone: '',
  preferred_contact_method: 'email',
  home_address: '',
  date_of_birth: '',
  notes: '',
  tags: [],
  is_freelancer: false,
  working_terms_type: 'usual',
  working_terms_credit_days: '',
  working_terms_notes: '',
};

export default function PersonForm({ personId, onSaved, onCancel }: PersonFormProps) {
  const [form, setForm] = useState<PersonFormData>(emptyForm);
  const [tagInput, setTagInput] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(!!personId);
  const [showFreelancer, setShowFreelancer] = useState(false);
  const [recordVersion, setRecordVersion] = useState<number | null>(null);
  const [emailWarning, setEmailWarning] = useState<{ name: string; id: string } | null>(null);
  const emailCheckRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [originalName, setOriginalName] = useState<string>('');
  const [linkedOrgs, setLinkedOrgs] = useState<Array<{ id: string; name: string }>>([]);
  const [syncOrgIds, setSyncOrgIds] = useState<Set<string>>(new Set());

  const isEdit = !!personId;

  useEffect(() => {
    if (personId) {
      loadPerson(personId);
    }
  }, [personId]);

  async function loadPerson(id: string) {
    try {
      const data = await api.get<Record<string, unknown>>(`/people/${id}`);
      setForm({
        first_name: (data.first_name as string) || '',
        last_name: (data.last_name as string) || '',
        email: (data.email as string) || '',
        phone: (data.phone as string) || '',
        mobile: (data.mobile as string) || '',
        international_phone: (data.international_phone as string) || '',
        preferred_contact_method: (data.preferred_contact_method as string) || 'email',
        home_address: (data.home_address as string) || '',
        date_of_birth: (data.date_of_birth as string) || '',
        notes: (data.notes as string) || '',
        tags: (data.tags as string[]) || [],
        is_freelancer: (data.is_freelancer as boolean) || false,
        working_terms_type: (data.working_terms_type as string) || '',
        working_terms_credit_days: data.working_terms_credit_days != null ? String(data.working_terms_credit_days) : '',
        working_terms_notes: (data.working_terms_notes as string) || '',
      });
      setShowFreelancer((data.is_freelancer as boolean) || false);
      if (data.version !== undefined) setRecordVersion(data.version as number);

      const first = (data.first_name as string) || '';
      const last = (data.last_name as string) || '';
      setOriginalName(`${first} ${last}`.trim());
      const orgs = (data.organisations as Array<{ organisation_id: string; organisation_name: string; status: string }> | null) || [];
      setLinkedOrgs(
        orgs
          .filter(o => o.status === 'active')
          .map(o => ({ id: o.organisation_id, name: o.organisation_name }))
      );
      setSyncOrgIds(new Set());
    } catch {
      setError('Failed to load person');
    } finally {
      setLoading(false);
    }
  }

  function checkEmail(email: string) {
    if (emailCheckRef.current) clearTimeout(emailCheckRef.current);
    if (!email || !email.includes('@')) {
      setEmailWarning(null);
      return;
    }
    emailCheckRef.current = setTimeout(async () => {
      try {
        const params = new URLSearchParams({ email });
        if (personId) params.set('exclude_id', personId);
        const data = await api.get<{ exists: boolean; match?: { id: string; name: string } }>(
          `/people/check-email?${params}`
        );
        setEmailWarning(data.exists && data.match ? data.match : null);
      } catch {
        setEmailWarning(null);
      }
    }, 400);
  }

  function set(field: keyof PersonFormData, value: unknown) {
    setForm(prev => ({ ...prev, [field]: value }));
    if (field === 'email') checkEmail(value as string);
  }

  function addTag() {
    const tag = tagInput.trim();
    if (tag && !form.tags.includes(tag)) {
      set('tags', [...form.tags, tag]);
    }
    setTagInput('');
  }

  function removeTag(tag: string) {
    set('tags', form.tags.filter(t => t !== tag));
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!form.first_name.trim() || !form.last_name.trim()) {
      setError('First name and last name are required');
      return;
    }

    setSaving(true);
    setError('');
    try {
      const body = {
        ...form,
        email: form.email || null,
        phone: form.phone || null,
        mobile: form.mobile || null,
        international_phone: form.international_phone || null,
        home_address: form.home_address || null,
        date_of_birth: form.date_of_birth || null,
        notes: form.notes || null,
        working_terms_type: form.working_terms_type || null,
        working_terms_credit_days: form.working_terms_credit_days ? parseInt(form.working_terms_credit_days) : null,
        working_terms_notes: form.working_terms_notes || null,
      };

      if (isEdit) {
        const putBody = recordVersion !== null ? { ...body, version: recordVersion } : body;
        const result = await api.put<Record<string, unknown>>(`/people/${personId}`, putBody);
        if (result.version !== undefined) setRecordVersion(result.version as number);

        if (syncOrgIds.size > 0) {
          const newName = `${form.first_name.trim()} ${form.last_name.trim()}`.trim();
          await Promise.all(
            Array.from(syncOrgIds).map(orgId =>
              api.put(`/organisations/${orgId}`, { name: newName }).catch(err => {
                console.error(`Failed to sync organisation ${orgId} name:`, err);
              })
            )
          );
        }
      } else {
        await api.post('/people', body);
      }
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save');
    } finally {
      setSaving(false);
    }
  }

  if (loading) {
    return <div className="text-center py-8 text-gray-500">Loading...</div>;
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-5">
      {error && (
        <div className="bg-red-50 text-red-700 px-4 py-2 rounded text-sm">{error}</div>
      )}

      {/* Name */}
      <div className="grid grid-cols-2 gap-4">
        <Field label="First Name *" value={form.first_name} onChange={v => set('first_name', v)} />
        <Field label="Last Name *" value={form.last_name} onChange={v => set('last_name', v)} />
      </div>
      {(() => {
        const currentName = `${form.first_name.trim()} ${form.last_name.trim()}`.trim();
        if (!isEdit || !originalName || currentName === originalName) return null;
        const matches = linkedOrgs.filter(o => o.name.trim() === originalName);
        if (matches.length === 0) return null;
        return (
          <div className="bg-amber-50 border border-amber-200 rounded px-3 py-2 text-xs text-amber-800">
            <p className="font-medium mb-1">Linked organisation has the old name</p>
            <p className="text-amber-700 mb-2">
              Rename to <span className="font-medium">{currentName || '(empty)'}</span> too?
            </p>
            {matches.map(org => (
              <label key={org.id} className="flex items-center gap-2 py-0.5 cursor-pointer">
                <input
                  type="checkbox"
                  checked={syncOrgIds.has(org.id)}
                  onChange={e => {
                    const next = new Set(syncOrgIds);
                    if (e.target.checked) next.add(org.id);
                    else next.delete(org.id);
                    setSyncOrgIds(next);
                  }}
                  className="rounded"
                />
                <span>{org.name}</span>
              </label>
            ))}
          </div>
        );
      })()}

      {/* Contact */}
      <div>
        <Field label="Email" type="email" value={form.email} onChange={v => set('email', v)} emailValidation />
        {emailWarning && (
          <div className="mt-1 bg-amber-50 border border-amber-200 text-amber-700 px-3 py-2 rounded text-xs flex items-center gap-2">
            <span className="font-bold text-amber-600">!</span>
            <span>
              This email already belongs to{' '}
              <Link to={`/people/${emailWarning.id}`} className="font-medium underline hover:text-amber-800">
                {emailWarning.name}
              </Link>
              . You can still save, but this may create a duplicate.
            </span>
          </div>
        )}
      </div>
      <div className="grid grid-cols-2 gap-4">
        <Field label="Mobile" value={form.mobile} onChange={v => set('mobile', v)} placeholder="UK mobile" />
        <Field label="Phone" value={form.phone} onChange={v => set('phone', v)} placeholder="Landline / office" />
      </div>
      <Field label="International Phone" value={form.international_phone} onChange={v => set('international_phone', v)} placeholder="Touring number" />

      <div>
        <label className="block text-xs font-medium text-gray-500 uppercase tracking-wider mb-1">Preferred Contact Method</label>
        <select
          value={form.preferred_contact_method}
          onChange={e => set('preferred_contact_method', e.target.value)}
          className="w-full rounded border border-gray-300 px-3 py-2 text-sm focus:border-ooosh-500 focus:outline-none focus:ring-1 focus:ring-ooosh-500"
        >
          <option value="email">Email</option>
          <option value="phone">Phone</option>
          <option value="mobile">Mobile</option>
          <option value="whatsapp">WhatsApp</option>
        </select>
      </div>

      {/* Personal */}
      <Field label="Home Address" value={form.home_address} onChange={v => set('home_address', v)} />
      <Field label="Date of Birth" type="date" value={form.date_of_birth} onChange={v => set('date_of_birth', v)} />

      {/* Tags */}
      <div>
        <label className="block text-xs font-medium text-gray-500 uppercase tracking-wider mb-1">Tags</label>
        <div className="flex flex-wrap gap-1 mb-2">
          {form.tags.map(tag => (
            <span key={tag} className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs bg-gray-100 text-gray-600">
              {tag}
              <button type="button" onClick={() => removeTag(tag)} className="text-gray-400 hover:text-gray-600">&times;</button>
            </span>
          ))}
        </div>
        <div className="flex gap-2">
          <input
            value={tagInput}
            onChange={e => setTagInput(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); addTag(); } }}
            placeholder="Add tag..."
            className="flex-1 rounded border border-gray-300 px-3 py-1.5 text-sm focus:border-ooosh-500 focus:outline-none focus:ring-1 focus:ring-ooosh-500"
          />
          <button type="button" onClick={addTag} className="px-3 py-1.5 text-sm border border-gray-300 rounded hover:bg-gray-50">Add</button>
        </div>
      </div>

      {/* Working Terms */}
      <h3 className="text-sm font-semibold text-gray-700 pt-2">Working Terms</h3>
      <div>
        <label className="block text-xs font-medium text-gray-500 uppercase tracking-wider mb-1">Payment Terms</label>
        <select
          value={form.working_terms_type}
          onChange={e => set('working_terms_type', e.target.value)}
          className="w-full rounded border border-gray-300 px-3 py-2 text-sm focus:border-ooosh-500 focus:outline-none focus:ring-1 focus:ring-ooosh-500"
        >
          <option value="">Not set</option>
          <option value="usual">USUAL (25% deposit, full balance before hire)</option>
          <option value="flex_balance">FLEX BALANCE (25% deposit, flexible balance)</option>
          <option value="no_deposit">NO DEPOSIT (balance by start of hire)</option>
          <option value="credit">CREDIT (no deposit, flexible balance)</option>
          <option value="custom">CUSTOM</option>
        </select>
      </div>
      {(form.working_terms_type === 'flex_balance' || form.working_terms_type === 'credit') && (
        <div>
          <label className="block text-xs font-medium text-gray-500 uppercase tracking-wider mb-1">Credit Days</label>
          <input type="number" value={form.working_terms_credit_days} onChange={e => set('working_terms_credit_days', e.target.value)} placeholder="e.g. 30" className="w-full rounded border border-gray-300 px-3 py-2 text-sm focus:border-ooosh-500 focus:outline-none focus:ring-1 focus:ring-ooosh-500" />
        </div>
      )}
      {form.working_terms_type && (
        <div>
          <label className="block text-xs font-medium text-gray-500 uppercase tracking-wider mb-1">Terms Notes</label>
          <input value={form.working_terms_notes} onChange={e => set('working_terms_notes', e.target.value)} placeholder="Any additional terms details..." className="w-full rounded border border-gray-300 px-3 py-2 text-sm focus:border-ooosh-500 focus:outline-none focus:ring-1 focus:ring-ooosh-500" />
        </div>
      )}

      {/* Notes */}
      <div>
        <label className="block text-xs font-medium text-gray-500 uppercase tracking-wider mb-1">Notes</label>
        <textarea
          value={form.notes}
          onChange={e => set('notes', e.target.value)}
          rows={3}
          className="w-full rounded border border-gray-300 px-3 py-2 text-sm focus:border-ooosh-500 focus:outline-none focus:ring-1 focus:ring-ooosh-500 resize-none"
        />
      </div>

      {/* Freelancer toggle — the gateway flag. Skills, dates, approval,
          documents and references live on the person's "Freelancer" tab. */}
      <div className="border-t pt-4">
        <label className="flex items-center gap-2 cursor-pointer">
          <input
            type="checkbox"
            checked={showFreelancer}
            onChange={e => { setShowFreelancer(e.target.checked); set('is_freelancer', e.target.checked); }}
            className="rounded border-gray-300 text-ooosh-600 focus:ring-ooosh-500"
          />
          <span className="text-sm font-medium text-gray-700">This person is a freelancer</span>
        </label>
        {showFreelancer && (
          <p className="mt-2 text-xs text-gray-500">
            {isEdit
              ? 'Manage skills, approval, review dates, documents and references on the Freelancer tab.'
              : 'After creating, manage skills, approval, review dates and documents on the Freelancer tab.'}
          </p>
        )}
      </div>

      {/* Actions */}
      <div className="flex gap-3 pt-4 border-t sticky bottom-0 bg-white pb-2">
        <button
          type="submit"
          disabled={saving}
          className="flex-1 bg-ooosh-600 text-white px-4 py-2 rounded text-sm font-medium hover:bg-ooosh-700 transition-colors disabled:opacity-50"
        >
          {saving ? 'Saving...' : isEdit ? 'Update Person' : 'Create Person'}
        </button>
        <button
          type="button"
          onClick={onCancel}
          className="px-4 py-2 text-sm border border-gray-300 rounded hover:bg-gray-50 transition-colors"
        >
          Cancel
        </button>
      </div>
    </form>
  );
}

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function Field({ label, value, onChange, type = 'text', placeholder, emailValidation }: {
  label: string; value: string; onChange: (v: string) => void;
  type?: string; placeholder?: string; emailValidation?: boolean;
}) {
  const showEmailError = emailValidation && value.trim() !== '' && !EMAIL_REGEX.test(value.trim());
  return (
    <div>
      <label className="block text-xs font-medium text-gray-500 uppercase tracking-wider mb-1">{label}</label>
      <input
        type={type}
        value={value}
        onChange={e => onChange(e.target.value)}
        placeholder={placeholder}
        className={`w-full rounded border px-3 py-2 text-sm focus:outline-none focus:ring-1 ${showEmailError ? 'border-red-400 focus:border-red-500 focus:ring-red-500' : 'border-gray-300 focus:border-ooosh-500 focus:ring-ooosh-500'}`}
      />
      {showEmailError && (
        <p className="mt-1 text-xs text-red-500">Please enter a valid email address</p>
      )}
    </div>
  );
}
