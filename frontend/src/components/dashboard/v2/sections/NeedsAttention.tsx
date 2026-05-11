import { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import type { DashboardSectionProps } from '../sections';
import { Card } from '../primitives';
import { api } from '../../../../services/api';

interface ProblemSummary {
  open_total: number;
  urgent_total: number;
  damaged_open: number;
  missing_open: number;
  broken_open: number;
  dispute_open: number;
  items: Array<{
    id: string;
    job_id: string;
    category: string;
    severity: string;
    summary: string;
    hh_job_number?: number;
    job_name?: string | null;
    client_name?: string | null;
  }>;
}

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
      className="op-card flex flex-col gap-2 min-h-[180px] transition-opacity"
      style={empty
        ? { opacity: 0.45, background: 'var(--op-surface)', borderColor: 'var(--op-border)' }
        : { background: tinted, borderColor: tinted }
      }
    >
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2 op-eyebrow">
          <span
            className="inline-block rounded-full"
            style={{ width: 8, height: 8, background: empty ? 'var(--op-text-3)' : dotColor }}
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

  // Job problems / issues register — fetched separately because dashboard's
  // /operations endpoint doesn't (yet) include problems in its aggregate.
  // Kept side-loaded so the rest of NeedsAttention renders even if the
  // problems table doesn't exist (returns 500 → empty bucket).
  const [problems, setProblems] = useState<ProblemSummary | null>(null);
  useEffect(() => {
    api.get<{ data: ProblemSummary }>('/problems/summary')
      .then(res => setProblems(res.data))
      .catch(() => {});
  }, []);

  // Overdue (red row) — "Overdue Completions" means jobs that came back but
  // haven't been closed out yet (invoiced, paid, excess resolved, etc.). The
  // separate "physically out and not back yet" case lives on the headline
  // stat card. Backend exposes the same data under both `overdue_completions`
  // (new) and `overdue_returns` (back-compat alias).
  const completionsRows = na.overdue_completions || na.overdue_returns || [];
  // Backend caps the row list at 10 for display; the true count comes from
  // overdue_completions_total (added May 2026). Falls back to row count if
  // we're talking to an older backend that doesn't expose the total.
  const completionsTotal = na.overdue_completions_total ?? completionsRows.length;
  const completions: NABucket = {
    key: 'completions',
    title: 'Overdue Completions',
    accent: 'red',
    count: completionsTotal,
    items: completionsRows.map((j) => {
      const ret = j.return_date ? new Date(j.return_date) : null;
      const days = ret ? Math.floor((Date.now() - ret.getTime()) / 86400000) : 0;
      return {
        id: j.id,
        label: `${j.hh_job_number ? `#${j.hh_job_number} ` : ''}${j.client_name || j.company_name || 'Unknown'} — ${j.job_name || 'Untitled'}`.slice(0, 80),
        age: `${days}d overdue`,
        href: `/jobs/${j.id}`,
      };
    }),
    viewAllHref: '/jobs/returns?overdue=1',
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
  // Transport arrangements to action — quotes in next 7 days on a
  // confirmed/pre-dispatch job where any arranging pill (client intro /
  // tolls / accommodation / flights) is still outstanding. Replaces the
  // old "Chases Due" bucket: chases now live solely on the stat-card row,
  // and post-confirmation follow-ups belong to the reminders system.
  const transportArrangements: NABucket = {
    key: 'transport_arrangements',
    title: 'Transport Arrangements',
    accent: 'blue',
    count: na.client_intros?.length || 0,
    items: (na.client_intros || []).map((q) => {
      const date = new Date(q.job_date);
      const today = new Date(); today.setHours(0, 0, 0, 0);
      const days = Math.round((date.getTime() - today.getTime()) / 86400000);
      const dateLabel = days <= 0 ? 'today' : days === 1 ? 'tomorrow' : `in ${days}d`;
      const who = q.client_name || q.company_name || 'Unknown';
      const where = q.venue_name || q.job_name || 'Untitled';
      const outstanding: string[] = [];
      if (q.client_introduction === 'todo') outstanding.push('intro');
      else if (q.client_introduction === 'working_on_it') outstanding.push('intro (wip)');
      if (q.tolls_status === 'todo') outstanding.push('tolls');
      if (q.accommodation_status === 'todo') outstanding.push('accom');
      if (q.flight_status === 'todo') outstanding.push('flights');
      return {
        id: q.quote_id,
        label: `${who} — ${where}`.slice(0, 80),
        age: dateLabel,
        sub: outstanding.join(' · ') || 'to do',
        href: '/operations/transport?needs_arranging=1',
      };
    }),
    viewAllHref: '/operations/transport?needs_arranging=1',
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
  // When the whole overdue total is 0, the overdue row collapses to a thin
  // green "All clear" line. Otherwise all 4 overdue cards render — empty
  // ones faded to ~45% opacity (via NACard) so the row keeps a consistent
  // shape but draws the eye to the populated cards.
  // Same for the secondary row: when ALL secondary buckets are empty the
  // whole row hides; otherwise empty ones render faded alongside populated
  // ones.
  // Open problems / issues register — purple accent (special category, not
  // time-critical like "overdue" but actively needs human chasing). Urgent
  // problems get a flag in the title.
  const problemsBucket: NABucket = {
    key: 'problems',
    title: problems && problems.urgent_total > 0
      ? `Open Problems (${problems.urgent_total} urgent)`
      : 'Open Problems',
    accent: 'purple',
    count: problems?.open_total || 0,
    items: (problems?.items || []).map((p) => ({
      id: p.id,
      label: `${p.hh_job_number ? `#${p.hh_job_number} ` : ''}${p.client_name || 'Unknown'} — ${p.summary}`.slice(0, 80),
      sub: p.category,
      tag: p.severity === 'urgent' ? 'URGENT' : undefined,
      href: `/operations/problems/${p.id}`,
    })),
    viewAllHref: '/operations/problems',
  };

  const allClear = overdueTotal === 0;
  const overdueBuckets = [departures, completions, backline, transport];
  const secondaryBuckets = [referrals, excess, transportArrangements, fleetBucket, problemsBucket];
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
            {overdueBuckets.map(b => <NACard key={b.key} bucket={b} />)}
          </div>
        </>
      )}
      {secondaryAny && (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          {secondaryBuckets.map(b => <NACard key={b.key} bucket={b} />)}
        </div>
      )}
    </Card>
  );
}
