import { Link } from 'react-router-dom';
import type { DashboardSectionProps } from '../sections';
import { Card, SectionHd } from '../primitives';
import { formatCurrency } from '../../helpers';

const PIPELINE_LABELS: Record<string, string> = {
  new_enquiry: 'Enquiries',
  quoting: 'Quoting',
  chasing: 'Chasing',
  paused: 'Paused',
  provisional: 'Provisional',
  prepped: 'Prepped',
  prepping: 'Prepping',
  dispatched: 'Dispatched',
  returned: 'Returned',
  returned_incomplete: 'Returned Incomplete',
  completed: 'Completed',
  cancelled: 'Cancelled',
};

const PIPELINE_COLOURS: Record<string, string> = {
  new_enquiry: 'var(--op-blue)',
  quoting: 'var(--op-blue)',
  chasing: 'var(--op-amber)',
  paused: 'var(--op-grey)',
  provisional: 'var(--op-purple)',
  prepped: 'var(--op-grey)',
  prepping: 'var(--op-grey)',
  dispatched: 'var(--op-purple)',
  returned: 'var(--op-green)',
  returned_incomplete: 'var(--op-red)',
  completed: 'var(--op-grey-bg)',
  cancelled: 'var(--op-grey-bg)',
};

const ORDER = [
  'new_enquiry', 'quoting', 'chasing', 'paused',
  'provisional', 'prepped', 'prepping', 'dispatched',
  'returned', 'returned_incomplete', 'completed', 'cancelled',
];

export default function PipelineBlock({ data }: DashboardSectionProps) {
  const stats = data.pipeline?.by_status || [];
  const value = data.pipeline?.active_value || 0;
  const totalCount = stats.reduce((s, p) => s + parseInt(p.count, 10), 0);

  const sorted = [...stats].sort((a, b) => {
    const ai = ORDER.indexOf(a.pipeline_status);
    const bi = ORDER.indexOf(b.pipeline_status);
    return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi);
  });

  const max = Math.max(1, ...stats.map(s => parseInt(s.count, 10)));

  return (
    <Card as="section">
      <SectionHd
        eyebrow="Pipeline"
        title="Open pipeline by status"
        action={<Link to="/pipeline" className="text-xs font-medium" style={{ color: 'var(--op-purple)' }}>Open pipeline →</Link>}
      />
      <div className="grid grid-cols-1 lg:grid-cols-[1fr_280px] gap-6">
        <div className="space-y-2">
          {sorted.map(p => {
            const count = parseInt(p.count, 10);
            const w = (count / max) * 100;
            return (
              <div key={p.pipeline_status} className="grid grid-cols-[110px_1fr_40px] items-center gap-3 text-sm">
                <Link
                  to={`/pipeline?status=${p.pipeline_status}`}
                  className="text-gray-700 hover:text-purple-700 truncate"
                >
                  {PIPELINE_LABELS[p.pipeline_status] || p.pipeline_status}
                </Link>
                <div className="h-2 rounded-full" style={{ background: 'var(--op-grey-bg)' }}>
                  <div
                    className="h-full rounded-full"
                    style={{ width: `${w}%`, background: PIPELINE_COLOURS[p.pipeline_status] || 'var(--op-blue)' }}
                  />
                </div>
                <div className="op-num text-xs text-gray-700 text-right">{count}</div>
              </div>
            );
          })}
        </div>
        <div className="space-y-4">
          <div className="op-card !p-4" style={{ background: 'var(--op-bg)' }}>
            <div className="op-eyebrow mb-1">Active Pipeline Value</div>
            <div className="op-num text-3xl font-semibold leading-tight">{formatCurrency(value)}</div>
            <div className="text-xs text-gray-500 mt-1">Across {totalCount} open jobs</div>
          </div>
          <div>
            <div className="op-eyebrow mb-2">Quick Actions</div>
            <div className="flex flex-wrap gap-2">
              <Link to="/pipeline?newEnquiry=1" className="text-xs px-2.5 py-1.5 rounded border border-gray-200 hover:bg-gray-50">+ New enquiry</Link>
              <Link to="/people?new=1" className="text-xs px-2.5 py-1.5 rounded border border-gray-200 hover:bg-gray-50">+ Person</Link>
              <Link to="/organisations?new=1" className="text-xs px-2.5 py-1.5 rounded border border-gray-200 hover:bg-gray-50">+ Organisation</Link>
              <Link to="/venues?new=1" className="text-xs px-2.5 py-1.5 rounded border border-gray-200 hover:bg-gray-50">+ Venue</Link>
            </div>
          </div>
        </div>
      </div>
    </Card>
  );
}
