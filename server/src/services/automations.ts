import crypto from 'node:crypto';
import { config } from '../config.js';
import { db, getMeta, getSetting, j, now, OWNER_TENANT, setMeta } from '../db.js';
import { chargeMetered, checkQuota, effectivePlanFor, quotaMessage } from './plans.js';

/* ------------------------------------------------------------------ */
/* Config resolution: env wins (owner tenant only), then settings table */
/* ------------------------------------------------------------------ */
/**
 * A tenant that connected through THIS server's Meta app (round 5 "Connect Instagram", `ig_accounts` row) receives
 * webhooks signed with this server's app secret — so the operator's META_APP_SECRET / META_VERIFY_TOKEN apply to it too
 * (rotation-safe: never copied into the tenant's settings). Tolerates the table not existing yet (pre-migration).
 */
function oauthConnected(tid: number): boolean {
  try { return !!db().prepare('SELECT 1 FROM ig_accounts WHERE tenant_id = ?').get(tid); } catch { return false; }
}
export function metaConfig(tid: number) {
  const env = tid === OWNER_TENANT;
  const viaApp = env || ((config.metaAppSecret || config.metaVerifyToken) ? oauthConnected(tid) : false);
  return {
    appSecret: (viaApp && config.metaAppSecret) || getSetting(tid, 'meta_app_secret') || '',
    verifyToken: (viaApp && config.metaVerifyToken) || getSetting(tid, 'meta_verify_token') || '',
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
      for (const ch of entry?.changes || []) if (ch?.value?.recipient?.id) ids.push(String(ch.value.recipient.id));
    }
  } catch {}
  const found = tenantsForIgIds(ids);
  return found.length ? found : [OWNER_TENANT];
}

/* ------------------------------------------------------------------ */
/* Rules                                                                */
/* ------------------------------------------------------------------ */
export type TriggerType = 'dm_keyword' | 'dm_any' | 'dm_first' | 'comment_keyword' | 'comment_any' | 'story_reply';
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
  /** Migration 007: JSON array of Instagram media ids the rule is limited to. NULL / [] = every post. */
  media_ids: string | null;
  /** Migration 007: reply to each person at most once for this rule. */
  once_per_person: number;
  /** Migration 007: the last error Instagram returned while sending for this rule. */
  last_error: string | null;
  last_error_at: number | null;
}

/** Human name of a trigger, used in skip reasons and diagnostics notes. */
export const TRIGGER_LABEL: Record<TriggerType, string> = {
  dm_keyword: 'a DM containing a keyword',
  dm_any: 'any DM',
  dm_first: 'the first DM from a person',
  comment_keyword: 'a comment containing a keyword',
  comment_any: 'any comment',
  story_reply: 'a reply to a story',
};

export function listRules(tid: number): Rule[] {
  return db().prepare('SELECT * FROM automation_rules WHERE tenant_id = ? ORDER BY priority ASC, id ASC').all(tid) as Rule[];
}

/** The media ids a rule is limited to (empty = every post). */
export function ruleMediaIds(rule: Pick<Rule, 'media_ids'>): string[] {
  return j<string[]>(rule.media_ids, []).map((s) => String(s).trim()).filter(Boolean);
}

export function keywordsOf(rule: Pick<Rule, 'keywords'>): string[] {
  return j<string[]>(rule.keywords, []).map((k) => k.trim()).filter(Boolean);
}

export function matches(rule: Rule, text: string): boolean {
  const kws = keywordsOf(rule);
  const t = (text || '').trim();
  if (rule.trigger_type === 'dm_any' || rule.trigger_type === 'comment_any') return true;
  // A story reply (or a first message) is already a strong signal on its own: with no keywords the rule answers all of them.
  if ((rule.trigger_type === 'story_reply' || rule.trigger_type === 'dm_first') && !kws.length) return true;
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

/** Does this rule listen for this kind of event at all? A story reply arrives as a DM, so DM rules see it too. */
export function triggerApplies(kind: IncomingEvent['kind'], trigger: TriggerType): boolean {
  if (kind === 'dm') return trigger === 'dm_keyword' || trigger === 'dm_any' || trigger === 'dm_first';
  if (kind === 'story_reply') return trigger === 'story_reply' || trigger === 'dm_keyword' || trigger === 'dm_any' || trigger === 'dm_first';
  return trigger === 'comment_keyword' || trigger === 'comment_any';
}

export interface RuleSkip { ruleId: number; name: string; reason: string }
export interface RuleEvaluation { matched: Rule | null; skipped: RuleSkip[] }

interface ContactRow { ig_id: string; username: string | null; message_count: number; last_rule_hits: string | null }
function contactRow(tid: number, igId: string | undefined | null): ContactRow | undefined {
  if (!igId) return undefined;
  return db().prepare('SELECT ig_id, username, message_count, last_rule_hits FROM automation_contacts WHERE tenant_id = ? AND ig_id = ?').get(tid, igId) as ContactRow | undefined;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/**
 * Run every rule of a tenant against one event and say, for each rule that did not fire, why.
 * The first matching rule wins (rules are ordered by priority); the rest are reported as skipped so the
 * activity log and the simulator can answer "why didn't it fire".
 */
export function evaluateRules(tid: number, ev: IncomingEvent, opts: { ignoreCooldown?: boolean } = {}): RuleEvaluation {
  const rules = listRules(tid);
  const contact = contactRow(tid, ev.senderId);
  const hits = j<Record<string, number>>(contact?.last_rule_hits, {});
  const firstMessage = !contact;
  const skipped: RuleSkip[] = [];
  let matched: Rule | null = null;
  for (const r of rules) {
    const skip = (reason: string) => skipped.push({ ruleId: r.id, name: r.name, reason });
    if (!r.enabled) { skip('The rule is turned off.'); continue; }
    if (!triggerApplies(ev.kind, r.trigger_type)) { skip(`This rule listens for ${TRIGGER_LABEL[r.trigger_type]}.`); continue; }
    if (!matches(r, ev.text)) {
      const kws = keywordsOf(r);
      skip(kws.length ? `None of its keywords (${kws.join(', ')}) appear in the message.` : 'The rule has no keywords, so nothing can match it.');
      continue;
    }
    const media = ruleMediaIds(r);
    if (media.length && ev.kind === 'comment') {
      if (!ev.mediaId) { skip(`The rule only runs on ${plural(media.length, 'selected post')} and this comment carries no post id.`); continue; }
      if (!media.includes(String(ev.mediaId))) { skip(`The comment is on another post — the rule only runs on ${plural(media.length, 'selected post')}.`); continue; }
    }
    if (r.trigger_type === 'dm_first' && !firstMessage) { skip('This person has written to you before, so this is not their first message.'); continue; }
    const last = hits[String(r.id)];
    if (r.once_per_person && last) { skip('This person already got this reply once, and the rule replies once per person.'); continue; }
    if (!opts.ignoreCooldown && r.cooldown_minutes > 0 && ev.senderId && last && now() - last < r.cooldown_minutes * 60) {
      const mins = Math.max(1, Math.round((now() - last) / 60));
      skip(`Cooldown: this person got this reply ${plural(mins, 'minute')} ago and the cooldown is ${plural(r.cooldown_minutes, 'minute')}.`);
      continue;
    }
    if (matched) { skip(`Another rule matched first (${matched.name}).`); continue; }
    matched = r;
  }
  return { matched, skipped };
}

/** Find the first enabled rule that matches an event (respecting per-sender cooldown, once-per-person and the post filter). */
export function findRule(tid: number, ev: IncomingEvent, opts: { ignoreCooldown?: boolean } = {}): Rule | null {
  return evaluateRules(tid, ev, opts).matched;
}

/* ------------------------------------------------------------------ */
/* Meta Graph API client (Instagram API with Instagram Login)           */
/* ------------------------------------------------------------------ */
/**
 * A Graph API call that came back with an error. `meta.message` is exactly what Instagram said, so callers
 * (test-send, the activity log) can show it verbatim instead of our wrapper text.
 */
export class GraphError extends Error {
  readonly meta: { message: string; code: number | null; subcode: number | null; type: string | null; status: number; raw: unknown };
  constructor(message: string, meta: GraphError['meta']) {
    super(message);
    this.name = 'GraphError';
    this.meta = meta;
  }
}

/** Instagram's own words for an error, whatever it was thrown as. */
export function metaErrorMessage(e: unknown): string {
  if (e instanceof GraphError) return e.meta.message;
  return String((e as any)?.message || e);
}

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
    const err = data?.error && typeof data.error === 'object' ? data.error : {};
    const msg = err.message || data?.error_message || `HTTP ${res.status}`;
    const code = typeof err.code === 'number' ? err.code : null;
    const subcode = typeof err.error_subcode === 'number' ? err.error_subcode : null;
    throw new GraphError(
      `Graph API ${method} ${path}: ${msg}${code !== null ? ` (code ${code}${subcode !== null ? `/${subcode}` : ''})` : ''}`,
      { message: msg, code, subcode, type: typeof err.type === 'string' ? err.type : null, status: res.status, raw: data },
    );
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

function logEvent(tid: number, e: { type: string; direction: 'in' | 'out' | 'system'; senderId?: string | null; senderUsername?: string | null; text?: string | null; ruleId?: number | null; status?: string; error?: string | null; payload?: unknown }): number {
  const info = db().prepare('INSERT INTO automation_events (tenant_id, ts, type, direction, sender_id, sender_username, text, rule_id, status, error, payload) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(tid, now(), e.type, e.direction, e.senderId || null, e.senderUsername || null, e.text || null, e.ruleId || null, e.status || 'ok', e.error || null, e.payload ? JSON.stringify(e.payload).slice(0, 8000) : null);
  return Number(info.lastInsertRowid);
}

/** Update the inbound row we wrote before the rules ran, so one line in the log carries the outcome and the reason. */
function settleEvent(tid: number, eventId: number, status: string, ruleId: number | null, error: string | null) {
  if (!eventId) return;
  db().prepare('UPDATE automation_events SET status = ?, rule_id = ?, error = ? WHERE id = ? AND tenant_id = ?').run(status, ruleId, error, eventId, tid);
}

/** A compact, readable copy of what arrived — the raw payload is kept underneath it for support. */
function payloadSnippet(ev: IncomingEvent) {
  return {
    kind: ev.kind,
    snippet: (ev.text || '').slice(0, 280),
    mediaId: ev.mediaId || null,
    commentId: ev.commentId || null,
    from: ev.senderUsername ? `@${ev.senderUsername}` : ev.senderId || null,
    raw: ev.raw,
  };
}

/** One sentence explaining why nothing fired, built from the per-rule skip reasons. */
export function noMatchReason(skipped: RuleSkip[]): string {
  if (!skipped.length) return 'No automation rules exist yet, so nothing could reply.';
  const first = skipped.slice(0, 3).map((s) => `${s.name}: ${s.reason}`).join(' ');
  const rest = skipped.length > 3 ? ` (+${skipped.length - 3} more rules)` : '';
  return `No rule matched. ${first}${rest}`;
}

/** Remember the last error Instagram returned for a rule (shown in the health card and the rule list). */
export function noteRuleError(tid: number, ruleId: number, message: string) {
  try { db().prepare('UPDATE automation_rules SET last_error = ?, last_error_at = ? WHERE id = ? AND tenant_id = ?').run(message.slice(0, 500), now(), ruleId, tid); } catch {}
}
function clearRuleError(tid: number, ruleId: number) {
  try { db().prepare('UPDATE automation_rules SET last_error = NULL, last_error_at = NULL WHERE id = ? AND tenant_id = ?').run(ruleId, tid); } catch {}
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

export function composeReply(rule: Rule, ev: IncomingEvent): string {
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
  // Every inbound event is logged, matched or not — the activity log has to be able to answer "why didn't it fire".
  const eventId = logEvent(tid, { type: ev.kind === 'comment' ? 'comment_in' : 'dm_in', direction: 'in', senderId: ev.senderId, senderUsername: ev.senderUsername, text: ev.text, payload: payloadSnippet(ev) });
  // Expired trial / lapsed subscription: rules are not evaluated (log once a day so the activity feed explains the silence).
  if (effectivePlanFor(tid) === 'free') {
    touchContact(tid, ev.senderId, ev.senderUsername);
    const why = 'Automations are paused: your trial ended (or your subscription lapsed). Upgrade to resume automatic replies.';
    settleEvent(tid, eventId, 'no_match', null, why);
    logOncePerDay(tid, 'automation_paused_logged', why, 'error');
    return { matched: null, actions: ['paused: plan'] };
  }
  const evaluation = evaluateRules(tid, ev);
  const rule = evaluation.matched;
  touchContact(tid, ev.senderId, ev.senderUsername, rule?.id);
  if (!rule) {
    settleEvent(tid, eventId, 'no_match', null, noMatchReason(evaluation.skipped));
    return { matched: null, actions: ['no rule matched'] };
  }
  settleEvent(tid, eventId, 'matched', rule.id, null);
  const reply = composeReply(rule, ev);
  const send = async (label: string, n: number, fn: () => Promise<unknown>): Promise<boolean> => {
    const q = checkQuota(tid, 'sends', n);
    if (!q.ok) {
      actions.push(`skipped ${label}: sends quota`);
      logEvent(tid, { type: 'error', direction: 'out', senderId: ev.senderId, senderUsername: ev.senderUsername, text: reply, ruleId: rule.id, status: 'error', error: quotaMessage(q) });
      return false;
    }
    await fn();
    chargeMetered(tid, 'sends', n, `rule:${rule.id}`); // plan allowance first, then credits (1 credit = 20 replies)
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
    if (actions.some((a) => a.endsWith('sent'))) {
      db().prepare('UPDATE automation_rules SET hit_count = hit_count + 1, last_hit_at = ? WHERE id = ? AND tenant_id = ?').run(now(), rule.id, tid);
      if (rule.last_error) clearRuleError(tid, rule.id);
    }
  } catch (e: any) {
    // Instagram's own wording, both on the rule (health card) and in the activity log.
    const msg = metaErrorMessage(e);
    actions.push(`error: ${msg}`);
    noteRuleError(tid, rule.id, msg);
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
      // Instagram delivers DMs and story replies as entry[].messaging[], but the App Dashboard's webhook "Test"
      // button sends the same event as a change on the `messages` field. Read both, or pressing Test in Meta's
      // dashboard looks like the automation is broken when it is only a different envelope.
      if (ch.field === 'messages') {
        const v = ch.value || {};
        const msg = v.message;
        if (!msg || msg.is_echo) continue;
        const senderId = v.sender?.id;
        if (!senderId || senderId === c.igUserId) continue;
        if (msg.mid && seenBefore(`${tid}:m:${msg.mid}`)) continue;
        const text: string = msg.text || (msg.attachments?.length ? `[attachment:${msg.attachments[0].type}]` : '');
        out.push({ kind: msg.reply_to?.story ? 'story_reply' : 'dm', text, senderId, senderUsername: v.sender?.username, raw: v });
        continue;
      }
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
/** Write one row into the activity log (used by the test-send route so a manual attempt is attributed to its rule). */
export function logAutomationEvent(tid: number, e: Parameters<typeof logEvent>[1]): number {
  return logEvent(tid, e);
}
