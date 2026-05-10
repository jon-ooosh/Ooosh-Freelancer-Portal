/**
 * Issue Detail page (/operations/problems/:id) — full control panel.
 *
 * Top: header with summary, status, severity, anchors, assignee.
 * Middle: timeline of events (created, status changes, comments, etc.)
 *         + comment box.
 * Right: resolution panel (path, costs with amber "informational" note),
 *        watchers, due date, surface_on, dangerous-zone (resolve, cancel).
 */
import { useState, useEffect, useCallback } from 'react';
import { useParams, Link } from 'react-router-dom';
import { api } from '../services/api';
import ThreadView from '../components/messaging/ThreadView';
import {
  PendingAttachmentStrip,
  useAttachments,
  type InteractionAttachment,
} from '../components/messaging/Attachments';

type IssueStatus = 'open' | 'investigating' | 'awaiting_quote' | 'quoted' | 'actioned' | 'resolved' | 'written_off' | 'cancelled';
type IssueCategory = 'damaged' | 'missing' | 'broken' | 'dispute' | 'breakdown' | 'other';
type IssueSeverity = 'low' | 'normal' | 'urgent';
type ResolutionPath = 'claim_excess' | 'charge_client' | 'write_off' | 'replaced' | 'other';

interface IssueEvent {
  id: string;
  event_type: string;
  body: string | null;
  metadata: Record<string, unknown> | null;
  created_at: string;
  created_by_name: string | null;
}

interface IssueFile {
  id: string;
  r2_key: string;
  filename: string | null;
  file_type: string | null;
  comment: string | null;
  uploaded_at: string;
  uploaded_by_name: string | null;
}

// Comments are now full interactions (Phase F repointing — May 2026).
// Each top-level comment renders via <ThreadView>, which fetches its
// own thread (root + replies + attachments + reactions).
interface IssueComment {
  id: string;
  content: string;
  created_at: string;
  created_by: string;
  created_by_name: string | null;
  parent_interaction_id: string | null;
  mentioned_user_ids: string[] | null;
  files: InteractionAttachment[] | null;
  reactions: Record<string, string[]> | null;
}

interface Issue {
  id: string;
  job_id: string;
  vehicle_id: string | null;
  vehicle_reg: string | null;
  vehicle_type: string | null;
  driver_id: string | null;
  driver_name: string | null;
  person_id: string | null;
  person_name: string | null;
  client_organisation_id: string | null;
  client_organisation_name: string | null;
  hh_stock_item_id: number | null;
  hh_stock_item_name: string | null;
  barcode: string | null;
  category: IssueCategory;
  source_module: string | null;
  severity: IssueSeverity;
  status: IssueStatus;
  resolution_path: ResolutionPath | null;
  summary: string;
  description: string | null;
  reported_by: string;
  reported_by_name: string | null;
  assigned_to: string | null;
  assigned_to_name: string | null;
  watchers: string[];
  due_date: string | null;
  surface_on: string | null;
  estimated_cost: number | null;
  actual_cost: number | null;
  excess_id: string | null;
  created_at: string;
  updated_at: string;
  resolved_at: string | null;
  hh_job_number: number;
  job_name: string | null;
  client_name: string | null;
  events: IssueEvent[];
  files: IssueFile[];
  comments: IssueComment[];
}

const STATUS_LABELS: Record<IssueStatus, string> = {
  open: 'Open',
  investigating: 'Investigating',
  awaiting_quote: 'Awaiting Quote',
  quoted: 'Quoted',
  actioned: 'Actioned',
  resolved: 'Resolved',
  written_off: 'Written Off',
  cancelled: 'Cancelled',
};
const STATUS_COLOURS: Record<IssueStatus, string> = {
  open: 'bg-red-100 text-red-700',
  investigating: 'bg-amber-100 text-amber-700',
  awaiting_quote: 'bg-orange-100 text-orange-700',
  quoted: 'bg-yellow-100 text-yellow-800',
  actioned: 'bg-blue-100 text-blue-700',
  resolved: 'bg-green-100 text-green-700',
  written_off: 'bg-gray-100 text-gray-500',
  cancelled: 'bg-gray-100 text-gray-500',
};
const CATEGORY_LABELS: Record<IssueCategory, string> = {
  damaged: 'Damaged', missing: 'Missing', broken: 'Broken',
  dispute: 'Dispute', breakdown: 'Breakdown', other: 'Other',
};
const CATEGORY_ICONS: Record<IssueCategory, string> = {
  damaged: '🔨', missing: '❓', broken: '⚙️', dispute: '⚖️', breakdown: '🚨', other: '⚠️',
};
const RESOLUTION_LABELS: Record<ResolutionPath, string> = {
  claim_excess: 'Claim against excess',
  charge_client: 'Charge client',
  write_off: 'Write off',
  replaced: 'Replaced',
  other: 'Other',
};

interface User { id: string; first_name: string; last_name: string }

export default function IssueDetailPage() {
  const { id } = useParams<{ id: string }>();
  const [issue, setIssue] = useState<Issue | null>(null);
  const [users, setUsers] = useState<User[]>([]);
  const [loading, setLoading] = useState(true);
  const [comment, setComment] = useState('');
  const [posting, setPosting] = useState(false);
  const attach = useAttachments();

  const load = useCallback(async () => {
    if (!id) return;
    setLoading(true);
    try {
      const res = await api.get<{ data: Issue }>(`/problems/${id}`);
      setIssue(res.data);
    } catch (err) {
      console.error('Failed to load issue:', err);
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => { load(); }, [load]);

  // Load user list for assignee picker once.
  useEffect(() => {
    api.get<{ data: User[] }>('/users')
      .then(res => setUsers(res.data))
      .catch(() => {});
  }, []);

  async function patch(payload: Record<string, unknown>) {
    if (!id) return;
    try {
      const res = await api.patch<{ data: Issue }>(`/problems/${id}`, payload);
      setIssue(prev => prev ? { ...prev, ...res.data } : prev);
      // Reload to get the new event in the timeline.
      load();
    } catch (err) {
      console.error('Update failed:', err);
    }
  }

  async function postComment() {
    if (!id) return;
    const trimmed = comment.trim();
    // Allow attachment-only posts (e.g. dragging in a photo with no text).
    if (!trimmed && attach.pending.length === 0) return;
    setPosting(true);
    try {
      await api.post('/interactions', {
        type: 'note',
        content: trimmed || '(attachment)',
        issue_id: id,
        attachments: attach.payload(),
      });
      setComment('');
      attach.clear();
      load();
    } catch (err) {
      console.error('Comment failed:', err);
    } finally {
      setPosting(false);
    }
  }

  if (loading || !issue) {
    return <div className="text-center py-12 text-gray-500">Loading…</div>;
  }

  const isResolved = ['resolved', 'written_off', 'cancelled'].includes(issue.status);

  return (
    <div className="max-w-5xl mx-auto">
      {/* ── Header ── */}
      <div className="mb-3 text-xs">
        <Link to="/operations/problems" className="text-ooosh-600 hover:underline">← Problems</Link>
        {' · '}
        <Link to={`/jobs/${issue.job_id}`} className="text-ooosh-600 hover:underline">
          Back to job J-{issue.hh_job_number}
        </Link>
      </div>

      <div className={`rounded-xl border p-4 mb-4 ${
        issue.severity === 'urgent' && !isResolved ? 'border-red-300 bg-red-50/40' : 'border-gray-200 bg-white'
      }`}>
        <div className="flex items-start gap-3 flex-wrap">
          <span className="text-2xl">{CATEGORY_ICONS[issue.category]}</span>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2 mb-1 flex-wrap">
              <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${STATUS_COLOURS[issue.status]}`}>
                {STATUS_LABELS[issue.status]}
              </span>
              <span className="px-2 py-0.5 rounded-full text-[10px] font-semibold bg-gray-100 text-gray-700 uppercase">
                {CATEGORY_LABELS[issue.category]}
              </span>
              {issue.severity === 'urgent' && (
                <span className="px-2 py-0.5 rounded-full text-[10px] font-semibold bg-red-100 text-red-700">⚠ Urgent</span>
              )}
              {issue.severity === 'low' && (
                <span className="px-2 py-0.5 rounded-full text-[10px] font-semibold bg-gray-100 text-gray-600">Low</span>
              )}
            </div>
            <h1 className="text-xl font-bold text-gray-900">{issue.summary}</h1>
            <div className="text-xs text-gray-500 mt-1">
              Reported by {issue.reported_by_name || 'unknown'}
              {' · '}
              {new Date(issue.created_at).toLocaleString('en-GB')}
              {issue.resolved_at && ` · Resolved ${new Date(issue.resolved_at).toLocaleString('en-GB')}`}
            </div>
            {issue.description && (
              <p className="text-sm text-gray-700 mt-2 whitespace-pre-wrap">{issue.description}</p>
            )}
          </div>
        </div>

        {/* Subject chips — what the issue is anchored to */}
        <div className="flex flex-wrap gap-2 mt-3">
          <Link
            to={`/jobs/${issue.job_id}`}
            className="text-xs px-2 py-1 rounded bg-blue-50 border border-blue-200 text-blue-700 hover:bg-blue-100"
          >
            📋 J-{issue.hh_job_number} {issue.job_name && `— ${issue.job_name}`}
          </Link>
          {issue.vehicle_id && issue.vehicle_reg && (
            <Link
              to={`/vehicles/fleet/${issue.vehicle_id}`}
              className="text-xs px-2 py-1 rounded bg-green-50 border border-green-200 text-green-700 hover:bg-green-100"
            >
              🚐 {issue.vehicle_reg} {issue.vehicle_type && `— ${issue.vehicle_type}`}
            </Link>
          )}
          {issue.hh_stock_item_name && (
            <span className="text-xs px-2 py-1 rounded bg-purple-50 border border-purple-200 text-purple-700">
              🎸 {issue.hh_stock_item_name}{issue.barcode && ` · ${issue.barcode}`}
            </span>
          )}
          {issue.driver_id && issue.driver_name && (
            <Link
              to={`/drivers/${issue.driver_id}`}
              className="text-xs px-2 py-1 rounded bg-amber-50 border border-amber-200 text-amber-700 hover:bg-amber-100"
            >
              🧑 {issue.driver_name}
            </Link>
          )}
          {issue.person_id && issue.person_name && (
            <Link
              to={`/people/${issue.person_id}`}
              className="text-xs px-2 py-1 rounded bg-amber-50 border border-amber-200 text-amber-700 hover:bg-amber-100"
            >
              👤 {issue.person_name}
            </Link>
          )}
          {issue.client_organisation_id && issue.client_organisation_name && (
            <Link
              to={`/organisations/${issue.client_organisation_id}`}
              className="text-xs px-2 py-1 rounded bg-indigo-50 border border-indigo-200 text-indigo-700 hover:bg-indigo-100"
            >
              🏢 {issue.client_organisation_name}
            </Link>
          )}
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        {/* ── Timeline (left, 2/3) ── */}
        <div className="lg:col-span-2 space-y-4">
          <div className="bg-white rounded-xl border border-gray-200 p-4">
            <h3 className="text-sm font-semibold text-gray-900 mb-3">Timeline</h3>
            <div className="space-y-2">
              {(() => {
                // Merge typed audit events + top-level comments
                // chronologically. Replies on a comment render nested inside
                // its <ThreadView> — we don't surface them at top level here.
                const topComments = (issue.comments ?? []).filter(
                  c => !c.parent_interaction_id
                );
                const items: Array<
                  | { kind: 'event'; ts: string; event: IssueEvent }
                  | { kind: 'comment'; ts: string; comment: IssueComment }
                > = [
                  ...issue.events.map(e => ({ kind: 'event' as const, ts: e.created_at, event: e })),
                  ...topComments.map(c => ({ kind: 'comment' as const, ts: c.created_at, comment: c })),
                ].sort((a, b) => a.ts.localeCompare(b.ts));

                if (items.length === 0) {
                  return <div className="text-xs text-gray-400 italic">No events yet.</div>;
                }
                return items.map(item =>
                  item.kind === 'event'
                    ? <EventRow key={`e-${item.event.id}`} e={item.event} />
                    : (
                      <div key={`c-${item.comment.id}`} className="border border-gray-200 rounded-lg p-3 bg-gray-50/40">
                        <ThreadView interactionId={item.comment.id} onReplied={load} />
                      </div>
                    )
                );
              })()}
            </div>

            {/* Comment box */}
            <div className="mt-4 pt-3 border-t border-gray-100">
              <textarea
                value={comment}
                onChange={e => setComment(e.target.value)}
                onPaste={e => { if (attach.pasteFromEvent(e)) e.preventDefault(); }}
                placeholder="Add a comment, update, or note… (paste images to attach)"
                rows={2}
                className="w-full border border-gray-300 rounded px-3 py-2 text-sm resize-y min-h-[64px]"
              />
              <PendingAttachmentStrip items={attach.pending} onRemove={attach.remove} />
              <div className="flex justify-between items-center mt-2 gap-2">
                <label className="text-[11px] text-gray-500 cursor-pointer hover:text-gray-700">
                  📎 Attach file
                  <input
                    type="file"
                    multiple
                    className="hidden"
                    onChange={e => {
                      if (e.target.files) attach.addFiles(e.target.files);
                      e.target.value = '';
                    }}
                  />
                </label>
                <button
                  onClick={postComment}
                  disabled={(!comment.trim() && attach.pending.length === 0) || posting || attach.hasInFlight}
                  className="px-3 py-1.5 text-xs bg-ooosh-600 text-white rounded hover:bg-ooosh-700 disabled:opacity-50"
                >
                  {posting ? 'Posting…' : attach.hasInFlight ? 'Uploading…' : 'Post comment'}
                </button>
              </div>
            </div>
          </div>

          {/* ── Files attached to this issue ── */}
          <IssueFilesCard
            issueId={issue.id}
            files={issue.files}
            onChange={load}
          />
        </div>

        {/* ── Sidebar (right, 1/3) ── */}
        <div className="space-y-4">
          {/* Status / Severity */}
          <div className="bg-white rounded-xl border border-gray-200 p-4 space-y-3">
            <div>
              <label className="block text-[11px] font-medium text-gray-600 mb-1">Status</label>
              <select
                value={issue.status}
                onChange={e => patch({ status: e.target.value })}
                className="w-full border border-gray-300 rounded px-2 py-1.5 text-sm"
              >
                {(Object.keys(STATUS_LABELS) as IssueStatus[]).map(s => (
                  <option key={s} value={s}>{STATUS_LABELS[s]}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-[11px] font-medium text-gray-600 mb-1">Severity</label>
              <select
                value={issue.severity}
                onChange={e => patch({ severity: e.target.value })}
                className="w-full border border-gray-300 rounded px-2 py-1.5 text-sm"
              >
                <option value="low">Low</option>
                <option value="normal">Normal</option>
                <option value="urgent">Urgent</option>
              </select>
            </div>
          </div>

          {/* Assignee + watchers + due date */}
          <div className="bg-white rounded-xl border border-gray-200 p-4 space-y-3">
            <div>
              <label className="block text-[11px] font-medium text-gray-600 mb-1">Assigned to</label>
              <select
                value={issue.assigned_to || ''}
                onChange={e => patch({ assigned_to: e.target.value || null })}
                className="w-full border border-gray-300 rounded px-2 py-1.5 text-sm"
              >
                <option value="">Unassigned</option>
                {users.map(u => (
                  <option key={u.id} value={u.id}>{u.first_name} {u.last_name}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-[11px] font-medium text-gray-600 mb-1">Resolve by</label>
              <input
                type="date"
                value={issue.due_date ? issue.due_date.split('T')[0] : ''}
                onChange={e => patch({ due_date: e.target.value || null })}
                className="w-full border border-gray-300 rounded px-2 py-1 text-sm"
              />
            </div>
            <div>
              <label className="block text-[11px] font-medium text-gray-600 mb-1">Surface again on</label>
              <select
                value={issue.surface_on || ''}
                onChange={e => patch({ surface_on: e.target.value || null })}
                className="w-full border border-gray-300 rounded px-2 py-1.5 text-xs"
              >
                <option value="">Just live in the register</option>
                <option value="vehicle_check_in">Vehicle next check-in</option>
                <option value="next_hire">Vehicle next hire</option>
                <option value="next_book_out">Vehicle next book-out</option>
                <option value="job_close_out">Block job close-out</option>
              </select>
            </div>
            <div className="text-[11px] text-gray-500 pt-2 border-t border-gray-100">
              {issue.watchers.length} watcher{issue.watchers.length === 1 ? '' : 's'}
            </div>
          </div>

          {/* Resolution panel */}
          <div className="bg-white rounded-xl border border-gray-200 p-4 space-y-3">
            <h3 className="text-sm font-semibold text-gray-900">Resolution</h3>
            <div>
              <label className="block text-[11px] font-medium text-gray-600 mb-1">Path</label>
              <select
                value={issue.resolution_path || ''}
                onChange={e => patch({ resolution_path: e.target.value || null })}
                className="w-full border border-gray-300 rounded px-2 py-1.5 text-sm"
              >
                <option value="">— None yet —</option>
                {(Object.keys(RESOLUTION_LABELS) as ResolutionPath[]).map(r => (
                  <option key={r} value={r}>{RESOLUTION_LABELS[r]}</option>
                ))}
              </select>
            </div>
            <div className="grid grid-cols-2 gap-2">
              <div>
                <label className="block text-[11px] font-medium text-gray-600 mb-1">Estimated</label>
                <input
                  type="number"
                  min={0}
                  step={0.01}
                  defaultValue={issue.estimated_cost ?? ''}
                  onBlur={e => {
                    const v = e.target.value === '' ? null : parseFloat(e.target.value);
                    if (v !== issue.estimated_cost) patch({ estimated_cost: v });
                  }}
                  placeholder="£"
                  className="w-full border border-gray-300 rounded px-2 py-1 text-sm"
                />
              </div>
              <div>
                <label className="block text-[11px] font-medium text-gray-600 mb-1">Actual</label>
                <input
                  type="number"
                  min={0}
                  step={0.01}
                  defaultValue={issue.actual_cost ?? ''}
                  onBlur={e => {
                    const v = e.target.value === '' ? null : parseFloat(e.target.value);
                    if (v !== issue.actual_cost) patch({ actual_cost: v });
                  }}
                  placeholder="£"
                  className="w-full border border-gray-300 rounded px-2 py-1 text-sm"
                />
              </div>
            </div>
            <div className="text-[10px] text-amber-700 bg-amber-50 border border-amber-200 rounded px-2 py-1.5 leading-relaxed">
              ℹ Cost is informational only — future wire-up to HireHop / Xero pending. Don’t double-enter into the Money tab.
            </div>
          </div>

          {/* Quick resolve */}
          {!isResolved && (
            <button
              onClick={() => patch({ status: 'resolved' })}
              className="w-full px-3 py-2 text-sm bg-green-600 text-white rounded-lg hover:bg-green-700 transition-colors"
            >
              ✓ Mark as resolved
            </button>
          )}
          {isResolved && (
            <button
              onClick={() => patch({ status: 'open' })}
              className="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg hover:bg-gray-50 transition-colors"
            >
              Reopen
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function EventRow({ e }: { e: IssueEvent }) {
  let icon = '·';
  let body: React.ReactNode = e.body;

  switch (e.event_type) {
    case 'created':
      icon = '🟢';
      body = body || 'Issue created';
      break;
    case 'comment':
      icon = '💬';
      break;
    case 'status_change': {
      icon = '🔄';
      const from = (e.metadata?.from_status as string) || '';
      const to = (e.metadata?.to_status as string) || '';
      body = `Status: ${from} → ${to}`;
      break;
    }
    case 'assignment': {
      icon = '👤';
      body = `Assignee changed`;
      break;
    }
    case 'severity_change': {
      icon = '⚠️';
      body = `Severity: ${(e.metadata?.from as string) || ''} → ${(e.metadata?.to as string) || ''}`;
      break;
    }
    case 'due_date_change':
      icon = '📅';
      body = `Due date changed`;
      break;
    case 'cost_estimate':
      icon = '💷';
      body = `Cost updated`;
      break;
    case 'resolved':
      icon = '✅';
      body = body || 'Resolved';
      break;
    default:
      icon = '·';
  }

  return (
    <div className="flex items-start gap-2 text-sm">
      <span className="flex-shrink-0">{icon}</span>
      <div className="min-w-0 flex-1">
        <div className="text-gray-700 whitespace-pre-wrap">{body}</div>
        <div className="text-[10px] text-gray-400 mt-0.5">
          {e.created_by_name || 'system'} · {new Date(e.created_at).toLocaleString('en-GB')}
        </div>
      </div>
    </div>
  );
}

/**
 * Issue-level files: documents and photos attached to the issue itself
 * (e.g. contractor quote PDF, insurer letter, photos taken outside a
 * comment). DISTINCT from interaction attachments — those live with the
 * specific comment they were posted with and render via <ThreadView>.
 *
 * The download link routes through /api/files/download with the R2 key so
 * the JWT travels with the request — direct R2 URLs would 401.
 */
function IssueFilesCard({
  issueId, files, onChange,
}: {
  issueId: string;
  files: IssueFile[];
  onChange: () => void;
}) {
  const [uploading, setUploading] = useState(false);
  const [comment, setComment] = useState('');

  async function handleUpload(file: File) {
    setUploading(true);
    try {
      const fd = new FormData();
      fd.append('file', file);
      if (comment.trim()) fd.append('comment', comment.trim());
      await api.upload(`/problems/${issueId}/files`, fd);
      setComment('');
      onChange();
    } catch (err) {
      console.error('File upload failed:', err);
      alert('File upload failed. Please try again.');
    } finally {
      setUploading(false);
    }
  }

  async function handleDelete(fileId: string, filename: string | null) {
    if (!confirm(`Delete ${filename || 'this file'}?`)) return;
    try {
      await api.delete(`/problems/${issueId}/files/${fileId}`);
      onChange();
    } catch (err) {
      console.error('File delete failed:', err);
    }
  }

  async function viewFile(r2Key: string, filename: string | null) {
    // Fetch the file as a blob via the authenticated download endpoint, then
    // open it via a generated object URL — same pattern as the messaging
    // image lightbox. Plain <a href=/api/files/download> 401s because the
    // browser doesn't carry the JWT on direct navigation.
    try {
      const { blob } = await api.blob(`/files/download?key=${encodeURIComponent(r2Key)}`);
      void filename;
      const url = URL.createObjectURL(blob);
      window.open(url, '_blank');
      // Revoke after a delay so the new tab has time to load.
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    } catch (err) {
      console.error('File view failed:', err);
    }
  }

  return (
    <div className="bg-white rounded-xl border border-gray-200 p-4">
      <h3 className="text-sm font-semibold text-gray-900 mb-3">
        Files <span className="text-xs font-normal text-gray-400">({files.length})</span>
      </h3>

      {files.length > 0 && (
        <div className="space-y-1.5 mb-3">
          {files.map(f => (
            <div key={f.id} className="flex items-center gap-2 text-xs p-2 bg-gray-50 rounded border border-gray-100">
              <span className="flex-shrink-0">
                {f.file_type === 'photo' ? '🖼️' : f.file_type === 'pdf' ? '📄' : '📎'}
              </span>
              <div className="min-w-0 flex-1">
                <button
                  onClick={() => viewFile(f.r2_key, f.filename)}
                  className="font-medium text-gray-900 hover:text-ooosh-700 hover:underline truncate block w-full text-left"
                >
                  {f.filename || 'Untitled'}
                </button>
                {f.comment && (
                  <div className="text-[10px] text-gray-600 mt-0.5 italic">{f.comment}</div>
                )}
                <div className="text-[10px] text-gray-400 mt-0.5">
                  {f.uploaded_by_name || 'unknown'} · {new Date(f.uploaded_at).toLocaleString('en-GB')}
                </div>
              </div>
              <button
                onClick={() => handleDelete(f.id, f.filename)}
                className="flex-shrink-0 text-gray-400 hover:text-red-600 text-sm"
                aria-label="Delete file"
              >
                ×
              </button>
            </div>
          ))}
        </div>
      )}

      <div className="pt-3 border-t border-gray-100 space-y-2">
        <input
          type="text"
          value={comment}
          onChange={e => setComment(e.target.value)}
          placeholder="Comment for next upload (optional)"
          className="w-full border border-gray-300 rounded px-2 py-1 text-xs"
        />
        <label className={`block text-xs text-center py-2 border-2 border-dashed border-gray-300 rounded cursor-pointer ${
          uploading ? 'opacity-50' : 'hover:border-ooosh-300 hover:bg-ooosh-50/30'
        }`}>
          {uploading ? 'Uploading…' : '📎 Upload file (PDF, photo, etc.)'}
          <input
            type="file"
            className="hidden"
            disabled={uploading}
            onChange={e => {
              const f = e.target.files?.[0];
              if (f) handleUpload(f);
              e.target.value = '';
            }}
          />
        </label>
      </div>
    </div>
  );
}
