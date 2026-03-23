import { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuthStore } from '../hooks/useAuthStore';

const API_BASE = '/api';

interface ReviewItem {
  id: string;
  entity_type: string;
  entity_id: string | null;
  external_id: string | null;
  review_type: string;
  summary: string;
  details: Record<string, unknown>;
  status: string;
  entity_name: string | null;
  created_at: string;
  resolved_by_email: string | null;
  resolved_at: string | null;
  resolution_note: string | null;
}

interface OrgTypeStat {
  type: string;
  count: string;
}

interface OrgListItem {
  id: string;
  name: string;
  type: string;
  tags: string[] | null;
  people_count: string;
  jobs_count: string;
}

function useApi() {
  const token = useAuthStore((s: { accessToken: string | null }) => s.accessToken);
  const fetchApi = useCallback(async (url: string, options?: RequestInit) => {
    const res = await fetch(`${API_BASE}${url}`, {
      ...options,
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...options?.headers },
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: res.statusText }));
      throw new Error(err.error || res.statusText);
    }
    return res.json();
  }, [token]);
  return fetchApi;
}

const REVIEW_TYPE_LABELS: Record<string, string> = {
  type_mismatch: 'Type Mismatch',
  name_conflict: 'Name Conflict',
  possible_band: 'Possible Band',
  convert_suggestion: 'Convert Suggestion',
};

const ORG_TYPES = ['band', 'management', 'label', 'agency', 'promoter', 'venue', 'festival', 'supplier', 'hire_company', 'booking_agent', 'client', 'unknown', 'other'];

export default function DataCleanupPage() {
  const navigate = useNavigate();
  const api = useApi();

  // Tabs
  const [tab, setTab] = useState<'reviews' | 'types' | 'convert'>('reviews');

  // Review queue state
  const [reviews, setReviews] = useState<ReviewItem[]>([]);
  const [reviewFilter, setReviewFilter] = useState<'pending' | 'resolved' | 'dismissed'>('pending');
  const [loadingReviews, setLoadingReviews] = useState(false);

  // Org type stats
  const [typeStats, setTypeStats] = useState<OrgTypeStat[]>([]);
  const [selectedType, setSelectedType] = useState<string | null>(null);
  const [typeOrgs, setTypeOrgs] = useState<OrgListItem[]>([]);
  const [selectedOrgs, setSelectedOrgs] = useState<Set<string>>(new Set());
  const [newType, setNewType] = useState('');
  const [loadingTypes, setLoadingTypes] = useState(false);

  // Convert person state
  const [convertSearch, setConvertSearch] = useState('');
  const [convertResults, setConvertResults] = useState<Array<{ id: string; name: string; type: string }>>([]);
  const [convertOrgType, setConvertOrgType] = useState('band');
  const [converting, setConverting] = useState(false);

  // Load reviews
  const loadReviews = useCallback(async () => {
    setLoadingReviews(true);
    try {
      const data = await api(`/data-cleanup/reviews?status=${reviewFilter}`);
      setReviews(data.data);
    } catch (err) {
      console.error('Failed to load reviews:', err);
    } finally {
      setLoadingReviews(false);
    }
  }, [api, reviewFilter]);

  useEffect(() => { if (tab === 'reviews') loadReviews(); }, [tab, loadReviews]);

  // Load org type stats
  const loadTypeStats = useCallback(async () => {
    setLoadingTypes(true);
    try {
      const data = await api('/data-cleanup/org-type-stats');
      setTypeStats(data.data);
    } catch (err) {
      console.error('Failed to load type stats:', err);
    } finally {
      setLoadingTypes(false);
    }
  }, [api]);

  useEffect(() => { if (tab === 'types') loadTypeStats(); }, [tab, loadTypeStats]);

  // Load orgs by type
  const loadOrgsByType = useCallback(async (type: string) => {
    try {
      const data = await api(`/data-cleanup/orgs-by-type/${encodeURIComponent(type)}`);
      setTypeOrgs(data.data);
      setSelectedOrgs(new Set());
    } catch (err) {
      console.error('Failed to load orgs:', err);
    }
  }, [api]);

  useEffect(() => { if (selectedType) loadOrgsByType(selectedType); }, [selectedType, loadOrgsByType]);

  // Resolve/dismiss a review
  async function resolveReview(id: string, status: 'resolved' | 'dismissed', note?: string) {
    try {
      await api(`/data-cleanup/reviews/${id}`, {
        method: 'PATCH',
        body: JSON.stringify({ status, resolution_note: note }),
      });
      setReviews(prev => prev.filter(r => r.id !== id));
    } catch (err) {
      console.error('Failed to resolve review:', err);
    }
  }

  // Bulk type update
  async function bulkUpdateType() {
    if (selectedOrgs.size === 0 || !newType) return;
    try {
      await api('/data-cleanup/bulk-type-update', {
        method: 'POST',
        body: JSON.stringify({ organisation_ids: Array.from(selectedOrgs), new_type: newType }),
      });
      // Refresh
      if (selectedType) loadOrgsByType(selectedType);
      loadTypeStats();
      setSelectedOrgs(new Set());
      setNewType('');
    } catch (err) {
      console.error('Bulk update failed:', err);
    }
  }

  // Search people for conversion
  useEffect(() => {
    if (convertSearch.length < 2) { setConvertResults([]); return; }
    const timeout = setTimeout(async () => {
      try {
        const data = await api(`/search?q=${encodeURIComponent(convertSearch)}&limit=10`);
        setConvertResults(data.results.filter((r: { type: string }) => r.type === 'person'));
      } catch (err) {
        console.error('Search failed:', err);
      }
    }, 300);
    return () => clearTimeout(timeout);
  }, [convertSearch, api]);

  // Convert person to org
  async function convertPerson(personId: string, personName: string) {
    if (!window.confirm(`Convert "${personName}" from a person to a ${convertOrgType} organisation?\n\nThis will:\n- Create a new organisation\n- Move interactions and job links\n- Soft-delete the person record`)) return;
    setConverting(true);
    try {
      const result = await api('/data-cleanup/convert-person-to-org', {
        method: 'POST',
        body: JSON.stringify({ person_id: personId, org_type: convertOrgType }),
      });
      alert(`Converted! New org: "${result.organisation_name}" (ID: ${result.organisation_id})`);
      setConvertSearch('');
      setConvertResults([]);
      navigate(`/organisations/${result.organisation_id}`);
    } catch (err) {
      alert(`Conversion failed: ${err instanceof Error ? err.message : 'Unknown error'}`);
    } finally {
      setConverting(false);
    }
  }

  const tabClass = (t: string) =>
    `px-4 py-2 text-sm font-medium rounded-t-lg ${tab === t ? 'bg-white text-ooosh-700 border-b-2 border-ooosh-600' : 'text-gray-500 hover:text-gray-700 hover:bg-gray-50'}`;

  return (
    <div className="max-w-6xl mx-auto p-6">
      <h1 className="text-2xl font-bold text-gray-900 mb-1">Data Cleanup</h1>
      <p className="text-sm text-gray-500 mb-6">Review sync conflicts, correct organisation types, and convert misclassified records.</p>

      {/* Tabs */}
      <div className="flex gap-1 border-b border-gray-200 mb-6">
        <button onClick={() => setTab('reviews')} className={tabClass('reviews')}>
          Sync Review Queue
          {reviews.length > 0 && tab !== 'reviews' && (
            <span className="ml-2 px-1.5 py-0.5 bg-red-100 text-red-700 rounded-full text-xs">{reviews.length}</span>
          )}
        </button>
        <button onClick={() => setTab('types')} className={tabClass('types')}>Organisation Types</button>
        <button onClick={() => setTab('convert')} className={tabClass('convert')}>Convert Person to Org</button>
      </div>

      {/* ═══════ REVIEW QUEUE TAB ═══════ */}
      {tab === 'reviews' && (
        <div>
          <div className="flex items-center gap-3 mb-4">
            <select value={reviewFilter} onChange={(e) => setReviewFilter(e.target.value as 'pending' | 'resolved' | 'dismissed')}
              className="border border-gray-300 rounded px-3 py-1.5 text-sm">
              <option value="pending">Pending</option>
              <option value="resolved">Resolved</option>
              <option value="dismissed">Dismissed</option>
            </select>
            <span className="text-sm text-gray-500">{reviews.length} item{reviews.length !== 1 ? 's' : ''}</span>
          </div>

          {loadingReviews ? (
            <div className="text-center py-8 text-gray-400 text-sm">Loading...</div>
          ) : reviews.length === 0 ? (
            <div className="bg-green-50 border border-green-200 rounded-lg px-6 py-8 text-center">
              <p className="text-green-700 font-medium">No pending review items</p>
              <p className="text-green-600 text-sm mt-1">All sync conflicts have been resolved.</p>
            </div>
          ) : (
            <div className="space-y-3">
              {reviews.map(review => (
                <div key={review.id} className="bg-white border border-gray-200 rounded-lg p-4 shadow-sm">
                  <div className="flex items-start justify-between">
                    <div>
                      <div className="flex items-center gap-2">
                        <span className="text-xs font-medium px-2 py-0.5 rounded-full bg-amber-100 text-amber-700">
                          {REVIEW_TYPE_LABELS[review.review_type] || review.review_type}
                        </span>
                        <span className="text-xs text-gray-400">
                          {new Date(review.created_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}
                        </span>
                      </div>
                      <p className="text-sm font-medium text-gray-900 mt-1">{review.summary}</p>
                      {review.entity_name && review.entity_id && (
                        <button
                          onClick={() => navigate(`/${review.entity_type === 'organisation' ? 'organisations' : 'people'}/${review.entity_id}`)}
                          className="text-xs text-ooosh-600 hover:underline mt-1"
                        >
                          View: {review.entity_name}
                        </button>
                      )}
                      {review.details && Object.keys(review.details).length > 0 && (
                        <div className="text-xs text-gray-500 mt-2 bg-gray-50 rounded px-2 py-1">
                          {review.details.op_type ? (
                            <span>OP type: <strong>{String(review.details.op_type)}</strong></span>
                          ) : null}
                          {review.details.hh_type ? (
                            <span className="ml-3">HH type: <strong>{String(review.details.hh_type)}</strong></span>
                          ) : null}
                        </div>
                      )}
                    </div>
                    {review.status === 'pending' && (
                      <div className="flex gap-2 ml-4 flex-shrink-0">
                        <button
                          onClick={() => resolveReview(review.id, 'resolved', 'Manually reviewed')}
                          className="text-xs px-3 py-1 bg-green-100 text-green-700 rounded hover:bg-green-200"
                        >
                          Resolve
                        </button>
                        <button
                          onClick={() => resolveReview(review.id, 'dismissed')}
                          className="text-xs px-3 py-1 bg-gray-100 text-gray-600 rounded hover:bg-gray-200"
                        >
                          Dismiss
                        </button>
                      </div>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* ═══════ ORGANISATION TYPES TAB ═══════ */}
      {tab === 'types' && (
        <div>
          {loadingTypes ? (
            <div className="text-center py-8 text-gray-400 text-sm">Loading...</div>
          ) : (
            <div className="grid grid-cols-12 gap-6">
              {/* Type breakdown */}
              <div className="col-span-4">
                <h3 className="text-sm font-semibold text-gray-700 mb-3">Type Breakdown</h3>
                <div className="bg-white border border-gray-200 rounded-lg overflow-hidden">
                  {typeStats.map(stat => (
                    <button
                      key={stat.type}
                      onClick={() => setSelectedType(stat.type)}
                      className={`w-full flex items-center justify-between px-4 py-2.5 text-sm border-b border-gray-100 hover:bg-gray-50 ${
                        selectedType === stat.type ? 'bg-ooosh-50 text-ooosh-700 font-medium' : 'text-gray-700'
                      }`}
                    >
                      <span className="capitalize">{stat.type || '(empty)'}</span>
                      <span className="text-xs text-gray-400 bg-gray-100 px-2 py-0.5 rounded-full">{stat.count}</span>
                    </button>
                  ))}
                </div>
              </div>

              {/* Orgs of selected type */}
              <div className="col-span-8">
                {selectedType ? (
                  <>
                    <div className="flex items-center justify-between mb-3">
                      <h3 className="text-sm font-semibold text-gray-700">
                        Organisations: <span className="capitalize">{selectedType}</span> ({typeOrgs.length})
                      </h3>
                      {selectedOrgs.size > 0 && (
                        <div className="flex items-center gap-2">
                          <span className="text-xs text-gray-500">{selectedOrgs.size} selected</span>
                          <select value={newType} onChange={e => setNewType(e.target.value)}
                            className="border border-gray-300 rounded px-2 py-1 text-xs">
                            <option value="">Change to...</option>
                            {ORG_TYPES.filter(t => t !== selectedType).map(t => (
                              <option key={t} value={t}>{t}</option>
                            ))}
                          </select>
                          <button
                            onClick={bulkUpdateType}
                            disabled={!newType}
                            className="text-xs px-3 py-1 bg-ooosh-600 text-white rounded hover:bg-ooosh-700 disabled:opacity-50"
                          >
                            Update Type
                          </button>
                        </div>
                      )}
                    </div>
                    <div className="bg-white border border-gray-200 rounded-lg overflow-hidden">
                      <table className="w-full">
                        <thead>
                          <tr className="bg-gray-50 border-b border-gray-200">
                            <th className="w-8 px-3 py-2">
                              <input type="checkbox"
                                checked={selectedOrgs.size === typeOrgs.length && typeOrgs.length > 0}
                                onChange={(e) => {
                                  if (e.target.checked) setSelectedOrgs(new Set(typeOrgs.map(o => o.id)));
                                  else setSelectedOrgs(new Set());
                                }}
                                className="rounded border-gray-300"
                              />
                            </th>
                            <th className="text-left text-xs font-medium text-gray-500 uppercase px-3 py-2">Name</th>
                            <th className="text-center text-xs font-medium text-gray-500 uppercase px-3 py-2">People</th>
                            <th className="text-center text-xs font-medium text-gray-500 uppercase px-3 py-2">Jobs</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-gray-100">
                          {typeOrgs.map(org => (
                            <tr key={org.id} className="hover:bg-gray-50">
                              <td className="px-3 py-2">
                                <input type="checkbox"
                                  checked={selectedOrgs.has(org.id)}
                                  onChange={(e) => {
                                    const next = new Set(selectedOrgs);
                                    if (e.target.checked) next.add(org.id); else next.delete(org.id);
                                    setSelectedOrgs(next);
                                  }}
                                  className="rounded border-gray-300"
                                />
                              </td>
                              <td className="px-3 py-2">
                                <button onClick={() => navigate(`/organisations/${org.id}`)}
                                  className="text-sm text-ooosh-600 hover:underline font-medium">
                                  {org.name}
                                </button>
                                {org.tags && org.tags.length > 0 && (
                                  <div className="flex gap-1 mt-0.5">
                                    {org.tags.map(tag => (
                                      <span key={tag} className="text-xs px-1.5 py-0.5 bg-gray-100 text-gray-500 rounded">{tag}</span>
                                    ))}
                                  </div>
                                )}
                              </td>
                              <td className="px-3 py-2 text-center text-sm text-gray-500">{org.people_count}</td>
                              <td className="px-3 py-2 text-center text-sm text-gray-500">{org.jobs_count}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </>
                ) : (
                  <div className="text-center py-12 text-gray-400 text-sm">
                    Select a type on the left to view organisations
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
      )}

      {/* ═══════ CONVERT PERSON TO ORG TAB ═══════ */}
      {tab === 'convert' && (
        <div className="max-w-xl">
          <div className="bg-amber-50 border border-amber-200 rounded-lg px-4 py-3 mb-6 text-sm text-amber-700">
            Use this to convert a person record that should be an organisation (e.g., a band name that was imported as a person from HireHop).
            This will create a new organisation, move interactions and job links, and soft-delete the person.
          </div>

          <div className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">New organisation type</label>
              <select value={convertOrgType} onChange={e => setConvertOrgType(e.target.value)}
                className="border border-gray-300 rounded-lg px-3 py-2 text-sm w-48">
                {ORG_TYPES.map(t => (
                  <option key={t} value={t}>{t}</option>
                ))}
              </select>
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Search for person to convert</label>
              <input
                type="text"
                value={convertSearch}
                onChange={e => setConvertSearch(e.target.value)}
                placeholder="Search by name..."
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:ring-ooosh-500 focus:border-ooosh-500"
              />
            </div>

            {convertResults.length > 0 && (
              <div className="bg-white border border-gray-200 rounded-lg divide-y divide-gray-100">
                {convertResults.map(person => (
                  <div key={person.id} className="flex items-center justify-between px-4 py-3">
                    <div>
                      <button onClick={() => navigate(`/people/${person.id}`)}
                        className="text-sm font-medium text-ooosh-600 hover:underline">
                        {person.name}
                      </button>
                    </div>
                    <button
                      onClick={() => convertPerson(person.id, person.name)}
                      disabled={converting}
                      className="text-xs px-3 py-1.5 bg-amber-100 text-amber-700 rounded hover:bg-amber-200 font-medium disabled:opacity-50"
                    >
                      {converting ? 'Converting...' : `Convert to ${convertOrgType}`}
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
