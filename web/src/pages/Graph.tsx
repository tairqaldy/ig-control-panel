import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import ForceGraph2D, { type ForceGraphMethods } from 'react-force-graph-2d';
import { forceX, forceY, forceCollide } from 'd3-force';
import { AnimatePresence, motion } from 'motion/react';
import { Search, X, Maximize2, RotateCcw, Focus, MousePointerClick, SlidersHorizontal, ChevronLeft, AlertCircle, RefreshCw } from 'lucide-react';
import { api, qs } from '../lib/api';
import type { GraphData, GraphNode, GraphLink, Facets } from '../lib/types';
import { useItemModal, useTheme } from '../lib/store';
import { categoryHue, cn } from '../lib/utils';
import { Skeleton, Toggle, CategoryDot } from '../components/ui';
import { AnalysisEmpty } from '../components/Onboarding';

type N = GraphNode & { x?: number; y?: number; vx?: number; vy?: number; __r?: number; fx?: number; fy?: number };
type L = GraphLink & { source: N | string; target: N | string };

const imgCache = new Map<string, HTMLImageElement>();
function getImg(src: string): HTMLImageElement {
  let im = imgCache.get(src);
  if (!im) { im = new Image(); im.src = src; im.decoding = 'async'; imgCache.set(src, im); }
  return im;
}
const idOf = (x: N | string) => (typeof x === 'object' ? x.id : x);
const FONT_UI = 'Instrument Sans Variable, ui-sans-serif, system-ui, sans-serif';
const FONT_MONO = 'Geist Mono Variable, ui-monospace, monospace';

/**
 * The knowledge graph. Full-bleed canvas; controls float over it. Categories are laid out on a ring and
 * their saves are gently pulled toward them (forceX/forceY), so the picture reads as clusters, not spaghetti.
 */
export default function Graph() {
  const fgRef = useRef<ForceGraphMethods<N, L> | undefined>(undefined);
  const wrapRef = useRef<HTMLDivElement>(null);
  const modal = useItemModal();
  const { theme } = useTheme();
  const dark = theme === 'dark';
  const [dims, setDims] = useState({ w: 800, h: 600 });
  const [showTags, setShowTags] = useState(true);
  const [showAuthors, setShowAuthors] = useState(false);
  const [showSimilar, setShowSimilar] = useState(true);
  const [minTag, setMinTag] = useState(3);
  const [maxItems, setMaxItems] = useState(600);
  const [category, setCategory] = useState('');
  const [query, setQuery] = useState('');
  const [hover, setHover] = useState<N | null>(null);
  const [focus, setFocus] = useState<N | null>(null);
  const [panel, setPanel] = useState<'none' | 'settings'>('none');
  const [engineRunning, setEngineRunning] = useState(true);
  const fittedRef = useRef(false);
  const hoverIdRef = useRef<string | null>(null);
  const facets = useQuery({ queryKey: ['facets'], queryFn: () => api.get<Facets>('/api/facets'), staleTime: 60_000 });
  const gq = useQuery({ queryKey: ['graph', minTag, category, showSimilar, maxItems], queryFn: () => api.get<GraphData>(`/api/graph${qs({ min_tag: minTag, category, similar: showSimilar ? 1 : 0, max_items: maxItems, tags_per_item: 3, similar_per_item: 2 })}`), staleTime: 60_000 });

  useEffect(() => {
    const el = wrapRef.current; if (!el) return;
    const ro = new ResizeObserver(() => setDims({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    setDims({ w: el.clientWidth, h: el.clientHeight });
    return () => ro.disconnect();
  }, []);

  // Filter by toggles
  const data = useMemo(() => {
    if (!gq.data) return { nodes: [] as N[], links: [] as L[] };
    const keep = (n: GraphNode) => (n.type === 'tag' ? showTags : n.type === 'author' ? showAuthors : true);
    const nodes = gq.data.nodes.filter(keep).map((n) => ({ ...n })) as N[];
    const ids = new Set(nodes.map((n) => n.id));
    const links = gq.data.links.filter((l) => ids.has(l.source as string) && ids.has(l.target as string) && (l.kind !== 'similar' || showSimilar)).map((l) => ({ ...l })) as L[];
    return { nodes, links };
  }, [gq.data, showTags, showAuthors, showSimilar]);

  const categories = useMemo(() => Array.from(new Set(data.nodes.filter((n) => n.type === 'item').map((n) => n.category || 'Other'))).sort(), [data.nodes]);
  const catCenter = useMemo(() => {
    const m = new Map<string, { x: number; y: number }>();
    const R = Math.min(dims.w, dims.h) * 0.9;
    categories.forEach((c, i) => { const a = (i / Math.max(1, categories.length)) * Math.PI * 2 - Math.PI / 2; m.set(c, { x: Math.cos(a) * R, y: Math.sin(a) * R }); });
    return m;
  }, [categories, dims.w, dims.h]);

  const neighbors = useMemo(() => {
    const m = new Map<string, Set<string>>();
    for (const l of data.links) {
      const s = idOf(l.source), t = idOf(l.target);
      if (!m.has(s)) m.set(s, new Set()); if (!m.has(t)) m.set(t, new Set());
      m.get(s)!.add(t); m.get(t)!.add(s);
    }
    return m;
  }, [data.links]);

  const matchIds = useMemo(() => {
    if (!query.trim()) return null;
    const q = query.toLowerCase();
    return new Set(data.nodes.filter((n) => n.label.toLowerCase().includes(q) || (n.tags || []).some((t) => t.includes(q)) || (n.author || '').includes(q) || (n.category || '').toLowerCase().includes(q)).map((n) => n.id));
  }, [query, data.nodes]);

  // Forces: charge by type, link distances, category attraction, collision
  useEffect(() => {
    const fg = fgRef.current; if (!fg) return;
    fittedRef.current = false;
    setEngineRunning(true);
    fg.d3Force('charge')?.strength((n: any) => (n.type === 'category' ? -300 : n.type === 'tag' ? -90 : n.type === 'author' ? -70 : -18));
    fg.d3Force('link')?.distance((l: any) => (l.kind === 'category' ? 70 : l.kind === 'similar' ? 26 : l.kind === 'author' ? 50 : 40)).strength((l: any) => (l.kind === 'similar' ? 0.4 : l.kind === 'category' ? 0.08 : 0.45));
    const cx = (n: any) => (n.type === 'category' ? catCenter.get(n.label)?.x : catCenter.get(n.category)?.x) ?? 0;
    const cy = (n: any) => (n.type === 'category' ? catCenter.get(n.label)?.y : catCenter.get(n.category)?.y) ?? 0;
    fg.d3Force('x', forceX<any>().x(cx).strength((n: any) => (n.type === 'item' ? 0.06 : n.type === 'category' ? 0.5 : 0.01)));
    fg.d3Force('y', forceY<any>().y(cy).strength((n: any) => (n.type === 'item' ? 0.06 : n.type === 'category' ? 0.5 : 0.01)));
    fg.d3Force('collide', forceCollide<any>().radius((n: any) => (n.type === 'category' ? 26 : n.type === 'tag' ? 8 : n.type === 'author' ? 8 : 5)).strength(0.7));
    fg.d3ReheatSimulation();
  }, [data, catCenter]);

  const activeSet = useMemo(() => {
    const src = focus || hover;
    if (!src) return null;
    const s = new Set<string>([src.id]);
    for (const id of neighbors.get(src.id) || []) s.add(id);
    return s;
  }, [focus, hover, neighbors]);

  const paint = useCallback((node: N, ctx: CanvasRenderingContext2D, scale: number) => {
    const x = node.x ?? 0, y = node.y ?? 0;
    const dimmed = (activeSet && !activeSet.has(node.id)) || (matchIds && !matchIds.has(node.id));
    ctx.globalAlpha = dimmed ? 0.1 : 1;
    const ink = dark ? '#edeae2' : '#17161a';
    const muted = dark ? '#8f8b81' : '#8b877d';
    const label = (text: string, r: number, font: string, color: string, size: number) => { ctx.font = `${size}px ${font}`; ctx.fillStyle = color; ctx.textAlign = 'center'; ctx.textBaseline = 'top'; ctx.fillText(text.length > 36 ? text.slice(0, 35) + '…' : text, x, y + r + 2 / scale); };
    if (node.type === 'item') {
      const r = 3 + Math.max(0, (node.useful || 5) - 5) * 0.4;
      const color = `oklch(${dark ? 0.72 : 0.55} 0.13 ${categoryHue(node.category)})`;
      const isActive = activeSet?.has(node.id);
      if (scale >= 1.5 && node.thumb) {
        const im = getImg(node.thumb);
        const R = r * 2.4; node.__r = R;
        ctx.save(); ctx.beginPath(); ctx.arc(x, y, R, 0, Math.PI * 2); ctx.closePath(); ctx.clip();
        if (im.complete && im.naturalWidth) { const s = Math.max((R * 2) / im.naturalWidth, (R * 2) / im.naturalHeight); const w = im.naturalWidth * s, h = im.naturalHeight * s; ctx.drawImage(im, x - w / 2, y - h / 2, w, h); }
        else { ctx.fillStyle = color; ctx.fillRect(x - R, y - R, R * 2, R * 2); }
        ctx.restore();
        ctx.beginPath(); ctx.arc(x, y, R, 0, Math.PI * 2); ctx.lineWidth = (isActive ? 2.4 : 1.2) / scale; ctx.strokeStyle = isActive ? (dark ? '#4fd39a' : '#177a4c') : color; ctx.stroke();
        if (scale >= 2.6 || isActive) label(node.label, R, FONT_UI, ink, Math.max(2.4, 11 / scale));
      } else {
        node.__r = r;
        ctx.beginPath(); ctx.arc(x, y, isActive ? r * 1.4 : r, 0, Math.PI * 2); ctx.fillStyle = color; ctx.fill();
        if (isActive && scale >= 0.8) label(node.label, r, FONT_UI, ink, Math.max(2.4, 11 / scale));
      }
    } else if (node.type === 'category') {
      const r = 10 + Math.sqrt(node.count || 1) * 1.1; node.__r = r;
      const color = `oklch(${dark ? 0.72 : 0.55} 0.13 ${categoryHue(node.label)})`;
      ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fillStyle = dark ? '#1a1a18' : '#fbfaf6'; ctx.fill(); ctx.lineWidth = 2 / Math.max(1, scale * 0.6); ctx.strokeStyle = color; ctx.stroke();
      ctx.font = `600 ${Math.max(3, 12 / Math.sqrt(scale))}px ${FONT_UI}`; ctx.fillStyle = ink; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      const words = node.label.split(' & ');
      if (scale < 1.2 && words.length > 1) { ctx.fillText(words[0], x, y - 5 / Math.sqrt(scale)); ctx.fillText('& ' + words.slice(1).join(' & '), x, y + 7 / Math.sqrt(scale)); }
      else ctx.fillText(node.label, x, y);
    } else if (node.type === 'tag') {
      const r = 2.5 + Math.sqrt(node.count || 1) * 0.9; node.__r = r;
      ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fillStyle = dark ? '#4fd39a' : '#177a4c'; ctx.fill();
      if (scale >= 1.1 || (node.count || 0) >= 8 || activeSet?.has(node.id)) label(`#${node.label}`, r, FONT_MONO, dark ? '#c9c4b8' : '#4a4843', Math.max(2.4, 10.5 / scale));
    } else {
      const r = 3 + Math.sqrt(node.count || 1) * 0.9; node.__r = r;
      ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fillStyle = dark ? '#e0a84a' : '#b7791f'; ctx.fill();
      if (scale >= 1.3 || (node.count || 0) >= 6 || activeSet?.has(node.id)) label(node.label, r, FONT_UI, muted, Math.max(2.4, 10.5 / scale));
    }
    ctx.globalAlpha = 1;
  }, [activeSet, matchIds, dark]);

  const focusOn = useCallback((node: N | null) => {
    setFocus(node);
    const fg = fgRef.current; if (!fg || !node) return;
    // zoom so the node and its neighbours fill the view
    const ids = new Set([node.id, ...(neighbors.get(node.id) || [])]);
    fg.zoomToFit(600, 60, (n: any) => ids.has(n.id));
  }, [neighbors]);

  const onNodeClick = useCallback((node: N) => {
    if (node.type === 'item') { modal.open(node.id); return; }
    if (focus?.id === node.id) { setFocus(null); fgRef.current?.zoomToFit(500, 30); return; }
    focusOn(node);
  }, [modal, focus, focusOn]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { setFocus(null); setQuery(''); } };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const focusCategory = (cat: string) => {
    const node = data.nodes.find((n) => n.type === 'category' && n.label === cat) || null;
    if (node) focusOn(node);
  };

  const legend = [
    { label: 'Save (color: category, size: usefulness)', color: 'oklch(0.55 0.13 210)' },
    { label: 'Category hub', color: dark ? '#edeae2' : '#17161a' },
    { label: 'Tag', color: dark ? '#4fd39a' : '#177a4c' },
    { label: 'Creator', color: dark ? '#e0a84a' : '#b7791f' },
  ];
  const meta = gq.data?.meta;

  return (
    <div ref={wrapRef} className="relative -mx-4 sm:-mx-6 lg:-mx-8 -my-6 lg:-my-8 h-[calc(100vh-3.5rem)] lg:h-screen overflow-hidden bg-surface">
      {gq.isLoading ? <Skeleton className="absolute inset-0" /> : gq.isError ? (
        <div className="absolute inset-0 grid place-items-center p-8">
          <div className="text-center flex flex-col items-center gap-3 max-w-sm">
            <AlertCircle size={24} className="text-danger" />
            <div className="display text-[22px]">The graph did not load</div>
            <div className="text-[13px] text-muted">{(gq.error as Error)?.message || 'The server did not answer.'}</div>
            <button onClick={() => gq.refetch()} className="btn btn-primary mt-1"><RefreshCw size={14} /> Try again</button>
          </div>
        </div>
      ) : data.nodes.length === 0 ? (
        <div className="absolute inset-0 grid place-items-center p-8"><AnalysisEmpty page="graph" filtered={!!category || (!!gq.data && gq.data.meta.items > 0)} onClearFilters={() => { setCategory(''); setMinTag(2); setShowTags(true); setShowSimilar(true); }} className="w-full max-w-lg !border-0 !bg-transparent" /></div>
      ) : (
        <ForceGraph2D
          ref={fgRef as any}
          width={dims.w}
          height={dims.h}
          graphData={data as any}
          backgroundColor="rgba(0,0,0,0)"
          nodeCanvasObject={paint as any}
          nodePointerAreaPaint={(node: any, color, ctx) => { const r = (node.__r || 4) + 2; ctx.fillStyle = color; ctx.beginPath(); ctx.arc(node.x, node.y, r, 0, Math.PI * 2); ctx.fill(); }}
          linkColor={(l: any) => { const s = idOf(l.source), t = idOf(l.target); const active = activeSet ? activeSet.has(s) && activeSet.has(t) : true; const a = active ? (l.kind === 'similar' ? 0.4 : l.kind === 'category' ? 0.07 : 0.2) : 0.025; return dark ? `rgba(237,234,226,${a})` : `rgba(23,22,26,${a})`; }}
          linkWidth={(l: any) => (l.kind === 'similar' ? 1.3 : 0.6)}
          linkDirectionalParticles={(l: any) => { if (l.kind !== 'similar' || !activeSet) return 0; return activeSet.has(idOf(l.source)) && activeSet.has(idOf(l.target)) ? 1 : 0; }}
          linkDirectionalParticleWidth={1.8}
          onNodeHover={(n: any) => { if ((n?.id || null) !== (hoverIdRef.current || null)) { hoverIdRef.current = n?.id || null; setHover(n || null); } if (wrapRef.current) wrapRef.current.style.cursor = n ? 'pointer' : 'grab'; }}
          onNodeClick={onNodeClick as any}
          onBackgroundClick={() => setFocus(null)}
          onEngineStop={() => { setEngineRunning(false); if (!fittedRef.current) { fittedRef.current = true; fgRef.current?.zoomToFit(600, 40); } }}
          cooldownTicks={160}
          warmupTicks={80}
          d3AlphaDecay={0.04}
          d3VelocityDecay={0.42}
          minZoom={0.15}
          maxZoom={12}
          enableNodeDrag
        />
      )}

      {/* Top bar: title + search + category chips */}
      <div className="pointer-events-none absolute inset-x-0 top-0 p-3 sm:p-4 flex flex-col gap-2">
        <div className="flex items-center gap-2 flex-wrap">
          <div className="pointer-events-auto card px-3 sm:px-3.5 py-1.5 sm:py-2 flex items-center gap-3 min-w-0">
            <div className="min-w-0">
              <div className="eyebrow hidden sm:block">Knowledge graph</div>
              <div className="display text-[17px] sm:text-[20px] leading-tight truncate">The shape of your <em className="text-accent not-italic">taste</em></div>
            </div>
            {meta && <div className="hidden md:block text-[11px] text-muted font-mono border-l border-line pl-3 whitespace-nowrap">{meta.items} saves · {meta.tags} tags{showAuthors ? ` · ${meta.authors} creators` : ''} · {data.links.length} links</div>}
          </div>
          <div className="pointer-events-auto card px-2 py-1.5 flex items-center gap-1.5 flex-1 sm:flex-none min-w-[140px] max-w-xs">
            <Search size={14} className="text-muted ml-1 shrink-0" />
            <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Highlight a title, tag or creator" aria-label="Highlight nodes" className="bg-transparent text-[13px] outline-none w-full sm:w-52 placeholder:text-muted-2 min-w-0" />
            {query && <button onClick={() => setQuery('')} className="btn btn-ghost btn-sm !px-1" aria-label="Clear highlight"><X size={13} /></button>}
          </div>
          <div className="pointer-events-auto ml-auto flex items-center gap-1.5">
            <button onClick={() => setPanel(panel === 'settings' ? 'none' : 'settings')} aria-expanded={panel === 'settings'} className={cn('btn btn-sm', panel === 'settings' && 'chip-active border-accent')}><SlidersHorizontal size={13} /> Tune</button>
            <button onClick={() => { setFocus(null); fgRef.current?.zoomToFit(600, 40); }} className="btn btn-sm" title="Fit to screen" aria-label="Fit to screen"><Maximize2 size={13} /></button>
          </div>
        </div>
        {/* Category chips: one click to focus a cluster (single scrolling row on phones) */}
        <div className="pointer-events-auto flex flex-nowrap sm:flex-wrap gap-1.5 max-w-4xl overflow-x-auto sm:overflow-visible pb-1 -mx-3 px-3 sm:mx-0 sm:px-0" role="group" aria-label="Focus a category">
          {categories.map((c) => (
            <button key={c} onClick={() => (focus?.type === 'category' && focus.label === c ? (setFocus(null), fgRef.current?.zoomToFit(600, 40)) : focusCategory(c))} aria-pressed={focus?.type === 'category' && focus.label === c} className={cn('chip shrink-0', focus?.type === 'category' && focus.label === c && 'chip-active')}><CategoryDot category={c} />{c}</button>
          ))}
        </div>
      </div>

      {/* Focus banner */}
      <AnimatePresence>
        {focus && (
          <motion.div initial={{ opacity: 0, y: -6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -6 }} className="absolute left-3 sm:left-4 right-3 sm:right-auto bottom-3 sm:bottom-auto sm:top-[104px] card px-3 py-2 flex items-center gap-2 text-[12.5px] sm:max-w-sm">
            <Focus size={13} className="text-accent shrink-0" /> <span className="truncate"><b>{focus.type === 'tag' ? `#${focus.label}` : focus.label}</b> <span className="text-muted">· {neighbors.get(focus.id)?.size ?? 0} connected</span></span>
            <button onClick={() => { setFocus(null); fgRef.current?.zoomToFit(600, 40); }} className="btn btn-ghost btn-sm !px-1 shrink-0"><ChevronLeft size={13} /> All</button>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Right panels */}
      <AnimatePresence>
        {panel === 'settings' && (
          <motion.div initial={{ opacity: 0, x: 12 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: 12 }} className="absolute right-3 sm:right-4 top-[58px] sm:top-[62px] card p-4 w-[calc(100vw-1.5rem)] sm:w-72 max-h-[calc(100%-5rem)] overflow-y-auto space-y-3 text-[13px]" role="dialog" aria-label="Tune the graph">
            <div className="flex items-center"><div className="eyebrow">Tune</div><button onClick={() => setPanel('none')} className="btn btn-ghost btn-sm !px-1 ml-auto -mr-1" aria-label="Close"><X size={13} /></button></div>
            <select value={category} onChange={(e) => setCategory(e.target.value)} aria-label="Category" className="input !py-1.5"><option value="">All categories</option>{(facets.data?.categories || []).map((c) => <option key={c.name} value={c.name}>{c.name} ({c.n})</option>)}</select>
            <Toggle checked={showTags} onChange={setShowTags} label="Tags" />
            <Toggle checked={showAuthors} onChange={setShowAuthors} label="Creators" />
            <Toggle checked={showSimilar} onChange={setShowSimilar} label="Similarity links" />
            <label className="flex items-center justify-between gap-2 text-ink-2">Min tag uses <input type="range" min={1} max={12} value={minTag} onChange={(e) => setMinTag(Number(e.target.value))} className="accent-[var(--accent)] w-28" /><span className="font-mono text-[11px] text-muted w-4">{minTag}</span></label>
            <label className="flex items-center justify-between gap-2 text-ink-2" title="Most recent saves shown. Fewer is smoother.">Saves shown <input type="range" min={100} max={3000} step={100} value={maxItems} onChange={(e) => setMaxItems(Number(e.target.value))} className="accent-[var(--accent)] w-28" /><span className="font-mono text-[11px] text-muted w-9">{maxItems}</span></label>
            <button onClick={() => fgRef.current?.d3ReheatSimulation()} className="btn btn-sm w-full"><RotateCcw size={13} /> Shake the layout</button>
            <div className="border-t border-line pt-3">
              <div className="eyebrow mb-1.5">Legend</div>
              {legend.map((l) => <div key={l.label} className="flex items-center gap-2 py-0.5 text-[12.5px]"><span className="h-2.5 w-2.5 rounded-full shrink-0" style={{ background: l.color }} />{l.label}</div>)}
              <div className="mt-2 text-[11.5px] text-muted leading-snug">Thin links: shared tags or creator. Thicker links with moving dots: similar meaning. Categories sit on a ring; their saves gather around them.</div>
            </div>
            <div className="text-[11.5px] text-muted leading-snug border-t border-line pt-3">Scroll to zoom, drag to pan, drag nodes to rearrange. Click a save to open it, a tag or category to focus, Esc to clear.</div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Hover card */}
      <AnimatePresence>
        {hover && hover.type === 'item' && (
          <motion.div initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: 6 }} className="pointer-events-none absolute left-3 sm:left-4 bottom-3 sm:bottom-4 flex max-w-sm items-center gap-3 card p-2.5">
            {hover.thumb && <img src={hover.thumb} alt="" className="h-16 w-12 rounded-md object-cover" />}
            <div className="min-w-0"><div className="text-[13px] font-medium leading-snug clamp-2">{hover.label}</div><div className="mt-0.5 flex items-center gap-1.5 text-[11px] text-muted"><CategoryDot category={hover.category} />{hover.category}{hover.author ? ` · @${hover.author}` : ''}</div>{hover.tags && <div className="mt-1 text-[10.5px] text-muted truncate">{hover.tags.slice(0, 5).map((t) => `#${t}`).join(' ')}</div>}<div className="mt-1 text-[10.5px] text-accent inline-flex items-center gap-1"><MousePointerClick size={10} /> click to open</div></div>
          </motion.div>
        )}
        {hover && hover.type !== 'item' && (
          <motion.div initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: 6 }} className="pointer-events-none absolute left-3 sm:left-4 bottom-3 sm:bottom-4 card px-3 py-2 text-[12.5px]">
            <span className="font-medium">{hover.type === 'tag' ? `#${hover.label}` : hover.label}</span> <span className="text-muted">· {hover.count} saves · click to focus</span>
          </motion.div>
        )}
      </AnimatePresence>

      {/* bottom-right status */}
      <div className="absolute right-3 sm:right-4 bottom-3 sm:bottom-4 hidden sm:flex items-center gap-2 text-[10.5px] font-mono text-muted">
        {engineRunning && <span className="inline-flex items-center gap-1"><span className="h-1.5 w-1.5 rounded-full bg-accent pulse-dot" /> settling</span>}
        <span>{data.nodes.length} nodes · {data.links.length} links</span>
      </div>
    </div>
  );
}
