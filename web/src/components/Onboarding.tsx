/**
 * Onboarding (ROUND5-SPEC §7): the "Getting started" checklist card, its collapsed done state, the sidebar
 * progress pill, the shared `useOnboarding()` query, and the specific empty states used by Library / Resurface / Graph.
 *
 * Server contract: GET /api/onboarding → OnboardingState; POST /api/onboarding/event { key }.
 * When the endpoint is missing (older server) the state is derived from /api/jobs/status so nothing breaks.
 */
import { useEffect, useMemo, useRef, type ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useLocation, useNavigate } from 'react-router';
import { motion } from 'motion/react';
import { Check, ArrowRight, Upload, Sparkles, MessageSquareText, Waypoints, X, Library as LibraryIcon, Puzzle, Loader2, PauseCircle, KeyRound } from 'lucide-react';
import { InstagramGlyph } from './instagram/icons';
import { api, ApiError } from '../lib/api';
import { getSuggestions } from '../lib/ask';
import type { WorkerStatus } from '../lib/types';
import type { OnboardingEventKey, OnboardingState, Suggestion } from '../lib/types-onboarding';
import { useAuth } from '../lib/store';
import { cn, isMac } from '../lib/utils';

/* ------------------------------------------------------------------ data ------------------------------------------------------------------ */

export const ONBOARDING_KEY = ['onboarding'] as const;

/** Same query key as Shell's useWorkerStatus (shared cache); declared here to keep Shell ↔ Onboarding free of a circular import. */
function useWorkerStatus() {
  return useQuery({
    queryKey: ['jobs-status'],
    queryFn: () => api.get<WorkerStatus>('/api/jobs/status'),
    refetchInterval: (q) => { const d = q.state.data; return d && (d.queued > 0 || d.running > 0) ? 2500 : 15000; },
  });
}

/** Builds a best-effort OnboardingState from the worker status when GET /api/onboarding is not available. */
function deriveFromWorker(w: WorkerStatus | null): OnboardingState {
  const total = w?.total ?? 0;
  const analyzed = w?.analyzed ?? 0;
  const running = !!w && (w.queued > 0 || w.running > 0) && !w.paused;
  const dismissed = localFlag('rs-onboarding-dismissed');
  return {
    steps: {
      import: { done: total > 0, count: total },
      analyze: { done: analyzed > 0, analyzed, total, running },
      ask: { done: localFlag('rs-onboarding-asked') },
      explore: { done: localFlag('rs-onboarding-explored') },
      connectInstagram: { done: false, available: false },
      companion: { done: false },
    },
    dismissed,
    firstRun: total === 0 && !dismissed,
    suggestedNext: total === 0 ? 'import' : analyzed === 0 ? 'wait' : !localFlag('rs-onboarding-asked') ? 'ask' : !localFlag('rs-onboarding-explored') ? 'explore' : 'done',
    derived: true,
  };
}

async function fetchOnboarding(): Promise<OnboardingState> {
  try {
    const r = await api.get<OnboardingState>('/api/onboarding');
    if (r && r.steps) return r;
  } catch (e) {
    if (!(e instanceof ApiError && (e.status === 404 || e.status === 501 || e.status === 405))) throw e;
  }
  const w = await api.get<WorkerStatus>('/api/jobs/status').catch(() => null);
  return deriveFromWorker(w);
}

export function useOnboarding(enabled = true) {
  return useQuery({
    queryKey: ONBOARDING_KEY,
    queryFn: fetchOnboarding,
    enabled,
    staleTime: 5_000,
    retry: 1,
    refetchInterval: (q) => {
      const d = q.state.data;
      if (!d) return 15_000;
      if (d.dismissed) return false;
      if (d.steps.analyze.running || !d.steps.import.done) return 5_000;
      return coreDone(d) ? false : 20_000;
    },
  });
}

export function useOnboardingEvent() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (key: OnboardingEventKey) => {
      // Mirror locally so the derived fallback (no server endpoint) still remembers.
      if (key === 'dismissed') setLocalFlag('rs-onboarding-dismissed');
      if (key === 'explored') setLocalFlag('rs-onboarding-explored');
      if (key === 'asked') setLocalFlag('rs-onboarding-asked');
      try { await api.post('/api/onboarding/event', { key }); } catch (e) { if (!(e instanceof ApiError && (e.status === 404 || e.status === 501 || e.status === 405))) throw e; }
    },
    onSettled: () => { qc.invalidateQueries({ queryKey: ONBOARDING_KEY }); },
  });
}

/** Core steps that decide "you're set": bring saves, analyze, ask, explore. Instagram + Companion are optional extras. */
export function coreDone(s: OnboardingState | undefined | null): boolean {
  if (!s) return false;
  const { steps } = s;
  return steps.import.done && steps.analyze.done && steps.ask.done && steps.explore.done;
}
export function onboardingProgress(s: OnboardingState | undefined | null): { done: number; total: number } {
  if (!s) return { done: 0, total: 5 };
  const rows = checklistRows(s);
  return { done: rows.filter((r) => r.done).length, total: rows.length };
}

/* Local flags (sessionless, per browser) */
function localFlag(k: string): boolean { try { return localStorage.getItem(k) === '1'; } catch { return false; } }
function setLocalFlag(k: string, v = true) { try { if (v) localStorage.setItem(k, '1'); else localStorage.removeItem(k); } catch {} }
/** Set when the user leaves /welcome via "Skip" or the last step; the '/' → '/welcome' redirect stops after that. */
export const markWelcomeDone = () => setLocalFlag('rs-welcome-done');
export const welcomeDone = () => localFlag('rs-welcome-done');

/**
 * Hosted first-run redirect ('/' → '/welcome'): only when hosted, the tenant has no items, never dismissed the checklist,
 * and hasn't skipped/finished the welcome flow in this browser. Owner / OSS: never (they get the checklist card).
 * Returns `null` while undecided (query loading) so the caller can show a skeleton instead of flashing the dashboard.
 */
export function useFirstRunRedirect(): boolean | null {
  const auth = useAuth();
  const q = useOnboarding(auth.hosted);
  if (!auth.hosted) return false;
  if (q.isLoading && !q.data) return null;
  const d = q.data;
  if (!d) return false;
  return !!(d.firstRun && !d.dismissed && !d.welcomeSeen && !welcomeDone());
}

/* ------------------------------------------------------------ Ask suggestions ------------------------------------------------------------ */

export const FALLBACK_SUGGESTIONS: Suggestion[] = [
  'What did I save about growing on Instagram?',
  'Give me the best AI tools from my saves',
  'Summarize the recurring themes in my library',
  'What hooks do the reels I saved use?',
  'Which saved recipes can I cook tonight?',
  'Turn my three most useful saves into a content brief',
  'What do I keep saving but never act on?',
  'Which creators do I save the most, and why?',
];

/** GET /api/ask/suggestions via lib/ask.ts getSuggestions() (tolerant of every payload shape) → plain strings, with a static fallback. */
export function useAskSuggestions() {
  return useQuery({
    queryKey: ['ask-suggestions'],
    queryFn: async (): Promise<Suggestion[]> => {
      try { const s = (await getSuggestions()).map((x) => x.text).filter(Boolean); return s.length ? s : FALLBACK_SUGGESTIONS; } catch { return FALLBACK_SUGGESTIONS; }
    },
    staleTime: 5 * 60_000,
    retry: 0,
  });
}

/* --------------------------------------------------------------- checklist --------------------------------------------------------------- */

interface Row { key: string; title: string; detail: ReactNode; done: boolean; icon: ReactNode; cta: { label: string; to: string; onClick?: () => void } | null; optional?: boolean; live?: boolean; kind: 'import' | 'wait' | 'ask' | 'explore' | 'connect' | 'companion' }

function checklistRows(s: OnboardingState): Row[] {
  const { steps } = s;
  const a = steps.analyze;
  const pct = a.total ? Math.round((a.analyzed / a.total) * 100) : 0;
  const rows: Row[] = [
    {
      key: 'import', kind: 'import', icon: <Upload size={15} />, title: 'Bring your saves', done: steps.import.done,
      detail: steps.import.done ? `${steps.import.count.toLocaleString()} saves in the library` : 'Companion syncs them automatically; the one-time script works too. Takes a couple of minutes.',
      cta: steps.import.done ? { label: 'Add more', to: '/import' } : { label: 'Bring your saves', to: '/import' },
    },
    {
      key: 'analyze', kind: 'wait', icon: <Sparkles size={15} />, title: 'Let the analysis run', done: a.done, live: a.running,
      detail: !steps.import.done ? 'Each save gets transcribed, summarized and tagged in the background.' : a.total ? `${a.analyzed.toLocaleString()} of ${a.total.toLocaleString()} analyzed · ${pct}%${a.running ? ' · running' : a.done ? '' : ' · not started'}` : 'Waiting for saves.',
      cta: { label: a.running || a.done ? 'See progress' : 'Start analysis', to: '/import' },
    },
    {
      key: 'ask', kind: 'ask', icon: <MessageSquareText size={15} />, title: 'Ask something', done: steps.ask.done,
      detail: steps.ask.done ? 'You asked your first question.' : 'Ask in plain language, like you would a friend who watched all your reels. Answers cite the exact saves.',
      cta: { label: 'Ask', to: '/ask' },
    },
    {
      key: 'explore', kind: 'explore', icon: <Waypoints size={15} />, title: 'Look around', done: steps.explore.done,
      detail: steps.explore.done ? 'Library and graph opened.' : 'The Library filters by category, tag and creator; the Graph shows how your saves connect.',
      cta: { label: 'Open the library', to: '/library' },
    },
  ];
  if (steps.connectInstagram.available) {
    rows.push({ key: 'connect', kind: 'connect', icon: <InstagramGlyph size={15} />, title: 'Connect Instagram', done: steps.connectInstagram.done, optional: true,
      detail: steps.connectInstagram.done ? 'Connected. Automations and analytics are live.' : 'Optional: DM/comment automations and analytics for your own account.',
      cta: { label: steps.connectInstagram.done ? 'Automations' : 'Connect', to: '/automations' } });
  } else {
    rows.push({ key: 'companion', kind: 'companion', icon: <Puzzle size={15} />, title: 'Keep saves in sync', done: steps.companion.done, optional: true,
      detail: steps.companion.done ? 'Companion is paired — new saves arrive on their own.' : 'Optional: pair the Companion extension so new saves sync every few hours.',
      cta: { label: steps.companion.done ? 'Devices' : 'Set up Companion', to: '/import' } });
  }
  return rows;
}

/**
 * The "Getting started" card. Full checklist while steps remain; when the four core steps are done it collapses to
 * "You're set — ⌘K to jump anywhere" with a dismiss ×. Renders nothing once dismissed.
 * `welcomeLinks` (hosted first run) points the import/ask CTAs at /welcome steps instead of the full pages.
 */
export function OnboardingChecklist({ className, welcomeLinks = false }: { className?: string; welcomeLinks?: boolean }) {
  const q = useOnboarding();
  const ev = useOnboardingEvent();
  const s = q.data;
  const nav = useNavigate();
  if (q.isLoading && !s) return <div className={cn('card p-5', className)}><div className="skeleton h-5 w-40 rounded mb-4" /><div className="space-y-3">{[0, 1, 2, 3, 4].map((i) => <div key={i} className="skeleton h-9 rounded-lg" />)}</div></div>;
  if (!s || s.dismissed) return null;

  const rows = checklistRows(s);
  const done = rows.filter((r) => r.done).length;
  const allCore = coreDone(s);
  const go = (r: Row) => {
    if (r.kind === 'explore') ev.mutate('explored');
    if (welcomeLinks && (r.kind === 'import' || r.kind === 'companion')) return nav('/welcome?step=1');
    if (welcomeLinks && r.kind === 'wait') return nav('/welcome?step=2');
    if (welcomeLinks && r.kind === 'ask') return nav('/welcome?step=3');
    nav(r.cta!.to);
  };

  if (allCore) {
    return (
      <motion.div initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} className={cn('flex items-center gap-3 rounded-xl border border-line bg-surface px-3.5 py-2 text-[13px]', className)}>
        <span className="grid h-5 w-5 place-items-center rounded-full bg-accent text-accent-ink"><Check size={12} strokeWidth={3} /></span>
        <span className="text-ink-2">You’re set — <kbd className="kbd">{isMac() ? '⌘' : 'Ctrl'} K</kbd> to jump anywhere.</span>
        {done < rows.length && <span className="hidden sm:inline text-muted">· {rows.filter((r) => !r.done).map((r) => r.title).join(' and ')} still optional</span>}
        <button onClick={() => ev.mutate('dismissed')} className="ml-auto btn btn-ghost btn-sm !px-1.5 text-muted" title="Dismiss" aria-label="Dismiss"><X size={14} /></button>
      </motion.div>
    );
  }

  const nextKey = s.suggestedNext === 'done' ? null : s.suggestedNext;
  return (
    <section className={cn('card p-5 sm:p-6', className)}>
      <div className="flex items-start justify-between gap-4 mb-4">
        <div>
          <div className="eyebrow mb-1">Getting started</div>
          <h2 className="display text-[24px] leading-tight">{done === 0 ? 'Five short steps' : `${done} of ${rows.length} done`}</h2>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <div className="hidden sm:block h-1.5 w-28 rounded-full bg-line overflow-hidden"><motion.div className="h-full bg-accent" initial={false} animate={{ width: `${(done / rows.length) * 100}%` }} transition={{ type: 'spring', stiffness: 90, damping: 20 }} /></div>
          <span className="font-mono text-[11px] text-muted tabular">{done}/{rows.length}</span>
          <button onClick={() => ev.mutate('dismissed')} className="btn btn-ghost btn-sm !px-1.5 text-muted" title="Hide this card" aria-label="Hide"><X size={14} /></button>
        </div>
      </div>
      <ol className="divide-y divide-line">
        {rows.map((r, i) => {
          const isNext = nextKey === r.kind || (nextKey === 'wait' && r.kind === 'wait');
          return (
            <li key={r.key} className={cn('flex items-start gap-3 py-3 first:pt-0 last:pb-0', isNext && 'relative')}>
              <span className={cn('mt-0.5 grid h-6 w-6 shrink-0 place-items-center rounded-full border text-[11px]', r.done ? 'border-accent bg-accent text-accent-ink' : isNext ? 'border-accent text-accent' : 'border-line text-muted')}>
                {r.done ? <Check size={13} strokeWidth={3} /> : r.live ? <Loader2 size={13} className="animate-spin" /> : <span className="font-mono">{i + 1}</span>}
              </span>
              <div className="min-w-0 flex-1">
                <div className={cn('flex items-center gap-2 text-[14px]', r.done ? 'text-muted line-through decoration-line-2' : 'font-medium')}>
                  <span className={cn('text-muted', r.done && 'opacity-60')}>{r.icon}</span>{r.title}
                  {r.optional && !r.done && <span className="chip !py-0.5 !text-[10.5px] text-muted">optional</span>}
                  {isNext && !r.done && <span className="chip chip-active !py-0.5 !text-[10.5px]">next</span>}
                </div>
                <div className={cn('mt-0.5 text-[12.5px] leading-relaxed', r.done ? 'text-muted' : 'text-ink-2')}>{r.detail}</div>
                {r.kind === 'wait' && s.steps.analyze.total > 0 && !s.steps.analyze.done && (
                  <div className="mt-1.5 h-1 w-full max-w-xs rounded-full bg-line overflow-hidden"><motion.div className="h-full bg-accent" initial={false} animate={{ width: `${s.steps.analyze.total ? (s.steps.analyze.analyzed / s.steps.analyze.total) * 100 : 0}%` }} /></div>
                )}
              </div>
              {r.cta && (
                <button onClick={() => go(r)} className={cn('btn btn-sm shrink-0 self-center', isNext && !r.done && 'btn-primary')}>{r.cta.label} <ArrowRight size={12} /></button>
              )}
            </li>
          );
        })}
      </ol>
    </section>
  );
}

/* ----------------------------------------------------------- sidebar pill ----------------------------------------------------------- */

/**
 * Small "Getting started · 2/5" pill for the sidebar (Shell). Hidden once dismissed or when the core steps are done.
 * Also the one place that marks the `explore` step: it watches the route and posts `explored` the first time /library or /graph opens.
 */
export function OnboardingPill() {
  const auth = useAuth();
  const q = useOnboarding(auth.authenticated);
  const ev = useOnboardingEvent();
  const loc = useLocation();
  const s = q.data;
  const explored = s?.steps.explore.done;
  const asked = s?.steps.ask.done;
  const posted = useRef<{ explored: boolean; asked: boolean }>({ explored: false, asked: false });
  useEffect(() => {
    if (!s) return;
    if (!explored && !posted.current.explored && (loc.pathname === '/library' || loc.pathname === '/graph')) { posted.current.explored = true; ev.mutate('explored'); }
    // `/ask?q=…` auto-submits the question (AskHero / Welcome deep link) — a fair client-side signal for servers that don't mark `asked` themselves.
    if (!asked && !posted.current.asked && loc.pathname === '/ask' && new URLSearchParams(loc.search).get('q')) { posted.current.asked = true; ev.mutate('asked'); }
  }, [loc.pathname, loc.search, s, explored, asked, ev]);
  if (!s || s.dismissed || coreDone(s)) return null;
  const { done, total } = onboardingProgress(s);
  const to = auth.hosted && s.firstRun && !welcomeDone() ? '/welcome' : '/';
  return (
    <Link to={to} className="flex items-center gap-2 rounded-xl border border-line bg-surface px-3 py-2 text-[12px] text-ink-2 hover:border-line-2 hover:text-ink transition-colors">
      <span className="relative h-4 w-4 shrink-0">
        <svg viewBox="0 0 20 20" className="h-4 w-4 -rotate-90"><circle cx="10" cy="10" r="8" className="stroke-line" strokeWidth="3" fill="none" /><circle cx="10" cy="10" r="8" className="stroke-accent" strokeWidth="3" fill="none" strokeDasharray={`${(done / total) * 50.27} 50.27`} strokeLinecap="round" /></svg>
      </span>
      <span className="flex-1">Getting started</span>
      <span className="font-mono text-[11px] text-muted tabular">{done}/{total}</span>
    </Link>
  );
}

/* ------------------------------------------------------------ empty states ------------------------------------------------------------ */

/**
 * The specific empty state for Library / Resurface / Graph: says what is actually going on (no saves yet · analysis
 * running N/M · paused · no OpenAI key) and offers exactly one CTA. `filtered` = the page has data but the current filters hide it.
 */
export function AnalysisEmpty({ page, filtered, onClearFilters, className }: { page: 'library' | 'resurface' | 'graph'; filtered?: boolean; onClearFilters?: () => void; className?: string }) {
  const auth = useAuth();
  const worker = useWorkerStatus();
  const onb = useOnboarding();
  const w = worker.data;
  const total = w?.total ?? 0;
  const analyzed = w?.analyzed ?? 0;
  const inQueue = (w?.queued ?? 0) + (w?.running ?? 0);
  const firstRunWelcome = auth.hosted && !!onb.data?.firstRun && !welcomeDone();
  const importTo = firstRunWelcome ? '/welcome?step=1' : '/import';

  let icon: ReactNode = <Upload size={26} />; let title = ''; let body: ReactNode = null; let action: ReactNode = null;
  if (filtered) {
    icon = page === 'graph' ? <Waypoints size={26} /> : <LibraryIcon size={26} />;
    title = 'Nothing matches these filters';
    body = page === 'graph' ? 'Lower the minimum tag count, clear the category, or turn similarity links back on.' : 'Try a broader search, or turn on “meaning” search to find semantically similar saves.';
    action = onClearFilters ? <button onClick={onClearFilters} className="btn">Clear filters</button> : null;
  } else if (!w && worker.isLoading) {
    title = ' '; body = <span className="inline-flex items-center gap-2"><Loader2 size={13} className="animate-spin" /> Checking…</span>;
  } else if (total === 0) {
    title = 'No saves yet';
    body = page === 'library'
      ? 'This is where every save lands, with its transcript, summary and tags. Bring them in with Companion (automatic) or the one-time script.'
      : page === 'resurface'
        ? 'Resurface picks three analyzed saves a day, weighted toward useful, evergreen ones you haven’t looked at in a while. Bring your saves in first.'
        : 'The graph connects your saves through tags, categories, creators and similarity. Bring your saves in first.';
    action = <Link to={importTo} className="btn btn-primary">Bring your saves <ArrowRight size={14} /></Link>;
  } else if (analyzed === 0) {
    const paused = !!w?.paused;
    const noKey = w ? !w.openaiConfigured : false;
    icon = paused ? <PauseCircle size={26} /> : noKey ? <KeyRound size={26} /> : <Sparkles size={26} />;
    title = noKey ? 'Analysis needs an OpenAI key' : paused ? 'Analysis is paused' : inQueue ? 'Analysis is running' : 'Analysis hasn’t started';
    const what = page === 'library' ? 'Saves show up here as they are analyzed.' : page === 'resurface' ? 'Resurface starts once a handful of saves are analyzed.' : 'The graph appears once saves are analyzed.';
    body = noKey
      ? <>{total.toLocaleString()} saves are in, but nothing gets transcribed or tagged until a key is set. {what}</>
      : paused
        ? <>{analyzed} of {total.toLocaleString()} analyzed · paused{w?.pauseReason === 'quota' ? ' (no OpenAI credits)' : w?.pauseReason === 'budget' ? ' (budget cap)' : ''}. {what}</>
        : inQueue
          ? <>{analyzed} of {total.toLocaleString()} analyzed · {inQueue.toLocaleString()} in the queue. The first ones take a minute or two. {what}</>
          : <>{total.toLocaleString()} saves are in, none analyzed yet. {what}</>;
    action = noKey && auth.hosted === false
      ? <Link to="/settings" className="btn btn-primary">Add OpenAI key <ArrowRight size={14} /></Link>
      : <Link to={firstRunWelcome ? '/welcome?step=2' : '/import'} className="btn btn-primary">{inQueue && !paused ? 'Watch progress' : 'Start analysis'} <ArrowRight size={14} /></Link>;
  } else {
    // Some saves are analyzed but this page still has nothing (Resurface needs a handful; Graph needs tags/links).
    icon = page === 'resurface' ? <Sparkles size={26} /> : <Waypoints size={26} />;
    title = page === 'resurface' ? 'Not enough analyzed saves yet' : 'Nothing to draw yet';
    body = page === 'resurface'
      ? <>{analyzed.toLocaleString()} of {total.toLocaleString()} analyzed so far{inQueue ? ` · ${inQueue.toLocaleString()} in the queue` : ''}. Resurface starts picking once a handful are done — check back in a few minutes.</>
      : <>{analyzed.toLocaleString()} of {total.toLocaleString()} analyzed so far{inQueue ? ` · ${inQueue.toLocaleString()} in the queue` : ''}. Links appear once saves share tags, creators or similar meaning.</>;
    action = <Link to="/library" className="btn btn-primary">Browse the library <ArrowRight size={14} /></Link>;
  }
  return (
    <div className={cn('card-flat border-dashed p-10 text-center flex flex-col items-center gap-3 rise', className)}>
      <div className="text-muted">{icon}</div>
      {title.trim() && <div className="display text-[22px]">{title}</div>}
      {body && <div className="text-[13px] text-muted max-w-md leading-relaxed">{body}</div>}
      {action && <div className="mt-2">{action}</div>}
    </div>
  );
}

export default OnboardingChecklist;

/** Cheap memo helper for callers that want the derived progress without re-running rows twice. */
export function useOnboardingProgress() {
  const q = useOnboarding();
  return useMemo(() => onboardingProgress(q.data), [q.data]);
}
