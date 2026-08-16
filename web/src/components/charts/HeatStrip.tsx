import { useState } from 'react';
import { cn } from '../../lib/utils';

export const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
export const WEEKDAYS_LONG = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
/** 24-hour clock, "19:00" — same everywhere (heat strip, recommendation, Ask prompt). */
export const fmtHour = (h: number) => `${String(((h % 24) + 24) % 24).padStart(2, '0')}:00`;
/** "Tue–Thu" for consecutive weekdays, "Tue, Thu" otherwise. Input: weekday indices (0 = Sunday). */
export function fmtWeekdays(days: number[]): string {
  const d = Array.from(new Set(days.filter((x) => x >= 0 && x < 7))).sort((a, b) => a - b);
  if (!d.length) return '';
  if (d.length === 1) return WEEKDAYS[d[0]];
  const consecutive = d.every((x, i) => i === 0 || x === d[i - 1] + 1);
  return consecutive && d.length >= 3 ? `${WEEKDAYS[d[0]]}–${WEEKDAYS[d[d.length - 1]]}` : d.map((x) => WEEKDAYS[x]).join(', ');
}

/**
 * 7 × 24 heat strip (weekday rows × hour columns). `cells[d][h]` in 0..1; jade at one hue, light → dark (sequential, one hue).
 * `marks[d][h]` = optional count of your own posts in that slot (drawn as a small ring so "when I post" is visible on top of "when it works").
 * Pure CSS grid, no SVG — the cells are 24 per row so they stay crisp at any width.
 */
export function HeatStrip({ cells, marks, best, className }: { cells: number[][]; marks?: number[][]; best?: { day: number; hour: number } | null; className?: string }) {
  const [hover, setHover] = useState<{ d: number; h: number } | null>(null);
  return (
    <div className={cn('select-none', className)}>
      <div className="grid gap-[3px]" style={{ gridTemplateColumns: '34px repeat(24, minmax(0, 1fr))' }}>
        {/* header row */}
        <div />
        {Array.from({ length: 24 }, (_, h) => (
          <div key={h} className="text-center font-mono text-[9px] text-muted leading-none h-3 whitespace-nowrap tabular">{h % 6 === 0 ? fmtHour(h) : ''}</div>
        ))}
        {cells.map((row, d) => (
          <RowFrag key={d} d={d} row={row} marks={marks?.[d]} best={best} hover={hover} setHover={setHover} />
        ))}
      </div>
      <div className="mt-2 flex items-center justify-between text-[11px] text-muted">
        <span className="h-4 tabular">{hover ? <><b className="text-ink font-medium">{WEEKDAYS[hover.d]} {fmtHour(hover.h)}</b> · engagement {Math.round((cells[hover.d]?.[hover.h] ?? 0) * 100)}/100{marks?.[hover.d]?.[hover.h] ? ` · you posted here ${marks[hover.d][hover.h]}×` : ''}</> : 'Hover a cell for its score'}</span>
        <span className="inline-flex items-center gap-1.5">less <span className="inline-flex gap-[2px]">{[0.08, 0.3, 0.55, 0.8, 1].map((o) => <span key={o} className="h-2.5 w-2.5 rounded-[3px]" style={{ background: 'var(--accent)', opacity: o }} />)}</span> more</span>
      </div>
    </div>
  );
}

function RowFrag({ d, row, marks, best, hover, setHover }: { d: number; row: number[]; marks?: number[]; best?: { day: number; hour: number } | null; hover: { d: number; h: number } | null; setHover: (v: { d: number; h: number } | null) => void }) {
  return (
    <>
      <div className="font-mono text-[10px] text-muted leading-none self-center">{WEEKDAYS[d]}</div>
      {Array.from({ length: 24 }, (_, h) => {
        const v = Math.max(0, Math.min(1, row[h] ?? 0));
        const isBest = best && best.day === d && best.hour === h;
        const isHover = hover && hover.d === d && hover.h === h;
        const m = marks?.[h] ?? 0;
        return (
          <div key={h} onMouseEnter={() => setHover({ d, h })} onMouseLeave={() => setHover(null)}
            className={cn('relative aspect-square rounded-[3px] transition-[outline] outline-none', (isBest || isHover) && 'ring-2 ring-ink/70 ring-offset-1 ring-offset-surface z-[1]')}
            style={{ background: v > 0.02 ? `color-mix(in oklab, var(--accent) ${Math.round(8 + v * 92)}%, var(--surface-2))` : 'var(--surface-2)' }}
            title={`${WEEKDAYS[d]} ${fmtHour(h)} · ${Math.round(v * 100)}`}
          >
            {m > 0 && <span className="absolute inset-0 m-auto h-[45%] w-[45%] rounded-full border-[1.5px] border-surface bg-ink/80" />}
          </div>
        );
      })}
    </>
  );
}
