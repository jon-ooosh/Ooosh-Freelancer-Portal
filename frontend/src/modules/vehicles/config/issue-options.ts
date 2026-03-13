/**
 * Issue tracker — predefined options, categories, and badge styles.
 *
 * These drive the pill-button pickers in the issue creation and detail forms.
 */

import type { IssueCategory, IssueComponent, IssueSeverity, IssueStatus, IssueContext, RepairStatus, ClaimStatus, InvoiceStatus } from '../types/issue'

/** All issue categories */
export const ISSUE_CATEGORIES: IssueCategory[] = [
  'Mechanical', 'Electrical', 'Bodywork', 'Interior', 'Tyres & Wheels', 'Other',
]

/** Components grouped by category — filters the component picker dynamically */
export const COMPONENTS_BY_CATEGORY: Record<IssueCategory, IssueComponent[]> = {
  Mechanical: ['Engine', 'Gearbox', 'Brakes', 'Suspension', 'Exhaust', 'Steering', 'Other'],
  Electrical: ['Lights', 'Battery', 'EML', 'Entertainment', 'Heating/AC', 'Windows', 'Other'],
  Bodywork: ['Bodywork panels', 'Bumpers', 'Doors', 'Windscreen', 'Other glass', 'Locks', 'Other'],
  Interior: ['Seats', 'Floor', 'Interior trim', 'Entertainment', 'Heating/AC', 'Other'],
  'Tyres & Wheels': ['Tyres', 'Wheels/Rims', 'Other'],
  Other: ['Other'],
}

/** All severities in order */
export const ISSUE_SEVERITIES: IssueSeverity[] = ['Low', 'Medium', 'High', 'Critical']

/** All statuses in lifecycle order */
export const ISSUE_STATUSES: IssueStatus[] = ['Open', 'In Progress', 'Awaiting Parts', 'Resolved']

/** All reporting contexts */
export const ISSUE_CONTEXTS: IssueContext[] = ['Prep', 'Check-in', 'Book-out', 'Ad-hoc', 'Client report', 'On the road']

/** Common action labels for the activity timeline */
export const COMMON_ACTIONS = [
  'Reported',
  'Updated',
  'Investigating',
  'Waiting for details',
  'Client contacted',
  'Breakdown called',
  'Roadside assistance',
  'Recovery arranged',
  'In garage',
  'Swap vehicle arranged',
  'Parts ordered',
  'Parts received',
  'Wrong part arrived',
  'Sent for repair',
  'Repair in progress',
  'Fixed',
  'Resolved',
  'Cannot reproduce',
  'Deferred',
] as const

/** Tailwind badge styles for severity */
export const SEVERITY_STYLES: Record<IssueSeverity, string> = {
  Low: 'bg-blue-100 text-blue-700',
  Medium: 'bg-amber-100 text-amber-700',
  High: 'bg-orange-100 text-orange-700',
  Critical: 'bg-red-100 text-red-700',
}

/** Tailwind badge styles for status */
export const STATUS_STYLES: Record<IssueStatus, string> = {
  Open: 'bg-red-100 text-red-700',
  'In Progress': 'bg-blue-100 text-blue-700',
  'Awaiting Parts': 'bg-amber-100 text-amber-700',
  Resolved: 'bg-green-100 text-green-700',
}

/** Repair statuses in lifecycle order */
export const REPAIR_STATUSES: RepairStatus[] = ['Not Started', 'Working on it', 'Repair Complete']

/** Claim statuses */
export const CLAIM_STATUSES: ClaimStatus[] = ['No Claim', 'Claim in Progress', 'Claim Settled']

/** Invoice statuses */
export const INVOICE_STATUSES: InvoiceStatus[] = ['Not Invoiced', 'Invoice Received', 'Paid']

/** Known bodyshops */
export const BODYSHOPS = ['T Reeves', 'Portslade Panelworks', 'Sussex Windscreens', 'Rossetts (Worthing)'] as const

/** Badge styles for repair status */
export const REPAIR_STATUS_STYLES: Record<RepairStatus, string> = {
  'Not Started': 'bg-gray-100 text-gray-600',
  'Working on it': 'bg-amber-100 text-amber-700',
  'Repair Complete': 'bg-green-100 text-green-700',
}

/** Badge styles for claim status */
export const CLAIM_STATUS_STYLES: Record<ClaimStatus, string> = {
  'No Claim': 'bg-gray-100 text-gray-600',
  'Claim in Progress': 'bg-blue-100 text-blue-700',
  'Claim Settled': 'bg-green-100 text-green-700',
}

/** Badge styles for invoice status */
export const INVOICE_STATUS_STYLES: Record<InvoiceStatus, string> = {
  'Not Invoiced': 'bg-gray-100 text-gray-600',
  'Invoice Received': 'bg-amber-100 text-amber-700',
  Paid: 'bg-green-100 text-green-700',
}

/** Tailwind badge styles for category */
export const CATEGORY_STYLES: Record<IssueCategory, string> = {
  Mechanical: 'bg-slate-100 text-slate-700',
  Electrical: 'bg-yellow-100 text-yellow-700',
  Bodywork: 'bg-purple-100 text-purple-700',
  Interior: 'bg-teal-100 text-teal-700',
  'Tyres & Wheels': 'bg-indigo-100 text-indigo-700',
  Other: 'bg-gray-100 text-gray-600',
}
