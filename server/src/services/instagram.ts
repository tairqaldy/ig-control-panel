/**
 * Connect Instagram — "Instagram API with Instagram Login" (Business Login), Graph API v23.0.
 *
 *  - OAuth: signed state → authorize URL → callback exchanges the code, upgrades to a long-lived token, loads the
 *    profile, stores everything in `ig_accounts` (token encrypted at rest, see ./crypto.ts), mirrors `ig_user_id` /
 *    `ig_access_token` into the tenant's settings so services/automations.ts keeps working unchanged, subscribes the
 *    webhook fields and creates the starter rules.
 *  - Token refresh job (every 12 h, tokens expiring in < 10 days), Meta deauthorize / data-deletion callbacks.
 *  - OWNER_PLAN (spec §0) is applied here at startup because this module owns the boot hook (`startInstagramJobs`).
 *
 * Owner env credentials (META_* / IG_*) keep working for tenant 1 exactly as before when no connected account exists.
 */
import crypto from 'node:crypto';
import { config } from '../config.js';
import { db, getMeta, getSetting, j, now, OWNER_TENANT, setMeta, setSetting } from '../db.js';
import { encryptSecret, tryDecryptSecret } from './crypto.js';
import { listRules, logSystemEvent, metaConfig, type Rule } from './automations.js';
import { checkQuota, getTenant, updateTenant, type QuotaCheck } from './plans.js';
import type { PlanId } from '../types.js';

/* ------------------------------------------------------------------ */
/* Constants / config                                                   */
/* ------------------------------------------------------------------ */
export const IG_SCOPES = ['instagram_business_basic', 'instagram_business_manage_messages', 'instagram_business_manage_comments', 'instagram_business_manage_insights'] as const;
export const WEBHOOK_FIELDS = ['messages', 'comments', 'message_reactions', 'messaging_postbacks', 'messaging_seen'] as const;
const STATE_TTL_MS = 10 * 60_000;
const REFRESH_WINDOW_S = 10 * 86400; // refresh tokens that expire in < 10 days
const REFRESH_EVERY_MS = 12 * 3600_000;

const graphBase = () => `https://graph.instagram.com/${config.graphApiVersion}`;

/** OAuth is available when the operator configured a Meta app id + secret (env). */
export function instagramConfigured(): boolean {
  return !!(config.metaAppId && config.metaAppSecret);
}

/** Absolute base URL for redirects (PUBLIC_URL, else the request origin passed by the route). */
export function publicBase(fallbackOrigin?: string): string {
  return (config.publicUrl || fallbackOrigin || '').replace(/\/$/, '');
}
export function redirectUri(base: string): string {
  return `${base}/api/instagram/callback`;
}

/* ------------------------------------------------------------------ */
/* Errors                                                               */
/* ------------------------------------------------------------------ */
/** Error with a short machine code (used for `?error=<code>` on the callback redirect). */
export class IgError extends Error {
  code: string;
  constructor(code: string, message: string) { super(message); this.code = code; }
}

/* ------------------------------------------------------------------ */
/* Signed OAuth state                                                   */
/* ------------------------------------------------------------------ */
/** `next` is the in-app path the screen that started the connect wants the person returned to (signed, so it cannot be forged into an open redirect). */
export interface OAuthState { tid: number; uid: number; nonce: string; exp: number; next?: string }

function stateKey(): Buffer {
  return crypto.createHash('sha256').update(`${config.sessionSecret}:ig-state`).digest();
}
function hmac(payload: string): string {
  return crypto.createHmac('sha256', stateKey()).update(payload).digest('base64url');
}

export function signState(tid: number, uid: number, ttlMs = STATE_TTL_MS, next?: string | null): string {
  const st: OAuthState = { tid, uid, nonce: crypto.randomBytes(12).toString('base64url'), exp: Date.now() + ttlMs };
  if (next) st.next = String(next).slice(0, 200);
  const payload = Buffer.from(JSON.stringify(st)).toString('base64url');
  return `${payload}.${hmac(payload)}`;
}

export function verifyState(state: string | undefined | null): OAuthState | null {
  if (!state) return null;
  const idx = state.lastIndexOf('.');
  if (idx <= 0) return null;
  const payload = state.slice(0, idx), sig = state.slice(idx + 1);
  const expected = hmac(payload);
  const a = Buffer.from(sig), b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const st = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as OAuthState;
    if (!Number.isInteger(st.tid) || st.tid < 1) return null;
    if (typeof st.exp !== 'number' || st.exp < Date.now()) return null;
    const next = typeof st.next === 'string' && st.next.startsWith('/') && !st.next.startsWith('//') ? st.next.slice(0, 200) : undefined;
    return { tid: st.tid, uid: Number(st.uid || 0), nonce: String(st.nonce || ''), exp: st.exp, next };
  } catch { return null; }
}

/** The Instagram authorization URL for a tenant. */
export function connectUrl(base: string, tid: number, uid: number, next?: string | null): string {
  const u = new URL('https://www.instagram.com/oauth/authorize');
  u.searchParams.set('client_id', config.metaAppId);
  u.searchParams.set('redirect_uri', redirectUri(base));
  u.searchParams.set('response_type', 'code');
  u.searchParams.set('scope', IG_SCOPES.join(','));
  u.searchParams.set('state', signState(tid, uid, undefined, next));
  u.searchParams.set('force_reauth', 'false');
  return u.toString();
}

/* ------------------------------------------------------------------ */
/* HTTP helpers (always go through globalThis.fetch so tests can mock)  */
/* ------------------------------------------------------------------ */
export interface GraphResult<T = any> { ok: boolean; status: number; data: T | null; error: string | null; errorCode?: number | null }

async function readJson(res: Response): Promise<any> {
  const text = await res.text();
  try { return JSON.parse(text); } catch { return { raw: text }; }
}
function errorOf(data: any, status: number): { message: string; code: number | null } {
  const e = data?.error;
  if (e && typeof e === 'object') return { message: `${e.message || 'Graph API error'}${e.code ? ` (code ${e.code}${e.error_subcode ? `/${e.error_subcode}` : ''})` : ''}`, code: typeof e.code === 'number' ? e.code : null };
  if (typeof data?.error_message === 'string') return { message: `${data.error_message}${data.error_type ? ` (${data.error_type})` : ''}`, code: typeof data.code === 'number' ? data.code : null };
  return { message: `HTTP ${status}`, code: null };
}

/** GET on graph.instagram.com/{version}/{path} with a token. Never throws (network errors become `ok:false`). */
export async function igGet<T = any>(path: string, params: Record<string, string>, accessToken: string, absolute = false): Promise<GraphResult<T>> {
  try {
    const url = new URL(absolute ? path : `${graphBase()}/${path.replace(/^\//, '')}`);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    url.searchParams.set('access_token', accessToken);
    const res = await fetch(url, { method: 'GET' });
    const data = await readJson(res);
    if (!res.ok || data?.error) { const e = errorOf(data, res.status); return { ok: false, status: res.status, data, error: e.message, errorCode: e.code }; }
    return { ok: true, status: res.status, data, error: null };
  } catch (e: any) {
    return { ok: false, status: 0, data: null, error: `network: ${e?.message || e}` };
  }
}

async function igPost<T = any>(path: string, params: Record<string, string>, accessToken: string): Promise<GraphResult<T>> {
  try {
    const url = new URL(`${graphBase()}/${path.replace(/^\//, '')}`);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    url.searchParams.set('access_token', accessToken);
    const res = await fetch(url, { method: 'POST' });
    const data = await readJson(res);
    if (!res.ok || data?.error) { const e = errorOf(data, res.status); return { ok: false, status: res.status, data, error: e.message, errorCode: e.code }; }
    return { ok: true, status: res.status, data, error: null };
  } catch (e: any) {
    return { ok: false, status: 0, data: null, error: `network: ${e?.message || e}` };
  }
}

/* ------------------------------------------------------------------ */
/* Accounts                                                             */
/* ------------------------------------------------------------------ */
export interface IgAccountRow {
  tenant_id: number;
  ig_user_id: string;
  app_scoped_id: string | null;
  username: string | null;
  name: string | null;
  profile_picture_url: string | null;
  account_type: string | null;
  followers_count: number | null;
  follows_count: number | null;
  media_count: number | null;
  access_token_enc: string;
  token_expires_at: number | null;
  scopes: string | null;
  connected_at: number | null;
  refreshed_at: number | null;
  last_error: string | null;
  webhook_subscribed: number;
}

export function getAccountRow(tid: number): IgAccountRow | undefined {
  return db().prepare('SELECT * FROM ig_accounts WHERE tenant_id = ?').get(tid) as IgAccountRow | undefined;
}

/** Tenants that connected this Instagram user (matches the professional account id OR the app-scoped id). Normally 0 or 1. */
export function tenantsForIgUser(userId: string | null | undefined): number[] {
  if (!userId) return [];
  const rows = db().prepare('SELECT tenant_id FROM ig_accounts WHERE ig_user_id = ? OR app_scoped_id = ?').all(String(userId), String(userId)) as Array<{ tenant_id: number }>;
  return rows.map((r) => r.tenant_id);
}
export function tenantForIgUser(userId: string | null | undefined): number | null {
  return tenantsForIgUser(userId)[0] ?? null;
}

/** Decrypted OAuth token for a tenant (null when not connected or undecryptable, e.g. after a SESSION_SECRET rotation). */
export function oauthToken(tid: number): string | null {
  const row = getAccountRow(tid);
  if (!row) return null;
  return tryDecryptSecret(row.access_token_enc, 'ig');
}

/**
 * Credentials to use for Graph calls made by this module: the connected account (OAuth) first, else whatever
 * services/automations.ts resolves (owner env / pasted settings) so BYO-app users get analytics too.
 */
export function igCredentials(tid: number): { accessToken: string; igUserId: string; source: 'oauth' | 'env' } | null {
  const row = getAccountRow(tid);
  if (row) {
    const token = tryDecryptSecret(row.access_token_enc, 'ig');
    if (token) return { accessToken: token, igUserId: row.ig_user_id, source: 'oauth' };
  }
  const m = metaConfig(tid);
  if (m.accessToken && m.igUserId) return { accessToken: m.accessToken, igUserId: m.igUserId, source: 'env' };
  return null;
}

/** Payload of GET /api/instagram/account. */
export function accountPayload(tid: number) {
  const row = getAccountRow(tid);
  const configured = instagramConfigured();
  if (row) {
    return {
      connected: true,
      configured,
      source: 'oauth' as const,
      account: {
        igUserId: row.ig_user_id,
        username: row.username,
        name: row.name,
        profilePictureUrl: row.profile_picture_url,
        accountType: row.account_type,
        followersCount: row.followers_count,
        followsCount: row.follows_count,
        mediaCount: row.media_count,
        connectedAt: row.connected_at,
        tokenExpiresAt: row.token_expires_at,
        refreshedAt: row.refreshed_at,
        webhookSubscribed: !!row.webhook_subscribed,
        lastError: row.last_error,
        scopes: (row.scopes || '').split(',').filter(Boolean),
      },
    };
  }
  const m = metaConfig(tid);
  const env = !!(m.accessToken && m.igUserId);
  return {
    connected: env,
    configured,
    source: env ? ('env' as const) : null,
    account: env ? { igUserId: m.igUserId, username: getMeta(tid, 'ig_username'), name: null, profilePictureUrl: null, accountType: null, followersCount: null, followsCount: null, mediaCount: null, connectedAt: null, tokenExpiresAt: null, refreshedAt: null, webhookSubscribed: false, lastError: null, scopes: [] as string[] } : undefined,
  };
}

interface MeProfile { id?: string; user_id?: string; username?: string; name?: string; account_type?: string; profile_picture_url?: string; followers_count?: number; follows_count?: number; media_count?: number }

const ME_FIELDS = 'id,user_id,username,name,account_type,profile_picture_url,followers_count,follows_count,media_count';

/** Refresh the profile counters of a connected account (used by analytics snapshots). Returns the profile or null. */
export async function fetchProfile(tid: number): Promise<MeProfile | null> {
  const creds = igCredentials(tid);
  if (!creds) return null;
  const r = await igGet<MeProfile>('me', { fields: ME_FIELDS }, creds.accessToken);
  if (!r.ok || !r.data) { noteError(tid, `profile: ${r.error}`); return null; }
  const p = r.data;
  if (getAccountRow(tid)) {
    db().prepare('UPDATE ig_accounts SET username = COALESCE(?, username), name = COALESCE(?, name), profile_picture_url = COALESCE(?, profile_picture_url), account_type = COALESCE(?, account_type), followers_count = COALESCE(?, followers_count), follows_count = COALESCE(?, follows_count), media_count = COALESCE(?, media_count), last_error = NULL WHERE tenant_id = ?')
      .run(p.username ?? null, p.name ?? null, p.profile_picture_url ?? null, p.account_type ?? null, p.followers_count ?? null, p.follows_count ?? null, p.media_count ?? null, tid);
  }
  return p;
}

function noteError(tid: number, msg: string) {
  try { db().prepare('UPDATE ig_accounts SET last_error = ? WHERE tenant_id = ?').run(msg.slice(0, 500), tid); } catch {}
}
/** Record a problem on the connected account (shown as `account.lastError` in GET /api/instagram/account). */
export function noteAccountError(tid: number, msg: string) { noteError(tid, msg); }

/* ------------------------------------------------------------------ */
/* Webhook subscription                                                 */
/* ------------------------------------------------------------------ */
export async function subscribeWebhooks(tid: number): Promise<{ ok: boolean; error: string | null }> {
  const creds = igCredentials(tid);
  if (!creds) return { ok: false, error: 'not connected' };
  const r = await igPost(`${creds.igUserId}/subscribed_apps`, { subscribed_fields: WEBHOOK_FIELDS.join(',') }, creds.accessToken);
  if (getAccountRow(tid)) db().prepare('UPDATE ig_accounts SET webhook_subscribed = ?, last_error = ? WHERE tenant_id = ?').run(r.ok ? 1 : 0, r.ok ? null : `subscribe: ${r.error}`, tid);
  return { ok: r.ok, error: r.error };
}

async function unsubscribeWebhooks(tid: number): Promise<void> {
  const creds = igCredentials(tid);
  if (!creds || creds.source !== 'oauth') return;
  try {
    const url = new URL(`${graphBase()}/${creds.igUserId}/subscribed_apps`);
    url.searchParams.set('access_token', creds.accessToken);
    await fetch(url, { method: 'DELETE' });
  } catch {}
}

/* ------------------------------------------------------------------ */
/* OAuth callback                                                       */
/* ------------------------------------------------------------------ */
export interface CallbackResult { tid: number; igUserId: string; username: string | null; webhookSubscribed: boolean; starterRulesCreated: number }

/**
 * Complete the OAuth dance. Throws IgError(code) — the route turns the code into `?error=<code>`.
 * `base` = the public base URL used to build the redirect_uri (must equal the one used for /connect).
 */
export async function handleCallback(params: { code?: string | null; state?: string | null; error?: string | null; errorReason?: string | null }, base: string): Promise<CallbackResult> {
  if (!instagramConfigured()) throw new IgError('not_configured', 'Instagram connect is not configured on this server (META_APP_ID/META_APP_SECRET).');
  const st = verifyState(params.state);
  if (!st) throw new IgError('state', 'The sign-in link expired or was tampered with. Try again.');
  if (params.error || !params.code) throw new IgError(params.errorReason === 'user_denied' || params.error === 'access_denied' ? 'denied' : 'oauth', params.error || 'Instagram returned no authorization code.');
  const tid = st.tid;
  if (!getTenant(tid)) throw new IgError('tenant', 'Account not found.');

  // 1. code → short-lived token
  let shortToken = '', appScopedId = '', permissions = '';
  try {
    const form = new URLSearchParams({ client_id: config.metaAppId, client_secret: config.metaAppSecret, grant_type: 'authorization_code', redirect_uri: redirectUri(base), code: params.code });
    const res = await fetch('https://api.instagram.com/oauth/access_token', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: form.toString() });
    const data = await readJson(res);
    if (!res.ok || !data?.access_token) throw new Error(errorOf(data, res.status).message);
    shortToken = String(data.access_token);
    appScopedId = data.user_id !== undefined && data.user_id !== null ? String(data.user_id) : '';
    permissions = Array.isArray(data.permissions) ? data.permissions.join(',') : String(data.permissions || '');
  } catch (e: any) {
    throw new IgError('exchange', `Could not exchange the code: ${e?.message || e}`);
  }

  // 2. long-lived token (60 days). If this fails we keep the short-lived one (1 h) and let the refresh job / user retry.
  let accessToken = shortToken, expiresAt: number | null = now() + 3600;
  const ll = await igGet<{ access_token: string; expires_in?: number }>('https://graph.instagram.com/access_token', { grant_type: 'ig_exchange_token', client_secret: config.metaAppSecret }, shortToken, true);
  if (ll.ok && ll.data?.access_token) {
    accessToken = ll.data.access_token;
    expiresAt = now() + (Number(ll.data.expires_in) || 60 * 86400);
  }

  // 3. profile
  const me = await igGet<MeProfile>('me', { fields: ME_FIELDS }, accessToken);
  if (!me.ok || !me.data) throw new IgError('profile', `Could not load the Instagram profile: ${me.error}`);
  const p = me.data;
  const igUserId = String(p.user_id || p.id || appScopedId || '');
  if (!igUserId) throw new IgError('profile', 'Instagram returned no account id.');
  const scopes = permissions || IG_SCOPES.join(',');
  const t = now();

  // 4. upsert + settings mirror (so the existing automations code path keeps working)
  const d = db();
  d.transaction(() => {
    d.prepare(`INSERT INTO ig_accounts (tenant_id, ig_user_id, app_scoped_id, username, name, profile_picture_url, account_type, followers_count, follows_count, media_count, access_token_enc, token_expires_at, scopes, connected_at, refreshed_at, last_error, webhook_subscribed)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 0)
      ON CONFLICT(tenant_id) DO UPDATE SET ig_user_id = excluded.ig_user_id, app_scoped_id = excluded.app_scoped_id, username = excluded.username, name = excluded.name, profile_picture_url = excluded.profile_picture_url,
        account_type = excluded.account_type, followers_count = excluded.followers_count, follows_count = excluded.follows_count, media_count = excluded.media_count, access_token_enc = excluded.access_token_enc,
        token_expires_at = excluded.token_expires_at, scopes = excluded.scopes, connected_at = excluded.connected_at, refreshed_at = excluded.refreshed_at, last_error = NULL`)
      .run(tid, igUserId, appScopedId || p.id || null, p.username ?? null, p.name ?? null, p.profile_picture_url ?? null, p.account_type ?? null, p.followers_count ?? null, p.follows_count ?? null, p.media_count ?? null,
        encryptSecret(accessToken, 'ig'), expiresAt, scopes, t, t);
    setSetting(tid, 'ig_user_id', igUserId);
    setSetting(tid, 'ig_access_token', accessToken);
    // Webhooks for OAuth-connected accounts are signed by THIS server's Meta app: services/automations.metaConfig()
    // falls back to META_APP_SECRET / META_VERIFY_TOKEN for any tenant with an ig_accounts row (nothing to mirror here).
    if (p.username) setMeta(tid, 'ig_username', p.username);
    d.prepare('INSERT INTO ig_snapshots (tenant_id, taken_at, followers_count, follows_count, media_count) VALUES (?, ?, ?, ?, ?)').run(tid, t, p.followers_count ?? null, p.follows_count ?? null, p.media_count ?? null);
  })();

  // 5. webhooks (best effort) + 6. starter rules (best effort, only when the tenant has no rules yet)
  const sub = await subscribeWebhooks(tid);
  let starterRulesCreated = 0;
  try { starterRulesCreated = ensureStarterRules(tid, { onlyIfEmpty: true }).created; } catch (e: any) { console.warn('[instagram] starter rules failed', e?.message || e); }
  try { logSystemEvent(tid, `Instagram connected as @${p.username || igUserId}${sub.ok ? ' — webhooks subscribed' : ` — webhook subscription failed: ${sub.error}`}`, null, sub.ok ? 'ok' : 'error'); } catch {}
  return { tid, igUserId, username: p.username ?? null, webhookSubscribed: sub.ok, starterRulesCreated };
}

/* ------------------------------------------------------------------ */
/* Disconnect                                                           */
/* ------------------------------------------------------------------ */
/**
 * Remove the connected account: row + mirrored settings (+ mirrored app secret / verify token for non-owner tenants),
 * best-effort webhook unsubscribe. `wipe` additionally deletes automation contacts/events and the analytics cache
 * (Meta data-deletion callback).
 */
export async function disconnect(tid: number, opts: { unsubscribe?: boolean; wipe?: boolean; reason?: string } = {}): Promise<{ ok: boolean; existed: boolean }> {
  const row = getAccountRow(tid);
  if (row && opts.unsubscribe !== false) await unsubscribeWebhooks(tid);
  const d = db();
  d.transaction(() => {
    d.prepare('DELETE FROM ig_accounts WHERE tenant_id = ?').run(tid);
    if (row) {
      // only clear the mirrored settings when they are the ones we wrote (an owner may have pasted their own)
      if (getSetting(tid, 'ig_access_token') === tryDecryptSecret(row.access_token_enc, 'ig') || getSetting(tid, 'ig_user_id') === row.ig_user_id) {
        setSetting(tid, 'ig_access_token', null);
        setSetting(tid, 'ig_user_id', null);
      }
      if (tid !== OWNER_TENANT) {
        if (getSetting(tid, 'meta_app_secret') === config.metaAppSecret) setSetting(tid, 'meta_app_secret', null);
        if (config.metaVerifyToken && getSetting(tid, 'meta_verify_token') === config.metaVerifyToken) setSetting(tid, 'meta_verify_token', null);
      }
    } else if (opts.wipe) {
      setSetting(tid, 'ig_access_token', null);
      setSetting(tid, 'ig_user_id', null);
    }
    if (opts.wipe) {
      d.prepare('DELETE FROM automation_contacts WHERE tenant_id = ?').run(tid);
      d.prepare('DELETE FROM automation_events WHERE tenant_id = ?').run(tid);
      d.prepare('DELETE FROM ig_media WHERE tenant_id = ?').run(tid);
      d.prepare('DELETE FROM ig_insights_daily WHERE tenant_id = ?').run(tid);
      d.prepare('DELETE FROM ig_snapshots WHERE tenant_id = ?').run(tid);
      setMeta(tid, 'ig_analytics_refreshed_at', null);
      setMeta(tid, 'ig_analytics_totals', null);
    }
  })();
  if (row && !opts.wipe) { try { logSystemEvent(tid, `Instagram disconnected${opts.reason ? ` (${opts.reason})` : ''}`); } catch {} }
  return { ok: true, existed: !!row };
}

/* ------------------------------------------------------------------ */
/* Token refresh                                                        */
/* ------------------------------------------------------------------ */
export async function refreshToken(tid: number): Promise<{ ok: boolean; expiresAt?: number; error?: string }> {
  const row = getAccountRow(tid);
  if (!row) return { ok: false, error: 'not connected' };
  const token = tryDecryptSecret(row.access_token_enc, 'ig');
  if (!token) return { ok: false, error: 'token undecryptable (SESSION_SECRET changed?) — reconnect' };
  const r = await igGet<{ access_token: string; expires_in?: number }>('https://graph.instagram.com/refresh_access_token', { grant_type: 'ig_refresh_token' }, token, true);
  if (!r.ok || !r.data?.access_token) {
    noteError(tid, `refresh: ${r.error}`);
    return { ok: false, error: r.error || 'refresh failed' };
  }
  const expiresAt = now() + (Number(r.data.expires_in) || 60 * 86400);
  const d = db();
  d.transaction(() => {
    d.prepare('UPDATE ig_accounts SET access_token_enc = ?, token_expires_at = ?, refreshed_at = ?, last_error = NULL WHERE tenant_id = ?').run(encryptSecret(r.data!.access_token, 'ig'), expiresAt, now(), tid);
    setSetting(tid, 'ig_access_token', r.data!.access_token);
  })();
  return { ok: true, expiresAt };
}

/** Refresh every connected token that expires in < 10 days (or has an unknown expiry and wasn't refreshed for 30 days). */
export async function refreshExpiringTokens(): Promise<{ checked: number; refreshed: number; failed: number }> {
  const t = now();
  const rows = db().prepare('SELECT tenant_id, token_expires_at, refreshed_at FROM ig_accounts WHERE (token_expires_at IS NOT NULL AND token_expires_at < ?) OR (token_expires_at IS NULL AND COALESCE(refreshed_at, 0) < ?)').all(t + REFRESH_WINDOW_S, t - 30 * 86400) as Array<{ tenant_id: number }>;
  let refreshed = 0, failed = 0;
  for (const r of rows) {
    const res = await refreshToken(r.tenant_id);
    if (res.ok) refreshed++; else { failed++; try { logSystemEvent(r.tenant_id, `Instagram token refresh failed: ${res.error}`, null, 'error'); } catch {} }
  }
  return { checked: rows.length, refreshed, failed };
}

/* ------------------------------------------------------------------ */
/* Meta signed_request (deauthorize / data deletion callbacks)          */
/* ------------------------------------------------------------------ */
export interface SignedRequestPayload { user_id?: string; algorithm?: string; issued_at?: number; [k: string]: unknown }

/** Parse & verify a Meta `signed_request` (base64url(sig).base64url(json), HMAC-SHA256 with the app secret). */
export function parseSignedRequest(signedRequest: string | undefined | null, appSecret = config.metaAppSecret): SignedRequestPayload | null {
  if (!signedRequest || !appSecret) return null;
  const [sigB, payloadB] = String(signedRequest).split('.', 2);
  if (!sigB || !payloadB) return null;
  let sig: Buffer;
  try { sig = Buffer.from(sigB, 'base64url'); } catch { return null; }
  const expected = crypto.createHmac('sha256', appSecret).update(payloadB).digest();
  if (sig.length !== expected.length || !crypto.timingSafeEqual(sig, expected)) return null;
  try {
    const data = JSON.parse(Buffer.from(payloadB, 'base64url').toString('utf8'));
    if (data?.algorithm && String(data.algorithm).toUpperCase() !== 'HMAC-SHA256') return null;
    if (data?.user_id !== undefined) data.user_id = String(data.user_id);
    return data as SignedRequestPayload;
  } catch { return null; }
}

/* ------------------------------------------------------------------ */
/* Starter rules (spec §2)                                              */
/* ------------------------------------------------------------------ */
export type StarterKey = 'comment_link' | 'dm_welcome' | 'story_thanks';
export interface StarterTemplate {
  key: StarterKey;
  name: string;
  description: string;
  trigger_type: Rule['trigger_type'];
  match_mode: Rule['match_mode'];
  keywords: string[];
  reply_text: string;
  cooldown_minutes: number;
  priority: number;
}

export const STARTER_TEMPLATES: StarterTemplate[] = [
  { key: 'comment_link', name: 'Comment keyword → DM the link', description: 'Someone comments a keyword on any post; they get a DM with your link.', trigger_type: 'comment_keyword', match_mode: 'contains', keywords: ['link', 'send', 'guide'], reply_text: "Hey {{username}} — here's the link you asked for: <paste your link>", cooldown_minutes: 1440, priority: 10 },
  { key: 'dm_welcome', name: 'First DM → welcome', description: 'Someone sends a greeting in DMs; they get a short welcome (once a week per person).', trigger_type: 'dm_keyword', match_mode: 'contains', keywords: ['hi', 'hello', 'hey'], reply_text: "Hey {{username}}, thanks for writing! I read every message and answer as soon as I can. What can I help you with?", cooldown_minutes: 10080, priority: 50 },
  { key: 'story_thanks', name: 'Story reply → thanks', description: 'Someone replies to your story; they get a thank-you DM.', trigger_type: 'story_reply', match_mode: 'contains', keywords: [], reply_text: 'Thanks for replying to my story, {{username}}! I read every reply — what did you think?', cooldown_minutes: 1440, priority: 60 },
];

const STARTER_META_KEY = 'starter_rules';

export interface StarterRule extends Rule { starter_key: StarterKey }
export interface StarterResult { rules: StarterRule[]; created: number; leftOut: number; quota: QuotaCheck | null; skipped: 'has_rules' | null }

/**
 * Create the starter rules that are missing (disabled), idempotently: a meta mapping starter key → rule id remembers
 * which rule is which; a rule the user deleted counts as missing. Rules are metered: creation stops at the plan's
 * `rules` allowance (`leftOut` says how many did not fit). `onlyIfEmpty` (first connect): skip when the tenant already has rules.
 */
export function ensureStarterRules(tid: number, opts: { onlyIfEmpty?: boolean } = {}): StarterResult {
  const d = db();
  const existing = listRules(tid);
  const map = j<Partial<Record<StarterKey, number>>>(getMeta(tid, STARTER_META_KEY), {});
  const byId = new Map(existing.map((r) => [r.id, r]));
  if (opts.onlyIfEmpty && existing.length > 0) {
    return { rules: starterRulesFrom(map, byId), created: 0, leftOut: 0, quota: null, skipped: 'has_rules' };
  }
  let created = 0, leftOut = 0;
  let quota: QuotaCheck | null = null;
  const t = now();
  const insert = d.prepare(`INSERT INTO automation_rules (tenant_id, name, enabled, trigger_type, match_mode, keywords, reply_text, reply_link, public_reply_text, cooldown_minutes, priority, created_at, updated_at)
    VALUES (?, ?, 0, ?, ?, ?, ?, NULL, NULL, ?, ?, ?, ?)`);
  for (const tpl of STARTER_TEMPLATES) {
    const id = map[tpl.key];
    if (id && byId.has(id)) continue;
    const q = checkQuota(tid, 'rules', 1);
    quota = q;
    if (!q.ok) { leftOut++; continue; }
    const info = insert.run(tid, tpl.name, tpl.trigger_type, tpl.match_mode, JSON.stringify(tpl.keywords), tpl.reply_text, tpl.cooldown_minutes, tpl.priority, t, t);
    map[tpl.key] = Number(info.lastInsertRowid);
    created++;
  }
  setMeta(tid, STARTER_META_KEY, JSON.stringify(map));
  const rules = starterRulesFrom(map, new Map(listRules(tid).map((r) => [r.id, r])));
  if (!quota) quota = checkQuota(tid, 'rules', 1);
  return { rules, created, leftOut, quota, skipped: null };
}

/** The starter rules that currently exist (no side effects). */
export function starterRules(tid: number): StarterRule[] {
  const map = j<Partial<Record<StarterKey, number>>>(getMeta(tid, STARTER_META_KEY), {});
  return starterRulesFrom(map, new Map(listRules(tid).map((r) => [r.id, r])));
}

function starterRulesFrom(map: Partial<Record<StarterKey, number>>, byId: Map<number, Rule>): StarterRule[] {
  const out: StarterRule[] = [];
  for (const tpl of STARTER_TEMPLATES) {
    const id = map[tpl.key];
    const r = id ? byId.get(id) : undefined;
    if (r) out.push({ ...r, starter_key: tpl.key });
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* OWNER_PLAN (spec §0)                                                 */
/* ------------------------------------------------------------------ */
/**
 * Apply `OWNER_PLAN` to tenant 1 at boot (default 'owner' = unlimited). Lets the operator dogfood the trial/pro/studio
 * limits with their own account. Admin powers stay keyed on users.is_owner / tenant 1, not on the plan.
 */
export function applyOwnerPlan(): PlanId | null {
  const want = config.ownerPlan as PlanId;
  const t = getTenant(OWNER_TENANT);
  if (!t) return null;
  if (t.plan === want && (want === 'owner' || t.plan_status === 'active')) return null;
  updateTenant(OWNER_TENANT, { plan: want, plan_status: 'active', plan_renews_at: null, trial_ends_at: null });
  console.log(`[plans] owner tenant plan set to '${want}' (OWNER_PLAN)`);
  return want;
}

/* ------------------------------------------------------------------ */
/* Jobs                                                                 */
/* ------------------------------------------------------------------ */
let jobsStarted = false;
/** Idempotent boot hook: OWNER_PLAN + the 12-hourly token refresh. Called once from routes/extra.ts (mountProtectedExtras). Never throws. */
export function startInstagramJobs(): void {
  if (jobsStarted) return;
  jobsStarted = true;
  try { applyOwnerPlan(); } catch (e: any) { console.warn('[plans] applyOwnerPlan failed', e?.message || e); }
  const tick = async () => {
    try {
      const r = await refreshExpiringTokens();
      if (r.checked) console.log(`[instagram] token refresh: ${r.refreshed}/${r.checked} refreshed${r.failed ? `, ${r.failed} failed` : ''}`);
    } catch (e: any) { console.warn('[instagram] token refresh job failed', e?.message || e); }
  };
  const first = setTimeout(tick, 45_000);
  first.unref?.();
  const every = setInterval(tick, REFRESH_EVERY_MS);
  every.unref?.();
}

/** Test hook. */
export function _resetInstagramJobsForTests() { jobsStarted = false; }
