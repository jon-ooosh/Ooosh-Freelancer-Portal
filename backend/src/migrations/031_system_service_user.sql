-- Migration 031: Add system service user for API key authentication
--
-- The hire form API uses API key auth (from Netlify functions).
-- When authenticated via API key, created_by is set to the system service user UUID.
-- Without this user in the users table, the FK constraint on vehicle_hire_assignments.created_by fails.
--
-- The users table requires a person_id FK to people, so we create both.

-- Create the system person record
INSERT INTO people (id, first_name, last_name, email, notes)
VALUES (
  '00000000-0000-0000-0000-000000000000',
  'System',
  'Service',
  'system@oooshtours.co.uk',
  'System service account for API key authentication. Do not delete.'
)
ON CONFLICT (id) DO NOTHING;

-- Create the system user record linked to the person
INSERT INTO users (id, person_id, email, password_hash, role, is_active)
VALUES (
  '00000000-0000-0000-0000-000000000000',
  '00000000-0000-0000-0000-000000000000',
  'system@oooshtours.co.uk',
  -- Not a real bcrypt hash — this account cannot be logged into
  '$2b$12$000000000000000000000uxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
  'admin',
  true
)
ON CONFLICT (id) DO NOTHING;
