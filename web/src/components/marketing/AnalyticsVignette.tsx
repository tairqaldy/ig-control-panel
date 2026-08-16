/* Analytics vignette: three KPI numbers counting up and a small follower / reach chart drawing itself once the card
   scrolls into view. Sample numbers (labelled as such, like the app's demo mode) — nobody's real account. */
import { useMemo, useRef } from 'react';
import { useInView, useReducedMotion } from 'motion/react';
import { TrendingUp } from 'lucide-react';
import { cn } from '../../lib/utils';
import { useTimeline } from './hooks';

const DAYS = 30, W = 320, H = 96, PAD = 4;
const DUR = 2200;
const easeOut = (x: number) => 1 - Math.pow(1 - x, 3);

// deterministic sample series: followers drift up with a bump; reach is spikier
function series() {
  const followers: number[] = []; const reach: number[] = [];
  let f = 4620;
  for (let i = 0; i < DAYS; i++) {
    f += 3 + Math.round(4 * Math.sin(i / 3.1) + (i === 17 ? 38 : 0) + (i > 22 ? 6 : 0));
    followers.push(f);
    reach.push(Math.round(900 + 420 * Math.abs(Math.sin(i / 2.3)) + (i === 17 ? 2600 : 0) + (i === 25 ? 1400 : 0) + 260 * Math.sin(i / 1.3)));
  }
  return { followers, reach };
}
function toPath(vals: number[], w: number, h: number, pad: number, area = false) {
  const min = Math.min(...vals), max = Math.max(...vals);
  const x = (i: number) => pad + (i / (vals.length - 1)) * (w - pad * 2);
  const y = (v: number) => h - pad - ((v - min) / Math.max(1, max - min)) * (h - pad * 2);
  const d = vals.map((v, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ');
  return area ? `${d} L${x(vals.length - 1).toFixed(1)},${h} L${x(0).toFixed(1)},${h} Z` : d;
}

export function AnalyticsVignette({ className }: { className?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const inView = useInView(ref, { amount: 0.5, once: true });
  const reduced = !!useReducedMotion();
  const t = useTimeline(inView, DUR, { reduced, loop: false });
  const p = easeOut(Math.min(1, t / (DUR - 400)));
  const { followers, reach } = useMemo(series, []);
  const paths = useMemo(() => ({ f: toPath(followers, W, H, PAD), r: toPath(reach, W, H, PAD, true), rl: toPath(reach, W, H, PAD) }), [followers, reach]);
  const kpi = (v: number) => Math.round(v * p).toLocaleString();
  const totalReach = reach.reduce((a, b) => a + b, 0);
  const delta = followers[DAYS - 1] - followers[0];

  return (
    <div ref={ref} role="img" className={cn('mk-dark card p-4 text-[13px]', className)} aria-label="Analytics: followers, reach and saves for the last 30 days, with a chart">
      <div className="flex items-center justify-between mb-3">
        <div className="eyebrow">Analytics · last 30 days</div>
        <span className="font-mono text-[10px] uppercase tracking-wider text-warn bg-warn-soft rounded px-1.5 py-0.5">Sample</span>
      </div>
      <div className="grid grid-cols-3 gap-2">
        {[
          ['Followers', kpi(followers[DAYS - 1]), `+${kpi(delta)}`],
          ['Reach', kpi(totalReach), 'accounts'],
          ['Saves', kpi(612), 'on 14 posts'],
        ].map(([l, v, h]) => (
          <div key={l} className="rounded-xl border border-line bg-surface-2 px-3 py-2 min-w-0">
            <div className="eyebrow !text-[9.5px]">{l}</div>
            <div className="display text-[22px] leading-none tabular mt-1">{v}</div>
            <div className={cn('text-[10.5px] mt-1 truncate', l === 'Followers' ? 'text-accent' : 'text-muted')}>{h}</div>
          </div>
        ))}
      </div>
      <div className="mt-3 rounded-xl border border-line bg-surface-2 p-3">
        <div className="flex items-center gap-3 text-[10.5px] text-muted mb-1.5">
          <span className="inline-flex items-center gap-1.5"><span className="h-1.5 w-3 rounded-full bg-accent" /> followers</span>
          <span className="inline-flex items-center gap-1.5"><span className="h-1.5 w-3 rounded-full bg-[oklch(0.7_0.1_60)]" /> reach</span>
        </div>
        <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-auto block" role="img" aria-hidden>
          <defs>
            <linearGradient id="mk-reach" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stopColor="oklch(0.7 0.1 60)" stopOpacity="0.35" /><stop offset="1" stopColor="oklch(0.7 0.1 60)" stopOpacity="0" /></linearGradient>
            <clipPath id="mk-reveal"><rect x="0" y="0" width={W * p} height={H} /></clipPath>
          </defs>
          <g clipPath="url(#mk-reveal)">
            <path d={paths.r} fill="url(#mk-reach)" />
            <path d={paths.rl} fill="none" stroke="oklch(0.7 0.1 60)" strokeWidth="1.25" strokeLinejoin="round" />
          </g>
          <path d={paths.f} fill="none" stroke="var(--accent)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" pathLength={1} strokeDasharray={1} strokeDashoffset={1 - p} />
        </svg>
      </div>
      <div className={cn('mt-3 flex items-center gap-1.5 text-[11.5px] text-ink-2 transition-opacity duration-500', p > 0.9 ? 'opacity-100' : 'opacity-0')}><TrendingUp size={12} className="text-accent" /> Best time to post: Tuesday around 19:00 · reels get 2.4× the saves of images</div>
    </div>
  );
}
