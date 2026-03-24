import { useState, useEffect } from 'react';
import { api } from '../services/api';

interface VenueFormData {
  name: string;
  organisation_id: string;
  address: string;
  city: string;
  postcode: string;
  country: string;
  w3w_address: string;
  load_in_address: string;
  loading_bay_info: string;
  access_codes: string;
  parking_info: string;
  approach_notes: string;
  technical_notes: string;
  general_notes: string;
  default_miles_from_base: string;
  default_drive_time_mins: string;
  default_return_cost: string;
  tags: string[];
}

interface VenueFormProps {
  venueId?: string | null;
  onSaved: () => void;
  onCancel: () => void;
}

const emptyForm: VenueFormData = {
  name: '',
  organisation_id: '',
  address: '',
  city: '',
  postcode: '',
  country: 'UK',
  w3w_address: '',
  load_in_address: '',
  loading_bay_info: '',
  access_codes: '',
  parking_info: '',
  approach_notes: '',
  technical_notes: '',
  general_notes: '',
  default_miles_from_base: '',
  default_drive_time_mins: '',
  default_return_cost: '',
  tags: [],
};

export default function VenueForm({ venueId, onSaved, onCancel }: VenueFormProps) {
  const [form, setForm] = useState<VenueFormData>(emptyForm);
  const [tagInput, setTagInput] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(!!venueId);
  const [recordVersion, setRecordVersion] = useState<number | null>(null);
  const [orgSearch, setOrgSearch] = useState('');
  const [orgResults, setOrgResults] = useState<Array<{ id: string; name: string; type: string }>>([]);
  const [orgName, setOrgName] = useState('');
  const [showOrgDropdown, setShowOrgDropdown] = useState(false);

  const isEdit = !!venueId;

  useEffect(() => {
    if (venueId) loadVenue(venueId);
  }, [venueId]);

  async function loadVenue(id: string) {
    try {
      const data = await api.get<Record<string, unknown>>(`/venues/${id}`);
      setForm({
        name: (data.name as string) || '',
        organisation_id: (data.organisation_id as string) || '',
        address: (data.address as string) || '',
        city: (data.city as string) || '',
        postcode: (data.postcode as string) || '',
        country: (data.country as string) || 'UK',
        w3w_address: (data.w3w_address as string) || '',
        load_in_address: (data.load_in_address as string) || '',
        loading_bay_info: (data.loading_bay_info as string) || '',
        access_codes: (data.access_codes as string) || '',
        parking_info: (data.parking_info as string) || '',
        approach_notes: (data.approach_notes as string) || '',
        technical_notes: (data.technical_notes as string) || '',
        general_notes: (data.general_notes as string) || '',
        default_miles_from_base: data.default_miles_from_base != null ? String(data.default_miles_from_base) : '',
        default_drive_time_mins: data.default_drive_time_mins != null ? String(data.default_drive_time_mins) : '',
        default_return_cost: data.default_return_cost != null ? String(data.default_return_cost) : '',
        tags: (data.tags as string[]) || [],
      });
      if (data.version !== undefined) setRecordVersion(data.version as number);
      if (data.organisation_id) {
        try {
          const org = await api.get<{ name: string }>(`/organisations/${data.organisation_id}`);
          setOrgName(org.name);
        } catch { /* org may have been deleted */ }
      }
    } catch {
      setError('Failed to load venue');
    } finally {
      setLoading(false);
    }
  }

  function set(field: keyof VenueFormData, value: unknown) {
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

  useEffect(() => {
    if (orgSearch.length < 2) { setOrgResults([]); return; }
    const timeout = setTimeout(async () => {
      try {
        const data = await api.get<{ data: Array<{ id: string; name: string; type: string }> }>(`/organisations?search=${encodeURIComponent(orgSearch)}&limit=8`);
        setOrgResults(data.data);
        setShowOrgDropdown(true);
      } catch { /* ignore */ }
    }, 300);
    return () => clearTimeout(timeout);
  }, [orgSearch]);

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
        name: form.name,
        organisation_id: form.organisation_id || null,
        address: form.address || null,
        city: form.city || null,
        postcode: form.postcode || null,
        country: form.country || null,
        w3w_address: form.w3w_address || null,
        load_in_address: form.load_in_address || null,
        loading_bay_info: form.loading_bay_info || null,
        access_codes: form.access_codes || null,
        parking_info: form.parking_info || null,
        approach_notes: form.approach_notes || null,
        technical_notes: form.technical_notes || null,
        general_notes: form.general_notes || null,
        default_miles_from_base: form.default_miles_from_base ? parseFloat(form.default_miles_from_base) : null,
        default_drive_time_mins: form.default_drive_time_mins ? parseInt(form.default_drive_time_mins) : null,
        default_return_cost: form.default_return_cost ? parseFloat(form.default_return_cost) : null,
        tags: form.tags,
      };

      if (isEdit) {
        const putBody = recordVersion !== null ? { ...body, version: recordVersion } : body;
        const result = await api.put<Record<string, unknown>>(`/venues/${venueId}`, putBody);
        if (result.version !== undefined) setRecordVersion(result.version as number);
      } else {
        await api.post('/venues', body);
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

      <Field label="Venue Name *" value={form.name} onChange={v => set('name', v)} />

      {/* Organisation */}
      <div className="relative">
        <label className="block text-xs font-medium text-gray-500 uppercase tracking-wider mb-1">Organisation</label>
        {form.organisation_id && orgName ? (
          <div className="flex items-center gap-2 px-3 py-2 border border-gray-300 rounded text-sm bg-gray-50">
            <span className="flex-1">{orgName}</span>
            <button type="button" onClick={() => { set('organisation_id', ''); setOrgName(''); setOrgSearch(''); }} className="text-gray-400 hover:text-gray-600">&times;</button>
          </div>
        ) : (
          <input
            value={orgSearch}
            onChange={e => setOrgSearch(e.target.value)}
            onFocus={() => orgResults.length > 0 && setShowOrgDropdown(true)}
            onBlur={() => setTimeout(() => setShowOrgDropdown(false), 200)}
            placeholder="Search organisations..."
            className="w-full rounded border border-gray-300 px-3 py-2 text-sm focus:border-ooosh-500 focus:outline-none focus:ring-1 focus:ring-ooosh-500"
          />
        )}
        {showOrgDropdown && orgResults.length > 0 && (
          <div className="absolute z-10 w-full mt-1 bg-white border border-gray-200 rounded shadow-lg max-h-48 overflow-y-auto">
            {orgResults.map(o => (
              <button
                key={o.id}
                type="button"
                onMouseDown={() => {
                  set('organisation_id', o.id);
                  setOrgName(o.name);
                  setOrgSearch('');
                  setShowOrgDropdown(false);
                }}
                className="w-full text-left px-3 py-2 text-sm hover:bg-ooosh-50 flex items-center gap-2"
              >
                <span>{o.name}</span>
                <span className="text-xs text-gray-400">{o.type}</span>
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Address */}
      <h3 className="text-sm font-semibold text-gray-700 pt-2">Address</h3>
      <Field label="Address" value={form.address} onChange={v => set('address', v)} />
      <div className="grid grid-cols-3 gap-3">
        <Field label="City" value={form.city} onChange={v => set('city', v)} />
        <Field label="Postcode" value={form.postcode} onChange={v => set('postcode', v)} />
        <Field label="Country" value={form.country} onChange={v => set('country', v)} />
      </div>

      {/* Load-in & Access */}
      <h3 className="text-sm font-semibold text-gray-700 pt-2">Load-in & Access</h3>
      <Field label="Load-in Address" value={form.load_in_address} onChange={v => set('load_in_address', v)} placeholder="If different from main address" />
      <Field label="what3words" value={form.w3w_address} onChange={v => set('w3w_address', v)} placeholder="e.g. ///filled.count.soap" />
      <TextArea label="Loading Bay Info" value={form.loading_bay_info} onChange={v => set('loading_bay_info', v)} />
      <TextArea label="Access Codes" value={form.access_codes} onChange={v => set('access_codes', v)} placeholder="Gate codes, door codes, etc." />

      {/* Logistics */}
      <h3 className="text-sm font-semibold text-gray-700 pt-2">Logistics</h3>
      <TextArea label="Parking Info" value={form.parking_info} onChange={v => set('parking_info', v)} />
      <TextArea label="Approach Notes" value={form.approach_notes} onChange={v => set('approach_notes', v)} />

      <div className="grid grid-cols-3 gap-3">
        <Field label="Miles from Base" value={form.default_miles_from_base} onChange={v => set('default_miles_from_base', v)} type="number" />
        <Field label="Drive Time (mins)" value={form.default_drive_time_mins} onChange={v => set('default_drive_time_mins', v)} type="number" />
        <Field label="Return Cost (£)" value={form.default_return_cost} onChange={v => set('default_return_cost', v)} type="number" />
      </div>

      {/* Technical */}
      <h3 className="text-sm font-semibold text-gray-700 pt-2">Notes</h3>
      <TextArea label="Technical Notes" value={form.technical_notes} onChange={v => set('technical_notes', v)} />
      <TextArea label="General Notes" value={form.general_notes} onChange={v => set('general_notes', v)} />

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

      {/* Actions */}
      <div className="flex gap-3 pt-4 border-t sticky bottom-0 bg-white pb-2">
        <button
          type="submit"
          disabled={saving}
          className="flex-1 bg-ooosh-600 text-white px-4 py-2 rounded text-sm font-medium hover:bg-ooosh-700 transition-colors disabled:opacity-50"
        >
          {saving ? 'Saving...' : isEdit ? 'Update Venue' : 'Create Venue'}
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

function TextArea({ label, value, onChange, placeholder }: {
  label: string; value: string; onChange: (v: string) => void; placeholder?: string;
}) {
  return (
    <div>
      <label className="block text-xs font-medium text-gray-500 uppercase tracking-wider mb-1">{label}</label>
      <textarea
        value={value}
        onChange={e => onChange(e.target.value)}
        placeholder={placeholder}
        rows={2}
        className="w-full rounded border border-gray-300 px-3 py-2 text-sm focus:border-ooosh-500 focus:outline-none focus:ring-1 focus:ring-ooosh-500 resize-none"
      />
    </div>
  );
}
