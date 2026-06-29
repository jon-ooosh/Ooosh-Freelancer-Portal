/**
 * BacklineMatcher — AI equipment-matching search + result panel.
 *
 * Shared by the Operations page (BacklineMatcherPage) and the Job Detail
 * "🛠 Tools" launcher modal. Calls POST /api/backline-matcher/match and renders
 * the structured result (have-it verdict, recommendation, alternatives with
 * availability pills). Native React — inherits OP's JWT auth.
 */
import { useState } from 'react';
import { api } from '../services/api';

interface Alternative {
  stock_id: number | null;
  name: string;
  qty: number | null;
  why: string;
  key_difference: string | null;
  available: number | null;
  imageUrl: string | null;
}

interface MatchResult {
  have_it: 'exact' | 'variant' | 'no';
  headline: string;
  what_it_is: string;
  alternatives: Alternative[];
}

interface MatchResponse {
  success: boolean;
  request: string;
  job: { jobNumber: string; jobName: string; outDate: string | null; returnDate: string | null } | null;
  result: MatchResult;
  availabilityChecked: boolean;
  error?: string;
}

const HAVE_IT_BADGE: Record<MatchResult['have_it'], { label: string; cls: string }> = {
  exact: { label: '✓ Yes — exact match', cls: 'bg-green-100 text-green-800 border-green-300' },
  variant: { label: '≈ Yes — similar variant', cls: 'bg-amber-100 text-amber-800 border-amber-300' },
  no: { label: '✗ No — not in stock', cls: 'bg-red-100 text-red-800 border-red-300' },
};

function availabilityPill(avail: number | null, qty: number | null) {
  if (avail == null) return null;
  if (avail <= 0) {
    return <span className="text-xs font-medium px-2 py-0.5 rounded-full bg-red-100 text-red-700">✗ Unavailable</span>;
  }
  if (qty != null && avail < qty) {
    return <span className="text-xs font-medium px-2 py-0.5 rounded-full bg-amber-100 text-amber-700">{avail} avail</span>;
  }
  return <span className="text-xs font-medium px-2 py-0.5 rounded-full bg-green-100 text-green-700">✓ Available</span>;
}

export default function BacklineMatcher({
  defaultJobNumber,
  onLogged,
}: {
  defaultJobNumber?: string;
  onLogged?: () => void;
}) {
  const [request, setRequest] = useState('');
  const [jobNumber, setJobNumber] = useState(defaultJobNumber || '');
  const [useJob, setUseJob] = useState(Boolean(defaultJobNumber));
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [data, setData] = useState<MatchResponse | null>(null);

  async function runMatch() {
    if (!request.trim()) {
      setError('Enter what the client asked for.');
      return;
    }
    setLoading(true);
    setError(null);
    setData(null);
    try {
      const body: { request: string; jobNumber?: string } = { request: request.trim() };
      if (useJob && jobNumber.trim()) body.jobNumber = jobNumber.trim();
      const resp = await api.post<MatchResponse>('/backline-matcher/match', body);
      setData(resp);
      onLogged?.();
    } catch (err: any) {
      const detail = err?.details ? ` — ${err.details}` : '';
      setError((err?.message || 'Match failed. Try again.') + detail);
    } finally {
      setLoading(false);
    }
  }

  const result = data?.result;
  const badge = result ? HAVE_IT_BADGE[result.have_it] : null;

  return (
    <div className="space-y-4">
      {/* Search form */}
      <div className="bg-white rounded-xl border border-gray-200 p-4 space-y-3">
        <label className="block text-sm font-medium text-gray-700">
          What did the client ask for?
        </label>
        <div className="flex flex-col sm:flex-row gap-2">
          <input
            type="text"
            value={request}
            onChange={(e) => setRequest(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && runMatch()}
            placeholder='e.g. "Nord Stage 4" or "16" floor tom"'
            className="flex-1 px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-ooosh-500 focus:border-ooosh-500"
            autoFocus
          />
          <button
            onClick={runMatch}
            disabled={loading}
            className="px-4 py-2 bg-ooosh-600 text-white rounded-lg text-sm font-medium hover:bg-ooosh-700 disabled:opacity-50 whitespace-nowrap"
          >
            {loading ? 'Searching…' : 'Find alternatives'}
          </button>
        </div>
        <div className="flex items-center gap-2 text-sm">
          <input
            id="bm-usejob"
            type="checkbox"
            checked={useJob}
            onChange={(e) => setUseJob(e.target.checked)}
            className="rounded border-gray-300"
          />
          <label htmlFor="bm-usejob" className="text-gray-600">Check availability for job</label>
          {useJob && (
            <input
              type="text"
              value={jobNumber}
              onChange={(e) => setJobNumber(e.target.value)}
              placeholder="HH job #"
              className="w-28 px-2 py-1 border border-gray-300 rounded text-sm"
            />
          )}
        </div>
      </div>

      {error && (
        <div className="bg-red-50 border border-red-200 text-red-700 text-sm rounded-lg p-3">{error}</div>
      )}

      {loading && (
        <div className="text-center py-8 text-gray-500 text-sm">
          Searching stock and finding alternatives…
        </div>
      )}

      {/* Result */}
      {result && badge && (
        <div className="space-y-3">
          {data?.job && (
            <div className="text-xs text-gray-500">
              Checked against <strong>Job {data.job.jobNumber}</strong>: {data.job.jobName}
              {data.job.outDate && ` · ${data.job.outDate} → ${data.job.returnDate || '?'}`}
            </div>
          )}

          <div className={`inline-flex items-center px-3 py-1 rounded-lg border text-sm font-semibold ${badge.cls}`}>
            {badge.label}
          </div>

          <div className="bg-ooosh-50 border border-ooosh-200 rounded-xl p-4">
            <div className="text-xs font-semibold text-ooosh-700 uppercase tracking-wide mb-1">Recommendation</div>
            <p className="text-sm text-gray-800">{result.headline}</p>
          </div>

          {result.what_it_is && (
            <div className="text-sm text-gray-600">
              <span className="font-medium text-gray-700">What they're asking for: </span>
              {result.what_it_is}
            </div>
          )}

          {result.alternatives.length > 0 && (
            <div className="space-y-2">
              <div className="text-xs font-semibold text-gray-400 uppercase tracking-wide">Alternatives</div>
              {result.alternatives.map((alt, i) => (
                <div key={i} className="bg-white border border-gray-200 rounded-lg p-3">
                  <div className="flex items-start justify-between gap-2">
                    <div className="font-medium text-sm text-gray-900">{alt.name}</div>
                    <div className="flex items-center gap-2 shrink-0">
                      {alt.qty != null && <span className="text-xs text-gray-400">qty {alt.qty}</span>}
                      {availabilityPill(alt.available, alt.qty)}
                    </div>
                  </div>
                  <p className="text-sm text-gray-600 mt-1">{alt.why}</p>
                  {alt.key_difference && (
                    <p className="text-xs text-gray-400 mt-1">Difference: {alt.key_difference}</p>
                  )}
                </div>
              ))}
            </div>
          )}

          {result.alternatives.length === 0 && (
            <div className="text-sm text-gray-500 italic">
              No suitable alternatives in stock — may need to source externally.
            </div>
          )}
        </div>
      )}
    </div>
  );
}
