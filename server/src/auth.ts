import crypto from 'node:crypto';
import type { Context, Next } from 'hono';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import { config } from './config.js';

const COOKIE = 'rs_session';

function sign(payload: string): string {
  return crypto.createHmac('sha256', config.sessionSecret).update(payload).digest('base64url');
}

export function createSessionToken(username: string): string {
  const payload = Buffer.from(JSON.stringify({ u: username, iat: Date.now(), exp: Date.now() + config.sessionDays * 86400_000 })).toString('base64url');
  return `${payload}.${sign(payload)}`;
}

export function verifySessionToken(token: string | undefined): { u: string } | null {
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
    if (data.u !== config.appUsername) return null;
    return { u: data.u };
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

export function currentUser(c: Context): { u: string } | null {
  return verifySessionToken(getCookie(c, COOKIE));
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

/** Client IP: the LAST X-Forwarded-For entry is the one appended by the trusted edge proxy (Railway/nginx); the first is client-controlled. */
export function clientIp(c: Context): string {
  const xff = (c.req.header('x-forwarded-for') || '').split(',').map((s) => s.trim()).filter(Boolean);
  return xff[xff.length - 1] || c.req.header('x-real-ip') || 'local';
}

/** Hono middleware protecting API routes. */
export async function requireAuth(c: Context, next: Next) {
  const user = currentUser(c);
  if (!user) return c.json({ error: 'unauthorized' }, 401);
  c.set('user' as never, user as never);
  await next();
}
