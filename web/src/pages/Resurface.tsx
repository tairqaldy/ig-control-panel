import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { motion, AnimatePresence } from 'motion/react';
import { Sparkles, Shuffle, ExternalLink, Heart, ArrowUpRight } from 'lucide-react';
import { api } from '../lib/api';
import type { ItemLight } from '../lib/types';
import { PageHeader, Skeleton, Empty, CategoryDot } from '../components/ui';
import { useItemModal } from '../lib/store';
import { fmtDuration } from '../lib/utils';

function BigCard({ item, i }: { item: ItemLight; i: number }) {
  const modal = useItemModal();
  const a = item.analysis;
  return (
    <motion.article initial={{ opacity: 0, y: 16, rotate: i % 2 ? 0.4 : -0.4 }} animate={{ opacity: 1, y: 0, rotate: 0 }} transition={{ delay: i * 0.1, type: 'spring', stiffness: 260, damping: 26 }} className="card overflow-hidden flex flex-col md:flex-row">
      <button onClick={() => modal.open(item.id)} className="relative md:w-[38%] aspect-[4/5] md:aspect-auto md:min-h-[320px] bg-surface-2 overflow-hidden group shrink-0">
        {item.thumb ? <img src={item.thumb} alt="" className="absolute inset-0 h-full w-full object-cover transition-transform duration-700 group-hover:scale-[1.03]" /> : <div className="absolute inset-0 grid place-items-center text-muted-2 text-[12px]">No preview</div>}
        {item.media_type === 'video' && <span className="absolute left-3 top-3 rounded-md bg-black/55 px-1.5 py-0.5 text-[10.5px] font-medium text-white backdrop-blur">Reel · {fmtDuration(item.duration)}</span>}
      </button>
      <div className="flex-1 p-6 md:p-7 flex flex-col">
        <div className="flex items-center gap-2 text-[12px] text-muted"><CategoryDot category={a?.category} />{a?.category}{a?.subcategory ? ` · ${a.subcategory}` : ''}<span className="ml-auto font-mono text-[10.5px]">{a?.usefulness_score}/10</span></div>
        <h3 className="display text-[28px] leading-[1.1] mt-2">{a?.title}</h3>
        <p className="mt-2 text-[14.5px] text-ink-2 leading-relaxed">{a?.one_liner}</p>
        {item.why_today && <div className="mt-4 flex items-start gap-2 rounded-xl bg-accent-soft/60 border border-accent/20 px-3 py-2.5 text-[13px] text-ink"><Sparkles size={14} className="text-accent shrink-0 mt-0.5" />{item.why_today}</div>}
        <div className="mt-auto pt-5 flex flex-wrap items-center gap-2">
          <button onClick={() => modal.open(item.id)} className="btn btn-primary">Open notes <ArrowUpRight size={14} /></button>
          <a href={item.url} target="_blank" rel="noreferrer" className="btn"><ExternalLink size={14} /> Instagram</a>
          <span className="ml-auto text-[12px] text-muted">{item.author ? `@${item.author}` : ''}</span>
        </div>
      </div>
    </motion.article>
  );
}

export default function Resurface() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['resurface'], queryFn: () => api.get<{ date: string; items: ItemLight[] }>('/api/resurface?n=3'), staleTime: 5 * 60_000 });
  const [random, setRandom] = useState<ItemLight | null>(null);
  const [spinning, setSpinning] = useState(false);
  const roll = async () => {
    setSpinning(true);
    try { const r = await api.get<{ item: ItemLight | null }>('/api/resurface/random'); setRandom(r.item); } finally { setTimeout(() => setSpinning(false), 300); }
  };
  return (
    <div>
      <PageHeader eyebrow={`Resurface · ${q.data?.date || ''}`} title={<>Today’s <em className="text-accent not-italic">dig</em></>} subtitle="A small, deterministic daily pick from the depths of your library — weighted toward useful, evergreen saves you haven’t looked at in a while. Same three all day; new ones tomorrow." actions={<button onClick={roll} className="btn"><Shuffle size={14} className={spinning ? 'animate-spin' : ''} /> Random save</button>} />
      <AnimatePresence>
        {random && (
          <motion.div initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }} exit={{ opacity: 0, height: 0 }} className="mb-6 overflow-hidden">
            <div className="eyebrow mb-2">Random pull</div>
            <BigCard item={random} i={0} />
          </motion.div>
        )}
      </AnimatePresence>
      {q.isLoading ? (
        <div className="space-y-4">{[0, 1, 2].map((i) => <Skeleton key={i} className="h-72" />)}</div>
      ) : q.data && q.data.items.length ? (
        <div className="space-y-4">{q.data.items.map((it, i) => <BigCard key={it.id} item={it} i={i} />)}</div>
      ) : (
        <Empty icon={<Heart size={26} />} title="Nothing to resurface yet" body="Once a handful of saves are analyzed, this page will pick three every day." action={<button onClick={() => qc.invalidateQueries({ queryKey: ['resurface'] })} className="btn">Refresh</button>} />
      )}
    </div>
  );
}
