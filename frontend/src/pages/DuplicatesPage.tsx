import { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../services/api';

interface DuplicatePerson {
  id: string;
  first_name: string;
  last_name: string;
  email: string | null;
  mobile: string | null;
  phone: string | null;
  created_at: string;
  organisations: string[];
}

interface DuplicateGroup {
  match_type: string;
  score: number;
  people: DuplicatePerson[];
}

const SCORE_COLORS: Record<string, string> = {
  '100': 'bg-red-100 text-red-700',
  '85': 'bg-amber-100 text-amber-700',
  '75': 'bg-yellow-100 text-yellow-700',
};

function formatDate(dateStr: string) {
  return new Date(dateStr).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
}

export default function DuplicatesPage() {
  const [groups, setGroups] = useState<DuplicateGroup[]>([]);
  const [loading, setLoading] = useState(true);
  const [merging, setMerging] = useState<string | null>(null);
  const [success, setSuccess] = useState('');

  useEffect(() => {
    loadDuplicates();
  }, []);

  async function loadDuplicates() {
    try {
      const data = await api.get<{ data: DuplicateGroup[] }>('/duplicates');
      setGroups(data.data);
    } catch (err) {
      console.error('Failed to load duplicates:', err);
    } finally {
      setLoading(false);
    }
  }

  async function handleMerge(keepId: string, mergeId: string, keepName: string) {
    if (!confirm(`Merge into "${keepName}"? The other record will be archived and all its data transferred.`)) return;

    setMerging(`${keepId}-${mergeId}`);
    try {
      const result = await api.post<{ message: string }>('/duplicates/merge', { keep_id: keepId, merge_id: mergeId });
      setSuccess(result.message);
      loadDuplicates();
    } catch (err) {
      console.error('Merge failed:', err);
    } finally {
      setMerging(null);
    }
  }

  async function handleDismiss(personIds: string[]) {
    try {
      await api.post('/duplicates/dismiss', { person_ids: personIds });
      setGroups(groups.filter(g => {
        const ids = g.people.map(p => p.id);
        return !personIds.every(id => ids.includes(id));
      }));
    } catch (err) {
      console.error('Dismiss failed:', err);
    }
  }

  if (loading) return <div className="text-center py-12 text-gray-500">Scanning for duplicates...</div>;

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Duplicate Detection</h1>
          <p className="text-sm text-gray-500 mt-1">
            {groups.length === 0
              ? 'No duplicates found — your contacts are clean!'
              : `Found ${groups.length} potential duplicate${groups.length !== 1 ? ' groups' : ''}`}
          </p>
        </div>
        <button
          onClick={() => { setLoading(true); loadDuplicates(); }}
          className="px-4 py-2 text-sm border border-gray-300 rounded hover:bg-gray-50 transition-colors"
        >
          Re-scan
        </button>
      </div>

      {success && (
        <div className="bg-green-50 border border-green-200 text-green-700 px-4 py-3 rounded-lg text-sm mb-4">
          {success}
        </div>
      )}

      {groups.length === 0 && !loading && (
        <div className="bg-white rounded-xl shadow-sm border border-gray-200 p-12 text-center">
          <div className="text-4xl mb-3">&#10003;</div>
          <h2 className="text-lg font-semibold text-gray-900">All clear</h2>
          <p className="text-sm text-gray-500 mt-1">No duplicate contacts detected. This page will flag duplicates automatically as new contacts are added.</p>
        </div>
      )}

      <div className="space-y-4">
        {groups.map((group, gi) => (
          <div key={gi} className="bg-white rounded-xl shadow-sm border border-gray-200 overflow-hidden">
            {/* Group header */}
            <div className="px-5 py-3 bg-gray-50 border-b border-gray-100 flex items-center justify-between">
              <div className="flex items-center gap-3">
                <span className={`text-xs font-medium px-2 py-0.5 rounded-full ${SCORE_COLORS[String(group.score)] || 'bg-gray-100 text-gray-700'}`}>
                  {group.score}% match
                </span>
                <span className="text-sm text-gray-600">{group.match_type}</span>
              </div>
              <button
                onClick={() => handleDismiss(group.people.map(p => p.id))}
                className="text-xs text-gray-400 hover:text-gray-600 transition-colors"
              >
                Not duplicates
              </button>
            </div>

            {/* People in group */}
            <div className="divide-y divide-gray-100">
              {group.people.map((person, pi) => (
                <div key={person.id} className="px-5 py-4 flex items-center justify-between">
                  <div className="flex items-center gap-4 flex-1 min-w-0">
                    <div className="w-9 h-9 rounded-full bg-ooosh-100 text-ooosh-700 flex items-center justify-center text-sm font-bold flex-shrink-0">
                      {person.first_name[0]?.toUpperCase() || '?'}
                    </div>
                    <div className="min-w-0">
                      <Link to={`/people/${person.id}`} className="text-sm font-medium text-gray-900 hover:text-ooosh-600">
                        {person.first_name} {person.last_name}
                      </Link>
                      <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-gray-500 mt-0.5">
                        {person.email && <span>{person.email}</span>}
                        {person.mobile && <span>{person.mobile}</span>}
                        {person.phone && !person.mobile && <span>{person.phone}</span>}
                        <span>Added {formatDate(person.created_at)}</span>
                      </div>
                      {person.organisations.length > 0 && (
                        <div className="flex flex-wrap gap-1 mt-1">
                          {person.organisations.map((org) => (
                            <span key={org} className="text-xs bg-gray-100 text-gray-600 px-1.5 py-0.5 rounded">{org}</span>
                          ))}
                        </div>
                      )}
                    </div>
                  </div>

                  {/* Merge actions — for each record, offer to merge the others into it */}
                  <div className="flex items-center gap-2 flex-shrink-0 ml-4">
                    {group.people.length === 2 && (
                      <button
                        onClick={() => handleMerge(
                          person.id,
                          group.people[pi === 0 ? 1 : 0].id,
                          `${person.first_name} ${person.last_name}`
                        )}
                        disabled={merging !== null}
                        className="text-xs bg-ooosh-50 text-ooosh-700 px-3 py-1.5 rounded hover:bg-ooosh-100 transition-colors disabled:opacity-50"
                      >
                        {merging === `${person.id}-${group.people[pi === 0 ? 1 : 0].id}` ? 'Merging...' : 'Keep this one'}
                      </button>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
