/**
 * Ask v2 — conversations CRUD + suggested prompts (ROUND5-SPEC §6). Mounted at /api/ask via mountProtectedExtras.
 * The streaming `POST /api/ask` itself lives in routes/misc.ts (kept there so its URL never moves).
 *
 *   GET    /api/ask/conversations          → ConversationSummary[] (newest 50, pinned first)
 *   POST   /api/ask/conversations {title?} → ConversationSummary
 *   GET    /api/ask/conversations/:id      → { conversation, messages: MessageOut[] }
 *   PATCH  /api/ask/conversations/:id {title?, pinned?} → ConversationSummary
 *   DELETE /api/ask/conversations/:id      → { ok }
 *   GET    /api/ask/suggestions            → { suggestions: AskSuggestion[] (8), empty: bool, analyticsConnected: bool }
 *   GET    /api/ask/stats                  → StatsSummary (the same summary the `stats` strategy injects; handy for the UI)
 */
import { Hono } from 'hono';
import { tid } from '../auth.js';
import { createConversation, deleteConversation, getConversation, igConnected, listConversations, listMessages, statsSummary, suggestions, updateConversation } from '../services/ask.js';

export const askV2 = new Hono();

function idParam(c: any): number | null {
  const n = Number(c.req.param('id'));
  return Number.isInteger(n) && n > 0 ? n : null;
}

askV2.get('/conversations', (c) => {
  const n = Number(c.req.query('limit') || 50);
  const limit = Number.isFinite(n) ? Math.min(200, Math.max(1, Math.floor(n))) : 50;
  return c.json(listConversations(tid(c), limit));
});

askV2.post('/conversations', async (c) => {
  const body = await c.req.json<{ title?: string }>().catch(() => ({}) as { title?: string });
  const title = typeof body.title === 'string' && body.title.trim() ? body.title.trim() : null;
  return c.json(createConversation(tid(c), title), 201);
});

askV2.get('/conversations/:id', (c) => {
  const id = idParam(c);
  if (!id) return c.json({ error: 'bad id' }, 400);
  const t = tid(c);
  const conversation = getConversation(t, id);
  if (!conversation) return c.json({ error: 'not found' }, 404);
  return c.json({ conversation, messages: listMessages(t, id) || [] });
});

askV2.patch('/conversations/:id', async (c) => {
  const id = idParam(c);
  if (!id) return c.json({ error: 'bad id' }, 400);
  const t = tid(c);
  if (!getConversation(t, id)) return c.json({ error: 'not found' }, 404);
  const body = await c.req.json<{ title?: string | null; pinned?: boolean }>().catch(() => ({}) as any);
  const patch: { title?: string | null; pinned?: boolean } = {};
  if (body.title !== undefined) patch.title = body.title === null ? null : String(body.title).trim().slice(0, 120) || null;
  if (body.pinned !== undefined) patch.pinned = !!body.pinned;
  return c.json(updateConversation(t, id, patch));
});

askV2.delete('/conversations/:id', (c) => {
  const id = idParam(c);
  if (!id) return c.json({ error: 'bad id' }, 400);
  const ok = deleteConversation(tid(c), id);
  return ok ? c.json({ ok: true }) : c.json({ error: 'not found' }, 404);
});

askV2.get('/suggestions', async (c) => {
  const t = tid(c);
  const list = await suggestions(t);
  const empty = list.length > 0 && list.every((s) => s.kind === 'onboarding' || s.text.startsWith('Once my saves'));
  return c.json({ suggestions: list, empty, analyticsConnected: igConnected(t) });
});

askV2.get('/stats', (c) => c.json(statsSummary(tid(c))));
