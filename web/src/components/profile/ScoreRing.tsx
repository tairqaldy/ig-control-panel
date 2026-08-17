/* The overall number, drawn as a ring. Colour follows the score, not the brand, so a weak profile looks weak. */
import { motion } from 'motion/react';
import { TONE_STROKE, TONE_TEXT, scoreTone } from '../../lib/types-profile';
import { cn } from '../../lib/utils';

export function ScoreRing({ score, size = 152, stroke = 10, className }: {
  score: number | null;
  size?: number;
  stroke?: number;
  className?: string;
}) {
  const tone = scoreTone(score);
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const pct = score === null ? 0 : Math.max(0, Math.min(100, score)) / 100;
  return (
    <div className={cn('relative shrink-0 grid place-items-center', className)} style={{ width: size, height: size }}>
      <svg width={size} height={size} className="-rotate-90" aria-hidden>
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="var(--line)" strokeWidth={stroke} />
        <motion.circle
          cx={size / 2} cy={size / 2} r={r} fill="none" stroke={TONE_STROKE[tone]} strokeWidth={stroke} strokeLinecap="round"
          strokeDasharray={c}
          initial={{ strokeDashoffset: c }}
          animate={{ strokeDashoffset: c * (1 - pct) }}
          transition={{ type: 'spring', stiffness: 60, damping: 18 }}
        />
      </svg>
      <div className="absolute inset-0 grid place-items-center text-center px-2">
        <div className={cn('display leading-none tabular', TONE_TEXT[tone])} style={{ fontSize: size * 0.31 }}>
          {score === null ? '—' : score}
          {score !== null && <span className="text-muted" style={{ fontSize: size * 0.12 }}>/100</span>}
        </div>
      </div>
    </div>
  );
}

/** "+7 since 12 Aug" — the reason to come back next week. */
export function ScoreDelta({ delta, className }: { delta: number | null; className?: string }) {
  if (delta === null || delta === 0) return null;
  const up = delta > 0;
  return (
    <span className={cn('inline-flex items-center gap-0.5 rounded-md px-1.5 py-0.5 font-mono text-[11.5px] tabular', up ? 'text-accent bg-accent-soft' : 'text-danger bg-danger-soft', className)}>
      {up ? '+' : ''}{delta}
    </span>
  );
}
