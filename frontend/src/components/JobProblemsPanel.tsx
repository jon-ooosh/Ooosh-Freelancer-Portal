/**
 * JobProblemsPanel — Issues / Problems register slot for Job Detail.
 *
 * Lists open problems on this job + a "Log Problem" button. Backend at
 * /api/problems (NOT /api/issues — that's the platform bug tracker).
 */
import { useState, useEffect, useCallback } from 'react';
import { api } from '../services/api';

type ProblemStatus = 'not_started' | 'in_progress' | 'done' | 'blocked' | 'cancelled';
type ProblemCategory = 'damaged' | 'missing' | 'broken' | 'dispute' | 'other';
type ProblemSeverity = 'normal' | 'urgent';

interface Problem {
  id: string;
  status: ProblemStatus;
  issue_category: ProblemCategory;
  severity: ProblemSeverity;
  summary: string;
  notes: string | null;
  source_module: string | null;
  due_date: string | null;
  created_at: string;
  created_by_name?: string | null;
}

const STATUS_LABELS: Record<ProblemStatus, string> = {
  not_started: 'Open',
  in_progress: 'Working on it',
  done: 'Resolved',
  blocked: 'Awaiting',
  cancelled: 'Cancelled',
};
const STATUS_COLOURS: Record<ProblemStatus, string> = {
  not_started: 'bg-red-100 text-red-700',
  in_progress: 'bg-amber-100 text-amber-700',
  done: 'bg-green-100 text-green-700',
  blocked: 'bg-orange-100 text-orange-700',
  cancelled: 'bg-gray-100 text-gray-500',
};
const CATEGORY_LABELS: Record<ProblemCategory, string> = {
  damaged: 'Damaged', missing: 'Missing', broken: 'Broken', dispute: 'Dispute', other: 'Other',
};
const CATEGORY_ICONS: Record<ProblemCategory, string> = {
  damaged: '🔨', missing: '❓', broken: '⚙️', dispute: '⚖️', other: '⚠️',
};

export default function JobProblemsPanel({ jobId }: { jobId: string }) {
  const [items, setItems] = useState<Problem[]>([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [showResolved, setShowResolved] = useState(false);

  // Form state
  const [category, setCategory] = useState<ProblemCategory>('damaged');
  const [summary, setSummary] = useState('');
  const [notes, setNotes] = useState('');
  const [severity, setSeverity] = useState<ProblemSeverity>('normal');
  const [submitting, setSubmitting] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api.get<{ data: Problem[] }>(`/problems/job/${jobId}`);
      setItems(res.data);
    } catch (err) {
      console.error('Failed to load problems:', err);
    } finally {
      setLoading(false);
    }
  }, [jobId]);

  useEffect(() => { load(); }, [load]);

  async function submit() {
    if (!summary.trim()) return;
    setSubmitting(true);
    try {
      await api.post('/problems', {
        job_id: jobId,
        category,
        summary: summary.trim(),
        notes: notes.trim() || null,
        severity,
      });
      setShowForm(false);
      setSummary(''); setNotes(''); setCategory('damaged'); setSeverity('normal');
      await load();
    } catch (err) {
      console.error('Failed to log problem:', err);
    } finally {
      setSubmitting(false);
    }
  }

  async function changeStatus(id: string, newStatus: ProblemStatus) {
    try {
      await api.patch(`/problems/${id}`, { status: newStatus });
      setItems(prev => prev.map(p => p.id === id ? { ...p, status: newStatus } : p));
    } catch (err) {
      console.error('Failed to update status:', err);
    }
  }

  const open = items.filter(p => p.status !== 'done' && p.status !== 'cancelled');
  const resolved = items.filter(p => p.status === 'done' || p.status === 'cancelled');

  return (
    <div className="bg-white rounded-xl border border-gray-200 p-4 mb-4">
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <h3 className="text-sm font-semibold text-gray-900">Problems</h3>
          {open.length > 0 && (
            <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${
              open.some(p => p.severity === 'urgent') ? 'bg-red-100 text-red-700' : 'bg-amber-100 text-amber-700'
            }`}>
              {open.length} open
            </span>
          )}
        </div>
        <button
          onClick={() => setShowForm(s => !s)}
          className="text-xs px-2.5 py-1 border border-gray-300 rounded hover:bg-gray-50 transition-colors"
        >
          {showForm ? 'Cancel' : '+ Log Problem'}
        </button>
      </div>

      {showForm && (
        <div className="mb-4 border border-gray-200 rounded-lg p-3 bg-gray-50 space-y-2">
          <div className="flex flex-wrap gap-2">
            {(Object.keys(CATEGORY_LABELS) as ProblemCategory[]).map(c => (
              <button
                key={c}
                onClick={() => setCategory(c)}
                className={`px-2.5 py-1 text-xs font-medium rounded-full border transition-colors ${
                  category === c ? 'bg-ooosh-600 text-white border-ooosh-600' : 'bg-white text-gray-600 border-gray-300'
                }`}
              >
                {CATEGORY_ICONS[c]} {CATEGORY_LABELS[c]}
              </button>
            ))}
          </div>
          <input
            type="text"
            value={summary}
            onChange={e => setSummary(e.target.value)}
            placeholder="Short summary (e.g. Scratched bumper RX22SXL)"
            className="w-full border border-gray-300 rounded px-3 py-1.5 text-sm"
          />
          <textarea
            value={notes}
            onChange={e => setNotes(e.target.value)}
            placeholder="Detail (optional) — quote refs, who's chasing, any notes"
            rows={3}
            className="w-full border border-gray-300 rounded px-3 py-1.5 text-sm"
          />
          <div className="flex items-center justify-between">
            <label className="text-xs text-gray-600 flex items-center gap-2">
              <input
                type="checkbox"
                checked={severity === 'urgent'}
                onChange={e => setSeverity(e.target.checked ? 'urgent' : 'normal')}
              />
              ⚠ Mark as urgent
            </label>
            <button
              onClick={submit}
              disabled={!summary.trim() || submitting}
              className="px-3 py-1.5 text-sm bg-ooosh-600 text-white rounded hover:bg-ooosh-700 disabled:opacity-50 transition-colors"
            >
              {submitting ? 'Logging…' : 'Log problem'}
            </button>
          </div>
        </div>
      )}

      {loading ? (
        <div className="text-xs text-gray-400 py-2">Loading…</div>
      ) : items.length === 0 ? (
        <div className="text-xs text-gray-400 py-2 italic">
          No problems on this job.
        </div>
      ) : (
        <>
          {open.length > 0 ? (
            <div className="space-y-2">
              {open.map(p => <Row key={p.id} p={p} onStatusChange={changeStatus} />)}
            </div>
          ) : (
            <div className="text-xs text-gray-400 py-2 italic">No open problems.</div>
          )}
          {resolved.length > 0 && (
            <>
              <button
                onClick={() => setShowResolved(s => !s)}
                className="text-xs text-gray-500 hover:text-gray-700 mt-3"
              >
                {showResolved ? '− Hide' : '+ Show'} {resolved.length} resolved
              </button>
              {showResolved && (
                <div className="space-y-2 mt-2 opacity-60">
                  {resolved.map(p => <Row key={p.id} p={p} onStatusChange={changeStatus} />)}
                </div>
              )}
            </>
          )}
        </>
      )}
    </div>
  );
}

function Row({ p, onStatusChange }: { p: Problem; onStatusChange: (id: string, s: ProblemStatus) => void }) {
  const ageDays = Math.floor((Date.now() - new Date(p.created_at).getTime()) / 86400000);
  return (
    <div className={`border rounded-lg p-2.5 ${p.severity === 'urgent' ? 'border-red-200 bg-red-50/40' : 'border-gray-200'}`}>
      <div className="flex items-start gap-2">
        <span className="text-base">{CATEGORY_ICONS[p.issue_category]}</span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5 mb-0.5 flex-wrap">
            <span className={`px-1.5 py-0.5 rounded text-[10px] font-medium ${STATUS_COLOURS[p.status]}`}>
              {STATUS_LABELS[p.status]}
            </span>
            <span className="px-1.5 py-0.5 rounded text-[10px] font-semibold bg-gray-100 text-gray-700 uppercase">
              {CATEGORY_LABELS[p.issue_category]}
            </span>
            {p.severity === 'urgent' && (
              <span className="px-1.5 py-0.5 rounded text-[10px] font-semibold bg-red-100 text-red-700">⚠ Urgent</span>
            )}
            <span className="text-[10px] text-gray-500">{ageDays === 0 ? 'today' : `${ageDays}d`}</span>
          </div>
          <div className="text-sm text-gray-900">{p.summary}</div>
          {p.notes && <div className="text-xs text-gray-600 mt-1 whitespace-pre-wrap">{p.notes}</div>}
          {p.created_by_name && <div className="text-[10px] text-gray-400 mt-1">Logged by {p.created_by_name}</div>}
        </div>
        <select
          value={p.status}
          onChange={e => onStatusChange(p.id, e.target.value as ProblemStatus)}
          className="text-[11px] border border-gray-300 rounded px-1 py-0.5 flex-shrink-0"
        >
          <option value="not_started">Open</option>
          <option value="in_progress">Working on it</option>
          <option value="blocked">Awaiting</option>
          <option value="done">Resolved</option>
          <option value="cancelled">Cancel</option>
        </select>
      </div>
    </div>
  );
}
