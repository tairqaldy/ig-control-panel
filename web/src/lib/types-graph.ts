/**
 * Types for GET /api/graph (the map of your taste). Kept out of lib/types.ts on purpose — the graph payload has its
 * own shape per mode and only the Graph page reads it.
 *
 *   mode=overview  categories + top tags + top creators, no item nodes (≤ ~70 nodes / ≤ ~120 links)
 *   mode=category  one category: its items, tags, creators + similarity links between the items
 *   mode=all       the whole library
 */
export type GraphMode = 'overview' | 'category' | 'all';
export type GraphNodeType = 'category' | 'tag' | 'author' | 'item';

export interface GNode {
  /** `cat:<name>` · `tag:<tag>` · `author:<username>` · <item id> */
  id: string;
  type: GraphNodeType;
  /** Category name, tag (no #), `@username`, or the save's title. */
  label: string;
  /** Saves behind this node. Absent on item nodes. */
  count?: number;
  /** The node's home category — the category itself for hubs, the strongest one for tags/creators/items. */
  category?: string | null;
  thumb?: string | null;
  /** Item nodes: usefulness 1–10 and the save's one-line summary (for the hover card). */
  useful?: number;
  oneLiner?: string | null;
  /** Category hubs: mean usefulness of the saves inside. */
  avgUseful?: number | null;
  author?: string | null;
  tags?: string[];
}

export interface GLink {
  source: string;
  target: string;
  kind: 'tag' | 'author' | 'category' | 'similar';
  /** overview: how many saves put this tag/creator in that category. */
  weight?: number;
  /** similar: cosine score. */
  score?: number;
}

export interface GraphMeta {
  mode: GraphMode;
  category: string | null;
  /** Every category in the library, biggest first — the source of truth for the ring and the View popover. */
  categories: Array<{ name: string; count: number }>;
  totals: { items: number; tags: number; creators: number };
  /** Item nodes returned (0 in overview). */
  items: number;
  tags: number;
  authors: number;
  links: number;
  maxItems: number;
  capped: boolean;
  planCap: number | null;
  /** Saves matching the current filter (all of them, not just the ones drawn). */
  totalAnalyzed: number;
}

export interface GraphResponse { nodes: GNode[]; links: GLink[]; meta: GraphMeta }

/** A node once d3-force has touched it (positions + the radius the painter last used, for hit-testing). */
export type SimNode = GNode & { x?: number; y?: number; vx?: number; vy?: number; fx?: number; fy?: number; __r?: number };
export type SimLink = Omit<GLink, 'source' | 'target'> & { source: SimNode | string; target: SimNode | string };

export const nodeIdOf = (x: SimNode | string): string => (typeof x === 'object' ? x.id : x);
/** The label as a human reads it: #tag, @creator, or the plain name. */
export const nodeTitle = (n: GNode): string => (n.type === 'tag' ? `#${n.label}` : n.label);
