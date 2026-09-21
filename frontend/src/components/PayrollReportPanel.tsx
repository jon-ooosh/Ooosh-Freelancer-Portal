/**
 * The payroll report, with a way to actually get it (spec §12.1, §17 item 10).
 *
 * The endpoint has existed since Phase C and NOTHING IN THE UI CALLED IT. The
 * only way to produce the figures payroll needs was to type the URL by hand,
 * which meant the answer to "how do I generate the spreadsheet?" was "you
 * cannot". Built Sep 2026 on the way to go-live.
 *
 * Preview first, download second, on purpose: these numbers go to an
 * accountant, and a figure you send without having looked at it is a figure you
 * find out about later.
 *
 * The CSV download stamps a batch (`recordBatch`) so there is a record of what
 * was generated and when. It never writes to the append-only ledger.
 */
import { useState } from 'react';
import { api } from '../services/api';

interface PayrollRow {
  personId: string;
  name: string;
  paidOvertimeMinutes: number;
  unpaidLeaveMinutes: number;
  unpaidLeaveDays: number;
  sicknessMinutes: number;
  sicknessDays: number;
  nominalDayMinutes: number | null;
}

function fmtH(mins: number): string {
  const sign = mins < 0 ? '-' : '';
  const m = Math.abs(mins);
  return `${sign}${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`;
}

/** Jan 1 to Dec 31 of the given year — the default period for a year-end run. */
function yearRange(year: number) {
  return { from: `${year}-01-01`, to: `${year}-12-31` };
}

export default function PayrollReportPanel() {
  const thisYear = new Date().getFullYear();
  const [{ from, to }, setRange] = useState(yearRange(thisYear));
  const [rows, setRows] = useState<PayrollRow[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function preview() {
    setBusy(true); setError(''); setRows(null);
    try {
      const res = await api.get<{ data: PayrollRow[] }>(
        `/staff-calendar/payroll?from=${from}&to=${to}`);
      setRows(res.data ?? []);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not build the report');
    } finally { setBusy(false); }
  }

  async function download() {
    setBusy(true); setError('');
    try {
      // Through api.blob, not a plain link: the route is behind the staff JWT
      // and a bare <a href> carries no Authorization header.
      const { blob } = await api.blob(`/staff-calendar/payroll?from=${from}&to=${to}&format=csv`);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `ooosh-payroll-${from}-to-${to}.csv`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not download the CSV');
    } finally { setBusy(false); }
  }

  const totalOvertime = rows?.reduce((n, r) => n + r.paidOvertimeMinutes, 0) ?? 0;

  return (
    <div className="mb-5 p-4 rounded-lg border border-gray-200 bg-white">
      <div className="flex flex-wrap items-baseline justify-between gap-2 mb-1">
        <h2 className="text-sm font-semibold text-gray-900">Payroll report</h2>
        <div className="flex gap-2 text-xs">
          <button onClick={() => setRange(yearRange(thisYear))} className="text-ooosh-600 hover:underline">
            This year
          </button>
          <button onClick={() => setRange(yearRange(thisYear - 1))} className="text-ooosh-600 hover:underline">
            Last year
          </button>
        </div>
      </div>
      <p className="text-xs text-gray-600 mb-3">
        What changed in a period, for the accountants: overtime to pay, unpaid leave and
        sickness days. Re-running the same dates always gives the same numbers.
        <strong> SSP is not calculated</strong> — the days are reported and payroll work out the pay.
      </p>

      <div className="flex flex-wrap items-end gap-3 mb-3">
        <label className="text-sm">
          <span className="block text-xs uppercase tracking-wide text-gray-400 mb-1">From</span>
          <input type="date" value={from} onChange={e => setRange(r => ({ ...r, from: e.target.value }))}
            className="px-2 py-1.5 rounded border border-gray-300" />
        </label>
        <label className="text-sm">
          <span className="block text-xs uppercase tracking-wide text-gray-400 mb-1">To</span>
          <input type="date" value={to} onChange={e => setRange(r => ({ ...r, to: e.target.value }))}
            className="px-2 py-1.5 rounded border border-gray-300" />
        </label>
        <button onClick={() => void preview()} disabled={busy}
          className="px-3 py-1.5 text-sm rounded border border-gray-300 hover:bg-gray-50 disabled:opacity-50">
          {busy ? 'Working…' : 'Show me'}
        </button>
        <button onClick={() => void download()} disabled={busy}
          className="px-3 py-1.5 text-sm rounded bg-ooosh-600 text-white hover:bg-ooosh-700 disabled:opacity-50">
          Download CSV
        </button>
      </div>

      {error && <p className="mb-2 text-sm text-red-700">{error}</p>}

      {rows && rows.length === 0 && (
        <p className="text-sm text-gray-500">Nothing to report for those dates.</p>
      )}

      {rows && rows.length > 0 && (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs uppercase tracking-wide text-gray-400 border-b border-gray-200">
                <th className="py-1.5 pr-3">Who</th>
                <th className="py-1.5 pr-3 text-right">Overtime to pay</th>
                <th className="py-1.5 pr-3 text-right">Unpaid leave</th>
                <th className="py-1.5 pr-3 text-right">Sickness</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(r => (
                <tr key={r.personId} className="border-b border-gray-100">
                  <td className="py-1.5 pr-3 text-gray-900">{r.name}</td>
                  <td className="py-1.5 pr-3 text-right tabular-nums">
                    {r.paidOvertimeMinutes === 0 ? '—' : fmtH(r.paidOvertimeMinutes)}
                    {r.paidOvertimeMinutes > 0 && r.nominalDayMinutes ? (
                      <span className="text-gray-400">
                        {' '}({(r.paidOvertimeMinutes / r.nominalDayMinutes).toFixed(2)} days)
                      </span>
                    ) : null}
                  </td>
                  <td className="py-1.5 pr-3 text-right tabular-nums">
                    {r.unpaidLeaveDays === 0 ? '—' : `${r.unpaidLeaveDays} days`}
                  </td>
                  <td className="py-1.5 pr-3 text-right tabular-nums">
                    {r.sicknessDays === 0 ? '—' : `${r.sicknessDays} days`}
                  </td>
                </tr>
              ))}
              {/* The single figure to send payroll — the whole point of a
                  year-end run, and otherwise something you would add up by
                  hand off a screen. */}
              <tr className="border-t-2 border-gray-300 font-medium">
                <td className="py-1.5 pr-3">Total overtime to pay</td>
                <td className="py-1.5 pr-3 text-right tabular-nums">{fmtH(totalOvertime)}</td>
                <td colSpan={2} />
              </tr>
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
