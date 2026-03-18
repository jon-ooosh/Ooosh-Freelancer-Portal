/**
 * Recent Activity feed for the dashboard.
 * Shows the last N vehicle events (book-outs, check-ins, preps, etc.) from the global R2 index.
 */

import { formatDistanceToNow } from 'date-fns'
import type { RecentEventEntry } from '../../hooks/useRecentEvents'

const EVENT_ICONS: Record<string, string> = {
  'Book Out': '🚐',
  'Check In': '📋',
  'Interim Check In': '📦',
  'Prep Started': '🔧',
  'Prep Completed': '✅',
  'Damage Logged': '⚠️',
  'Damage Repaired': '🔨',
  'Oil Top Up': '🛢️',
  'Coolant Top Up': '🧊',
  'Screen Wash Top Up': '💧',
  'AdBlue Top Up': '💧',
  'Bulb Replacement': '💡',
  'Wiper Replacement': '🪟',
  'Tyre Check': '🔘',
  'Seat Rotation': '💺',
  'MOT': '📄',
  'Service': '🔩',
  'Location Change': '📍',
  'Ad-Hoc Note': '📝',
  'Swap Out': '🔄',
  'Swap In': '🔄',
}

function formatRelative(dateStr: string): string {
  try {
    return formatDistanceToNow(new Date(dateStr), { addSuffix: true })
  } catch {
    return dateStr
  }
}

interface RecentActivityFeedProps {
  events: RecentEventEntry[]
  isLoading: boolean
}

export function RecentActivityFeed({ events, isLoading }: RecentActivityFeedProps) {
  if (isLoading) {
    return (
      <div className="space-y-2">
        {Array.from({ length: 3 }).map((_, i) => (
          <div key={i} className="h-12 animate-pulse rounded-lg bg-gray-100" />
        ))}
      </div>
    )
  }

  if (events.length === 0) {
    return (
      <div className="rounded-lg border border-gray-200 bg-white p-6 text-center text-sm text-gray-400">
        No recent activity
      </div>
    )
  }

  return (
    <div className="divide-y divide-gray-100 rounded-lg border border-gray-200 bg-white">
      {events.map(event => (
        <div key={event.id} className="flex items-center gap-3 px-3 py-2.5">
          <span className="text-lg">{EVENT_ICONS[event.eventType] || '📌'}</span>
          <div className="min-w-0 flex-1">
            <div className="flex items-baseline gap-1.5">
              <span className="font-mono text-xs font-bold text-ooosh-navy">{event.vehicleReg}</span>
              <span className="text-sm text-gray-700">{event.eventType}</span>
            </div>
            <div className="flex items-center gap-2 text-[11px] text-gray-400">
              <span>{formatRelative(event.createdAt)}</span>
              {event.mileage != null && (
                <span>· {event.mileage.toLocaleString()} mi</span>
              )}
              {event.hireHopJob && (
                <span>· Job #{event.hireHopJob}</span>
              )}
            </div>
          </div>
          {event.hireStatus && (
            <span className={`shrink-0 inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-medium ${
              event.hireStatus === 'On Hire' ? 'bg-blue-100 text-blue-700' :
              event.hireStatus === 'Available' ? 'bg-green-100 text-green-700' :
              event.hireStatus === 'Prep Needed' ? 'bg-amber-100 text-amber-700' :
              event.hireStatus === 'Collected' ? 'bg-purple-100 text-purple-700' :
              'bg-gray-100 text-gray-600'
            }`}>
              {event.hireStatus}
            </span>
          )}
        </div>
      ))}
    </div>
  )
}
