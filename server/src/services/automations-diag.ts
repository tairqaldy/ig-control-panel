/**
 * Automations diagnostics (round 6, spec §1) — the seven checks behind `GET /api/automations/diagnostics`.
 *
 * The point of this file: when an automation does not fire, the product must say exactly why, in a sentence a
 * non-developer understands. Two of the checks talk to Instagram live (token + webhook subscription); the rest
 * read the database. Every network call has a timeout so the endpoint always answers.
 */
import { config } from '../config.js';
import { db, now } from '../db.js';
import { checkQuota, effectivePlanFor, PLAN_NAMES } from './plans.js';
import { getAccountRow, igCredentials, WEBHOOK_FIELDS } from './instagram.js';
import { keywordsOf, listRules, ruleMediaIds, TRIGGER_LABEL, type Rule } from './automations.js';

export type CheckStatus = 'ok' | 'warn' | 'fail';
export interface CheckFix { label: string; href?: string; action?: string }
export interface Check { id: string; label: string; status: CheckStatus; detail: string; fix?: CheckFix; notes?: string[] }

export interface DiagnosticsPayload {
  checks: Check[];
  summary: { ok: number; warn: number; fail: number };
  lastInboundAt: number | null;
  lastOutboundAt: number | null;
  events24h: number;
  canFire: boolean;
  checkedAt: number;
}

/**
 * Where the "put the app in Live mode" explanation lives — the `#live-mode` anchor sits right above
 * "Getting to Live mode" in `docs/AUTOMATIONS.md`, which also covers Business verification step by step.
 */
export const LIVE_MODE_DOC = 'https://github.com/tairqaldy/resurfly/blob/main/docs/AUTOMATIONS.md#live-mode';
const BILLING_HREF = '/billing';
const CONNECT_HREF = '/api/instagram/connect';
const PROBE_TIMEOUT_MS = 6000;
/** How long an account has to be connected before "we never received an event" means something. */
const QUIET_GRACE_S = 300;

/* ------------------------------------------------------------------ */
/* Small helpers                                                        */
/* ------------------------------------------------------------------ */
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

function dateText(ts: number | null | undefined): string {
  if (!ts) return 'an unknown date';
  return new Date(ts * 1000).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
}

function agoText(ts: number | null | undefined): string {
  if (!ts) return 'never';
  const s = Math.max(0, now() - ts);
  if (s < 90) return 'just now';
  if (s < 5400) return `${plural(Math.round(s / 60), 'minute')} ago`;
  if (s < 172800) return `${plural(Math.round(s / 3600), 'hour')} ago`;
  return `${plural(Math.round(s / 86400), 'day')} ago`;
}

interface Probe { ok: boolean; status: number; data: any; error: string | null; code: number | null; type: string | null }

/** GET graph.instagram.com/{version}/{path} with a hard timeout. Never throws; Instagram's wording is kept verbatim. */
async function probe(path: string, params: Record<string, string>, token: string): Promise<Probe> {
  try {
    const url = new URL(`https://graph.instagram.com/${config.graphApiVersion}/${path.replace(/^\//, '')}`);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    url.searchParams.set('access_token', token);
    const res = await fetch(url, { method: 'GET', signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
    const text = await res.text();
    let data: any = null;
    try { data = JSON.parse(text); } catch { data = { raw: text.slice(0, 500) }; }
    const err = data?.error && typeof data.error === 'object' ? data.error : null;
    if (!res.ok || err) {
      const message = err?.message || `Instagram answered HTTP ${res.status}`;
      const type = typeof err?.type === 'string' ? err.type : null;
      const code = typeof err?.code === 'number' ? err.code : null;
      return { ok: false, status: res.status, data, error: `${type ? `${type}: ` : ''}${message}${code !== null ? ` (code ${code})` : ''}`, code, type };
    }
    return { ok: true, status: res.status, data, error: null, code: null, type: null };
  } catch (e: any) {
    const timedOut = e?.name === 'TimeoutError' || e?.name === 'AbortError';
    return { ok: false, status: 0, data: null, error: timedOut ? `Instagram did not answer within ${PROBE_TIMEOUT_MS / 1000} seconds.` : `Could not reach Instagram: ${e?.message || e}`, code: null, type: null };
  }
}

/** Credits are added by migration 008; read them defensively so diagnostics work before that migration lands. */
function creditBalance(tid: number): number | null {
  try {
    const r = db().prepare('SELECT credits FROM tenants WHERE id = ?').get(tid) as { credits?: number } | undefined;
    return typeof r?.credits === 'number' ? r.credits : null;
  } catch { return null; }
}

function eventStats(tid: number) {
  const d = db();
  const one = (sql: string, ...args: unknown[]) => (d.prepare(sql).get(...args) as any) || {};
  const lastInboundAt = one('SELECT MAX(ts) AS ts FROM automation_events WHERE tenant_id = ? AND direction = ?', tid, 'in').ts ?? null;
  const lastOutboundAt = one("SELECT MAX(ts) AS ts FROM automation_events WHERE tenant_id = ? AND direction = 'out' AND status != 'error'", tid).ts ?? null;
  const events24h = one('SELECT COUNT(*) AS n FROM automation_events WHERE tenant_id = ? AND ts > ?', tid, now() - 86400).n ?? 0;
  const inboundEver = one("SELECT COUNT(*) AS n FROM automation_events WHERE tenant_id = ? AND direction = 'in'", tid).n ?? 0;
  return { lastInboundAt: lastInboundAt as number | null, lastOutboundAt: lastOutboundAt as number | null, events24h: events24h as number, inboundEver: inboundEver as number };
}

/* ------------------------------------------------------------------ */
/* Per-rule notes (check 5)                                             */
/* ------------------------------------------------------------------ */
function knownMediaIds(tid: number): Set<string> {
  try {
    const rows = db().prepare('SELECT id FROM ig_media WHERE tenant_id = ?').all(tid) as Array<{ id: string }>;
    return new Set(rows.map((r) => String(r.id)));
  } catch { return new Set(); }
}

export function ruleNotes(tid: number, rules: Rule[]): string[] {
  const notes: string[] = [];
  const known = knownMediaIds(tid);
  for (const r of rules) {
    if (!r.enabled) continue;
    if (r.trigger_type !== 'story_reply' && r.trigger_type !== 'dm_any' && r.trigger_type !== 'comment_any' && r.trigger_type !== 'dm_first' && !keywordsOf(r).length) {
      notes.push(`"${r.name}" has no keywords, so it can never match.`);
    }
    const media = ruleMediaIds(r);
    if (media.length && known.size) {
      const missing = media.filter((id) => !known.has(id));
      if (missing.length === media.length) notes.push(`"${r.name}" points at ${plural(media.length, 'post')} we can no longer find on your account.`);
      else if (missing.length) notes.push(`"${r.name}" points at ${plural(missing.length, 'post')} we can no longer find on your account.`);
    }
    if (r.last_error && r.last_error_at && now() - r.last_error_at < 7 * 86400) {
      notes.push(`"${r.name}" last failed ${agoText(r.last_error_at)}: ${r.last_error}`);
    }
  }
  return notes;
}

/* ------------------------------------------------------------------ */
/* The checks                                                           */
/* ------------------------------------------------------------------ */
export async function runDiagnostics(tid: number): Promise<DiagnosticsPayload> {
  const checks: Check[] = [];
  const account = getAccountRow(tid);
  const creds = igCredentials(tid);
  const stats = eventStats(tid);
  const rules = listRules(tid);
  const enabled = rules.filter((r) => r.enabled);

  /* 1. connected */
  if (creds) {
    const who = account?.username ? `@${account.username}` : `Instagram account ${creds.igUserId}`;
    const since = account?.connected_at ? ` since ${dateText(account.connected_at)}` : '';
    checks.push({
      id: 'connected',
      label: 'Instagram account',
      status: 'ok',
      detail: creds.source === 'oauth' ? `Connected as ${who}${since}.` : `Using the access token and account id from this server's settings (${who}).`,
    });
  } else {
    checks.push({
      id: 'connected',
      label: 'Instagram account',
      status: 'fail',
      detail: 'No Instagram account is connected, so nothing can trigger a reply.',
      fix: { label: 'Connect Instagram', href: CONNECT_HREF },
    });
  }

  /* 2. permissions — does the stored token still work, and does it carry messages + comments? */
  if (!creds) {
    checks.push({ id: 'permissions', label: 'Access token and permissions', status: 'fail', detail: 'There is no access token to check yet. Connect Instagram first.', fix: { label: 'Connect Instagram', href: CONNECT_HREF } });
  } else {
    const me = await probe('me', { fields: 'id,username' }, creds.accessToken);
    if (!me.ok) {
      checks.push({
        id: 'permissions',
        label: 'Access token and permissions',
        status: 'fail',
        detail: `Instagram rejected the stored access token. It said: ${me.error}`,
        fix: { label: 'Reconnect Instagram', href: CONNECT_HREF },
      });
    } else {
      const scopes = (account?.scopes || '').split(',').map((s) => s.trim()).filter(Boolean);
      const missing = scopes.length
        ? ['instagram_business_manage_messages', 'instagram_business_manage_comments'].filter((s) => !scopes.includes(s))
        : [];
      const username = me.data?.username ? `@${me.data.username}` : `id ${me.data?.id ?? creds.igUserId}`;
      if (missing.length) {
        checks.push({
          id: 'permissions',
          label: 'Access token and permissions',
          status: 'warn',
          detail: `The token works (Instagram answered ${username}) but the connection is missing ${missing.map((m) => (m.includes('messages') ? 'permission to send messages' : 'permission to read and reply to comments')).join(' and ')}. Connect again and accept every permission.`,
          fix: { label: 'Reconnect Instagram', href: CONNECT_HREF },
        });
      } else {
        checks.push({
          id: 'permissions',
          label: 'Access token and permissions',
          status: 'ok',
          detail: `The token works — Instagram answered ${username}${scopes.length ? ', and it covers messages and comments' : ''}.`,
        });
      }
    }
  }

  /* 3. webhook_subscribed — is this app actually subscribed to the account's events? */
  if (!creds) {
    checks.push({ id: 'webhook_subscribed', label: 'Webhook subscription', status: 'fail', detail: 'Instagram can only send us your DMs and comments once an account is connected.', fix: { label: 'Connect Instagram', href: CONNECT_HREF } });
  } else {
    const sub = await probe(`${creds.igUserId}/subscribed_apps`, {}, creds.accessToken);
    const resubscribe: CheckFix = { label: 'Subscribe again', action: 'resubscribe' };
    if (!sub.ok) {
      checks.push({ id: 'webhook_subscribed', label: 'Webhook subscription', status: 'fail', detail: `We could not read the subscription from Instagram. It said: ${sub.error}`, fix: resubscribe });
    } else {
      const entries: any[] = Array.isArray(sub.data?.data) ? sub.data.data : [];
      const fields = new Set<string>();
      for (const e of entries) for (const f of e?.subscribed_fields || []) fields.add(typeof f === 'string' ? f : String(f?.name || ''));
      const missing = ['messages', 'comments'].filter((f) => !fields.has(f));
      if (!entries.length || fields.size === 0) {
        checks.push({ id: 'webhook_subscribed', label: 'Webhook subscription', status: 'fail', detail: 'This app is not subscribed to your account, so Instagram sends us nothing.', fix: resubscribe });
      } else if (missing.length) {
        checks.push({ id: 'webhook_subscribed', label: 'Webhook subscription', status: 'fail', detail: `The subscription is missing ${missing.join(' and ')}, so those events never reach us. Subscribed now: ${Array.from(fields).join(', ')}.`, fix: resubscribe });
      } else {
        checks.push({ id: 'webhook_subscribed', label: 'Webhook subscription', status: 'ok', detail: `Instagram is set to send us ${Array.from(fields).join(', ')} for this account.` });
      }
    }
  }

  /* 4. app_published — the silent killer: a Development-mode app never receives real events. */
  const connectedFor = account?.connected_at ? now() - account.connected_at : creds ? QUIET_GRACE_S + 1 : 0;
  if (creds && !stats.inboundEver && connectedFor > QUIET_GRACE_S) {
    checks.push({
      id: 'app_published',
      label: 'Meta app in Live mode',
      status: 'warn',
      detail: 'Meta only delivers webhooks to apps that are Live. While the app is in Development mode, Instagram never sends us your DMs or comments. We have not received a single event for this account yet, which is what that looks like. Publishing usually waits on one thing: Business verification in Meta Business settings. Once that clears, the Publish button turns on, and an account with a tester role starts receiving automations without App Review.',
      fix: { label: 'How to switch the app to Live', href: LIVE_MODE_DOC },
    });
  } else if (!creds) {
    checks.push({ id: 'app_published', label: 'Meta app in Live mode', status: 'warn', detail: 'We cannot tell whether events are arriving until an Instagram account is connected.', fix: { label: 'How to switch the app to Live', href: LIVE_MODE_DOC } });
  } else if (!stats.inboundEver) {
    checks.push({ id: 'app_published', label: 'Meta app in Live mode', status: 'ok', detail: 'The account was connected a moment ago. Send yourself a DM or comment to confirm events arrive.' });
  } else {
    checks.push({ id: 'app_published', label: 'Meta app in Live mode', status: 'ok', detail: `Events are arriving: the last one was ${agoText(stats.lastInboundAt)}.` });
  }

  /* 5. rules_enabled */
  const notes = ruleNotes(tid, rules);
  if (!enabled.length) {
    checks.push({
      id: 'rules_enabled',
      label: 'Rules',
      status: 'warn',
      detail: rules.length ? `You have ${plural(rules.length, 'rule')}, but ${rules.length === 1 ? 'it is' : 'they are all'} turned off, so nothing replies.` : 'You have no rules yet, so nothing replies.',
      fix: { label: 'Add a rule', href: '/automations' },
    });
  } else {
    checks.push({
      id: 'rules_enabled',
      label: 'Rules',
      status: notes.length ? 'warn' : 'ok',
      detail: notes.length
        ? `${plural(enabled.length, 'rule')} turned on. ${notes.join(' ')}`
        : `${plural(enabled.length, 'rule')} turned on${rules.length > enabled.length ? `, ${rules.length - enabled.length} turned off` : ''}. Nothing looks broken in ${enabled.length === 1 ? 'it' : 'them'}.`,
      ...(notes.length ? { notes } : {}),
    });
  }

  /* 6. sends_quota */
  const plan = effectivePlanFor(tid);
  const q = checkQuota(tid, 'sends', 1);
  const credits = creditBalance(tid);
  const creditSentence = credits && credits > 0 ? ` You also have ${plural(credits, 'credit')} in reserve — one credit covers 20 replies.` : '';
  if (q.limit === Infinity) {
    checks.push({ id: 'sends_quota', label: 'Replies included in your plan', status: 'ok', detail: `Your plan includes unlimited automated replies. ${q.used} sent this month.` });
  } else if (!q.ok && !(credits && credits > 0)) {
    checks.push({
      id: 'sends_quota',
      label: 'Replies included in your plan',
      status: 'fail',
      detail: plan === 'free'
        ? 'Automated replies are paused because the trial ended. Rules stay saved and start again as soon as you pick a plan.'
        : `You have used all ${q.limit} automated replies included in ${PLAN_NAMES[plan]} this month. Nothing sends until ${dateText(q.resetsAt)}.`,
      fix: { label: 'See plans', href: BILLING_HREF },
    });
  } else if (q.remaining <= 0) {
    // The monthly allowance is gone but credits can pay for the next replies.
    checks.push({
      id: 'sends_quota',
      label: 'Replies included in your plan',
      status: 'warn',
      detail: `The ${q.limit} automated replies included in ${PLAN_NAMES[plan]} are used up for this month. Replies now come out of your credits.${creditSentence}`,
      fix: { label: 'See plans and credits', href: BILLING_HREF },
    });
  } else {
    const low = q.remaining <= Math.max(5, q.limit * 0.1);
    checks.push({
      id: 'sends_quota',
      label: 'Replies included in your plan',
      status: low && !(credits && credits > 0) ? 'warn' : 'ok',
      detail: `${q.used} of ${q.limit} automated replies used this month on ${PLAN_NAMES[plan]} — ${q.remaining} left, resetting ${dateText(q.resetsAt)}.${creditSentence}`,
      ...(low ? { fix: { label: 'See plans and credits', href: BILLING_HREF } } : {}),
    });
  }

  /* 7. messaging_window — always informational. */
  checks.push({
    id: 'messaging_window',
    label: 'When Instagram allows a reply',
    status: 'ok',
    detail: 'Instagram only accepts a DM within 24 hours of that person\'s last message to you. A reply to a comment goes out through the private-reply endpoint instead, which works for 7 days after the comment and only once per comment.',
  });

  const summary = { ok: 0, warn: 0, fail: 0 };
  for (const c of checks) summary[c.status] += 1;
  const canFire = summary.fail === 0 && enabled.length > 0;

  return { checks, summary, lastInboundAt: stats.lastInboundAt, lastOutboundAt: stats.lastOutboundAt, events24h: stats.events24h, canFire, checkedAt: now() };
}

/** Fields we ask Instagram to send us — surfaced by POST /api/automations/resubscribe. */
export const SUBSCRIBED_FIELDS = [...WEBHOOK_FIELDS];

/** Read the live subscription (used right after re-subscribing so the UI can show Meta's own answer). */
export async function readSubscription(tid: number): Promise<{ ok: boolean; error: string | null; response: unknown }> {
  const creds = igCredentials(tid);
  if (!creds) return { ok: false, error: 'Instagram is not connected.', response: null };
  const r = await probe(`${creds.igUserId}/subscribed_apps`, {}, creds.accessToken);
  return { ok: r.ok, error: r.error, response: r.data };
}
