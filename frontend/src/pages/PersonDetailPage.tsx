import { useState, useEffect } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import { api } from '../services/api';
import { useAuthStore } from '../hooks/useAuthStore';
import SlidePanel from '../components/SlidePanel';
import PersonForm from '../components/PersonForm';
import FileUpload from '../components/FileUpload';

interface PersonDetail {
  id: string;
  first_name: string;
  last_name: string;
  email: string | null;
  phone: string | null;
  mobile: string | null;
  international_phone: string | null;
  notes: string | null;
  tags: string[];
  preferred_contact_method: string;
  home_address: string | null;
  date_of_birth: string | null;
  skills: string[];
  is_insured_on_vehicles: boolean;
  is_approved: boolean;
  has_tshirt: boolean;
  emergency_contact_name: string | null;
  emergency_contact_phone: string | null;
  licence_details: string | null;
  files: Array<{ name: string; url: string; type: 'document' | 'image' | 'other'; uploaded_at: string; uploaded_by: string }>;
  created_at: string;
  organisations: Array<{
    id: string;
    organisation_id: string;
    organisation_name: string;
    organisation_type: string;
    role: string;
    status: string;
    is_primary: boolean;
    start_date: string | null;
    end_date: string | null;
    notes: string | null;
  }> | null;
}

interface Interaction {
  id: string;
  type: string;
  content: string;
  created_at: string;
  created_by_name: string | null;
  created_by_email: string | null;
}

const typeIcons: Record<string, string> = {
  note: 'N',
  call: 'C',
  email: 'E',
  meeting: 'M',
  mention: '@',
};

const typeColors: Record<string, string> = {
  note: 'bg-blue-100 text-blue-700',
  call: 'bg-green-100 text-green-700',
  email: 'bg-purple-100 text-purple-700',
  meeting: 'bg-amber-100 text-amber-700',
  mention: 'bg-pink-100 text-pink-700',
};

export default function PersonDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const user = useAuthStore((s) => s.user);

  const [person, setPerson] = useState<PersonDetail | null>(null);
  const [interactions, setInteractions] = useState<Interaction[]>([]);
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState<'timeline' | 'details' | 'relationships'>('timeline');

  // New interaction form
  const [newNote, setNewNote] = useState('');
  const [newNoteType, setNewNoteType] = useState<string>('note');
  const [submitting, setSubmitting] = useState(false);

  // Edit panel
  const [showEdit, setShowEdit] = useState(false);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);

  // Add relationship
  const [showAddRole, setShowAddRole] = useState(false);
  const [roleOrgSearch, setRoleOrgSearch] = useState('');
  const [roleOrgResults, setRoleOrgResults] = useState<Array<{ id: string; name: string; type: string }>>([]);
  const [roleSelectedOrg, setRoleSelectedOrg] = useState<{ id: string; name: string } | null>(null);
  const [roleTitle, setRoleTitle] = useState('');
  const [roleIsPrimary, setRoleIsPrimary] = useState(false);
  const [roleSubmitting, setRoleSubmitting] = useState(false);

  useEffect(() => {
    if (id) {
      loadPerson();
      loadInteractions();
    }
  }, [id]);

  async function loadPerson() {
    try {
      const data = await api.get<PersonDetail>(`/people/${id}`);
      setPerson(data);
    } catch {
      navigate('/people');
    } finally {
      setLoading(false);
    }
  }

  async function loadInteractions() {
    try {
      const data = await api.get<{ data: Interaction[] }>(`/interactions?person_id=${id}`);
      setInteractions(data.data);
    } catch (err) {
      console.error('Failed to load interactions:', err);
    }
  }

  async function handleAddInteraction(e: React.FormEvent) {
    e.preventDefault();
    if (!newNote.trim() || submitting) return;

    setSubmitting(true);
    try {
      await api.post('/interactions', {
        type: newNoteType,
        content: newNote.trim(),
        person_id: id,
      });
      setNewNote('');
      loadInteractions();
    } catch (err) {
      console.error('Failed to add interaction:', err);
    } finally {
      setSubmitting(false);
    }
  }

  async function searchOrgs(q: string) {
    setRoleOrgSearch(q);
    if (q.trim().length < 2) { setRoleOrgResults([]); return; }
    try {
      const data = await api.get<{ data: Array<{ id: string; name: string; type: string }> }>(`/organisations?search=${encodeURIComponent(q)}&limit=10`);
      setRoleOrgResults(data.data);
    } catch { /* ignore */ }
  }

  async function handleAddRole(e: React.FormEvent) {
    e.preventDefault();
    if (!roleSelectedOrg || !roleTitle.trim() || roleSubmitting) return;
    setRoleSubmitting(true);
    try {
      await api.post(`/people/${id}/roles`, {
        organisation_id: roleSelectedOrg.id,
        role: roleTitle.trim(),
        is_primary: roleIsPrimary,
      });
      setShowAddRole(false);
      setRoleSelectedOrg(null);
      setRoleTitle('');
      setRoleIsPrimary(false);
      setRoleOrgSearch('');
      setRoleOrgResults([]);
      loadPerson();
    } catch (err) {
      console.error('Failed to add role:', err);
    } finally {
      setRoleSubmitting(false);
    }
  }

  async function handleEndRole(roleId: string) {
    try {
      await api.put(`/people/${id}/roles/${roleId}/end`, {});
      loadPerson();
    } catch (err) {
      console.error('Failed to end role:', err);
    }
  }

  async function handleDelete() {
    try {
      await api.delete(`/people/${id}`);
      navigate('/people');
    } catch (err) {
      console.error('Failed to delete person:', err);
    }
  }

  function formatDate(dateStr: string) {
    return new Date(dateStr).toLocaleDateString('en-GB', {
      day: 'numeric', month: 'short', year: 'numeric',
    });
  }

  function formatDateTime(dateStr: string) {
    return new Date(dateStr).toLocaleDateString('en-GB', {
      day: 'numeric', month: 'short', year: 'numeric',
      hour: '2-digit', minute: '2-digit',
    });
  }

  if (loading) {
    return <div className="text-center py-12 text-gray-500">Loading...</div>;
  }

  if (!person) {
    return <div className="text-center py-12 text-gray-500">Person not found.</div>;
  }

  const activeOrgs = person.organisations?.filter(o => o.status === 'active') || [];
  const historicalOrgs = person.organisations?.filter(o => o.status === 'historical') || [];
  const isFreelancer = person.skills && person.skills.length > 0;

  return (
    <div>
      {/* Back link */}
      <Link to="/people" className="text-sm text-ooosh-600 hover:text-ooosh-700 mb-4 inline-block">
        &larr; Back to People
      </Link>

      {/* Header */}
      <div className="bg-white rounded-xl shadow-sm border border-gray-200 p-6 mb-6">
        <div className="flex items-start justify-between">
          <div className="flex items-center gap-4">
            <div className="w-14 h-14 bg-ooosh-100 text-ooosh-700 rounded-full flex items-center justify-center text-xl font-bold">
              {person.first_name[0]}{person.last_name[0]}
            </div>
            <div>
              <h1 className="text-2xl font-bold text-gray-900">
                {person.first_name} {person.last_name}
              </h1>
              <div className="flex flex-wrap gap-2 mt-1">
                {activeOrgs.map((org) => (
                  <Link
                    key={org.id}
                    to={`/organisations/${org.organisation_id}`}
                    className="inline-flex items-center px-2 py-0.5 rounded-full text-xs bg-ooosh-100 text-ooosh-700 hover:bg-ooosh-200 transition-colors"
                  >
                    {org.role} @ {org.organisation_name}
                  </Link>
                ))}
                {activeOrgs.length === 0 && (
                  <span className="text-sm text-gray-400">No current organisation</span>
                )}
              </div>
            </div>
          </div>
          <div className="flex items-center gap-2">
            {isFreelancer && (
              <span className={`inline-flex px-2 py-1 rounded-full text-xs font-medium ${person.is_approved ? 'bg-green-100 text-green-700' : 'bg-amber-100 text-amber-700'}`}>
                {person.is_approved ? 'Approved Freelancer' : 'Pending Approval'}
              </span>
            )}
            <button
              onClick={() => setShowEdit(true)}
              className="px-3 py-1.5 text-sm border border-gray-300 rounded hover:bg-gray-50 transition-colors"
            >
              Edit
            </button>
            <div className="relative">
              <button
                onClick={() => setShowDeleteConfirm(!showDeleteConfirm)}
                className="px-3 py-1.5 text-sm border border-red-200 text-red-600 rounded hover:bg-red-50 transition-colors"
              >
                Delete
              </button>
              {showDeleteConfirm && (
                <div className="absolute right-0 top-full mt-1 bg-white border border-gray-200 rounded shadow-lg p-3 z-10 w-56">
                  <p className="text-sm text-gray-700 mb-2">Delete this person?</p>
                  <div className="flex gap-2">
                    <button onClick={handleDelete} className="flex-1 bg-red-600 text-white px-3 py-1 rounded text-sm hover:bg-red-700">Yes, delete</button>
                    <button onClick={() => setShowDeleteConfirm(false)} className="flex-1 border border-gray-300 px-3 py-1 rounded text-sm hover:bg-gray-50">Cancel</button>
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>

        {/* Contact details row */}
        <div className="mt-4 flex flex-wrap gap-6 text-sm text-gray-600">
          {person.email && (
            <a href={`mailto:${person.email}`} className="hover:text-ooosh-600">
              {person.email}
            </a>
          )}
          {person.mobile && (
            <a href={`tel:${person.mobile}`} className="hover:text-ooosh-600">
              {person.mobile}
            </a>
          )}
          {person.phone && (
            <span>{person.phone}</span>
          )}
          {person.international_phone && (
            <span>{person.international_phone}</span>
          )}
        </div>

        {/* Tags */}
        {person.tags && person.tags.length > 0 && (
          <div className="mt-3 flex flex-wrap gap-1">
            {person.tags.map((tag) => (
              <span key={tag} className="inline-flex px-2 py-0.5 rounded text-xs bg-gray-100 text-gray-600">
                {tag}
              </span>
            ))}
          </div>
        )}
      </div>

      {/* Tabs */}
      <div className="border-b border-gray-200 mb-6">
        <nav className="flex gap-6">
          {(['timeline', 'details', 'relationships'] as const).map((tab) => (
            <button
              key={tab}
              onClick={() => setActiveTab(tab)}
              className={`pb-3 text-sm font-medium border-b-2 transition-colors ${
                activeTab === tab
                  ? 'border-ooosh-600 text-ooosh-600'
                  : 'border-transparent text-gray-500 hover:text-gray-700'
              }`}
            >
              {tab === 'timeline' ? 'Activity Timeline' : tab === 'details' ? 'Details' : 'Relationships'}
            </button>
          ))}
        </nav>
      </div>

      {/* Tab Content */}
      {activeTab === 'timeline' && (
        <div>
          {/* Add interaction form */}
          <form onSubmit={handleAddInteraction} className="bg-white rounded-xl shadow-sm border border-gray-200 p-4 mb-6">
            <div className="flex gap-3 mb-3">
              {(['note', 'call', 'email', 'meeting'] as const).map((t) => (
                <button
                  key={t}
                  type="button"
                  onClick={() => setNewNoteType(t)}
                  className={`px-3 py-1 rounded-full text-xs font-medium transition-colors ${
                    newNoteType === t
                      ? typeColors[t]
                      : 'bg-gray-100 text-gray-500 hover:bg-gray-200'
                  }`}
                >
                  {t.charAt(0).toUpperCase() + t.slice(1)}
                </button>
              ))}
            </div>
            <textarea
              value={newNote}
              onChange={(e) => setNewNote(e.target.value)}
              placeholder={`Add a ${newNoteType}...`}
              rows={3}
              className="w-full rounded border border-gray-300 px-3 py-2 text-sm focus:border-ooosh-500 focus:outline-none focus:ring-1 focus:ring-ooosh-500 resize-none"
            />
            <div className="flex justify-between items-center mt-2">
              <span className="text-xs text-gray-400">
                Posting as {user?.first_name} {user?.last_name}
              </span>
              <button
                type="submit"
                disabled={!newNote.trim() || submitting}
                className="bg-ooosh-600 text-white px-4 py-1.5 rounded text-sm font-medium hover:bg-ooosh-700 transition-colors disabled:opacity-50"
              >
                {submitting ? 'Saving...' : 'Add'}
              </button>
            </div>
          </form>

          {/* Timeline */}
          {interactions.length === 0 ? (
            <p className="text-center text-sm text-gray-400 py-8">No activity yet. Add a note above to get started.</p>
          ) : (
            <div className="space-y-4">
              {interactions.map((interaction) => (
                <div key={interaction.id} className="bg-white rounded-xl shadow-sm border border-gray-200 p-4">
                  <div className="flex items-start gap-3">
                    <div className={`w-8 h-8 rounded-full flex items-center justify-center text-xs font-bold flex-shrink-0 ${typeColors[interaction.type] || 'bg-gray-100 text-gray-600'}`}>
                      {typeIcons[interaction.type] || '?'}
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 text-xs text-gray-500">
                        <span className="font-medium text-gray-700">{interaction.created_by_name || 'System'}</span>
                        <span>logged a {interaction.type}</span>
                        <span>&middot;</span>
                        <span>{formatDateTime(interaction.created_at)}</span>
                      </div>
                      <p className="mt-1 text-sm text-gray-800 whitespace-pre-wrap">{interaction.content}</p>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {activeTab === 'details' && (
        <div className="bg-white rounded-xl shadow-sm border border-gray-200 p-6">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            <DetailField label="Email" value={person.email} />
            <DetailField label="Mobile" value={person.mobile} />
            <DetailField label="Phone" value={person.phone} />
            <DetailField label="International Phone" value={person.international_phone} />
            <DetailField label="Preferred Contact" value={person.preferred_contact_method} />
            <DetailField label="Home Address" value={person.home_address} />
            <DetailField label="Date of Birth" value={person.date_of_birth ? formatDate(person.date_of_birth) : null} />
            <DetailField label="Member Since" value={formatDate(person.created_at)} />

            {isFreelancer && (
              <>
                <div className="col-span-full border-t pt-4 mt-2">
                  <h3 className="text-sm font-semibold text-gray-700 mb-3">Freelancer Details</h3>
                </div>
                <DetailField label="Skills" value={person.skills?.join(', ')} />
                <DetailField label="Licence" value={person.licence_details} />
                <DetailField label="Insured on Vehicles" value={person.is_insured_on_vehicles ? 'Yes' : 'No'} />
                <DetailField label="Has T-Shirt" value={person.has_tshirt ? 'Yes' : 'No'} />
                <DetailField label="Emergency Contact" value={person.emergency_contact_name} />
                <DetailField label="Emergency Phone" value={person.emergency_contact_phone} />
              </>
            )}
          </div>

          {person.notes && (
            <div className="mt-6 pt-4 border-t">
              <h3 className="text-sm font-semibold text-gray-700 mb-2">Notes</h3>
              <p className="text-sm text-gray-600 whitespace-pre-wrap">{person.notes}</p>
            </div>
          )}

          <div className="mt-6 pt-4 border-t">
            <FileUpload
              entityType="people"
              entityId={person.id}
              files={person.files || []}
              onFilesChanged={(files) => setPerson(prev => prev ? { ...prev, files } : prev)}
              onActivityCreated={loadInteractions}
            />
          </div>
        </div>
      )}

      {activeTab === 'relationships' && (
        <div className="space-y-6">
          {/* Add relationship button/form */}
          {!showAddRole ? (
            <button
              onClick={() => setShowAddRole(true)}
              className="bg-ooosh-600 text-white px-4 py-2 rounded text-sm font-medium hover:bg-ooosh-700 transition-colors"
            >
              Add Relationship
            </button>
          ) : (
            <form onSubmit={handleAddRole} className="bg-white rounded-xl shadow-sm border border-gray-200 p-4">
              <h3 className="text-sm font-semibold text-gray-700 mb-3">Link to Organisation</h3>
              {/* Org search */}
              {!roleSelectedOrg ? (
                <div className="relative">
                  <input
                    value={roleOrgSearch}
                    onChange={e => searchOrgs(e.target.value)}
                    placeholder="Search for an organisation..."
                    autoFocus
                    className="w-full rounded border border-gray-300 px-3 py-2 text-sm focus:border-ooosh-500 focus:outline-none focus:ring-1 focus:ring-ooosh-500"
                  />
                  {roleOrgResults.length > 0 && (
                    <div className="absolute top-full left-0 right-0 mt-1 bg-white border border-gray-200 rounded shadow-lg max-h-48 overflow-y-auto z-10">
                      {roleOrgResults.map(org => (
                        <button
                          key={org.id}
                          type="button"
                          onClick={() => { setRoleSelectedOrg({ id: org.id, name: org.name }); setRoleOrgResults([]); }}
                          className="w-full text-left px-3 py-2 text-sm hover:bg-gray-50 flex items-center gap-2"
                        >
                          <span className="font-medium">{org.name}</span>
                          <span className="text-xs text-gray-400">{org.type}</span>
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              ) : (
                <div className="flex items-center gap-2 mb-3">
                  <span className="text-sm font-medium text-gray-900 bg-ooosh-50 px-2 py-1 rounded">{roleSelectedOrg.name}</span>
                  <button type="button" onClick={() => { setRoleSelectedOrg(null); setRoleOrgSearch(''); }} className="text-xs text-gray-400 hover:text-gray-600">Change</button>
                </div>
              )}

              {roleSelectedOrg && (
                <>
                  <div className="mt-3">
                    <label className="block text-xs font-medium text-gray-500 uppercase mb-1">Role / Title</label>
                    <input
                      value={roleTitle}
                      onChange={e => setRoleTitle(e.target.value)}
                      placeholder="e.g. Tour Manager, Lead Vocalist, Account Manager"
                      className="w-full rounded border border-gray-300 px-3 py-2 text-sm focus:border-ooosh-500 focus:outline-none focus:ring-1 focus:ring-ooosh-500"
                    />
                  </div>
                  <label className="flex items-center gap-2 mt-3 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={roleIsPrimary}
                      onChange={e => setRoleIsPrimary(e.target.checked)}
                      className="rounded border-gray-300 text-ooosh-600 focus:ring-ooosh-500"
                    />
                    <span className="text-sm text-gray-700">Primary organisation</span>
                  </label>
                  <div className="flex gap-2 mt-4">
                    <button
                      type="submit"
                      disabled={!roleTitle.trim() || roleSubmitting}
                      className="bg-ooosh-600 text-white px-4 py-1.5 rounded text-sm font-medium hover:bg-ooosh-700 transition-colors disabled:opacity-50"
                    >
                      {roleSubmitting ? 'Saving...' : 'Add Role'}
                    </button>
                    <button type="button" onClick={() => { setShowAddRole(false); setRoleSelectedOrg(null); setRoleOrgSearch(''); }} className="px-4 py-1.5 text-sm border border-gray-300 rounded hover:bg-gray-50">Cancel</button>
                  </div>
                </>
              )}
            </form>
          )}

          {activeOrgs.length > 0 && (
            <div>
              <h3 className="text-sm font-semibold text-gray-700 mb-3">Current</h3>
              <div className="space-y-2">
                {activeOrgs.map((org) => (
                  <div
                    key={org.id}
                    className="bg-white rounded-xl shadow-sm border border-gray-200 p-4 flex items-center justify-between"
                  >
                    <Link to={`/organisations/${org.organisation_id}`} className="flex-1 hover:text-ooosh-600">
                      <span className="font-medium text-gray-900">{org.organisation_name}</span>
                      <span className="ml-2 text-sm text-gray-500">{org.role}</span>
                      {org.is_primary && (
                        <span className="ml-2 text-xs bg-ooosh-100 text-ooosh-700 px-2 py-0.5 rounded-full">Primary</span>
                      )}
                    </Link>
                    <div className="flex items-center gap-2">
                      {org.start_date && (
                        <span className="text-xs text-gray-400">Since {formatDate(org.start_date)}</span>
                      )}
                      <button
                        onClick={() => handleEndRole(org.id)}
                        className="text-xs text-red-500 hover:text-red-700 px-2 py-1 border border-red-200 rounded hover:bg-red-50"
                      >
                        End
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {historicalOrgs.length > 0 && (
            <div>
              <h3 className="text-sm font-semibold text-gray-700 mb-3">Historical</h3>
              <div className="space-y-2">
                {historicalOrgs.map((org) => (
                  <Link
                    key={org.id}
                    to={`/organisations/${org.organisation_id}`}
                    className="block bg-white rounded-xl shadow-sm border border-gray-200 p-4 opacity-60 hover:opacity-100 transition-all"
                  >
                    <div className="flex items-center justify-between">
                      <div>
                        <span className="font-medium text-gray-900">{org.organisation_name}</span>
                        <span className="ml-2 text-sm text-gray-500">{org.role}</span>
                      </div>
                      <span className="text-xs text-gray-400">
                        {org.start_date && formatDate(org.start_date)}
                        {org.end_date && ` — ${formatDate(org.end_date)}`}
                      </span>
                    </div>
                  </Link>
                ))}
              </div>
            </div>
          )}

          {!person.organisations?.length && !showAddRole && (
            <p className="text-center text-sm text-gray-400 py-8">No organisation relationships.</p>
          )}
        </div>
      )}

      {/* Edit Panel */}
      <SlidePanel open={showEdit} onClose={() => setShowEdit(false)} title="Edit Person">
        <PersonForm
          personId={id}
          onSaved={() => { setShowEdit(false); loadPerson(); }}
          onCancel={() => setShowEdit(false)}
        />
      </SlidePanel>
    </div>
  );
}

function DetailField({ label, value }: { label: string; value: string | null | undefined }) {
  return (
    <div>
      <dt className="text-xs font-medium text-gray-500 uppercase tracking-wider">{label}</dt>
      <dd className="mt-1 text-sm text-gray-900">{value || '—'}</dd>
    </div>
  );
}
