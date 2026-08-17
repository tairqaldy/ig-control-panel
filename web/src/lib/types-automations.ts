/* Round 6 — Automations UI contracts (docs/dev/ROUND6-SPEC.md §1–§2).
   Everything the rule builder, post picker, health card and activity log talk to.
   The server endpoints are additive: anything missing answers 404/501 and the UI hides that panel. */

import type { Rule } from './types';

/* ---------------- Rules ---------------- */

/** Server `automation_rules.trigger_type`. `dm_first` is new in round 6. */
export type AutomationTrigger = 'dm_keyword' | 'dm_any' | 'dm_first' | 'comment_keyword' | 'comment_any' | 'story_reply';
export type MatchMode = 'contains' | 'exact' | 'starts_with' | 'regex';

/** The round-5 `Rule` row plus the round-6 columns (migration 007). Older servers simply omit them. */
export interface AutomationRule extends Omit<Rule, 'trigger_type'> {
  trigger_type: AutomationTrigger;
  /** JSON array of Instagram media ids. null / '[]' = every post. */
  media_ids?: string | null;
  once_per_person?: number | null;
  last_error?: string | null;
  last_error_at?: number | null;
  /** set by GET /api/automations/starter when the rule came from a starter template */
  starter_key?: string;
}
export interface RulesResponse { rules: AutomationRule[] }

/**
 * What the builder edits. One chip per family: the `_keyword` / `_any` server variants are chosen
 * on save from whether keywords were typed, so nobody has to understand the difference.
 */
export type TriggerFamily = 'comment' | 'dm' | 'dm_first' | 'story_reply';

export interface RuleDraft {
  id?: number;
  name: string;
  enabled: boolean;
  trigger: TriggerFamily;
  matchMode: MatchMode;
  keywords: string[];
  /** empty = any post */
  mediaIds: string[];
  replyText: string;
  replyLink: string;
  publicReplyText: string;
  cooldownMinutes: number;
  oncePerPerson: boolean;
  priority: number;
}

export const TRIGGER_FAMILIES: Array<{ id: TriggerFamily; label: string; when: string; hint: string }> = [
  { id: 'comment', label: 'Comment on a post', when: 'someone comments on your post', hint: 'Instagram lets us answer a comment with one private DM, within 7 days of the comment.' },
  { id: 'dm', label: 'DM keyword', when: 'someone sends you a DM', hint: 'Leave the keywords empty to answer every DM that no other rule caught.' },
  { id: 'dm_first', label: 'First DM', when: 'someone messages you for the first time', hint: 'Fires once per person, on their very first message to you.' },
  { id: 'story_reply', label: 'Story reply', when: 'someone replies to your story', hint: 'Keywords are optional — leave them empty to answer every story reply.' },
];

export const MATCH_MODES: Array<{ id: MatchMode; label: string }> = [
  { id: 'contains', label: 'contains' },
  { id: 'exact', label: 'is exactly' },
  { id: 'starts_with', label: 'starts with' },
  { id: 'regex', label: 'matches regex' },
];

export const familyOf = (t: string | null | undefined): TriggerFamily =>
  t === 'dm_first' ? 'dm_first' : t === 'story_reply' ? 'story_reply' : String(t || '').startsWith('comment') ? 'comment' : 'dm';

/** Family + keywords → the trigger_type the server stores. */
export function triggerTypeOf(family: TriggerFamily, keywords: string[]): AutomationTrigger {
  if (family === 'dm_first') return 'dm_first';
  if (family === 'story_reply') return 'story_reply';
  if (family === 'comment') return keywords.length ? 'comment_keyword' : 'comment_any';
  return keywords.length ? 'dm_keyword' : 'dm_any';
}

/** Family + keywords in words, for rule rows and the builder summary. */
export function triggerSentence(family: TriggerFamily, keywords: string[], mediaCount: number): string {
  const kw = keywords.length ? `“${keywords.slice(0, 3).join('”, “')}”${keywords.length > 3 ? ` +${keywords.length - 3}` : ''}` : '';
  const where = family === 'comment' ? (mediaCount ? ` on ${mediaCount} selected post${mediaCount === 1 ? '' : 's'}` : ' on any post') : '';
  switch (family) {
    case 'comment': return keywords.length ? `Someone comments ${kw}${where}` : `Someone comments anything${where}`;
    case 'dm_first': return 'Someone messages you for the first time';
    case 'story_reply': return keywords.length ? `Someone replies to your story with ${kw}` : 'Someone replies to your story';
    default: return keywords.length ? `Someone DMs you ${kw}` : 'Someone DMs you anything';
  }
}

export const parseKeywords = (s: string | null | undefined): string[] => {
  try { const a = JSON.parse(s || '[]'); return Array.isArray(a) ? a.map(String) : []; } catch { return []; }
};
export const parseMediaIds = (s: string | null | undefined): string[] => {
  if (!s) return [];
  try { const a = JSON.parse(s); return Array.isArray(a) ? a.map(String) : []; } catch { return []; }
};

export const EMPTY_DRAFT: RuleDraft = {
  name: '', enabled: true, trigger: 'comment', matchMode: 'contains', keywords: [], mediaIds: [],
  replyText: '', replyLink: '', publicReplyText: '', cooldownMinutes: 1440, oncePerPerson: false, priority: 100,
};

export function draftFromRule(r: AutomationRule): RuleDraft {
  return {
    id: r.id,
    name: r.name,
    enabled: !!r.enabled,
    trigger: familyOf(r.trigger_type),
    matchMode: (r.match_mode as MatchMode) || 'contains',
    keywords: parseKeywords(r.keywords),
    mediaIds: parseMediaIds(r.media_ids),
    replyText: r.reply_text || '',
    replyLink: r.reply_link || '',
    publicReplyText: r.public_reply_text || '',
    cooldownMinutes: r.cooldown_minutes ?? 1440,
    oncePerPerson: !!r.once_per_person,
    priority: r.priority ?? 100,
  };
}

/** Request body for POST/PUT /api/automations/rules. Extra fields are ignored by an older server. */
export function ruleBody(d: RuleDraft): Record<string, unknown> {
  const isComment = d.trigger === 'comment';
  return {
    name: d.name.trim() || 'Untitled rule',
    enabled: d.enabled,
    trigger_type: triggerTypeOf(d.trigger, d.keywords),
    match_mode: d.matchMode,
    keywords: d.keywords,
    media_ids: isComment ? d.mediaIds : [],
    reply_text: d.replyText,
    reply_link: d.replyLink.trim(),
    public_reply_text: isComment ? d.publicReplyText : '',
    cooldown_minutes: d.cooldownMinutes,
    once_per_person: d.oncePerPerson,
    priority: d.priority,
  };
}

/** "once a day per person" — the cooldown in words. */
export function fmtCooldown(min: number): string {
  if (!min || min <= 0) return 'every time';
  if (min < 60) return `at most once every ${min} min per person`;
  if (min < 1440) return `at most once every ${Math.round(min / 60)} h per person`;
  if (min === 1440) return 'once a day per person';
  if (min === 10080) return 'once a week per person';
  return `at most once every ${Math.round(min / 1440)} days per person`;
}

/** The reply as Instagram will show it: {{username}} → @handle, link appended on its own line. */
export function renderReply(text: string, link: string, username: string | null | undefined): string {
  let out = (text || '').replace(/\{\{\s*username\s*\}\}/gi, username ? `@${username}` : 'there');
  if (link.trim()) out = `${out}\n${link.trim()}`.trim();
  return out;
}

/* ---------------- GET /api/automations/diagnostics ---------------- */

export type CheckStatus = 'ok' | 'warn' | 'fail';
export interface DiagnosticFix {
  label: string;
  /** a URL to open (external doc, or /api/instagram/connect) */
  href?: string | null;
  /** a server action the card can run — currently only 'resubscribe' (POST /api/automations/resubscribe) */
  action?: string | null;
}
export interface DiagnosticCheck {
  id: 'connected' | 'permissions' | 'webhook_subscribed' | 'app_published' | 'rules_enabled' | 'sends_quota' | 'messaging_window' | string;
  label: string;
  status: CheckStatus;
  detail: string;
  fix?: DiagnosticFix | null;
  /** optional per-rule notes (rules_enabled) */
  notes?: string[];
}
export interface DiagnosticsResponse {
  checks: DiagnosticCheck[];
  summary: { ok: number; warn: number; fail: number };
  lastInboundAt: number | null;
  lastOutboundAt: number | null;
  events24h: number;
  canFire: boolean;
  /** set by the web when the endpoint is missing (older server) — never sent by the server */
  unavailable?: boolean;
}

/* ---------------- POST /api/automations/simulate ---------------- */

export type SimulateKind = 'dm' | 'comment' | 'story_reply';
export interface SimulateRequest { kind: SimulateKind; text: string; mediaId?: string; senderUsername?: string }
export interface SimulateResponse {
  matched: { ruleId: number; name: string } | null;
  wouldSend: { dm?: string | null; publicReply?: string | null };
  skipped: Array<{ ruleId: number; name: string; reason: string }>;
}

/** POST /api/automations/rules/:id/test-send — a real send; `error` is Meta's message, verbatim. */
export interface TestSendResponse { ok: boolean; error?: string | null; result?: unknown }

/* ---------------- GET /api/instagram/media ---------------- */

export interface IgMediaItem {
  id: string;
  caption: string | null;
  type: string | null;          // IMAGE | VIDEO | CAROUSEL_ALBUM
  productType: string | null;   // FEED | REELS | STORY
  thumb: string | null;
  permalink: string | null;
  timestamp: number | null;     // unix seconds
  likes: number | null;
  comments: number | null;
}
export interface IgMediaResponse {
  media: IgMediaItem[];
  refreshedAt: number | null;
  /** set by the web when the endpoint is missing (older server) — never sent by the server */
  unavailable?: boolean;
}

/* ---------------- GET /api/automations/events ---------------- */

export interface AutomationEvent {
  id: number;
  ts: number;
  type: string;                 // dm_in | comment_in | dm_out | comment_reply_out | system | …
  direction: 'in' | 'out' | 'system';
  sender_id: string | null;
  sender_username: string | null;
  text: string | null;
  rule_id: number | null;
  /** 'ok' | 'error' | 'no_match' | 'skipped' | … */
  status: string;
  error: string | null;
  payload: string | null;
}
export interface EventsResponse { events: AutomationEvent[] }

export type LogFilter = 'all' | 'sent' | 'no_match' | 'error';
