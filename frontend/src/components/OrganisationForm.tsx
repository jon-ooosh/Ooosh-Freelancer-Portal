import { useState, useEffect } from 'react';
import { api } from '../services/api';

interface OrgFormData {
  name: string;
  type: string;
  parent_id: string;
  website: string;
  email: string;
  phone: string;
  address: string;
  location: string;
  notes: string;
  tags: string[];
  working_terms_type: string;
  working_terms_credit_days: string;
  working_terms_notes: string;
}

interface OrganisationFormProps {
  orgId?: string | null;
  onSaved: () => void;
  onCancel: () => void;
}

const orgTypes = [
  'band', 'client', 'management', 'label', 'agency', 'promoter',
  'venue', 'festival', 'supplier', 'hire_company', 'booking_agent', 'other',
];

const emptyForm: OrgFormData = {
  name: '',
  type: 'band',
  parent_id: '',
  website: '',
  email: '',
  phone: '',
  address: '',
  location: '',
  notes: '',
  tags: [],
  working_terms_type: '',
  working_terms_credit_days: '',
  working_terms_notes: '',
};

export default function OrganisationForm({ orgId, onSaved, onCancel }: OrganisationFormProps) {
  const [form, setForm] = useState<OrgFormData>(emptyForm);
  const [tagInput, setTagInput] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(!!orgId);
  const [recordVersion, setRecordVersion] = useState<number | null>(null);

  const isEdit = !!orgId;

  useEffect(() => {
    if (orgId) loadOrg(orgId);
  }, [orgId]);

  async function loadOrg(id: string) {
    try {
      const data = await api.get<Record<string, unknown>>(`/organisations/${id}`);
      setForm({
        name: (data.name as string) || '',
        type: (data.type as string) || 'band',
        parent_id: (data.parent_id as string) || '',
        website: (data.website as string) || '',
        email: (data.email as string) || '',
        phone: (data.phone as string) || '',
        address: (data.address as string) || '',
        location: (data.location as string) || '',
        notes: (data.notes as string) || '',
        tags: (data.tags as string[]) || [],
        working_terms_type: (data.working_terms_type as string) || '',
        working_terms_credit_days: data.working_terms_credit_days != null ? String(data.working_terms_credit_days) : '',
        working_terms_notes: (data.working_terms_notes as string) || '',
      });
      if (data.version !== undefined) setRecordVersion(data.version as number);
    } catch {
      setError('Failed to load organisation');
    } finally {
      setLoading(false);
    }
  }

  function set(field: keyof OrgFormData, value: unknown) {
    setForm(prev => ({ ...prev, [field]: value }));
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
    if (!form.name.trim()) {
      setError('Name is required');
      return;
    }

    setSaving(true);
    setError('');
    try {
      const body = {
        ...form,
        parent_id: form.parent_id || null,
        website: form.website || null,
        email: form.email || null,
        phone: form.phone || null,
        address: form.address || null,
        location: form.location || null,
        notes: form.notes || null,
        working_terms_type: form.working_terms_type || null,
        working_terms_credit_days: form.working_terms_credit_days ? parseInt(form.working_terms_credit_days) : null,
        working_terms_notes: form.working_terms_notes || null,
      };

      if (isEdit) {
        const putBody = recordVersion !== null ? { ...body, version: recordVersion } : body;
        const result = await api.put<Record<string, unknown>>(`/organisations/${orgId}`, putBody);
        if (result.version !== undefined) setRecordVersion(result.version as number);
      } else {
        await api.post('/organisations', body);
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

      <Field label="Name *" value={form.name} onChange={v => set('name', v)} />

      <div>
        <label className="block text-xs font-medium text-gray-500 uppercase tracking-wider mb-1">Type *</label>
        <select
          value={form.type}
          onChange={e => set('type', e.target.value)}
          className="w-full rounded border border-gray-300 px-3 py-2 text-sm focus:border-ooosh-500 focus:outline-none focus:ring-1 focus:ring-ooosh-500"
        >
          {orgTypes.map(t => (
            <option key={t} value={t}>{t.replace('_', ' ').replace(/\b\w/g, l => l.toUpperCase())}</option>
          ))}
        </select>
      </div>

      <Field label="Email" type="email" value={form.email} onChange={v => set('email', v)} />
      <Field label="Phone" value={form.phone} onChange={v => set('phone', v)} />
      <Field label="Website" value={form.website} onChange={v => set('website', v)} placeholder="https://..." />
      <Field label="Address" value={form.address} onChange={v => set('address', v)} />
      <Field label="Location" value={form.location} onChange={v => set('location', v)} placeholder="e.g. London, UK" />

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
        <Field label="Credit Days" type="number" value={form.working_terms_credit_days} onChange={v => set('working_terms_credit_days', v)} placeholder="e.g. 30" />
      )}
      {form.working_terms_type && (
        <Field label="Terms Notes" value={form.working_terms_notes} onChange={v => set('working_terms_notes', v)} placeholder="Any additional terms details..." />
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

      {/* Actions */}
      <div className="flex gap-3 pt-4 border-t sticky bottom-0 bg-white pb-2">
        <button
          type="submit"
          disabled={saving}
          className="flex-1 bg-ooosh-600 text-white px-4 py-2 rounded text-sm font-medium hover:bg-ooosh-700 transition-colors disabled:opacity-50"
        >
          {saving ? 'Saving...' : isEdit ? 'Update Organisation' : 'Create Organisation'}
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

function Field({ label, value, onChange, type = 'text', placeholder }: {
  label: string; value: string; onChange: (v: string) => void;
  type?: string; placeholder?: string;
}) {
  return (
    <div>
      <label className="block text-xs font-medium text-gray-500 uppercase tracking-wider mb-1">{label}</label>
      <input
        type={type}
        value={value}
        onChange={e => onChange(e.target.value)}
        placeholder={placeholder}
        className="w-full rounded border border-gray-300 px-3 py-2 text-sm focus:border-ooosh-500 focus:outline-none focus:ring-1 focus:ring-ooosh-500"
      />
    </div>
  );
}
