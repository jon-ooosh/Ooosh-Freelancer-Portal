/**
 * shop-period.ts — the weekly HireHop "Shop Sales" job.
 *
 * Step 6 of `docs/SHOP-SALES-SPEC.md`. One job per week, created by OP, held
 * permanently at DISPATCHED (5) because sale stock is only consumed at dispatch
 * and a line added to an already-dispatched job decrements immediately (§2.1).
 *
 * ⚠️ THE STATUS IS LOAD-BEARING STATE. Anything that knocks this job below
 * status 5 releases every sale on it — the stock reappears and nothing errors.
 * That is why the job is never synced into OP's `jobs` table (§3.0): with no
 * row, OP cannot push a `pipeline_status` to it, so the failure mode is
 * impossible rather than merely unlikely.
 *
 * ⚠️ NOTHING HERE TRUSTS A 200. Every write is read back and checked, because
 * HireHop has twice returned `success: true` for something it did not do
 * (§2.5). A job created on the wrong client is a Xero cleanup; a sale left
 * queued in OP is not. When in doubt this refuses.
 */
import { query } from '../config/database';
import hhBroker from './hirehop-broker';

/* eslint-disable @typescript-eslint/no-explicit-any */

const CLIENT_ID_KEY = 'shop_job_client_id';
const NAME_PATTERN_KEY = 'shop_job_name_pattern';
const CONTACT_NAME_KEY = 'shop_job_contact_name';

/** HireHop status 5. Below this, sale stock is not consumed (§2.1). */
const DISPATCHED = 5;

export interface ShopPeriod {
  id: string;
  periodStart: string;
  periodEnd: string;
  hhJobNumber: number;
}

async function setting(key: string): Promise<string | null> {
  try {
    const r = await query(`SELECT value FROM system_settings WHERE key = $1`, [key]);
    const v = r.rows[0]?.value;
    return v ? String(v).trim() : null;
  } catch {
    return null;
  }
}

/** Monday of the week containing `d`, as YYYY-MM-DD. */
export function weekStart(d: Date): string {
  const copy = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  // getUTCDay: 0 = Sunday. Sunday belongs to the week that STARTED six days ago,
  // not the one about to start — an off-by-one here would split a Sunday's
  // takings across two invoices.
  const shift = (copy.getUTCDay() + 6) % 7;
  copy.setUTCDate(copy.getUTCDate() - shift);
  return copy.toISOString().slice(0, 10);
}

function addDays(iso: string, n: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** "28th Sep 2026" — how jon writes it, so the job list reads naturally. */
function prettyDate(iso: string): string {
  const d = new Date(`${iso}T00:00:00Z`);
  const day = d.getUTCDate();
  const suffix = day % 10 === 1 && day !== 11 ? 'st'
    : day % 10 === 2 && day !== 12 ? 'nd'
    : day % 10 === 3 && day !== 13 ? 'rd' : 'th';
  const month = d.toLocaleString('en-GB', { month: 'short', timeZone: 'UTC' });
  return `${day}${suffix} ${month} ${d.getUTCFullYear()}`;
}

/**
 * Find, or create, the HireHop job for the week containing `when`.
 *
 * `shop_sale_periods.period_start` is UNIQUE, which is what stops two tills
 * racing to create two jobs for the same week.
 */
export async function getOrCreateShopPeriod(when: Date = new Date()): Promise<ShopPeriod> {
  const start = weekStart(when);
  const end = addDays(start, 6);

  const existing = await query(
    `SELECT id, period_start::text, period_end::text, hh_job_number
       FROM shop_sale_periods WHERE period_start = $1`,
    [start],
  );
  if (existing.rows[0]?.hh_job_number) {
    const row = existing.rows[0];
    return {
      id: row.id, periodStart: row.period_start,
      periodEnd: row.period_end, hhJobNumber: Number(row.hh_job_number),
    };
  }

  const clientId = Number(await setting(CLIENT_ID_KEY));
  if (!Number.isFinite(clientId) || clientId <= 0) {
    // Refuse rather than improvise. A job on the wrong client is a Xero
    // cleanup; sales waiting in OP are simply late.
    throw new Error(
      `No HireHop client configured for shop sales. Set '${CLIENT_ID_KEY}' in system settings.`,
    );
  }

  const pattern = (await setting(NAME_PATTERN_KEY)) || 'Shop Sales W/C {date}';
  const jobName = pattern.replace('{date}', prettyDate(start));

  // Monday 00:01 to Sunday 23:59 — jon's choice. Sales land on whichever week
  // they happen in, and the week closes cleanly for invoicing.
  //
  // ⚠️ SEND parameters are lowercase; the UPPERCASE names are what HireHop
  // RETURNS. The first attempt sent `CLIENT_ID`, lifted from the response
  // shape, and got error 3 — that one was my misreading rather than HireHop's
  // docs being wrong, unlike the three endpoints in §2.9.
  //
  // `name` is documented as required when creating, and `client_id` is the
  // company in the address book. Different fields; HireHop wants both.
  //
  // This is the FIRST job OP has ever created in HireHop — every other
  // save_job.php call in this codebase targets an existing `job: <number>` to
  // rename it or add an item. There was no working example to copy.
  const contactName = (await setting(CONTACT_NAME_KEY)) || 'OP Shop Sales';
  const createPayload = {
    job: 0,                       // 0 = create
    client_id: clientId,          // lowercase on the way IN
    name: contactName,            // required for new
    job_name: jobName,
    out: `${start} 00:01`,
    start: `${start} 00:01`,
    end: `${end} 23:59`,
    to: `${end} 23:59`,
    duration_days: 7,
    duration_locked: 0,
    no_webhook: 1,
  };
  const createRes = await hhBroker.post<any>('/api/save_job.php', createPayload, { priority: 'high' });

  if (!createRes?.success) {
    console.error('[shop-period] save_job rejected. sent=%j reply=%j', createPayload, createRes);
    throw new Error(
      `HireHop refused to create the weekly shop job (reply: ${JSON.stringify(createRes?.error ?? createRes).slice(0, 200)}). ` +
      `The payload is in the server log — this endpoint's real parameters have not been captured yet.`,
    );
  }

  const created: any = createRes.data;
  const hhJobNumber = Number(created?.ID ?? created?.job ?? created?.JOB);
  if (!Number.isFinite(hhJobNumber) || hhJobNumber <= 0) {
    throw new Error(`HireHop accepted the job but returned no id (keys: ${created && typeof created === 'object' ? Object.keys(created).join(',') : 'none'})`);
  }

  // Read it back. `success: true` has twice meant nothing (§2.5), and this is
  // the one write where being wrong is expensive — a week of takings against
  // the wrong client.
  const check = await hhBroker.get<any>('/api/job_data.php', { job: hhJobNumber },
    { priority: 'high', cacheTTL: -1, skipCache: true });
  const job: any = check?.success ? check.data : null;
  if (!job) {
    throw new Error(`Created HireHop job ${hhJobNumber} but could not read it back — check it by hand before using it.`);
  }
  if (Number(job.CLIENT_ID) !== clientId) {
    throw new Error(
      `HireHop job ${hhJobNumber} was created against client ${job.CLIENT_ID}, not ${clientId}. ` +
      `Delete it in HireHop and check the '${CLIENT_ID_KEY}' setting.`,
    );
  }

  // Dispatched, or nothing sold on it ever moves stock (§2.1).
  const statusRes = await hhBroker.post<any>('/frames/status_save.php', {
    job: hhJobNumber, status: DISPATCHED, no_webhook: 1,
  }, { priority: 'high' });
  if (!statusRes?.success) {
    throw new Error(`Created HireHop job ${hhJobNumber} but could not set it to Dispatched: ${JSON.stringify(statusRes?.error ?? '').slice(0, 200)}`);
  }

  const after = await hhBroker.get<any>('/api/job_data.php', { job: hhJobNumber },
    { priority: 'high', cacheTTL: -1, skipCache: true });
  const status = Number((after?.data as any)?.STATUS);
  if (status !== DISPATCHED) {
    throw new Error(
      `HireHop job ${hhJobNumber} is status ${status}, not ${DISPATCHED}. Sales on it would not move stock — fix it in HireHop before selling.`,
    );
  }

  const ins = await query(
    `INSERT INTO shop_sale_periods (period_start, period_end, hh_job_number)
     VALUES ($1, $2, $3)
     ON CONFLICT (period_start) DO UPDATE SET hh_job_number = COALESCE(shop_sale_periods.hh_job_number, EXCLUDED.hh_job_number)
     RETURNING id, period_start::text, period_end::text, hh_job_number`,
    [start, end, hhJobNumber],
  );
  const row = ins.rows[0];
  console.log(`[shop-period] week ${start} → HireHop job ${row.hh_job_number} ("${jobName}")`);

  // The sync exclusion (§3.0) works off this table, so it only protects jobs it
  // already knows about. There is a small window between HireHop creating the
  // job and this row existing, and the 30-minute sync could in principle land
  // in it. Check rather than assume — a shop job sitting in New Enquiries is
  // precisely what the exclusion exists to prevent, and it would look like the
  // guard had failed rather than raced.
  try {
    const leaked = await query(
      `SELECT id FROM jobs WHERE hh_job_number = $1`, [row.hh_job_number],
    );
    if (leaked.rows.length) {
      console.error(
        `[shop-period] ⚠️ HireHop job ${row.hh_job_number} is ALSO in OP's jobs table ` +
        `(row ${leaked.rows[0].id}). It was synced before the exclusion knew about it. ` +
        `Remove that OP row — while it exists, an OP status push could release the week's stock.`,
      );
    }
  } catch {
    // Diagnostic only; never fail the creation over it.
  }
  return {
    id: row.id, periodStart: row.period_start,
    periodEnd: row.period_end, hhJobNumber: Number(row.hh_job_number),
  };
}

/**
 * HireHop job numbers OP must never sync into its own `jobs` table (§3.0).
 *
 * ONE definition, used at every boundary. Three copies of this rule would drift,
 * and the one that drifts is the one that lets a shop job into the pipeline and
 * puts a week of stock at the mercy of a stale-enquiry sweep.
 */
export async function getShopJobNumbers(): Promise<Set<number>> {
  try {
    const r = await query(
      `SELECT hh_job_number FROM shop_sale_periods WHERE hh_job_number IS NOT NULL`,
    );
    return new Set(r.rows.map((x: any) => Number(x.hh_job_number)).filter(Number.isFinite));
  } catch (err) {
    // Fail OPEN on the read: an empty set means the sync behaves exactly as it
    // did before this module existed, which is safe. Silently excluding real
    // jobs because a query failed would not be.
    console.warn('[shop-period] could not read shop job numbers:', err instanceof Error ? err.message : err);
    return new Set();
  }
}

export async function isShopJob(hhJobNumber: number | null | undefined): Promise<boolean> {
  if (!hhJobNumber) return false;
  return (await getShopJobNumbers()).has(Number(hhJobNumber));
}
