import { Link } from 'react-router-dom';
import type { UpcomingEvent } from './types';
import { formatDayDate, jobDisplayName } from './helpers';

interface Props {
  events: UpcomingEvent[];
}

export default function ComingUpTimeline({ events }: Props) {
  if (events.length === 0) return null;

  // Group events by date
  const grouped = new Map<string, UpcomingEvent[]>();
  for (const event of events) {
    const key = event.event_date;
    const list = grouped.get(key) || [];
    list.push(event);
    grouped.set(key, list);
  }

  // Split into this week (next 7 days) and next week (7-14 days)
  const now = new Date();
  const weekCutoff = new Date(now);
  weekCutoff.setDate(weekCutoff.getDate() + 7);

  const thisWeek: [string, UpcomingEvent[]][] = [];
  const nextWeek: [string, UpcomingEvent[]][] = [];

  for (const [dateStr, dayEvents] of grouped) {
    const date = new Date(dateStr);
    if (date < weekCutoff) {
      thisWeek.push([dateStr, dayEvents]);
    } else {
      nextWeek.push([dateStr, dayEvents]);
    }
  }

  return (
    <div className="bg-white rounded-xl shadow-sm border border-gray-200">
      <div className="px-5 py-4 border-b border-gray-100 flex items-center justify-between">
        <h2 className="text-sm font-semibold text-gray-900 uppercase tracking-wide">Coming Up — Next 14 Days</h2>
        <Link to="/jobs" className="text-xs text-ooosh-600 hover:text-ooosh-700 font-medium">
          View all jobs
        </Link>
      </div>
      <div className="grid grid-cols-1 md:grid-cols-2 divide-y md:divide-y-0 md:divide-x divide-gray-100">
        {/* This Week */}
        <div className="p-5">
          <h3 className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-3">This Week</h3>
          {thisWeek.length === 0 ? (
            <p className="text-sm text-gray-400">Nothing scheduled</p>
          ) : (
            <div className="space-y-3">
              {thisWeek.map(([dateStr, dayEvents]) => (
                <div key={dateStr}>
                  <div className="text-xs font-semibold text-gray-700 mb-1">{formatDayDate(dateStr)}</div>
                  {dayEvents.map((event) => (
                    <Link
                      key={`${event.id}-${event.event_type}`}
                      to={`/jobs/${event.id}`}
                      className="flex items-center gap-2 text-xs text-gray-600 hover:text-gray-900 py-0.5 transition-colors"
                    >
                      <span className={event.event_type === 'departure' ? 'text-blue-500' : 'text-teal-500'}>
                        {event.event_type === 'departure' ? '>' : '<'}
                      </span>
                      <span className="truncate">{jobDisplayName(event)}</span>
                    </Link>
                  ))}
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Next Week */}
        <div className="p-5">
          <h3 className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-3">Next Week</h3>
          {nextWeek.length === 0 ? (
            <p className="text-sm text-gray-400">Nothing scheduled yet</p>
          ) : (
            <div className="space-y-3">
              {nextWeek.map(([dateStr, dayEvents]) => {
                // Collapse days with many events
                const departures = dayEvents.filter(e => e.event_type === 'departure');
                const returns = dayEvents.filter(e => e.event_type === 'return');
                return (
                  <div key={dateStr}>
                    <div className="text-xs font-semibold text-gray-700 mb-1">{formatDayDate(dateStr)}</div>
                    {dayEvents.length <= 4 ? (
                      dayEvents.map((event) => (
                        <Link
                          key={`${event.id}-${event.event_type}`}
                          to={`/jobs/${event.id}`}
                          className="flex items-center gap-2 text-xs text-gray-600 hover:text-gray-900 py-0.5 transition-colors"
                        >
                          <span className={event.event_type === 'departure' ? 'text-blue-500' : 'text-teal-500'}>
                            {event.event_type === 'departure' ? '>' : '<'}
                          </span>
                          <span className="truncate">{jobDisplayName(event)}</span>
                        </Link>
                      ))
                    ) : (
                      <div className="text-xs text-gray-500">
                        {departures.length > 0 && <span className="text-blue-600">{departures.length} going out</span>}
                        {departures.length > 0 && returns.length > 0 && ', '}
                        {returns.length > 0 && <span className="text-teal-600">{returns.length} returning</span>}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
