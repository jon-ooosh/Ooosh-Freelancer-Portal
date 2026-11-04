/**
 * The forecast's table: one column per week (or day), one row per kind of
 * money. Click a figure to see what's behind it. Rows that are empty across
 * the whole forecast are left out so the table stays short.
 */
import type { Forecast, Period, RowKey } from '../../lib/cashflow';
import { gbp, shortDate } from '../../lib/cashflow';

export interface CellRef { period: number; row: RowKey | 'all' }

interface Props {
  forecast: Forecast;
  periods: Period[];
  byDay: boolean;
  target: number;
  limit: number;   // negative
  selected: CellRef | null;
  onSelect: (cell: CellRef) => void;
}

export default function ForecastTable({ forecast, periods, byDay, target, limit, selected, onSelect }: Props) {
  const used = forecast.rows.filter((r) => periods.some((p) => Math.abs(p.byRow[r.key] || 0) >= 0.005));
  const ins = used.filter((r) => r.direction === 'in');
  const outs = used.filter((r) => r.direction === 'out');
  const showInterest = periods.some((p) => p.interestMemo > 0);
  const lowIdx = periods.reduce((lo, p, i) => (p.closing < periods[lo].closing ? i : lo), 0);

  const cell = (period: number, row: RowKey, clientMoney?: boolean) => {
    const v = periods[period].byRow[row] || 0;
    const isSel = selected?.period === period && selected.row === row;
    if (Math.abs(v) < 0.005) return <td key={period} className="px-2 py-1.5 text-right text-gray-300">–</td>;
    return (
      <td key={period} className="px-1 py-0.5 text-right">
        <button type="button" onClick={() => onSelect({ period, row })}
          className={`w-full text-right px-1.5 py-1 rounded tabular-nums hover:bg-ooosh-50 ${isSel ? 'ring-2 ring-ooosh-500 bg-ooosh-50' : ''} ${clientMoney ? 'text-violet-700' : 'text-gray-800'}`}>
          {gbp(v)}
        </button>
      </td>
    );
  };

  const closingClass = (v: number) => (v < limit ? 'bg-red-50 text-red-700' : v < target ? 'bg-amber-50 text-amber-800' : '');

  return (
    <div className="overflow-x-auto">
      <table className="min-w-full text-xs">
        <thead>
          <tr className="border-b border-gray-200">
            <th className="sticky left-0 bg-white text-left font-semibold text-gray-500 px-2 py-2 min-w-[11rem]">{byDay ? 'Day' : 'Week of'}</th>
            {periods.map((p, i) => (
              <th key={p.start} className={`px-2 py-2 text-right font-semibold whitespace-nowrap ${i === lowIdx ? 'text-amber-700' : 'text-gray-500'}`}>
                {shortDate(p.start, byDay)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          <tr>
            <td className="sticky left-0 bg-white px-2 py-1.5 text-gray-600">Opening</td>
            {periods.map((p) => <td key={p.start} className="px-2 py-1.5 text-right tabular-nums text-gray-600">{gbp(p.opening)}</td>)}
          </tr>
          {ins.length > 0 && (
            <tr><td colSpan={periods.length + 1} className="sticky left-0 bg-white px-2 pt-3 pb-1 text-[10px] font-bold uppercase tracking-wider text-gray-400">Money in</td></tr>
          )}
          {ins.map((r) => (
            <tr key={r.key}>
              <td className="sticky left-0 bg-white px-2 py-1 text-gray-700 whitespace-nowrap">{r.label}</td>
              {periods.map((_, i) => cell(i, r.key, r.clientMoney))}
            </tr>
          ))}
          {outs.length > 0 && (
            <tr><td colSpan={periods.length + 1} className="sticky left-0 bg-white px-2 pt-3 pb-1 text-[10px] font-bold uppercase tracking-wider text-gray-400">Money out</td></tr>
          )}
          {outs.map((r) => (
            <tr key={r.key}>
              <td className="sticky left-0 bg-white px-2 py-1 text-gray-700 whitespace-nowrap">{r.label}</td>
              {periods.map((_, i) => cell(i, r.key, r.clientMoney))}
            </tr>
          ))}
          <tr className="border-t border-gray-200 font-semibold">
            <td className="sticky left-0 bg-white px-2 py-2 text-gray-900">Closing</td>
            {periods.map((p, i) => (
              <td key={p.start} className="px-1 py-1 text-right">
                <button type="button" onClick={() => onSelect({ period: i, row: 'all' })}
                  className={`w-full text-right px-1.5 py-1 rounded tabular-nums ${closingClass(p.closing)} ${selected?.period === i && selected.row === 'all' ? 'ring-2 ring-ooosh-500' : ''}`}>
                  {gbp(p.closing)}
                </button>
              </td>
            ))}
          </tr>
          {showInterest && (
            <tr className="text-gray-400 italic">
              <td className="sticky left-0 bg-white px-2 py-1.5 whitespace-nowrap" title="Interest is added to the card, not paid from the bank — so it isn't in the totals. It shows in the card's balance below.">
                Card interest (added to the card)
              </td>
              {periods.map((p) => (
                <td key={p.start} className="px-2 py-1.5 text-right tabular-nums">{p.interestMemo > 0 ? gbp(p.interestMemo) : ''}</td>
              ))}
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}
