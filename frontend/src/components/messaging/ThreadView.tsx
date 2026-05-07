/**
 * ThreadView — full-thread render for any interaction with a parent or
 * children. Used by:
 *
 * - InboxPage: when user expands a mention/reply notification, replaces the
 *   old single-line reply input with this full-thread experience.
 * - (future) IssueDetailPage: when issue comments move to interactions
 *   (Problems Stage 3 — see CLAUDE.md and docs/MESSAGING-SPEC.md §6.3).
 *
 * Fetches GET /api/interactions/:id/thread which walks to the root and
 * returns root + replies oldest-first + distinct participants. The caller
 * passes ANY interaction in the thread (typically the one referenced by
 * a notification's interaction_id); we walk to the root server-side.
 *
 * The persistent reply composer at the bottom mirrors ActivityTimeline's
 * reply composer: textarea with @mention autocomplete, drag/drop +
 * paste-to-attach, mention pills, attachment strip, send button.
 *
 * Acknowledgement is per-recipient and orthogonal to thread state — the
 * thread itself doesn't have a "closed" concept. The optional Done /
 * Snooze action callbacks let the embedding surface (Inbox) drive its own
 * notification lifecycle without ThreadView needing to know about
 * notifications at all.
 */

import { useState, useEffect, useRef, useCallback } from 'react';
import { api } from '../../services/api';
import {
  AttachmentList,
  PendingAttachmentStrip,
  useAttachments,
  type InteractionAttachment,
} from './Attachments';

interface ThreadInteraction {
  id: string;
  type: string;
  content: string;
  created_at: string;
  created_by: string | null;
  created_by_name: string | null;
  created_by_email: string | null;
  parent_interaction_id: string | null;
  mentioned_user_ids: string[];
  files?: InteractionAttachment[];
}

interface ThreadParticipant {
  id: string;
  name: string;
  email: string;
}

interface ThreadResponse {
  root: ThreadInteraction;
  replies: ThreadInteraction[];
  participants: ThreadParticipant[];
}

interface UserOption {
  id: string;
  email: string;
  first_name: string | null;
  last_name: string | null;
}

interface ThreadViewProps {
  /** Any interaction in the thread — server walks to the root. */
  interactionId: string;
  /** Optional handler for acknowledging the thread (used by InboxPage to
   * mark the originating notification as Done). */
  onAcknowledge?: () => void | Promise<void>;
  /** Optional snooze trigger (InboxPage uses this to open its snooze modal). */
  onSnooze?: () => void;
  /** Called after a reply has posted, in case the parent wants to refresh
   * a list count or similar. */
  onReplied?: () => void;
}

function formatDateTime(dateStr: string): string {
  return new Date(dateStr).toLocaleDateString('en-GB', {
    day: 'numeric', month: 'short',
    hour: '2-digit', minute: '2-digit',
  });
}

// Render @mentions, URLs, and #NNNNN job-number references inline. Mirrors
// the helper in ActivityTimeline — kept duplicated for now since both
// surfaces are small renderers and the helper has no state. If a third
// surface needs it we'll extract.
function renderContent(text: string) {
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

export default function ThreadView({ interactionId, onAcknowledge, onSnooze, onReplied }: ThreadViewProps) {
  const [thread, setThread] = useState<ThreadResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Reply composer state
  const [content, setContent] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const attach = useAttachments();
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // @mention picker
  const [users, setUsers] = useState<UserOption[]>([]);
  const [showMentions, setShowMentions] = useState(false);
  const [mentionFilter, setMentionFilter] = useState('');
  const [mentionIndex, setMentionIndex] = useState(0);
  const [mentionedIds, setMentionedIds] = useState<string[]>([]);

  const loadThread = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await api.get<ThreadResponse>(`/interactions/${interactionId}/thread`);
      setThread(result);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load thread');
    } finally {
      setLoading(false);
    }
  }, [interactionId]);

  useEffect(() => { loadThread(); }, [loadThread]);

  useEffect(() => {
    api.get<{ data: UserOption[] }>('/users')
      .then((res) => setUsers(res.data))
      .catch(() => {});
  }, []);

  const filteredUsers = users.filter((u) => {
    const name = `${u.first_name || ''} ${u.last_name || ''}`.toLowerCase();
    return name.includes(mentionFilter.toLowerCase()) || u.email.toLowerCase().includes(mentionFilter.toLowerCase());
  });

  function handleContentChange(e: React.ChangeEvent<HTMLTextAreaElement>) {
    const val = e.target.value;
    setContent(val);
    const cursorPos = e.target.selectionStart;
    const upToCursor = val.slice(0, cursorPos);
    const m = upToCursor.match(/@(\w*)$/);
    if (m) {
      setMentionFilter(m[1]);
      setShowMentions(true);
      setMentionIndex(0);
    } else {
      setShowMentions(false);
    }
  }

  function insertMention(u: UserOption) {
    const ta = textareaRef.current;
    if (!ta) return;
    const cursorPos = ta.selectionStart;
    const upToCursor = content.slice(0, cursorPos);
    const atPos = upToCursor.lastIndexOf('@');
    const displayName = `${u.first_name || ''} ${u.last_name || ''}`.trim() || u.email;
    const newContent = content.slice(0, atPos) + `@${displayName} ` + content.slice(cursorPos);
    setContent(newContent);
    setShowMentions(false);
    if (!mentionedIds.includes(u.id)) {
      setMentionedIds([...mentionedIds, u.id]);
    }
    setTimeout(() => {
      ta.focus();
      const newPos = atPos + displayName.length + 2;
      ta.setSelectionRange(newPos, newPos);
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

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!content.trim() || submitting || !thread) return;
    setSubmitting(true);
    try {
      const payload: Record<string, unknown> = {
        type: 'note',
        content: content.trim(),
        parent_interaction_id: thread.root.id,
        mentioned_user_ids: mentionedIds,
      };
      const attachments = attach.payload();
      if (attachments.length > 0) payload.attachments = attachments;
      await api.post('/interactions', payload);
      setContent('');
      setMentionedIds([]);
      setShowMentions(false);
      attach.clear();
      // Re-fetch the thread so the new reply appears immediately.
      await loadThread();
      if (onReplied) onReplied();
    } catch (err) {
      console.error('Failed to send reply:', err);
    } finally {
      setSubmitting(false);
    }
  }

  if (loading) {
    return <div className="text-xs text-gray-400 py-2">Loading thread…</div>;
  }
  if (error || !thread) {
    return <div className="text-xs text-red-600 py-2">{error || 'Thread unavailable'}</div>;
  }

  const allMessages = [thread.root, ...thread.replies];

  return (
    <div className="space-y-3">
      {/* Participants strip — small, low-noise. */}
      {thread.participants.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5 text-[11px] text-gray-500">
          <span>In this thread:</span>
          {thread.participants.map((p) => (
            <span key={p.id} className="inline-flex items-center gap-1 bg-gray-100 px-2 py-0.5 rounded-full">
              <span className="w-4 h-4 rounded-full bg-ooosh-100 text-ooosh-700 flex items-center justify-center text-[9px] font-bold">
                {p.name.charAt(0).toUpperCase()}
              </span>
              <span>{p.name}</span>
            </span>
          ))}
        </div>
      )}

      {/* Messages */}
      <div className="space-y-3">
        {allMessages.map((m, idx) => {
          const isRoot = idx === 0;
          return (
            <div
              key={m.id}
              className={`rounded-lg p-3 ${
                isRoot ? 'bg-white border border-gray-200' : 'bg-gray-50 border border-gray-100 ml-6'
              }`}
            >
              <div className="flex items-center gap-2 text-[11px] text-gray-500 mb-1">
                <span className="font-medium text-gray-700">{m.created_by_name || m.created_by_email || 'System'}</span>
                {!isRoot && <span>replied</span>}
                <span>·</span>
                <span>{formatDateTime(m.created_at)}</span>
              </div>
              <div className="text-sm text-gray-800 whitespace-pre-wrap">{renderContent(m.content)}</div>
              <AttachmentList files={m.files} />
            </div>
          );
        })}
      </div>

      {/* Persistent reply composer */}
      <form
        onSubmit={handleSubmit}
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => {
          e.preventDefault();
          if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
            attach.addFiles(e.dataTransfer.files);
          }
        }}
        className="bg-gray-50 rounded-lg border border-gray-200 p-3"
      >
        <div className="relative">
          <textarea
            ref={textareaRef}
            value={content}
            onChange={handleContentChange}
            onKeyDown={handleKeyDown}
            onPaste={(e) => { if (attach.pasteFromEvent(e)) e.preventDefault(); }}
            placeholder="Write a reply… (type @ to mention, paste a screenshot, or drop a file)"
            rows={3}
            className="w-full rounded border border-gray-300 px-3 py-2 text-sm focus:border-ooosh-500 focus:outline-none focus:ring-1 focus:ring-ooosh-500 resize-none"
          />
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
          </div>
        )}

        <PendingAttachmentStrip items={attach.pending} onRemove={attach.remove} />

        <div className="flex justify-between items-center mt-2 gap-2">
          <label className="inline-flex items-center gap-1 text-xs text-gray-500 hover:text-ooosh-700 cursor-pointer">
            📎 Attach
            <input
              type="file"
              multiple
              className="hidden"
              onChange={(e) => {
                if (e.target.files) attach.addFiles(e.target.files);
                e.target.value = '';
              }}
            />
          </label>

          <div className="flex items-center gap-2">
            {onSnooze && (
              <button
                type="button"
                onClick={onSnooze}
                className="text-xs text-blue-600 hover:text-blue-700 border border-blue-200 px-2 py-1 rounded hover:bg-blue-50"
              >
                Snooze
              </button>
            )}
            {onAcknowledge && (
              <button
                type="button"
                onClick={() => onAcknowledge()}
                className="text-xs text-green-600 hover:text-green-700 border border-green-200 px-2 py-1 rounded hover:bg-green-50"
                title="Mark as dealt with for me — doesn't close the thread for others"
              >
                Done
              </button>
            )}
            <button
              type="submit"
              disabled={!content.trim() || submitting || attach.hasInFlight}
              className="bg-ooosh-600 text-white px-3 py-1 rounded text-xs font-medium hover:bg-ooosh-700 disabled:opacity-50"
            >
              {submitting ? 'Posting…' : 'Reply'}
            </button>
          </div>
        </div>
      </form>
    </div>
  );
}
