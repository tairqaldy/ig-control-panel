/**
 * Shared state for the /welcome wizard (ROUND7-SPEC §2): the step in the URL, the jobs poll every screen leans on,
 * and the Instagram availability contract from §3.
 *
 * The step lives in `?step=N` so reload and the browser Back button both do the obvious thing; the furthest screen
 * reached is mirrored to localStorage and to the tenant's onboarding meta (`welcome_step`), so a bare `/welcome`
 * resumes instead of restarting — on this browser, and on the next one they sign in from.
 */
import { useCallback, useEffect, useRef } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useSearchParams } from 'react-router';
import { api, ApiError } from '../../lib/api';
import type { IgAvailability, IgAvailabilityMode, IgWaitlistFailure, IgWaitlistResult, WelcomeStep, WorkerStatusX } from '../../lib/types-onboarding';
import { useOnboarding } from '../Onboarding';
import { fetchIgAccount } from '../instagram/useIgAccount';

export const WELCOME_STEP_LABELS: Record<WelcomeStep, string> = {
  1: 'Bring your saves in',
  2: 'Watch it work',
  3: 'Ask your first question',
  4: 'Instagram',
  5: 'Done',
};

const STEP_KEY = 'rs-welcome-step';
const readStored = (): number => { try { return Number(localStorage.getItem(STEP_KEY) || 0); } catch { return 0; } };
const writeStored = (s: WelcomeStep) => { try { localStorage.setItem(STEP_KEY, String(s)); } catch {} };
const clampStep = (n: number): WelcomeStep => (Number.isInteger(n) && n >= 1 && n <= 5 ? (n as WelcomeStep) : 1);

/**
 * `POST /api/onboarding/event { key: 'welcome_step', value }` — remembers the furthest screen reached for this tenant,
 * so someone who starts on a phone and opens a laptop lands back on the screen they left. Best effort: a server that
 * predates the key answers 400 and the URL plus localStorage carry on alone.
 */
function reportStep(s: WelcomeStep): void {
  void api.post('/api/onboarding/event', { key: 'welcome_step', value: s }).catch(() => {});
}

export function useWizardStep(): { step: WelcomeStep; go: (s: WelcomeStep) => void } {
  const [sp, setSp] = useSearchParams();
  const raw = sp.get('step');
  const step = raw ? clampStep(Number(raw)) : clampStep(readStored() || 1);
  const go = useCallback((s: WelcomeStep) => {
    writeStored(s);
    reportStep(s);
    const next = new URLSearchParams(window.location.search);
    next.set('step', String(s));
    setSp(next, { replace: false });
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }, [setSp]);
  // Resumed from storage, or the param was junk: put the real step in the URL without adding a history entry.
  useEffect(() => {
    if (raw && Number(raw) === step) { writeStored(step); return; }
    const next = new URLSearchParams(window.location.search);
    next.set('step', String(step));
    setSp(next, { replace: true });
  }, [raw, step, setSp]);

  /* This browser has never been here (no ?step=, nothing stored) but the account has: resume on the far screen once,
     and only forwards — a Back that lands on screen 1 must not be yanked to 4 again. */
  const onb = useOnboarding();
  const server = clampStep(Number(onb.data?.welcomeStep ?? 0) || 1);
  const resumed = useRef(readStored() > 0 || !!raw);
  useEffect(() => {
    if (resumed.current) return;
    if (!onb.data) return;
    resumed.current = true;
    if (server > step) {
      writeStored(server);
      const next = new URLSearchParams(window.location.search);
      next.set('step', String(server));
      setSp(next, { replace: true });
    }
  }, [onb.data, server, step, setSp]);

  return { step, go };
}

/**
 * The `['jobs-status']` query (same cache as Shell's useWorkerStatus; declared here to keep the wizard free of a
 * circular import). `fast` polls every 3 s — screens 1 and 2 are waiting for saves to appear.
 */
export function useJobs(fast = false) {
  return useQuery({
    queryKey: ['jobs-status'],
    queryFn: () => api.get<WorkerStatusX>('/api/jobs/status'),
    refetchInterval: (q) => {
      if (fast) return 3000;
      const d = q.state.data;
      return d && (d.queued > 0 || d.running > 0) ? 2500 : 15000;
    },
  });
}

/* ------------------------------------------------- Instagram availability (ROUND7-SPEC §3) ------------------------------------------------- */

/* Deliberately not the ['ig-availability'] key components/instagram/useAutomations.ts uses: that fetcher returns a
   narrower shape and falls back to `canConnect: true` when the endpoint is missing, which is the one guess this
   screen must never make. Sharing the key would let whichever page loaded first decide what screen 4 believes. */
export const IG_AVAILABILITY_KEY = ['ig-availability', 'welcome'] as const;

const MODES: IgAvailabilityMode[] = ['live', 'development', 'unconfigured', 'unknown'];
function normMode(v: unknown): IgAvailabilityMode {
  const s = typeof v === 'string' ? v.toLowerCase().trim() : '';
  return (MODES as string[]).includes(s) ? (s as IgAvailabilityMode) : 'unknown';
}
const missing = (e: unknown): boolean => e instanceof ApiError && (e.status === 404 || e.status === 405 || e.status === 501);

/**
 * `GET /api/instagram/availability`. When the endpoint is not on this server yet we derive what we can from
 * `/api/instagram/account` and fall back to `unknown` — saying "we can't tell" is honest; offering a button that
 * fails is what lost the founder's father.
 */
export async function fetchIgAvailability(): Promise<IgAvailability> {
  try {
    const raw = await api.get<unknown>('/api/instagram/availability');
    const r = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : null;
    if (r && ('canConnect' in r || 'mode' in r)) {
      return {
        canConnect: !!r.canConnect,
        mode: normMode(r.mode),
        reason: typeof r.reason === 'string' ? r.reason : '',
        waitlist: !!r.waitlist,
        waitlistOffered: typeof r.waitlistOffered === 'boolean' ? r.waitlistOffered : undefined,
        waitlistEmail: typeof r.waitlistEmail === 'string' ? r.waitlistEmail : null,
        connected: !!r.connected,
        username: typeof r.username === 'string' ? r.username : null,
      };
    }
  } catch (e) {
    if (!missing(e)) throw e;
  }
  const acc = await fetchIgAccount().catch(() => null);
  if (acc?.connected) return { canConnect: true, mode: 'live', reason: '', waitlist: false, connected: true, username: acc.account?.username ?? null, derived: true };
  if (!acc || acc.unavailable || !acc.configured) return { canConnect: false, mode: 'unconfigured', reason: 'This server has no Instagram app set up, so there is nothing to connect to.', waitlist: false, connected: false, username: null, derived: true };
  return { canConnect: false, mode: 'unknown', reason: 'We can’t confirm that Instagram connections are open right now.', waitlist: false, connected: false, username: null, derived: true };
}

export function useIgAvailability(enabled = true) {
  return useQuery({ queryKey: IG_AVAILABILITY_KEY, queryFn: fetchIgAvailability, enabled, staleTime: 60_000, retry: 1 });
}

/** The reason the mutation rejected, carried on the Error so the screen can say the true thing. */
export class IgWaitlistError extends Error {
  constructor(public failure: IgWaitlistFailure) { super(failure.kind === 'missing' ? 'notFound' : failure.message); }
}

/**
 * `POST /api/instagram/waitlist` — records "tell me when it opens" for this tenant (idempotent server-side, one row).
 * The server picks the address when we send none and answers with the sentence it wants shown; both a missing endpoint
 * and a refusal ("we have no e-mail for this account") come back as an `IgWaitlistError` so screen 4 can offer the
 * mailto instead of claiming we wrote something down.
 */
export function useIgWaitlist() {
  const qc = useQueryClient();
  return useMutation<IgWaitlistResult, IgWaitlistError, string | null | undefined>({
    mutationFn: async (email) => {
      let raw: unknown;
      try {
        raw = await api.post<unknown>('/api/instagram/waitlist', email ? { email } : {});
      } catch (e) {
        if (missing(e)) throw new IgWaitlistError({ kind: 'missing' });
        if (e instanceof ApiError && e.status >= 400 && e.status < 500) throw new IgWaitlistError({ kind: 'rejected', message: e.message });
        throw e;
      }
      const r = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
      // `ok: false` with HTTP 200 is not a shape this server sends, but treating it as success would be a quiet lie.
      if (r.ok === false) throw new IgWaitlistError({ kind: 'rejected', message: typeof r.error === 'string' ? r.error : 'We could not store that request.' });
      return {
        waitlist: r.waitlist !== false,
        alreadyOn: !!r.alreadyOn,
        email: typeof r.email === 'string' ? r.email : null,
        message: typeof r.message === 'string' ? r.message : null,
      };
    },
    onSuccess: () => { void qc.invalidateQueries({ queryKey: IG_AVAILABILITY_KEY }); },
  });
}
