import { useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { ChevronDown, ExternalLink, FileText } from 'lucide-react';
import type { AskSource } from '../../lib/types-ask';
import { cn } from '../../lib/utils';

export function SourceCard({ s, n, onOpen }: { s: AskSource; n: number; onOpen: () => void }) {
  return (
    <button type="button" onClick={onOpen} className="group flex w-full flex-col overflow-hidden rounded-xl border border-line bg-surface text-left transition-colors hover:border-line-2 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/40" style={{ boxShadow: 'var(--shadow)' }} title={s.one_liner || s.title}>
      <div className="relative aspect-[4/3] overflow-hidden bg-surface-2">
        {s.thumb ? <img src={s.thumb} alt="" className="h-full w-full object-cover transition-transform duration-500 group-hover:scale-105" loading="lazy" /> : <div className="grid h-full w-full place-items-center text-muted-2"><FileText size={16} /></div>}
        <span className="cite absolute left-1.5 top-1.5 !mx-0 !cursor-default">#{n}</span>
        {s.url && <a href={s.url} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()} className="absolute right-1.5 top-1.5 grid h-6 w-6 place-items-center rounded-md bg-ink/70 text-bg opacity-0 transition-opacity group-hover:opacity-100 hover:bg-ink" title="Open on Instagram" aria-label="Open on Instagram"><ExternalLink size={11} /></a>}
      </div>
      <div className="p-2.5">
        <div className="text-[12px] font-medium leading-snug clamp-2">{s.title || 'Untitled save'}</div>
        <div className="mt-0.5 truncate text-[10.5px] text-muted">{s.author ? `@${s.author}` : s.category || ''}</div>
      </div>
    </button>
  );
}

/** Stacked thumbnails + "N sources" — the collapsed face of the drawer. */
function Stack({ sources }: { sources: AskSource[] }) {
  const show = sources.slice(0, 5);
  return (
    <span className="flex -space-x-2">
      {show.map((s, i) => (
        <span key={s.id} className="grid h-6 w-6 overflow-hidden rounded-md border border-surface bg-surface-2 place-items-center" style={{ zIndex: 10 - i }}>
          {s.thumb ? <img src={s.thumb} alt="" className="h-full w-full object-cover" loading="lazy" /> : <FileText size={10} className="text-muted-2" />}
        </span>
      ))}
    </span>
  );
}

/**
 * Per-answer sources: collapsed line ("12 sources", stacked thumbs; "Reading 12 saves…" while streaming) → expandable grid of source cards.
 */
export function SourcesDrawer({ sources, streaming, onOpen, defaultOpen }: { sources: AskSource[]; streaming?: boolean; onOpen: (id: string) => void; defaultOpen?: boolean }) {
  const [isOpen, setOpen] = useState(!!defaultOpen);
  if (!sources.length) return null;
  return (
    <div className="mb-3">
      <button type="button" onClick={() => setOpen((o) => !o)} aria-expanded={isOpen} title={isOpen ? 'Hide the saves this answer is built from' : 'Show the saves this answer is built from'} className={cn('group inline-flex items-center gap-2 rounded-full border px-2 py-1 pr-2.5 text-[12px] transition-colors', isOpen ? 'border-line-2 bg-surface-2 text-ink' : 'border-line bg-surface text-ink-2 hover:border-line-2 hover:text-ink')}>
        <Stack sources={sources} />
        <span>{streaming ? `Reading ${sources.length} save${sources.length === 1 ? '' : 's'}…` : `Built from ${sources.length} save${sources.length === 1 ? '' : 's'}`}</span>
        {!streaming && <span className="text-muted group-hover:text-ink">· {isOpen ? 'hide' : 'show'}</span>}
        <ChevronDown size={13} className={cn('text-muted transition-transform', isOpen && 'rotate-180')} />
      </button>
      <AnimatePresence initial={false}>
        {isOpen && (
          <motion.div key="grid" initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }} exit={{ height: 0, opacity: 0 }} transition={{ duration: 0.22, ease: [0.2, 0.7, 0.2, 1] }} className="overflow-hidden">
            <div className="grid grid-cols-2 gap-2 pt-2.5 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6">
              {sources.map((s, i) => <SourceCard key={s.id} s={s} n={i + 1} onOpen={() => onOpen(s.id)} />)}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
