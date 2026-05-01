import { Link } from 'react-router-dom';
import type { DashboardSectionProps } from '../sections';
import { Card, SectionHd } from '../primitives';
import { formatTimeAgo } from '../../helpers';

export default function ActivityBlock({ data }: DashboardSectionProps) {
  const team = (data.team_activity || []).slice(0, 6);
  const recent = (data.recent_activity || []).slice(0, 6);
  const max = Math.max(1, ...team.map(t => parseInt(t.interaction_count, 10) || 0));

  return (
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
      <Card as="section">
        <SectionHd eyebrow="Team This Week" title="Activity by user" />
        {team.length === 0 ? (
          <div className="text-sm text-gray-500">No interactions logged yet this week.</div>
        ) : (
          <div className="space-y-2.5">
            {team.map(t => {
              const count = parseInt(t.interaction_count, 10) || 0;
              const w = (count / max) * 100;
              return (
                <div key={t.user_id} className="grid grid-cols-[100px_1fr_40px] items-center gap-3 text-sm">
                  <div className="text-gray-700 truncate">{t.name.split(' ')[0]}</div>
                  <div className="h-2 rounded-full" style={{ background: 'var(--op-grey-bg)' }}>
                    <div
                      className="h-full rounded-full"
                      style={{ width: `${w}%`, background: 'var(--op-purple)' }}
                    />
                  </div>
                  <div className="op-num text-xs text-gray-700 text-right">{count}</div>
                </div>
              );
            })}
          </div>
        )}
      </Card>

      <Card as="section">
        <SectionHd
          eyebrow="Recent"
          title={`Last ${recent.length} interactions`}
          action={<Link to="/people" className="text-xs font-medium" style={{ color: 'var(--op-purple)' }}>View all →</Link>}
        />
        {recent.length === 0 ? (
          <div className="text-sm text-gray-500">No recent activity.</div>
        ) : (
          <ul className="space-y-2 text-sm">
            {recent.map(r => {
              const entityHref = r.person_id ? `/people/${r.person_id}`
                : r.organisation_id ? `/organisations/${r.organisation_id}`
                : r.venue_id ? `/venues/${r.venue_id}`
                : null;
              const verb = r.type === 'note' ? 'added note to'
                : r.type === 'call' ? 'logged a call'
                : r.type === 'email' ? 'sent email'
                : r.type === 'status_transition' ? 'changed status'
                : r.type === 'meeting' ? 'logged meeting'
                : 'updated';
              return (
                <li key={r.id} className="flex items-baseline justify-between gap-2 py-1.5 border-b last:border-0" style={{ borderColor: 'var(--op-border)' }}>
                  <div className="truncate">
                    <span className="font-medium">{r.created_by_name?.split(' ')[0] || 'Someone'}</span>
                    <span className="text-gray-500"> {verb} </span>
                    {entityHref && r.entity_name ? (
                      <Link to={entityHref} className="text-purple-700 hover:underline">{r.entity_name}</Link>
                    ) : (
                      <span>{r.entity_name || ''}</span>
                    )}
                  </div>
                  <span className="op-num text-xs text-gray-400 shrink-0">{formatTimeAgo(r.created_at)}</span>
                </li>
              );
            })}
          </ul>
        )}
      </Card>
    </div>
  );
}
