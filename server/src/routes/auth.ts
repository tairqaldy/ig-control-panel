import { Hono } from 'hono';
import { config } from '../config.js';
import {
  clearSessionCookie, clientIp, createSessionToken, currentTenant, hashPassword, loginAllowed, loginSucceeded, safeEqual, setSessionCookie, signupAllowed, verifyPassword,
} from '../auth.js';
import { db, now, OWNER_TENANT, ownerEmail } from '../db.js';
import { hasOpenAI } from '../services/openai.js';
import { getTenant, planPayload } from '../services/plans.js';
import { missingPaywallConfig, requiresPaymentAtSignup } from '../services/paywall.js';
import type { TenantRow, UserRow } from '../types.js';

export const auth = new Hono();

const ownerLoginEnabled = () => !!(config.appUsername && config.appPasscode);

function setupIssues(): string[] {
  const issues: string[] = [];
  if (!ownerLoginEnabled()) issues.push('APP_USERNAME / APP_PASSCODE are not set — login is disabled until you set them.');
  if (!hasOpenAI(OWNER_TENANT)) issues.push('OPENAI_API_KEY is not set — imports work, but analysis, transcription, search-by-meaning and Ask are disabled.');
  // /security says the key that encrypts Instagram tokens lives only in the deployment environment. On a hosted
  // deploy without SESSION_SECRET it lives on the same volume as the database, which makes that sentence untrue.
  if (config.hosted && !(process.env.SESSION_SECRET && process.env.SESSION_SECRET.length >= 16)) {
    issues.push('SESSION_SECRET is not set — the key that encrypts Instagram tokens is stored on the data volume beside the database it protects. Set it in the deployment environment (it signs everyone out once, and stored Instagram tokens have to be reconnected).');
  }
  // The paywall turns itself off rather than trap people; without this line the operator would never learn it did.
  if (config.trialRequiresCard) {
    const missing = missingPaywallConfig();
    if (missing.length) issues.push(`TRIAL_REQUIRES_CARD is on but ${missing.join(', ')} ${missing.length === 1 ? 'is' : 'are'} not set — new signups start without a card until that is fixed.`);
  }
  return issues;
}

function userById(uid: number): UserRow | undefined {
  return uid ? (db().prepare('SELECT * FROM users WHERE id = ?').get(uid) as UserRow | undefined) : undefined;
}

auth.get('/me', (c) => {
  const s = currentTenant(c);
  const user = s ? userById(s.uid) : undefined;
  const email = s ? (s.isOwner ? user?.email || ownerEmail() : user?.email || s.u) : null;
  const tenant: TenantRow | undefined = s ? getTenant(s.tid) : undefined;
  return c.json({
    authenticated: !!s,
    username: s?.u || null,
    email,
    tenantId: s?.tid ?? null,
    tenantName: tenant?.name ?? null,
    isOwner: s?.isOwner ?? false,
    hosted: config.hosted,
    signupsEnabled: config.signupsEnabled,
    plan: s ? planPayload(s.tid) : null,
    // server setup hints are for the operator only — hosted tenants never see env details
    setupIssues: !s ? (config.hosted ? [] : setupIssues()) : s.isOwner ? setupIssues() : [],
    loginEnabled: ownerLoginEnabled() || config.hosted,
  });
});

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

auth.post('/login', async (c) => {
  const ip = clientIp(c);
  if (!loginAllowed(ip)) return c.json({ error: 'Too many attempts. Try again in a few minutes.' }, 429);
  const body = await c.req.json<{ username?: string; email?: string; passcode?: string; password?: string }>().catch(() => ({}) as any);
  const username = String(body.username || body.email || '').trim();
  const passcode = String(body.passcode ?? body.password ?? '');
  if (!username || !passcode) return c.json({ error: 'Enter your email/username and password.' }, 400);

  // 1) owner (env credentials) → tenant 1
  if (ownerLoginEnabled() && safeEqual(username, config.appUsername) && safeEqual(passcode, config.appPasscode)) {
    loginSucceeded(ip);
    const owner = db().prepare('SELECT * FROM users WHERE tenant_id = 1 AND is_owner = 1').get() as UserRow | undefined;
    if (owner) db().prepare('UPDATE users SET last_login_at = ? WHERE id = ?').run(now(), owner.id);
    setSessionCookie(c, createSessionToken(username, OWNER_TENANT, owner?.id || 0));
    return c.json({ ok: true, username, tenantId: OWNER_TENANT, isOwner: true });
  }
  // 2) hosted users (email + scrypt password)
  if (config.hosted || config.signupsEnabled) {
    const user = db().prepare('SELECT * FROM users WHERE email = ? COLLATE NOCASE').get(username.toLowerCase()) as UserRow | undefined;
    if (user && user.password_hash && verifyPassword(passcode, user.password_hash)) {
      const t = getTenant(user.tenant_id);
      if (!t || t.deleted_at) return c.json({ error: 'This account has been deleted.' }, 401);
      loginSucceeded(ip);
      db().prepare('UPDATE users SET last_login_at = ? WHERE id = ?').run(now(), user.id);
      setSessionCookie(c, createSessionToken(user.email, user.tenant_id, user.id));
      return c.json({ ok: true, username: user.email, tenantId: user.tenant_id, isOwner: false });
    }
  } else if (!ownerLoginEnabled()) {
    return c.json({ error: 'Login is not configured on the server (set APP_USERNAME and APP_PASSCODE).' }, 503);
  }
  return c.json({ error: config.hosted ? 'Wrong email or password.' : 'Wrong username or passcode.' }, 401);
});

/** Hosted signup: creates a tenant on a trial + its first user, and signs them in. */
auth.post('/signup', async (c) => {
  if (!config.signupsEnabled) return c.json({ error: 'Signups are disabled on this server.' }, 404);
  const ip = clientIp(c);
  if (!signupAllowed(ip)) return c.json({ error: 'Too many signups from this address. Try again in a minute.' }, 429);
  const body = await c.req.json<{ email?: string; password?: string; name?: string }>().catch(() => ({}) as any);
  const email = String(body.email || '').trim().toLowerCase();
  const password = String(body.password || '');
  const name = String(body.name || '').trim().slice(0, 80) || null;
  if (!EMAIL_RE.test(email) || email.length > 200) return c.json({ error: 'Enter a valid email address.' }, 400);
  if (password.length < 8) return c.json({ error: 'Password must be at least 8 characters.' }, 400);
  if (password.length > 200) return c.json({ error: 'Password is too long.' }, 400);
  const ownerMail = ownerEmail();
  if (ownerMail && email === ownerMail) return c.json({ error: 'That email is already registered.' }, 409);
  const d = db();
  const existing = d.prepare('SELECT id FROM users WHERE email = ? COLLATE NOCASE').get(email);
  if (existing) return c.json({ error: 'That email is already registered. Log in instead.' }, 409);
  const t = now();
  const trialEnds = t + config.trialDays * 86400;
  let tenantId = 0, userId = 0;
  d.transaction(() => {
    // requires_payment: only signups made while the paywall is in force start locked — existing tenants stay at 0 (migration 009).
    const info = d.prepare(`INSERT INTO tenants (name, plan, plan_status, trial_ends_at, plan_started_at, requires_payment, created_at, updated_at) VALUES (?, 'trial', 'active', ?, ?, ?, ?, ?)`).run(name || email.split('@')[0], trialEnds, t, requiresPaymentAtSignup(), t, t);
    tenantId = Number(info.lastInsertRowid);
    const u = d.prepare('INSERT INTO users (tenant_id, email, password_hash, is_owner, created_at, last_login_at) VALUES (?, ?, ?, 0, ?, ?)').run(tenantId, email, hashPassword(password), t, t);
    userId = Number(u.lastInsertRowid);
  })();
  setSessionCookie(c, createSessionToken(email, tenantId, userId));
  const tenant = getTenant(tenantId)!;
  // requiresPayment lets the signup form go straight to /start instead of bouncing off a 402 first.
  return c.json({ ok: true, tenant: { id: tenant.id, name: tenant.name, plan: tenant.plan, trialEndsAt: tenant.trial_ends_at }, tenantId, email, requiresPayment: Number(tenant.requires_payment ?? 0) === 1 });
});

auth.post('/logout', (c) => {
  clearSessionCookie(c);
  return c.json({ ok: true });
});
