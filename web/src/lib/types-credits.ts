/* Credits (ROUND6-SPEC §3): balance, packs, ledger — plus tolerant readers for the server payloads.
 *
 * The server adds credits to payloads the web already consumes:
 *   GET /api/plans  → catalog gains the credit pack catalog (one-time Paddle prices)
 *   GET /api/plan   → gains `credits` (balance + last ~20 ledger rows)
 *   HTTP 402 body   → gains `credits: { balance, needed, packs }`
 * Field names differ between snake_case (SQLite columns) and camelCase (JSON), and this code ships
 * alongside the server change, so every reader below accepts a few shapes and falls back to the
 * numbers in the spec instead of rendering an empty section.
 */
import type { PlanInfo, PlansCatalog, QuotaError } from './types';

/** One-time purchase: N credits for $X, sold through a Paddle one-time price. */
export interface CreditPack { id: string; credits: number; price: number; priceId: string | null; name?: string }
/** A row of `credit_ledger`: positive delta = purchase, negative = spend. */
export interface CreditLedgerEntry { id: number; delta: number; balanceAfter: number | null; reason: string; ref: string | null; createdAt: number | null }
/** What the Billing page needs to render the credits section. */
export interface CreditsState { balance: number; packs: CreditPack[]; ledger: CreditLedgerEntry[] }
/** The `credits` block of a 402 body — enough to offer "buy credits" next to "upgrade". */
export interface CreditOffer { balance: number; needed: number; packs: CreditPack[] }
/** GET /api/plans, with the credit pack catalog kept alongside the plans. */
export interface CreditsCatalog extends PlansCatalog { creditPacks: CreditPack[] }

/** 1 credit buys one of these. Used verbatim in pricing copy — keep in step with server/src/services/plans.ts. */
export const CREDIT_UNIT_LINE = '1 credit = 1 save analyzed = 1 Ask answer = 20 automated replies.';
export const CREDIT_RULE_LINE = 'Credits are only spent after your plan allowance runs out, and they don’t expire.';
export const SENDS_PER_CREDIT = 20;

/** Spec prices: 500 credits $12 · 2,000 credits $39 · 6,000 credits $99. Fallback when /api/plans is old or unreachable. */
export const DEFAULT_CREDIT_PACKS: CreditPack[] = [
  { id: 'credits_500', credits: 500, price: 12, priceId: null },
  { id: 'credits_2000', credits: 2000, price: 39, priceId: null },
  { id: 'credits_6000', credits: 6000, price: 99, priceId: null },
];

const num = (v: unknown): number | null => (v === null || v === undefined || v === '' ? null : Number.isFinite(Number(v)) ? Number(v) : null);
const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : typeof v === 'number' ? String(v) : null);

function packFrom(raw: any): CreditPack | null {
  if (!raw || typeof raw !== 'object') return null;
  const credits = num(raw.credits ?? raw.amount ?? raw.quantity ?? raw.n);
  if (!credits || credits <= 0) return null;
  const price = num(raw.price ?? raw.priceUsd ?? raw.usd ?? raw.priceUSD ?? raw.amountUsd) ?? 0;
  const priceId = str(raw.priceId ?? raw.price_id ?? raw.paddlePriceId ?? raw.paddle_price_id ?? raw.id_paddle);
  const id = str(raw.id ?? raw.key ?? raw.slug) ?? `credits_${credits}`;
  return { id, credits, price, priceId, name: str(raw.name ?? raw.label) ?? undefined };
}

/** Accepts an array, `{ packs }`, `{ credits: { packs } }`, or `{ creditPacks }`; falls back to DEFAULT_CREDIT_PACKS. */
export function normalizeCreditPacks(raw: unknown): CreditPack[] {
  const src: any = raw && typeof raw === 'object' ? raw : {};
  const list: any[] = Array.isArray(raw) ? (raw as any[])
    : Array.isArray(src.creditPacks) ? src.creditPacks
      : Array.isArray(src.packs) ? src.packs
        : Array.isArray(src.credits?.packs) ? src.credits.packs
          : Array.isArray(src.credits) ? src.credits
            : [];
  const packs = list.map(packFrom).filter((p): p is CreditPack => !!p).sort((a, b) => a.credits - b.credits);
  return packs.length ? packs : DEFAULT_CREDIT_PACKS;
}

function ledgerRow(raw: any, i: number): CreditLedgerEntry | null {
  if (!raw || typeof raw !== 'object') return null;
  const delta = num(raw.delta ?? raw.amount ?? raw.change);
  if (delta === null) return null;
  return {
    id: num(raw.id) ?? i,
    delta,
    balanceAfter: num(raw.balanceAfter ?? raw.balance_after ?? raw.balance),
    reason: str(raw.reason ?? raw.kind ?? raw.metric) ?? 'adjustment',
    ref: str(raw.ref ?? raw.reference ?? raw.transactionId),
    createdAt: num(raw.createdAt ?? raw.created_at ?? raw.at ?? raw.ts),
  };
}

/** Reads the credits block of GET /api/plan. `credits` may be a plain number or an object with ledger + packs. */
export function creditsFromPlan(plan: PlanInfo | null | undefined, fallbackPacks?: CreditPack[]): CreditsState {
  const p: any = plan ?? {};
  const c = p.credits;
  const balance = num(typeof c === 'number' ? c : c?.balance ?? c?.credits ?? p.creditBalance ?? p.creditsBalance) ?? 0;
  const rawLedger: any[] = Array.isArray(c?.ledger) ? c.ledger : Array.isArray(p.creditLedger) ? p.creditLedger : Array.isArray(p.credit_ledger) ? p.credit_ledger : Array.isArray(p.ledger) ? p.ledger : [];
  const ledger = rawLedger.map(ledgerRow).filter((r): r is CreditLedgerEntry => !!r);
  const packs = Array.isArray(c?.packs) && c.packs.length ? normalizeCreditPacks(c.packs) : (fallbackPacks?.length ? fallbackPacks : DEFAULT_CREDIT_PACKS);
  return { balance: Math.max(0, balance), packs, ledger };
}

/** Current credit balance, 0 when the server hasn't shipped credits yet. */
export const creditBalance = (plan: PlanInfo | null | undefined): number => creditsFromPlan(plan).balance;

/**
 * Reads the `credits` block of a 402 body; null when this 402 isn't credit-payable.
 * The server sets `eligible: false` for limits credits can't lift (imports, rule slots, the Ask rate limit) —
 * offering a top-up there would be a lie, so nothing is rendered.
 */
export function creditOffer(q: QuotaError | null | undefined, fallbackPacks?: CreditPack[]): CreditOffer | null {
  const c: any = (q as any)?.credits;
  if (!c || typeof c !== 'object') return null;
  if (c.eligible === false) return null;
  const packs = Array.isArray(c.packs) && c.packs.length ? normalizeCreditPacks(c.packs) : (fallbackPacks?.length ? fallbackPacks : DEFAULT_CREDIT_PACKS);
  return { balance: Math.max(0, num(c.balance) ?? 0), needed: Math.max(0, num(c.needed) ?? 1), packs };
}

/** "2.4¢ per credit" — the honest per-unit price of a pack. */
export const perCreditLabel = (p: CreditPack): string => (p.credits > 0 && p.price > 0 ? `${((p.price / p.credits) * 100).toFixed(1)}¢ per credit` : '');
export const fmtCredits = (n: number): string => n.toLocaleString();

/** Human label for a `credit_ledger.reason`. */
export function ledgerReason(reason: string): string {
  switch (reason) {
    case 'purchase': case 'topup': case 'top_up': return 'Credit pack purchased';
    case 'analyze': return 'Saves analyzed';
    case 'ask': return 'Ask answers';
    case 'sends': case 'send': return 'Automated replies';
    case 'refund': return 'Refund';
    case 'grant': case 'bonus': return 'Credits granted';
    case 'adjustment': return 'Adjustment';
    default: return reason.replace(/[_-]/g, ' ').replace(/^./, (m) => m.toUpperCase());
  }
}

/** What one credit covers for a metric, for the "N credits left" lines. */
export function creditsCover(metric: 'analyze' | 'ask' | 'sends', credits: number): string {
  if (metric === 'sends') return `${(credits * SENDS_PER_CREDIT).toLocaleString()} more replies`;
  return metric === 'ask' ? `${credits.toLocaleString()} more questions` : `${credits.toLocaleString()} more saves`;
}
