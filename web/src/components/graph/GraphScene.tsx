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
/** Labels cost a text layout per node per frame: past this many nodes only the active ones get one. */
const LABEL_BUDGET = 200;

/* ---------------- caches (module-level: they survive re-renders and mode switches) ---------------- */
const imgCache = new Map<string, HTMLImageElement>();
function getImg(src: string): HTMLImageElement {
  let im = imgCache.get(src);
  if (!im) { im = new Image(); im.src = src; im.decoding = 'async'; imgCache.set(src, im); }
  return im;
}
const wrapCache = new Map<string, string[]>();
/** Greedy word wrap, memoised per (text, font size, width) — measureText is the expensive part of a category disc. */
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
  if (wrapCache.size > 500) wrapCache.clear();
  wrapCache.set(key, out);
  return out;
}

/* ---------------- node sizes (graph units — the layout is built around them) ---------------- */
const discR = (count: number) => 16 + Math.sqrt(Math.max(1, count)) * 1.3;
const tagR = (count: number) => Math.min(11, 2.6 + Math.sqrt(Math.max(1, count)) * 0.5);
const avatarR = (count: number) => Math.min(15, 7 + Math.sqrt(Math.max(1, count)) * 0.5);
const itemR = (useful: number | undefined) => 3 + Math.max(0, (useful || 5) - 5) * 0.4;
export function radiusOf(n: SimNode, mode: GraphMode): number {
  if (n.type === 'category') return mode === 'overview' ? discR(n.count || 1) : discR(n.count || 1) * 0.7;
  if (n.type === 'tag') return tagR(n.count || 1);
  if (n.type === 'author') return avatarR(n.count || 1);
  return itemR(n.useful);
}

export interface GraphSceneProps {
  fgRef: MutableRefObject<ForceGraphMethods<SimNode, SimLink> | undefined>;
  data: { nodes: SimNode[]; links: SimLink[] };
  mode: GraphMode;
  width: number;
  height: number;
  dark: boolean;
  /** Category names in ring order (biggest first) — the map's skeleton. */
  ring: string[];
  /** Search hits: everything else is dimmed. */
  matchIds: Set<string> | null;
  /** Selected/hovered node + its neighbours. */
  activeSet: Set<string> | null;
  selectedId: string | null;
  fontsReady: boolean;
  onHover: (n: SimNode | null) => void;
  onNodeClick: (n: SimNode) => void;
  onBackgroundClick: () => void;
  onSettled: () => void;
}

const replaceMode = () => 'replace' as const;

/**
 * The canvas. Three visual classes — soft category discs (label always on, Instrument Serif), tag dots (label on
 * hover/zoom) and creator avatars — plus item dots when a category is open. Motion is warmup + a short cooldown:
 * the picture arrives already settled and then stops. No link particles.
 */
export default function GraphScene({ fgRef, data, mode, width, height, dark, ring, matchIds, activeSet, selectedId, fontsReady, onHover, onNodeClick, onBackgroundClick, onSettled }: GraphSceneProps) {
  const fittedRef = useRef(false);
  const labelBudget = data.nodes.length <= LABEL_BUDGET;

  const ink = dark ? '#edeae2' : '#17161a';
  const muted = dark ? '#8f8b81' : '#7d7970';
  const accent = dark ? '#4fd39a' : '#177a4c';
  const hueOf = useCallback((n: SimNode) => categoryHue(n.type === 'category' ? n.label : n.category || undefined), []);
  const catColor = useCallback((hue: number, alpha = 1, l = dark ? 0.74 : 0.5, chroma = 0.13) => `oklch(${l} ${chroma} ${hue} / ${alpha})`, [dark]);

  /* ---------------- layout anchors ---------------- */
  const anchors = useMemo(() => {
    const m = new Map<string, { x: number; y: number }>();
    if (!ring.length) return m;
    const R = Math.max(240, (ring.length * 172) / TAU);
    ring.forEach((c, i) => {
      const a = (i / ring.length) * TAU - Math.PI / 2;
      m.set(c, { x: Math.cos(a) * R, y: Math.sin(a) * R });
    });
    return m;
  }, [ring]);

  /** In a single category the hub sits in the middle and its tags take the ring; creators sit a little further out. */
  const satelliteRing = useMemo(() => {
    const m = new Map<string, { x: number; y: number }>();
    if (mode !== 'category') return m;
    const tags = data.nodes.filter((n) => n.type === 'tag');
    const authors = data.nodes.filter((n) => n.type === 'author');
    const place = (list: SimNode[], R: number, offset: number) => list.forEach((n, i) => {
      const a = (i / Math.max(1, list.length)) * TAU + offset;
      m.set(n.id, { x: Math.cos(a) * R, y: Math.sin(a) * R });
    });
    place(tags, Math.max(190, (tags.length * 84) / TAU), -Math.PI / 2);
    place(authors, Math.max(300, (authors.length * 84) / TAU) * 1.5, -Math.PI / 2 + 0.3);
    return m;
  }, [mode, data.nodes]);

  /* ---------------- forces ---------------- */
  useEffect(() => {
    const fg = fgRef.current;
    if (!fg || !data.nodes.length) return;
    fittedRef.current = false;
    const at = (n: SimNode, axis: 'x' | 'y') => {
      if (mode === 'category') {
        if (n.type === 'category') return 0;
        const s = satelliteRing.get(n.id);
        if (s) return s[axis];
        return 0;
      }
      const p = anchors.get(n.type === 'category' ? n.label : n.category || '');
      return p ? p[axis] : 0;
    };
    if (mode === 'overview') {
      fg.d3Force('charge')?.strength((n: any) => (n.type === 'category' ? -1400 : n.type === 'author' ? -190 : -140));
      fg.d3Force('link')?.distance((l: any) => (l.kind === 'author' ? 118 : 96)).strength(0.22);
      fg.d3Force('x', forceX<any>().x((n: any) => at(n, 'x')).strength((n: any) => (n.type === 'category' ? 1 : 0.09)));
      fg.d3Force('y', forceY<any>().y((n: any) => at(n, 'y')).strength((n: any) => (n.type === 'category' ? 1 : 0.09)));
    } else if (mode === 'category') {
      fg.d3Force('charge')?.strength((n: any) => (n.type === 'category' ? -900 : n.type === 'tag' ? -160 : n.type === 'author' ? -140 : -22));
      fg.d3Force('link')?.distance((l: any) => (l.kind === 'category' ? 150 : l.kind === 'similar' ? 24 : l.kind === 'author' ? 46 : 38)).strength((l: any) => (l.kind === 'category' ? 0.02 : l.kind === 'similar' ? 0.35 : 0.5));
      fg.d3Force('x', forceX<any>().x((n: any) => at(n, 'x')).strength((n: any) => (n.type === 'category' ? 0.9 : n.type === 'item' ? 0.008 : 0.35)));
      fg.d3Force('y', forceY<any>().y((n: any) => at(n, 'y')).strength((n: any) => (n.type === 'category' ? 0.9 : n.type === 'item' ? 0.008 : 0.35)));
    } else {
      fg.d3Force('charge')?.strength((n: any) => (n.type === 'category' ? -320 : n.type === 'tag' ? -90 : n.type === 'author' ? -70 : -18));
      fg.d3Force('link')?.distance((l: any) => (l.kind === 'category' ? 70 : l.kind === 'similar' ? 26 : l.kind === 'author' ? 50 : 40)).strength((l: any) => (l.kind === 'similar' ? 0.4 : l.kind === 'category' ? 0.08 : 0.45));
      fg.d3Force('x', forceX<any>().x((n: any) => at(n, 'x')).strength((n: any) => (n.type === 'item' ? 0.06 : n.type === 'category' ? 0.5 : 0.01)));
      fg.d3Force('y', forceY<any>().y((n: any) => at(n, 'y')).strength((n: any) => (n.type === 'item' ? 0.06 : n.type === 'category' ? 0.5 : 0.01)));
    }
    fg.d3Force('collide', forceCollide<any>().radius((n: any) => radiusOf(n, mode) + (n.type === 'category' ? 14 : 3)).strength(0.8));
    fg.d3ReheatSimulation();
  }, [data, mode, anchors, satelliteRing, fgRef]);

  /* ---------------- painting ---------------- */
  const paint = useCallback((node: SimNode, ctx: CanvasRenderingContext2D, scale: number) => {
    const x = node.x ?? 0;
    const y = node.y ?? 0;
    const matched = !matchIds || matchIds.has(node.id);
    const active = !!activeSet?.has(node.id);
    const selected = selectedId === node.id;
    const dimmed = (activeSet && !active) || !matched;
    const hue = hueOf(node);
    ctx.globalAlpha = dimmed ? 0.11 : 1;
    if (matchIds && matched) { ctx.shadowColor = accent; ctx.shadowBlur = 14; }

    if (node.type === 'category') {
      const r = radiusOf(node, mode);
      node.__r = r;
      const glow = ctx.createRadialGradient(x, y, r * 0.2, x, y, r * 1.5);
      glow.addColorStop(0, catColor(hue, 0.26));
      glow.addColorStop(0.6, catColor(hue, 0.1));
      glow.addColorStop(1, catColor(hue, 0));
      ctx.beginPath(); ctx.arc(x, y, r * 1.5, 0, TAU); ctx.fillStyle = glow; ctx.fill();
      ctx.beginPath(); ctx.arc(x, y, r, 0, TAU); ctx.fillStyle = catColor(hue, dark ? 0.16 : 0.13); ctx.fill();
      ctx.lineWidth = (selected || active ? 2.2 : 1.1) / scale;
      ctx.strokeStyle = selected || active ? accent : catColor(hue, 0.6);
      ctx.stroke();
      ctx.shadowBlur = 0;
      // label always visible: serif, wrapped inside the disc, sized with it
      const fs = Math.max(9, Math.min(23, r * 0.42));
      ctx.font = `${fs}px ${fontsReady ? FONT_SERIF : FONT_UI}`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      const lines = wrapLines(ctx, node.label, r * 1.85, fs);
      ctx.fillStyle = ink;
      const lh = fs * 1.02;
      const top = y - ((lines.length - 1) * lh) / 2 - (node.count ? fs * 0.3 : 0);
      lines.forEach((l, i) => ctx.fillText(l, x, top + i * lh));
      if (node.count) {
        ctx.font = `${fs * 0.46}px ${FONT_MONO}`;
        ctx.fillStyle = muted;
        ctx.fillText(String(node.count), x, top + lines.length * lh - fs * 0.1);
      }
    } else if (node.type === 'tag') {
      const r = tagR(node.count || 1);
      node.__r = r;
      ctx.beginPath(); ctx.arc(x, y, active || selected ? r * 1.3 : r, 0, TAU);
      ctx.fillStyle = node.category ? catColor(hue, 0.9, dark ? 0.68 : 0.56, 0.09) : accent;
      ctx.fill();
      if (selected || active) { ctx.lineWidth = 1.6 / scale; ctx.strokeStyle = accent; ctx.stroke(); }
      ctx.shadowBlur = 0;
      if (labelBudget && (scale >= 1.35 || active || selected || (matchIds && matched))) {
        const fs = Math.max(2.6, 10.5 / scale);
        ctx.font = `${fs}px ${FONT_MONO}`;
        ctx.fillStyle = active || selected ? ink : muted;
        ctx.textAlign = 'center'; ctx.textBaseline = 'top';
        ctx.fillText(`#${node.label}`, x, y + r + 2 / scale);
      }
    } else if (node.type === 'author') {
      const r = avatarR(node.count || 1);
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
      ctx.lineWidth = (selected || active ? 2.2 : 1.2) / scale;
      ctx.strokeStyle = selected || active ? accent : catColor(hue, 0.75);
      ctx.stroke();
      ctx.shadowBlur = 0;
      if (labelBudget && (scale >= 1.35 || active || selected || (matchIds && matched))) {
        const fs = Math.max(2.6, 10.5 / scale);
        ctx.font = `${fs}px ${FONT_UI}`;
        ctx.fillStyle = active || selected ? ink : muted;
        ctx.textAlign = 'center'; ctx.textBaseline = 'top';
        ctx.fillText(node.label, x, y + r + 2.5 / scale);
      }
    } else {
      const r = itemR(node.useful);
      const color = catColor(hue, 1, dark ? 0.72 : 0.55);
      if (scale >= 1.5 && node.thumb) {
        const R = r * 2.4;
        node.__r = R;
        const im = getImg(node.thumb);
        ctx.save();
        ctx.beginPath(); ctx.arc(x, y, R, 0, TAU); ctx.closePath(); ctx.clip();
        if (im.complete && im.naturalWidth) {
          const s = Math.max((R * 2) / im.naturalWidth, (R * 2) / im.naturalHeight);
          const w = im.naturalWidth * s, h = im.naturalHeight * s;
          ctx.drawImage(im, x - w / 2, y - h / 2, w, h);
        } else { ctx.fillStyle = color; ctx.fillRect(x - R, y - R, R * 2, R * 2); }
        ctx.restore();
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
  }, [mode, dark, ink, muted, accent, catColor, hueOf, matchIds, activeSet, selectedId, labelBudget, fontsReady]);

  const linkColor = useCallback((l: SimLink) => {
    const s = nodeIdOf(l.source), t = nodeIdOf(l.target);
    const on = activeSet ? activeSet.has(s) && activeSet.has(t) : true;
    const base = mode === 'overview' ? 0.16 + Math.min(0.24, (l.weight || 1) / 260) : l.kind === 'similar' ? 0.35 : l.kind === 'category' ? 0.06 : 0.18;
    const a = on ? base : 0.02;
    return dark ? `rgba(237,234,226,${a})` : `rgba(23,22,26,${a})`;
  }, [activeSet, dark, mode]);
  const linkWidth = useCallback((l: SimLink) => (mode === 'overview' ? 0.5 + Math.min(2, (l.weight || 1) / 55) : l.kind === 'similar' ? 1.2 : 0.6), [mode]);

  const hoverIdRef = useRef<string | null>(null);
  return (
    <ForceGraph2D
      ref={fgRef as any}
      width={width}
      height={height}
      graphData={data as any}
      backgroundColor="rgba(0,0,0,0)"
      nodeCanvasObject={paint as any}
      nodeCanvasObjectMode={replaceMode}
      nodePointerAreaPaint={(node: any, color: string, ctx: CanvasRenderingContext2D) => {
        const r = (node.__r || radiusOf(node, mode)) + 3;
        ctx.fillStyle = color; ctx.beginPath(); ctx.arc(node.x, node.y, r, 0, TAU); ctx.fill();
      }}
      linkColor={linkColor as any}
      linkWidth={linkWidth as any}
      linkDirectionalParticles={0}
      onNodeHover={(n: any) => {
        if ((n?.id || null) !== hoverIdRef.current) { hoverIdRef.current = n?.id || null; onHover(n || null); }
      }}
      onNodeClick={onNodeClick as any}
      onBackgroundClick={onBackgroundClick}
      onEngineStop={() => {
        if (!fittedRef.current) { fittedRef.current = true; fgRef.current?.zoomToFit(700, mode === 'overview' ? 70 : 50); }
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
