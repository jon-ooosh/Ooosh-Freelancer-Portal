/**
 * "Jobs for this tour" in an expanded lead row — what we've already quoted,
 * booked or lost for these dates (linked automatically when the band matches
 * and the dates overlap, ±14 days). Suggested ones (only named after the band)
 * get Confirm / Not this one; anything can be unlinked, or linked by hand.
 */
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../../services/api';
import { fmtDate, tourJobBadge, Lead, TourJob } from './leadTypes';

interface Candidate { job_id: string; hh_job_number: number | null; job_name: string | null; outcome: TourJob['outcome']; start: string | null; end: string | null; }

export default function LeadTourJobs({ lead, onChanged }: { lead: Lead; onChanged: () => void }) {
  const jobs = lead.tour_jobs ?? [];
  const [linking, setLinking] = useState(false);
  const [candidates, setCandidates] = useState<Candidate[] | null>(null);
  const [number, setNumber] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const call = async (fn: () => Promise<unknown>) => {
    setBusy(true); setError(null);
    try { await fn(); onChanged(); return true; }
    catch (e) { setError(e instanceof Error ? e.message : 'Something went wrong'); return false; }
    finally { setBusy(false); }
  };
  const openLinker = async () => {
    setLinking(true);
    if (lead.matched_organisation_id && candidates == null) {
      try {
        const r = await api.get<{ data: Candidate[] }>(`/leads/${lead.id}/tour-jobs/candidates`);
        setCandidates(r.data);
      } catch { setCandidates([]); }
    }
  };
  const link = async (body: { job_id?: string; hh_job_number?: number }) => {
    if (await call(() => api.post(`/leads/${lead.id}/tour-jobs`, body))) { setLinking(false); setNumber(''); setCandidates(null); }
  };

  return (
    <div className="mb-2">
      <div className="flex flex-wrap items-center gap-x-3 mb-1">
        <span className="text-gray-400">Jobs for this tour</span>
        {!linking && <button onClick={openLinker} className="text-[#7B5EA7] hover:underline">+ Link a job</button>}
      </div>
      {jobs.length === 0 && !linking && <p className="text-gray-400">None found for these dates (±14 days).</p>}
      {jobs.length > 0 && (
        <ul className="space-y-1">
          {jobs.map((j) => {
            const b = tourJobBadge(j);
            return (
              <li key={j.job_id} className="flex flex-wrap items-center gap-x-2">
                <span className={`text-[11px] px-1.5 py-0.5 rounded ${b.cls}`}>{b.icon} {b.text}</span>
                <Link to={`/jobs/${j.job_id}`} className="text-blue-600 hover:underline">{j.job_name || 'Open job'}</Link>
                <span className="text-gray-400">{fmtDate(j.start)} – {fmtDate(j.end)}</span>
                {j.status === 'suggested' ? (
                  <>
                    <span className="text-amber-700">named after the band — is this the tour?</span>
                    <button onClick={() => call(() => api.post(`/leads/${lead.id}/tour-jobs/${j.job_id}/confirm`, {}))} disabled={busy}
                      className="text-green-700 hover:underline">Yes</button>
                    <button onClick={() => call(() => api.delete(`/leads/${lead.id}/tour-jobs/${j.job_id}`))} disabled={busy}
                      className="text-gray-400 hover:underline">Not this one</button>
                  </>
                ) : (
                  <>
                    <span className="text-gray-400">{j.link_type === 'manual' ? 'linked by hand' : j.link_type === 'name' ? 'confirmed' : 'matched'}</span>
                    <button onClick={() => call(() => api.delete(`/leads/${lead.id}/tour-jobs/${j.job_id}`))} disabled={busy}
                      className="text-gray-300 hover:text-red-600" title="Not this tour's job" aria-label="Unlink">×</button>
                  </>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {linking && (
        <div className="mt-2 rounded-lg border border-gray-200 bg-white p-2.5 max-w-xl space-y-2">
          {candidates == null && lead.matched_organisation_id ? (
            <p className="text-gray-400">Loading the band’s jobs…</p>
          ) : (candidates ?? []).length > 0 ? (
            <ul className="space-y-1">
              {(candidates ?? []).map((c) => {
                const b = tourJobBadge({ ...c, status: 'linked', link_type: 'manual', pipeline_status: null, lost_reason: null, job_value: null });
                return (
                  <li key={c.job_id} className="flex flex-wrap items-center gap-x-2">
                    <button onClick={() => link({ job_id: c.job_id })} disabled={busy} className="text-[#7B5EA7] hover:underline">Link</button>
                    <span className="text-gray-800">{c.job_name || 'Job'}</span>
                    <span className="text-gray-400">{b.text} · {fmtDate(c.start)} – {fmtDate(c.end)}</span>
                  </li>
                );
              })}
            </ul>
          ) : lead.matched_organisation_id ? (
            <p className="text-gray-400">No other jobs for this band.</p>
          ) : null}
          <div className="flex items-center gap-2">
            <span className="text-gray-500">HireHop job no.</span>
            <input value={number} onChange={(e) => setNumber(e.target.value.replace(/\D/g, ''))} inputMode="numeric"
              placeholder="e.g. 16352" className="w-28 rounded border border-gray-300 px-2 py-1 text-xs" />
            <button onClick={() => link({ hh_job_number: Number(number) })} disabled={busy || !number}
              className="px-2.5 py-1 rounded bg-[#7B5EA7] text-white hover:bg-[#6a4f92] disabled:opacity-50">Link</button>
            <button onClick={() => { setLinking(false); setError(null); }} className="text-gray-500 hover:text-gray-800">Cancel</button>
          </div>
        </div>
      )}
      {error && <div className="mt-1 text-red-700">{error}</div>}
    </div>
  );
}
