/**
 * Traccar's nightly housekeeping (docs/TRACCAR-POSTGRES.md):
 *
 *   1. Delete GPS positions older than 12 months — Traccar has no setting for
 *      this; its own docs do it with a scheduled delete. Each van's current
 *      position (tc_devices.positionid / motionpositionid) is never deleted.
 *   2. pg_dump the Traccar database (live — no Traccar downtime) and upload it
 *      to R2 under backups/traccar/, in parts (it is ~1GB).
 *   3. Keep the 7 newest dumps plus the newest of each of the 4 weeks before
 *      them; delete the rest.
 *
 * Off unless TRACCAR_DATABASE_URL is set (the Traccar database's own login,
 * never OP's). Can be run by hand: npx tsx src/scripts/traccar-backup.ts
 *
 * The dumps end in `.dump` and live under backups/traccar/ — OP's own
 * retention sweep only touches `.sql.gz`, so the two never cross.
 */
import { spawn } from 'child_process';
import { stat, unlink } from 'fs/promises';
import { tmpdir } from 'os';
import path from 'path';
import dotenv from 'dotenv';
import { Client } from 'pg';
import { uploadFileToR2, listR2Objects, deleteFromR2, isR2Configured } from '../config/r2';

dotenv.config({ quiet: true });

export const TRACCAR_BACKUP_PREFIX = 'backups/traccar/';
export const TRACCAR_HISTORY_MONTHS = 12;
const KEEP_NEWEST = 7;
const KEEP_WEEKS = 4;

export function isTraccarHousekeepingConfigured(): boolean {
  return !!process.env.TRACCAR_DATABASE_URL && isR2Configured();
}

// ── Retention (pure) ─────────────────────────────────────────────────────

export interface DumpEntry { key: string; at: Date }

/** Monday (UTC) of the week a date falls in, as YYYY-MM-DD. */
function weekOf(d: Date): string {
  const day = (d.getUTCDay() + 6) % 7; // Mon = 0
  const monday = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - day));
  return monday.toISOString().slice(0, 10);
}

/**
 * Which dumps to delete: keep the KEEP_NEWEST newest, then the newest dump of
 * each of the next KEEP_WEEKS distinct weeks; everything older goes.
 */
export function planTraccarRetention(dumps: DumpEntry[]): string[] {
  const sorted = [...dumps].sort((a, b) => b.at.getTime() - a.at.getTime());
  const keep = new Set(sorted.slice(0, KEEP_NEWEST).map(d => d.key));
  const keptWeeks = new Set(sorted.slice(0, KEEP_NEWEST).map(d => weekOf(d.at)));
  const extraWeeks = new Set<string>();
  for (const d of sorted.slice(KEEP_NEWEST)) {
    const w = weekOf(d.at);
    if (keptWeeks.has(w) || extraWeeks.has(w)) continue;
    if (extraWeeks.size >= KEEP_WEEKS) break;
    extraWeeks.add(w);
    keep.add(d.key);
  }
  return sorted.filter(d => !keep.has(d.key)).map(d => d.key);
}

// ── 1. Purge ─────────────────────────────────────────────────────────────

/** Delete positions older than TRACCAR_HISTORY_MONTHS, device by device, 10k at a time. */
export async function purgeOldTraccarPositions(): Promise<number> {
  const client = new Client({ connectionString: process.env.TRACCAR_DATABASE_URL });
  await client.connect();
  let total = 0;
  try {
    const devices = await client.query('SELECT id FROM tc_devices');
    for (const { id } of devices.rows) {
      // Uses Traccar's (deviceid, fixtime) index. fixtime is stored as UTC.
      for (;;) {
        const res = await client.query(
          `DELETE FROM tc_positions WHERE id IN (
             SELECT p.id FROM tc_positions p
              WHERE p.deviceid = $1
                AND p.fixtime < (NOW() AT TIME ZONE 'UTC') - make_interval(months => $2)
                AND p.id NOT IN (
                  SELECT positionid FROM tc_devices WHERE positionid IS NOT NULL
                  UNION
                  SELECT motionpositionid FROM tc_devices WHERE motionpositionid IS NOT NULL)
              LIMIT 10000)`,
          [id, TRACCAR_HISTORY_MONTHS],
        );
        total += res.rowCount || 0;
        if (!res.rowCount) break;
      }
    }
  } finally {
    await client.end();
  }
  return total;
}

// ── 2. Dump + upload ─────────────────────────────────────────────────────

function pgDump(url: string, outFile: string): Promise<void> {
  return new Promise((resolve, reject) => {
    // Custom format (-Fc) is compressed and restores with pg_restore.
    // The password goes in the environment, not on the command line, where `ps` would show it.
    const u = new URL(url);
    const password = decodeURIComponent(u.password);
    u.password = '';
    const p = spawn('pg_dump', ['-Fc', '--no-owner', '-f', outFile, u.toString()], {
      stdio: ['ignore', 'ignore', 'pipe'],
      env: { ...process.env, PGPASSWORD: password },
    });
    let err = '';
    p.stderr.on('data', (d) => { err += d.toString(); });
    p.on('error', reject);
    p.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`pg_dump exited ${code}: ${err.trim()}`))));
  });
}

export interface TraccarHousekeepingResult {
  purged: number;
  key: string;
  bytes: number;
  deleted: string[];
}

export async function runTraccarHousekeeping(): Promise<TraccarHousekeepingResult> {
  const url = process.env.TRACCAR_DATABASE_URL;
  if (!url) throw new Error('TRACCAR_DATABASE_URL is not set');

  const purged = await purgeOldTraccarPositions();

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const file = path.join(tmpdir(), `traccar-${stamp}.dump`);
  const key = `${TRACCAR_BACKUP_PREFIX}traccar-${stamp}.dump`;
  let bytes = 0;
  try {
    await pgDump(url, file);
    const { size } = await stat(file);
    // An empty or tiny dump means something went wrong — never let it rotate good ones out.
    if (size < 1024 * 1024) throw new Error(`Traccar dump is only ${size} bytes — not uploading`);
    bytes = await uploadFileToR2(key, file, 'application/octet-stream');
  } finally {
    await unlink(file).catch(() => {});
  }

  const listed = await listR2Objects(TRACCAR_BACKUP_PREFIX);
  const dumps: DumpEntry[] = listed
    .filter(o => o.Key?.endsWith('.dump') && o.LastModified)
    .map(o => ({ key: o.Key as string, at: o.LastModified as Date }));
  const deleted = planTraccarRetention(dumps);
  for (const k of deleted) await deleteFromR2(k);

  return { purged, key, bytes, deleted };
}

if (require.main === module) {
  runTraccarHousekeeping()
    .then((r) => {
      console.log(`Traccar housekeeping: purged ${r.purged} positions, uploaded ${r.key} (${Math.round(r.bytes / 1048576)}MB), removed ${r.deleted.length} old dump(s)`);
      process.exit(0);
    })
    .catch((err) => {
      console.error('Traccar housekeeping failed:', err);
      process.exit(1);
    });
}
