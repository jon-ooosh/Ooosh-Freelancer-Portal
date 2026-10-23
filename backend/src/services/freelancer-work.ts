/**
 * A freelancer's work, as an invoice sees it (docs/FREELANCER-PORTAL-SPEC.md §5,
 * jon, Oct 2026).
 *
 * The office uploads a freelancer's invoice in Costs and ticks the work it
 * covers ("Which jobs?"). This lists that work and records the ticks in
 * `cost_work_items`; the portal's Earnings tab reads the same rows
 * (services/freelancer-earnings.ts).
 *
 * Three kinds of work, each with the fee the freelancer was booked at:
 *   - a delivery / collection / crew booking (quote_assignments): the shared
 *     personalFee() rule, the same figure as the portal's "Your fee". Stops on
 *     one multi-drop run are ONE item: the run's combined fee when it has one
 *     (the figure the freelancer was offered), else the stops' fees added up.
 *   - a studio-sitter evening (studio_sitter_shift_assignments.fee)
 *   - a yard day (freelancer_day_bookings.expected_total)
 *
 * "Finished" is by date: started today or earlier, not cancelled or declined.
 * Marking a job complete in the portal isn't required, so an invoice that
 * arrives before the paperwork can still be matched.
 *
 * The expense estimate is a guide, not a rule (jon: fees are fixed, train /
 * taxi / fuel are guesstimates): the quote's own figures for one person.
 *
 * Nothing here moves money or touches Xero; job costs on the Money tab
 * (cost_allocations, GET /costs/by-job) are unchanged by these links.
 */
import { query, getClient } from '../config/database';
import { personalFee } from './freelancer-fees';
import { getSystemSetting } from '../routes/system-settings';
import { ukToday } from './uk-date';

export type WorkPartKind = 'booking' | 'sitter' | 'yard';

export interface WorkPart {
  kind: WorkPartKind;
  /** quote_assignments.id / studio_sitter_shift_assignments.id / freelancer_day_bookings.id */
  id: string;
  /** This part's booked figure, used to share a run's amount across its stops. */
  weight: number;
  jobId: string | null;
  /** That job's HireHop number and name, so a run's stops on other jobs can be named. */
  hhJobNumber?: number | null;
  jobName?: string | null;
}

export interface FreelancerWorkItem {
  /** What the client ticks: 'booking:<id>' | 'run:<run id>' | 'sitter:<id>' | 'yard:<id>'. */
  key: string;
  kind: 'booking' | 'run' | 'sitter' | 'yard';
  date: string;
  title: string;
  /** Stops on a run (each a venue), for the row's second line. */
  detail: string | null;
  jobId: string | null;
  hhJobNumber: number | null;
  jobName: string | null;
  /** The fee they were booked at (one person's share). */
  fee: number;
  /** One person's expense estimate from the quote, and what it is made of. */
  estimate: number;
  estimateParts: { label: string; amount: number }[];
  parts: WorkPart[];
  /** Other invoices this work is already on. */
  invoicedOn: { costId: string; invoiceNumber: string | null; supplierName: string | null; amount: number }[];
  /** This invoice's amount for it, when it is linked to the cost asked about. */
  linkedAmount: number | null;
}

const round2 = (n: number) => Math.round(n * 100) / 100;
const num = (v: unknown) => (v == null || v === '' ? 0 : Number(v) || 0);

function jobTypeLabel(t: string | null): string {
  if (t === 'delivery') return 'Delivery';
  if (t === 'collection') return 'Collection';
  if (t === 'crewed') return 'Crew';
  return 'Job';
}

/** One person's expense estimate from a quote row. A guide only. */
export function bookingEstimate(row: Record<string, unknown>): { total: number; parts: { label: string; amount: number }[] } {
  if (row.expected_expenses != null && String(row.expected_expenses).trim() !== '') {
    const v = round2(num(row.expected_expenses));
    return { total: v, parts: v ? [{ label: 'Agreed expenses', amount: v }] : [] };
  }
  const parts: { label: string; amount: number }[] = [];
  const crew = row.job_type === 'crewed' ? Math.max(1, Math.floor(num(row.crew_count) || 1)) : 1;
  let lines: Array<{ type?: string; description?: string; amount?: number; chargeMode?: string }> = [];
  try {
    lines = Array.isArray(row.expenses) ? row.expenses as typeof lines
      : typeof row.expenses === 'string' ? JSON.parse(row.expenses) : [];
  } catch { lines = []; }
  // Train fares and the like: per person (the calculator counts them per person).
  if (row.travel_method === 'public_transport' && num(row.travel_cost) > 0) {
    parts.push({ label: 'Travel', amount: round2(num(row.travel_cost)) });
  }
  // Fuel: one van, one tank, so one person's share of it.
  const fuelLine = lines.find((l) => l?.type === 'fuel');
  if (num(row.expected_fuel_cost) > 0 && fuelLine?.chargeMode !== 'na') {
    parts.push({ label: 'Fuel', amount: round2(num(row.expected_fuel_cost) / crew) });
  }
  // Parking, tolls, hotels…: per person, as typed on the quote.
  for (const l of lines) {
    if (!l || l.type === 'fuel' || l.chargeMode === 'na' || !(num(l.amount) > 0)) continue;
    parts.push({ label: (l.description || l.type || 'Expense').toString().slice(0, 40), amount: round2(num(l.amount)) });
  }
  return { total: round2(parts.reduce((t, p) => t + p.amount, 0)), parts };
}

/**
 * The person's finished work from `from` (default 12 months back) to today,
 * plus anything already linked to `costId` whatever its date. With
 * `includeInvoiced` false, work already on ANOTHER invoice is left out (unless
 * it is also on this one).
 */
export async function listFreelancerWork(personId: string, opts: {
  costId?: string | null; includeInvoiced?: boolean; from?: string;
} = {}): Promise<FreelancerWorkItem[]> {
  const today = ukToday();
  const from = opts.from || (() => {
    const [y, m, d] = today.split('-').map(Number);
    return `${y - 1}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  })();
  const costId = opts.costId || null;

  const [bookings, sitter, yard] = await Promise.all([
    query(
      `SELECT qa.id, qa.agreed_rate, qa.expected_expenses,
              q.id AS quote_id, q.job_type, q.venue_name, q.job_date::text AS job_date,
              q.freelancer_fee, q.freelancer_fee_rounded, q.crew_count,
              q.travel_method, q.travel_cost, q.expected_fuel_cost, q.expenses,
              q.run_group, rg.combined_freelancer_fee AS run_fee, q.run_order,
              j.id AS job_id, j.hh_job_number, j.job_name
         FROM quote_assignments qa
         JOIN quotes q ON q.id = qa.quote_id AND q.is_deleted = false
         LEFT JOIN run_groups rg ON rg.id = q.run_group
         LEFT JOIN jobs j ON j.id = q.job_id AND j.is_deleted = false
        WHERE qa.person_id = $1
          AND (
            ( qa.status NOT IN ('declined', 'cancelled')
              AND COALESCE(q.status, '') <> 'cancelled' AND COALESCE(q.ops_status, '') <> 'cancelled'
              AND q.job_date IS NOT NULL AND q.job_date BETWEEN $2::date AND $3::date )
            OR EXISTS (SELECT 1 FROM cost_work_items w WHERE w.cost_id = $4 AND w.quote_assignment_id = qa.id)
          )`,
      [personId, from, today, costId],
    ),
    query(
      `SELECT a.id, a.fee, s.shift_date::text AS shift_date, s.planned_start::text AS planned_start
         FROM studio_sitter_shift_assignments a
         JOIN studio_sitter_shifts s ON s.id = a.shift_id
        WHERE a.person_id = $1
          AND (
            ( a.status NOT IN ('declined', 'cancelled') AND s.status <> 'cancelled'
              AND s.shift_date BETWEEN $2::date AND $3::date )
            OR EXISTS (SELECT 1 FROM cost_work_items w WHERE w.cost_id = $4 AND w.sitter_assignment_id = a.id)
          )`,
      [personId, from, today, costId],
    ),
    query(
      `SELECT b.id, b.booking_date::text AS booking_date, b.duration_type, b.expected_total
         FROM freelancer_day_bookings b
        WHERE b.person_id = $1
          AND (
            ( b.status IN ('accepted', 'completed') AND b.booking_date BETWEEN $2::date AND $3::date )
            OR EXISTS (SELECT 1 FROM cost_work_items w WHERE w.cost_id = $4 AND w.day_booking_id = b.id)
          )`,
      [personId, from, today, costId],
    ),
  ]);

  const items: FreelancerWorkItem[] = [];

  // Bookings: stops on one run collapse into a single item.
  const runs = new Map<string, Array<Record<string, unknown>>>();
  for (const r of bookings.rows) {
    if (r.run_group && (r.job_type === 'delivery' || r.job_type === 'collection')) {
      const list = runs.get(r.run_group) || [];
      list.push(r);
      runs.set(r.run_group, list);
      continue;
    }
    const est = bookingEstimate(r);
    items.push({
      key: `booking:${r.id}`,
      kind: 'booking',
      date: r.job_date,
      title: `${jobTypeLabel(r.job_type)}${r.venue_name ? `, ${r.venue_name}` : ''}`,
      detail: null,
      jobId: r.job_id || null,
      hhJobNumber: r.hh_job_number != null ? Number(r.hh_job_number) : null,
      jobName: r.job_name || null,
      fee: personalFee(r),
      estimate: est.total,
      estimateParts: est.parts,
      parts: [{
        kind: 'booking', id: r.id, weight: personalFee(r) + est.total, jobId: r.job_id || null,
        hhJobNumber: r.hh_job_number != null ? Number(r.hh_job_number) : null, jobName: r.job_name || null,
      }],
      invoicedOn: [],
      linkedAmount: null,
    });
  }
  for (const [runId, stops] of runs) {
    stops.sort((a, b) => num(a.run_order) - num(b.run_order));
    const stopFees = stops.map((s) => personalFee(s));
    const runFee = stops.find((s) => s.run_fee != null)?.run_fee;
    const fee = runFee != null ? round2(num(runFee)) : round2(stopFees.reduce((t, f) => t + f, 0));
    const ests = stops.map((s) => bookingEstimate(s));
    const firstJob = stops.find((s) => s.job_id);
    items.push({
      key: `run:${runId}`,
      kind: 'run',
      date: String(stops[0].job_date),
      title: `Run, ${stops.length} stop${stops.length === 1 ? '' : 's'}`,
      detail: stops.map((s) => s.venue_name || jobTypeLabel(s.job_type as string)).join(' · '),
      jobId: (firstJob?.job_id as string) || null,
      hhJobNumber: firstJob?.hh_job_number != null ? Number(firstJob.hh_job_number) : null,
      jobName: (firstJob?.job_name as string) || null,
      fee,
      estimate: round2(ests.reduce((t, e) => t + e.total, 0)),
      estimateParts: ests.flatMap((e) => e.parts),
      parts: stops.map((s, i) => ({
        kind: 'booking' as const, id: s.id as string,
        weight: stopFees[i] + ests[i].total || 1, jobId: (s.job_id as string) || null,
        hhJobNumber: s.hh_job_number != null ? Number(s.hh_job_number) : null,
        jobName: (s.job_name as string) || null,
      })),
      invoicedOn: [],
      linkedAmount: null,
    });
  }
  for (const r of sitter.rows) {
    const fee = round2(num(r.fee));
    items.push({
      key: `sitter:${r.id}`, kind: 'sitter', date: r.shift_date,
      title: 'Studio evening', detail: null, jobId: null, hhJobNumber: null, jobName: null,
      fee, estimate: 0, estimateParts: [],
      parts: [{ kind: 'sitter', id: r.id, weight: fee || 1, jobId: null }],
      invoicedOn: [], linkedAmount: null,
    });
  }
  for (const r of yard.rows) {
    const fee = round2(num(r.expected_total));
    const len = r.duration_type === 'half_day' ? 'half day' : r.duration_type === 'hours' ? 'hours' : 'full day';
    items.push({
      key: `yard:${r.id}`, kind: 'yard', date: r.booking_date,
      title: `Yard day (${len})`, detail: null, jobId: null, hhJobNumber: null, jobName: null,
      fee, estimate: 0, estimateParts: [],
      parts: [{ kind: 'yard', id: r.id, weight: fee || 1, jobId: null }],
      invoicedOn: [], linkedAmount: null,
    });
  }

  // Which invoices each piece of work is already on.
  const ids = { booking: [] as string[], sitter: [] as string[], yard: [] as string[] };
  for (const it of items) for (const p of it.parts) ids[p.kind].push(p.id);
  if (items.length) {
    const links = await query(
      `SELECT w.cost_id, w.amount, w.quote_assignment_id, w.sitter_assignment_id, w.day_booking_id,
              c.invoice_number, c.supplier_name
         FROM cost_work_items w JOIN costs c ON c.id = w.cost_id
        WHERE w.quote_assignment_id = ANY($1::uuid[])
           OR w.sitter_assignment_id = ANY($2::uuid[])
           OR w.day_booking_id = ANY($3::uuid[])`,
      [ids.booking, ids.sitter, ids.yard],
    );
    const byPart = new Map<string, typeof links.rows>();
    for (const l of links.rows) {
      const k = l.quote_assignment_id ? `booking:${l.quote_assignment_id}`
        : l.sitter_assignment_id ? `sitter:${l.sitter_assignment_id}` : `yard:${l.day_booking_id}`;
      const list = byPart.get(k) || [];
      list.push(l);
      byPart.set(k, list);
    }
    for (const it of items) {
      const seen = new Map<string, { costId: string; invoiceNumber: string | null; supplierName: string | null; amount: number }>();
      let mine = 0;
      let onThis = false;
      for (const p of it.parts) {
        for (const l of byPart.get(`${p.kind}:${p.id}`) || []) {
          if (costId && l.cost_id === costId) { mine += num(l.amount); onThis = true; continue; }
          const e = seen.get(l.cost_id) || { costId: l.cost_id, invoiceNumber: l.invoice_number || null, supplierName: l.supplier_name || null, amount: 0 };
          e.amount = round2(e.amount + num(l.amount));
          seen.set(l.cost_id, e);
        }
      }
      it.invoicedOn = [...seen.values()];
      it.linkedAmount = onThis ? round2(mine) : null;
    }
  }

  const visible = opts.includeInvoiced
    ? items
    : items.filter((it) => it.linkedAmount != null || it.invoicedOn.length === 0);
  // Newest first: an invoice usually covers the last few weeks.
  return visible.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : a.key.localeCompare(b.key)));
}

/** Booked vs invoiced: how far over the expense estimate is still "about right". */
export async function getInvoiceTolerance(): Promise<{ gbp: number; pct: number }> {
  const gbp = Number(await getSystemSetting('freelancer_invoice_tolerance_gbp'));
  const pct = Number(await getSystemSetting('freelancer_invoice_tolerance_pct'));
  return { gbp: Number.isFinite(gbp) && gbp >= 0 ? gbp : 10, pct: Number.isFinite(pct) && pct >= 0 ? pct : 25 };
}

export class WorkLinkError extends Error {}

export type WorkLinkRow = { kind: WorkPartKind; id: string; amount: number };

/**
 * Check the ticks and turn them into rows, BEFORE anything is written, so a
 * tick that isn't this person's can't leave a half-saved cost behind. `items`
 * are keys from listFreelancerWork() with this invoice's amount for each; a
 * run's amount is shared across its stops by their booked figures (the last
 * stop takes the odd penny). `costId` is null for a cost not yet created.
 */
export async function planWorkLinks(
  costId: string | null, personId: string | null, items: { key: string; amount: number }[],
): Promise<WorkLinkRow[]> {
  if (items.length && !personId) throw new WorkLinkError('Pick whose invoice it is before ticking their work.');
  const available = items.length
    ? await listFreelancerWork(personId as string, { costId, includeInvoiced: true, from: '2000-01-01' })
    : [];
  const byKey = new Map(available.map((it) => [it.key, it]));
  const rows: WorkLinkRow[] = [];
  const seen = new Set<string>();
  for (const { key, amount } of items) {
    if (seen.has(key)) continue;
    seen.add(key);
    const it = byKey.get(key);
    if (!it) throw new WorkLinkError('Some of the ticked work isn\'t this freelancer\'s. Refresh and tick it again.');
    const pence = Math.round(Math.max(0, Number(amount) || 0) * 100);
    const totalWeight = it.parts.reduce((t, p) => t + p.weight, 0) || it.parts.length;
    let given = 0;
    it.parts.forEach((p, i) => {
      const share = i === it.parts.length - 1 ? pence - given : Math.round((pence * p.weight) / totalWeight);
      given += share;
      rows.push({ kind: p.kind, id: p.id, amount: share / 100 });
    });
  }
  return rows;
}

/** Replace a cost's work links with `rows` (from planWorkLinks; empty clears them). */
export async function writeWorkLinks(costId: string, rows: WorkLinkRow[], userId: string | null): Promise<void> {
  const client = await getClient();
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM cost_work_items WHERE cost_id = $1', [costId]);
    for (const r of rows) {
      await client.query(
        `INSERT INTO cost_work_items (cost_id, quote_assignment_id, sitter_assignment_id, day_booking_id, amount, created_by)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [costId, r.kind === 'booking' ? r.id : null, r.kind === 'sitter' ? r.id : null,
          r.kind === 'yard' ? r.id : null, r.amount, userId],
      );
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}
