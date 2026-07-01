import { Pool } from 'pg';
import dotenv from 'dotenv';

dotenv.config({ quiet: true });

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 20,
  idleTimeoutMillis: 30000,
  // 10s, not 2s: under brief contention (e.g. two simultaneous book-outs
  // firing post-hooks while server-side PDF builds occupy the event loop —
  // observed 10 Jun 2026, "timeout exceeded when trying to connect" from
  // vehicle-requirement-sync), waiters should queue rather than error.
  // Still bounded so a genuinely wedged pool surfaces as failures.
  connectionTimeoutMillis: 10000,
});

pool.on('error', (err) => {
  console.error('Unexpected database pool error:', err);
  process.exit(1);
});

export async function query(text: string, params?: unknown[]) {
  const start = Date.now();
  const result = await pool.query(text, params);
  const duration = Date.now() - start;

  if (duration > 200) {
    console.warn(`Slow query (${duration}ms):`, text.substring(0, 100));
  }

  return result;
}

export async function getClient() {
  const client = await pool.connect();
  return client;
}

export async function testConnection(): Promise<boolean> {
  try {
    await pool.query('SELECT NOW()');
    return true;
  } catch {
    return false;
  }
}

export function getPool() {
  return pool;
}

export default pool;
