import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import ForceGraph2D, { type ForceGraphMethods } from 'react-force-graph-2d';
import { AnimatePresence, motion } from 'motion/react';
import { Search, X, Maximize2, RotateCcw, Waypoints, Info, Focus, MousePointerClick } from 'lucide-react';
import { api, qs } from '../lib/api';
import type { GraphData, GraphNode, GraphLink, Facets } from '../lib/types';
import { useItemModal, useTheme } from '../lib/store';
import { categoryHue, cn } from '../lib/utils';
import { PageHeader, Skeleton, Toggle, CategoryDot } from '../components/ui';

type N = GraphNode & { x?: number; y?: number; vx?: number; vy?: number; __img?: HTMLImageElement | null; __r?: number };
type L = GraphLink & { source: N | string; target: N | string };

const imgCache = new Map<string, HTMLImageElement>();
function getImg(src: string): HTMLImageElement {
  let im = imgCache.get(src);
  if (!im) { im = new Image(); im.src = src; im.decoding = 'async'; imgCache.set(src, im); }
  return im;
}

export default function Graph() {
  const fgRef = useRef<ForceGraphMethods<N, L> | undefined>(undefined);
  const wrapRef = useRef<HTMLDivElement>(null);
  const modal = useItemModal();
  const { theme } = useTheme();
  const dark = theme === 'dark';
  const [dims, setDims] = useState({ w: 800, h: 600 });
  const [showTags, setShowTags] = useState(true);
  const [showAuthors, setShowAuthors] = useState(true);
  const [showSimilar, setShowSimilar] = useState(true);
  const [minTag, setMinTag] = useState(3);
  const [category, setCategory] = useState('');
  const [query, setQuery] = useState('');
  const [hover, setHover] = useState<N | null>(null);
  const [focus, setFocus] = useState<N | null>(null);
  const [showHelp, setShowHelp] = useState(false);
  const fittedRef = useRef(false);
  const facets = useQuery({ queryKey: ['facets'], queryFn: () => api.get<Facets>('/api/facets'), staleTime: 60_000 });
  const gq = useQuery({ queryKey: ['graph', minTag, category, showSimilar], queryFn: () => api.get<GraphData>(`/api/graph${qs({ min_tag: minTag, category, similar: showSimilar ? 1 : 0, max_items: 2500 })}`), staleTime: 60_000 });

  useEffect(() => {
    const el = wrapRef.current; if (!el) return;
    const ro = new ResizeObserver(() => setDims({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    setDims({ w: el.clientWidth, h: el.clientHeight });
    return () => ro.disconnect();
  }, []);

  // Filter data by toggles; compute neighbor maps for hover highlighting
  const data = useMemo(() => {
    if (!gq.data) return { nodes: [] as N[], links: [] as L[] };
    const keep = (n: GraphNode) => (n.type === 'tag' ? showTags : n.type === 'author' ? showAuthors : true);
    const nodes = gq.data.nodes.filter(keep).map((n) => ({ ...n })) as N[];
    const ids = new Set(nodes.map((n) => n.id));
    const links = gq.data.links.filter((l) => ids.has(l.source as string) && ids.has(l.target as string) && (l.kind !== 'similar' || showSimilar)).map((l) => ({ ...l })) as L[];
    return { nodes, links };
  }, [gq.data, showTags, showAuthors, showSimilar]);

  const neighbors = useMemo(() => {
    const m = new Map<string, Set<string>>();
    for (const l of data.links) {
      const s = typeof l.source === 'object' ? (l.source as N).id : (l.source as string); const t = typeof l.target === 'object' ? (l.target as N).id : (l.target as string);
      if (!m.has(s)) m.set(s, new Set()); if (!m.has(t)) m.set(t, new Set());
      m.get(s)!.add(t); m.get(t)!.add(s);
    }
    return m;
  }, [data.links]);

  const matchIds = useMemo(() => {
    if (!query.trim()) return null;
    const q = query.toLowerCase();
    return new Set(data.nodes.filter((n) => n.label.toLowerCase().includes(q) || (n.tags || []).some((t) => t.includes(q)) || (n.author || '').includes(q)).map((n) => n.id));
  }, [query, data.nodes]);

  // Force tuning
  useEffect(() => {
    const fg = fgRef.current; if (!fg) return;
    fittedRef.current = false;
    fg.d3Force('charge')?.strength((n: any) => (n.type === 'category' ? -420 : n.type === 'tag' ? -140 : n.type === 'author' ? -100 : -28));
    fg.d3Force('link')?.distance((l: any) => (l.kind === 'category' ? 90 : l.kind === 'similar' ? 34 : l.kind === 'author' ? 60 : 48)).strength((l: any) => (l.kind === 'similar' ? 0.35 : l.kind === 'category' ? 0.15 : 0.5));
    fg.d3ReheatSimulation();
  }, [data]);

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
    const alpha = dimmed ? 0.12 : 1;
    const ink = dark ? '#edeae2' : '#17161a';
    const muted = dark ? '#8f8b81' : '#8b877d';
    ctx.globalAlpha = alpha;
    if (node.type === 'item') {
      const r = 3.2 + Math.max(0, (node.useful || 5) - 5) * 0.35;
      node.__r = r;
      const color = `oklch(${dark ? 0.72 : 0.55} 0.13 ${categoryHue(node.category)})`;
      if (scale >= 1.6 && node.thumb) {
        const im = getImg(node.thumb);
        const R = r * 2.2;
        ctx.save(); ctx.beginPath(); ctx.arc(x, y, R, 0, Math.PI * 2); ctx.closePath(); ctx.clip();
        if (im.complete && im.naturalWidth) { const s = Math.max((R * 2) / im.naturalWidth, (R * 2) / im.naturalHeight); const w = im.naturalWidth * s, h = im.naturalHeight * s; ctx.drawImage(im, x - w / 2, y - h / 2, w, h); }
        else { ctx.fillStyle = color; ctx.fillRect(x - R, y - R, R * 2, R * 2); }
        ctx.restore();
        ctx.beginPath(); ctx.arc(x, y, R, 0, Math.PI * 2); ctx.lineWidth = 1.2 / scale; ctx.strokeStyle = color; ctx.stroke();
        node.__r = R;
        if (scale >= 3 || activeSet?.has(node.id)) { ctx.font = `${Math.max(2.4, 11 / scale)}px Instrument Sans Variable, sans-serif`; ctx.fillStyle = ink; ctx.textAlign = 'center'; ctx.textBaseline = 'top'; ctx.fillText(node.label.length > 34 ? node.label.slice(0, 33) + '…' : node.label, x, y + R + 2 / scale); }
      } else {
        ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fillStyle = color; ctx.fill();
        if (activeSet?.has(node.id) && scale >= 0.9) { ctx.font = `${Math.max(2.4, 11 / scale)}px Instrument Sans Variable, sans-serif`; ctx.fillStyle = ink; ctx.textAlign = 'center'; ctx.textBaseline = 'top'; ctx.fillText(node.label.length > 34 ? node.label.slice(0, 33) + '…' : node.label, x, y + r + 2 / scale); }
      }
    } else if (node.type === 'category') {
      const r = 9 + Math.sqrt(node.count || 1) * 1.2; node.__r = r;
      const color = `oklch(${dark ? 0.72 : 0.55} 0.13 ${categoryHue(node.label)})`;
      ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fillStyle = dark ? '#1a1a18' : '#fbfaf6'; ctx.fill(); ctx.lineWidth = 2 / Math.max(1, scale * 0.6); ctx.strokeStyle = color; ctx.stroke();
      ctx.font = `600 ${Math.max(3, 12 / Math.sqrt(scale))}px Instrument Sans Variable, sans-serif`; ctx.fillStyle = ink; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      const label = node.label.replace(' & ', ' & ');
      ctx.fillText(label.length > 22 && scale < 1.5 ? label.split(' ')[0] : label, x, y);
    } else if (node.type === 'tag') {
      const r = 2.5 + Math.sqrt(node.count || 1) * 0.9; node.__r = r;
      ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fillStyle = dark ? '#4fd39a' : '#177a4c'; ctx.fill();
      if (scale >= 1.2 || (node.count || 0) >= 8 || activeSet?.has(node.id)) { ctx.font = `${Math.max(2.4, 10.5 / scale)}px Geist Mono Variable, monospace`; ctx.fillStyle = dark ? '#c9c4b8' : '#4a4843'; ctx.textAlign = 'center'; ctx.textBaseline = 'top'; ctx.fillText(`#${node.label}`, x, y + r + 1.5 / scale); }
    } else {
      const r = 3 + Math.sqrt(node.count || 1) * 0.9; node.__r = r;
      ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fillStyle = dark ? '#e0a84a' : '#b7791f'; ctx.fill();
      if (scale >= 1.4 || (node.count || 0) >= 6 || activeSet?.has(node.id)) { ctx.font = `${Math.max(2.4, 10.5 / scale)}px Instrument Sans Variable, sans-serif`; ctx.fillStyle = muted; ctx.textAlign = 'center'; ctx.textBaseline = 'top'; ctx.fillText(node.label, x, y + r + 1.5 / scale); }
    }
    ctx.globalAlpha = 1;
  }, [activeSet, matchIds, dark]);

  const onNodeClick = useCallback((node: N) => {
    if (node.type === 'item') { modal.open(node.id); return; }
    setFocus((f) => (f?.id === node.id ? null : node));
    fgRef.current?.centerAt(node.x, node.y, 600);
    fgRef.current?.zoom(Math.max(2.2, fgRef.current.zoom()), 600);
  }, [modal]);

  const legend = [
    { label: 'Save', color: 'oklch(0.55 0.13 210)' },
    { label: 'Category', color: dark ? '#edeae2' : '#17161a' },
    { label: 'Tag', color: dark ? '#4fd39a' : '#177a4c' },
    { label: 'Creator', color: dark ? '#e0a84a' : '#b7791f' },
  ];

  return (
    <div className="flex flex-col h-[calc(100vh-5.5rem)] lg:h-[calc(100vh-4rem)]">
      <PageHeader eyebrow="Knowledge graph" title={<>The shape of your <em className="text-accent not-italic">taste</em></>} subtitle={gq.data ? `${gq.data.meta.items} saves · ${gq.data.meta.tags} tags · ${gq.data.meta.authors} creators · ${gq.data.meta.categories} categories. Hover to highlight, click a save to open it, click a tag/category to focus. Zoom in to see thumbnails.` : undefined}
        actions={<><button onClick={() => setShowHelp((s) => !s)} className="btn btn-sm"><Info size={13} /> Legend</button><button onClick={() => { setFocus(null); fgRef.current?.zoomToFit(600, 40); }} className="btn btn-sm"><Maximize2 size={13} /> Fit</button><button onClick={() => { fgRef.current?.d3ReheatSimulation(); }} className="btn btn-sm"><RotateCcw size={13} /> Shake</button></>} />
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <div className="relative">
          <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted" />
          <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Highlight nodes…" className="input !pl-8 !py-1.5 w-56" />
          {query && <button onClick={() => setQuery('')} className="absolute right-1.5 top-1/2 -translate-y-1/2 text-muted"><X size={13} /></button>}
        </div>
        <select value={category} onChange={(e) => setCategory(e.target.value)} className="input !py-1.5 w-52">
          <option value="">All categories</option>
          {(facets.data?.categories || []).map((c) => <option key={c.name} value={c.name}>{c.name} ({c.n})</option>)}
        </select>
        <Toggle checked={showTags} onChange={setShowTags} label="Tags" />
        <Toggle checked={showAuthors} onChange={setShowAuthors} label="Creators" />
        <Toggle checked={showSimilar} onChange={setShowSimilar} label="Similarity links" />
        <label className="inline-flex items-center gap-2 text-[13px] text-ink-2">Min tag uses <input type="range" min={1} max={12} value={minTag} onChange={(e) => setMinTag(Number(e.target.value))} className="accent-[var(--accent)]" /><span className="font-mono text-[11px] text-muted w-4">{minTag}</span></label>
        {focus && <button onClick={() => setFocus(null)} className="btn btn-sm chip-active border-accent"><Focus size={13} /> Focus: {focus.label} <X size={12} /></button>}
      </div>
      <div ref={wrapRef} className="relative flex-1 min-h-[420px] overflow-hidden rounded-2xl border border-line bg-surface" style={{ boxShadow: 'var(--shadow)' }}>
        {gq.isLoading ? <Skeleton className="absolute inset-0 rounded-2xl" /> : data.nodes.length === 0 ? (
          <div className="absolute inset-0 grid place-items-center text-center p-8"><div><Waypoints size={28} className="mx-auto text-muted mb-3" /><div className="display text-[22px]">No graph yet</div><div className="text-[13px] text-muted mt-1">The graph appears once saves are analyzed (it’s built from AI tags, categories, creators and embedding similarity).</div></div></div>
        ) : (
          <ForceGraph2D
            ref={fgRef as any}
            width={dims.w}
            height={dims.h}
            graphData={data as any}
            backgroundColor="rgba(0,0,0,0)"
            nodeCanvasObject={paint as any}
            nodePointerAreaPaint={(node: any, color, ctx) => { const r = (node.__r || 4) + 2; ctx.fillStyle = color; ctx.beginPath(); ctx.arc(node.x, node.y, r, 0, Math.PI * 2); ctx.fill(); }}
            linkColor={(l: any) => { const s = typeof l.source === 'object' ? l.source.id : l.source; const t = typeof l.target === 'object' ? l.target.id : l.target; const active = activeSet ? activeSet.has(s) && activeSet.has(t) : true; const a = active ? (l.kind === 'similar' ? 0.35 : l.kind === 'category' ? 0.10 : 0.22) : 0.03; return dark ? `rgba(237,234,226,${a})` : `rgba(23,22,26,${a})`; }}
            linkWidth={(l: any) => (l.kind === 'similar' ? 1.2 : 0.6)}
            linkDirectionalParticles={(l: any) => (l.kind === 'similar' && activeSet ? 1 : 0)}
            linkDirectionalParticleWidth={1.6}
            onNodeHover={(n: any) => { setHover(n || null); if (wrapRef.current) wrapRef.current.style.cursor = n ? 'pointer' : 'grab'; }}
            onNodeClick={onNodeClick as any}
            onBackgroundClick={() => setFocus(null)}
            onEngineStop={() => { if (!fittedRef.current) { fittedRef.current = true; fgRef.current?.zoomToFit(500, 30); } }}
            cooldownTicks={220}
            warmupTicks={40}
            d3AlphaDecay={0.028}
            d3VelocityDecay={0.34}
            enableNodeDrag
          />
        )}
        {/* hover card */}
        <AnimatePresence>
          {hover && hover.type === 'item' && (
            <motion.div initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: 6 }} className="pointer-events-none absolute left-3 bottom-3 flex max-w-sm items-center gap-3 rounded-xl border border-line bg-surface p-2.5" style={{ boxShadow: 'var(--shadow-lg)' }}>
              {hover.thumb && <img src={hover.thumb} alt="" className="h-16 w-12 rounded-md object-cover" />}
              <div className="min-w-0"><div className="text-[13px] font-medium leading-snug clamp-2">{hover.label}</div><div className="mt-0.5 flex items-center gap-1.5 text-[11px] text-muted"><CategoryDot category={hover.category} />{hover.category}{hover.author ? ` · @${hover.author}` : ''}</div>{hover.tags && <div className="mt-1 text-[10.5px] text-muted truncate">{hover.tags.slice(0, 5).map((t) => `#${t}`).join(' ')}</div>}<div className="mt-1 text-[10.5px] text-accent inline-flex items-center gap-1"><MousePointerClick size={10} /> click to open</div></div>
            </motion.div>
          )}
          {hover && hover.type !== 'item' && (
            <motion.div initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: 6 }} className="pointer-events-none absolute left-3 bottom-3 rounded-xl border border-line bg-surface px-3 py-2 text-[12.5px]" style={{ boxShadow: 'var(--shadow-lg)' }}>
              <span className="font-medium">{hover.type === 'tag' ? `#${hover.label}` : hover.label}</span> <span className="text-muted">· {hover.count} saves · click to focus</span>
            </motion.div>
          )}
        </AnimatePresence>
        <AnimatePresence>
          {showHelp && (
            <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="absolute right-3 top-3 rounded-xl border border-line bg-surface p-3 text-[12px]" style={{ boxShadow: 'var(--shadow-lg)' }}>
              {legend.map((l) => <div key={l.label} className="flex items-center gap-2 py-0.5"><span className="h-2.5 w-2.5 rounded-full" style={{ background: l.color }} />{l.label}</div>)}
              <div className="mt-2 text-muted max-w-[200px] leading-snug">Save color = category. Size = usefulness (saves) or count (tags/creators). Thin links = tags/creators; thicker links = semantic similarity.</div>
            </motion.div>
          )}
        </AnimatePresence>
        <div className={cn('absolute right-3 bottom-3 text-[10.5px] font-mono text-muted', !gq.data && 'hidden')}>{data.nodes.length} nodes · {data.links.length} links</div>
      </div>
    </div>
  );
}
