import { db, j } from '../db.js';
import type { Analysis, ItemRow } from '../types.js';

/** Normalize a tag: lowercase kebab-case, ascii-ish, singular-ish for common plurals. */
export function normalizeTag(raw: string): string {
  let t = (raw || '').toLowerCase().trim();
  t = t.replace(/^#+/, '');
  t = t.normalize('NFKD').replace(/[̀-ͯ]/g, '');
  t = t.replace(/[_\s]+/g, '-').replace(/[^a-z0-9а-яёіїєґқңғүұөһ\-]+/gi, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
  if (t.length > 40) t = t.slice(0, 40).replace(/-$/, '');
  // gentle plural → singular for english tags
  if (/^[a-z0-9-]+$/.test(t) && t.length > 4) {
    if (/(ies)$/.test(t) && !/(series|species|movies)$/.test(t)) t = t.replace(/ies$/, 'y');
    else if (/[^s]s$/.test(t) && !/(ss|us|is|news|analytics|business|fitness|wellness|physics|graphics|economics|ethics|politics|glasses|lens|jeans|sneakers)$/.test(t)) t = t.replace(/s$/, '');
  }
  return t;
}

/** (Re)index an item in the FTS table. */
export function indexItem(item: ItemRow) {
  const a = j<Analysis | null>(item.analysis, null);
  const d = db();
  d.prepare('DELETE FROM items_fts WHERE item_id = ?').run(item.id);
  const ents = a ? [...a.entities.people, ...a.entities.brands, ...a.entities.tools, ...a.entities.places, ...a.entities.books_media, ...a.entities.products].join(' ') : '';
  const userTags = j<string[]>(item.user_tags, []).join(' ');
  d.prepare('INSERT INTO items_fts (item_id, title, summary, key_points, tags, caption, transcript, author, entities) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
    item.id,
    a ? `${a.title} ${a.one_liner} ${a.subcategory} ${a.category}` : '',
    a ? `${a.summary} ${a.why_saved_guess} ${a.actionable_takeaways.join(' ')} ${a.on_screen_text}` : '',
    a ? a.key_points.join(' ') : '',
    `${a ? a.tags.join(' ') : ''} ${userTags}`.trim(),
    (item.caption || '').slice(0, 5000),
    (item.transcript || '').slice(0, 20000),
    `${item.author_username || ''} ${item.author_name || ''}`.trim(),
    ents,
  );
}

export function reindexAll(): number {
  const d = db();
  const rows = d.prepare('SELECT * FROM items').all() as ItemRow[];
  d.exec('DELETE FROM items_fts');
  const tx = d.transaction(() => { for (const r of rows) indexItem(r); });
  tx();
  return rows.length;
}

/** Build a safe FTS5 MATCH query from free text: each token quoted with prefix search, AND-ed. */
export function ftsQuery(q: string): string | null {
  const tokens = q
    .replace(/["'`^*:()]/g, ' ')
    .split(/\s+/)
    .map((t) => t.trim())
    .filter((t) => t.length >= 2)
    .slice(0, 8);
  if (!tokens.length) return null;
  return tokens.map((t) => `"${t.replace(/"/g, '')}"*`).join(' AND ');
}

/** Keyword search → ranked item ids with bm25 score (lower is better in sqlite; we invert). */
export function keywordSearch(q: string, limit = 50): Array<{ id: string; score: number }> {
  const match = ftsQuery(q);
  if (!match) return [];
  try {
    const rows = db()
      .prepare(`SELECT item_id AS id, bm25(items_fts, 0, 10.0, 4.0, 5.0, 6.0, 1.5, 1.0, 3.0, 4.0) AS rank FROM items_fts WHERE items_fts MATCH ? ORDER BY rank LIMIT ?`)
      .all(match, limit) as Array<{ id: string; rank: number }>;
    return rows.map((r) => ({ id: r.id, score: -r.rank }));
  } catch {
    // fallback: LIKE over caption/title
    const like = `%${q.toLowerCase()}%`;
    const rows = db().prepare(`SELECT id FROM items WHERE lower(coalesce(caption,'')) LIKE ? OR lower(coalesce(analysis,'')) LIKE ? LIMIT ?`).all(like, like, limit) as Array<{ id: string }>;
    return rows.map((r, i) => ({ id: r.id, score: limit - i }));
  }
}
