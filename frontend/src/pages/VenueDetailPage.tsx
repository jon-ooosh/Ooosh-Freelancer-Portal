import { useState, useEffect } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import { api } from '../services/api';
import { useAuthStore } from '../hooks/useAuthStore';
import SlidePanel from '../components/SlidePanel';
import VenueForm from '../components/VenueForm';

interface VenueDetail {
  id: string;
  name: string;
  address: string | null;
  city: string | null;
  postcode: string | null;
  country: string | null;
  w3w_address: string | null;
  load_in_address: string | null;
  loading_bay_info: string | null;
  access_codes: string | null;
  parking_info: string | null;
  approach_notes: string | null;
  technical_notes: string | null;
  general_notes: string | null;
  default_miles_from_base: number | null;
  default_drive_time_mins: number | null;
  default_return_cost: number | null;
  tags: string[];
  created_at: string;
}

interface Interaction {
  id: string;
  type: string;
  content: string;
  created_at: string;
  created_by_name: string | null;
}

const interactionTypeColors: Record<string, string> = {
  note: 'bg-blue-100 text-blue-700',
  call: 'bg-green-100 text-green-700',
  email: 'bg-purple-100 text-purple-700',
  meeting: 'bg-amber-100 text-amber-700',
};

const interactionTypeIcons: Record<string, string> = {
  note: 'N', call: 'C', email: 'E', meeting: 'M',
};

export default function VenueDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const user = useAuthStore((s) => s.user);

  const [venue, setVenue] = useState<VenueDetail | null>(null);
  const [interactions, setInteractions] = useState<Interaction[]>([]);
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState<'info' | 'timeline'>('info');

  const [newNote, setNewNote] = useState('');
  const [submitting, setSubmitting] = useState(false);

  // Edit/delete
  const [showEdit, setShowEdit] = useState(false);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);

  useEffect(() => {
    if (id) {
      loadVenue();
      loadInteractions();
    }
  }, [id]);

  async function loadVenue() {
    try {
      const data = await api.get<VenueDetail>(`/venues/${id}`);
      setVenue(data);
    } catch {
      navigate('/venues');
    } finally {
      setLoading(false);
    }
  }

  async function loadInteractions() {
    try {
      const data = await api.get<{ data: Interaction[] }>(`/interactions?venue_id=${id}`);
      setInteractions(data.data);
    } catch (err) {
      console.error('Failed to load interactions:', err);
    }
  }

  async function handleAddNote(e: React.FormEvent) {
    e.preventDefault();
    if (!newNote.trim() || submitting) return;

    setSubmitting(true);
    try {
      await api.post('/interactions', {
        type: 'note',
        content: newNote.trim(),
        venue_id: id,
      });
      setNewNote('');
      loadInteractions();
    } catch (err) {
      console.error('Failed to add note:', err);
    } finally {
      setSubmitting(false);
    }
  }

  async function handleDelete() {
    try {
      await api.delete(`/venues/${id}`);
      navigate('/venues');
    } catch (err) {
      console.error('Failed to delete venue:', err);
    }
  }

  function formatDateTime(dateStr: string) {
    return new Date(dateStr).toLocaleDateString('en-GB', {
      day: 'numeric', month: 'short', year: 'numeric',
      hour: '2-digit', minute: '2-digit',
    });
  }

  if (loading) return <div className="text-center py-12 text-gray-500">Loading...</div>;
  if (!venue) return <div className="text-center py-12 text-gray-500">Venue not found.</div>;

  const fullAddress = [venue.address, venue.city, venue.postcode, venue.country].filter(Boolean).join(', ');

  return (
    <div>
      <Link to="/venues" className="text-sm text-ooosh-600 hover:text-ooosh-700 mb-4 inline-block">
        &larr; Back to Venues
      </Link>

      {/* Header */}
      <div className="bg-white rounded-xl shadow-sm border border-gray-200 p-6 mb-6">
        <div className="flex items-start justify-between">
          <div>
            <h1 className="text-2xl font-bold text-gray-900">{venue.name}</h1>
            {fullAddress && <p className="mt-1 text-sm text-gray-500">{fullAddress}</p>}
          </div>
          <div className="flex items-center gap-2">
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
                  <p className="text-sm text-gray-700 mb-2">Delete this venue?</p>
                  <div className="flex gap-2">
                    <button onClick={handleDelete} className="flex-1 bg-red-600 text-white px-3 py-1 rounded text-sm hover:bg-red-700">Yes, delete</button>
                    <button onClick={() => setShowDeleteConfirm(false)} className="flex-1 border border-gray-300 px-3 py-1 rounded text-sm hover:bg-gray-50">Cancel</button>
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>

        {/* Quick stats */}
        <div className="mt-4 flex flex-wrap gap-6 text-sm">
          {venue.default_miles_from_base != null && (
            <div>
              <span className="text-gray-500">Distance:</span>{' '}
              <span className="font-medium text-gray-900">{venue.default_miles_from_base} miles</span>
            </div>
          )}
          {venue.default_drive_time_mins != null && (
            <div>
              <span className="text-gray-500">Drive time:</span>{' '}
              <span className="font-medium text-gray-900">
                {venue.default_drive_time_mins >= 60
                  ? `${Math.floor(venue.default_drive_time_mins / 60)}h ${venue.default_drive_time_mins % 60}m`
                  : `${venue.default_drive_time_mins} min`}
              </span>
            </div>
          )}
          {venue.default_return_cost != null && (
            <div>
              <span className="text-gray-500">Return cost:</span>{' '}
              <span className="font-medium text-gray-900">£{venue.default_return_cost.toFixed(2)}</span>
            </div>
          )}
        </div>

        {venue.tags && venue.tags.length > 0 && (
          <div className="mt-3 flex flex-wrap gap-1">
            {venue.tags.map((tag) => (
              <span key={tag} className="inline-flex px-2 py-0.5 rounded text-xs bg-gray-100 text-gray-600">{tag}</span>
            ))}
          </div>
        )}
      </div>

      {/* Tabs */}
      <div className="border-b border-gray-200 mb-6">
        <nav className="flex gap-6">
          {(['info', 'timeline'] as const).map((tab) => (
            <button
              key={tab}
              onClick={() => setActiveTab(tab)}
              className={`pb-3 text-sm font-medium border-b-2 transition-colors ${
                activeTab === tab
                  ? 'border-ooosh-600 text-ooosh-600'
                  : 'border-transparent text-gray-500 hover:text-gray-700'
              }`}
            >
              {tab === 'info' ? 'Site Information' : 'Notes & Activity'}
            </button>
          ))}
        </nav>
      </div>

      {activeTab === 'info' && (
        <div className="space-y-6">
          <InfoSection title="Load-in & Access">
            <InfoBlock label="Load-in Address" value={venue.load_in_address} />
            <InfoBlock label="Loading Bay" value={venue.loading_bay_info} />
            <InfoBlock label="Access Codes" value={venue.access_codes} />
            <InfoBlock label="what3words" value={venue.w3w_address} />
          </InfoSection>

          <InfoSection title="Logistics">
            <InfoBlock label="Parking" value={venue.parking_info} />
            <InfoBlock label="Approach Notes" value={venue.approach_notes} />
          </InfoSection>

          {venue.technical_notes && (
            <InfoSection title="Technical Notes">
              <p className="text-sm text-gray-700 whitespace-pre-wrap">{venue.technical_notes}</p>
            </InfoSection>
          )}

          {venue.general_notes && (
            <InfoSection title="General Notes">
              <p className="text-sm text-gray-700 whitespace-pre-wrap">{venue.general_notes}</p>
            </InfoSection>
          )}
        </div>
      )}

      {activeTab === 'timeline' && (
        <div>
          <form onSubmit={handleAddNote} className="bg-white rounded-xl shadow-sm border border-gray-200 p-4 mb-6">
            <textarea
              value={newNote}
              onChange={(e) => setNewNote(e.target.value)}
              placeholder="Add a note about this venue..."
              rows={3}
              className="w-full rounded border border-gray-300 px-3 py-2 text-sm focus:border-ooosh-500 focus:outline-none focus:ring-1 focus:ring-ooosh-500 resize-none"
            />
            <div className="flex justify-between items-center mt-2">
              <span className="text-xs text-gray-400">Posting as {user?.first_name} {user?.last_name}</span>
              <button
                type="submit"
                disabled={!newNote.trim() || submitting}
                className="bg-ooosh-600 text-white px-4 py-1.5 rounded text-sm font-medium hover:bg-ooosh-700 transition-colors disabled:opacity-50"
              >
                {submitting ? 'Saving...' : 'Add Note'}
              </button>
            </div>
          </form>

          {interactions.length === 0 ? (
            <p className="text-center text-sm text-gray-400 py-8">No notes yet.</p>
          ) : (
            <div className="space-y-4">
              {interactions.map((interaction) => (
                <div key={interaction.id} className="bg-white rounded-xl shadow-sm border border-gray-200 p-4">
                  <div className="flex items-start gap-3">
                    <div className={`w-8 h-8 rounded-full flex items-center justify-center text-xs font-bold flex-shrink-0 ${interactionTypeColors[interaction.type] || 'bg-gray-100 text-gray-600'}`}>
                      {interactionTypeIcons[interaction.type] || 'N'}
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 text-xs text-gray-500">
                        <span className="font-medium text-gray-700">{interaction.created_by_name || 'System'}</span>
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

      {/* Edit Panel */}
      <SlidePanel open={showEdit} onClose={() => setShowEdit(false)} title="Edit Venue" wide>
        <VenueForm
          venueId={id}
          onSaved={() => { setShowEdit(false); loadVenue(); }}
          onCancel={() => setShowEdit(false)}
        />
      </SlidePanel>
    </div>
  );
}

function InfoSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="bg-white rounded-xl shadow-sm border border-gray-200 p-6">
      <h3 className="text-sm font-semibold text-gray-700 mb-4">{title}</h3>
      <div className="space-y-4">{children}</div>
    </div>
  );
}

function InfoBlock({ label, value }: { label: string; value: string | null | undefined }) {
  if (!value) return null;
  return (
    <div>
      <dt className="text-xs font-medium text-gray-500 uppercase tracking-wider">{label}</dt>
      <dd className="mt-1 text-sm text-gray-800 whitespace-pre-wrap">{value}</dd>
    </div>
  );
}
