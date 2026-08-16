import { useCallback, useEffect, useMemo, useRef, type MutableRefObject } from 'react';
import ForceGraph2D, { type ForceGraphMethods } from 'react-force-graph-2d';
import { forceCollide, forceX, forceY } from 'd3-force';
import { categoryHue } from '../../lib/utils';
import type { GraphMode, SimLink, SimNode } from '../../lib/types-graph';
import { nodeIdOf } from '../../lib/types-graph';

const TAU = Math.PI * 2;
const FONT_SERIF = "'Instrument Serif', ui-serif, Georgia, serif";
const FONT_UI = "'Instrument Sans Variable', ui-sans-serif, system-ui, sans-serif";
const FONT_MONO = "'Geist Mono Variable', ui-monospace, monospace";
/** A label costs a text layout per node per frame: past this many nodes only the active ones get one. */
const LABEL_BUDGET = 200;

/* ---------------- caches (module level: they survive re-renders and view switches) ---------------- */
const imgCache = new Map<string, HTMLImageElement>();
function getImg(src: string): HTMLImageElement {
  let im = imgCache.get(src);
  if (!im) { im = new Image(); im.src = src; im.decoding = 'async'; imgCache.set(src, im); }
  return im;
}
const wrapCache = new Map<string, string[]>();
/** Greedy word wrap, memoised per (text, size, width) — measureText is the expensive part of a category disc. */
function wrapLines(ctx: CanvasRenderingContext2D, text: string, maxW: number, fs: number, max = 3): string[] {
  const key = `${text}|${fs.toFixed(1)}|${maxW.toFixed(0)}`;
  const hit = wrapCache.get(key);
  if (hit) return hit;
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let cur = '';
  for (const w of words) {
    const next = cur ? `${cur} ${w}` : w;
    if (!cur || ctx.measureText(next).width <= maxW) cur = next;
    else { lines.push(cur); cur = w; }
  }
  if (cur) lines.push(cur);
  const out = lines.slice(0, max);
  if (lines.length > max) out[max - 1] += '…';
  if (wrapCache.size > 600) wrapCache.clear();
  wrapCache.set(key, out);
  return out;
}

const itemR = (useful: number | undefined) => 3 + Math.max(0, (useful || 5) - 5) * 0.4;
/** Fallback radius for hit-testing before the first paint has measured a node. */
export const radiusOf = (n: SimNode): number => n.__r ?? (n.type === 'category' ? 34 : n.type === 'author' ? 11 : n.type === 'tag' ? 6 : itemR(n.useful));

export interface GraphSceneProps {
  /** Where this scene publishes its ForceGraph instance for the page (zoom-to-node, coordinate lookups). */
  fgRef: MutableRefObject<ForceGraphMethods<SimNode, SimLink> | undefined>;
  data: { nodes: SimNode[]; links: SimLink[] };
  mode: GraphMode;
  width: number;
  height: number;
  dark: boolean;
  /** Category names in ring order (biggest first) — the map's skeleton, stable across views. */
  ring: string[];
  /** Search hits: everything else is dimmed. */
  matchIds: Set<string> | null;
  /** Selected/hovered node + its neighbours. */
  activeSet: Set<string> | null;
  selectedId: string | null;
  fontsReady: boolean;
  /** The scene hands its "fit to screen" back through this ref so the top bar's button uses the same framing. */
  fitRef: MutableRefObject<(() => void) | null>;
  onHover: (n: SimNode | null) => void;
  onNodeClick: (n: SimNode) => void;
  onBackgroundClick: () => void;
  onSettled: () => void;
}

const replaceMode = () => 'replace' as const;

/**
 * The canvas. Three visual classes — soft category discs (label always on, in Instrument Serif), tag dots (label on
 * hover or zoom) and creator avatars — plus item dots once a category is open.
 *
 * The layout is placed, not guessed: categories sit on an ellipse sized to the viewport, each one's tags and creators
 * take small orbits around it, and d3 only has to settle the last few pixels (warmup, short cooldown, then silence).
 * No link particles.
 */
export default function GraphScene({ fgRef, data, mode, width, height, dark, ring, matchIds, activeSet, selectedId, fontsReady, fitRef, onHover, onNodeClick, onBackgroundClick, onSettled }: GraphSceneProps) {
  const fittedRef = useRef(false);
  /**
   * Own instance handle. Two scenes overlap during a view crossfade, so the page's `fgRef` is *published* here and
   * only released by whichever scene still owns it — otherwise the one animating out would clear the new one's ref.
   */
  const fg = useRef<ForceGraphMethods<SimNode, SimLink> | undefined>(undefined);
  useEffect(() => {
    fgRef.current = fg.current;
    return () => { if (fgRef.current === fg.current) fgRef.current = undefined; };
  }, [fgRef]);
  const labelBudget = data.nodes.length <= LABEL_BUDGET;
  /**
   * When tag/creator names appear. On the map they wait for a hover or a zoom (the category names carry it);
   * inside a category there are few enough of them to name straight away.
   */
  const labelZoom = mode === 'overview' ? 1.5 : data.nodes.length <= 80 ? 0.5 : 1.35;

  const ink = dark ? '#edeae2' : '#17161a';
  const muted = dark ? '#8f8b81' : '#7d7970';
  const accent = dark ? '#4fd39a' : '#177a4c';
  const hueOf = useCallback((n: SimNode) => categoryHue(n.type === 'category' ? n.label : n.category || undefined), []);
  const catColor = useCallback((hue: number, alpha = 1, l = dark ? 0.74 : 0.5, chroma = 0.13) => `oklch(${l} ${chroma} ${hue} / ${alpha})`, [dark]);

  /* ---------------- sizes: relative to the biggest node of each class, so a 40-save library reads like a 4,000-save one ---------------- */
  const peak = useMemo(() => {
    let cat = 1, tag = 1, author = 1;
    for (const n of data.nodes) {
      if (n.type === 'category') cat = Math.max(cat, n.count || 1);
      else if (n.type === 'tag') tag = Math.max(tag, n.count || 1);
      else if (n.type === 'author') author = Math.max(author, n.count || 1);
    }
    return { cat, tag, author };
  }, [data.nodes]);
  const sizeOf = useCallback((n: SimNode): number => {
    // one hub alone in a category view can afford to be big; on the map and in Everything they are sized by their share
    if (n.type === 'category') return mode === 'category' ? 56 : 25 + 30 * Math.sqrt((n.count || 1) / peak.cat);
    if (n.type === 'tag') return 3.2 + 7 * Math.sqrt((n.count || 1) / peak.tag);
    if (n.type === 'author') return 8 + 8 * Math.sqrt((n.count || 1) / peak.author);
    return itemR(n.useful);
  }, [mode, peak]);

  /* ---------------- layout anchors ---------------- */
  const layout = useMemo(() => {
    const cat = new Map<string, { x: number; y: number }>();
    const sat = new Map<string, { x: number; y: number }>();
    if (!data.nodes.length) return { cat, sat };
    // the ring becomes an ellipse shaped like the viewport, so a wide screen fills sideways and a phone fills down
    const aspect = Math.max(0.5, Math.min(2, width / Math.max(1, height)));
    const k = Math.sqrt(aspect);

    if (mode === 'category') {
      const tags = data.nodes.filter((n) => n.type === 'tag');
      const authors = data.nodes.filter((n) => n.type === 'author');
      const Rt = Math.max(215, (tags.length * 74) / TAU);
      tags.forEach((n, i) => { const a = (i / Math.max(1, tags.length)) * TAU - Math.PI / 2; sat.set(n.id, { x: Math.cos(a) * Rt * k, y: (Math.sin(a) * Rt) / k }); });
      const Ra = Rt * 1.75;
      authors.forEach((n, i) => { const a = (i / Math.max(1, authors.length)) * TAU - Math.PI / 2 + 0.45; sat.set(n.id, { x: Math.cos(a) * Ra * k, y: (Math.sin(a) * Ra) / k }); });
      return { cat, sat };
    }

    const names = ring.length ? ring : Array.from(new Set(data.nodes.filter((n) => n.type === 'category').map((n) => n.label)));
    if (mode !== 'overview') {
      const R = Math.max(300, (names.length * 180) / TAU);
      names.forEach((c, i) => { const a = (i / names.length) * TAU - Math.PI / 2; cat.set(c, { x: Math.cos(a) * R * k, y: (Math.sin(a) * R) / k }); });
      return { cat, sat };
    }

    // Each category takes a slice of the ring as wide as its constellation needs, so a 600-save category and a
    // 3-save one can be neighbours without their tags colliding.
    const TAG_PER = 7, AUTH_PER = 6, LVL = 30;
    const by = (a: SimNode, b: SimNode) => (b.count || 0) - (a.count || 0);
    const groups = new Map<string, SimNode[]>();
    for (const n of data.nodes) {
      if (n.type === 'category') continue;
      const home = n.category || '';
      const g = groups.get(home);
      if (g) g.push(n); else groups.set(home, [n]);
    }
    const hubs = new Map(data.nodes.filter((n) => n.type === 'category').map((n) => [n.label, n] as const));
    const slices = names.map((name) => {
      const list = groups.get(name) || [];
      const tags = list.filter((n) => n.type === 'tag').sort(by);
      const authors = list.filter((n) => n.type === 'author').sort(by);
      const hub = hubs.get(name);
      const r0 = (hub ? sizeOf(hub) : 30) + 18;
      const tagDepth = tags.length ? 14 + (Math.ceil(tags.length / TAG_PER) - 1) * LVL : 0;
      const authDepth = authors.length ? 104 + (Math.ceil(authors.length / AUTH_PER) - 1) * LVL : 0;
      return { name, r0, tags, authors, span: 2 * (r0 + Math.max(tagDepth, authDepth)) + 54 };
    });
    const circumference = slices.reduce((s, i) => s + i.span, 0) || 1;
    const R = Math.max(280, circumference / TAU);
    let cum = 0;
    for (const s of slices) {
      const a = ((cum + s.span / 2) / circumference) * TAU - Math.PI / 2;
      cum += s.span;
      const c = { x: Math.cos(a) * R * k, y: (Math.sin(a) * R) / k };
      cat.set(s.name, c);
      const base = Math.atan2(c.y, c.x); // the constellation leans away from the middle of the map
      const put = (arr: SimNode[], gap: number, spread: number, per: number) => arr.forEach((n, i) => {
        const lvl = Math.floor(i / per);
        const inLvl = i % per;
        const cnt = Math.min(per, arr.length - lvl * per);
        const t = cnt === 1 ? 0 : inLvl / (cnt - 1) - 0.5;
        const rr = s.r0 + gap + lvl * LVL;
        sat.set(n.id, { x: c.x + Math.cos(base + t * spread) * rr, y: c.y + Math.sin(base + t * spread) * rr });
      });
      put(s.tags, 14, Math.PI * 1.2, TAG_PER);
      put(s.authors, 104, Math.PI * 0.8, AUTH_PER);
    }
    return { cat, sat };
  }, [data.nodes, mode, ring, width, height, sizeOf]);

  /* ---------------- forces ---------------- */
  useEffect(() => {
    const sim = fg.current;
    if (!sim || !data.nodes.length) return;
    fittedRef.current = false;
    const at = (n: SimNode, axis: 'x' | 'y'): number => {
      if (n.type === 'category') return mode === 'category' ? 0 : layout.cat.get(n.label)?.[axis] ?? 0;
      const s = layout.sat.get(n.id);
      if (s) return s[axis];
      return layout.cat.get(n.category || '')?.[axis] ?? 0;
    };
    if (mode === 'overview') {
      sim.d3Force('charge')?.strength((n: any) => (n.type === 'category' ? -260 : -22));
      sim.d3Force('link')?.distance(60).strength(0.02);
      sim.d3Force('x', forceX<any>().x((n: any) => at(n, 'x')).strength((n: any) => (n.type === 'category' ? 1 : 0.55)));
      sim.d3Force('y', forceY<any>().y((n: any) => at(n, 'y')).strength((n: any) => (n.type === 'category' ? 1 : 0.55)));
    } else if (mode === 'category') {
      sim.d3Force('charge')?.strength((n: any) => (n.type === 'category' ? -420 : n.type === 'item' ? -26 : -90));
      sim.d3Force('link')?.distance((l: any) => (l.kind === 'category' ? 170 : l.kind === 'similar' ? 26 : l.kind === 'author' ? 40 : 34)).strength((l: any) => (l.kind === 'category' ? 0.01 : l.kind === 'similar' ? 0.3 : l.kind === 'author' ? 0.5 : 0.55));
      sim.d3Force('x', forceX<any>().x((n: any) => at(n, 'x')).strength((n: any) => (n.type === 'category' ? 1 : n.type === 'item' ? 0.004 : 0.75)));
      sim.d3Force('y', forceY<any>().y((n: any) => at(n, 'y')).strength((n: any) => (n.type === 'category' ? 1 : n.type === 'item' ? 0.004 : 0.75)));
    } else {
      sim.d3Force('charge')?.strength((n: any) => (n.type === 'category' ? -320 : n.type === 'tag' ? -90 : n.type === 'author' ? -70 : -18));
      sim.d3Force('link')?.distance((l: any) => (l.kind === 'category' ? 70 : l.kind === 'similar' ? 26 : l.kind === 'author' ? 50 : 40)).strength((l: any) => (l.kind === 'similar' ? 0.4 : l.kind === 'category' ? 0.08 : 0.45));
      sim.d3Force('x', forceX<any>().x((n: any) => at(n, 'x')).strength((n: any) => (n.type === 'item' ? 0.06 : n.type === 'category' ? 0.6 : 0.01)));
      sim.d3Force('y', forceY<any>().y((n: any) => at(n, 'y')).strength((n: any) => (n.type === 'item' ? 0.06 : n.type === 'category' ? 0.6 : 0.01)));
    }
    sim.d3Force('collide', forceCollide<any>().radius((n: any) => sizeOf(n) + (n.type === 'category' ? 8 : 2.5)).strength(0.85));
    sim.d3ReheatSimulation();
  }, [data, mode, layout, sizeOf]);

  /* ---------------- painting ---------------- */
  const paint = useCallback((node: SimNode, ctx: CanvasRenderingContext2D, scale: number) => {
    const x = node.x ?? 0;
    const y = node.y ?? 0;
    const matched = !matchIds || matchIds.has(node.id);
    const active = !!activeSet?.has(node.id);
    const selected = selectedId === node.id;
    const dimmed = (activeSet && !active) || !matched;
    const hue = hueOf(node);
    const r = sizeOf(node);
    ctx.globalAlpha = dimmed ? 0.11 : 1;
    if (matchIds && matched) { ctx.shadowColor = accent; ctx.shadowBlur = 16; }

    if (node.type === 'category') {
      node.__r = r;
      const glow = ctx.createRadialGradient(x, y, r * 0.2, x, y, r * 1.55);
      glow.addColorStop(0, catColor(hue, 0.28));
      glow.addColorStop(0.6, catColor(hue, 0.1));
      glow.addColorStop(1, catColor(hue, 0));
      ctx.beginPath(); ctx.arc(x, y, r * 1.55, 0, TAU); ctx.fillStyle = glow; ctx.fill();
      ctx.beginPath(); ctx.arc(x, y, r, 0, TAU); ctx.fillStyle = catColor(hue, dark ? 0.17 : 0.14); ctx.fill();
      ctx.lineWidth = (selected || active ? 2.4 : 1.2) / scale;
      ctx.strokeStyle = selected || active ? accent : catColor(hue, 0.62);
      ctx.stroke();
      ctx.shadowBlur = 0;
      // the label is always on — it is the map's legend. The second term caps it in screen pixels so a deep zoom
      // does not turn one category name into wallpaper.
      const fs = Math.min(Math.max(10, Math.min(26, r * 0.44)), Math.max(7, 34 / scale));
      ctx.font = `${fs}px ${fontsReady ? FONT_SERIF : FONT_UI}`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      const lines = wrapLines(ctx, node.label, r * 2.3, fs);
      const lh = fs * 1.03;
      const top = y - ((lines.length - 1) * lh) / 2 - (node.count ? fs * 0.32 : 0);
      ctx.fillStyle = ink;
      lines.forEach((l, i) => ctx.fillText(l, x, top + i * lh));
      if (node.count) {
        ctx.font = `${fs * 0.48}px ${FONT_MONO}`;
        ctx.fillStyle = muted;
        ctx.fillText(node.count.toLocaleString(), x, top + lines.length * lh - fs * 0.08);
      }
    } else if (node.type === 'tag') {
      node.__r = r;
      ctx.beginPath(); ctx.arc(x, y, active || selected ? r * 1.3 : r, 0, TAU);
      ctx.fillStyle = node.category ? catColor(hue, 0.92, dark ? 0.68 : 0.55, 0.09) : accent;
      ctx.fill();
      if (selected || active) { ctx.lineWidth = 1.8 / scale; ctx.strokeStyle = accent; ctx.stroke(); }
      ctx.shadowBlur = 0;
      if (labelBudget && (scale >= labelZoom || active || selected || (matchIds && matched))) {
        const fs = Math.max(2.6, 10.5 / scale);
        ctx.font = `${fs}px ${FONT_MONO}`;
        ctx.fillStyle = active || selected ? ink : muted;
        ctx.textAlign = 'center'; ctx.textBaseline = 'top';
        ctx.fillText(`#${node.label}`, x, y + r + 2.5 / scale);
      }
    } else if (node.type === 'author') {
      node.__r = r;
      const im = node.thumb ? getImg(node.thumb) : null;
      ctx.save();
      ctx.beginPath(); ctx.arc(x, y, r, 0, TAU); ctx.closePath(); ctx.clip();
      if (im && im.complete && im.naturalWidth) {
        const s = Math.max((r * 2) / im.naturalWidth, (r * 2) / im.naturalHeight);
        const w = im.naturalWidth * s, h = im.naturalHeight * s;
        ctx.drawImage(im, x - w / 2, y - h / 2, w, h);
      } else {
        ctx.fillStyle = catColor(hue, 0.5, dark ? 0.5 : 0.7);
        ctx.fillRect(x - r, y - r, r * 2, r * 2);
      }
      ctx.restore();
      ctx.beginPath(); ctx.arc(x, y, r, 0, TAU);
      ctx.lineWidth = (selected || active ? 2.4 : 1.3) / scale;
      ctx.strokeStyle = selected || active ? accent : catColor(hue, 0.75);
      ctx.stroke();
      ctx.shadowBlur = 0;
      if (labelBudget && (scale >= labelZoom || active || selected || (matchIds && matched))) {
        const fs = Math.max(2.6, 10.5 / scale);
        ctx.font = `${fs}px ${FONT_UI}`;
        ctx.fillStyle = active || selected ? ink : muted;
        ctx.textAlign = 'center'; ctx.textBaseline = 'top';
        ctx.fillText(node.label, x, y + r + 3 / scale);
      }
    } else {
      const color = catColor(hue, 1, dark ? 0.72 : 0.55);
      const clip = (radius: number) => {
        const im = getImg(node.thumb!);
        ctx.save();
        ctx.beginPath(); ctx.arc(x, y, radius, 0, TAU); ctx.closePath(); ctx.clip();
        if (im.complete && im.naturalWidth) {
          const s = Math.max((radius * 2) / im.naturalWidth, (radius * 2) / im.naturalHeight);
          const w = im.naturalWidth * s, h = im.naturalHeight * s;
          ctx.drawImage(im, x - w / 2, y - h / 2, w, h);
        } else { ctx.fillStyle = color; ctx.fillRect(x - radius, y - radius, radius * 2, radius * 2); }
        ctx.restore();
      };
      if (scale >= 1.5 && node.thumb) {
        const R = r * 2.4;
        node.__r = R;
        clip(R);
        ctx.beginPath(); ctx.arc(x, y, R, 0, TAU);
        ctx.lineWidth = (active ? 2.2 : 1) / scale;
        ctx.strokeStyle = active ? accent : color;
        ctx.stroke();
        ctx.shadowBlur = 0;
        if (labelBudget && (scale >= 2.6 || active)) {
          const fs = Math.max(2.6, 11 / scale);
          ctx.font = `${fs}px ${FONT_UI}`;
          ctx.fillStyle = ink; ctx.textAlign = 'center'; ctx.textBaseline = 'top';
          ctx.fillText(node.label.length > 34 ? `${node.label.slice(0, 33)}…` : node.label, x, y + R + 2 / scale);
        }
      } else {
        node.__r = r;
        ctx.beginPath(); ctx.arc(x, y, active ? r * 1.5 : r, 0, TAU);
        ctx.fillStyle = color; ctx.fill();
        ctx.shadowBlur = 0;
        if (labelBudget && active && scale >= 0.8) {
          const fs = Math.max(2.6, 11 / scale);
          ctx.font = `${fs}px ${FONT_UI}`;
          ctx.fillStyle = ink; ctx.textAlign = 'center'; ctx.textBaseline = 'top';
          ctx.fillText(node.label.length > 34 ? `${node.label.slice(0, 33)}…` : node.label, x, y + r + 2 / scale);
        }
      }
    }
    ctx.shadowBlur = 0;
    ctx.globalAlpha = 1;
  }, [mode, dark, ink, muted, accent, catColor, hueOf, sizeOf, matchIds, activeSet, selectedId, labelBudget, labelZoom, fontsReady]);

  const linkColor = useCallback((l: SimLink) => {
    const s = nodeIdOf(l.source), t = nodeIdOf(l.target);
    const on = activeSet ? activeSet.has(s) && activeSet.has(t) : true;
    const base = mode === 'overview' ? 0.13 + Math.min(0.22, (l.weight || 1) / 260) : l.kind === 'similar' ? 0.35 : l.kind === 'category' ? 0.05 : 0.16;
    const a = on ? base : 0.02;
    return dark ? `rgba(237,234,226,${a})` : `rgba(23,22,26,${a})`;
  }, [activeSet, dark, mode]);
  const linkWidth = useCallback((l: SimLink) => (mode === 'overview' ? 0.5 + Math.min(2, (l.weight || 1) / 55) : l.kind === 'similar' ? 1.2 : 0.6), [mode]);

  /**
   * Fit, but into the area the reader can actually see: the top bar floats over the canvas, so the picture is
   * framed below it instead of being centred under it.
   */
  const fitView = useCallback((ms = 700) => {
    const sim = fg.current;
    if (!sim || !data.nodes.length || !width || !height) return;
    const bb = sim.getGraphBbox();
    if (!bb) return;
    const topInset = width < 640 ? 124 : 78;
    const pad = 36;
    const z = Math.max(0.1, Math.min(12, Math.min((width - pad * 2) / Math.max(1, bb.x[1] - bb.x[0]), (height - topInset - pad) / Math.max(1, bb.y[1] - bb.y[0]))));
    const cx = (bb.x[0] + bb.x[1]) / 2;
    const cy = (bb.y[0] + bb.y[1]) / 2;
    sim.zoom(z, ms);
    sim.centerAt(cx, cy - (topInset - pad) / (2 * z), ms);
  }, [data.nodes.length, width, height]);
  useEffect(() => { fitRef.current = () => fitView(600); return () => { fitRef.current = null; }; }, [fitRef, fitView]);

  const hoverIdRef = useRef<string | null>(null);
  return (
    <ForceGraph2D
      ref={fg as any}
      width={width}
      height={height}
      graphData={data as any}
      backgroundColor="rgba(0,0,0,0)"
      nodeCanvasObject={paint as any}
      nodeCanvasObjectMode={replaceMode}
      nodePointerAreaPaint={(node: any, color: string, ctx: CanvasRenderingContext2D) => {
        const r = radiusOf(node) + 3;
        ctx.fillStyle = color; ctx.beginPath(); ctx.arc(node.x, node.y, r, 0, TAU); ctx.fill();
      }}
      linkColor={linkColor as any}
      linkWidth={linkWidth as any}
      linkDirectionalParticles={0}
      onNodeHover={(n: any) => { if ((n?.id || null) !== hoverIdRef.current) { hoverIdRef.current = n?.id || null; onHover(n || null); } }}
      onNodeClick={onNodeClick as any}
      onBackgroundClick={onBackgroundClick}
      onEngineStop={() => {
        if (!fittedRef.current) { fittedRef.current = true; fitView(700); }
        onSettled();
      }}
      cooldownTicks={mode === 'overview' ? 110 : 150}
      warmupTicks={mode === 'overview' ? 90 : 70}
      d3AlphaDecay={0.045}
      d3VelocityDecay={0.45}
      minZoom={0.1}
      maxZoom={12}
      enableNodeDrag
    />
  );
}
