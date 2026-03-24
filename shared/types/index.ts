// ============================================================================
// Shared types between frontend and backend
// These mirror the database schema from migration 001
// ============================================================================

// Files attached to any entity (people, organisations, venues, interactions)
// Stored as JSONB array in PostgreSQL
export interface FileAttachment {
  name: string;
  label?: string;
  comment?: string;
  url: string;
  type: 'document' | 'image' | 'other';
  uploaded_at: string;
  uploaded_by: string;
  share_with_freelancer?: boolean;
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
  // Freelancer-specific
  is_freelancer: boolean;
  freelancer_joined_date: string | null;
  freelancer_next_review_date: string | null;
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

// Organisation-to-Organisation relationship types
export type OrgRelationshipType = 'manages' | 'books_for' | 'does_accounts_for' | 'promotes' | 'supplies' | 'represents' | 'other';

// Bidirectional display labels for org relationships
export const ORG_RELATIONSHIP_LABELS: Record<OrgRelationshipType, { forward: string; reverse: string }> = {
  manages: { forward: 'Manages', reverse: 'Managed by' },
  books_for: { forward: 'Books for', reverse: 'Booked by' },
  does_accounts_for: { forward: 'Does accounts for', reverse: 'Accounts done by' },
  promotes: { forward: 'Promotes', reverse: 'Promoted by' },
  supplies: { forward: 'Supplies', reverse: 'Supplied by' },
  represents: { forward: 'Represents', reverse: 'Represented by' },
  other: { forward: 'Related to', reverse: 'Related to' },
};

export interface OrganisationRelationship {
  id: string;
  from_org_id: string;
  to_org_id: string;
  relationship_type: OrgRelationshipType;
  status: 'active' | 'historical';
  start_date: string | null;
  end_date: string | null;
  notes: string | null;
  created_by: string;
  created_at: string;
  updated_at: string;
  // Joined fields for display
  from_org_name?: string;
  from_org_type?: string;
  to_org_name?: string;
  to_org_type?: string;
}

// Job-Organisation link roles
export type JobOrgRole = 'band' | 'client' | 'promoter' | 'venue_operator' | 'management' | 'label' | 'supplier' | 'other';

export const JOB_ORG_ROLE_LABELS: Record<JobOrgRole, string> = {
  band: 'Band',
  client: 'Client',
  promoter: 'Promoter',
  venue_operator: 'Venue Operator',
  management: 'Management',
  label: 'Label',
  supplier: 'Supplier',
  other: 'Other',
};

export interface JobOrganisation {
  id: string;
  job_id: string;
  organisation_id: string;
  role: JobOrgRole;
  is_primary: boolean;
  notes: string | null;
  created_by: string;
  created_at: string;
  updated_at: string;
  // Joined fields for display
  organisation_name?: string;
  organisation_type?: string;
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
  new_enquiry:  { label: 'Enquiries',       colour: '#3B82F6', order: 1 },  // Blue
  quoting:      { label: 'Enquiries',       colour: '#3B82F6', order: 1 },  // Merged into Enquiries
  chasing:      { label: 'Chasing',         colour: '#F59E0B', order: 2 },  // Amber
  provisional:  { label: 'Provisional',     colour: '#EF4444', order: 3 },  // Red
  paused:       { label: 'Paused Enquiry',  colour: '#6B7280', order: 4 },  // Grey
  confirmed:    { label: 'Confirmed',       colour: '#10B981', order: 5 },  // Green
  lost:         { label: 'Lost',            colour: '#374151', order: 6 },  // Dark grey
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
  role: 'admin' | 'manager' | 'staff' | 'general_assistant' | 'weekend_manager' | 'freelancer';
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

// ============================================================================
// Calculator & Quotes
// ============================================================================

export interface CostingSettings {
  freelancer_hourly_day: number;
  freelancer_hourly_night: number;
  client_hourly_day: number;
  client_hourly_night: number;
  driver_day_rate: number;
  admin_cost_per_hour: number;
  fuel_price_per_litre: number;
  handover_time_mins: number;
  unload_time_mins: number;
  expense_markup_percent: number;
  min_hours_threshold: number;
  min_client_charge_floor: number;
  day_rate_client_markup: number;
  fuel_efficiency_mpg: number;
}

export interface CostingSettingRow {
  key: string;
  value: number;
  label: string;
  unit: string;
}

export type QuoteJobType = 'delivery' | 'collection' | 'crewed';
export type QuoteCalcMode = 'hourly' | 'dayrate';
export type QuoteWhatIsIt = 'vehicle' | 'equipment' | 'people';

export interface QuoteExpenseItem {
  id: string;
  category: string;   // fuel, parking, tolls, transport_out, transport_back, hotel, pd, other
  label: string;
  amount: number;
  included: boolean;
  description?: string;
  pdDays?: number;
}

export type QuoteAssignmentStatus = 'assigned' | 'confirmed' | 'declined' | 'completed' | 'cancelled';

export interface QuoteAssignment {
  id: string;
  person_id: string;
  first_name: string;
  last_name: string;
  role: string;
  status: QuoteAssignmentStatus;
  agreed_rate: number | null;
  rate_type: 'hourly' | 'dayrate' | 'fixed' | null;
}

export type QuoteStatusType = 'draft' | 'confirmed' | 'cancelled' | 'completed';

export interface SavedQuote {
  id: string;
  job_id: string | null;
  job_type: QuoteJobType;
  calculation_mode: QuoteCalcMode;
  venue_name: string | null;
  venue_id: string | null;
  distance_miles: number | null;
  drive_time_mins: number | null;
  arrival_time: string | null;
  job_date: string | null;
  job_finish_date: string | null;
  is_multi_day: boolean;
  work_duration_hrs: number | null;
  num_days: number | null;
  what_is_it: QuoteWhatIsIt | null;
  add_collection: boolean;
  collection_date: string | null;
  client_name: string | null;
  work_type: string | null;
  expenses: QuoteExpenseItem[];
  // Calculated
  client_charge_labour: number | null;
  client_charge_fuel: number | null;
  client_charge_expenses: number | null;
  client_charge_total: number | null;
  client_charge_rounded: number;
  freelancer_fee: number | null;
  freelancer_fee_rounded: number;
  expected_fuel_cost: number | null;
  expenses_included: number | null;
  expenses_not_included: number | null;
  our_margin: number;
  our_total_cost: number;
  estimated_time_hrs: number | null;
  // Status
  status: QuoteStatusType;
  status_changed_at: string | null;
  cancelled_reason: string | null;
  // Crew assignments (populated via subquery)
  assignments: QuoteAssignment[];
  // Notes
  internal_notes: string | null;
  freelancer_notes: string | null;
  // Meta
  created_by: string;
  created_by_name: string | null;
  created_at: string;
}

// ============================================================================
// Driver Hire & Excess types
// These mirror the database schema from migration 017
// ============================================================================

export interface LicenceEndorsement {
  code: string;
  points: number;
  date: string | null;
  expiry: string | null;
}

export type InsuranceStatus = 'Approved' | 'Referral' | 'Failed';

export interface Driver {
  id: string;
  person_id: string | null;
  full_name: string;
  email: string | null;
  phone: string | null;
  phone_country: string | null;
  date_of_birth: string | null;
  nationality: string | null;
  address_line1: string | null;
  address_line2: string | null;
  city: string | null;
  postcode: string | null;
  address_full: string | null;
  licence_address: string | null;
  licence_number: string | null;
  licence_type: string | null;
  licence_valid_from: string | null;
  licence_valid_to: string | null;
  licence_issue_country: string;
  licence_issued_by: string | null;
  licence_points: number;
  licence_endorsements: LicenceEndorsement[];
  licence_restrictions: string | null;
  licence_next_check_due: string | null;
  date_passed_test: string | null;
  // Document expiry dates (the validity backbone)
  poa1_valid_until: string | null;
  poa2_valid_until: string | null;
  dvla_valid_until: string | null;
  passport_valid_until: string | null;
  // Document providers (POA diversity check)
  poa1_provider: string | null;
  poa2_provider: string | null;
  // DVLA
  dvla_check_code: string | null;
  dvla_check_date: string | null;
  // Insurance questionnaire
  has_disability: boolean;
  has_convictions: boolean;
  has_prosecution: boolean;
  has_accidents: boolean;
  has_insurance_issues: boolean;
  has_driving_ban: boolean;
  additional_details: string | null;
  insurance_status: InsuranceStatus | null;
  overall_status: string | null;
  // Referral
  requires_referral: boolean;
  referral_status: string | null;
  referral_date: string | null;
  referral_notes: string | null;
  // iDenfy
  idenfy_check_date: string | null;
  idenfy_scan_ref: string | null;
  // Signature
  signature_date: string | null;
  // Metadata
  source: string;
  monday_item_id: string | null;
  files: FileAttachment[] | null;
  is_active: boolean;
  created_at: string;
  updated_at: string;
  created_by: string | null;
}

// Driver document validity analysis (computed, not stored)
export interface DriverDocumentStatus {
  licence: { valid: boolean; expiryDate: string | null };
  poa1: { valid: boolean; expiryDate: string | null; provider: string | null };
  poa2: { valid: boolean; expiryDate: string | null; provider: string | null };
  dvla: { valid: boolean; expiryDate: string | null };
  passport: { valid: boolean; expiryDate: string | null };
  isUkDriver: boolean;
  allValid: boolean;
}

// Response shape for GET /api/drivers/status (matches hire form app expectations)
export interface DriverStatusResponse {
  status: string;
  email: string;
  name: string | null;
  phoneNumber: string | null;
  phoneCountry: string | null;
  dateOfBirth: string | null;
  licenseNumber: string | null;
  licenseEnding: string | null;
  licenseIssuedBy: string | null;
  homeAddress: string | null;
  licenseAddress: string | null;
  nationality: string | null;
  documents: {
    license: { valid: boolean; expiryDate?: string; status: string };
    poa1: { valid: boolean; expiryDate?: string; status: string; provider: string | null };
    poa2: { valid: boolean; expiryDate?: string; status: string; provider: string | null };
    dvlaCheck: { valid: boolean; expiryDate?: string; status: string };
    passportCheck: { valid: boolean; expiryDate?: string; status: string };
  };
  insuranceData: {
    datePassedTest: string;
    hasDisability: boolean;
    hasConvictions: boolean;
    hasProsecution: boolean;
    hasAccidents: boolean;
    hasInsuranceIssues: boolean;
    hasDrivingBan: boolean;
    additionalDetails: string;
  } | null;
  boardAId: string | null;
  licenseNextCheckDue: string | null;
  poa1ValidUntil: string | null;
  poa2ValidUntil: string | null;
  dvlaValidUntil: string | null;
  passportValidUntil: string | null;
  poa1Provider: string | null;
  poa2Provider: string | null;
  dvlaPoints: number;
  dvlaEndorsements: string | null;
  dvlaCalculatedExcess: string | null;
}

export type HireAssignmentType = 'self_drive' | 'driven' | 'delivery' | 'collection';
export type HireAssignmentStatus = 'soft' | 'confirmed' | 'booked_out' | 'active' | 'returned' | 'cancelled';

export interface VehicleHireAssignment {
  id: string;
  vehicle_id: string;
  job_id: string | null;
  hirehop_job_id: number | null;
  hirehop_job_name: string | null;
  driver_id: string | null;
  assignment_type: HireAssignmentType;
  van_requirement_index: number;
  required_type: string | null;
  required_gearbox: string | null;
  status: HireAssignmentStatus;
  status_changed_at: string;
  hire_start: string | null;
  hire_end: string | null;
  start_time: string | null;
  end_time: string | null;
  return_overnight: boolean | null;
  booked_out_at: string | null;
  booked_out_by: string | null;
  mileage_out: number | null;
  fuel_level_out: string | null;
  checked_in_at: string | null;
  checked_in_by: string | null;
  mileage_in: number | null;
  fuel_level_in: string | null;
  has_damage: boolean;
  freelancer_person_id: string | null;
  notes: string | null;
  ve103b_ref: string | null;
  created_at: string;
  updated_at: string;
  created_by: string | null;
  allocated_by_name: string | null;
  // Joined fields (populated via subquery/join)
  vehicle_reg?: string;
  driver_name?: string;
  freelancer_name?: string;
}

export type ExcessStatus = 'not_required' | 'pending' | 'taken' | 'partial' | 'waived' | 'claimed' | 'reimbursed' | 'rolled_over';

export interface JobExcess {
  id: string;
  assignment_id: string;
  job_id: string | null;
  hirehop_job_id: number | null;
  excess_amount_required: number | null;
  excess_amount_taken: number;
  excess_calculation_basis: string | null;
  excess_status: ExcessStatus;
  payment_method: string | null;
  payment_reference: string | null;
  payment_date: string | null;
  xero_contact_id: string | null;
  xero_contact_name: string | null;
  client_name: string | null;
  claim_amount: number | null;
  claim_date: string | null;
  claim_notes: string | null;
  reimbursement_amount: number | null;
  reimbursement_date: string | null;
  reimbursement_method: string | null;
  created_at: string;
  updated_at: string;
  created_by: string | null;
}

export interface ExcessRule {
  id: string;
  rule_type: string;
  condition_min: number | null;
  condition_max: number | null;
  condition_code: string | null;
  excess_amount: number | null;
  requires_referral: boolean;
  description: string | null;
  is_active: boolean;
  sort_order: number;
  updated_at: string;
  updated_by: string | null;
}

export interface ClientExcessLedgerEntry {
  xero_contact_id: string;
  xero_contact_name: string;
  client_name: string;
  total_hires: number;
  total_taken: number;
  total_claimed: number;
  total_reimbursed: number;
  balance_held: number;
  pending_count: number;
  held_count: number;
  rolled_over_count: number;
}

export interface DispatchCheck {
  canDispatch: boolean;
  blockers: DispatchBlocker[];
}

export interface DispatchBlocker {
  type: 'excess_pending' | 'referral_pending';
  assignmentId: string;
  driverName: string | null;
  vehicleReg: string | null;
  amountRequired: number | null;
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
