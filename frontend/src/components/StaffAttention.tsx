/**
 * "Needs attention" — the top of the Staff page.
 *
 * The staff area was organised person → topic, but nearly every real question
 * runs the other way: whose review is due, what's expiring, who is missing
 * right to work. This is the surface that answers those without opening seven
 * people in turn.
 *
 * Every row is DERIVED server-side (services/staff-attention.ts). Nothing here
 * is a flag somebody has to clear, so the list cannot go stale or lie.
 *
 * Each row links into the person view on the tab that answers it — which is
 * why the person view has a real URL rather than being accordion state.
 */

export interface AttentionItem {
  id: string;
  severity: 'urgent' | 'soon' | 'info';
  kind: string;
  label: string;
  detail?: string | null;
  personId?: string | null;
  personName?: string | null;
  tab?: string | null;
  action?: string | null;
}

const DOT: Record<string, string> = {
  urgent: 'bg-red-600',
  soon: 'bg-amber-500',
  info: 'bg-gray-400',
};

// A date detail is rendered as a date; anything else is free text. Cheaper and
// clearer than a second field saying which it is.
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function fmtDetail(detail: string | null | undefined): string {
  if (!detail) return '';
  if (!DATE_RE.test(detail)) return detail;
  return new Date(detail).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
}

/**
 * Presentational on purpose: the PAGE owns the fetch, because the same derived
 * list feeds three surfaces — this panel, the flags on each roster row, and
 * the person view's own "needs attention" box. Fetching in here would leave
 * the other two empty whenever this panel is not on screen, which is exactly
 * what happens when a notification deep-links straight into a person.
 */
export default function StaffAttention({ items, loading, loadError, onOpenPerson, onLinkLogin }: {
  items: AttentionItem[];
  loading: boolean;
  loadError: string | null;
  onOpenPerson: (personId: string, tab?: string) => void;
  onLinkLogin: () => void;
}) {
  const urgent = items.filter(i => i.severity === 'urgent').length;
  const soon = items.filter(i => i.severity === 'soon').length;

  if (loading) {
    return (
      <div className="bg-white rounded-lg border border-gray-200 px-4 py-3 text-sm text-gray-500">
        Checking what needs attention…
      </div>
    );
  }

  if (loadError) {
    return (
      <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">
        Couldn’t work out what needs attention — {loadError}
      </div>
    );
  }

  if (items.length === 0) {
    return (
      <div className="bg-white rounded-lg border border-gray-200 px-4 py-3">
        <span className="text-sm font-medium text-gray-900">Nothing needs attention</span>
        <span className="text-sm text-gray-500"> — no expiring documents, reviews due or missing records.</span>
      </div>
    );
  }

  return (
    <div className="bg-white rounded-lg border border-gray-200 overflow-hidden">
      <div className="flex flex-wrap items-center gap-2 px-4 py-3 border-b border-gray-100">
        <h2 className="text-sm font-semibold text-gray-900">Needs attention</h2>
        {urgent > 0 && (
          <span className="text-xs font-semibold text-red-800 bg-red-100 rounded-full px-2 py-0.5">
            {urgent} urgent
          </span>
        )}
        {soon > 0 && (
          <span className="text-xs font-semibold text-amber-800 bg-amber-100 rounded-full px-2 py-0.5">
            {soon} soon
          </span>
        )}
        <span className="ml-auto text-xs text-gray-500">
          All worked out from what’s recorded — nothing to keep up to date by hand
        </span>
      </div>

      <ul className="divide-y divide-gray-100">
        {items.map(item => (
          <li key={item.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2.5">
            <span className={`w-2 h-2 rounded-full shrink-0 ${DOT[item.severity]}`} aria-hidden="true" />
            <span className="text-sm text-gray-900 min-w-[13rem]">{item.label}</span>
            {item.personId ? (
              <button
                onClick={() => onOpenPerson(item.personId!, item.tab ?? undefined)}
                className="text-sm font-medium text-ooosh-700 hover:text-ooosh-900 hover:underline"
              >
                {item.personName || 'Unnamed'}
              </button>
            ) : null}
            {item.detail && (
              <span className="text-xs text-gray-500">{fmtDetail(item.detail)}</span>
            )}
            <button
              onClick={() => item.personId ? onOpenPerson(item.personId, item.tab ?? undefined) : onLinkLogin()}
              className="ml-auto text-xs font-medium text-ooosh-600 hover:text-ooosh-800 hover:underline shrink-0"
            >
              {item.action || 'Open'}
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
