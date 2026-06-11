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
import { useState, useEffect, useCallback } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api } from '../services/api';
import { useAuthStore } from '../hooks/useAuthStore';
import CostCaptureModal from '../components/CostCaptureModal';
import type { Cost } from '../../../shared/types';

type ViewMode = 'all' | 'payable' | 'recharge' | 'reconcile';

interface CostRow extends Cost {
  uploaded_by_name?: string | null;
  hh_job_number?: number | null;
  job_name?: string | null;
  vehicle_reg?: string | null;
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

const APPROVAL_COLOURS: Record<string, string> = {
  submitted: 'bg-gray-100 text-gray-700',
  verified: 'bg-blue-100 text-blue-700',
  approved: 'bg-amber-100 text-amber-700',
  paid: 'bg-green-100 text-green-700',
};

export default function CostsPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const { user } = useAuthStore();
  const role = user?.role || '';
  const isManager = role === 'admin' || role === 'manager';
  const isAdmin = role === 'admin';

  const [view, setView] = useState<ViewMode>((searchParams.get('view') as ViewMode) || 'all');
  const [rows, setRows] = useState<CostRow[]>([]);
  const [stats, setStats] = useState<Stats | null>(null);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [searchDebounced, setSearchDebounced] = useState('');
  const [typeFilter, setTypeFilter] = useState('');
  const [showCapture, setShowCapture] = useState(false);
  const [editing, setEditing] = useState<CostRow | null>(null);
  const [payTarget, setPayTarget] = useState<CostRow | null>(null);
  const [preview, setPreview] = useState<CostRow | null>(null);
  const [actionBusy, setActionBusy] = useState<string | null>(null);

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
      const res = await api.get<{ data: CostRow[]; stats: Stats }>(`/costs?${params.toString()}`);
      setRows(res.data);
      setStats(res.stats);
    } catch (err) {
      console.error('Failed to load costs:', err);
    } finally {
      if (!quiet) setLoading(false);
    }
  }, [view, typeFilter, searchDebounced]);

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
    if (!confirm(`Delete this cost${c.supplier_name ? ` from ${c.supplier_name}` : ''}? This cannot be undone.`)) return;
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

  async function confirmRecharge(c: CostRow) {
    setActionBusy(c.id + 'recharge');
    try {
      await api.post(`/costs/${c.id}/recharge`, { recharge_mode: c.recharge_mode, recharge_amount: c.recharge_amount });
      await load(true);
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Failed to confirm recharge');
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
      </div>

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
                <th className="px-2.5 py-2 text-left font-medium">Date</th>
                <th className="px-2.5 py-2 text-left font-medium">Supplier</th>
                <th className="px-2.5 py-2 text-left font-medium">Description</th>
                <th className="px-2.5 py-2 text-right font-medium">Gross</th>
                <th className="px-2.5 py-2 text-left font-medium">Type</th>
                <th className="px-2.5 py-2 text-left font-medium">Linked</th>
                <th className="px-2.5 py-2 text-left font-medium">Uploaded by</th>
                <th className="px-2.5 py-2 text-left font-medium">Status</th>
                <th className="px-2.5 py-2 text-left font-medium">Xero</th>
                <th className="px-2.5 py-2 text-right font-medium">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {rows.map((c) => (
                <tr key={c.id} className="hover:bg-gray-50">
                  <td className="px-2.5 py-2 whitespace-nowrap text-gray-700">{fmtDate(c.cost_date)}</td>
                  <td className="px-2.5 py-2 text-gray-900">
                    <div className="flex items-center gap-2">
                      {c.receipt_r2_key && <ReceiptThumb cost={c} onOpen={() => setPreview(c)} />}
                      <div className="min-w-0">
                        <div className="truncate max-w-[160px]">{c.supplier_name || '—'}</div>
                        {c.invoice_number && <div className="text-xs text-gray-400 truncate max-w-[160px]">#{c.invoice_number}</div>}
                      </div>
                    </div>
                  </td>
                  <td className="px-2.5 py-2 text-gray-600 max-w-[180px] truncate">{c.description || '—'}</td>
                  <td className="px-2.5 py-2 text-right font-medium text-gray-900">{gbp(c.amount_gross)}</td>
                  <td className="px-2.5 py-2 text-gray-600">{c.category || c.cost_type.replace('_', ' ')}</td>
                  <td className="px-2.5 py-2 text-gray-600">
                    {c.hh_job_number ? <span className="text-purple-700">#{c.hh_job_number}</span>
                      : c.vehicle_reg ? <span className="text-purple-700">{c.vehicle_reg}</span> : '—'}
                  </td>
                  <td className="px-2.5 py-2 text-gray-600 whitespace-nowrap">{c.uploaded_by_name || '—'}</td>
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
                  <td className="px-2.5 py-2">
                    <XeroCell cost={c} busy={actionBusy === c.id + 'sync'} onRetry={() => retrySync(c)} />
                  </td>
                  <td className="px-2.5 py-2 text-right whitespace-nowrap">
                    <div className="flex items-center justify-end gap-2">
                      {view === 'payable' && (
                        <PayableActions cost={c} isManager={isManager} isAdmin={isAdmin} busy={actionBusy} onAction={runAction} onPay={() => setPayTarget(c)} />
                      )}
                      {view === 'recharge' && !c.recharged_to_hh_at && (
                        <button disabled={actionBusy === c.id + 'recharge'} onClick={() => confirmRecharge(c)}
                          className="px-2 py-1 text-xs text-blue-700 hover:bg-blue-50 rounded disabled:opacity-50">
                          Confirm recharge
                        </button>
                      )}
                      <button onClick={() => setEditing(c)} className="px-2 py-1 text-xs text-gray-600 hover:bg-gray-100 rounded">
                        Edit
                      </button>
                      {isManager && (
                        <button disabled={actionBusy === c.id + 'delete'} onClick={() => deleteCost(c)}
                          className="px-2 py-1 text-xs text-red-600 hover:bg-red-50 rounded disabled:opacity-50">
                          Delete
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
        />
      )}
      {editing && (
        <CostCaptureModal
          existing={editing}
          onClose={() => setEditing(null)}
          onSaved={() => { setEditing(null); load(); }}
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
      {preview && <ReceiptPreview cost={preview} onClose={() => setPreview(null)} />}
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
  { value: 'wise', label: 'Wise bank transfer' },
  { value: 'lloyds_transfer', label: 'Lloyds bank transfer' },
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
  const [paidMethod, setPaidMethod] = useState('wise');
  const isReimburse = cost.payment_method === 'reimburse_me';

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
            {' '}of <strong>{gbp(cost.amount_gross)}</strong>.
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
  if (s === 'verified' && isAdmin) {
    return <ActionBtn busy={busy === cost.id + 'approve'} onClick={() => onAction(cost.id, 'approve')} label="Approve" />;
  }
  if (s === 'approved' && isAdmin) {
    return <ActionBtn busy={busy === cost.id + 'pay'} onClick={onPay} label="Mark paid" />;
  }
  return <span className="text-xs text-gray-400">{s ? `awaiting ${s === 'verified' ? 'approval' : 'payment'}` : '—'}</span>;
}

function ActionBtn({ busy, onClick, label }: { busy: boolean; onClick: () => void; label: string }) {
  return (
    <button disabled={busy} onClick={onClick}
      className="px-2 py-1 text-xs text-white bg-purple-600 hover:bg-purple-700 rounded disabled:opacity-50">
      {busy ? '…' : label}
    </button>
  );
}

function XeroCell({ cost, busy, onRetry }: { cost: Cost; busy: boolean; onRetry: () => void }) {
  const isBill = cost.payment_method === 'not_yet_paid' || cost.payment_method === 'reimburse_me';
  // Paid-now costs have nothing to push until they're paid. Bills push on
  // approval, so show their state regardless of payment status.
  if (!isBill && cost.payment_status !== 'paid') {
    return <span className="text-xs text-gray-400">—</span>;
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
  if (cost.xero_sync_state === 'error') {
    return (
      <div className="flex items-center gap-2">
        <span className="px-2 py-0.5 text-xs rounded-full bg-red-100 text-red-800" title={cost.xero_error || ''}>Failed</span>
        <button disabled={busy} onClick={onRetry} className="text-xs text-purple-700 hover:underline disabled:opacity-50">
          {busy ? '…' : 'Retry'}
        </button>
      </div>
    );
  }
  // pending + advisory xero_error → soft "Not synced" pill. Push now stays
  // available so staff can re-trigger after fixing the underlying gap (e.g.
  // they've just set the bank-account mapping).
  if (cost.xero_error) {
    return (
      <div className="flex items-center gap-2">
        <span className="px-2 py-0.5 text-xs rounded-full bg-gray-100 text-gray-600" title={cost.xero_error}>
          Not synced
        </span>
        <button disabled={busy} onClick={onRetry} className="text-xs text-purple-700 hover:underline disabled:opacity-50">
          {busy ? '…' : 'Push now'}
        </button>
      </div>
    );
  }
  // pending (paid but not yet pushed — likely scheduler just queued it)
  return (
    <div className="flex items-center gap-2">
      <span className="px-2 py-0.5 text-xs rounded-full bg-gray-100 text-gray-700">Pending</span>
      <button disabled={busy} onClick={onRetry} className="text-xs text-purple-700 hover:underline disabled:opacity-50">
        {busy ? '…' : 'Push now'}
      </button>
    </div>
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
