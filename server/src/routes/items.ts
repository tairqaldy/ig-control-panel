import { Hono } from 'hono';
import { db, j, now } from '../db.js';
import type { Analysis, ItemRow } from '../types.js';
import { keywordSearch, indexItem, normalizeTag } from '../services/search.js';
import { neighborsOf, semanticSearch, dropEmbedding } from '../services/neighbors.js';
import { worker } from '../services/worker.js';
import { resetItemForReprocess } from '../services/pipeline.js';
import { removeItemMedia } from '../services/media.js';
import { hasOpenAI } from '../services/openai.js';

export const items = new Hono();

export function lightItem(r: ItemRow) {
  const a = j<Analysis | null>(r.analysis, null);
  return {
    id: r.id,
    url: r.url,
    shortcode: r.shortcode,
    media_type: r.media_type,
    product_type: r.product_type,
    author: r.author_username,
    author_name: r.author_name,
    caption: r.caption ? r.caption.slice(0, 280) : null,
    thumb: r.thumb_path ? `/media/${r.thumb_path}` : null,
    frames: j<string[]>(r.frames, []).map((f) => `/media/${f}`),
    taken_at: r.taken_at,
    saved_at: r.saved_at,
    saved_rank: r.saved_rank,
    like_count: r.like_count,
    play_count: r.play_count,
    comment_count: r.comment_count,
    duration: r.duration,
    music: r.music_title ? `${r.music_title}${r.music_artist ? ` — ${r.music_artist}` : ''}` : null,
    location: r.location,
    collections: j<string[]>(r.collections, []),
    favorite: !!r.favorite,
    archived: !!r.archived,
    user_tags: j<string[]>(r.user_tags, []),
    has_notes: !!r.user_notes,
    media_status: r.media_status,
    analysis_status: r.analysis_status,
    analysis_error: r.analysis_error,
    queue_state: r.queue_state,
    has_transcript: !!r.transcript,
    analysis: a
      ? {
          title: a.title, one_liner: a.one_liner, category: a.category, subcategory: a.subcategory, tags: a.tags, content_type: a.content_type,
          action_type: a.action_type, usefulness_score: a.usefulness_score, is_evergreen: a.is_evergreen, vibe: a.vibe, language: a.language, key_points_count: a.key_points.length,
        }
      : null,
  };
}

export function fullItem(r: ItemRow) {
  const a = j<Analysis | null>(r.analysis, null);
  return {
    ...lightItem(r),
    caption: r.caption,
    alt_text: r.alt_text,
    transcript: r.transcript,
    transcript_lang: r.transcript_lang,
    user_notes: r.user_notes,
    media_error: r.media_error,
    analysis_model: r.analysis_model,
    analyzed_at: r.analyzed_at,
    source: r.source,
    created_at: r.created_at,
    updated_at: r.updated_at,
    last_resurfaced_at: r.last_resurfaced_at,
    resurface_count: r.resurface_count,
    video: r.video_path ? `/media/${r.video_path}` : null,
    analysis: a,
  };
}

const SORTS: Record<string, string> = {
  saved: 'CASE WHEN saved_rank IS NULL THEN 1 ELSE 0 END, saved_rank ASC, saved_at DESC, created_at DESC',
  saved_asc: 'CASE WHEN saved_rank IS NULL THEN 1 ELSE 0 END, saved_rank DESC, saved_at ASC, created_at ASC',
  posted: 'taken_at DESC',
  likes: 'like_count DESC',
  plays: 'play_count DESC',
  useful: "json_extract(analysis, '$.usefulness_score') DESC, saved_rank ASC",
  updated: 'updated_at DESC',
  random: 'RANDOM()',
};

items.get('/', async (c) => {
  const q = c.req.query('q')?.trim() || '';
  const category = c.req.query('category') || '';
  const tag = c.req.query('tag') || '';
  const author = c.req.query('author') || '';
  const type = c.req.query('type') || '';
  const status = c.req.query('status') || '';
  const collection = c.req.query('collection') || '';
  const contentType = c.req.query('content_type') || '';
  const action = c.req.query('action') || '';
  const favorite = c.req.query('favorite') === '1';
  const evergreen = c.req.query('evergreen') === '1';
  const minUseful = Number(c.req.query('min_useful') || 0);
  const archived = c.req.query('archived') === '1';
  const sort = SORTS[c.req.query('sort') || 'saved'] ? c.req.query('sort') || 'saved' : 'saved';
  const semantic = c.req.query('semantic') === '1';
  const page = Math.max(1, Number(c.req.query('page') || 1));
  const limit = Math.min(200, Math.max(1, Number(c.req.query('limit') || 60)));

  const where: string[] = ['i.archived = ?'];
  const params: unknown[] = [archived ? 1 : 0];
  if (category) { where.push("json_extract(i.analysis, '$.category') = ?"); params.push(category); }
  if (tag) { where.push('EXISTS (SELECT 1 FROM item_tags t WHERE t.item_id = i.id AND t.tag = ?)'); params.push(tag); }
  if (author) { where.push('i.author_username = ?'); params.push(author); }
  if (type) { where.push('i.media_type = ?'); params.push(type); }
  if (status) { where.push('i.analysis_status = ?'); params.push(status); }
  if (collection) { where.push("EXISTS (SELECT 1 FROM json_each(i.collections) je WHERE je.value = ?)"); params.push(collection); }
  if (contentType) { where.push("json_extract(i.analysis, '$.content_type') = ?"); params.push(contentType); }
  if (action) { where.push("json_extract(i.analysis, '$.action_type') = ?"); params.push(action); }
  if (favorite) where.push('i.favorite = 1');
  if (evergreen) where.push("json_extract(i.analysis, '$.is_evergreen') = 1");
  if (minUseful > 0) { where.push("CAST(json_extract(i.analysis, '$.usefulness_score') AS INTEGER) >= ?"); params.push(minUseful); }

  let orderBy = SORTS[sort];
  let idFilter: string[] | null = null;
  let scoreMap: Map<string, number> | null = null;
  if (q) {
    const kw = keywordSearch(q, 400);
    let ids = kw.map((r) => r.id);
    scoreMap = new Map(kw.map((r) => [r.id, r.score]));
    if (semantic && hasOpenAI()) {
      try {
        const sem = await semanticSearch(q, 80);
        for (const s of sem) if (s.score > 0.25 && !scoreMap.has(s.id)) { ids.push(s.id); scoreMap.set(s.id, s.score * 20); }
      } catch {}
    }
    // Also match tag prefix and author quickly
    const like = `%${q.toLowerCase()}%`;
    const extra = db().prepare('SELECT id FROM items WHERE lower(author_username) LIKE ? OR lower(author_name) LIKE ? LIMIT 100').all(like, like) as Array<{ id: string }>;
    for (const e of extra) if (!scoreMap.has(e.id)) { ids.push(e.id); scoreMap.set(e.id, 1); }
    idFilter = ids;
    if (!ids.length) return c.json({ items: [], total: 0, page, limit });
    where.push(`i.id IN (${ids.map(() => '?').join(',')})`);
    params.push(...ids);
    orderBy = `CASE i.id ${ids.map((_, k) => `WHEN ? THEN ${k}`).join(' ')} ELSE 99999 END`;
    params.push(...ids);
  }

  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const total = (db().prepare(`SELECT COUNT(*) AS n FROM items i ${whereSql}`).get(...params.slice(0, params.length - (idFilter ? idFilter.length : 0))) as any).n;
  const rows = db().prepare(`SELECT i.* FROM items i ${whereSql} ORDER BY ${orderBy} LIMIT ? OFFSET ?`).all(...params, limit, (page - 1) * limit) as ItemRow[];
  return c.json({ items: rows.map(lightItem), total, page, limit, hasMore: page * limit < total });
});

items.get('/:id', (c) => {
  const r = db().prepare('SELECT * FROM items WHERE id = ?').get(c.req.param('id')) as ItemRow | undefined;
  if (!r) return c.json({ error: 'not found' }, 404);
  const nb = neighborsOf(r.id, 8);
  const related = nb.length
    ? (db().prepare(`SELECT * FROM items WHERE id IN (${nb.map(() => '?').join(',')}) AND archived = 0`).all(...nb.map((n) => n.id)) as ItemRow[])
        .map(lightItem)
        .map((li) => ({ ...li, score: nb.find((n) => n.id === li.id)?.score || 0 }))
        .sort((a, b) => b.score - a.score)
    : [];
  return c.json({ item: fullItem(r), related });
});

items.patch('/:id', async (c) => {
  const id = c.req.param('id');
  const body = await c.req.json<{ favorite?: boolean; archived?: boolean; user_notes?: string | null; user_tags?: string[]; title?: string; category?: string }>();
  const r = db().prepare('SELECT * FROM items WHERE id = ?').get(id) as ItemRow | undefined;
  if (!r) return c.json({ error: 'not found' }, 404);
  const patch: Record<string, unknown> = {};
  if (typeof body.favorite === 'boolean') patch.favorite = body.favorite ? 1 : 0;
  if (typeof body.archived === 'boolean') patch.archived = body.archived ? 1 : 0;
  if (body.user_notes !== undefined) patch.user_notes = body.user_notes || null;
  if (Array.isArray(body.user_tags)) patch.user_tags = JSON.stringify(Array.from(new Set(body.user_tags.map(normalizeTag).filter(Boolean))));
  if ((body.title !== undefined || body.category !== undefined) && r.analysis) {
    const a = j<Analysis>(r.analysis, {} as Analysis);
    if (body.title !== undefined) a.title = body.title.trim().slice(0, 120) || a.title;
    if (body.category !== undefined) a.category = body.category;
    patch.analysis = JSON.stringify(a);
  }
  if (Object.keys(patch).length) {
    const sets = Object.keys(patch).map((k) => `${k} = @${k}`).join(', ');
    db().prepare(`UPDATE items SET ${sets}, updated_at = @__now WHERE id = @__id`).run({ ...patch, __now: now(), __id: id });
    // user tags → item_tags (kind user)
    if (patch.user_tags !== undefined) {
      const d = db();
      d.prepare("DELETE FROM item_tags WHERE item_id = ? AND kind = 'user'").run(id);
      const ins = d.prepare("INSERT OR IGNORE INTO item_tags (item_id, tag, kind) VALUES (?, ?, 'user')");
      for (const t of JSON.parse(patch.user_tags as string)) ins.run(id, t);
    }
    if (typeof body.archived === 'boolean' && body.archived) dropEmbedding(id);
    indexItem(db().prepare('SELECT * FROM items WHERE id = ?').get(id) as ItemRow);
  }
  return c.json({ item: fullItem(db().prepare('SELECT * FROM items WHERE id = ?').get(id) as ItemRow) });
});

items.post('/:id/reanalyze', async (c) => {
  const id = c.req.param('id');
  const body = await c.req.json<{ media?: boolean }>().catch(() => ({ media: false }));
  const r = db().prepare('SELECT id FROM items WHERE id = ?').get(id);
  if (!r) return c.json({ error: 'not found' }, 404);
  resetItemForReprocess(id, { media: !!body.media });
  worker.enqueue([id], { force: true });
  return c.json({ ok: true });
});

items.delete('/:id', async (c) => {
  const id = c.req.param('id');
  db().prepare('DELETE FROM items WHERE id = ?').run(id);
  db().prepare('DELETE FROM items_fts WHERE item_id = ?').run(id);
  dropEmbedding(id);
  await removeItemMedia(id);
  return c.json({ ok: true });
});

/** Bulk operations */
items.post('/bulk', async (c) => {
  const body = await c.req.json<{ ids: string[]; action: 'favorite' | 'unfavorite' | 'archive' | 'unarchive' | 'reanalyze' | 'delete' | 'add_tag'; tag?: string }>();
  const ids = (body.ids || []).slice(0, 5000);
  if (!ids.length) return c.json({ ok: true, n: 0 });
  const d = db();
  let n = 0;
  if (body.action === 'reanalyze') {
    for (const id of ids) resetItemForReprocess(id);
    n = worker.enqueue(ids, { force: true });
  } else if (body.action === 'delete') {
    const del = d.prepare('DELETE FROM items WHERE id = ?');
    d.transaction(() => { for (const id of ids) { n += del.run(id).changes; d.prepare('DELETE FROM items_fts WHERE item_id = ?').run(id); dropEmbedding(id); } })();
    for (const id of ids) await removeItemMedia(id);
  } else if (body.action === 'add_tag' && body.tag) {
    const tag = normalizeTag(body.tag);
    const ins = d.prepare("INSERT OR IGNORE INTO item_tags (item_id, tag, kind) VALUES (?, ?, 'user')");
    d.transaction(() => {
      for (const id of ids) {
        const r = d.prepare('SELECT user_tags FROM items WHERE id = ?').get(id) as any;
        if (!r) continue;
        const tags = Array.from(new Set([...j<string[]>(r.user_tags, []), tag]));
        d.prepare('UPDATE items SET user_tags = ?, updated_at = ? WHERE id = ?').run(JSON.stringify(tags), now(), id);
        ins.run(id, tag); n++;
      }
    })();
  } else {
    const col = body.action.includes('favorite') ? 'favorite' : 'archived';
    const val = body.action.startsWith('un') ? 0 : 1;
    const upd = d.prepare(`UPDATE items SET ${col} = ?, updated_at = ? WHERE id = ?`);
    d.transaction(() => { for (const id of ids) n += upd.run(val, now(), id).changes; })();
    if (col === 'archived') for (const id of ids) if (val) dropEmbedding(id);
  }
  return c.json({ ok: true, n });
});
