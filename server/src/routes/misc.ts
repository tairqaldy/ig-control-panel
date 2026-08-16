import { Hono } from 'hono';
import { stream } from 'hono/streaming';
import { db, getMeta, j, now, setMeta } from '../db.js';
import { currentTenant, tid } from '../auth.js';
import type { Analysis, ItemRow } from '../types.js';
import { worker } from '../services/worker.js';
import { toCsv, toExportItem, toMarkdownDigest, toObsidianZip } from '../services/exporters.js';
import { askStream, retrieve } from '../services/ask.js';
import { markResurfaced, pickResurface, resurfaceNotes, todayKey } from '../services/resurface.js';
import { lightItem } from './items.js';
import { hasOpenAI } from '../services/openai.js';
import { CATEGORIES } from '../prompts/analysis.js';
import { rebuildAllNeighbors } from '../services/neighbors.js';
import { reindexAll } from '../services/search.js';
import { budgetExhausted, getScope, recomputeSavedAtEst, resetBudget, scopeReport, scopeWhereSql, setScope, type Scope } from '../services/scope.js';
import { bumpUsage, checkQuota, finite, limitsFor, quotaResponse } from '../services/plans.js';

export const misc = new Hono();

/* ---------------- stats ---------------- */
misc.get('/stats', (c) => {
  const t = tid(c);
  const d = db();
  const totals = d.prepare(`SELECT COUNT(*) AS total,
      SUM(CASE WHEN analysis_status = 'done' THEN 1 ELSE 0 END) AS analyzed,
      SUM(CASE WHEN analysis_status = 'pending' THEN 1 ELSE 0 END) AS pending,
      SUM(CASE WHEN analysis_status = 'failed' THEN 1 ELSE 0 END) AS failed,
      SUM(CASE WHEN analysis_status = 'skipped' THEN 1 ELSE 0 END) AS skipped,
      SUM(CASE WHEN media_type = 'video' THEN 1 ELSE 0 END) AS videos,
      SUM(CASE WHEN media_type = 'image' THEN 1 ELSE 0 END) AS images,
      SUM(CASE WHEN media_type = 'carousel' THEN 1 ELSE 0 END) AS carousels,
      SUM(CASE WHEN transcript IS NOT NULL AND transcript != '' THEN 1 ELSE 0 END) AS transcribed,
      SUM(CASE WHEN favorite = 1 THEN 1 ELSE 0 END) AS favorites,
      SUM(COALESCE(duration, 0)) AS total_seconds,
      COUNT(DISTINCT author_username) AS authors
    FROM items WHERE tenant_id = ? AND archived = 0 AND excluded = 0`).get(t) as any;
  const categories = d.prepare(`SELECT json_extract(analysis, '$.category') AS name, COUNT(*) AS n FROM items WHERE tenant_id = ? AND archived = 0 AND excluded = 0 AND analysis_status = 'done' GROUP BY name ORDER BY n DESC`).all(t);
  const tags = d.prepare(`SELECT t.tag AS name, COUNT(*) AS n FROM item_tags t JOIN items i ON i.id = t.item_id WHERE i.tenant_id = ? AND i.archived = 0 AND i.excluded = 0 GROUP BY t.tag ORDER BY n DESC LIMIT 40`).all(t);
  const authors = d.prepare(`SELECT author_username AS name, author_name AS full_name, COUNT(*) AS n FROM items WHERE tenant_id = ? AND archived = 0 AND excluded = 0 AND author_username IS NOT NULL GROUP BY author_username ORDER BY n DESC LIMIT 20`).all(t);
  const contentTypes = d.prepare(`SELECT json_extract(analysis, '$.content_type') AS name, COUNT(*) AS n FROM items WHERE tenant_id = ? AND archived = 0 AND excluded = 0 AND analysis_status = 'done' GROUP BY name ORDER BY n DESC`).all(t);
  const actions = d.prepare(`SELECT json_extract(analysis, '$.action_type') AS name, COUNT(*) AS n FROM items WHERE tenant_id = ? AND archived = 0 AND excluded = 0 AND analysis_status = 'done' GROUP BY name ORDER BY n DESC`).all(t);
  const timeline = d.prepare(`SELECT strftime('%Y-%m', datetime(COALESCE(saved_at, taken_at), 'unixepoch')) AS month, COUNT(*) AS n FROM items WHERE tenant_id = ? AND archived = 0 AND excluded = 0 AND COALESCE(saved_at, taken_at) IS NOT NULL GROUP BY month ORDER BY month ASC`).all(t);
  const usefulness = d.prepare(`SELECT CAST(json_extract(analysis, '$.usefulness_score') AS INTEGER) AS score, COUNT(*) AS n FROM items WHERE tenant_id = ? AND archived = 0 AND excluded = 0 AND analysis_status = 'done' GROUP BY score ORDER BY score`).all(t);
  const languages = d.prepare(`SELECT json_extract(analysis, '$.language') AS name, COUNT(*) AS n FROM items WHERE tenant_id = ? AND archived = 0 AND excluded = 0 AND analysis_status = 'done' GROUP BY name ORDER BY n DESC LIMIT 8`).all(t);
  const evergreen = (d.prepare(`SELECT COUNT(*) AS n FROM items WHERE tenant_id = ? AND archived = 0 AND excluded = 0 AND json_extract(analysis, '$.is_evergreen') = 1`).get(t) as any).n;
  const lastImport = d.prepare('SELECT * FROM imports WHERE tenant_id = ? ORDER BY id DESC LIMIT 1').get(t);
  return c.json({ totals: { ...totals, evergreen }, categories, tags, authors, contentTypes, actions, timeline, usefulness, languages, worker: worker.status(t), lastImport, igUsername: getMeta(t, 'ig_username') });
});

misc.get('/facets', (c) => {
  const t = tid(c);
  const d = db();
  const tags = d.prepare(`SELECT t.tag AS name, COUNT(*) AS n FROM item_tags t JOIN items i ON i.id = t.item_id WHERE i.tenant_id = ? AND i.archived = 0 AND i.excluded = 0 GROUP BY t.tag HAVING n >= 1 ORDER BY n DESC, t.tag ASC LIMIT 600`).all(t);
  const authors = d.prepare(`SELECT author_username AS name, author_name AS full_name, COUNT(*) AS n FROM items WHERE tenant_id = ? AND archived = 0 AND excluded = 0 AND author_username IS NOT NULL GROUP BY author_username ORDER BY n DESC LIMIT 400`).all(t);
  const categories = d.prepare(`SELECT json_extract(analysis, '$.category') AS name, COUNT(*) AS n FROM items WHERE tenant_id = ? AND archived = 0 AND excluded = 0 AND analysis_status = 'done' GROUP BY name ORDER BY n DESC`).all(t);
  const collections = d.prepare(`SELECT je.value AS name, COUNT(*) AS n FROM items i, json_each(i.collections) je WHERE i.tenant_id = ? AND i.archived = 0 AND i.excluded = 0 GROUP BY je.value ORDER BY n DESC`).all(t);
  const contentTypes = d.prepare(`SELECT json_extract(analysis, '$.content_type') AS name, COUNT(*) AS n FROM items WHERE tenant_id = ? AND archived = 0 AND excluded = 0 AND analysis_status = 'done' GROUP BY name ORDER BY n DESC`).all(t);
  return c.json({ tags, authors, categories, collections, contentTypes, allCategories: CATEGORIES });
});

/* ---------------- jobs ---------------- */
function queueJson(r: { queued: number; leftOut: number; quota: ReturnType<typeof checkQuota> | null }) {
  return { justQueued: r.queued, leftOut: r.leftOut, quota: r.quota ? { metric: r.quota.metric, plan: r.quota.plan, used: r.quota.used, limit: finite(r.quota.limit), remaining: finite(r.quota.remaining), resetsAt: r.quota.resetsAt } : null };
}
misc.get('/jobs/status', (c) => c.json(worker.status(tid(c))));
misc.post('/jobs/pause', (c) => { const t = tid(c); worker.pause(t, 'manual'); return c.json(worker.status(t)); });
misc.post('/jobs/resume', (c) => { const t = tid(c); worker.resume(t); return c.json(worker.status(t)); });
misc.post('/jobs/queue', async (c) => {
  const t = tid(c);
  const body = await c.req.json<{ what?: 'pending' | 'failed' | 'all' | 'eligible'; ids?: string[]; force?: boolean }>().catch(() => ({}) as any);
  const r = body.ids?.length ? worker.enqueue(t, body.ids, { force: !!body.force }) : worker.enqueue(t, body.what || 'eligible');
  worker.kick();
  return c.json({ ...worker.status(t), ...queueJson(r) });
});
misc.post('/jobs/reset-quota-failures', (c) => { const t = tid(c); return c.json({ reset: worker.resetQuotaFailures(t), ...worker.status(t) }); });

/* ---------------- analysis scope + cost ---------------- */
misc.get('/scope', (c) => c.json(scopeReport(tid(c))));
misc.put('/scope', async (c) => {
  const t = tid(c);
  const body = await c.req.json<Partial<Scope> & { resetBudget?: boolean }>();
  setScope(t, body);
  if (body.resetBudget) resetBudget(t);
  // Scope change → drop queued items that are no longer eligible so money isn't spent on them.
  const w = scopeWhereSql(getScope(t));
  db().prepare(`UPDATE items SET queue_state = 'idle' WHERE tenant_id = ? AND queue_state = 'queued' AND NOT (${w.sql})`).run(t, ...w.params);
  if (worker.pauseReason(t) === 'budget' && !budgetExhausted(t)) worker.resume(t);
  return c.json(scopeReport(t));
});
misc.post('/scope/recompute-dates', (c) => { const t = tid(c); return c.json({ updated: recomputeSavedAtEst(t), ...scopeReport(t) }); });
misc.post('/jobs/clear', (c) => { const t = tid(c); return c.json({ cleared: worker.dequeueAll(t), ...worker.status(t) }); });
misc.post('/jobs/concurrency', async (c) => {
  const s = currentTenant(c)!;
  const b = await c.req.json<{ concurrency: number }>();
  // the global concurrency budget is an operator setting; hosted tenants get their plan's cap
  if (s.isOwner) worker.concurrency = b.concurrency;
  return c.json(worker.status(s.tid));
});
misc.post('/jobs/reindex', (c) => { const t = tid(c); return c.json({ indexed: reindexAll(t), neighbors: rebuildAllNeighbors(t) }); });

/* ---------------- export ---------------- */
function selectForExport(t: number, c: any): ItemRow[] {
  const ids = c.req.query('ids');
  const category = c.req.query('category');
  const tag = c.req.query('tag');
  const onlyAnalyzed = c.req.query('analyzed') === '1';
  const favorite = c.req.query('favorite') === '1';
  const where: string[] = ['tenant_id = ?', 'archived = 0', 'excluded = 0'];
  const params: unknown[] = [t];
  if (ids) { const list = String(ids).split(',').filter(Boolean).slice(0, 5000); where.push(`id IN (${list.map(() => '?').join(',')})`); params.push(...list); }
  if (category) { where.push("json_extract(analysis, '$.category') = ?"); params.push(category); }
  if (tag) { where.push('EXISTS (SELECT 1 FROM item_tags t WHERE t.item_id = items.id AND t.tag = ?)'); params.push(tag); }
  if (onlyAnalyzed) where.push("analysis_status = 'done'");
  if (favorite) where.push('favorite = 1');
  return db().prepare(`SELECT * FROM items WHERE ${where.join(' AND ')} ORDER BY CASE WHEN saved_rank IS NULL THEN 1 ELSE 0 END, saved_rank ASC, saved_at DESC`).all(...params) as ItemRow[];
}

misc.get('/export', async (c) => {
  const format = (c.req.query('format') || 'json').toLowerCase();
  const rows = selectForExport(tid(c), c);
  const base = new URL(c.req.url).origin;
  const items = rows.map((r) => toExportItem(r, base));
  const stamp = new Date().toISOString().slice(0, 10);
  if (format === 'csv') {
    return c.body(toCsv(items), 200, { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': `attachment; filename="resurfly-${stamp}.csv"` });
  }
  if (format === 'md' || format === 'markdown') {
    return c.body(toMarkdownDigest(items), 200, { 'content-type': 'text/markdown; charset=utf-8', 'content-disposition': `attachment; filename="resurfly-${stamp}.md"` });
  }
  if (format === 'obsidian') {
    const zip = toObsidianZip(items);
    return c.body(new Uint8Array(zip), 200, { 'content-type': 'application/zip', 'content-disposition': `attachment; filename="resurfly-obsidian-${stamp}.zip"` });
  }
  return c.body(JSON.stringify({ exported_at: new Date().toISOString(), count: items.length, items }, null, 2), 200, { 'content-type': 'application/json; charset=utf-8', 'content-disposition': `attachment; filename="resurfly-${stamp}.json"` });
});

/* ---------------- ask (killer feature) ---------------- */
misc.post('/ask', async (c) => {
  const t = tid(c);
  if (!hasOpenAI(t)) return c.json({ error: 'OpenAI API key not configured' }, 503);
  const body = await c.req.json<{ question: string; history?: Array<{ role: 'user' | 'assistant'; content: string }> }>();
  const question = (body.question || '').trim();
  if (!question) return c.json({ error: 'question required' }, 400);
  const q = checkQuota(t, 'ask', 1);
  if (!q.ok) return quotaResponse(c, q);
  bumpUsage(t, 'ask', 1);
  const sources = await retrieve(t, question, 12);
  c.header('content-type', 'text/event-stream');
  c.header('cache-control', 'no-cache');
  c.header('x-accel-buffering', 'no');
  return stream(c, async (s) => {
    const send = (event: string, data: unknown) => s.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    await send('sources', sources);
    try {
      for await (const delta of askStream(t, question, body.history || [], sources)) await send('delta', delta);
      const after = checkQuota(t, 'ask', 1);
      await send('done', { ok: true, quota: { used: after.used, limit: finite(after.limit), remaining: finite(after.remaining), resetsAt: after.resetsAt } });
    } catch (e: any) {
      await send('error', { message: String(e?.message || e) });
    }
  });
});

/* ---------------- resurfly ---------------- */
misc.get('/resurface', async (c) => {
  const t = tid(c);
  const n = Math.min(6, Math.max(1, Number(c.req.query('n') || 3)));
  const dateKey = todayKey();
  const picks = pickResurface(t, n, dateKey);
  const notes = await resurfaceNotes(t, picks, dateKey);
  const seenKey = `resurface_seen:${dateKey}`;
  const seen = getMeta(t, seenKey) === '1';
  if (!seen && picks.length) { markResurfaced(t, picks.map((p) => p.id)); setMeta(t, seenKey, '1'); }
  return c.json({ date: dateKey, items: picks.map((p) => ({ ...lightItem(p), why_today: notes[p.id] || j<Analysis | null>(p.analysis, null)?.resurface_prompt || '' })) });
});
misc.get('/resurface/random', (c) => {
  const t = tid(c);
  const r = db().prepare("SELECT * FROM items WHERE tenant_id = ? AND analysis_status = 'done' AND archived = 0 ORDER BY RANDOM() LIMIT 1").get(t) as ItemRow | undefined;
  if (!r) return c.json({ item: null });
  markResurfaced(t, [r.id]);
  return c.json({ item: { ...lightItem(r), why_today: j<Analysis | null>(r.analysis, null)?.resurface_prompt || '' } });
});

/* ---------------- graph ---------------- */
misc.get('/graph', (c) => {
  const t = tid(c);
  const d = db();
  // Defaults are tuned so a 1,500-save library yields ~5k links (smooth), not 15k+ (freezes). Plans cap the node count.
  const graphCap = limitsFor(t).graphNodes;
  const maxItems = Math.min(6000, graphCap, Number(c.req.query('max_items') || 800));
  const minTag = Math.max(1, Number(c.req.query('min_tag') || 3));
  const minAuthor = Math.max(1, Number(c.req.query('min_author') || 3));
  const tagsPerItem = Math.max(1, Math.min(10, Number(c.req.query('tags_per_item') || 3)));
  const similarPerItem = Math.max(0, Math.min(8, Number(c.req.query('similar_per_item') || 2)));
  const similarMin = Math.min(0.99, Math.max(0.3, Number(c.req.query('similar_min') || 0.7)));
  const includeSimilar = c.req.query('similar') !== '0' && similarPerItem > 0;
  const includeCategoryHubs = c.req.query('category_hubs') !== '0';
  const category = c.req.query('category') || '';
  const where = ['tenant_id = ?', 'archived = 0', 'excluded = 0', "analysis_status = 'done'"];
  const params: unknown[] = [t];
  if (category) { where.push("json_extract(analysis, '$.category') = ?"); params.push(category); }
  const rows = d.prepare(`SELECT id, author_username, thumb_path, analysis, like_count, play_count FROM items WHERE ${where.join(' AND ')} ORDER BY CASE WHEN saved_rank IS NULL THEN 1 ELSE 0 END, saved_rank ASC LIMIT ?`).all(...params, maxItems) as any[];
  const ids = new Set(rows.map((r) => r.id));
  const nodes: any[] = [];
  const links: any[] = [];
  const tagCount = new Map<string, number>();
  const authorCount = new Map<string, number>();
  const catCount = new Map<string, number>();
  const parsed = rows.map((r) => ({ ...r, a: j<Analysis | null>(r.analysis, null) }));
  for (const r of parsed) {
    if (!r.a) continue;
    for (const tg of r.a.tags) tagCount.set(tg, (tagCount.get(tg) || 0) + 1);
    if (r.author_username) authorCount.set(r.author_username, (authorCount.get(r.author_username) || 0) + 1);
    catCount.set(r.a.category, (catCount.get(r.a.category) || 0) + 1);
  }
  const keepTags = new Set(Array.from(tagCount.entries()).filter(([, n]) => n >= minTag).sort((a, b) => b[1] - a[1]).slice(0, 250).map(([tg]) => tg));
  const keepAuthors = new Set(Array.from(authorCount.entries()).filter(([, n]) => n >= minAuthor).slice(0, 150).map(([a]) => a));
  const usedTags = new Set<string>();
  const usedAuthors = new Set<string>();
  const itemNodes: any[] = [];
  for (const r of parsed) {
    if (!r.a) continue;
    itemNodes.push({ id: r.id, type: 'item', label: r.a.title, category: r.a.category, thumb: r.thumb_path ? `/media/${r.thumb_path}` : null, useful: r.a.usefulness_score, author: r.author_username, tags: r.a.tags });
    if (includeCategoryHubs) links.push({ source: r.id, target: `cat:${r.a.category}`, kind: 'category' });
    // only the item's N most-shared tags → clusters form around real themes, link count stays sane
    const tagsSorted = (r.a.tags as string[]).filter((tg: string) => keepTags.has(tg)).sort((x: string, y: string) => (tagCount.get(y) || 0) - (tagCount.get(x) || 0)).slice(0, tagsPerItem);
    for (const tg of tagsSorted) { links.push({ source: r.id, target: `tag:${tg}`, kind: 'tag' }); usedTags.add(tg); }
    if (r.author_username && keepAuthors.has(r.author_username)) { links.push({ source: r.id, target: `author:${r.author_username}`, kind: 'author' }); usedAuthors.add(r.author_username); }
  }
  if (includeCategoryHubs) for (const [cat, n] of catCount) nodes.push({ id: `cat:${cat}`, type: 'category', label: cat, count: n });
  for (const tg of usedTags) nodes.push({ id: `tag:${tg}`, type: 'tag', label: tg, count: tagCount.get(tg) });
  for (const a of usedAuthors) nodes.push({ id: `author:${a}`, type: 'author', label: `@${a}`, count: authorCount.get(a) });
  nodes.push(...itemNodes);
  if (includeSimilar) {
    // top-N strongest neighbors per item, undirected, above the threshold (edges only among this tenant's selected items)
    const nb = d.prepare('SELECT n.item_id, n.neighbor_id, n.score FROM item_neighbors n JOIN items i ON i.id = n.item_id WHERE i.tenant_id = ? AND n.score >= ? ORDER BY n.item_id, n.score DESC').all(t, similarMin) as Array<{ item_id: string; neighbor_id: string; score: number }>;
    const seen = new Set<string>();
    const perItem = new Map<string, number>();
    for (const e of nb) {
      if (!ids.has(e.item_id) || !ids.has(e.neighbor_id)) continue;
      const c1 = perItem.get(e.item_id) || 0;
      if (c1 >= similarPerItem) continue;
      const key = e.item_id < e.neighbor_id ? `${e.item_id}|${e.neighbor_id}` : `${e.neighbor_id}|${e.item_id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      perItem.set(e.item_id, c1 + 1);
      links.push({ source: e.item_id, target: e.neighbor_id, kind: 'similar', score: e.score });
    }
  }
  const totalDone = (d.prepare(`SELECT COUNT(*) AS n FROM items WHERE ${where.join(' AND ')}`).get(...params) as any).n as number;
  return c.json({ nodes, links, meta: { items: parsed.length, tags: usedTags.size, authors: usedAuthors.size, categories: includeCategoryHubs ? catCount.size : 0, links: links.length, maxItems, capped: totalDone > maxItems, planCap: finite(graphCap), totalAnalyzed: totalDone } });
});
