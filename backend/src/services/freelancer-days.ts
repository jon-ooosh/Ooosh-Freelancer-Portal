/**
 * Freelancer day bookings — "yard days" (spec §9).
 *
 * Non-staff people booked in to work AT THE YARD for a day. NOT a freelancer
 * driving a delivery, which lives in quote_assignments and is untouched by
 * this: the distinction is whether they are physically in the building, because
 * the only question this feature exists to answer is "have we got enough people
 * in".
 *
 * STRUCTURALLY SEPARATE FROM PHASES A–D AND MUST STAY THAT WAY (§9.1). No
 * ledger account, no working pattern, no entitlement, no holiday, no overtime,
 * no absence. If a future change here needs to import staff-balance.ts, that is
 * the signal something has gone wrong: showing a booked freelancer on a
 * calendar is ordinary operational information, whereas giving them a
 * contracted pattern or accrued leave is what creates employment-status risk.
 *
 * THE LANGUAGE IS LOAD-BEARING. Offered → accepted / declined. Never
 * "rostered", never "assigned", never "shift". A decline is a recorded
 * response, not a penalty, and the rate is agreed per booking rather than set
 * by a schedule. Do not tidy this wording into something more familiar.
 */

import { query } from '../config/database';
import { DATE_RE } from './staff-day-status';

export type DurationType = 'full_day' | 'half_day' | 'hours';
export type RateType = 'day' | 'half_day' | 'hourly' | 'fixed';
export type BookingStatus =
  | 'offered' | 'accepted' | 'declined' | 'cancelled' | 'completed'
  /**
   * Offered, never answered, the day has gone, and a human wrote it off.
   *
   * NOT `declined` — nobody declined anything — and NOT `cancelled`, which is
   * Ooosh calling a day off. Keeping it separate preserves the only signal that
   * says "we asked and heard nothing", which is what you actually want when
   * deciding who to ask next time.
   */
  | 'lapsed';

/** Statuses that occupy the calendar and count toward who is in. */
export const LIVE_STATUSES: BookingStatus[] = ['offered', 'accepted'];

export interface DayBooking {
  id: string;
  personId: string;
  personName: string;
  bookingDate: string;
  startTime: string | null;
  endTime: string | null;
  durationType: DurationType;
  rateType: RateType;
  agreedRate: number | null;
  expectedTotal: number | null;
  status: BookingStatus;
  offeredAt: string;
  respondedAt: string | null;
  responseNote: string | null;
  notes: string | null;
  invoiceReceived: boolean;
  invoiceAmount: number | null;
  invoiceQueried: boolean;
  invoiceQueryNotes: string | null;
  cancellationReason: string | null;
}

const SELECT = `
  SELECT b.*, b.booking_date::text AS booking_date_t,
         b.start_time::text AS start_time_t, b.end_time::text AS end_time_t,
         -- What they go by, matching lib/displayName.ts on the frontend.
         COALESCE(NULLIF(p.preferred_name, ''), p.first_name) AS display_first,
         p.last_name
    FROM freelancer_day_bookings b
    JOIN people p ON p.id = b.person_id`;

function mapRow(r: Record<string, any>): DayBooking {
  return {
    id: r.id,
    personId: r.person_id,
    personName: `${r.display_first ?? ''} ${r.last_name ?? ''}`.trim(),
    bookingDate: r.booking_date_t,
    startTime: r.start_time_t ? String(r.start_time_t).slice(0, 5) : null,
    endTime: r.end_time_t ? String(r.end_time_t).slice(0, 5) : null,
    durationType: r.duration_type,
    rateType: r.rate_type,
    agreedRate: r.agreed_rate === null ? null : Number(r.agreed_rate),
    expectedTotal: r.expected_total === null ? null : Number(r.expected_total),
    status: r.status,
    offeredAt: new Date(r.offered_at).toISOString(),
    respondedAt: r.responded_at ? new Date(r.responded_at).toISOString() : null,
    responseNote: r.response_note,
    notes: r.notes,
    invoiceReceived: r.invoice_received,
    invoiceAmount: r.invoice_amount === null ? null : Number(r.invoice_amount),
    invoiceQueried: r.invoice_queried,
    invoiceQueryNotes: r.invoice_query_notes,
    cancellationReason: r.cancellation_reason,
  };
}

/** Hours between two HH:MM times, to two decimals. */
export function hoursBetween(start: string, end: string): number {
  const toMin = (t: string) => {
    const [h, m] = t.split(':').map(Number);
    return h * 60 + m;
  };
  return Math.round(((toMin(end) - toMin(start)) / 60) * 100) / 100;
}

/**
 * What this booking is expected to cost.
 *
 * Computed on write and stored, so a month of bookings rolls up into expected
 * spend without a report re-deriving the rate rules — and so a later change to
 * how rates work cannot silently restate what was agreed.
 *
 * `fixed` is the escape hatch for "we agreed £150 for the job" and is taken at
 * face value; `hourly` is the only one that multiplies, and it needs times.
 */
export function computeExpectedTotal(input: {
  rateType: RateType;
  agreedRate: number | null;
  durationType: DurationType;
  startTime?: string | null;
  endTime?: string | null;
}): number | null {
  if (input.agreedRate === null || input.agreedRate === undefined) return null;
  if (input.rateType === 'hourly') {
    if (!input.startTime || !input.endTime) return null;
    const hours = hoursBetween(input.startTime, input.endTime);
    return hours > 0 ? Math.round(input.agreedRate * hours * 100) / 100 : null;
  }
  // day, half_day and fixed are all "the agreed figure, as agreed".
  return Math.round(input.agreedRate * 100) / 100;
}

// ── Reads ───────────────────────────────────────────────────────────────────

/**
 * Bookings over a range, for the calendar lane.
 *
 * Only live and completed ones: a declined or cancelled booking is history and
 * must not put somebody on the calendar, or the headcount overstates who is in
 * — which is the one number this feature exists to get right.
 */
export async function listForRange(from: string, to: string): Promise<DayBooking[]> {
  if (!DATE_RE.test(from) || !DATE_RE.test(to)) throw new Error('Dates must be YYYY-MM-DD');
  const r = await query(
    `${SELECT}
      WHERE b.booking_date BETWEEN $1::date AND $2::date
        AND b.status IN ('offered','accepted','completed')
      ORDER BY b.booking_date, display_first`,
    [from, to]
  );
  return r.rows.map(mapRow);
}

export async function listForPerson(personId: string, opts: { limit?: number } = {}): Promise<DayBooking[]> {
  const r = await query(
    `${SELECT} WHERE b.person_id = $1 ORDER BY b.booking_date DESC LIMIT $2`,
    [personId, Math.min(opts.limit ?? 100, 500)]
  );
  return r.rows.map(mapRow);
}

export async function getBooking(id: string): Promise<DayBooking | null> {
  const r = await query(`${SELECT} WHERE b.id = $1`, [id]);
  return r.rows[0] ? mapRow(r.rows[0]) : null;
}

/** Freelancers who can be booked, with their pre-fill rates. */
export async function listBookableFreelancers() {
  const r = await query(
    `SELECT p.id AS person_id,
            COALESCE(NULLIF(p.preferred_name, ''), p.first_name) AS first_name,
            p.last_name, p.email,
            p.default_day_rate, p.default_half_day_rate
       FROM people p
      WHERE p.is_freelancer = true AND p.is_deleted = false
      ORDER BY first_name, p.last_name`
  );
  return r.rows.map(row => ({
    personId: row.person_id,
    name: `${row.first_name ?? ''} ${row.last_name ?? ''}`.trim(),
    email: row.email,
    defaultDayRate: row.default_day_rate === null ? null : Number(row.default_day_rate),
    defaultHalfDayRate: row.default_half_day_rate === null ? null : Number(row.default_half_day_rate),
  }));
}

// ── Writes ──────────────────────────────────────────────────────────────────

export interface CreateBookingInput {
  personId: string;
  bookingDate: string;
  durationType?: DurationType;
  startTime?: string | null;
  endTime?: string | null;
  rateType?: RateType;
  agreedRate?: number | null;
  notes?: string | null;
}

export async function createBooking(input: CreateBookingInput, userId: string): Promise<DayBooking> {
  if (!DATE_RE.test(input.bookingDate)) throw new Error('The date must be YYYY-MM-DD');
  const durationType = input.durationType ?? 'full_day';
  const rateType = input.rateType ?? 'day';

  if (durationType === 'hours' && (!input.startTime || !input.endTime)) {
    throw new Error('A timed booking needs both a start and an end time');
  }
  if (durationType !== 'hours' && (input.startTime || input.endTime)) {
    throw new Error('Only a timed booking carries times — pick "set hours" or leave them blank');
  }
  // The `freelancer_day_times` CHECK (mig 222) already refuses this, so nothing
  // backwards can be stored — but a caller that reaches it gets the raw
  // constraint violation as its error message. Say it in English first. An
  // overnight day is genuinely unsupported, not an oversight: the row holds two
  // times and no dates, so 22:00 → 02:00 has nowhere to record which day the
  // 02:00 belongs to. Two bookings is the honest way to record one.
  // Zero-padded HH:MM compares correctly as a string; `timeStr` guarantees the
  // padding, so this does not need parsing into minutes.
  if (durationType === 'hours' && input.startTime && input.endTime
      && input.endTime <= input.startTime) {
    throw new Error('The end time needs to be after the start — a day that runs past midnight is two bookings');
  }
  if (rateType === 'hourly' && durationType !== 'hours') {
    throw new Error('An hourly rate needs the hours — pick "set hours" for the duration');
  }

  const person = await query(
    `SELECT is_freelancer FROM people WHERE id = $1 AND is_deleted = false`, [input.personId]);
  if (person.rows.length === 0) throw new Error('That person does not exist');
  if (!person.rows[0].is_freelancer) {
    // Staff have a working pattern and a holiday balance; booking one as a
    // freelancer would put them on the calendar twice and pay them twice.
    throw new Error('That person is staff, not a freelancer — staff hours come from their working pattern');
  }

  const expectedTotal = computeExpectedTotal({
    rateType, agreedRate: input.agreedRate ?? null, durationType,
    startTime: input.startTime, endTime: input.endTime,
  });

  try {
    const r = await query(
      `INSERT INTO freelancer_day_bookings
         (person_id, booking_date, duration_type, start_time, end_time,
          rate_type, agreed_rate, expected_total, notes, created_by)
       VALUES ($1,$2::date,$3,$4::time,$5::time,$6,$7,$8,$9,$10)
       RETURNING id`,
      [input.personId, input.bookingDate, durationType,
       input.startTime ?? null, input.endTime ?? null,
       rateType, input.agreedRate ?? null, expectedTotal, input.notes ?? null, userId]
    );
    const booking = await getBooking(r.rows[0].id);
    if (!booking) throw new Error('Booking vanished immediately after being created');
    return booking;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.includes('idx_freelancer_day_one_live')) {
      throw new Error('They are already booked that day — widen the existing booking instead');
    }
    throw e;
  }
}

/**
 * Record how they replied.
 *
 * Admin records it for now; the freelancer-facing version is §9.3 and is not
 * built. Either way it is a RESPONSE — a decline is noted and nothing else
 * happens, which is the whole point of the wording.
 */
export async function recordResponse(
  id: string, response: 'accepted' | 'declined', note: string | null
): Promise<DayBooking> {
  const cur = await getBooking(id);
  if (!cur) throw new Error('Booking not found');
  if (cur.status === 'cancelled') throw new Error('That booking was cancelled');
  if (cur.status === 'completed') throw new Error('That booking is already marked done');

  await query(
    `UPDATE freelancer_day_bookings
        SET status = $2, responded_at = NOW(), response_note = $3, updated_at = NOW()
      WHERE id = $1`,
    [id, response, note]
  );
  const out = await getBooking(id);
  if (!out) throw new Error('Booking not found after recording the response');
  return out;
}

/** They came in and did the work — the point invoicing starts mattering. */
export async function markCompleted(id: string): Promise<DayBooking> {
  const cur = await getBooking(id);
  if (!cur) throw new Error('Booking not found');
  if (cur.status === 'cancelled') throw new Error('That booking was cancelled');
  if (cur.status === 'declined') throw new Error('That booking was declined');
  if (cur.status === 'lapsed') throw new Error('That booking was written off — reopen it by booking the day again');

  await query(
    `UPDATE freelancer_day_bookings SET status = 'completed', updated_at = NOW() WHERE id = $1`, [id]);
  const out = await getBooking(id);
  if (!out) throw new Error('Booking not found after completing');
  return out;
}

export async function cancelBooking(id: string, reason: string, userId: string): Promise<DayBooking> {
  const cur = await getBooking(id);
  if (!cur) throw new Error('Booking not found');
  if (cur.status === 'cancelled') throw new Error('That booking is already cancelled');

  await query(
    `UPDATE freelancer_day_bookings
        SET status = 'cancelled', cancelled_by = $2, cancelled_at = NOW(),
            cancellation_reason = $3, updated_at = NOW()
      WHERE id = $1`,
    [id, userId, reason]
  );
  const out = await getBooking(id);
  if (!out) throw new Error('Booking not found after cancelling');
  return out;
}

/**
 * Passed, still `offered` — the list §9.4 decision 1 creates and item 5 clears.
 *
 * Deliberately no date floor: an offer from last March is exactly the thing
 * that should still be shouting. Oldest first, because the stale end is where
 * the list stops being read.
 */
export async function listNeedsClosing(): Promise<DayBooking[]> {
  const r = await query(
    `${SELECT} WHERE b.status = 'offered' AND b.booking_date < CURRENT_DATE
      ORDER BY b.booking_date ASC`);
  return r.rows.map(mapRow);
}

/**
 * Write off, or record that they came anyway (§9.4 item 5).
 *
 * Two outcomes because those are the two things that actually happened, and
 * both need to be sayable in one click or the list does not get cleared.
 */
export async function closeOutBooking(
  id: string,
  outcome: 'completed' | 'lapsed',
  userId: string,
): Promise<DayBooking> {
  const cur = await getBooking(id);
  if (!cur) throw new Error('Booking not found');
  if (cur.status !== 'offered') {
    throw new Error(`Only an unanswered offer can be closed out — that one is ${cur.status}`);
  }
  // A future offer is not stale, it is pending. Closing one out would quietly
  // remove somebody from a day that has not happened, which is the exact
  // failure §9.4 decision 1 exists to prevent.
  if (cur.bookingDate >= new Date().toISOString().slice(0, 10)) {
    throw new Error('That day has not happened yet — cancel it instead if it is off');
  }

  await query(
    `UPDATE freelancer_day_bookings
        SET status = $2, closed_by = $3, closed_at = NOW(), updated_at = NOW()
      WHERE id = $1`,
    [id, outcome, userId]
  );
  const out = await getBooking(id);
  if (!out) throw new Error('Booking not found after closing out');
  return out;
}

export async function recordInvoice(id: string, input: {
  received: boolean; amount?: number | null; queried?: boolean; queryNotes?: string | null;
}): Promise<DayBooking> {
  const cur = await getBooking(id);
  if (!cur) throw new Error('Booking not found');

  await query(
    `UPDATE freelancer_day_bookings
        SET invoice_received = $2, invoice_amount = $3,
            invoice_queried = $4, invoice_query_notes = $5, updated_at = NOW()
      WHERE id = $1`,
    [id, input.received, input.amount ?? null, input.queried ?? false, input.queryNotes ?? null]
  );
  const out = await getBooking(id);
  if (!out) throw new Error('Booking not found after recording the invoice');
  return out;
}

// ── Money owed ──────────────────────────────────────────────────────────────

/**
 * Expected spend over a period, and what is still waiting on an invoice.
 *
 * Deliberately NOT called a "cost" — nothing here posts to `costs` or Xero.
 * It is a forecast of what these days are expected to add up to, which is what
 * makes booking a freelancer a decision with a number attached rather than a
 * calendar entry.
 */
export async function getSpendSummary(from: string, to: string) {
  const r = await query(
    `SELECT
       COUNT(*) FILTER (WHERE status IN ('offered','accepted'))         AS booked_days,
       COUNT(*) FILTER (WHERE status = 'completed')                     AS completed_days,
       COALESCE(SUM(expected_total) FILTER (
         WHERE status IN ('offered','accepted','completed')), 0)        AS expected_total,
       COALESCE(SUM(invoice_amount) FILTER (WHERE invoice_received), 0) AS invoiced_total,
       COUNT(*) FILTER (
         WHERE status = 'completed' AND invoice_received = false)       AS awaiting_invoice,
       COUNT(*) FILTER (WHERE invoice_queried)                          AS queried
     FROM freelancer_day_bookings
    WHERE booking_date BETWEEN $1::date AND $2::date`,
    [from, to]
  );
  const row = r.rows[0];
  return {
    from, to,
    bookedDays: Number(row.booked_days),
    completedDays: Number(row.completed_days),
    expectedTotal: Number(row.expected_total),
    invoicedTotal: Number(row.invoiced_total),
    awaitingInvoice: Number(row.awaiting_invoice),
    queried: Number(row.queried),
  };
}
