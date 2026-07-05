/**
 * Forecast tab — forward-looking health view for a single vehicle.
 *
 * Renders the deterministic cards (mileage pace, service-due, compliance runway,
 * fluid frequency, cost trajectory, recurring issues) computed server-side, the
 * per-corner tyre wear panel (reuses PrepTrendsPanel, fed the same prep sessions),
 * and the cached AI health assessment with an on-demand Regenerate button.
 *
 * Everything reads from ONE backend payload so what staff see is exactly what
 * the AI narrator reasoned over.
 */

import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import {
  fetchVehicleForecast,
  regenerateAssessment,
  type VehicleForecast,
  type VehicleAssessment,
} from '../../lib/vehicle-forecast'
import { PrepTrendsPanel } from '../prep/PrepTrendsPanel'

interface Props {
  vehicleId: string
}

function fmtDate(d: string | null): string {
  if (!d) return '—'
  try {
    return new Date(d + 'T00:00:00').toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })
  } catch {
    return d
  }
}
function fmtDateTime(d: string): string {
  try {
    return new Date(d).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })
  } catch {
    return d
  }
}

const STATUS_DOT: Record<string, string> = {
  ok: 'bg-green-500', good: 'bg-green-500', green: 'bg-green-500',
  soon: 'bg-amber-500', watch: 'bg-amber-500', amber: 'bg-amber-500',
  due: 'bg-red-500', overdue: 'bg-red-500', attention: 'bg-red-500', red: 'bg-red-500',
  unknown: 'bg-gray-300',
}
const SEV_STYLE: Record<string, string> = {
  high: 'border-red-200 bg-red-50 text-red-700',
  medium: 'border-amber-200 bg-amber-50 text-amber-700',
  low: 'border-gray-200 bg-gray-50 text-gray-600',
}

function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-gray-200 bg-white p-3">
      <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-gray-400">{title}</div>
      {children}
    </div>
  )
}

function MileageCard({ f }: { f: VehicleForecast }) {
  const m = f.mileage
  return (
    <Card title="Mileage pace">
      {m.perWeek != null ? (
        <div className="space-y-1 text-sm">
          <div><span className="font-semibold text-gray-900">{m.perWeek.toLocaleString('en-GB')}</span> <span className="text-gray-500">mi/week</span></div>
          <div className="text-xs text-gray-500">~{m.annualProjected?.toLocaleString('en-GB')} mi/year projected</div>
          {f.vehicle.currentMileage != null && (
            <div className="text-xs text-gray-400">Now at {f.vehicle.currentMileage.toLocaleString('en-GB')} mi · {m.readings} readings</div>
          )}
        </div>
      ) : (
        <div className="text-sm text-gray-400">Not enough mileage readings yet</div>
      )}
    </Card>
  )
}

function ServiceCard({ f }: { f: VehicleForecast }) {
  const s = f.service
  return (
    <Card title="Next service">
      {s.nextDueMileage != null ? (
        <div className="space-y-1 text-sm">
          <div className="flex items-center gap-2">
            <span className={`h-2 w-2 rounded-full ${STATUS_DOT[s.status]}`} />
            <span className="font-semibold text-gray-900">
              {s.milesUntil != null ? (s.milesUntil <= 0 ? 'Due now' : `${s.milesUntil.toLocaleString('en-GB')} mi away`) : 'Distance unknown'}
            </span>
          </div>
          <div className="text-xs text-gray-500">
            Due at {s.nextDueMileage.toLocaleString('en-GB')} mi{s.etaWeeks != null && s.etaWeeks > 0 ? ` · ~${s.etaWeeks} weeks at current pace` : ''}
          </div>
          {s.lastServiceDate && (
            <div className="text-xs text-gray-400">Last: {fmtDate(s.lastServiceDate)}{s.lastServiceMileage != null ? ` at ${s.lastServiceMileage.toLocaleString('en-GB')} mi` : ''}</div>
          )}
        </div>
      ) : (
        <div className="text-sm text-gray-400">Next service mileage not set</div>
      )}
    </Card>
  )
}

function ComplianceCard({ f }: { f: VehicleForecast }) {
  return (
    <Card title="Compliance runway">
      <div className="space-y-1.5">
        {f.compliance.map((c) => (
          <div key={c.kind} className="flex items-center justify-between text-sm">
            <span className="flex items-center gap-2 text-gray-600">
              <span className={`h-2 w-2 rounded-full ${STATUS_DOT[c.status]}`} />
              {c.kind}
            </span>
            <span className={`text-xs font-medium ${c.status === 'overdue' ? 'text-red-600' : c.status === 'soon' ? 'text-amber-600' : 'text-gray-500'}`}>
              {c.due ? fmtDate(c.due) : 'not set'}{c.days != null ? ` (${c.days < 0 ? `${Math.abs(c.days)}d overdue` : `${c.days}d`})` : ''}
            </span>
          </div>
        ))}
      </div>
    </Card>
  )
}

function FluidsCard({ f }: { f: VehicleForecast }) {
  const shown = f.fluids.filter((fl) => fl.preps > 0)
  return (
    <Card title="Fluids (top-up frequency)">
      {shown.length ? (
        <div className="space-y-1.5">
          {shown.map((fl) => (
            <div key={fl.key} className="flex items-center justify-between text-sm">
              <span className="flex items-center gap-2 text-gray-600">
                <span className={`h-2 w-2 rounded-full ${STATUS_DOT[fl.status]}`} />
                {fl.label}
              </span>
              <span className={`text-xs ${fl.status === 'watch' ? 'font-medium text-amber-600' : 'text-gray-500'}`}>
                {fl.topUps}/{fl.preps} preps{fl.milesBetween != null ? ` · ~${fl.milesBetween.toLocaleString('en-GB')} mi` : ''}
              </span>
            </div>
          ))}
        </div>
      ) : (
        <div className="text-sm text-gray-400">No fluid checks recorded yet</div>
      )}
    </Card>
  )
}

function CostsCard({ f }: { f: VehicleForecast }) {
  const c = f.costs
  return (
    <Card title="Running cost (12 months)">
      <div className="space-y-1 text-sm">
        <div><span className="font-semibold text-gray-900">£{c.last12mTotal.toLocaleString('en-GB')}</span>{c.perMile != null ? <span className="text-gray-500"> · ~£{c.perMile}/mile</span> : ''}</div>
        <div className="text-xs text-gray-500">Service £{c.serviceTotal.toLocaleString('en-GB')} · Fuel £{c.fuelTotal.toLocaleString('en-GB')}</div>
        {c.recent.length > 0 && (
          <div className="mt-1.5 space-y-0.5 border-t border-gray-100 pt-1.5">
            {c.recent.slice(0, 4).map((r, i) => (
              <div key={i} className="flex items-center justify-between text-[11px] text-gray-500">
                <span className="truncate pr-2">{fmtDate(r.date)} · {r.name || r.type}</span>
                {r.cost != null && <span className="shrink-0">£{r.cost.toLocaleString('en-GB')}</span>}
              </div>
            ))}
          </div>
        )}
      </div>
    </Card>
  )
}

function RecurringCard({ f }: { f: VehicleForecast }) {
  if (!f.recurringIssues.length) return null
  return (
    <Card title="Recurring issues">
      <div className="space-y-1.5">
        {f.recurringIssues.map((ri, i) => (
          <div key={i} className="flex items-center justify-between text-sm">
            <span className="text-gray-700">{ri.label}</span>
            <span className="text-xs text-gray-500">{ri.count}× · last {fmtDate(ri.lastDate)}</span>
          </div>
        ))}
      </div>
    </Card>
  )
}

function AssessmentPanel({
  assessment, onRegenerate, regenerating,
}: { assessment: VehicleAssessment | null; onRegenerate: () => void; regenerating: boolean }) {
  // Collapsed by default — show the headline + a 2-line summary teaser, expand for
  // the full watch / recommended detail. Keeps the forecast cards above the fold.
  const [expanded, setExpanded] = useState(false)
  const statusLabel = assessment?.overall_status
    ? { good: 'Healthy', watch: 'Keep an eye', attention: 'Needs attention' }[assessment.overall_status] || assessment.overall_status
    : null
  const hasDetail = !!assessment && (assessment.watch_items.length > 0 || assessment.recommendations.length > 0 || !!assessment.summary)
  return (
    <div className="rounded-lg border border-ooosh-blue/20 bg-ooosh-blue/[0.03] p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-center gap-2">
          <span className="text-sm font-semibold text-gray-800">AI health assessment</span>
          {statusLabel && (
            <span className={`inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[10px] font-medium ${
              assessment?.overall_status === 'attention' ? 'bg-red-100 text-red-700'
                : assessment?.overall_status === 'watch' ? 'bg-amber-100 text-amber-700'
                : 'bg-green-100 text-green-700'
            }`}>{statusLabel}</span>
          )}
        </div>
        <button
          type="button"
          onClick={onRegenerate}
          disabled={regenerating}
          className="shrink-0 rounded-md border border-ooosh-blue/30 bg-white px-2.5 py-1 text-xs font-medium text-ooosh-blue hover:bg-ooosh-blue/5 disabled:opacity-50"
        >
          {regenerating ? 'Generating…' : 'Regenerate'}
        </button>
      </div>

      {!assessment ? (
        <p className="mt-2 text-sm text-gray-400">No assessment yet — generated automatically once a week, or click Regenerate.</p>
      ) : !expanded ? (
        <div className="mt-2">
          {assessment.headline && <p className="text-sm font-medium text-gray-900">{assessment.headline}</p>}
          {assessment.summary && (
            <p className="mt-0.5 text-sm leading-relaxed text-gray-700 line-clamp-2">{assessment.summary}</p>
          )}
          {hasDetail && (
            <button
              type="button"
              onClick={() => setExpanded(true)}
              className="mt-1 text-xs font-medium text-ooosh-blue hover:underline"
            >
              … Show more{assessment.watch_items.length + assessment.recommendations.length > 0
                ? ` (${assessment.watch_items.length + assessment.recommendations.length} item${assessment.watch_items.length + assessment.recommendations.length === 1 ? '' : 's'})`
                : ''}
            </button>
          )}
        </div>
      ) : (
        <div className="mt-2 space-y-3">
          {assessment.headline && <p className="text-sm font-medium text-gray-900">{assessment.headline}</p>}
          {assessment.summary && <p className="text-sm leading-relaxed text-gray-700">{assessment.summary}</p>}

          {assessment.watch_items.length > 0 && (
            <div className="space-y-1.5">
              <div className="text-[10px] font-medium uppercase tracking-wide text-gray-400">Watch</div>
              {assessment.watch_items.map((w, i) => (
                <div key={i} className={`rounded border px-2 py-1.5 text-xs ${SEV_STYLE[w.severity] || SEV_STYLE.low}`}>
                  <span className="font-medium">{w.label}</span> — {w.detail}
                </div>
              ))}
            </div>
          )}

          {assessment.recommendations.length > 0 && (
            <div className="space-y-1.5">
              <div className="text-[10px] font-medium uppercase tracking-wide text-gray-400">Recommended</div>
              {assessment.recommendations.map((r, i) => (
                <div key={i} className="flex items-start gap-2 text-xs text-gray-700">
                  <span className={`mt-1 h-1.5 w-1.5 shrink-0 rounded-full ${STATUS_DOT[r.priority] || 'bg-gray-300'}`} />
                  <span><span className="font-medium">{r.action}</span> — {r.reason}</span>
                </div>
              ))}
            </div>
          )}

          <p className="text-[10px] text-gray-400">
            Generated {fmtDateTime(assessment.generated_at)}{assessment.trigger === 'manual' ? ' (manual)' : ''}. AI synthesis of the data above — always sanity-check against the figures.
          </p>

          <button
            type="button"
            onClick={() => setExpanded(false)}
            className="text-xs font-medium text-ooosh-blue hover:underline"
          >
            Show less
          </button>
        </div>
      )}
    </div>
  )
}

export function ForecastTab({ vehicleId }: Props) {
  const [regenerating, setRegenerating] = useState(false)
  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: ['vehicle-forecast', vehicleId],
    queryFn: () => fetchVehicleForecast(vehicleId),
    staleTime: 5 * 60 * 1000,
  })

  async function handleRegenerate() {
    setRegenerating(true)
    try {
      await regenerateAssessment(vehicleId)
      await refetch()
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Could not generate the assessment.')
    } finally {
      setRegenerating(false)
    }
  }

  if (isLoading) {
    return (
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        {[1, 2, 3, 4].map((i) => <div key={i} className="h-28 animate-pulse rounded-lg bg-gray-100" />)}
      </div>
    )
  }
  if (isError || !data) {
    return <div className="rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-700">Failed to load forecast</div>
  }

  const f = data.forecast

  return (
    <div className="space-y-4">
      <AssessmentPanel assessment={data.assessment} onRegenerate={handleRegenerate} regenerating={regenerating} />

      {/* Tyre wear & projection — reuses the prep-trends panel, same prep data + service-record tyre changes */}
      <PrepTrendsPanel sessions={f.prepSessions} tyreEvents={f.tyreEvents} />

      {/* Deterministic cards */}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <MileageCard f={f} />
        <ServiceCard f={f} />
        <ComplianceCard f={f} />
        <FluidsCard f={f} />
        <CostsCard f={f} />
        <RecurringCard f={f} />
      </div>

      <p className="text-[10px] leading-relaxed text-gray-400">
        Forecast is built from prep history, service &amp; fuel logs, mileage readings, compliance dates and logged issues.
        Projections are straight-line estimates — treat as a planning guide, not a guarantee.
      </p>
    </div>
  )
}
