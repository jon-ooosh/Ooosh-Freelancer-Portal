import { Link } from 'react-router-dom';
import type { PipelineStat } from './types';
import { formatCurrency, PIPELINE_LABELS, PIPELINE_COLOURS } from './helpers';

interface Props {
  byStatus: PipelineStat[];
  activeValue: number;
}

export default function PipelineSnapshot({ byStatus, activeValue }: Props) {
  const maxCount = Math.max(...byStatus.map(s => parseInt(s.count)), 1);

  return (
    <div className="bg-white rounded-xl shadow-sm border border-gray-200">
      <div className="px-5 py-4 border-b border-gray-100">
        <h2 className="text-sm font-semibold text-gray-900 uppercase tracking-wide">Pipeline & Sales</h2>
      </div>
      <div className="grid grid-cols-1 md:grid-cols-2 divide-y md:divide-y-0 md:divide-x divide-gray-100">
        {/* Pipeline Snapshot */}
        <div className="p-5">
          <div className="flex items-center justify-between mb-3">
            <h3 className="text-xs font-semibold text-gray-700 uppercase tracking-wider">Pipeline Snapshot</h3>
            <Link to="/pipeline" className="text-[11px] text-ooosh-600 hover:text-ooosh-700 font-medium">
              Open Pipeline
            </Link>
          </div>
          {byStatus.length === 0 ? (
            <p className="text-sm text-gray-400">No active pipeline</p>
          ) : (
            <div className="space-y-2">
              {byStatus.map((stat) => {
                const count = parseInt(stat.count);
                const pct = (count / maxCount) * 100;
                const label = PIPELINE_LABELS[stat.pipeline_status] || stat.pipeline_status;
                const colour = PIPELINE_COLOURS[stat.pipeline_status] || 'bg-gray-400';
                return (
                  <div key={stat.pipeline_status}>
                    <div className="flex items-center justify-between text-xs mb-0.5">
                      <span className="text-gray-600">{label}</span>
                      <span className="font-medium text-gray-900">{count}</span>
                    </div>
                    <div className="h-2 bg-gray-100 rounded-full overflow-hidden">
                      <div className={`h-full rounded-full ${colour}`} style={{ width: `${Math.max(pct, 4)}%` }} />
                    </div>
                  </div>
                );
              })}
              <div className="pt-2 border-t border-gray-100">
                <div className="flex items-center justify-between text-xs">
                  <span className="text-gray-500">Active pipeline value</span>
                  <span className="font-semibold text-gray-900">{formatCurrency(activeValue)}</span>
                </div>
              </div>
            </div>
          )}
        </div>

        {/* Financial Overview — Placeholder */}
        <div className="p-5 opacity-60">
          <div className="flex items-center justify-between mb-3">
            <h3 className="text-xs font-semibold text-gray-700 uppercase tracking-wider">Financial Overview</h3>
            <span className="text-[10px] bg-gray-100 text-gray-500 px-1.5 py-0.5 rounded">Coming Soon</span>
          </div>
          <p className="text-xs text-gray-400 mb-2">
            Aggregate financial data requires per-job HireHop billing lookups — coming with Payment Portal repointing.
          </p>
          <ul className="space-y-1">
            {['Deposits pending', 'Balances outstanding', 'Excess held', 'Overdue invoices'].map((item) => (
              <li key={item} className="text-[11px] text-gray-400 flex items-center gap-1.5">
                <span className="w-1 h-1 bg-gray-300 rounded-full flex-shrink-0" />
                {item}
              </li>
            ))}
          </ul>
        </div>
      </div>
    </div>
  );
}
