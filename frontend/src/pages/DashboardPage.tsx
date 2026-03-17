import { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../services/api';
import { useAuthStore } from '../hooks/useAuthStore';

interface JobSummary {
  id: string;
  hh_job_number: number;
  job_name: string | null;
  status: number;
  client_name: string | null;
  company_name: string | null;
  venue_name: string | null;
  job_date: string | null;
  job_end: string | null;
  out_date: string | null;
  return_date: string | null;
  created_date: string | null;
}

interface DashboardData {
  counts: {
    people_count: string;
    org_count: string;
    venue_count: string;
    interaction_count: string;
    user_count: string;
    active_job_count: string;
  };
  recent_activity: Array<{
    id: string;
    type: string;
    content: string;
    created_at: string;
    created_by_name: string;
    entity_name: string;
    entity_type: string;
    person_id: string | null;
    organisation_id: string | null;
    venue_id: string | null;
  }>;
  activity_by_type: Array<{ type: string; count: string }>;
  recent_people: Array<{ id: string; first_name: string; last_name: string; email: string; created_at: string }>;
  recent_orgs: Array<{ id: string; name: string; type: string; created_at: string }>;
  this_week_activity: { this_week: string; last_week: string };
  team_activity: Array<{ name: string; user_id: string; interaction_count: string; last_active: string | null }>;
  unread_notifications: number;
  job_status_breakdown: Array<{ status: number; count: string }>;
  upcoming_jobs: JobSummary[];
  overdue_returns: JobSummary[];
  recent_enquiries: JobSummary[];
  pending_referrals: Array<{
    id: string;
    full_name: string;
    email: string;
    referral_status: string;
    referral_date: string | null;
    licence_points: number | null;
    updated_at: string;
    hirehop_job_id: number | null;
    hirehop_job_name: string | null;
    job_name: string | null;
    job_uuid: string | null;
  }>;
  pending_excess: Array<{
    excess_id: string;
    excess_status: string;
    excess_amount_required: number | null;
    assignment_id: string;
    hirehop_job_id: number | null;
    hirehop_job_name: string | null;
    hire_start: string | null;
    driver_name: string | null;
    driver_email: string | null;
    vehicle_reg: string | null;
    job_name: string | null;
    job_uuid: string | null;
  }>;
}

const TYPE_COLORS: Record<string, string> = {
  note: 'bg-blue-100 text-blue-700',
  call: 'bg-green-100 text-green-700',
  email: 'bg-purple-100 text-purple-700',
  meeting: 'bg-amber-100 text-amber-700',
};

const JOB_STATUS_MAP: Record<number, string> = {
  0: 'Enquiry', 1: 'Provisional', 2: 'Booked', 3: 'Prepped',
  4: 'Part Dispatched', 5: 'Dispatched', 6: 'Returned Incomplete',
  7: 'Returned', 8: 'Requires Attention',
};

const JOB_STATUS_COLOURS: Record<number, string> = {
  0: 'bg-blue-100 text-blue-700',
  1: 'bg-amber-100 text-amber-700',
  2: 'bg-green-100 text-green-700',
  3: 'bg-purple-100 text-purple-700',
  4: 'bg-orange-100 text-orange-700',
  5: 'bg-indigo-100 text-indigo-700',
  6: 'bg-yellow-100 text-yellow-800',
  7: 'bg-teal-100 text-teal-700',
  8: 'bg-red-100 text-red-700',
};

const TYPE_ICONS: Record<string, string> = {
  note: 'N', call: 'C', email: 'E', meeting: 'M',
};

function formatTimeAgo(dateStr: string) {
  const diff = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days === 1) return 'yesterday';
  return `${days}d ago`;
}

function formatDate(dateStr: string) {
  return new Date(dateStr).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
}

export default function DashboardPage() {
  const user = useAuthStore((s) => s.user);
  const [data, setData] = useState<DashboardData | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api.get<DashboardData>('/dashboard')
      .then(setData)
      .catch(console.error)
      .finally(() => setLoading(false));
  }, []);

  if (loading) return <div className="text-center py-12 text-gray-500">Loading Command Centre...</div>;
  if (!data) return <div className="text-center py-12 text-gray-500">Failed to load dashboard.</div>;

  const thisWeek = parseInt(data.this_week_activity.this_week);
  const lastWeek = parseInt(data.this_week_activity.last_week);
  const weekTrend = lastWeek > 0 ? Math.round(((thisWeek - lastWeek) / lastWeek) * 100) : 0;

  const entityLink = (item: { entity_type: string; person_id: string | null; organisation_id: string | null; venue_id: string | null }) => {
    const id = item.person_id || item.organisation_id || item.venue_id;
    return id ? `/${item.entity_type}/${id}` : '#';
  };

  return (
    <div>
      {/* Header */}
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-gray-900">Command Centre</h1>
        <p className="mt-1 text-sm text-gray-500">
          Welcome back, {user?.first_name}. Here's what's happening.
        </p>
      </div>

      {/* Stats bar */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-4 mb-6">
        <StatCard label="Active Jobs" value={data.counts.active_job_count} href="/jobs" color="bg-green-500" />
        <StatCard label="People" value={data.counts.people_count} href="/people" color="bg-blue-500" />
        <StatCard label="Organisations" value={data.counts.org_count} href="/organisations" color="bg-purple-500" />
        <StatCard label="Venues" value={data.counts.venue_count} href="/venues" color="bg-teal-500" />
        <StatCard
          label="This Week"
          value={String(thisWeek)}
          subtitle={weekTrend !== 0 ? `${weekTrend > 0 ? '+' : ''}${weekTrend}% vs last week` : 'Same as last week'}
          color="bg-ooosh-500"
        />
        <StatCard label="Team Members" value={data.counts.user_count} color="bg-amber-500" />
      </div>

      {/* Main grid — two columns */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">

        {/* Left column — Activity Feed (takes 2 cols) */}
        <div className="lg:col-span-2 space-y-6">

          {/* Activity by type — mini bar chart */}
          {data.activity_by_type.length > 0 && (
            <div className="bg-white rounded-xl shadow-sm border border-gray-200 p-5">
              <h2 className="text-sm font-semibold text-gray-700 mb-3">Activity — Last 30 Days</h2>
              <div className="flex gap-4 items-end h-20">
                {data.activity_by_type.map((item) => {
                  const max = Math.max(...data.activity_by_type.map(a => parseInt(a.count)));
                  const pct = max > 0 ? (parseInt(item.count) / max) * 100 : 0;
                  return (
                    <div key={item.type} className="flex-1 flex flex-col items-center gap-1">
                      <span className="text-xs font-semibold text-gray-700">{item.count}</span>
                      <div
                        className={`w-full rounded-t ${TYPE_COLORS[item.type]?.split(' ')[0] || 'bg-gray-200'}`}
                        style={{ height: `${Math.max(pct, 8)}%` }}
                      />
                      <span className="text-xs text-gray-500 capitalize">{item.type}s</span>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* Recent Activity Feed */}
          <div className="bg-white rounded-xl shadow-sm border border-gray-200">
            <div className="px-5 py-4 border-b border-gray-100">
              <h2 className="text-sm font-semibold text-gray-700">Recent Activity</h2>
            </div>
            <div className="divide-y divide-gray-50">
              {data.recent_activity.map((item) => (
                <Link
                  key={item.id}
                  to={entityLink(item)}
                  className="flex items-start gap-3 px-5 py-3 hover:bg-gray-50 transition-colors"
                >
                  <div className={`w-7 h-7 rounded-full flex items-center justify-center text-xs font-bold flex-shrink-0 mt-0.5 ${TYPE_COLORS[item.type] || 'bg-gray-100 text-gray-600'}`}>
                    {TYPE_ICONS[item.type] || '?'}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 text-xs text-gray-500">
                      <span className="font-medium text-gray-700">{item.created_by_name}</span>
                      <span>logged a {item.type}</span>
                      {item.entity_name && (
                        <>
                          <span>on</span>
                          <span className="font-medium text-ooosh-600">{item.entity_name}</span>
                        </>
                      )}
                    </div>
                    <p className="text-sm text-gray-700 mt-0.5 truncate">{item.content}</p>
                  </div>
                  <span className="text-xs text-gray-400 flex-shrink-0 mt-0.5">{formatTimeAgo(item.created_at)}</span>
                </Link>
              ))}
              {data.recent_activity.length === 0 && (
                <p className="px-5 py-8 text-center text-sm text-gray-400">No activity yet.</p>
              )}
            </div>
          </div>

          {/* Job Status Breakdown */}
          {data.job_status_breakdown.length > 0 && (
            <div className="bg-white rounded-xl shadow-sm border border-gray-200 p-5">
              <div className="flex items-center justify-between mb-3">
                <h2 className="text-sm font-semibold text-gray-700">Job Pipeline</h2>
                <Link to="/jobs" className="text-xs text-ooosh-600 hover:text-ooosh-700">View all jobs &rarr;</Link>
              </div>
              <div className="flex gap-2 flex-wrap">
                {data.job_status_breakdown.map((item) => (
                  <Link
                    key={item.status}
                    to={`/jobs?status=${item.status}`}
                    className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-medium transition-opacity hover:opacity-80 ${JOB_STATUS_COLOURS[item.status] || 'bg-gray-100 text-gray-600'}`}
                  >
                    <span className="font-bold">{item.count}</span>
                    <span className="text-xs">{JOB_STATUS_MAP[item.status] || `Status ${item.status}`}</span>
                  </Link>
                ))}
              </div>
            </div>
          )}

          {/* Live Job Panels */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {/* Overdue Returns */}
            <div className="bg-white rounded-xl shadow-sm border border-gray-200 p-5">
              <div className="flex items-center justify-between mb-3">
                <h3 className="text-sm font-semibold text-gray-700">Overdue Returns</h3>
                {data.overdue_returns.length > 0 && (
                  <span className="text-xs bg-red-100 text-red-700 px-2 py-0.5 rounded-full font-medium">
                    {data.overdue_returns.length}
                  </span>
                )}
              </div>
              {data.overdue_returns.length === 0 ? (
                <p className="text-sm text-gray-400">No overdue returns. All clear!</p>
              ) : (
                <div className="space-y-2">
                  {data.overdue_returns.map((job) => (
                    <Link key={job.id} to={`/jobs/${job.id}`} className="flex items-center justify-between hover:bg-gray-50 -mx-2 px-2 py-1.5 rounded transition-colors">
                      <div className="min-w-0">
                        <div className="text-sm font-medium text-gray-900 truncate">
                          <span className="font-mono text-gray-400 text-xs mr-1">#{job.hh_job_number}</span>
                          {job.job_name || job.client_name || job.company_name || 'Untitled'}
                        </div>
                        <div className="text-xs text-gray-500">{job.venue_name || job.client_name || '—'}</div>
                      </div>
                      <div className="text-xs text-red-600 font-medium flex-shrink-0 ml-2">
                        Due {formatDate(job.return_date || '')}
                      </div>
                    </Link>
                  ))}
                </div>
              )}
            </div>

            {/* Recent Enquiries */}
            <div className="bg-white rounded-xl shadow-sm border border-gray-200 p-5">
              <div className="flex items-center justify-between mb-3">
                <h3 className="text-sm font-semibold text-gray-700">Enquiries & Provisionals</h3>
                <Link to="/pipeline" className="text-xs text-ooosh-600 hover:text-ooosh-700">View all &rarr;</Link>
              </div>
              {data.recent_enquiries.length === 0 ? (
                <p className="text-sm text-gray-400">No open enquiries.</p>
              ) : (
                <div className="space-y-2">
                  {data.recent_enquiries.map((job) => (
                    <Link key={job.id} to={`/jobs/${job.id}`} className="flex items-center justify-between hover:bg-gray-50 -mx-2 px-2 py-1.5 rounded transition-colors">
                      <div className="min-w-0">
                        <div className="text-sm font-medium text-gray-900 truncate">
                          <span className="font-mono text-gray-400 text-xs mr-1">#{job.hh_job_number}</span>
                          {job.job_name || 'Untitled'}
                        </div>
                        <div className="text-xs text-gray-500">{job.client_name || job.company_name || '—'}</div>
                      </div>
                      <span className={`inline-flex px-2 py-0.5 rounded-full text-[10px] font-medium flex-shrink-0 ml-2 ${JOB_STATUS_COLOURS[job.status]}`}>
                        {JOB_STATUS_MAP[job.status]}
                      </span>
                    </Link>
                  ))}
                </div>
              )}
            </div>

            {/* Pending Referrals */}
            {data.pending_referrals.length > 0 && (
              <div className="bg-white rounded-xl shadow-sm border border-orange-200 p-5">
                <div className="flex items-center justify-between mb-3">
                  <h3 className="text-sm font-semibold text-gray-700">Pending Referrals</h3>
                  <span className="text-xs bg-orange-100 text-orange-700 px-2 py-0.5 rounded-full font-medium">
                    {data.pending_referrals.length}
                  </span>
                </div>
                <div className="space-y-2">
                  {data.pending_referrals.map((r) => (
                    <Link key={r.id} to={`/vehicles/drivers/${r.id}`} className="flex items-center justify-between hover:bg-gray-50 -mx-2 px-2 py-1.5 rounded transition-colors">
                      <div className="min-w-0">
                        <div className="text-sm font-medium text-gray-900 truncate">
                          {r.full_name}
                          {r.licence_points != null && r.licence_points > 0 && (
                            <span className={`ml-2 text-xs px-1.5 py-0.5 rounded-full ${
                              r.licence_points >= 10 ? 'bg-red-100 text-red-700' :
                              r.licence_points >= 7 ? 'bg-orange-100 text-orange-700' :
                              'bg-amber-100 text-amber-700'
                            }`}>
                              {r.licence_points} pts
                            </span>
                          )}
                        </div>
                        <div className="text-xs text-gray-500">
                          {r.hirehop_job_name || r.job_name || 'No job linked'}
                        </div>
                      </div>
                      <span className="text-xs text-orange-600 font-medium flex-shrink-0 ml-2">
                        {r.referral_status || 'Pending'}
                      </span>
                    </Link>
                  ))}
                </div>
              </div>
            )}

            {/* Pending Excess */}
            {data.pending_excess.length > 0 && (
              <div className="bg-white rounded-xl shadow-sm border border-amber-200 p-5">
                <div className="flex items-center justify-between mb-3">
                  <h3 className="text-sm font-semibold text-gray-700">Excess Awaiting Collection</h3>
                  <span className="text-xs bg-amber-100 text-amber-700 px-2 py-0.5 rounded-full font-medium">
                    {data.pending_excess.length}
                  </span>
                </div>
                <div className="space-y-2">
                  {data.pending_excess.map((e) => (
                    <Link key={e.excess_id} to={e.job_uuid ? `/jobs/${e.job_uuid}` : '#'} className="flex items-center justify-between hover:bg-gray-50 -mx-2 px-2 py-1.5 rounded transition-colors">
                      <div className="min-w-0">
                        <div className="text-sm font-medium text-gray-900 truncate">
                          {e.driver_name || e.driver_email || 'Unknown driver'}
                          <span className="text-gray-400 font-normal ml-1.5">— {e.vehicle_reg || '?'}</span>
                        </div>
                        <div className="text-xs text-gray-500">
                          {e.hirehop_job_name || e.job_name || `J-${e.hirehop_job_id}`}
                          {e.hire_start && ` · ${new Date(e.hire_start).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}`}
                        </div>
                      </div>
                      <span className="text-xs text-amber-600 font-medium flex-shrink-0 ml-2">
                        {e.excess_amount_required ? `£${Number(e.excess_amount_required).toFixed(0)}` : 'TBD'}
                      </span>
                    </Link>
                  ))}
                </div>
              </div>
            )}

            {/* Still-placeholder panels */}
            <PlaceholderPanel
              title="Operations"
              items={['Crewed jobs needing intros', 'Rehearsals needing studio sitters', 'Expected merch/deliveries', 'Overdue lost property']}
              integration="HireHop"
            />
            <PlaceholderPanel
              title="Financial"
              items={['Overdue invoices', 'Insurance deposits due', 'End of hire follow-ups', 'Carnet attention required']}
              integration="HireHop + Xero"
              adminOnly
            />
          </div>
        </div>

        {/* Right column — Sidebar */}
        <div className="space-y-6">

          {/* Team Activity */}
          <div className="bg-white rounded-xl shadow-sm border border-gray-200 p-5">
            <h2 className="text-sm font-semibold text-gray-700 mb-3">Team — This Week</h2>
            <div className="space-y-3">
              {data.team_activity.map((member) => (
                <div key={member.user_id} className="flex items-center gap-3">
                  <div className="w-8 h-8 rounded-full bg-ooosh-100 text-ooosh-700 flex items-center justify-center text-xs font-bold flex-shrink-0">
                    {member.name[0]?.toUpperCase() || '?'}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-medium text-gray-900">{member.name}</div>
                    <div className="text-xs text-gray-500">
                      {parseInt(member.interaction_count) > 0
                        ? `${member.interaction_count} interaction${parseInt(member.interaction_count) !== 1 ? 's' : ''}`
                        : 'No activity'}
                      {member.last_active && ` · ${formatTimeAgo(member.last_active)}`}
                    </div>
                  </div>
                  {parseInt(member.interaction_count) > 0 && (
                    <div className="w-12 h-1.5 bg-gray-100 rounded-full overflow-hidden flex-shrink-0">
                      <div
                        className="h-full bg-ooosh-400 rounded-full"
                        style={{ width: `${Math.min((parseInt(member.interaction_count) / Math.max(...data.team_activity.map(m => parseInt(m.interaction_count)))) * 100, 100)}%` }}
                      />
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>

          {/* Recently Added */}
          {(data.recent_people.length > 0 || data.recent_orgs.length > 0) && (
            <div className="bg-white rounded-xl shadow-sm border border-gray-200 p-5">
              <h2 className="text-sm font-semibold text-gray-700 mb-3">Recently Added</h2>

              {data.recent_people.length > 0 && (
                <div className="mb-4">
                  <h3 className="text-xs font-medium text-gray-400 uppercase tracking-wider mb-2">People</h3>
                  <div className="space-y-2">
                    {data.recent_people.map((p) => (
                      <Link key={p.id} to={`/people/${p.id}`} className="flex items-center justify-between hover:bg-gray-50 -mx-2 px-2 py-1 rounded transition-colors">
                        <span className="text-sm text-gray-700">{p.first_name} {p.last_name}</span>
                        <span className="text-xs text-gray-400">{formatDate(p.created_at)}</span>
                      </Link>
                    ))}
                  </div>
                </div>
              )}

              {data.recent_orgs.length > 0 && (
                <div>
                  <h3 className="text-xs font-medium text-gray-400 uppercase tracking-wider mb-2">Organisations</h3>
                  <div className="space-y-2">
                    {data.recent_orgs.map((o) => (
                      <Link key={o.id} to={`/organisations/${o.id}`} className="flex items-center justify-between hover:bg-gray-50 -mx-2 px-2 py-1 rounded transition-colors">
                        <div>
                          <span className="text-sm text-gray-700">{o.name}</span>
                          <span className="text-xs text-gray-400 ml-1.5">{o.type}</span>
                        </div>
                        <span className="text-xs text-gray-400">{formatDate(o.created_at)}</span>
                      </Link>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}

          {/* Coming Up — real upcoming jobs */}
          <div className="bg-white rounded-xl shadow-sm border border-gray-200 p-5">
            <div className="flex items-center justify-between mb-3">
              <h2 className="text-sm font-semibold text-gray-700">Coming Up</h2>
              <Link to="/jobs?status=1,2,3" className="text-xs text-ooosh-600 hover:text-ooosh-700">View all &rarr;</Link>
            </div>
            {data.upcoming_jobs.length === 0 ? (
              <p className="text-sm text-gray-400">No jobs starting in the next 14 days.</p>
            ) : (
              <div className="space-y-2">
                {data.upcoming_jobs.map((job) => (
                  <Link key={job.id} to={`/jobs/${job.id}`} className="flex items-center justify-between hover:bg-gray-50 -mx-2 px-2 py-1.5 rounded transition-colors">
                    <div className="min-w-0">
                      <div className="text-sm text-gray-700 truncate">{job.job_name || job.client_name || 'Untitled'}</div>
                      <div className="text-xs text-gray-400">{job.venue_name || '—'}</div>
                    </div>
                    <span className="text-xs text-gray-500 flex-shrink-0 ml-2">{formatDate(job.job_date || '')}</span>
                  </Link>
                ))}
              </div>
            )}
          </div>

          {/* Quick Actions */}
          <div className="bg-white rounded-xl shadow-sm border border-gray-200 p-5">
            <h2 className="text-sm font-semibold text-gray-700 mb-3">Quick Actions</h2>
            <div className="space-y-2">
              <Link to="/people" className="flex items-center gap-2 text-sm text-ooosh-600 hover:text-ooosh-700 transition-colors">
                <span className="w-5 h-5 rounded bg-blue-100 text-blue-700 flex items-center justify-center text-xs font-bold">+</span>
                Add Person
              </Link>
              <Link to="/organisations" className="flex items-center gap-2 text-sm text-ooosh-600 hover:text-ooosh-700 transition-colors">
                <span className="w-5 h-5 rounded bg-purple-100 text-purple-700 flex items-center justify-center text-xs font-bold">+</span>
                Add Organisation
              </Link>
              <Link to="/venues" className="flex items-center gap-2 text-sm text-ooosh-600 hover:text-ooosh-700 transition-colors">
                <span className="w-5 h-5 rounded bg-teal-100 text-teal-700 flex items-center justify-center text-xs font-bold">+</span>
                Add Venue
              </Link>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

/* --- Sub-components --- */

function StatCard({ label, value, subtitle, href, color }: {
  label: string;
  value: string;
  subtitle?: string;
  href?: string;
  color: string;
}) {
  const content = (
    <div className={`bg-white rounded-xl shadow-sm border border-gray-200 p-4 ${href ? 'hover:border-gray-300 transition-colors' : ''}`}>
      <div className="flex items-center gap-3">
        <div className={`w-2 h-8 rounded-full ${color}`} />
        <div>
          <div className="text-2xl font-bold text-gray-900">{value}</div>
          <div className="text-xs text-gray-500">{label}</div>
          {subtitle && <div className="text-xs text-gray-400 mt-0.5">{subtitle}</div>}
        </div>
      </div>
    </div>
  );

  if (href) return <Link to={href}>{content}</Link>;
  return content;
}

function PlaceholderPanel({ title, items, integration, adminOnly }: {
  title: string;
  items: string[];
  integration: string;
  adminOnly?: boolean;
}) {
  return (
    <div className="bg-white rounded-xl shadow-sm border border-gray-200 p-5 opacity-75">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-sm font-semibold text-gray-700">{title}</h3>
        <div className="flex gap-1.5">
          {adminOnly && (
            <span className="text-[10px] bg-red-50 text-red-500 px-1.5 py-0.5 rounded">Admin</span>
          )}
          <span className="text-[10px] bg-amber-50 text-amber-600 px-1.5 py-0.5 rounded">
            Awaiting {integration}
          </span>
        </div>
      </div>
      <ul className="space-y-1.5">
        {items.map((item) => (
          <li key={item} className="text-xs text-gray-400 flex items-center gap-2">
            <span className="w-1 h-1 bg-gray-300 rounded-full flex-shrink-0" />
            {item}
          </li>
        ))}
      </ul>
    </div>
  );
}
