import { useEffect, useState, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { AnimatePresence, motion } from 'motion/react';
import { CheckCircle2, AlertCircle, Terminal, FileArchive, ChevronDown, SlidersHorizontal } from 'lucide-react';
import { api } from '../lib/api';
import type { ScopeReport } from '../lib/types';
import { PageHeader, Toggle } from '../components/ui';
import { AnalysisPlan } from '../components/AnalysisPlan';
import { useWorkerStatus } from '../components/Shell';
import { ChromeGlyph } from '../components/instagram/icons';
import { CompanionCard, ScriptSteps, AdvancedImport } from '../components/import';
import { cn, fmtAgo } from '../lib/utils';

/** Numbered section with an optional disclosure (2 and 3 are collapsed by default). */
function Section({ n, title, blurb, icon, badge, open, onToggle, children }: { n: number; title: string; blurb: string; icon: ReactNode; badge?: ReactNode; open: boolean; onToggle?: () => void; children: ReactNode }) {
  const collapsible = !!onToggle;
  return (
    <section className="mb-5">
      <button type="button" onClick={onToggle} disabled={!collapsible} className={cn('w-full flex items-center gap-3 text-left rounded-xl px-1 py-2 group outline-none focus-visible:ring-2 focus-visible:ring-accent/30', collapsible && 'hover:bg-surface-2/60 transition-colors')} aria-expanded={open}>
        <span className={cn('h-7 w-7 shrink-0 grid place-items-center rounded-full border font-mono text-[11.5px]', n === 1 ? 'border-accent bg-accent text-accent-ink' : 'border-line-2 text-muted')}>{n}</span>
        <span className="text-muted hidden sm:inline">{icon}</span>
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-2 flex-wrap"><span className="text-[15px] font-semibold">{title}</span>{badge}</span>
          <span className="block text-[12.5px] text-muted">{blurb}</span>
        </span>
        {collapsible && <ChevronDown size={16} className={cn('text-muted transition-transform shrink-0', open && 'rotate-180')} />}
      </button>
      <AnimatePresence initial={false}>
        {open && (
          <motion.div key="body" initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }} exit={{ opacity: 0, height: 0 }} transition={{ duration: 0.22, ease: [0.2, 0.7, 0.2, 1] }} className="overflow-hidden">
            <div className="pt-2 pl-0 sm:pl-10">{children}</div>
          </motion.div>
        )}
      </AnimatePresence>
    </section>
  );
}

/**
 * One-line analysis status (dot · state · counts · progress) with the full AnalysisPlan behind "Fine-tune".
 * Opens itself when the worker paused for a reason the user has to act on (no OpenAI credits, budget cap).
 */
function AnalysisStrip() {
  const worker = useWorkerStatus();
  const scope = useQuery({ queryKey: ['scope'], queryFn: () => api.get<ScopeReport>('/api/scope'), refetchInterval: 15000 });
  const [open, setOpen] = useState(false);
  const w = worker.data; const r = scope.data;
  const needsAttention = !!w?.paused && !!w.pauseReason && w.pauseReason !== 'manual';
  useEffect(() => { if (needsAttention) setOpen(true); }, [needsAttention]);
  const active = w ? w.queued + w.running : 0;
  const total = w?.total || 0;
  const pct = total ? Math.round(((w?.analyzed ?? 0) / total) * 100) : 0;
  const state = !w ? 'Loading…' : w.paused ? (w.pauseReason === 'quota' ? 'Paused — no OpenAI credits' : w.pauseReason === 'budget' ? 'Paused — budget cap reached' : 'Paused') : active > 0 ? `Analyzing · ${w.running} running, ${w.queued} queued` : r && r.counts.eligiblePending > 0 ? `${r.counts.eligiblePending.toLocaleString()} saves waiting for analysis` : 'Analysis up to date';
  return (
    <div className="mb-6">
      <div className={cn('card-flat px-4 py-3', needsAttention && 'border-warn/50')}>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          <div className="flex items-center gap-2.5 min-w-0">
            <span className={cn('h-2 w-2 rounded-full shrink-0', active > 0 && !w?.paused ? 'bg-accent pulse-dot' : w?.paused ? 'bg-warn' : 'bg-line-2')} />
            <div className="min-w-0">
              <div className="text-[13.5px] font-medium truncate">{state}</div>
              <div className="text-[11.5px] text-muted truncate">
                {w ? <>{w.analyzed.toLocaleString()} of {total.toLocaleString()} analyzed{r ? ` · ${r.counts.eligiblePending.toLocaleString()} eligible · ${r.counts.outOfScope.toLocaleString()} outside plan` : ''}{w.failed ? ` · ${w.failed} failed` : ''}</> : ' '}
              </div>
            </div>
          </div>
          <div className="hidden sm:block flex-1 min-w-[120px] max-w-[260px]">
            <div className="h-1 rounded-full bg-line overflow-hidden"><motion.div className="h-full bg-accent" initial={false} animate={{ width: `${pct}%` }} transition={{ type: 'spring', stiffness: 80, damping: 20 }} /></div>
          </div>
          <button type="button" onClick={() => setOpen((o) => !o)} aria-expanded={open} className="btn btn-sm ml-auto"><SlidersHorizontal size={13} /> Fine-tune <ChevronDown size={12} className={cn('transition-transform', open && 'rotate-180')} /></button>
        </div>
        {w && !w.openaiConfigured && <div className="mt-2 text-[12.5px] text-warn flex items-center gap-1.5"><AlertCircle size={13} className="shrink-0" /> No OpenAI key yet — imports still work, but analysis waits until you add one in Settings.</div>}
      </div>
      <AnimatePresence initial={false}>
        {open && (
          <motion.div key="plan" initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }} exit={{ opacity: 0, height: 0 }} transition={{ duration: 0.22, ease: [0.2, 0.7, 0.2, 1] }} className="overflow-hidden">
            <div className="pt-3"><AnalysisPlan /></div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

export default function Import() {
  const [autoAnalyze, setAutoAnalyze] = useState(true);
  const [scriptOpen, setScriptOpen] = useState(false);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const history = useQuery({ queryKey: ['imports'], queryFn: () => api.get<{ imports: any[] }>('/api/import/history') });

  return (
    <div>
      <PageHeader eyebrow="Import" title={<>Bring your saves <em className="text-accent not-italic">home</em></>} subtitle="Pair the Companion once and new saves arrive on their own. Re-running any import is safe: existing saves are updated, never duplicated."
        actions={<Toggle checked={autoAnalyze} onChange={setAutoAnalyze} label="Analyze automatically after import" />} />

      {/* Analysis: one-line status, full plan under Fine-tune */}
      <AnalysisStrip />

      <Section n={1} title="Companion" blurb="Chrome extension. Pair once; new saves sync every 6 hours." icon={<ChromeGlyph size={16} />} badge={<span className="chip chip-active !text-[11px]">recommended</span>} open>
        <CompanionCard />
      </Section>

      <Section n={2} title="One-time script" blurb="Bookmarklet or console script on instagram.com. Brings the most detail per save." icon={<Terminal size={16} />} open={scriptOpen} onToggle={() => setScriptOpen((o) => !o)}>
        <ScriptSteps autoAnalyze={autoAnalyze} />
      </Section>

      <Section n={3} title="Advanced" blurb="Instagram data-export ZIP, or paste post and reel links." icon={<FileArchive size={16} />} open={advancedOpen} onToggle={() => setAdvancedOpen((o) => !o)}>
        <AdvancedImport autoAnalyze={autoAnalyze} />
      </Section>

      {/* History */}
      <div className="mt-8">
        <div className="eyebrow mb-2">Import history</div>
        {history.data?.imports.length ? (
          <div className="card-flat divide-y divide-line">
            {history.data.imports.map((h) => (
              <div key={h.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2.5 text-[13px]">
                <CheckCircle2 size={14} className="text-accent shrink-0" />
                <span className="font-medium capitalize">{h.source}</span>
                <span className="text-muted truncate max-w-[40vw]">{h.filename || ''}</span>
                <span className="ml-auto font-mono text-[11.5px] text-muted shrink-0 tabular">{h.total} total · {h.created} new · {h.updated} updated</span>
                <span className="text-[11.5px] text-muted shrink-0 sm:w-24 text-right">{fmtAgo(h.created_at)}</span>
              </div>
            ))}
          </div>
        ) : <div className="text-[13px] text-muted">No imports yet. Pair the Companion above, or open the one-time script and drop its JSON here.</div>}
      </div>
    </div>
  );
}
