import { Link } from 'react-router-dom';
import type { DashboardSectionProps } from '../sections';
import { Card, SectionHd } from '../primitives';

/**
 * "On Today / Tomorrow" — the home for ad-hoc to-dos that don't belong to a
 * hire, prep, or compliance check and otherwise fall through the cracks.
 *
 * Seeded from storage access requests (data.on_today). To add another source,
 * union it into the `on_today` payload in backend routes/dashboard.ts — the
 * item shape (source/id/title/detail/due/href) is generic on purpose.
 *
 * Hidden entirely when there's nothing due, so it never adds noise.
 */
function dueLabel(due: string | null): { text: string; tone: string } {
  if (!due) return { text: 'No date', tone: 'bg-slate-100 text-slate-600' };
  const d = new Date(due);
  const today = new Date(new Date().toISOString().slice(0, 10));
  const diff = Math.round((d.getTime() - today.getTime()) / 86400000);
  if (diff < 0) return { text: 'Overdue', tone: 'bg-red-100 text-red-700' };
  if (diff === 0) return { text: 'Today', tone: 'bg-amber-100 text-amber-700' };
  if (diff === 1) return { text: 'Tomorrow', tone: 'bg-blue-100 text-blue-700' };
  return { text: d.toLocaleDateString('en-GB'), tone: 'bg-slate-100 text-slate-600' };
}

export default function OnToday({ data }: DashboardSectionProps) {
  const items = data.on_today ?? [];
  if (items.length === 0) return null;

  return (
    <Card as="section">
      <SectionHd
        eyebrow="To do"
        title="On Today / Tomorrow"
        sub="Ad-hoc tasks — collections, access, one-offs"
      />
      <div>
        {items.map((it) => {
          const due = dueLabel(it.due);
          return (
            <Link
              key={`${it.source}-${it.id}`}
              to={it.href}
              className="flex items-center gap-3 py-2.5 border-t hover:bg-slate-50 transition px-1 -mx-1 rounded"
              style={{ borderColor: 'var(--op-border)' }}
            >
              <span className={`text-xs font-medium px-2 py-0.5 rounded whitespace-nowrap ${due.tone}`}>{due.text}</span>
              <span className="flex-1 min-w-0">
                <span className="block text-sm font-medium text-gray-900 truncate">{it.title}</span>
                {it.detail && <span className="block text-xs text-gray-500 truncate">{it.detail}</span>}
              </span>
              <span className="text-gray-300 text-sm">→</span>
            </Link>
          );
        })}
      </div>
    </Card>
  );
}
