import { useState, useEffect } from 'react';
import { api } from '../services/api';

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
  // Freelancer
  skills: string[];
  is_insured_on_vehicles: boolean;
  is_approved: boolean;
  has_tshirt: boolean;
  emergency_contact_name: string;
  emergency_contact_phone: string;
  licence_details: string;
}

interface PersonFormProps {
  personId?: string | null;
  onSaved: () => void;
  onCancel: () => void;
}

const PRESET_SKILLS = [
  'Sound Engineer',
  'Lighting Engineer',
  'Stage Manager',
  'Backline Tech',
  'Monitor Engineer',
  'FOH Engineer',
  'Rigger',
  'Tour Manager',
  'Production Manager',
  'Driver',
  'Truck Driver',
  'Van Driver',
  'Stage Hand',
  'Carpenter',
  'Electrician',
  'Video Tech',
  'LED Tech',
  'Follow Spot Operator',
  'Pyro Tech',
  'SFX Tech',
  'Wardrobe',
  'Runner',
  'Caterer',
  'Security',
  'First Aider',
  'Site Manager',
  'Event Manager',
];

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
  skills: [],
  is_insured_on_vehicles: false,
  is_approved: false,
  has_tshirt: false,
  emergency_contact_name: '',
  emergency_contact_phone: '',
  licence_details: '',
};

export default function PersonForm({ personId, onSaved, onCancel }: PersonFormProps) {
  const [form, setForm] = useState<PersonFormData>(emptyForm);
  const [tagInput, setTagInput] = useState('');
  const [skillInput, setSkillInput] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(!!personId);
  const [showFreelancer, setShowFreelancer] = useState(false);

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
        skills: (data.skills as string[]) || [],
        is_insured_on_vehicles: (data.is_insured_on_vehicles as boolean) || false,
        is_approved: (data.is_approved as boolean) || false,
        has_tshirt: (data.has_tshirt as boolean) || false,
        emergency_contact_name: (data.emergency_contact_name as string) || '',
        emergency_contact_phone: (data.emergency_contact_phone as string) || '',
        licence_details: (data.licence_details as string) || '',
      });
      const skills = (data.skills as string[]) || [];
      setShowFreelancer(skills.length > 0);
    } catch {
      setError('Failed to load person');
    } finally {
      setLoading(false);
    }
  }

  function set(field: keyof PersonFormData, value: unknown) {
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

  function addSkill() {
    const skill = skillInput.trim();
    if (skill && !form.skills.includes(skill)) {
      set('skills', [...form.skills, skill]);
    }
    setSkillInput('');
  }

  function removeSkill(skill: string) {
    set('skills', form.skills.filter(s => s !== skill));
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
        emergency_contact_name: form.emergency_contact_name || null,
        emergency_contact_phone: form.emergency_contact_phone || null,
        licence_details: form.licence_details || null,
      };

      if (isEdit) {
        await api.put(`/people/${personId}`, body);
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

      {/* Contact */}
      <Field label="Email" type="email" value={form.email} onChange={v => set('email', v)} />
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

      {/* Freelancer toggle */}
      <div className="border-t pt-4">
        <label className="flex items-center gap-2 cursor-pointer">
          <input
            type="checkbox"
            checked={showFreelancer}
            onChange={e => setShowFreelancer(e.target.checked)}
            className="rounded border-gray-300 text-ooosh-600 focus:ring-ooosh-500"
          />
          <span className="text-sm font-medium text-gray-700">This person is a freelancer</span>
        </label>
      </div>

      {showFreelancer && (
        <div className="space-y-4 pl-2 border-l-2 border-ooosh-200">
          {/* Skills */}
          <div>
            <label className="block text-xs font-medium text-gray-500 uppercase tracking-wider mb-1">Skills</label>
            <div className="flex flex-wrap gap-1 mb-2">
              {form.skills.map(skill => (
                <span key={skill} className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs bg-ooosh-100 text-ooosh-700">
                  {skill}
                  <button type="button" onClick={() => removeSkill(skill)} className="text-ooosh-400 hover:text-ooosh-600">&times;</button>
                </span>
              ))}
            </div>
            <div className="flex gap-2">
              <select
                value=""
                onChange={e => {
                  const val = e.target.value;
                  if (val === '__custom__') {
                    setSkillInput('');
                    // Focus will shift to the input that appears
                  } else if (val && !form.skills.includes(val)) {
                    set('skills', [...form.skills, val]);
                  }
                  e.target.value = '';
                }}
                className="flex-1 rounded border border-gray-300 px-3 py-1.5 text-sm focus:border-ooosh-500 focus:outline-none focus:ring-1 focus:ring-ooosh-500"
              >
                <option value="">Select a skill...</option>
                {PRESET_SKILLS.filter(s => !form.skills.includes(s)).map(s => (
                  <option key={s} value={s}>{s}</option>
                ))}
                <option value="__custom__">+ Add custom skill</option>
              </select>
            </div>
            {skillInput !== null && (
              <div className="flex gap-2 mt-2">
                <input
                  value={skillInput}
                  onChange={e => setSkillInput(e.target.value)}
                  onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); addSkill(); } }}
                  placeholder="Type custom skill..."
                  autoFocus
                  className="flex-1 rounded border border-gray-300 px-3 py-1.5 text-sm focus:border-ooosh-500 focus:outline-none focus:ring-1 focus:ring-ooosh-500"
                />
                <button type="button" onClick={addSkill} className="px-3 py-1.5 text-sm border border-gray-300 rounded hover:bg-gray-50">Add</button>
              </div>
            )}
          </div>

          <Field label="Licence Details" value={form.licence_details} onChange={v => set('licence_details', v)} />

          <div className="grid grid-cols-2 gap-4">
            <Field label="Emergency Contact Name" value={form.emergency_contact_name} onChange={v => set('emergency_contact_name', v)} />
            <Field label="Emergency Contact Phone" value={form.emergency_contact_phone} onChange={v => set('emergency_contact_phone', v)} />
          </div>

          <div className="flex flex-wrap gap-4">
            <Checkbox label="Insured on vehicles" checked={form.is_insured_on_vehicles} onChange={v => set('is_insured_on_vehicles', v)} />
            <Checkbox label="Approved freelancer" checked={form.is_approved} onChange={v => set('is_approved', v)} />
            <Checkbox label="Has T-shirt" checked={form.has_tshirt} onChange={v => set('has_tshirt', v)} />
          </div>
        </div>
      )}

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

function Checkbox({ label, checked, onChange }: {
  label: string; checked: boolean; onChange: (v: boolean) => void;
}) {
  return (
    <label className="flex items-center gap-2 cursor-pointer">
      <input
        type="checkbox"
        checked={checked}
        onChange={e => onChange(e.target.checked)}
        className="rounded border-gray-300 text-ooosh-600 focus:ring-ooosh-500"
      />
      <span className="text-sm text-gray-700">{label}</span>
    </label>
  );
}
