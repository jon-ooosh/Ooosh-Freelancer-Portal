import { Link } from 'react-router-dom';
import type { DashboardSectionProps } from '../sections';
import { Card } from '../primitives';

interface NACardItem {
  id: string;
  label: string;
  age?: string;
  sub?: string;
  tag?: string;
  href?: string;
}

interface NABucket {
  key: string;
  title: string;
  accent: 'red' | 'amber' | 'blue' | 'purple';
  items: NACardItem[];
  count: number;
  viewAllHref?: string;
}

const ACCENT_COLOR: Record<NABucket['accent'], string> = {
  red: 'var(--op-red)',
  amber: 'var(--op-amber)',
  blue: 'var(--op-blue)',
  purple: 'var(--op-purple)',
};

function NACard({ bucket }: { bucket: NABucket }) {
  const empty = bucket.count === 0;
  const dotColor = ACCENT_COLOR[bucket.accent];
  const tinted = bucket.accent === 'red' ? 'var(--op-red-bg)'
    : bucket.accent === 'amber' ? 'var(--op-amber-bg)'
    : bucket.accent === 'blue' ? 'var(--op-blue-bg)'
    : 'var(--op-purple-50)';

  return (
    <div
      className="op-card flex flex-col gap-2 min-h-[180px]"
      style={empty ? {} : { background: tinted, borderColor: tinted }}
    >
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2 op-eyebrow">
          <span
            className="inline-block rounded-full"
            style={{ width: 8, height: 8, background: dotColor }}
          />
          {bucket.title}
        </div>
        {empty ? (
          <span className="text-[10.5px] uppercase font-semibold tracking-wider text-green-700 bg-green-50 px-2 py-0.5 rounded-full">
            All clear
          </span>
        ) : (
          <span className="op-num text-xs text-gray-500 bg-white/60 px-2 py-0.5 rounded-full">
            {bucket.count}
          </span>
        )}
      </div>
      {empty ? null : (
        <>
          <div className="space-y-2">
            {bucket.items.slice(0, 3).map((item) => {
              const inner = (
                <>
                  <div className="text-sm text-gray-900 leading-tight">{item.label}</div>
                  <div className="flex items-center gap-2 text-xs text-gray-500 mt-0.5">
                    {item.age && <span>{item.age}</span>}
                    {item.sub && <span>· {item.sub}</span>}
                    {item.tag && (
                      <span className="ml-auto text-[10px] uppercase font-semibold tracking-wider bg-gray-100 text-gray-700 px-1.5 py-0.5 rounded-full">
                        {item.tag}
                      </span>
                    )}
                  </div>
                </>
              );
              return item.href ? (
                <Link key={item.id} to={item.href} className="block hover:opacity-80 transition">
                  {inner}
                </Link>
              ) : (
                <div key={item.id}>{inner}</div>
              );
            })}
          </div>
          {bucket.count > 3 && bucket.viewAllHref && (
            <Link
              to={bucket.viewAllHref}
              className="text-xs font-medium mt-auto pt-1"
              style={{ color: dotColor }}
            >
              View all {bucket.count} →
            </Link>
          )}
        </>
      )}
    </div>
  );
}

export default function NeedsAttention({ data }: DashboardSectionProps) {
  const na = data.needs_attention;
  const overdueTotal = na.total_overdue_count ?? 0;

  // Overdue (red row)
  const returns: NABucket = {
    key: 'returns',
    title: 'Overdue Returns',
    accent: 'red',
    count: na.overdue_returns?.length || 0,
    items: (na.overdue_returns || []).map((j) => {
      const ret = j.return_date ? new Date(j.return_date) : null;
      const days = ret ? Math.floor((Date.now() - ret.getTime()) / 86400000) : 0;
      return {
        id: j.id,
        label: `${j.hh_job_number ? `#${j.hh_job_number} ` : ''}${j.client_name || j.company_name || 'Unknown'} — ${j.job_name || 'Untitled'}`.slice(0, 80),
        age: `${days}d overdue`,
        href: `/jobs/${j.id}`,
      };
    }),
    viewAllHref: '/jobs/returns',
  };
  const departures: NABucket = {
    key: 'departures',
    title: 'Overdue Departures',
    accent: 'red',
    count: na.overdue_departures?.length || 0,
    items: (na.overdue_departures || []).map((j) => ({
      id: j.id,
      label: `${j.hh_job_number ? `#${j.hh_job_number} ` : ''}${j.client_name || 'Unknown'} — ${j.job_name || 'Untitled'}`.slice(0, 80),
      age: `${j.days_overdue}d overdue`,
      href: `/jobs/${j.id}`,
    })),
    viewAllHref: '/jobs',
  };
  const backline: NABucket = {
    key: 'backline',
    title: 'Overdue Backline',
    accent: 'red',
    count: na.overdue_backline?.length || 0,
    items: (na.overdue_backline || []).map((j) => ({
      id: j.id,
      label: `${j.hh_job_number ? `#${j.hh_job_number} ` : ''}${j.client_name || 'Unknown'} — ${j.job_name || 'Untitled'}`.slice(0, 80),
      age: `${j.days_overdue}d overdue`,
      href: `/jobs/${j.id}`,
    })),
    viewAllHref: '/operations/backline',
  };
  const transport: NABucket = {
    key: 'transport',
    title: 'Overdue Transport',
    accent: 'red',
    count: na.overdue_transport_ops?.length || 0,
    items: (na.overdue_transport_ops || []).map((q) => ({
      id: q.id,
      label: `${q.hh_job_number ? `#${q.hh_job_number} ` : ''}${q.client_name || 'Unknown'} — ${q.job_name || 'Untitled'}`.slice(0, 80),
      age: `${q.days_overdue}d overdue`,
      sub: q.ops_status || undefined,
      href: q.job_id ? `/jobs/${q.job_id}` : '/operations/transport',
    })),
    viewAllHref: '/operations/transport',
  };

  // Secondary row (amber/blue/purple)
  const referrals: NABucket = {
    key: 'referrals',
    title: 'Referrals',
    accent: 'amber',
    count: na.referral_count || 0,
    items: (na.referrals || []).map((d) => ({
      id: d.id,
      label: d.full_name,
      age: d.referral_status,
      tag: d.licence_points ? `${d.licence_points}pts` : undefined,
      href: `/drivers/${d.id}`,
    })),
    viewAllHref: '/drivers?referral=pending',
  };
  const excess: NABucket = {
    key: 'excess',
    title: 'Excess (Unreimbursed)',
    accent: 'amber',
    count: na.excess_count || 0,
    items: (na.excess_items || []).map((e) => ({
      id: e.excess_id,
      label: e.driver_name || e.job_name || `Job #${e.hh_job_number ?? '—'}`,
      age: `£${Math.round(e.excess_amount_required ?? 0)}`,
      sub: e.days_since_finish != null ? `${e.days_since_finish}d since hire` : undefined,
      tag: e.vehicle_reg ?? undefined,
      href: e.job_uuid ? `/jobs/${e.job_uuid}` : '/money/excess',
    })),
    viewAllHref: '/money/excess',
  };
  const chases: NABucket = {
    key: 'chases',
    title: 'Chases Due',
    accent: 'blue',
    count: na.chases_due?.length || 0,
    items: (na.chases_due || []).map((c) => {
      const due = new Date(c.next_chase_date);
      const days = Math.floor((Date.now() - due.getTime()) / 86400000);
      return {
        id: c.id,
        label: `${c.client_name || c.company_name || 'Unknown'} — ${c.job_name || 'Untitled'}`.slice(0, 80),
        age: days >= 0 ? `${days}d ago` : `in ${-days}d`,
        href: `/jobs/${c.id}`,
      };
    }),
    viewAllHref: '/pipeline?chasesDue=1',
  };

  const fleetItems: NACardItem[] = [];
  const fleet = data.fleet;
  if (fleet) {
    if (parseInt(fleet.mot_due_soon, 10) > 0) fleetItems.push({ id: 'mot', label: `${fleet.mot_due_soon} MOTs due`, age: 'within 30 days', href: '/vehicles/fleet?compliance=mot' });
    if (parseInt(fleet.insurance_due_soon, 10) > 0) fleetItems.push({ id: 'ins', label: `${fleet.insurance_due_soon} insurance renewals due`, age: 'within 30 days', href: '/vehicles/fleet?compliance=insurance' });
    if (parseInt(fleet.tax_due_soon, 10) > 0) fleetItems.push({ id: 'tax', label: `${fleet.tax_due_soon} tax discs due`, age: 'within 30 days', href: '/vehicles/fleet?compliance=tax' });
  }
  const fleetTotalCount = fleetItems.reduce(
    (sum, item) => sum + (parseInt(item.label.split(' ')[0], 10) || 0),
    0,
  );
  const fleetBucket: NABucket = {
    key: 'fleet',
    title: 'Fleet Compliance',
    accent: 'purple',
    count: fleetTotalCount,
    items: fleetItems,
    viewAllHref: '/vehicles/fleet',
  };

  // ── Adaptive layout ───────────────────────────────────────────────────
  // Per brief §4: when overdue total is 0, collapse to a thin "All clear" line
  // and only show secondary buckets that have items.
  const allClear = overdueTotal === 0;
  const secondaryBuckets = [referrals, excess, chases, fleetBucket];
  const secondaryAny = secondaryBuckets.some(b => b.count > 0);

  return (
    <Card as="section" className="!p-0 !border-0 !bg-transparent">
      {allClear ? (
        <div
          className="op-card flex items-center gap-3 mb-4"
          style={{ background: 'var(--op-green-bg)', borderColor: 'var(--op-green-bg)' }}
        >
          <span
            className="inline-block rounded-full"
            style={{ width: 10, height: 10, background: 'var(--op-green)' }}
          />
          <div className="op-eyebrow" style={{ color: 'var(--op-green)' }}>All clear</div>
          <div className="text-sm text-gray-700">Nothing overdue.</div>
        </div>
      ) : (
        <>
          <div className="op-eyebrow mb-1" style={{ color: 'var(--op-red)' }}>
            ⚠ {overdueTotal} overdue · needs attention now
          </div>
          <div className="op-h1 mb-1">Needs attention</div>
          <div className="text-xs text-gray-500 mb-4">
            Items that should be done but aren't. Click any card to triage.
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 mb-4">
            <NACard bucket={returns} />
            <NACard bucket={departures} />
            <NACard bucket={backline} />
            <NACard bucket={transport} />
          </div>
        </>
      )}
      {secondaryAny && (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          {secondaryBuckets.filter(b => b.count > 0 || !allClear).map(b => (
            <NACard key={b.key} bucket={b} />
          ))}
        </div>
      )}
    </Card>
  );
}
