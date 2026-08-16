import crypto from 'node:crypto';
import type { Context, Next } from 'hono';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import { config } from './config.js';
import { db, OWNER_TENANT } from './db.js';
import type { TenantSession } from './types.js';

declare module 'hono' {
  interface ContextVariableMap {
    tenant: TenantSession;
  }
}

const COOKIE = 'rs_session';

function sign(payload: string): string {
  return crypto.createHmac('sha256', config.sessionSecret).update(payload).digest('base64url');
}

/** Cookie payload: { u, tid, uid, iat, exp }. Legacy cookies (no tid) are still accepted as the tenant-1 owner. */
export function createSessionToken(username: string, tid = OWNER_TENANT, uid = 0): string {
  const payload = Buffer.from(JSON.stringify({ u: username, tid, uid, iat: Date.now(), exp: Date.now() + config.sessionDays * 86400_000 })).toString('base64url');
  return `${payload}.${sign(payload)}`;
}

/** Positive session validations for non-owner tenants are cached briefly (avoids two lookups per request). */
const validCache = new Map<string, number>();
function tenantSessionValid(tid: number, uid: number): boolean {
  const key = `${tid}:${uid}`;
  const t = Date.now();
  const until = validCache.get(key);
  if (until && until > t) return true;
  const row = db().prepare('SELECT t.deleted_at AS deleted, (SELECT COUNT(*) FROM users u WHERE u.id = ? AND u.tenant_id = t.id) AS users FROM tenants t WHERE t.id = ?').get(uid, tid) as { deleted: number | null; users: number } | undefined;
  const ok = !!row && !row.deleted && row.users > 0;
  if (ok) {
    validCache.set(key, t + 30_000);
    if (validCache.size > 10_000) validCache.clear();
  }
  return ok;
}
/** Drop cached validations (account deleted, user removed). */
export function invalidateSessions(tid: number) {
  for (const k of validCache.keys()) if (k.startsWith(`${tid}:`)) validCache.delete(k);
}

export function verifySessionToken(token: string | undefined): TenantSession | null {
  if (!token) return null;
  const idx = token.lastIndexOf('.');
  if (idx <= 0) return null;
  const payload = token.slice(0, idx);
  const sig = token.slice(idx + 1);
  const expected = sign(payload);
  const a = Buffer.from(sig), b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (typeof data.exp !== 'number' || data.exp < Date.now()) return null;
    if (typeof data.u !== 'string') return null;
    if (data.tid === undefined) {
      // legacy single-user cookie → owner tenant
      if (data.u !== config.appUsername) return null;
      return { u: data.u, tid: OWNER_TENANT, uid: 0, isOwner: true };
    }
    const tid = Number(data.tid), uid = Number(data.uid || 0);
    if (!Number.isInteger(tid) || tid < 1) return null;
    if (tid === OWNER_TENANT) {
      if (data.u !== config.appUsername) return null;
      return { u: data.u, tid, uid, isOwner: true };
    }
    if (!tenantSessionValid(tid, uid)) return null;
    return { u: data.u, tid, uid, isOwner: false };
  } catch {
    return null;
  }
}

export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) {
    // still do a comparison to keep timing roughly constant
    crypto.timingSafeEqual(ab, ab);
    return false;
  }
  return crypto.timingSafeEqual(ab, bb);
}

/* ---------------- password hashing (hosted users): scrypt$N$salt$hash ---------------- */
const SCRYPT_N = 16384;
export function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16).toString('base64url');
  const hash = crypto.scryptSync(password, salt, 64, { N: SCRYPT_N, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }).toString('base64url');
  return `scrypt$${SCRYPT_N}$${salt}$${hash}`;
}
export function verifyPassword(password: string, stored: string | null | undefined): boolean {
  if (!stored) return false;
  const [algo, nStr, salt, hash] = stored.split('$');
  if (algo !== 'scrypt' || !salt || !hash) return false;
  const N = Number(nStr) || SCRYPT_N;
  try {
    const got = crypto.scryptSync(password, salt, 64, { N, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
    const want = Buffer.from(hash, 'base64url');
    return got.length === want.length && crypto.timingSafeEqual(got, want);
  } catch {
    return false;
  }
}

export function isHttps(c: Context): boolean {
  const proto = c.req.header('x-forwarded-proto');
  if (proto) return proto.split(',')[0].trim() === 'https';
  return new URL(c.req.url).protocol === 'https:';
}

export function setSessionCookie(c: Context, token: string) {
  setCookie(c, COOKIE, token, {
    httpOnly: true,
    sameSite: 'Lax',
    secure: isHttps(c),
    path: '/',
    maxAge: config.sessionDays * 86400,
  });
}

export function clearSessionCookie(c: Context) {
  deleteCookie(c, COOKIE, { path: '/' });
}

/** Session of the current request (from the middleware when available, else decoded from the cookie). */
export function currentTenant(c: Context): TenantSession | null {
  const set = c.get('tenant');
  if (set) return set;
  return verifySessionToken(getCookie(c, COOKIE));
}
/** Backward-compatible alias. */
export function currentUser(c: Context): { u: string } | null {
  const t = currentTenant(c);
  return t ? { u: t.u } : null;
}
/** Tenant id of the current request. Only call behind `requireAuth` (or after resolving a tenant yourself). */
export function tid(c: Context): number {
  const t = currentTenant(c);
  if (!t) throw new Error('no session');
  return t.tid;
}

/**
 * Login rate limiter: 8 attempts / 10 min per client, PLUS a global cap of 60 attempts / 10 min
 * (so spoofing X-Forwarded-For cannot buy unlimited guesses). Bounded memory.
 */
const attempts = new Map<string, { n: number; reset: number }>();
let global = { n: 0, reset: 0 };
export function loginAllowed(ip: string): boolean {
  const nowMs = Date.now();
  if (global.reset < nowMs) global = { n: 0, reset: nowMs + 10 * 60_000 };
  global.n += 1;
  if (global.n > 60) return false;
  if (attempts.size > 2000) for (const [k, v] of attempts) if (v.reset < nowMs) attempts.delete(k);
  if (attempts.size > 5000) attempts.clear();
  const rec = attempts.get(ip);
  if (!rec || rec.reset < nowMs) {
    attempts.set(ip, { n: 1, reset: nowMs + 10 * 60_000 });
    return true;
  }
  rec.n += 1;
  return rec.n <= 8;
}
export function loginSucceeded(ip: string) {
  attempts.delete(ip);
}

/** Signup rate limiter: 5 / minute / IP. */
const signups = new Map<string, { n: number; reset: number }>();
export function signupAllowed(ip: string): boolean {
  const nowMs = Date.now();
  if (signups.size > 5000) for (const [k, v] of signups) if (v.reset < nowMs) signups.delete(k);
  const rec = signups.get(ip);
  if (!rec || rec.reset < nowMs) { signups.set(ip, { n: 1, reset: nowMs + 60_000 }); return true; }
  rec.n += 1;
  return rec.n <= 5;
}

/** Client IP: the LAST X-Forwarded-For entry is the one appended by the trusted edge proxy (Railway/nginx); the first is client-controlled. */
export function clientIp(c: Context): string {
  const xff = (c.req.header('x-forwarded-for') || '').split(',').map((s) => s.trim()).filter(Boolean);
  return xff[xff.length - 1] || c.req.header('x-real-ip') || 'local';
}

/** Hono middleware protecting API routes: verifies the session and attaches the tenant to the context. */
export async function requireAuth(c: Context, next: Next) {
  const session = verifySessionToken(getCookie(c, COOKIE));
  if (!session) return c.json({ error: 'unauthorized' }, 401);
  c.set('tenant', session);
  await next();
}
