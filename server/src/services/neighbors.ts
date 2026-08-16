import { db } from '../db.js';
import { config } from '../config.js';
import { bufferToEmbedding, cosine, embedTexts } from './openai.js';

/** In-memory embedding cache for fast semantic search: tenant → (item id → vector). */
const cache = new Map<number, Map<string, Float32Array>>();
let loaded = false;

function bucket(tid: number): Map<string, Float32Array> {
  let m = cache.get(tid);
  if (!m) { m = new Map(); cache.set(tid, m); }
  return m;
}

/** Only vectors from the CURRENT model:dims are comparable. Others are dropped (and re-embedded lazily by the worker). */
export function currentEmbeddingTag(): string { return `${config.embedModel}:${config.embedDims}`; }

export function loadEmbeddings(force = false) {
  if (loaded && !force) return;
  cache.clear();
  const tag = currentEmbeddingTag();
  const rows = db().prepare('SELECT id, tenant_id, embedding, embedding_model FROM items WHERE embedding IS NOT NULL AND archived = 0 AND excluded = 0').all() as Array<{ id: string; tenant_id: number; embedding: Buffer; embedding_model: string | null }>;
  let mismatched = 0;
  for (const r of rows) {
    if (r.embedding_model && r.embedding_model !== tag) { mismatched++; continue; }
    bucket(r.tenant_id).set(r.id, bufferToEmbedding(r.embedding));
  }
  if (mismatched) {
    console.warn(`[embeddings] ${mismatched} vectors were made with a different model/dims than ${tag} — clearing them so they get re-embedded.`);
    db().prepare('UPDATE items SET embedding = NULL WHERE embedding_model IS NOT NULL AND embedding_model != ?').run(tag);
  }
  loaded = true;
}
export function setEmbedding(tid: number, id: string, vec: Float32Array) { loadEmbeddings(); bucket(tid).set(id, vec); }
export function dropEmbedding(tid: number, id: string) { cache.get(tid)?.delete(id); }
/** Forget a whole tenant (account deletion). */
export function dropTenantEmbeddings(tid: number) { cache.delete(tid); }
export function embeddingCount(tid: number) { loadEmbeddings(); return cache.get(tid)?.size || 0; }

export function topKSimilar(tid: number, vec: Float32Array, k: number, exclude?: string): Array<{ id: string; score: number }> {
  loadEmbeddings();
  const out: Array<{ id: string; score: number }> = [];
  const m = cache.get(tid);
  if (!m) return out;
  for (const [id, v] of m) {
    if (id === exclude) continue;
    const s = cosine(vec, v);
    if (out.length < k) { out.push({ id, score: s }); if (out.length === k) out.sort((a, b) => b.score - a.score); }
    else if (s > out[k - 1].score) { out[k - 1] = { id, score: s }; out.sort((a, b) => b.score - a.score); }
  }
  return out.sort((a, b) => b.score - a.score);
}

/** Recompute stored neighbors for one item (within its tenant), and update reverse edges where this item is a closer neighbor. */
export function updateNeighborsFor(tid: number, id: string, vec: Float32Array, k = 8) {
  setEmbedding(tid, id, vec);
  const d = db();
  const top = topKSimilar(tid, vec, k, id);
  const del = d.prepare('DELETE FROM item_neighbors WHERE item_id = ?');
  const ins = d.prepare('INSERT OR REPLACE INTO item_neighbors (item_id, neighbor_id, score) VALUES (?, ?, ?)');
  const countFor = d.prepare('SELECT COUNT(*) AS n, MIN(score) AS minScore FROM item_neighbors WHERE item_id = ?');
  const worstFor = d.prepare('SELECT neighbor_id FROM item_neighbors WHERE item_id = ? ORDER BY score ASC LIMIT 1');
  const delOne = d.prepare('DELETE FROM item_neighbors WHERE item_id = ? AND neighbor_id = ?');
  d.transaction(() => {
    del.run(id);
    for (const t of top) {
      ins.run(id, t.id, t.score);
      // reverse edge maintenance
      const c = countFor.get(t.id) as { n: number; minScore: number | null };
      if (c.n < k) ins.run(t.id, id, t.score);
      else if (c.minScore !== null && t.score > c.minScore) {
        const w = worstFor.get(t.id) as { neighbor_id: string } | undefined;
        if (w) delOne.run(t.id, w.neighbor_id);
        ins.run(t.id, id, t.score);
      }
    }
  })();
}

export function neighborsOf(tid: number, id: string, limit = 8): Array<{ id: string; score: number }> {
  return db().prepare('SELECT n.neighbor_id AS id, n.score FROM item_neighbors n JOIN items i ON i.id = n.neighbor_id WHERE n.item_id = ? AND i.tenant_id = ? ORDER BY n.score DESC LIMIT ?').all(id, tid, limit) as any;
}

export async function semanticSearch(tid: number, query: string, k = 30): Promise<Array<{ id: string; score: number }>> {
  const [vec] = await embedTexts(tid, [query]);
  return topKSimilar(tid, vec, k);
}

/** Rebuild all neighbor edges of one tenant from scratch (used after bulk changes). O(N^2) but fine for a few thousand items. */
export function rebuildAllNeighbors(tid: number, k = 8): number {
  loadEmbeddings(true);
  const d = db();
  d.prepare('DELETE FROM item_neighbors WHERE item_id IN (SELECT id FROM items WHERE tenant_id = ?)').run(tid);
  const ins = d.prepare('INSERT OR REPLACE INTO item_neighbors (item_id, neighbor_id, score) VALUES (?, ?, ?)');
  const m = cache.get(tid) || new Map<string, Float32Array>();
  const ids = Array.from(m.keys());
  d.transaction(() => {
    for (const id of ids) {
      const vec = m.get(id)!;
      for (const t of topKSimilar(tid, vec, k, id)) ins.run(id, t.id, t.score);
    }
  })();
  return ids.length;
}
