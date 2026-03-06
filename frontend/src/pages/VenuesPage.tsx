import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../services/api';

interface Venue {
  id: string;
  name: string;
  city: string | null;
  postcode: string | null;
  country: string | null;
  loading_bay_info: string | null;
}

interface VenuesResponse {
  data: Venue[];
  pagination: { page: number; limit: number; total: number; totalPages: number };
}

export default function VenuesPage() {
  const [venues, setVenues] = useState<Venue[]>([]);
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(true);
  const [pagination, setPagination] = useState({ page: 1, total: 0, totalPages: 0 });
  const navigate = useNavigate();

  useEffect(() => {
    loadVenues();
  }, [search]);

  async function loadVenues(page = 1) {
    setLoading(true);
    try {
      const params = new URLSearchParams({ page: String(page), limit: '50' });
      if (search) params.set('search', search);

      const data = await api.get<VenuesResponse>(`/venues?${params}`);
      setVenues(data.data);
      setPagination(data.pagination);
    } catch (err) {
      console.error('Failed to load venues:', err);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div>
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Venues</h1>
          <p className="mt-1 text-sm text-gray-500">{pagination.total} venues</p>
        </div>
        <button className="bg-ooosh-600 text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-ooosh-700 transition-colors">
          Add Venue
        </button>
      </div>

      <div className="mt-6">
        <input
          type="text"
          placeholder="Search venues by name, address, or city..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="w-full max-w-md rounded-lg border border-gray-300 px-4 py-2 text-sm shadow-sm focus:border-ooosh-500 focus:outline-none focus:ring-1 focus:ring-ooosh-500"
        />
      </div>

      <div className="mt-6 grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {loading ? (
          <p className="col-span-full text-center text-sm text-gray-500 py-8">Loading...</p>
        ) : venues.length === 0 ? (
          <p className="col-span-full text-center text-sm text-gray-500 py-8">No venues found.</p>
        ) : (
          venues.map((venue) => (
            <div
              key={venue.id}
              onClick={() => navigate(`/venues/${venue.id}`)}
              className="bg-white rounded-xl shadow-sm border border-gray-200 p-5 hover:border-ooosh-300 cursor-pointer transition-colors"
            >
              <h3 className="font-semibold text-gray-900">{venue.name}</h3>
              <p className="mt-1 text-sm text-gray-500">
                {[venue.city, venue.postcode, venue.country].filter(Boolean).join(', ') || 'No address'}
              </p>
              {venue.loading_bay_info && (
                <p className="mt-3 text-xs text-gray-400 line-clamp-2">
                  Loading: {venue.loading_bay_info}
                </p>
              )}
            </div>
          ))
        )}
      </div>
    </div>
  );
}
