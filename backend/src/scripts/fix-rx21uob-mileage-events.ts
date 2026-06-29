/**
 * One-off fix for a +9,000 mileage typo (a "9" keyed where a "0" belonged).
 *
 * Background (Jun 2026): a prep on RX21UOB recorded 179,283 instead of ~170,283.
 * The upward-only ratchet then carried it forward through the 15647 hire
 * (book-out 179,283 → check-in 179,902), locking the van's mileage ~9,000 miles
 * above reality. The fleet-board figure was corrected to 170,915 by hand, but
 * the bad readings still sit in:
 *   - R2 vehicle-event history (per-event JSON + the per-vehicle _index.json)
 *   - the vehicle_mileage_log table (skews avg/max-mileage stats)
 *
 * This script subtracts the offset from every reading that falls in the typo
 * window, on BOTH stores. Idempotent: once corrected, readings fall out of the
 * window so a second run is a no-op.
 *
 * Detection window is deliberately tight — correct readings are ~170,9xx and
 * next-service-due is 186,000, so the 179,xxx typos sit alone in [175k, 185k).
 * Nothing legitimate is in range.
 *
 * Usage:
 *   cd backend
 *   npx tsx src/scripts/fix-rx21uob-mileage-events.ts                 # dry-run
 *   npx tsx src/scripts/fix-rx21uob-mileage-events.ts --commit        # apply
 *   npx tsx src/scripts/fix-rx21uob-mileage-events.ts --reg=RX21UOB --offset=9000 \
 *       --low=175000 --high=185000 --commit
 */

import { Pool } from 'pg';
import dotenv from 'dotenv';
import { getFromR2, uploadToR2, isR2Configured } from '../config/r2';

dotenv.config();

function arg(name: string, fallback: string): string {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.split('=')[1] : fallback;
}

const commit = process.argv.includes('--commit');
const reg = arg('reg', 'RX21UOB').toUpperCase();
const offset = Number(arg('offset', '9000'));
const low = Number(arg('low', '175000'));
const high = Number(arg('high', '185000'));

/** A value is a typo if it sits in the detection window. */
function inWindow(v: unknown): boolean {
  const n = Number(v);
  return Number.isFinite(n) && n >= low && n < high;
}

async function readJson<T>(key: string): Promise<T | null> {
  try {
    const resp = await getFromR2(key);
    if (!resp.Body) return null;
    const text = await resp.Body.transformToString('utf-8');
    return JSON.parse(text) as T;
  } catch (err: unknown) {
    if ((err as { name?: string })?.name === 'NoSuchKey') return null;
    throw err;
  }
}

async function writeJson(key: string, data: unknown): Promise<void> {
  await uploadToR2(key, Buffer.from(JSON.stringify(data)), 'application/json');
}

/** Fix every mileage-like numeric field on an object that's in the window. */
function fixMileageFields(obj: Record<string, unknown>): string[] {
  const fixed: string[] = [];
  for (const [k, v] of Object.entries(obj)) {
    if (/mileage/i.test(k) && inWindow(v)) {
      const before = Number(v);
      obj[k] = before - offset;
      fixed.push(`${k}: ${before.toLocaleString()} → ${(before - offset).toLocaleString()}`);
    }
  }
  return fixed;
}

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error('DATABASE_URL not set');
    process.exit(1);
  }
  if (!isR2Configured()) {
    console.error('R2 not configured (need R2_ACCOUNT_ID / R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY)');
    process.exit(1);
  }

  console.log(`Mode:   ${commit ? 'COMMIT (will write)' : 'DRY RUN (no changes)'}`);
  console.log(`Reg:    ${reg}`);
  console.log(`Offset: -${offset.toLocaleString()}   Window: [${low.toLocaleString()}, ${high.toLocaleString()})\n`);

  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const client = await pool.connect();
  let r2EventsFixed = 0;

  try {
    // ── 1. R2 event history ──────────────────────────────────────────────
    const indexKey = `vehicle-events/${reg}/_index.json`;
    const index = await readJson<{ events: Array<Record<string, unknown>> }>(indexKey);

    if (!index || !Array.isArray(index.events)) {
      console.log(`R2: no event index at ${indexKey} — skipping event history.`);
    } else {
      console.log(`R2: ${index.events.length} events in index. Scanning…`);
      let indexChanged = false;

      for (const entry of index.events) {
        if (!inWindow(entry.mileage)) continue;
        const id = String(entry.id);
        const eventKey = `vehicle-events/${reg}/${id}.json`;

        // Per-event JSON — the canonical record the UI + delta calcs read.
        const event = await readJson<Record<string, unknown>>(eventKey);
        if (event) {
          const changes = fixMileageFields(event);
          if (changes.length > 0) {
            console.log(`  ${entry.eventType} ${entry.eventDate} (${id})`);
            for (const c of changes) console.log(`     ${c}`);
            if (commit) await writeJson(eventKey, event);
            r2EventsFixed++;
          }
        } else {
          console.log(`  ! per-event JSON missing for ${id} — fixing index entry only`);
        }

        // Index summary entry (mirrors the per-event mileage).
        fixMileageFields(entry);
        indexChanged = true;
      }

      if (indexChanged && commit) await writeJson(indexKey, index);
      console.log(`R2: ${r2EventsFixed} event(s) ${commit ? 'fixed' : 'would be fixed'}.\n`);
    }

    // ── 2. vehicle_mileage_log table ─────────────────────────────────────
    const veh = await client.query('SELECT id FROM fleet_vehicles WHERE reg = $1', [reg]);
    if (veh.rows.length === 0) {
      console.log(`DB: no fleet_vehicles row for ${reg} — skipping mileage log.`);
    } else {
      const vehicleId = veh.rows[0].id as string;
      const rows = await client.query(
        `SELECT id, mileage, source, recorded_at
           FROM vehicle_mileage_log
          WHERE vehicle_id = $1 AND mileage >= $2 AND mileage < $3
          ORDER BY recorded_at`,
        [vehicleId, low, high],
      );

      console.log(`DB: ${rows.rows.length} mileage_log row(s) in window.`);
      for (const r of rows.rows) {
        const before = Number(r.mileage);
        console.log(`  ${r.source} ${new Date(r.recorded_at).toISOString().slice(0, 10)}: ${before.toLocaleString()} → ${(before - offset).toLocaleString()}`);
      }

      if (commit && rows.rows.length > 0) {
        await client.query(
          `UPDATE vehicle_mileage_log
              SET mileage = mileage - $2
            WHERE vehicle_id = $1 AND mileage >= $3 AND mileage < $4`,
          [vehicleId, offset, low, high],
        );
        console.log(`DB: ${rows.rows.length} row(s) updated.`);
      }
    }

    console.log(`\n${commit ? 'Done.' : 'Dry run — re-run with --commit to apply.'}`);
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((err) => {
  console.error('Fix failed:', err);
  process.exit(1);
});
