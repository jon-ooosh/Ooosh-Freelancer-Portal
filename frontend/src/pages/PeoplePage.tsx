import { useState, useEffect, useRef } from 'react';
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
  // Freelancer-specific (always returned by SELECT p.*, may be null/false)
  is_freelancer: boolean;
  is_approved: boolean;
  is_insured_on_vehicles: boolean;
  has_tshirt: boolean;
  skills: string[] | null;
  freelancer_next_review_date: string | null;
  freelancer_joined_date: string | null;
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

type ReviewBucket = 'overdue' | 'due_soon' | 'ok' | 'none';

function reviewBucket(dateStr: string | null): ReviewBucket {
  if (!dateStr) return 'none';
  const days = Math.floor((new Date(dateStr).getTime() - Date.now()) / 86400000);
  if (days < 0) return 'overdue';
  if (days <= 30) return 'due_soon';
  return 'ok';
}

function fmtUKDate(dateStr: string | null): string {
  if (!dateStr) return '—';
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) return '—';
  return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
}

const REVIEW_PILL: Record<ReviewBucket, { label: string; cls: string }> = {
  overdue:  { label: 'Overdue',  cls: 'bg-red-100 text-red-700 border-red-200' },
  due_soon: { label: 'Due ≤30d', cls: 'bg-amber-100 text-amber-700 border-amber-200' },
  ok:       { label: 'OK',       cls: 'bg-green-100 text-green-700 border-green-200' },
  none:     { label: 'No date',  cls: 'bg-gray-100 text-gray-500 border-gray-200' },
};

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
  const [filterMissingEmail, setFilterMissingEmail] = useState(false);
  const [filterMissingPhone, setFilterMissingPhone] = useState(false);
  const [sortBy, setSortBy] = useState('name');
  // Freelancer-only filters
  const [filterInsured, setFilterInsured] = useState(false);
  const [filterTshirt, setFilterTshirt] = useState(false);
  const [reviewFilter, setReviewFilter] = useState<ReviewBucket | ''>('');
  const [selectedSkills, setSelectedSkills] = useState<Set<string>>(new Set());
  const [skillsList, setSkillsList] = useState<string[]>([]);
  const [showSkillsMenu, setShowSkillsMenu] = useState(false);
  const [groupByReview, setGroupByReview] = useState(false);
  const skillsMenuRef = useRef<HTMLDivElement>(null);
  const navigate = useNavigate();

  useEffect(() => {
    loadPeople();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search, filterFreelancer, filterApproved, filterMissingEmail, filterMissingPhone,
      filterInsured, filterTshirt, reviewFilter, selectedSkills, sortBy, groupByReview]);

  // Load skills list when freelancer filter turns on (once per session is enough)
  useEffect(() => {
    if (filterFreelancer && skillsList.length === 0) {
      api.get<{ data: string[] }>('/people/skills')
        .then((r) => setSkillsList(r.data || []))
        .catch(() => {});
    }
  }, [filterFreelancer, skillsList.length]);

  // Click outside skills menu to close
  useEffect(() => {
    if (!showSkillsMenu) return;
    const handler = (e: MouseEvent) => {
      if (skillsMenuRef.current && !skillsMenuRef.current.contains(e.target as Node)) {
        setShowSkillsMenu(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [showSkillsMenu]);

  // Reset freelancer-only filters when leaving freelancer mode
  useEffect(() => {
    if (!filterFreelancer) {
      setFilterInsured(false);
      setFilterTshirt(false);
      setReviewFilter('');
      setSelectedSkills(new Set());
      setGroupByReview(false);
      if (sortBy === 'review_due') setSortBy('name');
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filterFreelancer]);

  async function loadPeople(page = 1) {
    setLoading(true);
    try {
      // When grouping by review, fetch all (limit 200 — well above the freelancer count)
      const limit = groupByReview ? '200' : '50';
      const params = new URLSearchParams({ page: String(page), limit });
      if (search) params.set('search', search);
      if (filterFreelancer) params.set('is_freelancer', 'true');
      if (filterApproved) params.set('is_approved', 'true');
      if (filterInsured) params.set('is_insured', 'true');
      if (filterTshirt) params.set('has_tshirt', 'true');
      if (reviewFilter) params.set('review_status', reviewFilter);
      if (selectedSkills.size > 0) params.set('skills_any', Array.from(selectedSkills).join(','));
      if (filterMissingEmail) params.set('missing_email', 'true');
      if (filterMissingPhone) params.set('missing_phone', 'true');
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

  // Group people by review bucket when groupByReview is on
  const grouped: Record<ReviewBucket, Person[]> = {
    overdue: [],
    due_soon: [],
    ok: [],
    none: [],
  };
  if (groupByReview) {
    for (const p of people) grouped[reviewBucket(p.freelancer_next_review_date)].push(p);
  }

  const toggleSkill = (skill: string) => {
    const next = new Set(selectedSkills);
    if (next.has(skill)) next.delete(skill); else next.add(skill);
    setSelectedSkills(next);
  };

  return (
    <div>
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">People</h1>
          <p className="mt-1 text-sm text-gray-500">
            {pagination.total} contacts{filterFreelancer ? ' (freelancers)' : ''}
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

      {/* Search & Filters — top row */}
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
        <label className="flex items-center gap-1.5 cursor-pointer text-sm text-amber-600">
          <input
            type="checkbox"
            checked={filterMissingEmail}
            onChange={(e) => setFilterMissingEmail(e.target.checked)}
            className="rounded border-gray-300 text-amber-500 focus:ring-amber-500"
          />
          Missing email
        </label>
        <label className="flex items-center gap-1.5 cursor-pointer text-sm text-amber-600">
          <input
            type="checkbox"
            checked={filterMissingPhone}
            onChange={(e) => setFilterMissingPhone(e.target.checked)}
            className="rounded border-gray-300 text-amber-500 focus:ring-amber-500"
          />
          Missing phone
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
          {filterFreelancer && <option value="review_due">Sort: Review due soonest</option>}
        </select>
      </div>

      {/* Freelancer-only filter row */}
      {filterFreelancer && (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          {/* Trait chips */}
          <button
            onClick={() => setFilterInsured(!filterInsured)}
            className={`px-2.5 py-1 rounded-full text-xs font-medium border transition-colors ${
              filterInsured ? 'bg-green-100 text-green-700 border-green-300' : 'bg-white text-gray-600 border-gray-300 hover:bg-gray-50'
            }`}
          >
            🛡 Insured
          </button>
          <button
            onClick={() => setFilterTshirt(!filterTshirt)}
            className={`px-2.5 py-1 rounded-full text-xs font-medium border transition-colors ${
              filterTshirt ? 'bg-blue-100 text-blue-700 border-blue-300' : 'bg-white text-gray-600 border-gray-300 hover:bg-gray-50'
            }`}
          >
            👕 Has T-shirt
          </button>

          <div className="w-px h-5 bg-gray-300 mx-1" />

          {/* Review-status segmented chips */}
          <span className="text-xs text-gray-500">Review:</span>
          {(['', 'overdue', 'due_soon', 'ok', 'none'] as const).map((bucket) => (
            <button
              key={bucket || 'all'}
              onClick={() => setReviewFilter(bucket)}
              className={`px-2.5 py-1 rounded-full text-xs font-medium border transition-colors ${
                reviewFilter === bucket
                  ? bucket === ''
                    ? 'bg-gray-900 text-white border-gray-900'
                    : REVIEW_PILL[bucket].cls.replace('bg-', 'bg-').replace('text-', 'text-') + ' ring-1 ring-offset-1 ring-current'
                  : 'bg-white text-gray-600 border-gray-300 hover:bg-gray-50'
              }`}
            >
              {bucket === '' ? 'All' : REVIEW_PILL[bucket].label}
            </button>
          ))}

          <div className="w-px h-5 bg-gray-300 mx-1" />

          {/* Skills multi-select */}
          <div className="relative" ref={skillsMenuRef}>
            <button
              onClick={() => setShowSkillsMenu(!showSkillsMenu)}
              className={`px-2.5 py-1 rounded-full text-xs font-medium border transition-colors ${
                selectedSkills.size > 0
                  ? 'bg-ooosh-100 text-ooosh-700 border-ooosh-300'
                  : 'bg-white text-gray-600 border-gray-300 hover:bg-gray-50'
              }`}
            >
              🎯 Skills{selectedSkills.size > 0 ? ` (${selectedSkills.size})` : ''} ▾
            </button>
            {showSkillsMenu && (
              <div className="absolute z-10 mt-1 left-0 w-64 max-h-72 overflow-y-auto bg-white border border-gray-200 rounded-lg shadow-lg p-2">
                {skillsList.length === 0 ? (
                  <p className="text-xs text-gray-400 p-2">No skills found.</p>
                ) : (
                  skillsList.map((skill) => (
                    <label key={skill} className="flex items-center gap-2 px-2 py-1 hover:bg-gray-50 rounded cursor-pointer">
                      <input
                        type="checkbox"
                        checked={selectedSkills.has(skill)}
                        onChange={() => toggleSkill(skill)}
                        className="rounded border-gray-300 text-ooosh-600"
                      />
                      <span className="text-xs text-gray-700">{skill}</span>
                    </label>
                  ))
                )}
                {selectedSkills.size > 0 && (
                  <button
                    onClick={() => { setSelectedSkills(new Set()); setShowSkillsMenu(false); }}
                    className="mt-1 w-full text-xs text-gray-500 hover:text-gray-700 px-2 py-1"
                  >
                    Clear all
                  </button>
                )}
              </div>
            )}
          </div>

          <div className="w-px h-5 bg-gray-300 mx-1" />

          {/* Group by review */}
          <label className="flex items-center gap-1.5 cursor-pointer text-xs text-gray-600">
            <input
              type="checkbox"
              checked={groupByReview}
              onChange={(e) => setGroupByReview(e.target.checked)}
              className="rounded border-gray-300 text-ooosh-600 focus:ring-ooosh-500"
            />
            Group by review status
          </label>
        </div>
      )}

      {/* Table(s) */}
      <div className="mt-6 space-y-6">
        {loading ? (
          <div className="bg-white rounded-xl shadow-sm border border-gray-200 p-8 text-center text-sm text-gray-500">
            Loading...
          </div>
        ) : people.length === 0 ? (
          <div className="bg-white rounded-xl shadow-sm border border-gray-200 p-8 text-center text-sm text-gray-500">
            No people found.
          </div>
        ) : groupByReview ? (
          // Grouped view (freelancer + groupByReview only)
          (['overdue', 'due_soon', 'ok', 'none'] as ReviewBucket[]).map((bucket) =>
            grouped[bucket].length > 0 ? (
              <div key={bucket}>
                <div className="flex items-center gap-2 mb-2">
                  <span className={`px-2 py-0.5 rounded-full border text-[11px] font-medium ${REVIEW_PILL[bucket].cls}`}>
                    {REVIEW_PILL[bucket].label}
                  </span>
                  <span className="text-xs text-gray-500">{grouped[bucket].length} freelancer{grouped[bucket].length !== 1 ? 's' : ''}</span>
                </div>
                <PeopleTable people={grouped[bucket]} freelancerMode onRowClick={(id) => navigate(`/people/${id}`)} />
              </div>
            ) : null
          )
        ) : (
          <PeopleTable people={people} freelancerMode={filterFreelancer} onRowClick={(id) => navigate(`/people/${id}`)} />
        )}
      </div>

      {/* Pagination — hide when grouping (all loaded) */}
      {!groupByReview && pagination.totalPages > 1 && (
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

// ── PeopleTable subcomponent ────────────────────────────────────────────

function PeopleTable({
  people,
  freelancerMode,
  onRowClick,
}: {
  people: Person[];
  freelancerMode: boolean;
  onRowClick: (id: string) => void;
}) {
  return (
    <div className="bg-white rounded-xl shadow-sm border border-gray-200 overflow-x-auto">
      <table className="min-w-full divide-y divide-gray-200">
        <thead className="bg-gray-50">
          <tr>
            <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Name</th>
            <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Email</th>
            {freelancerMode ? (
              <>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Mobile</th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Skills</th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Next Review</th>
              </>
            ) : (
              <>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Organisations & Roles</th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Mobile</th>
              </>
            )}
            <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Last Contact</th>
          </tr>
        </thead>
        <tbody className="bg-white divide-y divide-gray-200">
          {people.map((person) => (
            <tr key={person.id} onClick={() => onRowClick(person.id)} className="hover:bg-gray-50 cursor-pointer transition-colors">
              <td className="px-6 py-4 whitespace-nowrap">
                <div className="flex items-center gap-1.5">
                  <span className="text-sm font-medium text-gray-900">
                    {person.first_name} {person.last_name}
                  </span>
                  {(!person.email || !person.mobile) && (
                    <span
                      className="inline-flex items-center justify-center w-4 h-4 rounded-full bg-amber-100 text-amber-600 text-[10px] leading-none flex-shrink-0 cursor-help"
                      title={[
                        !person.email && 'Missing email',
                        !person.mobile && 'Missing phone',
                      ].filter(Boolean).join(' & ')}
                    >
                      !
                    </span>
                  )}
                  {freelancerMode && person.is_approved && (
                    <span title="Approved" className="text-[10px] px-1 rounded bg-green-100 text-green-700">✓</span>
                  )}
                  {freelancerMode && person.is_insured_on_vehicles && (
                    <span title="Insured on vehicles" className="text-[10px]">🛡</span>
                  )}
                  {freelancerMode && person.has_tshirt && (
                    <span title="Has T-shirt" className="text-[10px]">👕</span>
                  )}
                </div>
              </td>
              <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500">
                {person.email || '—'}
              </td>
              {freelancerMode ? (
                <>
                  <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500">
                    {person.mobile || '—'}
                  </td>
                  <td className="px-6 py-4">
                    <div className="flex flex-wrap gap-1 max-w-md">
                      {(person.skills || []).slice(0, 4).map((s) => (
                        <span key={s} className="inline-flex items-center px-2 py-0.5 rounded text-[11px] bg-ooosh-50 text-ooosh-700 border border-ooosh-100">
                          {s}
                        </span>
                      ))}
                      {(person.skills?.length || 0) > 4 && (
                        <span className="text-[11px] text-gray-400">+{(person.skills?.length || 0) - 4}</span>
                      )}
                      {(!person.skills || person.skills.length === 0) && (
                        <span className="text-[11px] text-gray-400">—</span>
                      )}
                    </div>
                  </td>
                  <td className="px-6 py-4 whitespace-nowrap text-sm">
                    {(() => {
                      const bucket = reviewBucket(person.freelancer_next_review_date);
                      return (
                        <div className="flex items-center gap-2">
                          <span className={`px-2 py-0.5 rounded-full border text-[10px] font-medium ${REVIEW_PILL[bucket].cls}`}>
                            {REVIEW_PILL[bucket].label}
                          </span>
                          {person.freelancer_next_review_date && (
                            <span className="text-xs text-gray-500">{fmtUKDate(person.freelancer_next_review_date)}</span>
                          )}
                        </div>
                      );
                    })()}
                  </td>
                </>
              ) : (
                <>
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
                </>
              )}
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
          ))}
        </tbody>
      </table>
    </div>
  );
}
