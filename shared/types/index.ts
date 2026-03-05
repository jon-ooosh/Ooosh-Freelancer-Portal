// ============================================================================
// Shared types between frontend and backend
// These mirror the database schema from migration 001
// ============================================================================

export interface Person {
  id: string;
  first_name: string;
  last_name: string;
  email: string | null;
  phone: string | null;
  mobile: string | null;
  notes: string | null;
  tags: string[];
  preferred_contact_method: string;
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
  notes: string | null;
  tags: string[];
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
  address: string | null;
  city: string | null;
  postcode: string | null;
  country: string | null;
  latitude: number | null;
  longitude: number | null;
  loading_bay_info: string | null;
  access_codes: string | null;
  parking_info: string | null;
  approach_notes: string | null;
  general_notes: string | null;
  tags: string[];
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
  created_by: string;
  created_at: string;
}

export interface User {
  id: string;
  person_id: string;
  email: string;
  role: 'admin' | 'manager' | 'staff' | 'warehouse' | 'driver' | 'freelancer' | 'client';
  is_active: boolean;
  last_login: string | null;
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
