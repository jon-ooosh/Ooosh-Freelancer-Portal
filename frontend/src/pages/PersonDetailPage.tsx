import { useState, useEffect, useRef } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import { api } from '../services/api';
import SlidePanel from '../components/SlidePanel';
import PersonForm from '../components/PersonForm';
import FileUpload from '../components/FileUpload';
import ActivityTimeline from '../components/ActivityTimeline';

interface FileAttachment {
  name: string;
  label?: string;
  url: string;
  type: 'document' | 'image' | 'other';
  uploaded_at: string;
  uploaded_by: string;
}

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
  is_freelancer: boolean;
  freelancer_joined_date: string | null;
  freelancer_next_review_date: string | null;
  skills: string[];
  is_insured_on_vehicles: boolean;
  is_approved: boolean;
  has_tshirt: boolean;
  emergency_contact_name: string | null;
  emergency_contact_phone: string | null;
  licence_details: string | null;
  freelancer_references: string | null;
  files: FileAttachment[];
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
  mentioned_user_ids: string[];
}

export default function PersonDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();

  const [person, setPerson] = useState<PersonDetail | null>(null);
  const [interactions, setInteractions] = useState<Interaction[]>([]);
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState<'timeline' | 'details' | 'relationships'>('timeline');

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

  if (loading) {
    return <div className="text-center py-12 text-gray-500">Loading...</div>;
  }

  if (!person) {
    return <div className="text-center py-12 text-gray-500">Person not found.</div>;
  }

  const activeOrgs = person.organisations?.filter(o => o.status === 'active') || [];
  const historicalOrgs = person.organisations?.filter(o => o.status === 'historical') || [];
  const isFreelancer = person.is_freelancer;

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
      {activeTab === 'timeline' && id && (
        <ActivityTimeline
          entityType="person_id"
          entityId={id}
          interactions={interactions}
          onInteractionAdded={loadInteractions}
        />
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
                <DetailField label="Joined Date" value={person.freelancer_joined_date ? formatDate(person.freelancer_joined_date) : null} />
                <DetailField label="Next Review Date" value={person.freelancer_next_review_date ? formatDate(person.freelancer_next_review_date) : null} />
                <DetailField label="Skills" value={person.skills?.join(', ')} />
                <DetailField label="Licence" value={person.licence_details} />
                <DetailField label="Insured on Vehicles" value={person.is_insured_on_vehicles ? 'Yes' : 'No'} />
                <DetailField label="Approved" value={person.is_approved ? 'Yes' : 'No'} />
                <DetailField label="Has T-Shirt" value={person.has_tshirt ? 'Yes' : 'No'} />
                <DetailField label="Emergency Contact" value={person.emergency_contact_name} />
                <DetailField label="Emergency Phone" value={person.emergency_contact_phone} />
                {person.freelancer_references && (
                  <div className="col-span-full">
                    <DetailField label="References" value={person.freelancer_references} />
                  </div>
                )}
              </>
            )}
          </div>

          {person.notes && (
            <div className="mt-6 pt-4 border-t">
              <h3 className="text-sm font-semibold text-gray-700 mb-2">Notes</h3>
              <p className="text-sm text-gray-600 whitespace-pre-wrap">{person.notes}</p>
            </div>
          )}

          {isFreelancer && (
            <div className="mt-6 pt-4 border-t">
              <FreelancerDocuments
                personId={person.id}
                files={person.files || []}
                onFilesChanged={(files) => setPerson(prev => prev ? { ...prev, files } : prev)}
                onActivityCreated={loadInteractions}
              />
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

const REQUIRED_DOCS = [
  { label: 'DVLA Check', description: 'DVLA licence check result' },
  { label: 'Licence Front', description: 'Front of driving licence' },
  { label: 'Licence Back', description: 'Back of driving licence' },
  { label: 'Passport', description: 'Passport photo page' },
];

function FreelancerDocuments({ personId, files, onFilesChanged, onActivityCreated }: {
  personId: string;
  files: FileAttachment[];
  onFilesChanged: (files: FileAttachment[]) => void;
  onActivityCreated: () => void;
}) {
  const [uploading, setUploading] = useState<string | null>(null);
  const [error, setError] = useState('');
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [uploadingLabel, setUploadingLabel] = useState('');

  function getDocFile(docLabel: string): FileAttachment | undefined {
    return files.find(f => f.label?.toLowerCase() === docLabel.toLowerCase());
  }

  function handleUploadClick(docLabel: string) {
    setUploadingLabel(docLabel);
    fileInputRef.current?.click();
  }

  async function handleFileSelected(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file || !uploadingLabel) return;
    if (fileInputRef.current) fileInputRef.current.value = '';

    setUploading(uploadingLabel);
    setError('');
    try {
      const formData = new FormData();
      formData.append('file', file);
      formData.append('entity_type', 'people');
      formData.append('entity_id', personId);
      formData.append('label', uploadingLabel);

      const result = await api.upload<FileAttachment>('/files/upload', formData);
      onFilesChanged([...files, result]);
      onActivityCreated();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Upload failed');
    } finally {
      setUploading(null);
      setUploadingLabel('');
    }
  }

  async function handleReplace(docLabel: string, existingFile: FileAttachment) {
    // Delete old then upload new
    try {
      await api.deleteWithBody('/files/delete', {
        key: existingFile.url,
        entity_type: 'people',
        entity_id: personId,
      });
      onFilesChanged(files.filter(f => f.url !== existingFile.url));
      onActivityCreated();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Delete failed');
      return;
    }
    handleUploadClick(docLabel);
  }

  function handleDownload(file: FileAttachment) {
    window.open(`/api/files/download?key=${encodeURIComponent(file.url)}`, '_blank');
  }

  function formatDate(dateStr: string) {
    return new Date(dateStr).toLocaleDateString('en-GB', {
      day: 'numeric', month: 'short', year: 'numeric',
    });
  }

  const presentCount = REQUIRED_DOCS.filter(d => getDocFile(d.label)).length;

  return (
    <div>
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-sm font-semibold text-gray-700">Required Documents</h3>
        <span className={`text-xs font-medium px-2 py-0.5 rounded-full ${
          presentCount === REQUIRED_DOCS.length
            ? 'bg-green-100 text-green-700'
            : 'bg-amber-100 text-amber-700'
        }`}>
          {presentCount}/{REQUIRED_DOCS.length} uploaded
        </span>
      </div>

      {error && (
        <div className="bg-red-50 text-red-700 px-3 py-1.5 rounded text-xs mb-2">{error}</div>
      )}

      <input
        ref={fileInputRef}
        type="file"
        onChange={handleFileSelected}
        className="hidden"
        accept=".pdf,.jpg,.jpeg,.png,.gif,.webp"
      />

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
        {REQUIRED_DOCS.map((doc) => {
          const file = getDocFile(doc.label);
          const isUploading = uploading === doc.label;

          return (
            <div
              key={doc.label}
              className={`flex items-center gap-3 p-3 rounded-lg border ${
                file
                  ? 'border-green-200 bg-green-50'
                  : 'border-amber-200 bg-amber-50'
              }`}
            >
              {/* Status icon */}
              {file ? (
                <svg className="w-5 h-5 text-green-600 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
                </svg>
              ) : (
                <svg className="w-5 h-5 text-amber-500 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4.5c-.77-.833-2.694-.833-3.464 0L3.34 16.5c-.77.833.192 2.5 1.732 2.5z" />
                </svg>
              )}

              {/* Info */}
              <div className="flex-1 min-w-0">
                <p className={`text-sm font-medium ${file ? 'text-green-800' : 'text-amber-800'}`}>
                  {doc.label}
                </p>
                {file ? (
                  <p className="text-xs text-green-600 truncate">
                    Uploaded {formatDate(file.uploaded_at)}
                  </p>
                ) : (
                  <p className="text-xs text-amber-600">Missing</p>
                )}
              </div>

              {/* Actions */}
              <div className="flex items-center gap-1 flex-shrink-0">
                {file ? (
                  <>
                    <button
                      type="button"
                      onClick={() => handleDownload(file)}
                      className="p-1 text-green-600 hover:text-green-800 rounded hover:bg-green-100"
                      title="View / Download"
                    >
                      <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" />
                      </svg>
                    </button>
                    <button
                      type="button"
                      onClick={() => handleReplace(doc.label, file)}
                      className="p-1 text-gray-400 hover:text-gray-600 rounded hover:bg-gray-100"
                      title="Replace"
                    >
                      <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                      </svg>
                    </button>
                  </>
                ) : (
                  <button
                    type="button"
                    onClick={() => handleUploadClick(doc.label)}
                    disabled={isUploading}
                    className="inline-flex items-center gap-1 px-2 py-1 text-xs font-medium text-amber-700 bg-amber-100 rounded hover:bg-amber-200 disabled:opacity-50"
                  >
                    {isUploading ? (
                      <svg className="w-3 h-3 animate-spin" fill="none" viewBox="0 0 24 24">
                        <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                        <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                      </svg>
                    ) : (
                      <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12" />
                      </svg>
                    )}
                    Upload
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </div>
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
