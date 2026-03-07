import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../services/api';
import SlidePanel from '../components/SlidePanel';
import OrganisationForm from '../components/OrganisationForm';

interface Organisation {
  id: string;
  name: string;
  type: string;
  email: string | null;
  phone: string | null;
  active_people_count: string;
  parent_name: string | null;
}

interface OrgsResponse {
  data: Organisation[];
  pagination: { page: number; limit: number; total: number; totalPages: number };
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

export default function OrganisationsPage() {
  const [orgs, setOrgs] = useState<Organisation[]>([]);
  const [search, setSearch] = useState('');
  const [typeFilter, setTypeFilter] = useState('');
  const [loading, setLoading] = useState(true);
  const [pagination, setPagination] = useState({ page: 1, total: 0, totalPages: 0 });
  const [showForm, setShowForm] = useState(false);
  const navigate = useNavigate();

  useEffect(() => {
    loadOrgs();
  }, [search, typeFilter]);

  async function loadOrgs(page = 1) {
    setLoading(true);
    try {
      const params = new URLSearchParams({ page: String(page), limit: '50' });
      if (search) params.set('search', search);
      if (typeFilter) params.set('type', typeFilter);

      const data = await api.get<OrgsResponse>(`/organisations?${params}`);
      setOrgs(data.data);
      setPagination(data.pagination);
    } catch (err) {
      console.error('Failed to load organisations:', err);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div>
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Organisations</h1>
          <p className="mt-1 text-sm text-gray-500">{pagination.total} organisations</p>
        </div>
        <button
          onClick={() => setShowForm(true)}
          className="bg-ooosh-600 text-white px-4 py-2 rounded text-sm font-medium hover:bg-ooosh-700 transition-colors"
        >
          Add Organisation
        </button>
      </div>

      <div className="mt-6 flex gap-4">
        <input
          type="text"
          placeholder="Search organisations..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="w-full max-w-md rounded border border-gray-300 px-4 py-2 text-sm shadow-sm focus:border-ooosh-500 focus:outline-none focus:ring-1 focus:ring-ooosh-500"
        />
        <select
          value={typeFilter}
          onChange={(e) => setTypeFilter(e.target.value)}
          className="rounded border border-gray-300 px-3 py-2 text-sm shadow-sm focus:border-ooosh-500 focus:outline-none"
        >
          <option value="">All types</option>
          <option value="band">Band</option>
          <option value="management">Management</option>
          <option value="label">Label</option>
          <option value="agency">Agency</option>
          <option value="promoter">Promoter</option>
          <option value="venue">Venue</option>
          <option value="festival">Festival</option>
          <option value="supplier">Supplier</option>
        </select>
      </div>

      <div className="mt-6 bg-white rounded-xl shadow-sm border border-gray-200 overflow-hidden">
        <table className="min-w-full divide-y divide-gray-200">
          <thead className="bg-gray-50">
            <tr>
              <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Name</th>
              <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Type</th>
              <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">People</th>
              <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Parent</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-200">
            {loading ? (
              <tr><td colSpan={4} className="px-6 py-8 text-center text-sm text-gray-500">Loading...</td></tr>
            ) : orgs.length === 0 ? (
              <tr><td colSpan={4} className="px-6 py-8 text-center text-sm text-gray-500">No organisations found.</td></tr>
            ) : (
              orgs.map((org) => (
                <tr key={org.id} onClick={() => navigate(`/organisations/${org.id}`)} className="hover:bg-gray-50 cursor-pointer transition-colors">
                  <td className="px-6 py-4 text-sm font-medium text-gray-900">{org.name}</td>
                  <td className="px-6 py-4">
                    <span className={`inline-flex px-2 py-0.5 rounded-full text-xs ${typeColors[org.type] || 'bg-gray-100 text-gray-700'}`}>
                      {org.type}
                    </span>
                  </td>
                  <td className="px-6 py-4 text-sm text-gray-500">{org.active_people_count}</td>
                  <td className="px-6 py-4 text-sm text-gray-500">{org.parent_name || '—'}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {/* Add Organisation Panel */}
      <SlidePanel open={showForm} onClose={() => setShowForm(false)} title="Add Organisation">
        <OrganisationForm
          onSaved={() => { setShowForm(false); loadOrgs(); }}
          onCancel={() => setShowForm(false)}
        />
      </SlidePanel>
    </div>
  );
}
