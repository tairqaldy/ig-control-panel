import OpenAI, { toFile } from 'openai';
import { config } from '../config.js';
import { getSetting } from '../db.js';

/** One client per distinct key (env key shared by all tenants in hosted mode; self-hosters may set a key in Settings). */
const clients = new Map<string, OpenAI>();

/** Effective key for a tenant: the server env key wins; otherwise the tenant's own key from Settings. */
export function apiKey(tid: number): string {
  return config.openaiApiKey || getSetting(tid, 'openai_api_key') || '';
}

export function hasOpenAI(tid: number): boolean {
  return apiKey(tid).length > 10;
}

/** True when the key in use is the shared server key (so an OpenAI billing problem affects every tenant). */
export function usesSharedKey(): boolean {
  return !!config.openaiApiKey;
}

export function openai(tid: number): OpenAI {
  const key = apiKey(tid);
  if (!key) throw new Error('OPENAI_API_KEY is not configured. Set it as an environment variable or in Settings.');
  let client = clients.get(key);
  if (!client) {
    if (clients.size > 50) clients.clear();
    client = new OpenAI({ apiKey: key, baseURL: config.openaiBaseUrl, maxRetries: 4, timeout: 180_000 });
    clients.set(key, client);
  }
  return client;
}

export function models(tid: number) {
  // analysis model: explicit setting/env wins; otherwise the scope tier decides (standard → mini, economy → nano)
  let tier: string | null = null;
  try { const s = getSetting(tid, 'scope'); tier = s ? JSON.parse(s).tier || null : null; } catch {}
  const explicit = getSetting(tid, 'analysis_model') || process.env.OPENAI_MODEL || '';
  return {
    analysis: explicit || (tier === 'economy' ? 'gpt-5.4-nano' : config.analysisModel),
    ask: getSetting(tid, 'ask_model') || config.askModel,
    transcribe: getSetting(tid, 'transcribe_model') || config.transcribeModel,
    embed: config.embedModel,
  };
}

/** GPT-5-family / o-series accept `reasoning` and reject `temperature`. */
export function isReasoningModel(model: string): boolean {
  return /^(gpt-5|o\d)/i.test(model);
}

export function reasoningParams(model: string, effort: 'none' | 'minimal' | 'low' | 'medium' | 'high' = 'low'): Record<string, unknown> {
  if (!isReasoningModel(model)) return { temperature: 0.3 };
  // gpt-5.1+ support 'none'; gpt-5 base supports 'minimal'. We use 'low' by default which is broadly supported.
  return { reasoning: { effort } };
}

/**
 * Structured JSON generation using the Responses API.
 * `images` are data: URLs or https URLs.
 */
export async function generateStructured<T>(opts: {
  tid: number;
  model: string;
  system: string;
  user: string;
  images?: string[];
  schemaName: string;
  schema: Record<string, unknown>;
  maxOutputTokens?: number;
  effort?: 'none' | 'minimal' | 'low' | 'medium' | 'high';
}): Promise<{ data: T; usage: { input: number; output: number } }> {
  const client = openai(opts.tid);
  const content: any[] = [{ type: 'input_text', text: opts.user }];
  for (const img of opts.images || []) content.push({ type: 'input_image', image_url: img, detail: 'low' });

  const res: any = await client.responses.create({
    model: opts.model,
    instructions: opts.system,
    input: [{ role: 'user', content }],
    text: { format: { type: 'json_schema', name: opts.schemaName, schema: opts.schema as any, strict: true } },
    max_output_tokens: opts.maxOutputTokens ?? 2500,
    ...(reasoningParams(opts.model, opts.effort) as any),
  } as any);

  const text: string = res.output_text ?? extractOutputText(res);
  if (!text) {
    const refusal = findRefusal(res);
    throw new Error(refusal ? `Model refused: ${refusal}` : `Empty model output (status=${res.status}, incomplete=${JSON.stringify(res.incomplete_details || null)})`);
  }
  let data: T;
  try {
    data = JSON.parse(text) as T;
  } catch (e) {
    throw new Error(`Model returned invalid JSON: ${text.slice(0, 200)}`);
  }
  return { data, usage: { input: res.usage?.input_tokens ?? 0, output: res.usage?.output_tokens ?? 0 } };
}

function extractOutputText(res: any): string {
  try {
    const parts: string[] = [];
    for (const out of res.output || []) {
      if (out.type === 'message') for (const c of out.content || []) if (c.type === 'output_text') parts.push(c.text);
    }
    return parts.join('');
  } catch {
    return '';
  }
}
function findRefusal(res: any): string | null {
  try {
    for (const out of res.output || []) if (out.type === 'message') for (const c of out.content || []) if (c.type === 'refusal') return c.refusal;
  } catch {}
  return null;
}

/** Streaming plain-text generation (for Ask). Yields text deltas. */
export async function* streamText(opts: {
  tid: number;
  model: string;
  system: string;
  messages: Array<{ role: 'user' | 'assistant'; content: string }>;
  effort?: 'none' | 'minimal' | 'low' | 'medium' | 'high';
  maxOutputTokens?: number;
}): AsyncGenerator<string, void, unknown> {
  const client = openai(opts.tid);
  const stream: any = await client.responses.create({
    model: opts.model,
    instructions: opts.system,
    input: opts.messages.map((m) => ({ role: m.role, content: m.content })),
    stream: true,
    max_output_tokens: opts.maxOutputTokens ?? 1800,
    ...(reasoningParams(opts.model, opts.effort) as any),
  } as any);
  for await (const event of stream) {
    if (event?.type === 'response.output_text.delta' && typeof event.delta === 'string') yield event.delta;
    else if (event?.type === 'response.error') throw new Error(event.error?.message || 'stream error');
    else if (event?.type === 'error') throw new Error(event.message || 'stream error');
  }
}

export async function transcribeFile(tid: number, buf: Buffer, filename: string, opts?: { language?: string; prompt?: string }): Promise<{ text: string; language?: string }> {
  const client = openai(tid);
  const model = models(tid).transcribe;
  const file = await toFile(buf, filename);
  const params: any = { file, model, response_format: 'json' };
  if (opts?.prompt) params.prompt = opts.prompt;
  if (opts?.language) params.language = opts.language;
  const res: any = await client.audio.transcriptions.create(params);
  const text = typeof res === 'string' ? res : res.text || '';
  return { text: (text || '').trim(), language: res?.language };
}

export async function embedTexts(tid: number, texts: string[]): Promise<Float32Array[]> {
  return (await embedTextsWithUsage(tid, texts)).vectors;
}
export async function embedTextsWithUsage(tid: number, texts: string[]): Promise<{ vectors: Float32Array[]; tokens: number }> {
  if (!texts.length) return { vectors: [], tokens: 0 };
  const client = openai(tid);
  const res = await client.embeddings.create({ model: models(tid).embed, input: texts, dimensions: config.embedDims });
  return { vectors: res.data.sort((a, b) => a.index - b.index).map((d) => Float32Array.from(d.embedding)), tokens: res.usage?.total_tokens ?? 0 };
}

/** OpenAI billing/quota errors — the account is out of money, not a transient rate limit. */
export function isQuotaError(e: unknown): boolean {
  const msg = String((e as any)?.message || e || '');
  const code = (e as any)?.code || (e as any)?.error?.code || '';
  return /insufficient_quota|no credits remaining|exceeded your current quota|billing_hard_limit|billing/i.test(msg) || /insufficient_quota/i.test(String(code));
}

/**
 * Circuit breaker for OpenAI billing outages.
 *
 * When the account runs out of credits, every embedding call still costs a full round trip plus the SDK's retries —
 * about 7 seconds. Optional features (semantic search, related items) then feel broken rather than merely degraded,
 * on every keystroke. Once a quota error is seen we stop trying for a few minutes and fall straight through to the
 * keyword path; the first call after that window probes again, so recovery needs no restart.
 */
const QUOTA_COOLDOWN_MS = 5 * 60_000;
let quotaBlockedUntil = 0;

/** Record a quota failure so optional callers can skip OpenAI for a while. */
export function noteQuotaFailure(e: unknown): boolean {
  if (!isQuotaError(e)) return false;
  const first = Date.now() > quotaBlockedUntil;
  quotaBlockedUntil = Date.now() + QUOTA_COOLDOWN_MS;
  if (first) console.error(`[openai] out of credits — skipping optional model calls for ${QUOTA_COOLDOWN_MS / 60_000} minutes`);
  return true;
}

/** True while we are inside that cooldown. Only optional features should consult this. */
export function quotaBlocked(): boolean {
  return Date.now() < quotaBlockedUntil;
}

/** Test hook: forget the cooldown, so one assertion about an outage does not colour the next one. */
export function _clearQuotaBlock(): void {
  quotaBlockedUntil = 0;
}

export function embeddingToBuffer(v: Float32Array): Buffer {
  return Buffer.from(v.buffer, v.byteOffset, v.byteLength);
}
export function bufferToEmbedding(b: Buffer): Float32Array {
  const copy = new Uint8Array(b.byteLength);
  copy.set(b);
  return new Float32Array(copy.buffer);
}
export function cosine(a: Float32Array, b: Float32Array): number {
  let dot = 0, na = 0, nb = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  if (!na || !nb) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/** Test the configured key/models with a tiny call. */
export async function testOpenAI(tid: number): Promise<{ ok: boolean; message: string; model: string }> {
  const m = models(tid).analysis;
  try {
    const client = openai(tid);
    const res: any = await client.responses.create({ model: m, input: 'Reply with the single word OK.', max_output_tokens: 16, ...(reasoningParams(m, 'low') as any) } as any);
    const out = (res.output_text || '').trim();
    return { ok: true, message: `Model ${m} responded: ${out.slice(0, 40)}`, model: m };
  } catch (e: any) {
    return { ok: false, message: e?.message || String(e), model: m };
  }
}
