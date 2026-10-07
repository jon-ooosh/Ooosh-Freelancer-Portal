/** A lead's activity — who did what, when. Loads when the row is expanded. */
import { useEffect, useState } from 'react';
import { api } from '../../services/api';
import { EVENT_LABEL, LeadEvent } from './leadTypes';

function when(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}

export default function LeadTimeline({ leadId, refreshKey }: { leadId: string; refreshKey?: string }) {
  const [events, setEvents] = useState<LeadEvent[] | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let alive = true;
    setFailed(false);
    api.get<{ data: LeadEvent[] }>(`/leads/${leadId}/events`)
      .then((r) => { if (alive) setEvents(r.data); })
      .catch(() => { if (alive) setFailed(true); });
    return () => { alive = false; };
  }, [leadId, refreshKey]);

  if (failed) return <p className="text-gray-400">Couldn’t load the activity.</p>;
  if (events == null) return <p className="text-gray-400">Loading activity…</p>;
  if (events.length === 0) return <p className="text-gray-400">No activity recorded yet.</p>;
  return (
    <ol className="space-y-1">
      {events.map((e) => (
        <li key={e.id} className="flex flex-wrap gap-x-2">
          <span className="text-gray-400 whitespace-nowrap w-28">{when(e.created_at)}</span>
          <span className="text-gray-800">{EVENT_LABEL[e.event] ?? e.event}</span>
          {e.detail && <span className="text-gray-500">— {e.detail}</span>}
          {e.actor && <span className="text-gray-400">· {e.actor}</span>}
        </li>
      ))}
    </ol>
  );
}
