// ============================================================================
// Shared types between frontend and backend
// These mirror the database schema from migration 001
// ============================================================================

// Files attached to any entity (people, organisations, venues, interactions)
// Stored as JSONB array in PostgreSQL
export interface FileAttachment {
  name: string;
  label?: string;
  url: string;
  type: 'document' | 'image' | 'other';
  uploaded_at: string;
  uploaded_by: string;
}

export interface Person {
  id: string;
  first_name: string;
  last_name: string;
  email: string | null;
  phone: string | null;           // Primary / office / landline
  mobile: string | null;          // UK mobile
  international_phone: string | null; // International / touring number
  notes: string | null;
  tags: string[];
  files: FileAttachment[];
  preferred_contact_method: string;
  home_address: string | null;
  date_of_birth: string | null;
  // Freelancer-specific (null for non-freelancers)
  skills: string[];
  is_insured_on_vehicles: boolean;
  is_approved: boolean;
  has_tshirt: boolean;
  emergency_contact_name: string | null;
  emergency_contact_phone: string | null;
  licence_details: string | null;
  freelancer_references: string | null;
  // System
  is_deleted: boolean;
  created_by: string;
  created_at: string;
  updated_at: string;
}

export interface Organisation {
  id: string;
  name: string;
  type: string;
  parent_id: string | null;
  website: string | null;
  email: string | null;
  phone: string | null;
  address: string | null;
  location: string | null;
  notes: string | null;
  tags: string[];
  files: FileAttachment[];
  is_deleted: boolean;
  created_by: string;
  created_at: string;
  updated_at: string;
}

export interface PersonOrganisationRole {
  id: string;
  person_id: string;
  organisation_id: string;
  role: string;
  status: 'active' | 'historical';
  is_primary: boolean;
  start_date: string | null;
  end_date: string | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

export interface Venue {
  id: string;
  name: string;
  organisation_id: string | null;
  address: string | null;
  city: string | null;
  postcode: string | null;
  country: string | null;
  latitude: number | null;
  longitude: number | null;
  w3w_address: string | null;
  load_in_address: string | null;
  loading_bay_info: string | null;
  access_codes: string | null;
  parking_info: string | null;
  approach_notes: string | null;
  technical_notes: string | null;
  general_notes: string | null;
  default_miles_from_base: number | null;
  default_drive_time_mins: number | null;
  default_return_cost: number | null;
  tags: string[];
  files: FileAttachment[];
  is_deleted: boolean;
  created_by: string;
  created_at: string;
  updated_at: string;
}

// HireHop status code → human-readable name
export const HH_JOB_STATUS_MAP: Record<number, string> = {
  0: 'Enquiry',
  1: 'Provisional',
  2: 'Booked',
  3: 'Prepped',
  4: 'Part Dispatched',
  5: 'Dispatched',
  6: 'Returned Incomplete',
  7: 'Returned',
  8: 'Requires Attention',
  9: 'Cancelled',
  10: 'Not Interested',
  11: 'Completed',
};

// Active statuses worth syncing (not dead/done)
export const HH_ACTIVE_STATUSES = [0, 1, 2, 3, 4, 5, 6, 7, 8];

// Pipeline status values
export type PipelineStatus = 'new_enquiry' | 'quoting' | 'chasing' | 'paused' | 'provisional' | 'confirmed' | 'lost';
export type QuoteStatus = 'not_quoted' | 'quoted' | 'revised' | 'accepted';
export type Likelihood = 'hot' | 'warm' | 'cold';
export type HoldReason = 'under_minimum' | 'fully_booked' | 'client_undecided' | 'too_early' | 'other';
export type ConfirmedMethod = 'deposit' | 'full_payment' | 'po' | 'manual';
export type EnquirySource = 'phone' | 'email' | 'web_form' | 'referral' | 'cold_lead' | 'forum' | 'repeat' | 'other';
export type ChaseMethod = 'phone' | 'email' | 'text' | 'whatsapp';

// Pipeline status display config
export const PIPELINE_STATUS_CONFIG: Record<PipelineStatus, { label: string; colour: string; order: number }> = {
  new_enquiry:  { label: 'New Enquiry',     colour: '#3B82F6', order: 1 },  // Blue
  quoting:      { label: 'Quoting',         colour: '#8B5CF6', order: 2 },  // Purple
  chasing:      { label: 'Chasing',         colour: '#F59E0B', order: 3 },  // Amber
  paused:       { label: 'Paused Enquiry',  colour: '#6B7280', order: 4 },  // Grey
  provisional:  { label: 'Provisional',     colour: '#EF4444', order: 5 },  // Red
  confirmed:    { label: 'Confirmed',       colour: '#10B981', order: 6 },  // Green
  lost:         { label: 'Lost',            colour: '#374151', order: 7 },  // Dark grey
};

export const HOLD_REASON_LABELS: Record<HoldReason, string> = {
  under_minimum:    'Under minimum terms',
  fully_booked:     'Fully booked',
  client_undecided: 'Client undecided',
  too_early:        'Too early to confirm',
  other:            'Other',
};

export const LOST_REASON_OPTIONS = [
  'Price',
  'Availability',
  'Competitor',
  'Timing',
  'No Decision',
  'Cancelled Event',
  'Other',
] as const;

export interface Job {
  id: string;
  hh_job_number: number | null;
  job_name: string | null;
  job_type: string | null;
  status: number;
  status_name: string | null;
  colour: string | null;
  // Client
  client_id: string | null;
  client_name: string | null;
  company_name: string | null;
  client_ref: string | null;
  // Venue
  venue_id: string | null;
  venue_name: string | null;
  address: string | null;
  // Dates
  out_date: string | null;
  job_date: string | null;
  job_end: string | null;
  return_date: string | null;
  created_date: string | null;
  // Duration
  duration_days: number | null;
  duration_hrs: number | null;
  // Managers
  manager1_name: string | null;
  manager1_person_id: string | null;
  manager2_name: string | null;
  manager2_person_id: string | null;
  // Project
  hh_project_id: number | null;
  project_name: string | null;
  // Details
  details: string | null;
  custom_index: string | null;
  depot_name: string | null;
  is_internal: boolean;
  // Pipeline
  pipeline_status: PipelineStatus;
  pipeline_status_changed_at: string | null;
  quote_status: QuoteStatus | null;
  likelihood: Likelihood | null;
  // Chase tracking
  chase_count: number;
  last_chased_at: string | null;
  next_chase_date: string | null;
  chase_interval_days: number;
  // Hold/pause
  hold_reason: HoldReason | null;
  hold_reason_detail: string | null;
  // Confirmation
  confirmed_method: ConfirmedMethod | null;
  confirmed_at: string | null;
  // Financial
  job_value: number | null;
  // Lost
  lost_reason: string | null;
  lost_detail: string | null;
  lost_at: string | null;
  // Source
  enquiry_source: EnquirySource | null;
  // HireHop status (separate from pipeline_status)
  hh_status: number | null;
  // Metadata
  notes: string | null;
  tags: string[];
  files: FileAttachment[];
  is_deleted: boolean;
  created_by: string;
  created_at: string;
  updated_at: string;
}

export interface Interaction {
  id: string;
  type: 'note' | 'email' | 'call' | 'meeting' | 'mention' | 'chase' | 'status_transition';
  content: string;
  person_id: string | null;
  organisation_id: string | null;
  job_id: string | null;
  opportunity_id: string | null;
  venue_id: string | null;
  mentioned_user_ids: string[];
  files: FileAttachment[];
  // Chase-specific
  chase_method: ChaseMethod | null;
  chase_response: string | null;
  // Status snapshots
  pipeline_status_at_creation: PipelineStatus | null;
  job_status_at_creation: number | null;
  job_status_name_at_creation: string | null;
  // Metadata
  created_by: string;
  created_at: string;
}

export interface UserPreferences {
  muted_job_ids?: string[];
  notifications_paused_until?: string | null;
  [key: string]: unknown;
}

export interface User {
  id: string;
  person_id: string;
  email: string;
  role: 'admin' | 'manager' | 'staff' | 'general_assistant' | 'weekend_manager';
  is_active: boolean;
  last_login: string | null;
  preferences: UserPreferences;
  created_at: string;
  updated_at: string;
}

export interface Notification {
  id: string;
  user_id: string;
  type: string;
  title: string;
  content: string | null;
  entity_type: string | null;
  entity_id: string | null;
  is_read: boolean;
  read_at: string | null;
  created_at: string;
}

export interface ExternalIdMapping {
  id: string;
  entity_type: string;
  entity_id: string;
  external_system: 'hirehop' | 'xero' | 'stripe' | 'traccar';
  external_id: string;
  synced_at: string;
  created_at: string;
}

export interface PicklistItem {
  id: string;
  category: string;
  value: string;
  label: string;
  sort_order: number;
  is_active: boolean;
  created_at: string;
}

// API response wrappers
export interface PaginatedResponse<T> {
  data: T[];
  pagination: {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
  };
}

export interface AuthResponse {
  user: Pick<User, 'id' | 'email' | 'role'> & {
    first_name: string;
    last_name: string;
  };
  accessToken: string;
  refreshToken: string;
}
