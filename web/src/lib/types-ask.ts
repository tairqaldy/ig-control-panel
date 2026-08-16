/* Types for Ask v2 (ROUND5-SPEC §6). Owned by the web-ask agent; the shared `AskSource` stays in lib/types.ts. */
import type { AskSource, Limit } from './types';
export type { AskSource };

/** Server-side intent router output. `guide` is web-only (local product tour, never sent to the server). */
export type AskIntent = 'library' | 'stats' | 'inspire' | 'create' | 'analytics' | 'chat' | 'guide';

/** Composer mode chips. `library` = let the server route the question (default); the others force that strategy via `intent` in the POST body. */
export type AskMode = 'library' | 'create' | 'stats' | 'analytics';

export interface AskQuota { used: number; limit: Limit; remaining?: Limit; resetsAt?: number | null }

/** One row of `GET /api/ask/conversations`. */
export interface Conversation { id: number; title: string; updatedAt: number; createdAt?: number; pinned: boolean; messageCount: number }

/** One row of `messages` (as returned by `GET /api/ask/conversations/:id`), normalized. */
export interface ServerMessage { id: number; role: 'user' | 'assistant'; content: string; sources: AskSource[]; intent: AskIntent | null; createdAt: number }

/** `GET /api/ask/conversations/:id`, normalized (the server may return the array alone or `{ …conversation, messages }`). */
export interface ConversationDetail { id: number; title: string; pinned: boolean; messages: ServerMessage[] }

/** A message as the Ask page renders it. `localId` is stable across streaming updates; `serverId` is set once known. */
export interface AskMessage {
  localId: string;
  serverId?: number;
  role: 'user' | 'assistant';
  content: string;
  sources: AskSource[];
  intent: AskIntent | null;
  createdAt: number;
  /** assistant only */
  streaming?: boolean;
  error?: string;
  /** assistant only: the question that produced it (for Regenerate / "Show these in the Library"). */
  question?: string;
  /** web-only message (product tour); never persisted, never sent as history. */
  local?: boolean;
}

/** `GET /api/ask/suggestions` entry, normalized (the server may send plain strings). */
export interface AskSuggestion { text: string; intent?: AskIntent | null; hint?: string | null }

/* ---------------- SSE stream (`POST /api/ask`) ---------------- */
export interface AskStreamRequest { question: string; conversationId?: number | null; history?: Array<{ role: 'user' | 'assistant'; content: string }>; /** force a strategy (mode chips); omit to let the server route */ intent?: AskIntent | null }
export interface AskMeta { conversationId: number | null; title: string | null; intent: AskIntent | null; isNew?: boolean }
export interface AskDone { ok: boolean; conversationId: number | null; title: string | null; intent: AskIntent | null; messageId: number | null; quota: AskQuota | null }
export interface AskStreamHandlers {
  onMeta?: (meta: AskMeta) => void;
  onSources?: (sources: AskSource[]) => void;
  onDelta?: (text: string) => void;
  onDone?: (done: AskDone) => void;
  onError?: (message: string) => void;
  signal?: AbortSignal;
}
export interface AskStreamResult { content: string; sources: AskSource[]; meta: AskMeta; done: AskDone | null; error: string | null; aborted: boolean }
