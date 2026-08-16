/**
 * Instagram routes (round 5, spec §1–§3).
 *  - `instagramPublic` (mounted at /api/instagram by mountPublicExtras): OAuth callback, Meta deauthorize + data-deletion callbacks.
 *  - `instagram` (mounted at /api/instagram by mountProtectedExtras): connect, account, starter rules, analytics.
 *  - `automationsStarter` (mounted at /api/automations by mountProtectedExtras): the same starter-rules handlers at /api/automations/starter.
 */
import crypto from 'node:crypto';
import { Hono, type Context } from 'hono';
import { config } from '../config.js';
import { currentTenant, tid } from '../auth.js';
import { finite } from '../services/plans.js';
import {
  accountPayload, connectUrl, disconnect, ensureStarterRules, handleCallback, IgError, instagramConfigured, parseSignedRequest, publicBase, STARTER_TEMPLATES, starterRules, tenantsForIgUser,
} from '../services/instagram.js';
import { analyticsPayload, FORCE_INTERVAL_S, isRefreshing, lastRefreshedAt, refreshAnalytics, refreshInBackground } from '../services/ig-analytics.js';

const NOT_CONFIGURED = { error: 'Instagram connect is not configured on this server (META_APP_ID/META_APP_SECRET).', code: 'not_configured' } as const;

/* ------------------------------------------------------------------ */
/* Public: OAuth callback + Meta callbacks                              */
/* ------------------------------------------------------------------ */
export const instagramPublic = new Hono();

instagramPublic.get('/callback', async (c) => {
  const base = publicBase(new URL(c.req.url).origin);
  const to = (q: string) => c.redirect(`${base}/automations?${q}`, 302);
  try {
    const r = await handleCallback({ code: c.req.query('code'), state: c.req.query('state'), error: c.req.query('error'), errorReason: c.req.query('error_reason') }, base);
    refreshInBackground(r.tid, { force: true }); // warm the analytics cache so /analytics is not empty on first open
    return to(`connected=1${r.webhookSubscribed ? '' : '&webhooks=0'}`);
  } catch (e: any) {
    const code = e instanceof IgError ? e.code : 'unknown';
    if (!(e instanceof IgError)) console.error('[instagram] callback failed', e);
    else console.warn(`[instagram] callback error ${code}: ${e.message}`);
    return to(`error=${encodeURIComponent(code)}`);
  }
});

/** Meta sends `signed_request` as a form field (application/x-www-form-urlencoded); accept JSON too. */
async function signedRequestFrom(c: Context): Promise<string | null> {
  const ct = c.req.header('content-type') || '';
  try {
    if (ct.includes('application/json')) { const b = await c.req.json<any>(); return typeof b?.signed_request === 'string' ? b.signed_request : null; }
    const body = await c.req.parseBody();
    const v = body['signed_request'];
    if (typeof v === 'string') return v;
  } catch {}
  return c.req.query('signed_request') || null;
}

instagramPublic.post('/deauthorize', async (c) => {
  const sr = await signedRequestFrom(c);
  const payload = parseSignedRequest(sr);
  if (!payload) return c.json({ error: 'invalid signed_request' }, 400);
  const tenants = tenantsForIgUser(payload.user_id);
  for (const t of tenants) await disconnect(t, { unsubscribe: false, reason: 'deauthorized from Instagram' });
  return c.json({ ok: true, disconnected: tenants.length });
});

instagramPublic.post('/delete', async (c) => {
  const sr = await signedRequestFrom(c);
  const payload = parseSignedRequest(sr);
  if (!payload) return c.json({ error: 'invalid signed_request' }, 400);
  const tenants = tenantsForIgUser(payload.user_id);
  for (const t of tenants) await disconnect(t, { unsubscribe: false, wipe: true, reason: 'data deletion requested from Instagram' });
  const base = publicBase(new URL(c.req.url).origin);
  const confirmation = crypto.randomUUID();
  console.log(`[instagram] data deletion request for ig user ${payload.user_id ?? '?'} → tenant(s) ${tenants.join(',') || 'none'} (confirmation ${confirmation})`);
  return c.json({ url: `${base}/privacy`, confirmation_code: confirmation });
});

/* ------------------------------------------------------------------ */
/* Protected                                                            */
/* ------------------------------------------------------------------ */
export const instagram = new Hono();

instagram.get('/connect', (c) => {
  if (!instagramConfigured()) return c.json(NOT_CONFIGURED, 503);
  const s = currentTenant(c)!;
  const base = publicBase(new URL(c.req.url).origin);
  return c.redirect(connectUrl(base, s.tid, s.uid), 302);
});

instagram.get('/account', (c) => c.json(accountPayload(tid(c))));

instagram.delete('/account', async (c) => {
  const t = tid(c);
  const r = await disconnect(t, { unsubscribe: true, reason: 'disconnected in Settings' });
  return c.json({ ok: true, existed: r.existed, ...accountPayload(t) });
});

/* ---- starter rules (also mounted at /api/automations/starter) ---- */
const templatesPayload = () => STARTER_TEMPLATES.map((t) => ({ key: t.key, name: t.name, description: t.description, trigger_type: t.trigger_type, match_mode: t.match_mode, keywords: t.keywords, reply_text: t.reply_text, cooldown_minutes: t.cooldown_minutes }));

function starterGet(c: Context) {
  return c.json({ rules: starterRules(tid(c)), templates: templatesPayload() });
}
function starterPost(c: Context) {
  const r = ensureStarterRules(tid(c));
  return c.json({
    rules: r.rules,
    created: r.created,
    leftOut: r.leftOut,
    quota: r.quota ? { metric: r.quota.metric, plan: r.quota.plan, used: r.quota.used, limit: finite(r.quota.limit), remaining: finite(r.quota.remaining), resetsAt: r.quota.resetsAt } : null,
    templates: templatesPayload(),
  });
}
instagram.get('/starter', starterGet);
instagram.post('/starter', starterPost);

export const automationsStarter = new Hono();
automationsStarter.get('/starter', starterGet);
automationsStarter.post('/starter', starterPost);

/* ---- analytics ---- */
instagram.get('/analytics', (c) => {
  const t = tid(c);
  const tz = Number(c.req.query('tzOffset') || 0);
  const payload = analyticsPayload(t, Number(c.req.query('range') || 30), Number.isFinite(tz) ? Math.max(-840, Math.min(840, tz)) : 0);
  if (payload.connected && !payload.demo) payload.refreshing = refreshInBackground(t) || payload.refreshing;
  return c.json(payload);
});

instagram.post('/analytics/refresh', async (c) => {
  const s = currentTenant(c)!;
  const t = s.tid;
  const last = lastRefreshedAt(t);
  if (!s.isOwner && last && Date.now() / 1000 - last < FORCE_INTERVAL_S) {
    return c.json({ error: 'Analytics were refreshed less than an hour ago. Try again a bit later.', code: 'too_soon', retryAt: last + FORCE_INTERVAL_S, refreshedAt: last }, 429);
  }
  if (isRefreshing(t)) return c.json({ ok: true, skipped: 'in_progress', refreshedAt: last, requests: 0, errors: [] });
  const r = await refreshAnalytics(t, { force: true });
  if (r.skipped === 'not_connected') return c.json({ error: 'Instagram is not connected.', code: 'not_connected' }, 400);
  return c.json({ ok: r.ok, skipped: r.skipped ?? null, error: r.error ?? null, refreshedAt: r.refreshedAt, requests: r.requests, errors: r.errors, media: r.media ?? 0 }, r.ok ? 200 : 502);
});

/** Kept for symmetry with the other feature routers: is this deployment able to run OAuth at all? */
instagram.get('/status', (c) => c.json({ configured: instagramConfigured(), appId: config.metaAppId ? `${config.metaAppId.slice(0, 4)}…` : null, redirectUri: `${publicBase(new URL(c.req.url).origin)}/api/instagram/callback` }));
