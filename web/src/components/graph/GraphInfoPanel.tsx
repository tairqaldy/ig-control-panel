import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router';
import { motion } from 'motion/react';
import { ArrowRight, MessageCircleQuestion, Sparkles, X } from 'lucide-react';
import { api, qs } from '../../lib/api';
import type { ItemsResponse } from '../../lib/types';
import type { GraphMode, SimNode } from '../../lib/types-graph';
import { nodeTitle } from '../../lib/types-graph';
import { useItemModal } from '../../lib/store';
import { CategoryDot, Skeleton } from '../ui';
import { cn } from '../../lib/utils';

const KIND: Record<string, string> = { category: 'Category', tag: 'Tag', author: 'Creator', item: 'Save' };

/** The Library filter that shows exactly what a node stands for. */
export function libraryHref(n: SimNode): string {
  if (n.type === 'category') return `/library${qs({ category: n.label })}`;
  if (n.type === 'tag') return `/library${qs({ tag: n.label })}`;
  if (n.type === 'author') return `/library${qs({ author: n.author || n.label.replace(/^@/, '') })}`;
  return '/library';
}
const askHref = (n: SimNode) => `/ask?q=${encodeURIComponent(`What did I save about ${nodeTitle(n)}?`)}`;

/**
 * The right-hand panel: what the selected node is, how big it is, its three most useful saves and the two things
 * you can do next. Sheet on phones, column on desktop. Nothing selected → the page shows a hint instead.
 */
export default function GraphInfoPanel({ node, mode, connected, onOpenCategory, onClose }: {
  node: SimNode;
  mode: GraphMode;
  connected: number;
  onOpenCategory: (name: string) => void;
  onClose: () => void;
}) {
  const modal = useItemModal();
  const filter: Record<string, string> | null = node.type === 'category' ? { category: node.label }
    : node.type === 'tag' ? { tag: node.label }
      : node.type === 'author' ? { author: node.author || node.label.replace(/^@/, '') } : null;
  const top = useQuery({
    queryKey: ['graph-top-saves', filter],
    queryFn: () => api.get<ItemsResponse>(`/api/items${qs({ ...filter, status: 'done', sort: 'useful', limit: 3 })}`),
    enabled: !!filter,
    staleTime: 60_000,
  });

  const count = node.count ?? 0;
  const line = node.type === 'category'
    ? [`${count.toLocaleString()} saves`, connected ? `${connected} tags & creators here` : '', node.avgUseful ? `usefulness ${node.avgUseful.toFixed(1)}/10` : ''].filter(Boolean).join(' · ')
    : node.type === 'item'
      ? [node.category, node.author ? `@${node.author}` : '', node.useful ? `usefulness ${node.useful}/10` : ''].filter(Boolean).join(' · ')
      : [`${count.toLocaleString()} saves`, node.category ? `mostly ${node.category}` : ''].filter(Boolean).join(' · ');

  return (
    <motion.aside
      initial={{ opacity: 0, y: 16, x: 0 }}
      animate={{ opacity: 1, y: 0, x: 0 }}
      exit={{ opacity: 0, y: 16 }}
      transition={{ type: 'spring', stiffness: 380, damping: 34 }}
      role="complementary"
      aria-label="About the selected node"
      className="pointer-events-auto card p-4 fixed inset-x-2 bottom-2 max-h-[62vh] overflow-y-auto sm:absolute sm:inset-x-auto sm:bottom-auto sm:right-4 sm:top-[76px] sm:w-[19rem] sm:max-h-[calc(100%-6rem)]"
    >
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <div className="eyebrow flex items-center gap-1.5">
            {node.category && node.type !== 'category' && <CategoryDot category={node.category} />}
            {KIND[node.type]}
          </div>
          <div className={cn('mt-1 leading-tight break-words', node.type === 'category' ? 'display text-[22px]' : node.type === 'tag' ? 'font-mono text-[15px]' : 'text-[15px] font-medium')}>
            {nodeTitle(node)}
          </div>
          <div className="mt-1 text-[12px] text-muted">{line}</div>
        </div>
        <button onClick={onClose} className="btn btn-ghost btn-sm !px-1.5 -mr-1 -mt-1 shrink-0" aria-label="Close panel"><X size={14} /></button>
      </div>

      {node.type !== 'item' && (
        <div className="mt-3.5">
          <div className="eyebrow mb-1.5">Top saves</div>
          {top.isLoading ? (
            <div className="space-y-1.5">{[0, 1, 2].map((i) => <Skeleton key={i} className="h-12 w-full" />)}</div>
          ) : top.data?.items.length ? (
            <ul className="space-y-1">
              {top.data.items.map((it) => (
                <li key={it.id}>
                  <button onClick={() => modal.open(it.id)} className="flex w-full items-center gap-2.5 rounded-lg p-1 text-left transition-colors hover:bg-surface-2">
                    {it.thumb ? <img src={it.thumb} alt="" loading="lazy" className="h-12 w-9 shrink-0 rounded-md object-cover" /> : <span className="h-12 w-9 shrink-0 rounded-md bg-surface-2" />}
                    <span className="min-w-0">
                      <span className="block text-[12.5px] leading-snug clamp-2">{it.analysis?.title || it.caption || 'Untitled save'}</span>
                      <span className="mt-0.5 block truncate text-[11px] text-muted">{it.author ? `@${it.author}` : ''}</span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <div className="text-[12px] text-muted">No analyzed saves here yet.</div>
          )}
        </div>
      )}

      <div className="mt-3.5 flex flex-col gap-1.5">
        {node.type === 'category' && mode !== 'category' && (
          <button onClick={() => onOpenCategory(node.label)} className="btn btn-sm btn-primary justify-between">Open this category <ArrowRight size={13} /></button>
        )}
        {node.type === 'item' && (
          <button onClick={() => modal.open(node.id)} className="btn btn-sm btn-primary justify-between">Open this save <ArrowRight size={13} /></button>
        )}
        <Link to={libraryHref(node)} className="btn btn-sm justify-between">
          {node.type === 'category' ? 'Open in Library' : 'Show in Library'} <Sparkles size={13} className="text-muted" />
        </Link>
        <Link to={askHref(node)} className="btn btn-sm justify-between">Ask about this <MessageCircleQuestion size={13} className="text-muted" /></Link>
      </div>
    </motion.aside>
  );
}
