/**
 * ExcessLedgerPage — Global excess overview at /money/excess.
 *
 * Shows summary cards, client ledger table, and click-through to per-client history.
 * Admin/manager only.
 */
import { useState, useEffect, useCallback } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api } from '../services/api';
import ExcessPaymentModal, { statusLabel, statusColor } from '../components/ExcessPaymentModal';
import { MobileListCard } from '../components/mobile/MobileListCard';
import type { ClientExcessLedgerEntry, JobExcess } from '../../../shared/types';

type ViewMode = 'ledger' | 'all' | 'client-detail';

export default function ExcessLedgerPage() {
  const [searchParams] = useSearchParams();
  // Deep-link support: /money/excess?status=pre_auth lands on the All Records
  // view pre-filtered (used by the dashboard "Pre-auth Holds Expiring" bucket).
  const initialStatus = searchParams.get('status') || '';
  const [viewMode, setViewMode] = useState<ViewMode>(initialStatus ? 'all' : 'ledger');
  const [ledger, setLedger] = useState<ClientExcessLedgerEntry[]>([]);
  const [allRecords, setAllRecords] = useState<JobExcess[]>([]);
  const [loading, setLoading] = useState(true);
  const [statusFilter, setStatusFilter] = useState<string>(initialStatus);
  const [sortBy, setSortBy] = useState<string>('newest');
  const [methodFilter, setMethodFilter] = useState<string>('');
  const [searchText, setSearchText] = useState<string>('');
  const [searchDebounced, setSearchDebounced] = useState<string>('');

  // Client detail state
  const [selectedClient, setSelectedClient] = useState<ClientExcessLedgerEntry | null>(null);
  const [clientHistory, setClientHistory] = useState<JobExcess[]>([]);
  const [clientLoading, setClientLoading] = useState(false);

  // Action modal
  const [actionExcess, setActionExcess] = useState<JobExcess | null>(null);

  const loadLedger = useCallback(async () => {
    setLoading(true);
    try {
      const data = await api.get<{ data: ClientExcessLedgerEntry[] }>('/excess/ledger');
      setLedger(data.data);
    } catch (err) {
      console.error('Failed to load excess ledger:', err);
    } finally {
      setLoading(false);
    }
  }, []);

  const loadAllRecords = useCallback(async () => {
    setLoading(true);
    try {
      const qp = new URLSearchParams({ limit: '200' });
      if (statusFilter) qp.set('status', statusFilter);
      if (methodFilter) qp.set('payment_method', methodFilter);
      if (searchDebounced) qp.set('search', searchDebounced);
      if (sortBy) qp.set('sort', sortBy);
      const data = await api.get<{ data: JobExcess[] }>(`/excess?${qp.toString()}`);
      setAllRecords(data.data);
    } catch (err) {
      console.error('Failed to load excess records:', err);
    } finally {
      setLoading(false);
    }
  }, [statusFilter, methodFilter, searchDebounced, sortBy]);

  // Debounce search input
  useEffect(() => {
    const timer = setTimeout(() => setSearchDebounced(searchText), 300);
    return () => clearTimeout(timer);
  }, [searchText]);

  useEffect(() => {
    if (viewMode === 'ledger') loadLedger();
    else if (viewMode === 'all') loadAllRecords();
  }, [viewMode, loadLedger, loadAllRecords]);

  async function loadClientDetail(client: ClientExcessLedgerEntry) {
    setSelectedClient(client);
    setViewMode('client-detail');
    setClientLoading(true);
    try {
      const data = await api.get<{ summary: any; history: JobExcess[] }>(`/excess/ledger/${encodeURIComponent(client.xero_contact_id)}`);
      setClientHistory(data.history);
    } catch (err) {
      console.error('Failed to load client history:', err);
    } finally {
      setClientLoading(false);
    }
  }

  function handleBackToLedger() {
    setViewMode('ledger');
    setSelectedClient(null);
    setClientHistory([]);
  }

  // Summary totals.
  // - On Client Ledger view, totals come from the `ledger` array (one row per client).
  // - On All Records view, totals come from the filtered `allRecords` array so the
  //   cards reflect the current search/filter (e.g. searching "vapors" shows only
  //   Vapors' totals). Otherwise the cards lie about scope when filters are applied.
  let totalHeld: number;
  let totalPending: number;
  let totalClients: number;
  let totalRolledOver: number;

  if (viewMode === 'all') {
    // Compute per-record stats from the filtered set.
    const heldStatuses = new Set(['taken', 'partially_paid', 'pre_auth', 'partially_reimbursed']);
    const pendingStatuses = new Set(['needed', 'pending', 'partially_paid']);
    let held = 0;
    let pending = 0;
    let rolled = 0;
    const clientsWithBalance = new Set<string>();
    for (const r of allRecords) {
      const balance = Math.max(
        0,
        Number(r.excess_amount_taken || 0) - Number(r.claim_amount || 0) - Number(r.reimbursement_amount || 0)
      );
      if (heldStatuses.has(r.excess_status) && balance > 0) {
        held += balance;
        // Bucket by xero_contact_id when present, else client_name; matches the
        // grouping used by the ledger view.
        const key = r.xero_contact_id || (r.client_name ? `name:${r.client_name}` : 'UNLINKED');
        clientsWithBalance.add(key);
      }
      if (pendingStatuses.has(r.excess_status)) pending += 1;
      if (r.excess_status === 'rolled_over') rolled += 1;
    }
    totalHeld = held;
    totalPending = pending;
    totalClients = clientsWithBalance.size;
    totalRolledOver = rolled;
  } else {
    totalHeld = ledger.reduce((sum, c) => sum + Number(c.balance_held || 0), 0);
    totalPending = ledger.reduce((sum, c) => sum + Number(c.pending_count || 0), 0);
    totalClients = ledger.length;
    totalRolledOver = ledger.reduce((sum, c) => sum + Number(c.rolled_over_count || 0), 0);
  }

  const filtered = viewMode === 'all' && (statusFilter || methodFilter || searchDebounced);

  return (
    <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
      {/* Page header */}
      <div className="flex items-center justify-between mb-6">
        <div>
          {viewMode === 'client-detail' && selectedClient ? (
            <>
              <button onClick={handleBackToLedger} className="text-sm text-gray-500 hover:text-gray-700 flex items-center gap-1 mb-1">
                <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 19.5L8.25 12l7.5-7.5" />
                </svg>
                Back to Ledger
              </button>
              <h1 className="text-2xl font-bold text-gray-900">
                {selectedClient.xero_contact_name || selectedClient.client_name}
              </h1>
              <p className="text-sm text-gray-500 mt-1">Excess history for this client</p>
            </>
          ) : (
            <>
              <h1 className="text-2xl font-bold text-gray-900">Insurance Excess</h1>
              <p className="text-sm text-gray-500 mt-1">Track and manage insurance excess deposits across all hires</p>
            </>
          )}
        </div>
      </div>

      {/* Summary cards (not shown in client detail) */}
      {viewMode !== 'client-detail' && (
        <>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-2">
            <SummaryCard label="Total Held" value={`£${totalHeld.toFixed(2)}`} color="green" />
            <SummaryCard label="Pending Collection" value={String(totalPending)} color="amber" />
            <SummaryCard label="Clients with Balance" value={String(totalClients)} color="blue" />
            <SummaryCard label="Rolled Over" value={String(totalRolledOver)} color="purple" />
          </div>
          {filtered && (
            <p className="text-xs text-gray-500 mb-6 italic">
              Showing totals for current filter ({allRecords.length} record{allRecords.length === 1 ? '' : 's'})
            </p>
          )}
          {!filtered && <div className="mb-6" />}
        </>
      )}

      {/* Client detail summary cards */}
      {viewMode === 'client-detail' && selectedClient && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-6">
          <SummaryCard label="Total Taken" value={`£${Number(selectedClient.total_taken || 0).toFixed(2)}`} color="green" />
          <SummaryCard label="Total Claimed" value={`£${Number(selectedClient.total_claimed || 0).toFixed(2)}`} color="red" />
          <SummaryCard label="Total Reimbursed" value={`£${Number(selectedClient.total_reimbursed || 0).toFixed(2)}`} color="blue" />
          <SummaryCard label="Balance Held" value={`£${Number(selectedClient.balance_held || 0).toFixed(2)}`} color="green" />
        </div>
      )}

      {/* View toggle (ledger vs client detail) */}
      {viewMode !== 'client-detail' && (
        <div className="space-y-3 mb-4">
          <div className="flex items-center gap-4">
            <div className="flex bg-gray-100 rounded-lg p-0.5">
              <button
                onClick={() => setViewMode('ledger')}
                className={`px-4 py-1.5 text-sm font-medium rounded-md transition-colors ${
                  viewMode === 'ledger' ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-600 hover:text-gray-900'
                }`}
              >
                Client Ledger
              </button>
              <button
                onClick={() => setViewMode('all')}
                className={`px-4 py-1.5 text-sm font-medium rounded-md transition-colors ${
                  viewMode === 'all' ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-600 hover:text-gray-900'
                }`}
              >
                All Records
              </button>
            </div>
          </div>

          {viewMode === 'all' && (
            <div className="flex flex-wrap items-center gap-3">
              {/* Search */}
              <div className="relative flex-1 min-w-[180px] max-w-xs">
                <svg className="absolute left-2.5 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-400" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-5.197-5.197m0 0A7.5 7.5 0 105.196 5.196a7.5 7.5 0 0010.607 10.607z" />
                </svg>
                <input
                  type="text"
                  placeholder="Search client, driver, job..."
                  value={searchText}
                  onChange={(e) => setSearchText(e.target.value)}
                  className="w-full text-sm border border-gray-300 rounded-md pl-8 pr-3 py-1.5"
                />
              </div>

              {/* Status filter */}
              <select
                value={statusFilter}
                onChange={(e) => setStatusFilter(e.target.value)}
                className="text-sm border border-gray-300 rounded-md px-3 py-1.5"
              >
                <option value="">All statuses</option>
                <option value="needed">Needed</option>
                <option value="taken">Taken</option>
                <option value="partially_paid">Partially Paid</option>
                <option value="pre_auth">Pre-auth Held</option>
                <option value="released">Released</option>
                <option value="fully_claimed">Fully Claimed</option>
                <option value="partially_reimbursed">Partially Reimbursed</option>
                <option value="reimbursed">Reimbursed</option>
                <option value="rolled_over">Rolled Over</option>
                <option value="waived">Waived</option>
              </select>

              {/* Payment method filter */}
              <select
                value={methodFilter}
                onChange={(e) => setMethodFilter(e.target.value)}
                className="text-sm border border-gray-300 rounded-md px-3 py-1.5"
              >
                <option value="">All methods</option>
                <option value="worldpay">Worldpay</option>
                <option value="amex">Amex</option>
                <option value="stripe_gbp">Stripe GBP</option>
                <option value="wise_bacs">Wise (BACS)</option>
                <option value="till_cash">Cash</option>
                <option value="paypal">PayPal</option>
                <option value="lloyds_bank">Lloyds Bank</option>
                <option value="rolled_over">Account Balance</option>
              </select>

              {/* Sort */}
              <select
                value={sortBy}
                onChange={(e) => setSortBy(e.target.value)}
                className="text-sm border border-gray-300 rounded-md px-3 py-1.5"
              >
                <optgroup label="Date">
                  <option value="newest">Newest first</option>
                  <option value="oldest">Oldest first</option>
                  <option value="payment_date_desc">Payment date (newest)</option>
                  <option value="payment_date_asc">Payment date (oldest)</option>
                  <option value="reimbursed_date_desc">Reimbursed date (newest)</option>
                  <option value="reimbursed_date_asc">Reimbursed date (oldest)</option>
                </optgroup>
                <optgroup label="Amount">
                  <option value="amount_high">Required (highest)</option>
                  <option value="amount_low">Required (lowest)</option>
                  <option value="collected_high">Collected (highest)</option>
                  <option value="collected_low">Collected (lowest)</option>
                </optgroup>
                <optgroup label="Client">
                  <option value="client_az">Client A-Z</option>
                  <option value="client_za">Client Z-A</option>
                </optgroup>
              </select>

              {/* Active filter count + clear */}
              {(statusFilter || methodFilter || searchText || sortBy !== 'newest') && (
                <button
                  onClick={() => { setStatusFilter(''); setMethodFilter(''); setSearchText(''); setSortBy('newest'); }}
                  className="text-xs text-gray-500 hover:text-gray-700 underline"
                >
                  Clear filters
                </button>
              )}
            </div>
          )}
        </div>
      )}

      {/* Content */}
      {loading ? (
        <div className="text-center py-12 text-gray-500">Loading...</div>
      ) : viewMode === 'ledger' ? (
        <LedgerTable entries={ledger} onSelectClient={loadClientDetail} />
      ) : viewMode === 'all' ? (
        <RecordsTable records={allRecords} onSelectRecord={setActionExcess} />
      ) : (
        <RecordsTable
          records={clientHistory}
          onSelectRecord={setActionExcess}
          loading={clientLoading}
        />
      )}

      {/* Action modal */}
      {actionExcess && (
        <ExcessPaymentModal
          excess={actionExcess}
          onClose={() => setActionExcess(null)}
          onUpdated={() => {
            if (viewMode === 'ledger') loadLedger();
            else if (viewMode === 'all') loadAllRecords();
            else if (selectedClient) loadClientDetail(selectedClient);
          }}
        />
      )}
    </div>
  );
}

// ── Sub-components ──

function SummaryCard({ label, value, color }: { label: string; value: string; color: string }) {
  const colorMap: Record<string, string> = {
    green: 'bg-green-50 border-green-200 text-green-800',
    amber: 'bg-amber-50 border-amber-200 text-amber-800',
    blue: 'bg-blue-50 border-blue-200 text-blue-800',
    purple: 'bg-purple-50 border-purple-200 text-purple-800',
    red: 'bg-red-50 border-red-200 text-red-800',
  };
  return (
    <div className={`rounded-lg border p-4 ${colorMap[color] || colorMap.blue}`}>
      <p className="text-xs font-medium opacity-75">{label}</p>
      <p className="text-xl font-bold mt-1">{value}</p>
    </div>
  );
}

function LedgerTable({ entries, onSelectClient }: { entries: ClientExcessLedgerEntry[]; onSelectClient: (e: ClientExcessLedgerEntry) => void }) {
  if (entries.length === 0) {
    return <p className="text-center py-12 text-gray-500">No excess records found.</p>;
  }

  return (
    <div className="bg-white rounded-lg border border-gray-200 overflow-hidden">
      {/* Desktop table */}
      <div className="hidden md:block overflow-x-auto">
        <table className="min-w-full divide-y divide-gray-200">
          <thead className="bg-gray-50">
            <tr>
              <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Client</th>
              <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase">Hires</th>
              <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase">Total Taken</th>
              <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase">Claimed</th>
              <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase">Reimbursed</th>
              <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase">Balance Held</th>
              <th className="px-4 py-3 text-center text-xs font-medium text-gray-500 uppercase">Pending</th>
              <th className="px-4 py-3 text-center text-xs font-medium text-gray-500 uppercase">Rolled Over</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-200">
            {entries.map((entry) => (
              <tr
                key={entry.xero_contact_id}
                onClick={() => onSelectClient(entry)}
                className="hover:bg-gray-50 cursor-pointer"
              >
                <td className="px-4 py-3">
                  <p className="text-sm font-medium text-gray-900">{entry.xero_contact_name || entry.client_name}</p>
                  {entry.client_name && entry.client_name !== entry.xero_contact_name && (
                    <p className="text-xs text-gray-500">{entry.client_name}</p>
                  )}
                </td>
                <td className="px-4 py-3 text-right text-sm text-gray-600">{entry.total_hires}</td>
                <td className="px-4 py-3 text-right text-sm text-gray-600">£{Number(entry.total_taken).toFixed(2)}</td>
                <td className="px-4 py-3 text-right text-sm text-red-600">
                  {Number(entry.total_claimed) > 0 ? `£${Number(entry.total_claimed).toFixed(2)}` : '—'}
                </td>
                <td className="px-4 py-3 text-right text-sm text-gray-600">
                  {Number(entry.total_reimbursed) > 0 ? `£${Number(entry.total_reimbursed).toFixed(2)}` : '—'}
                </td>
                <td className="px-4 py-3 text-right text-sm font-semibold text-green-700">
                  £{Number(entry.balance_held).toFixed(2)}
                </td>
                <td className="px-4 py-3 text-center">
                  {Number(entry.pending_count) > 0 && (
                    <span className="inline-block px-2 py-0.5 text-xs font-medium bg-amber-100 text-amber-800 rounded-full">
                      {entry.pending_count}
                    </span>
                  )}
                </td>
                <td className="px-4 py-3 text-center">
                  {Number(entry.rolled_over_count) > 0 && (
                    <span className="inline-block px-2 py-0.5 text-xs font-medium bg-purple-100 text-purple-800 rounded-full">
                      {entry.rolled_over_count}
                    </span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Mobile cards */}
      <div className="md:hidden divide-y divide-gray-100">
        {entries.map((entry) => (
          <MobileListCard
            key={entry.xero_contact_id}
            onToggle={() => onSelectClient(entry)}
            primary={entry.xero_contact_name || entry.client_name || '—'}
            secondary={
              entry.client_name && entry.client_name !== entry.xero_contact_name
                ? entry.client_name
                : null
            }
            trailing={
              <div className="text-right">
                <div className="text-base font-semibold text-green-700">£{Number(entry.balance_held).toFixed(0)}</div>
                <div className="text-[10px] text-gray-400 uppercase tracking-wide">held</div>
              </div>
            }
            meta={
              <>
                <span>{entry.total_hires} hire{entry.total_hires === 1 ? '' : 's'}</span>
                <span>· Taken £{Number(entry.total_taken).toFixed(0)}</span>
                {Number(entry.total_claimed) > 0 && (
                  <span className="text-red-600">· Claimed £{Number(entry.total_claimed).toFixed(0)}</span>
                )}
                {Number(entry.total_reimbursed) > 0 && (
                  <span>· Reimbursed £{Number(entry.total_reimbursed).toFixed(0)}</span>
                )}
              </>
            }
            chips={
              <>
                {Number(entry.pending_count) > 0 && (
                  <span className="text-xs px-2 py-0.5 rounded-full bg-amber-100 text-amber-800 font-medium">
                    {entry.pending_count} pending
                  </span>
                )}
                {Number(entry.rolled_over_count) > 0 && (
                  <span className="text-xs px-2 py-0.5 rounded-full bg-purple-100 text-purple-800 font-medium">
                    {entry.rolled_over_count} rolled over
                  </span>
                )}
              </>
            }
          />
        ))}
      </div>
    </div>
  );
}

function RecordsTable({
  records,
  onSelectRecord,
  loading,
}: {
  records: JobExcess[];
  onSelectRecord: (r: JobExcess) => void;
  loading?: boolean;
}) {
  if (loading) {
    return <div className="text-center py-12 text-gray-500">Loading...</div>;
  }

  if (records.length === 0) {
    return <p className="text-center py-12 text-gray-500">No excess records found.</p>;
  }

  return (
    <div className="bg-white rounded-lg border border-gray-200 overflow-hidden">
      {/* Desktop table */}
      <div className="hidden md:block overflow-x-auto">
      <table className="min-w-full divide-y divide-gray-200">
        <thead className="bg-gray-50">
          <tr>
            <th className="px-3 py-3 text-left text-xs font-medium text-gray-500 uppercase">Job / Client</th>
            <th className="px-3 py-3 text-left text-xs font-medium text-gray-500 uppercase">Driver</th>
            <th className="px-3 py-3 text-left text-xs font-medium text-gray-500 uppercase">Vehicle</th>
            <th className="px-3 py-3 text-right text-xs font-medium text-gray-500 uppercase">Required</th>
            <th className="px-3 py-3 text-right text-xs font-medium text-gray-500 uppercase">Collected</th>
            <th className="px-3 py-3 text-center text-xs font-medium text-gray-500 uppercase">Status</th>
            <th className="px-3 py-3 text-left text-xs font-medium text-gray-500 uppercase">Method</th>
            <th className="px-3 py-3 text-left text-xs font-medium text-gray-500 uppercase">Paid</th>
            <th className="px-3 py-3 text-left text-xs font-medium text-gray-500 uppercase">Reimbursed</th>
            <th className="px-3 py-3 text-center text-xs font-medium text-gray-500 uppercase">HH</th>
            <th className="px-3 py-3 text-center text-xs font-medium text-gray-500 uppercase"></th>
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-200">
          {records.map((record) => (
            <tr key={record.id} className="hover:bg-gray-50">
              <td className="px-3 py-3">
                <p className="text-sm font-medium text-gray-900">{record.hirehop_job_name || record.job_name || '—'}</p>
                <p className="text-xs text-gray-500">
                  {record.client_name || '—'}
                  {record.hirehop_job_id ? ` · HH #${record.hirehop_job_id}` : ''}
                </p>
              </td>
              <td className="px-3 py-3 text-sm text-gray-600">{record.driver_name || '—'}</td>
              <td className="px-3 py-3 text-sm text-gray-600">{record.vehicle_reg || '—'}</td>
              <td className="px-3 py-3 text-right text-sm text-gray-600">
                {record.excess_amount_required != null ? `£${Number(record.excess_amount_required).toFixed(2)}` : '—'}
              </td>
              <td className="px-3 py-3 text-right text-sm font-medium text-gray-900">
                {Number(record.amount_held || 0) > 0 ? (
                  <span className="text-sky-700" title="On pre-auth hold (not yet captured)">
                    £{Number(record.amount_held).toFixed(2)} held
                  </span>
                ) : (
                  <>£{Number(record.excess_amount_taken || 0).toFixed(2)}</>
                )}
              </td>
              <td className="px-3 py-3 text-center">
                <span className={`inline-block px-2 py-0.5 rounded-full text-xs font-medium ${statusColor(record.excess_status)}`}>
                  {statusLabel(record.excess_status)}
                </span>
                {record.held_on_account && (record.excess_status === 'taken' || record.excess_status === 'partially_paid') && (
                  <span className="block mt-1 text-[10px] font-semibold text-purple-700" title="Held on account for the client's next hire">Held on account</span>
                )}
                {record.dispatch_override && (
                  <span className="block mt-1 text-[10px] text-amber-600">overridden</span>
                )}
              </td>
              <td className="px-3 py-3 text-xs text-gray-500 whitespace-nowrap">
                {record.payment_method ? record.payment_method.replace(/_/g, ' ') : '—'}
              </td>
              <td className="px-3 py-3 text-xs text-gray-500 whitespace-nowrap">
                {record.payment_date
                  ? new Date(record.payment_date).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: '2-digit' })
                  : '—'}
              </td>
              <td className="px-3 py-3 text-xs text-gray-500 whitespace-nowrap">
                {record.reimbursement_date
                  ? new Date(record.reimbursement_date).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: '2-digit' })
                  : '—'}
              </td>
              <td className="px-3 py-3 text-center">
                {record.hh_deposit_id ? (
                  <span className="text-[10px] text-green-600 font-medium" title={`HH #${record.hh_deposit_id}`}>linked</span>
                ) : (
                  <span className="text-[10px] text-gray-400">—</span>
                )}
              </td>
              <td className="px-3 py-3 text-center">
                <button
                  onClick={() => onSelectRecord(record)}
                  className="text-xs font-medium text-ooosh-600 hover:text-ooosh-800"
                >
                  Manage
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      </div>

      {/* Mobile cards */}
      <div className="md:hidden divide-y divide-gray-100">
        {records.map((record) => (
          <MobileListCard
            key={record.id}
            onToggle={() => onSelectRecord(record)}
            primary={record.hirehop_job_name || record.job_name || '—'}
            secondary={
              <>
                {record.client_name || '—'}
                {record.hirehop_job_id ? ` · HH #${record.hirehop_job_id}` : ''}
              </>
            }
            trailing={
              <span className="flex flex-col items-end gap-1">
                <span className={`inline-block px-2 py-1 rounded-full text-xs font-medium whitespace-nowrap ${statusColor(record.excess_status)}`}>
                  {statusLabel(record.excess_status)}
                </span>
                {record.held_on_account && (record.excess_status === 'taken' || record.excess_status === 'partially_paid') && (
                  <span className="text-[10px] font-semibold text-purple-700">Held on account</span>
                )}
              </span>
            }
            meta={
              <>
                {record.driver_name && <span>👤 {record.driver_name}</span>}
                {record.vehicle_reg && <span>· 🚐 {record.vehicle_reg}</span>}
                {record.payment_method && <span>· {record.payment_method.replace(/_/g, ' ')}</span>}
              </>
            }
            chips={
              <>
                <span className="text-xs px-2 py-0.5 rounded-full bg-gray-100 text-gray-700 font-medium">
                  Required £{Number(record.excess_amount_required ?? 0).toFixed(0)}
                </span>
                <span className="text-xs px-2 py-0.5 rounded-full bg-green-50 text-green-700 font-medium">
                  Taken £{Number(record.excess_amount_taken || 0).toFixed(0)}
                </span>
                {record.dispatch_override && (
                  <span className="text-xs px-2 py-0.5 rounded-full bg-amber-100 text-amber-700 font-medium">
                    overridden
                  </span>
                )}
                {record.hh_deposit_id && (
                  <span className="text-xs px-2 py-0.5 rounded-full bg-green-100 text-green-700 font-medium" title={`HH #${record.hh_deposit_id}`}>
                    HH linked
                  </span>
                )}
              </>
            }
          />
        ))}
      </div>
    </div>
  );
}
