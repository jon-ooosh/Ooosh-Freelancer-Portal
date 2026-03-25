import { useState, useEffect } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import { api } from '../services/api';
import SlidePanel from '../components/SlidePanel';
import OrganisationForm from '../components/OrganisationForm';
import FileUpload from '../components/FileUpload';
import ActivityTimeline from '../components/ActivityTimeline';
import { ORG_RELATIONSHIP_LABELS, type OrgRelationshipType, type OrganisationRelationship } from '../../../shared/types';
import { useAuthStore } from '../hooks/useAuthStore';

interface OrgDetail {
  id: string;
  name: string;
  type: string;
  website: string | null;
  email: string | null;
  phone: string | null;
  address: string | null;
  location: string | null;
  notes: string | null;
  tags: string[];
  files: Array<{ name: string; url: string; type: 'document' | 'image' | 'other'; uploaded_at: string; uploaded_by: string }>;
  parent_name: string | null;
  parent_id: string | null;
  do_not_hire: boolean;
  do_not_hire_reason: string | null;
  do_not_hire_set_at: string | null;
  do_not_hire_set_by: string | null;
  working_terms_type: string | null;
  working_terms_credit_days: number | null;
  working_terms_notes: string | null;
  ai_summary: string | null;
  ai_research: string | null;
  created_at: string;
  people: Array<{
    id: string;
    person_id: string;
    person_name: string;
    person_email: string | null;
    role: string;
    status: string;
    is_primary: boolean;
    start_date: string | null;
    end_date: string | null;
  }> | null;
  subsidiaries: Array<{
    id: string;
    name: string;
    type: string;
  }> | null;
  relationships: OrganisationRelationship[];
  linked_jobs: Array<{
    id: string;
    job_id: string;
    role: string;
    job_name: string | null;
    hh_job_number: number | null;
    pipeline_status: string;
    job_date: string | null;
    return_date: string | null;
    job_value: number | null;
  }>;
}

interface Interaction {
  id: string;
  type: string;
  content: string;
  created_at: string;
  created_by_name: string | null;
  mentioned_user_ids: string[];
}

const typeColors: Record<string, string> = {
  band: 'bg-purple-100 text-purple-700',
  management: 'bg-blue-100 text-blue-700',
  label: 'bg-green-100 text-green-700',
  agency: 'bg-amber-100 text-amber-700',
  promoter: 'bg-red-100 text-red-700',
  venue: 'bg-teal-100 text-teal-700',
  festival: 'bg-pink-100 text-pink-700',
  supplier: 'bg-gray-100 text-gray-700',
};

export default function OrganisationDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const user = useAuthStore((s) => s.user);
  const isAdmin = user?.role === 'admin' || user?.role === 'manager';

  const [org, setOrg] = useState<OrgDetail | null>(null);
  const [dnoReason, setDnoReason] = useState('');
  const [showDnoForm, setShowDnoForm] = useState(false);
  const [interactions, setInteractions] = useState<Interaction[]>([]);
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState<'people' | 'relationships' | 'timeline' | 'details'>('people');

  // Edit/delete
  const [showEdit, setShowEdit] = useState(false);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);

  // Add relationship
  const [showAddRelationship, setShowAddRelationship] = useState(false);
  const [relOrgSearch, setRelOrgSearch] = useState('');
  const [relOrgResults, setRelOrgResults] = useState<Array<{ id: string; name: string; type: string }>>([]);
  const [relSelectedOrg, setRelSelectedOrg] = useState<{ id: string; name: string; type: string } | null>(null);
  const [relType, setRelType] = useState<OrgRelationshipType>('manages');
  const [relDirection, setRelDirection] = useState<'forward' | 'reverse'>('forward');
  const [relSaving, setRelSaving] = useState(false);

  useEffect(() => {
    if (id) {
      loadOrg();
      loadInteractions();
    }
  }, [id]);

  async function loadOrg() {
    try {
      const data = await api.get<OrgDetail>(`/organisations/${id}`);
      setOrg(data);
    } catch {
      navigate('/organisations');
    } finally {
      setLoading(false);
    }
  }

  async function loadInteractions() {
    try {
      const data = await api.get<{ data: Interaction[] }>(`/interactions?organisation_id=${id}`);
      setInteractions(data.data);
    } catch (err) {
      console.error('Failed to load interactions:', err);
    }
  }

  async function handleDelete() {
    try {
      await api.delete(`/organisations/${id}`);
      navigate('/organisations');
    } catch (err) {
      console.error('Failed to delete organisation:', err);
    }
  }

  // Search orgs for relationship picker
  useEffect(() => {
    if (relOrgSearch.length < 2) { setRelOrgResults([]); return; }
    const timeout = setTimeout(async () => {
      try {
        const data = await api.get<{ data: Array<{ id: string; name: string; type: string }> }>(
          `/organisations?search=${encodeURIComponent(relOrgSearch)}&limit=10`
        );
        setRelOrgResults(data.data.filter(o => o.id !== id));
      } catch { /* ignore */ }
    }, 250);
    return () => clearTimeout(timeout);
  }, [relOrgSearch, id]);

  async function handleAddRelationship() {
    if (!relSelectedOrg || !id) return;
    setRelSaving(true);
    try {
      const from_org_id = relDirection === 'forward' ? id : relSelectedOrg.id;
      const to_org_id = relDirection === 'forward' ? relSelectedOrg.id : id;
      await api.post(`/organisations/${id}/relationships`, {
        from_org_id,
        to_org_id,
        relationship_type: relType,
      });
      setShowAddRelationship(false);
      setRelSelectedOrg(null);
      setRelOrgSearch('');
      loadOrg();
    } catch (err: any) {
      alert(err?.response?.data?.error || 'Failed to add relationship');
    } finally {
      setRelSaving(false);
    }
  }

  async function handleDeleteRelationship(relId: string) {
    if (!confirm('Remove this relationship?')) return;
    try {
      await api.delete(`/organisations/${id}/relationships/${relId}`);
      loadOrg();
    } catch (err) {
      console.error('Failed to delete relationship:', err);
    }
  }

  // Get display text for a relationship from this org's perspective
  function getRelationshipDisplay(rel: OrganisationRelationship) {
    const isFrom = rel.from_org_id === id;
    const labels = ORG_RELATIONSHIP_LABELS[rel.relationship_type as OrgRelationshipType];
    const label = isFrom ? labels?.forward : labels?.reverse;
    const linkedOrg = isFrom
      ? { id: rel.to_org_id, name: rel.to_org_name!, type: rel.to_org_type! }
      : { id: rel.from_org_id, name: rel.from_org_name!, type: rel.from_org_type! };
    return { label: label || rel.relationship_type, linkedOrg };
  }

  function formatDate(dateStr: string) {
    return new Date(dateStr).toLocaleDateString('en-GB', {
      day: 'numeric', month: 'short', year: 'numeric',
    });
  }

  if (loading) return <div className="text-center py-12 text-gray-500">Loading...</div>;
  if (!org) return <div className="text-center py-12 text-gray-500">Organisation not found.</div>;

  const activePeople = org.people?.filter(p => p.status === 'active') || [];
  const historicalPeople = org.people?.filter(p => p.status === 'historical') || [];

  return (
    <div>
      <Link to="/organisations" className="text-sm text-ooosh-600 hover:text-ooosh-700 mb-4 inline-block">
        &larr; Back to Organisations
      </Link>

      {/* Header */}
      <div className="bg-white rounded-xl shadow-sm border border-gray-200 p-6 mb-6">
        <div className="flex items-start justify-between">
          <div>
            <div className="flex items-center gap-3">
              <h1 className="text-2xl font-bold text-gray-900">{org.name}</h1>
              <span className={`inline-flex px-2 py-0.5 rounded-full text-xs font-medium ${typeColors[org.type] || 'bg-gray-100 text-gray-700'}`}>
                {org.type}
              </span>
            </div>
            {org.parent_name && org.parent_id && (
              <p className="mt-1 text-sm text-gray-500">
                Part of <Link to={`/organisations/${org.parent_id}`} className="text-ooosh-600 hover:text-ooosh-700">{org.parent_name}</Link>
              </p>
            )}
          </div>
          <div className="flex items-center gap-2">
            <span className="text-sm text-gray-500 mr-2">
              {activePeople.length} active {activePeople.length === 1 ? 'person' : 'people'}
            </span>
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
                  <p className="text-sm text-gray-700 mb-2">Delete this organisation?</p>
                  <div className="flex gap-2">
                    <button onClick={handleDelete} className="flex-1 bg-red-600 text-white px-3 py-1 rounded text-sm hover:bg-red-700">Yes, delete</button>
                    <button onClick={() => setShowDeleteConfirm(false)} className="flex-1 border border-gray-300 px-3 py-1 rounded text-sm hover:bg-gray-50">Cancel</button>
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>

        <div className="mt-4 flex flex-wrap gap-6 text-sm text-gray-600">
          {org.email && <a href={`mailto:${org.email}`} className="hover:text-ooosh-600">{org.email}</a>}
          {org.phone && <span>{org.phone}</span>}
          {org.website && <a href={org.website} target="_blank" rel="noopener noreferrer" className="text-ooosh-600 hover:text-ooosh-700">{org.website}</a>}
          {org.location && <span>{org.location}</span>}
        </div>

        {org.tags && org.tags.length > 0 && (
          <div className="mt-3 flex flex-wrap gap-1">
            {org.tags.map((tag) => (
              <span key={tag} className="inline-flex px-2 py-0.5 rounded text-xs bg-gray-100 text-gray-600">{tag}</span>
            ))}
          </div>
        )}
      </div>

      {/* Do Not Hire Banner */}
      {org.do_not_hire && (
        <div className="mb-4 bg-red-50 border border-red-200 rounded-lg px-4 py-3 flex items-center justify-between">
          <div>
            <p className="text-sm font-semibold text-red-800">DO NOT HIRE</p>
            {org.do_not_hire_reason && <p className="text-sm text-red-600 mt-0.5">{org.do_not_hire_reason}</p>}
            {org.do_not_hire_set_by && <p className="text-xs text-red-400 mt-0.5">Set by {org.do_not_hire_set_by}</p>}
          </div>
          {isAdmin && (
            <button
              onClick={async () => {
                await api.post(`/organisations/${id}/do-not-hire`, { do_not_hire: false });
                loadOrg();
              }}
              className="text-xs px-3 py-1.5 bg-red-100 text-red-700 rounded hover:bg-red-200"
            >
              Lift restriction
            </button>
          )}
        </div>
      )}
      {!org.do_not_hire && isAdmin && (
        <div className="mb-4">
          {showDnoForm ? (
            <div className="bg-gray-50 border border-gray-200 rounded-lg px-4 py-3 flex items-center gap-3">
              <input
                value={dnoReason}
                onChange={e => setDnoReason(e.target.value)}
                placeholder="Reason (optional)..."
                className="flex-1 rounded border border-gray-300 px-3 py-1.5 text-sm"
              />
              <button
                onClick={async () => {
                  await api.post(`/organisations/${id}/do-not-hire`, { do_not_hire: true, reason: dnoReason || null });
                  setShowDnoForm(false);
                  setDnoReason('');
                  loadOrg();
                }}
                className="text-xs px-3 py-1.5 bg-red-600 text-white rounded hover:bg-red-700"
              >
                Confirm
              </button>
              <button onClick={() => { setShowDnoForm(false); setDnoReason(''); }} className="text-xs px-3 py-1.5 border border-gray-300 rounded hover:bg-gray-50">Cancel</button>
            </div>
          ) : (
            <button
              onClick={() => setShowDnoForm(true)}
              className="text-xs px-3 py-1.5 border border-red-200 text-red-600 rounded hover:bg-red-50"
            >
              Flag as Do Not Hire
            </button>
          )}
        </div>
      )}

      {/* Smart suggestions */}
      {(() => {
        const suggestions: Array<{ text: string; action: string; newType: string }> = [];
        const type = org.type?.toLowerCase() || '';
        const name = org.name || '';
        const companyWords = ['ltd', 'limited', 'group', 'management', 'agency', 'inc', 'llc', 'plc', 'services', 'productions', 'consulting'];
        const looksLikeCompany = companyWords.some(w => name.toLowerCase().includes(w));
        const hasJobsAsBand = (org.linked_jobs || []).some(j => j.role === 'band');
        const peopleCount = (org.people || []).length;

        // Suggest band if typed as client/unknown but linked as band in jobs
        if ((type === 'client' || type === 'unknown') && hasJobsAsBand) {
          suggestions.push({ text: `This is typed as "${type}" but appears as a band on ${(org.linked_jobs || []).filter(j => j.role === 'band').length} job(s). Should it be a band?`, action: 'Change to Band', newType: 'band' });
        }
        // Suggest band if typed as client/unknown, no company-like words, and few/no people
        if ((type === 'client' || type === 'unknown') && !looksLikeCompany && peopleCount <= 1 && !hasJobsAsBand) {
          suggestions.push({ text: `"${name}" is typed as "${type}" — could this be a band or artist?`, action: 'Change to Band', newType: 'band' });
        }
        // Suggest management if typed as client but has "management" in name
        if (type === 'client' && name.toLowerCase().includes('management')) {
          suggestions.push({ text: `"${name}" is typed as "client" but looks like a management company.`, action: 'Change to Management', newType: 'management' });
        }

        if (suggestions.length === 0) return null;
        return (
          <div className="mb-4 space-y-2">
            {suggestions.map((s, i) => (
              <div key={i} className="bg-amber-50 border border-amber-200 rounded-lg px-4 py-3 flex items-center justify-between">
                <p className="text-sm text-amber-800">{s.text}</p>
                <button
                  onClick={async () => {
                    try {
                      await api.put(`/organisations/${id}`, { type: s.newType });
                      loadOrg();
                    } catch (err) { console.error(err); }
                  }}
                  className="ml-4 flex-shrink-0 text-xs font-medium px-3 py-1.5 bg-amber-100 text-amber-700 rounded hover:bg-amber-200"
                >
                  {s.action}
                </button>
              </div>
            ))}
          </div>
        );
      })()}

      {/* Tabs */}
      <div className="border-b border-gray-200 mb-6">
        <nav className="flex gap-6">
          {(['people', 'relationships', 'timeline', 'details'] as const).map((tab) => {
            const relCount = (org.relationships || []).filter(r => r.status === 'active').length;
            const label = tab === 'people' ? `People (${(org.people || []).length})`
              : tab === 'relationships' ? `Relationships${relCount ? ` (${relCount})` : ''}`
              : tab === 'timeline' ? 'Activity Timeline'
              : 'Details';
            return (
              <button
                key={tab}
                onClick={() => setActiveTab(tab)}
                className={`pb-3 text-sm font-medium border-b-2 transition-colors ${
                  activeTab === tab
                    ? 'border-ooosh-600 text-ooosh-600'
                    : 'border-transparent text-gray-500 hover:text-gray-700'
                }`}
              >
                {label}
              </button>
            );
          })}
        </nav>
      </div>

      {activeTab === 'people' && (
        <div className="space-y-6">
          {activePeople.length > 0 && (
            <div>
              <h3 className="text-sm font-semibold text-gray-700 mb-3">Current</h3>
              <div className="bg-white rounded-xl shadow-sm border border-gray-200 overflow-hidden">
                <table className="min-w-full divide-y divide-gray-200">
                  <thead className="bg-gray-50">
                    <tr>
                      <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Name</th>
                      <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Role</th>
                      <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Since</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-200">
                    {activePeople.map((p) => (
                      <tr key={p.id} className="hover:bg-gray-50">
                        <td className="px-6 py-4">
                          <Link to={`/people/${p.person_id}`} className="text-sm font-medium text-ooosh-600 hover:text-ooosh-700">
                            {p.person_name}
                          </Link>
                          {p.person_email && (
                            <p className="text-xs text-gray-400">{p.person_email}</p>
                          )}
                        </td>
                        <td className="px-6 py-4">
                          <span className="text-sm text-gray-700">{p.role}</span>
                          {p.is_primary && (
                            <span className="ml-2 text-xs bg-ooosh-100 text-ooosh-700 px-1.5 py-0.5 rounded-full">Primary</span>
                          )}
                        </td>
                        <td className="px-6 py-4 text-sm text-gray-500">
                          {p.start_date ? formatDate(p.start_date) : '—'}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {historicalPeople.length > 0 && (
            <div>
              <h3 className="text-sm font-semibold text-gray-700 mb-3">Historical</h3>
              <div className="bg-white rounded-xl shadow-sm border border-gray-200 overflow-hidden opacity-60">
                <table className="min-w-full divide-y divide-gray-200">
                  <tbody className="divide-y divide-gray-200">
                    {historicalPeople.map((p) => (
                      <tr key={p.id} className="hover:bg-gray-50">
                        <td className="px-6 py-3">
                          <Link to={`/people/${p.person_id}`} className="text-sm text-ooosh-600 hover:text-ooosh-700">
                            {p.person_name}
                          </Link>
                        </td>
                        <td className="px-6 py-3 text-sm text-gray-500">{p.role}</td>
                        <td className="px-6 py-3 text-xs text-gray-400">
                          {p.start_date && formatDate(p.start_date)}
                          {p.end_date && ` — ${formatDate(p.end_date)}`}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {!org.people?.length && (
            <p className="text-center text-sm text-gray-400 py-8">No people associated with this organisation.</p>
          )}

          {org.subsidiaries && org.subsidiaries.length > 0 && (
            <div>
              <h3 className="text-sm font-semibold text-gray-700 mb-3">Subsidiaries</h3>
              <div className="space-y-2">
                {org.subsidiaries.map((sub) => (
                  <Link
                    key={sub.id}
                    to={`/organisations/${sub.id}`}
                    className="block bg-white rounded-xl shadow-sm border border-gray-200 p-4 hover:border-ooosh-300 transition-colors"
                  >
                    <span className="font-medium text-gray-900">{sub.name}</span>
                    <span className={`ml-2 inline-flex px-2 py-0.5 rounded-full text-xs ${typeColors[sub.type] || 'bg-gray-100 text-gray-700'}`}>
                      {sub.type}
                    </span>
                  </Link>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {activeTab === 'relationships' && (
        <div className="space-y-6">
          {/* Add relationship button */}
          <div className="flex justify-end">
            <button
              onClick={() => { setShowAddRelationship(true); setRelSelectedOrg(null); setRelOrgSearch(''); }}
              className="px-3 py-1.5 text-sm bg-ooosh-600 text-white rounded hover:bg-ooosh-700 transition-colors"
            >
              + Add Relationship
            </button>
          </div>

          {/* Active relationships */}
          {(() => {
            const activeRels = (org.relationships || []).filter(r => r.status === 'active');
            const historicalRels = (org.relationships || []).filter(r => r.status === 'historical');
            return (
              <>
                {activeRels.length > 0 ? (
                  <div className="bg-white rounded-xl shadow-sm border border-gray-200 divide-y divide-gray-100">
                    {activeRels.map((rel) => {
                      const { label, linkedOrg } = getRelationshipDisplay(rel);
                      return (
                        <div key={rel.id} className="px-6 py-4 flex items-center justify-between">
                          <div className="flex items-center gap-3">
                            <span className="text-sm text-gray-500 w-36">{label}</span>
                            <Link
                              to={`/organisations/${linkedOrg.id}`}
                              className="text-sm font-medium text-ooosh-600 hover:text-ooosh-700"
                            >
                              {linkedOrg.name}
                            </Link>
                            <span className={`inline-flex px-2 py-0.5 rounded-full text-xs font-medium ${typeColors[linkedOrg.type] || 'bg-gray-100 text-gray-700'}`}>
                              {linkedOrg.type}
                            </span>
                          </div>
                          <button
                            onClick={() => handleDeleteRelationship(rel.id)}
                            className="text-xs text-gray-400 hover:text-red-500 transition-colors"
                          >
                            Remove
                          </button>
                        </div>
                      );
                    })}
                  </div>
                ) : (
                  <p className="text-center text-sm text-gray-400 py-8">
                    No relationships yet. Add one to link this organisation to bands, management companies, labels, etc.
                  </p>
                )}

                {historicalRels.length > 0 && (
                  <div>
                    <h3 className="text-sm font-semibold text-gray-500 mb-3">Historical</h3>
                    <div className="bg-white rounded-xl shadow-sm border border-gray-200 divide-y divide-gray-100 opacity-60">
                      {historicalRels.map((rel) => {
                        const { label, linkedOrg } = getRelationshipDisplay(rel);
                        return (
                          <div key={rel.id} className="px-6 py-3 flex items-center gap-3">
                            <span className="text-sm text-gray-500 w-36">{label}</span>
                            <Link to={`/organisations/${linkedOrg.id}`} className="text-sm text-ooosh-600 hover:text-ooosh-700">
                              {linkedOrg.name}
                            </Link>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                )}
              </>
            );
          })()}

          {/* Linked jobs */}
          {org.linked_jobs && org.linked_jobs.length > 0 && (
            <div>
              <h3 className="text-sm font-semibold text-gray-700 mb-3">Jobs linked as {org.type === 'band' ? 'band' : 'organisation'}</h3>
              <div className="bg-white rounded-xl shadow-sm border border-gray-200 overflow-hidden">
                <table className="min-w-full divide-y divide-gray-200">
                  <thead className="bg-gray-50">
                    <tr>
                      <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Job</th>
                      <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Role</th>
                      <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Date</th>
                      <th className="px-6 py-3 text-right text-xs font-medium text-gray-500 uppercase">Value</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-200">
                    {org.linked_jobs.map((lj) => (
                      <tr key={lj.id} className="hover:bg-gray-50">
                        <td className="px-6 py-3">
                          <Link to={`/jobs/${lj.job_id}`} className="text-sm font-medium text-ooosh-600 hover:text-ooosh-700">
                            {lj.hh_job_number ? `J-${lj.hh_job_number}` : 'NEW'} {lj.job_name || ''}
                          </Link>
                        </td>
                        <td className="px-6 py-3 text-sm text-gray-600 capitalize">{lj.role.replace('_', ' ')}</td>
                        <td className="px-6 py-3 text-sm text-gray-500">{lj.job_date ? formatDate(lj.job_date) : '—'}</td>
                        <td className="px-6 py-3 text-sm text-gray-700 text-right">
                          {lj.job_value ? `£${Number(lj.job_value).toLocaleString()}` : '—'}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>
      )}

      {activeTab === 'timeline' && id && (
        <ActivityTimeline
          entityType="organisation_id"
          entityId={id}
          interactions={interactions}
          onInteractionAdded={loadInteractions}
        />
      )}

      {activeTab === 'details' && (
        <div className="bg-white rounded-xl shadow-sm border border-gray-200 p-6">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            <DetailField label="Type" value={org.type} />
            <DetailField label="Location" value={org.location} />
            <DetailField label="Email" value={org.email} />
            <DetailField label="Phone" value={org.phone} />
            <DetailField label="Website" value={org.website} />
            <DetailField label="Address" value={org.address} />
            <DetailField label="Created" value={formatDate(org.created_at)} />
          </div>
          {/* Working Terms */}
          <div className="mt-6 pt-4 border-t">
            <h3 className="text-sm font-semibold text-gray-700 mb-2">Working Terms</h3>
            {org.working_terms_type ? (
              <div className="text-sm">
                <span className={`inline-block px-2.5 py-1 rounded-full text-xs font-semibold text-white ${
                  { usual: 'bg-green-600', flex_balance: 'bg-emerald-500', no_deposit: 'bg-blue-800', credit: 'bg-purple-600', custom: 'bg-orange-500' }[org.working_terms_type] || 'bg-gray-500'
                }`}>{
                  { usual: 'USUAL', flex_balance: 'FLEX BALANCE', no_deposit: 'NO DEPOSIT', credit: 'CREDIT', custom: 'CUSTOM' }[org.working_terms_type] || org.working_terms_type
                }</span>
                <span className="ml-2 text-gray-500 text-xs">{
                  { usual: '25% deposit, full balance before hire', flex_balance: '25% deposit, flexible balance', no_deposit: 'Balance by start of hire', credit: 'No deposit, flexible balance', custom: '' }[org.working_terms_type]
                }</span>
                {(org.working_terms_type === 'flex_balance' || org.working_terms_type === 'credit') && org.working_terms_credit_days && (
                  <span className="ml-1 text-gray-500 text-xs">({org.working_terms_credit_days} day credit)</span>
                )}
                {org.working_terms_notes && <p className="mt-1 text-gray-500 text-xs">{org.working_terms_notes}</p>}
              </div>
            ) : (
              <p className="text-sm text-gray-400 italic">Not set — edit to configure</p>
            )}
          </div>

          {/* Internal Notes */}
          <div className="mt-6 pt-4 border-t">
            <h3 className="text-sm font-semibold text-gray-700 mb-2">Internal Notes</h3>
            {org.notes ? (
              <p className="text-sm text-gray-600 whitespace-pre-wrap">{org.notes}</p>
            ) : (
              <p className="text-sm text-gray-400 italic">No notes — edit to add</p>
            )}
          </div>

          {/* AI Summary */}
          <div className="mt-6 pt-4 border-t">
            <h3 className="text-sm font-semibold text-gray-700 mb-2">AI Summary</h3>
            {org.ai_summary ? (
              <p className="text-sm text-gray-600 whitespace-pre-wrap">{org.ai_summary}</p>
            ) : (
              <p className="text-sm text-gray-400 italic">No AI summary yet — this will auto-populate with a summary of activity in the system</p>
            )}
          </div>

          {/* AI Research */}
          <div className="mt-6 pt-4 border-t">
            <h3 className="text-sm font-semibold text-gray-700 mb-2">AI Research</h3>
            {org.ai_research ? (
              <p className="text-sm text-gray-600 whitespace-pre-wrap">{org.ai_research}</p>
            ) : (
              <p className="text-sm text-gray-400 italic">No AI research yet — this will show discovered context from external sources</p>
            )}
          </div>

          <div className="mt-6 pt-4 border-t">
            <FileUpload
              entityType="organisations"
              entityId={org.id}
              files={org.files || []}
              onFilesChanged={(files) => setOrg(prev => prev ? { ...prev, files } : prev)}
              onActivityCreated={loadInteractions}
            />
          </div>
        </div>
      )}

      {/* Add Relationship Modal */}
      {showAddRelationship && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <div className="bg-white rounded-xl shadow-xl w-full max-w-lg mx-4 p-6">
            <h3 className="text-lg font-semibold text-gray-900 mb-4">Add Relationship</h3>

            {/* Step 1: Search and select org */}
            {!relSelectedOrg ? (
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Search for organisation</label>
                <input
                  type="text"
                  value={relOrgSearch}
                  onChange={(e) => setRelOrgSearch(e.target.value)}
                  placeholder="Type to search organisations..."
                  className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:ring-ooosh-500 focus:border-ooosh-500"
                  autoFocus
                />
                {relOrgResults.length > 0 && (
                  <div className="mt-2 border border-gray-200 rounded-lg max-h-60 overflow-y-auto">
                    {relOrgResults.map((o) => (
                      <button
                        key={o.id}
                        onClick={() => { setRelSelectedOrg(o); setRelOrgResults([]); }}
                        className="w-full text-left px-4 py-3 hover:bg-gray-50 flex items-center gap-2 border-b border-gray-100 last:border-b-0"
                      >
                        <span className="text-sm font-medium text-gray-900">{o.name}</span>
                        <span className={`inline-flex px-2 py-0.5 rounded-full text-xs ${typeColors[o.type] || 'bg-gray-100 text-gray-700'}`}>
                          {o.type}
                        </span>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            ) : (
              <div>
                {/* Selected org */}
                <div className="flex items-center gap-2 mb-4 p-3 bg-gray-50 rounded-lg">
                  <span className="text-sm font-medium text-gray-900">{relSelectedOrg.name}</span>
                  <span className={`inline-flex px-2 py-0.5 rounded-full text-xs ${typeColors[relSelectedOrg.type] || 'bg-gray-100 text-gray-700'}`}>
                    {relSelectedOrg.type}
                  </span>
                  <button
                    onClick={() => { setRelSelectedOrg(null); setRelOrgSearch(''); }}
                    className="ml-auto text-xs text-gray-400 hover:text-gray-600"
                  >
                    Change
                  </button>
                </div>

                {/* Relationship type */}
                <label className="block text-sm font-medium text-gray-700 mb-1">Relationship type</label>
                <select
                  value={relType}
                  onChange={(e) => setRelType(e.target.value as OrgRelationshipType)}
                  className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm mb-3"
                >
                  {Object.entries(ORG_RELATIONSHIP_LABELS).map(([key, labels]) => (
                    <option key={key} value={key}>{labels.forward}</option>
                  ))}
                </select>

                {/* Direction */}
                <label className="block text-sm font-medium text-gray-700 mb-2">Direction</label>
                <div className="space-y-2 mb-4">
                  <label className="flex items-center gap-2 p-3 rounded-lg border cursor-pointer hover:bg-gray-50 transition-colors"
                    style={{ borderColor: relDirection === 'forward' ? '#0ea5e9' : '#e5e7eb' }}
                  >
                    <input type="radio" name="direction" checked={relDirection === 'forward'}
                      onChange={() => setRelDirection('forward')} className="text-ooosh-600" />
                    <span className="text-sm">
                      <strong>{org.name}</strong> {ORG_RELATIONSHIP_LABELS[relType]?.forward.toLowerCase()} <strong>{relSelectedOrg.name}</strong>
                    </span>
                  </label>
                  <label className="flex items-center gap-2 p-3 rounded-lg border cursor-pointer hover:bg-gray-50 transition-colors"
                    style={{ borderColor: relDirection === 'reverse' ? '#0ea5e9' : '#e5e7eb' }}
                  >
                    <input type="radio" name="direction" checked={relDirection === 'reverse'}
                      onChange={() => setRelDirection('reverse')} className="text-ooosh-600" />
                    <span className="text-sm">
                      <strong>{relSelectedOrg.name}</strong> {ORG_RELATIONSHIP_LABELS[relType]?.forward.toLowerCase()} <strong>{org.name}</strong>
                    </span>
                  </label>
                </div>
              </div>
            )}

            <div className="flex justify-end gap-2 mt-4 pt-4 border-t">
              <button
                onClick={() => { setShowAddRelationship(false); setRelSelectedOrg(null); setRelOrgSearch(''); }}
                className="px-4 py-2 text-sm border border-gray-300 rounded-lg hover:bg-gray-50"
              >
                Cancel
              </button>
              {relSelectedOrg && (
                <button
                  onClick={handleAddRelationship}
                  disabled={relSaving}
                  className="px-4 py-2 text-sm bg-ooosh-600 text-white rounded-lg hover:bg-ooosh-700 disabled:opacity-50"
                >
                  {relSaving ? 'Saving...' : 'Add Relationship'}
                </button>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Edit Panel */}
      <SlidePanel open={showEdit} onClose={() => setShowEdit(false)} title="Edit Organisation">
        <OrganisationForm
          orgId={id}
          onSaved={() => { setShowEdit(false); loadOrg(); }}
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
