/**
 * Plans, limits and quotas (hosted mode). In single-tenant mode tenant 1 is on the 'owner' plan (unlimited),
 * so nothing here ever blocks the open-source app.
 */
import type { Context } from 'hono';
import { config } from '../config.js';
import { db, now } from '../db.js';
import type { PlanId, TenantRow } from '../types.js';
import { CREDIT_EXPLAINER, CREDIT_RATES, creditBalance, creditPacks, creditUnitsAvailable, creditsForUnits, creditsPayload, isCreditMetric, spendCredits, type CreditMetric } from './credits.js';
import { paywallEnabled, paywallState, trialPriceIds } from './paywall.js';

export type { PlanId };

export interface Limits {
  analyzeTotal: number;
  analyzePerMonth: number;
  askPerMonth: number;
  askPerMinute: number;
  rules: number;
  sendsPerMonth: number;
  harvestsPerDay: number;
  graphNodes: number;
  concurrency: number;
}

export const PLANS: Record<PlanId, Limits> = {
  owner:  { analyzeTotal: Infinity, analyzePerMonth: Infinity, askPerMonth: Infinity, askPerMinute: 30, rules: Infinity, sendsPerMonth: Infinity, harvestsPerDay: Infinity, graphNodes: 6000, concurrency: 4 },
  trial:  { analyzeTotal: 100,   analyzePerMonth: 100,  askPerMonth: 20,   askPerMinute: 4,  rules: 1,        sendsPerMonth: 100,   harvestsPerDay: 3,  graphNodes: 300,  concurrency: 1 },
  free:   { analyzeTotal: 100,   analyzePerMonth: 0,    askPerMonth: 5,    askPerMinute: 2,  rules: 1,        sendsPerMonth: 0,     harvestsPerDay: 1,  graphNodes: 300,  concurrency: 1 }, // after trial expiry: browse + export only
  pro:    { analyzeTotal: 2000,  analyzePerMonth: 300,  askPerMonth: 300,  askPerMinute: 8,  rules: 10,       sendsPerMonth: 5000,  harvestsPerDay: 20, graphNodes: 3000, concurrency: 2 },
  studio: { analyzeTotal: 10000, analyzePerMonth: 2000, askPerMonth: 1500, askPerMinute: 15, rules: Infinity, sendsPerMonth: 25000, harvestsPerDay: 50, graphNodes: 6000, concurrency: 4 },
};

/** Public price list (USD). Yearly is billed once a year; `year / 12` is what the pricing page shows as the monthly equivalent. */
export const PRICES = {
  pro: { month: 19, year: 144 },
  studio: { month: 49, year: 348 },
} as const;

/** Monthly equivalent of the yearly price, and how much less that is than paying monthly (rounded, for copy). */
export function yearlyMath(p: { month: number; year: number }) {
  return { perMonth: Math.round((p.year / 12) * 100) / 100, savePercent: Math.round((1 - p.year / (p.month * 12)) * 100) };
}

export const PLAN_NAMES: Record<PlanId, string> = { owner: 'Owner', trial: 'Trial', free: 'Free', pro: 'Pro', studio: 'Studio' };

/** Fair-scheduling weights for the analysis worker (studio 3 : pro 2 : trial 1). */
export const PLAN_WEIGHTS: Record<PlanId, number> = { owner: 3, studio: 3, pro: 2, trial: 1, free: 0 };

const GRACE_SECONDS = 7 * 86400;

/* ---------------- tenants ---------------- */

export function getTenant(tid: number): TenantRow | undefined {
  return db().prepare('SELECT * FROM tenants WHERE id = ?').get(tid) as TenantRow | undefined;
}

export function updateTenant(tid: number, patch: Partial<Omit<TenantRow, 'id' | 'created_at'>>) {
  const keys = Object.keys(patch) as Array<keyof typeof patch>;
  if (!keys.length) return;
  const sets = keys.map((k) => `${k} = @${k}`).join(', ');
  db().prepare(`UPDATE tenants SET ${sets}, updated_at = @__now WHERE id = @__id`).run({ ...patch, __now: now(), __id: tid });
}

/**
 * The plan that actually applies right now: 'trial' becomes 'free' after trial_ends_at; a paid plan whose subscription is
 * past_due/paused/canceled keeps working for a 7-day grace period after the last paid period, then becomes 'free'.
 */
export function effectivePlan(t: TenantRow | undefined, nowSec = now()): PlanId {
  if (!t || t.deleted_at) return 'free';
  if (t.plan === 'owner') return 'owner';
  if (t.plan === 'trial') return t.trial_ends_at !== null && t.trial_ends_at < nowSec ? 'free' : 'trial';
  if (t.plan === 'pro' || t.plan === 'studio') {
    if (t.plan_status === 'past_due' || t.plan_status === 'paused' || t.plan_status === 'canceled') {
      const until = (t.plan_renews_at || t.plan_started_at || 0) + GRACE_SECONDS;
      if (nowSec > until) return 'free';
    }
    return t.plan;
  }
  return 'free';
}

export function effectivePlanFor(tid: number): PlanId {
  return effectivePlan(getTenant(tid));
}

export function limitsFor(tid: number): Limits {
  return PLANS[effectivePlanFor(tid)];
}

/* ---------------- usage ---------------- */

export type Metric = 'analyze' | 'ask' | 'sends' | 'harvests' | 'rules';

const monthKey = (d = new Date()) => d.toISOString().slice(0, 7);
const dayKey = (d = new Date()) => d.toISOString().slice(0, 10);
function nextMonthStart(): number { const d = new Date(); return Math.floor(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1) / 1000); }
function nextDayStart(): number { const d = new Date(); return Math.floor(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1) / 1000); }

export function usageCount(tid: number, metric: Metric, period: string): number {
  const r = db().prepare('SELECT count FROM usage WHERE tenant_id = ? AND period = ? AND metric = ?').get(tid, period, metric) as { count: number } | undefined;
  return r?.count || 0;
}

/** Record consumption. `analyze` counts against both the lifetime total and the current month. */
export function bumpUsage(tid: number, metric: Metric, n = 1) {
  if (n <= 0) return;
  const periods = metric === 'analyze' ? ['total', monthKey()] : metric === 'harvests' ? [dayKey()] : [monthKey()];
  const stmt = db().prepare('INSERT INTO usage (tenant_id, period, metric, count) VALUES (?, ?, ?, ?) ON CONFLICT(tenant_id, period, metric) DO UPDATE SET count = count + excluded.count');
  for (const p of periods) stmt.run(tid, p, metric, n);
  if (metric === 'ask') noteAsk(tid, n);
}

/** Per-minute sliding window for Ask (in memory; a restart just forgets the last minute). */
const askWindow = new Map<number, number[]>();
function noteAsk(tid: number, n = 1) {
  const t = Date.now();
  const arr = (askWindow.get(tid) || []).filter((x) => t - x < 60_000);
  for (let i = 0; i < n; i++) arr.push(t);
  askWindow.set(tid, arr);
  if (askWindow.size > 5000) for (const [k, v] of askWindow) if (!v.length || t - v[v.length - 1] > 60_000) askWindow.delete(k);
}
function asksLastMinute(tid: number): number {
  const t = Date.now();
  const arr = (askWindow.get(tid) || []).filter((x) => t - x < 60_000);
  askWindow.set(tid, arr);
  return arr.length;
}

export interface QuotaCheck {
  /** May this call go ahead? True when the plan allowance covers it OR the tenant has enough credits. */
  ok: boolean;
  /** True when the plan allowance alone covers it (no credits needed). */
  okAllowance: boolean;
  metric: Metric;
  plan: PlanId;
  used: number;
  limit: number; // Infinity = unlimited
  remaining: number;
  resetsAt: number | null; // epoch seconds, null = never
  /** which sub-limit is binding for the composite metrics (analyze: total|month; ask: month|minute) */
  window?: 'total' | 'month' | 'day' | 'minute';
  /** credit balance right now (0 when credits cannot pay for this metric) */
  creditsAvailable: number;
  /** how many units of this metric the balance could still pay for (0 for harvests/rules and the Ask rate limit) */
  creditUnitsAvailable: number;
  /** credits this call would consume on top of the allowance (0 when the allowance covers it) */
  creditsNeeded: number;
  /** the allowance is gone and this call would be paid with credits */
  wouldUseCredits: boolean;
}

/** Credits pay for analysis, Ask answers and automated replies — not for imports, rule slots or the Ask rate limit. */
function creditsApplyTo(metric: Metric, window: QuotaCheck['window']): CreditMetric | null {
  if (window === 'minute') return null;
  return isCreditMetric(metric) ? metric : null;
}

/**
 * Can this tenant consume `n` more units of `metric` right now?
 * analyze: lifetime total AND calendar month; ask: month AND per-minute; sends: month; harvests: day; rules: live row count.
 * When the allowance is exhausted, credits are considered (analyze / ask / sends only) — `ok` stays true while the
 * balance covers the shortfall, and `wouldUseCredits` says the call will be paid from the balance.
 */
export function checkQuota(tid: number, metric: Metric, n = 1): QuotaCheck {
  const plan = effectivePlanFor(tid);
  const lim = PLANS[plan];
  const mk = (used: number, limit: number, resetsAt: number | null, window: QuotaCheck['window']): QuotaCheck => {
    const remaining = limit === Infinity ? Infinity : Math.max(0, limit - used);
    const okAllowance = remaining >= n;
    const q: QuotaCheck = { ok: okAllowance, okAllowance, metric, plan, used, limit, remaining, resetsAt, window, creditsAvailable: 0, creditUnitsAvailable: 0, creditsNeeded: 0, wouldUseCredits: false };
    const cm = creditsApplyTo(metric, window);
    if (!cm || plan === 'owner') return q;
    q.creditsAvailable = creditBalance(tid);
    q.creditUnitsAvailable = creditUnitsAvailable(tid, cm);
    if (okAllowance) return q;
    const short = n - (remaining === Infinity ? n : remaining);
    q.creditsNeeded = creditsForUnits(tid, cm, short);
    if (q.creditUnitsAvailable >= short) { q.ok = true; q.wouldUseCredits = true; }
    return q;
  };
  switch (metric) {
    case 'analyze': {
      const total = mk(usageCount(tid, 'analyze', 'total'), lim.analyzeTotal, null, 'total');
      const month = mk(usageCount(tid, 'analyze', monthKey()), lim.analyzePerMonth, nextMonthStart(), 'month');
      return month.remaining < total.remaining ? month : total;
    }
    case 'ask': {
      const month = mk(usageCount(tid, 'ask', monthKey()), lim.askPerMonth, nextMonthStart(), 'month');
      if (!month.ok) return month;
      const minute = mk(asksLastMinute(tid), lim.askPerMinute, Math.floor(Date.now() / 1000) + 60, 'minute');
      return minute.ok ? month : minute;
    }
    case 'sends': return mk(usageCount(tid, 'sends', monthKey()), lim.sendsPerMonth, nextMonthStart(), 'month');
    case 'harvests': return mk(usageCount(tid, 'harvests', dayKey()), lim.harvestsPerDay, nextDayStart(), 'day');
    case 'rules': {
      const used = (db().prepare('SELECT COUNT(*) AS n FROM automation_rules WHERE tenant_id = ?').get(tid) as any).n as number;
      return mk(used, lim.rules, null, 'total');
    }
  }
}

/**
 * How much of the monthly (and, for analyze, lifetime) allowance is left — the per-minute Ask window is deliberately
 * not part of this: it is a rate limit, not an allowance, and credits must never look like a way around it.
 */
function allowanceRemaining(tid: number, metric: CreditMetric, plan: PlanId): number {
  const lim = PLANS[plan];
  const left = (limit: number, used: number) => (limit === Infinity ? Infinity : Math.max(0, limit - used));
  switch (metric) {
    case 'analyze': return Math.min(left(lim.analyzeTotal, usageCount(tid, 'analyze', 'total')), left(lim.analyzePerMonth, usageCount(tid, 'analyze', monthKey())));
    case 'ask': return left(lim.askPerMonth, usageCount(tid, 'ask', monthKey()));
    case 'sends': return left(lim.sendsPerMonth, usageCount(tid, 'sends', monthKey()));
  }
}

/**
 * Record `n` units of a metered action: the plan allowance first, the rest from credits.
 * Call it AFTER the work succeeded (the worker charges a save once it is analyzed, Ask charges the answer, automations
 * charge the reply that was actually sent). Returns what was taken; `ok:false` means neither allowance nor credits
 * covered it and the caller should treat the action as not permitted.
 */
export function chargeMetered(tid: number, metric: CreditMetric, n = 1, ref?: string | null): { ok: boolean; fromAllowance: number; fromCredits: number; creditsSpent: number; balance: number } {
  if (n <= 0) return { ok: true, fromAllowance: 0, fromCredits: 0, creditsSpent: 0, balance: creditBalance(tid) };
  const plan = effectivePlanFor(tid);
  if (plan === 'owner') { bumpUsage(tid, metric, n); return { ok: true, fromAllowance: n, fromCredits: 0, creditsSpent: 0, balance: 0 }; }
  const left = allowanceRemaining(tid, metric, plan);
  const fromAllowance = left === Infinity ? n : Math.max(0, Math.min(n, left));
  const fromCredits = n - fromAllowance;
  if (fromAllowance > 0) bumpUsage(tid, metric, fromAllowance);
  if (fromCredits > 0) {
    const spent = spendCredits(tid, metric, fromCredits, ref);
    if (!spent.ok) return { ok: false, fromAllowance, fromCredits: 0, creditsSpent: 0, balance: spent.balance };
    return { ok: true, fromAllowance, fromCredits, creditsSpent: spent.credits, balance: spent.balance };
  }
  return { ok: true, fromAllowance, fromCredits: 0, creditsSpent: 0, balance: creditBalance(tid) };
}

/** Human message for a 402. */
export function quotaMessage(q: QuotaCheck): string {
  const planName = q.plan === 'trial' ? 'your trial' : q.plan === 'free' ? 'the free tier' : `your ${PLAN_NAMES[q.plan]} plan`;
  const lim = q.limit === Infinity ? 'unlimited' : String(q.limit);
  switch (q.metric) {
    case 'analyze':
      if (q.plan === 'free') return 'Your trial has ended — analysis is paused. Upgrade to keep analyzing your saves (browsing and export keep working).';
      return q.window === 'month' ? `You've analyzed ${q.used} of ${lim} saves this month on ${planName}.` : `You've used all ${lim} analyzed saves included in ${planName}.`;
    case 'ask':
      return q.window === 'minute' ? `Slow down a little — ${lim} questions per minute on ${planName}.` : `You've used all ${lim} questions of ${planName} this month.`;
    case 'sends': return q.plan === 'free' ? 'Automations are paused after the trial. Upgrade to keep replying automatically.' : `You've sent ${q.used} of ${lim} automated replies this month on ${planName}.`;
    case 'harvests': return `You've imported ${q.used} of ${lim} times today on ${planName}. Try again tomorrow or upgrade.`;
    case 'rules': return `${planName[0].toUpperCase()}${planName.slice(1)} includes ${lim} automation rule${q.limit === 1 ? '' : 's'}. Upgrade to add more.`;
  }
}

/**
 * The `credits` block of a 402: what the tenant has, what this call would cost, and what they can buy.
 * `needed = 0` with `eligible = false` means credits cannot help here (imports, rule slots, the Ask rate limit) —
 * upgrading is the only way forward.
 */
export function creditsFor402(tid: number, q: QuotaCheck) {
  const cm = q.window === 'minute' ? null : isCreditMetric(q.metric) ? q.metric : null;
  const short = q.limit === Infinity ? 0 : Math.max(1, 1 - q.remaining);
  return {
    balance: creditBalance(tid),
    needed: cm ? Math.max(q.creditsNeeded, creditsForUnits(tid, cm, short)) : 0,
    eligible: !!cm,
    rates: { ...CREDIT_RATES },
    explainer: CREDIT_EXPLAINER,
    packs: creditPacks(),
  };
}

/** HTTP 402 payload for the web's upgrade modal. */
export function quotaResponse(c: Context, q: QuotaCheck, tid?: number) {
  const t = tid ?? (c.get('tenant') as { tid: number } | undefined)?.tid ?? 0;
  return c.json({
    error: quotaMessage(q), code: 'quota', metric: q.metric, window: q.window ?? null,
    used: q.used, limit: finite(q.limit), remaining: finite(q.remaining), resetsAt: q.resetsAt, plan: q.plan, upgrade: true,
    credits: creditsFor402(t, q),
  }, 402);
}

/** JSON can't carry Infinity: unlimited limits are serialized as null. */
export function finite(n: number): number | null { return Number.isFinite(n) ? n : null; }
function jsonLimits(l: Limits): Record<keyof Limits, number | null> {
  const out = {} as Record<keyof Limits, number | null>;
  for (const k of Object.keys(l) as Array<keyof Limits>) out[k] = finite(l[k]);
  return out;
}

/* ---------------- payloads ---------------- */

export function paddlePublic() {
  // `trialPrices` are the same prices with Paddle's free period on them — signup checkout uses those, an upgrade uses `prices`.
  return { env: config.paddle.env, clientToken: config.paddle.clientToken || null, prices: { ...config.paddle.prices }, trialPrices: trialPriceIds() };
}

/** `GET /api/plan` */
export function planPayload(tid: number) {
  const t = getTenant(tid);
  const plan: PlanId = t?.plan || 'free';
  const eff = effectivePlan(t);
  const lim = PLANS[eff];
  const meter = (used: number, limit: number) => ({ used, limit: finite(limit) });
  const analyzeTotal = usageCount(tid, 'analyze', 'total');
  const analyzeMonth = usageCount(tid, 'analyze', monthKey());
  const rules = (db().prepare('SELECT COUNT(*) AS n FROM automation_rules WHERE tenant_id = ?').get(tid) as any).n as number;
  return {
    tenantId: tid,
    plan,
    effectivePlan: eff,
    planName: PLAN_NAMES[eff],
    status: t?.plan_status || 'active',
    trialEndsAt: t?.trial_ends_at ?? null,
    trialDaysLeft: t?.plan === 'trial' && t.trial_ends_at ? Math.max(0, Math.ceil((t.trial_ends_at - now()) / 86400)) : null,
    renewsAt: t?.plan_renews_at ?? null,
    cancelledAt: t?.cancelled_at ?? null,
    limits: jsonLimits(lim),
    usage: {
      analyze: meter(analyzeTotal, lim.analyzeTotal),
      analyzeMonth: meter(analyzeMonth, lim.analyzePerMonth),
      ask: meter(usageCount(tid, 'ask', monthKey()), lim.askPerMonth),
      sends: meter(usageCount(tid, 'sends', monthKey()), lim.sendsPerMonth),
      rules: meter(rules, lim.rules),
      harvests: meter(usageCount(tid, 'harvests', dayKey()), lim.harvestsPerDay),
    },
    resets: { month: nextMonthStart(), day: nextDayStart() },
    credits: creditsPayload(tid, 20),
    paywall: paywallState(tid), // the web polls this after checkout until the Paddle webhook lands
    paddle: { ...paddlePublic(), customData: { tenant_id: tid } },
    canManage: !!(t?.paddle_customer_id && config.paddle.apiKey),
    hosted: config.hosted,
  };
}

/** `GET /api/plans` — public catalog for the landing/pricing page. */
export function planCatalog() {
  const p = config.paddle.prices;
  const pro = yearlyMath(PRICES.pro);
  const studio = yearlyMath(PRICES.studio);
  return {
    currency: 'USD',
    trialDays: config.trialDays,
    hosted: config.hosted,
    signupsEnabled: config.signupsEnabled,
    /**
     * Is a card taken before the free days start on this server (ROUND7 §1)? The landing, pricing, signup and login
     * pages all used to say "no card" unconditionally, which stopped being true the moment the paywall came on — the
     * exact class of promise this round exists to remove. It is the live `paywallEnabled()` answer, not the raw flag,
     * so a deploy whose Paddle env is incomplete advertises the truth (no card) rather than the intent.
     */
    trialRequiresCard: paywallEnabled(),
    paddle: { env: config.paddle.env, clientToken: config.paddle.clientToken || null },
    plans: [
      { id: 'trial', name: 'Trial', tagline: `${config.trialDays} days free`, priceMonth: 0, priceYear: 0, priceYearPerMonth: 0, yearSavePercent: 0, priceIds: { month: null, year: null }, limits: jsonLimits(PLANS.trial) },
      { id: 'pro', name: 'Pro', tagline: 'For serious savers', priceMonth: PRICES.pro.month, priceYear: PRICES.pro.year, priceYearPerMonth: pro.perMonth, yearSavePercent: pro.savePercent, priceIds: { month: p.proMonth || null, year: p.proYear || null }, limits: jsonLimits(PLANS.pro) },
      { id: 'studio', name: 'Studio', tagline: 'For creators and teams of one', priceMonth: PRICES.studio.month, priceYear: PRICES.studio.year, priceYearPerMonth: studio.perMonth, yearSavePercent: studio.savePercent, priceIds: { month: p.studioMonth || null, year: p.studioYear || null }, limits: jsonLimits(PLANS.studio) },
      { id: 'free', name: 'Free', tagline: 'After the trial: browse and export', priceMonth: 0, priceYear: 0, priceYearPerMonth: 0, yearSavePercent: 0, priceIds: { month: null, year: null }, limits: jsonLimits(PLANS.free) },
    ],
    credits: { rates: { ...CREDIT_RATES }, explainer: CREDIT_EXPLAINER, packs: creditPacks() },
  };
}

/** Map a Paddle price id to a plan (from env). */
export function planForPriceId(priceId: string | null | undefined): 'pro' | 'studio' | null {
  if (!priceId) return null;
  const p = config.paddle.prices;
  if (priceId === p.proMonth || priceId === p.proYear) return 'pro';
  if (priceId === p.studioMonth || priceId === p.studioYear) return 'studio';
  // Signup checkout buys the trial-enabled twin of the same plan; without this a card-first signup would stay on 'trial'.
  const tp = trialPriceIds();
  if (priceId === tp.proMonth || priceId === tp.proYear) return 'pro';
  if (priceId === tp.studioMonth || priceId === tp.studioYear) return 'studio';
  return null;
}
