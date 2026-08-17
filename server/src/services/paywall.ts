/**
 * The signup paywall (ROUND7-SPEC §1): a card before the free days start.
 *
 * A tenant is *locked* when `tenants.requires_payment = 1` and no card has arrived yet. Locked tenants get HTTP 402
 * `{ code: 'payment_required' }` from every API route except the ones that let them pay, look at their plan, log out
 * or delete the account (see routes/paywall.ts).
 *
 * Two things must never happen:
 *   1. Somebody who signed up before the paywall existed meets a wall. Migration 009 backfills every existing tenant
 *      to 0 and nothing here ever sets it back to 1 — only a fresh signup starts at 1.
 *   2. A deploy whose Paddle env is incomplete locks everybody out with no way to pay. `paywallEnabled()` therefore
 *      requires all four trial price ids and turns itself off (loudly, once) when any is missing.
 *
 * Deliberately does not import ./plans.ts — plans imports this module, same layering as ./credits.ts.
 */
import { config } from '../config.js';
import { db, now } from '../db.js';
import type { TenantRow } from '../types.js';

export interface TrialPriceIds { proMonth: string; proYear: string; studioMonth: string; studioYear: string }

const TRIAL_PRICE_ENV: Record<keyof TrialPriceIds, string> = {
  proMonth: 'PADDLE_PRICE_PRO_MONTH_TRIAL',
  proYear: 'PADDLE_PRICE_PRO_YEAR_TRIAL',
  studioMonth: 'PADDLE_PRICE_STUDIO_MONTH_TRIAL',
  studioYear: 'PADDLE_PRICE_STUDIO_YEAR_TRIAL',
};

/**
 * The trial-enabled Paddle prices used by signup checkout. Read from the environment at call time (not captured at
 * import) so fixing the env of a running deploy takes effect immediately — the same idiom as credits.creditPacks().
 * config.ts has already folded .env into process.env by the time anything calls this.
 */
export function trialPriceIds(): TrialPriceIds {
  return {
    proMonth: process.env[TRIAL_PRICE_ENV.proMonth] || '',
    proYear: process.env[TRIAL_PRICE_ENV.proYear] || '',
    studioMonth: process.env[TRIAL_PRICE_ENV.studioMonth] || '',
    studioYear: process.env[TRIAL_PRICE_ENV.studioYear] || '',
  };
}

/** Env var names of the trial prices that are not configured. */
export function missingTrialPriceIds(): string[] {
  const ids = trialPriceIds();
  return (Object.keys(TRIAL_PRICE_ENV) as Array<keyof TrialPriceIds>).filter((k) => !ids[k]).map((k) => TRIAL_PRICE_ENV[k]);
}

/**
 * Everything that has to be present before it is safe to lock a signup out. The prices are what checkout buys, the
 * client token is what opens the Paddle overlay at all, and the webhook secret is what lifts the lock afterwards —
 * without it we would take a card and leave the person staring at the wall, which is worse than no paywall.
 * `PADDLE_API_KEY` is here for the same reason one step later: it is what `createPortalSession` needs, and without it
 * `plan.canManage` is false, the Billing page shows no cancel control at all, and "cancel any time, one click" becomes
 * a promise we made to somebody whose card we just took. Read from process.env at call time, like the prices.
 */
const REQUIRED_PAYWALL_ENV = ['PADDLE_CLIENT_TOKEN', 'PADDLE_WEBHOOK_SECRET', 'PADDLE_API_KEY'] as const;

export function missingPaywallConfig(): string[] {
  return [...missingTrialPriceIds(), ...REQUIRED_PAYWALL_ENV.filter((k) => !process.env[k])];
}

let warnedMissing = false;

/**
 * Is the paywall in force on this server? Off for self-hosters (TRIAL_REQUIRES_CARD defaults to HOSTED), and off —
 * however the flag is set — when anything a locked person would need in order to pay is not configured.
 */
export function paywallEnabled(): boolean {
  if (!config.trialRequiresCard) return false;
  const missing = missingPaywallConfig();
  if (!missing.length) return true;
  if (!warnedMissing) {
    warnedMissing = true;
    console.warn(`[paywall] TRIAL_REQUIRES_CARD is on but ${missing.join(', ')} ${missing.length === 1 ? 'is' : 'are'} not set — keeping the paywall OFF so nobody is locked out with no way to pay. Run scripts/paddle-setup.mjs for the price ids; the client token and webhook secret come from the Paddle dashboard.`);
  }
  return false;
}

/** 1 for a signup made while the paywall is in force, 0 otherwise. Used by routes/auth.ts at signup. */
export function requiresPaymentAtSignup(): number {
  return paywallEnabled() ? 1 : 0;
}

/* ---------------- state ---------------- */

export type PaywallReason =
  | 'no_card'      // locked: the card never arrived
  | 'paid'         // a Paddle subscription is on file
  | 'cleared'      // a card arrived (subscription or credit pack) and lifted the lock
  | 'not_required' // signed up before the paywall, or while it was off
  | 'owner'        // the owner tenant is never billable
  | 'disabled';    // no paywall on this server

export interface PaywallState {
  locked: boolean;
  reason: PaywallReason;
  requiresPayment: boolean;
  clearedAt: number | null;
}

function tenantRow(tid: number): TenantRow | undefined {
  return db().prepare('SELECT * FROM tenants WHERE id = ?').get(tid) as TenantRow | undefined;
}

/**
 * A card is on file. `plan` is only ever set to pro/studio by the Paddle webhook, so it is a safe second opinion when
 * the `requires_payment` update was missed (a webhook redelivered against an older row, a restore from backup).
 */
function hasSubscription(t: TenantRow): boolean {
  return t.plan === 'owner' || t.plan === 'pro' || t.plan === 'studio' || !!t.paddle_subscription_id;
}

export function paywallState(tid: number): PaywallState {
  const t = tenantRow(tid);
  const requiresPayment = Number(t?.requires_payment ?? 0) === 1;
  const clearedAt = t?.paywall_cleared_at ?? null;
  const open = (reason: PaywallReason): PaywallState => ({ locked: false, reason, requiresPayment, clearedAt });
  if (!t) return open('disabled');
  if (t.plan === 'owner') return open('owner');
  if (!paywallEnabled()) return open('disabled');
  if (!requiresPayment) return open(clearedAt ? 'cleared' : 'not_required');
  if (hasSubscription(t)) return open('paid');
  return { locked: true, reason: 'no_card', requiresPayment, clearedAt };
}

export function isLocked(tid: number): boolean {
  return paywallState(tid).locked;
}

/**
 * A card arrived — lift the lock for good. Called from the Paddle webhook for a trialing/active subscription and for
 * a credit-pack purchase. Idempotent, and only logs when something actually changed.
 *
 * Only a tenant that was actually locked is touched. Migration 009 documents `paywall_cleared_at IS NULL` as "signed
 * up before the paywall existed", and support reads it that way; stamping it on a grandfathered tenant who later
 * upgrades would erase exactly the distinction the column exists for (and make `/start` tell them their card lifted a
 * lock they never met).
 */
export function clearPaywall(tid: number, why: string): boolean {
  const t = now();
  const res = db()
    .prepare('UPDATE tenants SET requires_payment = 0, paywall_cleared_at = COALESCE(paywall_cleared_at, ?), updated_at = ? WHERE id = ? AND requires_payment = 1')
    .run(t, t, tid);
  if (!res.changes) return false;
  console.log(`[paywall] tenant ${tid} unlocked (${why})`);
  return true;
}

/** The sentence a locked person sees in the 402 body. */
export function lockedMessage(): string {
  const d = config.trialDays;
  return `Add a card to start your ${d} free day${d === 1 ? '' : 's'}. Nothing is charged until then, and you can cancel in one click.`;
}
