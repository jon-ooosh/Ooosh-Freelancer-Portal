import { useState, useEffect } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import { api } from '../services/api';
import SlidePanel from '../components/SlidePanel';
import OrganisationForm from '../components/OrganisationForm';
import OrganisationMergeModal from '../components/OrganisationMergeModal';
import FileUpload from '../components/FileUpload';
import ActivityTimeline from '../components/ActivityTimeline';
import ExcessHistorySection from '../components/ExcessHistorySection';
import { IssuesListSection } from '../components/IssuesListSection';
import HireHistoryTab from '../components/HireHistoryTab';
import HeldItemsSection from '../components/HeldItemsSection';
import StorageHistorySection from '../components/StorageHistorySection';
import PcnHistorySection from '../components/PcnHistorySection';
import { ORG_RELATIONSHIP_LABELS, PERSON_ORG_ROLES_WITH_MAIN_CONTACT, type OrgRelationshipType, type OrganisationRelationship } from '../../../shared/types';
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
  dismissed_suggestions: string[] | null;
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
  linked_job_count?: number;
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

// Org types offered when creating a new org inline (matches OrganisationForm)
const ORG_TYPE_OPTIONS = [
  'band', 'client', 'management', 'label', 'agency', 'promoter',
  'venue', 'festival', 'supplier', 'hire_company', 'booking_agent', 'other',
];

// Sensible default org type to pre-select when creating the other party of a
// relationship, inferred from the relationship type (forward direction). Always
// editable — staff override freely. Falls back to 'band' (the dominant case).
const INFERRED_ORG_TYPE: Record<string, string> = {
  manages: 'band',
  books_for: 'band',
  does_accounts_for: 'band',
  promotes: 'band',
  represents: 'band',
  supplies: 'client',
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
  const [activeTab, setActiveTab] = useState<'people' | 'relationships' | 'hire_history' | 'timeline' | 'details' | 'excess' | 'issues' | 'held' | 'storage' | 'pcns'>('people');
  const [issuesCount, setIssuesCount] = useState<number | null>(null);
  const [pcnCount, setPcnCount] = useState<number | null>(null);

  // Edit/delete
  const [showEdit, setShowEdit] = useState(false);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);

  // Merge
  const [showMergeModal, setShowMergeModal] = useState(false);

  // Add relationship
  const [showAddRelationship, setShowAddRelationship] = useState(false);
  const [relOrgSearch, setRelOrgSearch] = useState('');
  const [relOrgResults, setRelOrgResults] = useState<Array<{ id: string; name: string; type: string }>>([]);
  const [relSelectedOrg, setRelSelectedOrg] = useState<{ id: string; name: string; type: string } | null>(null);
  const [relType, setRelType] = useState<OrgRelationshipType>('manages');
  const [relDirection, setRelDirection] = useState<'forward' | 'reverse'>('forward');
  const [relSaving, setRelSaving] = useState(false);
  // Create-new-org inline (within the relationship modal)
  const [relCreating, setRelCreating] = useState(false);
  const [relNewName, setRelNewName] = useState('');
  const [relNewType, setRelNewType] = useState('band');
  const [relSuggestions, setRelSuggestions] = useState<Array<{ id: string; name: string; type: string; via_person: string }>>([]);

  // Edit relationship type in place
  const [editingRelId, setEditingRelId] = useState<string | null>(null);
  const [editRelType, setEditRelType] = useState<OrgRelationshipType>('manages');
  const [editRelSaving, setEditRelSaving] = useState(false);

  // Edit a person's role at this org in place
  const [editingPersonRoleId, setEditingPersonRoleId] = useState<string | null>(null);
  const [editPersonRole, setEditPersonRole] = useState('');
  const [editPersonRoleSaving, setEditPersonRoleSaving] = useState(false);

  // End a person's role at this org (soft — marks historical with end_date)
  const [endingPersonRole, setEndingPersonRole] = useState<{ roleId: string; personId: string; personName: string; role: string } | null>(null);
  const [endPersonReason, setEndPersonReason] = useState('');
  const [endingPersonSaving, setEndingPersonSaving] = useState(false);

  // Add person — search-first; if no match (or coincidental match) we let
  // the user fall through to a "create new" inline form.
  const [showAddPerson, setShowAddPerson] = useState(false);
  const [creatingNew, setCreatingNew] = useState(false);
  const [personSearch, setPersonSearch] = useState('');
  const [personResults, setPersonResults] = useState<Array<{ id: string; first_name: string; last_name: string; email: string | null }>>([]);
  const [personSelected, setPersonSelected] = useState<{ id: string; name: string } | null>(null);
  const [newPersonFirst, setNewPersonFirst] = useState('');
  const [newPersonLast, setNewPersonLast] = useState('');
  const [newPersonEmail, setNewPersonEmail] = useState('');
  const [newPersonMobile, setNewPersonMobile] = useState('');
  const [personRole, setPersonRole] = useState('');
  const [personIsPrimary, setPersonIsPrimary] = useState(false);
  const [personSaving, setPersonSaving] = useState(false);
  const [personError, setPersonError] = useState('');

  useEffect(() => {
    if (id) {
      loadOrg();
      loadInteractions();
    }
  }, [id]);

  // Reset tab when switching orgs — component instance is reused across
  // /organisations/A → /organisations/B so without this the active tab
  // "drags across".
  useEffect(() => {
    setActiveTab('people');
    setIssuesCount(null);
    setPcnCount(null);
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

  // Load "quick associate" suggestions (orgs sharing a person, not yet linked)
  // when the relationship modal opens.
  useEffect(() => {
    if (!showAddRelationship || !id) { setRelSuggestions([]); return; }
    (async () => {
      try {
        const data = await api.get<{ data: Array<{ id: string; name: string; type: string; via_person: string }> }>(
          `/organisations/${id}/relationship-suggestions`
        );
        setRelSuggestions(data.data || []);
      } catch { setRelSuggestions([]); }
    })();
  }, [showAddRelationship, id]);

  useEffect(() => {
    if (personSearch.length < 2) { setPersonResults([]); return; }
    const timeout = setTimeout(async () => {
      try {
        const data = await api.get<{ data: Array<{ id: string; first_name: string; last_name: string; email: string | null }> }>(
          `/people?search=${encodeURIComponent(personSearch)}&limit=8`
        );
        const linkedPersonIds = new Set((org?.people || []).filter(p => p.status === 'active').map(p => p.person_id));
        setPersonResults(data.data.filter(p => !linkedPersonIds.has(p.id)));
      } catch { /* ignore */ }
    }, 250);
    return () => clearTimeout(timeout);
  }, [personSearch, org?.people]);

  function resetAddPersonForm() {
    setShowAddPerson(false);
    setCreatingNew(false);
    setPersonSearch('');
    setPersonResults([]);
    setPersonSelected(null);
    setNewPersonFirst('');
    setNewPersonLast('');
    setNewPersonEmail('');
    setNewPersonMobile('');
    setPersonRole('');
    setPersonIsPrimary(false);
    setPersonError('');
  }

  function startCreateNew(prefill: string) {
    const trimmed = prefill.trim();
    const spaceIdx = trimmed.indexOf(' ');
    if (spaceIdx > 0) {
      setNewPersonFirst(trimmed.slice(0, spaceIdx));
      setNewPersonLast(trimmed.slice(spaceIdx + 1).trim());
    } else {
      setNewPersonFirst(trimmed);
      setNewPersonLast('');
    }
    setCreatingNew(true);
    setPersonResults([]);
    setPersonError('');
  }

  async function handleAddPerson(e: React.FormEvent) {
    e.preventDefault();
    if (!id || personSaving) return;
    if (!personRole.trim()) {
      setPersonError('Pick a role');
      return;
    }
    if (!personSelected && !creatingNew) {
      setPersonError('Pick a person or create a new one');
      return;
    }
    if (creatingNew && (!newPersonFirst.trim() || !newPersonLast.trim())) {
      setPersonError('First and last name are required for a new person');
      return;
    }
    setPersonSaving(true);
    setPersonError('');
    try {
      const body: Record<string, unknown> = {
        role: personRole.trim(),
        is_primary: personIsPrimary,
      };
      if (personSelected) {
        body.person_id = personSelected.id;
      } else {
        body.new_person = {
          first_name: newPersonFirst.trim(),
          last_name: newPersonLast.trim(),
          email: newPersonEmail.trim() || undefined,
          mobile: newPersonMobile.trim() || undefined,
        };
      }
      await api.post(`/organisations/${id}/people`, body);
      resetAddPersonForm();
      loadOrg();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Failed to add person';
      setPersonError(msg);
    } finally {
      setPersonSaving(false);
    }
  }

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
      resetRelationshipModal();
      loadOrg();
    } catch (err: any) {
      alert(err?.response?.data?.error || 'Failed to add relationship');
    } finally {
      setRelSaving(false);
    }
  }

  // Open the inline create-new form, prefilling the name from the search box
  // and the type inferred from the currently-selected relationship type.
  function startCreateOrg() {
    setRelNewName(relOrgSearch.trim());
    setRelNewType(INFERRED_ORG_TYPE[relType] || 'band');
    setRelCreating(true);
  }

  // Create the org with just name + type, then drop into the relationship
  // type/direction step with the new org pre-selected.
  async function handleCreateOrgForRelationship() {
    if (!relNewName.trim() || !id) return;
    setRelSaving(true);
    try {
      const created = await api.post<{ id: string; name: string; type: string }>('/organisations', {
        name: relNewName.trim(),
        type: relNewType,
      });
      setRelSelectedOrg({ id: created.id, name: created.name, type: created.type });
      setRelCreating(false);
      setRelOrgResults([]);
    } catch (err: any) {
      alert(err?.response?.data?.error || 'Failed to create organisation');
    } finally {
      setRelSaving(false);
    }
  }

  function resetRelationshipModal() {
    setShowAddRelationship(false);
    setRelSelectedOrg(null);
    setRelOrgSearch('');
    setRelOrgResults([]);
    setRelCreating(false);
    setRelNewName('');
  }

  async function handleTogglePrimary(roleId: string, makePrimary: boolean) {
    try {
      await api.put(`/organisations/${id}/people/${roleId}/primary`, {
        is_primary: makePrimary,
      });
      loadOrg();
    } catch (err: any) {
      alert(err?.response?.data?.error || err?.message || 'Failed to update primary contact');
    }
  }

  async function handleDeleteRelationship(relId: string) {
    if (!confirm('End this relationship? It will be kept on record as historical, not deleted.')) return;
    try {
      await api.delete(`/organisations/${id}/relationships/${relId}`);
      loadOrg();
    } catch (err) {
      console.error('Failed to delete relationship:', err);
    }
  }

  // Edit the relationship type (direction is preserved — to flip direction,
  // remove and re-add). editRelType holds the new type from this org's view.
  async function handleEditRelationship(relId: string) {
    if (editRelSaving) return;
    setEditRelSaving(true);
    try {
      await api.put(`/organisations/${id}/relationships/${relId}`, {
        relationship_type: editRelType,
      });
      setEditingRelId(null);
      loadOrg();
    } catch (err: any) {
      alert(err?.response?.data?.error || err?.message || 'Failed to update relationship');
    } finally {
      setEditRelSaving(false);
    }
  }

  // Edit a person's role at this org. Uses the person-roles PATCH endpoint
  // (roleId is the person_organisation_roles row id, exposed as p.id).
  async function handleEditPersonRole(personId: string, roleId: string) {
    if (!editPersonRole.trim() || editPersonRoleSaving) return;
    setEditPersonRoleSaving(true);
    try {
      await api.patch(`/people/${personId}/roles/${roleId}`, {
        role: editPersonRole.trim(),
      });
      setEditingPersonRoleId(null);
      loadOrg();
    } catch (err: any) {
      alert(err?.response?.data?.error || err?.message || 'Failed to update role');
    } finally {
      setEditPersonRoleSaving(false);
    }
  }

  // End a person's role at this org. Soft only — the backend sets
  // status='historical', stamps end_date and clears primary (the row moves to
  // the Historical section, preserving the "who used to be involved" audit
  // trail rather than vanishing). Optional reason is logged as an interaction.
  async function handleEndPersonRoleConfirmed() {
    if (!endingPersonRole || endingPersonSaving) return;
    setEndingPersonSaving(true);
    try {
      await api.put(`/people/${endingPersonRole.personId}/roles/${endingPersonRole.roleId}/end`, {});
      if (endPersonReason.trim()) {
        try {
          await api.post('/interactions', {
            type: 'note',
            content: `Role ended at ${org?.name || 'organisation'}: ${endPersonReason.trim()}`,
            person_id: endingPersonRole.personId,
            organisation_id: id,
          });
        } catch { /* non-critical — the role still ended */ }
      }
      setEndingPersonRole(null);
      setEndPersonReason('');
      loadOrg();
    } catch (err: any) {
      alert(err?.response?.data?.error || err?.message || 'Failed to end role');
    } finally {
      setEndingPersonSaving(false);
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
              onClick={() => navigate(`/pipeline?newEnquiry=1&client=${org.id}`)}
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
            {!org.do_not_hire && isAdmin && (
              <button
                onClick={() => setShowDnoForm(true)}
                className="px-3 py-1.5 text-sm border border-red-200 text-red-600 rounded hover:bg-red-50 transition-colors"
                title="Flag as Do Not Hire"
              >
                DNH
              </button>
            )}
            {isAdmin && (
              <button
                onClick={() => setShowMergeModal(true)}
                className="px-3 py-1.5 text-sm border border-amber-200 text-amber-700 rounded hover:bg-amber-50 transition-colors"
                title="Merge this organisation into another"
              >
                Merge
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
      {/* DNH reason form (shown when DNH button clicked) */}
      {showDnoForm && !org.do_not_hire && (
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
      )}

      {/* Smart suggestions */}
      {(() => {
        const suggestions: Array<{ key: string; text: string; action: string; newType: string }> = [];
        const type = org.type?.toLowerCase() || '';
        const name = org.name || '';
        const companyWords = ['ltd', 'limited', 'group', 'management', 'agency', 'inc', 'llc', 'plc', 'services', 'productions', 'consulting'];
        const looksLikeCompany = companyWords.some(w => name.toLowerCase().includes(w));
        const hasJobsAsBand = (org.linked_jobs || []).some(j => j.role === 'band');
        const peopleCount = (org.people || []).length;
        const dismissed = new Set(org.dismissed_suggestions || []);

        // Suggest band if typed as client/unknown but linked as band in jobs
        if ((type === 'client' || type === 'unknown') && hasJobsAsBand) {
          suggestions.push({ key: 'band-rename-by-jobs', text: `This is typed as "${type}" but appears as a band on ${(org.linked_jobs || []).filter(j => j.role === 'band').length} job(s). Should it be a band?`, action: 'Change to Band', newType: 'band' });
        }
        // Suggest band if typed as client/unknown, no company-like words, and few/no people
        if ((type === 'client' || type === 'unknown') && !looksLikeCompany && peopleCount <= 1 && !hasJobsAsBand) {
          suggestions.push({ key: 'band-rename', text: `"${name}" is typed as "${type}" — could this be a band or artist?`, action: 'Change to Band', newType: 'band' });
        }
        // Suggest management if typed as client but has "management" in name
        if (type === 'client' && name.toLowerCase().includes('management')) {
          suggestions.push({ key: 'management-rename', text: `"${name}" is typed as "client" but looks like a management company.`, action: 'Change to Management', newType: 'management' });
        }

        const visible = suggestions.filter(s => !dismissed.has(s.key));
        if (visible.length === 0) return null;

        return (
          <div className="mb-4 space-y-2">
            {visible.map((s) => (
              <div key={s.key} className="bg-amber-50 border border-amber-200 rounded-lg px-4 py-3 flex items-center justify-between gap-3">
                <p className="text-sm text-amber-800 flex-1 min-w-0">{s.text}</p>
                <div className="flex items-center gap-2 flex-shrink-0">
                  <button
                    onClick={async () => {
                      try {
                        await api.put(`/organisations/${id}`, { type: s.newType });
                        loadOrg();
                      } catch (err) { console.error(err); }
                    }}
                    className="text-xs font-medium px-3 py-1.5 bg-amber-100 text-amber-700 rounded hover:bg-amber-200"
                  >
                    {s.action}
                  </button>
                  <button
                    onClick={async () => {
                      try {
                        await api.post(`/organisations/${id}/dismiss-suggestion`, { key: s.key });
                        loadOrg();
                      } catch (err) { console.error(err); }
                    }}
                    title="Dismiss this suggestion"
                    aria-label="Dismiss this suggestion"
                    className="text-amber-600 hover:text-amber-800 hover:bg-amber-100 rounded p-1 leading-none"
                  >
                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                    </svg>
                  </button>
                </div>
              </div>
            ))}
          </div>
        );
      })()}

      {/* Tabs */}
      <div className="border-b border-gray-200 mb-6">
        <nav className="flex gap-6">
          {(['people', 'relationships', 'hire_history', 'timeline', 'details', 'excess', 'issues', 'held', 'storage', 'pcns'] as const).map((tab) => {
            const relCount = (org.relationships || []).filter(r => r.status === 'active').length;
            // linked_job_count comes from the backend's UNION of job_organisations + jobs.client_id,
            // matching the Hire History tab content. Falls back to local linked_jobs.length only
            // if the backend hasn't been redeployed yet.
            const linkedJobCount = typeof org.linked_job_count === 'number'
              ? org.linked_job_count
              : (org.linked_jobs || []).length;
            const label = tab === 'people' ? `People (${(org.people || []).length})`
              : tab === 'relationships' ? `Relationships${relCount ? ` (${relCount})` : ''}`
              : tab === 'hire_history' ? `Hire History${linkedJobCount ? ` (${linkedJobCount})` : ''}`
              : tab === 'timeline' ? 'Activity Timeline'
              : tab === 'excess' ? 'Excess History'
              : tab === 'issues' ? `Issues${issuesCount ? ` (${issuesCount})` : ''}`
              : tab === 'held' ? 'Held Items'
              : tab === 'storage' ? 'Storage'
              : tab === 'pcns' ? (pcnCount ? `PCNs (${pcnCount})` : 'PCNs')
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
          {/* Add person */}
          {!showAddPerson ? (
            <button
              onClick={() => setShowAddPerson(true)}
              className="bg-ooosh-600 text-white px-4 py-2 rounded text-sm font-medium hover:bg-ooosh-700 transition-colors"
            >
              + Add Person
            </button>
          ) : (
            <form onSubmit={handleAddPerson} className="bg-white rounded-xl shadow-sm border border-gray-200 p-4">
              <h3 className="text-sm font-semibold text-gray-700 mb-3">Add Person to {org.name}</h3>

              {personError && (
                <div className="mb-3 bg-red-50 border border-red-200 text-red-700 px-3 py-2 rounded text-xs">{personError}</div>
              )}

              {personSelected ? (
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium text-gray-900 bg-ooosh-50 px-2 py-1 rounded">{personSelected.name}</span>
                  <button
                    type="button"
                    onClick={() => { setPersonSelected(null); setPersonSearch(''); }}
                    className="text-xs text-gray-400 hover:text-gray-600"
                  >
                    Change
                  </button>
                </div>
              ) : creatingNew ? (
                <>
                  <div className="flex items-center justify-between mb-2">
                    <p className="text-xs text-gray-500">Creating a new person record</p>
                    <button
                      type="button"
                      onClick={() => { setCreatingNew(false); setNewPersonFirst(''); setNewPersonLast(''); setNewPersonEmail(''); setNewPersonMobile(''); setPersonError(''); }}
                      className="text-xs text-gray-400 hover:text-gray-600"
                    >
                      Back to search
                    </button>
                  </div>
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className="block text-xs font-medium text-gray-500 uppercase mb-1">First Name *</label>
                      <input
                        value={newPersonFirst}
                        onChange={e => setNewPersonFirst(e.target.value)}
                        autoFocus
                        className="w-full rounded border border-gray-300 px-3 py-2 text-sm focus:border-ooosh-500 focus:outline-none focus:ring-1 focus:ring-ooosh-500"
                      />
                    </div>
                    <div>
                      <label className="block text-xs font-medium text-gray-500 uppercase mb-1">Last Name *</label>
                      <input
                        value={newPersonLast}
                        onChange={e => setNewPersonLast(e.target.value)}
                        className="w-full rounded border border-gray-300 px-3 py-2 text-sm focus:border-ooosh-500 focus:outline-none focus:ring-1 focus:ring-ooosh-500"
                      />
                    </div>
                    <div>
                      <label className="block text-xs font-medium text-gray-500 uppercase mb-1">Email</label>
                      <input
                        type="email"
                        value={newPersonEmail}
                        onChange={e => setNewPersonEmail(e.target.value)}
                        className="w-full rounded border border-gray-300 px-3 py-2 text-sm focus:border-ooosh-500 focus:outline-none focus:ring-1 focus:ring-ooosh-500"
                      />
                    </div>
                    <div>
                      <label className="block text-xs font-medium text-gray-500 uppercase mb-1">Mobile</label>
                      <input
                        value={newPersonMobile}
                        onChange={e => setNewPersonMobile(e.target.value)}
                        className="w-full rounded border border-gray-300 px-3 py-2 text-sm focus:border-ooosh-500 focus:outline-none focus:ring-1 focus:ring-ooosh-500"
                      />
                    </div>
                  </div>
                </>
              ) : (
                <div className="relative">
                  <input
                    value={personSearch}
                    onChange={e => setPersonSearch(e.target.value)}
                    placeholder="Search for a person..."
                    autoFocus
                    className="w-full rounded border border-gray-300 px-3 py-2 text-sm focus:border-ooosh-500 focus:outline-none focus:ring-1 focus:ring-ooosh-500"
                  />
                  {personSearch.trim().length >= 2 && (
                    <div className="absolute top-full left-0 right-0 mt-1 bg-white border border-gray-200 rounded shadow-lg max-h-64 overflow-y-auto z-10">
                      {personResults.map(p => (
                        <button
                          key={p.id}
                          type="button"
                          onClick={() => {
                            setPersonSelected({ id: p.id, name: `${p.first_name} ${p.last_name}`.trim() });
                            setPersonResults([]);
                            setPersonSearch('');
                          }}
                          className="w-full text-left px-3 py-2 text-sm hover:bg-gray-50 flex items-center justify-between gap-2 border-b border-gray-100"
                        >
                          <span className="font-medium">{p.first_name} {p.last_name}</span>
                          {p.email && <span className="text-xs text-gray-400 truncate">{p.email}</span>}
                        </button>
                      ))}
                      <button
                        type="button"
                        onClick={() => startCreateNew(personSearch)}
                        className="w-full text-left px-3 py-2 text-sm hover:bg-ooosh-50 text-ooosh-600 flex items-center gap-2"
                      >
                        <span className="font-medium">+ Create new:</span>
                        <span>{personSearch.trim()}</span>
                        {personResults.length > 0 && (
                          <span className="text-xs text-gray-400 ml-auto">use this if none of the above are right</span>
                        )}
                      </button>
                    </div>
                  )}
                </div>
              )}

              <div className="mt-4">
                <label className="block text-xs font-medium text-gray-500 uppercase mb-1">Role / Title *</label>
                <select
                  value={personRole}
                  onChange={e => setPersonRole(e.target.value)}
                  className="w-full rounded border border-gray-300 px-3 py-2 text-sm focus:border-ooosh-500 focus:outline-none focus:ring-1 focus:ring-ooosh-500"
                >
                  <option value="">Select a role...</option>
                  {PERSON_ORG_ROLES_WITH_MAIN_CONTACT.map(r => (
                    <option key={r} value={r}>{r}</option>
                  ))}
                </select>
              </div>

              <label className="flex items-center gap-2 mt-3 cursor-pointer">
                <input
                  type="checkbox"
                  checked={personIsPrimary}
                  onChange={e => setPersonIsPrimary(e.target.checked)}
                  className="rounded border-gray-300 text-ooosh-600 focus:ring-ooosh-500"
                />
                <span className="text-sm text-gray-700">Primary contact at this organisation</span>
              </label>

              <div className="flex gap-2 mt-4">
                <button
                  type="submit"
                  disabled={personSaving}
                  className="bg-ooosh-600 text-white px-4 py-1.5 rounded text-sm font-medium hover:bg-ooosh-700 transition-colors disabled:opacity-50"
                >
                  {personSaving ? 'Saving...' : 'Add Person'}
                </button>
                <button
                  type="button"
                  onClick={resetAddPersonForm}
                  className="px-4 py-1.5 text-sm border border-gray-300 rounded hover:bg-gray-50"
                >
                  Cancel
                </button>
              </div>
            </form>
          )}

          {activePeople.length > 0 && (
            <div>
              <h3 className="text-sm font-semibold text-gray-700 mb-3">Current</h3>
              <div className="bg-white rounded-xl shadow-sm border border-gray-200 overflow-x-auto">
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
                          {editingPersonRoleId === p.id ? (
                            <div className="flex items-center gap-2">
                              <select
                                value={editPersonRole}
                                onChange={e => setEditPersonRole(e.target.value)}
                                className="rounded border border-gray-300 px-2 py-1 text-sm focus:border-ooosh-500 focus:outline-none focus:ring-1 focus:ring-ooosh-500"
                              >
                                <option value="">Select a role...</option>
                                {PERSON_ORG_ROLES_WITH_MAIN_CONTACT.map(r => (
                                  <option key={r} value={r}>{r}</option>
                                ))}
                                {editPersonRole && !PERSON_ORG_ROLES_WITH_MAIN_CONTACT.includes(editPersonRole) && (
                                  <option value={editPersonRole}>{editPersonRole}</option>
                                )}
                              </select>
                              <button
                                type="button"
                                onClick={() => handleEditPersonRole(p.person_id, p.id)}
                                disabled={!editPersonRole.trim() || editPersonRoleSaving}
                                className="text-xs bg-ooosh-600 text-white px-2 py-1 rounded hover:bg-ooosh-700 disabled:opacity-50"
                              >
                                {editPersonRoleSaving ? 'Saving...' : 'Save'}
                              </button>
                              <button type="button" onClick={() => setEditingPersonRoleId(null)} className="text-xs text-gray-500 hover:text-gray-700 underline">Cancel</button>
                            </div>
                          ) : (
                          <>
                          <span className="text-sm text-gray-700">{p.role}</span>
                          <button
                            type="button"
                            onClick={() => { setEditingPersonRoleId(p.id); setEditPersonRole(p.role); }}
                            className="ml-2 text-xs text-gray-500 hover:text-ooosh-700 underline"
                          >
                            Edit
                          </button>
                          {p.is_primary ? (
                            <>
                              <span className="ml-2 text-xs bg-ooosh-100 text-ooosh-700 px-1.5 py-0.5 rounded-full">Primary</span>
                              <button
                                type="button"
                                onClick={() => handleTogglePrimary(p.id, false)}
                                className="ml-2 text-xs text-gray-500 hover:text-gray-700 underline"
                                title="Remove primary status"
                              >
                                Remove primary
                              </button>
                            </>
                          ) : (
                            <button
                              type="button"
                              onClick={() => handleTogglePrimary(p.id, true)}
                              className="ml-2 text-xs text-ooosh-600 hover:text-ooosh-700 underline"
                              title="Make this the primary contact for the organisation"
                            >
                              Make primary
                            </button>
                          )}
                          <button
                            type="button"
                            onClick={() => setEndingPersonRole({ roleId: p.id, personId: p.person_id, personName: p.person_name, role: p.role })}
                            className="ml-2 text-xs text-red-600 hover:text-red-700 underline"
                            title="End this person's role at the organisation (kept as historical for the audit trail)"
                          >
                            End role
                          </button>
                          </>
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

          {!org.people?.length && !showAddPerson && (
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

      {/* End person role confirmation modal */}
      {endingPersonRole && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <div className="bg-white rounded-xl shadow-xl w-full max-w-md mx-4 p-6">
            <h3 className="text-lg font-semibold text-gray-900 mb-2">End Role</h3>
            <p className="text-sm text-gray-600 mb-4">
              End <strong>{endingPersonRole.personName}'s</strong> role as <strong>{endingPersonRole.role}</strong> at <strong>{org.name}</strong>?
              This is marked as historical with today's date — the person stays on record under "Historical", not deleted.
            </p>

            <div className="mb-4">
              <label className="block text-xs font-medium text-gray-500 uppercase mb-1">Reason (optional)</label>
              <input
                type="text"
                value={endPersonReason}
                onChange={(e) => setEndPersonReason(e.target.value)}
                placeholder="e.g. No longer manages the band, left the company..."
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:ring-ooosh-500 focus:border-ooosh-500"
              />
            </div>

            <div className="flex justify-end gap-2 pt-4 border-t mt-4">
              <button
                onClick={() => { setEndingPersonRole(null); setEndPersonReason(''); }}
                className="px-4 py-2 text-sm border border-gray-300 rounded-lg hover:bg-gray-50"
              >
                Cancel
              </button>
              <button
                onClick={handleEndPersonRoleConfirmed}
                disabled={endingPersonSaving}
                className="px-4 py-2 text-sm bg-red-600 text-white rounded-lg hover:bg-red-700 disabled:opacity-50"
              >
                {endingPersonSaving ? 'Saving...' : 'End Role'}
              </button>
            </div>
          </div>
        </div>
      )}

      {activeTab === 'relationships' && (
        <div className="space-y-6">
          {/* Add relationship button */}
          <div className="flex justify-end">
            <button
              onClick={() => { setShowAddRelationship(true); setRelSelectedOrg(null); setRelOrgSearch(''); setRelCreating(false); setRelNewName(''); }}
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
                      const isFrom = rel.from_org_id === id;
                      return (
                        <div key={rel.id} className="px-6 py-4 flex items-center justify-between">
                          <div className="flex items-center gap-3 flex-wrap">
                            {editingRelId === rel.id ? (
                              <select
                                value={editRelType}
                                onChange={e => setEditRelType(e.target.value as OrgRelationshipType)}
                                className="text-sm rounded border border-gray-300 px-2 py-1 focus:border-ooosh-500 focus:outline-none focus:ring-1 focus:ring-ooosh-500"
                              >
                                {Object.entries(ORG_RELATIONSHIP_LABELS).map(([key, labels]) => (
                                  <option key={key} value={key}>{isFrom ? labels.forward : labels.reverse}</option>
                                ))}
                              </select>
                            ) : (
                              <span className="text-sm text-gray-500 w-36">{label}</span>
                            )}
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
                          {editingRelId === rel.id ? (
                            <div className="flex items-center gap-2">
                              <button
                                onClick={() => handleEditRelationship(rel.id)}
                                disabled={editRelSaving}
                                className="text-xs bg-ooosh-600 text-white px-2 py-1 rounded hover:bg-ooosh-700 disabled:opacity-50"
                              >
                                {editRelSaving ? 'Saving...' : 'Save'}
                              </button>
                              <button onClick={() => setEditingRelId(null)} className="text-xs text-gray-500 hover:text-gray-700 underline">Cancel</button>
                            </div>
                          ) : (
                            <div className="flex items-center gap-3">
                              <button
                                onClick={() => { setEditingRelId(rel.id); setEditRelType(rel.relationship_type as OrgRelationshipType); }}
                                className="text-xs text-gray-400 hover:text-ooosh-600 transition-colors"
                              >
                                Edit
                              </button>
                              <button
                                onClick={() => handleDeleteRelationship(rel.id)}
                                className="text-xs text-gray-400 hover:text-red-500 transition-colors"
                                title="End this relationship (kept as historical for the audit trail)"
                              >
                                End
                              </button>
                            </div>
                          )}
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

            {/* Relationship type — chosen up front so a new org's type can be
                inferred from it. Visible across both steps. */}
            <label className="block text-sm font-medium text-gray-700 mb-1">Relationship type</label>
            <select
              value={relType}
              onChange={(e) => setRelType(e.target.value as OrgRelationshipType)}
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm mb-4"
            >
              {Object.entries(ORG_RELATIONSHIP_LABELS).map(([key, labels]) => (
                <option key={key} value={key}>{labels.forward}</option>
              ))}
            </select>

            {/* Step 1: Search / create org */}
            {!relSelectedOrg ? (
              relCreating ? (
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">New organisation name</label>
                  <input
                    type="text"
                    value={relNewName}
                    onChange={(e) => setRelNewName(e.target.value)}
                    placeholder="Organisation name"
                    className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm mb-3 focus:ring-ooosh-500 focus:border-ooosh-500"
                    autoFocus
                  />
                  <label className="block text-sm font-medium text-gray-700 mb-1">Type</label>
                  <select
                    value={relNewType}
                    onChange={(e) => setRelNewType(e.target.value)}
                    className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm mb-2"
                  >
                    {ORG_TYPE_OPTIONS.map((t) => (
                      <option key={t} value={t}>{t.replace(/_/g, ' ')}</option>
                    ))}
                  </select>
                  <p className="text-xs text-gray-400 mb-3">Just name + type for now — add full details later on the new org's page.</p>
                  <button
                    onClick={() => setRelCreating(false)}
                    className="text-xs text-gray-500 hover:text-gray-700"
                  >
                    ← Back to search
                  </button>
                </div>
              ) : (
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

                  {/* No match → offer to create */}
                  {relOrgSearch.trim().length >= 2 && relOrgResults.length === 0 && (
                    <button
                      onClick={startCreateOrg}
                      className="mt-2 w-full text-left px-4 py-3 border border-dashed border-ooosh-300 rounded-lg text-sm text-ooosh-700 hover:bg-ooosh-50"
                    >
                      + Create <strong>{relOrgSearch.trim()}</strong> as a new organisation
                    </button>
                  )}

                  {/* Quick associate — orgs connected via a shared person, not yet linked */}
                  {!relOrgSearch.trim() && relSuggestions.length > 0 && (
                    <div className="mt-4">
                      <p className="text-xs font-medium text-gray-500 mb-2">Quick associate — connected via shared people</p>
                      <div className="flex flex-wrap gap-2">
                        {relSuggestions.map((s) => (
                          <button
                            key={s.id}
                            onClick={() => setRelSelectedOrg({ id: s.id, name: s.name, type: s.type })}
                            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full border border-gray-200 text-xs hover:bg-gray-50"
                            title={`via ${s.via_person}`}
                          >
                            <span className="font-medium text-gray-900">{s.name}</span>
                            <span className={`inline-flex px-1.5 py-0.5 rounded-full ${typeColors[s.type] || 'bg-gray-100 text-gray-700'}`}>{s.type}</span>
                          </button>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* Manual create fallback (before typing) */}
                  {relOrgSearch.trim().length < 2 && (
                    <button
                      onClick={startCreateOrg}
                      className="mt-3 text-xs text-ooosh-600 hover:text-ooosh-700 font-medium"
                    >
                      + Create a new organisation instead
                    </button>
                  )}
                </div>
              )
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
                onClick={resetRelationshipModal}
                className="px-4 py-2 text-sm border border-gray-300 rounded-lg hover:bg-gray-50"
              >
                Cancel
              </button>
              {relCreating && !relSelectedOrg && (
                <button
                  onClick={handleCreateOrgForRelationship}
                  disabled={relSaving || !relNewName.trim()}
                  className="px-4 py-2 text-sm bg-ooosh-600 text-white rounded-lg hover:bg-ooosh-700 disabled:opacity-50"
                >
                  {relSaving ? 'Creating...' : 'Create & continue'}
                </button>
              )}
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

      {/* Hire History Tab */}
      {activeTab === 'hire_history' && id && (
        <HireHistoryTab entityType="organisation" entityId={id} />
      )}

      {/* Excess History Tab */}
      {activeTab === 'excess' && id && (
        <ExcessHistorySection entityType="organisation" entityId={id} />
      )}

      {/* Held Items Tab — Holding module (incoming / temp storage / lost property) */}
      {activeTab === 'held' && id && (
        <HeldItemsSection entityType="organisation" entityId={id} />
      )}

      {/* Storage Tab — Client Storage module (recurring storage tenancies) */}
      {activeTab === 'storage' && id && (
        <StorageHistorySection entityType="organisation" entityId={id} />
      )}

      {/* Issues Tab — OP job_issues backed (Stage 3, May 2026).
          Endpoint /api/problems/by-organisation/:id already provided
          by the backend. Reuses the shared IssuesListSection. */}
      {activeTab === 'issues' && id && (
        <IssuesListSection entityType="organisation" entityId={id} onCount={setIssuesCount} />
      )}

      {/* PCNs Tab — penalty charge notices where this org is the client/hirer */}
      {activeTab === 'pcns' && id && (
        <PcnHistorySection entityType="organisation" entityId={id} onCount={(_open, total) => setPcnCount(total)} />
      )}

      {/* Edit Panel */}
      <SlidePanel open={showEdit} onClose={() => setShowEdit(false)} title="Edit Organisation">
        <OrganisationForm
          orgId={id}
          onSaved={() => { setShowEdit(false); loadOrg(); }}
          onCancel={() => setShowEdit(false)}
        />
      </SlidePanel>

      {/* Merge Modal */}
      {showMergeModal && id && org && (
        <OrganisationMergeModal
          loserId={id}
          loserName={org.name}
          onClose={() => setShowMergeModal(false)}
          onMerged={(keeperId) => {
            setShowMergeModal(false);
            navigate(`/organisations/${keeperId}`);
          }}
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
