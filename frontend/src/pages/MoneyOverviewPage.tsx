/**
 * MoneyOverviewPage — global financial dashboard at /money/overview.
 *
 * Reads OP's cached `job_financials` (write-through from each job's Money tab)
 * + live excess (canonical v_excess_held) + pending refunds via
 * GET /api/money/overview. No HireHop calls — instant. Each table is
 * searchable and click-to-sort by column.
 */
import { useState, useEffect, useCallback, useMemo } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../services/api';
import { useAuthStore } from '../hooks/useAuthStore';
import { hasManagerRole } from '../lib/roles';

interface BalanceRow {
  job_id: string; hh_job_number: number | null; job_name: string | null;
  client_name: string | null; pipeline_status: string | null;
  job_date: string | null; job_end: string | null; return_date: string | null;
  hire_value_inc_vat: string; total_hire_deposits: string; balance_outstanding: string;
  vat_saved: string; last_synced_at: string;
  // Present only on resolved rows (migration 117 business override).
  override_reason?: string | null; override_notes?: string | null;
  override_resolved_at?: string | null; override_resolved_by_name?: string | null;
  // Debt-chase tracker (migration 120).
  chase_count?: number | null; last_chased_at?: string | null; last_chased_by_name?: string | null;
}
interface DepositPendingRow {
  job_id: string; hh_job_number: number | null; job_name: string | null;
  client_name: string | null; pipeline_status: string | null;
  job_date: string | null; out_date: string | null;
  hire_value_inc_vat: string; total_hire_deposits: string; last_synced_at: string;
}
interface ExcessHeldRow {
  excess_id: string; job_id: string; hh_job_number: number | null;
  client_name: string | null; excess_status: string;
  amount_taken: string; amount_held: string; held_amount: string;
  finished_on: string | null; hire_finished: boolean;
}
interface PendingRefundRow {
  id: number; job_id: string; hh_job_number: number | null;
  client_name: string | null; amount: string; notes: string | null; payment_date: string;
}
interface OverviewData {
  balances_outstanding: BalanceRow[];
  balances_resolved: BalanceRow[];
  deposits_pending: DepositPendingRow[];
  excess_held: ExcessHeldRow[];
  pending_refunds: PendingRefundRow[];
  totals: {
    balance_outstanding: number; balances_count: number;
    balances_resolved_total: number; balances_resolved_count: number;
    deposits_pending_count: number;
    excess_held: number; excess_held_count: number;
    excess_held_upcoming: number; excess_held_upcoming_count: number;
    excess_held_past: number; excess_held_past_count: number;
    pending_refunds: number; pending_refunds_count: number;
  };
}

const gbp = (n: number | string | null) =>
  '£' + (parseFloat(String(n ?? 0))).toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

// Filter prefs persist across navigation (localStorage) — staff set their view
// once and it holds when they come back.
type Timing = 'all' | 'finished' | 'upcoming';
type Tab = 'balances' | 'deposits' | 'excess' | 'refunds';
const PREFS_KEY = 'ooosh_money_overview_prefs';
interface OverviewPrefs { tab: Tab; includeSpeculative: boolean; balancesTiming: Timing; excessTiming: Timing; groupByClient: boolean }
const DEFAULT_PREFS: OverviewPrefs = { tab: 'balances', includeSpeculative: false, balancesTiming: 'all', excessTiming: 'all', groupByClient: false };
function loadPrefs(): OverviewPrefs {
  try {
    const raw = localStorage.getItem(PREFS_KEY);
    if (raw) {
      const p = { ...DEFAULT_PREFS, ...JSON.parse(raw) } as OverviewPrefs;
      // Guard against stale/garbage values from older builds.
      if (!['balances', 'deposits', 'excess', 'refunds'].includes(p.tab)) p.tab = DEFAULT_PREFS.tab;
      if (!['all', 'finished', 'upcoming'].includes(p.balancesTiming)) p.balancesTiming = 'all';
      if (!['all', 'finished', 'upcoming'].includes(p.excessTiming)) p.excessTiming = 'all';
      return p;
    }
  } catch { /* corrupted/blocked storage — fall through to defaults */ }
  return DEFAULT_PREFS;
}

// A date-only "is this in the past?" check — finished means the hire end date
// is before today (today itself still counts as upcoming/live).
function isPastDate(d: string | null): boolean {
  if (!d) return false;
  const today = new Date(); today.setHours(0, 0, 0, 0);
  return new Date(d).getTime() < today.getTime();
}

function daysAgo(d: string | null): number | null {
  if (!d) return null;
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const days = Math.floor((today.getTime() - new Date(d).getTime()) / 86_400_000);
  return days > 0 ? days : null;
}

// Ageing badge on finished hires — the older the debt, the louder the badge.
function AgeBadge({ date }: { date: string | null }) {
  const days = daysAgo(date);
  if (days === null) return null;
  const cls = days > 90 ? 'bg-red-100 text-red-700'
    : days > 30 ? 'bg-amber-100 text-amber-800'
    : 'bg-gray-100 text-gray-500';
  return <span className={`ml-1.5 text-[10px] px-1.5 py-0.5 rounded whitespace-nowrap ${cls}`}>{days}d ago</span>;
}

function TimingPills({ value, onChange }: { value: Timing; onChange: (t: Timing) => void }) {
  const opts: { v: Timing; label: string }[] = [
    { v: 'all', label: 'All' },
    { v: 'finished', label: 'Finished' },
    { v: 'upcoming', label: 'Upcoming' },
  ];
  return (
    <div className="inline-flex rounded-md border border-gray-300 overflow-hidden text-xs">
      {opts.map((o, i) => (
        <button key={o.v} type="button" onClick={() => onChange(o.v)}
          className={`px-2.5 py-1 ${i > 0 ? 'border-l border-gray-300' : ''} ${
            value === o.v ? 'bg-ooosh-600 text-white' : 'bg-white text-gray-600 hover:bg-gray-50'
          }`}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

const fmtDate = (d: string | null) =>
  d ? new Date(d).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) : '—';

const dateMs = (d: string | null) => (d ? new Date(d).getTime() : 0);
const jobHref = (r: { job_id: string }) => `/jobs/${r.job_id}`;

// Status colour palette — aligned with the pipeline status colours used
// elsewhere (confirmed = green, etc.). Falls back to neutral grey.
const STATUS_COLOURS: Record<string, string> = {
  // pipeline
  new_enquiry: 'bg-gray-100 text-gray-700', quoting: 'bg-gray-100 text-gray-700',
  paused: 'bg-gray-100 text-gray-500', provisional: 'bg-yellow-100 text-yellow-800',
  confirmed: 'bg-green-100 text-green-800', prepping: 'bg-blue-100 text-blue-800',
  prepped: 'bg-blue-100 text-blue-800', dispatched: 'bg-indigo-100 text-indigo-800',
  returned_incomplete: 'bg-amber-100 text-amber-800', returned: 'bg-amber-100 text-amber-800',
  completed: 'bg-emerald-100 text-emerald-800', cancelled: 'bg-red-100 text-red-700',
  lost: 'bg-gray-200 text-gray-600',
  // excess
  needed: 'bg-gray-100 text-gray-700', taken: 'bg-blue-100 text-blue-800',
  partially_paid: 'bg-amber-100 text-amber-800', pre_auth: 'bg-purple-100 text-purple-800',
  reimbursed: 'bg-gray-100 text-gray-600', partially_reimbursed: 'bg-amber-100 text-amber-800',
  fully_claimed: 'bg-orange-100 text-orange-800', rolled_over: 'bg-teal-100 text-teal-800',
  waived: 'bg-gray-100 text-gray-500', released: 'bg-gray-100 text-gray-500',
};

function Pill({ text }: { text: string }) {
  const cls = STATUS_COLOURS[text] || 'bg-gray-100 text-gray-700';
  return <span className={`text-[11px] px-2 py-0.5 rounded capitalize ${cls}`}>{text.replace(/_/g, ' ')}</span>;
}

function JobRef({ hh, name }: { hh: number | null; name: string | null }) {
  return (
    <span>
      <span className="font-medium text-ooosh-700">#{hh ?? '—'}</span>
      {name && <span className="text-gray-500 text-xs block">{name}</span>}
    </span>
  );
}

// Business-level balance-override reasons (migration 117).
const RESOLVE_REASONS = [
  { value: 'xero_settled', label: 'Settled in Xero (not fed back to HireHop)' },
  { value: 'internal_discounted', label: 'Internal / discounted job' },
  { value: 'hh_xero_corrected', label: 'Corrected HireHop↔Xero error' },
  { value: 'write_off', label: 'Write-off (bad debt / goodwill)' },
  { value: 'other', label: 'Other' },
];
const REASON_LABEL: Record<string, string> = Object.fromEntries(RESOLVE_REASONS.map((r) => [r.value, r.label]));

// Resolve-balance modal — single (a BalanceRow) or bulk ('bulk', date-based).
// Admin only. Flags the HH-derived balance as a business adjustment; does NOT
// touch HireHop or Xero.
function ResolveBalanceModal({ target, onClose, onDone }: {
  target: BalanceRow | 'bulk';
  onClose: () => void;
  onDone: (msg: string) => void;
}) {
  const isBulk = target === 'bulk';
  const [reason, setReason] = useState('xero_settled');
  const [notes, setNotes] = useState('');
  const [beforeDate, setBeforeDate] = useState('');
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState('');

  const submit = async () => {
    setSaving(true); setErr('');
    try {
      if (isBulk) {
        if (!beforeDate) throw new Error('Pick a "finished before" date');
        const res = await api.post<{ resolved: number }>('/money/balances/bulk-resolve', {
          reason, notes: notes || null, finished_before: beforeDate,
        });
        onDone(`Resolved ${res.resolved} balance${res.resolved === 1 ? '' : 's'}`);
      } else {
        await api.post(`/money/${target.job_id}/resolve-balance`, { reason, notes: notes || null });
        onDone('Balance resolved');
      }
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Failed');
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4" onClick={onClose}>
      <div className="bg-white rounded-xl shadow-xl max-w-md w-full p-5" onClick={(e) => e.stopPropagation()}>
        <h3 className="text-lg font-semibold text-gray-900 mb-1">
          {isBulk ? 'Bulk resolve outstanding balances' : 'Resolve balance'}
        </h3>
        {isBulk ? (
          <p className="text-xs text-gray-500 mb-3">
            Flags every still-outstanding (non-cancelled) job that finished before the chosen date as resolved.
            Doesn't touch HireHop or Xero — it just removes them from the active Outstanding list.
          </p>
        ) : (
          <p className="text-xs text-gray-500 mb-3">
            #{target.hh_job_number ?? '—'}{target.client_name ? ` · ${target.client_name}` : ''} · {gbp(target.balance_outstanding)} outstanding.
            Doesn't touch HireHop or Xero.
          </p>
        )}

        {isBulk && (
          <div className="mb-3">
            <label className="block text-xs font-medium text-gray-600 mb-1">Finished before</label>
            <input type="date" value={beforeDate} onChange={(e) => setBeforeDate(e.target.value)}
              className="w-full text-sm border border-gray-300 rounded-md px-3 py-2" />
          </div>
        )}

        <div className="mb-3">
          <label className="block text-xs font-medium text-gray-600 mb-1">Reason</label>
          <select value={reason} onChange={(e) => setReason(e.target.value)}
            className="w-full text-sm border border-gray-300 rounded-md px-3 py-2">
            {RESOLVE_REASONS.map((r) => <option key={r.value} value={r.value}>{r.label}</option>)}
          </select>
        </div>

        <div className="mb-4">
          <label className="block text-xs font-medium text-gray-600 mb-1">Notes (optional)</label>
          <textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={2}
            className="w-full text-sm border border-gray-300 rounded-md px-3 py-2 resize-y" />
        </div>

        {err && <p className="text-xs text-red-600 mb-3">{err}</p>}

        <div className="flex justify-end gap-2">
          <button onClick={onClose} className="px-3 py-1.5 text-sm text-gray-600 hover:text-gray-800">Cancel</button>
          <button onClick={submit} disabled={saving}
            className="px-4 py-1.5 text-sm font-medium text-white bg-ooosh-600 rounded-md hover:bg-ooosh-700 disabled:opacity-50">
            {saving ? 'Saving…' : isBulk ? 'Resolve matching' : 'Resolve'}
          </button>
        </div>
      </div>
    </div>
  );
}

// Pending-refund dismiss reasons (mirror of money.ts DISMISS_REFUND_REASONS).
const DISMISS_REASONS = [
  { value: 'refunded_externally', label: 'Already refunded outside OP (HireHop / Stripe / bank)' },
  { value: 'not_required', label: 'Not required (artifact / superseded)' },
  { value: 'duplicate', label: 'Duplicate record' },
  { value: 'other', label: 'Other' },
];

// Dismiss-refund modal — single (a PendingRefundRow) or bulk ('bulk', date-based).
// Clears the OP IOU WITHOUT moving money — for refunds already done out-of-band
// or pre-refund-tracking artifacts. Does NOT touch HireHop / Stripe / Xero.
function DismissRefundModal({ target, isAdmin, onClose, onDone }: {
  target: PendingRefundRow | 'bulk';
  isAdmin: boolean;
  onClose: () => void;
  onDone: (msg: string) => void;
}) {
  const isBulk = target === 'bulk';
  const [reason, setReason] = useState('refunded_externally');
  const [notes, setNotes] = useState('');
  const [beforeDate, setBeforeDate] = useState('');
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState('');

  const submit = async () => {
    setSaving(true); setErr('');
    try {
      if (isBulk) {
        if (!beforeDate) throw new Error('Pick a "logged before" date');
        const res = await api.post<{ dismissed: number }>('/money/refunds/bulk-dismiss', {
          reason, notes: notes || null, logged_before: beforeDate,
        });
        onDone(`Cleared ${res.dismissed} pending refund${res.dismissed === 1 ? '' : 's'}`);
      } else {
        await api.post(`/money/${target.job_id}/dismiss-refund`, {
          refund_id: String(target.id), reason, notes: notes || null,
        });
        onDone('Pending refund cleared');
      }
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Failed');
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4" onClick={onClose}>
      <div className="bg-white rounded-xl shadow-xl max-w-md w-full p-5" onClick={(e) => e.stopPropagation()}>
        <h3 className="text-lg font-semibold text-gray-900 mb-1">
          {isBulk ? 'Bulk clear pending refunds' : 'Clear pending refund'}
        </h3>
        {isBulk ? (
          <p className="text-xs text-gray-500 mb-3">
            Clears every pending refund logged before the chosen date. Use for the backlog from
            before refund tracking was finished. Does NOT move any money or touch HireHop / Stripe / Xero.
          </p>
        ) : (
          <p className="text-xs text-gray-500 mb-3">
            #{target.hh_job_number ?? '—'}{target.client_name ? ` · ${target.client_name}` : ''} · {gbp(target.amount)}.
            Clears this IOU — no money moves. Use when the refund was already handled in HireHop / Stripe / the bank,
            or shouldn't have been logged. To actually send a refund, use the Money tab on the job instead.
          </p>
        )}

        {isBulk && (
          <div className="mb-3">
            <label className="block text-xs font-medium text-gray-600 mb-1">Logged before</label>
            <input type="date" value={beforeDate} onChange={(e) => setBeforeDate(e.target.value)}
              className="w-full text-sm border border-gray-300 rounded-md px-3 py-2" />
          </div>
        )}

        <div className="mb-3">
          <label className="block text-xs font-medium text-gray-600 mb-1">Reason</label>
          <select value={reason} onChange={(e) => setReason(e.target.value)}
            className="w-full text-sm border border-gray-300 rounded-md px-3 py-2">
            {DISMISS_REASONS.map((r) => <option key={r.value} value={r.value}>{r.label}</option>)}
          </select>
        </div>

        <div className="mb-4">
          <label className="block text-xs font-medium text-gray-600 mb-1">Notes (optional)</label>
          <textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={2}
            placeholder="e.g. refunded £150 in full direct in HireHop"
            className="w-full text-sm border border-gray-300 rounded-md px-3 py-2 resize-y" />
        </div>

        {err && <p className="text-xs text-red-600 mb-3">{err}</p>}
        {isBulk && !isAdmin && <p className="text-xs text-amber-600 mb-3">Bulk clear is admin-only.</p>}

        <div className="flex justify-end gap-2">
          <button onClick={onClose} className="px-3 py-1.5 text-sm text-gray-600 hover:text-gray-800">Cancel</button>
          <button onClick={submit} disabled={saving || (isBulk && !isAdmin)}
            className="px-4 py-1.5 text-sm font-medium text-white bg-ooosh-600 rounded-md hover:bg-ooosh-700 disabled:opacity-50">
            {saving ? 'Saving…' : isBulk ? 'Clear matching' : 'Clear refund'}
          </button>
        </div>
      </div>
    </div>
  );
}

// Debt-chase tracker button: count + click-to-log, hover for the last chase.
// Undo lives in the toast the parent shows after logging.
function ChaseButton({ row, onChase }: { row: BalanceRow; onChase: (r: BalanceRow) => void }) {
  const n = row.chase_count || 0;
  const title = n > 0
    ? `Chased ${n}× — last ${fmtDate(row.last_chased_at ?? null)}${row.last_chased_by_name ? ` by ${row.last_chased_by_name}` : ''}. Click to log another chase.`
    : 'No chases logged yet — click to log one (call / email about this balance)';
  return (
    <button
      onClick={(e) => { e.preventDefault(); e.stopPropagation(); onChase(row); }}
      title={title}
      className={`text-xs px-2 py-0.5 rounded-full border whitespace-nowrap ${
        n > 0
          ? 'bg-amber-50 border-amber-200 text-amber-800 hover:bg-amber-100'
          : 'bg-white border-gray-200 text-gray-400 hover:text-gray-600 hover:border-gray-300'
      }`}
    >
      📣 {n > 0 ? n : 'Chase'}
    </button>
  );
}

// Grouped balances view — one chase per client, not one per job. Sorted by
// total outstanding (biggest debt first); expand a client to see their jobs.
function GroupedBalances({ rows, isAdmin, onResolve, onChase }: {
  rows: BalanceRow[];
  isAdmin: boolean;
  onResolve: (r: BalanceRow) => void;
  onChase: (r: BalanceRow) => void;
}) {
  const [q, setQ] = useState('');
  const [open, setOpen] = useState<Record<string, boolean>>({});

  const groups = useMemo(() => {
    const map = new Map<string, BalanceRow[]>();
    for (const r of rows) {
      const key = r.client_name || 'Unknown client';
      const list = map.get(key) || [];
      list.push(r);
      map.set(key, list);
    }
    const needle = q.trim().toLowerCase();
    return Array.from(map.entries())
      .filter(([client]) => !needle || client.toLowerCase().includes(needle))
      .map(([client, jobs]) => ({
        client,
        jobs: jobs.slice().sort((a, b) => dateMs(a.job_end || a.return_date) - dateMs(b.job_end || b.return_date)),
        total: jobs.reduce((s, j) => s + parseFloat(j.balance_outstanding), 0),
        oldest: jobs.reduce<string | null>((acc, j) => {
          const d = j.job_end || j.return_date;
          return d && (!acc || dateMs(d) < dateMs(acc)) ? d : acc;
        }, null),
      }))
      .sort((a, b) => b.total - a.total);
  }, [rows, q]);

  return (
    <div>
      <div className="flex items-center gap-3 px-4 py-3 border-b border-gray-100">
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search client…"
          className="flex-1 max-w-xs px-3 py-1.5 text-sm border border-gray-300 rounded-md"
        />
        <span className="text-xs text-gray-400">{groups.length} client{groups.length === 1 ? '' : 's'}</span>
      </div>
      {groups.length === 0 ? (
        <p className="p-6 text-sm text-gray-500">{rows.length === 0 ? 'No outstanding balances on synced jobs.' : 'No matches.'}</p>
      ) : (
        <div className="divide-y divide-gray-100">
          {groups.map((g) => (
            <div key={g.client}>
              <button
                onClick={() => setOpen((o) => ({ ...o, [g.client]: !o[g.client] }))}
                className="w-full flex items-center justify-between gap-3 px-4 py-2.5 text-left hover:bg-gray-50"
              >
                <span className="flex items-center gap-2 min-w-0">
                  <span className="text-gray-400 text-xs">{open[g.client] ? '▾' : '▸'}</span>
                  <span className="text-sm font-medium text-gray-800 truncate">{g.client}</span>
                  <span className="text-xs text-gray-400 whitespace-nowrap">{g.jobs.length} job{g.jobs.length === 1 ? '' : 's'}</span>
                  {isPastDate(g.oldest) && <AgeBadge date={g.oldest} />}
                </span>
                <span className="text-sm font-semibold text-red-700 whitespace-nowrap">{gbp(g.total)}</span>
              </button>
              {open[g.client] && (
                <div className="bg-gray-50/60 px-4 pb-2">
                  <table className="w-full text-sm">
                    <tbody className="divide-y divide-gray-100">
                      {g.jobs.map((r) => (
                        <tr key={r.job_id}>
                          <td className="py-2 pr-3">
                            <Link to={jobHref(r)} className="hover:underline"><JobRef hh={r.hh_job_number} name={r.job_name} /></Link>
                          </td>
                          <td className="py-2 pr-3"><Pill text={r.pipeline_status || '—'} /></td>
                          <td className="py-2 pr-3 whitespace-nowrap text-gray-600">
                            {fmtDate(r.job_end || r.return_date)}<AgeBadge date={r.job_end || r.return_date} />
                          </td>
                          <td className="py-2 pr-3 text-right font-semibold text-red-700 whitespace-nowrap">{gbp(r.balance_outstanding)}</td>
                          <td className="py-2 pr-3 text-right"><ChaseButton row={r} onChase={onChase} /></td>
                          {isAdmin && (
                            <td className="py-2 text-right">
                              <button
                                onClick={() => onResolve(r)}
                                className="text-xs text-gray-500 hover:text-ooosh-700 underline whitespace-nowrap"
                              >Resolve</button>
                            </td>
                          )}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

type Col = { label: string; sortable?: boolean; align?: 'right' };
type Row = { key: string; href: string; cells: React.ReactNode[]; sort: (string | number)[]; search: string };

function Table({ columns, rows, empty }: { columns: Col[]; rows: Row[]; empty: string }) {
  const [q, setQ] = useState('');
  const [sortIdx, setSortIdx] = useState<number | null>(null);
  const [dir, setDir] = useState<'asc' | 'desc'>('asc');

  const view = useMemo(() => {
    const needle = q.trim().toLowerCase();
    let out = needle ? rows.filter((r) => r.search.toLowerCase().includes(needle)) : rows.slice();
    if (sortIdx !== null) {
      out.sort((a, b) => {
        const av = a.sort[sortIdx]; const bv = b.sort[sortIdx];
        let cmp: number;
        if (typeof av === 'number' && typeof bv === 'number') cmp = av - bv;
        else cmp = String(av).localeCompare(String(bv));
        return dir === 'asc' ? cmp : -cmp;
      });
    }
    return out;
  }, [rows, q, sortIdx, dir]);

  const clickSort = (i: number) => {
    if (!columns[i].sortable) return;
    if (sortIdx === i) setDir(dir === 'asc' ? 'desc' : 'asc');
    else { setSortIdx(i); setDir('asc'); }
  };

  return (
    <div>
      <div className="flex items-center gap-3 px-4 py-3 border-b border-gray-100">
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search job, client…"
          className="flex-1 max-w-xs px-3 py-1.5 text-sm border border-gray-300 rounded-md"
        />
        <span className="text-xs text-gray-400">{view.length} of {rows.length}</span>
      </div>
      {view.length === 0 ? (
        <p className="p-6 text-sm text-gray-500">{rows.length === 0 ? empty : 'No matches.'}</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-gray-100 text-left text-xs text-gray-500">
                {columns.map((c, i) => (
                  <th
                    key={c.label}
                    onClick={() => clickSort(i)}
                    className={`px-4 py-2 font-medium whitespace-nowrap ${c.align === 'right' ? 'text-right' : ''} ${c.sortable ? 'cursor-pointer hover:text-gray-800 select-none' : ''}`}
                  >
                    {c.label}
                    {sortIdx === i && <span className="ml-1">{dir === 'asc' ? '▲' : '▼'}</span>}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-50">
              {view.map((r) => (
                <tr key={r.key} className="hover:bg-gray-50">
                  {r.cells.map((cell, i) => (
                    <td key={i} className={`px-4 py-2.5 align-top ${columns[i].align === 'right' ? 'text-right' : ''}`}>
                      {i === 0 ? <Link to={r.href} className="hover:underline">{cell}</Link> : cell}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

export default function MoneyOverviewPage() {
  const [data, setData] = useState<OverviewData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const role = useAuthStore((s) => s.user?.role);
  const isAdmin = role === 'admin';
  const canManage = hasManagerRole(role);
  const [resolveTarget, setResolveTarget] = useState<BalanceRow | 'bulk' | null>(null);
  const [dismissTarget, setDismissTarget] = useState<PendingRefundRow | 'bulk' | null>(null);
  const [showResolved, setShowResolved] = useState(false);
  const [toast, setToast] = useState<{ msg: string; undo?: () => void } | null>(null);
  // Filters initialise from the last-used prefs and persist on every change.
  const [prefs] = useState(loadPrefs);
  const [tab, setTab] = useState<Tab>(prefs.tab);
  // Default view = confirmed-onwards (real money owed / upcoming). Toggle to
  // include speculative enquiry-stage jobs (new enquiry / quoting / provisional).
  const [includeSpeculative, setIncludeSpeculative] = useState(prefs.includeSpeculative);
  // Historic vs upcoming split — finished = hire end date already past.
  const [balancesTiming, setBalancesTiming] = useState<Timing>(prefs.balancesTiming);
  const [excessTiming, setExcessTiming] = useState<Timing>(prefs.excessTiming);
  const [groupByClient, setGroupByClient] = useState(prefs.groupByClient);

  useEffect(() => {
    try {
      localStorage.setItem(PREFS_KEY, JSON.stringify({ tab, includeSpeculative, balancesTiming, excessTiming, groupByClient } satisfies OverviewPrefs));
    } catch { /* storage blocked — prefs just won't persist */ }
  }, [tab, includeSpeculative, balancesTiming, excessTiming, groupByClient]);

  // `quiet` skips the page-level spinner (row actions like chase logging
  // shouldn't unmount the table).
  const load = useCallback(async (quiet = false) => {
    if (!quiet) setLoading(true);
    setError('');
    try {
      const res = await api.get<{ data: OverviewData }>(`/money/overview${includeSpeculative ? '?include_speculative=1' : ''}`);
      setData(res.data);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load overview');
    } finally {
      if (!quiet) setLoading(false);
    }
  }, [includeSpeculative]);

  useEffect(() => { load(); }, [load]);

  const undoResolve = useCallback(async (jobId: string) => {
    try {
      await api.delete(`/money/${jobId}/resolve-balance`);
      setToast({ msg: 'Balance override removed' });
      load();
    } catch (e) {
      setToast({ msg: e instanceof Error ? e.message : 'Failed to undo' });
    }
  }, [load]);

  // Log a debt chase (+1) with an Undo in the toast for accidental clicks.
  const logChase = useCallback(async (r: BalanceRow) => {
    try {
      await api.post(`/money/${r.job_id}/chase`, {});
      setToast({
        msg: `Chase logged — #${r.hh_job_number ?? '—'}${r.client_name ? ` · ${r.client_name}` : ''}`,
        undo: async () => {
          try {
            await api.delete(`/money/${r.job_id}/chase`);
            setToast({ msg: 'Chase removed' });
            load(true);
          } catch (e) {
            setToast({ msg: e instanceof Error ? e.message : 'Failed to undo chase' });
          }
        },
      });
      load(true);
    } catch (e) {
      setToast({ msg: e instanceof Error ? e.message : 'Failed to log chase' });
    }
  }, [load]);

  if (loading) return <div className="p-6 text-gray-500">Loading financial overview…</div>;
  if (error) return <div className="p-6 text-red-600">{error}</div>;
  if (!data) return null;

  const t = data.totals;

  // The headline Balances card follows the timing filter, so the number always
  // matches the list below it.
  const balancesFiltered = data.balances_outstanding.filter((r) => {
    if (balancesTiming === 'all') return true;
    const finished = isPastDate(r.job_end || r.return_date);
    return balancesTiming === 'finished' ? finished : !finished;
  });
  const filteredBalanceTotal = balancesFiltered.reduce((s, r) => s + parseFloat(r.balance_outstanding), 0);
  const balancesViewLabel = balancesTiming === 'all' ? '' : balancesTiming === 'finished' ? ' · finished only' : ' · upcoming only';

  const cards: { key: typeof tab; label: string; value: string; sub: string; subNode?: React.ReactNode; accent: string }[] = [
    { key: 'balances', label: 'Balances Outstanding', value: gbp(filteredBalanceTotal), sub: `${balancesFiltered.length} owing${balancesViewLabel}${t.balances_resolved_count ? ` · ${t.balances_resolved_count} resolved` : ''}`, accent: 'text-red-700' },
    { key: 'deposits', label: 'Deposits Pending', value: String(t.deposits_pending_count), sub: 'confirmed, no deposit yet', accent: 'text-amber-700' },
    {
      key: 'excess', label: 'Excess Held', value: gbp(t.excess_held), accent: 'text-blue-700',
      sub: `${t.excess_held_count} records`,
      subNode: (
        <>
          {gbp(t.excess_held_upcoming)} upcoming
          {' · '}
          <span className="text-amber-700 font-medium">{gbp(t.excess_held_past)} to return</span>
          {t.excess_held_past_count > 0 && <span className="text-gray-400"> ({t.excess_held_past_count})</span>}
        </>
      ),
    },
    { key: 'refunds', label: 'Pending Refunds', value: gbp(t.pending_refunds), sub: `${t.pending_refunds_count} to process`, accent: 'text-purple-700' },
  ];

  // Build rows per tab (cells + parallel sort values + search blob).
  const balanceRows: Row[] = balancesFiltered.map((r) => ({
    key: r.job_id, href: jobHref(r),
    search: `${r.hh_job_number ?? ''} ${r.client_name ?? ''} ${r.job_name ?? ''} ${r.pipeline_status ?? ''}`,
    sort: [r.hh_job_number ?? 0, r.client_name ?? '', r.pipeline_status ?? '', dateMs(r.job_end || r.return_date), parseFloat(r.hire_value_inc_vat), parseFloat(r.balance_outstanding), dateMs(r.last_chased_at ?? null)],
    cells: [
      <JobRef hh={r.hh_job_number} name={r.job_name} />,
      r.client_name || '—',
      <Pill text={r.pipeline_status || '—'} />,
      <span className="whitespace-nowrap">{fmtDate(r.job_end || r.return_date)}<AgeBadge date={r.job_end || r.return_date} /></span>,
      gbp(r.hire_value_inc_vat),
      <span className="font-semibold text-red-700">{gbp(r.balance_outstanding)}</span>,
      <ChaseButton row={r} onChase={logChase} />,
      ...(isAdmin ? [
        <button
          onClick={(e) => { e.preventDefault(); e.stopPropagation(); setResolveTarget(r); }}
          className="text-xs text-gray-500 hover:text-ooosh-700 underline whitespace-nowrap"
        >Resolve</button>,
      ] : []),
    ],
  }));

  const balanceColumns: Col[] = [
    { label: 'Job', sortable: true }, { label: 'Client', sortable: true },
    { label: 'Status', sortable: true }, { label: 'Finishes', sortable: true },
    { label: 'Hire value', sortable: true, align: 'right' },
    { label: 'Outstanding', sortable: true, align: 'right' },
    { label: 'Chased', sortable: true },
    ...(isAdmin ? [{ label: '', align: 'right' as const }] : []),
  ];

  const depositRows: Row[] = data.deposits_pending.map((r) => ({
    key: r.job_id, href: jobHref(r),
    search: `${r.hh_job_number ?? ''} ${r.client_name ?? ''} ${r.job_name ?? ''} ${r.pipeline_status ?? ''}`,
    sort: [r.hh_job_number ?? 0, r.client_name ?? '', r.pipeline_status ?? '', dateMs(r.out_date || r.job_date), parseFloat(r.hire_value_inc_vat)],
    cells: [
      <JobRef hh={r.hh_job_number} name={r.job_name} />,
      r.client_name || '—',
      <Pill text={r.pipeline_status || '—'} />,
      fmtDate(r.out_date || r.job_date),
      gbp(r.hire_value_inc_vat),
    ],
  }));

  const excessFiltered = data.excess_held.filter((r) =>
    excessTiming === 'all' ? true : excessTiming === 'finished' ? r.hire_finished : !r.hire_finished);
  const excessRows: Row[] = excessFiltered.map((r) => ({
    key: r.excess_id, href: jobHref(r),
    search: `${r.hh_job_number ?? ''} ${r.client_name ?? ''} ${r.excess_status}`,
    sort: [r.hh_job_number ?? 0, r.client_name ?? '', r.excess_status, dateMs(r.finished_on), parseFloat(r.held_amount)],
    cells: [
      <JobRef hh={r.hh_job_number} name={null} />,
      r.client_name || '—',
      <Pill text={r.excess_status} />,
      <span>
        {fmtDate(r.finished_on)}
        {r.hire_finished && <span className="ml-1.5 text-[10px] px-1.5 py-0.5 rounded bg-amber-100 text-amber-800">to return</span>}
      </span>,
      <span className="font-medium text-blue-700">{gbp(r.held_amount)}</span>,
    ],
  }));

  const refundRows: Row[] = data.pending_refunds.map((r) => ({
    key: String(r.id), href: jobHref(r),
    search: `${r.hh_job_number ?? ''} ${r.client_name ?? ''} ${r.notes ?? ''}`,
    sort: [r.hh_job_number ?? 0, r.client_name ?? '', dateMs(r.payment_date), parseFloat(r.amount)],
    cells: [
      <JobRef hh={r.hh_job_number} name={null} />,
      r.client_name || '—',
      fmtDate(r.payment_date),
      <span className="font-semibold text-purple-700">{gbp(r.amount)}</span>,
      <span className="text-gray-500 text-xs">{r.notes || '—'}</span>,
      ...(canManage ? [
        <button
          onClick={(e) => { e.preventDefault(); e.stopPropagation(); setDismissTarget(r); }}
          title="Clear this IOU without moving money (already refunded out-of-band / artifact)"
          className="text-xs text-gray-500 hover:text-ooosh-700 underline whitespace-nowrap"
        >Clear</button>,
      ] : []),
    ],
  }));

  const refundColumns: Col[] = [
    { label: 'Job', sortable: true }, { label: 'Client', sortable: true },
    { label: 'Logged', sortable: true }, { label: 'Amount', sortable: true, align: 'right' },
    { label: 'Reason' },
    ...(canManage ? [{ label: '', align: 'right' as const }] : []),
  ];

  return (
    <div className="p-4 sm:p-6 max-w-6xl mx-auto">
      <div className="flex items-center justify-between mb-4">
        <h1 className="text-2xl font-bold text-gray-900">Money Overview</h1>
        <button onClick={() => load()} className="text-sm text-ooosh-600 hover:text-ooosh-700 underline">Refresh</button>
      </div>
      <p className="text-xs text-gray-500 mb-4">
        Cached per-job figures — each job refreshes when its Money tab is opened. Excess and pending refunds are live.
      </p>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-6">
        {cards.map((c) => (
          <button
            key={c.key}
            onClick={() => setTab(c.key)}
            className={`text-left bg-white rounded-xl border p-4 transition ${tab === c.key ? 'border-ooosh-400 ring-1 ring-ooosh-300' : 'border-gray-200 hover:border-gray-300'}`}
          >
            <p className="text-xs text-gray-500">{c.label}</p>
            <p className={`text-xl font-bold ${c.accent}`}>{c.value}</p>
            <p className="text-[11px] text-gray-400 mt-0.5">{c.subNode ?? c.sub}</p>
          </button>
        ))}
      </div>

      <div className="bg-white rounded-xl shadow-sm border border-gray-200">
        {tab === 'balances' && (
          <>
            <div className="flex items-center justify-between gap-3 flex-wrap px-4 pt-3">
              <div className="flex items-center gap-3 flex-wrap">
                <TimingPills value={balancesTiming} onChange={setBalancesTiming} />
                <label className="flex items-center gap-1.5 text-xs text-gray-500 cursor-pointer select-none">
                  <input
                    type="checkbox"
                    checked={includeSpeculative}
                    onChange={(e) => setIncludeSpeculative(e.target.checked)}
                  />
                  Show enquiries / provisional
                </label>
                <label className="flex items-center gap-1.5 text-xs text-gray-500 cursor-pointer select-none">
                  <input
                    type="checkbox"
                    checked={groupByClient}
                    onChange={(e) => setGroupByClient(e.target.checked)}
                  />
                  Group by client
                </label>
              </div>
              {isAdmin && (
                <button
                  onClick={() => setResolveTarget('bulk')}
                  className="text-xs text-gray-500 hover:text-ooosh-700 underline"
                >Bulk resolve old balances…</button>
              )}
            </div>
            {groupByClient ? (
              <GroupedBalances rows={balancesFiltered} isAdmin={isAdmin} onResolve={setResolveTarget} onChase={logChase} />
            ) : (
              <Table
                columns={balanceColumns}
                empty="No outstanding balances on synced jobs."
                rows={balanceRows}
              />
            )}
            {data.balances_resolved.length > 0 && (
              <div className="border-t border-gray-100">
                <button
                  onClick={() => setShowResolved((v) => !v)}
                  className="w-full text-left px-4 py-2.5 text-xs font-medium text-gray-500 hover:text-gray-700 flex items-center gap-1"
                >
                  <span>{showResolved ? '▾' : '▸'}</span>
                  Resolved ({t.balances_resolved_count}) · {gbp(t.balances_resolved_total)} ignored
                </button>
                {showResolved && (
                  <div className="overflow-x-auto pb-2">
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="border-b border-gray-100 text-left text-xs text-gray-400">
                          <th className="px-4 py-1.5 font-medium">Job</th>
                          <th className="px-4 py-1.5 font-medium">Client</th>
                          <th className="px-4 py-1.5 font-medium">Reason</th>
                          <th className="px-4 py-1.5 font-medium text-right">Was outstanding</th>
                          <th className="px-4 py-1.5 font-medium">Resolved by</th>
                          {isAdmin && <th />}
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-gray-50">
                        {data.balances_resolved.map((r) => (
                          <tr key={r.job_id} className="text-gray-500">
                            <td className="px-4 py-2 align-top">
                              <Link to={jobHref(r)} className="hover:underline"><JobRef hh={r.hh_job_number} name={r.job_name} /></Link>
                            </td>
                            <td className="px-4 py-2 align-top">{r.client_name || '—'}</td>
                            <td className="px-4 py-2 align-top">
                              <span className="text-[11px] px-2 py-0.5 rounded bg-gray-100 text-gray-600">{REASON_LABEL[r.override_reason || ''] || r.override_reason}</span>
                              {r.override_notes && <span className="block text-[11px] text-gray-400 mt-0.5">{r.override_notes}</span>}
                            </td>
                            <td className="px-4 py-2 align-top text-right line-through">{gbp(r.balance_outstanding)}</td>
                            <td className="px-4 py-2 align-top text-[11px]">
                              {r.override_resolved_by_name || '—'}
                              <span className="block text-gray-400">{fmtDate(r.override_resolved_at || null)}</span>
                            </td>
                            {isAdmin && (
                              <td className="px-4 py-2 align-top text-right">
                                <button onClick={() => undoResolve(r.job_id)} className="text-[11px] text-gray-400 hover:text-red-600 underline">Undo</button>
                              </td>
                            )}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            )}
          </>
        )}
        {tab === 'deposits' && (
          <Table
            columns={[
              { label: 'Job', sortable: true }, { label: 'Client', sortable: true },
              { label: 'Status', sortable: true }, { label: 'Out date', sortable: true },
              { label: 'Hire value', sortable: true, align: 'right' },
            ]}
            empty="No confirmed jobs awaiting a deposit (on synced jobs)."
            rows={depositRows}
          />
        )}
        {tab === 'excess' && (
          <>
            <div className="px-4 pt-3">
              <TimingPills value={excessTiming} onChange={setExcessTiming} />
              <span className="ml-2 text-[11px] text-gray-400">Finished = hire over, excess to return</span>
            </div>
            <Table
              columns={[
                { label: 'Job', sortable: true }, { label: 'Client', sortable: true },
                { label: 'Status', sortable: true }, { label: 'Finished', sortable: true },
                { label: 'Held', sortable: true, align: 'right' },
              ]}
              empty="No excess currently held."
              rows={excessRows}
            />
          </>
        )}
        {tab === 'refunds' && (
          <>
            <div className="flex items-center justify-between gap-3 flex-wrap px-4 pt-3">
              <p className="text-xs text-gray-500">
                Refund IOUs from cancellations awaiting processing. <strong>Process</strong> moves money (Money tab on the job);
                <strong> Clear</strong> just removes the IOU for refunds already handled out-of-band.
              </p>
              {isAdmin && data.pending_refunds.length > 0 && (
                <button
                  onClick={() => setDismissTarget('bulk')}
                  className="text-xs text-gray-500 hover:text-ooosh-700 underline whitespace-nowrap"
                >Bulk clear old refunds…</button>
              )}
            </div>
            <Table
              columns={refundColumns}
              empty="No pending refunds."
              rows={refundRows}
            />
          </>
        )}
      </div>

      {resolveTarget && (
        <ResolveBalanceModal
          target={resolveTarget}
          onClose={() => setResolveTarget(null)}
          onDone={(msg) => { setResolveTarget(null); setToast({ msg }); load(); }}
        />
      )}
      {dismissTarget && (
        <DismissRefundModal
          target={dismissTarget}
          isAdmin={isAdmin}
          onClose={() => setDismissTarget(null)}
          onDone={(msg) => { setDismissTarget(null); setToast({ msg }); load(); }}
        />
      )}
      {toast && (
        <div className="fixed bottom-4 left-1/2 -translate-x-1/2 z-50 bg-gray-900 text-white text-sm px-4 py-2 rounded-lg shadow-lg flex items-center gap-3">
          <span>{toast.msg}</span>
          {toast.undo && (
            <button onClick={() => { const u = toast.undo!; setToast(null); u(); }}
              className="font-medium text-amber-300 hover:text-amber-200 underline">
              Undo
            </button>
          )}
          <button onClick={() => setToast(null)} className="text-gray-300 hover:text-white">✕</button>
        </div>
      )}
    </div>
  );
}
