-- Migration 022: Fix audit_log table permissions
-- Same pattern as 009 (sync_log permissions fix).
-- The audit_log table may have been created by a different database user (e.g. postgres)
-- which prevents the app user from querying it.

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'audit_log') THEN
    EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON audit_log TO ' || current_user;
    RAISE NOTICE 'Granted permissions on audit_log to %', current_user;
  END IF;
EXCEPTION
  WHEN insufficient_privilege THEN
    RAISE NOTICE 'Could not grant permissions on audit_log - may need superuser to run: GRANT ALL ON audit_log TO ooosh;';
END
$$;
