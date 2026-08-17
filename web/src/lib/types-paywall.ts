/* Paywall — card at signup (ROUND7 §1).
 *
 * Wire contract (the server half lands in parallel):
 *   GET /api/paywall → { locked, reason, plans, trialDays, priceIds, credits }
 *   every other /api/* route answers 402 { code: 'payment_required' } while the lock is on.
 *
 * Every reader below is deliberately tolerant: a 404 (route not deployed yet), a missing field, or price
 * ids spelled `pro_month_trial` instead of `proMonth` must end in "not locked" or "checkout unavailable"
 * with a way forward — never a screen the person cannot leave.
 */
import type { PlanCatalogEntry, PlanId, PlansCatalog } from './types';
import { normalizeCatalog } from './plans';

export type PaidPlanId = Extract<PlanId, 'pro' | 'studio'>;
/** A catalog entry narrowed to a plan you can actually buy here. */
export type PaidPlanEntry = PlanCatalogEntry & { id: PaidPlanId };
export type BillingInterval = 'month' | 'year';
export const PAID_PLAN_IDS: readonly PaidPlanId[] = ['pro', 'studio'];

/** Raw body of GET /api/paywall. `credits` is the pack catalog (buying a pack also puts a card on file). */
export interface PaywallResponse {
  locked?: boolean;
  reason?: string | null;
  plans?: unknown;
  trialDays?: number;
  priceIds?: unknown;
  credits?: unknown;
  paddle?: { env?: string; clientToken?: string | null } | null;
}

export interface PaywallState {
  /** The endpoint answered at all — false means the server half isn't deployed on this server. */
  served: boolean;
  locked: boolean;
  reason: string | null;
  trialDays: number;
  /** Pro and Studio, in catalog order. */
  plans: PaidPlanEntry[];
  /** Trial-enabled Paddle price ids (the ones carrying `trial_period`), by plan and interval. */
  trialPriceIds: Record<PaidPlanId, Record<BillingInterval, string | null>>;
  paddle: { env: 'sandbox' | 'production'; clientToken: string | null } | null;
}

const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);

/** `true`/`false` when the payload says so, `null` when it doesn't say anything we recognise. */
export function readLocked(raw: unknown): boolean | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  for (const k of ['locked', 'required', 'paymentRequired', 'payment_required', 'requiresPayment', 'requires_payment']) {
    const v = o[k];
    if (typeof v === 'boolean') return v;
    if (v === 1 || v === 0) return v === 1;
  }
  return null;
}

/**
 * One price id out of whatever shape the server used: `proMonthTrial`, `proMonth`, `pro_month_trial`,
 * `{ pro: { monthTrial } }`, or the same nested under `trial` / `trialPrices` / `prices`.
 */
export function pickTrialPriceId(raw: unknown, plan: PaidPlanId, iv: BillingInterval): string | null {
  const roots: unknown[] = [];
  const push = (v: unknown) => { if (v && typeof v === 'object') roots.push(v); };
  push(raw);
  if (raw && typeof raw === 'object') {
    const o = raw as Record<string, unknown>;
    push(o.trial); push(o.trialPrices); push(o.trial_prices); push(o.prices);
  }
  const cap = iv === 'year' ? 'Year' : 'Month';
  const flat = [`${plan}${cap}Trial`, `${plan}${cap}`, `${plan}_${iv}_trial`, `${plan}_${iv}`, `${plan}${cap}TrialPriceId`];
  const nestedKeys = [`${iv}Trial`, iv, `${iv}_trial`, `trial${cap}`];
  for (const root of roots) {
    const o = root as Record<string, unknown>;
    for (const k of flat) { const v = str(o[k]); if (v) return v; }
    const nested = o[plan];
    if (nested && typeof nested === 'object') {
      const n = nested as Record<string, unknown>;
      for (const k of nestedKeys) { const v = str(n[k]); if (v) return v; }
    }
  }
  return null;
}

const EMPTY_PRICE_IDS = (): Record<PaidPlanId, Record<BillingInterval, string | null>> => ({
  pro: { month: null, year: null },
  studio: { month: null, year: null },
});

/**
 * `raw = null` means the endpoint 404'd (server half not deployed) → not locked, so nobody is trapped
 * on /start by a missing route. The public catalog fills in plans and prices the payload leaves out.
 */
export function normalizePaywall(raw: PaywallResponse | null | undefined, catalog: PlansCatalog): PaywallState {
  const served = !!raw && typeof raw === 'object';
  const src = (served ? raw : {}) as PaywallResponse;
  const trialDays = Number.isFinite(Number(src.trialDays)) && Number(src.trialDays) > 0 ? Math.round(Number(src.trialDays)) : catalog.trialDays;
  const merged = Array.isArray(src.plans) && src.plans.length ? normalizeCatalog({ plans: src.plans, trialDays }) : catalog;
  const plans = merged.plans.filter((p): p is PaidPlanEntry => p.id === 'pro' || p.id === 'studio');
  const trialPriceIds = EMPTY_PRICE_IDS();
  for (const plan of PAID_PLAN_IDS) {
    for (const iv of ['month', 'year'] as const) trialPriceIds[plan][iv] = pickTrialPriceId(src.priceIds ?? src, plan, iv);
  }
  const env = src.paddle?.env === 'production' ? 'production' : src.paddle?.env === 'sandbox' ? 'sandbox' : null;
  return {
    served,
    locked: readLocked(src) === true,
    reason: str(src.reason),
    trialDays,
    plans,
    trialPriceIds,
    paddle: env ? { env, clientToken: str(src.paddle?.clientToken) } : null,
  };
}

export const hasTrialPrice = (s: PaywallState, plan: PaidPlanId, iv: BillingInterval): boolean => !!s.trialPriceIds[plan][iv];

/** The server's `reason` is a machine code (`no_card`, `cleared`, …), so it never reaches the screen unread. */
const REASON_TEXT: Record<string, (trialDays: number) => string> = {
  no_card: (d) => `Your account is created. Add a card and your ${d} free day${d === 1 ? '' : 's'} start — nothing is charged today.`,
  cleared: () => 'Your card is on file, so everything is open.',
  paid: () => 'Your subscription is active. Manage or cancel it any time from Billing.',
  owner: () => 'Owner account — no card needed.',
  disabled: () => 'This server does not ask for a card.',
  not_required: () => 'This account was created before we started asking for a card at signup, so nothing changes for you.',
};

/** A readable sentence, or null: an unknown code says nothing rather than showing the person a token. */
export function reasonLine(reason: string | null | undefined, trialDays: number): string | null {
  if (!reason) return null;
  const known = REASON_TEXT[reason];
  if (known) return known(trialDays);
  return /^[a-z0-9_.-]+$/.test(reason) ? null : reason;
}

/** Paddle bills at the end of the free period, so: today + trialDays. */
export function firstChargeDate(trialDays: number, from: Date = new Date()): Date {
  const d = new Date(from.getTime());
  d.setDate(d.getDate() + Math.max(0, Math.round(trialDays)));
  return d;
}

export const fmtChargeDate = (d: Date): string => d.toLocaleDateString(undefined, { day: 'numeric', month: 'long', year: 'numeric' });

const amountFor = (plan: PlanCatalogEntry | undefined, iv: BillingInterval): number | null => {
  const n = iv === 'year' ? plan?.yearly : plan?.monthly;
  return typeof n === 'number' && Number.isFinite(n) ? n : null;
};

/** "First charge: $19 on 20 August 2026, then every month." — the exact date, computed here, not promised vaguely. */
export function chargeLine(plan: PlanCatalogEntry | undefined, iv: BillingInterval, trialDays: number, from?: Date): string {
  const when = fmtChargeDate(firstChargeDate(trialDays, from));
  const amount = amountFor(plan, iv);
  const every = iv === 'year' ? 'every year' : 'every month';
  return amount === null ? `First charge on ${when}.` : `First charge: $${amount} on ${when}, then ${every}.`;
}

/** Same line for the honest fallback when this deploy has no trial-enabled price: the card is charged today. */
export function chargeTodayLine(plan: PlanCatalogEntry | undefined, iv: BillingInterval): string {
  const amount = amountFor(plan, iv);
  const every = iv === 'year' ? 'every year' : 'every month';
  return amount === null ? 'Charged today.' : `$${amount} today, then ${every}.`;
}
