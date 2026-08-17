import { config } from '../config.js';
import { db, getMeta, GLOBAL, now, OWNER_TENANT, setMeta } from '../db.js';
import { hasOpenAI, usesSharedKey } from './openai.js';
import { processItem, QuotaError } from './pipeline.js';
import { budgetExhausted, getScope, scopeWhereSql } from './scope.js';
import { chargeMetered, checkQuota, effectivePlan, getTenant, PLAN_WEIGHTS, PLANS, type QuotaCheck } from './plans.js';
import { creditBalance, creditUnitsAvailable } from './credits.js';

export interface EnqueueResult {
  /** items actually queued now */
  queued: number;
  /** eligible items NOT queued because the tenant's analysis allowance is used up (newest saves were queued first) */
  leftOut: number;
  /** the analyze quota check that limited the queue (null = unlimited) */
  quota: QuotaCheck | null;
}

const NEWEST_FIRST = 'CASE WHEN saved_rank IS NULL THEN 1 ELSE 0 END, saved_rank ASC, saved_at DESC, created_at DESC';

/**
 * Minimal, robust in-process job runner.
 * Queue state lives in the items table (queue_state: idle | queued | running), so it survives restarts.
 * Multi-tenant: one global concurrency budget, fair weighted round-robin across tenants (studio 3 : pro 2 : trial 1),
 * per-tenant concurrency caps from the plan, and tenants without analysis allowance (expired trial / free) are skipped.
 */
class Worker {
  private running = new Map<string, number>(); // item id → tenant id
  private timer: NodeJS.Timeout | null = null;
  private stopping = false;
  private rrCurrent = new Map<number, number>(); // smooth weighted round-robin state
  public startedAt = now();
  private processed = new Map<number, number>();
  private failed = new Map<number, number>();
  private lastErrors = new Map<number, string>();
  public recent: Array<{ tid: number; id: string; ok: boolean; at: number; ms: number; note?: string }> = [];

  /* ---------------- pause state: global (tenant 0) + per tenant ---------------- */
  get globalPaused(): boolean { return getMeta(GLOBAL, 'worker_paused') === '1'; }
  isPaused(tid: number): boolean { return this.globalPaused || getMeta(tid, 'worker_paused') === '1'; }
  pauseReason(tid: number): string | null { return getMeta(tid, 'worker_pause_reason') || getMeta(GLOBAL, 'worker_pause_reason'); }
  /**
   * Pause with a machine-readable reason (shown in the UI): 'quota' | 'budget' | 'manual'.
   * The owner's manual pause and a shared-key OpenAI quota problem stop the whole worker; everything else is per tenant.
   */
  pause(tid: number, reason: string) {
    const global = reason === 'quota' ? usesSharedKey() : reason === 'manual' && tid === OWNER_TENANT;
    const scope = global ? GLOBAL : tid;
    setMeta(scope, 'worker_pause_reason', reason);
    setMeta(scope, 'worker_paused', '1');
  }
  /** Resume: clears the tenant's own pause; the owner also clears the global pause. */
  resume(tid: number) {
    setMeta(tid, 'worker_paused', '0');
    setMeta(tid, 'worker_pause_reason', null);
    if (tid === OWNER_TENANT) { setMeta(GLOBAL, 'worker_paused', '0'); setMeta(GLOBAL, 'worker_pause_reason', null); }
    this.kick();
  }
  /** Backward-compatible global accessors (owner). */
  get paused(): boolean { return this.globalPaused; }
  set paused(v: boolean) { if (v) this.pause(OWNER_TENANT, 'manual'); else this.resume(OWNER_TENANT); }
  pauseFor(reason: string) { this.pause(OWNER_TENANT, reason); }

  /* ---------------- concurrency: one global budget (env / owner setting) ---------------- */
  get concurrency(): number { const s = Number(getMeta(GLOBAL, 'worker_concurrency')); return Number.isFinite(s) && s > 0 ? Math.min(8, s) : config.concurrency; }
  set concurrency(n: number) { setMeta(GLOBAL, 'worker_concurrency', String(Math.max(1, Math.min(8, Math.round(n))))); this.kick(); }
  /** Per-tenant cap: plan concurrency; the owner tenant is only bounded by the global budget (single-tenant behaviour). */
  tenantConcurrency(tid: number): number {
    const t = getTenant(tid);
    const plan = effectivePlan(t);
    return plan === 'owner' ? this.concurrency : Math.min(this.concurrency, PLANS[plan].concurrency);
  }

  start() {
    // Requeue anything that was mid-flight when the process died.
    db().prepare("UPDATE items SET queue_state = 'queued' WHERE queue_state = 'running'").run();
    db().prepare("UPDATE items SET analysis_status = 'pending' WHERE analysis_status = 'running'").run();
    this.timer = setInterval(() => this.tick(), 1500);
    this.kick();
  }
  stop() { this.stopping = true; if (this.timer) clearInterval(this.timer); }
  kick() { setImmediate(() => this.tick()); }

  status(tid: number) {
    const d = db();
    const counts = d.prepare(`SELECT
        SUM(CASE WHEN queue_state = 'queued' THEN 1 ELSE 0 END) AS queued,
        SUM(CASE WHEN queue_state = 'running' THEN 1 ELSE 0 END) AS running,
        SUM(CASE WHEN analysis_status = 'done' THEN 1 ELSE 0 END) AS analyzed,
        SUM(CASE WHEN analysis_status = 'failed' THEN 1 ELSE 0 END) AS failed,
        SUM(CASE WHEN analysis_status = 'skipped' THEN 1 ELSE 0 END) AS skipped,
        SUM(CASE WHEN analysis_status = 'pending' AND queue_state = 'idle' THEN 1 ELSE 0 END) AS unqueued_pending,
        COUNT(*) AS total
      FROM items WHERE tenant_id = ? AND archived = 0`).get(tid) as any;
    const plan = effectivePlan(getTenant(tid));
    const quota = plan === 'owner' ? null : checkQuota(tid, 'analyze');
    const credits = plan === 'owner' ? 0 : creditBalance(tid);
    // Nothing will move until the tenant upgrades or buys credits — the saves stay pending, they are never dropped.
    const stalled = !!quota && !quota.ok;
    const waiting = (counts.queued || 0) + (counts.unqueued_pending || 0);
    return {
      paused: this.isPaused(tid),
      pauseReason: this.pauseReason(tid),
      concurrency: this.tenantConcurrency(tid),
      openaiConfigured: hasOpenAI(tid),
      queued: counts.queued || 0,
      running: counts.running || 0,
      analyzed: counts.analyzed || 0,
      failed: counts.failed || 0,
      skipped: counts.skipped || 0,
      pending: counts.unqueued_pending || 0,
      total: counts.total || 0,
      runningIds: Array.from(this.running.entries()).filter(([, t]) => t === tid).map(([id]) => id),
      processedSinceBoot: this.processed.get(tid) || 0,
      failedSinceBoot: this.failed.get(tid) || 0,
      lastError: this.lastErrors.get(tid) || null,
      recent: this.recent.filter((r) => r.tid === tid).slice(-12).reverse().map(({ tid: _t, ...r }) => r),
      startedAt: this.startedAt,
      plan,
      // hosted: how much analysis allowance is left (null = unlimited)
      quota: quota ? { used: quota.used, limit: Number.isFinite(quota.limit) ? quota.limit : null, remaining: Number.isFinite(quota.remaining) ? quota.remaining : null, resetsAt: quota.resetsAt, ok: quota.ok, okAllowance: quota.okAllowance, wouldUseCredits: quota.wouldUseCredits } : null,
      planBlocked: plan === 'free' && !(quota && quota.ok),
      // credits: what is left, and how many saves are waiting because both the allowance and the credits are gone
      credits,
      creditsUsable: plan === 'owner' ? null : creditUnitsAvailable(tid, 'analyze'),
      blocked: stalled,
      blockedPending: stalled ? waiting : 0,
      blockedReason: stalled ? (plan === 'free' ? 'plan' : 'allowance') : null,
    };
  }

  /**
   * Remaining analysis allowance for a tenant, minus what is already queued/running (so repeated queueing never
   * over-commits). Credits extend the allowance: one credit = one more save analyzed.
   */
  private allowance(tid: number): { remaining: number; quota: QuotaCheck | null } {
    const q = checkQuota(tid, 'analyze');
    if (q.limit === Infinity) return { remaining: Infinity, quota: null };
    const inFlight = (db().prepare("SELECT COUNT(*) AS n FROM items WHERE tenant_id = ? AND queue_state IN ('queued','running')").get(tid) as any).n as number;
    return { remaining: Math.max(0, q.remaining + creditUnitsAvailable(tid, 'analyze') - inFlight), quota: q };
  }

  /**
   * Queue items by ids, or by selector. All selectors respect the analysis scope (date window, media types)
   * and never touch excluded/archived saves; explicit ids are queued as-is (user intent).
   * Only up to the tenant's remaining analysis allowance is queued — newest saves first; the rest is reported as `leftOut`.
   */
  enqueue(tid: number, ids: string[] | 'pending' | 'failed' | 'all' | 'eligible', opts: { force?: boolean } = {}): EnqueueResult {
    const d = db();
    const t = now();
    const w = scopeWhereSql(getScope(tid));
    const { remaining, quota } = this.allowance(tid);
    let queued = 0, leftOut = 0;

    if (Array.isArray(ids)) {
      const sel = d.prepare(`SELECT id FROM items WHERE id = ? AND tenant_id = ? AND queue_state = 'idle' AND excluded = 0`);
      let candidates = ids.filter((id) => !!sel.get(id, tid));
      if (remaining !== Infinity && candidates.length > remaining) {
        // newest first: order the candidate ids by rank/date, keep the top `remaining`
        const rank = d.prepare('SELECT saved_rank, saved_at, created_at FROM items WHERE id = ?');
        const keyed = candidates.map((id) => ({ id, r: rank.get(id) as { saved_rank: number | null; saved_at: number | null; created_at: number } }));
        keyed.sort((a, b) => (a.r.saved_rank === null ? 1 : 0) - (b.r.saved_rank === null ? 1 : 0) || (a.r.saved_rank ?? 0) - (b.r.saved_rank ?? 0) || (b.r.saved_at ?? 0) - (a.r.saved_at ?? 0) || b.r.created_at - a.r.created_at);
        candidates = keyed.slice(0, remaining).map((k) => k.id);
        leftOut = keyed.length - candidates.length;
      }
      const stmt = d.prepare(`UPDATE items SET queue_state = 'queued', queued_at = ?${opts.force ? ", analysis_status = 'pending', analysis_error = NULL" : ''} WHERE id = ? AND tenant_id = ? AND queue_state = 'idle' AND excluded = 0`);
      d.transaction(() => { for (const id of candidates) queued += stmt.run(t, id, tid).changes; })();
    } else {
      const cond = ids === 'failed' ? "analysis_status IN ('failed','skipped')" : ids === 'all' ? '1 = 1' : "analysis_status IN ('pending')";
      const setSql = ids === 'failed'
        ? "queue_state = 'queued', queued_at = ?, analysis_status = 'pending', analysis_error = NULL, media_status = CASE WHEN media_status IN ('failed','expired') THEN 'pending' ELSE media_status END"
        : ids === 'all' ? "queue_state = 'queued', queued_at = ?, analysis_status = 'pending'" : "queue_state = 'queued', queued_at = ?";
      const where = `queue_state = 'idle' AND tenant_id = ? AND ${w.sql} AND ${cond}`;
      if (remaining === Infinity) {
        queued = d.prepare(`UPDATE items SET ${setSql} WHERE ${where}`).run(t, tid, ...w.params).changes;
      } else {
        const all = d.prepare(`SELECT id FROM items WHERE ${where} ORDER BY ${NEWEST_FIRST}`).all(tid, ...w.params) as Array<{ id: string }>;
        const take = all.slice(0, remaining);
        leftOut = all.length - take.length;
        const upd = d.prepare(`UPDATE items SET ${setSql} WHERE id = ? AND queue_state = 'idle'`);
        d.transaction(() => { for (const r of take) queued += upd.run(t, r.id).changes; })();
      }
    }
    this.kick();
    return { queued, leftOut, quota };
  }

  /** Items that failed only because OpenAI ran out of credits are not really failed: put them back to pending. */
  resetQuotaFailures(tid: number): number {
    const d = db();
    const n = d.prepare("UPDATE items SET analysis_status = 'pending', analysis_error = NULL WHERE tenant_id = ? AND analysis_status = 'failed' AND (analysis_error LIKE '%429%' OR analysis_error LIKE '%quota%' OR analysis_error LIKE '%credits%')").run(tid).changes;
    d.prepare("UPDATE items SET media_status = 'pending', media_error = NULL WHERE tenant_id = ? AND media_status IN ('partial','failed') AND (media_error LIKE '%429%' OR media_error LIKE '%quota%' OR media_error LIKE '%credits%')").run(tid);
    return n;
  }

  dequeueAll(tid: number): number {
    return db().prepare("UPDATE items SET queue_state = 'idle' WHERE tenant_id = ? AND queue_state = 'queued'").run(tid).changes;
  }

  /** Smooth weighted round-robin (nginx-style): every candidate gains its weight, the max wins and pays the total. */
  private pickTenant(cands: Array<{ tid: number; weight: number }>): number | null {
    let total = 0;
    let best: { tid: number; cur: number } | null = null;
    for (const c of cands) {
      const cur = (this.rrCurrent.get(c.tid) || 0) + c.weight;
      this.rrCurrent.set(c.tid, cur);
      total += c.weight;
      if (!best || cur > best.cur) best = { tid: c.tid, cur };
    }
    if (!best) return null;
    this.rrCurrent.set(best.tid, best.cur - total);
    if (this.rrCurrent.size > 5000) this.rrCurrent.clear();
    return best.tid;
  }

  private tick() {
    if (this.stopping || this.globalPaused) return;
    let free = this.concurrency - this.running.size;
    if (free <= 0) return;
    const d = db();
    const rows = d.prepare("SELECT tenant_id AS tid, COUNT(*) AS n FROM items WHERE queue_state = 'queued' AND excluded = 0 GROUP BY tenant_id").all() as Array<{ tid: number; n: number }>;
    if (!rows.length) return;
    const runningPer = new Map<number, number>();
    for (const t of this.running.values()) runningPer.set(t, (runningPer.get(t) || 0) + 1);

    const cands: Array<{ tid: number; weight: number; capacity: number }> = [];
    for (const r of rows) {
      const tid = r.tid;
      if (!hasOpenAI(tid)) continue; // nothing useful to do without a key (media-only fetch is still triggered by import)
      if (getMeta(tid, 'worker_paused') === '1') continue;
      const tenant = getTenant(tid);
      if (!tenant || tenant.deleted_at) continue;
      const plan = effectivePlan(tenant);
      const cap = plan === 'owner' ? Infinity : PLANS[plan].concurrency;
      const here = runningPer.get(tid) || 0;
      if (here >= cap) continue;
      if (budgetExhausted(tid)) { if (this.pauseReason(tid) !== 'budget') this.pause(tid, 'budget'); continue; }
      // Allowance first, then credits. With neither (expired trial, lapsed subscription, month used up and no credits)
      // the items simply stay queued/pending until the tenant upgrades or tops up — nothing is failed or dropped.
      const q = checkQuota(tid, 'analyze');
      if (!q.ok) continue;
      const budget = q.limit === Infinity ? Infinity : q.remaining + creditUnitsAvailable(tid, 'analyze');
      cands.push({ tid, weight: PLAN_WEIGHTS[plan] || 1, capacity: Math.min(cap - here, budget, r.n) });
    }
    // Newest saves first (saved_rank asc), never excluded ones. `run()` flips queue_state synchronously, so re-selecting is safe.
    const next = d.prepare("SELECT id FROM items WHERE tenant_id = ? AND queue_state = 'queued' AND excluded = 0 ORDER BY saved_rank ASC, queued_at ASC LIMIT 1");
    while (free > 0 && cands.length) {
      const tid = this.pickTenant(cands);
      if (tid === null) break;
      const idx = cands.findIndex((c) => c.tid === tid);
      const row = next.get(tid) as { id: string } | undefined;
      if (!row) { cands.splice(idx, 1); continue; }
      this.run(row.id, tid);
      free--;
      cands[idx].capacity--;
      if (cands[idx].capacity <= 0) cands.splice(idx, 1);
    }
  }

  private async run(id: string, tid: number) {
    if (this.running.has(id)) return;
    this.running.set(id, tid);
    const before = db().prepare('SELECT analyzed_at FROM items WHERE id = ?').get(id) as { analyzed_at: number | null } | undefined;
    db().prepare("UPDATE items SET queue_state = 'running' WHERE id = ?").run(id);
    const t0 = Date.now();
    let ok = true;
    let note: string | undefined;
    try {
      await processItem(id);
      const st = db().prepare('SELECT analysis_status, analysis_error, analyzed_at FROM items WHERE id = ?').get(id) as any;
      ok = st?.analysis_status === 'done';
      note = ok ? undefined : st?.analysis_error || st?.analysis_status;
      if (ok && st?.analyzed_at && st.analyzed_at !== (before?.analyzed_at ?? null)) chargeMetered(tid, 'analyze', 1, `item:${id}`);
      if (!ok) { this.failed.set(tid, (this.failed.get(tid) || 0) + 1); this.lastErrors.set(tid, note || ''); } else this.processed.set(tid, (this.processed.get(tid) || 0) + 1);
    } catch (e: any) {
      ok = false;
      note = String(e?.message || e);
      this.lastErrors.set(tid, note);
      if (e instanceof QuotaError) {
        // Out of credits: keep the item queued, pause with a clear reason (globally when the shared key is used). Nothing is marked failed.
        this.pause(tid, 'quota');
        db().prepare("UPDATE items SET queue_state = 'queued' WHERE id = ?").run(id);
        this.running.delete(id);
        this.pushRecent({ tid, id, ok: false, at: now(), ms: Date.now() - t0, note: 'paused: OpenAI credits exhausted' });
        return;
      }
      this.failed.set(tid, (this.failed.get(tid) || 0) + 1);
      db().prepare("UPDATE items SET analysis_status = CASE WHEN analysis_status = 'done' THEN 'done' ELSE 'failed' END, analysis_error = ? WHERE id = ?").run(note.slice(0, 500), id);
    } finally {
      if (this.running.has(id)) {
        db().prepare("UPDATE items SET queue_state = 'idle' WHERE id = ?").run(id);
        this.running.delete(id);
        this.pushRecent({ tid, id, ok, at: now(), ms: Date.now() - t0, note });
        // Rate-limit backoff: if the last 3 all failed with 429-ish errors, take a breather.
        const last3 = this.recent.slice(-3);
        if (last3.length === 3 && last3.every((r) => !r.ok && /429|rate limit/i.test(r.note || ''))) setTimeout(() => this.kick(), 30_000);
        else this.kick();
      }
    }
  }

  private pushRecent(r: Worker['recent'][number]) {
    this.recent.push(r);
    if (this.recent.length > 200) this.recent.shift();
  }
}

export const worker = new Worker();
