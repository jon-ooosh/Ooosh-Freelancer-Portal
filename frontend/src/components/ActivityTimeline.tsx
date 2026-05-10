import { useState, useEffect, useRef, useCallback } from 'react';
import { api } from '../services/api';
import { useAuthStore } from '../hooks/useAuthStore';
import {
  AttachmentList,
  PendingAttachmentStrip,
  useAttachments,
  type InteractionAttachment,
} from './messaging/Attachments';
import Reactions, { type ReactionsMap } from './messaging/Reactions';

interface Interaction {
  id: string;
  type: string;
  content: string;
  created_at: string;
  created_by_name: string | null;
  mentioned_user_ids: string[];
  job_status_at_creation?: number | null;
  job_status_name_at_creation?: string | null;
  // Threading + attachments (added in migration 076)
  parent_interaction_id?: string | null;
  issue_id?: string | null;
  files?: InteractionAttachment[];
  // Lightweight emoji reactions (migration 077)
  reactions?: ReactionsMap;
}

const JOB_STATUS_MAP: Record<number, string> = {
  0: 'Enquiry', 1: 'Provisional', 2: 'Booked', 3: 'Prepped',
  4: 'Part Dispatched', 5: 'Dispatched', 6: 'Returned Incomplete',
  7: 'Returned', 8: 'Requires Attention', 9: 'Cancelled',
  10: 'Not Interested', 11: 'Completed',
};

const JOB_STATUS_COLOURS: Record<number, string> = {
  0: 'bg-blue-50 text-blue-600 border-blue-200',
  1: 'bg-amber-50 text-amber-600 border-amber-200',
  2: 'bg-green-50 text-green-600 border-green-200',
  3: 'bg-purple-50 text-purple-600 border-purple-200',
  4: 'bg-orange-50 text-orange-600 border-orange-200',
  5: 'bg-indigo-50 text-indigo-600 border-indigo-200',
  6: 'bg-yellow-50 text-yellow-700 border-yellow-200',
  7: 'bg-teal-50 text-teal-600 border-teal-200',
  8: 'bg-red-50 text-red-600 border-red-200',
  9: 'bg-gray-50 text-gray-400 border-gray-200',
  10: 'bg-gray-50 text-gray-400 border-gray-200',
  11: 'bg-emerald-50 text-emerald-600 border-emerald-200',
};

interface UserOption {
  id: string;
  email: string;
  first_name: string | null;
  last_name: string | null;
}

interface SearchResult {
  id: string;
  label: string;
  type: 'person_id' | 'organisation_id' | 'venue_id';
  entityLabel: string;
}

interface ActivityTimelineProps {
  entityType: 'person_id' | 'organisation_id' | 'venue_id' | 'job_id';
  entityId: string;
  interactions: Interaction[];
  onInteractionAdded: () => void;
}

const TYPE_COLORS: Record<string, string> = {
  note: 'bg-blue-100 text-blue-700',
  call: 'bg-green-100 text-green-700',
  email: 'bg-purple-100 text-purple-700',
  meeting: 'bg-amber-100 text-amber-700',
  chase: 'bg-orange-100 text-orange-700',
  mention: 'bg-pink-100 text-pink-700',
};

const TYPE_ICONS: Record<string, string> = {
  note: 'N', call: 'C', email: 'E', meeting: 'M', chase: 'Ch', mention: '@',
};

function addDays(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d.toISOString().split('T')[0];
}

function formatDateTime(dateStr: string) {
  return new Date(dateStr).toLocaleDateString('en-GB', {
    day: 'numeric', month: 'short', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
  });
}

export default function ActivityTimeline({ entityType, entityId, interactions, onInteractionAdded }: ActivityTimelineProps) {
  const user = useAuthStore((s) => s.user);

  const [content, setContent] = useState('');
  const [interactionType, setInteractionType] = useState<string>('note');
  const [submitting, setSubmitting] = useState(false);

  // Chase-specific fields
  const [chaseMethod, setChaseMethod] = useState<string>('phone');
  const [nextChaseDate, setNextChaseDate] = useState('');
  const [selectedChasePreset, setSelectedChasePreset] = useState<string | null>(null);
  const [chaseAlertUserId, setChaseAlertUserId] = useState('');

  // Auto-chase-bump opt-out — for backdated or non-consequential contact
  // events. Only meaningful for call/email/meeting on a job, where the
  // backend would otherwise push next_chase_date forward.
  const [skipChaseBump, setSkipChaseBump] = useState(false);

  // ── Attachments — one hook instance per composer ────────────────────────
  // Top-level composer (always rendered) + reply composer (open when
  // replyParentId is set). Each maintains its own pending-upload state,
  // preview-URL lifecycle, paste/drop helpers via useAttachments.
  const topAttach = useAttachments();
  const replyAttach = useAttachments();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [isDragging, setIsDragging] = useState(false);

  // ── Reply mode ───────────────────────────────────────────────────────────
  const [replyParentId, setReplyParentId] = useState<string | null>(null);
  const [replyContent, setReplyContent] = useState('');
  const [replySubmitting, setReplySubmitting] = useState(false);

  // Reply-composer @mention state — parallel to the top-level composer.
  // Only one reply composer can be open at a time (replyParentId is a
  // single value), so a single set of state suffices.
  const [replyShowMentions, setReplyShowMentions] = useState(false);
  const [replyMentionFilter, setReplyMentionFilter] = useState('');
  const [replyMentionIndex, setReplyMentionIndex] = useState(0);
  const [replyMentionedIds, setReplyMentionedIds] = useState<string[]>([]);
  const replyTextareaRef = useRef<HTMLTextAreaElement>(null);

  // ── Thread expand/collapse ───────────────────────────────────────────────
  // Threads with > 2 replies collapse the middle by default; clicking
  // expands them.
  const [expandedThreads, setExpandedThreads] = useState<Set<string>>(new Set());
  function toggleThread(rootId: string) {
    setExpandedThreads((prev) => {
      const next = new Set(prev);
      if (next.has(rootId)) next.delete(rootId);
      else next.add(rootId);
      return next;
    });
  }

  // Thin adapters so the existing JSX (which used handleFiles + handlePaste
  // with a 'top'|'reply' target arg) keeps working against the new hooks.
  function handleFiles(files: FileList | File[], target: 'top' | 'reply') {
    (target === 'top' ? topAttach : replyAttach).addFiles(files);
  }
  function handlePaste(e: React.ClipboardEvent, target: 'top' | 'reply') {
    const handled = (target === 'top' ? topAttach : replyAttach).pasteFromEvent(e);
    if (handled) e.preventDefault();
  }
  function removeAttachment(localId: string, target: 'top' | 'reply') {
    (target === 'top' ? topAttach : replyAttach).remove(localId);
  }

  // Move interaction
  const [movingId, setMovingId] = useState<string | null>(null);
  const [moveSearch, setMoveSearch] = useState('');
  const [moveResults, setMoveResults] = useState<SearchResult[]>([]);
  const [moveLoading, setMoveLoading] = useState(false);
  const moveSearchRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  function startMove(interactionId: string) {
    setMovingId(movingId === interactionId ? null : interactionId);
    setMoveSearch('');
    setMoveResults([]);
  }

  function searchEntities(q: string) {
    setMoveSearch(q);
    if (moveSearchRef.current) clearTimeout(moveSearchRef.current);
    if (q.trim().length < 2) { setMoveResults([]); return; }

    moveSearchRef.current = setTimeout(async () => {
      setMoveLoading(true);
      try {
        const results: SearchResult[] = [];
        const [peopleRes, orgsRes, venuesRes] = await Promise.all([
          api.get<{ data: Array<{ id: string; first_name: string; last_name: string }> }>(`/people?search=${encodeURIComponent(q)}&limit=5`),
          api.get<{ data: Array<{ id: string; name: string }> }>(`/organisations?search=${encodeURIComponent(q)}&limit=5`),
          api.get<{ data: Array<{ id: string; name: string }> }>(`/venues?search=${encodeURIComponent(q)}&limit=5`),
        ]);
        for (const p of peopleRes.data) {
          if (p.id === entityId) continue;
          results.push({ id: p.id, label: `${p.first_name} ${p.last_name}`, type: 'person_id', entityLabel: 'Person' });
        }
        for (const o of orgsRes.data) {
          if (o.id === entityId) continue;
          results.push({ id: o.id, label: o.name, type: 'organisation_id', entityLabel: 'Organisation' });
        }
        for (const v of venuesRes.data) {
          if (v.id === entityId) continue;
          results.push({ id: v.id, label: v.name, type: 'venue_id', entityLabel: 'Venue' });
        }
        setMoveResults(results);
      } catch {
        setMoveResults([]);
      } finally {
        setMoveLoading(false);
      }
    }, 300);
  }

  async function confirmMove(interactionId: string, target: SearchResult) {
    try {
      await api.put(`/interactions/${interactionId}/move`, {
        target_type: target.type,
        target_id: target.id,
      });
      setMovingId(null);
      onInteractionAdded(); // Refresh list
    } catch (err) {
      console.error('Move failed:', err);
    }
  }

  // @mentions
  const [users, setUsers] = useState<UserOption[]>([]);
  const [showMentions, setShowMentions] = useState(false);
  const [mentionFilter, setMentionFilter] = useState('');
  const [mentionIndex, setMentionIndex] = useState(0);
  const [mentionedIds, setMentionedIds] = useState<string[]>([]);
  const [mentionPriority, setMentionPriority] = useState<'normal' | 'high' | 'urgent'>('normal');
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    api.get<{ data: UserOption[] }>('/users')
      .then((res) => setUsers(res.data))
      .catch(() => {});
  }, []);

  const filteredUsers = users.filter((u) => {
    const name = `${u.first_name || ''} ${u.last_name || ''}`.toLowerCase();
    return name.includes(mentionFilter.toLowerCase()) || u.email.toLowerCase().includes(mentionFilter.toLowerCase());
  });

  const handleContentChange = useCallback((e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const val = e.target.value;
    setContent(val);

    // Detect @mention trigger
    const cursorPos = e.target.selectionStart;
    const textUpToCursor = val.slice(0, cursorPos);
    const mentionMatch = textUpToCursor.match(/@(\w*)$/);

    if (mentionMatch) {
      setMentionFilter(mentionMatch[1]);
      setShowMentions(true);
      setMentionIndex(0);
    } else {
      setShowMentions(false);
    }
  }, []);

  function insertMention(u: UserOption) {
    const textarea = textareaRef.current;
    if (!textarea) return;

    const cursorPos = textarea.selectionStart;
    const textUpToCursor = content.slice(0, cursorPos);
    const atPos = textUpToCursor.lastIndexOf('@');
    const displayName = `${u.first_name || ''} ${u.last_name || ''}`.trim() || u.email;

    const newContent = content.slice(0, atPos) + `@${displayName} ` + content.slice(cursorPos);
    setContent(newContent);
    setShowMentions(false);

    if (!mentionedIds.includes(u.id)) {
      setMentionedIds([...mentionedIds, u.id]);
    }

    // Refocus textarea
    setTimeout(() => {
      textarea.focus();
      const newPos = atPos + displayName.length + 2;
      textarea.setSelectionRange(newPos, newPos);
    }, 0);
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (!showMentions || filteredUsers.length === 0) return;

    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setMentionIndex((prev) => Math.min(prev + 1, filteredUsers.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setMentionIndex((prev) => Math.max(prev - 1, 0));
    } else if (e.key === 'Enter' || e.key === 'Tab') {
      e.preventDefault();
      insertMention(filteredUsers[mentionIndex]);
    } else if (e.key === 'Escape') {
      setShowMentions(false);
    }
  }

  // ── Reply composer @mention plumbing — parallel to the main composer ────
  // We deliberately keep the state separate (not shared) because the two
  // composers can be open simultaneously: top-level for a new note, reply
  // open on an old thread.
  const replyFilteredUsers = users.filter((u) => {
    const name = `${u.first_name || ''} ${u.last_name || ''}`.toLowerCase();
    return name.includes(replyMentionFilter.toLowerCase()) || u.email.toLowerCase().includes(replyMentionFilter.toLowerCase());
  });

  function handleReplyContentChange(e: React.ChangeEvent<HTMLTextAreaElement>) {
    const val = e.target.value;
    setReplyContent(val);
    const cursorPos = e.target.selectionStart;
    const upToCursor = val.slice(0, cursorPos);
    const m = upToCursor.match(/@(\w*)$/);
    if (m) {
      setReplyMentionFilter(m[1]);
      setReplyShowMentions(true);
      setReplyMentionIndex(0);
    } else {
      setReplyShowMentions(false);
    }
  }

  function insertReplyMention(u: UserOption) {
    const ta = replyTextareaRef.current;
    if (!ta) return;
    const cursorPos = ta.selectionStart;
    const upToCursor = replyContent.slice(0, cursorPos);
    const atPos = upToCursor.lastIndexOf('@');
    const displayName = `${u.first_name || ''} ${u.last_name || ''}`.trim() || u.email;
    const newContent = replyContent.slice(0, atPos) + `@${displayName} ` + replyContent.slice(cursorPos);
    setReplyContent(newContent);
    setReplyShowMentions(false);
    if (!replyMentionedIds.includes(u.id)) {
      setReplyMentionedIds([...replyMentionedIds, u.id]);
    }
    setTimeout(() => {
      ta.focus();
      const newPos = atPos + displayName.length + 2;
      ta.setSelectionRange(newPos, newPos);
    }, 0);
  }

  function handleReplyKeyDown(e: React.KeyboardEvent) {
    if (!replyShowMentions || replyFilteredUsers.length === 0) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setReplyMentionIndex((prev) => Math.min(prev + 1, replyFilteredUsers.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setReplyMentionIndex((prev) => Math.max(prev - 1, 0));
    } else if (e.key === 'Enter' || e.key === 'Tab') {
      e.preventDefault();
      insertReplyMention(replyFilteredUsers[replyMentionIndex]);
    } else if (e.key === 'Escape') {
      setReplyShowMentions(false);
    }
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!content.trim() || submitting) return;

    setSubmitting(true);
    try {
      const payload: Record<string, unknown> = {
        type: interactionType,
        content: content.trim(),
        [entityType]: entityId,
        mentioned_user_ids: mentionedIds,
        mention_priority: mentionedIds.length > 0 ? mentionPriority : undefined,
      };
      if (interactionType === 'chase') {
        payload.chase_method = chaseMethod;
        if (nextChaseDate) payload.next_chase_date = nextChaseDate;
        if (chaseAlertUserId) payload.chase_alert_user_id = chaseAlertUserId;
      }
      // Pass through skip_chase_bump only when relevant (job + contact type)
      if (entityType === 'job_id' && ['call', 'email', 'meeting'].includes(interactionType) && skipChaseBump) {
        payload.skip_chase_bump = true;
      }
      const attachments = topAttach.payload();
      if (attachments.length > 0) payload.attachments = attachments;
      await api.post('/interactions', payload);
      setContent('');
      setMentionedIds([]);
      setMentionPriority('normal');
      setNextChaseDate('');
      setSelectedChasePreset(null);
      setChaseAlertUserId('');
      setSkipChaseBump(false);
      topAttach.clear();
      onInteractionAdded();
    } catch (err) {
      console.error('Failed to add interaction:', err);
    } finally {
      setSubmitting(false);
    }
  }

  async function handleReplySubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!replyContent.trim() || replySubmitting || !replyParentId) return;
    setReplySubmitting(true);
    try {
      const payload: Record<string, unknown> = {
        type: 'note',
        content: replyContent.trim(),
        parent_interaction_id: replyParentId,
        // Backend ignores the entity anchor on replies (inherits from
        // parent) but we send it anyway so the schema validation always
        // passes.
        [entityType]: entityId,
        mentioned_user_ids: replyMentionedIds,
      };
      const attachments = replyAttach.payload();
      if (attachments.length > 0) payload.attachments = attachments;
      await api.post('/interactions', payload);
      replyAttach.clear();
      setReplyContent('');
      setReplyMentionedIds([]);
      setReplyShowMentions(false);
      setReplyParentId(null);
      // Auto-expand the thread we just replied in so the new reply is visible.
      setExpandedThreads((prev) => new Set(prev).add(replyParentId));
      onInteractionAdded();
    } catch (err) {
      console.error('Failed to add reply:', err);
    } finally {
      setReplySubmitting(false);
    }
  }

  // Render @mentions, URLs, and #NNNNN job-number references inline.
  // Stored content stays plain text; this is purely a render-time concern
  // so the existing global search keeps working.
  function renderContent(text: string) {
    // One regex captures all three patterns. Order matters: URL first
    // (longest, most specific), then @mentions, then #NNNNN.
    const pattern = /(https?:\/\/[^\s<>()]+|@\w+(?:\s\w+)?|#\d{4,7})/g;
    const parts = text.split(pattern);
    return parts.map((part, i) => {
      if (!part) return null;
      if (/^https?:\/\//.test(part)) {
        return (
          <a
            key={i}
            href={part}
            target="_blank"
            rel="noopener noreferrer"
            className="text-ooosh-700 underline hover:text-ooosh-900 break-all"
          >
            {part}
          </a>
        );
      }
      if (part.startsWith('@') && part.length > 1) {
        return (
          <span key={i} className="bg-pink-100 text-pink-700 px-0.5 rounded font-medium">
            {part}
          </span>
        );
      }
      if (/^#\d{4,7}$/.test(part)) {
        // Job-number link — opens the job's detail page by HH number.
        // The /jobs page accepts ?hh= for direct navigation to the
        // matching job; resolution is handled there.
        const jobNumber = part.slice(1);
        return (
          <a
            key={i}
            href={`/jobs?hh=${jobNumber}`}
            className="bg-blue-50 text-blue-700 px-1 rounded font-medium hover:bg-blue-100"
            title={`Job #${jobNumber}`}
          >
            {part}
          </a>
        );
      }
      return part;
    });
  }

  // Group interactions into threads. Top-level (no parent) come first;
  // replies are nested under their parent. Replies that arrive before
  // their parent in the list (shouldn't happen given DESC ordering, but
  // defensively handle) get rendered as if top-level.
  type ThreadGroup = { root: Interaction; replies: Interaction[] };
  function groupIntoThreads(list: Interaction[]): ThreadGroup[] {
    const byId = new Map<string, Interaction>();
    for (const i of list) byId.set(i.id, i);
    const replyMap = new Map<string, Interaction[]>();
    const roots: Interaction[] = [];
    for (const i of list) {
      if (i.parent_interaction_id && byId.has(i.parent_interaction_id)) {
        const arr = replyMap.get(i.parent_interaction_id) || [];
        arr.push(i);
        replyMap.set(i.parent_interaction_id, arr);
      } else {
        roots.push(i);
      }
    }
    return roots.map((root) => ({
      root,
      // Replies oldest-first within a thread (the timeline list is newest-first overall).
      replies: (replyMap.get(root.id) || []).slice().sort(
        (a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime()
      ),
    }));
  }

  return (
    <div>
      {/* Add interaction form */}
      <form
        onSubmit={handleSubmit}
        onDragOver={(e) => { e.preventDefault(); setIsDragging(true); }}
        onDragLeave={(e) => { e.preventDefault(); setIsDragging(false); }}
        onDrop={(e) => {
          e.preventDefault();
          setIsDragging(false);
          if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
            handleFiles(e.dataTransfer.files, 'top');
          }
        }}
        className={`bg-white rounded-xl shadow-sm border ${isDragging ? 'border-ooosh-400 ring-2 ring-ooosh-200' : 'border-gray-200'} p-4 mb-6 transition-shadow`}
      >
        <div className="flex gap-2 mb-3 flex-wrap">
          {(entityType === 'job_id'
            ? ['note', 'call', 'email', 'meeting', 'chase'] as const
            : ['note', 'call', 'email', 'meeting'] as const
          ).map((t) => (
            <button
              key={t}
              type="button"
              onClick={() => setInteractionType(t)}
              className={`px-3 py-1 rounded-full text-xs font-medium transition-colors ${
                interactionType === t
                  ? TYPE_COLORS[t]
                  : 'bg-gray-100 text-gray-500 hover:bg-gray-200'
              }`}
            >
              {t.charAt(0).toUpperCase() + t.slice(1)}
            </button>
          ))}
        </div>

        {/* Chase-specific fields */}
        {interactionType === 'chase' && (
          <div className="mb-3 space-y-2 bg-orange-50 border border-orange-200 rounded-lg p-3">
            <div className="flex items-center gap-3">
              <label className="text-xs font-medium text-gray-600 w-16">Method</label>
              <div className="flex gap-1.5">
                {(['phone', 'email', 'text', 'whatsapp'] as const).map((m) => (
                  <button
                    key={m}
                    type="button"
                    onClick={() => setChaseMethod(m)}
                    className={`px-2 py-1 rounded text-xs font-medium transition-colors ${
                      chaseMethod === m ? 'bg-orange-200 text-orange-800' : 'bg-white text-gray-500 hover:bg-orange-100'
                    }`}
                  >
                    {m.charAt(0).toUpperCase() + m.slice(1)}
                  </button>
                ))}
              </div>
            </div>
            <div className="flex items-center gap-3">
              <label className="text-xs font-medium text-gray-600 w-16">Next chase</label>
              <div className="flex gap-1.5 flex-wrap items-center">
                {[
                  { label: '2 days', fn: () => addDays(2) },
                  { label: '5 days', fn: () => addDays(5) },
                  { label: '14 days', fn: () => addDays(14) },
                ].map((opt) => (
                  <button
                    key={opt.label}
                    type="button"
                    onClick={() => { setNextChaseDate(opt.fn()); setSelectedChasePreset(opt.label); }}
                    className={`px-2 py-1 rounded text-xs font-medium transition-colors ${
                      selectedChasePreset === opt.label ? 'bg-orange-200 text-orange-800' : 'bg-white text-gray-500 hover:bg-orange-100'
                    }`}
                  >
                    {opt.label}
                  </button>
                ))}
                <input
                  type="date"
                  value={nextChaseDate}
                  onChange={(e) => { setNextChaseDate(e.target.value); setSelectedChasePreset(null); }}
                  className="text-xs border border-gray-300 rounded px-2 py-1 focus:border-ooosh-500 focus:outline-none"
                />
              </div>
            </div>
            <div className="flex items-center gap-3">
              <label className="text-xs font-medium text-gray-600 w-16">Alert</label>
              <select
                value={chaseAlertUserId}
                onChange={(e) => setChaseAlertUserId(e.target.value)}
                className="text-xs border border-gray-300 rounded px-2 py-1 focus:border-ooosh-500 focus:outline-none"
              >
                <option value="">No alert</option>
                {users.map((u) => (
                  <option key={u.id} value={u.id}>
                    {u.first_name && u.last_name ? `${u.first_name} ${u.last_name}` : u.email}
                  </option>
                ))}
              </select>
            </div>
          </div>
        )}

        <div className="relative">
          <textarea
            ref={textareaRef}
            value={content}
            onChange={handleContentChange}
            onKeyDown={handleKeyDown}
            onPaste={(e) => handlePaste(e, 'top')}
            placeholder={interactionType === 'chase' ? 'What happened on the chase?...' : `Add a ${interactionType}... (type @ to mention someone, paste a screenshot, or drop a file)`}
            rows={3}
            className="w-full rounded border border-gray-300 px-3 py-2 text-sm focus:border-ooosh-500 focus:outline-none focus:ring-1 focus:ring-ooosh-500 resize-y min-h-[64px]"
          />

          {/* @mention dropdown */}
          {showMentions && filteredUsers.length > 0 && (
            <div className="absolute left-0 right-0 bottom-full mb-1 bg-white border border-gray-200 rounded-lg shadow-lg max-h-48 overflow-y-auto z-50">
              {filteredUsers.map((u, i) => (
                <button
                  key={u.id}
                  type="button"
                  onClick={() => insertMention(u)}
                  className={`w-full text-left px-3 py-2 text-sm flex items-center gap-2 ${
                    i === mentionIndex ? 'bg-ooosh-50 text-ooosh-700' : 'hover:bg-gray-50'
                  }`}
                >
                  <span className="w-6 h-6 rounded-full bg-ooosh-100 text-ooosh-700 flex items-center justify-center text-xs font-bold flex-shrink-0">
                    {(u.first_name || u.email)[0].toUpperCase()}
                  </span>
                  <span>
                    <span className="font-medium">
                      {u.first_name && u.last_name ? `${u.first_name} ${u.last_name}` : u.email}
                    </span>
                    {u.first_name && (
                      <span className="text-gray-400 text-xs ml-1.5">{u.email}</span>
                    )}
                  </span>
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Mentioned users tags + priority */}
        {mentionedIds.length > 0 && (
          <div className="flex flex-wrap items-center gap-1.5 mt-1.5">
            {mentionedIds.map((uid) => {
              const u = users.find((x) => x.id === uid);
              if (!u) return null;
              return (
                <span key={uid} className="inline-flex items-center gap-1 bg-pink-50 text-pink-700 text-xs px-2 py-0.5 rounded-full">
                  @{u.first_name || u.email}
                  <button
                    type="button"
                    onClick={() => setMentionedIds(mentionedIds.filter((id) => id !== uid))}
                    className="hover:text-pink-900"
                  >
                    &times;
                  </button>
                </span>
              );
            })}
            <select
              value={mentionPriority}
              onChange={(e) => setMentionPriority(e.target.value as 'normal' | 'high' | 'urgent')}
              className={`text-[10px] border rounded px-1.5 py-0.5 ${
                mentionPriority === 'urgent' ? 'border-red-300 bg-red-50 text-red-700' :
                mentionPriority === 'high' ? 'border-amber-300 bg-amber-50 text-amber-700' :
                'border-gray-200 text-gray-500'
              }`}
            >
              <option value="normal">Normal</option>
              <option value="high">Important</option>
              <option value="urgent">Urgent</option>
            </select>
          </div>
        )}

        {/* Skip-chase-bump opt-out — only relevant when logging a contact
            event on a job. Checked = don't push next_chase_date forward. */}
        {entityType === 'job_id' && ['call', 'email', 'meeting'].includes(interactionType) && (
          <label
            className="flex items-center gap-1.5 text-xs text-gray-500 mt-2 cursor-pointer"
            title="By default, logging a call/email/meeting pushes the chase date forward by your usual chase interval. Tick this to keep the chase date as-is — useful for backdated entries or non-consequential events."
          >
            <input
              type="checkbox"
              checked={skipChaseBump}
              onChange={(e) => setSkipChaseBump(e.target.checked)}
              className="rounded border-gray-300"
            />
            Don't update chase date
          </label>
        )}

        {/* Pending attachment thumbnails / pills (uploading + uploaded) */}
        <PendingAttachmentStrip items={topAttach.pending} onRemove={(id) => removeAttachment(id, 'top')} />

        <div className="flex justify-between items-center mt-2 gap-2">
          <div className="flex items-center gap-3 text-xs text-gray-400">
            <span>Posting as {user?.first_name} {user?.last_name}</span>
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              className="inline-flex items-center gap-1 text-gray-500 hover:text-ooosh-700"
              title="Attach files (or drop them onto this form)"
            >
              📎 Attach
            </button>
            <input
              ref={fileInputRef}
              type="file"
              multiple
              className="hidden"
              onChange={(e) => {
                if (e.target.files) handleFiles(e.target.files, 'top');
                e.target.value = ''; // allow re-selecting same file
              }}
            />
          </div>
          <button
            type="submit"
            disabled={!content.trim() || submitting || topAttach.hasInFlight}
            className="bg-ooosh-600 text-white px-4 py-1.5 rounded text-sm font-medium hover:bg-ooosh-700 transition-colors disabled:opacity-50"
          >
            {submitting ? 'Saving...' : 'Add'}
          </button>
        </div>
      </form>

      {/* Timeline */}
      {interactions.length === 0 ? (
        <p className="text-center text-sm text-gray-400 py-8">No activity yet. Add a note above to get started.</p>
      ) : (
        <div className="space-y-4">
          {groupIntoThreads(interactions).map((group) => {
            const interaction = group.root;
            const replies = group.replies;
            const replyCount = replies.length;
            const expanded = expandedThreads.has(interaction.id);
            const COLLAPSE_THRESHOLD = 2;
            const visibleReplies = (replyCount > COLLAPSE_THRESHOLD && !expanded)
              ? replies.slice(-1) // show just the most recent when collapsed
              : replies;

            return (
              <div key={interaction.id} className="bg-white rounded-xl shadow-sm border border-gray-200 p-4">
                <InteractionRow
                  interaction={interaction}
                  isReply={false}
                  movingId={movingId}
                  onStartMove={() => startMove(interaction.id)}
                  onCancelMove={() => setMovingId(null)}
                  moveSearch={moveSearch}
                  moveResults={moveResults}
                  moveLoading={moveLoading}
                  onSearchEntities={searchEntities}
                  onConfirmMove={(target) => confirmMove(interaction.id, target)}
                  renderContent={renderContent}
                />

                {/* Replies — nested, indented */}
                {replyCount > 0 && (
                  <div className="mt-3 ml-11 border-l-2 border-gray-100 pl-3 space-y-3">
                    {replyCount > COLLAPSE_THRESHOLD && !expanded && (
                      <button
                        type="button"
                        onClick={() => toggleThread(interaction.id)}
                        className="text-xs text-ooosh-600 hover:text-ooosh-800"
                      >
                        Show {replyCount - 1} earlier {replyCount - 1 === 1 ? 'reply' : 'replies'}
                      </button>
                    )}
                    {visibleReplies.map((r) => (
                      <InteractionRow
                        key={r.id}
                        interaction={r}
                        isReply
                        movingId={null}
                        onStartMove={() => {}}
                        onCancelMove={() => {}}
                        moveSearch=""
                        moveResults={[]}
                        moveLoading={false}
                        onSearchEntities={() => {}}
                        onConfirmMove={() => {}}
                        renderContent={renderContent}
                      />
                    ))}
                    {expanded && replyCount > COLLAPSE_THRESHOLD && (
                      <button
                        type="button"
                        onClick={() => toggleThread(interaction.id)}
                        className="text-xs text-gray-400 hover:text-gray-600"
                      >
                        Collapse thread
                      </button>
                    )}
                  </div>
                )}

                {/* Reply composer (inline, when active for this thread) */}
                {replyParentId === interaction.id ? (
                  <form
                    onSubmit={handleReplySubmit}
                    onDragOver={(e) => e.preventDefault()}
                    onDrop={(e) => {
                      e.preventDefault();
                      if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
                        handleFiles(e.dataTransfer.files, 'reply');
                      }
                    }}
                    className="mt-3 ml-11 bg-gray-50 rounded-lg border border-gray-200 p-3"
                  >
                    <div className="relative">
                      <textarea
                        ref={replyTextareaRef}
                        value={replyContent}
                        onChange={handleReplyContentChange}
                        onKeyDown={handleReplyKeyDown}
                        onPaste={(e) => handlePaste(e, 'reply')}
                        placeholder="Write a reply… (type @ to mention, paste a screenshot, or drop a file)"
                        rows={2}
                        autoFocus
                        className="w-full rounded border border-gray-300 px-2.5 py-1.5 text-sm focus:border-ooosh-500 focus:outline-none focus:ring-1 focus:ring-ooosh-500 resize-y min-h-[64px]"
                      />
                      {replyShowMentions && replyFilteredUsers.length > 0 && (
                        <div className="absolute left-0 right-0 bottom-full mb-1 bg-white border border-gray-200 rounded-lg shadow-lg max-h-48 overflow-y-auto z-50">
                          {replyFilteredUsers.map((u, i) => (
                            <button
                              key={u.id}
                              type="button"
                              onClick={() => insertReplyMention(u)}
                              className={`w-full text-left px-3 py-2 text-sm flex items-center gap-2 ${
                                i === replyMentionIndex ? 'bg-ooosh-50 text-ooosh-700' : 'hover:bg-gray-50'
                              }`}
                            >
                              <span className="w-6 h-6 rounded-full bg-ooosh-100 text-ooosh-700 flex items-center justify-center text-xs font-bold flex-shrink-0">
                                {(u.first_name || u.email)[0].toUpperCase()}
                              </span>
                              <span>
                                <span className="font-medium">
                                  {u.first_name && u.last_name ? `${u.first_name} ${u.last_name}` : u.email}
                                </span>
                                {u.first_name && (
                                  <span className="text-gray-400 text-xs ml-1.5">{u.email}</span>
                                )}
                              </span>
                            </button>
                          ))}
                        </div>
                      )}
                    </div>
                    {replyMentionedIds.length > 0 && (
                      <div className="flex flex-wrap items-center gap-1.5 mt-1.5">
                        {replyMentionedIds.map((uid) => {
                          const u = users.find((x) => x.id === uid);
                          if (!u) return null;
                          return (
                            <span key={uid} className="inline-flex items-center gap-1 bg-pink-50 text-pink-700 text-xs px-2 py-0.5 rounded-full">
                              @{u.first_name || u.email}
                              <button
                                type="button"
                                onClick={() => setReplyMentionedIds(replyMentionedIds.filter((id) => id !== uid))}
                                className="hover:text-pink-900"
                              >
                                &times;
                              </button>
                            </span>
                          );
                        })}
                      </div>
                    )}
                    <PendingAttachmentStrip items={replyAttach.pending} onRemove={(id) => removeAttachment(id, 'reply')} />
                    <div className="flex justify-between items-center mt-2">
                      <label className="inline-flex items-center gap-1 text-xs text-gray-500 hover:text-ooosh-700 cursor-pointer">
                        📎 Attach
                        <input
                          type="file"
                          multiple
                          className="hidden"
                          onChange={(e) => {
                            if (e.target.files) handleFiles(e.target.files, 'reply');
                            e.target.value = '';
                          }}
                        />
                      </label>
                      <div className="flex items-center gap-2">
                        <button
                          type="button"
                          onClick={() => {
                            replyAttach.clear();
                            setReplyContent('');
                            setReplyMentionedIds([]);
                            setReplyShowMentions(false);
                            setReplyParentId(null);
                          }}
                          className="text-xs text-gray-500 hover:text-gray-700 px-2 py-1"
                        >
                          Cancel
                        </button>
                        <button
                          type="submit"
                          disabled={!replyContent.trim() || replySubmitting || replyAttach.hasInFlight}
                          className="bg-ooosh-600 text-white px-3 py-1 rounded text-xs font-medium hover:bg-ooosh-700 disabled:opacity-50"
                        >
                          {replySubmitting ? 'Posting…' : 'Reply'}
                        </button>
                      </div>
                    </div>
                  </form>
                ) : (
                  // Reply trigger — only on note/mention/email/call/meeting types
                  // (not on status_transition / system events).
                  ['note', 'mention', 'email', 'call', 'meeting', 'chase'].includes(interaction.type) && (
                    <button
                      type="button"
                      onClick={() => setReplyParentId(interaction.id)}
                      className="mt-2 ml-11 text-xs text-gray-400 hover:text-ooosh-700"
                    >
                      ↩ Reply
                    </button>
                  )
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ── InteractionRow ─────────────────────────────────────────────────────────
// Single row renderer used for both top-level interactions and replies.
// Reply rows hide the Move button and the status badge since both attach
// to the thread root, not individual replies.

interface InteractionRowProps {
  interaction: Interaction;
  isReply: boolean;
  movingId: string | null;
  onStartMove: () => void;
  onCancelMove: () => void;
  moveSearch: string;
  moveResults: SearchResult[];
  moveLoading: boolean;
  onSearchEntities: (q: string) => void;
  onConfirmMove: (target: SearchResult) => void;
  renderContent: (text: string) => React.ReactNode;
}

function InteractionRow({
  interaction, isReply, movingId, onStartMove, onCancelMove,
  moveSearch, moveResults, moveLoading, onSearchEntities, onConfirmMove, renderContent,
}: InteractionRowProps) {
  return (
    <>
      <div className="flex items-start gap-3">
        <div className={`w-8 h-8 rounded-full flex items-center justify-center text-xs font-bold flex-shrink-0 ${TYPE_COLORS[interaction.type] || 'bg-gray-100 text-gray-600'}`}>
          {TYPE_ICONS[interaction.type] || '?'}
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2 text-xs text-gray-500 flex-wrap">
              <span className="font-medium text-gray-700">{interaction.created_by_name || 'System'}</span>
              <span>{isReply ? 'replied' : `logged a ${interaction.type}`}</span>
              {!isReply && interaction.job_status_at_creation != null && (
                <>
                  <span>&middot;</span>
                  <span className={`inline-flex px-1.5 py-0.5 rounded border text-[10px] font-semibold ${JOB_STATUS_COLOURS[interaction.job_status_at_creation] || 'bg-gray-50 text-gray-500 border-gray-200'}`}>
                    {JOB_STATUS_MAP[interaction.job_status_at_creation] || interaction.job_status_name_at_creation || `Status ${interaction.job_status_at_creation}`}
                  </span>
                </>
              )}
              <span>&middot;</span>
              <span>{formatDateTime(interaction.created_at)}</span>
            </div>
            {!isReply && (
              <button
                type="button"
                onClick={onStartMove}
                className={`text-xs px-2 py-0.5 rounded transition-colors ${
                  movingId === interaction.id
                    ? 'bg-ooosh-100 text-ooosh-700'
                    : 'text-gray-400 hover:text-gray-600 hover:bg-gray-100'
                }`}
                title="Move to another record"
              >
                Move
              </button>
            )}
          </div>
          <p className="mt-1 text-sm text-gray-800 whitespace-pre-wrap">{renderContent(interaction.content)}</p>
          <AttachmentList files={interaction.files} />
          <Reactions interactionId={interaction.id} reactions={interaction.reactions} />
        </div>
      </div>

      {/* Move panel — top-level only */}
      {!isReply && movingId === interaction.id && (
        <div className="mt-3 ml-11 p-3 bg-gray-50 rounded-lg border border-gray-200">
          <p className="text-xs text-gray-500 mb-2">Move this activity to a different person, organisation, or venue:</p>
          <input
            type="text"
            value={moveSearch}
            onChange={(e) => onSearchEntities(e.target.value)}
            placeholder="Search by name..."
            autoFocus
            className="w-full rounded border border-gray-300 px-3 py-1.5 text-sm focus:border-ooosh-500 focus:outline-none focus:ring-1 focus:ring-ooosh-500"
          />
          {moveLoading && <p className="text-xs text-gray-400 mt-2">Searching...</p>}
          {moveResults.length > 0 && (
            <div className="mt-2 space-y-1 max-h-40 overflow-y-auto">
              {moveResults.map((r) => (
                <button
                  key={`${r.type}-${r.id}`}
                  type="button"
                  onClick={() => onConfirmMove(r)}
                  className="w-full text-left px-3 py-1.5 text-sm rounded hover:bg-ooosh-50 flex items-center justify-between group"
                >
                  <span className="font-medium text-gray-800">{r.label}</span>
                  <span className="text-xs text-gray-400 group-hover:text-ooosh-600">{r.entityLabel}</span>
                </button>
              ))}
            </div>
          )}
          {moveSearch.length >= 2 && !moveLoading && moveResults.length === 0 && (
            <p className="text-xs text-gray-400 mt-2">No results found</p>
          )}
          <button
            type="button"
            onClick={onCancelMove}
            className="mt-2 text-xs text-gray-400 hover:text-gray-600"
          >
            Cancel
          </button>
        </div>
      )}
    </>
  );
}
