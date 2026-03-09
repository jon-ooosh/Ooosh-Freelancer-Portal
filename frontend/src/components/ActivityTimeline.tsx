import { useState, useEffect, useRef, useCallback } from 'react';
import { api } from '../services/api';
import { useAuthStore } from '../hooks/useAuthStore';

interface Interaction {
  id: string;
  type: string;
  content: string;
  created_at: string;
  created_by_name: string | null;
  mentioned_user_ids: string[];
}

interface UserOption {
  id: string;
  email: string;
  first_name: string | null;
  last_name: string | null;
}

interface ActivityTimelineProps {
  entityType: 'person_id' | 'organisation_id' | 'venue_id';
  entityId: string;
  interactions: Interaction[];
  onInteractionAdded: () => void;
}

const TYPE_COLORS: Record<string, string> = {
  note: 'bg-blue-100 text-blue-700',
  call: 'bg-green-100 text-green-700',
  email: 'bg-purple-100 text-purple-700',
  meeting: 'bg-amber-100 text-amber-700',
  mention: 'bg-pink-100 text-pink-700',
};

const TYPE_ICONS: Record<string, string> = {
  note: 'N', call: 'C', email: 'E', meeting: 'M', mention: '@',
};

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

  // @mentions
  const [users, setUsers] = useState<UserOption[]>([]);
  const [showMentions, setShowMentions] = useState(false);
  const [mentionFilter, setMentionFilter] = useState('');
  const [mentionIndex, setMentionIndex] = useState(0);
  const [mentionedIds, setMentionedIds] = useState<string[]>([]);
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

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!content.trim() || submitting) return;

    setSubmitting(true);
    try {
      await api.post('/interactions', {
        type: interactionType,
        content: content.trim(),
        [entityType]: entityId,
        mentioned_user_ids: mentionedIds,
      });
      setContent('');
      setMentionedIds([]);
      onInteractionAdded();
    } catch (err) {
      console.error('Failed to add interaction:', err);
    } finally {
      setSubmitting(false);
    }
  }

  // Render @mentions in content as highlighted
  function renderContent(text: string) {
    // Match @Name patterns
    const parts = text.split(/(@\w+(?:\s\w+)?)/g);
    return parts.map((part, i) => {
      if (part.startsWith('@') && part.length > 1) {
        return (
          <span key={i} className="bg-pink-100 text-pink-700 px-0.5 rounded font-medium">
            {part}
          </span>
        );
      }
      return part;
    });
  }

  return (
    <div>
      {/* Add interaction form */}
      <form onSubmit={handleSubmit} className="bg-white rounded-xl shadow-sm border border-gray-200 p-4 mb-6">
        <div className="flex gap-2 mb-3 flex-wrap">
          {(['note', 'call', 'email', 'meeting'] as const).map((t) => (
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

        <div className="relative">
          <textarea
            ref={textareaRef}
            value={content}
            onChange={handleContentChange}
            onKeyDown={handleKeyDown}
            placeholder={`Add a ${interactionType}... (type @ to mention someone)`}
            rows={3}
            className="w-full rounded border border-gray-300 px-3 py-2 text-sm focus:border-ooosh-500 focus:outline-none focus:ring-1 focus:ring-ooosh-500 resize-none"
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

        {/* Mentioned users tags */}
        {mentionedIds.length > 0 && (
          <div className="flex flex-wrap gap-1 mt-1.5">
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

        <div className="flex justify-between items-center mt-2">
          <span className="text-xs text-gray-400">
            Posting as {user?.first_name} {user?.last_name}
          </span>
          <button
            type="submit"
            disabled={!content.trim() || submitting}
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
          {interactions.map((interaction) => (
            <div key={interaction.id} className="bg-white rounded-xl shadow-sm border border-gray-200 p-4">
              <div className="flex items-start gap-3">
                <div className={`w-8 h-8 rounded-full flex items-center justify-center text-xs font-bold flex-shrink-0 ${TYPE_COLORS[interaction.type] || 'bg-gray-100 text-gray-600'}`}>
                  {TYPE_ICONS[interaction.type] || '?'}
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 text-xs text-gray-500">
                    <span className="font-medium text-gray-700">{interaction.created_by_name || 'System'}</span>
                    <span>logged a {interaction.type}</span>
                    <span>&middot;</span>
                    <span>{formatDateTime(interaction.created_at)}</span>
                  </div>
                  <p className="mt-1 text-sm text-gray-800 whitespace-pre-wrap">{renderContent(interaction.content)}</p>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
