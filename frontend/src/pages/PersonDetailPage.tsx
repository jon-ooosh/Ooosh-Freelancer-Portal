import { useState, useEffect } from 'react';
import { hasManagerRole } from '../lib/roles';
import { useParams, useNavigate, Link } from 'react-router-dom';
import { api } from '../services/api';
import { useAuthStore } from '../hooks/useAuthStore';
import SlidePanel from '../components/SlidePanel';
import PersonForm from '../components/PersonForm';
import FileUpload from '../components/FileUpload';
import ActivityTimeline from '../components/ActivityTimeline';
import ExcessHistorySection from '../components/ExcessHistorySection';
import HireHistoryTab from '../components/HireHistoryTab';
import FreelancerPanel, { freelancerStatusPill } from '../components/FreelancerPanel';
import HeldItemsSection from '../components/HeldItemsSection';
import InviteFreelancerModal from '../components/InviteFreelancerModal';
import StorageHistorySection from '../components/StorageHistorySection';
import { PcnHistorySection } from '../components/PcnHistorySection';
import { PERSON_ORG_ROLES } from '@shared/index';

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
  freelancer_status: string | null;
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
  do_not_hire: boolean;
  do_not_hire_reason: string | null;
  do_not_hire_set_at: string | null;
  do_not_hire_set_by: string | null;
  working_terms_type: string | null;
  working_terms_credit_days: number | null;
  working_terms_notes: string | null;
  ai_summary: string | null;
  ai_research: string | null;
  portal_notifications_paused_until: string | null;
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
  const user = useAuthStore((s) => s.user);
  const isAdmin = hasManagerRole(user?.role);

  const [person, setPerson] = useState<PersonDetail | null>(null);
  const [dnoReason, setDnoReason] = useState('');
  const [showDnoForm, setShowDnoForm] = useState(false);
  const [showInvite, setShowInvite] = useState(false);
  const [interactions, setInteractions] = useState<Interaction[]>([]);
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState<'timeline' | 'hire_history' | 'freelancer' | 'details' | 'relationships' | 'excess' | 'held' | 'storage' | 'pcn'>('timeline');
  const [heldCount, setHeldCount] = useState<number | null>(null);

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

  // End role confirmation
  const [endingRoleId, setEndingRoleId] = useState<string | null>(null);
  const [endReason, setEndReason] = useState('');
  const [endRepoint, setEndRepoint] = useState(false);
  const [repointOrgSearch, setRepointOrgSearch] = useState('');
  const [repointOrgResults, setRepointOrgResults] = useState<Array<{ id: string; name: string; type: string }>>([]);
  const [repointSelectedOrg, setRepointSelectedOrg] = useState<{ id: string; name: string } | null>(null);
  const [repointRole, setRepointRole] = useState('');
  const [endingSaving, setEndingSaving] = useState(false);

  // Edit role in place
  const [editingRoleId, setEditingRoleId] = useState<string | null>(null);
  const [editRole, setEditRole] = useState('');
  const [editIsPrimary, setEditIsPrimary] = useState(false);
  const [editSaving, setEditSaving] = useState(false);

  useEffect(() => {
    if (id) {
      loadPerson();
      loadInteractions();
    }
  }, [id]);

  // Reset tab when switching people — component instance is reused across
  // /people/A → /people/B so without this the active tab "drags across".
  useEffect(() => {
    setActiveTab('timeline');
    setHeldCount(null);
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

  function startEditRole(org: { id: string; role: string; is_primary?: boolean }) {
    setEditingRoleId(org.id);
    setEditRole(org.role);
    setEditIsPrimary(!!org.is_primary);
  }

  async function handleEditRole(roleId: string) {
    if (!editRole.trim() || editSaving) return;
    setEditSaving(true);
    try {
      await api.patch(`/people/${id}/roles/${roleId}`, {
        role: editRole.trim(),
        is_primary: editIsPrimary,
      });
      setEditingRoleId(null);
      loadPerson();
    } catch (err) {
      console.error('Failed to edit role:', err);
    } finally {
      setEditSaving(false);
    }
  }

  async function handleEndRoleConfirmed() {
    if (!endingRoleId) return;
    setEndingSaving(true);
    try {
      // End the current role
      await api.put(`/people/${id}/roles/${endingRoleId}/end`, {});

      // If reason provided, log it as an interaction
      if (endReason.trim()) {
        const endingOrg = activeOrgs.find(o => o.id === endingRoleId);
        try {
          await api.post('/interactions', {
            type: 'note',
            content: `Role ended at ${endingOrg?.organisation_name || 'organisation'}: ${endReason.trim()}`,
            person_id: id,
            organisation_id: endingOrg?.organisation_id,
          });
        } catch { /* non-critical */ }
      }

      // If repointing, create new role at the selected org
      if (endRepoint && repointSelectedOrg && repointRole.trim()) {
        try {
          await api.post(`/people/${id}/roles`, {
            organisation_id: repointSelectedOrg.id,
            role: repointRole.trim(),
            is_primary: true,
          });
        } catch (err) {
          console.error('Failed to create repointed role:', err);
        }
      }

      // Reset and reload
      setEndingRoleId(null);
      setEndReason('');
      setEndRepoint(false);
      setRepointSelectedOrg(null);
      setRepointRole('');
      setRepointOrgSearch('');
      loadPerson();
      loadInteractions();
    } catch (err) {
      console.error('Failed to end role:', err);
    } finally {
      setEndingSaving(false);
    }
  }

  // Search orgs for repoint picker
  useEffect(() => {
    if (repointOrgSearch.length < 2) { setRepointOrgResults([]); return; }
    const timeout = setTimeout(async () => {
      try {
        const data = await api.get<{ data: Array<{ id: string; name: string; type: string }> }>(
          `/organisations?search=${encodeURIComponent(repointOrgSearch)}&limit=10`
        );
        setRepointOrgResults(data.data);
      } catch { /* ignore */ }
    }, 250);
    return () => clearTimeout(timeout);
  }, [repointOrgSearch]);

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
            {isFreelancer && (() => {
              const fp = freelancerStatusPill(person.freelancer_status, person.is_approved);
              return <span className={`inline-flex px-2 py-1 rounded-full text-xs font-medium ${fp.cls}`}>{fp.label}</span>;
            })()}
            {!person.is_approved && (
              <button
                onClick={() => setShowInvite(true)}
                className="px-3 py-1.5 text-sm border border-purple-300 text-purple-700 rounded hover:bg-purple-50 transition-colors"
              >
                {isFreelancer ? 'Re-send sign-up' : 'Invite to freelance'}
              </button>
            )}
            <button
              onClick={() => {
                // Client on an enquiry is always an organisation. Pre-fill the
                // person's primary (or first) linked org and tick them as the
                // contact. No org → open the picker plainly.
                const primaryOrg = activeOrgs.find(o => o.is_primary) || activeOrgs[0];
                if (primaryOrg) {
                  navigate(`/pipeline?newEnquiry=1&client=${primaryOrg.organisation_id}&contact=${person.id}`);
                } else {
                  navigate('/pipeline?newEnquiry=1');
                }
              }}
              className="px-3 py-1.5 text-sm bg-ooosh-600 text-white rounded hover:bg-ooosh-700 transition-colors"
            >
              + New Enquiry
            </button>
            <button
              onClick={() => setShowEdit(true)}
              className="px-3 py-1.5 text-sm border border-gray-300 rounded hover:bg-gray-50 transition-colors"
            >
              Edit
            </button>
            {!person.do_not_hire && isAdmin && (
              <button
                onClick={() => setShowDnoForm(true)}
                className="px-3 py-1.5 text-sm border border-red-200 text-red-600 rounded hover:bg-red-50 transition-colors"
                title="Flag as Do Not Hire"
              >
                DNH
              </button>
            )}
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

      {/* Do Not Hire Banner */}
      {person.do_not_hire && (
        <div className="mb-4 bg-red-50 border border-red-200 rounded-lg px-4 py-3 flex items-center justify-between">
          <div>
            <p className="text-sm font-semibold text-red-800">DO NOT HIRE</p>
            {person.do_not_hire_reason && <p className="text-sm text-red-600 mt-0.5">{person.do_not_hire_reason}</p>}
            {person.do_not_hire_set_by && <p className="text-xs text-red-400 mt-0.5">Set by {person.do_not_hire_set_by}</p>}
          </div>
          {isAdmin && (
            <button
              onClick={async () => {
                await api.post(`/people/${id}/do-not-hire`, { do_not_hire: false });
                loadPerson();
              }}
              className="text-xs px-3 py-1.5 bg-red-100 text-red-700 rounded hover:bg-red-200"
            >
              Lift restriction
            </button>
          )}
        </div>
      )}
      {/* DNH reason form (shown when DNH button clicked) */}
      {showDnoForm && !person.do_not_hire && (
        <div className="mb-4 bg-gray-50 border border-gray-200 rounded-lg px-4 py-3 flex items-center gap-3">
          <input
            value={dnoReason}
            onChange={e => setDnoReason(e.target.value)}
            placeholder="Reason for Do Not Hire (optional)..."
            className="flex-1 rounded border border-gray-300 px-3 py-1.5 text-sm"
            autoFocus
          />
          <button
            onClick={async () => {
              await api.post(`/people/${id}/do-not-hire`, { do_not_hire: true, reason: dnoReason || null });
              setShowDnoForm(false);
              setDnoReason('');
              loadPerson();
            }}
            className="text-xs px-3 py-1.5 bg-red-600 text-white rounded hover:bg-red-700"
          >
            Confirm
          </button>
          <button onClick={() => { setShowDnoForm(false); setDnoReason(''); }} className="text-xs px-3 py-1.5 border border-gray-300 rounded hover:bg-gray-50">Cancel</button>
        </div>
      )}

      {/* Tabs */}
      <div className="border-b border-gray-200 mb-6">
        <nav className="flex gap-6">
          {([
            'timeline',
            ...(isFreelancer ? (['freelancer'] as const) : []),
            'hire_history',
            'details', 'relationships', 'excess', 'held', 'storage',
            ...(isFreelancer ? (['pcn'] as const) : []),
          ] as const).map((tab) => {
            const totalOrgs = (person.organisations || []).length;
            const label = tab === 'timeline' ? 'Activity Timeline'
              : tab === 'hire_history' ? 'Hire History'
              : tab === 'freelancer' ? 'Freelancer'
              : tab === 'details' ? 'Details'
              : tab === 'excess' ? 'Excess History'
              : tab === 'held' ? (heldCount ? `Held Items (${heldCount})` : 'Held Items')
              : tab === 'storage' ? 'Storage'
              : tab === 'pcn' ? 'PCNs'
              : `Relationships${totalOrgs ? ` (${totalOrgs})` : ''}`;
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
          </div>

          {isFreelancer && (
            <div className="mt-4 pt-4 border-t">
              <p className="text-sm text-gray-500">
                Freelancer details, approval, review dates and documents now live on the{' '}
                <button
                  onClick={() => setActiveTab('freelancer')}
                  className="text-ooosh-600 font-medium hover:underline"
                >
                  Freelancer tab
                </button>.
              </p>
            </div>
          )}

          {/* Working Terms */}
          <div className="mt-6 pt-4 border-t">
            <h3 className="text-sm font-semibold text-gray-700 mb-2">Working Terms</h3>
            {person.working_terms_type ? (
              <div className="text-sm">
                <span className={`inline-block px-2.5 py-1 rounded-full text-xs font-semibold text-white ${
                  { usual: 'bg-green-600', flex_balance: 'bg-emerald-500', no_deposit: 'bg-blue-800', credit: 'bg-purple-600', custom: 'bg-orange-500' }[person.working_terms_type] || 'bg-gray-500'
                }`}>{
                  { usual: 'USUAL', flex_balance: 'FLEX BALANCE', no_deposit: 'NO DEPOSIT', credit: 'CREDIT', custom: 'CUSTOM' }[person.working_terms_type] || person.working_terms_type
                }</span>
                <span className="ml-2 text-gray-500 text-xs">{
                  { usual: '25% deposit, full balance before hire', flex_balance: '25% deposit, flexible balance', no_deposit: 'Balance by start of hire', credit: 'No deposit, flexible balance', custom: '' }[person.working_terms_type]
                }</span>
                {(person.working_terms_type === 'flex_balance' || person.working_terms_type === 'credit') && person.working_terms_credit_days && (
                  <span className="ml-1 text-gray-500 text-xs">({person.working_terms_credit_days} day credit)</span>
                )}
                {person.working_terms_notes && <p className="mt-1 text-gray-500 text-xs">{person.working_terms_notes}</p>}
              </div>
            ) : (
              <p className="text-sm text-gray-400 italic">Not set — edit to configure</p>
            )}
          </div>

          {/* Internal Notes */}
          <div className="mt-6 pt-4 border-t">
            <h3 className="text-sm font-semibold text-gray-700 mb-2">Internal Notes</h3>
            {person.notes ? (
              <p className="text-sm text-gray-600 whitespace-pre-wrap">{person.notes}</p>
            ) : (
              <p className="text-sm text-gray-400 italic">No notes — edit to add</p>
            )}
          </div>

          {/* AI Summary */}
          <div className="mt-6 pt-4 border-t">
            <h3 className="text-sm font-semibold text-gray-700 mb-2">AI Summary</h3>
            {person.ai_summary ? (
              <p className="text-sm text-gray-600 whitespace-pre-wrap">{person.ai_summary}</p>
            ) : (
              <p className="text-sm text-gray-400 italic">No AI summary yet — this will auto-populate with a summary of activity in the system</p>
            )}
          </div>

          {/* AI Research */}
          <div className="mt-6 pt-4 border-t">
            <h3 className="text-sm font-semibold text-gray-700 mb-2">AI Research</h3>
            {person.ai_research ? (
              <p className="text-sm text-gray-600 whitespace-pre-wrap">{person.ai_research}</p>
            ) : (
              <p className="text-sm text-gray-400 italic">No AI research yet — this will show discovered context from external sources</p>
            )}
          </div>

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
                    <select
                      value={roleTitle}
                      onChange={e => setRoleTitle(e.target.value)}
                      className="w-full rounded border border-gray-300 px-3 py-2 text-sm focus:border-ooosh-500 focus:outline-none focus:ring-1 focus:ring-ooosh-500"
                    >
                      <option value="">Select a role...</option>
                      {PERSON_ORG_ROLES.map(r => (
                        <option key={r} value={r}>{r}</option>
                      ))}
                    </select>
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
                    className="bg-white rounded-xl shadow-sm border border-gray-200 p-4"
                  >
                    {editingRoleId === org.id ? (
                      <div className="space-y-3">
                        <div className="font-medium text-gray-900">{org.organisation_name}</div>
                        <div>
                          <label className="block text-xs font-medium text-gray-500 uppercase mb-1">Role / Title</label>
                          <select
                            value={editRole}
                            onChange={e => setEditRole(e.target.value)}
                            className="w-full rounded border border-gray-300 px-3 py-2 text-sm focus:border-ooosh-500 focus:outline-none focus:ring-1 focus:ring-ooosh-500"
                          >
                            <option value="">Select a role...</option>
                            {PERSON_ORG_ROLES.map(r => (
                              <option key={r} value={r}>{r}</option>
                            ))}
                            {editRole && !PERSON_ORG_ROLES.includes(editRole) && (
                              <option value={editRole}>{editRole}</option>
                            )}
                          </select>
                        </div>
                        <label className="flex items-center gap-2 cursor-pointer">
                          <input
                            type="checkbox"
                            checked={editIsPrimary}
                            onChange={e => setEditIsPrimary(e.target.checked)}
                            className="rounded border-gray-300 text-ooosh-600 focus:ring-ooosh-500"
                          />
                          <span className="text-sm text-gray-700">Primary organisation</span>
                        </label>
                        <div className="flex gap-2">
                          <button
                            onClick={() => handleEditRole(org.id)}
                            disabled={!editRole.trim() || editSaving}
                            className="bg-ooosh-600 text-white px-4 py-1.5 rounded text-sm font-medium hover:bg-ooosh-700 transition-colors disabled:opacity-50"
                          >
                            {editSaving ? 'Saving...' : 'Save'}
                          </button>
                          <button onClick={() => setEditingRoleId(null)} className="px-4 py-1.5 text-sm border border-gray-300 rounded hover:bg-gray-50">Cancel</button>
                        </div>
                      </div>
                    ) : (
                      <div className="flex items-center justify-between">
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
                            onClick={() => startEditRole(org)}
                            className="text-xs text-gray-500 hover:text-ooosh-700 px-2 py-1 border border-gray-200 rounded hover:bg-gray-50"
                          >
                            Edit
                          </button>
                          <button
                            onClick={() => { setEndingRoleId(org.id); setEndReason(''); setEndRepoint(false); setRepointSelectedOrg(null); setRepointRole(''); }}
                            className="text-xs text-red-500 hover:text-red-700 px-2 py-1 border border-red-200 rounded hover:bg-red-50"
                          >
                            End
                          </button>
                        </div>
                      </div>
                    )}
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

      {/* End Role Confirmation Modal */}
      {endingRoleId && (() => {
        const endingOrg = activeOrgs.find(o => o.id === endingRoleId);
        return (
          <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
            <div className="bg-white rounded-xl shadow-xl w-full max-w-md mx-4 p-6">
              <h3 className="text-lg font-semibold text-gray-900 mb-2">End Role</h3>
              <p className="text-sm text-gray-600 mb-4">
                End <strong>{person.first_name}'s</strong> role as <strong>{endingOrg?.role}</strong> at <strong>{endingOrg?.organisation_name}</strong>?
                This will be marked as historical with today's date.
              </p>

              {/* Reason (optional) */}
              <div className="mb-4">
                <label className="block text-xs font-medium text-gray-500 uppercase mb-1">Reason (optional)</label>
                <input
                  type="text"
                  value={endReason}
                  onChange={(e) => setEndReason(e.target.value)}
                  placeholder="e.g. Moved to new management, left the band..."
                  className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:ring-ooosh-500 focus:border-ooosh-500"
                />
              </div>

              {/* Repoint option */}
              <label className="flex items-center gap-2 mb-3 cursor-pointer">
                <input
                  type="checkbox"
                  checked={endRepoint}
                  onChange={(e) => setEndRepoint(e.target.checked)}
                  className="rounded border-gray-300 text-ooosh-600 focus:ring-ooosh-500"
                />
                <span className="text-sm text-gray-700">Immediately link to a new organisation</span>
              </label>

              {endRepoint && (
                <div className="ml-6 mb-4 space-y-3 border-l-2 border-ooosh-200 pl-4">
                  {!repointSelectedOrg ? (
                    <div className="relative">
                      <input
                        type="text"
                        value={repointOrgSearch}
                        onChange={(e) => setRepointOrgSearch(e.target.value)}
                        placeholder="Search for new organisation..."
                        className="w-full border border-gray-300 rounded px-3 py-2 text-sm focus:ring-ooosh-500 focus:border-ooosh-500"
                        autoFocus
                      />
                      {repointOrgResults.length > 0 && (
                        <div className="absolute top-full left-0 right-0 mt-1 bg-white border border-gray-200 rounded-lg shadow-lg z-10 max-h-40 overflow-y-auto">
                          {repointOrgResults.map((o) => (
                            <button
                              key={o.id}
                              onClick={() => { setRepointSelectedOrg({ id: o.id, name: o.name }); setRepointOrgResults([]); }}
                              className="w-full text-left px-3 py-2 hover:bg-gray-50 text-sm flex items-center gap-2"
                            >
                              <span className="font-medium">{o.name}</span>
                              <span className="text-xs text-gray-400">{o.type}</span>
                            </button>
                          ))}
                        </div>
                      )}
                    </div>
                  ) : (
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium text-gray-900 bg-ooosh-50 px-2 py-1 rounded">{repointSelectedOrg.name}</span>
                      <button onClick={() => { setRepointSelectedOrg(null); setRepointOrgSearch(''); }} className="text-xs text-gray-400 hover:text-gray-600">Change</button>
                    </div>
                  )}

                  {repointSelectedOrg && (
                    <select
                      value={repointRole}
                      onChange={(e) => setRepointRole(e.target.value)}
                      className="w-full border border-gray-300 rounded px-3 py-2 text-sm"
                    >
                      <option value="">Select role at new org...</option>
                      {PERSON_ORG_ROLES.map(r => (
                        <option key={r} value={r}>{r}</option>
                      ))}
                    </select>
                  )}
                </div>
              )}

              <div className="flex justify-end gap-2 pt-4 border-t mt-4">
                <button
                  onClick={() => { setEndingRoleId(null); setEndReason(''); setEndRepoint(false); }}
                  className="px-4 py-2 text-sm border border-gray-300 rounded-lg hover:bg-gray-50"
                >
                  Cancel
                </button>
                <button
                  onClick={handleEndRoleConfirmed}
                  disabled={endingSaving || (endRepoint && (!repointSelectedOrg || !repointRole))}
                  className="px-4 py-2 text-sm bg-red-600 text-white rounded-lg hover:bg-red-700 disabled:opacity-50"
                >
                  {endingSaving ? 'Saving...' : endRepoint ? 'End & Repoint' : 'End Role'}
                </button>
              </div>
            </div>
          </div>
        );
      })()}

      {/* Hire History Tab */}
      {activeTab === 'hire_history' && id && (
        <HireHistoryTab entityType="person" entityId={id} />
      )}

      {/* Freelancer Tab (freelancers only) — single home for freelancer data,
          approval, review dates, documents and assignment history. */}
      {activeTab === 'freelancer' && isFreelancer && (
        <FreelancerPanel
          person={person}
          onChanged={loadPerson}
          onFilesChanged={(files) => setPerson(prev => prev ? { ...prev, files } : prev)}
          onActivityCreated={loadInteractions}
          onInvite={() => setShowInvite(true)}
        />
      )}

      {/* Excess History Tab */}
      {activeTab === 'excess' && id && (
        <ExcessHistorySection entityType="person" entityId={id} />
      )}

      {activeTab === 'held' && id && (
        <HeldItemsSection entityType="person" entityId={id} onCount={setHeldCount} />
      )}

      {activeTab === 'storage' && id && (
        <StorageHistorySection entityType="person" entityId={id} />
      )}

      {activeTab === 'pcn' && id && (
        <PcnHistorySection entityType="person" entityId={id} heading="🅿️ Penalty Charge Notices" />
      )}

      {/* Edit Panel */}
      <SlidePanel open={showEdit} onClose={() => setShowEdit(false)} title="Edit Person">
        <PersonForm
          personId={id}
          onSaved={() => { setShowEdit(false); loadPerson(); }}
          onCancel={() => setShowEdit(false)}
        />
      </SlidePanel>

      {showInvite && (
        <InviteFreelancerModal
          personId={person.id}
          personName={`${person.first_name} ${person.last_name}`}
          onClose={() => setShowInvite(false)}
          onInvited={() => { setShowInvite(false); loadPerson(); }}
        />
      )}
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
