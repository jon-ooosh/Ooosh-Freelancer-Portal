/**
 * StudioHandoverCard — the sitter ⇄ staff handover thread(s) for a rehearsal
 * job, surfaced on the Job Detail Overview (Rehearsals module).
 *
 * One rehearsal job can span several sitter-needed evenings, and each evening's
 * shift is shared across every band in that night — so the thread stays
 * shift-anchored (not job-anchored). This card lists the job's evenings and,
 * per evening, shows the shared handover thread (same StudioShiftNotes used on
 * the roster). Self-hides when the job has no rehearsal evenings.
 */

import { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../services/api';
import StudioShiftNotes from './StudioShiftNotes';

interface CoverageEvening {
  date: string;
  shift_id: string | null;
  status: string;
  assignee: { id: string; name: string } | null;
  note_count?: number;
}

function formatDay(iso: string): string {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('en-GB', {
    weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC',
  });
}

export default function StudioHandoverCard({ jobId }: { jobId: string }) {
  const [evenings, setEvenings] = useState<CoverageEvening[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [open, setOpen] = useState<Set<string>>(new Set());

  useEffect(() => {
    let cancelled = false;
    api.get<{ data: CoverageEvening[] }>(`/studio-sitters/job/${jobId}/coverage`)
      .then((r) => {
        if (cancelled) return;
        const list = r.data ?? [];
        setEvenings(list);
        // Auto-open evenings that already have a conversation, plus the single-
        // evening case, so notes aren't hidden behind a click.
        const toOpen = list.filter((e) => (e.note_count ?? 0) > 0).map((e) => e.date);
        if (toOpen.length === 0 && list.length === 1) toOpen.push(list[0].date);
        setOpen(new Set(toOpen));
      })
      .catch(() => { /* leave empty → card hides */ })
      .finally(() => { if (!cancelled) setLoaded(true); });
    return () => { cancelled = true; };
  }, [jobId]);

  if (!loaded || evenings.length === 0) return null;

  const toggle = (date: string) => setOpen((prev) => {
    const next = new Set(prev);
    if (next.has(date)) next.delete(date); else next.add(date);
    return next;
  });

  return (
    <div className="bg-white rounded-lg border border-gray-200 p-4">
      <div className="flex items-center justify-between gap-2 mb-1">
        <h3 className="font-semibold text-gray-900 flex items-center gap-2">
          <span>🎸</span> Studio sitter handover
        </h3>
        <Link to="/studio-sitters" className="text-xs font-medium text-purple-600 hover:text-purple-800">
          Manage on roster →
        </Link>
      </div>
      <p className="text-xs text-gray-500 mb-3">
        Notes shared with the studio sitter for this job&apos;s evenings — jobs for the night, money owed,
        anything left undone.
      </p>

      <div className="divide-y divide-gray-100">
        {evenings.map((ev) => (
          <div key={ev.date} className="py-2 first:pt-0 last:pb-0">
            <button
              onClick={() => toggle(ev.date)}
              className="w-full flex items-center justify-between gap-2 text-left"
            >
              <span className="text-sm font-medium text-gray-800 flex items-center gap-1.5">
                {formatDay(ev.date)}
                {(ev.note_count ?? 0) > 0 && (
                  <span className="text-[11px] px-1.5 py-0.5 rounded-full bg-purple-100 text-purple-700 font-medium">
                    💬 {ev.note_count}
                  </span>
                )}
              </span>
              <span className="flex items-center gap-2">
                {ev.assignee ? (
                  <span className="text-xs px-2 py-0.5 rounded-full bg-green-100 text-green-700">{ev.assignee.name}</span>
                ) : (
                  <span className="text-xs px-2 py-0.5 rounded-full bg-amber-100 text-amber-700">No sitter yet</span>
                )}
                <span className="text-gray-400 text-xs">{open.has(ev.date) ? '▾' : '▸'}</span>
              </span>
            </button>
            {open.has(ev.date) && (
              <div className="mt-2">
                {ev.shift_id ? (
                  <StudioShiftNotes shiftId={ev.shift_id} />
                ) : (
                  <div className="text-xs text-gray-400 py-1">
                    Assign a sitter on the roster to start a handover thread for this evening.
                  </div>
                )}
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
