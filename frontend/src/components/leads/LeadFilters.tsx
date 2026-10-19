/**
 * The Leads page filter bar + the filter logic. Filters live in the URL so a
 * view can be shared or bookmarked ("the 6 Oct batch, international, 8+").
 *
 * Every value read back from the URL is validated — a stale or hand-edited
 * link falls back to "any" rather than crashing the page.
 */
import type { Lead, LeadRun } from './leadTypes';
import { fmtDate } from './leadTypes';

export interface LeadFilterState {
  q: string;
  /** '' = all searches; otherwise a lead_runs id (the search that FOUND the lead). */
  run: string;
  /** '' or 'YYYY-MM' — tour start month. */
  month: string;
  /** '' | '6' | '8' — minimum AI score. */
  score: string;
  /** '' | 'warm' | 'cold'. */
  type: string;
  /** '' | 'has' | 'none' | 'known'. */
  contacts: string;
  intl: boolean;
  /** Show tours that have already started (hidden by default on To review / Contacted). */
  started: boolean;
  /** Contacted tab: only outreach logged 14+ days ago. */
  stale: boolean;
}

export const EMPTY_FILTERS: LeadFilterState = {
  q: '', run: '', month: '', score: '', type: '', contacts: '', intl: false, started: false, stale: false,
};

const pick = (v: string | null, allowed: string[]): string => (v && allowed.includes(v) ? v : '');

export function filtersFromParams(p: URLSearchParams): LeadFilterState {
  const run = p.get('run') ?? '';
  const month = p.get('month') ?? '';
  return {
    q: (p.get('q') ?? '').slice(0, 100),
    run: /^[0-9a-f-]{36}$/i.test(run) ? run : '',
    month: /^\d{4}-\d{2}$/.test(month) ? month : '',
    score: pick(p.get('score'), ['6', '8']),
    type: pick(p.get('type'), ['warm', 'cold']),
    contacts: pick(p.get('contacts'), ['has', 'none', 'known']),
    intl: p.get('intl') === '1',
    started: p.get('started') === '1',
    stale: p.get('stale') === '1',
  };
}

/** Write the filters into a copy of the params (other params — tab, lead — are kept). */
export function filtersToParams(f: LeadFilterState, base: URLSearchParams): URLSearchParams {
  const p = new URLSearchParams(base);
  const set = (k: string, v: string | boolean) => {
    if (v === '' || v === false) p.delete(k);
    else p.set(k, v === true ? '1' : v);
  };
  set('q', f.q.trim()); set('run', f.run); set('month', f.month); set('score', f.score);
  set('type', f.type); set('contacts', f.contacts); set('intl', f.intl); set('started', f.started); set('stale', f.stale);
  return p;
}

export function activeFilterCount(f: LeadFilterState): number {
  return [f.q.trim(), f.run, f.month, f.score, f.type, f.contacts, f.intl, f.stale].filter(Boolean).length;
}

const STALE_DAYS = 14;

/** Has the tour already started? (first UK date before today) */
export function tourStarted(l: Lead, today: string): boolean {
  return Boolean(l.first_date) && String(l.first_date).slice(0, 10) < today;
}

/** Everything EXCEPT the stage tab and the "already started" rule. */
export function applyLeadFilters(leads: Lead[], f: LeadFilterState): Lead[] {
  const q = f.q.trim().toLowerCase();
  const staleCutoff = Date.now() - STALE_DAYS * 86_400_000;
  return leads.filter((l) => {
    if (q && !(l.artist_name.toLowerCase().includes(q) || (l.origin_country ?? '').toLowerCase().includes(q)
      || (l.matched_org_name ?? '').toLowerCase().includes(q))) return false;
    if (f.run && l.first_run_id !== f.run) return false;
    if (f.month && String(l.first_date ?? '').slice(0, 7) !== f.month) return false;
    if (f.score && (l.relevance_score ?? -1) < Number(f.score)) return false;
    if (f.type && l.stream !== f.type) return false;
    if (f.contacts === 'has' && !(l.contacts?.length > 0)) return false;
    if (f.contacts === 'none' && l.contacts?.length > 0) return false;
    if (f.contacts === 'known' && !(l.known_contacts?.length > 0)) return false;
    if (f.intl && !l.is_international) return false;
    if (f.stale && !(l.contacted_at && new Date(l.contacted_at).getTime() < staleCutoff)) return false;
    return true;
  });
}

function monthLabel(ym: string): string {
  const d = new Date(`${ym}-01T00:00:00Z`);
  return Number.isNaN(d.getTime()) ? ym : d.toLocaleDateString('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' });
}

const SELECT = 'rounded-lg border border-gray-300 bg-white px-2 py-1.5 text-sm text-gray-700';

export default function LeadFilters({ value, onChange, leads, runs, showStale, shown, total }: {
  value: LeadFilterState;
  onChange: (f: LeadFilterState) => void;
  /** All loaded leads — for the month list. */
  leads: Lead[];
  /** Search history — for the batch list. */
  runs: LeadRun[];
  /** The Contacted tab offers "14+ days, no enquiry". */
  showStale: boolean;
  shown: number;
  total: number;
}) {
  const set = (patch: Partial<LeadFilterState>) => onChange({ ...value, ...patch });
  const months = Array.from(new Set(leads.map((l) => String(l.first_date ?? '').slice(0, 7)).filter((m) => /^\d{4}-\d{2}$/.test(m)))).sort();
  // Searches that found something — Re-process runs find nothing new.
  const batches = runs.filter((r) => (r.leads_found ?? 0) > 0);
  const runKnown = !value.run || batches.some((r) => r.id === value.run);
  const active = activeFilterCount(value);

  return (
    <div className="flex flex-wrap items-center gap-2 mb-3">
      <input value={value.q} onChange={(e) => set({ q: e.target.value })} placeholder="Search band, origin or org…"
        className="px-3 py-1.5 rounded-lg border border-gray-300 text-sm w-52 max-w-full" />
      <select value={value.run} onChange={(e) => set({ run: e.target.value })} className={SELECT} title="Which search found the lead">
        <option value="">All searches</option>
        {batches.map((r, i) => (
          <option key={r.id} value={r.id}>
            {i === 0 ? 'Latest search · ' : ''}{fmtDate(r.started_at)}{r.triggered_by_name ? ` · ${r.triggered_by_name}` : ''} ({r.leads_found})
          </option>
        ))}
        {!runKnown && <option value={value.run}>An older search</option>}
      </select>
      <select value={value.month} onChange={(e) => set({ month: e.target.value })} className={SELECT} title="Tour start month">
        <option value="">Any start month</option>
        {months.map((m) => <option key={m} value={m}>{monthLabel(m)}</option>)}
        {value.month && !months.includes(value.month) && <option value={value.month}>{monthLabel(value.month)}</option>}
      </select>
      <select value={value.score} onChange={(e) => set({ score: e.target.value })} className={SELECT}>
        <option value="">Any score</option>
        <option value="6">Score 6+</option>
        <option value="8">Score 8+</option>
      </select>
      <select value={value.type} onChange={(e) => set({ type: e.target.value })} className={SELECT}>
        <option value="">Warm + cold</option>
        <option value="warm">Warm only (known bands)</option>
        <option value="cold">Cold only</option>
      </select>
      <select value={value.contacts} onChange={(e) => set({ contacts: e.target.value })} className={SELECT}>
        <option value="">Any contacts</option>
        <option value="has">Has contacts</option>
        <option value="none">No contacts yet</option>
        <option value="known">Known contact in our book</option>
      </select>
      <label className="flex items-center gap-1.5 text-sm text-gray-600 cursor-pointer">
        <input type="checkbox" checked={value.intl} onChange={(e) => set({ intl: e.target.checked })} /> International
      </label>
      {showStale && (
        <label className="flex items-center gap-1.5 text-sm text-gray-600 cursor-pointer" title="Outreach logged 14+ days ago and still no enquiry">
          <input type="checkbox" checked={value.stale} onChange={(e) => set({ stale: e.target.checked })} /> No reply in 14+ days
        </label>
      )}
      <span className="ml-auto text-xs text-gray-400 whitespace-nowrap">
        {active > 0 ? (
          <>Showing {shown} of {total} · <button onClick={() => onChange({ ...EMPTY_FILTERS, started: value.started })} className="text-[#7B5EA7] hover:underline">clear filters</button></>
        ) : `${total} lead${total === 1 ? '' : 's'}`}
      </span>
    </div>
  );
}
