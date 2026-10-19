/**
 * Countdown — date + colour-coded relative countdown chip, used on the Carnet
 * overview + detail ("Needed by" / "Return by"). Green > 7 days out, amber
 * within 7 days, red once overdue.
 */
export default function Countdown({ date, label }: { date: string | null; label?: string }) {
  if (!date) return <span className="text-gray-400">—</span>;
  const d = new Date(date);
  if (Number.isNaN(d.getTime())) return <span className="text-gray-400">—</span>;
  const days = Math.ceil((d.getTime() - Date.now()) / 86_400_000);
  const colour = days < 0 ? 'text-red-600' : days <= 7 ? 'text-amber-600' : 'text-green-600';
  const rel = days === 0 ? 'today' : days < 0 ? `${Math.abs(days)}d ago` : `in ${days}d`;
  return (
    <span className="whitespace-nowrap">
      {label && <span className="text-gray-400 text-xs mr-1">{label}</span>}
      <span className="text-gray-700">{d.toLocaleDateString('en-GB')}</span>{' '}
      <span className={`text-xs font-medium ${colour}`}>· {rel}</span>
    </span>
  );
}
