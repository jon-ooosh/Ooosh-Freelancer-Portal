/**
 * Shared type definitions for the Ooosh Freelancer Portal
 */

// =============================================================================
// USER / AUTHENTICATION
// =============================================================================

export interface User {
  id: string
  name: string
  email: string
  phone?: string
}

export interface Session {
  id: string
  email: string
  name: string
  exp: number
  iat: number
}

// =============================================================================
// JOBS
// =============================================================================

export type JobType = 'delivery' | 'collection'

export type JobStatus = 
  | 'to_do'
  | 'arranging'
  | 'arranged'
  | 'working_on_it'
  | 'all_done'
  | 'now_not_needed'

export interface Job {
  id: string
  name: string
  type: JobType
  hhRef?: string
  date: string
  time?: string
  venue: Venue
  status: JobStatus
  runGroup?: string
  agreedFee: number
  driverIds: string[]
  keyNotes?: string
  completedAt?: string
  completionNotes?: string
  extraCharges?: number
  extraChargesReason?: string
}

export interface GroupedRun {
  runGroup: string
  date: string
  jobs: Job[]
  totalFee: number
}

// =============================================================================
// VENUES
// =============================================================================

export interface Venue {
  id: string
  name: string
  address: string
  whatThreeWords?: string
  contact1?: string
  contact2?: string
  phone?: string
  email?: string
  accessNotes?: string
}

// =============================================================================
// COSTINGS
// =============================================================================

export interface JobCosting {
  jobId: string
  quotedToClient: number
  payDriver: number
  fuelEstimate?: number
  tollsEstimate?: number
}

// =============================================================================
// API RESPONSES
// =============================================================================

export interface ApiResponse<T = unknown> {
  success: boolean
  data?: T
  error?: string
}

export interface LoginResponse {
  success: boolean
  user?: User
  error?: string
}

export interface JobsResponse {
  success: boolean
  jobs?: Job[]
  groupedRuns?: GroupedRun[]
  error?: string
}

// =============================================================================
// DISPLAY HELPERS
// =============================================================================

export type DisplayJobStatus = 'upcoming' | 'today' | 'in_progress' | 'completed' | 'cancelled'

export interface DisplayJob extends Omit<Job, 'status'> {
  displayStatus: DisplayJobStatus
  isContactVisible: boolean
  formattedDate: string
  formattedFee: string
}

export interface DisplayGroupedRun extends Omit<GroupedRun, 'jobs'> {
  jobs: DisplayJob[]
  formattedTotalFee: string
}
