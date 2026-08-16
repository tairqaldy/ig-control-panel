/**
 * Onboarding state (ROUND5-SPEC §7). Mounted at /api/onboarding via mountProtectedExtras.
 *
 *   GET  /api/onboarding                 → OnboardingPayload (see below)
 *   POST /api/onboarding/event {key}     → sets a meta flag, returns the fresh OnboardingPayload
 *        key ∈ 'explored' | 'dismissed' | 'asked' | 'welcome_seen'
 *
 * No table: flags live in `meta` (tenant-scoped) under the keys in migrations/006-ask-onboarding.ts.
 */
import { Hono } from 'hono';
import { config } from '../config.js';
import { db, getMeta, setMeta } from '../db.js';
import { tid } from '../auth.js';
import { worker } from '../services/worker.js';
import { igConnected } from '../services/ask.js';
import { ONBOARDING_META_KEYS } from '../migrations/006-ask-onboarding.js';

export const onboarding = new Hono();

export type SuggestedNext = 'import' | 'wait' | 'ask' | 'explore' | 'connect' | 'done';

export interface OnboardingPayload {
  steps: {
    import: { done: boolean; count: number };
    analyze: { done: boolean; analyzed: number; total: number; running: boolean; queued: number; pending: number; planBlocked: boolean; openaiConfigured: boolean };
    ask: { done: boolean };
    explore: { done: boolean };
    connectInstagram: { done: boolean; available: boolean };
    companion: { done: boolean };
  };
  dismissed: boolean;
  welcomeSeen: boolean;
  firstRun: boolean;
  suggestedNext: SuggestedNext;
}

function tableExists(name: string): boolean {
  try { return !!db().prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name); } catch { return false; }
}

export function onboardingPayload(t: number): OnboardingPayload {
  const d = db();
  const flag = (k: keyof typeof ONBOARDING_META_KEYS) => !!getMeta(t, ONBOARDING_META_KEYS[k]);
  const count = (d.prepare('SELECT COUNT(*) AS n FROM items WHERE tenant_id = ? AND archived = 0').get(t) as any).n as number;
  const ws = worker.status(t);
  const analyzed = ws.analyzed || 0;
  const running = !ws.paused && ((ws.running || 0) > 0 || (ws.queued || 0) > 0);
  const asked = flag('asked') || !!d.prepare('SELECT 1 FROM messages m JOIN conversations c ON c.id = m.conversation_id WHERE c.tenant_id = ? LIMIT 1').get(t);
  const explored = flag('explored');
  const connectAvailable = !!(process.env.META_APP_ID || (config as any).metaAppId);
  const connected = igConnected(t);
  const companion = tableExists('companion_devices') ? !!d.prepare('SELECT 1 FROM companion_devices WHERE tenant_id = ? LIMIT 1').get(t) : false;
  const dismissed = flag('dismissed');
  const welcomeSeen = flag('welcome_seen');
  const firstRun = count === 0 && !dismissed;

  let suggestedNext: SuggestedNext;
  if (count === 0) suggestedNext = 'import';
  else if (analyzed === 0) suggestedNext = 'wait';
  else if (!asked) suggestedNext = 'ask';
  else if (!explored) suggestedNext = 'explore';
  else if (connectAvailable && !connected) suggestedNext = 'connect';
  else suggestedNext = 'done';

  return {
    steps: {
      import: { done: count > 0, count },
      analyze: { done: analyzed > 0, analyzed, total: ws.total || count, running, queued: ws.queued || 0, pending: ws.pending || 0, planBlocked: !!ws.planBlocked, openaiConfigured: !!ws.openaiConfigured },
      ask: { done: asked },
      explore: { done: explored },
      connectInstagram: { done: connected, available: connectAvailable },
      companion: { done: companion },
    },
    dismissed,
    welcomeSeen,
    firstRun,
    suggestedNext,
  };
}

onboarding.get('/', (c) => c.json(onboardingPayload(tid(c))));

onboarding.post('/event', async (c) => {
  const t = tid(c);
  const body = await c.req.json<{ key?: string }>().catch(() => ({}) as { key?: string });
  const key = String(body.key || '') as keyof typeof ONBOARDING_META_KEYS;
  if (!Object.prototype.hasOwnProperty.call(ONBOARDING_META_KEYS, key)) return c.json({ error: `key must be one of ${Object.keys(ONBOARDING_META_KEYS).join(', ')}` }, 400);
  setMeta(t, ONBOARDING_META_KEYS[key], String(Math.floor(Date.now() / 1000)));
  return c.json(onboardingPayload(t));
});
