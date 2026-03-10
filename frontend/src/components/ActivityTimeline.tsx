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
  job_status_at_creation?: number | null;
  job_status_name_at_creation?: string | null;
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
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2 text-xs text-gray-500 flex-wrap">
                      <span className="font-medium text-gray-700">{interaction.created_by_name || 'System'}</span>
                      <span>logged a {interaction.type}</span>
                      {interaction.job_status_at_creation != null && (
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
                    <button
                      type="button"
                      onClick={() => startMove(interaction.id)}
                      className={`text-xs px-2 py-0.5 rounded transition-colors ${
                        movingId === interaction.id
                          ? 'bg-ooosh-100 text-ooosh-700'
                          : 'text-gray-400 hover:text-gray-600 hover:bg-gray-100'
                      }`}
                      title="Move to another record"
                    >
                      Move
                    </button>
                  </div>
                  <p className="mt-1 text-sm text-gray-800 whitespace-pre-wrap">{renderContent(interaction.content)}</p>
                </div>
              </div>

              {/* Move panel */}
              {movingId === interaction.id && (
                <div className="mt-3 ml-11 p-3 bg-gray-50 rounded-lg border border-gray-200">
                  <p className="text-xs text-gray-500 mb-2">Move this activity to a different person, organisation, or venue:</p>
                  <input
                    type="text"
                    value={moveSearch}
                    onChange={(e) => searchEntities(e.target.value)}
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
                          onClick={() => confirmMove(interaction.id, r)}
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
                    onClick={() => setMovingId(null)}
                    className="mt-2 text-xs text-gray-400 hover:text-gray-600"
                  >
                    Cancel
                  </button>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
