import { Link } from 'react-router-dom';
import type { ScheduleJob, ChaseJob, PendingReferral, PendingExcess } from './types';
import { jobDisplayName, daysAgo, formatCurrency } from './helpers';

interface Props {
  overdueReturns: ScheduleJob[];
  overdueTotalCount?: number;
  chasesDue: ChaseJob[];
  referralCount: number;
  referrals: PendingReferral[];
  excessCount: number;
  excessTotal?: number;
  excessItems: PendingExcess[];
  fleetAlerts?: { mot: number; insurance: number; tax: number };
}

export default function NeedsAttention({
  overdueReturns, overdueTotalCount, chasesDue, referralCount, referrals,
  excessCount, excessItems, fleetAlerts,
}: Props) {
  const totalFleetAlerts = (fleetAlerts?.mot || 0) + (fleetAlerts?.insurance || 0) + (fleetAlerts?.tax || 0);
  const overdueCount = overdueTotalCount ?? overdueReturns.length;
  const hasAnything = overdueCount > 0 || chasesDue.length > 0 || referralCount > 0 || excessCount > 0 || totalFleetAlerts > 0;

  if (!hasAnything) return null;

  return (
    <div className="bg-white rounded-xl shadow-sm border border-gray-200">
      <div className="px-5 py-4 border-b border-gray-100">
        <h2 className="text-sm font-semibold text-gray-900 uppercase tracking-wide">Needs Attention</h2>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-0 divide-y sm:divide-y-0 sm:divide-x divide-gray-100">
        {/* Overdue Returns */}
        {overdueCount > 0 && (
          <div className="p-4">
            <div className="flex items-center gap-2 mb-3">
              <span className="w-2 h-2 rounded-full bg-red-500" />
              <h3 className="text-xs font-semibold text-red-700 uppercase">Overdue Returns</h3>
              <span className="ml-auto text-xs bg-red-100 text-red-700 px-1.5 py-0.5 rounded-full font-medium">
                {overdueCount}
              </span>
            </div>
            <div className="space-y-2">
              {overdueReturns.slice(0, 3).map((job) => (
                <Link key={job.id} to={`/jobs/${job.id}`} className="block text-sm hover:bg-red-50 -mx-1 px-1 py-1 rounded transition-colors">
                  <div className="font-medium text-gray-900 truncate text-xs">
                    {job.hh_job_number && <span className="font-mono text-gray-400 mr-1">#{job.hh_job_number}</span>}
                    {jobDisplayName(job)}
                  </div>
                  <div className="text-[11px] text-red-600">
                    {job.return_date ? `${daysAgo(job.return_date)}d overdue` : 'Overdue'}
                  </div>
                </Link>
              ))}
            </div>
            {overdueCount > 3 && (
              <Link to="/jobs/returns" className="text-[11px] text-red-600 hover:text-red-700 font-medium mt-2 block">
                View all {overdueCount}
              </Link>
            )}
          </div>
        )}

        {/* Pending Referrals */}
        {referralCount > 0 && (
          <div className="p-4">
            <div className="flex items-center gap-2 mb-3">
              <span className="w-2 h-2 rounded-full bg-orange-500" />
              <h3 className="text-xs font-semibold text-orange-700 uppercase">Referrals</h3>
              <span className="ml-auto text-xs bg-orange-100 text-orange-700 px-1.5 py-0.5 rounded-full font-medium">
                {referralCount}
              </span>
            </div>
            <div className="space-y-2">
              {referrals.slice(0, 3).map((r) => (
                <Link key={r.id} to={`/vehicles/drivers/${r.id}`} className="block hover:bg-orange-50 -mx-1 px-1 py-1 rounded transition-colors">
                  <div className="text-xs font-medium text-gray-900 truncate">
                    {r.full_name}
                    {r.licence_points != null && r.licence_points > 0 && (
                      <span className={`ml-1.5 text-[10px] px-1 py-0.5 rounded-full ${
                        r.licence_points >= 10 ? 'bg-red-100 text-red-700' :
                        r.licence_points >= 7 ? 'bg-orange-100 text-orange-700' :
                        'bg-amber-100 text-amber-700'
                      }`}>
                        {r.licence_points}pts
                      </span>
                    )}
                  </div>
                  <div className="text-[11px] text-orange-600">{r.referral_status || 'Pending'}</div>
                </Link>
              ))}
            </div>
            {referralCount > 3 && (
              <Link to="/vehicles/drivers" className="text-[11px] text-orange-600 hover:text-orange-700 font-medium mt-2 block">
                View all {referralCount}
              </Link>
            )}
          </div>
        )}

        {/* Excess to Collect */}
        {excessCount > 0 && (
          <div className="p-4">
            <div className="flex items-center gap-2 mb-3">
              <span className="w-2 h-2 rounded-full bg-amber-500" />
              <h3 className="text-xs font-semibold text-amber-700 uppercase">Excess</h3>
              <span className="ml-auto text-xs bg-amber-100 text-amber-700 px-1.5 py-0.5 rounded-full font-medium">
                {excessCount}
              </span>
            </div>
            <div className="space-y-2">
              {excessItems.slice(0, 3).map((e) => (
                <Link key={e.excess_id} to={e.job_uuid ? `/jobs/${e.job_uuid}` : '/money/excess'} className="block hover:bg-amber-50 -mx-1 px-1 py-1 rounded transition-colors">
                  <div className="text-xs font-medium text-gray-900 truncate">
                    {e.driver_name || 'Unknown'} {e.vehicle_reg && <span className="text-gray-400">- {e.vehicle_reg}</span>}
                  </div>
                  <div className="text-[11px] text-amber-600">
                    {e.excess_amount_required ? formatCurrency(e.excess_amount_required) : 'TBD'}
                  </div>
                </Link>
              ))}
            </div>
            {excessCount > 3 && (
              <Link to="/money/excess" className="text-[11px] text-amber-600 hover:text-amber-700 font-medium mt-2 block">
                View all {excessCount}
              </Link>
            )}
          </div>
        )}

        {/* Chases Due */}
        {chasesDue.length > 0 && (
          <div className="p-4">
            <div className="flex items-center gap-2 mb-3">
              <span className="w-2 h-2 rounded-full bg-blue-500" />
              <h3 className="text-xs font-semibold text-blue-700 uppercase">Chases Due</h3>
              <span className="ml-auto text-xs bg-blue-100 text-blue-700 px-1.5 py-0.5 rounded-full font-medium">
                {chasesDue.length}
              </span>
            </div>
            <div className="space-y-2">
              {chasesDue.slice(0, 3).map((job) => (
                <Link key={job.id} to={`/jobs/${job.id}`} className="block hover:bg-blue-50 -mx-1 px-1 py-1 rounded transition-colors">
                  <div className="text-xs font-medium text-gray-900 truncate">
                    {jobDisplayName(job)}
                  </div>
                  <div className="text-[11px] text-blue-600">
                    {daysAgo(job.next_chase_date)}d ago
                    {job.job_value ? ` - ${formatCurrency(job.job_value)}` : ''}
                  </div>
                </Link>
              ))}
            </div>
            {chasesDue.length > 3 && (
              <Link to="/pipeline" className="text-[11px] text-blue-600 hover:text-blue-700 font-medium mt-2 block">
                View pipeline
              </Link>
            )}
          </div>
        )}

        {/* Fleet Compliance */}
        {totalFleetAlerts > 0 && fleetAlerts && (
          <div className="p-4">
            <div className="flex items-center gap-2 mb-3">
              <span className="w-2 h-2 rounded-full bg-purple-500" />
              <h3 className="text-xs font-semibold text-purple-700 uppercase">Fleet Compliance</h3>
              <span className="ml-auto text-xs bg-purple-100 text-purple-700 px-1.5 py-0.5 rounded-full font-medium">
                {totalFleetAlerts}
              </span>
            </div>
            <div className="space-y-1.5">
              {fleetAlerts.mot > 0 && (
                <div className="text-xs text-amber-600">{fleetAlerts.mot} MOT{fleetAlerts.mot !== 1 ? 's' : ''} due within 30d</div>
              )}
              {fleetAlerts.insurance > 0 && (
                <div className="text-xs text-amber-600">{fleetAlerts.insurance} insurance renewal{fleetAlerts.insurance !== 1 ? 's' : ''} due</div>
              )}
              {fleetAlerts.tax > 0 && (
                <div className="text-xs text-amber-600">{fleetAlerts.tax} tax disc{fleetAlerts.tax !== 1 ? 's' : ''} due</div>
              )}
            </div>
            <Link to="/vehicles/fleet" className="text-[11px] text-purple-600 hover:text-purple-700 font-medium mt-2 block">
              View fleet
            </Link>
          </div>
        )}
      </div>
    </div>
  );
}
