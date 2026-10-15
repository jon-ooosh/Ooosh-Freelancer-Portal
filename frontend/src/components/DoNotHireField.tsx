import { useAuthStore } from '../hooks/useAuthStore';
import { hasManagerRole } from '../lib/roles';

/**
 * "Do not hire" switch in the Edit panel's Working Terms section (Organisation
 * and Person forms). It sits next to Payment Terms because that's where staff
 * went looking when they needed to flag a client — moved here from its own
 * header button, Oct 2026.
 *
 * Manager-tier only (matches POST /…/do-not-hire). The form saves it through
 * that endpoint, not the general PUT, so who set it and when stay recorded.
 * Edit mode only — the endpoint needs the record to exist.
 */
export interface DoNotHireValue {
  on: boolean;
  reason: string;
}

export default function DoNotHireField({ value, onChange }: {
  value: DoNotHireValue;
  onChange: (v: DoNotHireValue) => void;
}) {
  const user = useAuthStore((s) => s.user);
  if (!hasManagerRole(user?.role)) return null;

  return (
    <div className={`rounded border px-3 py-2 ${value.on ? 'border-red-200 bg-red-50' : 'border-gray-200'}`}>
      <label className="flex items-center gap-2 cursor-pointer text-sm">
        <input
          type="checkbox"
          checked={value.on}
          onChange={(e) => onChange({ ...value, on: e.target.checked })}
          className="rounded border-gray-300 text-red-600 focus:ring-red-500"
        />
        <span className={value.on ? 'font-semibold text-red-700' : 'text-gray-700'}>Do not hire</span>
        <span className="text-xs text-gray-400">(managers)</span>
      </label>
      {value.on && (
        <input
          value={value.reason}
          onChange={(e) => onChange({ ...value, reason: e.target.value })}
          placeholder="Reason, e.g. still has the Nord Triple pedal"
          className="mt-2 w-full rounded border border-red-200 px-3 py-1.5 text-sm focus:border-red-400 focus:outline-none focus:ring-1 focus:ring-red-400"
        />
      )}
      {value.on && (
        <p className="mt-1 text-xs text-red-600">Shows a red Do Not Hire warning on enquiries and jobs. Payment terms above are kept, shown as on hold.</p>
      )}
    </div>
  );
}

/** Save a changed DNH value through its own endpoint. No-op when nothing changed. */
export async function saveDoNotHireIfChanged(
  post: (url: string, body: unknown) => Promise<unknown>,
  url: string,
  original: DoNotHireValue,
  current: DoNotHireValue,
): Promise<void> {
  const reason = current.reason.trim();
  if (original.on === current.on && (!current.on || original.reason.trim() === reason)) return;
  await post(url, { do_not_hire: current.on, reason: current.on ? (reason || null) : null });
}
