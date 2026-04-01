import { readFileSync } from 'fs';
import { join } from 'path';
import { Pool } from 'pg';
import dotenv from 'dotenv';

dotenv.config();

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

async function runMigrations(direction: 'up' | 'down') {
  const client = await pool.connect();

  try {
    // Create migrations tracking table if it doesn't exist
    await client.query(`
      CREATE TABLE IF NOT EXISTS _migrations (
        id SERIAL PRIMARY KEY,
        name VARCHAR(500) NOT NULL UNIQUE,
        applied_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    if (direction === 'up') {
      // Get already-applied migrations
      const applied = await client.query('SELECT name FROM _migrations ORDER BY id');
      const appliedNames = new Set(applied.rows.map((r) => r.name));

      // Read migration files in order
      const migrations = [
        '001_foundation.sql',
        '002_jobs.sql',
        '003_job_status_tracking.sql',
        '004_pipeline.sql',
        '005_fix_interaction_types.sql',
        '006_merge_quoting.sql',
        '007_calculator.sql',
        '008_quote_status_assignments.sql',
        '009_fix_sync_log_permissions.sql',
        '010_freelancer_fields.sql',
        '011_fleet_vehicles.sql',
        '012_vehicle_service_log.sql',
        '013_fleet_v5_fields.sql',
        '014_vehicle_maintenance_compliance.sql',
        '015_vehicle_details_extended.sql',
        '016_email_log.sql',
        '017_driver_hire_excess.sql',
        '018_webhook_log.sql',
        '019_driver_files.sql',
        '020_driver_hire_form_fields.sql',
        '021_job_requirements.sql',
        '022_roles_and_optimistic_locking.sql',
        '022_fix_audit_log_permissions.sql',
        '023_user_profiles.sql',
        '024_transport_crew_ops.sql',
        '024_hire_form_pdf.sql',
        '025_portal_password.sql',
        '026_fix_calculation_mode.sql',
        '027_organisation_relationships.sql',
        '028_hh_user_mapping.sql',
        '029_nullable_vehicle_id.sql',
        '030_sync_review_queue.sql',
        '031_system_service_user.sql',
        '032_fix_audit_log_action_constraint.sql',
        '033_address_book_enhancements.sql',
        '033_job_line_items.sql',
        '034_vehicle_swap.sql',
        '034_crewed_jobs_enhancements.sql',
        '034_excess_enhancements.sql',
        '035_job_payments.sql',
        '036_ooosh_staff_person.sql',
        '037_excess_nullable_assignment.sql',
        '038_excess_status_revisions.sql',
        '039_excess_hh_deposit_reconciliation.sql',
      ];

      for (const migration of migrations) {
        if (appliedNames.has(migration)) {
          console.log(`Skipping (already applied): ${migration}`);
          continue;
        }

        console.log(`Applying: ${migration}`);
        const sql = readFileSync(join(__dirname, migration), 'utf-8');

        await client.query('BEGIN');
        try {
          await client.query(sql);
          await client.query('INSERT INTO _migrations (name) VALUES ($1)', [migration]);
          await client.query('COMMIT');
          console.log(`Applied: ${migration}`);
        } catch (err) {
          await client.query('ROLLBACK');
          console.error(`Failed to apply ${migration}:`, err);
          throw err;
        }
      }

      console.log('All migrations applied.');
    } else {
      // Down: drop all tables (development only!)
      console.log('WARNING: Dropping all platform tables. This is irreversible.');
      await client.query('BEGIN');
      try {
        await client.query(`
          DROP TABLE IF EXISTS quote_assignments CASCADE;
          DROP TABLE IF EXISTS quotes CASCADE;
          DROP TABLE IF EXISTS sync_log CASCADE;
          DROP TABLE IF EXISTS notifications CASCADE;
          DROP TABLE IF EXISTS audit_log CASCADE;
          DROP TABLE IF EXISTS jobs CASCADE;
          DROP TABLE IF EXISTS interactions CASCADE;
          DROP TABLE IF EXISTS external_id_map CASCADE;
          DROP TABLE IF EXISTS picklist_items CASCADE;
          DROP TABLE IF EXISTS users CASCADE;
          DROP TABLE IF EXISTS person_organisation_roles CASCADE;
          DROP TABLE IF EXISTS venues CASCADE;
          DROP TABLE IF EXISTS organisations CASCADE;
          DROP TABLE IF EXISTS people CASCADE;
          DROP TABLE IF EXISTS _migrations CASCADE;
        `);
        await client.query('COMMIT');
        console.log('All tables dropped.');
      } catch (err) {
        await client.query('ROLLBACK');
        console.error('Failed to drop tables:', err);
        throw err;
      }
    }
  } finally {
    client.release();
    await pool.end();
  }
}

const direction = process.argv[2] as 'up' | 'down';
if (!direction || !['up', 'down'].includes(direction)) {
  console.error('Usage: tsx run.ts [up|down]');
  process.exit(1);
}

runMigrations(direction).catch((err) => {
  console.error('Migration failed:', err);
  process.exit(1);
});
