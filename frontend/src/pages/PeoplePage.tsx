import { useState, useEffect } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { api } from '../services/api';
import SlidePanel from '../components/SlidePanel';
import PersonForm from '../components/PersonForm';

interface Person {
  id: string;
  first_name: string;
  last_name: string;
  email: string | null;
  mobile: string | null;
  tags: string[];
  last_interaction_at: string | null;
  current_organisations: Array<{
    id: string;
    organisation_name: string;
    role: string;
    is_primary: boolean;
  }> | null;
}

function timeAgo(dateStr: string): string {
  const days = Math.floor((Date.now() - new Date(dateStr).getTime()) / 86400000);
  if (days === 0) return 'Today';
  if (days === 1) return 'Yesterday';
  if (days < 30) return `${days}d ago`;
  if (days < 365) return `${Math.floor(days / 30)}mo ago`;
  return `${Math.floor(days / 365)}y ago`;
}

interface PeopleResponse {
  data: Person[];
  pagination: {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
  };
}

export default function PeoplePage() {
  const [people, setPeople] = useState<Person[]>([]);
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(true);
  const [pagination, setPagination] = useState({ page: 1, total: 0, totalPages: 0 });
  const [showForm, setShowForm] = useState(false);
  const [filterFreelancer, setFilterFreelancer] = useState(false);
  const [filterApproved, setFilterApproved] = useState(false);
  const [filterHasEmail, setFilterHasEmail] = useState(false);
  const [filterHasPhone, setFilterHasPhone] = useState(false);
  const [sortBy, setSortBy] = useState('name');
  const navigate = useNavigate();

  useEffect(() => {
    loadPeople();
  }, [search, filterFreelancer, filterApproved, filterHasEmail, filterHasPhone, sortBy]);

  async function loadPeople(page = 1) {
    setLoading(true);
    try {
      const params = new URLSearchParams({ page: String(page), limit: '50' });
      if (search) params.set('search', search);
      if (filterFreelancer) params.set('is_freelancer', 'true');
      if (filterApproved) params.set('is_approved', 'true');
      if (filterHasEmail) params.set('has_email', 'true');
      if (filterHasPhone) params.set('has_phone', 'true');
      if (sortBy !== 'name') params.set('sort', sortBy);

      const data = await api.get<PeopleResponse>(`/people?${params}`);
      setPeople(data.data);
      setPagination(data.pagination);
    } catch (err) {
      console.error('Failed to load people:', err);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div>
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">People</h1>
          <p className="mt-1 text-sm text-gray-500">
            {pagination.total} contacts
          </p>
        </div>
        <div className="flex items-center gap-3">
          <Link
            to="/people/duplicates"
            className="px-4 py-2 text-sm border border-gray-300 rounded hover:bg-gray-50 transition-colors text-gray-700"
          >
            Duplicates
          </Link>
          <button
            onClick={() => setShowForm(true)}
            className="bg-ooosh-600 text-white px-4 py-2 rounded text-sm font-medium hover:bg-ooosh-700 transition-colors"
          >
            Add Person
          </button>
        </div>
      </div>

      {/* Search & Filters */}
      <div className="mt-6 flex flex-wrap items-center gap-4">
        <input
          type="text"
          placeholder="Search people by name or email..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="w-full max-w-md rounded border border-gray-300 px-4 py-2 text-sm shadow-sm focus:border-ooosh-500 focus:outline-none focus:ring-1 focus:ring-ooosh-500"
        />
        <label className="flex items-center gap-1.5 cursor-pointer text-sm text-gray-600">
          <input
            type="checkbox"
            checked={filterFreelancer}
            onChange={(e) => setFilterFreelancer(e.target.checked)}
            className="rounded border-gray-300 text-ooosh-600 focus:ring-ooosh-500"
          />
          Freelancers
        </label>
        <label className="flex items-center gap-1.5 cursor-pointer text-sm text-gray-600">
          <input
            type="checkbox"
            checked={filterApproved}
            onChange={(e) => setFilterApproved(e.target.checked)}
            className="rounded border-gray-300 text-ooosh-600 focus:ring-ooosh-500"
          />
          Approved only
        </label>
        <label className="flex items-center gap-1.5 cursor-pointer text-sm text-gray-600">
          <input
            type="checkbox"
            checked={filterHasEmail}
            onChange={(e) => setFilterHasEmail(e.target.checked)}
            className="rounded border-gray-300 text-ooosh-600 focus:ring-ooosh-500"
          />
          Has email
        </label>
        <label className="flex items-center gap-1.5 cursor-pointer text-sm text-gray-600">
          <input
            type="checkbox"
            checked={filterHasPhone}
            onChange={(e) => setFilterHasPhone(e.target.checked)}
            className="rounded border-gray-300 text-ooosh-600 focus:ring-ooosh-500"
          />
          Has phone
        </label>
        <select
          value={sortBy}
          onChange={(e) => setSortBy(e.target.value)}
          className="rounded border border-gray-300 px-3 py-2 text-sm shadow-sm focus:border-ooosh-500 focus:outline-none"
        >
          <option value="name">Sort: Name</option>
          <option value="recently_added">Sort: Recently added</option>
          <option value="recently_updated">Sort: Recently updated</option>
          <option value="last_contacted">Sort: Last contacted</option>
        </select>
      </div>

      {/* Table */}
      <div className="mt-6 bg-white rounded-xl shadow-sm border border-gray-200 overflow-hidden">
        <table className="min-w-full divide-y divide-gray-200">
          <thead className="bg-gray-50">
            <tr>
              <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                Name
              </th>
              <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                Email
              </th>
              <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                Organisations & Roles
              </th>
              <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                Mobile
              </th>
              <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                Last Contact
              </th>
            </tr>
          </thead>
          <tbody className="bg-white divide-y divide-gray-200">
            {loading ? (
              <tr>
                <td colSpan={5} className="px-6 py-8 text-center text-sm text-gray-500">
                  Loading...
                </td>
              </tr>
            ) : people.length === 0 ? (
              <tr>
                <td colSpan={5} className="px-6 py-8 text-center text-sm text-gray-500">
                  No people found.
                </td>
              </tr>
            ) : (
              people.map((person) => (
                <tr key={person.id} onClick={() => navigate(`/people/${person.id}`)} className="hover:bg-gray-50 cursor-pointer transition-colors">
                  <td className="px-6 py-4 whitespace-nowrap">
                    <div className="text-sm font-medium text-gray-900">
                      {person.first_name} {person.last_name}
                    </div>
                  </td>
                  <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500">
                    {person.email || '—'}
                  </td>
                  <td className="px-6 py-4">
                    <div className="flex flex-wrap gap-1">
                      {person.current_organisations?.map((org) => (
                        <span
                          key={org.id}
                          className="inline-flex items-center px-2 py-0.5 rounded-full text-xs bg-ooosh-100 text-ooosh-700"
                        >
                          {org.role} @ {org.organisation_name}
                        </span>
                      )) || (
                        <span className="text-xs text-gray-400">No organisation</span>
                      )}
                    </div>
                  </td>
                  <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500">
                    {person.mobile || '—'}
                  </td>
                  <td className="px-6 py-4 whitespace-nowrap text-sm">
                    {person.last_interaction_at ? (
                      <span className={(() => {
                        const days = Math.floor((Date.now() - new Date(person.last_interaction_at).getTime()) / 86400000);
                        return days > 90 ? 'text-red-500' : days > 30 ? 'text-amber-500' : 'text-gray-500';
                      })()}>
                        {timeAgo(person.last_interaction_at)}
                      </span>
                    ) : (
                      <span className="text-gray-300">Never</span>
                    )}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {/* Pagination */}
      {pagination.totalPages > 1 && (
        <div className="mt-4 flex justify-between items-center">
          <p className="text-sm text-gray-500">
            Page {pagination.page} of {pagination.totalPages}
          </p>
          <div className="flex gap-2">
            <button
              onClick={() => loadPeople(pagination.page - 1)}
              disabled={pagination.page <= 1}
              className="px-3 py-1 text-sm border rounded disabled:opacity-50"
            >
              Previous
            </button>
            <button
              onClick={() => loadPeople(pagination.page + 1)}
              disabled={pagination.page >= pagination.totalPages}
              className="px-3 py-1 text-sm border rounded disabled:opacity-50"
            >
              Next
            </button>
          </div>
        </div>
      )}

      {/* Add Person Panel */}
      <SlidePanel open={showForm} onClose={() => setShowForm(false)} title="Add Person">
        <PersonForm
          onSaved={() => { setShowForm(false); loadPeople(); }}
          onCancel={() => setShowForm(false)}
        />
      </SlidePanel>
    </div>
  );
}
