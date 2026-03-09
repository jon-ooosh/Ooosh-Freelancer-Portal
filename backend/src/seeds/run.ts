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
       VALUES ('Admin', 'User', 'admin@oooshtours.co.uk', 'seed')
       RETURNING id`
    );

    const passwordHash = await bcrypt.hash('admin12345', 12);
    const adminUser = await client.query(
      `INSERT INTO users (person_id, email, password_hash, role)
       VALUES ($1, 'admin@oooshtours.co.uk', $2, 'admin')
       RETURNING id`,
      [adminPerson.rows[0].id, passwordHash]
    );

    // Create some demo organisations
    const bandA = await client.query(
      `INSERT INTO organisations (name, type, location, created_by)
       VALUES ('The Rolling Tones', 'band', 'London', 'seed') RETURNING id`
    );

    const mgmtA = await client.query(
      `INSERT INTO organisations (name, type, website, location, created_by)
       VALUES ('Rocksteady Management', 'management', 'https://rocksteady.example.com', 'London', 'seed') RETURNING id`
    );

    const festivalA = await client.query(
      `INSERT INTO organisations (name, type, location, created_by)
       VALUES ('Glastonfield Festival', 'festival', 'Somerset', 'seed') RETURNING id`
    );

    const labelA = await client.query(
      `INSERT INTO organisations (name, type, location, created_by)
       VALUES ('Indie Records Ltd', 'label', 'London', 'seed') RETURNING id`
    );

    // Create demo people with relationships
    const tourManager = await client.query(
      `INSERT INTO people (first_name, last_name, email, mobile, international_phone, created_by)
       VALUES ('Sarah', 'Jones', 'sarah@rocksteady.example.com', '07700 900001', '+1 555 0123', 'seed') RETURNING id`
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

    // Create a demo freelancer (person with freelancer fields + user account)
    const freelancer = await client.query(
      `INSERT INTO people (
        first_name, last_name, email, mobile, home_address, date_of_birth,
        skills, is_insured_on_vehicles, is_approved, has_tshirt,
        emergency_contact_name, emergency_contact_phone, licence_details,
        created_by
      ) VALUES (
        'Tom', 'Baker', 'tom@example.com', '07700 900003', '42 Driver Lane, London SE1 1AA', '1990-05-15',
        '{driving,backline_tech,stage_hand}', true, true, true,
        'Jane Baker', '07700 900004', 'Cat B+E, expires 2028-11-30',
        'seed'
      ) RETURNING id`
    );

    const freelancerPasswordHash = await bcrypt.hash('freelancer123', 12);
    await client.query(
      `INSERT INTO users (person_id, email, password_hash, role)
       VALUES ($1, 'tom@example.com', $2, 'freelancer')`,
      [freelancer.rows[0].id, freelancerPasswordHash]
    );

    // Create demo venues (with quoting defaults and new fields)
    await client.query(
      `INSERT INTO venues (
        name, address, city, postcode, country,
        w3w_address, load_in_address,
        loading_bay_info, parking_info, approach_notes, technical_notes,
        default_miles_from_base, default_drive_time_mins, default_return_cost,
        created_by
      ) VALUES
       ('The O2 Arena', 'Peninsula Square', 'London', 'SE10 0DX', 'UK',
        'filled.count.soap', 'Loading Bay East, Peninsula Square SE10 0DX',
        'Loading bay on the east side. Max height 4.2m. Booking required via venue production.',
        'Production parking available — request permits 48h in advance.',
        'Approach via Blackwall Tunnel. Allow extra time during rush hour.',
        '3-phase power available. House PA: d&b J-Series. FOH and monitor positions provided.',
        12.5, 35, 85.00,
        'seed'),
       ('Manchester Arena', 'Victoria Station', 'Manchester', 'M3 1AR', 'UK',
        'index.home.raft', 'Loading Dock, Trinity Way, M3 1AR',
        'Loading dock off Trinity Way. 24hr access during show days.',
        'Limited crew parking. NCP on Deansgate is closest.',
        'Sat nav to M3 1AR, then follow production signs.',
        'Full production venue. House PA and lighting rig. Check rider for specifics.',
        210.0, 240, 450.00,
        'seed'),
       ('Worthy Farm', 'Pilton', 'Glastonbury', 'BA4 4BY', 'UK',
        'apple.green.field', 'Gate B, Worthy Farm, Pilton BA4 4BY',
        'Multiple loading points. Coordinate with site production for gate allocation.',
        'Crew parking in designated fields. Vehicle pass required.',
        'A361 from Shepton Mallet. Expect delays during build week.',
        'Outdoor site. Generator power only on most stages. No house PA — everything provided.',
        135.0, 150, 350.00,
        'seed')`
    );

    // Create a second staff user (for @mention testing)
    const staffPerson = await client.query(
      `INSERT INTO people (first_name, last_name, email, created_by)
       VALUES ('Jon', 'Staff', 'jon@oooshtours.co.uk', 'seed')
       RETURNING id`
    );

    const staffPasswordHash = await bcrypt.hash('staff12345', 12);
    await client.query(
      `INSERT INTO users (person_id, email, password_hash, role)
       VALUES ($1, 'jon@oooshtours.co.uk', $2, 'staff')`,
      [staffPerson.rows[0].id, staffPasswordHash]
    );

    // Create some demo interactions
    await client.query(
      `INSERT INTO interactions (type, content, person_id, created_by)
       VALUES
       ('note', 'Sarah confirmed she''ll be touring with The Rolling Tones again this summer. Looking at June/July dates for van hire + backline.', $1, $2),
       ('call', 'Quick call with Sarah — they''re looking at 2x Sprinters + full backline for a 3-week UK tour. Budget around £8k. Sending quote today.', $1, $2),
       ('note', 'Glastonfield site contacts updated for 2026. Dave Thompson still main production contact.', $3, $2)`,
      [tourManager.rows[0].id, adminUser.rows[0].id, siteContact.rows[0].id]
    );

    await client.query('COMMIT');
    console.log('Seed data created successfully.');
    console.log('');
    console.log('Demo login:');
    console.log('  Email: admin@oooshtours.co.uk');
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
