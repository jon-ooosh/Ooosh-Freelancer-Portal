/**
 * MoneyOverviewPage — global financial dashboard at /money/overview.
 *
 * Reads OP's cached `job_financials` (populated write-through from each job's
 * Money tab) + live excess + pending refunds via GET /api/money/overview.
 * No HireHop calls — instant. Figures are as fresh as the last Money-tab view
 * per job (shown via "synced" age), and self-heal as jobs are opened.
 */
import { useState, useEffect, useCallback } from 'react';
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
  amount_taken: string; amount_held: string; finished_on: string | null;
  hire_finished: boolean;
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

const syncedAge = (d: string) => {
  const ms = Date.now() - new Date(d).getTime();
  const mins = Math.round(ms / 60000);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 48) return `${hrs}h ago`;
  return `${Math.round(hrs / 24)}d ago`;
};

const jobHref = (r: { job_id: string }) => `/jobs/${r.job_id}`;

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
      // Split: legit-to-hold (upcoming/active) vs the actionable "should be back" backlog.
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

  return (
    <div className="p-4 sm:p-6 max-w-6xl mx-auto">
      <div className="flex items-center justify-between mb-4">
        <h1 className="text-2xl font-bold text-gray-900">Money Overview</h1>
        <button onClick={load} className="text-sm text-ooosh-600 hover:text-ooosh-700 underline">Refresh</button>
      </div>
      <p className="text-xs text-gray-500 mb-4">
        Cached per-job figures — each job refreshes when its Money tab is opened. Excess and pending refunds are live.
      </p>

      {/* Summary cards (click to switch the table below) */}
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

      <div className="bg-white rounded-xl shadow-sm border border-gray-200 overflow-x-auto">
        {tab === 'balances' && (
          <Table
            head={['Job', 'Client', 'Status', 'Finishes', 'Hire value', 'Deposits', 'Outstanding', 'Synced']}
            empty="No outstanding balances on synced jobs."
            rows={data.balances_outstanding.map((r) => ({
              key: r.job_id,
              href: jobHref(r),
              cells: [
                <JobRef hh={r.hh_job_number} name={r.job_name} />,
                r.client_name || '—',
                <Pill text={r.pipeline_status || '—'} />,
                fmtDate(r.job_end || r.return_date),
                gbp(r.hire_value_inc_vat),
                gbp(r.total_hire_deposits),
                <span className="font-semibold text-red-700">{gbp(r.balance_outstanding)}</span>,
                <span className="text-gray-400">{syncedAge(r.last_synced_at)}</span>,
              ],
            }))}
          />
        )}
        {tab === 'deposits' && (
          <Table
            head={['Job', 'Client', 'Status', 'Out date', 'Hire value', 'Synced']}
            empty="No confirmed jobs awaiting a deposit (on synced jobs)."
            rows={data.deposits_pending.map((r) => ({
              key: r.job_id,
              href: jobHref(r),
              cells: [
                <JobRef hh={r.hh_job_number} name={r.job_name} />,
                r.client_name || '—',
                <Pill text={r.pipeline_status || '—'} />,
                fmtDate(r.out_date || r.job_date),
                gbp(r.hire_value_inc_vat),
                <span className="text-gray-400">{syncedAge(r.last_synced_at)}</span>,
              ],
            }))}
          />
        )}
        {tab === 'excess' && (
          <Table
            head={['Job', 'Client', 'Status', 'Finished', 'Taken', 'Held']}
            empty="No excess currently held."
            rows={data.excess_held.map((r) => ({
              key: r.excess_id,
              href: jobHref(r),
              cells: [
                <JobRef hh={r.hh_job_number} name={null} />,
                r.client_name || '—',
                <Pill text={r.excess_status} />,
                <span>
                  {fmtDate(r.finished_on)}
                  {r.hire_finished && <span className="ml-1.5 text-[10px] px-1.5 py-0.5 rounded bg-amber-100 text-amber-800">to return</span>}
                </span>,
                gbp(r.amount_taken),
                parseFloat(r.amount_held) > 0 ? <span className="text-blue-700">{gbp(r.amount_held)}</span> : '—',
              ],
            }))}
          />
        )}
        {tab === 'refunds' && (
          <Table
            head={['Job', 'Client', 'Logged', 'Amount', 'Reason']}
            empty="No pending refunds."
            rows={data.pending_refunds.map((r) => ({
              key: String(r.id),
              href: jobHref(r),
              cells: [
                <JobRef hh={r.hh_job_number} name={null} />,
                r.client_name || '—',
                fmtDate(r.payment_date),
                <span className="font-semibold text-purple-700">{gbp(r.amount)}</span>,
                <span className="text-gray-500 text-xs">{r.notes || '—'}</span>,
              ],
            }))}
          />
        )}
      </div>
    </div>
  );
}

function JobRef({ hh, name }: { hh: number | null; name: string | null }) {
  return (
    <span>
      <span className="font-medium text-ooosh-700">#{hh ?? '—'}</span>
      {name && <span className="text-gray-500 text-xs block">{name}</span>}
    </span>
  );
}

function Pill({ text }: { text: string }) {
  return <span className="text-[11px] px-2 py-0.5 rounded bg-gray-100 text-gray-700 capitalize">{text.replace(/_/g, ' ')}</span>;
}

function Table({ head, rows, empty }: {
  head: string[];
  rows: { key: string; href: string; cells: React.ReactNode[] }[];
  empty: string;
}) {
  if (rows.length === 0) return <p className="p-6 text-sm text-gray-500">{empty}</p>;
  return (
    <table className="w-full text-sm">
      <thead>
        <tr className="border-b border-gray-100 text-left text-xs text-gray-500">
          {head.map((h) => <th key={h} className="px-4 py-2 font-medium whitespace-nowrap">{h}</th>)}
        </tr>
      </thead>
      <tbody className="divide-y divide-gray-50">
        {rows.map((r) => (
          <tr key={r.key} className="hover:bg-gray-50">
            {r.cells.map((c, i) => (
              <td key={i} className="px-4 py-2.5 align-top whitespace-nowrap">
                {i === 0 ? <Link to={r.href} className="hover:underline">{c}</Link> : c}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}
