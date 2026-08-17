/**
 * The paywall route and the 402 middleware (ROUND7-SPEC §1).
 *
 *   GET /api/paywall  → what the /start screen needs: locked?, why, the two plans, the trial price ids, the packs.
 *   paywallGuard      → every other /api/* route answers 402 { code: 'payment_required' } while the tenant is locked.
 *
 * ORDER MATTERS. Hono runs the handlers that match a path in registration order, so the guard is mounted from
 * `mountPublicExtras` — the only hook in app.ts that runs *before* the protected routes are registered. Two
 * consequences, both wanted: routes registered earlier (auth, the Paddle/Instagram webhooks, the harvester upload and
 * the Companion's device-token endpoints) never reach the guard, and the guard runs before `requireAuth`, so it must
 * cope with there being no session (it lets those through and requireAuth answers 401).
 */
import { Hono } from 'hono';
import type { Context, Next } from 'hono';
import { config } from '../config.js';
import { currentTenant } from '../auth.js';
import { creditsPayload } from '../services/credits.js';
import { lockedMessage, paywallEnabled, paywallState, trialPriceIds } from '../services/paywall.js';
import { paddlePublic, planCatalog, planPayload } from '../services/plans.js';

/**
 * Routes a locked tenant may still use: the ones that let them pay, see what they signed up for, log out or leave.
 * Everything else is 402 until a card is on file.
 */
function isOpenPath(path: string, method: string): boolean {
  if (path === '/api/health') return true;
  if (path === '/api/plan' || path === '/api/plans' || path.startsWith('/api/plans/')) return true;
  if (path === '/api/paywall' || path.startsWith('/api/paywall/')) return true;
  if (path === '/api/auth' || path.startsWith('/api/auth/')) return true; // includes logout
  if (path === '/api/billing' || path.startsWith('/api/billing/')) return true;
  if (path.startsWith('/api/webhooks/')) return true;
  if (path === '/api/account' && method.toUpperCase() === 'DELETE') return true;
  return false;
}

export async function paywallGuard(c: Context, next: Next) {
  const path = c.req.path;
  if (!path.startsWith('/api/') || isOpenPath(path, c.req.method)) return next();
  if (!paywallEnabled()) return next(); // self-hosted, or the flag turned itself off — no DB read at all
  const s = currentTenant(c);
  if (!s || s.isOwner) return next();
  const state = paywallState(s.tid);
  if (!state.locked) return next();
  return c.json(
    { error: lockedMessage(), code: 'payment_required', reason: state.reason, trialDays: config.trialDays, start: '/start' },
    402,
  );
}

export const paywall = new Hono();

/**
 * Everything the /start screen needs in one call. `priceIds` are the trial-enabled prices — signup checkout must use
 * those, so the free days are Paddle's own and the first charge date is Paddle's own. `paidPriceIds` are for an
 * upgrade later on, when the person has already had their free days.
 */
paywall.get('/', (c) => {
  const s = currentTenant(c)!;
  const state = paywallState(s.tid);
  const plan = planPayload(s.tid);
  const trial = trialPriceIds();
  const catalog = planCatalog();
  const plans = catalog.plans
    .filter((p) => p.id === 'pro' || p.id === 'studio')
    .map((p) => ({
      ...p,
      trialPriceIds: p.id === 'pro'
        ? { month: trial.proMonth || null, year: trial.proYear || null }
        : { month: trial.studioMonth || null, year: trial.studioYear || null },
    }));
  return c.json({
    locked: state.locked,
    reason: state.reason,
    requiresPayment: state.requiresPayment,
    clearedAt: state.clearedAt,
    trialDays: config.trialDays,
    /** When the first charge would land if checkout completed right now (epoch seconds); the screen shows the date. */
    firstChargeAt: Math.floor(Date.now() / 1000) + config.trialDays * 86400,
    plans,
    priceIds: { proMonth: trial.proMonth || null, proYear: trial.proYear || null, studioMonth: trial.studioMonth || null, studioYear: trial.studioYear || null },
    paidPriceIds: { ...paddlePublic().prices },
    paddle: { env: config.paddle.env, clientToken: config.paddle.clientToken || null, customData: { tenant_id: s.tid } },
    credits: creditsPayload(s.tid, 5),
    plan: { plan: plan.plan, effectivePlan: plan.effectivePlan, status: plan.status, trialEndsAt: plan.trialEndsAt },
  });
});
