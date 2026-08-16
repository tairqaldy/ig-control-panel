import crypto from 'node:crypto';
import { config } from '../config.js';
import { db, getSetting, j, now } from '../db.js';

/* ------------------------------------------------------------------ */
/* Config resolution: env wins, then settings table                     */
/* ------------------------------------------------------------------ */
export function metaConfig() {
  return {
    appSecret: config.metaAppSecret || getSetting('meta_app_secret') || '',
    verifyToken: config.metaVerifyToken || getSetting('meta_verify_token') || '',
    accessToken: config.igAccessToken || getSetting('ig_access_token') || '',
    igUserId: config.igUserId || getSetting('ig_user_id') || '',
    apiVersion: config.graphApiVersion,
  };
}
export function automationsConfigured(): boolean {
  const c = metaConfig();
  return !!(c.accessToken && c.igUserId);
}

/* ------------------------------------------------------------------ */
/* Rules                                                                */
/* ------------------------------------------------------------------ */
export type TriggerType = 'dm_keyword' | 'dm_any' | 'comment_keyword' | 'comment_any' | 'story_reply';
export type MatchMode = 'contains' | 'exact' | 'starts_with' | 'regex';

export interface Rule {
  id: number;
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

export function listRules(): Rule[] {
  return db().prepare('SELECT * FROM automation_rules ORDER BY priority ASC, id ASC').all() as Rule[];
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
export function findRule(ev: IncomingEvent, opts: { ignoreCooldown?: boolean } = {}): Rule | null {
  const rules = listRules().filter((r) => r.enabled);
  const applicable = rules.filter((r) => {
    if (ev.kind === 'dm') return r.trigger_type === 'dm_keyword' || r.trigger_type === 'dm_any';
    if (ev.kind === 'story_reply') return r.trigger_type === 'story_reply' || r.trigger_type === 'dm_keyword' || r.trigger_type === 'dm_any';
    return r.trigger_type === 'comment_keyword' || r.trigger_type === 'comment_any';
  });
  for (const r of applicable) {
    if (!matches(r, ev.text)) continue;
    if (!opts.ignoreCooldown && r.cooldown_minutes > 0 && ev.senderId) {
      const contact = db().prepare('SELECT last_rule_hits FROM automation_contacts WHERE ig_id = ?').get(ev.senderId) as { last_rule_hits: string } | undefined;
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
async function graph(method: 'GET' | 'POST', path: string, body?: Record<string, unknown>, params?: Record<string, string>) {
  const c = metaConfig();
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

export async function getMe(): Promise<{ id: string; user_id?: string; username?: string; name?: string }> {
  return graph('GET', 'me', undefined, { fields: 'id,user_id,username,name,account_type' });
}

export async function sendDm(recipientId: string, text: string) {
  const c = metaConfig();
  return graph('POST', `${c.igUserId}/messages`, { recipient: { id: recipientId }, message: { text } });
}

/** Private reply to a comment (opens a DM thread from a comment). Only allowed once per comment, within 7 days. */
export async function sendPrivateReply(commentId: string, text: string) {
  const c = metaConfig();
  return graph('POST', `${c.igUserId}/messages`, { recipient: { comment_id: commentId }, message: { text } });
}

export async function replyToComment(commentId: string, text: string) {
  return graph('POST', `${commentId}/replies`, { message: text });
}

export async function getUsername(igScopedId: string): Promise<string | null> {
  try {
    const d = await graph('GET', igScopedId, undefined, { fields: 'username,name' });
    return d?.username || null;
  } catch { return null; }
}

/* ------------------------------------------------------------------ */
/* Webhook handling                                                     */
/* ------------------------------------------------------------------ */
export function verifySignature(rawBody: string, header: string | undefined): boolean {
  const c = metaConfig();
  if (!c.appSecret) return true; // not configured → accept (documented; set META_APP_SECRET to enforce)
  if (!header || !header.startsWith('sha256=')) return false;
  const expected = 'sha256=' + crypto.createHmac('sha256', c.appSecret).update(rawBody, 'utf8').digest('hex');
  const a = Buffer.from(header), b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function logEvent(e: { type: string; direction: 'in' | 'out' | 'system'; senderId?: string | null; senderUsername?: string | null; text?: string | null; ruleId?: number | null; status?: string; error?: string | null; payload?: unknown }) {
  db().prepare('INSERT INTO automation_events (ts, type, direction, sender_id, sender_username, text, rule_id, status, error, payload) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(now(), e.type, e.direction, e.senderId || null, e.senderUsername || null, e.text || null, e.ruleId || null, e.status || 'ok', e.error || null, e.payload ? JSON.stringify(e.payload).slice(0, 8000) : null);
}

function touchContact(igId: string, username?: string | null, ruleId?: number) {
  const d = db();
  const t = now();
  const existing = d.prepare('SELECT * FROM automation_contacts WHERE ig_id = ?').get(igId) as any;
  if (!existing) {
    d.prepare('INSERT INTO automation_contacts (ig_id, username, first_seen, last_seen, message_count, last_rule_hits) VALUES (?, ?, ?, ?, 1, ?)').run(igId, username || null, t, t, ruleId ? JSON.stringify({ [ruleId]: t }) : '{}');
  } else {
    const hits = j<Record<string, number>>(existing.last_rule_hits, {});
    if (ruleId) hits[String(ruleId)] = t;
    d.prepare('UPDATE automation_contacts SET username = COALESCE(?, username), last_seen = ?, message_count = message_count + 1, last_rule_hits = ? WHERE ig_id = ?').run(username || null, t, JSON.stringify(hits), igId);
  }
}

function composeReply(rule: Rule, ev: IncomingEvent): string {
  let text = rule.reply_text || '';
  text = text.replace(/\{\{\s*username\s*\}\}/gi, ev.senderUsername ? `@${ev.senderUsername}` : 'there');
  text = text.replace(/\{\{\s*keyword\s*\}\}/gi, ev.text.slice(0, 60));
  if (rule.reply_link) text = `${text}\n${rule.reply_link}`.trim();
  return text;
}

/** Process one incoming event through the rules engine and send replies. */
export async function handleIncoming(ev: IncomingEvent): Promise<{ matched: Rule | null; actions: string[] }> {
  const actions: string[] = [];
  const c = metaConfig();
  // ignore our own messages
  if (ev.senderId && c.igUserId && ev.senderId === c.igUserId) return { matched: null, actions: ['ignored: own message'] };
  logEvent({ type: ev.kind === 'comment' ? 'comment_in' : 'dm_in', direction: 'in', senderId: ev.senderId, senderUsername: ev.senderUsername, text: ev.text, payload: ev.raw });
  const rule = findRule(ev);
  touchContact(ev.senderId, ev.senderUsername, rule?.id);
  if (!rule) return { matched: null, actions: ['no rule matched'] };
  const reply = composeReply(rule, ev);
  try {
    if (ev.kind === 'comment' && ev.commentId) {
      if (reply) { await sendPrivateReply(ev.commentId, reply); actions.push('private reply sent'); logEvent({ type: 'dm_out', direction: 'out', senderId: ev.senderId, senderUsername: ev.senderUsername, text: reply, ruleId: rule.id }); }
      if (rule.public_reply_text) { await replyToComment(ev.commentId, rule.public_reply_text); actions.push('public comment reply sent'); logEvent({ type: 'comment_reply_out', direction: 'out', senderId: ev.senderId, senderUsername: ev.senderUsername, text: rule.public_reply_text, ruleId: rule.id }); }
    } else if (reply) {
      await sendDm(ev.senderId, reply);
      actions.push('dm sent');
      logEvent({ type: 'dm_out', direction: 'out', senderId: ev.senderId, senderUsername: ev.senderUsername, text: reply, ruleId: rule.id });
    }
    db().prepare('UPDATE automation_rules SET hit_count = hit_count + 1, last_hit_at = ? WHERE id = ?').run(now(), rule.id);
  } catch (e: any) {
    const msg = String(e?.message || e);
    actions.push(`error: ${msg}`);
    logEvent({ type: 'error', direction: 'out', senderId: ev.senderId, senderUsername: ev.senderUsername, text: reply, ruleId: rule.id, status: 'error', error: msg });
  }
  return { matched: rule, actions };
}

/** Meta retries webhooks for up to 36h — dedupe on message id / comment id (in-memory LRU). */
const seenIds: string[] = [];
const seenSet = new Set<string>();
function seenBefore(key: string): boolean {
  if (seenSet.has(key)) return true;
  seenSet.add(key); seenIds.push(key);
  if (seenIds.length > 5000) { const old = seenIds.shift()!; seenSet.delete(old); }
  return false;
}

/** Parse a Meta webhook POST body into incoming events (messages + comments). Tolerant to shape differences. */
export function parseWebhookBody(body: any): IncomingEvent[] {
  const out: IncomingEvent[] = [];
  const c = metaConfig();
  if (!body || body.object !== 'instagram') return out;
  for (const entry of body.entry || []) {
    for (const m of entry.messaging || []) {
      const msg = m.message;
      if (!msg || msg.is_echo) continue;
      const senderId = m.sender?.id;
      if (!senderId || senderId === c.igUserId) continue;
      if (msg.mid && seenBefore(`m:${msg.mid}`)) continue;
      const text: string = msg.text || (msg.attachments?.length ? `[attachment:${msg.attachments[0].type}]` : '');
      const isStoryReply = !!msg.reply_to?.story;
      out.push({ kind: isStoryReply ? 'story_reply' : 'dm', text, senderId, raw: m });
    }
    for (const ch of entry.changes || []) {
      if (ch.field !== 'comments') continue;
      const v = ch.value || {};
      const senderId = v.from?.id;
      if (!senderId || senderId === c.igUserId) continue;
      if (v.id && seenBefore(`c:${v.id}`)) continue;
      out.push({ kind: 'comment', text: v.text || '', senderId, senderUsername: v.from?.username, commentId: v.id, mediaId: v.media?.id, raw: v });
    }
  }
  return out;
}

export function recentEvents(limit = 100) {
  return db().prepare('SELECT * FROM automation_events ORDER BY id DESC LIMIT ?').all(limit);
}
export function contacts(limit = 200) {
  return db().prepare('SELECT * FROM automation_contacts ORDER BY last_seen DESC LIMIT ?').all(limit);
}
export function logSystemEvent(text: string, payload?: unknown, status = 'ok') {
  logEvent({ type: 'system', direction: 'system', text, payload, status });
}
