import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { motion, AnimatePresence } from 'motion/react';
import { toast } from 'sonner';
import { Play, Pause, RotateCcw, Sparkles, Wallet, AlertTriangle, Coins, Info, Check } from 'lucide-react';
import { api } from '../lib/api';
import type { QueueResponse, Scope, ScopeReport, WorkerStatus } from '../lib/types';
import { cn } from '../lib/utils';
import { useQuota } from '../lib/store';
import { fmtLimit, isUnlimited, meterRemaining, planName } from '../lib/plans';
import { creditBalance } from '../lib/types-credits';
import { CreditsLeft } from './Pricing';
import { Field, Toggle } from './ui';

const usd = (n: number, d = 2) => `$${n.toFixed(d)}`;

/**
 * "What gets analyzed, how deep, and what it costs" — the money panel.
 * Everything here maps 1:1 to server-side scope settings; the worker only ever touches eligible saves.
 * Hosted tenants additionally see their plan allowance (HOSTED-SPEC §6): the newest N eligible saves get queued, the rest wait for an upgrade.
 */
export function AnalysisPlan({ compact = false }: { compact?: boolean }) {
  const qc = useQueryClient();
  const { plan, openUpgrade, refreshPlan } = useQuota();
  const scopeQ = useQuery({ queryKey: ['scope'], queryFn: () => api.get<ScopeReport>('/api/scope'), refetchInterval: 15000 });
  const worker = useQuery({ queryKey: ['jobs-status'], queryFn: () => api.get<WorkerStatus>('/api/jobs/status'), refetchInterval: (q) => { const d = q.state.data; return d && (d.queued > 0 || d.running > 0) ? 2500 : 15000; } });
  const [draft, setDraft] = useState<Scope | null>(null);
  useEffect(() => { if (scopeQ.data && !draft) setDraft(scopeQ.data.scope); }, [scopeQ.data]);
  const invalidate = () => { qc.invalidateQueries({ queryKey: ['scope'] }); qc.invalidateQueries({ queryKey: ['jobs-status'] }); qc.invalidateQueries({ queryKey: ['items'] }); qc.invalidateQueries({ queryKey: ['stats'] }); void refreshPlan(); };
  const save = useMutation({ mutationFn: (s: Partial<Scope> & { resetBudget?: boolean }) => api.put<ScopeReport>('/api/scope', s), onSuccess: (r) => { setDraft(r.scope); toast.success('Analysis plan saved'); invalidate(); } });
  const jobs = useMutation({
    mutationFn: (p: { path: string; body?: any }) => api.post<any>(p.path, p.body),
    onSuccess: (r: Partial<QueueResponse> & { reset?: number }, v) => {
      if (v.path.includes('queue')) {
        const left = r.leftOut ?? 0;
        if (left > 0) toast(`Queued ${r.justQueued ?? 0} saves · ${left.toLocaleString()} left out of your ${planName(r.quota?.plan ?? plan?.plan)} allowance`, { action: { label: 'Upgrade', onClick: () => openUpgrade({ reason: `Analyze the ${left.toLocaleString()} saves that didn't fit your allowance` }) }, duration: 8000 });
        else toast.success(`Queued ${r.justQueued ?? ''} saves`);
      }
      if (v.path.includes('reset-quota')) toast.success(`${r.reset} saves moved back to pending`);
      invalidate();
    },
    onError: (e: any) => toast.error(e.message),
  });
  const r = scopeQ.data;
  const w = worker.data;
  if (!r || !draft) return <div className="card p-5 h-40 skeleton" />;
  const dirty = JSON.stringify(draft) !== JSON.stringify(r.scope);
  const est = draft.tier === 'economy' ? r.estimate.economy : r.estimate.standard;
  const perItem = draft.tier === 'economy' ? r.estimate.perItemEconomy : r.estimate.perItemStandard;
  const active = w ? w.queued + w.running : 0;
  const reasonText = w?.pauseReason === 'quota' ? 'Paused automatically: your OpenAI account has no credits. Add credits at platform.openai.com → Billing, then press Resume — nothing was lost, the queue is intact.' : w?.pauseReason === 'budget' ? `Paused: budget cap of ${usd(r.budget.cap)} reached. Raise the cap (or reset the counter) to continue.` : w?.paused ? 'Paused manually.' : null;

  // Hosted allowance (owner tenant behaves like the single-tenant app)
  const metered = !!plan && plan.plan !== 'owner';
  const allowanceLeft = !metered ? Number.POSITIVE_INFINITY : plan!.effectivePlan === 'free' ? 0 : Math.min(meterRemaining(plan!.usage?.analyze), meterRemaining(plan!.usage?.analyzeMonth));
  // The server queues up to allowance + credits (1 credit = 1 save), so the button must count credits too.
  const remaining = !metered ? Number.POSITIVE_INFINITY : allowanceLeft + creditBalance(plan);
  const willQueue = Math.min(r.counts.eligiblePending, Number.isFinite(remaining) ? remaining : r.counts.eligiblePending);
  const leftOut = Math.max(0, r.counts.eligiblePending - willQueue);
  const allowanceText = (() => {
    if (!metered) return null;
    const p = plan!;
    const total = p.usage?.analyze; const month = p.usage?.analyzeMonth;
    if (p.effectivePlan === 'free') return `${p.plan === 'trial' ? 'Trial ended' : 'Free plan'}: analysis is paused. Your ${total?.used?.toLocaleString() ?? 0} analyzed saves stay searchable; upgrade to analyze the rest.`;
    const cap = isUnlimited(total?.limit) ? 'unlimited saves' : `${fmtLimit(total?.limit)} saves`;
    const monthTxt = month && !isUnlimited(month.limit) ? ` · ${month.used.toLocaleString()}/${fmtLimit(month.limit)} this month` : '';
    return `${planName(p.plan)}: ${cap} — the newest ${willQueue.toLocaleString()} eligible saves get analyzed · ${(total?.used ?? 0).toLocaleString()}/${fmtLimit(total?.limit)} used${monthTxt}`;
  })();

  return (
    <div className="space-y-4">
      {/* Status / controls */}
      <div className={cn('card p-4', w?.paused && w.pauseReason && w.pauseReason !== 'manual' && 'border-warn/50')}>
        <div className="flex flex-wrap items-center gap-3">
          <div className="flex items-center gap-2 min-w-[220px]">
            <span className={cn('h-2 w-2 rounded-full', active > 0 && !w?.paused ? 'bg-accent pulse-dot' : w?.paused ? 'bg-warn' : 'bg-line-2')} />
            <div>
              <div className="text-[13.5px] font-medium">{w ? (w.paused ? `Paused${w.pauseReason && w.pauseReason !== 'manual' ? ` (${w.pauseReason})` : ''}` : active > 0 ? `Analyzing · ${w.running} running, ${w.queued} queued` : 'Idle') : 'Loading…'}</div>
              <div className="text-[11.5px] text-muted">{r.counts.analyzed.toLocaleString()} analyzed · {r.counts.eligiblePending.toLocaleString()} eligible & waiting · {r.counts.outOfScope.toLocaleString()} outside scope · {r.counts.excluded.toLocaleString()} excluded{r.counts.failed ? ` · ${r.counts.failed} failed` : ''}</div>
            </div>
          </div>
          <div className="ml-auto flex flex-wrap items-center gap-2">
            {w?.paused ? <button onClick={() => jobs.mutate({ path: '/api/jobs/resume' })} className="btn btn-sm btn-primary"><Play size={13} /> Resume</button> : <button onClick={() => jobs.mutate({ path: '/api/jobs/pause' })} className="btn btn-sm"><Pause size={13} /> Pause</button>}
            {metered && remaining <= 0 && r.counts.eligiblePending > 0 ? (
              <button onClick={() => openUpgrade({ reason: `Upgrade to analyze ${r.counts.eligiblePending.toLocaleString()} waiting saves` })} className="btn btn-sm btn-primary" title="Your plan's analysis allowance is used up"><Sparkles size={13} /> Upgrade to analyze {r.counts.eligiblePending.toLocaleString()} saves</button>
            ) : (
              <button onClick={() => jobs.mutate({ path: '/api/jobs/queue', body: { what: 'eligible' } })} disabled={!r.counts.eligiblePending} className="btn btn-sm btn-primary" title={metered ? 'Queue the newest eligible saves that fit your plan allowance' : 'Queue every eligible save (inside the date window & media types, not excluded)'}><Sparkles size={13} /> Analyze eligible ({willQueue.toLocaleString()}){!metered && <> ≈ {usd(est)}</>}</button>
            )}
            {r.counts.failed > 0 && <button onClick={() => jobs.mutate({ path: '/api/jobs/reset-quota-failures' })} className="btn btn-sm" title="Saves that 'failed' only because OpenAI credits ran out are put back to pending (free)"><RotateCcw size={13} /> Un-fail credit errors ({r.counts.failed})</button>}
            {!!w?.queued && <button onClick={() => jobs.mutate({ path: '/api/jobs/clear' })} className="btn btn-ghost btn-sm text-muted">Clear queue</button>}
          </div>
        </div>
        {allowanceText && (
          <div className={cn('mt-3 flex flex-wrap items-center gap-2 rounded-xl border px-3 py-2 text-[12.5px]', remaining <= 0 || leftOut > 0 ? 'border-warn/30 bg-warn-soft' : 'border-line bg-surface-2/60')}>
            <Info size={14} className={cn('shrink-0', remaining <= 0 || leftOut > 0 ? 'text-warn' : 'text-accent')} />
            <span className="text-ink-2">{allowanceText}{leftOut > 0 && remaining > 0 ? ` · ${leftOut.toLocaleString()} left out` : ''}</span>
            {metered && allowanceLeft <= 0 && <CreditsLeft metric="analyze" className="text-ink-2" />}
            {(leftOut > 0 || remaining <= 0) && <button onClick={() => openUpgrade({ reason: leftOut > 0 ? `Analyze the ${leftOut.toLocaleString()} saves that don't fit your allowance` : undefined })} className="ml-auto btn btn-sm btn-primary">Upgrade</button>}
          </div>
        )}
        <AnimatePresence>{reasonText && <motion.div initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }} exit={{ opacity: 0, height: 0 }} className="mt-3 flex items-start gap-2 rounded-xl bg-warn-soft border border-warn/30 px-3 py-2 text-[12.5px]"><AlertTriangle size={14} className="text-warn shrink-0 mt-0.5" />{reasonText}</motion.div>}</AnimatePresence>
        {w?.lastError && !w.paused && <div className="mt-2 text-[11.5px] text-muted font-mono truncate">last error: {w.lastError}</div>}
      </div>

      {/* Money — the OpenAI bill is ours on hosted plans, so only the owner / self-hosters see it */}
      {!metered && (
        <div className="grid md:grid-cols-3 gap-3">
          <div className="card p-4"><div className="eyebrow mb-1 inline-flex items-center gap-1.5"><Coins size={11} /> Spent so far (est.)</div><div className="display text-[26px] tabular">{usd(r.spent.total)}</div><div className="text-[12px] text-muted mt-1">{r.spent.items.toLocaleString()} analyzed · avg {usd(r.spent.avgPerItem, 4)}/save{Object.keys(r.spent.byType).length ? ` · ${Object.entries(r.spent.byType).map(([k, v]) => `${k} ${usd(v.usd / v.n, 4)}`).join(' · ')}` : ''}</div></div>
          <div className="card p-4"><div className="eyebrow mb-1 inline-flex items-center gap-1.5"><Wallet size={11} /> To finish current scope</div><div className="display text-[26px] tabular">{usd(est)}</div><div className="text-[12px] text-muted mt-1">{r.counts.eligiblePending.toLocaleString()} saves · ≈ {usd(perItem, 4)}/save · {r.estimate.transcribeMinutes} min of speech to transcribe</div></div>
          <div className="card p-4"><div className="eyebrow mb-1">Standard vs Economy</div><div className="text-[13px] mt-1"><span className="font-medium">Standard</span> gpt-5.4-mini ≈ {usd(r.estimate.standard)}<br /><span className="font-medium">Economy</span> gpt-5.4-nano ≈ {usd(r.estimate.economy)}</div><div className="text-[11.5px] text-muted mt-1">List prices, Aug 2026. Actuals are tracked per save from real token counts.</div></div>
        </div>
      )}

      {/* Scope controls */}
      <div className="card p-5">
        <div className="flex items-center justify-between mb-4"><div><div className="eyebrow mb-0.5">Analysis plan</div><h3 className="text-[15px] font-semibold">What gets analyzed, and how deep</h3></div>{dirty && <button onClick={() => save.mutate(draft)} disabled={save.isPending} className="btn btn-primary btn-sm"><Check size={13} /> Save plan</button>}</div>
        <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-4">
          <Field label="Only saves from the last…" hint="Estimated save date (Instagram doesn't expose it; we derive it from the saved order + post dates). 0 = everything.">
            <select value={draft.years} onChange={(e) => setDraft({ ...draft, years: Number(e.target.value) })} className="input">
              {[0.5, 1, 2, 3, 5, 0].map((y) => <option key={y} value={y}>{y === 0 ? 'Everything' : y === 0.5 ? '6 months' : `${y} year${y > 1 ? 's' : ''}`}</option>)}
            </select>
          </Field>
          <Field label="Media types">
            <div className="flex flex-col gap-1.5 pt-1">
              {(['video', 'image', 'carousel'] as const).map((t) => <Toggle key={t} checked={draft.types.includes(t)} onChange={(v) => setDraft({ ...draft, types: v ? Array.from(new Set([...draft.types, t])) : draft.types.filter((x) => x !== t) })} label={t === 'video' ? 'Reels & videos' : t === 'image' ? 'Images' : 'Carousels'} />)}
            </div>
          </Field>
          <Field label="Transcribe speech" hint={metered ? 'Speech in reels becomes searchable text. Short reels carry the most value.' : '~30% of the per-reel cost. Short reels carry the most value per cent.'}>
            <select value={draft.transcribe} onChange={(e) => setDraft({ ...draft, transcribe: e.target.value as Scope['transcribe'] })} className="input">
              <option value="all">All reels</option>
              <option value="short">Only reels up to…</option>
              <option value="none">Never (caption + frames only)</option>
            </select>
            {draft.transcribe === 'short' && <input type="number" min={15} max={1800} value={draft.transcribeMaxSeconds} onChange={(e) => setDraft({ ...draft, transcribeMaxSeconds: Number(e.target.value) })} className="input mt-2" placeholder="seconds" />}
          </Field>
          <Field label="Vision frames per reel" hint={metered ? 'Frames the model looks at (on-screen text, visuals).' : 'Frames the model looks at (on-screen text, visuals). Fewer = cheaper.'}>
            <select value={draft.frames} onChange={(e) => setDraft({ ...draft, frames: Number(e.target.value) })} className="input">
              <option value={4}>4 frames (best)</option><option value={2}>2 frames</option><option value={0}>0 — text only</option>
            </select>
          </Field>
          <Field label="Quality tier" hint={metered ? 'Standard = gpt-5.4-mini (recommended). Economy = gpt-5.4-nano, faster, slightly blunter summaries.' : 'Standard = gpt-5.4-mini (recommended). Economy = gpt-5.4-nano, ~4× cheaper, slightly blunter summaries.'}>
            <select value={draft.tier} onChange={(e) => setDraft({ ...draft, tier: e.target.value as Scope['tier'] })} className="input"><option value="standard">Standard</option><option value="economy">Economy</option></select>
          </Field>
          {!metered && (
            <Field label="Budget cap (USD)" hint="Worker pauses itself when estimated spend since the last reset reaches this. 0 = no cap.">
              <div className="flex gap-2"><input type="number" min={0} step={1} value={draft.budgetUsd} onChange={(e) => setDraft({ ...draft, budgetUsd: Number(e.target.value) })} className="input" /><button onClick={() => save.mutate({ ...draft, resetBudget: true })} className="btn btn-sm shrink-0" title="Start counting from zero again">Reset</button></div>
              {r.budget.cap > 0 && <div className="text-[11.5px] text-muted mt-1">Spent since reset {usd(r.spent.sinceReset)} · remaining {usd(r.budget.remaining || 0)}</div>}
            </Field>
          )}
        </div>
        {!compact && (
          <div className="mt-4 flex items-start gap-2 text-[12px] text-muted leading-relaxed"><Info size={13} className="shrink-0 mt-0.5" /><span>Saves outside the plan stay in the library as "not analyzed" (searchable by caption, but no summary/tags). Change the plan any time and press <b>Analyze eligible</b> — already-analyzed saves are never {metered ? 'counted twice' : 're-billed'}. Use <b>Exclude</b> (item modal, bulk bar, or "exclude everything by @creator") for saves you don't want in the system at all.{metered ? ' On a metered plan the newest eligible saves are queued first.' : ''}</span></div>
        )}
      </div>
    </div>
  );
}
