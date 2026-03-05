import { Pool } from 'pg';
import bcrypt from 'bcryptjs';
import dotenv from 'dotenv';

dotenv.config();

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

async function seed() {
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    console.log('Seeding demo data...');

    // Create admin person + user
    const adminPerson = await client.query(
      `INSERT INTO people (first_name, last_name, email, created_by)
       VALUES ('Admin', 'User', 'admin@ooosh.co.uk', 'seed')
       RETURNING id`
    );

    const passwordHash = await bcrypt.hash('admin12345', 12);
    await client.query(
      `INSERT INTO users (person_id, email, password_hash, role)
       VALUES ($1, 'admin@ooosh.co.uk', $2, 'admin')`,
      [adminPerson.rows[0].id, passwordHash]
    );

    // Create some demo organisations
    const bandA = await client.query(
      `INSERT INTO organisations (name, type, created_by)
       VALUES ('The Rolling Tones', 'band', 'seed') RETURNING id`
    );

    const mgmtA = await client.query(
      `INSERT INTO organisations (name, type, website, created_by)
       VALUES ('Rocksteady Management', 'management', 'https://rocksteady.example.com', 'seed') RETURNING id`
    );

    const festivalA = await client.query(
      `INSERT INTO organisations (name, type, created_by)
       VALUES ('Glastonfield Festival', 'festival', 'seed') RETURNING id`
    );

    const labelA = await client.query(
      `INSERT INTO organisations (name, type, created_by)
       VALUES ('Indie Records Ltd', 'label', 'seed') RETURNING id`
    );

    // Create demo people with relationships
    const tourManager = await client.query(
      `INSERT INTO people (first_name, last_name, email, mobile, created_by)
       VALUES ('Sarah', 'Jones', 'sarah@rocksteady.example.com', '07700 900001', 'seed') RETURNING id`
    );

    await client.query(
      `INSERT INTO person_organisation_roles (person_id, organisation_id, role, is_primary, start_date)
       VALUES ($1, $2, 'Tour Manager', true, '2024-01-15')`,
      [tourManager.rows[0].id, mgmtA.rows[0].id]
    );

    await client.query(
      `INSERT INTO person_organisation_roles (person_id, organisation_id, role, start_date)
       VALUES ($1, $2, 'Tour Manager', '2024-01-15')`,
      [tourManager.rows[0].id, bandA.rows[0].id]
    );

    const agent = await client.query(
      `INSERT INTO people (first_name, last_name, email, created_by)
       VALUES ('Mike', 'Chen', 'mike@agency.example.com', 'seed') RETURNING id`
    );

    const accountant = await client.query(
      `INSERT INTO people (first_name, last_name, email, created_by)
       VALUES ('Emma', 'Williams', 'emma@accounts.example.com', 'seed') RETURNING id`
    );

    await client.query(
      `INSERT INTO person_organisation_roles (person_id, organisation_id, role, is_primary, start_date)
       VALUES ($1, $2, 'Accountant', true, '2023-06-01')`,
      [accountant.rows[0].id, labelA.rows[0].id]
    );

    const siteContact = await client.query(
      `INSERT INTO people (first_name, last_name, email, mobile, created_by)
       VALUES ('Dave', 'Thompson', 'dave@glastonfield.example.com', '07700 900002', 'seed') RETURNING id`
    );

    await client.query(
      `INSERT INTO person_organisation_roles (person_id, organisation_id, role, is_primary, start_date)
       VALUES ($1, $2, 'Site Contact', true, '2022-03-01')`,
      [siteContact.rows[0].id, festivalA.rows[0].id]
    );

    // Create demo venues
    await client.query(
      `INSERT INTO venues (name, address, city, postcode, country, loading_bay_info, parking_info, approach_notes, created_by)
       VALUES
       ('The O2 Arena', 'Peninsula Square', 'London', 'SE10 0DX', 'UK',
        'Loading bay on the east side. Max height 4.2m. Booking required via venue production.',
        'Production parking available — request permits 48h in advance.',
        'Approach via Blackwall Tunnel. Allow extra time during rush hour.',
        'seed'),
       ('Manchester Arena', 'Victoria Station', 'Manchester', 'M3 1AR', 'UK',
        'Loading dock off Trinity Way. 24hr access during show days.',
        'Limited crew parking. NCP on Deansgate is closest.',
        'Sat nav to M3 1AR, then follow production signs.',
        'seed'),
       ('Worthy Farm', 'Pilton', 'Glastonbury', 'BA4 4BY', 'UK',
        'Multiple loading points. Coordinate with site production for gate allocation.',
        'Crew parking in designated fields. Vehicle pass required.',
        'A361 from Shepton Mallet. Expect delays during build week.',
        'seed')`
    );

    // Create some demo interactions
    await client.query(
      `INSERT INTO interactions (type, content, person_id, created_by)
       VALUES
       ('note', 'Sarah confirmed she''ll be touring with The Rolling Tones again this summer. Looking at June/July dates for van hire + backline.', $1, $2),
       ('call', 'Quick call with Sarah — they''re looking at 2x Sprinters + full backline for a 3-week UK tour. Budget around £8k. Sending quote today.', $1, $2),
       ('note', 'Glastonfield site contacts updated for 2026. Dave Thompson still main production contact.', $3, $2)`,
      [tourManager.rows[0].id, adminPerson.rows[0].id, siteContact.rows[0].id]
    );

    await client.query('COMMIT');
    console.log('Seed data created successfully.');
    console.log('');
    console.log('Demo login:');
    console.log('  Email: admin@ooosh.co.uk');
    console.log('  Password: admin12345');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Seed failed:', err);
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
}

seed().catch((err) => {
  console.error(err);
  process.exit(1);
});
