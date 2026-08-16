import { memo } from 'react';
import { motion } from 'motion/react';
import { Heart, Play, Images, FileText, AlertCircle, Loader2, Clock, Sparkles } from 'lucide-react';
import type { ItemLight } from '../lib/types';
import { cn, fmtNum, fmtDuration } from '../lib/utils';
import { CategoryDot } from './ui';
import { useItemModal, useQuota } from '../lib/store';

export const ItemCard = memo(function ItemCard({ item, index = 0, selected, onSelect, view = 'grid' }: { item: ItemLight; index?: number; selected?: boolean; onSelect?: (id: string, e: React.MouseEvent) => void; view?: 'grid' | 'list' }) {
  const modal = useItemModal();
  const { analyzeExhausted, openUpgrade } = useQuota();
  const a = item.analysis;
  const title = a?.title || (item.caption ? item.caption.split('\n')[0].slice(0, 90) : item.author ? `@${item.author}` : 'Untitled');
  const status = item.analysis_status;
  const busy = item.queue_state === 'running' || status === 'running';
  // Hosted: a pending save that won't be analyzed because the tenant is out of allowance gets a soft "Upgrade to analyze" pill.
  const needsUpgrade = analyzeExhausted && status === 'pending' && !busy && item.queue_state !== 'queued';

  const onClick = (e: React.MouseEvent) => {
    if ((e.metaKey || e.ctrlKey || e.shiftKey) && onSelect) { e.preventDefault(); onSelect(item.id, e); return; }
    modal.open(item.id);
  };

  if (view === 'list') {
    return (
      <motion.button layout onClick={onClick} initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: Math.min(index, 20) * 0.015 }}
        aria-label={title} aria-pressed={selected}
        className={cn('w-full text-left flex items-center gap-3 rounded-xl border p-2 pr-3 transition-colors hover:bg-surface-2/60 outline-none focus-visible:ring-2 focus-visible:ring-accent/40', selected ? 'border-accent bg-accent-soft/40' : 'border-transparent hover:border-line')}>
        <div className="relative h-14 w-11 shrink-0 overflow-hidden rounded-lg bg-surface-2">
          {item.thumb ? <img src={item.thumb} alt="" loading="lazy" className="h-full w-full object-cover" /> : <div className="h-full w-full grid place-items-center text-muted-2"><FileText size={14} /></div>}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 min-w-0">
            <div className="truncate text-[13.5px] font-medium">{title}</div>
            {item.favorite && <Heart size={12} className="text-danger fill-danger shrink-0" />}
          </div>
          <div className="truncate text-[12px] text-muted mt-0.5">{a?.one_liner || item.caption?.replace(/\n+/g, ' ') || '—'}</div>
        </div>
        <div className="hidden md:flex items-center gap-2 shrink-0 text-[11.5px] text-muted">
          {a && <span className="inline-flex items-center gap-1.5"><CategoryDot category={a.category} />{a.category}</span>}
        </div>
        <div className="hidden sm:block shrink-0 w-24 truncate text-[12px] text-muted text-right">{item.author ? `@${item.author}` : ''}</div>
        {needsUpgrade ? <span onClick={(e) => { e.stopPropagation(); openUpgrade({ reason: 'Upgrade to analyze the rest of your library' }); }} className="inline-flex items-center gap-1 rounded-full border border-accent/40 bg-accent-soft px-2 py-0.5 text-[10.5px] font-medium text-accent hover:bg-accent hover:text-accent-ink transition-colors" title="Past your plan's analysis allowance"><Sparkles size={10} /> Upgrade</span> : <StatusGlyph status={status} busy={busy} />}
      </motion.button>
    );
  }

  return (
    <motion.article
      layout
      initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: Math.min(index % 24, 24) * 0.02, duration: 0.35, ease: [0.2, 0.7, 0.2, 1] }}
      className={cn('group relative flex flex-col overflow-hidden rounded-2xl border bg-surface transition-all duration-300 hover:-translate-y-0.5 cursor-pointer outline-none focus-visible:ring-2 focus-visible:ring-accent/40', selected ? 'border-accent ring-2 ring-accent/20' : 'border-line hover:border-line-2')}
      style={{ boxShadow: 'var(--shadow)' }}
      onClick={onClick}
      role="button" tabIndex={0} aria-label={title}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); modal.open(item.id); } }}
    >
      <div className="relative aspect-[4/5] overflow-hidden bg-surface-2">
        {item.thumb ? (
          <img src={item.thumb} alt="" loading="lazy" decoding="async" className="h-full w-full object-cover transition-transform duration-700 ease-out group-hover:scale-[1.04]" />
        ) : (
          <div className="h-full w-full grid place-items-center text-muted-2 p-6 text-center">
            <div>
              <FileText size={22} className="mx-auto mb-2" />
              <div className="text-[11.5px] leading-snug clamp-3">{item.caption || 'No preview'}</div>
            </div>
          </div>
        )}
        <div className="pointer-events-none absolute inset-x-0 bottom-0 h-24 bg-gradient-to-t from-black/55 to-transparent opacity-80" />
        {/* type badge */}
        <div className="absolute left-2 top-2 flex items-center gap-1">
          {item.media_type === 'video' && <span className="inline-flex items-center gap-1 rounded-md bg-black/55 px-1.5 py-0.5 text-[10.5px] font-medium text-white backdrop-blur"><Play size={10} className="fill-white" />{fmtDuration(item.duration) || 'Reel'}</span>}
          {item.media_type === 'carousel' && <span className="inline-flex items-center gap-1 rounded-md bg-black/55 px-1.5 py-0.5 text-[10.5px] font-medium text-white backdrop-blur"><Images size={10} />Carousel</span>}
        </div>
        <div className="absolute right-2 top-2 flex items-center gap-1">
          {item.favorite && <span className="rounded-md bg-black/55 p-1 text-white backdrop-blur"><Heart size={11} className="fill-white" /></span>}
          <StatusGlyph status={status} busy={busy} onDark />
        </div>
        <div className="absolute inset-x-0 bottom-0 p-3 text-white">
          <div className="flex items-center gap-1.5 text-[11px] opacity-90">
            {item.author && <span className="truncate">@{item.author}</span>}
            {item.play_count ? <span className="ml-auto shrink-0 tabular">{fmtNum(item.play_count)} plays</span> : item.like_count ? <span className="ml-auto shrink-0 tabular">{fmtNum(item.like_count)} likes</span> : null}
          </div>
        </div>
      </div>
      <div className="flex flex-col gap-1.5 p-3.5">
        <div className="text-[14px] font-medium leading-snug clamp-2">{title}</div>
        {a?.one_liner ? <div className="text-[12.5px] text-muted leading-snug clamp-2">{a.one_liner}</div> : !a && item.caption ? <div className="text-[12.5px] text-muted leading-snug clamp-2">{item.caption.replace(/\n+/g, ' ')}</div> : null}
        <div className="mt-1 flex items-center gap-1.5 flex-wrap min-h-[20px]">
          {a ? (
            <>
              <span className="inline-flex items-center gap-1.5 text-[11px] text-ink-2"><CategoryDot category={a.category} />{a.category}</span>
              {a.tags.slice(0, 2).map((t) => <span key={t} className="text-[11px] text-muted">#{t}</span>)}
              {a.usefulness_score >= 8 && <span className="ml-auto font-mono text-[10px] text-accent" title="Usefulness score">{a.usefulness_score}/10</span>}
            </>
          ) : needsUpgrade ? (
            <button type="button" onClick={(e) => { e.stopPropagation(); openUpgrade({ reason: 'Upgrade to analyze the rest of your library' }); }} className="inline-flex items-center gap-1 rounded-full border border-accent/40 bg-accent-soft px-2 py-0.5 text-[10.5px] font-medium text-accent hover:bg-accent hover:text-accent-ink transition-colors" title="Past your plan's analysis allowance">
              <Sparkles size={10} /> Upgrade to analyze
            </button>
          ) : (
            <span className="text-[11px] text-muted-2 inline-flex items-center gap-1">
              {status === 'failed' ? <><AlertCircle size={11} className="text-danger" /> Analysis failed</> : status === 'skipped' ? 'Not enough content to analyze' : busy ? <><Loader2 size={11} className="animate-spin" /> Analyzing…</> : <><Clock size={11} /> In the queue</>}
            </span>
          )}
        </div>
      </div>
    </motion.article>
  );
});

function StatusGlyph({ status, busy, onDark }: { status: string; busy: boolean; onDark?: boolean }) {
  if (status === 'done') return null;
  const base = onDark ? 'rounded-md bg-black/55 p-1 text-white backdrop-blur' : 'text-muted';
  if (busy) return <span className={base} title="Analyzing"><Loader2 size={11} className="animate-spin" /></span>;
  if (status === 'failed') return <span className={cn(base, !onDark && 'text-danger')} title="Analysis failed"><AlertCircle size={11} /></span>;
  return <span className={base} title="In the queue"><Clock size={11} /></span>;
}
