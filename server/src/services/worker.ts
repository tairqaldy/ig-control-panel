import { config } from '../config.js';
import { db, getMeta, now, setMeta } from '../db.js';
import { hasOpenAI } from './openai.js';
import { processItem, QuotaError } from './pipeline.js';
import { budgetExhausted, getScope, scopeWhereSql } from './scope.js';

/**
 * Minimal, robust in-process job runner.
 * Queue state lives in the items table (queue_state: idle | queued | running), so it survives restarts.
 */
class Worker {
  private running = new Set<string>();
  private timer: NodeJS.Timeout | null = null;
  private stopping = false;
  public startedAt = now();
  public processedSinceBoot = 0;
  public failedSinceBoot = 0;
  public lastError: string | null = null;
  public recent: Array<{ id: string; ok: boolean; at: number; ms: number; note?: string }> = [];

  get paused(): boolean { return getMeta('worker_paused') === '1'; }
  set paused(v: boolean) { setMeta('worker_paused', v ? '1' : '0'); if (!v) { setMeta('worker_pause_reason', null); this.kick(); } }
  get pauseReason(): string | null { return getMeta('worker_pause_reason'); }
  /** Pause with a machine-readable reason (shown in the UI): 'quota' | 'budget' | 'manual'. */
  pauseFor(reason: string) { setMeta('worker_pause_reason', reason); setMeta('worker_paused', '1'); }
  get concurrency(): number { const s = Number(getMeta('worker_concurrency')); return Number.isFinite(s) && s > 0 ? Math.min(8, s) : config.concurrency; }
  set concurrency(n: number) { setMeta('worker_concurrency', String(Math.max(1, Math.min(8, Math.round(n))))); this.kick(); }

  start() {
    // Requeue anything that was mid-flight when the process died.
    db().prepare("UPDATE items SET queue_state = 'queued' WHERE queue_state = 'running'").run();
    db().prepare("UPDATE items SET analysis_status = 'pending' WHERE analysis_status = 'running'").run();
    this.timer = setInterval(() => this.tick(), 1500);
    this.kick();
  }
  stop() { this.stopping = true; if (this.timer) clearInterval(this.timer); }
  kick() { setImmediate(() => this.tick()); }

  status() {
    const d = db();
    const counts = d.prepare(`SELECT
        SUM(CASE WHEN queue_state = 'queued' THEN 1 ELSE 0 END) AS queued,
        SUM(CASE WHEN queue_state = 'running' THEN 1 ELSE 0 END) AS running,
        SUM(CASE WHEN analysis_status = 'done' THEN 1 ELSE 0 END) AS analyzed,
        SUM(CASE WHEN analysis_status = 'failed' THEN 1 ELSE 0 END) AS failed,
        SUM(CASE WHEN analysis_status = 'skipped' THEN 1 ELSE 0 END) AS skipped,
        SUM(CASE WHEN analysis_status = 'pending' AND queue_state = 'idle' THEN 1 ELSE 0 END) AS unqueued_pending,
        COUNT(*) AS total
      FROM items WHERE archived = 0`).get() as any;
    return {
      paused: this.paused,
      pauseReason: this.pauseReason,
      concurrency: this.concurrency,
      openaiConfigured: hasOpenAI(),
      queued: counts.queued || 0,
      running: counts.running || 0,
      analyzed: counts.analyzed || 0,
      failed: counts.failed || 0,
      skipped: counts.skipped || 0,
      pending: counts.unqueued_pending || 0,
      total: counts.total || 0,
      runningIds: Array.from(this.running),
      processedSinceBoot: this.processedSinceBoot,
      failedSinceBoot: this.failedSinceBoot,
      lastError: this.lastError,
      recent: this.recent.slice(-12).reverse(),
      startedAt: this.startedAt,
    };
  }

  /**
   * Queue items by ids, or by selector. All selectors respect the analysis scope (date window, media types)
   * and never touch excluded/archived saves; explicit ids are queued as-is (user intent).
   */
  enqueue(ids: string[] | 'pending' | 'failed' | 'all' | 'eligible', opts: { force?: boolean } = {}): number {
    const d = db();
    const t = now();
    const w = scopeWhereSql(getScope());
    let n = 0;
    if (ids === 'pending' || ids === 'eligible') {
      n = d.prepare(`UPDATE items SET queue_state = 'queued', queued_at = ? WHERE queue_state = 'idle' AND ${w.sql} AND analysis_status IN ('pending')`).run(t, ...w.params).changes;
    } else if (ids === 'failed') {
      n = d.prepare(`UPDATE items SET queue_state = 'queued', queued_at = ?, analysis_status = 'pending', analysis_error = NULL, media_status = CASE WHEN media_status IN ('failed','expired') THEN 'pending' ELSE media_status END WHERE queue_state = 'idle' AND ${w.sql} AND analysis_status IN ('failed','skipped')`).run(t, ...w.params).changes;
    } else if (ids === 'all') {
      n = d.prepare(`UPDATE items SET queue_state = 'queued', queued_at = ?, analysis_status = 'pending' WHERE queue_state = 'idle' AND ${w.sql}`).run(t, ...w.params).changes;
    } else {
      const stmt = d.prepare(`UPDATE items SET queue_state = 'queued', queued_at = ?${opts.force ? ", analysis_status = 'pending', analysis_error = NULL" : ''} WHERE id = ? AND queue_state = 'idle' AND excluded = 0`);
      d.transaction(() => { for (const id of ids) n += stmt.run(t, id).changes; })();
    }
    this.kick();
    return n;
  }

  /** Items that failed only because OpenAI ran out of credits are not really failed: put them back to pending. */
  resetQuotaFailures(): number {
    const d = db();
    const n = d.prepare("UPDATE items SET analysis_status = 'pending', analysis_error = NULL WHERE analysis_status = 'failed' AND (analysis_error LIKE '%429%' OR analysis_error LIKE '%quota%' OR analysis_error LIKE '%credits%')").run().changes;
    d.prepare("UPDATE items SET media_status = 'pending', media_error = NULL WHERE media_status IN ('partial','failed') AND (media_error LIKE '%429%' OR media_error LIKE '%quota%' OR media_error LIKE '%credits%')").run();
    return n;
  }

  dequeueAll(): number {
    return db().prepare("UPDATE items SET queue_state = 'idle' WHERE queue_state = 'queued'").run().changes;
  }

  private tick() {
    if (this.stopping || this.paused) return;
    if (!hasOpenAI()) return; // nothing useful to do without a key (media-only fetch is still triggered by import)
    const free = this.concurrency - this.running.size;
    if (free <= 0) return;
    if (budgetExhausted()) { this.pauseFor('budget'); return; }
    // Newest saves first (saved_rank asc), never excluded ones.
    const rows = db().prepare("SELECT id FROM items WHERE queue_state = 'queued' AND excluded = 0 ORDER BY saved_rank ASC, queued_at ASC LIMIT ?").all(free) as Array<{ id: string }>;
    for (const r of rows) this.run(r.id);
  }

  private async run(id: string) {
    if (this.running.has(id)) return;
    this.running.add(id);
    db().prepare("UPDATE items SET queue_state = 'running' WHERE id = ?").run(id);
    const t0 = Date.now();
    let ok = true;
    let note: string | undefined;
    try {
      await processItem(id);
      const st = db().prepare('SELECT analysis_status, analysis_error FROM items WHERE id = ?').get(id) as any;
      ok = st?.analysis_status === 'done';
      note = ok ? undefined : st?.analysis_error || st?.analysis_status;
      if (!ok) { this.failedSinceBoot++; this.lastError = note || null; } else this.processedSinceBoot++;
    } catch (e: any) {
      ok = false;
      note = String(e?.message || e);
      this.lastError = note;
      if (e instanceof QuotaError) {
        // Out of credits: keep the item queued, pause everything with a clear reason. Nothing is marked failed.
        this.pauseFor('quota');
        db().prepare("UPDATE items SET queue_state = 'queued' WHERE id = ?").run(id);
        this.running.delete(id);
        this.recent.push({ id, ok: false, at: now(), ms: Date.now() - t0, note: 'paused: OpenAI credits exhausted' });
        return;
      }
      this.failedSinceBoot++;
      db().prepare("UPDATE items SET analysis_status = CASE WHEN analysis_status = 'done' THEN 'done' ELSE 'failed' END, analysis_error = ? WHERE id = ?").run(note.slice(0, 500), id);
    } finally {
      if (this.running.has(id)) {
        db().prepare("UPDATE items SET queue_state = 'idle' WHERE id = ?").run(id);
        this.running.delete(id);
        this.recent.push({ id, ok, at: now(), ms: Date.now() - t0, note });
        if (this.recent.length > 50) this.recent.shift();
        // Rate-limit backoff: if the last 3 all failed with 429-ish errors, take a breather.
        const last3 = this.recent.slice(-3);
        if (last3.length === 3 && last3.every((r) => !r.ok && /429|rate limit/i.test(r.note || ''))) setTimeout(() => this.kick(), 30_000);
        else this.kick();
      }
    }
  }
}

export const worker = new Worker();
