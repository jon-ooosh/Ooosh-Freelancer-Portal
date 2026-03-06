import { useState, useEffect } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import { api } from '../services/api';
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
  parent_name: string | null;
  parent_id: string | null;
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
}

interface Interaction {
  id: string;
  type: string;
  content: string;
  created_at: string;
  created_by_name: string | null;
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

const interactionTypeColors: Record<string, string> = {
  note: 'bg-blue-100 text-blue-700',
  call: 'bg-green-100 text-green-700',
  email: 'bg-purple-100 text-purple-700',
  meeting: 'bg-amber-100 text-amber-700',
  mention: 'bg-pink-100 text-pink-700',
};

const interactionTypeIcons: Record<string, string> = {
  note: 'N', call: 'C', email: 'E', meeting: 'M', mention: '@',
};

export default function OrganisationDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const user = useAuthStore((s) => s.user);

  const [org, setOrg] = useState<OrgDetail | null>(null);
  const [interactions, setInteractions] = useState<Interaction[]>([]);
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState<'timeline' | 'people' | 'details'>('people');

  const [newNote, setNewNote] = useState('');
  const [newNoteType, setNewNoteType] = useState<string>('note');
  const [submitting, setSubmitting] = useState(false);

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

  async function handleAddInteraction(e: React.FormEvent) {
    e.preventDefault();
    if (!newNote.trim() || submitting) return;

    setSubmitting(true);
    try {
      await api.post('/interactions', {
        type: newNoteType,
        content: newNote.trim(),
        organisation_id: id,
      });
      setNewNote('');
      loadInteractions();
    } catch (err) {
      console.error('Failed to add interaction:', err);
    } finally {
      setSubmitting(false);
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
          <div className="text-right text-sm text-gray-500">
            {activePeople.length} active {activePeople.length === 1 ? 'person' : 'people'}
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

      {/* Tabs */}
      <div className="border-b border-gray-200 mb-6">
        <nav className="flex gap-6">
          {(['people', 'timeline', 'details'] as const).map((tab) => (
            <button
              key={tab}
              onClick={() => setActiveTab(tab)}
              className={`pb-3 text-sm font-medium border-b-2 transition-colors ${
                activeTab === tab
                  ? 'border-ooosh-600 text-ooosh-600'
                  : 'border-transparent text-gray-500 hover:text-gray-700'
              }`}
            >
              {tab === 'people' ? `People (${(org.people || []).length})` : tab === 'timeline' ? 'Activity Timeline' : 'Details'}
            </button>
          ))}
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

      {activeTab === 'timeline' && (
        <div>
          <form onSubmit={handleAddInteraction} className="bg-white rounded-xl shadow-sm border border-gray-200 p-4 mb-6">
            <div className="flex gap-3 mb-3">
              {(['note', 'call', 'email', 'meeting'] as const).map((t) => (
                <button
                  key={t}
                  type="button"
                  onClick={() => setNewNoteType(t)}
                  className={`px-3 py-1 rounded-full text-xs font-medium transition-colors ${
                    newNoteType === t ? interactionTypeColors[t] : 'bg-gray-100 text-gray-500 hover:bg-gray-200'
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
              className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-ooosh-500 focus:outline-none focus:ring-1 focus:ring-ooosh-500 resize-none"
            />
            <div className="flex justify-between items-center mt-2">
              <span className="text-xs text-gray-400">Posting as {user?.first_name} {user?.last_name}</span>
              <button
                type="submit"
                disabled={!newNote.trim() || submitting}
                className="bg-ooosh-600 text-white px-4 py-1.5 rounded-lg text-sm font-medium hover:bg-ooosh-700 transition-colors disabled:opacity-50"
              >
                {submitting ? 'Saving...' : 'Add'}
              </button>
            </div>
          </form>

          {interactions.length === 0 ? (
            <p className="text-center text-sm text-gray-400 py-8">No activity yet.</p>
          ) : (
            <div className="space-y-4">
              {interactions.map((interaction) => (
                <div key={interaction.id} className="bg-white rounded-xl shadow-sm border border-gray-200 p-4">
                  <div className="flex items-start gap-3">
                    <div className={`w-8 h-8 rounded-full flex items-center justify-center text-xs font-bold flex-shrink-0 ${interactionTypeColors[interaction.type] || 'bg-gray-100 text-gray-600'}`}>
                      {interactionTypeIcons[interaction.type] || '?'}
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
            <DetailField label="Type" value={org.type} />
            <DetailField label="Location" value={org.location} />
            <DetailField label="Email" value={org.email} />
            <DetailField label="Phone" value={org.phone} />
            <DetailField label="Website" value={org.website} />
            <DetailField label="Address" value={org.address} />
            <DetailField label="Created" value={formatDate(org.created_at)} />
          </div>
          {org.notes && (
            <div className="mt-6 pt-4 border-t">
              <h3 className="text-sm font-semibold text-gray-700 mb-2">Notes</h3>
              <p className="text-sm text-gray-600 whitespace-pre-wrap">{org.notes}</p>
            </div>
          )}
        </div>
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
