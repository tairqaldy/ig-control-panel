/* Ask v2 client (ROUND5-SPEC §6): conversations CRUD, suggestions, and the SSE stream on top of lib/api.ts ssePost.
   Everything here is tolerant of the older server (no `meta` event, no conversation endpoints) so the page keeps working
   while the server-ask work lands: unknown endpoints resolve to empty data, unknown events are ignored. */
import { api, ssePost, ApiError } from './api';
import type { AskSource } from './types';
import type { AskDone, AskIntent, AskMeta, AskMode, AskStreamHandlers, AskStreamRequest, AskStreamResult, AskSuggestion, Conversation, ConversationDetail, ServerMessage } from './types-ask';

const INTENTS: AskIntent[] = ['library', 'stats', 'inspire', 'create', 'analytics', 'chat'];
export function normIntent(v: unknown): AskIntent | null {
  const s = typeof v === 'string' ? v.toLowerCase().trim() : '';
  return (INTENTS as string[]).includes(s) ? (s as AskIntent) : null;
}
const num = (v: unknown): number | null => (v === null || v === undefined || v === '' ? null : Number.isFinite(Number(v)) ? Number(v) : null);
const secs = (v: unknown): number => { const n = num(v); if (n === null) return Math.floor(Date.now() / 1000); return n > 1e12 ? Math.floor(n / 1000) : n; };

function normSources(v: unknown): AskSource[] {
  let arr: unknown = v;
  if (typeof arr === 'string') { try { arr = JSON.parse(arr); } catch { arr = []; } }
  if (arr && !Array.isArray(arr) && typeof arr === 'object' && Array.isArray((arr as any).sources)) arr = (arr as any).sources;
  if (!Array.isArray(arr)) return [];
  return arr.filter((s) => s && typeof s === 'object' && s.id).map((s: any) => ({
    id: String(s.id), title: String(s.title || ''), one_liner: String(s.one_liner || s.oneLiner || ''), author: s.author ?? null, url: String(s.url || ''),
    thumb: s.thumb ?? null, category: s.category ?? null, tags: Array.isArray(s.tags) ? s.tags.map(String) : [], score: Number(s.score || 0),
  }));
}
function normConversation(r: any): Conversation {
  return { id: Number(r.id), title: String(r.title || 'Untitled'), updatedAt: secs(r.updatedAt ?? r.updated_at), createdAt: num(r.createdAt ?? r.created_at) ?? undefined, pinned: !!(r.pinned && r.pinned !== '0'), messageCount: Number(r.messageCount ?? r.message_count ?? 0) };
}
function normMessage(m: any, i: number): ServerMessage {
  return { id: Number(m.id ?? i), role: m.role === 'user' ? 'user' : 'assistant', content: String(m.content ?? ''), sources: normSources(m.sources), intent: normIntent(m.intent), createdAt: secs(m.createdAt ?? m.created_at) };
}

/** True when the endpoint is simply not there yet (older server) — callers degrade gracefully instead of toasting. */
export const isMissingEndpoint = (e: unknown): boolean => e instanceof ApiError && (e.status === 404 || e.status === 405);

/* ---------------- Conversations ---------------- */
export async function listConversations(): Promise<Conversation[]> {
  const raw = await api.get<unknown>('/api/ask/conversations');
  const arr = Array.isArray(raw) ? raw : Array.isArray((raw as any)?.conversations) ? (raw as any).conversations : [];
  return arr.map(normConversation);
}
export async function createConversation(title?: string): Promise<Conversation> {
  const raw = await api.post<any>('/api/ask/conversations', title ? { title } : {});
  return normConversation(raw?.conversation ?? raw);
}
export async function getConversation(id: number): Promise<ConversationDetail> {
  const raw = await api.get<any>(`/api/ask/conversations/${id}`);
  const messages: unknown[] = Array.isArray(raw) ? raw : Array.isArray(raw?.messages) ? raw.messages : [];
  const head = Array.isArray(raw) ? {} : raw?.conversation ?? raw ?? {};
  return { id: Number(head.id ?? id), title: String(head.title || ''), pinned: !!(head.pinned && head.pinned !== '0'), messages: messages.map(normMessage) };
}
export async function updateConversation(id: number, patch: { title?: string; pinned?: boolean }): Promise<void> {
  await api.patch(`/api/ask/conversations/${id}`, patch);
}
export async function deleteConversation(id: number): Promise<void> {
  await api.del(`/api/ask/conversations/${id}`);
}

/* ---------------- Suggestions ---------------- */
export async function getSuggestions(): Promise<AskSuggestion[]> {
  const raw = await api.get<unknown>('/api/ask/suggestions');
  const arr: unknown[] = Array.isArray(raw) ? raw : Array.isArray((raw as any)?.suggestions) ? (raw as any).suggestions : Array.isArray((raw as any)?.prompts) ? (raw as any).prompts : [];
  return arr.map((s: any): AskSuggestion | null => {
    if (typeof s === 'string') return s.trim() ? { text: s.trim() } : null;
    if (s && typeof s === 'object') { const text = String(s.text ?? s.prompt ?? s.question ?? s.q ?? '').trim(); return text ? { text, intent: normIntent(s.intent), hint: s.hint ?? s.label ?? s.why ?? null } : null; }
    return null;
  }).filter((s): s is AskSuggestion => !!s);
}

/* ---------------- Modes ---------------- */
export const MODE_LABEL: Record<AskMode, string> = { library: 'Ask my saves', create: 'Content brief', stats: 'My taste', analytics: 'Analytics' };
export const MODE_HINT: Record<AskMode, string> = {
  library: 'Answers only from your saves, with citations you can open.',
  create: 'A brief you can shoot: hook options, outline, CTA, format — built from the saves that fit.',
  stats: 'What you save most, which creators, which formats — your patterns in numbers.',
  analytics: 'Your Instagram numbers (reach, saves, best time to post) if the account is connected.',
};
/** Mode chip → forced strategy sent as `intent` in the POST body. `library` (the default chip) lets the server route the question. */
export const MODE_INTENT: Record<AskMode, AskIntent | null> = { library: null, create: 'create', stats: 'stats', analytics: 'analytics' };
export const INTENT_LABEL: Record<AskIntent, string> = { library: 'From your saves', stats: 'Your taste', inspire: 'Ideas from your saves', create: 'Content brief', analytics: 'Your Instagram numbers', chat: 'General', guide: 'About Resurfly' };

/* ---------------- Stream ---------------- */
function deltaText(data: unknown): string {
  if (typeof data === 'string') return data;
  if (data && typeof data === 'object') { const d = data as any; const t = d.delta ?? d.text ?? d.content ?? d.token ?? d.chunk; return typeof t === 'string' ? t : ''; }
  return '';
}
function normMeta(data: any, prev: AskMeta): AskMeta {
  return { conversationId: num(data?.conversationId ?? data?.conversation_id ?? data?.id) ?? prev.conversationId, title: typeof data?.title === 'string' && data.title.trim() ? data.title.trim() : prev.title, intent: normIntent(data?.intent) ?? prev.intent, isNew: typeof data?.isNew === 'boolean' ? data.isNew : prev.isNew };
}
function normDone(data: any, meta: AskMeta): AskDone {
  const q = data?.quota && typeof data.quota === 'object' ? { used: Number(data.quota.used || 0), limit: data.quota.limit === undefined || data.quota.limit === null ? null : Number(data.quota.limit), remaining: data.quota.remaining === undefined || data.quota.remaining === null ? null : Number(data.quota.remaining), resetsAt: num(data.quota.resetsAt) } : null;
  return { ok: data?.ok !== false, conversationId: num(data?.conversationId ?? data?.conversation_id) ?? meta.conversationId, title: typeof data?.title === 'string' && data.title.trim() ? data.title.trim() : meta.title, intent: normIntent(data?.intent) ?? meta.intent, messageId: num(data?.messageId), quota: q };
}

/**
 * POST /api/ask as SSE — body `{ question, conversationId?, history?, intent? }`. Events consumed:
 *   meta {conversationId,title,intent,filters,via,isNew} (first) · sources AskSource[] · delta "…" (also token|chunk|text, or {delta|text|content})
 *   intent {intent} · title {title} · done {ok, conversationId, title, intent, messageId, quota} · error {message, conversationId?}
 * Resolves (never rejects) with the assembled result; network/HTTP errors land in `error` (a 402 also fires the global rs:quota event via ssePost).
 */
export async function streamAsk(req: AskStreamRequest, h: AskStreamHandlers = {}): Promise<AskStreamResult> {
  const res: AskStreamResult = { content: '', sources: [], meta: { conversationId: req.conversationId ?? null, title: null, intent: null }, done: null, error: null, aborted: false };
  const body: Record<string, unknown> = { question: req.question };
  if (req.conversationId) body.conversationId = req.conversationId;
  if (req.history?.length) body.history = req.history;
  if (req.intent) body.intent = req.intent;
  try {
    await ssePost('/api/ask', body, {
      signal: h.signal,
      onEvent: (ev, data) => {
        switch (ev) {
          case 'meta': res.meta = normMeta(data, res.meta); h.onMeta?.(res.meta); break;
          case 'intent': res.meta = normMeta({ intent: typeof data === 'string' ? data : data?.intent }, res.meta); h.onMeta?.(res.meta); break;
          case 'title': res.meta = normMeta({ title: typeof data === 'string' ? data : data?.title }, res.meta); h.onMeta?.(res.meta); break;
          case 'sources': res.sources = normSources(data); h.onSources?.(res.sources); break;
          case 'delta': case 'token': case 'chunk': case 'text': { const t = deltaText(data); if (t) { res.content += t; h.onDelta?.(t); } break; }
          case 'message': { if (typeof data === 'string') { res.content += data; h.onDelta?.(data); } break; }
          case 'done': res.done = normDone(data, res.meta); if (res.done.conversationId && !res.meta.conversationId) res.meta = { ...res.meta, conversationId: res.done.conversationId }; h.onDone?.(res.done); break;
          case 'error': { const m = (data && typeof data === 'object' && (data.message || data.error)) || (typeof data === 'string' ? data : '') || 'Something went wrong'; res.error = String(m); h.onError?.(res.error); break; }
          default: break;
        }
      },
    });
  } catch (e: any) {
    if (e?.name === 'AbortError') res.aborted = true;
    else { res.error = e instanceof ApiError ? friendlyHttpError(e) : e?.message || 'Request failed'; h.onError?.(res.error!); }
  }
  return res;
}

export function friendlyHttpError(e: ApiError): string {
  if (e.status === 402) return e.message || 'Question allowance used — upgrade to keep asking.';
  if (e.status === 503) return e.message || 'OpenAI is not configured on this server yet.';
  if (e.status === 429) return e.message || 'Too many questions in a row — give it a few seconds.';
  if (e.status >= 500) return 'The server had trouble answering. Try again in a moment.';
  return e.message || `HTTP ${e.status}`;
}

/** Answer text ready for the clipboard: `[#id]` → `[n]`, plus a numbered source list with titles and links. */
export function answerToClipboard(content: string, sources: AskSource[]): string {
  const idx = new Map(sources.map((s, i) => [s.id, i + 1]));
  const body = content.replace(/\[#([A-Za-z0-9_-]+)\]/g, (m, id) => { const n = idx.get(id) ?? (/^\d+$/.test(id) && Number(id) <= sources.length ? Number(id) : null); return n ? `[${n}]` : m; });
  if (!sources.length) return body.trim();
  const list = sources.map((s, i) => `[${i + 1}] ${s.title}${s.author ? ` — @${s.author}` : ''}${s.url ? ` — ${s.url}` : ''}`).join('\n');
  return `${body.trim()}\n\nSources\n${list}`;
}
