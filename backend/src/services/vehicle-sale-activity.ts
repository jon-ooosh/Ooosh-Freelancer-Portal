/**
 * A van sale's activity log — THE definition (docs/VEHICLE-SALES-SPEC.md §7).
 *
 * Staff log what happened: a viewing, a listing (site + URL), a contact, an
 * offer, a note. Any entry can carry a FOLLOW-UP, which is an ordinary To Do
 * item (staff_tasks, source_type 'vehicle_sale', source_id = the sale) made
 * through services/staff-tasks.ts createTask() — this module never writes a
 * task row itself (D13; TASKS-SPEC §2). Ticking it is plain To Do.
 *
 * Offers can be accepted or declined. Accepting one moves the sale to
 * "Under offer" (logged), and "Mark sold" pre-fills the sold modal from it.
 * Nothing here moves money or marks anything sold.
 *
 * OP's own entries (stage changes, links) are written by logSaleEvent() in
 * services/vehicle-sales.ts.
 */
import { query } from '../config/database';
import { DISPLAY_NAME_SQL } from './display-name';
import { SaleError, OPEN_SALE_STATUSES, cleanDate, cleanPrice, updateSale } from './vehicle-sales';
import { createTask, todayLondon } from './staff-tasks';

export const STAFF_EVENT_TYPES = ['note', 'viewing', 'listed', 'contact', 'offer'] as const;
export type StaffEventType = typeof STAFF_EVENT_TYPES[number];

export interface ActivityInput {
  type?: unknown;
  occurredOn?: unknown;
  who?: unknown;
  text?: unknown;
  amount?: unknown;
  listingSite?: unknown;
  listingUrl?: unknown;
  followUp?: { dueDate?: unknown; personId?: unknown } | null;
}

export interface CleanActivity {
  type: StaffEventType;
  occurredOn: string;
  who: string | null;
  text: string | null;
  amount: number | null;
  listingSite: string | null;
  listingUrl: string | null;
  followUp: { dueDate: string; personId: string | null } | null;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function str(v: unknown, max: number): string | null {
  return typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null;
}

/**
 * Validate a staff entry. Pure — `today` is passed in. What happened may be in
 * the past; it may not be in the future (that's what the follow-up is for).
 */
export function planActivity(input: ActivityInput, today: string): CleanActivity {
  const type = input.type;
  if (typeof type !== 'string' || !(STAFF_EVENT_TYPES as readonly string[]).includes(type)) {
    throw new SaleError(400, 'Pick what happened — viewing, listing, contact, offer or note');
  }
  const occurredOn = input.occurredOn === undefined || input.occurredOn === '' ? today : cleanDate(input.occurredOn);
  if (!occurredOn) throw new SaleError(400, 'The date is not a valid date');
  if (occurredOn > today) throw new SaleError(400, "The date can't be in the future — add a follow-up instead");

  const who = str(input.who, 200);
  const text = str(input.text, 5000);

  let amount: number | null = null;
  if (type === 'offer') {
    const a = cleanPrice(input.amount);
    if (a === undefined || a === null || a <= 0) throw new SaleError(400, 'An offer needs an amount');
    if (!who) throw new SaleError(400, 'Who made the offer?');
    amount = a;
  }

  let listingSite: string | null = null;
  let listingUrl: string | null = null;
  if (type === 'listed') {
    listingSite = str(input.listingSite, 100);
    if (!listingSite) throw new SaleError(400, 'Where was it listed?');
    const url = str(input.listingUrl, 1000);
    if (url && !/^https?:\/\//i.test(url)) throw new SaleError(400, 'The listing link must start with http:// or https://');
    listingUrl = url;
  }

  if (type !== 'offer' && type !== 'listed' && !who && !text) {
    throw new SaleError(400, 'Say who, or what happened');
  }

  let followUp: CleanActivity['followUp'] = null;
  if (input.followUp && input.followUp.dueDate) {
    const due = cleanDate(input.followUp.dueDate);
    if (!due) throw new SaleError(400, 'The follow-up date is not a valid date');
    if (due < today) throw new SaleError(400, "The follow-up can't be in the past");
    const pid = input.followUp.personId;
    if (pid != null && pid !== '' && (typeof pid !== 'string' || !UUID_RE.test(pid))) {
      throw new SaleError(400, 'Unknown person for the follow-up');
    }
    followUp = { dueDate: due, personId: typeof pid === 'string' && pid ? pid : null };
  }

  return { type: type as StaffEventType, occurredOn, who, text, amount, listingSite, listingUrl, followUp };
}

const TYPE_VERB: Record<StaffEventType, string> = {
  note: 'Note', viewing: 'Viewing', listed: 'Listing', contact: 'Contact', offer: 'Offer',
};

/** The To Do title — reads on its own in somebody's list. Pure. */
export function followUpTitle(reg: string, a: Pick<CleanActivity, 'type' | 'who' | 'listingSite'>): string {
  const subject = a.who ?? (a.type === 'listed' && a.listingSite ? `the ${a.listingSite} listing` : null);
  return subject ? `Follow up ${subject} re ${reg} sale` : `Follow up the ${reg} sale`;
}

async function openSaleOr409(saleId: string): Promise<{ reg: string; vehicleId: string; status: string }> {
  const res = await query(
    `SELECT s.status, s.vehicle_id, fv.reg FROM vehicle_sales s JOIN fleet_vehicles fv ON fv.id = s.vehicle_id WHERE s.id = $1`,
    [saleId],
  );
  const r = res.rows[0];
  if (!r) throw new SaleError(404, 'Sale not found');
  if (!(OPEN_SALE_STATUSES as readonly string[]).includes(r.status)) throw new SaleError(409, 'This sale is closed');
  return { reg: r.reg, vehicleId: r.vehicle_id, status: r.status };
}

export async function addActivity(saleId: string, userId: string, role: string, input: ActivityInput): Promise<void> {
  const sale = await openSaleOr409(saleId);
  const a = planActivity(input, todayLondon());

  let taskId: string | null = null;
  if (a.followUp) {
    const detail = [
      `${TYPE_VERB[a.type]} on ${a.occurredOn}${a.who ? ` — ${a.who}` : ''}${a.amount != null ? ` (£${a.amount.toLocaleString('en-GB')})` : ''}`,
      a.text,
      a.listingUrl,
    ].filter(Boolean).join('\n');
    try {
      const task = await createTask({
        title: followUpTitle(sale.reg, a),
        detail,
        dueDate: a.followUp.dueDate,
        personId: a.followUp.personId ?? undefined,
        sourceType: 'vehicle_sale',
        sourceId: saleId,
      }, userId, role);
      taskId = (task as { id: string }).id;
    } catch (err) {
      // createTask speaks in plain Errors ("can't be in the past", …) — those are the caller's to fix.
      throw new SaleError(400, (err as Error).message);
    }
  }

  await query(
    `INSERT INTO vehicle_sale_events
       (sale_id, type, occurred_on, who, text, amount, offer_status, listing_site, listing_url, task_id, created_by)
     VALUES ($1, $2, $3::date, $4, $5, $6, $7, $8, $9, $10, $11)`,
    [saleId, a.type, a.occurredOn, a.who, a.text, a.amount, a.type === 'offer' ? 'open' : null,
      a.listingSite, a.listingUrl, taskId, userId],
  );
}

/**
 * Accept or decline an offer. Accepting moves the sale to "Under offer" (the
 * stage change is logged by updateSale). Re-opening (`open`) is allowed — a
 * buyer who pulls out.
 */
export async function setOfferStatus(
  saleId: string, eventId: string, status: unknown, userId: string, role: string,
): Promise<void> {
  if (status !== 'open' && status !== 'accepted' && status !== 'declined') throw new SaleError(400, 'Unknown offer status');
  const sale = await openSaleOr409(saleId);
  const res = await query(
    `UPDATE vehicle_sale_events SET offer_status = $3
      WHERE id = $2 AND sale_id = $1 AND type = 'offer'`,
    [saleId, eventId, status],
  );
  if ((res.rowCount ?? 0) === 0) throw new SaleError(404, 'Offer not found');
  if (status === 'accepted' && sale.status !== 'under_offer') {
    await updateSale(saleId, role, { status: 'under_offer' }, userId);
  }
}

export interface ActivityEntry {
  id: string;
  type: string;
  occurredOn: string;
  who: string | null;
  text: string | null;
  amount: number | null;
  offerStatus: 'open' | 'accepted' | 'declined' | null;
  listingSite: string | null;
  listingUrl: string | null;
  createdAt: string;
  createdByName: string | null;
  followUp: { taskId: string; dueDate: string | null; status: string; ownerName: string | null } | null;
}

export async function listActivity(saleId: string): Promise<ActivityEntry[]> {
  const res = await query(
    `SELECT e.*, to_char(e.occurred_on, 'YYYY-MM-DD') AS occurred_on_str,
            ${DISPLAY_NAME_SQL} AS created_by_name,
            t.id AS t_id, t.status AS t_status, t.due_date::text AS t_due,
            NULLIF(TRIM(COALESCE(NULLIF(op.preferred_name, ''), op.first_name, '') || ' ' || COALESCE(op.last_name, '')), '') AS t_owner
       FROM vehicle_sale_events e
       LEFT JOIN users u ON u.id = e.created_by
       LEFT JOIN people p ON p.id = u.person_id
       LEFT JOIN staff_tasks t ON t.id = e.task_id
       LEFT JOIN people op ON op.id = t.person_id
      WHERE e.sale_id = $1
      ORDER BY e.occurred_on DESC, e.created_at DESC
      LIMIT 500`,
    [saleId],
  );
  return res.rows.map((r) => ({
    id: r.id,
    type: r.type,
    occurredOn: r.occurred_on_str,
    who: r.who ?? null,
    text: r.text ?? null,
    amount: r.amount != null ? Number(r.amount) : null,
    offerStatus: r.offer_status ?? null,
    listingSite: r.listing_site ?? null,
    listingUrl: r.listing_url ?? null,
    createdAt: (r.created_at as Date).toISOString(),
    createdByName: ((r.created_by_name as string | null) ?? '').trim() || null,
    followUp: r.t_id
      ? { taskId: r.t_id, dueDate: r.t_due ?? null, status: r.t_status, ownerName: r.t_owner ?? null }
      : null,
  }));
}

/** The offer "Mark sold" pre-fills from: the most recent accepted one. */
export async function acceptedOffer(saleId: string): Promise<{ amount: number; who: string | null } | null> {
  const res = await query(
    `SELECT amount, who FROM vehicle_sale_events
      WHERE sale_id = $1 AND type = 'offer' AND offer_status = 'accepted'
      ORDER BY occurred_on DESC, created_at DESC LIMIT 1`,
    [saleId],
  );
  const r = res.rows[0];
  return r ? { amount: Number(r.amount), who: r.who ?? null } : null;
}
