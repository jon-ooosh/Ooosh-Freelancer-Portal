/**
 * Which HireHop price group (A / B / C) a NEW job is created on.
 *
 * HireHop holds every price; each stock item has Price A, B and C, and a job
 * prices its lines from ONE group (`price_group` on save_job.php: 0 = A,
 * 1 = B, 2 = C). OP creates every job, so a yearly price change is: load the
 * new prices into a spare group ahead of time, then set these two settings and
 * every job OP creates from that date is born on the new group. Jobs created
 * before keep their own group and the prices already on their lines — a quote
 * or booking made in the old year is honoured at the old price.
 * The runbook is docs/PRICE-LIST-CHANGE.md.
 *
 * Settings (system_settings, category 'hirehop'; Settings › HireHop prices):
 *   hh_price_group       'A' | 'B' | 'C', or empty = send nothing (HireHop's default, A)
 *   hh_price_group_from  YYYY-MM-DD the group applies from (UK date), or empty = now
 *
 * Only job CREATION reads this. A duplicated job (quote option, Re-open) is a
 * copy made by HireHop and keeps its source's group and prices.
 */
import { getSystemSettings } from '../routes/system-settings';
import { ukToday } from './uk-date';

export const PRICE_GROUP_KEY = 'hh_price_group';
export const PRICE_GROUP_FROM_KEY = 'hh_price_group_from';

const GROUP_INDEX: Record<string, number> = { A: 0, B: 1, C: 2 };

/**
 * The `price_group` to send for a job created on `today`, or null to send
 * nothing. A malformed setting sends nothing rather than guessing.
 */
export function pickPriceGroup(group: string | null, from: string | null, today: string): number | null {
  const g = (group ?? '').trim().toUpperCase();
  if (!(g in GROUP_INDEX)) return null;
  const f = (from ?? '').trim();
  if (f && !/^\d{4}-\d{2}-\d{2}$/.test(f)) return null;
  if (f && today < f) return null; // YYYY-MM-DD compares as text
  return GROUP_INDEX[g];
}

/** The price group for a job being created in HireHop now (null = leave HireHop's default). */
export async function priceGroupForNewJob(): Promise<number | null> {
  const s = await getSystemSettings([PRICE_GROUP_KEY, PRICE_GROUP_FROM_KEY]);
  return pickPriceGroup(s[PRICE_GROUP_KEY] ?? null, s[PRICE_GROUP_FROM_KEY] ?? null, ukToday());
}
