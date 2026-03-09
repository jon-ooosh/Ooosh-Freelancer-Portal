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

export interface Interaction {
  id: string;
  type: 'note' | 'email' | 'call' | 'meeting' | 'mention';
  content: string;
  person_id: string | null;
  organisation_id: string | null;
  job_id: string | null;
  opportunity_id: string | null;
  venue_id: string | null;
  mentioned_user_ids: string[];
  files: FileAttachment[];
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
