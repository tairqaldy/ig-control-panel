/**
 * Credits (ROUND6-SPEC §3). Credits are top-ups that keep a tenant working once the plan allowance for the month is gone.
 *
 *   1 credit = 1 save analyzed = 1 Ask answer = 20 automated replies.
 *
 * Only `analyze`, `ask` and `sends` can be paid with credits. Everything else (harvests, rules, the per-minute Ask
 * rate limit) stays a plan matter — buying credits must never look like a way around a rate limit.
 *
 * Balance lives on `tenants.credits`; every change is written to `credit_ledger` in the same transaction, so the
 * balance is always the sum of the deltas. A send costs a twentieth of a credit, which SQLite integers cannot hold, so
 * a per-tenant remainder of already-paid-for units is kept in `meta` (`credit_units_sends`): paying for one reply takes
 * one credit and banks the other 19 replies.
 *
 * This module deliberately does not import ./plans.ts (plans imports credits) — the allowance-then-credits decision
 * lives in `chargeMetered()` over there.
 */
import { db, getMeta, now, setMeta } from '../db.js';

export type CreditMetric = 'analyze' | 'ask' | 'sends';

/** How many units of a metric one credit buys. */
export const CREDIT_RATES: Record<CreditMetric, number> = { analyze: 1, ask: 1, sends: 20 };

export const CREDIT_METRICS = Object.keys(CREDIT_RATES) as CreditMetric[];

export function isCreditMetric(metric: string): metric is CreditMetric {
  return metric === 'analyze' || metric === 'ask' || metric === 'sends';
}

/** One sentence for the UI; kept here so server and web say the same thing. */
export const CREDIT_EXPLAINER = '1 credit = 1 save analyzed = 1 Ask answer = 20 automated replies.';

/* ---------------- packs (Paddle one-time prices) ---------------- */

export interface CreditPack {
  id: 'credits_500' | 'credits_2000' | 'credits_6000';
  credits: number;
  price: number; // USD, one-time
  priceId: string | null; // Paddle price id (null when the env var is not set)
}

/** Read at call time (not at import) so a test or a config change without a rebuild is picked up. */
export function creditPacks(): CreditPack[] {
  return [
    { id: 'credits_500', credits: 500, price: 12, priceId: process.env.PADDLE_PRICE_CREDITS_500 || null },
    { id: 'credits_2000', credits: 2000, price: 39, priceId: process.env.PADDLE_PRICE_CREDITS_2000 || null },
    { id: 'credits_6000', credits: 6000, price: 99, priceId: process.env.PADDLE_PRICE_CREDITS_6000 || null },
  ];
}

/** Which pack (if any) a Paddle price id refers to. */
export function packForPriceId(priceId: string | null | undefined): CreditPack | null {
  if (!priceId) return null;
  return creditPacks().find((p) => p.priceId && p.priceId === priceId) || null;
}

/* ---------------- balance ---------------- */

export function creditBalance(tid: number): number {
  const r = db().prepare('SELECT credits FROM tenants WHERE id = ?').get(tid) as { credits: number } | undefined;
  const n = Number(r?.credits);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

const remainderKey = (metric: CreditMetric) => `credit_units_${metric}`;

/** Units of `metric` already paid for by an earlier credit but not consumed yet (only ever non-zero for `sends`). */
export function creditRemainder(tid: number, metric: CreditMetric): number {
  if (CREDIT_RATES[metric] === 1) return 0;
  const n = Number(getMeta(tid, remainderKey(metric)));
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}
function setRemainder(tid: number, metric: CreditMetric, units: number) {
  if (CREDIT_RATES[metric] === 1) return;
  setMeta(tid, remainderKey(metric), String(Math.max(0, Math.floor(units))));
}

/** How many more units of `metric` the current balance (plus any remainder) can pay for. */
export function creditUnitsAvailable(tid: number, metric: CreditMetric): number {
  return creditBalance(tid) * CREDIT_RATES[metric] + creditRemainder(tid, metric);
}

/** How many credits `units` of `metric` would cost right now (the remainder is used first). */
export function creditsForUnits(tid: number, metric: CreditMetric, units: number): number {
  if (units <= 0) return 0;
  const need = Math.max(0, units - creditRemainder(tid, metric));
  return Math.ceil(need / CREDIT_RATES[metric]);
}

/* ---------------- spend / grant ---------------- */

export interface SpendResult { ok: boolean; credits: number; balance: number }

/**
 * Spend credits for `units` of `metric`. Atomic: the balance is decremented with a guarded UPDATE and the ledger row is
 * written in the same transaction, so the balance can never go negative and never drifts from the ledger.
 * Returns `ok:false` (and changes nothing) when the balance is too small.
 */
export function spendCredits(tid: number, metric: CreditMetric, units: number, ref?: string | null): SpendResult {
  if (units <= 0) return { ok: true, credits: 0, balance: creditBalance(tid) };
  const rate = CREDIT_RATES[metric];
  const d = db();
  return d.transaction((): SpendResult => {
    const remainder = creditRemainder(tid, metric);
    const fromRemainder = Math.min(remainder, units);
    const need = units - fromRemainder;
    const credits = Math.ceil(need / rate);
    const left = remainder - fromRemainder + (credits * rate - need);
    if (credits > 0) {
      const res = d.prepare('UPDATE tenants SET credits = credits - ?, updated_at = ? WHERE id = ? AND credits >= ?').run(credits, now(), tid, credits);
      if (!res.changes) return { ok: false, credits: 0, balance: creditBalance(tid) };
      const balance = creditBalance(tid);
      // reason = the metric ('analyze' | 'ask' | 'sends'); the sign of `delta` says it was a spend.
      d.prepare('INSERT INTO credit_ledger (tenant_id, delta, balance_after, reason, ref, created_at) VALUES (?, ?, ?, ?, ?, ?)')
        .run(tid, -credits, balance, metric, ref ?? null, now());
      setRemainder(tid, metric, left);
      return { ok: true, credits, balance };
    }
    setRemainder(tid, metric, left);
    return { ok: true, credits: 0, balance: creditBalance(tid) };
  })();
}

export interface GrantResult { ok: boolean; added: number; balance: number; duplicate: boolean }

/**
 * Add credits (a Paddle purchase, a manual grant, a refund). `ref` makes it idempotent: a second call with the same
 * (tenant, ref) is a no-op and reports `duplicate: true`. Reasons in use: 'purchase', 'grant', 'refund'.
 */
export function addCredits(tid: number, credits: number, reason = 'grant', ref?: string | null): GrantResult {
  const amount = Math.floor(credits);
  if (!Number.isFinite(amount) || amount <= 0) return { ok: false, added: 0, balance: creditBalance(tid), duplicate: false };
  const d = db();
  return d.transaction((): GrantResult => {
    if (ref) {
      const dup = d.prepare('SELECT id FROM credit_ledger WHERE tenant_id = ? AND ref = ? AND delta > 0').get(tid, ref);
      if (dup) return { ok: true, added: 0, balance: creditBalance(tid), duplicate: true };
    }
    d.prepare('UPDATE tenants SET credits = credits + ?, updated_at = ? WHERE id = ?').run(amount, now(), tid);
    const balance = creditBalance(tid);
    d.prepare('INSERT INTO credit_ledger (tenant_id, delta, balance_after, reason, ref, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(tid, amount, balance, reason, ref ?? null, now());
    return { ok: true, added: amount, balance, duplicate: false };
  })();
}

/* ---------------- history ---------------- */

export interface LedgerRow { id: number; delta: number; balanceAfter: number; reason: string; ref: string | null; createdAt: number }

/** Newest first. */
export function creditLedger(tid: number, limit = 20): LedgerRow[] {
  const rows = db().prepare('SELECT id, delta, balance_after, reason, ref, created_at FROM credit_ledger WHERE tenant_id = ? ORDER BY id DESC LIMIT ?').all(tid, Math.max(1, Math.min(200, limit))) as Array<any>;
  return rows.map((r) => ({ id: r.id, delta: r.delta, balanceAfter: r.balance_after, reason: r.reason, ref: r.ref ?? null, createdAt: r.created_at }));
}

/** The `credits` block of `GET /api/plan`. */
export function creditsPayload(tid: number, ledgerLimit = 20) {
  return {
    balance: creditBalance(tid),
    rates: { ...CREDIT_RATES },
    explainer: CREDIT_EXPLAINER,
    packs: creditPacks(),
    ledger: creditLedger(tid, ledgerLimit),
  };
}
