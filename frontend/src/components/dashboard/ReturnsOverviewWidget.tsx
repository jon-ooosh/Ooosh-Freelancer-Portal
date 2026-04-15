import { Link } from 'react-router-dom';
import type { ReturnsOverview } from './types';

interface Props {
  data: ReturnsOverview;
}

const TYPE_LABELS: Record<string, { label: string; icon: string; colour: string }> = {
  invoice:              { label: 'Invoicing',      icon: '\uD83E\uDDFE', colour: 'text-blue-700 bg-blue-50' },
  payment_reconcile:    { label: 'Payment',        icon: '\uD83D\uDCB7', colour: 'text-green-700 bg-green-50' },
  excess_resolve:       { label: 'Excess',         icon: '\uD83D\uDEE1\uFE0F', colour: 'text-purple-700 bg-purple-50' },
  damage_review:        { label: 'Damage',         icon: '\u26A0\uFE0F', colour: 'text-red-700 bg-red-50' },
  freelancer_followup:  { label: 'Freelancer',     icon: '\uD83D\uDC64', colour: 'text-indigo-700 bg-indigo-50' },
  client_followup:      { label: 'Client',         icon: '\uD83D\uDCDE', colour: 'text-teal-700 bg-teal-50' },
  vehicle:              { label: 'Vehicle Check',  icon: '\uD83D\uDE90', colour: 'text-blue-700 bg-blue-50' },
  backline:             { label: 'De-prep',        icon: '\uD83C\uDFB8', colour: 'text-purple-700 bg-purple-50' },
};

export default function ReturnsOverviewWidget({ data }: Props) {
  const { counts, outstanding, oldest_returns, excess_pending } = data;

  const totalActive = counts.active_returns;
  const hasWork = totalActive > 0 || counts.overdue > 0;

  if (!hasWork) {
    return (
      <div className="bg-white rounded-xl shadow-sm border border-gray-200">
        <div className="px-5 py-4 border-b border-gray-100 flex items-center justify-between">
          <h2 className="text-sm font-semibold text-gray-900 uppercase tracking-wide">Returns</h2>
          <Link to="/jobs/returns" className="text-[11px] text-ooosh-600 hover:text-ooosh-700 font-medium">
            Open
          </Link>
        </div>
        <div className="p-5">
          <p className="text-sm text-gray-400">No active returns</p>
        </div>
      </div>
    );
  }

  return (
    <div className="bg-white rounded-xl shadow-sm border border-gray-200">
      <div className="px-5 py-4 border-b border-gray-100 flex items-center justify-between">
        <h2 className="text-sm font-semibold text-gray-900 uppercase tracking-wide">Returns & Close-Out</h2>
        <Link to="/jobs/returns" className="text-[11px] text-ooosh-600 hover:text-ooosh-700 font-medium">
          View all
        </Link>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 divide-y md:divide-y-0 md:divide-x divide-gray-100">
        {/* Left: Status counts + outstanding items */}
        <div className="p-5 space-y-4">
          {/* Status breakdown */}
          <div>
            <h3 className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-2">Active Returns</h3>
            <div className="flex items-center gap-3 flex-wrap">
              <div className="flex items-center gap-1.5">
                <div className="w-2 h-2 rounded-full bg-amber-400" />
                <span className="text-xs text-gray-600">{counts.checking_in} checking in</span>
              </div>
              <div className="flex items-center gap-1.5">
                <div className="w-2 h-2 rounded-full bg-teal-400" />
                <span className="text-xs text-gray-600">{counts.returned} returned</span>
              </div>
              {counts.requires_attention > 0 && (
                <div className="flex items-center gap-1.5">
                  <div className="w-2 h-2 rounded-full bg-red-500" />
                  <span className="text-xs text-red-600 font-medium">{counts.requires_attention} needs attention</span>
                </div>
              )}
              {counts.overdue > 0 && (
                <div className="flex items-center gap-1.5">
                  <div className="w-2 h-2 rounded-full bg-red-500 animate-pulse" />
                  <span className="text-xs text-red-600 font-medium">{counts.overdue} overdue</span>
                </div>
              )}
            </div>
          </div>

          {/* Outstanding close-out items */}
          {outstanding.length > 0 && (
            <div>
              <h3 className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-2">Outstanding Items</h3>
              <div className="space-y-1.5">
                {outstanding.map(item => {
                  const meta = TYPE_LABELS[item.type];
                  if (!meta) return null;
                  return (
                    <div key={item.type} className="flex items-center justify-between text-xs">
                      <div className="flex items-center gap-2">
                        <span className="text-sm">{meta.icon}</span>
                        <span className="text-gray-600">{meta.label}</span>
                      </div>
                      <span className={`px-1.5 py-0.5 rounded text-[10px] font-medium ${meta.colour}`}>
                        {item.outstanding} of {item.total}
                      </span>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* Excess pending */}
          {excess_pending.count > 0 && (
            <div className="pt-2 border-t border-gray-100">
              <div className="flex items-center justify-between text-xs">
                <span className="text-gray-500">Excess pending resolution</span>
                <span className="font-medium text-purple-700">
                  {excess_pending.count} ({'\u00A3'}{excess_pending.total_amount.toLocaleString('en-GB', { maximumFractionDigits: 0 })})
                </span>
              </div>
            </div>
          )}
        </div>

        {/* Right: Oldest returns */}
        <div className="p-5">
          <h3 className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-2">Longest Outstanding</h3>
          {oldest_returns.length === 0 ? (
            <p className="text-xs text-gray-400">No outstanding returns</p>
          ) : (
            <div className="space-y-2">
              {oldest_returns.map(job => (
                <Link
                  key={job.id}
                  to={`/jobs/${job.id}`}
                  className="flex items-center justify-between group hover:bg-gray-50 -mx-2 px-2 py-1 rounded transition-colors"
                >
                  <div className="min-w-0">
                    <div className="text-xs font-medium text-gray-900 group-hover:text-ooosh-600 truncate">
                      {job.hh_job_number ? `J-${job.hh_job_number}` : ''}{' '}
                      {job.job_name || job.client_name || 'Untitled'}
                    </div>
                    {job.client_name && job.job_name && (
                      <div className="text-[10px] text-gray-400 truncate">{job.client_name}</div>
                    )}
                  </div>
                  <span className={`text-[10px] font-medium whitespace-nowrap ml-2 px-1.5 py-0.5 rounded ${
                    job.days_since_return > 14 ? 'bg-red-100 text-red-700' :
                    job.days_since_return > 7 ? 'bg-amber-100 text-amber-700' :
                    'bg-gray-100 text-gray-600'
                  }`}>
                    {job.days_since_return}d ago
                  </span>
                </Link>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
