import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import type { DashboardSectionProps } from '../sections';
import { Card, SectionHd } from '../primitives';
import { api } from '../../../../services/api';

/**
 * "Who's in" — the compact staffing strip (Staff Calendar, Phase A).
 * See docs/STAFF-CALENDAR-SPEC.md §10.
 *
 * Deliberately a STRIP, not a month grid: the dashboard is already dense and
 * user-ordered, so the full calendar lives at its own route (/staff/calendar).
 *
 * Self-fetching and hidden entirely when no staff have employment records yet,
 * so it costs nothing until the module is set up.
 */

interface TodayPerson {
  personId: string;
  name: string;
  jobTitle: string | null;
  status: 'working' | 'not_scheduled' | 'leave' | 'absent' | 'partial';
  startTime: string | null;
  endTime: string | null;
  scheduledMinutes: number;
  window?: { start: string; end: string };
}
interface TodaySummary {
  date: string;
  in: number;
  total: number;
  people: TodayPerson[];
}

const PIP: Record<TodayPerson['status'], string> = {
  working:       'bg-emerald-500',
  partial:       'bg-amber-500',
  leave:         'bg-sky-500',
  absent:        'bg-rose-500',
  not_scheduled: 'bg-gray-300',
};

function label(p: TodayPerson): string {
  if (p.status === 'working' && p.startTime) return `${p.startTime.slice(0, 5)}–${p.endTime?.slice(0, 5)}`;
  if (p.status === 'partial') return p.window ? `out ${p.window.start}–${p.window.end}` : 'part day';
  if (p.status === 'leave') return 'on leave';
  if (p.status === 'absent') return 'absent';
  return 'not in today';
}

export default function WhosIn(_props: DashboardSectionProps) {
  const [data, setData] = useState<TodaySummary | null>(null);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await api.get<{ data: TodaySummary }>('/staff-calendar/today');
        if (!cancelled) setData(res.data);
      } catch {
        /* swallow — section just won't show */
      } finally {
        if (!cancelled) setLoaded(true);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  if (!loaded || !data || data.total === 0) return null;

  return (
    <Card>
      <SectionHd
        title="Who's in"
        action={
          <div className="flex items-center gap-3">
            <span className="text-xs text-gray-500">{data.in} of {data.total} in today</span>
            <Link to="/staff/calendar" className="text-xs text-ooosh-600 hover:text-ooosh-700 hover:underline">
              Full calendar →
            </Link>
          </div>
        }
      />
      <div className="flex flex-wrap gap-2">
        {data.people.map(p => (
          <div key={p.personId}
            className="flex items-center gap-2 px-2.5 py-1.5 rounded-md border border-gray-200 bg-white">
            <span className={`inline-block w-2 h-2 rounded-full ${PIP[p.status]}`} />
            <span className="text-sm text-gray-900">{p.name}</span>
            <span className="text-xs text-gray-500">{label(p)}</span>
          </div>
        ))}
      </div>
    </Card>
  );
}
