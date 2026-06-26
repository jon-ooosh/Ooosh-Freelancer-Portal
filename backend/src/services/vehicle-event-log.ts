/**
 * vehicle-event-log — write entries to a vehicle's R2 Event History from
 * server-side flows that aren't the interactive save-event route.
 *
 * First consumer: the vehicle swap endpoint, which soft-checks-in the van
 * being swapped OUT. Before this, the swap recorded the soft check-in only as
 * fleet status (Not Ready) + a mileage-log row + the linked Job Issue — the
 * van's own Event History had no entry, so there was nothing to regenerate an
 * Interim Assessment PDF from. Writing a `soft-check-in` event here puts the
 * interim assessment on the van's timeline AND makes the existing
 * `POST /vehicles/events/:id/regenerate-pdf` produce the Interim Assessment
 * PDF on demand (it derives `isInterim` from the `soft-check-in` eventType and
 * parses the `details` blob below — see routes/vehicles.ts).
 *
 * R2 shape mirrors the save-event route exactly: a per-event JSON blob plus an
 * entry appended to the per-vehicle `_index.json`. readR2Json/writeR2Json are
 * inlined here, matching the existing duplication pattern across the codebase
 * (routes/vehicles.ts, services/vehicle-forecast.ts, scripts/*).
 */

import { randomUUID } from 'crypto';
import { getFromR2, uploadToR2 } from '../config/r2';

async function readR2Json<T>(key: string): Promise<T | null> {
  try {
    const resp = await getFromR2(key);
    if (!resp.Body) return null;
    const text = await resp.Body.transformToString('utf-8');
    return JSON.parse(text) as T;
  } catch (err: unknown) {
    const code = (err as { name?: string })?.name;
    if (code === 'NoSuchKey') return null;
    throw err;
  }
}

async function writeR2Json(key: string, data: unknown): Promise<void> {
  await uploadToR2(key, Buffer.from(JSON.stringify(data)), 'application/json');
}

export interface SoftCheckInEventInput {
  reg: string;
  hhJob: number | null;
  mileage?: number | null;
  fuelLevel?: string | null;
  location?: string | null;
  notes?: string | null;
  /** Driver name(s) on the swapped-out van, for the PDF header. */
  driverName?: string | null;
  /** The reg the hire moved TO (for context on the assessment). */
  toReg?: string | null;
  /** Combined reason code + details, e.g. "Breakdown: brake fault on the M6". */
  swapReason?: string | null;
}

/**
 * Record an interim ("soft check-in") assessment on a vehicle's Event History.
 * Best-effort by design — callers should treat a throw as non-fatal (the swap's
 * durable record is the Job Issue + fleet status + mileage log). Returns the new
 * event id on success.
 */
export async function recordSoftCheckInEvent(input: SoftCheckInEventInput): Promise<string | null> {
  const reg = input.reg.trim().toUpperCase();
  if (!reg) return null;

  const id = randomUUID();
  const now = new Date().toISOString();

  // The PDF/regen path parses `details` for "Driver:" and "Notes:" lines, so
  // keep that shape and add the swap context lines around it.
  const detailLines = [
    `Driver: ${input.driverName || 'Not recorded'}`,
    `HireHop Job: ${input.hhJob ?? 'n/a'}`,
    `Interim assessment — vehicle swapped${input.toReg ? ` ${reg} → ${input.toReg}` : ' out'}`,
    input.swapReason ? `Reason: ${input.swapReason}` : null,
    input.location ? `Location: ${input.location}` : null,
    input.fuelLevel ? `Fuel: ${input.fuelLevel}` : null,
    input.notes ? `Notes: ${input.notes}` : null,
  ].filter(Boolean);

  const event = {
    id,
    eventType: 'soft-check-in',
    eventDate: now.slice(0, 10),
    mileage: input.mileage ?? null,
    fuelLevel: input.fuelLevel ?? null,
    hireHopJob: input.hhJob != null ? String(input.hhJob) : null,
    hireStatus: 'Not Ready',
    driverName: input.driverName || null,
    notes: input.notes || null,
    details: detailLines.join('\n'),
    createdAt: now,
  };

  await writeR2Json(`vehicle-events/${reg}/${id}.json`, event);

  const indexKey = `vehicle-events/${reg}/_index.json`;
  const indexData = (await readR2Json<{ events: any[] }>(indexKey)) || { events: [] };
  indexData.events.push({
    id,
    vehicleReg: reg,
    eventType: 'soft-check-in',
    eventDate: event.eventDate,
    mileage: event.mileage,
    fuelLevel: event.fuelLevel,
    hireHopJob: event.hireHopJob,
    hireStatus: 'Not Ready',
    createdAt: now,
  });
  await writeR2Json(indexKey, indexData);

  return id;
}
