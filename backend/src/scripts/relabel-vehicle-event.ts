/**
 * Relabel the HireHop job number on a single vehicle event in R2.
 *
 * Vehicle events live in R2, not Postgres:
 *   - full event JSON:  vehicle-events/{REG}/{eventId}.json   (field `hireHopJob`)
 *   - per-vehicle index: vehicle-events/{REG}/_index.json      (entry `hireHopJob`)
 * Both carry the job number, so a relabel has to touch both or the History
 * list and the event detail disagree.
 *
 * Why this exists: a check-in resolves the hire from the van's most-recent
 * book-out EVENT. When a book-out flips the assignment status but its history
 * event never lands, the check-in grabs a stale book-out from a previous hire
 * and stamps the check-in card against the wrong job. RX73TBZ, Jun 2026: the
 * Unpeople return (job 16149, mileage 100,246) was recorded as a Check In
 * against the prior Ritchie Prior hire (job 16057). This relabels that card
 * back to the truth — we keep the event (it IS the real return), just fix its
 * job number. (The PATCH/check-in code fixes prevent it recurring.)
 *
 * Usage:
 *   cd backend
 *   # dry-run, find the card by reg + type + date:
 *   npx tsx src/scripts/relabel-vehicle-event.ts --reg=RX73TBZ --type="Check In" --date=2026-06-23 --to=16149
 *   # or target an exact event id:
 *   npx tsx src/scripts/relabel-vehicle-event.ts --reg=RX73TBZ --event=<uuid> --to=16149
 *   # apply:
 *   npx tsx src/scripts/relabel-vehicle-event.ts --reg=RX73TBZ --type="Check In" --date=2026-06-23 --to=16149 --commit
 */

import dotenv from 'dotenv';
import { getFromR2, uploadToR2 } from '../config/r2';

dotenv.config();

const arg = (name: string): string | undefined =>
  process.argv.find(a => a.startsWith(`--${name}=`))?.split('=').slice(1).join('=');

const commit = process.argv.includes('--commit');
const reg = arg('reg')?.toUpperCase();
const eventId = arg('event');
const typeFilter = arg('type');           // e.g. "Check In"
const dateFilter = arg('date');           // YYYY-MM-DD prefix match on eventDate
const toRaw = arg('to');                  // new HH job number

interface IndexEntry {
  id: string;
  vehicleReg: string;
  eventType: string;
  eventDate: string;
  mileage: number | null;
  fuelLevel: string | null;
  hireHopJob: number | string | null;
  hireStatus: string | null;
  createdAt: string;
}

async function readR2Json<T>(key: string): Promise<T | null> {
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

async function writeR2Json(key: string, data: unknown): Promise<void> {
  await uploadToR2(key, Buffer.from(JSON.stringify(data)), 'application/json');
}

async function main() {
  if (!reg || !toRaw) {
    console.error('Required: --reg=<REG> --to=<newHHJobNumber>');
    console.error('Plus EITHER --event=<id> OR --type=<...> --date=YYYY-MM-DD');
    process.exit(1);
  }
  const newJob = Number(toRaw);
  if (!Number.isInteger(newJob)) {
    console.error(`--to must be an integer job number, got "${toRaw}"`);
    process.exit(1);
  }

  console.log(`Mode: ${commit ? 'COMMIT (will write to R2)' : 'DRY RUN (no changes)'}`);
  console.log(`Vehicle: ${reg}\n`);

  const indexKey = `vehicle-events/${reg}/_index.json`;
  const index = await readR2Json<{ events: IndexEntry[] }>(indexKey);
  if (!index || !Array.isArray(index.events)) {
    console.error(`No event index found at ${indexKey}`);
    process.exit(1);
  }

  // Resolve which event to relabel.
  let target: IndexEntry | undefined;
  if (eventId) {
    target = index.events.find(e => e.id === eventId);
  } else {
    const matches = index.events.filter(e =>
      (!typeFilter || e.eventType.toLowerCase() === typeFilter.toLowerCase()) &&
      (!dateFilter || String(e.eventDate).startsWith(dateFilter)),
    );
    if (matches.length > 1) {
      console.error(`Ambiguous: ${matches.length} events match. Narrow with --event=<id>:`);
      for (const m of matches) {
        console.error(`  ${m.id}  ${m.eventType}  ${m.eventDate}  mileage=${m.mileage}  job=${m.hireHopJob}`);
      }
      process.exit(1);
    }
    target = matches[0];
  }

  if (!target) {
    console.error('No matching event found.');
    process.exit(1);
  }

  console.log('Target event:');
  console.log(`  id:        ${target.id}`);
  console.log(`  type:      ${target.eventType}`);
  console.log(`  date:      ${target.eventDate}`);
  console.log(`  mileage:   ${target.mileage}`);
  console.log(`  job (now): ${target.hireHopJob}`);
  console.log(`  job (new): ${newJob}\n`);

  if (String(target.hireHopJob) === String(newJob)) {
    console.log('Already labelled with that job — nothing to do.');
    return;
  }

  if (!commit) {
    console.log('DRY RUN — would update both the event JSON and the index entry.');
    console.log('Re-run with --commit to apply.');
    return;
  }

  // 1. Full event JSON
  const eventKey = `vehicle-events/${reg}/${target.id}.json`;
  const fullEvent = await readR2Json<Record<string, unknown>>(eventKey);
  if (!fullEvent) {
    console.error(`Event JSON missing at ${eventKey} — aborting (index would diverge).`);
    process.exit(1);
  }
  const prevEventJob = fullEvent.hireHopJob;
  fullEvent.hireHopJob = newJob;
  await writeR2Json(eventKey, fullEvent);
  console.log(`✓ event JSON ${eventKey}: hireHopJob ${prevEventJob} → ${newJob}`);

  // 2. Index entry
  const idx = index.events.findIndex(e => e.id === target!.id);
  index.events[idx]!.hireHopJob = newJob;
  await writeR2Json(indexKey, index);
  console.log(`✓ index ${indexKey}: entry ${target.id} hireHopJob → ${newJob}`);

  console.log('\nDone. Reload the vehicle History → Events to confirm.');
}

main().catch(err => {
  console.error('Failed:', err);
  process.exit(1);
});
