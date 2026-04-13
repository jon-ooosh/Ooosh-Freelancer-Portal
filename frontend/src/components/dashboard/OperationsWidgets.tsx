import { Link } from 'react-router-dom';
import type { BacklineOverview } from './types';
import { formatPrepTime } from './helpers';

interface Props {
  transportOps: { summary: Record<string, number>; unassigned_count: number };
  fleet: {
    active_count: string;
    total_count: string;
    mot_due_soon: string;
    insurance_due_soon: string;
    tax_due_soon: string;
  };
  backline: BacklineOverview | null;
}

const OPS_STATUS_LABELS: Record<string, string> = {
  todo: 'To Do',
  arranging: 'Arranging',
  arranged: 'Arranged',
  dispatched: 'Dispatched',
  arrived: 'Arrived',
  completed: 'Completed',
};

export default function OperationsWidgets({ transportOps, fleet, backline }: Props) {
  const activeFleet = parseInt(fleet.active_count) || 0;
  const motDue = parseInt(fleet.mot_due_soon) || 0;
  const insuranceDue = parseInt(fleet.insurance_due_soon) || 0;
  const taxDue = parseInt(fleet.tax_due_soon) || 0;
  const fleetIssues = motDue + insuranceDue + taxDue;

  return (
    <div className="bg-white rounded-xl shadow-sm border border-gray-200">
      <div className="px-5 py-4 border-b border-gray-100">
        <h2 className="text-sm font-semibold text-gray-900 uppercase tracking-wide">Operations</h2>
      </div>
      <div className="grid grid-cols-1 md:grid-cols-2 divide-y md:divide-y-0 md:divide-x divide-gray-100">
        {/* Transport Ops */}
        <div className="p-5">
          <div className="flex items-center justify-between mb-3">
            <h3 className="text-xs font-semibold text-gray-700 uppercase tracking-wider">Transport Ops</h3>
            <Link to="/operations/transport" className="text-[11px] text-ooosh-600 hover:text-ooosh-700 font-medium">
              Open
            </Link>
          </div>
          {Object.keys(transportOps.summary).length === 0 ? (
            <p className="text-sm text-gray-400">No active transport jobs</p>
          ) : (
            <div className="space-y-1.5">
              {Object.entries(OPS_STATUS_LABELS).map(([key, label]) => {
                const count = transportOps.summary[key] || 0;
                if (count === 0) return null;
                return (
                  <div key={key} className="flex items-center justify-between text-xs">
                    <span className="text-gray-600">{label}</span>
                    <span className="font-medium text-gray-900">{count}</span>
                  </div>
                );
              })}
              {transportOps.unassigned_count > 0 && (
                <div className="flex items-center justify-between text-xs pt-1 border-t border-gray-100">
                  <span className="text-amber-600">Needs crew</span>
                  <span className="font-medium text-amber-700">{transportOps.unassigned_count}</span>
                </div>
              )}
            </div>
          )}
        </div>

        {/* Fleet Health */}
        <div className="p-5">
          <div className="flex items-center justify-between mb-3">
            <h3 className="text-xs font-semibold text-gray-700 uppercase tracking-wider">Fleet Health</h3>
            <Link to="/vehicles/fleet" className="text-[11px] text-ooosh-600 hover:text-ooosh-700 font-medium">
              Open
            </Link>
          </div>
          <div className="space-y-1.5">
            <div className="flex items-center justify-between text-xs">
              <span className="text-gray-600">Active vehicles</span>
              <span className="font-medium text-gray-900">{activeFleet}</span>
            </div>
            {fleetIssues > 0 ? (
              <>
                {motDue > 0 && (
                  <div className="flex items-center justify-between text-xs">
                    <span className="text-amber-600">MOT due within 30d</span>
                    <span className="font-medium text-amber-700">{motDue}</span>
                  </div>
                )}
                {insuranceDue > 0 && (
                  <div className="flex items-center justify-between text-xs">
                    <span className="text-amber-600">Insurance due within 30d</span>
                    <span className="font-medium text-amber-700">{insuranceDue}</span>
                  </div>
                )}
                {taxDue > 0 && (
                  <div className="flex items-center justify-between text-xs">
                    <span className="text-amber-600">Tax due within 30d</span>
                    <span className="font-medium text-amber-700">{taxDue}</span>
                  </div>
                )}
              </>
            ) : (
              <div className="text-xs text-green-600">All compliance up to date</div>
            )}
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 divide-y md:divide-y-0 md:divide-x divide-gray-100 border-t border-gray-100">
        {/* Backline & Prep */}
        <div className="p-5">
          <div className="flex items-center justify-between mb-3">
            <h3 className="text-xs font-semibold text-gray-700 uppercase tracking-wider">Backline & Prep</h3>
            <Link to="/operations/backline" className="text-[11px] text-ooosh-600 hover:text-ooosh-700 font-medium">
              Open
            </Link>
          </div>
          {!backline || (backline.goingOut.stats.jobCount === 0 && backline.returning.stats.jobCount === 0) ? (
            <p className="text-sm text-gray-400">No backline jobs this week</p>
          ) : (
            <div className="space-y-3">
              {backline.goingOut.stats.jobCount > 0 && (
                <div>
                  <div className="flex items-center justify-between text-xs mb-1">
                    <span className="text-gray-600">
                      <span className="font-semibold text-gray-900">{backline.goingOut.stats.jobCount}</span> going out
                    </span>
                    <div className="flex items-center gap-2">
                      <span className="text-purple-600 font-medium">{backline.goingOut.stats.totalItems} items</span>
                      <span className="text-blue-600 font-medium">{formatPrepTime(backline.goingOut.stats.remainingPrepMins || 0)} left</span>
                    </div>
                  </div>
                  <div className="h-1.5 bg-gray-100 rounded-full overflow-hidden flex">
                    {(backline.goingOut.stats.done || 0) > 0 && (
                      <div className="bg-green-500" style={{ width: `${((backline.goingOut.stats.done || 0) / backline.goingOut.stats.jobCount) * 100}%` }} />
                    )}
                    {(backline.goingOut.stats.inProgress || 0) > 0 && (
                      <div className="bg-amber-400" style={{ width: `${((backline.goingOut.stats.inProgress || 0) / backline.goingOut.stats.jobCount) * 100}%` }} />
                    )}
                  </div>
                </div>
              )}
              {backline.returning.stats.jobCount > 0 && (
                <div className="flex items-center justify-between text-xs">
                  <span className="text-gray-600">
                    <span className="font-semibold text-gray-900">{backline.returning.stats.jobCount}</span> coming back
                  </span>
                  <span className="text-blue-600 font-medium">{formatPrepTime(backline.returning.stats.remainingDeprepMins || 0)} de-prep</span>
                </div>
              )}
            </div>
          )}
        </div>

        {/* Incoming Deliveries — Placeholder */}
        <div className="p-5 opacity-60">
          <div className="flex items-center justify-between mb-3">
            <h3 className="text-xs font-semibold text-gray-700 uppercase tracking-wider">Incoming Deliveries</h3>
            <span className="text-[10px] bg-gray-100 text-gray-500 px-1.5 py-0.5 rounded">Coming Soon</span>
          </div>
          <p className="text-xs text-gray-400">
            Delivery tracking module coming soon — will show expected arrivals and received items across all jobs.
          </p>
        </div>
      </div>
    </div>
  );
}
