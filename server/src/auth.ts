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
  if (sig.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
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

/** Simple in-memory login rate limiter: 8 attempts per 10 min per IP. */
const attempts = new Map<string, { n: number; reset: number }>();
export function loginAllowed(ip: string): boolean {
  const nowMs = Date.now();
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

export function clientIp(c: Context): string {
  return (c.req.header('x-forwarded-for') || '').split(',')[0].trim() || c.req.header('x-real-ip') || 'local';
}

/** Hono middleware protecting API routes. */
export async function requireAuth(c: Context, next: Next) {
  const user = currentUser(c);
  if (!user) return c.json({ error: 'unauthorized' }, 401);
  c.set('user' as never, user as never);
  await next();
}
