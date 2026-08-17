/* Round 6 §2 — the queries the automations page shares. Every round-6 endpoint is additive, so each
   fetcher turns a 404/501 into `{ unavailable: true }` and the panel that owns it hides itself. */
import { useQuery } from '@tanstack/react-query';
import { api, ApiError } from '../../lib/api';
import type { AutomationEvent, AutomationRule, DiagnosticsResponse, EventsResponse, IgMediaResponse, RulesResponse, SimulateRequest, SimulateResponse } from '../../lib/types-automations';

export const DIAGNOSTICS_KEY = ['auto-diagnostics'] as const;
export const IG_MEDIA_KEY = ['ig-media'] as const;
export const EVENTS_KEY = ['auto-events'] as const;
export const RULES_KEY = ['rules'] as const;

const missing = (e: unknown) => e instanceof ApiError && (e.status === 404 || e.status === 405 || e.status === 501);

/** GET /api/automations/diagnostics — the health card. */
export async function fetchDiagnostics(): Promise<DiagnosticsResponse> {
  const empty: DiagnosticsResponse = { checks: [], summary: { ok: 0, warn: 0, fail: 0 }, lastInboundAt: null, lastOutboundAt: null, events24h: 0, canFire: false, unavailable: true };
  try {
    const r = await api.get<DiagnosticsResponse | string>('/api/automations/diagnostics');
    if (!r || typeof r !== 'object' || !Array.isArray((r as DiagnosticsResponse).checks)) return empty; // SPA html from an older server
    const d = r as DiagnosticsResponse;
    return { ...d, summary: d.summary || { ok: 0, warn: 0, fail: 0 }, events24h: d.events24h ?? 0 };
  } catch (e) {
    if (missing(e)) return empty;
    throw e;
  }
}
export function useDiagnostics() {
  return useQuery({ queryKey: DIAGNOSTICS_KEY, queryFn: fetchDiagnostics, staleTime: 20_000, retry: 1, refetchInterval: 60_000 });
}

/** GET /api/instagram/media — the post picker's grid. */
export async function fetchIgMedia(): Promise<IgMediaResponse> {
  try {
    const r = await api.get<IgMediaResponse | string>('/api/instagram/media');
    if (!r || typeof r !== 'object' || !Array.isArray((r as IgMediaResponse).media)) return { media: [], refreshedAt: null, unavailable: true };
    const d = r as IgMediaResponse;
    return { media: d.media, refreshedAt: d.refreshedAt ?? null };
  } catch (e) {
    if (missing(e)) return { media: [], refreshedAt: null, unavailable: true };
    throw e;
  }
}
export function useIgMedia(enabled = true) {
  return useQuery({ queryKey: IG_MEDIA_KEY, queryFn: fetchIgMedia, enabled, staleTime: 5 * 60_000, retry: 1 });
}

export function useRules() {
  return useQuery({ queryKey: RULES_KEY, queryFn: () => api.get<RulesResponse>('/api/automations/rules') });
}

export function useAutomationEvents(limit = 200) {
  return useQuery({
    queryKey: [...EVENTS_KEY, limit],
    queryFn: async (): Promise<AutomationEvent[]> => {
      const r = await api.get<EventsResponse>(`/api/automations/events?limit=${limit}`);
      return Array.isArray(r?.events) ? r.events : [];
    },
    refetchInterval: 10_000,
  });
}

/**
 * POST /api/automations/simulate. Falls back to the round-5 `/api/automations/test` (which answers
 * `{ matched, candidates }`) so the panel still works against a server that has not shipped §1 yet.
 */
export async function simulate(body: SimulateRequest, rules: AutomationRule[]): Promise<SimulateResponse> {
  try {
    const r = await api.post<SimulateResponse>('/api/automations/simulate', body);
    return { matched: r?.matched ?? null, wouldSend: r?.wouldSend || {}, skipped: Array.isArray(r?.skipped) ? r.skipped : [] };
  } catch (e) {
    if (!missing(e)) throw e;
    const legacy = await api.post<{ matched: AutomationRule | null; candidates: Array<{ id: number; name: string; enabled: boolean; matches: boolean }> }>('/api/automations/test', { kind: body.kind, text: body.text });
    const matched = legacy?.matched ?? null;
    const byId = new Map(rules.map((r) => [r.id, r]));
    return {
      matched: matched ? { ruleId: matched.id, name: matched.name } : null,
      wouldSend: matched ? { dm: matched.reply_text, publicReply: matched.public_reply_text } : {},
      skipped: (legacy?.candidates || [])
        .filter((c) => c.id !== matched?.id)
        .map((c) => ({ ruleId: c.id, name: c.name || byId.get(c.id)?.name || `Rule ${c.id}`, reason: !c.enabled ? 'the rule is switched off' : !c.matches ? 'the text does not match its keywords' : 'another rule matched first' })),
    };
  }
}

/* ---------------- Round 7 §5 — is connecting Instagram possible at all? ---------------- */

/**
 * `GET /api/instagram/availability` (ROUND7-SPEC §3, owned by the server side). A server that does not
 * have the endpoint answers 404, and everything falls back to the round-6 behaviour — so the fallback
 * says `canConnect: true`: a missing endpoint must never hide a Connect button that would have worked.
 */
export interface IgAvailability {
  canConnect: boolean;
  mode: 'live' | 'development' | 'unconfigured' | string;
  /** one sentence from the server explaining the current state, shown verbatim */
  reason: string;
  /** this tenant already asked to be told when connecting opens */
  waitlist: boolean;
  /** the server's own call on whether "tell me when it opens" makes sense here (nothing to wait for on a self-hosted server) */
  waitlistOffered?: boolean;
  /** where the notice will go, when we know it */
  waitlistEmail?: string | null;
  connected?: boolean;
  username?: string | null;
  /** set by the web when the endpoint is missing — never sent by the server */
  unavailable?: boolean;
}

export const IG_AVAILABILITY_KEY = ['ig-availability'] as const;

export async function fetchIgAvailability(): Promise<IgAvailability> {
  const unknown: IgAvailability = { canConnect: true, mode: 'unconfigured', reason: '', waitlist: false, unavailable: true };
  try {
    const r = await api.get<IgAvailability | string>('/api/instagram/availability');
    if (!r || typeof r !== 'object' || typeof (r as IgAvailability).canConnect !== 'boolean') return unknown; // SPA html from an older server
    const d = r as IgAvailability;
    return {
      canConnect: d.canConnect, mode: d.mode || 'unconfigured', reason: String(d.reason || ''), waitlist: !!d.waitlist,
      waitlistOffered: typeof d.waitlistOffered === 'boolean' ? d.waitlistOffered : undefined,
      waitlistEmail: d.waitlistEmail ?? null, connected: !!d.connected, username: d.username ?? null,
    };
  } catch (e) {
    if (missing(e)) return unknown;
    throw e;
  }
}

export function useIgAvailability() {
  return useQuery({ queryKey: IG_AVAILABILITY_KEY, queryFn: fetchIgAvailability, staleTime: 5 * 60_000, retry: 1 });
}
