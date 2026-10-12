import { useEffect, useMemo, useState } from 'react';
import { api } from '../services/api';
import { OPTION_COPY } from '../lib/optionCopy';
import { stripOptionSuffix } from '../lib/quoteOptions';
import type { JobGroupRead } from '../../../shared/types';

/**
 * "Quote another option" (spec §5.2) — duplicates this job (OP + HireHop) as the
 * next option of its enquiry. The label is the only required field; the dates
 * are the one piece of job data editable up front because "different dates"
 * is the most common alternative. Kit changes happen in HireHop afterwards.
 *
 * The second mode links an EXISTING job instead (§5.4) — for the enquiries
 * staff already quoted twice by hand before this existed.
 */
interface SourceJob {
  id: string;
  hh_job_number: number | null;
  job_name: string | null;
  option_no?: number | null;
  option_label?: string | null;
  out_date: string | null;
  job_date: string | null;
  job_end: string | null;
  return_date: string | null;
  group_id?: string | null;
}

interface Candidate {
  id: string;
  hh_job_number: number | null;
  job_name: string | null;
  pipeline_status: string;
  job_date: string | null;
  job_end: string | null;
  job_value: number | null;
  client_name: string | null;
  same_client: boolean;
}

interface Props {
  job: SourceJob;
  onClose: () => void;
  /** The new option's job id (navigate there), or null after a link (reload). */
  onDone: (newJobId: string | null) => void;
}

const toDateInput = (d: string | null): string => {
  if (!d) return '';
  return d.includes('T') ? d.split('T')[0] : d;
};

const fmtDate = (d: string | null) =>
  d ? new Date(d).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) : '—';

export default function AddQuoteOptionModal({ job, onClose, onDone }: Props) {
  // The number the new option will get: a lone job becomes Option 1 and the new
  // one Option 2; in a group it's MAX + 1 (read from the group — removed numbers
  // are never reused, so the member count is not enough).
  const [nextOptionNo, setNextOptionNo] = useState(2);
  const [mode, setMode] = useState<'create' | 'link'>('create');

  const [label, setLabel] = useState('');
  const [outDate, setOutDate] = useState(toDateInput(job.out_date));
  const [jobDate, setJobDate] = useState(toDateInput(job.job_date));
  const [jobEnd, setJobEnd] = useState(toDateInput(job.job_end));
  const [returnDate, setReturnDate] = useState(toDateInput(job.return_date));
  const [createInHH, setCreateInHH] = useState(!!job.hh_job_number);

  const [candidates, setCandidates] = useState<Candidate[]>([]);
  const [search, setSearch] = useState('');
  const [loadingCandidates, setLoadingCandidates] = useState(false);
  const [picked, setPicked] = useState<Candidate | null>(null);

  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!job.group_id) return;
    let cancelled = false;
    api.get<{ data: JobGroupRead }>(`/pipeline/groups/${job.group_id}`)
      .then((res) => {
        if (cancelled) return;
        const max = Math.max(0, ...res.data.members.map((m) => m.option_no ?? 0));
        setNextOptionNo(max + 1);
      })
      .catch(() => { /* the button just says Option 2 */ });
    return () => { cancelled = true; };
  }, [job.group_id]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !submitting) onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, submitting]);

  // Link mode: the same client's open quotes by default; a search widens it.
  useEffect(() => {
    if (mode !== 'link') return;
    let cancelled = false;
    const q = search.trim();
    setLoadingCandidates(true);
    const t = setTimeout(async () => {
      try {
        const res = await api.get<{ data: Candidate[] }>(
          `/pipeline/${job.id}/group-candidates${q ? `?q=${encodeURIComponent(q)}` : ''}`,
        );
        if (!cancelled) setCandidates(res.data);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : 'Could not load quotes');
      } finally {
        if (!cancelled) setLoadingCandidates(false);
      }
    }, q ? 250 : 0);
    return () => { cancelled = true; clearTimeout(t); };
  }, [mode, search, job.id]);

  const baseName = useMemo(() => stripOptionSuffix(job.job_name) || 'Untitled job', [job.job_name]);
  const ref = job.hh_job_number ? `#${job.hh_job_number}` : 'not in HireHop';

  async function submitCreate() {
    if (!label.trim()) { setError('Say what is different about this option.'); return; }
    setSubmitting(true);
    setError('');
    try {
      const res = await api.post<{ data: { job: { id: string }; group: JobGroupRead; hh_error?: string; warnings: string[] } }>(
        `/pipeline/${job.id}/add-option`,
        {
          option_label: label.trim(),
          out_date: outDate || null,
          job_date: jobDate || null,
          job_end: jobEnd || null,
          return_date: returnDate || null,
          create_in_hirehop: createInHH,
        },
      );
      const notes: string[] = [];
      if (res.data.hh_error) notes.push(`${OPTION_COPY.createdOpWarn} (${res.data.hh_error})`);
      notes.push(...(res.data.warnings || []));
      if (notes.length) window.alert(`${OPTION_COPY.warningsHeading}\n\n• ${notes.join('\n• ')}`);
      onDone(res.data.job.id);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not create the option');
      setSubmitting(false);
    }
  }

  async function submitLink() {
    if (!picked) return;
    setSubmitting(true);
    setError('');
    try {
      const res = await api.post<{ data: { group: JobGroupRead; warnings: string[] } }>(
        `/pipeline/${job.id}/group-with`,
        { other_job_id: picked.id },
      );
      if (res.data.warnings?.length) window.alert(`${OPTION_COPY.warningsHeading}\n\n• ${res.data.warnings.join('\n• ')}`);
      onDone(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not link the jobs');
      setSubmitting(false);
    }
  }

  const dateField = (lbl: string, value: string, set: (v: string) => void) => (
    <label className="block">
      <span className="block text-[11px] font-semibold text-gray-500 mb-0.5">{lbl}</span>
      <input
        type="date"
        value={value}
        onChange={(e) => set(e.target.value)}
        className="w-full border border-gray-300 rounded-lg px-2 py-1.5 text-sm"
      />
    </label>
  );

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={() => { if (!submitting) onClose(); }}>
      <div
        className="bg-white rounded-2xl shadow-xl w-full max-w-lg max-h-[90vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
      >
        <div className="px-5 pt-5 pb-3 border-b border-gray-100">
          <p className="text-[11px] font-semibold tracking-wide text-gray-400 uppercase">
            {mode === 'create' ? OPTION_COPY.modalTitle : OPTION_COPY.linkExistingTitle}
          </p>
          <h2 className="text-lg font-bold text-gray-900 mt-0.5 truncate">{baseName}</h2>
          <p className="text-xs text-gray-500 mt-0.5">
            {OPTION_COPY.modalBasedOn(job.option_no ?? null, job.option_label ?? null, ref)}
          </p>
        </div>

        {mode === 'create' ? (
          <div className="px-5 py-4 space-y-4">
            <p className="text-sm text-gray-600 bg-ooosh-50/60 border border-ooosh-100 rounded-lg px-3 py-2">
              {OPTION_COPY.modalIntro}
            </p>

            <div>
              <label className="block text-sm font-semibold text-gray-800 mb-1">{OPTION_COPY.labelField}</label>
              <input
                autoFocus
                type="text"
                value={label}
                maxLength={120}
                placeholder={OPTION_COPY.labelPlaceholder}
                onChange={(e) => setLabel(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') submitCreate(); }}
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm"
              />
              <div className="mt-1.5 flex flex-wrap gap-1.5">
                {OPTION_COPY.labelChips.map((chip) => (
                  <button
                    key={chip}
                    type="button"
                    onClick={() => setLabel(chip)}
                    className={`px-2 py-0.5 rounded-full border text-xs transition-colors ${
                      label === chip ? 'border-ooosh-500 bg-ooosh-50 text-ooosh-700' : 'border-gray-200 text-gray-600 hover:bg-gray-50'
                    }`}
                  >
                    {chip}
                  </button>
                ))}
              </div>
              <p className="text-[11px] text-gray-400 mt-1">{OPTION_COPY.labelHint}</p>
            </div>

            <div>
              <div className="flex items-baseline justify-between mb-1">
                <span className="text-sm font-semibold text-gray-800">{OPTION_COPY.datesHeading}</span>
                <span className="text-[11px] text-gray-400">{OPTION_COPY.datesHint}</span>
              </div>
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                {dateField(OPTION_COPY.dateOut, outDate, setOutDate)}
                {dateField(OPTION_COPY.dateStart, jobDate, setJobDate)}
                {dateField(OPTION_COPY.dateEnd, jobEnd, setJobEnd)}
                {dateField(OPTION_COPY.dateReturn, returnDate, setReturnDate)}
              </div>
            </div>

            {job.hh_job_number ? (
              <label className="flex items-start gap-2 text-sm text-gray-700">
                <input
                  type="checkbox"
                  checked={createInHH}
                  onChange={(e) => setCreateInHH(e.target.checked)}
                  className="mt-0.5 h-4 w-4 rounded border-gray-300 text-ooosh-600"
                />
                <span>
                  <span className="font-medium">{OPTION_COPY.hhCheckbox}</span>
                  <span className="block text-xs text-gray-500">{OPTION_COPY.hhCheckboxHint}</span>
                </span>
              </label>
            ) : (
              <p className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
                {OPTION_COPY.hhUnavailable}
              </p>
            )}

            <button
              type="button"
              onClick={() => { setMode('link'); setError(''); }}
              className="text-xs text-ooosh-600 hover:text-ooosh-800"
            >
              {OPTION_COPY.linkExistingToggle}
            </button>
          </div>
        ) : (
          <div className="px-5 py-4 space-y-3">
            <input
              autoFocus
              type="text"
              value={search}
              placeholder={OPTION_COPY.linkExistingSearch}
              onChange={(e) => { setSearch(e.target.value); setPicked(null); }}
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm"
            />
            {!search.trim() && (
              <p className="text-[11px] font-semibold text-gray-500 uppercase tracking-wide">{OPTION_COPY.linkExistingSameClient}</p>
            )}
            <div className="max-h-64 overflow-y-auto border border-gray-100 rounded-lg divide-y divide-gray-100">
              {loadingCandidates && candidates.length === 0 ? (
                <p className="px-3 py-3 text-sm text-gray-400">Loading…</p>
              ) : candidates.length === 0 ? (
                <p className="px-3 py-3 text-sm text-gray-400">{OPTION_COPY.linkExistingNone}</p>
              ) : candidates.map((c) => (
                <button
                  key={c.id}
                  type="button"
                  onClick={() => setPicked(c)}
                  className={`w-full text-left px-3 py-2 text-sm hover:bg-gray-50 ${picked?.id === c.id ? 'bg-ooosh-50' : ''}`}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-medium text-gray-900 truncate">
                      {c.hh_job_number ? `#${c.hh_job_number} · ` : ''}{c.job_name || 'Untitled'}
                    </span>
                    {!c.same_client && (
                      <span className="text-[10px] px-1.5 py-0.5 rounded bg-amber-100 text-amber-800 whitespace-nowrap">
                        {OPTION_COPY.linkExistingDifferentClient}
                      </span>
                    )}
                  </div>
                  <div className="text-xs text-gray-500">
                    {fmtDate(c.job_date)}{c.job_end ? ` – ${fmtDate(c.job_end)}` : ''}
                    {!c.same_client && c.client_name ? ` · ${c.client_name}` : ''}
                  </div>
                </button>
              ))}
            </div>
            <button
              type="button"
              onClick={() => { setMode('create'); setError(''); }}
              className="text-xs text-ooosh-600 hover:text-ooosh-800"
            >
              ← {OPTION_COPY.linkExistingBack}
            </button>
          </div>
        )}

        {error && <p className="px-5 text-sm text-red-600">{error}</p>}

        <div className="px-5 py-3 border-t border-gray-100 flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            disabled={submitting}
            className="px-3 py-1.5 text-sm border border-gray-300 rounded-lg hover:bg-gray-50 disabled:opacity-50"
          >
            {OPTION_COPY.cancel}
          </button>
          {mode === 'create' ? (
            <button
              type="button"
              onClick={submitCreate}
              disabled={submitting || !label.trim()}
              className="px-3 py-1.5 text-sm rounded-lg bg-ooosh-600 text-white font-medium hover:bg-ooosh-700 disabled:opacity-50"
            >
              {submitting ? OPTION_COPY.submitting : OPTION_COPY.submit(nextOptionNo)}
            </button>
          ) : (
            <button
              type="button"
              onClick={submitLink}
              disabled={submitting || !picked}
              className="px-3 py-1.5 text-sm rounded-lg bg-ooosh-600 text-white font-medium hover:bg-ooosh-700 disabled:opacity-50"
            >
              {submitting ? OPTION_COPY.submitting : OPTION_COPY.linkExistingSubmit}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
