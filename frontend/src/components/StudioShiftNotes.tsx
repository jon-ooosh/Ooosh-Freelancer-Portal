/**
 * StudioShiftNotes — the sitter ⇄ staff handover thread for one shift-evening
 * (Rehearsals module). Reused by the Studio Sitters roster and the Job Detail
 * handover card. Anchored to the shift via interactions.shift_id.
 *
 * Freelancer-authored notes come back with created_by = NULL + author_name;
 * staff notes derive the name from the users join. Plain-text composer for now
 * (URLs auto-linkified on render); image/PDF attachments land in a follow-up.
 */

import { useState, useEffect, useCallback } from 'react';
import { api } from '../services/api';

interface ShiftMessage {
  id: string;
  content: string;
  created_at: string;
  created_by: string | null;
  created_by_name: string | null;
  author_name: string | null;
}

function formatMessageTime(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  return d.toLocaleString('en-GB', {
    weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit',
  });
}

/** Render message text with bare URLs turned into clickable links. */
function LinkifiedText({ text }: { text: string }) {
  const parts = text.split(/(https?:\/\/[^\s]+)/g);
  return (
    <>
      {parts.map((part, i) =>
        /^https?:\/\//.test(part) ? (
          <a
            key={i}
            href={part}
            target="_blank"
            rel="noopener noreferrer"
            className="text-purple-600 hover:text-purple-800 underline break-all"
          >
            {part}
          </a>
        ) : (
          <span key={i}>{part}</span>
        )
      )}
    </>
  );
}

export default function StudioShiftNotes({ shiftId }: { shiftId: string }) {
  const [messages, setMessages] = useState<ShiftMessage[]>([]);
  const [loading, setLoading] = useState(true);
  const [draft, setDraft] = useState('');
  const [posting, setPosting] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const loadNotes = useCallback(async () => {
    setLoading(true);
    try {
      const r = await api.get<{ data: ShiftMessage[] }>(`/interactions?shift_id=${shiftId}&limit=100`);
      // Endpoint returns newest-first; a handover log reads best oldest-first.
      setMessages([...(r.data ?? [])].reverse());
    } catch {
      setErr('Could not load notes');
    } finally {
      setLoading(false);
    }
  }, [shiftId]);

  useEffect(() => { loadNotes(); }, [loadNotes]);

  async function post() {
    const content = draft.trim();
    if (!content || posting) return;
    setPosting(true);
    setErr(null);
    try {
      await api.post('/interactions', { type: 'note', content, shift_id: shiftId });
      setDraft('');
      await loadNotes();
    } catch {
      setErr('Could not post note');
    } finally {
      setPosting(false);
    }
  }

  return (
    <div>
      {loading ? (
        <div className="text-xs text-gray-400 py-2">Loading notes…</div>
      ) : messages.length === 0 ? (
        <div className="text-xs text-gray-400 py-1">No handover notes yet.</div>
      ) : (
        <div className="space-y-2 mb-2">
          {messages.map((m) => {
            const fromStaff = !!m.created_by;
            const author = fromStaff
              ? (String(m.created_by_name || '').trim() || 'Ooosh')
              : (m.author_name || 'Studio sitter');
            return (
              <div key={m.id} className={`rounded-lg border p-2 ${fromStaff ? 'bg-white border-gray-200' : 'bg-purple-50 border-purple-100'}`}>
                <div className="flex items-center justify-between gap-2 mb-0.5">
                  <span className="text-xs font-semibold text-gray-700">
                    {author}
                    {!fromStaff && <span className="ml-1.5 text-[10px] px-1.5 py-0.5 rounded-full bg-purple-100 text-purple-700 font-medium uppercase tracking-wide">Sitter</span>}
                  </span>
                  <span className="text-[11px] text-gray-400 shrink-0">{formatMessageTime(m.created_at)}</span>
                </div>
                <p className="text-sm text-gray-800 whitespace-pre-wrap break-words"><LinkifiedText text={m.content} /></p>
              </div>
            );
          })}
        </div>
      )}
      {err && <div className="text-xs text-red-600 mb-1">{err}</div>}
      <div className="flex items-end gap-2">
        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder="Add a note for the sitter…"
          rows={2}
          className="flex-1 text-sm border border-gray-300 rounded-lg p-2 resize-y min-h-[44px]"
        />
        <button onClick={post} disabled={!draft.trim() || posting}
          className="px-3 py-2 text-sm rounded-lg bg-purple-600 text-white hover:bg-purple-700 disabled:opacity-40 shrink-0">
          {posting ? 'Posting…' : 'Post'}
        </button>
      </div>
    </div>
  );
}
