/**
 * /welcome — the 3-screen guided first run (ROUND5-SPEC §7).
 *   1. Bring your saves     — Companion pairing (recommended) or the one-time script; live "N saves arrived" strip.
 *   2. While it analyzes    — live worker progress + a preview of the first analyzed note with what the fields mean.
 *   3. Ask something        — four suggested prompts from /api/ask/suggestions + the compact Ask composer.
 * The step lives in the URL (?step=1|2|3) so a reload keeps the place. "Skip, show me around" → Overview with the checklist.
 * Real components only: CompanionCard / ScriptSteps come from components/import, the composer is AskHero, the preview is ItemCard.
 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { AnimatePresence, motion } from 'motion/react';
import { toast } from 'sonner';
import { ArrowRight, ArrowLeft, Check, Loader2, Sparkles, KeyRound, PauseCircle, Play, Terminal, MessageSquareText, Leaf, Tag, FolderOpen, Gauge, ListChecks, Mic, Type, AlignLeft, ExternalLink, RefreshCw } from 'lucide-react';
import { api } from '../lib/api';
import type { ItemsResponse, ItemLight, WorkerStatus, QueueResponse } from '../lib/types';
import type { WelcomeStep } from '../lib/types-onboarding';
import { useAuth, useItemModal, useQuota } from '../lib/store';
import { cn, CONTENT_TYPE_LABEL } from '../lib/utils';
import { Tabs, Skeleton, CategoryDot } from '../components/ui';
import { ItemCard } from '../components/ItemCard';
import { AskHero } from '../components/AskHero';
import { CompanionCard, ScriptSteps } from '../components/import';
import { ChromeGlyph } from '../components/instagram/icons';
import { useWorkerStatus } from '../components/Shell';
import { markWelcomeDone, useAskSuggestions, useOnboarding, useOnboardingEvent } from '../components/Onboarding';

const STEPS: Array<{ n: WelcomeStep; label: string }> = [
  { n: 1, label: 'Bring your saves' },
  { n: 2, label: 'While it analyzes' },
  { n: 3, label: 'Ask something' },
];

function useStep(): [WelcomeStep, (s: WelcomeStep) => void] {
  const [sp, setSp] = useSearchParams();
  const raw = Number(sp.get('step') || 1);
  const step: WelcomeStep = raw === 2 ? 2 : raw === 3 ? 3 : 1;
  const set = (s: WelcomeStep) => { const n = new URLSearchParams(sp); n.set('step', String(s)); setSp(n, { replace: false }); window.scrollTo({ top: 0, behavior: 'smooth' }); };
  return [step, set];
}

/* ------------------------------------------------------------ Step 1 ------------------------------------------------------------ */

function StepBring({ onNext }: { onNext: () => void }) {
  const [how, setHow] = useState<'companion' | 'script'>('companion');
  const worker = useWorkerStatus();
  const qc = useQueryClient();
  const total = worker.data?.total ?? 0;
  const arrived = total > 0;
  const seenTotal = useRef<number | null>(null);
  useEffect(() => {
    if (worker.data === undefined) return;
    if (seenTotal.current === null) { seenTotal.current = total; return; }
    if (total > seenTotal.current) { toast.success(`${(total - seenTotal.current).toLocaleString()} new saves arrived`); seenTotal.current = total; }
  }, [total, worker.data]);
  const onImported = () => { qc.invalidateQueries({ queryKey: ['jobs-status'] }); qc.invalidateQueries({ queryKey: ['stats'] }); qc.invalidateQueries({ queryKey: ['onboarding'] }); };
  return (
    <div>
      <div className="mb-5">
        <h1 className="display text-[36px] sm:text-[44px] leading-[1.03] tracking-tight">Bring your saves</h1>
        <p className="mt-2 text-[14px] text-muted max-w-2xl leading-relaxed">Two ways in. Companion is a small Chrome extension that keeps syncing on its own; the one-time script is a single manual run on instagram.com. Both are safe to repeat — nothing gets duplicated.</p>
      </div>
      <div className="mb-4">
        <Tabs value={how} onChange={setHow} tabs={[
          { id: 'companion', label: <span className="inline-flex items-center gap-1.5"><ChromeGlyph size={13} /> Companion <span className="hidden sm:inline text-muted">· recommended</span></span> },
          { id: 'script', label: <span className="inline-flex items-center gap-1.5"><Terminal size={13} /> One-time script</span> },
        ]} />
      </div>
      <AnimatePresence mode="wait">
        {how === 'companion' ? (
          <motion.div key="c" initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }}>
            <CompanionCard compact />
            <p className="mt-2 text-[12px] text-muted">Install → get a pairing code → paste it in the extension popup. The first sync walks your whole saved list; it takes a few minutes for a big library.</p>
          </motion.div>
        ) : (
          <motion.div key="s" initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} className="card p-5 sm:p-6">
            <ScriptSteps compact onImported={onImported} />
          </motion.div>
        )}
      </AnimatePresence>
      <div className="mt-3 text-[12px] text-muted">Have an Instagram data-export ZIP or a list of links instead? <Link to="/import" className="underline hover:text-ink">Use the Import page</Link>.</div>

      {/* live arrival strip */}
      <div className={cn('mt-6 flex flex-wrap items-center gap-3 rounded-xl border px-4 py-3 text-[13px] transition-colors', arrived ? 'border-accent/40 bg-accent-soft/50' : 'border-line bg-surface')}>
        {arrived ? <Check size={16} className="text-accent" /> : <Loader2 size={16} className="text-muted animate-spin" />}
        <span className="text-ink-2">{arrived ? <><b>{total.toLocaleString()}</b> save{total === 1 ? '' : 's'} in your library{(worker.data?.queued ?? 0) + (worker.data?.running ?? 0) > 0 ? ' — analysis already running' : ''}.</> : 'Waiting for the first saves to arrive — this updates on its own.'}</span>
        <button onClick={onNext} className={cn('btn ml-auto', arrived ? 'btn-primary' : '')}>{arrived ? 'Continue' : 'Continue anyway'} <ArrowRight size={14} /></button>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------ Step 2 ------------------------------------------------------------ */

/** GET /api/jobs/status carries a few hosted extras (HOSTED-SPEC §7b) that lib/types.ts WorkerStatus doesn't declare. */
type WorkerStatusX = WorkerStatus & { planBlocked?: boolean; quota?: { used: number; limit: number | null; remaining: number | null; resetsAt?: number | null; ok?: boolean } | null };

const FIELDS: Array<{ key: string; label: string; icon: ReactNode; what: string; get: (a: NonNullable<ItemLight['analysis']>, it: ItemLight) => ReactNode }> = [
  { key: 'title', label: 'Title', icon: <Type size={13} />, what: 'A short, searchable name — the reel finally has one.', get: (a) => a.title },
  { key: 'one_liner', label: 'One-liner', icon: <AlignLeft size={13} />, what: 'What it is in one sentence, so you can scan a hundred fast.', get: (a) => a.one_liner },
  { key: 'category', label: 'Category', icon: <FolderOpen size={13} />, what: 'One of 19 fixed categories, plus a finer subcategory. Powers filters and the graph.', get: (a) => <span className="inline-flex items-center gap-1.5"><CategoryDot category={a.category} />{a.category}{a.subcategory ? ` · ${a.subcategory}` : ''}</span> },
  { key: 'tags', label: 'Tags', icon: <Tag size={13} />, what: 'Free-form topics. Same tag across saves = a thread through your library.', get: (a) => a.tags?.length ? <span className="flex flex-wrap gap-1">{a.tags.slice(0, 6).map((t) => <span key={t} className="chip !py-0.5 !text-[11px]">{t}</span>)}</span> : '—' },
  { key: 'type', label: 'Format', icon: <ListChecks size={13} />, what: 'Tutorial, tips list, recipe, meme… and the "action" it invites (try, buy, learn, watch again).', get: (a) => `${CONTENT_TYPE_LABEL[a.content_type] || a.content_type || '—'}${a.action_type ? ` · ${a.action_type.replace('_', ' ')}` : ''}` },
  { key: 'useful', label: 'Usefulness · evergreen', icon: <Gauge size={13} />, what: '1–10 how actionable it is, and whether it still matters in a year. Resurface leans on both.', get: (a) => <span className="inline-flex items-center gap-2 font-mono text-[12px]">{a.usefulness_score}/10 {a.is_evergreen ? <span className="inline-flex items-center gap-1 text-accent"><Leaf size={11} /> evergreen</span> : <span className="text-muted">timely</span>}</span> },
  { key: 'points', label: 'Key points · transcript', icon: <Mic size={13} />, what: 'Reels are transcribed; the note keeps the concrete points, takeaways, hook and a remix idea. Open the note to read them.', get: (a, it) => `${a.key_points_count || 0} key points${it.has_transcript ? ' · transcript' : ''}` },
];

function StepAnalyze({ onNext, onBack }: { onNext: () => void; onBack: () => void }) {
  const auth = useAuth();
  const { openUpgrade } = useQuota();
  const worker = useWorkerStatus();
  const modal = useItemModal();
  const qc = useQueryClient();
  const w = worker.data as WorkerStatusX | undefined;
  const total = w?.total ?? 0;
  const analyzed = w?.analyzed ?? 0;
  const inQueue = (w?.queued ?? 0) + (w?.running ?? 0);
  const pct = total ? Math.round((analyzed / total) * 100) : 0;
  const first = useQuery({
    queryKey: ['items', 'first-analyzed'],
    // Note: the items route filters on analysis_status, whose "analyzed" value is `done`.
    queryFn: () => api.get<ItemsResponse>('/api/items?status=done&limit=1&sort=saved'),
    refetchInterval: (q) => (q.state.data?.items.length ? false : 4000),
    enabled: total > 0,
  });
  const preview = first.data?.items[0] ?? null;
  const jobs = useMutation({
    mutationFn: (path: string) => api.post<Partial<QueueResponse>>(path),
    onSuccess: (r, path) => {
      if (path.includes('queue')) { const left = r.leftOut ?? 0; if (left > 0) toast(`Queued ${r.justQueued ?? 0} · ${left.toLocaleString()} left out of your allowance`, { action: { label: 'Upgrade', onClick: () => openUpgrade({ reason: `Analyze the ${left.toLocaleString()} saves that didn't fit your allowance` }) } }); else toast.success(`Queued ${r.justQueued ?? ''} saves`); }
      qc.invalidateQueries({ queryKey: ['jobs-status'] }); qc.invalidateQueries({ queryKey: ['stats'] }); qc.invalidateQueries({ queryKey: ['onboarding'] });
    },
    onError: (e: any) => toast.error(e.message),
  });
  // rough ETA from the recent per-item timings
  const eta = useMemo(() => {
    if (!w || !inQueue || !w.recent?.length) return null;
    const ok = w.recent.filter((r) => r.ok && r.ms > 0).slice(0, 12);
    if (ok.length < 3) return null;
    const avg = ok.reduce((s, r) => s + r.ms, 0) / ok.length;
    const secs = (avg * inQueue) / Math.max(1, w.concurrency || 1) / 1000;
    return secs < 90 ? 'about a minute' : secs < 3600 ? `about ${Math.round(secs / 60)} min` : `about ${(secs / 3600).toFixed(1)} h`;
  }, [w, inQueue]);

  const noKey = !!w && !w.openaiConfigured;
  const paused = !!w?.paused;
  const blocked = !!w?.planBlocked;
  const idle = !!w && total > 0 && analyzed === 0 && inQueue === 0 && !paused && !noKey && !blocked;

  return (
    <div>
      <div className="mb-5">
        <h1 className="display text-[36px] sm:text-[44px] leading-[1.03] tracking-tight">{analyzed > 0 ? 'Your first notes are ready' : 'While it analyzes'}</h1>
        <p className="mt-2 text-[14px] text-muted max-w-2xl leading-relaxed">Each save is fetched, reels are transcribed, then a model writes a structured note: title, one-liner, category, tags, key points, usefulness. It runs in the background — you can leave this page.</p>
      </div>

      {/* progress */}
      <div className="card p-5 mb-5">
        {!w ? <Skeleton className="h-16" /> : total === 0 ? (
          <div className="flex flex-wrap items-center gap-3 text-[13.5px]"><span className="text-ink-2">No saves yet — the analysis starts as soon as the first ones arrive.</span><button onClick={onBack} className="btn btn-sm ml-auto"><ArrowLeft size={13} /> Back to step 1</button></div>
        ) : (
          <>
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[13.5px]">
              <span className="inline-flex items-center gap-2 font-medium">
                <span className={cn('h-2 w-2 rounded-full', inQueue && !paused ? 'bg-accent pulse-dot' : paused ? 'bg-warn' : analyzed === total ? 'bg-accent' : 'bg-line-2')} />
                {noKey ? 'Waiting for an OpenAI key' : blocked ? 'Analysis paused on this plan' : paused ? (w.pauseReason === 'quota' ? 'Paused · no OpenAI credits' : w.pauseReason === 'budget' ? 'Paused · budget cap' : 'Paused') : inQueue ? 'Analyzing' : analyzed === total ? 'All done' : idle ? 'Ready to start' : 'Idle'}
              </span>
              <span className="font-mono text-[12px] text-muted tabular">{analyzed.toLocaleString()} / {total.toLocaleString()} · {pct}%</span>
              {inQueue > 0 && <span className="text-[12px] text-muted">{inQueue.toLocaleString()} in the queue{eta ? ` · ${eta} left` : ''}</span>}
              {w.failed > 0 && <span className="text-[12px] text-muted">{w.failed} failed</span>}
              <span className="ml-auto flex items-center gap-2">
                {noKey && !auth.hosted && <Link to="/settings" className="btn btn-primary btn-sm"><KeyRound size={13} /> Add OpenAI key</Link>}
                {blocked && <button onClick={() => openUpgrade({ reason: 'Analysis is paused on the Free plan' })} className="btn btn-primary btn-sm">Upgrade</button>}
                {paused && !blocked && <button onClick={() => jobs.mutate('/api/jobs/resume')} disabled={jobs.isPending} className="btn btn-primary btn-sm"><Play size={13} /> Resume</button>}
                {idle && <button onClick={() => jobs.mutate('/api/jobs/queue')} disabled={jobs.isPending} className="btn btn-primary btn-sm"><Sparkles size={13} /> Start analysis</button>}
                {inQueue > 0 && !paused && <button onClick={() => jobs.mutate('/api/jobs/pause')} disabled={jobs.isPending} className="btn btn-ghost btn-sm text-muted"><PauseCircle size={13} /> Pause</button>}
              </span>
            </div>
            <div className="mt-3 h-1.5 rounded-full bg-line overflow-hidden"><motion.div className="h-full bg-accent" initial={false} animate={{ width: `${pct}%` }} transition={{ type: 'spring', stiffness: 80, damping: 20 }} /></div>
            {w.quota && w.quota.limit !== null && <div className="mt-2 text-[11.5px] text-muted">Plan allowance: {w.quota.used.toLocaleString()} of {Number(w.quota.limit).toLocaleString()} saves analyzed{w.quota.remaining !== null ? ` · ${Number(w.quota.remaining).toLocaleString()} left` : ''}. The newest saves go first.</div>}
          </>
        )}
      </div>

      {/* first note preview + field legend */}
      <div className="grid md:grid-cols-[260px_1fr] gap-5 items-start">
        <div>
          <div className="eyebrow mb-2">First analyzed note</div>
          {preview ? (
            <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }}>
              <ItemCard item={preview} index={0} />
              <button onClick={() => modal.open(preview.id)} className="btn btn-sm mt-3 w-full">Open the full note <ExternalLink size={12} /></button>
            </motion.div>
          ) : (
            <div className="card-flat border-dashed aspect-[4/6] grid place-items-center p-6 text-center">
              <div className="text-[12.5px] text-muted leading-relaxed">
                {total === 0 ? 'Appears once the first save is in and analyzed.' : inQueue || paused ? <span className="inline-flex flex-col items-center gap-2"><Loader2 size={16} className={cn('text-accent', !paused && 'animate-spin')} /> The first note lands here in a minute or two.</span> : 'Start the analysis to see the first note here.'}
              </div>
            </div>
          )}
        </div>
        <div className="card p-5">
          <div className="eyebrow mb-3">What the fields mean</div>
          <ul className="divide-y divide-line">
            {FIELDS.map((f) => (
              <li key={f.key} className="py-2.5 first:pt-0 last:pb-0 grid sm:grid-cols-[170px_1fr] gap-x-4 gap-y-1">
                <div className="inline-flex items-center gap-1.5 text-[12.5px] font-medium text-ink"><span className="text-muted">{f.icon}</span>{f.label}</div>
                <div className="min-w-0">
                  {preview?.analysis ? <div className="text-[13px] text-ink break-words">{f.get(preview.analysis, preview)}</div> : null}
                  <div className={cn('text-[12px] text-muted leading-relaxed', preview?.analysis && 'mt-0.5')}>{f.what}</div>
                </div>
              </li>
            ))}
          </ul>
        </div>
      </div>

      <div className="mt-6 flex flex-wrap items-center gap-3">
        <button onClick={onBack} className="btn"><ArrowLeft size={14} /> Back</button>
        <button onClick={onNext} className="btn btn-primary ml-auto">{analyzed > 0 ? 'Ask something' : 'Continue anyway'} <ArrowRight size={14} /></button>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------ Step 3 ------------------------------------------------------------ */

function StepAsk({ onBack, onFinish }: { onBack: () => void; onFinish: () => void }) {
  const nav = useNavigate();
  const worker = useWorkerStatus();
  const sug = useAskSuggestions();
  const analyzed = worker.data?.analyzed ?? 0;
  const total = worker.data?.total ?? 0;
  const [offset, setOffset] = useState(0);
  const all = sug.data ?? [];
  const prompts = all.length ? Array.from({ length: Math.min(4, all.length) }, (_, i) => all[(offset + i) % all.length]) : [];
  const ask = (q: string) => { onFinish(); nav(`/ask?q=${encodeURIComponent(q)}`); };
  return (
    <div>
      <div className="mb-5">
        <h1 className="display text-[36px] sm:text-[44px] leading-[1.03] tracking-tight">Ask something you’d actually ask a friend who watched all your reels</h1>
        <p className="mt-2 text-[14px] text-muted max-w-2xl leading-relaxed">Plain language. The answer is built only from your saves and cites the exact ones, so you can open them. {analyzed > 0 ? <>{analyzed.toLocaleString()} of {total.toLocaleString()} saves are searchable right now — it gets better as more finish.</> : 'Answers get better as saves finish analyzing.'}</p>
      </div>
      <div className="grid sm:grid-cols-2 gap-3 mb-6">
        {(sug.isLoading ? Array.from({ length: 4 }).map(() => null) : prompts).map((p, i) => p === null ? <Skeleton key={i} className="h-20" /> : (
          <motion.button key={p} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: i * 0.05 }} onClick={() => ask(p)} className="card p-4 text-left hover:border-accent transition-colors group flex items-start gap-3">
            <span className="mt-0.5 h-7 w-7 shrink-0 grid place-items-center rounded-lg bg-accent-soft text-accent"><MessageSquareText size={14} /></span>
            <span className="text-[14px] leading-snug text-ink group-hover:text-accent">{p}</span>
            <ArrowRight size={14} className="ml-auto mt-1 shrink-0 text-muted group-hover:text-accent" />
          </motion.button>
        ))}
        {!sug.isLoading && all.length > 4 && <button onClick={() => setOffset((o) => (o + 4) % all.length)} className="sm:col-span-2 text-[12px] text-muted hover:text-ink inline-flex items-center gap-1 justify-center"><RefreshCw size={11} /> Other ideas</button>}
      </div>
      <div className="mb-6" onSubmitCapture={onFinish}>
        <div className="eyebrow mb-2">Or type your own</div>
        <AskHero compact />
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <button onClick={onBack} className="btn"><ArrowLeft size={14} /> Back</button>
        <button onClick={() => { onFinish(); nav('/'); }} className="btn ml-auto">Done — go to Overview <ArrowRight size={14} /></button>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------ page ------------------------------------------------------------ */

export default function Welcome() {
  const [step, setStep] = useStep();
  const nav = useNavigate();
  const ev = useOnboardingEvent();
  const onb = useOnboarding();
  const seen = useRef(false);
  useEffect(() => { if (!seen.current) { seen.current = true; ev.mutate('welcome_seen'); } /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, []);
  const finish = () => { markWelcomeDone(); };
  const skip = () => { finish(); nav('/'); };
  const count = onb.data?.steps.import.count ?? 0;

  return (
    <div className="mx-auto max-w-4xl">
      <div className="flex flex-wrap items-center gap-3 mb-6 rise">
        <div className="eyebrow">Welcome · step {step} of 3</div>
        <ol className="flex items-center gap-1.5 ml-1">
          {STEPS.map((s) => (
            <li key={s.n}>
              <button onClick={() => setStep(s.n)} className={cn('h-1.5 rounded-full transition-all', s.n === step ? 'w-8 bg-accent' : s.n < step ? 'w-4 bg-accent/50' : 'w-4 bg-line-2')} aria-label={`Step ${s.n}: ${s.label}`} title={s.label} />
            </li>
          ))}
        </ol>
        <span className="hidden sm:inline text-[12px] text-muted">{STEPS[step - 1].label}</span>
        <button onClick={skip} className="ml-auto text-[12.5px] text-muted hover:text-ink inline-flex items-center gap-1">Skip, show me around <ArrowRight size={12} /></button>
      </div>
      <AnimatePresence mode="wait">
        <motion.div key={step} initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -6 }} transition={{ duration: 0.22, ease: [0.2, 0.7, 0.2, 1] }}>
          {step === 1 && <StepBring onNext={() => setStep(2)} />}
          {step === 2 && <StepAnalyze onNext={() => setStep(3)} onBack={() => setStep(1)} />}
          {step === 3 && <StepAsk onBack={() => setStep(2)} onFinish={finish} />}
        </motion.div>
      </AnimatePresence>
      {step !== 1 && count === 0 && (
        <div className="mt-8 text-[12px] text-muted">No saves yet — <button onClick={() => setStep(1)} className="underline hover:text-ink">back to step 1</button> to bring them in.</div>
      )}
    </div>
  );
}
