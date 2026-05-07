/**
 * Lightweight emoji reactions on interactions.
 *
 * Renders the existing reactions as compact pills with counts (the user's
 * own reactions get a coloured outline so they can see at a glance what
 * they've already reacted with), plus an "Add reaction" button that opens
 * a small palette popover. Click any palette emoji to toggle that reaction
 * on the interaction.
 *
 * No notifications fire on reactions — this is the deliberately lightweight
 * "I saw it, no further action needed" pattern. Storage is the
 * `interactions.reactions` JSONB column (migration 077).
 *
 * Used by InteractionRow in ActivityTimeline and message rows in ThreadView.
 */

import { useState, useEffect, useRef } from 'react';
import { api } from '../../services/api';
import { useAuthStore } from '../../hooks/useAuthStore';

const PALETTE = ['👍', '❤️', '✅', '😂', '🎉', '👀'] as const;

export type ReactionsMap = Record<string, string[]>; // emoji → array of user UUIDs

interface ReactionsProps {
  interactionId: string;
  reactions?: ReactionsMap;
  onChanged?: (next: ReactionsMap) => void;
}

export default function Reactions({ interactionId, reactions, onChanged }: ReactionsProps) {
  const currentUserId = useAuthStore((s) => s.user?.id);
  const [local, setLocal] = useState<ReactionsMap>(reactions || {});
  const [showPalette, setShowPalette] = useState(false);
  const [submitting, setSubmitting] = useState<string | null>(null);
  const popoverRef = useRef<HTMLDivElement>(null);

  // Keep local state in sync if the prop changes (parent refetches).
  useEffect(() => { setLocal(reactions || {}); }, [reactions]);

  // Close palette on outside click.
  useEffect(() => {
    if (!showPalette) return;
    function onClick(e: MouseEvent) {
      if (popoverRef.current && !popoverRef.current.contains(e.target as Node)) {
        setShowPalette(false);
      }
    }
    document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, [showPalette]);

  async function toggle(emoji: string) {
    if (submitting) return;
    setSubmitting(emoji);
    // Optimistic update — flip the user's reaction locally before the
    // round-trip lands. Reverted on failure.
    const before = local;
    const existing = local[emoji] || [];
    const has = currentUserId ? existing.includes(currentUserId) : false;
    const optimistic: ReactionsMap = { ...local };
    if (has && currentUserId) {
      optimistic[emoji] = existing.filter((u) => u !== currentUserId);
      if (optimistic[emoji].length === 0) delete optimistic[emoji];
    } else if (currentUserId) {
      optimistic[emoji] = [...existing, currentUserId];
    }
    setLocal(optimistic);

    try {
      const result = await api.post<{ reactions: ReactionsMap }>(`/interactions/${interactionId}/reactions`, { emoji });
      setLocal(result.reactions || {});
      onChanged?.(result.reactions || {});
      setShowPalette(false);
    } catch (err) {
      console.error('Toggle reaction failed:', err);
      setLocal(before);
    } finally {
      setSubmitting(null);
    }
  }

  // Render order: existing reactions in the order they appear in the data,
  // then the "Add" button.
  const entries = Object.entries(local).filter(([, ids]) => ids.length > 0);

  return (
    <div className="flex flex-wrap items-center gap-1 mt-1.5">
      {entries.map(([emoji, ids]) => {
        const mine = currentUserId ? ids.includes(currentUserId) : false;
        return (
          <button
            key={emoji}
            type="button"
            onClick={() => toggle(emoji)}
            disabled={submitting === emoji}
            className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full text-xs border transition-colors ${
              mine
                ? 'bg-ooosh-50 border-ooosh-300 text-ooosh-800'
                : 'bg-gray-50 border-gray-200 text-gray-600 hover:bg-gray-100'
            } disabled:opacity-50`}
            title={mine ? 'Click to remove your reaction' : 'Click to add this reaction'}
          >
            <span>{emoji}</span>
            <span className="font-medium">{ids.length}</span>
          </button>
        );
      })}

      {/* Add-reaction trigger + palette popover */}
      <div className="relative" ref={popoverRef}>
        <button
          type="button"
          onClick={() => setShowPalette((p) => !p)}
          className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded-full text-xs border border-dashed border-gray-300 text-gray-400 hover:bg-gray-50 hover:text-gray-600 transition-colors"
          title="Add reaction"
        >
          <span>🙂</span>
          <span className="text-[10px]">+</span>
        </button>
        {showPalette && (
          <div className="absolute left-0 top-full mt-1 bg-white border border-gray-200 rounded-lg shadow-lg p-1 z-50 flex gap-1">
            {PALETTE.map((emoji) => {
              const mine = currentUserId ? (local[emoji] || []).includes(currentUserId) : false;
              return (
                <button
                  key={emoji}
                  type="button"
                  onClick={() => toggle(emoji)}
                  disabled={submitting === emoji}
                  className={`text-base p-1 rounded hover:bg-gray-100 transition-colors ${
                    mine ? 'bg-ooosh-50' : ''
                  } disabled:opacity-50`}
                  title={emoji}
                >
                  {emoji}
                </button>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
