/**
 * OpenAI list prices (USD) used for cost ESTIMATES shown in the UI and stored per item.
 * These are the published prices as of Aug 2026; override with the PRICES_JSON env var if they change:
 *   PRICES_JSON='{"gpt-5.4-mini":{"in":0.75,"out":4.5}}'
 * "in"/"out" = $ per 1M tokens; "min" = $ per audio minute; "embed" = $ per 1M tokens.
 */
export interface ModelPrice { in?: number; out?: number; min?: number; embed?: number }

const DEFAULT_PRICES: Record<string, ModelPrice> = {
  // analysis / ask
  'gpt-5.4-mini': { in: 0.75, out: 4.5 },
  'gpt-5.4-nano': { in: 0.2, out: 1.25 },
  'gpt-5.4': { in: 2.5, out: 15 },
  'gpt-5-mini': { in: 0.25, out: 2.0 },
  'gpt-5-nano': { in: 0.05, out: 0.4 },
  'gpt-5': { in: 1.25, out: 10 },
  'gpt-4.1-mini': { in: 0.4, out: 1.6 },
  'gpt-4.1-nano': { in: 0.1, out: 0.4 },
  'gpt-4o-mini': { in: 0.15, out: 0.6 },
  'gpt-4o': { in: 2.5, out: 10 },
  // transcription
  'gpt-4o-mini-transcribe': { min: 0.003 },
  'gpt-4o-transcribe': { min: 0.006 },
  'gpt-transcribe': { min: 0.0045 },
  'whisper-1': { min: 0.006 },
  // embeddings
  'text-embedding-3-small': { embed: 0.02 },
  'text-embedding-3-large': { embed: 0.13 },
};

let overrides: Record<string, ModelPrice> = {};
try { overrides = process.env.PRICES_JSON ? JSON.parse(process.env.PRICES_JSON) : {}; } catch { overrides = {}; }

export function priceFor(model: string): ModelPrice {
  const all = { ...DEFAULT_PRICES, ...overrides };
  // exact match first, then the LONGEST prefix (so 'gpt-4o-mini-transcribe' never resolves to 'gpt-4o-mini')
  const key = all[model] ? model : Object.keys(all).filter((k) => model.startsWith(k + '-')).sort((a, b) => b.length - a.length)[0] || model;
  return { ...(DEFAULT_PRICES[key] || {}), ...(overrides[key] || {}) };
}

export interface Usage {
  analysis?: { model: string; input: number; output: number };
  transcribe?: { model: string; seconds: number };
  embed?: { model: string; tokens: number };
  notes?: { model: string; input: number; output: number };
}

export function costOf(u: Usage): number {
  let c = 0;
  if (u.analysis) { const p = priceFor(u.analysis.model); c += (u.analysis.input * (p.in || 0) + u.analysis.output * (p.out || 0)) / 1e6; }
  if (u.transcribe) { const p = priceFor(u.transcribe.model); c += (u.transcribe.seconds / 60) * (p.min || 0); }
  if (u.embed) { const p = priceFor(u.embed.model); c += (u.embed.tokens * (p.embed || 0)) / 1e6; }
  if (u.notes) { const p = priceFor(u.notes.model); c += (u.notes.input * (p.in || 0) + u.notes.output * (p.out || 0)) / 1e6; }
  return Math.round(c * 1e6) / 1e6;
}

/**
 * Typical token footprints measured on real saves (Aug 2026, gpt-5.x mini/nano at detail:low):
 *  - text part of the prompt (metadata + caption + transcript + tag vocabulary): ~1,900 tokens
 *  - each low-detail image: ~415 tokens (mini/nano/5.x), 2,833 on gpt-4o-mini
 *  - output JSON incl. reasoning: ~600 tokens
 */
export function estimateItemCost(opts: { model: string; transcribeModel: string; embedModel: string; frames: number; hasVideo: boolean; transcribeSeconds: number; hasTranscript?: boolean }): number {
  const imgTokens = /gpt-4o-mini/.test(opts.model) ? 2833 : 415;
  const input = 1900 + (opts.hasTranscript ?? opts.transcribeSeconds > 0 ? 400 : 0) + opts.frames * imgTokens;
  const output = 600;
  return costOf({
    analysis: { model: opts.model, input, output },
    transcribe: opts.hasVideo && opts.transcribeSeconds > 0 ? { model: opts.transcribeModel, seconds: opts.transcribeSeconds } : undefined,
    embed: { model: opts.embedModel, tokens: 900 },
  });
}
