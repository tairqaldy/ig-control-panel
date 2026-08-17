/**
 * Screen 2 — Watch it work (ROUND7-SPEC §2). The payoff screen: a live count and the first three real notes from
 * their own library, appearing as they finish. It is never skipped, and it never lies about why nothing is moving —
 * no OpenAI credit, a paused worker and an untouched queue each get their own sentence and their own one button.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { motion } from 'motion/react';
import { toast } from 'sonner';
import { FileText, Loader2, Play, Sparkles } from 'lucide-react';
import { api } from '../../lib/api';
import type { ItemLight, ItemsResponse, QueueResponse } from '../../lib/types';
import { useItemModal, useQuota } from '../../lib/store';
import { cn } from '../../lib/utils';
import { CategoryDot } from '../ui';
import { WizardShell, type StepProps } from './WizardShell';
import { useJobs } from './useWizard';

export function StepWatchItWork({ step, onStep, onLeave, next }: StepProps) {
  const jobs = useJobs(true);
  const qc = useQueryClient();
  const modal = useItemModal();
  const { openUpgrade } = useQuota();
  const w = jobs.data;
  const total = w?.total ?? 0;
  const analyzed = w?.analyzed ?? 0;
  const inQueue = (w?.queued ?? 0) + (w?.running ?? 0);
  const pct = total ? Math.min(100, Math.round((analyzed / total) * 100)) : 0;

  const first = useQuery({
    // The items route filters on analysis_status, whose "analyzed" value is `done`.
    queryKey: ['items', 'welcome-first-three'],
    queryFn: () => api.get<ItemsResponse>('/api/items?status=done&limit=3&sort=saved'),
    refetchInterval: (q) => ((q.state.data?.items.length ?? 0) >= 3 ? false : 5000),
    enabled: total > 0,
  });
  const cards = first.data?.items ?? [];

  const start = useMutation({
    mutationFn: (path: string) => api.post<Partial<QueueResponse>>(path),
    onSuccess: (r) => {
      const left = r.leftOut ?? 0;
      if (left > 0) toast(`${left.toLocaleString()} saves are waiting for a bigger plan`, { action: { label: 'See plans', onClick: () => openUpgrade({ reason: `Analyze the ${left.toLocaleString()} saves that didn’t fit your allowance` }) } });
      // Both of these buttons can legitimately change nothing: Resume clears this tenant's pause while an operator's
      // global pause stays in force, and Queue only picks up items still marked pending. Silence then reads as a
      // broken button, so say what actually happened.
      else if (r.paused) toast('Analysis is paused on our side, not by you. It starts again by itself — nothing here can turn it on.');
      else if (r.justQueued === 0) toast('Nothing new to queue: every save has already been through analysis.');
      void qc.invalidateQueries({ queryKey: ['jobs-status'] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  /* Until the first status lands, `total` is 0 — saying "nothing to analyze" then would be a lie for a second.
     A phone that drops signal here used to be left with a permanently disabled "Checking…" and no control at all,
     which is the one thing the spec forbids: there is always a retry and always a way on. */
  if (!w) {
    const failed = jobs.isError;
    return (
      <WizardShell
        step={step} onStep={onStep} onLeave={onLeave}
        title={failed ? 'We could not reach the server' : 'Watch it work'}
        body={failed
          ? 'Your saves and their notes are safe — this screen just could not read the progress. Try again, or carry on and come back later.'
          : 'Checking where the analysis has got to.'}
        primary={failed
          ? { label: 'Try again', onClick: () => { void jobs.refetch(); }, busy: jobs.isFetching }
          : { label: 'Checking…', onClick: () => {}, busy: true }}
        later={{ label: 'I’ll come back to this later', onClick: onLeave }}
      />
    );
  }

  const noOpenAI = !!w && !w.openaiConfigured;
  const noCredit = !!w?.paused && w.pauseReason === 'quota';
  const budgetCap = !!w?.paused && w.pauseReason === 'budget';
  const planBlocked = !!w?.planBlocked;
  const pausedByHand = !!w?.paused && !noCredit && !budgetCap;
  const idle = !!w && total > 0 && inQueue === 0 && analyzed === 0 && !w.paused && !noOpenAI && !planBlocked;
  /* Asking needs the model; when it is unreachable we send them past the question screen rather than into it.
     It also needs something analyzed to ask *about*: screen 3 refuses with "Nothing to answer from yet" and its own
     big button points back here, so offering it at analyzed === 0 built a loop out of the only two buttons on the
     two screens. That is the state the founder's father was in — 300 saves imported, none analyzed yet. */
  const askPossible = !noOpenAI && !noCredit;
  const canAsk = askPossible && analyzed > 0;
  /* Queued items only mean progress when something is actually allowed to run — otherwise the copy would be a lie. */
  const moving = inQueue > 0 && !w.paused && !planBlocked && !noOpenAI;

  const title = total === 0 ? 'Nothing to analyze yet'
    : planBlocked ? 'Analysis is paused on this plan'
    : noOpenAI || noCredit || budgetCap || pausedByHand ? 'Analysis is paused'
    : analyzed > 0 ? 'Your first notes are ready'
    : 'Watch it work';

  const body = total === 0 ? 'Your saves have not arrived yet. Go back one screen to bring them in — this takes a few minutes, not hours.'
    : noOpenAI ? 'The AI service is not set up on this server, so nothing gets a note yet. Your saves are safe.'
    : noCredit ? 'The AI service is out of credit right now. Your saves are safe and get their notes as soon as it is topped up.'
    : planBlocked ? 'Your plan is not analyzing new saves right now. Everything already analyzed stays readable.'
    : budgetCap ? 'Analysis stopped at the spending cap you set. Raise it in Settings, or carry on — what is done stays readable.'
    : pausedByHand ? 'Analysis is paused. Start it again and the notes come in a minute or two.'
    : idle ? 'Your saves are in. Start the analysis and the first notes appear in a minute or two.'
    : 'Every save gets read, transcribed if it is a reel, then written up as a short note. You can leave this page.';

  const primary = total === 0 ? { label: 'Back to bringing my saves in', onClick: () => onStep(1) }
    : idle || pausedByHand ? { label: pausedByHand ? 'Start the analysis again' : 'Start the analysis', onClick: () => { start.mutate(pausedByHand ? '/api/jobs/resume' : '/api/jobs/queue'); }, icon: pausedByHand ? <Play size={15} /> : <Sparkles size={15} />, busy: start.isPending }
    : canAsk ? { label: 'Ask my first question', onClick: next }
    : { label: 'Show me what I can do now', onClick: () => onStep(4) };

  return (
    <WizardShell
      step={step} onStep={onStep} onLeave={onLeave}
      title={title}
      body={body}
      primary={primary}
      later={total === 0
        ? { label: 'I’ll bring my saves in later', onClick: onLeave }
        : !canAsk
          ? { label: 'Skip to the last step', onClick: () => onStep(5) }
          : { label: 'I’ll come back to this later', onClick: next }}
      footNote={total > 0 && analyzed === 0 && moving ? 'You do not have to wait here. The analysis keeps running when you close the tab.' : undefined}
    >
      {total > 0 && (
        <>
          <div className="card p-4 sm:p-5">
            <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
              <span className="display text-[30px] leading-none tabular text-accent">{analyzed.toLocaleString()}</span>
              <span className="text-[14px] text-ink-2">of {total.toLocaleString()} saves analyzed</span>
              <span className="ml-auto font-mono text-[12px] text-muted tabular">
                {moving ? `${inQueue.toLocaleString()} in the queue` : inQueue > 0 ? `${inQueue.toLocaleString()} waiting` : analyzed >= total ? 'all done' : `${pct}%`}
              </span>
            </div>
            <div className="mt-3 h-2 overflow-hidden rounded-full bg-line">
              <motion.div className="h-full bg-accent" initial={false} animate={{ width: `${pct}%` }} transition={{ type: 'spring', stiffness: 80, damping: 20 }} />
            </div>
            {w?.quota && w.quota.limit !== null && (
              <div className="mt-2 text-[12px] text-muted">Your plan covers {Number(w.quota.limit).toLocaleString()} saves. The newest ones go first.</div>
            )}
          </div>

          <div className="mt-5">
            <div className="eyebrow mb-2.5">The first three, from your own library</div>
            <ul className="space-y-2.5">
              {[0, 1, 2].map((i) => {
                const it = cards[i];
                return it ? <NoteRow key={it.id} item={it} index={i} onOpen={() => modal.open(it.id)} /> : <PendingRow key={i} index={i} working={moving} />;
              })}
            </ul>
          </div>
        </>
      )}
    </WizardShell>
  );
}

function NoteRow({ item, index, onOpen }: { item: ItemLight; index: number; onOpen: () => void }) {
  const a = item.analysis;
  return (
    <motion.li initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: index * 0.06 }}>
      <button onClick={onOpen} className="card flex w-full items-start gap-3 p-3 text-left transition-colors hover:border-accent">
        <span className="h-[64px] w-[48px] shrink-0 overflow-hidden rounded-lg bg-surface-2">
          {item.thumb
            ? <img src={item.thumb} alt="" loading="lazy" className="h-full w-full object-cover" />
            : <span className="grid h-full w-full place-items-center text-muted-2"><FileText size={15} /></span>}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block text-[14px] font-medium leading-snug text-ink clamp-2">{a?.title || item.caption || 'Untitled save'}</span>
          {a?.one_liner && <span className="mt-0.5 block text-[12.5px] leading-snug text-muted clamp-2">{a.one_liner}</span>}
          {a?.category && (
            <span className="mt-1.5 inline-flex items-center gap-1.5 text-[11.5px] text-muted"><CategoryDot category={a.category} />{a.category}</span>
          )}
        </span>
      </button>
    </motion.li>
  );
}

function PendingRow({ index, working }: { index: number; working: boolean }) {
  return (
    <li className={cn('card-flat flex items-center gap-3 border-dashed p-3 text-[13px] text-muted')}>
      <span className="grid h-[64px] w-[48px] shrink-0 place-items-center rounded-lg bg-surface-2">
        {working ? <Loader2 size={15} className="animate-spin text-accent" /> : <span className="font-mono text-[12px]">{index + 1}</span>}
      </span>
      <span>{working ? 'Writing this one now…' : 'This one is waiting its turn.'}</span>
    </li>
  );
}
