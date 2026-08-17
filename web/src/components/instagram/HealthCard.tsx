/* Round 6 §2 — "why can't my automation fire?" as a checklist.
   GET /api/automations/diagnostics; a server that does not have it yet answers 404 and this card renders nothing. */
import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { AnimatePresence, motion } from 'motion/react';
import { toast } from 'sonner';
import { ArrowRight, CheckCircle2, ChevronDown, CircleAlert, ExternalLink, RefreshCw, TriangleAlert } from 'lucide-react';
import { api } from '../../lib/api';
import type { CheckStatus, DiagnosticCheck } from '../../lib/types-automations';
import { Skeleton } from '../ui';
import { cn, fmtAgo } from '../../lib/utils';
import { DIAGNOSTICS_KEY, useDiagnostics } from './useAutomations';

const DOCS = 'https://github.com/tairqaldy/resurfly/blob/main/docs/AUTOMATIONS.md';

const TONE: Record<CheckStatus, { dot: string; text: string; ring: string }> = {
  ok: { dot: 'bg-accent', text: 'text-accent', ring: 'border-accent/40' },
  warn: { dot: 'bg-warn', text: 'text-warn', ring: 'border-warn/40' },
  fail: { dot: 'bg-danger', text: 'text-danger', ring: 'border-danger/40' },
};

/** `docs/AUTOMATIONS.md#live-mode` and friends come back as repo-relative paths — send them to GitHub. */
function fixHref(href: string): string {
  if (/^https?:\/\//i.test(href) || href.startsWith('/')) return href;
  if (href.startsWith('docs/AUTOMATIONS.md')) return DOCS + href.slice('docs/AUTOMATIONS.md'.length);
  return `https://github.com/tairqaldy/resurfly/blob/main/${href}`;
}

function FixButton({ check, onAction, busy }: { check: DiagnosticCheck; onAction: (action: string) => void; busy: boolean }) {
  const fix = check.fix;
  if (!fix?.label) return null;
  if (fix.action) return <button onClick={() => onAction(fix.action!)} disabled={busy} className="btn btn-sm shrink-0"><RefreshCw size={12} className={cn(busy && 'animate-spin')} /> {fix.label}</button>;
  if (!fix.href) return null;
  const href = fixHref(fix.href);
  const external = /^https?:\/\//i.test(href);
  return (
    <a href={href} {...(external ? { target: '_blank', rel: 'noreferrer' } : {})} className="btn btn-sm shrink-0">
      {fix.label} {external ? <ExternalLink size={12} /> : <ArrowRight size={12} />}
    </a>
  );
}

function Row({ check, onAction, busyAction }: { check: DiagnosticCheck; onAction: (a: string) => void; busyAction: string | null }) {
  const tone = TONE[check.status] || TONE.ok;
  return (
    <li className="flex flex-wrap items-start gap-x-3 gap-y-2 px-4 py-3">
      <span className={cn('mt-[7px] h-2 w-2 shrink-0 rounded-full', tone.dot)} aria-hidden />
      <div className="min-w-[200px] flex-1">
        <div className="flex items-center gap-2">
          <span className="text-[13.5px] font-medium">{check.label}</span>
          <span className={cn('font-mono text-[10px] uppercase tracking-wider', tone.text)}>{check.status === 'ok' ? 'ok' : check.status === 'warn' ? 'check this' : 'blocked'}</span>
        </div>
        <p className="mt-0.5 text-[12.5px] text-muted leading-relaxed">{check.detail}</p>
        {check.notes?.length ? (
          <ul className="mt-1.5 space-y-0.5">
            {check.notes.map((n, i) => <li key={i} className="text-[12px] text-ink-2 before:content-['—'] before:mr-1.5 before:text-muted-2">{n}</li>)}
          </ul>
        ) : null}
      </div>
      <FixButton check={check} onAction={onAction} busy={busyAction === check.fix?.action} />
    </li>
  );
}

/**
 * The diagnostics checklist. Green / amber / red rows with one sentence each and a fix where there is one.
 * Collapsed to the problem rows when everything else is fine, so a healthy account stays quiet.
 */
export function HealthCard({ className }: { className?: string }) {
  const qc = useQueryClient();
  const q = useDiagnostics();
  const [open, setOpen] = useState(false);
  const [busyAction, setBusyAction] = useState<string | null>(null);

  const run = useMutation({
    mutationFn: async (action: string) => {
      setBusyAction(action);
      if (action === 'resubscribe') return api.post<any>('/api/automations/resubscribe');
      return api.post<any>(`/api/automations/${action}`);
    },
    onSuccess: (r: any) => {
      const meta = r?.response ?? r?.result ?? r;
      const ok = r?.ok !== false && meta?.success !== false;
      toast[ok ? 'success' : 'error'](ok ? 'Instagram accepted the subscription — rechecking.' : String(r?.error || meta?.error?.message || 'Instagram refused the request'));
      void qc.invalidateQueries({ queryKey: DIAGNOSTICS_KEY });
      void qc.invalidateQueries({ queryKey: ['ig-account'] });
    },
    onError: (e: any) => toast.error(String(e?.message || 'Could not run that fix')),
    onSettled: () => setBusyAction(null),
  });

  if (q.isLoading && !q.data) return <Skeleton className={cn('h-24', className)} />;
  const d = q.data;
  if (!d || d.unavailable || !d.checks.length) return null;

  const problems = d.checks.filter((c) => c.status !== 'ok');
  // Before an account is connected, three checks fail and all three say "Connect Instagram" — that is one thing to do,
  // not three. Collapse rows that share a fix so the count matches the number of actions; "All N checks" still shows
  // every row for anyone who wants the detail.
  const fixKey = (c: DiagnosticCheck) => (c.fix?.action || c.fix?.href ? `${c.fix.action || ''}|${c.fix.href || ''}` : `#${c.id}`);
  const distinct: DiagnosticCheck[] = [];
  const seenFix = new Set<string>();
  for (const c of problems) {
    const k = fixKey(c);
    if (seenFix.has(k)) continue;
    seenFix.add(k);
    distinct.push(c);
  }
  const blocking = distinct.filter((c) => c.status === 'fail').length;
  const checking = distinct.filter((c) => c.status === 'warn').length;
  const healthy = problems.length === 0;
  const shown = open ? d.checks : distinct.length ? distinct : d.checks.slice(0, 1);
  const worst: CheckStatus = d.summary.fail > 0 ? 'fail' : d.summary.warn > 0 ? 'warn' : 'ok';
  const tone = TONE[worst];
  const Icon = worst === 'ok' ? CheckCircle2 : worst === 'warn' ? TriangleAlert : CircleAlert;

  return (
    <section className={cn('card overflow-hidden', worst !== 'ok' && tone.ring, className)}>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3 border-b border-line">
        <span className={cn('h-8 w-8 shrink-0 grid place-items-center rounded-lg', worst === 'ok' ? 'bg-accent-soft text-accent' : worst === 'warn' ? 'bg-warn-soft text-warn' : 'bg-danger-soft text-danger')}><Icon size={16} /></span>
        <div className="min-w-[200px] flex-1">
          <div className="text-[14px] font-medium">
            {healthy ? 'Automations can fire' : blocking > 0 ? `${blocking} thing${blocking === 1 ? '' : 's'} block${blocking === 1 ? 's' : ''} your automations` : `${checking} thing${checking === 1 ? '' : 's'} to check`}
          </div>
          <div className="text-[12px] text-muted">
            {d.events24h} event{d.events24h === 1 ? '' : 's'} in the last 24 hours
            {d.lastInboundAt ? ` · last message in ${fmtAgo(d.lastInboundAt)}` : ' · nothing has come in yet'}
            {d.lastOutboundAt ? ` · last reply out ${fmtAgo(d.lastOutboundAt)}` : ''}
          </div>
        </div>
        <div className="flex items-center gap-1.5">
          <button onClick={() => q.refetch()} disabled={q.isFetching} className="btn btn-sm" aria-label="Run the checks again"><RefreshCw size={12} className={cn(q.isFetching && 'animate-spin')} /> Recheck</button>
          <button onClick={() => setOpen((o) => !o)} className="btn btn-ghost btn-sm text-muted" aria-expanded={open}>
            {open ? 'Hide' : `All ${d.checks.length} checks`} <ChevronDown size={12} className={cn('transition-transform', open && 'rotate-180')} />
          </button>
        </div>
      </div>
      <AnimatePresence initial={false} mode="popLayout">
        <motion.ul key={open ? 'all' : 'some'} initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.12 }} className="divide-y divide-line">
          {shown.map((c) => <Row key={c.id} check={c} onAction={(a) => run.mutate(a)} busyAction={busyAction} />)}
        </motion.ul>
      </AnimatePresence>
    </section>
  );
}
