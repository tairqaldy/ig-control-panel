import { useCallback, useEffect, useMemo, useState } from 'react';
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useSearchParams } from 'react-router';
import { AnimatePresence, motion } from 'motion/react';
import { toast } from 'sonner';
import { Search, X, LayoutGrid, List, Download, ChevronDown, Heart, Sparkles, Filter, RefreshCw, Archive, Trash2, Tag, CheckSquare, Square, Brain, EyeOff, Eye } from 'lucide-react';
import { api, qs } from '../lib/api';
import type { Facets, ItemsResponse } from '../lib/types';
import { cn, CONTENT_TYPE_LABEL } from '../lib/utils';
import { ItemCard } from '../components/ItemCard';
import { PageHeader, Empty, Skeleton, useDebounced, useInfiniteScroll, CategoryDot, Popover } from '../components/ui';

const SORTS = [
  { id: 'saved', label: 'Recently saved' },
  { id: 'saved_asc', label: 'Oldest saved' },
  { id: 'useful', label: 'Most useful' },
  { id: 'posted', label: 'Recently posted' },
  { id: 'plays', label: 'Most played' },
  { id: 'likes', label: 'Most liked' },
  { id: 'random', label: 'Surprise me' },
];

const WIDTHS: Record<string, number> = { 'w-40': 160, 'w-44': 176, 'w-48': 192, 'w-52': 208, 'w-56': 224, 'w-60': 240, 'w-64': 256 };
function Dropdown({ label, value, options, onChange, icon, width = 'w-56' }: { label: string; value: string; options: Array<{ id: string; label: string; n?: number }>; onChange: (v: string) => void; icon?: React.ReactNode; width?: string }) {
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState('');
  const [anchor, setAnchor] = useState<HTMLButtonElement | null>(null);
  const current = options.find((o) => o.id === value);
  const filtered = filter ? options.filter((o) => o.label.toLowerCase().includes(filter.toLowerCase())) : options;
  const close = useCallback(() => { setOpen(false); setFilter(''); }, []);
  return (
    <>
      <button ref={setAnchor} onClick={() => setOpen((o) => !o)} aria-expanded={open} className={cn('btn btn-sm', value && 'chip-active border-accent')}>{icon}{current ? current.label : label}<ChevronDown size={13} className={cn('text-muted transition-transform', open && 'rotate-180')} /></button>
      <Popover anchor={anchor} open={open} onClose={close} width={WIDTHS[width] || 224}>
        {options.length > 8 && <input autoFocus value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Filter…" className="input !py-1.5 mb-1 !rounded-lg" />}
        <button onClick={() => { onChange(''); close(); }} className={cn('flex w-full items-center rounded-lg px-2.5 py-1.5 text-left text-[13px] hover:bg-surface-2', !value && 'text-accent')}>All</button>
        {filtered.slice(0, 300).map((o) => (
          <button key={o.id} onClick={() => { onChange(o.id); close(); }} className={cn('flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-[13px] hover:bg-surface-2', value === o.id && 'text-accent')}>
            <span className="truncate flex-1">{o.label}</span>{o.n !== undefined && <span className="font-mono text-[11px] text-muted">{o.n}</span>}
          </button>
        ))}
        {filtered.length === 0 && <div className="px-2.5 py-2 text-[12px] text-muted">No matches</div>}
        {filtered.length > 300 && <div className="px-2.5 py-2 text-[11px] text-muted">{filtered.length - 300} more — type to filter</div>}
      </Popover>
    </>
  );
}

export default function Library() {
  const [sp, setSp] = useSearchParams();
  const qc = useQueryClient();
  const get = (k: string) => sp.get(k) || '';
  const set = (patch: Record<string, string>) => {
    const next = new URLSearchParams(sp);
    for (const [k, v] of Object.entries(patch)) { if (v) next.set(k, v); else next.delete(k); }
    setSp(next, { replace: true });
  };
  const [qInput, setQInput] = useState(get('q'));
  useEffect(() => { setQInput(get('q')); }, [sp.get('q')]);
  const dq = useDebounced(qInput, 300);
  useEffect(() => { if (dq !== get('q')) set({ q: dq }); }, [dq]);
  const [view, setView] = useState<'grid' | 'list'>(() => (localStorage.getItem('rs-view') as 'grid' | 'list') || 'grid');
  useEffect(() => localStorage.setItem('rs-view', view), [view]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [semantic, setSemantic] = useState(true);

  const params = { q: get('q'), category: get('category'), tag: get('tag'), author: get('author'), type: get('type'), status: get('status'), collection: get('collection'), content_type: get('content_type'), sort: get('sort') || 'saved', favorite: get('favorite'), evergreen: get('evergreen'), min_useful: get('min_useful'), archived: get('archived'), excluded: get('excluded'), semantic: semantic ? '1' : '' };
  const isRandom = params.sort === 'random';
  const query = useInfiniteQuery({
    queryKey: ['items', params],
    queryFn: ({ pageParam }) => api.get<ItemsResponse>(`/api/items${qs({ ...params, page: pageParam, limit: isRandom ? 120 : 60 })}`),
    initialPageParam: 1,
    // RANDOM() is re-rolled per request, so "Surprise me" is a single shuffled page (no pagination, no polling reshuffle).
    getNextPageParam: (last) => (!isRandom && last.hasMore ? last.page + 1 : undefined),
    refetchInterval: (q) => (!isRandom && q.state.data?.pages.some((p) => p.items.some((i) => i.queue_state !== 'idle' || i.analysis_status === 'running')) ? 5000 : false),
  });
  const facets = useQuery({ queryKey: ['facets'], queryFn: () => api.get<Facets>('/api/facets'), staleTime: 30_000 });
  const items = useMemo(() => {
    const seen = new Set<string>();
    return (query.data?.pages.flatMap((p) => p.items) || []).filter((i) => (seen.has(i.id) ? false : (seen.add(i.id), true)));
  }, [query.data]);
  const total = query.data?.pages[0]?.total ?? 0;
  const loadMore = useCallback(() => { if (query.hasNextPage && !query.isFetchingNextPage) query.fetchNextPage(); }, [query]);
  const sentinel = useInfiniteScroll(loadMore, !!query.hasNextPage);

  const activeFilters = ['category', 'tag', 'author', 'type', 'status', 'collection', 'content_type', 'favorite', 'evergreen', 'min_useful', 'archived', 'excluded'].filter((k) => get(k));
  const clearAll = () => { setSp(new URLSearchParams(get('q') ? { q: get('q') } : {}), { replace: true }); };

  const onSelect = (id: string) => setSelected((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });
  const bulk = useMutation({
    mutationFn: (body: { action: string; tag?: string }) => api.post<{ n: number }>('/api/items/bulk', { ids: Array.from(selected), ...body }),
    onSuccess: (r, v) => { toast.success(`${v.action.replace('_', ' ')}: ${r.n} items`); setSelected(new Set()); qc.invalidateQueries({ queryKey: ['items'] }); qc.invalidateQueries({ queryKey: ['stats'] }); qc.invalidateQueries({ queryKey: ['jobs-status'] }); },
    onError: (e: any) => toast.error(e.message),
  });
  const exportUrl = (format: string) => `/api/export${qs({ format, category: get('category'), tag: get('tag'), favorite: get('favorite'), ids: selected.size ? Array.from(selected).join(',') : '' })}`;

  const catOptions = (facets.data?.categories || []).map((c) => ({ id: c.name, label: c.name, n: c.n }));
  const tagOptions = (facets.data?.tags || []).map((c) => ({ id: c.name, label: `#${c.name}`, n: c.n }));
  const authorOptions = (facets.data?.authors || []).map((c) => ({ id: c.name, label: `@${c.name}`, n: c.n }));
  const colOptions = (facets.data?.collections || []).map((c) => ({ id: c.name, label: c.name, n: c.n }));
  const ctOptions = (facets.data?.contentTypes || []).map((c) => ({ id: c.name, label: CONTENT_TYPE_LABEL[c.name] || c.name, n: c.n }));

  return (
    <div>
      <PageHeader
        eyebrow="Library"
        title={<>Everything you saved{total ? <span className="text-muted"> · {total.toLocaleString()}</span> : ''}</>}
        actions={
          <>
            <div className="relative">
              <Dropdown label="Export" value="" icon={<Download size={14} />} onChange={(v) => { if (v) window.location.href = exportUrl(v); }} options={[{ id: 'json', label: 'JSON (full data)' }, { id: 'csv', label: 'CSV (spreadsheet / Notion)' }, { id: 'md', label: 'Markdown digest' }, { id: 'obsidian', label: 'Obsidian vault (zip)' }]} width="w-60" />
            </div>
            <div className="inline-flex rounded-xl border border-line bg-surface p-0.5">
              <button onClick={() => setView('grid')} className={cn('rounded-lg p-1.5', view === 'grid' ? 'bg-surface-2 text-ink' : 'text-muted')} title="Grid"><LayoutGrid size={15} /></button>
              <button onClick={() => setView('list')} className={cn('rounded-lg p-1.5', view === 'list' ? 'bg-surface-2 text-ink' : 'text-muted')} title="List"><List size={15} /></button>
            </div>
          </>
        }
      />

      {/* Search + filters */}
      <div className="sticky top-14 lg:top-0 z-20 -mx-4 sm:-mx-6 lg:-mx-8 px-4 sm:px-6 lg:px-8 py-3 mb-4 bg-bg/85 backdrop-blur border-b border-line/60">
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative flex-1 min-w-[240px] max-w-xl">
            <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted" />
            <input value={qInput} onChange={(e) => setQInput(e.target.value)} placeholder="Search titles, transcripts, captions, tags, people…" className="input !pl-9 !pr-24" />
            <div className="absolute right-1.5 top-1/2 -translate-y-1/2 flex items-center gap-1">
              {qInput && <button onClick={() => setQInput('')} className="btn btn-ghost btn-sm !px-1.5"><X size={13} /></button>}
              <button onClick={() => setSemantic((s) => !s)} className={cn('btn btn-sm !py-1', semantic ? 'chip-active border-accent' : '')} title="Also search by meaning (embeddings)"><Brain size={12} /> meaning</button>
            </div>
          </div>
          <Dropdown label="Category" value={get('category')} options={catOptions} onChange={(v) => set({ category: v })} icon={<Filter size={13} />} />
          <Dropdown label="Tag" value={get('tag')} options={tagOptions} onChange={(v) => set({ tag: v })} icon={<Tag size={13} />} width="w-64" />
          <Dropdown label="Author" value={get('author')} options={authorOptions} onChange={(v) => set({ author: v })} width="w-64" />
          <Dropdown label="Type" value={get('type')} options={[{ id: 'video', label: 'Reels & videos' }, { id: 'image', label: 'Images' }, { id: 'carousel', label: 'Carousels' }]} onChange={(v) => set({ type: v })} width="w-44" />
          {ctOptions.length > 0 && <Dropdown label="Format" value={get('content_type')} options={ctOptions} onChange={(v) => set({ content_type: v })} width="w-52" />}
          {colOptions.length > 0 && <Dropdown label="Collection" value={get('collection')} options={colOptions} onChange={(v) => set({ collection: v })} />}
          <Dropdown label="Status" value={get('status')} options={[{ id: 'done', label: 'Analyzed' }, { id: 'pending', label: 'Pending' }, { id: 'failed', label: 'Failed' }, { id: 'skipped', label: 'Skipped' }]} onChange={(v) => set({ status: v })} width="w-40" />
          <button onClick={() => set({ favorite: get('favorite') ? '' : '1' })} className={cn('btn btn-sm', get('favorite') && 'chip-active border-accent')}><Heart size={13} className={cn(get('favorite') && 'fill-current')} /> Favorites</button>
          <button onClick={() => set({ evergreen: get('evergreen') ? '' : '1' })} className={cn('btn btn-sm', get('evergreen') && 'chip-active border-accent')}><Sparkles size={13} /> Evergreen</button>
          <Dropdown label="Sort" value={get('sort') || 'saved'} options={SORTS} onChange={(v) => set({ sort: v })} width="w-48" />
          <button onClick={() => set({ excluded: get('excluded') ? '' : '1', archived: '' })} className={cn('btn btn-sm', get('excluded') && 'chip-active border-accent')} title="Saves you excluded from the system (never analyzed, hidden everywhere)"><EyeOff size={13} /> Excluded</button>
          {activeFilters.length > 0 && <button onClick={clearAll} className="btn btn-ghost btn-sm text-muted"><X size={13} /> Clear</button>}
        </div>
      </div>

      {/* Bulk bar */}
      <AnimatePresence>
        {selected.size > 0 && (
          <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: 20 }} className="fixed bottom-5 left-1/2 -translate-x-1/2 z-40 flex items-center gap-2 rounded-2xl border border-line bg-surface px-3 py-2" style={{ boxShadow: 'var(--shadow-lg)' }}>
            <span className="text-[13px] font-medium px-1">{selected.size} selected</span>
            <button onClick={() => bulk.mutate({ action: 'favorite' })} className="btn btn-sm"><Heart size={13} /> Favorite</button>
            <button onClick={() => bulk.mutate({ action: 'reanalyze' })} className="btn btn-sm"><RefreshCw size={13} /> Re-analyze</button>
            <button onClick={() => { const t = prompt('Tag to add:'); if (t) bulk.mutate({ action: 'add_tag', tag: t }); }} className="btn btn-sm"><Tag size={13} /> Tag</button>
            <a href={exportUrl('json')} className="btn btn-sm"><Download size={13} /> Export</a>
            {get('excluded') ? (
              <button onClick={() => bulk.mutate({ action: 'include' })} className="btn btn-sm"><Eye size={13} /> Include again</button>
            ) : (
              <button onClick={() => bulk.mutate({ action: 'exclude' })} className="btn btn-sm" title="Exclude from Resurfly: never analyzed, hidden from library/search/graph. Undo from the Excluded filter."><EyeOff size={13} /> Exclude</button>
            )}
            <button onClick={() => bulk.mutate({ action: get('archived') ? 'unarchive' : 'archive' })} className="btn btn-sm"><Archive size={13} /> {get('archived') ? 'Restore' : 'Archive'}</button>
            <button onClick={() => { if (confirm(`Delete ${selected.size} saves from Resurfly?`)) bulk.mutate({ action: 'delete' }); }} className="btn btn-sm btn-danger"><Trash2 size={13} /></button>
            <button onClick={() => setSelected(new Set())} className="btn btn-ghost btn-sm"><X size={13} /></button>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Results */}
      {query.isLoading ? (
        <div className={cn(view === 'grid' ? 'grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-4' : 'space-y-2')}>
          {Array.from({ length: 10 }).map((_, i) => <Skeleton key={i} className={view === 'grid' ? 'aspect-[4/6] w-full rounded-2xl' : 'h-16 w-full'} />)}
        </div>
      ) : items.length === 0 ? (
        <Empty title={get('q') || activeFilters.length ? 'No saves match' : 'Your library is empty'} body={get('q') || activeFilters.length ? 'Try a broader search, or turn on "meaning" search to find semantically similar saves.' : 'Import your Instagram saves to get started. It takes two minutes.'} action={!get('q') && !activeFilters.length ? <a href="/import" className="btn btn-primary">Import saves</a> : <button onClick={clearAll} className="btn">Clear filters</button>} />
      ) : (
        <>
          <div className="mb-3 flex items-center justify-between text-[12px] text-muted">
            <span>{items.length} of {total} shown{get('q') ? ` for “${get('q')}”` : ''}</span>
            <button onClick={() => setSelected(selected.size === items.length ? new Set() : new Set(items.map((i) => i.id)))} className="inline-flex items-center gap-1 hover:text-ink">{selected.size === items.length ? <CheckSquare size={13} /> : <Square size={13} />} {selected.size === items.length ? 'Deselect all' : 'Select all loaded'} <span className="hidden sm:inline text-muted-2">· ⌘/ctrl-click cards to multi-select</span></button>
          </div>
          {view === 'grid' ? (
            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-4">
              {items.map((it, i) => <ItemCard key={it.id} item={it} index={i} selected={selected.has(it.id)} onSelect={onSelect} />)}
            </div>
          ) : (
            <div className="space-y-1">
              {items.map((it, i) => <ItemCard key={it.id} item={it} index={i} selected={selected.has(it.id)} onSelect={onSelect} view="list" />)}
            </div>
          )}
          <div ref={sentinel} className="h-10" />
          {query.isFetchingNextPage && <div className="py-6 text-center text-[12px] text-muted">Loading more…</div>}
        </>
      )}
      {/* category legend for context */}
      {!query.isLoading && items.length > 0 && get('category') && (
        <div className="mt-6 text-[12px] text-muted inline-flex items-center gap-2"><CategoryDot category={get('category')} /> Showing {get('category')}</div>
      )}
    </div>
  );
}
