/**
 * Analysis scope & budget: which saves get (paid) analysis, how deep, and with what model tier.
 * All settings live in the `settings` table (editable in the UI); env vars are only used for models.
 */
import { config } from '../config.js';
import { db, getMeta, getSetting, now, setMeta, setSetting } from '../db.js';
import { estimateItemCost } from './pricing.js';
import { models } from './openai.js';

export type Tier = 'standard' | 'economy';
export type TranscribePolicy = 'all' | 'short' | 'none';
export type MediaKind = 'video' | 'image' | 'carousel';

export interface Scope {
  years: number; // 0 = everything
  types: MediaKind[];
  transcribe: TranscribePolicy;
  transcribeMaxSeconds: number; // used when policy = 'short'
  frames: number; // 0 | 2 | 4 (video frames / carousel slides sent to the vision model)
  tier: Tier;
  budgetUsd: number; // 0 = no cap
}

export const DEFAULT_SCOPE: Scope = { years: 2, types: ['video', 'image', 'carousel'], transcribe: 'short', transcribeMaxSeconds: 180, frames: 4, tier: 'standard', budgetUsd: 0 };

export function getScope(): Scope {
  const raw = getSetting('scope');
  if (!raw) return { ...DEFAULT_SCOPE };
  try { return { ...DEFAULT_SCOPE, ...JSON.parse(raw) }; } catch { return { ...DEFAULT_SCOPE }; }
}
export function setScope(patch: Partial<Scope>): Scope {
  const cur = getScope();
  const next: Scope = {
    years: Math.max(0, Math.min(15, Number(patch.years ?? cur.years) || 0)),
    types: Array.isArray(patch.types) && patch.types.length ? (patch.types.filter((t) => ['video', 'image', 'carousel'].includes(t)) as MediaKind[]) : cur.types,
    transcribe: (['all', 'short', 'none'] as const).includes(patch.transcribe as any) ? (patch.transcribe as TranscribePolicy) : cur.transcribe,
    transcribeMaxSeconds: Math.max(15, Math.min(1800, Number(patch.transcribeMaxSeconds ?? cur.transcribeMaxSeconds) || 180)),
    frames: [0, 2, 4, 6].includes(Number(patch.frames)) ? Number(patch.frames) : cur.frames,
    tier: patch.tier === 'economy' || patch.tier === 'standard' ? patch.tier : cur.tier,
    budgetUsd: Math.max(0, Number(patch.budgetUsd ?? cur.budgetUsd) || 0),
  };
  setSetting('scope', JSON.stringify(next));
  return next;
}

/** Model actually used for analysis, honoring an explicit env/settings override, else the tier. */
export function analysisModelFor(scope: Scope): string {
  const explicit = getSetting('analysis_model') || process.env.OPENAI_MODEL;
  if (explicit) return explicit;
  return scope.tier === 'economy' ? 'gpt-5.4-nano' : 'gpt-5.4-mini';
}

/** SQL fragment (no leading AND) selecting items inside the current scope. */
export function scopeWhereSql(scope: Scope): { sql: string; params: unknown[] } {
  const clauses: string[] = ['excluded = 0', 'archived = 0'];
  const params: unknown[] = [];
  if (scope.years > 0) {
    clauses.push('COALESCE(saved_at, saved_at_est, taken_at, created_at) >= ?');
    params.push(now() - Math.round(scope.years * 365.25 * 86400));
  }
  if (scope.types.length < 3) {
    clauses.push(`media_type IN (${scope.types.map(() => '?').join(',')})`);
    params.push(...scope.types);
  }
  return { sql: clauses.join(' AND '), params };
}

/** Should this video be transcribed under the current policy? */
export function shouldTranscribe(scope: Scope, durationSec: number | null): boolean {
  if (scope.transcribe === 'none') return false;
  if (scope.transcribe === 'all') return true;
  return (durationSec ?? 0) <= scope.transcribeMaxSeconds;
}

/**
 * Estimated save time for harvest items (Instagram's saved feed doesn't expose it):
 * saves are ordered newest-first (saved_rank asc); a save can't be older than its post, and can't be older than
 * any save further down the list → running max of taken_at from the oldest end is a tight lower bound.
 */
export function recomputeSavedAtEst(): number {
  const d = db();
  const rows = d.prepare('SELECT id, taken_at, saved_at FROM items WHERE saved_rank IS NOT NULL ORDER BY saved_rank DESC').all() as Array<{ id: string; taken_at: number | null; saved_at: number | null }>;
  const upd = d.prepare('UPDATE items SET saved_at_est = ? WHERE id = ?');
  let running = 0, n = 0;
  d.transaction(() => {
    for (const r of rows) {
      const t = r.saved_at || r.taken_at || 0;
      if (t > running) running = t;
      upd.run(running || null, r.id);
      n++;
    }
  })();
  return n;
}

export interface ScopeReport {
  scope: Scope;
  model: string;
  counts: { total: number; analyzed: number; eligiblePending: number; outOfScope: number; excluded: number; failed: number; queued: number };
  eligibleByType: Record<string, number>;
  estimate: { standard: number; economy: number; perItemStandard: number; perItemEconomy: number; transcribeMinutes: number };
  spent: { total: number; sinceReset: number; items: number; avgPerItem: number; byType: Record<string, { n: number; usd: number }> };
  budget: { cap: number; remaining: number | null; paused: boolean; pauseReason: string | null };
}

export function scopeReport(): ScopeReport {
  const d = db();
  const scope = getScope();
  const m = models();
  const w = scopeWhereSql(scope);
  const total = (d.prepare('SELECT COUNT(*) AS n FROM items WHERE archived = 0').get() as any).n;
  const excluded = (d.prepare('SELECT COUNT(*) AS n FROM items WHERE excluded = 1').get() as any).n;
  const analyzed = (d.prepare("SELECT COUNT(*) AS n FROM items WHERE analysis_status = 'done' AND archived = 0 AND excluded = 0").get() as any).n;
  const failed = (d.prepare("SELECT COUNT(*) AS n FROM items WHERE analysis_status = 'failed' AND archived = 0 AND excluded = 0").get() as any).n;
  const queued = (d.prepare("SELECT COUNT(*) AS n FROM items WHERE queue_state IN ('queued','running')").get() as any).n;
  const eligibleRows = d.prepare(`SELECT media_type, duration FROM items WHERE ${w.sql} AND analysis_status != 'done'`).all(...w.params) as Array<{ media_type: string; duration: number | null }>;
  const outOfScope = (d.prepare(`SELECT COUNT(*) AS n FROM items WHERE archived = 0 AND excluded = 0 AND analysis_status != 'done' AND NOT (${w.sql})`).get(...w.params) as any).n;
  const byType: Record<string, number> = {};
  let std = 0, eco = 0, trMin = 0;
  const trModel = m.transcribe;
  for (const r of eligibleRows) {
    byType[r.media_type] = (byType[r.media_type] || 0) + 1;
    const hasVideo = r.media_type === 'video';
    const trSec = hasVideo && shouldTranscribe(scope, r.duration) ? (r.duration || 40) : 0;
    trMin += trSec / 60;
    const frames = r.media_type === 'image' ? Math.min(1, scope.frames) : r.media_type === 'carousel' ? Math.min(6, Math.max(scope.frames, 1)) : scope.frames;
    std += estimateItemCost({ model: 'gpt-5.4-mini', transcribeModel: trModel, embedModel: m.embed, frames, hasVideo, transcribeSeconds: trSec });
    eco += estimateItemCost({ model: 'gpt-5.4-nano', transcribeModel: trModel, embedModel: m.embed, frames, hasVideo, transcribeSeconds: trSec });
  }
  const n = eligibleRows.length || 1;
  const spentRow = d.prepare('SELECT COALESCE(SUM(cost_usd),0) AS usd, SUM(CASE WHEN cost_usd > 0 THEN 1 ELSE 0 END) AS n FROM items').get() as any;
  const resetAt = Number(getMeta('budget_reset_at') || 0);
  const sinceReset = (d.prepare('SELECT COALESCE(SUM(cost_usd),0) AS usd FROM items WHERE analyzed_at >= ?').get(resetAt) as any).usd;
  const byTypeRows = d.prepare('SELECT media_type, COUNT(*) AS n, SUM(cost_usd) AS usd FROM items WHERE cost_usd > 0 GROUP BY media_type').all() as Array<{ media_type: string; n: number; usd: number }>;
  const spentByType: Record<string, { n: number; usd: number }> = {};
  for (const r of byTypeRows) spentByType[r.media_type] = { n: r.n, usd: r.usd };
  const paused = getMeta('worker_paused') === '1';
  return {
    scope,
    model: analysisModelFor(scope),
    counts: { total, analyzed, eligiblePending: eligibleRows.length, outOfScope, excluded, failed, queued },
    eligibleByType: byType,
    estimate: { standard: round(std), economy: round(eco), perItemStandard: round(std / n, 4), perItemEconomy: round(eco / n, 4), transcribeMinutes: Math.round(trMin) },
    spent: { total: round(spentRow.usd), sinceReset: round(sinceReset), items: spentRow.n || 0, avgPerItem: spentRow.n ? round(spentRow.usd / spentRow.n, 4) : 0, byType: spentByType },
    budget: { cap: scope.budgetUsd, remaining: scope.budgetUsd ? round(Math.max(0, scope.budgetUsd - sinceReset)) : null, paused, pauseReason: getMeta('worker_pause_reason') },
  };
}

const round = (n: number, d = 2) => Math.round(n * 10 ** d) / 10 ** d;

/**
 * Items analyzed before per-save cost tracking existed get an ESTIMATED cost (marked estimated:true)
 * so "Spent so far" isn't misleadingly low. Real token counts are used for everything analyzed afterwards.
 */
export function backfillEstimatedCosts(): number {
  const d = db();
  const m = models();
  const rows = d.prepare("SELECT id, analysis_model, media_type, duration, transcript, frames FROM items WHERE analysis_status = 'done' AND (cost_usd IS NULL OR cost_usd = 0) AND usage IS NULL").all() as Array<{ id: string; analysis_model: string | null; media_type: string; duration: number | null; transcript: string | null; frames: string | null }>;
  if (!rows.length) return 0;
  const upd = d.prepare('UPDATE items SET cost_usd = ?, usage = ? WHERE id = ?');
  d.transaction(() => {
    for (const r of rows) {
      let frames = 0;
      try { frames = r.frames ? (JSON.parse(r.frames) as string[]).length : 0; } catch {}
      const hasVideo = r.media_type === 'video';
      const trSec = hasVideo && r.transcript ? Math.round(r.duration || 40) : 0;
      const cost = estimateItemCost({ model: r.analysis_model || m.analysis, transcribeModel: m.transcribe, embedModel: m.embed, frames: frames || (r.media_type === 'image' ? 1 : 0), hasVideo, transcribeSeconds: trSec, hasTranscript: !!r.transcript });
      upd.run(cost, JSON.stringify({ estimated: true }), r.id);
    }
  })();
  return rows.length;
}

/** True when the configured budget is exhausted. */
export function budgetExhausted(): boolean {
  const scope = getScope();
  if (!scope.budgetUsd) return false;
  const resetAt = Number(getMeta('budget_reset_at') || 0);
  const spent = (db().prepare('SELECT COALESCE(SUM(cost_usd),0) AS usd FROM items WHERE analyzed_at >= ?').get(resetAt) as any).usd;
  return spent >= scope.budgetUsd;
}
export function resetBudget() { setMeta('budget_reset_at', String(now())); }
