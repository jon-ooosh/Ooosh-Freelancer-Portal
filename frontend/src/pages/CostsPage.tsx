/**
 * CostsPage — Cost Capture & Recharge hub at /money/costs.
 *
 * Four views over the `costs` table:
 *   - all        every captured cost
 *   - payable    bills awaiting payment → verify → approve → pay workflow
 *   - recharge   costs flagged for client recharge, not yet pushed to HireHop
 *   - reconcile  company-card costs not yet reconciled against Xero
 *
 * Capture is manual (CostCaptureModal); AI extraction is a fast-follow.
 */
import { useState, useEffect, useCallback, useMemo } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api } from '../services/api';
import { useAuthStore } from '../hooks/useAuthStore';
import CostCaptureModal from '../components/CostCaptureModal';
import CostAllocationModal from '../components/CostAllocationModal';
import type { Cost, SupplierPaymentTerms } from '../../../shared/types';

type ViewMode = 'all' | 'payable' | 'recharge' | 'reconcile';

interface CostRow extends Cost {
  uploaded_by_name?: string | null;
  hh_job_number?: number | null;
  job_name?: string | null;
  vehicle_reg?: string | null;
  allocation_count?: number;
  due_date?: string | null;
}

interface Stats {
  payable: number;
  recharge_pending: number;
  reconcile_pending: number;
  payable_total: number;
}

const gbp = (n: number | null | undefined) => `£${Number(n || 0).toFixed(2)}`;

// cost_date is a DATE; pg/JSON returns it as an ISO timestamp. Take the date
// part only (avoids timezone day-shift) and show UK format.
const fmtDate = (s: string | null | undefined) => {
  if (!s) return '—';
  const [y, m, d] = s.slice(0, 10).split('-');
  return y && m && d ? `${d}/${m}/${y}` : s;
};

// Compact day/month for the dense table — full date (with year) is on hover.
const fmtDayMonth = (s: string | null | undefined) => {
  if (!s) return '—';
  const [, m, d] = s.slice(0, 10).split('-');
  return m && d ? `${d}/${m}` : s;
};

// Default terms when a supplier has none stored — see
// docs/COSTS-PAYMENT-AUTOMATION-SPEC.md.
const DEFAULT_TERMS_DAYS = 30;

// Fallback flat invoice + 30 when the server hasn't supplied a computed due
// date (older API). Normally the server sends `due_date` from the supplier's
// resolved terms.
function flatDueIso(costDate: string | null | undefined): string | null {
  if (!costDate) return null;
  const d = new Date(`${costDate.slice(0, 10)}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + DEFAULT_TERMS_DAYS);
  return d.toISOString().slice(0, 10);
}

// Build the Due-column display from the server-computed due date (falling back
// to flat+30). Returns null when there's no date. tone: red = due/overdue,
// amber = within a week, grey = comfortably ahead.
function dueInfo(c: { due_date?: string | null; cost_date: string | null }) {
  const iso = c.due_date || flatDueIso(c.cost_date);
  if (!iso) return null;
  const due = new Date(`${iso}T00:00:00Z`);
  const now = new Date();
  const todayUTC = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const days = Math.round((due.getTime() - todayUTC) / 86_400_000);
  const dd = String(due.getUTCDate()).padStart(2, '0');
  const mm = String(due.getUTCMonth() + 1).padStart(2, '0');
  const fullLabel = due.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
  let countdown: string;
  let tone: string;
  if (days < 0) { countdown = `${Math.abs(days)}d overdue`; tone = 'bg-red-100 text-red-700'; }
  else if (days === 0) { countdown = 'due today'; tone = 'bg-red-100 text-red-700'; }
  else if (days <= 7) { countdown = `in ${days}d`; tone = 'bg-amber-100 text-amber-700'; }
  else { countdown = `in ${days}d`; tone = 'bg-gray-100 text-gray-600'; }
  return { dateLabel: `${dd}/${mm}`, fullLabel, countdown, tone };
}

// Human description of a supplier's terms for the Due cell tooltip.
function termsLabel(t?: SupplierPaymentTerms): string {
  if (!t || t.source === 'default') return `invoice + ${DEFAULT_TERMS_DAYS}d (default)`;
  if (t.source === 'freelancer') return 'freelancer — first Friday +1wk after approval';
  const base = t.basis === 'end_of_invoice_month' ? 'end of invoice month' : 'invoice date';
  return `${base} + ${t.days}d${t.source === 'xero' ? ' · from Xero' : ''}`;
}

const APPROVAL_COLOURS: Record<string, string> = {
  submitted: 'bg-gray-100 text-gray-700',
  verified: 'bg-blue-100 text-blue-700',
  approved: 'bg-amber-100 text-amber-700',
  paid: 'bg-green-100 text-green-700',
};

// Client-side column sort. null = server order (newest captured first).
type SortKey = 'date' | 'due' | 'supplier' | 'description' | 'gross' | 'type' | 'status';
type DueFilter = 'all' | 'overdue' | 'friday' | 'next_friday' | 'this_week' | 'next_7';
const SORT_VALUE: Record<SortKey, (c: { cost_date: string | null; due_date?: string | null; supplier_name: string | null; description: string | null; amount_gross: number | null; category: string | null; cost_type: string; approval_state: string | null; payment_status: string }) => string | number> = {
  date: (c) => c.cost_date || '',
  // Undated bills sort last under ascending (the common "what's due soonest" view).
  due: (c) => c.due_date || '9999-12-31',
  supplier: (c) => (c.supplier_name || '').toLowerCase(),
  description: (c) => (c.description || '').toLowerCase(),
  gross: (c) => Number(c.amount_gross || 0),
  type: (c) => (c.category || c.cost_type || '').toLowerCase(),
  status: (c) => c.approval_state || c.payment_status || '',
};

export default function CostsPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const { user } = useAuthStore();
  const role = user?.role || '';
  const isManager = role === 'admin' || role === 'manager';
  const isAdmin = role === 'admin';

  const [view, setView] = useState<ViewMode>((searchParams.get('view') as ViewMode) || 'all');
  const missingReceipt = searchParams.get('missing_receipt') === '1';
  const mineOnly = searchParams.get('mine') === '1';
  const [rows, setRows] = useState<CostRow[]>([]);
  const [stats, setStats] = useState<Stats | null>(null);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [searchDebounced, setSearchDebounced] = useState('');
  const [typeFilter, setTypeFilter] = useState('');
  const [showCapture, setShowCapture] = useState(false);
  const [editing, setEditing] = useState<CostRow | null>(null);
  const [allocating, setAllocating] = useState<CostRow | null>(null);
  const [payTarget, setPayTarget] = useState<CostRow | null>(null);
  const [termsTarget, setTermsTarget] = useState<CostRow | null>(null);
  const [preview, setPreview] = useState<CostRow | null>(null);
  const [actionBusy, setActionBusy] = useState<string | null>(null);
  const [sortKey, setSortKey] = useState<SortKey | null>(null);
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc');
  const [dueFilter, setDueFilter] = useState<DueFilter>('all');
  const [supplierFilter, setSupplierFilter] = useState('');

  const sortedRows = useMemo(() => {
    let base = rows;
    if (supplierFilter) base = base.filter((c) => (c.supplier_name || '') === supplierFilter);
    // Due-date filters only apply in the Bills to Pay view.
    if (view === 'payable' && dueFilter !== 'all') {
      const today = new Date(); today.setHours(0, 0, 0, 0);
      // Format in LOCAL time — toISOString() is UTC and shifts the day under BST,
      // which broke the exact-match "This Friday" filter.
      const fmt = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
      const todayStr = fmt(today);
      // End of this week = upcoming Sunday (Mon-start week).
      const endOfWeek = new Date(today); endOfWeek.setDate(today.getDate() + ((7 - today.getDay()) % 7 || 7));
      // Next Friday on/after today (today if it's a Friday); the one after = +7.
      const friday = new Date(today); friday.setDate(today.getDate() + ((5 - today.getDay() + 7) % 7));
      const nextFriday = new Date(friday); nextFriday.setDate(friday.getDate() + 7);
      const next7 = new Date(today); next7.setDate(today.getDate() + 7);
      base = base.filter((c) => {
        if (c.payment_status === 'paid' || !c.due_date) return false;
        const d = c.due_date.slice(0, 10);
        switch (dueFilter) {
          case 'overdue':     return d < todayStr;
          case 'friday':      return d === fmt(friday);
          case 'next_friday': return d === fmt(nextFriday);
          case 'this_week':   return d >= todayStr && d <= fmt(endOfWeek);
          case 'next_7':      return d >= todayStr && d <= fmt(next7);
          default:            return true;
        }
      });
    }
    if (!sortKey) return base;
    const val = SORT_VALUE[sortKey];
    return [...base].sort((a, b) => {
      const av = val(a); const bv = val(b);
      const cmp = typeof av === 'number' && typeof bv === 'number' ? av - bv : String(av).localeCompare(String(bv));
      return sortDir === 'asc' ? cmp : -cmp;
    });
  }, [rows, sortKey, sortDir, view, dueFilter, supplierFilter]);

  const supplierOptions = useMemo(
    () => Array.from(new Set(rows.map((r) => r.supplier_name).filter((s): s is string => !!s))).sort((a, b) => a.localeCompare(b)),
    [rows],
  );

  const clickSort = (key: SortKey) => {
    if (sortKey === key) setSortDir(sortDir === 'asc' ? 'desc' : 'asc');
    else { setSortKey(key); setSortDir('asc'); }
  };

  useEffect(() => {
    const t = setTimeout(() => setSearchDebounced(search), 300);
    return () => clearTimeout(t);
  }, [search]);

  // `quiet` refreshes (after row actions) skip the page-level loading flag so the
  // table doesn't unmount → remount, which made the page jump on Approve/Push Now.
  const load = useCallback(async (quiet = false) => {
    if (!quiet) setLoading(true);
    try {
      const params = new URLSearchParams();
      if (view !== 'all') params.set('view', view);
      if (typeFilter) params.set('cost_type', typeFilter);
      if (searchDebounced) params.set('search', searchDebounced);
      if (missingReceipt) params.set('missing_receipt', '1');
      if (mineOnly) params.set('mine', '1');
      const res = await api.get<{ data: CostRow[]; stats: Stats }>(`/costs?${params.toString()}`);
      setRows(res.data);
      setStats(res.stats);
    } catch (err) {
      console.error('Failed to load costs:', err);
    } finally {
      if (!quiet) setLoading(false);
    }
  }, [view, typeFilter, searchDebounced, missingReceipt, mineOnly]);

  useEffect(() => { load(); }, [load]);

  // Deep-link from /quick "Upload receipt" → open the capture modal directly.
  useEffect(() => {
    if (searchParams.get('capture') === '1') {
      setShowCapture(true);
      searchParams.delete('capture');
      setSearchParams(searchParams, { replace: true });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function runAction(id: string, action: 'verify' | 'approve') {
    setActionBusy(id + action);
    try {
      await api.post(`/costs/${id}/${action}`, {});
      await load(true);
      // Approving a bill pushes it to Xero in the background (takes a second
      // or two) — refresh again shortly so the "Bill created" pill appears
      // without a manual reload.
      if (action === 'approve') setTimeout(() => load(true), 3500);
    } catch (err) {
      alert(err instanceof Error ? err.message : `Failed to ${action}`);
    } finally {
      setActionBusy(null);
    }
  }

  // Mark a bill paid: captures the value date (may be future) + the method the
  // money went out from. The backend records the payment against the Xero bill
  // on that method's mapped bank account.
  async function payCost(id: string, paidDate: string, paidMethod: string) {
    setActionBusy(id + 'pay');
    try {
      await api.post(`/costs/${id}/pay`, { paid_date: paidDate, paid_method: paidMethod });
      setPayTarget(null);
      await load(true);
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Failed to mark paid');
    } finally {
      setActionBusy(null);
    }
  }

  async function deleteCost(c: CostRow) {
    if (c.xero_sync_state === 'reconciled') {
      alert('This cost is reconciled in Xero and is locked — void it in Xero rather than deleting here.');
      return;
    }
    const inXero = !!c.xero_object_id;
    const xeroNote = inXero
      ? '\n\n⚠️ This removes the cost from OP only — it will NOT delete the bill/transaction in Xero. Void it in Xero separately if needed.'
      : '';
    if (!confirm(`Delete this cost${c.supplier_name ? ` from ${c.supplier_name}` : ''}? This cannot be undone.${xeroNote}`)) return;
    setActionBusy(c.id + 'delete');
    try {
      await api.delete(`/costs/${c.id}`);
      await load(true);
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Failed to delete');
    } finally {
      setActionBusy(null);
    }
  }

  async function resyncStale(c: CostRow) {
    setActionBusy(c.id + 'resync');
    try {
      const r = await api.post<{ result?: { error?: string; skipped?: string } }>(`/costs/${c.id}/resync-xero`, {});
      if (r.result?.error) alert(`Re-sync: ${r.result.error}`);
      await load(true);
    } catch (err) {
      // 409 = Xero has it locked (paid bill / reconciled txn). Offer to clear the
      // flag since staff will fix it directly in Xero.
      const msg = err instanceof Error ? err.message : 'Failed to re-sync';
      if (confirm(`${msg}\n\nMark as resolved here? (only do this once you've fixed it in Xero)`)) {
        try { await api.post(`/costs/${c.id}/resync-xero`, { dismiss: true }); await load(true); }
        catch (e2) { alert(e2 instanceof Error ? e2.message : 'Failed to clear flag'); }
      }
    } finally {
      setActionBusy(null);
    }
  }

  async function retrySync(c: CostRow) {
    setActionBusy(c.id + 'sync');
    try {
      const r = await api.post<{ result: { error?: string; skipped?: string } }>(`/costs/${c.id}/sync-xero`, {});
      if (r.result?.error) alert(`Xero push failed: ${r.result.error}`);
      else if (r.result?.skipped) alert(`Skipped: ${r.result.skipped}`);
      await load(true);
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Failed to retry sync');
    } finally {
      setActionBusy(null);
    }
  }

  // Push the flagged recharge to HireHop as a billable line. Surfaces HH's own
  // message on failure (closed job, validation, etc.) so staff know what to do.
  async function confirmRecharge(c: CostRow) {
    if (!confirm(`Add a £${Number(c.recharge_amount ?? c.amount_gross ?? 0).toFixed(2)} recharge line (+ VAT) to HireHop${c.hh_job_number ? ` job #${c.hh_job_number}` : ''}?`)) return;
    setActionBusy(c.id + 'recharge');
    try {
      const r = await api.post<{ result: { pushed?: boolean; error?: string; skipped?: string; manualActionRequired?: boolean; amount?: number; stockLabel?: string } }>(
        `/costs/${c.id}/push-recharge`, {},
      );
      const res = r.result || {};
      if (res.pushed) alert(`Recharged to HireHop: ${res.stockLabel} £${Number(res.amount || 0).toFixed(2)} + VAT added to the job.`);
      else if (res.error) alert(`Recharge ${res.manualActionRequired ? 'needs manual action' : 'failed'}: ${res.error}`);
      else if (res.skipped) alert(`Skipped: ${res.skipped}`);
      await load(true);
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Failed to push recharge to HireHop');
    } finally {
      setActionBusy(null);
    }
  }

  const tabs: { key: ViewMode; label: string; badge?: number }[] = [
    { key: 'all', label: 'All costs' },
    { key: 'payable', label: 'Bills to Pay', badge: stats?.payable },
    { key: 'recharge', label: 'Recharges', badge: stats?.recharge_pending },
    { key: 'reconcile', label: 'Reconcile', badge: stats?.reconcile_pending },
  ];

  return (
    <div className="p-4 sm:p-6 max-w-7xl mx-auto">
      <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
        <h1 className="text-xl sm:text-2xl font-bold text-gray-900">Costs</h1>
        <button onClick={() => setShowCapture(true)}
          className="px-4 py-2 text-sm font-medium text-white bg-purple-600 hover:bg-purple-700 rounded-md">
          + Capture cost
        </button>
      </div>

      {/* Stat cards */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-5">
        <StatCard label="Bills to pay" value={String(stats?.payable ?? 0)} sub={gbp(stats?.payable_total)} color="amber" />
        <StatCard label="Recharges pending" value={String(stats?.recharge_pending ?? 0)} color="blue" />
        <StatCard label="To reconcile" value={String(stats?.reconcile_pending ?? 0)} color="purple" />
        <StatCard label="Shown" value={String(rows.length)} color="gray" />
      </div>

      {/* Tabs */}
      <div className="flex flex-wrap gap-2 border-b border-gray-200 mb-4">
        {tabs.map((t) => (
          <button key={t.key} onClick={() => setView(t.key)}
            className={`px-3 py-2 text-sm font-medium border-b-2 -mb-px ${
              view === t.key ? 'border-purple-600 text-purple-700' : 'border-transparent text-gray-500 hover:text-gray-700'
            }`}>
            {t.label}
            {t.badge ? <span className="ml-1.5 px-1.5 py-0.5 text-xs bg-gray-200 text-gray-700 rounded-full">{t.badge}</span> : null}
          </button>
        ))}
      </div>

      {/* Filters */}
      {missingReceipt && (
        <div className="flex items-center justify-between gap-2 mb-4 bg-amber-50 border border-amber-200 text-amber-800 rounded-md px-3 py-2 text-sm">
          <span>Showing company-card costs with no receipt attached{mineOnly ? ' (yours)' : ''}. Open each one to attach its receipt.</span>
          <button onClick={() => { searchParams.delete('missing_receipt'); searchParams.delete('mine'); setSearchParams(searchParams, { replace: true }); }}
            className="text-amber-700 hover:underline whitespace-nowrap">Clear filter</button>
        </div>
      )}
      <div className="flex flex-wrap gap-2 mb-4">
        <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search supplier / description"
          className="border border-gray-300 rounded-md px-3 py-1.5 text-sm flex-1 min-w-[200px]" />
        <select value={typeFilter} onChange={(e) => setTypeFilter(e.target.value)}
          className="border border-gray-300 rounded-md px-3 py-1.5 text-sm">
          <option value="">All types</option>
          <option value="overhead">Overhead</option>
          <option value="job">Job</option>
          <option value="vehicle">Vehicle</option>
          <option value="stock">Stock</option>
          <option value="parts">Parts</option>
          <option value="freelancer_invoice">Freelancer invoice</option>
        </select>
        <select value={supplierFilter} onChange={(e) => setSupplierFilter(e.target.value)}
          className="border border-gray-300 rounded-md px-3 py-1.5 text-sm max-w-[180px]">
          <option value="">All suppliers</option>
          {supplierOptions.map((s) => <option key={s} value={s}>{s}</option>)}
        </select>
      </div>

      {/* Due-date filters — Bills to Pay only */}
      {view === 'payable' && (
        <div className="flex flex-wrap items-center gap-1.5 mb-4">
          <span className="text-xs text-gray-400 mr-1">Due:</span>
          {([
            ['all', 'All'],
            ['overdue', 'Overdue'],
            ['friday', 'This Friday'],
            ['next_friday', 'Next Friday'],
            ['this_week', 'This week'],
            ['next_7', 'Next 7 days'],
          ] as [DueFilter, string][]).map(([key, label]) => (
            <button key={key} onClick={() => setDueFilter(key)}
              className={`px-2.5 py-1 text-xs rounded-full border ${dueFilter === key
                ? (key === 'overdue' ? 'bg-red-600 border-red-600 text-white' : 'bg-purple-600 border-purple-600 text-white')
                : 'bg-white border-gray-300 text-gray-600 hover:bg-gray-50'}`}>
              {label}
            </button>
          ))}
        </div>
      )}

      {view === 'reconcile' && isManager && <XeroCotProbe />}

      {/* Table */}
      {loading ? (
        <div className="text-center text-gray-500 py-12">Loading…</div>
      ) : rows.length === 0 ? (
        <div className="text-center text-gray-500 py-12">No costs in this view.</div>
      ) : (
        <div className="overflow-x-auto border border-gray-200 rounded-lg">
          <table className="min-w-full text-sm">
            <thead className="bg-gray-50 text-gray-600">
              <tr>
                <SortableTh label="Date" k="date" sortKey={sortKey} sortDir={sortDir} onSort={clickSort} />
                {view === 'payable' && <SortableTh label="Due" k="due" sortKey={sortKey} sortDir={sortDir} onSort={clickSort} />}
                <SortableTh label="Supplier" k="supplier" sortKey={sortKey} sortDir={sortDir} onSort={clickSort} />
                <SortableTh label="Description" k="description" sortKey={sortKey} sortDir={sortDir} onSort={clickSort} />
                <SortableTh label="Gross" k="gross" sortKey={sortKey} sortDir={sortDir} onSort={clickSort} align="right" />
                <SortableTh label="Type" k="type" sortKey={sortKey} sortDir={sortDir} onSort={clickSort} />
                <th className="px-2.5 py-2 text-left font-medium">Linked</th>
                {view === 'all' && <th className="px-2.5 py-2 text-left font-medium">Uploaded by</th>}
                <SortableTh label="Status" k="status" sortKey={sortKey} sortDir={sortDir} onSort={clickSort} />
                <th className="px-2.5 py-2 text-left font-medium">Xero</th>
                <th className="px-2.5 py-2 text-right font-medium">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {sortedRows.map((c) => (
                <tr key={c.id} className="hover:bg-gray-50">
                  <td className="px-2.5 py-2 whitespace-nowrap text-gray-700" title={fmtDate(c.cost_date)}>{fmtDayMonth(c.cost_date)}</td>
                  {view === 'payable' && (() => {
                    const due = dueInfo(c);
                    return (
                      <td className="px-2.5 py-2 whitespace-nowrap">
                        <button onClick={() => setTermsTarget(c)}
                          title={due ? `Due ${due.fullLabel} · terms: ${termsLabel(c.terms)} · click to set this supplier's terms` : 'Set this supplier’s payment terms'}
                          className="flex items-center gap-1.5 text-gray-700 hover:text-purple-700">
                          {due ? (
                            <>
                              <span className="border-b border-dashed border-gray-300 group-hover:border-purple-300">{due.dateLabel}</span>
                              <span className={`px-1.5 py-0.5 text-xs rounded-full ${due.tone}`}>{due.countdown}</span>
                            </>
                          ) : <span className="text-gray-400">set terms</span>}
                        </button>
                      </td>
                    );
                  })()}
                  <td className="px-2.5 py-2 text-gray-900">
                    <div className="flex items-center gap-2">
                      {c.receipt_r2_key && <ReceiptThumb cost={c} onOpen={() => setPreview(c)} />}
                      <div className="min-w-0">
                        <div className="truncate max-w-[160px]">{c.supplier_name || '—'}</div>
                        {c.invoice_number && <div className="text-xs text-gray-400 truncate max-w-[160px]">#{c.invoice_number}</div>}
                      </div>
                    </div>
                  </td>
                  <td className="px-2.5 py-2 text-gray-600 max-w-[180px] truncate" title={c.description || undefined}>{c.description || '—'}</td>
                  <td className="px-2.5 py-2 text-right font-medium text-gray-900">{gbp(c.amount_gross)}</td>
                  <td className="px-2.5 py-2 text-gray-600 max-w-[110px] truncate whitespace-nowrap" title={`${c.category || c.cost_type.replace('_', ' ')}${view !== 'all' && c.uploaded_by_name ? ` · uploaded by ${c.uploaded_by_name}` : ''}`}>
                    {c.category || c.cost_type.replace('_', ' ')}
                  </td>
                  <td className="px-2.5 py-2 text-gray-600 whitespace-nowrap">
                    {c.hh_job_number && c.job_id ? (
                      <Link to={`/jobs/${c.job_id}`} title={c.job_name || undefined} className="text-purple-700 hover:underline">#{c.hh_job_number}</Link>
                    ) : c.hh_job_number ? <span className="text-purple-700">#{c.hh_job_number}</span>
                      : c.vehicle_reg && c.vehicle_id ? (
                        <Link to={`/vehicles/fleet/${c.vehicle_id}`} className="text-purple-700 hover:underline">{c.vehicle_reg}</Link>
                      ) : c.vehicle_reg ? <span className="text-purple-700">{c.vehicle_reg}</span> : '—'}
                  </td>
                  {view === 'all' && <td className="px-2.5 py-2 text-gray-600 whitespace-nowrap">{c.uploaded_by_name || '—'}</td>}
                  <td className="px-2.5 py-2">
                    {c.approval_state ? (
                      <span className={`px-2 py-0.5 text-xs rounded-full ${APPROVAL_COLOURS[c.approval_state] || 'bg-gray-100 text-gray-700'}`}>
                        {c.approval_state}
                      </span>
                    ) : (
                      <span className="text-xs text-gray-500">{c.payment_status.replace('_', ' ')}</span>
                    )}
                    {c.recharge_mode !== 'none' && (
                      <span className="ml-1 px-2 py-0.5 text-xs rounded-full bg-blue-50 text-blue-700">
                        recharge{c.recharged_to_hh_at ? ' ✓' : ''}
                      </span>
                    )}
                  </td>
                  <td className="px-2.5 py-2 whitespace-nowrap">
                    <XeroCell cost={c} busy={actionBusy === c.id + 'sync'} onRetry={() => retrySync(c)}
                      resyncBusy={actionBusy === c.id + 'resync'} onResync={() => resyncStale(c)} />
                  </td>
                  <td className="px-2.5 py-2 text-right whitespace-nowrap">
                    <div className="flex items-center justify-end gap-2">
                      {view === 'payable' && (
                        <PayableActions cost={c} isManager={isManager} isAdmin={isAdmin} busy={actionBusy} onAction={runAction} onPay={() => setPayTarget(c)} />
                      )}
                      {view === 'recharge' && !c.recharged_to_hh_at && (
                        <button disabled={actionBusy === c.id + 'recharge'} onClick={() => confirmRecharge(c)}
                          className="px-2 py-1 text-xs text-white bg-blue-600 hover:bg-blue-700 rounded disabled:opacity-50">
                          {actionBusy === c.id + 'recharge' ? '…' : 'Push to HireHop'}
                        </button>
                      )}
                      <button onClick={() => setAllocating(c)} title="Split across jobs"
                        className={`px-1.5 py-1 text-sm rounded hover:bg-gray-100 ${c.allocation_count ? 'text-purple-700' : 'text-gray-500 hover:text-gray-800'}`}>
                        ⑂{c.allocation_count ? <span className="text-[10px] align-top">{c.allocation_count}</span> : ''}
                      </button>
                      <button onClick={() => setEditing(c)} title="Edit"
                        className="px-1.5 py-1 text-sm text-gray-500 hover:text-gray-800 hover:bg-gray-100 rounded">
                        ✎
                      </button>
                      {isManager && (
                        <button disabled={actionBusy === c.id + 'delete'} onClick={() => deleteCost(c)} title="Delete"
                          className="px-1.5 py-1 text-sm text-red-500 hover:text-red-700 hover:bg-red-50 rounded disabled:opacity-50">
                          🗑
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {showCapture && (
        <CostCaptureModal
          onClose={() => setShowCapture(false)}
          onSaved={() => { setShowCapture(false); load(); }}
          onSavedAndSplit={(c) => { setShowCapture(false); load(); setAllocating(c as CostRow); }}
        />
      )}
      {editing && (
        <CostCaptureModal
          existing={editing}
          onClose={() => setEditing(null)}
          onSaved={() => { setEditing(null); load(); }}
        />
      )}
      {allocating && (
        <CostAllocationModal
          cost={allocating}
          onClose={() => setAllocating(null)}
          onSaved={() => { setAllocating(null); load(true); }}
        />
      )}
      {payTarget && (
        <PayModal
          cost={payTarget}
          busy={actionBusy === payTarget.id + 'pay'}
          onClose={() => setPayTarget(null)}
          onSubmit={(date, method) => payCost(payTarget.id, date, method)}
        />
      )}
      {termsTarget && (
        <SupplierTermsModal
          cost={termsTarget}
          onClose={() => setTermsTarget(null)}
          onSaved={() => { setTermsTarget(null); load(true); }}
        />
      )}
      {preview && <ReceiptPreview cost={preview} onClose={() => setPreview(null)} />}
    </div>
  );
}

// Per-supplier payment terms editor (opened from the Due cell). Terms apply to
// every bill from this supplier and drive the computed due date + the Xero bill
// due date. Keyed by Xero contact id when the cost has one, else supplier name.
function SupplierTermsModal({ cost, onClose, onSaved }: {
  cost: CostRow;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [basis, setBasis] = useState<SupplierPaymentTerms['basis']>(cost.terms?.basis || 'invoice_date');
  const [days, setDays] = useState<number>(cost.terms?.days ?? DEFAULT_TERMS_DAYS);
  const [source, setSource] = useState<SupplierPaymentTerms['source']>(cost.terms?.source || 'default');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const supplier = cost.supplier_name || 'this supplier';

  // Load the current effective terms (handles the case where they were set on
  // another bill from the same supplier since this row was fetched).
  useEffect(() => {
    const params = new URLSearchParams();
    if (cost.supplier_name) params.set('supplier_name', cost.supplier_name);
    if (cost.xero_contact_id) params.set('xero_contact_id', cost.xero_contact_id);
    api.get<{ data: SupplierPaymentTerms }>(`/costs/suppliers/terms?${params.toString()}`)
      .then((r) => { setBasis(r.data.basis); setDays(r.data.days); setSource(r.data.source); })
      .catch(() => { /* keep row's terms as the seed */ })
      .finally(() => setLoading(false));
  }, [cost.supplier_name, cost.xero_contact_id]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  // Preview the resulting due date against this cost's invoice date.
  const preview = (() => {
    if (!cost.cost_date) return null;
    const [y, m, d] = cost.cost_date.slice(0, 10).split('-').map((n) => parseInt(n, 10));
    if (!y || !m || !d) return null;
    const base = basis === 'end_of_invoice_month' ? new Date(Date.UTC(y, m, 0)) : new Date(Date.UTC(y, m - 1, d));
    base.setUTCDate(base.getUTCDate() + days);
    return base.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
  })();

  async function save() {
    setSaving(true);
    try {
      await api.put('/costs/suppliers/terms', {
        supplier_name: cost.supplier_name || null,
        xero_contact_id: cost.xero_contact_id || null,
        basis,
        days,
      });
      onSaved();
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Failed to save terms');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4" onClick={onClose}>
      <div className="bg-white rounded-lg shadow-xl w-full max-w-md" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-200">
          <h2 className="text-lg font-semibold text-gray-900">Payment terms</h2>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 text-xl leading-none">&times;</button>
        </div>
        <div className="px-6 py-4 space-y-4">
          <p className="text-sm text-gray-600">
            Applies to <strong>all bills from {supplier}</strong>.
            {source === 'xero' && <span className="text-gray-400"> Currently from Xero.</span>}
            {!cost.xero_contact_id && <span className="text-gray-400"> (Matched by name — pick this supplier from the Xero list when capturing to match by account.)</span>}
          </p>
          <div className="flex items-end gap-2">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Due</label>
              <input type="number" min={0} max={365} value={days}
                onChange={(e) => setDays(Math.max(0, Math.min(365, parseInt(e.target.value, 10) || 0)))}
                className="w-20 border border-gray-300 rounded-md px-3 py-2 text-sm focus:ring-2 focus:ring-purple-500" />
            </div>
            <span className="pb-2.5 text-sm text-gray-600">days after</span>
            <div className="flex-1">
              <select value={basis} onChange={(e) => setBasis(e.target.value as SupplierPaymentTerms['basis'])}
                className="w-full border border-gray-300 rounded-md px-3 py-2 text-sm focus:ring-2 focus:ring-purple-500">
                <option value="invoice_date">the invoice date</option>
                <option value="end_of_invoice_month">end of the invoice month (EOM)</option>
              </select>
            </div>
          </div>
          {preview && (
            <p className="text-xs text-gray-500">
              This bill (invoiced {fmtDate(cost.cost_date)}) would be due <strong>{preview}</strong>.
            </p>
          )}
          {loading && <p className="text-xs text-gray-400">Loading current terms…</p>}
        </div>
        <div className="flex justify-end gap-2 px-6 py-4 border-t border-gray-200">
          <button onClick={onClose} className="px-4 py-2 text-sm text-gray-700 hover:bg-gray-100 rounded-md">Cancel</button>
          <button onClick={save} disabled={saving}
            className="px-4 py-2 text-sm text-white bg-purple-600 hover:bg-purple-700 rounded-md disabled:opacity-50">
            {saving ? 'Saving…' : 'Save terms'}
          </button>
        </div>
      </div>
    </div>
  );
}

// Small receipt thumbnail in the Supplier cell — authenticated blob fetch (the
// JWT isn't sent on a plain <img src> to /files/download). Image → thumbnail,
// PDF/other → 📎 icon. Click opens the lightbox.
function ReceiptThumb({ cost, onOpen }: { cost: CostRow; onOpen: () => void }) {
  const [url, setUrl] = useState<string | null>(null);
  const [isImage, setIsImage] = useState(false);
  useEffect(() => {
    if (!cost.receipt_r2_key) return;
    let objUrl = ''; let cancelled = false;
    api.blob(`/files/download?key=${encodeURIComponent(cost.receipt_r2_key)}`)
      .then(({ blob, contentType }) => {
        if (cancelled) return;
        if (contentType.startsWith('image/')) {
          setIsImage(true);
          objUrl = URL.createObjectURL(blob);
          setUrl(objUrl);
        }
      })
      .catch(() => {});
    return () => { cancelled = true; if (objUrl) URL.revokeObjectURL(objUrl); };
  }, [cost.receipt_r2_key]);
  return (
    <button onClick={onOpen} title="View receipt"
      className="shrink-0 w-8 h-8 rounded border border-gray-200 overflow-hidden bg-gray-50 flex items-center justify-center hover:border-purple-400">
      {isImage && url ? <img src={url} alt="receipt" className="w-full h-full object-cover" /> : <span className="text-sm">📎</span>}
    </button>
  );
}

// Lightbox — fetches the receipt blob and shows it large (image inline, PDF in
// an iframe). Backdrop / ✕ / Escape to close.
function ReceiptPreview({ cost, onClose }: { cost: CostRow; onClose: () => void }) {
  const [url, setUrl] = useState<string | null>(null);
  const [type, setType] = useState('');
  const [err, setErr] = useState('');
  useEffect(() => {
    if (!cost.receipt_r2_key) { setErr('No receipt on file'); return; }
    let objUrl = ''; let cancelled = false;
    api.blob(`/files/download?key=${encodeURIComponent(cost.receipt_r2_key)}`)
      .then(({ blob, contentType }) => {
        if (cancelled) return;
        setType(contentType);
        objUrl = URL.createObjectURL(blob);
        setUrl(objUrl);
      })
      .catch(() => { if (!cancelled) setErr('Failed to load receipt'); });
    return () => { cancelled = true; if (objUrl) URL.revokeObjectURL(objUrl); };
  }, [cost.receipt_r2_key]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="fixed inset-0 z-50 bg-black/70 flex items-center justify-center p-4" onClick={onClose}>
      <div className="bg-white rounded-lg shadow-xl max-w-3xl w-full max-h-[90vh] overflow-hidden flex flex-col" onClick={(e) => e.stopPropagation()}>
        <div className="px-4 py-2.5 border-b border-gray-200 flex items-center justify-between">
          <span className="text-sm font-medium text-gray-700 truncate">{cost.receipt_filename || cost.supplier_name || 'Receipt'}</span>
          <div className="flex items-center gap-3">
            {url && <a href={url} target="_blank" rel="noreferrer" className="text-xs text-purple-600 hover:underline">Open full</a>}
            <button onClick={onClose} className="text-gray-400 hover:text-gray-700">✕</button>
          </div>
        </div>
        <div className="flex-1 overflow-auto bg-gray-100 flex items-center justify-center min-h-[300px]">
          {err ? <p className="text-sm text-gray-500 p-6">{err}</p>
            : !url ? <p className="text-sm text-gray-400 p-6">Loading…</p>
            : type.includes('pdf') ? <iframe src={url} title="receipt" className="w-full h-[75vh]" />
            : <img src={url} alt="receipt" className="max-w-full max-h-[80vh] object-contain" />}
        </div>
      </div>
    </div>
  );
}

// Bank/card instruments money can go out from — drives which Xero bank account
// a bill payment posts to. Keep in step with the paid-now methods in
// CostCaptureModal + backend SPEND_MONEY_METHODS.
const PAID_NOW_METHODS = [
  { value: 'lloyds_transfer', label: 'Lloyds bank transfer' },
  { value: 'wise', label: 'Wise bank transfer' },
  { value: 'cot_card', label: 'Company card (COT)' },
  { value: 'amex', label: 'Amex card' },
  { value: 'lloyds_cc', label: 'Lloyds credit card' },
  { value: 'petty_cash', label: 'Petty cash' },
  { value: 'paypal', label: 'PayPal' },
];

function PayModal({ cost, busy, onClose, onSubmit }: {
  cost: CostRow;
  busy: boolean;
  onClose: () => void;
  onSubmit: (paidDate: string, paidMethod: string) => void;
}) {
  const [paidDate, setPaidDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [paidMethod, setPaidMethod] = useState('lloyds_transfer');
  const isReimburse = cost.payment_method === 'reimburse_me';
  // Due date from the supplier's resolved terms (server-computed), falling back
  // to flat invoice + 30 for an older API response.
  const dueDate = (() => {
    const iso = cost.due_date || flatDueIso(cost.cost_date);
    if (!iso) return null;
    return new Date(`${iso}T00:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
  })();

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4" onClick={onClose}>
      <div className="bg-white rounded-lg shadow-xl w-full max-w-md" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-200">
          <h2 className="text-lg font-semibold text-gray-900">Mark bill paid</h2>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 text-xl leading-none">&times;</button>
        </div>
        <div className="px-6 py-4 space-y-4">
          <p className="text-sm text-gray-600">
            {isReimburse ? 'Reimbursement to ' : 'Payment to '}
            <strong>{isReimburse ? (cost.uploaded_by_name || 'staff') : (cost.supplier_name || 'supplier')}</strong>
            {' '}of <strong>{gbp(cost.amount_gross)}</strong>
            {cost.invoice_number ? <> for invoice <strong>{cost.invoice_number}</strong></> : null}
            {dueDate ? <>, due <strong>{dueDate}</strong></> : null}.
          </p>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Payment date</label>
            <input type="date" value={paidDate} onChange={(e) => setPaidDate(e.target.value)}
              className="w-full border border-gray-300 rounded-md px-3 py-2 text-sm focus:ring-2 focus:ring-purple-500" />
            <p className="text-xs text-gray-400 mt-1">A future date schedules the payment in Xero for that day.</p>
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Paid from</label>
            <select value={paidMethod} onChange={(e) => setPaidMethod(e.target.value)}
              className="w-full border border-gray-300 rounded-md px-3 py-2 text-sm focus:ring-2 focus:ring-purple-500">
              {PAID_NOW_METHODS.map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}
            </select>
            <p className="text-xs text-gray-400 mt-1">Records the payment against the bill on this account's Xero feed.</p>
          </div>
        </div>
        <div className="flex justify-end gap-2 px-6 py-4 border-t border-gray-200">
          <button onClick={onClose} className="px-4 py-2 text-sm text-gray-700 hover:bg-gray-100 rounded-md">Cancel</button>
          <button onClick={() => onSubmit(paidDate, paidMethod)} disabled={busy}
            className="px-4 py-2 text-sm text-white bg-purple-600 hover:bg-purple-700 rounded-md disabled:opacity-50">
            {busy ? 'Saving…' : 'Mark paid'}
          </button>
        </div>
      </div>
    </div>
  );
}

function PayableActions({ cost, isManager, isAdmin, busy, onAction, onPay }: {
  cost: Cost;
  isManager: boolean;
  isAdmin: boolean;
  busy: string | null;
  onAction: (id: string, a: 'verify' | 'approve') => void;
  onPay: () => void;
}) {
  const s = cost.approval_state;
  if (s === 'paid') return <span className="text-xs text-green-600">Paid</span>;
  if ((!s || s === 'submitted') && isManager) {
    return <ActionBtn busy={busy === cost.id + 'verify'} onClick={() => onAction(cost.id, 'verify')} label="Verify" />;
  }
  if (s === 'verified' && isManager) {
    return <ActionBtn busy={busy === cost.id + 'approve'} onClick={() => onAction(cost.id, 'approve')} label="Approve" />;
  }
  if (s === 'approved' && isAdmin) {
    return <ActionBtn busy={busy === cost.id + 'pay'} onClick={onPay} label="Mark paid" />;
  }
  return <span className="text-xs text-gray-400">{s ? `awaiting ${s === 'verified' ? 'approval' : 'payment'}` : '—'}</span>;
}

function SortableTh({ label, k, sortKey, sortDir, onSort, align }: {
  label: string; k: SortKey; sortKey: SortKey | null; sortDir: 'asc' | 'desc';
  onSort: (k: SortKey) => void; align?: 'right';
}) {
  return (
    <th onClick={() => onSort(k)}
      className={`px-2.5 py-2 font-medium cursor-pointer select-none hover:text-gray-900 whitespace-nowrap ${align === 'right' ? 'text-right' : 'text-left'}`}>
      {label}
      {sortKey === k && <span className="ml-1">{sortDir === 'asc' ? '▲' : '▼'}</span>}
    </th>
  );
}

function ActionBtn({ busy, onClick, label }: { busy: boolean; onClick: () => void; label: string }) {
  return (
    <button disabled={busy} onClick={onClick}
      className="px-2 py-1 text-xs text-white bg-purple-600 hover:bg-purple-700 rounded disabled:opacity-50">
      {busy ? '…' : label}
    </button>
  );
}

function XeroCell({ cost, busy, onRetry, resyncBusy, onResync }: { cost: Cost; busy: boolean; onRetry: () => void; resyncBusy?: boolean; onResync?: () => void }) {
  const isBill = cost.payment_method === 'not_yet_paid' || cost.payment_method === 'reimburse_me';
  // Edited after it was pushed → Xero is out of date. Takes precedence over the
  // synced pills; offer a manual re-sync.
  if (cost.xero_stale && cost.xero_object_id) {
    return onResync ? (
      <button disabled={resyncBusy} onClick={onResync}
        title="Edited after it was pushed — Xero is out of date. Click to re-sync."
        className="px-2 py-0.5 text-xs rounded-full bg-amber-100 text-amber-800 hover:bg-amber-200 disabled:opacity-50 whitespace-nowrap">
        {resyncBusy ? '…' : 'Re-sync'}
      </button>
    ) : <span className="px-2 py-0.5 text-xs rounded-full bg-amber-100 text-amber-800">Out of date</span>;
  }
  // Paid-now costs have nothing to push until they're paid. Bills push on
  // approval, so show their state regardless of payment status.
  if (!isBill && cost.payment_status !== 'paid') {
    return <span className="text-xs text-gray-400">—</span>;
  }
  // A bill awaiting approval syncs AUTOMATICALLY the moment it's approved —
  // a "Push now" button here just looks like a chore (and would no-op anyway).
  if (isBill && !cost.xero_object_id
    && cost.approval_state !== 'approved' && cost.approval_state !== 'paid'
    && cost.xero_sync_state !== 'error') {
    return <span className="text-xs text-gray-400 whitespace-nowrap" title="The Xero bill is created automatically when this cost is approved">Syncs on approval</span>;
  }
  if (cost.xero_sync_state === 'reconciled') {
    return <span className="px-2 py-0.5 text-xs rounded-full bg-emerald-100 text-emerald-800">Reconciled</span>;
  }
  if (cost.xero_sync_state === 'attached') {
    if (isBill) {
      return cost.xero_payment_id
        ? <span className="px-2 py-0.5 text-xs rounded-full bg-green-100 text-green-800" title="Bill paid in Xero">Bill paid</span>
        : <span className="px-2 py-0.5 text-xs rounded-full bg-blue-100 text-blue-800" title="Bill in Xero, awaiting payment">In Xero</span>;
    }
    return <span className="px-2 py-0.5 text-xs rounded-full bg-green-100 text-green-800">Synced</span>;
  }
  if (cost.xero_sync_state === 'bill_created') {
    return <span className="px-2 py-0.5 text-xs rounded-full bg-blue-100 text-blue-800" title="In Xero; receipt attach pending">{isBill ? 'Bill created' : 'Sent'}</span>;
  }
  // Actionable states collapse the status + sync button into ONE clickable pill
  // (the button used to widen the column and push the row actions off-screen).
  if (cost.xero_sync_state === 'error') {
    return (
      <button disabled={busy} onClick={onRetry} title={`Push failed — click to retry.${cost.xero_error ? ' ' + cost.xero_error : ''}`}
        className="px-2 py-0.5 text-xs rounded-full bg-red-100 text-red-800 hover:bg-red-200 disabled:opacity-50 whitespace-nowrap">
        {busy ? '…' : 'Sync failed — retry'}
      </button>
    );
  }
  // pending + advisory xero_error → soft "Sync now". Re-triggerable after staff
  // fix the underlying gap (e.g. they've just set the bank-account mapping).
  if (cost.xero_error) {
    return (
      <button disabled={busy} onClick={onRetry} title={`Not synced — click to push to Xero.${cost.xero_error ? ' ' + cost.xero_error : ''}`}
        className="px-2 py-0.5 text-xs rounded-full bg-gray-100 text-gray-600 hover:bg-gray-200 disabled:opacity-50 whitespace-nowrap">
        {busy ? '…' : 'Sync now'}
      </button>
    );
  }
  // pending (paid but not yet pushed — likely scheduler just queued it)
  return (
    <button disabled={busy} onClick={onRetry} title="Queued for Xero — click to push now."
      className="px-2 py-0.5 text-xs rounded-full bg-gray-100 text-gray-700 hover:bg-gray-200 disabled:opacity-50 whitespace-nowrap">
      {busy ? '…' : 'Sync now'}
    </button>
  );
}

function StatCard({ label, value, sub, color }: { label: string; value: string; sub?: string; color: string }) {
  const colours: Record<string, string> = {
    amber: 'border-amber-200 bg-amber-50',
    blue: 'border-blue-200 bg-blue-50',
    purple: 'border-purple-200 bg-purple-50',
    gray: 'border-gray-200 bg-gray-50',
  };
  return (
    <div className={`border rounded-lg p-3 ${colours[color] || colours.gray}`}>
      <div className="text-xs text-gray-500">{label}</div>
      <div className="text-xl font-bold text-gray-900">{value}</div>
      {sub && <div className="text-xs text-gray-500">{sub}</div>}
    </div>
  );
}

// ── Xero COT probe ──────────────────────────────────────────────────────────
// "What's on the company card in Xero that isn't in OP." Reads SPEND bank
// transactions on the mapped COT account and lists the ones with no matching
// OP cost. Also the verification tool for the Codat→Xero feed — if it returns
// transactions we can read + match the card; if it returns nothing the
// purchases aren't landing as readable BankTransactions yet.
interface CotProbeTxn {
  bank_transaction_id: string | null;
  date: string | null;
  total: number;
  reference: string | null;
  contact_name: string | null;
  is_reconciled: boolean;
  status: string | null;
}
interface CotProbeResult {
  configured: boolean;
  message?: string;
  account_id?: string;
  window?: { days: number; from: string };
  fetched?: number;
  matched?: number;
  unmatched_count?: number;
  unmatched?: CotProbeTxn[];
}

function XeroCotProbe() {
  const [days, setDays] = useState(30);
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<CotProbeResult | null>(null);
  const [error, setError] = useState('');

  async function run() {
    setLoading(true); setError(''); setResult(null);
    try {
      const r = await api.get<{ data: CotProbeResult }>(`/costs/reconcile/xero-cot?days=${days}`);
      setResult(r.data);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Probe failed');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="mb-4 border border-gray-200 rounded-lg p-4 bg-gray-50">
      <div className="flex flex-wrap items-center gap-3">
        <div>
          <h3 className="text-sm font-semibold text-gray-800">Company card in Xero, not in OP</h3>
          <p className="text-xs text-gray-500">Reads card spend from Xero and lists anything with no matching OP cost.</p>
        </div>
        <div className="ml-auto flex items-center gap-2">
          <select value={days} onChange={(e) => setDays(Number(e.target.value))}
            className="border border-gray-300 rounded-md px-2 py-1 text-sm">
            <option value={14}>Last 14 days</option>
            <option value={30}>Last 30 days</option>
            <option value={60}>Last 60 days</option>
            <option value={90}>Last 90 days</option>
          </select>
          <button onClick={run} disabled={loading}
            className="px-3 py-1.5 text-sm text-white bg-purple-600 hover:bg-purple-700 rounded-md disabled:opacity-50">
            {loading ? 'Checking…' : 'Check Xero'}
          </button>
        </div>
      </div>

      {error && <div className="mt-3 bg-red-50 border border-red-200 text-red-700 text-sm rounded-md px-3 py-2">{error}</div>}

      {result && !result.configured && (
        <div className="mt-3 bg-amber-50 border border-amber-200 text-amber-800 text-sm rounded-md px-3 py-2">{result.message}</div>
      )}

      {result && result.configured && (
        <div className="mt-3">
          <p className="text-sm text-gray-700 mb-2">
            Fetched <strong>{result.fetched}</strong> card transaction{result.fetched === 1 ? '' : 's'} from the last {result.window?.days} days ·{' '}
            <span className="text-green-700">{result.matched} matched</span> ·{' '}
            <span className={result.unmatched_count ? 'text-amber-700 font-medium' : 'text-gray-500'}>{result.unmatched_count} not in OP</span>
          </p>
          {result.fetched === 0 && (
            <p className="text-xs text-gray-500 italic">
              No card transactions came back. Either there genuinely weren't any, or the card's purchases are sitting in Xero as raw
              (unreconciled) bank-statement lines, which the API doesn't expose until they're coded/reconciled. If you can see card spend
              in Xero for this period but nothing shows here, it's the latter — tell me and we'll take the statement-line route.
            </p>
          )}
          {result.unmatched && result.unmatched.length > 0 && (
            <div className="overflow-x-auto">
              <table className="min-w-full text-sm">
                <thead>
                  <tr className="text-left text-gray-500 border-b border-gray-200">
                    <th className="py-1.5 pr-3 font-medium">Date</th>
                    <th className="py-1.5 px-3 font-medium text-right">Amount</th>
                    <th className="py-1.5 px-3 font-medium">Reference / payee</th>
                    <th className="py-1.5 pl-3 font-medium">In Xero</th>
                  </tr>
                </thead>
                <tbody>
                  {result.unmatched.map((t, i) => (
                    <tr key={t.bank_transaction_id || i} className="border-b border-gray-100">
                      <td className="py-1.5 pr-3 whitespace-nowrap text-gray-700">{t.date || '—'}</td>
                      <td className="py-1.5 px-3 text-right font-medium text-gray-900">£{t.total.toFixed(2)}</td>
                      <td className="py-1.5 px-3 text-gray-600">{t.reference || t.contact_name || '—'}</td>
                      <td className="py-1.5 pl-3">
                        <span className={`text-xs px-2 py-0.5 rounded-full ${t.is_reconciled ? 'bg-emerald-100 text-emerald-800' : 'bg-gray-100 text-gray-600'}`}>
                          {t.is_reconciled ? 'reconciled' : t.status?.toLowerCase() || 'unreconciled'}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <p className="text-xs text-gray-400 mt-2">These are card payments in Xero with no matching cost in OP — log them (and attach the receipt) so they reconcile.</p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
