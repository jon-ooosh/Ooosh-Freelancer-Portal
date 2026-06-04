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

interface BalanceRow {
  job_id: string; hh_job_number: number | null; job_name: string | null;
  client_name: string | null; pipeline_status: string | null;
  job_date: string | null; job_end: string | null; return_date: string | null;
  hire_value_inc_vat: string; total_hire_deposits: string; balance_outstanding: string;
  vat_saved: string; last_synced_at: string;
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
  deposits_pending: DepositPendingRow[];
  excess_held: ExcessHeldRow[];
  pending_refunds: PendingRefundRow[];
  totals: {
    balance_outstanding: number; balances_count: number;
    deposits_pending_count: number;
    excess_held: number; excess_held_count: number;
    excess_held_upcoming: number; excess_held_upcoming_count: number;
    excess_held_past: number; excess_held_past_count: number;
    pending_refunds: number; pending_refunds_count: number;
  };
}

const gbp = (n: number | string | null) =>
  '£' + (parseFloat(String(n ?? 0))).toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

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
  const [tab, setTab] = useState<'balances' | 'deposits' | 'excess' | 'refunds'>('balances');

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const res = await api.get<{ data: OverviewData }>('/money/overview');
      setData(res.data);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load overview');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  if (loading) return <div className="p-6 text-gray-500">Loading financial overview…</div>;
  if (error) return <div className="p-6 text-red-600">{error}</div>;
  if (!data) return null;

  const t = data.totals;
  const cards: { key: typeof tab; label: string; value: string; sub: string; subNode?: React.ReactNode; accent: string }[] = [
    { key: 'balances', label: 'Balances Outstanding', value: gbp(t.balance_outstanding), sub: `${t.balances_count} job${t.balances_count === 1 ? '' : 's'} owing`, accent: 'text-red-700' },
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
  const balanceRows: Row[] = data.balances_outstanding.map((r) => ({
    key: r.job_id, href: jobHref(r),
    search: `${r.hh_job_number ?? ''} ${r.client_name ?? ''} ${r.job_name ?? ''} ${r.pipeline_status ?? ''}`,
    sort: [r.hh_job_number ?? 0, r.client_name ?? '', r.pipeline_status ?? '', dateMs(r.job_end || r.return_date), parseFloat(r.hire_value_inc_vat), parseFloat(r.balance_outstanding)],
    cells: [
      <JobRef hh={r.hh_job_number} name={r.job_name} />,
      r.client_name || '—',
      <Pill text={r.pipeline_status || '—'} />,
      fmtDate(r.job_end || r.return_date),
      gbp(r.hire_value_inc_vat),
      <span className="font-semibold text-red-700">{gbp(r.balance_outstanding)}</span>,
    ],
  }));

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

  const excessRows: Row[] = data.excess_held.map((r) => ({
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
    ],
  }));

  return (
    <div className="p-4 sm:p-6 max-w-6xl mx-auto">
      <div className="flex items-center justify-between mb-4">
        <h1 className="text-2xl font-bold text-gray-900">Money Overview</h1>
        <button onClick={load} className="text-sm text-ooosh-600 hover:text-ooosh-700 underline">Refresh</button>
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
          <Table
            columns={[
              { label: 'Job', sortable: true }, { label: 'Client', sortable: true },
              { label: 'Status', sortable: true }, { label: 'Finishes', sortable: true },
              { label: 'Hire value', sortable: true, align: 'right' },
              { label: 'Outstanding', sortable: true, align: 'right' },
            ]}
            empty="No outstanding balances on synced jobs."
            rows={balanceRows}
          />
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
          <Table
            columns={[
              { label: 'Job', sortable: true }, { label: 'Client', sortable: true },
              { label: 'Status', sortable: true }, { label: 'Finished', sortable: true },
              { label: 'Held', sortable: true, align: 'right' },
            ]}
            empty="No excess currently held."
            rows={excessRows}
          />
        )}
        {tab === 'refunds' && (
          <Table
            columns={[
              { label: 'Job', sortable: true }, { label: 'Client', sortable: true },
              { label: 'Logged', sortable: true }, { label: 'Amount', sortable: true, align: 'right' },
              { label: 'Reason' },
            ]}
            empty="No pending refunds."
            rows={refundRows}
          />
        )}
      </div>
    </div>
  );
}
