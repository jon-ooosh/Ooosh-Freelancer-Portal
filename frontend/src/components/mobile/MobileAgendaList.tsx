import { ReactNode } from 'react';

/**
 * Day-grouped vertical list. Each day gets a sticky header; under each
 * header the items render via the consumer's `renderItem` (typically a
 * MobileListCard). Used by Transport Ops calendar mobile reflow and any
 * future "schedule by day" view (Returns, Going Out Today, etc.).
 */
export interface AgendaDay<T> {
  dateKey: string;
  label: string;
  sublabel?: string;
  items: T[];
}

export interface MobileAgendaListProps<T> {
  days: AgendaDay<T>[];
  renderItem: (item: T) => ReactNode;
  emptyLabel?: string;
}

export function MobileAgendaList<T>({
  days,
  renderItem,
  emptyLabel = 'No items in this period.',
}: MobileAgendaListProps<T>) {
  const total = days.reduce((s, d) => s + d.items.length, 0);
  if (total === 0) {
    return (
      <div className="text-center py-12 text-gray-400 text-sm">{emptyLabel}</div>
    );
  }

  return (
    <div className="bg-white rounded-lg border border-gray-200 overflow-hidden">
      {days
        .filter((d) => d.items.length > 0)
        .map((day) => (
          <div key={day.dateKey}>
            <div className="sticky top-0 z-10 bg-gray-100 border-b border-gray-200 px-3 py-2 flex items-baseline justify-between">
              <h3 className="text-sm font-semibold text-gray-700">{day.label}</h3>
              <span className="text-[11px] text-gray-500 font-medium">
                {day.sublabel ? `${day.sublabel} · ` : ''}
                {day.items.length} item{day.items.length === 1 ? '' : 's'}
              </span>
            </div>
            <div className="divide-y divide-gray-100">
              {day.items.map((item, i) => (
                <div key={i}>{renderItem(item)}</div>
              ))}
            </div>
          </div>
        ))}
    </div>
  );
}
