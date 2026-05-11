/**
 * FillGapPage — Operations > Fill a Gap
 *
 * Surface candidate `paused` / `new_enquiry` / `quoting` jobs that could
 * take a freed slot from a cancelled OR lost job. Phase 1 = deterministic
 * SQL scoring (no AI). Linked from the cancelled / lost banners on
 * JobDetailPage.
 *
 * Future phases (captured in CLAUDE.md):
 *  - Phase 2: AI rationale + draft re-engagement emails.
 *  - Phase 3: dashboard widget aggregating freed slots across all recent
 *    cancellations / losses.
 */

import { useState, useEffect, useMemo } from 'react';
import { Link, useParams, useNavigate } from 'react-router-dom';
import { api } from '../services/api';

interface SlotFlags {
  has_vehicle: boolean;
  vehicle_count: number;
  vehicle_types: string[];
  has_backline: boolean;
  backline_item_count: number;
  backline_buckets: string[];   // ['drums', 'keys', 'pa', ...]
  has_rehearsal: boolean;
}

const BUCKET_LABEL: Record<string, string> = {
  guitars: 'Guitars', basses: 'Basses', drums: 'Drums', keys: 'Keys',
  woodwind: 'Woodwind', accessories: 'Backline acc.',
  pa: 'PA/Sound', dj: 'DJ', lighting: 'Lighting', power: 'Power',
  staging: 'Staging', video: 'Video',
};
const bucketLabelFor = (b: string) => BUCKET_LABEL[b] || b;

interface FreedSlot {
  job_id: string;
  hh_job_number: number | null;
  job_name: string;
  client_name: string;
  pipeline_status: string;
  manager_name: string | null;
  dates: { job_date: string | null; job_end: string | null; hire_days: number };
  hire_value_ex_vat: number;
  flags: SlotFlags;
  warning?: string;
}

interface Candidate {
  job_id: string;
  hh_job_number: number | null;
  job_name: string;
  client_name: string;
  manager_name: string | null;
  pipeline_status: string;
  bucket: 'paused' | 'open_enquiry';
  hold_reason: string | null;
  dates: { job_date: string | null; job_end: string | null; hire_days: number };
  hire_value_ex_vat: number;
  flags: SlotFlags;
  match: {
    score: number;
    date_overlap_days: number;
    bundle_match: boolean;
    vehicle_match: boolean;
    backline_match: boolean;
    backline_matched_buckets: string[];
    rehearsal_match: boolean;
    rationale: string[];
  };
  last_interaction_at: string | null;
  last_interaction_snippet: string | null;
}

interface Response {
  freed_slot: FreedSlot;
  candidates: Candidate[];
  totals: { paused: number; open_enquiries: number; total: number; total_before_cap: number };
}

function fmtMoney(v: number): string {
  return `£${Number(v || 0).toFixed(2)}`;
}

function fmtDate(d: string | null): string {
  if (!d) return '—';
  return new Date(d).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
}

function daysAgo(iso: string | null): string {
  if (!iso) return 'No interactions logged';
  const days = Math.floor((Date.now() - new Date(iso).getTime()) / (1000 * 60 * 60 * 24));
  if (days === 0) return 'today';
  if (days === 1) return 'yesterday';
  return `${days}d ago`;
}

function bucketLabel(b: 'paused' | 'open_enquiry'): string {
  return b === 'paused' ? 'Paused enquiry' : 'Open enquiry';
}

// Surface the pause reason next to the bucket pill so staff see at-a-glance
// why a candidate was paused. "No availability" → emerald (gold candidates —
// we *wanted* the work). "Under 4-day window" → amber (judgement call).
// "Other" / legacy / unset → not shown to keep the card uncluttered.
function pausedReasonBadge(reason: string | null): { label: string; classes: string } | null {
  if (!reason) return null;
  if (reason === 'fully_booked') {
    return { label: 'No availability', classes: 'bg-emerald-100 text-emerald-800' };
  }
  if (reason === 'under_minimum') {
    return { label: 'Under 4-day window', classes: 'bg-amber-100 text-amber-800' };
  }
  return null;
}

function statusBadgeColour(status: string): string {
  switch (status) {
    case 'paused': return 'bg-purple-100 text-purple-700';
    case 'new_enquiry': return 'bg-blue-100 text-blue-700';
    case 'quoting': return 'bg-sky-100 text-sky-700';
    default: return 'bg-gray-100 text-gray-700';
  }
}

export default function FillGapPage() {
  const { jobId } = useParams<{ jobId: string }>();
  const navigate = useNavigate();
  const [data, setData] = useState<Response | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [bucketFilter, setBucketFilter] = useState<'all' | 'paused' | 'open_enquiry'>('all');
  const [sort, setSort] = useState<'score' | 'date' | 'value' | 'length'>('score');

  useEffect(() => {
    if (!jobId) return;
    let cancelled = false;
    setLoading(true);
    setError('');
    api.get<Response>(`/fill-gap/${jobId}/candidates`)
      .then(res => { if (!cancelled) setData(res); })
      .catch(err => { if (!cancelled) setError(err?.message || 'Failed to load candidates'); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [jobId]);

  const candidates = useMemo(() => {
    if (!data) return [];
    let out = data.candidates;
    if (bucketFilter !== 'all') {
      out = out.filter(c => c.bucket === bucketFilter);
    }
    out = [...out];
    out.sort((a, b) => {
      switch (sort) {
        case 'date': {
          const ad = a.dates.job_date ? new Date(a.dates.job_date).getTime() : 0;
          const bd = b.dates.job_date ? new Date(b.dates.job_date).getTime() : 0;
          return ad - bd;
        }
        case 'value':
          return b.hire_value_ex_vat - a.hire_value_ex_vat;
        case 'length':
          return b.dates.hire_days - a.dates.hire_days;
        default:
          // score desc, then date asc
          if (b.match.score !== a.match.score) return b.match.score - a.match.score;
          const ad = a.dates.job_date ? new Date(a.dates.job_date).getTime() : 0;
          const bd = b.dates.job_date ? new Date(b.dates.job_date).getTime() : 0;
          return ad - bd;
      }
    });
    return out;
  }, [data, bucketFilter, sort]);

  if (loading) {
    return (
      <div className="p-6 flex justify-center">
        <div className="animate-spin h-6 w-6 border-4 border-ooosh-500 border-t-transparent rounded-full" />
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="p-6">
        <Link to="/jobs/lost-cancelled" className="text-sm text-ooosh-600 hover:underline">&larr; Back</Link>
        <div className="bg-red-50 border border-red-200 rounded-lg p-4 mt-4 text-sm text-red-700">
          {error || 'Job not found.'}
        </div>
      </div>
    );
  }

  const { freed_slot, candidates: allCandidates, totals } = data;

  return (
    <div className="p-4 sm:p-6 max-w-5xl mx-auto">
      <button
        onClick={() => navigate(`/jobs/${jobId}`)}
        className="text-sm text-ooosh-600 hover:text-ooosh-700 mb-4 inline-block"
      >
        &larr; Back to job
      </button>

      <h1 className="text-2xl font-bold text-gray-900 mb-1">Fill a Gap</h1>
      <p className="text-sm text-gray-500 mb-6">
        Replacement candidates for the freed slot. Sorted by match score — bundle &amp; tour-length matches rank highest.
      </p>

      {/* Freed slot summary */}
      <div className="bg-amber-50 border border-amber-200 rounded-xl p-4 mb-6">
        <div className="flex items-start justify-between gap-3 flex-wrap">
          <div>
            <p className="text-xs uppercase tracking-wide text-amber-700 font-semibold">
              Freed slot ({freed_slot.pipeline_status})
            </p>
            <p className="text-lg font-semibold text-amber-900 mt-1">
              {freed_slot.hh_job_number ? `#${freed_slot.hh_job_number} ` : ''}{freed_slot.job_name}
            </p>
            <p className="text-sm text-amber-800">{freed_slot.client_name}</p>
          </div>
          <Link
            to={`/jobs/${freed_slot.job_id}`}
            className="text-xs px-3 py-1.5 bg-white border border-amber-300 rounded-md text-amber-800 hover:bg-amber-100"
          >
            Open job
          </Link>
        </div>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mt-3 text-sm">
          <div>
            <p className="text-xs text-amber-700">Dates</p>
            <p className="text-amber-900 font-medium">
              {fmtDate(freed_slot.dates.job_date)} — {fmtDate(freed_slot.dates.job_end)}
            </p>
            <p className="text-xs text-amber-700">{freed_slot.dates.hire_days}-day window</p>
          </div>
          <div>
            <p className="text-xs text-amber-700">Hire value</p>
            <p className="text-amber-900 font-medium">{fmtMoney(freed_slot.hire_value_ex_vat)} ex-VAT</p>
          </div>
          <div>
            <p className="text-xs text-amber-700">Resources</p>
            <div className="flex flex-wrap gap-1 mt-0.5">
              {freed_slot.flags.has_vehicle && (
                <span className="inline-flex items-center px-1.5 py-0.5 text-xs bg-amber-200 text-amber-900 rounded">
                  🚐 {freed_slot.flags.vehicle_count} van{freed_slot.flags.vehicle_count !== 1 ? 's' : ''}
                </span>
              )}
              {freed_slot.flags.has_rehearsal && (
                <span className="inline-flex items-center px-1.5 py-0.5 text-xs bg-amber-200 text-amber-900 rounded">
                  🏠 Rehearsal
                </span>
              )}
              {freed_slot.flags.backline_buckets.map(b => (
                <span key={b} className="inline-flex items-center px-1.5 py-0.5 text-xs bg-amber-200 text-amber-900 rounded">
                  🎸 {bucketLabelFor(b)}
                </span>
              ))}
              {!freed_slot.flags.has_vehicle &&
                freed_slot.flags.backline_buckets.length === 0 &&
                !freed_slot.flags.has_rehearsal && (
                <span className="text-xs text-amber-700">No resources detected</span>
              )}
            </div>
          </div>
          <div>
            <p className="text-xs text-amber-700">Manager</p>
            <p className="text-amber-900 font-medium">{freed_slot.manager_name || '—'}</p>
          </div>
        </div>
        {freed_slot.warning && (
          <p className="text-xs text-amber-700 mt-3 italic">{freed_slot.warning}</p>
        )}
      </div>

      {/* Filters + totals */}
      <div className="flex items-center justify-between gap-3 mb-4 flex-wrap">
        <div className="flex gap-1 text-sm">
          {(['all', 'paused', 'open_enquiry'] as const).map(b => {
            const count = b === 'all' ? totals.total : (b === 'paused' ? totals.paused : totals.open_enquiries);
            return (
              <button
                key={b}
                onClick={() => setBucketFilter(b)}
                className={`px-3 py-1.5 rounded-md border ${
                  bucketFilter === b
                    ? 'bg-ooosh-600 text-white border-ooosh-600'
                    : 'bg-white text-gray-700 border-gray-300 hover:bg-gray-50'
                }`}
              >
                {b === 'all' ? `All (${count})` : b === 'paused' ? `Paused (${count})` : `Open (${count})`}
              </button>
            );
          })}
        </div>
        <div className="flex items-center gap-2 text-sm">
          <label className="text-xs text-gray-500">Sort:</label>
          <select
            value={sort}
            onChange={e => setSort(e.target.value as typeof sort)}
            className="border border-gray-300 rounded-md px-2 py-1 text-sm"
          >
            <option value="score">Match score</option>
            <option value="date">Job date</option>
            <option value="value">Job value</option>
            <option value="length">Tour length</option>
          </select>
        </div>
      </div>

      {totals.total_before_cap > totals.total && (
        <p className="text-xs text-gray-500 mb-3">
          Showing top {totals.total} of {totals.total_before_cap} matched candidates. Tighten the date range or
          refine the freed slot's resources to narrow further.
        </p>
      )}

      {candidates.length === 0 ? (
        <div className="bg-gray-50 border border-gray-200 rounded-lg p-6 text-center text-sm text-gray-500">
          {allCandidates.length === 0
            ? 'No paused or open enquiries overlap this date window. Try widening the dates on a candidate enquiry, or check back as enquiries arrive.'
            : 'No candidates match the current filter — switch to "All".'}
        </div>
      ) : (
        <ul className="space-y-3">
          {candidates.map(c => (
            <li key={c.job_id} className="bg-white border border-gray-200 rounded-lg p-4 hover:border-ooosh-300 transition-colors">
              <div className="flex items-start justify-between gap-3 flex-wrap">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <Link
                      to={`/jobs/${c.job_id}`}
                      className="text-base font-semibold text-gray-900 hover:text-ooosh-700 hover:underline"
                    >
                      {c.hh_job_number ? `#${c.hh_job_number} ` : ''}{c.job_name}
                    </Link>
                    <span className={`text-xs px-2 py-0.5 rounded ${statusBadgeColour(c.pipeline_status)}`}>
                      {bucketLabel(c.bucket)}
                    </span>
                    {c.bucket === 'paused' && (() => {
                      const badge = pausedReasonBadge(c.hold_reason);
                      return badge ? (
                        <span className={`text-xs px-2 py-0.5 rounded ${badge.classes}`}>
                          {badge.label}
                        </span>
                      ) : null;
                    })()}
                    {c.match.bundle_match && (
                      <span className="text-xs px-2 py-0.5 rounded bg-emerald-100 text-emerald-800 font-medium">
                        🎯 Bundle
                      </span>
                    )}
                  </div>
                  <p className="text-sm text-gray-600 mt-0.5">{c.client_name}</p>
                </div>
                <div className="text-right">
                  <div className="text-xs text-gray-500">Match score</div>
                  <div className={`text-2xl font-bold ${
                    c.match.score >= 75 ? 'text-emerald-700' :
                    c.match.score >= 50 ? 'text-amber-600' :
                    'text-gray-500'
                  }`}>
                    {c.match.score}
                  </div>
                </div>
              </div>

              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mt-3 text-sm">
                <div>
                  <p className="text-xs text-gray-500">Dates</p>
                  <p className="text-gray-800">{fmtDate(c.dates.job_date)} — {fmtDate(c.dates.job_end)}</p>
                  <p className="text-xs text-gray-500">{c.dates.hire_days}-day hire</p>
                </div>
                <div>
                  <p className="text-xs text-gray-500">Hire value</p>
                  <p className="text-gray-800 font-medium">{fmtMoney(c.hire_value_ex_vat)} ex-VAT</p>
                </div>
                <div>
                  <p className="text-xs text-gray-500">Resources</p>
                  <div className="flex flex-wrap gap-1 mt-0.5">
                    {c.flags.has_vehicle && (
                      <span className={`inline-flex items-center px-1.5 py-0.5 text-xs rounded ${
                        c.match.vehicle_match ? 'bg-emerald-100 text-emerald-800' : 'bg-gray-100 text-gray-600'
                      }`}>
                        🚐 {c.flags.vehicle_count}
                      </span>
                    )}
                    {c.flags.has_rehearsal && (
                      <span className={`inline-flex items-center px-1.5 py-0.5 text-xs rounded ${
                        c.match.rehearsal_match ? 'bg-emerald-100 text-emerald-800' : 'bg-gray-100 text-gray-600'
                      }`}>
                        🏠
                      </span>
                    )}
                    {/* Backline buckets — green pill if this bucket overlaps
                        with the freed slot's buckets, grey otherwise. Lets
                        staff see at a glance which categories actually line
                        up rather than just "has backline / doesn't". */}
                    {c.flags.backline_buckets.map(b => {
                      const matched = c.match.backline_matched_buckets.includes(b);
                      return (
                        <span
                          key={b}
                          className={`inline-flex items-center px-1.5 py-0.5 text-xs rounded ${
                            matched ? 'bg-emerald-100 text-emerald-800' : 'bg-gray-100 text-gray-600'
                          }`}
                        >
                          🎸 {bucketLabelFor(b)}
                        </span>
                      );
                    })}
                    {!c.flags.has_vehicle &&
                      c.flags.backline_buckets.length === 0 &&
                      !c.flags.has_rehearsal && (
                      <span className="text-xs text-gray-500">—</span>
                    )}
                  </div>
                </div>
                <div>
                  <p className="text-xs text-gray-500">Last contact</p>
                  <p className="text-gray-800 text-sm">{daysAgo(c.last_interaction_at)}</p>
                  {c.manager_name && (
                    <p className="text-xs text-gray-500">Mgr: {c.manager_name}</p>
                  )}
                </div>
              </div>

              {c.match.rationale.length > 0 && (
                <div className="mt-3 flex flex-wrap gap-1">
                  {c.match.rationale.map((r, i) => (
                    <span key={i} className="text-xs px-2 py-0.5 bg-gray-100 text-gray-700 rounded">
                      {r}
                    </span>
                  ))}
                </div>
              )}

              {c.last_interaction_snippet && (
                <p className="text-xs text-gray-500 italic mt-2 line-clamp-2">
                  Latest note: {c.last_interaction_snippet}
                </p>
              )}
            </li>
          ))}
        </ul>
      )}

      {/* Phase 2 placeholder note */}
      <div className="mt-8 p-3 bg-blue-50 border border-blue-200 rounded-lg text-xs text-blue-800">
        <strong>Phase 1 view.</strong> Candidates ranked deterministically (date overlap × resource match × tour length × bucket).
        Phase 2 will add Claude-generated rationale and draft re-engagement emails per candidate — pending API key configuration.
        Don't auto-email from this page yet; click through to a candidate to compose manually.
      </div>
    </div>
  );
}
