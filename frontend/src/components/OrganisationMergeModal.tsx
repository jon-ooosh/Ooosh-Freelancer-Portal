import { useState, useEffect } from 'react';
import { api } from '../services/api';

interface OrgSearchResult {
  id: string;
  name: string;
  type: string;
}

interface MergePreview {
  keeper: { id: string; name: string; type: string; do_not_hire: boolean };
  loser: { id: string; name: string; type: string; do_not_hire: boolean };
  counts: {
    people: number;
    jobs_as_client: number;
    job_organisation_links: number;
    venues: number;
    interactions: number;
    relationships: number;
    child_organisations: number;
    job_issues: number;
  };
  external_ids: Record<string, string[]>;
}

interface Props {
  loserId: string;
  loserName: string;
  onClose: () => void;
  onMerged: (keeperId: string) => void;
}

export default function OrganisationMergeModal({ loserId, loserName, onClose, onMerged }: Props) {
  const [search, setSearch] = useState('');
  const [results, setResults] = useState<OrgSearchResult[]>([]);
  const [keeper, setKeeper] = useState<OrgSearchResult | null>(null);
  const [preview, setPreview] = useState<MergePreview | null>(null);
  const [loadingPreview, setLoadingPreview] = useState(false);
  const [merging, setMerging] = useState(false);
  const [confirmText, setConfirmText] = useState('');
  const [error, setError] = useState<string | null>(null);

  // Search orgs when typing
  useEffect(() => {
    if (search.trim().length < 2 || keeper) { setResults([]); return; }
    const timer = setTimeout(async () => {
      try {
        const data = await api.get<{ data: OrgSearchResult[] }>(
          `/organisations?search=${encodeURIComponent(search)}&limit=10`
        );
        setResults(data.data.filter(o => o.id !== loserId));
      } catch {
        /* ignore */
      }
    }, 250);
    return () => clearTimeout(timer);
  }, [search, loserId, keeper]);

  // Load preview when keeper picked
  useEffect(() => {
    if (!keeper) { setPreview(null); return; }
    setLoadingPreview(true);
    api.get<MergePreview>(`/organisations/${loserId}/merge-preview?keep_id=${keeper.id}`)
      .then(setPreview)
      .catch((e: Error) => setError(e.message || 'Failed to load preview'))
      .finally(() => setLoadingPreview(false));
  }, [keeper, loserId]);

  // Escape closes
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const expectedConfirm = preview ? preview.loser.name : '';
  const canMerge = !!keeper && !!preview && !merging && confirmText.trim() === expectedConfirm.trim();

  async function handleMerge() {
    if (!keeper || !preview) return;
    setMerging(true);
    setError(null);
    try {
      const result = await api.post<{ kept_id: string }>(`/organisations/${loserId}/merge`, { keep_id: keeper.id });
      onMerged(result.kept_id);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Merge failed');
      setMerging(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" onClick={onClose}>
      <div
        className="bg-white rounded-lg shadow-xl max-w-2xl w-full max-h-[90vh] overflow-y-auto"
        onClick={e => e.stopPropagation()}
      >
        <div className="px-6 py-4 border-b border-gray-200 flex items-center justify-between sticky top-0 bg-white">
          <h2 className="text-lg font-semibold text-gray-900">
            Merge "{loserName}" into another organisation
          </h2>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 text-xl leading-none">×</button>
        </div>

        <div className="p-6 space-y-4">
          {error && (
            <div className="bg-red-50 border border-red-200 rounded p-3 text-sm text-red-700">
              {error}
            </div>
          )}

          <div className="bg-amber-50 border border-amber-200 rounded p-3 text-sm text-amber-900">
            <p className="font-medium">This will permanently merge the two records.</p>
            <p className="mt-1">
              All people, jobs, interactions, relationships and HireHop links from <strong>"{loserName}"</strong> move
              to the chosen keeper. The current record (this one) becomes soft-deleted with a backref.
            </p>
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Keeper organisation (the one to merge into)
            </label>
            {keeper ? (
              <div className="flex items-center justify-between gap-2 px-3 py-2 border border-green-300 bg-green-50 rounded">
                <div>
                  <div className="font-medium text-gray-900">{keeper.name}</div>
                  <div className="text-xs text-gray-500">{keeper.type}</div>
                </div>
                <button
                  onClick={() => { setKeeper(null); setPreview(null); setConfirmText(''); }}
                  className="text-sm text-red-600 hover:text-red-700"
                >
                  Change
                </button>
              </div>
            ) : (
              <>
                <input
                  type="text"
                  value={search}
                  onChange={e => setSearch(e.target.value)}
                  placeholder="Search organisations…"
                  className="w-full rounded border border-gray-300 px-3 py-2 text-sm"
                  autoFocus
                />
                {results.length > 0 && (
                  <div className="mt-1 max-h-60 overflow-y-auto border border-gray-200 rounded">
                    {results.map(r => (
                      <button
                        key={r.id}
                        onClick={() => { setKeeper(r); setSearch(''); setResults([]); }}
                        className="block w-full text-left px-3 py-2 text-sm hover:bg-gray-50 border-b border-gray-100 last:border-0"
                      >
                        <div className="font-medium text-gray-900">{r.name}</div>
                        <div className="text-xs text-gray-500">{r.type}</div>
                      </button>
                    ))}
                  </div>
                )}
              </>
            )}
          </div>

          {keeper && loadingPreview && (
            <div className="text-sm text-gray-500">Loading preview…</div>
          )}

          {keeper && preview && !loadingPreview && (
            <>
              <div className="border border-gray-200 rounded p-4 space-y-2">
                <div className="text-xs font-medium text-gray-500 uppercase tracking-wider">What will move</div>
                <ul className="text-sm text-gray-700 space-y-1">
                  <PreviewRow label="People (active + historical roles)" count={preview.counts.people} />
                  <PreviewRow label="Jobs (as client)" count={preview.counts.jobs_as_client} />
                  <PreviewRow label="Job organisation links" count={preview.counts.job_organisation_links} />
                  <PreviewRow label="Linked venues" count={preview.counts.venues} />
                  <PreviewRow label="Interactions" count={preview.counts.interactions} />
                  <PreviewRow label="Relationships to other orgs" count={preview.counts.relationships} />
                  <PreviewRow label="Child organisations" count={preview.counts.child_organisations} />
                  <PreviewRow label="Job issues" count={preview.counts.job_issues} />
                </ul>
                {Object.keys(preview.external_ids).length > 0 && (
                  <div className="mt-3 pt-3 border-t border-gray-100">
                    <div className="text-xs font-medium text-gray-500 uppercase tracking-wider mb-1">External IDs</div>
                    {Object.entries(preview.external_ids).map(([sys, ids]) => (
                      <div key={sys} className="text-xs text-gray-600">
                        <span className="font-medium uppercase">{sys}:</span> {ids.join(', ')}
                        {ids.length > 1 && (
                          <span className="ml-2 text-amber-700">
                            (conflict — keeper's existing ID wins, others discarded with audit note)
                          </span>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Type the name of the record being merged to confirm: <strong>{expectedConfirm}</strong>
                </label>
                <input
                  type="text"
                  value={confirmText}
                  onChange={e => setConfirmText(e.target.value)}
                  className="w-full rounded border border-gray-300 px-3 py-2 text-sm"
                  placeholder={expectedConfirm}
                />
              </div>
            </>
          )}
        </div>

        <div className="px-6 py-4 border-t border-gray-200 flex items-center justify-end gap-2 sticky bottom-0 bg-white">
          <button
            onClick={onClose}
            className="px-4 py-2 text-sm border border-gray-300 rounded hover:bg-gray-50"
            disabled={merging}
          >
            Cancel
          </button>
          <button
            onClick={handleMerge}
            disabled={!canMerge}
            className="px-4 py-2 text-sm bg-amber-600 text-white rounded hover:bg-amber-700 disabled:bg-gray-300 disabled:cursor-not-allowed"
          >
            {merging ? 'Merging…' : `Merge into "${keeper?.name || ''}"`}
          </button>
        </div>
      </div>
    </div>
  );
}

function PreviewRow({ label, count }: { label: string; count: number }) {
  return (
    <li className="flex justify-between">
      <span>{label}</span>
      <span className={count > 0 ? 'font-medium text-gray-900' : 'text-gray-400'}>{count}</span>
    </li>
  );
}
