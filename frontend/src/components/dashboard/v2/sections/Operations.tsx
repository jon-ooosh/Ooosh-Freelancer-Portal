import { Link } from 'react-router-dom';
import type { DashboardSectionProps } from '../sections';
import { Card, ProgressBar, SectionHd, SegBar } from '../primitives';
import { formatPrepTime } from '../../helpers';

const OPS_COLOURS: Record<string, string> = {
  todo: 'var(--op-text-3)',
  arranging: 'var(--op-amber)',
  arranged: 'var(--op-blue)',
  dispatched: 'var(--op-purple)',
  arrived: 'var(--op-purple-300)',
  completed: 'var(--op-green)',
  cancelled: 'var(--op-grey-bg)',
};

const OPS_LABELS: Record<string, string> = {
  todo: 'To do',
  arranging: 'Arranging',
  arranged: 'Arranged',
  dispatched: 'Dispatched',
  arrived: 'Arrived',
  completed: 'Completed',
  cancelled: 'Cancelled',
};

export default function OpsRow({ data, backline }: DashboardSectionProps) {
  const summary = data.transport_ops?.summary || {};
  const total = Object.values(summary).reduce((s, v) => s + v, 0);
  const unassigned = data.transport_ops?.unassigned_count || 0;

  const segments = ['todo', 'arranging', 'arranged', 'dispatched', 'arrived', 'completed']
    .filter(k => (summary[k] ?? 0) > 0)
    .map(k => ({ label: OPS_LABELS[k] || k, count: summary[k] ?? 0, color: OPS_COLOURS[k] || '#999' }));

  const out = backline?.goingOut?.stats;
  const back = backline?.returning?.stats;

  return (
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
      <Card as="section">
        <SectionHd
          eyebrow="Transport Ops"
          title="Next 30 days"
          action={<Link to="/operations/transport" className="text-xs font-medium" style={{ color: 'var(--op-purple)' }}>Open →</Link>}
        />
        <div className="op-num text-3xl font-semibold mb-1">{total}</div>
        {unassigned > 0 && (
          <div className="text-xs mb-3" style={{ color: 'var(--op-amber)' }}>{unassigned} need crew</div>
        )}
        <SegBar segments={segments} />
      </Card>

      <Card as="section">
        <SectionHd
          eyebrow="Backline Status"
          title="Today"
          action={<Link to="/operations/backline" className="text-xs font-medium" style={{ color: 'var(--op-purple)' }}>Open →</Link>}
        />
        <div className="grid grid-cols-2 gap-4">
          <div className="op-card !p-4" style={{ background: 'var(--op-bg)' }}>
            <div className="op-eyebrow mb-1">Going Out</div>
            <div className="op-num text-3xl font-semibold leading-none">{out?.jobCount ?? 0}</div>
            <div className="text-xs text-gray-500 mt-1">{out?.totalItems ?? 0} items</div>
            <div className="mt-3">
              <ProgressBar
                done={out?.done ?? 0}
                wip={out?.inProgress ?? 0}
                total={out?.jobCount ?? 0}
                color="green"
              />
            </div>
            {out?.remainingPrepMins ? (
              <div className="text-xs mt-2" style={{ color: 'var(--op-amber)' }}>
                {formatPrepTime(out.remainingPrepMins)} prep remaining
              </div>
            ) : null}
          </div>
          <div className="op-card !p-4" style={{ background: 'var(--op-bg)' }}>
            <div className="op-eyebrow mb-1">Coming Back</div>
            <div className="op-num text-3xl font-semibold leading-none">{back?.jobCount ?? 0}</div>
            <div className="text-xs text-gray-500 mt-1">{back?.totalItems ?? 0} items</div>
            <div className="mt-3">
              <ProgressBar
                done={back?.done ?? 0}
                wip={back?.inProgress ?? 0}
                total={back?.jobCount ?? 0}
                color="green"
              />
            </div>
            {back?.remainingDeprepMins ? (
              <div className="text-xs mt-2" style={{ color: 'var(--op-amber)' }}>
                {formatPrepTime(back.remainingDeprepMins)} de-prep remaining
              </div>
            ) : null}
          </div>
        </div>
      </Card>
    </div>
  );
}
