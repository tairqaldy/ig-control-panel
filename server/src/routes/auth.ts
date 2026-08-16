import { Hono } from 'hono';
import { config } from '../config.js';
import { clearSessionCookie, clientIp, createSessionToken, currentUser, loginAllowed, loginSucceeded, safeEqual, setSessionCookie } from '../auth.js';
import { hasOpenAI } from '../services/openai.js';

export const auth = new Hono();

function setupIssues(): string[] {
  const issues: string[] = [];
  if (!config.appUsername || !config.appPasscode) issues.push('APP_USERNAME / APP_PASSCODE are not set — login is disabled until you set them.');
  if (!hasOpenAI()) issues.push('OPENAI_API_KEY is not set — imports work, but analysis, transcription, search-by-meaning and Ask are disabled.');
  return issues;
}

auth.get('/me', (c) => {
  const u = currentUser(c);
  return c.json({ authenticated: !!u, username: u?.u || null, setupIssues: setupIssues(), loginEnabled: !!(config.appUsername && config.appPasscode) });
});

auth.post('/login', async (c) => {
  const ip = clientIp(c);
  if (!loginAllowed(ip)) return c.json({ error: 'Too many attempts. Try again in a few minutes.' }, 429);
  const body = await c.req.json<{ username?: string; passcode?: string }>().catch(() => ({}) as any);
  const username = String(body.username || '').trim();
  const passcode = String(body.passcode || '');
  if (!config.appUsername || !config.appPasscode) return c.json({ error: 'Login is not configured on the server (set APP_USERNAME and APP_PASSCODE).' }, 503);
  const ok = safeEqual(username, config.appUsername) && safeEqual(passcode, config.appPasscode);
  if (!ok) return c.json({ error: 'Wrong username or passcode.' }, 401);
  loginSucceeded(ip);
  setSessionCookie(c, createSessionToken(username));
  return c.json({ ok: true, username });
});

auth.post('/logout', (c) => {
  clearSessionCookie(c);
  return c.json({ ok: true });
});
