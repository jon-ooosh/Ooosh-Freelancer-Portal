import { ReactNode } from 'react';

/**
 * Shared mobile-first list card primitive. Each list page (Transport Ops,
 * Jobs, Pipeline, Drivers, etc.) consumes this for its mobile breakpoint;
 * desktop layouts can stay as their own thing.
 *
 * Slot model:
 *   leadingBadge   — small left-side chip (job-type, status, role)
 *   primary        — main heading line (venue, job name, person name)
 *   primarySuffix  — inline tags next to the primary (📍, links, etc.)
 *   trailing       — right-side action (status pill / chevron / "+ Assign")
 *   secondary      — second line of muted text
 *   meta           — third line — small text strip (HH#, dates, distance)
 *   chips          — wrap-friendly chip strip (overdue, run-letter, fee, crew)
 *   children       — expanded panel content (rendered when expanded=true)
 */
export interface MobileListCardProps {
  leftBorderClass?: string;
  expanded?: boolean;
  onToggle?: () => void;
  leadingBadge?: ReactNode;
  primary: ReactNode;
  primarySuffix?: ReactNode;
  trailing?: ReactNode;
  secondary?: ReactNode;
  meta?: ReactNode;
  chips?: ReactNode;
  children?: ReactNode;
  className?: string;
}

export function MobileListCard({
  leftBorderClass = '',
  expanded = false,
  onToggle,
  leadingBadge,
  primary,
  primarySuffix,
  trailing,
  secondary,
  meta,
  chips,
  children,
  className = '',
}: MobileListCardProps) {
  const containerClasses = [
    'bg-white',
    leftBorderClass,
    className,
  ].filter(Boolean).join(' ');

  return (
    <div className={containerClasses}>
      <div
        className={`px-3 py-3 ${onToggle ? 'cursor-pointer active:bg-gray-50' : ''}`}
        onClick={onToggle}
        role={onToggle ? 'button' : undefined}
        tabIndex={onToggle ? 0 : undefined}
        onKeyDown={
          onToggle
            ? (e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  onToggle();
                }
              }
            : undefined
        }
      >
        {/* Top row: leading badge + primary + trailing */}
        <div className="flex items-start gap-2">
          {leadingBadge && (
            <div className="flex-shrink-0 mt-0.5">{leadingBadge}</div>
          )}
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-1.5 flex-wrap">
              <span className="text-sm font-medium text-gray-900 break-words min-w-0">
                {primary}
              </span>
              {primarySuffix}
            </div>
            {secondary && (
              <div className="text-xs text-gray-600 mt-0.5 truncate">
                {secondary}
              </div>
            )}
            {meta && (
              <div className="text-[11px] text-gray-400 mt-0.5 flex items-center gap-1.5 flex-wrap">
                {meta}
              </div>
            )}
          </div>
          {trailing && (
            <div
              className="flex-shrink-0"
              onClick={(e) => e.stopPropagation()}
            >
              {trailing}
            </div>
          )}
        </div>

        {/* Chip strip */}
        {chips && (
          <div
            className="mt-2 flex items-center gap-1.5 flex-wrap"
            onClick={(e) => e.stopPropagation()}
          >
            {chips}
          </div>
        )}
      </div>

      {expanded && children && (
        <div className="border-t border-gray-100 bg-gray-50">{children}</div>
      )}
    </div>
  );
}
