-- Create the system "Ooosh Staff" person for local D&C assignments
-- This person represents generic Ooosh team members on the freelancer portal
INSERT INTO people (
  id, first_name, last_name, email, mobile, tags,
  is_freelancer, is_approved, created_by
) VALUES (
  '00000000-0000-0000-0000-000000000001',
  'Ooosh', 'Staff',
  'info@oooshtours.co.uk',
  NULL,
  ARRAY['system_account'],
  true, true,
  'system'
) ON CONFLICT (id) DO NOTHING;
