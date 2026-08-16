import { useId, useMemo, useState } from 'react';
import { cn } from '../../lib/utils';
import { useMeasure } from './useMeasure';

export interface AreaChartProps {
  /** x labels, one per point ('YYYY-MM-DD') */
  days: string[];
  values: Array<number | null | undefined>;
  height?: number;
  /** value formatter for axis + tooltip */
  format?: (v: number) => string;
  /** 'accent' (jade) or 'ink' (neutral) */
  tone?: 'accent' | 'ink';
  /** start the y-axis at zero (reach) or at the series minimum (followers) */
  fromZero?: boolean;
  className?: string;
  /** label above the tooltip value ("Followers") */
  label?: string;
}

const PAD = { top: 10, right: 12, bottom: 20, left: 46 };

function fmtDay(d: string): string {
  const dt = new Date(`${d}T00:00:00`);
  return Number.isNaN(dt.getTime()) ? d : dt.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}
function fmtDayLong(d: string): string {
  const dt = new Date(`${d}T00:00:00`);
  return Number.isNaN(dt.getTime()) ? d : dt.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
}
function niceTicks(min: number, max: number, n = 3): number[] {
  if (!(max > min)) return [min];
  const raw = (max - min) / n;
  const p = Math.pow(10, Math.floor(Math.log10(raw)));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * p).find((s) => s >= raw) ?? raw;
  const start = Math.ceil(min / step) * step;
  const out: number[] = [];
  for (let v = start; v <= max + 1e-9; v += step) out.push(Number(v.toFixed(6)));
  return out;
}

/** Axis/tooltip formatter that keeps enough precision for the tick step (12.2K / 12.4K instead of 12K / 12K). */
export function fmtAxis(v: number, step = 0): string {
  const trim = (s: string) => (s.includes('.') ? s.replace(/0+$/, '').replace(/\.$/, '') : s);
  const a = Math.abs(v);
  if (a >= 1_000_000) return `${trim((v / 1_000_000).toFixed(step && step < 100_000 ? 2 : 1))}M`;
  if (a >= 1_000) return `${trim((v / 1_000).toFixed(step && step < 1000 ? (step < 100 ? 2 : 1) : 0))}K`;
  return Math.round(v).toLocaleString();
}

/**
 * Single-series area chart, hand-rolled SVG: 1.5px line, jade gradient fill, recessive grid, crosshair + tooltip on hover.
 * Null values break the line (no interpolation across gaps).
 */
export function AreaChart({ days, values, height = 160, format, tone = 'accent', fromZero = false, className, label }: AreaChartProps) {
  const [ref, width] = useMeasure<HTMLDivElement>();
  const uid = useId().replace(/:/g, '');
  const [hover, setHover] = useState<number | null>(null);

  const model = useMemo(() => {
    const W = Math.max(0, width);
    const H = height;
    const iw = Math.max(1, W - PAD.left - PAD.right);
    const ih = Math.max(1, H - PAD.top - PAD.bottom);
    const nums = values.map((v) => (v === null || v === undefined || !Number.isFinite(v) ? null : Number(v)));
    const present = nums.filter((v): v is number => v !== null);
    let min = present.length ? Math.min(...present) : 0;
    let max = present.length ? Math.max(...present) : 1;
    if (fromZero) min = Math.min(0, min);
    if (max === min) { max = min + (Math.abs(min) || 1) * 0.1; min = fromZero ? 0 : min - (Math.abs(min) || 1) * 0.1; }
    // a little headroom so the line never kisses the top edge
    const span = max - min; max += span * 0.08; if (!fromZero) min -= span * 0.08;
    const n = nums.length;
    const x = (i: number) => PAD.left + (n <= 1 ? iw / 2 : (i / (n - 1)) * iw);
    const y = (v: number) => PAD.top + ih - ((v - min) / (max - min)) * ih;
    // segments (break on null)
    const segs: Array<Array<[number, number, number]>> = [];
    let cur: Array<[number, number, number]> = [];
    nums.forEach((v, i) => { if (v === null) { if (cur.length) segs.push(cur); cur = []; } else cur.push([x(i), y(v), i]); });
    if (cur.length) segs.push(cur);
    const linePath = segs.map((s) => s.map(([px, py], k) => `${k ? 'L' : 'M'}${px.toFixed(1)},${py.toFixed(1)}`).join('')).join('');
    const base = PAD.top + ih;
    const areaPath = segs.map((s) => `M${s[0][0].toFixed(1)},${base}` + s.map(([px, py]) => `L${px.toFixed(1)},${py.toFixed(1)}`).join('') + `L${s[s.length - 1][0].toFixed(1)},${base}Z`).join('');
    const ticks = niceTicks(min, max, 3).filter((t) => t >= min && t <= max);
    const step = ticks.length > 1 ? ticks[1] - ticks[0] : max - min;
    return { W, H, iw, ih, nums, min, max, x, y, linePath, areaPath, ticks, base, n, step };
  }, [values, width, height, fromZero]);
  const fmt = format ?? ((v: number) => fmtAxis(v, model.step));

  const onMove = (e: React.MouseEvent<SVGSVGElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const px = e.clientX - rect.left;
    const { n, iw } = model;
    if (n === 0) return;
    const i = n <= 1 ? 0 : Math.round(((px - PAD.left) / iw) * (n - 1));
    setHover(Math.max(0, Math.min(n - 1, i)));
  };

  const stroke = tone === 'accent' ? 'var(--accent)' : 'var(--ink-2)';
  const hv = hover !== null ? model.nums[hover] : null;
  // x labels: 3 on narrow charts, up to 5 when there is room (≈ one per 110px), always first + last
  const xCount = model.n <= 1 ? 1 : Math.max(2, Math.min(5, Math.floor(model.iw / 110) + 1, model.n));
  const xIdx = model.n > 0 ? Array.from({ length: xCount }, (_, k) => Math.round((k / Math.max(1, xCount - 1)) * (model.n - 1))).filter((v, i, a) => a.indexOf(v) === i) : [];

  return (
    <div ref={ref} className={cn('relative w-full select-none', className)} style={{ height }}>
      {model.W > 0 && (
        <svg width={model.W} height={model.H} onMouseMove={onMove} onMouseLeave={() => setHover(null)} className="block overflow-visible" role="img" aria-label={label ? `${label} over time` : 'Chart'}>
          <defs>
            <linearGradient id={`g-${uid}`} x1="0" x2="0" y1="0" y2="1">
              <stop offset="0%" stopColor={stroke} stopOpacity={0.22} />
              <stop offset="100%" stopColor={stroke} stopOpacity={0.02} />
            </linearGradient>
          </defs>
          {/* grid + y labels */}
          {model.ticks.map((t) => (
            <g key={t}>
              <line x1={PAD.left} x2={model.W - PAD.right} y1={model.y(t)} y2={model.y(t)} stroke="var(--line)" strokeDasharray="2 3" />
              <text x={PAD.left - 8} y={model.y(t)} dy="0.35em" textAnchor="end" fontSize={10.5} fill="var(--muted)" className="font-mono tabular">{fmt(t)}</text>
            </g>
          ))}
          <line x1={PAD.left} x2={model.W - PAD.right} y1={model.base} y2={model.base} stroke="var(--line-2)" />
          {/* x labels */}
          {xIdx.map((i) => (
            <text key={i} x={model.x(i)} y={model.H - 5} textAnchor={i === 0 ? 'start' : i === model.n - 1 ? 'end' : 'middle'} fontSize={10.5} fill="var(--muted)" className="font-mono tabular">{fmtDay(days[i] ?? '')}</text>
          ))}
          {/* series */}
          <path d={model.areaPath} fill={`url(#g-${uid})`} />
          <path d={model.linePath} fill="none" stroke={stroke} strokeWidth={1.5} strokeLinejoin="round" strokeLinecap="round" />
          {/* last point */}
          {model.n > 0 && model.nums[model.n - 1] !== null && hover === null && (
            <circle cx={model.x(model.n - 1)} cy={model.y(model.nums[model.n - 1] as number)} r={3} fill={stroke} stroke="var(--surface)" strokeWidth={2} />
          )}
          {/* hover */}
          {hover !== null && hv !== null && (
            <g>
              <line x1={model.x(hover)} x2={model.x(hover)} y1={PAD.top} y2={model.base} stroke="var(--line-2)" />
              <circle cx={model.x(hover)} cy={model.y(hv)} r={4} fill={stroke} stroke="var(--surface)" strokeWidth={2} />
            </g>
          )}
        </svg>
      )}
      {hover !== null && hv !== null && model.W > 0 && (
        <div className="pointer-events-none absolute z-10 rounded-lg border border-line bg-surface px-2.5 py-1.5 text-[11.5px] leading-tight" style={{ left: Math.min(Math.max(model.x(hover) - 60, 0), Math.max(0, model.W - 130)), top: Math.max(0, model.y(hv) - 48), boxShadow: 'var(--shadow)' }}>
          {label && <div className="eyebrow !text-[9.5px] !tracking-[0.1em]">{label}</div>}
          <div className="font-mono tabular text-[13px] text-ink">{Math.round(hv).toLocaleString()}</div>
          <div className="text-muted">{fmtDayLong(days[hover] ?? '')}</div>
        </div>
      )}
    </div>
  );
}
