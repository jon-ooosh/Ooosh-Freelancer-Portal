import { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../services/api';
import { useAuthStore } from '../hooks/useAuthStore';

interface DashboardData {
  counts: {
    people_count: string;
    org_count: string;
    venue_count: string;
    interaction_count: string;
    user_count: string;
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
}

const TYPE_COLORS: Record<string, string> = {
  note: 'bg-blue-100 text-blue-700',
  call: 'bg-green-100 text-green-700',
  email: 'bg-purple-100 text-purple-700',
  meeting: 'bg-amber-100 text-amber-700',
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
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-4 mb-6">
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

          {/* HireHop Integration Panels — Coming Soon */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <PlaceholderPanel
              title="Active Hires"
              items={['Hires out on the road', 'Deliveries & collections today', 'Equipment due back', 'Equipment due out']}
              integration="HireHop"
            />
            <PlaceholderPanel
              title="Enquiries & Quotes"
              items={['Enquiries awaiting response', 'Response time tracking', 'Quotes pending confirmation', 'Follow-up due dates']}
              integration="HireHop"
            />
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

          {/* Coming Up — Placeholder */}
          <PlaceholderPanel
            title="Coming Up"
            items={['Hires starting in 7 days', 'Vehicles due for MOT/service', 'Staff holidays & absences', 'Cold leads to follow up']}
            integration="HireHop"
          />

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
