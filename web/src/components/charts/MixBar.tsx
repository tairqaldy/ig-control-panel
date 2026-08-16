import { cn } from '../../lib/utils';

export interface MixSegment { key: string; label: string; value: number; /** CSS color; defaults step down the jade ramp by index */ color?: string }

/** One horizontal segmented bar (share of total) + legend with counts. Segments separated by a 2px surface gap; identity by label + swatch, never color alone. */
export function MixBar({ segments, className, height = 12 }: { segments: MixSegment[]; className?: string; height?: number }) {
  const total = segments.reduce((s, x) => s + Math.max(0, x.value), 0);
  const ramp = ['var(--accent)', 'color-mix(in oklab, var(--accent) 55%, var(--surface-2))', 'color-mix(in oklab, var(--accent) 25%, var(--surface-2))', 'var(--line-2)'];
  return (
    <div className={className}>
      <div className="flex w-full overflow-hidden rounded-full bg-surface-2" style={{ height, gap: 2 }}>
        {segments.map((s, i) => {
          const pct = total ? (Math.max(0, s.value) / total) * 100 : 0;
          return pct > 0 ? <div key={s.key} title={`${s.label} · ${s.value} · ${Math.round(pct)}%`} className="h-full rounded-full transition-[width] duration-500" style={{ width: `${pct}%`, background: s.color || ramp[i % ramp.length] }} /> : null;
        })}
      </div>
      <div className="mt-2.5 flex flex-wrap gap-x-4 gap-y-1.5 text-[12px]">
        {segments.map((s, i) => {
          const pct = total ? Math.round((Math.max(0, s.value) / total) * 100) : 0;
          return (
            <span key={s.key} className={cn('inline-flex items-center gap-1.5', s.value === 0 && 'text-muted')}>
              <span className="h-2.5 w-2.5 rounded-[3px] shrink-0" style={{ background: s.color || ramp[i % ramp.length] }} />
              <span className="text-ink-2">{s.label}</span>
              <span className="font-mono tabular text-muted">{s.value} · {pct}%</span>
            </span>
          );
        })}
      </div>
    </div>
  );
}
