/**
 * Issue & Maintenance Tracker — TypeScript types.
 *
 * Issues live in R2 (not Monday.com) as the source of truth.
 * Each issue has a stepped activity log tracking its full lifecycle.
 */

export type IssueCategory = 'Mechanical' | 'Electrical' | 'Bodywork' | 'Interior' | 'Tyres & Wheels' | 'Other'

export type IssueComponent =
  | 'Engine' | 'Gearbox' | 'Brakes' | 'Suspension' | 'Exhaust' | 'Steering'
  | 'Doors' | 'Locks' | 'Lights' | 'Heating/AC' | 'Entertainment' | 'Windows' | 'EML' | 'Battery'
  | 'Bodywork panels' | 'Bumpers' | 'Windscreen' | 'Other glass'
  | 'Tyres' | 'Wheels/Rims'
  | 'Seats' | 'Floor' | 'Interior trim'
  | 'Other'

export type IssueSeverity = 'Low' | 'Medium' | 'High' | 'Critical'

export type IssueStatus = 'Open' | 'In Progress' | 'Awaiting Parts' | 'Resolved'

// ── Repair & Insurance tracking ──

export type RepairStatus = 'Not Started' | 'Working on it' | 'Repair Complete'

export type ClaimStatus = 'No Claim' | 'Claim in Progress' | 'Claim Settled'

export type InvoiceStatus = 'Not Invoiced' | 'Invoice Received' | 'Paid'

/** A document attached to an issue (quote, invoice, photo, etc.) */
export interface IssueDocument {
  id: string
  filename: string
  r2Key: string            // R2 storage key
  url: string              // Public URL for display/download
  contentType: string      // MIME type
  comment: string          // User comment explaining what this doc is
  uploadedBy: string
  uploadedAt: string       // ISO timestamp
}

/** Repair & insurance claim details — optional, typically added after initial report */
export interface RepairInsuranceDetails {
  insuranceClaim: boolean
  claimStatus: ClaimStatus
  bodyshop: string | null          // e.g. "T Reeves", "Portslade Panelworks"
  quoteReceived: boolean
  estimateAmount: number | null    // Including VAT
  repairStatus: RepairStatus
  invoiceStatus: InvoiceStatus
  documents: IssueDocument[]       // Quotes, invoices, photos, etc.
}

export type IssueContext = 'Prep' | 'Check-in' | 'Book-out' | 'Ad-hoc' | 'Client report' | 'On the road'

/** A single entry in the issue's activity timeline */
export interface IssueActivity {
  id: string
  timestamp: string
  author: string
  action: string
  note: string
  newStatus?: IssueStatus
}

/** GPS location snapshot captured at time of issue report */
export interface IssueLocation {
  lat: number
  lng: number
  address?: string
  speed?: number        // mph at time of report
  ignition?: boolean
  capturedAt: string    // ISO timestamp of the GPS fix
}

/** Full issue object — stored per-vehicle in R2 */
export interface VehicleIssue {
  id: string
  vehicleReg: string
  vehicleId: string
  vehicleMake: string
  vehicleModel: string
  vehicleType: string
  mileageAtReport: number | null
  hireHopJob: string | null
  location?: IssueLocation | null
  category: IssueCategory
  component: IssueComponent
  severity: IssueSeverity
  summary: string
  status: IssueStatus
  reportedBy: string
  reportedAt: string
  reportedDuring: IssueContext
  resolvedAt: string | null
  photos: string[]
  activity: IssueActivity[]
  /** Repair & insurance claim tracking — added/updated via issue detail page */
  repair?: RepairInsuranceDetails
}

/** Lightweight index entry — stored in issues/_index.json for fleet-wide queries */
export interface IssueIndexEntry {
  id: string
  vehicleReg: string
  vehicleId: string
  category: IssueCategory
  component: IssueComponent
  severity: IssueSeverity
  summary: string
  status: IssueStatus
  reportedAt: string
  resolvedAt: string | null
  lastActivityAt: string
}
