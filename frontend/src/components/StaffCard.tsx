/**
 * The Staff page's building blocks — the look of the Time off tab (My Time,
 * from the Claude Design pack), shared so every tab on a person reads the same
 * way: white rounded cards, one 17px heading each, big figures with a quiet
 * caption underneath, and pills rather than coloured text for a state.
 *
 * Presentation only. Nothing here fetches or decides anything.
 */
import type { ReactNode } from 'react';

export function Card({ title, subtitle, action, children, className = '' }: {
  title?: ReactNode; subtitle?: ReactNode; action?: ReactNode; children: ReactNode; className?: string;
}) {
  return (
    <section className={`bg-white border border-gray-200 rounded-2xl sm:rounded-xl p-5 ${className}`}>
      {(title || action) && (
        <div className="flex flex-wrap items-start justify-between gap-3 mb-4">
          <div className="min-w-0">
            {title && <h2 className="text-[17px] font-semibold text-gray-900">{title}</h2>}
            {subtitle && <p className="text-[13px] text-gray-500 mt-0.5">{subtitle}</p>}
          </div>
          {action && <div className="shrink-0">{action}</div>}
        </div>
      )}
      {children}
    </section>
  );
}

/** A headline figure: label, big number, a caption under it. Clickable when given onClick. */
export function StatCard({ label, value, unit, caption, tone, onClick }: {
  label: string; value: ReactNode; unit?: string; caption?: ReactNode;
  tone?: 'warn' | 'bad'; onClick?: () => void;
}) {
  const colour = tone === 'bad' ? 'text-red-700' : tone === 'warn' ? 'text-amber-700' : 'text-gray-900';
  const body = (
    <>
      <div className="text-[13px] font-medium text-gray-500">{label}</div>
      <div className="flex items-baseline gap-1.5">
        <span className={`text-[32px] leading-none font-semibold tracking-[-0.02em] tabular-nums ${colour}`}>{value}</span>
        {unit && <span className="text-[15px] text-gray-700">{unit}</span>}
      </div>
      {caption && <div className="text-xs text-gray-500">{caption}</div>}
    </>
  );
  const cls = 'bg-white border border-gray-200 rounded-xl p-5 flex flex-col gap-2.5 text-left';
  return onClick
    ? <button onClick={onClick} className={`${cls} hover:border-ooosh-300 hover:shadow-sm transition`}>{body}</button>
    : <div className={cls}>{body}</div>;
}

/** One label / value line. Values sit right on wide screens, under the label on phones. */
export function InfoRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col sm:flex-row sm:items-baseline sm:justify-between gap-0.5 sm:gap-4 py-2.5 border-b border-gray-100 last:border-b-0">
      <dt className="text-[13px] text-gray-500 shrink-0">{label}</dt>
      <dd className="text-[15px] text-gray-900 sm:text-right min-w-0">{children}</dd>
    </div>
  );
}

const PILL: Record<'ok' | 'warn' | 'bad' | 'muted' | 'info', string> = {
  ok: 'bg-emerald-100 text-emerald-800',
  warn: 'bg-amber-100 text-amber-800',
  bad: 'bg-red-100 text-red-800',
  muted: 'bg-gray-100 text-gray-600',
  info: 'bg-ooosh-50 text-ooosh-700',
};

export function Pill({ tone = 'muted', children }: { tone?: keyof typeof PILL; children: ReactNode }) {
  return (
    <span className={`inline-flex text-xs px-[9px] py-[3px] rounded-full whitespace-nowrap ${PILL[tone]}`}>{children}</span>
  );
}

/** The primary and secondary buttons the Time off tab uses. */
export const btnPrimary = 'px-3.5 py-2 rounded-lg bg-ooosh-600 hover:bg-ooosh-700 text-white text-sm font-semibold disabled:opacity-50';
export const btnSecondary = 'px-3.5 py-2 rounded-lg border border-ooosh-300 text-ooosh-700 hover:bg-ooosh-50 text-sm font-medium disabled:opacity-50';
export const btnQuiet = 'text-sm text-gray-500 hover:text-gray-800';
