/**
 * Form for adding an activity update to an issue.
 * Action picker pills, optional status change, free-text note, author input.
 */

import { useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { saveIssue } from '../../lib/issues-r2-api'
import {
  COMMON_ACTIONS,
  ISSUE_STATUSES,
  STATUS_STYLES,
  REPAIR_STATUSES,
  REPAIR_STATUS_STYLES,
  CLAIM_STATUSES,
  CLAIM_STATUS_STYLES,
  INVOICE_STATUSES,
  INVOICE_STATUS_STYLES,
  BODYSHOPS,
} from '../../config/issue-options'
import type { VehicleIssue, IssueStatus, IssueActivity, IssueDocument, RepairStatus, ClaimStatus, InvoiceStatus, RepairInsuranceDetails } from '../../types/issue'
import { IssueDocuments } from './IssueDocuments'

interface AddActivityFormProps {
  issue: VehicleIssue
  onSaved: (updatedIssue: VehicleIssue) => void
}

export function AddActivityForm({ issue, onSaved }: AddActivityFormProps) {
  const queryClient = useQueryClient()
  const [action, setAction] = useState('')
  const [note, setNote] = useState('')
  const [author, setAuthor] = useState('')
  const [newStatus, setNewStatus] = useState<IssueStatus | null>(null)
  const [isSaving, setIsSaving] = useState(false)
  const [showRepairFields, setShowRepairFields] = useState(!!issue.repair)

  // Repair & insurance state — initialised from existing issue data
  const existing = issue.repair
  const [insuranceClaim, setInsuranceClaim] = useState(existing?.insuranceClaim ?? false)
  const [claimStatus, setClaimStatus] = useState<ClaimStatus>(existing?.claimStatus ?? 'No Claim')
  const [bodyshop, setBodyshop] = useState(existing?.bodyshop ?? '')
  const [quoteReceived, setQuoteReceived] = useState(existing?.quoteReceived ?? false)
  const [estimateAmount, setEstimateAmount] = useState(existing?.estimateAmount?.toString() ?? '')
  const [repairStatus, setRepairStatus] = useState<RepairStatus>(existing?.repairStatus ?? 'Not Started')
  const [invoiceStatus, setInvoiceStatus] = useState<InvoiceStatus>(existing?.invoiceStatus ?? 'Not Invoiced')
  const [repairDocs, setRepairDocs] = useState<IssueDocument[]>(existing?.documents ?? [])

  const canSubmit = action.trim() && author.trim() && !isSaving

  const handleSubmit = async () => {
    if (!canSubmit) return
    setIsSaving(true)

    try {
      const activity: IssueActivity = {
        id: crypto.randomUUID(),
        timestamp: new Date().toISOString(),
        author: author.trim(),
        action: action.trim(),
        note: note.trim(),
        newStatus: newStatus || undefined,
      }

      // Build repair details if the repair section is open
      const repairDetails: RepairInsuranceDetails | undefined = showRepairFields
        ? {
            insuranceClaim,
            claimStatus,
            bodyshop: bodyshop.trim() || null,
            quoteReceived,
            estimateAmount: estimateAmount ? parseFloat(estimateAmount) : null,
            repairStatus,
            invoiceStatus,
            documents: repairDocs,
          }
        : issue.repair

      const updatedIssue: VehicleIssue = {
        ...issue,
        activity: [...issue.activity, activity],
        status: newStatus || issue.status,
        resolvedAt: newStatus === 'Resolved' ? new Date().toISOString() : issue.resolvedAt,
        repair: repairDetails,
      }

      const result = await saveIssue(updatedIssue)

      if (result.success) {
        // Invalidate caches
        await queryClient.invalidateQueries({ queryKey: ['vehicle-issues', issue.vehicleReg] })
        await queryClient.invalidateQueries({ queryKey: ['issue', issue.vehicleReg, issue.id] })
        await queryClient.invalidateQueries({ queryKey: ['all-issues'] })

        // Reset form
        setAction('')
        setNote('')
        setNewStatus(null)
        // Keep author for convenience

        onSaved(updatedIssue)
      } else {
        console.error('[AddActivityForm] Save failed:', result.error)
      }
    } catch (err) {
      console.error('[AddActivityForm] Error:', err)
    } finally {
      setIsSaving(false)
    }
  }

  return (
    <div className="space-y-3 rounded-lg border border-gray-200 bg-white p-4">
      <h4 className="text-sm font-semibold text-gray-700">Add Update</h4>

      {/* Action picker pills */}
      <div>
        <label className="mb-1.5 block text-xs font-medium text-gray-500">Action</label>
        <div className="flex flex-wrap gap-1.5">
          {COMMON_ACTIONS.map((a) => (
            <button
              key={a}
              type="button"
              onClick={() => setAction(a)}
              className={`rounded-full px-3 py-1 text-xs font-medium transition-colors ${
                action === a
                  ? 'bg-ooosh-navy text-white'
                  : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
              }`}
            >
              {a}
            </button>
          ))}
        </div>
      </div>

      {/* Optional status change */}
      <div>
        <label className="mb-1.5 block text-xs font-medium text-gray-500">
          Change status <span className="text-gray-400">(optional)</span>
        </label>
        <div className="flex flex-wrap gap-1.5">
          {ISSUE_STATUSES.map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => setNewStatus(newStatus === s ? null : s)}
              className={`rounded-full px-3 py-1 text-xs font-medium transition-colors ${
                newStatus === s
                  ? STATUS_STYLES[s]
                  : 'bg-gray-50 text-gray-400 hover:bg-gray-100'
              }`}
            >
              {s}
            </button>
          ))}
        </div>
      </div>

      {/* Note textarea */}
      <div>
        <label className="mb-1.5 block text-xs font-medium text-gray-500">
          Note <span className="text-gray-400">(optional)</span>
        </label>
        <textarea
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder="Any details, observations, next steps..."
          rows={3}
          className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm placeholder-gray-400 focus:border-blue-300 focus:outline-none focus:ring-1 focus:ring-blue-300"
        />
      </div>

      {/* Repair & Insurance toggle */}
      <div className="border-t border-gray-100 pt-3">
        <button
          type="button"
          onClick={() => setShowRepairFields(!showRepairFields)}
          className="flex items-center gap-1.5 text-xs font-medium text-gray-500 hover:text-gray-700"
        >
          <svg
            className={`h-3 w-3 transition-transform ${showRepairFields ? 'rotate-90' : ''}`}
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
            strokeWidth={2}
          >
            <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
          </svg>
          Repair & Insurance
        </button>

        {showRepairFields && (
          <div className="mt-3 space-y-3 rounded-lg border border-gray-100 bg-gray-50 p-3">
            {/* Insurance claim */}
            <div className="flex items-center gap-3">
              <label className="text-xs font-medium text-gray-500 w-28">Insurance claim</label>
              <div className="flex gap-1.5">
                {[true, false].map(val => (
                  <button
                    key={String(val)}
                    type="button"
                    onClick={() => setInsuranceClaim(val)}
                    className={`rounded-full px-3 py-1 text-xs font-medium transition-colors ${
                      insuranceClaim === val
                        ? val ? 'bg-blue-100 text-blue-700' : 'bg-gray-200 text-gray-600'
                        : 'bg-gray-50 text-gray-400 hover:bg-gray-100'
                    }`}
                  >
                    {val ? 'Yes' : 'No'}
                  </button>
                ))}
              </div>
            </div>

            {/* Claim status — only if insurance claim is Yes */}
            {insuranceClaim && (
              <div className="flex items-center gap-3">
                <label className="text-xs font-medium text-gray-500 w-28">Claim status</label>
                <div className="flex flex-wrap gap-1.5">
                  {CLAIM_STATUSES.map(s => (
                    <button
                      key={s}
                      type="button"
                      onClick={() => setClaimStatus(s)}
                      className={`rounded-full px-3 py-1 text-xs font-medium transition-colors ${
                        claimStatus === s
                          ? CLAIM_STATUS_STYLES[s]
                          : 'bg-gray-50 text-gray-400 hover:bg-gray-100'
                      }`}
                    >
                      {s}
                    </button>
                  ))}
                </div>
              </div>
            )}

            {/* Bodyshop */}
            <div className="flex items-center gap-3">
              <label className="text-xs font-medium text-gray-500 w-28">Bodyshop</label>
              <div className="flex flex-wrap gap-1.5">
                {BODYSHOPS.map(b => (
                  <button
                    key={b}
                    type="button"
                    onClick={() => setBodyshop(bodyshop === b ? '' : b)}
                    className={`rounded-full px-3 py-1 text-xs font-medium transition-colors ${
                      bodyshop === b
                        ? 'bg-purple-100 text-purple-700'
                        : 'bg-gray-50 text-gray-400 hover:bg-gray-100'
                    }`}
                  >
                    {b}
                  </button>
                ))}
                <input
                  type="text"
                  value={BODYSHOPS.includes(bodyshop as typeof BODYSHOPS[number]) ? '' : bodyshop}
                  onChange={e => setBodyshop(e.target.value)}
                  placeholder="Other..."
                  className="w-24 rounded-lg border border-gray-200 px-2 py-1 text-xs placeholder-gray-400 focus:border-blue-300 focus:outline-none"
                />
              </div>
            </div>

            {/* Quote received + estimate */}
            <div className="flex items-center gap-3">
              <label className="text-xs font-medium text-gray-500 w-28">Quote received</label>
              <div className="flex items-center gap-3">
                <div className="flex gap-1.5">
                  {[true, false].map(val => (
                    <button
                      key={String(val)}
                      type="button"
                      onClick={() => setQuoteReceived(val)}
                      className={`rounded-full px-3 py-1 text-xs font-medium transition-colors ${
                        quoteReceived === val
                          ? val ? 'bg-green-100 text-green-700' : 'bg-gray-200 text-gray-600'
                          : 'bg-gray-50 text-gray-400 hover:bg-gray-100'
                      }`}
                    >
                      {val ? 'Yes' : 'No'}
                    </button>
                  ))}
                </div>
                {quoteReceived && (
                  <div className="flex items-center gap-1">
                    <span className="text-xs text-gray-400">{'\u00A3'}</span>
                    <input
                      type="number"
                      value={estimateAmount}
                      onChange={e => setEstimateAmount(e.target.value)}
                      placeholder="Amount inc VAT"
                      step="0.01"
                      className="w-28 rounded-lg border border-gray-200 px-2 py-1 text-xs placeholder-gray-400 focus:border-blue-300 focus:outline-none"
                    />
                  </div>
                )}
              </div>
            </div>

            {/* Repair status */}
            <div className="flex items-center gap-3">
              <label className="text-xs font-medium text-gray-500 w-28">Repair status</label>
              <div className="flex flex-wrap gap-1.5">
                {REPAIR_STATUSES.map(s => (
                  <button
                    key={s}
                    type="button"
                    onClick={() => setRepairStatus(s)}
                    className={`rounded-full px-3 py-1 text-xs font-medium transition-colors ${
                      repairStatus === s
                        ? REPAIR_STATUS_STYLES[s]
                        : 'bg-gray-50 text-gray-400 hover:bg-gray-100'
                    }`}
                  >
                    {s}
                  </button>
                ))}
              </div>
            </div>

            {/* Invoice status */}
            <div className="flex items-center gap-3">
              <label className="text-xs font-medium text-gray-500 w-28">Invoice</label>
              <div className="flex flex-wrap gap-1.5">
                {INVOICE_STATUSES.map(s => (
                  <button
                    key={s}
                    type="button"
                    onClick={() => setInvoiceStatus(s)}
                    className={`rounded-full px-3 py-1 text-xs font-medium transition-colors ${
                      invoiceStatus === s
                        ? INVOICE_STATUS_STYLES[s]
                        : 'bg-gray-50 text-gray-400 hover:bg-gray-100'
                    }`}
                  >
                    {s}
                  </button>
                ))}
              </div>
            </div>

            {/* Documents */}
            <div className="border-t border-gray-100 pt-3">
              <label className="mb-2 block text-xs font-medium text-gray-500">Documents (quotes, invoices, photos)</label>
              <IssueDocuments
                vehicleReg={issue.vehicleReg}
                issueId={issue.id}
                documents={repairDocs}
                onDocumentsChange={setRepairDocs}
              />
            </div>
          </div>
        )}
      </div>

      {/* Author input */}
      <div>
        <label className="mb-1.5 block text-xs font-medium text-gray-500">Your name</label>
        <input
          type="text"
          value={author}
          onChange={(e) => setAuthor(e.target.value)}
          placeholder="Who's adding this update?"
          className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm placeholder-gray-400 focus:border-blue-300 focus:outline-none focus:ring-1 focus:ring-blue-300"
        />
      </div>

      {/* Submit button */}
      <button
        type="button"
        onClick={handleSubmit}
        disabled={!canSubmit}
        className={`w-full rounded-lg py-2.5 text-sm font-semibold text-white transition-colors ${
          canSubmit
            ? 'bg-ooosh-navy hover:bg-ooosh-navy/90 active:bg-ooosh-navy/80'
            : 'bg-gray-300 cursor-not-allowed'
        }`}
      >
        {isSaving ? 'Saving...' : 'Add Update'}
      </button>
    </div>
  )
}
