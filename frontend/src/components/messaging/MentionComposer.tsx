/**
 * <MentionComposer> — shared message-composer primitive.
 *
 * Owns the parts that are identical across every composer surface
 * (timeline top-level, thread reply, issue comment): the textarea,
 * the @-mention picker dropdown with keyboard nav, the mention pills,
 * the attachments hook integration, paste/drop-to-attach. Doesn't
 * own the submit button or the submit logic — those vary by surface
 * (different endpoints, different payload shapes, different button
 * copy) so the caller handles them via `footer` (rendered below the
 * textarea inside the same wrapper).
 *
 * Three previously-duplicated mention pickers (ThreadView reply,
 * ActivityTimeline top-level, ActivityTimeline reply) now route
 * through this primitive, plus a fourth: the issue-comment composer
 * on IssueDetailPage which gained mention support via this extraction.
 *
 * Usage:
 *   const attach = useAttachments();
 *   const [content, setContent] = useState('');
 *   const [mentionedIds, setMentionedIds] = useState<string[]>([]);
 *
 *   <MentionComposer
 *     value={content} onChange={setContent}
 *     mentionedIds={mentionedIds} onMentionedIdsChange={setMentionedIds}
 *     attach={attach} placeholder="Add a comment…" rows={3}
 *     footer={
 *       <div className="flex justify-end">
 *         <button onClick={submit}>Post</button>
 *       </div>
 *     }
 *   />
 *
 * The caller's `submit` reads `content`, `mentionedIds`, and
 * `attach.payload()` and POSTs whatever endpoint shape it needs.
 * On success, clear via setContent(''); setMentionedIds([]);
 * attach.clear().
 */

import { useState, useEffect, useRef } from 'react';
import type { ReactNode } from 'react';
import { api } from '../../services/api';
import { PendingAttachmentStrip, type useAttachments } from './Attachments';

export interface MentionUser {
  id: string;
  email: string;
  first_name: string | null;
  last_name: string | null;
}

interface MentionComposerProps {
  value: string;
  onChange: (value: string) => void;
  mentionedIds: string[];
  onMentionedIdsChange: (ids: string[]) => void;
  attach: ReturnType<typeof useAttachments>;
  placeholder?: string;
  rows?: number;
  disabled?: boolean;
  /** Footer slot — typically the submit button + any per-surface controls. */
  footer?: ReactNode;
  /** Extra className on the outer wrapper. */
  className?: string;
  /**
   * Optional pre-loaded user list. If omitted, the primitive fetches
   * GET /users once on mount. Useful for callers that already have a
   * user list cached and want to share it.
   */
  users?: MentionUser[];
}

export function MentionComposer({
  value,
  onChange,
  mentionedIds,
  onMentionedIdsChange,
  attach,
  placeholder = 'Write a message… (type @ to mention, paste an image, or drop a file)',
  rows = 3,
  disabled = false,
  footer,
  className = '',
  users: usersProp,
}: MentionComposerProps) {
  const [users, setUsers] = useState<MentionUser[]>(usersProp ?? []);
  const [showMentions, setShowMentions] = useState(false);
  const [mentionFilter, setMentionFilter] = useState('');
  const [mentionIndex, setMentionIndex] = useState(0);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (usersProp) {
      setUsers(usersProp);
      return;
    }
    api.get<{ data: MentionUser[] }>('/users')
      .then((res) => setUsers(res.data))
      .catch(() => {});
  }, [usersProp]);

  const filteredUsers = users.filter((u) => {
    const name = `${u.first_name || ''} ${u.last_name || ''}`.toLowerCase();
    const f = mentionFilter.toLowerCase();
    return name.includes(f) || u.email.toLowerCase().includes(f);
  });

  function handleContentChange(e: React.ChangeEvent<HTMLTextAreaElement>) {
    const val = e.target.value;
    onChange(val);
    const cursorPos = e.target.selectionStart;
    const upToCursor = val.slice(0, cursorPos);
    const m = upToCursor.match(/@(\w*)$/);
    if (m) {
      setMentionFilter(m[1] ?? '');
      setShowMentions(true);
      setMentionIndex(0);
    } else {
      setShowMentions(false);
    }
  }

  function insertMention(u: MentionUser) {
    const ta = textareaRef.current;
    if (!ta) return;
    const cursorPos = ta.selectionStart;
    const upToCursor = value.slice(0, cursorPos);
    const atPos = upToCursor.lastIndexOf('@');
    const displayName = `${u.first_name || ''} ${u.last_name || ''}`.trim() || u.email;
    const newContent = value.slice(0, atPos) + `@${displayName} ` + value.slice(cursorPos);
    onChange(newContent);
    setShowMentions(false);
    if (!mentionedIds.includes(u.id)) {
      onMentionedIdsChange([...mentionedIds, u.id]);
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
      const target = filteredUsers[mentionIndex];
      if (target) insertMention(target);
    } else if (e.key === 'Escape') {
      setShowMentions(false);
    }
  }

  return (
    <div
      className={className}
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => {
        e.preventDefault();
        if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
          attach.addFiles(e.dataTransfer.files);
        }
      }}
    >
      <div className="relative">
        <textarea
          ref={textareaRef}
          value={value}
          onChange={handleContentChange}
          onKeyDown={handleKeyDown}
          onPaste={(e) => { if (attach.pasteFromEvent(e)) e.preventDefault(); }}
          placeholder={placeholder}
          rows={rows}
          disabled={disabled}
          className="w-full rounded border border-gray-300 px-3 py-2 text-sm focus:border-ooosh-500 focus:outline-none focus:ring-1 focus:ring-ooosh-500 resize-y min-h-[64px]"
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
                  {(u.first_name || u.email)[0]!.toUpperCase()}
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
                  onClick={() => onMentionedIdsChange(mentionedIds.filter((id) => id !== uid))}
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

      {footer}
    </div>
  );
}
