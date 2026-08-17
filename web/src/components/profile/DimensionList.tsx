/* The five dimensions as rows that expand into fixes. Collapsed, a row answers "how bad is it";
   expanded, it answers "what do I change, and what do I paste". */
import { useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { ChevronDown, Copy } from 'lucide-react';
import { toast } from 'sonner';
import { DIMENSION_HINT, DIMENSION_LABEL, EFFORT_LABEL, TONE_BAR, TONE_TEXT, scoreTone, type ProfileDimension, type ProfileFix } from '../../lib/types-profile';
import { cn, copyText } from '../../lib/utils';

function Fix({ fix, index }: { fix: ProfileFix; index: number }) {
  return (
    <li className="flex gap-2.5">
      <span className="mt-[7px] h-1.5 w-1.5 shrink-0 rounded-full bg-accent" />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
          <span className="text-[13.5px] font-medium text-ink leading-snug">{fix.what}</span>
          <span className="chip !py-0.5 !text-[10.5px] font-mono uppercase tracking-wider text-muted">{EFFORT_LABEL[fix.effort]}</span>
        </div>
        {fix.why && <div className="mt-0.5 text-[12.5px] text-muted leading-relaxed">{fix.why}</div>}
        {fix.example && (
          <div className="mt-2 flex items-start gap-2 rounded-lg border border-line bg-surface-2 px-2.5 py-2">
            <span className="flex-1 whitespace-pre-wrap font-mono text-[12px] leading-relaxed text-ink-2">{fix.example}</span>
            <button
              type="button"
              onClick={() => { void copyText(fix.example ?? ''); toast.success('Copied'); }}
              className="btn btn-ghost btn-sm !px-1.5 shrink-0 text-muted"
              aria-label={`Copy the example for fix ${index + 1}`}
            ><Copy size={13} /></button>
          </div>
        )}
      </div>
    </li>
  );
}

function Row({ dim, defaultOpen }: { dim: ProfileDimension; defaultOpen: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  const tone = scoreTone(dim.score);
  const pct = dim.score === null ? 0 : dim.score;
  const hasDetail = !!dim.verdict || dim.fixes.length > 0;
  return (
    <div className="border-b border-line last:border-b-0">
      <button
        type="button"
        onClick={() => hasDetail && setOpen((o) => !o)}
        aria-expanded={hasDetail ? open : undefined}
        className={cn('flex w-full items-center gap-3 px-4 py-3.5 text-left transition-colors', hasDetail ? 'hover:bg-surface-2/60' : 'cursor-default')}
      >
        <div className="min-w-0 flex-1">
          <div className="text-[14px] font-medium text-ink">{DIMENSION_LABEL[dim.id]}</div>
          <div className="mt-0.5 text-[12px] text-muted leading-snug clamp-2">{dim.verdict || DIMENSION_HINT[dim.id]}</div>
        </div>
        <div className="hidden sm:block w-24 shrink-0">
          <div className="h-1.5 rounded-full bg-line overflow-hidden">
            <motion.div className={cn('h-full rounded-full', TONE_BAR[tone])} initial={{ width: 0 }} animate={{ width: `${pct}%` }} transition={{ type: 'spring', stiffness: 70, damping: 20 }} />
          </div>
        </div>
        <div className={cn('w-11 shrink-0 text-right font-mono text-[15px] tabular', TONE_TEXT[tone])}>{dim.score === null ? '—' : dim.score}</div>
        {hasDetail && <ChevronDown size={15} className={cn('shrink-0 text-muted transition-transform', open && 'rotate-180')} />}
      </button>
      <AnimatePresence initial={false}>
        {open && hasDetail && (
          <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }} exit={{ height: 0, opacity: 0 }} transition={{ duration: 0.18 }} className="overflow-hidden">
            <div className="px-4 pb-4 pt-0.5">
              {dim.verdict && <p className="mb-3 text-[13px] text-ink-2 leading-relaxed">{dim.verdict}</p>}
              {dim.fixes.length ? (
                <ul className="space-y-3">{dim.fixes.map((f, i) => <Fix key={`${i}-${f.what}`} fix={f} index={i} />)}</ul>
              ) : (
                <p className="text-[12.5px] text-muted">Nothing to change here right now.</p>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

export function DimensionList({ dimensions }: { dimensions: ProfileDimension[] }) {
  // The weakest dimension opens by itself — that is where the reading should start.
  const scored = dimensions.filter((d) => d.score !== null);
  const weakest = scored.length ? scored.reduce((a, b) => ((a.score ?? 100) <= (b.score ?? 100) ? a : b)).id : null;
  return (
    <div className="card overflow-hidden">
      {dimensions.map((d) => <Row key={d.id} dim={d} defaultOpen={d.id === weakest} />)}
    </div>
  );
}
