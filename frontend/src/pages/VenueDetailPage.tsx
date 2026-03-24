import { useState, useEffect } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import { api } from '../services/api';
import SlidePanel from '../components/SlidePanel';
import VenueForm from '../components/VenueForm';
import FileUpload from '../components/FileUpload';
import ActivityTimeline from '../components/ActivityTimeline';

interface VenueDetail {
  id: string;
  name: string;
  organisation_id: string | null;
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
  files: Array<{ name: string; url: string; type: 'document' | 'image' | 'other'; uploaded_at: string; uploaded_by: string }>;
  created_at: string;
}

interface Interaction {
  id: string;
  type: string;
  content: string;
  created_at: string;
  created_by_name: string | null;
  mentioned_user_ids: string[];
}

export default function VenueDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();

  const [venue, setVenue] = useState<VenueDetail | null>(null);
  const [interactions, setInteractions] = useState<Interaction[]>([]);
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState<'info' | 'timeline'>('info');
  const [orgName, setOrgName] = useState<string | null>(null);

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
      if (data.organisation_id) {
        try {
          const org = await api.get<{ name: string }>(`/organisations/${data.organisation_id}`);
          setOrgName(org.name);
        } catch { setOrgName(null); }
      } else {
        setOrgName(null);
      }
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

  async function handleDelete() {
    try {
      await api.delete(`/venues/${id}`);
      navigate('/venues');
    } catch (err) {
      console.error('Failed to delete venue:', err);
    }
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
            {venue.organisation_id && orgName && (
              <p className="mt-1 text-sm text-gray-500">
                <Link to={`/organisations/${venue.organisation_id}`} className="text-ooosh-600 hover:text-ooosh-700">{orgName}</Link>
              </p>
            )}
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
                {Number(venue.default_drive_time_mins) >= 60
                  ? `${Math.floor(Number(venue.default_drive_time_mins) / 60)}h ${Number(venue.default_drive_time_mins) % 60}m`
                  : `${venue.default_drive_time_mins} min`}
              </span>
            </div>
          )}
          {venue.default_return_cost != null && (
            <div>
              <span className="text-gray-500">Return cost:</span>{' '}
              <span className="font-medium text-gray-900">£{Number(venue.default_return_cost).toFixed(2)}</span>
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

          <div className="bg-white rounded-xl shadow-sm border border-gray-200 p-6">
            <FileUpload
              entityType="venues"
              entityId={venue.id}
              files={venue.files || []}
              onFilesChanged={(files) => setVenue(prev => prev ? { ...prev, files } : prev)}
              onActivityCreated={loadInteractions}
            />
          </div>
        </div>
      )}

      {activeTab === 'timeline' && id && (
        <ActivityTimeline
          entityType="venue_id"
          entityId={id}
          interactions={interactions}
          onInteractionAdded={loadInteractions}
        />
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
