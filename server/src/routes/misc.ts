import { Hono } from 'hono';
import { stream } from 'hono/streaming';
import { db, getMeta, j, now, setMeta } from '../db.js';
import { currentTenant, tid } from '../auth.js';
import type { Analysis, ItemRow } from '../types.js';
import { worker } from '../services/worker.js';
import { toCsv, toExportItem, toMarkdownDigest, toObsidianZip } from '../services/exporters.js';
import { addMessage, askStream, createConversation, defaultTitle, getConversation, historyFor, planAsk, routeIntent, summarizeTitle, updateConversation, type AskPlan, type AskSource } from '../services/ask.js';
import { ONBOARDING_META_KEYS } from '../migrations/006-ask-onboarding.js';
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
/**
 * POST /api/ask  body { question, conversationId?, history?, intent? }  → SSE
 *   event: meta     { conversationId, title, intent, filters, via, isNew }   (always first)
 *   event: sources  AskSource[]                                              (may be [])
 *   event: delta    "text chunk"                                            (0..n)
 *   event: done     { ok, conversationId, title, intent, messageId, quota }
 *   event: error    { message }                                              (instead of done)
 * Both messages are persisted (user right after routing, assistant after the stream, also on client abort with the partial text).
 * `intent` in the body forces a strategy (library|stats|inspire|create|analytics|chat) — used by the UI mode chips; otherwise routed.
 */
misc.post('/ask', async (c) => {
  const t = tid(c);
  if (!hasOpenAI(t)) return c.json({ error: 'OpenAI API key not configured' }, 503);
  const body = await c.req.json<{ question: string; conversationId?: number | null; history?: Array<{ role: 'user' | 'assistant'; content: string }>; intent?: string | null }>().catch(() => ({}) as any);
  const question = String(body.question || '').trim();
  if (!question) return c.json({ error: 'question required' }, 400);
  let conversationId: number | null = body.conversationId ? Number(body.conversationId) : null;
  if (conversationId !== null && (!Number.isInteger(conversationId) || !getConversation(t, conversationId))) return c.json({ error: 'conversation not found' }, 404);
  const q = checkQuota(t, 'ask', 1);
  if (!q.ok) return quotaResponse(c, q);
  bumpUsage(t, 'ask', 1);

  const isNew = conversationId === null;
  if (conversationId === null) conversationId = createConversation(t, defaultTitle(question)).id;
  const convId = conversationId;
  let conv = getConversation(t, convId)!;
  const hadMessages = conv.messageCount > 0;
  // untitled conversation (created via POST /conversations without a title): give it the question as a provisional title
  if (!hadMessages && conv.title === 'New conversation') conv = updateConversation(t, convId, { title: defaultTitle(question) }) || conv;
  const autoTitled = !hadMessages && conv.title === defaultTitle(question); // only auto titles get replaced by the nano summary
  const history: Array<{ role: 'user' | 'assistant'; content: string }> = Array.isArray(body.history) && body.history.length
    ? body.history.filter((m: any) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string').slice(-8).map((m: any) => ({ role: m.role, content: String(m.content).slice(0, 4000) }))
    : historyFor(t, convId, 8);
  setMeta(t, ONBOARDING_META_KEYS.asked, String(now()));

  c.header('content-type', 'text/event-stream');
  c.header('cache-control', 'no-cache');
  c.header('x-accel-buffering', 'no');
  return stream(c, async (s) => {
    const send = (event: string, data: unknown) => s.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    let aborted = false;
    s.onAbort(() => { aborted = true; });
    let answer = '';
    let plan: AskPlan | null = null;
    let sources: AskSource[] = [];
    let intent: string = 'library';
    let persisted = false;
    const persistAssistant = () => {
      if (persisted || !answer.trim()) return null;
      persisted = true;
      try { return addMessage(t, convId, { role: 'assistant', content: answer, sources, intent: plan?.intent || (intent as any) }); } catch { return null; }
    };
    try {
      const routed = await routeIntent(t, question, history, body.intent || null);
      intent = routed.intent;
      addMessage(t, convId, { role: 'user', content: question, intent: routed.intent });
      await send('meta', { conversationId: convId, title: conv.title, intent: routed.intent, filters: routed.filters, via: routed.via, isNew });
      plan = await planAsk(t, question, routed, history);
      sources = plan.sources;
      await send('sources', sources);
      for await (const delta of askStream(t, question, history, sources, plan)) {
        if (aborted) break;
        answer += delta;
        await send('delta', delta);
      }
      const msg = persistAssistant();
      let title = conv.title;
      if (autoTitled && answer.trim() && !aborted) {
        const better = await Promise.race([summarizeTitle(t, question, answer), new Promise<null>((r) => setTimeout(() => r(null), 8000).unref())]).catch(() => null);
        if (better && getConversation(t, convId)?.title === conv.title) { updateConversation(t, convId, { title: better }); title = better; }
      }
      const after = checkQuota(t, 'ask', 1);
      await send('done', { ok: true, conversationId: convId, title, intent: plan.intent, messageId: msg?.id ?? null, quota: { used: after.used, limit: finite(after.limit), remaining: finite(after.remaining), resetsAt: after.resetsAt } });
    } catch (e: any) {
      persistAssistant();
      await send('error', { message: String(e?.message || e), conversationId: convId });
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
type GraphMode = 'overview' | 'category' | 'all';
/** Every graph query looks at the same slice of the library: this tenant, analyzed, not archived, not excluded. */
const G_WHERE = "tenant_id = ? AND archived = 0 AND excluded = 0 AND analysis_status = 'done'";
const G_WHERE_I = "i.tenant_id = ? AND i.archived = 0 AND i.excluded = 0 AND i.analysis_status = 'done'";
const G_CAT = "COALESCE(json_extract(analysis, '$.category'), 'Other')";
const G_CAT_I = "COALESCE(json_extract(i.analysis, '$.category'), 'Other')";
const gnum = (v: string | undefined, dflt: number, lo: number, hi: number) => {
  const n = v === undefined || v === '' ? dflt : Number(v);
  return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : dflt;
};

function graphCategoryRows(t: number) {
  return db().prepare(`SELECT ${G_CAT} AS name, COUNT(*) AS count, AVG(CAST(json_extract(analysis, '$.usefulness_score') AS REAL)) AS avg_useful
    FROM items WHERE ${G_WHERE} GROUP BY name ORDER BY count DESC, name ASC`).all(t) as Array<{ name: string; count: number; avg_useful: number | null }>;
}
function graphTotals(t: number) {
  const d = db();
  const items = (d.prepare(`SELECT COUNT(*) AS n FROM items WHERE ${G_WHERE}`).get(t) as any).n as number;
  const tags = (d.prepare(`SELECT COUNT(DISTINCT t.tag) AS n FROM item_tags t JOIN items i ON i.id = t.item_id WHERE ${G_WHERE_I}`).get(t) as any).n as number;
  const creators = (d.prepare(`SELECT COUNT(DISTINCT author_username) AS n FROM items WHERE ${G_WHERE} AND author_username IS NOT NULL AND author_username != ''`).get(t) as any).n as number;
  return { items, tags, creators };
}
/** Strongest 1–2 categories for a tag/creator: always the top one, the runner-up only when it is genuinely shared. */
function topTwo(list: Array<{ cat: string; n: number }>) {
  const s = list.slice().sort((a, b) => b.n - a.n || a.cat.localeCompare(b.cat));
  const out = s.slice(0, 1);
  if (s[1] && s[1].n >= 2 && s[1].n >= s[0].n * 0.6) out.push(s[1]);
  return out;
}

/**
 * mode=overview — the map. One node per category, the `topTags` most-used tags and the `topCreators` most-saved
 * creators, each linked to the 1–2 categories they actually live in. No item nodes: ≤ ~70 nodes / ≤ ~120 links.
 */
function overviewGraph(t: number, cats: ReturnType<typeof graphCategoryRows>, topTags: number, topCreators: number, graphCap: number) {
  const d = db();
  // categories are the map itself and are never dropped; the plan cap trims the tags/creators around them
  const room = Math.max(0, graphCap - cats.length);
  if (topTags + topCreators > room) { topCreators = Math.min(topCreators, Math.floor(room / 4)); topTags = Math.max(0, room - topCreators); }
  const catSet = new Set(cats.map((r) => r.name));
  const nodes: any[] = cats.map((r) => ({ id: `cat:${r.name}`, type: 'category', label: r.name, count: r.count, category: r.name, avgUseful: r.avg_useful === null ? null : Math.round(r.avg_useful * 10) / 10 }));
  const links: any[] = [];

  const tagRows = topTags > 0
    ? d.prepare(`SELECT t.tag AS tag, COUNT(*) AS n FROM item_tags t JOIN items i ON i.id = t.item_id WHERE ${G_WHERE_I} GROUP BY t.tag ORDER BY n DESC, t.tag ASC LIMIT ?`).all(t, topTags) as Array<{ tag: string; n: number }>
    : [];
  if (tagRows.length) {
    const ph = tagRows.map(() => '?').join(',');
    const mix = d.prepare(`SELECT t.tag AS tag, ${G_CAT_I} AS cat, COUNT(*) AS n FROM item_tags t JOIN items i ON i.id = t.item_id
      WHERE ${G_WHERE_I} AND t.tag IN (${ph}) GROUP BY t.tag, cat`).all(t, ...tagRows.map((r) => r.tag)) as Array<{ tag: string; cat: string; n: number }>;
    const byTag = new Map<string, Array<{ cat: string; n: number }>>();
    for (const m of mix) { const a = byTag.get(m.tag) || []; a.push({ cat: m.cat, n: m.n }); byTag.set(m.tag, a); }
    for (const r of tagRows) {
      const home = topTwo(byTag.get(r.tag) || []);
      nodes.push({ id: `tag:${r.tag}`, type: 'tag', label: r.tag, count: r.n, category: home[0]?.cat ?? null });
      for (const h of home) if (catSet.has(h.cat)) links.push({ source: `tag:${r.tag}`, target: `cat:${h.cat}`, kind: 'tag', weight: h.n });
    }
  }

  const creatorRows = topCreators > 0
    ? d.prepare(`SELECT author_username AS name, COUNT(*) AS n FROM items WHERE ${G_WHERE} AND author_username IS NOT NULL AND author_username != '' GROUP BY author_username ORDER BY n DESC, name ASC LIMIT ?`).all(t, topCreators) as Array<{ name: string; n: number }>
    : [];
  if (creatorRows.length) {
    const names = creatorRows.map((r) => r.name);
    const ph = names.map(() => '?').join(',');
    const mix = d.prepare(`SELECT author_username AS name, ${G_CAT} AS cat, COUNT(*) AS n FROM items WHERE ${G_WHERE} AND author_username IN (${ph}) GROUP BY author_username, cat`).all(t, ...names) as Array<{ name: string; cat: string; n: number }>;
    // thumb = the creator's most-liked save that actually has one
    const thumbRows = d.prepare(`SELECT author_username AS name, thumb_path FROM items WHERE ${G_WHERE} AND author_username IN (${ph}) AND thumb_path IS NOT NULL ORDER BY COALESCE(like_count, 0) DESC`).all(t, ...names) as Array<{ name: string; thumb_path: string }>;
    const thumbOf = new Map<string, string>();
    for (const r of thumbRows) if (!thumbOf.has(r.name)) thumbOf.set(r.name, r.thumb_path);
    const byCreator = new Map<string, Array<{ cat: string; n: number }>>();
    for (const m of mix) { const a = byCreator.get(m.name) || []; a.push({ cat: m.cat, n: m.n }); byCreator.set(m.name, a); }
    for (const r of creatorRows) {
      const home = topTwo(byCreator.get(r.name) || []);
      const thumb = thumbOf.get(r.name);
      nodes.push({ id: `author:${r.name}`, type: 'author', label: `@${r.name}`, author: r.name, count: r.n, category: home[0]?.cat ?? null, thumb: thumb ? `/media/${thumb}` : null });
      for (const h of home) if (catSet.has(h.cat)) links.push({ source: `author:${r.name}`, target: `cat:${h.cat}`, kind: 'author', weight: h.n });
    }
  }
  return { nodes, links, tags: tagRows.length, creators: creatorRows.length };
}

interface ItemGraphOpts { maxItems: number; minTag: number; minAuthor: number; tagsPerItem: number; similarPerItem: number; similarMin: number; includeSimilar: boolean; includeCategoryHubs: boolean; category: string }
/**
 * mode=category / mode=all — item nodes (newest first by saved_rank) with their tags, creators, category hubs and
 * similarity edges. Defaults are tuned so a 1,500-save library yields ~5k links (smooth), not 15k+ (freezes).
 */
function itemGraph(t: number, o: ItemGraphOpts) {
  const d = db();
  const where = ['tenant_id = ?', 'archived = 0', 'excluded = 0', "analysis_status = 'done'"];
  const params: unknown[] = [t];
  if (o.category) { where.push(`${G_CAT} = ?`); params.push(o.category); }
  const rows = d.prepare(`SELECT id, author_username, thumb_path, analysis, like_count, play_count FROM items WHERE ${where.join(' AND ')} ORDER BY CASE WHEN saved_rank IS NULL THEN 1 ELSE 0 END, saved_rank ASC LIMIT ?`).all(...params, o.maxItems) as any[];
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
  const keepTags = new Set(Array.from(tagCount.entries()).filter(([, n]) => n >= o.minTag).sort((a, b) => b[1] - a[1]).slice(0, 250).map(([tg]) => tg));
  const keepAuthors = new Set(Array.from(authorCount.entries()).filter(([, n]) => n >= o.minAuthor).slice(0, 150).map(([a]) => a));
  const usedTags = new Set<string>();
  const usedAuthors = new Set<string>();
  const itemNodes: any[] = [];
  for (const r of parsed) {
    if (!r.a) continue;
    itemNodes.push({ id: r.id, type: 'item', label: r.a.title, oneLiner: r.a.one_liner || null, category: r.a.category, thumb: r.thumb_path ? `/media/${r.thumb_path}` : null, useful: r.a.usefulness_score, author: r.author_username, tags: r.a.tags });
    if (o.includeCategoryHubs) links.push({ source: r.id, target: `cat:${r.a.category}`, kind: 'category' });
    // only the item's N most-shared tags → clusters form around real themes, link count stays sane
    const tagsSorted = (r.a.tags as string[]).filter((tg: string) => keepTags.has(tg)).sort((x: string, y: string) => (tagCount.get(y) || 0) - (tagCount.get(x) || 0)).slice(0, o.tagsPerItem);
    for (const tg of tagsSorted) { links.push({ source: r.id, target: `tag:${tg}`, kind: 'tag' }); usedTags.add(tg); }
    if (r.author_username && keepAuthors.has(r.author_username)) { links.push({ source: r.id, target: `author:${r.author_username}`, kind: 'author' }); usedAuthors.add(r.author_username); }
  }
  if (o.includeCategoryHubs) for (const [cat, n] of catCount) nodes.push({ id: `cat:${cat}`, type: 'category', label: cat, count: n, category: cat });
  for (const tg of usedTags) nodes.push({ id: `tag:${tg}`, type: 'tag', label: tg, count: tagCount.get(tg) });
  if (usedAuthors.size) {
    // creator avatar = their most-liked save that has a thumbnail
    const names = Array.from(usedAuthors);
    const rows2 = d.prepare(`SELECT author_username AS name, thumb_path FROM items WHERE ${G_WHERE} AND author_username IN (${names.map(() => '?').join(',')}) AND thumb_path IS NOT NULL ORDER BY COALESCE(like_count, 0) DESC`).all(t, ...names) as Array<{ name: string; thumb_path: string }>;
    const thumbOf = new Map<string, string>();
    for (const r of rows2) if (!thumbOf.has(r.name)) thumbOf.set(r.name, r.thumb_path);
    for (const a of names) {
      const th = thumbOf.get(a);
      nodes.push({ id: `author:${a}`, type: 'author', label: `@${a}`, author: a, count: authorCount.get(a), thumb: th ? `/media/${th}` : null });
    }
  }
  nodes.push(...itemNodes);
  if (o.includeSimilar && o.similarPerItem > 0) {
    // top-N strongest neighbors per item, undirected, above the threshold (edges only among this tenant's selected items)
    const nb = d.prepare('SELECT n.item_id, n.neighbor_id, n.score FROM item_neighbors n JOIN items i ON i.id = n.item_id WHERE i.tenant_id = ? AND n.score >= ? ORDER BY n.item_id, n.score DESC').all(t, o.similarMin) as Array<{ item_id: string; neighbor_id: string; score: number }>;
    const seen = new Set<string>();
    const perItem = new Map<string, number>();
    for (const e of nb) {
      if (!ids.has(e.item_id) || !ids.has(e.neighbor_id)) continue;
      const c1 = perItem.get(e.item_id) || 0;
      if (c1 >= o.similarPerItem) continue;
      const key = e.item_id < e.neighbor_id ? `${e.item_id}|${e.neighbor_id}` : `${e.neighbor_id}|${e.item_id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      perItem.set(e.item_id, c1 + 1);
      links.push({ source: e.item_id, target: e.neighbor_id, kind: 'similar', score: e.score });
    }
  }
  const totalDone = (d.prepare(`SELECT COUNT(*) AS n FROM items WHERE ${where.join(' AND ')}`).get(...params) as any).n as number;
  return { nodes, links, items: parsed.length, tags: usedTags.size, authors: usedAuthors.size, maxItems: o.maxItems, capped: totalDone > o.maxItems, totalAnalyzed: totalDone };
}

/**
 * GET /api/graph — three views over one library, all tenant-scoped, analysis_status='done', not archived/excluded,
 * ordered by saved_rank (newest first) and capped by the plan's `graphNodes`.
 *
 *   ?mode=overview (default)  the map: categories + the top tags + the top creators around them, no item nodes
 *                             (`top_tags` 36, `top_creators` 12 → ≤ ~70 nodes / ≤ ~120 links)
 *   ?mode=category&category=  one category: its items (`max_items` 250), its tags (≥ 2 items), its creators
 *                             (≥ 2 items) and the similarity links between those items
 *   ?mode=all                 the whole library, unchanged defaults (800 items, min_tag 3, similarity on)
 *
 * Every earlier query param still applies to category/all: max_items, min_tag, min_author, tags_per_item,
 * similar_per_item, similar_min, similar=0|1, category_hubs=0|1, category.
 * Node ids: `cat:<name>` · `tag:<tag>` · `author:<username>` · <item id>.
 * meta = { mode, category, categories: [{name,count}], totals: {items,tags,creators}, items, tags, authors, links,
 *          maxItems, capped, planCap, totalAnalyzed }.
 */
misc.get('/graph', (c) => {
  const t = tid(c);
  const q = (k: string) => c.req.query(k);
  const graphCap = limitsFor(t).graphNodes;
  const raw = (q('mode') || 'overview').toLowerCase();
  const mode: GraphMode = raw === 'all' ? 'all' : raw === 'category' ? 'category' : 'overview';
  const category = (q('category') || '').trim();
  if (mode === 'category' && !category) return c.json({ error: 'mode=category needs ?category= — the names are in meta.categories of mode=overview' }, 400);
  const cats = graphCategoryRows(t);
  const categories = cats.map((r) => ({ name: r.name, count: r.count }));
  const totals = graphTotals(t);

  if (mode === 'overview') {
    const g = overviewGraph(t, cats, gnum(q('top_tags'), 36, 0, 80), gnum(q('top_creators'), 12, 0, 40), graphCap);
    return c.json({ nodes: g.nodes, links: g.links, meta: { mode, category: null, categories, totals, items: 0, tags: g.tags, authors: g.creators, links: g.links.length, maxItems: 0, capped: false, planCap: finite(graphCap), totalAnalyzed: totals.items } });
  }
  const isCat = mode === 'category';
  const g = itemGraph(t, {
    // Category drill-in stays readable: 160 newest saves, tags shared by ≥ 3 of them, 2 tags per save, no hub links
    // (every save here belongs to the category anyway — the hub only made a starburst).
    maxItems: Math.min(6000, graphCap, gnum(q('max_items'), isCat ? 160 : 800, 10, 6000)),
    minTag: gnum(q('min_tag'), isCat ? 3 : 3, 1, 50),
    minAuthor: gnum(q('min_author'), isCat ? 2 : 3, 1, 50),
    tagsPerItem: gnum(q('tags_per_item'), isCat ? 2 : 3, 1, 10),
    similarPerItem: gnum(q('similar_per_item'), 2, 0, 8),
    similarMin: gnum(q('similar_min'), isCat ? 0.75 : 0.7, 0.3, 0.99),
    includeSimilar: q('similar') !== '0',
    includeCategoryHubs: q('category_hubs') === '1' || (!isCat && q('category_hubs') !== '0'),
    category,
  });
  return c.json({ nodes: g.nodes, links: g.links, meta: { mode, category: category || null, categories, totals, items: g.items, tags: g.tags, authors: g.authors, links: g.links.length, maxItems: g.maxItems, capped: g.capped, planCap: finite(graphCap), totalAnalyzed: g.totalAnalyzed } });
});
