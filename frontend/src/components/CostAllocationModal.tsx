/**
 * CostAllocationModal — split one cost (e.g. a bundled freelancer invoice
 * covering several jobs) across those jobs. Writes a cost_allocations row per
 * line via PUT /api/costs/:id/allocations. The allocated total must reconcile
 * to the cost's gross before it can be saved; each line shows that job's
 * expected crew/transport cost (from its quotes) as a sanity check.
 */
import { useState, useEffect } from 'react';
import { api } from '../services/api';

interface AllocCostLite {
  id: string;
  amount_gross: number | null;
  supplier_name: string | null;
  description: string | null;
}

interface Line {
  key: string;
  job_id: string;
  label: string;
  amount: string;
  recharge: boolean;
  notes: string;
  expected?: number | null; // quoted crew/transport cost for the job
}

interface JobSuggestion { id: string; type: string; name: string; subtitle?: string }

const gbp = (n: number) => `£${n.toFixed(2)}`;
let keySeq = 0;
const nextKey = () => `l${keySeq++}`;

export default function CostAllocationModal({ cost, onClose, onSaved }: {
  cost: AllocCostLite;
  onClose: () => void;
  onSaved: () => void;
}) {
  const gross = Number(cost.amount_gross || 0);
  const [lines, setLines] = useState<Line[]>([]);
  const [jobSearch, setJobSearch] = useState('');
  const [jobSuggestions, setJobSuggestions] = useState<JobSuggestion[]>([]);
  const [jobFocused, setJobFocused] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  // Load existing allocations
  useEffect(() => {
    (async () => {
      try {
        const r = await api.get<{ data: { allocations?: Array<{ job_id: string | null; hh_job_number?: number | null; job_name?: string | null; amount: number; recharge: boolean; notes: string | null }> } }>(`/costs/${cost.id}`);
        const existing = (r.data.allocations || []).filter((a) => a.job_id);
        setLines(existing.map((a) => ({
          key: nextKey(),
          job_id: a.job_id as string,
          label: a.hh_job_number ? `#${a.hh_job_number}${a.job_name ? ' – ' + a.job_name : ''}` : '(job)',
          amount: String(a.amount ?? ''),
          recharge: !!a.recharge,
          notes: a.notes || '',
        })));
      } catch { /* start empty */ }
      finally { setLoading(false); }
    })();
  }, [cost.id]);

  // Job search
  useEffect(() => {
    if (jobSearch.trim().length < 2) { setJobSuggestions([]); return; }
    const t = setTimeout(async () => {
      try {
        const r = await api.get<{ results: JobSuggestion[] }>(`/search?q=${encodeURIComponent(jobSearch.trim())}&limit=10`);
        setJobSuggestions((r.results || []).filter((x) => x.type === 'job').slice(0, 8));
      } catch { setJobSuggestions([]); }
    }, 300);
    return () => clearTimeout(t);
  }, [jobSearch]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  async function addJob(s: JobSuggestion) {
    if (lines.some((l) => l.job_id === s.id)) { setJobSearch(''); setJobSuggestions([]); return; }
    const allocatedSoFar = round2(lines.reduce((sum, l) => sum + (Number(l.amount) || 0), 0));
    const remainingNow = round2(gross - allocatedSoFar);
    const line: Line = { key: nextKey(), job_id: s.id, label: s.name, amount: remainingNow > 0 ? remainingNow.toFixed(2) : '', recharge: false, notes: '' };
    setLines((prev) => [...prev, line]);
    setJobSearch('');
    setJobSuggestions([]);
    // Fetch the job's expected crew/transport cost (sum of quote freelancer fees).
    try {
      const qr = await api.get<{ data: Array<{ freelancer_fee: number | null; freelancer_fee_rounded: number | null; status: string | null }> }>(`/quotes?job_id=${s.id}`);
      const exp = (qr.data || []).filter((q) => q.status !== 'cancelled')
        .reduce((sum, q) => sum + Number(q.freelancer_fee_rounded ?? q.freelancer_fee ?? 0), 0);
      setLines((prev) => prev.map((l) => l.job_id === s.id ? { ...l, expected: exp || null } : l));
    } catch { /* no expected */ }
  }

  const setLine = (key: string, patch: Partial<Line>) => setLines((prev) => prev.map((l) => l.key === key ? { ...l, ...patch } : l));
  const removeLine = (key: string) => setLines((prev) => prev.filter((l) => l.key !== key));

  const allocated = round2(lines.reduce((s, l) => s + (Number(l.amount) || 0), 0));
  const remaining = round2(gross - allocated);
  const reconciles = Math.abs(remaining) <= 0.01;

  async function save() {
    setError('');
    if (lines.length && !reconciles) {
      setError(`Allocated ${gbp(allocated)} of ${gbp(gross)} — must match the cost total (${remaining > 0 ? gbp(remaining) + ' left' : gbp(-remaining) + ' over'}).`);
      return;
    }
    if (lines.some((l) => !(Number(l.amount) > 0))) { setError('Every line needs an amount greater than zero.'); return; }
    setSaving(true);
    try {
      await api.put(`/costs/${cost.id}/allocations`, {
        allocations: lines.map((l) => ({ job_id: l.job_id, amount: Number(l.amount), recharge: l.recharge, notes: l.notes || null })),
      });
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save allocations');
    } finally {
      setSaving(false);
    }
  }

  const inputCls = 'border border-gray-300 rounded-md px-2 py-1.5 text-sm focus:ring-2 focus:ring-purple-500';

  return (
    <div className="fixed inset-0 bg-black/40 flex items-start justify-center z-50 p-4 overflow-y-auto" onClick={onClose}>
      <div className="bg-white rounded-lg shadow-xl w-full max-w-2xl my-4" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-200">
          <h2 className="text-lg font-semibold text-gray-900">Split cost across jobs</h2>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 text-xl leading-none">&times;</button>
        </div>

        <div className="px-6 py-4 space-y-4">
          <p className="text-sm text-gray-600">
            {cost.supplier_name || cost.description || 'Cost'} — total <strong>{gbp(gross)}</strong>. Add the jobs this invoice covers and split the amount; the lines must add up to the total.
          </p>

          {loading ? <div className="text-sm text-gray-500">Loading…</div> : (
            <>
              {lines.length > 0 && (
                <div className="space-y-2">
                  {lines.map((l) => (
                    <div key={l.key} className="flex items-center gap-2 flex-wrap border border-gray-100 rounded-md p-2">
                      <div className="flex-1 min-w-[140px]">
                        <div className="text-sm text-gray-800">{l.label}</div>
                        {l.expected != null && <div className="text-xs text-gray-400">quoted cost {gbp(l.expected)}</div>}
                      </div>
                      <div className="flex items-center gap-1">
                        <span className="text-xs text-gray-400">£</span>
                        <input type="number" step="0.01" min="0" className={`${inputCls} w-24`} value={l.amount}
                          onChange={(e) => setLine(l.key, { amount: e.target.value })} />
                      </div>
                      <label className="flex items-center gap-1 text-xs text-gray-600">
                        <input type="checkbox" checked={l.recharge} onChange={(e) => setLine(l.key, { recharge: e.target.checked })} />
                        recharge
                      </label>
                      <button onClick={() => removeLine(l.key)} className="text-red-500 hover:text-red-700 text-sm px-1" title="Remove">🗑</button>
                    </div>
                  ))}
                </div>
              )}

              {/* Add job */}
              <div className="relative">
                <input className={`${inputCls} w-full`} value={jobSearch}
                  onChange={(e) => setJobSearch(e.target.value)}
                  onFocus={() => setJobFocused(true)}
                  onBlur={() => setTimeout(() => setJobFocused(false), 150)}
                  placeholder="Add a job (search by number or name)" autoComplete="off" />
                {jobFocused && jobSuggestions.length > 0 && (
                  <div className="absolute z-10 mt-1 w-full max-h-48 overflow-y-auto bg-white border border-gray-200 rounded-md shadow-lg">
                    {jobSuggestions.map((s) => (
                      <button key={s.id} type="button"
                        onMouseDown={(e) => { e.preventDefault(); addJob(s); }}
                        className="block w-full text-left px-3 py-1.5 text-sm hover:bg-purple-50">
                        {s.name}{s.subtitle ? <span className="text-gray-400"> · {s.subtitle}</span> : null}
                      </button>
                    ))}
                  </div>
                )}
              </div>

              {/* Reconciliation */}
              <div className={`flex items-center justify-between text-sm rounded-md px-3 py-2 ${
                lines.length === 0 ? 'bg-gray-50 text-gray-500'
                  : reconciles ? 'bg-green-50 text-green-700' : 'bg-amber-50 text-amber-700'
              }`}>
                <span>Allocated {gbp(allocated)} of {gbp(gross)}</span>
                <span>{lines.length === 0 ? 'No split' : reconciles ? '✓ reconciles' : remaining > 0 ? `${gbp(remaining)} left` : `${gbp(-remaining)} over`}</span>
              </div>

              {error && <div className="bg-red-50 border border-red-200 text-red-700 text-sm rounded-md px-3 py-2">{error}</div>}
            </>
          )}
        </div>

        <div className="flex justify-between gap-2 px-6 py-4 border-t border-gray-200">
          <span className="text-xs text-gray-400 self-center">{lines.length === 0 ? 'Saving with no lines clears the split.' : ''}</span>
          <div className="flex gap-2">
            <button onClick={onClose} className="px-4 py-2 text-sm text-gray-700 hover:bg-gray-100 rounded-md">Cancel</button>
            <button onClick={save} disabled={saving || loading || (lines.length > 0 && !reconciles)}
              className="px-4 py-2 text-sm text-white bg-purple-600 hover:bg-purple-700 rounded-md disabled:opacity-50">
              {saving ? 'Saving…' : 'Save split'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function round2(n: number) { return Math.round(n * 100) / 100; }
