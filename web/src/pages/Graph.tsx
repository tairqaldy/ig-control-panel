import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useSearchParams } from 'react-router';
import { type ForceGraphMethods } from 'react-force-graph-2d';
import { AnimatePresence, motion } from 'motion/react';
import { AlertCircle, MousePointerClick, RefreshCw } from 'lucide-react';
import { api, qs } from '../lib/api';
import type { GraphMode, GraphResponse, SimLink, SimNode } from '../lib/types-graph';
import { nodeIdOf, nodeTitle } from '../lib/types-graph';
import { useItemModal, useTheme } from '../lib/store';
import { Skeleton, CategoryDot } from '../components/ui';
import { AnalysisEmpty } from '../components/Onboarding';
import GraphScene from '../components/graph/GraphScene';
import GraphTopBar from '../components/graph/GraphTopBar';
import GraphInfoPanel from '../components/graph/GraphInfoPanel';

/**
 * The map of your taste. Three views over one library:
 *   Map (default)  — every category as a soft disc, its strongest tags and creators orbiting it. ~60 nodes.
 *   Category       — click a disc: that category's saves, tags and creators, with the similar ones tied together.
 *   Everything     — the old full-library picture, behind the View popover.
 *
 * Deep links: `/graph?category=Food%20%26%20Recipes` opens that category, `/graph?mode=all`, and `?focus=<node id>`
 * (`cat:…`, `tag:…`, `author:…` or a save id, a bare category name also works) selects a node once the view settles.
 */
export default function Graph() {
  const fgRef = useRef<ForceGraphMethods<SimNode, SimLink> | undefined>(undefined);
  const wrapRef = useRef<HTMLDivElement>(null);
  const modal = useItemModal();
  const { theme } = useTheme();
  const dark = theme === 'dark';
  const [sp, setSp] = useSearchParams();

  const urlMode = (sp.get('mode') || '').toLowerCase();
  const category = sp.get('category') || '';
  const mode: GraphMode = urlMode === 'all' ? 'all' : urlMode === 'category' || (!urlMode && category) ? 'category' : 'overview';
  const focusParam = sp.get('focus') || '';

  const [dims, setDims] = useState({ w: 800, h: 600 });
  const [query, setQuery] = useState('');
  const [hover, setHover] = useState<SimNode | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [tune, setTune] = useState({ minTag: 3, maxItems: 800, similar: true });
  const [settling, setSettling] = useState(true);
  const [touched, setTouched] = useState(false);
  const [fontsReady, setFontsReady] = useState(false);
  const focusDone = useRef('');

  useEffect(() => {
    const fonts = (document as any).fonts;
    if (!fonts?.ready) { setFontsReady(true); return; }
    let alive = true;
    fonts.ready.then(() => { if (alive) setFontsReady(true); });
    return () => { alive = false; };
  }, []);

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setDims({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    setDims({ w: el.clientWidth, h: el.clientHeight });
    return () => ro.disconnect();
  }, []);

  /* ---------------- data ---------------- */
  const gq = useQuery({
    queryKey: ['graph', mode, mode === 'overview' ? '' : category, mode === 'all' ? tune : null],
    queryFn: () => api.get<GraphResponse>(`/api/graph${qs({
      mode,
      category: mode === 'overview' ? '' : category,
      ...(mode === 'all' ? { min_tag: tune.minTag, max_items: tune.maxItems, similar: tune.similar ? 1 : 0 } : {}),
    })}`),
    staleTime: 60_000,
    // keep the previous picture on screen while the next one loads, so switching views is a crossfade, not a flash
    placeholderData: (prev) => prev,
  });
  const meta = gq.data?.meta;
  // render whatever data we actually hold (may lag the URL by one fetch)
  const view: GraphMode = meta?.mode ?? mode;
  const viewCategory = meta?.category ?? category;

  const data = useMemo(() => {
    if (!gq.data) return { nodes: [] as SimNode[], links: [] as SimLink[] };
    return { nodes: gq.data.nodes.map((n) => ({ ...n })) as SimNode[], links: gq.data.links.map((l) => ({ ...l })) as SimLink[] };
  }, [gq.data]);
  const ring = useMemo(() => (meta?.categories || []).map((c) => c.name), [meta]);

  const neighbors = useMemo(() => {
    const m = new Map<string, Set<string>>();
    for (const l of data.links) {
      const s = nodeIdOf(l.source), t = nodeIdOf(l.target);
      if (!m.has(s)) m.set(s, new Set());
      if (!m.has(t)) m.set(t, new Set());
      m.get(s)!.add(t);
      m.get(t)!.add(s);
    }
    return m;
  }, [data.links]);

  const matchIds = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return null;
    return new Set(data.nodes.filter((n) =>
      n.label.toLowerCase().includes(q)
      || (n.category || '').toLowerCase().includes(q)
      || (n.author || '').toLowerCase().includes(q)
      || (n.tags || []).some((t) => t.includes(q)),
    ).map((n) => n.id));
  }, [query, data.nodes]);

  const selected = useMemo(() => data.nodes.find((n) => n.id === selectedId) || null, [data.nodes, selectedId]);
  const activeSet = useMemo(() => {
    const src = selected || hover;
    if (!src) return null;
    const s = new Set<string>([src.id]);
    for (const id of neighbors.get(src.id) || []) s.add(id);
    return s;
  }, [selected, hover, neighbors]);

  /* ---------------- navigation ---------------- */
  const setView = useCallback((m: GraphMode, cat?: string) => {
    setTouched(true);
    setSelectedId(null);
    setHover(null);
    const next = new URLSearchParams(sp);
    next.delete('focus');
    if (m === 'overview') { next.delete('mode'); next.delete('category'); }
    else { next.set('mode', m); if (m === 'category') next.set('category', cat || category); else next.delete('category'); }
    setSp(next);
  }, [sp, setSp, category]);

  const onNodeClick = useCallback((node: SimNode) => {
    setTouched(true);
    if (node.type === 'item') { modal.open(node.id); return; }
    if (node.type === 'category' && view === 'overview') { setView('category', node.label); return; }
    if (selectedId === node.id) { setSelectedId(null); fgRef.current?.zoomToFit(600, 50); return; }
    setSelectedId(node.id);
    if (view !== 'overview') {
      const ids = new Set([node.id, ...(neighbors.get(node.id) || [])]);
      fgRef.current?.zoomToFit(600, 60, (n: any) => ids.has(n.id));
    }
  }, [modal, view, selectedId, neighbors, setView]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (query) { setQuery(''); return; }
      if (selectedId) { setSelectedId(null); return; }
      if (mode !== 'overview') setView('overview');
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [query, selectedId, mode, setView]);

  // ?focus=… — select the node once its view is on screen (accepts an id or a bare category name)
  useEffect(() => {
    if (!focusParam || !data.nodes.length || focusDone.current === focusParam) return;
    const hit = data.nodes.find((n) => n.id === focusParam) || data.nodes.find((n) => n.type === 'category' && n.label === focusParam) || data.nodes.find((n) => n.label === focusParam);
    if (!hit) return;
    focusDone.current = focusParam;
    setSelectedId(hit.id);
    setTouched(true);
    const ids = new Set([hit.id, ...(neighbors.get(hit.id) || [])]);
    setTimeout(() => fgRef.current?.zoomToFit(700, 60, (n: any) => ids.has(n.id)), 400);
  }, [focusParam, data.nodes, neighbors]);

  /** Read-only handle for screenshot/e2e harnesses: node positions and their viewport coordinates. */
  useEffect(() => {
    (window as any).__resurflyGraph = {
      mode: view,
      nodes: () => data.nodes.map((n) => ({ id: n.id, type: n.type, label: n.label, count: n.count, x: n.x, y: n.y })),
      screen: (id: string) => {
        const n = data.nodes.find((m) => m.id === id);
        const fg = fgRef.current;
        if (!n || !fg || n.x === undefined || n.y === undefined) return null;
        const p = fg.graph2ScreenCoords(n.x, n.y);
        const rect = wrapRef.current?.querySelector('canvas')?.getBoundingClientRect();
        return rect ? { x: p.x + rect.left, y: p.y + rect.top } : p;
      },
    };
    return () => { delete (window as any).__resurflyGraph; };
  }, [data.nodes, view]);

  useEffect(() => { setSettling(true); }, [view, viewCategory]);

  const sceneKey = `${view}:${viewCategory || ''}`;
  const isEmpty = !gq.isLoading && !gq.isError && data.nodes.length === 0;

  return (
    <div ref={wrapRef} className="relative -mx-4 -my-6 h-[calc(100vh-3.5rem)] overflow-hidden bg-surface sm:-mx-6 lg:-mx-8 lg:-my-8 lg:h-screen">
      {gq.isLoading ? (
        <Skeleton className="absolute inset-0" />
      ) : gq.isError ? (
        <div className="absolute inset-0 grid place-items-center p-8">
          <div className="flex max-w-sm flex-col items-center gap-3 text-center">
            <AlertCircle size={24} className="text-danger" />
            <div className="display text-[22px]">The map did not load</div>
            <div className="text-[13px] text-muted">{(gq.error as Error)?.message || 'The server did not answer.'}</div>
            <button onClick={() => gq.refetch()} className="btn btn-primary mt-1"><RefreshCw size={14} /> Try again</button>
          </div>
        </div>
      ) : isEmpty ? (
        <div className="absolute inset-0 grid place-items-center p-8">
          <AnalysisEmpty page="graph" filtered={mode !== 'overview' && (meta?.totals.items ?? 0) > 0} onClearFilters={() => setView('overview')} className="w-full max-w-lg !border-0 !bg-transparent" />
        </div>
      ) : (
        <AnimatePresence initial={false}>
          <motion.div
            key={sceneKey}
            className="absolute inset-0"
            initial={{ opacity: 0, scale: 0.985 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 1.015 }}
            transition={{ duration: 0.32, ease: [0.2, 0.7, 0.2, 1] }}
          >
            <GraphScene
              fgRef={fgRef}
              data={data}
              mode={view}
              width={dims.w}
              height={dims.h}
              dark={dark}
              ring={ring}
              matchIds={matchIds}
              activeSet={activeSet}
              selectedId={selectedId}
              fontsReady={fontsReady}
              onHover={setHover}
              onNodeClick={onNodeClick}
              onBackgroundClick={() => { setSelectedId(null); setTouched(true); }}
              onSettled={() => setSettling(false)}
            />
          </motion.div>
        </AnimatePresence>
      )}

      <GraphTopBar
        mode={mode}
        category={category}
        meta={meta}
        nodeCount={data.nodes.length}
        linkCount={data.links.length}
        query={query}
        onQuery={(v) => { setQuery(v); if (v) setTouched(true); }}
        onMode={setView}
        onBack={() => setView('overview')}
        onFit={() => { setSelectedId(null); fgRef.current?.zoomToFit(600, view === 'overview' ? 70 : 50); }}
        tune={tune}
        onTune={(patch) => setTune((t) => ({ ...t, ...patch }))}
      />

      {/* Hint: two lines, gone for good after the first click, search or drag */}
      <AnimatePresence>
        {!touched && !selected && !isEmpty && !gq.isLoading && (
          <motion.div
            initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: 8 }} transition={{ duration: 0.4, delay: 0.6 }}
            className="pointer-events-none absolute inset-x-0 bottom-6 flex justify-center px-4"
          >
            <div className="card px-3.5 py-2 text-center text-[12.5px] leading-relaxed text-muted">
              Click a category to open it.<br />Search highlights anything.
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Hover card (pointer only — on a phone a tap selects and the sheet says the same thing) */}
      <AnimatePresence>
        {hover && hover.id !== selectedId && (
          <motion.div
            initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: 6 }} transition={{ duration: 0.14 }}
            className="pointer-events-none absolute bottom-4 left-4 hidden max-w-sm sm:block"
          >
            {hover.type === 'item' ? (
              <div className="card flex items-center gap-3 p-2.5">
                {hover.thumb && <img src={hover.thumb} alt="" className="h-16 w-12 rounded-md object-cover" />}
                <div className="min-w-0">
                  <div className="clamp-2 text-[13px] font-medium leading-snug">{hover.label}</div>
                  {hover.oneLiner && <div className="clamp-2 mt-0.5 text-[11.5px] leading-snug text-ink-2">{hover.oneLiner}</div>}
                  <div className="mt-1 flex items-center gap-1.5 text-[11px] text-muted">
                    <CategoryDot category={hover.category} />{hover.category}{hover.author ? ` · @${hover.author}` : ''}{hover.useful ? ` · ${hover.useful}/10` : ''}
                  </div>
                  <div className="mt-1 inline-flex items-center gap-1 text-[10.5px] text-accent"><MousePointerClick size={10} /> click to open</div>
                </div>
              </div>
            ) : (
              <div className="card px-3 py-2 text-[12.5px]">
                <span className="font-medium">{nodeTitle(hover)}</span>
                <span className="text-muted"> · {(hover.count ?? 0).toLocaleString()} saves · {hover.type === 'category' && view === 'overview' ? 'click to open' : 'click for details'}</span>
              </div>
            )}
          </motion.div>
        )}
      </AnimatePresence>

      <AnimatePresence>
        {selected && (
          <GraphInfoPanel
            key={selected.id}
            node={selected}
            mode={view}
            connected={neighbors.get(selected.id)?.size ?? 0}
            onOpenCategory={(name) => setView('category', name)}
            onClose={() => setSelectedId(null)}
          />
        )}
      </AnimatePresence>

      <div className="absolute bottom-4 right-4 hidden items-center gap-2 font-mono text-[10.5px] text-muted sm:flex">
        {(settling || gq.isFetching) && <span className="inline-flex items-center gap-1"><span className="pulse-dot h-1.5 w-1.5 rounded-full bg-accent" /> settling</span>}
        <span>{data.nodes.length} nodes · {data.links.length} links</span>
      </div>
    </div>
  );
}
