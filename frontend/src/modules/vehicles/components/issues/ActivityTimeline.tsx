/**
 * Vertical timeline of issue activity entries.
 * Each entry shows a coloured dot, action label, author + timestamp, note text, and optional status badge.
 */

import { formatDistanceToNow, format } from 'date-fns'
import { STATUS_STYLES } from '../../config/issue-options'
import type { IssueActivity, IssueStatus } from '../../types/issue'

interface ActivityTimelineProps {
  activities: IssueActivity[]
}

/** Dot colour based on the activity's effect */
function getDotColour(activity: IssueActivity): string {
  if (activity.newStatus === 'Resolved') return 'bg-green-500'
  if (activity.newStatus) return 'bg-blue-500'
  return 'bg-gray-400'
}

function formatTimestamp(ts: string): { relative: string; full: string } {
  try {
    const date = new Date(ts)
    return {
      relative: formatDistanceToNow(date, { addSuffix: true }),
      full: format(date, 'dd MMM yyyy, HH:mm'),
    }
  } catch {
    return { relative: ts, full: ts }
  }
}

export function ActivityTimeline({ activities }: ActivityTimelineProps) {
  if (activities.length === 0) {
    return (
      <p className="py-4 text-center text-sm text-gray-400">No activity yet</p>
    )
  }

  // Show oldest first (chronological)
  const sorted = [...activities].sort(
    (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime(),
  )

  return (
    <div className="relative pl-6">
      {/* Vertical line */}
      <div className="absolute left-[9px] top-2 bottom-2 w-px bg-gray-200" />

      <div className="space-y-4">
        {sorted.map((entry) => {
          const { relative, full } = formatTimestamp(entry.timestamp)
          return (
            <div key={entry.id} className="relative">
              {/* Coloured dot */}
              <div
                className={`absolute -left-6 top-1.5 h-[11px] w-[11px] rounded-full border-2 border-white ${getDotColour(entry)}`}
              />

              <div>
                {/* Action + status badge */}
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium text-gray-900">{entry.action}</span>
                  {entry.newStatus && (
                    <span
                      className={`inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-medium ${
                        STATUS_STYLES[entry.newStatus as IssueStatus] || 'bg-gray-100 text-gray-600'
                      }`}
                    >
                      → {entry.newStatus}
                    </span>
                  )}
                </div>

                {/* Author + time */}
                <p className="text-[11px] text-gray-400" title={full}>
                  {entry.author} · {relative}
                </p>

                {/* Note */}
                {entry.note && (
                  <p className="mt-1 text-sm text-gray-600 whitespace-pre-line">{entry.note}</p>
                )}
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}
