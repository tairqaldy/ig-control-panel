import crypto from 'node:crypto';
import { config } from '../config.js';
import { db, getMeta, getSetting, j, now, OWNER_TENANT, setMeta } from '../db.js';
import { bumpUsage, checkQuota, effectivePlanFor, quotaMessage } from './plans.js';

/* ------------------------------------------------------------------ */
/* Config resolution: env wins (owner tenant only), then settings table */
/* ------------------------------------------------------------------ */
export function metaConfig(tid: number) {
  const env = tid === OWNER_TENANT;
  return {
    appSecret: (env && config.metaAppSecret) || getSetting(tid, 'meta_app_secret') || '',
    verifyToken: (env && config.metaVerifyToken) || getSetting(tid, 'meta_verify_token') || '',
    accessToken: (env && config.igAccessToken) || getSetting(tid, 'ig_access_token') || '',
    igUserId: (env && config.igUserId) || getSetting(tid, 'ig_user_id') || '',
    apiVersion: config.graphApiVersion,
  };
}
export function automationsConfigured(tid: number): boolean {
  const c = metaConfig(tid);
  return !!(c.accessToken && c.igUserId);
}

/** Tenants whose Instagram account id matches one of the ids seen in a webhook payload (settings + owner env). */
function tenantsForIgIds(ids: string[]): number[] {
  const out = new Set<number>();
  const clean = Array.from(new Set(ids.filter(Boolean)));
  if (!clean.length) return [];
  const owner = metaConfig(OWNER_TENANT).igUserId;
  if (owner && clean.includes(owner)) out.add(OWNER_TENANT);
  const rows = db().prepare(`SELECT tenant_id FROM settings WHERE key = 'ig_user_id' AND value IN (${clean.map(() => '?').join(',')})`).all(...clean) as Array<{ tenant_id: number }>;
  for (const r of rows) out.add(r.tenant_id);
  return Array.from(out);
}

/** Which tenant owns this Meta verify token (GET webhook handshake)? */
export function tenantForVerifyToken(token: string | undefined): number | null {
  if (!token) return null;
  const owner = metaConfig(OWNER_TENANT).verifyToken;
  if (owner && owner.length === token.length && crypto.timingSafeEqual(Buffer.from(owner), Buffer.from(token))) return OWNER_TENANT;
  const r = db().prepare("SELECT tenant_id FROM settings WHERE key = 'meta_verify_token' AND value = ? LIMIT 1").get(token) as { tenant_id: number } | undefined;
  return r?.tenant_id ?? null;
}

/**
 * Candidate tenants for an incoming webhook POST: tenants whose ig_user_id appears in the payload (entry ids /
 * message recipients), else the owner tenant (single-tenant behaviour). The caller verifies the signature per candidate.
 */
export function tenantsForWebhook(body: any): number[] {
  const ids: string[] = [];
  try {
    for (const entry of body?.entry || []) {
      if (entry?.id) ids.push(String(entry.id));
      for (const m of entry?.messaging || []) if (m?.recipient?.id) ids.push(String(m.recipient.id));
    }
  } catch {}
  const found = tenantsForIgIds(ids);
  return found.length ? found : [OWNER_TENANT];
}

/* ------------------------------------------------------------------ */
/* Rules                                                                */
/* ------------------------------------------------------------------ */
export type TriggerType = 'dm_keyword' | 'dm_any' | 'comment_keyword' | 'comment_any' | 'story_reply';
export type MatchMode = 'contains' | 'exact' | 'starts_with' | 'regex';

export interface Rule {
  id: number;
  tenant_id: number;
  name: string;
  enabled: number;
  trigger_type: TriggerType;
  match_mode: MatchMode;
  keywords: string; // JSON array
  reply_text: string;
  reply_link: string | null;
  public_reply_text: string | null;
  cooldown_minutes: number;
  priority: number;
  hit_count: number;
  last_hit_at: number | null;
  created_at: number;
  updated_at: number;
}

export function listRules(tid: number): Rule[] {
  return db().prepare('SELECT * FROM automation_rules WHERE tenant_id = ? ORDER BY priority ASC, id ASC').all(tid) as Rule[];
}

export function matches(rule: Rule, text: string): boolean {
  const kws = j<string[]>(rule.keywords, []).map((k) => k.trim()).filter(Boolean);
  const t = (text || '').trim();
  if (rule.trigger_type === 'dm_any' || rule.trigger_type === 'comment_any') return true;
  if (!kws.length) return false;
  const lower = t.toLowerCase();
  switch (rule.match_mode) {
    case 'exact': return kws.some((k) => lower === k.toLowerCase());
    case 'starts_with': return kws.some((k) => lower.startsWith(k.toLowerCase()));
    case 'regex': return kws.some((k) => { try { return new RegExp(k, 'i').test(t); } catch { return false; } });
    default: return kws.some((k) => lower.includes(k.toLowerCase()));
  }
}

export interface IncomingEvent {
  kind: 'dm' | 'comment' | 'story_reply';
  text: string;
  senderId: string;
  senderUsername?: string;
  commentId?: string;
  mediaId?: string;
  raw?: unknown;
}

/** Find the first enabled rule that matches an event (respecting per-sender cooldown). */
export function findRule(tid: number, ev: IncomingEvent, opts: { ignoreCooldown?: boolean } = {}): Rule | null {
  const rules = listRules(tid).filter((r) => r.enabled);
  const applicable = rules.filter((r) => {
    if (ev.kind === 'dm') return r.trigger_type === 'dm_keyword' || r.trigger_type === 'dm_any';
    if (ev.kind === 'story_reply') return r.trigger_type === 'story_reply' || r.trigger_type === 'dm_keyword' || r.trigger_type === 'dm_any';
    return r.trigger_type === 'comment_keyword' || r.trigger_type === 'comment_any';
  });
  for (const r of applicable) {
    if (!matches(r, ev.text)) continue;
    if (!opts.ignoreCooldown && r.cooldown_minutes > 0 && ev.senderId) {
      const contact = db().prepare('SELECT last_rule_hits FROM automation_contacts WHERE tenant_id = ? AND ig_id = ?').get(tid, ev.senderId) as { last_rule_hits: string } | undefined;
      const hits = j<Record<string, number>>(contact?.last_rule_hits, {});
      const last = hits[String(r.id)];
      if (last && now() - last < r.cooldown_minutes * 60) continue;
    }
    return r;
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* Meta Graph API client (Instagram API with Instagram Login)           */
/* ------------------------------------------------------------------ */
async function graph(tid: number, method: 'GET' | 'POST', path: string, body?: Record<string, unknown>, params?: Record<string, string>) {
  const c = metaConfig(tid);
  if (!c.accessToken) throw new Error('IG_ACCESS_TOKEN not configured');
  const url = new URL(`https://graph.instagram.com/${c.apiVersion}/${path.replace(/^\//, '')}`);
  url.searchParams.set('access_token', c.accessToken);
  for (const [k, v] of Object.entries(params || {})) url.searchParams.set(k, v);
  const res = await fetch(url, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data: any = null;
  try { data = JSON.parse(text); } catch { data = { raw: text }; }
  if (!res.ok || data?.error) {
    const msg = data?.error?.message || `HTTP ${res.status}`;
    throw new Error(`Graph API ${method} ${path}: ${msg}${data?.error?.code ? ` (code ${data.error.code}${data.error.error_subcode ? `/${data.error.error_subcode}` : ''})` : ''}`);
  }
  return data;
}

export async function getMe(tid: number): Promise<{ id: string; user_id?: string; username?: string; name?: string }> {
  return graph(tid, 'GET', 'me', undefined, { fields: 'id,user_id,username,name,account_type' });
}

export async function sendDm(tid: number, recipientId: string, text: string) {
  const c = metaConfig(tid);
  return graph(tid, 'POST', `${c.igUserId}/messages`, { recipient: { id: recipientId }, message: { text } });
}

/** Private reply to a comment (opens a DM thread from a comment). Only allowed once per comment, within 7 days. */
export async function sendPrivateReply(tid: number, commentId: string, text: string) {
  const c = metaConfig(tid);
  return graph(tid, 'POST', `${c.igUserId}/messages`, { recipient: { comment_id: commentId }, message: { text } });
}

export async function replyToComment(tid: number, commentId: string, text: string) {
  return graph(tid, 'POST', `${commentId}/replies`, { message: text });
}

export async function getUsername(tid: number, igScopedId: string): Promise<string | null> {
  try {
    const d = await graph(tid, 'GET', igScopedId, undefined, { fields: 'username,name' });
    return d?.username || null;
  } catch { return null; }
}

/* ------------------------------------------------------------------ */
/* Webhook handling                                                     */
/* ------------------------------------------------------------------ */
/**
 * Webhook signature check. Fail closed: if no META_APP_SECRET is configured but an access token IS
 * (i.e. the app could actually send DMs), unsigned webhooks are rejected so nobody can drive your account.
 * With neither configured (pure logging/testing) unsigned events are accepted and only logged.
 */
export function verifySignature(tid: number, rawBody: string, header: string | undefined): boolean {
  const c = metaConfig(tid);
  if (!c.appSecret) return !c.accessToken;
  if (!header || !header.startsWith('sha256=')) return false;
  const expected = 'sha256=' + crypto.createHmac('sha256', c.appSecret).update(rawBody, 'utf8').digest('hex');
  const a = Buffer.from(header), b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function logEvent(tid: number, e: { type: string; direction: 'in' | 'out' | 'system'; senderId?: string | null; senderUsername?: string | null; text?: string | null; ruleId?: number | null; status?: string; error?: string | null; payload?: unknown }) {
  db().prepare('INSERT INTO automation_events (tenant_id, ts, type, direction, sender_id, sender_username, text, rule_id, status, error, payload) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(tid, now(), e.type, e.direction, e.senderId || null, e.senderUsername || null, e.text || null, e.ruleId || null, e.status || 'ok', e.error || null, e.payload ? JSON.stringify(e.payload).slice(0, 8000) : null);
}

function touchContact(tid: number, igId: string, username?: string | null, ruleId?: number) {
  const d = db();
  const t = now();
  const existing = d.prepare('SELECT * FROM automation_contacts WHERE tenant_id = ? AND ig_id = ?').get(tid, igId) as any;
  if (!existing) {
    d.prepare('INSERT INTO automation_contacts (tenant_id, ig_id, username, first_seen, last_seen, message_count, last_rule_hits) VALUES (?, ?, ?, ?, ?, 1, ?)').run(tid, igId, username || null, t, t, ruleId ? JSON.stringify({ [ruleId]: t }) : '{}');
  } else {
    const hits = j<Record<string, number>>(existing.last_rule_hits, {});
    if (ruleId) hits[String(ruleId)] = t;
    d.prepare('UPDATE automation_contacts SET username = COALESCE(?, username), last_seen = ?, message_count = message_count + 1, last_rule_hits = ? WHERE tenant_id = ? AND ig_id = ?').run(username || null, t, JSON.stringify(hits), tid, igId);
  }
}

function composeReply(rule: Rule, ev: IncomingEvent): string {
  let text = rule.reply_text || '';
  text = text.replace(/\{\{\s*username\s*\}\}/gi, ev.senderUsername ? `@${ev.senderUsername}` : 'there');
  text = text.replace(/\{\{\s*keyword\s*\}\}/gi, ev.text.slice(0, 60));
  if (rule.reply_link) text = `${text}\n${rule.reply_link}`.trim();
  return text;
}

/** Log a system event at most once per day per key (used for "automations paused" notices). */
function logOncePerDay(tid: number, key: string, text: string, status = 'ok') {
  const today = new Date().toISOString().slice(0, 10);
  if (getMeta(tid, key) === today) return;
  setMeta(tid, key, today);
  logSystemEvent(tid, text, null, status);
}

/** Process one incoming event through the rules engine and send replies. */
export async function handleIncoming(tid: number, ev: IncomingEvent): Promise<{ matched: Rule | null; actions: string[] }> {
  const actions: string[] = [];
  const c = metaConfig(tid);
  // ignore our own messages
  if (ev.senderId && c.igUserId && ev.senderId === c.igUserId) return { matched: null, actions: ['ignored: own message'] };
  logEvent(tid, { type: ev.kind === 'comment' ? 'comment_in' : 'dm_in', direction: 'in', senderId: ev.senderId, senderUsername: ev.senderUsername, text: ev.text, payload: ev.raw });
  // Expired trial / lapsed subscription: rules are not evaluated (log once a day so the activity feed explains the silence).
  if (effectivePlanFor(tid) === 'free') {
    touchContact(tid, ev.senderId, ev.senderUsername);
    logOncePerDay(tid, 'automation_paused_logged', 'Automations are paused: your trial ended (or your subscription lapsed). Upgrade to resume automatic replies.', 'error');
    return { matched: null, actions: ['paused: plan'] };
  }
  const rule = findRule(tid, ev);
  touchContact(tid, ev.senderId, ev.senderUsername, rule?.id);
  if (!rule) return { matched: null, actions: ['no rule matched'] };
  const reply = composeReply(rule, ev);
  const send = async (label: string, n: number, fn: () => Promise<unknown>): Promise<boolean> => {
    const q = checkQuota(tid, 'sends', n);
    if (!q.ok) {
      actions.push(`skipped ${label}: sends quota`);
      logEvent(tid, { type: 'error', direction: 'out', senderId: ev.senderId, senderUsername: ev.senderUsername, text: reply, ruleId: rule.id, status: 'error', error: quotaMessage(q) });
      return false;
    }
    await fn();
    bumpUsage(tid, 'sends', n);
    return true;
  };
  try {
    if (ev.kind === 'comment' && ev.commentId) {
      if (reply && await send('private reply', 1, () => sendPrivateReply(tid, ev.commentId!, reply))) { actions.push('private reply sent'); logEvent(tid, { type: 'dm_out', direction: 'out', senderId: ev.senderId, senderUsername: ev.senderUsername, text: reply, ruleId: rule.id }); }
      if (rule.public_reply_text && await send('public reply', 1, () => replyToComment(tid, ev.commentId!, rule.public_reply_text!))) { actions.push('public comment reply sent'); logEvent(tid, { type: 'comment_reply_out', direction: 'out', senderId: ev.senderId, senderUsername: ev.senderUsername, text: rule.public_reply_text, ruleId: rule.id }); }
    } else if (reply) {
      if (await send('dm', 1, () => sendDm(tid, ev.senderId, reply))) {
        actions.push('dm sent');
        logEvent(tid, { type: 'dm_out', direction: 'out', senderId: ev.senderId, senderUsername: ev.senderUsername, text: reply, ruleId: rule.id });
      }
    }
    if (actions.some((a) => a.endsWith('sent'))) db().prepare('UPDATE automation_rules SET hit_count = hit_count + 1, last_hit_at = ? WHERE id = ? AND tenant_id = ?').run(now(), rule.id, tid);
  } catch (e: any) {
    const msg = String(e?.message || e);
    actions.push(`error: ${msg}`);
    logEvent(tid, { type: 'error', direction: 'out', senderId: ev.senderId, senderUsername: ev.senderUsername, text: reply, ruleId: rule.id, status: 'error', error: msg });
  }
  return { matched: rule, actions };
}

/** Meta retries webhooks for up to 36h — dedupe on message id / comment id (in-memory LRU, keyed per tenant). */
const seenIds: string[] = [];
const seenSet = new Set<string>();
function seenBefore(key: string): boolean {
  if (seenSet.has(key)) return true;
  seenSet.add(key); seenIds.push(key);
  if (seenIds.length > 5000) { const old = seenIds.shift()!; seenSet.delete(old); }
  return false;
}

/** Parse a Meta webhook POST body into incoming events (messages + comments). Tolerant to shape differences. */
export function parseWebhookBody(tid: number, body: any): IncomingEvent[] {
  const out: IncomingEvent[] = [];
  const c = metaConfig(tid);
  if (!body || body.object !== 'instagram') return out;
  for (const entry of body.entry || []) {
    for (const m of entry.messaging || []) {
      const msg = m.message;
      if (!msg || msg.is_echo) continue;
      const senderId = m.sender?.id;
      if (!senderId || senderId === c.igUserId) continue;
      if (msg.mid && seenBefore(`${tid}:m:${msg.mid}`)) continue;
      const text: string = msg.text || (msg.attachments?.length ? `[attachment:${msg.attachments[0].type}]` : '');
      const isStoryReply = !!msg.reply_to?.story;
      out.push({ kind: isStoryReply ? 'story_reply' : 'dm', text, senderId, raw: m });
    }
    for (const ch of entry.changes || []) {
      if (ch.field !== 'comments') continue;
      const v = ch.value || {};
      const senderId = v.from?.id;
      if (!senderId || senderId === c.igUserId) continue;
      if (v.id && seenBefore(`${tid}:c:${v.id}`)) continue;
      out.push({ kind: 'comment', text: v.text || '', senderId, senderUsername: v.from?.username, commentId: v.id, mediaId: v.media?.id, raw: v });
    }
  }
  return out;
}

export function recentEvents(tid: number, limit = 100) {
  return db().prepare('SELECT * FROM automation_events WHERE tenant_id = ? ORDER BY id DESC LIMIT ?').all(tid, limit);
}
export function contacts(tid: number, limit = 200) {
  return db().prepare('SELECT * FROM automation_contacts WHERE tenant_id = ? ORDER BY last_seen DESC LIMIT ?').all(tid, limit);
}
export function logSystemEvent(tid: number, text: string, payload?: unknown, status = 'ok') {
  logEvent(tid, { type: 'system', direction: 'system', text, payload, status });
}
