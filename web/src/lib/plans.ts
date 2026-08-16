/* Plan / quota helpers shared by the Shell banner, Billing page, UpgradeModal, Landing pricing (HOSTED-SPEC §4, §7). */
import type { Limit, Limits, PlanCatalogEntry, PlanId, PlansCatalog, QuotaError, UsageMeter } from './types';

export const isUnlimited = (l: Limit | undefined): boolean => l === null || l === undefined || !Number.isFinite(l);
export const fmtLimit = (l: Limit | undefined): string => (isUnlimited(l) ? '∞' : (l as number).toLocaleString());
export const meterPct = (m: UsageMeter | undefined): number => (!m || isUnlimited(m.limit) ? 0 : Math.max(0, Math.min(100, Math.round((m.used / Math.max(1, m.limit as number)) * 100))));
export const meterFull = (m: UsageMeter | undefined): boolean => !!m && !isUnlimited(m.limit) && m.used >= (m.limit as number);
export const meterRemaining = (m: UsageMeter | undefined): number => (!m ? 0 : isUnlimited(m.limit) ? Number.POSITIVE_INFINITY : Math.max(0, (m.limit as number) - m.used));

/** Server timestamps are unix seconds everywhere; be tolerant of milliseconds anyway. */
export const toMs = (t: number | null | undefined): number | null => (t === null || t === undefined ? null : t > 1e12 ? t : t * 1000);
export const daysLeft = (t: number | null | undefined): number | null => { const ms = toMs(t); return ms === null ? null : Math.max(0, Math.ceil((ms - Date.now()) / 86_400_000)); };

export const PLAN_NAMES: Record<PlanId, string> = { owner: 'Owner', trial: 'Trial', free: 'Free', pro: 'Pro', studio: 'Studio' };
export const planName = (p: PlanId | string | null | undefined): string => (p && (PLAN_NAMES as any)[p]) || (p ? String(p) : '—');

/* Same numbers as server/src/services/plans.ts — used as the fallback catalog when /api/plans is unreachable. */
export const PLAN_LIMITS: Record<PlanId, Limits> = {
  owner: { analyzeTotal: null, analyzePerMonth: null, askPerMonth: null, askPerMinute: 30, rules: null, sendsPerMonth: null, harvestsPerDay: null, graphNodes: 6000, concurrency: 4 },
  trial: { analyzeTotal: 100, analyzePerMonth: 100, askPerMonth: 20, askPerMinute: 4, rules: 1, sendsPerMonth: 100, harvestsPerDay: 3, graphNodes: 300, concurrency: 1 },
  free: { analyzeTotal: 100, analyzePerMonth: 0, askPerMonth: 5, askPerMinute: 2, rules: 1, sendsPerMonth: 0, harvestsPerDay: 1, graphNodes: 300, concurrency: 1 },
  pro: { analyzeTotal: 2000, analyzePerMonth: 300, askPerMonth: 300, askPerMinute: 8, rules: 10, sendsPerMonth: 5000, harvestsPerDay: 20, graphNodes: 3000, concurrency: 2 },
  studio: { analyzeTotal: 10000, analyzePerMonth: 2000, askPerMonth: 1500, askPerMinute: 15, rules: null, sendsPerMonth: 25000, harvestsPerDay: 50, graphNodes: 6000, concurrency: 4 },
};
export const DEFAULT_CATALOG: PlansCatalog = {
  trialDays: 3,
  plans: [
    { id: 'trial', name: 'Trial', blurb: 'Try the whole thing on your newest 100 saves.', monthly: 0, yearly: 0, priceIds: { month: null, year: null }, limits: PLAN_LIMITS.trial },
    { id: 'pro', name: 'Pro', blurb: 'For one person with a real library.', monthly: 12, yearly: 99, priceIds: { month: null, year: null }, limits: PLAN_LIMITS.pro },
    { id: 'studio', name: 'Studio', blurb: 'For creators who save a lot and run DM automations.', monthly: 34, yearly: 290, priceIds: { month: null, year: null }, limits: PLAN_LIMITS.studio },
  ],
};

/** Accepts the catalog in a few plausible shapes (array or {plans}, price fields named a few ways) and fills gaps from DEFAULT_CATALOG. */
export function normalizeCatalog(raw: unknown): PlansCatalog {
  const src: any = raw && typeof raw === 'object' ? raw : {};
  const list: any[] = Array.isArray(src) ? src : Array.isArray(src.plans) ? src.plans : src.plans && typeof src.plans === 'object' ? Object.entries(src.plans).map(([id, v]: [string, any]) => ({ id, ...v })) : [];
  const num = (v: any): number | null => (v === null || v === undefined || v === '' ? null : Number.isFinite(Number(v)) ? Number(v) : null);
  const plans: PlanCatalogEntry[] = [];
  for (const d of DEFAULT_CATALOG.plans) {
    const p = list.find((x) => x && (x.id === d.id || String(x.name || '').toLowerCase() === d.id));
    if (!p) { plans.push(d); continue; }
    const monthly = num(p.monthly ?? p.priceMonth ?? p.month ?? p.prices?.month ?? p.prices?.monthly ?? p.price?.month ?? p.price?.monthly ?? p.usd?.month ?? p.usd?.monthly);
    const yearly = num(p.yearly ?? p.priceYear ?? p.year ?? p.prices?.year ?? p.prices?.yearly ?? p.price?.year ?? p.price?.yearly ?? p.usd?.year ?? p.usd?.yearly);
    const pm = p.priceIds?.month ?? p.priceIds?.monthly ?? p.paddle?.month ?? p.paddle?.monthly ?? p.priceIdMonth ?? null;
    const py = p.priceIds?.year ?? p.priceIds?.yearly ?? p.paddle?.year ?? p.paddle?.yearly ?? p.priceIdYear ?? null;
    plans.push({ id: d.id, name: p.name || d.name, blurb: p.blurb || p.description || d.blurb || p.tagline, monthly: monthly ?? d.monthly, yearly: yearly ?? d.yearly, priceIds: { month: pm ? String(pm) : null, year: py ? String(py) : null }, limits: { ...d.limits, ...(p.limits || {}) } });
  }
  return { trialDays: Number(src.trialDays ?? src.trial_days ?? DEFAULT_CATALOG.trialDays) || DEFAULT_CATALOG.trialDays, plans };
}

/** Bullet list for a pricing card, from limits. */
export function planFeatures(l: Limits): string[] {
  const f: string[] = [];
  f.push(`${fmtLimit(l.analyzeTotal)} saves analyzed in total`);
  if (!isUnlimited(l.analyzePerMonth) && (l.analyzePerMonth as number) > 0) f.push(`${fmtLimit(l.analyzePerMonth)} new saves analyzed / month`);
  f.push(`${fmtLimit(l.askPerMonth)} questions / month`);
  f.push(isUnlimited(l.rules) ? 'Unlimited automation rules' : `${fmtLimit(l.rules)} automation rule${l.rules === 1 ? '' : 's'}`);
  if (!isUnlimited(l.sendsPerMonth) && (l.sendsPerMonth as number) > 0) f.push(`${fmtLimit(l.sendsPerMonth)} automated replies / month`);
  else if (isUnlimited(l.sendsPerMonth)) f.push('Unlimited automated replies');
  f.push(`${fmtLimit(l.harvestsPerDay)} harvest${l.harvestsPerDay === 1 ? '' : 's'} / day`);
  f.push(`Graph up to ${fmtLimit(l.graphNodes)} nodes`);
  if (!isUnlimited(l.concurrency) && (l.concurrency as number) > 1) f.push(`${l.concurrency} parallel workers`);
  return f;
}

/** Human message for the UpgradeModal from a 402 body. */
export function quotaMessage(q: QuotaError | null | undefined): { title: string; body: string } {
  if (!q) return { title: 'Upgrade Resurfly', body: 'Analyze more saves, ask more questions, and run automations at scale.' };
  const plan = planName(q.plan);
  const lim = fmtLimit(q.limit);
  // The server reports the composite metric ('analyze' | 'ask') plus which sub-limit is binding in `window`.
  const metric = q.metric === 'analyze' && q.window === 'month' ? 'analyzeMonth' : q.metric === 'ask' && q.window === 'minute' ? 'askMinute' : q.metric;
  if (q.plan === 'free' && (metric === 'analyze' || metric === 'analyzeMonth' || metric === 'sends')) return { title: 'Your trial has ended', body: q.error || 'Upgrade to keep analyzing your saves and running automations. Browsing and export keep working.' };
  switch (metric) {
    case 'analyze': return { title: 'All saves in your allowance are analyzed', body: `Your ${plan} plan includes ${lim} analyzed saves${q.plan === 'trial' ? ' (the newest ones first)' : ''}. Upgrade to keep analyzing.` };
    case 'analyzeMonth': return { title: 'Monthly analysis allowance used', body: `Your ${plan} plan analyzes ${lim} new saves per month and you've used ${q.used.toLocaleString()}. Upgrade for a bigger monthly allowance.` };
    case 'ask': return { title: `You've used all ${lim} questions of your ${plan}`, body: q.plan === 'trial' ? `The trial includes ${lim} questions. Pro has 300 a month, Studio 1,500.` : `Your ${plan} plan includes ${lim} questions a month. Upgrade for more.` };
    case 'askMinute': case 'ask_minute': return { title: 'Slow down a little', body: q.error || 'Too many questions in one minute. Try again shortly.' };
    case 'rules': return { title: `Your ${plan} plan includes ${lim} automation rule${q.limit === 1 ? '' : 's'}`, body: 'Upgrade to Pro for 10 rules, or Studio for unlimited rules.' };
    case 'sends': return { title: 'Automated replies allowance used', body: `Your ${plan} plan sends up to ${lim} automated replies a month. Upgrade to keep replying.` };
    case 'harvests': return { title: 'Harvest limit for today reached', body: `Your ${plan} plan allows ${lim} harvest import${q.limit === 1 ? '' : 's'} a day. Upgrade for more, or try again tomorrow.` };
    default: return { title: 'Plan limit reached', body: q.error || 'Upgrade to continue.' };
  }
}

/* ---------------- Paddle overlay checkout ---------------- */
type PaddleInstance = import('@paddle/paddle-js').Paddle;
let paddleReady: Promise<PaddleInstance | undefined> | null = null;
let paddleKey = '';
const completedListeners = new Set<(data: any) => void>();
const closedListeners = new Set<() => void>();

/** initializePaddle() exactly once per (environment, token). The eventCallback fans out to listeners registered by openCheckout(). */
export async function getPaddle(env: 'sandbox' | 'production', token: string): Promise<PaddleInstance | undefined> {
  const key = `${env}:${token}`;
  if (!paddleReady || paddleKey !== key) {
    paddleKey = key;
    paddleReady = import('@paddle/paddle-js').then(({ initializePaddle }) => initializePaddle({
      environment: env, token,
      eventCallback: (ev) => {
        if (ev?.name === 'checkout.completed') completedListeners.forEach((fn) => fn(ev.data));
        if (ev?.name === 'checkout.closed') closedListeners.forEach((fn) => fn());
      },
    })).catch((e) => { paddleReady = null; throw e; }); // let the next click retry (ad blocker toggled off, network back)
  }
  return paddleReady;
}

export async function openCheckout(opts: { env: 'sandbox' | 'production'; token: string; priceId: string; tenantId: number | null; email: string | null; theme: 'light' | 'dark'; onCompleted: (data: any) => void; onClosed?: () => void }): Promise<void> {
  const paddle = await getPaddle(opts.env, opts.token);
  if (!paddle) throw new Error('Paddle.js failed to load (ad blocker or offline?)');
  const done = (d: any) => { completedListeners.delete(done); opts.onCompleted(d); };
  const closed = () => { closedListeners.delete(closed); completedListeners.delete(done); opts.onClosed?.(); };
  completedListeners.add(done);
  closedListeners.add(closed);
  paddle.Checkout.open({
    items: [{ priceId: opts.priceId, quantity: 1 }],
    customData: { tenant_id: opts.tenantId },
    ...(opts.email ? { customer: { email: opts.email } } : {}),
    settings: { displayMode: 'overlay', theme: opts.theme, allowLogout: false },
  });
}
