import { db, j } from '../db.js';
import type { Analysis, ItemRow } from '../types.js';
import { keywordSearch } from './search.js';
import { semanticSearch } from './neighbors.js';
import { models, streamText } from './openai.js';

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

const ASK_SYSTEM = `You are Undig, the user's personal librarian for everything they ever saved on Instagram.
You answer questions ONLY from the provided saves (the "library context"). Each save has an id like [#abc123].

Rules:
- Ground every claim in the context. After each sentence or bullet that uses a save, cite it with its id token exactly like [#abc123]. You may cite several: [#a1] [#b2].
- If the context does not contain the answer, say so plainly and suggest what to search for or which tags to explore. Never invent saves.
- Prefer synthesis: group related saves, extract the concrete steps/tips, compare approaches, and point out the single best save to start with.
- Be concise and structured (short paragraphs, bullets). Plain language. No emojis. Do not repeat the question.
- End with a line "Try next:" followed by 2-3 short follow-up questions the user could ask about their library.`;

function rrf(lists: Array<Array<{ id: string; score: number }>>, k = 60): Map<string, number> {
  const out = new Map<string, number>();
  for (const list of lists) list.forEach((r, i) => out.set(r.id, (out.get(r.id) || 0) + 1 / (k + i + 1)));
  return out;
}

export async function retrieve(question: string, limit = 12): Promise<AskSource[]> {
  const [sem, kw] = await Promise.all([
    semanticSearch(question, 40).catch(() => [] as Array<{ id: string; score: number }>),
    Promise.resolve(keywordSearch(question, 25)),
  ]);
  const fused = rrf([sem, kw]);
  const ids = Array.from(fused.entries()).sort((a, b) => b[1] - a[1]).slice(0, limit).map(([id]) => id);
  if (!ids.length) return [];
  const rows = db().prepare(`SELECT * FROM items WHERE id IN (${ids.map(() => '?').join(',')}) AND archived = 0 AND excluded = 0`).all(...ids) as ItemRow[];
  const byId = new Map(rows.map((r) => [r.id, r]));
  return ids.filter((id) => byId.has(id)).map((id) => {
    const r = byId.get(id)!;
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
      score: fused.get(id) || 0,
    };
  });
}

export function buildContext(sources: AskSource[]): string {
  const d = db();
  const parts: string[] = [];
  for (const s of sources) {
    const r = d.prepare('SELECT * FROM items WHERE id = ?').get(s.id) as ItemRow;
    const a = j<Analysis | null>(r.analysis, null);
    const lines = [`[#${s.id}] ${s.title}${r.author_username ? ` — @${r.author_username}` : ''} (${r.media_type}${a ? `, ${a.category}` : ''})`];
    if (a) {
      if (a.one_liner) lines.push(`  One-liner: ${a.one_liner}`);
      if (a.summary) lines.push(`  Summary: ${a.summary}`);
      if (a.key_points.length) lines.push(`  Key points: ${a.key_points.map((k) => `• ${k}`).join(' ')}`);
      if (a.actionable_takeaways.length) lines.push(`  Actions: ${a.actionable_takeaways.join(' | ')}`);
      if (a.tags.length) lines.push(`  Tags: ${a.tags.join(', ')}`);
      const ents = [...a.entities.tools, ...a.entities.brands, ...a.entities.people, ...a.entities.places].slice(0, 12);
      if (ents.length) lines.push(`  Entities: ${ents.join(', ')}`);
      if (a.quotes.length) lines.push(`  Quotes: ${a.quotes.map((q) => `"${q}"`).join(' ')}`);
    } else if (r.caption) lines.push(`  Caption: ${r.caption.slice(0, 500)}`);
    if (r.transcript && (!a || a.key_points.length < 2)) lines.push(`  Transcript excerpt: ${r.transcript.slice(0, 600)}`);
    lines.push(`  URL: ${r.url}`);
    parts.push(lines.join('\n'));
  }
  return parts.join('\n\n');
}

export async function* askStream(question: string, history: Array<{ role: 'user' | 'assistant'; content: string }>, sources: AskSource[]): AsyncGenerator<string> {
  const context = buildContext(sources);
  const total = (db().prepare("SELECT COUNT(*) AS n FROM items WHERE analysis_status = 'done' AND archived = 0 AND excluded = 0").get() as any).n;
  const userMsg = `## Library context (${sources.length} most relevant of ${total} analyzed saves)\n\n${context || '(nothing relevant found)'}\n\n## Question\n${question}`;
  const messages = [...history.slice(-6), { role: 'user' as const, content: userMsg }];
  yield* streamText({ model: models().ask, system: ASK_SYSTEM, messages, effort: 'low', maxOutputTokens: 1800 });
}
