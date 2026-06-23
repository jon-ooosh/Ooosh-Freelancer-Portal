/**
 * Prep Trends panel — per-corner tyre wear + projection, derived from the
 * prep history already loaded by PrepHistoryTab. Read-only, computed entirely
 * client-side (no extra fetch). Mounts at the top of the Preps history view.
 *
 * Shows, grouped by axle (front / rear computed independently):
 *   - current tread, colour-coded green/amber/red against the 5/4mm thresholds
 *   - wear rate (mm per 1,000 miles) across the current tyre's segment
 *   - projection to 5mm (plan replacement) and 4mm (replace now) — miles + date
 *   - a small tread sparkline with reset (new-tyre) markers
 */

import { useMemo, useState } from 'react'
import type { PrepHistorySession } from '../../lib/prep-history'
import {
  computePrepTrends,
  ratePer1000,
  type CornerTrend,
  type Projection,
} from '../../lib/prep-trends'
import { TYRE_TREAD_RED_MM, TYRE_TREAD_AMBER_MM, TYRE_TREAD_CAP_MM } from '../../lib/tyre-sanity'

interface Props {
  sessions: PrepHistorySession[]
}

const STATUS_STYLES: Record<CornerTrend['status'], { dot: string; text: string }> = {
  red: { dot: 'bg-red-500', text: 'text-red-600' },
  amber: { dot: 'bg-amber-500', text: 'text-amber-600' },
  green: { dot: 'bg-green-500', text: 'text-green-600' },
  unknown: { dot: 'bg-gray-300', text: 'text-gray-400' },
}

function formatDate(dateStr: string | null): string {
  if (!dateStr) return '—'
  try {
    return new Date(dateStr + 'T00:00:00').toLocaleDateString('en-GB', {
      day: 'numeric', month: 'short', year: 'numeric',
    })
  } catch {
    return dateStr
  }
}

function ProjectionLine({ label, projection, colour }: {
  label: string
  projection: Projection | null
  colour: string
}) {
  if (!projection) {
    return (
      <div className="flex items-baseline justify-between text-[11px]">
        <span className="text-gray-400">{label}</span>
        <span className="text-gray-300">—</span>
      </div>
    )
  }
  if (projection.milesRemaining <= 0) {
    return (
      <div className="flex items-baseline justify-between text-[11px]">
        <span className="text-gray-400">{label}</span>
        <span className={`font-medium ${colour}`}>reached now</span>
      </div>
    )
  }
  return (
    <div className="flex items-baseline justify-between text-[11px]">
      <span className="text-gray-400">{label}</span>
      <span className={`font-medium ${colour}`}>
        ~{projection.milesRemaining.toLocaleString('en-GB')} mi
        {projection.estimatedDate && (
          <span className="ml-1 font-normal text-gray-400">({formatDate(projection.estimatedDate)})</span>
        )}
      </span>
    </div>
  )
}

/** Tiny SVG sparkline of the tread series, scaled 0…cap, with reset markers. */
function TreadSparkline({ trend }: { trend: CornerTrend }) {
  const pts = trend.points
  if (pts.length < 2) return null
  const W = 120, H = 28, pad = 2
  const max = TYRE_TREAD_CAP_MM
  const xStep = (W - pad * 2) / (pts.length - 1)
  const y = (t: number) => H - pad - (Math.min(t, max) / max) * (H - pad * 2)
  const coords = pts.map((p, i) => ({ x: pad + i * xStep, yy: y(p.tread), reset: p.isReset }))
  const path = coords.map((c, i) => `${i === 0 ? 'M' : 'L'}${c.x.toFixed(1)},${c.yy.toFixed(1)}`).join(' ')
  // Amber/red threshold guide lines.
  const amberY = y(TYRE_TREAD_AMBER_MM)
  const redY = y(TYRE_TREAD_RED_MM)
  return (
    <svg width={W} height={H} className="overflow-visible">
      <line x1={pad} y1={amberY} x2={W - pad} y2={amberY} stroke="#f59e0b" strokeWidth={0.5} strokeDasharray="2 2" opacity={0.5} />
      <line x1={pad} y1={redY} x2={W - pad} y2={redY} stroke="#ef4444" strokeWidth={0.5} strokeDasharray="2 2" opacity={0.5} />
      <path d={path} fill="none" stroke="#475569" strokeWidth={1.25} />
      {coords.map((c, i) => (
        <circle
          key={i}
          cx={c.x}
          cy={c.yy}
          r={c.reset ? 2.4 : 1.4}
          fill={c.reset ? '#0ea5e9' : '#475569'}
        />
      ))}
    </svg>
  )
}

function CornerCard({ trend }: { trend: CornerTrend }) {
  const styles = STATUS_STYLES[trend.status]
  const rate = ratePer1000(trend.wearRatePerMile)
  return (
    <div className="rounded-lg border border-gray-200 bg-white p-3">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className={`h-2 w-2 rounded-full ${styles.dot}`} />
          <span className="text-xs font-semibold text-gray-700">{trend.corner}</span>
          <span className="text-[10px] text-gray-400">{trend.label}</span>
        </div>
        <div className="text-right">
          <span className={`text-sm font-semibold ${styles.text}`}>
            {trend.currentTread != null ? `${trend.currentTread}mm` : '—'}
          </span>
        </div>
      </div>

      <div className="mt-2">
        <TreadSparkline trend={trend} />
      </div>

      <div className="mt-2 space-y-1">
        <div className="flex items-baseline justify-between text-[11px]">
          <span className="text-gray-400">Wear rate</span>
          <span className="font-medium text-gray-600">
            {rate != null ? `${rate} mm / 1,000 mi` : 'not enough data'}
          </span>
        </div>
        <ProjectionLine label="To 5mm (plan)" projection={trend.projectionTo5mm} colour="text-amber-600" />
        <ProjectionLine label="To 4mm (replace)" projection={trend.projectionTo4mm} colour="text-red-600" />
      </div>

      {trend.resetCount > 0 && (
        <div className="mt-2 flex items-center gap-1 text-[10px] text-sky-600">
          <span className="h-1.5 w-1.5 rounded-full bg-sky-500" />
          New tyre detected {formatDate(trend.lastResetDate)}
          {trend.resetCount > 1 && <span className="text-gray-400">(+{trend.resetCount - 1} earlier)</span>}
        </div>
      )}
    </div>
  )
}

export function PrepTrendsPanel({ sessions }: Props) {
  const [open, setOpen] = useState(true)
  const trends = useMemo(() => computePrepTrends(sessions), [sessions])

  if (!trends.hasData) return null

  const front = trends.corners.filter(c => c.axle === 'front')
  const rear = trends.corners.filter(c => c.axle === 'rear')

  return (
    <div className="rounded-lg border border-gray-200 bg-gray-50/50">
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        className="flex w-full items-center justify-between px-3 py-2 text-left"
      >
        <div className="flex items-center gap-2">
          <span className="text-sm font-semibold text-gray-700">Tyre wear &amp; projection</span>
          <span className="rounded-full bg-gray-100 px-2 py-0.5 text-[10px] text-gray-500">
            from {sessions.length} prep{sessions.length === 1 ? '' : 's'}
          </span>
        </div>
        <svg
          className={`h-4 w-4 text-gray-400 transition-transform ${open ? 'rotate-180' : ''}`}
          fill="none" viewBox="0 0 24 24" stroke="currentColor"
        >
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
        </svg>
      </button>

      {open && (
        <div className="space-y-3 px-3 pb-3">
          <div>
            <div className="mb-1 text-[10px] font-medium uppercase tracking-wide text-gray-400">Front axle</div>
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              {front.map(c => <CornerCard key={c.corner} trend={c} />)}
            </div>
          </div>
          <div>
            <div className="mb-1 text-[10px] font-medium uppercase tracking-wide text-gray-400">Rear axle</div>
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              {rear.map(c => <CornerCard key={c.corner} trend={c} />)}
            </div>
          </div>
          <p className="text-[10px] leading-relaxed text-gray-400">
            Projection is a straight-line estimate from the current tyre&apos;s wear so far
            {trends.milesPerDay != null && (
              <> (~{Math.round(trends.milesPerDay)} mi/day)</>
            )}. To 5mm = plan a replacement; to 4mm = replace now (Ooosh threshold, well above the
            {' '}{TYRE_TREAD_RED_MM}mm red line and the 1.6mm legal limit). Front and rear are
            computed separately. A blue dot marks a detected tyre change (tread jumped back up),
            which resets the projection for that corner.
          </p>
        </div>
      )}
    </div>
  )
}
