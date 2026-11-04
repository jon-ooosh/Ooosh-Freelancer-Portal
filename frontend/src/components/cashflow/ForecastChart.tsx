/**
 * The cash forecast's chart: closing balance per week (or per day), against
 * the target line and the overdraft limit. Plain SVG — the page needs one line
 * and two thresholds, not a chart library.
 */
import { gbp, shortDate } from '../../lib/cashflow';

interface Props {
  points: Array<{ date: string; closing: number }>;
  target: number;
  overdraftLimit: number;   // positive £; drawn at minus this
  selected: number | null;
  onSelect: (index: number) => void;
}

const W = 900;
const H = 300;
const L = 64;
const R = 14;
const T = 16;
const B = 32;

function niceStep(range: number): number {
  const raw = range / 5;
  const pow = Math.pow(10, Math.floor(Math.log10(Math.max(raw, 1))));
  const n = raw / pow;
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * pow;
}

const axisLabel = (v: number) => {
  if (v === 0) return '£0';
  const k = Math.abs(v) >= 1000 ? `${Math.round(Math.abs(v) / 1000)}k` : String(Math.abs(Math.round(v)));
  return `${v < 0 ? '−' : ''}£${k}`;
};

export default function ForecastChart({ points, target, overdraftLimit, selected, onSelect }: Props) {
  if (points.length === 0) return null;
  const limit = -Math.abs(overdraftLimit);
  const values = [...points.map((p) => p.closing), target, limit, 0];
  const step = niceStep(Math.max(...values) - Math.min(...values) || 1000);
  const yMin = Math.floor(Math.min(...values) / step) * step - step / 2;
  const yMax = Math.ceil(Math.max(...values) / step) * step + step / 2;
  const x = (i: number) => L + ((W - L - R) * (i + 0.5)) / points.length;
  const y = (v: number) => T + ((H - T - B) * (yMax - v)) / (yMax - yMin);
  const lowIdx = points.reduce((lo, p, i) => (p.closing < points[lo].closing ? i : lo), 0);
  const ticks: number[] = [];
  for (let v = Math.ceil(yMin / step) * step; v <= yMax; v += step) ticks.push(v);
  const labelEvery = points.length > 14 ? 2 : 1;
  const colourFor = (v: number) => (v < limit ? '#b91c1c' : v < target ? '#b45309' : '#0074c6');

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-auto" role="img" aria-label="Forecast closing balance">
      {ticks.map((v) => (
        <g key={v}>
          <line x1={L} x2={W - R} y1={y(v)} y2={y(v)} stroke="#f3f4f6" />
          <text x={L - 8} y={y(v) + 4} textAnchor="end" fontSize="11" fill="#9ca3af">{axisLabel(v)}</text>
        </g>
      ))}
      <line x1={L} x2={W - R} y1={y(target)} y2={y(target)} stroke="#d97706" strokeWidth="1.5" strokeDasharray="5 4" />
      <text x={L + 4} y={y(target) - 5} textAnchor="start" fontSize="11" fill="#b45309">Target {axisLabel(target)}</text>
      <line x1={L} x2={W - R} y1={y(limit)} y2={y(limit)} stroke="#b91c1c" strokeWidth="1.5" strokeDasharray="5 4" />
      <text x={L + 4} y={y(limit) - 5} textAnchor="start" fontSize="11" fill="#b91c1c">Overdraft limit {axisLabel(limit)}</text>

      {selected !== null && selected < points.length && (
        <rect x={x(selected) - (W - L - R) / points.length / 2} y={T} width={(W - L - R) / points.length} height={H - T - B} fill="#e0effe" opacity="0.6" />
      )}
      <path
        d={`M${points.map((p, i) => `${x(i)},${y(p.closing)}`).join(' L')}`}
        fill="none" stroke="#0074c6" strokeWidth="2.5" strokeLinejoin="round"
      />
      {points.map((p, i) => (
        <g key={p.date} onClick={() => onSelect(i)} style={{ cursor: 'pointer' }}>
          <rect x={x(i) - (W - L - R) / points.length / 2} y={T} width={(W - L - R) / points.length} height={H - T - B} fill="transparent" />
          <circle cx={x(i)} cy={y(p.closing)} r={i === lowIdx ? 5 : 3.5} fill={colourFor(p.closing)} stroke="#fff" strokeWidth="1.5" />
          <title>{`${shortDate(p.date, true)}: ${gbp(p.closing)}`}</title>
        </g>
      ))}
      <text x={x(lowIdx)} y={Math.min(y(points[lowIdx].closing) + 20, H - B - 4)} textAnchor="middle" fontSize="12" fontWeight="700" fill={colourFor(points[lowIdx].closing)}>
        {gbp(points[lowIdx].closing)}
      </text>
      {points.map((p, i) => (i % labelEvery === 0 ? (
        <text key={`l${p.date}`} x={x(i)} y={H - 10} textAnchor="middle" fontSize="11"
          fill={i === lowIdx ? '#b45309' : '#6b7280'} fontWeight={i === lowIdx ? 700 : 400}>
          {shortDate(p.date)}
        </text>
      ) : null))}
    </svg>
  );
}
