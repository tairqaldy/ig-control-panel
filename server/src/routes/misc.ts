import { Hono } from 'hono';
import { stream } from 'hono/streaming';
import { db, getMeta, j, now, setMeta } from '../db.js';
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

export const misc = new Hono();

/* ---------------- stats ---------------- */
misc.get('/stats', (c) => {
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
    FROM items WHERE archived = 0`).get() as any;
  const categories = d.prepare(`SELECT json_extract(analysis, '$.category') AS name, COUNT(*) AS n FROM items WHERE archived = 0 AND analysis_status = 'done' GROUP BY name ORDER BY n DESC`).all();
  const tags = d.prepare(`SELECT t.tag AS name, COUNT(*) AS n FROM item_tags t JOIN items i ON i.id = t.item_id WHERE i.archived = 0 GROUP BY t.tag ORDER BY n DESC LIMIT 40`).all();
  const authors = d.prepare(`SELECT author_username AS name, author_name AS full_name, COUNT(*) AS n FROM items WHERE archived = 0 AND author_username IS NOT NULL GROUP BY author_username ORDER BY n DESC LIMIT 20`).all();
  const contentTypes = d.prepare(`SELECT json_extract(analysis, '$.content_type') AS name, COUNT(*) AS n FROM items WHERE archived = 0 AND analysis_status = 'done' GROUP BY name ORDER BY n DESC`).all();
  const actions = d.prepare(`SELECT json_extract(analysis, '$.action_type') AS name, COUNT(*) AS n FROM items WHERE archived = 0 AND analysis_status = 'done' GROUP BY name ORDER BY n DESC`).all();
  const timeline = d.prepare(`SELECT strftime('%Y-%m', datetime(COALESCE(saved_at, taken_at), 'unixepoch')) AS month, COUNT(*) AS n FROM items WHERE archived = 0 AND COALESCE(saved_at, taken_at) IS NOT NULL GROUP BY month ORDER BY month ASC`).all();
  const usefulness = d.prepare(`SELECT CAST(json_extract(analysis, '$.usefulness_score') AS INTEGER) AS score, COUNT(*) AS n FROM items WHERE archived = 0 AND analysis_status = 'done' GROUP BY score ORDER BY score`).all();
  const languages = d.prepare(`SELECT json_extract(analysis, '$.language') AS name, COUNT(*) AS n FROM items WHERE archived = 0 AND analysis_status = 'done' GROUP BY name ORDER BY n DESC LIMIT 8`).all();
  const evergreen = (d.prepare(`SELECT COUNT(*) AS n FROM items WHERE archived = 0 AND json_extract(analysis, '$.is_evergreen') = 1`).get() as any).n;
  const lastImport = d.prepare('SELECT * FROM imports ORDER BY id DESC LIMIT 1').get();
  return c.json({ totals: { ...totals, evergreen }, categories, tags, authors, contentTypes, actions, timeline, usefulness, languages, worker: worker.status(), lastImport, igUsername: getMeta('ig_username') });
});

misc.get('/facets', (c) => {
  const d = db();
  const tags = d.prepare(`SELECT t.tag AS name, COUNT(*) AS n FROM item_tags t JOIN items i ON i.id = t.item_id WHERE i.archived = 0 GROUP BY t.tag HAVING n >= 1 ORDER BY n DESC, t.tag ASC LIMIT 600`).all();
  const authors = d.prepare(`SELECT author_username AS name, author_name AS full_name, COUNT(*) AS n FROM items WHERE archived = 0 AND author_username IS NOT NULL GROUP BY author_username ORDER BY n DESC LIMIT 400`).all();
  const categories = d.prepare(`SELECT json_extract(analysis, '$.category') AS name, COUNT(*) AS n FROM items WHERE archived = 0 AND analysis_status = 'done' GROUP BY name ORDER BY n DESC`).all();
  const collections = d.prepare(`SELECT je.value AS name, COUNT(*) AS n FROM items i, json_each(i.collections) je WHERE i.archived = 0 GROUP BY je.value ORDER BY n DESC`).all();
  const contentTypes = d.prepare(`SELECT json_extract(analysis, '$.content_type') AS name, COUNT(*) AS n FROM items WHERE archived = 0 AND analysis_status = 'done' GROUP BY name ORDER BY n DESC`).all();
  return c.json({ tags, authors, categories, collections, contentTypes, allCategories: CATEGORIES });
});

/* ---------------- jobs ---------------- */
misc.get('/jobs/status', (c) => c.json(worker.status()));
misc.post('/jobs/pause', (c) => { worker.paused = true; return c.json(worker.status()); });
misc.post('/jobs/resume', (c) => { worker.paused = false; return c.json(worker.status()); });
misc.post('/jobs/queue', async (c) => {
  const body = await c.req.json<{ what?: 'pending' | 'failed' | 'all'; ids?: string[]; force?: boolean }>().catch(() => ({}) as any);
  const n = body.ids?.length ? worker.enqueue(body.ids, { force: !!body.force }) : worker.enqueue(body.what || 'pending');
  worker.kick();
  return c.json({ ...worker.status(), justQueued: n });
});
misc.post('/jobs/clear', (c) => c.json({ cleared: worker.dequeueAll(), ...worker.status() }));
misc.post('/jobs/concurrency', async (c) => { const b = await c.req.json<{ concurrency: number }>(); worker.concurrency = b.concurrency; return c.json(worker.status()); });
misc.post('/jobs/reindex', (c) => c.json({ indexed: reindexAll(), neighbors: rebuildAllNeighbors() }));

/* ---------------- export ---------------- */
function selectForExport(c: any): ItemRow[] {
  const ids = c.req.query('ids');
  const category = c.req.query('category');
  const tag = c.req.query('tag');
  const onlyAnalyzed = c.req.query('analyzed') === '1';
  const favorite = c.req.query('favorite') === '1';
  const where: string[] = ['archived = 0'];
  const params: unknown[] = [];
  if (ids) { const list = String(ids).split(',').filter(Boolean).slice(0, 5000); where.push(`id IN (${list.map(() => '?').join(',')})`); params.push(...list); }
  if (category) { where.push("json_extract(analysis, '$.category') = ?"); params.push(category); }
  if (tag) { where.push('EXISTS (SELECT 1 FROM item_tags t WHERE t.item_id = items.id AND t.tag = ?)'); params.push(tag); }
  if (onlyAnalyzed) where.push("analysis_status = 'done'");
  if (favorite) where.push('favorite = 1');
  return db().prepare(`SELECT * FROM items WHERE ${where.join(' AND ')} ORDER BY CASE WHEN saved_rank IS NULL THEN 1 ELSE 0 END, saved_rank ASC, saved_at DESC`).all(...params) as ItemRow[];
}

misc.get('/export', async (c) => {
  const format = (c.req.query('format') || 'json').toLowerCase();
  const rows = selectForExport(c);
  const base = new URL(c.req.url).origin;
  const items = rows.map((r) => toExportItem(r, base));
  const stamp = new Date().toISOString().slice(0, 10);
  if (format === 'csv') {
    return c.body(toCsv(items), 200, { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': `attachment; filename="resurface-${stamp}.csv"` });
  }
  if (format === 'md' || format === 'markdown') {
    return c.body(toMarkdownDigest(items), 200, { 'content-type': 'text/markdown; charset=utf-8', 'content-disposition': `attachment; filename="resurface-${stamp}.md"` });
  }
  if (format === 'obsidian') {
    const zip = toObsidianZip(items);
    return c.body(new Uint8Array(zip), 200, { 'content-type': 'application/zip', 'content-disposition': `attachment; filename="resurface-obsidian-${stamp}.zip"` });
  }
  return c.body(JSON.stringify({ exported_at: new Date().toISOString(), count: items.length, items }, null, 2), 200, { 'content-type': 'application/json; charset=utf-8', 'content-disposition': `attachment; filename="resurface-${stamp}.json"` });
});

/* ---------------- ask (killer feature) ---------------- */
misc.post('/ask', async (c) => {
  if (!hasOpenAI()) return c.json({ error: 'OpenAI API key not configured' }, 503);
  const body = await c.req.json<{ question: string; history?: Array<{ role: 'user' | 'assistant'; content: string }> }>();
  const question = (body.question || '').trim();
  if (!question) return c.json({ error: 'question required' }, 400);
  const sources = await retrieve(question, 12);
  c.header('content-type', 'text/event-stream');
  c.header('cache-control', 'no-cache');
  c.header('x-accel-buffering', 'no');
  return stream(c, async (s) => {
    const send = (event: string, data: unknown) => s.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    await send('sources', sources);
    try {
      for await (const delta of askStream(question, body.history || [], sources)) await send('delta', delta);
      await send('done', { ok: true });
    } catch (e: any) {
      await send('error', { message: String(e?.message || e) });
    }
  });
});

/* ---------------- resurface ---------------- */
misc.get('/resurface', async (c) => {
  const n = Math.min(6, Math.max(1, Number(c.req.query('n') || 3)));
  const dateKey = todayKey();
  const picks = pickResurface(n, dateKey);
  const notes = await resurfaceNotes(picks, dateKey);
  const seenKey = `resurface_seen:${dateKey}`;
  const seen = getMeta(seenKey) === '1';
  if (!seen && picks.length) { markResurfaced(picks.map((p) => p.id)); setMeta(seenKey, '1'); }
  return c.json({ date: dateKey, items: picks.map((p) => ({ ...lightItem(p), why_today: notes[p.id] || j<Analysis | null>(p.analysis, null)?.resurface_prompt || '' })) });
});
misc.get('/resurface/random', (c) => {
  const r = db().prepare("SELECT * FROM items WHERE analysis_status = 'done' AND archived = 0 ORDER BY RANDOM() LIMIT 1").get() as ItemRow | undefined;
  if (!r) return c.json({ item: null });
  markResurfaced([r.id]);
  return c.json({ item: { ...lightItem(r), why_today: j<Analysis | null>(r.analysis, null)?.resurface_prompt || '' } });
});

/* ---------------- graph ---------------- */
misc.get('/graph', (c) => {
  const d = db();
  const maxItems = Math.min(6000, Number(c.req.query('max_items') || 1500));
  const minTag = Math.max(1, Number(c.req.query('min_tag') || 2));
  const minAuthor = Math.max(1, Number(c.req.query('min_author') || 2));
  const includeSimilar = c.req.query('similar') !== '0';
  const category = c.req.query('category') || '';
  const where = ["archived = 0", "analysis_status = 'done'"];
  const params: unknown[] = [];
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
    for (const t of r.a.tags) tagCount.set(t, (tagCount.get(t) || 0) + 1);
    if (r.author_username) authorCount.set(r.author_username, (authorCount.get(r.author_username) || 0) + 1);
    catCount.set(r.a.category, (catCount.get(r.a.category) || 0) + 1);
  }
  const keepTags = new Set(Array.from(tagCount.entries()).filter(([, n]) => n >= minTag).sort((a, b) => b[1] - a[1]).slice(0, 400).map(([t]) => t));
  const keepAuthors = new Set(Array.from(authorCount.entries()).filter(([, n]) => n >= minAuthor).slice(0, 300).map(([a]) => a));
  for (const [cat, n] of catCount) nodes.push({ id: `cat:${cat}`, type: 'category', label: cat, count: n });
  for (const t of keepTags) nodes.push({ id: `tag:${t}`, type: 'tag', label: t, count: tagCount.get(t) });
  for (const a of keepAuthors) nodes.push({ id: `author:${a}`, type: 'author', label: `@${a}`, count: authorCount.get(a) });
  for (const r of parsed) {
    if (!r.a) continue;
    nodes.push({ id: r.id, type: 'item', label: r.a.title, category: r.a.category, thumb: r.thumb_path ? `/media/${r.thumb_path}` : null, useful: r.a.usefulness_score, author: r.author_username, tags: r.a.tags });
    links.push({ source: r.id, target: `cat:${r.a.category}`, kind: 'category' });
    for (const t of r.a.tags) if (keepTags.has(t)) links.push({ source: r.id, target: `tag:${t}`, kind: 'tag' });
    if (r.author_username && keepAuthors.has(r.author_username)) links.push({ source: r.id, target: `author:${r.author_username}`, kind: 'author' });
  }
  if (includeSimilar) {
    const nb = d.prepare('SELECT item_id, neighbor_id, score FROM item_neighbors WHERE score >= 0.62').all() as Array<{ item_id: string; neighbor_id: string; score: number }>;
    const seen = new Set<string>();
    for (const e of nb) {
      if (!ids.has(e.item_id) || !ids.has(e.neighbor_id)) continue;
      const key = e.item_id < e.neighbor_id ? `${e.item_id}|${e.neighbor_id}` : `${e.neighbor_id}|${e.item_id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      links.push({ source: e.item_id, target: e.neighbor_id, kind: 'similar', score: e.score });
    }
  }
  return c.json({ nodes, links, meta: { items: parsed.length, tags: keepTags.size, authors: keepAuthors.size, categories: catCount.size } });
});
