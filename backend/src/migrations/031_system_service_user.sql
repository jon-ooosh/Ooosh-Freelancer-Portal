-- Migration 031: Add system service user for API key authentication
--
-- The hire form API uses API key auth (from Netlify functions).
-- When authenticated via API key, created_by is set to the system service user UUID.
-- Without this user in the users table, the FK constraint on vehicle_hire_assignments.created_by fails.

INSERT INTO users (id, email, first_name, last_name, password_hash, role, is_active)
VALUES (
  '00000000-0000-0000-0000-000000000000',
  'system@oooshtours.co.uk',
  'System',
  'Service',
  -- Not a real password hash — this account cannot be logged into
  '$2b$12$000000000000000000000000000000000000000000000000000000',
  'admin',
  true
)
ON CONFLICT (id) DO NOTHING;
