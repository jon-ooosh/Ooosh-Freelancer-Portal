import { Link } from 'react-router-dom';
import type { BacklineOverview, PrepEstimate } from './types';
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
  todayPrep?: PrepEstimate;
  tomorrowPrep?: PrepEstimate;
}

const OPS_STATUS_LABELS: Record<string, string> = {
  todo: 'To Do',
  arranging: 'Arranging',
  arranged: 'Arranged',
  dispatched: 'Dispatched',
  arrived: 'Arrived',
  completed: 'Completed',
};

export default function OperationsWidgets({ transportOps, backline, todayPrep, tomorrowPrep }: Props) {
  return (
    <div className="bg-white rounded-xl shadow-sm border border-gray-200">
      <div className="px-5 py-4 border-b border-gray-100">
        <h2 className="text-sm font-semibold text-gray-900 uppercase tracking-wide">Operations</h2>
      </div>

      {/* Row 1: Transport Ops + Backline summary */}
      <div className="grid grid-cols-1 md:grid-cols-2 divide-y md:divide-y-0 md:divide-x divide-gray-100">
        {/* Transport Ops */}
        <div className="p-5">
          <div className="flex items-center justify-between mb-1">
            <h3 className="text-xs font-semibold text-gray-700 uppercase tracking-wider">Transport Ops</h3>
            <Link to="/operations/transport" className="text-[11px] text-ooosh-600 hover:text-ooosh-700 font-medium">
              Open
            </Link>
          </div>
          <p className="text-[10px] text-gray-400 mb-2">Next 30 days</p>
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
                <Link
                  to="/operations/transport?needs_crew=1"
                  className="flex items-center justify-between text-xs pt-1 border-t border-gray-100 hover:bg-amber-50 -mx-1 px-1 rounded"
                  title="View quotes without crew assigned"
                >
                  <span className="text-amber-600">Needs crew</span>
                  <span className="font-medium text-amber-700">{transportOps.unassigned_count}</span>
                </Link>
              )}
            </div>
          )}
        </div>

        {/* Backline status */}
        <div className="p-5">
          <div className="flex items-center justify-between mb-1">
            <h3 className="text-xs font-semibold text-gray-700 uppercase tracking-wider">Backline Status</h3>
            <Link to="/operations/backline" className="text-[11px] text-ooosh-600 hover:text-ooosh-700 font-medium">
              Open
            </Link>
          </div>
          <p className="text-[10px] text-gray-400 mb-2">Next 7 days</p>
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
                  <div className="flex items-center gap-2">
                    <span className="text-purple-600 font-medium">{backline.returning.stats.totalItems} items</span>
                    {(backline.returning.stats.remainingDeprepMins || 0) > 0 ? (
                      <span className="text-blue-600 font-medium">{formatPrepTime(backline.returning.stats.remainingDeprepMins || 0)} de-prep</span>
                    ) : (
                      <span className="text-gray-400">de-prep TBD</span>
                    )}
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      {/* Row 2: Prep Workload — Today + Tomorrow with prep & de-prep per category */}
      <div className="border-t border-gray-100">
        <div className="px-5 py-3 border-b border-gray-50">
          <h3 className="text-xs font-semibold text-gray-700 uppercase tracking-wider">Prep & De-Prep Workload</h3>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 divide-y md:divide-y-0 md:divide-x divide-gray-100">
          <PrepColumn label="Today" prep={todayPrep} />
          <PrepColumn label="Tomorrow" prep={tomorrowPrep} />
        </div>
      </div>
    </div>
  );
}

/* ── Prep column: shows prep + de-prep per category ── */

const CATEGORIES = [
  { key: 'vehicle', label: 'Vehicles', color: 'text-blue-600', bg: 'bg-blue-500', dot: 'bg-blue-500' },
  { key: 'backline', label: 'Backline', color: 'text-purple-600', bg: 'bg-purple-500', dot: 'bg-purple-500' },
  { key: 'rehearsal', label: 'Rehearsals', color: 'text-teal-600', bg: 'bg-teal-500', dot: 'bg-teal-500' },
] as const;

function PrepColumn({ label, prep }: { label: string; prep?: PrepEstimate }) {
  const hasPrep = prep && prep.total_prep_mins > 0;
  const hasDeprep = prep && prep.total_deprep_mins > 0;

  if (!hasPrep && !hasDeprep) {
    return (
      <div className="p-5">
        <h4 className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-2">{label}</h4>
        <p className="text-sm text-gray-400">No prep or de-prep needed</p>
      </div>
    );
  }

  const prepItems = CATEGORIES.map(cat => ({
    ...cat,
    prepMins: prep?.[`${cat.key}_prep_mins` as keyof PrepEstimate] as number || 0,
    deprepMins: prep?.[`${cat.key}_deprep_mins` as keyof PrepEstimate] as number || 0,
    count: cat.key === 'vehicle' ? (prep?.vehicle_count || 0) : null,
    deprepCount: cat.key === 'vehicle' ? (prep?.deprep_vehicle_count || 0) : null,
  })).filter(c => c.prepMins > 0 || c.deprepMins > 0);

  const totalPrep = prep?.total_prep_mins || 0;
  const totalDeprep = prep?.total_deprep_mins || 0;

  return (
    <div className="p-5">
      <div className="flex items-center justify-between mb-3">
        <h4 className="text-xs font-semibold text-gray-500 uppercase tracking-wider">{label}</h4>
        <div className="flex items-center gap-3 text-xs">
          {totalPrep > 0 && (
            <span className="font-bold text-gray-900">{formatPrepTime(totalPrep)} prep</span>
          )}
          {totalDeprep > 0 && (
            <span className="font-bold text-gray-600">{formatPrepTime(totalDeprep)} de-prep</span>
          )}
        </div>
      </div>

      {/* Category table */}
      <table className="w-full text-xs">
        <thead>
          <tr className="text-gray-400">
            <th className="text-left font-medium pb-1.5" />
            {totalPrep > 0 && <th className="text-right font-medium pb-1.5 w-20">Prep</th>}
            {totalDeprep > 0 && <th className="text-right font-medium pb-1.5 w-20">De-prep</th>}
          </tr>
        </thead>
        <tbody>
          {prepItems.map(cat => (
            <tr key={cat.key}>
              <td className="py-1">
                <div className="flex items-center gap-2">
                  <div className={`w-1.5 h-1.5 rounded-full ${cat.dot}`} />
                  <span className="text-gray-600">
                    {cat.label}
                    {cat.count && cat.count > 0 ? ` (${cat.count})` : ''}
                  </span>
                </div>
              </td>
              {totalPrep > 0 && (
                <td className={`text-right py-1 font-medium ${cat.prepMins > 0 ? cat.color : 'text-gray-300'}`}>
                  {cat.prepMins > 0 ? formatPrepTime(cat.prepMins) : '-'}
                </td>
              )}
              {totalDeprep > 0 && (
                <td className={`text-right py-1 font-medium ${cat.deprepMins > 0 ? 'text-gray-600' : 'text-gray-300'}`}>
                  {cat.deprepMins > 0 ? formatPrepTime(cat.deprepMins) : '-'}
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table>

      {/* Job counts */}
      <div className="flex items-center gap-3 mt-2 pt-2 border-t border-gray-50">
        {(prep?.job_count || 0) > 0 && (
          <span className="text-[10px] text-gray-400">{prep!.job_count} job{prep!.job_count !== 1 ? 's' : ''} going out</span>
        )}
        {(prep?.deprep_job_count || 0) > 0 && (
          <span className="text-[10px] text-gray-400">{prep!.deprep_job_count} job{prep!.deprep_job_count !== 1 ? 's' : ''} returning</span>
        )}
      </div>
    </div>
  );
}
