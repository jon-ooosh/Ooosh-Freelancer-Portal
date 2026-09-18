/**
 * Staff Calendar & Time — the configurable numbers (spec §13).
 *
 * THE definition. Every threshold this module uses is read here and nowhere
 * else, so there is one place to look when a figure on screen disagrees with
 * what someone expected.
 *
 * WHY SETTINGS AND NOT CONSTANTS. Spec §17 lists nine statutory specifics that
 * want a sanity check from the accountants before go-live — the rounding rule,
 * whether bank holidays are granted, how overtime is paid at year end. All of
 * them are here, so a correction is a settings change and not a deploy. That
 * was the whole argument for them being settings, and until now they were
 * hardcoded defaults with a comment pointing at §13.
 *
 * EVERY GETTER FALLS BACK TO A CODE DEFAULT. A missing or malformed row must
 * never take the module down — it degrades to the documented default and says
 * so in the log. The seeded rows and these defaults are deliberately identical.
 */

import { getSystemSetting } from '../routes/system-settings';
import { DATE_RE } from './staff-day-status';
import { computeBankHolidayDates } from './bank-holidays';

// ── Defaults (identical to what migration 216 seeds) ────────────────────────

export const DEFAULTS = {
  statutoryWeeks: 5.6,
  bankHolidayPolicy: 'use_allowance' as 'use_allowance' | 'granted',
  proRataRounding: 'up_half_day' as 'up_half_day' | 'none',
  overtimeYearEnd: 'cash_out' as 'cash_out' | 'expire',
  overtimeMinIncrementMinutes: 5,
  noticeDaysWarning: 14,
  absenceFlagSpells: 3,
  absenceFlagMonths: 3,
  rtwChaseDays: 7,
  cashOutReminderDay: 8,
  offerChaseDays: 1,
  minHeadcountByWeekday: {} as Record<string, number>,
};

async function num(key: string, fallback: number): Promise<number> {
  const raw = await getSystemSetting(key);
  if (raw === null || raw.trim() === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) {
    console.warn(`[staff-settings] ${key} is not a number ("${raw}") — using ${fallback}`);
    return fallback;
  }
  return n;
}

async function oneOf<T extends string>(key: string, allowed: readonly T[], fallback: T): Promise<T> {
  const raw = (await getSystemSetting(key))?.trim();
  if (!raw) return fallback;
  if (!(allowed as readonly string[]).includes(raw)) {
    console.warn(`[staff-settings] ${key} is "${raw}", not one of ${allowed.join('/')} — using ${fallback}`);
    return fallback;
  }
  return raw as T;
}

// ── Holiday ─────────────────────────────────────────────────────────────────

/**
 * Statutory weeks, the company-wide figure.
 *
 * `staff_employment.entitlement_weeks` overrides it per person and is read by
 * syncEntitlement, not here — a per-person contract beats a company default.
 */
export function getStatutoryWeeks(): Promise<number> {
  return num('staff.statutory_weeks', DEFAULTS.statutoryWeeks);
}

export function getBankHolidayPolicy(): Promise<'use_allowance' | 'granted'> {
  return oneOf('staff.bank_holidays_policy', ['use_allowance', 'granted'] as const, DEFAULTS.bankHolidayPolicy);
}

export function getProRataRounding(): Promise<'up_half_day' | 'none'> {
  return oneOf('staff.pro_rata_rounding', ['up_half_day', 'none'] as const, DEFAULTS.proRataRounding);
}

/**
 * Bank holiday dates for one year, England & Wales.
 *
 * COMPUTED by default (`services/bank-holidays.ts`), because the alternative is
 * a seeded list that silently runs out. Migration 216 seeded 2026–2028, which
 * immediately raised "and who adds 2029?" — the answer is nobody, and the
 * calendar quietly stops marking them.
 *
 * `staff.bank_holidays.<year>` is now an OVERRIDE: leave it empty and the year
 * is computed; put a comma-separated list in it and that list wins outright,
 * for the rare year the arithmetic is wrong. One-off royal bank holidays are
 * NOT handled here — a coronation is "the company is shut", which is a company
 * day (spec §20), not a change to the bank holiday calendar.
 *
 * They are INFORMATIONAL under the current policy: `use_allowance` means a bank
 * holiday is an ordinary working day and someone wanting it off books it like
 * any other. They are emphatically NOT seeded as pattern exceptions — that
 * would make them non-working and silently give everyone eight free days.
 */
export async function getBankHolidays(year: number): Promise<string[]> {
  const raw = await getSystemSetting(`staff.bank_holidays.${year}`);
  if (!raw || raw.trim() === '') return computeBankHolidayDates(year);

  const dates = raw.split(',').map(s => s.trim()).filter(Boolean);
  const good = dates.filter(d => DATE_RE.test(d) && d.slice(0, 4) === String(year));
  if (good.length !== dates.length) {
    console.warn(`[staff-settings] staff.bank_holidays.${year} has entries that are not ${year} YYYY-MM-DD dates — ignoring those`);
  }
  // An override that turns out to be entirely junk falls back to the computed
  // list rather than leaving the year blank.
  if (good.length === 0) {
    console.warn(`[staff-settings] staff.bank_holidays.${year} had nothing usable — computing instead`);
    return computeBankHolidayDates(year);
  }
  return good.sort();
}

/** Bank holidays touching a date range, across however many years it spans. */
export async function getBankHolidaysInRange(from: string, to: string): Promise<string[]> {
  const years: number[] = [];
  for (let y = Number(from.slice(0, 4)); y <= Number(to.slice(0, 4)); y++) years.push(y);
  const all = await Promise.all(years.map(getBankHolidays));
  return all.flat().filter(d => d >= from && d <= to).sort();
}

// ── Overtime ────────────────────────────────────────────────────────────────

export function getOvertimeYearEnd(): Promise<'cash_out' | 'expire'> {
  return oneOf('staff.overtime_year_end', ['cash_out', 'expire'] as const, DEFAULTS.overtimeYearEnd);
}

/**
 * The overtime step, in minutes.
 *
 * CAVEAT, and it is a real one: `staff_overtime_entries` carries a CHECK of
 * `minutes % 5 = 0` from migration 212. This setting drives the UI step and the
 * service-side validation, so lowering it to 1 here WITHOUT a migration
 * relaxing that constraint would leave the database refusing what the form
 * offers. Raising it (to 15, say) is safe on its own.
 */
export function getOvertimeMinIncrement(): Promise<number> {
  return num('staff.overtime_min_increment_minutes', DEFAULTS.overtimeMinIncrementMinutes);
}

/**
 * Which day of December the year-end cash-out reminder goes out.
 *
 * A REMINDER, not the sweep itself — see the scheduler. Early enough that the
 * figures reach whoever runs December payroll before it closes (spec §17.2).
 */
export function getCashOutReminderDay(): Promise<number> {
  return num('staff.overtime_cashout_reminder_day', DEFAULTS.cashOutReminderDay);
}

// ── Leave requests ──────────────────────────────────────────────────────────

/** Short-notice threshold. A WARNING, never a block (spec §5.2). */
export function getNoticeDaysWarning(): Promise<number> {
  return num('staff.notice_days_warning', DEFAULTS.noticeDaysWarning);
}

/**
 * Minimum bodies wanted per weekday, Monday = 0 … Sunday = 6.
 *
 * JSON object keyed by weekday index, e.g. {"0":2,"4":1}. Empty means no
 * coverage floor is defined and the impact preview simply reports headcount.
 * Also a warning, never a block.
 */
export async function getMinHeadcountByWeekday(): Promise<Record<string, number>> {
  const raw = await getSystemSetting('staff.min_headcount_by_weekday');
  if (!raw || raw.trim() === '' || raw.trim() === '{}') return {};
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object');
    const out: Record<string, number> = {};
    for (const [k, v] of Object.entries(parsed)) {
      const n = Number(v);
      if (/^[0-6]$/.test(k) && Number.isFinite(n) && n >= 0) out[k] = n;
    }
    return out;
  } catch (e) {
    console.warn('[staff-settings] staff.min_headcount_by_weekday is not valid JSON — ignoring:', e);
    return {};
  }
}

// ── Absence ─────────────────────────────────────────────────────────────────

/** Repeat-absence flag: this many spells within this many months (spec §7.6). */
export async function getAbsenceFlag(): Promise<{ spells: number; months: number }> {
  const [spells, months] = await Promise.all([
    num('staff.absence_flag_spells', DEFAULTS.absenceFlagSpells),
    num('staff.absence_flag_months', DEFAULTS.absenceFlagMonths),
  ]);
  return { spells, months };
}

/** Days after a yard-day offer before the ONE chase to the freelancer (§9.4). */
export function getOfferChaseDays(): Promise<number> {
  return num('staff.offer_chase_days', DEFAULTS.offerChaseDays);
}

/** Days after a sickness closes before the one return-to-work chase (§7.3). */
export function getRtwChaseDays(): Promise<number> {
  return num('staff.rtw_chase_days', DEFAULTS.rtwChaseDays);
}
