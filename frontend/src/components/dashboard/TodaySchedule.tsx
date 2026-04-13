import { Link } from 'react-router-dom';
import type { ScheduleJob, VehicleAssignment } from './types';
import { jobDisplayName } from './helpers';

interface Props {
  goingOut: ScheduleJob[];
  returning: ScheduleJob[];
  vehicleAssignments: VehicleAssignment[];
  tomorrowGoingOut: number;
  tomorrowReturning: number;
}

export default function TodaySchedule({ goingOut, returning, vehicleAssignments, tomorrowGoingOut, tomorrowReturning }: Props) {
  // Map vehicle assignments by job ID for quick lookup
  const assignmentsByJob = new Map<string, VehicleAssignment[]>();
  for (const a of vehicleAssignments) {
    const list = assignmentsByJob.get(a.job_uuid) || [];
    list.push(a);
    assignmentsByJob.set(a.job_uuid, list);
  }

  return (
    <div className="bg-white rounded-xl shadow-sm border border-gray-200">
      <div className="px-5 py-4 border-b border-gray-100">
        <h2 className="text-sm font-semibold text-gray-900 uppercase tracking-wide">Today's Schedule</h2>
      </div>
      <div className="grid grid-cols-1 md:grid-cols-2 divide-y md:divide-y-0 md:divide-x divide-gray-100">
        {/* Going Out */}
        <div className="p-5">
          <h3 className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-3 flex items-center gap-2">
            <span className="w-2 h-2 rounded-full bg-blue-500" />
            Going Out Today
          </h3>
          {goingOut.length === 0 ? (
            <p className="text-sm text-gray-400 py-4">Nothing going out today</p>
          ) : (
            <div className="space-y-3">
              {goingOut.map((job) => {
                const assignments = assignmentsByJob.get(job.id) || [];
                return (
                  <Link
                    key={job.id}
                    to={`/jobs/${job.id}`}
                    className="block -mx-2 px-3 py-2.5 rounded-lg hover:bg-gray-50 transition-colors border border-transparent hover:border-gray-200"
                  >
                    <div className="flex items-start justify-between">
                      <div className="min-w-0 flex-1">
                        <div className="text-sm font-medium text-gray-900 truncate">
                          {job.hh_job_number && (
                            <span className="font-mono text-gray-400 text-xs mr-1.5">#{job.hh_job_number}</span>
                          )}
                          {jobDisplayName(job)}
                        </div>
                        {job.venue_name && (
                          <div className="text-xs text-gray-500 mt-0.5">{job.venue_name}</div>
                        )}
                        {assignments.length > 0 && (
                          <div className="flex flex-wrap gap-1.5 mt-1.5">
                            {assignments.map((a) => (
                              <span key={a.id} className="inline-flex items-center gap-1 text-[11px] bg-blue-50 text-blue-700 px-1.5 py-0.5 rounded">
                                {a.reg && <span className="font-mono font-medium">{a.reg}</span>}
                                {a.driver_name && <span className="text-blue-500">- {a.driver_name}</span>}
                              </span>
                            ))}
                          </div>
                        )}
                      </div>
                      {job.out_date && (
                        <span className="text-xs text-blue-600 font-medium flex-shrink-0 ml-2">
                          {new Date(job.out_date).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}
                        </span>
                      )}
                    </div>
                  </Link>
                );
              })}
            </div>
          )}
        </div>

        {/* Returning */}
        <div className="p-5">
          <h3 className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-3 flex items-center gap-2">
            <span className="w-2 h-2 rounded-full bg-teal-500" />
            Returning Today
          </h3>
          {returning.length === 0 ? (
            <p className="text-sm text-gray-400 py-4">No returns expected today</p>
          ) : (
            <div className="space-y-3">
              {returning.map((job) => (
                <Link
                  key={job.id}
                  to={`/jobs/${job.id}`}
                  className="block -mx-2 px-3 py-2.5 rounded-lg hover:bg-gray-50 transition-colors border border-transparent hover:border-gray-200"
                >
                  <div className="flex items-start justify-between">
                    <div className="min-w-0 flex-1">
                      <div className="text-sm font-medium text-gray-900 truncate">
                        {job.hh_job_number && (
                          <span className="font-mono text-gray-400 text-xs mr-1.5">#{job.hh_job_number}</span>
                        )}
                        {jobDisplayName(job)}
                      </div>
                      <div className="text-xs text-gray-500 mt-0.5">
                        {job.client_name || job.company_name || '-'}
                      </div>
                    </div>
                    {job.return_date && (
                      <span className="text-xs text-teal-600 font-medium flex-shrink-0 ml-2">
                        Due {new Date(job.return_date).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}
                      </span>
                    )}
                  </div>
                </Link>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Tomorrow preview */}
      {(tomorrowGoingOut > 0 || tomorrowReturning > 0) && (
        <div className="px-5 py-3 bg-gray-50 rounded-b-xl border-t border-gray-100 flex items-center justify-between">
          <span className="text-xs text-gray-500">
            Tomorrow: {tomorrowGoingOut > 0 && `${tomorrowGoingOut} going out`}
            {tomorrowGoingOut > 0 && tomorrowReturning > 0 && ', '}
            {tomorrowReturning > 0 && `${tomorrowReturning} coming back`}
          </span>
          <Link to="/jobs" className="text-xs text-ooosh-600 hover:text-ooosh-700 font-medium">
            View full schedule
          </Link>
        </div>
      )}
    </div>
  );
}
