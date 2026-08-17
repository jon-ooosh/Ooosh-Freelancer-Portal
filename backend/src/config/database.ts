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

// A pooled connection can be severed for reasons that say nothing about the
// health of the pool as a whole. The common one is Postgres restarting under us
// during a package upgrade — every idle client gets FATAL 57P01 ("terminating
// connection due to administrator command"). `pg` discards the dead client and
// opens a fresh one on the next query, so this is recoverable by design.
//
// This used to call process.exit(1), which turned that self-healing blip into a
// real (if brief) outage — twice in the week of 11-17 Aug 2026, both times off
// the back of routine unattended-upgrades. It also made us FRAGILE rather than
// safe: with Restart=on-failure + StartLimitBurst=3/60s, a Postgres outage
// lasting more than a minute would crash-loop us past the burst limit and leave
// the API permanently dead, needing a human. Staying up means we recover on our
// own the moment the database is back.
//
// Not exiting also matches the process-level guards in index.ts, which
// deliberately keep the API alive on uncaught exceptions and unhandled
// rejections: "A genuinely unrecoverable state would be caught by systemd's
// health, not by us crashing." A genuinely dead database still surfaces — every
// query rejects, and GET /api/health returns 503 via testConnection().
//
// Logged as message + code rather than the whole error: pg attaches the entire
// Client object (connection params, timers, socket state), which buried the one
// informative line under ~90 lines of journal noise.
let poolErrorCount = 0;
pool.on('error', (err) => {
  poolErrorCount += 1;
  const code = (err as { code?: string }).code;
  console.error(
    `Database pool error #${poolErrorCount} (process kept alive)${code ? ` [${code}]` : ''}: ${err.message}`
  );
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
