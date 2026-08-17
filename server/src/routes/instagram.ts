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
  accountPayload, connectUrl, disconnect, ensureStarterRules, handleCallback, IgError, instagramConfigured, parseSignedRequest, publicBase, STARTER_TEMPLATES, starterRules, tenantsForIgUser, verifyState,
} from '../services/instagram.js';
import { analyticsPayload, FORCE_INTERVAL_S, isRefreshing, lastRefreshedAt, refreshAnalytics, refreshInBackground } from '../services/ig-analytics.js';
import { igAvailability, invalidateIgAvailability } from '../services/ig-availability.js';
import { now as nowSec, setMeta } from '../db.js';

const NOT_CONFIGURED = { error: 'Instagram connect is not configured on this server (META_APP_ID/META_APP_SECRET).', code: 'not_configured' } as const;

/**
 * Where to send the browser after the OAuth round trip. Only a same-site path we produced ourselves — an absolute
 * URL, a protocol-relative `//host` or anything with a backslash is refused, so `?next=` can never be an open
 * redirect. The wizard uses it to come back to `/welcome?step=4`, which is what its own copy promises.
 */
function safeReturnPath(v: string | undefined | null): string | null {
  if (!v || typeof v !== 'string') return null;
  if (!v.startsWith('/') || v.startsWith('//') || v.includes('\\') || v.includes('://')) return null;
  return v.slice(0, 200);
}
/** Append a query fragment to a path that may already carry one. */
function withQuery(pathname: string, q: string): string {
  return `${pathname}${pathname.includes('?') ? '&' : '?'}${q}`;
}

/* ------------------------------------------------------------------ */
/* Public: OAuth callback + Meta callbacks                              */
/* ------------------------------------------------------------------ */
export const instagramPublic = new Hono();

instagramPublic.get('/callback', async (c) => {
  const base = publicBase(new URL(c.req.url).origin);
  // The screen that started the connect said where it wanted the person back; the state carries it, signed, so a
  // refusal by Meta returns them to the same screen instead of stranding them on a page they never asked for.
  const dest = safeReturnPath(verifyState(c.req.query('state'))?.next) || '/automations';
  const to = (q: string) => c.redirect(`${base}${withQuery(dest, q)}`, 302);
  try {
    const r = await handleCallback({ code: c.req.query('code'), state: c.req.query('state'), error: c.req.query('error'), errorReason: c.req.query('error_reason') }, base);
    invalidateIgAvailability(r.tid); // the 10-minute availability cache must not keep saying "not connected"
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

/**
 * Meta calls this when somebody removes Resurfly under Instagram → Apps and websites. `/privacy` and
 * `/data-deletion` both state that removing the app there also clears the automation contacts and events and the
 * cached media, insights and snapshots — so it wipes, exactly like the data-deletion callback. (The two callbacks
 * are separate requests at Meta and removal only guarantees this one; leaving the wipe to the other one meant every
 * sender id, handle and message body of a removed account stayed in the database indefinitely.)
 */
instagramPublic.post('/deauthorize', async (c) => {
  const sr = await signedRequestFrom(c);
  const payload = parseSignedRequest(sr);
  if (!payload) return c.json({ error: 'invalid signed_request' }, 400);
  const tenants = tenantsForIgUser(payload.user_id);
  for (const t of tenants) { await disconnect(t, { unsubscribe: false, wipe: true, reason: 'deauthorized from Instagram' }); invalidateIgAvailability(t); }
  return c.json({ ok: true, disconnected: tenants.length });
});

instagramPublic.post('/delete', async (c) => {
  const sr = await signedRequestFrom(c);
  const payload = parseSignedRequest(sr);
  if (!payload) return c.json({ error: 'invalid signed_request' }, 400);
  const tenants = tenantsForIgUser(payload.user_id);
  for (const t of tenants) { await disconnect(t, { unsubscribe: false, wipe: true, reason: 'data deletion requested from Instagram' }); invalidateIgAvailability(t); }
  const base = publicBase(new URL(c.req.url).origin);
  const confirmation = crypto.randomUUID();
  // Meta's contract for `url` is a page where the person can follow up on the request, and the code is only useful if
  // somebody can look it up — a console line is not a record. Kept against every tenant the request touched, and
  // deleted with the account like everything else in `meta`.
  const record = JSON.stringify({ code: confirmation, at: nowSec(), igUser: payload.user_id ?? null });
  for (const t of tenants) { try { setMeta(t, 'ig_deletion_request', record); } catch {} }
  console.log(`[instagram] data deletion request for ig user ${payload.user_id ?? '?'} → tenant(s) ${tenants.join(',') || 'none'} (confirmation ${confirmation})`);
  return c.json({ url: `${base}/data-deletion`, confirmation_code: confirmation });
});

/* ------------------------------------------------------------------ */
/* Protected                                                            */
/* ------------------------------------------------------------------ */
export const instagram = new Hono();

/**
 * Start the OAuth round trip. The availability check (ROUND7 §3) is the last chokepoint before the person leaves our
 * product for Meta: a stale tab, a bookmark or any button we failed to gate would otherwise land them on Meta's
 * "app not active" page, whose only exit is the browser Back button. Refusing here sends them back to the screen
 * they came from with the reason, which is what every other surface now shows.
 */
instagram.get('/connect', async (c) => {
  if (!instagramConfigured()) return c.json(NOT_CONFIGURED, 503);
  const s = currentTenant(c)!;
  const base = publicBase(new URL(c.req.url).origin);
  const next = safeReturnPath(c.req.query('next'));
  const av = await igAvailability(s.tid).catch(() => null);
  if (av && !av.canConnect) {
    return c.redirect(`${base}${withQuery(next || '/automations', `error=${encodeURIComponent('unavailable')}`)}`, 302);
  }
  return c.redirect(connectUrl(base, s.tid, s.uid, next), 302);
});

instagram.get('/account', (c) => c.json(accountPayload(tid(c))));

instagram.delete('/account', async (c) => {
  const t = tid(c);
  const r = await disconnect(t, { unsubscribe: true, reason: 'disconnected in Settings' });
  invalidateIgAvailability(t); // otherwise the AI capability note keeps asserting a connection for ten minutes
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
