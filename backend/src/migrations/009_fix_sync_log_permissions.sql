-- Migration 009: Fix sync_log table permissions
-- The sync_log table may have been created by a different database user (e.g. postgres)
-- which prevents the app user from reading it during pg_dump backups.

DO $$
BEGIN
  -- Grant permissions to current user on sync_log if the table exists
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'sync_log') THEN
    EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON sync_log TO ' || current_user;
    RAISE NOTICE 'Granted permissions on sync_log to %', current_user;
  END IF;
EXCEPTION
  WHEN insufficient_privilege THEN
    RAISE NOTICE 'Could not grant permissions on sync_log - may need superuser to run: GRANT ALL ON sync_log TO ooosh;';
END
$$;
