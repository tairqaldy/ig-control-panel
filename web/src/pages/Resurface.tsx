import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { motion, AnimatePresence } from 'motion/react';
import { Sparkles, Shuffle, ExternalLink, ArrowUpRight, X, AlertCircle, RefreshCw } from 'lucide-react';
import { toast } from 'sonner';
import { api } from '../lib/api';
import type { ItemLight } from '../lib/types';
import { PageHeader, Skeleton, CategoryDot } from '../components/ui';
import { AnalysisEmpty } from '../components/Onboarding';
import { useItemModal } from '../lib/store';
import { fmtDuration } from '../lib/utils';

function BigCard({ item, i }: { item: ItemLight; i: number }) {
  const modal = useItemModal();
  const a = item.analysis;
  const dur = item.media_type === 'video' ? fmtDuration(item.duration) : '';
  return (
    <motion.article initial={{ opacity: 0, y: 16, rotate: i % 2 ? 0.4 : -0.4 }} animate={{ opacity: 1, y: 0, rotate: 0 }} transition={{ delay: i * 0.1, type: 'spring', stiffness: 260, damping: 26 }} className="card overflow-hidden flex flex-col md:flex-row">
      <button onClick={() => modal.open(item.id)} aria-label={`Open ${a?.title || 'save'}`} className="relative md:w-[38%] aspect-[4/5] md:aspect-auto md:min-h-[320px] bg-surface-2 overflow-hidden group shrink-0 outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent/50">
        {item.thumb ? <img src={item.thumb} alt="" className="absolute inset-0 h-full w-full object-cover transition-transform duration-700 group-hover:scale-[1.03]" /> : <div className="absolute inset-0 grid place-items-center text-muted-2 text-[12px]">No preview</div>}
        {item.media_type === 'video' && <span className="absolute left-3 top-3 rounded-md bg-black/55 px-1.5 py-0.5 text-[10.5px] font-medium text-white backdrop-blur">{dur ? `Reel · ${dur}` : 'Reel'}</span>}
      </button>
      <div className="flex-1 p-5 sm:p-6 md:p-7 flex flex-col min-w-0">
        <div className="flex items-center gap-2 text-[12px] text-muted min-w-0"><CategoryDot category={a?.category} /><span className="truncate">{a?.category}{a?.subcategory ? ` · ${a.subcategory}` : ''}</span><span className="ml-auto font-mono text-[10.5px] shrink-0" title="Usefulness score out of 10">{a?.usefulness_score}/10</span></div>
        <h3 className="display text-[24px] sm:text-[28px] leading-[1.1] mt-2">{a?.title}</h3>
        <p className="mt-2 text-[14.5px] text-ink-2 leading-relaxed">{a?.one_liner}</p>
        {item.why_today && <div className="mt-4 flex items-start gap-2 rounded-xl bg-accent-soft/60 border border-accent/20 px-3 py-2.5 text-[13px] text-ink"><Sparkles size={14} className="text-accent shrink-0 mt-0.5" />{item.why_today}</div>}
        <div className="mt-auto pt-5 flex flex-wrap items-center gap-2">
          <button onClick={() => modal.open(item.id)} className="btn btn-primary">Open notes <ArrowUpRight size={14} /></button>
          <a href={item.url} target="_blank" rel="noreferrer" className="btn"><ExternalLink size={14} /> Instagram</a>
          <span className="ml-auto text-[12px] text-muted truncate">{item.author ? `@${item.author}` : ''}</span>
        </div>
      </div>
    </motion.article>
  );
}

export default function Resurface() {
  const q = useQuery({ queryKey: ['resurface'], queryFn: () => api.get<{ date: string; items: ItemLight[] }>('/api/resurface?n=3'), staleTime: 5 * 60_000 });
  const [random, setRandom] = useState<ItemLight | null>(null);
  const [spinning, setSpinning] = useState(false);
  const roll = async () => {
    setSpinning(true);
    try {
      const r = await api.get<{ item: ItemLight | null }>('/api/resurface/random');
      if (r.item) setRandom(r.item); else toast.message('Nothing analyzed to pull from yet');
    } catch (e: any) { toast.error(e?.message || 'Could not pull a random save'); }
    finally { setTimeout(() => setSpinning(false), 300); }
  };
  const hasPicks = !!q.data?.items.length;
  return (
    <div>
      <PageHeader
        eyebrow={`Resurface${q.data?.date ? ` · ${q.data.date}` : ''}`}
        title={<>Today’s <em className="text-accent not-italic">dig</em></>}
        subtitle="Three saves picked for today, weighted toward useful, evergreen ones you haven’t opened in a while. New picks tomorrow."
        actions={hasPicks ? <button onClick={roll} disabled={spinning} className="btn"><Shuffle size={14} className={spinning ? 'animate-spin' : ''} /> Random save</button> : undefined}
      />
      <AnimatePresence>
        {random && (
          <motion.div initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }} exit={{ opacity: 0, height: 0 }} className="mb-6 overflow-hidden">
            <div className="flex items-center gap-2 mb-2"><div className="eyebrow">Random pull</div><button onClick={() => setRandom(null)} className="btn btn-ghost btn-sm !px-1.5 ml-auto text-muted" aria-label="Dismiss random pull"><X size={13} /></button></div>
            <BigCard item={random} i={0} />
          </motion.div>
        )}
      </AnimatePresence>
      {q.isLoading ? (
        <div className="space-y-4" aria-busy>{[0, 1, 2].map((i) => <Skeleton key={i} className="h-72" />)}</div>
      ) : q.isError ? (
        <div className="card-flat border-dashed p-10 text-center flex flex-col items-center gap-3">
          <AlertCircle size={24} className="text-danger" />
          <div className="display text-[22px]">Today’s picks did not load</div>
          <div className="text-[13px] text-muted max-w-md">{(q.error as Error)?.message || 'The server did not answer.'}</div>
          <button onClick={() => q.refetch()} className="btn btn-primary mt-1"><RefreshCw size={14} /> Try again</button>
        </div>
      ) : hasPicks ? (
        <div className="space-y-4">{q.data!.items.map((it, i) => <BigCard key={it.id} item={it} i={i} />)}</div>
      ) : (
        <AnalysisEmpty page="resurface" />
      )}
    </div>
  );
}
