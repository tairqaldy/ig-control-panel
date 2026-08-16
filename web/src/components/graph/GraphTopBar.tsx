import { useState } from 'react';
import { ChevronLeft, Layers, Maximize2, Search, SlidersHorizontal, X } from 'lucide-react';
import type { GraphMeta, GraphMode } from '../../lib/types-graph';
import { Popover, Toggle } from '../ui';
import { cn } from '../../lib/utils';

const MODES: Array<{ id: GraphMode; label: string; hint: string }> = [
  { id: 'overview', label: 'Map', hint: 'Categories, their tags and creators' },
  { id: 'category', label: 'Category', hint: 'One category and its saves' },
  { id: 'all', label: 'Everything', hint: 'Every save at once — heavier' },
];

export interface GraphTopBarProps {
  mode: GraphMode;
  category: string;
  meta: GraphMeta | undefined;
  nodeCount: number;
  linkCount: number;
  query: string;
  onQuery: (v: string) => void;
  onMode: (m: GraphMode, category?: string) => void;
  onBack: () => void;
  onFit: () => void;
  tune: { minTag: number; maxItems: number; similar: boolean };
  onTune: (patch: Partial<{ minTag: number; maxItems: number; similar: boolean }>) => void;
}

/**
 * The quiet bar over the canvas: where you are on the left, Search and View on the right. Everything else
 * (the old chip row, the tune sliders) moved into the View popover or onto the map itself.
 */
export default function GraphTopBar({ mode, category, meta, nodeCount, linkCount, query, onQuery, onMode, onBack, onFit, tune, onTune }: GraphTopBarProps) {
  const [viewOpen, setViewOpen] = useState(false);
  const [anchor, setAnchor] = useState<HTMLButtonElement | null>(null);
  const cats = meta?.categories || [];
  const n = (v: number | undefined) => (v ?? 0).toLocaleString();

  const title = mode === 'category' ? category : mode === 'all' ? 'Everything' : 'Map of your taste';
  const sub = mode === 'category'
    ? [`${n(meta?.totalAnalyzed)} saves`, `${n(meta?.tags)} tags`, meta?.capped ? `${n(meta?.items)} newest shown` : ''].filter(Boolean).join(' · ')
    : mode === 'all'
      ? [`${n(meta?.items)} saves`, `${n(meta?.tags)} tags`, `${n(linkCount)} links`].filter(Boolean).join(' · ')
      : `${cats.length} categories · ${n(meta?.totals.items)} saves`;

  return (
    <div className="pointer-events-none absolute inset-x-0 top-0 flex flex-wrap items-start gap-2 p-3 sm:p-4">
      <div className="pointer-events-auto card flex min-w-0 items-center gap-2.5 px-3 py-2">
        {mode === 'category' && (
          <button onClick={onBack} className="btn btn-ghost btn-sm !px-1.5 -ml-1 shrink-0" aria-label="Back to the map"><ChevronLeft size={16} /></button>
        )}
        <div className="min-w-0">
          <div className="flex items-center gap-1.5 text-[11px] text-muted">
            {mode === 'category' ? (
              <><button onClick={onBack} className="hover:text-ink transition-colors">Map</button><span aria-hidden>›</span><span className="truncate text-ink-2">{category}</span></>
            ) : (
              <span className="eyebrow">Knowledge graph</span>
            )}
          </div>
          <div className="display truncate text-[17px] leading-tight sm:text-[20px]">{title}</div>
        </div>
        <div className="hidden whitespace-nowrap border-l border-line pl-2.5 font-mono text-[11px] text-muted md:block">{sub}</div>
      </div>

      <div className="pointer-events-auto ml-auto flex items-center gap-1.5">
        <div className="card flex items-center gap-1.5 px-2 py-1.5">
          <Search size={14} className="ml-1 shrink-0 text-muted" />
          <input
            value={query}
            onChange={(e) => onQuery(e.target.value)}
            placeholder="Search the map"
            aria-label="Search the map"
            className="w-28 min-w-0 bg-transparent text-[13px] outline-none placeholder:text-muted-2 sm:w-48"
          />
          {query && <button onClick={() => onQuery('')} className="btn btn-ghost btn-sm !px-1" aria-label="Clear search"><X size={13} /></button>}
        </div>
        <button ref={setAnchor} onClick={() => setViewOpen((v) => !v)} aria-expanded={viewOpen} className={cn('btn btn-sm', viewOpen && 'chip-active border-accent')}><Layers size={13} /> <span className="hidden sm:inline">View</span></button>
        <button onClick={onFit} className="btn btn-sm !px-2" title="Fit to screen" aria-label="Fit to screen"><Maximize2 size={13} /></button>
      </div>

      <Popover anchor={anchor} open={viewOpen} onClose={() => setViewOpen(false)} width={272} align="end">
        <div className="p-2 space-y-2.5 text-[13px]">
          <div>
            <div className="eyebrow mb-1.5">View</div>
            <div className="space-y-0.5">
              {MODES.map((m) => (
                <button
                  key={m.id}
                  onClick={() => { onMode(m.id, m.id === 'category' ? category || cats[0]?.name : undefined); if (m.id !== 'category') setViewOpen(false); }}
                  aria-pressed={mode === m.id}
                  className={cn('flex w-full flex-col rounded-lg px-2.5 py-1.5 text-left transition-colors hover:bg-surface-2', mode === m.id && 'bg-surface-2')}
                >
                  <span className={cn('text-[13px]', mode === m.id && 'text-accent')}>{m.label}</span>
                  <span className="text-[11.5px] text-muted">{m.hint}</span>
                </button>
              ))}
            </div>
          </div>

          {mode === 'category' && (
            <div className="border-t border-line pt-2.5">
              <label className="eyebrow mb-1.5 block" htmlFor="graph-category">Which category</label>
              <select id="graph-category" value={category} onChange={(e) => onMode('category', e.target.value)} className="input !py-1.5">
                {cats.map((c) => <option key={c.name} value={c.name}>{c.name} ({c.count})</option>)}
              </select>
            </div>
          )}

          {mode === 'all' && (
            <div className="space-y-2.5 border-t border-line pt-2.5">
              <div className="eyebrow">Tune</div>
              <label className="flex items-center justify-between gap-2 text-ink-2">
                Min tag uses
                <input type="range" min={1} max={12} value={tune.minTag} onChange={(e) => onTune({ minTag: Number(e.target.value) })} className="w-24 accent-[var(--accent)]" />
                <span className="w-4 font-mono text-[11px] text-muted">{tune.minTag}</span>
              </label>
              <label className="flex items-center justify-between gap-2 text-ink-2" title="Most recent saves first. Fewer is smoother.">
                Saves shown
                <input type="range" min={100} max={3000} step={100} value={tune.maxItems} onChange={(e) => onTune({ maxItems: Number(e.target.value) })} className="w-24 accent-[var(--accent)]" />
                <span className="w-9 font-mono text-[11px] text-muted">{tune.maxItems}</span>
              </label>
              <Toggle checked={tune.similar} onChange={(v) => onTune({ similar: v })} label="Similarity links" />
            </div>
          )}

          <div className="flex items-center gap-1.5 border-t border-line pt-2.5 text-[11.5px] text-muted">
            <SlidersHorizontal size={12} className="shrink-0" />
            {nodeCount} nodes · {linkCount} links on screen
          </div>
        </div>
      </Popover>
    </div>
  );
}
