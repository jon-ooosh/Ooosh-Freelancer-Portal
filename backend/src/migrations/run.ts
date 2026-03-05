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
        // Add future migrations here in order
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
          DROP TABLE IF EXISTS notifications CASCADE;
          DROP TABLE IF EXISTS audit_log CASCADE;
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
