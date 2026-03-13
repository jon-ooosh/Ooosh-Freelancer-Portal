/**
 * Issue detail page — view issue info, activity timeline, and add updates.
 *
 * Route: /issues/:vehicleReg/:issueId
 */

import { useState } from 'react'
import { useParams, Link } from 'react-router-dom'
import { vmPath } from '../config/route-paths'
import { useIssue } from '../hooks/useVehicleIssues'
import { useVehicles } from '../hooks/useVehicles'
import { ActivityTimeline } from '../components/issues/ActivityTimeline'
import { AddActivityForm } from '../components/issues/AddActivityForm'
import { IssueDocuments } from '../components/issues/IssueDocuments'
import { SEVERITY_STYLES, STATUS_STYLES, CATEGORY_STYLES, REPAIR_STATUS_STYLES, CLAIM_STATUS_STYLES, INVOICE_STATUS_STYLES } from '../config/issue-options'
import { formatDistanceToNow, format } from 'date-fns'
import type { VehicleIssue, IssueSeverity, IssueStatus, IssueCategory, RepairStatus, ClaimStatus, InvoiceStatus } from '../types/issue'

function Badge({ children, className = '' }: { children: React.ReactNode; className?: string }) {
  return (
    <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-medium ${className}`}>
      {children}
    </span>
  )
}

function formatDate(dateStr: string): string {
  try {
    return format(new Date(dateStr), 'dd MMM yyyy, HH:mm')
  } catch {
    return dateStr
  }
}

function formatRelative(dateStr: string): string {
  try {
    return formatDistanceToNow(new Date(dateStr), { addSuffix: true })
  } catch {
    return dateStr
  }
}

export function IssueDetailPage() {
  const { vehicleReg, issueId } = useParams()
  const { data: issue, isLoading, isError } = useIssue(vehicleReg, issueId)
  const { data: allVehicles } = useVehicles()

  // Local state for optimistic updates after adding activity
  const [localIssue, setLocalIssue] = useState<VehicleIssue | null>(null)

  // Use local issue if we have it (optimistic after update), otherwise use query data
  const displayIssue = localIssue || issue

  // Find the vehicle to link to vehicle detail
  const vehicle = allVehicles?.find(v => v.reg === vehicleReg)

  if (isLoading) {
    return (
      <div className="space-y-4 animate-pulse">
        <div className="h-4 w-24 rounded bg-gray-200" />
        <div className="h-8 w-48 rounded bg-gray-200" />
        <div className="rounded-lg border border-gray-200 bg-white p-6">
          <div className="space-y-3">
            {[1, 2, 3].map(i => <div key={i} className="h-4 rounded bg-gray-100" />)}
          </div>
        </div>
      </div>
    )
  }

  if (isError || !displayIssue) {
    return (
      <div className="space-y-4">
        <Link to={vmPath('/issues')} className="inline-flex items-center text-sm text-ooosh-blue hover:underline">
          &larr; Back to issues
        </Link>
        <div className="rounded-lg border border-red-200 bg-red-50 p-6 text-center text-sm text-red-700">
          Issue not found
        </div>
      </div>
    )
  }

  const severity = displayIssue.severity as IssueSeverity
  const status = displayIssue.status as IssueStatus
  const category = displayIssue.category as IssueCategory

  return (
    <div className="space-y-4">
      {/* Back link */}
      <Link to={vmPath('/issues')} className="inline-flex items-center text-sm text-ooosh-blue hover:underline">
        &larr; Back to issues
      </Link>

      {/* Header card */}
      <div className="rounded-lg border border-gray-200 bg-white p-4">
        {/* Vehicle link */}
        <div className="mb-2">
          {vehicle ? (
            <Link
              to={`/vehicles/${vehicle.id}`}
              className="font-mono text-sm font-bold text-ooosh-navy hover:underline"
            >
              {displayIssue.vehicleReg}
            </Link>
          ) : (
            <span className="font-mono text-sm font-bold text-ooosh-navy">
              {displayIssue.vehicleReg}
            </span>
          )}
          <span className="ml-2 text-xs text-gray-400">
            {displayIssue.vehicleMake} {displayIssue.vehicleModel}
          </span>
        </div>

        {/* Summary */}
        <h2 className="text-lg font-semibold text-gray-900">{displayIssue.summary}</h2>

        {/* Badges */}
        <div className="mt-2 flex flex-wrap gap-1.5">
          <Badge className={STATUS_STYLES[status] || 'bg-gray-100 text-gray-600'}>{status}</Badge>
          <Badge className={SEVERITY_STYLES[severity] || 'bg-gray-100 text-gray-600'}>{severity}</Badge>
          <Badge className={CATEGORY_STYLES[category] || 'bg-gray-100 text-gray-600'}>{category}</Badge>
          <Badge className="bg-gray-100 text-gray-600">{displayIssue.component}</Badge>
        </div>

        {/* Info row */}
        <div className="mt-3 grid grid-cols-2 gap-2 text-xs text-gray-500">
          <div>
            <span className="text-gray-400">Reported by </span>
            <span className="font-medium text-gray-600">{displayIssue.reportedBy}</span>
          </div>
          <div>
            <span className="text-gray-400">During </span>
            <span className="font-medium text-gray-600">{displayIssue.reportedDuring}</span>
          </div>
          <div title={formatDate(displayIssue.reportedAt)}>
            <span className="text-gray-400">Reported </span>
            <span className="font-medium text-gray-600">{formatRelative(displayIssue.reportedAt)}</span>
          </div>
          {displayIssue.mileageAtReport && (
            <div>
              <span className="text-gray-400">Mileage </span>
              <span className="font-medium text-gray-600">
                {displayIssue.mileageAtReport.toLocaleString('en-GB')}
              </span>
            </div>
          )}
          {displayIssue.hireHopJob && (
            <div>
              <span className="text-gray-400">HireHop Job </span>
              <span className="font-mono font-medium text-gray-600">{displayIssue.hireHopJob}</span>
            </div>
          )}
          {displayIssue.resolvedAt && (
            <div title={formatDate(displayIssue.resolvedAt)}>
              <span className="text-gray-400">Resolved </span>
              <span className="font-medium text-green-600">{formatRelative(displayIssue.resolvedAt)}</span>
            </div>
          )}
        </div>
      </div>

      {/* Location */}
      {displayIssue.location && (
        <div className="rounded-lg border border-gray-200 bg-white p-4">
          <h3 className="mb-2 text-sm font-semibold uppercase tracking-wide text-gray-500">
            Location at Report
          </h3>
          <a
            href={`https://www.openstreetmap.org/?mlat=${displayIssue.location.lat}&mlon=${displayIssue.location.lng}#map=15/${displayIssue.location.lat}/${displayIssue.location.lng}`}
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-2 rounded-lg border border-blue-100 bg-blue-50 px-3 py-2 text-sm text-blue-700 hover:bg-blue-100 transition-colors"
          >
            <svg className="h-4 w-4 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M17.657 16.657L13.414 20.9a1.998 1.998 0 01-2.827 0l-4.244-4.243a8 8 0 1111.314 0z" />
              <path strokeLinecap="round" strokeLinejoin="round" d="M15 11a3 3 0 11-6 0 3 3 0 016 0z" />
            </svg>
            <span>
              {displayIssue.location.lat.toFixed(5)}, {displayIssue.location.lng.toFixed(5)}
              {displayIssue.location.speed != null && displayIssue.location.speed > 0 && (
                <span className="ml-2 text-blue-500">({displayIssue.location.speed} mph)</span>
              )}
              {displayIssue.location.ignition != null && (
                <span className="ml-2 text-blue-500">
                  {displayIssue.location.ignition ? 'Engine on' : 'Engine off'}
                </span>
              )}
            </span>
            <svg className="ml-auto h-3.5 w-3.5 flex-shrink-0 text-blue-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
            </svg>
          </a>
          <p className="mt-1 text-[10px] text-gray-400">
            GPS fix: {formatDate(displayIssue.location.capturedAt)}
          </p>
        </div>
      )}

      {/* Photos */}
      {displayIssue.photos && displayIssue.photos.length > 0 && (
        <div className="rounded-lg border border-gray-200 bg-white p-4">
          <h3 className="mb-3 text-sm font-semibold uppercase tracking-wide text-gray-500">Photos</h3>
          <div className="grid grid-cols-3 gap-2">
            {displayIssue.photos.map((url, i) => (
              <a key={i} href={url} target="_blank" rel="noopener noreferrer">
                <img
                  src={url}
                  alt={`Issue photo ${i + 1}`}
                  className="h-24 w-full rounded-lg border border-gray-200 object-cover"
                />
              </a>
            ))}
          </div>
        </div>
      )}

      {/* Repair & Insurance card */}
      {displayIssue.repair && (
        <div className="rounded-lg border border-gray-200 bg-white p-4">
          <h3 className="mb-3 text-sm font-semibold uppercase tracking-wide text-gray-500">
            Repair & Insurance
          </h3>
          <div className="grid grid-cols-2 gap-2 text-xs text-gray-500">
            <div>
              <span className="text-gray-400">Insurance claim </span>
              <span className="font-medium text-gray-600">
                {displayIssue.repair.insuranceClaim ? 'Yes' : 'No'}
              </span>
            </div>
            {displayIssue.repair.insuranceClaim && (
              <div>
                <span className="text-gray-400">Claim status </span>
                <Badge className={CLAIM_STATUS_STYLES[displayIssue.repair.claimStatus as ClaimStatus] || 'bg-gray-100 text-gray-600'}>
                  {displayIssue.repair.claimStatus}
                </Badge>
              </div>
            )}
            {displayIssue.repair.bodyshop && (
              <div>
                <span className="text-gray-400">Bodyshop </span>
                <span className="font-medium text-gray-600">{displayIssue.repair.bodyshop}</span>
              </div>
            )}
            <div>
              <span className="text-gray-400">Quote received </span>
              <span className="font-medium text-gray-600">
                {displayIssue.repair.quoteReceived ? 'Yes' : 'No'}
              </span>
            </div>
            {displayIssue.repair.estimateAmount != null && (
              <div>
                <span className="text-gray-400">Estimate (inc VAT) </span>
                <span className="font-medium text-gray-600">
                  {'\u00A3'}{displayIssue.repair.estimateAmount.toLocaleString('en-GB', { minimumFractionDigits: 2 })}
                </span>
              </div>
            )}
            <div>
              <span className="text-gray-400">Repair status </span>
              <Badge className={REPAIR_STATUS_STYLES[displayIssue.repair.repairStatus as RepairStatus] || 'bg-gray-100 text-gray-600'}>
                {displayIssue.repair.repairStatus}
              </Badge>
            </div>
            <div>
              <span className="text-gray-400">Invoice </span>
              <Badge className={INVOICE_STATUS_STYLES[displayIssue.repair.invoiceStatus as InvoiceStatus] || 'bg-gray-100 text-gray-600'}>
                {displayIssue.repair.invoiceStatus}
              </Badge>
            </div>
          </div>

          {/* Documents within repair card */}
          {displayIssue.repair.documents && displayIssue.repair.documents.length > 0 && (
            <div className="mt-3 border-t border-gray-100 pt-3">
              <h4 className="mb-2 text-xs font-semibold text-gray-500">Documents</h4>
              <IssueDocuments
                vehicleReg={displayIssue.vehicleReg}
                issueId={displayIssue.id}
                documents={displayIssue.repair.documents}
                onDocumentsChange={() => {}}
                readOnly
              />
            </div>
          )}
        </div>
      )}

      {/* Activity timeline */}
      <div className="rounded-lg border border-gray-200 bg-white p-4">
        <h3 className="mb-3 text-sm font-semibold uppercase tracking-wide text-gray-500">Activity</h3>
        <ActivityTimeline activities={displayIssue.activity} />
      </div>

      {/* Add activity form — hide if resolved */}
      {displayIssue.status !== 'Resolved' && (
        <AddActivityForm
          issue={displayIssue}
          onSaved={(updated) => setLocalIssue(updated)}
        />
      )}
    </div>
  )
}
