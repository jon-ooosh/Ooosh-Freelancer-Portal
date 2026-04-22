/**
 * IssuesPage — Operations > Issues
 *
 * Lightweight platform issues tracker. Anyone logged in can:
 *  - Log a new issue (bug, feature request, question, other)
 *  - See all issues + their current status
 *  - Comment on issues (e.g. "I saw this too", "workaround: X")
 *
 * Admin/managers can additionally:
 *  - Change status (new → seen → in_progress → done / deferred / wont_fix)
 *  - Change severity, assign to someone, add resolution notes
 */

import { useState, useEffect, useCallback } from 'react';
import { useSearchParams, useParams, useNavigate } from 'react-router-dom';
import { api } from '../services/api';
import { useAuthStore } from '../hooks/useAuthStore';

interface Issue {
  id: string;
  title: string;
  description: string | null;
  category: string;
  severity: string;
  status: string;
  area: string | null;
  page_url: string | null;
  created_by: string | null;
  assigned_to: string | null;
  resolution_notes: string | null;
  resolved_at: string | null;
  created_at: string;
  updated_at: string;
  reporter_name: string | null;
  reporter_email: string | null;
  assignee_name: string | null;
  assignee_email: string | null;
  comment_count?: number;
}

interface Comment {
  id: string;
  issue_id: string;
  author_id: string | null;
  author_name: string | null;
  author_email: string | null;
  body: string;
  created_at: string;
}

interface IssueDetail extends Issue {
  comments: Comment[];
}

const STATUS_CONFIG: Record<string, { label: string; colour: string }> = {
  new:         { label: 'New',         colour: 'bg-blue-100 text-blue-800 border-blue-300' },
  seen:        { label: 'Seen',        colour: 'bg-purple-100 text-purple-800 border-purple-300' },
  in_progress: { label: 'Working On',  colour: 'bg-amber-100 text-amber-800 border-amber-300' },
  done:        { label: 'Done',        colour: 'bg-green-100 text-green-800 border-green-300' },
  deferred:    { label: 'Deferred',    colour: 'bg-gray-100 text-gray-700 border-gray-300' },
  wont_fix:    { label: "Won't Fix",   colour: 'bg-slate-200 text-slate-700 border-slate-300' },
};

const STATUS_ORDER = ['new', 'seen', 'in_progress', 'deferred', 'done', 'wont_fix'];

const CATEGORY_CONFIG: Record<string, { label: string; emoji: string }> = {
  bug:             { label: 'Bug',             emoji: '🐛' },
  feature_request: { label: 'Feature',         emoji: '✨' },
  question:        { label: 'Question',        emoji: '❓' },
  roadmap:         { label: 'Roadmap',         emoji: '🗺️' },
  other:           { label: 'Other',           emoji: '📌' },
};

const SEVERITY_CONFIG: Record<string, { label: string; colour: string }> = {
  low:    { label: 'Low',    colour: 'text-gray-600' },
  normal: { label: 'Normal', colour: 'text-slate-700' },
  high:   { label: 'High',   colour: 'text-orange-700 font-semibold' },
  urgent: { label: 'Urgent', colour: 'text-red-700 font-bold' },
};

const AREA_OPTIONS = [
  'address_book',
  'pipeline',
  'jobs',
  'money',
  'excess',
  'vehicles',
  'drivers',
  'hire_forms',
  'portal',
  'transport_ops',
  'backline',
  'requirements',
  'inbox',
  'dashboard',
  'auth',
  'other',
];

function formatDate(d: string | null): string {
  if (!d) return '—';
  const date = new Date(d);
  return date.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }) +
    ' ' + date.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
}

function StatusBadge({ status }: { status: string }) {
  const cfg = STATUS_CONFIG[status] || { label: status, colour: 'bg-gray-100 text-gray-700 border-gray-300' };
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium border ${cfg.colour}`}>
      {cfg.label}
    </span>
  );
}

function SeverityLabel({ severity }: { severity: string }) {
  const cfg = SEVERITY_CONFIG[severity] || { label: severity, colour: 'text-slate-700' };
  return <span className={`text-xs ${cfg.colour}`}>{cfg.label}</span>;
}

// ── New issue modal ─────────────────────────────────────────────────────────

function NewIssueModal({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [category, setCategory] = useState('bug');
  const [severity, setSeverity] = useState('normal');
  const [area, setArea] = useState('');
  const [pageUrl, setPageUrl] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    // Pre-fill page URL with referrer or current location if we got here from somewhere meaningful
    if (document.referrer && !document.referrer.includes('/operations/issues')) {
      try {
        const ref = new URL(document.referrer);
        if (ref.host === window.location.host) {
          setPageUrl(ref.pathname + ref.search);
        }
      } catch { /* ignore */ }
    }
  }, []);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      await api.post('/issues', {
        title: title.trim(),
        description: description.trim() || null,
        category,
        severity,
        area: area || null,
        page_url: pageUrl.trim() || null,
      });
      onCreated();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create issue');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 bg-black/50 flex items-start justify-center p-4 overflow-y-auto">
      <div className="bg-white rounded-lg shadow-xl w-full max-w-2xl my-8">
        <div className="px-6 py-4 border-b flex items-center justify-between">
          <h2 className="text-lg font-semibold">Log an issue</h2>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-700 text-2xl leading-none">&times;</button>
        </div>
        <form onSubmit={handleSubmit} className="p-6 space-y-4">
          <p className="text-sm text-gray-600">
            Log any bug, feature request, or question about the Operations Platform. Jon will be emailed when you submit. Please be specific — what you clicked, what you expected to happen, what actually happened.
          </p>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Title *</label>
            <input
              type="text"
              value={title}
              onChange={e => setTitle(e.target.value)}
              required
              minLength={3}
              maxLength={300}
              placeholder="e.g. Payment Received email had the wrong amount"
              className="w-full border border-gray-300 rounded px-3 py-2 text-sm"
            />
          </div>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Category</label>
              <select
                value={category}
                onChange={e => setCategory(e.target.value)}
                className="w-full border border-gray-300 rounded px-3 py-2 text-sm"
              >
                {Object.entries(CATEGORY_CONFIG).map(([k, v]) => (
                  <option key={k} value={k}>{v.emoji} {v.label}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Severity</label>
              <select
                value={severity}
                onChange={e => setSeverity(e.target.value)}
                className="w-full border border-gray-300 rounded px-3 py-2 text-sm"
              >
                <option value="low">Low</option>
                <option value="normal">Normal</option>
                <option value="high">High</option>
                <option value="urgent">Urgent</option>
              </select>
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Area</label>
              <select
                value={area}
                onChange={e => setArea(e.target.value)}
                className="w-full border border-gray-300 rounded px-3 py-2 text-sm"
              >
                <option value="">— pick an area —</option>
                {AREA_OPTIONS.map(a => (
                  <option key={a} value={a}>{a.replace(/_/g, ' ')}</option>
                ))}
              </select>
            </div>
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Description
            </label>
            <textarea
              value={description}
              onChange={e => setDescription(e.target.value)}
              rows={6}
              placeholder={`What happened?\nWhat did you expect to happen?\nSteps to reproduce (if it's a bug):\n1.\n2.\n3.`}
              className="w-full border border-gray-300 rounded px-3 py-2 text-sm font-mono"
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Page / URL (optional)</label>
            <input
              type="text"
              value={pageUrl}
              onChange={e => setPageUrl(e.target.value)}
              placeholder="e.g. /jobs/abc-123 or https://..."
              className="w-full border border-gray-300 rounded px-3 py-2 text-sm"
            />
          </div>

          {error && <div className="text-sm text-red-700 bg-red-50 border border-red-200 rounded p-2">{error}</div>}

          <div className="flex justify-end gap-2 pt-2">
            <button type="button" onClick={onClose} className="px-4 py-2 text-sm text-gray-700 hover:bg-gray-100 rounded">Cancel</button>
            <button
              type="submit"
              disabled={submitting || title.trim().length < 3}
              className="px-4 py-2 text-sm bg-ooosh-600 text-white rounded hover:bg-ooosh-700 disabled:opacity-50"
            >
              {submitting ? 'Submitting…' : 'Submit issue'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

// ── Issue detail modal ──────────────────────────────────────────────────────

function IssueDetailModal({
  issueId,
  canTriage,
  onClose,
  onChanged,
}: {
  issueId: string;
  canTriage: boolean;
  onClose: () => void;
  onChanged: () => void;
}) {
  const [issue, setIssue] = useState<IssueDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [newComment, setNewComment] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api.get<{ data: IssueDetail }>(`/issues/${issueId}`);
      setIssue(res.data);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load issue');
    } finally {
      setLoading(false);
    }
  }, [issueId]);

  useEffect(() => { load(); }, [load]);

  async function updateField(field: string, value: string | null) {
    try {
      await api.patch(`/issues/${issueId}`, { [field]: value });
      await load();
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Update failed');
    }
  }

  async function postComment() {
    if (!newComment.trim()) return;
    setSubmitting(true);
    try {
      await api.post(`/issues/${issueId}/comments`, { body: newComment.trim() });
      setNewComment('');
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to post comment');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 bg-black/50 flex items-start justify-center p-4 overflow-y-auto">
      <div className="bg-white rounded-lg shadow-xl w-full max-w-3xl my-8">
        {loading || !issue ? (
          <div className="p-8 text-center text-gray-500">Loading…</div>
        ) : (
          <>
            <div className="px-6 py-4 border-b flex items-start justify-between gap-4">
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 flex-wrap mb-1">
                  <span className="text-lg">{CATEGORY_CONFIG[issue.category]?.emoji || '📌'}</span>
                  <StatusBadge status={issue.status} />
                  <SeverityLabel severity={issue.severity} />
                  {issue.area && <span className="text-xs text-gray-500">&middot; {issue.area.replace(/_/g, ' ')}</span>}
                </div>
                <h2 className="text-lg font-semibold break-words">{issue.title}</h2>
                <p className="text-xs text-gray-500 mt-1">
                  Logged {formatDate(issue.created_at)} by {issue.reporter_name || issue.reporter_email || 'unknown'}
                  {issue.assignee_name && <> &middot; Assigned to {issue.assignee_name}</>}
                </p>
              </div>
              <button onClick={onClose} className="text-gray-400 hover:text-gray-700 text-2xl leading-none">&times;</button>
            </div>

            <div className="p-6 space-y-5">
              {/* Triage controls (admin/manager only) */}
              {canTriage && (
                <div className="bg-ooosh-50 border border-ooosh-200 rounded p-3">
                  <div className="text-xs font-medium text-ooosh-900 mb-2">Triage</div>
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className="block text-xs text-gray-600 mb-1">Status</label>
                      <select
                        value={issue.status}
                        onChange={e => updateField('status', e.target.value)}
                        className="w-full border border-gray-300 rounded px-2 py-1 text-sm"
                      >
                        {STATUS_ORDER.map(s => (
                          <option key={s} value={s}>{STATUS_CONFIG[s].label}</option>
                        ))}
                      </select>
                    </div>
                    <div>
                      <label className="block text-xs text-gray-600 mb-1">Severity</label>
                      <select
                        value={issue.severity}
                        onChange={e => updateField('severity', e.target.value)}
                        className="w-full border border-gray-300 rounded px-2 py-1 text-sm"
                      >
                        <option value="low">Low</option>
                        <option value="normal">Normal</option>
                        <option value="high">High</option>
                        <option value="urgent">Urgent</option>
                      </select>
                    </div>
                  </div>
                </div>
              )}

              {/* Description */}
              <div>
                <div className="text-xs font-medium text-gray-500 uppercase mb-1">Description</div>
                <div className="text-sm text-gray-800 whitespace-pre-wrap bg-gray-50 rounded p-3 border border-gray-200">
                  {issue.description || <span className="text-gray-400 italic">No description</span>}
                </div>
              </div>

              {issue.page_url && (
                <div>
                  <div className="text-xs font-medium text-gray-500 uppercase mb-1">Page / context</div>
                  <div className="text-sm text-gray-700 break-all">{issue.page_url}</div>
                </div>
              )}

              {issue.resolution_notes && (
                <div>
                  <div className="text-xs font-medium text-gray-500 uppercase mb-1">Resolution notes</div>
                  <div className="text-sm text-gray-800 whitespace-pre-wrap bg-green-50 rounded p-3 border border-green-200">
                    {issue.resolution_notes}
                  </div>
                </div>
              )}

              {/* Comments */}
              <div>
                <div className="text-xs font-medium text-gray-500 uppercase mb-2">
                  Comments ({issue.comments.length})
                </div>
                <div className="space-y-2 mb-3">
                  {issue.comments.length === 0 && (
                    <div className="text-sm text-gray-400 italic">No comments yet.</div>
                  )}
                  {issue.comments.map(c => (
                    <div key={c.id} className="bg-white border border-gray-200 rounded p-3">
                      <div className="flex items-center justify-between mb-1">
                        <span className="text-xs font-medium text-gray-700">
                          {c.author_name || c.author_email || 'unknown'}
                        </span>
                        <span className="text-xs text-gray-400">{formatDate(c.created_at)}</span>
                      </div>
                      <div className="text-sm text-gray-800 whitespace-pre-wrap">{c.body}</div>
                    </div>
                  ))}
                </div>
                <div className="flex gap-2">
                  <textarea
                    value={newComment}
                    onChange={e => setNewComment(e.target.value)}
                    rows={2}
                    placeholder="Add a comment, workaround, or update…"
                    className="flex-1 border border-gray-300 rounded px-3 py-2 text-sm"
                  />
                  <button
                    onClick={postComment}
                    disabled={submitting || !newComment.trim()}
                    className="px-4 py-2 text-sm bg-ooosh-600 text-white rounded hover:bg-ooosh-700 disabled:opacity-50 self-start"
                  >
                    Post
                  </button>
                </div>
              </div>

              {/* Admin resolution notes editor */}
              {canTriage && (
                <details className="text-sm">
                  <summary className="cursor-pointer text-gray-600 hover:text-gray-800">Edit resolution notes</summary>
                  <ResolutionNotesEditor
                    issue={issue}
                    onSave={async (notes) => {
                      await updateField('resolution_notes', notes);
                    }}
                  />
                </details>
              )}

              {error && <div className="text-sm text-red-700 bg-red-50 border border-red-200 rounded p-2">{error}</div>}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function ResolutionNotesEditor({ issue, onSave }: { issue: IssueDetail; onSave: (notes: string) => Promise<void> }) {
  const [notes, setNotes] = useState(issue.resolution_notes || '');
  const [saving, setSaving] = useState(false);
  return (
    <div className="mt-2 space-y-2">
      <textarea
        value={notes}
        onChange={e => setNotes(e.target.value)}
        rows={3}
        className="w-full border border-gray-300 rounded px-3 py-2 text-sm"
      />
      <button
        onClick={async () => { setSaving(true); await onSave(notes); setSaving(false); }}
        disabled={saving}
        className="px-3 py-1 text-sm bg-ooosh-600 text-white rounded hover:bg-ooosh-700 disabled:opacity-50"
      >
        {saving ? 'Saving…' : 'Save notes'}
      </button>
    </div>
  );
}

// ── Main page ───────────────────────────────────────────────────────────────

export default function IssuesPage() {
  const [issues, setIssues] = useState<Issue[]>([]);
  const [stats, setStats] = useState<Record<string, number>>({});
  const [loading, setLoading] = useState(true);
  const [showNew, setShowNew] = useState(false);
  const [detailId, setDetailId] = useState<string | null>(null);
  const [searchParams, setSearchParams] = useSearchParams();
  const { id: routeId } = useParams<{ id: string }>();
  const navigate = useNavigate();

  const user = useAuthStore(s => s.user);
  const canTriage = user?.role === 'admin' || user?.role === 'manager';

  const statusFilter = searchParams.get('status') || 'open'; // default: hide done/wont_fix
  const categoryFilter = searchParams.get('category') || '';
  const search = searchParams.get('search') || '';

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (statusFilter === 'open') {
        params.set('status', 'new,seen,in_progress,deferred');
      } else if (statusFilter !== 'all') {
        params.set('status', statusFilter);
      }
      if (categoryFilter) params.set('category', categoryFilter);
      if (search) params.set('search', search);

      const res = await api.get<{ data: Issue[]; stats: Record<string, number> }>(`/issues?${params}`);
      setIssues(res.data);
      setStats(res.stats || {});
    } catch (err) {
      console.error('Failed to load issues:', err);
    } finally {
      setLoading(false);
    }
  }, [statusFilter, categoryFilter, search]);

  useEffect(() => { load(); }, [load]);

  // Deep link /operations/issues/:id or ?issue=<id> opens detail modal
  useEffect(() => {
    const linkId = routeId || searchParams.get('issue');
    if (linkId) setDetailId(linkId);
  }, [routeId, searchParams]);

  function updateFilter(key: string, value: string) {
    const next = new URLSearchParams(searchParams);
    if (value) next.set(key, value);
    else next.delete(key);
    setSearchParams(next);
  }

  const totalOpen = (stats.new || 0) + (stats.seen || 0) + (stats.in_progress || 0) + (stats.deferred || 0);

  return (
    <div className="p-6 max-w-6xl mx-auto">
      <div className="flex items-start justify-between flex-wrap gap-4 mb-6">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Platform Issues</h1>
          <p className="text-sm text-gray-600 mt-1 max-w-2xl">
            Log bugs, feature requests and questions about the Operations Platform. Jon gets an email alert on each new issue, and you can track its status here.
          </p>
        </div>
        <button
          onClick={() => setShowNew(true)}
          className="px-4 py-2 bg-ooosh-600 text-white rounded hover:bg-ooosh-700 font-medium text-sm"
        >
          + Log an issue
        </button>
      </div>

      {/* Stats strip */}
      <div className="grid grid-cols-2 sm:grid-cols-6 gap-2 mb-6">
        <StatCard label="Open" value={totalOpen} active={statusFilter === 'open'} onClick={() => updateFilter('status', 'open')} />
        <StatCard label="New" value={stats.new || 0} active={statusFilter === 'new'} onClick={() => updateFilter('status', 'new')} />
        <StatCard label="Working On" value={stats.in_progress || 0} active={statusFilter === 'in_progress'} onClick={() => updateFilter('status', 'in_progress')} />
        <StatCard label="Deferred" value={stats.deferred || 0} active={statusFilter === 'deferred'} onClick={() => updateFilter('status', 'deferred')} />
        <StatCard label="Done" value={stats.done || 0} active={statusFilter === 'done'} onClick={() => updateFilter('status', 'done')} />
        <StatCard label="All" value={(stats.new || 0) + (stats.seen || 0) + (stats.in_progress || 0) + (stats.deferred || 0) + (stats.done || 0) + (stats.wont_fix || 0)} active={statusFilter === 'all'} onClick={() => updateFilter('status', 'all')} />
      </div>

      {/* Filters */}
      <div className="flex flex-wrap items-center gap-2 mb-4">
        <select
          value={categoryFilter}
          onChange={e => updateFilter('category', e.target.value)}
          className="border border-gray-300 rounded px-3 py-1.5 text-sm"
        >
          <option value="">All categories</option>
          {Object.entries(CATEGORY_CONFIG).map(([k, v]) => (
            <option key={k} value={k}>{v.emoji} {v.label}</option>
          ))}
        </select>
        <input
          type="text"
          defaultValue={search}
          onKeyDown={e => { if (e.key === 'Enter') updateFilter('search', (e.target as HTMLInputElement).value); }}
          placeholder="Search title or description (press Enter)"
          className="flex-1 min-w-[200px] border border-gray-300 rounded px-3 py-1.5 text-sm"
        />
      </div>

      {/* Issue list */}
      {loading ? (
        <div className="text-center py-12 text-gray-500">Loading…</div>
      ) : issues.length === 0 ? (
        <div className="text-center py-12 text-gray-500 bg-gray-50 rounded-lg border border-dashed border-gray-300">
          No issues match the current filters.
        </div>
      ) : (
        <div className="bg-white border border-gray-200 rounded-lg overflow-hidden">
          <div className="overflow-x-auto">
            <table className="min-w-full divide-y divide-gray-200">
              <thead className="bg-gray-50">
                <tr>
                  <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase">Issue</th>
                  <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase">Area</th>
                  <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase">Status</th>
                  <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase">Severity</th>
                  <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase">Logged</th>
                  <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase">By</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {issues.map(issue => (
                  <tr
                    key={issue.id}
                    onClick={() => setDetailId(issue.id)}
                    className="hover:bg-gray-50 cursor-pointer"
                  >
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-2">
                        <span>{CATEGORY_CONFIG[issue.category]?.emoji || '📌'}</span>
                        <span className="text-sm font-medium text-gray-900">{issue.title}</span>
                        {(issue.comment_count ?? 0) > 0 && (
                          <span className="text-xs text-gray-500">💬 {issue.comment_count}</span>
                        )}
                      </div>
                    </td>
                    <td className="px-4 py-3 text-sm text-gray-600">{issue.area?.replace(/_/g, ' ') || '—'}</td>
                    <td className="px-4 py-3"><StatusBadge status={issue.status} /></td>
                    <td className="px-4 py-3"><SeverityLabel severity={issue.severity} /></td>
                    <td className="px-4 py-3 text-xs text-gray-500 whitespace-nowrap">{formatDate(issue.created_at)}</td>
                    <td className="px-4 py-3 text-xs text-gray-600 whitespace-nowrap">{issue.reporter_name || issue.reporter_email || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {showNew && (
        <NewIssueModal
          onClose={() => setShowNew(false)}
          onCreated={() => load()}
        />
      )}

      {detailId && (
        <IssueDetailModal
          issueId={detailId}
          canTriage={canTriage}
          onClose={() => {
            setDetailId(null);
            const next = new URLSearchParams(searchParams);
            next.delete('issue');
            // If we got here via /operations/issues/:id, go back to list URL
            if (routeId) {
              navigate(`/operations/issues${next.toString() ? '?' + next.toString() : ''}`, { replace: true });
            } else {
              setSearchParams(next);
            }
          }}
          onChanged={() => load()}
        />
      )}
    </div>
  );
}

function StatCard({ label, value, active, onClick }: { label: string; value: number; active: boolean; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className={`p-3 rounded border text-left transition-colors ${
        active
          ? 'bg-ooosh-600 text-white border-ooosh-700'
          : 'bg-white border-gray-200 hover:border-ooosh-400'
      }`}
    >
      <div className={`text-2xl font-bold ${active ? 'text-white' : 'text-gray-900'}`}>{value}</div>
      <div className={`text-xs ${active ? 'text-ooosh-100' : 'text-gray-500'}`}>{label}</div>
    </button>
  );
}
