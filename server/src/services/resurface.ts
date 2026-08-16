import { db, getMeta, j, now, setMeta } from '../db.js';
import type { Analysis, ItemRow } from '../types.js';
import { generateStructured, hasOpenAI, models } from './openai.js';

/** Deterministic PRNG from a string seed (mulberry32 over a hash). */
function seeded(seed: string) {
  let h = 1779033703 ^ seed.length;
  for (let i = 0; i < seed.length; i++) { h = Math.imul(h ^ seed.charCodeAt(i), 3432918353); h = (h << 13) | (h >>> 19); }
  let a = h >>> 0;
  return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

export function todayKey(): string { return new Date().toISOString().slice(0, 10); }

/**
 * Pick N saves worth resurfacing today. Weighted by usefulness, evergreen-ness, time since last resurfaced, and age.
 * Deterministic per day so the "Today" set is stable.
 */
export function pickResurface(tid: number, n = 3, dateKey = todayKey()): ItemRow[] {
  const d = db();
  // Stable for the whole day: persist the chosen ids on first computation (marking items "resurfaced" must not reshuffle the set).
  const key = `resurface_picks:${dateKey}:${n}`;
  const stored = j<string[] | null>(getMeta(tid, key), null);
  if (stored && stored.length) {
    const rows = d.prepare(`SELECT * FROM items WHERE tenant_id = ? AND id IN (${stored.map(() => '?').join(',')}) AND archived = 0 AND excluded = 0`).all(tid, ...stored) as ItemRow[];
    if (rows.length === stored.length) return stored.map((id) => rows.find((r) => r.id === id)!).filter(Boolean);
  }
  const picked = computePicks(tid, n, dateKey);
  if (picked.length) setMeta(tid, key, JSON.stringify(picked.map((p) => p.id)));
  return picked;
}

function computePicks(tid: number, n: number, dateKey: string): ItemRow[] {
  const rows = db().prepare("SELECT * FROM items WHERE tenant_id = ? AND analysis_status = 'done' AND archived = 0 AND excluded = 0").all(tid) as ItemRow[];
  if (!rows.length) return [];
  const rnd = seeded(`resurfly:${tid}:${dateKey}`);
  const t = now();
  const scored = rows.map((r) => {
    const a = j<Analysis | null>(r.analysis, null);
    const useful = a?.usefulness_score ?? 5;
    const evergreen = a?.is_evergreen ? 1.4 : 1;
    const sinceResurf = r.last_resurfaced_at ? Math.min(60, (t - r.last_resurfaced_at) / 86400) / 60 : 1;
    const rank = r.saved_rank ?? 0;
    const buried = Math.min(1, rank / Math.max(50, rows.length)); // deeper in the graveyard = more deserving
    const w = (useful / 10) * evergreen * (0.4 + sinceResurf) * (0.6 + buried * 0.8) * (0.7 + rnd() * 0.6);
    return { r, w };
  });
  scored.sort((a, b) => b.w - a.w);
  // take top-N with some diversity by category
  const picked: ItemRow[] = [];
  const cats = new Set<string>();
  for (const s of scored) {
    const cat = j<Analysis | null>(s.r.analysis, null)?.category || 'x';
    if (cats.has(cat) && picked.length < n - 1 && scored.length > n * 3) continue;
    picked.push(s.r); cats.add(cat);
    if (picked.length >= n) break;
  }
  return picked;
}

const NOTE_SCHEMA = {
  type: 'object', additionalProperties: false,
  properties: { notes: { type: 'array', items: { type: 'object', additionalProperties: false, properties: { id: { type: 'string' }, why_today: { type: 'string', description: 'One warm, specific sentence (max 160 chars) telling the user why this save deserves a second look today, referencing its actual content.' } }, required: ['id', 'why_today'] } } },
  required: ['notes'],
} as const;

/** Cached per-day "why today" blurbs. */
export async function resurfaceNotes(tid: number, items: ItemRow[], dateKey = todayKey()): Promise<Record<string, string>> {
  const key = `resurface_notes:${dateKey}`;
  const cached = j<Record<string, string> | null>(getMeta(tid, key), null);
  if (cached && items.every((i) => cached[i.id])) return cached;
  if (!hasOpenAI(tid) || !items.length) return {};
  try {
    const desc = items.map((r) => { const a = j<Analysis | null>(r.analysis, null)!; return `[${r.id}] ${a.title} — ${a.one_liner}. Key: ${a.key_points.slice(0, 3).join('; ')}. Nudge: ${a.resurface_prompt}`; }).join('\n');
    const { data } = await generateStructured<{ notes: Array<{ id: string; why_today: string }> }>({
      tid, model: models(tid).analysis, system: 'You write short, specific, encouraging one-liners. No emojis. No hype.', user: `Today is ${dateKey}. For each save below write "why_today".\n\n${desc}`,
      schemaName: 'resurface_notes', schema: NOTE_SCHEMA as any, maxOutputTokens: 600, effort: 'low',
    });
    const map: Record<string, string> = {};
    for (const n of data.notes) map[n.id] = n.why_today;
    setMeta(tid, key, JSON.stringify(map));
    return map;
  } catch {
    return {};
  }
}

export function markResurfaced(tid: number, ids: string[]) {
  const stmt = db().prepare('UPDATE items SET last_resurfaced_at = ?, resurface_count = resurface_count + 1 WHERE id = ? AND tenant_id = ?');
  const t = now();
  db().transaction(() => { for (const id of ids) stmt.run(t, id, tid); })();
}
