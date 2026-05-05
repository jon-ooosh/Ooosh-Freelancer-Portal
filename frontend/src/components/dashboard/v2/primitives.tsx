import { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import type { ProgressStripStatus, ProgressStripCategory, JobProgressStrip } from './progress-strip';
import { STRIP_ORDER } from './progress-strip';

/* ── Card / Section header ─────────────────────────────────────────────── */

export function Card({
  children, className = '', as: Tag = 'div',
}: { children: ReactNode; className?: string; as?: 'div' | 'section' }) {
  return <Tag className={`op-card ${className}`}>{children}</Tag>;
}

export function SectionHd({
  eyebrow, title, sub, action,
}: { eyebrow?: ReactNode; title?: ReactNode; sub?: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex items-end justify-between mb-3">
      <div>
        {eyebrow && <div className="op-eyebrow mb-1">{eyebrow}</div>}
        {title && <div className="op-title">{title}</div>}
        {sub && <div className="text-xs text-gray-500 mt-0.5">{sub}</div>}
      </div>
      {action && <div>{action}</div>}
    </div>
  );
}

/* ── Stat card (top row) ────────────────────────────────────────────────── */

export function StatCard({
  value, label, accent = 'grey', sparkline, to,
}: {
  value: string | number;
  label: string;
  accent?: 'grey' | 'red' | 'amber' | 'green' | 'blue' | 'purple';
  sparkline?: number[];
  to?: string;
}) {
  const stripeColor: Record<string, string> = {
    grey: 'var(--op-text-3)',
    red: 'var(--op-red)',
    amber: 'var(--op-amber)',
    green: 'var(--op-green)',
    blue: 'var(--op-blue)',
    purple: 'var(--op-purple)',
  };
  const inner = (
    <div className="flex items-center justify-between gap-3">
      <div>
        <div className="op-num text-2xl font-semibold leading-none">{value}</div>
        <div className="text-xs text-gray-500 mt-1.5">{label}</div>
      </div>
      {sparkline && sparkline.length > 1 && (
        <Sparkline values={sparkline} color={stripeColor[accent]} />
      )}
    </div>
  );
  const className = 'op-card relative overflow-hidden';
  const style = { borderLeft: `3px solid ${stripeColor[accent]}` };
  if (to) {
    return (
      <Link
        to={to}
        className={`${className} block transition hover:shadow-md hover:-translate-y-0.5`}
        style={style}
      >
        {inner}
      </Link>
    );
  }
  return <div className={className} style={style}>{inner}</div>;
}

/* ── Sparkline ─────────────────────────────────────────────────────────── */

export function Sparkline({
  values, color = 'currentColor', width = 80, height = 28,
}: { values: number[]; color?: string; width?: number; height?: number }) {
  if (values.length < 2) return null;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min || 1;
  const stepX = width / (values.length - 1);
  const points = values
    .map((v, i) => `${(i * stepX).toFixed(1)},${(height - ((v - min) / range) * height).toFixed(1)}`)
    .join(' ');
  return (
    <svg width={width} height={height} aria-hidden="true">
      <polyline
        points={points}
        fill="none"
        stroke={color}
        strokeWidth={1.5}
        strokeLinecap="round"
        strokeLinejoin="round"
        opacity={0.7}
      />
    </svg>
  );
}

/* ── Progress strip (per-job 7-pip status row) ─────────────────────────── */

const PIP_CLASS: Record<ProgressStripStatus, string> = {
  todo: 'op-pip-todo',
  wip: 'op-pip-wip',
  done: 'op-pip-done',
  prob: 'op-pip-prob',
};

const PIP_STATUS_LABEL: Record<ProgressStripStatus, string> = {
  todo: 'To do',
  wip: 'In progress',
  done: 'Done',
  prob: 'Problem',
};

export function ProgressStrip({
  strip, labels,
}: {
  strip: JobProgressStrip;
  labels: Record<ProgressStripCategory, string>;
}) {
  // Only render categories present on the strip — a missing category means
  // the job has no matching requirement for it, so showing nothing is more
  // informative than showing a greyed-out "not applicable" placeholder.
  const present = STRIP_ORDER.filter((cat) => strip[cat] !== undefined);
  if (present.length === 0) {
    return <div className="text-xs text-gray-400">No requirements yet.</div>;
  }
  return (
    <div className="flex flex-wrap gap-1.5">
      {present.map((cat) => {
        const status = strip[cat]!;
        return (
          <span
            key={cat}
            className={`op-pip ${PIP_CLASS[status]}`}
            title={`${labels[cat]} — ${PIP_STATUS_LABEL[status]}`}
          >
            {labels[cat]}
          </span>
        );
      })}
    </div>
  );
}

/* ── Progress bar (% done with WIP overlay) ────────────────────────────── */

export function ProgressBar({
  done, wip, total, color = 'green',
}: { done: number; wip: number; total: number; color?: 'green' | 'amber' | 'purple' }) {
  if (total === 0) return null;
  const dPct = (done / total) * 100;
  const wPct = (wip / total) * 100;
  const colorVar: Record<string, string> = {
    green: 'var(--op-green)',
    amber: 'var(--op-amber)',
    purple: 'var(--op-purple)',
  };
  return (
    <div
      className="relative w-full overflow-hidden rounded-full"
      style={{ height: 6, background: 'var(--op-grey-bg)' }}
    >
      <div
        className="absolute inset-y-0 left-0"
        style={{ width: `${dPct + wPct}%`, background: 'var(--op-amber)', opacity: 0.5 }}
      />
      <div
        className="absolute inset-y-0 left-0"
        style={{ width: `${dPct}%`, background: colorVar[color] }}
      />
    </div>
  );
}

/* ── Segmented bar (transport status mix) ──────────────────────────────── */

export function SegBar({ segments }: { segments: { label: string; count: number; color: string }[] }) {
  const total = segments.reduce((sum, s) => sum + s.count, 0);
  if (total === 0) {
    return <div className="text-xs text-gray-500">No items.</div>;
  }
  return (
    <>
      <div
        className="w-full rounded-full overflow-hidden flex"
        style={{ height: 8, background: 'var(--op-grey-bg)' }}
      >
        {segments.map((s, i) =>
          s.count > 0 ? (
            <div
              key={i}
              style={{
                width: `${(s.count / total) * 100}%`,
                background: s.color,
              }}
              title={`${s.label}: ${s.count}`}
            />
          ) : null,
        )}
      </div>
      <div className="grid grid-cols-2 gap-x-4 gap-y-1.5 mt-3 text-xs">
        {segments.map((s) => (
          <div key={s.label} className="flex items-center justify-between gap-2">
            <span className="flex items-center gap-1.5">
              <span
                className="inline-block rounded-full"
                style={{ width: 8, height: 8, background: s.color }}
              />
              <span className="text-gray-700">{s.label}</span>
            </span>
            <span className="op-num font-medium tabular-nums">{s.count}</span>
          </div>
        ))}
      </div>
    </>
  );
}
