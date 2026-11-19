/**
 * A meter's use per week between readings — one bar per gap, the latest
 * darkest. The numbers come from the server (premises-rules.ts usageSeries);
 * this only draws them, to one scale.
 */
import { UsageInterval, fmtDate, fmtNumber } from './premisesCopy';

export default function UsageChart({ usage, unit, height = 120 }: { usage: UsageInterval[]; unit: string | null; height?: number }) {
  const bars = usage.slice(-12);
  if (bars.length === 0) {
    return <p className="text-xs text-gray-500">The chart starts after two readings.</p>;
  }
  // Room above the bars for the scale label, below for the dates.
  const W = 320, top = 16, bottom = 18, left = 4;
  const plot = height - top - bottom;
  const max = Math.max(...bars.map(b => Math.max(0, b.per_week)), 1);
  const step = (W - left * 2) / bars.length;
  const bw = Math.max(4, Math.min(24, step * 0.65));
  return (
    <svg viewBox={`0 0 ${W} ${height}`} className="w-full" role="img"
      aria-label={`Use per week for the last ${bars.length} readings${unit ? `, in ${unit}` : ''}`}>
      <line x1={left} x2={W - left} y1={top + plot} y2={top + plot} stroke="#e5e7eb" />
      {bars.map((b, i) => {
        const h = (Math.max(0, b.per_week) / max) * plot;
        const x = left + i * step + (step - bw) / 2;
        const last = i === bars.length - 1;
        return (
          <g key={`${b.from}-${b.to}`}>
            <rect x={x} y={top + plot - h} width={bw} height={h} rx={2} fill={last ? '#0074c6' : '#7cc8fb'}>
              <title>{`${fmtDate(b.from)} – ${fmtDate(b.to)}: ${fmtNumber(b.used)}${unit ? ` ${unit}` : ''} (${fmtNumber(b.per_week)} a week)`}</title>
            </rect>
            {(i === 0 || last) && (
              <text x={x + bw / 2} y={height - 4} textAnchor="middle" fontSize="9" fill="#6b7280">
                {fmtDate(b.to).replace(/ \d{4}$/, '')}
              </text>
            )}
          </g>
        );
      })}
      <text x={left} y={10} textAnchor="start" fontSize="9" fill="#6b7280">
        max {fmtNumber(max)}{unit ? ` ${unit}` : ''}/wk
      </text>
    </svg>
  );
}
