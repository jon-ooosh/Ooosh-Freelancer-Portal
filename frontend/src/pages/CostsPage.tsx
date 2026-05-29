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

const APPROVAL_COLOURS: Record<string, string> = {
  submitted: 'bg-gray-100 text-gray-700',
  verified: 'bg-blue-100 text-blue-700',
  approved: 'bg-amber-100 text-amber-700',
  paid: 'bg-green-100 text-green-700',
};

export default function CostsPage() {
  const [searchParams] = useSearchParams();
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
  const [actionBusy, setActionBusy] = useState<string | null>(null);

  useEffect(() => {
    const t = setTimeout(() => setSearchDebounced(search), 300);
    return () => clearTimeout(t);
  }, [search]);

  const load = useCallback(async () => {
    setLoading(true);
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
      setLoading(false);
    }
  }, [view, typeFilter, searchDebounced]);

  useEffect(() => { load(); }, [load]);

  async function runAction(id: string, action: 'verify' | 'approve' | 'pay') {
    setActionBusy(id + action);
    try {
      await api.post(`/costs/${id}/${action}`, {});
      await load();
    } catch (err) {
      alert(err instanceof Error ? err.message : `Failed to ${action}`);
    } finally {
      setActionBusy(null);
    }
  }

  async function confirmRecharge(c: CostRow) {
    setActionBusy(c.id + 'recharge');
    try {
      await api.post(`/costs/${c.id}/recharge`, { recharge_mode: c.recharge_mode, recharge_amount: c.recharge_amount });
      await load();
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
                <th className="px-3 py-2 text-left font-medium">Date</th>
                <th className="px-3 py-2 text-left font-medium">Supplier</th>
                <th className="px-3 py-2 text-left font-medium">Description</th>
                <th className="px-3 py-2 text-right font-medium">Gross</th>
                <th className="px-3 py-2 text-left font-medium">Type</th>
                <th className="px-3 py-2 text-left font-medium">Linked</th>
                <th className="px-3 py-2 text-left font-medium">Status</th>
                <th className="px-3 py-2 text-right font-medium">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {rows.map((c) => (
                <tr key={c.id} className="hover:bg-gray-50">
                  <td className="px-3 py-2 whitespace-nowrap text-gray-700">{c.cost_date || '—'}</td>
                  <td className="px-3 py-2 text-gray-900">{c.supplier_name || '—'}</td>
                  <td className="px-3 py-2 text-gray-600 max-w-xs truncate">{c.description || '—'}</td>
                  <td className="px-3 py-2 text-right font-medium text-gray-900">{gbp(c.amount_gross)}</td>
                  <td className="px-3 py-2 text-gray-600">{c.cost_type.replace('_', ' ')}</td>
                  <td className="px-3 py-2 text-gray-600">
                    {c.hh_job_number ? <span className="text-purple-700">#{c.hh_job_number}</span>
                      : c.vehicle_reg ? <span className="text-purple-700">{c.vehicle_reg}</span> : '—'}
                  </td>
                  <td className="px-3 py-2">
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
                  <td className="px-3 py-2 text-right whitespace-nowrap">
                    {view === 'payable' && (
                      <PayableActions cost={c} isManager={isManager} isAdmin={isAdmin} busy={actionBusy} onAction={runAction} />
                    )}
                    {view === 'recharge' && !c.recharged_to_hh_at && (
                      <button disabled={actionBusy === c.id + 'recharge'} onClick={() => confirmRecharge(c)}
                        className="px-2 py-1 text-xs text-blue-700 hover:bg-blue-50 rounded disabled:opacity-50">
                        Confirm recharge
                      </button>
                    )}
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
    </div>
  );
}

function PayableActions({ cost, isManager, isAdmin, busy, onAction }: {
  cost: Cost;
  isManager: boolean;
  isAdmin: boolean;
  busy: string | null;
  onAction: (id: string, a: 'verify' | 'approve' | 'pay') => void;
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
    return <ActionBtn busy={busy === cost.id + 'pay'} onClick={() => onAction(cost.id, 'pay')} label="Mark paid" />;
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
