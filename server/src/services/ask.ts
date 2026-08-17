/**
 * Ask — retrieval + answer generation over the user's saves, plus (round 5) intent routing, strategies,
 * conversations/messages persistence, title summarization and suggested prompts.
 *
 * Round 6 (§4): the voice is a friend who happens to be a great social-media strategist, and every strategy that can
 * use it gets the own-content profile from services/ig-content.ts — what the person actually posts — so answers can
 * connect the library to the account ("saved vs posted") without inventing a single number.
 *
 * Public surface used by routes/misc.ts (POST /api/ask) and routes/ask.ts (conversations, suggestions):
 *   retrieve(), buildContext(), askStream()            – v1, still exported (askStream accepts an optional plan)
 *   routeIntent(), planAsk(), statsSummary()           – v2 intent routing + the six strategies
 *   summarizeTitle(), suggestions()
 *   createConversation(), listConversations(), getConversation(), updateConversation(), deleteConversation(),
 *   addMessage(), listMessages(), touchConversation()
 */
import { config } from '../config.js';
import { db, getSetting, j, now, OWNER_TENANT } from '../db.js';
import type { Analysis, ItemRow } from '../types.js';
import { keywordSearch } from './search.js';
import { semanticSearch } from './neighbors.js';
import { generateStructured, models, streamText } from './openai.js';
import { crossReferenceText, isAccountQuestion, isCrossRefQuestion, ownContentProfile, recentPostsText, type OwnContentProfile } from './ig-content.js';
import { igAvailabilityCached, igCapabilityNote } from './ig-availability.js';
import { CATEGORIES } from '../prompts/analysis.js';

export interface AskSource {
  id: string;
  title: string;
  one_liner: string;
  author: string | null;
  url: string;
  thumb: string | null;
  category: string | null;
  tags: string[];
  score: number;
}

export type AskIntent = 'library' | 'stats' | 'inspire' | 'create' | 'analytics' | 'chat';
export const ASK_INTENTS: AskIntent[] = ['library', 'stats', 'inspire', 'create', 'analytics', 'chat'];

export interface AskFilters {
  category?: string | null;
  tag?: string | null;
  creator?: string | null;
  /** media type: video | image | carousel */
  type?: string | null;
  /** ISO date 'YYYY-MM-DD' or a relative hint like '30d', '6m', '1y' */
  since?: string | null;
}

export interface RoutedIntent {
  intent: AskIntent;
  filters: AskFilters;
  /** where the decision came from (for logs/tests) */
  via: 'model' | 'heuristic' | 'explicit';
}

/** Cheap model for routing / titles. */
const NANO = 'gpt-5.4-nano';

/* ------------------------------------------------------------------ */
/* System prompts                                                      */
/* ------------------------------------------------------------------ */

/**
 * The voice (ROUND6-SPEC §4): a friend who happens to be a great social-media strategist and knows the AI tools
 * people actually use. Every strategy prompt ends with this block.
 */
const VOICE = `Voice — a friend who happens to be a great social-media strategist and knows the AI tools people actually use. Write the way that friend would reply.
- The answer goes in the first one or two lines. Everything after that is support.
- Then at most 3-5 short bullets, and only when bullets genuinely help. A lot of good answers are three sentences.
- No section headers, no bold labels, no numbered outlines, unless the user asked for a document, brief, script or plan.
- Never restate the question. No preamble, no "great question", no narrating what you are about to do.
- Contractions are good. Plain words. No marketing language, no hype, no emoji unless the user used them first.
- Do not list every source you were given; name the two or three that actually matter.
- If the library has nothing on this, say so plainly in one line and offer the nearest useful thing instead of padding.
- Keep it to about 180 words unless the user asked for a brief, script or plan.`;

const CITE = `Citations: every save in the context has an id token like [#abc123]. When a sentence leans on a specific save, end it with that token exactly as written (several are fine: [#a1] [#b2]). Cite the saves you actually used, not all of them. Never invent saves, ids, numbers or quotes that are not in the context.`;

/** Rules for the injected own-content profile (services/ig-content.ts). Added to every strategy that can receive one. */
const OWN = `Their own posts: a section headed "What they post" holds real data pulled from their connected Instagram account. Use those numbers exactly as given, never invent reach, saves, dates or a trend the data does not show, and if a metric is missing say you cannot see it. Refer to one of their posts by what it was about and when ("the carousel about pricing from 12 May"), never by the bare post id — those ids are there for you to keep the posts apart, they must not appear in the answer, and they are not library citations.`;

const ASK_SYSTEM = `You are Resurfly, the person's own library of everything they ever saved on Instagram. Answer only from the saves in the context.

Rules:
- Lead with the answer, then the two or three saves that carry it. Group what belongs together, pull out the concrete steps, and say which one to start with.
- ${CITE}
- If the context does not hold the answer, say so in one line and name the tag or search that probably would.
- ${VOICE}
- End with a line "Try next:" followed by 2 short follow-up questions about their library, one per line. That trailer is the only exception to the no-headers rule.`;

const STATS_SYSTEM = `You are Resurfly. The user is asking about their own saving habits, taste or patterns. You get a factual summary of the whole library (counts by category, creator, format, month; spend; evergreen share; top tags), a few example saves, and — when their Instagram is connected — what they actually post plus a measured saved-vs-posted comparison.

Rules:
- Open with the observation that matters most, with the real number in it ("a third of what you save is cooking, almost all reels, mostly two creators"). Then at most three more, including one thing that is easy to miss.
- Only use numbers that appear in the data you were given. Never compute a trend the data does not show. If the library is thin, say so.
- When the saved-vs-posted block is there, use it: connect what they keep saving to what they actually publish and name the gap.
- Use the example saves to illustrate — ${CITE}
- ${OWN}
- ${VOICE}
- End with a line "Try next:" followed by 2 short follow-up questions, one per line. That trailer is the only exception to the no-headers rule.`;

const INSPIRE_SYSTEM = `You are Resurfly. They want ideas, prompts or a nudge — things worth doing, trying or revisiting this week, grounded in what they actually saved. The context lists evergreen, high-usefulness saves matching the request; each has a "Nudge" line.

Rules:
- One short line to frame the pick, then 3-5 ideas. Each idea is one line: what to do (specific, doable this week), the reason as a clause rather than a sentence, and the citation of the save it came from. ${CITE}
- Vary them; do not give five versions of one save. Most doable first.
- When their own posts are in the context, prefer ideas that fit a format that already works for them.
- ${OWN}
- If nothing relevant is there, say so and name two tags or categories to look at instead.
- ${VOICE}`;

const CREATE_SYSTEM = `You are Resurfly, a content strategist who has read every save in this person's library and can see how their own recent posts did. They want to make something (a reel, carousel, post, story, script, caption). Give them a brief they can shoot today, built from their best-matching saves — hooks, formats, remix ideas, key points.

Open with one line saying what this is and why it will land for them. Then these plain-text headings, "-" bullets only, no other markdown:
Hooks — 3 options, one line each, in the styles that recur in their saves.
Outline — 4-7 beats or slides, one line each, concrete.
CTA — one line.
Format — length, structure, on-screen text, filming notes; borrow from the saves' format notes and, when you can see their account, from the format that actually performs for them.
Why this fits — 2-3 lines tying it to what they keep saving and, when their posts are in the context, to what already worked.

Rules:
- ${CITE} Cite the save each hook, beat and format note came from.
- Be specific to their niche as it shows in the saves. Never generic "post consistently" advice.
- If the saves do not support a brief on this topic, say what is missing in one line and propose the closest topic they do have.
- ${OWN}
- ${VOICE}
- A brief is a document: the headings above are wanted here, and it may run past 180 words.`;

const ANALYTICS_SYSTEM = `You are Resurfly. The question is about their own Instagram account. You get the last 30 days of account analytics (followers, reach, interactions, profile views, saves, best hours/days, content mix, top posts, hashtags), the posts they published recently, and sometimes a few saves that could inspire the next one.

Rules:
- Lead with the number that answers the question and what it means. Round sensibly.
- At most 3 actions, each doable this week. When a saved post inspired an idea, cite it. ${CITE}
- Only numbers from the payload. If a metric is not there, say so in a clause and move on. Hedge small samples instead of dressing them up.
- ${OWN}
- ${VOICE}`;

const CHAT_SYSTEM = `You are Resurfly, the assistant inside this person's library of Instagram saves. Answer the question directly and briefly. A short library summary is provided — use it only when it genuinely helps; relevant saves, when listed, can be cited. ${CITE}
${OWN}
${VOICE}
If the question is really about their saves, their habits, their Instagram numbers or making content, answer as far as you can and mention in one clause that asking directly ("what did I save about …", "what do I save most", "my analytics", "content brief for …") gets a fuller answer.`;

/* ------------------------------------------------------------------ */
/* Retrieval                                                           */
/* ------------------------------------------------------------------ */

function rrf(lists: Array<Array<{ id: string; score: number }>>, k = 60): Map<string, number> {
  const out = new Map<string, number>();
  for (const list of lists) list.forEach((r, i) => out.set(r.id, (out.get(r.id) || 0) + 1 / (k + i + 1)));
  return out;
}

function sinceEpoch(since: string | null | undefined): number | null {
  if (!since) return null;
  const s = since.trim().toLowerCase();
  const rel = s.match(/^(\d+)\s*(d|day|days|w|week|weeks|m|month|months|y|year|years)$/);
  if (rel) {
    const n = Number(rel[1]);
    const unit = rel[2][0];
    const secs = unit === 'd' ? 86400 : unit === 'w' ? 7 * 86400 : unit === 'm' ? 30 * 86400 : 365 * 86400;
    return now() - n * secs;
  }
  const t = Date.parse(s);
  return Number.isFinite(t) ? Math.floor(t / 1000) : null;
}

function filterSql(f: AskFilters | undefined, alias = 'items'): { sql: string; params: unknown[] } {
  const where: string[] = [];
  const params: unknown[] = [];
  if (!f) return { sql: '', params };
  if (f.category) { where.push(`json_extract(${alias}.analysis, '$.category') = ?`); params.push(f.category); }
  if (f.tag) { where.push(`EXISTS (SELECT 1 FROM item_tags t WHERE t.item_id = ${alias}.id AND t.tag = ?)`); params.push(String(f.tag).toLowerCase().replace(/^#/, '')); }
  if (f.creator) { where.push(`lower(${alias}.author_username) = ?`); params.push(String(f.creator).toLowerCase().replace(/^@/, '')); }
  if (f.type && ['video', 'image', 'carousel'].includes(String(f.type))) { where.push(`${alias}.media_type = ?`); params.push(f.type); }
  const since = sinceEpoch(f.since);
  if (since) { where.push(`COALESCE(${alias}.saved_at, ${alias}.saved_at_est, ${alias}.taken_at) >= ?`); params.push(since); }
  return { sql: where.length ? ` AND ${where.join(' AND ')}` : '', params };
}

function toSource(r: ItemRow, score: number): AskSource {
  const a = j<Analysis | null>(r.analysis, null);
  return {
    id: r.id,
    title: a?.title || (r.caption ? r.caption.split('\n')[0].slice(0, 80) : `Save by @${r.author_username || 'unknown'}`),
    one_liner: a?.one_liner || '',
    author: r.author_username,
    url: r.url,
    thumb: r.thumb_path ? `/media/${r.thumb_path}` : null,
    category: a?.category || null,
    tags: a?.tags || [],
    score,
  };
}

const STOPWORDS = new Set('a an the and or but if then so of to in on at for from by with about into over under as is are was were be been being am do does did done have has had having i me my mine we our us you your yours he she it its they them their this that these those what which who whom whose when where why how all any some more most other such no not only own same than too very can could should would will shall may might must just also ever never again there here once please show find give tell get got want need like saved save saves did about something anything everything things stuff reels reel post posts video videos'.split(' '));

/**
 * Loose keyword search for natural-language questions: the strict FTS query AND-s every token ("what did I save about X"
 * needs every word to appear), which finds nothing when embeddings are missing. This OR-s the content words instead.
 */
function keywordSearchLoose(tid: number, q: string, limit: number): Array<{ id: string; score: number }> {
  const tokens = Array.from(new Set(q.toLowerCase().replace(/[^\p{L}\p{N}#@\s-]/gu, ' ').split(/\s+/).map((t) => t.replace(/^[#@]/, '')).filter((t) => t.length >= 3 && !STOPWORDS.has(t)))).slice(0, 8);
  if (!tokens.length) return [];
  const match = tokens.map((t) => `"${t.replace(/"/g, '')}"*`).join(' OR ');
  try {
    const rows = db().prepare(`SELECT item_id AS id, bm25(items_fts, 0, 0, 10.0, 4.0, 5.0, 6.0, 1.5, 1.0, 3.0, 4.0) AS rank FROM items_fts WHERE items_fts MATCH ? AND tenant_id = ? ORDER BY rank LIMIT ?`).all(match, tid, limit) as Array<{ id: string; rank: number }>;
    return rows.map((r) => ({ id: r.id, score: -r.rank }));
  } catch { return []; }
}

/** Hybrid retrieval (semantic + keyword, RRF-fused). Optional filters narrow the candidate set. */
export async function retrieve(tid: number, question: string, limit = 12, filters?: AskFilters): Promise<AskSource[]> {
  const hasFilters = !!(filters && (filters.category || filters.tag || filters.creator || filters.type || filters.since));
  const pool = hasFilters ? limit * 5 : limit;
  const [sem, kwStrict] = await Promise.all([
    semanticSearch(tid, question, Math.max(40, pool * 2)).catch(() => [] as Array<{ id: string; score: number }>),
    Promise.resolve(keywordSearch(tid, question, Math.max(25, pool))),
  ]);
  const kw = kwStrict.length ? kwStrict : keywordSearchLoose(tid, question, Math.max(25, pool));
  const fused = rrf([sem, kw]);
  const ids = Array.from(fused.entries()).sort((a, b) => b[1] - a[1]).slice(0, Math.max(pool, limit)).map(([id]) => id);
  const fs = filterSql(filters);
  let rows: ItemRow[] = [];
  if (ids.length) {
    rows = db().prepare(`SELECT * FROM items WHERE tenant_id = ? AND id IN (${ids.map(() => '?').join(',')}) AND archived = 0 AND excluded = 0${fs.sql}`).all(tid, ...ids, ...fs.params) as ItemRow[];
  }
  // Filters given but retrieval found nothing (or too little): fall back to the newest analyzed saves matching the filters.
  if (hasFilters && rows.length < Math.min(4, limit)) {
    const have = new Set(rows.map((r) => r.id));
    const extra = db().prepare(`SELECT * FROM items WHERE tenant_id = ? AND archived = 0 AND excluded = 0 AND analysis_status = 'done'${fs.sql} ORDER BY COALESCE(saved_at, saved_at_est, taken_at) DESC LIMIT ?`).all(tid, ...fs.params, limit) as ItemRow[];
    for (const r of extra) if (!have.has(r.id)) { rows.push(r); have.add(r.id); }
  }
  // A wrong filter must never turn a question with real hits into "nothing found": when the filtered set is EMPTY,
  // fall back to the unfiltered hits (a small but non-empty filtered set is kept as-is — the user asked for it).
  if (hasFilters && rows.length === 0 && ids.length) {
    rows = db().prepare(`SELECT * FROM items WHERE tenant_id = ? AND id IN (${ids.map(() => '?').join(',')}) AND archived = 0 AND excluded = 0`).all(tid, ...ids) as ItemRow[];
  }
  const byId = new Map(rows.map((r) => [r.id, r]));
  const ordered = ids.filter((id) => byId.has(id));
  for (const r of rows) if (!ordered.includes(r.id)) ordered.push(r.id);
  return ordered.slice(0, limit).map((id) => toSource(byId.get(id)!, fused.get(id) || 0));
}

/** Evergreen, high-usefulness saves matching the question (for `inspire`). */
async function retrieveInspire(tid: number, question: string, limit: number, filters?: AskFilters): Promise<AskSource[]> {
  const cands = await retrieve(tid, question, limit * 3, filters);
  const d = db();
  const scored = cands.map((s) => {
    const r = d.prepare('SELECT analysis FROM items WHERE id = ? AND tenant_id = ?').get(s.id, tid) as { analysis: string | null } | undefined;
    const a = j<Analysis | null>(r?.analysis, null);
    const useful = a?.usefulness_score ?? 0;
    const boost = (a?.is_evergreen ? 1 : 0) + useful / 10 + (a?.resurface_prompt ? 0.3 : 0);
    return { s, rank: s.score * 100 + boost, useful };
  });
  let picked = scored.filter((x) => x.useful >= 6).sort((a, b) => b.rank - a.rank).slice(0, limit).map((x) => x.s);
  if (picked.length < 3) picked = scored.sort((a, b) => b.rank - a.rank).slice(0, limit).map((x) => x.s);
  // Thin question-match ("ideas for this weekend"): top up with the tenant's best evergreen saves overall.
  if (picked.length < Math.min(4, limit)) {
    const fs = filterSql(filters);
    const have = new Set(picked.map((s) => s.id));
    const rows = d.prepare(`SELECT * FROM items WHERE tenant_id = ? AND archived = 0 AND excluded = 0 AND analysis_status = 'done' AND (json_extract(analysis, '$.is_evergreen') = 1 OR CAST(json_extract(analysis, '$.usefulness_score') AS INTEGER) >= 8)${fs.sql} ORDER BY CAST(json_extract(analysis, '$.usefulness_score') AS INTEGER) DESC, RANDOM() LIMIT ?`).all(tid, ...fs.params, limit) as ItemRow[];
    for (const r of rows) if (!have.has(r.id) && picked.length < limit) { picked.push(toSource(r, 0)); have.add(r.id); }
  }
  return picked;
}

/* ------------------------------------------------------------------ */
/* Context builders                                                    */
/* ------------------------------------------------------------------ */

type ContextMode = 'library' | 'inspire' | 'create';

export function buildContext(tid: number, sources: AskSource[], mode: ContextMode = 'library'): string {
  const d = db();
  const parts: string[] = [];
  for (const s of sources) {
    const r = d.prepare('SELECT * FROM items WHERE id = ? AND tenant_id = ?').get(s.id, tid) as ItemRow | undefined;
    if (!r) continue;
    const a = j<Analysis | null>(r.analysis, null);
    const lines = [`[#${s.id}] ${s.title}${r.author_username ? ` — @${r.author_username}` : ''} (${r.media_type}${a ? `, ${a.category}` : ''})`];
    if (a) {
      if (a.one_liner) lines.push(`  One-liner: ${a.one_liner}`);
      if (mode !== 'inspire' && a.summary) lines.push(`  Summary: ${a.summary}`);
      if (a.key_points.length) lines.push(`  Key points: ${a.key_points.map((k) => `• ${k}`).join(' ')}`);
      if (a.actionable_takeaways.length) lines.push(`  Actions: ${a.actionable_takeaways.join(' | ')}`);
      if (a.tags.length) lines.push(`  Tags: ${a.tags.join(', ')}`);
      if (mode === 'library') {
        const ents = [...a.entities.tools, ...a.entities.brands, ...a.entities.people, ...a.entities.places].slice(0, 12);
        if (ents.length) lines.push(`  Entities: ${ents.join(', ')}`);
        if (a.quotes.length) lines.push(`  Quotes: ${a.quotes.map((q) => `"${q}"`).join(' ')}`);
      }
      if (mode === 'inspire') {
        if (a.resurface_prompt) lines.push(`  Nudge: ${a.resurface_prompt}`);
        if (a.remix_idea) lines.push(`  Remix idea: ${a.remix_idea}`);
        lines.push(`  Usefulness: ${a.usefulness_score}/10${a.is_evergreen ? ', evergreen' : ''}`);
      }
      if (mode === 'create') {
        if (a.hook?.text) lines.push(`  Hook: "${a.hook.text}"${a.hook.style ? ` (${a.hook.style})` : ''}`);
        if (a.format_notes) lines.push(`  Format: ${a.format_notes}`);
        if (a.remix_idea) lines.push(`  Remix idea: ${a.remix_idea}`);
        if (a.content_type) lines.push(`  Content type: ${a.content_type}${a.vibe ? `, vibe: ${a.vibe}` : ''}`);
        if (a.on_screen_text) lines.push(`  On-screen text: ${a.on_screen_text.slice(0, 200)}`);
        if (r.like_count || r.play_count) lines.push(`  Performance: ${r.play_count ? `${r.play_count} plays` : ''}${r.play_count && r.like_count ? ', ' : ''}${r.like_count ? `${r.like_count} likes` : ''}`);
      }
    } else if (r.caption) lines.push(`  Caption: ${r.caption.slice(0, 500)}`);
    if (mode === 'library' && r.transcript && (!a || a.key_points.length < 2)) lines.push(`  Transcript excerpt: ${r.transcript.slice(0, 600)}`);
    lines.push(`  URL: ${r.url}`);
    parts.push(lines.join('\n'));
  }
  return parts.join('\n\n');
}

function analyzedCount(tid: number): number {
  return (db().prepare("SELECT COUNT(*) AS n FROM items WHERE tenant_id = ? AND analysis_status = 'done' AND archived = 0 AND excluded = 0").get(tid) as any).n as number;
}

/* ------------------------------------------------------------------ */
/* Stats summary                                                       */
/* ------------------------------------------------------------------ */

export interface StatsSummary {
  totals: { total: number; analyzed: number; evergreen: number; favorites: number; creators: number; spendUsd: number; firstSaveMonth: string | null; lastSaveMonth: string | null };
  categories: Array<{ name: string; n: number }>;
  creators: Array<{ name: string; n: number }>;
  formats: Array<{ name: string; n: number }>;
  contentTypes: Array<{ name: string; n: number }>;
  months: Array<{ month: string; n: number }>;
  tags: Array<{ name: string; n: number }>;
  usefulnessAvg: number | null;
  languages: Array<{ name: string; n: number }>;
  text: string;
}

const pct = (n: number, of: number) => (of ? Math.round((n / of) * 100) : 0);

/** Counts by category / creator / format / month, spend, evergreen, top tags — as data and as a compact text block for prompts. */
export function statsSummary(tid: number): StatsSummary {
  const d = db();
  const base = 'tenant_id = ? AND archived = 0 AND excluded = 0';
  const totals = d.prepare(`SELECT COUNT(*) AS total,
      SUM(CASE WHEN analysis_status = 'done' THEN 1 ELSE 0 END) AS analyzed,
      SUM(CASE WHEN json_extract(analysis, '$.is_evergreen') = 1 THEN 1 ELSE 0 END) AS evergreen,
      SUM(CASE WHEN favorite = 1 THEN 1 ELSE 0 END) AS favorites,
      COUNT(DISTINCT author_username) AS creators,
      COALESCE(SUM(cost_usd), 0) AS spend,
      MIN(COALESCE(saved_at, saved_at_est, taken_at)) AS first_ts,
      MAX(COALESCE(saved_at, saved_at_est, taken_at)) AS last_ts,
      AVG(CASE WHEN analysis_status = 'done' THEN CAST(json_extract(analysis, '$.usefulness_score') AS REAL) END) AS useful
    FROM items WHERE ${base}`).get(tid) as any;
  const categories = d.prepare(`SELECT json_extract(analysis, '$.category') AS name, COUNT(*) AS n FROM items WHERE ${base} AND analysis_status = 'done' GROUP BY name ORDER BY n DESC LIMIT 12`).all(tid) as Array<{ name: string; n: number }>;
  const creators = d.prepare(`SELECT author_username AS name, COUNT(*) AS n FROM items WHERE ${base} AND author_username IS NOT NULL GROUP BY author_username ORDER BY n DESC LIMIT 10`).all(tid) as Array<{ name: string; n: number }>;
  const formats = d.prepare(`SELECT media_type AS name, COUNT(*) AS n FROM items WHERE ${base} GROUP BY media_type ORDER BY n DESC`).all(tid) as Array<{ name: string; n: number }>;
  const contentTypes = d.prepare(`SELECT json_extract(analysis, '$.content_type') AS name, COUNT(*) AS n FROM items WHERE ${base} AND analysis_status = 'done' GROUP BY name ORDER BY n DESC LIMIT 8`).all(tid) as Array<{ name: string; n: number }>;
  const months = d.prepare(`SELECT strftime('%Y-%m', datetime(COALESCE(saved_at, saved_at_est, taken_at), 'unixepoch')) AS month, COUNT(*) AS n FROM items WHERE ${base} AND COALESCE(saved_at, saved_at_est, taken_at) IS NOT NULL GROUP BY month ORDER BY month DESC LIMIT 18`).all(tid) as Array<{ month: string; n: number }>;
  const tags = d.prepare(`SELECT t.tag AS name, COUNT(*) AS n FROM item_tags t JOIN items i ON i.id = t.item_id WHERE i.tenant_id = ? AND i.archived = 0 AND i.excluded = 0 GROUP BY t.tag ORDER BY n DESC LIMIT 25`).all(tid) as Array<{ name: string; n: number }>;
  const languages = d.prepare(`SELECT json_extract(analysis, '$.language') AS name, COUNT(*) AS n FROM items WHERE ${base} AND analysis_status = 'done' AND json_extract(analysis, '$.language') IS NOT NULL GROUP BY name ORDER BY n DESC LIMIT 5`).all(tid) as Array<{ name: string; n: number }>;
  const monthOf = (ts: number | null) => (ts ? new Date(ts * 1000).toISOString().slice(0, 7) : null);
  const total = totals.total || 0, analyzed = totals.analyzed || 0;
  const lines: string[] = [];
  lines.push(`Saves: ${total} total, ${analyzed} analyzed${totals.evergreen ? `, ${totals.evergreen} evergreen (${pct(totals.evergreen, analyzed)}% of analyzed)` : ''}${totals.favorites ? `, ${totals.favorites} favorites` : ''}. ${totals.creators || 0} distinct creators.${monthOf(totals.first_ts) ? ` Saved between ${monthOf(totals.first_ts)} and ${monthOf(totals.last_ts)}.` : ''}`);
  if (categories.length) lines.push(`Categories: ${categories.map((c) => `${c.name || 'uncategorized'} ${c.n} (${pct(c.n, analyzed)}%)`).join(', ')}`);
  if (formats.length) lines.push(`Formats: ${formats.map((f) => `${f.name} ${f.n} (${pct(f.n, total)}%)`).join(', ')}`);
  if (contentTypes.length) lines.push(`Content types: ${contentTypes.map((c) => `${c.name || 'other'} ${c.n}`).join(', ')}`);
  if (creators.length) lines.push(`Top creators: ${creators.map((c) => `@${c.name} ${c.n}`).join(', ')}`);
  if (tags.length) lines.push(`Top tags: ${tags.map((t) => `${t.name} ${t.n}`).join(', ')}`);
  if (months.length) lines.push(`Saves per month (newest first): ${months.map((m) => `${m.month}: ${m.n}`).join(', ')}`);
  if (languages.length > 1) lines.push(`Languages: ${languages.map((l) => `${l.name} ${l.n}`).join(', ')}`);
  if (totals.useful) lines.push(`Average usefulness score: ${Number(totals.useful).toFixed(1)}/10`);
  if (totals.spend) lines.push(`Analysis spend so far: $${Number(totals.spend).toFixed(2)}`);
  return {
    totals: { total, analyzed, evergreen: totals.evergreen || 0, favorites: totals.favorites || 0, creators: totals.creators || 0, spendUsd: Math.round((totals.spend || 0) * 100) / 100, firstSaveMonth: monthOf(totals.first_ts), lastSaveMonth: monthOf(totals.last_ts) },
    categories, creators, formats, contentTypes, months, tags, languages,
    usefulnessAvg: totals.useful ? Math.round(totals.useful * 10) / 10 : null,
    text: lines.join('\n'),
  };
}

/** Example saves for the stats strategy: the most useful save of each of the top categories (so the answer can cite). */
function statsExamples(tid: number, cats: Array<{ name: string; n: number }>, perCat = 2, maxCats = 5): AskSource[] {
  const d = db();
  const out: AskSource[] = [];
  for (const c of cats.slice(0, maxCats)) {
    if (!c.name) continue;
    const rows = d.prepare(`SELECT * FROM items WHERE tenant_id = ? AND archived = 0 AND excluded = 0 AND analysis_status = 'done' AND json_extract(analysis, '$.category') = ? ORDER BY CAST(json_extract(analysis, '$.usefulness_score') AS INTEGER) DESC, COALESCE(saved_at, saved_at_est, taken_at) DESC LIMIT ?`).all(tid, c.name, perCat) as ItemRow[];
    for (const r of rows) out.push(toSource(r, 0));
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Instagram analytics (server-instagram agent's module; optional)     */
/* ------------------------------------------------------------------ */

/** Is an Instagram account connected for this tenant (OAuth row, settings, or owner env)? */
export function igConnected(tid: number): boolean {
  try {
    const r = db().prepare('SELECT 1 FROM ig_accounts WHERE tenant_id = ?').get(tid);
    if (r) return true;
  } catch { /* table not created (instagram migration absent) */ }
  const envOk = tid === OWNER_TENANT && !!(config.igAccessToken && config.igUserId);
  return envOk || !!(getSetting(tid, 'ig_access_token') && getSetting(tid, 'ig_user_id'));
}

/**
 * Loads the 30-day analytics payload through services/ig-analytics.ts when that module exists.
 * The import is dynamic and tolerant: missing module / missing export / thrown error → { connected:false }.
 */
export async function loadAnalytics(tid: number, range = 30): Promise<{ connected: boolean; payload: any | null; available: boolean }> {
  let mod: any = null;
  try { mod = await import('./ig-analytics.js' as string); } catch { mod = null; }
  const fn = mod && (mod.getAnalytics || mod.analyticsPayload || mod.buildAnalytics || mod.analyticsFor || mod.analytics || mod.default);
  if (typeof fn !== 'function') return { connected: igConnected(tid), payload: null, available: false };
  try {
    let p = await fn(tid, range);
    if (p && typeof p === 'object' && !('series' in p) && !('totals' in p)) p = await fn(tid, { range });
    if (!p || typeof p !== 'object') return { connected: igConnected(tid), payload: null, available: true };
    const connected = p.connected === true || (p.connected === undefined && !p.demo);
    if (!connected || p.demo) return { connected: false, payload: null, available: true };
    if (!p.refreshedAt) {
      // connected but never refreshed: kick a background refresh (best-effort) and answer "no numbers yet"
      try { if (typeof mod.refreshInBackground === 'function') mod.refreshInBackground(tid); } catch {}
      return { connected: true, payload: null, available: true };
    }
    return { connected: true, payload: p, available: true };
  } catch {
    return { connected: igConnected(tid), payload: null, available: true };
  }
}

/** Compact analytics text for the prompt (keeps tokens sane). */
function analyticsText(p: any): string {
  const L: string[] = [];
  const acc = p.account || {};
  L.push(`Account: @${acc.username || '?'}${acc.name ? ` (${acc.name})` : ''} — followers ${acc.followers ?? '?'}, following ${acc.follows ?? '?'}, posts ${acc.media ?? '?'}. Refreshed: ${p.refreshedAt ? new Date((p.refreshedAt > 1e12 ? p.refreshedAt : p.refreshedAt * 1000)).toISOString().slice(0, 10) : 'unknown'}.`);
  const s = p.series || {};
  if (Array.isArray(s.days) && s.days.length) {
    const first = s.followers?.[0], last = s.followers?.[s.followers.length - 1];
    const reachSum = Array.isArray(s.reach) ? s.reach.reduce((a: number, b: number) => a + (Number(b) || 0), 0) : null;
    const newF = Array.isArray(s.newFollowers) ? s.newFollowers.reduce((a: number, b: number) => a + (Number(b) || 0), 0) : null;
    L.push(`Window: ${s.days[0]} → ${s.days[s.days.length - 1]} (${s.days.length} days). Followers ${first ?? '?'} → ${last ?? '?'}${typeof first === 'number' && typeof last === 'number' ? ` (${last - first >= 0 ? '+' : ''}${last - first})` : ''}.${newF ? ` New followers ${newF}.` : ''}${reachSum !== null ? ` Total reach ${reachSum}, avg/day ${Math.round(reachSum / s.days.length)}.` : ''}`);
  }
  const t = p.totals || {};
  const tot = Object.entries(t).filter(([, v]) => typeof v === 'number').map(([k, v]) => `${k} ${v}`).join(', ');
  if (tot) L.push(`Totals (window): ${tot}`);
  const dv = p.derived || {};
  if (Array.isArray(dv.bestHours) && dv.bestHours.length) L.push(`Best hours (score): ${dv.bestHours.slice(0, 5).map((h: any) => `${h.hour}:00 (${Math.round((h.score || 0) * 100) / 100})`).join(', ')}`);
  if (Array.isArray(dv.bestDays) && dv.bestDays.length) L.push(`Best days: ${dv.bestDays.slice(0, 4).map((d: any) => `${d.weekday} (${Math.round((d.score || 0) * 100) / 100})`).join(', ')}`);
  if (dv.contentMix) L.push(`Content mix: ${Object.entries(dv.contentMix).map(([k, v]) => `${k} ${v}`).join(', ')}${dv.avgEngagementRate !== undefined ? `; avg engagement rate ${Number(dv.avgEngagementRate).toFixed(2)}%` : ''}${dv.postingCadencePerWeek !== undefined ? `; cadence ${Number(dv.postingCadencePerWeek).toFixed(1)} posts/week` : ''}`);
  const media = Array.isArray(p.media) ? p.media : [];
  if (media.length) {
    const top = [...media].sort((a: any, b: any) => (b.reach || 0) - (a.reach || 0)).slice(0, 8);
    L.push('Top posts by reach:');
    for (const m of top) L.push(`  - ${(m.type || '').toLowerCase()}${m.productType ? `/${m.productType.toLowerCase()}` : ''} ${m.timestamp ? new Date((m.timestamp > 1e12 ? m.timestamp : m.timestamp * 1000)).toISOString().slice(0, 10) : ''}: reach ${m.reach ?? '?'}, likes ${m.likes ?? '?'}, comments ${m.comments ?? '?'}, saves ${m.saved ?? '?'}${m.views ? `, views ${m.views}` : ''}${m.engagementRate !== undefined ? `, ER ${Number(m.engagementRate).toFixed(2)}%` : ''} — "${String(m.caption || '').replace(/\s+/g, ' ').slice(0, 90)}"`);
  }
  if (Array.isArray(dv.hashtags) && dv.hashtags.length) L.push(`Hashtags: ${dv.hashtags.slice(0, 10).map((h: any) => `#${h.tag} (${h.uses}x, avg reach ${h.avgReach})`).join(', ')}`);
  return L.join('\n');
}

/* ------------------------------------------------------------------ */
/* Intent routing                                                      */
/* ------------------------------------------------------------------ */

const ROUTER_SYSTEM = `You route a question asked inside "Resurfly", a personal library of the user's saved Instagram posts (analyzed into notes with categories, tags, creators, key points), which may also be connected to the user's Instagram account analytics.
Pick exactly one intent:
- library: find/explain/compare things the user saved ("what did I save about sourdough", "which reels talk about cold outreach", "the video by @x").
- stats: the user's own saving habits, taste, patterns, counts ("what do I save most", "my taste in one line", "how many cooking saves", "who do I save the most from").
- inspire: wants ideas, prompts, nudges, things to try/revisit/do this week from their saves ("what should I try this weekend", "remind me of something worth doing", "give me ideas from my saves").
- create: wants to make content — reel/carousel/post/story/script/caption/hook/content brief/what to post ("write hooks for a reel about X", "content brief for a carousel on Y", "what should I post"). If the question is about what to post AND about their account performance, prefer analytics only when they explicitly mention analytics/numbers/reach/followers.
- analytics: their own Instagram account performance — followers, reach, best time to post, top posts, engagement, hashtags ("how did I do this month", "best time to post", "why did reach drop").
- chat: anything else (general knowledge, small talk, how Resurfly works).
A question that compares the library with the user's own account ("does what I save match what I post", "am I posting what I keep saving") is stats — that strategy sees both sides.
Also extract optional filters ONLY when explicitly present: category (one of exactly: ${CATEGORIES.join(' | ')} — pick the closest one only when the question clearly names that broad topic), tag (a specific keyword/hashtag), creator (an @handle), type (video|image|carousel — "reels" = video), since (a date like 2025-06-01 or relative like 30d/6m/1y). Otherwise leave them null. When unsure, leave a filter null: filters narrow the search and a wrong one hides good saves.`;

const ROUTER_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    intent: { type: 'string', enum: ASK_INTENTS },
    filters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        category: { type: ['string', 'null'] },
        tag: { type: ['string', 'null'] },
        creator: { type: ['string', 'null'] },
        type: { type: ['string', 'null'], enum: ['video', 'image', 'carousel', null] },
        since: { type: ['string', 'null'] },
      },
      required: ['category', 'tag', 'creator', 'type', 'since'],
    },
  },
  required: ['intent', 'filters'],
};

/** Fast, deterministic fallback (used when the model call fails, and for obvious prefixes from the UI mode chips). */
export function heuristicIntent(question: string): AskIntent {
  const q = question.trim().toLowerCase();
  const pre = q.match(/^\[?(library|saves|stats|taste|inspire|ideas|create|brief|content brief|analytics|chat)\]?\s*[:—-]/);
  if (pre) {
    const k = pre[1];
    if (k === 'saves' || k === 'library') return 'library';
    if (k === 'taste' || k === 'stats') return 'stats';
    if (k === 'ideas' || k === 'inspire') return 'inspire';
    if (k === 'brief' || k === 'content brief' || k === 'create') return 'create';
    if (k === 'analytics') return 'analytics';
    return 'chat';
  }
  // "does what I save match what I post" needs both sides — that is the stats strategy (library summary + own posts)
  if (isCrossRefQuestion(q)) return 'stats';
  if (/\b(followers?|reach|impressions|profile views|engagement( rate)?|best time to post|analytics|insights|my (posts|reels) (did|perform)|how did i do|website clicks)\b/.test(q)) return 'analytics';
  if (/\b(content brief|brief for|write (me )?(a |the )?(hook|hooks|script|caption|carousel|reel|post)|hooks? for|script for|caption for|what should i post|outline for|make (a|my own) (reel|carousel|post|version)|remix)\b/.test(q)) return 'create';
  if (/\b(what do i save|my taste|patterns?|how many|most (saved|often)|who do i save|which categor|breakdown|habits?|top (creators|tags|categories)|spend|spent)\b/.test(q)) return 'stats';
  if (/\b(ideas?|inspire|inspiration|nudge|worth (trying|doing|revisiting)|something to (try|do|cook|watch)|this (weekend|week)|remind me|surprise me|prompts?)\b/.test(q)) return 'inspire';
  if (/\b(what did i save|did i save|saved about|from my saves|in my (library|saves)|which (reels?|posts?|saves?)|show me|find|the (video|reel|post) (by|about|where))\b/.test(q)) return 'library';
  if (/\b(hi|hello|hey|thanks|thank you|who are you|what can you do|how does this work)\b/.test(q) && q.length < 40) return 'chat';
  return 'library';
}

/* Category words that are too generic inside an Instagram-saves product to count as "the user named that category". */
const CAT_SYN: Record<string, string> = { cooking: 'Food & Recipes', recipes: 'Food & Recipes', recipe: 'Food & Recipes', food: 'Food & Recipes', fitness: 'Health & Fitness', workout: 'Health & Fitness', workouts: 'Health & Fitness', health: 'Health & Fitness', marketing: 'Business & Marketing', business: 'Business & Marketing', sales: 'Business & Marketing', tech: 'Tech, AI & Tools', ai: 'Tech, AI & Tools', tools: 'Tech, AI & Tools', productivity: 'Productivity & Mindset', mindset: 'Productivity & Mindset', money: 'Money & Finance', finance: 'Money & Finance', investing: 'Money & Finance', travel: 'Travel & Places', fashion: 'Fashion & Style', style: 'Fashion & Style', interior: 'Home & Interior', art: 'Art & Creativity', music: 'Music & Audio', photography: 'Photography & Video Craft', learning: 'Learning & Science', science: 'Learning & Science', relationships: 'Relationships & Communication', humor: 'Humor & Entertainment', comedy: 'Humor & Entertainment', entertainment: 'Humor & Entertainment', design: 'Design & Visual Aesthetics', aesthetics: 'Design & Visual Aesthetics', sentimental: 'Personal & Sentimental' };
const CAT_GENERIC = new Set(['and', 'the', 'content', 'social', 'media', 'video', 'craft', 'other', 'personal', 'places', 'home', 'style', 'creation', 'visual', 'communication']);
const catWords = (s: string) => s.toLowerCase().split(/[^a-z0-9]+/).filter((w) => (w.length >= 3 || w === 'ai') && !CAT_GENERIC.has(w));

/** Every real category a piece of text names (by synonym or by one of its distinctive words). */
export function categoriesMentioned(text: string): Set<string> {
  const out = new Set<string>();
  const t = String(text || '').toLowerCase();
  for (const c of CATEGORIES) if (t.includes(c.toLowerCase())) out.add(c);
  for (const w of catWords(t)) {
    if (CAT_SYN[w]) out.add(CAT_SYN[w]);
    for (const c of CATEGORIES) if (catWords(c).includes(w)) out.add(c);
  }
  return out;
}

/**
 * Snap a model-provided category to a real one ("Marketing" → "Business & Marketing", "cooking" → "Food & Recipes"); null when
 * nothing matches. With `question`, the category is kept only when the question itself names it (the router prompt says
 * "only when explicitly present", but small models over-apply filters — and a filter the user did not ask for hides saves).
 */
export function snapCategory(input: string | null | undefined, question?: string): string | null {
  const q = String(input || '').trim().toLowerCase();
  if (!q) return null;
  let snapped: string | null = CATEGORIES.find((c) => c.toLowerCase() === q) || null;
  if (!snapped) {
    const qw = catWords(q);
    for (const w of qw) if (!snapped && CAT_SYN[w]) snapped = CAT_SYN[w];
    if (!snapped) { const hit = CATEGORIES.filter((c) => qw.some((w) => catWords(c).includes(w))); snapped = hit.length === 1 ? hit[0] : null; }
  }
  if (snapped && question !== undefined && !categoriesMentioned(question).has(snapped)) return null;
  return snapped;
}

/** Validate/normalize router filters against the question + the tenant's real data: unknown categories, creators and tags are dropped (a wrong filter would hide good saves). */
function cleanFilters(f: any, tid?: number, question?: string): AskFilters {
  const out: AskFilters = {};
  if (!f || typeof f !== 'object') return out;
  const s = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, 80) : null);
  const category = s(f.category), tag = s(f.tag), creator = s(f.creator), type = s(f.type), since = s(f.since);
  const snapped = snapCategory(category, question);
  if (snapped) out.category = snapped;
  if (tag) out.tag = tag.replace(/^#/, '').toLowerCase();
  if (creator) out.creator = creator.replace(/^@/, '').toLowerCase();
  if (type && ['video', 'image', 'carousel'].includes(type)) out.type = type;
  if (since && sinceEpoch(since)) out.since = since;
  if (tid !== undefined) {
    try {
      const d = db();
      if (out.tag && !d.prepare('SELECT 1 FROM item_tags t JOIN items i ON i.id = t.item_id WHERE i.tenant_id = ? AND t.tag = ? LIMIT 1').get(tid, out.tag)) delete out.tag;
      if (out.creator && !d.prepare('SELECT 1 FROM items WHERE tenant_id = ? AND lower(author_username) = ? LIMIT 1').get(tid, out.creator)) delete out.creator;
      if (out.category && !d.prepare("SELECT 1 FROM items WHERE tenant_id = ? AND json_extract(analysis, '$.category') = ? LIMIT 1").get(tid, out.category)) delete out.category;
    } catch { /* keep what we have */ }
  }
  return out;
}

/**
 * Decide how to answer. `explicit` (from the request body) wins; otherwise a nano structured call, falling back to
 * the heuristic when the model is unavailable or errors. Never throws.
 */
export async function routeIntent(tid: number, question: string, history: Array<{ role: 'user' | 'assistant'; content: string }> = [], explicit?: string | null): Promise<RoutedIntent> {
  if (explicit && (ASK_INTENTS as string[]).includes(explicit)) return { intent: explicit as AskIntent, filters: {}, via: 'explicit' };
  const recent = history.slice(-4).map((m) => `${m.role}: ${m.content.slice(0, 240)}`).join('\n');
  try {
    const { data } = await generateStructured<{ intent: AskIntent; filters: any }>({
      tid, model: NANO, system: ROUTER_SYSTEM,
      user: `${recent ? `Recent conversation:\n${recent}\n\n` : ''}Question:\n${question.slice(0, 1200)}`,
      schemaName: 'ask_route', schema: ROUTER_SCHEMA, maxOutputTokens: 200, effort: 'low',
    });
    let intent = (ASK_INTENTS as string[]).includes(data?.intent) ? data.intent : heuristicIntent(question);
    // a saved-vs-posted question only works in the strategy that gets both sides
    if (isCrossRefQuestion(question) && (intent === 'library' || intent === 'chat' || intent === 'inspire')) intent = 'stats';
    return { intent, filters: cleanFilters(data?.filters, tid, question), via: 'model' };
  } catch {
    return { intent: heuristicIntent(question), filters: {}, via: 'heuristic' };
  }
}

/* ------------------------------------------------------------------ */
/* Strategies → plan → stream                                          */
/* ------------------------------------------------------------------ */

export interface AskPlan {
  intent: AskIntent;
  filters: AskFilters;
  sources: AskSource[];
  system: string;
  userMsg: string;
  /** e.g. analytics not connected: the answer is fixed text, no model call */
  canned?: string;
  maxOutputTokens: number;
}

const CONNECT_PATH = '/automations';

/* ---- own-content injection (ROUND6 §4) ---- */

const OWN_HEADING = '## What they post (from their connected Instagram account)';
const CROSS_HEADING = '## Saved vs posted (measured overlap)';

/** `## What they post` block, or '' when the account has no cached posts. */
function ownBlock(p: OwnContentProfile, mode: 'full' | 'recent' = 'full'): string {
  const body = mode === 'recent' ? recentPostsText(p) : p.text;
  return body ? `\n\n${OWN_HEADING}\n${body}` : '';
}

/** `## Saved vs posted` block: exact counts of saved topics against the captions of their recent posts. */
function crossBlock(p: OwnContentProfile, st: StatsSummary): string {
  const body = crossReferenceText(p, { tags: st.tags, categories: st.categories });
  return body ? `\n\n${CROSS_HEADING}\n${body}` : '';
}

/** Build the prompt + sources for one intent. Retrieval happens here (so the route can emit `sources` before streaming). */
export async function planAsk(tid: number, question: string, routed: RoutedIntent, history: Array<{ role: 'user' | 'assistant'; content: string }> = []): Promise<AskPlan> {
  const { intent, filters } = routed;
  const total = analyzedCount(tid);
  const q = question.trim();
  switch (intent) {
    case 'stats': {
      const st = statsSummary(tid);
      const sources = statsExamples(tid, st.categories);
      const ctx = buildContext(tid, sources, 'inspire');
      const own = ownContentProfile(tid);
      return {
        intent, filters, sources, system: STATS_SYSTEM, maxOutputTokens: 1200,
        userMsg: `## Library summary\n${st.text}\n\n## Example saves (most useful per top category)\n${ctx || '(no analyzed saves yet)'}${ownBlock(own)}${crossBlock(own, st)}\n\n## Question\n${q}`,
      };
    }
    case 'inspire': {
      const sources = await retrieveInspire(tid, q, 8, filters);
      const ctx = buildContext(tid, sources, 'inspire');
      const own = ownContentProfile(tid);
      return {
        intent, filters, sources, system: INSPIRE_SYSTEM, maxOutputTokens: 1200,
        userMsg: `## Evergreen, useful saves matching the request (${sources.length} of ${total} analyzed)\n\n${ctx || '(nothing relevant found)'}${ownBlock(own)}\n\n## Request\n${q}`,
      };
    }
    case 'create': {
      const sources = await retrieve(tid, q, 10, filters);
      const ctx = buildContext(tid, sources, 'create');
      const st = statsSummary(tid);
      const own = ownContentProfile(tid);
      const taste = [st.categories.slice(0, 4).map((c) => c.name).filter(Boolean).join(', '), st.tags.slice(0, 8).map((t) => t.name).join(', ')].filter(Boolean).join(' · ');
      return {
        intent, filters, sources, system: CREATE_SYSTEM, maxOutputTokens: 1600,
        userMsg: `## The user's taste (from ${total} analyzed saves)\n${taste || '(library still small)'}\n\n## Best-matching saves with hooks, formats and remix ideas\n\n${ctx || '(nothing relevant found)'}${ownBlock(own)}${crossBlock(own, st)}\n\n## Request\n${q}`,
      };
    }
    case 'analytics': {
      const an = await loadAnalytics(tid, 30);
      if (!an.connected || !an.payload) {
        // The one answer that is not written by the model, so it needs the §3 capability check of its own.
        const av = igAvailabilityCached(tid);
        const canned = an.connected && !an.payload
          ? `Your Instagram account is connected, but I don't have analytics for it yet. Open Analytics and press Refresh, then ask again — or ask about your saves in the meantime.`
          : av.canConnect
            ? `Instagram isn't connected yet, so I can't see your numbers. Connect it from Automations (${CONNECT_PATH}) — it takes one click — and I'll answer with your reach, followers, best posting time and top posts. Meanwhile I can help with your saves: try "what do I save most" or "content brief for …".`
            : `I can't see your Instagram numbers: ${av.reason} Your saves are all here though — try "what do I save most" or "content brief for …".`;
        return { intent, filters, sources: [], system: ANALYTICS_SYSTEM, userMsg: q, canned, maxOutputTokens: 200 };
      }
      const wantsIdeas = /\b(post|content|idea|reel|carousel|what should i)\b/i.test(q);
      const sources = wantsIdeas ? await retrieve(tid, q, 5, filters).catch(() => [] as AskSource[]) : [];
      const ctx = sources.length ? buildContext(tid, sources, 'create') : '';
      // the payload already carries the aggregates, so only the recent-posts list is added here (plus the overlap
      // block when the question compares the two sides)
      const own = ownContentProfile(tid);
      const cross = isCrossRefQuestion(q) ? crossBlock(own, statsSummary(tid)) : '';
      return {
        intent, filters, sources, system: ANALYTICS_SYSTEM, maxOutputTokens: 1400,
        userMsg: `## Instagram analytics — last 30 days\n${analyticsText(an.payload)}${ownBlock(own, 'recent')}${cross}${ctx ? `\n\n## Saved posts that could inspire the next post\n${ctx}` : ''}\n\n## Question\n${q}`,
      };
    }
    case 'chat': {
      const st = statsSummary(tid);
      const sources = total ? await retrieve(tid, q, 5, filters).catch(() => [] as AskSource[]) : [];
      const ctx = buildContext(tid, sources, 'library');
      const light = st.totals.total ? `${st.totals.total} saves (${st.totals.analyzed} analyzed). Top categories: ${st.categories.slice(0, 5).map((c) => `${c.name} ${c.n}`).join(', ') || '—'}. Top creators: ${st.creators.slice(0, 4).map((c) => `@${c.name}`).join(', ') || '—'}.` : 'The library is empty so far.';
      // own content only when the question is actually about the account (chat is the catch-all intent)
      const aboutAccount = isAccountQuestion(q) || isCrossRefQuestion(q);
      const own = aboutAccount ? ownContentProfile(tid) : null;
      const ownTxt = own ? `${ownBlock(own)}${isCrossRefQuestion(q) ? crossBlock(own, st) : ''}` : '';
      return {
        intent, filters, sources, system: CHAT_SYSTEM, maxOutputTokens: 900,
        userMsg: `## Library summary (light context)\n${light}${ctx ? `\n\n## Possibly relevant saves\n${ctx}` : ''}${ownTxt}\n\n## Question\n${q}`,
      };
    }
    case 'library':
    default: {
      const sources = await retrieve(tid, q, 12, filters);
      const ctx = buildContext(tid, sources, 'library');
      const fl = Object.entries(filters).filter(([, v]) => v).map(([k, v]) => `${k}=${v}`).join(', ');
      return {
        intent: 'library', filters, sources, system: ASK_SYSTEM, maxOutputTokens: 1800,
        userMsg: `## Library context (${sources.length} most relevant of ${total} analyzed saves${fl ? `; filters: ${fl}` : ''})\n\n${ctx || '(nothing relevant found)'}\n\n## Question\n${q}`,
      };
    }
  }
  void history;
}

/**
 * Stream the answer. Backward compatible: without `plan` it behaves like v1 (library strategy over the given sources).
 */
export async function* askStream(tid: number, question: string, history: Array<{ role: 'user' | 'assistant'; content: string }>, sources: AskSource[], plan?: AskPlan): AsyncGenerator<string> {
  if (plan?.canned) { yield plan.canned; return; }
  let system = ASK_SYSTEM, userMsg: string, maxOutputTokens = 1800;
  if (plan) { system = plan.system; userMsg = plan.userMsg; maxOutputTokens = plan.maxOutputTokens; }
  else {
    const context = buildContext(tid, sources);
    userMsg = `## Library context (${sources.length} most relevant of ${analyzedCount(tid)} analyzed saves)\n\n${context || '(nothing relevant found)'}\n\n## Question\n${question}`;
  }
  system = `${system}\n\n${igCapabilityNote(tid)}`.trim(); // ROUND7 §3: never recommend connecting Instagram when that cannot work
  const messages = [...history.slice(-6).map((m) => ({ role: m.role, content: m.content.slice(0, 4000) })), { role: 'user' as const, content: userMsg }];
  yield* streamText({ tid, model: models(tid).ask, system, messages, effort: 'low', maxOutputTokens });
}

/* ------------------------------------------------------------------ */
/* Title summarization                                                 */
/* ------------------------------------------------------------------ */

export function defaultTitle(question: string): string {
  const t = question.replace(/\s+/g, ' ').trim();
  return t.length > 60 ? `${t.slice(0, 57).trimEnd()}…` : t || 'New conversation';
}

/** Short conversation title (≤ 60 chars) from the first exchange; null when the model is unavailable. */
export async function summarizeTitle(tid: number, question: string, answer: string): Promise<string | null> {
  try {
    const { data } = await generateStructured<{ title: string }>({
      tid, model: NANO,
      system: 'Write a short title (3-7 words, max 60 characters, sentence case, no quotes, no trailing period, no emojis) for a chat that starts with the given question and answer. Name the topic, not the act of asking ("Sourdough starter tips", not "Question about sourdough").',
      user: `Question: ${question.slice(0, 600)}\n\nAnswer (excerpt): ${answer.slice(0, 900)}`,
      schemaName: 'chat_title', schema: { type: 'object', additionalProperties: false, properties: { title: { type: 'string' } }, required: ['title'] },
      maxOutputTokens: 60, effort: 'low',
    });
    const t = String(data?.title || '').replace(/[\r\n"]+/g, ' ').replace(/\s+/g, ' ').trim().replace(/[.!]$/, '');
    if (!t) return null;
    return t.length > 60 ? `${t.slice(0, 57).trimEnd()}…` : t;
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ */
/* Suggested prompts                                                   */
/* ------------------------------------------------------------------ */

export interface AskSuggestion { text: string; intent: AskIntent; kind: 'onboarding' | 'category' | 'creator' | 'season' | 'brief' | 'stats' | 'inspire' | 'analytics' | 'library' | 'crossref' }

const ONBOARDING_PROMPTS: AskSuggestion[] = [
  { text: 'What can you do with my saves?', intent: 'chat', kind: 'onboarding' },
  { text: 'How do I bring my saved posts in?', intent: 'chat', kind: 'onboarding' },
  { text: 'What happens when a save is analyzed?', intent: 'chat', kind: 'onboarding' },
  { text: 'What kinds of questions work best here?', intent: 'chat', kind: 'onboarding' },
  { text: 'Once my saves are in: what do I save most?', intent: 'stats', kind: 'stats' },
  { text: 'Once my saves are in: give me 3 ideas worth trying this week', intent: 'inspire', kind: 'inspire' },
  { text: 'Once my saves are in: write a content brief in my style', intent: 'create', kind: 'brief' },
  { text: 'How do citations like [#id] work?', intent: 'chat', kind: 'onboarding' },
];

function seasonHook(d = new Date()): string {
  const m = d.getUTCMonth();
  const dow = d.getUTCDay();
  const weekend = dow === 5 || dow === 6 || dow === 0;
  const season = m >= 11 || m <= 1 ? 'winter' : m <= 4 ? 'spring' : m <= 7 ? 'summer' : 'autumn';
  if (weekend) return `What did I save that's worth doing this weekend?`;
  if (dow === 1) return `Give me 3 things from my saves to try this week`;
  return `Anything in my saves that fits ${season}?`;
}

/** 8 contextual prompts from the tenant's real data. Empty library → onboarding prompts. */
export async function suggestions(tid: number): Promise<AskSuggestion[]> {
  const st = statsSummary(tid);
  if (!st.totals.total || !st.totals.analyzed) return ONBOARDING_PROMPTS.slice(0, 8);
  const out: AskSuggestion[] = [];
  const cats = st.categories.filter((c) => c.name).slice(0, 3);
  const creators = st.creators.filter((c) => c.name);
  const recentCreator = (db().prepare("SELECT author_username AS name FROM items WHERE tenant_id = ? AND archived = 0 AND excluded = 0 AND author_username IS NOT NULL AND analysis_status = 'done' ORDER BY COALESCE(saved_at, saved_at_est, taken_at) DESC, id DESC LIMIT 1").get(tid) as { name: string } | undefined)?.name || creators[0]?.name;
  const topTag = st.tags[0]?.name;
  const analytics = await loadAnalytics(tid, 30).catch(() => ({ connected: false, payload: null, available: false }));
  const own = ownContentProfile(tid);
  const igOn = own.hasPosts || own.connected || analytics.connected || igConnected(tid);

  if (cats[0]) out.push({ text: `What are the best ${cats[0].name.toLowerCase()} saves I should actually use?`, intent: 'library', kind: 'category' });
  out.push({ text: `What do I save most, and what does it say about my taste?`, intent: 'stats', kind: 'stats' });
  // cross-reference prompts: only meaningful once we can see what they post
  if (igOn) {
    out.push({ text: `Does what I save match what I post?`, intent: 'stats', kind: 'crossref' });
    out.push({ text: `Which of my recent posts is closest to what I keep saving?`, intent: 'analytics', kind: 'crossref' });
  }
  if (recentCreator) out.push({ text: `What have I saved from @${recentCreator}, in short?`, intent: 'library', kind: 'creator' });
  out.push({ text: seasonHook(), intent: 'inspire', kind: 'season' });
  if (igOn) out.push({ text: `Give me an idea that uses my best-performing format`, intent: 'create', kind: 'crossref' });
  if (analytics.connected) {
    out.push({ text: `Based on my analytics, what should I post this week?`, intent: 'analytics', kind: 'analytics' });
    out.push({ text: `Content brief for a reel in my niche, using my best-performing format`, intent: 'create', kind: 'brief' });
  } else {
    out.push({ text: `Content brief for a ${cats[0] ? cats[0].name.toLowerCase() + ' ' : ''}reel in my style`, intent: 'create', kind: 'brief' });
    if (cats[1]) out.push({ text: `Compare the ${cats[1].name.toLowerCase()} advice I saved — what do they agree on?`, intent: 'library', kind: 'category' });
  }
  if (topTag) out.push({ text: `Summarize everything I saved about ${topTag.replace(/-/g, ' ')}`, intent: 'library', kind: 'library' });
  if (cats[2]) out.push({ text: `Give me 3 ideas from my ${cats[2].name.toLowerCase()} saves worth trying`, intent: 'inspire', kind: 'inspire' });
  out.push({ text: `Which of my saves are evergreen and still worth revisiting?`, intent: 'inspire', kind: 'inspire' });
  if (creators[0] && creators[0].name !== recentCreator) out.push({ text: `What do I keep saving from @${creators[0].name}?`, intent: 'library', kind: 'creator' });
  out.push({ text: `What did I save last month that I haven't acted on?`, intent: 'library', kind: 'library' });
  const seen = new Set<string>();
  return out.filter((s) => (seen.has(s.text) ? false : (seen.add(s.text), true))).slice(0, 8);
}

/* ------------------------------------------------------------------ */
/* Conversations + messages                                            */
/* ------------------------------------------------------------------ */

export interface ConversationRow { id: number; tenant_id: number; title: string | null; created_at: number; updated_at: number; pinned: number }
export interface MessageRow { id: number; conversation_id: number; role: 'user' | 'assistant'; content: string; sources: string | null; intent: string | null; created_at: number }

export interface ConversationSummary { id: number; title: string; updatedAt: number; createdAt: number; pinned: boolean; messageCount: number }
export interface MessageOut { id: number; role: 'user' | 'assistant'; content: string; sources: AskSource[]; intent: AskIntent | null; createdAt: number }

const summary = (r: ConversationRow & { message_count?: number }): ConversationSummary => ({ id: r.id, title: r.title || 'New conversation', updatedAt: r.updated_at, createdAt: r.created_at, pinned: !!r.pinned, messageCount: r.message_count || 0 });

export function createConversation(tid: number, title?: string | null): ConversationSummary {
  const t = now();
  const stored = title ? title.slice(0, 120) : null;
  const info = db().prepare('INSERT INTO conversations (tenant_id, title, created_at, updated_at, pinned) VALUES (?, ?, ?, ?, 0)').run(tid, stored, t, t);
  return { id: Number(info.lastInsertRowid), title: stored || 'New conversation', updatedAt: t, createdAt: t, pinned: false, messageCount: 0 };
}

export function listConversations(tid: number, limit = 50): ConversationSummary[] {
  const rows = db().prepare(`SELECT c.*, (SELECT COUNT(*) FROM messages m WHERE m.conversation_id = c.id) AS message_count FROM conversations c WHERE c.tenant_id = ? ORDER BY c.pinned DESC, c.updated_at DESC, c.id DESC LIMIT ?`).all(tid, limit) as Array<ConversationRow & { message_count: number }>;
  return rows.map(summary);
}

export function getConversation(tid: number, id: number): ConversationSummary | null {
  const r = db().prepare(`SELECT c.*, (SELECT COUNT(*) FROM messages m WHERE m.conversation_id = c.id) AS message_count FROM conversations c WHERE c.tenant_id = ? AND c.id = ?`).get(tid, id) as (ConversationRow & { message_count: number }) | undefined;
  return r ? summary(r) : null;
}

export function updateConversation(tid: number, id: number, patch: { title?: string | null; pinned?: boolean }): ConversationSummary | null {
  const sets: string[] = [];
  const params: unknown[] = [];
  if (patch.title !== undefined) { sets.push('title = ?'); params.push(patch.title ? String(patch.title).slice(0, 120) : null); }
  if (patch.pinned !== undefined) { sets.push('pinned = ?'); params.push(patch.pinned ? 1 : 0); }
  if (sets.length) db().prepare(`UPDATE conversations SET ${sets.join(', ')} WHERE tenant_id = ? AND id = ?`).run(...params, tid, id);
  return getConversation(tid, id);
}

export function deleteConversation(tid: number, id: number): boolean {
  const d = db();
  const own = d.prepare('SELECT 1 FROM conversations WHERE tenant_id = ? AND id = ?').get(tid, id);
  if (!own) return false;
  d.prepare('DELETE FROM messages WHERE conversation_id = ?').run(id); // explicit (FK cascade also handles it)
  d.prepare('DELETE FROM conversations WHERE tenant_id = ? AND id = ?').run(tid, id);
  return true;
}

export function touchConversation(tid: number, id: number) {
  db().prepare('UPDATE conversations SET updated_at = ? WHERE tenant_id = ? AND id = ?').run(now(), tid, id);
}

export function addMessage(tid: number, conversationId: number, m: { role: 'user' | 'assistant'; content: string; sources?: AskSource[]; intent?: AskIntent | null }): MessageOut {
  const d = db();
  const own = d.prepare('SELECT 1 FROM conversations WHERE tenant_id = ? AND id = ?').get(tid, conversationId);
  if (!own) throw new Error('conversation not found');
  const t = now();
  const info = d.prepare('INSERT INTO messages (conversation_id, role, content, sources, intent, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(conversationId, m.role, m.content, m.sources && m.sources.length ? JSON.stringify(m.sources) : null, m.intent || null, t);
  d.prepare('UPDATE conversations SET updated_at = ? WHERE id = ?').run(t, conversationId);
  return { id: Number(info.lastInsertRowid), role: m.role, content: m.content, sources: m.sources || [], intent: m.intent || null, createdAt: t };
}

export function listMessages(tid: number, conversationId: number, limit = 200): MessageOut[] | null {
  const d = db();
  const own = d.prepare('SELECT 1 FROM conversations WHERE tenant_id = ? AND id = ?').get(tid, conversationId);
  if (!own) return null;
  const rows = d.prepare('SELECT * FROM messages WHERE conversation_id = ? ORDER BY id ASC LIMIT ?').all(conversationId, limit) as MessageRow[];
  return rows.map((r) => ({ id: r.id, role: r.role, content: r.content, sources: j<AskSource[]>(r.sources, []), intent: (r.intent as AskIntent) || null, createdAt: r.created_at }));
}

/** History for the model when the client didn't send one: the conversation's last messages (user/assistant text only). */
export function historyFor(tid: number, conversationId: number, limit = 8): Array<{ role: 'user' | 'assistant'; content: string }> {
  const rows = listMessages(tid, conversationId, 500) || [];
  return rows.slice(-limit).map((m) => ({ role: m.role, content: m.content }));
}
